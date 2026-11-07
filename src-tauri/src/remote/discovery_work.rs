//! Discovery owns its exact temporary/native/HTTP worker, independently of turns.
use super::{
    commit::{self, Stamp},
    fs_guard::Anchor,
    hostbridge, instructions, work, Core, Inner, RemoteState,
};
use serde_json::{json, Value};
use std::time::{Duration, Instant};
use std::{
    collections::HashMap,
    future::Future,
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc, Mutex,
    },
};
use tauri::{AppHandle, Emitter, State, WebviewWindow};
#[derive(Default)]
pub(super) struct Registry {
    routes: HashMap<String, Arc<Route>>,
}
pub(crate) struct Route {
    id: String,
    created: Instant,
    app: Option<AppHandle>,
    stamp: Stamp,
    op: String,
    inner: Arc<Inner>,
    root: Anchor,
    alive: AtomicBool,
    next: AtomicUsize,
    worker: Mutex<Option<crate::run_discovery::RemoteWorker>>,
    result: Mutex<Option<Result<Value, String>>>,
}
fn stale() -> String {
    work::refused("stale_target")
}
impl Route {
    fn check(&self, core: &Core) -> Result<(), String> {
        if !self.alive.load(Ordering::Acquire) {
            return Err(work::refused("cancelled"));
        }
        self.stamp.check(core, &self.op)?;
        self.root.validate()
    }
    pub(crate) fn inspect<T>(&self, read: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
        self.check(&self.inner.lock())?;
        // Inspection is read-only and cancellation-aware. Never hold the app's
        // decision lock across disk/network-volume I/O; discard its evidence if
        // permission changed while reading, before any model input can use it.
        let result = read()?;
        self.check(&self.inner.lock())?;
        Ok(result)
    }
    pub(crate) async fn input(self: &Arc<Self>, phase: &str) -> Result<Input, String> {
        let next = self.next.fetch_add(1, Ordering::AcqRel);
        if next >= 64 {
            return Err(work::refused("busy"));
        }
        let route = self.clone();
        let phase = phase.to_owned();
        let stamp = super::finish_write(self.inner.enqueue_write(false, move |db| {
            let core = route.inner.lock();
            route.check(&core)?;
            let tx = db.transaction().map_err(|_| stale())?;
            let child = instructions::child(
                &tx,
                &route.stamp,
                &format!("discovery-{next}"),
                "engine.discovery",
                route.stamp.thread_id.as_deref(),
                &json!({"phase":phase}),
            )?;
            tx.commit().map_err(|_| stale())?;
            Ok(child)
        }))
        .await?;
        Ok(Input {
            route: self.clone(),
            stamp,
            begun: false,
        })
    }
    fn reclaimable(&self) -> bool {
        self.result
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .is_some()
            && self
                .worker
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .as_ref()
                .is_some_and(|w| w.confirmed_finished())
    }
    fn close(&self) {
        self.alive.store(false, Ordering::Release);
        if let Some(worker) = self
            .worker
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .as_ref()
        {
            worker.cancel();
        }
    }
}
pub(crate) struct Input {
    route: Arc<Route>,
    stamp: Stamp,
    begun: bool,
}
impl Input {
    pub(crate) fn spawn<T>(
        &mut self,
        spawn: impl FnOnce() -> Result<T, String>,
    ) -> Result<T, String> {
        let core = self.route.inner.lock();
        self.route.check(&core)?;
        self.begun = true;
        spawn()
    }
    pub(crate) async fn write<T, F: Future<Output = Result<T, String>>>(
        &mut self,
        future: F,
    ) -> Result<T, String> {
        tokio::pin!(future);
        std::future::poll_fn(|cx| {
            if self.begun {
                return future.as_mut().poll(cx);
            }
            let core = self.route.inner.lock();
            if let Err(e) = self.route.check(&core) {
                return std::task::Poll::Ready(Err(e));
            }
            self.begun = true;
            future.as_mut().poll(cx)
        })
        .await
    }
    pub(crate) async fn finish(self, success: bool) -> Result<(), String> {
        let stamp = self.stamp;
        let state = if success {
            "accepted"
        } else if self.begun {
            "uncertain"
        } else {
            "rejected"
        };
        super::finish_write(self.route.inner.enqueue_write(false, move |db| {
            let tx = db.transaction().map_err(|_| stale())?;
            commit::complete(
                &tx,
                &stamp,
                "engine.discovery",
                &json!({"opId":stamp.op_id,"state":state}),
                false,
            )?;
            tx.commit().map_err(|_| stale())
        }))
        .await
    }
}
pub(super) fn invalidate(core: &mut Core, device: Option<&str>) {
    for route in core
        .discovery_jobs
        .routes
        .values()
        .filter(|r| device.is_none_or(|d| d == r.stamp.device))
    {
        route.close();
        let route = route.clone();
        tauri::async_runtime::spawn(async move {
            let worker = route
                .worker
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .clone();
            if let Some(worker) = worker {
                if worker.stop().await.is_err() {
                    if let Some(app) = route.app.as_ref() {
                        let _=app.emit("remote-runtime-warning",json!({"device":route.stamp.device,"message":"Command discovery may still be running. When other work has finished, quit and reopen Mythra Code on this device."}));
                    }
                }
            }
        });
    }
}
fn binding(db: &rusqlite::Connection, stamp: &Stamp, root: &str) -> Result<(), String> {
    let projects = commit::state_row(db, "kiwi.projects")?["value"].clone();
    let Some(project) = projects.as_array().and_then(|rows| {
        rows.iter()
            .find(|r| r["id"].as_str() == stamp.workspace_id.as_deref())
    }) else {
        return Err(stale());
    };
    let project_root = project["path"].as_str().ok_or_else(stale)?;
    let bound = if let Some(thread) = stamp.thread_id.as_deref() {
        let known = commit::state_row(db, "kiwi.knownThreads")?["value"].clone();
        if known.get(thread).is_none() {
            return Err(stale());
        }
        let bindings = commit::state_row(db, "kiwi.threadProjects")?["value"].clone();
        let bound = bindings
            .get(thread)
            .and_then(Value::as_str)
            .or_else(|| known[thread]["cwd"].as_str())
            .ok_or_else(stale)?;
        if std::fs::canonicalize(bound).ok() != std::fs::canonicalize(project_root).ok() {
            return Err(stale());
        }
        let trees = commit::state_row(db, "kiwi.threadWorktrees")?["value"].clone();
        trees
            .get(thread)
            .filter(|r| r["status"] != "removed")
            .and_then(|r| r["path"].as_str())
            .unwrap_or(project_root)
            .to_owned()
    } else {
        project_root.to_owned()
    };
    if Anchor::open(std::path::Path::new(root))?.identity()?
        != Anchor::open(std::path::Path::new(&bound))?.identity()?
    {
        return Err(stale());
    }
    Ok(())
}
#[tauri::command]
pub(crate) async fn remote_discovery_start(
    app: AppHandle,
    state: State<'_, RemoteState>,
    window: WebviewWindow,
    stamp: Stamp,
    root: String,
    options: Value,
) -> Result<Value, String> {
    hostbridge::window_is_host(&window).map_err(|_| stale())?;
    let inner = state.inner.clone();
    tauri::async_runtime::spawn(async move { start(app, inner, stamp, root, options).await })
        .await
        .map_err(|_| stale())?
}
async fn start(
    app: AppHandle,
    inner: Arc<Inner>,
    stamp: Stamp,
    root: String,
    options: Value,
) -> Result<Value, String> {
    let s = stamp.clone();
    let r = root.clone();
    let worker = inner.clone();
    let (op, prior) = inner
        .read_db(move |db| {
            let op = commit::operation(db, &s)?;
            if !matches!(op.as_str(), "discovery.run.start" | "discovery.check.start") {
                return Err(stale());
            }
            s.check(&worker.lock(), &op)?;
            binding(db, &s, &r)?;
            Ok((op, commit::prior(db, &s)?))
        })
        .await?;
    if let Some(prior) = prior {
        return Ok(prior);
    }
    let route = Arc::new(Route {
        id: uuid::Uuid::new_v4().to_string(),
        created: Instant::now(),
        app: Some(app.clone()),
        stamp: stamp.clone(),
        op: op.clone(),
        inner: inner.clone(),
        root: Anchor::open(std::path::Path::new(&root))?,
        alive: AtomicBool::new(true),
        next: AtomicUsize::new(0),
        worker: Mutex::new(None),
        result: Mutex::new(None),
    });
    let prepared = crate::run_discovery::remote_prepare(&app, &root, &op, options, route.clone())?;
    *route
        .worker
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(prepared.worker());
    let r = route.clone();
    let worker = inner.clone();
    let s = stamp.clone();
    let o = op.clone();
    let path = root.clone();
    let saved=super::finish_write(inner.enqueue_write(false,move|db|{
        if let Some(prior)=commit::prior(db,&s)?{return Ok((prior,true));}
        let tx=db.transaction().map_err(|_|stale())?;binding(&tx,&s,&path)?;let mut core=worker.lock();s.check(&core,&o)?;
        // Retain active/uncertain exact owners; evict only finished histories.
        core.discovery_jobs.routes.retain(|_,r|r.created.elapsed()<Duration::from_secs(600)||!r.reclaimable());
        if core.discovery_jobs.routes.len()>=64{let oldest=core.discovery_jobs.routes.iter().filter(|(_,r)|r.reclaimable()).min_by_key(|(_,r)|r.created).map(|(id,_)|id.clone());if let Some(id)=oldest{core.discovery_jobs.routes.remove(&id);}}
        if core.discovery_jobs.routes.len()>=64{return Err(work::refused("busy"));}
        let result=json!({"opId":s.op_id,"state":"accepted","workspaceId":s.workspace_id,"processHandle":r.id});
        commit::complete(&tx,&s,&o,&result,false)?;tx.commit().map_err(|_|stale())?;
        core.discovery_jobs.routes.insert(r.id.clone(),r);Ok((result,false))
    })).await?;
    if saved.1 {
        return Ok(saved.0);
    }
    let r = route.clone();
    tauri::async_runtime::spawn(async move {
        let outcome = prepared
            .execute(app.clone())
            .await
            .and_then(|value| serde_json::to_value(value).map_err(|_| stale()));
        *r.result
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(outcome);
        // Guard drop marks exact completion before this task publishes done.
        let _=app.emit("remote-discovery-state",json!({"device":r.stamp.device,"processHandle":r.id,"workspaceId":r.stamp.workspace_id}));
    });
    Ok(saved.0)
}
#[tauri::command]
pub(crate) async fn remote_discovery_status(
    state: State<'_, RemoteState>,
    window: WebviewWindow,
    generation: u64,
    device: String,
    grant_revision: u64,
    workspace_id: String,
    process_handle: String,
) -> Result<Value, String> {
    hostbridge::window_is_host(&window).map_err(|_| stale())?;
    super::studio::check_scope(
        &state,
        generation,
        &device,
        grant_revision,
        Some(&workspace_id),
        false,
    )?;
    let core = state.inner.lock();
    hostbridge::check_generation(&core, generation).map_err(|_| stale())?;
    let grant = work::grant_locked(&core, &device)
        .filter(|g| g.view && g.revision == grant_revision)
        .ok_or_else(stale)?;
    if let super::store::GrantScope::Projects { project_ids } = &grant.scope {
        if !project_ids.contains(&workspace_id) {
            return Err(work::refused("forbidden"));
        }
    }
    let route = core
        .discovery_jobs
        .routes
        .get(&process_handle)
        .filter(|r| {
            r.stamp.device == device && r.stamp.workspace_id.as_deref() == Some(&workspace_id)
        })
        .ok_or_else(stale)?;
    let finished = route
        .worker
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .as_ref()
        .is_some_and(|w| w.confirmed_finished());
    let result = route
        .result
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    Ok(match result.as_ref() {
        None => {
            json!({"state":if route.alive.load(Ordering::Acquire){"running"}else{"stopping"},"processHandle":process_handle})
        }
        Some(Ok(result)) => {
            json!({"state":"completed","processHandle":process_handle,"discovery":result})
        }
        Some(Err(_)) => {
            if finished {
                json!({"state":if route.alive.load(Ordering::Acquire){"failed"}else{"stopped"},"processHandle":process_handle,"message":"Discovery stopped without finding a command. Try again on the host device."})
            } else {
                json!({"state":"uncertain","processHandle":process_handle,"message":"Discovery may still be running. When other work has finished, quit and reopen Mythra Code on the host device."})
            }
        }
    })
}
#[tauri::command]
pub(crate) async fn remote_discovery_stop(
    state: State<'_, RemoteState>,
    window: WebviewWindow,
    stamp: Stamp,
    process_handle: String,
) -> Result<Value, String> {
    hostbridge::window_is_host(&window).map_err(|_| stale())?;
    let inner = state.inner.clone();
    let s = stamp.clone();
    let worker = inner.clone();
    let route=super::finish_write(inner.enqueue_write(false,move|db|{
        if let Some(prior)=commit::prior(db,&s)?{return Ok(Err(prior));}
        let op=commit::operation(db,&s)?;if !matches!(op.as_str(),"discovery.run.stop"|"discovery.check.stop"){return Err(stale());}
        let core=worker.lock();s.check(&core,&op)?;let route=core.discovery_jobs.routes.get(&process_handle).filter(|r|r.stamp.device==s.device&&r.stamp.workspace_id==s.workspace_id&&r.op.replace(".start",".stop")==op).cloned().ok_or_else(stale)?;
        let mut receipt=super::store::delivery_receipt(db,&s.device,&s.op_id,s.op_seq)?.ok_or_else(stale)?;
        receipt["nativeSteps"]=json!(["discovery-stop"]);receipt["disposition"]=json!("dispatched");receipt["stopTarget"]=json!(route.id);
        db.execute("UPDATE remote_op_journal SET delivery_json=?4 WHERE device_fingerprint=?1 AND op_id=?2 AND op_seq=?3",rusqlite::params![s.device,s.op_id,s.op_seq as i64,receipt.to_string()]).map_err(|_|stale())?;
        route.close();Ok(Ok(route))
    })).await?;
    let route = match route {
        Ok(route) => route,
        Err(replay) => return Ok(replay),
    };
    let exact = route
        .worker
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .clone()
        .ok_or_else(stale)?;
    exact.stop().await?;
    super::finish_write(inner.enqueue_write(false,move|db|{let op=commit::operation(db,&stamp)?;let tx=db.transaction().map_err(|_|stale())?;let result=json!({"opId":stamp.op_id,"state":"accepted","workspaceId":stamp.workspace_id,"processHandle":route.id,"confirmed":true});commit::complete(&tx,&stamp,&op,&result,false)?;tx.commit().map_err(|_|stale())?;Ok(result)})).await
}
#[cfg(test)]
mod tests {
    use super::*;
    fn route() -> (Arc<Route>, std::path::PathBuf) {
        let path =
            std::env::temp_dir().join(format!("mythra-discovery-grant-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&path).unwrap();
        let inner = RemoteState::default().inner;
        hostbridge::test_attach(&inner, 1);
        let revision = {
            let mut core = inner.lock();
            core.settings.hosting = true;
            let mut grant = super::super::store::DeviceGrant::initial();
            grant.work = true;
            grant.capabilities.terminal = true;
            grant.scope = super::super::store::GrantScope::Projects {
                project_ids: vec!["p".into()],
            };
            let revision = grant.revision;
            core.devices.insert(
                "device".into(),
                super::super::store::DeviceRecord {
                    fingerprint: "device".into(),
                    spki: vec![],
                    name: "test".into(),
                    platform: None,
                    addresses: vec![],
                    they_host: false,
                    access_removed: false,
                    paired_at: 1,
                    last_seen_at: None,
                    grant: Some(grant),
                },
            );
            revision
        };
        let stamp = Stamp {
            generation: 1,
            device: "device".into(),
            grant_revision: revision,
            op_id: "root".into(),
            op_seq: 1,
            workspace_id: Some("p".into()),
            thread_id: None,
        };
        (
            Arc::new(Route {
                id: "handle".into(),
                created: Instant::now(),
                app: None,
                stamp,
                op: "discovery.run.start".into(),
                inner,
                root: Anchor::open(&path).unwrap(),
                alive: AtomicBool::new(true),
                next: AtomicUsize::new(0),
                worker: Mutex::new(None),
                result: Mutex::new(None),
            }),
            path,
        )
    }
    #[tokio::test]
    async fn discovery_checks_live_terminal_grant_at_the_actual_first_poll_and_inspection() {
        let (route, path) = route();
        assert_eq!(route.inspect(|| Ok(7)).unwrap(), 7);
        route
            .inner
            .lock()
            .devices
            .get_mut("device")
            .unwrap()
            .grant
            .as_mut()
            .unwrap()
            .capabilities
            .terminal = false;
        let called = AtomicBool::new(false);
        assert!(route
            .inspect(|| {
                called.store(true, Ordering::Release);
                Ok(())
            })
            .is_err());
        let mut input = Input {
            route: route.clone(),
            stamp: route.stamp.clone(),
            begun: false,
        };
        assert!(input
            .write(async {
                called.store(true, Ordering::Release);
                Ok(())
            })
            .await
            .is_err());
        assert!(!called.load(Ordering::Acquire));
        route
            .inner
            .lock()
            .devices
            .get_mut("device")
            .unwrap()
            .grant
            .as_mut()
            .unwrap()
            .capabilities
            .terminal = true;
        assert!(route
            .inspect(|| {
                route
                    .inner
                    .lock()
                    .devices
                    .get_mut("device")
                    .unwrap()
                    .grant
                    .as_mut()
                    .unwrap()
                    .capabilities
                    .terminal = false;
                Ok("must not reach the model")
            })
            .is_err());
        route.close();
        assert!(route.inspect(|| Ok(())).is_err());
        drop(input);
        drop(route);
        std::fs::remove_dir(path).unwrap();
    }
}
