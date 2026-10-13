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
use tauri::AppHandle;

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
#[cfg(windows)]
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

/// One deadline for a read-only operation, including all of its Git subprocesses.
/// Mutation helpers deliberately keep their existing semantics and ownership.
pub(super) struct GitReadOperation {
    deadline: Instant,
    output_limit: usize,
}

impl GitReadOperation {
    pub(super) fn new() -> Self {
        Self::with_limits(Duration::from_secs(15), 2 * 1024 * 1024)
    }

    pub(super) fn with_limits(timeout: Duration, output_limit: usize) -> Self {
        Self {
            deadline: Instant::now() + timeout,
            output_limit,
        }
    }

    pub(super) fn deadline(&self) -> Instant {
        self.deadline
    }

    pub(super) fn bounded_output(
        &self,
        cwd: &Path,
        args: &[&str],
        limit: usize,
    ) -> Result<(std::process::Output, bool), String> {
        let remaining = self
            .deadline
            .checked_duration_since(Instant::now())
            .ok_or("Git read operation timed out")?;
        let mut readonly_args = vec!["--no-pager", "--no-optional-locks", "-c", "color.ui=false"];
        readonly_args.extend_from_slice(args);
        crate::git_workspace::bounded_git_output(
            cwd,
            &readonly_args,
            remaining,
            limit.min(self.output_limit),
            true,
        )
    }

    pub(super) fn output(&self, cwd: &Path, args: &[&str]) -> Result<std::process::Output, String> {
        let (output, truncated) = self.bounded_output(cwd, args, self.output_limit)?;
        if truncated {
            return Err(
                "Git read output exceeded its byte limit; repository state is unknown".into(),
            );
        }
        Ok(output)
    }

    pub(super) fn nul_path_count(&self, cwd: &Path, args: &[&str]) -> Result<usize, String> {
        let remaining = self
            .deadline
            .checked_duration_since(Instant::now())
            .ok_or("Git read operation timed out")?;
        let mut readonly_args = vec!["--no-pager", "--no-optional-locks", "-c", "color.ui=false"];
        readonly_args.extend_from_slice(args);
        crate::git_workspace::bounded_git_nul_path_count(
            cwd,
            &readonly_args,
            remaining,
            self.output_limit,
        )
    }

    pub(super) fn stdout(&self, cwd: &Path, args: &[&str]) -> Result<String, String> {
        let output = self.output(cwd, args)?;
        if !output.status.success() {
            let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
            return Err(if detail.is_empty() {
                "Could not inspect Git repository".into()
            } else {
                detail
            });
        }
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    }

    /// A completed nonzero probe can mean an absent ref/config value. A timeout,
    /// overflow or failed process launch must never masquerade as absence.
    pub(super) fn optional_stdout(
        &self,
        cwd: &Path,
        args: &[&str],
    ) -> Result<Option<String>, String> {
        let output = self.output(cwd, args)?;
        if output.status.code() == Some(1) {
            return Ok(None);
        }
        if !output.status.success() {
            let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
            return Err(if detail.is_empty() {
                format!("Git read probe failed with status {}", output.status)
            } else {
                detail
            });
        }
        let value = String::from_utf8_lossy(&output.stdout).trim().to_string();
        Ok((!value.is_empty()).then_some(value))
    }

    pub(super) fn common_dir(&self, repo: &Path) -> Result<PathBuf, String> {
        let path = PathBuf::from(self.stdout(repo, &["rev-parse", "--git-common-dir"])?);
        let resolved = if path.is_absolute() {
            path
        } else {
            repo.join(path)
        };
        resolved
            .canonicalize()
            .map_err(|error| format!("Could not resolve the shared Git directory: {error}"))
    }

    fn root(&self, cwd: &str) -> Result<PathBuf, String> {
        let selected = PathBuf::from(cwd)
            .canonicalize()
            .map_err(|error| format!("Could not open the project folder: {error}"))?;
        let root = PathBuf::from(self.stdout(&selected, &["rev-parse", "--show-toplevel"])?)
            .canonicalize()
            .map_err(|error| format!("Could not resolve the Git repository: {error}"))?;
        if selected != root {
            return Err("Open the Git repository root before inspecting worktrees".into());
        }
        Ok(root)
    }
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
    GitReadOperation::new().common_dir(repo)
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
    let read = GitReadOperation::new();
    let source = read.root(project_path)?;
    let path = PathBuf::from(worktree_path);
    if !path.exists() {
        return Ok(WorktreeStatus {
            head_oid: None,
            source_branch: read
                .optional_stdout(&source, &["symbolic-ref", "--short", "-q", "HEAD"])?,
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
    let worktree = read.root(worktree_path)?;
    if read.common_dir(&source)? != read.common_dir(&worktree)? {
        return Err("That worktree does not belong to the selected project".into());
    }
    let registered = crate::git_workspace::worktree_paths_with_read(&source, &read)?
        .into_iter()
        .any(|listed_path| {
            PathBuf::from(listed_path)
                .canonicalize()
                .map(|path| path == worktree)
                .unwrap_or(false)
        });
    let status = read.stdout(
        &worktree,
        &["status", "--porcelain=v1", "--untracked-files=all"],
    )?;
    let changed_files = status.lines().filter(|line| !line.is_empty()).count();
    let untracked_files = status.lines().filter(|line| line.starts_with("??")).count();
    let ignored_file_count = read.nul_path_count(&worktree, IGNORED_FILES_ARGS)?;
    let counts = read.stdout(
        &source,
        &[
            "rev-list",
            "--left-right",
            "--count",
            &format!("HEAD...{branch}"),
        ],
    )?;
    let mut count_parts = counts.split_whitespace();
    let invalid = || "Git returned invalid worktree ahead/behind counts".to_string();
    let behind = count_parts
        .next()
        .ok_or_else(invalid)?
        .parse()
        .map_err(|_| invalid())?;
    let ahead = count_parts
        .next()
        .ok_or_else(invalid)?
        .parse()
        .map_err(|_| invalid())?;
    if count_parts.next().is_some() {
        return Err(invalid());
    }
    Ok(WorktreeStatus {
        head_oid: read.optional_stdout(&worktree, &["rev-parse", "--verify", "--quiet", "HEAD"])?,
        source_branch: read.optional_stdout(&source, &["symbolic-ref", "--short", "-q", "HEAD"])?,
        exists: true,
        registered,
        branch: read.optional_stdout(&worktree, &["symbolic-ref", "--short", "-q", "HEAD"])?,
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
    let read = GitReadOperation::new();
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
    let root_probe = read.output(&selected, &["rev-parse", "--show-toplevel"])?;
    let root = if root_probe.status.success() {
        PathBuf::from(String::from_utf8_lossy(&root_probe.stdout).trim())
    } else {
        return Ok(WorkspaceGitInfo {
            is_repo: false,
            is_root: false,
            has_commit: false,
            branch: None,
            head: None,
            error: None,
        });
    };
    let root = root.canonicalize().unwrap_or(root);
    let head = read.optional_stdout(&selected, &["rev-parse", "--verify", "--quiet", "HEAD"])?;
    Ok(WorkspaceGitInfo {
        is_repo: true,
        is_root: selected == root,
        has_commit: head.is_some(),
        branch: read.optional_stdout(&selected, &["symbolic-ref", "--short", "-q", "HEAD"])?,
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
    let app_data = crate::release_qa::app_data_dir(&app)
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
    let app_data = crate::release_qa::app_data_dir(&app)
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
        || !run_git(
            &source,
            &[
                "merge-base",
                "--is-ancestor",
                &source_head_oid,
                &source_commit,
            ],
            None,
        )?
        .status
        .success()
        || !run_git(
            &source,
            &[
                "merge-base",
                "--is-ancestor",
                &isolated_head_oid,
                &source_commit,
            ],
            None,
        )?
        .status
        .success()
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
    let managed_root = crate::release_qa::app_data_dir(&app)
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
