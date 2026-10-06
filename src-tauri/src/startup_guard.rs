//! One bounded startup observation, independent of profile storage or providers.
//! This starts after WebView construction; it cannot bound a blocked native
//! WebView constructor or an event loop that stops processing messages.

use std::{
    collections::HashMap,
    sync::Mutex,
    time::{Duration, Instant},
};

use serde::Deserialize;
use tauri::{AppHandle, Manager, State, WebviewWindow, WindowEvent};
use tauri_plugin_dialog::{
    DialogExt, MessageDialogButtons, MessageDialogKind, MessageDialogResult,
};
use tokio::sync::oneshot;

const STARTUP_DEADLINE: Duration = Duration::from_secs(60);
const CLOSE_LABEL: &str = "Close Mythra Code";
const FATAL_ACK_LABEL: &str = "Close";

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub(super) enum StartupStage {
    Bootstrap,
    Entry,
    Hydration,
    AppImport,
    Mount,
    Render,
}

impl StartupStage {
    fn code(self) -> &'static str {
        match self {
            Self::Bootstrap => "bootstrap",
            Self::Entry => "entry",
            Self::Hydration => "hydration",
            Self::AppImport => "app-import",
            Self::Mount => "mount",
            Self::Render => "render",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct Key {
    label: String,
    generation: u64,
}

struct StartupWindow {
    generation: u64,
    started: Instant,
    ready: bool,
    fallback: Option<StartupStage>,
    prompted: bool,
    cancel_deadline: Option<oneshot::Sender<()>>,
}

impl StartupWindow {
    fn cancel_deadline(&mut self) {
        if let Some(sender) = self.cancel_deadline.take() {
            let _ = sender.send(());
        }
    }
}

#[derive(Default)]
struct Machine {
    next_generation: u64,
    windows: HashMap<String, StartupWindow>,
}

impl Machine {
    fn bind(&mut self, label: &str) -> Option<(Key, oneshot::Receiver<()>)> {
        if self.windows.contains_key(label) {
            return None;
        }
        self.next_generation += 1;
        let (sender, receiver) = oneshot::channel();
        let key = Key {
            label: label.to_owned(),
            generation: self.next_generation,
        };
        self.windows.insert(
            label.to_owned(),
            StartupWindow {
                generation: key.generation,
                started: Instant::now(),
                ready: false,
                fallback: None,
                prompted: false,
                cancel_deadline: Some(sender),
            },
        );
        Some((key, receiver))
    }

    fn ready(&mut self, label: &str) -> Option<u128> {
        let window = self.windows.get_mut(label)?;
        if window.ready {
            return None;
        }
        window.ready = true;
        window.cancel_deadline();
        Some(window.started.elapsed().as_millis())
    }

    fn failed(&mut self, label: &str, stage: StartupStage) -> Option<u128> {
        let window = self.windows.get_mut(label)?;
        if window.ready || window.fallback.is_some() {
            return None;
        }
        // The caller reports only after showing a useful static fallback. An
        // additional native timeout dialog would obscure that error UI.
        window.fallback = Some(stage);
        window.cancel_deadline();
        Some(window.started.elapsed().as_millis())
    }

    fn pending(&self, key: &Key) -> bool {
        self.windows.get(&key.label).is_some_and(|window| {
            window.generation == key.generation && !window.ready && window.fallback.is_none()
        })
    }

    fn deadline(&mut self, key: &Key) -> Option<u128> {
        if !self.pending(key) {
            return None;
        }
        let window = self.windows.get_mut(&key.label)?;
        if window.prompted {
            return None;
        }
        window.prompted = true;
        Some(window.started.elapsed().as_millis())
    }

    fn remove(&mut self, key: &Key) {
        if self
            .windows
            .get(&key.label)
            .is_some_and(|window| window.generation == key.generation)
        {
            self.windows.remove(&key.label);
        }
    }
}

#[derive(Default)]
pub(super) struct StartupGuardState(Mutex<Machine>);

pub(super) struct PreparedStartup {
    key: Key,
    cancel: oneshot::Receiver<()>,
}

impl StartupGuardState {
    fn with<T>(&self, f: impl FnOnce(&mut Machine) -> T) -> T {
        f(&mut self
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner))
    }
}

// Fixed fields only: never persist exception text, profile paths, or provider
// content. stderr remains available even when SQLite failed to initialize.
pub(super) fn diagnostic(stage: &str, code: &str, elapsed_ms: u128) {
    eprintln!("mythra.startup stage={stage} code={code} elapsed_ms={elapsed_ms}");
}

#[tauri::command]
pub(super) fn startup_ready(window: WebviewWindow, state: State<'_, StartupGuardState>) {
    if let Some(elapsed) = state.with(|machine| machine.ready(window.label())) {
        diagnostic("render", "ready", elapsed);
        crate::release_qa::record("render-ready", serde_json::json!({"label":window.label(),"elapsedMs":elapsed}));
    }
}

#[tauri::command]
pub(super) fn startup_failed(
    window: WebviewWindow,
    state: State<'_, StartupGuardState>,
    stage: StartupStage,
) {
    if let Some(elapsed) = state.with(|machine| machine.failed(window.label(), stage)) {
        diagnostic(stage.code(), "fallback-visible", elapsed);
        crate::release_qa::record("render-failed", serde_json::json!({"stage":stage.code(),"elapsedMs":elapsed}));
    }
}

fn explicitly_chose(result: MessageDialogResult, label: &str) -> bool {
    matches!(result, MessageDialogResult::Custom(value) if value == label)
}

#[derive(Debug, PartialEq, Eq)]
enum FatalAction {
    Exit,
    CloseMain,
    KeepMain,
}

fn fatal_action(has_main: bool, result: MessageDialogResult) -> FatalAction {
    if !has_main {
        // Setup has failed before a usable main window exists. Dismissal or
        // a dialog error must not leave an invisible, unusable host running.
        FatalAction::Exit
    } else if explicitly_chose(result, FATAL_ACK_LABEL) {
        FatalAction::CloseMain
    } else {
        FatalAction::KeepMain
    }
}

/// Bind before construction: a constructor may pump messages and deliver a
/// renderer acknowledgment before it returns the WebviewWindow handle.
pub(super) fn prepare(app: &AppHandle, label: &str) -> Option<PreparedStartup> {
    let (key, cancel) = app
        .state::<StartupGuardState>()
        .with(|machine| machine.bind(label))?;
    Some(PreparedStartup { key, cancel })
}

pub(super) fn cancel_prepared(app: &AppHandle, prepared: PreparedStartup) {
    app.state::<StartupGuardState>()
        .with(|machine| machine.remove(&prepared.key));
}

pub(super) fn install(window: &WebviewWindow, prepared: PreparedStartup) {
    let app = window.app_handle().clone();
    let PreparedStartup { key, mut cancel } = prepared;
    diagnostic("native-window", "constructed", 0);
    crate::release_qa::record("window-constructed", serde_json::json!({"label":window.label()}));
    let destroyed_app = app.clone();
    let destroyed_key = key.clone();
    window.on_window_event(move |event| {
        if matches!(event, WindowEvent::Destroyed) {
            destroyed_app
                .state::<StartupGuardState>()
                .with(|machine| machine.remove(&destroyed_key));
        }
    });
    tauri::async_runtime::spawn(async move {
        tokio::select! {
            _ = tokio::time::sleep(STARTUP_DEADLINE) => {},
            _ = &mut cancel => return,
        }
        let ui_app = app.clone();
        let _ = app.run_on_main_thread(move || {
            // Check on the UI thread immediately before showing; a queued
            // deadline must not warn after readiness or window destruction.
            let Some(elapsed) = ui_app.state::<StartupGuardState>().with(|machine| machine.deadline(&key)) else { return; };
            let Some(window) = ui_app.get_webview_window(&key.label) else { return; };
            diagnostic("render", "deadline", elapsed);
            let callback_app = ui_app.clone();
            ui_app.dialog().message("Mythra Code has not finished opening. You can keep waiting or close the window.\n\nClosing follows the usual save confirmation and may stop running tasks.")
                .title("Mythra Code is still opening")
                .kind(MessageDialogKind::Warning)
                .buttons(MessageDialogButtons::YesNoCancelCustom("Keep waiting".into(), CLOSE_LABEL.into(), "Cancel".into()))
                .parent(&window)
                .show_with_result(move |result| {
                    if !explicitly_chose(result, CLOSE_LABEL) { return; }
                    let close_app = callback_app.clone();
                    let _ = callback_app.run_on_main_thread(move || {
                        // A native dialog cannot be dismissed by late ready.
                        // Its stale Close choice must not close a recovered UI.
                        if !close_app.state::<StartupGuardState>().with(|machine| machine.pending(&key)) { return; }
                        if let Some(window) = close_app.get_webview_window(&key.label) {
                            let _ = window.close();
                        }
                    });
                });
        });
    });
}

/// Setup calls this rather than returning an error to Tauri's panic path.
/// Never block setup or the event loop waiting for acknowledgment.
pub(super) fn setup_failed(app: &AppHandle, stage: &'static str) {
    diagnostic(stage, "setup-failed", 0);
    crate::release_qa::record("setup-failed", serde_json::json!({"stage":stage}));
    let callback_app = app.clone();
    app.dialog()
        .message(
            "Mythra Code could not finish opening. Close the application and try opening it again.",
        )
        .title("Mythra Code could not open")
        .kind(MessageDialogKind::Error)
        .buttons(MessageDialogButtons::OkCustom(FATAL_ACK_LABEL.into()))
        .show_with_result(move |result| {
            let close_app = callback_app.clone();
            let _ = callback_app.run_on_main_thread(move || {
                // Recheck native window existence on the event loop: a usable
                // window still requires explicit Close through its close guard.
                let main = close_app.get_webview_window("main");
                match fatal_action(main.is_some(), result) {
                    FatalAction::Exit => close_app.exit(1),
                    FatalAction::CloseMain => {
                        if let Some(window) = main {
                            let _ = window.close();
                        }
                    }
                    FatalAction::KeepMain => {}
                }
            });
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> (Machine, Key, oneshot::Receiver<()>) {
        let mut machine = Machine::default();
        let (key, receiver) = machine.bind("main").unwrap();
        (machine, key, receiver)
    }

    #[test]
    fn healthy_startup_cancels_the_single_deadline() {
        let (mut machine, key, mut cancel) = fixture();
        assert!(machine.ready("main").is_some());
        assert_eq!(cancel.try_recv(), Ok(()));
        assert_eq!(machine.ready("main"), None);
        assert_eq!(machine.deadline(&key), None);
    }

    #[test]
    fn acknowledgment_during_construction_is_retained_before_timer_install() {
        let (mut machine, key, mut cancel) = fixture();
        // The receiver is not polled until WebView construction completes.
        machine.ready("main");
        assert_eq!(cancel.try_recv(), Ok(()));
        assert_eq!(machine.deadline(&key), None);
        assert!(!machine.pending(&key));
    }

    #[test]
    fn visible_fallback_suppresses_timeout_and_late_failure_after_ready() {
        let (mut machine, key, mut cancel) = fixture();
        assert!(machine.failed("main", StartupStage::AppImport).is_some());
        assert_eq!(cancel.try_recv(), Ok(()));
        assert_eq!(machine.deadline(&key), None);
        assert!(machine.ready("main").is_some());
        assert_eq!(machine.failed("main", StartupStage::Render), None);
    }

    #[test]
    fn timeout_is_one_shot_and_late_ready_invalidates_close() {
        let (mut machine, key, _) = fixture();
        assert!(machine.deadline(&key).is_some());
        assert!(machine.pending(&key));
        assert_eq!(machine.deadline(&key), None);
        machine.ready("main");
        assert!(!machine.pending(&key));
    }

    #[test]
    fn destroyed_or_replaced_window_rejects_old_deadlines_and_removal() {
        let (mut machine, old_key, _) = fixture();
        assert!(machine.bind("main").is_none());
        machine.remove(&old_key);
        let (new_key, _) = machine.bind("main").unwrap();
        assert_ne!(old_key.generation, new_key.generation);
        assert_eq!(machine.deadline(&old_key), None);
        machine.remove(&old_key);
        assert!(machine.pending(&new_key));
    }

    #[test]
    fn close_requires_the_exact_explicit_button() {
        for result in [
            MessageDialogResult::Ok,
            MessageDialogResult::Yes,
            MessageDialogResult::No,
            MessageDialogResult::Cancel,
            MessageDialogResult::Custom("Keep waiting".into()),
            MessageDialogResult::Custom("Cancel".into()),
        ] {
            assert!(!explicitly_chose(result, CLOSE_LABEL));
        }
        assert!(explicitly_chose(
            MessageDialogResult::Custom(CLOSE_LABEL.into()),
            CLOSE_LABEL
        ));
    }

    #[test]
    fn fatal_failure_without_main_exits_on_acknowledgment_dismissal_or_error() {
        for result in [
            MessageDialogResult::Ok,
            MessageDialogResult::Yes,
            MessageDialogResult::No,
            MessageDialogResult::Cancel,
            MessageDialogResult::Custom(FATAL_ACK_LABEL.into()),
            MessageDialogResult::Custom("Cancel".into()),
            MessageDialogResult::Custom("".into()),
        ] {
            assert_eq!(fatal_action(false, result), FatalAction::Exit);
        }
    }

    #[test]
    fn fatal_failure_with_main_preserves_it_unless_close_is_explicit() {
        for result in [
            MessageDialogResult::Ok,
            MessageDialogResult::Yes,
            MessageDialogResult::No,
            MessageDialogResult::Cancel,
            MessageDialogResult::Custom("Cancel".into()),
            MessageDialogResult::Custom("".into()),
        ] {
            assert_eq!(fatal_action(true, result), FatalAction::KeepMain);
        }
        assert_eq!(
            fatal_action(true, MessageDialogResult::Custom(FATAL_ACK_LABEL.into())),
            FatalAction::CloseMain
        );
    }

    #[test]
    fn frontend_stages_accept_only_fixed_diagnostic_values() {
        for stage in [
            "bootstrap",
            "entry",
            "hydration",
            "app-import",
            "mount",
            "render",
        ] {
            assert!(serde_json::from_value::<StartupStage>(serde_json::json!(stage)).is_ok());
        }
        assert!(
            serde_json::from_value::<StartupStage>(serde_json::json!("private/profile/path"))
                .is_err()
        );
    }
}
