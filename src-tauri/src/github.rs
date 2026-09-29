use std::{
    env,
    path::{Path, PathBuf},
    process::Stdio,
};

use super::{find_on_path, find_with_login_shell, git_stdout, optional_git_stdout, push_candidate};
use crate::process_launch::background_command;
use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Manager};

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
    if let Ok(home) = app.path().home_dir() {
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

#[cfg(any(windows, test))]
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
    let selected = PathBuf::from(cwd)
        .canonicalize()
        .map_err(|error| format!("Could not open the project folder: {error}"))?;
    if git_stdout(&selected, &["rev-parse", "--show-toplevel"], None).is_err() {
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
    let remote_url = github_remote_url(&selected, "origin");
    let upstream = optional_git_stdout(
        &selected,
        &[
            "rev-parse",
            "--abbrev-ref",
            "--symbolic-full-name",
            "@{upstream}",
        ],
    );
    let (ahead, behind) = upstream
        .as_ref()
        .and_then(|_| {
            optional_git_stdout(
                &selected,
                &["rev-list", "--left-right", "--count", "HEAD...@{upstream}"],
            )
        })
        .and_then(|counts| {
            let mut parts = counts.split_whitespace();
            Some((parts.next()?.parse().ok()?, parts.next()?.parse().ok()?))
        })
        .unwrap_or((0, 0));
    Ok(GitHubRepoStatus {
        is_repo: true,
        repository: remote_url.as_deref().and_then(parse_github_repository),
        remote_url,
        branch: optional_git_stdout(&selected, &["symbolic-ref", "--short", "-q", "HEAD"]),
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

#[cfg(test)]
mod connect_tests {
    use super::*;

    struct RepositoryFixture(PathBuf);

    impl RepositoryFixture {
        fn new() -> Self {
            let root = env::temp_dir().join(format!("mythra-gh-connect-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir(&root).unwrap();
            git_stdout(&root, &["init", "-b", "main"], None).unwrap();
            Self(root)
        }

        fn cwd(&self) -> &str {
            self.0.to_str().unwrap()
        }
    }

    impl Drop for RepositoryFixture {
        fn drop(&mut self) {
            std::fs::remove_dir_all(&self.0).unwrap();
        }
    }

    #[test]
    fn official_ssh_https_transport_retains_its_port_and_repository_identity() {
        let url = "ssh://git@ssh.github.com:443/owner/repository.git";
        assert_eq!(
            parse_github_repository(url).as_deref(),
            Some("owner/repository")
        );
        assert_eq!(normalize_github_remote_url(url).as_deref(), Some(url));
        for invalid in [
            "ssh://git@ssh.github.com:22/owner/repository.git",
            "ssh://git@ssh.github.com:443.example.com/owner/repository.git",
            "ssh://git@ssh.github.com:443/owner/repository.git/other",
        ] {
            assert_eq!(parse_github_repository(invalid), None);
        }
    }

    #[test]
    fn remote_parser_rejects_invalid_repository_components() {
        for input in [
            "https://github.com/owner/..",
            "https://github.com/owner/.",
            "https://github.com/../repository",
            "https://github.com/ow ner/repository",
            "https://github.com/owner/repo\\other",
            "https://github.com/owner/repo%2Fother",
            "https://github.com/owner/repo?tab=readme",
            "https://github.com/owner/repo\nother",
        ] {
            assert_eq!(parse_github_repository(input), None, "accepted {input:?}");
        }
    }

    #[test]
    fn attach_normalizes_copied_browser_urls_without_touching_local_files() {
        let fixture = RepositoryFixture::new();
        std::fs::write(fixture.0.join("draft.txt"), "local draft").unwrap();
        let before = git_stdout(&fixture.0, &["status", "--porcelain"], None).unwrap();
        let result = github_attach_remote_sync(
            fixture.cwd(),
            "  http://github.com/owner/repo.git/?tab=readme#top  ",
        )
        .unwrap();
        assert_eq!(result.repository.as_deref(), Some("owner/repo"));
        assert_eq!(
            result.remote_url.as_deref(),
            Some("https://github.com/owner/repo.git")
        );
        assert_eq!(result.branch.as_deref(), Some("main"));
        assert_eq!(
            git_stdout(&fixture.0, &["status", "--porcelain"], None).unwrap(),
            before
        );
        assert!(optional_git_stdout(&fixture.0, &["rev-parse", "--verify", "HEAD"]).is_none());
        assert_eq!(
            std::fs::read_to_string(fixture.0.join("draft.txt")).unwrap(),
            "local draft"
        );
    }

    #[test]
    fn attach_does_not_bind_an_enclosing_repository_from_a_project_subfolder() {
        let fixture = RepositoryFixture::new();
        let project = fixture.0.join("nested-project");
        std::fs::create_dir(&project).unwrap();
        let result = github_attach_remote_sync(
            project.to_str().unwrap(),
            "https://github.com/owner/repository.git",
        );
        assert!(result.unwrap_err().contains("repository root"));
        assert_eq!(git_stdout(&fixture.0, &["remote"], None).unwrap(), "");
    }

    #[test]
    fn attach_refuses_an_origin_without_a_fetch_url() {
        let fixture = RepositoryFixture::new();
        git_stdout(
            &fixture.0,
            &[
                "config",
                "remote.origin.fetch",
                "+refs/heads/*:refs/remotes/origin/*",
            ],
            None,
        )
        .unwrap();
        let result = github_attach_remote_sync(fixture.cwd(), "https://github.com/owner/new.git");
        assert!(result.unwrap_err().contains("already has an origin remote"));
        assert_eq!(
            git_stdout(
                &fixture.0,
                &["config", "--get", "remote.origin.fetch"],
                None
            )
            .unwrap(),
            "+refs/heads/*:refs/remotes/origin/*"
        );
    }

    #[test]
    fn repository_status_keeps_raw_github_identity_with_a_local_transport_rewrite() {
        let fixture = RepositoryFixture::new();
        let remote = fixture.0.join("rewritten-remote.git");
        git_stdout(
            &fixture.0,
            &["init", "--bare", remote.to_str().unwrap()],
            None,
        )
        .unwrap();
        git_stdout(
            &fixture.0,
            &[
                "remote",
                "add",
                "origin",
                "https://github.com/owner/repository.git",
            ],
            None,
        )
        .unwrap();
        git_stdout(
            &fixture.0,
            &[
                "config",
                &format!("url.{}.insteadOf", remote.display()),
                "https://github.com/owner/repository.git",
            ],
            None,
        )
        .unwrap();
        assert_eq!(
            git_stdout(&fixture.0, &["remote", "get-url", "origin"], None).unwrap(),
            remote.to_string_lossy()
        );
        let status = github_repo_status_sync(fixture.cwd()).unwrap();
        assert_eq!(
            status.remote_url.as_deref(),
            Some("https://github.com/owner/repository.git")
        );
        assert_eq!(status.repository.as_deref(), Some("owner/repository"));
        assert_eq!(status.branch.as_deref(), Some("main"));
    }

    #[test]
    fn repository_status_does_not_choose_a_github_identity_from_multiple_origin_urls() {
        let fixture = RepositoryFixture::new();
        git_stdout(
            &fixture.0,
            &[
                "remote",
                "add",
                "origin",
                "https://github.com/owner/first.git",
            ],
            None,
        )
        .unwrap();
        git_stdout(
            &fixture.0,
            &[
                "config",
                "--add",
                "remote.origin.url",
                "https://github.com/owner/second.git",
            ],
            None,
        )
        .unwrap();
        let status = github_repo_status_sync(fixture.cwd()).unwrap();
        assert_eq!(status.repository, None);
        assert_eq!(
            status.remote_url.as_deref(),
            Some("https://github.com/owner/first.git\nhttps://github.com/owner/second.git")
        );
    }

    #[test]
    fn creation_names_reject_dot_paths() {
        for input in [".", ".."] {
            assert!(validate_github_repository_name(input).is_err());
        }
    }

    #[tokio::test]
    async fn attach_waits_for_the_shared_native_repository_lock() {
        let fixture = RepositoryFixture::new();
        let lock = crate::git_workspace::repository_lock(&fixture.0)
            .await
            .unwrap();
        let guard = lock.lock_owned().await;
        let cwd = fixture.cwd().to_string();
        let mut attachment = tokio::spawn(async move {
            github_attach_remote(cwd, "https://github.com/owner/repository.git".into()).await
        });
        let waiting = tokio::time::timeout(std::time::Duration::from_millis(100), &mut attachment)
            .await
            .is_err();
        drop(guard);
        assert!(
            waiting,
            "attachment bypassed the native repository mutation lock"
        );
        let result = attachment.await.unwrap().unwrap();
        assert_eq!(result.repository.as_deref(), Some("owner/repository"));
    }

    #[cfg(unix)]
    fn fake_github(fixture: &RepositoryFixture, behavior: &str) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let binary = fixture.0.join("fake-gh");
        std::fs::write(&binary, format!(
            "#!/bin/sh\nif [ \"$1\" = config ]; then printf 'ssh\\n'; exit 0; fi\n[ \"$GH_HOST\" = github.com ] || exit 80\n[ \"$GH_PROMPT_DISABLED\" = 1 ] || exit 81\n[ -z \"$GH_REPO\" ] || exit 82\n[ \"$#\" = 5 ] && [ \"$1:$2:$3:$4\" = 'repo:create:--private:--' ] || exit 83\n{behavior}\n"
        )).unwrap();
        std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o700)).unwrap();
        binary
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn creation_holds_the_shared_native_lock_until_attachment_completes() {
        let fixture = RepositoryFixture::new();
        let binary = fake_github(&fixture, ": > create-started\nwhile [ ! -f create-release ]; do sleep 0.02; done\nprintf 'https://github.com/owner/repository\\n'");
        let selected = fixture.0.clone();
        let creation = tokio::spawn(async move {
            github_create_repository_at(&binary, &selected, "repository", "private").await
        });
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            while !fixture.0.join("create-started").exists() {
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        let lock = crate::git_workspace::repository_lock(&fixture.0)
            .await
            .unwrap();
        let held_during_creation = lock.try_lock_owned().is_err();
        std::fs::write(fixture.0.join("create-release"), "continue").unwrap();
        let result = creation.await.unwrap().unwrap();
        assert!(
            held_during_creation,
            "creation did not hold the shared repository lock"
        );
        assert_eq!(result.repository.as_deref(), Some("owner/repository"));
        let lock = crate::git_workspace::repository_lock(&fixture.0)
            .await
            .unwrap();
        assert!(
            lock.try_lock_owned().is_ok(),
            "creation retained the lock after attachment"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn create_attaches_an_unborn_repo_without_committing_or_pushing() {
        let fixture = RepositoryFixture::new();
        std::fs::write(fixture.0.join("draft.txt"), "keep this draft").unwrap();
        let binary = fake_github(&fixture, "printf 'https://github.com/owner/repository\\n'");
        let before = git_stdout(&fixture.0, &["status", "--porcelain"], None).unwrap();
        let result = github_create_repository_at(&binary, &fixture.0, "repository", "private")
            .await
            .unwrap();
        assert_eq!(result.repository.as_deref(), Some("owner/repository"));
        assert_eq!(
            result.remote_url.as_deref(),
            Some("git@github.com:owner/repository.git")
        );
        assert!(optional_git_stdout(&fixture.0, &["rev-parse", "--verify", "HEAD"]).is_none());
        assert_eq!(
            git_stdout(&fixture.0, &["status", "--porcelain"], None).unwrap(),
            before
        );
        assert_eq!(
            std::fs::read_to_string(fixture.0.join("draft.txt")).unwrap(),
            "keep this draft"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn create_supports_a_linked_worktree_and_keeps_the_existing_commit() {
        let fixture = RepositoryFixture::new();
        git_stdout(
            &fixture.0,
            &[
                "-c",
                "user.name=Fixture",
                "-c",
                "user.email=fixture@example.invalid",
                "commit",
                "--allow-empty",
                "-m",
                "Fixture",
            ],
            None,
        )
        .unwrap();
        let before = git_stdout(&fixture.0, &["rev-parse", "HEAD"], None).unwrap();
        let worktree = fixture.0.join("linked-worktree");
        git_stdout(
            &fixture.0,
            &[
                "worktree",
                "add",
                "-b",
                "feature",
                worktree.to_str().unwrap(),
            ],
            None,
        )
        .unwrap();
        let binary = fake_github(&fixture, "printf 'https://github.com/owner/repository\\n'");
        let result = github_create_repository_at(&binary, &worktree, "repository", "private")
            .await
            .unwrap();
        assert_eq!(result.branch.as_deref(), Some("feature"));
        assert_eq!(result.repository.as_deref(), Some("owner/repository"));
        assert_eq!(
            git_stdout(&worktree, &["rev-parse", "HEAD"], None).unwrap(),
            before
        );
        assert_eq!(
            git_stdout(&fixture.0, &["rev-parse", "HEAD"], None).unwrap(),
            before
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn create_reports_a_created_url_if_origin_is_added_during_creation() {
        let fixture = RepositoryFixture::new();
        let binary = fake_github(&fixture, "git remote add origin https://example.invalid/original.git\nprintf 'https://github.com/owner/repository\\n'");
        let error = github_create_repository_at(&binary, &fixture.0, "repository", "private")
            .await
            .unwrap_err();
        assert!(
            error.contains("GitHub repository created at https://github.com/owner/repository.git")
        );
        assert!(error.contains("Use Attach remote"));
        assert!(error.contains("No commits were uploaded"));
        assert_eq!(
            git_stdout(&fixture.0, &["remote", "get-url", "origin"], None).unwrap(),
            "https://example.invalid/original.git"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn create_retains_cli_auth_errors_without_mutating_the_repo() {
        let fixture = RepositoryFixture::new();
        let binary = fake_github(&fixture, "printf 'authentication failed\\n' >&2\nexit 4");
        let error = github_create_repository_at(&binary, &fixture.0, "repository", "private")
            .await
            .unwrap_err();
        assert_eq!(error, "authentication failed");
        assert_eq!(git_stdout(&fixture.0, &["remote"], None).unwrap(), "");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn create_preserves_a_repository_name_ending_in_dot_git() {
        let fixture = RepositoryFixture::new();
        let binary = fake_github(
            &fixture,
            "printf 'https://github.com/owner/repository.git\\n'",
        );
        let result = github_create_repository_at(&binary, &fixture.0, "repository.git", "private")
            .await
            .unwrap();
        assert_eq!(result.repository.as_deref(), Some("owner/repository.git"));
        assert_eq!(
            result.remote_url.as_deref(),
            Some("git@github.com:owner/repository.git.git")
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn create_preflight_blocks_existing_origins_and_missing_repositories() {
        let fixture = RepositoryFixture::new();
        let binary = fake_github(&fixture, "exit 84");
        git_stdout(
            &fixture.0,
            &[
                "config",
                "remote.origin.fetch",
                "+refs/heads/*:refs/remotes/origin/*",
            ],
            None,
        )
        .unwrap();
        let error = github_create_repository_at(&binary, &fixture.0, "repository", "private")
            .await
            .unwrap_err();
        assert!(error.contains("already has an origin remote"));
        let not_repo =
            env::temp_dir().join(format!("mythra-gh-uninitialized-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&not_repo).unwrap();
        let result = github_create_repository_at(&binary, &not_repo, "repository", "private").await;
        std::fs::remove_dir(not_repo).unwrap();
        assert!(result.unwrap_err().contains("repository"));
    }
}

#[cfg(test)]
mod clone_tests {
    use super::validate_clone_destination;
    use std::{fs, path::Path};

    #[test]
    fn clone_destination_requires_new_child_in_existing_parent() {
        let parent = std::env::temp_dir().join(format!(
            "mythra-clone-test-{}-{}",
            std::process::id(),
            super::super::unix_timestamp_ms()
        ));
        fs::create_dir(&parent).unwrap();
        assert!(validate_clone_destination(&parent.join("new-repo")).is_ok());
        assert!(validate_clone_destination(Path::new("relative/repo")).is_err());
        assert!(validate_clone_destination(&parent.join("missing/repo")).is_err());
        fs::write(parent.join("existing-file"), "do not overwrite").unwrap();
        assert!(validate_clone_destination(&parent.join("existing-file"))
            .unwrap_err()
            .contains("Nothing was overwritten"));
        assert!(validate_clone_destination(&parent)
            .unwrap_err()
            .contains("already exists"));
        assert_eq!(
            fs::read_to_string(parent.join("existing-file")).unwrap(),
            "do not overwrite"
        );
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(parent.join("absent"), parent.join("dangling-link"))
                .unwrap();
            assert!(validate_clone_destination(&parent.join("dangling-link"))
                .unwrap_err()
                .contains("already exists"));
            fs::remove_file(parent.join("dangling-link")).unwrap();
        }
        fs::remove_file(parent.join("existing-file")).unwrap();
        fs::remove_dir(&parent).unwrap();
    }
}

#[cfg(test)]
mod probe_tests {
    use super::*;

    #[test]
    fn app_owned_github_commands_bind_the_host_and_remove_repository_overrides() {
        let command = github_command(Path::new("gh"));
        let environment: std::collections::HashMap<_, _> = command.as_std().get_envs().collect();
        assert_eq!(
            environment.get(std::ffi::OsStr::new("GH_HOST")),
            Some(&Some(std::ffi::OsStr::new("github.com")))
        );
        assert_eq!(
            environment.get(std::ffi::OsStr::new("GH_PROMPT_DISABLED")),
            Some(&Some(std::ffi::OsStr::new("1")))
        );
        assert_eq!(
            environment.get(std::ffi::OsStr::new("GH_REPO")),
            Some(&None)
        );
    }

    #[cfg(unix)]
    fn account_probe_fixture(behavior: &str) -> (PathBuf, PathBuf) {
        use std::os::unix::fs::PermissionsExt;
        let root = env::temp_dir().join(format!("mythra-gh-account-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let binary = root.join("gh");
        std::fs::write(&binary, format!(
            "#!/bin/sh\n[ \"$GH_HOST\" = github.com ] || exit 80\n[ \"$GH_PROMPT_DISABLED\" = 1 ] || exit 81\n[ -z \"$GH_REPO\" ] || exit 82\nif [ \"$1\" = --version ]; then printf 'gh version 2.2.0\\n'; exit 0; fi\nif [ \"$1\" = auth ]; then printf 'inactive account token expired\\n' >&2; exit 1; fi\n[ \"$*\" = 'api --hostname github.com --method GET user' ] || exit 83\n{behavior}\n"
        )).unwrap();
        std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o700)).unwrap();
        (root, binary)
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn account_probe_uses_active_credentials_without_new_auth_status_flags() {
        let (root, binary) = account_probe_fixture(
            "printf '%s\\n' '{\"login\":\"active-user\",\"name\":\"Active user\"}'",
        );
        let status = github_status_at(&binary).await;
        std::fs::remove_dir_all(root).unwrap();
        assert!(status.authenticated);
        assert_eq!(status.login.as_deref(), Some("active-user"));
        assert_eq!(status.version.as_deref(), Some("gh version 2.2.0"));
        assert_eq!(status.error, None);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn account_probe_reports_invalid_credentials_separately_from_transient_failures() {
        for (behavior, expected, forbidden) in [
            (
                "printf 'HTTP 401: Bad credentials\\n' >&2; exit 1",
                "Sign in again",
                "saved credentials were not changed",
            ),
            (
                "printf 'HTTP 429: rate limit exceeded\\n' >&2; exit 1",
                "saved credentials were not changed",
                "Sign in again",
            ),
            (
                "printf '%s\\n' '{}'",
                "did not report the active account login",
                "Sign in again",
            ),
        ] {
            let (root, binary) = account_probe_fixture(behavior);
            let status = github_status_at(&binary).await;
            std::fs::remove_dir_all(root).unwrap();
            assert!(!status.authenticated);
            assert_eq!(status.login, None);
            let error = status.error.unwrap();
            assert!(error.contains(expected), "{error}");
            assert!(!error.contains(forbidden), "{error}");
        }
    }

    #[test]
    fn github_discovery_picks_up_an_install_in_a_new_registered_path() {
        let root = std::env::temp_dir().join(format!("mythra-gh-path-{}", uuid::Uuid::new_v4()));
        let old_bin = root.join("old-bin");
        let new_bin = root.join("GitHub CLI ü/bin");
        std::fs::create_dir_all(&old_bin).unwrap();
        std::fs::create_dir_all(&new_bin).unwrap();
        let old_paths = vec![old_bin.to_string_lossy().into_owned()];
        let new_paths = vec![old_paths[0].clone(), format!(";\"{}\";", new_bin.display())];
        assert_eq!(github_on_windows_paths(&new_paths), None);
        std::fs::write(new_bin.join("gh.exe"), b"fixture").unwrap();
        assert_eq!(github_on_windows_paths(&old_paths), None);
        assert_eq!(
            github_on_windows_paths(&new_paths),
            Some(new_bin.join("gh.exe"))
        );
        // A second refresh also sees an uninstall rather than retaining a path.
        std::fs::remove_file(new_bin.join("gh.exe")).unwrap();
        assert_eq!(github_on_windows_paths(&new_paths), None);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(windows)]
    #[tokio::test]
    #[ignore = "requires a real GitHub CLI registered in Windows PATH"]
    async fn live_registered_path_detects_github_from_a_stale_process_environment() {
        // Exercise the actual registry-reading child process without changing
        // either the user's registry or this test process's global environment.
        let stale_path = PathBuf::from(std::env::var_os("SystemRoot").unwrap()).join("System32");
        let mut command = registered_windows_path_command();
        command.env("PATH", &stale_path);
        let output = github_probe_output(command).await.unwrap();
        assert!(output.status.success());
        let paths: Vec<String> = serde_json::from_slice(&output.stdout).unwrap();
        let gh = github_on_windows_paths(&paths).expect("registered GitHub CLI");
        assert_ne!(gh.parent(), Some(stale_path.as_path()));
        let mut version = background_command(&gh);
        version.arg("--version").env("PATH", &stale_path);
        let output = github_probe_output(version).await.unwrap();
        assert!(output.status.success());
        assert!(String::from_utf8_lossy(&output.stdout).starts_with("gh version "));
    }

    #[tokio::test]
    async fn status_probe_times_out_a_stalled_native_process() {
        #[cfg(windows)]
        let mut command = background_command("powershell.exe");
        #[cfg(windows)]
        command.args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "Start-Sleep -Seconds 60",
        ]);
        #[cfg(not(windows))]
        let mut command = background_command("sh");
        #[cfg(not(windows))]
        command.args(["-c", "exec sleep 60"]);
        let started = std::time::Instant::now();
        let result =
            github_probe_output_with_timeout(command, std::time::Duration::from_millis(100)).await;
        assert!(result.unwrap_err().contains("timed out"));
        assert!(started.elapsed() < std::time::Duration::from_secs(5));
    }
}
