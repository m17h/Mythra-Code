use serde_json::json;
use std::{fs::OpenOptions, io::{Read, Write}, process::{Child, Command, Stdio}, sync::Mutex};
use tauri::{AppHandle, Manager};

// Exact production module, not a copy or a platform fork.
#[path = "../../../src-tauri/src/close_guard.rs"]
mod close_guard;

#[derive(Default)]
struct OwnedBackend(Mutex<Option<Child>>);
static AUDIT_LOCK: Mutex<()> = Mutex::new(());

fn backend_mode() -> bool {
    if std::env::args().nth(1).as_deref() != Some("--synthetic-backend") { return false; }
    // No providers or network. Parent-owned pipe EOF makes orphan cleanup safe.
    let _ = std::io::stdin().read_to_end(&mut Vec::new());
    true
}

fn record(app: &AppHandle, kind: &str, payload: serde_json::Value) -> Result<(), String> {
    let _lock = AUDIT_LOCK.lock().map_err(|_| "fixture audit lock poisoned".to_string())?;
    let directory = app.path().app_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
    let mut file = OpenOptions::new().create(true).append(true).open(directory.join("fixture-audit.jsonl")).map_err(|e| e.to_string())?;
    let timestamp_ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_err(|e| e.to_string())?.as_millis() as u64;
    let line = format!("{}\n", json!({"timestampMs":timestamp_ms,"kind":kind,"pid":std::process::id(),"payload":payload}));
    file.write_all(line.as_bytes()).map_err(|e| e.to_string())
}

async fn audit_append(app: AppHandle, kind: String, _thread: Option<String>, payload: serde_json::Value) -> Result<(), String> {
    record(&app, &kind, payload)
}

#[tauri::command]
fn fixture_info(app: AppHandle) -> serde_json::Value {
    let child = app.state::<OwnedBackend>().0.lock().unwrap().as_ref().map(Child::id);
    json!({"baseline": BASELINE,"startup":STARTUP,"pid":std::process::id(),"backendPid":child,"identifier":app.config().identifier,"dataDir":app.path().app_data_dir().ok(),"localDataDir":app.path().app_local_data_dir().ok()})
}

#[tauri::command]
fn fixture_record(app: AppHandle, kind: String) -> Result<(), String> {
    // Accept only fixed synthetic event labels; never record arbitrary chat data.
    if !["close-listener-registered", "display-ready", "flush-started", "close-error"].contains(&kind.as_str()) { return Err("unknown fixture event".into()); }
    record(&app, &kind, json!({}))
}

#[tauri::command]
async fn fixture_flush(app: AppHandle, mode: String) -> Result<(), String> {
    record(&app, "flush-started", json!({"mode":mode}))?;
    match mode.as_str() {
        "failed" => return Err("synthetic save failure".into()),
        "pending" => tokio::time::sleep(std::time::Duration::from_secs(60)).await,
        "saved" => {},
        _ => return Err("unknown synthetic flush mode".into()),
    }
    let file = app.path().app_data_dir().map_err(|e| e.to_string())?.join("synthetic-save.json");
    std::fs::write(file, "{\"syntheticOnly\":true,\"saved\":true}\n").map_err(|e| e.to_string())?;
    record(&app, "flush-saved", json!({"syntheticOnly":true}))
}

fn cleanup(app: &AppHandle) {
    let Some(mut child) = app.state::<OwnedBackend>().0.lock().unwrap().take() else { return; };
    let pid = child.id();
    drop(child.stdin.take());
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(1);
    loop {
        if matches!(child.try_wait(), Ok(Some(_))) { break; }
        if std::time::Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(20));
    }
    let _ = record(app, "synthetic-backend-stopped", json!({"backendPid":pid}));
}

fn run(context: tauri::Context<tauri::Wry>) {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(OwnedBackend::default())
        .manage(close_guard::CloseGuardState::default())
        .invoke_handler(tauri::generate_handler![fixture_info, fixture_record, fixture_flush, close_guard::close_guard_claim, close_guard::close_guard_finish])
        .setup(|app| {
            let child = Command::new(std::env::current_exe()?).arg("--synthetic-backend").stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::null()).spawn()?;
            let pid = child.id();
            *app.state::<OwnedBackend>().0.lock().unwrap() = Some(child);
            record(app.handle(), "synthetic-backend-started", json!({"backendPid":pid}))?;
            if !BASELINE { close_guard::install(&app.get_webview_window("main").unwrap()); }
            Ok(())
        })
        .build(context).expect("isolated native close fixture build")
        .run(|app, event| {
            if matches!(event, tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit) { cleanup(app); }
        });
}
