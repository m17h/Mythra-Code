//! Safe, opt-in publication of already-created local Git commits.
//!
//! This module never stages, commits, checks out, pulls, rebases, resets, or
//! rewrites remote history. The renderer supplies a pinned repository binding
//! and an immutable commit ID; every part of that snapshot is checked again
//! while holding the repository-wide mutation lock. Previously published refs
//! use an exact expected-old lease as compare-and-swap concurrency protection,
//! after ancestry proves the update is still fast-forward only.

use std::{
    collections::{HashMap, HashSet},
    env,
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};

use serde::{Deserialize, Serialize};
use tokio::{
    io::{AsyncRead, AsyncReadExt},
    process::Command,
};

#[cfg(test)]
use crate::process_launch::background_std_command;
use crate::{
    git_workspace::{repository_lock, worktree_branch_paths},
    github::parse_github_repository,
    process_launch::background_command,
    project_git::{git_common_dir, git_runtime_path, git_stdout, optional_git_stdout},
};

const PUBLISH_TIMEOUT: Duration = Duration::from_secs(120);
const MAX_ERROR_CHARS: usize = 4_000;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(super) struct GitPublishBinding {
    repository: String,
    remote: String,
    remote_url: String,
    common_dir: String,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(super) struct GitPublishBranch {
    name: String,
    head_oid: String,
    remote_branch: String,
    checked_out: bool,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(super) struct GitPublishSnapshot {
    binding: GitPublishBinding,
    branches: Vec<GitPublishBranch>,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(super) struct GitPublishResult {
    published_oid: String,
}

fn paused(message: impl AsRef<str>) -> String {
    format!("PAUSED: {}", message.as_ref())
}
fn retry(message: impl AsRef<str>) -> String {
    format!("RETRY: {}", message.as_ref())
}

async fn blocking_local<T, F>(operation: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(operation)
        .await
        .map_err(|error| paused(format!("Local Git task failed: {error}")))?
}

fn selected_repository(cwd: &str) -> Result<PathBuf, String> {
    let selected = PathBuf::from(cwd)
        .canonicalize()
        .map_err(|error| paused(format!("Could not open the project folder: {error}")))?;
    let top = git_stdout(&selected, &["rev-parse", "--show-toplevel"], None)
        .map_err(|_| paused("The selected folder is not a Git repository."))?;
    PathBuf::from(top)
        .canonicalize()
        .map_err(|error| paused(format!("Could not open the Git repository: {error}")))
}

fn valid_ref_component(value: &str) -> bool {
    !value.is_empty()
        && value != "HEAD"
        && !value.starts_with('-')
        && !value.starts_with('.')
        && !value.ends_with('.')
        && !value.ends_with('/')
        && !value.ends_with(".lock")
        && !value.contains("..")
        && !value.contains("@{")
        && !value.contains("//")
        && value != "@"
        && value.split('/').all(|component| {
            !component.is_empty() && !component.starts_with('.') && !component.ends_with(".lock")
        })
        && !value.bytes().any(|b| {
            b <= b' ' || b == 0x7f || matches!(b, b'~' | b'^' | b':' | b'?' | b'*' | b'[' | b'\\')
        })
}

fn valid_oid(value: &str) -> bool {
    matches!(value.len(), 40 | 64) && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn one_line(value: &[u8]) -> String {
    let raw = String::from_utf8_lossy(value).replace(['\r', '\n'], " ");
    raw.chars()
        .take(MAX_ERROR_CHARS)
        .collect::<String>()
        .trim()
        .to_string()
}

fn remote_urls(repo: &Path, remote: &str) -> Result<(String, String), String> {
    if !valid_ref_component(remote) {
        return Err(paused("The configured Git remote name is invalid."));
    }
    let fetch = git_stdout(repo, &["remote", "get-url", remote], None)
        .map_err(|_| paused(format!("The configured remote {remote} no longer exists.")))?;
    let pushes = git_stdout(
        repo,
        &["remote", "get-url", "--push", "--all", remote],
        None,
    )
    .map_err(|_| paused(format!("Could not read the push URL for {remote}.")))?;
    let push_urls: Vec<&str> = pushes
        .lines()
        .filter(|line| !line.trim().is_empty())
        .collect();
    if push_urls.len() != 1 {
        return Err(paused(format!(
            "Remote {remote} must have exactly one push URL before automatic publishing can run."
        )));
    }
    Ok((fetch, push_urls[0].to_string()))
}

fn repository_identity(fetch: &str, push: &str) -> Result<String, String> {
    match (
        parse_github_repository(fetch),
        parse_github_repository(push),
    ) {
        (Some(fetch_repo), Some(push_repo)) if fetch_repo.eq_ignore_ascii_case(&push_repo) => {
            Ok(fetch_repo)
        }
        (Some(_), Some(_)) => Err(paused(
            "The remote fetch and push URLs point to different GitHub repositories.",
        )),
        _ => {
            #[cfg(test)]
            {
                // Disposable local bare repositories are allowed only in native
                // tests. Production bindings are always pinned GitHub identities.
                if fetch == push {
                    return Ok("local/test-repository".into());
                }
            }
            Err(paused(
                "Automatic publishing requires matching GitHub fetch and push URLs.",
            ))
        }
    }
}

fn current_remote(repo: &Path) -> String {
    optional_git_stdout(repo, &["symbolic-ref", "--short", "-q", "HEAD"])
        .and_then(|branch| {
            optional_git_stdout(
                repo,
                &["config", "--get", &format!("branch.{branch}.remote")],
            )
        })
        .filter(|remote| !remote.is_empty())
        .unwrap_or_else(|| "origin".into())
}

fn checked_out_branches(repo: &Path) -> Result<HashSet<String>, String> {
    worktree_branch_paths(repo)
        .map(|paths| paths.into_keys().collect())
        .map_err(|error| paused(format!("Could not inspect repository worktrees: {error}")))
}

fn snapshot_sync(cwd: &str) -> Result<GitPublishSnapshot, String> {
    let repo = selected_repository(cwd)?;
    let common_dir = git_common_dir(&repo).map_err(paused)?;
    let remote = current_remote(&repo);
    let (fetch_url, push_url) = remote_urls(&repo, &remote)?;
    let repository = repository_identity(&fetch_url, &push_url)?;
    let checked_out = checked_out_branches(&repo)?;
    let rows = git_stdout(
        &repo,
        &[
            "for-each-ref",
            "--format=%(refname:short)%00%(objectname)%00%(upstream:remotename)%00%(upstream:remoteref)",
            "refs/heads",
        ],
        None,
    )
    .map_err(|error| paused(format!("Could not inspect local branches: {error}")))?;
    let mut branches = Vec::new();
    let mut remote_targets = HashMap::<String, String>::new();
    for row in rows.lines().filter(|row| !row.is_empty()) {
        let mut fields = row.split('\0');
        let name = fields.next().unwrap_or_default().to_string();
        let head_oid = fields.next().unwrap_or_default().to_string();
        let upstream_remote = fields.next().unwrap_or_default();
        let upstream_ref = fields.next().unwrap_or_default();
        if !valid_ref_component(&name) || !valid_oid(&head_oid) {
            return Err(paused("Git reported an invalid local branch identity."));
        }
        let remote_branch = if upstream_remote.is_empty() && upstream_ref.is_empty() {
            name.clone()
        } else {
            let branch = upstream_ref
                .strip_prefix("refs/heads/")
                .ok_or_else(|| paused(format!("Branch {name} has an invalid upstream.")))?;
            if upstream_remote != remote {
                return Err(paused(format!(
                    "Branch {name} tracks {upstream_remote}, not the pinned remote {remote}."
                )));
            }
            if !valid_ref_component(branch) {
                return Err(paused(format!(
                    "Branch {name} has an invalid upstream branch."
                )));
            }
            branch.to_string()
        };
        if let Some(existing) = remote_targets.insert(remote_branch.clone(), name.clone()) {
            return Err(paused(format!(
                "Branches {existing} and {name} both map to {remote}/{remote_branch}. Give each local branch a distinct upstream before enabling automatic publishing."
            )));
        }
        branches.push(GitPublishBranch {
            checked_out: checked_out.contains(&name),
            name,
            head_oid,
            remote_branch,
        });
    }
    if branches.is_empty() {
        return Err(paused(
            "This repository has no commits to publish yet. Create its first commit, then enable automatic publishing.",
        ));
    }
    Ok(GitPublishSnapshot {
        binding: GitPublishBinding {
            repository,
            remote,
            remote_url: push_url,
            common_dir: common_dir.to_string_lossy().into_owned(),
        },
        branches,
    })
}

fn git_is_ancestor(repo: &Path, older: &str, newer: &str) -> Result<bool, String> {
    let command =
        crate::project_git::run_git(repo, &["merge-base", "--is-ancestor", older, newer], None)
            .map_err(paused)?;
    match command.status.code() {
        Some(0) => Ok(true),
        Some(1) => Ok(false),
        _ => Err(paused(one_line(&command.stderr))),
    }
}

fn configured_upstream(repo: &Path, branch: &str) -> Option<(String, String)> {
    let upstream = optional_git_stdout(
        repo,
        &[
            "for-each-ref",
            "--format=%(upstream:remotename)%00%(upstream:remoteref)",
            &format!("refs/heads/{branch}"),
        ],
    )?;
    let mut parts = upstream.split('\0');
    let remote = parts.next().unwrap_or_default();
    let reference = parts.next().unwrap_or_default();
    (!remote.is_empty() || !reference.is_empty())
        .then(|| (remote.to_string(), reference.to_string()))
}

fn verify_publish(
    repo: &Path,
    binding: &GitPublishBinding,
    branch: &str,
    head_oid: &str,
    remote_branch: &str,
    floor: Option<&str>,
) -> Result<(), String> {
    if !valid_ref_component(branch)
        || !valid_ref_component(remote_branch)
        || !valid_oid(head_oid)
        || floor.is_some_and(|oid| !valid_oid(oid))
    {
        return Err(paused(
            "The requested branch or commit identity is invalid.",
        ));
    }
    let common = git_common_dir(repo).map_err(paused)?;
    if common.to_string_lossy() != binding.common_dir {
        return Err(paused(
            "This project now points to a different Git repository.",
        ));
    }
    let (fetch_url, push_url) = remote_urls(repo, &binding.remote)?;
    let repository = repository_identity(&fetch_url, &push_url)?;
    if push_url != binding.remote_url || !repository.eq_ignore_ascii_case(&binding.repository) {
        return Err(paused(
            "The configured Git remote changed since automatic publishing was enabled.",
        ));
    }
    // Rebuild the complete snapshot under the mutation lock. Besides checking
    // this branch, this refuses ambiguous many-to-one remote mappings before
    // any network process can start.
    let fresh = snapshot_sync(repo.to_string_lossy().as_ref())?;
    if fresh.binding != *binding {
        return Err(paused(
            "The repository publication binding changed since automatic publishing was enabled.",
        ));
    }
    if !fresh
        .branches
        .iter()
        .any(|candidate| candidate.name == branch && candidate.remote_branch == remote_branch)
    {
        return Err(paused(format!(
            "Branch {branch} no longer maps to {}/{}.",
            binding.remote, remote_branch
        )));
    }
    let current_oid = git_stdout(
        repo,
        &["rev-parse", &format!("refs/heads/{branch}^{{commit}}")],
        None,
    )
    .map_err(|_| paused(format!("Local branch {branch} no longer exists.")))?;
    // A later commit may arrive while an earlier one is queued. Publishing the
    // captured SHA is safe only while it remains in the branch's history.
    if !git_is_ancestor(repo, head_oid, &current_oid)? {
        return Err(paused(format!(
            "Branch {branch} was rewritten after this commit was queued."
        )));
    }
    if let Some(floor) = floor {
        if !git_is_ancestor(repo, floor, head_oid)? {
            return Err(paused(format!(
                "Branch {branch} no longer descends from the last reviewed commit."
            )));
        }
    }
    if let Some((configured_remote, configured_ref)) = configured_upstream(repo, branch) {
        if configured_remote != binding.remote
            || configured_ref != format!("refs/heads/{remote_branch}")
        {
            return Err(paused(format!(
                "Branch {branch} now has a different upstream than {}/{}.",
                binding.remote, remote_branch
            )));
        }
    } else if remote_branch != branch {
        return Err(paused(format!("Branch {branch} has no upstream, so publishing it as {remote_branch} was not verified.")));
    }
    Ok(())
}

fn establish_upstream(
    repo: &Path,
    binding: &GitPublishBinding,
    branch: &str,
    head_oid: &str,
    remote_branch: &str,
) -> Result<(), String> {
    if configured_upstream(repo, branch).is_some() {
        return Ok(());
    }
    // The immutable object was just accepted by the remote. Record precisely
    // that known value as the remote-tracking ref before installing branch
    // tracking, so status/ahead/behind remain coherent without a fetch.
    git_stdout(repo, &["update-ref", &format!("refs/remotes/{}/{remote_branch}", binding.remote), head_oid], None)
        .map_err(|error| paused(format!("The commit was published, but its local remote-tracking ref could not be recorded: {error}")))?;
    git_stdout(
        repo,
        &[
            "config",
            "--local",
            &format!("branch.{branch}.remote"),
            &binding.remote,
        ],
        None,
    )
    .map_err(|error| {
        paused(format!(
            "The commit was published, but its branch upstream could not be recorded: {error}"
        ))
    })?;
    git_stdout(
        repo,
        &[
            "config",
            "--local",
            &format!("branch.{branch}.merge"),
            &format!("refs/heads/{remote_branch}"),
        ],
        None,
    )
    .map_err(|error| {
        paused(format!(
            "The commit was published, but its branch upstream could not be completed: {error}"
        ))
    })?;
    Ok(())
}

fn classify_push_failure(detail: &str) -> String {
    let lower = detail.to_ascii_lowercase();
    let retryable = [
        "could not resolve host",
        "failed to connect",
        "connection timed out",
        "connection reset",
        "network is unreachable",
        "temporary failure",
        "authentication failed",
        "terminal prompts disabled",
        "could not read username",
        "operation timed out",
    ]
    .iter()
    .any(|needle| lower.contains(needle));
    if retryable {
        retry(detail)
    } else {
        paused(detail)
    }
}

fn async_git(repo: &Path) -> Command {
    let mut command = background_command("git");
    command
        .current_dir(repo)
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .env_remove("GIT_COMMON_DIR")
        .env_remove("GIT_INDEX_FILE")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GCM_INTERACTIVE", "Never")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let home = env::var_os("HOME").map(PathBuf::from);
    if let Some(path) = git_runtime_path(env::var_os("PATH").as_deref(), home.as_deref()) {
        command.env("PATH", path);
    }
    command
}

async fn drain_bounded<R: AsyncRead + Unpin>(mut reader: R) -> Result<Vec<u8>, std::io::Error> {
    let mut kept = Vec::new();
    let mut chunk = [0_u8; 1024];
    loop {
        let count = reader.read(&mut chunk).await?;
        if count == 0 {
            break;
        }
        if kept.len() < MAX_ERROR_CHARS {
            let remaining = MAX_ERROR_CHARS - kept.len();
            kept.extend_from_slice(&chunk[..count.min(remaining)]);
        }
    }
    Ok(kept)
}

async fn bounded_network_git(
    repo: &Path,
    args: &[String],
    action: &str,
) -> Result<(Vec<u8>, Vec<u8>), String> {
    let mut command = async_git(repo);
    command.args(args);
    let mut child = command
        .spawn()
        .map_err(|error| retry(format!("Could not start {action}: {error}")))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| retry(format!("Could not capture {action} output.")))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| retry(format!("Could not capture {action} errors.")))?;
    let (status, stdout, stderr) = tokio::time::timeout(PUBLISH_TIMEOUT, async {
        let (stdout, stderr, status) =
            tokio::join!(drain_bounded(stdout), drain_bounded(stderr), child.wait());
        Ok::<_, std::io::Error>((status?, stdout?, stderr?))
    })
    .await
    .map_err(|_| {
        retry(format!(
            "{action} timed out; the remote outcome may be unknown, so refresh before retrying."
        ))
    })?
    .map_err(|error| retry(format!("Could not finish {action}: {error}")))?;
    if status.success() {
        Ok((stdout, stderr))
    } else {
        let detail = one_line(if stderr.is_empty() { &stdout } else { &stderr });
        Err(classify_push_failure(if detail.is_empty() {
            "Git rejected the network operation."
        } else {
            &detail
        }))
    }
}

async fn remote_oid(
    repo: &Path,
    remote_url: &str,
    remote_branch: &str,
) -> Result<Option<String>, String> {
    let reference = format!("refs/heads/{remote_branch}");
    let args = vec![
        "ls-remote".into(),
        "--heads".into(),
        "--".into(),
        remote_url.into(),
        reference,
    ];
    let (stdout, _) = bounded_network_git(repo, &args, "Git remote inspection").await?;
    let text = String::from_utf8_lossy(&stdout);
    let mut lines = text.lines().filter(|line| !line.trim().is_empty());
    let first = lines.next();
    if lines.next().is_some() {
        return Err(paused("Git returned more than one remote branch identity."));
    }
    let Some(line) = first else {
        return Ok(None);
    };
    let oid = line.split_whitespace().next().unwrap_or_default();
    valid_oid(oid)
        .then(|| Some(oid.to_string()))
        .ok_or_else(|| paused("Git returned an invalid remote commit identity."))
}

#[tauri::command]
pub(super) async fn git_publish_snapshot(cwd: String) -> Result<GitPublishSnapshot, String> {
    tauri::async_runtime::spawn_blocking(move || snapshot_sync(&cwd))
        .await
        .map_err(|error| paused(format!("Git publication inspection failed: {error}")))?
}

#[tauri::command]
pub(super) async fn git_publish_commit(
    cwd: String,
    binding: GitPublishBinding,
    branch: String,
    head_oid: String,
    remote_branch: String,
    last_published_oid: Option<String>,
    expected_remote_oid: Option<String>,
) -> Result<GitPublishResult, String> {
    let repo = blocking_local(move || selected_repository(&cwd)).await?;
    let lock_repo = repo.clone();
    let lock = tauri::async_runtime::spawn_blocking(move || {
        tauri::async_runtime::block_on(repository_lock(&lock_repo))
    })
    .await
    .map_err(|error| paused(format!("Repository lock task failed: {error}")))?
    .map_err(paused)?;
    let _guard = lock.lock().await;
    if expected_remote_oid
        .as_deref()
        .is_some_and(|oid| !valid_oid(oid))
    {
        return Err(paused("The expected remote commit identity is invalid."));
    }
    let verify_repo = repo.clone();
    let verify_binding = binding.clone();
    let verify_branch = branch.clone();
    let verify_head = head_oid.clone();
    let verify_remote_branch = remote_branch.clone();
    let verify_floor = last_published_oid.clone();
    blocking_local(move || {
        verify_publish(
            &verify_repo,
            &verify_binding,
            &verify_branch,
            &verify_head,
            &verify_remote_branch,
            verify_floor.as_deref(),
        )
    })
    .await?;
    if let Some(expected) = expected_remote_oid.as_deref() {
        let ancestry_repo = repo.clone();
        let ancestry_expected = expected.to_string();
        let ancestry_head = head_oid.clone();
        if !blocking_local(move || {
            git_is_ancestor(&ancestry_repo, &ancestry_expected, &ancestry_head)
        })
        .await?
        {
            return Err(paused("The queued commit does not descend from the exact commit last published to this remote branch."));
        }
        match remote_oid(&repo, &binding.remote_url, &remote_branch).await? {
            Some(actual) if actual == head_oid => {
                // A prior attempt may have reached GitHub before its local
                // process timed out. Treat the exact intended object as an
                // idempotent success and repair only the guarded local mapping.
                let repair_repo = repo.clone();
                let repair_binding = binding.clone();
                let repair_branch = branch.clone();
                let repair_head = head_oid.clone();
                let repair_remote_branch = remote_branch.clone();
                let repair_floor = last_published_oid.clone();
                blocking_local(move || {
                    verify_publish(&repair_repo, &repair_binding, &repair_branch, &repair_head, &repair_remote_branch, repair_floor.as_deref())?;
                    establish_upstream(&repair_repo, &repair_binding, &repair_branch, &repair_head, &repair_remote_branch)
                }).await?;
                return Ok(GitPublishResult { published_oid: head_oid });
            }
            Some(actual) if actual == expected => {}
            Some(_) => return Err(paused("The remote branch changed since the last successful publication.")),
            None => return Err(paused("The previously published remote branch was deleted. Automatic publishing will not recreate it.")),
        }
    }
    let refspec = format!("{head_oid}:refs/heads/{remote_branch}");
    let mut args = vec![
        "push".into(),
        "--porcelain".into(),
        "--no-follow-tags".into(),
    ];
    if let Some(expected) = expected_remote_oid.as_deref() {
        // This exact lease is a compare-and-swap guard, never authorization to
        // rewrite history: verify_publish already proved head_oid descends from
        // expected. Bare --force and unqualified leases are never used.
        args.push(format!(
            "--force-with-lease=refs/heads/{remote_branch}:{expected}"
        ));
    }
    args.extend(["--".into(), binding.remote_url.clone(), refspec]);
    bounded_network_git(&repo, &args, "Git push").await?;
    let finish_repo = repo.clone();
    let finish_binding = binding.clone();
    let finish_branch = branch.clone();
    let finish_head = head_oid.clone();
    let finish_remote_branch = remote_branch.clone();
    let finish_floor = last_published_oid.clone();
    blocking_local(move || {
        verify_publish(
            &finish_repo,
            &finish_binding,
            &finish_branch,
            &finish_head,
            &finish_remote_branch,
            finish_floor.as_deref(),
        )?;
        establish_upstream(
            &finish_repo,
            &finish_binding,
            &finish_branch,
            &finish_head,
            &finish_remote_branch,
        )
    })
    .await?;
    Ok(GitPublishResult {
        published_oid: head_oid,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;

    fn run(cwd: &Path, args: &[&str]) -> String {
        let output = background_std_command("git")
            .current_dir(cwd)
            .args(args)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "git {}: {}",
            args.join(" "),
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).trim().to_string()
    }

    fn fixture() -> (PathBuf, PathBuf) {
        let root = env::temp_dir().join(format!("mythra-publish-test-{}", uuid::Uuid::new_v4()));
        let repo = root.join("repo");
        let bare = root.join("remote.git");
        fs::create_dir_all(&repo).unwrap();
        run(&root, &["init", "--bare", bare.to_str().unwrap()]);
        run(&repo, &["init", "-b", "main"]);
        run(&repo, &["config", "user.name", "Mythra Test"]);
        run(&repo, &["config", "user.email", "test@mythra.invalid"]);
        fs::write(repo.join("file.txt"), "one\n").unwrap();
        run(&repo, &["add", "file.txt"]);
        run(&repo, &["commit", "-m", "first"]);
        run(&repo, &["remote", "add", "origin", bare.to_str().unwrap()]);
        (root, repo)
    }

    fn install_rejecting_pre_push_hook(repo: &Path) {
        let hooks = repo.join("test-hooks");
        fs::create_dir_all(&hooks).unwrap();
        let hook = hooks.join("pre-push");
        fs::write(
            &hook,
            "#!/bin/sh\necho 'publication blocked by test hook' >&2\nexit 1\n",
        )
        .unwrap();
        #[cfg(unix)]
        fs::set_permissions(&hook, fs::Permissions::from_mode(0o755)).unwrap();
        run(repo, &["config", "core.hooksPath", hooks.to_str().unwrap()]);
    }

    #[test]
    fn validates_refs_and_oids_without_accepting_refspec_syntax() {
        assert!(valid_ref_component("topic/safe-name"));
        for bad in [
            "",
            "HEAD",
            "-oops",
            "bad..name",
            "bad:name",
            "bad name",
            "bad@{name",
            "topic/.hidden",
            "topic/name.lock",
            "@",
        ] {
            assert!(!valid_ref_component(bad), "{bad}");
        }
        assert!(valid_oid("0123456789012345678901234567890123456789"));
        assert!(valid_oid(&"a".repeat(64)));
        assert!(!valid_oid("main"));
    }

    #[test]
    fn classifies_only_transient_transport_and_auth_failures_for_retry() {
        assert!(
            classify_push_failure("fatal: unable to access: Could not resolve host")
                .starts_with("RETRY:")
        );
        assert!(classify_push_failure("rejected (non-fast-forward)").starts_with("PAUSED:"));
        assert!(classify_push_failure("protected branch hook declined").starts_with("PAUSED:"));
    }

    #[tokio::test]
    async fn publishes_an_immutable_sha_to_a_disposable_bare_remote() {
        let (root, repo) = fixture();
        run(&repo, &["branch", "must-not-publish"]);
        run(&repo, &["tag", "-a", "must-not-publish", "-m", "test tag"]);
        run(&repo, &["config", "push.followTags", "true"]);
        run(&repo, &["config", "remote.origin.mirror", "true"]);
        let snapshot = snapshot_sync(repo.to_str().unwrap()).unwrap();
        let branch = snapshot
            .branches
            .iter()
            .find(|branch| branch.name == "main")
            .unwrap();
        let expected = branch.head_oid.clone();
        let result = git_publish_commit(
            repo.to_string_lossy().into_owned(),
            snapshot.binding,
            "main".into(),
            expected.clone(),
            "main".into(),
            None,
            None,
        )
        .await
        .unwrap();
        assert_eq!(result.published_oid, expected);
        assert_eq!(
            run(&repo, &["ls-remote", "origin", "refs/heads/main"])
                .split_whitespace()
                .next(),
            Some(expected.as_str())
        );
        assert_eq!(
            run(&repo, &["rev-parse", "--abbrev-ref", "@{upstream}"]),
            "origin/main"
        );
        assert!(run(
            &repo,
            &["ls-remote", "origin", "refs/heads/must-not-publish"]
        )
        .is_empty());
        assert!(run(
            &repo,
            &["ls-remote", "origin", "refs/tags/must-not-publish"]
        )
        .is_empty());
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn refuses_a_rewritten_branch_before_contacting_the_remote() {
        let (root, repo) = fixture();
        let snapshot = snapshot_sync(repo.to_str().unwrap()).unwrap();
        let original = snapshot.branches[0].head_oid.clone();
        fs::write(repo.join("file.txt"), "two\n").unwrap();
        run(&repo, &["add", "file.txt"]);
        run(&repo, &["commit", "--amend", "-m", "rewritten"]);
        let error = git_publish_commit(
            repo.to_string_lossy().into_owned(),
            snapshot.binding,
            "main".into(),
            original,
            "main".into(),
            None,
            None,
        )
        .await
        .unwrap_err();
        assert!(
            error.starts_with("PAUSED: Branch main was rewritten"),
            "{error}"
        );
        assert!(run(&repo, &["ls-remote", "origin", "refs/heads/main"]).is_empty());
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn honors_a_rejecting_pre_push_hook_without_touching_the_remote() {
        let (root, repo) = fixture();
        install_rejecting_pre_push_hook(&repo);
        let snapshot = snapshot_sync(repo.to_str().unwrap()).unwrap();
        let oid = snapshot.branches[0].head_oid.clone();
        let error = git_publish_commit(
            repo.to_string_lossy().into_owned(),
            snapshot.binding,
            "main".into(),
            oid,
            "main".into(),
            None,
            None,
        )
        .await
        .unwrap_err();
        assert!(error.starts_with("PAUSED:"), "{error}");
        assert!(
            error.contains("publication blocked by test hook"),
            "{error}"
        );
        assert!(run(&repo, &["ls-remote", "origin", "refs/heads/main"]).is_empty());
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn refuses_duplicate_remote_targets_before_publishing_either_branch() {
        let (root, repo) = fixture();
        run(&repo, &["branch", "alpha"]);
        run(&repo, &["branch", "beta"]);
        for branch in ["alpha", "beta"] {
            run(
                &repo,
                &["config", &format!("branch.{branch}.remote"), "origin"],
            );
            run(
                &repo,
                &[
                    "config",
                    &format!("branch.{branch}.merge"),
                    "refs/heads/shared",
                ],
            );
        }
        let binding = GitPublishBinding {
            repository: "local/test-repository".into(),
            remote: "origin".into(),
            remote_url: root.join("remote.git").to_string_lossy().into_owned(),
            common_dir: git_common_dir(&repo)
                .unwrap()
                .to_string_lossy()
                .into_owned(),
        };
        let oid = run(&repo, &["rev-parse", "refs/heads/alpha"]);
        let error = git_publish_commit(
            repo.to_string_lossy().into_owned(),
            binding,
            "alpha".into(),
            oid,
            "shared".into(),
            None,
            None,
        )
        .await
        .unwrap_err();
        assert!(error.contains("both map to origin/shared"), "{error}");
        assert!(run(&repo, &["ls-remote", "origin", "refs/heads/shared"]).is_empty());
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn does_not_recreate_a_deleted_previously_published_remote_branch() {
        let (root, repo) = fixture();
        let snapshot = snapshot_sync(repo.to_str().unwrap()).unwrap();
        let binding = snapshot.binding.clone();
        let first = snapshot.branches[0].head_oid.clone();
        git_publish_commit(
            repo.to_string_lossy().into_owned(),
            binding.clone(),
            "main".into(),
            first.clone(),
            "main".into(),
            None,
            None,
        )
        .await
        .unwrap();
        run(
            &root,
            &[
                "--git-dir",
                root.join("remote.git").to_str().unwrap(),
                "update-ref",
                "-d",
                "refs/heads/main",
            ],
        );
        fs::write(repo.join("file.txt"), "two\n").unwrap();
        run(&repo, &["add", "file.txt"]);
        run(&repo, &["commit", "-m", "second"]);
        let second = run(&repo, &["rev-parse", "HEAD"]);
        let error = git_publish_commit(
            repo.to_string_lossy().into_owned(),
            binding,
            "main".into(),
            second,
            "main".into(),
            Some(first.clone()),
            Some(first),
        )
        .await
        .unwrap_err();
        assert!(error.contains("was deleted"), "{error}");
        assert!(run(&repo, &["ls-remote", "origin", "refs/heads/main"]).is_empty());
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn does_not_overwrite_a_remotely_rewritten_previously_published_branch() {
        let (root, repo) = fixture();
        let snapshot = snapshot_sync(repo.to_str().unwrap()).unwrap();
        let binding = snapshot.binding.clone();
        let first = snapshot.branches[0].head_oid.clone();
        git_publish_commit(
            repo.to_string_lossy().into_owned(),
            binding.clone(),
            "main".into(),
            first.clone(),
            "main".into(),
            None,
            None,
        )
        .await
        .unwrap();
        run(&repo, &["checkout", "-b", "remote-rewrite"]);
        fs::write(repo.join("other.txt"), "remote rewrite\n").unwrap();
        run(&repo, &["add", "other.txt"]);
        run(&repo, &["commit", "-m", "remote rewrite"]);
        let rewritten = run(&repo, &["rev-parse", "HEAD"]);
        run(
            &repo,
            &["push", "--force", "origin", "HEAD:refs/heads/main"],
        );
        run(&repo, &["checkout", "main"]);
        fs::write(repo.join("file.txt"), "local next\n").unwrap();
        run(&repo, &["add", "file.txt"]);
        run(&repo, &["commit", "-m", "local next"]);
        let intended = run(&repo, &["rev-parse", "HEAD"]);
        let error = git_publish_commit(
            repo.to_string_lossy().into_owned(),
            binding,
            "main".into(),
            intended,
            "main".into(),
            Some(first.clone()),
            Some(first),
        )
        .await
        .unwrap_err();
        assert!(error.contains("remote branch changed"), "{error}");
        assert_eq!(
            run(&repo, &["ls-remote", "origin", "refs/heads/main"])
                .split_whitespace()
                .next(),
            Some(rewritten.as_str())
        );
        fs::remove_dir_all(root).unwrap();
    }
}
