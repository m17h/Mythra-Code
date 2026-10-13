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
    path::{Path, PathBuf},
    time::Duration,
};

use serde::{Deserialize, Serialize};

use crate::{
    git_workspace::{
        bounded_git_output_with_prompt_policy, repository_lock, worktree_branch_paths_with_read,
    },
    github::parse_github_repository,
    project_git::{git_common_dir, git_stdout, optional_git_stdout, GitReadOperation},
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
    selected_repository_with_read(cwd, &GitReadOperation::new())
}

fn selected_repository_with_read(cwd: &str, read: &GitReadOperation) -> Result<PathBuf, String> {
    let selected = PathBuf::from(cwd)
        .canonicalize()
        .map_err(|error| paused(format!("Could not open the project folder: {error}")))?;
    let top = read
        .stdout(&selected, &["rev-parse", "--show-toplevel"])
        .map_err(paused)?;
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
            Err(paused(
                "Automatic publishing requires matching GitHub fetch and push URLs.",
            ))
        }
    }
}

fn current_remote(repo: &Path, read: &GitReadOperation) -> Result<String, String> {
    let configured = match read
        .optional_stdout(repo, &["symbolic-ref", "--short", "-q", "HEAD"])
        .map_err(paused)?
    {
        Some(branch) => read
            .optional_stdout(
                repo,
                &["config", "--get", &format!("branch.{branch}.remote")],
            )
            .map_err(paused)?,
        None => None,
    };
    Ok(configured
        .filter(|remote| !remote.is_empty())
        .unwrap_or_else(|| "origin".into()))
}

fn checked_out_branches(repo: &Path, read: &GitReadOperation) -> Result<HashSet<String>, String> {
    worktree_branch_paths_with_read(repo, read)
        .map(|paths| paths.into_keys().collect())
        .map_err(|error| paused(format!("Could not inspect repository worktrees: {error}")))
}

fn snapshot_sync(cwd: &str) -> Result<GitPublishSnapshot, String> {
    snapshot_with_read(cwd, &GitReadOperation::new())
}

fn snapshot_with_read(cwd: &str, read: &GitReadOperation) -> Result<GitPublishSnapshot, String> {
    let repo = selected_repository_with_read(cwd, read)?;
    let common_dir = read.common_dir(&repo).map_err(paused)?;
    let remote = current_remote(&repo, read)?;
    if !valid_ref_component(&remote) {
        return Err(paused("The configured Git remote name is invalid."));
    }
    let fetch_url = read
        .stdout(&repo, &["remote", "get-url", &remote])
        .map_err(paused)?;
    let pushes = read
        .stdout(&repo, &["remote", "get-url", "--push", "--all", &remote])
        .map_err(paused)?;
    let push_urls: Vec<_> = pushes
        .lines()
        .filter(|line| !line.trim().is_empty())
        .collect();
    if push_urls.len() != 1 {
        return Err(paused(format!(
            "Remote {remote} must have exactly one push URL before automatic publishing can run."
        )));
    }
    let push_url = push_urls[0].to_string();
    let repository = repository_identity(&fetch_url, &push_url)?;
    let checked_out = checked_out_branches(&repo, read)?;
    let rows = read.stdout(
        &repo,
        &[
            "for-each-ref",
            "--format=%(refname:strip=2)%00%(objectname)%00%(upstream:remotename)%00%(upstream:remoteref)",
            "refs/heads",
        ],
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
    if configured_upstream(repo, branch).is_none() {
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
    }
    // Explicit-URL pushes do not update a named remote's tracking refs. Ask
    // Git for its effective fetch mapping, including custom namespaces, and
    // record the exact published object after *every* successful publication.
    let tracking_ref = git_stdout(repo, &["for-each-ref", "--format=%(upstream)", &format!("refs/heads/{branch}")], None)
        .map_err(|error| paused(format!("The commit was published, but its local tracking mapping could not be inspected: {error}")))?;
    if tracking_ref.is_empty() {
        return Err(paused("The commit was published, but this remote has no local fetch mapping for the branch. Configure its tracking mapping and fetch before continuing automatic publication."));
    }
    git_stdout(repo, &["check-ref-format", &tracking_ref], None).map_err(|error| {
        paused(format!(
            "The commit was published, but its tracking ref is invalid: {error}"
        ))
    })?;
    if tracking_ref.starts_with("refs/heads/") {
        return Err(paused("The commit was published, but its fetch mapping targets a local branch. That branch was not rewritten; inspect the mapping before continuing automatic publication."));
    }
    if optional_git_stdout(repo, &["symbolic-ref", "--quiet", &tracking_ref]).is_some() {
        return Err(paused("The commit was published, but its remote tracking ref is symbolic. It was not rewritten; inspect the mapping before continuing automatic publication."));
    }
    let old = optional_git_stdout(repo, &["rev-parse", "--verify", &tracking_ref]);
    if old.as_deref() == Some(head_oid) {
        return Ok(());
    }
    // Another Git client may have fetched since the push. Never replace a
    // newer or divergent observation with the older commit we just sent.
    if let Some(current) = old.as_deref() {
        if !git_is_ancestor(repo, current, head_oid)? {
            return Err(paused("The commit was published, but the local remote-tracking ref advanced or changed. Refresh before continuing automatic publication."));
        }
    }
    let expected_old = old.unwrap_or_else(|| "0".repeat(head_oid.len()));
    // A symbolic ref introduced after the precheck must never redirect this
    // transaction into a local branch. The expected old value also protects
    // a direct ref changed by another Git client during the inspection.
    git_stdout(repo, &["update-ref", "--no-deref", &tracking_ref, head_oid, &expected_old], None)
        .map_err(|error| paused(format!("The commit was published, but its local remote-tracking ref could not be recorded: {error}")))?;
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

fn bounded_network_git(
    repo: &Path,
    args: &[String],
    action: &str,
) -> Result<(Vec<u8>, Vec<u8>), String> {
    bounded_network_git_with_timeout(repo, args, action, PUBLISH_TIMEOUT)
}

fn bounded_network_git_with_timeout(
    repo: &Path,
    args: &[String],
    action: &str,
    timeout: Duration,
) -> Result<(Vec<u8>, Vec<u8>), String> {
    let args: Vec<_> = args.iter().map(String::as_str).collect();
    // The same bounded process-group executor used for workspace commands
    // stops Git and hook/credential descendants on timeout. Preserve the
    // publication command's existing askpass policy and configured hooks.
    let (output, truncated) = bounded_git_output_with_prompt_policy(repo, &args, timeout, MAX_ERROR_CHARS, true, false)
        .map_err(|error| {
            if error.contains("timed out") {
                retry(format!("{action} timed out; the remote outcome may be unknown, so refresh before retrying."))
            } else {
                retry(format!("Could not finish {action}: {error}"))
            }
        })?;
    if truncated && args.first() == Some(&"ls-remote") {
        return Err(paused("Git returned too much remote identity output. Refresh before continuing automatic publication."));
    }
    if output.status.success() {
        Ok((output.stdout, output.stderr))
    } else {
        let detail = one_line(if output.stderr.is_empty() {
            &output.stdout
        } else {
            &output.stderr
        });
        Err(classify_push_failure(if detail.is_empty() {
            "Git rejected the network operation."
        } else {
            &detail
        }))
    }
}

fn remote_oid(
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
    let (stdout, _) = bounded_network_git(repo, &args, "Git remote inspection")?;
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
    let lock = repository_lock(&repo).await.map_err(paused)?;
    let guard = lock.lock_owned().await;
    blocking_local(move || {
        // The worker, not the awaiting renderer call, owns the lock. An
        // aborted caller cannot allow another mutation while Git is running.
        let _guard = guard;
        publish_sync(
            &repo,
            &binding,
            &branch,
            &head_oid,
            &remote_branch,
            last_published_oid.as_deref(),
            expected_remote_oid.as_deref(),
        )
    })
    .await
}

fn publish_sync(
    repo: &Path,
    binding: &GitPublishBinding,
    branch: &str,
    head_oid: &str,
    remote_branch: &str,
    last_published_oid: Option<&str>,
    expected_remote_oid: Option<&str>,
) -> Result<GitPublishResult, String> {
    if expected_remote_oid.is_some_and(|oid| !valid_oid(oid)) {
        return Err(paused("The expected remote commit identity is invalid."));
    }
    verify_publish(
        repo,
        binding,
        branch,
        head_oid,
        remote_branch,
        last_published_oid,
    )?;
    if let Some(expected) = expected_remote_oid {
        if !git_is_ancestor(repo, expected, head_oid)? {
            return Err(paused("The queued commit does not descend from the exact commit last published to this remote branch."));
        }
        match remote_oid(repo, &binding.remote_url, remote_branch)? {
            Some(actual) if actual == head_oid => {
                // A prior attempt may have reached GitHub before its local
                // process timed out. Treat the exact intended object as an
                // idempotent success and repair only the guarded local mapping.
                verify_publish(repo, binding, branch, head_oid, remote_branch, last_published_oid)?;
                establish_upstream(repo, binding, branch, head_oid, remote_branch)?;
                return Ok(GitPublishResult { published_oid: head_oid.to_string() });
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
    if let Some(expected) = expected_remote_oid {
        // This exact lease is a compare-and-swap guard, never authorization to
        // rewrite history: verify_publish already proved head_oid descends from
        // expected. Bare --force and unqualified leases are never used.
        args.push(format!(
            "--force-with-lease=refs/heads/{remote_branch}:{expected}"
        ));
    }
    args.extend(["--".into(), binding.remote_url.clone(), refspec]);
    bounded_network_git(repo, &args, "Git push")?;
    verify_publish(repo, binding, branch, head_oid, remote_branch, last_published_oid)
        .map_err(|error| paused(format!("The commit was pushed, but local verification could not finish: {error}. Refresh and inspect the remote before retrying.")))?;
    establish_upstream(repo, binding, branch, head_oid, remote_branch)?;
    Ok(GitPublishResult {
        published_oid: head_oid.to_string(),
    })
}
