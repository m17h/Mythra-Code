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
mod official_skills;
mod openrouter_usage;
mod persistence;
mod preference_learning;
mod pricing_sources;
mod process_launch;
mod project_git;
mod release_qa;
mod run_discovery;
mod skills;
mod startup_guard;
mod workspace_folder;
#[cfg(test)]
use agents::{
    bridge_local_response, tokens_match, tool_catalog, validate_targets, validate_tool_call,
    ChildAgentTarget, AGENT_BRIDGE_SERVER, AGENT_BRIDGE_TOOLS,
};
use agents::{
    child_agent_bridge_config_allows_spawning, child_agent_bridge_config_registered,
    child_agent_finished, child_agent_respond, child_agent_session_end, child_agent_session_start,
    purge_stale_agent_bridges, run_agent_bridge, shutdown_agent_bridges_on_exit, ChildAgentState,
    AGENT_BRIDGE_ARG,
};
use close_guard::{close_guard_claim, close_guard_finish, CloseGuardState};
use cursor::{
    cursor_login, cursor_models, cursor_permission_respond, cursor_runtime_status,
    cursor_turn_active, cursor_turn_interrupt, cursor_turn_kill, cursor_turn_start,
    cursor_turn_steer, shutdown_cursor_on_exit, CursorState,
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
#[cfg(test)]
use github::{
    github_attach_remote_sync, github_repo_status_sync, parse_github_repository,
    validate_github_repository_name,
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
use process_launch::{background_command, background_std_command};
#[cfg(test)]
use project_git::*;
use project_git::{
    checkpoint_complete, checkpoint_create, checkpoint_delete, checkpoint_diff, checkpoint_restore,
    git_common_dir, git_runtime_path, git_stdout, optional_git_stdout, unix_timestamp_ms,
    workspace_git_info, workspace_git_initialize, worktree_apply_to_source, worktree_create,
    worktree_merge_branch, worktree_recreate, worktree_remove, worktree_set_applied_baseline,
    worktree_status,
};
use run_discovery::{
    run_discovery_cancel, run_discovery_start, shutdown_run_discoveries_on_exit, RunDiscoveryState,
};
#[cfg(test)]
use skills::*;
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

// The pipe lock and a blocked write must consume the same deadline as the
// response. A provider that stops reading must not wedge every later RPC.
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

struct AppServer {
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
    /// Server-initiated requests this exact instance is waiting on, keyed by
    /// protocol id. The stored identity lets question replies verify their
    /// thread/turn/item target if a restarted runtime reuses an id.
    server_requests: Arc<Mutex<HashMap<String, CodexServerRequestIdentity>>>,
    /// Threads successfully loaded into this exact app-server process. This
    /// avoids pessimistically restarting a fresh runtime merely because the
    /// renderer has no durable capability record for an older thread.
    loaded_threads: RwLock<HashSet<String>>,
    openrouter_proxy_url: Option<String>,
    openrouter_proxy_task: Option<tokio::task::JoinHandle<()>>,
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
    in_flight_activity_requests: usize,
    in_flight_rpcs: usize,
}

struct RuntimeRestartReservationState {
    token: String,
    expires_at: Instant,
    restarting: bool,
}

struct RuntimeActivityGuard {
    lifecycle: Arc<RuntimeLifecycle>,
    instance: String,
    method: String,
    thread_id: Option<String>,
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
        if state.restart_reservation.is_some() {
            return Err("The Codex runtime is refreshing its model catalog. Try this action again in a moment.".into());
        }
        if state.instance.as_deref() != Some(instance) {
            return Err("The Codex runtime is changing. Try this action again in a moment.".into());
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
        state.in_flight_activity_requests = 0;
    }

    fn clear_instance(&self, instance: &str) {
        let mut state = self.lock();
        if state.instance.as_deref() == Some(instance) {
            state.instance = None;
            state.active_turns.clear();
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
                state.settled_native_agents.remove(thread_id);
            }
            "turn/completed" => {
                state.active_turns.remove(thread_id);
                state.active_native_agents.remove(thread_id);
                state.ambiguous_native_activity.remove(thread_id);
                state.settled_native_agents.insert(thread_id.to_owned());
            }
            "thread/status/changed" if params["status"]["type"].as_str() == Some("active") => {
                state.active_turns.insert(thread_id.to_owned());
                state.settled_native_agents.remove(thread_id);
            }
            "thread/status/changed"
                if matches!(
                    params["status"]["type"].as_str(),
                    Some("idle" | "systemError")
                ) =>
            {
                state.active_turns.remove(thread_id);
                state.active_native_agents.remove(thread_id);
                state.ambiguous_native_activity.remove(thread_id);
                state.settled_native_agents.insert(thread_id.to_owned());
                state.active_compactions.remove(thread_id);
            }
            _ => {}
        }
    }

    fn reserve_restart(&self) -> Result<String, String> {
        let mut state = self.lock();
        Self::clear_expired_reservation(&mut state);
        if state.restart_reservation.is_some() {
            return Err("A Codex runtime refresh is already in progress.".into());
        }
        if !state.active_turns.is_empty()
            || !state.active_native_agents.is_empty()
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
        });
        Ok(token)
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
        let mut state = self.lock();
        Self::clear_expired_reservation(&mut state);
        if state.restart_reservation.is_some() {
            return Err("A Codex runtime refresh is already in progress.".into());
        }
        if !state.active_turns.is_empty()
            || !state.active_native_agents.is_empty()
            || !state.starting_turns.is_empty()
            || !state.active_compactions.is_empty()
            || !state.starting_compactions.is_empty()
            || state.active_commands > 0
            || state.in_flight_activity_requests > 0
            || state.in_flight_rpcs > 0
        {
            return Err("A Codex turn, command, or request is still active. Finish active work before restarting the runtime.".into());
        }
        let token = uuid::Uuid::new_v4().to_string();
        state.restart_reservation = Some(RuntimeRestartReservationState {
            token: token.clone(),
            expires_at: Instant::now() + Duration::from_secs(300),
            restarting: true,
        });
        Ok(RuntimeRestartGuard {
            lifecycle: self.clone(),
            token,
        })
    }
}

impl RuntimeActivityGuard {
    fn finish(mut self, succeeded: bool) {
        self.finished = true;
        self.update(succeeded);
    }

    fn update(&self, succeeded: bool) {
        let mut state = self.lifecycle.lock();
        if state.instance.as_deref() != Some(&self.instance) {
            return;
        }
        state.in_flight_activity_requests = state.in_flight_activity_requests.saturating_sub(1);
        if self.method == "command/exec" {
            state.active_commands = state.active_commands.saturating_sub(1);
        }
        if matches!(self.method.as_str(), "turn/start" | "review/start") {
            if let Some(thread_id) = &self.thread_id {
                state.starting_turns.remove(thread_id);
                if !succeeded {
                    state.active_turns.remove(thread_id);
                }
            }
        }
        if self.method == "thread/compact/start" {
            if let Some(thread_id) = &self.thread_id {
                state.starting_compactions.remove(thread_id);
                if !succeeded {
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
            self.update(false);
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
    /// `codex --version` during one cold launch.
    codex_runtime: Mutex<Option<ResolvedCodexRuntime>>,
    /// Identity of the live app-server child, published the moment it is
    /// spawned and cleared on every path that ends it. Unlike `server`, this
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
    kill_process_tree(identity.pid);
    true
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
    prompt_snapshot_support: Mutex<Option<ClaudePromptSnapshotSupport>>,
}

#[derive(Clone, PartialEq, Eq)]
struct ClaudeExecutableIdentity {
    path: PathBuf,
    target: Option<PathBuf>,
    metadata: Option<(u64, Option<SystemTime>)>,
    file_identity: Option<(u64, u64)>,
}

struct ClaudePromptSnapshotSupport {
    identity: ClaudeExecutableIdentity,
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
    fn reusable(&self, identity: &ClaudeExecutableIdentity, now: Instant) -> bool {
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
    stdin: Mutex<Option<ChildStdin>>,
    child: Arc<Mutex<Child>>,
    pid: Option<u32>,
    alive: Arc<AtomicBool>,
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
) -> Option<std::process::ExitStatus> {
    let mut sink = tokio::io::sink();
    let graceful = async {
        tokio::select! {
            exit = child.wait() => exit,
            _ = tokio::io::copy(stdout, &mut sink) => child.wait().await,
        }
    };
    match timeout(grace, graceful).await {
        Ok(exit) => exit.ok(),
        Err(_) => {
            if let Some(pid) = child.id() {
                kill_process_tree(pid);
            }
            let _ = child.kill().await;
            None
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
async fn write_claude_startup_input<R: tokio::io::AsyncBufRead + Unpin>(
    turn: &ClaudeTurn,
    messages: &[&Value],
    lines: &mut tokio::io::Lines<R>,
    deadline: Instant,
) -> Result<ClaudeEarlyOutput, String> {
    enum Progress {
        Written(Result<Result<(), String>, tokio::time::error::Elapsed>),
        Read(std::io::Result<Option<String>>),
    }
    let writes = timeout_at(deadline, async {
        for message in messages {
            turn.write(message).await?;
        }
        Ok::<(), String>(())
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
                return Err("Claude Code did not accept its input in time.".into())
            }
            Progress::Read(line) => {
                if let Ok(Some(text)) = &line {
                    early_bytes = early_bytes.saturating_add(text.len());
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
    message.get("type").and_then(Value::as_str) == Some("assistant")
        // A nested agent's final message ends that agent's turn, not the root
        // turn Mythra Code is waiting on.
        && message
            .get("parent_tool_use_id")
            .is_none_or(Value::is_null)
        && message
            .get("message")
            .and_then(|message| message.get("stop_reason"))
            .and_then(Value::as_str)
            == Some("end_turn")
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

    fn push_text(&mut self, text: &str) {
        self.text.push_str(text);
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
    running_path: Option<String>,
    data_home: Option<String>,
    version: Option<String>,
    running_version: Option<String>,
    running_commands: usize,
    runtime_changed: bool,
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
        let activity_guard = self.lifecycle.begin_activity(
            &self.instance,
            method,
            params.get("threadId").and_then(Value::as_str),
        )?;
        let result = async {
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

            let tracking_thread_id = params
                .get("threadId")
                .and_then(Value::as_str)
                .map(str::to_owned);
            let message = json!({ "method": method, "id": id, "params": params });
            let deadline = Instant::now() + request_timeout;
            if let Err(error) =
                write_server_message(&self.stdin, format!("{message}\n").as_bytes(), deadline).await
            {
                // A timed-out write may have sent a partial JSON line. Do not
                // reuse this stream for another request.
                self.alive.store(false, Ordering::Release);
                self.pending.lock().await.remove(&id);
                return Err(error);
            }

            match timeout_at(deadline, receiver).await {
                Ok(Ok(result)) => {
                    if let Ok(value) = &result {
                        self.track_successful_request(method, tracking_thread_id.as_deref(), value);
                    }
                    result
                }
                Ok(Err(_)) => Err("Codex App Server stopped before replying".into()),
                Err(_) => {
                    self.pending.lock().await.remove(&id);
                    Err(format!(
                        "Codex App Server timed out while handling {method}"
                    ))
                }
            }
        }
        .await;
        if let Some(activity_guard) = activity_guard {
            activity_guard.finish(result.is_ok());
        }
        result
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

    async fn shutdown(&self) {
        self.alive.store(false, Ordering::Release);
        // The reader may already have reaped the child, after which the OS
        // can reuse its pid; only signal the tree while it is still ours.
        if let Some(identity) = self.identity {
            kill_managed_process_tree(identity);
        }
        let _ = self.child.lock().await.kill().await;
        clear_server_identity(&self.identity_slot, self.identity);
        if let Some(task) = &self.openrouter_proxy_task {
            task.abort();
        }
        self.lifecycle.clear_instance(&self.instance);
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

#[cfg(test)]
mod keyring_read_tests {
    use super::*;

    static TEST_SHARED_READ: KeyringReadSlot = KeyringReadSlot(StdMutex::new(None));
    static TEST_STALLED_READ: KeyringReadSlot = KeyringReadSlot(StdMutex::new(None));
    static TEST_INVALIDATED_READ: KeyringReadSlot = KeyringReadSlot(StdMutex::new(None));
    static TEST_SAVED_READ: KeyringReadSlot = KeyringReadSlot(StdMutex::new(None));

    #[tokio::test]
    async fn concurrent_callers_share_the_same_healthy_keychain_result() {
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let first = tokio::spawn(bounded_keyring_read(
            &TEST_SHARED_READ,
            Duration::from_secs(1),
            move || {
                let _ = started_tx.send(());
                let _ = release_rx.recv();
                Some("test-key".into())
            },
        ));
        timeout(Duration::from_secs(1), started_rx)
            .await
            .unwrap()
            .unwrap();
        let second_ran = Arc::new(AtomicBool::new(false));
        let marker = second_ran.clone();
        let second = tokio::spawn(bounded_keyring_read(
            &TEST_SHARED_READ,
            Duration::from_secs(1),
            move || {
                marker.store(true, Ordering::Release);
                Some("wrong-key".into())
            },
        ));
        timeout(Duration::from_secs(1), async {
            loop {
                let joined = TEST_SHARED_READ
                    .0
                    .lock()
                    .unwrap()
                    .as_ref()
                    .is_some_and(|session| Arc::strong_count(session) >= 4);
                if joined {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        release_tx.send(()).unwrap();
        assert_eq!(first.await.unwrap().as_deref(), Some("test-key"));
        assert_eq!(second.await.unwrap().as_deref(), Some("test-key"));
        assert!(!second_ran.load(Ordering::Acquire));
    }

    #[tokio::test]
    async fn stalled_keychain_read_is_bounded_and_does_not_spawn_more_workers() {
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let first = tokio::spawn(bounded_keyring_read(
            &TEST_STALLED_READ,
            Duration::from_millis(80),
            move || {
                let _ = started_tx.send(());
                let _ = release_rx.recv();
                Some("test-key".into())
            },
        ));
        timeout(Duration::from_secs(1), started_rx)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(first.await.unwrap(), None);
        assert!(TEST_STALLED_READ.0.lock().unwrap().is_some());

        let second_ran = Arc::new(AtomicBool::new(false));
        let marker = second_ran.clone();
        assert_eq!(
            bounded_keyring_read(&TEST_STALLED_READ, Duration::from_millis(80), move || {
                marker.store(true, Ordering::Release);
                Some("second-key".into())
            })
            .await,
            None
        );
        assert!(!second_ran.load(Ordering::Acquire));

        release_tx.send(()).unwrap();
        timeout(Duration::from_secs(1), async {
            while TEST_STALLED_READ.0.lock().unwrap().is_some() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert_eq!(
            bounded_keyring_read(&TEST_STALLED_READ, Duration::from_secs(1), || Some(
                "available-key".into()
            ))
            .await
            .as_deref(),
            Some("available-key")
        );
    }

    #[tokio::test]
    async fn saved_key_replaces_stale_read_until_its_worker_finishes() {
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        let old = tokio::spawn(bounded_keyring_read(
            &TEST_INVALIDATED_READ,
            Duration::from_secs(1),
            move || {
                let _ = started_tx.send(());
                let _ = release_rx.recv();
                Some("old-key".into())
            },
        ));
        timeout(Duration::from_secs(1), started_rx)
            .await
            .unwrap()
            .unwrap();
        let first_save = publish_saved_key(&TEST_INVALIDATED_READ, Some("new-key".into()));
        clear_saved_key_after_restart(&TEST_INVALIDATED_READ, &first_save);
        let latest_save = publish_saved_key(&TEST_INVALIDATED_READ, Some("newer-key".into()));
        clear_saved_key_after_restart(&TEST_INVALIDATED_READ, &latest_save);
        let extra_read = Arc::new(AtomicBool::new(false));
        let marker = extra_read.clone();
        assert_eq!(
            bounded_keyring_read(
                &TEST_INVALIDATED_READ,
                Duration::from_millis(80),
                move || {
                    marker.store(true, Ordering::Release);
                    Some("unexpected-key".into())
                }
            )
            .await
            .as_deref(),
            Some("newer-key")
        );
        assert!(!extra_read.load(Ordering::Acquire));
        release_tx.send(()).unwrap();
        assert_eq!(old.await.unwrap(), None);
        timeout(Duration::from_secs(1), async {
            while TEST_INVALIDATED_READ.0.lock().unwrap().is_some() {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert_eq!(
            bounded_keyring_read(&TEST_INVALIDATED_READ, Duration::from_secs(1), || Some(
                "new-key".into()
            ))
            .await
            .as_deref(),
            Some("new-key")
        );
    }

    #[tokio::test]
    async fn saved_key_override_clears_after_an_unblocked_restart() {
        let saved = publish_saved_key(&TEST_SAVED_READ, Some("saved-key".into()));
        assert_eq!(
            bounded_keyring_read(&TEST_SAVED_READ, Duration::from_secs(1), || None)
                .await
                .as_deref(),
            Some("saved-key")
        );
        clear_saved_key_after_restart(&TEST_SAVED_READ, &saved);
        assert!(TEST_SAVED_READ.0.lock().unwrap().is_none());
        assert_eq!(
            bounded_keyring_read(&TEST_SAVED_READ, Duration::from_secs(1), || Some(
                "keychain-key".into()
            ))
            .await
            .as_deref(),
            Some("keychain-key")
        );
    }
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
    if cached
        .as_ref()
        .is_some_and(|runtime| runtime.path.is_file())
    {
        return Ok(cached.as_ref().expect("checked above").clone());
    }
    *cached = None;

    let mut candidates = Vec::new();
    let executable_name = if cfg!(windows) { "codex.exe" } else { "codex" };

    if let Some(override_path) = codex_runtime_override() {
        let override_path = PathBuf::from(override_path);
        if !override_path.is_file() {
            return Err(
            "MYTHRA_CODE_CODEX_PATH does not point to a Codex executable. Update or remove it, then choose Try again.".into()
            );
        }
        let version = runtime_version(&override_path).await.ok_or_else(|| {
            "MYTHRA_CODE_CODEX_PATH could not be started. Update or remove it, then choose Try again.".to_string()
        })?;
        let resolved = ResolvedCodexRuntime {
            path: override_path,
            version,
        };
        *cached = Some(resolved.clone());
        return Ok(resolved);
    }

    // Prefer the official standalone installer location. This lets the
    // Updates pane move a machine away from a stale npm shim or an embedded
    // ChatGPT copy without relying on the sparse PATH of a GUI launch.
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
        if let Some(version) = runtime_version(candidate).await {
            let resolved = ResolvedCodexRuntime {
                path: candidate.clone(),
                version,
            };
            *cached = Some(resolved.clone());
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
        if let Some(version) = runtime_version(&candidate).await {
            let resolved = ResolvedCodexRuntime {
                path: candidate,
                version,
            };
            *cached = Some(resolved.clone());
            return Ok(resolved);
        }
    }
    #[cfg(not(windows))]
    if let Some(candidate) = candidates.into_iter().find(|candidate| candidate.is_file()) {
        if let Some(version) = runtime_version(&candidate).await {
            let resolved = ResolvedCodexRuntime {
                path: candidate,
                version,
            };
            *cached = Some(resolved.clone());
            return Ok(resolved);
        }
    }
    if let Some(candidate) = find_with_login_shell(executable_name).await {
        if let Some(version) = runtime_version(&candidate).await {
            let resolved = ResolvedCodexRuntime {
                path: candidate,
                version,
            };
            *cached = Some(resolved.clone());
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
            "Native Codex sub-agents are available only for the Codex subscription.".into(),
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

async fn fetch_runtime_text(url: &'static str, maximum_bytes: usize) -> Result<String, String> {
    let mut response = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|error| format!("Could not create the runtime update client: {error}"))?
        .get(url)
        .send()
        .await
        .map_err(|error| format!("Could not reach the runtime release service: {error}"))?
        .error_for_status()
        .map_err(|error| format!("The runtime release service returned an error: {error}"))?;
    if response
        .content_length()
        .is_some_and(|length| length > maximum_bytes as u64)
    {
        return Err("The runtime release response was unexpectedly large".into());
    }
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| format!("Could not read the runtime release response: {error}"))?
    {
        if body.len().saturating_add(chunk.len()) > maximum_bytes {
            return Err("The runtime release response was unexpectedly large".into());
        }
        body.extend_from_slice(&chunk);
    }
    String::from_utf8(body)
        .map(|text| text.trim().to_string())
        .map_err(|_| "The runtime release service returned non-UTF-8 text".to_string())
}

async fn latest_claude_version() -> Result<String, String> {
    let response =
        fetch_runtime_text(CLAUDE_LATEST_VERSION_URL, RUNTIME_VERSION_RESPONSE_BYTES).await?;
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
        fetch_runtime_text(CODEX_LATEST_RELEASE_URL, RUNTIME_VERSION_RESPONSE_BYTES).await?;
    parse_latest_codex_version(&response)
}

fn parse_latest_codex_version(response: &str) -> Result<String, String> {
    let payload: Value = serde_json::from_str(response)
        .map_err(|error| format!("Could not parse the Codex release response: {error}"))?;
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
                kill_process_tree(pid);
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
    let (codex_installed, codex_current, codex_source, codex_resolution_error) = match codex_runtime
    {
        Ok(runtime) => (
            true,
            normalized_runtime_version(&runtime.version),
            Some(runtime_source(&runtime.path).to_string()),
            None,
        ),
        Err(error) => (
            false,
            None,
            codex_custom.then(|| "Custom path".to_string()),
            codex_custom.then_some(error),
        ),
    };
    let (claude_installed, claude_current, claude_source, claude_resolution_error) =
        match claude_path {
            Ok(path) => {
                let source = claude_runtime_source(&path);
                match runtime_version(&path)
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
        codex: developer_runtime_target_status(
            codex_installed,
            codex_current,
            codex_latest,
            codex_source,
            codex_custom,
            codex_resolution_error,
        ),
        claude: developer_runtime_target_status(
            claude_installed,
            claude_current,
            claude_latest,
            claude_source,
            claude_custom,
            claude_resolution_error,
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
    let (message, restart_required) = match target.as_str() {
        "claude" => {
            if !claude_state.turns.lock().await.is_empty() {
                return Err("Stop active Claude tasks before updating Claude Code.".into());
            }
            if claude_runtime_override().is_some() {
                return Err("Mythra Code will not overwrite a custom Claude Code path. Update that executable yourself or remove MYTHRA_CODE_CLAUDE_PATH.".into());
            }
            let message = match resolve_claude_binary(&app).await {
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
                        .await?
                    } else {
                        let mut command = background_command(path);
                        command.arg("update");
                        run_runtime_update_command(command, None).await?
                    }
                }
                Err(_) => {
                    run_official_installer(
                        CLAUDE_INSTALLER_URL,
                        CLAUDE_INSTALLER_WINDOWS_URL,
                        false,
                    )
                    .await?
                }
            };
            (message, false)
        }
        "codex" => {
            if codex_runtime_override().is_some() {
                return Err("Mythra Code will not overwrite a custom Codex path. Update that executable yourself or remove MYTHRA_CODE_CODEX_PATH.".into());
            }
            let message =
                run_official_installer(CODEX_INSTALLER_URL, CODEX_INSTALLER_WINDOWS_URL, true)
                    .await?;
            *runtime_state.codex_runtime.lock().await = None;
            (message, true)
        }
        _ => return Err("Unknown developer runtime update target".into()),
    };
    let status = read_developer_runtime_updates(&app, &runtime_state).await;
    Ok(DeveloperRuntimeUpdateResult {
        status,
        message,
        restart_required,
    })
}

async fn resolve_claude_binary(app: &AppHandle) -> Result<PathBuf, String> {
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
    for candidate in candidates
        .into_iter()
        .filter(|candidate| candidate.is_file())
    {
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

    Err("Mythra Code could not find Claude Code. Install Claude Code, sign in with `claude auth login`, then try again. Advanced users can set MYTHRA_CODE_CLAUDE_PATH.".into())
}

fn configure_claude_subscription(command: &mut Command, home: Option<&Path>) {
    command
        .env_remove("ANTHROPIC_API_KEY")
        .env_remove("ANTHROPIC_AUTH_TOKEN")
        .env_remove("ANTHROPIC_BASE_URL")
        .env_remove("ANTHROPIC_CUSTOM_HEADERS")
        .env_remove("ANTHROPIC_DEFAULT_HAIKU_MODEL")
        .env_remove("ANTHROPIC_DEFAULT_OPUS_MODEL")
        .env_remove("ANTHROPIC_DEFAULT_SONNET_MODEL")
        .env_remove("ANTHROPIC_DEFAULT_FABLE_MODEL")
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

async fn claude_executable_identity(path: &Path) -> ClaudeExecutableIdentity {
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
    ClaudeExecutableIdentity {
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
    let identity = claude_executable_identity(path).await;
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
    if claude_executable_identity(path).await != identity {
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
        runtime_version(path)
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
    let identity = claude_executable_identity(path).await;
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
    let identity = claude_executable_identity(path).await;
    cache.lock().await.as_ref()
        .filter(|runtime| runtime.reusable(&identity, Instant::now()))
        .and_then(|runtime| runtime.haiku55_supported)
        .unwrap_or(false)
}

async fn cached_claude_model_compaction_support(
    cache: &Mutex<Option<ClaudePromptSnapshotSupport>>,
    path: &Path,
) -> bool {
    let identity = claude_executable_identity(path).await;
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

#[tauri::command]
async fn claude_usage(app: AppHandle) -> Result<ClaudeUsageLimits, String> {
    let path = resolve_claude_binary(&app).await?;
    let home = crate::release_qa::home_dir(&app).ok();
    let output = timeout(
        Duration::from_secs(10),
        subscription_only_command(&path, home.as_deref())
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
            .kill_on_drop(true)
            .output(),
    )
    .await
    .map_err(|_| "CLAUDE_USAGE_TIMEOUT".to_string())?
    .map_err(|_| "CLAUDE_USAGE_START_FAILED".to_string())?;
    if !output.status.success() {
        // Keep provider output out of renderer errors and audit logs, but
        // preserve the one distinction that changes the user's next action.
        return Err(claude_usage_failure_code(&output.stderr).into());
    }
    let envelope = parse_claude_auth_status(&output.stdout)
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
    let binary = resolve_claude_binary(&app).await?;
    let cwd = crate::release_qa::home_dir(&app)
        .ok()
        .filter(|path| path.is_dir())
        .unwrap_or_else(env::temp_dir);
    let mut child = subscription_only_command(&binary, Some(&cwd))
        .current_dir(cwd)
        .env("CLAUDE_CODE_ENTRYPOINT", "sdk-ts")
        .args([
            "--setting-sources",
            "",
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

    // kill_on_drop only fires once the handle is dropped; the reader below owns
    // stdout, so take both pipes before any early return can leak the process.
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| "Claude Code did not accept a model catalog request".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Claude Code did not return a model catalog".to_string())?;

    let request = json!({
        "type": "control_request",
        "request_id": "mythra-list-models",
        "request": { "subtype": "list_models" },
    });
    let outcome = timeout(Duration::from_secs(20), async {
        stdin
            .write_all(format!("{request}\n").as_bytes())
            .await
            .map_err(|error| format!("Could not ask Claude Code for its models: {error}"))?;
        stdin
            .flush()
            .await
            .map_err(|error| format!("Could not ask Claude Code for its models: {error}"))?;
        let mut lines = BufReader::new(stdout).lines();
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
    outcome.map_err(|_| "Claude Code took too long to list its models".to_string())?
}

async fn read_claude_runtime_status(app: &AppHandle) -> ClaudeRuntimeStatus {
    let warning = claude_credential_override_present()
    .then(|| "Mythra Code ignores Anthropic credential, proxy, and hosted-provider environment overrides for Claude subscription sessions, so this provider uses only your Claude Code login.".to_string());
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
    let warning = claude_runtime_warnings(version.as_deref(), warning);
    let home = crate::release_qa::home_dir(app).ok();
    let auth = timeout(
        CLAUDE_AUTH_STATUS_TIMEOUT,
        subscription_only_command(&path, home.as_deref())
            .args(["--setting-sources", "", "auth", "status"])
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .output(),
    )
    .await
    .ok()
    .and_then(Result::ok)
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
        let home = crate::release_qa::home_dir(&app).ok();
        configure_claude_subscription(&mut command, home.as_deref());
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
        Err(
            "Run `claude auth login` in a terminal, then refresh Claude status in Mythra Code."
                .into(),
        )
    }
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

#[cfg(test)]
mod unattended_claude_tests {
    use super::*;

    #[test]
    fn unattended_turn_denies_tool_and_question_requests_without_changing_read_only_tools() {
        let question = json!({
            "type": "control_request", "request_id": "question-1",
            "request": { "subtype": "can_use_tool", "tool_name": "AskUserQuestion" }
        });
        let denied =
            claude_unattended_denial(false, &question).expect("unattended question denied");
        assert_eq!(denied["response"]["response"]["behavior"], "deny");
        assert_eq!(denied["response"]["request_id"], "question-1");
        assert!(claude_unattended_denial(true, &question).is_none());
        assert!(claude_allowed_builtin_tools("read-only", false).contains(&"Read"));
        assert!(!claude_allowed_builtin_tools("read-only", false).contains(&"Write"));
    }
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
    let home = crate::release_qa::home_dir(&app).ok();
    let mut command = subscription_only_command(&binary, home.as_deref());
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
        stdin: Mutex::new(Some(stdin)),
        child: Arc::new(Mutex::new(child)),
        pid,
        alive: alive.clone(),
        control_requests: Mutex::new(HashSet::new()),
        control_response: Mutex::new(()),
    });
    if !claim_turn_slot(&state.turns, &options.thread_id, &turn, |existing| {
        existing.alive.load(Ordering::Acquire)
    })
    .await
    {
        turn.shutdown().await;
        return Err("Claude is already working in this thread".into());
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
        &[&initialize, &user_message],
        &mut lines,
        Instant::now() + CLAUDE_STARTUP_INPUT_TIMEOUT,
    )
    .await
    {
        Ok(early_output) => early_output,
        Err(error) => {
            remove_claude_turn_if_current(&state.turns, &options.thread_id, &turn).await;
            turn.shutdown().await;
            stderr_task.abort();
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
    let stdout_thread = options.thread_id;
    let stdout_turn = turn_id.clone();
    let turns = state.turns.clone();
    let stdout_child = turn.child.clone();
    let stdout_runtime = turn.clone();
    tauri::async_runtime::spawn(async move {
        let mut terminal_result = None;
        let mut saw_terminal_assistant = false;
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
                    saw_terminal_assistant = false;
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
            if claude_assistant_ends_turn(&message) {
                saw_terminal_assistant = !turn_boundary.prompt_pending();
            } else if claude_reopens_turn(&message) {
                saw_terminal_assistant = false;
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
                if let Some(response) = claude_unattended_denial(interactive, &message)
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
        let exit = if observed_exit.is_some() {
            observed_exit
        } else {
            let mut child = stdout_child.lock().await;
            let grace = if saw_result {
                CLAUDE_RESULT_EXIT_GRACE
            } else {
                Duration::from_secs(5)
            };
            reap_claude_process(&mut child, &mut lines.into_inner(), grace).await
        };
        let recovered = claude_can_recover_at_exit(saw_terminal_assistant, exit.as_ref());
        if let Some(message) = terminal_result {
            stdout_runtime.alive.store(false, Ordering::Release);
            remove_claude_turn_if_current(&turns, &stdout_thread, &stdout_runtime).await;
            emit_claude_event(&stdout_app, &stdout_thread, &stdout_turn, message).await;
        } else if recovered {
            // The direct process is gone, so no later result can carry usage
            // or a different terminal state. The assistant event was already
            // forwarded and contains its own usage; synthesize only the
            // missing lifecycle envelope so the renderer can seal the turn.
            stdout_runtime.alive.store(false, Ordering::Release);
            remove_claude_turn_if_current(&turns, &stdout_thread, &stdout_runtime).await;
            emit_claude_event(
                &stdout_app,
                &stdout_thread,
                &stdout_turn,
                json!({
                    "type": "result",
                    "subtype": "success",
                    "is_error": false,
                    "num_turns": 1,
                    "result": "",
                    "openkiwi_recovered_from_assistant_end_turn": true,
                }),
            )
            .await;
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
        // of leaving the thread stuck until Mythra Code restarts.
        remove_claude_turn_if_current(&state.turns, &thread_id, &turn).await;
        turn.shutdown().await;
        return Err(error);
    }
    // Escalate if the CLI ignores the interrupt. A healthy process emits a
    // `result` well within the grace period (whose reader reaps the process);
    // a wedged one would otherwise hold the per-thread slot until app restart.
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
        connection
            .execute(
                "INSERT INTO audit_events(created_at, kind, thread_id, payload) VALUES (?1, ?2, ?3, ?4)",
                params![unix_timestamp_ms(), kind, thread_id, json],
            )
            .map_err(|error| format!("Could not append audit event: {error}"))?;
        persistence::prune_audit_events(&connection)
            .map_err(|error| format!("Could not prune audit history: {error}"))?;
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

#[cfg(test)]
mod provider_runtime_tests {
    use super::*;
    use std::io::{BufRead as _, Write as _};

    const FIXTURE_TEST: &str = "provider_runtime_tests::provider_fixture";
    const FIXTURE_MODE: &str = "MYTHRA_PROVIDER_FIXTURE";
    const FIXTURE_RELEASE: &str = "MYTHRA_PROVIDER_FIXTURE_RELEASE";
    pub(crate) const FIXTURE_HOLDER: &str = "MYTHRA_PROVIDER_FIXTURE_HOLDER";
    pub(crate) const FIXTURE_READ_FIRST: &str = "MYTHRA_PROVIDER_FIXTURE_READ_FIRST";
    pub(crate) const FIXTURE_FINAL: &str = "MYTHRA_PROVIDER_FIXTURE_FINAL";
    pub(crate) const FIXTURE_STDERR: &str = "fixture stderr before exit";
    /// Printed by `read-one` once it has consumed its line and stopped reading.
    pub(crate) const FIXTURE_CONSUMED: &str = "fixture consumed one input line";
    /// The longest a fixture waits for release; tests release them sooner.
    const FIXTURE_LIFETIME: Duration = Duration::from_secs(30);

    /// A hermetic stand-in for a provider CLI on every OS: this test binary
    /// re-run in one mode. It never contacts a provider or uses a model.
    #[test]
    #[ignore = "subprocess fixture spawned by provider runtime tests"]
    fn provider_fixture() {
        let Ok(mode) = env::var(FIXTURE_MODE) else {
            return;
        };
        let release = PathBuf::from(env::var_os(FIXTURE_RELEASE).expect("fixture release path"));
        run_fixture(&mode, &release);
        // Exit before the harness prints its result line on stdout.
        std::process::exit(0);
    }

    fn released(release: &Path) -> bool {
        release.exists() || !release.parent().is_some_and(Path::exists)
    }

    fn wait_for_release(release: &Path) {
        let started = std::time::Instant::now();
        while !released(release) && started.elapsed() < FIXTURE_LIFETIME {
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    fn read_input_line() {
        let mut line = String::new();
        let _ = std::io::stdin().lock().read_line(&mut line);
    }

    fn print_lines(lines: &[&str]) {
        let mut stdout = std::io::stdout().lock();
        for line in lines {
            writeln!(stdout, "{line}").unwrap();
        }
        stdout.flush().unwrap();
    }

    fn run_fixture(mode: &str, release: &Path) {
        // The harness banner precedes fixture output; start on a fresh line.
        print_lines(&[""]);
        match mode {
            "exit" => {}
            "hold" | "no-read" => wait_for_release(release),
            "hold-spam" => {
                let mut stdout = std::io::stdout().lock();
                // Ends when the reader closes the pipe or the test releases it.
                while !released(release) && writeln!(stdout, "spam").is_ok() {}
            }
            "orphan-parent" => {
                if env::var_os(FIXTURE_READ_FIRST).is_some() {
                    read_input_line();
                }
                // The descendant inherits stdout and stderr and outlives us.
                let mut descendant = background_std_command(env::current_exe().unwrap())
                    .args(["--exact", FIXTURE_TEST, "--ignored", "--nocapture", "-q"])
                    .env(
                        FIXTURE_MODE,
                        env::var(FIXTURE_HOLDER).unwrap_or("hold".into()),
                    )
                    .stdin(Stdio::null())
                    .spawn()
                    .expect("spawn fixture descendant");
                // Reap while the parent remains alive. This mode deliberately
                // exits first, at which point the OS adopts the descendant;
                // the scratch-root release still bounds its lifetime.
                std::thread::spawn(move || {
                    let _ = descendant.wait();
                });
                let final_line = env::var(FIXTURE_FINAL).unwrap_or("final".into());
                print_lines(&[&final_line]);
                eprintln!("{FIXTURE_STDERR}");
            }
            "startup" => {
                let mut stdout = std::io::stdout().lock();
                stdout.write_all(&vec![b'x'; 1024 * 1024]).unwrap();
                stdout.write_all(b"\nsecond\n").unwrap();
                stdout.flush().unwrap();
                drop(stdout);
                let _ = std::io::copy(&mut std::io::stdin().lock(), &mut std::io::sink());
            }
            "read-one" => {
                read_input_line();
                // Lets a test order its next write after this read, instead
                // of racing the first writer for the input pipe.
                print_lines(&[FIXTURE_CONSUMED]);
                wait_for_release(release);
            }
            "acp-one" => {
                read_input_line();
                print_lines(&[r#"{"jsonrpc":"2.0","id":1,"result":{"stopReason":"end_turn"}}"#]);
                wait_for_release(release);
            }
            "acp-echo" => {
                for _ in 0..3 {
                    let mut line = String::new();
                    if std::io::stdin().lock().read_line(&mut line).unwrap() == 0 {
                        break;
                    }
                    let request: Value = serde_json::from_str(&line).unwrap();
                    print_lines(&[&json!({ "jsonrpc": "2.0", "method": "session/update",
                        "params": { "echo": request["params"]["prompt"][0]["text"] }
                    })
                    .to_string()]);
                }
                wait_for_release(release);
            }
            "acp-steer" => {
                read_input_line();
                read_input_line();
                print_lines(&[
                    r#"{"jsonrpc":"2.0","method":"session/update","params":{"n":1}}"#,
                    r#"{"jsonrpc":"2.0","id":1,"result":{"stopReason":"end_turn"}}"#,
                ]);
                std::thread::sleep(Duration::from_millis(300));
                print_lines(&[
                    r#"{"jsonrpc":"2.0","method":"session/update","params":{"n":2}}"#,
                    r#"{"jsonrpc":"2.0","id":2,"result":{"stopReason":"end_turn"}}"#,
                ]);
                wait_for_release(release);
            }
            "burst" => {
                std::thread::sleep(Duration::from_millis(300));
                let burst: String = (0..1000)
                    .map(|n| {
                        format!(
                            "{{\"jsonrpc\":\"2.0\",\"method\":\"session/update\",\"params\":{{\"n\":{n}}}}}\n"
                        )
                    })
                    .collect();
                let mut stdout = std::io::stdout().lock();
                stdout.write_all(burst.as_bytes()).unwrap();
                stdout.flush().unwrap();
                drop(stdout);
                wait_for_release(release);
            }
            other => panic!("unknown provider fixture mode `{other}`"),
        }
    }

    /// A scratch directory whose removal releases every fixture started from it.
    pub(crate) struct Fixture {
        directory: PathBuf,
        release: PathBuf,
    }

    impl Fixture {
        pub(crate) fn new() -> Self {
            let directory =
                env::temp_dir().join(format!("mythra-provider-fixture-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(&directory).unwrap();
            Self {
                release: directory.join("release"),
                directory,
            }
        }

        /// The fixture in `mode` with piped stdio in its own process group, as
        /// provider CLIs are launched.
        pub(crate) fn command(&self, mode: &str) -> Command {
            let mut command = background_command(env::current_exe().unwrap());
            command
                .args(["--exact", FIXTURE_TEST, "--ignored", "--nocapture", "-q"])
                .env(FIXTURE_MODE, mode)
                .env(FIXTURE_RELEASE, &self.release)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .kill_on_drop(true);
            #[cfg(unix)]
            command.process_group(0);
            command
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.directory);
        }
    }

    #[test]
    fn provider_delta_batches_flush_after_every_append() {
        let now = Instant::now();
        let mut batch = ProviderDeltaBatch::default();
        assert!(batch.deadline().is_none());
        for index in 0..CODEX_DELTA_MAX_BATCH_SIZE - 1 {
            assert!(!batch.push(json!(index), 10, now));
        }
        assert!(batch.push(json!("last"), 10, now));
        let events = batch.take().expect("full batch");
        let events = events.as_array().unwrap();
        assert_eq!(events.len(), CODEX_DELTA_MAX_BATCH_SIZE);
        assert_eq!(events[0], json!(0), "arrival order is preserved");
        assert!(batch.deadline().is_none() && batch.take().is_none());

        // A single event larger than the byte threshold is emitted whole and
        // alone: the threshold triggers a flush, it does not split or drop.
        let large = "z".repeat(2 * PROVIDER_DELTA_MAX_BATCH_BYTES);
        assert!(batch.push(json!(large), large.len(), now));
        let events = batch.take().unwrap();
        assert_eq!(events.as_array().unwrap(), &vec![json!(large)]);
        assert!(!batch.push(json!(1), 1, now));
        assert!(
            batch.push(json!(2), 1, now + PROVIDER_DELTA_FLUSH_INTERVAL),
            "the deadline is honored even when the next line was already ready"
        );
    }

    /// Output that is always ready: every poll yields another `spam` line.
    #[derive(Default)]
    struct EndlessSpam {
        offset: usize,
    }

    const SPAM: &[u8] = b"spam\nspam\nspam\nspam\nspam\nspam\nspam\nspam\n";

    impl tokio::io::AsyncRead for EndlessSpam {
        fn poll_read(
            mut self: std::pin::Pin<&mut Self>,
            _: &mut std::task::Context<'_>,
            buf: &mut tokio::io::ReadBuf<'_>,
        ) -> std::task::Poll<std::io::Result<()>> {
            let available = &SPAM[self.offset..];
            let count = available.len().min(buf.remaining());
            buf.put_slice(&available[..count]);
            self.offset = (self.offset + count) % SPAM.len();
            std::task::Poll::Ready(Ok(()))
        }
    }

    impl tokio::io::AsyncBufRead for EndlessSpam {
        fn poll_fill_buf(
            self: std::pin::Pin<&mut Self>,
            _: &mut std::task::Context<'_>,
        ) -> std::task::Poll<std::io::Result<&[u8]>> {
            let offset = self.offset;
            std::task::Poll::Ready(Ok(&SPAM[offset..]))
        }

        fn consume(mut self: std::pin::Pin<&mut Self>, amount: usize) {
            self.offset = (self.offset + amount) % SPAM.len();
        }
    }

    /// A kill path (Cursor `terminate`, Codex `shutdown`) holds the child lock
    /// while the reader reaches EOF. Whatever the watcher was doing then, it
    /// must not end up owning that lock after the holder releases it: nothing
    /// polls a watcher after `Closed`, so a lock granted to it is never
    /// released and every later kill or reap of the transport waits forever.
    #[tokio::test]
    async fn closed_output_does_not_retain_the_child_lock() {
        let fixture = Fixture::new();
        let child = Arc::new(Mutex::new(fixture.command("hold").spawn().unwrap()));
        let holder = child.lock().await;
        let mut output = ProviderOutput::new(BufReader::new(tokio::io::empty()), child.clone());
        assert!(matches!(
            timeout(Duration::from_secs(2), output.next_line(None)).await,
            Ok(ProviderRead::Closed)
        ));
        drop(holder);
        assert!(
            child.try_lock().is_ok(),
            "a closed output must not hold the child lock"
        );
        drop(output);
        child.lock().await.start_kill().unwrap();
    }

    /// The same applies between lines: a reader handling a line may itself
    /// need the child lock (a failed reply retires and kills the transport).
    #[tokio::test]
    async fn returned_line_does_not_leave_the_watcher_holding_the_child_lock() {
        let fixture = Fixture::new();
        let child = Arc::new(Mutex::new(fixture.command("hold").spawn().unwrap()));
        let holder = child.lock().await;
        let mut output = ProviderOutput::new(BufReader::new(&b"line\n"[..]), child.clone());
        assert!(matches!(
            timeout(Duration::from_secs(2), output.next_line(None)).await,
            Ok(ProviderRead::Line(line)) if line == "line"
        ));
        drop(holder);
        assert!(
            child.try_lock().is_ok(),
            "the watcher must not be granted the child lock between lines"
        );
        drop(output);
        child.lock().await.start_kill().unwrap();
    }

    #[tokio::test]
    async fn provider_exit_watch_is_not_starved_by_always_ready_output() {
        let fixture = Fixture::new();
        let child = Arc::new(Mutex::new(fixture.command("exit").spawn().unwrap()));
        let mut output = ProviderOutput::new(EndlessSpam::default(), child.clone());
        let started = Instant::now();
        let lines = timeout(Duration::from_secs(15), async {
            let mut lines = 0u64;
            loop {
                match output.next_line(None).await {
                    ProviderRead::Line(_) => {
                        lines += 1;
                        // A consumer that does other work between lines.
                        if lines.is_multiple_of(32) {
                            tokio::task::yield_now().await;
                        }
                    }
                    ProviderRead::FlushDue => {}
                    ProviderRead::Closed => return lines,
                }
            }
        })
        .await
        .expect("the exit watcher must not be starved by always-ready output");
        assert!(lines > 0, "output after exit is still drained");
        assert!(started.elapsed() < PROVIDER_EXIT_DRAIN + Duration::from_secs(5));
        assert!(child.lock().await.try_wait().unwrap().is_some());
    }

    fn fixture_output(
        fixture: &Fixture,
        mode: &str,
        holder: &str,
    ) -> (
        Arc<Mutex<Child>>,
        ProviderOutput<BufReader<tokio::process::ChildStdout>>,
        tokio::process::ChildStderr,
    ) {
        let mut child = fixture
            .command(mode)
            .env(FIXTURE_HOLDER, holder)
            .spawn()
            .expect("spawn fixture provider");
        let stdout = child.stdout.take().unwrap();
        let stderr = child.stderr.take().unwrap();
        let child = Arc::new(Mutex::new(child));
        let output = ProviderOutput::new(BufReader::new(stdout), child.clone());
        (child, output, stderr)
    }

    async fn read_until_closed(
        output: &mut ProviderOutput<BufReader<tokio::process::ChildStdout>>,
    ) -> Vec<String> {
        let mut lines = Vec::new();
        loop {
            match output.next_line(None).await {
                ProviderRead::Line(line) => lines.push(line),
                ProviderRead::FlushDue => {}
                ProviderRead::Closed => return lines,
            }
        }
    }

    #[tokio::test]
    async fn provider_output_keeps_final_output_and_ends_at_direct_exit() {
        // The descendant inherits stdout and stderr and outlives the direct
        // child, so EOF would not arrive until the fixture is released.
        let fixture = Fixture::new();
        let (child, mut output, _stderr) = fixture_output(&fixture, "orphan-parent", "hold");
        let started = Instant::now();
        let lines = timeout(Duration::from_secs(10), read_until_closed(&mut output))
            .await
            .expect("transport must end at direct exit");
        assert!(lines.iter().any(|line| line == "final"), "{lines:?}");
        assert!(started.elapsed() < PROVIDER_EXIT_DRAIN + Duration::from_secs(5));
        assert!(child.lock().await.try_wait().unwrap().is_some());
    }

    #[tokio::test]
    async fn provider_output_drain_is_bounded_while_a_descendant_keeps_writing() {
        let fixture = Fixture::new();
        let (_child, mut output, _stderr) = fixture_output(&fixture, "orphan-parent", "hold-spam");
        let lines = timeout(Duration::from_secs(10), read_until_closed(&mut output))
            .await
            .expect("drain must end while a descendant keeps writing");
        assert!(
            lines.iter().any(|line| line == "final"),
            "final output kept"
        );
    }

    #[tokio::test]
    async fn provider_output_reports_a_due_flush_while_idle() {
        let fixture = Fixture::new();
        let (_child, mut output, _stderr) = fixture_output(&fixture, "no-read", "hold");
        // Skip the harness banner so the idle wait is what is measured.
        timeout(Duration::from_secs(5), async {
            loop {
                match timeout(Duration::from_millis(500), output.next_line(None)).await {
                    Err(_) => break,
                    Ok(ProviderRead::Line(_) | ProviderRead::FlushDue) => {}
                    Ok(ProviderRead::Closed) => {
                        panic!("fixture exited before the idle flush check")
                    }
                }
            }
        })
        .await
        .expect("fixture banner drain must finish or fail within the startup bound");
        let flush_at = Instant::now() + Duration::from_millis(30);
        assert!(matches!(
            timeout(Duration::from_secs(2), output.next_line(Some(flush_at))).await,
            Ok(ProviderRead::FlushDue)
        ));
    }

    #[test]
    fn stderr_reader_reports_while_active_and_is_retired_with_the_transport() {
        tauri::async_runtime::block_on(async {
            let fixture = Fixture::new();
            let (child, mut output, stderr) = fixture_output(&fixture, "orphan-parent", "hold");
            let reported = Arc::new(StdMutex::new(Vec::new()));
            let task = tauri::async_runtime::spawn({
                let reported = reported.clone();
                async move {
                    let mut lines = BufReader::new(stderr).lines();
                    while let Ok(Some(line)) = lines.next_line().await {
                        reported.lock().unwrap().push(line);
                    }
                }
            });
            timeout(Duration::from_secs(10), read_until_closed(&mut output))
                .await
                .unwrap();
            assert!(child.lock().await.try_wait().unwrap().is_some());
            // The descendant still holds stderr, so the reader never sees EOF.
            let started = Instant::now();
            timeout(Duration::from_secs(5), finish_stderr_reader(task))
                .await
                .expect("an inherited stderr pipe must not keep its reader running");
            assert!(started.elapsed() < PROVIDER_STDERR_DRAIN + Duration::from_secs(1));
            assert!(reported
                .lock()
                .unwrap()
                .iter()
                .any(|line| line == FIXTURE_STDERR));
        });
    }

    fn fixture_claude(
        fixture: &Fixture,
        mode: &str,
    ) -> (
        ClaudeTurn,
        tokio::io::Lines<BufReader<tokio::process::ChildStdout>>,
    ) {
        let mut child = fixture
            .command(mode)
            .spawn()
            .expect("spawn fake Claude Code");
        let stdin = child.stdin.take().unwrap();
        let lines = BufReader::new(child.stdout.take().unwrap()).lines();
        let turn = ClaudeTurn {
            stdin: Mutex::new(Some(stdin)),
            pid: child.id(),
            child: Arc::new(Mutex::new(child)),
            alive: Arc::new(AtomicBool::new(true)),
            control_requests: Mutex::new(HashSet::new()),
            control_response: Mutex::new(()),
        };
        (turn, lines)
    }

    #[tokio::test]
    async fn claude_startup_input_is_written_while_its_output_is_drained() {
        // Writes 1 MiB before reading any input. Writing first, as startup
        // used to, leaves both sides blocked on full pipes.
        let fixture = Fixture::new();
        let (turn, mut lines) = fixture_claude(&fixture, "startup");
        let prompt = json!({ "type": "user", "blob": "y".repeat(2 * 1024 * 1024) });
        let early = timeout(
            Duration::from_secs(20),
            write_claude_startup_input(
                &turn,
                &[&json!({ "type": "control_request" }), &prompt],
                &mut lines,
                Instant::now() + Duration::from_secs(20),
            ),
        )
        .await
        .expect("startup input must not deadlock behind unread output")
        .expect("startup input written");
        let mut drained: Vec<String> = early
            .into_iter()
            .map(|line| line.unwrap().expect("not EOF"))
            .collect();
        // Output the drain had not reached yet stays in the stream, in order.
        while !drained.iter().any(|line| line == "second") {
            drained.push(lines.next_line().await.unwrap().unwrap());
        }
        let large = drained
            .iter()
            .position(|line| line.len() == 1024 * 1024)
            .expect("1 MiB line kept whole");
        assert_eq!(drained[large + 1], "second");
        turn.shutdown().await;
    }

    #[tokio::test]
    async fn claude_startup_input_has_a_deadline() {
        let fixture = Fixture::new();
        let (turn, mut lines) = fixture_claude(&fixture, "no-read");
        let prompt = json!({ "type": "user", "blob": "y".repeat(2 * 1024 * 1024) });
        let error = timeout(
            Duration::from_secs(5),
            write_claude_startup_input(
                &turn,
                &[&prompt],
                &mut lines,
                Instant::now() + Duration::from_millis(300),
            ),
        )
        .await
        .expect("the deadline bounds a CLI that never reads")
        .unwrap_err();
        assert!(error.contains("in time"), "{error}");
        timeout(Duration::from_secs(5), turn.shutdown())
            .await
            .expect("the timed-out start is killed promptly");
        assert!(turn.child.lock().await.try_wait().unwrap().is_some());
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

async fn spawn_server(app: &AppHandle, state: &RuntimeState) -> Result<Arc<AppServer>, String> {
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
    let server_requests: Arc<Mutex<HashMap<String, CodexServerRequestIdentity>>> =
        Arc::new(Mutex::new(HashMap::new()));
    let server_requests_for_reader = server_requests.clone();
    let lifecycle_for_reader = state.lifecycle.clone();
    let instance = uuid::Uuid::new_v4().to_string();
    let instance_for_reader = instance.clone();
    state.lifecycle.begin_instance(&instance);

    // The stdout reader owns this task: stderr keeps reporting while the
    // transport is active and is retired with it, even when a descendant holds
    // the inherited pipe open.
    let stderr_task = stderr.map(|stderr| {
        let app_for_stderr = app.clone();
        tauri::async_runtime::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let _ =
                    app_for_stderr.emit("codex-event", json!({ "stream": "stderr", "line": line }));
            }
        })
    });

    tauri::async_runtime::spawn(async move {
        // A descendant can inherit stdout and hold it open after the direct
        // app-server exits. Watching the child ends the transport anyway, so
        // pending requests fail and the next request starts a replacement.
        let mut output = ProviderOutput::new(BufReader::new(stdout), child_for_reader.clone());
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

            let Ok(message) = serde_json::from_str::<Value>(&line) else {
                flush_deltas(&mut delta_buffer, &app_for_reader);
                let _ = app_for_reader.emit(
                    "codex-event",
                    json!({ "stream": "stderr", "line": format!("Invalid app-server message: {line}") }),
                );
                continue;
            };
            lifecycle_for_reader.observe_server_message(&instance_for_reader, &message);

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
        drop(child);
        // The pid is free for reuse from here on, so it must no longer be
        // published as ours.
        clear_server_identity(&identity_slot_for_reader, identity);
        lifecycle_for_reader.clear_instance(&instance_for_reader);
        if let Some(stderr_task) = stderr_task {
            finish_stderr_reader(stderr_task).await;
        }
    });

    let server = Arc::new(AppServer {
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
        server_requests,
        loaded_threads: RwLock::new(HashSet::new()),
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

    // The child's identity was published by spawn_server before initialize,
    // so the exit handler could already reach it during that window.
    let server = spawn_server(app, state).await?;
    *guard = Some(server.clone());
    Ok(server)
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
        return Err(format!(
            "Mythra Code's desktop bridge does not allow the RPC method `{method}`"
        ));
    }
    enforce_codex_delegation_config(&method, &mut params)?;
    validate_rpc_params(&method, &params)?;
    validate_native_codex_bridges(&app.state::<ChildAgentState>(), &method, &params).await?;
    // Register before `ensure_server` so a read cannot spawn a process in the
    // gap after a reserved restart has taken the old server out of the slot.
    let _rpc_guard = state.lifecycle.begin_rpc_call(&method)?;
    let server = ensure_server(&app, &state).await?;
    validate_native_codex_runtime(&method, &params, &server.runtime_version)?;
    if requests_native_codex(&method, &params) {
        let cwd = params.get("cwd").and_then(Value::as_str).filter(|cwd| !cwd.is_empty())
            .ok_or_else(|| "Native Codex startup requires its working directory to verify inherited bridges.".to_string())?;
        // One read from this existing process, only for native startup. Never
        // bootstrap another client or retry a failed safety inspection.
        let effective = server.request("config/read", json!({ "cwd": cwd, "includeLayers": false })).await
            .map_err(|_| "Could not verify inherited Mythra Code bridges. The native thread was not started; retry after the Codex runtime is available.".to_string())?;
        let bridge_params = native_codex_effective_bridge_params(&params, &effective["config"])?;
        validate_native_codex_bridges(&app.state::<ChildAgentState>(), &method, &bridge_params).await?;
    }
    if matches!(
        method.as_str(),
        "thread/start" | "thread/resume" | "thread/fork"
    ) {
        inject_openrouter_proxy_config(&mut params, server.openrouter_proxy_url.as_deref());
    }
    let result = match server.request(&method, params.clone()).await {
        Ok(result) => Ok(result),
        Err(error) if !server.is_alive() => {
            let dead = {
                let mut guard = state.server.lock().await;
                if guard
                    .as_ref()
                    .is_some_and(|current| Arc::ptr_eq(current, &server))
                {
                    guard.take()
                } else {
                    None
                }
            };
            // The process is gone, but shutdown still has to abort the
            // OpenRouter proxy task or its listener (and key) outlive the
            // server it belonged to.
            if let Some(dead) = dead {
                dead.shutdown().await;
            }
            let recovered = ensure_server(&app, &state).await.map_err(|restart_error| {
                format!("{error}. Mythra Code also could not restart the runtime: {restart_error}")
            })?;
            if RETRYABLE_METHODS.contains(&method.as_str()) {
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
        response_guard.finish(response.is_ok());
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

    if let Some(server) = state.server.lock().await.take() {
        server.shutdown().await;
    }
    let restarted = ensure_server(&app, &state).await.map(|_| ());
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

    if let Some(server) = state.server.lock().await.take() {
        server.shutdown().await;
    }
    let restarted = ensure_server(&app, &state).await.map(|_| ());
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
    if let Some(server) = state.server.lock().await.take() {
        server.shutdown().await;
    }
    let _ = ensure_server(&app, &state).await?;
    Ok(())
}

#[tauri::command]
fn reserve_runtime_restart(state: State<'_, RuntimeState>) -> Result<String, String> {
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
        .manage(CloseGuardState::default())
        .manage(StartupGuardState::default())
        .invoke_handler({
            let handler: Box<dyn Fn(tauri::ipc::Invoke) -> bool + Send + Sync> =
                Box::new(tauri::generate_handler![
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
                    claude_permission_respond,
                    claude_control_error,
                    cursor_turn_start,
                    cursor_turn_steer,
                    cursor_turn_interrupt,
                    cursor_turn_kill,
                    cursor_turn_active,
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
                    child_agent_respond,
                    child_agent_finished,
                    runtime_instance,
                    runtime_thread_state,
                    restart_runtime,
                    run_discovery_start,
                    run_discovery_cancel,
                    run_discovery::generate_thread_title,
                    run_discovery::analyze_user_preferences,
                    preference_learning::preference_learning_list,
                    preference_learning::preference_learning_save,
                    preference_learning::preference_learning_forget,
                    language_tools_snapshot,
                    language_tools_refresh,
                    language_tools_set_auto_install,
                    language_tools_install,
                    language_tools_set_enabled,
                    language_tools_prepare_project
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

#[cfg(test)]
mod tests;
