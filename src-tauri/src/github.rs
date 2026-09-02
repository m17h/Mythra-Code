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
    if let Ok(home) = app.path().home_dir() {
        for relative in [".local/bin/gh", ".cargo/bin/gh", ".npm-global/bin/gh"] {
            push_candidate(&mut candidates, home.join(relative));
        }
    }
    if let Some(candidate) = candidates.into_iter().find(|candidate| candidate.is_file()) {
        return Ok(candidate);
    }
    if let Some(candidate) = find_with_login_shell(executable_name).await {
        return Ok(candidate);
    }
    Err("GitHub CLI is not installed. Install it from cli.github.com, then refresh GitHub settings.".into())
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
    let version = background_command(&path)
        .arg("--version")
        .stdin(Stdio::null())
        .output()
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
    let auth = background_command(&path)
        .args(["auth", "status", "--hostname", "github.com"])
        .stdin(Stdio::null())
        .output()
        .await;
    let authenticated = auth.as_ref().is_ok_and(|output| output.status.success());
    if !authenticated {
        let error = auth
            .ok()
            .map(|output| String::from_utf8_lossy(&output.stderr).trim().to_string())
            .filter(|value| !value.is_empty());
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
            error,
        };
    }
    let user = background_command(&path)
        .args(["api", "user"])
        .stdin(Stdio::null())
        .output()
        .await
        .ok()
        .filter(|output| output.status.success())
        .and_then(|output| serde_json::from_slice::<Value>(&output.stdout).ok());
    GitHubAccountStatus {
        available: true,
        authenticated: true,
        path: Some(path.to_string_lossy().into_owned()),
        version,
        login: user
            .as_ref()
            .and_then(|value| value.get("login"))
            .and_then(Value::as_str)
            .map(str::to_string),
        name: user
            .as_ref()
            .and_then(|value| value.get("name"))
            .and_then(Value::as_str)
            .map(str::to_string),
        email: user
            .as_ref()
            .and_then(|value| value.get("email"))
            .and_then(Value::as_str)
            .map(str::to_string),
        avatar_url: user
            .as_ref()
            .and_then(|value| value.get("avatar_url"))
            .and_then(Value::as_str)
            .map(str::to_string),
        profile_url: user
            .as_ref()
            .and_then(|value| value.get("html_url"))
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
        Err("Run `gh auth login` in a terminal, then refresh GitHub settings.".into())
    }
}

pub(super) fn parse_github_repository(remote: &str) -> Option<String> {
    let trimmed = remote.trim().trim_end_matches('/').trim_end_matches(".git");
    let path = if let Some(value) = trimmed.strip_prefix("git@github.com:") {
        value
    } else if let Some(value) = trimmed.strip_prefix("ssh://git@github.com/") {
        value
    } else if let Some(value) = trimmed.strip_prefix("https://github.com/") {
        value
    } else {
        trimmed.strip_prefix("http://github.com/")?
    };
    let mut parts = path.split('/');
    let owner = parts.next()?;
    let repo = parts.next()?;
    (parts.next().is_none() && !owner.is_empty() && !repo.is_empty())
        .then(|| format!("{owner}/{repo}"))
}

pub(super) fn validate_github_repository_name(name: &str) -> Result<(), String> {
    let valid = !name.is_empty()
        && name.len() <= 100
        && !name.starts_with('-')
        && name.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '.' | '_' | '-')
        });
    valid.then_some(()).ok_or_else(|| {
        "Repository name must be 1–100 characters using only letters, numbers, periods, underscores, or hyphens, and cannot begin with a hyphen.".into()
    })
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
    let remote_url = optional_git_stdout(&selected, &["remote", "get-url", "origin"]);
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
    if parse_github_repository(url).is_none() {
        return Err(
            "Enter a GitHub repository URL such as https://github.com/owner/repository.git".into(),
        );
    }
    let selected = PathBuf::from(cwd)
        .canonicalize()
        .map_err(|error| format!("Could not open the project folder: {error}"))?;
    if optional_git_stdout(&selected, &["remote", "get-url", "origin"]).is_some() {
        return Err("This project already has an origin remote. Remove or change it in Git before attaching another repository.".into());
    }
    git_stdout(&selected, &["remote", "add", "origin", url], None)?;
    github_repo_status_sync(cwd)
}

#[tauri::command]
pub(super) async fn github_attach_remote(
    cwd: String,
    url: String,
) -> Result<GitHubRepoStatus, String> {
    tauri::async_runtime::spawn_blocking(move || github_attach_remote_sync(&cwd, &url))
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
    let path = resolve_github_binary(&app).await?;
    validate_github_repository_name(&name)?;
    if visibility != "private" && visibility != "public" {
        return Err("Repository visibility must be private or public.".into());
    }
    let selected = PathBuf::from(&cwd)
        .canonicalize()
        .map_err(|error| format!("Could not open the project folder: {error}"))?;
    if optional_git_stdout(&selected, &["remote", "get-url", "origin"]).is_some() {
        return Err("This project already has an origin remote.".into());
    }
    let visibility_flag = if visibility == "public" {
        "--public"
    } else {
        "--private"
    };
    let output = background_command(path)
        .args([
            "repo",
            "create",
            "--source",
            &cwd,
            "--remote",
            "origin",
            visibility_flag,
            "--",
            &name,
        ])
        .stdin(Stdio::null())
        .output()
        .await
        .map_err(|error| format!("Could not run GitHub CLI: {error}"))?;
    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if detail.is_empty() {
            "GitHub repository creation failed.".into()
        } else {
            detail
        });
    }
    github_repo_status_sync(&cwd)
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
    if parse_github_repository(&url).is_none() {
        return Err("Enter a valid GitHub repository URL.".into());
    }
    let destination_path = PathBuf::from(&destination);
    validate_clone_destination(&destination_path)?;
    let path = resolve_github_binary(&app).await?;
    let output = background_command(path)
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
