use std::{
    collections::{HashMap, HashSet},
    env,
    io::Read,
    path::{Path, PathBuf},
    process::{Output, Stdio},
    sync::{mpsc, Arc, Mutex as StdMutex, OnceLock, Weak},
    thread,
    time::{Duration, Instant},
};

use serde::Serialize;
use tokio::sync::Mutex;

use crate::{
    github::parse_github_repository,
    project_git::{git_command_for, git_common_dir, git_stdout, optional_git_stdout, run_git},
};

const NETWORK_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_NETWORK_OUTPUT: usize = 64 * 1024;
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
    branches: Vec<GitWorkspaceBranch>,
    staged_files: usize,
    unstaged_files: usize,
    changed_files: usize,
    staged_paths: Vec<String>,
    root_path: String,
    is_root: bool,
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
    let selected = PathBuf::from(cwd)
        .canonicalize()
        .map_err(|error| format!("Could not open the project folder: {error}"))?;
    let root = git_stdout(&selected, &["rev-parse", "--show-toplevel"], None)
        .map_err(|_| "This folder is not inside a Git repository".to_string())?;
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

fn worktree_records(repo: &Path) -> Result<Vec<(String, Option<String>)>, String> {
    let output = run_git(repo, &["worktree", "list", "--porcelain", "-z"], None)?;
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

pub(super) fn worktree_paths(repo: &Path) -> Result<Vec<String>, String> {
    Ok(worktree_records(repo)?
        .into_iter()
        .map(|(path, _)| path)
        .collect())
}

pub(super) fn worktree_branch_paths(repo: &Path) -> Result<HashMap<String, String>, String> {
    Ok(worktree_records(repo)?
        .into_iter()
        .filter_map(|(path, branch)| branch.map(|branch| (branch, path)))
        .collect())
}

fn snapshot(repo: &Path) -> Result<GitWorkspaceSnapshot, String> {
    let branch = optional_git_stdout(repo, &["symbolic-ref", "--short", "-q", "HEAD"]);
    let head_oid = optional_git_stdout(repo, &["rev-parse", "--verify", "HEAD"]);
    let occupied = worktree_branch_paths(repo)?;
    let refs = git_stdout(
        repo,
        &["for-each-ref", "--format=%(refname:strip=2)", "refs/heads"],
        None,
    )?;
    let mut branches: Vec<_> = refs
        .lines()
        .filter(|name| !name.is_empty())
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
    let status = run_git(
        repo,
        &["status", "--porcelain=v1", "-z", "--untracked-files=all"],
        None,
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
        let name = String::from_utf8_lossy(&entry[3..]).into_owned();
        changed.insert(name.clone());
        if x != ' ' && x != '?' {
            staged_paths.push(name.clone());
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
    Ok(GitWorkspaceSnapshot {
        branch,
        head_oid,
        branches,
        staged_files: staged_paths.len(),
        unstaged_files: unstaged.len(),
        changed_files: changed.len(),
        staged_paths,
        root_path: repo.to_string_lossy().into_owned(),
        is_root: true,
    })
}

fn snapshot_for_selection(root: &Path, cwd: &str) -> Result<GitWorkspaceSnapshot, String> {
    let selected = Path::new(cwd)
        .canonicalize()
        .map_err(|error| format!("Could not open the project folder: {error}"))?;
    let mut value = snapshot(root)?;
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
    let committed = local_git_with_options(&selected, &args, timeout, MAX_LOCAL_OUTPUT).map_err(|error| {
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

        #[cfg(test)]
        pub(super) fn occupy_single_process_limit_for_test(&self, child: &Child) -> io::Result<()> {
            use windows_sys::Win32::System::JobObjects::{
                JobObjectExtendedLimitInformation, SetInformationJobObject,
                JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_ACTIVE_PROCESS,
            };
            let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_ACTIVE_PROCESS;
            info.BasicLimitInformation.ActiveProcessLimit = 1;
            // SAFETY: correctly sized test-only job policy and owned handles.
            if unsafe {
                SetInformationJobObject(
                    self.0.as_raw_handle(),
                    JobObjectExtendedLimitInformation,
                    (&info as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                    std::mem::size_of_val(&info) as u32,
                )
            } == 0
            {
                return Err(io::Error::last_os_error());
            }
            // SAFETY: occupy this test-owned job with the still-suspended dummy.
            if unsafe { AssignProcessToJobObject(self.0.as_raw_handle(), child.as_raw_handle()) }
                == 0
            {
                return Err(io::Error::last_os_error());
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
    let home = env::var_os("HOME").map(PathBuf::from);
    let mut command = git_command_for(repo, env::var_os("PATH").as_deref(), home.as_deref());
    command
        .args(args)
        .current_dir(repo)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
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
    let drain = |mut pipe: Box<dyn Read + Send>| {
        let (sender, receiver) = mpsc::sync_channel(1);
        thread::spawn(move || {
            let mut kept = Vec::new();
            let mut total = 0usize;
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
                    break Ok((kept, total));
                }
                total = total.saturating_add(count);
                if kept.len() < output_limit {
                    let retain = count.min(output_limit - kept.len());
                    kept.extend_from_slice(&chunk[..retain]);
                }
            };
            let _ = sender.send(result);
        });
        receiver
    };
    let stdout_reader = drain(Box::new(stdout));
    let stderr_reader = drain(Box::new(stderr));
    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(25)),
            Ok(None) => {
                return Err(stop(&mut child, "Git operation timed out".into()));
            }
            Err(error) => {
                return Err(stop(&mut child, format!("Could not wait for Git: {error}")));
            }
        }
    };
    let remaining = || deadline.saturating_duration_since(Instant::now());
    let (stdout, stdout_len) = stdout_reader
        .recv_timeout(remaining())
        .map_err(|_| stop(&mut child, "Git operation timed out".to_string()))?
        .map_err(|error| stop(&mut child, error))?;
    let (stderr, stderr_len) = stderr_reader
        .recv_timeout(remaining())
        .map_err(|_| stop(&mut child, "Git operation timed out".to_string()))?
        .map_err(|error| stop(&mut child, error))?;
    let output = Output {
        status,
        stdout,
        stderr,
    };
    Ok((
        output,
        stdout_len > output_limit || stderr_len > output_limit,
    ))
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
) -> Result<(String, String, bool), String> {
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
    Ok((push_urls[0].to_string(), target, needs_upstream))
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
    let (url, target, needs_upstream) =
        push_destination(&selected, branch, expected_remote_url, expected_repository)?;
    let tracking_ref = format!("refs/remotes/origin/{target}");
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
    if current != (url, target.clone(), needs_upstream) {
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
        repo(&cwd).and_then(|path| snapshot_for_selection(&path, &cwd))
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs,
        sync::atomic::{AtomicUsize, Ordering},
    };

    struct RemoteFixture {
        root: PathBuf,
        seed: PathBuf,
        client: PathBuf,
        bare: PathBuf,
    }

    fn fixture() -> PathBuf {
        static NEXT: AtomicUsize = AtomicUsize::new(0);
        let path = env::temp_dir().join(format!(
            "mythra-git-workspace-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&path).unwrap();
        git_stdout(&path, &["init"], None).unwrap();
        fs::write(path.join("file.txt"), "one\n").unwrap();
        git_stdout(&path, &["add", "."], None).unwrap();
        git_stdout(
            &path,
            &[
                "-c",
                "user.name=Test",
                "-c",
                "user.email=test@example.com",
                "commit",
                "-m",
                "initial",
            ],
            None,
        )
        .unwrap();
        path
    }

    fn enable_test_hook(path: &Path) {
        let _ = path;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(path, fs::Permissions::from_mode(0o755)).unwrap();
        }
    }

    fn assert_restored_from_head(repo: &Path, path: &str) {
        // Checkout honors core.autocrlf and attributes. Compare the restored
        // working file's cleaned object, not a platform-specific newline style.
        let oid = git_stdout(
            repo,
            &["hash-object", &format!("--path={path}"), "--", path],
            None,
        )
        .unwrap();
        assert_eq!(
            oid,
            git_stdout(repo, &["rev-parse", &format!("HEAD:{path}")], None).unwrap()
        );
    }

    #[cfg(windows)]
    #[test]
    fn windows_job_assignment_failure_stops_suspended_git_without_running_it() {
        use std::os::windows::process::CommandExt;
        use windows_sys::Win32::System::Threading::{CREATE_NO_WINDOW, CREATE_SUSPENDED};
        let path = fixture();
        let job = windows_git_job::GitJob::new().unwrap();
        let mut dummy = crate::process_launch::background_std_command("cmd.exe")
            .args(["/c", "exit", "0"])
            .creation_flags(CREATE_NO_WINDOW | CREATE_SUSPENDED)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        job.occupy_single_process_limit_for_test(&dummy).unwrap();
        let mut command = git_command_for(&path, env::var_os("PATH").as_deref(), None);
        command
            .args(["config", "--local", "test.must-not-run", "true"])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let error = spawn_scoped_git_with_job(&mut command, job)
            .err()
            .expect("an occupied one-process job must reject a second process");
        assert!(error.contains("suspended process was stopped"), "{error}");
        assert!(
            !dummy.wait().unwrap().success(),
            "the test's suspended dummy was not cleaned up"
        );
        assert!(
            optional_git_stdout(&path, &["config", "--get", "test.must-not-run"]).is_none(),
            "uncontained Git was resumed despite assignment failure"
        );
        fs::remove_dir_all(path).unwrap();
    }

    #[test]
    fn revert_staged_rename_restores_source_and_preserves_destination_without_touching_other_changes(
    ) {
        let path = fixture();
        fs::write(path.join("other.txt"), "other\n").unwrap();
        git_stdout(&path, &["add", "other.txt"], None).unwrap();
        git_stdout(&path, &["mv", "file.txt", "renamed.txt"], None).unwrap();
        fs::write(path.join("renamed.txt"), "edited rename\n").unwrap();
        let preview = revert_preview_sync(path.to_str().unwrap(), "renamed.txt").unwrap();
        assert_eq!(preview.paths, ["file.txt", "renamed.txt"]);
        assert_eq!(preview.restore_paths, ["file.txt"]);
        assert_eq!(preview.preserved_paths, ["renamed.txt"]);
        assert!(revert_preview_sync(path.to_str().unwrap(), "./renamed.txt").is_err());
        assert!(revert_preview_sync(path.to_str().unwrap(), "renamed.txt/").is_err());
        revert_sync(path.to_str().unwrap(), "renamed.txt", &preview.token).unwrap();
        assert_restored_from_head(&path, "file.txt");
        assert_eq!(
            fs::read(path.join("renamed.txt")).unwrap(),
            b"edited rename\n"
        );
        assert_eq!(
            git_stdout(&path, &["diff", "--cached", "--name-only"], None).unwrap(),
            "other.txt"
        );
        assert_eq!(
            fs::read_to_string(path.join("other.txt")).unwrap(),
            "other\n"
        );
        fs::remove_dir_all(path).unwrap();
    }

    #[test]
    fn revert_confirmation_rejects_working_edits_index_changes_and_changed_checkout() {
        for change in ["working", "index", "head", "branch"] {
            let path = fixture();
            fs::write(path.join("file.txt"), "selected contents\n").unwrap();
            git_stdout(&path, &["add", "file.txt"], None).unwrap();
            let preview = revert_preview_sync(path.to_str().unwrap(), "file.txt").unwrap();
            match change {
                "working" => fs::write(path.join("file.txt"), "new edit\n").unwrap(),
                "index" => {
                    git_stdout(&path, &["reset", "--", "file.txt"], None).unwrap();
                }
                "head" => {
                    git_stdout(
                        &path,
                        &[
                            "-c",
                            "user.name=Test",
                            "-c",
                            "user.email=test@example.com",
                            "commit",
                            "-m",
                            "other commit",
                        ],
                        None,
                    )
                    .unwrap();
                }
                "branch" => {
                    git_stdout(&path, &["checkout", "-b", "other"], None).unwrap();
                }
                _ => unreachable!(),
            }
            let contents = fs::read(path.join("file.txt")).unwrap();
            let before = git_stdout(&path, &["diff", "--cached"], None).unwrap();
            assert!(
                revert_sync(path.to_str().unwrap(), "file.txt", &preview.token).is_err(),
                "accepted stale {change}"
            );
            assert_eq!(fs::read(path.join("file.txt")).unwrap(), contents);
            assert_eq!(
                git_stdout(&path, &["diff", "--cached"], None).unwrap(),
                before
            );
            assert!(
                revert_sync(path.to_str().unwrap(), "file.txt", &preview.token)
                    .unwrap_err()
                    .contains("already used")
            );
            fs::remove_dir_all(path).unwrap();
        }
    }

    #[test]
    fn revert_rename_rejects_recreated_source_and_changed_destination() {
        let path = fixture();
        git_stdout(&path, &["mv", "file.txt", "renamed.txt"], None).unwrap();
        let preview = revert_preview_sync(path.to_str().unwrap(), "renamed.txt").unwrap();
        fs::write(path.join("renamed.txt"), "new rename edit\n").unwrap();
        assert!(revert_sync(path.to_str().unwrap(), "renamed.txt", &preview.token).is_err());
        fs::write(path.join("file.txt"), "valuable untracked source\n").unwrap();
        assert!(revert_preview_sync(path.to_str().unwrap(), "renamed.txt")
            .unwrap_err()
            .contains("recreated"));
        assert_eq!(
            fs::read_to_string(path.join("file.txt")).unwrap(),
            "valuable untracked source\n"
        );
        assert_eq!(
            fs::read_to_string(path.join("renamed.txt")).unwrap(),
            "new rename edit\n"
        );
        fs::remove_dir_all(path).unwrap();
    }

    #[test]
    fn revert_staged_deletion_preserves_recreated_untracked_file() {
        let path = fixture();
        git_stdout(&path, &["rm", "file.txt"], None).unwrap();
        fs::write(path.join("file.txt"), "valuable untracked replacement\n").unwrap();
        let before = git_stdout(&path, &["diff", "--cached"], None).unwrap();

        let error = revert_preview_sync(path.to_str().unwrap(), "file.txt").unwrap_err();
        assert!(error.contains("recreated"), "{error}");
        assert_eq!(
            fs::read(path.join("file.txt")).unwrap(),
            b"valuable untracked replacement\n"
        );
        assert_eq!(
            git_stdout(&path, &["diff", "--cached"], None).unwrap(),
            before
        );
        fs::remove_dir_all(path).unwrap();
    }

    #[test]
    fn revert_added_copy_is_refused_without_resetting_its_source_or_contents() {
        let path = fixture();
        fs::write(path.join("file.txt"), "source staged edit\n").unwrap();
        fs::copy(path.join("file.txt"), path.join("copy.txt")).unwrap();
        git_stdout(&path, &["add", "file.txt", "copy.txt"], None).unwrap();
        let error = revert_preview_sync(path.to_str().unwrap(), "copy.txt").unwrap_err();
        assert!(error.contains("Unstage"), "{error}");
        assert_eq!(
            fs::read(path.join("copy.txt")).unwrap(),
            b"source staged edit\n"
        );
        assert_eq!(
            fs::read_to_string(path.join("file.txt")).unwrap(),
            "source staged edit\n"
        );
        assert_eq!(
            git_stdout(&path, &["diff", "--cached", "--name-only"], None).unwrap(),
            "copy.txt\nfile.txt"
        );
        fs::remove_dir_all(path).unwrap();
    }

    #[test]
    fn revert_refuses_new_file_and_missing_rename_working_copy_without_losing_staged_data() {
        let path = fixture();
        fs::write(path.join("new.txt"), "only new working contents\n").unwrap();
        git_stdout(&path, &["add", "new.txt"], None).unwrap();
        let before = git_stdout(&path, &["diff", "--cached"], None).unwrap();
        assert!(revert_preview_sync(path.to_str().unwrap(), "new.txt")
            .unwrap_err()
            .contains("Unstage"));
        assert_eq!(
            fs::read(path.join("new.txt")).unwrap(),
            b"only new working contents\n"
        );
        assert_eq!(
            git_stdout(&path, &["diff", "--cached"], None).unwrap(),
            before
        );
        git_stdout(&path, &["mv", "file.txt", "renamed.txt"], None).unwrap();
        fs::remove_file(path.join("renamed.txt")).unwrap();
        let before = git_stdout(&path, &["diff", "--cached"], None).unwrap();
        let staged = git_stdout(&path, &["show", ":renamed.txt"], None).unwrap();
        assert!(revert_preview_sync(path.to_str().unwrap(), "renamed.txt")
            .unwrap_err()
            .contains("no working copy"));
        assert_eq!(
            git_stdout(&path, &["diff", "--cached"], None).unwrap(),
            before
        );
        assert_eq!(
            git_stdout(&path, &["show", ":renamed.txt"], None).unwrap(),
            staged
        );
        fs::remove_dir_all(path).unwrap();
    }

    #[test]
    fn revert_missing_staged_addition_preserves_index_and_requires_recovery_before_unstage() {
        let path = fixture();
        fs::write(path.join("new.txt"), "only staged copy\n").unwrap();
        git_stdout(&path, &["add", "new.txt"], None).unwrap();
        fs::remove_file(path.join("new.txt")).unwrap();
        let staged = git_stdout(&path, &["show", ":new.txt"], None).unwrap();
        let error = revert_preview_sync(path.to_str().unwrap(), "new.txt").unwrap_err();
        assert_eq!(
            git_stdout(&path, &["show", ":new.txt"], None).unwrap(),
            staged
        );
        assert!(
            error.contains("no working copy") && error.contains("before unstaging"),
            "{error}"
        );
        assert!(!error.contains("Unstage to keep"), "{error}");
        fs::remove_dir_all(path).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn revert_rejects_symlink_ancestors_but_restores_the_tracked_symlink_itself() {
        use std::os::unix::fs::symlink;
        let path = fixture();
        let outside = path.with_extension("outside");
        fs::create_dir(&outside).unwrap();
        fs::write(outside.join("valuable"), "outside data\n").unwrap();
        symlink(&outside, path.join("escape")).unwrap();
        assert!(
            revert_preview_sync(path.to_str().unwrap(), "escape/valuable")
                .unwrap_err()
                .contains("symlink")
        );
        symlink(outside.join("valuable"), path.join("link")).unwrap();
        git_stdout(&path, &["add", "link"], None).unwrap();
        git_stdout(
            &path,
            &[
                "-c",
                "user.name=Test",
                "-c",
                "user.email=test@example.com",
                "commit",
                "-m",
                "link",
            ],
            None,
        )
        .unwrap();
        fs::remove_file(path.join("link")).unwrap();
        symlink("other-target", path.join("link")).unwrap();
        let preview = revert_preview_sync(path.to_str().unwrap(), "link").unwrap();
        revert_sync(path.to_str().unwrap(), "link", &preview.token).unwrap();
        assert_eq!(
            fs::read_link(path.join("link")).unwrap(),
            outside.join("valuable")
        );
        assert_eq!(
            fs::read_to_string(outside.join("valuable")).unwrap(),
            "outside data\n"
        );
        fs::remove_dir_all(path).unwrap();
        fs::remove_dir_all(outside).unwrap();
    }

    #[test]
    fn revert_has_no_destructive_unborn_or_untracked_fallback() {
        let path = fixture();
        fs::write(path.join("untracked"), "valuable\n").unwrap();
        assert!(revert_preview_sync(path.to_str().unwrap(), "untracked")
            .unwrap_err()
            .contains("untracked"));
        let unborn = path.with_extension("unborn");
        fs::create_dir(&unborn).unwrap();
        git_stdout(&unborn, &["init"], None).unwrap();
        fs::write(unborn.join("new"), "initial\n").unwrap();
        git_stdout(&unborn, &["add", "new"], None).unwrap();
        assert!(revert_preview_sync(unborn.to_str().unwrap(), "new")
            .unwrap_err()
            .contains("no saved commit"));
        assert_eq!(fs::read_to_string(unborn.join("new")).unwrap(), "initial\n");
        fs::remove_dir_all(path).unwrap();
        fs::remove_dir_all(unborn).unwrap();
    }

    #[test]
    fn revert_literal_path_and_expired_confirmation_preserve_neighboring_files() {
        let path = fixture();
        #[cfg(unix)]
        let literal = ":(glob)*.txt";
        #[cfg(not(unix))]
        let literal = "literal[1].txt";
        fs::write(path.join(literal), "literal saved\n").unwrap();
        git_stdout(&path, &["--literal-pathspecs", "add", "--", literal], None).unwrap();
        git_stdout(
            &path,
            &[
                "-c",
                "user.name=Test",
                "-c",
                "user.email=test@example.com",
                "commit",
                "-m",
                "literal",
            ],
            None,
        )
        .unwrap();
        fs::write(path.join(literal), "literal edit\n").unwrap();
        fs::write(path.join("file.txt"), "neighbor edit\n").unwrap();
        let expired = revert_preview_sync(path.to_str().unwrap(), literal).unwrap();
        revert_previews()
            .lock()
            .unwrap()
            .get_mut(&expired.token)
            .unwrap()
            .created = Instant::now() - REVERT_PREVIEW_TTL;
        assert!(revert_sync(path.to_str().unwrap(), literal, &expired.token).is_err());
        assert_eq!(
            fs::read_to_string(path.join(literal)).unwrap(),
            "literal edit\n"
        );
        let preview = revert_preview_sync(path.to_str().unwrap(), literal).unwrap();
        revert_sync(path.to_str().unwrap(), literal, &preview.token).unwrap();
        assert_restored_from_head(&path, literal);
        assert_eq!(
            fs::read_to_string(path.join("file.txt")).unwrap(),
            "neighbor edit\n"
        );
        fs::remove_dir_all(path).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn revert_failure_reports_possible_partial_changes_and_consumes_confirmation() {
        let path = fixture();
        fs::write(path.join(".gitattributes"), "*.txt filter=revert-test\n").unwrap();
        git_stdout(&path, &["add", ".gitattributes"], None).unwrap();
        git_stdout(
            &path,
            &[
                "-c",
                "user.name=Test",
                "-c",
                "user.email=test@example.com",
                "commit",
                "-m",
                "attributes",
            ],
            None,
        )
        .unwrap();
        fs::write(path.join("file.txt"), "working edit\n").unwrap();
        git_stdout(&path, &["add", "file.txt"], None).unwrap();
        let preview = revert_preview_sync(path.to_str().unwrap(), "file.txt").unwrap();
        git_stdout(
            &path,
            &["config", "filter.revert-test.required", "true"],
            None,
        )
        .unwrap();
        git_stdout(
            &path,
            &["config", "filter.revert-test.smudge", "exit 1"],
            None,
        )
        .unwrap();
        let error = revert_sync(path.to_str().unwrap(), "file.txt", &preview.token).unwrap_err();
        assert!(
            error.contains("reset the selected index paths")
                && error.contains("Some tracked paths may have changed"),
            "{error}"
        );
        assert!(
            revert_sync(path.to_str().unwrap(), "file.txt", &preview.token)
                .unwrap_err()
                .contains("already used")
        );
        fs::remove_dir_all(path).unwrap();
    }

    #[test]
    fn bulk_revert_preserves_added_untracked_and_renamed_destination_contents() {
        let path = fixture();
        fs::write(path.join("tracked.txt"), "saved tracked\n").unwrap();
        commit_sync(
            path.to_str().unwrap(),
            "second tracked file",
            false,
            None,
            None,
        )
        .unwrap();
        git_stdout(&path, &["mv", "--", "file.txt", "renamed.txt"], None).unwrap();
        fs::write(path.join("renamed.txt"), "rename working contents\n").unwrap();
        fs::write(path.join("tracked.txt"), "tracked edits\n").unwrap();
        fs::write(path.join("added.txt"), "new staged contents\n").unwrap();
        git_stdout(&path, &["add", "--", "added.txt", "tracked.txt"], None).unwrap();
        fs::write(path.join("added.txt"), "newer unstaged contents\n").unwrap();
        fs::write(path.join("untracked.txt"), "new untracked contents\n").unwrap();
        let before_head = git_stdout(&path, &["rev-parse", "HEAD"], None).unwrap();
        let preview = revert_all_preview_sync(path.to_str().unwrap()).unwrap();
        assert_eq!(preview.restore_paths, vec!["file.txt", "tracked.txt"]);
        assert_eq!(
            preview.preserved_paths,
            vec!["added.txt", "renamed.txt", "untracked.txt"]
        );
        revert_all_sync(path.to_str().unwrap(), &preview.token).unwrap();
        assert_eq!(
            fs::read(path.join("added.txt")).unwrap(),
            b"newer unstaged contents\n"
        );
        assert_eq!(
            fs::read(path.join("renamed.txt")).unwrap(),
            b"rename working contents\n"
        );
        assert_eq!(
            fs::read(path.join("untracked.txt")).unwrap(),
            b"new untracked contents\n"
        );
        assert_restored_from_head(&path, "file.txt");
        assert_restored_from_head(&path, "tracked.txt");
        assert_eq!(snapshot(&path).unwrap().staged_files, 0);
        assert_eq!(
            git_stdout(&path, &["rev-parse", "HEAD"], None).unwrap(),
            before_head
        );
        fs::remove_dir_all(path).unwrap();
    }

    #[test]
    fn bulk_revert_rejects_stale_working_index_head_branch_and_preserved_contents() {
        for mutation in [
            "working",
            "index",
            "head",
            "branch",
            "preserved",
            "new path",
        ] {
            let path = fixture();
            fs::write(path.join("file.txt"), "previewed tracked edits\n").unwrap();
            fs::write(path.join("new.txt"), "previewed new contents\n").unwrap();
            let preview = revert_all_preview_sync(path.to_str().unwrap()).unwrap();
            match mutation {
                "working" => fs::write(path.join("file.txt"), "late tracked edits\n").unwrap(),
                "index" => {
                    git_stdout(&path, &["add", "--", "file.txt"], None).unwrap();
                }
                "head" => {
                    commit_sync(path.to_str().unwrap(), "external commit", false, None, None)
                        .unwrap();
                }
                "branch" => {
                    git_stdout(&path, &["checkout", "-b", "other"], None).unwrap();
                }
                "preserved" => fs::write(path.join("new.txt"), "late new contents\n").unwrap(),
                "new path" => fs::write(path.join("later.txt"), "late new file\n").unwrap(),
                _ => unreachable!(),
            }
            let working = fs::read(path.join("file.txt")).unwrap();
            let new = fs::read(path.join("new.txt")).unwrap();
            let index = run_git(&path, &["ls-files", "--stage", "-z"], None)
                .unwrap()
                .stdout;
            let head = git_stdout(&path, &["rev-parse", "HEAD"], None).unwrap();
            let error = revert_all_sync(path.to_str().unwrap(), &preview.token).unwrap_err();
            assert!(
                error.contains("changed during confirmation"),
                "{mutation}: {error}"
            );
            assert_eq!(fs::read(path.join("file.txt")).unwrap(), working);
            assert_eq!(fs::read(path.join("new.txt")).unwrap(), new);
            assert_eq!(
                run_git(&path, &["ls-files", "--stage", "-z"], None)
                    .unwrap()
                    .stdout,
                index
            );
            assert_eq!(
                git_stdout(&path, &["rev-parse", "HEAD"], None).unwrap(),
                head
            );
            assert!(revert_all_sync(path.to_str().unwrap(), &preview.token)
                .unwrap_err()
                .contains("already used"));
            fs::remove_dir_all(path).unwrap();
        }
    }

    #[test]
    fn bulk_revert_refuses_unborn_conflicts_and_missing_new_working_files() {
        let unborn = env::temp_dir().join(format!("mythra-bulk-unborn-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&unborn).unwrap();
        git_stdout(&unborn, &["init"], None).unwrap();
        fs::write(unborn.join("new.txt"), "initial contents\n").unwrap();
        git_stdout(&unborn, &["add", "--", "new.txt"], None).unwrap();
        assert!(revert_all_preview_sync(unborn.to_str().unwrap())
            .unwrap_err()
            .contains("no readable saved commit"));
        assert_eq!(
            fs::read(unborn.join("new.txt")).unwrap(),
            b"initial contents\n"
        );
        fs::remove_dir_all(unborn).unwrap();
        let path = fixture();
        let oid = git_stdout(&path, &["rev-parse", "HEAD:file.txt"], None).unwrap();
        let conflicts = format!("0 {}\tfile.txt\n100644 {oid} 1\tfile.txt\n100644 {oid} 2\tfile.txt\n100644 {oid} 3\tfile.txt\n", "0".repeat(oid.len()));
        let result = crate::project_git::run_git_with_input(
            &path,
            &["update-index", "--index-info"],
            None,
            conflicts.as_bytes(),
        )
        .unwrap();
        assert!(result.status.success());
        let before = run_git(&path, &["ls-files", "--stage", "-z"], None)
            .unwrap()
            .stdout;
        assert!(revert_all_preview_sync(path.to_str().unwrap())
            .unwrap_err()
            .contains("conflicts"));
        assert_eq!(
            run_git(&path, &["ls-files", "--stage", "-z"], None)
                .unwrap()
                .stdout,
            before
        );
        fs::remove_dir_all(path).unwrap();
        let path = fixture();
        fs::write(path.join("added.txt"), "only staged copy\n").unwrap();
        git_stdout(&path, &["add", "--", "added.txt"], None).unwrap();
        fs::remove_file(path.join("added.txt")).unwrap();
        assert!(revert_all_preview_sync(path.to_str().unwrap())
            .unwrap_err()
            .contains("no working copy"));
        assert_eq!(
            git_stdout(&path, &["show", ":added.txt"], None).unwrap(),
            "only staged copy"
        );
        fs::remove_dir_all(path).unwrap();
    }

    #[test]
    fn bulk_revert_refuses_recreated_sources_and_bounds_large_inspections() {
        let path = fixture();
        git_stdout(&path, &["mv", "--", "file.txt", "renamed.txt"], None).unwrap();
        fs::write(path.join("file.txt"), "new recreated source\n").unwrap();
        let index = run_git(&path, &["ls-files", "--stage", "-z"], None)
            .unwrap()
            .stdout;
        assert!(revert_all_preview_sync(path.to_str().unwrap())
            .unwrap_err()
            .contains("recreated"));
        assert_eq!(
            fs::read(path.join("file.txt")).unwrap(),
            b"new recreated source\n"
        );
        assert_eq!(
            run_git(&path, &["ls-files", "--stage", "-z"], None)
                .unwrap()
                .stdout,
            index
        );
        fs::remove_dir_all(path).unwrap();
        let path = fixture();
        for number in 0..=MAX_BULK_REVERT_PATHS {
            fs::write(path.join(format!("new-{number}.txt")), "keep\n").unwrap();
        }
        assert!(revert_all_preview_sync(path.to_str().unwrap())
            .unwrap_err()
            .contains("too many changed paths"));
        assert_eq!(snapshot(&path).unwrap().staged_files, 0);
        fs::remove_dir_all(path).unwrap();
        let path = fixture();
        let large = fs::File::create(path.join("large-new.bin")).unwrap();
        large.set_len(MAX_BULK_REVERT_WORKING_BYTES + 1).unwrap();
        assert!(revert_all_preview_sync(path.to_str().unwrap())
            .unwrap_err()
            .contains("too large"));
        assert_eq!(
            large.metadata().unwrap().len(),
            MAX_BULK_REVERT_WORKING_BYTES + 1
        );
        drop(large);
        fs::remove_dir_all(path).unwrap();
    }

    #[test]
    fn bulk_revert_confirmation_is_bound_to_checkout_and_expires() {
        let path = fixture();
        fs::write(path.join("file.txt"), "keep edits\n").unwrap();
        let other = fixture();
        fs::write(other.join("file.txt"), "other edits\n").unwrap();
        let preview = revert_all_preview_sync(path.to_str().unwrap()).unwrap();
        assert!(revert_all_sync(other.to_str().unwrap(), &preview.token)
            .unwrap_err()
            .contains("changed during confirmation"));
        assert_eq!(fs::read(other.join("file.txt")).unwrap(), b"other edits\n");
        let preview = revert_all_preview_sync(path.to_str().unwrap()).unwrap();
        bulk_revert_previews()
            .lock()
            .unwrap()
            .get_mut(&preview.token)
            .unwrap()
            .created = Instant::now() - REVERT_PREVIEW_TTL;
        assert!(revert_all_sync(path.to_str().unwrap(), &preview.token)
            .unwrap_err()
            .contains("changed during confirmation"));
        assert_eq!(fs::read(path.join("file.txt")).unwrap(), b"keep edits\n");
        fs::remove_dir_all(path).unwrap();
        fs::remove_dir_all(other).unwrap();
    }

    #[test]
    fn bulk_revert_reports_partial_restore_failure_without_removing_new_files() {
        let path = fixture();
        fs::write(path.join(".gitattributes"), "file.txt filter=blocked\n").unwrap();
        commit_sync(
            path.to_str().unwrap(),
            "filter configuration",
            false,
            None,
            None,
        )
        .unwrap();
        git_stdout(
            &path,
            &[
                "config",
                "filter.blocked.smudge",
                "git --not-a-real-restore-filter",
            ],
            None,
        )
        .unwrap();
        git_stdout(&path, &["config", "filter.blocked.required", "true"], None).unwrap();
        fs::write(path.join("file.txt"), "tracked edits\n").unwrap();
        fs::write(path.join("added.txt"), "keep new contents\n").unwrap();
        git_stdout(&path, &["add", "--", "added.txt"], None).unwrap();
        let preview = revert_all_preview_sync(path.to_str().unwrap()).unwrap();
        let error = revert_all_sync(path.to_str().unwrap(), &preview.token).unwrap_err();
        assert!(
            error.contains("reset the index") && error.contains("did not finish"),
            "{error}"
        );
        assert_eq!(snapshot(&path).unwrap().staged_files, 0);
        assert_eq!(
            fs::read(path.join("added.txt")).unwrap(),
            b"keep new contents\n"
        );
        assert!(revert_all_sync(path.to_str().unwrap(), &preview.token)
            .unwrap_err()
            .contains("already used"));
        fs::remove_dir_all(path).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn bulk_revert_uses_literal_paths_and_refuses_symlink_parent_escape() {
        use std::os::unix::fs::symlink;
        let path = fixture();
        git_stdout(&path, &["mv", "--", "file.txt", ":(glob)*.txt"], None).unwrap();
        commit_sync(
            path.to_str().unwrap(),
            "literal tracked filename",
            true,
            None,
            None,
        )
        .unwrap();
        fs::write(path.join(":(glob)*.txt"), "tracked edits\n").unwrap();
        fs::write(path.join("new.txt"), "keep new\n").unwrap();
        let preview = revert_all_preview_sync(path.to_str().unwrap()).unwrap();
        revert_all_sync(path.to_str().unwrap(), &preview.token).unwrap();
        assert_restored_from_head(&path, ":(glob)*.txt");
        assert_eq!(fs::read(path.join("new.txt")).unwrap(), b"keep new\n");
        fs::create_dir(path.join("parent")).unwrap();
        fs::write(path.join("parent/tracked.txt"), "inside\n").unwrap();
        commit_sync(path.to_str().unwrap(), "nested tracked", false, None, None).unwrap();
        let outside = fixture();
        fs::rename(path.join("parent"), path.join("old-parent")).unwrap();
        symlink(&outside, path.join("parent")).unwrap();
        assert!(revert_all_preview_sync(path.to_str().unwrap())
            .unwrap_err()
            .contains("symlink"));
        assert_eq!(fs::read(outside.join("file.txt")).unwrap(), b"one\n");
        fs::remove_dir_all(path).unwrap();
        fs::remove_dir_all(outside).unwrap();
    }

    #[test]
    fn commit_after_initialization_without_a_configured_identity() {
        let path = env::temp_dir().join(format!("mythra-initialized-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&path).unwrap();
        git_stdout(&path, &["init"], None).unwrap();
        git_stdout(&path, &["config", "user.name", ""], None).unwrap();
        git_stdout(&path, &["config", "user.email", ""], None).unwrap();
        fs::write(path.join("file.txt"), "initial\n").unwrap();
        crate::project_git::initialize_workspace_git_sync(path.to_str().unwrap()).unwrap();
        fs::write(path.join("file.txt"), "next\n").unwrap();
        let result = commit_sync(path.to_str().unwrap(), "next", false, None, None);
        assert_eq!(
            git_stdout(&path, &["log", "-1", "--format=%an <%ae>"], None).unwrap(),
            "Mythra Code <openkiwi@local>"
        );
        assert_eq!(
            git_stdout(&path, &["config", "user.name"], None).unwrap(),
            ""
        );
        assert_eq!(
            git_stdout(&path, &["config", "user.email"], None).unwrap(),
            ""
        );
        fs::remove_dir_all(&path).unwrap();
        result.expect("the initialized project must remain eligible for local commits");
    }

    #[test]
    fn unstage_unborn_partial_file_preserves_the_working_copy() {
        let path = env::temp_dir().join(format!("mythra-unborn-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&path).unwrap();
        git_stdout(&path, &["init"], None).unwrap();
        fs::write(path.join("file.txt"), "staged\n").unwrap();
        git_stdout(&path, &["add", "--", "file.txt"], None).unwrap();
        fs::write(path.join("file.txt"), "working\n").unwrap();
        let result = stage_sync(path.to_str().unwrap(), Some("file.txt"), true, None, None);
        let contents = fs::read_to_string(path.join("file.txt")).unwrap();
        assert_eq!(snapshot(&path).unwrap().staged_files, 0);
        fs::remove_dir_all(&path).unwrap();
        result.expect("unstaging must work when the working copy has newer edits");
        assert_eq!(contents, "working\n");
    }

    #[cfg(unix)]
    #[test]
    fn stage_treats_review_paths_as_literal_filenames() {
        let path = fixture();
        let filename = ":(glob)*.txt";
        fs::write(path.join(filename), "literal\n").unwrap();
        fs::write(path.join("file.txt"), "unrelated\n").unwrap();
        stage_sync(path.to_str().unwrap(), Some(filename), false, None, None).unwrap();
        let staged = snapshot(&path).unwrap().staged_paths;
        fs::remove_dir_all(&path).unwrap();
        assert_eq!(staged, vec![filename]);
    }

    #[test]
    fn unstage_staged_rename_restores_both_index_paths_and_preserves_other_staged_work() {
        for selected_path in ["renamed file.txt", "file.txt"] {
            let path = fixture();
            git_stdout(&path, &["mv", "--", "file.txt", "renamed file.txt"], None).unwrap();
            fs::write(path.join("renamed file.txt"), "newer working edits\n").unwrap();
            fs::write(path.join("unrelated.txt"), "keep staged\n").unwrap();
            git_stdout(&path, &["add", "--", "unrelated.txt"], None).unwrap();
            let before = snapshot(&path).unwrap();

            stage_sync(
                path.to_str().unwrap(),
                Some(selected_path),
                true,
                before.head_oid.as_deref(),
                before.branch.as_deref(),
            )
            .unwrap();

            assert_eq!(snapshot(&path).unwrap().staged_paths, vec!["unrelated.txt"]);
            assert_eq!(
                git_stdout(&path, &["show", ":file.txt"], None).unwrap(),
                "one"
            );
            assert!(!path.join("file.txt").exists());
            assert_eq!(
                fs::read_to_string(path.join("renamed file.txt")).unwrap(),
                "newer working edits\n"
            );
            assert_eq!(
                fs::read_to_string(path.join("unrelated.txt")).unwrap(),
                "keep staged\n"
            );
            fs::remove_dir_all(path).unwrap();
        }
    }

    #[test]
    fn unstage_added_copy_preserves_staged_edits_to_its_source() {
        let path = fixture();
        git_stdout(&path, &["config", "diff.renames", "copies"], None).unwrap();
        fs::write(path.join("file.txt"), "staged source edits\n").unwrap();
        fs::write(path.join("copy.txt"), "one\n").unwrap();
        git_stdout(&path, &["add", "--", "file.txt", "copy.txt"], None).unwrap();
        stage_sync(path.to_str().unwrap(), Some("copy.txt"), true, None, None).unwrap();
        assert_eq!(snapshot(&path).unwrap().staged_paths, vec!["file.txt"]);
        assert_eq!(
            git_stdout(&path, &["show", ":file.txt"], None).unwrap(),
            "staged source edits"
        );
        assert_eq!(fs::read_to_string(path.join("copy.txt")).unwrap(), "one\n");
        fs::remove_dir_all(path).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn unstage_rename_treats_both_index_paths_as_literal_filenames() {
        let path = fixture();
        let source = "source [1].txt";
        let target = ":(glob)*.txt";
        git_stdout(&path, &["mv", "--", "file.txt", source], None).unwrap();
        commit_sync(path.to_str().unwrap(), "source filename", true, None, None).unwrap();
        git_stdout(&path, &["mv", "--", source, target], None).unwrap();
        fs::write(path.join("unrelated.txt"), "keep staged\n").unwrap();
        git_stdout(&path, &["add", "--", "unrelated.txt"], None).unwrap();
        stage_sync(path.to_str().unwrap(), Some(target), true, None, None).unwrap();
        assert_eq!(snapshot(&path).unwrap().staged_paths, vec!["unrelated.txt"]);
        assert_eq!(
            git_stdout(&path, &["show", &format!(":{source}")], None).unwrap(),
            "one"
        );
        assert_eq!(fs::read_to_string(path.join(target)).unwrap(), "one\n");
        fs::remove_dir_all(path).unwrap();
    }

    #[tokio::test]
    async fn stage_and_unstage_all_preserve_working_files_and_ignored_files() {
        let path = fixture();
        fs::write(path.join(".gitignore"), "ignored.txt\n").unwrap();
        fs::write(path.join("ignored.txt"), "private\n").unwrap();
        fs::write(path.join("file.txt"), "working\n").unwrap();
        fs::write(path.join("new.txt"), "new\n").unwrap();
        let before = snapshot(&path).unwrap();
        git_workspace_stage(
            path.to_string_lossy().into_owned(),
            None,
            false,
            before.head_oid.clone(),
            before.branch.clone(),
        )
        .await
        .unwrap();
        assert_eq!(
            snapshot(&path).unwrap().staged_paths,
            vec![".gitignore", "file.txt", "new.txt"]
        );
        git_workspace_stage(
            path.to_string_lossy().into_owned(),
            None,
            true,
            before.head_oid,
            before.branch,
        )
        .await
        .unwrap();
        assert_eq!(snapshot(&path).unwrap().staged_files, 0);
        assert_eq!(
            fs::read_to_string(path.join("file.txt")).unwrap(),
            "working\n"
        );
        assert_eq!(fs::read_to_string(path.join("new.txt")).unwrap(), "new\n");
        assert_eq!(
            fs::read_to_string(path.join("ignored.txt")).unwrap(),
            "private\n"
        );
        fs::remove_dir_all(path).unwrap();
    }

    #[test]
    fn staging_rejects_paths_outside_the_repository_before_index_changes() {
        let path = fixture();
        fs::write(path.join("file.txt"), "working\n").unwrap();
        let error = stage_sync(
            path.to_str().unwrap(),
            Some("../file.txt"),
            false,
            None,
            None,
        )
        .unwrap_err();
        assert!(error.contains("inside the Git repository"));
        assert_eq!(snapshot(&path).unwrap().staged_files, 0);
        fs::remove_dir_all(path).unwrap();
    }

    #[test]
    fn staged_commit_preserves_unstaged_and_untracked_work() {
        let path = fixture();
        git_stdout(&path, &["config", "user.name", "Configured User"], None).unwrap();
        git_stdout(
            &path,
            &["config", "user.email", "configured@example.com"],
            None,
        )
        .unwrap();
        fs::write(path.join("file.txt"), "staged\n").unwrap();
        git_stdout(&path, &["add", "--", "file.txt"], None).unwrap();
        fs::write(path.join("file.txt"), "later working edit\n").unwrap();
        fs::write(path.join("untracked.txt"), "untracked\n").unwrap();
        let before = snapshot(&path).unwrap();
        let result = commit_sync(
            path.to_str().unwrap(),
            "  staged only  ",
            true,
            before.head_oid.as_deref(),
            before.branch.as_deref(),
        )
        .unwrap();
        assert_ne!(Some(result.head_oid), before.head_oid);
        assert_eq!(result.branch, before.branch);
        assert_eq!(
            git_stdout(&path, &["show", "HEAD:file.txt"], None).unwrap(),
            "staged"
        );
        assert_eq!(
            git_stdout(&path, &["log", "-1", "--format=%s"], None).unwrap(),
            "staged only"
        );
        assert_eq!(
            git_stdout(&path, &["log", "-1", "--format=%an <%ae>"], None).unwrap(),
            "Configured User <configured@example.com>"
        );
        assert_eq!(
            fs::read_to_string(path.join("file.txt")).unwrap(),
            "later working edit\n"
        );
        assert_eq!(snapshot(&path).unwrap().unstaged_files, 2);
        assert!(
            run_git(&path, &["cat-file", "-e", "HEAD:untracked.txt"], None)
                .unwrap()
                .status
                .code()
                .is_some_and(|code| code != 0)
        );
        fs::remove_dir_all(path).unwrap();
    }

    #[test]
    fn first_commit_accepts_an_unborn_branch_snapshot() {
        let path = env::temp_dir().join(format!("mythra-first-commit-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&path).unwrap();
        git_stdout(&path, &["init", "-b", "main"], None).unwrap();
        fs::write(path.join("first.txt"), "first\n").unwrap();
        let result =
            commit_sync(path.to_str().unwrap(), "first", false, None, Some("main")).unwrap();
        assert_eq!(result.branch.as_deref(), Some("main"));
        assert_eq!(snapshot(&path).unwrap().changed_files, 0);
        assert_eq!(
            git_stdout(&path, &["show", "HEAD:first.txt"], None).unwrap(),
            "first"
        );
        fs::remove_dir_all(path).unwrap();
    }

    #[test]
    fn stale_checkout_and_empty_message_leave_the_index_unchanged() {
        let path = fixture();
        fs::write(path.join("file.txt"), "working\n").unwrap();
        let before = snapshot(&path).unwrap();
        let error = commit_sync(path.to_str().unwrap(), " \n ", false, None, None).unwrap_err();
        assert_eq!(error, "Enter a commit message");
        git_stdout(&path, &["checkout", "-b", "other"], None).unwrap();
        let error = commit_sync(
            path.to_str().unwrap(),
            "stale",
            false,
            before.head_oid.as_deref(),
            before.branch.as_deref(),
        )
        .unwrap_err();
        assert!(error.contains("changed since"));
        assert_eq!(snapshot(&path).unwrap().staged_files, 0);
        fs::remove_dir_all(path).unwrap();
    }

    #[test]
    fn empty_staged_commit_reports_git_output_and_does_not_stage() {
        let path = fixture();
        fs::write(path.join("file.txt"), "working\n").unwrap();
        let before = snapshot(&path).unwrap();
        let error =
            commit_sync(path.to_str().unwrap(), "staged only", true, None, None).unwrap_err();
        assert!(error.contains("no changes added to commit"), "{error}");
        let after = snapshot(&path).unwrap();
        assert_eq!(after.head_oid, before.head_oid);
        assert_eq!(after.staged_files, 0);
        assert_eq!(
            fs::read_to_string(path.join("file.txt")).unwrap(),
            "working\n"
        );
        fs::remove_dir_all(path).unwrap();
    }

    #[tokio::test]
    async fn concurrent_commits_revalidate_the_same_snapshot_under_the_repository_lock() {
        let path = fixture();
        fs::write(path.join("file.txt"), "working\n").unwrap();
        let before = snapshot(&path).unwrap();
        let first = git_workspace_commit(
            path.to_string_lossy().into_owned(),
            "first contender".into(),
            false,
            before.head_oid.clone(),
            before.branch.clone(),
        );
        let second = git_workspace_commit(
            path.to_string_lossy().into_owned(),
            "second contender".into(),
            false,
            before.head_oid,
            before.branch,
        );
        let (first, second) = tokio::join!(first, second);
        assert_ne!(first.is_ok(), second.is_ok());
        let error = first.err().or_else(|| second.err()).unwrap();
        assert!(error.contains("changed since"), "{error}");
        assert_eq!(
            git_stdout(&path, &["rev-list", "--count", "HEAD"], None).unwrap(),
            "2"
        );
        fs::remove_dir_all(path).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn failed_commit_keeps_staged_content_and_git_hook_details() {
        use std::os::unix::fs::PermissionsExt;

        let path = fixture();
        let before = snapshot(&path).unwrap();
        let hook = path.join(".git/hooks/pre-commit");
        fs::write(
            &hook,
            "#!/bin/sh\necho 'Rejected by fixture hook' >&2\nexit 1\n",
        )
        .unwrap();
        let mut permissions = fs::metadata(&hook).unwrap().permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&hook, permissions).unwrap();
        fs::write(path.join("file.txt"), "working\n").unwrap();
        let error = commit_sync(path.to_str().unwrap(), "blocked", false, None, None).unwrap_err();
        assert!(error.contains("Rejected by fixture hook"));
        let after = snapshot(&path).unwrap();
        assert_eq!(after.head_oid, before.head_oid);
        assert_eq!(after.staged_files, 1);
        assert_eq!(
            git_stdout(&path, &["show", ":file.txt"], None).unwrap(),
            "working"
        );
        assert_eq!(
            fs::read_to_string(path.join("file.txt")).unwrap(),
            "working\n"
        );
        fs::remove_dir_all(path).unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn cancelled_commit_keeps_the_lock_until_git_finishes() {
        use std::os::unix::fs::PermissionsExt;

        let path = fixture();
        let marker = path.join(".git/hook-started");
        let gate = path.join(".git/hook-release");
        let hook = path.join(".git/hooks/pre-commit");
        fs::write(
            &hook,
            format!(
                "#!/bin/sh\ntouch \"{}\"\nwhile [ ! -f \"{}\" ]; do sleep 0.01; done\n",
                marker.display(),
                gate.display(),
            ),
        )
        .unwrap();
        let mut permissions = fs::metadata(&hook).unwrap().permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&hook, permissions).unwrap();
        fs::write(path.join("file.txt"), "working\n").unwrap();
        let task = tokio::spawn(git_workspace_commit(
            path.to_string_lossy().into_owned(),
            "cancelled invocation".into(),
            false,
            None,
            None,
        ));
        let started = tokio::time::timeout(Duration::from_secs(5), async {
            while !marker.exists() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await;
        if started.is_err() {
            fs::write(&gate, "release").unwrap();
            panic!("the fixture Git hook did not start");
        }
        task.abort();
        assert!(task.await.unwrap_err().is_cancelled());
        let lock = repository_lock(&path).await.unwrap();
        let still_locked = lock.try_lock().is_err();
        fs::write(&gate, "release").unwrap();
        let guard = tokio::time::timeout(Duration::from_secs(5), lock.lock())
            .await
            .unwrap();
        assert!(
            still_locked,
            "cancelling the invocation released the active Git mutation lock"
        );
        assert_eq!(
            git_stdout(&path, &["log", "-1", "--format=%s"], None).unwrap(),
            "cancelled invocation"
        );
        drop(guard);
        fs::remove_dir_all(path).unwrap();
    }

    fn remote_fixture() -> RemoteFixture {
        static NEXT: AtomicUsize = AtomicUsize::new(10_000);
        let root = env::temp_dir().join(format!(
            "mythra-git-workspace-remote-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed),
        ));
        let seed = root.join("seed");
        let client = root.join("client");
        let bare = root.join("remote.git");
        fs::create_dir_all(&seed).unwrap();
        git_stdout(&root, &["init", "--bare", bare.to_str().unwrap()], None).unwrap();
        git_stdout(&seed, &["init", "-b", "main"], None).unwrap();
        fs::write(seed.join("file.txt"), "main\n").unwrap();
        git_stdout(&seed, &["add", "."], None).unwrap();
        git_stdout(
            &seed,
            &[
                "-c",
                "user.name=Test",
                "-c",
                "user.email=test@example.com",
                "commit",
                "-m",
                "main",
            ],
            None,
        )
        .unwrap();
        git_stdout(&seed, &["checkout", "-b", "release/v2"], None).unwrap();
        fs::write(seed.join("release.txt"), "release one\n").unwrap();
        git_stdout(&seed, &["add", "."], None).unwrap();
        git_stdout(
            &seed,
            &[
                "-c",
                "user.name=Test",
                "-c",
                "user.email=test@example.com",
                "commit",
                "-m",
                "release",
            ],
            None,
        )
        .unwrap();
        git_stdout(
            &seed,
            &["remote", "add", "origin", bare.to_str().unwrap()],
            None,
        )
        .unwrap();
        git_stdout(&seed, &["push", "origin", "main", "release/v2"], None).unwrap();
        git_stdout(
            &root,
            &[
                "clone",
                "-b",
                "main",
                bare.to_str().unwrap(),
                client.to_str().unwrap(),
            ],
            None,
        )
        .unwrap();
        git_stdout(&client, &["checkout", "-b", "topic/local"], None).unwrap();
        git_stdout(
            &client,
            &[
                "remote",
                "set-url",
                "origin",
                "https://github.com/test/repo.git",
            ],
            None,
        )
        .unwrap();
        let rewrite = format!("url.file://{}.insteadOf", bare.to_string_lossy());
        git_stdout(
            &client,
            &["config", &rewrite, "https://github.com/test/repo.git"],
            None,
        )
        .unwrap();
        RemoteFixture {
            root,
            seed,
            client,
            bare,
        }
    }

    fn advance_release(fixture: &RemoteFixture, value: &str) -> String {
        fs::write(fixture.seed.join("release.txt"), value).unwrap();
        git_stdout(&fixture.seed, &["add", "."], None).unwrap();
        git_stdout(
            &fixture.seed,
            &[
                "-c",
                "user.name=Test",
                "-c",
                "user.email=test@example.com",
                "commit",
                "-m",
                value,
            ],
            None,
        )
        .unwrap();
        git_stdout(&fixture.seed, &["push", "origin", "release/v2"], None).unwrap();
        git_stdout(&fixture.seed, &["rev-parse", "HEAD"], None).unwrap()
    }

    #[test]
    fn push_refuses_a_checkout_changed_after_the_commit_was_captured() {
        let fixture = remote_fixture();
        git_stdout(&fixture.client, &["config", "push.default", "simple"], None).unwrap();
        git_stdout(
            &fixture.client,
            &["push", "--set-upstream", "origin", "topic/local"],
            None,
        )
        .unwrap();
        fs::write(fixture.client.join("file.txt"), "intended topic\n").unwrap();
        let committed = commit_sync(
            fixture.client.to_str().unwrap(),
            "intended topic",
            false,
            None,
            None,
        )
        .unwrap();
        git_stdout(&fixture.client, &["checkout", "main"], None).unwrap();
        fs::write(fixture.client.join("file.txt"), "other branch\n").unwrap();
        commit_sync(
            fixture.client.to_str().unwrap(),
            "other branch",
            false,
            None,
            None,
        )
        .unwrap();
        let result = push_sync(
            fixture.client.to_str().unwrap(),
            &committed.head_oid,
            committed.branch.as_deref().unwrap(),
            "https://github.com/test/repo.git",
            "test/repo",
        );
        let remote_topic = git_stdout(
            &fixture.bare,
            &["rev-parse", "refs/heads/topic/local"],
            None,
        )
        .unwrap();
        fs::remove_dir_all(fixture.root).unwrap();
        assert!(
            result.is_err(),
            "a stale push must refuse a different current checkout"
        );
        assert_ne!(remote_topic, committed.head_oid);
    }

    fn configure_pull(fixture: &RemoteFixture) {
        git_stdout(
            &fixture.client,
            &["config", "branch.topic/local.remote", "origin"],
            None,
        )
        .unwrap();
        git_stdout(
            &fixture.client,
            &["config", "branch.topic/local.merge", "refs/heads/main"],
            None,
        )
        .unwrap();
        git_stdout(&fixture.seed, &["checkout", "main"], None).unwrap();
    }

    fn advance_pull(fixture: &RemoteFixture) -> String {
        let committed = commit_sync(
            fixture.seed.to_str().unwrap(),
            "remote advance",
            false,
            None,
            None,
        )
        .unwrap();
        git_stdout(&fixture.seed, &["push", "origin", "main"], None).unwrap();
        committed.head_oid
    }

    #[test]
    fn pull_fast_forwards_current_branch_without_changing_upstream_or_fetch_head() {
        let fixture = remote_fixture();
        configure_pull(&fixture);
        fs::write(fixture.seed.join("file.txt"), "remote update\n").unwrap();
        let target = advance_pull(&fixture);
        fs::write(
            fixture.client.join(".git/FETCH_HEAD"),
            "keep prior fetch state\n",
        )
        .unwrap();
        let before = snapshot(&fixture.client).unwrap();
        pull_sync(
            fixture.client.to_str().unwrap(),
            before.head_oid.as_deref().unwrap(),
            before.branch.as_deref().unwrap(),
            "https://github.com/test/repo.git",
            "test/repo",
        )
        .unwrap();
        assert_eq!(snapshot(&fixture.client).unwrap().branch, before.branch);
        assert_eq!(
            snapshot(&fixture.client).unwrap().head_oid.as_deref(),
            Some(target.as_str())
        );
        assert_eq!(
            git_stdout(
                &fixture.client,
                &["config", "branch.topic/local.remote"],
                None
            )
            .unwrap(),
            "origin"
        );
        assert_eq!(
            git_stdout(
                &fixture.client,
                &["config", "branch.topic/local.merge"],
                None
            )
            .unwrap(),
            "refs/heads/main"
        );
        assert_eq!(
            git_stdout(&fixture.client, &["rev-parse", "@{upstream}"], None).unwrap(),
            target
        );
        assert_eq!(
            git_stdout(
                &fixture.client,
                &["rev-list", "--left-right", "--count", "HEAD...@{upstream}"],
                None
            )
            .unwrap(),
            "0\t0"
        );
        assert_eq!(
            fs::read(fixture.client.join(".git/FETCH_HEAD")).unwrap(),
            b"keep prior fetch state\n"
        );
        assert_eq!(
            git_stdout(
                &fixture.client,
                &["for-each-ref", "refs/openkiwi/fetched-pull"],
                None
            )
            .unwrap(),
            ""
        );
        fs::remove_dir_all(fixture.root).unwrap();
    }

    #[test]
    fn pull_uses_origin_fetch_url_independently_of_a_separate_push_url() {
        let fixture = remote_fixture();
        configure_pull(&fixture);
        git_stdout(
            &fixture.client,
            &[
                "config",
                "remote.origin.pushurl",
                "https://github.com/fork/separate-repo.git",
            ],
            None,
        )
        .unwrap();
        fs::write(fixture.seed.join("file.txt"), "remote update\n").unwrap();
        let target = advance_pull(&fixture);
        let before = snapshot(&fixture.client).unwrap();
        pull_sync(
            fixture.client.to_str().unwrap(),
            before.head_oid.as_deref().unwrap(),
            before.branch.as_deref().unwrap(),
            "https://github.com/test/repo.git",
            "test/repo",
        )
        .unwrap();
        assert_eq!(
            snapshot(&fixture.client).unwrap().head_oid.as_deref(),
            Some(target.as_str())
        );
        assert_eq!(snapshot(&fixture.client).unwrap().branch, before.branch);
        assert_eq!(
            git_stdout(&fixture.client, &["config", "remote.origin.pushurl"], None).unwrap(),
            "https://github.com/fork/separate-repo.git"
        );
        fs::remove_dir_all(fixture.root).unwrap();
    }

    #[test]
    fn pull_refuses_ignored_destination_matrix_without_changing_checkout() {
        for shape in ["file", "ancestor", "directory", "symlink"] {
            #[cfg(not(unix))]
            if shape == "symlink" {
                continue;
            }
            let fixture = remote_fixture();
            configure_pull(&fixture);
            let target = if matches!(shape, "ancestor" | "symlink") {
                "cache/nested.txt"
            } else if shape == "directory" {
                "cache"
            } else {
                "private.txt"
            };
            fs::create_dir_all(fixture.seed.join(target).parent().unwrap()).unwrap();
            fs::write(fixture.seed.join(target), "committed destination\n").unwrap();
            advance_pull(&fixture);
            fs::write(
                fixture.client.join(".git/info/exclude"),
                "private.txt\ncache\n",
            )
            .unwrap();
            let ignored = match shape {
                "ancestor" => fixture.client.join("cache"),
                "directory" => {
                    fs::create_dir(fixture.client.join("cache")).unwrap();
                    fixture.client.join("cache/private.txt")
                }
                "symlink" => {
                    let outside = fixture.root.join("outside");
                    fs::create_dir(&outside).unwrap();
                    #[cfg(unix)]
                    std::os::unix::fs::symlink(&outside, fixture.client.join("cache")).unwrap();
                    outside.join("private.txt")
                }
                _ => fixture.client.join("private.txt"),
            };
            fs::write(&ignored, "unique ignored contents\n").unwrap();
            let before = snapshot(&fixture.client).unwrap();
            let index = fs::read(fixture.client.join(".git/index")).unwrap();
            let result = pull_sync(
                fixture.client.to_str().unwrap(),
                before.head_oid.as_deref().unwrap(),
                before.branch.as_deref().unwrap(),
                "https://github.com/test/repo.git",
                "test/repo",
            );
            assert!(
                result.is_err(),
                "{shape}: ignored contents were overwritten: {result:?}"
            );
            assert_eq!(
                fs::read(&ignored).unwrap(),
                b"unique ignored contents\n",
                "{shape}"
            );
            if shape == "symlink" {
                assert!(fs::symlink_metadata(fixture.client.join("cache"))
                    .unwrap()
                    .file_type()
                    .is_symlink());
            }
            assert_eq!(
                fs::read(fixture.client.join(".git/index")).unwrap(),
                index,
                "{shape}"
            );
            assert_eq!(
                snapshot(&fixture.client).unwrap().branch,
                before.branch,
                "{shape}"
            );
            assert_eq!(
                snapshot(&fixture.client).unwrap().head_oid,
                before.head_oid,
                "{shape}"
            );
            assert_eq!(
                git_stdout(
                    &fixture.client,
                    &["config", "branch.topic/local.merge"],
                    None
                )
                .unwrap(),
                "refs/heads/main"
            );
            assert_eq!(
                git_stdout(
                    &fixture.client,
                    &["for-each-ref", "refs/openkiwi/fetched-pull"],
                    None
                )
                .unwrap(),
                ""
            );
            fs::remove_dir_all(fixture.root).unwrap();
        }
    }

    #[test]
    fn pull_records_the_effective_custom_fetch_mapping() {
        let fixture = remote_fixture();
        configure_pull(&fixture);
        git_stdout(
            &fixture.client,
            &[
                "config",
                "remote.origin.fetch",
                "+refs/heads/*:refs/remotes/custom/*",
            ],
            None,
        )
        .unwrap();
        fs::write(fixture.seed.join("file.txt"), "remote update\n").unwrap();
        let target = advance_pull(&fixture);
        let before = snapshot(&fixture.client).unwrap();
        pull_sync(
            fixture.client.to_str().unwrap(),
            before.head_oid.as_deref().unwrap(),
            before.branch.as_deref().unwrap(),
            "https://github.com/test/repo.git",
            "test/repo",
        )
        .unwrap();
        assert_eq!(
            git_stdout(&fixture.client, &["rev-parse", "@{upstream}"], None).unwrap(),
            target
        );
        assert_eq!(
            git_stdout(
                &fixture.client,
                &["rev-parse", "refs/remotes/custom/main"],
                None
            )
            .unwrap(),
            target
        );
        assert_eq!(
            git_stdout(
                &fixture.client,
                &["rev-list", "--left-right", "--count", "HEAD...@{upstream}"],
                None
            )
            .unwrap(),
            "0\t0"
        );
        assert_eq!(snapshot(&fixture.client).unwrap().branch, before.branch);
        fs::remove_dir_all(fixture.root).unwrap();
    }

    #[test]
    fn pull_refuses_symbolic_or_local_branch_tracking_mappings() {
        for mode in ["symbolic", "local"] {
            let fixture = remote_fixture();
            configure_pull(&fixture);
            let before = snapshot(&fixture.client).unwrap();
            git_stdout(&fixture.client, &["branch", "victim"], None).unwrap();
            if mode == "symbolic" {
                git_stdout(
                    &fixture.client,
                    &[
                        "symbolic-ref",
                        "refs/remotes/origin/main",
                        "refs/heads/victim",
                    ],
                    None,
                )
                .unwrap();
            } else {
                git_stdout(
                    &fixture.client,
                    &[
                        "config",
                        "remote.origin.fetch",
                        "+refs/heads/*:refs/heads/upstream/*",
                    ],
                    None,
                )
                .unwrap();
            }
            let result = pull_sync(
                fixture.client.to_str().unwrap(),
                before.head_oid.as_deref().unwrap(),
                before.branch.as_deref().unwrap(),
                "https://github.com/test/repo.git",
                "test/repo",
            );
            assert!(
                result.is_err(),
                "unsafe {mode} tracking mapping was used: {result:?}"
            );
            assert_eq!(
                git_stdout(&fixture.client, &["rev-parse", "victim"], None).unwrap(),
                before.head_oid.unwrap()
            );
            assert_eq!(snapshot(&fixture.client).unwrap().branch, before.branch);
            assert_eq!(
                git_stdout(
                    &fixture.client,
                    &["for-each-ref", "refs/openkiwi/fetched-pull"],
                    None
                )
                .unwrap(),
                ""
            );
            fs::remove_dir_all(fixture.root).unwrap();
        }
    }

    #[test]
    fn pull_preserves_a_tracking_ref_changed_while_fetching() {
        let fixture = remote_fixture();
        configure_pull(&fixture);
        fs::write(fixture.seed.join("file.txt"), "remote update\n").unwrap();
        advance_pull(&fixture);
        let before = snapshot(&fixture.client).unwrap();
        let concurrent =
            git_stdout(&fixture.client, &["rev-parse", "origin/release/v2"], None).unwrap();
        let hook = fixture.client.join(".git/hooks/reference-transaction");
        fs::write(&hook, format!("#!/bin/sh\nif test \"$1\" = committed; then\nwhile read old new ref; do\ncase \"$ref\" in refs/openkiwi/fetched-pull/*) git update-ref refs/remotes/origin/main {concurrent} ;; esac\ndone\nfi\n")).unwrap();
        enable_test_hook(&hook);
        let result = pull_sync(
            fixture.client.to_str().unwrap(),
            before.head_oid.as_deref().unwrap(),
            before.branch.as_deref().unwrap(),
            "https://github.com/test/repo.git",
            "test/repo",
        );
        assert!(result.unwrap_err().contains("Nothing was merged"));
        assert_eq!(
            git_stdout(&fixture.client, &["rev-parse", "origin/main"], None).unwrap(),
            concurrent
        );
        assert_eq!(snapshot(&fixture.client).unwrap().head_oid, before.head_oid);
        assert_eq!(snapshot(&fixture.client).unwrap().branch, before.branch);
        assert_restored_from_head(&fixture.client, "file.txt");
        fs::remove_dir_all(fixture.root).unwrap();
    }

    #[test]
    fn pull_rechecks_checkout_and_upstream_after_fetch() {
        for action in [
            "git config branch.topic/local.merge refs/heads/release/v2",
            "git symbolic-ref HEAD refs/heads/main",
        ] {
            let fixture = remote_fixture();
            configure_pull(&fixture);
            fs::write(fixture.seed.join("file.txt"), "remote update\n").unwrap();
            advance_pull(&fixture);
            let before = snapshot(&fixture.client).unwrap();
            let hook = fixture.client.join(".git/hooks/reference-transaction");
            fs::write(&hook, format!("#!/bin/sh\nif test \"$1\" = committed; then\nwhile read old new ref; do\ncase \"$ref\" in refs/openkiwi/fetched-pull/*) {action} ;; esac\ndone\nfi\n")).unwrap();
            enable_test_hook(&hook);
            let result = pull_sync(
                fixture.client.to_str().unwrap(),
                before.head_oid.as_deref().unwrap(),
                before.branch.as_deref().unwrap(),
                "https://github.com/test/repo.git",
                "test/repo",
            );
            assert!(
                result.is_err(),
                "a fetch hook changed the pull binding: {result:?}"
            );
            assert_eq!(
                git_stdout(
                    &fixture.client,
                    &["rev-parse", "refs/heads/topic/local"],
                    None
                )
                .unwrap(),
                before.head_oid.unwrap()
            );
            assert_restored_from_head(&fixture.client, "file.txt");
            assert_eq!(
                git_stdout(
                    &fixture.client,
                    &["for-each-ref", "refs/openkiwi/fetched-pull"],
                    None
                )
                .unwrap(),
                ""
            );
            fs::remove_dir_all(fixture.root).unwrap();
        }
    }

    #[test]
    fn pull_refuses_missing_upstream_dirty_or_stale_checkout_before_fetch() {
        let fixture = remote_fixture();
        let before = snapshot(&fixture.client).unwrap();
        let invoke = || {
            pull_sync(
                fixture.client.to_str().unwrap(),
                before.head_oid.as_deref().unwrap(),
                before.branch.as_deref().unwrap(),
                "https://github.com/test/repo.git",
                "test/repo",
            )
        };
        assert!(invoke().unwrap_err().contains("no origin upstream"));
        configure_pull(&fixture);
        fs::write(fixture.client.join("file.txt"), "local working change\n").unwrap();
        assert!(invoke().unwrap_err().contains("working changes"));
        git_stdout(&fixture.client, &["restore", "file.txt"], None).unwrap();
        git_stdout(&fixture.client, &["checkout", "main"], None).unwrap();
        assert!(invoke().unwrap_err().contains("changed since"));
        assert_eq!(
            git_stdout(
                &fixture.client,
                &["for-each-ref", "refs/openkiwi/fetched-pull"],
                None
            )
            .unwrap(),
            ""
        );
        fs::remove_dir_all(fixture.root).unwrap();
    }

    #[test]
    fn push_refuses_symbolic_tracking_refs_without_rewriting_local_branches() {
        let fixture = remote_fixture();
        let before = git_stdout(&fixture.client, &["rev-parse", "HEAD"], None).unwrap();
        git_stdout(&fixture.client, &["branch", "victim"], None).unwrap();
        fs::write(fixture.client.join("file.txt"), "intended change\n").unwrap();
        let committed =
            commit_sync(fixture.client.to_str().unwrap(), "next", false, None, None).unwrap();
        git_stdout(
            &fixture.client,
            &[
                "symbolic-ref",
                "refs/remotes/origin/topic/local",
                "refs/heads/victim",
            ],
            None,
        )
        .unwrap();
        let result = push_sync(
            fixture.client.to_str().unwrap(),
            &committed.head_oid,
            committed.branch.as_deref().unwrap(),
            "https://github.com/test/repo.git",
            "test/repo",
        );
        assert!(
            result.is_err(),
            "symbolic tracking target was rewritten: {result:?}"
        );
        assert_eq!(
            git_stdout(&fixture.client, &["rev-parse", "victim"], None).unwrap(),
            before
        );
        assert_eq!(
            git_stdout(
                &fixture.client,
                &["symbolic-ref", "refs/remotes/origin/topic/local"],
                None
            )
            .unwrap(),
            "refs/heads/victim"
        );
        assert!(optional_git_stdout(
            &fixture.bare,
            &["rev-parse", "--verify", "refs/heads/topic/local"]
        )
        .is_none());
        fs::remove_dir_all(fixture.root).unwrap();
    }

    #[test]
    fn push_preserves_a_tracking_ref_changed_while_the_network_command_runs() {
        let fixture = remote_fixture();
        let before = git_stdout(&fixture.client, &["rev-parse", "HEAD"], None).unwrap();
        let concurrent =
            git_stdout(&fixture.client, &["rev-parse", "origin/release/v2"], None).unwrap();
        let tracking = "refs/remotes/origin/topic/local";
        git_stdout(&fixture.client, &["update-ref", tracking, &before], None).unwrap();
        fs::write(fixture.client.join("file.txt"), "intended change\n").unwrap();
        let committed =
            commit_sync(fixture.client.to_str().unwrap(), "next", false, None, None).unwrap();
        let hook = fixture.client.join(".git/hooks/pre-push");
        fs::write(
            &hook,
            format!("#!/bin/sh\ngit update-ref {tracking} {concurrent}\n"),
        )
        .unwrap();
        enable_test_hook(&hook);
        let result = push_sync(
            fixture.client.to_str().unwrap(),
            &committed.head_oid,
            committed.branch.as_deref().unwrap(),
            "https://github.com/test/repo.git",
            "test/repo",
        );
        assert!(result.unwrap_err().contains("commit was pushed"));
        assert_eq!(
            git_stdout(&fixture.client, &["rev-parse", tracking], None).unwrap(),
            concurrent
        );
        assert_eq!(
            git_stdout(
                &fixture.bare,
                &["rev-parse", "refs/heads/topic/local"],
                None
            )
            .unwrap(),
            committed.head_oid
        );
        assert_eq!(
            snapshot(&fixture.client).unwrap().head_oid.as_deref(),
            Some(committed.head_oid.as_str())
        );
        fs::remove_dir_all(fixture.root).unwrap();
    }

    #[tokio::test]
    async fn push_creates_only_the_captured_branch_and_records_its_upstream() {
        let fixture = remote_fixture();
        fs::write(fixture.client.join("file.txt"), "intended topic\n").unwrap();
        let committed = commit_sync(
            fixture.client.to_str().unwrap(),
            "intended topic",
            false,
            None,
            None,
        )
        .unwrap();
        git_stdout(
            &fixture.client,
            &[
                "-c",
                "user.name=Test",
                "-c",
                "user.email=test@example.com",
                "tag",
                "-a",
                "local-only",
                "-m",
                "local tag",
            ],
            None,
        )
        .unwrap();
        git_stdout(
            &fixture.client,
            &["config", "push.followTags", "true"],
            None,
        )
        .unwrap();
        git_stdout(
            &fixture.client,
            &["config", "remote.origin.push", "+HEAD:refs/heads/main"],
            None,
        )
        .unwrap();
        let main_before =
            git_stdout(&fixture.bare, &["rev-parse", "refs/heads/main"], None).unwrap();
        let result = git_workspace_push(
            fixture.client.to_string_lossy().into_owned(),
            committed.head_oid.clone(),
            committed.branch.unwrap(),
            "https://github.com/test/repo.git".into(),
            "test/repo".into(),
        )
        .await
        .unwrap();
        assert!(result.stdout.contains("refs/heads/topic/local"));
        assert_eq!(
            git_stdout(
                &fixture.bare,
                &["rev-parse", "refs/heads/topic/local"],
                None
            )
            .unwrap(),
            committed.head_oid
        );
        assert_eq!(
            git_stdout(
                &fixture.client,
                &["rev-parse", "refs/remotes/origin/topic/local"],
                None
            )
            .unwrap(),
            committed.head_oid
        );
        assert_eq!(
            git_stdout(
                &fixture.client,
                &["rev-parse", "--abbrev-ref", "@{upstream}"],
                None
            )
            .unwrap(),
            "origin/topic/local"
        );
        assert_eq!(
            git_stdout(&fixture.bare, &["rev-parse", "refs/heads/main"], None).unwrap(),
            main_before
        );
        assert_eq!(
            git_stdout(&fixture.bare, &["tag", "--list"], None).unwrap(),
            ""
        );
        fs::remove_dir_all(fixture.root).unwrap();
    }

    #[test]
    fn push_uses_the_configured_origin_upstream_branch() {
        let fixture = remote_fixture();
        git_stdout(
            &fixture.client,
            &["merge", "--ff-only", "origin/release/v2"],
            None,
        )
        .unwrap();
        git_stdout(
            &fixture.client,
            &["config", "branch.topic/local.remote", "origin"],
            None,
        )
        .unwrap();
        git_stdout(
            &fixture.client,
            &[
                "config",
                "branch.topic/local.merge",
                "refs/heads/release/v2",
            ],
            None,
        )
        .unwrap();
        fs::write(fixture.client.join("release.txt"), "topic release update\n").unwrap();
        let committed = commit_sync(
            fixture.client.to_str().unwrap(),
            "release update",
            false,
            None,
            None,
        )
        .unwrap();
        push_sync(
            fixture.client.to_str().unwrap(),
            &committed.head_oid,
            "topic/local",
            "https://github.com/test/repo.git",
            "test/repo",
        )
        .unwrap();
        assert_eq!(
            git_stdout(&fixture.bare, &["rev-parse", "refs/heads/release/v2"], None).unwrap(),
            committed.head_oid
        );
        assert!(run_git(
            &fixture.bare,
            &["show-ref", "--verify", "refs/heads/topic/local"],
            None
        )
        .unwrap()
        .status
        .code()
        .is_some_and(|code| code != 0));
        assert_eq!(
            git_stdout(
                &fixture.client,
                &["rev-parse", "--abbrev-ref", "@{upstream}"],
                None
            )
            .unwrap(),
            "origin/release/v2"
        );
        fs::remove_dir_all(fixture.root).unwrap();
    }

    #[test]
    fn push_refuses_remote_retargeting_multiple_urls_and_other_upstreams() {
        let fixture = remote_fixture();
        let head = snapshot(&fixture.client).unwrap().head_oid.unwrap();
        let rewrite = format!("url.file://{}.insteadOf", fixture.bare.to_string_lossy());
        git_stdout(
            &fixture.client,
            &[
                "config",
                "--add",
                &rewrite,
                "https://github.com/test/other.git",
            ],
            None,
        )
        .unwrap();
        git_stdout(
            &fixture.client,
            &[
                "remote",
                "set-url",
                "origin",
                "https://github.com/test/other.git",
            ],
            None,
        )
        .unwrap();
        let error = push_sync(
            fixture.client.to_str().unwrap(),
            &head,
            "topic/local",
            "https://github.com/test/repo.git",
            "test/repo",
        )
        .unwrap_err();
        assert!(error.contains("remote changed"));
        git_stdout(
            &fixture.client,
            &[
                "remote",
                "set-url",
                "origin",
                "https://github.com/test/repo.git",
            ],
            None,
        )
        .unwrap();
        git_stdout(
            &fixture.client,
            &[
                "config",
                "remote.origin.pushurl",
                "https://github.com/test/other.git",
            ],
            None,
        )
        .unwrap();
        let error = push_sync(
            fixture.client.to_str().unwrap(),
            &head,
            "topic/local",
            "https://github.com/test/repo.git",
            "test/repo",
        )
        .unwrap_err();
        assert!(error.contains("exactly one push URL"));
        git_stdout(
            &fixture.client,
            &[
                "config",
                "remote.origin.pushurl",
                "https://github.com/test/repo.git",
            ],
            None,
        )
        .unwrap();
        git_stdout(
            &fixture.client,
            &[
                "config",
                "--add",
                "remote.origin.pushurl",
                "https://github.com/test/repo.git",
            ],
            None,
        )
        .unwrap();
        let error = push_sync(
            fixture.client.to_str().unwrap(),
            &head,
            "topic/local",
            "https://github.com/test/repo.git",
            "test/repo",
        )
        .unwrap_err();
        assert!(error.contains("exactly one push URL"));
        git_stdout(
            &fixture.client,
            &["config", "--unset-all", "remote.origin.pushurl"],
            None,
        )
        .unwrap();
        git_stdout(
            &fixture.client,
            &["config", "branch.topic/local.remote", "elsewhere"],
            None,
        )
        .unwrap();
        git_stdout(
            &fixture.client,
            &[
                "config",
                "branch.topic/local.merge",
                "refs/heads/topic/local",
            ],
            None,
        )
        .unwrap();
        let error = push_sync(
            fixture.client.to_str().unwrap(),
            &head,
            "topic/local",
            "https://github.com/test/repo.git",
            "test/repo",
        )
        .unwrap_err();
        assert!(error.contains("upstream must point to origin"));
        assert!(run_git(
            &fixture.bare,
            &["show-ref", "--verify", "refs/heads/topic/local"],
            None
        )
        .unwrap()
        .status
        .code()
        .is_some_and(|code| code != 0));
        fs::remove_dir_all(fixture.root).unwrap();
    }

    #[test]
    fn rejected_push_keeps_local_commit_and_does_not_force_the_remote() {
        let fixture = remote_fixture();
        git_stdout(
            &fixture.client,
            &["config", "branch.topic/local.remote", "origin"],
            None,
        )
        .unwrap();
        git_stdout(
            &fixture.client,
            &["config", "branch.topic/local.merge", "refs/heads/main"],
            None,
        )
        .unwrap();
        fs::write(fixture.client.join("file.txt"), "local commit\n").unwrap();
        let committed = commit_sync(
            fixture.client.to_str().unwrap(),
            "local commit",
            false,
            None,
            None,
        )
        .unwrap();
        git_stdout(&fixture.seed, &["checkout", "main"], None).unwrap();
        fs::write(fixture.seed.join("file.txt"), "remote commit\n").unwrap();
        let remote = commit_sync(
            fixture.seed.to_str().unwrap(),
            "remote commit",
            false,
            None,
            None,
        )
        .unwrap();
        git_stdout(&fixture.seed, &["push", "origin", "main"], None).unwrap();
        let error = push_sync(
            fixture.client.to_str().unwrap(),
            &committed.head_oid,
            "topic/local",
            "https://github.com/test/repo.git",
            "test/repo",
        )
        .unwrap_err();
        assert!(error.contains("rejected"), "{error}");
        assert_eq!(
            snapshot(&fixture.client).unwrap().head_oid.as_deref(),
            Some(committed.head_oid.as_str())
        );
        assert_eq!(snapshot(&fixture.client).unwrap().changed_files, 0);
        assert_eq!(
            git_stdout(&fixture.bare, &["rev-parse", "refs/heads/main"], None).unwrap(),
            remote.head_oid
        );
        fs::remove_dir_all(fixture.root).unwrap();
    }

    #[test]
    fn nested_project_mutations_preserve_the_enclosing_repository() {
        let fixture = remote_fixture();
        let nested = fixture.client.join("nested-project");
        fs::create_dir_all(&nested).unwrap();
        fs::write(fixture.client.join("file.txt"), "outside selected folder\n").unwrap();
        let before = snapshot(&fixture.client).unwrap();
        let staged = stage_sync(nested.to_str().unwrap(), None, false, None, None);
        let committed = commit_sync(nested.to_str().unwrap(), "nested commit", false, None, None);
        let pushed = push_sync(
            nested.to_str().unwrap(),
            before.head_oid.as_deref().unwrap(),
            before.branch.as_deref().unwrap(),
            "https://github.com/test/repo.git",
            "test/repo",
        );
        let after = snapshot(&fixture.client).unwrap();
        fs::remove_dir_all(fixture.root).unwrap();
        assert!(
            staged.is_err(),
            "nested staging must not stage the parent repository"
        );
        assert!(
            committed.is_err(),
            "nested commits must not commit the parent repository"
        );
        assert!(
            pushed.is_err(),
            "nested pushes must not publish the parent repository"
        );
        assert_eq!(after.head_oid, before.head_oid);
        assert_eq!(after.staged_files, 0);
    }

    #[test]
    fn nested_project_branch_and_update_cannot_mutate_the_enclosing_repository() {
        let fixture = remote_fixture();
        let nested = fixture.client.join("nested-project");
        fs::create_dir(&nested).unwrap();
        let before = snapshot(&fixture.client).unwrap();
        let branched = branch_sync(
            nested.to_str().unwrap(),
            "nested-unintended",
            true,
            before.head_oid.as_deref().unwrap(),
            before.branch.as_deref().unwrap(),
        );
        let after_branch = snapshot(&fixture.client).unwrap();
        git_stdout(
            &fixture.client,
            &["checkout", before.branch.as_deref().unwrap()],
            None,
        )
        .unwrap();
        let updated = update_sync(
            nested.to_str().unwrap(),
            "test/repo",
            "main",
            before.head_oid.as_deref().unwrap(),
            before.branch.as_deref().unwrap(),
        );
        let after_update = snapshot(&fixture.client).unwrap();
        fs::remove_dir_all(fixture.root).unwrap();
        assert!(
            branched.is_err(),
            "nested branch creation changed the enclosing repository"
        );
        assert_eq!(after_branch.branch, before.branch);
        assert!(
            updated.is_err(),
            "nested base update changed the enclosing checkout"
        );
        assert_eq!(after_update.branch, before.branch);
        assert_eq!(after_update.head_oid, before.head_oid);
    }

    #[cfg(unix)]
    #[test]
    fn local_git_timeout_stops_a_hook_and_preserves_the_index_and_worktree() {
        use std::os::unix::fs::PermissionsExt;

        let path = fixture();
        git_stdout(&path, &["config", "user.name", "Test"], None).unwrap();
        git_stdout(&path, &["config", "user.email", "test@example.com"], None).unwrap();
        fs::write(path.join("file.txt"), "staged\n").unwrap();
        git_stdout(&path, &["add", "file.txt"], None).unwrap();
        let before = snapshot(&path).unwrap();
        let hook = path.join(".git/hooks/pre-commit");
        fs::write(&hook, "#!/bin/sh\nsleep 0.3\n").unwrap();
        let mut permissions = fs::metadata(&hook).unwrap().permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&hook, permissions).unwrap();
        let result = local_git_with_options(
            &path,
            &["commit", "-m", "timed out"],
            Duration::from_millis(75),
            1024,
        );
        let after = snapshot(&path).unwrap();
        let contents = fs::read_to_string(path.join("file.txt")).unwrap();
        let staged = git_stdout(&path, &["show", ":file.txt"], None).unwrap();
        fs::remove_dir_all(path).unwrap();
        assert!(
            result.is_err(),
            "the hanging hook exceeded the local Git timeout"
        );
        assert!(result.unwrap_err().contains("timed out"));
        assert_eq!(after.head_oid, before.head_oid);
        assert_eq!(after.staged_files, 1);
        assert_eq!(contents, "staged\n");
        assert_eq!(staged, "staged");
    }

    #[test]
    fn commit_timeout_after_post_commit_reports_the_changed_head_without_claiming_success() {
        let path = fixture();
        let before = snapshot(&path).unwrap();
        fs::write(path.join("file.txt"), "saved before timeout\n").unwrap();
        git_stdout(&path, &["add", "--", "file.txt"], None).unwrap();
        let hook = path.join(".git/hooks/post-commit");
        fs::write(&hook, "#!/bin/sh\nsleep 2\n").unwrap();
        enable_test_hook(&hook);

        let error = commit_sync_with_timeout(
            path.to_str().unwrap(),
            "saved before timeout",
            true,
            before.head_oid.as_deref(),
            before.branch.as_deref(),
            Duration::from_millis(750),
        )
        .unwrap_err();
        let after = snapshot(&path).unwrap();
        assert_ne!(after.head_oid, before.head_oid);
        assert!(error.contains("timed out"), "{error}");
        assert!(
            error.contains(after.head_oid.as_deref().unwrap()),
            "{error}"
        );
        assert!(
            error.contains("A commit may already have been saved"),
            "{error}"
        );
        assert_eq!(after.staged_files, 0);
        assert_eq!(
            fs::read_to_string(path.join("file.txt")).unwrap(),
            "saved before timeout\n"
        );
        fs::remove_dir_all(path).unwrap();
    }

    #[test]
    fn commit_post_hook_branch_switch_does_not_return_another_branch_as_the_saved_commit() {
        let path = fixture();
        let before = snapshot(&path).unwrap();
        git_stdout(&path, &["branch", "other"], None).unwrap();
        fs::write(path.join("file.txt"), "saved on original branch\n").unwrap();
        let hook = path.join(".git/hooks/post-commit");
        fs::write(&hook, "#!/bin/sh\ngit checkout other\n").unwrap();
        enable_test_hook(&hook);

        let result = commit_sync(
            path.to_str().unwrap(),
            "saved on original branch",
            false,
            before.head_oid.as_deref(),
            before.branch.as_deref(),
        );
        assert_eq!(snapshot(&path).unwrap().branch.as_deref(), Some("other"));
        assert_ne!(
            git_stdout(
                &path,
                &["rev-parse", before.branch.as_deref().unwrap()],
                None
            )
            .unwrap(),
            before.head_oid.unwrap()
        );
        assert!(
            result.is_err(),
            "a commit result for the other branch could push the wrong branch: {result:?}"
        );
        let error = result.unwrap_err();
        assert!(error.contains("branch changed"), "{error}");
        assert!(
            error.contains("A commit may already have been saved"),
            "{error}"
        );
        fs::remove_dir_all(path).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn successful_commit_with_truncated_output_still_reports_success() {
        use std::os::unix::fs::PermissionsExt;

        let path = fixture();
        git_stdout(&path, &["config", "user.name", "Test"], None).unwrap();
        git_stdout(&path, &["config", "user.email", "test@example.com"], None).unwrap();
        fs::write(path.join("file.txt"), "staged\n").unwrap();
        git_stdout(&path, &["add", "file.txt"], None).unwrap();
        let hook = path.join(".git/hooks/pre-commit");
        fs::write(
            &hook,
            "#!/bin/sh\ndd if=/dev/zero bs=1024 count=2 2>/dev/null | tr '\\0' x >&2\n",
        )
        .unwrap();
        let mut permissions = fs::metadata(&hook).unwrap().permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&hook, permissions).unwrap();
        let result = local_git_with_options(
            &path,
            &["commit", "-m", "noisy successful hook"],
            Duration::from_secs(5),
            64,
        )
        .unwrap();
        assert!(result.stderr.contains("Git output was truncated"));
        assert_eq!(
            git_stdout(&path, &["log", "-1", "--format=%s"], None).unwrap(),
            "noisy successful hook"
        );
        assert_eq!(snapshot(&path).unwrap().changed_files, 0);
        fs::remove_dir_all(path).unwrap();
    }

    #[test]
    fn snapshot_counts_staged_and_unstaged_paths() {
        let path = fixture();
        fs::write(path.join("file.txt"), "two\n").unwrap();
        fs::write(path.join("new.txt"), "new\n").unwrap();
        git_stdout(&path, &["add", "file.txt"], None).unwrap();
        let value = snapshot(&path).unwrap();
        assert_eq!(value.changed_files, 2);
        assert_eq!(value.staged_files, 1);
        assert_eq!(value.unstaged_files, 1);
        assert_eq!(value.staged_paths, vec!["file.txt"]);
        fs::remove_dir_all(path).unwrap();
    }

    #[tokio::test]
    async fn snapshot_marks_nested_selections_as_not_root_and_blocks_branch_mutation() {
        let path = fixture();
        let nested = path.join("nested-project");
        fs::create_dir_all(&nested).unwrap();
        let root = git_workspace_snapshot(path.to_string_lossy().into_owned())
            .await
            .unwrap();
        let nested_value = git_workspace_snapshot(nested.to_string_lossy().into_owned())
            .await
            .unwrap();
        assert!(root.is_root);
        assert!(!nested_value.is_root);
        assert_eq!(root.root_path, nested_value.root_path);
        let error = git_workspace_branch(
            nested.to_string_lossy().into_owned(),
            "topic/nested".into(),
            true,
            root.head_oid.clone().unwrap(),
            root.branch.clone().unwrap(),
        )
        .await
        .unwrap_err();
        assert!(error.contains("repository root"));
        let after = snapshot(&path).unwrap();
        assert_eq!(after.head_oid, root.head_oid);
        assert_eq!(after.branch, root.branch);
        fs::remove_dir_all(path).unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn snapshot_treats_a_symlink_alias_of_the_repository_as_root() {
        let path = fixture();
        let alias = path.with_file_name(format!("mythra-root-alias-{}", uuid::Uuid::new_v4()));
        std::os::unix::fs::symlink(&path, &alias).unwrap();
        let value = git_workspace_snapshot(alias.to_string_lossy().into_owned())
            .await
            .unwrap();
        assert!(value.is_root);
        assert_eq!(
            PathBuf::from(&value.root_path),
            path.canonicalize().unwrap()
        );
        assert_eq!(serde_json::to_value(value).unwrap()["isRoot"], true);
        fs::remove_file(alias).unwrap();
        fs::remove_dir_all(path).unwrap();
    }

    #[test]
    fn snapshot_preserves_raw_status_columns_and_exact_rename_paths() {
        let path = fixture();
        #[cfg(unix)]
        let unstaged_name = " leading ünicode trailing  ";
        #[cfg(windows)]
        let unstaged_name = " leading ünicode";
        let rename_source = "rename source.txt";
        #[cfg(unix)]
        let rename_target = "renamed 文 trailing  ";
        #[cfg(windows)]
        let rename_target = "renamed 文";
        fs::write(path.join(unstaged_name), "before\n").unwrap();
        fs::write(path.join(rename_source), "rename me\n").unwrap();
        git_stdout(&path, &["add", "--", unstaged_name, rename_source], None).unwrap();
        git_stdout(
            &path,
            &[
                "-c",
                "user.name=Test",
                "-c",
                "user.email=test@example.com",
                "commit",
                "-m",
                "path fixtures",
            ],
            None,
        )
        .unwrap();

        fs::write(path.join(unstaged_name), "after\n").unwrap();
        git_stdout(&path, &["mv", "--", rename_source, rename_target], None).unwrap();

        let value = snapshot(&path).unwrap();
        assert_eq!(value.changed_files, 2);
        assert_eq!(value.staged_files, 1);
        assert_eq!(value.unstaged_files, 1);
        assert_eq!(value.staged_paths, vec![rename_target]);
        fs::remove_dir_all(path).unwrap();
    }

    #[test]
    fn snapshot_preserves_space_and_unicode_worktree_paths() {
        let path = fixture();
        let linked = path.with_file_name(format!(
            "{} linked ünicode",
            path.file_name().unwrap().to_string_lossy()
        ));
        git_stdout(
            &path,
            &[
                "worktree",
                "add",
                "-b",
                "linked-unicode",
                linked.to_str().unwrap(),
            ],
            None,
        )
        .unwrap();
        let expected = linked.canonicalize().unwrap();
        let value = snapshot(&path).unwrap();
        let actual = value
            .branches
            .iter()
            .find(|branch| branch.name == "linked-unicode")
            .and_then(|branch| branch.worktree_path.as_deref())
            .unwrap();
        // Git uses forward slashes while Windows canonicalize returns a
        // verbatim `\\?\` path. Resolve both spellings before comparing the
        // actual location; a damaged Unicode/space path would not resolve.
        assert_eq!(PathBuf::from(actual).canonicalize().unwrap(), expected);
        git_stdout(
            &path,
            &["worktree", "remove", "--force", linked.to_str().unwrap()],
            None,
        )
        .unwrap();
        fs::remove_dir_all(path).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn snapshot_preserves_newline_tab_and_quote_in_worktree_path() {
        let path = fixture();
        let linked = path.with_file_name(format!(
            "{} linked\n\t\"quoted ü",
            path.file_name().unwrap().to_string_lossy()
        ));
        git_stdout(
            &path,
            &[
                "worktree",
                "add",
                "-b",
                "linked-special",
                linked.to_str().unwrap(),
            ],
            None,
        )
        .unwrap();
        let expected = linked.canonicalize().unwrap();
        let value = snapshot(&path).unwrap();
        assert_eq!(
            value
                .branches
                .iter()
                .find(|branch| branch.name == "linked-special")
                .and_then(|branch| branch.worktree_path.as_deref()),
            Some(expected.to_str().unwrap())
        );
        assert!(occupied_elsewhere(&path, "linked-special").unwrap());
        git_stdout(
            &path,
            &["worktree", "remove", "--force", linked.to_str().unwrap()],
            None,
        )
        .unwrap();
        fs::remove_dir_all(path).unwrap();
    }

    #[test]
    fn branch_change_rejects_stale_identity_and_preserves_checkout() {
        let path = fixture();
        let before = snapshot(&path).unwrap();
        let error = branch_sync(
            &path.to_string_lossy(),
            "topic",
            true,
            "stale",
            before.branch.as_deref().unwrap(),
        )
        .unwrap_err();
        assert!(error.contains("changed since"));
        assert_eq!(snapshot(&path).unwrap().branch, before.branch);
        fs::remove_dir_all(path).unwrap();
    }

    #[test]
    fn branch_change_creates_and_switches_without_a_remote() {
        let path = fixture();
        let before = snapshot(&path).unwrap();
        let created = branch_sync(
            &path.to_string_lossy(),
            "topic/local-only",
            true,
            before.head_oid.as_deref().unwrap(),
            before.branch.as_deref().unwrap(),
        )
        .unwrap();
        assert_eq!(created.branch.as_deref(), Some("topic/local-only"));
        assert!(created
            .branches
            .iter()
            .any(|branch| branch.name == "topic/local-only" && branch.current));
        fs::remove_dir_all(path).unwrap();
    }

    #[test]
    fn branch_change_refuses_to_overwrite_ignored_destination() {
        let path = fixture();
        let original_branch = snapshot(&path).unwrap().branch.unwrap();
        git_stdout(&path, &["checkout", "-b", "topic/ignored"], None).unwrap();
        fs::write(path.join("private.txt"), "committed destination\n").unwrap();
        commit_sync(path.to_str().unwrap(), "destination", false, None, None).unwrap();
        git_stdout(&path, &["checkout", &original_branch], None).unwrap();
        fs::write(path.join(".git/info/exclude"), "private.txt\n").unwrap();
        fs::write(path.join("private.txt"), "unique ignored contents\n").unwrap();
        let before = snapshot(&path).unwrap();
        assert_eq!(before.changed_files, 0);
        let index_before = fs::read(path.join(".git/index")).unwrap();
        let result = branch_sync(
            path.to_str().unwrap(),
            "topic/ignored",
            false,
            before.head_oid.as_deref().unwrap(),
            &original_branch,
        );
        assert!(
            result.is_err(),
            "ignored contents were overwritten: {result:?}"
        );
        assert_eq!(
            fs::read(path.join("private.txt")).unwrap(),
            b"unique ignored contents\n"
        );
        assert_eq!(fs::read(path.join(".git/index")).unwrap(), index_before);
        assert_eq!(snapshot(&path).unwrap().branch, before.branch);
        assert_eq!(snapshot(&path).unwrap().head_oid, before.head_oid);
        fs::remove_dir_all(path).unwrap();
    }

    #[test]
    fn update_refuses_to_overwrite_ignored_destination_during_checkout_or_merge() {
        for mode in ["missing", "existing", "selected"] {
            let fixture = remote_fixture();
            if mode != "missing" {
                git_stdout(
                    &fixture.client,
                    &["branch", "release/v2", "origin/release/v2"],
                    None,
                )
                .unwrap();
            }
            if mode == "selected" {
                git_stdout(&fixture.client, &["checkout", "release/v2"], None).unwrap();
            }
            fs::write(fixture.seed.join("private.txt"), "committed destination\n").unwrap();
            advance_release(&fixture, "release with private path\n");
            if mode == "existing" {
                git_stdout(&fixture.client, &["fetch", "origin"], None).unwrap();
                let target =
                    git_stdout(&fixture.client, &["rev-parse", "origin/release/v2"], None).unwrap();
                git_stdout(
                    &fixture.client,
                    &["update-ref", "refs/heads/release/v2", &target],
                    None,
                )
                .unwrap();
            }
            fs::write(fixture.client.join(".git/info/exclude"), "private.txt\n").unwrap();
            fs::write(
                fixture.client.join("private.txt"),
                "unique ignored contents\n",
            )
            .unwrap();
            let before = snapshot(&fixture.client).unwrap();
            assert_eq!(before.changed_files, 0);
            let index_before = fs::read(fixture.client.join(".git/index")).unwrap();
            let branches_before = git_stdout(
                &fixture.client,
                &[
                    "for-each-ref",
                    "--format=%(refname) %(objectname)",
                    "refs/heads",
                ],
                None,
            )
            .unwrap();
            let result = update_sync(
                fixture.client.to_str().unwrap(),
                "test/repo",
                "release/v2",
                before.head_oid.as_deref().unwrap(),
                before.branch.as_deref().unwrap(),
            );
            assert!(
                result.is_err(),
                "{mode}: ignored contents were overwritten: {result:?}"
            );
            assert_eq!(
                fs::read(fixture.client.join("private.txt")).unwrap(),
                b"unique ignored contents\n",
                "{mode}"
            );
            assert_eq!(
                fs::read(fixture.client.join(".git/index")).unwrap(),
                index_before,
                "{mode}"
            );
            assert_eq!(
                snapshot(&fixture.client).unwrap().branch,
                before.branch,
                "{mode}"
            );
            assert_eq!(
                snapshot(&fixture.client).unwrap().head_oid,
                before.head_oid,
                "{mode}"
            );
            assert_eq!(
                git_stdout(
                    &fixture.client,
                    &[
                        "for-each-ref",
                        "--format=%(refname) %(objectname)",
                        "refs/heads"
                    ],
                    None
                )
                .unwrap(),
                branches_before,
                "{mode}"
            );
            fs::remove_dir_all(fixture.root).unwrap();
        }
    }

    #[tokio::test]
    async fn linked_worktrees_share_repository_lock() {
        let path = fixture();
        let worktree = path.with_extension("linked");
        git_stdout(
            &path,
            &[
                "worktree",
                "add",
                "-b",
                "linked",
                worktree.to_str().unwrap(),
            ],
            None,
        )
        .unwrap();
        let a = repository_lock(&path).await.unwrap();
        let b = repository_lock(&worktree).await.unwrap();
        assert!(Arc::ptr_eq(&a, &b));
        git_stdout(
            &path,
            &["worktree", "remove", "--force", worktree.to_str().unwrap()],
            None,
        )
        .unwrap();
        fs::remove_dir_all(path).unwrap();
    }

    #[tokio::test]
    async fn update_command_fetches_custom_base_and_fast_forwards_to_verified_target() {
        let fixture = remote_fixture();
        let remote_head = advance_release(&fixture, "release two\n");
        let before = snapshot(&fixture.client).unwrap();
        let updated = git_workspace_update(
            fixture.client.to_string_lossy().into_owned(),
            "test/repo".into(),
            "release/v2".into(),
            before.head_oid.unwrap(),
            before.branch.unwrap(),
        )
        .await
        .unwrap();
        assert_eq!(updated.branch.as_deref(), Some("release/v2"));
        assert_eq!(updated.head_oid.as_deref(), Some(remote_head.as_str()));
        fs::remove_dir_all(fixture.root).unwrap();
    }

    #[test]
    fn update_refuses_a_successful_checkout_hook_that_selects_another_branch() {
        let fixture = remote_fixture();
        let before = snapshot(&fixture.client).unwrap();
        let other_before = before.head_oid.clone().unwrap();
        git_stdout(&fixture.client, &["branch", "other"], None).unwrap();
        git_stdout(
            &fixture.client,
            &["branch", "release/v2", "refs/remotes/origin/release/v2"],
            None,
        )
        .unwrap();
        let base_before = git_stdout(
            &fixture.client,
            &["rev-parse", "refs/heads/release/v2"],
            None,
        )
        .unwrap();
        advance_release(&fixture, "new release\n");
        let hook = fixture.client.join(".git/hooks/post-checkout");
        fs::write(&hook, "#!/bin/sh\nif [ \"$(git symbolic-ref --short HEAD)\" = release/v2 ]; then git checkout other; fi\n").unwrap();
        enable_test_hook(&hook);
        let result = update_sync(
            fixture.client.to_str().unwrap(),
            "test/repo",
            "release/v2",
            before.head_oid.as_deref().unwrap(),
            before.branch.as_deref().unwrap(),
        );
        assert!(
            result.is_err(),
            "a checkout hook retargeted the update: {result:?}"
        );
        assert_eq!(
            git_stdout(&fixture.client, &["rev-parse", "refs/heads/other"], None).unwrap(),
            other_before
        );
        assert_eq!(
            git_stdout(
                &fixture.client,
                &["rev-parse", "refs/heads/release/v2"],
                None
            )
            .unwrap(),
            base_before
        );
        fs::remove_dir_all(fixture.root).unwrap();
    }

    #[tokio::test]
    async fn update_command_refuses_dirty_divergent_and_occupied_bases_without_switching() {
        // Dirty source checkout.
        let dirty = remote_fixture();
        fs::write(dirty.client.join("dirty.txt"), "dirty\n").unwrap();
        let before = snapshot(&dirty.client).unwrap();
        let error = git_workspace_update(
            dirty.client.to_string_lossy().into_owned(),
            "test/repo".into(),
            "release/v2".into(),
            before.head_oid.unwrap(),
            before.branch.clone().unwrap(),
        )
        .await
        .unwrap_err();
        assert!(error.contains("working changes"));
        assert_eq!(snapshot(&dirty.client).unwrap().branch, before.branch);
        fs::remove_dir_all(dirty.root).unwrap();

        // Diverged local base.
        let divergent = remote_fixture();
        git_stdout(
            &divergent.client,
            &["checkout", "-b", "release/v2", "origin/release/v2"],
            None,
        )
        .unwrap();
        fs::write(divergent.client.join("local.txt"), "local\n").unwrap();
        git_stdout(&divergent.client, &["add", "."], None).unwrap();
        git_stdout(
            &divergent.client,
            &[
                "-c",
                "user.name=Test",
                "-c",
                "user.email=test@example.com",
                "commit",
                "-m",
                "local",
            ],
            None,
        )
        .unwrap();
        git_stdout(&divergent.client, &["checkout", "topic/local"], None).unwrap();
        advance_release(&divergent, "remote divergent\n");
        let before = snapshot(&divergent.client).unwrap();
        let error = git_workspace_update(
            divergent.client.to_string_lossy().into_owned(),
            "test/repo".into(),
            "release/v2".into(),
            before.head_oid.unwrap(),
            before.branch.clone().unwrap(),
        )
        .await
        .unwrap_err();
        assert!(error.contains("diverged"));
        assert_eq!(snapshot(&divergent.client).unwrap().branch, before.branch);
        fs::remove_dir_all(divergent.root).unwrap();

        // Base occupied by another linked worktree.
        let occupied = remote_fixture();
        let occupied_path = occupied.root.join("occupied");
        git_stdout(
            &occupied.client,
            &[
                "worktree",
                "add",
                "-b",
                "release/v2",
                occupied_path.to_str().unwrap(),
                "origin/release/v2",
            ],
            None,
        )
        .unwrap();
        let before = snapshot(&occupied.client).unwrap();
        let error = git_workspace_update(
            occupied.client.to_string_lossy().into_owned(),
            "test/repo".into(),
            "release/v2".into(),
            before.head_oid.unwrap(),
            before.branch.clone().unwrap(),
        )
        .await
        .unwrap_err();
        assert!(error.contains("another worktree"));
        assert_eq!(snapshot(&occupied.client).unwrap().branch, before.branch);
        git_stdout(
            &occupied.client,
            &[
                "worktree",
                "remove",
                "--force",
                occupied_path.to_str().unwrap(),
            ],
            None,
        )
        .unwrap();
        fs::remove_dir_all(occupied.root).unwrap();
    }

    #[tokio::test]
    async fn update_command_preserves_checkout_on_fetch_failure_and_stale_identity() {
        let fixture = remote_fixture();
        let before = snapshot(&fixture.client).unwrap();
        let rewrite = format!("url.file://{}.insteadOf", fixture.bare.to_string_lossy());
        git_stdout(&fixture.client, &["config", "--unset-all", &rewrite], None).unwrap();
        let missing = fixture.root.join("missing.git");
        let broken_rewrite = format!("url.file://{}.insteadOf", missing.to_string_lossy());
        git_stdout(
            &fixture.client,
            &[
                "config",
                &broken_rewrite,
                "https://github.com/test/repo.git",
            ],
            None,
        )
        .unwrap();
        let error = git_workspace_update(
            fixture.client.to_string_lossy().into_owned(),
            "test/repo".into(),
            "release/v2".into(),
            before.head_oid.clone().unwrap(),
            before.branch.clone().unwrap(),
        )
        .await
        .unwrap_err();
        assert!(!error.is_empty());
        assert_eq!(snapshot(&fixture.client).unwrap().branch, before.branch);

        let error = git_workspace_update(
            fixture.client.to_string_lossy().into_owned(),
            "test/repo".into(),
            "release/v2".into(),
            "0000000000000000000000000000000000000000".into(),
            before.branch.clone().unwrap(),
        )
        .await
        .unwrap_err();
        assert!(error.contains("changed since"));
        assert_eq!(snapshot(&fixture.client).unwrap().branch, before.branch);
        fs::remove_dir_all(fixture.root).unwrap();
    }

    #[cfg(unix)]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn update_command_rechecks_identity_after_fetch_before_switching() {
        use std::os::unix::fs::PermissionsExt;

        let fixture = remote_fixture();
        let before = snapshot(&fixture.client).unwrap();
        let upload_pack = fixture.root.join("slow-upload-pack.sh");
        let marker = fixture.root.join("fetch-started");
        let gate = fixture.root.join("fetch-release");
        fs::write(
            &upload_pack,
            format!(
                "#!/bin/sh\ntouch \"{}\"\nwhile [ ! -f \"{}\" ]; do sleep 0.01; done\nexec git-upload-pack \"$@\"\n",
                marker.display(),
                gate.display(),
            ),
        )
        .unwrap();
        let mut permissions = fs::metadata(&upload_pack).unwrap().permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&upload_pack, permissions).unwrap();
        git_stdout(
            &fixture.client,
            &[
                "config",
                "remote.origin.uploadpack",
                upload_pack.to_str().unwrap(),
            ],
            None,
        )
        .unwrap();

        let cwd = fixture.client.to_string_lossy().into_owned();
        let task = tokio::spawn(git_workspace_update(
            cwd,
            "test/repo".into(),
            "release/v2".into(),
            before.head_oid.unwrap(),
            before.branch.unwrap(),
        ));
        let started = tokio::time::timeout(Duration::from_secs(5), async {
            while !marker.exists() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await;
        // Simulate another Git client changing the checkout while network I/O
        // is in flight. The post-fetch guard must observe and preserve it.
        let checkout = if started.is_ok() {
            git_stdout(&fixture.client, &["checkout", "main"], None)
        } else {
            Err("the fixture Git fetch did not start".into())
        };
        // Release the child even if the fixture checkout failed, so a test
        // assertion never leaves an in-flight Git command behind.
        fs::write(&gate, "release").unwrap();
        checkout.unwrap();
        let error = task.await.unwrap().unwrap_err();
        assert!(error.contains("changed since"));
        assert_eq!(
            snapshot(&fixture.client).unwrap().branch.as_deref(),
            Some("main")
        );
        fs::remove_dir_all(fixture.root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn bounded_git_drains_large_output_without_waiting_for_pipe_capacity() {
        use std::os::unix::fs::PermissionsExt;

        let fixture = remote_fixture();
        let upload_pack = fixture.root.join("noisy-upload-pack.sh");
        fs::write(
            &upload_pack,
            "#!/bin/sh\ndd if=/dev/zero bs=1024 count=80 2>/dev/null | tr '\\0' x >&2\nexec git-upload-pack \"$@\"\n",
        )
        .unwrap();
        let mut permissions = fs::metadata(&upload_pack).unwrap().permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&upload_pack, permissions).unwrap();
        git_stdout(
            &fixture.client,
            &[
                "config",
                "remote.origin.uploadpack",
                upload_pack.to_str().unwrap(),
            ],
            None,
        )
        .unwrap();

        let started = Instant::now();
        let error = bounded_git(
            &fixture.client,
            &["fetch", "--no-tags", "origin", "refs/heads/main"],
        )
        .unwrap_err();
        assert!(error.contains("too much network output"));
        assert!(started.elapsed() < Duration::from_secs(10));
        fs::remove_dir_all(fixture.root).unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn update_command_rolls_back_when_checkout_hook_fails_after_switch() {
        use std::os::unix::fs::PermissionsExt;

        let fixture = remote_fixture();
        let before = snapshot(&fixture.client).unwrap();
        let hook = fixture.client.join(".git/hooks/post-checkout");
        fs::write(&hook, "#!/bin/sh\nexit 1\n").unwrap();
        let mut permissions = fs::metadata(&hook).unwrap().permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&hook, permissions).unwrap();
        let error = git_workspace_update(
            fixture.client.to_string_lossy().into_owned(),
            "test/repo".into(),
            "release/v2".into(),
            before.head_oid.unwrap(),
            before.branch.clone().unwrap(),
        )
        .await
        .unwrap_err();
        assert!(!error.is_empty());
        assert_eq!(snapshot(&fixture.client).unwrap().branch, before.branch);
        fs::remove_dir_all(fixture.root).unwrap();
    }
}
