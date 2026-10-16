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
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
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
    starts: super::NativeStartRegistry,
    identities: Mutex<HashMap<String, CursorTurnIdentity>>,
    authenticated: AtomicBool,
    /// Advances only at sign-in, which can change credentials outside this
    /// process; a check spanning one cannot authorize turns.
    auth_check_generation: StdMutex<u64>,
    /// Ordinary checks run one at a time so one cannot cancel another's
    /// (for example a turn's own check) merely by starting.
    auth_check_lock: Mutex<()>,
    auth_probes: StdMutex<CursorAuthProbes>,
}

/// Callers that waited behind a probe share its result instead of queueing
/// another full CLI check each. Only a probe that finished after the caller
/// arrived, under the current sign-in generation, is shared; nothing else is
/// reused, so a check started after one settles still probes.
#[derive(Default)]
struct CursorAuthProbes {
    completed: u64,
    last: Option<(u64, Result<CursorRuntimeStatus, String>)>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CursorTurnIdentity {
    turn_id: String,
    start_request_id: Option<String>,
    cursor_session_id: Option<String>,
    phase: String,
    requested_effort: String,
    effort_status: String,
}

struct CursorProcess {
    stdin: Mutex<ChildStdin>,
    child: Arc<Mutex<Child>>,
    pid: Option<u32>,
    pending: PendingMap,
    next_id: AtomicI64,
    alive: AtomicBool,
    cutoff_uncertain: AtomicBool,
    cutoff_error: StdMutex<Option<String>>,
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

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CursorRuntimeStatus {
    available: bool,
    path: Option<String>,
    version: Option<String>,
    logged_in: bool,
    auth_verified: bool,
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
    requested_effort: String,
    effort_status: String,
}

impl CursorProcess {
    /// Test-only phase marker; a no-op in the app.
    fn stage(&self, _stage: &'static str) {
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
            let _ = self.retire(&format!("Cursor Agent input failed: {error}"))
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
        self.request_with_receipt(method, params, input, None).await
    }

    async fn request_with_receipt(
        &self,
        method: &str,
        params: Value,
        input: Option<CursorPromptInputTicket>,
        mut receipt: Option<oneshot::Sender<Result<(), String>>>,
    ) -> Result<Value, String> {
        if let Some(input) = input.as_ref() {
            if let Err(error) = input.wait().await {
                if let Some(receipt) = receipt.take() { let _ = receipt.send(Err(error.clone())); }
                return Err(error);
            }
        }
        if !self.alive.load(Ordering::Acquire) {
            let error = "This Cursor turn is no longer running".to_string();
            if let Some(receipt) = receipt.take() { let _ = receipt.send(Err(error.clone())); }
            return Err(error);
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
        if let Some(receipt) = receipt.take() {
            let reported = written.as_ref().map(|_| ()).map_err(|error| format!("MYTHRA_DELIVERY_UNCERTAIN: Cursor input may have been written: {error}"));
            let _ = receipt.send(reported);
        }
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
    async fn shutdown(&self) -> Result<(), String> {
        let result = self.retire(CURSOR_STOPPED).await;
        // Close input only if no writer owns it; one that does fails on its own
        // now that the process is gone.
        if let Ok(mut stdin) = self.stdin.try_lock() {
            let _ = timeout(Duration::from_millis(250), stdin.shutdown()).await;
        }
        result
    }

    /// End this transport: refuse further input and steers, fail every request
    /// still waiting with `reason`, and kill the process. Idempotent.
    async fn retire(&self, reason: &str) -> Result<(), String> {
        self.stage("retire: start");
        self.cutoff_uncertain.store(true, Ordering::Release);
        self.alive.store(false, Ordering::Release);
        self.run.close();
        // Settle first: once the process dies the reader reaches EOF and would
        // otherwise report a generic closed connection instead of the cause.
        fail_pending(&self.pending, reason).await;
        self.stage("retire: pending settled");
        let result = self.terminate().await;
        self.stage("retire: done");
        result
    }

    /// Kill the process tree and reap the direct child, unless it was already
    /// reaped. An unreaped child keeps its pid and process group reserved, so
    /// the tree signal cannot reach an unrelated process that reused them.
    async fn terminate(&self) -> Result<(), String> {
        self.cutoff_uncertain.store(true, Ordering::Release);
        let mut child = self.child.lock().await;
        self.stage("terminate: child locked");
        match child.try_wait() {
            Ok(None) => {
            let tree_result = self.pid.map(super::kill_process_tree).unwrap_or(Ok(()));
            self.stage("terminate: tree kill returned");
            let _ = child.start_kill();
            let reaped = timeout(CURSOR_KILL_REAP_GRACE, child.wait()).await;
            self.stage(match &reaped {
                Ok(Ok(_)) => "terminate: reaped",
                Ok(Err(_)) => "terminate: wait failed",
                Err(_) => "terminate: reap grace elapsed",
            });
            let reap_result = match reaped {
                Ok(Ok(_)) => Ok(()),
                Ok(Err(error)) => Err(format!("Could not confirm Cursor process exit: {error}")),
                Err(_) => Err("Cursor process did not exit within the cutoff deadline.".to_string()),
            };
            let result = tree_result.and(reap_result);
            *self.cutoff_error.lock().unwrap_or_else(PoisonError::into_inner) = result.as_ref().err().cloned();
            self.cutoff_uncertain.store(result.is_err(), Ordering::Release);
            result
            }
            Ok(Some(_)) => {
            self.stage("terminate: already exited");
            if let Some(error) = self.cutoff_error.lock().unwrap_or_else(PoisonError::into_inner).clone() {
                Err(format!("An earlier Cursor cutoff remains unconfirmed ({error}); its reaped process identity cannot safely be signalled again."))
            } else { self.cutoff_uncertain.store(false, Ordering::Release); Ok(()) }
            }
            Err(error) => {
                self.cutoff_uncertain.store(true, Ordering::Release);
                let error = format!("Could not inspect the Cursor process before stopping it: {error}");
                *self.cutoff_error.lock().unwrap_or_else(PoisonError::into_inner) = Some(error.clone());
                Err(error)
            }
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
    receipt: Option<oneshot::Sender<Result<(), String>>>,
) -> tauri::async_runtime::JoinHandle<()> {
    tauri::async_runtime::spawn(async move {
        let result = process
            .request_with_receipt(
                "session/prompt",
                json!({ "sessionId": session_id, "prompt": blocks }),
                Some(input),
                receipt,
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
    if let Err(error) = process.shutdown().await {
        process.emit_turn_message(json!({"type":"openkiwi_cutoff_uncertain","message":error}));
        return;
    }
    process.emit_turn_message(cursor_final_message(outcomes));
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
    let output = timeout(
        super::RUNTIME_PROBE_TIMEOUT,
        background_command("wsl.exe")
            .args([
                "--exec",
                "sh",
                "-lc",
                "command -v cursor-agent || command -v agent",
            ])
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .output(),
    )
    .await
    .ok()?
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
    #[cfg(windows)]
    if let Some(local_app_data) = env::var_os("LOCALAPPDATA").map(PathBuf::from) {
        if let Some(runtime) = resolve_windows_cursor_install_at(&local_app_data) {
            return Ok(runtime);
        }
    }
    for name in executable_names {
        if let Some(candidate) = super::find_on_path(name).await {
            return Ok(CursorRuntime::Native(candidate));
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
            let candidate = home.join(relative);
            if candidate.is_file() {
                return Ok(CursorRuntime::Native(candidate));
            }
        }
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

/// Bounds for the `agent status --format json` sign-in probe.
const CURSOR_STATUS_TIMEOUT: Duration = Duration::from_secs(15);
const CURSOR_STATUS_MAX_BYTES: u64 = 65_536;
const CURSOR_STATUS_UNRECOGNIZED: &str =
    "Cursor Agent did not return a supported sign-in status. Update Cursor Agent, then refresh.";

fn parse_cursor_sign_in_status(bytes: &[u8]) -> Result<(bool, Option<String>, bool), String> {
    let status: Value = serde_json::from_slice(bytes)
        .map_err(|_| CURSOR_STATUS_UNRECOGNIZED.to_string())?;
    // These fields describe the CLI's local sign-in state, independently of
    // whether its optional account-details request succeeded. In particular,
    // missing email is not evidence of sign-out or of service availability.
    let (logged_in, has_access_token, has_refresh_token) = match (
        status.get("status").and_then(Value::as_str),
        status.get("isAuthenticated").and_then(Value::as_bool),
    ) {
        (Some("authenticated"), Some(true)) => (true, true, true),
        (Some("unauthenticated"), Some(false)) => (false, false, false),
        (Some("partially-authenticated"), Some(false)) => (false, true, false),
        _ => return Err(CURSOR_STATUS_UNRECOGNIZED.into()),
    };
    for (field, expected) in [
        ("hasAccessToken", has_access_token),
        ("hasRefreshToken", has_refresh_token),
    ] {
        if let Some(value) = status.get(field) {
            if value.as_bool() != Some(expected) {
                return Err(CURSOR_STATUS_UNRECOGNIZED.into());
            }
        }
    }
    let email = if logged_in {
        status
            .get("userInfo")
            .and_then(|info| info.get("email"))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|email| email.contains('@') && !email.chars().any(char::is_whitespace))
            .map(str::to_string)
    } else {
        None
    };
    // Cursor reports cached credentials as authenticated even when getMe fails.
    // An email is optional (Enterprise accounts may omit it), but a successful
    // account response must contain some account evidence before we say Connected.
    let auth_verified = !logged_in
        || status.get("userInfo").is_some_and(|info| {
            ["email", "userId", "firstName", "lastName", "teamId", "createdAt"]
                .iter()
                .any(|field| {
                    info.get(*field).is_some_and(|value| {
                        !value.is_null()
                            && value.as_str().is_none_or(|text| !text.trim().is_empty())
                    })
                })
        });
    Ok((logged_in, email, auth_verified))
}

async fn read_cursor_runtime_status(app: &AppHandle) -> Result<CursorRuntimeStatus, String> {
    let runtime = match resolve_cursor_runtime(app).await {
        Ok(runtime) => runtime,
        Err(error) => {
            return Ok(CursorRuntimeStatus {
                available: false,
                path: None,
                version: None,
                logged_in: false,
                auth_verified: false,
                email: None,
                subscription_type: None,
                warning: Some(error),
            });
        }
    };
    // Bounded like the Claude probe: a wedged CLI must not pin the account
    // panel on "checking" forever.
    let mut child = runtime
        .background(None)
        .args(["status", "--format", "json"])
        .env("NO_COLOR", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|error| format!("Could not check Cursor account status: {error}"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Could not read Cursor account status.".to_string())?;
    let bytes = timeout(CURSOR_STATUS_TIMEOUT, async {
        let mut bytes = Vec::new();
        stdout
            .take(CURSOR_STATUS_MAX_BYTES + 1)
            .read_to_end(&mut bytes)
            .await
            .map_err(|_| "Could not read Cursor account status.".to_string())?;
        if bytes.len() as u64 > CURSOR_STATUS_MAX_BYTES {
            return Err("Cursor account status was unexpectedly large.".to_string());
        }
        let status = child
            .wait()
            .await
            .map_err(|error| format!("Could not check Cursor account status: {error}"))?;
        if !status.success() {
            return Err(format!(
                "Cursor account status could not be checked ({status}). Try refreshing, or update Cursor Agent if the problem continues."
            ));
        }
        Ok(bytes)
    })
    .await
    .map_err(|_| "Cursor account status took too long to check. Try refreshing.".to_string())??;
    let (logged_in, email, auth_verified) = parse_cursor_sign_in_status(&bytes)?;
    Ok(CursorRuntimeStatus {
        available: true,
        path: Some(runtime.display_path()),
        // Status does not expose version or plan. Their UI fallbacks avoid a
        // second account-details probe delaying or invalidating sign-in.
        version: None,
        logged_in,
        auth_verified,
        email,
        subscription_type: None,
        warning: (!auth_verified).then(|| {
            "Cursor credentials are saved, but the connection could not be verified. Try refreshing, or sign in again."
                .to_string()
        }),
    })
}

fn invalidate_cursor_auth(state: &CursorState) {
    let mut generation = state
        .auth_check_generation
        .lock()
        .unwrap_or_else(PoisonError::into_inner);
    *generation = generation.wrapping_add(1);
    state.authenticated.store(false, Ordering::Release);
}

fn cursor_auth_generation(state: &CursorState) -> u64 {
    *state.auth_check_generation.lock().unwrap_or_else(PoisonError::into_inner)
}

/// A turn authorizes once, then session setup may take minutes. Refuse the
/// first prompt if a sign-in began meanwhile or a check found the account
/// signed out or unverifiable. Ordinary checks that still find it signed in pass.
fn cursor_auth_admits(state: &CursorState, authorized_generation: u64) -> Result<(), String> {
    let generation = state.auth_check_generation.lock().unwrap_or_else(PoisonError::into_inner);
    if *generation != authorized_generation || !state.authenticated.load(Ordering::Acquire) {
        return Err("Cursor's sign-in changed before this message was sent. Check the connection, then send it again.".into());
    }
    Ok(())
}

async fn checked_cursor_runtime_status(
    app: &AppHandle,
    state: &CursorState,
) -> Result<CursorRuntimeStatus, String> {
    let arrived = state.auth_probes.lock().unwrap_or_else(PoisonError::into_inner).completed;
    let _serial = state.auth_check_lock.lock().await;
    {
        // Validate against the live generation while holding its lock, as
        // fresh publication does, so a sign-in cannot land in between.
        let generation = state.auth_check_generation.lock().unwrap_or_else(PoisonError::into_inner);
        let probes = state.auth_probes.lock().unwrap_or_else(PoisonError::into_inner);
        if probes.completed != arrived {
            if let Some((_, result)) = probes.last.as_ref().filter(|(checked, _)| *checked == *generation) {
                return result.clone();
            }
        }
    }
    // Captured under the probe lock, through publication; sign-in
    // invalidates without waiting for it.
    let checked_generation = cursor_auth_generation(state);
    let result = read_cursor_runtime_status(app).await;
    let result = {
        let generation = state
            .auth_check_generation
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        if *generation != checked_generation {
            Err("A Cursor sign-in started during this check. Try refreshing.".to_string())
        } else {
            // An unknown account check cannot authorize starting a native turn.
            // Reject it to the UI without presenting it as a proven sign-out.
            // Optional account details can be unavailable for an otherwise
            // usable login. Permit a passive ACP attempt from saved credentials;
            // ACP itself rejects unusable authentication without opening login.
            state.authenticated.store(
                result.as_ref().is_ok_and(|status| status.logged_in),
                Ordering::Release,
            );
            result
        }
    };
    let mut probes = state.auth_probes.lock().unwrap_or_else(PoisonError::into_inner);
    probes.completed = probes.completed.wrapping_add(1);
    probes.last = Some((checked_generation, result.clone()));
    result
}

#[tauri::command]
pub async fn cursor_runtime_status(
    app: AppHandle,
    state: State<'_, CursorState>,
) -> Result<CursorRuntimeStatus, String> {
    checked_cursor_runtime_status(&app, &state).await
}

#[tauri::command]
pub async fn cursor_login(app: AppHandle) -> Result<(), String> {
    // Sign-in changes credentials outside this process. A check started
    // before it must not restore the previous account authorization.
    invalidate_cursor_auth(&app.state::<CursorState>());
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
        cutoff_uncertain: AtomicBool::new(false),
        cutoff_error: StdMutex::new(None),
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
                        Err(super::provider_error_text(error
                            .get("message")
                            .and_then(Value::as_str)
                            .unwrap_or("Cursor Agent request failed")))
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
        let _ = process.terminate().await;
    }
    // A descendant can hold stderr open too; it is diagnostic, not lifecycle.
    if let Some(stderr_task) = stderr_task {
        super::finish_stderr_reader(stderr_task).await;
    }
}

async fn initialize_cursor(process: &CursorProcess) -> Result<Value, String> {
    // ACP starts with the CLI's existing authentication state. Never call
    // authenticate(cursor_login) here: it can open a browser when credentials
    // expire, including during background model refresh or unattended turns.
    // Only the explicit cursor_login command may start interactive sign-in.
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
    process.shutdown().await?;
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
    system_prompt: Option<&str>,
    attachments: &[CursorAttachment],
    wsl: bool,
) -> Result<Vec<Value>, String> {
    // New turns carry the current snapshot, including an explicit clear.
    // Steering adds user input while keeping the running turn's policy frozen.
    let text = if let Some(system_prompt) = system_prompt {
        let effective = if system_prompt.trim().is_empty() {
            "Current effective app system prompt: none. There is no additional app system prompt or system-selected skill for this turn."
        } else {
            system_prompt.trim()
        };
        format!(
            "<openkiwi_instructions>\nMythra Code current app system-prompt configuration for this turn. This latest snapshot supersedes earlier app system-prompt snapshots, resolved system-skill envelopes, and unresolved @skill selections from earlier app system prompts. Do not treat removed system-selected skills as current requirements. User-message skills and ordinary conversation instructions remain valid independently. Native permissions, delegation policy, and other non-app-system instructions remain in force.\n\n{}\n</openkiwi_instructions>\n\n{}",
            effective,
            prompt
        )
    } else {
        prompt.to_string()
    };
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
        Some(&options.system_prompt),
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
    mut options: CursorTurnOptions,
) -> Result<CursorTurnStarted, String> {
    let mut process_requested = false;
    let mut safe_not_dispatched = false;
    let result: Result<CursorTurnStarted, String> = async {
    let turn_id = uuid::Uuid::new_v4().to_string();
    let start = state.starts.begin(&options.thread_id, &turn_id, options.start_request_id.as_deref())?;
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
    if crate::normal_chat::contains(&app, &options.cwd)? {
        options.system_prompt = crate::normal_chat::instructions(&options.system_prompt);
    }
    let authorized_generation = cursor_auth_generation(&state);
    if !state.authenticated.load(Ordering::Acquire) {
        let status = checked_cursor_runtime_status(&app, &state).await?;
        if !status.logged_in {
            return Err("Sign in to Cursor Agent before sending a message.".into());
        }
    }
    if state
        .turns
        .lock()
        .await
        .get(&options.thread_id)
        .is_some_and(|turn| turn.alive.load(Ordering::Acquire) || turn.cutoff_uncertain.load(Ordering::Acquire))
    {
        return Err("Cursor is already working in this thread".into());
    }
    state.identities.lock().await.insert(options.thread_id.clone(), CursorTurnIdentity {
        turn_id: turn_id.clone(), start_request_id: options.start_request_id.clone(),
        cursor_session_id: options.resume_session_id.clone(), phase: "starting".into(),
        requested_effort: options.effort.clone(), effort_status: "providerDefault".into(),
    });
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
    start.assert_current()?;
    process_requested = true;
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
        existing.alive.load(Ordering::Acquire) || existing.cutoff_uncertain.load(Ordering::Acquire)
    })
    .await
    {
        let _ = process.shutdown().await;
        return Err("Cursor is already working in this thread".into());
    }

    let start_result = async {
        start.assert_current()?;
        initialize_cursor(&process).await?;
        start.assert_current()?;
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
        if let Some(identity) = state.identities.lock().await.get_mut(&options.thread_id) {
            if identity.turn_id == turn_id { identity.cursor_session_id = Some(session_id.clone()); }
        }
        start.assert_current()?;
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
        let effort_status = if let Some((config_id, value)) = config_option_id(&setup, &options.effort) {
            process
                .request(
                    "session/set_config_option",
                    json!({ "sessionId": session_id, "configId": config_id, "value": value }),
                )
                .await.map_err(|error| format!("Cursor refused the requested reasoning effort before prompt dispatch: {error}"))?;
            "applied"
        } else if options.effort.trim().is_empty() || options.effort == "default" {
            "providerDefault"
        } else { "unsupported" };
        let blocks = cursor_prompt_blocks(&options, process.wsl).await?;
        start.assert_current()?;
        if let Some(identity) = state.identities.lock().await.get_mut(&options.thread_id) {
            if identity.turn_id == turn_id { identity.effort_status = effort_status.into(); }
        }
        process.emit_turn_message(json!({ "type": "openkiwi_session", "cursorSessionId": session_id,
            "requestedEffort": options.effort, "effortStatus": effort_status }));
        Ok::<_, String>((session_id, blocks, effort_status.to_string()))
    }
    .await;
    // Admission fails only if the process already ended or was stopped.
    let start_result = start_result.and_then(|started| {
        start.assert_current()?;
        cursor_auth_admits(&state, authorized_generation)?;
        process.prompt_started.store(true, Ordering::Release);
        if let Some(input) = process.run.admit_primary() {
            Ok((started, input))
        } else {
            Err("Cursor Agent stopped before the turn started.".to_string())
        }
    });
    let ((session_id, blocks, effort_status), input) = match start_result {
        Ok(value) => value,
        Err(error) => {
            if let Err(cutoff) = process.shutdown().await {
                start.record_cutoff_error(&cutoff);
                return Err(format!("{error} The unused Cursor process cutoff is uncertain: {cutoff}"));
            }
            let mut turns = state.turns.lock().await;
            if turns
                .get(&options.thread_id)
                .is_some_and(|current| Arc::ptr_eq(current, &process))
            {
                turns.remove(&options.thread_id);
            }
            drop(turns);
            // No primary prompt task was spawned on this path. Successful
            // native cleanup proves refusal, even if session/effort setup ran.
            safe_not_dispatched = true;
            return Err(error);
        }
    };

    let (receipt_sender, receipt_receiver) = oneshot::channel();
    spawn_cursor_prompt(
        process.clone(),
        state.turns.clone(),
        CursorPromptKind::Primary,
        input,
        session_id.clone(),
        blocks,
        Some(receipt_sender),
    );
    let receipt = receipt_receiver.await.map_err(|_| "MYTHRA_DELIVERY_UNCERTAIN: Cursor did not return the first prompt's input receipt.".to_string())?;
    if let Err(error) = receipt {
        if !error.starts_with("MYTHRA_DELIVERY_UNCERTAIN:") {
            if let Err(cutoff) = process.shutdown().await {
                start.record_cutoff_error(&cutoff);
                return Err(format!("{error} Cursor first-prompt cutoff is uncertain: {cutoff}"));
            }
            let mut turns = state.turns.lock().await;
            if turns.get(&options.thread_id).is_some_and(|current| Arc::ptr_eq(current, &process)) { turns.remove(&options.thread_id); }
            safe_not_dispatched = true;
        }
        return Err(error);
    }

    Ok(CursorTurnStarted {
        turn_id,
        cursor_session_id: session_id,
        requested_effort: options.effort,
        effort_status,
    })
    }.await;
    if process_requested && !safe_not_dispatched { result } else {
        result.map_err(|error| format!("MYTHRA_NOT_DISPATCHED: {}", super::provider_error_text(&error)))
    }
}

#[tauri::command]
pub async fn cursor_turn_steer(
    state: State<'_, CursorState>,
    thread_id: String,
    prompt: String,
    attachments: Vec<CursorAttachment>,
    expected_turn_id: Option<String>,
) -> Result<(), String> {
    let turn = state
        .turns
        .lock()
        .await
        .get(&thread_id)
        .cloned()
        .ok_or("Cursor is not currently running in this thread")?;
    // Retain this exact process after checking the captured renderer owner;
    // async session/attachment preparation must not select a successor.
    // Child bridge messages omit the expectation for thread-current input.
    if expected_turn_id.as_deref().is_some_and(|expected| turn.turn_id.as_deref() != Some(expected)) {
        return Err("MYTHRA_NOT_DISPATCHED: Cursor expected turn ID does not match the currently running turn.".into());
    }
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
    let blocks = match cursor_prompt_blocks_for(&prompt, None, &attachments, turn.wsl).await {
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
    let (receipt_sender, receipt_receiver) = oneshot::channel();
    spawn_cursor_prompt(
        turn,
        state.turns.clone(),
        CursorPromptKind::Steer,
        input,
        session_id,
        blocks,
        Some(receipt_sender),
    );
    receipt_receiver.await.map_err(|_| "MYTHRA_DELIVERY_UNCERTAIN: Cursor did not return its input receipt; inspect the child before resending.".to_string())?
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
    expected_turn_id: Option<String>,
    expected_start_request_id: Option<String>,
) -> Result<(), String> {
    let turns = state.turns.lock().await;
    let turn = turns.get(&thread_id).cloned();
    let identity = state.identities.lock().await.get(&thread_id).cloned();
    if turn.as_ref().is_some_and(|turn| expected_turn_id.as_deref().is_some_and(|expected| turn.turn_id.as_deref() != Some(expected)))
        || turn.is_some() && expected_start_request_id.as_deref().is_some_and(|expected| identity.as_ref().and_then(|identity| identity.start_request_id.as_deref()) != Some(expected)) {
        return Err("The Stop request belongs to an older Cursor turn; the current turn was preserved.".into());
    }
    let pending = state.starts.cancel(&thread_id, expected_turn_id.as_deref(), expected_start_request_id.as_deref())?;
    drop(turns);
    if let Some(turn) = turn {
        turn.shutdown().await?;
        let mut turns = state.turns.lock().await;
        if turns.get(&thread_id).is_some_and(|current| Arc::ptr_eq(current, &turn)) {
            turns.remove(&thread_id);
        }
    }
    super::await_native_start_settlement(pending.clone()).await?;
    if let Some(pending) = pending {
        let late = state.turns.lock().await.get(&thread_id).cloned()
            .filter(|turn| turn.turn_id.as_deref() == Some(pending.turn_id.as_str()));
        if let Some(turn) = late {
            turn.shutdown().await?;
            let mut turns = state.turns.lock().await;
            if turns.get(&thread_id).is_some_and(|current| Arc::ptr_eq(current, &turn)) { turns.remove(&thread_id); }
        }
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
        .is_some_and(|turn| turn.alive.load(Ordering::Acquire) || turn.cutoff_uncertain.load(Ordering::Acquire)))
}

/// The latest native-owned session identity survives renderer replacement and
/// turn completion. It is captured before sending the primary model prompt.
#[tauri::command]
pub async fn cursor_turn_state(state: State<'_, CursorState>, thread_id: String) -> Result<Option<CursorTurnIdentity>, String> {
    let mut identity = state.identities.lock().await.get(&thread_id).cloned();
    let turn = state.turns.lock().await.get(&thread_id).cloned();
    let pending = state.starts.identity(&thread_id);
    // Authentication/binary preparation can precede the first session record.
    // Never relabel the previous completed identity as this new pending start.
    if turn.is_none() {
        if let Some((turn_id, start_request_id, phase)) = pending.as_ref() {
            if identity.as_ref().is_none_or(|identity| identity.turn_id != *turn_id) {
                identity = Some(CursorTurnIdentity { turn_id: turn_id.clone(), start_request_id: start_request_id.clone(),
                    cursor_session_id: None, phase: (*phase).into(), requested_effort: String::new(), effort_status: "providerDefault".into() });
            }
        }
    }
    if let Some(identity) = identity.as_mut() {
        identity.phase = if let Some((_, _, phase)) = pending.filter(|(turn_id, _, _)| *turn_id == identity.turn_id) {
            phase.into()
        } else if let Some(turn) = turn {
            if turn.cutoff_uncertain.load(Ordering::Acquire) { "stopping".into() }
            else if turn.alive.load(Ordering::Acquire) { "running".into() }
            else { "completed".into() }
        } else { "completed".into() };
    }
    Ok(identity)
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
            matches!(timeout(Duration::from_secs(2), turn.shutdown()).await, Ok(Ok(())))
        });
        if !stopped {
            if let Ok(mut child) = turn.child.try_lock() {
                if matches!(child.try_wait(), Ok(None)) {
                    if let Some(pid) = child.id() { let _ = super::kill_process_tree(pid); }
                }
            }
        }
    }
}
