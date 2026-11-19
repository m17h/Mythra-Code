//! The hidden theme preview behind the theme tool `capture_app_screenshot`.
//!
//! A model checking a theme gets a picture of a dedicated, never-shown
//! webview that draws the app's real conversation, composer, sidebar and
//! Tools views from bundled sample content (`src/themePreview`). The window
//! the person uses is never captured, shown, hidden or resized, so a capture
//! keeps working while they switch threads, projects or machines.
//!
//! One preview session exists at a time and lives for one request:
//!
//! 1. The main webview calls `theme_preview_capture` with a sanitized job
//!    (theme revision, view, sizes; no user content).
//! 2. A hidden, focus-less, taskbar-less window with its own web storage
//!    opens exactly `theme-preview.html` on the app's own origin under a
//!    one-off label.
//! 3. That page takes the job once (`theme_preview_job`), renders it and
//!    reports back once (`theme_preview_rendered` or `theme_preview_failed`).
//! 4. The request itself then photographs that exact webview, by label.
//! 5. Opening, drawing and the snapshot share one deadline. Success,
//!    failure, timeout, a dropped request, the main page reloading or the
//!    main window closing ends the session and destroys its window; a
//!    window whose construction finishes after its session ended is
//!    destroyed as soon as it exists.
//!
//! Preview webviews can call only the three preview commands (see
//! `may_invoke`, enforced in the app's invoke handler), receive no plugin
//! permission (the default capability names only `main`), cannot navigate
//! or open windows, and their page carries a stricter CSP than the app
//! (theme-preview.html, vite.config.ts).

use std::collections::VecDeque;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde_json::{json, Map, Value};
use tauri::webview::NewWindowResponse;
use tauri::{AppHandle, Manager, Url, WebviewUrl, WebviewWindowBuilder};
use uuid::Uuid;

const MAIN_LABEL: &str = "main";
const LABEL_PREFIX: &str = "theme-preview-";
const PAGE: &str = "theme-preview.html";

/// The only commands a preview webview may invoke.
const PREVIEW_COMMANDS: [&str; 3] = ["theme_preview_job", "theme_preview_rendered", "theme_preview_failed"];

/// Top-level theme spec fields passed to the page; anything else a stored
/// revision carries (older metadata) stays behind.
const SPEC_KEYS: [&str; 12] = [
    "schema", "name", "description", "base", "tokens", "shape", "elevation", "typography", "surfaces", "effects", "motion",
    "customCss",
];

/// Largest job accepted from the main webview (a spec's customCss is ≤ 16 KB).
const MAX_JOB_BYTES: usize = 96 * 1024;
const MAX_SPEC_BYTES: usize = 80 * 1024;
/// Largest layout report accepted back from the preview page.
const MAX_LAYOUT_BYTES: usize = 64 * 1024;
const MAX_FAILURE_CHARS: usize = 200;

/// Window sizes the preview may take, in logical (CSS) pixels. A 4K display
/// at 100% (3840 wide) is drawn at its own size; the picture is downscaled
/// afterwards (window_capture.rs). The page reports any clamping it sees.
const WIDTH: (f64, f64) = (640.0, 3840.0);
const HEIGHT: (f64, f64) = (480.0, 2400.0);
const UI_SCALE: (f64, f64) = (0.5, 2.0);
const PANE: (f64, f64) = (0.0, 1200.0);

/// From request to answer: opening the webview, drawing and the snapshot.
const SESSION_TIMEOUT: Duration = Duration::from_secs(20);
/// Kept back from the snapshot so a stalled one still answers with the layout.
const ANSWER_MARGIN: Duration = Duration::from_millis(750);
/// IPC delivery can overtake registration. Keep recent cancellation IDs for
/// one session lifetime, with a fixed limit on how many can be stored.
const MAX_CANCELLED_REQUESTS: usize = 32;

static SLOT: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(1);

/// What the page reports once it has drawn its job.
struct Rendered {
    layout: Value,
    viewport: Option<Viewport>,
}

#[derive(serde::Serialize)]
struct Viewport {
    width: u32,
    height: u32,
}

type Reply = tokio::sync::oneshot::Sender<Result<Rendered, String>>;

struct Session {
    request_id: Uuid,
    nonce: String,
    label: String,
    /// Set before the webview starts navigating.
    expected: Option<Url>,
    /// Handed to the page once.
    job: Option<Value>,
    /// Claimed by the page's single completion report.
    reply: Option<Reply>,
    /// Removing the session wakes the request even after it took its reply.
    _closed: tokio::sync::oneshot::Sender<()>,
}

struct PreviewState {
    current: Option<Session>,
    cancelled: VecDeque<(Uuid, Instant)>,
}

impl PreviewState {
    fn prune_cancelled(&mut self) {
        while self.cancelled.front().is_some_and(|(_, time)| time.elapsed() >= SESSION_TIMEOUT) {
            self.cancelled.pop_front();
        }
    }

    fn take_session(&mut self, matches: impl FnOnce(&Session) -> bool) -> Option<Session> {
        if self.current.as_ref().is_some_and(matches) {
            self.current.take()
        } else {
            None
        }
    }
}

static PREVIEW: Mutex<PreviewState> = Mutex::new(PreviewState {
    current: None,
    cancelled: VecDeque::new(),
});

fn preview() -> std::sync::MutexGuard<'static, PreviewState> {
    PREVIEW.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// This label's session is still the one in progress.
fn session_is(label: &str) -> bool {
    preview().current.as_ref().is_some_and(|session| session.label == label)
}

pub(crate) fn is_preview_label(label: &str) -> bool {
    label.starts_with(LABEL_PREFIX)
}

/// The invoke-handler gate: a preview webview may call only the preview commands.
pub(crate) fn may_invoke(webview_label: &str, command: &str) -> bool {
    is_preview_label(webview_label) == PREVIEW_COMMANDS.contains(&command)
}

/// The preview page's exact URL on the origin the app window was loaded
/// from: the configured dev server in development, the app's own protocol
/// otherwise. Any other origin (a navigated main window) is refused.
fn preview_url(app: &AppHandle, main_url: &Url) -> Result<Url, String> {
    let refused = || "The theme preview is available only from the Mythra Code app page.".to_string();
    if !main_url.username().is_empty() || main_url.password().is_some() {
        return Err(refused());
    }
    if tauri::is_dev() {
        if let Some(dev) = app.config().build.dev_url.as_ref() {
            if dev.origin() != main_url.origin() {
                return Err(refused());
            }
            return dev.join(PAGE).map_err(|_| refused());
        }
    }
    #[cfg(windows)]
    let trusted = matches!(
        (main_url.scheme(), main_url.host_str(), main_url.port()),
        ("http" | "https", Some("tauri.localhost"), None)
    );
    #[cfg(not(windows))]
    let trusted = matches!(
        (main_url.scheme(), main_url.host_str(), main_url.port()),
        ("tauri", Some("localhost"), None)
    );
    if !trusted {
        return Err(refused());
    }
    main_url.join(&format!("/{PAGE}")).map_err(|_| refused())
}

/// The preview commands belong to the exact page of the active session.
fn check_preview_page(webview: &tauri::Webview) -> Result<(), String> {
    let denied = || "No theme preview is waiting for this page.".to_string();
    let expected = preview()
        .current
        .as_ref()
        .filter(|session| session.label == webview.label())
        .and_then(|session| session.expected.clone())
        .ok_or_else(denied)?;
    // A native URL read can dispatch to the event loop. Do it outside the
    // session lock so the main thread stays free to close the session.
    if webview.url().ok().as_ref() != Some(&expected) {
        return Err(denied());
    }
    Ok(())
}

// ---- The job (shape and bounds only; the page re-validates the theme) ----------

fn number(object: &Map<String, Value>, key: &str, (min, max): (f64, f64), fallback: f64) -> f64 {
    object
        .get(key)
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite())
        .unwrap_or(fallback)
        .clamp(min, max)
}

fn word(value: Option<&Value>, max: usize) -> Option<String> {
    value
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty() && text.len() <= max)
        .filter(|text| text.bytes().all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-'))
        .map(str::to_string)
}

fn flag(object: &Map<String, Value>, key: &str) -> bool {
    object.get(key).and_then(Value::as_bool).unwrap_or(false)
}

fn custom_theme_id(value: Option<&Value>) -> Option<String> {
    value.and_then(Value::as_str).filter(|id| {
        id.len() == 13 && id.starts_with("ct_") && id[3..].bytes().all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
    }).map(str::to_string)
}

/// Rebuilds the job from known fields only, so nothing else reaches the page.
/// Returns the job, whether a picture is wanted, and the window size.
fn sanitize_job(request: &Value) -> Result<(Value, bool, f64, f64), String> {
    let invalid = || "The theme preview request was not valid.".to_string();
    if serde_json::to_vec(request).map(|bytes| bytes.len()).unwrap_or(usize::MAX) > MAX_JOB_BYTES {
        return Err("The theme preview request is too large.".into());
    }
    let object = request.as_object().ok_or_else(invalid)?;
    let view = match object.get("view").and_then(Value::as_str) {
        Some(view @ ("conversation" | "changes")) => view,
        _ => return Err(invalid()),
    };
    let viewport = object.get("viewport").and_then(Value::as_object).ok_or_else(invalid)?;
    let width = number(viewport, "width", WIDTH, 1380.0).round();
    let height = number(viewport, "height", HEIGHT, 900.0).round();
    let panes = object.get("panes").and_then(Value::as_object).cloned().unwrap_or_default();
    let theme = object.get("theme").and_then(Value::as_object).ok_or_else(invalid)?;
    let base = word(theme.get("base"), 40).ok_or_else(invalid)?;
    let custom = match theme.get("custom") {
        None | Some(Value::Null) => Value::Null,
        Some(Value::Object(custom)) => {
            let id = custom_theme_id(custom.get("id")).ok_or_else(invalid)?;
            let revision = custom
                .get("revision")
                .and_then(Value::as_u64)
                .filter(|revision| (1..=100_000).contains(revision))
                .ok_or_else(invalid)?;
            let spec: Map<String, Value> = custom
                .get("spec")
                .and_then(Value::as_object)
                .ok_or_else(invalid)?
                .iter()
                .filter(|(key, _)| SPEC_KEYS.contains(&key.as_str()))
                .map(|(key, value)| (key.clone(), value.clone()))
                .collect();
            if serde_json::to_vec(&spec).map(|bytes| bytes.len()).unwrap_or(usize::MAX) > MAX_SPEC_BYTES {
                return Err("The theme is too large to preview.".into());
            }
            json!({ "id": id, "revision": revision, "spec": spec })
        }
        Some(_) => return Err(invalid()),
    };
    let provider = match object.get("provider").and_then(Value::as_str) {
        Some(provider @ ("openai" | "claude" | "cursor" | "openrouter" | "lmstudio")) => provider,
        _ => "openai",
    };
    let logos = object.get("logos").and_then(Value::as_object).cloned().unwrap_or_default();
    let motion = object.get("motion").and_then(Value::as_object).cloned().unwrap_or_default();
    let wants_image = flag(object, "capture");
    let job = json!({
        "version": 1,
        "view": view,
        "capture": wants_image,
        "viewport": { "width": width, "height": height },
        "uiScale": number(object, "uiScale", UI_SCALE, 1.0),
        "panes": {
            "sidebar": number(&panes, "sidebar", PANE, 260.0).round(),
            "dock": number(&panes, "dock", PANE, 430.0).round(),
            "dockAuto": panes.get("dockAuto").and_then(Value::as_bool).unwrap_or(true),
            "sidebarOpen": panes.get("sidebarOpen").and_then(Value::as_bool).unwrap_or(true),
        },
        "theme": { "base": base, "custom": custom },
        "chatFont": word(object.get("chatFont"), 40).unwrap_or_else(|| "system".into()),
        "effortSlider": word(object.get("effortSlider"), 40),
        "provider": provider,
        "logos": {
            "openai": word(logos.get("openai"), 24),
            "claude": word(logos.get("claude"), 24),
            "cursor": word(logos.get("cursor"), 24),
        },
        "motion": {
            "animate": flag(&motion, "animate"),
            "paused": flag(&motion, "paused"),
            "reducedMotion": flag(&motion, "reducedMotion"),
        },
    });
    Ok((job, wants_image, width, height))
}

// ---- The session ---------------------------------------------------------------

/// Ends the session it opened however the request ends (answer, error,
/// timeout or a dropped IPC future): forgets it and destroys its window.
/// The session is forgotten first, so a window still being constructed
/// sees that and destroys itself (see `open_window`).
struct SessionGuard {
    app: AppHandle,
    label: String,
}

impl Drop for SessionGuard {
    fn drop(&mut self) {
        end_session(&self.app, |session| session.label == self.label);
    }
}

fn destroy_window(app: &AppHandle, label: &str) {
    if let Some(window) = app.get_webview_window(label) {
        let _ = window.destroy();
    }
}

fn end_session(app: &AppHandle, matches: impl FnOnce(&Session) -> bool) {
    let ended = preview().take_session(matches);
    if let Some(ended) = ended {
        destroy_window(app, &ended.label);
    }
}

/// A reload or destruction of the main page cancels its active preview.
pub(crate) fn close_active(app: &AppHandle) {
    end_session(app, |_| true);
}

/// A preview window can also be destroyed by the runtime before it reports.
pub(crate) fn window_destroyed(label: &str) {
    if is_preview_label(label) {
        let ended = preview().take_session(|session| session.label == label);
        drop(ended);
    }
}

fn build_window(app: &AppHandle, label: &str, width: f64, height: f64, expected: Url) -> Result<(), String> {
    let failed = || "The hidden theme preview could not be opened.".to_string();
    #[cfg(windows)]
    let https = expected.scheme() == "https";
    let builder = WebviewWindowBuilder::new(app, label, WebviewUrl::App(PAGE.into()))
        .title("Mythra Code theme preview")
        .visible(false)
        .focused(false)
        .focusable(false)
        .skip_taskbar(true)
        .decorations(false)
        .shadow(false)
        .resizable(false)
        .inner_size(width, height)
        // A separate, non-persistent store where the platform offers one.
        .incognito(true)
        .zoom_hotkeys_enabled(false)
        // A never-shown webview would otherwise be throttled or suspended
        // (macOS 14+; unsupported and ignored elsewhere).
        .background_throttling(tauri::utils::config::BackgroundThrottlingPolicy::Disabled)
        .on_navigation(move |url| url == &expected)
        .on_new_window(|_, _| NewWindowResponse::Deny)
        .on_download(|_, _| false);
    // WebView2 falls back to an ordinary (persistent) profile when the
    // runtime lacks private mode, and Tauri's default data folder is the
    // app window's. A folder of its own keeps the preview's storage apart
    // from the app's whatever the runtime supports.
    #[cfg(windows)]
    let builder = builder.use_https_scheme(https).data_directory(
        app.path().app_local_data_dir().map_err(|_| failed())?.join("theme-preview-webview"),
    );
    #[cfg(target_os = "macos")]
    let builder = {
        let mtm = objc2::MainThreadMarker::new().ok_or_else(failed)?;
        // Supplying a configuration makes Wry ignore `incognito`; this one
        // carries a non-persistent store of its own.
        builder.with_webview_configuration(crate::macos_text::configuration(mtm, true, None))
    };
    builder.build().map(|_| ()).map_err(|_| failed())
}

/// Builds the window on the main thread, only while its session is current
/// and the app window exists, and destroys it if either ended meanwhile.
async fn open_window(app: &AppHandle, label: &str, width: f64, height: f64) -> Result<(), String> {
    let failed = || "The hidden theme preview could not be opened.".to_string();
    let (sender, receiver) = tokio::sync::oneshot::channel();
    let build_app = app.clone();
    let build_label = label.to_string();
    app.run_on_main_thread(move || {
        if sender.is_closed() || !session_is(&build_label) {
            return;
        }
        let ended = || "The theme preview request already ended.".to_string();
        let built = (|| {
            let main = build_app.get_webview_window(MAIN_LABEL).ok_or_else(ended)?;
            let main_url = main.url().map_err(|_| "The app page could not be identified.".to_string())?;
            let expected = preview_url(&build_app, &main_url)?;
            {
                let mut state = preview();
                let active = state.current.as_mut().filter(|session| session.label == build_label).ok_or_else(ended)?;
                active.expected = Some(expected.clone());
            }
            let built = build_window(&build_app, &build_label, width, height, expected);
            if !session_is(&build_label) {
                destroy_window(&build_app, &build_label);
                return Err(ended());
            }
            built
        })();
        let _ = sender.send(built);
    })
    .map_err(|_| failed())?;
    receiver.await.map_err(|_| failed())?
}

/// Open, wait for the page's single report, then photograph that webview.
async fn run_session(
    app: &AppHandle,
    label: &str,
    width: f64,
    height: f64,
    wants_image: bool,
    answer: tokio::sync::oneshot::Receiver<Result<Rendered, String>>,
    deadline: tokio::time::Instant,
) -> Result<Value, String> {
    let ended = || "The hidden theme preview closed before it finished.".to_string();
    open_window(app, label, width, height).await?;
    let rendered = answer.await.map_err(|_| ended())??;
    let mut result = json!({ "layout": rendered.layout, "viewport": rendered.viewport });
    if wants_image {
        let window = app.get_webview_window(label).filter(|_| session_is(label)).ok_or_else(ended)?;
        let picture = if let Some(viewport) = rendered.viewport {
            let size = (viewport.width, viewport.height);
            tokio::time::timeout_at(deadline - ANSWER_MARGIN, crate::window_capture::capture_preview_png(window.as_ref(), size))
                .await
                .unwrap_or_else(|_| Err("the picture was not ready in time".to_string()))
        } else {
            Err("The hidden theme preview did not report its viewport size.".to_string())
        };
        match picture {
            Ok((png, width, height)) => {
                result["image"] = json!({
                    "mimeType": "image/png",
                    "data": base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &png),
                    "width": width,
                    "height": height,
                });
            }
            Err(error) => result["imageError"] = json!(error),
        }
    }
    // The main page may have reloaded or closed during the snapshot.
    if !session_is(label) {
        return Err(ended());
    }
    Ok(result)
}

/// Render `request` in a hidden preview and answer `{ layout, viewport,
/// image?, imageError? }`. Only the main webview may ask.
#[tauri::command]
pub(crate) async fn theme_preview_capture(app: AppHandle, webview: tauri::Webview, request_id: Uuid, request: Value) -> Result<Value, String> {
    if webview.label() != MAIN_LABEL {
        return Err("Only the Mythra Code window can request a theme preview.".into());
    }
    let deadline = tokio::time::Instant::now() + SESSION_TIMEOUT;
    let (job, wants_image, width, height) = sanitize_job(&request)?;
    let _slot = SLOT
        .try_acquire()
        .map_err(|_| "Another theme preview is being prepared. Try again in a moment.".to_string())?;
    let nonce = Uuid::new_v4().simple().to_string();
    let label = format!("{LABEL_PREFIX}{nonce}");
    let (reply, answer) = tokio::sync::oneshot::channel();
    let (close, closed) = tokio::sync::oneshot::channel();
    // Declared after the slot so destruction is queued before another
    // request can start. The builder also checks for a cancelled session.
    let _guard = SessionGuard { app: app.clone(), label: label.clone() };
    {
        let mut state = preview();
        state.prune_cancelled();
        if state.cancelled.iter().any(|(cancelled, _)| *cancelled == request_id) {
            return Err("The theme preview request already ended.".into());
        }
        state.current = Some(Session {
            request_id,
            nonce,
            label: label.clone(),
            expected: None,
            job: Some(job),
            reply: Some(reply),
            _closed: close,
        });
    }

    let run = run_session(&app, &label, width, height, wants_image, answer, deadline);
    tokio::select! {
        biased;
        _ = closed => Err("The theme preview request already ended.".into()),
        result = tokio::time::timeout_at(deadline, run) => match result {
            Ok(result) => result,
            Err(_) => Err("The hidden theme preview did not finish in time.".into()),
        }
    }
}

/// Cancel only the request the main page abandoned, including a capture
/// command that was sent first and has yet to register.
#[tauri::command]
pub(crate) fn theme_preview_cancel(app: AppHandle, webview: tauri::Webview, request_id: Uuid) -> Result<(), String> {
    if webview.label() != MAIN_LABEL {
        return Err("Only the Mythra Code window can cancel a theme preview.".into());
    }
    let ended = {
        let mut state = preview();
        state.prune_cancelled();
        if state.cancelled.len() >= MAX_CANCELLED_REQUESTS {
            state.cancelled.pop_front();
        }
        state.cancelled.push_back((request_id, Instant::now()));
        state.take_session(|session| session.request_id == request_id)
    };
    if let Some(ended) = ended {
        destroy_window(&app, &ended.label);
    }
    Ok(())
}

/// The preview page takes its job, once.
#[tauri::command]
pub(crate) fn theme_preview_job(webview: tauri::Webview) -> Result<Value, String> {
    check_preview_page(&webview)?;
    let mut state = preview();
    let session = state.current
        .as_mut()
        .filter(|session| session.label == webview.label())
        .ok_or_else(|| "No theme preview is waiting.".to_string())?;
    let job = session.job.take().ok_or_else(|| "This preview was already handed out.".to_string())?;
    Ok(json!({ "nonce": session.nonce, "job": job }))
}

/// Claims this webview's single report, if `nonce` is its session's own.
fn take_reply(label: &str, nonce: &str) -> Option<Reply> {
    let mut state = preview();
    let session = state.current.as_mut().filter(|session| session.label == label && session.nonce == nonce && session.job.is_none())?;
    session.reply.take()
}

/// The page has drawn its job. The waiting request takes the snapshot; a
/// second report finds the reply already claimed and is refused.
#[tauri::command]
pub(crate) fn theme_preview_rendered(webview: tauri::Webview, nonce: String, layout: Value, viewport: Value) -> Result<(), String> {
    check_preview_page(&webview)?;
    let reply = take_reply(webview.label(), &nonce).ok_or_else(|| "No theme preview is waiting.".to_string())?;
    let layout = if layout.is_object() && serde_json::to_vec(&layout).map(|bytes| bytes.len()).unwrap_or(usize::MAX) <= MAX_LAYOUT_BYTES {
        layout
    } else {
        Value::Null
    };
    let dimension = |object: &Map<String, Value>, key: &str| {
        object.get(key).and_then(Value::as_u64).filter(|value| (1..=8192).contains(value)).map(|value| value as u32)
    };
    let viewport = viewport.as_object().and_then(|object| Some(Viewport {
        width: dimension(object, "width")?,
        height: dimension(object, "height")?,
    }));
    let _ = reply.send(Ok(Rendered { layout, viewport }));
    Ok(())
}

/// The page could not draw its job.
#[tauri::command]
pub(crate) fn theme_preview_failed(webview: tauri::Webview, nonce: String, message: String) -> Result<(), String> {
    check_preview_page(&webview)?;
    let reply = take_reply(webview.label(), &nonce).ok_or_else(|| "No theme preview is waiting.".to_string())?;
    let message: String = message
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .take(MAX_FAILURE_CHARS)
        .collect();
    let message = message.trim();
    let _ = reply.send(Err(if message.is_empty() {
        "The hidden theme preview could not draw this theme.".to_string()
    } else {
        format!("The hidden theme preview could not draw this theme: {message}")
    }));
    Ok(())
}
