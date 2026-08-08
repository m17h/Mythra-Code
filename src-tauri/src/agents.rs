//! Cross-provider sub-agents.
//!
//! Every provider runtime OpenKiwi drives can only delegate to itself: the
//! Codex app server spawns Codex children, Claude Code spawns Claude
//! sub-agents, and Cursor has no delegation surface at all. To let a root
//! agent delegate *across* providers, OpenKiwi exposes its own delegation
//! tools to whichever runtime is driving the root thread, and performs the
//! spawn itself through the normal per-provider start path.
//!
//! The one tool-injection mechanism all three runtimes share is a local stdio
//! MCP server, so that is the bridge:
//!
//! ```text
//! provider CLI ──stdio MCP──▶ `openkiwi --openkiwi-agent-bridge <session>`
//!                                   │ loopback HTTP + bearer token
//!                                   ▼
//!                             OpenKiwi backend ──Tauri event──▶ webview
//!                                                                  │
//!                                          real provider turn ◀────┘
//! ```
//!
//! The bridge process is this same executable re-invoked with a private
//! argument, so no extra runtime dependency (node, python, a sidecar binary)
//! is introduced. It receives only a path to a 0600 session file; the loopback
//! URL and bearer token live inside that file and never reach argv, a model
//! prompt, a transcript, an audit record, or a project file.
//!
//! Depth is structurally capped at one: a bridge is only ever attached to a
//! root thread's runtime, so a child runtime is started without delegation
//! tools and cannot spawn grandchildren.

use std::{
    collections::{HashMap, HashSet},
    fs::OpenOptions,
    io::Write as _,
    path::PathBuf,
    sync::Arc,
};

use axum::{
    body::Body,
    extract::{Path as AxumPath, State as AxumState},
    http::{header, Response, StatusCode},
    routing::post,
    Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    sync::{oneshot, Mutex},
    time::{timeout, Duration},
};

/// Private argv switch that turns this executable into the stdio MCP bridge.
pub(super) const AGENT_BRIDGE_ARG: &str = "--openkiwi-agent-bridge";

/// MCP server name the provider runtimes register the bridge under.
pub(super) const AGENT_BRIDGE_SERVER: &str = "openkiwi";

/// Tools the bridge exposes. Kept small and explicit so a root model chooses a
/// pre-approved destination rather than writing a free-form model string.
const TOOL_SPAWN: &str = "spawn_agent";
const TOOL_STATUS: &str = "agent_status";
const TOOL_COLLECT: &str = "collect_agent";
const TOOL_CANCEL: &str = "cancel_agent";
pub(super) const AGENT_BRIDGE_TOOLS: [&str; 4] =
    [TOOL_SPAWN, TOOL_STATUS, TOOL_COLLECT, TOOL_CANCEL];

/// How long the backend waits for the webview to answer a delegation request.
/// A cold provider start can take longer than an MCP client's own tool wait.
/// Keep its reservation alive so a late successful response is still recorded
/// and discoverable through `agent_status`, instead of orphaning the child.
const RELAY_TIMEOUT: Duration = Duration::from_secs(60);
const SPAWN_RELAY_TIMEOUT: Duration = Duration::from_secs(300);
const COLLECT_RELAY_TIMEOUT: Duration = Duration::from_secs(360);

const MAX_PROMPT_BYTES: usize = 32_768;
const MAX_TITLE_BYTES: usize = 200;
const MAX_TARGETS: usize = 24;
/// Hard ceiling on concurrent cross-provider children, mirroring the
/// sub-agent maximum the composer already enforces.
const MAX_CONCURRENT_CEILING: usize = 24;

pub(super) fn agent_bridge_providers() -> [&'static str; 4] {
    ["openai", "openrouter", "claude", "cursor"]
}

/// One pre-approved provider/model destination a root agent may delegate to.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(super) struct ChildAgentTarget {
    /// Agent-facing identifier; the only value a model ever writes.
    pub id: String,
    pub provider: String,
    /// Provider-specific model identity. Empty means "the provider default".
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub description: String,
    #[serde(default = "default_reasoning_mode")]
    pub reasoning_mode: String,
    #[serde(default = "default_reasoning_effort")]
    pub reasoning_effort: String,
    #[serde(default = "default_reasoning_max_effort")]
    pub reasoning_max_effort: String,
}

fn default_reasoning_mode() -> String {
    "inherit".into()
}

fn default_reasoning_effort() -> String {
    "medium".into()
}

fn default_reasoning_max_effort() -> String {
    "high".into()
}

const REASONING_EFFORTS: [&str; 6] = ["low", "medium", "high", "xhigh", "max", "ultra"];

fn valid_target_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 40
        && id.chars().all(|character| {
            character.is_ascii_lowercase()
                || character.is_ascii_digit()
                || character == '-'
                || character == '_'
        })
        && id
            .chars()
            .next()
            .is_some_and(|character| character.is_ascii_lowercase() || character.is_ascii_digit())
}

/// Reject anything that could not be honoured later, at the moment the root
/// thread starts, instead of when the model first tries to delegate.
pub(super) fn validate_targets(targets: &[ChildAgentTarget]) -> Result<(), String> {
    if targets.len() > MAX_TARGETS {
        return Err(format!(
            "A thread may allow at most {MAX_TARGETS} cross-provider destinations."
        ));
    }
    let mut seen = HashSet::new();
    for target in targets {
        if !valid_target_id(&target.id) {
            return Err(format!(
                "`{}` is not a valid sub-agent destination name.",
                target.id
            ));
        }
        if !seen.insert(target.id.as_str()) {
            return Err(format!("Duplicate sub-agent destination `{}`.", target.id));
        }
        if !agent_bridge_providers().contains(&target.provider.as_str()) {
            return Err(format!(
                "`{}` is not a provider OpenKiwi can start.",
                target.provider
            ));
        }
        if target.model.len() > 128 || target.label.len() > 80 || target.description.len() > 400 {
            return Err(format!(
                "The `{}` destination has an oversized model, label, or description.",
                target.id
            ));
        }
        if !["inherit", "fixed", "agent"].contains(&target.reasoning_mode.as_str())
            || !REASONING_EFFORTS.contains(&target.reasoning_effort.as_str())
            || !REASONING_EFFORTS.contains(&target.reasoning_max_effort.as_str())
        {
            return Err(format!(
                "The `{}` destination has an invalid reasoning policy.",
                target.id
            ));
        }
    }
    Ok(())
}

#[derive(Default)]
pub(super) struct SessionRuntime {
    /// Children currently running, plus reservations for spawns the webview
    /// has not answered yet, so two concurrent tool calls cannot both pass the
    /// concurrency check.
    pub(super) live: HashSet<String>,
    reserved: usize,
    /// Every child ever spawned in this session; cancel/collect are refused
    /// for ids that did not come from it.
    pub(super) known: HashSet<String>,
    /// Completion can beat the spawn relay response for very short turns.
    /// Remember it so the late response cannot resurrect a released slot.
    pub(super) finished: HashSet<String>,
}

pub(super) fn record_spawned_child(runtime: &mut SessionRuntime, value: &Value) {
    let Some(child_id) = value.get("childId").and_then(Value::as_str) else {
        return;
    };
    runtime.known.insert(child_id.to_string());
    let reported_active = matches!(
        value.get("status").and_then(Value::as_str),
        Some("starting" | "running") | None
    );
    if runtime.finished.remove(child_id) || !reported_active {
        runtime.live.remove(child_id);
    } else {
        runtime.live.insert(child_id.to_string());
    }
}

pub(super) fn record_finished_child(runtime: &mut SessionRuntime, child_id: &str) {
    if !runtime.live.remove(child_id) {
        runtime.finished.insert(child_id.to_string());
    }
}

struct ChildAgentSession {
    /// Client-generated identity for this root thread's delegation session.
    /// Deliberately not the thread id: for app-server providers the bridge has
    /// to exist before `thread/start` returns the id it will belong to.
    session_id: String,
    session_token: String,
    targets: Vec<ChildAgentTarget>,
    max_concurrent: usize,
    directory: PathBuf,
    runtime: Mutex<SessionRuntime>,
}

impl ChildAgentSession {
    fn target(&self, id: &str) -> Option<&ChildAgentTarget> {
        self.targets.iter().find(|target| target.id == id)
    }
}

struct BridgeServer {
    url: String,
    task: tokio::task::JoinHandle<()>,
}

type SessionMap = Arc<Mutex<HashMap<String, Arc<ChildAgentSession>>>>;
type PendingRelays = Arc<Mutex<HashMap<String, oneshot::Sender<Result<Value, String>>>>>;

#[derive(Default)]
pub(super) struct ChildAgentState {
    sessions: SessionMap,
    pending: PendingRelays,
    server: Mutex<Option<BridgeServer>>,
}

/** Only backend-created private MCP configs may be handed to Claude Code. */
pub(super) async fn child_agent_bridge_config_registered(
    state: &ChildAgentState,
    config_path: &str,
) -> bool {
    let path = std::path::Path::new(config_path);
    if !path.is_file() {
        return false;
    }
    state
        .sessions
        .lock()
        .await
        .values()
        .any(|session| session.directory.join("mcp.json") == path)
}

/**
 * Cursor receives a structured MCP command from the renderer. Re-derive the
 * launch identity from live backend state before allowing ACP to execute it,
 * so a forged renderer payload cannot turn this field into command execution.
 */
pub(super) async fn child_agent_bridge_launch_registered(
    state: &ChildAgentState,
    name: &str,
    command: &str,
    args: &[String],
) -> bool {
    if name != AGENT_BRIDGE_SERVER || args.len() != 2 || args[0] != AGENT_BRIDGE_ARG {
        return false;
    }
    let Ok(executable) = std::env::current_exe() else {
        return false;
    };
    if std::path::Path::new(command) != executable {
        return false;
    }
    let session_file = std::path::Path::new(&args[1]);
    state
        .sessions
        .lock()
        .await
        .values()
        .any(|session| session.directory.join("session.json") == session_file)
}

#[derive(Clone)]
struct BridgeHttpState {
    app: AppHandle,
    server_token: String,
    sessions: SessionMap,
    pending: PendingRelays,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BridgeRequest {
    session: String,
    method: String,
    #[serde(default)]
    tool: String,
    #[serde(default)]
    arguments: Value,
}

/// Contents of the 0600 session file the bridge process reads. This is the
/// only place the loopback URL and bearer token exist outside memory.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BridgeSessionFile {
    url: String,
    session_token: String,
    session_id: String,
}

/// Everything a provider runtime needs to launch the bridge. Deliberately
/// carries no secret, so it can cross the Tauri boundary into the webview and
/// into a runtime's MCP configuration without leaking anything.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub(super) struct ChildAgentBridgeLaunch {
    pub name: String,
    pub command: String,
    pub args: Vec<String>,
    /// A ready-made `{"mcpServers":{…}}` file for CLIs that take a config path
    /// (Claude Code) instead of structured configuration.
    pub config_path: String,
    pub tool_names: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ChildAgentSessionOptions {
    session_id: String,
    targets: Vec<ChildAgentTarget>,
    max_concurrent: usize,
    /// Children already spawned in an earlier app session. Re-seeding them
    /// keeps `collect_agent`/`cancel_agent` working for a resumed thread whose
    /// backend session had to be rebuilt.
    #[serde(default)]
    known_children: Vec<String>,
}

fn bridge_root(app: &AppHandle) -> Result<PathBuf, String> {
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Could not resolve OpenKiwi app data: {error}"))?
        .join("child-agents");
    std::fs::create_dir_all(&directory)
        .map_err(|error| format!("Could not create the sub-agent bridge directory: {error}"))?;
    Ok(directory)
}

fn write_private_file(path: &std::path::Path, contents: &str) -> Result<(), String> {
    #[cfg(unix)]
    use std::os::unix::fs::OpenOptionsExt;

    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    options.mode(0o600);
    let mut file = options.open(path).map_err(|error| {
        format!("Could not create the private sub-agent bridge configuration: {error}")
    })?;
    file.write_all(contents.as_bytes())
        .map_err(|error| format!("Could not write the sub-agent bridge configuration: {error}"))?;
    Ok(())
}

/// Remove bridge material left behind by a previous run. A session file is
/// only ever useful while its backend is listening, so nothing here can be
/// live at startup.
pub(super) fn purge_stale_agent_bridges(app: &AppHandle) {
    if let Ok(directory) = bridge_root(app) {
        let _ = std::fs::remove_dir_all(&directory);
    }
}

fn json_response(status: StatusCode, body: Value) -> Response<Body> {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(body.to_string()))
        .unwrap_or_else(|_| Response::new(Body::empty()))
}

/// Compare secrets without an early exit on the first differing byte.
pub(super) fn tokens_match(left: &str, right: &str) -> bool {
    if left.len() != right.len() {
        return false;
    }
    left.bytes()
        .zip(right.bytes())
        .fold(0u8, |difference, (a, b)| difference | (a ^ b))
        == 0
}

/// The MCP tool catalog for one session. The `target` enum is exactly the set
/// of destinations the user approved when this root thread started, so the
/// model chooses a provider/model pair by name and can never invent one.
pub(super) fn tool_catalog(targets: &[ChildAgentTarget]) -> Value {
    let ids: Vec<Value> = targets
        .iter()
        .map(|target| Value::String(target.id.clone()))
        .collect();
    let roster = targets
        .iter()
        .map(|target| {
            let model = if target.model.is_empty() {
                "provider default".to_string()
            } else {
                target.model.clone()
            };
            let description = if target.description.is_empty() {
                String::new()
            } else {
                format!(" — {}", target.description)
            };
            let reasoning = match target.reasoning_mode.as_str() {
                "fixed" => format!("reasoning fixed at {}", target.reasoning_effort),
                "agent" => format!(
                    "you may choose reasoning up to {} with `reasoningEffort`",
                    target.reasoning_max_effort
                ),
                _ => "reasoning inherited from the parent".to_string(),
            };
            format!(
                "`{}`: {} / {} / {}{}",
                target.id, target.provider, model, reasoning, description
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    let target_property = json!({
        "type": "string",
        "enum": ids,
        "description": format!("Which approved destination runs this child.\n{roster}"),
    });

    json!([
        {
            "name": TOOL_SPAWN,
            "title": "Spawn a sub-agent",
            "description": format!(
                "Start a child agent on one of the destinations OpenKiwi approved for this thread. \
                 The child runs in the same workspace with the same permission policy, reports into the \
                 same conversation, and returns immediately with an id — use `{TOOL_COLLECT}` to wait for its result.\n\nDestinations:\n{roster}"
            ),
            "inputSchema": {
                "type": "object",
                "properties": {
                    "target": target_property,
                    "prompt": {
                        "type": "string",
                        "description": "The complete, self-contained task for the child. It does not see this conversation.",
                    },
                    "title": {
                        "type": "string",
                        "description": "Optional short label shown in the OpenKiwi timeline.",
                    },
                    "reasoningEffort": {
                        "type": "string",
                        "enum": REASONING_EFFORTS,
                        "description": "Optional. Set only when the chosen destination says you may decide reasoning, and never above its user-approved ceiling.",
                    },
                },
                "required": ["target", "prompt"],
                "additionalProperties": false,
            },
        },
        {
            "name": TOOL_STATUS,
            "title": "Read sub-agent status",
            "description": "List the children spawned from this thread and their current lifecycle status.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "childId": { "type": "string", "description": "Optional: report on one child instead of all." },
                },
                "additionalProperties": false,
            },
        },
        {
            "name": TOOL_COLLECT,
            "title": "Collect a sub-agent result",
            "description": "Wait for a child to finish and return its final message. Returns a still-running status if the wait elapses first.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "childId": { "type": "string" },
                    "timeoutSeconds": { "type": "number", "minimum": 1, "maximum": 45 },
                },
                "required": ["childId"],
                "additionalProperties": false,
            },
        },
        {
            "name": TOOL_CANCEL,
            "title": "Cancel a sub-agent",
            "description": "Interrupt a running child. Its partial work stays visible in the OpenKiwi timeline.",
            "inputSchema": {
                "type": "object",
                "properties": { "childId": { "type": "string" } },
                "required": ["childId"],
                "additionalProperties": false,
            },
        },
    ])
}

/// Reject a malformed or out-of-policy call before any thread is started.
/// Pure so the whole matrix is unit-testable without a runtime.
pub(super) fn validate_tool_call(
    session_targets: &[ChildAgentTarget],
    known_children: &HashSet<String>,
    tool: &str,
    arguments: &Value,
) -> Result<(), String> {
    let object = arguments
        .as_object()
        .ok_or_else(|| "Tool arguments must be an object.".to_string())?;
    let text = |key: &str| object.get(key).and_then(Value::as_str).unwrap_or_default();
    match tool {
        TOOL_SPAWN => {
            let target = text("target");
            if target.is_empty() {
                return Err("`target` is required: name one of the approved destinations.".into());
            }
            let selected_target = session_targets.iter().find(|entry| entry.id == target);
            if selected_target.is_none() {
                let allowed = session_targets
                    .iter()
                    .map(|entry| entry.id.as_str())
                    .collect::<Vec<_>>()
                    .join(", ");
                return Err(format!(
                    "`{target}` is not an approved destination for this thread. Allowed: {allowed}."
                ));
            }
            let prompt = text("prompt");
            if prompt.trim().is_empty() {
                return Err(
                    "`prompt` is required and must describe the child's whole task.".into(),
                );
            }
            if prompt.len() > MAX_PROMPT_BYTES {
                return Err(format!(
                    "`prompt` is too long ({} bytes); the limit is {MAX_PROMPT_BYTES}.",
                    prompt.len()
                ));
            }
            if text("title").len() > MAX_TITLE_BYTES {
                return Err(format!("`title` is limited to {MAX_TITLE_BYTES} bytes."));
            }
            if let Some(reasoning_effort) = object.get("reasoningEffort") {
                let reasoning_effort = reasoning_effort.as_str().ok_or_else(|| {
                    "`reasoningEffort` must be a named reasoning level.".to_string()
                })?;
                let selected_target = selected_target.expect("approved target exists");
                if selected_target.reasoning_mode != "agent" {
                    return Err(
                        "`reasoningEffort` may only be chosen for destinations where the user enabled ‘Main agent decides’."
                            .into(),
                    );
                }
                let requested_rank = REASONING_EFFORTS
                    .iter()
                    .position(|effort| *effort == reasoning_effort)
                    .ok_or_else(|| {
                        format!("`{reasoning_effort}` is not a supported reasoning level.")
                    })?;
                let maximum_rank = REASONING_EFFORTS
                    .iter()
                    .position(|effort| *effort == selected_target.reasoning_max_effort)
                    .expect("validated target reasoning ceiling");
                if requested_rank > maximum_rank {
                    return Err(format!(
                        "`reasoningEffort` exceeds the user’s `{}` ceiling for `{target}`.",
                        selected_target.reasoning_max_effort
                    ));
                }
            }
            Ok(())
        }
        TOOL_STATUS => {
            let child = text("childId");
            if !child.is_empty() && !known_children.contains(child) {
                return Err(format!("`{child}` was not spawned from this thread."));
            }
            Ok(())
        }
        TOOL_COLLECT | TOOL_CANCEL => {
            let child = text("childId");
            if child.is_empty() {
                return Err("`childId` is required.".into());
            }
            if !known_children.contains(child) {
                return Err(format!("`{child}` was not spawned from this thread."));
            }
            if tool == TOOL_COLLECT {
                if let Some(seconds) = object.get("timeoutSeconds") {
                    let seconds = seconds
                        .as_f64()
                        .ok_or_else(|| "`timeoutSeconds` must be a number.".to_string())?;
                    if !(1.0..=45.0).contains(&seconds) {
                        return Err("`timeoutSeconds` must be between 1 and 45.".into());
                    }
                }
            }
            Ok(())
        }
        other => Err(format!("`{other}` is not a sub-agent tool.")),
    }
}

async fn relay_to_app(
    state: &BridgeHttpState,
    session: &ChildAgentSession,
    tool: &str,
    arguments: Value,
) -> Result<Value, String> {
    let request_id = uuid::Uuid::new_v4().to_string();
    let (sender, receiver) = oneshot::channel();
    state
        .pending
        .lock()
        .await
        .insert(request_id.clone(), sender);
    let emitted = state.app.emit(
        "child-agent-request",
        json!({
            "requestId": request_id,
            "sessionId": session.session_id,
            "tool": tool,
            "arguments": arguments,
        }),
    );
    if let Err(error) = emitted {
        state.pending.lock().await.remove(&request_id);
        return Err(format!("OpenKiwi could not dispatch the request: {error}"));
    }
    let wait = match tool {
        TOOL_SPAWN => SPAWN_RELAY_TIMEOUT,
        TOOL_COLLECT => COLLECT_RELAY_TIMEOUT,
        _ => RELAY_TIMEOUT,
    };
    match timeout(wait, receiver).await {
        Ok(Ok(result)) => result,
        Ok(Err(_)) => {
            state.pending.lock().await.remove(&request_id);
            Err("OpenKiwi stopped tracking this request before it completed.".into())
        }
        Err(_) => {
            state.pending.lock().await.remove(&request_id);
            Err("OpenKiwi did not answer the sub-agent request in time.".into())
        }
    }
}

async fn dispatch_tool(
    state: &BridgeHttpState,
    session: &Arc<ChildAgentSession>,
    tool: &str,
    arguments: Value,
) -> Result<Value, String> {
    {
        let runtime = session.runtime.lock().await;
        validate_tool_call(&session.targets, &runtime.known, tool, &arguments)?;
    }

    if tool != TOOL_SPAWN {
        return relay_to_app(state, session, tool, arguments).await;
    }

    // Reserve a concurrency slot before the webview is asked to do anything,
    // so two tool calls arriving together cannot both see the last free slot.
    {
        let mut runtime = session.runtime.lock().await;
        if runtime.live.len() + runtime.reserved >= session.max_concurrent {
            return Err(format!(
                "This thread already has {} sub-agent{} running, which is its configured maximum. Wait for one to finish or cancel it first.",
                session.max_concurrent,
                if session.max_concurrent == 1 { "" } else { "s" }
            ));
        }
        runtime.reserved += 1;
    }

    let target_id = arguments
        .get("target")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let target = session
        .target(target_id)
        .cloned()
        .expect("validate_tool_call accepted the destination");
    let mut relayed = arguments.clone();
    if let Some(object) = relayed.as_object_mut() {
        object.insert("provider".into(), Value::String(target.provider.clone()));
        object.insert("model".into(), Value::String(target.model.clone()));
        object.insert("label".into(), Value::String(target.label.clone()));
    }

    let result = relay_to_app(state, session, tool, relayed).await;
    let mut runtime = session.runtime.lock().await;
    runtime.reserved = runtime.reserved.saturating_sub(1);
    // A refused or failed spawn leaves no child behind, so only a successful
    // one takes a lasting slot.
    if let Ok(value) = &result {
        record_spawned_child(&mut runtime, value);
    }
    result
}

async fn handle_bridge_request(
    AxumState(state): AxumState<BridgeHttpState>,
    AxumPath(token): AxumPath<String>,
    Json(request): Json<BridgeRequest>,
) -> Response<Body> {
    if !tokens_match(&token, &state.server_token) {
        return json_response(StatusCode::NOT_FOUND, json!({ "error": "Not found" }));
    }
    let session = state
        .sessions
        .lock()
        .await
        .values()
        .find(|session| tokens_match(&session.session_token, &request.session))
        .cloned();
    let Some(session) = session else {
        return json_response(
            StatusCode::UNAUTHORIZED,
            json!({ "error": "This sub-agent session is no longer active." }),
        );
    };

    match request.method.as_str() {
        "describe" => json_response(
            StatusCode::OK,
            json!({ "ok": true, "result": { "tools": tool_catalog(&session.targets) } }),
        ),
        "call" => match dispatch_tool(&state, &session, &request.tool, request.arguments).await {
            Ok(result) => json_response(StatusCode::OK, json!({ "ok": true, "result": result })),
            Err(error) => json_response(StatusCode::OK, json!({ "ok": false, "error": error })),
        },
        other => json_response(
            StatusCode::BAD_REQUEST,
            json!({ "ok": false, "error": format!("Unknown bridge method `{other}`") }),
        ),
    }
}

async fn ensure_bridge_server(
    app: &AppHandle,
    state: &ChildAgentState,
) -> Result<(String, String), String> {
    let mut server = state.server.lock().await;
    if let Some(existing) = server.as_ref() {
        if !existing.task.is_finished() {
            let token = existing
                .url
                .rsplit('/')
                .next()
                .unwrap_or_default()
                .to_string();
            return Ok((existing.url.clone(), token));
        }
    }

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|error| format!("Could not start the sub-agent bridge: {error}"))?;
    let address = listener
        .local_addr()
        .map_err(|error| format!("Could not read the sub-agent bridge address: {error}"))?;
    let server_token = super::random_hex_token()?;
    let http_state = BridgeHttpState {
        app: app.clone(),
        server_token: server_token.clone(),
        sessions: state.sessions.clone(),
        pending: state.pending.clone(),
    };
    let router = Router::new()
        .route("/{token}", post(handle_bridge_request))
        .with_state(http_state);
    let task = tokio::spawn(async move {
        let _ = axum::serve(listener, router).await;
    });
    let url = format!("http://{address}/{server_token}");
    *server = Some(BridgeServer {
        url: url.clone(),
        task,
    });
    Ok((url, server_token))
}

/// Register a root thread's delegation policy and return the launch spec its
/// runtime should register as an MCP server. Called once, when the root thread
/// starts, so the approved destinations cannot drift mid-thread.
#[tauri::command]
pub(super) async fn child_agent_session_start(
    app: AppHandle,
    state: State<'_, ChildAgentState>,
    options: ChildAgentSessionOptions,
) -> Result<ChildAgentBridgeLaunch, String> {
    if options.session_id.trim().is_empty() || options.session_id.len() > 64 {
        return Err("A sub-agent session needs a session identity.".into());
    }
    if options.targets.is_empty() {
        return Err("Approve at least one cross-provider destination first.".into());
    }
    validate_targets(&options.targets)?;
    let max_concurrent = options.max_concurrent.clamp(1, MAX_CONCURRENT_CEILING);

    let (url, _) = ensure_bridge_server(&app, &state).await?;
    let session_token = super::random_hex_token()?;
    let directory = bridge_root(&app)?.join(uuid::Uuid::new_v4().to_string());
    std::fs::create_dir_all(&directory)
        .map_err(|error| format!("Could not create the sub-agent bridge session: {error}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o700))
            .map_err(|error| format!("Could not secure the sub-agent bridge session: {error}"))?;
    }

    let session_path = directory.join("session.json");
    let session_file = serde_json::to_string(&BridgeSessionFile {
        url,
        session_token: session_token.clone(),
        session_id: options.session_id.clone(),
    })
    .map_err(|error| format!("Could not encode the sub-agent bridge session: {error}"))?;
    write_private_file(&session_path, &session_file)?;

    let executable = std::env::current_exe()
        .map_err(|error| format!("Could not resolve the OpenKiwi executable: {error}"))?
        .to_string_lossy()
        .to_string();
    let session_argument = session_path.to_string_lossy().to_string();
    let launch = ChildAgentBridgeLaunch {
        name: AGENT_BRIDGE_SERVER.to_string(),
        command: executable.clone(),
        args: vec![AGENT_BRIDGE_ARG.to_string(), session_argument.clone()],
        config_path: directory.join("mcp.json").to_string_lossy().to_string(),
        tool_names: AGENT_BRIDGE_TOOLS
            .iter()
            .map(|tool| (*tool).to_string())
            .collect(),
    };
    let mcp_config = json!({
        "mcpServers": {
            AGENT_BRIDGE_SERVER: {
                "type": "stdio",
                "command": executable,
                "args": [AGENT_BRIDGE_ARG, session_argument],
            }
        }
    });
    write_private_file(
        std::path::Path::new(&launch.config_path),
        &mcp_config.to_string(),
    )?;

    // Replacing an existing session for the same root thread is how a restart
    // of that thread's runtime re-arms delegation; the old material is removed
    // so a stale bridge process cannot keep talking to the app.
    let mut runtime = SessionRuntime::default();
    for child in options.known_children.iter().take(256) {
        runtime.known.insert(child.clone());
    }
    let previous = state.sessions.lock().await.insert(
        options.session_id.clone(),
        Arc::new(ChildAgentSession {
            session_id: options.session_id.clone(),
            session_token,
            targets: options.targets,
            max_concurrent,
            directory,
            runtime: Mutex::new(runtime),
        }),
    );
    if let Some(previous) = previous {
        let _ = std::fs::remove_dir_all(&previous.directory);
    }
    Ok(launch)
}

#[tauri::command]
pub(super) async fn child_agent_session_end(
    state: State<'_, ChildAgentState>,
    session_id: String,
) -> Result<(), String> {
    if let Some(session) = state.sessions.lock().await.remove(&session_id) {
        let _ = std::fs::remove_dir_all(&session.directory);
    }
    Ok(())
}

/// The webview's answer to a `child-agent-request` event. Exactly one of
/// `result`/`error` is used; an unknown request id is ignored, because the
/// bridge caller has already been told it timed out.
#[tauri::command]
pub(super) async fn child_agent_respond(
    state: State<'_, ChildAgentState>,
    request_id: String,
    result: Option<Value>,
    error: Option<String>,
) -> Result<(), String> {
    let Some(sender) = state.pending.lock().await.remove(&request_id) else {
        return Ok(());
    };
    let payload = match error {
        Some(message) if !message.trim().is_empty() => Err(message),
        _ => Ok(result.unwrap_or_else(|| json!({}))),
    };
    let _ = sender.send(payload);
    Ok(())
}

/// Release a child's concurrency slot once its turn reaches a terminal state.
#[tauri::command]
pub(super) async fn child_agent_finished(
    state: State<'_, ChildAgentState>,
    session_id: String,
    child_thread_id: String,
) -> Result<(), String> {
    let session = state.sessions.lock().await.get(&session_id).cloned();
    if let Some(session) = session {
        let mut runtime = session.runtime.lock().await;
        record_finished_child(&mut runtime, &child_thread_id);
    }
    Ok(())
}

pub(super) fn shutdown_agent_bridges_on_exit(app: &AppHandle) {
    let Some(state) = app.try_state::<ChildAgentState>() else {
        return;
    };
    let Ok(mut sessions) = state.sessions.try_lock() else {
        return;
    };
    for (_, session) in sessions.drain() {
        let _ = std::fs::remove_dir_all(&session.directory);
    }
}

// ---------------------------------------------------------------------------
// Bridge process
// ---------------------------------------------------------------------------

fn mcp_error(id: Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

fn mcp_tool_result(payload: &Value, is_error: bool) -> Value {
    json!({
        "content": [{ "type": "text", "text": serde_json::to_string_pretty(payload).unwrap_or_else(|_| payload.to_string()) }],
        "isError": is_error,
    })
}

async fn bridge_post(
    client: &reqwest::Client,
    config: &BridgeSessionFile,
    body: Value,
) -> Result<Value, String> {
    let response = client
        .post(&config.url)
        .json(&body)
        .send()
        .await
        .map_err(|error| format!("OpenKiwi is not reachable: {error}"))?;
    let status = response.status();
    let payload: Value = response
        .json()
        .await
        .map_err(|error| format!("OpenKiwi returned an unreadable response: {error}"))?;
    if !status.is_success() {
        return Err(payload
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("OpenKiwi rejected the sub-agent request")
            .to_string());
    }
    if payload.get("ok").and_then(Value::as_bool) == Some(false) {
        return Err(payload
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("The sub-agent request failed")
            .to_string());
    }
    Ok(payload.get("result").cloned().unwrap_or_else(|| json!({})))
}

/// The half of the MCP surface that needs no round trip to the app. Returns
/// `Some(Some(response))` when this method was fully handled here, and
/// `Some(None)` for a notification that must not be answered at all.
pub(super) fn bridge_local_response(method: &str, id: Option<&Value>) -> Option<Option<Value>> {
    let Some(id) = id else {
        // A notification: nothing is ever expected in reply.
        return Some(None);
    };
    let id = id.clone();
    match method {
        "initialize" => Some(Some(json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": {
                "protocolVersion": "2025-06-18",
                "capabilities": { "tools": { "listChanged": false } },
                "serverInfo": { "name": AGENT_BRIDGE_SERVER, "version": env!("CARGO_PKG_VERSION") },
                "instructions": "OpenKiwi-managed sub-agent delegation. This server is the authoritative delegation route while attached: use spawn_agent to run work on an approved OpenKiwi destination, then agent_status and collect_agent to read its result or cancel_agent to stop it. Do not use provider-native task, team, or agent-spawning tools.",
            }
        }))),
        "ping" => Some(Some(json!({ "jsonrpc": "2.0", "id": id, "result": {} }))),
        "tools/list" | "tools/call" => None,
        other => Some(Some(mcp_error(
            id,
            -32601,
            &format!("`{other}` is not supported by the OpenKiwi bridge"),
        ))),
    }
}

/// Handle one JSON-RPC line. Returns the response to write, or None for a
/// notification.
async fn bridge_handle(
    client: &reqwest::Client,
    config: &BridgeSessionFile,
    message: Value,
) -> Option<Value> {
    let method = message.get("method").and_then(Value::as_str).unwrap_or("");
    if let Some(response) = bridge_local_response(method, message.get("id")) {
        return response;
    }
    let id = message.get("id").cloned().unwrap_or(Value::Null);

    match method {
        "tools/list" => {
            let body = json!({ "session": config.session_token, "method": "describe" });
            match bridge_post(client, config, body).await {
                Ok(result) => Some(json!({ "jsonrpc": "2.0", "id": id, "result": result })),
                Err(error) => Some(mcp_error(id, -32603, &error)),
            }
        }
        "tools/call" => {
            let params = message.get("params").cloned().unwrap_or_else(|| json!({}));
            let body = json!({
                "session": config.session_token,
                "method": "call",
                "tool": params.get("name").and_then(Value::as_str).unwrap_or_default(),
                "arguments": params.get("arguments").cloned().unwrap_or_else(|| json!({})),
            });
            let result = match bridge_post(client, config, body).await {
                Ok(result) => mcp_tool_result(&result, false),
                // Tool failures are results, not protocol errors: the model
                // needs to read the reason and choose differently.
                Err(error) => mcp_tool_result(&json!({ "error": error }), true),
            };
            Some(json!({ "jsonrpc": "2.0", "id": id, "result": result }))
        }
        // `bridge_local_response` already answered everything else.
        _ => None,
    }
}

/// Entry point for `openkiwi --openkiwi-agent-bridge <session file>`: a stdio
/// MCP server that forwards to the running OpenKiwi app. Never touches Tauri,
/// so no window, dock icon, or app state is created.
pub(super) fn run_agent_bridge(session_path: &str) -> i32 {
    let Ok(runtime) = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    else {
        return 1;
    };
    runtime.block_on(async move {
        let Ok(raw) = tokio::fs::read_to_string(session_path).await else {
            return 1;
        };
        let Ok(config) = serde_json::from_str::<BridgeSessionFile>(&raw) else {
            return 1;
        };
        let Ok(client) = reqwest::Client::builder()
            .timeout(Duration::from_secs(420))
            .build()
        else {
            return 1;
        };
        let mut lines = BufReader::new(tokio::io::stdin()).lines();
        let mut stdout = tokio::io::stdout();
        while let Ok(Some(line)) = lines.next_line().await {
            if line.trim().is_empty() {
                continue;
            }
            let response = match serde_json::from_str::<Value>(&line) {
                Ok(message) => bridge_handle(&client, &config, message).await,
                Err(error) => Some(mcp_error(
                    Value::Null,
                    -32700,
                    &format!("Unparseable request: {error}"),
                )),
            };
            let Some(response) = response else { continue };
            if stdout
                .write_all(format!("{response}\n").as_bytes())
                .await
                .is_err()
                || stdout.flush().await.is_err()
            {
                break;
            }
        }
        0
    })
}
