#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
const BASELINE: bool = false;
const STARTUP: bool = true;
include!("common.rs");

// Import the exact production machine/dialog path; no shortened deadline or
// production environment variable fault hook is used.
#[path = "../../../src-tauri/src/startup_guard.rs"]
mod startup_guard;

fn main() {
    if backend_mode() {
        return;
    }
    let mut context = tauri::generate_context!("tauri.conf.json");
    let config = context.config_mut();
    config.identifier = "com.mythra.nativestartuptest".into();
    config.product_name = Some("Mythra Native Startup Test".into());
    for window in &mut config.app.windows {
        window.title = "Mythra Native Startup Test - synthetic only".into();
    }
    let windows = config.app.windows.clone();
    for window in &mut config.app.windows {
        window.create = false;
    }
    let mode = std::env::args().nth(1).unwrap_or_default();
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(OwnedBackend::default())
        .manage(close_guard::CloseGuardState::default())
        .manage(startup_guard::StartupGuardState::default())
        .invoke_handler(tauri::generate_handler![
            fixture_info,
            fixture_record,
            fixture_flush,
            close_guard::close_guard_claim,
            close_guard::close_guard_finish,
            startup_guard::startup_ready,
            startup_guard::startup_failed
        ])
        .setup(move |app| {
            if mode == "--setup-failed" {
                startup_guard::setup_failed(app.handle(), "database-open");
                return Ok(());
            }
            for config in windows.iter().filter(|window| window.create) {
                let builder = tauri::WebviewWindowBuilder::from_config(app.handle(), config)?;
                let prepared = startup_guard::prepare(app.handle(), &config.label).unwrap();
                if mode == "--window-failed" {
                    startup_guard::cancel_prepared(app.handle(), prepared);
                    startup_guard::setup_failed(app.handle(), "window-create");
                    return Ok(());
                }
                let window = builder.build()?;
                close_guard::install(&window);
                if mode == "--early-ready" {
                    startup_guard::startup_ready(window.clone(), app.state());
                }
                startup_guard::install(&window, prepared);
            }
            let child = Command::new(std::env::current_exe()?)
                .arg("--synthetic-backend")
                .stdin(Stdio::piped())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()?;
            let pid = child.id();
            *app.state::<OwnedBackend>().0.lock().unwrap() = Some(child);
            record(
                app.handle(),
                "synthetic-backend-started",
                json!({"backendPid":pid}),
            )?;
            Ok(())
        })
        .build(context)
        .expect("isolated native startup fixture build")
        .run(|app, event| {
            if matches!(
                event,
                tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit
            ) {
                cleanup(app);
            }
        });
}
