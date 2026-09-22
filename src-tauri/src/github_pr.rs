//! Native GitHub pull-request operations.
//!
//! Mutations are serialized per repository for this process. This cannot
//! coordinate with another Mythra process or an external Git client, so every
//! mutation also re-checks the branch and caller-provided HEAD immediately
//! before changing local or remote state.

use std::{
    collections::HashMap,
    env,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{Arc, Mutex as StdMutex, OnceLock},
    time::Duration,
};

use serde::Serialize;
use serde_json::Value;
use tauri::AppHandle;
use tokio::{process::Command, sync::Mutex};

#[cfg(test)]
use crate::process_launch::background_std_command;
use crate::{
    github::{parse_github_repository, resolve_github_binary},
    process_launch::background_command,
    project_git::{git_runtime_path, optional_git_stdout, run_git},
};

const COMMAND_TIMEOUT: Duration = Duration::from_secs(30);
const MUTATION_TIMEOUT: Duration = Duration::from_secs(120);

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

fn async_git_command(cwd: &Path) -> Command {
    let mut command = background_command("git");
    command
        .current_dir(cwd)
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .env_remove("GIT_COMMON_DIR")
        .env_remove("GIT_INDEX_FILE");
    let home = env::var_os("HOME").map(PathBuf::from);
    if let Some(path) = git_runtime_path(env::var_os("PATH").as_deref(), home.as_deref()) {
        command.env("PATH", path);
    }
    command
}

async fn bounded_git(
    cwd: &Path,
    args: &[String],
    limit: Duration,
    action: &str,
) -> Result<String, String> {
    let mut command = async_git_command(cwd);
    command.args(args);
    let output = command_output(command, limit, action).await?;
    Ok(String::from_utf8_lossy(&output).trim().to_string())
}

async fn gh_json(path: &Path, args: &[&str]) -> Result<Value, String> {
    let mut command = background_command(path);
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
        state: value
            .get("conclusion")
            .or_else(|| value.get("state"))
            .or_else(|| value.get("status"))
            .and_then(Value::as_str)
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

const PR_FIELDS: &str = "number,url,title,body,state,isDraft,headRefName,baseRefName,headRefOid,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup,updatedAt,mergedAt,author";

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
) -> Result<Option<GitHubPullRequest>, String> {
    validate_repository(repository)?;
    validate_ref(branch, "Branch")?;
    let info = repository_info(gh, repository).await?;
    let value = gh_json(
        gh,
        &[
            "pr", "list", "--repo", repository, "--state", "open", "--head", branch, "--limit",
            "1", "--json", PR_FIELDS,
        ],
    )
    .await?;
    value
        .as_array()
        .and_then(|items| items.first())
        .map(|item| pull_request_from_json(repository, item, &info))
        .transpose()
}

fn remote_for_repository(cwd: &Path, repository: &str) -> Result<String, String> {
    let remotes = git(cwd, &["remote"])?;
    for remote in remotes.lines() {
        if let Some(url) = optional_git_stdout(cwd, &["remote", "get-url", remote]) {
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
        let origin = optional_git_stdout(&selected, &["remote", "get-url", "origin"])
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
    find_with(&resolve_github_binary(&app).await?, &repository, &branch).await
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
    if base != default_branch {
        return Err(format!(
            "The base branch must be the repository default branch ({default_branch})."
        ));
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
        let selected = selected_repository(&cwd)?;
        let origin = optional_git_stdout(&selected, &["remote", "get-url", "origin"])
            .ok_or_else(|| "This repository has no origin remote.".to_string())?;
        let repository = parse_github_repository(&origin)
            .ok_or_else(|| "The origin remote is not a GitHub repository.".to_string())?;
        Ok((selected, repository))
    })
    .await?;
    // Resolve authentication up front so this command has the same GitHub
    // availability boundary as the rest of the PR workflow, without making a
    // network request or changing any remote state.
    let _ = resolve_github_binary(&app).await?;
    let lock = mutation_lock(&repository);
    let _guard = lock.lock().await;
    blocking_local(move || {
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
        git(&selected, &["switch", "-c", &name]).map(|_| ())
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
    let selected = blocking_local(move || selected_repository(&cwd)).await?;
    let gh = resolve_github_binary(&app).await?;
    let lock = mutation_lock(&repository);
    let _guard = lock.lock().await;
    let info = repository_info(&gh, &repository).await?;
    let preflight_selected = selected.clone();
    let preflight_repository = repository.clone();
    let preflight_head = head.clone();
    let preflight_base = base.clone();
    let preflight_expected = expected_head_oid.clone();
    let preflight_default = info.default_branch.clone();
    blocking_local(move || {
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
    if let Some(existing) = find_with(&gh, &repository, &head).await? {
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
    let (selected, remote) = blocking_local(move || {
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
        if commit_all {
            git(&selected, &["add", "-A"])?;
        }
        Ok((selected, remote))
    })
    .await?;
    if let Some(message) = commit_message {
        bounded_git(
            &selected,
            &["commit".into(), "-m".into(), message],
            MUTATION_TIMEOUT,
            "Git commit",
        )
        .await
        .map_err(|error| {
            format!("Could not create the requested commit. The changes remain staged: {error}")
        })?;
    }
    let verify_selected = selected.clone();
    let verify_head = head.clone();
    let verify_base = base.clone();
    let verify_remote = remote.clone();
    let verify_expected = expected_head_oid.clone();
    let refspec = blocking_local(move || {
        if committed_delta(&verify_selected, &verify_remote, &verify_base)? == 0 { return Err("There are no committed changes to include in this pull request. Commit changes explicitly or select Commit all changes.".into()); }
        let push_oid = push_oid_for(&verify_selected, &verify_head, &verify_expected, commit_all)?;
        Ok(format!("{push_oid}:refs/heads/{verify_head}"))
    }).await?;
    bounded_git(
        &selected,
        &["push".into(), "--".into(), remote, refspec],
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
    if let Some(existing) = find_with(&gh, &repository, &head).await? {
        return Ok(GitHubPrCreateResult::updated(existing));
    }
    let mut command = background_command(&gh);
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
    let output = command_output(command, MUTATION_TIMEOUT, "GitHub pull request creation").await
        .map_err(|error| format!("The branch was pushed, but GitHub did not confirm pull request creation. Refresh before retrying: {error}"))?;
    let url = String::from_utf8_lossy(&output).trim().to_string();
    let number = url
        .rsplit('/')
        .next()
        .and_then(|v| v.parse().ok())
        .ok_or_else(|| {
            format!("GitHub reported that the pull request was created at {url}, but its number could not be read. Refresh before retrying.")
        })?;
    view_with(&gh, &repository, number).await.map(GitHubPrCreateResult::created).map_err(|error| {
        format!("GitHub reported that the pull request was created at {url}, but its details could not be refreshed: {error}. Refresh before retrying.")
    })
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
    blocking_local(move || selected_repository(&cwd).map(|_| ())).await?;
    let gh = resolve_github_binary(&app).await?;
    let lock = mutation_lock(&repository);
    let _guard = lock.lock().await;
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
    let mut command = background_command(&gh);
    command.args(args);
    command_output(command, MUTATION_TIMEOUT, "GitHub pull request merge").await?;
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
    let lock = mutation_lock(&repository);
    let _guard = lock.lock().await;
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
    let mut command = background_command(&gh);
    command.args(["pr", "ready", "--repo", &repository, "--", &number_text]);
    command_output(command, MUTATION_TIMEOUT, "GitHub draft update").await?;
    view_with(&gh, &repository, number).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[cfg(unix)]
    fn fake_gh(root: &Path) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let script = root.join("gh");
        let log = root.join("gh.log");
        let source = format!(
            r#"#!/bin/sh
printf '%s\n' "$*" >> '{}'
if [ "$1" = api ]; then
  printf '%s\n' '{{"default_branch":"main","permissions":{{"push":true}},"allow_squash_merge":true,"allow_merge_commit":false,"allow_rebase_merge":false}}'
elif [ "$1" = pr ] && [ "$2" = view ]; then
  printf '%s\n' '{{"number":7,"url":"https://github.com/owner/repo/pull/7","title":"Topic","body":"Body","state":"OPEN","isDraft":false,"headRefName":"topic","baseRefName":"main","headRefOid":"0123456789abcdef0123456789abcdef01234567","mergeable":"MERGEABLE","mergeStateStatus":"CLEAN","reviewDecision":"APPROVED","statusCheckRollup":[{{"name":"build","conclusion":"SUCCESS","detailsUrl":"https://example.test/check"}}],"updatedAt":"2026-09-22T00:00:00Z","mergedAt":null,"author":{{"login":"tester"}}}}'
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
        }
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
        let mut command = background_command(&gh);
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
