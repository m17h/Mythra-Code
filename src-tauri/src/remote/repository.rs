//! Connecting a host-owned checkout. No viewer paths, shell, auth or push proxy.
use super::{
    commit::{self, Stamp},
    domain,
    fs_guard::Anchor,
    hostbridge, store, work, Inner, RemoteState,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    path::{Path, PathBuf},
    process::Command,
    sync::Arc,
};
use tauri::{AppHandle, State, WebviewWindow};

#[derive(Clone, Deserialize)]
#[serde(tag = "action", rename_all = "camelCase", deny_unknown_fields)]
pub(crate) enum RepositoryAction {
    AttachRemote { url: String },
    CreateRepository { name: String, visibility: String },
}
fn invalid() -> String {
    work::refused("invalid")
}
fn uncertain() -> String {
    "MYTHRA_DELIVERY_UNCERTAIN: This repository change may have completed on the host. Refresh its origin and check GitHub before trying again.".into()
}
/// Accept only network Git transports. In particular not file, ext, helpers,
/// option-like input, credentials in HTTPS, control characters or whitespace.
pub(super) fn validate_url(value: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 4096
        || value.starts_with('-')
        || value.chars().any(|c| c.is_control() || c.is_whitespace())
        || value.contains('\\')
    {
        return Err(invalid());
    }
    if value.starts_with("https://") || value.starts_with("ssh://") {
        let url = tauri::Url::parse(value).map_err(|_| invalid())?;
        if url.host_str().is_none_or(|h| h.starts_with('-'))
            || url.username().starts_with('-')
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
            || url.path().trim_matches('/').is_empty()
            || url.scheme() == "https" && !url.username().is_empty()
        {
            return Err(invalid());
        }
        return Ok(());
    }
    // Conventional scp-style SSH syntax: git@host:owner/repository.git.
    let (authority, path) = value.split_once(':').ok_or_else(invalid)?;
    let (user, host) = authority.split_once('@').ok_or_else(invalid)?;
    if user.is_empty()
        || user.starts_with('-')
        || host.is_empty()
        || path.is_empty()
        || path.starts_with(['-', '/'])
        || !user
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'.'))
        || !host
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.'))
        || host.starts_with('-')
    {
        return Err(invalid());
    }
    Ok(())
}
impl RepositoryAction {
    fn validate(&self) -> Result<(), String> {
        match self {
            Self::AttachRemote { url } => validate_url(url),
            Self::CreateRepository { name, visibility } => {
                if name.is_empty()
                    || name.len() > 100
                    || matches!(name.as_str(), "." | "..")
                    || name.starts_with('-')
                    || !name
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
                    || !matches!(visibility.as_str(), "private" | "public")
                {
                    return Err(invalid());
                }
                Ok(())
            }
        }
    }
}
fn git_command(root: &Path) -> Command {
    let home = std::env::var_os("HOME").map(PathBuf::from);
    let mut command = crate::project_git::git_command_for(
        root,
        std::env::var_os("PATH").as_deref(),
        home.as_deref(),
    );
    super::safe_git::repository_environment(&mut command);
    command
}
fn output(command: &mut Command) -> Result<std::process::Output, String> {
    domain::output(command).ok_or_else(|| work::refused("forbidden"))?
}
fn preflight(root: &Path) -> Result<(), String> {
    // Never act on an enclosing repository or replace an existing origin.
    super::git_metadata::locations(root)?;
    let output = output(git_command(root).args(["remote"]))?;
    if !output.status.success() {
        return Err("The host couldn't inspect this checkout's remotes.".into());
    }
    if String::from_utf8_lossy(&output.stdout)
        .lines()
        .any(|line| line == "origin")
    {
        return Err("This project already has an origin remote. Remove or change it in Git before attaching another repository.".into());
    }
    Ok(())
}
fn attach(root: &Path, url: &str) -> Result<Value, String> {
    validate_url(url)?;
    preflight(root)?;
    let result = output(git_command(root).args(["remote", "add", "--", "origin", url]))?;
    if !result.status.success() {
        return Err("The host couldn't attach origin. Inspect this checkout's Git configuration before trying again.".into());
    }
    Ok(
        json!({"url":url,"remoteUrl":url,"repository":crate::github::parse_github_repository(url),"attached":true}),
    )
}
fn gh_command(binary: &Path, root: &Path) -> Command {
    let mut command = crate::process_launch::background_std_command(binary);
    command
        .current_dir(root)
        .env("GH_HOST", "github.com")
        .env("GH_PROMPT_DISABLED", "1")
        .env_remove("GH_REPO");
    command
}
fn create(
    root: &Path,
    binary: &Path,
    name: &str,
    visibility: &str,
    host: &str,
) -> Result<Value, String> {
    preflight(root)?;
    let authenticated =
        output(gh_command(binary, root).args(["auth", "status", "--hostname", "github.com"]))?;
    if !authenticated.status.success() {
        return Err(format!(
            "GitHub CLI isn't signed in on {host}. Sign in on that host, then try again."
        ));
    }
    // Creation and attachment are separate so linked worktrees work too. No
    // --push, --source, shell, viewer auth/token or interactive login ever.
    let created = output(gh_command(binary, root).args([
        "repo",
        "create",
        if visibility == "public" {
            "--public"
        } else {
            "--private"
        },
        "--",
        name,
    ]))?;
    if !created.status.success() {
        return Err(format!("GitHub couldn't create that repository on {host}. The name may already exist or the host account may not have access. Check GitHub on {host} before trying again."));
    }
    let repository = String::from_utf8_lossy(&created.stdout)
        .lines()
        .find_map(|line| {
            let parsed = tauri::Url::parse(line.trim()).ok()?;
            if parsed.scheme() != "https"
                || parsed.host_str() != Some("github.com")
                || parsed.query().is_some()
                || parsed.fragment().is_some()
            {
                return None;
            }
            let parts: Vec<_> = parsed.path().trim_matches('/').split('/').collect();
            if parts.len() != 2 || parts[1] != name {
                return None;
            }
            let repo = format!("{}/{}", parts[0], parts[1]);
            crate::github::parse_github_repository(&format!("https://github.com/{repo}.git"))
                .filter(|r| r == &repo)
        })
        .ok_or_else(uncertain)?;
    let url = format!("https://github.com/{repository}.git");
    match attach(root, &url) {
        Ok(mut result) => {
            result["url"] = json!(format!("https://github.com/{repository}"));
            Ok(result)
        }
        Err(_) => Ok(
            json!({"url":format!("https://github.com/{repository}"),"repository":repository,"attached":false,"message":format!("GitHub repository created, but origin couldn't be attached on {host}. Use Attach remote with {url} to finish. No commits were uploaded.")}),
        ),
    }
}

fn claim(
    db: &mut rusqlite::Connection,
    inner: &Inner,
    stamp: &Stamp,
    root: &str,
) -> Result<Option<Value>, String> {
    if commit::operation(db, stamp)? != "git.write" {
        return Err(invalid());
    }
    super::discovery_work::binding(db, stamp, root)?;
    let core = inner.lock();
    stamp.check(&core, "git.write")?;
    if let Some(prior) = commit::prior(db, stamp)? {
        return Ok(Some(prior));
    }
    if store::delivery_receipt(db, &stamp.device, &stamp.op_id, stamp.op_seq)?
        .is_some_and(|r| r["repositoryStarted"] == true)
    {
        return Err(uncertain());
    }
    store::save_delivery_receipt(
        db,
        &stamp.device,
        &stamp.op_id,
        stamp.op_seq,
        &json!({"disposition":"dispatched","repositoryStarted":true,"workspaceId":stamp.workspace_id,"threadId":stamp.thread_id}),
    )?;
    Ok(None)
}

#[tauri::command]
pub(crate) async fn remote_repository_execute(
    app: AppHandle,
    state: State<'_, RemoteState>,
    window: WebviewWindow,
    stamp: Stamp,
    root: String,
    action: RepositoryAction,
) -> Result<Value, String> {
    hostbridge::window_is_host(&window).map_err(|_| invalid())?;
    action.validate()?;
    // A detached worker retains the repository lock even if a viewer times out.
    let inner = state.inner.clone();
    tauri::async_runtime::spawn(async move { execute(app, inner, stamp, root, action).await })
        .await
        .map_err(|_| uncertain())?
}
async fn execute(
    app: AppHandle,
    inner: Arc<Inner>,
    stamp: Stamp,
    root: String,
    action: RepositoryAction,
) -> Result<Value, String> {
    let worker = inner.clone();
    let s = stamp.clone();
    let r = root.clone();
    let prior = inner
        .read_db(move |db| {
            s.check(&worker.lock(), "git.write")?;
            if commit::operation(db, &s)? != "git.write" {
                return Err(invalid());
            }
            super::discovery_work::binding(db, &s, &r)?;
            commit::prior(db, &s)
        })
        .await?;
    if let Some(prior) = prior {
        return Ok(prior);
    }
    let host = super::device_name(&inner.lock());
    let binary = match &action {
        RepositoryAction::CreateRepository { .. } => match crate::github::resolve_github_binary(&app).await {
            Ok(binary) => Some(binary),
            Err(_) => return settle(inner, stamp, Err(format!("GitHub CLI isn't installed on {host}. Install it and sign in there before creating a repository."))).await,
        },
        _ => None,
    };
    let lock = crate::git_workspace::repository_lock(Path::new(&root)).await?;
    let guard = lock.lock_owned().await;
    let anchor = Anchor::open(Path::new(&root))?;
    let s = stamp.clone();
    let worker = inner.clone();
    let r = root.clone();
    let replay =
        super::finish_write(inner.enqueue_write(false, move |db| claim(db, &worker, &s, &r)))
            .await?;
    if let Some(prior) = replay {
        return Ok(prior);
    }
    let fence = domain::make_context(
        inner.clone(),
        stamp.clone(),
        "git.write".into(),
        anchor,
        false,
    );
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        let _guard = guard;
        domain::with_context(fence, || match action {
            RepositoryAction::AttachRemote { url } => attach(Path::new(&root), &url),
            RepositoryAction::CreateRepository { name, visibility } => create(
                Path::new(&root),
                binary.as_deref().ok_or_else(invalid)?,
                &name,
                &visibility,
                &host,
            ),
        })
    })
    .await
    .map_err(|_| uncertain())?;
    settle(inner, stamp, outcome).await
}

async fn settle(
    inner: Arc<Inner>,
    stamp: Stamp,
    outcome: Result<Value, String>,
) -> Result<Value, String> {
    let worker = inner.clone();
    super::finish_write(inner.enqueue_write(false, move |db| {
        let tx = db.transaction().map_err(|_| uncertain())?;
        let core = worker.lock(); stamp.check(&core, "git.write")?;
        // Plain-English known failures are native allowlisted messages, never
        // stderr/auth output. Saving them makes a retry with this opId inert.
        let result = match outcome {
            Ok(payload) => json!({"opId":stamp.op_id,"state":"accepted","workspaceId":stamp.workspace_id,"threadId":stamp.thread_id,"repository":payload}),
            Err(message) if !message.starts_with("MYTHRA_DELIVERY_UNCERTAIN:") && !message.starts_with("MYTHRA_REMOTE_REJECTED:") => json!({"opId":stamp.op_id,"state":"rejected","error":{"code":"repository_failed","message":message}}),
            Err(message) => return Err(message),
        };
        commit::complete(&tx, &stamp, "git.write", &result, false)?;
        tx.commit().map_err(|_| uncertain())?;
        Ok(result)
    })).await
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn repository_manifest_admits_connection_actions_but_keeps_git_write_terminal_authority() {
        for action in [
            json!({"action":"attachRemote","url":"https://github.com/owner/repo.git"}),
            json!({"action":"createRepository","name":"repo","visibility":"private"}),
            json!({"action":"createRepository","name":"repo","visibility":"public"}),
        ] {
            let mut args = action.clone();
            args["opId"] = json!("connect");
            args["opSeq"] = json!(1);
            args["workspaceId"] = json!("p");
            args["revision"] = json!("r");
            assert_eq!(
                super::super::manifest::validate("git.write", &args).unwrap(),
                true
            );
            let mut extra = args.clone();
            extra["cwd"] = json!("/outside");
            assert!(super::super::manifest::validate("git.write", &extra).is_err());
            let mut grant = store::DeviceGrant::initial();
            grant.work = true;
            grant.capabilities.git_write = true;
            grant.capabilities.terminal = true;
            assert!(super::super::manifest::access("git.write", &grant).is_ok());
            grant.capabilities.terminal = false;
            assert!(super::super::manifest::access("git.write", &grant).is_err());
        }
    }
    #[test]
    fn repository_network_urls_only_and_no_options_or_controls() {
        for good in [
            "https://github.com/owner/repo.git",
            "ssh://git@example.com:2222/owner/repo.git",
            "git@github.com:owner/repo.git",
        ] {
            assert!(validate_url(good).is_ok(), "{good}");
        }
        for bad in [
            "--upload-pack=evil",
            "https://github.com/a/b\n-c evil",
            "file:///tmp/repo",
            "ext::evil",
            "/tmp/repo",
            "https://user:secret@github.com/a/b",
            "ssh://host/",
            "git@-host:a/b",
            "git@host:-option",
            "http://host/a/b",
            "https://host/a/b?token=secret",
        ] {
            assert!(validate_url(bad).is_err(), "{bad}");
        }
        for (name, visibility) in [
            ("--evil", "public"),
            ("a/b", "private"),
            ("repo", "internal"),
            ("repo\n", "public"),
        ] {
            assert!(RepositoryAction::CreateRepository {
                name: name.into(),
                visibility: visibility.into()
            }
            .validate()
            .is_err());
        }
    }
    fn fixture() -> super::super::threads::tests::Fixture {
        let f = super::super::threads::tests::fixture("git.write");
        let output = crate::process_launch::background_std_command("git")
            .current_dir(&f.path)
            .args(["init", "-q"])
            .output()
            .unwrap();
        assert!(output.status.success());
        {
            let mut core = f.inner.lock();
            let grant = core
                .devices
                .get_mut("device")
                .unwrap()
                .grant
                .as_mut()
                .unwrap();
            grant.capabilities.terminal = true;
            grant.capabilities.git_write = true;
        }
        f
    }
    #[test]
    fn repository_attach_succeeds_inside_pinned_temp_checkout_and_refuses_second_origin() {
        let f = fixture();
        super::super::discovery_work::binding(&f.db, &f.stamp, f.path.to_str().unwrap()).unwrap();
        let fence = domain::make_context(
            f.inner.clone(),
            f.stamp.clone(),
            "git.write".into(),
            Anchor::open(&f.path).unwrap(),
            false,
        );
        domain::with_context(fence, || {
            let result = attach(&f.path, "https://github.com/owner/repo.git")?;
            assert_eq!(result["repository"], "owner/repo");
            assert!(attach(&f.path, "git@github.com:other/repo.git").is_err());
            let actual =
                output(git_command(&f.path).args(["config", "--get", "remote.origin.url"]))?;
            assert_eq!(actual.stdout, b"https://github.com/owner/repo.git\n");
            Ok(())
        })
        .unwrap();
    }
    #[test]
    fn repository_root_cannot_be_an_arbitrary_folder_or_outside_project_grant() {
        let f = fixture();
        assert!(super::super::discovery_work::binding(
            &f.db,
            &f.stamp,
            std::env::temp_dir().to_str().unwrap()
        )
        .is_err());
        let mut stamp = f.stamp.clone();
        stamp.workspace_id = Some("outside".into());
        assert!(stamp.check(&f.inner.lock(), "git.write").is_err());
        let sub = f.path.join("sub");
        std::fs::create_dir(&sub).unwrap();
        assert!(super::super::git_metadata::locations(&sub).is_err());
    }
    #[test]
    fn repository_permission_denied_before_git_spawn() {
        let f = fixture();
        f.inner
            .lock()
            .devices
            .get_mut("device")
            .unwrap()
            .grant
            .as_mut()
            .unwrap()
            .capabilities
            .terminal = false;
        let fence = domain::make_context(
            f.inner.clone(),
            f.stamp.clone(),
            "git.write".into(),
            Anchor::open(&f.path).unwrap(),
            false,
        );
        assert!(domain::with_context(fence, || attach(
            &f.path,
            "https://github.com/owner/repo.git"
        ))
        .is_err());
        assert!(!std::fs::read_to_string(f.path.join(".git/config"))
            .unwrap()
            .contains("origin"));
    }
    #[test]
    fn repository_op_id_replays_completed_result_and_never_redispatches_started_effect() {
        let mut f = fixture();
        let root = f.path.to_str().unwrap().to_owned();
        assert!(claim(&mut f.db, &f.inner, &f.stamp, &root)
            .unwrap()
            .is_none());
        assert!(claim(&mut f.db, &f.inner, &f.stamp, &root)
            .unwrap_err()
            .starts_with("MYTHRA_DELIVERY_UNCERTAIN:"));
        let result = json!({"opId":"op","state":"accepted","repository":{"url":"https://github.com/owner/repo"}});
        commit::complete(&f.db, &f.stamp, "git.write", &result, false).unwrap();
        assert_eq!(
            claim(&mut f.db, &f.inner, &f.stamp, &root).unwrap(),
            Some(result)
        );
        f.stamp.device = "another-device".into();
        assert!(claim(&mut f.db, &f.inner, &f.stamp, &root).is_err());
    }
    #[test]
    fn repository_native_error_and_url_survive_late_renderer_sanitization() {
        let f = fixture();
        let failure = json!({"opId":"op","state":"rejected","error":{"code":"repository_failed","message":"GitHub CLI isn't signed in on Test host."}});
        commit::complete(&f.db, &f.stamp, "git.write", &failure, false).unwrap();
        store::save_operation_result(&f.db,"device","op",1,&json!({"opId":"op","state":"rejected","error":{"code":"repository_failed","message":"generic renderer summary"}})).unwrap();
        assert_eq!(
            store::operation_result(&f.db, "device", "op").unwrap(),
            failure
        );
    }
    #[cfg(unix)]
    #[test]
    fn repository_gh_mock_uses_explicit_private_public_argv_and_host_auth_only() {
        use std::os::unix::fs::PermissionsExt;
        for visibility in ["private", "public"] {
            let f = fixture();
            let binary = f.path.join("gh-mock");
            let argv = f.path.join("argv");
            let script=format!("#!/bin/sh\nprintf '%s\\n' \"$@\" >> '{}'\nif [ \"$1\" = auth ]; then exit 0; fi\nprintf '%s\\n' 'https://github.com/owner/new-repo'\n",argv.display());
            std::fs::write(&binary, script).unwrap();
            std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o700)).unwrap();
            let fence = domain::make_context(
                f.inner.clone(),
                f.stamp.clone(),
                "git.write".into(),
                Anchor::open(&f.path).unwrap(),
                false,
            );
            let result = domain::with_context(fence, || {
                create(&f.path, &binary, "new-repo", visibility, "Test host")
            })
            .unwrap();
            assert_eq!(result["url"], "https://github.com/owner/new-repo");
            assert_eq!(std::fs::read_to_string(&argv).unwrap(),format!("auth\nstatus\n--hostname\ngithub.com\nrepo\ncreate\n--{visibility}\n--\nnew-repo\n"));
        }
    }
    #[cfg(unix)]
    #[test]
    fn repository_gh_auth_failure_is_a_plain_host_named_error_without_credentials() {
        use std::os::unix::fs::PermissionsExt;
        let f = fixture();
        let binary = f.path.join("gh-mock");
        std::fs::write(
            &binary,
            "#!/bin/sh\nprintf 'secret must not escape' >&2\nexit 1\n",
        )
        .unwrap();
        std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o700)).unwrap();
        let fence = domain::make_context(
            f.inner.clone(),
            f.stamp.clone(),
            "git.write".into(),
            Anchor::open(&f.path).unwrap(),
            false,
        );
        let error = domain::with_context(fence, || {
            create(&f.path, &binary, "new-repo", "private", "Test host")
        })
        .unwrap_err();
        assert!(error.contains("GitHub CLI isn't signed in on Test host"));
        assert!(!error.contains("secret"));
    }
    #[test]
    fn repository_write_refuses_view_only_terminal_off_and_git_write_off() {
        let f = super::super::threads::tests::fixture("git.write");
        let mut grant = work::grant_locked(&f.inner.lock(), "device").unwrap();
        for (work, terminal, git) in [
            (false, true, true),
            (true, false, true),
            (true, true, false),
        ] {
            grant.work = work;
            grant.capabilities.terminal = terminal;
            grant.capabilities.git_write = git;
            f.inner.lock().devices.get_mut("device").unwrap().grant = Some(grant.clone());
            assert!(f.stamp.check(&f.inner.lock(), "git.write").is_err());
        }
    }
}
