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
    process_launch::background_std_command,
    project_git::{git_common_dir, git_runtime_path, git_stdout, optional_git_stdout, run_git},
};

const NETWORK_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_NETWORK_OUTPUT: usize = 64 * 1024;

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
    })
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
    let selected = repo(cwd)?;
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
        git_stdout(&selected, &["checkout", "-b", name], None)?;
    } else {
        git_stdout(
            &selected,
            &["show-ref", "--verify", &format!("refs/heads/{name}")],
            None,
        )
        .map_err(|_| format!("Branch {name} does not exist"))?;
        git_stdout(&selected, &["checkout", name], None)?;
    }
    snapshot(&selected)
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

fn bounded_git(repo: &Path, args: &[&str]) -> Result<Output, String> {
    let mut command = background_std_command("git");
    command
        .args(args)
        .current_dir(repo)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    command.env("GIT_TERMINAL_PROMPT", "0");
    command.env("GCM_INTERACTIVE", "Never");
    command.env("GIT_ASKPASS", "");
    if let Some(path) = git_runtime_path(
        env::var_os("PATH").as_deref(),
        env::var_os("HOME").as_deref().map(Path::new),
    ) {
        command.env("PATH", path);
    }
    let mut child = command
        .spawn()
        .map_err(|error| format!("Could not start Git: {error}"))?;
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
                if kept.len() < MAX_NETWORK_OUTPUT {
                    let retain = count.min(MAX_NETWORK_OUTPUT - kept.len());
                    kept.extend_from_slice(&chunk[..retain]);
                }
            };
            let _ = sender.send(result);
        });
        receiver
    };
    let stdout_reader = drain(Box::new(stdout));
    let stderr_reader = drain(Box::new(stderr));
    let deadline = Instant::now() + NETWORK_TIMEOUT;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(25)),
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("Git network operation timed out".into());
            }
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("Could not wait for Git: {error}"));
            }
        }
    };
    let remaining = || deadline.saturating_duration_since(Instant::now());
    let (stdout, stdout_len) = stdout_reader
        .recv_timeout(remaining())
        .map_err(|_| "Git network operation timed out".to_string())??;
    let (stderr, stderr_len) = stderr_reader
        .recv_timeout(remaining())
        .map_err(|_| "Git network operation timed out".to_string())??;
    if stdout_len > MAX_NETWORK_OUTPUT || stderr_len > MAX_NETWORK_OUTPUT {
        return Err("Git produced too much network output".into());
    }
    let output = Output {
        status,
        stdout,
        stderr,
    };
    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if detail.is_empty() {
            "Git network operation failed".into()
        } else {
            detail
        });
    }
    Ok(output)
}

fn fetch_sync(cwd: &str) -> Result<GitWorkspaceSnapshot, String> {
    let selected = repo(cwd)?;
    let (remote, _) = remote_for_repository(&selected, None)?;
    bounded_git(&selected, &["fetch", "--prune", "--no-tags", &remote])?;
    snapshot(&selected)
}

fn update_sync(
    cwd: &str,
    repository: &str,
    base: &str,
    expected_head: &str,
    expected_branch: &str,
) -> Result<GitWorkspaceSnapshot, String> {
    let selected = repo(cwd)?;
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
        git_stdout(&selected, &["checkout", base], None)
    } else {
        git_stdout(&selected, &["checkout", "-b", base, &fetched_oid], None)
    };
    if let Err(error) = checkout {
        // Checkout hooks can fail after Git has already changed HEAD. Restore
        // the caller's branch even when the checkout command reports failure.
        if switched {
            let _ = git_stdout(&selected, &["checkout", expected_branch], None);
        }
        return Err(error);
    }
    if local_oid.as_deref() != Some(fetched_oid.as_str()) {
        if let Err(error) = git_stdout(&selected, &["merge", "--ff-only", &fetched_oid], None) {
            if switched {
                let _ = git_stdout(&selected, &["checkout", expected_branch], None);
            }
            return Err(error);
        }
    }
    snapshot(&selected)
}

#[tauri::command]
pub(super) async fn git_workspace_snapshot(cwd: String) -> Result<GitWorkspaceSnapshot, String> {
    tauri::async_runtime::spawn_blocking(move || repo(&cwd).and_then(|path| snapshot(&path)))
        .await
        .map_err(|error| format!("Git workspace inspection failed: {error}"))?
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
    let _guard = lock.lock().await;
    tauri::async_runtime::spawn_blocking(move || {
        branch_sync(&cwd, &name, create, &expected_head_oid, &expected_branch)
    })
    .await
    .map_err(|error| format!("Git branch task failed: {error}"))?
}

#[tauri::command]
pub(super) async fn git_workspace_fetch(cwd: String) -> Result<GitWorkspaceSnapshot, String> {
    let lock = repository_lock(Path::new(&cwd)).await?;
    let _guard = lock.lock().await;
    tauri::async_runtime::spawn_blocking(move || fetch_sync(&cwd))
        .await
        .map_err(|error| format!("Git fetch task failed: {error}"))?
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
    let _guard = lock.lock().await;
    tauri::async_runtime::spawn_blocking(move || {
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
        fs::write(
            &upload_pack,
            "#!/bin/sh\nsleep 1\nexec git-upload-pack \"$@\"\n",
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
        tokio::time::sleep(Duration::from_millis(200)).await;
        // Simulate another Git client changing the checkout while network I/O
        // is in flight. The post-fetch guard must observe and preserve it.
        git_stdout(&fixture.client, &["checkout", "main"], None).unwrap();
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
