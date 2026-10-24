use std::{
    collections::{HashMap, HashSet},
    env,
    ffi::OsString,
    fs,
    future::Future,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        atomic::{AtomicBool, AtomicI64, Ordering},
        Arc, Mutex as StdMutex, RwLock, Weak,
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
use futures_util::TryStreamExt;
use rusqlite::params;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::{
    io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, Command},
    sync::{oneshot, watch, Mutex},
    time::{timeout, timeout_at, Duration, Instant},
};
use unicode_segmentation::UnicodeSegmentation;

mod agents;
mod close_guard;
mod cursor;
mod file_preview;
mod git_inspection;
mod git_publish;
mod git_workspace;
mod github;
mod github_pr;
mod language_framing;
mod language_queries;
mod language_recipes;
mod language_tools;
#[cfg(target_os = "macos")]
mod macos_text;
mod normal_chat;
mod official_skills;
mod openrouter_usage;
mod persistence;
mod tray;
mod preference_learning;
mod pricing_sources;
mod process_launch;
mod project_git;
mod provider_auth;
mod release_qa;
mod run_discovery;
mod skills;
mod spelling;
mod instruction_files;
mod startup_guard;
mod transcription;
mod workspace_folder;
use agents::{
    child_agent_bridge_config_allows_spawning, child_agent_bridge_config_registered,
    child_agent_bridge_mailbox_control_response,
    child_agent_claim_spawn, child_agent_finished, child_agent_reactivate, child_agent_request_active,
    child_agent_respond, child_agent_retire_unclaimed_spawns, child_agent_revoke_root_registration,
    child_agent_session_end, child_agent_session_start,
    purge_stale_agent_bridges, run_agent_bridge, shutdown_agent_bridges_on_exit, ChildAgentState,
    AGENT_BRIDGE_ARG,
};
use close_guard::{close_guard_claim, close_guard_finish, CloseGuardState};
use cursor::{
    cursor_login, cursor_models, cursor_permission_respond, cursor_runtime_status,
    cursor_turn_active, cursor_turn_interrupt, cursor_turn_kill, cursor_turn_start,
    cursor_turn_steer, cursor_turn_state, shutdown_cursor_on_exit, CursorState,
};
use git_inspection::{
    git_project_changes, git_project_diff, git_project_file_diff, git_project_history,
};
use git_publish::{git_publish_commit, git_publish_snapshot};
use git_workspace::{
    git_workspace_branch, git_workspace_commit, git_workspace_fetch, git_workspace_pull,
    git_workspace_push, git_workspace_revert, git_workspace_revert_all,
    git_workspace_revert_all_preview, git_workspace_revert_preview, git_workspace_snapshot,
    git_workspace_stage, git_workspace_update,
};
use github::{
    github_attach_remote, github_clone_repository, github_create_repository, github_login,
    github_repo_status, github_status,
};
use github_pr::{
    github_pr_branch, github_pr_context, github_pr_create, github_pr_find, github_pr_list,
    github_pr_merge, github_pr_ready, github_pr_view,
};
use official_skills::{local_skills_catalog, local_skills_install_official};
use persistence::{
    local_transcript_full_read, local_transcript_list, local_transcript_metadata_write,
    local_transcript_page_read, local_transcript_rename, local_transcript_snapshot_write,
    local_transcript_tail_write, local_transcript_write_state_read, lock_state_db,
    open_state_db_or_quarantine, shared_state_db, state_db_path, state_delete, state_read,
    state_read_raw, state_write, StateDb,
};
#[cfg(windows)]
use process_launch::interactive_command;
use process_launch::background_command;
#[cfg(windows)]
use process_launch::background_std_command;
use project_git::{
    checkpoint_complete, checkpoint_create, checkpoint_delete, checkpoint_diff, checkpoint_restore,
    git_common_dir, git_runtime_path, git_stdout, optional_git_stdout, unix_timestamp_ms,
    workspace_git_auto_initialize, workspace_git_info, workspace_git_initialize,
    worktree_apply_to_source, worktree_create,
    worktree_merge_branch, worktree_recreate, worktree_remove, worktree_set_applied_baseline,
    worktree_status,
};
use run_discovery::{
    run_discovery_cancel, run_discovery_start, shutdown_run_discoveries_on_exit, RunDiscoveryState,
};
use skills::{
    local_skills_analyze_prompts, local_skills_create, local_skills_delete, local_skills_import,
    local_skills_mention_names, local_skills_read, local_skills_resolve_prompt,
    local_skills_resolve_prompts, local_skills_scan, local_skills_sync, local_skills_update,
    normalize_skill_name,
};
use startup_guard::{startup_failed, startup_ready, StartupGuardState};

const KEYRING_SERVICE: &str = "com.kiwi.harness";
const OPENROUTER_ACCOUNT: &str = "openrouter-api-key";
const LMSTUDIO_ACCOUNT: &str = "lmstudio-api-key";
const KEYRING_READ_TIMEOUT: Duration = Duration::from_secs(4);
static OPENROUTER_KEY_READ: KeyringReadSlot = KeyringReadSlot(StdMutex::new(None));
static LMSTUDIO_KEY_READ: KeyringReadSlot = KeyringReadSlot(StdMutex::new(None));

type PendingMap = Arc<Mutex<HashMap<i64, oneshot::Sender<Result<Value, String>>>>>;

fn provider_error_text(message: &str) -> String {
    // These disposition tags belong to the native transport, never upstream
    // provider text. Do not let an upstream refusal impersonate a safe retry.
    message.replace("MYTHRA_NOT_DISPATCHED:", "Provider reported not-dispatched:")
        .replace("MYTHRA_DELIVERY_UNCERTAIN:", "Provider reported delivery-uncertain:")
}

fn native_predispatch_refusal(error: String) -> String {
    format!("MYTHRA_NOT_DISPATCHED: {}", provider_error_text(&error))
}

// The pipe lock and a blocked write share a bounded deadline even when a
// deliberately long-lived command has no response deadline.
async fn write_server_message<W: AsyncWrite + Unpin>(
    stdin: &Mutex<W>,
    message: &[u8],
    deadline: Instant,
) -> Result<(), String> {
    timeout_at(deadline, async {
        let mut stdin = stdin.lock().await;
        stdin.write_all(message).await?;
        stdin.flush().await
    })
    .await
    .map_err(|_| "Codex App Server timed out while writing input".to_string())?
    .map_err(|error: std::io::Error| format!("Could not write Codex App Server input: {error}"))
}

fn app_server_request_deadlines(
    method: &str,
    params: &Value,
    now: Instant,
) -> Result<(Instant, Option<Instant>), String> {
    let write_limit = now + Duration::from_secs(120);
    let response_timeout = if method == "command/exec" {
        if params.get("disableTimeout").and_then(Value::as_bool) == Some(true) {
            if params.get("timeoutMs").is_some_and(|value| !value.is_null()) {
                return Err("command/exec cannot combine disableTimeout with timeoutMs".into());
            }
            None
        } else {
            let milliseconds = match params.get("timeoutMs").filter(|value| !value.is_null()) {
                Some(value) => value
                    .as_u64()
                    .filter(|value| *value <= i64::MAX as u64)
                    .ok_or_else(|| "command/exec timeoutMs must be a nonnegative integer".to_string())?,
                None => 300_000,
            };
            Some(Duration::from_millis(milliseconds.saturating_add(30_000)))
        }
    } else {
        Some(Duration::from_secs(120))
    };
    let response_deadline = response_timeout
        .map(|duration| now.checked_add(duration).ok_or_else(|| "command/exec timeoutMs is too large".to_string()))
        .transpose()?;
    Ok((response_deadline.map_or(write_limit, |deadline| deadline.min(write_limit)), response_deadline))
}

fn validate_command_timeout_runtime(method: &str, params: &Value, version: &str) -> Result<(), String> {
    // 0.145 is the supported protocol floor and includes disableTimeout.
    // Older runtimes may silently ignore unknown fields and restore a default
    // deadline, so an explicitly unlimited command must fail before launch.
    if method == "command/exec"
        && params.get("disableTimeout").and_then(Value::as_bool) == Some(true)
        && parsed_runtime_version(version)
            .is_none_or(|version| version < semver::Version::new(0, 145, 0))
    {
        return Err("Disabling the app terminal timeout needs Codex 0.145.0 or newer. Update Codex or choose a terminal timeout before starting this command.".into());
    }
    Ok(())
}

async fn receive_server_reply(
    receiver: oneshot::Receiver<Result<Value, String>>,
    method: &str,
    deadline: Option<Instant>,
    replied: &mut bool,
) -> Result<Value, String> {
    let reply = match deadline {
        Some(deadline) => timeout_at(deadline, receiver)
            .await
            .map_err(|_| format!("Codex App Server timed out while handling {method}"))?,
        // command/exec replies at process exit. Stop and app-server shutdown
        // still settle this receiver; the stdin write remains bounded above.
        None => receiver.await,
    };
    let reply = reply.map_err(|_| "Codex App Server stopped before replying".to_string())?;
    // Native EOF settlement is transport evidence, not a protocol reply.
    // Upstream errors have their native disposition markers stripped.
    *replied = !matches!(&reply, Err(error) if error.starts_with("MYTHRA_DELIVERY_UNCERTAIN:"));
    reply
}


struct AppServer {
    app: AppHandle,
    stdin: Mutex<ChildStdin>,
    child: Arc<Mutex<Child>>,
    /// Pid and start time of the child, `None` only if the OS reported no pid.
    identity: Option<ManagedProcessIdentity>,
    /// The runtime-wide slot the exit handler reads. This server clears it
    /// when its own process is gone, and never when a newer server owns it.
    identity_slot: ServerIdentitySlot,
    /// Identity of this exact app-server process. A restart — deliberate or
    /// after a crash — produces a new one, and every thread the old process
    /// had loaded is gone with it. The webview keys its record of "what this
    /// thread's runtime was last configured with" on this value, because
    /// startup-only config is only honoured for a thread that is not loaded.
    instance: String,
    /// The executable and version loaded into this process. The executable
    /// may be replaced by an installer while Mythra Code remains open.
    runtime_path: PathBuf,
    runtime_version: String,
    lifecycle: Arc<RuntimeLifecycle>,
    pending: PendingMap,
    next_id: AtomicI64,
    alive: Arc<AtomicBool>,
    cutoff: Arc<RuntimeCutoffState>,
    /// Server-initiated requests this exact instance is waiting on, keyed by
    /// protocol id. The stored identity lets question replies verify their
    /// thread/turn/item target if a restarted runtime reuses an id.
    server_requests: Arc<Mutex<HashMap<String, CodexServerRequestIdentity>>>,
    /// Threads loaded, or possibly loaded after a written startup request,
    /// into this exact process. Missing acknowledgements never imply cold
    /// startup configuration can safely be applied to a resident thread.
    loaded_threads: Arc<RwLock<HashSet<String>>>,
    /// Runtime-confirmed providers; renderer labels cannot choose billing.
    thread_providers: RwLock<HashMap<String, String>>,
    openrouter_proxy_url: Option<String>,
    openrouter_proxy_task: Option<tokio::task::JoinHandle<()>>,
}

#[derive(Default)]
struct RuntimeCutoffState {
    uncertain: AtomicBool,
    tree_unconfirmed: AtomicBool,
    error: StdMutex<Option<String>>,
}

/// The reader and explicit shutdown share one checked OS cutoff. The child
/// lock reserves the unreaped PID, and a failed tree signal survives reaping
/// so a later caller cannot silently turn that uncertainty into success.
async fn cutoff_runtime_child(child: &Arc<Mutex<Child>>, cutoff: &RuntimeCutoffState) -> Result<(), String> {
    cutoff.uncertain.store(true, Ordering::Release);
    let mut child = child.lock().await;
    let result = match child.try_wait() {
        Ok(Some(_)) => {
            if cutoff.tree_unconfirmed.load(Ordering::Acquire) {
                let error = cutoff.error.lock().unwrap_or_else(std::sync::PoisonError::into_inner).clone()
                    .unwrap_or_else(|| "The earlier process-tree signal was not confirmed.".into());
                return Err(format!("The Codex runtime tree cutoff remains unconfirmed: {error}. Its reaped process identity cannot safely be signalled again."));
            } else { Ok(()) }
        },
        Ok(None) => {
            let tree = child.id().map(kill_process_tree).unwrap_or(Ok(()));
            cutoff.tree_unconfirmed.store(tree.is_err(), Ordering::Release);
            let _ = child.start_kill();
            let reaped = match timeout(Duration::from_secs(2), child.wait()).await {
                Ok(Ok(_)) => Ok(()),
                Ok(Err(error)) => Err(format!("Could not confirm Codex runtime process exit: {error}")),
                Err(_) => Err("Codex runtime process did not exit within the cutoff deadline.".into()),
            };
            tree.and(reaped)
        },
        Err(error) => Err(format!("Could not inspect the Codex runtime process before stopping it: {error}")),
    };
    *cutoff.error.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = result.as_ref().err().cloned();
    cutoff.uncertain.store(result.is_err(), Ordering::Release);
    result
}

#[derive(Default)]
struct RuntimeLifecycle {
    state: StdMutex<RuntimeLifecycleState>,
}

#[derive(Default)]
struct RuntimeLifecycleState {
    instance: Option<String>,
    restart_reservation: Option<RuntimeRestartReservationState>,
    active_turns: HashSet<String>,
    confirmed_active_turns: HashSet<String>,
    // V2 child work can be reported on the parent's collaboration item even
    // when the client is not subscribed to the child's own turn events.
    active_native_agents: HashSet<String>,
    settled_native_agents: HashSet<String>,
    native_agent_operations: HashMap<String, String>,
    native_agent_operation_ids: HashSet<(String, String)>,
    native_passive_operation_snapshots: HashMap<String, HashMap<String, String>>,
    native_subagent_activity_ids: HashMap<String, String>,
    ambiguous_native_activity: HashSet<String>,
    starting_turns: HashSet<String>,
    active_compactions: HashSet<String>,
    starting_compactions: HashSet<String>,
    active_commands: usize,
    active_command_requests: HashSet<i64>,
    in_flight_activity_requests: usize,
    in_flight_rpcs: usize,
}

struct RuntimeRestartReservationState {
    token: String,
    expires_at: Instant,
    restarting: bool,
    /// An OpenAI billing change: only its own sign-in requests may dispatch.
    auth_switch: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeRestartReservation {
    token: String,
    instance: Option<String>,
    observed_native_thread_ids: Vec<String>,
}

struct RuntimeActivityGuard {
    lifecycle: Arc<RuntimeLifecycle>,
    instance: String,
    method: String,
    thread_id: Option<String>,
    command_request_id: Option<i64>,
    finished: bool,
}

struct RuntimeRpcGuard {
    lifecycle: Arc<RuntimeLifecycle>,
}

impl RuntimeLifecycle {
    fn lock(&self) -> std::sync::MutexGuard<'_, RuntimeLifecycleState> {
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn clear_expired_reservation(state: &mut RuntimeLifecycleState) {
        if state
            .restart_reservation
            .as_ref()
            .is_some_and(|reservation| {
                !reservation.restarting && Instant::now() >= reservation.expires_at
            })
        {
            state.restart_reservation = None;
        }
    }

    fn begin_activity(
        self: &Arc<Self>,
        instance: &str,
        method: &str,
        thread_id: Option<&str>,
    ) -> Result<Option<RuntimeActivityGuard>, String> {
        const RETRYABLE_READS: &[&str] = &[
            "initialize",
            "account/read",
            "account/rateLimits/read",
            "model/list",
            "thread/list",
            "thread/read",
            "thread/turns/list",
            "thread/search",
            "skills/list",
            "mcpServerStatus/list",
            "gitDiffToRemote",
            "fs/readFile",
            "fs/readDirectory",
            "fuzzyFileSearch",
        ];
        if RETRYABLE_READS.contains(&method) {
            return Ok(None);
        }

        let mut state = self.lock();
        Self::clear_expired_reservation(&mut state);
        if let Some(reservation) = state.restart_reservation.as_ref() {
            if !(reservation.auth_switch && matches!(method, "account/login/start" | "account/logout")) {
                return Err("The Codex runtime is refreshing its model catalog. Try this action again in a moment.".into());
            }
        }
        if state.instance.as_deref() != Some(instance) {
            return Err("The Codex runtime is changing. Try this action again in a moment.".into());
        }
        // Keep unresolved command ownership bounded without guessing that a
        // deadline means the process ended. Real late replies release slots.
        if method == "command/exec" && state.active_commands >= 128 {
            return Err("The runtime already owns 128 running or unresolved commands. Stop or settle existing commands before starting another.".into());
        }
        state.in_flight_activity_requests += 1;
        if matches!(method, "turn/start" | "review/start") {
            if let Some(thread_id) = thread_id {
                state.starting_turns.insert(thread_id.to_owned());
                state.active_turns.insert(thread_id.to_owned());
            }
        }
        if method == "thread/compact/start" {
            if let Some(thread_id) = thread_id {
                state.starting_compactions.insert(thread_id.to_owned());
                state.active_compactions.insert(thread_id.to_owned());
            }
        }
        if method == "command/exec" {
            state.active_commands += 1;
        }
        drop(state);
        Ok(Some(RuntimeActivityGuard {
            lifecycle: self.clone(),
            instance: instance.to_owned(),
            method: method.to_owned(),
            thread_id: thread_id.map(str::to_owned),
            command_request_id: None,
            finished: false,
        }))
    }

    fn begin_rpc_call(self: &Arc<Self>, method: &str) -> Result<RuntimeRpcGuard, String> {
        const RETRYABLE_READS: &[&str] = &[
            "account/read",
            "account/rateLimits/read",
            "model/list",
            "thread/list",
            "thread/read",
            "thread/turns/list",
            "thread/search",
            "skills/list",
            "mcpServerStatus/list",
            "gitDiffToRemote",
            "fs/readFile",
            "fs/readDirectory",
            "fuzzyFileSearch",
        ];
        let is_read = RETRYABLE_READS.contains(&method);
        let mut state = self.lock();
        Self::clear_expired_reservation(&mut state);
        if let Some(reservation) = state.restart_reservation.as_ref() {
            if reservation.restarting || !is_read {
                return Err("The Codex runtime is refreshing its model catalog. Try this action again in a moment.".into());
            }
        }
        state.in_flight_rpcs += 1;
        Ok(RuntimeRpcGuard {
            lifecycle: self.clone(),
        })
    }

    fn begin_instance(&self, instance: &str) {
        let mut state = self.lock();
        state.instance = Some(instance.to_owned());
        state.active_turns.clear();
        state.confirmed_active_turns.clear();
        state.active_native_agents.clear();
        state.settled_native_agents.clear();
        state.native_agent_operations.clear();
        state.native_agent_operation_ids.clear();
        state.native_passive_operation_snapshots.clear();
        state.native_subagent_activity_ids.clear();
        state.ambiguous_native_activity.clear();
        state.starting_turns.clear();
        state.active_compactions.clear();
        state.starting_compactions.clear();
        state.active_commands = 0;
        state.active_command_requests.clear();
        state.in_flight_activity_requests = 0;
    }

    fn clear_instance(&self, instance: &str) {
        let mut state = self.lock();
        if state.instance.as_deref() == Some(instance) {
            state.instance = None;
            state.active_turns.clear();
            state.confirmed_active_turns.clear();
            state.active_native_agents.clear();
            state.settled_native_agents.clear();
            state.native_agent_operations.clear();
            state.native_agent_operation_ids.clear();
            state.native_passive_operation_snapshots.clear();
            state.native_subagent_activity_ids.clear();
            state.ambiguous_native_activity.clear();
            state.starting_turns.clear();
            state.active_compactions.clear();
            state.starting_compactions.clear();
            state.active_commands = 0;
            state.active_command_requests.clear();
            state.in_flight_activity_requests = 0;
        }
    }

    fn observe_server_message(&self, instance: &str, message: &Value) {
        let Some(method) = message.get("method").and_then(Value::as_str) else {
            return;
        };
        let params = &message["params"];
        if matches!(method, "item/started" | "item/completed")
            && params["item"]["type"].as_str() == Some("subAgentActivity")
        {
            let Some(agent) = params["item"]["agentThreadId"].as_str() else {
                return;
            };
            let mut state = self.lock();
            if state.instance.as_deref() != Some(instance) {
                return;
            }
            match params["item"]["kind"].as_str() {
                // Activity items have no task/activation reference. Once
                // another activation has taken over, a terminal activity
                // snapshot cannot prove that newer work is finished.
                Some("completed" | "interrupted")
                    if !state.ambiguous_native_activity.contains(agent)
                        && state.native_subagent_activity_ids.get(agent)
                            == state.native_agent_operations.get(agent) =>
                {
                    state.active_native_agents.remove(agent);
                    state.settled_native_agents.insert(agent.to_owned());
                }
                Some("started") => {
                    let operation = params["item"]["id"].as_str().unwrap_or_default();
                    let known = state
                        .native_agent_operation_ids
                        .contains(&(agent.to_owned(), operation.to_owned()));
                    if !known {
                        if state
                            .native_subagent_activity_ids
                            .get(agent)
                            .is_some_and(|previous| previous != operation)
                        {
                            state.ambiguous_native_activity.insert(agent.to_owned());
                        }
                        state
                            .native_subagent_activity_ids
                            .insert(agent.to_owned(), operation.to_owned());
                        state
                            .native_agent_operation_ids
                            .insert((agent.to_owned(), operation.to_owned()));
                        state
                            .native_agent_operations
                            .insert(agent.to_owned(), operation.to_owned());
                        state.settled_native_agents.remove(agent);
                        state.active_native_agents.insert(agent.to_owned());
                    }
                }
                _ if !state.settled_native_agents.contains(agent) => {
                    state.active_native_agents.insert(agent.to_owned());
                }
                _ => {}
            }
            return;
        }
        if matches!(method, "item/started" | "item/completed")
            && params["item"]["type"].as_str() == Some("collabAgentToolCall")
        {
            let mut state = self.lock();
            if state.instance.as_deref() != Some(instance) {
                return;
            }
            let item = &params["item"];
            let activation = matches!(
                item["tool"].as_str(),
                Some("spawnAgent" | "sendInput" | "resumeAgent" | "followupTask")
            );
            let operation = item["id"].as_str().unwrap_or_default();
            let states = item["agentsStates"].as_object();
            let mut agents: HashSet<&str> = item["receiverThreadIds"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .collect();
            if let Some(states) = states {
                agents.extend(states.keys().map(String::as_str));
            }
            if !activation
                && !state
                    .native_passive_operation_snapshots
                    .contains_key(operation)
            {
                // Bind wait/list snapshots to the activations present when the
                // operation began, not whichever work exists when it finishes.
                let snapshot = state.native_agent_operations.clone();
                state
                    .native_passive_operation_snapshots
                    .insert(operation.to_owned(), snapshot);
            }
            for agent in agents {
                if !activation
                    && state
                        .native_passive_operation_snapshots
                        .get(operation)
                        .and_then(|snapshot| snapshot.get(agent))
                        != state.native_agent_operations.get(agent)
                {
                    continue;
                }
                let known_operation = state
                    .native_agent_operation_ids
                    .contains(&(agent.to_owned(), operation.to_owned()));
                if activation
                    && known_operation
                    && state
                        .native_agent_operations
                        .get(agent)
                        .is_some_and(|current| current != operation)
                {
                    // An older activation can finish after a newer follow-up
                    // has begun. Its snapshot cannot settle the newer work.
                    continue;
                }
                let new_operation = activation && !known_operation;
                if new_operation {
                    state
                        .native_agent_operation_ids
                        .insert((agent.to_owned(), operation.to_owned()));
                    state
                        .native_agent_operations
                        .insert(agent.to_owned(), operation.to_owned());
                    state.settled_native_agents.remove(agent);
                }
                let status = states
                    .and_then(|states| states.get(agent))
                    .and_then(|agent| {
                        agent
                            .as_str()
                            .or_else(|| agent.get("status").and_then(Value::as_str))
                    });
                if matches!(
                    status,
                    Some("completed" | "interrupted" | "errored" | "shutdown" | "notFound")
                ) {
                    state.active_native_agents.remove(agent);
                    state.ambiguous_native_activity.remove(agent);
                    state.settled_native_agents.insert(agent.to_owned());
                    continue;
                }
                // A completed spawn tool does not mean the spawned child is
                // done. New activation IDs may reuse a settled child; replaying
                // its old tool completion or passive status must not revive it.
                if !state.settled_native_agents.contains(agent) {
                    state.active_native_agents.insert(agent.to_owned());
                }
            }
            return;
        }
        if method == "item/completed"
            && params["item"]["type"].as_str() == Some("contextCompaction")
        {
            let mut state = self.lock();
            if state.instance.as_deref() != Some(instance) {
                return;
            }
            if let Some(thread_id) = params.get("threadId").and_then(Value::as_str) {
                state.active_compactions.remove(thread_id);
            }
            return;
        }
        let Some(thread_id) = params.get("threadId").and_then(Value::as_str) else {
            return;
        };
        let mut state = self.lock();
        if state.instance.as_deref() != Some(instance) {
            return;
        }
        match method {
            "turn/started" => {
                state.active_turns.insert(thread_id.to_owned());
                state.confirmed_active_turns.insert(thread_id.to_owned());
                state.settled_native_agents.remove(thread_id);
            }
            "turn/completed" => {
                state.active_turns.remove(thread_id);
                state.confirmed_active_turns.remove(thread_id);
                state.active_native_agents.remove(thread_id);
                state.ambiguous_native_activity.remove(thread_id);
                state.settled_native_agents.insert(thread_id.to_owned());
            }
            "thread/status/changed" if params["status"]["type"].as_str() == Some("active") => {
                state.active_turns.insert(thread_id.to_owned());
                state.confirmed_active_turns.insert(thread_id.to_owned());
                state.settled_native_agents.remove(thread_id);
            }
            "thread/status/changed"
                if matches!(
                    params["status"]["type"].as_str(),
                    Some("idle" | "systemError")
                ) =>
            {
                state.active_turns.remove(thread_id);
                state.confirmed_active_turns.remove(thread_id);
                state.active_native_agents.remove(thread_id);
                state.ambiguous_native_activity.remove(thread_id);
                state.settled_native_agents.insert(thread_id.to_owned());
                state.active_compactions.remove(thread_id);
            }
            _ => {}
        }
    }

    fn reserve_restart(&self) -> Result<RuntimeRestartReservation, String> {
        let mut state = self.lock();
        Self::clear_expired_reservation(&mut state);
        if state.restart_reservation.is_some() {
            return Err("A Codex runtime refresh is already in progress.".into());
        }
        if !state.active_turns.is_empty()
            || !state.active_native_agents.is_empty()
            || !state.ambiguous_native_activity.is_empty()
            || !state.starting_turns.is_empty()
            || !state.active_compactions.is_empty()
            || !state.starting_compactions.is_empty()
            || state.active_commands > 0
            || state.in_flight_activity_requests > 0
            || state.in_flight_rpcs > 0
        {
            return Err("A Codex turn or command is still active. Finish active work before refreshing the model catalog.".into());
        }
        let token = uuid::Uuid::new_v4().to_string();
        state.restart_reservation = Some(RuntimeRestartReservationState {
            token: token.clone(),
            // A lost renderer cannot leave the runtime permanently gated.
            expires_at: Instant::now() + Duration::from_secs(60),
            restarting: false,
            auth_switch: false,
        });
        // Ownership-only history is unresolved only if this exact process has
        // witnessed that child. Keep observations after activity settles, and
        // take the snapshot under the same lock that admits the reservation.
        let observed_native_thread_ids: HashSet<String> = state.native_agent_operations.keys()
            .chain(state.settled_native_agents.iter())
            .chain(state.active_native_agents.iter())
            .cloned()
            .collect();
        Ok(RuntimeRestartReservation {
            token,
            instance: state.instance.clone(),
            observed_native_thread_ids: observed_native_thread_ids.into_iter().collect(),
        })
    }

    fn release_restart(&self, token: &str) {
        let mut state = self.lock();
        if state
            .restart_reservation
            .as_ref()
            .is_some_and(|reservation| reservation.token == token)
        {
            state.restart_reservation = None;
        }
    }

    fn validate_restart(&self, token: &str) -> Result<(), String> {
        let mut state = self.lock();
        Self::clear_expired_reservation(&mut state);
        if state.in_flight_rpcs > 0 {
            return Err(
                "A Codex request is still finishing. Try the model catalog refresh again.".into(),
            );
        }
        let reservation = state
            .restart_reservation
            .as_mut()
            .filter(|reservation| reservation.token == token)
            .ok_or_else(|| {
                "The Codex runtime refresh reservation expired. Refresh the model catalog again."
                    .to_string()
            })?;
        // Once native replacement starts, the RAII guard owns the reservation
        // until startup succeeds or fails; a TTL must not admit work mid-swap.
        reservation.restarting = true;
        Ok(())
    }

    fn active_command_count(&self) -> usize {
        self.lock().active_commands
    }

    fn begin_generic_restart(self: &Arc<Self>) -> Result<RuntimeRestartGuard, String> {
        self.begin_exclusive(false, "A Codex turn, command, or request is still active. Finish active work before restarting the runtime.")
    }

    /// Reserves the runtime for an OpenAI billing change and its restart.
    /// Refuses, rather than interrupts, while any Codex work is active.
    fn begin_auth_switch(self: &Arc<Self>) -> Result<RuntimeRestartGuard, String> {
        self.begin_exclusive(true, "Finish or stop active Codex work (turns, commands, sub-agents or requests) before changing how OpenAI is billed.")
    }

    /// A ChatGPT sign-in or sign-out changes what the next model request
    /// bills, so it waits for running Codex turns instead of switching under
    /// them.
    fn auth_change_idle(&self) -> Result<(), String> {
        let state = self.lock();
        if !state.active_turns.is_empty()
            || !state.active_native_agents.is_empty()
            || !state.ambiguous_native_activity.is_empty()
            || !state.starting_turns.is_empty()
            || !state.active_compactions.is_empty()
            || !state.starting_compactions.is_empty()
            || state.active_commands > 0
        {
            return Err("Finish or stop active Codex turns before changing the OpenAI sign-in.".into());
        }
        Ok(())
    }

    fn begin_exclusive(self: &Arc<Self>, auth_switch: bool, busy: &str) -> Result<RuntimeRestartGuard, String> {
        let mut state = self.lock();
        Self::clear_expired_reservation(&mut state);
        if state.restart_reservation.is_some() {
            return Err("A Codex runtime refresh is already in progress.".into());
        }
        if !state.active_turns.is_empty()
            || !state.active_native_agents.is_empty()
            || !state.ambiguous_native_activity.is_empty()
            || !state.starting_turns.is_empty()
            || !state.active_compactions.is_empty()
            || !state.starting_compactions.is_empty()
            || state.active_commands > 0
            || state.in_flight_activity_requests > 0
            || state.in_flight_rpcs > 0
        {
            return Err(busy.into());
        }
        let token = uuid::Uuid::new_v4().to_string();
        state.restart_reservation = Some(RuntimeRestartReservationState {
            token: token.clone(),
            expires_at: Instant::now() + Duration::from_secs(300),
            restarting: true,
            auth_switch,
        });
        Ok(RuntimeRestartGuard {
            lifecycle: self.clone(),
            token,
        })
    }
}

impl RuntimeActivityGuard {
    fn register_command_request(&mut self, request_id: i64) {
        if self.method != "command/exec" { return; }
        let mut state = self.lifecycle.lock();
        if state.instance.as_deref() == Some(&self.instance) {
            state.active_command_requests.insert(request_id);
            self.command_request_id = Some(request_id);
        }
    }

    fn finish(mut self, succeeded: bool, uncertain: bool) {
        self.finished = true;
        self.update(succeeded, uncertain);
    }

    fn update(&self, succeeded: bool, uncertain: bool) {
        let mut state = self.lifecycle.lock();
        if state.instance.as_deref() != Some(&self.instance) {
            return;
        }
        state.in_flight_activity_requests = state.in_flight_activity_requests.saturating_sub(1);
        if self.method == "command/exec" {
            if !uncertain {
                // The stdout reader may already have released this exact
                // request. Never decrement another command's reservation.
                if self.command_request_id.is_none_or(|id| state.active_command_requests.remove(&id)) {
                    state.active_commands = state.active_commands.saturating_sub(1);
                }
            }
        }
        if matches!(self.method.as_str(), "turn/start" | "review/start") {
            if let Some(thread_id) = &self.thread_id {
                state.starting_turns.remove(thread_id);
                if !succeeded && !uncertain && !state.confirmed_active_turns.contains(thread_id) {
                    state.active_turns.remove(thread_id);
                }
            }
        }
        if self.method == "thread/compact/start" {
            if let Some(thread_id) = &self.thread_id {
                state.starting_compactions.remove(thread_id);
                if !succeeded && !uncertain {
                    state.active_compactions.remove(thread_id);
                }
            }
        }
    }
}

impl Drop for RuntimeRpcGuard {
    fn drop(&mut self) {
        let mut state = self.lifecycle.lock();
        state.in_flight_rpcs = state.in_flight_rpcs.saturating_sub(1);
    }
}

impl Drop for RuntimeActivityGuard {
    fn drop(&mut self) {
        if !self.finished {
            self.update(false, self.command_request_id.is_some());
        }
    }
}

struct RuntimeRestartGuard {
    lifecycle: Arc<RuntimeLifecycle>,
    token: String,
}

impl Drop for RuntimeRestartGuard {
    fn drop(&mut self) {
        self.lifecycle.release_restart(&self.token);
    }
}

fn successfully_loaded_thread_ids(
    method: &str,
    source_thread_id: Option<&str>,
    result: &Value,
) -> HashSet<String> {
    let mut loaded = HashSet::new();
    if matches!(
        method,
        "thread/start" | "thread/resume" | "thread/fork" | "thread/rollback"
    ) {
        if let Some(thread_id) = result
            .get("thread")
            .and_then(|thread| thread.get("id"))
            .and_then(Value::as_str)
        {
            loaded.insert(thread_id.to_string());
        }
    }
    if matches!(
        method,
        "thread/fork"
            | "thread/rollback"
            | "thread/compact/start"
            | "review/start"
            | "turn/start"
            | "turn/steer"
            | "turn/interrupt"
    ) {
        if let Some(thread_id) = source_thread_id {
            loaded.insert(thread_id.to_string());
        }
    }
    loaded
}

#[derive(Default)]
struct RuntimeState {
    server: Mutex<Option<Arc<AppServer>>>,
    lifecycle: Arc<RuntimeLifecycle>,
    /// Only one package installer may mutate the shared runtime locations at
    /// a time, even if multiple windows or IPC callers bypass the disabled UI.
    runtime_update: Mutex<()>,
    /// Runtime discovery launches external processes on Windows. Cache the
    /// first verified executable/version pair for this Mythra Code process so
    /// status checks and app-server startup cannot repeat `where.exe` and
    /// `codex --version` during one cold launch. The pair is reused only while
    /// the executable keeps the file identity it had when probed.
    codex_runtime: Mutex<Option<ResolvedCodexRuntime>>,
    /// Identity of the app-server child, published when it is spawned and
    /// cleared only after confirmed cutoff. Unlike `server`, this
    /// is accessible without awaiting the async mutex, so the exit handler
    /// can still tear the process tree down while `ensure_server` holds the
    /// lock during a slow spawn/initialize.
    server_identity: ServerIdentitySlot,
    process_memory: Mutex<ProcessMemoryCache>,
}

#[derive(Clone, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct CodexServerRequestIdentity {
    method: String,
    thread_id: Option<String>,
    turn_id: Option<String>,
    item_id: Option<String>,
}

fn codex_server_request_identity(message: &Value) -> Option<CodexServerRequestIdentity> {
    let params = message.get("params").unwrap_or(&Value::Null);
    Some(CodexServerRequestIdentity {
        method: message.get("method")?.as_str()?.to_string(),
        thread_id: params
            .get("threadId")
            .and_then(Value::as_str)
            .map(str::to_string),
        turn_id: params
            .get("turnId")
            .and_then(Value::as_str)
            .map(str::to_string),
        item_id: params
            .get("itemId")
            .and_then(Value::as_str)
            .map(str::to_string),
    })
}

fn consume_codex_server_request(
    requests: &mut HashMap<String, CodexServerRequestIdentity>,
    id: &Value,
    expected: Option<&CodexServerRequestIdentity>,
) -> Result<(), String> {
    let key = id.to_string();
    let actual = requests.get(&key).ok_or_else(|| {
        "This Codex request is no longer pending and can no longer be answered.".to_string()
    })?;
    if expected.is_some_and(|expected| expected != actual) {
        return Err(
            "This Codex request no longer matches the question that is waiting for an answer."
                .into(),
        );
    }
    requests.remove(&key);
    Ok(())
}

/// Identity of a managed child, captured when it is spawned. A pid alone
/// cannot name a process later: once the child exits the OS may hand the
/// same number to an unrelated process, so fallback termination checks
/// parentage and start time before signalling anything.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct ManagedProcessIdentity {
    pid: u32,
    /// OS-reported start time in seconds since the epoch, or 0 when it could
    /// not be read at spawn, in which case only parentage is checked.
    start_time: u64,
}

type ServerIdentitySlot = Arc<std::sync::Mutex<Option<ManagedProcessIdentity>>>;

/// What the OS currently reports for a pid.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct ObservedProcess {
    parent: Option<u32>,
    start_time: u64,
}

fn observe_process(pid: u32) -> Option<ObservedProcess> {
    let target = sysinfo::Pid::from_u32(pid);
    let mut system = System::new();
    system.refresh_processes_specifics(
        ProcessesToUpdate::Some(&[target]),
        true,
        ProcessRefreshKind::nothing(),
    );
    let process = system.process(target)?;
    Some(ObservedProcess {
        parent: process.parent().map(|parent| parent.as_u32()),
        start_time: process.start_time(),
    })
}

fn managed_identity_for(pid: u32) -> ManagedProcessIdentity {
    ManagedProcessIdentity {
        pid,
        start_time: observe_process(pid)
            .map(|observed| observed.start_time)
            .unwrap_or(0),
    }
}

/// Whether the process the OS currently reports for `identity.pid` is still
/// the child Mythra Code spawned: it must be our direct child, and its start
/// time must agree whenever both sides could read one.
fn identity_still_managed(
    identity: ManagedProcessIdentity,
    observed: Option<ObservedProcess>,
    own_pid: u32,
) -> bool {
    let Some(observed) = observed else {
        return false;
    };
    if observed.parent != Some(own_pid) {
        return false;
    }
    identity.start_time == 0
        || observed.start_time == 0
        || identity.start_time == observed.start_time
}

/// Fallback termination by identity. Signals the tree only while the pid
/// still names the child we spawned; returns whether anything was signalled.
fn kill_managed_process_tree(identity: ManagedProcessIdentity) -> bool {
    if !identity_still_managed(identity, observe_process(identity.pid), std::process::id()) {
        return false;
    }
    kill_process_tree(identity.pid).is_ok()
}

fn server_identity(slot: &ServerIdentitySlot) -> Option<ManagedProcessIdentity> {
    *slot
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn publish_server_identity(slot: &ServerIdentitySlot, identity: Option<ManagedProcessIdentity>) {
    *slot
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner) = identity;
}

/// Clear the slot only if it still names `identity`. A stale server shutting
/// down after a restart must not erase the newer server's entry.
fn clear_server_identity(slot: &ServerIdentitySlot, identity: Option<ManagedProcessIdentity>) {
    let Some(identity) = identity else {
        return;
    };
    let mut guard = slot
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if *guard == Some(identity) {
        *guard = None;
    }
}

#[derive(Clone)]
struct ResolvedCodexRuntime {
    path: PathBuf,
    version: String,
    /// The executable observed both before and after `version` was probed.
    identity: ExecutableIdentity,
}

/// Kill a provider child and all of its descendants. Provider children are
/// spawned in their own process group on unix, so signalling the negative
/// pgid reaches the whole tree; `taskkill /T` walks the tree on Windows.
/// Falls back to the pid itself if the group signal fails (for example when
/// the child never became a group leader).
fn kill_process_tree(pid: u32) -> Result<(), String> {
    #[cfg(unix)]
    {
        // Signal directly rather than spawning `kill`: this runs on async
        // workers and stop paths, where a process launch would block them.
        let Ok(pid) = libc::pid_t::try_from(pid) else {
            return Err("Could not signal the provider process: invalid process id.".into());
        };
        if pid <= 0 {
            return Err("Could not signal the provider process: invalid process id.".into());
        }
        // SAFETY: kill(2) only sends a signal; a negative pid names the group.
        let killed_group = unsafe { libc::kill(-pid, libc::SIGKILL) } == 0;
        if !killed_group {
            // SAFETY: as above, for the single process.
            if unsafe { libc::kill(pid, libc::SIGKILL) } != 0 {
                return Err("Could not confirm the provider process tree was killed.".into());
            }
        }
    }
    #[cfg(windows)]
    {
        let status = background_std_command("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .status().map_err(|error| format!("Could not signal the provider process tree: {error}"))?;
        if !status.success() { return Err("Could not confirm the provider process tree was killed.".into()); }
    }
    Ok(())
}

/// A native start owns cancellation before its first preparation await. Stop
/// waits for this exact attempt to settle; a missing running process is not
/// evidence that an already-dispatched start cannot still launch one.
#[derive(Default)]
pub(crate) struct NativeStartRegistry {
    attempts: Arc<StdMutex<HashMap<String, Arc<NativeStartAttempt>>>>,
}

pub(crate) struct NativeStartAttempt {
    turn_id: String,
    start_request_id: Option<String>,
    cancelled: AtomicBool,
    settled: AtomicBool,
    changed: tokio::sync::Notify,
    cutoff_error: StdMutex<Option<String>>,
}

pub(crate) struct NativeStartGuard {
    registry: Arc<StdMutex<HashMap<String, Arc<NativeStartAttempt>>>>,
    thread_id: String,
    attempt: Arc<NativeStartAttempt>,
}

impl NativeStartRegistry {
    pub(crate) fn begin(&self, thread_id: &str, turn_id: &str, start_request_id: Option<&str>) -> Result<NativeStartGuard, String> {
        let mut attempts = self.attempts.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        if attempts.contains_key(thread_id) {
            return Err("A provider start is still settling in this thread. Wait before starting another turn.".into());
        }
        let attempt = Arc::new(NativeStartAttempt {
            turn_id: turn_id.to_owned(), start_request_id: start_request_id.map(str::to_owned),
            cancelled: AtomicBool::new(false), settled: AtomicBool::new(false), changed: tokio::sync::Notify::new(),
            cutoff_error: StdMutex::new(None),
        });
        attempts.insert(thread_id.to_owned(), attempt.clone());
        Ok(NativeStartGuard { registry: self.attempts.clone(), thread_id: thread_id.to_owned(), attempt })
    }

    pub(crate) fn cancel(&self, thread_id: &str, expected_turn_id: Option<&str>, expected_start_request_id: Option<&str>) -> Result<Option<Arc<NativeStartAttempt>>, String> {
        let attempts = self.attempts.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let Some(attempt) = attempts.get(thread_id).cloned() else { return Ok(None); };
        if expected_turn_id.is_some_and(|expected| expected != attempt.turn_id)
            || expected_start_request_id.is_some_and(|expected| attempt.start_request_id.as_deref() != Some(expected)) {
            return Err("The Stop request belongs to an older provider start; the current start was preserved.".into());
        }
        attempt.cancelled.store(true, Ordering::Release);
        Ok(Some(attempt))
    }

    pub(crate) fn identity(&self, thread_id: &str) -> Option<(String, Option<String>, &'static str)> {
        let attempts = self.attempts.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        attempts.get(thread_id).map(|attempt| (attempt.turn_id.clone(), attempt.start_request_id.clone(),
            if attempt.cancelled.load(Ordering::Acquire) { "stopping" } else { "starting" }))
    }

    /// Whether any thread has a provider start still settling.
    pub(crate) fn any_pending(&self) -> bool {
        !self.attempts.lock().unwrap_or_else(std::sync::PoisonError::into_inner).is_empty()
    }
}

impl NativeStartGuard {
    pub(crate) fn record_cutoff_error(&self, error: &str) {
        *self.attempt.cutoff_error.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = Some(error.to_owned());
    }
    pub(crate) fn assert_current(&self) -> Result<(), String> {
        if self.attempt.cancelled.load(Ordering::Acquire) {
            return Err("The provider start was stopped before model dispatch.".into());
        }
        Ok(())
    }
}

impl Drop for NativeStartGuard {
    fn drop(&mut self) {
        let mut attempts = self.registry.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        if attempts.get(&self.thread_id).is_some_and(|current| Arc::ptr_eq(current, &self.attempt)) {
            attempts.remove(&self.thread_id);
        }
        self.attempt.settled.store(true, Ordering::Release);
        self.attempt.changed.notify_waiters();
    }
}

pub(crate) async fn await_native_start_settlement(attempt: Option<Arc<NativeStartAttempt>>) -> Result<(), String> {
    let Some(attempt) = attempt else { return Ok(()); };
    timeout(Duration::from_secs(5), async {
        loop {
            let changed = attempt.changed.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            if attempt.settled.load(Ordering::Acquire) { return; }
            changed.await;
        }
    }).await.map_err(|_| "The pending provider start is cancelled but has not settled; its cutoff remains unconfirmed.".to_string())?;
    let error = attempt.cutoff_error.lock().unwrap_or_else(std::sync::PoisonError::into_inner).clone();
    error.map_or(Ok(()), |error| Err(format!("The cancelled provider start settled with an unconfirmed cutoff: {error}")))
}

#[derive(Default)]
struct ClaudeState {
    turns: Arc<Mutex<HashMap<String, Arc<ClaudeTurn>>>>,
    /// Terminal events keyed by exact (thread, turn), recorded before that
    /// turn releases its slot. Emitting is not renderer delivery: health
    /// reconciliation consumes an exact-turn receipt through the normal event
    /// route instead of sealing a finished turn as failed.
    terminal_receipts: Arc<StdMutex<ClaudeTerminalReceipts>>,
    starts: NativeStartRegistry,
    authenticated: AtomicBool,
    /// Advances only at sign-in, which can change credentials outside this
    /// process; a check spanning one cannot authorize turns.
    auth_check_generation: StdMutex<u64>,
    /// Ordinary checks run one at a time so one cannot cancel another's
    /// (for example a turn's own check) merely by starting.
    auth_check_lock: Mutex<()>,
    auth_probes: StdMutex<ClaudeAuthProbes>,
    /// Serialize `/usage` reads and share overlapping same-scope outcomes.
    usage_lock: Mutex<()>,
    usage_probes: StdMutex<ClaudeUsageProbes>,
    prompt_snapshot_support: Mutex<Option<ClaudePromptSnapshotSupport>>,
}

/// Receipts normally live only until the renderer acknowledges handling that
/// exact turn's terminal event. The bounds only matter when acknowledgments
/// never come (for example a reloaded renderer): the oldest are evicted
/// whole, never truncated, and the newest is always kept. An evicted turn
/// falls back to the ordinary unexpected-exit recovery.
const CLAUDE_TERMINAL_RECEIPT_LIMIT: usize = 32;
const CLAUDE_TERMINAL_RECEIPT_BYTES: usize = 8 * 1024 * 1024;

#[derive(Default)]
struct ClaudeTerminalReceipts {
    /// (thread, turn, message, serialized size), oldest first.
    entries: std::collections::VecDeque<(String, String, Value, usize)>,
    bytes: usize,
}

impl ClaudeTerminalReceipts {
    fn remove(&mut self, thread_id: &str, turn_id: &str) {
        let bytes = &mut self.bytes;
        self.entries.retain(|(thread, turn, _, size)| {
            let keep = thread != thread_id || turn != turn_id;
            if !keep {
                *bytes -= size;
            }
            keep
        });
    }

    /// Keyed by exact turn, so a stopped predecessor's late exit can never
    /// replace or erase its successor's outcome.
    fn record(&mut self, thread_id: &str, turn_id: &str, message: &Value) {
        self.remove(thread_id, turn_id);
        let size = message.to_string().len();
        self.entries.push_back((thread_id.to_string(), turn_id.to_string(), message.clone(), size));
        self.bytes += size;
        while self.entries.len() > 1
            && (self.entries.len() > CLAUDE_TERMINAL_RECEIPT_LIMIT || self.bytes > CLAUDE_TERMINAL_RECEIPT_BYTES)
        {
            if let Some((_, _, _, size)) = self.entries.pop_front() {
                self.bytes -= size;
            }
        }
    }

    fn get(&self, thread_id: &str, turn_id: &str) -> Option<Value> {
        self.entries
            .iter()
            .find(|(thread, turn, _, _)| thread == thread_id && turn == turn_id)
            .map(|(_, _, message, _)| message.clone())
    }
}

fn record_claude_terminal_receipt(
    receipts: &StdMutex<ClaudeTerminalReceipts>,
    thread_id: &str,
    turn_id: &str,
    message: &Value,
) {
    receipts
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .record(thread_id, turn_id, message);
}

/// Callers that waited behind a probe share its result instead of queueing
/// another full CLI check each. Only a probe that finished after the caller
/// arrived, under the current sign-in generation, is shared; nothing else is
/// reused, so a check started after one settles still probes.
#[derive(Default)]
struct ClaudeAuthProbes {
    completed: u64,
    last: Option<(u64, ClaudeRuntimeStatus)>,
}

/// Startup, Settings and the usage poller can all ask for quota at once.
/// Callers share a read only within the same accepted account/runtime scope.
/// One current scope and one result keep this independent of account history.
#[derive(Default)]
struct ClaudeUsageProbes {
    completed: u64,
    scope_epoch: u64,
    scope: Option<ClaudeUsageScope>,
    last: Option<(u64, Result<ClaudeUsageLimits, String>)>,
}

#[derive(Clone, PartialEq, Eq)]
struct ClaudeUsageScope {
    auth_generation: u64,
    account_key: String,
    runtime_path: Option<String>,
}

#[derive(Clone, PartialEq, Eq)]
struct ExecutableIdentity {
    path: PathBuf,
    target: Option<PathBuf>,
    metadata: Option<(u64, Option<SystemTime>)>,
    file_identity: Option<(u64, u64)>,
}

struct ClaudePromptSnapshotSupport {
    identity: ExecutableIdentity,
    supported: Option<bool>,
    native_supported: Option<bool>,
    haiku55_supported: Option<bool>,
    model_compaction_supported: Option<bool>,
    checked_at: Instant,
}

// A transient version failure must not pin a modern CLI to stale snapshots.
// Known versions remain cached until the executable changes; unknown versions
// retry at a bounded cadence instead of spawning a probe on every turn.
const CLAUDE_PROMPT_SNAPSHOT_RETRY_AFTER: Duration = Duration::from_secs(30);

impl ClaudePromptSnapshotSupport {
    fn reusable(&self, identity: &ExecutableIdentity, now: Instant) -> bool {
        self.identity == *identity
            && (self.supported.is_some()
                || now.saturating_duration_since(self.checked_at)
                    < CLAUDE_PROMPT_SNAPSHOT_RETRY_AFTER)
    }
}

/// How long a cooperative interrupt gets to unwind before the Claude process
/// is force-killed. Generous enough for the CLI to finish an in-flight tool
/// call and emit its `result`, short enough that a wedged process cannot hold
/// the thread's slot indefinitely.
const CLAUDE_INTERRUPT_GRACE: Duration = Duration::from_secs(10);

/// A Claude `result` is the terminal protocol event for one Mythra Code turn.
/// Close stdin and let the CLI persist its transcript before reaping it.
/// The result can be emitted before that asynchronous persistence completes.
const CLAUDE_RESULT_EXIT_GRACE: Duration = Duration::from_secs(10);

struct ClaudeTurn {
    turn_id: String,
    start_request_id: Option<String>,
    stdin: Mutex<Option<ChildStdin>>,
    child: Arc<Mutex<Child>>,
    pid: Option<u32>,
    alive: Arc<AtomicBool>,
    /// User steering stays closed until initialization was authenticated and
    /// the original prompt finished writing. Control and Stop remain usable.
    input_ready: AtomicBool,
    cutoff_uncertain: AtomicBool,
    cutoff_error: StdMutex<Option<String>>,
    /// Ids of `control_request` messages this CLI process has sent and the
    /// renderer has not answered yet. A control response is only accepted
    /// for one of these, so the webview cannot answer a request this turn
    /// never issued (mirrors the Codex bridge's server-request set).
    control_requests: Mutex<HashSet<String>>,
    /// Serializes replies without holding `control_requests` across pipe IO.
    /// That keeps duplicate renderer replies out while allowing the stdout
    /// reader to register or cancel requests if Claude stops reading stdin.
    control_response: Mutex<()>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ClaudeRuntimeStatus {
    available: bool,
    path: Option<String>,
    version: Option<String>,
    /// For API-key billing, "logged in" means a key is saved for Claude.
    logged_in: bool,
    auth_verified: bool,
    auth_method: Option<String>,
    email: Option<String>,
    subscription_type: Option<String>,
    /// The billing these fields describe; null when the choice is unreadable.
    billing: Option<provider_auth::ClaudeBilling>,
    warning: Option<String>,
}

#[derive(Clone, Serialize, PartialEq, Debug)]
#[serde(rename_all = "camelCase")]
struct ClaudeUsageWindow {
    label: String,
    used_percent: f64,
    /// Claude Code formats the reset in the user's own timezone. Keep that
    /// official display text instead of guessing at a locale-specific date.
    reset_label: Option<String>,
}

#[derive(Clone, Serialize, PartialEq, Debug)]
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
    resume: bool,
    attachments: Vec<ClaudeAttachment>,
    subagent_max: usize,
    custom_agents: Vec<ClaudeAgentInput>,
    #[serde(default)]
    native_subagents: bool,
    #[serde(default)]
    native_subagent_max: Option<usize>,
    #[serde(default)]
    native_subagent_model: Option<String>,
    #[serde(default)]
    native_auto_compact_tokens: Option<usize>,
    #[serde(default)]
    auto_compact_tokens: Option<usize>,
    skills_plugin_path: Option<String>,
    /// Path to the cross-provider delegation MCP configuration, present only
    /// for a root thread whose policy allows spawning on other providers.
    #[serde(default)]
    child_agent_bridge_config: Option<String>,
}

fn default_interactive() -> bool {
    true
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
        let mut input = self.stdin.lock().await;
        let stdin = input.as_mut().ok_or("This Claude turn is finishing")?;
        stdin
            .write_all(format!("{message}\n").as_bytes())
            .await
            .map_err(|error| format!("MYTHRA_DELIVERY_UNCERTAIN: Could not confirm Claude Code input write: {error}"))?;
        stdin
            .flush()
            .await
            .map_err(|error| format!("MYTHRA_DELIVERY_UNCERTAIN: Could not confirm Claude Code input flush: {error}"))
    }

    async fn shutdown(&self) -> Result<(), String> {
        self.cutoff_uncertain.store(true, Ordering::Release);
        self.alive.store(false, Ordering::Release);
        let mut child = self.child.lock().await;
        match child.try_wait() {
            Ok(Some(_)) => {
                if let Some(error) = self.cutoff_error.lock().unwrap_or_else(std::sync::PoisonError::into_inner).clone() {
                    return Err(format!("An earlier provider cutoff remains unconfirmed ({error}); the reaped process identity cannot safely be signalled again."));
                }
                self.cutoff_uncertain.store(false, Ordering::Release);
                return Ok(());
            }
            Ok(None) => {},
            Err(error) => {
                self.cutoff_uncertain.store(true, Ordering::Release);
                let error = format!("Could not inspect the Claude process before stopping it: {error}");
                *self.cutoff_error.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = Some(error.clone());
                return Err(error);
            }
        }
        let tree_result = self.pid.map(kill_process_tree).unwrap_or(Ok(()));
        let _ = child.start_kill();
        let reap_result = match timeout(Duration::from_secs(2), child.wait()).await {
            Ok(Ok(_)) => Ok(()),
            Ok(Err(error)) => Err(format!("Could not confirm Claude process exit: {error}")),
            Err(_) => Err("Claude process did not exit within the cutoff deadline.".to_string()),
        };
        let result = tree_result.and(reap_result);
        *self.cutoff_error.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = result.as_ref().err().cloned();
        self.cutoff_uncertain.store(result.is_err(), Ordering::Release);
        result
    }

    async fn close_input(&self) {
        // Dropping the pipe guarantees EOF; shutdown alone can leave its
        // handle alive while stream-input mode waits for another prompt.
        self.stdin.lock().await.take();
    }
}

async fn write_claude_control_response<F, Fut>(
    response_lock: &Mutex<()>,
    requests: &Mutex<HashSet<String>>,
    request_id: &str,
    write: F,
) -> Result<(), String>
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = Result<(), String>>,
{
    let _response = response_lock.lock().await;
    if !requests.lock().await.contains(request_id) {
        return Err("This Claude turn is no longer waiting for that request".into());
    }

    // Keep the request pending on IO failure so the renderer can retry. The
    // pending-set lock must not cross this await: Claude can cancel this
    // request or send another one while its stdin is backpressured.
    write().await?;
    requests.lock().await.remove(request_id);
    Ok(())
}

/// Drain post-result output without forwarding it while the CLI saves history.
/// Waiting for the direct child (not EOF) also tolerates inherited stdout pipes.
async fn reap_claude_process(
    child: &mut Child,
    stdout: &mut (impl AsyncRead + Unpin),
    grace: Duration,
) -> Result<std::process::ExitStatus, String> {
    let mut sink = tokio::io::sink();
    let graceful = async {
        tokio::select! {
            exit = child.wait() => exit,
            _ = tokio::io::copy(stdout, &mut sink) => child.wait().await,
        }
    };
    match timeout(grace, graceful).await {
        Ok(exit) => exit.map_err(|error| format!("Could not confirm Claude process exit: {error}")),
        Err(_) => {
            let tree_result = child.id().map(kill_process_tree).unwrap_or(Ok(()));
            let _ = child.start_kill();
            let exit = timeout(Duration::from_secs(2), child.wait()).await
                .map_err(|_| "Claude process did not exit within the cutoff deadline.".to_string())?
                .map_err(|error| format!("Could not confirm Claude process exit: {error}"))?;
            tree_result.map(|_| exit)
        }
    }
}

/// How long Claude Code may take to accept the initialize request and first
/// prompt. Stdout and stderr are drained meanwhile, so only a CLI that stops
/// reading its input reaches this; that start then fails and its process is
/// killed instead of holding the thread slot.
const CLAUDE_STARTUP_INPUT_TIMEOUT: Duration = Duration::from_secs(60);
/// Stdout retained while startup input is still being written. Past this the
/// drain pauses, without discarding anything, and the input deadline applies.
const CLAUDE_STARTUP_OUTPUT_BYTES: usize = 8 * 1024 * 1024;

/// Stdout read results, in order, observed before the reader task took over.
type ClaudeEarlyOutput = std::collections::VecDeque<std::io::Result<Option<String>>>;

/// Write Claude Code's startup input while draining its stdout. The CLI may
/// write before it reads, and a full stdout pipe would stop it reading stdin.
/// Everything drained is returned unprocessed so the stdout reader can apply
/// its normal handling — including the prompt boundary — in original order.
enum ClaudeStartupInputError {
    /// Refused before the user's message was written; nothing was dispatched.
    NotSent(String),
    /// Billing confirmation failed before the user's message was written.
    Refused(ClaudeStartRefusal),
    Failed(String),
}

/// Why a Claude Code process was refused before any prompt or request was
/// written to it. Each cause has its own next step, so they are kept apart.
pub(crate) enum ClaudeStartRefusal {
    /// It reported a credential other than the selected billing.
    Credential(provider_auth::ClaudeBilling),
    /// It reported no credential at all for the selected billing.
    NoCredential(provider_auth::ClaudeBilling),
    /// It reported an API provider other than Anthropic's.
    Provider,
    /// Its initialize answer had no usable account evidence.
    Unreported,
    /// It answered initialize with an error.
    Rejected,
    /// It exited, or stopped reading or writing, before answering.
    Exited,
    /// It did not answer before the startup deadline.
    Late,
}

impl ClaudeStartRefusal {
    /// User-facing text. `stderr` is only inspected for the CLI's own
    /// unknown-option error, the one exit that does indicate an outdated or
    /// incompatible Claude Code; other exits are not attributed to a version.
    /// Avoids wording that the renderer's generic error rewriting replaces.
    pub(crate) fn message(&self, stderr: &str) -> String {
        match self {
            Self::Credential(provider_auth::ClaudeBilling::Subscription) => "Claude Code is using an API key or another credential instead of your Claude subscription, which is the billing selected in Settings › Models & accounts. Sign in with your Claude subscription there, or explicitly choose API key billing.".into(),
            Self::Credential(provider_auth::ClaudeBilling::ApiKey) => "Claude Code is using a different credential instead of the Anthropic API key selected in Settings › Models & accounts. Check the saved key there, or explicitly switch Claude to your subscription.".into(),
            Self::NoCredential(provider_auth::ClaudeBilling::Subscription) => "Claude Code reports no Claude subscription sign-in. Sign in with your subscription in Settings › Models & accounts, then try again.".into(),
            Self::NoCredential(provider_auth::ClaudeBilling::ApiKey) => "Claude Code did not pick up the Anthropic API key selected in Settings › Models & accounts. Check the saved key there, then try again.".into(),
            Self::Provider => "Claude Code is set to use an API provider other than Anthropic, for example through an organization policy. Mythra Code bills Claude only through the method selected in Settings › Models & accounts.".into(),
            Self::Unreported => "Claude Code started without reporting which credential it is using, so the billing selected in Settings › Models & accounts could not be confirmed. Check your Claude connection there. If it looks correct, this Claude Code version may not report its account; check Settings › Updates › Claude Code.".into(),
            Self::Rejected => "Claude Code refused Mythra Code's startup request, so its billing could not be confirmed. This Claude Code version may not support it; check Settings › Updates › Claude Code.".into(),
            Self::Exited if stderr.contains("error: unknown option") => "Claude Code stopped because it does not recognize an option Mythra Code needs, which usually means it is out of date. Update it in Settings › Updates › Claude Code.".into(),
            Self::Exited => "Claude Code stopped before confirming the billing selected in Settings › Models & accounts. Try again; if it keeps happening, check Claude in Models & accounts.".into(),
            Self::Late => "Claude Code took too long to start and confirm its billing. Try again in a moment.".into(),
        }
    }
}

/// Validate the credential chosen by the actual headless runtime, rather than
/// assuming the launch environment won over managed policy or a saved gateway.
/// Evidence of the other billing is a credential mismatch; missing or
/// malformed evidence is unconfirmed. Neither is ever admitted.
fn validate_claude_initialized_account(
    billing: provider_auth::ClaudeBilling,
    initialized: &Value,
) -> Result<(), ClaudeStartRefusal> {
    let Some(account) = initialized.get("account").filter(|account| account.is_object()) else {
        return Err(ClaudeStartRefusal::Unreported);
    };
    // Claude Code before 2.1.77 omits apiProvider here. Hosted providers are
    // already stripped from the launch environment and settings, and the
    // billing evidence below is still required, so only an explicit other
    // provider is refused.
    match account.get("apiProvider") {
        None => {}
        Some(Value::String(provider)) if provider == "firstParty" => {}
        Some(Value::String(_)) => return Err(ClaudeStartRefusal::Provider),
        Some(_) => return Err(ClaudeStartRefusal::Unreported),
    }
    // A string field is reported evidence; any other type is malformed.
    let text = |field: &str| match account.get(field) {
        None => Ok(None),
        Some(Value::String(value)) => Ok(Some(value.as_str())),
        Some(_) => Err(ClaudeStartRefusal::Unreported),
    };
    let api_key_source = text("apiKeySource")?;
    let subscription_type = text("subscriptionType")?;
    let token_source = text("tokenSource")?;
    let subscription = subscription_type.is_some_and(|value| !value.trim().is_empty())
        || token_source == Some("claude.ai");
    // Claude Code reports "none" for a source that supplies nothing.
    let reported_none = token_source == Some("none");
    match billing {
        provider_auth::ClaudeBilling::Subscription => {
            // Current Claude Code emits subscriptionType, and deliberately
            // omits tokenSource, when subscription OAuth is the active auth.
            // Either subscription shape can coexist with an overriding API
            // key. Only an omitted source or explicit "none" confirms none,
            // and any other token source (for example a long-lived OAuth
            // token from managed settings) is not the selected sign-in.
            if api_key_source.is_some_and(|source| source != "none")
                || token_source.is_some_and(|source| source != "claude.ai" && source != "none")
            {
                return Err(ClaudeStartRefusal::Credential(billing));
            }
            if !subscription {
                return Err(if reported_none {
                    ClaudeStartRefusal::NoCredential(billing)
                } else {
                    ClaudeStartRefusal::Unreported
                });
            }
        }
        // A stored claude.ai login is still reported as tokenSource beside an
        // overriding key, so only the key source admits; the other fields
        // only choose which refusal explains a missing key.
        provider_auth::ClaudeBilling::ApiKey => match api_key_source {
            Some("ANTHROPIC_API_KEY") => {}
            Some("none") if !subscription && (reported_none || token_source.is_none()) => {
                return Err(ClaudeStartRefusal::NoCredential(billing))
            }
            Some(_) => return Err(ClaudeStartRefusal::Credential(billing)),
            None if subscription || token_source.is_some_and(|source| source != "none") => {
                return Err(ClaudeStartRefusal::Credential(billing))
            }
            None if reported_none => return Err(ClaudeStartRefusal::NoCredential(billing)),
            None => return Err(ClaudeStartRefusal::Unreported),
        },
    }
    Ok(())
}

/// The billing verdict when `message` answers the initialize request
/// `request_id`, or None for any other output. Shared by streamed turns,
/// helpers and the catalog so their admission cannot drift apart.
fn claude_initialize_answer(
    message: &Value,
    request_id: &str,
    billing: provider_auth::ClaudeBilling,
) -> Option<Result<(), ClaudeStartRefusal>> {
    let response = message.get("response")?;
    if message.get("type").and_then(Value::as_str) != Some("control_response")
        || response.get("request_id").and_then(Value::as_str) != Some(request_id)
    {
        return None;
    }
    Some(if response.get("subtype").and_then(Value::as_str) == Some("success") {
        validate_claude_initialized_account(billing, response.get("response").unwrap_or(&Value::Null))
    } else {
        Err(ClaudeStartRefusal::Rejected)
    })
}

/// How long a helper or catalog process may take to answer `initialize`.
const CLAUDE_PROCESS_INITIALIZE_TIMEOUT: Duration = Duration::from_secs(30);
/// How long a refused start waits for its stopped process's last stderr.
const CLAUDE_REFUSAL_STDERR_WAIT: Duration = Duration::from_millis(500);
/// Stdout a helper or catalog process may write before that answer.
const CLAUDE_PROCESS_INITIALIZE_OUTPUT_BYTES: u64 = 1024 * 1024;

/// Ask a started `-p` stream-json Claude Code process which credential it
/// selected, and refuse unless it is the billing selected in Models &
/// accounts. Callers write nothing else before this succeeds, so a refused
/// process never receives a prompt or request. A check in another process
/// (`auth status`) would be stale by the time this one starts. The caller
/// must drain stderr meanwhile and stop the process on any error.
pub(crate) async fn confirm_claude_process_billing<W, R>(
    stdin: &mut W,
    stdout: &mut R,
    billing: provider_auth::ClaudeBilling,
) -> Result<(), ClaudeStartRefusal>
where
    W: AsyncWrite + Unpin,
    R: tokio::io::AsyncBufRead + Unpin,
{
    let request_id = uuid::Uuid::new_v4().to_string();
    let request = json!({
        "type": "control_request",
        "request_id": request_id,
        "request": { "subtype": "initialize" },
    });
    timeout(CLAUDE_PROCESS_INITIALIZE_TIMEOUT, async {
        stdin.write_all(format!("{request}\n").as_bytes()).await.map_err(|_| ClaudeStartRefusal::Exited)?;
        stdin.flush().await.map_err(|_| ClaudeStartRefusal::Exited)?;
        // Only the initialize answer matters here, and nothing earlier is
        // billed output, so earlier lines are dropped within a fixed budget.
        let mut output = (&mut *stdout).take(CLAUDE_PROCESS_INITIALIZE_OUTPUT_BYTES);
        let mut line = Vec::new();
        loop {
            line.clear();
            // EOF, a read error, or the budget running out all end the check.
            if output.read_until(b'\n', &mut line).await.map_err(|_| ClaudeStartRefusal::Exited)? == 0 {
                return Err(ClaudeStartRefusal::Exited);
            }
            let Ok(message) = serde_json::from_slice::<Value>(&line) else { continue };
            if let Some(verdict) = claude_initialize_answer(&message, &request_id, billing) {
                return verdict;
            }
        }
    })
    .await
    .map_err(|_| ClaudeStartRefusal::Late)?
}

/// Write initialization and drain its matching response before allowing the
/// user's input. `admit_input` still runs at the last input boundary.
async fn write_claude_startup_input<R: tokio::io::AsyncBufRead + Unpin>(
    turn: &ClaudeTurn,
    control: &[&Value],
    input: &Value,
    billing: provider_auth::ClaudeBilling,
    admit_input: impl FnOnce() -> Result<(), String>,
    lines: &mut tokio::io::Lines<R>,
    deadline: Instant,
) -> Result<ClaudeEarlyOutput, ClaudeStartupInputError> {
    enum Progress {
        Written(Result<Result<(), ClaudeStartupInputError>, tokio::time::error::Elapsed>),
        Read(std::io::Result<Option<String>>),
    }
    let initialize_id = control.iter()
        .find(|message| message.pointer("/request/subtype").and_then(Value::as_str) == Some("initialize"))
        .and_then(|message| message.get("request_id").and_then(Value::as_str))
        .ok_or_else(|| ClaudeStartupInputError::NotSent("Claude initialization was not configured; your message was not sent.".into()))?
        .to_owned();
    let (initialized_sender, initialized_receiver) = oneshot::channel::<Result<(), ClaudeStartRefusal>>();
    let mut initialized_sender = Some(initialized_sender);
    let writes = timeout_at(deadline, async {
        for message in control {
            // Only initialization is being written here, not the prompt.
            // An old CLI may exit on an unsupported option before it reads
            // even this first frame; retain the same refusal/recovery path.
            turn.write(message).await
                .map_err(|_| ClaudeStartupInputError::Refused(ClaudeStartRefusal::Exited))?;
        }
        initialized_receiver.await
            .map_err(|_| ClaudeStartupInputError::Refused(ClaudeStartRefusal::Exited))?
            .map_err(ClaudeStartupInputError::Refused)?;
        admit_input().map_err(ClaudeStartupInputError::NotSent)?;
        turn.write(input).await.map_err(ClaudeStartupInputError::Failed)?;
        turn.input_ready.store(true, Ordering::Release);
        Ok(())
    });
    tokio::pin!(writes);
    let mut early = ClaudeEarlyOutput::new();
    let mut early_bytes = 0usize;
    loop {
        // EOF and read errors end the drain; the reader reports them in turn.
        let draining = early_bytes < CLAUDE_STARTUP_OUTPUT_BYTES
            && early.back().is_none_or(|last| matches!(last, Ok(Some(_))));
        let progress = tokio::select! {
            biased;
            written = &mut writes => Progress::Written(written),
            line = lines.next_line(), if draining => Progress::Read(line),
        };
        match progress {
            Progress::Written(Ok(Ok(()))) => return Ok(early),
            Progress::Written(Ok(Err(error))) => return Err(error),
            Progress::Written(Err(_)) => {
                return Err(if initialized_sender.is_some() {
                    ClaudeStartupInputError::Refused(ClaudeStartRefusal::Late)
                } else {
                    ClaudeStartupInputError::Failed("Claude Code did not accept its input in time.".into())
                })
            }
            Progress::Read(line) => {
                if let Ok(Some(text)) = &line {
                    early_bytes = early_bytes.saturating_add(text.len());
                    if initialized_sender.is_some() {
                        if let Ok(message) = serde_json::from_str::<Value>(text) {
                            if let Some(verdict) = claude_initialize_answer(&message, &initialize_id, billing) {
                                if let Some(sender) = initialized_sender.take() { let _ = sender.send(verdict); }
                            }
                        }
                    }
                } else if let Some(sender) = initialized_sender.take() {
                    let _ = sender.send(Err(ClaudeStartRefusal::Exited));
                }
                early.push_back(line);
            }
        }
    }
}

/// A resumed CLI can finish restored background notifications before it starts
/// our queued prompt. Match the CLI's command lifecycle to the UUID we sent;
/// that zero-turn result must not close stdin or retire the process.
struct ClaudeTurnBoundary {
    prompt_id: String,
    prompt_started: bool,
    prompt_queued: bool,
}

impl ClaudeTurnBoundary {
    fn new(prompt_id: String, resumed: bool) -> Self {
        Self {
            prompt_id,
            // A fresh process cannot emit restored work. A resumed process can,
            // so its output is not attributable to our prompt until the CLI
            // acknowledges that prompt's lifecycle.
            prompt_started: !resumed,
            prompt_queued: false,
        }
    }

    fn ends_turn(&mut self, message: &Value) -> bool {
        let kind = message.get("type").and_then(Value::as_str);
        if kind == Some("command_lifecycle")
            && message.get("command_uuid").and_then(Value::as_str) == Some(&self.prompt_id)
        {
            match message.get("state").and_then(Value::as_str) {
                Some("queued") => self.prompt_queued = true,
                Some("started" | "completed") => {
                    self.prompt_started = true;
                    self.prompt_queued = false;
                }
                _ => {}
            }
        }
        if kind != Some("result") {
            return false;
        }
        // Preserve errors and legacy CLI behavior, and preserve genuine empty
        // answers after the prompt starts so the UI can report them normally.
        !(self.prompt_pending()
            && message.get("subtype").and_then(Value::as_str) == Some("success")
            && message.get("is_error").and_then(Value::as_bool) == Some(false)
            && message.get("num_turns").and_then(Value::as_u64) == Some(0)
            && message
                .get("result")
                .and_then(Value::as_str)
                .is_some_and(|text| text.trim().is_empty()))
    }

    /// True until a resumed CLI has started our prompt. This includes both the
    /// interval before its first lifecycle acknowledgement and an explicitly
    /// queued prompt, when terminal output can still belong to restored work.
    fn prompt_pending(&self) -> bool {
        !self.prompt_started || self.prompt_queued
    }
}

/// Claude Code normally follows a terminal assistant message with a top-level
/// `result` envelope. Some short alias-selected turns have been observed to
/// exit after the assistant's explicit `end_turn` without writing that final
/// envelope. Preserve the stronger result boundary when it arrives, but use
/// this provider-authored stop reason as recovery evidence after process exit.
fn claude_assistant_ends_turn(message: &Value) -> bool {
    claude_root_assistant(message)
        && message
            .get("message")
            .and_then(|message| message.get("stop_reason"))
            .and_then(Value::as_str)
            == Some("end_turn")
}

/// A root assistant envelope that can carry the answer: not a nested agent's
/// message and not a provider-authored error.
fn claude_root_assistant(message: &Value) -> bool {
    message.get("type").and_then(Value::as_str) == Some("assistant")
        // Provider-authored error messages can also carry `end_turn`. They
        // never prove a successful answer when the result envelope is missing.
        && message.get("error").is_none_or(Value::is_null)
        && message.get("isApiErrorMessage").and_then(Value::as_bool) != Some(true)
        // A nested agent's final message ends that agent's turn, not the root
        // turn Mythra Code is waiting on.
        && message
            .get("parent_tool_use_id")
            .is_none_or(Value::is_null)
}

/// The root assistant message being assembled, so exit recovery and empty
/// results name that exact whole message rather than whatever text came last.
/// Claude Code emits one envelope per content block under one message id
/// (thinking, text and tool_use envelopes share it, one block each), so a
/// single-block envelope adds its block; an envelope carrying several blocks
/// is the message so far and replaces them.
#[derive(Default)]
struct ClaudeRootAssistant {
    id: String,
    text: String,
    tool_use: bool,
}

fn accumulate_claude_root_assistant(message: &Value, current: Option<ClaudeRootAssistant>) -> ClaudeRootAssistant {
    let assistant = message.get("message");
    let id = assistant
        .and_then(|assistant| assistant.get("id"))
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let content: &[Value] = assistant
        .and_then(|assistant| assistant.get("content"))
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default();
    let text: String = content
        .iter()
        .filter(|block| block.get("type").and_then(Value::as_str) == Some("text"))
        .filter_map(|block| block.get("text").and_then(Value::as_str))
        .collect();
    let tool_use = content
        .iter()
        .any(|block| block.get("type").and_then(Value::as_str) == Some("tool_use"));
    match current {
        Some(mut current) if current.id == id && content.len() <= 1 => {
            current.text.push_str(&text);
            current.tool_use |= tool_use;
            current
        }
        _ => ClaudeRootAssistant { id, text, tool_use },
    }
}

/// Output proving the CLI kept working after an assistant ended its turn: a
/// non-terminal assistant activity, a tool result, a steered follow-up prompt,
/// or a permission request. Recovery is only sound while an `end_turn` is still
/// the last thing the CLI did, so any of these withdraws the evidence.
fn claude_reopens_turn(message: &Value) -> bool {
    match message.get("type").and_then(Value::as_str) {
        Some("assistant") => !claude_assistant_ends_turn(message),
        Some("user" | "control_request") => true,
        Some("stream_event") => {
            message
                .get("event")
                .and_then(|event| event.get("type"))
                .and_then(Value::as_str)
                == Some("message_start")
        }
        _ => false,
    }
}

fn claude_can_recover_at_exit(
    saw_terminal_assistant: bool,
    exit: Option<&std::process::ExitStatus>,
) -> bool {
    // A crash, signal, cancellation, or forced reap must remain a failure even
    // when the CLI emitted an answer before failing to finish/save the turn.
    saw_terminal_assistant && exit.is_some_and(std::process::ExitStatus::success)
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
        self.push_text(line);
    }

    // Trimming shifts the whole buffer, so let it grow to twice the limit and
    // trim then, instead of on every line once full. `contents` returns the
    // same bounded tail either way.
    fn push_text(&mut self, text: &str) {
        self.text.push_str(text);
        if self.text.len() > self.limit.saturating_mul(2) {
            let cut = self.tail_start();
            self.text.drain(..cut);
        }
    }

    fn tail_start(&self) -> usize {
        let excess = self.text.len().saturating_sub(self.limit);
        (excess..self.text.len())
            .find(|index| self.text.is_char_boundary(*index))
            .unwrap_or(self.text.len())
    }

    fn contents(&self) -> &str {
        &self.text[self.tail_start()..]
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
    running_path: Option<String>,
    data_home: Option<String>,
    version: Option<String>,
    running_version: Option<String>,
    running_commands: usize,
    runtime_changed: bool,
    /// The installed version is lower than the one the running app-server
    /// loaded. Switching to it would be a downgrade.
    installed_older: bool,
    compatible: bool,
    warning: Option<String>,
}

const CLAUDE_LATEST_VERSION_URL: &str = "https://downloads.claude.ai/claude-code-releases/latest";
const CODEX_LATEST_RELEASE_URL: &str = "https://releases.openai.com/codex/channels/latest";
const CLAUDE_INSTALLER_URL: &str = "https://claude.ai/install.sh";
const CLAUDE_INSTALLER_WINDOWS_URL: &str = "https://claude.ai/install.ps1";
const CODEX_INSTALLER_URL: &str = "https://chatgpt.com/codex/install.sh";
const CODEX_INSTALLER_WINDOWS_URL: &str = "https://chatgpt.com/codex/install.ps1";
const RUNTIME_UPDATE_OUTPUT_BYTES: usize = 32 * 1024;
// Codex's channel metadata includes the complete asset manifest and is about
// 47 KiB today; leave bounded growth room without accepting an arbitrary body.
const RUNTIME_VERSION_RESPONSE_BYTES: usize = 128 * 1024;
const RUNTIME_INSTALLER_RESPONSE_BYTES: usize = 2 * 1024 * 1024;
const RUNTIME_UPDATE_TIMEOUT: Duration = Duration::from_secs(8 * 60);
const RUNTIME_UPDATE_OUTPUT_DRAIN_TIMEOUT: Duration = Duration::from_secs(2);

#[cfg(windows)]
struct TemporaryInstallerScript {
    path: PathBuf,
}

#[cfg(windows)]
impl TemporaryInstallerScript {
    fn create(contents: &str) -> Result<Self, String> {
        let path = env::temp_dir().join(format!(
            "mythra-runtime-installer-{}.ps1",
            uuid::Uuid::new_v4()
        ));
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .map_err(|error| format!("Could not prepare the runtime installer: {error}"))?;
        if let Err(error) = std::io::Write::write_all(&mut file, contents.as_bytes()) {
            drop(file);
            let _ = fs::remove_file(&path);
            return Err(format!("Could not prepare the runtime installer: {error}"));
        }
        Ok(Self { path })
    }
}

#[cfg(windows)]
impl Drop for TemporaryInstallerScript {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DeveloperRuntimeTargetStatus {
    installed: bool,
    current_version: Option<String>,
    latest_version: Option<String>,
    update_available: bool,
    can_update: bool,
    source: Option<String>,
    error: Option<String>,
    /// Executable Mythra Code would start next (a disk probe).
    path: Option<String>,
    /// Codex only: facts recorded when the running app-server started.
    running_path: Option<String>,
    running_version: Option<String>,
    /// Codex only: a selectable installation differs from the running one
    /// and is not older than it.
    restart_required: bool,
    notice: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DeveloperRuntimeUpdateStatus {
    checked_at: i64,
    codex: DeveloperRuntimeTargetStatus,
    claude: DeveloperRuntimeTargetStatus,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DeveloperRuntimeUpdateResult {
    status: DeveloperRuntimeUpdateStatus,
    message: String,
    restart_required: bool,
}

impl AppServer {
    fn track_successful_request(
        &self,
        method: &str,
        source_thread_id: Option<&str>,
        result: &Value,
    ) {
        if let (Some(id), Some(provider)) = (
            result.pointer("/thread/id").and_then(Value::as_str),
            result.pointer("/thread/modelProvider").and_then(Value::as_str),
        ) {
            self.thread_providers.write().unwrap_or_else(std::sync::PoisonError::into_inner)
                .insert(id.to_owned(), provider.to_owned());
        }
        {
            let mut loaded = self
                .loaded_threads
                .write()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            // Fork returns the new thread, but successfully forking also proves
            // the source is resident. Over-reporting costs a guarded restart;
            // under-reporting can silently ignore startup-only configuration.
            loaded.extend(successfully_loaded_thread_ids(
                method,
                source_thread_id,
                result,
            ));
        }
        if method == "thread/delete" {
            if let Some(thread_id) = source_thread_id {
                self.thread_providers.write().unwrap_or_else(std::sync::PoisonError::into_inner).remove(thread_id);
                self.loaded_threads
                    .write()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .remove(thread_id);
            }
        }
    }

    fn has_loaded_thread(&self, thread_id: &str) -> bool {
        self.loaded_threads
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .contains(thread_id)
    }

    async fn request(&self, method: &str, params: Value) -> Result<Value, String> {
        validate_command_timeout_runtime(method, &params, &self.runtime_version)
            .map_err(|error| format!("MYTHRA_NOT_DISPATCHED: {}", provider_error_text(&error)))?;
        let mut activity_guard = self.lifecycle.begin_activity(
            &self.instance,
            method,
            params.get("threadId").and_then(Value::as_str),
        ).map_err(|error| format!("MYTHRA_NOT_DISPATCHED: {}", provider_error_text(&error)))?;
        let mut dispatch_attempted = false;
        let mut replied = false;
        let result = async {
            let (write_deadline, response_deadline) =
                app_server_request_deadlines(method, &params, Instant::now())?;
            let id = self.next_id.fetch_add(1, Ordering::Relaxed);
            if let Some(guard) = activity_guard.as_mut() { guard.register_command_request(id); }
            let (sender, receiver) = oneshot::channel();
            self.pending.lock().await.insert(id, sender);

            let tracking_thread_id = params
                .get("threadId")
                .and_then(Value::as_str)
                .map(str::to_owned);
            let message = json!({ "method": method, "id": id, "params": params });
            // Startup configuration becomes uncertain at the write boundary,
            // rather than cold again when an acknowledgement times out.
            if matches!(method, "thread/resume" | "thread/fork" | "thread/rollback") {
                if let Some(thread_id) = tracking_thread_id.as_ref() {
                    self.loaded_threads.write().unwrap_or_else(std::sync::PoisonError::into_inner).insert(thread_id.clone());
                }
            }
            dispatch_attempted = true;
            if let Err(error) =
                write_server_message(&self.stdin, format!("{message}\n").as_bytes(), write_deadline).await
            {
                // A timed-out write may have sent a partial JSON line. Do not
                // reuse this stream for another request.
                self.alive.store(false, Ordering::Release);
                self.pending.lock().await.remove(&id);
                return Err(format!("MYTHRA_DELIVERY_UNCERTAIN: {error}"));
            }

            let mut result = receive_server_reply(receiver, method, response_deadline, &mut replied).await;
            if !replied {
                result = result.map_err(|error| if error.starts_with("MYTHRA_DELIVERY_UNCERTAIN:") { error }
                    else { format!("MYTHRA_DELIVERY_UNCERTAIN: {error}") });
            }
            if let Ok(value) = &result {
                self.track_successful_request(method, tracking_thread_id.as_deref(), value);
            } else {
                self.pending.lock().await.remove(&id);
            }
            result.map(|mut value| {
                if let Some(object) = value.as_object_mut() { object.insert("runtimeInstance".into(), json!(self.instance)); }
                value
            })
        }
        .await;
        if let Some(activity_guard) = activity_guard {
            activity_guard.finish(result.is_ok(), dispatch_attempted && !replied);
        }
        if dispatch_attempted { result } else {
            result.map_err(|error| format!("MYTHRA_NOT_DISPATCHED: {}", provider_error_text(&error)))
        }
    }

    async fn notify(&self, method: &str, params: Value) -> Result<(), String> {
        let message = json!({ "method": method, "params": params });
        let result = write_server_message(
            &self.stdin,
            format!("{message}\n").as_bytes(),
            Instant::now() + Duration::from_secs(120),
        )
        .await;
        if result.is_err() {
            self.alive.store(false, Ordering::Release);
        }
        result
    }

    async fn respond(&self, id: Value, result: Value) -> Result<(), String> {
        let message = json!({ "id": id, "result": result });
        let result = write_server_message(
            &self.stdin,
            format!("{message}\n").as_bytes(),
            Instant::now() + Duration::from_secs(120),
        )
        .await;
        if result.is_err() {
            self.alive.store(false, Ordering::Release);
        }
        result
    }

    async fn shutdown(&self) -> Result<(), String> {
        self.alive.store(false, Ordering::Release);
        let mut owned_threads = self.loaded_threads.read().unwrap_or_else(std::sync::PoisonError::into_inner).clone();
        {
            let lifecycle = self.lifecycle.lock();
            if lifecycle.instance.as_deref() == Some(&self.instance) {
                owned_threads.extend(lifecycle.active_turns.iter().cloned());
                owned_threads.extend(lifecycle.active_native_agents.iter().cloned());
                owned_threads.extend(lifecycle.starting_turns.iter().cloned());
            }
        }
        cutoff_runtime_child(&self.child, &self.cutoff).await?;
        clear_server_identity(&self.identity_slot, self.identity);
        if let Some(task) = &self.openrouter_proxy_task {
            task.abort();
        }
        // An earlier EOF notification may have reported uncertainty. Publish
        // the later checked outcome for this same instance before replacement.
        let _ = self.app.emit("codex-runtime", json!({ "alive": false, "instance": self.instance,
            "runtimeInstance": self.instance, "threadIds": owned_threads, "cutoffConfirmed": true }));
        self.lifecycle.clear_instance(&self.instance);
        Ok(())
    }

    fn is_alive(&self) -> bool {
        self.alive.load(Ordering::Acquire)
    }
}

/// One in-flight OS read per credential. Concurrent callers receive the same
/// result. A successful in-app save replaces the read with its known value so
/// the immediate runtime restart cannot pick up an older in-flight result.
struct KeyringReadSlot(StdMutex<Option<Arc<KeyringReadSession>>>);

struct KeyringReadSession {
    result: watch::Receiver<Option<Option<String>>>,
    invalidated: AtomicBool,
    blocked_origin: Option<Weak<KeyringReadSession>>,
    saved_override: bool,
}

fn publish_saved_key(
    slot: &'static KeyringReadSlot,
    value: Option<String>,
) -> Arc<KeyringReadSession> {
    let (_sender, result) = watch::channel(Some(value));
    let mut current = slot
        .0
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let blocked_origin = current.as_ref().and_then(|old| {
        if old.saved_override {
            old.blocked_origin.clone()
        } else {
            Some(Arc::downgrade(old))
        }
    });
    let new = Arc::new(KeyringReadSession {
        result,
        invalidated: AtomicBool::new(false),
        blocked_origin,
        saved_override: true,
    });
    if let Some(old) = current.as_ref() {
        old.invalidated.store(true, Ordering::Release);
    }
    *current = Some(new.clone());
    new
}

fn clear_saved_key_after_restart(slot: &'static KeyringReadSlot, saved: &Arc<KeyringReadSession>) {
    // When an old OS read is stuck, retain this known value until that worker
    // exits; otherwise clear it after the immediate runtime restart.
    if saved.blocked_origin.is_some() {
        return;
    }
    let mut current = slot
        .0
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if current
        .as_ref()
        .is_some_and(|active| Arc::ptr_eq(active, saved))
    {
        *current = None;
    }
}

struct KeyringReadGuard {
    slot: &'static KeyringReadSlot,
    session: Arc<KeyringReadSession>,
}

impl Drop for KeyringReadGuard {
    fn drop(&mut self) {
        let mut current = self
            .slot
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if current.as_ref().is_some_and(|active| {
            Arc::ptr_eq(active, &self.session)
                || active
                    .blocked_origin
                    .as_ref()
                    .and_then(Weak::upgrade)
                    .is_some_and(|origin| Arc::ptr_eq(&origin, &self.session))
        }) {
            *current = None;
        }
    }
}

async fn bounded_keyring_read<F>(
    slot: &'static KeyringReadSlot,
    limit: Duration,
    read: F,
) -> Option<String>
where
    F: FnOnce() -> Option<String> + Send + 'static,
{
    // macOS Keychain can block indefinitely in SecKeychainFindGenericPassword.
    // A timed-out spawn_blocking task cannot be stopped. Keep its session
    // available so later callers join it instead of starting another worker.
    let mut read = Some(read);
    let session = {
        let mut current = slot
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(session) = current.as_ref() {
            session.clone()
        } else {
            let (sender, result) = watch::channel(None);
            let session = Arc::new(KeyringReadSession {
                result,
                invalidated: AtomicBool::new(false),
                blocked_origin: None,
                saved_override: false,
            });
            *current = Some(session.clone());
            let worker_session = session.clone();
            let work = read.take().expect("new keyring session owns the read");
            tauri::async_runtime::spawn_blocking(move || {
                let _guard = KeyringReadGuard {
                    slot,
                    session: worker_session,
                };
                let _ = sender.send(Some(work()));
            });
            session
        }
    };
    let mut result = session.result.clone();
    let value = timeout(limit, async {
        loop {
            if let Some(value) = result.borrow().clone() {
                return value;
            }
            result.changed().await.ok()?;
        }
    })
    .await
    .ok()
    .flatten();
    if session.invalidated.load(Ordering::Acquire) {
        None
    } else {
        value
    }
}

async fn openrouter_key() -> Option<String> {
    if release_qa::active() {
        return None;
    }
    bounded_keyring_read(&OPENROUTER_KEY_READ, KEYRING_READ_TIMEOUT, || {
        let entry = keyring::Entry::new(KEYRING_SERVICE, OPENROUTER_ACCOUNT).ok()?;
        entry
            .get_password()
            .ok()
            .filter(|value| !value.trim().is_empty())
    })
    .await
}

async fn lmstudio_key() -> Option<String> {
    if release_qa::active() {
        return None;
    }
    bounded_keyring_read(&LMSTUDIO_KEY_READ, KEYRING_READ_TIMEOUT, || {
        let entry = keyring::Entry::new(KEYRING_SERVICE, LMSTUDIO_ACCOUNT).ok()?;
        entry
            .get_password()
            .ok()
            .filter(|value| !value.trim().is_empty())
    })
    .await
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
    if !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(
            "The LM Studio server URL cannot contain credentials, a query, or a fragment.".into(),
        );
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
    app: AppHandle,
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
    let content_type = upstream
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("");
    let observe = status.is_success()
        && (upstream_path == "/responses" || upstream_path == "/chat/completions")
        && (content_type.starts_with("text/event-stream")
            || content_type.starts_with("application/json"));
    let mut receipts =
        openrouter_usage::ReceiptObserver::new(content_type.starts_with("text/event-stream"));
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
        .body(Body::from_stream(upstream.bytes_stream().inspect_ok(
            move |bytes| {
                if observe {
                    if let Some(receipt) = receipts.push(bytes) {
                        let _ = state.app.emit(
                            "codex-event",
                            json!({ "method": "mythra/openrouterCharge", "params": receipt }),
                        );
                    }
                }
            },
        )))
        .unwrap_or_else(|_| {
            proxy_response(
                StatusCode::BAD_GATEWAY,
                "Could not stream OpenRouter response",
            )
        })
}

async fn start_openrouter_proxy(
    api_key: String,
    app: AppHandle,
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
        app,
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
const MYTHRA_CODE_NATIVE_DELEGATION_POLICY: &str = "Provider-native task, team, and agent spawning is disabled in Mythra Code. Never use collaboration.spawn_agent or another provider-native agent tool. When the mythra_agents MCP bridge exposes spawn_mythra_agent, use that uniquely named tool exclusively and obey its exact approved destination list; when it is absent, do not spawn sub-agents.";

/// Configuration keys Mythra Code re-asserts on every startup, as
/// `(section, key, value)` with TOML-encoded values. Everything else in
/// config.toml (model selection, MCP servers, …) belongs to the user and the
/// Codex runtime and is preserved verbatim.
fn managed_runtime_config(openrouter_base_url: &str) -> Vec<(&'static str, &'static str, String)> {
    let base_url = serde_json::to_string(openrouter_base_url)
        .unwrap_or_else(|_| format!("\"{OPENROUTER_DEFAULT_BASE_URL}\""));
    let native_delegation_policy = serde_json::to_string(MYTHRA_CODE_NATIVE_DELEGATION_POLICY)
        .expect("static native delegation policy must encode as a TOML string");
    let mut managed = vec![
        ("", "cli_auth_credentials_store", "\"keyring\"".into()),
        ("", "project_doc_max_bytes", "0".into()),
        // Codex also keys native team delegation off a host-level mode. This
        // prevents that injected team role from competing with the exact,
        // user-approved Mythra Code MCP destination roster.
        (
            "",
            "multi_agent_mode",
            format!("{{ custom = {native_delegation_policy} }}"),
        ),
        // Off is authoritative only with agents disabled and both native
        // feature flags disabled. The small legacy limits are compatibility
        // defaults, not the mechanism that prevents native spawning.
        ("agents", "max_threads", "1".into()),
        ("agents", "max_depth", "1".into()),
        ("agents", "enabled", "false".into()),
        ("features", "multi_agent", "false".into()),
        ("features", "multi_agent_v2", "false".into()),
        ("model_providers.openrouter", "base_url", base_url),
    ];
    // Windows Credential Manager caps a generic credential at 2,560 bytes,
    // and a ChatGPT token bundle is larger. With the plain keyring store the
    // browser sign-in ends on the callback page with a 500 "Unable to
    // persist auth file" right after the identity provider step. Codex
    // ≥ 0.140 keeps only an encryption key in the keyring and the payload in
    // an encrypted local-secrets file when this feature is on; it defaults on
    // for Windows, but a user-level or stale profile setting must not be able
    // to turn it back off.
    if cfg!(windows) {
        managed.push(("features", "secret_auth_storage", "true".into()));
    }
    managed
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
        .map_err(|error| format!("Could not create Mythra Code runtime directory: {error}"))?;

    let config_path = codex_home.join("config.toml");
    let base_url = openrouter_base_url.unwrap_or(OPENROUTER_DEFAULT_BASE_URL);
    let existing = match tokio::fs::read_to_string(&config_path).await {
        Ok(existing) => Some(existing),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => {
            return Err(format!(
                "Could not read Mythra Code runtime configuration: {error}"
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
            let native_delegation_policy =
                serde_json::to_string(MYTHRA_CODE_NATIVE_DELEGATION_POLICY).map_err(|error| {
                    format!("Could not encode the native delegation policy: {error}")
                })?;
            // See managed_runtime_config for why Windows pins this feature.
            let secret_auth_storage = if cfg!(windows) {
                "\nsecret_auth_storage = true"
            } else {
                ""
            };
            Some(format!(
                r#"cli_auth_credentials_store = "keyring"
model_provider = "openai"
project_doc_max_bytes = 0
project_doc_fallback_filenames = []
developer_instructions = ""
multi_agent_mode = {{ custom = {native_delegation_policy} }}

[agents]
max_threads = 1
max_depth = 1
enabled = false

[features]
multi_agent = false
multi_agent_v2 = false{secret_auth_storage}

[model_providers.openrouter]
name = "OpenRouter"
base_url = {base_url_toml}
env_key = "OPENROUTER_API_KEY"
env_key_instructions = "Add your OpenRouter API key in Mythra Code Settings."
wire_api = "responses"
"#
            ))
        }
    };

    if let Some(config) = updated {
        tokio::fs::write(&config_path, config)
            .await
            .map_err(|error| {
                format!("Could not write Mythra Code runtime configuration: {error}")
            })?;
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

const RUNTIME_PROBE_TIMEOUT: Duration = Duration::from_secs(3);

#[cfg(not(windows))]
async fn find_on_path(program: &str) -> Option<PathBuf> {
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
async fn find_on_path(program: &str) -> Option<PathBuf> {
    let mut command = background_command("where.exe");
    command.arg(program).kill_on_drop(true);
    let output = timeout(RUNTIME_PROBE_TIMEOUT, command.output())
        .await
        .ok()?
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
        // working when Mythra Code is launched from Explorer with a stale PATH.
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
    let mut command = background_command(shell);
    command
        .args(["-lc", &format!("command -v {}", program)])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    // User shell startup files can block. Discovery must not leave an account
    // refresh waiting forever (or leave its child running after timeout).
    let output = timeout(RUNTIME_PROBE_TIMEOUT, command.output())
        .await
        .ok()?
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

fn codex_runtime_override() -> Option<OsString> {
    env::var_os("MYTHRA_CODE_CODEX_PATH")
        .or_else(|| env::var_os(concat!("OPEN", "KIWI_CODEX_PATH")))
}

fn claude_runtime_override() -> Option<OsString> {
    env::var_os("MYTHRA_CODE_CLAUDE_PATH")
        .or_else(|| env::var_os(concat!("OPEN", "KIWI_CLAUDE_PATH")))
}

async fn resolve_codex_runtime(
    app: &AppHandle,
    state: &RuntimeState,
) -> Result<ResolvedCodexRuntime, String> {
    // Runtime discovery is single-flight. Several startup consumers may ask
    // for status at once; keeping this guard across the bounded probes makes
    // every follower reuse the first verified path instead of launching its
    // own where.exe / codex --version process tree.
    let mut cached = state.codex_runtime.lock().await;
    if let Some(runtime) = cached.as_ref() {
        // The same path is not the same binary: the official installer
        // retargets its link in place, so reuse requires the same file.
        if executable_identity(&runtime.path).await == runtime.identity {
            return Ok(runtime.clone());
        }
    }
    *cached = None;
    let resolved = discover_codex_runtime(app).await?;
    *cached = Some(resolved.clone());
    Ok(resolved)
}

/// Probe a Codex executable and bind the reported version to the file that
/// reported it. A file replaced during the probe is never certified.
async fn probe_codex_runtime(path: &Path) -> Option<ResolvedCodexRuntime> {
    // One retry lets a link swap that finished during the probe verify.
    for _ in 0..2 {
        let identity = executable_identity(path).await;
        if identity.metadata.is_none() {
            return None;
        }
        let version = runtime_version(path).await?;
        if executable_identity(path).await == identity {
            return Some(ResolvedCodexRuntime {
                path: path.to_path_buf(),
                version,
                identity,
            });
        }
    }
    None
}

/// The launcher and selection markers of the official Codex installer, using
/// the same `CODEX_INSTALL_DIR` and `CODEX_HOME` rules as install.sh and
/// install.ps1. These come from the user's environment that Mythra Code and
/// the installer it runs both inherit, never the private CODEX_HOME given to
/// Mythra Code's own app-server.
struct OfficialCodexSelection {
    launcher: PathBuf,
    markers: Vec<PathBuf>,
}

impl OfficialCodexSelection {
    /// `symlink_metadata` counts a dangling symlink or junction as present.
    fn present(&self) -> bool {
        self.markers
            .iter()
            .any(|marker| fs::symlink_metadata(marker).is_ok())
    }
}

fn nonempty_env_path(name: &str) -> Option<PathBuf> {
    env::var_os(name)
        .filter(|value| !value.to_string_lossy().trim().is_empty())
        .map(PathBuf::from)
}

fn official_codex_selection(app: &AppHandle) -> Option<OfficialCodexSelection> {
    let home = crate::release_qa::home_dir(app).ok();
    #[cfg(windows)]
    let install_dir = nonempty_env_path("CODEX_INSTALL_DIR").or_else(|| {
        nonempty_env_path("LOCALAPPDATA").map(|directory| directory.join("Programs/OpenAI/Codex/bin"))
    })?;
    #[cfg(not(windows))]
    let install_dir = nonempty_env_path("CODEX_INSTALL_DIR")
        .or_else(|| home.as_ref().map(|home| home.join(".local/bin")))?;
    let launcher = install_dir.join(if cfg!(windows) { "codex.exe" } else { "codex" });
    let mut markers = vec![launcher.clone()];
    // The Windows visible bin directory is itself the installer's junction.
    // On Unix it is a shared directory such as ~/.local/bin, so only the
    // Codex entry in it counts.
    #[cfg(windows)]
    markers.push(install_dir);
    if let Some(codex_home) =
        nonempty_env_path("CODEX_HOME").or_else(|| home.as_ref().map(|home| home.join(".codex")))
    {
        markers.push(codex_home.join("packages/standalone/current"));
    }
    Some(OfficialCodexSelection { launcher, markers })
}

fn broken_codex_selection_error(launcher: &Path) -> String {
    format!(
        "The official Codex installation at {} can't be started, so Mythra Code won't switch to a different Codex installation. Reinstall Codex in Settings › Updates. If that doesn't fix it, repair or remove that installation, or set MYTHRA_CODE_CODEX_PATH to a working Codex executable.",
        launcher.display()
    )
}

async fn discover_codex_runtime(app: &AppHandle) -> Result<ResolvedCodexRuntime, String> {
    let mut candidates = Vec::new();
    let executable_name = if cfg!(windows) { "codex.exe" } else { "codex" };

    if let Some(override_path) = codex_runtime_override() {
        let override_path = PathBuf::from(override_path);
        if !override_path.is_file() {
            return Err(
            "MYTHRA_CODE_CODEX_PATH does not point to a Codex executable. Update or remove it, then choose Try again.".into()
            );
        }
        return probe_codex_runtime(&override_path).await.ok_or_else(|| {
            "MYTHRA_CODE_CODEX_PATH could not be started. Update or remove it, then choose Try again.".to_string()
        });
    }

    // Prefer the official installer's launcher. This lets the Updates pane
    // move a machine away from a stale npm shim or an embedded ChatGPT copy
    // without relying on the sparse PATH of a GUI launch. When that
    // installation exists but cannot start, do not silently fall back to an
    // older package-manager copy; npm-only setups have no markers at all.
    if let Some(selection) = official_codex_selection(app) {
        if let Some(runtime) = probe_codex_runtime(&selection.launcher).await {
            return Ok(runtime);
        }
        if selection.present() {
            return Err(broken_codex_selection_error(&selection.launcher));
        }
    }
    if let Ok(home) = crate::release_qa::home_dir(app) {
        #[cfg(windows)]
        if let Some(local_app_data) = env::var_os("LOCALAPPDATA").map(PathBuf::from) {
            push_candidate(
                &mut candidates,
                local_app_data.join("Programs/OpenAI/Codex/bin/codex.exe"),
            );
        }
        for relative in [".local/bin/codex", ".local/bin/codex.exe"] {
            push_candidate(&mut candidates, home.join(relative));
        }
    }

    #[cfg(windows)]
    push_windows_npm_codex_candidates(&mut candidates);

    // Explorer-launched Windows apps commonly have a sparse PATH. Probe the
    // deterministic npm installation first so an unrelated or stalled app
    // execution alias cannot delay every startup.
    #[cfg(windows)]
    for candidate in candidates.iter().filter(|candidate| candidate.is_file()) {
        if let Some(resolved) = probe_codex_runtime(candidate).await {
            return Ok(resolved);
        }
    }

    if let Some(candidate) = find_on_path(executable_name).await {
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

    if let Ok(home) = crate::release_qa::home_dir(app) {
        #[cfg(target_os = "macos")]
        push_candidate(
            &mut candidates,
            home.join("Applications/ChatGPT.app/Contents/Resources/codex"),
        );
        for relative in [
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
    for candidate in candidates
        .into_iter()
        .filter(|candidate| candidate.is_file())
    {
        // `where.exe` can expose protected WindowsApps resource paths that
        // exist but cannot be launched directly. Accept only a runtime that
        // successfully executes, then the later app-server spawn is reliable.
        if let Some(resolved) = probe_codex_runtime(&candidate).await {
            return Ok(resolved);
        }
    }
    #[cfg(not(windows))]
    if let Some(candidate) = candidates.into_iter().find(|candidate| candidate.is_file()) {
        if let Some(resolved) = probe_codex_runtime(&candidate).await {
            return Ok(resolved);
        }
    }
    if let Some(candidate) = find_with_login_shell(executable_name).await {
        if let Some(resolved) = probe_codex_runtime(&candidate).await {
            return Ok(resolved);
        }
    }

    Err("Mythra Code could not find the Codex runtime. Install the Codex CLI or ChatGPT desktop app, then choose Try again. Advanced users can set MYTHRA_CODE_CODEX_PATH to the Codex executable.".into())
}

fn runtime_source(path: &Path) -> &'static str {
    if path
        .to_string_lossy()
        .contains("ChatGPT.app/Contents/Resources/codex")
    {
        "ChatGPT app"
    } else if codex_runtime_override().is_some_and(|configured| Path::new(&configured) == path) {
        "Custom path"
    } else {
        "Codex CLI"
    }
}

async fn runtime_version(path: &Path) -> Option<String> {
    let mut command = background_command(path);
    command
        .arg("--version")
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    let output = timeout(RUNTIME_PROBE_TIMEOUT, command.output())
        .await
        .ok()?
        .ok()?;
    output
        .status
        .success()
        .then(|| String::from_utf8_lossy(&output.stdout).trim().to_string())
        .filter(|value| !value.is_empty())
}

struct ClaudeRuntimeVersionCache {
    identity: ExecutableIdentity,
    version: String,
    checked_at: Instant,
}

// Account refreshes need fresh authentication, not another CLI startup merely
// to rediscover its installed version. Share a short-lived compatibility probe
// with executable discovery; Updates explicitly requests fresh version data.
// The identity also invalidates the cache immediately if the binary changes.
async fn claude_runtime_version(path: &Path, force: bool) -> Option<String> {
    static CACHE: std::sync::OnceLock<Mutex<Option<ClaudeRuntimeVersionCache>>> =
        std::sync::OnceLock::new();
    let mut cache = CACHE.get_or_init(|| Mutex::new(None)).lock().await;
    let identity = executable_identity(path).await;
    if !force {
        if let Some(cached) = cache.as_ref() {
            if identity.metadata.is_some()
                && cached.identity == identity
                && cached.checked_at.elapsed() < Duration::from_secs(5 * 60)
            {
                return Some(cached.version.clone());
            }
        }
    }
    *cache = None;
    let version = runtime_version(path).await?;
    // Do not associate a result with a binary replaced during the probe.
    if identity != executable_identity(path).await {
        return None;
    }
    if identity.metadata.is_some() {
        *cache = Some(ClaudeRuntimeVersionCache {
            identity,
            version: version.clone(),
            checked_at: Instant::now(),
        });
    }
    Some(version)
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

/// Pin the actual harness route on every startup RPC. App-owned baseline
/// files are not enough: project/profile layers and omitted renderer config
/// must not reactivate a second delegation system.
fn enforce_codex_delegation_config(method: &str, params: &mut Value) -> Result<(), String> {
    if !matches!(method, "thread/start" | "thread/resume" | "thread/fork") {
        return Ok(());
    }
    let params = params.as_object_mut().ok_or_else(|| "Thread startup requires an object.".to_string())?;
    let config = params.entry("config").or_insert_with(|| json!({}));
    if config.is_null() { *config = json!({}); }
    let config = config.as_object_mut().ok_or_else(|| "Thread startup config must be an object.".to_string())?;
    if config.keys().any(|key| key.starts_with("agents.") || key.starts_with("features.multi_agent")) {
        return Err("Thread delegation settings must use the explicit managed configuration, not dotted overrides.".into());
    }
    let features = config.entry("features").or_insert_with(|| json!({}));
    let features = features.as_object_mut().ok_or_else(|| "Thread startup features must be an object.".to_string())?;
    if features.keys().any(|key| key.starts_with("multi_agent." ) || key.starts_with("multi_agent_v2.")) {
        return Err("Thread delegation settings cannot use dotted feature overrides.".into());
    }
    let native = match features.get("multi_agent_v2") {
        None | Some(Value::Bool(false)) => false,
        Some(Value::Bool(true)) => true,
        Some(Value::Object(value)) => value.get("enabled").and_then(Value::as_bool)
            .ok_or_else(|| "Native Codex V2 configuration requires an explicit enabled flag.".to_string())?,
        _ => return Err("Native Codex V2 configuration has an invalid enabled flag.".into()),
    };
    // The native safety inspection resolves the current cwd's layers and
    // merges the explicit MCP table. Alternate selectors/dotted overrides
    // would describe a different configuration than the one it inspected.
    if native && config.keys().any(|key| key == "profile" || key == "profiles" || key.starts_with("profiles.") || key.starts_with("mcp_servers.")) {
        return Err("Native Codex startup must use explicit MCP tables without alternate configuration profiles.".into());
    }
    let features = config.get_mut("features").and_then(Value::as_object_mut).expect("features were validated above");
    let legacy = match features.get("multi_agent") {
        None => false,
        Some(Value::Bool(value)) => *value,
        _ => return Err("Native Codex legacy configuration has an invalid enabled flag.".into()),
    };
    if !native && legacy {
        return Err("Mythra Code supports only the explicitly selected native Codex V2 route.".into());
    }
    features.insert("multi_agent".into(), json!(native));
    if !native { features.insert("multi_agent_v2".into(), json!(false)); }
    let agents = config.entry("agents").or_insert_with(|| json!({}));
    let agents = agents.as_object_mut().ok_or_else(|| "Thread startup agents must be an object.".to_string())?;
    if let Some(enabled) = agents.get("enabled") {
        let enabled = enabled.as_bool().ok_or_else(|| "Native Codex agents require a boolean enabled flag.".to_string())?;
        if !native && enabled { return Err("Native Codex agents require the explicitly selected V2 route.".into()); }
    }
    agents.insert("enabled".into(), json!(native));
    Ok(())
}

fn requests_native_codex(method: &str, params: &Value) -> bool {
    if !matches!(method, "thread/start" | "thread/resume" | "thread/fork") {
        return false;
    }
    let v2 = params.pointer("/config/features/multi_agent_v2");
    v2 == Some(&Value::Bool(true))
        || v2
            .and_then(|value| value.get("enabled"))
            .and_then(Value::as_bool)
            == Some(true)
}

async fn validate_native_codex_bridges(
    state: &ChildAgentState,
    method: &str,
    params: &Value,
) -> Result<(), String> {
    if !requests_native_codex(method, params) {
        return Ok(());
    }
    let Some(bridges) = params.pointer("/config/mcp_servers").and_then(Value::as_object) else {
        return Ok(());
    };
    for (name, bridge) in bridges {
    // A retained alias that is explicitly disabled cannot expose tools.
    if bridge.get("enabled") == Some(&Value::Bool(false)) { continue; }
    let bridge_marker = bridge["args"].as_array().is_some_and(|args| args.iter().any(|arg| arg.as_str() == Some("--openkiwi-agent-bridge")));
    if name != "mythra_agents" && !bridge_marker { continue; }
    let args: Vec<String> = bridge["args"]
        .as_array()
        .and_then(|args| {
            args.iter()
                .map(|arg| arg.as_str().map(str::to_owned))
                .collect()
        })
        .ok_or_else(|| {
            "The native thread's Mythra Code project bridge has invalid arguments.".to_string()
        })?;
    let command = bridge["command"].as_str().unwrap_or_default();
    if agents::child_agent_bridge_launch_allows_spawning(state, &args).await {
        return Err("Native Codex sub-agents cannot run with a Mythra Code delegation bridge. Reconfigure this thread's sub-agent mode before starting.".into());
    }
    if !agents::child_agent_bridge_launch_registered(state, name, command, &args).await {
        return Err("The native thread's Mythra Code project bridge is no longer active.".into());
    }
    }
    Ok(())
}

/// MCP server tables merge by field in Codex's configuration layers. Keep
/// inherited aliases visible while applying per-thread command/args/disabled
/// overrides, without copying unrelated configuration or exposing its secrets.
fn native_codex_effective_bridge_params(params: &Value, effective_config: &Value) -> Result<Value, String> {
    if !effective_config.is_object() {
        return Err("Could not verify inherited Mythra Code bridges before native startup.".into());
    }
    let mut bridges = match effective_config.get("mcp_servers") {
        None | Some(Value::Null) => serde_json::Map::new(),
        Some(Value::Object(bridges)) => bridges.clone(),
        _ => return Err("Could not verify inherited Mythra Code bridge configuration.".into()),
    };
    if let Some(overrides) = params.pointer("/config/mcp_servers") {
        let overrides = overrides.as_object().ok_or_else(|| "Native thread MCP configuration must be an object.".to_string())?;
        for (name, server) in overrides {
            match (bridges.get_mut(name), server.as_object()) {
                (Some(Value::Object(inherited)), Some(fields)) => inherited.extend(fields.clone()),
                _ => { bridges.insert(name.clone(), server.clone()); }
            }
        }
    }
    Ok(json!({ "config": { "features": { "multi_agent_v2": true }, "mcp_servers": bridges } }))
}

fn validate_native_codex_runtime(
    method: &str,
    params: &Value,
    version: &str,
) -> Result<(), String> {
    // This setting also applies to parent and Mythra-managed child turns.
    if let Some(value) = params.pointer("/config/model_auto_compact_token_limit") {
        if !value.is_null() {
            if value.as_u64().is_none_or(|value| !(100_000..=1_000_000).contains(&value)) {
                return Err("Codex auto-compaction must be a whole token count from 100,000 to 1,000,000.".into());
            }
            if params.pointer("/config/model_auto_compact_token_limit_scope").and_then(Value::as_str) != Some("total") {
                return Err("Codex auto-compaction must count the full active context.".into());
            }
        }
    }
    if !requests_native_codex(method, params) {
        return Ok(());
    }
    if parsed_runtime_version(version)
        .is_none_or(|version| version < semver::Version::new(0, 161, 0))
    {
        return Err("Native Codex sub-agents need Codex 0.161.0 or newer. Update Codex before using this mode.".into());
    }
    let provider = params
        .get("modelProvider")
        .and_then(Value::as_str)
        .or_else(|| {
            params
                .pointer("/config/model_provider")
                .and_then(Value::as_str)
        });
    if provider != Some("openai") {
        return Err(
            "Native Codex sub-agents are available only for the OpenAI provider.".into(),
        );
    }
    if let Some(value) = params.pointer("/config/agents/default_subagent_model") {
        let valid = value.as_str().is_some_and(|value| {
            !value.is_empty() && value.len() <= 200 && value.bytes().all(|byte| {
                byte.is_ascii_alphanumeric() || b"._:/-".contains(&byte)
            })
        });
        if !valid {
            return Err("The native Codex child model must be a valid identifier.".into());
        }
    }
    if let Some(value) = params.pointer("/config/agents/default_subagent_reasoning_effort") {
        if !matches!(value.as_str(), Some("low" | "medium" | "high" | "xhigh" | "max" | "ultra")) {
            return Err("The native Codex child reasoning effort is invalid.".into());
        }
    }
    Ok(())
}

fn codex_runtime_changed(
    installed_path: &Path,
    installed_version: &str,
    running_path: &Path,
    running_version: &str,
) -> bool {
    installed_path != running_path || installed_version != running_version
}

fn codex_installed_older(installed_version: &str, running_version: &str) -> bool {
    matches!(
        (parsed_runtime_version(installed_version), parsed_runtime_version(running_version)),
        (Some(installed), Some(running)) if installed < running
    )
}

async fn read_codex_runtime_status(app: &AppHandle, state: &RuntimeState) -> CodexRuntimeStatus {
    let data_home = crate::release_qa::app_data_dir(app)
        .ok()
        .map(|path| path.join("codex-home").to_string_lossy().into_owned());
    let running_runtime = state.server.lock().await.as_ref().map(|server| {
        (
            server.runtime_path.clone(),
            server.runtime_version.clone(),
            server.lifecycle.active_command_count(),
        )
    });
    match resolve_codex_runtime(app, state).await {
        Ok(runtime) => {
            let compatible = runtime_is_compatible(&runtime.version);
            let runtime_changed = running_runtime.as_ref().is_some_and(|(path, version, _)| {
                codex_runtime_changed(&runtime.path, &runtime.version, path, version)
            });
            let installed_older = running_runtime.as_ref().is_some_and(|(_, version, _)| {
                codex_installed_older(&runtime.version, version)
            });
            CodexRuntimeStatus {
                available: true,
                source: Some(runtime_source(&runtime.path)),
                path: Some(runtime.path.to_string_lossy().into_owned()),
                running_path: running_runtime
                    .as_ref()
                    .map(|(path, _, _)| path.to_string_lossy().into_owned()),
                data_home,
                warning: (!compatible).then(|| "This Codex runtime predates Mythra Code's tested App Server contract (0.145+). Update Codex before relying on advanced features.".to_string()),
                version: Some(runtime.version),
                running_version: running_runtime.as_ref().map(|(_, version, _)| version.clone()),
                running_commands: running_runtime.as_ref().map_or(0, |(_, _, count)| *count),
                runtime_changed,
                installed_older,
                compatible,
            }
        }
        Err(error) => CodexRuntimeStatus {
            available: false,
            source: None,
            path: None,
            running_path: running_runtime
                .as_ref()
                .map(|(path, _, _)| path.to_string_lossy().into_owned()),
            data_home,
            version: None,
            running_version: running_runtime
                .as_ref()
                .map(|(_, version, _)| version.clone()),
            running_commands: running_runtime.as_ref().map_or(0, |(_, _, count)| *count),
            runtime_changed: false,
            installed_older: false,
            compatible: false,
            warning: Some(error),
        },
    }
}

#[tauri::command]
async fn codex_runtime_status(
    app: AppHandle,
    state: State<'_, RuntimeState>,
) -> Result<CodexRuntimeStatus, String> {
    Ok(read_codex_runtime_status(&app, &state).await)
}

#[tauri::command]
async fn codex_runtime_status_refresh(
    app: AppHandle,
    state: State<'_, RuntimeState>,
) -> Result<CodexRuntimeStatus, String> {
    // Package managers can replace codex while Mythra Code remains open.
    // Compare the executable on disk with the version already loaded by the
    // running app-server before deciding whether its catalog can be refreshed.
    *state.codex_runtime.lock().await = None;
    Ok(read_codex_runtime_status(&app, &state).await)
}

fn parsed_runtime_version(value: &str) -> Option<semver::Version> {
    value
        .split(|character: char| {
            !character.is_ascii_alphanumeric()
                && character != '.'
                && character != '-'
                && character != '+'
        })
        .filter(|part| !part.is_empty())
        .find_map(|part| {
            part.char_indices()
                .filter(|(_, character)| character.is_ascii_digit())
                .find_map(|(index, _)| semver::Version::parse(&part[index..]).ok())
        })
}

fn normalized_runtime_version(value: &str) -> Option<String> {
    parsed_runtime_version(value).map(|version| version.to_string())
}

fn runtime_update_available(current: Option<&str>, latest: Option<&str>) -> bool {
    let Some(current) = current.and_then(parsed_runtime_version) else {
        return false;
    };
    let Some(latest) = latest.and_then(parsed_runtime_version) else {
        return false;
    };
    current < latest
}

fn developer_runtime_target_status(
    installed: bool,
    current_version: Option<String>,
    latest: Result<String, String>,
    source: Option<String>,
    custom_path: bool,
    resolution_error: Option<String>,
    path: Option<String>,
) -> DeveloperRuntimeTargetStatus {
    let latest_version = latest.as_ref().ok().cloned();
    let update_available =
        runtime_update_available(current_version.as_deref(), latest_version.as_deref());
    DeveloperRuntimeTargetStatus {
        installed,
        current_version,
        latest_version,
        update_available,
        can_update: !custom_path,
        source: if custom_path {
            Some("Custom path".to_string())
        } else {
            source
        },
        error: resolution_error.or_else(|| latest.err()),
        path,
        running_path: None,
        running_version: None,
        restart_required: false,
        notice: None,
    }
}

fn codex_update_source(path: &Path, selection: Option<&OfficialCodexSelection>) -> String {
    if codex_runtime_override().is_some_and(|configured| Path::new(&configured) == path) {
        return "Custom path".into();
    }
    if selection.is_some_and(|selection| selection.launcher == path) {
        return "Official installer".into();
    }
    let display = path.to_string_lossy().replace('\\', "/").to_lowercase();
    let resolved = fs::canonicalize(path)
        .map(|path| path.to_string_lossy().replace('\\', "/").to_lowercase())
        .unwrap_or_default();
    let locations = format!("{display}\n{resolved}");
    if locations.contains("chatgpt.app/") {
        "ChatGPT app".into()
    } else if locations.contains("/node_modules/")
        || locations.contains("/npm-global/")
        || locations.contains("/appdata/roaming/npm/")
    {
        "npm".into()
    } else if locations.contains("/cellar/")
        || locations.contains("/caskroom/")
        || display.starts_with("/opt/homebrew/")
    {
        "Homebrew".into()
    } else {
        "Codex CLI".into()
    }
}

fn claude_runtime_source(path: &Path) -> String {
    claude_runtime_source_for_path(
        path,
        fs::canonicalize(path).ok().as_deref(),
        claude_runtime_override().is_some_and(|configured| Path::new(&configured) == path),
    )
}

fn claude_runtime_source_for_path(
    path: &Path,
    resolved_path: Option<&Path>,
    custom_path: bool,
) -> String {
    if custom_path {
        return "Custom path".into();
    }
    let display = path.to_string_lossy().replace('\\', "/").to_lowercase();
    let resolved = resolved_path
        .map(|path| path.to_string_lossy().replace('\\', "/").to_lowercase())
        .unwrap_or_default();
    let locations = format!("{display}\n{resolved}");
    if locations.contains("/.local/share/claude") || locations.contains("/.local/bin/claude") {
        "Native installer".into()
    } else if locations.contains("/cellar/")
        || display.starts_with("/opt/homebrew/")
        || resolved.starts_with("/opt/homebrew/")
    {
        "Homebrew".into()
    } else if locations.contains("/node_modules/")
        || locations.contains("/.npm/")
        || locations.contains("/npm-global/")
        || locations.contains("/appdata/roaming/npm/")
    {
        "npm".into()
    } else if locations.contains("/windowsapps/") {
        "WinGet".into()
    } else {
        "Claude Code".into()
    }
}

struct RuntimeFetchError {
    message: String,
    retryable: bool,
}

fn runtime_transport_error(error: reqwest::Error, reading_body: bool) -> RuntimeFetchError {
    // Certificate/protocol failures are not transient connection failures.
    // Preserve TLS verification and never expose the raw URL/error chain in UI.
    let mut source: Option<&(dyn std::error::Error + 'static)> = Some(&error);
    let mut tls_error = false;
    while let Some(cause) = source {
        if cause.is::<rustls::Error>() {
            tls_error = true;
            break;
        }
        // io::Error::source skips its stored error's own type. Tokio-rustls
        // wraps certificate errors here, so inspect get_ref before following.
        source = match cause.downcast_ref::<std::io::Error>().and_then(|io| io.get_ref()) {
            Some(inner) => Some(inner),
            None => cause.source(),
        };
    }
    RuntimeFetchError {
        message: if tls_error {
            "Couldn’t securely connect to the update service. Check your device’s date and network, then try again."
        } else {
            "Couldn’t check for updates. Check your connection and try again."
        }.into(),
        // reqwest 0.13.4 classifies chunk/read failures as Decode, not Body.
        // Application decoding/size/UTF-8 validation happens separately below.
        retryable: !tls_error && (reading_body || error.is_timeout() || error.is_connect() || error.is_body()),
    }
}

async fn fetch_runtime_text_once(
    client: &reqwest::Client,
    url: &'static str,
    maximum_bytes: usize,
) -> Result<String, RuntimeFetchError> {
    let mut response = client.get(url).send().await.map_err(|error| runtime_transport_error(error, false))?;
    let status = response.status();
    if status.is_client_error() || status.is_server_error() {
        return Err(RuntimeFetchError {
            message: format!("The update service is unavailable (HTTP {}). Try again later.", status.as_u16()),
            // Do not hammer rate limits or retry permanent/authentication errors.
            retryable: matches!(status.as_u16(), 408 | 500 | 502 | 503 | 504)
                && !response.headers().contains_key(reqwest::header::RETRY_AFTER),
        });
    }
    if response.content_length().is_some_and(|length| length > maximum_bytes as u64) {
        return Err(RuntimeFetchError {
            message: "The update service returned an unexpectedly large response. Try again later.".into(),
            retryable: false,
        });
    }
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|error| runtime_transport_error(error, true))? {
        if body.len().saturating_add(chunk.len()) > maximum_bytes {
            return Err(RuntimeFetchError {
                message: "The update service returned an unexpectedly large response. Try again later.".into(),
                retryable: false,
            });
        }
        body.extend_from_slice(&chunk);
    }
    String::from_utf8(body)
        .map(|text| text.trim().to_string())
        .map_err(|_| RuntimeFetchError {
            message: "The update service returned an unreadable response. Try again later.".into(),
            retryable: false,
        })
}

async fn fetch_runtime_text(url: &'static str, maximum_bytes: usize) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|_| "Couldn’t prepare the update connection. Try again.".to_string())?;
    // Installer downloads/execution deliberately do not get an application retry.
    fetch_runtime_text_once(&client, url, maximum_bytes).await.map_err(|error| error.message)
}

async fn fetch_runtime_version_text(url: &'static str) -> Result<String, String> {
    let client = reqwest::Client::builder()
        // Name resolution counts toward the connect timeout, and a cold Windows
        // resolver has been observed taking up to 11.6 seconds for one name.
        // An OS lookup that already started keeps running after a timed-out
        // attempt and may warm the system cache for the retry; not guaranteed.
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(18))
        .retry(reqwest::retry::never())
        .build()
        .map_err(|_| "Couldn’t prepare the update connection. Try again.".to_string())?;
    // Only these read-only metadata calls recover automatically. Two attempts,
    // one short delay, and one overall deadline; no background retry loop. The
    // deadline cancels the request in flight, so after a full first attempt
    // the retry only gets the remaining time.
    timeout(Duration::from_secs(28), async {
        for attempt in 0..2 {
            match fetch_runtime_text_once(&client, url, RUNTIME_VERSION_RESPONSE_BYTES).await {
                Ok(text) => return Ok(text),
                Err(error) if attempt == 0 && error.retryable => {
                    tokio::time::sleep(Duration::from_secs(1)).await;
                }
                Err(error) => return Err(error.message),
            }
        }
        unreachable!("the final attempt returns its result")
    }).await.map_err(|_| "Couldn’t check for updates in time. Try again.".to_string())?
}

async fn latest_claude_version() -> Result<String, String> {
    let response =
        fetch_runtime_version_text(CLAUDE_LATEST_VERSION_URL).await?;
    parse_latest_claude_version(&response)
}

fn parse_latest_claude_version(response: &str) -> Result<String, String> {
    let response = response
        .strip_prefix('v')
        .or_else(|| response.strip_prefix('V'))
        .unwrap_or(response);
    semver::Version::parse(response)
        .map(|version| version.to_string())
        .map_err(|_| "Claude's release service returned an invalid version".to_string())
}

async fn latest_codex_version() -> Result<String, String> {
    let response =
        fetch_runtime_version_text(CODEX_LATEST_RELEASE_URL).await?;
    parse_latest_codex_version(&response)
}

fn parse_latest_codex_version(response: &str) -> Result<String, String> {
    let payload: Value = serde_json::from_str(response)
        .map_err(|_| "Codex’s update service returned an unreadable response. Try again later.".to_string())?;
    payload
        .get("tag_name")
        .and_then(Value::as_str)
        .and_then(normalized_runtime_version)
        .ok_or_else(|| "Codex's release service returned an invalid version".to_string())
}

fn push_runtime_output_bytes(
    output: &mut TailBuffer,
    pending: &mut Vec<u8>,
    bytes: &[u8],
    end_of_input: bool,
) {
    pending.extend_from_slice(bytes);
    loop {
        match std::str::from_utf8(pending) {
            Ok(text) => {
                if text.contains('\r') {
                    output.push_text(&text.replace('\r', "\n"));
                } else {
                    output.push_text(text);
                }
                pending.clear();
                break;
            }
            Err(error) => {
                let valid_up_to = error.valid_up_to();
                if valid_up_to > 0 {
                    let text = String::from_utf8(pending[..valid_up_to].to_vec())
                        .expect("UTF-8 validator marked this prefix valid");
                    if text.contains('\r') {
                        output.push_text(&text.replace('\r', "\n"));
                    } else {
                        output.push_text(&text);
                    }
                    pending.drain(..valid_up_to);
                }
                if let Some(error_length) = error.error_len() {
                    output.push_text("\u{fffd}");
                    pending.drain(..error_length);
                } else {
                    if end_of_input {
                        output.push_text("\u{fffd}");
                        pending.clear();
                    }
                    break;
                }
            }
        }
    }
}

async fn collect_bounded_output<R: AsyncRead + Unpin>(mut reader: R) -> String {
    let mut output = TailBuffer::new(RUNTIME_UPDATE_OUTPUT_BYTES);
    let mut pending = Vec::with_capacity(4);
    let mut chunk = [0_u8; 8 * 1024];
    loop {
        match reader.read(&mut chunk).await {
            Ok(0) | Err(_) => break,
            Ok(read) => push_runtime_output_bytes(&mut output, &mut pending, &chunk[..read], false),
        }
    }
    push_runtime_output_bytes(&mut output, &mut pending, &[], true);
    output.contents().trim().to_string()
}

async fn finish_bounded_output(
    mut task: tokio::task::JoinHandle<String>,
    drain_timeout: Duration,
) -> String {
    match timeout(drain_timeout, &mut task).await {
        Ok(Ok(output)) => output,
        Ok(Err(_)) => String::new(),
        Err(_) => {
            // A detached grandchild can inherit the installer's pipe after the
            // installer exits. Do not let that keep Mythra's update UI pending.
            task.abort();
            String::new()
        }
    }
}

async fn run_runtime_update_command(
    command: Command,
    stdin_payload: Option<&[u8]>,
) -> Result<String, String> {
    run_runtime_update_command_with_timeouts(
        command,
        stdin_payload,
        RUNTIME_UPDATE_TIMEOUT,
        RUNTIME_UPDATE_OUTPUT_DRAIN_TIMEOUT,
    )
    .await
}

async fn run_runtime_update_command_with_timeouts(
    mut command: Command,
    stdin_payload: Option<&[u8]>,
    update_timeout: Duration,
    drain_timeout: Duration,
) -> Result<String, String> {
    command
        .stdin(if stdin_payload.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    // The timeout must stop installer descendants as well as the shell that
    // launched them. A dedicated Unix process group gives kill_process_tree a
    // stable target; Windows taskkill /T walks the child tree by pid.
    #[cfg(unix)]
    command.process_group(0);
    let mut child = command
        .spawn()
        .map_err(|error| format!("Could not start the runtime updater: {error}"))?;
    let child_pid = child.id();
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "The runtime updater did not provide stdout".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "The runtime updater did not provide stderr".to_string())?;
    let stdout_task = tokio::spawn(collect_bounded_output(stdout));
    let stderr_task = tokio::spawn(collect_bounded_output(stderr));
    let deadline = Instant::now() + update_timeout;
    let outcome = async {
        if let Some(payload) = stdin_payload {
            let mut stdin = child
                .stdin
                .take()
                .ok_or_else(|| "The runtime updater did not accept its installer".to_string())?;
            timeout_at(deadline, async {
                stdin.write_all(payload).await.map_err(|error| {
                    format!("Could not send the verified installer to the updater: {error}")
                })?;
                stdin.shutdown().await.map_err(|error| {
                    format!("Could not finish sending the installer to the updater: {error}")
                })
            })
            .await
            .map_err(|_| {
                "The runtime update timed out while starting the installer".to_string()
            })??;
        }
        timeout_at(deadline, child.wait())
            .await
            .map_err(|_| "The runtime update timed out".to_string())?
            .map_err(|error| format!("Could not wait for the runtime updater: {error}"))
    }
    .await;
    if outcome.is_err() {
        let timed_out = outcome
            .as_ref()
            .err()
            .is_some_and(|error| error.starts_with("The runtime update timed out"));
        // Non-timeout failures are local pipe/wait errors. Avoid signalling a
        // pid that could already have exited and been reused in that case.
        if timed_out {
            if let Some(pid) = child_pid {
                let _ = kill_process_tree(pid);
            }
        }
        let _ = child.start_kill();
        let _ = child.wait().await;
    }
    let (stdout, stderr) = tokio::join!(
        finish_bounded_output(stdout_task, drain_timeout),
        finish_bounded_output(stderr_task, drain_timeout),
    );
    let status = outcome?;
    let detail = [stdout.trim(), stderr.trim()]
        .into_iter()
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    if status.success() {
        Ok(if detail.is_empty() {
            "Runtime update completed.".into()
        } else {
            detail
        })
    } else {
        Err(if detail.is_empty() {
            format!("The runtime updater exited with {status}")
        } else {
            detail
        })
    }
}

async fn run_official_installer(
    unix_url: &'static str,
    windows_url: &'static str,
    codex: bool,
) -> Result<String, String> {
    #[cfg(windows)]
    let (script, mut command, script_path) = {
        let _ = unix_url;
        let script = fetch_runtime_text(windows_url, RUNTIME_INSTALLER_RESPONSE_BYTES).await?;
        let script_path = TemporaryInstallerScript::create(&script)?;
        let mut command = background_command("powershell.exe");
        command.args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
        ]);
        command.arg(&script_path.path);
        (script, command, Some(script_path))
    };
    #[cfg(not(windows))]
    let (script, mut command, script_path) = {
        let _ = windows_url;
        let script = fetch_runtime_text(unix_url, RUNTIME_INSTALLER_RESPONSE_BYTES).await?;
        let mut command = background_command("/bin/sh");
        command.args(["-s", "--"]);
        (script, command, None::<PathBuf>)
    };
    if codex {
        command.env("CODEX_NON_INTERACTIVE", "true");
    }
    let result =
        run_runtime_update_command(command, script_path.is_none().then_some(script.as_bytes()))
            .await;
    drop(script_path);
    result
}

async fn read_developer_runtime_updates(
    app: &AppHandle,
    state: &RuntimeState,
) -> DeveloperRuntimeUpdateStatus {
    // A manual package-manager update can replace the executable while Mythra
    // remains open. The Updates pane must report the file on disk now, not the
    // version cached when the app server first started.
    *state.codex_runtime.lock().await = None;
    let codex_custom = codex_runtime_override().is_some();
    let claude_custom = claude_runtime_override().is_some();
    let (codex_runtime, claude_path, codex_latest, claude_latest) = tokio::join!(
        resolve_codex_runtime(app, state),
        resolve_claude_binary(app),
        latest_codex_version(),
        latest_claude_version(),
    );
    // Process-start facts of the serving app-server. Do not wait behind a
    // spawn or shutdown holding the slot (Err): that state is unknown, not
    // "no server", and must not read as up to date.
    let codex_running = state.server.try_lock().map(|slot| {
        slot.as_ref()
            .filter(|server| server.is_alive())
            .map(|server| (server.runtime_path.clone(), server.runtime_version.clone()))
    });
    let codex_selection = official_codex_selection(app);
    let (codex_installed, codex_current, codex_source, codex_resolution_error, codex_path) =
        match &codex_runtime {
            Ok(runtime) => (
                true,
                normalized_runtime_version(&runtime.version),
                Some(codex_update_source(&runtime.path, codex_selection.as_ref())),
                None,
                Some(runtime.path.to_string_lossy().into_owned()),
            ),
            Err(error) if codex_custom => {
                (false, None, Some("Custom path".to_string()), Some(error.clone()), None)
            }
            // An official installation that exists but cannot start is
            // installed and repairable, not absent.
            Err(error)
                if codex_selection
                    .as_ref()
                    .is_some_and(OfficialCodexSelection::present) =>
            {
                (
                    true,
                    None,
                    Some("Official installer".to_string()),
                    Some(error.clone()),
                    codex_selection
                        .as_ref()
                        .map(|selection| selection.launcher.to_string_lossy().into_owned()),
                )
            }
            Err(_) => (false, None, None, None, None),
        };
    let mut codex = developer_runtime_target_status(
        codex_installed,
        codex_current,
        codex_latest,
        codex_source,
        codex_custom,
        codex_resolution_error,
        codex_path,
    );
    if codex_running.is_err() {
        codex.notice = Some(
            "Codex is starting or restarting in Mythra Code. Check again in a moment to confirm which version is running."
                .to_string(),
        );
    }
    if let Ok(Some((running_path, running_version))) = codex_running {
        let installed = codex_runtime.as_ref().ok();
        let older = installed
            .is_some_and(|runtime| codex_installed_older(&runtime.version, &running_version));
        // Only a selectable installation that differs from the running
        // process needs a restart, and never one that would downgrade it.
        codex.restart_required = !older
            && installed.is_some_and(|runtime| {
                codex_runtime_changed(&runtime.path, &runtime.version, &running_path, &running_version)
            });
        let running_display =
            normalized_runtime_version(&running_version).unwrap_or_else(|| running_version.clone());
        codex.notice = match installed {
            Some(runtime) if older => Some(format!(
                "Mythra Code is running Codex {running_display}. The installed version is older ({}); restart Mythra Code only if you intend to switch to it.",
                normalized_runtime_version(&runtime.version).unwrap_or_else(|| runtime.version.clone())
            )),
            None => Some(format!(
                "Mythra Code is still running Codex {running_display}, which it started earlier."
            )),
            _ => None,
        };
        codex.running_path = Some(running_path.to_string_lossy().into_owned());
        codex.running_version = Some(running_display);
    }
    let claude_display_path = claude_path
        .as_ref()
        .ok()
        .map(|path| path.to_string_lossy().into_owned());
    let (claude_installed, claude_current, claude_source, claude_resolution_error) =
        match claude_path {
            Ok(path) => {
                let source = claude_runtime_source(&path);
                match claude_runtime_version(&path, true)
                    .await
                    .and_then(|version| normalized_runtime_version(&version))
                {
                    Some(version) => (true, Some(version), Some(source), None),
                    None => (
                        true,
                        None,
                        Some(source),
                        Some(if claude_custom {
                            "MYTHRA_CODE_CLAUDE_PATH did not report a valid version. Update or remove it, then check again.".to_string()
                        } else {
                            "Claude Code is installed but did not report a valid version. You can check again or update it here.".to_string()
                        }),
                    ),
                }
            }
            Err(error) => (
                false,
                None,
                claude_custom.then(|| "Custom path".to_string()),
                claude_custom.then_some(error),
            ),
        };
    DeveloperRuntimeUpdateStatus {
        checked_at: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as i64,
        codex,
        claude: developer_runtime_target_status(
            claude_installed,
            claude_current,
            claude_latest,
            claude_source,
            claude_custom,
            claude_resolution_error,
            claude_display_path,
        ),
    }
}

#[tauri::command]
async fn developer_runtime_updates(
    app: AppHandle,
    state: State<'_, RuntimeState>,
) -> Result<DeveloperRuntimeUpdateStatus, String> {
    Ok(read_developer_runtime_updates(&app, &state).await)
}

#[tauri::command]
async fn developer_runtime_update(
    target: String,
    app: AppHandle,
    runtime_state: State<'_, RuntimeState>,
    claude_state: State<'_, ClaudeState>,
) -> Result<DeveloperRuntimeUpdateResult, String> {
    let _update_guard = runtime_state
        .runtime_update
        .try_lock()
        .map_err(|_| "A developer runtime update is already running.".to_string())?;
    // Codex only: the official launcher and the version it verified with.
    let mut codex_verified = None;
    let message = match target.as_str() {
        "claude" => {
            if !claude_state.turns.lock().await.is_empty() {
                return Err("Stop active Claude tasks before updating Claude Code.".into());
            }
            if claude_runtime_override().is_some() {
                return Err("Mythra Code will not overwrite a custom Claude Code path. Update that executable yourself or remove MYTHRA_CODE_CLAUDE_PATH.".into());
            }
            let outcome = match resolve_claude_binary(&app).await {
                Ok(path) => {
                    // Package-manager installs cannot update themselves
                    // reliably (`claude update` explicitly excludes Homebrew
                    // and WinGet). Install the official native distribution in
                    // that case; resolve_claude_binary prefers it on the next
                    // probe without mutating the package-manager installation.
                    let source = claude_runtime_source(&path);
                    if matches!(source.as_str(), "Homebrew" | "npm" | "WinGet") {
                        run_official_installer(
                            CLAUDE_INSTALLER_URL,
                            CLAUDE_INSTALLER_WINDOWS_URL,
                            false,
                        )
                        .await
                    } else {
                        let mut command = background_command(path);
                        command.arg("update");
                        run_runtime_update_command(command, None).await
                    }
                }
                Err(_) => {
                    run_official_installer(
                        CLAUDE_INSTALLER_URL,
                        CLAUDE_INSTALLER_WINDOWS_URL,
                        false,
                    )
                    .await
                }
            };
            // The official installer may now outrank the cached location,
            // even when it failed after writing part of the installation.
            CLAUDE_BINARY_CACHE.clear().await;
            outcome?
        }
        "codex" => {
            if codex_runtime_override().is_some() {
                return Err("Mythra Code will not overwrite a custom Codex path. Update that executable yourself or remove MYTHRA_CODE_CODEX_PATH.".into());
            }
            let outcome =
                run_official_installer(CODEX_INSTALLER_URL, CODEX_INSTALLER_WINDOWS_URL, true)
                    .await;
            // The installer may have changed disk even when it failed.
            *runtime_state.codex_runtime.lock().await = None;
            let message = outcome?;
            // Exit 0 is not proof. Verify the launcher this installer owns
            // (honouring CODEX_INSTALL_DIR), never a fallback found elsewhere.
            // An unchanged version is fine: the release may already be latest.
            let Some(launcher) = official_codex_selection(&app).map(|selection| selection.launcher) else {
                return Err("The Codex installer finished, but Mythra Code couldn't determine where it installs Codex. Check again.".into());
            };
            // A successful --version without a recognizable version does not
            // certify the update either.
            let Some(version) = probe_codex_runtime(&launcher)
                .await
                .and_then(|runtime| normalized_runtime_version(&runtime.version))
            else {
                return Err(format!(
                    "The Codex installer finished, but {} can't be started or didn't report a recognizable version. Try the update again. If it keeps failing, repair or remove that installation, or set MYTHRA_CODE_CODEX_PATH to a working Codex executable.",
                    launcher.display()
                ));
            };
            codex_verified = Some((launcher, version));
            message
        }
        _ => return Err("Unknown developer runtime update target".into()),
    };
    let status = read_developer_runtime_updates(&app, &runtime_state).await;
    // Unchanged is fine when it is already the latest release, and failed
    // metadata is not proof of a failed install. Fresh metadata that is still
    // newer than the verified launcher means the requested update didn't apply.
    if let (Some((launcher, version)), Some(latest)) =
        (&codex_verified, status.codex.latest_version.as_deref())
    {
        if runtime_update_available(Some(version.as_str()), Some(latest)) {
            return Err(format!(
                "The Codex installer finished, but {} still reports Codex {version} while the latest release is {latest}. Try the update again.",
                launcher.display()
            ));
        }
    }
    // Restart only when the running app-server differs from what is now
    // selectable, not after every successful installer run.
    let restart_required = target == "codex" && status.codex.restart_required;
    Ok(DeveloperRuntimeUpdateResult {
        status,
        message,
        restart_required,
    })
}

/// How long a discovered CLI location is reused. A turn start, a usage poll
/// and a status check otherwise each repeat PATH, `where.exe` and login-shell
/// probes. Short enough that a newly preferred install is picked up quickly;
/// a location that disappears is re-discovered at once. Misses are never
/// cached, so installing a missing CLI and refreshing works immediately.
const BINARY_CACHE_TTL: Duration = Duration::from_secs(60);

pub(crate) struct BinaryCache<T>(tokio::sync::Mutex<Option<(Instant, T)>>);

impl<T: Clone> BinaryCache<T> {
    pub(crate) const fn new() -> Self {
        Self(tokio::sync::Mutex::const_new(None))
    }

    /// Single-flight: concurrent callers wait for one discovery and reuse it.
    pub(crate) async fn get_or_resolve<Fut>(
        &self,
        still_valid: impl Fn(&T) -> bool,
        resolve: impl FnOnce() -> Fut,
    ) -> Result<T, String>
    where
        Fut: std::future::Future<Output = Result<T, String>>,
    {
        let mut cached = self.0.lock().await;
        if let Some((resolved_at, value)) = cached.as_ref() {
            if resolved_at.elapsed() < BINARY_CACHE_TTL && still_valid(value) {
                return Ok(value.clone());
            }
        }
        *cached = None;
        let value = resolve().await?;
        *cached = Some((Instant::now(), value.clone()));
        Ok(value)
    }

    pub(crate) async fn clear(&self) {
        *self.0.lock().await = None;
    }
}

static CLAUDE_BINARY_CACHE: BinaryCache<PathBuf> = BinaryCache::new();

async fn resolve_claude_binary(app: &AppHandle) -> Result<PathBuf, String> {
    CLAUDE_BINARY_CACHE
        .get_or_resolve(|path| path.is_file(), || discover_claude_binary(app))
        .await
}

async fn discover_claude_binary(app: &AppHandle) -> Result<PathBuf, String> {
    let executable_name = if cfg!(windows) {
        "claude.exe"
    } else {
        "claude"
    };
    if let Some(override_path) = claude_runtime_override() {
        let override_path = PathBuf::from(override_path);
        return override_path.is_file().then_some(override_path).ok_or_else(|| {
            "MYTHRA_CODE_CLAUDE_PATH does not point to a Claude Code executable. Update or remove it, then try again.".into()
        });
    }

    let mut candidates = Vec::new();
    // The native installer is Claude Code's recommended and auto-updating
    // location. Probe it before package-manager shims and GUI-style PATH.
    if let Ok(home) = crate::release_qa::home_dir(app) {
        for relative in [".local/bin/claude", ".local/bin/claude.exe"] {
            push_candidate(&mut candidates, home.join(relative));
        }
    }
    #[cfg(windows)]
    push_windows_npm_claude_candidates(&mut candidates);
    // These already outrank PATH. Validate them before the PATH search, whose
    // `where.exe` can stall for seconds even when the native install works.
    #[cfg(windows)]
    if let Some(candidate) = first_working_windows_claude(&candidates).await {
        return Ok(candidate);
    }
    #[cfg(windows)]
    let validated = candidates.len();
    if let Some(candidate) = find_on_path(executable_name).await {
        push_candidate(&mut candidates, candidate);
    }
    #[cfg(target_os = "macos")]
    {
        push_candidate(&mut candidates, PathBuf::from("/opt/homebrew/bin/claude"));
        push_candidate(&mut candidates, PathBuf::from("/usr/local/bin/claude"));
    }
    if let Ok(home) = crate::release_qa::home_dir(app) {
        for relative in [
            ".npm-global/bin/claude",
            ".bun/bin/claude",
            ".volta/bin/claude",
        ] {
            push_candidate(&mut candidates, home.join(relative));
        }
    }
    #[cfg(windows)]
    if let Some(candidate) = first_working_windows_claude(&candidates[validated..]).await {
        return Ok(candidate);
    }
    #[cfg(not(windows))]
    if let Some(candidate) = candidates.into_iter().find(|candidate| candidate.is_file()) {
        return Ok(candidate);
    }
    if let Some(candidate) = find_with_login_shell(executable_name).await {
        return Ok(candidate);
    }

    Err("Mythra Code could not find Claude Code. Install Claude Code, sign in with `claude auth login`, then try again. Advanced users can set MYTHRA_CODE_CLAUDE_PATH.".into())
}

#[cfg(windows)]
async fn first_working_windows_claude(candidates: &[PathBuf]) -> Option<PathBuf> {
    for candidate in candidates.iter().filter(|candidate| candidate.is_file()) {
        if claude_runtime_version(candidate, false).await.is_some() {
            return Some(candidate.clone());
        }
    }
    None
}

fn configure_claude_subscription(command: &mut Command, home: Option<&Path>) {
    command
        .env_remove("ANTHROPIC_API_KEY")
        .env_remove("ANTHROPIC_AUTH_TOKEN")
        .env_remove("ANTHROPIC_AWS_API_KEY")
        .env_remove("ANTHROPIC_AWS_BASE_URL")
        .env_remove("ANTHROPIC_AWS_WORKSPACE_ID")
        .env_remove("ANTHROPIC_BASE_URL")
        .env_remove("ANTHROPIC_CUSTOM_HEADERS")
        .env_remove("ANTHROPIC_DEFAULT_HAIKU_MODEL")
        .env_remove("ANTHROPIC_DEFAULT_OPUS_MODEL")
        .env_remove("ANTHROPIC_DEFAULT_SONNET_MODEL")
        .env_remove("ANTHROPIC_DEFAULT_FABLE_MODEL")
        .env_remove("CLAUDE_CODE_OAUTH_TOKEN")
        .env_remove("CLAUDE_CODE_OAUTH_REFRESH_TOKEN")
        .env_remove("CLAUDE_CODE_OAUTH_SCOPES")
        .env_remove("CLAUDE_CODE_OAUTH_CLIENT_ID")
        .env_remove("CLAUDE_CODE_CUSTOM_OAUTH_URL")
        .env_remove("AWS_BEARER_TOKEN_BEDROCK")
        .env_remove("AWS_ACCESS_KEY_ID")
        .env_remove("AWS_SECRET_ACCESS_KEY")
        .env_remove("AWS_SESSION_TOKEN")
        .env_remove("AWS_PROFILE")
        .env_remove("GOOGLE_APPLICATION_CREDENTIALS")
        .env_remove("CLAUDE_CODE_USE_BEDROCK")
        .env_remove("CLAUDE_CODE_USE_VERTEX")
        .env_remove("CLAUDE_CODE_USE_FOUNDRY")
        .env_remove("CLAUDE_CODE_USE_ANTHROPIC_AWS")
        .env_remove("CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD")
        .env_remove("CLAUDE_CODE_USE_MANTLE")
        .env_remove("CLAUDE_CODE_USE_GATEWAY")
        .env_remove("CLAUDE_CODE_GATEWAY_TOKEN")
        .env_remove("CLAUDE_CODE_HOST_GATEWAY_LINEAGE")
        .env_remove("CLAUDE_CODE_HOST_CREDS_FILE")
        .env_remove("CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST")
        .env_remove("CLAUDE_CODE_HOST_AUTH_ENV_VAR")
        .env_remove("CLAUDE_CODE_BG_AUTH_SNAPSHOT_PATH")
        .env_remove("CLAUDE_BG_AUTH_SNAPSHOT_PATH")
        .env_remove("CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR")
        .env_remove("CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR")
        .env_remove("CLAUDE_CODE_GATEWAY_TOKEN_FILE_DESCRIPTOR")
        .env_remove("CCR_OAUTH_TOKEN_FILE")
        .env_remove("ANTHROPIC_UNIX_SOCKET")
        .env_remove("ANTHROPIC_PROFILE")
        .env_remove("ANTHROPIC_CONFIG_DIR")
        .env_remove("ANTHROPIC_FEDERATION_RULE_ID")
        .env_remove("ANTHROPIC_ORGANIZATION_ID")
        .env_remove("ANTHROPIC_WORKSPACE_ID")
        .env_remove("ANTHROPIC_SERVICE_ACCOUNT_ID")
        .env_remove("ANTHROPIC_IDENTITY_TOKEN")
        .env_remove("ANTHROPIC_IDENTITY_TOKEN_FILE")
        .env_remove("ANTHROPIC_SCOPE")
        .env_remove("CLAUDE_CODE_FEDERATION_CACHE_DIR")
        .env_remove("ANTHROPIC_FOUNDRY_API_KEY")
        .env_remove("ANTHROPIC_FOUNDRY_AUTH_TOKEN")
        .env_remove("ANTHROPIC_FOUNDRY_BASE_URL")
        .env_remove("ANTHROPIC_GOOGLE_CLOUD_BASE_URL")
        .env_remove("ANTHROPIC_BEDROCK_MANTLE_BASE_URL")
        .env_remove("ANTHROPIC_BEDROCK_BASE_URL")
        .env_remove("ANTHROPIC_VERTEX_BASE_URL")
        .env_remove("ANTHROPIC_VERTEX_PROJECT_ID")
        .env_remove("VERTEX_REGION_CLAUDE_3_5_SONNET")
        .env("COLUMNS", "1000")
        .env("NO_COLOR", "1");
    // GUI-launched Windows apps frequently lack Git and npm in PATH. Claude
    // itself is started by absolute path, but its Bash/tool subprocesses are
    // not, so give the whole turn the same augmented environment as Codex and
    // Mythra Code's native Git helpers.
    if let Some(path) = git_runtime_path(env::var_os("PATH").as_deref(), home) {
        command.env("PATH", path);
    }
}

fn subscription_only_command(path: &Path, home: Option<&Path>) -> Command {
    let mut command = background_command(path);
    configure_claude_subscription(&mut command, home);
    command
}

/// A stream-json Claude Code command billed the way Models & accounts
/// selects, and the billing its process must confirm through
/// `confirm_claude_process_billing` before anything else is written. With
/// API-key billing the saved key is the only credential added back after the
/// overrides are stripped; Claude Code's documented precedence then uses it
/// instead of the subscription login. The user's environment and external
/// Claude Code login are never changed. Callers hold Claude admission, so the
/// selection cannot change before the process is confirmed.
async fn claude_billed_command(
    app: &AppHandle,
    path: &Path,
    home: Option<&Path>,
) -> Result<(Command, provider_auth::ClaudeBilling), String> {
    let api_key = provider_auth::claude_turn_api_key(app).await?;
    let mut command = subscription_only_command(path, home);
    let billing = match api_key {
        Some(key) => {
            command.env("ANTHROPIC_API_KEY", key);
            provider_auth::ClaudeBilling::ApiKey
        }
        None => provider_auth::ClaudeBilling::Subscription,
    };
    Ok((command, billing))
}

fn claude_prompt_snapshot_version_support(version: Option<&str>) -> Option<bool> {
    // Official `--version` output starts with the version, followed by
    // `(Claude Code)`. Do not infer capabilities from arbitrary banner text.
    let token = version?.split_whitespace().next()?;
    let version = semver::Version::parse(token.strip_prefix('v').unwrap_or(token)).ok()?;
    Some(version >= semver::Version::new(2, 1, 257))
}

fn claude_native_subagent_version_support(version: Option<&str>) -> Option<bool> {
    let token = version?.split_whitespace().next()?;
    let version = semver::Version::parse(token.strip_prefix('v').unwrap_or(token)).ok()?;
    // 2.1.267 refuses a custom child's bypassPermissions mode unless its
    // parent already has that authority. Snapshot support alone (2.1.257)
    // cannot establish this inherited permission boundary.
    Some(version >= semver::Version::new(2, 1, 267))
}

fn claude_haiku55_version_support(version: Option<&str>) -> Option<bool> {
    let token = version?.split_whitespace().next()?;
    let version = semver::Version::parse(token.strip_prefix('v').unwrap_or(token)).ok()?;
    Some(version >= semver::Version::new(2, 1, 293))
}

fn claude_model_compaction_version_support(version: Option<&str>) -> Option<bool> {
    let token = version?.split_whitespace().next()?;
    let version = semver::Version::parse(token.strip_prefix('v').unwrap_or(token)).ok()?;
    Some(version >= semver::Version::new(2, 1, 288))
}

fn claude_wrap_up_version_support(version: Option<&str>) -> Option<bool> {
    // Client compatibility is necessary, but it does not prove that Anthropic
    // will grant an allowance to this account or turn. Live telemetry owns that.
    let token = version?.split_whitespace().next()?;
    let version = semver::Version::parse(token.strip_prefix('v').unwrap_or(token)).ok()?;
    Some(version >= semver::Version::new(2, 1, 277))
}

fn claude_wrap_up_version_warning(version: Option<&str>) -> Option<&'static str> {
    match claude_wrap_up_version_support(version) {
        Some(true) => None,
        Some(false) => Some(
            "Included wrap-up support requires Claude Code 2.1.277 or newer. Update Claude Code in Updates; normal Claude conversations remain available.",
        ),
        None => Some(
            "Included wrap-up support could not be verified; it requires Claude Code 2.1.277 or newer. Recheck or update Claude Code in Updates.",
        ),
    }
}

fn claude_runtime_warnings(
    version: Option<&str>,
    credential_warning: Option<String>,
) -> Option<String> {
    let warnings = credential_warning
        .into_iter()
        .chain(claude_prompt_snapshot_version_warning(version).map(str::to_string))
        .chain(claude_wrap_up_version_warning(version).map(str::to_string))
        .collect::<Vec<_>>();
    (!warnings.is_empty()).then(|| warnings.join(" "))
}

async fn executable_identity(path: &Path) -> ExecutableIdentity {
    let metadata = tokio::fs::metadata(path).await.ok();
    #[cfg(unix)]
    let file_identity = {
        use std::os::unix::fs::MetadataExt;
        metadata
            .as_ref()
            .map(|metadata| (metadata.dev(), metadata.ino()))
    };
    #[cfg(windows)]
    let file_identity = {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Storage::FileSystem::{
            GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION,
        };
        match tokio::fs::File::open(path).await {
            Ok(file) => {
                let mut information: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
                // SAFETY: the file remains open through the read-only query,
                // and information is a correctly sized initialized output.
                (unsafe {
                    GetFileInformationByHandle(file.as_raw_handle().cast(), &mut information)
                } != 0)
                    .then_some((
                        u64::from(information.dwVolumeSerialNumber),
                        (u64::from(information.nFileIndexHigh) << 32)
                            | u64::from(information.nFileIndexLow),
                    ))
            }
            Err(_) => None,
        }
    };
    #[cfg(not(any(unix, windows)))]
    let file_identity = None;
    ExecutableIdentity {
        path: path.to_path_buf(),
        target: tokio::fs::canonicalize(path).await.ok(),
        metadata: metadata.map(|metadata| (metadata.len(), metadata.modified().ok())),
        file_identity,
    }
}

async fn cached_claude_prompt_snapshot_support<F, Fut>(
    cache: &Mutex<Option<ClaudePromptSnapshotSupport>>,
    path: &Path,
    probe: F,
) -> bool
where
    F: FnOnce() -> Fut,
    Fut: Future<Output = Option<String>>,
{
    let identity = executable_identity(path).await;
    let mut cached = cache.lock().await;
    if let Some(runtime) = cached
        .as_ref()
        .filter(|runtime| runtime.reusable(&identity, Instant::now()))
    {
        return runtime.supported.unwrap_or(false);
    }
    let version = probe().await;
    let supported = claude_prompt_snapshot_version_support(version.as_deref());
    let native_supported = claude_native_subagent_version_support(version.as_deref());
    let haiku55_supported = claude_haiku55_version_support(version.as_deref());
    let model_compaction_supported = claude_model_compaction_version_support(version.as_deref());
    // An updater can replace the CLI during a probe. Never attribute the old
    // version to the new executable (or send a new flag to a replaced old CLI).
    if executable_identity(path).await != identity {
        *cached = None;
        return false;
    }
    *cached = Some(ClaudePromptSnapshotSupport {
        identity,
        supported,
        native_supported,
        haiku55_supported,
        model_compaction_supported,
        checked_at: Instant::now(),
    });
    supported.unwrap_or(false)
}

async fn claude_prompt_snapshot_supported(state: &ClaudeState, path: &Path) -> bool {
    cached_claude_prompt_snapshot_support(&state.prompt_snapshot_support, path, || {
        claude_runtime_version(path, false)
    })
    .await
}

async fn cached_claude_native_subagent_support(
    cache: &Mutex<Option<ClaudePromptSnapshotSupport>>,
    path: &Path,
) -> bool {
    // The snapshot probe fills both capabilities from the same executable.
    // Recheck identity so an updater cannot transfer permission guarantees
    // from the probed CLI to a replacement binary.
    let identity = executable_identity(path).await;
    cache
        .lock()
        .await
        .as_ref()
        .filter(|runtime| runtime.reusable(&identity, Instant::now()))
        .and_then(|runtime| runtime.native_supported)
        .unwrap_or(false)
}

async fn cached_claude_haiku55_support(
    cache: &Mutex<Option<ClaudePromptSnapshotSupport>>,
    path: &Path,
) -> bool {
    let identity = executable_identity(path).await;
    cache.lock().await.as_ref()
        .filter(|runtime| runtime.reusable(&identity, Instant::now()))
        .and_then(|runtime| runtime.haiku55_supported)
        .unwrap_or(false)
}

async fn cached_claude_model_compaction_support(
    cache: &Mutex<Option<ClaudePromptSnapshotSupport>>,
    path: &Path,
) -> bool {
    let identity = executable_identity(path).await;
    cache.lock().await.as_ref()
        .filter(|runtime| runtime.reusable(&identity, Instant::now()))
        .and_then(|runtime| runtime.model_compaction_supported)
        .unwrap_or(false)
}

fn claude_system_prompt_arguments(system_prompt: &str, snapshot_supported: bool) -> Vec<String> {
    let mut arguments = Vec::new();
    if snapshot_supported {
        // Recent Claude Code restores the first recorded prompt on --resume,
        // ignoring even changed/removed append text until compaction. Re-render
        // authored instructions on first turns and resumes, including clears.
        arguments.extend(["--system-prompt-snapshot".into(), "off".into()]);
    }
    if !system_prompt.trim().is_empty() {
        arguments.extend(["--append-system-prompt".into(), system_prompt.into()]);
    }
    arguments
}

fn claude_prompt_snapshot_version_warning(version: Option<&str>) -> Option<&'static str> {
    claude_prompt_snapshot_version_support(version).is_none().then_some(
        "Mythra Code could not verify this Claude Code version. Updated system instructions in resumed conversations may not apply; recheck or update the Claude Code runtime.",
    )
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

/// How long a `claude auth status` probe may take before Mythra Code reports
/// the account as unverified instead of leaving the connection check hanging.
/// A healthy probe answers in well under a second; a stuck keychain prompt or
/// a wedged CLI would otherwise pin "Checking connection…" forever.
const CLAUDE_AUTH_STATUS_TIMEOUT: Duration = Duration::from_secs(15);

fn invalidate_claude_auth(app: &AppHandle) {
    let Some(state) = app.try_state::<ClaudeState>() else { return; };
    let mut generation = state.auth_check_generation.lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    *generation = generation.wrapping_add(1);
    state.authenticated.store(false, Ordering::Release);
}

pub(crate) fn claude_auth_generation(app: &AppHandle) -> u64 {
    let Some(state) = app.try_state::<ClaudeState>() else { return 0; };
    let generation = *state.auth_check_generation.lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    generation
}

fn publish_claude_auth_check(app: &AppHandle, checked_generation: u64, authenticated: bool) -> bool {
    let Some(state) = app.try_state::<ClaudeState>() else { return true; };
    let generation = state.auth_check_generation.lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if *generation != checked_generation {
        return false;
    }
    state.authenticated.store(authenticated, Ordering::Release);
    true
}

/// A turn authorizes once, then may wait on setup before spawning. Refuse to
/// dispatch if a sign-in began meanwhile or a check found the account signed
/// out or unverifiable. Ordinary checks that still find it signed in pass.
fn claude_auth_admits(state: &ClaudeState, authorized_generation: u64) -> Result<(), String> {
    let generation = state.auth_check_generation.lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if *generation != authorized_generation || !state.authenticated.load(Ordering::Acquire) {
        return Err("Claude Code's sign-in changed before this message was sent. Check the connection, then send it again.".into());
    }
    Ok(())
}

async fn probe_claude_auth(path: &Path, home: Option<&Path>) -> Result<Value, String> {
    let output = timeout(
        CLAUDE_AUTH_STATUS_TIMEOUT,
        subscription_only_command(path, home)
            .args(["--setting-sources", "", "auth", "status"])
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .output(),
    )
    .await
    .map_err(|_| "Claude Code took too long to verify your account. Try checking the connection again.".to_string())?
    .map_err(|_| "Claude Code could not start its account check. Try checking the connection again.".to_string())?;
    let auth = parse_claude_auth_status(&output.stdout)
        .filter(|value| value.get("loggedIn").and_then(Value::as_bool).is_some())
        .ok_or_else(|| "Claude Code returned an unrecognized account status. Try checking the connection again.".to_string())?;
    // Official auth status exits 1 when signed out. Other failures, including
    // a nonzero result claiming to be signed in, do not verify account state.
    let signed_out = output.status.code() == Some(1)
        && auth.get("loggedIn").and_then(Value::as_bool) == Some(false)
        && auth.get("authMethod").and_then(Value::as_str) == Some("none");
    if !output.status.success() && !signed_out {
        return Err("Claude Code could not verify your account. Try checking the connection again.".into());
    }
    // Claude Code before 2.1.300 reports a Console login as authMethod
    // "claude.ai" with an apiKeySource ("/login managed key"); only a
    // subscription sign-in has none.
    let api_key_source = auth.get("apiKeySource").and_then(Value::as_str).filter(|source| *source != "none");
    if auth.get("loggedIn").and_then(Value::as_bool) == Some(true)
        && (auth.get("authMethod").and_then(Value::as_str) != Some("claude.ai")
            || auth.get("apiProvider").and_then(Value::as_str) != Some("firstParty")
            || api_key_source.is_some())
    {
        // A Console key, profile or hosted-provider login is not the selected
        // subscription. Leave external credentials untouched and fail closed.
        return Err("Claude is set to subscription billing, but Claude Code selected a different credential or provider. Sign in with your Claude subscription in Models & accounts, or explicitly choose API key billing.".into());
    }
    Ok(auth)
}

fn parse_claude_auth_status(stdout: &[u8]) -> Option<Value> {
    serde_json::from_slice(stdout).ok().or_else(|| {
        // Claude Code can print a notice (update banner, deprecation warning)
        // ahead of the status object, and a narrow terminal may wrap long
        // values. Keep only the outermost object and rejoin wrapped lines.
        let text = String::from_utf8_lossy(stdout);
        let start = text.find('{')?;
        let end = text.rfind('}')?;
        let body = text.get(start..=end)?;
        serde_json::from_str(body).ok().or_else(|| {
            let compact = body.lines().map(str::trim).collect::<String>();
            serde_json::from_str(&compact).ok()
        })
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

fn claude_usage_failure_code(stderr: &[u8]) -> &'static str {
    let stderr = String::from_utf8_lossy(stderr).to_lowercase();
    if [
        "unauthorized",
        "not logged in",
        "sign in",
        "login",
        "oauth",
        "401",
    ]
    .iter()
    .any(|needle| stderr.contains(needle))
    {
        "CLAUDE_USAGE_AUTH_REQUIRED"
    } else {
        "CLAUDE_USAGE_UNAVAILABLE"
    }
}

/// Best-effort warming for the first-party quota endpoint on Windows.
#[cfg(windows)]
const CLAUDE_API_HOST: &str = "api.anthropic.com";
#[cfg(windows)]
const CLAUDE_USAGE_RESOLVE_TIMEOUT: Duration = Duration::from_secs(15);
/// This deadline covers the CLI alone, after any Windows DNS warmup wait.
const CLAUDE_USAGE_TIMEOUT: Duration = Duration::from_secs(10);
const CLAUDE_USAGE_STDOUT_BYTES: usize = 256 * 1024;
const CLAUDE_USAGE_STDERR_BYTES: usize = 16 * 1024;

/// Windows measurements found uncached DNS taking about 11 seconds while
/// cached lookups were fast. Warming may help the CLI avoid its own request
/// timeout; this is not proof of every usage failure's cause or freshness.
/// Proxy variables conservatively skip warming; bypass rules and the CLI's
/// transport can differ, so warming never determines whether the CLI may run.
#[cfg(windows)]
async fn warm_claude_api_host() {
    if ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"]
        .iter()
        .any(|key| env::var_os(key).is_some_and(|value| !value.is_empty()))
    {
        return;
    }
    static LOOKUP: std::sync::OnceLock<Arc<tokio::sync::Semaphore>> = std::sync::OnceLock::new();
    let gate = LOOKUP.get_or_init(|| Arc::new(tokio::sync::Semaphore::new(1)));
    let Ok(permit) = gate.clone().try_acquire_owned() else { return; };
    let lookup = tokio::task::spawn_blocking(move || {
        // A timed-out OS lookup cannot be cancelled. Keep its permit inside
        // the blocking job so later reads cannot accumulate more DNS jobs.
        let _permit = permit;
        std::net::ToSocketAddrs::to_socket_addrs(&(CLAUDE_API_HOST, 443))
            .map(|mut addresses| addresses.next())
    });
    let _ = timeout(CLAUDE_USAGE_RESOLVE_TIMEOUT, lookup).await;
}

/// Keeps at most `limit` bytes and drains the rest, so a noisy child cannot
/// grow memory or stall on a full pipe before its deadline.
async fn read_capped<R: AsyncRead + Unpin>(reader: Option<R>, limit: usize) -> std::io::Result<(Vec<u8>, bool)> {
    let mut bytes = Vec::new();
    let mut exceeded = false;
    let Some(mut reader) = reader else {
        return Err(std::io::Error::new(std::io::ErrorKind::BrokenPipe, "Missing usage pipe"));
    };
    let mut buffer = [0u8; 8192];
    loop {
        let read = reader.read(&mut buffer).await?;
        if read == 0 {
            break;
        }
        let retained = limit.saturating_sub(bytes.len()).min(read);
        bytes.extend_from_slice(&buffer[..retained]);
        exceeded |= retained < read;
    }
    Ok((bytes, exceeded))
}

#[tauri::command]
async fn claude_usage(app: AppHandle, account_key: String, runtime_path: Option<String>) -> Result<ClaudeUsageLimits, String> {
    if account_key.is_empty() || account_key.len() > 1024 || runtime_path.as_ref().is_some_and(|path| path.len() > 32768) {
        return Err("CLAUDE_USAGE_SCOPE_CHANGED".into());
    }
    let Some(state) = app.try_state::<ClaudeState>() else {
        return Err("CLAUDE_USAGE_SCOPE_CHANGED".into());
    };
    // Capture request ownership before waiting. A queued old-account caller
    // must not adopt a later login merely because it acquired the lock later.
    let (scope, scope_epoch, arrived) = {
        let generation = state.auth_check_generation.lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let scope = ClaudeUsageScope { auth_generation: *generation, account_key, runtime_path };
        let mut probes = state.usage_probes.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        if probes.scope.as_ref() != Some(&scope) {
            probes.scope_epoch = probes.scope_epoch.wrapping_add(1);
            probes.scope = Some(scope.clone());
            probes.last = None;
        }
        (scope, probes.scope_epoch, probes.completed)
    };
    let _serial = state.usage_lock.lock().await;
    {
        let generation = state.auth_check_generation.lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let probes = state.usage_probes.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        if *generation != scope.auth_generation || probes.scope_epoch != scope_epoch {
            return Err("CLAUDE_USAGE_SCOPE_CHANGED".into());
        }
        if probes.completed != arrived {
            if let Some((_, usage)) = probes.last.as_ref().filter(|(checked, _)| *checked == scope_epoch) {
                return usage.clone();
            }
        }
    }
    let usage = probe_claude_usage(&app).await;
    let generation = state.auth_check_generation.lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let mut probes = state.usage_probes.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    if *generation != scope.auth_generation || probes.scope_epoch != scope_epoch {
        return Err("CLAUDE_USAGE_SCOPE_CHANGED".into());
    }
    probes.completed = probes.completed.wrapping_add(1);
    probes.last = Some((scope_epoch, usage.clone()));
    usage
}

async fn probe_claude_usage(app: &AppHandle) -> Result<ClaudeUsageLimits, String> {
    let _billing_admission = provider_auth::begin_use(app, provider_auth::ApiKeyProvider::Anthropic)?;
    // Subscription quota only: an API key has no plan windows to read.
    if !matches!(provider_auth::claude_billing(app), Ok(provider_auth::ClaudeBilling::Subscription)) {
        return Err("CLAUDE_USAGE_API_BILLING".into());
    }
    // `/usage` is a local command in print mode and sends no model request,
    // so this read is not billed; the preflight keeps a Console or other
    // login from being reported as subscription quota.
    provider_auth::claude_subscription_login_verified(app).await?;
    let path = resolve_claude_binary(app).await?;
    let home = crate::release_qa::home_dir(app).ok();
    #[cfg(windows)]
    warm_claude_api_host().await;
    let mut child = subscription_only_command(&path, home.as_deref())
        // A quota read needs no tools. claude.ai connectors and local MCP
        // servers would add host lookups, a retried connector fetch, and
        // helper processes to every read.
        .env("ENABLE_CLAUDEAI_MCP_SERVERS", "false")
        .args([
            "--setting-sources",
            "",
            "--strict-mcp-config",
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
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|_| "CLAUDE_USAGE_START_FAILED".to_string())?;
    let (stdout, stderr) = (child.stdout.take(), child.stderr.take());
    let outcome = timeout(CLAUDE_USAGE_TIMEOUT, async {
        tokio::join!(
            read_capped(stdout, CLAUDE_USAGE_STDOUT_BYTES),
            read_capped(stderr, CLAUDE_USAGE_STDERR_BYTES),
            child.wait(),
        )
    })
    .await;
    let Ok((stdout, stderr, status)) = outcome else {
        // Attempt termination and a bounded reap before the handle drops.
        let _ = child.start_kill();
        let _ = timeout(Duration::from_secs(2), child.wait()).await;
        return Err("CLAUDE_USAGE_TIMEOUT".into());
    };
    let (stdout, stdout_exceeded) = stdout.map_err(|_| "CLAUDE_USAGE_READ_FAILED".to_string())?;
    let (stderr, _) = stderr.map_err(|_| "CLAUDE_USAGE_READ_FAILED".to_string())?;
    let status = status.map_err(|_| "CLAUDE_USAGE_START_FAILED".to_string())?;
    if !status.success() {
        // Keep provider output out of renderer errors and audit logs, but
        // preserve the one distinction that changes the user's next action.
        return Err(claude_usage_failure_code(&stderr).into());
    }
    if stdout_exceeded {
        return Err("CLAUDE_USAGE_UNSUPPORTED".into());
    }
    let envelope = parse_claude_auth_status(&stdout)
        .ok_or_else(|| "CLAUDE_USAGE_UNSUPPORTED".to_string())?;
    let result = envelope
        .get("result")
        .and_then(Value::as_str)
        .ok_or_else(|| "CLAUDE_USAGE_EMPTY".to_string())?;
    let usage = parse_claude_usage_result(result);
    if usage.windows.is_empty() {
        return Err("CLAUDE_USAGE_PARSE_FAILED".into());
    }
    Ok(usage)
}

/// Reads the live Claude Code model catalog.
///
/// The CLI has no `models` subcommand, but the stream-json control protocol it
/// already speaks answers a `list_models` request with the same catalog its own
/// picker shows — resolved against the signed-in subscription, the settings
/// cascade, and any enforcement policy. A CLI too old to know the subtype
/// answers with an error, which the frontend turns into a labelled fallback.
#[tauri::command]
async fn claude_models(app: AppHandle) -> Result<Value, String> {
    let billing_admission = provider_auth::begin_use(&app, provider_auth::ApiKeyProvider::Anthropic)?;
    let binary = resolve_claude_binary(&app).await?;
    let cwd = crate::release_qa::home_dir(&app)
        .ok()
        .filter(|path| path.is_dir())
        .unwrap_or_else(env::temp_dir);
    let (mut command, billing) = claude_billed_command(&app, &binary, Some(&cwd)).await?;
    let mut child = command
        .current_dir(cwd)
        .env("CLAUDE_CODE_ENTRYPOINT", "sdk-ts")
        .env("ENABLE_CLAUDEAI_MCP_SERVERS", "false")
        .args([
            "--setting-sources",
            "",
            "--strict-mcp-config",
            "--mcp-config",
            r#"{"mcpServers":{}}"#,
            "-p",
            "--output-format",
            "stream-json",
            "--input-format",
            "stream-json",
            "--verbose",
            "--no-session-persistence",
            "--model",
            // `default` is the account's recommended model and is the safest
            // bootstrap choice when an organization has disabled Haiku. The
            // control request itself does not start a billed model turn.
            "default",
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|error| format!("Could not start Claude Code: {error}"))?;

    let request = json!({
        "type": "control_request",
        "request_id": "mythra-list-models",
        "request": { "subtype": "list_models" },
    });
    let outcome = timeout(Duration::from_secs(20), async {
        // Keep every post-spawn failure inside this outcome so cleanup and
        // admission cover missing pipes as well as protocol failures.
        let mut stdin = child.stdin.take()
            .ok_or_else(|| "Claude Code did not accept a model catalog request".to_string())?;
        let stdout = child.stdout.take()
            .ok_or_else(|| "Claude Code did not return a model catalog".to_string())?;
        let mut stdout = BufReader::new(stdout);
        // The catalog depends on the account, so it is read only from a
        // process confirmed to use the selected billing.
        confirm_claude_process_billing(&mut stdin, &mut stdout, billing).await
            .map_err(|refusal| refusal.message(""))?;
        stdin
            .write_all(format!("{request}\n").as_bytes())
            .await
            .map_err(|error| format!("Could not ask Claude Code for its models: {error}"))?;
        stdin
            .flush()
            .await
            .map_err(|error| format!("Could not ask Claude Code for its models: {error}"))?;
        let mut lines = stdout.lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let Ok(message) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            if message.get("type").and_then(Value::as_str) != Some("control_response") {
                continue;
            }
            let response = message.get("response").unwrap_or(&Value::Null);
            if response.get("request_id").and_then(Value::as_str) != Some("mythra-list-models") {
                continue;
            }
            if response.get("subtype").and_then(Value::as_str) == Some("error") {
                return Err(response
                    .get("error")
                    .and_then(Value::as_str)
                    .unwrap_or("Claude Code could not list its models")
                    .to_string());
            }
            return response
                .get("response")
                .cloned()
                .ok_or_else(|| "Claude Code returned an empty model catalog".to_string());
        }
        Err("Claude Code closed before returning its models".to_string())
    })
    .await;
    let _ = child.start_kill();
    if !matches!(timeout(Duration::from_secs(2), child.wait()).await, Ok(Ok(_))) {
        // A timed-out IPC must not release admission while its process may
        // still hold the old key. Keep ownership until exit is confirmed.
        tauri::async_runtime::spawn(async move {
            let _admission = billing_admission;
            loop {
                let _ = child.start_kill();
                if child.wait().await.is_ok() { break; }
                tokio::time::sleep(Duration::from_secs(1)).await;
            }
        });
        return Err("Claude's model catalog process has not confirmed exit. Billing and key changes remain blocked until it stops.".into());
    }
    outcome.map_err(|_| "Claude Code took too long to list its models".to_string())?
}

async fn read_claude_runtime_status(app: &AppHandle) -> ClaudeRuntimeStatus {
    let Some(state) = app.try_state::<ClaudeState>() else {
        return probe_claude_runtime_status(app, 0).await;
    };
    let arrived = state.auth_probes.lock().unwrap_or_else(std::sync::PoisonError::into_inner).completed;
    let _serial = state.auth_check_lock.lock().await;
    {
        // Validate against the live generation while holding its lock, as
        // fresh publication does, so a sign-in cannot land in between.
        let generation = state.auth_check_generation.lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let probes = state.auth_probes.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        if probes.completed != arrived {
            if let Some((_, status)) = probes.last.as_ref().filter(|(checked, _)| *checked == *generation) {
                return status.clone();
            }
        }
    }
    // Captured under the probe lock, through publication; sign-in
    // invalidates without waiting for it.
    let auth_generation = claude_auth_generation(app);
    let status = probe_claude_runtime_status(app, auth_generation).await;
    let mut probes = state.auth_probes.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    probes.completed = probes.completed.wrapping_add(1);
    probes.last = Some((auth_generation, status.clone()));
    status
}

async fn probe_claude_runtime_status(app: &AppHandle, auth_generation: u64) -> ClaudeRuntimeStatus {
    let billing = provider_auth::claude_billing(app);
    let warning = claude_credential_override_present().then(|| match billing {
        Ok(provider_auth::ClaudeBilling::ApiKey) => "Mythra Code ignores Anthropic credential, proxy, and hosted-provider environment overrides for Claude, so this provider uses only the Anthropic API key saved in Models & accounts.",
        _ => "Mythra Code ignores Anthropic credential, proxy, and hosted-provider environment overrides for Claude subscription sessions, so this provider uses only your Claude Code login.",
    }.to_string());
    let path = match resolve_claude_binary(app).await {
        Ok(path) => path,
        Err(error) => {
            // A check that cannot run cannot keep authorizing turns.
            publish_claude_auth_check(app, auth_generation, false);
            return ClaudeRuntimeStatus {
                available: false,
                path: None,
                version: None,
                logged_in: false,
                auth_verified: false,
                auth_method: None,
                email: None,
                subscription_type: None,
                billing: billing.ok(),
                warning: Some(error),
            };
        }
    };

    let billing = match billing {
        Ok(billing) => billing,
        Err(error) => {
            // An unreadable choice is unverified, not signed out, and
            // authorizes no turns until it is chosen again.
            publish_claude_auth_check(app, auth_generation, false);
            return ClaudeRuntimeStatus {
                available: true,
                version: claude_runtime_version(&path, false).await,
                path: Some(path.to_string_lossy().into_owned()),
                logged_in: false,
                auth_verified: false,
                auth_method: None,
                email: None,
                subscription_type: None,
                billing: None,
                warning: Some(error),
            };
        }
    };
    if billing == provider_auth::ClaudeBilling::ApiKey {
        // API-key billing never consults the subscription login. `auth
        // status` is skipped: a saved key is the whole local credential.
        let (version, key) = tokio::join!(
            claude_runtime_version(&path, false),
            provider_auth::anthropic_key_state(),
        );
        let key_warning = match key {
            transcription::KeyState::Saved => None,
            transcription::KeyState::Missing => Some("Add an Anthropic API key, or switch Claude back to your subscription.".to_string()),
            transcription::KeyState::Unavailable => Some("The OS credential store didn't return the Anthropic API key. Check for a system prompt, then refresh.".to_string()),
        };
        let warning = claude_runtime_warnings(version.as_deref(), warning);
        let warning = match (warning, key_warning) {
            (Some(warning), Some(key)) => Some(format!("{warning} {key}")),
            (warning, key) => warning.or(key),
        };
        let mut status = ClaudeRuntimeStatus {
            available: true,
            path: Some(path.to_string_lossy().into_owned()),
            version,
            logged_in: key == transcription::KeyState::Saved,
            auth_verified: key != transcription::KeyState::Unavailable,
            auth_method: None,
            email: None,
            subscription_type: None,
            billing: Some(billing),
            warning,
        };
        if !publish_claude_auth_check(app, auth_generation, status.auth_verified && status.logged_in) {
            status.auth_verified = false;
            status.logged_in = false;
            let message = "Claude's billing or API key changed during this check. Check the connection again.";
            status.warning = Some(match status.warning {
                Some(warning) => format!("{warning} {message}"),
                None => message.into(),
            });
        }
        return status;
    }

    let home = crate::release_qa::home_dir(app).ok();
    let (version, auth) = tokio::join!(
        claude_runtime_version(&path, false),
        probe_claude_auth(&path, home.as_deref()),
    );
    let warning = claude_runtime_warnings(version.as_deref(), warning);
    let warning = match auth.as_ref().err() {
        Some(error) => Some(match warning {
            Some(warning) => format!("{warning} {error}"),
            None => error.clone(),
        }),
        None => warning,
    };
    let auth_verified = auth.is_ok();
    let auth = auth.ok();
    let mut status = ClaudeRuntimeStatus {
        available: true,
        path: Some(path.to_string_lossy().into_owned()),
        version,
        auth_verified,
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
        billing: Some(billing),
        warning,
    };
    if !publish_claude_auth_check(app, auth_generation, status.auth_verified && status.logged_in) {
        status.auth_verified = false;
        status.logged_in = false;
        status.auth_method = None;
        status.email = None;
        status.subscription_type = None;
        let message = "A Claude Code sign-in started during this check. Check the connection again.";
        status.warning = Some(match status.warning {
            Some(warning) => format!("{warning} {message}"),
            None => message.into(),
        });
    }
    status
}

#[tauri::command]
async fn claude_runtime_status(
    app: AppHandle,
) -> Result<ClaudeRuntimeStatus, String> {
    Ok(read_claude_runtime_status(&app).await)
}

/// Cancels the browser sign-in `claude_login` is waiting for, so an abandoned
/// browser does not hold Claude work and billing changes until the timeout.
static CLAUDE_LOGIN_CANCEL: std::sync::Mutex<Option<oneshot::Sender<()>>> = std::sync::Mutex::new(None);

#[tauri::command]
fn claude_login_cancel() -> bool {
    CLAUDE_LOGIN_CANCEL.lock().unwrap_or_else(std::sync::PoisonError::into_inner).take()
        .is_some_and(|cancel| cancel.send(()).is_ok())
}

#[tauri::command]
async fn claude_login(app: AppHandle) -> Result<(), String> {
    crate::release_qa::require_providers()?;
    let change = provider_auth::begin_change(&app, provider_auth::ApiKeyProvider::Anthropic).await?;
    provider_auth::claude_idle(&app.state::<ClaudeState>()).await?;
    if provider_auth::claude_billing(&app)? != provider_auth::ClaudeBilling::Subscription {
        return Err("Choose Subscription for Claude in Models & accounts before signing in. Mythra Code never changes billing automatically.".into());
    }
    // Own the actual login child, rather than launching an untracked Terminal
    // command. Admission stays exclusive until the browser flow has settled.
    invalidate_claude_auth(&app);
    let result = async {
        let path = resolve_claude_binary(&app).await?;
        let home = crate::release_qa::home_dir(&app).ok();
        #[cfg(windows)]
        let mut command = interactive_command(&path);
        #[cfg(not(windows))]
        let mut command = background_command(&path);
        configure_claude_subscription(&mut command, home.as_deref());
        command.args(["--setting-sources", "", "auth", "login", "--claudeai"])
            .kill_on_drop(true);
        #[cfg(windows)]
        command.stdin(Stdio::inherit()).stdout(Stdio::inherit()).stderr(Stdio::inherit());
        #[cfg(not(windows))]
        command.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
        let mut child = command.spawn()
            .map_err(|_| "Could not start Claude subscription sign-in. Run `claude auth login --claudeai` in a terminal, then refresh the connection.".to_string())?;
        let (cancel, cancelled) = oneshot::channel::<()>();
        *CLAUDE_LOGIN_CANCEL.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = Some(cancel);
        let mut was_cancelled = false;
        let outcome = tokio::select! {
            waited = timeout(Duration::from_secs(300), child.wait()) => waited.ok().and_then(Result::ok),
            _ = cancelled => { was_cancelled = true; None }
        };
        CLAUDE_LOGIN_CANCEL.lock().unwrap_or_else(std::sync::PoisonError::into_inner).take();
        let success = outcome.is_some_and(|status| status.success());
        if outcome.is_none() {
            let _ = child.start_kill();
            if !matches!(timeout(Duration::from_secs(2), child.wait()).await, Ok(Ok(_))) {
                let pending_app = app.clone();
                tauri::async_runtime::spawn(async move {
                    let _change = change;
                    loop {
                        let _ = child.start_kill();
                        if child.wait().await.is_ok() { break; }
                        tokio::time::sleep(Duration::from_secs(1)).await;
                    }
                    invalidate_claude_auth(&pending_app);
                });
                return Err("Claude sign-in has not confirmed exit. New Claude work and billing changes remain blocked until it stops.".to_string());
            }
        }
        // Keep the exclusive admission alive through credential verification.
        let _change = change;
        if was_cancelled {
            return Err("Claude sign-in was cancelled.".into());
        }
        if !success {
            return Err("Claude subscription sign-in did not finish. Try again; if the browser did not open, run `claude auth login --claudeai` in a terminal, then refresh the connection.".into());
        }
        let auth = probe_claude_auth(&path, home.as_deref()).await?;
        if auth.get("loggedIn").and_then(Value::as_bool) != Some(true) {
            return Err("Claude subscription sign-in was not confirmed. Check the connection and try again.".into());
        }
        Ok(())
    }.await;
    // A status probe taken during login cannot authorize the completed flow.
    invalidate_claude_auth(&app);
    result
}

/// Persists an image pasted into the composer (which arrives as raw bytes,
/// not a file path) so it can be attached to a turn like any local image.
/// These paths may be retained by another thread's draft, queue, or transcript,
/// so cleanup requires a future reference-aware collector rather than age or
/// directory-size eviction.
#[tauri::command]
async fn save_pasted_image(
    app: AppHandle,
    data_base64: String,
    extension: String,
    display_name: Option<String>,
) -> Result<String, String> {
    use base64::Engine as _;
    let safe_extension = normalized_pasted_image_extension(&extension)?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data_base64.as_bytes())
        .map_err(|error| format!("Could not decode the pasted image: {error}"))?;
    if bytes.is_empty() {
        return Err("The pasted image was empty".to_string());
    }
    if bytes.len() > 50 * 1024 * 1024 {
        return Err("The pasted image exceeds 50 MB".to_string());
    }
    let directory = crate::release_qa::app_data_dir(&app)
        .map_err(|error| format!("Could not resolve Mythra Code app data: {error}"))?
        .join("message-images");
    tokio::fs::create_dir_all(&directory)
        .await
        .map_err(|error| format!("Could not create the message-images folder: {error}"))?;
    let token = random_hex_token()?;
    let file = durable_image_destination(
        &directory,
        display_name.as_deref().or(Some("Pasted image")),
        &safe_extension,
        unix_timestamp_ms(),
        &token,
    );
    if let Some(parent) = file.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|error| format!("Could not create the message-image folder: {error}"))?;
    }
    tokio::fs::write(&file, &bytes)
        .await
        .map_err(|error| format!("Could not save the pasted image: {error}"))?;
    app.asset_protocol_scope()
        .allow_file(&file)
        .map_err(|error| format!("Could not prepare the pasted image preview: {error}"))?;
    Ok(file.to_string_lossy().into_owned())
}

fn normalized_pasted_image_extension(extension: &str) -> Result<String, String> {
    let normalized = extension.trim().to_ascii_lowercase();
    let synthetic_path = PathBuf::from(format!("pasted.{normalized}"));
    image_attachment_media_type(&synthetic_path)?;
    Ok(normalized)
}

fn unsupported_image_format_error(path: &Path) -> String {
    let extension = path
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if matches!(extension.as_str(), "heic" | "heif") {
        "HEIC/HEIF images are not supported. Convert this image to PNG, JPEG, GIF, or WebP before attaching it."
            .into()
    } else {
        "The attachment is not a supported image. Use PNG, JPEG, GIF, or WebP.".into()
    }
}

fn image_attachment_media_type(path: &Path) -> Result<&'static str, String> {
    match path
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
        .as_str()
    {
        "png" => Ok("image/png"),
        "jpg" | "jpeg" => Ok("image/jpeg"),
        "gif" => Ok("image/gif"),
        "webp" => Ok("image/webp"),
        _ => Err(unsupported_image_format_error(path)),
    }
}

/// The largest image attachment Mythra Code will read into memory — the same
/// cap `save_pasted_image` enforces.
const MAX_IMAGE_ATTACHMENT_BYTES: u64 = 50 * 1024 * 1024;

async fn validate_image_attachment(path: &Path) -> Result<(), String> {
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
    Ok(())
}

/// Reads an image attachment after checking that it is a regular file within
/// the size cap, via tokio::fs so the async runtime is never blocked on disk.
async fn read_image_attachment(path: &Path) -> Result<Vec<u8>, String> {
    validate_image_attachment(path).await?;
    tokio::fs::read(path)
        .await
        .map_err(|error| format!("Could not read {}: {error}", path.display()))
}

fn supported_preview_image_extension(path: &Path) -> Option<String> {
    let extension = path.extension()?.to_str()?.to_ascii_lowercase();
    matches!(extension.as_str(), "png" | "jpg" | "jpeg" | "gif" | "webp").then_some(extension)
}

fn durable_image_filename(display_name: Option<&str>, extension: &str) -> String {
    let basename = display_name
        .and_then(|name| {
            name.replace('\\', "/")
                .rsplit('/')
                .next()
                .map(str::to_string)
        })
        .unwrap_or_else(|| "Attached image".to_string());
    let filtered = basename
        .rsplit_once('.')
        .map(|(stem, _)| stem)
        .unwrap_or(&basename)
        .chars()
        .filter(|character| {
            character.is_alphanumeric() || matches!(character, ' ' | '-' | '_' | '(' | ')')
        })
        .collect::<String>();
    // Keep the complete path component below APFS/ext4's 255-byte ceiling,
    // not merely below a character count. Multi-byte names otherwise fail to
    // persist and silently fall back to their temporary source path.
    let mut stem = String::new();
    for character in filtered.chars() {
        if stem.len() + character.len_utf8() > 180 {
            break;
        }
        stem.push(character);
    }
    let mut stem = stem.trim().to_string();
    let upper = stem.to_ascii_uppercase();
    let reserved_device = matches!(upper.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || upper
            .strip_prefix("COM")
            .or_else(|| upper.strip_prefix("LPT"))
            .is_some_and(|suffix| suffix.len() == 1 && matches!(suffix.as_bytes()[0], b'1'..=b'9'));
    if reserved_device {
        stem.insert(0, '_');
    }
    format!(
        "{}.{}",
        if stem.is_empty() {
            "Attached image"
        } else {
            &stem
        },
        extension
    )
}

fn durable_image_destination(
    directory: &Path,
    display_name: Option<&str>,
    extension: &str,
    created_at_ms: i64,
    token: &str,
) -> PathBuf {
    directory
        .join(format!("{}-{}", created_at_ms, &token[..8]))
        .join(durable_image_filename(display_name, extension))
}

/// Re-authorizes a transcript image for the asset protocol after restart.
/// Dialog scopes are session-local, so an otherwise valid image selected by
/// the user would render once and then become a broken tile in old threads.
#[tauri::command]
async fn prepare_image_preview(app: AppHandle, path: String) -> Result<(), String> {
    let path = PathBuf::from(path);
    if supported_preview_image_extension(&path).is_none() {
        return Err(unsupported_image_format_error(&path));
    }
    // Legacy Claude/Cursor transcripts can legitimately retain the original
    // user-selected path when durable copying was unavailable. Restricting
    // this command to app data would break those histories; a tighter scope
    // needs thread identity plus an authoritative reference lookup.
    let metadata = tokio::fs::metadata(&path)
        .await
        .map_err(|error| format!("Could not open the attached image: {error}"))?;
    if !metadata.is_file() || metadata.len() > MAX_IMAGE_ATTACHMENT_BYTES {
        return Err("The attached image is unavailable or exceeds 50 MB".into());
    }
    app.asset_protocol_scope()
        .allow_file(&path)
        .map_err(|error| format!("Could not prepare the attached image preview: {error}"))
}

/// Copies a newly attached image into durable app data. Thread history keeps
/// only this path, so previews stay lightweight in memory and do not depend on
/// a screenshot utility's temporary source file surviving indefinitely.
#[tauri::command]
async fn persist_image_attachment(
    app: AppHandle,
    path: String,
    display_name: Option<String>,
) -> Result<String, String> {
    let source = PathBuf::from(path);
    let extension = supported_preview_image_extension(&source)
        .ok_or_else(|| unsupported_image_format_error(&source))?;
    validate_image_attachment(&source).await?;
    let directory = crate::release_qa::app_data_dir(&app)
        .map_err(|error| format!("Could not resolve Mythra Code app data: {error}"))?
        .join("message-images");
    tokio::fs::create_dir_all(&directory)
        .await
        .map_err(|error| format!("Could not create the message-images folder: {error}"))?;

    let canonical_source = tokio::fs::canonicalize(&source)
        .await
        .map_err(|error| format!("Could not read {}: {error}", source.display()))?;
    let canonical_directory = tokio::fs::canonicalize(&directory)
        .await
        .map_err(|error| format!("Could not resolve the message-images folder: {error}"))?;
    if canonical_source.starts_with(&canonical_directory) {
        app.asset_protocol_scope()
            .allow_file(&canonical_source)
            .map_err(|error| format!("Could not prepare the attached image preview: {error}"))?;
        return Ok(canonical_source.to_string_lossy().into_owned());
    }

    let token = random_hex_token()?;
    let destination = durable_image_destination(
        &directory,
        display_name.as_deref(),
        &extension,
        unix_timestamp_ms(),
        &token,
    );
    let destination_directory = destination
        .parent()
        .expect("durable image destinations always have a parent");
    tokio::fs::create_dir_all(&destination_directory)
        .await
        .map_err(|error| format!("Could not create the message-image folder: {error}"))?;
    let copied = tokio::fs::copy(&source, &destination)
        .await
        .map_err(|error| format!("Could not preserve the attached image: {error}"))?;
    if copied > MAX_IMAGE_ATTACHMENT_BYTES {
        let _ = tokio::fs::remove_file(&destination).await;
        return Err("The attached image grew beyond 50 MB while it was being preserved".into());
    }
    app.asset_protocol_scope()
        .allow_file(&destination)
        .map_err(|error| format!("Could not prepare the attached image preview: {error}"))?;
    Ok(destination.to_string_lossy().into_owned())
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
            let media_type = image_attachment_media_type(&path)?;
            let bytes = read_image_attachment(&path).await?;
            content.push(json!({
                "type": "image",
                "source": {
                    "type": "base64",
                    "media_type": media_type,
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
        "uuid": uuid::Uuid::new_v4().to_string(),
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

fn claude_agent_definitions(
    agents: &[ClaudeAgentInput],
    maximum: usize,
    native_subagents: bool,
) -> Value {
    // The saved profiles are the Mythra crew, not native Claude definitions.
    // Keep the provider's registered agents and their model defaults intact.
    if native_subagents {
        return json!({});
    }
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

/// The base built-in tools a Claude thread may use, before native opt-in.
///
/// `--tools` is an allowlist over the CLI's built-in set, so containment no
/// longer depends on Mythra Code knowing the name of every spawning tool. A
/// deny list only holds while the names hold: Claude Code renamed `Task` to
/// `Agent` in 2.1.63, while `Workflow`, cron, remote-trigger, and peer-message
/// tools were not in the old list. Those gaps left native fan-out routes
/// available. Anything absent from this allowlist —
/// `Agent`, `Workflow`, the background `Task*` family, cron and remote
/// triggers, peer messaging, and whatever a later release adds or renames —
/// is unavailable unless explicitly opened by CLAUDE_NATIVE_AGENT_TOOLS.
///
/// MCP tools are not governed by `--tools`, so the Mythra Code delegation
/// bridge still reaches Claude as the one approved way to delegate.
const CLAUDE_BUILTIN_TOOLS: &[&str] = &[
    "AskUserQuestion",
    "Bash",
    "BashOutput",
    "KillShell",
    "PowerShell",
    "Read",
    "Edit",
    "Write",
    "NotebookEdit",
    "Glob",
    "Grep",
    "LSP",
    "TodoWrite",
    "WebFetch",
    "WebSearch",
    "ListMcpResourcesTool",
    "ReadMcpResourceTool",
];

/// Built-in tools a read-only thread must not reach. Every executing or
/// writing tool in `CLAUDE_BUILTIN_TOOLS` belongs here.
const CLAUDE_WRITE_TOOLS: &[&str] = &[
    "Bash",
    "BashOutput",
    "KillShell",
    "PowerShell",
    "Write",
    "Edit",
    "NotebookEdit",
    "WebFetch",
    "WebSearch",
];

/// Provider-native spawning, scheduling, and agent-messaging surfaces.
///
/// Mythra mode withholds these because they bypass its approved roster,
/// concurrency budget, ownership records and child inbox. Native mode opens
/// only CLAUDE_NATIVE_AGENT_TOOLS; scheduling and unrelated routes stay denied.
/// The allowlist above already withholds them; naming them again as a deny list
/// keeps containment if a future CLI widens or ignores `--tools`, and covers
/// both the current `Agent` name and the pre-2.1.63 `Task` name. Only names
/// the CLI still knows belong here — it warns on stderr for the rest — so
/// retired names such as `TeamCreate` are left to the allowlist alone.
const CLAUDE_SPAWN_TOOLS: &[&str] = &[
    // A context:fork Skill dispatches its child internally, without calling
    // Agent and its spawn-depth guard. App-selected skills are expanded inline
    // before dispatch instead; the provider executor is unavailable in either
    // engine so it cannot bypass the selected delegation/lifecycle boundary.
    "Skill",
    "Agent",
    "Task",
    "Workflow",
    "TaskCreate",
    "TaskGet",
    "TaskList",
    "TaskUpdate",
    "TaskStop",
    "TaskOutput",
    "SendMessage",
    "SendUserMessage",
    "ListAgents",
    "ListPeers",
    "CronCreate",
    "CronDelete",
    "CronList",
    "ScheduleWakeup",
    "RemoteTrigger",
];

/// Native mode opens only ordinary in-session delegation. Workflows, teams,
/// scheduling and cross-session messaging remain outside this route.
const CLAUDE_NATIVE_AGENT_TOOLS: &[&str] = &["Agent", "Task", "TaskOutput", "TaskStop"];

fn claude_allowed_builtin_tools(permission: &str, native_subagents: bool) -> Vec<&'static str> {
    let native_tools = if native_subagents {
        CLAUDE_NATIVE_AGENT_TOOLS
    } else {
        &[]
    };
    CLAUDE_BUILTIN_TOOLS
        .iter()
        .chain(native_tools.iter())
        .copied()
        .filter(|tool| permission != "read-only" || !CLAUDE_WRITE_TOOLS.contains(tool))
        // An unrelated spawning route must never reach the allowlist,
        // whatever a later edit to CLAUDE_BUILTIN_TOOLS adds.
        .filter(|tool| {
            !CLAUDE_SPAWN_TOOLS.contains(tool)
                || native_subagents && CLAUDE_NATIVE_AGENT_TOOLS.contains(tool)
        })
        .collect()
}

fn claude_disallowed_tools(permission: &str, native_subagents: bool) -> Vec<&'static str> {
    let mut disallowed = Vec::new();
    if permission == "read-only" {
        disallowed.extend(CLAUDE_WRITE_TOOLS.iter().copied());
    }
    disallowed.extend(
        CLAUDE_SPAWN_TOOLS
            .iter()
            .copied()
            .filter(|tool| !native_subagents || !CLAUDE_NATIVE_AGENT_TOOLS.contains(tool)),
    );
    disallowed
}

/// The tool-availability arguments handed to the Claude CLI, built once so a
/// test can assert on exactly what the spawned command receives.
fn claude_tool_arguments(permission: &str, native_subagents: bool) -> Vec<String> {
    let mut arguments = vec![
        // Also close user slash-command forks: they do not call the exposed
        // Skill/Agent tools. This process-local flag disables the provider's
        // skill executor, not Mythra Code's inline skill resolution.
        "--disable-slash-commands".to_string(),
        "--tools".to_string(),
        claude_allowed_builtin_tools(permission, native_subagents).join(","),
    ];
    let disallowed = claude_disallowed_tools(permission, native_subagents);
    if !disallowed.is_empty() {
        arguments.push("--disallowedTools".to_string());
        arguments.push(disallowed.join(","));
    }
    arguments
}

fn validate_claude_native_support(
    native_subagents: bool,
    native_supported: bool,
) -> Result<(), String> {
    if native_subagents && !native_supported {
        return Err("Native Claude sub-agents require a verified Claude Code 2.1.267 or newer to preserve parent permission rules and apply changed delegation instructions when this conversation resumes. Update Claude Code or choose Mythra Code sub-agents.".into());
    }
    Ok(())
}

fn validate_claude_native_options(
    model: Option<&str>,
    compact_tokens: Option<usize>,
    haiku55_supported: bool,
) -> Result<(), String> {
    if let Some(model) = model.map(str::trim).filter(|model| !model.is_empty()) {
        let lower = model.to_ascii_lowercase();
        let identifier = lower.strip_suffix("[1m]").unwrap_or(&lower);
        if model.len() > 200 || identifier.is_empty() || !identifier.bytes().all(|byte| byte.is_ascii_alphanumeric()
            || matches!(byte, b'.' | b'_' | b':' | b'/' | b'-'))
            || matches!(identifier, "default" | "inherit")
        {
            return Err("Choose a supported native child model, or leave it empty for provider selection.".into());
        }
        if (identifier == "haiku" || identifier.starts_with("claude-haiku-5-5")) && !haiku55_supported {
            return Err("Native Haiku 5.5 requires a verified Claude Code 2.1.293 or newer. Update Claude Code or choose another child model.".into());
        }
    }
    if compact_tokens.is_some_and(|tokens| !(100_000..=1_000_000).contains(&tokens)) {
        return Err("The native auto-compact window must be a whole token count from 100,000 to 1,000,000.".into());
    }
    Ok(())
}

/// Identity keys verified against the first-party Claude Code 2.1.293
/// modelSettings resolver. Unknown/custom spellings are deliberately refused
/// for separate windows instead of guessing which model they serve.
fn claude_compaction_model_key(model: &str) -> Option<String> {
    let lower = model.trim().to_ascii_lowercase();
    let spelling = lower.strip_suffix("[1m]").unwrap_or(&lower);
    let spelling = match spelling {
        "opus" => "claude-opus-5-5",
        "sonnet" => "claude-sonnet-5-5",
        "haiku" => "claude-haiku-5-5",
        "fable" => "claude-fable-5-1",
        value => value,
    };
    let spelling = spelling.rsplit_once('-').filter(|(_, suffix)|
        suffix.len() == 8 && suffix.bytes().all(|byte| byte.is_ascii_digit())
    ).map_or(spelling, |(prefix, _)| prefix);
    matches!(spelling,
        "claude-opus-4-6" | "claude-opus-4-7" | "claude-opus-4-8" |
        "claude-opus-5" | "claude-opus-5-5" |
        "claude-sonnet-4-5" | "claude-sonnet-4-6" | "claude-sonnet-5" |
        "claude-sonnet-5-5" | "claude-haiku-4-5" | "claude-haiku-5-5" |
        "claude-fable-5" | "claude-fable-5-1"
    ).then(|| spelling.to_string())
}

fn claude_compaction_settings(
    parent_model: &str,
    parent_tokens: Option<usize>,
    child_model: Option<&str>,
    child_tokens: Option<usize>,
) -> Result<Option<Value>, String> {
    for tokens in [parent_tokens, child_tokens].into_iter().flatten() {
        if !(100_000..=1_000_000).contains(&tokens) {
            return Err("The auto-compact window must be a whole token count from 100,000 to 1,000,000.".into());
        }
    }
    if parent_tokens.is_none() && child_tokens.is_none() {
        return Ok(None);
    }
    let mut settings = json!({"autoCompactEnabled": true});
    let parent_key = claude_compaction_model_key(parent_model);
    if child_tokens.is_some() && child_tokens != parent_tokens {
        let parent = parent_key.ok_or_else(|| "Separate native auto-compact windows require an explicit supported parent model. Choose a model instead of Provider default, or use Mythra Code sub-agents.".to_string())?;
        let child = child_model.and_then(claude_compaction_model_key).ok_or_else(|| "Separate native auto-compact windows require an explicit supported child model. Choose a child model, or use Mythra Code sub-agents.".to_string())?;
        if parent == child {
            return Err("Claude native parent and children using the same model share that model's auto-compact window. Choose a different child model, use the same window, or choose Mythra Code sub-agents.".into());
        }
        let mut models = serde_json::Map::new();
        models.insert(parent, json!({"autoCompactWindow": parent_tokens.map_or(json!("auto"), |tokens| json!(tokens))}));
        models.insert(child, json!({"autoCompactWindow": child_tokens}));
        settings["modelSettings"] = Value::Object(models);
    } else if let Some(tokens) = parent_tokens.or(child_tokens) {
        // Equal explicit windows are safe even when the provider chooses the
        // model. A parent-only value is keyed when its identity is known.
        if child_tokens.is_none() {
            if let Some(parent) = parent_key {
                settings["modelSettings"] = json!({parent: {"autoCompactWindow": tokens}});
            } else {
                settings["autoCompactWindow"] = json!(tokens);
            }
        } else {
            settings["autoCompactWindow"] = json!(tokens);
        }
    }
    Ok(Some(settings))
}

fn configure_claude_compaction(command: &mut Command, settings: Option<&Value>) {
    let Some(settings) = settings else { return; };
    command.env_remove("CLAUDE_CODE_AUTO_COMPACT_WINDOW")
        .env_remove("CLAUDE_AUTOCOMPACT_PCT_OVERRIDE")
        .env_remove("DISABLE_COMPACT")
        .env_remove("DISABLE_AUTO_COMPACT")
        .arg("--settings").arg(settings.to_string());
}

fn configure_claude_agents_disabled(command: &mut Command) {
    // --tools/--disallowedTools remove provider delegation from the exposed
    // tool set. Also close the supported internal catalog/fork gates so an
    // inherited CLI environment cannot re-enable them for an off/Mythra turn.
    // These overrides belong only to this child process, including resumes.
    command
        .env("CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS", "1")
        .env("CLAUDE_CODE_DISABLE_EXPLORE_PLAN_AGENTS", "1")
        .env("CLAUDE_CODE_FORK_SUBAGENT", "0")
        .env("CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS", "0")
        .env_remove("CLAUDE_CODE_SUBAGENT_MODEL")
        .env_remove("CLAUDE_CODE_SUBAGENT_MODEL_FORCE");
}

fn configure_claude_native_agents(
    command: &mut Command,
    maximum: Option<usize>,
    model: Option<&str>,
) {
    // This app owns a process per turn and closes it after its root result.
    // Foreground children finish inside that turn; background children could
    // otherwise lose their later completion notification when we reap it.
    command
        // Complete child messages carry the actual model and parent tool id.
        // The frontend routes these into native activity, never root answers.
        .arg("--forward-subagent-text")
        .env("CLAUDE_CODE_DISABLE_BACKGROUND_TASKS", "1")
        .env("CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH", "1")
        .env(
            "CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS",
            maximum.unwrap_or(6).clamp(1, 24).to_string(),
        )
        // Retain the runtime's built-in catalog and model defaults. A process
        // inherited override must not silently hijack this thread's selection.
        .env_remove("CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS")
        .env_remove("CLAUDE_CODE_DISABLE_EXPLORE_PLAN_AGENTS")
        .env_remove("CLAUDE_CODE_SUBAGENT_MODEL")
        .env_remove("CLAUDE_CODE_SUBAGENT_MODEL_FORCE")
        // Native mode opens ordinary in-session children, not teams. Pin the
        // supported gate instead of inheriting an unrelated CLI opt-in.
        .env("CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS", "0")
        // Forks inherit the parent context/model and require background work,
        // which this per-turn process does not support.
        .env("CLAUDE_CODE_FORK_SUBAGENT", "0");
    if let Some(model) = model.map(str::trim).filter(|model| !model.is_empty()) {
        command.env("CLAUDE_CODE_SUBAGENT_MODEL", model)
            .env("CLAUDE_CODE_SUBAGENT_MODEL_FORCE", "1");
    }
}

fn claude_permission_arguments(permission: &str) -> Vec<&'static str> {
    // Interactive questions always use the control channel, including full
    // access. dontAsk suppresses AskUserQuestion itself, so read-only uses
    // manual mode with an automatic denial for ordinary permission requests.
    let mut arguments = vec!["--permission-prompt-tool", "stdio", "--permission-mode"];
    if permission == "full" {
        arguments.extend(["bypassPermissions", "--allow-dangerously-skip-permissions"]);
    } else {
        arguments.push("manual");
    }
    arguments
}

fn claude_read_only_denial(read_only: bool, message: &Value) -> Option<Value> {
    // Agent launches in manual mode don't ordinarily require permission;
    // each child's tools still use this control channel. Keep explicit policy
    // prompts denied too rather than granting a native-agent exception here.
    let request = &message["request"];
    if !read_only
        || message["type"] != "control_request"
        || request["subtype"] != "can_use_tool"
        || request["tool_name"] == "AskUserQuestion"
    {
        return None;
    }
    let request_id = message["request_id"].as_str()?;
    Some(json!({
        "type": "control_response",
        "response": {
            "subtype": "success", "request_id": request_id,
            "response": { "behavior": "deny", "message": "This task is read-only." }
        }
    }))
}

/// A scheduled workflow has nobody to answer Claude's stdio permission or
/// question prompts. Deny the pending tool request through the normal control
/// protocol so the turn can either continue within its saved access or fail.
fn claude_unattended_denial(interactive: bool, message: &Value) -> Option<Value> {
    if interactive
        || message["type"] != "control_request"
        || message["request"]["subtype"] != "can_use_tool"
    {
        return None;
    }
    let request_id = message["request_id"].as_str()?;
    Some(json!({
        "type": "control_response",
        "response": {
            "subtype": "success", "request_id": request_id,
            "response": {
                "behavior": "deny",
                "message": "This unattended workflow cannot answer permission or user-input requests. Run it manually or change its saved access settings."
            }
        }
    }))
}


#[tauri::command]
async fn language_tools_snapshot(
    app: AppHandle,
) -> Result<language_tools::LanguageToolsSnapshot, String> {
    language_tools::snapshot(&app).await
}

#[tauri::command]
async fn language_tools_refresh(
    app: AppHandle,
) -> Result<language_tools::LanguageToolsSnapshot, String> {
    language_tools::refresh(&app).await
}

#[tauri::command]
async fn language_tools_set_auto_install(
    app: AppHandle,
    enabled: bool,
) -> Result<language_tools::LanguageToolsSnapshot, String> {
    language_tools::set_auto_install(&app, enabled).await
}

#[tauri::command]
async fn language_tools_install(
    app: AppHandle,
    id: String,
) -> Result<language_tools::LanguageToolsSnapshot, String> {
    language_tools::install(&app, &id).await
}

#[tauri::command]
async fn language_tools_set_enabled(
    app: AppHandle,
    id: String,
    enabled: bool,
) -> Result<language_tools::LanguageToolsSnapshot, String> {
    language_tools::set_enabled(&app, &id, enabled).await
}

#[tauri::command]
async fn language_tools_prepare_project(
    app: AppHandle,
    cwd: String,
    permission: String,
) -> Result<(), String> {
    // Read-only and Ask threads may use existing tools, but cannot silently
    // install software. Manual Settings installations are explicit user actions.
    language_tools::prepare_project_tools(&app, &cwd, permission == "full", &permission)
        .await
        .map(|_| ())
}

#[tauri::command]
async fn claude_turn_start(
    app: AppHandle,
    state: State<'_, ClaudeState>,
    agent_state: State<'_, ChildAgentState>,
    mut options: ClaudeTurnOptions,
) -> Result<ClaudeTurnStarted, String> {
    let mut process_requested = false;
    let mut safe_not_dispatched = false;
    let result: Result<ClaudeTurnStarted, String> = async {
    let _billing_admission = provider_auth::begin_use(&app, provider_auth::ApiKeyProvider::Anthropic)?;
    let turn_id = uuid::Uuid::new_v4().to_string();
    let start = state.starts.begin(&options.thread_id, &turn_id, options.start_request_id.as_deref())?;
    let binary = resolve_claude_binary(&app).await?;
    start.assert_current()?;
    let authorized_generation = claude_auth_generation(&app);
    if !state.authenticated.load(Ordering::Acquire) {
        let auth = read_claude_runtime_status(&app).await;
        if !auth.logged_in {
            if !auth.auth_verified {
                return Err("Claude Code could not verify your account. Check the connection before sending a message.".into());
            }
            if auth.billing == Some(provider_auth::ClaudeBilling::ApiKey) {
                return Err("Add an Anthropic API key in Settings › Models & accounts, or switch Claude back to your subscription, before sending a message.".into());
            }
            return Err("Sign in to Claude Code before sending a message.".into());
        }
    }
    // Read after the authorization generation: a billing or key change
    // publishes before it advances the generation, so a start holding the
    // old choice is refused at spawn by `claude_auth_admits`.
    let api_key = provider_auth::claude_turn_api_key(&app).await?;
    let selected_billing = provider_auth::claude_billing(&app)?;
    if options.cwd.trim().is_empty() || !Path::new(&options.cwd).is_dir() {
        return Err("Choose a valid project folder before starting this Claude thread.".into());
    }
    if normal_chat::contains(&app, &options.cwd)? {
        options.system_prompt = normal_chat::instructions(&options.system_prompt);
    }
    validate_cli_value(&options.thread_id, "The thread identity")?;
    validate_cli_value(&options.model, "The model identity")?;
    if state
        .turns
        .lock()
        .await
        .get(&options.thread_id)
        .is_some_and(|turn| turn.alive.load(Ordering::Acquire) || turn.cutoff_uncertain.load(Ordering::Acquire))
    {
        return Err("Claude is already working in this thread".into());
    }

    let home = crate::release_qa::home_dir(&app).ok();
    let mut command = subscription_only_command(&binary, home.as_deref());
    if let Some(key) = api_key {
        command.env("ANTHROPIC_API_KEY", key);
    }
    // Windows executable resolution must not prefer a project-local binary
    // over the private language server's explicitly controlled PATH. This
    // flag belongs on the spawning CLI, not merely its LSP child environment.
    #[cfg(windows)]
    command.env("NoDefaultCurrentDirectoryInExePath", "1");
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
            "Mythra Code",
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
    let snapshot_supported = claude_prompt_snapshot_supported(&state, &binary).await;
    let compaction_settings = claude_compaction_settings(
        &options.model, options.auto_compact_tokens,
        options.native_subagents.then_some(options.native_subagent_model.as_deref()).flatten(),
        options.native_subagents.then_some(options.native_auto_compact_tokens).flatten(),
    )?;
    if compaction_settings.is_some() {
        if !cached_claude_model_compaction_support(&state.prompt_snapshot_support, &binary).await {
            return Err("Explicit Claude auto-compaction requires a verified Claude Code 2.1.288 or newer. Update Claude Code before choosing this window.".into());
        }
        if claude_compaction_model_key(&options.model).as_deref() == Some("claude-haiku-5-5")
            && !cached_claude_haiku55_support(&state.prompt_snapshot_support, &binary).await {
            return Err("Haiku 5.5 requires a verified Claude Code 2.1.293 or newer. Update Claude Code before choosing this model.".into());
        }
    }
    configure_claude_compaction(&mut command, compaction_settings.as_ref());
    if options.native_subagents {
        validate_claude_native_support(
            true,
            cached_claude_native_subagent_support(&state.prompt_snapshot_support, &binary).await,
        )?;
        validate_claude_native_options(
            options.native_subagent_model.as_deref(), options.native_auto_compact_tokens,
            cached_claude_haiku55_support(&state.prompt_snapshot_support, &binary).await,
        )?;
        configure_claude_native_agents(
            &mut command, options.native_subagent_max,
            options.native_subagent_model.as_deref(),
        );
    } else {
        configure_claude_agents_disabled(&mut command);
    }
    command.args(claude_system_prompt_arguments(
        &options.system_prompt,
        snapshot_supported,
    ));
    let agent_definitions = claude_agent_definitions(
        &options.custom_agents,
        options.subagent_max,
        options.native_subagents,
    );
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
    command.args(claude_permission_arguments(&options.permission));
    command.args(claude_tool_arguments(
        &options.permission,
        options.native_subagents,
    ));
    // Language plugins are explicitly supplied because Claude's user/project
    // settings are intentionally isolated. Optional setup must never prevent
    // a normal turn from starting when a dependency is unavailable.
    if let Ok(Some(plugin_path)) =
        language_tools::prepare_project(&app, &options.cwd, false, &options.permission).await
    {
        command.arg("--plugin-dir").arg(plugin_path);
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
        if options.native_subagents
            && child_agent_bridge_config_allows_spawning(&agent_state, bridge_config).await
        {
            return Err("Native Claude sub-agents cannot run with a Mythra Code delegation bridge. Reconfigure this thread's sub-agent mode before starting.".into());
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
    // "Claude is already working" until Mythra Code restarts.
    let user_message =
        claude_user_message(&options.thread_id, &options.prompt, &options.attachments).await?;

    claude_auth_admits(&state, authorized_generation)?;
    start.assert_current()?;
    process_requested = true;
    let mut child = command
        .spawn()
        .map_err(|error| { safe_not_dispatched = true; format!("Could not start Claude Code: {error}") })?;
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
        turn_id: turn_id.clone(),
        start_request_id: options.start_request_id.clone(),
        stdin: Mutex::new(Some(stdin)),
        child: Arc::new(Mutex::new(child)),
        pid,
        alive: alive.clone(),
        input_ready: AtomicBool::new(false),
        cutoff_uncertain: AtomicBool::new(false),
        cutoff_error: StdMutex::new(None),
        control_requests: Mutex::new(HashSet::new()),
        control_response: Mutex::new(()),
    });
    if !claim_turn_slot(&state.turns, &options.thread_id, &turn, |existing| {
        existing.alive.load(Ordering::Acquire) || existing.cutoff_uncertain.load(Ordering::Acquire)
    })
    .await
    {
        let _ = turn.shutdown().await;
        return Err("Claude is already working in this thread".into());
    }
    if let Err(error) = start.assert_current() {
        if let Err(cutoff) = turn.shutdown().await {
            start.record_cutoff_error(&cutoff);
            return Err(format!("{error} The unused process cutoff is uncertain: {cutoff}"));
        }
        remove_claude_turn_if_current(&state.turns, &options.thread_id, &turn).await;
        safe_not_dispatched = true;
        return Err(error);
    }

    // Both output pipes are drained before any input is written. A CLI that
    // writes startup output before reading its prompt would otherwise fill an
    // unread pipe and stop reading stdin while this write waits for it.
    let stderr_lines = Arc::new(Mutex::new(TailBuffer::new(CLAUDE_STDERR_TAIL_BYTES)));
    let stderr_output = stderr_lines.clone();
    let mut stderr_task = tauri::async_runtime::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let line = line.trim();
            if !line.is_empty() {
                stderr_output.lock().await.push_line(line);
            }
        }
    });
    let mut lines = BufReader::new(stdout).lines();

    let initialize = json!({
        "type": "control_request",
        "request_id": uuid::Uuid::new_v4().to_string(),
        "request": { "subtype": "initialize" }
    });
    let mut early_output = match write_claude_startup_input(
        &turn,
        &[&initialize],
        &user_message,
        selected_billing,
        // The pre-spawn check can be stale after the slot claim and the
        // control write; recheck at the input boundary itself.
        || claude_auth_admits(&state, authorized_generation),
        &mut lines,
        Instant::now() + CLAUDE_STARTUP_INPUT_TIMEOUT,
    )
    .await
    {
        Ok(early_output) => early_output,
        Err(failure) => {
            let cutoff = turn.shutdown().await;
            let (error, not_sent) = match failure {
                ClaudeStartupInputError::NotSent(error) => (error, true),
                ClaudeStartupInputError::Refused(refusal) => {
                    // Give the drain a moment to collect a final stderr line,
                    // such as an unknown-option error, from the stopped CLI.
                    if cutoff.is_ok() {
                        let _ = timeout(CLAUDE_REFUSAL_STDERR_WAIT, &mut stderr_task).await;
                    }
                    let stderr = stderr_lines.lock().await.contents().to_owned();
                    (format!("{} Your message was not sent.", refusal.message(&stderr)), true)
                }
                ClaudeStartupInputError::Failed(error) => (error, false),
            };
            if let Err(cutoff) = cutoff {
                start.record_cutoff_error(&cutoff);
                stderr_task.abort();
                return Err(format!("{error} Claude startup cleanup could not confirm cutoff: {cutoff}"));
            }
            remove_claude_turn_if_current(&state.turns, &options.thread_id, &turn).await;
            stderr_task.abort();
            // The user's message was never written and the unused process is
            // confirmed stopped, as on the other pre-dispatch refusals.
            if not_sent {
                safe_not_dispatched = true;
            }
            return Err(error);
        }
    };

    let mut turn_boundary = ClaudeTurnBoundary::new(
        user_message["uuid"]
            .as_str()
            .expect("user message UUID")
            .to_string(),
        options.resume,
    );
    let stdout_app = app.clone();
    let read_only = options.permission == "read-only";
    let interactive = options.interactive;
    let stdout_mailbox_config = if options.native_subagents {
        None
    } else {
        options.child_agent_bridge_config.clone()
    };
    let stdout_permission = options.permission;
    let stdout_cwd = options.cwd;
    let stdout_thread = options.thread_id;
    let stdout_turn = turn_id.clone();
    let turns = state.turns.clone();
    let receipts = state.terminal_receipts.clone();
    let stdout_child = turn.child.clone();
    let stdout_runtime = turn.clone();
    tauri::async_runtime::spawn(async move {
        let mut terminal_result = None;
        let mut root_assistant: Option<ClaudeRootAssistant> = None;
        // The root `end_turn` assistant (provider id, whole-message text)
        // still standing as the CLI's last word. Any reopening output
        // withdraws it. A message that invoked a tool is never an answer.
        let mut terminal_assistant: Option<(String, String)> = None;
        // High-frequency `stream_event` messages are coalesced into a single
        // "claude-events" array emit (mirroring the Codex reader), flushed on
        // a ~25ms tick, at the event or byte flush threshold, or before any non-delta
        // message so ordering is strictly preserved. Each array entry is
        // exactly the payload the per-line "claude-event" emit would have
        // carried.
        let mut delta_buffer = ProviderDeltaBatch::default();
        let mut observed_exit = None;
        let flush_deltas = |buffer: &mut ProviderDeltaBatch, app: &AppHandle| {
            if let Some(batch) = buffer.take() {
                let _ = app.emit("claude-events", batch);
            }
        };

        'reader: loop {
            // `Lines::next_line` is cancellation safe, so racing it against
            // the flush deadline cannot drop partial lines. Output read while
            // startup input was being written comes first, in order.
            let next = if let Some(early) = early_output.pop_front() {
                early
            } else if let Some(flush_deadline) = delta_buffer.deadline() {
                match timeout_at(flush_deadline, lines.next_line()).await {
                    Ok(next) => next,
                    Err(_) => {
                        flush_deltas(&mut delta_buffer, &stdout_app);
                        continue;
                    }
                }
            } else {
                match timeout(Duration::from_secs(1), lines.next_line()).await {
                    Ok(next) => next,
                    Err(_) => {
                        // A grandchild can inherit stdout and keep the pipe
                        // open after the direct Claude process has exited.
                        // Poll the direct child while output is idle so that
                        // orphaned pipe handles cannot retain this turn slot
                        // forever and block every queued follow-up.
                        match stdout_child.lock().await.try_wait() {
                            Ok(Some(exit)) => {
                                observed_exit = Some(exit);
                                break 'reader;
                            }
                            Ok(None) => continue,
                            Err(error) => {
                                stderr_lines.lock().await.push_line(&format!(
                                    "Could not inspect Claude Code after output stopped: {error}"
                                ));
                                break 'reader;
                            }
                        }
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
                        "message": format!("Claude Code sent output Mythra Code could not parse: {line}"),
                    }),
                )
                .await;
                continue;
            };
            if message.get("type").and_then(Value::as_str) == Some("stream_event") {
                if claude_reopens_turn(&message) {
                    terminal_assistant = None;
                }
                let event = json!({
                    "threadId": stdout_thread,
                    "turnId": stdout_turn,
                    "message": message,
                });
                // Ready lines win the deadline race during a continuous
                // stream, so the flush thresholds are checked after each append.
                if delta_buffer.push(event, line.len(), Instant::now()) {
                    flush_deltas(&mut delta_buffer, &stdout_app);
                }
                continue;
            }
            flush_deltas(&mut delta_buffer, &stdout_app);
            let ends_turn = turn_boundary.ends_turn(&message);
            if message.get("type").and_then(Value::as_str) == Some("result") && !ends_turn {
                // This result belongs to restored work, not the queued prompt.
                // Do not forward it to the UI's terminal-result handler either.
                continue;
            }
            // Recovery evidence, never a boundary: only an `end_turn` that is
            // still the CLI's last word when the process dies may seal a turn.
            // A prompt the CLI has queued but not started cannot have produced
            // one — that output belongs to a resumed session's restored work —
            // and later tool results or a steered follow-up mean work was
            // still in flight at exit.
            if claude_root_assistant(&message) {
                root_assistant = Some(accumulate_claude_root_assistant(&message, root_assistant.take()));
            }
            if claude_assistant_ends_turn(&message) {
                terminal_assistant = if turn_boundary.prompt_pending() {
                    None
                } else {
                    root_assistant.as_ref().map(|assistant| {
                        (assistant.id.clone(), if assistant.tool_use { String::new() } else { assistant.text.clone() })
                    })
                };
            } else if claude_reopens_turn(&message) {
                terminal_assistant = None;
            }
            if ends_turn {
                // Result delivery is not a transcript flush acknowledgement.
                // Keep the slot until EOF lets the CLI save and exit, then
                // publish completion so a queued resume cannot race that save.
                stdout_runtime.close_input().await;
                terminal_result = Some(message);
                break;
            }
            if message.get("type").and_then(Value::as_str) == Some("control_request") {
                let mailbox_response = if let Some(config_path) = stdout_mailbox_config.as_deref() {
                    child_agent_bridge_mailbox_control_response(
                        &stdout_app.state::<ChildAgentState>(),
                        config_path,
                        &stdout_permission,
                        &stdout_cwd,
                        &message,
                    ).await
                } else {
                    None
                };
                if let Some(response) = mailbox_response
                    .or_else(|| claude_unattended_denial(interactive, &message))
                    .or_else(|| claude_read_only_denial(read_only, &message))
                {
                    if stdout_runtime.write(&response).await.is_err() {
                        break;
                    }
                    continue;
                }
                // Record the request id (before emitting) so the approval
                // commands can verify a response targets a request this
                // exact turn is still waiting on.
                if let Some(request_id) = message.get("request_id").and_then(Value::as_str) {
                    stdout_runtime
                        .control_requests
                        .lock()
                        .await
                        .insert(request_id.to_string());
                }
            }
            if message.get("type").and_then(Value::as_str) == Some("control_cancel_request") {
                if let Some(request_id) = message.get("request_id").and_then(Value::as_str) {
                    stdout_runtime
                        .control_requests
                        .lock()
                        .await
                        .remove(request_id);
                }
            }
            emit_claude_event(&stdout_app, &stdout_thread, &stdout_turn, message).await;
        }
        flush_deltas(&mut delta_buffer, &stdout_app);
        let saw_result = terminal_result.is_some();
        let exit_result = if let Some(exit) = observed_exit {
            Ok(exit)
        } else {
            let mut child = stdout_child.lock().await;
            let grace = if saw_result {
                CLAUDE_RESULT_EXIT_GRACE
            } else {
                Duration::from_secs(5)
            };
            reap_claude_process(&mut child, &mut lines.into_inner(), grace).await
        };
        let exit = match exit_result {
            Ok(exit) => Some(exit),
            Err(error) => {
                stdout_runtime.alive.store(false, Ordering::Release);
                stdout_runtime.cutoff_uncertain.store(true, Ordering::Release);
                *stdout_runtime.cutoff_error.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = Some(error.clone());
                stderr_task.abort();
                emit_claude_event(&stdout_app, &stdout_thread, &stdout_turn,
                    json!({"type":"openkiwi_cutoff_uncertain","message":error})).await;
                return;
            }
        };
        let recovered = claude_can_recover_at_exit(terminal_assistant.is_some(), exit.as_ref());
        let (terminal_assistant_id, terminal_assistant_text) = terminal_assistant.unwrap_or_default();
        // Each terminal event is recorded as this turn's receipt BEFORE the
        // slot is released, so a health probe that finds the process inactive
        // always finds the exact outcome too. The slot still releases before
        // emission so a follow-up the renderer starts on completion is not
        // rejected as busy.
        if let Some(mut message) = terminal_result {
            // Provenance: the renderer confirms this exact root message as the
            // answer, never the latest arbitrary text. With no result text,
            // its whole observed text travels too, since that envelope may
            // still be queued when a health probe delivers this receipt.
            if !terminal_assistant_id.is_empty() {
                let empty = message.get("result").and_then(Value::as_str).is_none_or(|result| result.trim().is_empty());
                if let Some(object) = message.as_object_mut() {
                    object.insert("openkiwi_terminal_assistant_id".to_string(), Value::String(terminal_assistant_id.clone()));
                    if empty && !terminal_assistant_text.trim().is_empty() {
                        object.insert("openkiwi_terminal_assistant_text".to_string(), Value::String(terminal_assistant_text.clone()));
                    }
                }
            }
            record_claude_terminal_receipt(&receipts, &stdout_thread, &stdout_turn, &message);
            stdout_runtime.alive.store(false, Ordering::Release);
            remove_claude_turn_if_current(&turns, &stdout_thread, &stdout_runtime).await;
            emit_claude_event(&stdout_app, &stdout_thread, &stdout_turn, message).await;
        } else if recovered {
            // The direct process is gone, so no later result can carry usage
            // or a different terminal state. The assistant event was already
            // forwarded and contains its own usage; synthesize only the
            // missing lifecycle envelope so the renderer can seal the turn,
            // naming the exact end_turn message and its whole observed text
            // instead of leaving the answer to inference or to delivery of a
            // still-queued assistant envelope.
            let message = json!({
                "type": "result",
                "subtype": "success",
                "is_error": false,
                "num_turns": 1,
                "result": "",
                "openkiwi_recovered_from_assistant_end_turn": true,
                "openkiwi_terminal_assistant_id": terminal_assistant_id,
                "openkiwi_terminal_assistant_text": terminal_assistant_text,
            });
            record_claude_terminal_receipt(&receipts, &stdout_thread, &stdout_turn, &message);
            stdout_runtime.alive.store(false, Ordering::Release);
            remove_claude_turn_if_current(&turns, &stdout_thread, &stdout_runtime).await;
            emit_claude_event(&stdout_app, &stdout_thread, &stdout_turn, message).await;
        }
        // A descendant can inherit stderr just as it can stdout. Never let an
        // orphaned pipe retain the turn slot after the direct Claude process
        // has been reaped; the captured tail is diagnostic, not a lifecycle
        // boundary.
        if timeout(Duration::from_secs(1), &mut stderr_task)
            .await
            .is_err()
        {
            stderr_task.abort();
        }
        if !saw_result && !recovered {
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
            let message = json!({
                "type": "openkiwi_exit",
                "message": detail,
                "code": exit.and_then(|status| status.code()),
            });
            record_claude_terminal_receipt(&receipts, &stdout_thread, &stdout_turn, &message);
            emit_claude_event(&stdout_app, &stdout_thread, &stdout_turn, message).await;
        }
        // Keep the turn visible as active until its terminal event has been
        // emitted. This closes the recovery race where the UI saw an inactive
        // process first, called it interrupted, and then suppressed the real
        // unexpected-exit error.
        alive.store(false, Ordering::Release);
        remove_claude_turn_if_current(&turns, &stdout_thread, &stdout_runtime).await;
    });

    Ok(ClaudeTurnStarted { turn_id })
    }.await;
    if process_requested && !safe_not_dispatched { result } else {
        result.map_err(|error| format!("MYTHRA_NOT_DISPATCHED: {}", provider_error_text(&error)))
    }
}

#[tauri::command]
async fn claude_turn_steer(
    state: State<'_, ClaudeState>,
    thread_id: String,
    prompt: String,
    attachments: Vec<ClaudeAttachment>,
    expected_turn_id: Option<String>,
) -> Result<(), String> {
    let turn = state
        .turns
        .lock()
        .await
        .get(&thread_id)
        .cloned()
        .ok_or_else(|| "Claude is not currently running in this thread".to_string())?;
    // The renderer's captured owner may have completed before this invoke
    // acquired the map. Bind input to that owner, never to its successor.
    // Bridge child messages intentionally omit an expectation to address
    // whichever turn currently owns the child conversation.
    if expected_turn_id.as_deref().is_some_and(|expected| expected != turn.turn_id) {
        return Err("MYTHRA_NOT_DISPATCHED: Claude expected turn ID does not match the currently running turn.".into());
    }
    if !turn.input_ready.load(Ordering::Acquire) {
        return Err("MYTHRA_NOT_DISPATCHED: Claude is still confirming its billing method and sending the original message. Try this input again when startup finishes.".into());
    }
    let message = claude_user_message(&thread_id, &prompt, &attachments).await?;
    turn.write(&message).await
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
        // of leaving the thread stuck until Mythra Code restarts.
        if let Err(cutoff) = turn.shutdown().await {
            return Err(format!("{error}. Claude cutoff could not be confirmed: {cutoff}"));
        }
        remove_claude_turn_if_current(&state.turns, &thread_id, &turn).await;
        return Err(error);
    }
    // Escalate if the CLI ignores the interrupt. A healthy process emits a
    // `result` well within the grace period (whose reader reaps the process);
    // a wedged one would otherwise hold the per-thread slot until app restart.
    let turns = state.turns.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(CLAUDE_INTERRUPT_GRACE).await;
        if turn.alive.load(Ordering::Acquire) {
            if turn.shutdown().await.is_ok() {
                remove_claude_turn_if_current(&turns, &thread_id, &turn).await;
            }
        }
    });
    Ok(())
}

/// Force-stop the Claude process for a thread, releasing its slot immediately.
/// Used by the frontend when a stale process is blocking new turns.
#[tauri::command]
async fn claude_turn_kill(state: State<'_, ClaudeState>, thread_id: String, expected_turn_id: Option<String>, expected_start_request_id: Option<String>) -> Result<(), String> {
    let turns = state.turns.lock().await;
    let turn = turns.get(&thread_id).cloned();
    if turn.as_ref().is_some_and(|turn| expected_turn_id.as_deref().is_some_and(|expected| expected != turn.turn_id)
        || expected_start_request_id.as_deref().is_some_and(|expected| turn.start_request_id.as_deref() != Some(expected))) {
        return Err("The Stop request belongs to an older Claude turn; the current turn was preserved.".into());
    }
    let pending = state.starts.cancel(&thread_id, expected_turn_id.as_deref(), expected_start_request_id.as_deref())?;
    drop(turns);
    if let Some(turn) = turn {
        turn.shutdown().await?;
        remove_claude_turn_if_current(&state.turns, &thread_id, &turn).await;
    }
    await_native_start_settlement(pending.clone()).await?;
    // An attempt may have registered its process after our first snapshot.
    // Settlement is not cutoff proof: inspect only that exact late owner.
    if let Some(pending) = pending {
        let late = state.turns.lock().await.get(&thread_id).cloned()
            .filter(|turn| turn.turn_id == pending.turn_id);
        if let Some(turn) = late {
            turn.shutdown().await?;
            remove_claude_turn_if_current(&state.turns, &thread_id, &turn).await;
        }
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
        .is_some_and(|turn| turn.alive.load(Ordering::Acquire) || turn.cutoff_uncertain.load(Ordering::Acquire)))
}

/// The exact turn's recorded terminal event, if its process already ended.
/// Health reconciliation delivers it through the normal event handler, which
/// still applies its own retired-turn and Stop guards.
#[tauri::command]
async fn claude_turn_terminal_receipt(
    state: State<'_, ClaudeState>,
    thread_id: String,
    turn_id: String,
) -> Result<Option<Value>, String> {
    Ok(state
        .terminal_receipts
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .get(&thread_id, &turn_id))
}

/// The renderer handled this exact turn's terminal event (or retired it), so
/// its receipt is no longer needed for reconciliation.
#[tauri::command]
async fn claude_turn_terminal_receipt_ack(
    state: State<'_, ClaudeState>,
    thread_id: String,
    turn_id: String,
) -> Result<(), String> {
    state
        .terminal_receipts
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .remove(&thread_id, &turn_id);
    Ok(())
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
    let response = json!({
        "type": "control_response",
        "response": {
            "subtype": "success",
            "request_id": &request_id,
            "response": result,
        }
    });
    write_claude_control_response(
        &turn.control_response,
        &turn.control_requests,
        &request_id,
        || turn.write(&response),
    )
    .await
}

/// Answer a Claude control request Mythra Code does not implement with an error
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
    let response = json!({
        "type": "control_response",
        "response": {
            "subtype": "error",
            "request_id": &request_id,
            "error": message,
        }
    });
    write_claude_control_response(
        &turn.control_response,
        &turn.control_requests,
        &request_id,
        || turn.write(&response),
    )
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
        // One commit (one WAL sync) for the append and its prune.
        let transaction = connection
            .unchecked_transaction()
            .map_err(|error| format!("Could not append audit event: {error}"))?;
        transaction
            .execute(
                "INSERT INTO audit_events(created_at, kind, thread_id, payload) VALUES (?1, ?2, ?3, ?4)",
                params![unix_timestamp_ms(), kind, thread_id, json],
            )
            .map_err(|error| format!("Could not append audit event: {error}"))?;
        // A failed prune still keeps the appended event, as before.
        let pruned = persistence::prune_audit_events(&transaction);
        transaction
            .commit()
            .map_err(|error| format!("Could not append audit event: {error}"))?;
        pruned.map_err(|error| format!("Could not prune audit history: {error}"))?;
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

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct ProcessMemorySnapshot {
    host_resident_bytes: Option<u64>,
    managed_process_tree_resident_bytes: Option<u64>,
    managed_process_count: usize,
    app_server_resident_bytes: Option<u64>,
    sampled_age_ms: u64,
    cached: bool,
}

#[derive(Clone, Copy)]
struct ProcessMemoryRow {
    pid: u32,
    parent: Option<u32>,
    resident_bytes: u64,
    start_time: u64,
}

#[derive(Default)]
struct ProcessMemoryCache {
    app_server_pid: Option<u32>,
    sampled_at: Option<Instant>,
    snapshot: Option<ProcessMemorySnapshot>,
}

const PROCESS_MEMORY_CACHE_TTL: Duration = Duration::from_secs(5);

/// Summarize only processes Mythra Code can attribute by parentage. WebView
/// helpers re-parented by the OS are intentionally excluded rather than
/// presenting an unreliable machine-wide total as application memory.
fn summarize_process_memory(
    processes: &[ProcessMemoryRow],
    host_pid: u32,
    app_server_pid: Option<u32>,
) -> ProcessMemorySnapshot {
    let start_times = processes
        .iter()
        .map(|process| (process.pid, process.start_time))
        .collect::<HashMap<_, _>>();
    // A child can retain a stale parent PID after the host exits. Require the
    // host itself in this enumeration before attributing any descendants.
    let mut managed = HashSet::new();
    if start_times.contains_key(&host_pid) {
        managed.insert(host_pid);
    }
    loop {
        let before = managed.len();
        for process in processes {
            if process.parent.is_some_and(|parent| {
                if !managed.contains(&parent) {
                    return false;
                }
                let parent_start = start_times.get(&parent).copied().unwrap_or(0);
                parent_start == 0 || process.start_time == 0 || parent_start <= process.start_time
            }) {
                managed.insert(process.pid);
            }
        }
        if managed.len() == before {
            break;
        }
    }
    let managed_rows = processes
        .iter()
        .filter(|process| managed.contains(&process.pid))
        .collect::<Vec<_>>();
    ProcessMemorySnapshot {
        host_resident_bytes: processes
            .iter()
            .find_map(|process| (process.pid == host_pid).then_some(process.resident_bytes)),
        managed_process_tree_resident_bytes: (!managed_rows.is_empty()).then(|| {
            managed_rows
                .iter()
                .map(|process| process.resident_bytes)
                .sum()
        }),
        managed_process_count: managed_rows.len(),
        app_server_resident_bytes: app_server_pid.and_then(|target| {
            processes
                .iter()
                .filter(|process| managed.contains(&process.pid))
                .find_map(|process| (process.pid == target).then_some(process.resident_bytes))
        }),
        sampled_age_ms: 0,
        cached: false,
    }
}

async fn collect_process_memory_snapshot(
    app_server_pid: Option<u32>,
) -> Result<ProcessMemorySnapshot, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut system = System::new();
        system.refresh_processes_specifics(
            ProcessesToUpdate::All,
            true,
            ProcessRefreshKind::nothing().with_memory(),
        );
        let processes = system
            .processes()
            .iter()
            .map(|(pid, process)| ProcessMemoryRow {
                pid: pid.as_u32(),
                parent: process.parent().map(|parent| parent.as_u32()),
                resident_bytes: process.memory(),
                start_time: process.start_time(),
            })
            .collect::<Vec<_>>();
        Ok(summarize_process_memory(
            &processes,
            std::process::id(),
            app_server_pid,
        ))
    })
    .await
    .map_err(|error| format!("Process memory snapshot task failed: {error}"))?
}

async fn cached_process_memory_snapshot(
    state: &RuntimeState,
) -> Result<ProcessMemorySnapshot, String> {
    let app_server_pid = server_identity(&state.server_identity).map(|identity| identity.pid);
    let mut cache = state.process_memory.lock().await;
    if cache.app_server_pid == app_server_pid {
        if let (Some(sampled_at), Some(snapshot)) = (cache.sampled_at, &cache.snapshot) {
            let age = sampled_at.elapsed();
            if age <= PROCESS_MEMORY_CACHE_TTL {
                let mut snapshot = snapshot.clone();
                snapshot.sampled_age_ms = age.as_millis().min(u128::from(u64::MAX)) as u64;
                snapshot.cached = true;
                return Ok(snapshot);
            }
        }
    }
    let snapshot = collect_process_memory_snapshot(app_server_pid).await?;
    cache.app_server_pid = app_server_pid;
    cache.sampled_at = Some(Instant::now());
    cache.snapshot = Some(snapshot.clone());
    Ok(snapshot)
}

#[tauri::command]
async fn performance_snapshot(
    state: State<'_, RuntimeState>,
) -> Result<ProcessMemorySnapshot, String> {
    cached_process_memory_snapshot(&state).await
}

async fn read_diagnostics(app: &AppHandle, state: &RuntimeState) -> Result<Value, String> {
    let runtime = read_codex_runtime_status(app, state).await;
    let process_memory = cached_process_memory_snapshot(state).await.ok();
    let database = state_db_path(app)?;
    let shared_connection = shared_state_db(app)?;
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
        "processMemory": process_memory,
        "auditEvents": audit,
    }))
}

#[tauri::command]
async fn diagnostics_read(app: AppHandle, state: State<'_, RuntimeState>) -> Result<Value, String> {
    read_diagnostics(&app, &state).await
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
    let home = crate::release_qa::home_dir(app)
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
async fn diagnostics_export(
    app: AppHandle,
    state: State<'_, RuntimeState>,
    path: String,
) -> Result<(), String> {
    let destination = validated_export_path(&app, &path)?;
    let diagnostics = read_diagnostics(&app, &state).await?;
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
    let app_data = crate::release_qa::app_data_dir(&app)
        .map_err(|error| format!("Could not resolve Mythra Code app data: {error}"))?;
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
    if let Some(runtime) = git_runtime_path(env::var_os("PATH").as_deref(), home) {
        for directory in env::split_paths(&runtime) {
            add(directory);
        }
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

fn resolved_server_request_id(message: &Value) -> Option<String> {
    if message["method"] != "serverRequest/resolved" {
        return None;
    }
    let id = &message["params"]["requestId"];
    (id.is_string() || id.is_number()).then(|| id.to_string())
}

fn initialize_params() -> Value {
    json!({
        "clientInfo": {
            "name": "mythra-code",
            "title": "Mythra Code",
            "version": env!("CARGO_PKG_VERSION")
        },
        "capabilities": {
            "experimentalApi": true,
            "requestAttestation": false,
            "mcpServerOpenaiFormElicitation": true
        }
    })
}

fn is_codex_delta_notification(message: &Value) -> bool {
    message.get("id").is_none()
        && message
            .get("method")
            .and_then(Value::as_str)
            .is_some_and(|method| method.ends_with("Delta") || method.ends_with("/delta"))
}

const CODEX_DELTA_MAX_BATCH_SIZE: usize = 128;

fn codex_delta_batch_due(batch_len: usize, deadline: Instant, now: Instant) -> bool {
    batch_len >= CODEX_DELTA_MAX_BATCH_SIZE || now >= deadline
}

/// How long provider readers coalesce high-frequency deltas before emitting.
const PROVIDER_DELTA_FLUSH_INTERVAL: Duration = Duration::from_millis(25);
/// Raw provider output, in bytes, at which a coalesced delta batch is flushed.
/// This is a flush threshold, not a payload limit: the event that crosses it
/// is kept in the batch, one event can be larger than it, and the emitted JSON
/// adds wrapper overhead. Events are never split, reordered, or dropped.
const PROVIDER_DELTA_MAX_BATCH_BYTES: usize = 256 * 1024;

fn provider_delta_batch_due(
    batch_len: usize,
    batch_bytes: usize,
    deadline: Instant,
    now: Instant,
) -> bool {
    codex_delta_batch_due(batch_len, deadline, now) || batch_bytes >= PROVIDER_DELTA_MAX_BATCH_BYTES
}

/// Deltas waiting to be emitted as one array event, in arrival order.
#[derive(Default)]
struct ProviderDeltaBatch {
    events: Vec<Value>,
    bytes: usize,
    deadline: Option<Instant>,
}

impl ProviderDeltaBatch {
    /// Append one delta and report whether the batch must be emitted now: its
    /// deadline passed, or it reached the event count or byte threshold. The
    /// check runs after every append because a reader whose next line is
    /// already buffered never observes its flush deadline expiring.
    fn push(&mut self, event: Value, line_bytes: usize, now: Instant) -> bool {
        let deadline = *self
            .deadline
            .get_or_insert(now + PROVIDER_DELTA_FLUSH_INTERVAL);
        self.events.push(event);
        self.bytes = self.bytes.saturating_add(line_bytes);
        provider_delta_batch_due(self.events.len(), self.bytes, deadline, now)
    }

    /// The pending flush deadline; `None` exactly when nothing is buffered.
    fn deadline(&self) -> Option<Instant> {
        self.deadline
    }

    fn take(&mut self) -> Option<Value> {
        self.deadline = None;
        self.bytes = 0;
        (!self.events.is_empty()).then(|| Value::Array(std::mem::take(&mut self.events)))
    }
}

/// How often a provider reader checks its direct child independently of the
/// output pipes, which a descendant can inherit and hold open.
const PROVIDER_EXIT_POLL_INTERVAL: Duration = Duration::from_millis(250);
/// After the direct child exits, output it already wrote (often its final
/// response) is still read for at most this long. A descendant holding the
/// pipe open, silently or while writing, cannot extend the transport's life.
const PROVIDER_EXIT_DRAIN: Duration = Duration::from_secs(2);

/// Resolves once the direct child has exited. Each check takes the child lock
/// only if it is free and only for a non-blocking `try_wait`, so the watcher
/// never queues ahead of, or holds the lock against, a kill path. If the child
/// cannot be inspected this never resolves, leaving EOF as the only end of the
/// transport exactly as before the watcher existed.
async fn direct_child_exit(child: Arc<Mutex<Child>>) {
    loop {
        // Never queue for the lock. Tokio's mutex is fair: a queued acquisition
        // is granted the lock when its holder releases it, before it is polled
        // again. A reader polls this watcher only while it waits for output, so
        // a grant that arrives while it handles a line, or after its transport
        // closed, would hold the lock unpolled and wedge every kill and reap of
        // this child. A busy lock (a kill path owns the child) just means
        // checking again after the interval.
        let status = match child.try_lock() {
            Ok(mut child) => child.try_wait(),
            Err(_) => Ok(None),
        };
        match status {
            Ok(Some(_)) => return,
            Ok(None) => tokio::time::sleep(PROVIDER_EXIT_POLL_INTERVAL).await,
            Err(_) => return std::future::pending().await,
        }
    }
}

/// How long a provider's stderr reader may keep delivering output the process
/// already wrote once its transport has ended.
const PROVIDER_STDERR_DRAIN: Duration = Duration::from_secs(1);

/// Retire a stderr reader with its transport. A descendant can inherit stderr
/// and hold it open indefinitely, so after a short grace the reader is aborted
/// rather than left running detached.
async fn finish_stderr_reader(mut task: tauri::async_runtime::JoinHandle<()>) {
    if timeout(PROVIDER_STDERR_DRAIN, &mut task).await.is_err() {
        task.abort();
    }
}

enum ProviderRead {
    Line(String),
    /// The caller's coalescing deadline passed while no line was ready.
    FlushDue,
    /// EOF, a read error, or the bounded drain after the direct child exited.
    Closed,
}

/// Provider stdout lines whose end is the earlier of EOF and the direct
/// child's exit plus a bounded final drain.
struct ProviderOutput<R> {
    lines: tokio::io::Lines<R>,
    exit: std::pin::Pin<Box<dyn Future<Output = ()> + Send>>,
    drain_until: Option<Instant>,
}

impl<R: tokio::io::AsyncBufRead + Unpin> ProviderOutput<R> {
    fn new(reader: R, child: Arc<Mutex<Child>>) -> Self {
        Self {
            lines: reader.lines(),
            exit: Box::pin(direct_child_exit(child)),
            drain_until: None,
        }
    }

    async fn next_line(&mut self, flush_at: Option<Instant>) -> ProviderRead {
        enum Wake {
            Line(std::io::Result<Option<String>>),
            Exited,
            Timer,
        }
        loop {
            if self
                .drain_until
                .is_some_and(|until| Instant::now() >= until)
            {
                return self.close();
            }
            let wake_at = match (flush_at, self.drain_until) {
                (Some(flush), Some(drain)) => Some(flush.min(drain)),
                (flush, drain) => flush.or(drain),
            };
            let watching_exit = self.drain_until.is_none();
            // The exit watcher is polled first: output that is always ready
            // would otherwise win every race and starve it, so a descendant
            // could keep the transport alive. Once the exit is seen, buffered
            // output is still read until the drain deadline. `Lines::next_line`
            // is cancellation safe, so losing a race cannot drop a partial line.
            let wake = tokio::select! {
                biased;
                () = &mut self.exit, if watching_exit => Wake::Exited,
                line = self.lines.next_line() => Wake::Line(line),
                () = tokio::time::sleep_until(wake_at.unwrap_or_else(Instant::now)), if wake_at.is_some() => Wake::Timer,
            };
            match wake {
                Wake::Line(Ok(Some(line))) => return ProviderRead::Line(line),
                Wake::Line(_) => return self.close(),
                Wake::Exited => self.drain_until = Some(Instant::now() + PROVIDER_EXIT_DRAIN),
                Wake::Timer => {
                    if flush_at.is_some_and(|flush| Instant::now() >= flush) {
                        return ProviderRead::FlushDue;
                    }
                }
            }
        }
    }

    /// End the transport and drop the exit watcher with it. Nothing polls the
    /// watcher after `Closed`, so it must not outlive this call holding (or
    /// waiting for) anything — callers go on to kill and reap the same child.
    fn close(&mut self) -> ProviderRead {
        self.exit = Box::pin(std::future::pending());
        ProviderRead::Closed
    }
}


// Only active assistant items are tracked; completion events discard their IDs.
#[derive(Default)]
struct CodexFirstAssistantDeltas {
    active_turns: HashMap<String, (Option<String>, HashSet<String>)>,
}

impl CodexFirstAssistantDeltas {
    fn observe(&mut self, message: &Value) -> bool {
        let Some(method) = message.get("method").and_then(Value::as_str) else {
            return false;
        };
        let params = &message["params"];
        let Some(thread_id) = params.get("threadId").and_then(Value::as_str) else {
            return false;
        };
        match method {
            "turn/started" => {
                let turn_id = params["turn"]["id"].as_str().map(str::to_owned);
                let active = self.active_turns.entry(thread_id.to_owned()).or_default();
                if active.0 != turn_id {
                    *active = (turn_id, HashSet::new());
                }
            }
            "turn/completed" => {
                let completed_id = params["turn"]["id"].as_str();
                if self.active_turns.get(thread_id).is_some_and(|active| {
                    completed_id.is_none() || active.0.as_deref() == completed_id
                }) {
                    self.active_turns.remove(thread_id);
                }
            }
            "item/completed" => {
                if let Some(item_id) = params["item"]["id"].as_str() {
                    if let Some(active) = self.active_turns.get_mut(thread_id) {
                        let completed_turn_id = params.get("turnId").and_then(Value::as_str);
                        if completed_turn_id.is_none() || active.0.as_deref() == completed_turn_id {
                            active.1.remove(item_id);
                        }
                    }
                }
            }
            "item/agentMessage/delta" if message.get("id").is_none() => {
                let Some(item_id) = params.get("itemId").and_then(Value::as_str) else {
                    return false;
                };
                if item_id.is_empty() || params["delta"].as_str().is_none_or(str::is_empty) {
                    return false;
                }
                let turn_id = params.get("turnId").and_then(Value::as_str);
                let active = self.active_turns.entry(thread_id.to_owned()).or_default();
                if let Some(turn_id) = turn_id {
                    match active.0.as_deref() {
                        Some(active_id) if active_id != turn_id => return false,
                        None => active.0 = Some(turn_id.to_owned()),
                        _ => {}
                    }
                }
                return active.1.insert(item_id.to_owned());
            }
            "thread/status/changed"
                if matches!(
                    params["status"]["type"].as_str(),
                    Some("idle" | "systemError")
                ) =>
            {
                self.active_turns.remove(thread_id);
            }
            _ => {}
        }
        false
    }
}

async fn spawn_server(app: &AppHandle, state: &RuntimeState, slot: &mut Option<Arc<AppServer>>) -> Result<Arc<AppServer>, String> {
    release_qa::require_providers()?;
    let app_data = crate::release_qa::app_data_dir(app)
        .map_err(|error| format!("Could not resolve app data directory: {error}"))?;
    let codex_home = app_data.join("codex-home");

    let codex_runtime = resolve_codex_runtime(app, state).await?;
    let codex_binary = codex_runtime.path.clone();
    let home = crate::release_qa::home_dir(app).ok();

    let mut command = background_command(&codex_binary);
    command
        .arg("app-server")
        .env("CODEX_HOME", &codex_home)
        .env_remove("OPENAI_API_KEY")
        .env_remove("CODEX_API_KEY")
        .env_remove("OPENAI_ACCESS_TOKEN")
        .env_remove("OPENAI_BASE_URL")
        .env_remove("OPENAI_ORG_ID")
        .env_remove("OPENAI_PROJECT_ID")
        .env_remove("AZURE_OPENAI_API_KEY")
        .env_remove("AZURE_OPENAI_ENDPOINT")
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
    // Neither optional provider may hold up the shared Codex runtime forever.
    // Fetch both concurrently so a stalled Keychain read adds at most one
    // bounded delay to Skills, Run checks, and other providers.
    let (openrouter_api_key, lmstudio_api_key) = tokio::join!(openrouter_key(), lmstudio_key());
    if let Some(key) = openrouter_api_key {
        let (proxy_url, task) = start_openrouter_proxy(key.clone(), app.clone()).await?;
        command.env("OPENROUTER_API_KEY", key);
        openrouter_proxy_url = Some(proxy_url);
        openrouter_proxy_task = Some(task);
    }
    // LM Studio accepts the conventional `lm-studio` placeholder when local
    // authentication is disabled. If the user enabled API tokens, the real
    // token lives only in Keychain and this child-process environment.
    command.env(
        "LMSTUDIO_API_KEY",
        lmstudio_api_key.unwrap_or_else(|| "lm-studio".into()),
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

    // The recorded version must describe the binary about to start.
    // Keychain, proxy and config work ran since discovery; refuse a file
    // that changed in that window while no child exists to clean up.
    if executable_identity(&codex_binary).await != codex_runtime.identity {
        if let Some(task) = &openrouter_proxy_task {
            task.abort();
        }
        *state.codex_runtime.lock().await = None;
        return Err("Codex changed while Mythra Code was starting it. Try again.".to_string());
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
    // Publish the child's identity before anything else can fail or wait.
    // `ensure_server` holds the async server lock for the whole
    // spawn/initialize window, so this slot is what lets a quit during a
    // hung handshake still tear the process tree down.
    let pid = child.id();
    let identity = pid.map(managed_identity_for);
    publish_server_identity(&state.server_identity, identity);
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
            clear_server_identity(&state.server_identity, identity);
            return Err("Codex App Server did not expose stdin".to_string());
        }
    };
    let stdout = match child.stdout.take() {
        Some(stdout) => stdout,
        None => {
            abort_proxy(&openrouter_proxy_task);
            let _ = child.start_kill();
            clear_server_identity(&state.server_identity, identity);
            return Err("Codex App Server did not expose stdout".to_string());
        }
    };
    let stderr = child.stderr.take();
    let identity_slot_for_reader = state.server_identity.clone();
    let child = Arc::new(Mutex::new(child));
    let child_for_reader = child.clone();
    let pending: PendingMap = Arc::new(Mutex::new(HashMap::new()));
    let pending_for_reader = pending.clone();
    let app_for_reader = app.clone();
    let alive = Arc::new(AtomicBool::new(true));
    let alive_for_reader = alive.clone();
    let cutoff = Arc::new(RuntimeCutoffState::default());
    let cutoff_for_reader = cutoff.clone();
    let server_requests: Arc<Mutex<HashMap<String, CodexServerRequestIdentity>>> =
        Arc::new(Mutex::new(HashMap::new()));
    let server_requests_for_reader = server_requests.clone();
    let loaded_threads = Arc::new(RwLock::new(HashSet::<String>::new()));
    let loaded_threads_for_reader = loaded_threads.clone();
    let lifecycle_for_reader = state.lifecycle.clone();
    let instance = uuid::Uuid::new_v4().to_string();
    let instance_for_reader = instance.clone();
    state.lifecycle.begin_instance(&instance);

    // The stdout reader owns this task: stderr keeps reporting while the
    // transport is active and is retired with it, even when a descendant holds
    // the inherited pipe open.
    let stderr_task = stderr.map(|stderr| {
        let app_for_stderr = app.clone();
        let instance_for_stderr = instance.clone();
        tauri::async_runtime::spawn(async move {
            // Chatty runtimes (RUST_LOG, MCP servers) can write hundreds of
            // stderr lines a second. Coalesce them like stdout deltas: a burst
            // goes out as one ordered "codex-events" array within 25 ms. The
            // 1 s retirement drain outlasts that, so no buffered line is lost.
            let mut lines = BufReader::new(stderr).lines();
            let mut pending: Vec<Value> = Vec::new();
            let mut flush_at: Option<Instant> = None;
            let flush = |pending: &mut Vec<Value>| match pending.len() {
                0 => {}
                1 => {
                    let _ = app_for_stderr.emit("codex-event", pending.pop());
                }
                _ => {
                    let _ = app_for_stderr.emit("codex-events", std::mem::take(pending));
                }
            };
            loop {
                let read = match flush_at {
                    Some(at) => match timeout_at(at, lines.next_line()).await {
                        Ok(read) => read,
                        Err(_) => {
                            flush(&mut pending);
                            flush_at = None;
                            continue;
                        }
                    },
                    None => lines.next_line().await,
                };
                let Ok(Some(line)) = read else {
                    break;
                };
                pending.push(json!({ "stream": "stderr", "line": line, "runtimeInstance": instance_for_stderr }));
                let now = Instant::now();
                let due = *flush_at.get_or_insert(now + PROVIDER_DELTA_FLUSH_INTERVAL);
                if pending.len() >= 128 || now >= due {
                    flush(&mut pending);
                    flush_at = None;
                }
            }
            flush(&mut pending);
        })
    });

    tauri::async_runtime::spawn(async move {
        // A descendant can inherit stdout and hold it open after the direct
        // app-server exits. Watching the child ends the transport anyway, so
        // pending requests fail and the next request starts a replacement.
        // App-server lines are JSON messages that often exceed the default
        // 8 KB buffer (diffs, command output); read them in fewer syscalls.
        let mut output = ProviderOutput::new(BufReader::with_capacity(64 * 1024, stdout), child_for_reader.clone());
        // The first assistant chunk is emitted immediately so the UI can lock
        // steering; subsequent deltas are coalesced into "codex-events" until
        // the deadline, batch size, or a non-delta message requires a flush.
        let mut delta_buffer = ProviderDeltaBatch::default();
        let mut first_assistant_deltas = CodexFirstAssistantDeltas::default();
        let flush_deltas = |buffer: &mut ProviderDeltaBatch, app: &AppHandle| {
            if let Some(batch) = buffer.take() {
                let _ = app.emit("codex-events", batch);
            }
        };

        loop {
            let line = match output.next_line(delta_buffer.deadline()).await {
                ProviderRead::Line(line) => line,
                ProviderRead::FlushDue => {
                    flush_deltas(&mut delta_buffer, &app_for_reader);
                    continue;
                }
                ProviderRead::Closed => break,
            };

            let Ok(mut message) = serde_json::from_str::<Value>(&line) else {
                flush_deltas(&mut delta_buffer, &app_for_reader);
                let _ = app_for_reader.emit(
                    "codex-event",
                    json!({ "stream": "stderr", "line": format!("Invalid app-server message: {line}"), "runtimeInstance": instance_for_reader }),
                );
                continue;
            };
            lifecycle_for_reader.observe_server_message(&instance_for_reader, &message);
            if let Some(thread_id) = message["params"]["threadId"].as_str() {
                // Nearly every line names an already-known thread: check under
                // the shared read lock before taking the write lock.
                let known = loaded_threads_for_reader.read().unwrap_or_else(std::sync::PoisonError::into_inner).contains(thread_id);
                if !known {
                    loaded_threads_for_reader.write().unwrap_or_else(std::sync::PoisonError::into_inner).insert(thread_id.to_owned());
                }
            }
            if let Some(object) = message.as_object_mut() {
                object.insert("runtimeInstance".into(), json!(instance_for_reader));
            }

            let is_response = message.get("id").is_some()
                && (message.get("result").is_some() || message.get("error").is_some());
            if is_response {
                flush_deltas(&mut delta_buffer, &app_for_reader);
                if let Some(id) = message.get("id").and_then(Value::as_i64) {
                    {
                        let mut lifecycle = lifecycle_for_reader.lock();
                        if lifecycle.instance.as_deref() == Some(&instance_for_reader)
                            && lifecycle.active_command_requests.remove(&id) {
                            lifecycle.active_commands = lifecycle.active_commands.saturating_sub(1);
                        }
                    }
                    if let Some(sender) = pending_for_reader.lock().await.remove(&id) {
                        let result = if let Some(error) = message.get("error") {
                            Err(provider_error_text(error
                                .get("message")
                                .and_then(Value::as_str)
                                .unwrap_or("Unknown Codex App Server error")))
                        } else {
                            Ok(message.get("result").cloned().unwrap_or(Value::Null))
                        };
                        let _ = sender.send(result);
                    }
                }
            } else {
                let is_delta_notification = is_codex_delta_notification(&message);
                let emit_first_assistant_delta = first_assistant_deltas.observe(&message);
                if is_delta_notification {
                    if emit_first_assistant_delta {
                        flush_deltas(&mut delta_buffer, &app_for_reader);
                        let _ = app_for_reader.emit("codex-event", message);
                        continue;
                    }
                    // Ready lines can keep winning the deadline race during a
                    // continuous stream, so the flush thresholds are checked here too.
                    if delta_buffer.push(message, line.len(), Instant::now()) {
                        flush_deltas(&mut delta_buffer, &app_for_reader);
                    }
                } else {
                    flush_deltas(&mut delta_buffer, &app_for_reader);
                    // Expiry and turn completion invalidate nonblocking input
                    // requests too. Reject stale UI responses before writing
                    // them to a runtime that would silently ignore them.
                    if let Some(id) = resolved_server_request_id(&message) {
                        server_requests_for_reader.lock().await.remove(&id);
                    }
                    if message.get("id").is_some() && message.get("method").is_some() {
                        // A server-initiated request: record its id (before
                        // emitting) so codex_respond can verify the response
                        // targets this exact server instance.
                        if let (Some(id), Some(identity)) =
                            (message.get("id"), codex_server_request_identity(&message))
                        {
                            server_requests_for_reader
                                .lock()
                                .await
                                .insert(id.to_string(), identity);
                        }
                    }
                    let _ = app_for_reader.emit("codex-event", message);
                }
            }
        }
        flush_deltas(&mut delta_buffer, &app_for_reader);

        alive_for_reader.store(false, Ordering::Release);
        let mut dead_threads = loaded_threads_for_reader.read().unwrap_or_else(std::sync::PoisonError::into_inner).clone();
        {
            let lifecycle = lifecycle_for_reader.lock();
            if lifecycle.instance.as_deref() == Some(&instance_for_reader) {
                dead_threads.extend(lifecycle.active_turns.iter().cloned());
                dead_threads.extend(lifecycle.active_native_agents.iter().cloned());
                dead_threads.extend(lifecycle.starting_turns.iter().cloned());
            }
        }
        let mut pending = pending_for_reader.lock().await;
        for (_, sender) in pending.drain() {
            let _ = sender.send(Err("MYTHRA_DELIVERY_UNCERTAIN: Codex App Server connection closed before a protocol acknowledgement.".into()));
        }
        let _ = app_for_reader.emit(
            "codex-event",
            json!({ "stream": "stderr", "line": "Codex App Server connection closed", "runtimeInstance": instance_for_reader }),
        );
        drop(pending);

        // EOF is transport evidence. Only a confirmed exit/cutoff authorizes
        // the renderer to settle this instance's owned work.
        let cutoff_confirmed = cutoff_runtime_child(&child_for_reader, &cutoff_for_reader).await.is_ok();
        let _ = app_for_reader.emit("codex-runtime", json!({ "alive": false, "instance": instance_for_reader,
            "runtimeInstance": instance_for_reader, "threadIds": dead_threads, "cutoffConfirmed": cutoff_confirmed }));
        // The pid is free for reuse from here on, so it must no longer be
        // published as ours.
        if cutoff_confirmed {
            clear_server_identity(&identity_slot_for_reader, identity);
            lifecycle_for_reader.clear_instance(&instance_for_reader);
        }
        if let Some(stderr_task) = stderr_task {
            finish_stderr_reader(stderr_task).await;
        }
    });

    let server = Arc::new(AppServer {
        app: app.clone(),
        stdin: Mutex::new(stdin),
        child,
        identity,
        identity_slot: state.server_identity.clone(),
        instance,
        runtime_path: codex_runtime.path,
        runtime_version: codex_runtime.version,
        lifecycle: state.lifecycle.clone(),
        pending,
        next_id: AtomicI64::new(1),
        alive,
        cutoff,
        server_requests,
        loaded_threads,
        thread_providers: RwLock::new(HashMap::new()),
        openrouter_proxy_url,
        openrouter_proxy_task,
    });

    // Keep the retryable native handle even if initialization fails and its
    // cleanup cannot establish that the process tree stopped.
    *slot = Some(server.clone());

    if let Err(error) = server.request("initialize", initialize_params()).await {
        server.shutdown().await.map_err(|cutoff| format!("{error}. Runtime startup cleanup remains uncertain: {cutoff}"))?;
        *slot = None;
        return Err(error);
    }
    if let Err(error) = server.notify("initialized", json!({})).await {
        server.shutdown().await.map_err(|cutoff| format!("{error}. Runtime startup cleanup remains uncertain: {cutoff}"))?;
        *slot = None;
        return Err(error);
    }
    let _ = app.emit("codex-runtime", json!({ "alive": true, "instance": server.instance, "runtimeInstance": server.instance }));
    Ok(server)
}

async fn ensure_server(app: &AppHandle, state: &RuntimeState) -> Result<Arc<AppServer>, String> {
    let mut guard = state.server.lock().await;
    // Serialize replacement behind successful cutoff. The old handle stays
    // in this slot if cleanup is uncertain, so another call can retry it.
    while let Some(server) = guard.as_ref().cloned() {
        if server.is_alive() {
            return Ok(server.clone());
        }
        server.shutdown().await.map_err(|error| format!("The previous Codex runtime cutoff is unconfirmed; replacement was refused: {error}"))?;
        *guard = None;
    }

    // The child's identity was published by spawn_server before initialize,
    // so the exit handler could already reach it during that window.
    let server = spawn_server(app, state, &mut *guard).await?;
    *guard = Some(server.clone());
    Ok(server)
}

async fn shutdown_current_runtime(state: &RuntimeState) -> Result<(), String> {
    let mut slot = state.server.lock().await;
    if let Some(server) = slot.as_ref().cloned() {
        server.shutdown().await?;
        *slot = None;
    }
    Ok(())
}

/// Check the replacement before stopping a healthy app-server. A broken
/// official selection, an executable without a recognizable version, or an
/// older installation leaves the running server in place. An explicit
/// MYTHRA_CODE_CODEX_PATH is the user's own choice and may change versions.
async fn preflight_runtime_replacement(app: &AppHandle, state: &RuntimeState) -> Result<(), String> {
    // Resolve, releasing the discovery cache lock, before reading the server
    // slot: spawning holds the slot and then takes the cache lock.
    let replacement = resolve_codex_runtime(app, state).await;
    let running = state
        .server
        .lock()
        .await
        .as_ref()
        .filter(|server| server.is_alive())
        .map(|server| (server.runtime_path.clone(), server.runtime_version.clone()));
    let Some((running_path, running_version)) = running else {
        // Nothing healthy to preserve; startup reports its own failure.
        return replacement.map(|_| ());
    };
    let running_display =
        normalized_runtime_version(&running_version).unwrap_or_else(|| running_version.clone());
    let replacement = replacement
        .map_err(|error| format!("Mythra Code kept the running Codex {running_display}. {error}"))?;
    if codex_runtime_override().is_some()
        || !codex_runtime_changed(&replacement.path, &replacement.version, &running_path, &running_version)
    {
        return Ok(());
    }
    let Some(replacement_version) = normalized_runtime_version(&replacement.version) else {
        return Err(format!(
            "Mythra Code kept the running Codex {running_display}. The installation at {} didn't report a recognizable Codex version.",
            replacement.path.display()
        ));
    };
    if codex_installed_older(&replacement.version, &running_version) {
        return Err(format!(
            "The selected Codex installation ({replacement_version}) is older than the running Codex {running_display}, so Mythra Code kept the running version. Update Codex in Settings › Updates, or restart Mythra Code to use the older installation deliberately."
        ));
    }
    Ok(())
}

async fn replace_current_runtime(app: &AppHandle, state: &RuntimeState) -> Result<(), String> {
    preflight_runtime_replacement(app, state).await?;
    shutdown_current_runtime(state).await?;
    ensure_server(app, state).await.map(|_| ())
}

/// Must hold provider admission and the lifecycle auth reservation. Retire
/// the old identity before changing billing/credentials. Preflight failure
/// leaves both untouched; cutoff failure forbids replacement/startup.
async fn retire_codex_for_auth_change(app: &AppHandle, state: &RuntimeState) -> Result<(), String> {
    preflight_runtime_replacement(app, state).await?;
    shutdown_current_runtime(state).await
}

/// Signs Mythra Code's private Codex profile in with an OpenAI API key
/// through the documented app-server login, which replaces a ChatGPT
/// sign-in in that profile. The old process is retired first under the same
/// reservation, so starts pinned to its identity cannot use the new billing.
async fn codex_login_with_api_key(app: &AppHandle, state: &RuntimeState, api_key: String) -> Result<(), String> {
    let _switch = state.lifecycle.begin_auth_switch()?;
    retire_codex_for_auth_change(app, state).await?;
    let server = ensure_server(app, state).await?;
    // Codex errors are not relayed: nothing derived from the request,
    // including the key, may reach the renderer.
    let result = server
        .request("account/login/start", json!({ "type": "apiKey", "apiKey": api_key }))
        .await
        .map_err(|_| "Codex did not accept the OpenAI API key sign-in. Check the key, then try again.".to_string())?;
    if result.get("type").and_then(Value::as_str) != Some("apiKey") {
        return Err("Codex did not confirm the OpenAI API key sign-in. Refresh Models & accounts to check its state.".into());
    }
    // This fresh process has no thread prepared under the retired billing.
    Ok(())
}

/// Signs Codex out if it is using an API key, so a key removed from Mythra
/// Code cannot keep billing. A ChatGPT sign-in is left alone. The returned
/// notice reports a sign-out state that could not be confirmed.
async fn codex_sign_out_api_key(app: &AppHandle, state: &RuntimeState, replacing: bool) -> Result<Option<String>, String> {
    // Saving a replacement key and removing a key both sign a previous key out
    // first; say which action was refused so the user retries the right one.
    let kept = if replacing { "so the new key wasn't saved" } else { "so the key was kept" };
    let retry = if replacing { "save the key again" } else { "remove the key again" };
    async fn uses_api_key(server: &AppServer) -> Result<bool, String> {
        let account = server.request("account/read", json!({ "refreshToken": false })).await?;
        Ok(account.pointer("/account/type").and_then(Value::as_str) == Some("apiKey"))
    }
    let _switch = state.lifecycle.begin_auth_switch()?;
    // A never-created private profile cannot hold a Codex credential. This
    // lets users remove a saved, never-connected key before installing Codex.
    let home = crate::release_qa::app_data_dir(app)
        .map_err(|_| format!("Could not inspect Codex's private profile, {kept}."))?.join("codex-home");
    if !home.try_exists().map_err(|_| format!("Could not inspect Codex's private profile, {kept}."))? {
        return Ok(None);
    }
    let running = state.server.lock().await.as_ref().filter(|server| server.is_alive()).cloned();
    let server = match running {
        Some(server) => server,
        None => match ensure_server(app, state).await {
            Ok(server) => server,
            Err(_) => return Err(format!("Codex couldn't confirm it stopped using the previous key, {kept}. Start or repair Codex, then {retry}.")),
        },
    };
    if !uses_api_key(&server).await.map_err(|_| format!("Mythra Code couldn't read Codex's sign-in, {kept}. Try again."))? {
        return Ok(None);
    }
    retire_codex_for_auth_change(app, state).await?;
    let server = ensure_server(app, state).await?;
    if uses_api_key(&server).await.map_err(|_| format!("Mythra Code couldn't read Codex's sign-in, {kept}. Try again."))? {
        server
            .request("account/logout", json!({}))
            .await
            .map_err(|_| format!("Codex did not sign out of the previous OpenAI API key, {kept}. Try again."))?;
    }
    Ok(None)
}

/// ChatGPT sign-in and sign-out. Re-signing in (or to another workspace) or
/// signing out of a ChatGPT profile does not change the billing method, so it
/// keeps the current session until the browser flow replaces it, as before
/// API keys. A profile still holding an API key is retired first and signed
/// out before the browser opens, so it cannot bill while the switch is pending.
/// Both paths reserve the lifecycle before reading the account: an unchanged
/// billing method must not allow sign-in/out underneath active work, and an
/// idle snapshot alone would leave a race with a command starting afterward.
async fn codex_subscription_auth(app: &AppHandle, state: &RuntimeState, method: &str, params: Value) -> Result<Value, String> {
    let _switch = state.lifecycle.begin_auth_switch()?;
    let server = ensure_server(app, state).await?;
    let account = server.request("account/read", json!({ "refreshToken": false })).await?;
    if account.pointer("/account/type").and_then(Value::as_str) != Some("apiKey") {
        return server.request(method, params).await;
    }
    retire_codex_for_auth_change(app, state).await?;
    let server = ensure_server(app, state).await?;
    if method == "account/login/start" {
        server.request("account/logout", json!({})).await?;
    }
    server.request(method, params).await
}

/// Validate the high-impact RPCs that the webview is allowed to forward.
/// The Codex app-server normally enforces its own approval policy for agent
/// turns, but Mythra Code also exposes a user-operated terminal and workflows via
/// `command/exec`, and every agent turn re-sends its sandbox on `turn/start`.
/// Requiring an explicit, bounded sandbox policy on both keeps a malformed
/// renderer request from silently omitting the sandbox or widening a
/// workspace-write request beyond its workspace (except for the shared Git
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
    }
    if matches!(method, "command/exec" | "turn/start") {
        validate_sandbox_policy(method, params)?;
    }
    if matches!(method, "thread/start" | "thread/resume" | "thread/fork") {
        // The thread-level mode is a plain string; the renderer only ever
        // sends one of Codex's three modes, so anything else is malformed.
        if let Some(sandbox) = params.get("sandbox") {
            if !sandbox.as_str().is_some_and(|mode| {
                matches!(mode, "read-only" | "workspace-write" | "danger-full-access")
            }) {
                return Err(format!("{method} received an unknown sandbox mode"));
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
                "Mythra Code only permits MCP server settings through the desktop bridge".into(),
            );
        }
    }
    Ok(())
}

/// `command/exec` and `turn/start` both carry a working directory and an
/// explicit `sandboxPolicy` object. A `workspaceWrite` policy must grant the
/// working directory itself and may only add roots inside it or the shared
/// Git directory of an isolated linked worktree.
fn validate_sandbox_policy(method: &str, params: &Value) -> Result<(), String> {
    let cwd = params
        .get("cwd")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("{method} requires a working directory"))?;
    let cwd = PathBuf::from(cwd)
        .canonicalize()
        .map_err(|error| format!("{method} working directory is unavailable: {error}"))?;
    if !cwd.is_dir() {
        return Err(format!("{method} working directory is not a folder"));
    }
    let sandbox = params
        .get("sandboxPolicy")
        .and_then(Value::as_object)
        .ok_or_else(|| format!("{method} requires an explicit sandbox policy"))?;
    let sandbox_type = sandbox
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if !matches!(
        sandbox_type,
        "readOnly" | "workspaceWrite" | "dangerFullAccess"
    ) {
        return Err(format!("{method} received an unknown sandbox policy"));
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
            let canonical = PathBuf::from(root)
                .canonicalize()
                .map_err(|error| format!("workspaceWrite root `{root}` is unavailable: {error}"))?;
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
    Ok(())
}

const MAX_THREAD_PREVIEW_CHARACTERS: usize = 320;

fn bound_thread_preview(thread: &mut Value) {
    let Some(preview) = thread.get("preview").and_then(Value::as_str) else {
        return;
    };
    let mut graphemes = UnicodeSegmentation::graphemes(preview, true);
    let bounded: String = graphemes
        .by_ref()
        .take(MAX_THREAD_PREVIEW_CHARACTERS)
        .collect();
    if graphemes.next().is_none() {
        return;
    }
    if let Some(value) = thread.get_mut("preview") {
        *value = Value::String(bounded);
    }
}

/// App-server previews repeat the first user prompt. They are useful for one
/// sidebar line but can otherwise duplicate many kilobytes across IPC before
/// paginated history delivers the canonical message.
fn bound_thread_previews(method: &str, result: &mut Value) {
    match method {
        "thread/list" => {
            if let Some(threads) = result.get_mut("data").and_then(Value::as_array_mut) {
                for thread in threads {
                    bound_thread_preview(thread);
                }
            }
        }
        "thread/search" => {
            if let Some(matches) = result.get_mut("data").and_then(Value::as_array_mut) {
                for matched in matches {
                    if let Some(thread) = matched.get_mut("thread") {
                        bound_thread_preview(thread);
                    }
                    // Mythra Code uses search only to discover matching thread
                    // IDs; the potentially large full-text excerpt is not
                    // rendered or retained by the client.
                    if let Some(object) = matched.as_object_mut() {
                        object.remove("snippet");
                    }
                }
            }
        }
        "thread/start" | "thread/resume" | "thread/read" | "thread/fork" => {
            if let Some(thread) = result.get_mut("thread") {
                bound_thread_preview(thread);
            }
        }
        _ => {}
    }
}

#[tauri::command]
async fn codex_rpc(
    app: AppHandle,
    state: State<'_, RuntimeState>,
    method: String,
    mut params: Value,
) -> Result<Value, String> {
    let expected_instance = params.as_object_mut().and_then(|object| object.remove("expectedRuntimeInstance"))
        .filter(|value| !value.is_null()).map(|value| value.as_str().map(str::to_owned)
            .ok_or_else(|| "MYTHRA_NOT_DISPATCHED: Invalid expected runtime identity.".to_string())).transpose()?;
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
        "thread/turns/list",
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
        "thread/turns/list",
        "thread/search",
        "skills/list",
        "mcpServerStatus/list",
        "gitDiffToRemote",
        "fs/readFile",
        "fs/readDirectory",
        "fuzzyFileSearch",
    ];
    if !ALLOWED_METHODS.contains(&method.as_str()) {
        return Err(native_predispatch_refusal(format!(
            "Mythra Code's desktop bridge does not allow the RPC method `{method}`"
        )));
    }
    let auth_change = matches!(method.as_str(), "account/login/start" | "account/logout");
    let _billing_change = if auth_change {
        Some(provider_auth::begin_change(&app, provider_auth::ApiKeyProvider::Openai).await.map_err(native_predispatch_refusal)?)
    } else { None };
    // Only requests that dispatch model work bill the selected method. Reads,
    // terminal commands and listing must not hold (or be refused by) billing
    // and credential changes; the runtime lifecycle already refuses a switch
    // while turns, commands or requests are active.
    let billed = matches!(method.as_str(),
        "thread/start" | "thread/resume" | "thread/fork" | "turn/start" | "turn/steer" | "review/start" | "thread/compact/start");
    let _billing_admission = if billed {
        Some(provider_auth::begin_use(&app, provider_auth::ApiKeyProvider::Openai).map_err(native_predispatch_refusal)?)
    } else { None };
    if method == "account/rateLimits/read"
        && provider_auth::openai_billing(&app).map_err(native_predispatch_refusal)? != provider_auth::ClaudeBilling::Subscription {
        return Err(native_predispatch_refusal("API key billing has no ChatGPT subscription quota. View API spend in the provider dashboard.".into()));
    }
    if method == "account/login/start" {
        if provider_auth::openai_billing(&app).map_err(native_predispatch_refusal)? != provider_auth::ClaudeBilling::Subscription {
            return Err(native_predispatch_refusal("Choose Subscription for OpenAI in Models & accounts before signing in with ChatGPT. Mythra Code never changes billing automatically.".into()));
        }
        // API keys reach Codex only natively, from the OS credential store,
        // so a key never travels through the renderer bridge or its audit.
        let login = params.get("type").and_then(Value::as_str);
        if !matches!(login, Some("chatgpt" | "chatgptDeviceCode")) {
            return Err(native_predispatch_refusal(
                "Add an OpenAI API key in Settings › Models & accounts.".to_string(),
            ));
        }
    }
    if matches!(method.as_str(), "account/login/start" | "account/logout") {
        return codex_subscription_auth(&app, &state, &method, params).await;
    }
    normal_chat::annotate_codex(&app, &method, &mut params).map_err(native_predispatch_refusal)?;
    enforce_codex_delegation_config(&method, &mut params).map_err(native_predispatch_refusal)?;
    validate_rpc_params(&method, &params).map_err(native_predispatch_refusal)?;
    validate_native_codex_bridges(&app.state::<ChildAgentState>(), &method, &params).await.map_err(native_predispatch_refusal)?;
    // Register before `ensure_server` so a read cannot spawn a process in the
    // gap after a reserved restart has taken the old server out of the slot.
    let _rpc_guard = state.lifecycle.begin_rpc_call(&method).map_err(native_predispatch_refusal)?;
    let server = ensure_server(&app, &state).await?;
    if expected_instance.as_deref().is_some_and(|expected| expected != server.instance) {
        return Err("MYTHRA_NOT_DISPATCHED: The Codex runtime changed before this action was dispatched. Read the conversation's runtime state again.".into());
    }
    validate_native_codex_runtime(&method, &params, &server.runtime_version).map_err(native_predispatch_refusal)?;
    // Use native thread metadata, not a renderer-supplied billing hint. This
    // also covers compaction/review and direct tool-invoked turn requests.
    if matches!(method.as_str(), "thread/start" | "thread/resume" | "thread/fork" | "turn/start" | "review/start" | "thread/compact/start") {
        let explicit = params.get("modelProvider").and_then(Value::as_str)
            .or_else(|| params.pointer("/config/model_provider").and_then(Value::as_str));
        let provider = if matches!(method.as_str(), "thread/start" | "thread/resume" | "thread/fork") && explicit.is_some() {
            explicit.unwrap().to_owned()
        } else if let Some(id) = params.get("threadId").and_then(Value::as_str) {
            let cached = server.thread_providers.read().unwrap_or_else(std::sync::PoisonError::into_inner).get(id).cloned();
            if let Some(provider) = cached { provider } else {
                let thread = server.request("thread/read", json!({ "threadId": id, "includeTurns": false })).await
                    .map_err(native_predispatch_refusal)?;
                thread.pointer("/thread/modelProvider").and_then(Value::as_str)
                    .ok_or_else(|| native_predispatch_refusal("Could not verify this thread's provider. Reopen the thread before sending.".into()))?.to_owned()
            }
        } else { "openai".to_owned() };
        // Only the destinations Mythra Code configures itself bill elsewhere.
        // Any other provider name, including a custom one defined through
        // `config`, may use Codex's OpenAI credential, so it is checked too.
        if !matches!(provider.as_str(), "openrouter" | "lmstudio" | "lmstudio_openkiwi" | "openkiwi-lmstudio") {
            let account = server.request("account/read", json!({ "refreshToken": false })).await.map_err(native_predispatch_refusal)?;
            provider_auth::assert_openai_account(&app, &account).map_err(native_predispatch_refusal)?;
        }
    }
    if requests_native_codex(&method, &params) {
        let cwd = params.get("cwd").and_then(Value::as_str).filter(|cwd| !cwd.is_empty())
            .ok_or_else(|| native_predispatch_refusal("Native Codex startup requires its working directory to verify inherited bridges.".to_string()))?;
        // One read from this existing process, only for native startup. Never
        // bootstrap another client or retry a failed safety inspection.
        let effective = server.request("config/read", json!({ "cwd": cwd, "includeLayers": false })).await
            .map_err(|_| "Could not verify inherited Mythra Code bridges. The native thread was not started; retry after the Codex runtime is available.".to_string())?;
        let bridge_params = native_codex_effective_bridge_params(&params, &effective["config"]).map_err(native_predispatch_refusal)?;
        validate_native_codex_bridges(&app.state::<ChildAgentState>(), &method, &bridge_params).await.map_err(native_predispatch_refusal)?;
    }
    if matches!(
        method.as_str(),
        "thread/start" | "thread/resume" | "thread/fork"
    ) {
        inject_openrouter_proxy_config(&mut params, server.openrouter_proxy_url.as_deref());
    }
    // Only a retryable read can be re-sent, so only it keeps a copy (turn and
    // config payloads can be large).
    let retryable = RETRYABLE_METHODS.contains(&method.as_str());
    let retry_params = retryable.then(|| params.clone());
    let result = match server.request(&method, params).await {
        Ok(result) => Ok(result),
        Err(error) if !server.is_alive() => {
            // ensure_server retains the old native slot until successful
            // cutoff; transport failure alone never authorizes replacement.
            let recovered = ensure_server(&app, &state).await.map_err(|restart_error| {
                format!("{error}. Mythra Code also could not restart the runtime: {restart_error}")
            })?;
            if let Some(params) = retry_params {
                validate_native_codex_runtime(&method, &params, &recovered.runtime_version)?;
                recovered.request(&method, params).await
            } else {
                Err(format!(
                    "{error}. The runtime was restarted; retry the action if it did not complete."
                ))
            }
        }
        Err(error) => Err(error),
    };
    result.map(|mut value| {
        if method == "account/read" {
            value["billing"] = serde_json::to_value(provider_auth::openai_billing(&app).ok()).unwrap_or(Value::Null);
        }
        if method == "account/read" && provider_auth::assert_openai_account(&app, &value).is_err() {
            // A credential for the unselected billing method isn't usable.
            // Keep the actual credential private to Codex, but never report
            // it as connected or allow it to satisfy renderer readiness.
            value["account"] = Value::Null;
        }
        bound_thread_previews(&method, &mut value);
        value
    })
}

#[tauri::command]
async fn codex_respond(
    state: State<'_, RuntimeState>,
    id: Value,
    result: Value,
    expected: Option<CodexServerRequestIdentity>,
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
    let response_guard =
        state
            .lifecycle
            .begin_activity(&server.instance, "serverRequest/respond", None)?;
    {
        let mut requests = server.server_requests.lock().await;
        consume_codex_server_request(&mut requests, &id, expected.as_ref())?;
    }
    let response = server.respond(id, result).await;
    if let Some(response_guard) = response_guard {
        response_guard.finish(response.is_ok(), response.is_err());
    }
    response
}

#[tauri::command]
async fn save_openrouter_key(
    app: AppHandle,
    state: State<'_, RuntimeState>,
    api_key: String,
) -> Result<(), String> {
    let _restart_guard = state.lifecycle.begin_generic_restart()?;
    let trimmed = api_key.trim().to_string();
    let saved_key = (!trimmed.is_empty()).then(|| trimmed.clone());
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

    let published = publish_saved_key(&OPENROUTER_KEY_READ, saved_key);

    let restarted = replace_current_runtime(&app, &state).await;
    clear_saved_key_after_restart(&OPENROUTER_KEY_READ, &published);
    restarted
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
    let _restart_guard = state.lifecycle.begin_generic_restart()?;
    let trimmed = api_key.trim().to_string();
    let saved_key = (!trimmed.is_empty()).then(|| trimmed.clone());
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

    let published = publish_saved_key(&LMSTUDIO_KEY_READ, saved_key);

    let restarted = replace_current_runtime(&app, &state).await;
    clear_saved_key_after_restart(&LMSTUDIO_KEY_READ, &published);
    restarted
}

#[tauri::command]
async fn has_lmstudio_key() -> bool {
    lmstudio_key().await.is_some()
}

const OPENROUTER_MODELS_URL: &str = "https://openrouter.ai/api/v1/models";
const OPENROUTER_USER_MODELS_URL: &str = "https://openrouter.ai/api/v1/models/user";
const OPENROUTER_CREDITS_URL: &str = "https://openrouter.ai/api/v1/credits";
const OPENROUTER_KEY_URL: &str = "https://openrouter.ai/api/v1/key";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct OpenRouterCreditBalance {
    remaining: f64,
    used: Option<f64>,
    source: &'static str,
}

fn finite_json_number(value: Option<&Value>) -> Option<f64> {
    value
        .and_then(Value::as_f64)
        .filter(|number| number.is_finite())
}

fn parse_openrouter_account_credits(value: &Value) -> Option<OpenRouterCreditBalance> {
    let total = finite_json_number(value.pointer("/data/total_credits"))?;
    let used = finite_json_number(value.pointer("/data/total_usage"))?;
    Some(OpenRouterCreditBalance {
        remaining: (total - used).max(0.0),
        used: Some(used.max(0.0)),
        source: "account",
    })
}

fn parse_openrouter_key_limit(value: &Value) -> Option<OpenRouterCreditBalance> {
    Some(OpenRouterCreditBalance {
        remaining: finite_json_number(value.pointer("/data/limit_remaining"))?.max(0.0),
        used: finite_json_number(value.pointer("/data/usage")).map(|used| used.max(0.0)),
        source: "keyLimit",
    })
}

fn openrouter_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|error| format!("Could not create the OpenRouter catalog client: {error}"))
}

async fn openrouter_get(client: &reqwest::Client, url: &str) -> reqwest::RequestBuilder {
    let request = client.get(url).header("X-Title", "Mythra Code");
    match openrouter_key().await {
        Some(key) => request.bearer_auth(key),
        None => request,
    }
}

/// OpenRouter's account-credit endpoint requires a management-capable key.
/// Ordinary inference keys can still expose their own remaining spend limit,
/// so use that as an explicitly identified fallback instead of inventing an
/// account balance from Mythra Code's local cost estimates.
#[tauri::command]
async fn openrouter_credits() -> Result<OpenRouterCreditBalance, String> {
    let key = openrouter_key()
        .await
        .ok_or_else(|| "Add an OpenRouter API key to view credits.".to_string())?;
    let client = openrouter_client()?;

    if let Ok(response) = client
        .get(OPENROUTER_CREDITS_URL)
        .header("X-Title", "Mythra Code")
        .bearer_auth(&key)
        .send()
        .await
    {
        if response.status().is_success() {
            if let Ok(value) = response.json::<Value>().await {
                if let Some(balance) = parse_openrouter_account_credits(&value) {
                    return Ok(balance);
                }
            }
        }
    }

    let response = client
        .get(OPENROUTER_KEY_URL)
        .header("X-Title", "Mythra Code")
        .bearer_auth(key)
        .send()
        .await
        .map_err(|error| format!("Could not reach OpenRouter usage: {error}"))?
        .error_for_status()
        .map_err(|error| format!("OpenRouter rejected the usage request: {error}"))?;
    let value = response
        .json::<Value>()
        .await
        .map_err(|error| format!("Could not read OpenRouter usage: {error}"))?;
    parse_openrouter_key_limit(&value).ok_or_else(|| {
        "This OpenRouter API key does not expose an account balance or spending limit.".into()
    })
}

fn openrouter_tool_models(mut catalog: Value) -> Value {
    if let Some(models) = catalog.get_mut("data").and_then(Value::as_array_mut) {
        models.retain(|model| {
            model
                .get("supported_parameters")
                .and_then(Value::as_array)
                .is_some_and(|parameters| {
                    parameters
                        .iter()
                        .any(|value| value.as_str() == Some("tools"))
                })
        });
    }
    catalog
}

/// Reads every model available under the user's OpenRouter preferences,
/// privacy settings, and guardrails. Omitting both `offset` and `limit` from
/// `/models/user` explicitly requests the complete list, so local search can
/// never miss an entry beyond an arbitrary page boundary. Older or restricted
/// keys fall back to the complete public tool-capable catalog.
#[tauri::command]
async fn list_openrouter_models() -> Result<Value, String> {
    let client = openrouter_client()?;
    if let Some(key) = openrouter_key().await {
        let response = client
            .get(OPENROUTER_USER_MODELS_URL)
            .header("X-Title", "Mythra Code")
            .bearer_auth(key)
            .send()
            .await
            .map_err(|error| {
                format!("Could not reach the OpenRouter account model catalog: {error}")
            })?;
        if let Ok(response) = response.error_for_status() {
            let catalog = response.json::<Value>().await.map_err(|error| {
                format!("Could not read the OpenRouter account model catalog: {error}")
            })?;
            return Ok(openrouter_tool_models(catalog));
        }
    }

    let mut url = reqwest::Url::parse(OPENROUTER_MODELS_URL)
        .map_err(|error| format!("Could not build the OpenRouter catalog request: {error}"))?;
    url.query_pairs_mut()
        .append_pair("supported_parameters", "tools");
    openrouter_get(&client, url.as_str())
        .await
        .send()
        .await
        .map_err(|error| format!("Could not reach the OpenRouter model catalog: {error}"))?
        .error_for_status()
        .map_err(|error| format!("OpenRouter rejected the model catalog request: {error}"))?
        .json::<Value>()
        .await
        .map_err(|error| format!("Could not read the OpenRouter model catalog: {error}"))
}

/// Resolves one `author/slug` directly.
///
/// The catalog filter and the `q` search can both come up empty for a model the
/// account can still route to, so a typed slug gets its own lookup rather than
/// being rejected as unknown.
/// Catalog path for an `author/slug`, rejecting anything that could climb out
/// of `/api/v1/models/`. Variant suffixes such as `:free` are routing options
/// rather than catalog paths, so they are dropped before the lookup.
fn openrouter_model_path(slug: &str) -> Result<String, String> {
    let invalid = || "Enter a complete provider/model slug.".to_string();
    let slug = slug.trim();
    if slug.is_empty() || slug.starts_with('/') || !slug.contains('/') {
        return Err(invalid());
    }
    let path = slug.split(':').next().unwrap_or(slug);
    let segments: Vec<&str> = path.split('/').collect();
    if segments.len() < 2
        || segments
            .iter()
            .any(|segment| segment.is_empty() || *segment == "." || *segment == "..")
    {
        return Err(invalid());
    }
    Ok(path.to_string())
}

#[tauri::command]
async fn openrouter_model(slug: String) -> Result<Value, String> {
    let path = openrouter_model_path(&slug)?;
    let path = path.as_str();
    let slug = slug.trim();
    let client = openrouter_client()?;
    let mut url = reqwest::Url::parse(OPENROUTER_MODELS_URL)
        .map_err(|error| format!("Could not build the OpenRouter model request: {error}"))?;
    {
        let mut segments = url
            .path_segments_mut()
            .map_err(|_| "Could not build the OpenRouter model request.".to_string())?;
        for segment in path.split('/') {
            segments.push(segment);
        }
        segments.push("endpoints");
    }
    let response = openrouter_get(&client, url.as_str())
        .await
        .send()
        .await
        .map_err(|error| format!("Could not reach OpenRouter: {error}"))?;
    if response.status() == reqwest::StatusCode::NOT_FOUND {
        return Err(format!("OpenRouter does not know the model {slug}."));
    }
    response
        .error_for_status()
        .map_err(|error| format!("OpenRouter rejected the model lookup: {error}"))?
        .json::<Value>()
        .await
        .map_err(|error| format!("Could not read the OpenRouter model: {error}"))
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
        .map_err(|error| {
            format!("Could not reach LM Studio. Start its local server and check the URL: {error}")
        })?
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
    let _rpc_guard = state.lifecycle.begin_rpc_call("thread/read")?;
    Ok(ensure_server(&app, &state).await?.instance.clone())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeThreadState {
    instance: String,
    loaded: bool,
}

/// Whether this exact managed app-server process is already holding a thread.
/// `thread/read` deliberately does not count: it reads durable history without
/// installing startup-only configuration into the live runtime.
#[tauri::command]
async fn runtime_thread_state(
    app: AppHandle,
    state: State<'_, RuntimeState>,
    thread_id: String,
) -> Result<RuntimeThreadState, String> {
    if thread_id.trim().is_empty() || thread_id.len() > 256 {
        return Err("A runtime thread identity is required.".into());
    }
    let _rpc_guard = state.lifecycle.begin_rpc_call("thread/read")?;
    let server = ensure_server(&app, &state).await?;
    Ok(RuntimeThreadState {
        instance: server.instance.clone(),
        loaded: server.has_loaded_thread(&thread_id),
    })
}

#[tauri::command]
async fn restart_runtime(app: AppHandle, state: State<'_, RuntimeState>) -> Result<(), String> {
    // Serialize ordinary capability/provider restarts with the tokenized
    // model-refresh restart, and gate new mutation RPCs during replacement.
    let _restart_guard = state.lifecycle.begin_generic_restart()?;
    replace_current_runtime(&app, &state).await
}

#[tauri::command]
fn reserve_runtime_restart(state: State<'_, RuntimeState>) -> Result<RuntimeRestartReservation, String> {
    state.lifecycle.reserve_restart()
}

#[tauri::command]
fn release_runtime_restart(state: State<'_, RuntimeState>, token: String) {
    state.lifecycle.release_restart(&token);
}

#[tauri::command]
async fn restart_runtime_reserved(
    app: AppHandle,
    state: State<'_, RuntimeState>,
    token: String,
) -> Result<(), String> {
    state.lifecycle.validate_restart(&token)?;
    let _reservation_guard = RuntimeRestartGuard {
        lifecycle: state.lifecycle.clone(),
        token,
    };
    replace_current_runtime(&app, &state).await
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
                matches!(timeout(Duration::from_secs(2), server.shutdown()).await, Ok(Ok(())))
            });
            if !graceful {
                // Last resort: signal the tree by identity without touching
                // locks. The check inside refuses a pid the OS has reused.
                if let Some(identity) = server.identity {
                    kill_managed_process_tree(identity);
                }
            }
        }
        Ok(None) => {}
        Err(()) => {
            // `ensure_server` can hold the server lock for the whole
            // spawn/initialize window (up to ~2 minutes). Fall back to the
            // identity spawn_server published before initialize so the
            // child's process tree is still torn down instead of orphaned.
            if let Some(identity) = server_identity(&state.server_identity) {
                kill_managed_process_tree(identity);
                clear_server_identity(&state.server_identity, Some(identity));
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
            matches!(timeout(Duration::from_secs(1), turn.shutdown()).await, Ok(Ok(())))
        });
        if !stopped {
            if let Ok(mut child) = turn.child.try_lock() {
                if matches!(child.try_wait(), Ok(None)) {
                    if let Some(pid) = child.id() { let _ = kill_process_tree(pid); }
                }
            }
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    if let Err(error) = release_qa::initialize() {
        eprintln!("mythra.release-qa rejected: {error}");
        std::process::exit(78);
    }
    // reqwest and the updater share the same provider-less rustls stack.
    // Install Ring before either subsystem creates its first HTTP client.
    let _ = rustls::crypto::ring::default_provider().install_default();

    // Re-invoked as the cross-provider sub-agent bridge: act as a stdio MCP
    // server and exit without ever constructing the desktop app.
    let mut arguments = env::args().skip(1);
    let first_argument = arguments.next();
    let qa_dispose_only = first_argument.as_deref() == Some(release_qa::DISPOSE_ARG);
    if qa_dispose_only && !release_qa::active() {
        eprintln!("mythra.release-qa disposal requires an explicit owned QA profile");
        std::process::exit(78);
    }
    if first_argument.as_deref() == Some(AGENT_BRIDGE_ARG) {
        if release_qa::require_providers().is_err() {
            std::process::exit(78);
        }
        let session = arguments.next().unwrap_or_default();
        std::process::exit(run_agent_bridge(&session));
    }

    // WebKit reads its spell-checking state once, when the first webview is
    // created, so this has to run before any window exists.
    #[cfg(target_os = "macos")]
    spelling::register_webkit_spelling_defaults();

    // Tauri's automatic window construction and returned setup errors panic
    // inside the event loop. Keep the original merged configuration intact
    // for explicit construction, disabling only automatic creation in this
    // context copy (including the Windows-specific updater configuration).
    let mut context = tauri::generate_context!();
    release_qa::configure_context(&mut context);
    let startup_windows = context.config().app.windows.clone();
    for window in &mut context.config_mut().app.windows {
        window.create = false;
    }

    let application = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_process::init())
        .setup(move |app| {
            // Never propagate these returned failures to Tauri's setup panic.
            // The asynchronous native dialog owns explicit acknowledgment.
            #[cfg(desktop)]
            if app
                .handle()
                .plugin(tauri_plugin_updater::Builder::new().build())
                .is_err()
            {
                startup_guard::setup_failed(app.handle(), "updater");
                return Ok(());
            }
            if qa_dispose_only {
                release_qa::dispose_owned_store(app.handle());
                return Ok(());
            }
            let db_path = match state_db_path(app.handle()) {
                Ok(path) => path,
                Err(_) => {
                    startup_guard::setup_failed(app.handle(), "database-path");
                    return Ok(());
                }
            };
            let connection = match open_state_db_or_quarantine(&db_path) {
                Ok(connection) => connection,
                Err(_) => {
                    startup_guard::setup_failed(app.handle(), "database-open");
                    return Ok(());
                }
            };
            app.manage(StateDb {
                connection: Arc::new(std::sync::Mutex::new(connection)),
                reader: persistence::open_state_db_reader(&db_path)
                    .map(|reader| Arc::new(std::sync::Mutex::new(reader))),
            });
            // Bridge session material is only meaningful while its backend is
            // listening, so anything on disk at startup is debris from a
            // previous run and must not outlive it.
            purge_stale_agent_bridges(app.handle());
            for window_config in startup_windows.iter().filter(|window| window.create) {
                let builder =
                    match tauri::WebviewWindowBuilder::from_config(app.handle(), window_config) {
                        Ok(builder) => builder,
                        Err(_) => {
                            startup_guard::setup_failed(app.handle(), "window-config");
                            return Ok(());
                        }
                    };
                let builder = release_qa::configure_window(builder);
                #[cfg(target_os = "macos")]
                let builder = {
                    let Some(mtm) = objc2::MainThreadMarker::new() else {
                        startup_guard::setup_failed(app.handle(), "window-main-thread");
                        return Ok(());
                    };
                    builder.with_webview_configuration(macos_text::configuration(
                        mtm,
                        !release_qa::active() && window_config.incognito,
                        release_qa::webview_store_identifier()
                            .or(window_config.data_store_identifier),
                    ))
                };
                let prepared = (window_config.label == "main")
                    .then(|| startup_guard::prepare(app.handle(), &window_config.label))
                    .flatten();
                let window = match builder.build() {
                    Ok(window) => window,
                    Err(_) => {
                        if let Some(prepared) = prepared {
                            startup_guard::cancel_prepared(app.handle(), prepared);
                        }
                        startup_guard::setup_failed(app.handle(), "window-create");
                        return Ok(());
                    }
                };
                if window.label() == "main" {
                    close_guard::install(&window);
                    if let Some(prepared) = prepared {
                        startup_guard::install(&window, prepared);
                    }
                }
            }
            release_qa::install_control(app.handle());
            Ok(())
        })
        .manage(RuntimeState::default())
        .manage(ClaudeState::default())
        .manage(CursorState::default())
        .manage(ChildAgentState::default())
        .manage(RunDiscoveryState::default())
        .manage(preference_learning::PreferenceLearningState::default())
        .manage(tray::TrayState::default())
        .manage(CloseGuardState::default())
        .manage(StartupGuardState::default())
        .manage(transcription::TranscriptionState::default())
        .manage(provider_auth::ProviderAuthState::default())
        .invoke_handler({
            let handler: Box<dyn Fn(tauri::ipc::Invoke) -> bool + Send + Sync> =
                Box::new(tauri::generate_handler![
                    spelling::spelling_suggestions,
                    file_preview::preview_project_file,
                    release_qa::release_qa_renderer_probe,
                    close_guard_claim,
                    close_guard_finish,
                    startup_ready,
                    startup_failed,
                    codex_runtime_status,
                    codex_runtime_status_refresh,
                    reserve_runtime_restart,
                    release_runtime_restart,
                    restart_runtime_reserved,
                    developer_runtime_updates,
                    developer_runtime_update,
                    claude_runtime_status,
                    claude_models,
                    claude_usage,
                    claude_login,
                    claude_login_cancel,
                    cursor_runtime_status,
                    cursor_login,
                    cursor_models,
                    pricing_sources::fetch_pricing_document,
                    github_status,
                    github_login,
                    github_repo_status,
                    github_attach_remote,
                    github_create_repository,
                    github_clone_repository,
                    git_workspace_snapshot,
                    git_project_changes,
                    git_project_diff,
                    git_project_file_diff,
                    git_project_history,
                    git_workspace_stage,
                    git_workspace_revert_preview,
                    git_workspace_revert,
                    git_workspace_revert_all_preview,
                    git_workspace_revert_all,
                    git_workspace_commit,
                    git_workspace_push,
                    git_workspace_pull,
                    git_workspace_branch,
                    git_workspace_fetch,
                    git_workspace_update,
                    git_publish_snapshot,
                    git_publish_commit,
                    github_pr_context,
                    github_pr_view,
                    github_pr_find,
                    github_pr_list,
                    github_pr_create,
                    github_pr_merge,
                    github_pr_branch,
                    github_pr_ready,
                    claude_turn_start,
                    claude_turn_steer,
                    claude_turn_interrupt,
                    claude_turn_kill,
                    claude_turn_active,
                    claude_turn_terminal_receipt,
                    claude_turn_terminal_receipt_ack,
                    claude_permission_respond,
                    claude_control_error,
                    cursor_turn_start,
                    cursor_turn_steer,
                    cursor_turn_interrupt,
                    cursor_turn_kill,
                    cursor_turn_active,
                    cursor_turn_state,
                    cursor_permission_respond,
                    state_read,
                    state_read_raw,
                    state_write,
                    state_delete,
                    local_transcript_list,
                    local_transcript_page_read,
                    local_transcript_full_read,
                    local_transcript_snapshot_write,
                    local_transcript_write_state_read,
                    local_transcript_tail_write,
                    local_transcript_metadata_write,
                    local_transcript_rename,
                    checkpoint_create,
                    checkpoint_complete,
                    checkpoint_diff,
                    checkpoint_restore,
                    checkpoint_delete,
                    workspace_git_info,
                    workspace_git_initialize,
                    workspace_git_auto_initialize,
                    worktree_create,
                    worktree_recreate,
                    worktree_status,
                    worktree_apply_to_source,
                    worktree_set_applied_baseline,
                    worktree_merge_branch,
                    worktree_remove,
                    audit_append,
                    audit_recent,
                    performance_snapshot,
                    diagnostics_read,
                    diagnostics_export,
                    export_text_file,
                    local_skills_scan,
                    local_skills_catalog,
                    local_skills_install_official,
                    local_skills_sync,
                    local_skills_import,
                    local_skills_create,
                    local_skills_read,
                    instruction_files::instruction_files_discover_globals,
                    instruction_files::instruction_files_read_global,
                    instruction_files::instruction_files_read_project,
                    instruction_files::instruction_files_save_global,
                    local_skills_mention_names,
                    local_skills_analyze_prompts,
                    local_skills_resolve_prompt,
                    local_skills_resolve_prompts,
                    local_skills_update,
                    local_skills_delete,
                    normal_chat_workspace,
                    workspace_folder::open_workspace_folder,
                    codex_rpc,
                    codex_respond,
                    save_openrouter_key,
                    save_lmstudio_key,
                    save_pasted_image,
                    prepare_image_preview,
                    persist_image_attachment,
                    has_openrouter_key,
                    openrouter_credits,
                    has_lmstudio_key,
                    list_openrouter_models,
                    openrouter_model,
                    list_lmstudio_models,
                    child_agent_session_start,
                    child_agent_session_end,
                    child_agent_revoke_root_registration,
                    child_agent_respond,
                    child_agent_finished,
                    child_agent_reactivate,
                    child_agent_request_active,
                    child_agent_claim_spawn,
                    child_agent_retire_unclaimed_spawns,
                    runtime_instance,
                    runtime_thread_state,
                    restart_runtime,
                    run_discovery_start,
                    run_discovery_cancel,
                    run_discovery::generate_thread_title,
                    run_discovery::analyze_user_preferences,
                    persistence::local_transcript_search,
                    tray::tray_configure,
                    tray::tray_status,
                    preference_learning::preference_learning_list,
                    preference_learning::preference_learning_save,
                    preference_learning::preference_learning_forget,
                    language_tools_snapshot,
                    language_tools_refresh,
                    language_tools_set_auto_install,
                    language_tools_install,
                    language_tools_set_enabled,
                    language_tools_prepare_project,
                    transcription::transcription_key_status,
                    provider_auth::provider_auth_status,
                    provider_auth::provider_api_key_save,
                    provider_auth::provider_api_key_remove,
                    provider_auth::openai_api_key_use,
                    provider_auth::claude_billing_set,
                    provider_auth::openai_billing_set,
                    transcription::transcription_save_key,
                    transcription::transcription_remove_key,
                    transcription::transcription_copy_openrouter_account_key,
                    transcription::transcription_models,
                    transcription::transcription_request_id,
                    transcription::transcription_transcribe,
                    transcription::transcription_cancel
                ]);
            move |invoke: tauri::ipc::Invoke| {
                if release_qa::active() {
                    if let Some(value) = release_qa::offline_status(invoke.message.command()) {
                        invoke.resolver.resolve(value);
                        return true;
                    }
                    if !release_qa::allowed_command(invoke.message.command()) {
                        invoke.resolver.reject(
                            "This action is unavailable in the credential-free release QA profile",
                        );
                        return true;
                    }
                }
                handler(invoke)
            }
        })
        .build(context);
    let application = match application {
        Ok(application) => application,
        Err(_) => {
            // No AppHandle exists here. Do not expose arbitrary native errors
            // or user paths, and do not add an untested platform dialog path.
            startup_guard::diagnostic("native-build", "build-failed", 0);
            std::process::exit(1);
        }
    };
    application.run(|app_handle, event| {
        // Menu Quit (including Cmd-Q) must use the same renderer flush as
        // the window close button. Once the last window is destroyed this
        // path is skipped and normal runtime shutdown proceeds. Preserve
        // nonzero exit codes, including the updater's restart request.
        if let tauri::RunEvent::ExitRequested {
            code: None | Some(0),
            api,
            ..
        } = &event
        {
            if let Some(window) = app_handle.get_webview_window("main") {
                if window.close().is_ok() {
                    api.prevent_exit();
                    return;
                }
            }
        }
        if release_qa::dispose_before_exit(app_handle, &event) {
            return;
        }
        if matches!(event, tauri::RunEvent::Exit) {
            release_qa::record("exit", json!({}));
        }
        if matches!(
            event,
            tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit
        ) {
            shutdown_runtime_on_exit(app_handle);
            shutdown_claude_on_exit(app_handle);
            shutdown_cursor_on_exit(app_handle);
            shutdown_agent_bridges_on_exit(app_handle);
            shutdown_run_discoveries_on_exit(app_handle);
        }
    });
}
