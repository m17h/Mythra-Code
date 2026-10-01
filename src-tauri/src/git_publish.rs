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

#[cfg(test)]
use crate::process_launch::background_std_command;
use crate::{
    git_workspace::{
        bounded_git_output_with_prompt_policy, repository_lock, worktree_branch_paths,
    },
    github::parse_github_repository,
    project_git::{git_common_dir, git_stdout, optional_git_stdout},
};
#[cfg(test)]
use std::env;

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
            "--format=%(refname:strip=2)%00%(objectname)%00%(upstream:remotename)%00%(upstream:remoteref)",
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::git_workspace::{
        bounded_git_output_after_readiness, spawn_scoped_git, GitProcessScope,
    };
    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;
    use std::{fs, process::Stdio, time::Instant};

    const FIXTURE_STAGE_TIMEOUT: Duration = Duration::from_secs(30);
    const CLEANUP_TIMEOUT: Duration = Duration::from_millis(750);

    fn wait_for_stage(
        description: &str,
        mut ready: impl FnMut() -> Result<bool, String>,
    ) -> Result<(), String> {
        let deadline = Instant::now() + FIXTURE_STAGE_TIMEOUT;
        while !ready()? {
            if Instant::now() >= deadline {
                return Err(format!(
                    "fixture did not reach {description} within {FIXTURE_STAGE_TIMEOUT:?}"
                ));
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        Ok(())
    }

    fn install_controlled_hook(repo: &Path, background: bool, redirect: bool, gate_startup: bool) {
        let hook = repo.join(".git/hooks/pre-push");
        let redirection = if redirect {
            " </dev/null >/dev/null 2>&1"
        } else {
            ""
        };
        let finish = if background {
            "if [ \"$prefix\" = control ]; then wait; fi"
        } else {
            "wait"
        };
        let startup_gate = if gate_startup {
            "if [ \"$prefix\" = hook ]; then\n  attempt=0\n  while [ ! -f hook-start-release ] && [ \"$attempt\" -lt 1200 ]; do\n    sleep 0.1\n    attempt=$((attempt + 1))\n  done\n  test -f hook-start-release || exit 1\nfi\n"
        } else {
            ""
        };
        #[cfg(unix)]
        let child = "sh -c '\n  prefix=$1\n  printf %s \"$$\" > \"$prefix-pid\"\n  printf started > \"$prefix-started\"\n  attempt=0\n  while [ ! -f \"$prefix-release\" ] && [ \"$attempt\" -lt 1200 ]; do\n    sleep 0.1\n    attempt=$((attempt + 1))\n  done\n  test -f \"$prefix-release\" || exit 1\n  printf survived > \"$prefix-marker\"\n' fixture-child \"$prefix\"";
        #[cfg(windows)]
        let child = {
            // A native child gives the observer a real Windows PID rather
            // than Git Bash's separate MSYS process identifier.
            fs::write(
                repo.join("fixture-child.ps1"),
                r#"param([string]$Prefix)
$ErrorActionPreference = 'Stop'
[IO.File]::WriteAllText("$Prefix-pid", [string]$PID)
[IO.File]::WriteAllText("$Prefix-started", 'started')
$Deadline = [DateTime]::UtcNow.AddSeconds(120)
while (!(Test-Path "$Prefix-release")) {
  if ([DateTime]::UtcNow -gt $Deadline) { exit 1 }
  Start-Sleep -Milliseconds 100
}
[IO.File]::WriteAllText("$Prefix-marker", 'survived')
"#,
            )
            .unwrap();
            "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ./fixture-child.ps1 \"$prefix\""
        };
        // The deliberate one-second startup exceeds the former 750 ms limit.
        // The child then waits for an explicit release, independent of how
        // long Git startup or publication takes on the host.
        fs::write(&hook, format!(
            "#!/bin/sh\nif [ \"$1\" = fixture-control ]; then prefix=control; else prefix=hook; fi\n{startup_gate}sleep 1\n{child}{redirection} &\n{finish}\n"
        )).unwrap();
        #[cfg(unix)]
        fs::set_permissions(&hook, fs::Permissions::from_mode(0o755)).unwrap();
    }

    fn hook_descendant_is_running(repo: &Path) -> Result<bool, String> {
        let pid: u32 = fs::read_to_string(repo.join("hook-pid"))
            .map_err(|error| error.to_string())?
            .parse::<u32>()
            .map_err(|error| error.to_string())?;
        #[cfg(unix)]
        {
            if unsafe { libc::kill(pid as libc::pid_t, 0) } == 0 {
                return Ok(true);
            }
            let error = std::io::Error::last_os_error();
            if error.raw_os_error() == Some(libc::ESRCH) {
                Ok(false)
            } else {
                Err(error.to_string())
            }
        }
        #[cfg(windows)]
        {
            use windows_sys::Win32::{
                Foundation::{CloseHandle, ERROR_INVALID_PARAMETER},
                System::Threading::{
                    GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
                },
            };
            let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
            if handle.is_null() {
                let error = std::io::Error::last_os_error();
                return if error.raw_os_error() == Some(ERROR_INVALID_PARAMETER as i32) {
                    Ok(false)
                } else {
                    Err(error.to_string())
                };
            }
            let mut exit_code = 0;
            let queried = unsafe { GetExitCodeProcess(handle, &mut exit_code) };
            let error = std::io::Error::last_os_error();
            unsafe { CloseHandle(handle) };
            if queried == 0 {
                Err(error.to_string())
            } else {
                Ok(exit_code == 259)
            }
        }
    }

    struct HookControl {
        child: std::process::Child,
        scope: GitProcessScope,
    }

    impl HookControl {
        fn start(repo: &Path) -> Self {
            let mut command = background_std_command("git");
            command
                .current_dir(repo)
                .args([
                    "-c",
                    "alias.fixture-control=!sh .git/hooks/pre-push fixture-control",
                    "fixture-control",
                ])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null());
            let (child, scope) = spawn_scoped_git(&mut command).unwrap();
            let control = Self { child, scope };
            wait_for_stage("positive control hook readiness", || {
                Ok(repo.join("control-started").exists())
            })
            .unwrap();
            control
        }

        fn release_and_finish(&mut self, repo: &Path) {
            fs::write(repo.join("hook-release"), "released\n").unwrap();
            fs::write(repo.join("control-release"), "released\n").unwrap();
            wait_for_stage("positive control completion", || {
                self.child
                    .try_wait()
                    .map(|status| status.is_some())
                    .map_err(|error| error.to_string())
            })
            .unwrap();
            assert!(
                self.child.wait().unwrap().success(),
                "positive control hook failed"
            );
            assert!(
                repo.join("control-marker").exists(),
                "the unexpired control must observe release and write its marker"
            );
            // Wait for the tested descendant itself. The control could be
            // scheduled first, so its marker alone cannot rule out a late
            // write from a surviving tested hook.
            wait_for_stage("tested hook descendant exit", || {
                hook_descendant_is_running(repo).map(|running| !running)
            })
            .unwrap();
        }
    }

    impl Drop for HookControl {
        fn drop(&mut self) {
            self.scope
                .stop(&mut self.child, "fixture control cleanup".into());
        }
    }

    fn gated_push_timeout(
        repo: &Path,
        args: &[String],
        ready: impl FnOnce(&mut std::process::Child) -> Result<(), String>,
    ) -> String {
        let args: Vec<_> = args.iter().map(String::as_str).collect();
        let error =
            bounded_git_output_after_readiness(repo, &args, CLEANUP_TIMEOUT, ready).unwrap_err();
        assert!(error.contains("timed out"), "{error}");
        assert!(!error.contains("Could not confirm"), "{error}");
        error
    }

    #[test]
    fn timed_out_publication_stops_its_hook_descendants() {
        let (root, repo) = fixture();
        let remote = root.join("remote.git");
        install_controlled_hook(&repo, false, false, true);
        let args = vec![
            "push".into(),
            "--".into(),
            remote.to_string_lossy().into_owned(),
            "refs/heads/main:refs/heads/main".into(),
        ];
        // Reproduce the old fixture flaw under controlled startup latency:
        // the absolute deadline expires before there is any hook descendant.
        let error = bounded_network_git_with_timeout(&repo, &args, "Git push", CLEANUP_TIMEOUT)
            .unwrap_err();
        assert!(error.contains("timed out"), "{error}");
        assert!(
            !repo.join("hook-started").exists(),
            "delayed startup must exceed the old timeout"
        );
        fs::write(repo.join("hook-start-release"), "released\n").unwrap();
        let mut control = HookControl::start(&repo);
        gated_push_timeout(&repo, &args, |child| {
            wait_for_stage("running hook descendant", || {
                if child
                    .try_wait()
                    .map_err(|error| error.to_string())?
                    .is_some()
                {
                    return Err("Git exited before the held hook became ready".into());
                }
                Ok(repo.join("hook-started").exists())
            })
        });
        assert!(repo.join("hook-started").exists());
        control.release_and_finish(&repo);
        assert!(
            !repo.join("hook-marker").exists(),
            "a pre-push descendant survived the publication timeout"
        );
        drop(control);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn publication_timeout_after_parent_exit_stops_pipe_holding_hook_descendants() {
        let (root, repo) = fixture();
        let remote = root.join("remote.git");
        let head = run(&repo, &["rev-parse", "refs/heads/main"]);
        install_controlled_hook(&repo, true, false, false);
        let mut control = HookControl::start(&repo);
        let args = vec![
            "push".into(),
            "--".into(),
            remote.to_string_lossy().into_owned(),
            "refs/heads/main:refs/heads/main".into(),
        ];
        gated_push_timeout(&repo, &args, |child| {
            wait_for_stage(
                "published ref and exited Git parent with inherited pipes",
                || {
                    let exited = child
                        .try_wait()
                        .map_err(|error| error.to_string())?
                        .is_some_and(|status| status.success());
                    let published = fs::read_to_string(remote.join("refs/heads/main"))
                        .is_ok_and(|oid| oid.trim() == head);
                    Ok(exited && published && repo.join("hook-started").exists())
                },
            )
        });
        assert!(repo.join("hook-started").exists());
        assert!(
            run(&repo, &["ls-remote", "origin", "refs/heads/main"]).starts_with(&head),
            "this fixture must reach successful publication before its inherited pipes time out"
        );
        control.release_and_finish(&repo);
        let survived = repo.join("hook-marker").exists();
        drop(control);
        fs::remove_dir_all(root).unwrap();
        assert!(
            !survived,
            "a pipe-holding hook descendant survived after parent Git exited"
        );
    }

    #[test]
    fn successful_publication_preserves_a_hooks_intended_background_work() {
        let (root, repo) = fixture();
        install_controlled_hook(&repo, true, true, false);
        let args = vec![
            "push".into(),
            "--".into(),
            root.join("remote.git").to_string_lossy().into_owned(),
            "refs/heads/main:refs/heads/main".into(),
        ];
        bounded_network_git_with_timeout(&repo, &args, "Git push", PUBLISH_TIMEOUT).unwrap();
        wait_for_stage("detached successful hook readiness", || {
            Ok(repo.join("hook-started").exists())
        })
        .unwrap();
        assert!(!repo.join("hook-marker").exists());
        // Release only after the successful executor has dropped its scope.
        fs::write(repo.join("hook-release"), "released\n").unwrap();
        wait_for_stage(
            "successful background hook completion after scope closure",
            || Ok(repo.join("hook-marker").exists()),
        )
        .unwrap();
        assert!(
            repo.join("hook-marker").exists(),
            "normal successful hooks must not be killed when their job scope is closed"
        );
        fs::remove_dir_all(root).unwrap();
    }

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
    fn publication_tracking_refuses_symbolic_local_branch_targets() {
        let (root, repo) = fixture();
        let before = run(&repo, &["rev-parse", "HEAD"]);
        run(&repo, &["branch", "victim"]);
        fs::write(repo.join("file.txt"), "published change\n").unwrap();
        run(&repo, &["add", "-A"]);
        run(&repo, &["commit", "-m", "next"]);
        let next = run(&repo, &["rev-parse", "HEAD"]);
        run(&repo, &["config", "branch.main.remote", "origin"]);
        run(&repo, &["config", "branch.main.merge", "refs/heads/main"]);
        run(
            &repo,
            &[
                "symbolic-ref",
                "refs/remotes/origin/main",
                "refs/heads/victim",
            ],
        );
        let binding = snapshot_sync(repo.to_str().unwrap()).unwrap().binding;
        let result = establish_upstream(&repo, &binding, "main", &next, "main");
        assert!(
            result.is_err(),
            "symbolic tracking target was rewritten: {result:?}"
        );
        assert_eq!(run(&repo, &["rev-parse", "victim"]), before);
        assert_eq!(
            run(&repo, &["symbolic-ref", "refs/remotes/origin/main"]),
            "refs/heads/victim"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn publication_tracking_does_not_rewind_a_newer_fetched_commit() {
        let (root, repo) = fixture();
        let published = run(&repo, &["rev-parse", "HEAD"]);
        run(&repo, &["config", "branch.main.remote", "origin"]);
        run(&repo, &["config", "branch.main.merge", "refs/heads/main"]);
        fs::write(repo.join("file.txt"), "newer remote change\n").unwrap();
        run(&repo, &["add", "-A"]);
        run(&repo, &["commit", "-m", "newer"]);
        let newer = run(&repo, &["rev-parse", "HEAD"]);
        run(&repo, &["update-ref", "refs/remotes/origin/main", &newer]);
        let binding = snapshot_sync(repo.to_str().unwrap()).unwrap().binding;
        let result = establish_upstream(&repo, &binding, "main", &published, "main");
        assert!(result.unwrap_err().contains("advanced or changed"));
        assert_eq!(
            run(&repo, &["rev-parse", "refs/remotes/origin/main"]),
            newer
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn publication_tracking_records_normal_and_missing_refs() {
        for existing in [false, true] {
            let (root, repo) = fixture();
            let before = run(&repo, &["rev-parse", "HEAD"]);
            if existing {
                run(&repo, &["update-ref", "refs/remotes/origin/main", &before]);
            }
            fs::write(repo.join("file.txt"), "published change\n").unwrap();
            run(&repo, &["add", "-A"]);
            run(&repo, &["commit", "-m", "next"]);
            let next = run(&repo, &["rev-parse", "HEAD"]);
            let binding = snapshot_sync(repo.to_str().unwrap()).unwrap().binding;
            establish_upstream(&repo, &binding, "main", &next, "main").unwrap();
            assert_eq!(run(&repo, &["rev-parse", "refs/remotes/origin/main"]), next);
            assert_eq!(run(&repo, &["config", "branch.main.remote"]), "origin");
            assert_eq!(
                run(&repo, &["config", "branch.main.merge"]),
                "refs/heads/main"
            );
            fs::remove_dir_all(root).unwrap();
        }
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

    #[test]
    fn snapshot_keeps_branch_names_unambiguous_when_a_tag_has_the_same_name() {
        let (root, repo) = fixture();
        run(&repo, &["tag", "main"]);
        let snapshot = snapshot_sync(repo.to_str().unwrap()).unwrap();
        assert_eq!(snapshot.branches[0].name, "main");
        assert!(snapshot.branches[0].checked_out);
        let oid = snapshot.branches[0].head_oid.clone();
        publish_sync(
            &repo,
            &snapshot.binding,
            "main",
            &oid,
            "main",
            Some(&oid),
            None,
        )
        .unwrap();
        assert!(run(&repo, &["ls-remote", "origin", "refs/heads/main"]).starts_with(&oid));
        assert!(run(&repo, &["ls-remote", "origin", "refs/tags/main"]).is_empty());
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn caller_cancellation_keeps_the_repository_locked_until_publication_finishes() {
        let (root, repo) = fixture();
        let snapshot = snapshot_sync(repo.to_str().unwrap()).unwrap();
        let oid = snapshot.branches[0].head_oid.clone();
        let hook = repo.join(".git/hooks/pre-push");
        fs::write(
            &hook,
            "#!/bin/sh\nprintf started > publication-started\nattempt=0\nwhile [ ! -f publication-release ] && [ \"$attempt\" -lt 1200 ]; do\n  sleep 0.1\n  attempt=$((attempt + 1))\ndone\ntest -f publication-release || exit 1\nprintf released > publication-release-observed\n",
        )
        .unwrap();
        #[cfg(unix)]
        fs::set_permissions(&hook, fs::Permissions::from_mode(0o755)).unwrap();
        let lock = repository_lock(&repo).await.unwrap();
        let cwd = repo.to_string_lossy().into_owned();
        let worker_oid = oid.clone();
        let task = tokio::spawn(async move {
            git_publish_commit(
                cwd,
                snapshot.binding,
                "main".into(),
                worker_oid.clone(),
                "main".into(),
                Some(worker_oid),
                None,
            )
            .await
        });
        // Windows starts several Git processes before reaching the hook. Wait
        // for the hook itself, then hold it open until after the lock check.
        let deadline = Instant::now() + FIXTURE_STAGE_TIMEOUT;
        while !repo.join("publication-started").exists() {
            if task.is_finished() {
                panic!(
                    "publication finished before its pre-push hook: {:?}",
                    task.await
                );
            }
            assert!(
                Instant::now() < deadline,
                "publication did not reach its pre-push hook"
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        task.abort();
        let _ = task.await;
        assert!(
            tokio::time::timeout(Duration::from_millis(100), lock.lock())
                .await
                .is_err(),
            "caller cancellation released the mutation lock while Git was running"
        );
        fs::write(repo.join("publication-release"), "released\n").unwrap();
        for (stage, marker) in [
            (
                "hook release acknowledgement",
                repo.join("publication-release-observed"),
            ),
            (
                "remote ref publication",
                root.join("remote.git/refs/heads/main"),
            ),
        ] {
            tokio::time::timeout(FIXTURE_STAGE_TIMEOUT, async {
                loop {
                    let ready = if stage == "remote ref publication" {
                        fs::read_to_string(&marker).is_ok_and(|published| published.trim() == oid)
                    } else {
                        marker.exists()
                    };
                    if ready {
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(20)).await;
                }
            })
            .await
            .unwrap_or_else(|_| panic!("cancelled publication did not reach {stage}"));
        }
        // After the push, the worker still verifies the binding and records
        // tracking refs using multiple Git commands. Give that real lifecycle
        // its native budget, with the preceding phases diagnosed separately.
        let guard = tokio::time::timeout(PUBLISH_TIMEOUT, lock.lock())
            .await
            .expect("publication completed remotely but its worker did not finish verification and release the repository lock");
        assert!(run(&repo, &["ls-remote", "origin", "refs/heads/main"]).starts_with(&oid));
        assert_eq!(run(&repo, &["rev-parse", "refs/remotes/origin/main"]), oid);
        assert_eq!(run(&repo, &["config", "branch.main.remote"]), "origin");
        assert_eq!(
            run(&repo, &["config", "branch.main.merge"]),
            "refs/heads/main"
        );
        drop(guard);
        fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn later_publication_updates_an_existing_upstream_and_custom_fetch_mapping() {
        for namespace in ["origin", "custom"] {
            let (root, repo) = fixture();
            let mapping = format!("+refs/heads/*:refs/remotes/{namespace}/*");
            run(&repo, &["config", "remote.origin.fetch", &mapping]);
            run(&repo, &["push", "-u", "origin", "main"]);
            run(&repo, &["fetch", "origin"]);
            let original = run(&repo, &["rev-parse", "refs/heads/main"]);
            fs::write(repo.join("file.txt"), "second\n").unwrap();
            run(&repo, &["add", "file.txt"]);
            run(&repo, &["commit", "-m", "second"]);
            let next = run(&repo, &["rev-parse", "refs/heads/main"]);
            let snapshot = snapshot_sync(repo.to_str().unwrap()).unwrap();
            git_publish_commit(
                repo.to_string_lossy().into_owned(),
                snapshot.binding,
                "main".into(),
                next.clone(),
                "main".into(),
                Some(original.clone()),
                Some(original),
            )
            .await
            .unwrap();
            assert_eq!(
                run(
                    &repo,
                    &["rev-parse", &format!("refs/remotes/{namespace}/main")]
                ),
                next
            );
            assert_eq!(
                run(
                    &repo,
                    &["rev-list", "--left-right", "--count", "HEAD...@{upstream}"]
                ),
                "0\t0"
            );
            fs::remove_dir_all(root).unwrap();
        }
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
