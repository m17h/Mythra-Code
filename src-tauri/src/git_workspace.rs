use std::{
    collections::{HashMap, HashSet},
    env,
    io::Read,
    path::{Path, PathBuf},
    process::{Output, Stdio},
    sync::{
        atomic::{AtomicUsize, Ordering},
        mpsc, Arc, Mutex as StdMutex, OnceLock, Weak,
    },
    thread,
    time::{Duration, Instant},
};

use serde::Serialize;
use tokio::sync::Mutex;

use crate::{
    github::parse_github_repository,
    project_git::{
        git_command_for, git_common_dir, git_stdout, optional_git_stdout, GitReadOperation,
    },
};

const NETWORK_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_NETWORK_OUTPUT: usize = 64 * 1024;
const TRACKING_READ_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_TRACKING_READ_OUTPUT: usize = 16 * 1024;
const LOCAL_TIMEOUT: Duration = Duration::from_secs(120);
const MAX_LOCAL_OUTPUT: usize = 512 * 1024;
const REVERT_PREVIEW_TTL: Duration = Duration::from_secs(5 * 60);
const MAX_REVERT_PREVIEWS: usize = 64;
const MAX_BULK_REVERT_PREVIEWS: usize = 8;
const MAX_BULK_REVERT_PATHS: usize = 256;
const MAX_BULK_REVERT_PATH_BYTES: usize = 16 * 1024;
const MAX_BULK_REVERT_WORKING_BYTES: u64 = 128 * 1024 * 1024;
const BULK_REVERT_INSPECTION_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct GitWorkspaceBranch {
    name: String,
    current: bool,
    worktree_path: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct GitWorkspaceSnapshot {
    branch: Option<String>,
    head_oid: Option<String>,
    upstream: Option<String>,
    upstream_remote: Option<String>,
    ahead: Option<usize>,
    behind: Option<usize>,
    branches: Vec<GitWorkspaceBranch>,
    staged_files: usize,
    unstaged_files: usize,
    changed_files: usize,
    staged_paths: Vec<String>,
    root_path: String,
    is_root: bool,
    changes: Option<crate::git_inspection::ProjectGitChanges>,
    changes_error: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct GitWorkspaceCommandResult {
    stdout: String,
    stderr: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct GitWorkspaceRevertPreview {
    token: String,
    paths: Vec<String>,
    restore_paths: Vec<String>,
    preserved_paths: Vec<String>,
    head_oid: String,
    branch: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct GitWorkspaceRevertAllPreview {
    token: String,
    restore_paths: Vec<String>,
    preserved_paths: Vec<String>,
    head_oid: String,
    branch: Option<String>,
}

#[derive(Debug, PartialEq, Eq)]
enum RevertWorkingState {
    Missing,
    File { oid: String, mode: u32 },
    Symlink(PathBuf),
}

#[derive(Debug, PartialEq, Eq)]
struct RevertState {
    root: PathBuf,
    common_dir: PathBuf,
    requested_path: String,
    paths: Vec<String>,
    restore_paths: Vec<String>,
    preserved_paths: Vec<String>,
    head_oid: String,
    branch: Option<String>,
    index: Vec<u8>,
    working: Vec<RevertWorkingState>,
}

struct SavedRevertPreview {
    created: Instant,
    state: RevertState,
}

fn revert_previews() -> &'static StdMutex<HashMap<String, SavedRevertPreview>> {
    static PREVIEWS: OnceLock<StdMutex<HashMap<String, SavedRevertPreview>>> = OnceLock::new();
    PREVIEWS.get_or_init(|| StdMutex::new(HashMap::new()))
}

#[derive(Debug, PartialEq, Eq)]
struct BulkRevertState {
    root: PathBuf,
    common_dir: PathBuf,
    head_oid: String,
    branch: Option<String>,
    index: Vec<u8>,
    status: Vec<u8>,
    paths: Vec<String>,
    restore_paths: Vec<String>,
    preserved_paths: Vec<String>,
    working: Vec<RevertWorkingState>,
}

struct SavedBulkRevertPreview {
    created: Instant,
    state: BulkRevertState,
}

fn bulk_revert_previews() -> &'static StdMutex<HashMap<String, SavedBulkRevertPreview>> {
    static PREVIEWS: OnceLock<StdMutex<HashMap<String, SavedBulkRevertPreview>>> = OnceLock::new();
    PREVIEWS.get_or_init(|| StdMutex::new(HashMap::new()))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct GitWorkspaceCommitResult {
    head_oid: String,
    branch: Option<String>,
    stdout: String,
    stderr: String,
}

fn lock_registry() -> &'static StdMutex<HashMap<PathBuf, Weak<Mutex<()>>>> {
    static LOCKS: OnceLock<StdMutex<HashMap<PathBuf, Weak<Mutex<()>>>>> = OnceLock::new();
    LOCKS.get_or_init(|| StdMutex::new(HashMap::new()))
}

/// Returns the process-wide mutation lock for the repository containing `cwd`.
/// Linked worktrees share one lock because the key is Git's canonical common dir.
pub(super) async fn repository_lock(cwd: &Path) -> Result<Arc<Mutex<()>>, String> {
    let cwd = cwd.to_path_buf();
    let key = tauri::async_runtime::spawn_blocking(move || {
        let selected = cwd
            .canonicalize()
            .map_err(|error| format!("Could not open the project folder: {error}"))?;
        git_common_dir(&selected)?
            .canonicalize()
            .map_err(|error| format!("Could not resolve the Git common directory: {error}"))
    })
    .await
    .map_err(|error| format!("Repository lock resolution failed: {error}"))??;
    let mut locks = lock_registry()
        .lock()
        .map_err(|_| "The repository lock registry is unavailable".to_string())?;
    if let Some(existing) = locks.get(&key).and_then(Weak::upgrade) {
        return Ok(existing);
    }
    locks.retain(|_, lock| lock.strong_count() > 0);
    let lock = Arc::new(Mutex::new(()));
    locks.insert(key, Arc::downgrade(&lock));
    Ok(lock)
}

fn repo(cwd: &str) -> Result<PathBuf, String> {
    repo_with_read(cwd, &GitReadOperation::new())
}

fn repo_with_read(cwd: &str, read: &GitReadOperation) -> Result<PathBuf, String> {
    let selected = PathBuf::from(cwd)
        .canonicalize()
        .map_err(|error| format!("Could not open the project folder: {error}"))?;
    let root = read.stdout(&selected, &["rev-parse", "--show-toplevel"])?;
    PathBuf::from(root)
        .canonicalize()
        .map_err(|error| format!("Could not open the Git repository root: {error}"))
}

fn mutation_repo(cwd: &str) -> Result<PathBuf, String> {
    let root = repo(cwd)?;
    let selected = Path::new(cwd)
        .canonicalize()
        .map_err(|error| format!("Could not open the project folder: {error}"))?;
    if selected != root {
        return Err("Open the Git repository root before changing Git".into());
    }
    Ok(root)
}

fn worktree_records_with_read(
    repo: &Path,
    read: &GitReadOperation,
) -> Result<Vec<(String, Option<String>)>, String> {
    let output = read.output(repo, &["worktree", "list", "--porcelain", "-z"])?;
    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if detail.is_empty() {
            "Could not inspect Git worktrees".into()
        } else {
            detail
        });
    }
    let mut records = Vec::new();
    for field in output.stdout.split(|byte| *byte == 0) {
        if let Some(value) = field.strip_prefix(b"worktree ") {
            let value = String::from_utf8_lossy(value).into_owned();
            records.push((value, None));
        } else if let Some(value) = field.strip_prefix(b"branch refs/heads/") {
            let (_, recorded_branch) = records
                .last_mut()
                .ok_or_else(|| "Git returned an unreadable worktree list".to_string())?;
            *recorded_branch = Some(String::from_utf8_lossy(value).into_owned());
        }
    }
    Ok(records)
}

pub(super) fn worktree_paths_with_read(
    repo: &Path,
    read: &GitReadOperation,
) -> Result<Vec<String>, String> {
    Ok(worktree_records_with_read(repo, read)?
        .into_iter()
        .map(|(path, _)| path)
        .collect())
}

pub(super) fn worktree_branch_paths(repo: &Path) -> Result<HashMap<String, String>, String> {
    worktree_branch_paths_with_read(repo, &GitReadOperation::new())
}

pub(super) fn worktree_branch_paths_with_read(
    repo: &Path,
    read: &GitReadOperation,
) -> Result<HashMap<String, String>, String> {
    Ok(worktree_records_with_read(repo, read)?
        .into_iter()
        .filter_map(|(path, branch)| branch.map(|branch| (branch, path)))
        .collect())
}

fn tracking_stdout(repo: &Path, args: &[&str], deadline: Instant) -> Option<String> {
    let (output, truncated) = bounded_git_output(
        repo,
        args,
        deadline.checked_duration_since(Instant::now())?,
        MAX_TRACKING_READ_OUTPUT,
        false,
    )
    .ok()?;
    if !output.status.success() || truncated {
        return None;
    }
    String::from_utf8(output.stdout).ok()
}


/// Upstream metadata for the checked-out branch, read in the same
/// `for-each-ref` as the branch list and HEAD, so it is bound to that HEAD.
struct BranchUpstream {
    short: String,
    full: String,
    remote: String,
}

fn snapshot_tracking_with_deadline(
    repo: &Path,
    head_oid: Option<&str>,
    upstream: Option<&BranchUpstream>,
    deadline: Instant,
) -> (Option<String>, Option<String>, Option<usize>, Option<usize>) {
    let (Some(head_oid), Some(metadata)) = (head_oid, upstream) else {
        return (None, None, None, None);
    };
    if metadata.full.is_empty() {
        return (None, None, None, None);
    }
    let upstream = Some(metadata.short.clone());
    let upstream_remote = (!metadata.remote.is_empty()).then(|| metadata.remote.clone());
    let Some(upstream_oid) = tracking_stdout(
        repo,
        &[
            "rev-parse",
            "--verify",
            &format!("{}^{{commit}}", metadata.full),
        ],
        deadline,
    ) else {
        return (upstream, upstream_remote, None, None);
    };
    // Use immutable identities, not HEAD or @{upstream}, which another Git
    // client could retarget between the metadata and history reads.
    let comparison = format!("{head_oid}...{}", upstream_oid.trim());
    let counts = tracking_stdout(
        repo,
        &["rev-list", "--left-right", "--count", &comparison],
        deadline,
    )
    .and_then(|value| {
        let mut parts = value.split_whitespace();
        let ahead = parts.next()?.parse().ok()?;
        let behind = parts.next()?.parse().ok()?;
        if parts.next().is_some() {
            return None;
        }
        Some((ahead, behind))
    });
    match counts {
        Some((ahead, behind)) => (upstream, upstream_remote, Some(ahead), Some(behind)),
        None => (upstream, upstream_remote, None, None),
    }
}


fn snapshot_with_read(
    repo: &Path,
    read: &GitReadOperation,
) -> Result<GitWorkspaceSnapshot, String> {
    // One read gives the branch list, the checked-out branch (%(HEAD)), its
    // commit and its upstream, all from the same moment. Separate
    // symbolic-ref / rev-parse / upstream reads remain only for a detached
    // or unborn HEAD, which no listed branch marks as current.
    let refs = read.stdout(
        repo,
        &[
            "for-each-ref",
            "--format=%(HEAD)%00%(refname:strip=2)%00%(objectname)%00%(upstream:short)%00%(upstream)%00%(upstream:remotename)",
            "refs/heads",
        ],
    )?;
    let mut names = Vec::new();
    let mut current: Option<(String, String, BranchUpstream)> = None;
    for line in refs.lines().filter(|line| !line.is_empty()) {
        let fields: Vec<_> = line.split('\0').collect();
        if fields.len() != 6 || fields[1].is_empty() {
            return Err("Git returned unreadable branch information".into());
        }
        if fields[0] == "*" {
            current = Some((
                fields[1].to_string(),
                fields[2].to_string(),
                BranchUpstream {
                    short: fields[3].to_string(),
                    full: fields[4].to_string(),
                    remote: fields[5].to_string(),
                },
            ));
        }
        names.push(fields[1].to_string());
    }
    let (branch, head_oid, upstream_metadata) = match current {
        Some((name, oid, upstream)) => (Some(name), Some(oid), Some(upstream)),
        None => (
            read.optional_stdout(repo, &["symbolic-ref", "--short", "-q", "HEAD"])?,
            read.optional_stdout(repo, &["rev-parse", "--verify", "--quiet", "HEAD"])?,
            None,
        ),
    };
    let occupied = worktree_branch_paths_with_read(repo, read)?;
    let mut branches: Vec<_> = names
        .iter()
        .map(|name| name.as_str())
        .map(|name| GitWorkspaceBranch {
            name: name.to_string(),
            current: branch.as_deref() == Some(name),
            worktree_path: occupied
                .get(name)
                .filter(|value| !value.is_empty())
                .cloned(),
        })
        .collect();
    branches.sort_by(|a, b| a.name.cmp(&b.name));

    // `git_stdout` trims text output. Porcelain status deliberately starts an
    // unstaged tracked entry with a space, and paths may end with spaces, so
    // parse the raw NUL-delimited bytes without any text normalization.
    let status = read.output(
        repo,
        &["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    )?;
    if !status.status.success() {
        let detail = String::from_utf8_lossy(&status.stderr).trim().to_string();
        return Err(if detail.is_empty() {
            "Could not inspect Git workspace status".into()
        } else {
            detail
        });
    }
    let mut staged_paths = Vec::new();
    let mut staged_files = 0;
    let mut changed = HashSet::new();
    let mut unstaged = HashSet::new();
    let entries: Vec<&[u8]> = status
        .stdout
        .split(|byte| *byte == 0)
        .filter(|entry| !entry.is_empty())
        .collect();
    let mut index = 0;
    while index < entries.len() {
        let entry = entries[index];
        if entry.len() < 3 {
            return Err("Git returned an unreadable workspace status".into());
        }
        let x = entry[0] as char;
        let y = entry[1] as char;
        let name = &entry[3..];
        changed.insert(name);
        if x != ' ' && x != '?' {
            staged_files += 1;
            // Byte filenames may not be representable across the bridge. Keep
            // counts exact without inventing a different per-file action path.
            if let Ok(name) = std::str::from_utf8(name) {
                staged_paths.push(name.to_string());
            }
        }
        if y != ' ' || x == '?' {
            unstaged.insert(name);
        }
        index += if matches!(x, 'R' | 'C') || matches!(y, 'R' | 'C') {
            2
        } else {
            1
        };
    }
    staged_paths.sort();
    // A presentation failure must not erase independently verified checkout
    // identity and counts. The Changes consumer receives an explicit error.
    let (changes, changes_error) =
        match crate::git_inspection::changes_from_status(repo, &status.stdout, false, 500) {
            Ok(changes) => (Some(changes), None),
            Err(error)
                if error.starts_with("A Git filename is not valid UTF-8")
                    || error == "Git filename must be a literal repository-relative path" =>
            {
                (None, Some(error))
            }
            Err(error) => return Err(error),
        };
    let (upstream, upstream_remote, ahead, behind) = snapshot_tracking_with_deadline(
        repo,
        head_oid.as_deref(),
        upstream_metadata.as_ref(),
        read.deadline().min(Instant::now() + TRACKING_READ_TIMEOUT),
    );
    Ok(GitWorkspaceSnapshot {
        branch,
        head_oid,
        upstream,
        upstream_remote,
        ahead,
        behind,
        branches,
        staged_files,
        unstaged_files: unstaged.len(),
        changed_files: changed.len(),
        staged_paths,
        root_path: repo.to_string_lossy().into_owned(),
        is_root: true,
        changes,
        changes_error,
    })
}

fn snapshot_for_selection(root: &Path, cwd: &str) -> Result<GitWorkspaceSnapshot, String> {
    // These callers have already received success from a mutation. A failed
    // bounded refresh is not evidence that the requested change did not happen.
    snapshot_for_selection_with_read(root, cwd, &GitReadOperation::new()).map_err(|error| {
        format!("Git completed the requested operation, but its workspace state could not be refreshed: {error}. Changes may already have taken effect; refresh and inspect the checkout before trying again.")
    })
}

fn snapshot_for_selection_with_read(
    root: &Path,
    cwd: &str,
    read: &GitReadOperation,
) -> Result<GitWorkspaceSnapshot, String> {
    let selected = Path::new(cwd)
        .canonicalize()
        .map_err(|error| format!("Could not open the project folder: {error}"))?;
    let mut value = snapshot_with_read(root, read)?;
    value.is_root = selected == root;
    Ok(value)
}

fn require_expected(repo: &Path, expected_head: &str, expected_branch: &str) -> Result<(), String> {
    let actual_head = optional_git_stdout(repo, &["rev-parse", "--verify", "HEAD"])
        .ok_or_else(|| "Branch changes require at least one commit".to_string())?;
    let actual_branch = optional_git_stdout(repo, &["symbolic-ref", "--short", "-q", "HEAD"])
        .ok_or_else(|| "Check out a named branch before changing branches".to_string())?;
    if actual_head != expected_head || actual_branch != expected_branch {
        return Err("The repository changed since it was shown. Refresh and try again.".into());
    }
    Ok(())
}

fn require_expected_checkout(
    repo: &Path,
    expected_head: Option<&str>,
    expected_branch: Option<&str>,
) -> Result<(), String> {
    // A missing snapshot is permitted; an unborn branch has a branch name but
    // no HEAD, and a detached checkout has a HEAD but no branch name.
    if expected_head.is_none() && expected_branch.is_none() {
        return Ok(());
    }
    let head = optional_git_stdout(repo, &["rev-parse", "--verify", "HEAD"]);
    let branch = optional_git_stdout(repo, &["symbolic-ref", "--short", "-q", "HEAD"]);
    if head.as_deref() != expected_head || branch.as_deref() != expected_branch {
        return Err("The repository changed since it was shown. Refresh and try again.".into());
    }
    Ok(())
}

fn local_git(repo: &Path, args: &[&str]) -> Result<GitWorkspaceCommandResult, String> {
    local_git_with_options(repo, args, LOCAL_TIMEOUT, MAX_LOCAL_OUTPUT)
}

fn local_git_with_options(
    repo: &Path,
    args: &[&str],
    timeout: Duration,
    output_limit: usize,
) -> Result<GitWorkspaceCommandResult, String> {
    let (output, truncated) = bounded_git_output(repo, args, timeout, output_limit, false)?;
    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    let mut stderr = String::from_utf8_lossy(&output.stderr).into_owned();
    if truncated {
        stderr.push_str("\nGit output was truncated.\n");
    }
    if !output.status.success() {
        let detail = format!("{stdout}{stderr}").trim().to_string();
        return Err(if detail.is_empty() {
            format!("Git command failed: git {}", args.join(" "))
        } else {
            detail
        });
    }
    Ok(GitWorkspaceCommandResult { stdout, stderr })
}

fn unstage_paths(repo: &Path, path: &str) -> Result<Vec<String>, String> {
    // A rename is represented in the index as a deletion plus an addition.
    // Reset both endpoints of the rename shown by Git, rather than leaving
    // half of it staged when Review supplies just the displayed filename.
    let (output, truncated) = bounded_git_output(
        repo,
        &[
            "diff",
            "--cached",
            "--name-status",
            "-z",
            "--find-renames",
            "--no-ext-diff",
        ],
        LOCAL_TIMEOUT,
        MAX_LOCAL_OUTPUT,
        false,
    )?;
    if !output.status.success() || truncated {
        return Err("Could not inspect staged renames. Refresh or use Unstage all changes.".into());
    }
    let fields: Vec<_> = output
        .stdout
        .split(|byte| *byte == 0)
        .filter(|field| !field.is_empty())
        .collect();
    let mut index = 0;
    while index < fields.len() {
        let status = fields[index];
        let source = fields
            .get(index + 1)
            .ok_or_else(|| "Git returned an unreadable staged file list".to_string())?;
        let paired = matches!(status.first(), Some(b'R' | b'C'));
        if paired {
            let target = fields
                .get(index + 2)
                .ok_or_else(|| "Git returned an unreadable staged rename".to_string())?;
            // A copy keeps its source. Unstaging its new file must not reset
            // independent staged changes to the original file.
            if status.first() == Some(&b'R')
                && (*source == path.as_bytes() || *target == path.as_bytes())
            {
                return [*source, *target]
                    .into_iter()
                    .map(|value| {
                        String::from_utf8(value.to_vec()).map_err(|_| {
                            "This rename contains a non-Unicode path. Use Unstage all changes."
                                .to_string()
                        })
                    })
                    .collect();
            }
        }
        index += if paired { 3 } else { 2 };
    }
    Ok(vec![path.to_string()])
}

fn validate_revert_path(root: &Path, path: &str) -> Result<PathBuf, String> {
    if path.is_empty()
        || path.len() > 4096
        || path.split('/').any(|part| matches!(part, "" | "." | ".."))
        || Path::new(path).components().any(|component| {
            !matches!(component, std::path::Component::Normal(_))
                || component
                    .as_os_str()
                    .to_str()
                    .is_some_and(|part| part.eq_ignore_ascii_case(".git"))
        })
    {
        return Err("Choose one file inside the Git repository to revert".into());
    }
    #[cfg(windows)]
    if path.contains('\\') {
        // Git's status/index paths use forward slashes. Keep that exact form
        // so alternate spellings cannot bypass native rename pairing.
        return Err("Choose the exact file path shown by Git to revert".into());
    }
    let components: Vec<_> = Path::new(path).components().collect();
    let mut selected = root.to_path_buf();
    for (index, component) in components.iter().enumerate() {
        selected.push(component.as_os_str());
        match std::fs::symlink_metadata(&selected) {
            Ok(metadata) if index + 1 < components.len() => {
                if metadata.file_type().is_symlink() || !metadata.is_dir() {
                    return Err("A parent of this file is a symlink or is not a directory. Revert it manually after inspecting the path.".into());
                }
            }
            Ok(metadata) if metadata.is_dir() => {
                return Err("Choose one file, not a folder, to revert".into());
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("Could not inspect the file to revert: {error}")),
        }
    }
    Ok(selected)
}

fn revert_working_state(root: &Path, path: &str) -> Result<RevertWorkingState, String> {
    revert_working_state_with_timeout(root, path, LOCAL_TIMEOUT)
}

fn revert_working_state_with_timeout(
    root: &Path,
    path: &str,
    timeout: Duration,
) -> Result<RevertWorkingState, String> {
    let selected = validate_revert_path(root, path)?;
    let metadata = match std::fs::symlink_metadata(&selected) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(RevertWorkingState::Missing);
        }
        Err(error) => return Err(format!("Could not inspect the file to revert: {error}")),
    };
    if metadata.file_type().is_symlink() {
        // Git restores the link itself. Never read through its target, which
        // may intentionally point outside the repository.
        return std::fs::read_link(selected)
            .map(RevertWorkingState::Symlink)
            .map_err(|error| format!("Could not inspect the symlink to revert: {error}"));
    }
    if !metadata.is_file() {
        return Err("This path is not a regular file or symlink. Revert it manually.".into());
    }
    let oid = local_git_with_options(
        root,
        &["hash-object", "--no-filters", "--", path],
        timeout,
        MAX_LOCAL_OUTPUT,
    )?
    .stdout
    .trim()
    .to_string();
    if !matches!(oid.len(), 40 | 64) || !oid.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("Could not identify the working file contents. Refresh and try again.".into());
    }
    // Detect an edit or path replacement during the hashing operation too.
    let after = std::fs::symlink_metadata(validate_revert_path(root, path)?)
        .map_err(|_| "The working file changed while it was inspected. Try again.".to_string())?;
    if !after.is_file()
        || metadata.len() != after.len()
        || metadata.modified().ok() != after.modified().ok()
        || metadata.permissions() != after.permissions()
    {
        return Err("The working file changed while it was inspected. Try again.".into());
    }
    #[cfg(unix)]
    let mode = {
        use std::os::unix::fs::PermissionsExt;
        metadata.permissions().mode() & 0o777
    };
    #[cfg(not(unix))]
    let mode = u32::from(metadata.permissions().readonly());
    Ok(RevertWorkingState::File { oid, mode })
}

fn revert_state(cwd: &str, path: &str) -> Result<RevertState, String> {
    let root = mutation_repo(cwd)?;
    validate_revert_path(&root, path)?;
    let head_oid =
        optional_git_stdout(&root, &["rev-parse", "--verify", "HEAD"]).ok_or_else(|| {
            "This repository has no saved commit to restore. Use Unstage to keep its initial files."
                .to_string()
        })?;
    let branch = optional_git_stdout(&root, &["symbolic-ref", "--short", "-q", "HEAD"]);
    let common_dir = git_common_dir(&root)?
        .canonicalize()
        .map_err(|error| format!("Could not resolve the Git common directory: {error}"))?;
    let paths = unstage_paths(&root, path)?;
    let mut args = vec!["--literal-pathspecs", "ls-files", "--stage", "-z", "--"];
    args.extend(paths.iter().map(String::as_str));
    let (index, truncated) = bounded_git_output(&root, &args, LOCAL_TIMEOUT, 64 * 1024, false)?;
    if !index.status.success() || truncated {
        return Err("Could not inspect the staged files to revert. Refresh and try again.".into());
    }
    let mut args = vec![
        "--literal-pathspecs",
        "ls-tree",
        "--name-only",
        "-z",
        &head_oid,
        "--",
    ];
    args.extend(paths.iter().map(String::as_str));
    let (head, truncated) = bounded_git_output(&root, &args, LOCAL_TIMEOUT, 64 * 1024, false)?;
    if !head.status.success() || truncated {
        return Err("Could not inspect the saved files to restore. Refresh and try again.".into());
    }
    if index.stdout.is_empty() && head.stdout.is_empty() {
        return Err(
            "This file is not tracked by Git. Revert does not delete untracked files.".into(),
        );
    }
    let head_paths: HashSet<_> = head
        .stdout
        .split(|byte| *byte == 0)
        .filter(|path| !path.is_empty())
        .map(|path| {
            std::str::from_utf8(path).map(str::to_owned).map_err(|_| {
                "A saved Git path is not valid Unicode. Use Unstage instead.".to_string()
            })
        })
        .collect::<Result<_, _>>()?;
    let indexed_paths: HashSet<_> = index
        .stdout
        .split(|byte| *byte == 0)
        .filter(|entry| !entry.is_empty())
        .map(|entry| {
            let separator = entry
                .iter()
                .position(|byte| *byte == b'\t')
                .ok_or_else(|| "Git returned an unreadable staged file list".to_string())?;
            std::str::from_utf8(&entry[separator + 1..])
                .map(str::to_owned)
                .map_err(|_| {
                    "A staged Git path is not valid Unicode. Use Unstage instead.".to_string()
                })
        })
        .collect::<Result<_, _>>()?;
    let (restore_paths, preserved_paths): (Vec<_>, Vec<_>) = paths
        .iter()
        .cloned()
        .partition(|path| head_paths.contains(path));
    let working: Vec<_> = paths
        .iter()
        .map(|path| revert_working_state(&root, path))
        .collect::<Result<_, _>>()?;
    for (path, working) in paths.iter().zip(&working) {
        if head_paths.contains(path)
            && !indexed_paths.contains(path)
            && *working != RevertWorkingState::Missing
        {
            // A staged deletion (including a rename source) can be followed
            // by a new, untracked file at the same path. Restoring HEAD would
            // overwrite that file, so keep it for manual inspection.
            return Err(format!("The deleted path {path} has been recreated. Revert would overwrite that file; move or preserve it before trying again."));
        }
        if preserved_paths.contains(path) && *working == RevertWorkingState::Missing {
            return Err("This newly staged file has no working copy. Its contents remain in the index; restore the working copy or export the staged contents before unstaging. Unstage cannot recover a missing working file. Nothing was reverted.".into());
        }
    }
    if restore_paths.is_empty() {
        return Err("This is a newly added or copied file with no committed version to restore. Use Unstage to keep its working contents; Revert does not delete new files.".into());
    }
    require_expected_checkout(&root, Some(&head_oid), branch.as_deref())?;
    Ok(RevertState {
        root,
        common_dir,
        requested_path: path.to_string(),
        paths,
        restore_paths,
        preserved_paths,
        head_oid,
        branch,
        index: index.stdout,
        working,
    })
}

fn revert_preview_sync(cwd: &str, path: &str) -> Result<GitWorkspaceRevertPreview, String> {
    let state = revert_state(cwd, path)?;
    let token = uuid::Uuid::new_v4().to_string();
    let result = GitWorkspaceRevertPreview {
        token: token.clone(),
        paths: state.paths.clone(),
        restore_paths: state.restore_paths.clone(),
        preserved_paths: state.preserved_paths.clone(),
        head_oid: state.head_oid.clone(),
        branch: state.branch.clone(),
    };
    let mut previews = revert_previews()
        .lock()
        .map_err(|_| "Revert confirmation is unavailable. Try again.".to_string())?;
    previews.retain(|_, saved| saved.created.elapsed() < REVERT_PREVIEW_TTL);
    if previews.len() >= MAX_REVERT_PREVIEWS {
        if let Some(oldest) = previews
            .iter()
            .min_by_key(|(_, saved)| saved.created)
            .map(|(token, _)| token.clone())
        {
            previews.remove(&oldest);
        }
    }
    previews.insert(
        token,
        SavedRevertPreview {
            created: Instant::now(),
            state,
        },
    );
    Ok(result)
}

fn revert_sync(
    cwd: &str,
    path: &str,
    expected_token: &str,
) -> Result<GitWorkspaceCommandResult, String> {
    let saved = revert_previews()
        .lock()
        .map_err(|_| "Revert confirmation is unavailable. Try again.".to_string())?
        .remove(expected_token)
        .ok_or_else(|| {
            "This revert confirmation expired or was already used. Refresh and confirm again."
                .to_string()
        })?;
    if saved.created.elapsed() >= REVERT_PREVIEW_TTL || revert_state(cwd, path)? != saved.state {
        return Err("The repository or file changed during confirmation. Nothing was reverted; refresh and confirm again.".into());
    }
    // Pin the actual source object, not a mutable HEAD symbolic reference.
    let source = format!("--source={}", saved.state.head_oid);
    let mut args = vec!["--literal-pathspecs", "restore", &source, "--staged", "--"];
    args.extend(saved.state.paths.iter().map(String::as_str));
    let unstaged = local_git(&saved.state.root, &args).map_err(|error| format!("Revert did not finish resetting the selected index paths: {error}\nGit may have changed staging, but this step does not remove working files. Refresh and inspect before trying again."))?;
    let mut args = vec![
        "--literal-pathspecs",
        "restore",
        &source,
        "--worktree",
        "--",
    ];
    args.extend(saved.state.restore_paths.iter().map(String::as_str));
    let restored = local_git(&saved.state.root, &args).map_err(|error| format!("Revert reset the selected index paths, but restoring committed working files did not finish: {error}\nSome tracked paths may have changed. New and renamed-destination contents were not selected for removal. Refresh and inspect before trying again."))?;
    Ok(GitWorkspaceCommandResult {
        stdout: format!("{}{}", unstaged.stdout, restored.stdout),
        stderr: format!("{}{}", unstaged.stderr, restored.stderr),
    })
}

fn bulk_revert_remaining(deadline: Instant) -> Result<Duration, String> {
    let remaining = deadline.saturating_duration_since(Instant::now());
    if remaining.is_zero() {
        Err("Bulk revert inspection timed out. Nothing was reverted; use per-file actions after inspecting the checkout.".into())
    } else {
        Ok(remaining)
    }
}

fn bulk_revert_output(root: &Path, args: &[&str], deadline: Instant) -> Result<Vec<u8>, String> {
    let (output, truncated) = bounded_git_output(
        root,
        args,
        bulk_revert_remaining(deadline)?,
        MAX_LOCAL_OUTPUT,
        false,
    )?;
    if truncated {
        return Err("This checkout is too large to safely confirm Revert all. Nothing was reverted; use per-file actions.".into());
    }
    if !output.status.success() {
        return Err(format!(
            "Could not inspect Revert all: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(output.stdout)
}

fn bulk_revert_path(value: &[u8]) -> Result<String, String> {
    String::from_utf8(value.to_vec())
        .map_err(|_| "Revert all needs Unicode paths. Use Git manually for this checkout.".into())
}

fn bulk_revert_state(cwd: &str) -> Result<BulkRevertState, String> {
    let root = mutation_repo(cwd)?;
    let deadline = Instant::now() + BULK_REVERT_INSPECTION_TIMEOUT;
    let head =
        bulk_revert_output(&root, &["rev-parse", "--verify", "HEAD"], deadline).map_err(|_| {
            "This repository has no readable saved commit. Use Unstage to keep its initial files."
                .to_string()
        })?;
    let head_oid = String::from_utf8_lossy(&head).trim().to_string();
    let reference = bulk_revert_output(
        &root,
        &["rev-parse", "--symbolic-full-name", "HEAD"],
        deadline,
    )?;
    let reference = String::from_utf8_lossy(&reference);
    let branch = reference
        .trim()
        .strip_prefix("refs/heads/")
        .map(str::to_string);
    let common_dir = git_common_dir(&root)?
        .canonicalize()
        .map_err(|error| format!("Could not resolve the Git common directory: {error}"))?;
    let status_args = ["status", "--porcelain=v1", "-z", "--untracked-files=all"];
    let index_args = ["ls-files", "--stage", "-z"];
    let status = bulk_revert_output(&root, &status_args, deadline)?;
    let index = bulk_revert_output(&root, &index_args, deadline)?;
    let mut indexed_paths = HashSet::new();
    for entry in index
        .split(|byte| *byte == 0)
        .filter(|entry| !entry.is_empty())
    {
        let separator = entry
            .iter()
            .position(|byte| *byte == b'\t')
            .ok_or_else(|| "Git returned an unreadable index. Nothing was reverted.".to_string())?;
        if !entry[..separator].ends_with(b" 0") {
            return Err(
                "Resolve Git conflicts before using Revert all. Nothing was reverted.".into(),
            );
        }
        indexed_paths.insert(bulk_revert_path(&entry[separator + 1..])?);
    }
    let entries: Vec<_> = status
        .split(|byte| *byte == 0)
        .filter(|entry| !entry.is_empty())
        .collect();
    let mut paths = Vec::new();
    let mut cursor = 0;
    while cursor < entries.len() {
        let entry = entries[cursor];
        if entry.len() < 4 || entry[2] != b' ' {
            return Err("Git returned an unreadable changes list. Nothing was reverted.".into());
        }
        if entry[..2].contains(&b'U') {
            return Err(
                "Resolve Git conflicts before using Revert all. Nothing was reverted.".into(),
            );
        }
        paths.push(bulk_revert_path(&entry[3..])?);
        cursor += 1;
        if entry[..2]
            .iter()
            .any(|status| matches!(status, b'R' | b'C'))
        {
            let source = entries.get(cursor).ok_or_else(|| {
                "Git returned an unreadable rename. Nothing was reverted.".to_string()
            })?;
            paths.push(bulk_revert_path(source)?);
            cursor += 1;
        }
    }
    paths.sort();
    paths.dedup();
    if paths.is_empty() {
        return Err("There are no changes to revert.".into());
    }
    if paths.len() > MAX_BULK_REVERT_PATHS
        || paths.iter().map(String::len).sum::<usize>() > MAX_BULK_REVERT_PATH_BYTES
    {
        return Err("This checkout has too many changed paths to safely confirm Revert all. Nothing was reverted; use per-file actions.".into());
    }
    let mut head_args = vec![
        "--literal-pathspecs",
        "ls-tree",
        "-r",
        "--name-only",
        "-z",
        &head_oid,
        "--",
    ];
    head_args.extend(paths.iter().map(String::as_str));
    let head_paths = bulk_revert_output(&root, &head_args, deadline)?;
    let head_paths: HashSet<_> = head_paths
        .split(|byte| *byte == 0)
        .filter(|entry| !entry.is_empty())
        .map(bulk_revert_path)
        .collect::<Result<_, _>>()?;
    let mut restore_paths = Vec::new();
    let mut preserved_paths = Vec::new();
    let mut working = Vec::new();
    let mut working_bytes = 0u64;
    for path in &paths {
        let selected = validate_revert_path(&root, path)?;
        if let Ok(metadata) = std::fs::symlink_metadata(&selected) {
            working_bytes = working_bytes.saturating_add(metadata.len());
            if working_bytes > MAX_BULK_REVERT_WORKING_BYTES {
                return Err("The changed files are too large to safely confirm Revert all. Nothing was reverted; use per-file actions.".into());
            }
        }
        let value =
            revert_working_state_with_timeout(&root, path, bulk_revert_remaining(deadline)?)?;
        if head_paths.contains(path) {
            if !indexed_paths.contains(path) && value != RevertWorkingState::Missing {
                return Err(format!("The deleted or renamed source {path:?} has been recreated. Revert all would overwrite a new file; preserve it before trying again."));
            }
            restore_paths.push(path.clone());
        } else {
            if indexed_paths.contains(path) && value == RevertWorkingState::Missing {
                return Err(format!("The newly staged file {path:?} has no working copy. Restore or unstage it manually before Revert all so its staged contents are not lost."));
            }
            preserved_paths.push(path.clone());
        }
        working.push(value);
    }
    require_expected_checkout(&root, Some(&head_oid), branch.as_deref())?;
    if bulk_revert_output(&root, &index_args, deadline)? != index
        || bulk_revert_output(&root, &status_args, deadline)? != status
    {
        return Err("The repository changed while Revert all was inspected. Nothing was reverted; refresh and try again.".into());
    }
    Ok(BulkRevertState {
        root,
        common_dir,
        head_oid,
        branch,
        index,
        status,
        paths,
        restore_paths,
        preserved_paths,
        working,
    })
}

fn revert_all_preview_sync(cwd: &str) -> Result<GitWorkspaceRevertAllPreview, String> {
    let state = bulk_revert_state(cwd)?;
    let token = uuid::Uuid::new_v4().to_string();
    let result = GitWorkspaceRevertAllPreview {
        token: token.clone(),
        restore_paths: state.restore_paths.clone(),
        preserved_paths: state.preserved_paths.clone(),
        head_oid: state.head_oid.clone(),
        branch: state.branch.clone(),
    };
    let mut previews = bulk_revert_previews()
        .lock()
        .map_err(|_| "Revert confirmation is unavailable. Try again.".to_string())?;
    previews.retain(|_, saved| saved.created.elapsed() < REVERT_PREVIEW_TTL);
    if previews.len() >= MAX_BULK_REVERT_PREVIEWS {
        if let Some(oldest) = previews
            .iter()
            .min_by_key(|(_, saved)| saved.created)
            .map(|(token, _)| token.clone())
        {
            previews.remove(&oldest);
        }
    }
    previews.insert(
        token,
        SavedBulkRevertPreview {
            created: Instant::now(),
            state,
        },
    );
    Ok(result)
}

fn revert_all_sync(cwd: &str, expected_token: &str) -> Result<GitWorkspaceCommandResult, String> {
    let saved = bulk_revert_previews()
        .lock()
        .map_err(|_| "Revert confirmation is unavailable. Try again.".to_string())?
        .remove(expected_token)
        .ok_or_else(|| {
            "This revert confirmation expired or was already used. Refresh and confirm again."
                .to_string()
        })?;
    if saved.created.elapsed() >= REVERT_PREVIEW_TTL {
        return Err("The repository or files changed during confirmation. Nothing was reverted; refresh and confirm again.".into());
    }
    let current = bulk_revert_state(cwd).map_err(|error| format!("The repository or files changed during confirmation, or could not be safely rechecked. Nothing was reverted; refresh and confirm again.\n{error}"))?;
    if current != saved.state {
        return Err("The repository or files changed during confirmation. Nothing was reverted; refresh and confirm again.".into());
    }
    let source = format!("--source={}", saved.state.head_oid);
    // Reset only the index first. Added and renamed-destination files become
    // untracked, but their exact working contents are never removed.
    let index = local_git(
        &saved.state.root,
        &["--literal-pathspecs", "restore", &source, "--staged", "--", "."],
    ).map_err(|error| format!("Revert all did not finish resetting the index: {error}\nGit may have changed staging, but this step does not remove working files. Refresh and inspect before trying again."))?;
    if saved.state.restore_paths.is_empty() {
        return Ok(index);
    }
    let mut args = vec![
        "--literal-pathspecs",
        "restore",
        &source,
        "--worktree",
        "--",
    ];
    args.extend(saved.state.restore_paths.iter().map(String::as_str));
    let restored = local_git(&saved.state.root, &args)
        .map_err(|error| format!("Revert all reset the index, but restoring committed working files did not finish: {error}\nSome tracked paths may have changed. Newly added and untracked files were not selected for removal. Refresh and inspect staged and working changes before trying again."))?;
    Ok(GitWorkspaceCommandResult {
        stdout: format!("{}{}", index.stdout, restored.stdout),
        stderr: format!("{}{}", index.stderr, restored.stderr),
    })
}

fn stage_sync(
    cwd: &str,
    path: Option<&str>,
    unstage: bool,
    expected_head: Option<&str>,
    expected_branch: Option<&str>,
) -> Result<GitWorkspaceCommandResult, String> {
    let selected = mutation_repo(cwd)?;
    require_expected_checkout(&selected, expected_head, expected_branch)?;
    if let Some(path) = path {
        if path.is_empty()
            || Path::new(path).components().any(|component| {
                matches!(
                    component,
                    std::path::Component::ParentDir
                        | std::path::Component::RootDir
                        | std::path::Component::Prefix(_)
                )
            })
        {
            return Err("Choose a file inside the Git repository".into());
        }
    }
    let path = path.unwrap_or(".");
    if !unstage {
        return local_git(
            &selected,
            &["--literal-pathspecs", "add", "--all", "--", path],
        );
    }
    if optional_git_stdout(&selected, &["rev-parse", "--verify", "HEAD"]).is_some() {
        let paths = if path == "." {
            vec![path.to_string()]
        } else {
            unstage_paths(&selected, path)?
        };
        let mut args = vec!["--literal-pathspecs", "reset", "--"];
        args.extend(paths.iter().map(String::as_str));
        local_git(&selected, &args)
    } else {
        // --cached only changes the index. -f allows an initially staged file
        // to be unstaged even after its working copy receives further edits.
        local_git(
            &selected,
            &[
                "--literal-pathspecs",
                "rm",
                "-r",
                "--cached",
                "-f",
                "--ignore-unmatch",
                "--",
                path,
            ],
        )
    }
}

fn commit_sync(
    cwd: &str,
    message: &str,
    staged_only: bool,
    expected_head: Option<&str>,
    expected_branch: Option<&str>,
) -> Result<GitWorkspaceCommitResult, String> {
    commit_sync_with_timeout(
        cwd,
        message,
        staged_only,
        expected_head,
        expected_branch,
        LOCAL_TIMEOUT,
    )
}

fn commit_sync_with_timeout(
    cwd: &str,
    message: &str,
    staged_only: bool,
    expected_head: Option<&str>,
    expected_branch: Option<&str>,
    timeout: Duration,
) -> Result<GitWorkspaceCommitResult, String> {
    commit_sync_with_command(
        cwd,
        message,
        staged_only,
        expected_head,
        expected_branch,
        |repo, args| local_git_with_options(repo, args, timeout, MAX_LOCAL_OUTPUT),
    )
}

fn commit_sync_with_command(
    cwd: &str,
    message: &str,
    staged_only: bool,
    expected_head: Option<&str>,
    expected_branch: Option<&str>,
    command: impl FnOnce(&Path, &[&str]) -> Result<GitWorkspaceCommandResult, String>,
) -> Result<GitWorkspaceCommitResult, String> {
    let message = message.trim();
    if message.is_empty() {
        return Err("Enter a commit message".into());
    }
    let selected = mutation_repo(cwd)?;
    require_expected_checkout(&selected, expected_head, expected_branch)?;
    let mut staged = GitWorkspaceCommandResult {
        stdout: String::new(),
        stderr: String::new(),
    };
    if !staged_only {
        staged = local_git(&selected, &["add", "--all"])?;
    }
    // Initialization and branch merging already use this command-local
    // identity for projects without Git identity configuration. Subsequent
    // explicit commits must remain possible without changing global/local config.
    let identity = optional_git_stdout(&selected, &["config", "user.name"])
        .zip(optional_git_stdout(&selected, &["config", "user.email"]));
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
    let before_commit = optional_git_stdout(&selected, &["rev-parse", "--verify", "HEAD"]);
    let before_branch = optional_git_stdout(&selected, &["symbolic-ref", "--short", "-q", "HEAD"]);
    let committed = command(&selected, &args).map_err(|error| {
        let after_commit = optional_git_stdout(&selected, &["rev-parse", "--verify", "HEAD"]);
        if after_commit != before_commit {
            if let Some(head) = after_commit {
                // Git updates HEAD before running post-commit hooks. A timeout
                // can therefore report failure after a commit was saved. An
                // external client could also have changed HEAD, so retain the
                // error and report the observed identity without claiming success.
                return format!("{error}\n\nHEAD is now {head}. A commit may already have been saved. Refresh and inspect it before trying another commit.");
            }
        }
        error
    })?;
    let head_oid = git_stdout(&selected, &["rev-parse", "--verify", "HEAD"], None)?;
    let branch = optional_git_stdout(&selected, &["symbolic-ref", "--short", "-q", "HEAD"]);
    if branch != before_branch {
        // A post-commit hook can switch branches after the commit was saved.
        // Do not hand the new checkout's identity to a follow-up push.
        return Err(format!(
            "The checked-out branch changed from {} to {} while Git was committing. HEAD is now {head_oid}. A commit may already have been saved. Refresh and inspect it before pushing or trying another commit.",
            before_branch.as_deref().unwrap_or("a detached checkout"),
            branch.as_deref().unwrap_or("a detached checkout"),
        ));
    }
    Ok(GitWorkspaceCommitResult {
        head_oid,
        branch,
        stdout: format!("{}{}", staged.stdout, committed.stdout),
        stderr: format!("{}{}", staged.stderr, committed.stderr),
    })
}

fn require_clean(repo: &Path) -> Result<(), String> {
    if !git_stdout(
        repo,
        &["status", "--porcelain=v1", "--untracked-files=all"],
        None,
    )?
    .is_empty()
    {
        return Err("Commit or remove the working changes before changing branches".into());
    }
    Ok(())
}

fn validate_branch(repo: &Path, name: &str) -> Result<(), String> {
    if name.trim() != name || name.is_empty() {
        return Err("Enter a valid branch name".into());
    }
    git_stdout(repo, &["check-ref-format", "--branch", name], None).map(|_| ())
}

fn occupied_elsewhere(repo: &Path, branch: &str) -> Result<bool, String> {
    let current_root = repo.canonicalize().unwrap_or_else(|_| repo.to_path_buf());
    let Some(path) = worktree_branch_paths(repo)?.remove(branch) else {
        return Ok(false);
    };
    let other = PathBuf::from(path).canonicalize().unwrap_or_default();
    Ok(other != current_root)
}

fn branch_sync(
    cwd: &str,
    name: &str,
    create: bool,
    expected_head: &str,
    expected_branch: &str,
) -> Result<GitWorkspaceSnapshot, String> {
    let selected = mutation_repo(cwd)?;
    require_expected(&selected, expected_head, expected_branch)?;
    require_clean(&selected)?;
    validate_branch(&selected, name)?;
    if occupied_elsewhere(&selected, name)? {
        return Err(format!("Branch {name} is checked out in another worktree"));
    }
    if create {
        if optional_git_stdout(
            &selected,
            &["show-ref", "--verify", &format!("refs/heads/{name}")],
        )
        .is_some()
        {
            return Err(format!("Branch {name} already exists"));
        }
        git_stdout(
            &selected,
            &["checkout", "--no-overwrite-ignore", "-b", name],
            None,
        )?;
    } else {
        git_stdout(
            &selected,
            &["show-ref", "--verify", &format!("refs/heads/{name}")],
            None,
        )
        .map_err(|_| format!("Branch {name} does not exist"))?;
        git_stdout(
            &selected,
            &["checkout", "--no-overwrite-ignore", name],
            None,
        )?;
    }
    snapshot_for_selection(&selected, cwd)
}

fn remote_for_repository(
    repo: &Path,
    repository: Option<&str>,
) -> Result<(String, String), String> {
    if repository.is_none() {
        let current = optional_git_stdout(repo, &["symbolic-ref", "--short", "-q", "HEAD"]);
        let configured = current
            .as_deref()
            .and_then(|branch| {
                optional_git_stdout(
                    repo,
                    &["config", "--get", &format!("branch.{branch}.remote")],
                )
            })
            .filter(|value| value != ".")
            .unwrap_or_else(|| "origin".to_string());
        // Read the configured URLs rather than `remote get-url`: the latter
        // expands Git's url.*.insteadOf rules, which can turn a verified
        // GitHub identity into a credential-helper or local transport URL.
        let fetch_url = git_stdout(
            repo,
            &["config", "--get", &format!("remote.{configured}.url")],
            None,
        )?;
        let push_urls = optional_git_stdout(
            repo,
            &[
                "config",
                "--get-all",
                &format!("remote.{configured}.pushurl"),
            ],
        )
        .unwrap_or_else(|| fetch_url.clone());
        let parsed = parse_github_repository(&fetch_url)
            .ok_or_else(|| "The configured Git remote is not a GitHub repository".to_string())?;
        let pushes: Vec<_> = push_urls.lines().filter(|line| !line.is_empty()).collect();
        if pushes.len() != 1
            || parse_github_repository(pushes[0]).as_deref() != Some(parsed.as_str())
        {
            return Err(
                "The configured remote must have exactly one matching GitHub push URL".into(),
            );
        }
        return Ok((configured, parsed));
    }
    let remotes = git_stdout(repo, &["remote"], None)?;
    let mut matches = Vec::new();
    for remote in remotes.lines().filter(|value| !value.is_empty()) {
        let fetch_url = git_stdout(
            repo,
            &["config", "--get", &format!("remote.{remote}.url")],
            None,
        )?;
        let push_urls = optional_git_stdout(
            repo,
            &["config", "--get-all", &format!("remote.{remote}.pushurl")],
        )
        .unwrap_or_else(|| fetch_url.clone());
        let parsed = parse_github_repository(&fetch_url);
        let one_push = push_urls.lines().filter(|line| !line.is_empty()).count() == 1;
        if parsed
            .as_deref()
            .is_some_and(|value| repository.is_none_or(|wanted| value.eq_ignore_ascii_case(wanted)))
            && one_push
            && push_urls
                .lines()
                .next()
                .and_then(parse_github_repository)
                .as_deref()
                == parsed.as_deref()
        {
            matches.push((remote.to_string(), parsed.unwrap()));
        }
    }
    match matches.len() {
        1 => Ok(matches.remove(0)),
        0 => Err("No configured GitHub remote matches this repository".into()),
        _ => Err("More than one Git remote matches this GitHub repository".into()),
    }
}

#[cfg(windows)]
mod windows_git_job {
    use std::{
        io,
        os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle},
        process::Child,
        thread,
        time::{Duration, Instant},
    };
    use windows_sys::Win32::{
        Foundation::INVALID_HANDLE_VALUE,
        System::{
            Diagnostics::ToolHelp::{
                CreateToolhelp32Snapshot, Thread32First, Thread32Next, TH32CS_SNAPTHREAD,
                THREADENTRY32,
            },
            JobObjects::{
                AssignProcessToJobObject, CreateJobObjectW, JobObjectBasicAccountingInformation,
                QueryInformationJobObject, TerminateJobObject,
                JOBOBJECT_BASIC_ACCOUNTING_INFORMATION,
            },
            Threading::{GetProcessIdOfThread, OpenThread, ResumeThread, THREAD_SUSPEND_RESUME},
        },
    };

    // No kill-on-close limit: normal successful hooks may intentionally leave
    // background work running. Only an aborted/timed-out command is terminated.
    pub(super) struct GitJob(OwnedHandle);

    impl GitJob {
        pub(super) fn new() -> io::Result<Self> {
            // SAFETY: unnamed job, default security; returned handle is owned.
            let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
            if handle.is_null() {
                return Err(io::Error::last_os_error());
            }
            // SAFETY: CreateJobObjectW returned a valid uniquely owned handle.
            Ok(Self(unsafe { OwnedHandle::from_raw_handle(handle) }))
        }

        pub(super) fn attach_and_resume(&self, child: &Child) -> io::Result<()> {
            // The caller created Git suspended. It cannot execute a hook or
            // launch descendants until assignment and this resume succeed.
            // Nested jobs are supported on our Windows 10+ target. Failure is
            // reported rather than launching an uncontained fallback process.
            // SAFETY: both process and job handles remain owned and live.
            if unsafe { AssignProcessToJobObject(self.0.as_raw_handle(), child.as_raw_handle()) }
                == 0
            {
                return Err(io::Error::last_os_error());
            }
            let primary = suspended_primary_thread(child.id())?;
            // SAFETY: the handle is our suspended child's sole primary thread.
            let previous_count = unsafe { ResumeThread(primary.as_raw_handle()) };
            if previous_count == u32::MAX {
                return Err(io::Error::last_os_error());
            }
            if previous_count != 1 {
                return Err(io::Error::other(
                    "Git's primary thread had an unexpected suspend count",
                ));
            }
            Ok(())
        }


        pub(super) fn terminate(&self) -> io::Result<()> {
            // The job retains its descendants even if the original Git PID
            // already exited and only an inherited output pipe is still open.
            // SAFETY: the job handle is owned by this command, never app-global.
            if unsafe { TerminateJobObject(self.0.as_raw_handle(), 1) } == 0 {
                return Err(io::Error::last_os_error());
            }
            let deadline = Instant::now() + Duration::from_secs(1);
            loop {
                let mut info = JOBOBJECT_BASIC_ACCOUNTING_INFORMATION::default();
                // SAFETY: info has the exact ABI and size requested by this class.
                if unsafe {
                    QueryInformationJobObject(
                        self.0.as_raw_handle(),
                        JobObjectBasicAccountingInformation,
                        (&mut info as *mut JOBOBJECT_BASIC_ACCOUNTING_INFORMATION).cast(),
                        std::mem::size_of_val(&info) as u32,
                        std::ptr::null_mut(),
                    )
                } == 0
                {
                    return Err(io::Error::last_os_error());
                }
                if info.ActiveProcesses == 0 {
                    return Ok(());
                }
                if Instant::now() >= deadline {
                    return Err(io::Error::new(
                        io::ErrorKind::TimedOut,
                        "Git descendants did not finish terminating",
                    ));
                }
                thread::sleep(Duration::from_millis(10));
            }
        }
    }

    fn suspended_primary_thread(pid: u32) -> io::Result<OwnedHandle> {
        // Stable Rust does not expose Child::main_thread_handle yet. A newly
        // created suspended, no-console process has exactly its primary thread;
        // use the documented ToolHelp API without resuming or inspecting any
        // other process's thread. Refuse an ambiguous snapshot.
        // SAFETY: the snapshot is read-only and its returned handle is owned.
        let raw = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) };
        if raw == INVALID_HANDLE_VALUE {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: snapshot creation returned a valid uniquely owned handle.
        let snapshot = unsafe { OwnedHandle::from_raw_handle(raw) };
        let mut entry = THREADENTRY32 {
            dwSize: std::mem::size_of::<THREADENTRY32>() as u32,
            ..Default::default()
        };
        let mut selected = None;
        // SAFETY: entry is initialized with the required structure size.
        let mut found = unsafe { Thread32First(snapshot.as_raw_handle(), &mut entry) } != 0;
        while found {
            if entry.th32OwnerProcessID == pid && selected.replace(entry.th32ThreadID).is_some() {
                return Err(io::Error::other(
                    "Could not identify Git's sole suspended primary thread",
                ));
            }
            entry.dwSize = std::mem::size_of::<THREADENTRY32>() as u32;
            // SAFETY: snapshot and initialized entry remain valid through iteration.
            found = unsafe { Thread32Next(snapshot.as_raw_handle(), &mut entry) } != 0;
        }
        let id = selected
            .ok_or_else(|| io::Error::other("Git's suspended primary thread was not found"))?;
        // SAFETY: open only the selected thread with minimum resume/query rights.
        let raw = unsafe {
            OpenThread(
                THREAD_SUSPEND_RESUME
                    | windows_sys::Win32::System::Threading::THREAD_QUERY_LIMITED_INFORMATION,
                0,
                id,
            )
        };
        if raw.is_null() {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: OpenThread returned a valid uniquely owned handle.
        let handle = unsafe { OwnedHandle::from_raw_handle(raw) };
        // Confirm thread identity again so a recycled ID is never resumed.
        // SAFETY: handle is owned and has limited query rights.
        if unsafe { GetProcessIdOfThread(handle.as_raw_handle()) } != pid {
            return Err(io::Error::other(
                "Git's suspended primary thread identity changed",
            ));
        }
        Ok(handle)
    }
}

#[cfg(not(windows))]
pub(super) fn stop_git_process(child: &mut std::process::Child) {
    #[cfg(unix)]
    {
        let group = -(child.id() as libc::pid_t);
        // Give Git's signal handler a chance to remove its own index lock,
        // then stop any hook/filter descendants that remain in this group.
        // SAFETY: scope creation set a new process group on this successfully
        // spawned child. Native signals do not execute a PATH-resolved helper.
        unsafe {
            libc::kill(group, libc::SIGTERM);
        }
        let deadline = Instant::now() + Duration::from_millis(250);
        while matches!(child.try_wait(), Ok(None)) && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(10));
        }
        // SAFETY: the same command-owned process group is being stopped.
        unsafe {
            libc::kill(group, libc::SIGKILL);
        }
    }
    let _ = child.kill();
    let _ = child.wait();
}

/// A single Git command's process containment, held until its pipes finish.
/// The interactive ref-transaction worker shares this lifecycle too.
pub(super) struct GitProcessScope {
    #[cfg(windows)]
    job: windows_git_job::GitJob,
}

impl GitProcessScope {
    pub(super) fn stop(&self, child: &mut std::process::Child, reason: String) -> String {
        #[cfg(windows)]
        {
            let cleanup = self.job.terminate();
            let _ = child.kill();
            let _ = child.wait();
            if let Err(error) = cleanup {
                return format!("{reason}. Could not confirm command descendant cleanup: {error}");
            }
        }
        #[cfg(not(windows))]
        stop_git_process(child);
        reason
    }
}

pub(super) fn spawn_scoped_git(
    command: &mut std::process::Command,
) -> Result<(std::process::Child, GitProcessScope), String> {
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    #[cfg(windows)]
    {
        let job = windows_git_job::GitJob::new()
            .map_err(|error| format!("Could not safely start command: {error}"))?;
        spawn_scoped_git_with_job(command, job)
    }
    #[cfg(not(windows))]
    {
        let child = command
            .spawn()
            .map_err(|error| format!("Could not start command: {error}"))?;
        Ok((child, GitProcessScope {}))
    }
}

#[cfg(windows)]
fn spawn_scoped_git_with_job(
    command: &mut std::process::Command,
    job: windows_git_job::GitJob,
) -> Result<(std::process::Child, GitProcessScope), String> {
    use std::os::windows::process::CommandExt;
    use windows_sys::Win32::System::Threading::{CREATE_NO_WINDOW, CREATE_SUSPENDED};
    command.creation_flags(CREATE_NO_WINDOW | CREATE_SUSPENDED);
    let mut child = command
        .spawn()
        .map_err(|error| format!("Could not start command: {error}"))?;
    if let Err(error) = job.attach_and_resume(&child) {
        // The child never launches without containment. Also stop any members
        // already assigned before a thread/resume failure, then reap the child.
        let _ = job.terminate();
        let _ = child.kill();
        let _ = child.wait();
        return Err(format!(
            "Could not safely start command; its suspended process was stopped: {error}"
        ));
    }
    Ok((child, GitProcessScope { job }))
}

pub(super) fn bounded_git_output(
    repo: &Path,
    args: &[&str],
    timeout: Duration,
    output_limit: usize,
    network: bool,
) -> Result<(Output, bool), String> {
    bounded_git_output_with_prompt_policy(repo, args, timeout, output_limit, network, true)
}

pub(super) fn bounded_git_output_with_prompt_policy(
    repo: &Path,
    args: &[&str],
    timeout: Duration,
    output_limit: usize,
    network: bool,
    suppress_askpass: bool,
) -> Result<(Output, bool), String> {
    bounded_git_output_with_readiness(
        repo,
        args,
        timeout,
        output_limit,
        (network, suppress_askpass),
        |_| Ok(()),
    )
}

// Production uses the no-op readiness callback above and its existing absolute
// timeout. Lifecycle tests can establish the exact phase before timing it out.
#[derive(Clone, Copy)]
enum GitPipe {
    Stdout,
    Stderr,
}

type GitPipeResult = (GitPipe, Result<(Vec<u8>, usize), String>);
type GitCompletedOutput = (std::process::ExitStatus, (Vec<u8>, usize), (Vec<u8>, usize));

fn git_completion_wake_enabled() -> bool {
    // Actual paired native measurements found EOF notifications beneficial on
    // macOS but slower for Windows status reads. Retain Windows' bounded poll
    // policy, with the same owned drains, containment and absolute deadline.
    !cfg!(windows)
}

fn bounded_git_output_with_readiness(
    repo: &Path,
    args: &[&str],
    timeout: Duration,
    output_limit: usize,
    prompt_policy: (bool, bool),
    readiness: impl FnOnce(&mut std::process::Child) -> Result<(), String>,
) -> Result<(Output, bool), String> {
    bounded_git_output_with_capture(
        repo,
        args,
        timeout,
        output_limit,
        prompt_policy,
        readiness,
        None,
        false,
    )
}

/// Automatic initialization must discover the actual containing repository,
/// independent of inherited repository-discovery overrides. Keep its English
/// diagnostic stable so only Git's explicit absence result permits mutation.
pub(super) fn bounded_git_initialization_output(
    repo: &Path,
    args: &[&str],
    timeout: Duration,
) -> Result<(Output, bool), String> {
    bounded_git_output_with_capture(
        repo,
        args,
        timeout,
        16 * 1024,
        (true, true),
        |_| Ok(()),
        None,
        true,
    )
}

/// Count records while draining stdout instead of retaining pathname bytes.
/// The same deadline, child ownership and bounded stderr policy still apply.
pub(super) fn bounded_git_nul_path_count(
    repo: &Path,
    args: &[&str],
    timeout: Duration,
    output_limit: usize,
) -> Result<usize, String> {
    let count = Arc::new(AtomicUsize::new(0));
    let (output, truncated) = bounded_git_output_with_capture(
        repo,
        args,
        timeout,
        output_limit,
        (true, true),
        |_| Ok(()),
        Some(count.clone()),
        false,
    )?;
    if truncated {
        return Err(
            "Git read errors exceeded their byte limit; repository state is unknown".into(),
        );
    }
    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if detail.is_empty() {
            "Could not count Git paths".into()
        } else {
            detail
        });
    }
    Ok(count.load(Ordering::Relaxed))
}

fn checked_add_path_count(counted: &AtomicUsize, paths: usize) -> Result<(), String> {
    let mut current = counted.load(Ordering::Relaxed);
    loop {
        let next = current
            .checked_add(paths)
            .ok_or_else(|| "Git returned too many paths to count".to_string())?;
        match counted.compare_exchange_weak(current, next, Ordering::Relaxed, Ordering::Relaxed) {
            Ok(_) => return Ok(()),
            Err(observed) => current = observed,
        }
    }
}

fn bounded_git_output_with_capture(
    repo: &Path,
    args: &[&str],
    timeout: Duration,
    output_limit: usize,
    prompt_policy: (bool, bool),
    readiness: impl FnOnce(&mut std::process::Child) -> Result<(), String>,
    stdout_nul_count: Option<Arc<AtomicUsize>>,
    isolated_initialization: bool,
) -> Result<(Output, bool), String> {
    let (network, suppress_askpass) = prompt_policy;
    let home = env::var_os("HOME").map(PathBuf::from);
    let mut command = git_command_for(repo, env::var_os("PATH").as_deref(), home.as_deref());
    command
        .args(args)
        .current_dir(repo)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if isolated_initialization {
        command
            .env("LC_ALL", "C")
            .env("LANG", "C")
            .env("GIT_DISCOVERY_ACROSS_FILESYSTEM", "1")
            .env_remove("GIT_CEILING_DIRECTORIES")
            .env_remove("GIT_OBJECT_DIRECTORY")
            .env_remove("GIT_ALTERNATE_OBJECT_DIRECTORIES")
            .env_remove("GIT_CONFIG")
            .env_remove("GIT_CONFIG_PARAMETERS")
            .env_remove("GIT_CONFIG_COUNT");
    }
    if network {
        command.env("GIT_TERMINAL_PROMPT", "0");
        command.env("GCM_INTERACTIVE", "Never");
        if suppress_askpass {
            command.env("GIT_ASKPASS", "");
        }
    }
    let (mut child, scope) = spawn_scoped_git(&mut command)?;
    let stop = |child: &mut std::process::Child, reason: String| scope.stop(child, reason);
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Could not read Git output".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Could not read Git errors".to_string())?;
    let (completion_sender, completion_receiver) = mpsc::sync_channel::<GitPipeResult>(2);
    let drain = |mut pipe: Box<dyn Read + Send>, kind| {
        let sender = completion_sender.clone();
        let nul_counter = if matches!(kind, GitPipe::Stdout) {
            stdout_nul_count.clone()
        } else {
            None
        };
        thread::spawn(move || {
            let mut kept = Vec::new();
            let mut total = 0usize;
            let mut path_has_bytes = false;
            let mut chunk = [0u8; 8192];
            let result = loop {
                let count = pipe
                    .read(&mut chunk)
                    .map_err(|error| format!("Could not read Git output: {error}"));
                let count = match count {
                    Ok(count) => count,
                    Err(error) => break Err(error),
                };
                if count == 0 {
                    if nul_counter.is_some() && path_has_bytes {
                        break Err("Git returned an unterminated path list".into());
                    }
                    break Ok((kept, total));
                }
                total = total.saturating_add(count);
                if let Some(counted) = &nul_counter {
                    let mut paths = 0;
                    let mut empty_path = false;
                    for byte in &chunk[..count] {
                        if *byte == 0 {
                            if !path_has_bytes {
                                empty_path = true;
                                break;
                            }
                            paths += 1;
                            path_has_bytes = false;
                        } else {
                            path_has_bytes = true;
                        }
                    }
                    if empty_path {
                        break Err("Git returned an empty path in its path list".into());
                    }
                    if let Err(error) = checked_add_path_count(counted, paths) {
                        break Err(error);
                    }
                } else if kept.len() < output_limit {
                    let retain = count.min(output_limit - kept.len());
                    kept.extend_from_slice(&chunk[..retain]);
                }
            };
            let _ = sender.send((kind, result));
        });
    };
    drain(Box::new(stdout), GitPipe::Stdout);
    drain(Box::new(stderr), GitPipe::Stderr);
    drop(completion_sender);
    readiness(&mut child).map_err(|error| stop(&mut child, error))?;
    let deadline = Instant::now() + timeout;
    let (status, (stdout, stdout_len), (stderr, stderr_len)) =
        wait_for_git_completion(&mut child, completion_receiver, deadline, stop)?;
    let output = Output {
        status,
        stdout,
        stderr,
    };
    Ok((
        output,
        (stdout_nul_count.is_none() && stdout_len > output_limit) || stderr_len > output_limit,
    ))
}

fn wait_for_git_completion(
    child: &mut std::process::Child,
    completed: mpsc::Receiver<GitPipeResult>,
    deadline: Instant,
    stop: impl Fn(&mut std::process::Child, String) -> String,
) -> Result<GitCompletedOutput, String> {
    let mut status = None;
    let mut stdout = None;
    let mut stderr = None;
    let mut next_child_poll = Instant::now();
    let mut child_polls = 0u32;
    loop {
        if status.is_none() {
            status = child
                .try_wait()
                .map_err(|error| stop(child, format!("Could not wait for Git: {error}")))?;
            let checked_at = Instant::now();
            if checked_at >= next_child_poll {
                child_polls = child_polls.saturating_add(1);
            }
            next_child_poll = next_git_child_poll(next_child_poll, checked_at, child_polls);
        }
        if let (Some(status), Some(stdout), Some(stderr)) =
            (status, stdout.as_mut(), stderr.as_mut())
        {
            return Ok((status, std::mem::take(stdout), std::mem::take(stderr)));
        }
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(stop(child, "Git operation timed out".into()));
        }
        let interval = if status.is_none() {
            remaining.min(next_child_poll.saturating_duration_since(Instant::now()))
        } else {
            remaining
        };
        // The old sleep cannot observe a quick Git exit until its full interval
        // elapses. EOF/error notifications wake it, with their bounded results
        // cached below. EOF is NOT process exit: recheck try_wait on every wake,
        // and retain polling when both streams close before the child exits.
        // An early EOF must not postpone that next scheduled poll: on Windows
        // the pipes can close before the process handle becomes signaled.
        if !git_completion_wake_enabled() && status.is_none() {
            thread::sleep(interval);
            continue;
        }
        if stdout.is_some() && stderr.is_some() {
            thread::sleep(interval);
            continue;
        }
        match completed.recv_timeout(interval) {
            Ok((kind, result)) => {
                let result = result.map_err(|error| stop(child, error))?;
                match kind {
                    GitPipe::Stdout => stdout = Some(result),
                    GitPipe::Stderr => stderr = Some(result),
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                return Err(stop(child, "Could not read Git output".into()));
            }
        }
    }
}

/// Most Git reads finish within a few milliseconds of their output closing,
/// so poll for the exit on a short backoff (1, 2, 4, 8, 16 ms) before settling
/// at 25 ms. A fixed 25 ms grid added up to 25 ms to every subprocess.
fn next_git_child_poll(previous: Instant, checked_at: Instant, polls: u32) -> Instant {
    if checked_at >= previous {
        let step = 1u64 << polls.saturating_sub(1).min(5);
        checked_at + Duration::from_millis(step.min(25))
    } else {
        previous
    }
}

fn bounded_git(repo: &Path, args: &[&str]) -> Result<Output, String> {
    let (output, truncated) =
        bounded_git_output(repo, args, NETWORK_TIMEOUT, MAX_NETWORK_OUTPUT, true)?;
    if truncated {
        return Err("Git produced too much network output".into());
    }
    if !output.status.success() {
        let detail = format!(
            "{}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        )
        .trim()
        .to_string();
        return Err(if detail.is_empty() {
            "Git network operation failed".into()
        } else {
            detail
        });
    }
    Ok(output)
}

fn push_destination(
    repo: &Path,
    branch: &str,
    expected_remote_url: &str,
    expected_repository: &str,
) -> Result<(String, String, bool, String), String> {
    let fetch = git_stdout(repo, &["config", "--get-all", "remote.origin.url"], None)
        .map_err(|_| "The GitHub remote no longer exists. Refresh and try again.".to_string())?;
    if fetch != expected_remote_url
        || !parse_github_repository(&fetch)
            .is_some_and(|repository| repository.eq_ignore_ascii_case(expected_repository))
    {
        return Err("The GitHub remote changed since it was shown. Refresh and try again.".into());
    }
    let pushes = optional_git_stdout(repo, &["config", "--get-all", "remote.origin.pushurl"])
        .unwrap_or_else(|| fetch.clone());
    let push_urls: Vec<_> = pushes.lines().filter(|url| !url.is_empty()).collect();
    if push_urls.len() != 1
        || !parse_github_repository(push_urls[0])
            .is_some_and(|repository| repository.eq_ignore_ascii_case(expected_repository))
    {
        return Err("Origin must have exactly one push URL matching this GitHub repository".into());
    }
    let remote = optional_git_stdout(
        repo,
        &["config", "--get-all", &format!("branch.{branch}.remote")],
    );
    let merge = optional_git_stdout(
        repo,
        &["config", "--get-all", &format!("branch.{branch}.merge")],
    );
    let (target, needs_upstream) = match (remote.as_deref(), merge.as_deref()) {
        (None, None) => (branch.to_string(), true),
        (Some("origin"), Some(reference)) => (
            reference
                .strip_prefix("refs/heads/")
                .ok_or_else(|| "This branch does not track a branch on origin".to_string())?
                .to_string(),
            false,
        ),
        _ => {
            return Err(
                "This branch's upstream must point to origin before pushing from the Git tab"
                    .into(),
            )
        }
    };
    git_stdout(
        repo,
        &["check-ref-format", &format!("refs/heads/{target}")],
        None,
    )
    .map_err(|_| "The upstream branch name is invalid".to_string())?;
    // Resolve Git's actual fetch mapping, including on a first push whose
    // upstream is not configured yet. These overrides are read-only: they
    // describe the binding we will record only after the push succeeds.
    let tracking = git_stdout(
        repo,
        &[
            "-c",
            &format!("branch.{branch}.remote=origin"),
            "-c",
            &format!("branch.{branch}.merge=refs/heads/{target}"),
            "for-each-ref",
            "--format=%(upstream)",
            &format!("refs/heads/{branch}"),
        ],
        None,
    )?;
    if tracking.is_empty() {
        return Err("This branch has no local origin fetch mapping. Configure its mapping and refresh before pushing from the Git tab.".into());
    }
    git_stdout(repo, &["check-ref-format", &tracking], None)
        .map_err(|_| "The origin fetch mapping is invalid".to_string())?;
    if !tracking.starts_with("refs/")
        || tracking.starts_with("refs/heads/")
        || tracking.starts_with("refs/tags/")
    {
        return Err("The origin fetch mapping targets a local branch or tag. Inspect the mapping before pushing from the Git tab.".into());
    }
    Ok((push_urls[0].to_string(), target, needs_upstream, tracking))
}

fn push_sync(
    cwd: &str,
    head_oid: &str,
    branch: &str,
    expected_remote_url: &str,
    expected_repository: &str,
) -> Result<GitWorkspaceCommandResult, String> {
    if !matches!(head_oid.len(), 40 | 64) || !head_oid.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Err("The commit identity is invalid. Refresh and try again.".into());
    }
    let selected = mutation_repo(cwd)?;
    validate_branch(&selected, branch)?;
    require_expected(&selected, head_oid, branch)?;
    let (url, target, needs_upstream, tracking_ref) =
        push_destination(&selected, branch, expected_remote_url, expected_repository)?;
    if optional_git_stdout(&selected, &["symbolic-ref", "--quiet", &tracking_ref]).is_some() {
        return Err("This remote tracking ref is symbolic. Inspect its mapping before pushing from the Git tab.".into());
    }
    let tracking_old = optional_git_stdout(&selected, &["rev-parse", "--verify", &tracking_ref]);
    let refspec = format!("{head_oid}:refs/heads/{target}");
    let output = bounded_git(
        &selected,
        &[
            "push",
            "--porcelain",
            "--no-follow-tags",
            "--",
            &url,
            &refspec,
        ],
    )?;
    // The URL and upstream may be edited by another Git client while the
    // network request runs. Do not apply tracking metadata to a new binding.
    let current = push_destination(&selected, branch, expected_remote_url, expected_repository)
        .map_err(|error| {
            format!("The commit was pushed, but its local tracking could not be recorded: {error}")
        })?;
    if current != (url, target.clone(), needs_upstream, tracking_ref.clone()) {
        return Err("The commit was pushed, but its upstream changed during the push. Refresh before pushing again.".into());
    }
    let record = (|| {
        if optional_git_stdout(&selected, &["symbolic-ref", "--quiet", &tracking_ref]).is_some() {
            return Err("The remote tracking ref became symbolic during the push. It was not rewritten; refresh and inspect it.".into());
        }
        git_stdout(
            &selected,
            &[
                "update-ref",
                "--no-deref",
                &tracking_ref,
                head_oid,
                tracking_old
                    .as_deref()
                    .unwrap_or(&"0".repeat(head_oid.len())),
            ],
            None,
        )?;
        if needs_upstream {
            git_stdout(
                &selected,
                &[
                    "config",
                    "--local",
                    &format!("branch.{branch}.remote"),
                    "origin",
                ],
                None,
            )?;
            git_stdout(
                &selected,
                &[
                    "config",
                    "--local",
                    &format!("branch.{branch}.merge"),
                    &format!("refs/heads/{target}"),
                ],
                None,
            )?;
        }
        Ok::<_, String>(())
    })();
    record.map_err(|error| {
        format!("The commit was pushed, but its local tracking could not be recorded: {error}")
    })?;
    Ok(GitWorkspaceCommandResult {
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
    })
}

fn fetch_sync(cwd: &str) -> Result<GitWorkspaceSnapshot, String> {
    let selected = mutation_repo(cwd)?;
    let (remote, _) = remote_for_repository(&selected, None)?;
    bounded_git(&selected, &["fetch", "--prune", "--no-tags", &remote])?;
    snapshot_for_selection(&selected, cwd)
}

fn pull_destination(
    repo: &Path,
    branch: &str,
    expected_remote_url: &str,
    expected_repository: &str,
) -> Result<(String, String), String> {
    validate_branch(repo, branch)?;
    let fetch = git_stdout(repo, &["config", "--get-all", "remote.origin.url"], None)
        .map_err(|_| "The GitHub remote no longer exists. Refresh and try again.".to_string())?;
    if fetch != expected_remote_url
        || !parse_github_repository(&fetch)
            .is_some_and(|repository| repository.eq_ignore_ascii_case(expected_repository))
    {
        return Err("The GitHub remote changed since it was shown. Refresh and try again.".into());
    }
    let remote = optional_git_stdout(
        repo,
        &["config", "--get-all", &format!("branch.{branch}.remote")],
    );
    let merge = optional_git_stdout(
        repo,
        &["config", "--get-all", &format!("branch.{branch}.merge")],
    );
    let target = match (remote.as_deref(), merge.as_deref()) {
        (None, None) => return Err("This branch has no origin upstream to pull. Configure its upstream, then refresh the Git tab.".into()),
        (Some("origin"), Some(reference)) => reference.strip_prefix("refs/heads/").ok_or("This branch does not track a branch on origin")?,
        _ => return Err("This branch's upstream must point to origin before pulling from the Git tab.".into()),
    };
    git_stdout(
        repo,
        &["check-ref-format", &format!("refs/heads/{target}")],
        None,
    )
    .map_err(|_| "The upstream branch name is invalid".to_string())?;
    let tracking = git_stdout(
        repo,
        &[
            "for-each-ref",
            "--format=%(upstream)",
            &format!("refs/heads/{branch}"),
        ],
        None,
    )?;
    if tracking.is_empty() {
        return Err("This upstream has no local fetch mapping. Configure its mapping and refresh before pulling from the Git tab.".into());
    }
    git_stdout(repo, &["check-ref-format", &tracking], None)
        .map_err(|_| "The upstream fetch mapping is invalid".to_string())?;
    if tracking.starts_with("refs/heads/") {
        return Err("The upstream fetch mapping targets a local branch. Inspect the mapping before pulling from the Git tab.".into());
    }
    if optional_git_stdout(repo, &["symbolic-ref", "--quiet", &tracking]).is_some() {
        return Err("The upstream tracking ref is symbolic. Inspect the mapping before pulling from the Git tab.".into());
    }
    Ok((target.to_owned(), tracking))
}

fn pull_sync(
    cwd: &str,
    expected_head: &str,
    expected_branch: &str,
    expected_remote_url: &str,
    expected_repository: &str,
) -> Result<GitWorkspaceCommandResult, String> {
    let selected = mutation_repo(cwd)?;
    require_expected(&selected, expected_head, expected_branch)?;
    require_clean(&selected)?;
    let destination = pull_destination(
        &selected,
        expected_branch,
        expected_remote_url,
        expected_repository,
    )?;
    let fetched_ref = format!("refs/openkiwi/fetched-pull/{}", uuid::Uuid::new_v4());
    let refspec = format!("refs/heads/{}:{fetched_ref}", destination.0);
    let tracking_old = optional_git_stdout(&selected, &["rev-parse", "--verify", &destination.1]);
    let result = (|| {
        bounded_git(
            &selected,
            &[
                "fetch",
                "--no-tags",
                "--no-write-fetch-head",
                "--",
                expected_remote_url,
                &refspec,
            ],
        )?;
        let fetched_oid = git_stdout(
            &selected,
            &[
                "rev-parse",
                "--verify",
                &format!("{fetched_ref}^{{commit}}"),
            ],
            None,
        )?;
        // The fetch can outlive the visible checkout or its remote settings.
        // Merge only the reviewed branch's exact upstream object, never FETCH_HEAD.
        require_expected(&selected, expected_head, expected_branch)?;
        require_clean(&selected)?;
        if pull_destination(
            &selected,
            expected_branch,
            expected_remote_url,
            expected_repository,
        )? != destination
        {
            return Err("This branch's upstream changed while fetching. Nothing was pulled into the checkout; refresh and inspect its upstream.".into());
        }
        // Preserve normal fetch semantics for status and ahead/behind counts,
        // including custom mappings. A concurrent fetch wins its own ref update;
        // never overwrite it or follow a symbolic name into another branch.
        local_git(&selected, &["update-ref", "--no-deref", &destination.1, &fetched_oid, tracking_old.as_deref().unwrap_or(&"0".repeat(fetched_oid.len()))])
            .map_err(|error| format!("The upstream was fetched, but its local tracking ref changed or could not be recorded. Nothing was merged; refresh and inspect it before retrying. {error}"))?;
        require_expected(&selected, expected_head, expected_branch)?;
        require_clean(&selected)?;
        let merged = local_git(
            &selected,
            &["merge", "--ff-only", "--no-overwrite-ignore", &fetched_oid],
        )?;
        if optional_git_stdout(&selected, &["symbolic-ref", "--short", "-q", "HEAD"]).as_deref()
            != Some(expected_branch)
        {
            return Err("The selected branch changed while pulling. Its update may already have been saved; refresh and inspect the checkout before trying again.".into());
        }
        Ok(merged)
    })();
    // Fetch may update the temporary ref before a later phase reports failure.
    // Its unique name and exact old value keep cleanup away from user refs.
    if let Some(oid) = optional_git_stdout(&selected, &["rev-parse", "--verify", &fetched_ref]) {
        let cleanup = local_git(
            &selected,
            &["update-ref", "--no-deref", "-d", &fetched_ref, &oid],
        );
        if let Err(error) = cleanup {
            return Err(format!("{}\nThe temporary fetched ref could not be cleaned up: {error}. Refresh and inspect the checkout before retrying.", result.as_ref().err().map(String::as_str).unwrap_or("The branch update completed.")));
        }
    }
    result
}

fn update_sync(
    cwd: &str,
    repository: &str,
    base: &str,
    expected_head: &str,
    expected_branch: &str,
) -> Result<GitWorkspaceSnapshot, String> {
    let selected = mutation_repo(cwd)?;
    require_expected(&selected, expected_head, expected_branch)?;
    require_clean(&selected)?;
    validate_branch(&selected, base)?;
    let (remote, _) = remote_for_repository(&selected, Some(repository))?;
    let fetched_ref = format!("refs/openkiwi/fetched/{base}");
    let source = format!("refs/heads/{base}:{fetched_ref}");
    bounded_git(&selected, &["fetch", "--no-tags", &remote, &source])?;
    // Fetch may have taken time; verify the user's source branch and commit again
    // before changing checkout state.
    require_expected(&selected, expected_head, expected_branch)?;
    require_clean(&selected)?;
    let fetched_oid = git_stdout(&selected, &["rev-parse", "--verify", &fetched_ref], None)?;
    if occupied_elsewhere(&selected, base)? {
        return Err(format!("Branch {base} is checked out in another worktree"));
    }
    let local_ref = format!("refs/heads/{base}");
    let local_oid = optional_git_stdout(&selected, &["rev-parse", "--verify", &local_ref]);
    if let Some(local) = &local_oid {
        git_stdout(
            &selected,
            &["merge-base", "--is-ancestor", local, &fetched_oid],
            None,
        )
        .map_err(|_| {
            format!("Local branch {base} has diverged from {repository}; update it manually")
        })?;
    }
    let switched = expected_branch != base;
    let checkout = if local_oid.is_some() {
        local_git(&selected, &["checkout", "--no-overwrite-ignore", base])
    } else {
        local_git(
            &selected,
            &[
                "checkout",
                "--no-overwrite-ignore",
                "-b",
                base,
                &fetched_oid,
            ],
        )
    };
    if let Err(error) = checkout {
        // Checkout hooks can fail after Git has already changed HEAD. Restore
        // the caller's branch even when the checkout command reports failure.
        if switched {
            let _ = local_git(
                &selected,
                &["checkout", "--no-overwrite-ignore", expected_branch],
            );
        }
        return Err(error);
    }
    // A successful post-checkout hook may itself switch branches. Never merge
    // into whichever branch the hook left selected instead of the requested one.
    if optional_git_stdout(&selected, &["symbolic-ref", "--short", "-q", "HEAD"]).as_deref()
        != Some(base)
    {
        return Err(format!("The checkout hook or another Git client changed the selected branch. Branch {base} was not updated. Refresh and inspect the checkout before trying again."));
    }
    require_clean(&selected)?;
    if local_oid.as_deref() != Some(fetched_oid.as_str()) {
        if let Err(error) = local_git(
            &selected,
            &["merge", "--no-overwrite-ignore", "--ff-only", &fetched_oid],
        ) {
            if switched {
                let _ = local_git(
                    &selected,
                    &["checkout", "--no-overwrite-ignore", expected_branch],
                );
            }
            return Err(error);
        }
    }
    if optional_git_stdout(&selected, &["symbolic-ref", "--short", "-q", "HEAD"]).as_deref()
        != Some(base)
    {
        return Err("The selected branch changed while updating. The update may already have been saved; refresh and inspect the checkout before trying again.".into());
    }
    snapshot_for_selection(&selected, cwd)
}

#[tauri::command]
pub(super) async fn git_workspace_revert_preview(
    cwd: String,
    path: String,
) -> Result<GitWorkspaceRevertPreview, String> {
    let lock = repository_lock(Path::new(&cwd)).await?;
    let guard = lock.lock_owned().await;
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = guard;
        revert_preview_sync(&cwd, &path)
    })
    .await
    .map_err(|error| format!("Git revert preview failed: {error}"))?
}

#[tauri::command]
pub(super) async fn git_workspace_revert(
    cwd: String,
    path: String,
    expected_token: String,
) -> Result<GitWorkspaceCommandResult, String> {
    let lock = repository_lock(Path::new(&cwd)).await?;
    let guard = lock.lock_owned().await;
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = guard;
        revert_sync(&cwd, &path, &expected_token)
    })
    .await
    .map_err(|error| format!("Git revert task failed: {error}"))?
}

#[tauri::command]
pub(super) async fn git_workspace_revert_all_preview(
    cwd: String,
) -> Result<GitWorkspaceRevertAllPreview, String> {
    let lock = repository_lock(Path::new(&cwd)).await?;
    let guard = lock.lock_owned().await;
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = guard;
        revert_all_preview_sync(&cwd)
    })
    .await
    .map_err(|error| format!("Git bulk revert preview failed: {error}"))?
}

#[tauri::command]
pub(super) async fn git_workspace_revert_all(
    cwd: String,
    expected_token: String,
) -> Result<GitWorkspaceCommandResult, String> {
    let lock = repository_lock(Path::new(&cwd)).await?;
    let guard = lock.lock_owned().await;
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = guard;
        revert_all_sync(&cwd, &expected_token)
    })
    .await
    .map_err(|error| format!("Git bulk revert task failed: {error}"))?
}

#[tauri::command]
pub(super) async fn git_workspace_snapshot(cwd: String) -> Result<GitWorkspaceSnapshot, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let read = GitReadOperation::new();
        repo_with_read(&cwd, &read)
            .and_then(|path| snapshot_for_selection_with_read(&path, &cwd, &read))
    })
    .await
    .map_err(|error| format!("Git workspace inspection failed: {error}"))?
}

#[tauri::command]
pub(super) async fn git_workspace_stage(
    cwd: String,
    path: Option<String>,
    unstage: bool,
    expected_head_oid: Option<String>,
    expected_branch: Option<String>,
) -> Result<GitWorkspaceCommandResult, String> {
    let lock = repository_lock(Path::new(&cwd)).await?;
    let guard = lock.lock_owned().await;
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = guard;
        stage_sync(
            &cwd,
            path.as_deref(),
            unstage,
            expected_head_oid.as_deref(),
            expected_branch.as_deref(),
        )
    })
    .await
    .map_err(|error| format!("Git staging task failed: {error}"))?
}

#[tauri::command]
pub(super) async fn git_workspace_commit(
    cwd: String,
    message: String,
    staged_only: bool,
    expected_head_oid: Option<String>,
    expected_branch: Option<String>,
) -> Result<GitWorkspaceCommitResult, String> {
    let lock = repository_lock(Path::new(&cwd)).await?;
    let guard = lock.lock_owned().await;
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = guard;
        commit_sync(
            &cwd,
            &message,
            staged_only,
            expected_head_oid.as_deref(),
            expected_branch.as_deref(),
        )
    })
    .await
    .map_err(|error| format!("Git commit task failed: {error}"))?
}

#[tauri::command]
pub(super) async fn git_workspace_push(
    cwd: String,
    head_oid: String,
    branch: String,
    expected_remote_url: String,
    expected_repository: String,
) -> Result<GitWorkspaceCommandResult, String> {
    let lock = repository_lock(Path::new(&cwd)).await?;
    let guard = lock.lock_owned().await;
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = guard;
        push_sync(
            &cwd,
            &head_oid,
            &branch,
            &expected_remote_url,
            &expected_repository,
        )
    })
    .await
    .map_err(|error| format!("Git push task failed: {error}"))?
}

#[tauri::command]
pub(super) async fn git_workspace_branch(
    cwd: String,
    name: String,
    create: bool,
    expected_head_oid: String,
    expected_branch: String,
) -> Result<GitWorkspaceSnapshot, String> {
    let lock = repository_lock(Path::new(&cwd)).await?;
    let guard = lock.lock_owned().await;
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = guard;
        branch_sync(&cwd, &name, create, &expected_head_oid, &expected_branch)
    })
    .await
    .map_err(|error| format!("Git branch task failed: {error}"))?
}

#[tauri::command]
pub(super) async fn git_workspace_fetch(cwd: String) -> Result<GitWorkspaceSnapshot, String> {
    let lock = repository_lock(Path::new(&cwd)).await?;
    let guard = lock.lock_owned().await;
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = guard;
        fetch_sync(&cwd)
    })
    .await
    .map_err(|error| format!("Git fetch task failed: {error}"))?
}

#[tauri::command]
pub(super) async fn git_workspace_pull(
    cwd: String,
    expected_head_oid: String,
    expected_branch: String,
    expected_remote_url: String,
    expected_repository: String,
) -> Result<GitWorkspaceCommandResult, String> {
    let lock = repository_lock(Path::new(&cwd)).await?;
    let guard = lock.lock_owned().await;
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = guard;
        pull_sync(
            &cwd,
            &expected_head_oid,
            &expected_branch,
            &expected_remote_url,
            &expected_repository,
        )
    })
    .await
    .map_err(|error| format!("Git pull task failed: {error}"))?
}

#[tauri::command]
pub(super) async fn git_workspace_update(
    cwd: String,
    repository: String,
    base: String,
    expected_head_oid: String,
    expected_branch: String,
) -> Result<GitWorkspaceSnapshot, String> {
    let lock = repository_lock(Path::new(&cwd)).await?;
    let guard = lock.lock_owned().await;
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = guard;
        update_sync(
            &cwd,
            &repository,
            &base,
            &expected_head_oid,
            &expected_branch,
        )
    })
    .await
    .map_err(|error| format!("Git update task failed: {error}"))?
}
