//! Clones a GitHub repository into a folder the viewer browsed to. A clone can take
//! minutes, so the request only starts it and the viewer asks how it's going. Adding
//! the finished folder as a project is the ordinary `projects.add`.
use super::{commit, commit::Stamp, finish_write, folders, fs_guard, hostbridge, work, Inner, RemoteState};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tauri::{AppHandle, State, WebviewWindow};

const MAX_RUNNING: usize = 2;
const MAX_REMEMBERED: usize = 16;
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
}
static JOBS: Mutex<Option<HashMap<String, Job>>> = Mutex::new(None);

fn refused() -> String {
    work::refused("stale_target")
}
fn with_jobs<T>(change: impl FnOnce(&mut HashMap<String, Job>) -> T) -> T {
    let mut jobs = JOBS.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
    change(jobs.get_or_insert_with(HashMap::new))
}
/// Finished records go first, so a running clone is never forgotten to make room.
fn admit(jobs: &mut HashMap<String, Job>, id: &str, device: &str) -> Result<(), String> {
    jobs.retain(|_, job| job.outcome == Outcome::Running || job.created.elapsed() < KEEP_FINISHED);
    let running = jobs.values().filter(|job| job.outcome == Outcome::Running);
    if running.clone().count() >= MAX_RUNNING || running.clone().any(|job| job.device == device) {
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
        Job { device: device.to_owned(), created: Instant::now(), outcome: Outcome::Running },
    );
    Ok(())
}
fn state_of(jobs: &HashMap<String, Job>, id: &str, device: &str) -> Option<&'static str> {
    jobs.get(id).filter(|job| job.device == device).map(|job| match job.outcome {
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
    let Some((url, name)) = crate::github::clone_target(&url).filter(|(_, name)| fs_guard::leaf(name)) else {
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
    let selected = folders::selection(&inner, stamp.generation, &stamp.device, stamp.grant_revision, &folder_token)?;
    selected.validate()?;
    let destination: PathBuf = selected.path.join(&name);
    if destination.symlink_metadata().is_ok() {
        return Err(work::refused("busy"));
    }
    let id = uuid::Uuid::new_v4().to_string();
    let (s, worker, handle, title) = (stamp.clone(), inner.clone(), id.clone(), name.clone());
    let saved = finish_write(inner.enqueue_write(false, move |db| {
        if let Some(prior) = commit::prior(db, &s)? {
            return Ok((prior, true));
        }
        let tx = db.transaction().map_err(|_| refused())?;
        let core = worker.lock();
        s.check(&core, "projects.clone")?;
        with_jobs(|jobs| admit(jobs, &handle, &s.device))?;
        let result = json!({"opId":s.op_id,"state":"accepted","processHandle":handle,"name":title});
        if let Err(error) = commit::complete(&tx, &s, "projects.clone", &result, false).and_then(|()| tx.commit().map_err(|_| refused())) {
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
        let finished = crate::github::clone_into(&app, &url, &destination).await;
        with_jobs(|jobs| {
            if let Some(job) = jobs.get_mut(&id) {
                job.outcome = finished.into();
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

impl From<crate::github::CloneFinished> for Outcome {
    fn from(value: crate::github::CloneFinished) -> Self {
        match value {
            crate::github::CloneFinished::Done => Self::Completed,
            crate::github::CloneFinished::Failed => Self::Failed,
            crate::github::CloneFinished::TimedOut => Self::TimedOut,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn one_clone_at_a_time_per_device_and_two_overall() {
        let mut jobs = HashMap::new();
        admit(&mut jobs, "a", "one").expect("first");
        assert!(admit(&mut jobs, "b", "one").is_err(), "same device waits");
        admit(&mut jobs, "c", "two").expect("second device");
        assert!(admit(&mut jobs, "d", "three").is_err(), "limit overall");
        jobs.get_mut("a").expect("job").outcome = Outcome::Completed;
        admit(&mut jobs, "e", "one").expect("free again");
    }

    #[test]
    fn another_device_cant_read_a_clone() {
        let mut jobs = HashMap::new();
        admit(&mut jobs, "a", "one").expect("first");
        assert_eq!(state_of(&jobs, "a", "one"), Some("running"));
        assert_eq!(state_of(&jobs, "a", "two"), None);
        assert_eq!(state_of(&jobs, "missing", "one"), None);
    }

    #[test]
    fn remembered_clones_stay_bounded_and_a_running_one_survives() {
        let mut jobs = HashMap::new();
        admit(&mut jobs, "live", "busy").expect("running");
        for index in 0..40 {
            let id = format!("done-{index}");
            admit(&mut jobs, &id, "other").expect("room");
            jobs.get_mut(&id).expect("job").outcome = Outcome::Failed;
        }
        assert!(jobs.len() <= MAX_REMEMBERED);
        assert!(jobs.contains_key("live"));
    }
}
