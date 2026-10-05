//! Native ownership of close completion. JavaScript may save, but cannot strand
//! an OS close request when its WebView process has exited.

use std::{collections::HashMap, sync::Mutex, time::Duration};

use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow, WindowEvent};
use tauri_plugin_dialog::{
    DialogExt, MessageDialogButtons, MessageDialogKind, MessageDialogResult,
};

const CLOSE_DEADLINE: Duration = Duration::from_secs(20);
const CANCELLED_EVENT: &str = "mythra://close-cancelled";
const DISCARD_LABEL: &str = "Close without saving";

fn explicitly_confirmed_discard(result: MessageDialogResult) -> bool {
    matches!(result, MessageDialogResult::Custom(label) if label == DISCARD_LABEL)
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct Key {
    label: String,
    instance: u64,
    request_id: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Phase {
    AwaitingFrontend,
    NativePrompt,
    Closing,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Reason {
    SaveFailed,
    Deadline,
    DisplayExited,
}

#[derive(Debug, PartialEq, Eq)]
enum Action {
    Wait(Key),
    Prompt(Key, Reason),
    Destroy(Key),
    Cancel(Key),
}

struct Pending {
    request_id: u64,
    phase: Phase,
}

struct GuardedWindow {
    instance: u64,
    display_exited: bool,
    pending: Option<Pending>,
}

#[derive(Default)]
struct Machine {
    next_instance: u64,
    next_request: u64,
    windows: HashMap<String, GuardedWindow>,
}

impl Machine {
    // Live labels are unique in Tauri. Repeated installation on that window is
    // a no-op; Destroyed removes the entry before a replacement can bind it.
    fn bind(&mut self, label: &str) -> Option<u64> {
        if self.windows.contains_key(label) {
            return None;
        }
        self.next_instance += 1;
        self.windows.insert(
            label.to_owned(),
            GuardedWindow {
                instance: self.next_instance,
                display_exited: false,
                pending: None,
            },
        );
        Some(self.next_instance)
    }

    fn remove(&mut self, label: &str, instance: u64) {
        if self
            .windows
            .get(label)
            .is_some_and(|w| w.instance == instance)
        {
            self.windows.remove(label);
        }
    }

    fn display_has_exited(&self, label: &str, instance: u64) -> bool {
        self.windows
            .get(label)
            .is_some_and(|window| window.instance == instance && window.display_exited)
    }

    fn is_window_instance(&self, key: &Key) -> bool {
        self.windows
            .get(&key.label)
            .is_some_and(|window| window.instance == key.instance)
    }

    fn request(&mut self, label: &str, instance: u64) -> Option<Action> {
        let window = self.windows.get_mut(label)?;
        if window.instance != instance || window.pending.is_some() {
            return None;
        }
        self.next_request += 1;
        let key = Key {
            label: label.to_owned(),
            instance,
            request_id: self.next_request,
        };
        let phase = if window.display_exited {
            Phase::NativePrompt
        } else {
            Phase::AwaitingFrontend
        };
        window.pending = Some(Pending {
            request_id: key.request_id,
            phase,
        });
        Some(if window.display_exited {
            Action::Prompt(key, Reason::DisplayExited)
        } else {
            Action::Wait(key)
        })
    }

    fn claim(&self, label: &str) -> Option<CloseRequest> {
        let pending = self.windows.get(label)?.pending.as_ref()?;
        (pending.phase == Phase::AwaitingFrontend).then_some(CloseRequest {
            request_id: pending.request_id,
        })
    }

    fn matches(&self, key: &Key, phase: Phase) -> bool {
        self.windows.get(&key.label).is_some_and(|window| {
            window.instance == key.instance
                && window.pending.as_ref().is_some_and(|pending| {
                    pending.request_id == key.request_id && pending.phase == phase
                })
        })
    }

    fn finish(&mut self, label: &str, request_id: u64, result: CloseResult) -> Option<Action> {
        let window = self.windows.get_mut(label)?;
        let pending = window.pending.as_mut()?;
        // Once the native dialog owns the decision, late JS responses cannot
        // close underneath it, cancel it, or override the user's Keep open.
        if pending.request_id != request_id || pending.phase != Phase::AwaitingFrontend {
            return None;
        }
        let key = Key {
            label: label.to_owned(),
            instance: window.instance,
            request_id,
        };
        Some(match result {
            CloseResult::Saved => {
                pending.phase = Phase::Closing;
                Action::Destroy(key)
            }
            CloseResult::Failed => {
                pending.phase = Phase::NativePrompt;
                Action::Prompt(key, Reason::SaveFailed)
            }
            CloseResult::Cancel => {
                window.pending = None;
                Action::Cancel(key)
            }
        })
    }

    fn deadline(&mut self, key: &Key) -> Option<Action> {
        if !self.matches(key, Phase::AwaitingFrontend) {
            return None;
        }
        self.windows.get_mut(&key.label)?.pending.as_mut()?.phase = Phase::NativePrompt;
        Some(Action::Prompt(key.clone(), Reason::Deadline))
    }

    #[cfg(any(windows, test))]
    fn display_failed(&mut self, label: &str, instance: u64) -> Option<Action> {
        let window = self.windows.get_mut(label)?;
        if window.instance != instance {
            return None;
        }
        window.display_exited = true;
        let pending = window.pending.as_mut()?;
        if pending.phase != Phase::AwaitingFrontend {
            return None;
        }
        pending.phase = Phase::NativePrompt;
        Some(Action::Prompt(
            Key {
                label: label.to_owned(),
                instance,
                request_id: pending.request_id,
            },
            Reason::DisplayExited,
        ))
    }

    fn answer(&mut self, key: &Key, confirmed: bool) -> Option<Action> {
        if !self.matches(key, Phase::NativePrompt) {
            return None;
        }
        let window = self.windows.get_mut(&key.label)?;
        Some(if confirmed {
            window.pending.as_mut()?.phase = Phase::Closing;
            Action::Destroy(key.clone())
        } else {
            window.pending = None;
            Action::Cancel(key.clone())
        })
    }

    fn destroy_failed(&mut self, key: &Key) -> Option<Action> {
        if !self.matches(key, Phase::Closing) {
            return None;
        }
        self.windows.get_mut(&key.label)?.pending = None;
        Some(Action::Cancel(key.clone()))
    }
}

#[derive(Default)]
pub(super) struct CloseGuardState(Mutex<Machine>);

impl CloseGuardState {
    fn with<T>(&self, f: impl FnOnce(&mut Machine) -> T) -> T {
        f(&mut self
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner))
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct CloseRequest {
    request_id: u64,
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(super) enum CloseResult {
    Saved,
    Failed,
    Cancel,
}

#[tauri::command]
pub(super) fn close_guard_claim(
    window: WebviewWindow,
    state: State<'_, CloseGuardState>,
) -> Option<CloseRequest> {
    state.with(|machine| machine.claim(window.label()))
}

#[tauri::command]
pub(super) fn close_guard_finish(
    window: WebviewWindow,
    state: State<'_, CloseGuardState>,
    request_id: u64,
    result: CloseResult,
    error: Option<String>,
) -> bool {
    // Persist only the structured native reason, not arbitrary frontend text
    // that could contain user data.
    let _ = error;
    let action = state.with(|machine| machine.finish(window.label(), request_id, result));
    let accepted = action.is_some();
    if let Some(action) = action {
        perform(window.app_handle(), action);
    }
    accepted
}

fn audit(app: &AppHandle, kind: &str, payload: serde_json::Value) {
    let app = app.clone();
    let kind = kind.to_owned();
    tauri::async_runtime::spawn(async move {
        let _ = super::audit_append(app, kind, None, payload).await;
    });
}

fn perform(app: &AppHandle, action: Action) {
    match action {
        Action::Wait(key) => {
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(CLOSE_DEADLINE).await;
                let action = app
                    .state::<CloseGuardState>()
                    .with(|machine| machine.deadline(&key));
                if let Some(action) = action {
                    perform(&app, action);
                }
            });
        }
        Action::Cancel(key) => {
            if !app
                .state::<CloseGuardState>()
                .with(|machine| machine.is_window_instance(&key))
            {
                return;
            }
            if let Some(window) = app.get_webview_window(&key.label) {
                let _ = window.emit(
                    CANCELLED_EVENT,
                    CloseRequest {
                        request_id: key.request_id,
                    },
                );
            }
        }
        Action::Destroy(key) => {
            let app_ = app.clone();
            let _ = app.run_on_main_thread(move || {
                if !app_
                    .state::<CloseGuardState>()
                    .with(|machine| machine.matches(&key, Phase::Closing))
                {
                    return;
                }
                if let Some(window) = app_.get_webview_window(&key.label) {
                    // Destroy bypasses Tauri's stale JS close listener. Normal
                    // WindowDestroyed/Exit cleanup still owns backend shutdown.
                    if window.destroy().is_err() {
                        let action = app_
                            .state::<CloseGuardState>()
                            .with(|machine| machine.destroy_failed(&key));
                        if let Some(action) = action {
                            perform(&app_, action);
                        }
                    }
                }
            });
        }
        Action::Prompt(key, reason) => {
            audit(
                app,
                "native.close.confirmation",
                json!({ "window": key.label, "requestId": key.request_id, "reason": format!("{reason:?}") }),
            );
            let app_ = app.clone();
            let _ = app.run_on_main_thread(move || {
                if !app_.state::<CloseGuardState>().with(|machine| machine.matches(&key, Phase::NativePrompt)) {
                    return;
                }
                let Some(window) = app_.get_webview_window(&key.label) else { return; };
                let explanation = if reason == Reason::DisplayExited {
                    "The application display has stopped."
                } else {
                    "Mythra Code could not confirm that pending changes were saved."
                };
                let message = format!("{explanation}\n\nClosing may lose recent unsaved changes and stop running tasks. Close without saving?");
                app_.dialog().message(message)
                    .title("Close Mythra Code?")
                    .kind(MessageDialogKind::Warning)
                    // The first button is the safe default on Windows. The
                    // third Cancel label is also non-destructive: the dialog
                    // plugin maps Escape, X, and rfd errors to that label.
                    // Swapping two Ok/Cancel labels would make Escape discard.
                    .buttons(MessageDialogButtons::YesNoCancelCustom("Keep open".into(), DISCARD_LABEL.into(), "Cancel".into()))
                    .parent(&window)
                    .show_with_result(move |result| {
                        let confirmed = explicitly_confirmed_discard(result);
                        let action = app_.state::<CloseGuardState>().with(|machine| machine.answer(&key, confirmed));
                        if let Some(action) = action { perform(&app_, action); }
                    });
            });
        }
    }
}

/// Called once for each configured window after native WebView construction.
/// Covers lifetime process failures; early WebView creation is a separate path.
pub(super) fn install(window: &WebviewWindow) {
    let app = window.app_handle();
    let label = window.label().to_owned();
    let Some(instance) = app
        .state::<CloseGuardState>()
        .with(|machine| machine.bind(&label))
    else {
        return;
    };
    let app_ = app.clone();
    let label_ = label.clone();
    window.on_window_event(move |event| match event {
        WindowEvent::CloseRequested { api, .. } => {
            let (display_exited, action) = app_.state::<CloseGuardState>().with(|machine| {
                (
                    machine.display_has_exited(&label_, instance),
                    machine.request(&label_, instance),
                )
            });
            // Tauri already prevents close when the standard JS close listener
            // exists. Before that listener is installed, healthy startup close
            // proceeds normally; Destroyed invalidates the unused watchdog.
            // A confirmed dead display needs native prevention and consent.
            if display_exited {
                api.prevent_close();
            }
            if let Some(action) = action {
                perform(&app_, action);
            }
        }
        WindowEvent::Destroyed => app_
            .state::<CloseGuardState>()
            .with(|machine| machine.remove(&label_, instance)),
        _ => {}
    });
    #[cfg(windows)]
    install_process_failure_handler(window, label, instance);
}

#[cfg(windows)]
fn install_process_failure_handler(window: &WebviewWindow, label: String, instance: u64) {
    use webview2_com::{Microsoft::Web::WebView2::Win32::*, ProcessFailedEventHandler};
    use windows_core::Interface;

    let app = window.app_handle().clone();
    let registration = window.with_webview(move |platform| {
        let result = (|| unsafe {
            let webview = platform.controller().CoreWebView2()?;
            let mut browser_pid = 0;
            let _ = webview.BrowserProcessId(&mut browser_pid);
            let mut token = 0;
            let app_ = app.clone();
            webview.add_ProcessFailed(&ProcessFailedEventHandler::create(Box::new(move |_, args| {
                let Some(args) = args else { return Ok(()); };
                let mut kind = COREWEBVIEW2_PROCESS_FAILED_KIND::default();
                args.ProcessFailedKind(&mut kind)?;
                let mut reason = None;
                let mut exit_code = None;
                if let Ok(details) = args.cast::<ICoreWebView2ProcessFailedEventArgs2>() {
                    let mut value = COREWEBVIEW2_PROCESS_FAILED_REASON::default();
                    if details.Reason(&mut value).is_ok() { reason = Some(value.0); }
                    let mut value = 0;
                    if details.ExitCode(&mut value).is_ok() { exit_code = Some(value); }
                }
                audit(&app_, "native.webview.processFailed", json!({ "window": label, "kind": kind.0, "reason": reason, "exitCode": exit_code, "browserPid": browser_pid }));
                if kind == COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED || kind == COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED {
                    let action = app_.state::<CloseGuardState>().with(|machine| machine.display_failed(&label, instance));
                    if let Some(action) = action { perform(&app_, action); }
                }
                Ok(())
            })), &mut token)?;
            // WebView2 retains its handler until the control is released.
            Ok::<(), windows_core::Error>(())
        })();
        if result.is_err() {
            audit(&app, "native.webview.failureHandlerUnavailable", json!({ "window": "main" }));
        }
    });
    if registration.is_err() {
        audit(
            window.app_handle(),
            "native.webview.failureHandlerUnavailable",
            json!({ "window": window.label() }),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> (Machine, u64) {
        let mut machine = Machine::default();
        let instance = machine.bind("main").unwrap();
        (machine, instance)
    }

    fn pending(machine: &mut Machine, instance: u64) -> Key {
        let Some(Action::Wait(key)) = machine.request("main", instance) else {
            panic!("expected awaiting close");
        };
        key
    }

    #[test]
    fn only_explicit_discard_label_authorizes_destroy() {
        for result in [
            MessageDialogResult::Ok,
            MessageDialogResult::Yes,
            MessageDialogResult::No,
            MessageDialogResult::Cancel,
            MessageDialogResult::Custom("Keep open".into()),
            MessageDialogResult::Custom("Cancel".into()),
            MessageDialogResult::Custom("".into()),
        ] {
            assert!(!explicitly_confirmed_discard(result));
        }
        assert!(explicitly_confirmed_discard(MessageDialogResult::Custom(
            DISCARD_LABEL.into()
        )));
    }

    #[test]
    fn unanswered_close_reaches_native_confirmation_without_destroying() {
        let (mut machine, instance) = fixture();
        let key = pending(&mut machine, instance);
        assert_eq!(
            machine.deadline(&key),
            Some(Action::Prompt(key.clone(), Reason::Deadline))
        );
        assert!(machine.matches(&key, Phase::NativePrompt));
        assert_eq!(machine.deadline(&key), None);
        assert_eq!(machine.claim("main").map(|r| r.request_id), None);
        assert_eq!(machine.answer(&key, false), Some(Action::Cancel(key)));
    }

    #[test]
    fn successful_save_closes_and_invalidates_the_deadline() {
        let (mut machine, instance) = fixture();
        let key = pending(&mut machine, instance);
        assert_eq!(machine.claim("main").unwrap().request_id, key.request_id);
        assert_eq!(
            machine.finish("main", key.request_id, CloseResult::Saved),
            Some(Action::Destroy(key.clone()))
        );
        assert_eq!(machine.deadline(&key), None);
    }

    #[test]
    fn failed_save_has_one_native_decision_owner() {
        let (mut machine, instance) = fixture();
        let key = pending(&mut machine, instance);
        assert_eq!(
            machine.finish("main", key.request_id, CloseResult::Failed),
            Some(Action::Prompt(key.clone(), Reason::SaveFailed))
        );
        assert_eq!(machine.request("main", instance), None);
        for result in [CloseResult::Saved, CloseResult::Failed, CloseResult::Cancel] {
            assert_eq!(machine.finish("main", key.request_id, result), None);
        }
        assert_eq!(
            machine.answer(&key, true),
            Some(Action::Destroy(key.clone()))
        );
        assert_eq!(machine.answer(&key, true), None);
    }

    #[test]
    fn keep_open_invalidates_late_saves_and_allows_a_new_close() {
        let (mut machine, instance) = fixture();
        let key = pending(&mut machine, instance);
        machine.deadline(&key);
        assert_eq!(
            machine.answer(&key, false),
            Some(Action::Cancel(key.clone()))
        );
        let next = pending(&mut machine, instance);
        assert_ne!(key.request_id, next.request_id);
        assert_eq!(
            machine.finish("main", key.request_id, CloseResult::Saved),
            None
        );
        assert_eq!(machine.answer(&key, true), None);
        assert!(machine.matches(&next, Phase::AwaitingFrontend));
    }

    #[test]
    fn renderer_death_mid_save_prompts_without_waiting_for_js() {
        let (mut machine, instance) = fixture();
        let key = pending(&mut machine, instance);
        assert_eq!(
            machine.display_failed("main", instance),
            Some(Action::Prompt(key.clone(), Reason::DisplayExited))
        );
        assert_eq!(
            machine.finish("main", key.request_id, CloseResult::Saved),
            None
        );
        assert_eq!(machine.deadline(&key), None);
    }

    #[test]
    fn display_failure_does_not_prompt_until_the_user_closes() {
        let (mut machine, instance) = fixture();
        assert_eq!(machine.display_failed("main", instance), None);
        assert!(matches!(
            machine.request("main", instance),
            Some(Action::Prompt(_, Reason::DisplayExited))
        ));
    }

    #[test]
    fn stale_window_dialog_and_deadline_cannot_close_replacement() {
        let (mut machine, instance) = fixture();
        let key = pending(&mut machine, instance);
        machine.deadline(&key);
        machine.remove("main", instance);
        assert!(!machine.is_window_instance(&key));
        let replacement = machine.bind("main").unwrap();
        assert_ne!(replacement, instance);
        let next = pending(&mut machine, replacement);
        assert!(!machine.is_window_instance(&key));
        assert!(machine.is_window_instance(&next));
        assert_eq!(machine.answer(&key, true), None);
        assert_eq!(machine.deadline(&key), None);
        assert_eq!(
            machine.finish("main", key.request_id, CloseResult::Saved),
            None
        );
        machine.remove("main", instance);
        assert!(machine.matches(&next, Phase::AwaitingFrontend));
    }

    #[test]
    fn wrong_window_result_and_duplicate_install_are_ignored() {
        let (mut machine, instance) = fixture();
        let key = pending(&mut machine, instance);
        assert_eq!(machine.bind("main"), None);
        let other = machine.bind("other").unwrap();
        machine.request("other", other);
        assert_eq!(
            machine.finish("other", key.request_id, CloseResult::Saved),
            None
        );
        assert_eq!(machine.claim("unknown").map(|r| r.request_id), None);
        assert!(machine.matches(&key, Phase::AwaitingFrontend));
    }

    #[test]
    fn frontend_cancel_invalidates_its_deadline() {
        let (mut machine, instance) = fixture();
        let key = pending(&mut machine, instance);
        assert_eq!(
            machine.finish("main", key.request_id, CloseResult::Cancel),
            Some(Action::Cancel(key.clone()))
        );
        assert_eq!(machine.deadline(&key), None);
        assert_eq!(
            machine.finish("main", key.request_id, CloseResult::Saved),
            None
        );
    }

    #[test]
    fn destroy_failure_allows_retry_without_reusing_the_generation() {
        let (mut machine, instance) = fixture();
        let key = pending(&mut machine, instance);
        machine.finish("main", key.request_id, CloseResult::Saved);
        assert_eq!(
            machine.destroy_failed(&key),
            Some(Action::Cancel(key.clone()))
        );
        assert_eq!(machine.destroy_failed(&key), None);
        assert_ne!(pending(&mut machine, instance).request_id, key.request_id);
    }
}
