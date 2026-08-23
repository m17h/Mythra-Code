use std::{
    collections::{HashMap, HashSet},
    env,
    ffi::OsString,
    fs,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        atomic::{AtomicBool, AtomicI64, Ordering},
        Arc,
    },
    time::UNIX_EPOCH,
};

use axum::{
    body::{Body, Bytes},
    extract::State as AxumState,
    http::{header, HeaderMap, Method, Response, StatusCode, Uri},
    routing::any,
    Router,
};
use rusqlite::params;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, Command},
    sync::{oneshot, Mutex},
    time::{timeout, timeout_at, Duration, Instant},
};

mod agents;
mod cursor;
mod github;
mod persistence;
mod process_launch;
mod project_git;
mod skills;
#[cfg(test)]
use agents::{
    bridge_local_response, tokens_match, tool_catalog, validate_targets, validate_tool_call,
    ChildAgentTarget, AGENT_BRIDGE_SERVER, AGENT_BRIDGE_TOOLS,
};
use agents::{
    child_agent_bridge_config_registered, child_agent_finished, child_agent_respond,
    child_agent_session_end, child_agent_session_start, purge_stale_agent_bridges,
    run_agent_bridge, shutdown_agent_bridges_on_exit, ChildAgentState, AGENT_BRIDGE_ARG,
};
use cursor::{
    cursor_login, cursor_models, cursor_permission_respond, cursor_runtime_status,
    cursor_turn_active, cursor_turn_interrupt, cursor_turn_kill, cursor_turn_start,
    cursor_turn_steer, shutdown_cursor_on_exit, CursorState,
};
use github::{
    github_attach_remote, github_clone_repository, github_create_repository, github_login,
    github_repo_status, github_status,
};
#[cfg(test)]
use github::{
    github_attach_remote_sync, github_repo_status_sync, parse_github_repository,
    validate_github_repository_name,
};
use persistence::{
    lock_state_db, open_state_db, shared_state_db, state_db_path, state_delete, state_read,
    state_write, StateDb,
};
use process_launch::{background_command, background_std_command};
#[cfg(windows)]
use process_launch::interactive_command;
#[cfg(test)]
use project_git::*;
use project_git::{
    checkpoint_complete, checkpoint_create, checkpoint_delete, checkpoint_diff, checkpoint_restore,
    git_common_dir, git_stdout, optional_git_stdout, unix_timestamp_ms, workspace_git_info,
    workspace_git_initialize, worktree_apply_to_source, worktree_create, worktree_merge_branch,
    worktree_recreate, worktree_remove, worktree_set_applied_baseline, worktree_status,
};
#[cfg(test)]
use skills::*;
use skills::{
    local_skills_create, local_skills_delete, local_skills_import, local_skills_read,
    local_skills_scan, local_skills_sync, local_skills_update, normalize_skill_name,
};

const KEYRING_SERVICE: &str = "com.kiwi.harness";
const OPENROUTER_ACCOUNT: &str = "openrouter-api-key";
const LMSTUDIO_ACCOUNT: &str = "lmstudio-api-key";

type PendingMap = Arc<Mutex<HashMap<i64, oneshot::Sender<Result<Value, String>>>>>;

struct AppServer {
    stdin: Mutex<ChildStdin>,
    child: Arc<Mutex<Child>>,
    pid: Option<u32>,
    /// Identity of this exact app-server process. A restart — deliberate or
    /// after a crash — produces a new one, and every thread the old process
    /// had loaded is gone with it. The webview keys its record of "what this
    /// thread's runtime was last configured with" on this value, because
    /// startup-only config is only honoured for a thread that is not loaded.
    instance: String,
    pending: PendingMap,
    next_id: AtomicI64,
    alive: Arc<AtomicBool>,
    /// Ids of server-initiated requests this exact instance is waiting on.
    /// `codex_respond` consults it so a response can never be sent to a
    /// different (respawned) server than the one that asked.
    server_requests: Arc<Mutex<HashSet<String>>>,
    openrouter_proxy_url: Option<String>,
    openrouter_proxy_task: Option<tokio::task::JoinHandle<()>>,
}

#[derive(Default)]
struct RuntimeState {
    server: Mutex<Option<Arc<AppServer>>>,
    /// Pid of the most recently spawned app-server child. Unlike `server`,
    /// this is always accessible without awaiting the async mutex, so the
    /// exit handler can still tear the process tree down while `ensure_server`
    /// holds the lock during a slow spawn/initialize.
    server_pid: std::sync::Mutex<Option<u32>>,
}

/// Kill a provider child and all of its descendants. Provider children are
/// spawned in their own process group on unix, so signalling the negative
/// pgid reaches the whole tree; `taskkill /T` walks the tree on Windows.
/// Falls back to the pid itself if the group signal fails (for example when
/// the child never became a group leader).
fn kill_process_tree(pid: u32) {
    #[cfg(unix)]
    {
        let killed_group = background_std_command("kill")
            .args(["-9", "--", &format!("-{pid}")])
            .status()
            .map(|status| status.success())
            .unwrap_or(false);
        if !killed_group {
            let _ = background_std_command("kill")
                .args(["-9", &pid.to_string()])
                .status();
        }
    }
    #[cfg(windows)]
    {
        let _ = background_std_command("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .status();
    }
}

#[derive(Default)]
struct ClaudeState {
    turns: Arc<Mutex<HashMap<String, Arc<ClaudeTurn>>>>,
    authenticated: AtomicBool,
}

/// How long a cooperative interrupt gets to unwind before the Claude process
/// is force-killed. Generous enough for the CLI to finish an in-flight tool
/// call and emit its `result`, short enough that a wedged process cannot hold
/// the thread's slot indefinitely.
const CLAUDE_INTERRUPT_GRACE: Duration = Duration::from_secs(10);

struct ClaudeTurn {
    stdin: Mutex<ChildStdin>,
    child: Arc<Mutex<Child>>,
    pid: Option<u32>,
    alive: Arc<AtomicBool>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ClaudeRuntimeStatus {
    available: bool,
    path: Option<String>,
    version: Option<String>,
    logged_in: bool,
    auth_method: Option<String>,
    email: Option<String>,
    subscription_type: Option<String>,
    warning: Option<String>,
}

#[derive(Serialize, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
struct ClaudeUsageWindow {
    label: String,
    used_percent: f64,
    /// Claude Code formats the reset in the user's own timezone. Keep that
    /// official display text instead of guessing at a locale-specific date.
    reset_label: Option<String>,
}

#[derive(Serialize, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
struct ClaudeUsageLimits {
    windows: Vec<ClaudeUsageWindow>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClaudeAttachment {
    path: String,
    kind: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClaudeAgentInput {
    name: String,
    description: String,
    instructions: String,
    model: Option<String>,
    enabled: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClaudeTurnOptions {
    thread_id: String,
    cwd: String,
    prompt: String,
    model: String,
    effort: String,
    permission: String,
    system_prompt: String,
    resume: bool,
    attachments: Vec<ClaudeAttachment>,
    subagent_max: usize,
    custom_agents: Vec<ClaudeAgentInput>,
    skills_plugin_path: Option<String>,
    /// Path to the cross-provider delegation MCP configuration, present only
    /// for a root thread whose policy allows spawning on other providers.
    #[serde(default)]
    child_agent_bridge_config: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ClaudeTurnStarted {
    turn_id: String,
}

impl ClaudeTurn {
    async fn write(&self, message: &Value) -> Result<(), String> {
        if !self.alive.load(Ordering::Acquire) {
            return Err("This Claude turn is no longer running".into());
        }
        let mut stdin = self.stdin.lock().await;
        stdin
            .write_all(format!("{message}\n").as_bytes())
            .await
            .map_err(|error| format!("Could not write to Claude Code: {error}"))?;
        stdin
            .flush()
            .await
            .map_err(|error| format!("Could not flush Claude Code input: {error}"))
    }

    async fn shutdown(&self) {
        self.alive.store(false, Ordering::Release);
        if let Some(pid) = self.pid {
            kill_process_tree(pid);
        }
        let _ = self.child.lock().await.kill().await;
    }

    async fn close_input(&self) {
        self.alive.store(false, Ordering::Release);
        let _ = self.stdin.lock().await.shutdown().await;
    }
}

/// How much provider stderr is retained per turn. Only the tail is ever
/// surfaced to the user, so a chatty process cannot grow memory without limit.
const CLAUDE_STDERR_TAIL_BYTES: usize = 16 * 1024;

/// Bounded tail of a child process's output: keeps only the newest bytes.
struct TailBuffer {
    limit: usize,
    text: String,
}

impl TailBuffer {
    fn new(limit: usize) -> Self {
        Self {
            limit,
            text: String::new(),
        }
    }

    fn push_line(&mut self, line: &str) {
        if !self.text.is_empty() {
            self.text.push('\n');
        }
        self.text.push_str(line);
        if self.text.len() > self.limit {
            let excess = self.text.len() - self.limit;
            let cut = (excess..self.text.len())
                .find(|index| self.text.is_char_boundary(*index))
                .unwrap_or(self.text.len());
            self.text.drain(..cut);
        }
    }

    fn contents(&self) -> &str {
        &self.text
    }
}

/// Claim the per-thread turn slot for a freshly spawned process. The
/// pre-spawn "already working" check races with concurrent starts, so this
/// re-checks under the lock at insert time: without it, a second start would
/// silently evict a live turn's handle, leaving its process running but
/// unkillable. Returns false when a different live turn holds the slot; the
/// caller must then kill the process it just spawned.
async fn claim_turn_slot<T>(
    turns: &Arc<Mutex<HashMap<String, Arc<T>>>>,
    thread_id: &str,
    turn: &Arc<T>,
    is_live: impl Fn(&T) -> bool,
) -> bool {
    let mut turns = turns.lock().await;
    if turns
        .get(thread_id)
        .is_some_and(|existing| !Arc::ptr_eq(existing, turn) && is_live(existing))
    {
        return false;
    }
    turns.insert(thread_id.to_string(), turn.clone());
    true
}

async fn remove_claude_turn_if_current(
    turns: &Arc<Mutex<HashMap<String, Arc<ClaudeTurn>>>>,
    thread_id: &str,
    expected: &Arc<ClaudeTurn>,
) {
    let mut turns = turns.lock().await;
    let current = turns
        .get(thread_id)
        .is_some_and(|current| Arc::ptr_eq(current, expected));
    if current {
        turns.remove(thread_id);
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CodexRuntimeStatus {
    available: bool,
    source: Option<&'static str>,
    path: Option<String>,
    version: Option<String>,
    compatible: bool,
    warning: Option<String>,
}

impl AppServer {
    async fn request(&self, method: &str, params: Value) -> Result<Value, String> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (sender, receiver) = oneshot::channel();
        self.pending.lock().await.insert(id, sender);

        let request_timeout = if method == "command/exec" {
            params
                .get("timeoutMs")
                .and_then(Value::as_u64)
                .map(|milliseconds| Duration::from_millis(milliseconds.saturating_add(30_000)))
                .unwrap_or_else(|| Duration::from_secs(330))
        } else {
            Duration::from_secs(120)
        };

        let message = json!({ "method": method, "id": id, "params": params });
        let mut stdin = self.stdin.lock().await;
        if let Err(error) = stdin.write_all(format!("{}\n", message).as_bytes()).await {
            self.alive.store(false, Ordering::Release);
            self.pending.lock().await.remove(&id);
            return Err(format!("Could not write to Codex App Server: {error}"));
        }
        if let Err(error) = stdin.flush().await {
            self.alive.store(false, Ordering::Release);
            drop(stdin);
            self.pending.lock().await.remove(&id);
            return Err(format!("Could not flush Codex App Server input: {error}"));
        }
        drop(stdin);

        match timeout(request_timeout, receiver).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err("Codex App Server stopped before replying".into()),
            Err(_) => {
                self.pending.lock().await.remove(&id);
                Err(format!(
                    "Codex App Server timed out while handling {method}"
                ))
            }
        }
    }

    async fn notify(&self, method: &str, params: Value) -> Result<(), String> {
        let message = json!({ "method": method, "params": params });
        let mut stdin = self.stdin.lock().await;
        stdin
            .write_all(format!("{}\n", message).as_bytes())
            .await
            .map_err(|error| format!("Could not write notification: {error}"))?;
        stdin
            .flush()
            .await
            .map_err(|error| format!("Could not flush notification: {error}"))
    }

    async fn respond(&self, id: Value, result: Value) -> Result<(), String> {
        let message = json!({ "id": id, "result": result });
        let mut stdin = self.stdin.lock().await;
        stdin
            .write_all(format!("{}\n", message).as_bytes())
            .await
            .map_err(|error| format!("Could not write server response: {error}"))?;
        stdin
            .flush()
            .await
            .map_err(|error| format!("Could not flush server response: {error}"))
    }

    async fn shutdown(&self) {
        self.alive.store(false, Ordering::Release);
        if let Some(pid) = self.pid {
            kill_process_tree(pid);
        }
        let _ = self.child.lock().await.kill().await;
        if let Some(task) = &self.openrouter_proxy_task {
            task.abort();
        }
    }

    fn is_alive(&self) -> bool {
        self.alive.load(Ordering::Acquire)
    }
}

async fn openrouter_key() -> Option<String> {
    // Keyring calls can block on the OS credential store; keep them off the
    // async runtime worker threads.
    tauri::async_runtime::spawn_blocking(|| {
        let entry = keyring::Entry::new(KEYRING_SERVICE, OPENROUTER_ACCOUNT).ok()?;
        entry
            .get_password()
            .ok()
            .filter(|value| !value.trim().is_empty())
    })
    .await
    .ok()
    .flatten()
}

async fn lmstudio_key() -> Option<String> {
    tauri::async_runtime::spawn_blocking(|| {
        let entry = keyring::Entry::new(KEYRING_SERVICE, LMSTUDIO_ACCOUNT).ok()?;
        entry
            .get_password()
            .ok()
            .filter(|value| !value.trim().is_empty())
    })
    .await
    .ok()
    .flatten()
}

fn normalize_lmstudio_base_url(value: &str) -> Result<reqwest::Url, String> {
    let trimmed = value.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return Err("Enter the LM Studio server URL, for example http://127.0.0.1:1234/v1".into());
    }
    let normalized = if trimmed.to_ascii_lowercase().ends_with("/v1") {
        trimmed.to_string()
    } else {
        format!("{trimmed}/v1")
    };
    let mut url = reqwest::Url::parse(&normalized)
        .map_err(|_| "The LM Studio server URL is not valid.".to_string())?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("The LM Studio server URL must use http or https.".into());
    }
    if !url.username().is_empty() || url.password().is_some() || url.query().is_some() || url.fragment().is_some() {
        return Err("The LM Studio server URL cannot contain credentials, a query, or a fragment.".into());
    }
    if url.host_str().is_none() {
        return Err("The LM Studio server URL must include a host.".into());
    }
    url.set_query(None);
    url.set_fragment(None);
    Ok(url)
}

fn lmstudio_native_models_url(base_url: &reqwest::Url) -> reqwest::Url {
    let mut url = base_url.clone();
    let base_path = url.path().trim_end_matches('/');
    let prefix = base_path.strip_suffix("/v1").unwrap_or(base_path);
    url.set_path(&format!("{prefix}/api/v1/models"));
    url
}

fn normalize_lmstudio_model_catalog(value: &Value) -> Option<Value> {
    let models = value.get("models")?.as_array()?;
    let data = models
        .iter()
        .filter(|model| model.get("type").and_then(Value::as_str) == Some("llm"))
        .filter_map(|model| {
            let id = model.get("key").and_then(Value::as_str)?.trim();
            if id.is_empty() {
                return None;
            }
            Some(json!({
                "id": id,
                "object": "model",
                "name": model.get("display_name").and_then(Value::as_str).unwrap_or(id),
                "owned_by": model.get("publisher").and_then(Value::as_str).unwrap_or("LM Studio"),
                "context_length": model.get("max_context_length").and_then(Value::as_u64),
                "trained_for_tool_use": model.pointer("/capabilities/trained_for_tool_use").and_then(Value::as_bool),
                "reasoning": model.pointer("/capabilities/reasoning").cloned(),
            }))
        })
        .collect::<Vec<_>>();
    Some(json!({ "object": "list", "data": data }))
}

fn random_hex_token() -> Result<String, String> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes)
        .map_err(|error| format!("Could not generate a secure proxy token: {error}"))?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

#[derive(Clone)]
struct OpenRouterProxyState {
    client: reqwest::Client,
    api_key: String,
    path_token: String,
}

fn sanitize_json_schema(value: &mut Value) -> usize {
    let mut removed = 0;
    match value {
        Value::Array(items) => {
            for item in items {
                removed += sanitize_json_schema(item);
            }
        }
        Value::Object(object) => {
            for child in object.values_mut() {
                removed += sanitize_json_schema(child);
            }

            let property_names = object
                .get("properties")
                .and_then(Value::as_object)
                .map(|properties| properties.keys().cloned().collect::<HashSet<_>>());
            if object.contains_key("required") {
                match property_names {
                    Some(property_names) => {
                        if let Some(required) =
                            object.get_mut("required").and_then(Value::as_array_mut)
                        {
                            let before = required.len();
                            required.retain(|name| {
                                name.as_str()
                                    .is_some_and(|name| property_names.contains(name))
                            });
                            removed += before.saturating_sub(required.len());
                            if required.is_empty() {
                                object.remove("required");
                            }
                        } else {
                            object.remove("required");
                            removed += 1;
                        }
                    }
                    None => {
                        object.remove("required");
                        removed += 1;
                    }
                }
            }
        }
        _ => {}
    }
    removed
}

fn proxy_response(status: StatusCode, body: impl Into<Body>) -> Response<Body> {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
        .body(body.into())
        .unwrap_or_else(|_| Response::new(Body::empty()))
}

fn inject_openrouter_proxy_config(params: &mut Value, proxy_url: Option<&str>) {
    let Some(proxy_url) = proxy_url else { return };
    let Some(params) = params.as_object_mut() else {
        return;
    };
    if params.get("modelProvider").and_then(Value::as_str) != Some("openrouter") {
        return;
    }

    let config = params
        .entry("config")
        .or_insert_with(|| Value::Object(Default::default()));
    if !config.is_object() {
        *config = Value::Object(Default::default());
    }
    let config = config
        .as_object_mut()
        .expect("config was replaced with an object");
    let providers = config
        .entry("model_providers")
        .or_insert_with(|| Value::Object(Default::default()));
    if !providers.is_object() {
        *providers = Value::Object(Default::default());
    }
    let providers = providers
        .as_object_mut()
        .expect("model_providers was replaced with an object");
    let openrouter = providers
        .entry("openrouter")
        .or_insert_with(|| Value::Object(Default::default()));
    if !openrouter.is_object() {
        *openrouter = Value::Object(Default::default());
    }
    openrouter
        .as_object_mut()
        .expect("openrouter was replaced with an object")
        .insert("base_url".into(), Value::String(proxy_url.into()));
}

async fn proxy_openrouter_request(
    AxumState(state): AxumState<Arc<OpenRouterProxyState>>,
    method: Method,
    uri: Uri,
    headers: HeaderMap,
    body: Bytes,
) -> Response<Body> {
    let expected_prefix = format!("/{}", state.path_token);
    let Some(upstream_path) = uri.path().strip_prefix(&expected_prefix) else {
        return proxy_response(StatusCode::NOT_FOUND, "Not found");
    };
    if !upstream_path.is_empty() && !upstream_path.starts_with('/') {
        return proxy_response(StatusCode::NOT_FOUND, "Not found");
    }

    let mut upstream_url = format!(
        "https://openrouter.ai/api/v1{}",
        if upstream_path.is_empty() {
            "/"
        } else {
            upstream_path
        }
    );
    if let Some(query) = uri.query() {
        upstream_url.push('?');
        upstream_url.push_str(query);
    }

    let sanitized_body = match serde_json::from_slice::<Value>(&body) {
        Ok(mut json_body) => {
            sanitize_json_schema(&mut json_body);
            match serde_json::to_vec(&json_body) {
                Ok(body) => body,
                Err(error) => {
                    return proxy_response(
                        StatusCode::BAD_REQUEST,
                        format!("Could not prepare OpenRouter request: {error}"),
                    )
                }
            }
        }
        Err(_) => body.to_vec(),
    };

    let mut request = state
        .client
        .request(method, upstream_url)
        .bearer_auth(&state.api_key)
        .body(sanitized_body);
    for name in [
        header::ACCEPT,
        header::CONTENT_TYPE,
        header::USER_AGENT,
        header::HeaderName::from_static("http-referer"),
        header::HeaderName::from_static("x-title"),
    ] {
        if let Some(value) = headers.get(&name) {
            request = request.header(name, value);
        }
    }

    let upstream = match request.send().await {
        Ok(response) => response,
        Err(error) => {
            return proxy_response(
                StatusCode::BAD_GATEWAY,
                format!("Could not reach OpenRouter: {error}"),
            )
        }
    };
    let status = upstream.status();
    let upstream_headers = upstream.headers().clone();
    let mut response = Response::builder().status(status);
    for (name, value) in upstream_headers {
        let Some(name) = name else { continue };
        if name != header::CONTENT_LENGTH
            && name != header::TRANSFER_ENCODING
            && name != header::CONNECTION
        {
            response = response.header(name, value);
        }
    }
    response
        .body(Body::from_stream(upstream.bytes_stream()))
        .unwrap_or_else(|_| {
            proxy_response(
                StatusCode::BAD_GATEWAY,
                "Could not stream OpenRouter response",
            )
        })
}

async fn start_openrouter_proxy(
    api_key: String,
) -> Result<(String, tokio::task::JoinHandle<()>), String> {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|error| {
            format!("Could not start the OpenRouter compatibility service: {error}")
        })?;
    let address = listener
        .local_addr()
        .map_err(|error| format!("Could not read the OpenRouter compatibility address: {error}"))?;
    let path_token = random_hex_token()?;
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(20))
        .build()
        .map_err(|error| {
            format!("Could not create the OpenRouter compatibility client: {error}")
        })?;
    let state = Arc::new(OpenRouterProxyState {
        client,
        api_key,
        path_token: path_token.clone(),
    });
    let router = Router::new()
        .fallback(any(proxy_openrouter_request))
        .with_state(state);
    let task = tokio::spawn(async move {
        let _ = axum::serve(listener, router).await;
    });
    Ok((format!("http://{address}/{path_token}"), task))
}

const OPENROUTER_DEFAULT_BASE_URL: &str = "https://openrouter.ai/api/v1";

/// Configuration keys OpenKiwi re-asserts on every startup, as
/// `(section, key, value)` with TOML-encoded values. Everything else in
/// config.toml (model selection, MCP servers, …) belongs to the user and the
/// Codex runtime and is preserved verbatim.
fn managed_runtime_config(openrouter_base_url: &str) -> Vec<(&'static str, &'static str, String)> {
    let base_url = serde_json::to_string(openrouter_base_url)
        .unwrap_or_else(|_| format!("\"{OPENROUTER_DEFAULT_BASE_URL}\""));
    vec![
        ("", "cli_auth_credentials_store", "\"keyring\"".into()),
        ("", "project_doc_max_bytes", "0".into()),
        // The OpenKiwi bridge is the only spawning authority, so the native
        // agent runtime is pinned to a single non-nesting thread. Depth is
        // re-asserted alongside the thread ceiling: a stale or hand-edited
        // `max_depth` would otherwise let native delegation nest below a child.
        ("agents", "max_threads", "1".into()),
        ("agents", "max_depth", "1".into()),
        ("features", "multi_agent", "false".into()),
        ("features", "multi_agent_v2", "false".into()),
        ("model_providers.openrouter", "base_url", base_url),
    ]
}

/// Line-based TOML reconcile: re-asserts each managed `key = value` inside
/// its `[section]` while preserving every other line. Deliberately does not
/// pull in a TOML crate — the managed keys are all scalars in header-based
/// sections, which this handles conservatively. Returns None when the file
/// already matches.
fn reconcile_config_toml(existing: &str, managed: &[(&str, &str, String)]) -> Option<String> {
    let mut lines: Vec<String> = existing.lines().map(str::to_string).collect();
    let mut changed = false;

    for (section, key, value) in managed {
        let desired = format!("{key} = {value}");
        let mut section_start = None;
        let mut section_end = lines.len();
        if section.is_empty() {
            section_start = Some(0);
            section_end = lines
                .iter()
                .position(|line| line.trim_start().starts_with('['))
                .unwrap_or(lines.len());
        } else {
            let header = format!("[{section}]");
            for (index, line) in lines.iter().enumerate() {
                let trimmed = line.trim();
                if section_start.is_none() {
                    if trimmed == header {
                        section_start = Some(index + 1);
                    }
                } else if trimmed.starts_with('[') {
                    section_end = index;
                    break;
                }
            }
        }
        match section_start {
            Some(start) => {
                let existing_line = (start..section_end).find(|index| {
                    lines[*index]
                        .split_once('=')
                        .map(|(name, _)| name.trim() == *key)
                        .unwrap_or(false)
                });
                match existing_line {
                    Some(index) => {
                        if lines[index].trim() != desired {
                            lines[index] = desired;
                            changed = true;
                        }
                    }
                    None => {
                        // Append at the end of the section rather than the
                        // top, so several managed keys in one section keep the
                        // order they are declared in above. Inserting at the
                        // top reversed them, which is how `multi_agent_v2`
                        // landed before `multi_agent` in a freshly written
                        // `[features]`. Trailing blank separator lines are
                        // stepped over so the key stays inside its section.
                        let mut insert_at = section_end.min(lines.len());
                        while insert_at > start && lines[insert_at - 1].trim().is_empty() {
                            insert_at -= 1;
                        }
                        lines.insert(insert_at, desired);
                        changed = true;
                    }
                }
            }
            None => {
                if lines.last().is_some_and(|line| !line.trim().is_empty()) {
                    lines.push(String::new());
                }
                lines.push(format!("[{section}]"));
                lines.push(desired);
                changed = true;
            }
        }
    }

    changed.then(|| {
        let mut output = lines.join("\n");
        output.push('\n');
        output
    })
}

async fn write_runtime_config(
    codex_home: &PathBuf,
    openrouter_base_url: Option<&str>,
) -> Result<(), String> {
    tokio::fs::create_dir_all(codex_home)
        .await
        .map_err(|error| format!("Could not create OpenKiwi runtime directory: {error}"))?;

    let config_path = codex_home.join("config.toml");
    let base_url = openrouter_base_url.unwrap_or(OPENROUTER_DEFAULT_BASE_URL);
    let existing = match tokio::fs::read_to_string(&config_path).await {
        Ok(existing) => Some(existing),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => {
            return Err(format!(
                "Could not read OpenKiwi runtime configuration: {error}"
            ))
        }
    };

    let updated = match &existing {
        // Hardening keys must hold for existing profiles too, not only for
        // brand-new ones, so reconcile the managed keys on every startup.
        Some(existing) => reconcile_config_toml(existing, &managed_runtime_config(base_url)),
        None => {
            let base_url_toml = serde_json::to_string(base_url)
                .map_err(|error| format!("Could not encode the OpenRouter base URL: {error}"))?;
            Some(format!(
                r#"cli_auth_credentials_store = "keyring"
model_provider = "openai"
project_doc_max_bytes = 0
project_doc_fallback_filenames = []
developer_instructions = ""

[agents]
max_threads = 1
max_depth = 1

[features]
multi_agent = false
multi_agent_v2 = false

[model_providers.openrouter]
name = "OpenRouter"
base_url = {base_url_toml}
env_key = "OPENROUTER_API_KEY"
env_key_instructions = "Add your OpenRouter API key in OpenKiwi Settings."
wire_api = "responses"
"#
            ))
        }
    };

    if let Some(config) = updated {
        tokio::fs::write(&config_path, config)
            .await
            .map_err(|error| format!("Could not write OpenKiwi runtime configuration: {error}"))?;
    }
    // The OpenRouter proxy base URL embeds a secret path token; keep the file
    // readable by the current user only.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ =
            tokio::fs::set_permissions(&config_path, std::fs::Permissions::from_mode(0o600)).await;
    }
    Ok(())
}

#[cfg(not(windows))]
fn find_on_path(program: &str) -> Option<PathBuf> {
    env::var_os("PATH").and_then(|path| {
        env::split_paths(&path)
            .map(|directory| directory.join(program))
            .find(|candidate| candidate.is_file())
    })
}

/// Windows command discovery must honor registered app execution aliases.
/// Looking only for `PATH\\program.exe` misses packaged apps, while `where.exe`
/// uses the same resolution rules as a Windows terminal. Provider-specific npm
/// shims are resolved to their native binaries separately so user prompt text
/// never has to pass through `cmd.exe` parsing.
#[cfg(windows)]
fn find_on_path(program: &str) -> Option<PathBuf> {
    let output = background_std_command("where.exe")
        .arg(program)
        .output()
        .ok()?;
    output.status.success().then_some(())?;
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(PathBuf::from)
        .find(|candidate| candidate.is_file())
}

fn push_candidate(candidates: &mut Vec<PathBuf>, candidate: PathBuf) {
    if !candidates.contains(&candidate) {
        candidates.push(candidate);
    }
}

#[cfg(windows)]
fn push_windows_npm_codex_candidates_at(candidates: &mut Vec<PathBuf>, app_data: &Path) {
    let package = app_data.join("npm/node_modules/@openai/codex");
    for (platform_package, target) in [
        ("codex-win32-x64", "x86_64-pc-windows-msvc"),
        ("codex-win32-arm64", "aarch64-pc-windows-msvc"),
    ] {
        let vendor = package
            .join("node_modules/@openai")
            .join(platform_package)
            .join("vendor")
            .join(target);
        // Current Codex npm packages place the native executable in `bin`.
        // Keep the older layout as a fallback so existing installations keep
        // working when OpenKiwi is launched from Explorer with a stale PATH.
        push_candidate(candidates, vendor.join("bin/codex.exe"));
        push_candidate(candidates, vendor.join("codex/codex.exe"));
        push_candidate(
            candidates,
            package.join("vendor").join(target).join("bin/codex.exe"),
        );
        push_candidate(
            candidates,
            package.join("vendor").join(target).join("codex/codex.exe"),
        );
    }
}

#[cfg(windows)]
fn push_windows_npm_codex_candidates(candidates: &mut Vec<PathBuf>) {
    if let Some(app_data) = env::var_os("APPDATA").map(PathBuf::from) {
        push_windows_npm_codex_candidates_at(candidates, &app_data);
    }
}

#[cfg(windows)]
fn push_windows_npm_claude_candidates(candidates: &mut Vec<PathBuf>) {
    let Some(app_data) = env::var_os("APPDATA").map(PathBuf::from) else {
        return;
    };
    let package = app_data.join("npm/node_modules/@anthropic-ai/claude-code");
    push_candidate(candidates, package.join("bin/claude.exe"));
    for platform_package in ["claude-code-win32-x64", "claude-code-win32-arm64"] {
        push_candidate(
            candidates,
            package
                .join("node_modules/@anthropic-ai")
                .join(platform_package)
                .join("claude.exe"),
        );
    }
}

#[cfg(target_os = "macos")]
async fn find_with_login_shell(program: &str) -> Option<PathBuf> {
    let shell = env::var_os("SHELL").unwrap_or_else(|| OsString::from("/bin/zsh"));
    let output = background_command(shell)
        .args(["-lc", &format!("command -v {}", program)])
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
        .rev()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(PathBuf::from)
        .filter(|candidate| candidate.is_file())
}

#[cfg(not(target_os = "macos"))]
async fn find_with_login_shell(_program: &str) -> Option<PathBuf> {
    None
}

async fn resolve_codex_binary(app: &AppHandle) -> Result<PathBuf, String> {
    let mut candidates = Vec::new();
    let executable_name = if cfg!(windows) { "codex.exe" } else { "codex" };

    if let Some(override_path) = env::var_os("OPENKIWI_CODEX_PATH") {
        let override_path = PathBuf::from(override_path);
        return override_path.is_file().then_some(override_path).ok_or_else(|| {
            "OPENKIWI_CODEX_PATH does not point to a Codex executable. Update or remove it, then choose Try again.".into()
        });
    }

    #[cfg(windows)]
    push_windows_npm_codex_candidates(&mut candidates);

    if let Some(candidate) = find_on_path(executable_name) {
        push_candidate(&mut candidates, candidate);
    }

    #[cfg(target_os = "macos")]
    {
        push_candidate(
            &mut candidates,
            PathBuf::from("/Applications/ChatGPT.app/Contents/Resources/codex"),
        );
        push_candidate(&mut candidates, PathBuf::from("/opt/homebrew/bin/codex"));
        push_candidate(&mut candidates, PathBuf::from("/usr/local/bin/codex"));
    }

    if let Ok(home) = app.path().home_dir() {
        #[cfg(target_os = "macos")]
        push_candidate(
            &mut candidates,
            home.join("Applications/ChatGPT.app/Contents/Resources/codex"),
        );
        for relative in [
            ".local/bin/codex",
            ".local/bin/codex.exe",
            ".cargo/bin/codex",
            ".cargo/bin/codex.exe",
            ".npm-global/bin/codex",
            ".bun/bin/codex",
            ".volta/bin/codex",
        ] {
            push_candidate(&mut candidates, home.join(relative));
        }
    }

    #[cfg(windows)]
    for candidate in candidates.into_iter().filter(|candidate| candidate.is_file()) {
        // `where.exe` can expose protected WindowsApps resource paths that
        // exist but cannot be launched directly. Accept only a runtime that
        // successfully executes, then the later app-server spawn is reliable.
        if runtime_version(&candidate).await.is_some() {
            return Ok(candidate);
        }
    }
    #[cfg(not(windows))]
    if let Some(candidate) = candidates.into_iter().find(|candidate| candidate.is_file()) {
        return Ok(candidate);
    }
    if let Some(candidate) = find_with_login_shell(executable_name).await {
        return Ok(candidate);
    }

    Err("OpenKiwi could not find the Codex runtime. Install the Codex CLI or ChatGPT desktop app, then choose Try again. Advanced users can set OPENKIWI_CODEX_PATH to the Codex executable.".into())
}

fn runtime_source(path: &Path) -> &'static str {
    if path
        .to_string_lossy()
        .contains("ChatGPT.app/Contents/Resources/codex")
    {
        "ChatGPT app"
    } else if env::var_os("OPENKIWI_CODEX_PATH")
        .is_some_and(|configured| Path::new(&configured) == path)
    {
        "Custom path"
    } else {
        "Codex CLI"
    }
}

async fn runtime_version(path: &Path) -> Option<String> {
    let output = background_command(path)
        .arg("--version")
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .await
        .ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).trim().to_string())
        .filter(|value| !value.is_empty())
}

fn runtime_is_compatible(version: &str) -> bool {
    let number = version.split_whitespace().find(|part| {
        part.chars()
            .next()
            .is_some_and(|value| value.is_ascii_digit())
    });
    let mut components = number.unwrap_or_default().split(['.', '-']);
    let major = components
        .next()
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(0);
    let minor = components
        .next()
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(0);
    major > 0 || minor >= 145
}

#[tauri::command]
async fn codex_runtime_status(app: AppHandle) -> CodexRuntimeStatus {
    match resolve_codex_binary(&app).await {
        Ok(path) => {
            let version = runtime_version(&path).await;
            let compatible = version.as_deref().is_some_and(runtime_is_compatible);
            CodexRuntimeStatus {
                available: true,
                source: Some(runtime_source(&path)),
                path: Some(path.to_string_lossy().into_owned()),
                warning: (!compatible).then(|| "This Codex runtime predates OpenKiwi's tested App Server contract (0.145+). Update Codex before relying on advanced features.".to_string()),
                version,
                compatible,
            }
        }
        Err(error) => CodexRuntimeStatus {
            available: false,
            source: None,
            path: None,
            version: None,
            compatible: false,
            warning: Some(error),
        },
    }
}

async fn resolve_claude_binary(app: &AppHandle) -> Result<PathBuf, String> {
    let executable_name = if cfg!(windows) {
        "claude.exe"
    } else {
        "claude"
    };
    if let Some(override_path) = env::var_os("OPENKIWI_CLAUDE_PATH") {
        let override_path = PathBuf::from(override_path);
        return override_path.is_file().then_some(override_path).ok_or_else(|| {
            "OPENKIWI_CLAUDE_PATH does not point to a Claude Code executable. Update or remove it, then try again.".into()
        });
    }

    let mut candidates = Vec::new();
    #[cfg(windows)]
    push_windows_npm_claude_candidates(&mut candidates);
    if let Some(candidate) = find_on_path(executable_name) {
        push_candidate(&mut candidates, candidate);
    }
    #[cfg(target_os = "macos")]
    {
        push_candidate(&mut candidates, PathBuf::from("/opt/homebrew/bin/claude"));
        push_candidate(&mut candidates, PathBuf::from("/usr/local/bin/claude"));
    }
    if let Ok(home) = app.path().home_dir() {
        for relative in [
            ".local/bin/claude",
            ".local/bin/claude.exe",
            ".npm-global/bin/claude",
            ".bun/bin/claude",
            ".volta/bin/claude",
        ] {
            push_candidate(&mut candidates, home.join(relative));
        }
    }
    #[cfg(windows)]
    for candidate in candidates.into_iter().filter(|candidate| candidate.is_file()) {
        if runtime_version(&candidate).await.is_some() {
            return Ok(candidate);
        }
    }
    #[cfg(not(windows))]
    if let Some(candidate) = candidates.into_iter().find(|candidate| candidate.is_file()) {
        return Ok(candidate);
    }
    if let Some(candidate) = find_with_login_shell(executable_name).await {
        return Ok(candidate);
    }

    Err("OpenKiwi could not find Claude Code. Install Claude Code, sign in with `claude auth login`, then try again. Advanced users can set OPENKIWI_CLAUDE_PATH.".into())
}

fn configure_claude_subscription(command: &mut Command) {
    command
        .env_remove("ANTHROPIC_API_KEY")
        .env_remove("ANTHROPIC_AUTH_TOKEN")
        .env_remove("ANTHROPIC_BASE_URL")
        .env_remove("ANTHROPIC_CUSTOM_HEADERS")
        .env_remove("ANTHROPIC_DEFAULT_HAIKU_MODEL")
        .env_remove("ANTHROPIC_DEFAULT_OPUS_MODEL")
        .env_remove("ANTHROPIC_DEFAULT_SONNET_MODEL")
        .env_remove("CLAUDE_CODE_OAUTH_TOKEN")
        .env_remove("AWS_BEARER_TOKEN_BEDROCK")
        .env_remove("AWS_ACCESS_KEY_ID")
        .env_remove("AWS_SECRET_ACCESS_KEY")
        .env_remove("AWS_SESSION_TOKEN")
        .env_remove("AWS_PROFILE")
        .env_remove("GOOGLE_APPLICATION_CREDENTIALS")
        .env_remove("CLAUDE_CODE_USE_BEDROCK")
        .env_remove("CLAUDE_CODE_USE_VERTEX")
        .env_remove("CLAUDE_CODE_USE_FOUNDRY")
        .env_remove("ANTHROPIC_BEDROCK_BASE_URL")
        .env_remove("ANTHROPIC_VERTEX_BASE_URL")
        .env_remove("ANTHROPIC_VERTEX_PROJECT_ID")
        .env_remove("VERTEX_REGION_CLAUDE_3_5_SONNET")
        .env("COLUMNS", "1000")
        .env("NO_COLOR", "1");
}

fn subscription_only_command(path: &Path) -> Command {
    let mut command = background_command(path);
    configure_claude_subscription(&mut command);
    command
}

fn claude_credential_override_present() -> bool {
    [
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_AUTH_TOKEN",
        "ANTHROPIC_BASE_URL",
        "ANTHROPIC_CUSTOM_HEADERS",
        "CLAUDE_CODE_OAUTH_TOKEN",
        "CLAUDE_CODE_USE_BEDROCK",
        "CLAUDE_CODE_USE_VERTEX",
        "CLAUDE_CODE_USE_FOUNDRY",
    ]
    .iter()
    .any(|key| env::var_os(key).is_some())
}

fn parse_claude_auth_status(stdout: &[u8]) -> Option<Value> {
    serde_json::from_slice(stdout).ok().or_else(|| {
        let compact = String::from_utf8_lossy(stdout)
            .lines()
            .map(str::trim)
            .collect::<String>();
        serde_json::from_str(&compact).ok()
    })
}

fn parse_claude_usage_result(result: &str) -> ClaudeUsageLimits {
    let windows = result
        .lines()
        .filter_map(|line| {
            let (title, details) = line.trim().split_once(": ")?;
            let label = match title {
                "Current session" => "5h".to_string(),
                "Current week (all models)" => "Weekly".to_string(),
                title if title.starts_with("Current week (") && title.ends_with(')') => format!(
                    "Weekly {}",
                    title
                        .strip_prefix("Current week (")
                        .and_then(|value| value.strip_suffix(')'))
                        .unwrap_or("model")
                ),
                _ => return None,
            };
            let (percent, reset) = details.split_once("% used")?;
            let used_percent = percent.trim().parse::<f64>().ok()?.clamp(0.0, 100.0);
            let reset_label = reset
                .split_once("resets ")
                .map(|(_, value)| value.trim().to_string())
                .filter(|value| !value.is_empty());
            Some(ClaudeUsageWindow {
                label,
                used_percent,
                reset_label,
            })
        })
        .collect();
    ClaudeUsageLimits { windows }
}

#[tauri::command]
async fn claude_usage(app: AppHandle) -> Result<ClaudeUsageLimits, String> {
    let path = resolve_claude_binary(&app).await?;
    let output = timeout(
        Duration::from_secs(10),
        subscription_only_command(&path)
            .args([
                "--setting-sources",
                "",
                "-p",
                "/usage",
                "--output-format",
                "json",
                "--no-session-persistence",
                "--max-turns",
                "1",
                "--model",
                "haiku",
            ])
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .output(),
    )
    .await
    .map_err(|_| "Claude Code usage timed out".to_string())?
    .map_err(|error| format!("Could not start Claude Code usage: {error}"))?;
    if !output.status.success() {
        return Err("Claude Code could not read subscription usage".into());
    }
    let envelope = parse_claude_auth_status(&output.stdout)
        .ok_or_else(|| "Claude Code returned an unsupported usage response".to_string())?;
    let result = envelope
        .get("result")
        .and_then(Value::as_str)
        .ok_or_else(|| "Claude Code returned no subscription usage".to_string())?;
    let usage = parse_claude_usage_result(result);
    if usage.windows.is_empty() {
        return Err("Claude Code returned no active usage windows".into());
    }
    Ok(usage)
}

async fn read_claude_runtime_status(app: &AppHandle) -> ClaudeRuntimeStatus {
    let warning = claude_credential_override_present()
    .then(|| "OpenKiwi ignores Anthropic credential, proxy, and hosted-provider environment overrides for Claude subscription sessions, so this provider uses only your Claude Code login.".to_string());
    let path = match resolve_claude_binary(app).await {
        Ok(path) => path,
        Err(error) => {
            return ClaudeRuntimeStatus {
                available: false,
                path: None,
                version: None,
                logged_in: false,
                auth_method: None,
                email: None,
                subscription_type: None,
                warning: Some(error),
            };
        }
    };

    let version = runtime_version(&path).await;
    let auth = subscription_only_command(&path)
        .args(["--setting-sources", "", "auth", "status"])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .await
        .ok()
        .filter(|output| output.status.success())
        .and_then(|output| parse_claude_auth_status(&output.stdout));
    ClaudeRuntimeStatus {
        available: true,
        path: Some(path.to_string_lossy().into_owned()),
        version,
        logged_in: auth
            .as_ref()
            .and_then(|value| value.get("loggedIn"))
            .and_then(Value::as_bool)
            .unwrap_or(false),
        auth_method: auth
            .as_ref()
            .and_then(|value| value.get("authMethod"))
            .and_then(Value::as_str)
            .map(str::to_string),
        email: auth
            .as_ref()
            .and_then(|value| value.get("email"))
            .and_then(Value::as_str)
            .map(str::to_string),
        subscription_type: auth
            .as_ref()
            .and_then(|value| value.get("subscriptionType"))
            .and_then(Value::as_str)
            .map(str::to_string),
        warning,
    }
}

#[tauri::command]
async fn claude_runtime_status(
    app: AppHandle,
    state: State<'_, ClaudeState>,
) -> Result<ClaudeRuntimeStatus, String> {
    let status = read_claude_runtime_status(&app).await;
    state
        .authenticated
        .store(status.logged_in, Ordering::Release);
    Ok(status)
}

#[tauri::command]
async fn claude_login(app: AppHandle) -> Result<(), String> {
    let path = resolve_claude_binary(&app).await?;
    #[cfg(target_os = "macos")]
    {
        let escaped = path.to_string_lossy().replace('\'', "'\"'\"'");
        let login_command = format!("'{}' auth login", escaped);
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
            .map_err(|error| format!("Could not open Claude Code sign-in in Terminal: {error}"))?;
        status.success().then_some(()).ok_or_else(|| {
            "Could not open Terminal. Run `claude auth login` yourself, then refresh Claude status."
                .into()
        })
    }
    #[cfg(windows)]
    {
        let mut command = interactive_command(&path);
        configure_claude_subscription(&mut command);
        command
            .args(["auth", "login"])
            .stdin(Stdio::inherit())
            .stdout(Stdio::inherit())
            .stderr(Stdio::inherit())
            .spawn()
            .map(|_| ())
            .map_err(|error| {
                format!(
                    "Could not open Claude Code sign-in in a Windows terminal: {error}. Run `claude auth login` yourself, then refresh Claude status."
                )
            })
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        let _ = path;
        Err("Run `claude auth login` in a terminal, then refresh Claude status in OpenKiwi.".into())
    }
}

const PASTED_IMAGE_RETENTION_MS: i64 = 30 * 24 * 60 * 60 * 1_000;
const PASTED_IMAGE_CACHE_MAX_BYTES: u64 = 512 * 1024 * 1024;

#[derive(Clone, Debug)]
struct PastedImageCandidate {
    path: PathBuf,
    modified_at_ms: i64,
    size: u64,
}

fn pasted_image_removal_plan(
    mut candidates: Vec<PastedImageCandidate>,
    now_ms: i64,
    retention_ms: i64,
    max_total_bytes: u64,
    preserve: Option<&Path>,
) -> Vec<PathBuf> {
    candidates.sort_by_key(|candidate| candidate.modified_at_ms);
    let mut removed = HashSet::new();

    for candidate in &candidates {
        if preserve.is_some_and(|path| path == candidate.path) {
            continue;
        }
        if now_ms.saturating_sub(candidate.modified_at_ms) > retention_ms {
            removed.insert(candidate.path.clone());
        }
    }

    let mut total = candidates
        .iter()
        .filter(|candidate| !removed.contains(&candidate.path))
        .map(|candidate| candidate.size)
        .sum::<u64>();
    for candidate in &candidates {
        if total <= max_total_bytes {
            break;
        }
        if removed.contains(&candidate.path) || preserve.is_some_and(|path| path == candidate.path)
        {
            continue;
        }
        removed.insert(candidate.path.clone());
        total = total.saturating_sub(candidate.size);
    }

    candidates
        .into_iter()
        .filter_map(|candidate| removed.contains(&candidate.path).then_some(candidate.path))
        .collect()
}

fn cleanup_pasted_image_cache(directory: &Path, preserve: Option<&Path>) -> Result<(), String> {
    if !directory.exists() {
        return Ok(());
    }
    let mut candidates = Vec::new();
    for entry in fs::read_dir(directory)
        .map_err(|error| format!("Could not inspect the pasted-image cache: {error}"))?
    {
        let entry = entry.map_err(|error| format!("Could not inspect a pasted image: {error}"))?;
        let file_type = entry
            .file_type()
            .map_err(|error| format!("Could not inspect a pasted image: {error}"))?;
        let file_name = entry.file_name();
        if !file_type.is_file() || !file_name.to_string_lossy().starts_with("pasted-") {
            continue;
        }
        let metadata = entry
            .metadata()
            .map_err(|error| format!("Could not inspect a pasted image: {error}"))?;
        let modified_at_ms = metadata
            .modified()
            .ok()
            .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
            .and_then(|duration| duration.as_millis().try_into().ok())
            .unwrap_or_else(unix_timestamp_ms);
        candidates.push(PastedImageCandidate {
            path: entry.path(),
            modified_at_ms,
            size: metadata.len(),
        });
    }

    for path in pasted_image_removal_plan(
        candidates,
        unix_timestamp_ms(),
        PASTED_IMAGE_RETENTION_MS,
        PASTED_IMAGE_CACHE_MAX_BYTES,
        preserve,
    ) {
        fs::remove_file(path)
            .map_err(|error| format!("Could not clean up an expired pasted image: {error}"))?;
    }
    Ok(())
}

/// Persists an image pasted into the composer (which arrives as raw bytes,
/// not a file path) so it can be attached to a turn like any local image.
#[tauri::command]
async fn save_pasted_image(
    app: AppHandle,
    data_base64: String,
    extension: String,
) -> Result<String, String> {
    use base64::Engine as _;
    let safe_extension = match extension.as_str() {
        "png" | "jpg" | "jpeg" | "gif" | "webp" => extension.as_str(),
        _ => "png",
    };
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_base64.as_bytes())
        .map_err(|error| format!("Could not decode the pasted image: {error}"))?;
    if bytes.is_empty() {
        return Err("The pasted image was empty".to_string());
    }
    if bytes.len() > 50 * 1024 * 1024 {
        return Err("The pasted image exceeds 50 MB".to_string());
    }
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Could not resolve OpenKiwi app data: {error}"))?
        .join("pasted-images");
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|error| format!("Could not create the pasted-images folder: {error}"))?;
    let token = random_hex_token()?;
    let file = dir.join(format!(
        "pasted-{}-{}.{safe_extension}",
        unix_timestamp_ms(),
        &token[..8]
    ));
    tokio::fs::write(&file, &bytes)
        .await
        .map_err(|error| format!("Could not save the pasted image: {error}"))?;
    app.asset_protocol_scope()
        .allow_file(&file)
        .map_err(|error| format!("Could not prepare the pasted image preview: {error}"))?;
    let cleanup_directory = dir.clone();
    let preserved_file = file.clone();
    // Cleanup is best effort: a successfully saved paste must remain usable
    // even if an older cache entry cannot be removed.
    let _ = tauri::async_runtime::spawn_blocking(move || {
        cleanup_pasted_image_cache(&cleanup_directory, Some(&preserved_file))
    })
    .await;
    Ok(file.to_string_lossy().into_owned())
}

fn claude_image_media_type(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
        .as_str()
    {
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        _ => "image/png",
    }
}

/// The largest image attachment OpenKiwi will read into memory — the same
/// cap `save_pasted_image` enforces.
const MAX_IMAGE_ATTACHMENT_BYTES: u64 = 50 * 1024 * 1024;

/// Reads an image attachment after checking that it is a regular file within
/// the size cap, via tokio::fs so the async runtime is never blocked on disk.
async fn read_image_attachment(path: &Path) -> Result<Vec<u8>, String> {
    let metadata = tokio::fs::metadata(path)
        .await
        .map_err(|error| format!("Could not read {}: {error}", path.display()))?;
    if !metadata.is_file() {
        return Err(format!(
            "Could not read {}: not a regular file",
            path.display()
        ));
    }
    if metadata.len() > MAX_IMAGE_ATTACHMENT_BYTES {
        return Err(format!(
            "{} exceeds the 50 MB image attachment limit",
            path.display()
        ));
    }
    tokio::fs::read(path)
        .await
        .map_err(|error| format!("Could not read {}: {error}", path.display()))
}

/// Directory grant for a non-image attachment. Returns None when the
/// attachment should be referenced without an `--add-dir` grant: the path
/// cannot be verified as a regular file, or its parent resolves to the
/// filesystem root or a top-level system directory — granting `/`, `/etc`,
/// or `/usr` would hand the agent far more than the attachment.
fn attachment_add_dir(path: &Path) -> Option<PathBuf> {
    let canonical = path.canonicalize().ok()?;
    if !canonical.is_file() {
        return None;
    }
    let parent = canonical.parent()?;
    (!add_dir_is_too_broad(parent)).then(|| parent.to_path_buf())
}

/// True when granting this directory would hand the agent the filesystem
/// root or a top-level system folder. Depth is measured on the canonical
/// path; `/private/<x>` gets one extra level because macOS resolves `/etc`,
/// `/var`, and `/tmp` there.
fn add_dir_is_too_broad(parent: &Path) -> bool {
    let depth = parent
        .components()
        .filter(|component| matches!(component, std::path::Component::Normal(_)))
        .count();
    if depth <= 1 {
        return true;
    }
    depth == 2 && parent.starts_with("/private")
}

async fn claude_user_message(
    thread_id: &str,
    prompt: &str,
    attachments: &[ClaudeAttachment],
) -> Result<Value, String> {
    use base64::Engine as _;

    let mut content = vec![json!({ "type": "text", "text": prompt })];
    for attachment in attachments {
        let path = PathBuf::from(&attachment.path);
        if attachment.kind == "image" {
            let bytes = read_image_attachment(&path).await?;
            content.push(json!({
                "type": "image",
                "source": {
                    "type": "base64",
                    "media_type": claude_image_media_type(&path),
                    "data": base64::engine::general_purpose::STANDARD.encode(bytes),
                }
            }));
        } else {
            content.push(json!({
                "type": "text",
                "text": format!("Attached file available at: {}", path.display()),
            }));
        }
    }
    Ok(json!({
        "type": "user",
        "message": { "role": "user", "content": content },
        "parent_tool_use_id": Value::Null,
        "session_id": thread_id,
    }))
}

fn claude_effort(value: &str) -> &str {
    match value {
        "low" | "medium" | "high" | "xhigh" | "max" => value,
        "extra" => "xhigh",
        "ultra" => "max",
        _ => "medium",
    }
}

fn claude_agent_definitions(agents: &[ClaudeAgentInput], maximum: usize) -> Value {
    let definitions = agents
        .iter()
        .filter(|agent| agent.enabled)
        .take(maximum.clamp(1, 24))
        .map(|agent| {
            let mut definition = json!({
                "description": agent.description,
                "prompt": agent.instructions,
            });
            if let Some(model) = agent.model.as_deref().filter(|model| !model.is_empty()) {
                definition["model"] = json!(model);
            }
            (normalize_skill_name(&agent.name), definition)
        })
        .filter(|(name, _)| !name.is_empty())
        .collect::<serde_json::Map<_, _>>();
    Value::Object(definitions)
}

async fn emit_claude_event(app: &AppHandle, thread_id: &str, turn_id: &str, message: Value) {
    let _ = app.emit(
        "claude-event",
        json!({ "threadId": thread_id, "turnId": turn_id, "message": message }),
    );
}

/// Values forwarded to a provider CLI as argument values must not look like
/// flags, or the CLI would parse them as options instead.
fn validate_cli_value(value: &str, label: &str) -> Result<(), String> {
    if value.trim().is_empty() || value.starts_with('-') {
        return Err(format!("{label} is invalid."));
    }
    Ok(())
}

fn claude_disallowed_tools(permission: &str) -> Vec<&'static str> {
    let mut disallowed = Vec::new();
    if permission == "read-only" {
        disallowed.extend([
            "Write",
            "Edit",
            "NotebookEdit",
            "Bash",
            "WebFetch",
            "WebSearch",
        ]);
    }
    // OpenKiwi is the sole delegation authority. Claude's native Task/team
    // surface bypasses the approved roster, concurrency budget, ownership
    // records, and child inbox, so it is never exposed from OpenKiwi.
    disallowed.extend([
        "Task",
        "SendMessage",
        "TaskCreate",
        "TaskUpdate",
        "TeamCreate",
    ]);
    disallowed
}

#[tauri::command]
async fn claude_turn_start(
    app: AppHandle,
    state: State<'_, ClaudeState>,
    agent_state: State<'_, ChildAgentState>,
    options: ClaudeTurnOptions,
) -> Result<ClaudeTurnStarted, String> {
    let binary = resolve_claude_binary(&app).await?;
    if !state.authenticated.load(Ordering::Acquire) {
        let auth = read_claude_runtime_status(&app).await;
        state.authenticated.store(auth.logged_in, Ordering::Release);
        if !auth.logged_in {
            return Err("Sign in to Claude Code before sending a message.".into());
        }
    }
    if options.cwd.trim().is_empty() || !Path::new(&options.cwd).is_dir() {
        return Err("Choose a valid project folder before starting this Claude thread.".into());
    }
    validate_cli_value(&options.thread_id, "The thread identity")?;
    validate_cli_value(&options.model, "The model identity")?;
    if state
        .turns
        .lock()
        .await
        .get(&options.thread_id)
        .is_some_and(|turn| turn.alive.load(Ordering::Acquire))
    {
        return Err("Claude is already working in this thread".into());
    }

    let turn_id = uuid::Uuid::new_v4().to_string();
    let mut command = subscription_only_command(&binary);
    command
        .current_dir(&options.cwd)
        .env("CLAUDE_CODE_ENTRYPOINT", "sdk-ts")
        .args([
            "-p",
            "--setting-sources",
            "",
            "--output-format",
            "stream-json",
            "--input-format",
            "stream-json",
            "--verbose",
            "--include-partial-messages",
            "--name",
            "OpenKiwi",
            "--model",
            &options.model,
            "--effort",
            claude_effort(&options.effort),
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    // A dedicated process group lets kill_process_tree reach every
    // descendant the CLI spawns, not just the direct child.
    #[cfg(unix)]
    command.process_group(0);
    if !options.system_prompt.trim().is_empty() {
        command
            .arg("--append-system-prompt")
            .arg(&options.system_prompt);
    }
    let agent_definitions = claude_agent_definitions(&options.custom_agents, options.subagent_max);
    if agent_definitions
        .as_object()
        .is_some_and(|agents| !agents.is_empty())
    {
        command.arg("--agents").arg(agent_definitions.to_string());
    }
    if options.resume {
        command.arg(format!("--resume={}", options.thread_id));
    } else {
        command.args(["--session-id", &options.thread_id]);
    }
    match options.permission.as_str() {
        "full" => {
            command.args([
                "--permission-mode",
                "bypassPermissions",
                "--allow-dangerously-skip-permissions",
            ]);
        }
        "read-only" => {
            command.args(["--permission-mode", "dontAsk"]);
        }
        _ => {
            command.args([
                "--permission-mode",
                "manual",
                "--permission-prompt-tool",
                "stdio",
            ]);
        }
    }
    let disallowed = claude_disallowed_tools(&options.permission);
    if !disallowed.is_empty() {
        command.args(["--disallowedTools", &disallowed.join(",")]);
    }
    if let Some(plugin_path) = options
        .skills_plugin_path
        .as_deref()
        .filter(|path| Path::new(path).is_dir())
    {
        command.args(["--plugin-dir", plugin_path]);
    }
    // The bridge is passed by path, never inline: a `--mcp-config` JSON string
    // would put the delegation configuration into this process's argv, which
    // every other local process can read.
    if let Some(bridge_config) = options.child_agent_bridge_config.as_deref() {
        if !child_agent_bridge_config_registered(&agent_state, bridge_config).await {
            return Err("The sub-agent bridge configuration is no longer active.".into());
        }
        // Claude merges this server with the user's normal MCP configuration.
        command.args(["--mcp-config", bridge_config]);
    }
    let mut directories = HashSet::new();
    for attachment in options
        .attachments
        .iter()
        .filter(|attachment| attachment.kind != "image")
    {
        if let Some(parent) = attachment_add_dir(Path::new(&attachment.path)) {
            if directories.insert(parent.clone()) {
                command.arg("--add-dir").arg(parent);
            }
        }
    }

    // Build the first user message before spawning anything. Reading an
    // attachment can fail (file deleted, pasted image evicted from the
    // cache), and past the spawn every error path must also remove the turn
    // from the map and kill the child — otherwise the thread reports
    // "Claude is already working" until OpenKiwi restarts.
    let user_message =
        claude_user_message(&options.thread_id, &options.prompt, &options.attachments).await?;

    let mut child = command
        .spawn()
        .map_err(|error| format!("Could not start Claude Code: {error}"))?;
    let pid = child.id();
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "Claude Code did not provide an input stream".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Claude Code did not provide an output stream".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Claude Code did not provide an error stream".to_string())?;
    let alive = Arc::new(AtomicBool::new(true));
    let turn = Arc::new(ClaudeTurn {
        stdin: Mutex::new(stdin),
        child: Arc::new(Mutex::new(child)),
        pid,
        alive: alive.clone(),
    });
    if !claim_turn_slot(&state.turns, &options.thread_id, &turn, |existing| {
        existing.alive.load(Ordering::Acquire)
    })
    .await
    {
        turn.shutdown().await;
        return Err("Claude is already working in this thread".into());
    }

    let initialize = json!({
        "type": "control_request",
        "request_id": uuid::Uuid::new_v4().to_string(),
        "request": { "subtype": "initialize" }
    });
    if let Err(error) = turn.write(&initialize).await {
        remove_claude_turn_if_current(&state.turns, &options.thread_id, &turn).await;
        turn.shutdown().await;
        return Err(error);
    }
    if let Err(error) = turn.write(&user_message).await {
        remove_claude_turn_if_current(&state.turns, &options.thread_id, &turn).await;
        turn.shutdown().await;
        return Err(error);
    }

    let stderr_lines = Arc::new(Mutex::new(TailBuffer::new(CLAUDE_STDERR_TAIL_BYTES)));
    let stderr_output = stderr_lines.clone();
    let stderr_task = tauri::async_runtime::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let line = line.trim();
            if !line.is_empty() {
                stderr_output.lock().await.push_line(line);
            }
        }
    });

    let stdout_app = app.clone();
    let stdout_thread = options.thread_id;
    let stdout_turn = turn_id.clone();
    let turns = state.turns.clone();
    let stdout_child = turn.child.clone();
    let stdout_runtime = turn.clone();
    tauri::async_runtime::spawn(async move {
        const DELTA_FLUSH_INTERVAL: Duration = Duration::from_millis(25);
        let mut lines = BufReader::new(stdout).lines();
        let mut saw_result = false;
        // High-frequency `stream_event` messages are coalesced into a single
        // "claude-events" array emit (mirroring the Codex reader), flushed on
        // a ~25ms tick or before any non-delta message so ordering is
        // strictly preserved. Each array entry is exactly the payload the
        // per-line "claude-event" emit would have carried.
        let mut delta_buffer: Vec<Value> = Vec::new();
        let mut flush_deadline = Instant::now();
        let flush_deltas = |buffer: &mut Vec<Value>, app: &AppHandle| {
            if !buffer.is_empty() {
                let batch = std::mem::take(buffer);
                let _ = app.emit("claude-events", Value::Array(batch));
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
                        flush_deltas(&mut delta_buffer, &stdout_app);
                        continue;
                    }
                }
            };
            let line = match next {
                Ok(Some(line)) => line,
                Ok(None) => break,
                Err(error) => {
                    flush_deltas(&mut delta_buffer, &stdout_app);
                    emit_claude_event(
                        &stdout_app,
                        &stdout_thread,
                        &stdout_turn,
                        json!({
                            "type": "openkiwi_diagnostic",
                            "message": format!("Could not read Claude Code output: {error}"),
                        }),
                    )
                    .await;
                    break;
                }
            };
            let Ok(message) = serde_json::from_str::<Value>(&line) else {
                flush_deltas(&mut delta_buffer, &stdout_app);
                stderr_lines
                    .lock()
                    .await
                    .push_line(&format!("Unparseable Claude Code output: {line}"));
                emit_claude_event(
                    &stdout_app,
                    &stdout_thread,
                    &stdout_turn,
                    json!({
                        "type": "openkiwi_diagnostic",
                        "message": format!("Claude Code sent output OpenKiwi could not parse: {line}"),
                    }),
                )
                .await;
                continue;
            };
            if message.get("type").and_then(Value::as_str) == Some("stream_event") {
                if delta_buffer.is_empty() {
                    flush_deadline = Instant::now() + DELTA_FLUSH_INTERVAL;
                }
                delta_buffer.push(json!({
                    "threadId": stdout_thread,
                    "turnId": stdout_turn,
                    "message": message,
                }));
                continue;
            }
            flush_deltas(&mut delta_buffer, &stdout_app);
            if message.get("type").and_then(Value::as_str) == Some("result") {
                saw_result = true;
                // Publish the terminal event before making the backend turn
                // look inactive. Otherwise a foreground health check can race
                // into this gap and misclassify a normal result as a vanished
                // provider process.
                emit_claude_event(&stdout_app, &stdout_thread, &stdout_turn, message).await;
                // Stream-input mode deliberately waits for another user
                // message. OpenKiwi uses one process per turn so the next
                // turn can resume from the persisted Claude session.
                remove_claude_turn_if_current(&turns, &stdout_thread, &stdout_runtime).await;
                stdout_runtime.close_input().await;
                continue;
            }
            emit_claude_event(&stdout_app, &stdout_thread, &stdout_turn, message).await;
        }
        flush_deltas(&mut delta_buffer, &stdout_app);
        // Reap the completed child so repeated Claude turns cannot accumulate
        // zombie processes during a long-running OpenKiwi session. Bounded
        // like the Codex reaper: a child that closed stdout but refuses to
        // exit is force-killed along with its descendants.
        let exit = {
            let mut child = stdout_child.lock().await;
            match timeout(Duration::from_secs(5), child.wait()).await {
                Ok(exit) => exit.ok(),
                Err(_) => {
                    if let Some(pid) = stdout_runtime.pid {
                        kill_process_tree(pid);
                    }
                    // `kill` also awaits the child, so it is reaped either way.
                    let _ = child.kill().await;
                    None
                }
            }
        };
        let _ = stderr_task.await;
        if !saw_result {
            let stderr = stderr_lines.lock().await.contents().to_string();
            let detail = if stderr.trim().is_empty() {
                "Claude Code exited before completing the turn.".to_string()
            } else {
                stderr
                    .chars()
                    .rev()
                    .take(4000)
                    .collect::<String>()
                    .chars()
                    .rev()
                    .collect()
            };
            emit_claude_event(
                &stdout_app,
                &stdout_thread,
                &stdout_turn,
                json!({
                    "type": "openkiwi_exit",
                    "message": detail,
                    "code": exit.and_then(|status| status.code()),
                }),
            )
            .await;
        }
        // Keep the turn visible as active until its terminal event has been
        // emitted. This closes the recovery race where the UI saw an inactive
        // process first, called it interrupted, and then suppressed the real
        // unexpected-exit error.
        alive.store(false, Ordering::Release);
        remove_claude_turn_if_current(&turns, &stdout_thread, &stdout_runtime).await;
    });

    Ok(ClaudeTurnStarted { turn_id })
}

#[tauri::command]
async fn claude_turn_steer(
    state: State<'_, ClaudeState>,
    thread_id: String,
    prompt: String,
    attachments: Vec<ClaudeAttachment>,
) -> Result<(), String> {
    let turn = state
        .turns
        .lock()
        .await
        .get(&thread_id)
        .cloned()
        .ok_or_else(|| "Claude is not currently running in this thread".to_string())?;
    turn.write(&claude_user_message(&thread_id, &prompt, &attachments).await?)
        .await
}

#[tauri::command]
async fn claude_turn_interrupt(
    state: State<'_, ClaudeState>,
    thread_id: String,
) -> Result<(), String> {
    let turn = state
        .turns
        .lock()
        .await
        .get(&thread_id)
        .cloned()
        .ok_or_else(|| "Claude is not currently running in this thread".to_string())?;
    let interrupt = json!({
        "type": "control_request",
        "request_id": uuid::Uuid::new_v4().to_string(),
        "request": { "subtype": "interrupt" },
    });
    if let Err(error) = turn.write(&interrupt).await {
        // The stdin pipe is unusable, so the process is dead or wedged and a
        // cooperative interrupt can never reach it. Free the slot now instead
        // of leaving the thread stuck until OpenKiwi restarts.
        remove_claude_turn_if_current(&state.turns, &thread_id, &turn).await;
        turn.shutdown().await;
        return Err(error);
    }
    // Escalate if the CLI ignores the interrupt. A healthy process emits a
    // `result` well within the grace period (which sets `alive` to false via
    // close_input); a wedged one would otherwise hold the per-thread slot
    // until app restart.
    let turns = state.turns.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(CLAUDE_INTERRUPT_GRACE).await;
        if turn.alive.load(Ordering::Acquire) {
            remove_claude_turn_if_current(&turns, &thread_id, &turn).await;
            turn.shutdown().await;
        }
    });
    Ok(())
}

/// Force-stop the Claude process for a thread, releasing its slot immediately.
/// Used by the frontend when a stale process is blocking new turns.
#[tauri::command]
async fn claude_turn_kill(state: State<'_, ClaudeState>, thread_id: String) -> Result<(), String> {
    let turn = state.turns.lock().await.remove(&thread_id);
    if let Some(turn) = turn {
        turn.shutdown().await;
    }
    Ok(())
}

#[tauri::command]
async fn claude_turn_active(
    state: State<'_, ClaudeState>,
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
async fn claude_permission_respond(
    state: State<'_, ClaudeState>,
    thread_id: String,
    request_id: String,
    result: Value,
) -> Result<(), String> {
    let turn = state
        .turns
        .lock()
        .await
        .get(&thread_id)
        .cloned()
        .ok_or_else(|| "This Claude turn is no longer waiting for approval".to_string())?;
    turn.write(&json!({
        "type": "control_response",
        "response": {
            "subtype": "success",
            "request_id": request_id,
            "response": result,
        }
    }))
    .await
}

/// Answer a Claude control request OpenKiwi does not implement with an error
/// response, so a CLI blocking on the reply cannot stall the turn.
#[tauri::command]
async fn claude_control_error(
    state: State<'_, ClaudeState>,
    thread_id: String,
    request_id: String,
    message: String,
) -> Result<(), String> {
    let turn = state
        .turns
        .lock()
        .await
        .get(&thread_id)
        .cloned()
        .ok_or_else(|| "This Claude turn is no longer running".to_string())?;
    turn.write(&json!({
        "type": "control_response",
        "response": {
            "subtype": "error",
            "request_id": request_id,
            "error": message,
        }
    }))
    .await
}

#[tauri::command]
async fn audit_append(
    app: AppHandle,
    kind: String,
    thread_id: Option<String>,
    payload: Value,
) -> Result<(), String> {
    let connection = shared_state_db(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let connection = lock_state_db(&connection)?;
        let json = serde_json::to_string(&payload).map_err(|error| format!("Could not encode audit event: {error}"))?;
        let json = truncate_audit_payload(json);
        connection
            .execute(
                "INSERT INTO audit_events(created_at, kind, thread_id, payload) VALUES (?1, ?2, ?3, ?4)",
                params![unix_timestamp_ms(), kind, thread_id, json],
            )
            .map_err(|error| format!("Could not append audit event: {error}"))?;
        Ok(())
    })
    .await
    .map_err(|error| format!("Audit write task failed: {error}"))?
}

const MAX_AUDIT_PAYLOAD_BYTES: usize = 16 * 1024;

/// Caps an audit payload's stored size. Oversized payloads are wrapped in a
/// small marker object whose `detail` holds the truncated original JSON, so
/// the stored column remains valid JSON.
fn truncate_audit_payload(json: String) -> String {
    if json.len() <= MAX_AUDIT_PAYLOAD_BYTES {
        return json;
    }
    let cut = (0..=MAX_AUDIT_PAYLOAD_BYTES)
        .rev()
        .find(|index| json.is_char_boundary(*index))
        .unwrap_or(0);
    json!({ "truncated": true, "detail": &json[..cut] }).to_string()
}

/// A `kind` prefix is only safe inside a LIKE pattern when it is restricted
/// to the characters audit kinds actually use. `%` is rejected here; `_` is
/// allowed but escaped in the query so it cannot act as a wildcard.
fn valid_audit_kind_prefix(prefix: &str) -> bool {
    !prefix.is_empty()
        && prefix
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

#[tauri::command]
async fn audit_recent(
    app: AppHandle,
    limit: Option<u32>,
    kind_prefix: Option<String>,
) -> Result<Vec<Value>, String> {
    let limit = limit.unwrap_or(50).clamp(1, 500);
    let kind_prefix = match kind_prefix.as_deref().map(str::trim) {
        None | Some("") => None,
        Some(prefix) if valid_audit_kind_prefix(prefix) => Some(prefix.to_string()),
        Some(_) => {
            return Err(
                "Audit kind filters may only contain letters, numbers, '.', '_', or '-'.".into(),
            )
        }
    };
    let connection = shared_state_db(&app)?;
    tauri::async_runtime::spawn_blocking(move || -> Result<Vec<Value>, String> {
        let connection = lock_state_db(&connection)?;
        let map_row = |row: &rusqlite::Row<'_>| -> rusqlite::Result<Value> {
            let payload: String = row.get(4)?;
            Ok(json!({
                "id": row.get::<_, i64>(0)?,
                "kind": row.get::<_, String>(1)?,
                "threadId": row.get::<_, Option<String>>(2)?,
                "createdAt": row.get::<_, i64>(3)?,
                "payload": serde_json::from_str::<Value>(&payload).unwrap_or(Value::String(payload)),
            }))
        };
        let rows = if let Some(prefix) = kind_prefix {
            let escaped = prefix.replace('\\', "\\\\").replace('_', "\\_");
            let mut statement = connection
                .prepare(
                    "SELECT id, kind, thread_id, created_at, payload FROM audit_events
                     WHERE kind LIKE ?1 ESCAPE '\\' ORDER BY id DESC LIMIT ?2",
                )
                .map_err(|error| format!("Could not read recent audit events: {error}"))?;
            let collected = statement
                .query_map(params![format!("{escaped}%"), limit], map_row)
                .map_err(|error| format!("Could not query recent audit events: {error}"))?
                .collect::<Result<Vec<_>, _>>();
            collected
        } else {
            let mut statement = connection
                .prepare(
                    "SELECT id, kind, thread_id, created_at, payload FROM audit_events
                     ORDER BY id DESC LIMIT ?1",
                )
                .map_err(|error| format!("Could not read recent audit events: {error}"))?;
            let collected = statement
                .query_map(params![limit], map_row)
                .map_err(|error| format!("Could not query recent audit events: {error}"))?
                .collect::<Result<Vec<_>, _>>();
            collected
        };
        rows.map_err(|error| format!("Could not decode recent audit events: {error}"))
    })
    .await
    .map_err(|error| format!("Audit read task failed: {error}"))?
}

#[tauri::command]
async fn diagnostics_read(app: AppHandle) -> Result<Value, String> {
    let runtime = codex_runtime_status(app.clone()).await;
    let database = state_db_path(&app)?;
    let shared_connection = shared_state_db(&app)?;
    let audit = tauri::async_runtime::spawn_blocking(move || -> Result<Vec<Value>, String> {
        let connection = lock_state_db(&shared_connection)?;
        let mut statement = connection
            .prepare("SELECT created_at, kind, thread_id, payload FROM audit_events ORDER BY created_at DESC LIMIT 200")
            .map_err(|error| format!("Could not read diagnostics audit history: {error}"))?;
        let rows = statement
            .query_map([], |row| {
                let payload: String = row.get(3)?;
                Ok(json!({
                    "createdAt": row.get::<_, i64>(0)?,
                    "kind": row.get::<_, String>(1)?,
                    "threadId": row.get::<_, Option<String>>(2)?,
                    "payload": serde_json::from_str::<Value>(&payload).unwrap_or(Value::String(payload)),
                }))
            })
            .map_err(|error| format!("Could not query diagnostics audit history: {error}"))?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("Could not decode diagnostics audit history: {error}"))
    })
    .await
    .map_err(|error| format!("Diagnostics audit task failed: {error}"))??;
    Ok(json!({
        "appVersion": env!("CARGO_PKG_VERSION"),
        "runtime": runtime,
        "stateDatabase": database,
        "platform": env::consts::OS,
        "architecture": env::consts::ARCH,
        "generatedAt": unix_timestamp_ms(),
        "auditEvents": audit,
    }))
}

/// Restrict diagnostics exports to visible files inside the user's home
/// directory. The webview supplies the path (picked via the OS save dialog),
/// so it must not be trusted to point anywhere on disk.
fn validated_export_path(app: &AppHandle, path: &str) -> Result<PathBuf, String> {
    let target = PathBuf::from(path);
    if !target.is_absolute() {
        return Err("Diagnostics can only be exported to an absolute path.".into());
    }
    let file_name = target
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "Diagnostics export needs a file name.".to_string())?
        .to_string();
    if file_name.starts_with('.') {
        return Err("Diagnostics cannot be exported to a hidden file.".into());
    }
    let parent = target
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .ok_or_else(|| "Diagnostics export needs a destination folder.".to_string())?;
    let parent = parent
        .canonicalize()
        .map_err(|error| format!("Could not open the export folder: {error}"))?;
    let home = app
        .path()
        .home_dir()
        .map_err(|error| format!("Could not resolve the home folder: {error}"))?;
    let home = home.canonicalize().unwrap_or(home);
    let relative = parent
        .strip_prefix(&home)
        .map_err(|_| "Diagnostics can only be exported inside your home folder.".to_string())?;
    if relative
        .components()
        .any(|component| component.as_os_str().to_string_lossy().starts_with('.'))
    {
        return Err("Diagnostics cannot be exported into a hidden folder.".into());
    }
    let destination = parent.join(file_name);
    // The parent is canonicalized above, but `tokio::fs::write` would still
    // follow a symlink at the final component, letting a pre-planted link
    // redirect the export outside the validated folder.
    if fs::symlink_metadata(&destination)
        .map(|metadata| metadata.file_type().is_symlink())
        .unwrap_or(false)
    {
        return Err(
            "The export destination is a symbolic link. Choose a regular file path.".into(),
        );
    }
    Ok(destination)
}

#[tauri::command]
async fn diagnostics_export(app: AppHandle, path: String) -> Result<(), String> {
    let destination = validated_export_path(&app, &path)?;
    let diagnostics = diagnostics_read(app).await?;
    let text = serde_json::to_string_pretty(&diagnostics)
        .map_err(|error| format!("Could not encode diagnostics: {error}"))?;
    tokio::fs::write(destination, text)
        .await
        .map_err(|error| format!("Could not export diagnostics: {error}"))
}

const MAX_TEXT_EXPORT_BYTES: usize = 20 * 1024 * 1024;

/// Writes UTF-8 text to a user-chosen destination (picked via the OS save
/// dialog). Restricted to visible files inside the home folder, like
/// diagnostics exports.
#[tauri::command]
async fn export_text_file(app: AppHandle, path: String, contents: String) -> Result<(), String> {
    if contents.len() > MAX_TEXT_EXPORT_BYTES {
        return Err("The exported text exceeds 20 MB.".into());
    }
    let destination = validated_export_path(&app, &path)?;
    tokio::fs::write(destination, contents)
        .await
        .map_err(|error| format!("Could not export the text file: {error}"))
}

#[tauri::command]
async fn normal_chat_workspace(app: AppHandle) -> Result<String, String> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Could not resolve OpenKiwi app data: {error}"))?;
    let workspace = app_data.join("normal-chats");
    tokio::fs::create_dir_all(&workspace)
        .await
        .map_err(|error| format!("Could not create the normal chat workspace: {error}"))?;
    Ok(workspace.to_string_lossy().into_owned())
}

fn runtime_path(codex_binary: &Path, home: Option<&Path>) -> Option<OsString> {
    let mut directories: Vec<PathBuf> = Vec::new();
    let mut add = |path: PathBuf| {
        if !directories.contains(&path) {
            directories.push(path);
        }
    };

    if let Some(parent) = codex_binary.parent() {
        add(parent.to_path_buf());
        if parent.file_name().is_some_and(|name| name == "bin") {
            if let Some(runtime_root) = parent.parent() {
                add(runtime_root.join("codex-path"));
                add(runtime_root.join("codex-resources").join("zsh").join("bin"));
            }
        }
    }
    if let Some(current) = env::var_os("PATH") {
        for directory in env::split_paths(&current) {
            add(directory);
        }
    }
    for directory in [
        "/opt/homebrew/bin",
        "/opt/homebrew/sbin",
        "/usr/local/bin",
        "/usr/local/sbin",
        "/usr/bin",
        "/bin",
        "/usr/sbin",
        "/sbin",
    ] {
        add(PathBuf::from(directory));
    }
    if let Some(home) = home {
        for relative in [
            ".local/bin",
            ".cargo/bin",
            ".npm-global/bin",
            ".bun/bin",
            ".volta/bin",
        ] {
            add(home.join(relative));
        }
    }

    env::join_paths(directories).ok()
}

fn initialize_params() -> Value {
    json!({
        "clientInfo": {
            "name": "openkiwi",
            "title": "OpenKiwi",
            "version": env!("CARGO_PKG_VERSION")
        },
        "capabilities": {
            "experimentalApi": true,
            "requestAttestation": false,
            "mcpServerOpenaiFormElicitation": true
        }
    })
}

async fn spawn_server(app: &AppHandle) -> Result<Arc<AppServer>, String> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Could not resolve app data directory: {error}"))?;
    let codex_home = app_data.join("codex-home");

    let codex_binary = resolve_codex_binary(app).await?;
    let home = app.path().home_dir().ok();

    let mut command = background_command(&codex_binary);
    command
        .arg("app-server")
        .env("CODEX_HOME", &codex_home)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    // A dedicated process group lets kill_process_tree reach every
    // descendant the runtime spawns, not just the direct child.
    #[cfg(unix)]
    command.process_group(0);

    let mut openrouter_proxy_url = None;
    let mut openrouter_proxy_task = None;
    if let Some(key) = openrouter_key().await {
        let (proxy_url, task) = start_openrouter_proxy(key.clone()).await?;
        command.env("OPENROUTER_API_KEY", key);
        openrouter_proxy_url = Some(proxy_url);
        openrouter_proxy_task = Some(task);
    }
    // LM Studio accepts the conventional `lm-studio` placeholder when local
    // authentication is disabled. If the user enabled API tokens, the real
    // token lives only in Keychain and this child-process environment.
    command.env(
        "LMSTUDIO_API_KEY",
        lmstudio_key().await.unwrap_or_else(|| "lm-studio".into()),
    );
    // The proxy base URL embeds a secret path token, so it is written into
    // the 0600 app-managed config.toml rather than passed as a `-c` CLI
    // override, which any local process could read via `ps`.
    if let Err(error) = write_runtime_config(&codex_home, openrouter_proxy_url.as_deref()).await {
        if let Some(task) = &openrouter_proxy_task {
            task.abort();
        }
        return Err(error);
    }

    if let Some(path) = runtime_path(&codex_binary, home.as_deref()) {
        command.env("PATH", path);
    }

    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            if let Some(task) = &openrouter_proxy_task {
                task.abort();
            }
            return Err(format!(
                "Could not start the Codex runtime at `{}`: {error}",
                codex_binary.display()
            ));
        }
    };
    let abort_proxy = |task: &Option<tokio::task::JoinHandle<()>>| {
        if let Some(task) = task {
            task.abort();
        }
    };
    let stdin = match child.stdin.take() {
        Some(stdin) => stdin,
        None => {
            abort_proxy(&openrouter_proxy_task);
            let _ = child.start_kill();
            return Err("Codex App Server did not expose stdin".to_string());
        }
    };
    let stdout = match child.stdout.take() {
        Some(stdout) => stdout,
        None => {
            abort_proxy(&openrouter_proxy_task);
            let _ = child.start_kill();
            return Err("Codex App Server did not expose stdout".to_string());
        }
    };
    let stderr = child.stderr.take();
    let pid = child.id();
    let child = Arc::new(Mutex::new(child));
    let child_for_reader = child.clone();
    let pending: PendingMap = Arc::new(Mutex::new(HashMap::new()));
    let pending_for_reader = pending.clone();
    let app_for_reader = app.clone();
    let alive = Arc::new(AtomicBool::new(true));
    let alive_for_reader = alive.clone();
    let server_requests: Arc<Mutex<HashSet<String>>> = Arc::new(Mutex::new(HashSet::new()));
    let server_requests_for_reader = server_requests.clone();

    tauri::async_runtime::spawn(async move {
        const DELTA_FLUSH_INTERVAL: Duration = Duration::from_millis(25);
        let mut lines = BufReader::new(stdout).lines();
        // Streaming "…Delta" notifications are coalesced into a single
        // "codex-events" array emit, flushed on a ~25ms tick or before any
        // non-delta message so ordering is strictly preserved.
        let mut delta_buffer: Vec<Value> = Vec::new();
        let mut flush_deadline = Instant::now();
        let flush_deltas = |buffer: &mut Vec<Value>, app: &AppHandle| {
            if !buffer.is_empty() {
                let batch = std::mem::take(buffer);
                let _ = app.emit("codex-events", Value::Array(batch));
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
                flush_deltas(&mut delta_buffer, &app_for_reader);
                let _ = app_for_reader.emit(
                    "codex-event",
                    json!({ "stream": "stderr", "line": format!("Invalid app-server message: {line}") }),
                );
                continue;
            };

            let is_response = message.get("id").is_some()
                && (message.get("result").is_some() || message.get("error").is_some());
            if is_response {
                flush_deltas(&mut delta_buffer, &app_for_reader);
                if let Some(id) = message.get("id").and_then(Value::as_i64) {
                    if let Some(sender) = pending_for_reader.lock().await.remove(&id) {
                        let result = if let Some(error) = message.get("error") {
                            Err(error
                                .get("message")
                                .and_then(Value::as_str)
                                .unwrap_or("Unknown Codex App Server error")
                                .to_string())
                        } else {
                            Ok(message.get("result").cloned().unwrap_or(Value::Null))
                        };
                        let _ = sender.send(result);
                    }
                }
            } else {
                let is_delta_notification = message.get("id").is_none()
                    && message
                        .get("method")
                        .and_then(Value::as_str)
                        .is_some_and(|method| method.ends_with("Delta"));
                if is_delta_notification {
                    if delta_buffer.is_empty() {
                        flush_deadline = Instant::now() + DELTA_FLUSH_INTERVAL;
                    }
                    delta_buffer.push(message);
                } else {
                    flush_deltas(&mut delta_buffer, &app_for_reader);
                    if message.get("id").is_some() && message.get("method").is_some() {
                        // A server-initiated request: record its id (before
                        // emitting) so codex_respond can verify the response
                        // targets this exact server instance.
                        if let Some(id) = message.get("id") {
                            server_requests_for_reader
                                .lock()
                                .await
                                .insert(id.to_string());
                        }
                    }
                    let _ = app_for_reader.emit("codex-event", message);
                }
            }
        }
        flush_deltas(&mut delta_buffer, &app_for_reader);

        alive_for_reader.store(false, Ordering::Release);
        let _ = app_for_reader.emit("codex-runtime", json!({ "alive": false }));
        let mut pending = pending_for_reader.lock().await;
        for (_, sender) in pending.drain() {
            let _ = sender.send(Err("Codex App Server connection closed".into()));
        }
        let _ = app_for_reader.emit(
            "codex-event",
            json!({ "stream": "stderr", "line": "Codex App Server connection closed" }),
        );
        drop(pending);

        // Reap the child so it does not linger as a zombie after stdout EOF.
        let mut child = child_for_reader.lock().await;
        if timeout(Duration::from_secs(5), child.wait()).await.is_err() {
            // `kill` also awaits the child, so it is reaped either way.
            let _ = child.kill().await;
        }
    });

    if let Some(stderr) = stderr {
        let app_for_stderr = app.clone();
        tauri::async_runtime::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let _ =
                    app_for_stderr.emit("codex-event", json!({ "stream": "stderr", "line": line }));
            }
        });
    }

    let server = Arc::new(AppServer {
        stdin: Mutex::new(stdin),
        child,
        pid,
        instance: uuid::Uuid::new_v4().to_string(),
        pending,
        next_id: AtomicI64::new(1),
        alive,
        server_requests,
        openrouter_proxy_url,
        openrouter_proxy_task,
    });

    if let Err(error) = server.request("initialize", initialize_params()).await {
        server.shutdown().await;
        return Err(error);
    }
    if let Err(error) = server.notify("initialized", json!({})).await {
        server.shutdown().await;
        return Err(error);
    }
    let _ = app.emit("codex-runtime", json!({ "alive": true }));
    Ok(server)
}

async fn ensure_server(app: &AppHandle, state: &RuntimeState) -> Result<Arc<AppServer>, String> {
    let mut guard = state.server.lock().await;
    // Another task can repopulate the slot while the lock is released for the
    // stale shutdown, so re-check the guard every time it is re-acquired.
    while let Some(server) = guard.as_ref() {
        if server.is_alive() {
            return Ok(server.clone());
        }
        let stale = guard.take();
        drop(guard);
        if let Some(stale) = stale {
            stale.shutdown().await;
        }
        guard = state.server.lock().await;
    }

    let server = spawn_server(app).await?;
    *guard = Some(server.clone());
    // Record the pid where the exit handler can reach it without the async
    // server lock (which this function holds during spawn/initialize).
    *state
        .server_pid
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner) = server.pid;
    Ok(server)
}

/// Validate the high-impact RPCs that the webview is allowed to forward.
/// The Codex app-server normally enforces its own approval policy for agent
/// turns, but OpenKiwi also exposes a user-operated terminal and workflows via
/// `command/exec`. Requiring an explicit, bounded sandbox policy here keeps a
/// malformed renderer request from silently omitting the sandbox or widening
/// a workspace-write request beyond its workspace (except for the shared Git
/// directory required by an isolated linked worktree).
fn validate_rpc_params(method: &str, params: &Value) -> Result<(), String> {
    if method == "command/exec" {
        let command = params
            .get("command")
            .and_then(Value::as_array)
            .ok_or_else(|| "command/exec requires a command array".to_string())?;
        if command.is_empty()
            || command.len() > 256
            || command.iter().any(|value| {
                value
                    .as_str()
                    .is_none_or(|argument| argument.is_empty() || argument.len() > 32_768)
            })
        {
            return Err("command/exec received an invalid or oversized command".into());
        }
        let cwd = params
            .get("cwd")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| "command/exec requires a working directory".to_string())?;
        let cwd = PathBuf::from(cwd)
            .canonicalize()
            .map_err(|error| format!("command/exec working directory is unavailable: {error}"))?;
        if !cwd.is_dir() {
            return Err("command/exec working directory is not a folder".into());
        }
        let sandbox = params
            .get("sandboxPolicy")
            .and_then(Value::as_object)
            .ok_or_else(|| "command/exec requires an explicit sandbox policy".to_string())?;
        let sandbox_type = sandbox
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if !matches!(
            sandbox_type,
            "readOnly" | "workspaceWrite" | "dangerFullAccess"
        ) {
            return Err("command/exec received an unknown sandbox policy".into());
        }
        if sandbox_type == "workspaceWrite" {
            let roots = sandbox
                .get("writableRoots")
                .and_then(Value::as_array)
                .ok_or_else(|| "workspaceWrite requires writable roots".to_string())?;
            if roots.is_empty() || roots.len() > 16 {
                return Err("workspaceWrite requires 1–16 writable roots".into());
            }
            let shared_git_dir = git_common_dir(&cwd).ok();
            let mut grants_working_directory = false;
            for root in roots {
                let root = root
                    .as_str()
                    .ok_or_else(|| "workspaceWrite roots must be paths".to_string())?;
                let canonical = PathBuf::from(root).canonicalize().map_err(|error| {
                    format!("workspaceWrite root `{root}` is unavailable: {error}")
                })?;
                if !canonical.is_dir() || canonical.parent().is_none() {
                    return Err("workspaceWrite cannot grant a filesystem root".into());
                }
                grants_working_directory |= canonical == cwd;
                if !canonical.starts_with(&cwd)
                    && shared_git_dir
                        .as_ref()
                        .is_none_or(|git_dir| canonical != *git_dir)
                {
                    return Err(
                        "workspaceWrite roots must stay inside the working directory or match its shared Git directory"
                            .into(),
                    );
                }
            }
            if !grants_working_directory {
                return Err("workspaceWrite must grant its working directory".into());
            }
        }
    }
    if matches!(method, "config/value/write" | "config/value/delete") {
        let key = params
            .get("keyPath")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if !key.starts_with("mcp_servers.") || key.len() > 256 {
            return Err(
                "OpenKiwi only permits MCP server settings through the desktop bridge".into(),
            );
        }
    }
    Ok(())
}

#[tauri::command]
async fn codex_rpc(
    app: AppHandle,
    state: State<'_, RuntimeState>,
    method: String,
    mut params: Value,
) -> Result<Value, String> {
    const ALLOWED_METHODS: &[&str] = &[
        "account/read",
        "account/login/start",
        "account/logout",
        "account/rateLimits/read",
        "model/list",
        "thread/list",
        "thread/start",
        "thread/resume",
        "thread/read",
        "thread/fork",
        "thread/rollback",
        "thread/name/set",
        "thread/archive",
        "thread/unarchive",
        "thread/delete",
        "thread/search",
        "thread/compact/start",
        "turn/start",
        "turn/steer",
        "turn/interrupt",
        "review/start",
        "command/exec",
        "command/exec/write",
        "command/exec/resize",
        "command/exec/terminate",
        "skills/list",
        "skills/extraRoots/set",
        "mcpServerStatus/list",
        "mcpServer/oauth/login",
        "config/mcpServer/reload",
        "config/value/write",
        "config/value/delete",
        "gitDiffToRemote",
        "fs/readFile",
        "fs/readDirectory",
        "fuzzyFileSearch",
    ];
    // Methods that are safe to transparently re-send after the runtime is
    // respawned. Everything else (turn/start, command/exec, config writes, …)
    // may already have taken effect before the connection died, so an
    // automatic retry could run the action twice.
    const RETRYABLE_METHODS: &[&str] = &[
        "account/read",
        "account/rateLimits/read",
        "model/list",
        "thread/list",
        "thread/read",
        "thread/search",
        "skills/list",
        "mcpServerStatus/list",
        "gitDiffToRemote",
        "fs/readFile",
        "fs/readDirectory",
        "fuzzyFileSearch",
    ];
    if !ALLOWED_METHODS.contains(&method.as_str()) {
        return Err(format!(
            "OpenKiwi's desktop bridge does not allow the RPC method `{method}`"
        ));
    }
    validate_rpc_params(&method, &params)?;
    let server = ensure_server(&app, &state).await?;
    if matches!(
        method.as_str(),
        "thread/start" | "thread/resume" | "thread/fork"
    ) {
        inject_openrouter_proxy_config(&mut params, server.openrouter_proxy_url.as_deref());
    }
    match server.request(&method, params.clone()).await {
        Ok(result) => Ok(result),
        Err(error) if !server.is_alive() => {
            let mut guard = state.server.lock().await;
            if guard
                .as_ref()
                .is_some_and(|current| Arc::ptr_eq(current, &server))
            {
                guard.take();
            }
            drop(guard);
            let recovered = ensure_server(&app, &state).await.map_err(|restart_error| {
                format!("{error}. OpenKiwi also could not restart the runtime: {restart_error}")
            })?;
            if RETRYABLE_METHODS.contains(&method.as_str()) {
                recovered.request(&method, params).await
            } else {
                Err(format!(
                    "{error}. The runtime was restarted; retry the action if it did not complete."
                ))
            }
        }
        Err(error) => Err(error),
    }
}

#[tauri::command]
async fn codex_respond(
    state: State<'_, RuntimeState>,
    id: Value,
    result: Value,
) -> Result<(), String> {
    // Deliberately not ensure_server: a response to a server-initiated
    // request is only meaningful for the exact instance that asked. Spawning
    // (or targeting) a fresh server would hand it a stale request id.
    let server = state
        .server
        .lock()
        .await
        .as_ref()
        .filter(|server| server.is_alive())
        .cloned()
        .ok_or_else(|| {
            "The Codex runtime is no longer running, so this request can no longer be answered."
                .to_string()
        })?;
    if !server.server_requests.lock().await.remove(&id.to_string()) {
        return Err(
            "The Codex runtime restarted, so this request can no longer be answered.".into(),
        );
    }
    server.respond(id, result).await
}

#[tauri::command]
async fn save_openrouter_key(
    app: AppHandle,
    state: State<'_, RuntimeState>,
    api_key: String,
) -> Result<(), String> {
    let trimmed = api_key.trim().to_string();
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let entry = keyring::Entry::new(KEYRING_SERVICE, OPENROUTER_ACCOUNT)
            .map_err(|error| format!("Could not open the OS credential store: {error}"))?;
        if trimmed.is_empty() {
            match entry.delete_credential() {
                Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
                Err(error) => Err(format!("Could not remove the OpenRouter key: {error}")),
            }
        } else {
            entry
                .set_password(&trimmed)
                .map_err(|error| format!("Could not save the OpenRouter key: {error}"))
        }
    })
    .await
    .map_err(|error| format!("Credential task failed: {error}"))??;

    if let Some(server) = state.server.lock().await.take() {
        server.shutdown().await;
    }
    let _ = ensure_server(&app, &state).await?;
    Ok(())
}

#[tauri::command]
async fn has_openrouter_key() -> bool {
    openrouter_key().await.is_some()
}

#[tauri::command]
async fn save_lmstudio_key(
    app: AppHandle,
    state: State<'_, RuntimeState>,
    api_key: String,
) -> Result<(), String> {
    let trimmed = api_key.trim().to_string();
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let entry = keyring::Entry::new(KEYRING_SERVICE, LMSTUDIO_ACCOUNT)
            .map_err(|error| format!("Could not open the OS credential store: {error}"))?;
        if trimmed.is_empty() {
            match entry.delete_credential() {
                Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
                Err(error) => Err(format!("Could not remove the LM Studio token: {error}")),
            }
        } else {
            entry
                .set_password(&trimmed)
                .map_err(|error| format!("Could not save the LM Studio token: {error}"))
        }
    })
    .await
    .map_err(|error| format!("Credential task failed: {error}"))??;

    if let Some(server) = state.server.lock().await.take() {
        server.shutdown().await;
    }
    let _ = ensure_server(&app, &state).await?;
    Ok(())
}

#[tauri::command]
async fn has_lmstudio_key() -> bool {
    lmstudio_key().await.is_some()
}

#[tauri::command]
async fn list_openrouter_models() -> Result<Value, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|error| format!("Could not create the OpenRouter catalog client: {error}"))?;
    let mut request = client
        .get("https://openrouter.ai/api/v1/models?supported_parameters=tools&limit=1000")
        .header("X-Title", "OpenKiwi");
    if let Some(key) = openrouter_key().await {
        request = request.bearer_auth(key);
    }
    request
        .send()
        .await
        .map_err(|error| format!("Could not reach the OpenRouter model catalog: {error}"))?
        .error_for_status()
        .map_err(|error| format!("OpenRouter rejected the model catalog request: {error}"))?
        .json::<Value>()
        .await
        .map_err(|error| format!("Could not read the OpenRouter model catalog: {error}"))
}

#[tauri::command]
async fn list_lmstudio_models(base_url: String) -> Result<Value, String> {
    let base_url = normalize_lmstudio_base_url(&base_url)?;
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(4))
        .timeout(Duration::from_secs(12))
        .build()
        .map_err(|error| format!("Could not create the LM Studio client: {error}"))?;
    let token = lmstudio_key().await.unwrap_or_else(|| "lm-studio".into());
    let native = client
        .get(lmstudio_native_models_url(&base_url))
        .bearer_auth(&token)
        .send()
        .await
        .ok()
        .and_then(|response| response.error_for_status().ok());
    if let Some(response) = native {
        if let Ok(value) = response.json::<Value>().await {
            if let Some(catalog) = normalize_lmstudio_model_catalog(&value) {
                return Ok(catalog);
            }
        }
    }

    let mut compatibility_url = base_url;
    let path = format!("{}/models", compatibility_url.path().trim_end_matches('/'));
    compatibility_url.set_path(&path);
    client
        .get(compatibility_url)
        .bearer_auth(token)
        .send()
        .await
        .map_err(|error| format!("Could not reach LM Studio. Start its local server and check the URL: {error}"))?
        .error_for_status()
        .map_err(|error| format!("LM Studio rejected the model request: {error}"))?
        .json::<Value>()
        .await
        .map_err(|error| format!("Could not read LM Studio's model catalog: {error}"))
}

/// Identity of the app-server that will serve the next RPC, starting it if it
/// is not running yet. Two calls returning the same value mean the same
/// process has been up throughout, so the threads it loaded are still loaded
/// and their startup-only config cannot be changed by `thread/resume` alone.
#[tauri::command]
async fn runtime_instance(
    app: AppHandle,
    state: State<'_, RuntimeState>,
) -> Result<String, String> {
    Ok(ensure_server(&app, &state).await?.instance.clone())
}

#[tauri::command]
async fn restart_runtime(app: AppHandle, state: State<'_, RuntimeState>) -> Result<(), String> {
    if let Some(server) = state.server.lock().await.take() {
        server.shutdown().await;
    }
    let _ = ensure_server(&app, &state).await?;
    Ok(())
}

/// Synchronously shut down the managed Codex app-server before the process
/// exits. `std::process::exit` skips drop glue, so `kill_on_drop` alone would
/// orphan the child. Bounded by short timeouts so quitting can never hang.
fn shutdown_runtime_on_exit(app: &AppHandle) {
    let Some(state) = app.try_state::<RuntimeState>() else {
        return;
    };
    let server = tauri::async_runtime::block_on(async {
        match timeout(Duration::from_millis(500), state.server.lock()).await {
            Ok(mut guard) => Ok(guard.take()),
            Err(_) => Err(()),
        }
    });
    match server {
        Ok(Some(server)) => {
            let graceful = tauri::async_runtime::block_on(async {
                timeout(Duration::from_secs(2), server.shutdown())
                    .await
                    .is_ok()
            });
            if !graceful {
                // Last resort: signal the tree by pid without touching locks.
                if let Some(pid) = server.pid {
                    kill_process_tree(pid);
                }
            }
        }
        Ok(None) => {}
        Err(()) => {
            // `ensure_server` can hold the server lock for the whole
            // spawn/initialize window (up to ~2 minutes). Fall back to the
            // separately recorded pid so the child's process tree is still
            // torn down instead of being orphaned.
            let pid = *state
                .server_pid
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if let Some(pid) = pid {
                kill_process_tree(pid);
            }
        }
    }
}

fn shutdown_claude_on_exit(app: &AppHandle) {
    let Some(state) = app.try_state::<ClaudeState>() else {
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
            timeout(Duration::from_secs(1), turn.shutdown())
                .await
                .is_ok()
        });
        if !stopped {
            if let Some(pid) = turn.pid {
                kill_process_tree(pid);
            }
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // reqwest and the updater share the same provider-less rustls stack.
    // Install Ring before either subsystem creates its first HTTP client.
    let _ = rustls::crypto::ring::default_provider().install_default();

    // Re-invoked as the cross-provider sub-agent bridge: act as a stdio MCP
    // server and exit without ever constructing the desktop app.
    let mut arguments = env::args().skip(1);
    if arguments.next().as_deref() == Some(AGENT_BRIDGE_ARG) {
        let session = arguments.next().unwrap_or_default();
        std::process::exit(run_agent_bridge(&session));
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            #[cfg(desktop)]
            app.handle()
                .plugin(tauri_plugin_updater::Builder::new().build())?;
            let db_path = state_db_path(app.handle()).map_err(std::io::Error::other)?;
            let connection = open_state_db(&db_path).map_err(std::io::Error::other)?;
            app.manage(StateDb {
                connection: Arc::new(std::sync::Mutex::new(connection)),
            });
            // Bridge session material is only meaningful while its backend is
            // listening, so anything on disk at startup is debris from a
            // previous run and must not outlive it.
            purge_stale_agent_bridges(app.handle());
            Ok(())
        })
        .manage(RuntimeState::default())
        .manage(ClaudeState::default())
        .manage(CursorState::default())
        .manage(ChildAgentState::default())
        .invoke_handler(tauri::generate_handler![
            codex_runtime_status,
            claude_runtime_status,
            claude_usage,
            claude_login,
            cursor_runtime_status,
            cursor_login,
            cursor_models,
            github_status,
            github_login,
            github_repo_status,
            github_attach_remote,
            github_create_repository,
            github_clone_repository,
            claude_turn_start,
            claude_turn_steer,
            claude_turn_interrupt,
            claude_turn_kill,
            claude_turn_active,
            claude_permission_respond,
            claude_control_error,
            cursor_turn_start,
            cursor_turn_steer,
            cursor_turn_interrupt,
            cursor_turn_kill,
            cursor_turn_active,
            cursor_permission_respond,
            state_read,
            state_write,
            state_delete,
            checkpoint_create,
            checkpoint_complete,
            checkpoint_diff,
            checkpoint_restore,
            checkpoint_delete,
            workspace_git_info,
            workspace_git_initialize,
            worktree_create,
            worktree_recreate,
            worktree_status,
            worktree_apply_to_source,
            worktree_set_applied_baseline,
            worktree_merge_branch,
            worktree_remove,
            audit_append,
            audit_recent,
            diagnostics_read,
            diagnostics_export,
            export_text_file,
            local_skills_scan,
            local_skills_sync,
            local_skills_import,
            local_skills_create,
            local_skills_read,
            local_skills_update,
            local_skills_delete,
            normal_chat_workspace,
            codex_rpc,
            codex_respond,
            save_openrouter_key,
            save_lmstudio_key,
            save_pasted_image,
            has_openrouter_key,
            has_lmstudio_key,
            list_openrouter_models,
            list_lmstudio_models,
            child_agent_session_start,
            child_agent_session_end,
            child_agent_respond,
            child_agent_finished,
            runtime_instance,
            restart_runtime
        ])
        .build(tauri::generate_context!())
        .expect("error while running OpenKiwi")
        .run(|app_handle, event| {
            if matches!(
                event,
                tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit
            ) {
                shutdown_runtime_on_exit(app_handle);
                shutdown_claude_on_exit(app_handle);
                shutdown_cursor_on_exit(app_handle);
                shutdown_agent_bridges_on_exit(app_handle);
            }
        });
}

#[cfg(test)]
mod tests;
