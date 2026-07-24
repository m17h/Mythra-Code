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
    time::{SystemTime, UNIX_EPOCH},
};

use axum::{
    body::{Body, Bytes},
    extract::State as AxumState,
    http::{header, HeaderMap, Method, Response, StatusCode, Uri},
    routing::any,
    Router,
};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, Command},
    sync::{oneshot, Mutex},
    time::{timeout, timeout_at, Duration, Instant},
};

const KEYRING_SERVICE: &str = "com.kiwi.harness";
const OPENROUTER_ACCOUNT: &str = "openrouter-api-key";

type PendingMap = Arc<Mutex<HashMap<i64, oneshot::Sender<Result<Value, String>>>>>;

struct AppServer {
    stdin: Mutex<ChildStdin>,
    child: Arc<Mutex<Child>>,
    pid: Option<u32>,
    pending: PendingMap,
    next_id: AtomicI64,
    alive: Arc<AtomicBool>,
    openrouter_proxy_url: Option<String>,
    openrouter_proxy_task: Option<tokio::task::JoinHandle<()>>,
}

#[derive(Default)]
struct RuntimeState {
    server: Mutex<Option<Arc<AppServer>>>,
}

#[derive(Default)]
struct ClaudeState {
    turns: Arc<Mutex<HashMap<String, Arc<ClaudeTurn>>>>,
    authenticated: AtomicBool,
}

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
    subagents_enabled: bool,
    subagent_max: usize,
    custom_agents: Vec<ClaudeAgentInput>,
    skills_plugin_path: Option<String>,
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
        let _ = self.child.lock().await.kill().await;
    }

    async fn close_input(&self) {
        self.alive.store(false, Ordering::Release);
        let _ = self.stdin.lock().await.shutdown().await;
    }
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

/// Shared SQLite connection, opened once at startup with DDL applied.
/// Locked with a std::sync::Mutex and only used inside spawn_blocking.
struct StateDb {
    connection: Arc<std::sync::Mutex<Connection>>,
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

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalSkillFile {
    path: String,
    relative_path: String,
    file_name: String,
    default_name: String,
    description: String,
    supporting_markdown_count: usize,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SkillBridgeConfig {
    source_path: String,
    name: String,
    enabled: bool,
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

async fn write_runtime_config(codex_home: &PathBuf) -> Result<(), String> {
    tokio::fs::create_dir_all(codex_home)
        .await
        .map_err(|error| format!("Could not create OpenKiwi runtime directory: {error}"))?;

    let config_path = codex_home.join("config.toml");
    if tokio::fs::try_exists(&config_path).await.unwrap_or(false) {
        return Ok(());
    }

    let config = r#"cli_auth_credentials_store = "keyring"
model_provider = "openai"
project_doc_max_bytes = 0
project_doc_fallback_filenames = []
developer_instructions = ""

[agents]
max_threads = 1
max_depth = 1

[features]
multi_agent = false

[model_providers.openrouter]
name = "OpenRouter"
base_url = "https://openrouter.ai/api/v1"
env_key = "OPENROUTER_API_KEY"
env_key_instructions = "Add your OpenRouter API key in OpenKiwi Settings."
wire_api = "responses"
"#;

    tokio::fs::write(config_path, config)
        .await
        .map_err(|error| format!("Could not write OpenKiwi runtime configuration: {error}"))
}

fn find_on_path(program: &str) -> Option<PathBuf> {
    env::var_os("PATH").and_then(|path| {
        env::split_paths(&path)
            .map(|directory| directory.join(program))
            .find(|candidate| candidate.is_file())
    })
}

fn push_candidate(candidates: &mut Vec<PathBuf>, candidate: PathBuf) {
    if !candidates.contains(&candidate) {
        candidates.push(candidate);
    }
}

#[cfg(target_os = "macos")]
async fn find_with_login_shell(program: &str) -> Option<PathBuf> {
    let shell = env::var_os("SHELL").unwrap_or_else(|| OsString::from("/bin/zsh"));
    let output = Command::new(shell)
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
            ".cargo/bin/codex",
            ".npm-global/bin/codex",
            ".bun/bin/codex",
            ".volta/bin/codex",
        ] {
            push_candidate(&mut candidates, home.join(relative));
        }
    }

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
    let output = Command::new(path)
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
        Err(_) => CodexRuntimeStatus {
            available: false,
            source: None,
            path: None,
            version: None,
            compatible: false,
            warning: None,
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
            ".npm-global/bin/claude",
            ".bun/bin/claude",
            ".volta/bin/claude",
        ] {
            push_candidate(&mut candidates, home.join(relative));
        }
    }
    if let Some(candidate) = candidates.into_iter().find(|candidate| candidate.is_file()) {
        return Ok(candidate);
    }
    if let Some(candidate) = find_with_login_shell(executable_name).await {
        return Ok(candidate);
    }

    Err("OpenKiwi could not find Claude Code. Install Claude Code, sign in with `claude auth login`, then try again. Advanced users can set OPENKIWI_CLAUDE_PATH.".into())
}

fn subscription_only_command(path: &Path) -> Command {
    let mut command = Command::new(path);
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

async fn read_claude_runtime_status(app: &AppHandle) -> ClaudeRuntimeStatus {
    let warning = claude_credential_override_present()
    .then(|| "OpenKiwi ignores Anthropic credential, proxy, and hosted-provider environment overrides for Claude subscription sessions, so this provider uses only your Claude Code login.".to_string());
    let Ok(path) = resolve_claude_binary(app).await else {
        return ClaudeRuntimeStatus {
            available: false,
            path: None,
            version: None,
            logged_in: false,
            auth_method: None,
            email: None,
            subscription_type: None,
            warning,
        };
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
            .map_err(|error| format!("Could not open Claude Code sign-in in Terminal: {error}"))?;
        return status.success().then_some(()).ok_or_else(|| {
            "Could not open Terminal. Run `claude auth login` yourself, then refresh Claude status."
                .into()
        });
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = path;
        Err("Run `claude auth login` in a terminal, then refresh Claude status in OpenKiwi.".into())
    }
}

fn unix_timestamp_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(i64::MAX)
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

fn state_db_path(app: &AppHandle) -> Result<PathBuf, String> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Could not resolve OpenKiwi app data: {error}"))?;
    std::fs::create_dir_all(&app_data)
        .map_err(|error| format!("Could not create OpenKiwi app data: {error}"))?;
    Ok(app_data.join("openkiwi.sqlite3"))
}

fn open_state_db(path: &Path) -> Result<Connection, String> {
    let connection = Connection::open(path)
        .map_err(|error| format!("Could not open OpenKiwi state database: {error}"))?;
    connection
        .execute_batch(
            "PRAGMA journal_mode=WAL;
             PRAGMA synchronous=NORMAL;
             PRAGMA busy_timeout=5000;
             CREATE TABLE IF NOT EXISTS app_state (
               key TEXT PRIMARY KEY,
               value TEXT NOT NULL,
               updated_at INTEGER NOT NULL
             );
             CREATE TABLE IF NOT EXISTS audit_events (
               id INTEGER PRIMARY KEY AUTOINCREMENT,
               created_at INTEGER NOT NULL,
               kind TEXT NOT NULL,
               thread_id TEXT,
               payload TEXT NOT NULL
             );
             CREATE INDEX IF NOT EXISTS audit_events_created_at ON audit_events(created_at DESC);",
        )
        .map_err(|error| format!("Could not initialize OpenKiwi state database: {error}"))?;
    Ok(connection)
}

fn shared_state_db(app: &AppHandle) -> Result<Arc<std::sync::Mutex<Connection>>, String> {
    app.try_state::<StateDb>()
        .map(|db| db.connection.clone())
        .ok_or_else(|| "OpenKiwi state database is not initialized".to_string())
}

fn lock_state_db(
    connection: &std::sync::Mutex<Connection>,
) -> Result<std::sync::MutexGuard<'_, Connection>, String> {
    connection
        .lock()
        .map_err(|_| "OpenKiwi state database is unavailable".to_string())
}

#[tauri::command]
async fn state_read(app: AppHandle, key: String) -> Result<Option<Value>, String> {
    let connection = shared_state_db(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let connection = lock_state_db(&connection)?;
        match connection.query_row(
            "SELECT value FROM app_state WHERE key = ?1",
            params![key],
            |row| row.get::<_, String>(0),
        ) {
            Ok(json) => serde_json::from_str(&json)
                .map(Some)
                .map_err(|error| format!("Stored OpenKiwi state is invalid: {error}")),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(error) => Err(format!("Could not read OpenKiwi state: {error}")),
        }
    })
    .await
    .map_err(|error| format!("State read task failed: {error}"))?
}

#[tauri::command]
async fn state_write(app: AppHandle, key: String, value: Value) -> Result<(), String> {
    let connection = shared_state_db(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let connection = lock_state_db(&connection)?;
        let json = serde_json::to_string(&value).map_err(|error| format!("Could not encode OpenKiwi state: {error}"))?;
        connection
            .execute(
                "INSERT INTO app_state(key, value, updated_at) VALUES (?1, ?2, ?3)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
                params![key, json, unix_timestamp_ms()],
            )
            .map_err(|error| format!("Could not save OpenKiwi state: {error}"))?;
        Ok(())
    })
    .await
    .map_err(|error| format!("State write task failed: {error}"))?
}

#[tauri::command]
async fn state_delete(app: AppHandle, key: String) -> Result<(), String> {
    let connection = shared_state_db(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let connection = lock_state_db(&connection)?;
        connection
            .execute("DELETE FROM app_state WHERE key = ?1", params![key])
            .map_err(|error| format!("Could not delete OpenKiwi state: {error}"))?;
        Ok(())
    })
    .await
    .map_err(|error| format!("State delete task failed: {error}"))?
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

fn claude_user_message(
    thread_id: &str,
    prompt: &str,
    attachments: &[ClaudeAttachment],
) -> Result<Value, String> {
    use base64::Engine as _;

    let mut content = vec![json!({ "type": "text", "text": prompt })];
    for attachment in attachments {
        let path = PathBuf::from(&attachment.path);
        if attachment.kind == "image" {
            let bytes = fs::read(&path)
                .map_err(|error| format!("Could not read {}: {error}", path.display()))?;
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

#[tauri::command]
async fn claude_turn_start(
    app: AppHandle,
    state: State<'_, ClaudeState>,
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
    let mut disallowed = Vec::new();
    if options.permission == "read-only" {
        disallowed.extend([
            "Write",
            "Edit",
            "NotebookEdit",
            "Bash",
            "WebFetch",
            "WebSearch",
        ]);
    }
    if !options.subagents_enabled {
        disallowed.extend([
            "Task",
            "SendMessage",
            "TaskCreate",
            "TaskUpdate",
            "TeamCreate",
        ]);
    }
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
    let mut directories = HashSet::new();
    for attachment in options
        .attachments
        .iter()
        .filter(|attachment| attachment.kind != "image")
    {
        if let Some(parent) = Path::new(&attachment.path).parent() {
            if directories.insert(parent.to_path_buf()) {
                command.arg("--add-dir").arg(parent);
            }
        }
    }

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
    state
        .turns
        .lock()
        .await
        .insert(options.thread_id.clone(), turn.clone());

    let initialize = json!({
        "type": "control_request",
        "request_id": uuid::Uuid::new_v4().to_string(),
        "request": { "subtype": "initialize" }
    });
    if let Err(error) = turn.write(&initialize).await {
        state.turns.lock().await.remove(&options.thread_id);
        turn.shutdown().await;
        return Err(error);
    }
    let user_message =
        claude_user_message(&options.thread_id, &options.prompt, &options.attachments)?;
    if let Err(error) = turn.write(&user_message).await {
        state.turns.lock().await.remove(&options.thread_id);
        turn.shutdown().await;
        return Err(error);
    }

    let stderr_lines = Arc::new(Mutex::new(Vec::<String>::new()));
    let stderr_output = stderr_lines.clone();
    let stderr_task = tauri::async_runtime::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let line = line.trim();
            if !line.is_empty() {
                stderr_output.lock().await.push(line.to_string());
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
        let mut lines = BufReader::new(stdout).lines();
        let mut saw_result = false;
        while let Ok(Some(line)) = lines.next_line().await {
            if let Ok(message) = serde_json::from_str::<Value>(&line) {
                if message.get("type").and_then(Value::as_str) == Some("result") {
                    saw_result = true;
                    // Stream-input mode deliberately waits for another user
                    // message. OpenKiwi uses one process per turn so the next
                    // turn can resume from the persisted Claude session.
                    remove_claude_turn_if_current(&turns, &stdout_thread, &stdout_runtime).await;
                    stdout_runtime.close_input().await;
                }
                emit_claude_event(&stdout_app, &stdout_thread, &stdout_turn, message).await;
            }
        }
        alive.store(false, Ordering::Release);
        remove_claude_turn_if_current(&turns, &stdout_thread, &stdout_runtime).await;
        // Reap the completed child so repeated Claude turns cannot accumulate
        // zombie processes during a long-running OpenKiwi session.
        let exit = stdout_child.lock().await.wait().await.ok();
        let _ = stderr_task.await;
        if !saw_result {
            let stderr = stderr_lines.lock().await.join("\n");
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
    turn.write(&claude_user_message(&thread_id, &prompt, &attachments)?)
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
    turn.write(&json!({
        "type": "control_request",
        "request_id": uuid::Uuid::new_v4().to_string(),
        "request": { "subtype": "interrupt" },
    }))
    .await
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
    Ok(parent.join(file_name))
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

const MAX_SKILL_FILE_BYTES: u64 = 1_048_576;
const MAX_SKILL_SCAN_DEPTH: usize = 8;
const MAX_SKILL_MARKDOWN_FILES: usize = 500;
const MAX_SKILL_MARKDOWN_BYTES: u64 = 16 * 1_048_576;

fn canonical_skill_folder(folder: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(folder);
    let canonical = path
        .canonicalize()
        .map_err(|error| format!("Could not open the skills folder: {error}"))?;
    if !canonical.is_dir() {
        return Err("The selected skills path is not a folder.".into());
    }
    Ok(canonical)
}

fn is_markdown(path: &Path) -> bool {
    path.extension()
        .and_then(|value| value.to_str())
        .is_some_and(|value| {
            value.eq_ignore_ascii_case("md") || value.eq_ignore_ascii_case("markdown")
        })
}

fn collect_skill_candidates(
    root: &Path,
    directory: &Path,
    depth: usize,
    output: &mut Vec<PathBuf>,
) -> Result<(), String> {
    if depth > MAX_SKILL_SCAN_DEPTH {
        return Ok(());
    }
    let mut entries = fs::read_dir(directory)
        .map_err(|error| format!("Could not scan {}: {error}", directory.display()))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Could not scan {}: {error}", directory.display()))?;
    entries.sort_by_key(|entry| entry.file_name());

    for entry in entries {
        let path = entry.path();
        let name = entry.file_name();
        if name.to_string_lossy().starts_with('.') {
            continue;
        }
        let file_type = entry
            .file_type()
            .map_err(|error| format!("Could not inspect {}: {error}", path.display()))?;
        if file_type.is_symlink() {
            continue;
        }
        if file_type.is_file() && is_markdown(&path) {
            let top_level_markdown = directory == root;
            let packaged_skill = path
                .file_name()
                .and_then(|value| value.to_str())
                .is_some_and(|value| value.eq_ignore_ascii_case("SKILL.md"));
            if top_level_markdown || packaged_skill {
                output.push(path);
            }
        } else if file_type.is_dir() {
            collect_skill_candidates(root, &path, depth + 1, output)?;
        }
    }
    Ok(())
}

fn split_skill_markdown(content: &str) -> (Option<String>, &str) {
    if !content.starts_with("---\n") && !content.starts_with("---\r\n") {
        return (None, content);
    }
    let normalized = content.replace("\r\n", "\n");
    let Some(end) = normalized[4..].find("\n---\n").map(|index| index + 4) else {
        return (None, content);
    };
    let frontmatter = &normalized[4..end];
    let description = frontmatter.lines().find_map(|line| {
        let (key, value) = line.split_once(':')?;
        if !key.trim().eq_ignore_ascii_case("description") {
            return None;
        }
        let value = value.trim().trim_matches(['\'', '"']);
        (!value.is_empty()).then(|| value.to_string())
    });
    let body_offset = end + "\n---\n".len();
    let body = if content.contains("\r\n") {
        // Offset calculations above used normalized newlines. Find the second
        // delimiter in the original text instead so the returned slice is valid.
        let delimiter = "\r\n---\r\n";
        content
            .strip_prefix("---\r\n")
            .and_then(|rest| {
                rest.find(delimiter)
                    .map(|index| &rest[index + delimiter.len()..])
            })
            .unwrap_or(content)
    } else {
        content.get(body_offset..).unwrap_or(content)
    };
    (description, body)
}

fn skill_description(content: &str, fallback: &str) -> String {
    let (declared, body) = split_skill_markdown(content);
    if let Some(description) = declared {
        return description.chars().take(240).collect();
    }
    let paragraph = body
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with('#') && !line.starts_with("<!--"))
        .take(3)
        .collect::<Vec<_>>()
        .join(" ");
    if paragraph.is_empty() {
        format!("Instructions from {fallback}")
    } else {
        paragraph.chars().take(240).collect()
    }
}

fn skill_default_name(path: &Path) -> String {
    let is_package = path
        .file_name()
        .and_then(|value| value.to_str())
        .is_some_and(|value| value.eq_ignore_ascii_case("SKILL.md"));
    let raw = if is_package {
        path.parent().and_then(Path::file_name)
    } else {
        path.file_stem()
    };
    normalize_skill_name(raw.and_then(|value| value.to_str()).unwrap_or("skill"))
}

fn normalize_skill_name(value: &str) -> String {
    let mut output = String::new();
    let mut pending_dash = false;
    for character in value.trim().to_lowercase().chars() {
        if character.is_ascii_alphanumeric() {
            if pending_dash && !output.is_empty() {
                output.push('-');
            }
            pending_dash = false;
            output.push(character);
        } else {
            pending_dash = true;
        }
        if output.len() >= 64 {
            break;
        }
    }
    output.trim_matches('-').to_string()
}

fn count_markdown_references(content: &str, source: &Path, folder: &Path) -> usize {
    let source_directory = source.parent().unwrap_or(folder);
    let canonical_folder = folder
        .canonicalize()
        .unwrap_or_else(|_| folder.to_path_buf());
    let canonical_source = source
        .canonicalize()
        .unwrap_or_else(|_| source.to_path_buf());
    let mut remaining = content;
    let mut references = std::collections::HashSet::new();
    while let Some(start) = remaining.find("](") {
        remaining = &remaining[start + 2..];
        let Some(end) = remaining.find(')') else {
            break;
        };
        let target = remaining[..end].trim().trim_matches(['<', '>']);
        remaining = &remaining[end + 1..];
        let path_text = target.split(['#', '?']).next().unwrap_or_default().trim();
        if path_text.is_empty() || path_text.contains("://") || path_text.starts_with("mailto:") {
            continue;
        }
        let candidate = source_directory.join(path_text);
        let Ok(candidate) = candidate.canonicalize() else {
            continue;
        };
        if candidate.starts_with(&canonical_folder)
            && candidate.is_file()
            && is_markdown(&candidate)
            && candidate != canonical_source
        {
            references.insert(candidate);
        }
    }
    references.len()
}

fn scan_local_skills(folder: &Path) -> Result<Vec<LocalSkillFile>, String> {
    let mut candidates = Vec::new();
    collect_skill_candidates(folder, folder, 0, &mut candidates)?;
    let mut skills = Vec::new();
    for path in candidates.into_iter().take(MAX_SKILL_MARKDOWN_FILES) {
        let metadata = fs::metadata(&path)
            .map_err(|error| format!("Could not inspect {}: {error}", path.display()))?;
        if metadata.len() > MAX_SKILL_FILE_BYTES {
            continue;
        }
        let content = fs::read_to_string(&path)
            .map_err(|error| format!("Could not read {}: {error}", path.display()))?;
        let file_name = path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("skill.md")
            .to_string();
        let supporting_markdown_count = count_markdown_references(&content, &path, folder);
        skills.push(LocalSkillFile {
            path: path.to_string_lossy().into_owned(),
            relative_path: path
                .strip_prefix(folder)
                .unwrap_or(&path)
                .to_string_lossy()
                .into_owned(),
            file_name: file_name.clone(),
            default_name: skill_default_name(&path),
            description: skill_description(&content, &file_name),
            supporting_markdown_count,
        });
    }
    skills.sort_by(|left, right| {
        left.default_name
            .cmp(&right.default_name)
            .then(left.path.cmp(&right.path))
    });
    Ok(skills)
}

fn copy_markdown_tree(
    source_root: &Path,
    source_skill: &Path,
    destination: &Path,
    depth: usize,
    count: &mut usize,
    bytes: &mut u64,
) -> Result<(), String> {
    if depth > MAX_SKILL_SCAN_DEPTH
        || *count >= MAX_SKILL_MARKDOWN_FILES
        || *bytes >= MAX_SKILL_MARKDOWN_BYTES
    {
        return Ok(());
    }
    let mut entries = fs::read_dir(source_root)
        .map_err(|error| {
            format!(
                "Could not read skill references in {}: {error}",
                source_root.display()
            )
        })?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| {
            format!(
                "Could not read skill references in {}: {error}",
                source_root.display()
            )
        })?;
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        let path = entry.path();
        let file_type = entry
            .file_type()
            .map_err(|error| format!("Could not inspect {}: {error}", path.display()))?;
        if file_type.is_symlink() || entry.file_name().to_string_lossy().starts_with('.') {
            continue;
        }
        let target = destination.join(entry.file_name());
        if file_type.is_dir() {
            fs::create_dir_all(&target)
                .map_err(|error| format!("Could not prepare skill references: {error}"))?;
            copy_markdown_tree(&path, source_skill, &target, depth + 1, count, bytes)?;
        } else if file_type.is_file() && is_markdown(&path) && path != source_skill {
            let size = entry.metadata().map(|metadata| metadata.len()).unwrap_or(0);
            if size > MAX_SKILL_FILE_BYTES
                || bytes.saturating_add(size) > MAX_SKILL_MARKDOWN_BYTES
                || *count >= MAX_SKILL_MARKDOWN_FILES
            {
                continue;
            }
            if target
                .file_name()
                .and_then(|value| value.to_str())
                .is_some_and(|value| value.eq_ignore_ascii_case("SKILL.md"))
            {
                continue;
            }
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent)
                    .map_err(|error| format!("Could not prepare skill references: {error}"))?;
            }
            fs::copy(&path, &target)
                .map_err(|error| format!("Could not mirror {}: {error}", path.display()))?;
            *count += 1;
            *bytes += size;
        }
    }
    Ok(())
}

fn sync_skill_runtime_at(
    runtime_root: &Path,
    folder: &Path,
    configs: Vec<SkillBridgeConfig>,
) -> Result<(), String> {
    let folder = folder
        .canonicalize()
        .map_err(|error| format!("Could not open the skills folder: {error}"))?;
    if runtime_root.exists() {
        fs::remove_dir_all(runtime_root)
            .map_err(|error| format!("Could not refresh the skill runtime: {error}"))?;
    }
    fs::create_dir_all(runtime_root)
        .map_err(|error| format!("Could not create the skill runtime: {error}"))?;
    fs::create_dir_all(runtime_root.join(".claude-plugin"))
        .map_err(|error| format!("Could not create the Claude skill plugin: {error}"))?;
    fs::create_dir_all(runtime_root.join("skills"))
        .map_err(|error| format!("Could not create the Claude skills directory: {error}"))?;
    fs::write(
        runtime_root.join(".claude-plugin/plugin.json"),
        r#"{"name":"openkiwi-skills","version":"1.0.0","description":"User-selected OpenKiwi skills"}"#,
    )
    .map_err(|error| format!("Could not prepare the Claude skill plugin: {error}"))?;

    let mut used_names = std::collections::HashSet::new();
    for config in configs.into_iter().filter(|config| config.enabled) {
        let source = PathBuf::from(&config.source_path)
            .canonicalize()
            .map_err(|error| format!("Could not open skill {}: {error}", config.source_path))?;
        if !source.starts_with(&folder) || !source.is_file() || !is_markdown(&source) {
            return Err(format!(
                "Skill source is outside the selected folder: {}",
                config.source_path
            ));
        }
        let name = normalize_skill_name(&config.name);
        if name.is_empty() {
            return Err(format!(
                "{} does not have a valid invocation name",
                source.display()
            ));
        }
        if !used_names.insert(name.clone()) {
            return Err(format!(
                "Two enabled skills use the invocation name `{name}`"
            ));
        }

        let content = fs::read_to_string(&source)
            .map_err(|error| format!("Could not read {}: {error}", source.display()))?;
        if content.len() as u64 > MAX_SKILL_FILE_BYTES {
            return Err(format!("{} is larger than 1 MB", source.display()));
        }
        let (declared_description, body) = split_skill_markdown(&content);
        let file_name = source
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("skill.md");
        let description =
            declared_description.unwrap_or_else(|| skill_description(body, file_name));
        let package = runtime_root.join(&name);
        fs::create_dir_all(&package)
            .map_err(|error| format!("Could not create skill `{name}`: {error}"))?;

        let reference_root = if file_name.eq_ignore_ascii_case("SKILL.md") {
            source.parent().unwrap_or(&folder)
        } else {
            &folder
        };
        let mut count = 0;
        let mut bytes = 0;
        copy_markdown_tree(reference_root, &source, &package, 0, &mut count, &mut bytes)?;

        let yaml_name = serde_json::to_string(&name).map_err(|error| error.to_string())?;
        let yaml_description =
            serde_json::to_string(&description.chars().take(500).collect::<String>())
                .map_err(|error| error.to_string())?;
        let bridge = format!(
            "---\nname: {yaml_name}\ndescription: {yaml_description}\n---\n\n<!-- Generated by OpenKiwi from {}. Edit the source file, not this bridge. -->\n\n{}\n",
            source.display(),
            body.trim_start(),
        );
        fs::write(package.join("SKILL.md"), &bridge)
            .map_err(|error| format!("Could not prepare skill `{name}`: {error}"))?;

        let claude_package = runtime_root.join("skills").join(&name);
        fs::create_dir_all(&claude_package)
            .map_err(|error| format!("Could not create Claude skill `{name}`: {error}"))?;
        let mut claude_count = 0;
        let mut claude_bytes = 0;
        copy_markdown_tree(
            reference_root,
            &source,
            &claude_package,
            0,
            &mut claude_count,
            &mut claude_bytes,
        )?;
        fs::write(claude_package.join("SKILL.md"), &bridge)
            .map_err(|error| format!("Could not prepare Claude skill `{name}`: {error}"))?;
    }
    Ok(())
}

fn sync_skill_runtime(
    app: &AppHandle,
    folder: &Path,
    configs: Vec<SkillBridgeConfig>,
) -> Result<PathBuf, String> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Could not resolve OpenKiwi app data: {error}"))?;
    let runtime_root = app_data.join("skill-runtime");
    sync_skill_runtime_at(&runtime_root, folder, configs)?;
    Ok(runtime_root)
}

#[tauri::command]
async fn local_skills_scan(folder: String) -> Result<Vec<LocalSkillFile>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let folder = canonical_skill_folder(&folder)?;
        scan_local_skills(&folder)
    })
    .await
    .map_err(|error| format!("Skill scan failed: {error}"))?
}

#[tauri::command]
async fn local_skills_sync(
    app: AppHandle,
    folder: String,
    skills: Vec<SkillBridgeConfig>,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let folder = canonical_skill_folder(&folder)?;
        sync_skill_runtime(&app, &folder, skills).map(|path| path.to_string_lossy().into_owned())
    })
    .await
    .map_err(|error| format!("Skill preparation failed: {error}"))?
}

fn available_import_path(folder: &Path, source_name: &str) -> PathBuf {
    let stem = Path::new(source_name)
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("skill");
    let extension = Path::new(source_name)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("md");
    let initial = folder.join(source_name);
    if !initial.exists() {
        return initial;
    }
    for index in 2..10_000 {
        let candidate = folder.join(format!("{stem}-{index}.{extension}"));
        if !candidate.exists() {
            return candidate;
        }
    }
    folder.join(format!("{stem}-imported.{extension}"))
}

#[tauri::command]
async fn local_skills_import(folder: String, paths: Vec<String>) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let folder = canonical_skill_folder(&folder)?;
        let mut imported = Vec::new();
        for raw in paths {
            let source = PathBuf::from(&raw)
                .canonicalize()
                .map_err(|error| format!("Could not open {raw}: {error}"))?;
            if !source.is_file() || !is_markdown(&source) {
                return Err(format!("Only Markdown files can be imported: {raw}"));
            }
            let size = fs::metadata(&source)
                .map(|metadata| metadata.len())
                .unwrap_or(MAX_SKILL_FILE_BYTES + 1);
            if size > MAX_SKILL_FILE_BYTES {
                return Err(format!("{} is larger than 1 MB", source.display()));
            }
            if source.parent().is_some_and(|parent| parent == folder) {
                imported.push(source.to_string_lossy().into_owned());
                continue;
            }
            let name = source
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("skill.md");
            let destination = available_import_path(&folder, name);
            fs::copy(&source, &destination)
                .map_err(|error| format!("Could not import {}: {error}", source.display()))?;
            imported.push(destination.to_string_lossy().into_owned());
        }
        Ok(imported)
    })
    .await
    .map_err(|error| format!("Skill import failed: {error}"))?
}

#[tauri::command]
async fn local_skills_create(
    folder: String,
    name: String,
    instructions: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let folder = canonical_skill_folder(&folder)?;
        let invocation_name = normalize_skill_name(&name);
        if invocation_name.is_empty() {
            return Err("Enter a skill name containing letters or numbers.".into());
        }
        if instructions.trim().is_empty() {
            return Err("Enter instructions for the skill.".into());
        }
        if instructions.len() as u64 > MAX_SKILL_FILE_BYTES {
            return Err("Skill instructions must be smaller than 1 MB.".into());
        }
        let destination = available_import_path(&folder, &format!("{invocation_name}.md"));
        let title = name.trim();
        let content = format!("# {title}\n\n{}\n", instructions.trim());
        fs::write(&destination, content)
            .map_err(|error| format!("Could not create the skill: {error}"))?;
        Ok(destination.to_string_lossy().into_owned())
    })
    .await
    .map_err(|error| format!("Skill creation failed: {error}"))?
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
    write_runtime_config(&codex_home).await?;

    let codex_binary = resolve_codex_binary(app).await?;
    let home = app.path().home_dir().ok();

    let mut command = Command::new(&codex_binary);
    command
        .arg("app-server")
        .env("CODEX_HOME", &codex_home)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);

    let mut openrouter_proxy_url = None;
    let mut openrouter_proxy_task = None;
    if let Some(key) = openrouter_key().await {
        let (proxy_url, task) = start_openrouter_proxy(key.clone()).await?;
        let proxy_url_toml = serde_json::to_string(&proxy_url)
            .map_err(|error| format!("Could not configure OpenRouter compatibility: {error}"))?;
        command
            .arg("-c")
            .arg(format!(
                "model_providers.openrouter.base_url={proxy_url_toml}"
            ))
            .env("OPENROUTER_API_KEY", key);
        openrouter_proxy_url = Some(proxy_url);
        openrouter_proxy_task = Some(task);
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
        pending,
        next_id: AtomicI64::new(1),
        alive,
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
    Ok(server)
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
        "account/usage/read",
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
        "thread/settings/update",
        "thread/compact/start",
        "thread/backgroundTerminals/list",
        "thread/backgroundTerminals/clean",
        "thread/backgroundTerminals/terminate",
        "turn/start",
        "turn/steer",
        "turn/interrupt",
        "review/start",
        "command/exec",
        "command/exec/write",
        "command/exec/resize",
        "command/exec/terminate",
        "process/spawn",
        "process/writeStdin",
        "process/resizePty",
        "process/kill",
        "skills/list",
        "skills/config/write",
        "skills/extraRoots/set",
        "mcpServerStatus/list",
        "mcpServer/oauth/login",
        "mcpServer/resource/read",
        "mcpServer/tool/call",
        "config/mcpServer/reload",
        "config/read",
        "config/value/write",
        "config/batchWrite",
        "modelProvider/capabilities/read",
        "permissionProfile/list",
        "experimentalFeature/list",
        "experimentalFeature/enablement/set",
        "gitDiffToRemote",
        "fs/readFile",
        "fs/writeFile",
        "fs/readDirectory",
        "fs/getMetadata",
        "fuzzyFileSearch",
        "fuzzyFileSearch/sessionStart",
        "fuzzyFileSearch/sessionUpdate",
        "fuzzyFileSearch/sessionStop",
    ];
    // Methods that are safe to transparently re-send after the runtime is
    // respawned. Everything else (turn/start, command/exec, config writes, …)
    // may already have taken effect before the connection died, so an
    // automatic retry could run the action twice.
    const RETRYABLE_METHODS: &[&str] = &[
        "account/read",
        "account/rateLimits/read",
        "account/usage/read",
        "model/list",
        "thread/list",
        "thread/read",
        "thread/search",
        "skills/list",
        "mcpServerStatus/list",
        "config/read",
        "modelProvider/capabilities/read",
        "permissionProfile/list",
        "experimentalFeature/list",
        "gitDiffToRemote",
        "fs/readFile",
        "fs/readDirectory",
        "fs/getMetadata",
        "fuzzyFileSearch",
    ];
    if !ALLOWED_METHODS.contains(&method.as_str()) {
        return Err(format!(
            "OpenKiwi's desktop bridge does not allow the RPC method `{method}`"
        ));
    }
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
    app: AppHandle,
    state: State<'_, RuntimeState>,
    id: Value,
    result: Value,
) -> Result<(), String> {
    let server = ensure_server(&app, &state).await?;
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
            Ok(mut guard) => guard.take(),
            Err(_) => None,
        }
    });
    let Some(server) = server else { return };
    let graceful = tauri::async_runtime::block_on(async {
        timeout(Duration::from_secs(2), server.shutdown())
            .await
            .is_ok()
    });
    if !graceful {
        // Last resort: signal the child by pid without touching any locks.
        if let Some(pid) = server.pid {
            #[cfg(unix)]
            let _ = std::process::Command::new("kill")
                .args(["-9", &pid.to_string()])
                .status();
            #[cfg(windows)]
            let _ = std::process::Command::new("taskkill")
                .args(["/PID", &pid.to_string(), "/T", "/F"])
                .status();
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
                #[cfg(unix)]
                let _ = std::process::Command::new("kill")
                    .args(["-9", &pid.to_string()])
                    .status();
                #[cfg(windows)]
                let _ = std::process::Command::new("taskkill")
                    .args(["/PID", &pid.to_string(), "/T", "/F"])
                    .status();
            }
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // reqwest and the updater share the same provider-less rustls stack.
    // Install Ring before either subsystem creates its first HTTP client.
    let _ = rustls::crypto::ring::default_provider().install_default();

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
            Ok(())
        })
        .manage(RuntimeState::default())
        .manage(ClaudeState::default())
        .invoke_handler(tauri::generate_handler![
            codex_runtime_status,
            claude_runtime_status,
            claude_login,
            claude_turn_start,
            claude_turn_steer,
            claude_turn_interrupt,
            claude_permission_respond,
            state_read,
            state_write,
            state_delete,
            audit_append,
            audit_recent,
            diagnostics_read,
            diagnostics_export,
            export_text_file,
            local_skills_scan,
            local_skills_sync,
            local_skills_import,
            local_skills_create,
            normal_chat_workspace,
            codex_rpc,
            codex_respond,
            save_openrouter_key,
            save_pasted_image,
            has_openrouter_key,
            list_openrouter_models,
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
            }
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pasted_image_cleanup_expires_old_files_and_preserves_the_current_paste() {
        let current = PathBuf::from("current.png");
        let candidates = vec![
            PastedImageCandidate {
                path: PathBuf::from("expired.png"),
                modified_at_ms: 10,
                size: 2,
            },
            PastedImageCandidate {
                path: current.clone(),
                modified_at_ms: 10,
                size: 2,
            },
            PastedImageCandidate {
                path: PathBuf::from("recent.png"),
                modified_at_ms: 95,
                size: 2,
            },
        ];
        let removed = pasted_image_removal_plan(candidates, 100, 20, 100, Some(&current));
        assert_eq!(removed, vec![PathBuf::from("expired.png")]);
    }

    #[test]
    fn pasted_image_cleanup_removes_oldest_files_until_under_the_size_cap() {
        let candidates = vec![
            PastedImageCandidate {
                path: PathBuf::from("oldest.png"),
                modified_at_ms: 80,
                size: 4,
            },
            PastedImageCandidate {
                path: PathBuf::from("middle.png"),
                modified_at_ms: 90,
                size: 4,
            },
            PastedImageCandidate {
                path: PathBuf::from("newest.png"),
                modified_at_ms: 100,
                size: 4,
            },
        ];
        let removed = pasted_image_removal_plan(candidates, 100, 1_000, 8, None);
        assert_eq!(removed, vec![PathBuf::from("oldest.png")]);
    }

    #[test]
    fn initialize_negotiates_fields_used_by_project_threads() {
        let params = initialize_params();
        assert_eq!(
            params.pointer("/capabilities/experimentalApi"),
            Some(&Value::Bool(true))
        );
        assert_eq!(
            params.pointer("/capabilities/mcpServerOpenaiFormElicitation"),
            Some(&Value::Bool(true))
        );
        assert_eq!(
            params.pointer("/capabilities/requestAttestation"),
            Some(&Value::Bool(false))
        );
    }

    #[test]
    fn runtime_compatibility_accepts_tested_contract() {
        assert!(runtime_is_compatible("codex-cli 0.145.0-alpha.18"));
        assert!(!runtime_is_compatible("codex-cli 0.144.9"));
    }

    #[test]
    fn claude_auth_status_tolerates_terminal_wrapping() {
        let wrapped = br#"{
          "loggedIn": true,
          "email": "a-very-long-address@
          example.com",
          "subscriptionType": "max"
        }"#;
        let parsed = parse_claude_auth_status(wrapped).unwrap();
        assert_eq!(parsed.get("loggedIn"), Some(&Value::Bool(true)));
        assert_eq!(
            parsed.get("email").and_then(Value::as_str),
            Some("a-very-long-address@example.com")
        );
    }

    #[test]
    fn openrouter_schema_sanitizer_removes_only_missing_required_properties() {
        let mut request = json!({
            "tools": [{
                "type": "function",
                "name": "render_artifact",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "snapshot": {
                            "type": "object",
                            "properties": { "path": { "type": "string" } },
                            "required": ["path", "manifest"]
                        }
                    },
                    "required": ["snapshot", "unknown"]
                }
            }]
        });

        assert_eq!(sanitize_json_schema(&mut request), 2);
        assert_eq!(
            request.pointer("/tools/0/parameters/required"),
            Some(&json!(["snapshot"]))
        );
        assert_eq!(
            request.pointer("/tools/0/parameters/properties/snapshot/required"),
            Some(&json!(["path"]))
        );
    }

    #[test]
    fn openrouter_schema_sanitizer_drops_required_without_properties() {
        let mut schema = json!({ "type": "object", "required": ["ghost"] });
        assert_eq!(sanitize_json_schema(&mut schema), 1);
        assert!(schema.get("required").is_none());
    }

    #[test]
    fn openrouter_proxy_is_injected_into_thread_config() {
        let mut params = json!({
            "modelProvider": "openrouter",
            "config": { "features": { "apps": false } }
        });
        inject_openrouter_proxy_config(&mut params, Some("http://127.0.0.1:3210/token"));
        assert_eq!(
            params.pointer("/config/model_providers/openrouter/base_url"),
            Some(&json!("http://127.0.0.1:3210/token"))
        );
        assert_eq!(params.pointer("/config/features/apps"), Some(&json!(false)));
    }

    #[test]
    fn openrouter_proxy_is_not_injected_into_openai_threads() {
        let mut params = json!({ "modelProvider": "openai", "config": {} });
        inject_openrouter_proxy_config(&mut params, Some("http://127.0.0.1:3210/token"));
        assert!(params.pointer("/config/model_providers").is_none());
    }

    fn skill_test_directory(label: &str) -> PathBuf {
        env::temp_dir().join(format!(
            "openkiwi-{label}-{}-{}",
            std::process::id(),
            unix_timestamp_ms()
        ))
    }

    #[test]
    fn local_skill_scan_uses_top_level_markdown_and_nested_skill_packages() {
        let root = skill_test_directory("skill-scan");
        fs::create_dir_all(root.join("references")).unwrap();
        fs::create_dir_all(root.join("packaged")).unwrap();
        fs::write(
            root.join("review.md"),
            "# Review\n\nReview changes carefully.\n\nRead [details](references/details.md).\n",
        )
        .unwrap();
        fs::write(
            root.join("references/details.md"),
            "# Details\n\nCheck edge cases.\n",
        )
        .unwrap();
        fs::write(root.join("packaged/SKILL.md"), "---\nname: ignored-source-name\ndescription: Package description\n---\n\nRun the package workflow.\n").unwrap();
        fs::write(root.join("packaged/guide.md"), "# Guide\n").unwrap();

        let skills = scan_local_skills(&root).unwrap();
        assert_eq!(skills.len(), 2);
        assert_eq!(
            skills
                .iter()
                .map(|skill| skill.default_name.as_str())
                .collect::<Vec<_>>(),
            vec!["packaged", "review"]
        );
        assert_eq!(skills[0].description, "Package description");
        assert!(
            skills
                .iter()
                .find(|skill| skill.default_name == "review")
                .unwrap()
                .supporting_markdown_count
                >= 1
        );

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn skill_runtime_bridge_preserves_app_name_body_and_markdown_references() {
        let root = skill_test_directory("skill-runtime-source");
        let runtime = skill_test_directory("skill-runtime-output");
        fs::create_dir_all(root.join("references")).unwrap();
        let source = root.join("Release Notes.md");
        fs::write(&source, "---\nname: source-name\ndescription: Publish a careful release.\n---\n\n# Release\n\nRead [checks](references/checks.md), then publish.\n").unwrap();
        fs::write(
            root.join("references/checks.md"),
            "# Checks\n\nRun the tests.\n",
        )
        .unwrap();

        sync_skill_runtime_at(
            &runtime,
            &root,
            vec![SkillBridgeConfig {
                source_path: source.to_string_lossy().into_owned(),
                name: "ship-release".into(),
                enabled: true,
            }],
        )
        .unwrap();

        let bridge = fs::read_to_string(runtime.join("ship-release/SKILL.md")).unwrap();
        assert!(bridge.contains("name: \"ship-release\""));
        assert!(bridge.contains("description: \"Publish a careful release.\""));
        assert!(bridge.contains("# Release"));
        assert!(!bridge.contains("name: source-name"));
        assert!(runtime.join("ship-release/references/checks.md").is_file());
        assert!(runtime.join(".claude-plugin/plugin.json").is_file());
        assert!(runtime.join("skills/ship-release/SKILL.md").is_file());
        assert!(runtime
            .join("skills/ship-release/references/checks.md")
            .is_file());

        fs::remove_dir_all(root).unwrap();
        fs::remove_dir_all(runtime).unwrap();
    }
}
