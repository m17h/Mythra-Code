//! Clones a GitHub repository into a folder the viewer browsed to. A clone can take
//! minutes, so the request only starts it and the viewer asks how it's going. Adding
//! the finished folder as a project is the ordinary `projects.add`.
use super::{
    commit, commit::Stamp, finish_write, folders, fs_guard, hostbridge, work, Inner, RemoteState,
};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::atomic::Ordering,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tauri::{AppHandle, State, WebviewWindow};

const MAX_RUNNING: usize = 2;
const MAX_REMEMBERED: usize = 16;
const RUN_LIMIT: Duration = Duration::from_secs(15 * 60);
const AUTHORITY_POLL: Duration = Duration::from_millis(100);
const KEEP_FINISHED: Duration = Duration::from_secs(30 * 60);

#[derive(Clone, Copy, PartialEq, Eq)]
enum Outcome {
    Running,
    Completed,
    Failed,
    TimedOut,
}
struct Job {
    device: String,
    created: Instant,
    outcome: Outcome,
    destination: Option<PathBuf>,
}
static JOBS: Mutex<Option<HashMap<String, Job>>> = Mutex::new(None);

fn refused() -> String {
    work::refused("stale_target")
}
fn with_jobs<T>(change: impl FnOnce(&mut HashMap<String, Job>) -> T) -> T {
    let mut jobs = JOBS
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    change(jobs.get_or_insert_with(HashMap::new))
}
/// Finished records go first, so a running clone is never forgotten to make room.
fn admit(
    jobs: &mut HashMap<String, Job>,
    id: &str,
    device: &str,
    destination: Option<&Path>,
) -> Result<(), String> {
    jobs.retain(|_, job| job.outcome == Outcome::Running || job.created.elapsed() < KEEP_FINISHED);
    let running = jobs.values().filter(|job| job.outcome == Outcome::Running);
    if running.clone().count() >= MAX_RUNNING
        || running.clone().any(|job| {
            job.device == device
                || destination.is_some_and(|path| job.destination.as_deref() == Some(path))
        })
    {
        return Err(work::refused("busy"));
    }
    while jobs.len() >= MAX_REMEMBERED {
        let Some(oldest) = jobs
            .iter()
            .filter(|(_, job)| job.outcome != Outcome::Running)
            .min_by_key(|(_, job)| job.created)
            .map(|(id, _)| id.clone())
        else {
            return Err(work::refused("busy"));
        };
        jobs.remove(&oldest);
    }
    jobs.insert(
        id.to_owned(),
        Job {
            device: device.to_owned(),
            created: Instant::now(),
            outcome: Outcome::Running,
            destination: destination.map(Path::to_owned),
        },
    );
    Ok(())
}
fn state_of(jobs: &HashMap<String, Job>, id: &str, device: &str) -> Option<&'static str> {
    jobs.get(id)
        .filter(|job| job.device == device)
        .map(|job| match job.outcome {
            Outcome::Running => "running",
            Outcome::Completed => "completed",
            Outcome::Failed => "failed",
            Outcome::TimedOut => "timedOut",
        })
}

#[tauri::command]
pub(crate) async fn remote_projects_clone(
    app: AppHandle,
    state: State<'_, RemoteState>,
    window: WebviewWindow,
    stamp: Stamp,
    folder_token: String,
    url: String,
) -> Result<Value, String> {
    hostbridge::window_is_host(&window).map_err(|_| refused())?;
    let inner: Arc<Inner> = state.inner.clone();
    let Some((url, name)) =
        crate::github::clone_target(&url).filter(|(_, name)| fs_guard::leaf(name))
    else {
        return Err(work::refused("invalid"));
    };
    let (s, worker) = (stamp.clone(), inner.clone());
    let prior = inner
        .read_db(move |db| {
            if commit::operation(db, &s)? != "projects.clone" {
                return Err(refused());
            }
            s.check(&worker.lock(), "projects.clone")?;
            commit::prior(db, &s)
        })
        .await?;
    if let Some(prior) = prior {
        return Ok(prior);
    }
    let selected = folders::selection(
        &inner,
        stamp.generation,
        &stamp.device,
        stamp.grant_revision,
        &folder_token,
    )?;
    let parent = fs_guard::Anchor::open(&selected.path)?;
    selected.validate()?;
    let destination: PathBuf = parent.path.join(&name);
    if destination.symlink_metadata().is_ok() {
        return Err(work::refused("busy"));
    }
    let id = uuid::Uuid::new_v4().to_string();
    let (s, worker, handle, title, reserved_path) = (
        stamp.clone(),
        inner.clone(),
        id.clone(),
        name.clone(),
        destination.clone(),
    );
    let saved = finish_write(inner.enqueue_write(false, move |db| {
        if let Some(prior) = commit::prior(db, &s)? {
            return Ok((prior, true));
        }
        let tx = db.transaction().map_err(|_| refused())?;
        let core = worker.lock();
        s.check(&core, "projects.clone")?;
        with_jobs(|jobs| admit(jobs, &handle, &s.device, Some(&reserved_path)))?;
        let result = json!({"opId":s.op_id,"state":"accepted","processHandle":handle,"name":title});
        if let Err(error) = commit::complete(&tx, &s, "projects.clone", &result, false)
            .and_then(|()| tx.commit().map_err(|_| refused()))
        {
            with_jobs(|jobs| jobs.remove(&handle));
            return Err(error);
        }
        drop(core);
        Ok((result, false))
    }))
    .await?;
    if saved.1 {
        return Ok(saved.0);
    }
    tauri::async_runtime::spawn(async move {
        let authority = Authority {
            inner,
            stamp,
            parent,
        };
        let finished = authority.clone(&app, &url, &destination).await;
        with_jobs(|jobs| {
            if let Some(job) = jobs.get_mut(&id) {
                job.outcome = finished;
            }
        });
    });
    Ok(saved.0)
}

#[tauri::command]
pub(crate) async fn remote_projects_clone_status(
    state: State<'_, RemoteState>,
    window: WebviewWindow,
    generation: u64,
    device: String,
    grant_revision: u64,
    process_handle: String,
) -> Result<Value, String> {
    hostbridge::window_is_host(&window).map_err(|_| refused())?;
    folders::check(&state, generation, &device, grant_revision)?;
    with_jobs(|jobs| state_of(jobs, &process_handle, &device))
        .map(|state| json!({"state":state}))
        .ok_or_else(refused)
}

/// The native job retains the exact authority admitted with the journal entry.
/// There are at most two of these workers; no polling exists while clones idle.
struct Authority {
    inner: Arc<Inner>,
    stamp: Stamp,
    parent: fs_guard::Anchor,
}
impl Authority {
    fn check(&self) -> Result<(), String> {
        self.check_locked(&self.inner.lock())
    }
    fn check_locked(&self, core: &super::Core) -> Result<(), String> {
        if self.inner.exiting.load(Ordering::Acquire) {
            return Err(refused());
        }
        self.stamp.check(core, "projects.clone")
    }
    async fn clone(self, app: &AppHandle, url: &str, destination: &Path) -> Outcome {
        let started = Instant::now();
        // Lookup can wait for a login-shell PATH probe. Revocation/lease loss
        // cancels this preparation too; most importantly it cannot authorize a
        // child later using a stamp that was valid only before that await.
        let lookup = crate::github::resolve_github_binary(app);
        tokio::pin!(lookup);
        let binary = loop {
            if self.check().is_err() {
                return Outcome::Failed;
            }
            tokio::select! {
                result = &mut lookup => match result { Ok(path) => break path, Err(_) => return Outcome::Failed },
                _ = tokio::time::sleep(AUTHORITY_POLL) => {}
            }
            if started.elapsed() >= RUN_LIMIT {
                return Outcome::TimedOut;
            }
        };
        let mut command = crate::github::github_command(&binary).into_std();
        command.args(["repo", "clone", url]).arg(destination);
        tauri::async_runtime::spawn_blocking(move || self.run(&mut command, started))
            .await
            .unwrap_or(Outcome::Failed)
    }
    fn run(&self, command: &mut Command, started: Instant) -> Outcome {
        // Re-pin on THIS worker, not the async thread that selected the folder.
        let Ok(parent) = fs_guard::Anchor::open(&self.parent.path) else {
            return Outcome::Failed;
        };
        let (Ok(opened), Ok(expected)) = (parent.identity(), self.parent.identity()) else {
            return Outcome::Failed;
        };
        if opened != expected {
            return Outcome::Failed;
        }
        command
            .current_dir(&parent.path)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let spawned = {
            let core = self.inner.lock();
            if self.check_locked(&core).is_err() || started.elapsed() >= RUN_LIMIT {
                return Outcome::Failed;
            }
            // Actual process creation (including Windows suspended Job Object
            // attach/resume) is synchronous under the same lock as revocation.
            crate::git_workspace::spawn_scoped_git(command)
        };
        let Ok((mut child, scope)) = spawned else {
            return Outcome::Failed;
        };
        loop {
            if self.check().is_err() {
                scope.stop(&mut child, refused());
                return Outcome::Failed;
            }
            if started.elapsed() >= RUN_LIMIT {
                scope.stop(&mut child, refused());
                return Outcome::TimedOut;
            }
            match child.try_wait() {
                Ok(Some(status)) => {
                    return if status.success() {
                        Outcome::Completed
                    } else {
                        Outcome::Failed
                    }
                }
                Ok(None) => std::thread::sleep(AUTHORITY_POLL),
                Err(_) => {
                    scope.stop(&mut child, refused());
                    return Outcome::Failed;
                }
            }
        }
        // Keep an incomplete destination for host inspection. Never recursively
        // delete a pathname after an uncertain process outcome.
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Root(PathBuf);
    impl Drop for Root {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    fn authority(root: &Path) -> Authority {
        let inner = RemoteState::default().inner;
        hostbridge::test_attach(&inner, 1);
        let mut grant = super::super::store::DeviceGrant::initial();
        grant.work = true;
        grant.capabilities.terminal = true;
        grant.capabilities.manage_projects = true;
        let stamp = Stamp {
            generation: 1,
            device: "clone-test".into(),
            grant_revision: grant.revision,
            op_id: "clone".into(),
            op_seq: 1,
            workspace_id: None,
            thread_id: None,
        };
        {
            let mut core = inner.lock();
            core.settings.hosting = true;
            core.devices.insert(
                stamp.device.clone(),
                super::super::store::DeviceRecord {
                    fingerprint: stamp.device.clone(),
                    spki: vec![],
                    name: "Test device".into(),
                    platform: None,
                    addresses: vec![],
                    they_host: false,
                    access_removed: false,
                    paired_at: 1,
                    last_seen_at: None,
                    grant: Some(grant),
                },
            );
        }
        Authority {
            inner,
            stamp,
            parent: fs_guard::Anchor::open(root).unwrap(),
        }
    }
    fn root() -> Root {
        let path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join(format!("remote-clone-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&path).unwrap();
        Root(path)
    }
    fn fixture_child(root: &Path) -> Command {
        let mut command =
            crate::process_launch::background_std_command(std::env::current_exe().unwrap());
        command
            .args([
                "--exact",
                "remote::clone::tests::owned_clone_test_process",
                "--nocapture",
            ])
            .env("MYTHRA_CLONE_TEST_CHILD", root);
        command
    }
    #[test]
    fn owned_clone_test_process() {
        // Only an explicitly spawned child takes this branch; a full suite
        // never creates processes or touches files in this helper test itself.
        let Some(root) = std::env::var_os("MYTHRA_CLONE_TEST_CHILD") else {
            return;
        };
        let root = PathBuf::from(root);
        assert!(root.starts_with(Path::new(env!("CARGO_MANIFEST_DIR")).join("target")));
        std::fs::write(root.join("SPAWNED"), "owned fixture").unwrap();
        std::thread::sleep(Duration::from_secs(20));
    }
    #[test]
    fn clone_needs_terminal_and_keeps_one_destination_reserved() {
        let root = root();
        let auth = authority(&root.0);
        assert!(auth.check().is_ok());
        auth.inner
            .lock()
            .devices
            .get_mut("clone-test")
            .unwrap()
            .grant
            .as_mut()
            .unwrap()
            .capabilities
            .terminal = false;
        assert!(auth.check().is_err());
        let mut jobs = HashMap::new();
        admit(&mut jobs, "one", "first", Some(&root.0)).unwrap();
        assert!(admit(&mut jobs, "two", "second", Some(&root.0)).is_err());
    }
    #[test]
    fn delayed_clone_cannot_spawn_after_revoke_or_generation_loss() {
        for revoke in [true, false] {
            let root = root();
            let auth = authority(&root.0);
            assert!(auth.check().is_ok()); // preparation began with authority
            if revoke {
                auth.inner
                    .lock()
                    .devices
                    .get_mut("clone-test")
                    .unwrap()
                    .grant = None;
            } else {
                hostbridge::test_attach(&auth.inner, 2);
            }
            let outcome = auth.run(&mut fixture_child(&root.0), Instant::now());
            assert!(outcome == Outcome::Failed);
            assert!(
                !root.0.join("SPAWNED").exists(),
                "no actual child was created"
            );
        }
    }
    #[test]
    fn revoke_and_generation_loss_stop_the_real_owned_clone_process() {
        for revoke in [true, false] {
            let root = root();
            let auth = authority(&root.0);
            let inner = auth.inner.clone();
            let mut command = fixture_child(&root.0);
            let (send, receive) = std::sync::mpsc::channel();
            let worker = std::thread::spawn(move || {
                let _ = send.send(auth.run(
                    &mut command,
                    Instant::now() - (RUN_LIMIT - Duration::from_secs(5)),
                ));
            });
            let deadline = Instant::now() + Duration::from_secs(3);
            while !root.0.join("SPAWNED").exists() && Instant::now() < deadline {
                std::thread::sleep(Duration::from_millis(10));
            }
            assert!(
                root.0.join("SPAWNED").exists(),
                "the actual child must start before invalidation"
            );
            let stopped = Instant::now();
            if revoke {
                inner.lock().devices.get_mut("clone-test").unwrap().grant = None;
            } else {
                hostbridge::test_attach(&inner, 2);
            }
            assert!(receive.recv_timeout(Duration::from_secs(3)).unwrap() == Outcome::Failed);
            worker.join().unwrap();
            assert!(stopped.elapsed() < Duration::from_secs(2));
        }
    }

    #[test]
    fn one_clone_at_a_time_per_device_and_two_overall() {
        let mut jobs = HashMap::new();
        admit(&mut jobs, "a", "one", None).expect("first");
        assert!(
            admit(&mut jobs, "b", "one", None).is_err(),
            "same device waits"
        );
        admit(&mut jobs, "c", "two", None).expect("second device");
        assert!(
            admit(&mut jobs, "d", "three", None).is_err(),
            "limit overall"
        );
        jobs.get_mut("a").expect("job").outcome = Outcome::Completed;
        admit(&mut jobs, "e", "one", None).expect("free again");
    }

    #[test]
    fn another_device_cant_read_a_clone() {
        let mut jobs = HashMap::new();
        admit(&mut jobs, "a", "one", None).expect("first");
        assert_eq!(state_of(&jobs, "a", "one"), Some("running"));
        assert_eq!(state_of(&jobs, "a", "two"), None);
        assert_eq!(state_of(&jobs, "missing", "one"), None);
    }

    #[test]
    fn remembered_clones_stay_bounded_and_a_running_one_survives() {
        let mut jobs = HashMap::new();
        admit(&mut jobs, "live", "busy", None).expect("running");
        for index in 0..40 {
            let id = format!("done-{index}");
            admit(&mut jobs, &id, "other", None).expect("room");
            jobs.get_mut(&id).expect("job").outcome = Outcome::Failed;
        }
        assert!(jobs.len() <= MAX_REMEMBERED);
        assert!(jobs.contains_key("live"));
    }
}
