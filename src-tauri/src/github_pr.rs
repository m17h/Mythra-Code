//! Native GitHub pull-request operations.
//!
//! Mutations are serialized per repository for this process. This cannot
//! coordinate with another Mythra process or an external Git client, so every
//! mutation also re-checks the branch and caller-provided HEAD immediately
//! before changing local or remote state.

use std::{
    collections::HashMap,
    io::Read,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Mutex as StdMutex, OnceLock,
    },
    thread,
    time::{Duration, Instant},
};

use serde::Serialize;
use serde_json::Value;
use tauri::AppHandle;
use tokio::{
    process::Command,
    sync::{Mutex, OwnedMutexGuard},
};

#[cfg(test)]
use crate::process_launch::background_std_command;
use crate::{
    git_workspace::{bounded_git_output, spawn_scoped_git},
    github::{github_command, github_remote_url, parse_github_repository, resolve_github_binary},
    project_git::{optional_git_stdout, run_git},
};
#[cfg(test)]
use std::env;

const COMMAND_TIMEOUT: Duration = Duration::from_secs(30);
const MUTATION_TIMEOUT: Duration = Duration::from_secs(120);
const MAX_LIST_LIMIT: usize = 50;
const MAX_COMMAND_OUTPUT: usize = 1024 * 1024;

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(super) struct GitHubPrSummary {
    repository: String,
    number: u64,
    url: String,
    title: String,
    state: String,
    is_draft: bool,
    head_ref_name: String,
    base_ref_name: String,
    updated_at: String,
    author_login: Option<String>,
}

struct PrListQuery {
    search: Option<String>,
    state: String,
    limit: usize,
}

fn pr_list_query(
    repository: &str,
    search: Option<String>,
    state: Option<String>,
    limit: Option<usize>,
) -> Result<PrListQuery, String> {
    validate_repository(repository)?;
    let state = state.unwrap_or_else(|| "open".into());
    if !matches!(state.as_str(), "open" | "closed" | "merged" | "all") {
        return Err("Pull request state must be open, closed, merged, or all.".into());
    }
    let limit = limit.unwrap_or(30);
    if !(1..=MAX_LIST_LIMIT).contains(&limit) {
        return Err("Request between 1 and 50 pull requests at a time.".into());
    }
    if search
        .as_ref()
        .is_some_and(|value| value.chars().any(char::is_control) || value.chars().count() > 256)
    {
        return Err(
            "Pull request search must be at most 256 characters without control characters.".into(),
        );
    }
    let search = search
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    Ok(PrListQuery {
        search,
        state,
        limit,
    })
}

const PR_SUMMARY_FIELDS: &str =
    "number,url,title,state,isDraft,headRefName,baseRefName,updatedAt,author";

fn pr_summaries_from_json(
    repository: &str,
    value: &Value,
    limit: usize,
) -> Result<Vec<GitHubPrSummary>, String> {
    let items = value
        .as_array()
        .ok_or_else(|| "GitHub returned an invalid pull request list.".to_string())?;
    if items.len() > limit {
        return Err("GitHub returned more pull requests than requested.".into());
    }
    items
        .iter()
        .map(|item| {
            let get = |field: &str| {
                item.get(field)
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string()
            };
            let number = item
                .get("number")
                .and_then(Value::as_u64)
                .filter(|number| *number > 0)
                .ok_or_else(|| "GitHub did not report a valid pull request number.".to_string())?;
            let url = get("url");
            if !url.eq_ignore_ascii_case(&format!("https://github.com/{repository}/pull/{number}"))
            {
                return Err(
                    "GitHub returned a pull request outside the requested repository.".into(),
                );
            }
            let state = get("state").to_ascii_uppercase();
            if !matches!(state.as_str(), "OPEN" | "CLOSED" | "MERGED") {
                return Err("GitHub returned an unknown pull request state.".into());
            }
            Ok(GitHubPrSummary {
                repository: repository.to_string(),
                number,
                url,
                title: get("title"),
                state,
                is_draft: item
                    .get("isDraft")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                head_ref_name: get("headRefName"),
                base_ref_name: get("baseRefName"),
                updated_at: get("updatedAt"),
                author_login: item
                    .pointer("/author/login")
                    .and_then(Value::as_str)
                    .map(str::to_string),
            })
        })
        .collect()
}

async fn list_with(
    gh: &Path,
    repository: &str,
    query: PrListQuery,
) -> Result<Vec<GitHubPrSummary>, String> {
    let mut args = vec![
        "pr".to_string(),
        "list".into(),
        "--repo".into(),
        format!("github.com/{repository}"),
        "--state".into(),
        query.state,
        "--limit".into(),
        query.limit.to_string(),
        "--json".into(),
        PR_SUMMARY_FIELDS.into(),
    ];
    if let Some(search) = query.search {
        args.extend(["--search".into(), search]);
    }
    let borrowed_args: Vec<_> = args.iter().map(String::as_str).collect();
    pr_summaries_from_json(repository, &gh_json(gh, &borrowed_args).await?, query.limit)
}

fn project_for_pr_list(cwd: &str, expected: &str) -> Result<PathBuf, String> {
    let selected = selected_repository(cwd)?;
    let origin = github_remote_url(&selected, "origin")
        .and_then(|url| parse_github_repository(&url))
        .ok_or_else(|| {
            "Connect this project to a GitHub repository before listing pull requests.".to_string()
        })?;
    if !origin.eq_ignore_ascii_case(expected) {
        return Err(
            "This project's GitHub repository changed. Refresh before listing pull requests."
                .into(),
        );
    }
    Ok(selected)
}

/// One read-only, bounded page for the project PR home. This never attaches a
/// PR to a thread and never stages, commits, pushes, or changes authentication.
#[tauri::command]
pub(super) async fn github_pr_list(
    app: AppHandle,
    cwd: String,
    repository: String,
    search: Option<String>,
    state: Option<String>,
    limit: Option<usize>,
) -> Result<Vec<GitHubPrSummary>, String> {
    let query = pr_list_query(&repository, search, state, limit)?;
    let expected = repository.clone();
    blocking_local(move || project_for_pr_list(&cwd, &expected)).await?;
    list_with(&resolve_github_binary(&app).await?, &repository, query).await
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(super) struct GitHubPrCheck {
    name: String,
    state: String,
    url: String,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(super) struct GitHubPullRequest {
    repository: String,
    number: u64,
    url: String,
    title: String,
    body: String,
    state: String,
    is_draft: bool,
    head_ref_name: String,
    #[serde(skip_serializing)]
    head_repository_owner: String,
    base_ref_name: String,
    head_oid: String,
    mergeable: String,
    merge_state_status: String,
    review_decision: String,
    checks: Vec<GitHubPrCheck>,
    updated_at: String,
    can_merge: bool,
    viewer_can_merge: bool,
    auto_merge_allowed: bool,
    merge_methods: Vec<String>,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(super) struct GitHubPrCreateResult {
    #[serde(flatten)]
    pull_request: GitHubPullRequest,
    creation_outcome: GitHubPrCreationOutcome,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "lowercase")]
enum GitHubPrCreationOutcome {
    Created,
    Updated,
    Existing,
}

impl GitHubPrCreateResult {
    fn created(pull_request: GitHubPullRequest) -> Self {
        Self {
            pull_request,
            creation_outcome: GitHubPrCreationOutcome::Created,
        }
    }

    fn existing(pull_request: GitHubPullRequest) -> Self {
        Self {
            pull_request,
            creation_outcome: GitHubPrCreationOutcome::Existing,
        }
    }

    fn updated(pull_request: GitHubPullRequest) -> Self {
        Self {
            pull_request,
            creation_outcome: GitHubPrCreationOutcome::Updated,
        }
    }
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(super) struct GitHubPrContext {
    repository: String,
    branch: String,
    default_branch: String,
    head_oid: String,
    dirty: bool,
    ahead: usize,
    behind: usize,
    push_remote: String,
    permission: String,
    merge_methods: Vec<String>,
    changed_files: Vec<String>,
    changed_file_count: usize,
    commits: Vec<String>,
}

#[derive(Clone, Debug)]
struct RepositoryInfo {
    auto_merge_allowed: bool,
    default_branch: String,
    permission: String,
    merge_methods: Vec<String>,
}

fn mutation_locks() -> &'static StdMutex<HashMap<String, Arc<Mutex<()>>>> {
    static LOCKS: OnceLock<StdMutex<HashMap<String, Arc<Mutex<()>>>>> = OnceLock::new();
    LOCKS.get_or_init(|| StdMutex::new(HashMap::new()))
}

fn mutation_lock(repository: &str) -> Arc<Mutex<()>> {
    let mut locks = mutation_locks().lock().unwrap_or_else(|e| e.into_inner());
    locks
        .entry(repository.to_ascii_lowercase())
        .or_insert_with(|| Arc::new(Mutex::new(())))
        .clone()
}

/// A worker owns a clone of this lease. Dropping the IPC future cannot release
/// either lock while its blocking Git worker or mutating CLI child is active.
struct MutationLease {
    _local: Option<OwnedMutexGuard<()>>,
    _github: OwnedMutexGuard<()>,
}

async fn mutation_lease(
    selected: Option<&Path>,
    repository: &str,
) -> Result<Arc<MutationLease>, String> {
    // All PR workflows acquire local then GitHub; never reverse this order.
    let local = match selected {
        Some(selected) => Some(
            crate::git_workspace::repository_lock(selected)
                .await?
                .lock_owned()
                .await,
        ),
        None => None,
    };
    let github = mutation_lock(repository).lock_owned().await;
    Ok(Arc::new(MutationLease {
        _local: local,
        _github: github,
    }))
}

async fn blocking_mutation<T, F>(lease: Arc<MutationLease>, operation: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    blocking_local(move || {
        let _lease = lease;
        operation()
    })
    .await
}

fn validate_repository(repository: &str) -> Result<(), String> {
    let mut parts = repository.split('/');
    let valid_part = |value: &str| {
        !value.is_empty()
            && value.len() <= 100
            && !value.starts_with('-')
            && value
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
    };
    match (parts.next(), parts.next(), parts.next()) {
        (Some(owner), Some(name), None)
            if !matches!(owner, "." | "..")
                && !matches!(name, "." | "..")
                && valid_part(owner)
                && valid_part(name) =>
        {
            Ok(())
        }
        _ => Err("GitHub repository must be an owner/repository name.".into()),
    }
}

fn validate_ref(value: &str, label: &str) -> Result<(), String> {
    let invalid = value.is_empty()
        || value.len() > 255
        || value.starts_with('-')
        || value.starts_with('/')
        || value.ends_with('/')
        || value.ends_with('.')
        || value.contains("..")
        || value.contains("@{")
        || value.contains("//")
        || value.chars().any(|c| {
            c.is_control()
                || c.is_whitespace()
                || matches!(c, '~' | '^' | ':' | '?' | '*' | '[' | '\\')
        });
    if invalid {
        Err(format!("{label} is not a valid Git branch name."))
    } else {
        Ok(())
    }
}

fn validate_oid(oid: &str) -> Result<(), String> {
    (oid.len() == 40 && oid.bytes().all(|byte| byte.is_ascii_hexdigit()))
        .then_some(())
        .ok_or_else(|| "Expected HEAD must be a full 40-character Git commit ID.".into())
}

fn selected_repository(cwd: &str) -> Result<PathBuf, String> {
    let selected = PathBuf::from(cwd)
        .canonicalize()
        .map_err(|error| format!("Could not open the project folder: {error}"))?;
    let top = optional_git_stdout(&selected, &["rev-parse", "--show-toplevel"])
        .ok_or_else(|| "The selected folder is not a Git repository.".to_string())?;
    PathBuf::from(top)
        .canonicalize()
        .map_err(|error| format!("Could not open the Git repository: {error}"))
}

fn selected_mutation_repository(cwd: &str) -> Result<PathBuf, String> {
    let root = selected_repository(cwd)?;
    let selected = Path::new(cwd)
        .canonicalize()
        .map_err(|error| format!("Could not open the project folder: {error}"))?;
    if selected != root {
        return Err("Open the Git repository root before creating a branch or pull request. This project folder belongs to an enclosing repository.".into());
    }
    Ok(root)
}

async fn blocking_local<T, F>(operation: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(operation)
        .await
        .map_err(|error| format!("Local Git task failed: {error}"))?
}

fn git(cwd: &Path, args: &[&str]) -> Result<String, String> {
    let output = run_git(cwd, args, None)?;
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(if detail.is_empty() {
            "Git command failed.".into()
        } else {
            detail
        })
    }
}

async fn command_output(
    mut command: Command,
    limit: Duration,
    action: &str,
) -> Result<Vec<u8>, String> {
    command.stdin(Stdio::null()).kill_on_drop(true);
    let output = tokio::time::timeout(limit, command.output())
        .await
        .map_err(|_| format!("{action} timed out."))?
        .map_err(|error| format!("Could not run {action}: {error}"))?;
    if output.status.success() {
        Ok(output.stdout)
    } else {
        let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(if detail.is_empty() {
            format!("{action} failed.")
        } else {
            detail
        })
    }
}

fn mutation_git(
    cwd: &Path,
    args: &[&str],
    limit: Duration,
    action: &str,
) -> Result<String, String> {
    let network = args.first().is_some_and(|arg| *arg == "push");
    let (output, truncated) = bounded_git_output(cwd, args, limit, MAX_COMMAND_OUTPUT, network)
        .map_err(|error| format!("{action}: {error}"))?;
    if truncated {
        return Err(format!(
            "{action} produced too much output. Refresh before retrying."
        ));
    }
    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if detail.is_empty() {
            format!("{action} failed.")
        } else {
            detail
        });
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

fn commit_for_pr_with_timeout(cwd: &Path, message: &str, limit: Duration) -> Result<(), String> {
    let before = optional_git_stdout(cwd, &["rev-parse", "--verify", "HEAD"]);
    // App initialization uses a command-local identity. Keep its PR workflow
    // usable too, while preserving any complete user-configured identity.
    let identity = optional_git_stdout(cwd, &["config", "user.name"])
        .zip(optional_git_stdout(cwd, &["config", "user.email"]));
    let args = if identity.is_some() {
        vec!["commit", "-m", message]
    } else {
        vec![
            "-c",
            "user.name=Mythra Code",
            "-c",
            "user.email=openkiwi@local",
            "commit",
            "-m",
            message,
        ]
    };
    mutation_git(cwd, &args, limit, "Git commit")
        .map(|_| ())
        .map_err(|error| {
            let after = optional_git_stdout(cwd, &["rev-parse", "--verify", "HEAD"]);
            if after != before {
                if let Some(head) = after {
                    return format!("Git did not confirm completion of the requested commit: {error}\nHEAD is now {head}. A commit may already have been saved. Mythra Code did not attempt a push; refresh and inspect the local history, staged changes, and working files before trying again.");
                }
            }
            format!("Git did not confirm completion of the requested commit: {error}\nMythra Code did not attempt a push. Refresh and inspect the local history, staged changes, and working files before trying again.")
        })
}

async fn bounded_git(
    lease: Arc<MutationLease>,
    cwd: &Path,
    args: &[String],
    limit: Duration,
    action: &str,
) -> Result<String, String> {
    let cwd = cwd.to_path_buf();
    let args = args.to_vec();
    let action = action.to_string();
    blocking_mutation(lease, move || {
        let borrowed: Vec<_> = args.iter().map(String::as_str).collect();
        mutation_git(&cwd, &borrowed, limit, &action)
    })
    .await
}

struct CancelMutationChild(Arc<AtomicBool>);

impl Drop for CancelMutationChild {
    fn drop(&mut self) {
        self.0.store(true, Ordering::Release);
    }
}

fn drain_command_pipe(
    mut pipe: Box<dyn Read + Send>,
) -> mpsc::Receiver<Result<(Vec<u8>, bool), String>> {
    let (sender, receiver) = mpsc::sync_channel(1);
    thread::spawn(move || {
        let _ = sender.send(read_command_pipe(&mut pipe));
    });
    receiver
}

fn read_command_pipe(pipe: &mut dyn Read) -> Result<(Vec<u8>, bool), String> {
    let mut kept = Vec::new();
    let mut truncated = false;
    let mut chunk = [0; 8192];
    loop {
        let count = pipe
            .read(&mut chunk)
            .map_err(|error| format!("Could not read GitHub CLI output: {error}"))?;
        if count == 0 {
            return Ok((kept, truncated));
        }
        let retain = count.min(MAX_COMMAND_OUTPUT.saturating_sub(kept.len()));
        kept.extend_from_slice(&chunk[..retain]);
        truncated |= retain < count;
    }
}

/// The blocking child owner is cancelled by a signal, not by dropping its
/// future. It retains both leases through scoped kill/reap, then ends; cancellation
/// does not continue the remaining push/create/refresh workflow.
async fn mutation_command_output(
    lease: Arc<MutationLease>,
    command: Command,
    limit: Duration,
    action: &str,
) -> Result<Vec<u8>, String> {
    let action = action.to_string();
    let cancelled = Arc::new(AtomicBool::new(false));
    let _cancel_on_drop = CancelMutationChild(cancelled.clone());
    blocking_mutation(lease, move || {
        if cancelled.load(Ordering::Acquire) {
            return Err(format!("{action} was cancelled. Refresh before retrying."));
        }
        let mut command = command.into_std();
        command
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let deadline = Instant::now() + limit;
        let (mut child, scope) = spawn_scoped_git(&mut command)
            .map_err(|error| format!("Could not run {action}: {error}"))?;
        let stdout = drain_command_pipe(Box::new(child.stdout.take().unwrap()));
        let stderr = drain_command_pipe(Box::new(child.stderr.take().unwrap()));
        let interruption = || {
            if cancelled.load(Ordering::Acquire) {
                Some(format!("{action} was cancelled. Refresh before retrying."))
            } else if Instant::now() >= deadline {
                Some(format!("{action} timed out. Refresh before retrying."))
            } else {
                None
            }
        };
        let status = loop {
            if let Some(error) = interruption() {
                return Err(scope.stop(&mut child, error));
            }
            match child.try_wait() {
                Ok(Some(status)) => break status,
                Ok(None) => thread::sleep(Duration::from_millis(10)),
                Err(error) => {
                    return Err(
                        scope.stop(&mut child, format!("Could not wait for {action}: {error}"))
                    )
                }
            }
        };
        let mut receive = |reader: mpsc::Receiver<Result<(Vec<u8>, bool), String>>| loop {
            if let Some(error) = interruption() {
                return Err(scope.stop(&mut child, error));
            }
            match reader.try_recv() {
                Ok(Ok(value)) => return Ok(value),
                Ok(Err(error)) => return Err(scope.stop(&mut child, error)),
                Err(mpsc::TryRecvError::Disconnected) => {
                    return Err(scope.stop(&mut child, format!("Could not read {action} output.")))
                }
                Err(mpsc::TryRecvError::Empty) => thread::sleep(Duration::from_millis(10)),
            }
        };
        let (stdout, stdout_truncated) = receive(stdout)?;
        let (stderr, stderr_truncated) = receive(stderr)?;
        if stdout_truncated || stderr_truncated {
            return Err(format!(
                "{action} produced too much output. Refresh before retrying."
            ));
        }
        if status.success() {
            Ok(stdout)
        } else {
            let detail = String::from_utf8_lossy(&stderr).trim().to_string();
            Err(if detail.is_empty() {
                format!("{action} failed.")
            } else {
                detail
            })
        }
    })
    .await
}

async fn gh_json(path: &Path, args: &[&str]) -> Result<Value, String> {
    let mut command = github_command(path);
    command.args(args);
    let bytes = command_output(command, COMMAND_TIMEOUT, "GitHub CLI").await?;
    serde_json::from_slice(&bytes).map_err(|error| format!("GitHub returned invalid data: {error}"))
}

fn repository_info_from_json(value: &Value) -> Result<RepositoryInfo, String> {
    let default_branch = value
        .get("default_branch")
        .and_then(Value::as_str)
        .filter(|v| !v.is_empty())
        .ok_or_else(|| "GitHub did not report a default branch.".to_string())?
        .to_string();
    let permission = value
        .pointer("/permissions/admin")
        .and_then(Value::as_bool)
        .filter(|v| *v)
        .map(|_| "admin")
        .or_else(|| {
            value
                .pointer("/permissions/maintain")
                .and_then(Value::as_bool)
                .filter(|v| *v)
                .map(|_| "maintain")
        })
        .or_else(|| {
            value
                .pointer("/permissions/push")
                .and_then(Value::as_bool)
                .filter(|v| *v)
                .map(|_| "write")
        })
        .or_else(|| {
            value
                .pointer("/permissions/triage")
                .and_then(Value::as_bool)
                .filter(|v| *v)
                .map(|_| "triage")
        })
        .or_else(|| {
            value
                .pointer("/permissions/pull")
                .and_then(Value::as_bool)
                .filter(|v| *v)
                .map(|_| "read")
        })
        .unwrap_or("none")
        .to_string();
    let mut merge_methods = Vec::new();
    for (field, name) in [
        ("allow_squash_merge", "squash"),
        ("allow_merge_commit", "merge"),
        ("allow_rebase_merge", "rebase"),
    ] {
        if value.get(field).and_then(Value::as_bool) == Some(true) {
            merge_methods.push(name.to_string());
        }
    }
    Ok(RepositoryInfo {
        auto_merge_allowed: value
            .get("allow_auto_merge")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        default_branch,
        permission,
        merge_methods,
    })
}

async fn repository_info(gh: &Path, repository: &str) -> Result<RepositoryInfo, String> {
    validate_repository(repository)?;
    let endpoint = format!("repos/{repository}");
    repository_info_from_json(&gh_json(gh, &["api", "--method", "GET", "--", &endpoint]).await?)
}

fn check_from_json(value: &Value) -> GitHubPrCheck {
    GitHubPrCheck {
        name: value
            .get("name")
            .or_else(|| value.get("context"))
            .and_then(Value::as_str)
            .unwrap_or("Unknown check")
            .to_string(),
        // CheckRun includes a null/empty conclusion until it finishes. Keep
        // its pending status visible instead of reporting an unknown result.
        state: ["conclusion", "state", "status"]
            .iter()
            .filter_map(|key| value.get(key).and_then(Value::as_str))
            .map(str::trim)
            .find(|state| !state.is_empty())
            .unwrap_or("UNKNOWN")
            .to_ascii_uppercase(),
        url: value
            .get("detailsUrl")
            .or_else(|| value.get("targetUrl"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
    }
}

fn pull_request_from_json(
    repository: &str,
    value: &Value,
    info: &RepositoryInfo,
) -> Result<GitHubPullRequest, String> {
    let get = |name: &str| {
        value
            .get(name)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string()
    };
    let mut state = get("state").to_ascii_uppercase();
    if value.get("mergedAt").is_some_and(|v| !v.is_null()) {
        state = "MERGED".into();
    }
    if !matches!(state.as_str(), "OPEN" | "CLOSED" | "MERGED") {
        return Err("GitHub returned an unknown pull request state.".into());
    }
    let checks: Vec<_> = value
        .get("statusCheckRollup")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .map(check_from_json)
        .collect();
    let permission_ok = matches!(info.permission.as_str(), "write" | "maintain" | "admin");
    let checks_ok = checks
        .iter()
        .all(|check| matches!(check.state.as_str(), "SUCCESS" | "NEUTRAL" | "SKIPPED"));
    let mergeable = get("mergeable").to_ascii_uppercase();
    let merge_state_status = get("mergeStateStatus").to_ascii_uppercase();
    let review_decision = get("reviewDecision").to_ascii_uppercase();
    let can_merge = state == "OPEN"
        && !value
            .get("isDraft")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        && permission_ok
        && !info.merge_methods.is_empty()
        && mergeable == "MERGEABLE"
        && checks_ok
        && matches!(merge_state_status.as_str(), "CLEAN" | "HAS_HOOKS")
        && !matches!(
            review_decision.as_str(),
            "CHANGES_REQUESTED" | "REVIEW_REQUIRED"
        );
    Ok(GitHubPullRequest {
        repository: repository.to_string(),
        number: value
            .get("number")
            .and_then(Value::as_u64)
            .ok_or_else(|| "GitHub did not report a pull request number.".to_string())?,
        url: get("url"),
        title: get("title"),
        body: get("body"),
        state,
        is_draft: value
            .get("isDraft")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        head_ref_name: get("headRefName"),
        head_repository_owner: value
            .pointer("/headRepositoryOwner/login")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        base_ref_name: get("baseRefName"),
        head_oid: get("headRefOid"),
        mergeable,
        merge_state_status,
        review_decision,
        checks,
        updated_at: get("updatedAt"),
        can_merge,
        viewer_can_merge: permission_ok,
        auto_merge_allowed: info.auto_merge_allowed,
        merge_methods: info.merge_methods.clone(),
    })
}

const PR_FIELDS: &str = "number,url,title,body,state,isDraft,headRefName,headRepositoryOwner,baseRefName,headRefOid,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup,updatedAt,mergedAt,author";

fn ensure_pull_request_identity(
    pull_request: &GitHubPullRequest,
    repository: &str,
    head: &str,
    base: &str,
    expected_oid: Option<&str>,
) -> Result<(), String> {
    let expected_owner = repository.split('/').next().unwrap_or_default();
    if !pull_request
        .head_repository_owner
        .eq_ignore_ascii_case(expected_owner)
        || pull_request.head_ref_name != head
        || pull_request.base_ref_name != base
    {
        return Err("GitHub returned a pull request for a different source or target. Refresh before retrying.".into());
    }
    if expected_oid.is_some_and(|oid| pull_request.head_oid != oid) {
        return Err("The remote pull request head changed while the branch was being published. Refresh and review the remote commit before retrying.".into());
    }
    Ok(())
}

async fn view_with(gh: &Path, repository: &str, number: u64) -> Result<GitHubPullRequest, String> {
    validate_repository(repository)?;
    if number == 0 {
        return Err("Pull request number must be positive.".into());
    }
    let info = repository_info(gh, repository).await?;
    let number = number.to_string();
    let value = gh_json(
        gh,
        &[
            "pr", "view", "--repo", repository, "--json", PR_FIELDS, "--", &number,
        ],
    )
    .await?;
    pull_request_from_json(repository, &value, &info)
}

async fn find_with(
    gh: &Path,
    repository: &str,
    branch: &str,
    base: Option<&str>,
) -> Result<Option<GitHubPullRequest>, String> {
    validate_repository(repository)?;
    validate_ref(branch, "Branch")?;
    if let Some(base) = base {
        validate_ref(base, "Base branch")?;
    }
    let info = repository_info(gh, repository).await?;
    let base = base.unwrap_or(&info.default_branch);
    validate_ref(base, "Base branch")?;
    let value = gh_json(
        gh,
        &[
            "pr", "list", "--repo", repository, "--state", "open", "--head", branch, "--base",
            base, "--limit", "20", "--json", PR_FIELDS,
        ],
    )
    .await?;
    let items = value
        .as_array()
        .ok_or_else(|| "GitHub returned an invalid pull request list.".to_string())?;
    for item in items {
        let pull_request = pull_request_from_json(repository, item, &info)?;
        if ensure_pull_request_identity(&pull_request, repository, branch, base, None).is_ok() {
            return Ok(Some(pull_request));
        }
    }
    Ok(None)
}

fn remote_for_repository(cwd: &Path, repository: &str) -> Result<String, String> {
    let remotes = git(cwd, &["remote"])?;
    for remote in remotes.lines() {
        if let Some(url) = github_remote_url(cwd, remote) {
            if parse_github_repository(&url)
                .as_deref()
                .is_some_and(|found| found.eq_ignore_ascii_case(repository))
            {
                let push_urls = git(cwd, &["remote", "get-url", "--push", "--all", remote])?;
                let pushes_to_target = !push_urls.is_empty()
                    && push_urls.lines().all(|push_url| {
                        parse_github_repository(push_url)
                            .as_deref()
                            .is_some_and(|found| found.eq_ignore_ascii_case(repository))
                    });
                if pushes_to_target {
                    return Ok(remote.to_string());
                }
            }
        }
    }
    Err(format!("No Git remote points to {repository}. Creating pull requests from a fork is not supported yet."))
}

#[derive(PartialEq, Eq)]
struct PrPushBinding {
    remote: String,
    fetch_url: String,
    push_url: String,
    fetch_refspecs: Vec<String>,
}

fn pr_push_binding(cwd: &Path, remote: &str, repository: &str) -> Result<PrPushBinding, String> {
    let fetch_url = github_remote_url(cwd, remote).ok_or_else(|| {
        "The Git remote changed before the branch could be pushed. Refresh and try again."
            .to_string()
    })?;
    // Keep the configured identity separate from Git's transport rewrites.
    // An explicit URL pins the destination even if another client changes the
    // named remote after this check; existing insteadOf/credential rules remain.
    let push_url = optional_git_stdout(
        cwd,
        &["config", "--get-all", &format!("remote.{remote}.pushurl")],
    )
    .unwrap_or_else(|| fetch_url.clone());
    if !parse_github_repository(&fetch_url)
        .is_some_and(|found| found.eq_ignore_ascii_case(repository))
        || !parse_github_repository(&push_url)
            .is_some_and(|found| found.eq_ignore_ascii_case(repository))
    {
        return Err("The Git remote changed before the branch could be pushed. Origin must have one fetch and one push URL matching the reviewed GitHub repository. Refresh and try again.".into());
    }
    Ok(PrPushBinding {
        remote: remote.into(),
        fetch_url,
        push_url,
        fetch_refspecs: optional_git_stdout(
            cwd,
            &["config", "--get-all", &format!("remote.{remote}.fetch")],
        )
        .map(|value| value.lines().map(str::to_owned).collect())
        .unwrap_or_default(),
    })
}

fn mapped_ref(reference: &str, pattern: &str) -> Option<String> {
    match pattern.split_once('*') {
        Some((prefix, suffix)) if !suffix.contains('*') => reference
            .strip_prefix(prefix)?
            .strip_suffix(suffix)
            .map(str::to_owned),
        None if reference == pattern => Some(String::new()),
        _ => None,
    }
}

fn pr_tracking_refs(
    cwd: &Path,
    binding: &PrPushBinding,
    head: &str,
) -> Result<Vec<(String, Option<String>)>, String> {
    let source = format!("refs/heads/{head}");
    if binding.fetch_refspecs.iter().any(|spec| {
        spec.strip_prefix('^')
            .is_some_and(|pattern| mapped_ref(&source, pattern).is_some())
    }) {
        return Ok(Vec::new());
    }
    let mut targets = Vec::new();
    for spec in &binding.fetch_refspecs {
        let Some((from, to)) = spec.trim_start_matches('+').split_once(':') else {
            continue;
        };
        let Some(middle) = mapped_ref(&source, from) else {
            continue;
        };
        let target = if from.contains('*') && to.matches('*').count() == 1 {
            to.replace('*', &middle)
        } else if !from.contains('*') && !to.contains('*') {
            to.to_owned()
        } else {
            return Err("The remote fetch mapping cannot be safely recorded. Refresh and inspect it before creating the pull request.".into());
        };
        git(cwd, &["check-ref-format", &target])?;
        if target.starts_with("refs/heads/") {
            return Err("The remote fetch mapping targets a local branch. That branch was not rewritten; inspect its mapping before creating the pull request.".into());
        }
        if optional_git_stdout(cwd, &["symbolic-ref", "--quiet", &target]).is_some() {
            return Err("The remote tracking mapping is symbolic. It was not rewritten; inspect it before creating the pull request.".into());
        }
        if !targets.iter().any(|(found, _)| found == &target) {
            let old = optional_git_stdout(cwd, &["rev-parse", "--verify", &target]);
            targets.push((target, old));
        }
    }
    Ok(targets)
}

fn record_pr_tracking(
    cwd: &Path,
    binding: &PrPushBinding,
    repository: &str,
    oid: &str,
    tracking: &[(String, Option<String>)],
) -> Result<(), String> {
    if pr_push_binding(cwd, &binding.remote, repository)? != *binding {
        return Err("The Git remote changed during the push. Its tracking refs were not changed; refresh before trying again.".into());
    }
    for (reference, old) in tracking {
        if optional_git_stdout(cwd, &["symbolic-ref", "--quiet", reference]).is_some() {
            return Err("A remote tracking ref became symbolic during the push. It was not rewritten; refresh and inspect it.".into());
        }
        git(
            cwd,
            &[
                "update-ref",
                "--no-deref",
                reference,
                oid,
                old.as_deref().unwrap_or(&"0".repeat(oid.len())),
            ],
        )?;
    }
    Ok(())
}

fn branch_and_head(cwd: &Path) -> Result<(String, String), String> {
    let branch = git(cwd, &["symbolic-ref", "--short", "-q", "HEAD"])
        .map_err(|_| "Pull requests cannot be created from a detached HEAD.".to_string())?;
    validate_ref(&branch, "Current branch")?;
    Ok((branch, git(cwd, &["rev-parse", "HEAD"])?))
}

fn divergence(cwd: &Path, remote: &str, branch: &str) -> (usize, usize) {
    optional_git_stdout(
        cwd,
        &[
            "rev-list",
            "--left-right",
            "--count",
            &format!("HEAD...{remote}/{branch}"),
        ],
    )
    .and_then(|counts| {
        let mut p = counts.split_whitespace();
        Some((p.next()?.parse().ok()?, p.next()?.parse().ok()?))
    })
    .unwrap_or((0, 0))
}

fn ensure_local_base(cwd: &Path, remote: &str, base: &str) -> Result<(), String> {
    let reference = format!("refs/remotes/{remote}/{base}");
    let output = run_git(cwd, &["show-ref", "--verify", "--quiet", &reference], None)?;
    output.status.success().then_some(()).ok_or_else(|| {
        format!("The local Git data does not include {remote}/{base}. Fetch from {remote}, then refresh pull request context.")
    })
}

fn committed_delta(cwd: &Path, remote: &str, base: &str) -> Result<usize, String> {
    git(
        cwd,
        &["rev-list", "--count", &format!("{remote}/{base}..HEAD")],
    )?
    .parse::<usize>()
    .map_err(|_| "Git returned an invalid committed-change count.".to_string())
}

fn push_oid_for(
    cwd: &Path,
    expected_branch: &str,
    expected_head_oid: &str,
    committed_all: bool,
) -> Result<String, String> {
    let (branch, head_oid) = branch_and_head(cwd)?;
    if branch != expected_branch {
        return Err(
            "The current branch changed before it could be pushed. Refresh and try again.".into(),
        );
    }
    if committed_all {
        let parent = git(cwd, &["rev-parse", &format!("{head_oid}^")])?;
        if parent != expected_head_oid {
            return Err("The branch changed while creating the requested commit. The new commit was not pushed; refresh and review the local history.".into());
        }
    } else if head_oid != expected_head_oid {
        return Err("HEAD changed before it could be pushed. Refresh and review the new commit before continuing.".into());
    }
    Ok(head_oid)
}

fn changed_files(cwd: &Path) -> Result<(Vec<String>, usize), String> {
    let output = run_git(
        cwd,
        &["status", "--porcelain=v1", "-z", "--untracked-files=normal"],
        None,
    )?;
    if !output.status.success() {
        return Err("Could not inspect changed files.".into());
    }
    let status_output = String::from_utf8_lossy(&output.stdout);
    let entries: Vec<&str> = status_output
        .split('\0')
        .filter(|entry| !entry.is_empty())
        .collect();
    let mut paths = Vec::new();
    let mut index = 0;
    while index < entries.len() {
        let entry = entries[index];
        let status = entry.get(..2).unwrap_or_default();
        if let Some(path) = entry.get(3..) {
            paths.push(path.to_string());
        }
        // In porcelain v1 -z, rename/copy entries are followed by the source
        // path. Show the destination (the first path) and skip that source.
        index += if status.contains('R') || status.contains('C') {
            2
        } else {
            1
        };
    }
    let count = paths.len();
    paths.truncate(100);
    Ok((paths, count))
}

fn branch_commits(cwd: &Path, remote: &str, base: &str) -> Vec<String> {
    optional_git_stdout(
        cwd,
        &[
            "log",
            "--format=%s",
            "--max-count=100",
            &format!("{remote}/{base}..HEAD"),
        ],
    )
    .map(|subjects| subjects.lines().map(str::to_string).collect())
    .unwrap_or_default()
}

#[tauri::command]
pub(super) async fn github_pr_context(
    app: AppHandle,
    cwd: String,
) -> Result<GitHubPrContext, String> {
    let (selected, branch, head_oid, repository, push_remote) = blocking_local(move || {
        let selected = selected_repository(&cwd)?;
        let (branch, head_oid) = branch_and_head(&selected)?;
        let origin = github_remote_url(&selected, "origin")
            .ok_or_else(|| "This repository has no origin remote.".to_string())?;
        let repository = parse_github_repository(&origin)
            .ok_or_else(|| "The origin remote is not a GitHub repository.".to_string())?;
        let push_remote = remote_for_repository(&selected, &repository)?;
        Ok((selected, branch, head_oid, repository, push_remote))
    })
    .await?;
    let gh = resolve_github_binary(&app).await?;
    let info = repository_info(&gh, &repository).await?;
    let base = info.default_branch.clone();
    let local_selected = selected.clone();
    let local_remote = push_remote.clone();
    let (ahead, behind, dirty, changed_files, changed_file_count, commits) =
        blocking_local(move || {
            ensure_local_base(&local_selected, &local_remote, &base)?;
            let (ahead, behind) = divergence(&local_selected, &local_remote, &base);
            let dirty = !git(
                &local_selected,
                &["status", "--porcelain", "--untracked-files=normal"],
            )?
            .is_empty();
            let (changed_files, changed_file_count) = changed_files(&local_selected)?;
            let commits = branch_commits(&local_selected, &local_remote, &base);
            Ok((
                ahead,
                behind,
                dirty,
                changed_files,
                changed_file_count,
                commits,
            ))
        })
        .await?;
    Ok(GitHubPrContext {
        repository,
        branch,
        default_branch: info.default_branch,
        head_oid,
        dirty,
        ahead,
        behind,
        push_remote,
        permission: info.permission,
        merge_methods: info.merge_methods,
        changed_files,
        changed_file_count,
        commits,
    })
}

#[tauri::command]
pub(super) async fn github_pr_view(
    app: AppHandle,
    cwd: String,
    repository: String,
    number: u64,
) -> Result<GitHubPullRequest, String> {
    blocking_local(move || selected_repository(&cwd).map(|_| ())).await?;
    view_with(&resolve_github_binary(&app).await?, &repository, number).await
}

#[tauri::command]
pub(super) async fn github_pr_find(
    app: AppHandle,
    cwd: String,
    repository: String,
    branch: String,
) -> Result<Option<GitHubPullRequest>, String> {
    blocking_local(move || selected_repository(&cwd).map(|_| ())).await?;
    find_with(
        &resolve_github_binary(&app).await?,
        &repository,
        &branch,
        None,
    )
    .await
}

fn create_preflight(
    cwd: &Path,
    repository: &str,
    head: &str,
    base: &str,
    expected: &str,
    default_branch: &str,
) -> Result<String, String> {
    validate_repository(repository)?;
    validate_ref(head, "Head branch")?;
    validate_ref(base, "Base branch")?;
    validate_oid(expected)?;
    if head == base {
        return Err("Head and base branches must be different.".into());
    }
    let (branch, oid) = branch_and_head(cwd)?;
    if branch != head {
        return Err(format!(
            "The current branch changed from {head} to {branch}. Refresh and try again."
        ));
    }
    if oid != expected {
        return Err("HEAD changed since this pull request form was opened. Refresh and review the new commit before continuing.".into());
    }
    if branch == default_branch {
        return Err("Create a topic branch before opening a pull request; the current branch is the repository default branch.".into());
    }
    Ok(oid)
}

#[tauri::command]
pub(super) async fn github_pr_branch(
    app: AppHandle,
    cwd: String,
    name: String,
    expected_head_oid: String,
) -> Result<(), String> {
    validate_ref(&name, "New branch")?;
    validate_oid(&expected_head_oid)?;
    let (selected, repository) = blocking_local(move || {
        let selected = selected_mutation_repository(&cwd)?;
        let origin = github_remote_url(&selected, "origin")
            .ok_or_else(|| "This repository has no origin remote.".to_string())?;
        let repository = parse_github_repository(&origin)
            .ok_or_else(|| "The origin remote is not a GitHub repository.".to_string())?;
        Ok((selected, repository))
    })
    .await?;
    // Resolve availability without making a network request or changing auth.
    let _ = resolve_github_binary(&app).await?;
    branch_with(selected, repository, name, expected_head_oid).await
}

async fn branch_with(
    selected: PathBuf,
    repository: String,
    name: String,
    expected_head_oid: String,
) -> Result<(), String> {
    let lease = mutation_lease(Some(&selected), &repository).await?;
    blocking_mutation(lease, move || {
        let (_, current_oid) = branch_and_head(&selected)?;
        if current_oid != expected_head_oid {
            return Err(
                "HEAD changed since the branch action was opened. Refresh and try again.".into(),
            );
        }
        if run_git(
            &selected,
            &[
                "show-ref",
                "--verify",
                "--quiet",
                &format!("refs/heads/{name}"),
            ],
            None,
        )?
        .status
        .success()
        {
            return Err(format!("A local branch named {name} already exists."));
        }
        mutation_git(
            &selected,
            &["switch", "-c", &name],
            MUTATION_TIMEOUT,
            "Git branch creation",
        )
        .map(|_| ())
    })
    .await
}

fn merge_args(
    repository: &str,
    number: u64,
    method: &str,
    expected: &str,
    auto: bool,
) -> Result<Vec<String>, String> {
    validate_repository(repository)?;
    validate_oid(expected)?;
    let flag = match method {
        "squash" => "--squash",
        "merge" => "--merge",
        "rebase" => "--rebase",
        _ => return Err("Merge method must be squash, merge, or rebase.".into()),
    };
    if number == 0 {
        return Err("Pull request number must be positive.".into());
    }
    let mut args = vec![
        "pr".into(),
        "merge".into(),
        "--repo".into(),
        repository.into(),
        flag.into(),
        "--match-head-commit".into(),
        expected.into(),
    ];
    if auto {
        args.push("--auto".into());
    }
    args.push("--".into());
    args.push(number.to_string());
    Ok(args)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub(super) async fn github_pr_create(
    app: AppHandle,
    cwd: String,
    repository: String,
    head: String,
    base: String,
    title: String,
    body: String,
    draft: bool,
    commit_message: Option<String>,
    commit_all: bool,
    expected_head_oid: String,
) -> Result<GitHubPrCreateResult, String> {
    let title = title.trim().to_string();
    if title.is_empty() || title.chars().count() > 256 {
        return Err("Pull request title must be 1–256 characters.".into());
    }
    let selected = blocking_local(move || selected_mutation_repository(&cwd)).await?;
    let gh = resolve_github_binary(&app).await?;
    create_with(
        selected,
        gh,
        repository,
        head,
        base,
        title,
        body,
        draft,
        commit_message,
        commit_all,
        expected_head_oid,
    )
    .await
}

#[allow(clippy::too_many_arguments)]
async fn create_with(
    selected: PathBuf,
    gh: PathBuf,
    repository: String,
    head: String,
    base: String,
    title: String,
    body: String,
    draft: bool,
    commit_message: Option<String>,
    commit_all: bool,
    expected_head_oid: String,
) -> Result<GitHubPrCreateResult, String> {
    let lease = mutation_lease(Some(&selected), &repository).await?;
    let info = repository_info(&gh, &repository).await?;
    let preflight_selected = selected.clone();
    let preflight_repository = repository.clone();
    let preflight_head = head.clone();
    let preflight_base = base.clone();
    let preflight_expected = expected_head_oid.clone();
    let preflight_default = info.default_branch.clone();
    blocking_mutation(lease.clone(), move || {
        create_preflight(
            &preflight_selected,
            &preflight_repository,
            &preflight_head,
            &preflight_base,
            &preflight_expected,
            &preflight_default,
        )
        .map(|_| ())
    })
    .await?;
    if let Some(existing) = find_with(&gh, &repository, &head, Some(&base)).await? {
        return Ok(GitHubPrCreateResult::existing(existing));
    }
    // Network reads above may take long enough for an external Git client to
    // move the checkout. Revalidate immediately before any local mutation.
    let mutation_default = info.default_branch.clone();
    let mutation_repository = repository.clone();
    let mutation_head = head.clone();
    let mutation_base = base.clone();
    let mutation_expected = expected_head_oid.clone();
    let commit_message = if commit_all {
        Some(
            commit_message
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .unwrap_or("Update project files")
                .to_string(),
        )
    } else if commit_message
        .as_deref()
        .is_some_and(|value| !value.trim().is_empty())
    {
        return Err("A commit message can only be used when commit all is selected.".into());
    } else {
        None
    };
    let (selected, binding) = blocking_mutation(lease.clone(), move || {
        create_preflight(
            &selected,
            &mutation_repository,
            &mutation_head,
            &mutation_base,
            &mutation_expected,
            &mutation_default,
        )?;
        let remote = remote_for_repository(&selected, &mutation_repository)?;
        ensure_local_base(&selected, &remote, &mutation_base)?;
        let binding = pr_push_binding(&selected, &remote, &mutation_repository)?;
        if commit_all {
            mutation_git(&selected, &["add", "-A"], MUTATION_TIMEOUT, "Git stage")?;
        }
        Ok((selected, binding))
    })
    .await?;
    if let Some(message) = commit_message {
        let commit_selected = selected.clone();
        blocking_mutation(lease.clone(), move || {
            commit_for_pr_with_timeout(&commit_selected, &message, MUTATION_TIMEOUT)
        })
        .await?;
    }
    let verify_selected = selected.clone();
    let verify_head = head.clone();
    let verify_base = base.clone();
    let verify_remote = binding.remote.clone();
    let verify_expected = expected_head_oid.clone();
    let (refspec, pushed_oid) = blocking_mutation(lease.clone(), move || {
        if committed_delta(&verify_selected, &verify_remote, &verify_base)? == 0 { return Err("There are no committed changes to include in this pull request. Commit changes explicitly or select Commit all changes.".into()); }
        let push_oid = push_oid_for(&verify_selected, &verify_head, &verify_expected, commit_all)?;
        Ok((format!("{push_oid}:refs/heads/{verify_head}"), push_oid))
    }).await?;
    let verify_selected = selected.clone();
    let verify_repository = repository.clone();
    let verify_tracking_head = head.clone();
    let binding = blocking_mutation(lease.clone(), move || {
        if pr_push_binding(&verify_selected, &binding.remote, &verify_repository)? != binding {
            return Err("The Git remote changed while creating the requested commit. The local commit was retained but was not pushed. Refresh and review the remote before trying again.".into());
        }
        let tracking = pr_tracking_refs(&verify_selected, &binding, &verify_tracking_head)?;
        Ok((binding, tracking))
    }).await?;
    let (binding, tracking) = binding;
    bounded_git(
        lease.clone(),
        &selected,
        &[
            "push".into(),
            "--no-follow-tags".into(),
            "--".into(),
            binding.push_url.clone(),
            refspec,
        ],
        MUTATION_TIMEOUT,
        "Git push",
    )
    .await
    .map_err(|error| {
        if commit_all {
            format!("The commit was created locally, but the branch was not pushed: {error}")
        } else {
            format!("The branch was not pushed: {error}")
        }
    })?;
    let tracking_selected = selected.clone();
    let tracking_repository = repository.clone();
    let tracking_oid = pushed_oid.clone();
    blocking_mutation(lease.clone(), move || record_pr_tracking(&tracking_selected, &binding, &tracking_repository, &tracking_oid, &tracking)).await
        .map_err(|error| format!("The branch was pushed, but its local tracking could not be recorded: {error}. Refresh and inspect the remote before retrying."))?;
    if let Some(existing) = find_with(&gh, &repository, &head, Some(&base)).await? {
        ensure_pull_request_identity(&existing, &repository, &head, &base, Some(&pushed_oid))?;
        return Ok(GitHubPrCreateResult::updated(existing));
    }
    let mut command = github_command(&gh);
    command.args([
        "pr",
        "create",
        "--repo",
        &repository,
        "--head",
        &head,
        "--base",
        &base,
        "--title",
        &title,
        "--body",
        &body,
    ]);
    if draft {
        command.arg("--draft");
    }
    let output = mutation_command_output(lease.clone(), command, MUTATION_TIMEOUT, "GitHub pull request creation").await
        .map_err(|error| format!("The branch was pushed, but GitHub did not confirm pull request creation. Refresh before retrying: {error}"))?;
    let url = String::from_utf8_lossy(&output).trim().to_string();
    let number = url
        .rsplit('/')
        .next()
        .and_then(|v| v.parse().ok())
        .ok_or_else(|| {
            format!("GitHub reported that the pull request was created at {url}, but its number could not be read. Refresh before retrying.")
        })?;
    let created = view_with(&gh, &repository, number).await.map_err(|error| {
        format!("GitHub reported that the pull request was created at {url}, but its details could not be refreshed: {error}. Refresh before retrying.")
    })?;
    ensure_pull_request_identity(&created, &repository, &head, &base, Some(&pushed_oid))
        .map_err(|error| format!("GitHub reported that the pull request was created at {url}, but its identity could not be confirmed: {error}"))?;
    Ok(GitHubPrCreateResult::created(created))
}

#[tauri::command]
pub(super) async fn github_pr_merge(
    app: AppHandle,
    cwd: String,
    repository: String,
    number: u64,
    method: String,
    expected_head_oid: String,
    auto: bool,
) -> Result<GitHubPullRequest, String> {
    let selected = blocking_local(move || selected_repository(&cwd)).await?;
    let gh = resolve_github_binary(&app).await?;
    let lease = mutation_lease(Some(&selected), &repository).await?;
    let current = view_with(&gh, &repository, number).await?;
    if current.head_oid != expected_head_oid {
        return Err(
            "The pull request head changed. Refresh and review the new commit before merging."
                .into(),
        );
    }
    if !current
        .merge_methods
        .iter()
        .any(|allowed| allowed == &method)
    {
        return Err(format!("The repository does not allow {method} merges."));
    }
    let info = repository_info(&gh, &repository).await?;
    if !matches!(info.permission.as_str(), "write" | "maintain" | "admin") {
        return Err(
            "Your GitHub account does not have permission to merge this pull request.".into(),
        );
    }
    if current.state != "OPEN" || current.is_draft || current.mergeable == "CONFLICTING" {
        return Err(
            "Only an open, non-draft pull request without merge conflicts can be merged.".into(),
        );
    }
    if auto && !current.auto_merge_allowed {
        return Err("This repository does not allow automatic merging.".into());
    }
    if !auto && !current.can_merge {
        return Err("This pull request is not currently mergeable. Refresh its checks and review status before merging.".into());
    }
    let args = merge_args(&repository, number, &method, &expected_head_oid, auto)?;
    let mut command = github_command(&gh);
    command.args(args);
    mutation_command_output(
        lease.clone(),
        command,
        MUTATION_TIMEOUT,
        "GitHub pull request merge",
    )
    .await?;
    view_with(&gh, &repository, number).await
}

#[tauri::command]
pub(super) async fn github_pr_ready(
    app: AppHandle,
    cwd: String,
    repository: String,
    number: u64,
    expected_head_oid: String,
) -> Result<GitHubPullRequest, String> {
    blocking_local(move || selected_repository(&cwd).map(|_| ())).await?;
    validate_repository(&repository)?;
    validate_oid(&expected_head_oid)?;
    if number == 0 {
        return Err("Pull request number must be positive.".into());
    }
    let gh = resolve_github_binary(&app).await?;
    let lease = mutation_lease(None, &repository).await?;
    let info = repository_info(&gh, &repository).await?;
    let number_text = number.to_string();
    let value = gh_json(
        &gh,
        &[
            "pr",
            "view",
            "--repo",
            &repository,
            "--json",
            PR_FIELDS,
            "--",
            &number_text,
        ],
    )
    .await?;
    let current = pull_request_from_json(&repository, &value, &info)?;
    if current.head_oid != expected_head_oid {
        return Err("The pull request head changed. Refresh and review the new commit before marking it ready.".into());
    }
    if current.state != "OPEN" || !current.is_draft {
        return Err("Only an open draft pull request can be marked ready for review.".into());
    }
    let user = gh_json(&gh, &["api", "--method", "GET", "--", "user"]).await?;
    let login = user
        .get("login")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let author = value
        .pointer("/author/login")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let can_write = matches!(info.permission.as_str(), "write" | "maintain" | "admin");
    if !can_write && (login.is_empty() || !login.eq_ignore_ascii_case(author)) {
        return Err("Only the pull request author or a repository collaborator with write permission can mark this draft ready.".into());
    }
    let mut command = github_command(&gh);
    command.args(["pr", "ready", "--repo", &repository, "--", &number_text]);
    mutation_command_output(
        lease.clone(),
        command,
        MUTATION_TIMEOUT,
        "GitHub draft update",
    )
    .await?;
    view_with(&gh, &repository, number).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn pr_commit_after_initialization_without_configured_identity() {
        let root = env::temp_dir().join(format!("mythra-pr-initialized-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        git(&root, &["init", "-b", "main"]).unwrap();
        git(&root, &["config", "user.name", ""]).unwrap();
        git(&root, &["config", "user.email", ""]).unwrap();
        fs::write(root.join("file.txt"), "initial\n").unwrap();
        crate::project_git::initialize_workspace_git_sync(root.to_str().unwrap()).unwrap();
        git(&root, &["switch", "-c", "topic"]).unwrap();
        let before = git(&root, &["rev-parse", "HEAD"]).unwrap();
        fs::write(root.join("file.txt"), "next\n").unwrap();
        mutation_git(&root, &["add", "-A"], MUTATION_TIMEOUT, "Git stage").unwrap();
        let result = commit_for_pr_with_timeout(&root, "PR change", MUTATION_TIMEOUT);
        assert!(
            result.is_ok(),
            "initialized project's PR commit failed: {result:?}"
        );
        assert_eq!(
            git(&root, &["log", "-1", "--format=%an <%ae>"]).unwrap(),
            "Mythra Code <openkiwi@local>"
        );
        assert_eq!(git(&root, &["config", "user.name"]).unwrap(), "");
        assert_eq!(git(&root, &["config", "user.email"]).unwrap(), "");
        assert_eq!(
            push_oid_for(&root, "topic", &before, true).unwrap(),
            git(&root, &["rev-parse", "HEAD"]).unwrap()
        );
        assert_eq!(fs::read(root.join("file.txt")).unwrap(), b"next\n");
        assert_eq!(git(&root, &["status", "--porcelain"]).unwrap(), "");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn pr_commit_preserves_configured_identity() {
        let root = env::temp_dir().join(format!("mythra-pr-identity-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        git(&root, &["init", "-b", "main"]).unwrap();
        git(&root, &["config", "user.name", "Configured User"]).unwrap();
        git(
            &root,
            &["config", "user.email", "configured@example.invalid"],
        )
        .unwrap();
        fs::write(root.join("file.txt"), "contents\n").unwrap();
        mutation_git(&root, &["add", "-A"], MUTATION_TIMEOUT, "Git stage").unwrap();
        commit_for_pr_with_timeout(&root, "PR change", MUTATION_TIMEOUT).unwrap();
        assert_eq!(
            git(&root, &["log", "-1", "--format=%an <%ae>"]).unwrap(),
            "Configured User <configured@example.invalid>"
        );
        assert_eq!(
            git(&root, &["config", "user.name"]).unwrap(),
            "Configured User"
        );
        assert_eq!(
            git(&root, &["config", "user.email"]).unwrap(),
            "configured@example.invalid"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    fn cancellation_fixture(hook_name: &str) -> (PathBuf, String, String, PathBuf, PathBuf) {
        use std::os::unix::fs::PermissionsExt;
        let root = env::temp_dir().join(format!("mythra-pr-cancel-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        git(&root, &["init", "-b", "main"]).unwrap();
        git(&root, &["config", "user.name", "Fixture"]).unwrap();
        git(&root, &["config", "user.email", "fixture@example.com"]).unwrap();
        fs::write(root.join("file"), "base").unwrap();
        git(&root, &["add", "file"]).unwrap();
        git(&root, &["commit", "-m", "base"]).unwrap();
        let expected = git(&root, &["rev-parse", "HEAD"]).unwrap();
        let repository = format!("owner/fixture-{}", uuid::Uuid::new_v4());
        git(
            &root,
            &[
                "remote",
                "add",
                "origin",
                &format!("https://github.com/{repository}.git"),
            ],
        )
        .unwrap();
        git(
            &root,
            &["update-ref", "refs/remotes/origin/main", &expected],
        )
        .unwrap();
        git(&root, &["switch", "-c", "topic"]).unwrap();
        let marker = root.join(".git/hook-started");
        let gate = root.join(".git/hook-release");
        let hook = root.join(".git/hooks").join(hook_name);
        fs::write(
            &hook,
            format!(
                "#!/bin/sh\ntouch '{}'\nwhile [ ! -f '{}' ]; do sleep 0.01; done\n",
                marker.display(),
                gate.display()
            ),
        )
        .unwrap();
        fs::set_permissions(&hook, fs::Permissions::from_mode(0o755)).unwrap();
        (root, repository, expected, marker, gate)
    }

    #[cfg(unix)]
    async fn assert_cancelled_worker_retains_ownership<T: Send + 'static>(
        task: tokio::task::JoinHandle<T>,
        root: &Path,
        repository: &str,
        marker: &Path,
        gate: &Path,
    ) {
        let started = tokio::time::timeout(Duration::from_secs(5), async {
            while !marker.exists() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await;
        if started.is_err() {
            fs::write(gate, "release").unwrap();
            panic!("the gated PR Git hook did not start");
        }
        task.abort();
        assert!(task.await.err().unwrap().is_cancelled());
        let local = crate::git_workspace::repository_lock(root).await.unwrap();
        let github = mutation_lock(repository);
        let local_retained = local.try_lock().is_err();
        let github_retained = github.try_lock().is_err();
        let second = tokio::spawn(crate::git_workspace::git_workspace_stage(
            root.to_string_lossy().into_owned(),
            None,
            false,
            None,
            None,
        ));
        tokio::time::sleep(Duration::from_millis(20)).await;
        let second_blocked = !second.is_finished();
        fs::write(gate, "release").unwrap();
        let _ = tokio::time::timeout(Duration::from_secs(5), second)
            .await
            .unwrap()
            .unwrap();
        let local_guard = tokio::time::timeout(Duration::from_secs(5), local.lock())
            .await
            .unwrap();
        let github_guard = tokio::time::timeout(Duration::from_secs(5), github.lock())
            .await
            .unwrap();
        assert!(
            local_retained,
            "cancelling IPC released the active PR Git worker's local lease"
        );
        assert!(
            github_retained,
            "cancelling IPC released the active PR Git worker's GitHub lease"
        );
        assert!(
            second_blocked,
            "a second native Git mutation entered before the cancelled worker finished"
        );
        drop((local_guard, github_guard));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn cancelled_pr_branch_retains_both_leases_through_post_checkout_hook() {
        let (root, repository, expected, marker, gate) = cancellation_fixture("post-checkout");
        let task = tokio::spawn(branch_with(
            root.clone(),
            repository.clone(),
            "new-topic".into(),
            expected,
        ));
        assert_cancelled_worker_retains_ownership(task, &root, &repository, &marker, &gate).await;
        assert_eq!(
            git(&root, &["branch", "--show-current"]).unwrap(),
            "new-topic"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn cancelled_pr_create_retains_both_leases_through_pre_commit_hook() {
        use std::os::unix::fs::PermissionsExt;
        let (root, repository, expected, marker, gate) = cancellation_fixture("pre-commit");
        let gh = root.join("fake-gh");
        fs::write(&gh, "#!/bin/sh\nif [ \"$1\" = api ]; then printf '%s\\n' '{\"default_branch\":\"main\",\"permissions\":{\"push\":true},\"allow_squash_merge\":true}'; elif [ \"$1:$2\" = pr:list ]; then printf '[]\\n'; else exit 88; fi\n").unwrap();
        fs::set_permissions(&gh, fs::Permissions::from_mode(0o755)).unwrap();
        fs::write(root.join("file"), "working").unwrap();
        let task = tokio::spawn(create_with(
            root.clone(),
            gh,
            repository.clone(),
            "topic".into(),
            "main".into(),
            "A change".into(),
            "".into(),
            true,
            Some("fixture commit".into()),
            true,
            expected,
        ));
        assert_cancelled_worker_retains_ownership(task, &root, &repository, &marker, &gate).await;
        assert_eq!(
            git(&root, &["log", "-1", "--format=%s"]).unwrap(),
            "fixture commit"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn pr_creation_never_pushes_to_remote_retargeted_by_commit_hook() {
        use std::os::unix::fs::PermissionsExt;
        let (root, repository, expected, _, _) = cancellation_fixture("post-commit");
        let destination = root.join(".git/unexpected.git");
        git(&root, &["init", "--bare", destination.to_str().unwrap()]).unwrap();
        let hook = root.join(".git/hooks/post-commit");
        fs::write(
            &hook,
            format!(
                "#!/bin/sh\ngit remote set-url origin '{}'\n",
                destination.display()
            ),
        )
        .unwrap();
        fs::set_permissions(&hook, fs::Permissions::from_mode(0o755)).unwrap();
        let gh = root.join(".git/fake-gh");
        fs::write(&gh, "#!/bin/sh\nif [ \"$1\" = api ]; then printf '%s\\n' '{\"default_branch\":\"main\",\"permissions\":{\"push\":true},\"allow_squash_merge\":true}'; elif [ \"$1:$2\" = pr:list ]; then printf '[]\\n'; else exit 88; fi\n").unwrap();
        fs::set_permissions(&gh, fs::Permissions::from_mode(0o755)).unwrap();
        fs::write(root.join("file"), "reviewed working change").unwrap();
        let error = create_with(
            root.clone(),
            gh,
            repository,
            "topic".into(),
            "main".into(),
            "A change".into(),
            "".into(),
            true,
            Some("fixture commit".into()),
            true,
            expected,
        )
        .await
        .unwrap_err();
        let pushed = run_git(
            &destination,
            &["show-ref", "--verify", "--quiet", "refs/heads/topic"],
            None,
        )
        .unwrap()
        .status
        .success();
        assert!(
            !pushed,
            "PR creation uploaded the commit to a destination selected by a commit hook: {error}"
        );
        assert!(error.contains("remote changed"), "{error}");
        assert_eq!(
            git(&root, &["log", "-1", "--format=%s"]).unwrap(),
            "fixture commit"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn pr_commit_timeout_after_save_reports_the_observed_head_and_never_claims_staged_contents() {
        use std::os::unix::fs::PermissionsExt;
        let (root, _, before, _, _) = cancellation_fixture("post-commit");
        let hook = root.join(".git/hooks/post-commit");
        fs::write(&hook, "#!/bin/sh\nsleep 2\n").unwrap();
        fs::set_permissions(&hook, fs::Permissions::from_mode(0o755)).unwrap();
        fs::write(root.join("file"), "saved before timeout\n").unwrap();
        git(&root, &["add", "file"]).unwrap();
        let error =
            commit_for_pr_with_timeout(&root, "saved before timeout", Duration::from_millis(500))
                .unwrap_err();
        let after = git(&root, &["rev-parse", "HEAD"]).unwrap();
        let staged = git(&root, &["diff", "--cached", "--name-only"]).unwrap();
        fs::remove_dir_all(root).unwrap();
        assert_ne!(after, before);
        assert!(staged.is_empty());
        assert!(
            error.contains("may already have been saved") && error.contains(&after),
            "{error}"
        );
        assert!(!error.contains("changes remain staged"), "{error}");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn cancelled_mutating_cli_retains_both_leases_until_kill_and_reap() {
        use std::os::unix::fs::PermissionsExt;
        let (root, repository, _, marker, gate) = cancellation_fixture("pre-commit");
        let binary = root.join("fake-gh");
        fs::write(&binary, format!(
            "#!/bin/sh\ntrap 'while [ ! -f \"{}\" ]; do sleep 0.01; done; exit 1' TERM\ntouch '{}'\nwhile :; do sleep 0.01; done\n",
            gate.display(), marker.display(),
        )).unwrap();
        fs::set_permissions(&binary, fs::Permissions::from_mode(0o755)).unwrap();
        let lease = mutation_lease(Some(&root), &repository).await.unwrap();
        let task = tokio::spawn(async move {
            mutation_command_output(
                lease,
                github_command(&binary),
                Duration::from_secs(5),
                "fixture mutation",
            )
            .await
        });
        assert_cancelled_worker_retains_ownership(task, &root, &repository, &marker, &gate).await;
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn mutating_cli_timeout_stops_descendants_and_bounds_output() {
        use std::os::unix::fs::PermissionsExt;
        let (root, repository, _, _, _) = cancellation_fixture("pre-commit");
        let binary = root.join("fake-gh");
        let late_write = root.join("unexpected-child-write");
        fs::write(
            &binary,
            format!(
                "#!/bin/sh\ntrap '' TERM\n(sleep 0.6; printf late > '{}') &\nwait\n",
                late_write.display(),
            ),
        )
        .unwrap();
        fs::set_permissions(&binary, fs::Permissions::from_mode(0o755)).unwrap();
        let lease = mutation_lease(Some(&root), &repository).await.unwrap();
        let error = mutation_command_output(
            lease,
            github_command(&binary),
            Duration::from_millis(80),
            "fixture mutation",
        )
        .await
        .unwrap_err();
        assert!(error.contains("timed out"));
        let local = crate::git_workspace::repository_lock(&root).await.unwrap();
        assert!(local.try_lock().is_ok());
        assert!(mutation_lock(&repository).try_lock().is_ok());
        tokio::time::sleep(Duration::from_millis(650)).await;
        assert!(
            !late_write.exists(),
            "timed-out CLI descendant continued mutating after lease release"
        );
        fs::write(&binary, "#!/bin/sh\nprintf '%1048577d' 0\n").unwrap();
        let lease = mutation_lease(Some(&root), &repository).await.unwrap();
        assert!(mutation_command_output(
            lease,
            github_command(&binary),
            Duration::from_secs(5),
            "fixture mutation"
        )
        .await
        .unwrap_err()
        .contains("too much output"));
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn mutating_cli_parent_exit_keeps_descendants_contained_until_pipe_timeout() {
        let root = env::temp_dir().join(format!("mythra-pr-parent-exit-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        git(&root, &["init", "-b", "main"]).unwrap();
        let repository = format!("owner/fixture-{}", uuid::Uuid::new_v4());
        let late_write = root.join("unexpected-child-write");
        let parent_exit = root.join("parent-exited");
        #[cfg(windows)]
        let child_release = root.join("child-release");
        #[cfg(unix)]
        let (command, timeout, after) = {
            use std::os::unix::fs::PermissionsExt;
            let binary = root.join("fake-gh");
            fs::write(
                &binary,
                format!(
                    "#!/bin/sh\n(sleep 3; printf late > '{}') &\nprintf exited > '{}'\nexit 0\n",
                    late_write.display(),
                    parent_exit.display()
                ),
            )
            .unwrap();
            fs::set_permissions(&binary, fs::Permissions::from_mode(0o755)).unwrap();
            (
                github_command(&binary),
                Duration::from_secs(2),
                Duration::from_millis(3200),
            )
        };
        #[cfg(windows)]
        let (command, timeout, after) = {
            let child_script = root.join("child.ps1");
            let parent_script = root.join("parent.ps1");
            let started = root.join("child-started");
            let escaped = |path: &Path| path.to_string_lossy().replace('\'', "''");
            fs::write(&child_script, format!("Set-Content -LiteralPath '{}' -Value 'started'; while (!(Test-Path -LiteralPath '{}')) {{ Start-Sleep -Milliseconds 10 }}; Set-Content -LiteralPath '{}' -Value 'late'", escaped(&started), escaped(&child_release), escaped(&late_write))).unwrap();
            fs::write(&parent_script, format!("$child = Start-Process -FilePath powershell.exe -ArgumentList @('-NoProfile', '-NonInteractive', '-File', '\"{}\"') -NoNewWindow -PassThru; while (!(Test-Path -LiteralPath '{}')) {{ Start-Sleep -Milliseconds 10 }}; Set-Content -LiteralPath '{}' -Value 'exited'; exit 0", escaped(&child_script), escaped(&started), escaped(&parent_exit))).unwrap();
            let mut command = crate::process_launch::background_command("powershell.exe");
            command
                .args(["-NoProfile", "-NonInteractive", "-File"])
                .arg(parent_script);
            (command, Duration::from_secs(5), Duration::from_millis(3200))
        };
        let lease = mutation_lease(Some(&root), &repository).await.unwrap();
        let error = mutation_command_output(lease, command, timeout, "fixture mutation")
            .await
            .unwrap_err();
        assert!(error.contains("timed out"), "{error}");
        assert!(
            parent_exit.exists(),
            "fixture parent did not reach its exit before timeout"
        );
        let local = crate::git_workspace::repository_lock(&root).await.unwrap();
        assert!(local.try_lock().is_ok());
        assert!(mutation_lock(&repository).try_lock().is_ok());
        #[cfg(windows)]
        fs::write(&child_release, "release").unwrap();
        tokio::time::sleep(after).await;
        assert!(
            !late_write.exists(),
            "CLI parent exited before timeout and its descendant mutated after lease release"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn project_pr_list_validates_bounds_and_keeps_search_as_data() {
        let query = pr_list_query(
            "owner/repo",
            Some("  title --limit 500  ".into()),
            Some("all".into()),
            Some(50),
        )
        .unwrap();
        assert_eq!(query.search.as_deref(), Some("title --limit 500"));
        assert_eq!(query.state, "all");
        assert_eq!(query.limit, 50);
        for limit in [0, 51, usize::MAX] {
            assert!(pr_list_query("owner/repo", None, None, Some(limit)).is_err());
        }
        for search in ["title\nrepo:other/target".into(), "x".repeat(257)] {
            assert!(pr_list_query("owner/repo", Some(search), None, None).is_err());
        }
        assert!(pr_list_query("--invalid/repo", None, None, None).is_err());
        assert!(pr_list_query("owner/repo", None, Some("unknown".into()), None).is_err());
    }

    #[test]
    fn project_pr_list_rejects_overflow_and_wrong_repository_results() {
        let item = serde_json::json!({
            "number": 7, "url": "https://github.com/owner/repo/pull/7", "title": "A change",
            "state": "OPEN", "isDraft": true, "headRefName": "feature", "baseRefName": "main",
            "updatedAt": "2026-09-28T00:00:00Z", "author": { "login": "author" },
        });
        let parsed =
            pr_summaries_from_json("owner/repo", &serde_json::json!([item.clone()]), 30).unwrap();
        assert_eq!(parsed[0].author_login.as_deref(), Some("author"));
        assert!(parsed[0].is_draft);
        let mut different = item.clone();
        different["url"] = serde_json::json!("https://github.com/other/repo/pull/7");
        assert!(pr_summaries_from_json("owner/repo", &serde_json::json!([different]), 30).is_err());
        assert!(
            pr_summaries_from_json("owner/repo", &serde_json::json!([item.clone(), item]), 1)
                .is_err()
        );
    }

    #[test]
    fn project_pr_list_binds_the_configured_origin_without_changing_local_git() {
        let root = env::temp_dir().join(format!("mythra-pr-list-origin-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        git(&root, &["init", "-b", "main"]).unwrap();
        let cwd = root.to_string_lossy();
        assert!(project_for_pr_list(&cwd, "owner/repo")
            .unwrap_err()
            .contains("Connect this project"));
        git(
            &root,
            &[
                "remote",
                "add",
                "origin",
                "https://github.com/Owner/Repo.git",
            ],
        )
        .unwrap();
        git(
            &root,
            &[
                "config",
                "url.ssh://git@ssh.github.com:443/.insteadOf",
                "https://github.com/",
            ],
        )
        .unwrap();
        let config_before = fs::read(root.join(".git/config")).unwrap();
        assert_eq!(
            project_for_pr_list(&cwd, "owner/repo").unwrap(),
            root.canonicalize().unwrap()
        );
        assert!(project_for_pr_list(&cwd, "other/repo")
            .unwrap_err()
            .contains("repository changed"));
        assert_eq!(fs::read(root.join(".git/config")).unwrap(), config_before);
        git(
            &root,
            &[
                "config",
                "--add",
                "remote.origin.url",
                "https://github.com/other/repo.git",
            ],
        )
        .unwrap();
        assert!(project_for_pr_list(&cwd, "owner/repo").is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn local_pr_mutations_reject_nested_projects_without_restricting_inspection() {
        let root = env::temp_dir().join(format!("mythra-pr-nested-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        git(&root, &["init", "-b", "main"]).unwrap();
        let nested = root.join("nested");
        fs::create_dir(&nested).unwrap();
        let canonical = root.canonicalize().unwrap();
        assert_eq!(
            selected_repository(nested.to_str().unwrap()).unwrap(),
            canonical
        );
        assert_eq!(
            selected_mutation_repository(root.to_str().unwrap()).unwrap(),
            canonical
        );
        assert!(selected_mutation_repository(nested.to_str().unwrap())
            .unwrap_err()
            .contains("enclosing repository"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn pinned_pr_push_tracks_custom_mappings_with_cas_and_never_rewrites_local_branches() {
        let root = env::temp_dir().join(format!("mythra-pr-tracking-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        git(&root, &["init", "-b", "main"]).unwrap();
        git(&root, &["config", "user.name", "Fixture"]).unwrap();
        git(&root, &["config", "user.email", "fixture@example.com"]).unwrap();
        fs::write(root.join("file"), "one").unwrap();
        git(&root, &["add", "file"]).unwrap();
        git(&root, &["commit", "-m", "one"]).unwrap();
        let first = git(&root, &["rev-parse", "HEAD"]).unwrap();
        git(
            &root,
            &[
                "remote",
                "add",
                "origin",
                "https://github.com/owner/repo.git",
            ],
        )
        .unwrap();
        git(
            &root,
            &[
                "config",
                "remote.origin.fetch",
                "+refs/heads/*:refs/review/origin/*",
            ],
        )
        .unwrap();
        let binding = pr_push_binding(&root, "origin", "owner/repo").unwrap();
        let targets = pr_tracking_refs(&root, &binding, "topic/nested").unwrap();
        assert_eq!(targets, [("refs/review/origin/topic/nested".into(), None)]);
        record_pr_tracking(&root, &binding, "owner/repo", &first, &targets).unwrap();
        assert_eq!(
            git(&root, &["rev-parse", "refs/review/origin/topic/nested"]).unwrap(),
            first
        );
        assert!(
            record_pr_tracking(&root, &binding, "owner/repo", &first, &targets).is_err(),
            "stale tracking CAS overwrote a concurrently created ref"
        );
        git(
            &root,
            &[
                "symbolic-ref",
                "refs/review/origin/topic/nested",
                "refs/heads/main",
            ],
        )
        .unwrap();
        assert!(pr_tracking_refs(&root, &binding, "topic/nested").is_err());
        assert!(record_pr_tracking(&root, &binding, "owner/repo", &first, &targets).is_err());
        assert_eq!(
            git(&root, &["symbolic-ref", "refs/review/origin/topic/nested"]).unwrap(),
            "refs/heads/main"
        );
        assert_eq!(git(&root, &["rev-parse", "HEAD"]).unwrap(), first);
        git(
            &root,
            &[
                "config",
                "remote.origin.fetch",
                "+refs/heads/*:refs/heads/*",
            ],
        )
        .unwrap();
        let binding = pr_push_binding(&root, "origin", "owner/repo").unwrap();
        assert!(pr_tracking_refs(&root, &binding, "topic/nested").is_err());
        git(
            &root,
            &[
                "config",
                "remote.origin.fetch",
                "refs/heads/topic:refs/review/topic",
            ],
        )
        .unwrap();
        git(
            &root,
            &[
                "config",
                "--add",
                "remote.origin.fetch",
                "^refs/heads/topic",
            ],
        )
        .unwrap();
        let binding = pr_push_binding(&root, "origin", "owner/repo").unwrap();
        assert!(pr_tracking_refs(&root, &binding, "topic")
            .unwrap()
            .is_empty());
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn project_pr_list_uses_one_bounded_read_on_the_explicit_github_host() {
        use std::os::unix::fs::PermissionsExt;
        let root = env::temp_dir().join(format!("mythra-pr-list-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        let binary = root.join("gh");
        fs::write(&binary, r#"#!/bin/sh
[ "$GH_HOST" = github.com ] || exit 80
[ "$GH_PROMPT_DISABLED" = 1 ] || exit 81
[ -z "$GH_REPO" ] || exit 82
[ "$#" = 12 ] || exit 83
[ "$1:$2:$3:$4:$5:$6:$7:$8" = 'pr:list:--repo:github.com/owner/repo:--state:all:--limit:2' ] || exit 84
[ "${11}:${12}" = '--search:title --limit 500' ] || exit 85
printf '%s\n' '[{"number":7,"url":"https://github.com/owner/repo/pull/7","title":"A change","state":"OPEN","isDraft":false,"headRefName":"feature","baseRefName":"main","updatedAt":"2026-09-28T00:00:00Z","author":{"login":"author"}}]'
"#).unwrap();
        fs::set_permissions(&binary, fs::Permissions::from_mode(0o700)).unwrap();
        let query = pr_list_query(
            "owner/repo",
            Some("title --limit 500".into()),
            Some("all".into()),
            Some(2),
        )
        .unwrap();
        let result = list_with(&binary, "owner/repo", query).await.unwrap();
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].number, 7);
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    fn fake_gh(root: &Path) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let script = root.join("gh");
        let log = root.join("gh.log");
        let source = format!(
            r#"#!/bin/sh
[ "$GH_HOST" = github.com ] || {{ printf '%s\n' 'wrong GitHub host' >&2; exit 80; }}
[ "$GH_PROMPT_DISABLED" = 1 ] || {{ printf '%s\n' 'interactive GitHub command' >&2; exit 81; }}
printf '%s\n' "$*" >> '{}'
if [ "$1" = api ]; then
  printf '%s\n' '{{"default_branch":"main","permissions":{{"push":true}},"allow_squash_merge":true,"allow_merge_commit":false,"allow_rebase_merge":false}}'
elif [ "$1" = pr ] && [ "$2" = view ]; then
  printf '%s\n' '{{"number":7,"url":"https://github.com/owner/repo/pull/7","title":"Topic","body":"Body","state":"OPEN","isDraft":false,"headRefName":"topic","headRepositoryOwner":{{"login":"owner"}},"baseRefName":"main","headRefOid":"0123456789abcdef0123456789abcdef01234567","mergeable":"MERGEABLE","mergeStateStatus":"CLEAN","reviewDecision":"APPROVED","statusCheckRollup":[{{"name":"build","conclusion":"SUCCESS","detailsUrl":"https://example.test/check"}}],"updatedAt":"2026-09-22T00:00:00Z","mergedAt":null,"author":{{"login":"tester"}}}}'
elif [ "$1" = pr ] && [ "$2" = list ]; then
  base=release
  while [ "$#" -gt 0 ]; do
    if [ "$1" = --base ]; then shift; base="$1"; fi
    shift
  done
  if [ "$base" = forkcollision ]; then
    printf '%s\n' '[{{"number":10,"url":"https://github.com/owner/repo/pull/10","title":"Fork","state":"OPEN","headRefName":"topic","headRepositoryOwner":{{"login":"fork"}},"baseRefName":"forkcollision","headRefOid":"1111111111111111111111111111111111111111"}},{{"number":11,"url":"https://github.com/owner/repo/pull/11","title":"Local","state":"OPEN","headRefName":"topic","headRepositoryOwner":{{"login":"owner"}},"baseRefName":"forkcollision","headRefOid":"0123456789abcdef0123456789abcdef01234567"}}]'
    exit 0
  fi
  case "$base" in
    main) number=7 ;;
    release) number=8 ;;
    mismatch) number=9; base=other ;;
    *) printf '%s\n' '[]'; exit 0 ;;
  esac
  printf '[{{"number":%s,"url":"https://github.com/owner/repo/pull/%s","title":"Topic","state":"OPEN","headRefName":"topic","headRepositoryOwner":{{"login":"owner"}},"baseRefName":"%s","headRefOid":"0123456789abcdef0123456789abcdef01234567"}}]\n' "$number" "$number" "$base"
elif [ "$1" = pr ] && [ "$2" = merge ]; then
  exit 0
else
  printf '%s\n' 'unexpected fake gh arguments' >&2
  exit 19
fi
"#,
            log.display()
        );
        fs::write(&script, source).unwrap();
        let mut permissions = fs::metadata(&script).unwrap().permissions();
        permissions.set_mode(0o700);
        fs::set_permissions(&script, permissions).unwrap();
        script
    }

    #[test]
    fn github_remote_identity_supports_the_official_https_ssh_transport_and_checks_every_push_url()
    {
        let root =
            std::env::temp_dir().join(format!("mythra-pr-transport-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        git(&root, &["init", "-b", "main"]).unwrap();
        git(
            &root,
            &[
                "remote",
                "add",
                "origin",
                "https://github.com/owner/repo.git",
            ],
        )
        .unwrap();
        git(
            &root,
            &[
                "config",
                "url.ssh://git@ssh.github.com:443/.insteadOf",
                "https://github.com/",
            ],
        )
        .unwrap();
        assert_eq!(
            remote_for_repository(&root, "owner/repo").unwrap(),
            "origin"
        );
        git(
            &root,
            &[
                "config",
                "--add",
                "remote.origin.pushurl",
                "ssh://git@ssh.github.com:443/owner/repo.git",
            ],
        )
        .unwrap();
        git(
            &root,
            &[
                "config",
                "--add",
                "remote.origin.pushurl",
                "https://github.com/owner/other.git",
            ],
        )
        .unwrap();
        assert!(remote_for_repository(&root, "owner/repo").is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn malformed_targets_and_refs_cannot_become_flags() {
        for bad in [
            "--repo/x",
            "owner/--repo",
            "owner/repo/extra",
            "owner/repo\n--admin",
        ] {
            assert!(validate_repository(bad).is_err());
        }
        for bad in ["--head", "main:evil", "feature name", "a..b", "x@{y"] {
            assert!(validate_ref(bad, "Branch").is_err());
        }
    }

    #[test]
    fn merge_arguments_pin_head_and_never_escalate_or_delete_branch() {
        let oid = "0123456789abcdef0123456789abcdef01234567";
        let args = merge_args("m17h/Mythra-Code", 42, "squash", oid, true).unwrap();
        assert_eq!(
            args,
            [
                "pr",
                "merge",
                "--repo",
                "m17h/Mythra-Code",
                "--squash",
                "--match-head-commit",
                oid,
                "--auto",
                "--",
                "42"
            ]
        );
        assert!(!args
            .iter()
            .any(|v| v == "--admin" || v == "--delete-branch"));
    }

    #[test]
    fn pending_checks_fall_back_from_empty_conclusions() {
        for conclusion in [
            serde_json::Value::Null,
            serde_json::json!(""),
            serde_json::json!(" "),
        ] {
            let check = check_from_json(
                &serde_json::json!({"name":"Windows", "conclusion":conclusion, "status":"IN_PROGRESS"}),
            );
            assert_eq!(check.state, "IN_PROGRESS");
        }
        assert_eq!(
            check_from_json(&serde_json::json!({"conclusion":"FAILURE", "status":"COMPLETED"}))
                .state,
            "FAILURE"
        );
        assert_eq!(
            check_from_json(&serde_json::json!({"conclusion":null, "state":"PENDING"})).state,
            "PENDING"
        );
        assert_eq!(
            check_from_json(&serde_json::json!({"conclusion":null})).state,
            "UNKNOWN"
        );
    }

    #[test]
    fn parses_repository_rules_permissions_and_incomplete_checks_conservatively() {
        let info = repository_info_from_json(&serde_json::json!({"default_branch":"main","permissions":{"push":true},"allow_squash_merge":true})).unwrap();
        let pr = pull_request_from_json("m17h/Mythra-Code", &serde_json::json!({
            "number": 3, "url":"https://github.com/m17h/Mythra-Code/pull/3", "title":"T", "body":"", "state":"OPEN", "isDraft":false,
            "headRefName":"topic", "baseRefName":"main", "headRefOid":"0123456789abcdef0123456789abcdef01234567", "mergeable":"MERGEABLE",
            "mergeStateStatus":"CLEAN", "reviewDecision":"APPROVED", "updatedAt":"2026-01-01T00:00:00Z", "mergedAt":null,
            "statusCheckRollup":[{"name":"build","status":"IN_PROGRESS"}]
        }), &info).unwrap();
        assert_eq!(info.permission, "write");
        assert_eq!(pr.merge_methods, ["squash"]);
        assert!(!pr.can_merge);
        let created = serde_json::to_value(GitHubPrCreateResult::created(pr.clone())).unwrap();
        let existing = serde_json::to_value(GitHubPrCreateResult::existing(pr)).unwrap();
        let updated = serde_json::to_value(GitHubPrCreateResult::updated(
            pull_request_from_json("m17h/Mythra-Code", &serde_json::json!({
                "number": 3, "url":"https://github.com/m17h/Mythra-Code/pull/3", "title":"T", "body":"", "state":"OPEN", "isDraft":false,
                "headRefName":"topic", "baseRefName":"main", "headRefOid":"0123456789abcdef0123456789abcdef01234567", "mergeable":"MERGEABLE",
                "mergeStateStatus":"CLEAN", "reviewDecision":"APPROVED", "updatedAt":"2026-01-01T00:00:00Z", "mergedAt":null, "statusCheckRollup":[]
            }), &info).unwrap()
        )).unwrap();
        assert_eq!(created["creationOutcome"], "created");
        assert_eq!(existing["creationOutcome"], "existing");
        assert_eq!(updated["creationOutcome"], "updated");
        assert_eq!(created["number"], 3);
        assert!(created.get("pullRequest").is_none());
    }

    #[test]
    fn creation_result_identity_rejects_wrong_owner_target_and_commit() {
        let info = repository_info_from_json(&serde_json::json!({
            "default_branch": "main",
            "permissions": {"push": true},
            "allow_squash_merge": true
        }))
        .unwrap();
        let payload = |owner: &str, base: &str, oid: &str| {
            serde_json::json!({
                "number": 3, "url": "https://github.com/owner/repo/pull/3",
                "title": "T", "body": "", "state": "OPEN", "isDraft": false,
                "headRefName": "topic", "headRepositoryOwner": {"login": owner},
                "baseRefName": base, "headRefOid": oid, "mergeable": "MERGEABLE",
                "mergeStateStatus": "CLEAN", "reviewDecision": "APPROVED",
                "updatedAt": "2026-01-01T00:00:00Z", "mergedAt": null,
                "statusCheckRollup": []
            })
        };
        let oid = "0123456789abcdef0123456789abcdef01234567";
        let valid =
            pull_request_from_json("owner/repo", &payload("owner", "main", oid), &info).unwrap();
        assert!(
            ensure_pull_request_identity(&valid, "owner/repo", "topic", "main", Some(oid)).is_ok()
        );
        for invalid in [
            pull_request_from_json("owner/repo", &payload("fork", "main", oid), &info).unwrap(),
            pull_request_from_json("owner/repo", &payload("owner", "release", oid), &info).unwrap(),
            pull_request_from_json(
                "owner/repo",
                &payload("owner", "main", "1111111111111111111111111111111111111111"),
                &info,
            )
            .unwrap(),
        ] {
            assert!(ensure_pull_request_identity(
                &invalid,
                "owner/repo",
                "topic",
                "main",
                Some(oid)
            )
            .is_err());
        }
    }

    #[test]
    fn create_preflight_rejects_default_detached_and_stale_heads() {
        let root = std::env::temp_dir().join(format!("mythra-pr-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        assert!(background_std_command("git")
            .args(["init", "-b", "main"])
            .current_dir(&root)
            .status()
            .unwrap()
            .success());
        fs::write(root.join("a"), "a").unwrap();
        background_std_command("git")
            .args(["add", "a"])
            .current_dir(&root)
            .status()
            .unwrap();
        background_std_command("git")
            .args([
                "-c",
                "user.name=Test",
                "-c",
                "user.email=test@example.com",
                "commit",
                "-m",
                "initial",
            ])
            .current_dir(&root)
            .status()
            .unwrap();
        let oid = git(&root, &["rev-parse", "HEAD"]).unwrap();
        assert_eq!(push_oid_for(&root, "main", &oid, false).unwrap(), oid);
        assert!(push_oid_for(
            &root,
            "main",
            "1111111111111111111111111111111111111111",
            false
        )
        .unwrap_err()
        .contains("HEAD changed"));
        assert!(
            create_preflight(&root, "owner/repo", "main", "main", &oid, "main")
                .unwrap_err()
                .contains("different")
        );
        assert!(create_preflight(
            &root,
            "owner/repo",
            "main",
            "trunk",
            "1111111111111111111111111111111111111111",
            "trunk"
        )
        .unwrap_err()
        .contains("HEAD changed"));
        git(&root, &["switch", "-c", "topic"]).unwrap();
        assert_eq!(
            create_preflight(&root, "owner/repo", "topic", "release", &oid, "main").unwrap(),
            oid
        );
        assert!(
            create_preflight(&root, "owner/repo", "topic", "topic", &oid, "main")
                .unwrap_err()
                .contains("different")
        );
        assert!(create_preflight(&root, "owner/repo", "topic", "--invalid", &oid, "main").is_err());
        background_std_command("git")
            .args(["checkout", "--detach"])
            .current_dir(&root)
            .status()
            .unwrap();
        assert!(
            create_preflight(&root, "owner/repo", "main", "trunk", &oid, "trunk")
                .unwrap_err()
                .contains("detached")
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn committed_delta_inspection_leaves_uncommitted_files_out_and_unchanged() {
        let root =
            std::env::temp_dir().join(format!("mythra-pr-dirty-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        background_std_command("git")
            .args(["init", "-b", "main"])
            .current_dir(&root)
            .status()
            .unwrap();
        fs::write(root.join("tracked"), "base").unwrap();
        background_std_command("git")
            .args(["add", "tracked"])
            .current_dir(&root)
            .status()
            .unwrap();
        background_std_command("git")
            .args([
                "-c",
                "user.name=Test",
                "-c",
                "user.email=test@example.com",
                "commit",
                "-m",
                "base",
            ])
            .current_dir(&root)
            .status()
            .unwrap();
        let base_oid = git(&root, &["rev-parse", "HEAD"]).unwrap();
        background_std_command("git")
            .args(["update-ref", "refs/remotes/origin/main", &base_oid])
            .current_dir(&root)
            .status()
            .unwrap();
        background_std_command("git")
            .args(["switch", "-c", "topic"])
            .current_dir(&root)
            .status()
            .unwrap();
        fs::write(root.join("committed"), "included").unwrap();
        background_std_command("git")
            .args(["add", "committed"])
            .current_dir(&root)
            .status()
            .unwrap();
        background_std_command("git")
            .args([
                "-c",
                "user.name=Test",
                "-c",
                "user.email=test@example.com",
                "commit",
                "-m",
                "topic",
            ])
            .current_dir(&root)
            .status()
            .unwrap();
        let topic_oid = git(&root, &["rev-parse", "HEAD"]).unwrap();
        assert_eq!(
            push_oid_for(&root, "topic", &base_oid, true).unwrap(),
            topic_oid
        );
        assert!(push_oid_for(&root, "topic", &topic_oid, true)
            .unwrap_err()
            .contains("branch changed"));
        fs::write(root.join("tracked"), "dirty and omitted").unwrap();
        let before = git(&root, &["diff"]).unwrap();
        assert_eq!(committed_delta(&root, "origin", "main").unwrap(), 1);
        assert_eq!(git(&root, &["diff"]).unwrap(), before);
        assert!(before.contains("dirty and omitted"));
        let _ = fs::remove_dir_all(root);
    }

    /// Opt-in read-only contract smoke against a real authenticated GitHub CLI.
    /// Set MYTHRA_TEST_GH_PATH, MYTHRA_TEST_GITHUB_REPOSITORY and optionally
    /// MYTHRA_TEST_GITHUB_PR before running this ignored test.
    #[tokio::test]
    #[ignore = "requires explicit authenticated GitHub smoke-test environment"]
    async fn live_github_payload_matches_native_contract() {
        let gh = PathBuf::from(std::env::var("MYTHRA_TEST_GH_PATH").expect("gh path"));
        let repository = std::env::var("MYTHRA_TEST_GITHUB_REPOSITORY").expect("repository");
        let info = repository_info(&gh, &repository)
            .await
            .expect("repository payload");
        assert!(!info.default_branch.is_empty());
        if let Ok(number) = std::env::var("MYTHRA_TEST_GITHUB_PR") {
            let pr = view_with(&gh, &repository, number.parse().expect("PR number"))
                .await
                .expect("pull request payload");
            assert_eq!(pr.repository, repository);
            assert!(!pr.url.is_empty());
            assert!(!pr.head_oid.is_empty());
            if pr.state == "OPEN" {
                let found = find_with(&gh, &repository, &pr.head_ref_name, Some(&pr.base_ref_name))
                    .await
                    .expect("targeted discovery payload")
                    .expect("open PR found");
                assert_eq!(found.number, pr.number);
            }
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn discovery_selects_default_target_instead_of_first_pr_on_branch() {
        let root = std::env::temp_dir().join(format!("mythra-fake-gh-find-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let gh = fake_gh(&root);
        // The same head has PR #8 into release and #7 into main. Without
        // a base filter GitHub returns #8 first; discovery must suggest #7.
        let pr = find_with(&gh, "owner/repo", "topic", None)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(pr.number, 7);
        assert_eq!(pr.base_ref_name, "main");
        // Creation deduplication uses the form's selected target, including
        // non-default targets; a PR into another base is not a duplicate.
        let release = find_with(&gh, "owner/repo", "topic", Some("release"))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(release.number, 8);
        assert_eq!(release.base_ref_name, "release");
        assert!(find_with(&gh, "owner/repo", "topic", Some("develop"))
            .await
            .unwrap()
            .is_none());
        let mismatch = find_with(&gh, "owner/repo", "topic", Some("mismatch")).await;
        assert!(mismatch.unwrap().is_none());
        let collision = find_with(&gh, "owner/repo", "topic", Some("forkcollision"))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(collision.number, 11);
        let before = fs::read_to_string(root.join("gh.log")).unwrap();
        assert!(find_with(&gh, "owner/repo", "topic", Some("--invalid"))
            .await
            .is_err());
        assert_eq!(fs::read_to_string(root.join("gh.log")).unwrap(), before);
        let _ = fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn fake_gh_view_exercises_rules_checks_and_argument_boundaries() {
        let root = std::env::temp_dir().join(format!("mythra-fake-gh-view-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let gh = fake_gh(&root);
        let pr = view_with(&gh, "owner/repo", 7).await.unwrap();
        assert_eq!(pr.number, 7);
        assert!(pr.can_merge);
        assert_eq!(
            pr.checks,
            [GitHubPrCheck {
                name: "build".into(),
                state: "SUCCESS".into(),
                url: "https://example.test/check".into()
            }]
        );
        let log = fs::read_to_string(root.join("gh.log")).unwrap();
        assert!(log.contains("api --method GET -- repos/owner/repo"));
        assert!(log.contains("pr view --repo owner/repo --json"));
        assert!(log.contains("-- 7"));
        let _ = fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn fake_gh_merge_receives_pinned_sha_without_admin_or_branch_delete() {
        let root =
            std::env::temp_dir().join(format!("mythra-fake-gh-merge-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let gh = fake_gh(&root);
        let oid = "0123456789abcdef0123456789abcdef01234567";
        let args = merge_args("owner/repo", 7, "squash", oid, true).unwrap();
        let mut command = github_command(&gh);
        command.args(args);
        command_output(command, COMMAND_TIMEOUT, "fake merge")
            .await
            .unwrap();
        let log = fs::read_to_string(root.join("gh.log")).unwrap();
        assert!(log.contains(&format!("--match-head-commit {oid}")));
        assert!(log.contains("--auto -- 7"));
        assert!(!log.contains("--admin"));
        assert!(!log.contains("--delete-branch"));
        let _ = fs::remove_dir_all(root);
    }
}
