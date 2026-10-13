use std::{
    env,
    path::{Path, PathBuf},
    process::Stdio,
};

use super::{find_on_path, find_with_login_shell, git_stdout, optional_git_stdout, push_candidate};
use crate::process_launch::background_command;
use serde::Serialize;
use serde_json::Value;
use tauri::AppHandle;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct GitHubAccountStatus {
    pub(super) available: bool,
    pub(super) authenticated: bool,
    pub(super) path: Option<String>,
    pub(super) version: Option<String>,
    pub(super) login: Option<String>,
    pub(super) name: Option<String>,
    pub(super) email: Option<String>,
    pub(super) avatar_url: Option<String>,
    pub(super) profile_url: Option<String>,
    pub(super) error: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct GitHubRepoStatus {
    pub(super) is_repo: bool,
    pub(super) remote_url: Option<String>,
    pub(super) repository: Option<String>,
    pub(super) branch: Option<String>,
    pub(super) upstream: Option<String>,
    pub(super) ahead: usize,
    pub(super) behind: usize,
}

/// App-owned GitHub operations always refer to the github.com identity shown
/// in Settings, independently of an inherited enterprise CLI default.
pub(super) fn github_command(path: &Path) -> tokio::process::Command {
    let mut command = background_command(path);
    command
        .env("GH_HOST", "github.com")
        .env("GH_PROMPT_DISABLED", "1")
        .env_remove("GH_REPO");
    command
}

pub(super) async fn resolve_github_binary(app: &AppHandle) -> Result<PathBuf, String> {
    let executable_name = if cfg!(windows) { "gh.exe" } else { "gh" };
    let legacy_override = concat!("OPEN", "KIWI_GH_PATH");
    if let Some(override_path) =
        env::var_os("MYTHRA_CODE_GH_PATH").or_else(|| env::var_os(legacy_override))
    {
        let override_path = PathBuf::from(override_path);
        return override_path
            .is_file()
            .then_some(override_path)
            .ok_or_else(|| {
                "MYTHRA_CODE_GH_PATH does not point to a GitHub CLI executable.".into()
            });
    }
    let mut candidates = Vec::new();
    if let Some(candidate) = find_on_path(executable_name).await {
        push_candidate(&mut candidates, candidate);
    }
    #[cfg(target_os = "macos")]
    {
        push_candidate(&mut candidates, PathBuf::from("/opt/homebrew/bin/gh"));
        push_candidate(&mut candidates, PathBuf::from("/usr/local/bin/gh"));
    }
    #[cfg(windows)]
    {
        // Installers update the registered PATH, not the environment inherited
        // by an already-running desktop app. Check common locations first to
        // avoid launching PowerShell on the normal refresh path.
        for variable in ["ProgramFiles", "ProgramFiles(x86)"] {
            if let Some(root) = env::var_os(variable) {
                push_candidate(
                    &mut candidates,
                    PathBuf::from(root).join("GitHub CLI/gh.exe"),
                );
            }
        }
        if let Some(root) = env::var_os("LOCALAPPDATA").map(PathBuf::from) {
            push_candidate(&mut candidates, root.join("Programs/GitHub CLI/gh.exe"));
            push_candidate(&mut candidates, root.join("Microsoft/WinGet/Links/gh.exe"));
        }
    }
    if let Ok(home) = crate::release_qa::home_dir(app) {
        for relative in [".local/bin", ".cargo/bin", ".npm-global/bin"] {
            push_candidate(&mut candidates, home.join(relative).join(executable_name));
        }
        #[cfg(windows)]
        push_candidate(&mut candidates, home.join("scoop/shims/gh.exe"));
    }
    if let Some(candidate) = candidates.into_iter().find(|candidate| candidate.is_file()) {
        return Ok(candidate);
    }
    #[cfg(windows)]
    if let Some(candidate) = find_github_on_registered_windows_path().await {
        return Ok(candidate);
    }
    if let Some(candidate) = find_with_login_shell(executable_name).await {
        return Ok(candidate);
    }
    Err("GitHub CLI is not installed. Install it from cli.github.com, then refresh GitHub settings.".into())
}

#[cfg(windows)]
fn github_on_windows_paths(paths: &[String]) -> Option<PathBuf> {
    paths
        .iter()
        .flat_map(|path| path.split(';'))
        .map(|directory| directory.trim().trim_matches('"'))
        .filter(|directory| !directory.is_empty())
        .map(|directory| PathBuf::from(directory).join("gh.exe"))
        .find(|candidate| candidate.is_file())
}

#[cfg(windows)]
fn registered_windows_path_command() -> tokio::process::Command {
    // Read both scopes on every miss. Do not mutate the app's global PATH:
    // unrelated provider/terminal launches may be running concurrently.
    // Use the system binary directly: a sparse/stale PATH may not contain
    // PowerShell either (and discovery should not run a same-named user shim).
    let powershell = env::var_os("SystemRoot")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(r"C:\Windows"))
        .join("System32/WindowsPowerShell/v1.0/powershell.exe");
    let mut command = background_command(powershell);
    command.args([
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "$ErrorActionPreference = 'Stop'; [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false); $paths = @([Environment]::GetEnvironmentVariable('Path', 'Machine'), [Environment]::GetEnvironmentVariable('Path', 'User')) | ForEach-Object { [Environment]::ExpandEnvironmentVariables([string]$_) }; ConvertTo-Json -Compress -InputObject @($paths)",
    ]);
    command
}

#[cfg(windows)]
async fn find_github_on_registered_windows_path() -> Option<PathBuf> {
    let output = github_probe_output_with_timeout(
        registered_windows_path_command(),
        super::RUNTIME_PROBE_TIMEOUT,
    )
    .await
    .ok()?;
    if !output.status.success() {
        return None;
    }
    let paths: Vec<String> = serde_json::from_slice(&output.stdout).ok()?;
    github_on_windows_paths(&paths)
}

async fn github_probe_output(
    command: tokio::process::Command,
) -> Result<std::process::Output, String> {
    github_probe_output_with_timeout(command, std::time::Duration::from_secs(15)).await
}

async fn github_probe_output_with_timeout(
    mut command: tokio::process::Command,
    limit: std::time::Duration,
) -> Result<std::process::Output, String> {
    command.stdin(Stdio::null()).kill_on_drop(true);
    tokio::time::timeout(limit, command.output())
        .await
        .map_err(|_| "GitHub status check timed out".to_string())?
        .map_err(|error| format!("Could not check GitHub status: {error}"))
}

#[tauri::command]
pub(super) async fn github_status(app: AppHandle) -> GitHubAccountStatus {
    let path = match resolve_github_binary(&app).await {
        Ok(path) => path,
        Err(error) => {
            return GitHubAccountStatus {
                available: false,
                authenticated: false,
                path: None,
                version: None,
                login: None,
                name: None,
                email: None,
                avatar_url: None,
                profile_url: None,
                error: Some(error),
            };
        }
    };
    github_status_at(&path).await
}

async fn github_status_at(path: &Path) -> GitHubAccountStatus {
    let mut version_command = github_command(path);
    version_command.arg("--version");
    let version = github_probe_output(version_command)
        .await
        .ok()
        .and_then(|output| {
            output.status.success().then(|| {
                String::from_utf8_lossy(&output.stdout)
                    .lines()
                    .next()
                    .unwrap_or_default()
                    .trim()
                    .to_string()
            })
        })
        .filter(|value| !value.is_empty());
    // `auth status` checks every stored account on older CLI versions; an
    // expired inactive account must not disable the active account. `api user`
    // uses the active credentials and also supplies the profile in one request,
    // without depending on newer --active or auth-status JSON flags.
    let mut user_command = github_command(path);
    user_command.args(["api", "--hostname", "github.com", "--method", "GET", "user"]);
    let user = match github_probe_output(user_command).await {
        Ok(output) if output.status.success() => serde_json::from_slice::<Value>(&output.stdout)
            .map_err(|error| format!("GitHub returned invalid account data: {error}"))
            .and_then(|value| {
                value
                    .get("login")
                    .and_then(Value::as_str)
                    .filter(|login| !login.is_empty())
                    .ok_or_else(|| "GitHub did not report the active account login.".to_string())?;
                Ok(value)
            }),
        Ok(output) => Err(String::from_utf8_lossy(&output.stderr).trim().to_string()),
        Err(error) => Err(error),
    };
    let user = match user {
        Ok(user) => user,
        Err(detail) => {
            let error = if detail.contains("HTTP 401") || detail.contains("401 Unauthorized") {
                format!("GitHub rejected the active github.com credentials. Sign in again, then refresh GitHub settings. {detail}")
            } else {
                format!("Could not verify the active github.com account. Refresh GitHub settings to try again; saved credentials were not changed. {detail}")
            };
            return GitHubAccountStatus {
                available: true,
                authenticated: false,
                path: Some(path.to_string_lossy().into_owned()),
                version,
                login: None,
                name: None,
                email: None,
                avatar_url: None,
                profile_url: None,
                error: Some(error.trim().to_string()),
            };
        }
    };
    GitHubAccountStatus {
        available: true,
        authenticated: true,
        path: Some(path.to_string_lossy().into_owned()),
        version,
        login: user
            .get("login")
            .and_then(Value::as_str)
            .map(str::to_string),
        name: user.get("name").and_then(Value::as_str).map(str::to_string),
        email: user
            .get("email")
            .and_then(Value::as_str)
            .map(str::to_string),
        avatar_url: user
            .get("avatar_url")
            .and_then(Value::as_str)
            .map(str::to_string),
        profile_url: user
            .get("html_url")
            .and_then(Value::as_str)
            .map(str::to_string),
        error: None,
    }
}

#[tauri::command]
pub(super) async fn github_login(app: AppHandle) -> Result<(), String> {
    let path = resolve_github_binary(&app).await?;
    #[cfg(target_os = "macos")]
    {
        let escaped = path.to_string_lossy().replace('\'', "'\"'\"'");
        let login_command = format!(
            "'{}' auth login --hostname github.com --git-protocol https --web",
            escaped
        );
        let status = background_command("/usr/bin/osascript")
            .args([
                "-e",
                "on run argv",
                "-e",
                "tell application \"Terminal\"",
                "-e",
                "activate",
                "-e",
                "do script (item 1 of argv)",
                "-e",
                "end tell",
                "-e",
                "end run",
                "--",
            ])
            .arg(login_command)
            .status()
            .await
            .map_err(|error| format!("Could not open GitHub sign-in in Terminal: {error}"))?;
        status.success().then_some(()).ok_or_else(|| {
            "Could not open GitHub sign-in. Run `gh auth login` yourself, then refresh GitHub settings.".into()
        })
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = path;
        Err("Run `gh auth login --hostname github.com --git-protocol https --web` in a terminal, then refresh GitHub settings.".into())
    }
}

pub(super) fn parse_github_repository(remote: &str) -> Option<String> {
    let trimmed = remote.trim().trim_end_matches('/');
    let path = if let Some(value) = trimmed.strip_prefix("git@github.com:") {
        value
    } else if let Some(value) = trimmed.strip_prefix("ssh://git@github.com/") {
        value
    } else if let Some(value) = trimmed.strip_prefix("ssh://git@ssh.github.com:443/") {
        value
    } else if let Some(value) = trimmed.strip_prefix("https://github.com/") {
        value
    } else {
        trimmed.strip_prefix("http://github.com/")?
    };
    let mut parts = path.split('/');
    let owner = parts.next()?;
    let repo = parts.next()?;
    let repo = repo.strip_suffix(".git").unwrap_or(repo);
    let valid_owner = !owner.is_empty()
        && owner.len() <= 39
        && owner.as_bytes()[0].is_ascii_alphanumeric()
        && owner
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-');
    let valid_repo = !repo.is_empty()
        && repo.len() <= 100
        && !matches!(repo, "." | "..")
        && repo
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'));
    (parts.next().is_none() && valid_owner && valid_repo).then(|| format!("{owner}/{repo}"))
}

fn normalize_github_remote_url(input: &str) -> Option<String> {
    let value = input.trim();
    if value.chars().any(char::is_control) {
        return None;
    }
    // Browser tabs append query strings and fragments. They are not part of
    // the Git address and must never be persisted in origin.
    let value = value.split(['?', '#']).next()?;
    let repository = parse_github_repository(value)?;
    Some(if value.starts_with("ssh://git@ssh.github.com:443/") {
        format!("ssh://git@ssh.github.com:443/{repository}.git")
    } else if value.starts_with("git@") || value.starts_with("ssh://") {
        format!("git@github.com:{repository}.git")
    } else {
        format!("https://github.com/{repository}.git")
    })
}

pub(super) fn validate_github_repository_name(name: &str) -> Result<(), String> {
    let valid = !name.is_empty()
        && name.len() <= 100
        && !matches!(name, "." | "..")
        && !name.starts_with('-')
        && name.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-')
        });
    valid.then_some(()).ok_or_else(|| {
        "Repository name must be 1–100 characters using only letters, numbers, periods, underscores, or hyphens, and cannot begin with a hyphen.".into()
    })
}

pub(super) fn github_remote_url(cwd: &Path, remote: &str) -> Option<String> {
    optional_git_stdout(
        cwd,
        &["config", "--get-all", &format!("remote.{remote}.url")],
    )
}

pub(super) fn github_repo_status_sync(cwd: &str) -> Result<GitHubRepoStatus, String> {
    github_repo_status_with_read(cwd, &crate::project_git::GitReadOperation::new())
}

fn github_repo_status_with_read(
    cwd: &str,
    read: &crate::project_git::GitReadOperation,
) -> Result<GitHubRepoStatus, String> {
    let selected = PathBuf::from(cwd)
        .canonicalize()
        .map_err(|error| format!("Could not open the project folder: {error}"))?;
    if !read
        .output(&selected, &["rev-parse", "--show-toplevel"])?
        .status
        .success()
    {
        return Ok(GitHubRepoStatus {
            is_repo: false,
            remote_url: None,
            repository: None,
            branch: None,
            upstream: None,
            ahead: 0,
            behind: 0,
        });
    }
    // Preserve the configured identity, independently of transport rewrites.
    // get-url expands url.*.insteadOf, which can mask a GitHub origin behind a
    // local/credential transport and break safe native push binding. Reading
    // all values also prevents treating multiple origin URLs as one target.
    let remote_url =
        read.optional_stdout(&selected, &["config", "--get-all", "remote.origin.url"])?;
    let branch = read.optional_stdout(&selected, &["symbolic-ref", "--short", "-q", "HEAD"])?;
    let upstream = match branch.as_deref() {
        Some(branch) => read.optional_stdout(
            &selected,
            &[
                "for-each-ref",
                "--format=%(upstream:short)",
                &format!("refs/heads/{branch}"),
            ],
        )?,
        None => None,
    };
    let (ahead, behind) = if upstream.is_some() {
        let counts = read.stdout(
            &selected,
            &["rev-list", "--left-right", "--count", "HEAD...@{upstream}"],
        )?;
        let mut parts = counts.split_whitespace();
        let invalid = || "Git returned invalid ahead/behind counts".to_string();
        let ahead = parts
            .next()
            .ok_or_else(invalid)?
            .parse()
            .map_err(|_| invalid())?;
        let behind = parts
            .next()
            .ok_or_else(invalid)?
            .parse()
            .map_err(|_| invalid())?;
        if parts.next().is_some() {
            return Err(invalid());
        }
        (ahead, behind)
    } else {
        (0, 0)
    };
    Ok(GitHubRepoStatus {
        is_repo: true,
        repository: remote_url.as_deref().and_then(parse_github_repository),
        remote_url,
        branch,
        upstream,
        ahead,
        behind,
    })
}

#[tauri::command]
pub(super) async fn github_repo_status(cwd: String) -> Result<GitHubRepoStatus, String> {
    tauri::async_runtime::spawn_blocking(move || github_repo_status_sync(&cwd))
        .await
        .map_err(|error| format!("GitHub repository inspection failed: {error}"))?
}

pub(super) fn github_attach_remote_sync(cwd: &str, url: &str) -> Result<GitHubRepoStatus, String> {
    let url = normalize_github_remote_url(url).ok_or_else(|| {
        "Enter a GitHub repository URL such as https://github.com/owner/repository.git".to_string()
    })?;
    let selected = github_connection_target(cwd)?;
    git_stdout(&selected, &["remote", "add", "origin", &url], None)?;
    github_repo_status_sync(cwd)
}

fn github_connection_target(cwd: &str) -> Result<PathBuf, String> {
    let selected = PathBuf::from(cwd)
        .canonicalize()
        .map_err(|error| format!("Could not open the project folder: {error}"))?;
    let root = git_stdout(&selected, &["rev-parse", "--show-toplevel"], None).map_err(|error| {
        format!("Open a local Git repository before connecting GitHub. {error}")
    })?;
    let root = PathBuf::from(root)
        .canonicalize()
        .map_err(|error| format!("Could not open the Git repository: {error}"))?;
    if selected != root {
        return Err("Open the Git repository root before connecting GitHub. This project folder belongs to an enclosing repository.".into());
    }
    // An origin can exist without a fetch URL. Checking get-url would allow
    // creation on GitHub before Git refuses to add the existing local remote.
    let remotes = git_stdout(&selected, &["remote"], None)?;
    if remotes.lines().any(|remote| remote == "origin") {
        return Err("This project already has an origin remote. Remove or change it in Git before attaching another repository.".into());
    }
    Ok(selected)
}

#[tauri::command]
pub(super) async fn github_attach_remote(
    cwd: String,
    url: String,
) -> Result<GitHubRepoStatus, String> {
    let lock = crate::git_workspace::repository_lock(Path::new(&cwd)).await?;
    let guard = lock.lock_owned().await;
    tauri::async_runtime::spawn_blocking(move || {
        // The blocking task owns the guard even if its awaiting command is
        // cancelled: another mutation cannot race the remaining Git work.
        let _guard = guard;
        github_attach_remote_sync(&cwd, &url)
    })
    .await
    .map_err(|error| format!("GitHub remote task failed: {error}"))?
}

#[tauri::command]
pub(super) async fn github_create_repository(
    app: AppHandle,
    cwd: String,
    name: String,
    visibility: String,
) -> Result<GitHubRepoStatus, String> {
    // Local validation runs before resolving or invoking the external CLI.
    validate_github_repository_name(&name)?;
    if visibility != "private" && visibility != "public" {
        return Err("Repository visibility must be private or public.".into());
    }
    let target_cwd = cwd.clone();
    let selected =
        tauri::async_runtime::spawn_blocking(move || github_connection_target(&target_cwd))
            .await
            .map_err(|error| format!("GitHub repository inspection failed: {error}"))??;
    let path = resolve_github_binary(&app).await?;
    github_create_repository_at(&path, &selected, &name, &visibility).await
}

async fn github_create_repository_at(
    path: &Path,
    selected: &Path,
    name: &str,
    visibility: &str,
) -> Result<GitHubRepoStatus, String> {
    validate_github_repository_name(name)?;
    if !matches!(visibility, "private" | "public") {
        return Err("Repository visibility must be private or public.".into());
    }
    let lock = crate::git_workspace::repository_lock(selected).await?;
    let guard = lock.lock_owned().await;
    // Repeat the local preflight immediately before any remote operation: CLI
    // discovery or waiting for the common repository lock may have taken time,
    // and another process can add an origin. Keep this lock through creation
    // and local attachment so native stage/commit/push cannot overlap them.
    github_connection_target(&selected.to_string_lossy())?;
    // Keep the configured transport, but make the service explicit. GitHub
    // account status checks github.com, so GH_HOST must not redirect creation
    // to an unrelated enterprise account inherited from the desktop process.
    let mut protocol_command = github_command(path);
    protocol_command
        .args(["config", "get", "git_protocol", "--host", "github.com"])
        .env("GH_HOST", "github.com");
    let ssh = github_probe_output(protocol_command)
        .await
        .is_ok_and(|output| output.status.success() && output.stdout.trim_ascii() == b"ssh");
    let visibility_flag = if visibility == "public" {
        "--public"
    } else {
        "--private"
    };
    // Creating and attaching are separate steps: gh --source rejects linked
    // worktrees, and a local remote failure must not hide a created GitHub repo.
    // This operation never passes --push and never creates a local commit.
    let mut command = github_command(path);
    command
        .args(["repo", "create", visibility_flag, "--", name])
        .current_dir(selected)
        .env("GH_HOST", "github.com")
        .env("GH_PROMPT_DISABLED", "1")
        .env_remove("GH_REPO")
        .stdin(Stdio::null())
        .kill_on_drop(true);
    let output = tokio::time::timeout(std::time::Duration::from_secs(120), command.output())
        .await
        .map_err(|_| "GitHub repository creation timed out. It may have completed on GitHub; check your account before trying Create again.".to_string())?
        .map_err(|error| format!("Could not run GitHub CLI: {error}"))?;
    let created_url = String::from_utf8_lossy(&output.stdout)
        .lines()
        .find_map(github_created_remote_url);
    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let detail = if detail.is_empty() {
            "GitHub repository creation failed.".into()
        } else {
            detail
        };
        return Err(created_url.as_deref().map_or(detail.clone(), |url| {
            github_creation_attachment_error(url, &detail)
        }));
    }
    let created_url = created_url.ok_or_else(|| "GitHub reported creation success but did not return a valid repository URL. Check your GitHub account before trying Create again.".to_string())?;
    let repository = parse_github_repository(&created_url).unwrap();
    if !repository
        .split_once('/')
        .is_some_and(|(_, repo)| repo.eq_ignore_ascii_case(name))
    {
        return Err(github_creation_attachment_error(
            &created_url,
            "GitHub returned a different repository name. The local origin was not changed.",
        ));
    }
    let remote_url = if ssh {
        format!("git@github.com:{repository}.git")
    } else {
        created_url.clone()
    };
    let cwd = selected.to_string_lossy().into_owned();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = guard;
        github_attach_remote_sync(&cwd, &remote_url)
    })
    .await
    .map_err(|error| github_creation_attachment_error(&created_url, &error.to_string()))?
    .map_err(|error| github_creation_attachment_error(&created_url, &error))
}

fn github_creation_attachment_error(url: &str, detail: &str) -> String {
    format!("GitHub repository created at {url}, but it could not be attached to this project. {detail} Use Attach remote with this URL to finish connecting it. No commits were uploaded.")
}

fn github_created_remote_url(output_line: &str) -> Option<String> {
    // gh prints the HTML URL, not the clone URL. A repository literally named
    // example.git needs example.git.git as its remote: strip only the suffix
    // we append here, preserving the repository name returned by GitHub.
    let url = output_line.trim().trim_end_matches('/');
    let path = url.strip_prefix("https://github.com/")?;
    let repository = parse_github_repository(&format!("https://github.com/{path}.git"))?;
    Some(format!("https://github.com/{repository}.git"))
}

fn validate_clone_destination(destination_path: &Path) -> Result<(), String> {
    if !destination_path.is_absolute() {
        return Err("Choose an absolute parent folder using the folder picker.".into());
    }
    match destination_path.symlink_metadata() {
        Ok(_) => return Err("The repository folder already exists in this location. Choose a different parent folder. Nothing was overwritten.".into()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {},
        Err(error) => return Err(format!("Could not check the clone destination: {error}")),
    }
    let parent = destination_path
        .parent()
        .ok_or_else(|| "The clone destination is invalid.".to_string())?;
    if !parent.is_dir() {
        return Err("The clone destination's parent folder does not exist.".into());
    }
    Ok(())
}

#[tauri::command]
pub(super) async fn github_clone_repository(
    app: AppHandle,
    url: String,
    destination: String,
) -> Result<(), String> {
    let url = normalize_github_remote_url(&url)
        .ok_or_else(|| "Enter a valid GitHub repository URL.".to_string())?;
    let destination_path = PathBuf::from(&destination);
    validate_clone_destination(&destination_path)?;
    let path = resolve_github_binary(&app).await?;
    let output = github_command(&path)
        .args(["repo", "clone", &url, &destination])
        .stdin(Stdio::null())
        .output()
        .await
        .map_err(|error| format!("Could not run GitHub CLI: {error}"))?;
    if output.status.success() {
        Ok(())
    } else {
        let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(if detail.is_empty() {
            "GitHub repository clone failed.".into()
        } else {
            detail
        })
    }
}
