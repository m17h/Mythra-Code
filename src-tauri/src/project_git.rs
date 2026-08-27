use std::{
    collections::HashSet,
    env,
    ffi::{OsStr, OsString},
    fs,
    io::Write,
    path::{Path, PathBuf},
    process::Stdio,
    time::{SystemTime, UNIX_EPOCH},
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
    pub(super) source_commit: String,
    pub(super) isolated_tree: String,
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
    #[cfg(not(unix))]
    let _ = home;
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
    if directories.is_empty() {
        None
    } else {
        env::join_paths(directories).ok()
    }
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
    let list = git_stdout(&source, &["worktree", "list", "--porcelain"], None)?;
    let registered = list
        .lines()
        .filter_map(|line| line.strip_prefix("worktree "))
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
    tauri::async_runtime::spawn_blocking(move || {
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
        fs::create_dir_all(&root)
            .map_err(|error| format!("Could not create the Mythra Code worktree folder: {error}"))?;
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
    tauri::async_runtime::spawn_blocking(move || {
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
        fs::create_dir_all(&root)
            .map_err(|error| format!("Could not create the Mythra Code worktree folder: {error}"))?;
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
    tauri::async_runtime::spawn_blocking(move || {
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
    tauri::async_runtime::spawn_blocking(move || {
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
    verify_current_safety_tree(&source, safety_id)?;
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
    let isolated_tree = git_stdout(&worktree, &["rev-parse", "--verify", "HEAD^{tree}"], None)?;
    let previous_pin = pin_reference
        .and_then(|reference| optional_git_stdout(&source, &["rev-parse", "--verify", reference]));
    if let Some(reference) = pin_reference {
        git_stdout(&source, &["update-ref", reference, &isolated_tree], None)?;
    }
    let merge = run_git(&source, &["merge", "--no-ff", "--no-edit", branch], None)?;
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
    Ok(WorktreeMergeResult {
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
) -> Result<WorktreeMergeResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
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

#[tauri::command]
pub(super) async fn worktree_remove(
    app: AppHandle,
    thread_id: Option<String>,
    project_path: String,
    worktree_path: String,
    branch: String,
    force: bool,
    delete_branch: bool,
) -> Result<(), String> {
    let managed_root = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Could not locate Mythra Code's application data: {error}"))?
        .join("worktrees");
    tauri::async_runtime::spawn_blocking(move || {
        let source = checkpoint_repo(&project_path)?;
        let canonical_root = managed_root
            .canonicalize()
            .map_err(|error| format!("Could not open Mythra Code's worktree folder: {error}"))?;
        let canonical_worktree = PathBuf::from(&worktree_path)
            .canonicalize()
            .map_err(|error| format!("Could not open the isolated worktree: {error}"))?;
        if !canonical_worktree.starts_with(&canonical_root) {
            return Err(
                "Mythra Code will only remove worktrees it created in its managed folder".into(),
            );
        }
        let worktree = checkpoint_repo(&worktree_path)?;
        verify_linked_worktree(&source, &worktree)?;
        verify_managed_worktree_branch(&worktree, &branch)?;
        let status = git_stdout(
            &worktree,
            &["status", "--porcelain=v1", "--untracked-files=all"],
            None,
        )?;
        let ignored_file_count = git_nul_path_count(&worktree, IGNORED_FILES_ARGS)?;
        if (!status.is_empty() || ignored_file_count > 0) && !force {
            return Err(
                "The isolated worktree contains uncommitted, untracked, or ignored files".into(),
            );
        }
        let mut args = vec!["worktree", "remove"];
        if force {
            args.push("--force");
        }
        args.push(&worktree_path);
        git_stdout(&source, &args, None)?;
        if delete_branch {
            git_stdout(
                &source,
                &["branch", if force { "-D" } else { "-d" }, &branch],
                None,
            )?;
        }
        if let Some(thread_id) = thread_id {
            let reference = worktree_applied_ref(&thread_id)?;
            let _ = git_stdout(&source, &["update-ref", "-d", &reference], None);
        }
        let _ = git_stdout(&source, &["worktree", "prune"], None);
        Ok(())
    })
    .await
    .map_err(|error| format!("Worktree removal task failed: {error}"))?
}
