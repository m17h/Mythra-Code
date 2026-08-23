#[cfg(windows)]
use std::fs;
use std::{
    collections::HashMap,
    env,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        atomic::{AtomicBool, AtomicI64, AtomicUsize, Ordering},
        Arc,
    },
};

use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin},
    sync::{oneshot, Mutex},
    time::{timeout, timeout_at, Duration, Instant},
};

use crate::agents::{child_agent_bridge_launch_registered, ChildAgentState};
use crate::process_launch::background_command;
#[cfg(windows)]
use crate::process_launch::interactive_command;

type PendingMap = Arc<Mutex<HashMap<i64, oneshot::Sender<Result<Value, String>>>>>;

/// How long to wait for one ACP reply, or `None` for "as long as the process
/// lives".
///
/// A control handshake that stalls is a wedged agent, so it keeps a short
/// deadline. The two exceptions are the calls whose duration is the agent's
/// work rather than ours: `session/prompt` runs the whole turn, and creating or
/// loading a session also cold-starts every MCP server the session declares —
/// which, for an OpenKiwi sub-agent crew, means launching the delegation bridge
/// before Cursor answers.
pub(super) fn cursor_request_timeout(method: &str) -> Option<Duration> {
    match method {
        "session/prompt" => None,
        "session/new" | "session/load" => Some(Duration::from_secs(180)),
        _ => Some(Duration::from_secs(45)),
    }
}

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
    /// Outstanding `session/prompt` requests. A steer queues a second prompt
    /// on the same session; only the last one to settle may take the process
    /// down, or a completing primary prompt would kill its own steer.
    active_prompts: AtomicUsize,
    session_id: Mutex<Option<String>>,
    turn_id: Option<String>,
    wsl: bool,
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
fn acp_mcp_servers(bridge: Option<&ChildAgentBridge>, wsl: bool) -> Result<Value, String> {
    match bridge {
        Some(bridge) => {
            let command = cursor_runtime_path(&bridge.command, wsl)?;
            Ok(json!([{
                "name": bridge.name,
                "command": command,
                "args": bridge.args,
                "env": [],
            }]))
        }
        None => Ok(json!([])),
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
        // `session/prompt` owns the full agent run, not just an ACP handshake.
        // It must follow the process lifetime: the reader drains this channel
        // on EOF, and Stop kills the process, so no arbitrary wall-clock limit
        // is needed to keep it cancellable.
        let Some(deadline) = cursor_request_timeout(method) else {
            return match receiver.await {
                Ok(result) => result,
                Err(_) => Err(format!("Cursor Agent dropped its `{method}` response")),
            };
        };
        match timeout(deadline, receiver).await {
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
        let value = value.strip_prefix(':').unwrap_or(value).trim();
        (!value.is_empty()).then(|| value.to_string())
    })
}

#[derive(Clone, Debug)]
enum CursorRuntime {
    Native(PathBuf),
    #[cfg(windows)]
    WindowsNode {
        launcher: PathBuf,
        node: PathBuf,
        script: PathBuf,
    },
    #[cfg(windows)]
    Wsl(String),
}

impl CursorRuntime {
    fn is_wsl(&self) -> bool {
        match self {
            Self::Native(_) => false,
            #[cfg(windows)]
            Self::WindowsNode { .. } => false,
            #[cfg(windows)]
            Self::Wsl(_) => true,
        }
    }

    fn display_path(&self) -> String {
        match self {
            Self::Native(path) => path.to_string_lossy().into_owned(),
            #[cfg(windows)]
            Self::WindowsNode { launcher, .. } => launcher.to_string_lossy().into_owned(),
            #[cfg(windows)]
            Self::Wsl(path) => format!("WSL: {path}"),
        }
    }

    fn background(&self, cwd: Option<&Path>) -> tokio::process::Command {
        match self {
            Self::Native(path) => {
                let mut command = background_command(path);
                if let Some(cwd) = cwd {
                    command.current_dir(cwd);
                }
                command
            }
            #[cfg(windows)]
            Self::WindowsNode { node, script, .. } => {
                let mut command = background_command(node);
                command.arg(script);
                if let Some(cwd) = cwd {
                    command.current_dir(cwd);
                }
                command
            }
            #[cfg(windows)]
            Self::Wsl(path) => {
                let mut command = background_command("wsl.exe");
                if let Some(cwd) = cwd {
                    command.arg("--cd").arg(cwd);
                }
                command.args(["--exec", path]);
                command
            }
        }
    }

    #[cfg(windows)]
    fn interactive(&self) -> tokio::process::Command {
        match self {
            Self::Native(path) => interactive_command(path),
            Self::WindowsNode { node, script, .. } => {
                let mut command = interactive_command(node);
                command.arg(script);
                command
            }
            Self::Wsl(path) => {
                let mut command = interactive_command("wsl.exe");
                command.args(["--exec", path]);
                command
            }
        }
    }
}

/// Translate a host path before handing it to a Linux Cursor process. WSL's
/// `--cd` understands Windows paths, but ACP payloads and MCP launch records
/// are interpreted by the Linux process itself and therefore require `/mnt/*`.
fn cursor_runtime_path(path: &str, wsl: bool) -> Result<String, String> {
    if !wsl || path.starts_with('/') {
        return Ok(path.to_string());
    }
    #[cfg(windows)]
    {
        let bytes = path.as_bytes();
        if bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
            let drive = (bytes[0] as char).to_ascii_lowercase();
            let rest = path[2..].replace('\\', "/");
            return Ok(format!("/mnt/{drive}/{}", rest.trim_start_matches('/')));
        }
        Err(format!(
            "Cursor Agent in WSL cannot access the Windows path `{path}`. Use a folder on a local Windows drive."
        ))
    }
    #[cfg(not(windows))]
    {
        Ok(path.to_string())
    }
}

#[cfg(windows)]
async fn resolve_cursor_in_wsl() -> Option<CursorRuntime> {
    let output = background_command("wsl.exe")
        .args([
            "--exec",
            "sh",
            "-lc",
            "command -v cursor-agent || command -v agent",
        ])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .await
        .ok()?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(str::trim)
        .find(|line| line.starts_with('/'))
        .map(|path| CursorRuntime::Wsl(path.to_string()))
}

#[cfg(windows)]
fn push_windows_cursor_candidates_at(candidates: &mut Vec<PathBuf>, local_app_data: &Path) {
    let install_root = local_app_data.join("cursor-agent");
    // Cursor's official native Windows installer does not ship the CLI with
    // the desktop editor. It installs these launchers separately and updates
    // the user's PATH, which an already-running GUI process may not inherit.
    // Checking the documented install root makes detection immediate and
    // reliable after installation without restarting Windows.
    super::push_candidate(candidates, install_root.join("agent.exe"));
    super::push_candidate(candidates, install_root.join("cursor-agent.exe"));
}

#[cfg(windows)]
fn resolve_windows_cursor_install_at(local_app_data: &Path) -> Option<CursorRuntime> {
    let install_root = local_app_data.join("cursor-agent");
    for executable in ["agent.exe", "cursor-agent.exe"] {
        let path = install_root.join(executable);
        if path.is_file() {
            return Some(CursorRuntime::Native(path));
        }
    }

    // The current native installer ships cmd/PowerShell launchers backed by a
    // private Node runtime. Launching the payload directly preserves ACP's
    // stdin/stdout transport and avoids cmd.exe quoting or console windows.
    let mut versions = fs::read_dir(install_root.join("versions"))
        .ok()?
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_dir()))
        .collect::<Vec<_>>();
    versions.sort_by_key(|entry| std::cmp::Reverse(entry.file_name()));
    versions.into_iter().find_map(|entry| {
        let version = entry.path();
        let node = version.join("node.exe");
        let script = version.join("index.js");
        (node.is_file() && script.is_file()).then(|| CursorRuntime::WindowsNode {
            launcher: install_root.join("agent.cmd"),
            node,
            script,
        })
    })
}

async fn resolve_cursor_runtime(app: &AppHandle) -> Result<CursorRuntime, String> {
    if let Some(override_path) = env::var_os("OPENKIWI_CURSOR_PATH") {
        let override_path = PathBuf::from(override_path);
        return override_path
            .is_file()
            .then_some(CursorRuntime::Native(override_path))
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
    #[cfg(windows)]
    if let Some(local_app_data) = env::var_os("LOCALAPPDATA").map(PathBuf::from) {
        push_windows_cursor_candidates_at(&mut candidates, &local_app_data);
        if let Some(runtime) = resolve_windows_cursor_install_at(&local_app_data) {
            return Ok(runtime);
        }
    }
    for name in executable_names {
        if let Some(candidate) = super::find_on_path(name) {
            super::push_candidate(&mut candidates, candidate);
        }
    }
    if let Ok(home) = app.path().home_dir() {
        for relative in [
            ".local/bin/agent",
            ".local/bin/agent.exe",
            ".local/bin/cursor-agent",
            ".local/bin/cursor-agent.exe",
            ".cursor/bin/agent",
            ".cursor/bin/agent.exe",
        ] {
            super::push_candidate(&mut candidates, home.join(relative));
        }
    }
    if let Some(candidate) = candidates.into_iter().find(|candidate| candidate.is_file()) {
        return Ok(CursorRuntime::Native(candidate));
    }
    for name in executable_names {
        if let Some(candidate) = super::find_with_login_shell(name).await {
            return Ok(CursorRuntime::Native(candidate));
        }
    }
    #[cfg(windows)]
    if let Some(runtime) = resolve_cursor_in_wsl().await {
        return Ok(runtime);
    }
    #[cfg(windows)]
    return Err("OpenKiwi could not find Cursor Agent. The Cursor desktop editor and Cursor Agent CLI are separate installs. Install the official native Windows CLI, then return here to sign in.".into());
    #[cfg(not(windows))]
    Err("OpenKiwi could not find Cursor Agent. Install it from cursor.com/docs/cli, then sign in with `cursor-agent login`.".into())
}

async fn read_cursor_runtime_status(app: &AppHandle) -> CursorRuntimeStatus {
    let runtime = match resolve_cursor_runtime(app).await {
        Ok(runtime) => runtime,
        Err(error) => {
            return CursorRuntimeStatus {
                available: false,
                path: None,
                version: None,
                logged_in: false,
                email: None,
                subscription_type: None,
                warning: Some(error),
            };
        }
    };
    let output = runtime
        .background(None)
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
        path: Some(runtime.display_path()),
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
    let runtime = resolve_cursor_runtime(&app).await?;
    #[cfg(target_os = "macos")]
    {
        let CursorRuntime::Native(path) = runtime;
        let escaped = path.to_string_lossy().replace('\'', "'\"'\"'");
        let login_command = format!("'{}' login", escaped);
        let status = background_command("/usr/bin/osascript")
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
    #[cfg(windows)]
    {
        runtime
            .interactive()
            .arg("login")
            .stdin(Stdio::inherit())
            .stdout(Stdio::inherit())
            .stderr(Stdio::inherit())
            .spawn()
            .map(|_| ())
            .map_err(|error| {
                format!(
                    "Could not open Cursor sign-in in a Windows terminal: {error}. Run `cursor-agent login` in WSL, then refresh Cursor status."
                )
            })
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        let _ = runtime;
        Err("Run `cursor-agent login` in a terminal, then refresh Cursor status.".into())
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
    let runtime = resolve_cursor_runtime(app).await?;
    let mut command = runtime.background(Some(cwd));
    command
        .arg("acp")
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
            runtime.display_path()
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
        active_prompts: AtomicUsize::new(0),
        session_id: Mutex::new(None),
        turn_id: event_context
            .as_ref()
            .map(|(_, turn_id, _)| turn_id.clone()),
        wsl: runtime.is_wsl(),
    });

    let app_for_reader = app.clone();
    let event_for_reader = event_context.clone();
    let alive_for_reader = alive.clone();
    tauri::async_runtime::spawn(async move {
        const DELTA_FLUSH_INTERVAL: Duration = Duration::from_millis(25);
        let mut lines = BufReader::new(stdout).lines();
        // High-frequency ACP notifications (`session/update` and friends) are
        // coalesced into a single "cursor-events" array emit, mirroring the
        // Codex and Claude readers: flushed on a ~25ms tick or before any
        // other message so ordering is strictly preserved. Each entry is
        // exactly the payload a per-line "cursor-event" emit would carry.
        let mut delta_buffer: Vec<Value> = Vec::new();
        let mut flush_deadline = Instant::now();
        let flush_deltas = |buffer: &mut Vec<Value>, app: &AppHandle| {
            if !buffer.is_empty() {
                let batch = std::mem::take(buffer);
                let _ = app.emit("cursor-events", Value::Array(batch));
            }
        };
        loop {
            // `Lines::next_line` is cancellation safe, so racing it against
            // the flush deadline cannot drop partial lines.
            let next = if delta_buffer.is_empty() {
                lines.next_line().await
            } else {
                match timeout_at(flush_deadline, lines.next_line()).await {
                    Ok(next) => next,
                    Err(_) => {
                        flush_deltas(&mut delta_buffer, &app_for_reader);
                        continue;
                    }
                }
            };
            let line = match next {
                Ok(Some(line)) => line,
                _ => break,
            };
            let Ok(message) = serde_json::from_str::<Value>(&line) else {
                // Surface unparseable output instead of dropping it, so a
                // wedged or misbehaving agent is visible in the thread.
                flush_deltas(&mut delta_buffer, &app_for_reader);
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
                    // A settled request can trigger turn completion handling;
                    // deliver buffered updates first so order is preserved.
                    flush_deltas(&mut delta_buffer, &app_for_reader);
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
                flush_deltas(&mut delta_buffer, &app_for_reader);
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
                flush_deltas(&mut delta_buffer, &app_for_reader);
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
                flush_deltas(&mut delta_buffer, &app_for_reader);
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
                flush_deltas(&mut delta_buffer, &app_for_reader);
                if let Some(id) = message.get("id").cloned() {
                    let _ = write_json(&stdin, &json!({
                        "jsonrpc": "2.0", "id": id,
                        "error": { "code": -32601, "message": format!("OpenKiwi does not support Cursor request `{method}` yet") }
                    })).await;
                }
                continue;
            }
            if let Some((thread_id, turn_id, _)) = event_for_reader.as_ref() {
                if delta_buffer.is_empty() {
                    flush_deadline = Instant::now() + DELTA_FLUSH_INTERVAL;
                }
                delta_buffer.push(json!({
                    "threadId": thread_id, "turnId": turn_id,
                    "message": { "type": "notification", "method": method, "params": message.get("params").cloned().unwrap_or(Value::Null) }
                }));
            }
        }
        flush_deltas(&mut delta_buffer, &app_for_reader);
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

async fn cursor_prompt_blocks_for(
    prompt: &str,
    system_prompt: &str,
    attachments: &[CursorAttachment],
    wsl: bool,
) -> Result<Vec<Value>, String> {
    let mut text = prompt.to_string();
    if !system_prompt.trim().is_empty() {
        text = format!(
            "<openkiwi_instructions>\n{}\n</openkiwi_instructions>\n\n{}",
            system_prompt.trim(),
            text
        );
    }
    let mut blocks = vec![json!({ "type": "text", "text": text })];
    for attachment in attachments {
        let runtime_path = cursor_runtime_path(&attachment.path, wsl)?;
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
                "uri": format!("file://{runtime_path}")
            }));
        } else {
            blocks.push(json!({
                "type": "resource_link", "name": Path::new(&attachment.path).file_name().and_then(|value| value.to_str()).unwrap_or("attachment"),
                "uri": format!("file://{runtime_path}")
            }));
        }
    }
    Ok(blocks)
}

async fn cursor_prompt_blocks(
    options: &CursorTurnOptions,
    wsl: bool,
) -> Result<Vec<Value>, String> {
    cursor_prompt_blocks_for(
        &options.prompt,
        &options.system_prompt,
        &options.attachments,
        wsl,
    )
    .await
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
        let mcp_servers = acp_mcp_servers(options.child_agent_bridge.as_ref(), process.wsl)?;
        let runtime_cwd = cursor_runtime_path(&options.cwd, process.wsl)?;
        let setup = if let Some(session_id) = options.resume_session_id.as_deref() {
            process
                .request(
                    "session/load",
                    json!({ "sessionId": session_id, "cwd": runtime_cwd, "mcpServers": mcp_servers }),
                )
                .await?
        } else {
            process
                .request(
                    "session/new",
                    json!({ "cwd": runtime_cwd, "mcpServers": mcp_servers }),
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
        let blocks = cursor_prompt_blocks(&options, process.wsl).await?;
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
    process.active_prompts.fetch_add(1, Ordering::AcqRel);
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
        // A steer queued behind this prompt is still running on the same
        // session; only the last outstanding prompt tears the process down.
        if process_for_prompt
            .active_prompts
            .fetch_sub(1, Ordering::AcqRel)
            == 1
        {
            process_for_prompt.alive.store(false, Ordering::Release);
            process_for_prompt.shutdown().await;
            let mut turns = turns.lock().await;
            if turns
                .get(&thread_id)
                .is_some_and(|current| Arc::ptr_eq(current, &process_for_prompt))
            {
                turns.remove(&thread_id);
            }
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
    attachments: Vec<CursorAttachment>,
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
    let turns_for_prompt = state.turns.clone();
    let blocks = cursor_prompt_blocks_for(&prompt, "", &attachments, turn.wsl).await?;
    turn.active_prompts.fetch_add(1, Ordering::AcqRel);
    tauri::async_runtime::spawn(async move {
        if let Err(error) = turn_for_prompt
            .request(
                "session/prompt",
                json!({
                    "sessionId": session_id,
                    "prompt": blocks
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
        // The primary prompt increments before any steer can exist, so a
        // count reaching zero here means it already settled and skipped its
        // teardown; this steer inherits that duty.
        if turn_for_prompt
            .active_prompts
            .fetch_sub(1, Ordering::AcqRel)
            == 1
        {
            turn_for_prompt.alive.store(false, Ordering::Release);
            turn_for_prompt.shutdown().await;
            let mut turns = turns_for_prompt.lock().await;
            if turns
                .get(&thread_id)
                .is_some_and(|current| Arc::ptr_eq(current, &turn_for_prompt))
            {
                turns.remove(&thread_id);
            }
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

/// Force-stop the Cursor process for a thread. Deliberately idempotent, like
/// its Claude counterpart: Stop means "this thread is not running when I
/// return", so a turn that already exited is success, not an error the UI has
/// to show instead of settling the thread.
#[tauri::command]
pub async fn cursor_turn_kill(
    state: State<'_, CursorState>,
    thread_id: String,
) -> Result<(), String> {
    let turn = state.turns.lock().await.remove(&thread_id);
    if let Some(turn) = turn {
        turn.shutdown().await;
    }
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
        assert_eq!(
            field_after_label("User Email: person@example.com", "User Email").as_deref(),
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

    #[cfg(windows)]
    #[test]
    fn translates_windows_paths_for_cursor_in_wsl() {
        assert_eq!(
            cursor_runtime_path(r"C:\Users\Person\Project\file.rs", true).as_deref(),
            Ok("/mnt/c/Users/Person/Project/file.rs")
        );
        assert_eq!(
            cursor_runtime_path(r"C:\Users\Person\Project", false).as_deref(),
            Ok(r"C:\Users\Person\Project")
        );
    }

    #[cfg(windows)]
    #[test]
    fn includes_official_native_windows_cursor_install_paths() {
        let mut candidates = Vec::new();
        push_windows_cursor_candidates_at(
            &mut candidates,
            Path::new(r"C:\Users\Person\AppData\Local"),
        );
        assert_eq!(
            candidates,
            vec![
                PathBuf::from(r"C:\Users\Person\AppData\Local\cursor-agent\agent.exe"),
                PathBuf::from(r"C:\Users\Person\AppData\Local\cursor-agent\cursor-agent.exe"),
            ]
        );
    }

    #[cfg(windows)]
    #[test]
    fn resolves_current_native_windows_cursor_node_payload() {
        let local_app_data =
            env::temp_dir().join(format!("openkiwi-cursor-{}", uuid::Uuid::new_v4()));
        let version = local_app_data.join("cursor-agent/versions/2026.08.11-e8db854");
        fs::create_dir_all(&version).unwrap();
        fs::write(version.join("node.exe"), b"test").unwrap();
        fs::write(version.join("index.js"), b"test").unwrap();
        fs::write(local_app_data.join("cursor-agent/agent.cmd"), b"test").unwrap();

        let runtime = resolve_windows_cursor_install_at(&local_app_data).unwrap();
        assert_eq!(
            PathBuf::from(runtime.display_path()),
            local_app_data.join("cursor-agent/agent.cmd")
        );

        fs::remove_dir_all(local_app_data).unwrap();
    }
}
