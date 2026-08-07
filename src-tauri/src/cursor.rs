use std::{
    collections::HashMap,
    env,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        atomic::{AtomicBool, AtomicI64, Ordering},
        Arc,
    },
};

use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, Command},
    sync::{oneshot, Mutex},
    time::{timeout, Duration},
};

use crate::agents::{child_agent_bridge_launch_registered, ChildAgentState};

type PendingMap = Arc<Mutex<HashMap<i64, oneshot::Sender<Result<Value, String>>>>>;

#[derive(Default)]
pub struct CursorState {
    turns: Arc<Mutex<HashMap<String, Arc<CursorProcess>>>>,
    authenticated: AtomicBool,
}

struct CursorProcess {
    stdin: Arc<Mutex<ChildStdin>>,
    child: Arc<Mutex<Child>>,
    pid: Option<u32>,
    pending: PendingMap,
    next_id: AtomicI64,
    alive: Arc<AtomicBool>,
    session_id: Mutex<Option<String>>,
    turn_id: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CursorRuntimeStatus {
    available: bool,
    path: Option<String>,
    version: Option<String>,
    logged_in: bool,
    email: Option<String>,
    subscription_type: Option<String>,
    warning: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CursorModel {
    id: String,
    name: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    config_options: Vec<Value>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CursorAttachment {
    path: String,
    kind: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CursorTurnOptions {
    thread_id: String,
    cwd: String,
    prompt: String,
    model: String,
    effort: String,
    permission: String,
    system_prompt: String,
    resume_session_id: Option<String>,
    attachments: Vec<CursorAttachment>,
    /// Cross-provider delegation bridge, present only for a root thread whose
    /// policy allows spawning children on other providers.
    #[serde(default)]
    child_agent_bridge: Option<ChildAgentBridge>,
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ChildAgentBridge {
    name: String,
    command: String,
    args: Vec<String>,
}

/// ACP announces MCP servers when the session is created, so the delegation
/// tools are attached for the whole session or not at all.
fn acp_mcp_servers(bridge: Option<&ChildAgentBridge>) -> Value {
    match bridge {
        Some(bridge) => json!([{
            "name": bridge.name,
            "command": bridge.command,
            "args": bridge.args,
            "env": [],
        }]),
        None => json!([]),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CursorTurnStarted {
    turn_id: String,
    cursor_session_id: String,
}

impl CursorProcess {
    async fn write_value(&self, message: &Value) -> Result<(), String> {
        if !self.alive.load(Ordering::Acquire) {
            return Err("This Cursor turn is no longer running".into());
        }
        write_json(&self.stdin, message).await
    }

    async fn request(&self, method: &str, params: Value) -> Result<Value, String> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (sender, receiver) = oneshot::channel();
        self.pending.lock().await.insert(id, sender);
        if let Err(error) = self
            .write_value(&json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }))
            .await
        {
            self.pending.lock().await.remove(&id);
            return Err(error);
        }
        match timeout(Duration::from_secs(45), receiver).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err(format!("Cursor Agent dropped its `{method}` response")),
            Err(_) => {
                self.pending.lock().await.remove(&id);
                Err(format!("Cursor Agent timed out during `{method}`"))
            }
        }
    }

    async fn notify(&self, method: &str, params: Value) -> Result<(), String> {
        self.write_value(&json!({ "jsonrpc": "2.0", "method": method, "params": params }))
            .await
    }

    async fn respond(&self, id: Value, result: Value) -> Result<(), String> {
        self.write_value(&json!({ "jsonrpc": "2.0", "id": id, "result": result }))
            .await
    }

    async fn shutdown(&self) {
        self.alive.store(false, Ordering::Release);
        let _ = self.stdin.lock().await.shutdown().await;
        if let Some(pid) = self.pid {
            super::kill_process_tree(pid);
        }
        let _ = self.child.lock().await.kill().await;
    }
}

async fn write_json(stdin: &Arc<Mutex<ChildStdin>>, message: &Value) -> Result<(), String> {
    let mut stdin = stdin.lock().await;
    stdin
        .write_all(format!("{message}\n").as_bytes())
        .await
        .map_err(|error| format!("Could not write to Cursor Agent: {error}"))?;
    stdin
        .flush()
        .await
        .map_err(|error| format!("Could not flush Cursor Agent input: {error}"))
}

fn field_after_label(output: &str, label: &str) -> Option<String> {
    output.lines().find_map(|line| {
        let trimmed = line.trim();
        let value = trimmed.strip_prefix(label)?.trim();
        (!value.is_empty()).then(|| value.to_string())
    })
}

async fn resolve_cursor_binary(app: &AppHandle) -> Result<PathBuf, String> {
    if let Some(override_path) = env::var_os("OPENKIWI_CURSOR_PATH") {
        let override_path = PathBuf::from(override_path);
        return override_path
            .is_file()
            .then_some(override_path)
            .ok_or_else(|| {
                "OPENKIWI_CURSOR_PATH does not point to a Cursor Agent executable.".into()
            });
    }
    let executable_names: &[&str] = if cfg!(windows) {
        &["agent.exe", "cursor-agent.exe"]
    } else {
        &["agent", "cursor-agent"]
    };
    let mut candidates = Vec::new();
    for name in executable_names {
        if let Some(candidate) = super::find_on_path(name) {
            super::push_candidate(&mut candidates, candidate);
        }
    }
    if let Ok(home) = app.path().home_dir() {
        for relative in [
            ".local/bin/agent",
            ".local/bin/cursor-agent",
            ".cursor/bin/agent",
        ] {
            super::push_candidate(&mut candidates, home.join(relative));
        }
    }
    if let Some(candidate) = candidates.into_iter().find(|candidate| candidate.is_file()) {
        return Ok(candidate);
    }
    for name in executable_names {
        if let Some(candidate) = super::find_with_login_shell(name).await {
            return Ok(candidate);
        }
    }
    Err("OpenKiwi could not find Cursor Agent. Install it from cursor.com/docs/cli, then sign in with `agent login`.".into())
}

async fn read_cursor_runtime_status(app: &AppHandle) -> CursorRuntimeStatus {
    let Ok(path) = resolve_cursor_binary(app).await else {
        return CursorRuntimeStatus {
            available: false,
            path: None,
            version: None,
            logged_in: false,
            email: None,
            subscription_type: None,
            warning: None,
        };
    };
    let output = Command::new(&path)
        .arg("about")
        .env("NO_COLOR", "1")
        .stdin(Stdio::null())
        .output()
        .await
        .ok();
    let plain = output
        .as_ref()
        .map(|value| {
            format!(
                "{}\n{}",
                String::from_utf8_lossy(&value.stdout),
                String::from_utf8_lossy(&value.stderr)
            )
        })
        .unwrap_or_default();
    let email = field_after_label(&plain, "User Email");
    let logged_in = email
        .as_deref()
        .is_some_and(|value| !value.eq_ignore_ascii_case("not logged in"));
    CursorRuntimeStatus {
        available: true,
        path: Some(path.to_string_lossy().into_owned()),
        version: field_after_label(&plain, "CLI Version")
            .or_else(|| field_after_label(&plain, "Version")),
        logged_in,
        email: logged_in.then_some(email).flatten(),
        subscription_type: field_after_label(&plain, "Subscription Tier")
            .filter(|value| !value.eq_ignore_ascii_case("unknown")),
        warning: None,
    }
}

#[tauri::command]
pub async fn cursor_runtime_status(
    app: AppHandle,
    state: State<'_, CursorState>,
) -> Result<CursorRuntimeStatus, String> {
    let status = read_cursor_runtime_status(&app).await;
    state
        .authenticated
        .store(status.logged_in, Ordering::Release);
    Ok(status)
}

#[tauri::command]
pub async fn cursor_login(app: AppHandle) -> Result<(), String> {
    let path = resolve_cursor_binary(&app).await?;
    #[cfg(target_os = "macos")]
    {
        let escaped = path.to_string_lossy().replace('\'', "'\"'\"'");
        let login_command = format!("'{}' login", escaped);
        let status = Command::new("/usr/bin/osascript")
            .args([
                "-e",
                "on run argv",
                "-e",
                "tell application \"Terminal\"",
                "-e",
                "activate",
                "-e",
                "do script (item 1 of argv)",
                "-e",
                "end tell",
                "-e",
                "end run",
                "--",
            ])
            .arg(login_command)
            .status()
            .await
            .map_err(|error| format!("Could not open Cursor sign-in in Terminal: {error}"))?;
        status.success().then_some(()).ok_or_else(|| {
            "Could not open Terminal. Run `agent login` yourself, then refresh Cursor status."
                .into()
        })
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = path;
        Err("Run `agent login` in a terminal, then refresh Cursor status.".into())
    }
}

fn permission_result(params: &Value, allow: bool) -> Value {
    let wanted = if allow {
        ["allow_always", "allow_once"]
    } else {
        ["reject_always", "reject_once"]
    };
    let option = wanted.iter().find_map(|kind| {
        params
            .get("options")
            .and_then(Value::as_array)?
            .iter()
            .find(|option| option.get("kind").and_then(Value::as_str) == Some(kind))
            .and_then(|option| option.get("optionId"))
            .and_then(Value::as_str)
    });
    option
        .map(|option_id| json!({ "outcome": { "outcome": "selected", "optionId": option_id } }))
        .unwrap_or_else(|| json!({ "outcome": { "outcome": "cancelled" } }))
}

async fn spawn_cursor_process(
    app: &AppHandle,
    cwd: &Path,
    event_context: Option<(String, String, String)>,
) -> Result<Arc<CursorProcess>, String> {
    let binary = resolve_cursor_binary(app).await?;
    let mut command = Command::new(&binary);
    command
        .arg("acp")
        .current_dir(cwd)
        .env("NO_COLOR", "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    // A dedicated process group lets kill_process_tree reach every
    // descendant the agent spawns, not just the direct child.
    #[cfg(unix)]
    command.process_group(0);
    let mut child = command.spawn().map_err(|error| {
        format!(
            "Could not start Cursor Agent at `{}`: {error}",
            binary.display()
        )
    })?;
    let stdin = Arc::new(Mutex::new(
        child
            .stdin
            .take()
            .ok_or("Cursor Agent did not expose stdin")?,
    ));
    let stdout = child
        .stdout
        .take()
        .ok_or("Cursor Agent did not expose stdout")?;
    let stderr = child.stderr.take();
    let pid = child.id();
    let child = Arc::new(Mutex::new(child));
    let pending: PendingMap = Arc::new(Mutex::new(HashMap::new()));
    let alive = Arc::new(AtomicBool::new(true));
    let process = Arc::new(CursorProcess {
        stdin: stdin.clone(),
        child: child.clone(),
        pid,
        pending: pending.clone(),
        next_id: AtomicI64::new(1),
        alive: alive.clone(),
        session_id: Mutex::new(None),
        turn_id: event_context
            .as_ref()
            .map(|(_, turn_id, _)| turn_id.clone()),
    });

    let app_for_reader = app.clone();
    let event_for_reader = event_context.clone();
    let alive_for_reader = alive.clone();
    tauri::async_runtime::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let Ok(message) = serde_json::from_str::<Value>(&line) else {
                // Surface unparseable output instead of dropping it, so a
                // wedged or misbehaving agent is visible in the thread.
                if let Some((thread_id, turn_id, _)) = event_for_reader.as_ref() {
                    let _ = app_for_reader.emit(
                        "cursor-event",
                        json!({
                            "threadId": thread_id, "turnId": turn_id,
                            "message": { "type": "stderr", "line": format!("Unparseable Cursor Agent output: {line}") }
                        }),
                    );
                }
                continue;
            };
            if let Some(id) = message.get("id").and_then(Value::as_i64) {
                if message.get("result").is_some() || message.get("error").is_some() {
                    if let Some(sender) = pending.lock().await.remove(&id) {
                        let result = if let Some(error) = message.get("error") {
                            Err(error
                                .get("message")
                                .and_then(Value::as_str)
                                .unwrap_or("Cursor Agent request failed")
                                .to_string())
                        } else {
                            Ok(message.get("result").cloned().unwrap_or(Value::Null))
                        };
                        let _ = sender.send(result);
                    }
                    continue;
                }
            }
            let method = message
                .get("method")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if method == "session/request_permission" {
                let params = message.get("params").cloned().unwrap_or_else(|| json!({}));
                if let (Some(id), Some((thread_id, turn_id, permission))) =
                    (message.get("id").cloned(), event_for_reader.as_ref())
                {
                    if permission == "ask" {
                        let _ = app_for_reader.emit("cursor-event", json!({
                            "threadId": thread_id, "turnId": turn_id,
                            "message": { "type": "permission_request", "requestId": id, "params": params }
                        }));
                    } else {
                        let result = permission_result(&params, permission == "full");
                        let _ = write_json(
                            &stdin,
                            &json!({ "jsonrpc": "2.0", "id": id, "result": result }),
                        )
                        .await;
                    }
                }
                continue;
            }
            if method == "cursor/ask_question" {
                if let (Some(id), Some((thread_id, turn_id, _))) =
                    (message.get("id").cloned(), event_for_reader.as_ref())
                {
                    let _ = app_for_reader.emit("cursor-event", json!({
                        "threadId": thread_id, "turnId": turn_id,
                        "message": { "type": "cursor_request", "method": method, "requestId": id, "params": message.get("params").cloned().unwrap_or(Value::Null) }
                    }));
                }
                continue;
            }
            if method == "cursor/create_plan" {
                if let Some((thread_id, turn_id, _)) = event_for_reader.as_ref() {
                    let _ = app_for_reader.emit("cursor-event", json!({
                        "threadId": thread_id, "turnId": turn_id,
                        "message": { "type": "notification", "method": method, "params": message.get("params").cloned().unwrap_or(Value::Null) }
                    }));
                }
                if let Some(id) = message.get("id").cloned() {
                    let _ = write_json(
                        &stdin,
                        &json!({ "jsonrpc": "2.0", "id": id, "result": { "accepted": true } }),
                    )
                    .await;
                }
                continue;
            }
            if message.get("id").is_some() && message.get("method").is_some() {
                if let Some(id) = message.get("id").cloned() {
                    let _ = write_json(&stdin, &json!({
                        "jsonrpc": "2.0", "id": id,
                        "error": { "code": -32601, "message": format!("OpenKiwi does not support Cursor request `{method}` yet") }
                    })).await;
                }
                continue;
            }
            if let Some((thread_id, turn_id, _)) = event_for_reader.as_ref() {
                let _ = app_for_reader.emit("cursor-event", json!({
                    "threadId": thread_id, "turnId": turn_id,
                    "message": { "type": "notification", "method": method, "params": message.get("params").cloned().unwrap_or(Value::Null) }
                }));
            }
        }
        let was_alive = alive_for_reader.swap(false, Ordering::AcqRel);
        let mut waiting = pending.lock().await;
        for (_, sender) in waiting.drain() {
            let _ = sender.send(Err("Cursor Agent connection closed".into()));
        }
        drop(waiting);
        if was_alive {
            if let Some((thread_id, turn_id, _)) = event_for_reader.as_ref() {
                let _ = app_for_reader.emit("cursor-event", json!({
                    "threadId": thread_id, "turnId": turn_id,
                    "message": { "type": "openkiwi_exit", "message": "Cursor Agent exited before completing the turn." }
                }));
            }
        }
        let mut child = child.lock().await;
        if timeout(Duration::from_secs(5), child.wait()).await.is_err() {
            let _ = child.kill().await;
        }
    });

    if let Some(stderr) = stderr {
        let app_for_stderr = app.clone();
        let event_for_stderr = event_context;
        tauri::async_runtime::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if let Some((thread_id, turn_id, _)) = event_for_stderr.as_ref() {
                    let _ = app_for_stderr.emit(
                        "cursor-event",
                        json!({
                            "threadId": thread_id, "turnId": turn_id,
                            "message": { "type": "stderr", "line": line }
                        }),
                    );
                }
            }
        });
    }
    Ok(process)
}

async fn initialize_cursor(process: &CursorProcess) -> Result<Value, String> {
    process
        .request(
            "initialize",
            json!({
                "protocolVersion": 1,
                "clientCapabilities": {
                    "fs": { "readTextFile": false, "writeTextFile": false },
                    "terminal": false,
                    "_meta": { "parameterizedModelPicker": true }
                },
                "clientInfo": { "name": "OpenKiwi", "version": env!("CARGO_PKG_VERSION") }
            }),
        )
        .await?;
    process
        .request("authenticate", json!({ "methodId": "cursor_login" }))
        .await
}

fn models_from_response(response: Value) -> Vec<CursorModel> {
    let mut models: Vec<CursorModel> = response
        .get("models")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|model| {
            let id = model.get("value")?.as_str()?.trim().to_string();
            let name = model.get("name")?.as_str()?.trim().to_string();
            (!id.is_empty() && !name.is_empty()).then(|| CursorModel {
                id,
                name,
                config_options: model
                    .get("configOptions")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default(),
            })
        })
        .collect();
    models.sort_by_key(|model| model.name.to_lowercase());
    models.dedup_by(|left, right| left.id == right.id);
    models
}

fn model_config_id(setup: &Value) -> Option<String> {
    setup
        .get("configOptions")?
        .as_array()?
        .iter()
        .find(|option| option.get("category").and_then(Value::as_str) == Some("model"))
        .and_then(|option| option.get("id"))
        .and_then(Value::as_str)
        .map(str::to_string)
}

#[tauri::command]
pub async fn cursor_models(app: AppHandle) -> Result<Vec<CursorModel>, String> {
    // The model catalog query needs a working directory but no project;
    // OpenKiwi's own data folder avoids handing the agent a shared /tmp cwd.
    let workspace = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Could not resolve OpenKiwi app data: {error}"))?;
    tokio::fs::create_dir_all(&workspace)
        .await
        .map_err(|error| format!("Could not create OpenKiwi app data: {error}"))?;
    let process = spawn_cursor_process(&app, &workspace, None).await?;
    let result = async {
        initialize_cursor(&process).await?;
        let response = process
            .request("cursor/list_available_models", json!({}))
            .await?;
        Ok(models_from_response(response))
    }
    .await;
    process.shutdown().await;
    result
}

fn config_option_id(setup: &Value, effort: &str) -> Option<(String, Value)> {
    let options = setup.get("configOptions")?.as_array()?;
    for option in options {
        let id = option.get("id").and_then(Value::as_str).unwrap_or_default();
        let name = option
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let normalized = format!("{id} {name}").to_lowercase();
        if !normalized.contains("reason")
            && !normalized.contains("effort")
            && !normalized.contains("thinking")
        {
            continue;
        }
        let values = option.get("options").and_then(Value::as_array);
        let value = values
            .and_then(|entries| {
                entries.iter().find_map(|entry| {
                    let candidate = entry.get("value").and_then(Value::as_str)?;
                    (candidate.eq_ignore_ascii_case(effort)
                        || entry
                            .get("name")
                            .and_then(Value::as_str)
                            .is_some_and(|name| name.eq_ignore_ascii_case(effort)))
                    .then(|| Value::String(candidate.to_string()))
                })
            })
            .unwrap_or_else(|| Value::String(effort.to_string()));
        return Some((id.to_string(), value));
    }
    None
}

async fn cursor_prompt_blocks(options: &CursorTurnOptions) -> Result<Vec<Value>, String> {
    let mut text = options.prompt.clone();
    if !options.system_prompt.trim().is_empty() {
        text = format!(
            "<openkiwi_instructions>\n{}\n</openkiwi_instructions>\n\n{}",
            options.system_prompt.trim(),
            text
        );
    }
    let mut blocks = vec![json!({ "type": "text", "text": text })];
    for attachment in &options.attachments {
        if attachment.kind == "image" {
            let bytes = super::read_image_attachment(Path::new(&attachment.path)).await?;
            let extension = Path::new(&attachment.path)
                .extension()
                .and_then(|value| value.to_str())
                .unwrap_or("png")
                .to_lowercase();
            let mime = match extension.as_str() {
                "jpg" | "jpeg" => "image/jpeg",
                "gif" => "image/gif",
                "webp" => "image/webp",
                _ => "image/png",
            };
            blocks.push(json!({
                "type": "image", "mimeType": mime,
                "data": base64::engine::general_purpose::STANDARD.encode(bytes),
                "uri": format!("file://{}", attachment.path)
            }));
        } else {
            blocks.push(json!({
                "type": "resource_link", "name": Path::new(&attachment.path).file_name().and_then(|value| value.to_str()).unwrap_or("attachment"),
                "uri": format!("file://{}", attachment.path)
            }));
        }
    }
    Ok(blocks)
}

#[tauri::command]
pub async fn cursor_turn_start(
    app: AppHandle,
    state: State<'_, CursorState>,
    agent_state: State<'_, ChildAgentState>,
    options: CursorTurnOptions,
) -> Result<CursorTurnStarted, String> {
    if options.cwd.trim().is_empty() || !Path::new(&options.cwd).is_dir() {
        return Err("Choose a valid project folder before starting this Cursor thread.".into());
    }
    if !state.authenticated.load(Ordering::Acquire) {
        let status = read_cursor_runtime_status(&app).await;
        state
            .authenticated
            .store(status.logged_in, Ordering::Release);
        if !status.logged_in {
            return Err("Sign in to Cursor Agent before sending a message.".into());
        }
    }
    if state
        .turns
        .lock()
        .await
        .get(&options.thread_id)
        .is_some_and(|turn| turn.alive.load(Ordering::Acquire))
    {
        return Err("Cursor is already working in this thread".into());
    }
    if let Some(bridge) = options.child_agent_bridge.as_ref() {
        if !child_agent_bridge_launch_registered(
            &agent_state,
            &bridge.name,
            &bridge.command,
            &bridge.args,
        )
        .await
        {
            return Err("The sub-agent bridge configuration is no longer active.".into());
        }
    }
    let turn_id = uuid::Uuid::new_v4().to_string();
    let process = spawn_cursor_process(
        &app,
        Path::new(&options.cwd),
        Some((
            options.thread_id.clone(),
            turn_id.clone(),
            options.permission.clone(),
        )),
    )
    .await?;
    if !super::claim_turn_slot(&state.turns, &options.thread_id, &process, |existing| {
        existing.alive.load(Ordering::Acquire)
    })
    .await
    {
        process.shutdown().await;
        return Err("Cursor is already working in this thread".into());
    }

    let start_result = async {
        initialize_cursor(&process).await?;
        let mcp_servers = acp_mcp_servers(options.child_agent_bridge.as_ref());
        let setup = if let Some(session_id) = options.resume_session_id.as_deref() {
            process
                .request(
                    "session/load",
                    json!({ "sessionId": session_id, "cwd": options.cwd, "mcpServers": mcp_servers }),
                )
                .await?
        } else {
            process
                .request(
                    "session/new",
                    json!({ "cwd": options.cwd, "mcpServers": mcp_servers }),
                )
                .await?
        };
        let session_id = options
            .resume_session_id
            .clone()
            .or_else(|| {
                setup
                    .get("sessionId")
                    .and_then(Value::as_str)
                    .map(str::to_string)
            })
            .ok_or("Cursor Agent did not return a session ID")?;
        *process.session_id.lock().await = Some(session_id.clone());
        if !options.model.trim().is_empty() && !options.model.eq_ignore_ascii_case("auto") {
            if let Some(config_id) = model_config_id(&setup) {
                process
                    .request(
                        "session/set_config_option",
                        json!({ "sessionId": session_id, "configId": config_id, "value": options.model.trim() }),
                    )
                    .await?;
            } else {
                process
                    .request(
                        "session/set_model",
                        json!({ "sessionId": session_id, "modelId": options.model.trim() }),
                    )
                    .await?;
            }
        }
        if let Some((config_id, value)) = config_option_id(&setup, &options.effort) {
            let _ = process
                .request(
                    "session/set_config_option",
                    json!({ "sessionId": session_id, "configId": config_id, "value": value }),
                )
                .await;
        }
        let blocks = cursor_prompt_blocks(&options).await?;
        Ok::<_, String>((session_id, blocks))
    }
    .await;
    let (session_id, blocks) = match start_result {
        Ok(value) => value,
        Err(error) => {
            let mut turns = state.turns.lock().await;
            if turns
                .get(&options.thread_id)
                .is_some_and(|current| Arc::ptr_eq(current, &process))
            {
                turns.remove(&options.thread_id);
            }
            drop(turns);
            process.shutdown().await;
            return Err(error);
        }
    };

    let app_for_prompt = app.clone();
    let thread_id = options.thread_id.clone();
    let turn_id_for_prompt = turn_id.clone();
    let turns = state.turns.clone();
    let process_for_prompt = process.clone();
    let prompt_session_id = session_id.clone();
    tauri::async_runtime::spawn(async move {
        let result = process_for_prompt
            .request(
                "session/prompt",
                json!({ "sessionId": prompt_session_id, "prompt": blocks }),
            )
            .await;
        match result {
            Ok(result) => {
                let _ = app_for_prompt.emit(
                    "cursor-event",
                    json!({
                        "threadId": thread_id, "turnId": turn_id_for_prompt,
                        "message": { "type": "result", "result": result }
                    }),
                );
            }
            Err(error) => {
                let _ = app_for_prompt.emit(
                    "cursor-event",
                    json!({
                        "threadId": thread_id, "turnId": turn_id_for_prompt,
                        "message": { "type": "openkiwi_error", "message": error }
                    }),
                );
            }
        }
        process_for_prompt.alive.store(false, Ordering::Release);
        process_for_prompt.shutdown().await;
        let mut turns = turns.lock().await;
        if turns
            .get(&thread_id)
            .is_some_and(|current| Arc::ptr_eq(current, &process_for_prompt))
        {
            turns.remove(&thread_id);
        }
    });

    Ok(CursorTurnStarted {
        turn_id,
        cursor_session_id: session_id,
    })
}

#[tauri::command]
pub async fn cursor_turn_steer(
    app: AppHandle,
    state: State<'_, CursorState>,
    thread_id: String,
    prompt: String,
) -> Result<(), String> {
    let turn = state
        .turns
        .lock()
        .await
        .get(&thread_id)
        .cloned()
        .ok_or("Cursor is not currently running in this thread")?;
    let session_id = turn
        .session_id
        .lock()
        .await
        .clone()
        .ok_or("Cursor session is still starting")?;
    let turn_for_prompt = turn.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(error) = turn_for_prompt
            .request(
                "session/prompt",
                json!({
                    "sessionId": session_id,
                    "prompt": [{ "type": "text", "text": prompt }]
                }),
            )
            .await
        {
            // A dropped steer means the user's guidance never reached the
            // agent; surface it instead of failing silently.
            let _ = app.emit(
                "cursor-event",
                json!({
                    "threadId": thread_id,
                    "turnId": turn_for_prompt.turn_id.clone().unwrap_or_default(),
                    "message": {
                        "type": "openkiwi_error",
                        "message": format!("Cursor did not accept the added instructions: {error}"),
                    }
                }),
            );
        }
    });
    Ok(())
}

#[tauri::command]
pub async fn cursor_turn_interrupt(
    state: State<'_, CursorState>,
    thread_id: String,
) -> Result<(), String> {
    let turn = state
        .turns
        .lock()
        .await
        .get(&thread_id)
        .cloned()
        .ok_or("Cursor is not currently running in this thread")?;
    let session_id = turn
        .session_id
        .lock()
        .await
        .clone()
        .ok_or("Cursor session is still starting")?;
    turn.notify("session/cancel", json!({ "sessionId": session_id }))
        .await
}

#[tauri::command]
pub async fn cursor_turn_kill(
    state: State<'_, CursorState>,
    thread_id: String,
) -> Result<(), String> {
    let turn = state
        .turns
        .lock()
        .await
        .remove(&thread_id)
        .ok_or("Cursor is not currently running in this thread")?;
    turn.shutdown().await;
    Ok(())
}

#[tauri::command]
pub async fn cursor_turn_active(
    state: State<'_, CursorState>,
    thread_id: String,
) -> Result<bool, String> {
    Ok(state
        .turns
        .lock()
        .await
        .get(&thread_id)
        .is_some_and(|turn| turn.alive.load(Ordering::Acquire)))
}

#[tauri::command]
pub async fn cursor_permission_respond(
    state: State<'_, CursorState>,
    thread_id: String,
    request_id: Value,
    result: Value,
) -> Result<(), String> {
    let turn = state
        .turns
        .lock()
        .await
        .get(&thread_id)
        .cloned()
        .ok_or("Cursor is not currently running in this thread")?;
    turn.respond(request_id, result).await
}

pub fn shutdown_cursor_on_exit(app: &AppHandle) {
    let Some(state) = app.try_state::<CursorState>() else {
        return;
    };
    let turns = tauri::async_runtime::block_on(async {
        match timeout(Duration::from_millis(500), state.turns.lock()).await {
            Ok(mut guard) => guard.drain().map(|(_, turn)| turn).collect::<Vec<_>>(),
            Err(_) => Vec::new(),
        }
    });
    for turn in turns {
        let stopped = tauri::async_runtime::block_on(async {
            timeout(Duration::from_secs(2), turn.shutdown())
                .await
                .is_ok()
        });
        if !stopped {
            if let Some(pid) = turn.pid {
                super::kill_process_tree(pid);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_cursor_about_fields() {
        let output = "About Cursor CLI\n\nCLI Version         2026.07.23\nSubscription Tier   Pro\nUser Email          person@example.com\n";
        assert_eq!(
            field_after_label(output, "CLI Version").as_deref(),
            Some("2026.07.23")
        );
        assert_eq!(
            field_after_label(output, "Subscription Tier").as_deref(),
            Some("Pro")
        );
        assert_eq!(
            field_after_label(output, "User Email").as_deref(),
            Some("person@example.com")
        );
    }

    #[test]
    fn chooses_allow_and_reject_permission_options() {
        let params = json!({ "options": [
            { "kind": "allow_once", "optionId": "yes" },
            { "kind": "reject_once", "optionId": "no" }
        ] });
        assert_eq!(
            permission_result(&params, true)
                .pointer("/outcome/optionId")
                .and_then(Value::as_str),
            Some("yes")
        );
        assert_eq!(
            permission_result(&params, false)
                .pointer("/outcome/optionId")
                .and_then(Value::as_str),
            Some("no")
        );
    }

    #[test]
    fn normalizes_cursor_model_catalog() {
        let models = models_from_response(json!({ "models": [
            { "value": "cursor-grok-4.5", "name": "Grok 4.5" },
            { "value": "auto", "name": "Auto" }
        ] }));
        assert_eq!(models.len(), 2);
        assert!(models.iter().any(|model| model.name == "Grok 4.5"));
    }

    #[test]
    fn finds_cursor_model_config_option() {
        let setup =
            json!({ "configOptions": [{ "id": "model", "category": "model", "type": "select" }] });
        assert_eq!(model_config_id(&setup).as_deref(), Some("model"));
    }
}
