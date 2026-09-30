use std::{
    collections::HashSet,
    env,
    ffi::{OsStr, OsString},
    fs,
    io::Write,
    path::{Path, PathBuf},
    process::Stdio,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::process_launch::background_std_command;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct CheckpointSnapshot {
    pub(super) commit: String,
    pub(super) repo_root: String,
    pub(super) file_count: usize,
    pub(super) branch: Option<String>,
    pub(super) head: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct CheckpointCompleted {
    pub(super) snapshot: CheckpointSnapshot,
    pub(super) changed_files: usize,
    pub(super) additions: usize,
    pub(super) deletions: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct WorkspaceGitInfo {
    pub(super) is_repo: bool,
    pub(super) is_root: bool,
    pub(super) has_commit: bool,
    pub(super) branch: Option<String>,
    pub(super) head: Option<String>,
    pub(super) error: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct WorkspaceGitInitializeResult {
    pub(super) info: WorkspaceGitInfo,
    pub(super) initialized: bool,
    pub(super) created_commit: bool,
    pub(super) tracked_files: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct CreatedWorktree {
    pub(super) path: String,
    pub(super) branch: String,
    pub(super) base_commit: String,
    pub(super) git_dir: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct WorktreeStatus {
    pub(super) head_oid: Option<String>,
    pub(super) source_branch: Option<String>,
    pub(super) exists: bool,
    pub(super) registered: bool,
    pub(super) branch: Option<String>,
    pub(super) base_commit: Option<String>,
    pub(super) changed_files: usize,
    pub(super) untracked_files: usize,
    /// Only the count is reported: the UI shows "N ignored", and a large
    /// build output directory could otherwise serialize tens of thousands of
    /// pathnames across the bridge for a number.
    pub(super) ignored_file_count: usize,
    pub(super) ahead: usize,
    pub(super) behind: usize,
    pub(super) clean: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct WorktreeApplyResult {
    pub(super) changed_files: usize,
    pub(super) additions: usize,
    pub(super) deletions: usize,
    pub(super) isolated_tree: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct WorktreeMergeResult {
    pub(super) isolated_head_oid: String,
    pub(super) source_commit: String,
    pub(super) isolated_tree: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct WorktreeRemoveResult {
    pub(super) folder_removed: bool,
    pub(super) branch_deleted: bool,
    pub(super) retained_branch: Option<String>,
    pub(super) retained_branch_oid: Option<String>,
    pub(super) branch_delete_error: Option<String>,
}

/// A blocking Git worker keeps mutation ownership even if its awaiting command
/// is cancelled. Dropping the outer future must not unlock a running worker.
fn spawn_locked_worktree_worker<T, F>(
    guard: tokio::sync::OwnedMutexGuard<()>,
    worker: F,
) -> tauri::async_runtime::JoinHandle<Result<T, String>>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = guard;
        worker()
    })
}

pub(super) fn unix_timestamp_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(i64::MAX)
}

pub(super) fn validate_checkpoint_id(id: &str) -> Result<(), String> {
    if id.is_empty()
        || id.len() > 80
        || !id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    {
        return Err("Checkpoint identity is invalid".into());
    }
    Ok(())
}

pub(super) fn checkpoint_ref(id: &str, phase: &str) -> Result<String, String> {
    validate_checkpoint_id(id)?;
    if phase != "before" && phase != "after" {
        return Err("Checkpoint phase must be before or after".into());
    }
    Ok(format!("refs/openkiwi/checkpoints/{id}/{phase}"))
}

/// GUI apps on macOS do not inherit the shell PATH. Git itself remains
/// available at `/usr/bin/git`, but filters launched by Git (notably Git LFS
/// installed by Homebrew) then disappear. Preserve every inherited entry and
/// add the native package-manager locations Git filters commonly use.
pub(super) fn git_runtime_path(current: Option<&OsStr>, home: Option<&Path>) -> Option<OsString> {
    let mut directories: Vec<PathBuf> = Vec::new();
    let mut add = |path: PathBuf| {
        if !directories.contains(&path) {
            directories.push(path);
        }
    };
    if let Some(current) = current {
        for directory in env::split_paths(current) {
            add(directory);
        }
    }
    #[cfg(unix)]
    {
        if let Some(home) = home {
            add(home.join(".local/bin"));
            add(home.join(".cargo/bin"));
        }
        for directory in [
            "/opt/homebrew/bin",
            "/opt/homebrew/sbin",
            "/usr/local/bin",
            "/usr/local/sbin",
            "/opt/local/bin",
            "/opt/local/sbin",
            "/usr/bin",
            "/bin",
            "/usr/sbin",
            "/sbin",
        ] {
            add(PathBuf::from(directory));
        }
    }
    #[cfg(windows)]
    for directory in windows_git_runtime_directories(
        env::var_os("ProgramFiles").as_deref().map(Path::new),
        env::var_os("ProgramFiles(x86)").as_deref().map(Path::new),
        env::var_os("LOCALAPPDATA").as_deref().map(Path::new),
        env::var_os("APPDATA").as_deref().map(Path::new),
        home,
    ) {
        add(directory);
    }
    if directories.is_empty() {
        None
    } else {
        env::join_paths(directories).ok()
    }
}

/// Explorer-launched Windows applications can receive a PATH that omits Git
/// even when Git for Windows is installed normally. These are Git's standard
/// per-machine and per-user locations; adding the folders is harmless when a
/// candidate does not exist and lets both native Git features and app-server
/// command execution resolve the same installation.
#[cfg(any(windows, test))]
pub(super) fn windows_git_runtime_directories(
    program_files: Option<&Path>,
    program_files_x86: Option<&Path>,
    local_app_data: Option<&Path>,
    roaming_app_data: Option<&Path>,
    home: Option<&Path>,
) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Some(path) = program_files {
        roots.push(path.join("Git"));
    }
    if let Some(path) = program_files_x86 {
        roots.push(path.join("Git"));
    }
    if let Some(path) = local_app_data {
        roots.push(path.join("Programs").join("Git"));
    } else if let Some(path) = home {
        roots.push(
            path.join("AppData")
                .join("Local")
                .join("Programs")
                .join("Git"),
        );
    }
    if let Some(path) = roaming_app_data {
        // npm installs executable shims here by default. Claude tools often
        // invoke npm/npx or other globally installed CLIs by name.
        roots.push(path.join("npm"));
    }

    roots
        .into_iter()
        .flat_map(|root| {
            if root.file_name().is_some_and(|name| name == "npm") {
                vec![root]
            } else {
                vec![root.join("cmd"), root.join("bin")]
            }
        })
        .collect()
}

pub(super) fn git_command_for(
    cwd: &Path,
    current_path: Option<&OsStr>,
    home: Option<&Path>,
) -> std::process::Command {
    let mut command = background_std_command("git");
    command
        .current_dir(cwd)
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .env_remove("GIT_COMMON_DIR")
        .env_remove("GIT_INDEX_FILE");
    if let Some(path) = git_runtime_path(current_path, home) {
        command.env("PATH", path);
    }
    command
}

fn git_command(cwd: &Path) -> std::process::Command {
    let home = env::var_os("HOME").map(PathBuf::from);
    git_command_for(cwd, env::var_os("PATH").as_deref(), home.as_deref())
}

pub(super) fn run_git(
    cwd: &Path,
    args: &[&str],
    index_file: Option<&Path>,
) -> Result<std::process::Output, String> {
    let mut command = git_command(cwd);
    command.args(args);
    if let Some(index_file) = index_file {
        command.env("GIT_INDEX_FILE", index_file);
    }
    command
        .output()
        .map_err(|error| format!("Could not run Git: {error}"))
}

pub(super) fn run_git_with_input(
    cwd: &Path,
    args: &[&str],
    index_file: Option<&Path>,
    input: &[u8],
) -> Result<std::process::Output, String> {
    let mut command = git_command(cwd);
    command
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(index_file) = index_file {
        command.env("GIT_INDEX_FILE", index_file);
    }
    let mut child = command
        .spawn()
        .map_err(|error| format!("Could not run Git: {error}"))?;
    let mut stdin = child
        .stdin
        .take()
        .ok_or_else(|| "Could not open Git input".to_string())?;
    // Write stdin from a separate thread while the output pipes are drained.
    // Writing everything first can deadlock: Git blocks once its 64KB
    // stdout/stderr pipes fill (for example a chatty failing `git apply`)
    // while this side blocks writing the rest of a large patch.
    let input = input.to_vec();
    let writer = std::thread::spawn(move || stdin.write_all(&input));
    let output = child
        .wait_with_output()
        .map_err(|error| format!("Could not finish Git: {error}"))?;
    let written = writer
        .join()
        .map_err(|_| "Could not send data to Git".to_string())?;
    if let Err(error) = written {
        // A broken pipe is expected when Git fails early; only surface the
        // write error when Git otherwise claims success.
        if output.status.success() {
            return Err(format!("Could not send data to Git: {error}"));
        }
    }
    Ok(output)
}

pub(super) fn git_stdout(
    cwd: &Path,
    args: &[&str],
    index_file: Option<&Path>,
) -> Result<String, String> {
    let output = run_git(cwd, args, index_file)?;
    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if detail.is_empty() {
            format!("Git command failed: git {}", args.join(" "))
        } else {
            detail
        });
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

pub(super) fn checkpoint_repo(cwd: &str) -> Result<PathBuf, String> {
    let selected = PathBuf::from(cwd)
        .canonicalize()
        .map_err(|error| format!("Could not open the project folder: {error}"))?;
    if !selected.is_dir() {
        return Err("Checkpoints require a project folder".into());
    }
    let root = git_stdout(&selected, &["rev-parse", "--show-toplevel"], None)
        .map_err(|_| "Checkpoints require a Git repository".to_string())?;
    let root = PathBuf::from(root)
        .canonicalize()
        .map_err(|error| format!("Could not resolve the Git repository: {error}"))?;
    if !selected.starts_with(&root) {
        return Err("The selected project is outside its Git repository".into());
    }
    if selected != root {
        return Err(
            "Checkpoints currently require the project folder to be the Git repository root".into(),
        );
    }
    Ok(root)
}

pub(super) fn checkpoint_temp_index() -> PathBuf {
    env::temp_dir().join(format!(
        "openkiwi-checkpoint-{}.index",
        uuid::Uuid::new_v4()
    ))
}

pub(super) fn optional_git_stdout(cwd: &Path, args: &[&str]) -> Option<String> {
    git_stdout(cwd, args, None)
        .ok()
        .filter(|value| !value.is_empty())
}

pub(super) fn current_worktree_tree(repo: &Path) -> Result<(String, usize), String> {
    let temp_index = checkpoint_temp_index();
    let result = (|| {
        if optional_git_stdout(repo, &["rev-parse", "--verify", "HEAD"]).is_some() {
            git_stdout(repo, &["read-tree", "HEAD"], Some(&temp_index))?;
        } else {
            git_stdout(repo, &["read-tree", "--empty"], Some(&temp_index))?;
        }
        // A temporary index captures the exact source worktree without
        // changing the user's staged files. Git-ignored paths remain outside
        // the checkpoint so secrets and generated build output are untouched.
        git_stdout(repo, &["add", "-A", "--", "."], Some(&temp_index))?;
        let tree = git_stdout(repo, &["write-tree"], Some(&temp_index))?;
        let files = git_stdout(repo, &["ls-tree", "-r", "--name-only", &tree], None)?;
        Ok((tree, files.lines().filter(|line| !line.is_empty()).count()))
    })();
    let _ = fs::remove_file(&temp_index);
    let _ = fs::remove_file(temp_index.with_extension("index.lock"));
    result
}

pub(super) fn capture_checkpoint_snapshot(
    id: &str,
    cwd: &str,
    phase: &str,
    label: &str,
) -> Result<CheckpointSnapshot, String> {
    let reference = checkpoint_ref(id, phase)?;
    let repo = checkpoint_repo(cwd)?;
    let (tree, file_count) = current_worktree_tree(&repo)?;
    let result = (|| {
        let mut commit = git_command(&repo);
        commit
            .args(["commit-tree", &tree, "-m", label])
            .env("GIT_AUTHOR_NAME", "Mythra Code Checkpoints")
            .env("GIT_AUTHOR_EMAIL", "checkpoints@openkiwi.local")
            .env("GIT_COMMITTER_NAME", "Mythra Code Checkpoints")
            .env("GIT_COMMITTER_EMAIL", "checkpoints@openkiwi.local");
        let output = commit
            .output()
            .map_err(|error| format!("Could not create the checkpoint snapshot: {error}"))?;
        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
        }
        let commit = String::from_utf8_lossy(&output.stdout).trim().to_string();
        git_stdout(&repo, &["update-ref", &reference, &commit], None)?;
        Ok(CheckpointSnapshot {
            commit,
            repo_root: repo.to_string_lossy().into_owned(),
            file_count,
            branch: optional_git_stdout(&repo, &["symbolic-ref", "--short", "-q", "HEAD"]),
            head: optional_git_stdout(&repo, &["rev-parse", "--verify", "HEAD"]),
        })
    })();
    result
}

pub(super) fn checkpoint_diff_stats(
    repo: &Path,
    before: &str,
    after: &str,
) -> Result<(usize, usize, usize), String> {
    let output = git_stdout(repo, &["diff", "--numstat", before, after, "--"], None)?;
    let mut changed_files = 0usize;
    let mut additions = 0usize;
    let mut deletions = 0usize;
    for line in output.lines().filter(|line| !line.trim().is_empty()) {
        let mut parts = line.splitn(3, '\t');
        let added = parts.next().unwrap_or_default();
        let deleted = parts.next().unwrap_or_default();
        if parts.next().is_none() {
            continue;
        }
        changed_files += 1;
        additions = additions.saturating_add(added.parse::<usize>().unwrap_or(0));
        deletions = deletions.saturating_add(deleted.parse::<usize>().unwrap_or(0));
    }
    Ok((changed_files, additions, deletions))
}

pub(super) fn nul_paths(bytes: &[u8]) -> Result<Vec<PathBuf>, String> {
    bytes
        .split(|byte| *byte == 0)
        .filter(|part| !part.is_empty())
        .map(|part| {
            let value = String::from_utf8(part.to_vec())
                .map_err(|_| "Git returned a non-UTF-8 project path".to_string())?;
            let path = PathBuf::from(value);
            if path.is_absolute()
                || path
                    .components()
                    .any(|component| !matches!(component, std::path::Component::Normal(_)))
            {
                return Err("Git returned an unsafe project path".into());
            }
            Ok(path)
        })
        .collect()
}

/// Untracked files the repository's ignore rules exclude, NUL-separated.
pub(super) const IGNORED_FILES_ARGS: &[&str] = &[
    "ls-files",
    "-z",
    "--others",
    "--ignored",
    "--exclude-standard",
];

/// How many paths `args` reports, without materializing any of them. Used
/// where only the count is needed; a generated-output directory can hold far
/// more entries than are worth allocating or sending to the UI.
pub(super) fn git_nul_path_count(cwd: &Path, args: &[&str]) -> Result<usize, String> {
    let output = run_git(cwd, args, None)?;
    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if detail.is_empty() {
            "Could not inspect checkpoint files".into()
        } else {
            detail
        });
    }
    Ok(output
        .stdout
        .split(|byte| *byte == 0)
        .filter(|part| !part.is_empty())
        .count())
}

pub(super) fn git_nul_paths(cwd: &Path, args: &[&str]) -> Result<Vec<PathBuf>, String> {
    let output = run_git(cwd, args, None)?;
    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if detail.is_empty() {
            "Could not inspect checkpoint files".into()
        } else {
            detail
        });
    }
    nul_paths(&output.stdout)
}

pub(super) fn remove_checkpoint_path(repo: &Path, relative: &Path) -> Result<(), String> {
    let mut ancestor = repo.to_path_buf();
    if let Some(parent) = relative.parent() {
        for component in parent.components() {
            ancestor.push(component.as_os_str());
            let Ok(metadata) = fs::symlink_metadata(&ancestor) else {
                continue;
            };
            if metadata.file_type().is_symlink() {
                return Err(format!(
                    "Checkpoint restore stopped because {} is a symbolic-link directory",
                    ancestor.strip_prefix(repo).unwrap_or(&ancestor).display()
                ));
            }
            if !metadata.is_dir() {
                return Err(format!(
                    "Checkpoint restore stopped because {} is not a directory",
                    ancestor.strip_prefix(repo).unwrap_or(&ancestor).display()
                ));
            }
        }
    }
    let target = repo.join(relative);
    let Ok(metadata) = fs::symlink_metadata(&target) else {
        return Ok(());
    };
    if metadata.is_dir() {
        return Err(format!(
            "Checkpoint restore cannot replace the nested repository or directory at {}",
            relative.display()
        ));
    }
    fs::remove_file(&target)
        .map_err(|error| format!("Could not restore {}: {error}", relative.display()))?;
    let mut parent = target.parent();
    while let Some(directory) = parent {
        if directory == repo {
            break;
        }
        if fs::remove_dir(directory).is_err() {
            break;
        }
        parent = directory.parent();
    }
    Ok(())
}

pub(super) fn verify_target_ancestors(
    repo: &Path,
    target_paths: &[PathBuf],
    removable_paths: &HashSet<PathBuf>,
) -> Result<(), String> {
    for target in target_paths {
        let Some(parent) = target.parent() else {
            continue;
        };
        let mut relative_ancestor = PathBuf::new();
        for component in parent.components() {
            relative_ancestor.push(component.as_os_str());
            let absolute = repo.join(&relative_ancestor);
            let Ok(metadata) = fs::symlink_metadata(&absolute) else {
                continue;
            };
            if (metadata.file_type().is_symlink() || !metadata.is_dir())
                && !removable_paths.contains(&relative_ancestor)
            {
                return Err(format!(
                    "Checkpoint restore cannot safely replace {} because it may contain ignored or external files",
                    relative_ancestor.display()
                ));
            }
        }
    }
    Ok(())
}

pub(super) fn verify_target_leaves(
    repo: &Path,
    target_paths: &[PathBuf],
    captured_current_paths: &HashSet<PathBuf>,
    removable_paths: &HashSet<PathBuf>,
) -> Result<(), String> {
    for target in target_paths {
        if target
            .ancestors()
            .skip(1)
            .any(|ancestor| !ancestor.as_os_str().is_empty() && removable_paths.contains(ancestor))
        {
            continue;
        }
        let Ok(metadata) = fs::symlink_metadata(repo.join(target)) else {
            continue;
        };
        // A normal directory can be a structural remnant of captured source
        // files and is handled by the removal pass. A file or symlink absent
        // from the safety tree is ignored under the current repository rules,
        // so overwriting it would break the "ignored files are untouched"
        // guarantee and would not be recoverable from the safety checkpoint.
        if !metadata.is_dir() && !captured_current_paths.contains(target) {
            return Err(format!(
                "Checkpoint restore cannot overwrite the ignored file at {}",
                target.display()
            ));
        }
    }
    Ok(())
}

pub(super) fn materialize_worktree_tree(
    repo: &Path,
    current_tree: &str,
    target_tree: &str,
) -> Result<usize, String> {
    // Applying a patch can take long enough for an editor or another process
    // to change the source after the caller's initial safety check. Verify
    // again at the materialization boundary before removing or overwriting
    // any path.
    let (observed_tree, _) = current_worktree_tree(repo)?;
    if observed_tree != current_tree {
        return Err(
            "The project changed after its safety checkpoint was created; no files were applied"
                .into(),
        );
    }
    // The verified safety tree is the authoritative list of current,
    // non-ignored source paths. Removing from this list (rather than using
    // `git clean`) preserves ignored neighbors inside otherwise-untracked
    // directories and also describes the real worktree rather than the user's
    // potentially-stale index.
    let current_paths = git_nul_paths(repo, &["ls-tree", "-r", "-z", "--name-only", current_tree])?;
    let target_paths = git_nul_paths(repo, &["ls-tree", "-r", "-z", "--name-only", target_tree])?;
    let captured_current_set = current_paths.iter().cloned().collect::<HashSet<_>>();
    let target_set = target_paths.iter().cloned().collect::<HashSet<_>>();
    let mut removed = current_paths
        .into_iter()
        .filter(|path| !target_set.contains(path))
        .collect::<Vec<_>>();
    let removable_set = removed.iter().cloned().collect::<HashSet<_>>();
    verify_target_ancestors(repo, &target_paths, &removable_set)?;
    verify_target_leaves(repo, &target_paths, &captured_current_set, &removable_set)?;
    removed.sort_by_key(|path| std::cmp::Reverse(path.components().count()));
    for path in &removed {
        remove_checkpoint_path(repo, path)?;
    }
    // Re-check immediately before checkout. This prevents a filesystem race
    // or an ignored symlink from redirecting Git writes outside the project.
    verify_target_ancestors(repo, &target_paths, &HashSet::new())?;
    verify_target_leaves(repo, &target_paths, &captured_current_set, &HashSet::new())?;

    let temp_index = checkpoint_temp_index();
    let result = (|| {
        git_stdout(repo, &["read-tree", target_tree], Some(&temp_index))?;
        git_stdout(
            repo,
            &["checkout-index", "--all", "--force"],
            Some(&temp_index),
        )?;
        Ok(target_paths.len())
    })();
    let _ = fs::remove_file(&temp_index);
    let _ = fs::remove_file(temp_index.with_extension("index.lock"));
    result
}

pub(super) fn restore_checkpoint_snapshot(
    id: &str,
    cwd: &str,
    phase: &str,
    safety_id: &str,
) -> Result<CheckpointSnapshot, String> {
    let reference = checkpoint_ref(id, phase)?;
    let safety_reference = checkpoint_ref(safety_id, "after")?;
    let repo = checkpoint_repo(cwd)?;
    let commit = git_stdout(
        &repo,
        &["rev-parse", "--verify", &format!("{reference}^{{commit}}")],
        None,
    )
    .map_err(|_| "That checkpoint snapshot is no longer available".to_string())?;
    let target_tree = git_stdout(
        &repo,
        &["rev-parse", "--verify", &format!("{commit}^{{tree}}")],
        None,
    )?;
    let safety_tree = git_stdout(
        &repo,
        &[
            "rev-parse",
            "--verify",
            &format!("{safety_reference}^{{tree}}"),
        ],
        None,
    )
    .map_err(|_| "A current safety checkpoint is required before restoring".to_string())?;
    let (current_tree, _) = current_worktree_tree(&repo)?;
    if current_tree != safety_tree {
        return Err(
            "The project changed after its safety checkpoint was created; save a new safety checkpoint and try again"
                .into(),
        );
    }
    let file_count = materialize_worktree_tree(&repo, &safety_tree, &target_tree)?;
    Ok(CheckpointSnapshot {
        commit,
        repo_root: repo.to_string_lossy().into_owned(),
        file_count,
        branch: optional_git_stdout(&repo, &["symbolic-ref", "--short", "-q", "HEAD"]),
        head: optional_git_stdout(&repo, &["rev-parse", "--verify", "HEAD"]),
    })
}

#[tauri::command]
pub(super) async fn checkpoint_create(
    id: String,
    cwd: String,
    label: String,
) -> Result<CheckpointSnapshot, String> {
    tauri::async_runtime::spawn_blocking(move || {
        capture_checkpoint_snapshot(&id, &cwd, "before", &label)
    })
    .await
    .map_err(|error| format!("Checkpoint task failed: {error}"))?
}

#[tauri::command]
pub(super) async fn checkpoint_complete(
    id: String,
    cwd: String,
    label: String,
) -> Result<CheckpointCompleted, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let snapshot = capture_checkpoint_snapshot(&id, &cwd, "after", &label)?;
        let before = checkpoint_ref(&id, "before")?;
        let after = checkpoint_ref(&id, "after")?;
        let (changed_files, additions, deletions) =
            checkpoint_diff_stats(Path::new(&snapshot.repo_root), &before, &after)?;
        Ok(CheckpointCompleted {
            snapshot,
            changed_files,
            additions,
            deletions,
        })
    })
    .await
    .map_err(|error| format!("Checkpoint completion task failed: {error}"))?
}

#[tauri::command]
pub(super) async fn checkpoint_diff(id: String, cwd: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let repo = checkpoint_repo(&cwd)?;
        let before = checkpoint_ref(&id, "before")?;
        let after = checkpoint_ref(&id, "after")?;
        git_stdout(
            &repo,
            &["diff", "--no-ext-diff", &before, &after, "--"],
            None,
        )
    })
    .await
    .map_err(|error| format!("Checkpoint diff task failed: {error}"))?
}

#[tauri::command]
pub(super) async fn checkpoint_restore(
    id: String,
    cwd: String,
    target: String,
    safety_id: String,
) -> Result<CheckpointSnapshot, String> {
    tauri::async_runtime::spawn_blocking(move || {
        restore_checkpoint_snapshot(&id, &cwd, &target, &safety_id)
    })
    .await
    .map_err(|error| format!("Checkpoint restore task failed: {error}"))?
}

#[tauri::command]
pub(super) async fn checkpoint_delete(id: String, cwd: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let repo = checkpoint_repo(&cwd)?;
        for phase in ["before", "after"] {
            let reference = checkpoint_ref(&id, phase)?;
            git_stdout(&repo, &["update-ref", "-d", &reference], None)?;
        }
        Ok(())
    })
    .await
    .map_err(|error| format!("Checkpoint deletion task failed: {error}"))?
}

pub(super) fn git_common_dir(repo: &Path) -> Result<PathBuf, String> {
    let value = git_stdout(repo, &["rev-parse", "--git-common-dir"], None)?;
    let path = PathBuf::from(value);
    let resolved = if path.is_absolute() {
        path
    } else {
        repo.join(path)
    };
    resolved
        .canonicalize()
        .map_err(|error| format!("Could not resolve the shared Git directory: {error}"))
}

pub(super) fn verify_linked_worktree(source: &Path, worktree: &Path) -> Result<(), String> {
    if git_common_dir(source)? != git_common_dir(worktree)? {
        return Err("That worktree does not belong to the selected project".into());
    }
    Ok(())
}

pub(super) fn worktree_label_slug(label: &str) -> String {
    let mut slug = String::new();
    let mut last_dash = false;
    for character in label.chars().flat_map(char::to_lowercase) {
        if character.is_ascii_alphanumeric() {
            slug.push(character);
            last_dash = false;
        } else if !last_dash && !slug.is_empty() {
            slug.push('-');
            last_dash = true;
        }
        if slug.len() >= 28 {
            break;
        }
    }
    let slug = slug.trim_matches('-');
    if slug.is_empty() {
        "thread".into()
    } else {
        slug.into()
    }
}

pub(super) fn is_managed_worktree_branch(branch: &str) -> bool {
    branch.starts_with("mythra/") || branch.starts_with("openkiwi/")
}

pub(super) fn verify_managed_worktree_branch(worktree: &Path, branch: &str) -> Result<(), String> {
    if !is_managed_worktree_branch(branch) {
        return Err("That branch is not managed by Mythra Code".into());
    }
    git_stdout(worktree, &["check-ref-format", "--branch", branch], None)?;
    let actual = git_stdout(worktree, &["symbolic-ref", "--short", "-q", "HEAD"], None)
        .map_err(|_| "The isolated worktree is not on a branch".to_string())?;
    if actual != branch {
        return Err("The isolated worktree no longer has its recorded branch checked out".into());
    }
    Ok(())
}

pub(super) fn worktree_applied_ref(thread_id: &str) -> Result<String, String> {
    validate_checkpoint_id(thread_id)?;
    Ok(format!("refs/openkiwi/worktrees/{thread_id}/applied"))
}

pub(super) fn set_worktree_applied_baseline_sync(
    project_path: &str,
    thread_id: &str,
    baseline: &str,
) -> Result<String, String> {
    let source = checkpoint_repo(project_path)?;
    let tree = git_stdout(
        &source,
        &["rev-parse", "--verify", &format!("{baseline}^{{tree}}")],
        None,
    )
    .map_err(|_| "The saved worktree baseline is no longer available".to_string())?;
    let reference = worktree_applied_ref(thread_id)?;
    git_stdout(&source, &["update-ref", &reference, &tree], None)?;
    Ok(tree)
}

pub(super) fn checkpoint_safety_tree(repo: &Path, safety_id: &str) -> Result<String, String> {
    let safety_reference = checkpoint_ref(safety_id, "after")?;
    git_stdout(
        repo,
        &[
            "rev-parse",
            "--verify",
            &format!("{safety_reference}^{{tree}}"),
        ],
        None,
    )
    .map_err(|_| "A current safety checkpoint is required before changing the project".to_string())
}

pub(super) fn verify_current_safety_tree(repo: &Path, safety_id: &str) -> Result<String, String> {
    let safety_tree = checkpoint_safety_tree(repo, safety_id)?;
    let (current_tree, _) = current_worktree_tree(repo)?;
    if current_tree != safety_tree {
        return Err(
            "The project changed after its safety checkpoint was created; save a new safety checkpoint and try again"
                .into(),
        );
    }
    Ok(safety_tree)
}

pub(super) fn worktree_status_sync(
    project_path: &str,
    worktree_path: &str,
    branch: &str,
    base_commit: &str,
) -> Result<WorktreeStatus, String> {
    let source = checkpoint_repo(project_path)?;
    let path = PathBuf::from(worktree_path);
    if !path.exists() {
        return Ok(WorktreeStatus {
            head_oid: None,
            source_branch: optional_git_stdout(&source, &["symbolic-ref", "--short", "-q", "HEAD"]),
            exists: false,
            registered: false,
            branch: None,
            base_commit: None,
            changed_files: 0,
            untracked_files: 0,
            ignored_file_count: 0,
            ahead: 0,
            behind: 0,
            clean: false,
        });
    }
    let worktree = checkpoint_repo(worktree_path)?;
    verify_linked_worktree(&source, &worktree)?;
    let registered = crate::git_workspace::worktree_paths(&source)?
        .into_iter()
        .any(|listed_path| {
            PathBuf::from(listed_path)
                .canonicalize()
                .map(|path| path == worktree)
                .unwrap_or(false)
        });
    let status = git_stdout(
        &worktree,
        &["status", "--porcelain=v1", "--untracked-files=all"],
        None,
    )?;
    let changed_files = status.lines().filter(|line| !line.is_empty()).count();
    let untracked_files = status.lines().filter(|line| line.starts_with("??")).count();
    let ignored_file_count = git_nul_path_count(&worktree, IGNORED_FILES_ARGS)?;
    let counts = git_stdout(
        &source,
        &[
            "rev-list",
            "--left-right",
            "--count",
            &format!("HEAD...{branch}"),
        ],
        None,
    )
    .unwrap_or_else(|_| "0\t0".into());
    let mut count_parts = counts.split_whitespace();
    let behind = count_parts
        .next()
        .and_then(|value| value.parse().ok())
        .unwrap_or(0);
    let ahead = count_parts
        .next()
        .and_then(|value| value.parse().ok())
        .unwrap_or(0);
    Ok(WorktreeStatus {
        head_oid: optional_git_stdout(&worktree, &["rev-parse", "HEAD"]),
        source_branch: optional_git_stdout(&source, &["symbolic-ref", "--short", "-q", "HEAD"]),
        exists: true,
        registered,
        branch: optional_git_stdout(&worktree, &["symbolic-ref", "--short", "-q", "HEAD"]),
        base_commit: Some(base_commit.into()),
        changed_files,
        untracked_files,
        ignored_file_count,
        ahead,
        behind,
        clean: changed_files == 0,
    })
}

pub(super) fn workspace_git_info_sync(cwd: &str) -> Result<WorkspaceGitInfo, String> {
    let selected = match PathBuf::from(cwd).canonicalize() {
        Ok(path) if path.is_dir() => path,
        Ok(_) => {
            return Ok(WorkspaceGitInfo {
                is_repo: false,
                is_root: false,
                has_commit: false,
                branch: None,
                head: None,
                error: Some("The selected path is not a folder".into()),
            });
        }
        Err(error) => {
            return Ok(WorkspaceGitInfo {
                is_repo: false,
                is_root: false,
                has_commit: false,
                branch: None,
                head: None,
                error: Some(format!("Could not open the project folder: {error}")),
            });
        }
    };
    let root = match git_stdout(&selected, &["rev-parse", "--show-toplevel"], None) {
        Ok(value) => PathBuf::from(value),
        Err(_) => {
            return Ok(WorkspaceGitInfo {
                is_repo: false,
                is_root: false,
                has_commit: false,
                branch: None,
                head: None,
                error: None,
            });
        }
    };
    let root = root.canonicalize().unwrap_or(root);
    let head = optional_git_stdout(&selected, &["rev-parse", "--verify", "HEAD"]);
    Ok(WorkspaceGitInfo {
        is_repo: true,
        is_root: selected == root,
        has_commit: head.is_some(),
        branch: optional_git_stdout(&selected, &["symbolic-ref", "--short", "-q", "HEAD"]),
        head,
        error: None,
    })
}

pub(super) fn initialize_workspace_git_sync(
    cwd: &str,
) -> Result<WorkspaceGitInitializeResult, String> {
    let selected = PathBuf::from(cwd)
        .canonicalize()
        .map_err(|error| format!("Could not open the project folder: {error}"))?;
    if !selected.is_dir() {
        return Err("Git can only be initialized inside a project folder".into());
    }

    let before = workspace_git_info_sync(cwd)?;
    if before.is_repo && !before.is_root {
        return Err(
            "This project is inside another Git repository. Open that repository's root folder to use isolated worktrees."
                .into(),
        );
    }
    if before.has_commit {
        let tracked_files = git_stdout(&selected, &["ls-files"], None)?
            .lines()
            .filter(|line| !line.is_empty())
            .count();
        return Ok(WorkspaceGitInitializeResult {
            info: before,
            initialized: false,
            created_commit: false,
            tracked_files,
        });
    }

    let initialized = !before.is_repo;
    if initialized {
        git_stdout(&selected, &["init"], None)
            .map_err(|error| format!("Could not initialize the Git repository: {error}"))?;
    }

    // The initial snapshot deliberately follows the project's .gitignore.
    // A local command identity avoids changing or depending on global Git
    // configuration, and --allow-empty keeps empty project folders eligible
    // for worktrees.
    git_stdout(&selected, &["add", "-A", "--", "."], None).map_err(|error| {
        format!("Git was initialized, but the project snapshot could not be staged: {error}")
    })?;
    git_stdout(
        &selected,
        &[
            "-c",
            "user.name=Mythra Code",
            "-c",
            "user.email=openkiwi@local",
            "commit",
            "--allow-empty",
            "-m",
            "Initial project snapshot",
        ],
        None,
    )
    .map_err(|error| {
        format!(
            "Git was initialized, but the initial project snapshot could not be created: {error}"
        )
    })?;

    let info = workspace_git_info_sync(cwd)?;
    if !info.is_repo || !info.is_root || !info.has_commit {
        return Err(
            "Git initialized, but the repository is not ready for isolated worktrees".into(),
        );
    }
    let tracked_files = git_stdout(&selected, &["ls-files"], None)?
        .lines()
        .filter(|line| !line.is_empty())
        .count();
    Ok(WorkspaceGitInitializeResult {
        info,
        initialized,
        created_commit: true,
        tracked_files,
    })
}

#[tauri::command]
pub(super) async fn workspace_git_info(cwd: String) -> Result<WorkspaceGitInfo, String> {
    tauri::async_runtime::spawn_blocking(move || workspace_git_info_sync(&cwd))
        .await
        .map_err(|error| format!("Git inspection task failed: {error}"))?
}

#[tauri::command]
pub(super) async fn workspace_git_initialize(
    cwd: String,
) -> Result<WorkspaceGitInitializeResult, String> {
    tauri::async_runtime::spawn_blocking(move || initialize_workspace_git_sync(&cwd))
        .await
        .map_err(|error| format!("Git initialization task failed: {error}"))?
}

#[tauri::command]
pub(super) async fn worktree_create(
    app: AppHandle,
    project_path: String,
    label: String,
) -> Result<CreatedWorktree, String> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Could not locate Mythra Code's application data: {error}"))?;
    let lock = crate::git_workspace::repository_lock(Path::new(&project_path)).await?;
    let guard = lock.lock_owned().await;
    spawn_locked_worktree_worker(guard, move || {
        let source = checkpoint_repo(&project_path)?;
        let base_commit =
            git_stdout(&source, &["rev-parse", "--verify", "HEAD"], None).map_err(|_| {
                "Isolated worktrees require a repository with at least one commit".to_string()
            })?;
        let suffix = uuid::Uuid::new_v4().simple().to_string()[..8].to_string();
        let slug = worktree_label_slug(&label);
        let branch = format!("mythra/{slug}-{suffix}");
        git_stdout(&source, &["check-ref-format", "--branch", &branch], None)?;
        let project_slug = worktree_label_slug(
            source
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("project"),
        );
        let root = app_data.join("worktrees").join(project_slug);
        fs::create_dir_all(&root).map_err(|error| {
            format!("Could not create the Mythra Code worktree folder: {error}")
        })?;
        let path = root.join(format!("{slug}-{suffix}"));
        let path_string = path.to_string_lossy().into_owned();
        git_stdout(
            &source,
            &["worktree", "add", &path_string, "-b", &branch, &base_commit],
            None,
        )?;
        Ok(CreatedWorktree {
            path: path_string,
            branch,
            base_commit,
            git_dir: git_common_dir(&source)?.to_string_lossy().into_owned(),
        })
    })
    .await
    .map_err(|error| format!("Worktree creation task failed: {error}"))?
}

#[tauri::command]
pub(super) async fn worktree_recreate(
    app: AppHandle,
    project_path: String,
    branch: String,
    label: String,
) -> Result<CreatedWorktree, String> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Could not locate Mythra Code's application data: {error}"))?;
    let lock = crate::git_workspace::repository_lock(Path::new(&project_path)).await?;
    let guard = lock.lock_owned().await;
    spawn_locked_worktree_worker(guard, move || {
        let source = checkpoint_repo(&project_path)?;
        if !is_managed_worktree_branch(&branch) {
            return Err("That branch is not managed by Mythra Code".into());
        }
        git_stdout(&source, &["check-ref-format", "--branch", &branch], None)?;
        let branch_commit = git_stdout(
            &source,
            &[
                "rev-parse",
                "--verify",
                &format!("refs/heads/{branch}^{{commit}}"),
            ],
            None,
        )
        .map_err(|_| "The isolated branch is no longer available".to_string())?;
        let suffix = uuid::Uuid::new_v4().simple().to_string()[..8].to_string();
        let slug = worktree_label_slug(&label);
        let project_slug = worktree_label_slug(
            source
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("project"),
        );
        let root = app_data.join("worktrees").join(project_slug);
        fs::create_dir_all(&root).map_err(|error| {
            format!("Could not create the Mythra Code worktree folder: {error}")
        })?;
        // A worktree folder can be deleted outside Mythra Code while Git still
        // has a stale registration for it. Prune that dead administrative
        // entry before attaching the surviving branch to its replacement.
        let _ = git_stdout(&source, &["worktree", "prune"], None);
        let path = root.join(format!("{slug}-{suffix}"));
        let path_string = path.to_string_lossy().into_owned();
        git_stdout(&source, &["worktree", "add", &path_string, &branch], None)?;
        Ok(CreatedWorktree {
            path: path_string,
            branch,
            base_commit: branch_commit,
            git_dir: git_common_dir(&source)?.to_string_lossy().into_owned(),
        })
    })
    .await
    .map_err(|error| format!("Worktree recreation task failed: {error}"))?
}

#[tauri::command]
pub(super) async fn worktree_status(
    project_path: String,
    worktree_path: String,
    branch: String,
    base_commit: String,
) -> Result<WorktreeStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        worktree_status_sync(&project_path, &worktree_path, &branch, &base_commit)
    })
    .await
    .map_err(|error| format!("Worktree status task failed: {error}"))?
}

pub(super) fn worktree_apply_to_source_sync(
    project_path: &str,
    worktree_path: &str,
    base_commit: &str,
    safety_id: &str,
    pin_reference: Option<&str>,
) -> Result<WorktreeApplyResult, String> {
    let source = checkpoint_repo(project_path)?;
    let worktree = checkpoint_repo(worktree_path)?;
    verify_linked_worktree(&source, &worktree)?;
    git_stdout(
        &source,
        &["rev-parse", "--verify", &format!("{base_commit}^{{tree}}")],
        None,
    )
    .map_err(|_| "The worktree's last applied source state is no longer available".to_string())?;
    let safety_tree = verify_current_safety_tree(&source, safety_id)?;
    let (isolated_tree, _) = current_worktree_tree(&worktree)?;
    let patch = run_git(
        &worktree,
        &[
            "diff",
            "--binary",
            "--full-index",
            base_commit,
            &isolated_tree,
            "--",
        ],
        None,
    )?;
    if !patch.status.success() {
        return Err(String::from_utf8_lossy(&patch.stderr).trim().to_string());
    }
    let temp_index = checkpoint_temp_index();
    let result = (|| {
        git_stdout(&source, &["read-tree", &safety_tree], Some(&temp_index))?;
        if !patch.stdout.is_empty() {
            let applied = run_git_with_input(
                &source,
                &["apply", "--cached", "--binary", "--whitespace=nowarn", "-"],
                Some(&temp_index),
                &patch.stdout,
            )?;
            if !applied.status.success() {
                let detail = String::from_utf8_lossy(&applied.stderr).trim().to_string();
                return Err(if detail.is_empty() {
                    "The isolated changes conflict with the current project".into()
                } else {
                    detail
                });
            }
        }
        let target_tree = git_stdout(&source, &["write-tree"], Some(&temp_index))?;
        let (changed_files, additions, deletions) =
            checkpoint_diff_stats(&source, &safety_tree, &target_tree)?;
        let previous_pin = pin_reference.and_then(|reference| {
            optional_git_stdout(&source, &["rev-parse", "--verify", reference])
        });
        if let Some(reference) = pin_reference {
            git_stdout(&source, &["update-ref", reference, &isolated_tree], None)?;
        }
        if let Err(error) = materialize_worktree_tree(&source, &safety_tree, &target_tree) {
            if let Some(reference) = pin_reference {
                if let Some(previous) = previous_pin {
                    let _ = git_stdout(&source, &["update-ref", reference, &previous], None);
                } else {
                    let _ = git_stdout(&source, &["update-ref", "-d", reference], None);
                }
            }
            return Err(error);
        }
        Ok(WorktreeApplyResult {
            changed_files,
            additions,
            deletions,
            isolated_tree,
        })
    })();
    let _ = fs::remove_file(&temp_index);
    let _ = fs::remove_file(temp_index.with_extension("index.lock"));
    result
}

#[tauri::command]
pub(super) async fn worktree_apply_to_source(
    thread_id: String,
    project_path: String,
    worktree_path: String,
    base_commit: String,
    safety_id: String,
) -> Result<WorktreeApplyResult, String> {
    let lock = crate::git_workspace::repository_lock(Path::new(&project_path)).await?;
    let guard = lock.lock_owned().await;
    spawn_locked_worktree_worker(guard, move || {
        let source = checkpoint_repo(&project_path)?;
        let reference = worktree_applied_ref(&thread_id)?;
        let effective_base = git_stdout(
            &source,
            &["rev-parse", "--verify", &format!("{reference}^{{tree}}")],
            None,
        )
        .unwrap_or(base_commit);
        worktree_apply_to_source_sync(
            &project_path,
            &worktree_path,
            &effective_base,
            &safety_id,
            Some(&reference),
        )
    })
    .await
    .map_err(|error| format!("Worktree apply task failed: {error}"))?
}

#[tauri::command]
pub(super) async fn worktree_set_applied_baseline(
    thread_id: String,
    project_path: String,
    baseline: String,
) -> Result<String, String> {
    let lock = crate::git_workspace::repository_lock(Path::new(&project_path)).await?;
    let guard = lock.lock_owned().await;
    spawn_locked_worktree_worker(guard, move || {
        set_worktree_applied_baseline_sync(&project_path, &thread_id, &baseline)
    })
    .await
    .map_err(|error| format!("Worktree baseline task failed: {error}"))?
}

pub(super) fn worktree_merge_branch_sync(
    project_path: &str,
    worktree_path: &str,
    branch: &str,
    safety_id: &str,
    pin_reference: Option<&str>,
) -> Result<WorktreeMergeResult, String> {
    let source = checkpoint_repo(project_path)?;
    let worktree = checkpoint_repo(worktree_path)?;
    verify_linked_worktree(&source, &worktree)?;
    verify_managed_worktree_branch(&worktree, branch)?;
    let safety_tree = verify_current_safety_tree(&source, safety_id)?;
    if !git_stdout(
        &source,
        &["status", "--porcelain=v1", "--untracked-files=all"],
        None,
    )?
    .is_empty()
    {
        return Err("Commit or remove the source project's working changes before merging".into());
    }
    if !git_stdout(
        &worktree,
        &["status", "--porcelain=v1", "--untracked-files=all"],
        None,
    )?
    .is_empty()
    {
        return Err("Commit the isolated worktree's changes before merging its branch".into());
    }
    let isolated_head_oid = git_stdout(&worktree, &["rev-parse", "--verify", "HEAD"], None)?;
    let isolated_tree = git_stdout(
        &worktree,
        &[
            "rev-parse",
            "--verify",
            &format!("{isolated_head_oid}^{{tree}}"),
        ],
        None,
    )?;
    let source_head_oid = git_stdout(&source, &["rev-parse", "--verify", "HEAD"], None)?;
    let source_branch = optional_git_stdout(&source, &["symbolic-ref", "--short", "-q", "HEAD"]);
    let branch_merge_options = source_branch.as_ref().and_then(|name| {
        optional_git_stdout(
            &source,
            &[
                "config",
                "--get-all",
                &format!("branch.{name}.mergeOptions"),
            ],
        )
    });
    let configured_strategy =
        optional_git_stdout(&source, &["config", "--get-all", "pull.twohead"]);
    if branch_merge_options.is_some()
        || configured_strategy
            .as_ref()
            .is_some_and(|strategy| strategy != "ort")
    {
        return Err("This repository configures additional merge options or a custom strategy that cannot be safely previewed. Preserve ignored files and merge this branch manually.".into());
    }
    // Ort can derive new destinations from directory renames, and can overwrite
    // ignored files even with --no-overwrite-ignore. Inspect its computed tree,
    // rather than only the incoming branch's original paths. No real checkout
    // or index is changed when this preview reports conflicts or is unavailable.
    let (preview, truncated) = crate::git_workspace::bounded_git_output(
        &source,
        &[
            "merge-tree",
            "--write-tree",
            "--no-messages",
            &source_head_oid,
            &isolated_head_oid,
        ],
        Duration::from_secs(30),
        512 * 1024,
        true,
    )?;
    if !preview.status.success() || truncated {
        let detail = String::from_utf8_lossy(&preview.stderr);
        if preview.status.code() == Some(129) || detail.contains("not a git command") {
            return Err("This Git version cannot safely preview branch merges. Update Git to 2.38 or later, or preserve ignored files and merge the branch manually. Nothing was merged.".into());
        }
        return Err(format!("Git could not safely preview this branch merge, or the merge has conflicts. Nothing was merged. {}", detail.trim()));
    }
    let result_tree = std::str::from_utf8(&preview.stdout)
        .map_err(|_| "Git returned an unreadable merge preview")?
        .trim();
    if !matches!(result_tree.len(), 40 | 64)
        || !result_tree.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return Err("Git returned an invalid merge preview. Nothing was merged.".into());
    }
    let source_paths = git_nul_paths(
        &source,
        &["ls-tree", "-r", "-z", "--name-only", &safety_tree],
    )?;
    let target_paths = git_nul_paths(
        &source,
        &["ls-tree", "-r", "-z", "--name-only", result_tree],
    )?;
    let captured_paths: HashSet<_> = source_paths.iter().cloned().collect();
    let target_set: HashSet<_> = target_paths.iter().cloned().collect();
    let removable_paths: HashSet<_> = source_paths
        .into_iter()
        .filter(|path| !target_set.contains(path))
        .collect();
    verify_target_ancestors(&source, &target_paths, &removable_paths)?;
    verify_target_leaves(&source, &target_paths, &captured_paths, &removable_paths)?;
    // A file destination may replace a directory. Only inspect those specific
    // directories, so unrelated ignored build output never blocks this merge.
    let directory_destinations: Vec<_> = target_paths
        .iter()
        .filter(|path| {
            fs::symlink_metadata(source.join(path)).is_ok_and(|metadata| metadata.is_dir())
        })
        .collect();
    if !directory_destinations.is_empty() {
        let mut args = vec!["--literal-pathspecs"];
        args.extend_from_slice(IGNORED_FILES_ARGS);
        args.push("--");
        for path in &directory_destinations {
            args.push(
                path.to_str()
                    .ok_or("The merge destination is not valid Unicode")?,
            );
        }
        let (ignored, truncated) = crate::git_workspace::bounded_git_output(
            &source,
            &args,
            Duration::from_secs(30),
            512 * 1024,
            true,
        )?;
        if !ignored.status.success() || truncated {
            return Err(
                "Could not safely inspect ignored files at merge destinations. Nothing was merged."
                    .into(),
            );
        }
        if !ignored.stdout.is_empty() {
            return Err("The branch would replace a directory containing ignored files. Preserve those files before merging; nothing was merged.".into());
        }
    }
    verify_current_safety_tree(&source, safety_id)?;
    if optional_git_stdout(&source, &["rev-parse", "--verify", "HEAD"]).as_deref()
        != Some(source_head_oid.as_str())
        || optional_git_stdout(&source, &["symbolic-ref", "--short", "-q", "HEAD"]) != source_branch
        || optional_git_stdout(&worktree, &["rev-parse", "--verify", "HEAD"]).as_deref()
            != Some(isolated_head_oid.as_str())
    {
        return Err("The source or isolated branch changed while its merge was previewed. Nothing was merged; refresh and review the branches.".into());
    }
    if source_branch.as_ref().and_then(|name| {
        optional_git_stdout(
            &source,
            &[
                "config",
                "--get-all",
                &format!("branch.{name}.mergeOptions"),
            ],
        )
    }) != branch_merge_options
        || optional_git_stdout(&source, &["config", "--get-all", "pull.twohead"])
            != configured_strategy
    {
        return Err("The repository's merge options changed while its merge was previewed. Nothing was merged; refresh and inspect the options.".into());
    }
    let previous_pin = pin_reference
        .and_then(|reference| optional_git_stdout(&source, &["rev-parse", "--verify", reference]));
    if let Some(reference) = pin_reference {
        git_stdout(&source, &["update-ref", reference, &isolated_tree], None)?;
    }
    // Mythra Code's initializer does not write a persistent user identity.
    // Preserve the user's configured identity when complete, otherwise use
    // the initializer's command-local identity for this merge commit.
    let configured_identity = optional_git_stdout(&source, &["config", "user.name"])
        .zip(optional_git_stdout(&source, &["config", "user.email"]));
    let merge_args = if configured_identity.is_some() {
        vec![
            "merge",
            "--no-overwrite-ignore",
            "--no-ff",
            "--no-edit",
            isolated_head_oid.as_str(),
        ]
    } else {
        vec![
            "-c",
            "user.name=Mythra Code",
            "-c",
            "user.email=openkiwi@local",
            "merge",
            "--no-overwrite-ignore",
            "--no-ff",
            "--no-edit",
            isolated_head_oid.as_str(),
        ]
    };
    let merge = run_git(&source, &merge_args, None)?;
    if !merge.status.success() {
        let detail = String::from_utf8_lossy(&merge.stderr).trim().to_string();
        let _ = run_git(&source, &["merge", "--abort"], None);
        if let Some(reference) = pin_reference {
            if let Some(previous) = previous_pin {
                let _ = git_stdout(&source, &["update-ref", reference, &previous], None);
            } else {
                let _ = git_stdout(&source, &["update-ref", "-d", reference], None);
            }
        }
        return Err(if detail.is_empty() {
            "The branch could not be merged cleanly".into()
        } else {
            detail
        });
    }
    let source_commit = git_stdout(&source, &["rev-parse", "--verify", "HEAD"], None)?;
    if optional_git_stdout(&source, &["symbolic-ref", "--short", "-q", "HEAD"]) != source_branch
        || !run_git(&source, &["merge-base", "--is-ancestor", &source_head_oid, &source_commit], None)?.status.success()
        || !run_git(&source, &["merge-base", "--is-ancestor", &isolated_head_oid, &source_commit], None)?.status.success()
    {
        return Err("The checkout changed after the merge, possibly from a Git hook. The merge may already be complete; refresh and inspect the branches before continuing.".into());
    }

    Ok(WorktreeMergeResult {
        isolated_head_oid,
        source_commit,
        isolated_tree,
    })
}

#[tauri::command]
pub(super) async fn worktree_merge_branch(
    thread_id: String,
    project_path: String,
    worktree_path: String,
    branch: String,
    safety_id: String,
    expected_source_branch: String,
    expected_source_head_oid: String,
) -> Result<WorktreeMergeResult, String> {
    let lock = crate::git_workspace::repository_lock(Path::new(&project_path)).await?;
    let guard = lock.lock_owned().await;
    spawn_locked_worktree_worker(guard, move || {
        let source = checkpoint_repo(&project_path)?;
        if optional_git_stdout(&source, &["symbolic-ref", "--short", "-q", "HEAD"]).as_deref() != Some(expected_source_branch.as_str())
            || optional_git_stdout(&source, &["rev-parse", "--verify", "HEAD"]).as_deref() != Some(expected_source_head_oid.as_str()) {
            return Err("The shared project changed since the merge confirmation. Review its branch and try again.".into());
        }
        let reference = worktree_applied_ref(&thread_id)?;
        worktree_merge_branch_sync(
            &project_path,
            &worktree_path,
            &branch,
            &safety_id,
            Some(&reference),
        )
    })
    .await
    .map_err(|error| format!("Worktree merge task failed: {error}"))?
}

const WORKTREE_REMOVE_OUTPUT_LIMIT: usize = 512 * 1024;

struct WorktreeRemovalGit {
    deadline: std::cell::Cell<Instant>,
}

impl WorktreeRemovalGit {
    fn remaining(&self) -> Result<Duration, String> {
        let remaining = self
            .deadline
            .get()
            .saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            Err("Git operation timed out".into())
        } else {
            Ok(remaining)
        }
    }

    fn output(&self, repo: &Path, args: &[&str]) -> Result<std::process::Output, String> {
        let (output, truncated) = crate::git_workspace::bounded_git_output(
            repo,
            args,
            self.remaining()?,
            WORKTREE_REMOVE_OUTPUT_LIMIT,
            false,
        )?;
        if truncated {
            return Err("Git produced too much output to safely remove the worktree".into());
        }
        Ok(output)
    }

    fn stdout(&self, repo: &Path, args: &[&str]) -> Result<String, String> {
        let output = self.output(repo, args)?;
        if !output.status.success() {
            let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
            return Err(if detail.is_empty() {
                "Git could not finish worktree cleanup".into()
            } else {
                detail
            });
        }
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    }

    fn optional(&self, repo: &Path, args: &[&str]) -> Result<Option<String>, String> {
        let output = self.output(repo, args)?;
        Ok(output
            .status
            .success()
            .then(|| String::from_utf8_lossy(&output.stdout).trim().to_string()))
    }

    fn repo(&self, path: &str) -> Result<PathBuf, String> {
        let selected = Path::new(path)
            .canonicalize()
            .map_err(|error| format!("Could not open the worktree folder: {error}"))?;
        let root = self.stdout(&selected, &["rev-parse", "--show-toplevel"])?;
        Path::new(&root)
            .canonicalize()
            .map_err(|error| format!("Could not open the Git repository: {error}"))
    }

    fn common_dir(&self, repo: &Path) -> Result<PathBuf, String> {
        let directory = PathBuf::from(self.stdout(repo, &["rev-parse", "--git-common-dir"])?);
        let directory = if directory.is_absolute() {
            directory
        } else {
            repo.join(directory)
        };
        directory
            .canonicalize()
            .map_err(|error| format!("Could not open the common Git directory: {error}"))
    }

    fn require_unoccupied(&self, repo: &Path, branch: &str) -> Result<(), String> {
        let reference = format!("refs/heads/{branch}");
        let output = self.output(repo, &["worktree", "list", "--porcelain", "-z"])?;
        if !output.status.success() {
            return Err("Could not inspect worktree branch ownership".into());
        }
        let mut paths = Vec::new();
        for field in output.stdout.split(|byte| *byte == 0) {
            if let Some(path) = field.strip_prefix(b"worktree ") {
                paths.push(PathBuf::from(String::from_utf8_lossy(path).into_owned()));
            }
            if field
                .strip_prefix(b"branch ")
                .is_some_and(|value| value == reference.as_bytes())
            {
                return Err("The retained branch is checked out in another worktree. Keep it until that worktree is finished.".into());
            }
        }
        // Git also protects detached worktrees whose rebase or bisect owns the
        // branch. Do not replace that protection with only a HEAD-name check.
        for path in paths.into_iter().filter(|path| path.is_dir()) {
            for state in [
                "rebase-merge/head-name",
                "rebase-apply/head-name",
                "BISECT_START",
            ] {
                let state_path =
                    PathBuf::from(self.stdout(&path, &["rev-parse", "--git-path", state])?);
                let state_path = if state_path.is_absolute() {
                    state_path
                } else {
                    path.join(state_path)
                };
                match read_worktree_operation_identity(&state_path) {
                    Ok(value) if value.trim() == reference || value.trim() == branch => return Err(
                        "The retained branch is used by a rebase or bisect in another worktree."
                            .into(),
                    ),
                    Ok(_) => {}
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                    Err(error) => {
                        return Err(format!(
                            "Could not inspect active worktree operations: {error}"
                        ))
                    }
                }
            }
        }
        Ok(())
    }

    fn require_merged(&self, repo: &Path, branch: &str, expected_oid: &str) -> Result<(), String> {
        // Match `git branch -d`: a resolvable upstream is authoritative, even
        // when the branch is merged to HEAD; otherwise Git falls back to HEAD.
        let upstream = self.stdout(
            repo,
            &[
                "for-each-ref",
                "--format=%(upstream)",
                &format!("refs/heads/{branch}"),
            ],
        )?;
        let upstream_oid = if upstream.is_empty() {
            None
        } else {
            self.optional(
                repo,
                &["rev-parse", "--verify", &format!("{upstream}^{{commit}}")],
            )?
        };
        let reference_oid = match upstream_oid {
            Some(oid) => oid,
            None => self.stdout(repo, &["rev-parse", "--verify", "HEAD^{commit}"])?,
        };
        let result = self.output(
            repo,
            &["merge-base", "--is-ancestor", expected_oid, &reference_oid],
        )?;
        if result.status.success() {
            Ok(())
        } else if result.status.code() == Some(1) {
            Err(format!(
                "The branch '{branch}' is not fully merged into {}. Its commits were kept.",
                if upstream.is_empty() {
                    "HEAD"
                } else {
                    upstream.as_str()
                }
            ))
        } else {
            Err("Could not verify whether the isolated branch is fully merged; its commits were kept.".into())
        }
    }
}

fn read_worktree_operation_identity(path: &Path) -> std::io::Result<String> {
    use std::io::Read;
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.share_mode(7).custom_flags(0x00200000);
    }
    let file = options.open(path)?;
    let metadata = file.metadata()?;
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > 4096 {
        return Err(std::io::Error::other(
            "Git operation identity is not a small regular file",
        ));
    }
    let mut value = String::new();
    file.take(4097).read_to_string(&mut value)?;
    if value.len() > 4096 {
        return Err(std::io::Error::other(
            "Git operation identity exceeded its size limit",
        ));
    }
    Ok(value)
}

/// Git's prepared `verify <ref> 0` transaction reserves an absent name while
/// config is removed. A recreated branch must never lose its own configuration.
struct DeletedBranchConfigLease {
    child: std::process::Child,
    scope: crate::git_workspace::GitProcessScope,
    input: Option<std::process::ChildStdin>,
    replies: std::sync::mpsc::Receiver<Result<String, String>>,
    output_done: std::sync::mpsc::Receiver<()>,
    errors_done: std::sync::mpsc::Receiver<()>,
    completed: bool,
}

impl DeletedBranchConfigLease {
    fn prepare(
        git: &WorktreeRemovalGit,
        repo: &Path,
        reference: &str,
        oid_width: usize,
    ) -> Result<Self, String> {
        use std::io::Read;
        git.remaining()?;
        let home = env::var_os("HOME").map(PathBuf::from);
        let mut command = git_command_for(repo, env::var_os("PATH").as_deref(), home.as_deref());
        command
            .args(["update-ref", "--no-deref", "--stdin"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let (mut child, scope) = crate::git_workspace::spawn_scoped_git(&mut command)?;
        let input = child.stdin.take().ok_or_else(|| {
            scope.stop(
                &mut child,
                "Could not open reference transaction input".into(),
            )
        })?;
        let mut output = child.stdout.take().ok_or_else(|| {
            scope.stop(
                &mut child,
                "Could not read reference transaction output".into(),
            )
        })?;
        let mut errors = child.stderr.take().ok_or_else(|| {
            scope.stop(
                &mut child,
                "Could not read reference transaction errors".into(),
            )
        })?;
        let (sender, replies) = std::sync::mpsc::sync_channel(1);
        let (output_done_tx, output_done) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let _completed = output_done_tx;
            let mut line = Vec::new();
            let mut buffer = [0u8; 4096];
            loop {
                match output.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(count) => {
                        for byte in &buffer[..count] {
                            if *byte == b'\n' {
                                if sender
                                    .send(Ok(String::from_utf8_lossy(&line).to_string()))
                                    .is_err()
                                {
                                    return;
                                }
                                line.clear();
                            } else {
                                line.push(*byte);
                                if line.len() > WORKTREE_REMOVE_OUTPUT_LIMIT {
                                    let _ = sender.send(Err(
                                        "Git reference transaction produced too much output".into(),
                                    ));
                                    return;
                                }
                            }
                        }
                    }
                    Err(error) => {
                        let _ = sender.send(Err(format!(
                            "Could not read reference transaction: {error}"
                        )));
                        return;
                    }
                }
            }
        });
        let (errors_done_tx, errors_done) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let _completed = errors_done_tx;
            let mut buffer = [0u8; 4096];
            while matches!(errors.read(&mut buffer), Ok(count) if count > 0) {}
        });
        let mut lease = Self {
            child,
            scope,
            input: Some(input),
            replies,
            output_done,
            errors_done,
            completed: false,
        };
        if let Err(error) = lease.exchange(git, "start\n", "start: ok") {
            return Err(lease.stop_with_reason(error));
        }
        if let Err(error) = lease.exchange(
            git,
            &format!("verify {reference} {}\nprepare\n", "0".repeat(oid_width)),
            "prepare: ok",
        ) {
            return Err(lease.stop_with_reason(error));
        }
        Ok(lease)
    }

    fn exchange(
        &mut self,
        git: &WorktreeRemovalGit,
        command: &str,
        expected: &str,
    ) -> Result<(), String> {
        git.remaining()?;
        let input = self
            .input
            .as_mut()
            .ok_or_else(|| "Reference cleanup input is closed".to_string())?;
        input
            .write_all(command.as_bytes())
            .and_then(|()| input.flush())
            .map_err(|error| format!("Could not finish reference cleanup: {error}"))?;
        let reply = self.replies.recv_timeout(git.remaining()?).map_err(|error| match error {
            std::sync::mpsc::RecvTimeoutError::Timeout => "Git reference cleanup timed out".to_string(),
            std::sync::mpsc::RecvTimeoutError::Disconnected => "The deleted branch was recreated or Git could not reserve its name; configuration was kept".to_string(),
        })??;
        if reply != expected {
            return Err(
                "Git could not safely reserve the deleted branch; configuration was kept".into(),
            );
        }
        Ok(())
    }

    fn finish(&mut self, git: &WorktreeRemovalGit) -> Result<(), String> {
        self.input.take();
        loop {
            match self.child.try_wait() {
                Ok(Some(status)) if status.success() => break,
                Ok(Some(_)) => return Err("Git did not finish reference cleanup".into()),
                Ok(None) => {
                    git.remaining()?;
                    std::thread::sleep(Duration::from_millis(10));
                }
                Err(error) => return Err(format!("Could not wait for reference cleanup: {error}")),
            }
        }
        for done in [&self.output_done, &self.errors_done] {
            if matches!(
                done.recv_timeout(git.remaining()?),
                Err(std::sync::mpsc::RecvTimeoutError::Timeout)
            ) {
                return Err("Git reference cleanup timed out while draining hook output".into());
            }
        }
        self.completed = true;
        Ok(())
    }

    fn stop_with_reason(&mut self, reason: String) -> String {
        let reason = self.scope.stop(&mut self.child, reason);
        self.completed = true;
        reason
    }
}

impl Drop for DeletedBranchConfigLease {
    fn drop(&mut self) {
        if !self.completed {
            self.scope
                .stop(&mut self.child, "Reference cleanup was interrupted".into());
        }
    }
}

#[derive(Clone, Copy)]
enum WorktreeRemovalPhase {
    FolderRemoved,
    BeforeBranchDelete,
    BeforeConfigCleanup,
    ConfigNameReserved,
}

fn delete_worktree_branch(
    git: &WorktreeRemovalGit,
    source: &Path,
    branch: &str,
    expected_oid: &str,
    force: bool,
    deletion_completed: &mut bool,
    gate: &mut impl FnMut(WorktreeRemovalPhase, &WorktreeRemovalGit) -> Result<(), String>,
) -> Result<(), String> {
    let reference = format!("refs/heads/{branch}");
    git.require_unoccupied(source, branch)?;
    if !force {
        git.require_merged(source, branch, expected_oid)?;
    }
    gate(WorktreeRemovalPhase::BeforeBranchDelete, git)?;
    // Bind deletion to the approved tip inside Git's reference transaction;
    // no second resolution of a possibly advanced branch and no force retry.
    git.stdout(
        source,
        &["update-ref", "--no-deref", "-d", &reference, expected_oid],
    )?;
    *deletion_completed = true;
    gate(WorktreeRemovalPhase::BeforeConfigCleanup, git)?;
    let mut lease = DeletedBranchConfigLease::prepare(git, source, &reference, expected_oid.len())?;
    let cleanup = (|| {
        gate(WorktreeRemovalPhase::ConfigNameReserved, git)?;
        let escaped_branch: String = branch
            .chars()
            .flat_map(|character| {
                if ".^$[]()|?*+{}\\".contains(character) {
                    vec!['\\', character]
                } else {
                    vec![character]
                }
            })
            .collect();
        let names = git.output(
            source,
            &[
                "config",
                "--local",
                "--name-only",
                "--get-regexp",
                &format!("^branch\\.{escaped_branch}\\."),
            ],
        )?;
        if names.status.success() {
            git.stdout(
                source,
                &[
                    "config",
                    "--local",
                    "--remove-section",
                    &format!("branch.{branch}"),
                ],
            )?;
        } else if names.status.code() != Some(1) {
            return Err(
                "The branch was deleted, but its configuration could not be inspected".into(),
            );
        }
        lease.exchange(git, "abort\n", "abort: ok")?;
        lease.finish(git)
    })();
    cleanup.map_err(|error| lease.stop_with_reason(error))
}

struct WorktreeRemoveOptions<'a> {
    force: bool,
    delete_branch: bool,
    expected_retained_branch_oid: Option<&'a str>,
    timeout: Duration,
}

fn worktree_remove_sync(
    managed_root: &Path,
    thread_id: Option<&str>,
    project_path: &str,
    worktree_path: &str,
    branch: &str,
    options: WorktreeRemoveOptions<'_>,
) -> Result<WorktreeRemoveResult, String> {
    worktree_remove_sync_with_gate(
        managed_root,
        thread_id,
        project_path,
        worktree_path,
        branch,
        options,
        |_, _| Ok(()),
    )
}

fn worktree_remove_sync_with_gate(
    managed_root: &Path,
    thread_id: Option<&str>,
    project_path: &str,
    worktree_path: &str,
    branch: &str,
    options: WorktreeRemoveOptions<'_>,
    mut gate: impl FnMut(WorktreeRemovalPhase, &WorktreeRemovalGit) -> Result<(), String>,
) -> Result<WorktreeRemoveResult, String> {
    let git = WorktreeRemovalGit {
        deadline: std::cell::Cell::new(Instant::now() + options.timeout),
    };
    let source = git.repo(project_path)?;
    // Validate cleanup identities before doing anything irreversible. A bad
    // checkpoint identity must not be discovered after its folder disappeared.
    let applied_reference = thread_id.map(worktree_applied_ref).transpose()?;
    if !is_managed_worktree_branch(branch) {
        return Err("That branch is not managed by Mythra Code".into());
    }
    git.stdout(&source, &["check-ref-format", "--branch", branch])?;
    let canonical_root = managed_root
        .canonicalize()
        .map_err(|error| format!("Could not open Mythra Code's worktree folder: {error}"))?;
    let path = Path::new(worktree_path);
    if !path.is_absolute()
        || path
            .components()
            .any(|part| matches!(part, std::path::Component::ParentDir))
    {
        return Err("The managed worktree path is invalid".into());
    }
    let folder_exists = match fs::symlink_metadata(path) {
        Ok(_) => true,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
        Err(error) => return Err(format!("Could not inspect the isolated worktree: {error}")),
    };
    let canonical_worktree = if folder_exists {
        path.canonicalize()
    } else {
        path.parent()
            .ok_or_else(|| "The managed worktree path is invalid".to_string())?
            .canonicalize()
            .map(|parent| parent.join(path.file_name().unwrap_or_default()))
    }
    .map_err(|error| format!("Could not open the isolated worktree: {error}"))?;
    if canonical_worktree == canonical_root || !canonical_worktree.starts_with(&canonical_root) {
        return Err(
            "Mythra Code will only remove worktrees it created in its managed folder".into(),
        );
    }
    let branch_reference = format!("refs/heads/{branch}");
    let branch_oid = git.optional(&source, &["rev-parse", "--verify", &branch_reference])?;
    if folder_exists {
        if options.expected_retained_branch_oid.is_some() {
            return Err("The worktree folder exists again. Review it before removing it.".into());
        }
        let worktree = git.repo(worktree_path)?;
        if git.common_dir(&source)? != git.common_dir(&worktree)? {
            return Err("That worktree does not belong to the selected project".into());
        }
        if git.stdout(&worktree, &["symbolic-ref", "--quiet", "HEAD"])? != branch_reference {
            return Err(
                "The isolated worktree no longer has its recorded branch checked out".into(),
            );
        }
        let status = git.stdout(
            &worktree,
            &["status", "--porcelain=v1", "--untracked-files=all"],
        )?;
        let ignored_files = git.output(&worktree, IGNORED_FILES_ARGS)?;
        if !ignored_files.status.success() {
            return Err("Could not inspect ignored worktree files".into());
        }
        if (!status.is_empty() || !ignored_files.stdout.is_empty()) && !options.force {
            return Err(
                "The isolated worktree contains uncommitted, untracked, or ignored files".into(),
            );
        }
        let mut args = vec!["worktree", "remove"];
        if options.force {
            args.push("--force");
        }
        args.push(worktree_path);
        if let Err(error) = git.stdout(&source, &args) {
            if matches!(fs::symlink_metadata(path), Err(error) if error.kind() == std::io::ErrorKind::NotFound)
            {
                return Ok(WorktreeRemoveResult {
                    folder_removed: true,
                    branch_deleted: false,
                    retained_branch: None,
                    retained_branch_oid: None,
                    branch_delete_error: Some(format!("The folder was removed, but Git did not finish its administrative cleanup. Current branch state could not be verified; the last observed tip was {}. Inspect it before retrying: {error}", branch_oid.as_deref().unwrap_or("unavailable"))),
                });
            }
            return Err(error);
        }
    } else {
        let expected_oid = options.expected_retained_branch_oid.ok_or_else(||
            "The worktree folder is missing. Review its retained branch before retrying cleanup.".to_string())?;
        if thread_id.is_none()
            || ![40, 64].contains(&expected_oid.len())
            || !expected_oid.bytes().all(|byte| byte.is_ascii_hexdigit())
        {
            return Err(
                "Retained branch cleanup needs its recorded thread and full commit identity."
                    .into(),
            );
        }
        if !options.delete_branch || options.force {
            return Err("Retained branch cleanup requires safe deletion without force.".into());
        }
        if branch_oid.as_deref().is_some_and(|oid| oid != expected_oid) {
            return Err(
                "The retained branch changed since removal. Review it before deleting it.".into(),
            );
        }
        git.require_unoccupied(&source, branch)?;
    }
    // Folder removal is complete. Never convert a later cleanup failure into a
    // rejected command that suggests the removed folder can still be used.
    let mut branch_delete_error = gate(WorktreeRemovalPhase::FolderRemoved, &git).err();
    let mut branch_state_verified = true;
    let mut retained_branch_oid =
        match git.optional(&source, &["rev-parse", "--verify", &branch_reference]) {
            Ok(oid) => oid,
            Err(error) => {
                branch_state_verified = false;
                branch_delete_error = Some(format!(
                "Current branch state could not be verified; the last observed tip was {}: {error}",
                branch_oid.as_deref().unwrap_or("unavailable")
            ));
                None
            }
        };
    let mut deletion_completed = false;
    if options.delete_branch && retained_branch_oid.is_some() {
        if retained_branch_oid != branch_oid {
            branch_delete_error = Some(
                "The isolated branch changed during removal; its new tip was retained.".into(),
            );
        } else if branch_delete_error.is_none() {
            let expected_oid = retained_branch_oid.as_deref().unwrap();
            let result = delete_worktree_branch(
                &git,
                &source,
                branch,
                expected_oid,
                options.force,
                &mut deletion_completed,
                &mut gate,
            );
            if let Err(error) = result {
                branch_delete_error = Some(error);
            }
            retained_branch_oid = match git
                .optional(&source, &["rev-parse", "--verify", &branch_reference])
            {
                Ok(oid) => oid,
                Err(error) => {
                    branch_state_verified = false;
                    let phase = if deletion_completed {
                        "The approved branch tip was deleted, but current branch state could not be verified"
                    } else {
                        "Branch cleanup could not be verified"
                    };
                    branch_delete_error = Some(format!(
                        "{phase}; the last observed tip was {expected_oid}: {error}. {}",
                        branch_delete_error
                            .as_deref()
                            .unwrap_or("Inspect the branch before retrying.")
                    ));
                    None
                }
            };
        }
    }
    if let Some(reference) = applied_reference {
        if let Err(error) = git.stdout(&source, &["update-ref", "-d", &reference]) {
            branch_delete_error
                .get_or_insert(format!("Checkpoint cleanup did not finish: {error}"));
        }
    }
    if let Err(error) = git.stdout(&source, &["worktree", "prune"]) {
        branch_delete_error.get_or_insert(format!(
            "Worktree registration cleanup did not finish: {error}"
        ));
    }
    Ok(WorktreeRemoveResult {
        folder_removed: true,
        branch_deleted: options.delete_branch
            && branch_state_verified
            && retained_branch_oid.is_none(),
        retained_branch: retained_branch_oid.as_ref().map(|_| branch.to_string()),
        retained_branch_oid,
        branch_delete_error,
    })
}

#[tauri::command]
// Keep the bridge's named arguments compatible; the retained tip is optional
// and only authorizes safe cleanup after a previously completed folder removal.
#[allow(clippy::too_many_arguments)]
pub(super) async fn worktree_remove(
    app: AppHandle,
    thread_id: Option<String>,
    project_path: String,
    worktree_path: String,
    branch: String,
    force: bool,
    delete_branch: bool,
    expected_retained_branch_oid: Option<String>,
) -> Result<WorktreeRemoveResult, String> {
    let managed_root = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Could not locate Mythra Code's application data: {error}"))?
        .join("worktrees");
    let lock = crate::git_workspace::repository_lock(Path::new(&project_path)).await?;
    let guard = lock.lock_owned().await;
    spawn_locked_worktree_worker(guard, move || {
        worktree_remove_sync(
            &managed_root,
            thread_id.as_deref(),
            &project_path,
            &worktree_path,
            &branch,
            WorktreeRemoveOptions {
                force,
                delete_branch,
                expected_retained_branch_oid: expected_retained_branch_oid.as_deref(),
                timeout: Duration::from_secs(120),
            },
        )
    })
    .await
    .map_err(|error| format!("Worktree removal task failed: {error}"))?
}

#[cfg(test)]
mod worktree_lifecycle_tests {
    use super::*;

    struct RemovalFixture {
        root: PathBuf,
        source: PathBuf,
        managed_root: PathBuf,
        isolated: PathBuf,
    }

    impl RemovalFixture {
        fn new() -> Self {
            let root =
                env::temp_dir().join(format!("mythra-worktree-remove-{}", uuid::Uuid::new_v4()));
            let source = root.join("source");
            let managed_root = root.join("worktrees");
            let isolated = managed_root.join("project/isolated");
            fs::create_dir_all(&source).unwrap();
            fs::create_dir_all(isolated.parent().unwrap()).unwrap();
            git_stdout(&source, &["init", "-b", "main"], None).unwrap();
            git_stdout(&source, &["config", "user.name", "Test"], None).unwrap();
            git_stdout(&source, &["config", "user.email", "test@example.com"], None).unwrap();
            fs::write(source.join("file.txt"), "initial\n").unwrap();
            git_stdout(&source, &["add", "--all"], None).unwrap();
            git_stdout(&source, &["commit", "-m", "initial"], None).unwrap();
            git_stdout(
                &source,
                &[
                    "worktree",
                    "add",
                    "-b",
                    "mythra/isolated",
                    isolated.to_str().unwrap(),
                    "HEAD",
                ],
                None,
            )
            .unwrap();
            Self {
                root,
                source,
                managed_root,
                isolated,
            }
        }

        fn remove(&self) -> Result<WorktreeRemoveResult, String> {
            worktree_remove_sync(
                &self.managed_root,
                Some("remove-thread"),
                self.source.to_str().unwrap(),
                self.isolated.to_str().unwrap(),
                "mythra/isolated",
                WorktreeRemoveOptions {
                    force: false,
                    delete_branch: true,
                    expected_retained_branch_oid: None,
                    timeout: Duration::from_secs(120),
                },
            )
        }

        fn cleanup(&self, expected_oid: &str, force: bool) -> Result<WorktreeRemoveResult, String> {
            worktree_remove_sync(
                &self.managed_root,
                Some("remove-thread"),
                self.source.to_str().unwrap(),
                self.isolated.to_str().unwrap(),
                "mythra/isolated",
                WorktreeRemoveOptions {
                    force,
                    delete_branch: true,
                    expected_retained_branch_oid: Some(expected_oid),
                    timeout: Duration::from_secs(120),
                },
            )
        }

        fn merge_with_stale_upstream(&self) -> String {
            let initial = git_stdout(&self.source, &["rev-parse", "HEAD"], None).unwrap();
            git_stdout(
                &self.source,
                &[
                    "remote",
                    "add",
                    "origin",
                    self.root.join("remote.git").to_str().unwrap(),
                ],
                None,
            )
            .unwrap();
            git_stdout(
                &self.source,
                &["update-ref", "refs/remotes/origin/main", &initial],
                None,
            )
            .unwrap();
            git_stdout(
                &self.source,
                &["config", "branch.mythra/isolated.remote", "origin"],
                None,
            )
            .unwrap();
            git_stdout(
                &self.source,
                &["config", "branch.mythra/isolated.merge", "refs/heads/main"],
                None,
            )
            .unwrap();
            fs::write(self.isolated.join("file.txt"), "isolated\n").unwrap();
            git_stdout(&self.isolated, &["add", "--all"], None).unwrap();
            git_stdout(&self.isolated, &["commit", "-m", "isolated"], None).unwrap();
            let oid = git_stdout(&self.isolated, &["rev-parse", "HEAD"], None).unwrap();
            git_stdout(
                &self.source,
                &["merge", "--no-ff", "--no-edit", "mythra/isolated"],
                None,
            )
            .unwrap();
            oid
        }
    }

    impl Drop for RemovalFixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn worktree_removal_reports_removed_folder_when_branch_deletion_is_refused() {
        let fixture = RemovalFixture::new();
        let isolated_oid = fixture.merge_with_stale_upstream();
        set_worktree_applied_baseline_sync(
            fixture.source.to_str().unwrap(),
            "remove-thread",
            &isolated_oid,
        )
        .unwrap();
        let result = fixture.remove();
        assert!(
            !fixture.isolated.exists(),
            "the successful first phase removed the folder"
        );
        assert!(
            result.is_ok(),
            "completed folder removal must be a resolved phased result: {result:?}"
        );
        let result = result.unwrap();
        assert!(result.folder_removed);
        assert!(!result.branch_deleted);
        assert_eq!(result.retained_branch.as_deref(), Some("mythra/isolated"));
        assert_eq!(
            result.retained_branch_oid.as_deref(),
            Some(isolated_oid.as_str())
        );
        assert!(result
            .branch_delete_error
            .unwrap()
            .contains("not fully merged"));
        assert_eq!(
            git_stdout(
                &fixture.source,
                &["rev-parse", "refs/heads/mythra/isolated"],
                None
            )
            .unwrap(),
            isolated_oid
        );
        assert!(optional_git_stdout(
            &fixture.source,
            &[
                "rev-parse",
                "--verify",
                "refs/openkiwi/worktrees/remove-thread/applied"
            ]
        )
        .is_none());
    }

    #[test]
    fn worktree_removal_reports_complete_cleanup() {
        let fixture = RemovalFixture::new();
        git_stdout(
            &fixture.source,
            &["config", "branch.mythra/isolated.description", "old branch"],
            None,
        )
        .unwrap();
        let result = fixture.remove().unwrap();
        assert!(result.folder_removed && result.branch_deleted);
        assert!(
            result.retained_branch.is_none()
                && result.retained_branch_oid.is_none()
                && result.branch_delete_error.is_none()
        );
        assert!(!fixture.isolated.exists());
        assert!(optional_git_stdout(
            &fixture.source,
            &["config", "--get", "branch.mythra/isolated.description"]
        )
        .is_none());
    }

    #[test]
    fn worktree_removal_preserves_a_recreated_branch_and_its_config() {
        let fixture = RemovalFixture::new();
        let initial = git_stdout(&fixture.source, &["rev-parse", "HEAD"], None).unwrap();
        let tree = git_stdout(&fixture.source, &["rev-parse", "HEAD^{tree}"], None).unwrap();
        let new_tip = git_stdout(
            &fixture.source,
            &[
                "commit-tree",
                &tree,
                "-p",
                &initial,
                "-m",
                "recreated branch",
            ],
            None,
        )
        .unwrap();
        git_stdout(
            &fixture.source,
            &["config", "branch.mythra/isolated.description", "old branch"],
            None,
        )
        .unwrap();
        let result = worktree_remove_sync_with_gate(
            &fixture.managed_root,
            Some("remove-thread"),
            fixture.source.to_str().unwrap(),
            fixture.isolated.to_str().unwrap(),
            "mythra/isolated",
            WorktreeRemoveOptions {
                force: true,
                delete_branch: true,
                expected_retained_branch_oid: None,
                timeout: Duration::from_secs(120),
            },
            |phase, _| {
                if matches!(phase, WorktreeRemovalPhase::BeforeConfigCleanup) {
                    git_stdout(
                        &fixture.source,
                        &[
                            "update-ref",
                            "refs/heads/mythra/isolated",
                            &new_tip,
                            &"0".repeat(40),
                        ],
                        None,
                    )?;
                    git_stdout(
                        &fixture.source,
                        &[
                            "config",
                            "branch.mythra/isolated.description",
                            "new branch configuration",
                        ],
                        None,
                    )?;
                }
                Ok(())
            },
        )
        .unwrap();
        assert!(result.folder_removed && !result.branch_deleted);
        assert_eq!(
            result.retained_branch_oid.as_deref(),
            Some(new_tip.as_str())
        );
        assert!(result.branch_delete_error.unwrap().contains("recreated"));
        assert_eq!(
            git_stdout(
                &fixture.source,
                &["config", "--get", "branch.mythra/isolated.description"],
                None
            )
            .unwrap(),
            "new branch configuration"
        );
    }

    #[test]
    fn worktree_removal_reserves_absent_branch_name_while_cleaning_config() {
        let fixture = RemovalFixture::new();
        let initial = git_stdout(&fixture.source, &["rev-parse", "HEAD"], None).unwrap();
        git_stdout(
            &fixture.source,
            &["config", "branch.mythra/isolated.description", "old branch"],
            None,
        )
        .unwrap();
        let mut attempted_recreation = false;
        let result = worktree_remove_sync_with_gate(&fixture.managed_root, Some("remove-thread"), fixture.source.to_str().unwrap(), fixture.isolated.to_str().unwrap(), "mythra/isolated", WorktreeRemoveOptions { force: true, delete_branch: true, expected_retained_branch_oid: None, timeout: Duration::from_secs(120) }, |phase, _| {
            if matches!(phase, WorktreeRemovalPhase::ConfigNameReserved) {
                let output = run_git(&fixture.source, &["update-ref", "refs/heads/mythra/isolated", &initial, &"0".repeat(40)], None)?;
                assert!(!output.status.success(), "the prepared absence transaction must prevent same-name recreation until old config is removed");
                attempted_recreation = true;
            }
            Ok(())
        }).unwrap();
        assert!(attempted_recreation);
        assert!(result.folder_removed && result.branch_deleted);
        assert!(result.branch_delete_error.is_none());
        assert!(optional_git_stdout(
            &fixture.source,
            &["config", "--get", "branch.mythra/isolated.description"]
        )
        .is_none());
    }

    #[test]
    fn worktree_removal_keeps_branches_owned_by_detached_rebase_or_bisect() {
        for state in [
            "rebase-merge/head-name",
            "rebase-apply/head-name",
            "BISECT_START",
        ] {
            let fixture = RemovalFixture::new();
            let other = fixture.managed_root.join("project/other");
            git_stdout(
                &fixture.source,
                &[
                    "worktree",
                    "add",
                    "--detach",
                    other.to_str().unwrap(),
                    "HEAD",
                ],
                None,
            )
            .unwrap();
            let git_path = git_stdout(&other, &["rev-parse", "--git-path", state], None).unwrap();
            let git_path = PathBuf::from(git_path);
            let git_path = if git_path.is_absolute() {
                git_path
            } else {
                other.join(git_path)
            };
            fs::create_dir_all(git_path.parent().unwrap()).unwrap();
            fs::write(
                &git_path,
                if state == "BISECT_START" {
                    "mythra/isolated\n"
                } else {
                    "refs/heads/mythra/isolated\n"
                },
            )
            .unwrap();
            let result = worktree_remove_sync(
                &fixture.managed_root,
                Some("remove-thread"),
                fixture.source.to_str().unwrap(),
                fixture.isolated.to_str().unwrap(),
                "mythra/isolated",
                WorktreeRemoveOptions {
                    force: true,
                    delete_branch: true,
                    expected_retained_branch_oid: None,
                    timeout: Duration::from_secs(120),
                },
            )
            .unwrap();
            assert!(result.folder_removed && !result.branch_deleted);
            assert!(result
                .branch_delete_error
                .unwrap()
                .contains("rebase or bisect"));
            assert!(optional_git_stdout(
                &fixture.source,
                &["rev-parse", "--verify", "refs/heads/mythra/isolated"]
            )
            .is_some());
        }
    }

    #[test]
    fn worktree_removal_timeout_before_preflight_preserves_folder_branch_and_index() {
        let fixture = RemovalFixture::new();
        let initial = git_stdout(&fixture.source, &["rev-parse", "HEAD"], None).unwrap();
        let index = fs::read(fixture.source.join(".git/index")).unwrap();
        let error = worktree_remove_sync(
            &fixture.managed_root,
            Some("remove-thread"),
            fixture.source.to_str().unwrap(),
            fixture.isolated.to_str().unwrap(),
            "mythra/isolated",
            WorktreeRemoveOptions {
                force: true,
                delete_branch: true,
                expected_retained_branch_oid: None,
                timeout: Duration::ZERO,
            },
        )
        .unwrap_err();
        assert!(error.contains("timed out"));
        assert!(fixture.isolated.join("file.txt").exists());
        assert_eq!(fs::read(fixture.source.join(".git/index")).unwrap(), index);
        assert_eq!(
            git_stdout(
                &fixture.source,
                &["rev-parse", "refs/heads/mythra/isolated"],
                None
            )
            .unwrap(),
            initial
        );
    }

    #[test]
    fn worktree_removal_reports_unknown_branch_state_when_cleanup_deadline_expires() {
        let fixture = RemovalFixture::new();
        let initial = git_stdout(&fixture.source, &["rev-parse", "HEAD"], None).unwrap();
        let result = worktree_remove_sync_with_gate(
            &fixture.managed_root,
            Some("remove-thread"),
            fixture.source.to_str().unwrap(),
            fixture.isolated.to_str().unwrap(),
            "mythra/isolated",
            WorktreeRemoveOptions {
                force: true,
                delete_branch: true,
                expected_retained_branch_oid: None,
                timeout: Duration::from_secs(120),
            },
            |phase, git| {
                if matches!(phase, WorktreeRemovalPhase::FolderRemoved) {
                    // Expire exactly after successful folder removal, independent
                    // of native process/job startup cost on either platform.
                    git.deadline.set(Instant::now());
                }
                Ok(())
            },
        )
        .unwrap();
        assert!(result.folder_removed && !result.branch_deleted);
        assert!(result.retained_branch.is_none() && result.retained_branch_oid.is_none());
        let warning = result.branch_delete_error.unwrap();
        assert!(warning.contains("could not be verified") && warning.contains(&initial));
        assert!(!fixture.isolated.exists());
        assert_eq!(
            git_stdout(
                &fixture.source,
                &["rev-parse", "refs/heads/mythra/isolated"],
                None
            )
            .unwrap(),
            initial
        );
    }

    #[test]
    fn worktree_removal_preserves_an_external_commit_created_after_final_tip_check() {
        let fixture = RemovalFixture::new();
        let initial = git_stdout(&fixture.source, &["rev-parse", "HEAD"], None).unwrap();
        let tree = git_stdout(&fixture.source, &["rev-parse", "HEAD^{tree}"], None).unwrap();
        let external_commit = git_stdout(
            &fixture.source,
            &[
                "commit-tree",
                &tree,
                "-p",
                &initial,
                "-m",
                "external unmerged commit",
            ],
            None,
        )
        .unwrap();
        let result = worktree_remove_sync_with_gate(
            &fixture.managed_root,
            Some("remove-thread"),
            fixture.source.to_str().unwrap(),
            fixture.isolated.to_str().unwrap(),
            "mythra/isolated",
            WorktreeRemoveOptions {
                force: true,
                delete_branch: true,
                expected_retained_branch_oid: None,
                timeout: Duration::from_secs(120),
            },
            |phase, _| {
                if matches!(phase, WorktreeRemovalPhase::BeforeBranchDelete) {
                    git_stdout(
                        &fixture.source,
                        &[
                            "update-ref",
                            "refs/heads/mythra/isolated",
                            &external_commit,
                            &initial,
                        ],
                        None,
                    )?;
                }
                Ok(())
            },
        )
        .unwrap();
        assert!(result.folder_removed);
        assert!(
            !result.branch_deleted,
            "a newer externally created commit must remain named after folder removal"
        );
        assert_eq!(
            result.retained_branch_oid.as_deref(),
            Some(external_commit.as_str())
        );
        assert_eq!(
            git_stdout(
                &fixture.source,
                &["rev-parse", "refs/heads/mythra/isolated"],
                None
            )
            .unwrap(),
            external_commit
        );
    }

    #[test]
    fn worktree_removal_keeps_branch_when_deletion_was_not_requested() {
        let fixture = RemovalFixture::new();
        let result = worktree_remove_sync(
            &fixture.managed_root,
            None,
            fixture.source.to_str().unwrap(),
            fixture.isolated.to_str().unwrap(),
            "mythra/isolated",
            WorktreeRemoveOptions {
                force: false,
                delete_branch: false,
                expected_retained_branch_oid: None,
                timeout: Duration::from_secs(120),
            },
        )
        .unwrap();
        assert!(result.folder_removed && !result.branch_deleted);
        assert_eq!(result.retained_branch.as_deref(), Some("mythra/isolated"));
        assert!(result.branch_delete_error.is_none());
    }

    #[test]
    fn worktree_removal_validates_checkpoint_identity_before_removing_folder() {
        let fixture = RemovalFixture::new();
        let error = worktree_remove_sync(
            &fixture.managed_root,
            Some("invalid/thread"),
            fixture.source.to_str().unwrap(),
            fixture.isolated.to_str().unwrap(),
            "mythra/isolated",
            WorktreeRemoveOptions {
                force: false,
                delete_branch: true,
                expected_retained_branch_oid: None,
                timeout: Duration::from_secs(120),
            },
        )
        .unwrap_err();
        assert!(error.contains("identity is invalid"));
        assert!(fixture.isolated.exists());
    }

    #[cfg(unix)]
    #[test]
    fn worktree_removal_bounds_a_hanging_fsmonitor_before_removing_data() {
        use std::{os::unix::fs::PermissionsExt, sync::mpsc};
        let fixture = RemovalFixture::new();
        let gate = fixture.root.join("finish-fsmonitor");
        let hook = fixture.root.join("fsmonitor.sh");
        fs::write(
            &hook,
            format!(
                "#!/bin/sh\nwhile ! test -f '{}'; do sleep 0.01; done\nprintf '\\0'\n",
                gate.display()
            ),
        )
        .unwrap();
        fs::set_permissions(&hook, fs::Permissions::from_mode(0o755)).unwrap();
        git_stdout(
            &fixture.source,
            &["config", "core.fsmonitor", hook.to_str().unwrap()],
            None,
        )
        .unwrap();
        fs::write(fixture.isolated.join("file.txt"), "preserve this change\n").unwrap();
        let managed = fixture.managed_root.clone();
        let source = fixture.source.clone();
        let isolated = fixture.isolated.clone();
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            tx.send(worktree_remove_sync(
                &managed,
                Some("remove-thread"),
                source.to_str().unwrap(),
                isolated.to_str().unwrap(),
                "mythra/isolated",
                WorktreeRemoveOptions {
                    force: false,
                    delete_branch: true,
                    expected_retained_branch_oid: None,
                    timeout: Duration::from_millis(300),
                },
            ))
            .unwrap();
        });
        let timely = rx.recv_timeout(Duration::from_secs(1));
        let completed_within_bound = timely.is_ok();
        // Release the old unbounded implementation so fail-before leaves no
        // blocked Git process and does not use the long production timeout.
        fs::write(&gate, "finish\n").unwrap();
        let result = timely.unwrap_or_else(|_| rx.recv_timeout(Duration::from_secs(2)).unwrap());
        assert!(
            completed_within_bound,
            "a hanging fsmonitor must not retain removal ownership indefinitely"
        );
        assert!(result.unwrap_err().contains("timed out"));
        assert_eq!(
            fs::read_to_string(fixture.isolated.join("file.txt")).unwrap(),
            "preserve this change\n"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn timed_out_removal_releases_cancelled_worker_ownership_and_stops_hook_descendants() {
        use std::{os::unix::fs::PermissionsExt, sync::mpsc};
        let fixture = RemovalFixture::new();
        let ready = fixture.root.join("fsmonitor-ready");
        let escaped = fixture.root.join("fsmonitor-descendant-escaped");
        let hook = fixture.root.join("fsmonitor.sh");
        fs::write(&hook, format!("#!/bin/sh\nprintf ready > '{}'\n(sleep 1.5; printf escaped > '{}') &\nwhile true; do sleep 0.01; done\n", ready.display(), escaped.display())).unwrap();
        fs::set_permissions(&hook, fs::Permissions::from_mode(0o755)).unwrap();
        let index_path = PathBuf::from(
            git_stdout(
                &fixture.isolated,
                &["rev-parse", "--git-path", "index"],
                None,
            )
            .unwrap(),
        );
        let index_path = if index_path.is_absolute() {
            index_path
        } else {
            fixture.isolated.join(index_path)
        };
        let index_before = fs::read(&index_path).unwrap();
        git_stdout(
            &fixture.source,
            &["config", "core.fsmonitor", hook.to_str().unwrap()],
            None,
        )
        .unwrap();
        fs::write(
            fixture.isolated.join("file.txt"),
            "keep my working change\n",
        )
        .unwrap();
        let lock = crate::git_workspace::repository_lock(&fixture.source)
            .await
            .unwrap();
        let worker_lock = std::sync::Arc::clone(&lock);
        let managed = fixture.managed_root.clone();
        let source = fixture.source.clone();
        let isolated = fixture.isolated.clone();
        let (tx, rx) = mpsc::channel();
        let outer = tokio::spawn(async move {
            let guard = worker_lock.lock_owned().await;
            spawn_locked_worktree_worker(guard, move || {
                tx.send(worktree_remove_sync(
                    &managed,
                    Some("remove-thread"),
                    source.to_str().unwrap(),
                    isolated.to_str().unwrap(),
                    "mythra/isolated",
                    WorktreeRemoveOptions {
                        force: false,
                        delete_branch: true,
                        expected_retained_branch_oid: None,
                        timeout: Duration::from_secs(1),
                    },
                ))
                .unwrap();
                Ok(())
            })
            .await
        });
        tokio::time::timeout(Duration::from_secs(2), async {
            while !ready.exists() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        outer.abort();
        assert!(outer.await.unwrap_err().is_cancelled());
        assert!(lock.try_lock().is_err());
        let _next_worker_guard = tokio::time::timeout(Duration::from_secs(2), lock.lock())
            .await
            .expect("timeout must finish the worker and release ownership for the next operation");
        assert!(rx
            .recv_timeout(Duration::from_millis(100))
            .unwrap()
            .unwrap_err()
            .contains("timed out"));
        assert_eq!(fs::read(&index_path).unwrap(), index_before);
        assert_eq!(
            fs::read_to_string(fixture.isolated.join("file.txt")).unwrap(),
            "keep my working change\n"
        );
        tokio::time::sleep(Duration::from_millis(700)).await;
        assert!(
            !escaped.exists(),
            "timeout must stop hook descendants as well as Git itself"
        );
    }

    #[cfg(unix)]
    #[test]
    fn worktree_removal_reports_partial_cleanup_when_a_reference_hook_times_out() {
        use std::os::unix::fs::PermissionsExt;
        let fixture = RemovalFixture::new();
        let initial = git_stdout(&fixture.source, &["rev-parse", "HEAD"], None).unwrap();
        let ready = fixture.root.join("reference-hook-ready");
        let hook = fixture.source.join(".git/hooks/reference-transaction");
        fs::write(&hook, format!("#!/bin/sh\nif test \"$1\" = prepared; then\nprintf ready > '{}'\nwhile true; do sleep 0.01; done\nfi\n", ready.display())).unwrap();
        fs::set_permissions(&hook, fs::Permissions::from_mode(0o755)).unwrap();
        let result = worktree_remove_sync_with_gate(
            &fixture.managed_root,
            Some("remove-thread"),
            fixture.source.to_str().unwrap(),
            fixture.isolated.to_str().unwrap(),
            "mythra/isolated",
            WorktreeRemoveOptions {
                force: true,
                delete_branch: true,
                expected_retained_branch_oid: None,
                timeout: Duration::from_secs(120),
            },
            |phase, git| {
                if matches!(phase, WorktreeRemovalPhase::BeforeBranchDelete) {
                    // Start the hook's bounded mutation budget at its actual
                    // phase. Parallel preflight cost must not expire it before
                    // the ref transaction reaches the hanging hook.
                    git.deadline.set(Instant::now() + Duration::from_secs(2));
                }
                Ok(())
            },
        )
        .unwrap();
        assert!(
            ready.exists(),
            "the actual ref mutation must have reached its hook after folder removal"
        );
        assert!(result.folder_removed && !result.branch_deleted);
        assert!(result.retained_branch.is_none() && result.retained_branch_oid.is_none());
        assert!(result.branch_delete_error.unwrap().contains("timed out"));
        assert!(!fixture.isolated.exists());
        assert_eq!(
            git_stdout(
                &fixture.source,
                &["rev-parse", "refs/heads/mythra/isolated"],
                None
            )
            .unwrap(),
            initial
        );
    }

    #[cfg(unix)]
    #[test]
    fn worktree_operation_identity_refuses_a_fifo_without_waiting_for_a_writer() {
        use std::{ffi::CString, os::unix::ffi::OsStrExt};
        let fixture = RemovalFixture::new();
        let path = fixture.root.join("rebase-identity-fifo");
        let name = CString::new(path.as_os_str().as_bytes()).unwrap();
        // SAFETY: name is a valid NUL-terminated disposable fixture path.
        assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
        assert!(read_worktree_operation_identity(&path)
            .unwrap_err()
            .to_string()
            .contains("small regular file"));
    }

    #[test]
    fn worktree_merge_refuses_to_overwrite_ignored_destination() {
        for shape in ["file", "ancestor", "directory", "symlink"] {
            #[cfg(not(unix))]
            if shape == "symlink" {
                continue;
            }
            let fixture = RemovalFixture::new();
            let target = if matches!(shape, "ancestor" | "symlink") {
                "cache/nested.txt"
            } else if shape == "directory" {
                "cache"
            } else {
                "private.txt"
            };
            fs::create_dir_all(fixture.isolated.join(target).parent().unwrap()).unwrap();
            fs::write(fixture.isolated.join(target), "committed destination\n").unwrap();
            git_stdout(&fixture.isolated, &["add", target], None).unwrap();
            git_stdout(&fixture.isolated, &["commit", "-m", "destination"], None).unwrap();
            fs::write(
                fixture.source.join(".git/info/exclude"),
                "private.txt\ncache\n",
            )
            .unwrap();
            let ignored = match shape {
                "ancestor" => fixture.source.join("cache"),
                "directory" => {
                    fs::create_dir(fixture.source.join("cache")).unwrap();
                    fixture.source.join("cache/private.txt")
                }
                "symlink" => {
                    let outside = fixture.root.join("outside");
                    fs::create_dir(&outside).unwrap();
                    #[cfg(unix)]
                    std::os::unix::fs::symlink(&outside, fixture.source.join("cache")).unwrap();
                    outside.join("private.txt")
                }
                _ => fixture.source.join("private.txt"),
            };
            fs::write(&ignored, "unique ignored contents\n").unwrap();
            capture_checkpoint_snapshot(
                "ignored-merge-safety",
                fixture.source.to_str().unwrap(),
                "after",
                "safety",
            )
            .unwrap();
            let source_head = git_stdout(&fixture.source, &["rev-parse", "HEAD"], None).unwrap();
            let isolated_head =
                git_stdout(&fixture.isolated, &["rev-parse", "HEAD"], None).unwrap();
            let index_before = fs::read(fixture.source.join(".git/index")).unwrap();
            let reference = worktree_applied_ref("ignored-merge-thread").unwrap();
            let result = worktree_merge_branch_sync(
                fixture.source.to_str().unwrap(),
                fixture.isolated.to_str().unwrap(),
                "mythra/isolated",
                "ignored-merge-safety",
                Some(&reference),
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
                assert!(fs::symlink_metadata(fixture.source.join("cache"))
                    .unwrap()
                    .file_type()
                    .is_symlink());
            }
            assert_eq!(
                fs::read(fixture.source.join(".git/index")).unwrap(),
                index_before
            );
            assert_eq!(
                git_stdout(&fixture.source, &["rev-parse", "HEAD"], None).unwrap(),
                source_head
            );
            assert_eq!(
                git_stdout(&fixture.isolated, &["rev-parse", "HEAD"], None).unwrap(),
                isolated_head
            );
            assert_eq!(
                git_stdout(&fixture.source, &["symbolic-ref", "--short", "HEAD"], None).unwrap(),
                "main"
            );
            assert!(
                optional_git_stdout(&fixture.source, &["rev-parse", "--verify", &reference])
                    .is_none()
            );
            assert!(
                optional_git_stdout(&fixture.source, &["rev-parse", "--verify", "MERGE_HEAD"])
                    .is_none()
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn worktree_merge_reports_a_branch_switch_by_post_merge_hook() {
        use std::os::unix::fs::PermissionsExt;
        let fixture = RemovalFixture::new();
        git_stdout(&fixture.source, &["branch", "other"], None).unwrap();
        fs::write(fixture.isolated.join("file.txt"), "isolated change\n").unwrap();
        git_stdout(&fixture.isolated, &["commit", "-am", "isolated change"], None).unwrap();
        capture_checkpoint_snapshot("hook-merge-safety", fixture.source.to_str().unwrap(), "after", "safety").unwrap();
        let hook = fixture.source.join(".git/hooks/post-merge");
        fs::write(&hook, "#!/bin/sh\ngit checkout other\n").unwrap();
        fs::set_permissions(&hook, fs::Permissions::from_mode(0o755)).unwrap();
        let result = worktree_merge_branch_sync(fixture.source.to_str().unwrap(), fixture.isolated.to_str().unwrap(),
            "mythra/isolated", "hook-merge-safety", None);
        assert!(result.unwrap_err().contains("changed after the merge"));
        assert_eq!(git_stdout(&fixture.source, &["symbolic-ref", "--short", "HEAD"], None).unwrap(), "other");
    }

    #[test]
    fn worktree_merge_preserves_unrelated_ignored_output_and_allows_tracked_file_to_directory() {
        let fixture = RemovalFixture::new();
        fs::remove_file(fixture.isolated.join("file.txt")).unwrap();
        fs::create_dir(fixture.isolated.join("file.txt")).unwrap();
        fs::write(
            fixture.isolated.join("file.txt/nested.txt"),
            "tracked replacement\n",
        )
        .unwrap();
        git_stdout(&fixture.isolated, &["add", "-A"], None).unwrap();
        git_stdout(
            &fixture.isolated,
            &["commit", "-m", "file to directory"],
            None,
        )
        .unwrap();
        fs::write(fixture.source.join(".git/info/exclude"), "build/\n").unwrap();
        fs::create_dir(fixture.source.join("build")).unwrap();
        fs::write(fixture.source.join("build/private.txt"), "unique output\n").unwrap();
        capture_checkpoint_snapshot(
            "ignored-output-safety",
            fixture.source.to_str().unwrap(),
            "after",
            "safety",
        )
        .unwrap();
        worktree_merge_branch_sync(
            fixture.source.to_str().unwrap(),
            fixture.isolated.to_str().unwrap(),
            "mythra/isolated",
            "ignored-output-safety",
            None,
        )
        .unwrap();
        assert_eq!(
            fs::read(fixture.source.join("build/private.txt")).unwrap(),
            b"unique output\n"
        );
        assert_eq!(
            git_stdout(
                &fixture.source,
                &[
                    "hash-object",
                    "--path=file.txt/nested.txt",
                    "--",
                    "file.txt/nested.txt",
                ],
                None,
            )
            .unwrap(),
            git_stdout(
                &fixture.source,
                &["rev-parse", "HEAD:file.txt/nested.txt"],
                None,
            )
            .unwrap()
        );
    }

    #[test]
    fn worktree_merge_refuses_ignored_destinations_derived_from_directory_renames() {
        for policy in [None, Some("true")] {
            let fixture = RemovalFixture::new();
            fs::create_dir(fixture.source.join("old")).unwrap();
            fs::write(fixture.source.join("old/tracked.txt"), "base\n").unwrap();
            git_stdout(&fixture.source, &["add", "old"], None).unwrap();
            git_stdout(&fixture.source, &["commit", "-m", "directory base"], None).unwrap();
            git_stdout(&fixture.isolated, &["merge", "--ff-only", "main"], None).unwrap();
            git_stdout(&fixture.source, &["mv", "old", "new"], None).unwrap();
            git_stdout(&fixture.source, &["commit", "-m", "rename directory"], None).unwrap();
            fs::write(
                fixture.isolated.join("old/private.txt"),
                "incoming contents\n",
            )
            .unwrap();
            git_stdout(&fixture.isolated, &["add", "old/private.txt"], None).unwrap();
            git_stdout(&fixture.isolated, &["commit", "-m", "incoming file"], None).unwrap();
            if let Some(value) = policy {
                git_stdout(
                    &fixture.source,
                    &["config", "merge.directoryRenames", value],
                    None,
                )
                .unwrap();
            }
            fs::write(
                fixture.source.join(".git/info/exclude"),
                "new/private.txt\n",
            )
            .unwrap();
            fs::write(
                fixture.source.join("new/private.txt"),
                "unique ignored contents\n",
            )
            .unwrap();
            capture_checkpoint_snapshot(
                "rename-safety",
                fixture.source.to_str().unwrap(),
                "after",
                "safety",
            )
            .unwrap();
            let head = git_stdout(&fixture.source, &["rev-parse", "HEAD"], None).unwrap();
            let index = fs::read(fixture.source.join(".git/index")).unwrap();
            let result = worktree_merge_branch_sync(
                fixture.source.to_str().unwrap(),
                fixture.isolated.to_str().unwrap(),
                "mythra/isolated",
                "rename-safety",
                None,
            );
            assert!(
                result.is_err(),
                "{policy:?}: merge-derived ignored file was overwritten: {result:?}"
            );
            assert_eq!(
                fs::read(fixture.source.join("new/private.txt")).unwrap(),
                b"unique ignored contents\n"
            );
            assert_eq!(fs::read(fixture.source.join(".git/index")).unwrap(), index);
            assert_eq!(
                git_stdout(&fixture.source, &["rev-parse", "HEAD"], None).unwrap(),
                head
            );
            assert!(
                optional_git_stdout(&fixture.source, &["rev-parse", "--verify", "MERGE_HEAD"])
                    .is_none()
            );
        }
    }

    #[test]
    fn worktree_removal_refuses_dirty_and_ignored_files_without_force() {
        let fixture = RemovalFixture::new();
        fs::write(fixture.isolated.join("file.txt"), "changed\n").unwrap();
        assert!(fixture.remove().unwrap_err().contains("uncommitted"));
        git_stdout(&fixture.isolated, &["restore", "file.txt"], None).unwrap();
        fs::write(fixture.source.join(".git/info/exclude"), "private.log\n").unwrap();
        fs::write(fixture.isolated.join("private.log"), "private\n").unwrap();
        assert!(fixture.remove().unwrap_err().contains("ignored files"));
        assert!(fixture.isolated.exists());
    }

    #[test]
    fn retained_branch_retry_requires_matching_tip_and_never_upgrades_to_force() {
        let fixture = RemovalFixture::new();
        let isolated_oid = fixture.merge_with_stale_upstream();
        fixture.remove().unwrap();
        assert!(fixture
            .remove()
            .unwrap_err()
            .contains("Review its retained branch"));
        assert!(fixture
            .cleanup(&isolated_oid, true)
            .unwrap_err()
            .contains("without force"));
        let retry = fixture.cleanup(&isolated_oid, false).unwrap();
        assert!(!retry.branch_deleted);
        assert_eq!(
            retry.retained_branch_oid.as_deref(),
            Some(isolated_oid.as_str())
        );
        assert!(retry
            .branch_delete_error
            .unwrap()
            .contains("not fully merged"));
        let source_head = git_stdout(&fixture.source, &["rev-parse", "HEAD"], None).unwrap();
        git_stdout(
            &fixture.source,
            &["update-ref", "refs/heads/mythra/isolated", &source_head],
            None,
        )
        .unwrap();
        assert!(fixture
            .cleanup(&isolated_oid, false)
            .unwrap_err()
            .contains("changed since removal"));
        assert_eq!(
            git_stdout(
                &fixture.source,
                &["rev-parse", "refs/heads/mythra/isolated"],
                None
            )
            .unwrap(),
            source_head
        );
    }

    #[test]
    fn retained_branch_retry_completes_after_upstream_contains_tip() {
        let fixture = RemovalFixture::new();
        let isolated_oid = fixture.merge_with_stale_upstream();
        fixture.remove().unwrap();
        git_stdout(
            &fixture.source,
            &["update-ref", "refs/remotes/origin/main", &isolated_oid],
            None,
        )
        .unwrap();
        let result = fixture.cleanup(&isolated_oid, false).unwrap();
        assert!(result.branch_deleted && result.folder_removed);
        // A repeated cleanup of the same completed removal is harmless.
        assert!(
            fixture
                .cleanup(&isolated_oid, false)
                .unwrap()
                .branch_deleted
        );
    }

    #[test]
    fn retained_branch_retry_refuses_recreated_folder_and_other_worktree() {
        let fixture = RemovalFixture::new();
        let isolated_oid = fixture.merge_with_stale_upstream();
        fixture.remove().unwrap();
        fs::create_dir_all(&fixture.isolated).unwrap();
        fs::write(fixture.isolated.join("new.txt"), "keep\n").unwrap();
        assert!(fixture
            .cleanup(&isolated_oid, false)
            .unwrap_err()
            .contains("exists again"));
        assert!(fixture.isolated.join("new.txt").exists());
        fs::remove_dir_all(&fixture.isolated).unwrap();
        let other = fixture.managed_root.join("project/recreated");
        git_stdout(
            &fixture.source,
            &[
                "worktree",
                "add",
                other.to_str().unwrap(),
                "mythra/isolated",
            ],
            None,
        )
        .unwrap();
        assert!(fixture
            .cleanup(&isolated_oid, false)
            .unwrap_err()
            .contains("checked out in another worktree"));
        assert!(other.join("file.txt").exists());
    }

    #[test]
    fn retained_branch_retry_refuses_outside_and_parent_traversal_paths() {
        let fixture = RemovalFixture::new();
        let isolated_oid = fixture.merge_with_stale_upstream();
        fixture.remove().unwrap();
        for path in [
            fixture.root.join("outside"),
            fixture.managed_root.join("project/../missing"),
        ] {
            let error = worktree_remove_sync(
                &fixture.managed_root,
                Some("remove-thread"),
                fixture.source.to_str().unwrap(),
                path.to_str().unwrap(),
                "mythra/isolated",
                WorktreeRemoveOptions {
                    force: false,
                    delete_branch: true,
                    expected_retained_branch_oid: Some(&isolated_oid),
                    timeout: Duration::from_secs(120),
                },
            )
            .unwrap_err();
            assert!(error.contains("managed") || error.contains("managed folder"));
        }
        assert_eq!(
            git_stdout(
                &fixture.source,
                &["rev-parse", "refs/heads/mythra/isolated"],
                None
            )
            .unwrap(),
            isolated_oid
        );
    }

    #[tokio::test]
    async fn worktree_blocking_worker_owns_lock_until_it_finishes_after_cancellation() {
        use std::{
            sync::{mpsc, Arc},
            time::Duration,
        };
        let lock = Arc::new(tokio::sync::Mutex::new(()));
        let worker_lock = Arc::clone(&lock);
        let (started_tx, started_rx) = tokio::sync::oneshot::channel();
        let (finish_tx, finish_rx) = mpsc::channel();
        let outer = tokio::spawn(async move {
            let guard = worker_lock.lock_owned().await;
            spawn_locked_worktree_worker(guard, move || {
                started_tx.send(()).unwrap();
                finish_rx.recv_timeout(Duration::from_secs(5)).unwrap();
                Ok(())
            })
            .await
        });
        tokio::time::timeout(Duration::from_secs(2), started_rx)
            .await
            .unwrap()
            .unwrap();
        outer.abort();
        assert!(outer.await.unwrap_err().is_cancelled());
        assert!(
            lock.try_lock().is_err(),
            "cancelling the command cannot release its still-running worker's ownership"
        );
        finish_tx.send(()).unwrap();
        let _guard = tokio::time::timeout(Duration::from_secs(2), lock.lock())
            .await
            .unwrap();
    }
}
