#[cfg(windows)]
use std::fs;
use std::{
    collections::{HashMap, HashSet},
    env,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        atomic::{AtomicBool, AtomicI64, Ordering},
        Arc, Mutex as StdMutex, MutexGuard as StdMutexGuard, PoisonError,
    },
};

use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, ChildStdout},
    sync::{oneshot, Mutex, Notify},
    time::{timeout, timeout_at, Duration, Instant},
};

use crate::agents::{child_agent_bridge_launch_registered, ChildAgentState};
use crate::process_launch::background_command;
#[cfg(windows)]
use crate::process_launch::interactive_command;

type PendingMap = Arc<Mutex<HashMap<i64, oneshot::Sender<Result<Value, String>>>>>;
type CursorTurns = Arc<Mutex<HashMap<String, Arc<CursorProcess>>>>;
/// Where a Cursor process publishes renderer events (`app.emit` in the app).
type CursorEmit = Arc<dyn Fn(&str, Value) + Send + Sync>;

/// Upper bound for taking the input pipe, writing one ACP message, and
/// flushing it. An agent that stops reading stdin must not wedge every later
/// request, permission reply, or Stop behind the pipe lock.
const CURSOR_INPUT_TIMEOUT: Duration = Duration::from_secs(60);
/// How long a kill waits for the direct child to be reaped.
const CURSOR_KILL_REAP_GRACE: Duration = Duration::from_secs(2);
const CURSOR_EXITED_EARLY: &str = "Cursor Agent exited before completing the turn.";
const CURSOR_STOPPED: &str = "Cursor Agent stopped.";

/// How long to wait for one ACP reply, or `None` for "as long as the process
/// lives".
///
/// A control handshake that stalls is a wedged agent, so it keeps a short
/// deadline. The two exceptions are the calls whose duration is the agent's
/// work rather than ours: `session/prompt` runs the whole turn, and creating or
/// loading a session also cold-starts every MCP server the session declares —
/// which, for an Mythra Code sub-agent crew, means launching the delegation bridge
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
    turns: CursorTurns,
    authenticated: AtomicBool,
}

struct CursorProcess {
    stdin: Mutex<ChildStdin>,
    child: Arc<Mutex<Child>>,
    pid: Option<u32>,
    pending: PendingMap,
    next_id: AtomicI64,
    alive: AtomicBool,
    input_timeout: Duration,
    /// The `session/prompt` requests (primary plus steers) of this turn.
    run: CursorPromptRun,
    /// `session/load` replays previous conversation updates. They belong to
    /// prior turns and must not be emitted under this process's new turn ID.
    prompt_started: AtomicBool,
    session_id: Mutex<Option<String>>,
    thread_id: Option<String>,
    turn_id: Option<String>,
    wsl: bool,
    /// Ids of agent-initiated requests that were forwarded to the renderer
    /// and not answered yet. `cursor_permission_respond` only accepts one of
    /// these, so the webview cannot answer a request this process never
    /// asked (mirrors the Codex bridge's server-request set).
    server_requests: Mutex<HashSet<String>>,
    emit: CursorEmit,
    #[cfg(test)]
    stages: CursorStageLog,
    #[cfg(test)]
    primary_start_gate: StdMutex<Option<(oneshot::Receiver<()>, Arc<AtomicBool>)>>,
}

/// Test-only record of the input, retirement, and kill phases, so a native
/// hang can be attributed to the phase it stopped in. Compiled out of the app
/// and bounded, holding only static phase names (never message content).
#[cfg(test)]
#[derive(Default)]
struct CursorStageLog(StdMutex<Vec<(std::time::Instant, &'static str)>>);

#[cfg(test)]
impl CursorStageLog {
    const CAPACITY: usize = 256;

    fn record(&self, stage: &'static str) {
        let mut stages = self.0.lock().unwrap_or_else(PoisonError::into_inner);
        if stages.len() < Self::CAPACITY {
            stages.push((std::time::Instant::now(), stage));
        }
    }

    /// Never blocks, so a watchdog can read it while the runtime is stuck.
    fn snapshot(&self, since: std::time::Instant) -> String {
        match self.0.try_lock() {
            Ok(stages) => stages
                .iter()
                .map(|(at, stage)| {
                    format!(
                        "{:>7}ms {stage}",
                        at.saturating_duration_since(since).as_millis()
                    )
                })
                .collect::<Vec<_>>()
                .join("\n"),
            Err(_) => "(stage log busy)".into(),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum CursorPromptKind {
    Primary,
    Steer,
}

#[derive(Debug)]
struct CursorPromptOutcome {
    kind: CursorPromptKind,
    result: Result<Value, String>,
}

/// Admission and completion of the `session/prompt` requests that make up one
/// Mythra Code turn. A steer queues another prompt on the same session, and
/// ACP does not say how its completion is ordered against the primary's, so
/// the turn ends — one terminal event, then teardown — only when the last
/// admitted prompt settles. Admission and that decision share one lock: a
/// steer either joins the run before it ends or is refused with an error.
#[derive(Default)]
struct CursorPromptRun(StdMutex<CursorPromptRunState>);

#[derive(Default)]
struct CursorPromptRunState {
    started: bool,
    closed: bool,
    finished: bool,
    outstanding: usize,
    outcomes: Vec<CursorPromptOutcome>,
    input: CursorPromptInputOrder,
}

/// Prompt writes follow admission order, independently of response order.
/// A withdrawn preparation skips its ticket only after every earlier write.
#[derive(Clone, Debug, Default)]
struct CursorPromptInputOrder(Arc<CursorPromptInputQueue>);

#[derive(Debug, Default)]
struct CursorPromptInputQueue {
    state: StdMutex<CursorPromptInputState>,
    changed: Notify,
}

#[derive(Debug, Default)]
struct CursorPromptInputState {
    next_ticket: usize,
    next_write: usize,
    completed: HashSet<usize>,
    closed: bool,
}

#[derive(Debug)]
struct CursorPromptInputTicket {
    order: CursorPromptInputOrder,
    index: usize,
}

impl CursorPromptInputOrder {
    fn reserve(&self) -> CursorPromptInputTicket {
        let mut state = self.0.state.lock().unwrap_or_else(PoisonError::into_inner);
        let index = state.next_ticket;
        state.next_ticket += 1;
        CursorPromptInputTicket {
            order: self.clone(),
            index,
        }
    }

    fn close(&self) {
        self.0
            .state
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .closed = true;
        self.0.changed.notify_waiters();
    }
}

impl CursorPromptInputTicket {
    async fn wait(&self) -> Result<(), String> {
        loop {
            // Register before observing state so completion cannot lose a wake.
            let changed = self.order.0.changed.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            {
                let state = self
                    .order
                    .0
                    .state
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner);
                if state.closed {
                    return Err("This Cursor turn is no longer running".into());
                }
                if state.next_write == self.index {
                    return Ok(());
                }
            }
            changed.await;
        }
    }
}

impl Drop for CursorPromptInputTicket {
    fn drop(&mut self) {
        let mut state = self
            .order
            .0
            .state
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        state.completed.insert(self.index);
        loop {
            let next = state.next_write;
            if !state.completed.remove(&next) {
                break;
            }
            state.next_write += 1;
        }
        drop(state);
        self.order.0.changed.notify_waiters();
    }
}

impl CursorPromptRun {
    fn state(&self) -> StdMutexGuard<'_, CursorPromptRunState> {
        self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn admit_primary(&self) -> Option<CursorPromptInputTicket> {
        let mut state = self.state();
        if state.started || state.closed {
            return None;
        }
        state.started = true;
        state.outstanding = 1;
        Some(state.input.reserve())
    }

    fn admit_steer(&self) -> Result<CursorPromptInputTicket, String> {
        let mut state = self.state();
        if !state.started {
            return Err("Cursor session is still starting".into());
        }
        if state.closed || state.outstanding == 0 {
            return Err("Cursor already finished this turn".into());
        }
        state.outstanding += 1;
        Ok(state.input.reserve())
    }

    /// Settle one admitted prompt; `None` withdraws a steer that was never
    /// sent. The caller settling the last prompt receives every outcome in
    /// settle order and owns the run's single terminal event and teardown.
    fn settle(&self, outcome: Option<CursorPromptOutcome>) -> Option<Vec<CursorPromptOutcome>> {
        let mut state = self.state();
        if let Some(outcome) = outcome {
            state.outcomes.push(outcome);
        }
        state.outstanding = state.outstanding.saturating_sub(1);
        if state.outstanding > 0 || state.finished {
            return None;
        }
        state.finished = true;
        state.closed = true;
        state.input.close();
        Some(std::mem::take(&mut state.outcomes))
    }

    /// Refuse further admission. Returns whether a prompt was ever admitted,
    /// in which case that prompt's settlement reports how the turn ended.
    fn close(&self) -> bool {
        let mut state = self.state();
        state.closed = true;
        state.input.close();
        state.started
    }
}

/// The single terminal renderer message for a run. Every prompt's result is
/// kept, in settle order; the last-settled result describes how the run
/// ended. Any failure — including a steer the agent did not accept — makes
/// the turn an error, because the user's added instructions were lost.
fn cursor_final_message(outcomes: Vec<CursorPromptOutcome>) -> Value {
    let mut results = Vec::new();
    let mut causes: Vec<String> = Vec::new();
    let mut errors = Vec::new();
    for outcome in outcomes {
        match outcome.result {
            Ok(result) => results.push(result),
            // One process failure settles every prompt with the same cause.
            Err(cause) if causes.contains(&cause) => {}
            Err(cause) => {
                errors.push(match outcome.kind {
                    CursorPromptKind::Primary => cause.clone(),
                    CursorPromptKind::Steer => {
                        format!("Cursor did not accept the added instructions: {cause}")
                    }
                });
                causes.push(cause);
            }
        }
    }
    let mut message = if errors.is_empty() {
        json!({ "type": "result", "result": results.last().cloned().unwrap_or(Value::Null) })
    } else {
        json!({ "type": "openkiwi_error", "message": errors.join("\n") })
    };
    if results.len() > 1 || (!errors.is_empty() && !results.is_empty()) {
        message["promptResults"] = Value::Array(results);
    }
    message
}

fn visible_cursor_notification(method: &str, prompt_started: bool) -> bool {
    prompt_started || (method != "session/update" && method != "cursor/create_plan")
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
    /// Renderer-owned start intent, echoed only on Mythra event envelopes.
    /// Never sent to ACP or used as a permission/authorization credential.
    #[serde(default)]
    start_request_id: Option<String>,
    cwd: String,
    prompt: String,
    model: String,
    effort: String,
    permission: String,
    #[serde(default = "default_interactive")]
    interactive: bool,
    system_prompt: String,
    resume_session_id: Option<String>,
    attachments: Vec<CursorAttachment>,
    /// Cross-provider delegation bridge, present only for a root thread whose
    /// policy allows spawning children on other providers.
    #[serde(default)]
    child_agent_bridge: Option<ChildAgentBridge>,
}

fn default_interactive() -> bool {
    true
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
    /// Test-only phase marker; a no-op in the app.
    fn stage(&self, _stage: &'static str) {
        #[cfg(test)]
        self.stages.record(_stage);
    }

    async fn write_value(&self, message: &Value) -> Result<(), String> {
        if !self.alive.load(Ordering::Acquire) {
            return Err("This Cursor turn is no longer running".into());
        }
        self.stage("write: start");
        let result = write_json(&self.stdin, message, Instant::now() + self.input_timeout).await;
        self.stage(if result.is_ok() {
            "write: done"
        } else {
            "write: failed"
        });
        if let Err(error) = &result {
            // A timed-out or failed write may have sent part of a JSON line,
            // so nothing more can be framed on this stream. Retire it: every
            // waiting request settles, and the next turn starts one fresh
            // process because the finished run releases the thread slot.
            self.retire(&format!("Cursor Agent input failed: {error}"))
                .await;
        }
        result
    }

    async fn request(&self, method: &str, params: Value) -> Result<Value, String> {
        self.request_with_input(method, params, None).await
    }

    async fn request_with_input(
        &self,
        method: &str,
        params: Value,
        input: Option<CursorPromptInputTicket>,
    ) -> Result<Value, String> {
        if let Some(input) = input.as_ref() {
            input.wait().await?;
        }
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (sender, receiver) = oneshot::channel();
        self.pending.lock().await.insert(id, sender);
        self.stage("request: registered");
        let written = self
            .write_value(&json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }))
            .await;
        // Steers may write while the primary's ACP response remains pending.
        drop(input);
        if let Err(error) = written {
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

    /// Stop the process and settle everything waiting on it. The kill comes
    /// first and never waits for the input pipe: a writer blocked on an agent
    /// that stopped reading holds that lock, and the kill is what fails it.
    async fn shutdown(&self) {
        self.retire(CURSOR_STOPPED).await;
        // Close input only if no writer owns it; one that does fails on its own
        // now that the process is gone.
        if let Ok(mut stdin) = self.stdin.try_lock() {
            let _ = timeout(Duration::from_millis(250), stdin.shutdown()).await;
        }
    }

    /// End this transport: refuse further input and steers, fail every request
    /// still waiting with `reason`, and kill the process. Idempotent.
    async fn retire(&self, reason: &str) {
        self.stage("retire: start");
        self.alive.store(false, Ordering::Release);
        self.run.close();
        // Settle first: once the process dies the reader reaches EOF and would
        // otherwise report a generic closed connection instead of the cause.
        fail_pending(&self.pending, reason).await;
        self.stage("retire: pending settled");
        self.terminate().await;
        self.stage("retire: done");
    }

    /// Kill the process tree and reap the direct child, unless it was already
    /// reaped. An unreaped child keeps its pid and process group reserved, so
    /// the tree signal cannot reach an unrelated process that reused them.
    async fn terminate(&self) {
        let mut child = self.child.lock().await;
        self.stage("terminate: child locked");
        if matches!(child.try_wait(), Ok(None)) {
            if let Some(pid) = self.pid {
                super::kill_process_tree(pid);
            }
            self.stage("terminate: tree kill returned");
            let _ = child.start_kill();
            let reaped = timeout(CURSOR_KILL_REAP_GRACE, child.wait()).await;
            self.stage(match reaped {
                Ok(Ok(_)) => "terminate: reaped",
                Ok(Err(_)) => "terminate: wait failed",
                Err(_) => "terminate: reap grace elapsed",
            });
        } else {
            self.stage("terminate: already exited");
        }
    }

    fn emit_turn_message(&self, message: Value) {
        if let (Some(thread_id), Some(turn_id)) = (&self.thread_id, &self.turn_id) {
            (self.emit)(
                "cursor-event",
                json!({ "threadId": thread_id, "turnId": turn_id, "message": message }),
            );
        }
    }
}

async fn fail_pending(pending: &PendingMap, reason: &str) {
    for (_, sender) in pending.lock().await.drain() {
        let _ = sender.send(Err(reason.to_string()));
    }
}

/// The pipe lock, the write, and the flush share one deadline.
async fn write_json(
    stdin: &Mutex<ChildStdin>,
    message: &Value,
    deadline: Instant,
) -> Result<(), String> {
    timeout_at(deadline, async {
        let mut stdin = stdin.lock().await;
        stdin
            .write_all(format!("{message}\n").as_bytes())
            .await
            .map_err(|error| format!("Could not write to Cursor Agent: {error}"))?;
        stdin
            .flush()
            .await
            .map_err(|error| format!("Could not flush Cursor Agent input: {error}"))
    })
    .await
    .map_err(|_| "Cursor Agent stopped reading its input".to_string())?
}

/// Send one `session/prompt` belonging to the run. Whoever settles the last
/// admitted prompt emits the run's terminal event and tears it down.
fn spawn_cursor_prompt(
    process: Arc<CursorProcess>,
    turns: CursorTurns,
    kind: CursorPromptKind,
    input: CursorPromptInputTicket,
    session_id: String,
    blocks: Vec<Value>,
) -> tauri::async_runtime::JoinHandle<()> {
    tauri::async_runtime::spawn(async move {
        #[cfg(test)]
        if kind == CursorPromptKind::Primary {
            let gate = process
                .primary_start_gate
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .take();
            if let Some((gate, entered)) = gate {
                entered.store(true, Ordering::Release);
                let _ = gate.await;
            }
        }
        let result = process
            .request_with_input(
                "session/prompt",
                json!({ "sessionId": session_id, "prompt": blocks }),
                Some(input),
            )
            .await;
        if let Some(outcomes) = process
            .run
            .settle(Some(CursorPromptOutcome { kind, result }))
        {
            finish_cursor_run(&process, &turns, outcomes).await;
        }
    })
}

async fn finish_cursor_run(
    process: &Arc<CursorProcess>,
    turns: &CursorTurns,
    outcomes: Vec<CursorPromptOutcome>,
) {
    // Retire before announcing. The terminal event can start a queued
    // follow-up turn at once, which must find this run neither alive nor
    // accepting steers (settling the last prompt already closed admission).
    process.alive.store(false, Ordering::Release);
    process.run.close();
    process.emit_turn_message(cursor_final_message(outcomes));
    process.shutdown().await;
    // A successor may already own the slot; only this exact run is removed.
    if let Some(thread_id) = process.thread_id.as_deref() {
        let mut turns = turns.lock().await;
        if turns
            .get(thread_id)
            .is_some_and(|current| Arc::ptr_eq(current, process))
        {
            turns.remove(thread_id);
        }
    }
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
pub(super) enum CursorRuntime {
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

    pub(super) fn discovery_background(
        &self,
        workspace: &Path,
        config_dir: &Path,
        data_dir: &Path,
    ) -> Result<tokio::process::Command, String> {
        match self {
            Self::Native(path) => {
                let mut command = background_command(path);
                command
                    .current_dir(workspace)
                    .env("CURSOR_CONFIG_DIR", config_dir)
                    .env("CURSOR_DATA_DIR", data_dir)
                    .env("CURSOR_AGENT_STORE", data_dir.join("agent-store"))
                    .env(
                        "CURSOR_AGENT_STORE_FILES_DIR",
                        data_dir.join("agent-store-files"),
                    )
                    .env("CURSOR_AGENT_STORE_DIR", data_dir.join("agent-store-dir"));
                Ok(command)
            }
            #[cfg(windows)]
            Self::WindowsNode { node, script, .. } => {
                let mut command = background_command(node);
                command
                    .arg(script)
                    .current_dir(workspace)
                    .env("CURSOR_CONFIG_DIR", config_dir)
                    .env("CURSOR_DATA_DIR", data_dir)
                    .env("CURSOR_AGENT_STORE", data_dir.join("agent-store"))
                    .env(
                        "CURSOR_AGENT_STORE_FILES_DIR",
                        data_dir.join("agent-store-files"),
                    )
                    .env("CURSOR_AGENT_STORE_DIR", data_dir.join("agent-store-dir"));
                Ok(command)
            }
            #[cfg(windows)]
            Self::Wsl(path) => {
                let config = cursor_runtime_path(&config_dir.to_string_lossy(), true)?;
                let data = cursor_runtime_path(&data_dir.to_string_lossy(), true)?;
                let mut command = background_command("wsl.exe");
                command.arg("--cd").arg(workspace).args([
                    "--exec",
                    "env",
                    &format!("CURSOR_CONFIG_DIR={config}"),
                    &format!("CURSOR_DATA_DIR={data}"),
                    &format!("CURSOR_AGENT_STORE={data}/agent-store"),
                    &format!("CURSOR_AGENT_STORE_FILES_DIR={data}/agent-store-files"),
                    &format!("CURSOR_AGENT_STORE_DIR={data}/agent-store-dir"),
                    path,
                ]);
                Ok(command)
            }
        }
    }

    pub(super) fn discovery_workspace_argument(&self, workspace: &Path) -> Result<String, String> {
        cursor_runtime_path(&workspace.to_string_lossy(), self.is_wsl())
    }

    pub(super) async fn discovery_auth_config(&self, app: &AppHandle) -> Result<Value, String> {
        let bytes = match self {
            #[cfg(windows)]
            Self::Wsl(_) => {
                let output = timeout(
                    Duration::from_secs(5),
                    background_command("wsl.exe")
                        .args([
                            "--exec",
                            "sh",
                            "-lc",
                            "head -c 65537 \"$HOME/.cursor/cli-config.json\"",
                        ])
                        .stdin(Stdio::null())
                        .stderr(Stdio::null())
                        .output(),
                )
                .await
                .map_err(|_| "Cursor account configuration took too long to read.".to_string())?
                .map_err(|error| format!("Could not read Cursor account configuration: {error}"))?;
                if !output.status.success() || output.stdout.len() > 65_536 {
                    return Err(
                        "Cursor is not signed in. Sign in with Cursor Agent, then try again."
                            .into(),
                    );
                }
                output.stdout
            }
            _ => {
                let home = crate::release_qa::home_dir(app).map_err(|error| {
                    format!("Could not locate the Cursor account configuration: {error}")
                })?;
                let path = home.join(".cursor/cli-config.json");
                let metadata = tokio::fs::metadata(&path).await.map_err(|_| {
                    "Cursor is not signed in. Sign in with Cursor Agent, then try again."
                        .to_string()
                })?;
                if metadata.len() > 65_536 {
                    return Err("Cursor account configuration is unexpectedly large.".into());
                }
                tokio::fs::read(path).await.map_err(|error| {
                    format!("Could not read Cursor account configuration: {error}")
                })?
            }
        };
        let source: Value = serde_json::from_slice(&bytes)
            .map_err(|_| "Cursor account configuration is malformed.".to_string())?;
        let auth = source
            .get("authInfo")
            .filter(|value| value.is_object())
            .ok_or_else(|| {
                "Cursor is not signed in. Sign in with Cursor Agent, then try again.".to_string()
            })?;
        Ok(json!({ "authInfo": auth }))
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

pub(super) async fn resolve_cursor_runtime(app: &AppHandle) -> Result<CursorRuntime, String> {
    let legacy_override = concat!("OPEN", "KIWI_CURSOR_PATH");
    if let Some(override_path) =
        env::var_os("MYTHRA_CODE_CURSOR_PATH").or_else(|| env::var_os(legacy_override))
    {
        let override_path = PathBuf::from(override_path);
        return override_path
            .is_file()
            .then_some(CursorRuntime::Native(override_path))
            .ok_or_else(|| {
                "MYTHRA_CODE_CURSOR_PATH does not point to a Cursor Agent executable.".into()
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
        if let Some(candidate) = super::find_on_path(name).await {
            super::push_candidate(&mut candidates, candidate);
        }
    }
    if let Ok(home) = crate::release_qa::home_dir(app) {
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
    return Err("Mythra Code could not find Cursor Agent. The Cursor desktop editor and Cursor Agent CLI are separate installs. Install the official native Windows CLI, then return here to sign in.".into());
    #[cfg(not(windows))]
    Err("Mythra Code could not find Cursor Agent. Install it from cursor.com/docs/cli, then sign in with `cursor-agent login`.".into())
}

/// Upper bound for the `agent about` sign-in probe.
const CURSOR_ABOUT_TIMEOUT: Duration = Duration::from_secs(15);

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
    // Bounded like the Claude probe: a wedged CLI must not pin the account
    // panel on "checking" forever.
    let output = timeout(
        CURSOR_ABOUT_TIMEOUT,
        runtime
            .background(None)
            .arg("about")
            .env("NO_COLOR", "1")
            .stdin(Stdio::null())
            .kill_on_drop(true)
            .output(),
    )
    .await
    .ok()
    .and_then(Result::ok);
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

fn automatic_permission_result(
    permission: &str,
    interactive: bool,
    params: &Value,
) -> Option<Value> {
    if permission == "ask" && interactive {
        None
    } else {
        Some(permission_result(params, permission == "full"))
    }
}

fn unattended_question_error(id: Value) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": {
            "code": -32000,
            "message": "This unattended workflow cannot answer user questions. Run it manually."
        }
    })
}

async fn spawn_cursor_process(
    app: &AppHandle,
    cwd: &Path,
    event_context: Option<(String, String, String, bool)>,
    start_request_id: Option<&str>,
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
    let child = command.spawn().map_err(|error| {
        format!(
            "Could not start Cursor Agent at `{}`: {error}",
            runtime.display_path()
        )
    })?;
    let app = app.clone();
    let emit: CursorEmit = Arc::new(move |event: &str, payload: Value| {
        let _ = app.emit(event, payload);
    });
    let emit = with_cursor_start_id(emit, start_request_id.map(str::to_owned));
    attach_cursor_process(
        child,
        runtime.is_wsl(),
        event_context,
        emit,
        CURSOR_INPUT_TIMEOUT,
    )
}

/// Tag both individual and batched envelopes at their common emission edge.
/// The original ACP message and its ordering remain untouched.
fn with_cursor_start_id(emit: CursorEmit, start_request_id: Option<String>) -> CursorEmit {
    let Some(start_request_id) = start_request_id else {
        return emit;
    };
    Arc::new(move |event, mut payload| {
        if matches!(event, "cursor-event" | "cursor-events") {
            let tag = |envelope: &mut Value| {
                if let Some(object) = envelope.as_object_mut() {
                    object.insert(
                        "startRequestId".into(),
                        Value::String(start_request_id.clone()),
                    );
                }
            };
            match &mut payload {
                Value::Array(envelopes) => envelopes.iter_mut().for_each(tag),
                envelope => tag(envelope),
            }
        }
        emit(event, payload);
    })
}

/// Wrap a spawned agent in its ACP transport and start its output readers.
fn attach_cursor_process(
    mut child: Child,
    wsl: bool,
    event_context: Option<(String, String, String, bool)>,
    emit: CursorEmit,
    input_timeout: Duration,
) -> Result<Arc<CursorProcess>, String> {
    let stdin = child
        .stdin
        .take()
        .ok_or("Cursor Agent did not expose stdin")?;
    let stdout = child
        .stdout
        .take()
        .ok_or("Cursor Agent did not expose stdout")?;
    let stderr = child.stderr.take();
    let pid = child.id();
    let process = Arc::new(CursorProcess {
        stdin: Mutex::new(stdin),
        child: Arc::new(Mutex::new(child)),
        pid,
        pending: Arc::new(Mutex::new(HashMap::new())),
        next_id: AtomicI64::new(1),
        alive: AtomicBool::new(true),
        input_timeout,
        run: CursorPromptRun::default(),
        prompt_started: AtomicBool::new(false),
        session_id: Mutex::new(None),
        thread_id: event_context
            .as_ref()
            .map(|(thread_id, _, _, _)| thread_id.clone()),
        turn_id: event_context
            .as_ref()
            .map(|(_, turn_id, _, _)| turn_id.clone()),
        wsl,
        server_requests: Mutex::new(HashSet::new()),
        emit,
        #[cfg(test)]
        stages: CursorStageLog::default(),
        #[cfg(test)]
        primary_start_gate: StdMutex::default(),
    });
    let stderr_task = stderr.map(|stderr| {
        let emit = process.emit.clone();
        let event_for_stderr = event_context.clone();
        tauri::async_runtime::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                if let Some((thread_id, turn_id, _, _)) = event_for_stderr.as_ref() {
                    emit(
                        "cursor-event",
                        json!({
                            "threadId": thread_id, "turnId": turn_id,
                            "message": { "type": "stderr", "line": line }
                        }),
                    );
                }
            }
        })
    });
    tauri::async_runtime::spawn(read_cursor_output(
        process.clone(),
        stdout,
        event_context,
        stderr_task,
    ));
    Ok(process)
}

async fn read_cursor_output(
    process: Arc<CursorProcess>,
    stdout: ChildStdout,
    event_context: Option<(String, String, String, bool)>,
    stderr_task: Option<tauri::async_runtime::JoinHandle<()>>,
) {
    let emit = process.emit.clone();
    // The transport ends at EOF or, because a descendant can inherit stdout
    // and hold it open, when the direct child exits plus a bounded drain of
    // the output it already wrote (often its final response).
    let mut output = super::ProviderOutput::new(BufReader::new(stdout), process.child.clone());
    // High-frequency ACP notifications (`session/update` and friends) are
    // coalesced into a single "cursor-events" array emit, mirroring the
    // Codex and Claude readers: flushed on a ~25ms tick, at the batch
    // size/byte threshold, or before any other message so ordering is strictly
    // preserved. Each entry is exactly the payload a per-line "cursor-event"
    // emit would carry.
    let mut delta_buffer = super::ProviderDeltaBatch::default();
    let flush_deltas = |buffer: &mut super::ProviderDeltaBatch| {
        if let Some(batch) = buffer.take() {
            emit("cursor-events", batch);
        }
    };
    loop {
        let line = match output.next_line(delta_buffer.deadline()).await {
            super::ProviderRead::Line(line) => line,
            super::ProviderRead::FlushDue => {
                flush_deltas(&mut delta_buffer);
                continue;
            }
            super::ProviderRead::Closed => break,
        };
        let Ok(message) = serde_json::from_str::<Value>(&line) else {
            // Surface unparseable output instead of dropping it, so a
            // wedged or misbehaving agent is visible in the thread.
            flush_deltas(&mut delta_buffer);
            if let Some((thread_id, turn_id, _, _)) = event_context.as_ref() {
                emit(
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
                flush_deltas(&mut delta_buffer);
                if let Some(sender) = process.pending.lock().await.remove(&id) {
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
        // Replies written from here are bounded like every other input; a
        // failed write retires the transport, which then ends this loop.
        if method == "session/request_permission" {
            flush_deltas(&mut delta_buffer);
            let params = message.get("params").cloned().unwrap_or_else(|| json!({}));
            if let (Some(id), Some((thread_id, turn_id, permission, interactive))) =
                (message.get("id").cloned(), event_context.as_ref())
            {
                if let Some(result) = automatic_permission_result(permission, *interactive, &params)
                {
                    let _ = process.respond(id, result).await;
                } else {
                    // Record the id (before emitting) so the response
                    // command can verify it targets a live request.
                    process.server_requests.lock().await.insert(id.to_string());
                    emit(
                        "cursor-event",
                        json!({
                            "threadId": thread_id, "turnId": turn_id,
                            "message": { "type": "permission_request", "requestId": id, "params": params }
                        }),
                    );
                }
            }
            continue;
        }
        if method == "cursor/ask_question" {
            flush_deltas(&mut delta_buffer);
            if let (Some(id), Some((thread_id, turn_id, _, interactive))) =
                (message.get("id").cloned(), event_context.as_ref())
            {
                if *interactive {
                    process.server_requests.lock().await.insert(id.to_string());
                    emit(
                        "cursor-event",
                        json!({
                            "threadId": thread_id, "turnId": turn_id,
                            "message": { "type": "cursor_request", "method": method, "requestId": id, "params": message.get("params").cloned().unwrap_or(Value::Null) }
                        }),
                    );
                } else {
                    let _ = process.write_value(&unattended_question_error(id)).await;
                }
            }
            continue;
        }
        if method == "cursor/create_plan" {
            flush_deltas(&mut delta_buffer);
            if let Some((thread_id, turn_id, _, _)) = event_context.as_ref().filter(|_| {
                visible_cursor_notification(method, process.prompt_started.load(Ordering::Acquire))
            }) {
                emit(
                    "cursor-event",
                    json!({
                        "threadId": thread_id, "turnId": turn_id,
                        "message": { "type": "notification", "method": method, "params": message.get("params").cloned().unwrap_or(Value::Null) }
                    }),
                );
            }
            if let Some(id) = message.get("id").cloned() {
                let _ = process.respond(id, json!({ "accepted": true })).await;
            }
            continue;
        }
        if message.get("id").is_some() && message.get("method").is_some() {
            flush_deltas(&mut delta_buffer);
            if let Some(id) = message.get("id").cloned() {
                let _ = process.write_value(&json!({
                    "jsonrpc": "2.0", "id": id,
                    "error": { "code": -32601, "message": format!("Mythra Code does not support Cursor request `{method}` yet") }
                })).await;
            }
            continue;
        }
        if let Some((thread_id, turn_id, _, _)) = event_context.as_ref().filter(|_| {
            visible_cursor_notification(method, process.prompt_started.load(Ordering::Acquire))
        }) {
            let event = json!({
                "threadId": thread_id, "turnId": turn_id,
                "message": { "type": "notification", "method": method, "params": message.get("params").cloned().unwrap_or(Value::Null) }
            });
            // Ready lines win the deadline race during a continuous stream,
            // so the flush thresholds are checked after each append.
            if delta_buffer.push(event, line.len(), Instant::now()) {
                flush_deltas(&mut delta_buffer);
            }
        }
    }
    flush_deltas(&mut delta_buffer);
    let was_alive = process.alive.swap(false, Ordering::AcqRel);
    // Closing admission and reading whether a prompt was admitted is one
    // step, so exactly one terminal event reports this exit: the run's own,
    // once its prompts settle with the error below, or this one.
    let prompt_admitted = process.run.close();
    fail_pending(
        &process.pending,
        if was_alive {
            CURSOR_EXITED_EARLY
        } else {
            "Cursor Agent connection closed"
        },
    )
    .await;
    if was_alive && !prompt_admitted {
        process
            .emit_turn_message(json!({ "type": "openkiwi_exit", "message": CURSOR_EXITED_EARLY }));
    }
    if timeout(
        Duration::from_secs(5),
        super::direct_child_exit(process.child.clone()),
    )
    .await
    .is_err()
    {
        process.terminate().await;
    }
    // A descendant can hold stderr open too; it is diagnostic, not lifecycle.
    if let Some(stderr_task) = stderr_task {
        super::finish_stderr_reader(stderr_task).await;
    }
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
                "clientInfo": { "name": "Mythra Code", "version": env!("CARGO_PKG_VERSION") }
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
    // Mythra Code's own data folder avoids handing the agent a shared /tmp cwd.
    let workspace = crate::release_qa::app_data_dir(&app)
        .map_err(|error| format!("Could not resolve Mythra Code app data: {error}"))?;
    tokio::fs::create_dir_all(&workspace)
        .await
        .map_err(|error| format!("Could not create Mythra Code app data: {error}"))?;
    let process = spawn_cursor_process(&app, &workspace, None, None).await?;
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
            let mime = super::image_attachment_media_type(Path::new(&attachment.path))?;
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
    if options
        .start_request_id
        .as_ref()
        .is_some_and(|id| id.is_empty() || id.len() > 128)
    {
        return Err("Invalid Cursor start request identity.".into());
    }
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
            options.interactive,
        )),
        options.start_request_id.as_deref(),
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
    // Admission fails only if the process already ended or was stopped.
    let start_result = start_result.and_then(|started| {
        process.prompt_started.store(true, Ordering::Release);
        if let Some(input) = process.run.admit_primary() {
            Ok((started, input))
        } else {
            Err("Cursor Agent stopped before the turn started.".to_string())
        }
    });
    let ((session_id, blocks), input) = match start_result {
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

    spawn_cursor_prompt(
        process,
        state.turns.clone(),
        CursorPromptKind::Primary,
        input,
        session_id.clone(),
        blocks,
    );

    Ok(CursorTurnStarted {
        turn_id,
        cursor_session_id: session_id,
    })
}

#[tauri::command]
pub async fn cursor_turn_steer(
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
    // Join the run before reading attachments, so the primary prompt cannot
    // end the turn while this steer is being prepared. Once admitted, the
    // steer's outcome is part of the run's single terminal event.
    let input = turn.run.admit_steer()?;
    let blocks = match cursor_prompt_blocks_for(&prompt, "", &attachments, turn.wsl).await {
        Ok(blocks) => blocks,
        Err(error) => {
            // Never sent: withdraw it, finishing the run if it was the last.
            drop(input);
            if let Some(outcomes) = turn.run.settle(None) {
                finish_cursor_run(&turn, &state.turns, outcomes).await;
            }
            return Err(error);
        }
    };
    spawn_cursor_prompt(
        turn,
        state.turns.clone(),
        CursorPromptKind::Steer,
        input,
        session_id,
        blocks,
    );
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
    if !turn
        .server_requests
        .lock()
        .await
        .remove(&request_id.to_string())
    {
        return Err("Cursor is no longer waiting for that request".into());
    }
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
    fn cursor_start_identity_tags_single_and_batched_envelopes_without_changing_messages() {
        let recorded: Arc<StdMutex<Vec<(String, Value)>>> = Arc::default();
        let emit: CursorEmit = Arc::new({
            let recorded = recorded.clone();
            move |event, payload| recorded.lock().unwrap().push((event.into(), payload))
        });
        let emit = with_cursor_start_id(emit, Some("new-intent".into()));
        let one = json!({ "threadId": "t", "turnId": "native-1", "message": { "type": "permission_request", "requestId": 7 } });
        let two = json!({ "threadId": "t", "turnId": "native-1", "message": { "type": "result", "result": {} } });
        emit("cursor-event", one.clone());
        emit("cursor-events", json!([one.clone(), two.clone()]));
        let recorded = recorded.lock().unwrap();
        assert_eq!(recorded[0].1["startRequestId"], "new-intent");
        assert_eq!(recorded[0].1["message"], one["message"]);
        let batch = recorded[1].1.as_array().unwrap();
        assert_eq!(batch.len(), 2);
        assert_eq!(batch[0]["startRequestId"], "new-intent");
        assert_eq!(batch[1]["startRequestId"], "new-intent");
        assert_eq!(batch[0]["message"], one["message"]);
        assert_eq!(batch[1]["message"], two["message"]);
    }

    #[test]
    fn cursor_start_identity_remains_optional_for_catalog_and_legacy_callers() {
        let recorded: Arc<StdMutex<Vec<Value>>> = Arc::default();
        let emit: CursorEmit = Arc::new({
            let recorded = recorded.clone();
            move |_, payload| recorded.lock().unwrap().push(payload)
        });
        let emit = with_cursor_start_id(emit, None);
        let payload = json!({ "threadId": "t", "turnId": "old", "message": { "type": "result" } });
        emit("cursor-event", payload.clone());
        assert_eq!(recorded.lock().unwrap()[0], payload);
    }

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
    fn unattended_requests_are_rejected_without_expanding_saved_access() {
        let params = json!({ "options": [
            { "kind": "allow_once", "optionId": "yes" },
            { "kind": "reject_once", "optionId": "no" }
        ] });
        assert!(automatic_permission_result("ask", true, &params).is_none());
        let denied = automatic_permission_result("ask", false, &params).expect("unattended denial");
        assert_eq!(denied["outcome"]["optionId"], "no");
        let read_only =
            automatic_permission_result("read-only", false, &params).expect("read-only denial");
        assert_eq!(read_only["outcome"]["optionId"], "no");
        let full = automatic_permission_result("full", false, &params).expect("saved full access");
        assert_eq!(full["outcome"]["optionId"], "yes");
        let question = unattended_question_error(json!(42));
        assert_eq!(question["id"], 42);
        assert!(question["error"]["message"]
            .as_str()
            .unwrap()
            .contains("unattended workflow"));
    }

    #[test]
    fn session_load_replay_is_not_attributed_to_the_new_turn() {
        // `session/load` can replay previous assistant chunks before the new
        // `session/prompt` starts. Those chunks already exist in the saved
        // transcript and must not become new-turn assistant output.
        assert!(!visible_cursor_notification("session/update", false));
        assert!(!visible_cursor_notification("cursor/create_plan", false));
        assert!(visible_cursor_notification("session/update", true));
        assert!(visible_cursor_notification("cursor/create_plan", true));
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

    fn outcome(kind: CursorPromptKind, result: Result<Value, &str>) -> CursorPromptOutcome {
        CursorPromptOutcome {
            kind,
            result: result.map_err(str::to_string),
        }
    }

    #[test]
    fn steer_keeps_the_run_open_until_every_admitted_prompt_settles() {
        let run = CursorPromptRun::default();
        assert!(run.admit_steer().unwrap_err().contains("starting"));
        assert!(run.admit_primary().is_some());
        assert!(run.admit_primary().is_none());
        run.admit_steer().unwrap();
        // The primary settling first must not end the turn under the steer.
        assert!(run
            .settle(Some(outcome(
                CursorPromptKind::Primary,
                Ok(json!({ "stopReason": "end_turn" }))
            )))
            .is_none());
        // The run is still open, so a further steer joins it.
        run.admit_steer().unwrap();
        assert!(run.settle(None).is_none(), "a withdrawn steer is not last");
        let outcomes = run
            .settle(Some(outcome(
                CursorPromptKind::Steer,
                Ok(json!({ "stopReason": "end_turn" })),
            )))
            .expect("the last settle finishes the run");
        assert_eq!(outcomes.len(), 2);
        assert_eq!(outcomes[0].kind, CursorPromptKind::Primary);
        assert!(run.admit_steer().unwrap_err().contains("finished"));
        assert!(run.settle(None).is_none(), "a run never finishes twice");
    }

    #[test]
    fn withdrawn_last_steer_finishes_with_the_primary_outcome() {
        let run = CursorPromptRun::default();
        assert!(run.admit_primary().is_some());
        run.admit_steer().unwrap();
        assert!(run
            .settle(Some(outcome(CursorPromptKind::Primary, Ok(json!({})))))
            .is_none());
        let outcomes = run.settle(None).expect("withdrawal of the last prompt");
        assert_eq!(outcomes.len(), 1);
    }

    #[test]
    fn closed_run_refuses_steers_but_admitted_prompts_still_report() {
        let run = CursorPromptRun::default();
        assert!(!CursorPromptRun::default().close());
        assert!(run.admit_primary().is_some());
        run.admit_steer().unwrap();
        assert!(run.close(), "a prompt was admitted");
        assert!(run.admit_steer().is_err());
        assert!(run.admit_primary().is_none());
        assert!(run
            .settle(Some(outcome(CursorPromptKind::Primary, Err("stopped"))))
            .is_none());
        assert!(run
            .settle(Some(outcome(CursorPromptKind::Steer, Err("stopped"))))
            .is_some());
    }

    #[test]
    fn racing_steer_admission_and_completion_finishes_exactly_once() {
        for _ in 0..500 {
            let run = Arc::new(CursorPromptRun::default());
            assert!(run.admit_primary().is_some());
            let primary = std::thread::spawn({
                let run = run.clone();
                move || run.settle(Some(outcome(CursorPromptKind::Primary, Ok(json!(1)))))
            });
            let steer = std::thread::spawn({
                let run = run.clone();
                move || match run.admit_steer() {
                    Ok(_input) => (
                        true,
                        run.settle(Some(outcome(CursorPromptKind::Steer, Ok(json!(2))))),
                    ),
                    Err(_) => (false, None),
                }
            });
            let primary = primary.join().unwrap();
            let (admitted, steer) = steer.join().unwrap();
            let finals: Vec<_> = [primary, steer].into_iter().flatten().collect();
            assert_eq!(finals.len(), 1, "exactly one finisher");
            // An admitted steer always belongs to the run that finishes.
            assert_eq!(finals[0].len(), if admitted { 2 } else { 1 });
        }
    }

    #[test]
    fn final_message_reports_every_prompt_once() {
        let single = cursor_final_message(vec![outcome(
            CursorPromptKind::Primary,
            Ok(json!({ "stopReason": "end_turn" })),
        )]);
        assert_eq!(single["type"], "result");
        assert_eq!(single["result"]["stopReason"], "end_turn");
        assert!(single.get("promptResults").is_none());

        let steered = cursor_final_message(vec![
            outcome(
                CursorPromptKind::Primary,
                Ok(json!({ "stopReason": "cancelled" })),
            ),
            outcome(
                CursorPromptKind::Steer,
                Ok(json!({ "stopReason": "end_turn" })),
            ),
        ]);
        assert_eq!(steered["type"], "result");
        assert_eq!(steered["result"]["stopReason"], "end_turn");
        assert_eq!(steered["promptResults"].as_array().unwrap().len(), 2);

        let rejected = cursor_final_message(vec![
            outcome(CursorPromptKind::Steer, Err("busy")),
            outcome(
                CursorPromptKind::Primary,
                Ok(json!({ "stopReason": "end_turn" })),
            ),
        ]);
        assert_eq!(rejected["type"], "openkiwi_error");
        assert_eq!(
            rejected["message"],
            "Cursor did not accept the added instructions: busy"
        );
        assert_eq!(rejected["promptResults"].as_array().unwrap().len(), 1);

        let exited = cursor_final_message(vec![
            outcome(CursorPromptKind::Primary, Err(CURSOR_EXITED_EARLY)),
            outcome(CursorPromptKind::Steer, Err(CURSOR_EXITED_EARLY)),
        ]);
        assert_eq!(exited["message"], CURSOR_EXITED_EARLY);
        assert!(exited.get("promptResults").is_none());
    }

    /// Cross-platform fake agents: the test binary re-run as a fixture (see
    /// `provider_runtime_tests::provider_fixture`). No provider is contacted.
    mod fake_process {
        use super::*;
        use crate::provider_runtime_tests::{
            Fixture, FIXTURE_FINAL, FIXTURE_HOLDER, FIXTURE_READ_FIRST,
        };
        use std::sync::{OnceLock, Weak};

        type Events = Arc<StdMutex<Vec<(String, Value)>>>;

        fn recording_emit() -> (CursorEmit, Events) {
            let events: Events = Arc::default();
            let sink = events.clone();
            let emit: CursorEmit = Arc::new(move |event: &str, payload: Value| {
                sink.lock().unwrap().push((event.to_string(), payload));
            });
            (emit, events)
        }

        fn attach(
            mut command: tokio::process::Command,
            emit: CursorEmit,
            input_timeout: Duration,
        ) -> Arc<CursorProcess> {
            let child = command.spawn().expect("spawn fake Cursor Agent");
            attach_cursor_process(
                child,
                false,
                Some(("thread".into(), "turn".into(), "full".into(), true)),
                emit,
                input_timeout,
            )
            .unwrap()
        }

        fn fake_agent(
            fixture: &Fixture,
            mode: &str,
            input_timeout: Duration,
        ) -> (Arc<CursorProcess>, Events) {
            let (emit, events) = recording_emit();
            (attach(fixture.command(mode), emit, input_timeout), events)
        }

        /// Renderer messages in emission order, with batches flattened.
        fn messages(events: &Events) -> Vec<Value> {
            events
                .lock()
                .unwrap()
                .iter()
                .flat_map(|(name, payload)| match name.as_str() {
                    "cursor-events" => payload.as_array().unwrap().clone(),
                    _ => vec![payload.clone()],
                })
                .map(|payload| payload["message"].clone())
                .collect()
        }

        fn is_terminal(message: &Value) -> bool {
            matches!(
                message["type"].as_str(),
                Some("result" | "openkiwi_error" | "openkiwi_exit")
            )
        }

        async fn wait_until(condition: impl Fn() -> bool, limit: Duration) {
            timeout(limit, async {
                while !condition() {
                    tokio::time::sleep(Duration::from_millis(20)).await;
                }
            })
            .await
            .expect("condition reached in time");
        }

        fn huge_message() -> Value {
            json!({ "blob": "x".repeat(2 * 1024 * 1024) })
        }

        async fn exited(process: &CursorProcess) -> bool {
            process.child.lock().await.try_wait().unwrap().is_some()
        }

        #[test]
        fn admitted_steer_cannot_write_before_a_delayed_primary() {
            tauri::async_runtime::block_on(async {
                let fixture = Fixture::new();
                let (process, events) = fake_agent(&fixture, "read-one", CURSOR_INPUT_TIMEOUT);
                let turns: CursorTurns = Arc::default();
                turns.lock().await.insert("thread".into(), process.clone());
                let (release, gate) = oneshot::channel();
                let entered = Arc::new(AtomicBool::new(false));
                *process.primary_start_gate.lock().unwrap() = Some((gate, entered.clone()));
                let primary_input = process.run.admit_primary().unwrap();
                let primary = spawn_cursor_prompt(
                    process.clone(),
                    turns.clone(),
                    CursorPromptKind::Primary,
                    primary_input,
                    "session".into(),
                    vec![json!({ "type": "text", "text": "original prompt" })],
                );
                wait_until(|| entered.load(Ordering::Acquire), Duration::from_secs(5)).await;
                let steer_input = process.run.admit_steer().unwrap();
                let steer = spawn_cursor_prompt(
                    process.clone(),
                    turns,
                    CursorPromptKind::Steer,
                    steer_input,
                    "session".into(),
                    vec![json!({ "type": "text", "text": "added instructions" })],
                );
                let consumed_before_primary = timeout(Duration::from_millis(500), async {
                    loop {
                        if messages(&events).iter().any(|message| {
                            message["line"].as_str().is_some_and(|line| {
                                line.contains(crate::provider_runtime_tests::FIXTURE_CONSUMED)
                            })
                        }) {
                            break;
                        }
                        tokio::time::sleep(Duration::from_millis(10)).await;
                    }
                })
                .await
                .is_ok();
                let _ = release.send(());
                process.shutdown().await;
                timeout(Duration::from_secs(5), primary)
                    .await
                    .unwrap()
                    .unwrap();
                timeout(Duration::from_secs(5), steer)
                    .await
                    .unwrap()
                    .unwrap();
                assert!(
                    !consumed_before_primary,
                    "the child consumed the steer while the primary had not started its request"
                );
            });
        }

        #[test]
        fn force_stop_kills_before_waiting_for_a_blocked_input_write() {
            tauri::async_runtime::block_on(async {
                // Never reads stdin: a large message fills the pipe and its
                // writer blocks while holding the input lock.
                let fixture = Fixture::new();
                let (process, _) = fake_agent(&fixture, "no-read", Duration::from_secs(30));
                let writer = tauri::async_runtime::spawn({
                    let process = process.clone();
                    async move { process.write_value(&huge_message()).await }
                });
                wait_until(|| process.stdin.try_lock().is_err(), Duration::from_secs(5)).await;
                assert!(process.stdin.try_lock().is_err(), "writer holds input");
                timeout(Duration::from_secs(5), process.shutdown())
                    .await
                    .expect("Stop must not wait behind the input pipe");
                assert!(!process.alive.load(Ordering::Acquire));
                assert!(exited(&process).await);
                let written = timeout(Duration::from_secs(5), writer)
                    .await
                    .expect("the blocked writer fails once the agent is killed")
                    .unwrap();
                assert!(written.is_err());
            });
        }

        fn spawn_admitted(
            process: &Arc<CursorProcess>,
            turns: &CursorTurns,
            kind: CursorPromptKind,
            input: CursorPromptInputTicket,
            text: &str,
        ) -> tauri::async_runtime::JoinHandle<()> {
            spawn_cursor_prompt(
                process.clone(),
                turns.clone(),
                kind,
                input,
                "session".into(),
                vec![json!({ "type": "text", "text": text })],
            )
        }

        fn echoes(events: &Events) -> Vec<String> {
            messages(events)
                .iter()
                .filter_map(|message| message["params"]["echo"].as_str().map(str::to_owned))
                .collect()
        }

        #[test]
        fn steer_writes_keep_admission_order_when_preparation_finishes_in_reverse() {
            tauri::async_runtime::block_on(async {
                let fixture = Fixture::new();
                let (process, events) = fake_agent(&fixture, "acp-echo", CURSOR_INPUT_TIMEOUT);
                process.prompt_started.store(true, Ordering::Release);
                let turns: CursorTurns = Arc::default();
                let primary_input = process.run.admit_primary().unwrap();
                // The first steer is admitted before its attachments finish.
                let first_input = process.run.admit_steer().unwrap();
                let second_input = process.run.admit_steer().unwrap();
                let primary = spawn_admitted(
                    &process,
                    &turns,
                    CursorPromptKind::Primary,
                    primary_input,
                    "original",
                );
                let second = spawn_admitted(
                    &process,
                    &turns,
                    CursorPromptKind::Steer,
                    second_input,
                    "second",
                );
                wait_until(|| !echoes(&events).is_empty(), Duration::from_secs(5)).await;
                tokio::time::sleep(Duration::from_millis(100)).await;
                let before_first_prepared = echoes(&events);
                let first = spawn_admitted(
                    &process,
                    &turns,
                    CursorPromptKind::Steer,
                    first_input,
                    "first",
                );
                wait_until(|| echoes(&events).len() == 3, Duration::from_secs(5)).await;
                let written = echoes(&events);
                process.shutdown().await;
                for prompt in [primary, first, second] {
                    timeout(Duration::from_secs(5), prompt)
                        .await
                        .unwrap()
                        .unwrap();
                }
                assert_eq!(before_first_prepared, ["original"]);
                assert_eq!(written, ["original", "first", "second"]);
            });
        }

        #[test]
        fn failed_middle_preparation_does_not_skip_a_blocked_primary_or_hold_later_steers() {
            tauri::async_runtime::block_on(async {
                let fixture = Fixture::new();
                let (process, events) = fake_agent(&fixture, "acp-echo", CURSOR_INPUT_TIMEOUT);
                process.prompt_started.store(true, Ordering::Release);
                let turns: CursorTurns = Arc::default();
                let (release, gate) = oneshot::channel();
                let entered = Arc::new(AtomicBool::new(false));
                *process.primary_start_gate.lock().unwrap() = Some((gate, entered.clone()));
                let primary_input = process.run.admit_primary().unwrap();
                let failed_input = process.run.admit_steer().unwrap();
                let later_input = process.run.admit_steer().unwrap();
                let primary = spawn_admitted(
                    &process,
                    &turns,
                    CursorPromptKind::Primary,
                    primary_input,
                    "original",
                );
                wait_until(|| entered.load(Ordering::Acquire), Duration::from_secs(5)).await;
                let later = spawn_admitted(
                    &process,
                    &turns,
                    CursorPromptKind::Steer,
                    later_input,
                    "later",
                );
                let missing =
                    env::temp_dir().join(format!("mythra-missing-{}.png", uuid::Uuid::new_v4()));
                let prepared = cursor_prompt_blocks_for(
                    "failed",
                    "",
                    &[CursorAttachment {
                        path: missing.to_string_lossy().into_owned(),
                        kind: "image".into(),
                    }],
                    false,
                )
                .await;
                assert!(prepared.is_err());
                drop(failed_input);
                assert!(process.run.settle(None).is_none());
                tokio::time::sleep(Duration::from_millis(100)).await;
                let before_primary = echoes(&events);
                let _ = release.send(());
                wait_until(|| echoes(&events).len() == 2, Duration::from_secs(5)).await;
                let written = echoes(&events);
                process.shutdown().await;
                for prompt in [primary, later] {
                    timeout(Duration::from_secs(5), prompt)
                        .await
                        .unwrap()
                        .unwrap();
                }
                assert!(before_primary.is_empty());
                assert_eq!(written, ["original", "later"]);
            });
        }

        #[test]
        fn stop_wakes_a_queued_steer_before_its_primary_is_ready_to_write() {
            tauri::async_runtime::block_on(async {
                let fixture = Fixture::new();
                let (process, _) = fake_agent(&fixture, "no-read", CURSOR_INPUT_TIMEOUT);
                let turns: CursorTurns = Arc::default();
                let (release, gate) = oneshot::channel();
                let entered = Arc::new(AtomicBool::new(false));
                *process.primary_start_gate.lock().unwrap() = Some((gate, entered.clone()));
                let primary_input = process.run.admit_primary().unwrap();
                let steer_input = process.run.admit_steer().unwrap();
                let primary = spawn_admitted(
                    &process,
                    &turns,
                    CursorPromptKind::Primary,
                    primary_input,
                    "original",
                );
                wait_until(|| entered.load(Ordering::Acquire), Duration::from_secs(5)).await;
                let steer = spawn_admitted(
                    &process,
                    &turns,
                    CursorPromptKind::Steer,
                    steer_input,
                    "later",
                );
                assert!(process.pending.lock().await.is_empty());
                timeout(Duration::from_secs(5), process.shutdown())
                    .await
                    .unwrap();
                // This must settle even though no pending ACP sender was registered.
                let queued_settled = timeout(Duration::from_secs(2), steer).await;
                let _ = release.send(());
                timeout(Duration::from_secs(5), primary)
                    .await
                    .unwrap()
                    .unwrap();
                queued_settled
                    .expect("Stop wakes the unregistered input waiter")
                    .unwrap();
            });
        }

        /// Bounded phase diagnostics for a native fake-process test. If the
        /// test panics or outlives `limit`, its own phases, the transport's
        /// test-only stage log, and a non-blocking state snapshot go straight
        /// to stderr (bypassing output capture). Past the limit, an OS thread
        /// that does not depend on the async runtime ends the test process
        /// with code 86 instead of letting it hang. A runtime heartbeat tells
        /// a stalled async runtime apart from an await that never completes.
        struct Diagnostics {
            steps: Arc<StdMutex<Vec<(std::time::Instant, &'static str)>>>,
            finished: Arc<AtomicBool>,
            heartbeat: tauri::async_runtime::JoinHandle<()>,
            report: Arc<dyn Fn() -> String + Send + Sync>,
        }

        impl Diagnostics {
            fn arm(
                name: &'static str,
                limit: Duration,
                process: &Arc<CursorProcess>,
                events: &Events,
            ) -> Self {
                let started = std::time::Instant::now();
                let steps: Arc<StdMutex<Vec<(std::time::Instant, &'static str)>>> = Arc::default();
                let ticks = Arc::new(std::sync::atomic::AtomicU64::new(0));
                let heartbeat = tauri::async_runtime::spawn({
                    let ticks = ticks.clone();
                    async move {
                        loop {
                            tokio::time::sleep(Duration::from_millis(100)).await;
                            ticks.fetch_add(1, Ordering::Relaxed);
                        }
                    }
                });
                let report: Arc<dyn Fn() -> String + Send + Sync> = Arc::new({
                    let steps = steps.clone();
                    let process = process.clone();
                    let events = events.clone();
                    move || {
                        let elapsed = started.elapsed();
                        let at = |instant: &std::time::Instant| {
                            instant.saturating_duration_since(started).as_millis()
                        };
                        let steps = match steps.try_lock() {
                            Ok(steps) => steps
                                .iter()
                                .map(|(instant, step)| format!("{:>7}ms {step}", at(instant)))
                                .collect::<Vec<_>>()
                                .join("\n"),
                            Err(_) => "(test steps busy)".into(),
                        };
                        let stdin = if process.stdin.try_lock().is_ok() {
                            "free"
                        } else {
                            "held by a writer"
                        };
                        let pending = process
                            .pending
                            .try_lock()
                            .map(|pending| pending.len().to_string())
                            .unwrap_or_else(|_| "locked".into());
                        let child = match process.child.try_lock() {
                            Ok(mut child) => match child.try_wait() {
                                Ok(Some(status)) => format!("exited ({status})"),
                                Ok(None) => "running".into(),
                                Err(error) => format!("unknown ({error})"),
                            },
                            Err(_) => "locked".into(),
                        };
                        let recent = events
                            .try_lock()
                            .map(|events| {
                                events
                                    .iter()
                                    .rev()
                                    .take(6)
                                    .map(|(event, payload)| {
                                        let line: String = payload["message"]["line"]
                                            .as_str()
                                            .unwrap_or_default()
                                            .chars()
                                            .take(100)
                                            .collect();
                                        format!(
                                            "{event} {} {line}",
                                            payload["message"]["type"].as_str().unwrap_or("-")
                                        )
                                    })
                                    .collect::<Vec<_>>()
                                    .join("\n")
                            })
                            .unwrap_or_else(|_| "(events busy)".into());
                        format!(
                            "[{name}] after {}ms; runtime heartbeat {} of ~{} ticks\n\
                             alive={} stdin={stdin} pending={pending} child={child}\n\
                             test steps:\n{steps}\ntransport stages:\n{}\n\
                             recent events (newest first):\n{recent}\n",
                            elapsed.as_millis(),
                            ticks.load(Ordering::Relaxed),
                            elapsed.as_millis() / 100,
                            process.alive.load(Ordering::Acquire),
                            process.stages.snapshot(started),
                        )
                    }
                });
                let finished = Arc::new(AtomicBool::new(false));
                std::thread::spawn({
                    let finished = finished.clone();
                    let report = report.clone();
                    move || {
                        while started.elapsed() < limit {
                            if finished.load(Ordering::Acquire) {
                                return;
                            }
                            std::thread::sleep(Duration::from_millis(50));
                        }
                        let message = format!(
                            "\n[{name}] watchdog: not finished within {limit:?}\n{}",
                            report()
                        );
                        let _ =
                            std::io::Write::write_all(&mut std::io::stderr(), message.as_bytes());
                        std::process::exit(86);
                    }
                });
                Self {
                    steps,
                    finished,
                    heartbeat,
                    report,
                }
            }

            fn step(&self, step: &'static str) {
                self.steps
                    .lock()
                    .unwrap_or_else(PoisonError::into_inner)
                    .push((std::time::Instant::now(), step));
            }
        }

        impl Drop for Diagnostics {
            fn drop(&mut self) {
                self.finished.store(true, Ordering::Release);
                self.heartbeat.abort();
                if std::thread::panicking() {
                    let _ = std::io::Write::write_all(
                        &mut std::io::stderr(),
                        format!("\n{}", (self.report)()).as_bytes(),
                    );
                }
            }
        }

        /// The Windows shape of a kill: `taskkill` and the reap run while the
        /// kill path holds the child, and the transport reaches EOF meanwhile.
        /// Once that holder is done, every later kill and reap must still get
        /// the child; the output watcher must not have been left owning it.
        #[test]
        fn transport_closing_during_a_slow_kill_does_not_wedge_later_kills() {
            tauri::async_runtime::block_on(async {
                let fixture = Fixture::new();
                let (process, _) = fake_agent(&fixture, "no-read", CURSOR_INPUT_TIMEOUT);
                let mut child = process.child.lock().await;
                // The output watcher checks the busy child at least once.
                tokio::time::sleep(crate::PROVIDER_EXIT_POLL_INTERVAL * 2).await;
                child.start_kill().unwrap();
                // The reader sees EOF and ends while the child is still held.
                wait_until(
                    || !process.alive.load(Ordering::Acquire),
                    Duration::from_secs(5),
                )
                .await;
                drop(child);
                timeout(Duration::from_secs(10), process.shutdown())
                    .await
                    .expect("a later kill must still get the child");
                let mut child = timeout(Duration::from_secs(2), process.child.lock())
                    .await
                    .expect("the child lock is free after every kill path");
                assert!(child.try_wait().unwrap().is_some());
            });
        }

        #[test]
        fn partial_input_retires_the_transport_and_settles_pending_requests() {
            tauri::async_runtime::block_on(async {
                // Reads one request, announces it, then stops reading.
                let fixture = Fixture::new();
                let (process, events) =
                    fake_agent(&fixture, "read-one", Duration::from_millis(300));
                let diagnostics =
                    Diagnostics::arm("partial-input", Duration::from_secs(60), &process, &events);
                diagnostics.step("fixture spawned");
                let pending = tauri::async_runtime::spawn({
                    let process = process.clone();
                    async move { process.request("initialize", json!({})).await }
                });
                // Wait until the fixture has consumed the request, not merely
                // until it is registered: registration precedes its write, so
                // the large write could otherwise take the input pipe first
                // and be read in its place.
                wait_until(
                    || {
                        messages(&events).iter().any(|message| {
                            message["line"].as_str().is_some_and(|line| {
                                line.contains(crate::provider_runtime_tests::FIXTURE_CONSUMED)
                            })
                        })
                    },
                    Duration::from_secs(10),
                )
                .await;
                diagnostics.step("fixture consumed the request and stopped reading");
                assert_eq!(process.pending.lock().await.len(), 1);
                let error = process.write_value(&huge_message()).await.unwrap_err();
                diagnostics.step("large write returned");
                assert!(error.contains("stopped reading"), "{error}");
                let settled = timeout(Duration::from_secs(5), pending)
                    .await
                    .expect("waiting requests settle with the retirement")
                    .unwrap();
                diagnostics.step("pending request settled");
                assert!(settled.unwrap_err().contains("input failed"));
                assert!(!process.alive.load(Ordering::Acquire));
                diagnostics.step("waiting for the child lock");
                let mut child = process.child.lock().await;
                diagnostics.step("child lock acquired");
                let status = child.try_wait();
                diagnostics.step("child try_wait returned");
                assert!(status.unwrap().is_some());
                drop(child);
                assert!(process
                    .write_value(&json!({}))
                    .await
                    .unwrap_err()
                    .contains("no longer running"));
                diagnostics.step("retired transport refuses input");
            });
        }

        #[test]
        fn steered_turn_emits_one_final_event_after_all_prompt_output() {
            tauri::async_runtime::block_on(async {
                let fixture = Fixture::new();
                let (process, events) = fake_agent(&fixture, "acp-steer", CURSOR_INPUT_TIMEOUT);
                let turns: CursorTurns = Arc::default();
                turns.lock().await.insert("thread".into(), process.clone());
                process.prompt_started.store(true, Ordering::Release);
                let primary_input = process.run.admit_primary().unwrap();
                let primary = spawn_cursor_prompt(
                    process.clone(),
                    turns.clone(),
                    CursorPromptKind::Primary,
                    primary_input,
                    "session".into(),
                    vec![json!({ "type": "text", "text": "start" })],
                );
                wait_until(
                    || {
                        process
                            .pending
                            .try_lock()
                            .is_ok_and(|pending| pending.len() == 1)
                    },
                    Duration::from_secs(5),
                )
                .await;
                let steer_input = process.run.admit_steer().unwrap();
                let steer = spawn_cursor_prompt(
                    process.clone(),
                    turns.clone(),
                    CursorPromptKind::Steer,
                    steer_input,
                    "session".into(),
                    vec![json!({ "type": "text", "text": "steer" })],
                );
                timeout(Duration::from_secs(10), async {
                    primary.await.unwrap();
                    steer.await.unwrap();
                })
                .await
                .expect("both prompts settle");

                let messages = messages(&events);
                let terminals: Vec<usize> = (0..messages.len())
                    .filter(|index| is_terminal(&messages[*index]))
                    .collect();
                assert_eq!(terminals.len(), 1, "{messages:?}");
                let primary_output = messages
                    .iter()
                    .position(|message| message["params"]["n"] == 1)
                    .expect("primary output delivered");
                let steer_output = messages
                    .iter()
                    .position(|message| message["params"]["n"] == 2)
                    .expect("steer output delivered");
                assert!(primary_output < steer_output);
                assert!(steer_output < terminals[0], "final event after all output");
                let final_message = &messages[terminals[0]];
                assert_eq!(final_message["type"], "result");
                assert_eq!(final_message["promptResults"].as_array().unwrap().len(), 2);
                assert!(!process.alive.load(Ordering::Acquire));
                assert!(process.run.admit_steer().is_err());
                assert!(turns.lock().await.is_empty());
                assert!(exited(&process).await);
            });
        }

        #[test]
        fn finished_run_is_retired_before_its_terminal_event_starts_a_successor() {
            tauri::async_runtime::block_on(async {
                let fixture = Fixture::new();
                let turns: CursorTurns = Arc::default();
                let (successor, _) = fake_agent(&fixture, "no-read", CURSOR_INPUT_TIMEOUT);
                let finishing: Arc<OnceLock<Weak<CursorProcess>>> = Arc::default();
                let observed: Arc<StdMutex<Vec<(bool, bool)>>> = Arc::default();
                // Reacts to the terminal event synchronously, the way a queued
                // follow-up would: `cursor_turn_start` refuses a thread whose
                // slot holds a live turn, otherwise it claims the slot.
                let emit: CursorEmit = Arc::new({
                    let turns = turns.clone();
                    let successor = successor.clone();
                    let finishing = finishing.clone();
                    let observed = observed.clone();
                    move |_event: &str, payload: Value| {
                        if !is_terminal(&payload["message"]) {
                            return;
                        }
                        let old = finishing.get().and_then(Weak::upgrade).unwrap();
                        let mut slots = turns
                            .try_lock()
                            .expect("the turn map is not held while announcing");
                        let claimable = !slots
                            .get("thread")
                            .is_some_and(|existing| existing.alive.load(Ordering::Acquire));
                        if claimable {
                            slots.insert("thread".into(), successor.clone());
                        }
                        observed
                            .lock()
                            .unwrap()
                            .push((claimable, old.run.admit_steer().is_err()));
                    }
                });
                let process = attach(fixture.command("acp-one"), emit, CURSOR_INPUT_TIMEOUT);
                finishing.set(Arc::downgrade(&process)).unwrap();
                turns.lock().await.insert("thread".into(), process.clone());
                let primary_input = process.run.admit_primary().unwrap();
                let prompt = spawn_cursor_prompt(
                    process.clone(),
                    turns.clone(),
                    CursorPromptKind::Primary,
                    primary_input,
                    "session".into(),
                    vec![json!({ "type": "text", "text": "start" })],
                );
                timeout(Duration::from_secs(10), prompt)
                    .await
                    .expect("the run finishes")
                    .unwrap();
                assert_eq!(
                    *observed.lock().unwrap(),
                    vec![(true, true)],
                    "at its terminal event the run is neither live nor steerable"
                );
                // The finished run's cleanup must not evict its successor.
                assert!(turns
                    .lock()
                    .await
                    .get("thread")
                    .is_some_and(|current| Arc::ptr_eq(current, &successor)));
                assert!(successor.alive.load(Ordering::Acquire));
                successor.shutdown().await;
            });
        }

        #[test]
        fn direct_exit_ends_the_transport_while_a_descendant_holds_output() {
            tauri::async_runtime::block_on(async {
                // The descendant inherits stdout and stderr and outlives the
                // agent, so EOF would not arrive until the fixture is released.
                let fixture = Fixture::new();
                let mut command = fixture.command("orphan-parent");
                command
                    .env(FIXTURE_READ_FIRST, "1")
                    .env(FIXTURE_HOLDER, "hold")
                    .env(
                        FIXTURE_FINAL,
                        r#"{"jsonrpc":"2.0","id":1,"result":{"final":true}}"#,
                    );
                let (emit, events) = recording_emit();
                let process = attach(command, emit, CURSOR_INPUT_TIMEOUT);
                let first = timeout(
                    Duration::from_secs(10),
                    process.request("session/prompt", json!({})),
                )
                .await
                .expect("buffered final output is delivered");
                assert_eq!(first.unwrap()["final"], true);
                wait_until(
                    || !process.alive.load(Ordering::Acquire),
                    crate::PROVIDER_EXIT_DRAIN + Duration::from_secs(5),
                )
                .await;
                let second = timeout(
                    Duration::from_secs(2),
                    process.request("session/prompt", json!({})),
                )
                .await
                .expect("later requests fail instead of hanging");
                assert!(second.is_err());
                // Stderr written before the exit is still reported.
                wait_until(
                    || {
                        messages(&events).iter().any(|message| {
                            message["line"] == crate::provider_runtime_tests::FIXTURE_STDERR
                        })
                    },
                    Duration::from_secs(5),
                )
                .await;
                let exits = messages(&events)
                    .into_iter()
                    .filter(|message| message["type"] == "openkiwi_exit")
                    .count();
                assert_eq!(exits, 1);
            });
        }

        #[test]
        fn ready_notification_bursts_are_emitted_in_bounded_batches() {
            tauri::async_runtime::block_on(async {
                let fixture = Fixture::new();
                let (process, events) = fake_agent(&fixture, "burst", CURSOR_INPUT_TIMEOUT);
                process.prompt_started.store(true, Ordering::Release);
                let notifications = |events: &Events| -> Vec<i64> {
                    messages(events)
                        .iter()
                        .filter(|message| message["type"] == "notification")
                        .map(|message| message["params"]["n"].as_i64().unwrap())
                        .collect()
                };
                wait_until(
                    || notifications(&events).len() >= 1000,
                    Duration::from_secs(10),
                )
                .await;
                let batches: Vec<usize> = events
                    .lock()
                    .unwrap()
                    .iter()
                    .filter(|(name, _)| name == "cursor-events")
                    .map(|(_, batch)| batch.as_array().unwrap().len())
                    .collect();
                assert!(
                    batches
                        .iter()
                        .all(|len| *len <= crate::CODEX_DELTA_MAX_BATCH_SIZE),
                    "{batches:?}"
                );
                assert_eq!(notifications(&events), (0..1000).collect::<Vec<_>>());
                process.shutdown().await;
            });
        }
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
