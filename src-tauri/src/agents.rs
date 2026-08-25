//! Cross-provider sub-agents.
//!
//! Every provider runtime Mythra Code drives can only delegate to itself: the
//! Codex app server spawns Codex children, Claude Code spawns Claude
//! sub-agents, and Cursor has no delegation surface at all. To let a root
//! agent delegate *across* providers, Mythra Code exposes its own delegation
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
//!                             Mythra Code backend ──Tauri event──▶ webview
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
const TOOL_PROPOSE_SETTINGS: &str = "propose_agent_settings";
pub(super) const AGENT_BRIDGE_TOOLS: [&str; 5] = [
    TOOL_SPAWN,
    TOOL_STATUS,
    TOOL_COLLECT,
    TOOL_CANCEL,
    TOOL_PROPOSE_SETTINGS,
];

/// How long the backend waits for the webview to answer a delegation request.
/// A cold provider start can take longer than an MCP client's own tool wait.
/// Keep its reservation alive so a late successful response is still recorded
/// and discoverable through `agent_status`, instead of orphaning the child.
const RELAY_TIMEOUT: Duration = Duration::from_secs(60);
const SPAWN_RELAY_TIMEOUT: Duration = Duration::from_secs(300);
const COLLECT_RELAY_TIMEOUT: Duration = Duration::from_secs(360);
/// How long a timed-out spawn's reservation survives waiting for the webview's
/// late answer before the slot is released as abandoned.
const LATE_SPAWN_GRACE: Duration = Duration::from_secs(600);

const MAX_PROMPT_BYTES: usize = 32_768;
const MAX_TITLE_BYTES: usize = 200;
const MAX_TARGETS: usize = 24;
/// Hard ceiling on concurrent cross-provider children, mirroring the
/// sub-agent maximum the composer already enforces.
const MAX_CONCURRENT_CEILING: usize = 24;

pub(super) fn agent_bridge_providers() -> [&'static str; 5] {
    ["openai", "openrouter", "lmstudio", "claude", "cursor"]
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
                "`{}` is not a provider Mythra Code can start.",
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
type RelayPayload = Result<Value, String>;

/// Every relay transition lives under one mutex so a webview response cannot
/// fall between separate "pending" and "late spawn" registries.
enum PendingRelay {
    Waiting(oneshot::Sender<RelayPayload>),
    TimedOutSpawn(Arc<ChildAgentSession>),
    AnsweredAfterTimeout(RelayPayload),
}

type PendingRelays = Arc<Mutex<HashMap<String, PendingRelay>>>;

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
        .map_err(|error| format!("Could not resolve Mythra Code app data: {error}"))?
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
pub(super) fn tool_catalog(targets: &[ChildAgentTarget], max_concurrent: usize) -> Value {
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
    let child_plural = if max_concurrent == 1 { "" } else { "s" };

    let catalog = json!([
        {
            "name": TOOL_SPAWN,
            "title": "Spawn a sub-agent",
            "description": format!(
                "Mythra Code is the only permitted sub-agent system for this thread; provider-native task, team, and agent spawning is not allowed. \
                 Start a child agent on one of the destinations Mythra Code approved for this thread. \
                 At most {max_concurrent} child agent{child_plural} may run concurrently. \
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
                        "description": "Optional short label shown in the Mythra Code timeline.",
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
            "description": "Interrupt a running child. Its partial work stays visible in the Mythra Code timeline.",
            "inputSchema": {
                "type": "object",
                "properties": { "childId": { "type": "string" } },
                "required": ["childId"],
                "additionalProperties": false,
            },
        },
        {
            "name": TOOL_PROPOSE_SETTINGS,
            "title": "Propose project sub-agent settings",
            "description": "Queue a user approval prompt for changing this project's Mythra Code sub-agent crew. This returns as soon as the prompt is queued, not when it is approved: never claim the change was applied. Approved changes update project defaults for subsequent runs; the current turn's security-frozen destination list does not change mid-flight.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "reason": { "type": "string", "description": "Short explanation of why this project needs the change." },
                    "enabled": { "type": "boolean" },
                    "crossProviderEnabled": { "type": "boolean" },
                    "maxConcurrent": { "type": "integer", "minimum": 1, "maximum": MAX_CONCURRENT_CEILING },
                    "targets": {
                        "type": "array",
                        "maxItems": MAX_TARGETS,
                        "description": "Optional full replacement crew. Omit to keep the current crew.",
                        "items": {
                            "type": "object",
                            "properties": {
                                "id": { "type": "string" },
                                "provider": { "type": "string", "enum": agent_bridge_providers() },
                                "model": { "type": "string" },
                                "label": { "type": "string" },
                                "description": { "type": "string" },
                                "reasoningMode": { "type": "string", "enum": ["inherit", "fixed", "agent"] },
                                "reasoningEffort": { "type": "string", "enum": REASONING_EFFORTS },
                                "reasoningMaxEffort": { "type": "string", "enum": REASONING_EFFORTS },
                            },
                            "required": ["id", "provider", "model", "label", "reasoningMode"],
                            "additionalProperties": false,
                        },
                    },
                },
                "required": ["reason"],
                "additionalProperties": false,
            },
        },
    ]);
    if targets.is_empty() {
        return Value::Array(
            catalog
                .as_array()
                .expect("tool catalog is an array")
                .iter()
                .filter(|tool| {
                    tool.get("name").and_then(Value::as_str) == Some(TOOL_PROPOSE_SETTINGS)
                })
                .cloned()
                .collect(),
        );
    }
    catalog
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
        TOOL_PROPOSE_SETTINGS => {
            let reason = text("reason").trim();
            if reason.is_empty() || reason.len() > 400 {
                return Err("`reason` is required and limited to 400 bytes.".into());
            }
            if let Some(enabled) = object.get("enabled") {
                if !enabled.is_boolean() {
                    return Err("`enabled` must be true or false.".into());
                }
            }
            if let Some(enabled) = object.get("crossProviderEnabled") {
                if !enabled.is_boolean() {
                    return Err("`crossProviderEnabled` must be true or false.".into());
                }
            }
            if let Some(max) = object.get("maxConcurrent") {
                let max = max
                    .as_u64()
                    .ok_or_else(|| "`maxConcurrent` must be an integer.".to_string())?;
                if !(1..=MAX_CONCURRENT_CEILING as u64).contains(&max) {
                    return Err(format!(
                        "`maxConcurrent` must be between 1 and {MAX_CONCURRENT_CEILING}."
                    ));
                }
            }
            if let Some(targets) = object.get("targets") {
                let targets: Vec<ChildAgentTarget> = serde_json::from_value(targets.clone())
                    .map_err(|error| format!("The proposed crew is invalid: {error}"))?;
                validate_targets(&targets)?;
            }
            Ok(())
        }
        other => Err(format!("`{other}` is not a sub-agent tool.")),
    }
}

enum RelayOutcome {
    Answered(Result<Value, String>),
    /// The webview did not answer within the tool's deadline; the request id
    /// identifies the still-pending relay so a spawn can atomically change its
    /// registry entry from a waiter into a reserved late spawn.
    TimedOut {
        request_id: String,
    },
}

async fn relay_to_app_inner(
    state: &BridgeHttpState,
    session: &ChildAgentSession,
    tool: &str,
    arguments: Value,
) -> RelayOutcome {
    let request_id = uuid::Uuid::new_v4().to_string();
    let (sender, receiver) = oneshot::channel();
    state
        .pending
        .lock()
        .await
        .insert(request_id.clone(), PendingRelay::Waiting(sender));
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
        return RelayOutcome::Answered(Err(format!(
            "Mythra Code could not dispatch the request: {error}"
        )));
    }
    let wait = match tool {
        TOOL_SPAWN => SPAWN_RELAY_TIMEOUT,
        TOOL_COLLECT => COLLECT_RELAY_TIMEOUT,
        _ => RELAY_TIMEOUT,
    };
    match timeout(wait, receiver).await {
        Ok(Ok(result)) => {
            // The responder keeps a registry copy until the receiver confirms
            // it won the deadline race. Remove that backup only now.
            state.pending.lock().await.remove(&request_id);
            RelayOutcome::Answered(result)
        }
        Ok(Err(_)) => {
            state.pending.lock().await.remove(&request_id);
            RelayOutcome::Answered(Err(
                "Mythra Code stopped tracking this request before it completed.".into(),
            ))
        }
        Err(_) => RelayOutcome::TimedOut { request_id },
    }
}

async fn relay_to_app(
    state: &BridgeHttpState,
    session: &ChildAgentSession,
    tool: &str,
    arguments: Value,
) -> Result<Value, String> {
    match relay_to_app_inner(state, session, tool, arguments).await {
        RelayOutcome::Answered(result) => result,
        RelayOutcome::TimedOut { request_id } => {
            state.pending.lock().await.remove(&request_id);
            Err("Mythra Code did not answer the sub-agent request in time.".into())
        }
    }
}

async fn settle_spawn_response(session: Arc<ChildAgentSession>, payload: &RelayPayload) {
    let mut runtime = session.runtime.lock().await;
    runtime.reserved = runtime.reserved.saturating_sub(1);
    if let Ok(value) = payload {
        record_spawned_child(&mut runtime, value);
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

    match relay_to_app_inner(state, session, tool, relayed).await {
        RelayOutcome::Answered(result) => {
            let mut runtime = session.runtime.lock().await;
            runtime.reserved = runtime.reserved.saturating_sub(1);
            // A refused or failed spawn leaves no child behind, so only a
            // successful one takes a lasting slot.
            if let Ok(value) = &result {
                record_spawned_child(&mut runtime, value);
            }
            result
        }
        RelayOutcome::TimedOut { request_id } => {
            // Keep the reservation and the pending relay alive: a cold provider
            // start can outlast the MCP wait yet still succeed, and dropping it
            // here would orphan the child and free a slot it occupies. The
            // webview's late answer settles both through `child_agent_respond`;
            // a grace timer releases the slot if that answer never comes.
            let (answer_after_timeout, parked) = {
                let mut pending = state.pending.lock().await;
                match pending.remove(&request_id) {
                    Some(PendingRelay::Waiting(_sender)) => {
                        pending.insert(
                            request_id.clone(),
                            PendingRelay::TimedOutSpawn(session.clone()),
                        );
                        (None, true)
                    }
                    Some(PendingRelay::AnsweredAfterTimeout(payload)) => (Some(payload), false),
                    Some(entry @ PendingRelay::TimedOutSpawn(_)) => {
                        pending.insert(request_id.clone(), entry);
                        (None, true)
                    }
                    None => (None, false),
                }
            };
            if let Some(payload) = answer_after_timeout {
                settle_spawn_response(session.clone(), &payload).await;
                return payload;
            }
            if !parked {
                let mut runtime = session.runtime.lock().await;
                runtime.reserved = runtime.reserved.saturating_sub(1);
                return Err(
                    "Mythra Code lost the spawn acknowledgement at its timeout boundary. Check `agent_status` before retrying so a slow start is not duplicated."
                        .into(),
                );
            }

            let pending = state.pending.clone();
            tokio::spawn(async move {
                tokio::time::sleep(LATE_SPAWN_GRACE).await;
                let abandoned = {
                    let mut pending = pending.lock().await;
                    match pending.remove(&request_id) {
                        Some(PendingRelay::TimedOutSpawn(session)) => Some(session),
                        Some(entry) => {
                            pending.insert(request_id, entry);
                            None
                        }
                        None => None,
                    }
                };
                if let Some(session) = abandoned {
                    let mut runtime = session.runtime.lock().await;
                    runtime.reserved = runtime.reserved.saturating_sub(1);
                }
            });
            Err(
                "Mythra Code did not confirm the spawn in time. It may still be starting; check `agent_status` before retrying so a slow start is not duplicated.".into(),
            )
        }
    }
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
            json!({ "ok": true, "result": { "tools": tool_catalog(&session.targets, session.max_concurrent) } }),
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
        .map_err(|error| format!("Could not resolve the Mythra Code executable: {error}"))?
        .to_string_lossy()
        .to_string();
    let session_argument = session_path.to_string_lossy().to_string();
    let launch = ChildAgentBridgeLaunch {
        name: AGENT_BRIDGE_SERVER.to_string(),
        command: executable.clone(),
        args: vec![AGENT_BRIDGE_ARG.to_string(), session_argument.clone()],
        config_path: directory.join("mcp.json").to_string_lossy().to_string(),
        tool_names: if options.targets.is_empty() {
            vec![TOOL_PROPOSE_SETTINGS.to_string()]
        } else {
            AGENT_BRIDGE_TOOLS
                .iter()
                .map(|tool| (*tool).to_string())
                .collect()
        },
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

async fn route_relay_response(
    pending: &PendingRelays,
    request_id: String,
    payload: RelayPayload,
) -> Option<(Arc<ChildAgentSession>, RelayPayload)> {
    let mut pending = pending.lock().await;
    match pending.remove(&request_id) {
        Some(PendingRelay::Waiting(sender)) => {
            // Keep a registry copy even when `send` succeeds: the timeout can
            // still win at the exact polling boundary after delivery. The
            // receiver removes this backup only after it observes the answer;
            // otherwise dispatch consumes it as a late response.
            let backup = payload.clone();
            let retained = sender.send(payload).err().unwrap_or(backup);
            pending.insert(request_id, PendingRelay::AnsweredAfterTimeout(retained));
            None
        }
        Some(PendingRelay::TimedOutSpawn(session)) => Some((session, payload)),
        Some(entry @ PendingRelay::AnsweredAfterTimeout(_)) => {
            // Ignore a duplicate response without discarding the first
            // answer that dispatch still needs to consume.
            pending.insert(request_id, entry);
            None
        }
        None => None,
    }
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
    let payload = match error {
        Some(message) if !message.trim().is_empty() => Err(message),
        _ => Ok(result.unwrap_or_else(|| json!({}))),
    };
    let late_spawn = route_relay_response(&state.pending, request_id, payload).await;
    if let Some((session, payload)) = late_spawn {
        settle_spawn_response(session, &payload).await;
    }
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
        .map_err(|error| format!("Mythra Code is not reachable: {error}"))?;
    let status = response.status();
    let payload: Value = response
        .json()
        .await
        .map_err(|error| format!("Mythra Code returned an unreadable response: {error}"))?;
    if !status.is_success() {
        return Err(payload
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("Mythra Code rejected the sub-agent request")
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
                "instructions": "Mythra Code project sub-agent controls. Use propose_agent_settings when the user asks to change this project's crew, even when delegation is currently off; never claim a proposed change was applied until the user approves it. When spawn_agent is available, it is the authoritative delegation route: collect every child result, recover a failed child at most twice, and do not use provider-native task, team, or agent-spawning tools.",
            }
        }))),
        "ping" => Some(Some(json!({ "jsonrpc": "2.0", "id": id, "result": {} }))),
        "tools/list" | "tools/call" => None,
        other => Some(Some(mcp_error(
            id,
            -32601,
            &format!("`{other}` is not supported by the Mythra Code bridge"),
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
/// MCP server that forwards to the running Mythra Code app. Never touches Tauri,
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

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn response_after_receiver_timeout_is_preserved_for_dispatch() {
        let pending: PendingRelays = Arc::new(Mutex::new(HashMap::new()));
        let (sender, receiver) = oneshot::channel();
        drop(receiver);
        pending
            .lock()
            .await
            .insert("request".into(), PendingRelay::Waiting(sender));

        let payload = Ok(json!({ "threadId": "child" }));
        assert!(route_relay_response(&pending, "request".into(), payload)
            .await
            .is_none());

        let registry = pending.lock().await;
        let Some(PendingRelay::AnsweredAfterTimeout(Ok(answer))) = registry.get("request") else {
            panic!("late answer was not retained");
        };
        assert_eq!(answer.get("threadId"), Some(&json!("child")));
    }

    #[tokio::test]
    async fn delivered_response_stays_backed_up_until_receiver_acknowledges_it() {
        let pending: PendingRelays = Arc::new(Mutex::new(HashMap::new()));
        let (sender, receiver) = oneshot::channel();
        pending
            .lock()
            .await
            .insert("request".into(), PendingRelay::Waiting(sender));

        let payload = Ok(json!({ "threadId": "child" }));
        assert!(route_relay_response(&pending, "request".into(), payload)
            .await
            .is_none());
        assert_eq!(
            receiver.await.expect("receive response"),
            Ok(json!({ "threadId": "child" }))
        );
        assert!(matches!(
            pending.lock().await.get("request"),
            Some(PendingRelay::AnsweredAfterTimeout(Ok(_)))
        ));
    }
}
