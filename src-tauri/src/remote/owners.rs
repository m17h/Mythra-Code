//! Native lifetimes for renderer engines. A timestamp is never ownership proof.
//! Each admitted child must carry ownerHandle before preparation/spawn/write.
use super::{
    commit::{self, Stamp},
    hostbridge,
    work::{self, RemoteDelivery, Target},
    Core, RemoteState,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
    time::Duration,
};
use tauri::{AppHandle, State, WebviewWindow};
use tokio::sync::Notify;
#[derive(Default)]
pub(super) struct Registry {
    owners: HashMap<String, Owner>,
    bindings: HashMap<(String, String), String>,
    commands: HashMap<(String, String), HashMap<i64, Arc<EngineCommand>>>,
}
struct Owner {
    local: bool,
    stamp: Stamp,
    kind: String,
    prepared_threads: HashSet<String>,
    thread: Option<String>,
    run: String,
    closed: bool,
    pending: HashSet<String>,
    children: HashMap<String, Child>,
    signal: Arc<Notify>,
}
#[derive(Clone)]
enum Child {
    Native(Target),
    Terminal(Arc<super::terminal::Route>),
    Command(Arc<EngineCommand>),
}
fn stale() -> String {
    work::refused("stale_target")
}
fn key(target: &Target) -> String {
    format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(target).unwrap_or_default())
    )
}
#[tauri::command]
pub(crate) async fn remote_work_owner_open(
    state: State<'_, RemoteState>,
    window: WebviewWindow,
    stamp: Stamp,
    kind: String,
    run_id: String,
) -> Result<Value, String> {
    hostbridge::window_is_host(&window).map_err(|_| stale())?;
    if !matches!(kind.as_str(), "parent" | "workflow" | "start")
        || run_id.is_empty()
        || run_id.len() > 256
    {
        return Err(stale());
    }
    let inner = state.inner.clone();
    super::finish_write(state.inner.enqueue_write(false,move|db|{
        let op=commit::operation(db,&stamp)?;
        if (kind=="workflow"&&op!="workflows.start")||(kind!="workflow"&&!matches!(op.as_str(),"prompt.send"|"prompt.queue"|"queue.edit.finish"|"queue.retry"|"prompt.schedule"|"prompt.scheduleNew"|"schedules.edit"|"thread.handoff.send"|"parent.continue"|"run.start"|"checks.start"|"actions.run"|"review.start"|"git.suggestCommit"|"agents.replace")){return Err(stale());}
        let mut receipt=super::store::delivery_receipt(db,&stamp.device,&stamp.op_id,stamp.op_seq)?.unwrap_or_else(||json!({"generation":stamp.generation,"device":stamp.device,"opId":stamp.op_id,"opSeq":stamp.op_seq,"workspaceId":stamp.workspace_id,"threadId":stamp.thread_id,"disposition":"preparing","op":op}));
        let mut core=inner.lock();stamp.check(&core,&op)?;
        if op=="agents.replace"&&!receipt["agentCutoffConfirmed"].is_string(){return Err(stale());}
        if let Some(handle)=receipt.get("engineOwnerHandle").and_then(Value::as_str){return if core.owners.owners.get(handle).is_some_and(|owner|!owner.closed&&owner.kind==kind&&owner.run==run_id){Ok(json!({"ownerHandle":handle}))}else{Err(stale())};}
        if receipt.get("nativeSteps").and_then(Value::as_array).is_some_and(|steps|!steps.is_empty())||(matches!(receipt.get("disposition").and_then(Value::as_str),Some("uncertain"|"rejected"))||(receipt.get("disposition").and_then(Value::as_str)==Some("dispatched")&&!matches!(op.as_str(),"thread.handoff.send"|"prompt.scheduleNew"|"agents.replace")))||(kind!="workflow"&&!matches!(op.as_str(),"run.start"|"checks.start"|"actions.run"|"review.start"|"git.suggestCommit"|"parent.continue")&&receipt.get("disposition").and_then(Value::as_str)==Some("accepted")){return Err(stale());}
        if core.owners.owners.len()>=256||core.owners.bindings.len()>=4096{return Err(work::refused("busy"));}
        if core.owners.owners.values().any(|o|o.stamp.generation==stamp.generation&&o.stamp.device==stamp.device&&o.kind==kind&&o.run==run_id){return Err(stale());}
        let handle=uuid::Uuid::new_v4().to_string();if op=="prompt.scheduleNew"&&receipt["preparationDetached"]==true{receipt["preparationDetached"]=json!(false);}receipt["ownerHandle"]=json!(handle);receipt["engineOwnerHandle"]=json!(handle);
        db.execute("UPDATE remote_op_journal SET delivery_json=?4 WHERE device_fingerprint=?1 AND op_id=?2 AND op_seq=?3",rusqlite::params![stamp.device,stamp.op_id,stamp.op_seq as i64,receipt.to_string()]).map_err(|_|stale())?;
        core.owners.bindings.insert((stamp.device.clone(),stamp.op_id.clone()),handle.clone());let thread=if op=="thread.handoff.send"{None}else{stamp.thread_id.clone()};core.owners.owners.insert(handle.clone(),Owner{local:false,stamp,kind,prepared_threads:HashSet::new(),thread,run:run_id,closed:false,pending:HashSet::new(),children:HashMap::new(),signal:Arc::new(Notify::new())});Ok(json!({"ownerHandle":handle}))
    })).await
}

pub(super) fn attach(
    core: &mut Core,
    meta: &RemoteDelivery,
    workspace: Option<&str>,
    ticket: &str,
) -> Result<(), String> {
    let binding = (meta.device.clone(), meta.op_id.clone());
    if let Some(bound) = core.owners.bindings.get(&binding) {
        if meta.owner_handle.as_ref() != Some(bound) {
            return Err(stale());
        }
    }
    if let Some(handle) = &meta.owner_handle {
        let owner = core.owners.owners.get_mut(handle).ok_or_else(stale)?;
        if owner.closed
            || owner.stamp.generation != meta.generation
            || owner.stamp.device != meta.device
            || owner.stamp.workspace_id.as_deref() != workspace
            || owner.pending.len() >= 512
            || owner.children.len() + owner.pending.len() * 2 + 2 > 512
        {
            return Err(stale());
        }
        if core.owners.bindings.len() >= 4096 {
            return Err(work::refused("busy"));
        }
        owner.pending.insert(ticket.to_owned());
        core.owners.bindings.insert(binding, handle.clone());
    }
    Ok(())
}
pub(super) fn check(core: &Core, meta: &RemoteDelivery) -> Result<(), String> {
    if let Some(bound) = core
        .owners
        .bindings
        .get(&(meta.device.clone(), meta.op_id.clone()))
    {
        if meta.owner_handle.as_ref() != Some(bound) {
            return Err(stale());
        }
    }
    if let Some(handle) = &meta.owner_handle {
        let owner = core.owners.owners.get(handle).ok_or_else(stale)?;
        if owner.closed
            || owner.stamp.generation != meta.generation
            || owner.stamp.device != meta.device
        {
            return Err(stale());
        }
    }
    Ok(())
}
pub(super) fn release(core: &mut Core, meta: &RemoteDelivery, ticket: &str) {
    if let Some(owner) = meta
        .owner_handle
        .as_ref()
        .and_then(|h| core.owners.owners.get_mut(h))
    {
        owner.pending.remove(ticket);
        owner.signal.notify_waiters();
    }
}
pub(super) fn record(core: &mut Core, meta: &RemoteDelivery, target: Target) -> Result<(), String> {
    if let Some(owner) = meta
        .owner_handle
        .as_ref()
        .and_then(|h| core.owners.owners.get_mut(h))
    {
        if owner.children.len() >= 512 {
            return Err(work::refused("busy"));
        }
        if owner.thread.is_none() {
            owner.thread = target.thread_id.clone();
        }
        owner.children.insert(key(&target), Child::Native(target));
        owner.signal.notify_waiters();
    }
    Ok(())
}
pub(super) fn record_terminal(
    core: &mut Core,
    handle: Option<&str>,
    id: &str,
    route: Arc<super::terminal::Route>,
) -> Result<(), String> {
    if let Some(handle) = handle {
        let owner = core.owners.owners.get_mut(handle).ok_or_else(stale)?;
        if owner.closed || owner.children.len() + owner.pending.len() * 2 + 1 > 512 {
            return Err(stale());
        }
        owner.children.insert(id.to_owned(), Child::Terminal(route));
    }
    Ok(())
}
pub(super) fn invalidate(core: &mut Core) {
    super::prompt_preparation::invalidate(core);
    for owner in core.owners.owners.values_mut().filter(|owner| !owner.local) {
        cancel_owned_commands(owner);
        owner.closed = true;
        owner.signal.notify_waiters();
    }
    core.owners.owners.retain(|_, owner| owner.local);
    core.owners.bindings.clear();
}
pub(super) fn prove_target(core: &Core, target: &Target) -> Result<String, String> {
    let handle = target.owner_handle.as_deref().ok_or_else(stale)?;
    let owner = core.owners.owners.get(handle).ok_or_else(stale)?;
    if target.kind != "parent"
        || target.method.as_deref() != Some(format!("engine:{}:{}", owner.kind, owner.run).as_str())
        || owner.closed
        || (!owner.local && owner.stamp.generation != target.generation)
        || owner.stamp.workspace_id != target.workspace_id
        || owner.thread != target.thread_id
    {
        return Err(stale());
    }
    Ok(format!("engine:{handle}"))
}
#[tauri::command]
pub(crate) async fn remote_work_owner_retire(
    app: AppHandle,
    state: State<'_, RemoteState>,
    window: WebviewWindow,
    stamp: Stamp,
    owner_handle: String,
) -> Result<Value, String> {
    hostbridge::window_is_host(&window).map_err(|_| stale())?;
    retire(&app, &state, stamp, owner_handle).await
}
pub(super) async fn retire(
    app: &AppHandle,
    state: &RemoteState,
    stamp: Stamp,
    handle: String,
) -> Result<Value, String> {
    let copy = stamp.clone();
    let worker = state.inner.clone();
    let saved=state.inner.enqueue_write(false,move|db|{
        let op=commit::operation(db,&copy)?;if !matches!(op.as_str(),"turn.stop"|"workflows.stop"|"run.stop"|"checks.stop"){return Err(stale());}
        if let Some(result)=commit::prior(db,&copy)?{return Ok(Some(result));}
        let core=worker.lock();copy.check(&core,&op)?;
        super::store::save_delivery_receipt(db,&copy.device,&copy.op_id,copy.op_seq,&json!({"generation":copy.generation,"device":copy.device,"opId":copy.op_id,"opSeq":copy.op_seq,"workspaceId":copy.workspace_id,"threadId":copy.thread_id,"permission":"read-only","disposition":"dispatched"}))?;Ok(None)
    });
    if let Some(result) = super::finish_write(saved).await? {
        return Ok(
            json!({"confirmed":result.get("confirmed").and_then(Value::as_bool)==Some(true)}),
        );
    }
    {
        let mut core = state.inner.lock();
        stamp.check(&core, "turn.stop")?;
        let owner = core.owners.owners.get_mut(&handle).ok_or_else(stale)?;
        if (!owner.local && owner.stamp.generation != stamp.generation)
            || owner.stamp.workspace_id != stamp.workspace_id
            || owner.closed
        {
            return Err(stale());
        }
        owner.closed = true;
        owner.signal.notify_waiters();
        super::prompt_preparation::retire_owner(&mut core,&handle);
    }
    let work = async {
        let mut done = HashSet::new();
        loop {
            let (children, pending, signal) = {
                let core = state.inner.lock();
                let owner = core.owners.owners.get(&handle).ok_or_else(stale)?;
                (
                    owner
                        .children
                        .iter()
                        .filter(|(id, _)| !done.contains(*id))
                        .map(|(id, child)| (id.clone(), child.clone()))
                        .collect::<Vec<_>>(),
                    owner.pending.len(),
                    owner.signal.clone(),
                )
            };
            for (id, child) in children {
                match child {
                    Child::Terminal(route) => super::terminal::retire_exact(route).await?,
                    Child::Command(command) => retire_command(app, &command).await?,
                    Child::Native(mut target) => {
                        if crate::remote_owned_child_ended(app, &mut target).await? {
                            done.insert(id);
                            continue;
                        }
                        let expected = target.owner.clone();
                        let actual = crate::remote_native_owner(app, &mut target).await?;
                        if expected != actual {
                            return Err(stale());
                        }
                        target.device = stamp.device.clone();
                        target.generation = stamp.generation;
                        target.revision = stamp.grant_revision;
                        target.claimed = None;
                        target.expires = Some(std::time::Instant::now() + Duration::from_secs(60));
                        let target_handle = uuid::Uuid::new_v4().to_string();
                        state
                            .inner
                            .lock()
                            .work
                            .targets
                            .insert(target_handle.clone(), target.clone());
                        let step = format!("owner_stop:{id}");
                        let mut permit = work::prepare_native(
                            app,
                            stamp.meta(),
                            &step,
                            None,
                            Some(target_handle.clone()),
                        )
                        .await?;
                        let cutoff=crate::remote_native_dispatch(app,&target,"turn_stop",json!({"threadId":target.thread_id,"turnId":target.turn_id,"startRequestId":target.start_request_id}),&mut permit).await;
                        state.inner.lock().work.targets.remove(&target_handle);
                        cutoff?;
                    }
                }
                done.insert(id);
            }
            if pending == 0 {
                let core = state.inner.lock();
                let owner = core.owners.owners.get(&handle).ok_or_else(stale)?;
                if owner.pending.is_empty() && owner.children.keys().all(|id| done.contains(id)) {
                    return Ok::<_, String>(());
                }
            }
            let change = signal.notified();
            tokio::pin!(change);
            change.as_mut().enable();
            {
                let core = state.inner.lock();
                let owner = core.owners.owners.get(&handle).ok_or_else(stale)?;
                if owner.pending.is_empty() && owner.children.keys().all(|id| done.contains(id)) {
                    return Ok(());
                }
            }
            change.await;
        }
    };
    if !matches!(
        tokio::time::timeout(Duration::from_secs(15), work).await,
        Ok(Ok(()))
    ) {
        return Ok(json!({"confirmed":false}));
    }
    let copy = stamp.clone();
    let root = {
        let core = state.inner.lock();
        core.owners
            .owners
            .get(&handle)
            .filter(|o| !o.local)
            .map(|o| o.stamp.clone())
    };
    let final_authority = state.inner.clone();
    super::finish_write(state.inner.enqueue_write(false, move |db| {
        let tx = db.transaction().map_err(|_| stale())?;
        let core = final_authority.lock();
        let operation = commit::operation(&tx, &copy)?;
        copy.check(&core, &operation)?;
        if let Some(root) = root {
            super::store::reject_unused_engine_steps(&tx, &root.device, &root.op_id)?;
        }
        let op = commit::operation(&tx, &copy)?;
        commit::complete(
            &tx,
            &copy,
            &op,
            &json!({"opId":copy.op_id,"state":"accepted","confirmed":true}),
            false,
        )?;
        tx.commit().map_err(|_| stale())
    }))
    .await?;
    state.inner.lock().owners.owners.remove(&handle);
    Ok(json!({"confirmed":true}))
}

pub(crate) fn prove_owner(app: &AppHandle, target: &Target) -> Result<String, String> {
    use tauri::Manager;
    let state = app.state::<RemoteState>();
    let core = state.inner.lock();
    prove_target(&core, target)
}

pub(super) fn target_method(
    inner: &super::Inner,
    handle: &str,
    run: Option<&str>,
) -> Result<String, super::wire::WireError> {
    let core = inner.lock();
    let owner = core
        .owners
        .owners
        .get(handle)
        .filter(|owner| run == Some(owner.run.as_str()))
        .ok_or_else(|| super::wire::WireError::new("stale_target", "This task has ended."))?;
    Ok(format!("engine:{}:{}", owner.kind, owner.run))
}

pub(super) fn is_open(core: &Core, handle: &str) -> bool {
    core.owners.owners.get(handle).is_some_and(|owner| {
        !owner.closed
            && (owner.local || hostbridge::check_generation(core, owner.stamp.generation).is_ok())
    })
}

pub(super) fn retire_device(core: &mut Core, device: &str) {
    super::prompt_preparation::retire_device(core,device);
    for owner in core
        .owners
        .owners
        .values_mut()
        .filter(|owner| !owner.local && owner.stamp.device == device)
    {
        cancel_owned_commands(owner);
        owner.closed = true;
        owner.signal.notify_waiters();
    }
}

fn owns_thread(owner: &Owner, thread: &str) -> bool {
    owner.thread.as_deref() == Some(thread)
        || owner.thread.is_none() && owner.stamp.thread_id.as_deref() == Some(thread)
        || owner.prepared_threads.contains(thread)
        || owner.children.values().any(|child| matches!(child, Child::Native(target) if target.thread_id.as_deref() == Some(thread)))
}

fn same_child(left: &Child, right: &Child) -> bool {
    match (left, right) {
        (Child::Native(left), Child::Native(right)) => key(left) == key(right),
        (Child::Terminal(left), Child::Terminal(right)) => Arc::ptr_eq(left, right),
        (Child::Command(left), Child::Command(right)) => Arc::ptr_eq(left, right),
        _ => false,
    }
}

/// An explicit local-host Stop may retry only the exact children retained by
/// already-closed owners. LAN Stop still uses its stamped retirement path;
/// this command never accepts a remote grant or an arbitrary native target.
#[tauri::command]
pub(crate) async fn remote_owner_thread_stop_retry(
    app: AppHandle,
    state: State<'_, RemoteState>,
    window: WebviewWindow,
    thread_id: String,
) -> Result<Value, String> {
    hostbridge::window_is_host(&window).map_err(|_| stale())?;
    if thread_id.trim().is_empty() || thread_id.len() > 256 { return Err(stale()); }
    let snapshots = {
        let core = state.inner.lock();
        let mut snapshots = Vec::new();
        for (handle, owner) in core.owners.owners.iter().filter(|(_, owner)| owns_thread(owner, &thread_id)) {
            if !owner.closed || !owner.pending.is_empty() {
                return Ok(json!({"settled":false,"owners":1}));
            }
            snapshots.extend(owner.children.iter().map(|(id, child)| (handle.clone(), id.clone(), child.clone())));
        }
        snapshots
    };
    tokio::time::timeout(Duration::from_secs(15), async {
        for (handle, id, child) in snapshots {
            {
                let core = state.inner.lock();
                let Some(owner) = core.owners.owners.get(&handle) else { continue; };
                if !owner.closed || !owner.pending.is_empty()
                    || owner.children.get(&id).is_none_or(|current| !same_child(&child, current)) {
                    return Err(stale());
                }
            }
            match child {
                Child::Native(mut target) => {
                    if !crate::remote_owned_child_ended(&app, &mut target).await.unwrap_or(false) {
                        crate::remote_owned_child_retry_stop(&app, &target).await?;
                    }
                }
                Child::Terminal(route) => super::terminal::retire_exact(route).await?,
                Child::Command(command) => retire_command(&app, &command).await?,
            }
        }
        Ok::<(), String>(())
    }).await.map_err(|_| "The retained native work has not confirmed its cutoff yet. Retry Stop after it settles.".to_owned())??;
    // The normal evidence probe owns finalization. It will also detect any
    // new owner admitted while this exact-child retry awaited native cutoff.
    let remaining = state.inner.lock().owners.owners.values().filter(|owner| owns_thread(owner, &thread_id)).count();
    Ok(json!({"settled":remaining == 0,"owners":remaining}))
}

/// Recover native tracking after an unconfirmed Stop, including lost renderer
/// handles. Only when every exact child ended and no admission is pending do we
/// close admission and release the owners. Never kills work or changes grants.
#[tauri::command]
pub(crate) async fn remote_owner_thread_settled(
    app: AppHandle,
    state: State<'_, RemoteState>,
    window: WebviewWindow,
    thread_id: String,
) -> Result<Value, String> {
    hostbridge::window_is_host(&window).map_err(|_| stale())?;
    if thread_id.trim().is_empty() || thread_id.len() > 256 {
        return Err(stale());
    }
    let snapshots = {
        let core = state.inner.lock();
        let mut snapshots = Vec::new();
        for (handle, owner) in core.owners.owners.iter().filter(|(_, owner)| owns_thread(owner, &thread_id)) {
            if !owner.pending.is_empty() {
                return Ok(json!({"settled":false,"owners":snapshots.len() + 1}));
            }
            snapshots.push((handle.clone(), owner.children.clone()));
        }
        snapshots
    };
    for child in snapshots.iter().flat_map(|(_, children)| children.values()) {
        let ended = match child {
            Child::Terminal(route) => super::terminal::is_finished(route),
            Child::Command(command) => command.finished.load(std::sync::atomic::Ordering::Acquire),
            // Unproven native state is not an ending.
            Child::Native(target) => {
                let mut target = target.clone();
                crate::remote_owned_child_ended(&app, &mut target).await.unwrap_or(false)
            }
        };
        if !ended {
            return Ok(json!({"settled":false,"owners":snapshots.len()}));
        }
    }
    let roots = {
        let mut core = state.inner.lock();
        // Native work may have been admitted while provider reads awaited.
        // Compare the complete thread scope, not just the initial child count.
        let current = core.owners.owners.iter().filter(|(_, owner)| owns_thread(owner, &thread_id)).collect::<Vec<_>>();
        if current.len() != snapshots.len() || current.iter().any(|(handle, owner)| {
            !owner.pending.is_empty() || snapshots.iter().find(|(old, _)| old.as_str() == handle.as_str()).is_none_or(|(_, children)| {
                children.len() != owner.children.len() || children.iter().any(|(id, child)| {
                    owner.children.get(id).is_none_or(|current| !same_child(child, current))
                })
            })
        }) {
            return Ok(json!({"settled":false,"owners":current.len()}));
        }
        let roots = current.iter().filter(|(_, owner)| !owner.local).map(|(_, owner)| owner.stamp.clone()).collect::<Vec<_>>();
        drop(current);
        for (handle, _) in &snapshots {
            let owner = core.owners.owners.get_mut(handle).ok_or_else(stale)?;
            owner.closed = true;
            owner.signal.notify_waiters();
            super::prompt_preparation::retire_owner(&mut core, handle);
        }
        roots
    };
    if !roots.is_empty() {
        super::finish_write(state.inner.enqueue_write(false, move |db| {
            let tx = db.transaction().map_err(|_| stale())?;
            for root in roots {
                super::store::reject_unused_engine_steps(&tx, &root.device, &root.op_id)?;
            }
            tx.commit().map_err(|_| stale())
        })).await?;
    }
    let mut core = state.inner.lock();
    for (handle, children) in &snapshots {
        if let Some(owner) = core.owners.owners.get(handle) {
            if !owner.closed || !owner.pending.is_empty() || owner.children.len() != children.len()
                || children.iter().any(|(id, child)| owner.children.get(id).is_none_or(|current| !same_child(child, current))) {
                return Ok(json!({"settled":false,"owners":snapshots.len()}));
            }
        }
    }
    for (handle, _) in &snapshots {
        core.owners.owners.remove(handle);
    }
    // A different owner may have opened during the durable receipt cleanup.
    let remaining = core.owners.owners.values().filter(|owner| owns_thread(owner, &thread_id)).count();
    Ok(json!({"settled":remaining == 0,"owners":remaining}))
}

/// Normal engine completion closes admission and releases retained native child
/// references only after the real native owners have ended. It never kills work.
#[tauri::command]
pub(crate) async fn remote_work_owner_finish(
    app: AppHandle,
    state: State<'_, RemoteState>,
    window: WebviewWindow,
    generation: u64,
    owner_handle: String,
) -> Result<Value, String> {
    hostbridge::window_is_host(&window).map_err(|_| stale())?;
    finish_owner(&app, &state, generation, owner_handle).await
}
async fn finish_owner(
    app: &AppHandle,
    state: &RemoteState,
    generation: u64,
    owner_handle: String,
) -> Result<Value, String> {
    let children = {
        let mut core = state.inner.lock();
        let local = core
            .owners
            .owners
            .get(&owner_handle)
            .is_some_and(|o| o.local);
        if !local {
            hostbridge::check_generation(&core, generation).map_err(|_| stale())?;
        }
        let owner = core
            .owners
            .owners
            .get_mut(&owner_handle)
            .filter(|owner| owner.local || owner.stamp.generation == generation)
            .ok_or_else(stale)?;
        owner.closed = true;
        owner.signal.notify_waiters();
        let pending=!owner.pending.is_empty();
        let children=owner.children.values().cloned().collect::<Vec<_>>();
        super::prompt_preparation::retire_owner(&mut core,&owner_handle);
        if pending { return Ok(json!({"confirmed":false})); }
        children
    };
    for child in &children {
        let ended = match child {
            Child::Terminal(route) => super::terminal::is_finished(route),
            Child::Command(command) => command.finished.load(std::sync::atomic::Ordering::Acquire),
            Child::Native(target) => {
                let mut target = target.clone();
                crate::remote_owned_child_ended(&app, &mut target).await?
            }
        };
        if !ended {
            return Ok(json!({"confirmed":false}));
        }
    }
    let root = {
        let core = state.inner.lock();
        let owner = core.owners.owners.get(&owner_handle).ok_or_else(stale)?;
        if !owner.pending.is_empty() || owner.children.len() != children.len() {
            return Ok(json!({"confirmed":false}));
        }
        (!owner.local).then(|| owner.stamp.clone())
    };
    if let Some(stamp) = root {
        super::finish_write(state.inner.enqueue_write(false, move |db| {
            super::store::reject_unused_engine_steps(db, &stamp.device, &stamp.op_id)
        }))
        .await?;
    }
    state.inner.lock().owners.owners.remove(&owner_handle);
    Ok(json!({"confirmed":true}))
}

/// Tracking only: no device grant, journal claim, permission ceiling, billing,
/// process arguments or policy of a local start is changed by this permit.
pub(crate) struct LocalPermit {
    inner: Arc<super::Inner>,
    handle: String,
    ticket: String,
}
impl Drop for LocalPermit {
    fn drop(&mut self) {
        let mut core = self.inner.lock();
        if let Some(owner) = core.owners.owners.get_mut(&self.handle) {
            owner.pending.remove(&self.ticket);
            owner.signal.notify_waiters();
        }
    }
}
impl LocalPermit {
    pub(crate) fn prepare(app: &AppHandle, handle: Option<String>) -> Result<Option<Self>, String> {
        use tauri::Manager;
        let Some(handle) = handle else {
            return Ok(None);
        };
        let state = app.state::<RemoteState>();
        let mut core = state.inner.lock();
        let owner = core
            .owners
            .owners
            .get_mut(&handle)
            .filter(|o| o.local && !o.closed)
            .ok_or_else(stale)?;
        if owner.children.len() + owner.pending.len() * 2 + 2 > 512 {
            return Err(work::refused("busy"));
        }
        let ticket = uuid::Uuid::new_v4().to_string();
        owner.pending.insert(ticket.clone());
        Ok(Some(Self {
            inner: state.inner.clone(),
            handle,
            ticket,
        }))
    }
    fn check(core: &Core, handle: &str) -> Result<(), String> {
        if core
            .owners
            .owners
            .get(handle)
            .is_some_and(|o| o.local && !o.closed)
        {
            Ok(())
        } else {
            Err(stale())
        }
    }
    pub(crate) fn spawn<T>(&self, spawn: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
        let core = self.inner.lock();
        Self::check(&core, &self.handle)?;
        spawn()
    }
    pub(crate) async fn write<T>(
        &self,
        future: impl std::future::Future<Output = Result<T, String>>,
    ) -> Result<T, String> {
        tokio::pin!(future);
        let mut begun = false;
        std::future::poll_fn(|cx| {
            if begun {
                return future.as_mut().poll(cx);
            }
            let core = self.inner.lock();
            if let Err(error) = Self::check(&core, &self.handle) {
                return std::task::Poll::Ready(Err(error));
            }
            begun = true;
            future.as_mut().poll(cx)
        })
        .await
    }
    pub(crate) fn track_start(
        &self,
        provider: &str,
        thread: &str,
        turn: &str,
        start: Option<&str>,
    ) -> Result<(), String> {
        let mut core = self.inner.lock();
        Self::check(&core, &self.handle)?;
        let owner = core.owners.owners.get_mut(&self.handle).ok_or_else(stale)?;
        let target = local_target(
            owner,
            provider,
            thread,
            turn,
            "start",
            format!("{provider}-start:{turn}:{}", start.unwrap_or("")),
            start,
        );
        owner.children.insert(key(&target), Child::Native(target));
        owner.signal.notify_waiters();
        Ok(())
    }
    pub(crate) fn accepted(
        &self,
        provider: &str,
        thread: &str,
        turn: &str,
        instance: Option<&str>,
        start: Option<&str>,
    ) -> Result<(), String> {
        let mut core = self.inner.lock();
        let Some(owner) = core.owners.owners.get_mut(&self.handle) else {
            return Err(stale());
        };
        if owner.thread.is_none() {
            owner.thread = Some(thread.into());
        }
        let identity = if let Some(instance) = instance {
            format!("codex:{instance}")
        } else {
            format!("{provider}:{turn}")
        };
        let target = local_target(owner, provider, thread, turn, "turn", identity, start);
        owner.children.insert(key(&target), Child::Native(target));
        owner.signal.notify_waiters();
        Ok(())
    }
}
fn local_target(
    owner: &Owner,
    provider: &str,
    thread: &str,
    turn: &str,
    kind: &str,
    identity: String,
    start: Option<&str>,
) -> Target {
    Target {
        owner_handle: None,
        generation: 0,
        device: String::new(),
        kind: kind.into(),
        thread_id: Some(thread.into()),
        workspace_id: owner.stamp.workspace_id.clone(),
        provider: Some(provider.into()),
        request_id: None,
        method: None,
        turn_id: Some(turn.into()),
        item_id: None,
        start_request_id: start.map(str::to_owned),
        agent_run_id: None,
        attempt_id: None,
        parent_run_id: None,
        revision: 0,
        owner: identity,
        expires: None,
        claimed: None,
    }
}
#[tauri::command]
pub(crate) fn remote_local_owner_open(
    state: State<'_, RemoteState>,
    window: WebviewWindow,
    workspace_id: String,
    thread_id: Option<String>,
    kind: String,
    run_id: String,
) -> Result<Value, String> {
    hostbridge::window_is_host(&window).map_err(|_| stale())?;
    if workspace_id.is_empty()
        || workspace_id.len() > 512
        || run_id.is_empty()
        || run_id.len() > 256
        || !matches!(kind.as_str(), "parent" | "workflow" | "start")
    {
        return Err(stale());
    }
    let mut core = state.inner.lock();
    if let Some((handle, owner)) = core
        .owners
        .owners
        .iter()
        .find(|(_, o)| o.local && o.kind == kind && o.run == run_id)
    {
        return if !owner.closed {
            Ok(json!({"ownerHandle":handle}))
        } else {
            Err(stale())
        };
    }
    if core.owners.owners.len() >= 256 {
        return Err(work::refused("busy"));
    }
    let handle = uuid::Uuid::new_v4().to_string();
    core.owners.owners.insert(
        handle.clone(),
        Owner {
            local: true,
            prepared_threads: HashSet::new(),
            stamp: Stamp {
                generation: 0,
                device: String::new(),
                grant_revision: 0,
                op_id: String::new(),
                op_seq: 0,
                workspace_id: Some(workspace_id),
                thread_id: thread_id.clone(),
            },
            kind,
            thread: thread_id,
            run: run_id,
            closed: false,
            pending: HashSet::new(),
            children: HashMap::new(),
            signal: Arc::new(Notify::new()),
        },
    );
    Ok(json!({"ownerHandle":handle}))
}
#[tauri::command]
pub(crate) async fn remote_local_owner_finish(
    app: AppHandle,
    state: State<'_, RemoteState>,
    window: WebviewWindow,
    owner_handle: String,
) -> Result<Value, String> {
    hostbridge::window_is_host(&window).map_err(|_| stale())?;
    let is_local = state
        .inner
        .lock()
        .owners
        .owners
        .get(&owner_handle)
        .is_some_and(|o| o.local);
    if !is_local {
        return Err(stale());
    }
    finish_owner(&app, &state, 0, owner_handle).await
}

/// Only called with actual native thread/start or thread/resume result, never a
/// viewer ID. This proof survives only for the in-memory lifetime of its owner.
pub(super) fn prepared_thread(
    core: &mut Core,
    meta: &RemoteDelivery,
    thread: &str,
) -> Result<(), String> {
    if let Some(handle) = meta.owner_handle.as_ref() {
        let owner = core.owners.owners.get_mut(handle).ok_or_else(stale)?;
        if owner.prepared_threads.len() >= 256 {
            return Err(work::refused("busy"));
        }
        owner.prepared_threads.insert(thread.to_owned());
    }
    Ok(())
}
#[tauri::command]
pub(crate) fn remote_work_owner_bind(
    state: State<'_, RemoteState>,
    window: WebviewWindow,
    generation: u64,
    owner_handle: String,
    thread_id: String,
) -> Result<Value, String> {
    hostbridge::window_is_host(&window).map_err(|_| stale())?;
    let mut core = state.inner.lock();
    hostbridge::check_generation(&core, generation).map_err(|_| stale())?;
    let owner = core.owners.owners.get(&owner_handle).ok_or_else(stale)?;
    if owner.local || owner.closed || owner.stamp.generation != generation {
        return Err(stale());
    }
    owner.stamp.check(&core, "prompt.send")?;
    let owner = core
        .owners
        .owners
        .get_mut(&owner_handle)
        .ok_or_else(stale)?;
    if owner.thread.as_ref().is_some_and(|old| old != &thread_id)
        || !owner.prepared_threads.contains(&thread_id)
    {
        return Err(stale());
    }
    owner.thread = Some(thread_id);
    Ok(json!({"bound":true}))
}
#[tauri::command]
pub(crate) async fn remote_work_engine_step(
    state: State<'_, RemoteState>,
    window: WebviewWindow,
    generation: u64,
    owner_handle: String,
    step_id: String,
    kind: String,
    thread_id: Option<String>,
    provider: String,
    permission: String,
    target_handle: Option<String>,
) -> Result<Value, String> {
    hostbridge::window_is_host(&window).map_err(|_| stale())?;
    if step_id.is_empty()
        || step_id.len() > 256
        || step_id.chars().any(char::is_control)
        || !matches!(kind.as_str(), "prompt" | "command")
        || !matches!(
            provider.as_str(),
            "openai" | "openrouter" | "lmstudio" | "claude" | "cursor"
        )
        || !matches!(permission.as_str(), "read-only" | "ask" | "full")
        || kind == "command" && !matches!(provider.as_str(), "openai" | "openrouter" | "lmstudio")
    {
        return Err(stale());
    }
    let inner = state.inner.clone();
    super::finish_write(state.inner.enqueue_write(false, move |db| {
        let tx = db.transaction().map_err(|_| stale())?;
        let mut core = inner.lock();
        hostbridge::check_generation(&core, generation).map_err(|_| stale())?;
        let owner = core
            .owners
            .owners
            .get(&owner_handle)
            .filter(|o| !o.local && !o.closed && o.stamp.generation == generation)
            .ok_or_else(stale)?;
        let op = commit::operation(&tx, &owner.stamp)?;
        owner.stamp.check(&core, &op)?;
        let grant = work::authorize(
            &core,
            &owner.stamp.meta(),
            owner.stamp.workspace_id.as_deref(),
        )
        .map_err(|_| work::refused("forbidden"))?;
        if kind == "command" && !grant.capabilities.terminal
            || permission == "full" && !grant.capabilities.full_access
        {
            return Err(work::refused("forbidden"));
        }
        if let Some(thread) = thread_id.as_deref() {
            if owner.thread.as_deref() != Some(thread) && !owner.prepared_threads.contains(thread) {
                return Err(stale());
            }
        }
        let root = super::store::delivery_receipt(
            &tx,
            &owner.stamp.device,
            &owner.stamp.op_id,
            owner.stamp.op_seq,
        )?
        .ok_or_else(stale)?;
        if op=="agents.replace"&&!root["agentCutoffConfirmed"].is_string(){return Err(stale());}
        if let Some(handle)=target_handle.as_deref(){if kind!="prompt"||op!="agents.replace"{return Err(stale());}let target=work::target_locked(&core,&owner.stamp.meta(),handle)?;if target.kind!="turn"||target.thread_id!=owner.thread||target.thread_id!=thread_id||target.workspace_id!=owner.stamp.workspace_id||target.provider.as_deref()!=Some(provider.as_str()){return Err(stale());}}

        let ceiling = root
            .get("permissionCeiling")
            .or_else(|| root.get("permission"))
            .and_then(Value::as_str)
            .unwrap_or("ask");
        let strength = |p: &str| match p {
            "read-only" => 0,
            "ask" => 1,
            "full" => 2,
            _ => 3,
        };
        if strength(&permission) > strength(ceiling) {
            return Err(work::refused("forbidden"));
        }
        let root_id = owner.stamp.op_id.clone();
        let device = owner.stamp.device.clone();
        let workspace = owner.stamp.workspace_id.clone();
        let revision = grant.revision;
        let result = engine_step_record(
            &tx,
            &device,
            &root_id,
            &owner_handle,
            &step_id,
            &kind,
            thread_id.as_deref(),
            &provider,
            &permission,
            &workspace,
            generation,
            revision,
            target_handle.as_deref(),
        )?;
        let id = result["delivery"]["opId"]
            .as_str()
            .ok_or_else(stale)?
            .to_owned();
        if core.owners.bindings.len() >= 4096
            && !core
                .owners
                .bindings
                .contains_key(&(device.clone(), id.clone()))
        {
            return Err(work::refused("busy"));
        }
        tx.commit().map_err(|_| stale())?;
        core.owners.bindings.insert((device, id), owner_handle);
        Ok(result)
    }))
    .await
}

fn engine_step_record(
    db: &rusqlite::Connection,
    device: &str,
    root: &str,
    owner: &str,
    step: &str,
    kind: &str,
    thread: Option<&str>,
    provider: &str,
    permission: &str,
    workspace: &Option<String>,
    generation: u64,
    revision: u64,
    target:Option<&str>,
) -> Result<Value, String> {
    use rusqlite::{params, OptionalExtension};
    let digest = super::store::request_digest(
        "engine.step",
        &json!({"owner":owner,"step":step,"kind":kind,"thread":thread,"provider":provider,"permission":permission,"target":target}),
    );
    let old:Option<(String,String,String)>=db.query_row("SELECT op_id,request_digest,delivery_json FROM remote_op_journal WHERE device_fingerprint=?1 AND engine_root=?2 AND engine_step=?3",params![device,root,step],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional().map_err(|_|stale())?;
    if target.is_some(){let op:String=db.query_row("SELECT op FROM remote_op_journal WHERE device_fingerprint=?1 AND op_id=?2",params![device,root],|r|r.get(0)).map_err(|_|stale())?;let proof=super::store::delivery_receipt(db,device,root,db.query_row("SELECT op_seq FROM remote_op_journal WHERE device_fingerprint=?1 AND op_id=?2",params![device,root],|r|r.get::<_,u64>(0)).map_err(|_|stale())?)?.ok_or_else(stale)?;if op!="agents.replace"||kind!="prompt"||!proof["agentCutoffConfirmed"].is_string()||proof["threadId"].as_str()!=thread{return Err(stale());}}
    let (id, receipt) = if let Some((id, previous, source)) = old {
        if previous != digest {
            return Err(stale());
        }
        let receipt: Value = serde_json::from_str(&source).map_err(|_| stale())?;
        (id, receipt)
    } else {
        let count:i64=db.query_row("SELECT COUNT(*) FROM remote_op_journal WHERE device_fingerprint=?1 AND engine_root=?2",params![device,root],|r|r.get(0)).map_err(|_|stale())?;
        if count >= 256 {
            return Err(work::refused("busy"));
        }
        let id = format!("engine:{}", uuid::Uuid::new_v4());
        let now = crate::unix_timestamp_ms();
        // Internal child sequences are fixed at 1 in their own reserved ID
        // namespace, never claim/increment/evict a viewer's monotonic sequence.
        let mut receipt = json!({"generation":generation,"device":device,"opId":id,"opSeq":1,"op":if kind=="prompt"{"engine.prompt"}else{"engine.command"},"engineKind":kind,"engineSteer":target.is_some(),"steerTarget":target,"ownerHandle":owner,"threadId":thread,"workspaceId":workspace,"provider":provider,"permission":permission,"permissionCeiling":permission,"grantRevision":revision,"attemptId":uuid::Uuid::new_v4().to_string(),"messageId":uuid::Uuid::new_v4().to_string(),"disposition":"preparing"});
        if let Some(text)=db.query_row("SELECT delivery_json FROM remote_op_journal WHERE device_fingerprint=?1 AND op_id=?2",params![device,root],|r|r.get::<_,Option<String>>(0)).map_err(|_|stale())?{let root_receipt:Value=serde_json::from_str(&text).map_err(|_|stale())?;if let Some(proof)=root_receipt.get("agentCutoffProof"){receipt["engineCutoffProof"]=proof.clone();}}
        db.execute("INSERT INTO remote_op_journal(device_fingerprint,op_id,op_seq,op,request_digest,state,created_at,updated_at,engine_root,engine_step,delivery_json)VALUES(?1,?2,1,?3,?4,'pending',?5,?5,?6,?7,?8)",params![device,id,receipt["op"].as_str(),digest,now,root,step,receipt.to_string()]).map_err(|_|stale())?;
        (id, receipt)
    };
    Ok(
        json!({"delivery":{"generation":generation,"device":device,"opId":id,"opSeq":1,"ownerHandle":owner,"attemptId":receipt["attemptId"],"messageId":receipt["messageId"]},"state":receipt.get("disposition").and_then(Value::as_str).unwrap_or("uncertain")}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn engine_steps_are_distinct_durable_and_do_not_touch_viewer_sequence() {
        let mut db = rusqlite::Connection::open_in_memory().unwrap();
        super::super::store::init(&db).unwrap();
        super::super::store::claim_operation(
            &mut db,
            "device",
            "root",
            41,
            "workflows.start",
            "root-digest",
        )
        .unwrap();
        let record = |db: &rusqlite::Connection, step: &str, permission: &str| {
            engine_step_record(
                db,
                "device",
                "root",
                "owner",
                step,
                "prompt",
                Some("thread"),
                "claude",
                permission,
                &Some("workspace".into()),
                7,
                1,
                None,
            )
            .unwrap()
        };
        let first = record(&db, "step-1", "ask");
        assert_eq!(
            super::super::store::highest_op_seq(&db, "device").unwrap(),
            41
        );
        assert_eq!(first, record(&db, "step-1", "ask"));
        let second = record(&db, "step-2", "ask");
        assert_ne!(first["delivery"]["opId"], second["delivery"]["opId"]);
        assert!(engine_step_record(
            &db,
            "device",
            "root",
            "owner",
            "step-1",
            "prompt",
            Some("thread"),
            "claude",
            "full",
            &Some("workspace".into()),
            7,
            1,
            None
        )
        .is_err());
        let id = first["delivery"]["opId"].as_str().unwrap();
        let receipt = json!({"disposition":"dispatched"});
        super::super::store::save_delivery_receipt(&mut db, "device", id, 1, &receipt).unwrap();
        super::super::store::claim_native_step(&mut db, "device", id, 1, "claude_prompt").unwrap();
        assert!(
            super::super::store::claim_native_step(&mut db, "device", id, 1, "claude_prompt")
                .is_err()
        );
        assert!(matches!(
            super::super::store::claim_operation(&mut db, "device", id, 42, "prompt.send", "evil")
                .unwrap(),
            super::super::store::JournalClaim::DigestMismatch
        ));
        assert_eq!(
            super::super::store::op_status(&db, "device", id, Some(1))
                .unwrap()
                .state,
            "expired"
        );
        assert_eq!(record(&db, "step-1", "ask")["state"], "dispatched");
        super::super::store::reject_unused_engine_steps(&db, "device", "root").unwrap();
        assert_eq!(record(&db, "step-1", "ask")["state"], "dispatched");
        assert_eq!(record(&db, "step-2", "ask")["state"], "rejected");
        assert!(matches!(
            super::super::store::claim_operation(
                &mut db,
                "device",
                "next-viewer-op",
                42,
                "prompt.send",
                "digest"
            )
            .unwrap(),
            super::super::store::JournalClaim::Claimed
        ));
    }
    fn local_fixture() -> (Arc<super::super::Inner>, String) {
        let inner = RemoteState::default().inner;
        let handle = "local-owner".to_string();
        let stamp = Stamp {
            generation: 0,
            device: String::new(),
            grant_revision: 0,
            op_id: String::new(),
            op_seq: 0,
            workspace_id: Some("workspace".into()),
            thread_id: Some("thread".into()),
        };
        inner.lock().owners.owners.insert(
            handle.clone(),
            Owner {
                local: true,
                stamp,
                kind: "workflow".into(),
                prepared_threads: HashSet::new(),
                thread: Some("thread".into()),
                run: "run".into(),
                closed: false,
                pending: HashSet::new(),
                children: HashMap::new(),
                signal: Arc::new(Notify::new()),
            },
        );
        (inner, handle)
    }
    #[tokio::test]
    async fn local_tracking_needs_no_host_or_grant_and_retirement_fences_future_dispatch() {
        let (inner, handle) = local_fixture();
        let permit = LocalPermit {
            inner: inner.clone(),
            handle: handle.clone(),
            ticket: "ticket".into(),
        };
        inner
            .lock()
            .owners
            .owners
            .get_mut(&handle)
            .unwrap()
            .pending
            .insert("ticket".into());
        assert_eq!(permit.spawn(|| Ok(7)).unwrap(), 7);
        assert_eq!(permit.write(async { Ok(8) }).await.unwrap(), 8);
        permit
            .track_start("claude", "thread", "turn", Some("start"))
            .unwrap();
        {
            let mut core = inner.lock();
            invalidate(&mut core);
            assert!(is_open(&core, &handle));
            retire_device(&mut core, "viewer");
            assert!(is_open(&core, &handle));
            core.owners.owners.get_mut(&handle).unwrap().closed = true;
        }
        let executed = std::sync::atomic::AtomicBool::new(false);
        assert!(permit
            .spawn(|| {
                executed.store(true, std::sync::atomic::Ordering::Release);
                Ok(())
            })
            .is_err());
        assert!(permit
            .write(async {
                executed.store(true, std::sync::atomic::Ordering::Release);
                Ok(())
            })
            .await
            .is_err());
        assert!(!executed.load(std::sync::atomic::Ordering::Acquire));
        // An acknowledgement racing Stop is still recorded before pending drains.
        permit
            .accepted("claude", "thread", "turn", None, Some("start"))
            .unwrap();
        drop(permit);
        assert!(inner.lock().owners.owners[&handle].pending.is_empty());
        assert_eq!(inner.lock().owners.owners[&handle].children.len(), 2);
    }
    #[tokio::test]
    async fn retirement_does_not_truncate_an_already_started_local_pipe_write() {
        let (inner, handle) = local_fixture();
        let permit = LocalPermit {
            inner: inner.clone(),
            handle: handle.clone(),
            ticket: "ticket".into(),
        };
        let (started, ready) = tokio::sync::oneshot::channel();
        let (resume, paused) = tokio::sync::oneshot::channel();
        let writer = tokio::spawn(async move {
            permit
                .write(async move {
                    started.send(()).unwrap();
                    paused.await.unwrap();
                    Ok(())
                })
                .await
        });
        ready.await.unwrap();
        inner.lock().owners.owners.get_mut(&handle).unwrap().closed = true;
        resume.send(()).unwrap();
        assert!(writer.await.unwrap().is_ok(),"once a JSON line starts, finish it under the provider input lock; Stop retires its exact native child instead");
    }
}

/// Native command owner proof. Every command/exec with a process ID is observed,
/// including untagged local calls, so a colliding local ID invalidates ownership
/// without changing whether that local request is dispatched.
pub(crate) struct EngineCommand {
    app: Option<AppHandle>,
    pub(crate) instance: String,
    pub(crate) process: String,
    request: i64,
    pub(crate) started: std::sync::atomic::AtomicBool,
    finished: std::sync::atomic::AtomicBool,
    ambiguous: std::sync::atomic::AtomicBool,
    signal: Notify,
}
pub(crate) fn observe_command(
    app: &AppHandle,
    instance: &str,
    request: i64,
    process: Option<&str>,
    owner: Option<&str>,
) -> Result<Option<Arc<EngineCommand>>, String> {
    use std::sync::atomic::Ordering;
    use tauri::Manager;
    let Some(process) = process else {
        return if owner.is_some() {
            Err(stale())
        } else {
            Ok(None)
        };
    };
    if process.is_empty() || process.len() > 512 || process.chars().any(char::is_control) {
        return if owner.is_some() {
            Err(stale())
        } else {
            Ok(None)
        };
    }
    let state = app.state::<RemoteState>();
    let mut core = state.inner.lock();
    if let Some(handle) = owner {
        if !core
            .owners
            .owners
            .get(handle)
            .is_some_and(|o| !o.closed && o.children.len() < 512)
        {
            return Err(stale());
        }
    }
    core.owners
        .commands
        .retain(|(actual, _), _| actual == instance);
    let entries = core
        .owners
        .commands
        .entry((instance.into(), process.into()))
        .or_default();
    entries.retain(|_, c| !c.finished.load(Ordering::Acquire));
    if owner.is_some() && !entries.is_empty() {
        return Err(stale());
    }
    for c in entries.values() {
        c.ambiguous.store(true, Ordering::Release);
        c.signal.notify_waiters();
    }
    let command = Arc::new(EngineCommand {
        app: Some(app.clone()),
        instance: instance.into(),
        process: process.into(),
        request,
        started: std::sync::atomic::AtomicBool::new(false),
        finished: std::sync::atomic::AtomicBool::new(false),
        ambiguous: std::sync::atomic::AtomicBool::new(!entries.is_empty()),
        signal: Notify::new(),
    });
    entries.insert(request, command.clone());
    if let Some(handle) = owner {
        let o = core.owners.owners.get_mut(handle).ok_or_else(stale)?;
        o.children.insert(
            format!("command:{instance}:{request}"),
            Child::Command(command.clone()),
        );
        o.signal.notify_waiters();
    }
    Ok(Some(command))
}
pub(crate) fn command_finished(app: &AppHandle, command: &EngineCommand, replied: bool) {
    use std::sync::atomic::Ordering;
    use tauri::Manager;
    if replied || !command.started.load(Ordering::Acquire) {
        command.finished.store(true, Ordering::Release);
        command.signal.notify_waiters();
        let state = app.state::<RemoteState>();
        let mut core = state.inner.lock();
        let key = (command.instance.clone(), command.process.clone());
        if let Some(entries) = core.owners.commands.get_mut(&key) {
            entries.remove(&command.request);
            if entries.is_empty() {
                core.owners.commands.remove(&key);
            }
        }
    }
}
pub(crate) fn command_stop_write<T>(
    app: &AppHandle,
    command: &EngineCommand,
    write: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    use tauri::Manager;
    let state = app.state::<RemoteState>();
    let core = state.inner.lock();
    if !command_owned(&core, command) {
        return Err(stale());
    }
    write()
}
async fn retire_command(app: &AppHandle, command: &Arc<EngineCommand>) -> Result<(), String> {
    use std::sync::atomic::Ordering;
    use tauri::Manager;
    if command.finished.load(Ordering::Acquire) || !command.started.load(Ordering::Acquire) {
        return Ok(());
    }
    if command.ambiguous.load(Ordering::Acquire) {
        return Err(stale());
    }
    let state = app.state::<crate::RuntimeState>();
    let server = state
        .server
        .lock()
        .await
        .as_ref()
        .filter(|s| s.instance == command.instance && s.is_alive())
        .cloned()
        .ok_or_else(stale)?;
    server.request_command_stop(command.clone()).await?;
    loop {
        let changed = command.signal.notified();
        tokio::pin!(changed);
        changed.as_mut().enable();
        if command.finished.load(Ordering::Acquire) {
            return Ok(());
        }
        if command.ambiguous.load(Ordering::Acquire) {
            return Err(stale());
        }
        changed.await;
    }
}

fn cancel_owned_commands(owner: &Owner) {
    use tauri::Emitter;
    for child in owner.children.values() {
        if let Child::Command(command) = child {
            if let Some(app) = command.app.clone() {
                let command = command.clone();
                let device = owner.stamp.device.clone();
                tauri::async_runtime::spawn(async move {
                    if !matches!(
                        tokio::time::timeout(
                            Duration::from_secs(12),
                            retire_command(&app, &command)
                        )
                        .await,
                        Ok(Ok(()))
                    ) {
                        let _=app.emit("remote-runtime-warning",json!({"device":device,"message":"A remote workflow command may still be running. Open this workflow on this device and stop it before continuing."}));
                    }
                });
            }
        }
    }
}

fn command_owned(core: &Core, command: &EngineCommand) -> bool {
    use std::sync::atomic::Ordering;
    !command.finished.load(Ordering::Acquire)
        && !command.ambiguous.load(Ordering::Acquire)
        && core
            .owners
            .commands
            .get(&(command.instance.clone(), command.process.clone()))
            .is_some_and(|entries| {
                entries.len() == 1
                    && entries
                        .get(&command.request)
                        .is_some_and(|actual| std::ptr::eq(actual.as_ref(), command))
            })
}
#[cfg(test)]
mod command_tests {
    use super::*;
    #[test]
    fn command_cutoff_requires_exact_native_request_and_collision_never_proves_stop() {
        let mut core = Core::default();
        let command = Arc::new(EngineCommand {
            app: None,
            instance: "instance".into(),
            process: "workflow-run-step".into(),
            request: 1,
            started: std::sync::atomic::AtomicBool::new(true),
            finished: std::sync::atomic::AtomicBool::new(false),
            ambiguous: std::sync::atomic::AtomicBool::new(false),
            signal: Notify::new(),
        });
        let key = (command.instance.clone(), command.process.clone());
        core.owners
            .commands
            .entry(key.clone())
            .or_default()
            .insert(1, command.clone());
        assert!(command_owned(&core, &command));
        core.owners
            .commands
            .get_mut(&key)
            .unwrap()
            .insert(2, command.clone());
        assert!(!command_owned(&core, &command));
        core.owners.commands.get_mut(&key).unwrap().remove(&2);
        assert!(command_owned(&core, &command));
        assert_eq!(command_state(&command),"running");command.started.store(false,std::sync::atomic::Ordering::Release);assert_eq!(command_state(&command),"starting");command.started.store(true,std::sync::atomic::Ordering::Release);assert_eq!(command_state(&command),"running");
        command
            .ambiguous
            .store(true, std::sync::atomic::Ordering::Release);
        assert!(!command_owned(&core, &command));
        assert_eq!(command_state(&command),"uncertain");
        command
            .ambiguous
            .store(false, std::sync::atomic::Ordering::Release);
        command
            .finished
            .store(true, std::sync::atomic::Ordering::Release);
        assert!(!command_owned(&core, &command));assert_eq!(command_state(&command),"completed");
    }
}

pub(super) fn thread_busy(core:&Core,thread:&str)->bool{core.owners.owners.values().any(|o|owns_thread(o,thread)&&(!o.closed||!o.pending.is_empty()||!o.children.is_empty()))}

/// Empty schedule preparation is not a running engine. Validate before SQL,
/// retire after its queued transaction commits while holding the same Core lock.
pub(super) fn validate_schedule_preparation(core:&Core,db:&rusqlite::Connection,stamp:&Stamp,thread:&str)->Result<String,String>{
 let receipt=super::store::delivery_receipt(db,&stamp.device,&stamp.op_id,stamp.op_seq)?.ok_or_else(stale)?;
 let handle=receipt.get("engineOwnerHandle").or_else(||receipt.get("ownerHandle")).and_then(Value::as_str).ok_or_else(stale)?;
 let owner=core.owners.owners.get(handle).filter(|o|!o.local&&!o.closed&&o.kind=="start"&&o.stamp.device==stamp.device&&o.stamp.op_id==stamp.op_id&&o.stamp.generation==stamp.generation&&o.stamp.workspace_id==stamp.workspace_id).ok_or_else(stale)?;
 if !owner.pending.is_empty()||!owner.children.is_empty()||receipt["queueAuthorized"]!=true||receipt.get("nativeSteps").and_then(Value::as_array).is_some_and(|a|a.iter().any(|s|!matches!(s.as_str(),Some("thread/start"|"thread/resume")))){return Err(stale());}
 if !owner.prepared_threads.contains(thread){
  use rusqlite::OptionalExtension;
  let value:Option<String>=db.query_row("SELECT thread_json FROM local_transcript_meta WHERE provider IN ('claude','cursor') AND thread_id=?1",[thread],|r|r.get(0)).optional().map_err(|_|stale())?;
  let value:Value=serde_json::from_str(&value.ok_or_else(stale)?).map_err(|_|stale())?;if value["id"]!=thread{return Err(stale());}
  let cwd=value["cwd"].as_str().ok_or_else(stale)?;let workspace=stamp.workspace_id.as_deref().ok_or_else(stale)?;
  let projects=super::commit::state_row(db,"kiwi.projects")?;let trees=super::commit::state_row(db,"kiwi.threadWorktrees")?;
  let same=|p:&str|match(std::fs::canonicalize(p),std::fs::canonicalize(cwd)){(Ok(a),Ok(b))=>a==b,_=>false};
  let project_ok=projects["value"].as_array().is_some_and(|p|p.iter().any(|p|p["id"]==workspace&&p["path"].as_str().is_some_and(same)));
  let tree_ok=trees["value"].get(thread).is_some_and(|r|r["projectId"]==workspace&&r["status"]!="removed"&&r["path"].as_str().is_some_and(same));
  let normal_ok=workspace=="openkiwi-normal-chats"&&super::commit::state_row(db,"kiwi.threadProjects")?["value"].get(thread).and_then(Value::as_str).is_some_and(same);
  if !project_ok&&!tree_ok&&!normal_ok{return Err(stale());}
  let count:i64=db.query_row("SELECT COUNT(*) FROM local_transcript_chunks WHERE provider IN ('claude','cursor') AND thread_id=?1 AND json_array_length(entries_json)>0",[thread],|r|r.get(0)).map_err(|_|stale())?;if count!=0{return Err(stale());}
 }
 Ok(handle.to_owned())
}
pub(super) fn detach_schedule_preparation(core:&mut Core,handle:&str){
 super::prompt_preparation::retire_owner(core,handle);
 if let Some(owner)=core.owners.owners.remove(handle){owner.signal.notify_waiters();}
 core.owners.bindings.retain(|_,bound|bound!=handle);
}

pub(super) fn command_state(command:&EngineCommand)->&'static str{use std::sync::atomic::Ordering;if command.finished.load(Ordering::Acquire){"completed"}else if command.ambiguous.load(Ordering::Acquire){"uncertain"}else if command.started.load(Ordering::Acquire){"running"}else{"starting"}}

/// Only empty native preparation may cross the queued admission boundary.
pub(super) fn schedule_admissible(db:&rusqlite::Connection,stamp:&Stamp)->Result<bool,String>{
 let r=super::store::delivery_receipt(db,&stamp.device,&stamp.op_id,stamp.op_seq)?.ok_or_else(stale)?;
 Ok(r["nativeCommitted"]!=true&&r["queueAuthorized"]==true&&matches!(r["disposition"].as_str(),Some("preparing"|"dispatched"))&&r.get("nativeSteps").and_then(Value::as_array).is_none_or(|a|a.iter().all(|s|matches!(s.as_str(),Some("thread/start"|"thread/resume")))))
}
#[cfg(test)]
mod schedule_tests{
 use super::*;
 fn preparation(f:&mut super::super::threads::tests::Fixture){
  f.db.execute("UPDATE remote_op_journal SET delivery_json=json_set(delivery_json,'$.disposition','preparing')",[]).unwrap();
  let receipt=json!({"op":"prompt.scheduleNew","generation":1,"device":"device","opId":"op","opSeq":1,"workspaceId":"p","threadId":"t","provider":"openai","disposition":"preparing","queueAuthorized":true,"ownerHandle":"prep","engineOwnerHandle":"prep","permission":"ask","permissionCeiling":"ask","attemptId":"a","messageId":"m"});super::super::store::save_delivery_receipt(&mut f.db,"device","op",1,&receipt).unwrap();super::super::store::claim_native_step(&mut f.db,"device","op",1,"thread/start").unwrap();
  let mut core=f.inner.lock();core.owners.owners.insert("prep".into(),Owner{local:false,stamp:f.stamp.clone(),kind:"start".into(),prepared_threads:HashSet::from(["t".into()]),thread:Some("t".into()),run:"run".into(),closed:false,pending:HashSet::new(),children:HashMap::new(),signal:Arc::new(Notify::new())});core.owners.bindings.insert(("device".into(),"op".into()),"prep".into());
 }
 #[test]
 fn schedule_admission_atomically_detaches_only_empty_preparation_and_replays(){
  let mut f=super::super::threads::tests::fixture("prompt.scheduleNew");preparation(&mut f);assert!(super::super::commit::prior(&f.db,&f.stamp).is_err());assert!(schedule_admissible(&f.db,&f.stamp).unwrap());
  let mut writes=vec![super::super::commit::StateWrite{key:"kiwi.queuedTurns".into(),expected_revision:None,value:json!({"t":[{"id":"q","threadId":"t","text":"later","attachments":[],"remoteDelivery":{"device":"device","opId":"op","opSeq":1,"workspaceId":"p","ownerHandle":"prep","attemptId":"a","messageId":"m","disposition":"queued"}}]})}];
  let result=super::super::commit::commit_state(&mut f.db,&f.inner,&f.stamp,&mut writes,&[],true,None).unwrap();assert!(result["rows"][0]["value"]["t"][0]["remoteDelivery"].get("ownerHandle").is_none());assert!(!f.inner.lock().owners.owners.contains_key("prep"));assert!(f.inner.lock().owners.bindings.is_empty());
  let r=super::super::store::delivery_receipt(&f.db,"device","op",1).unwrap().unwrap();assert_eq!(r["preparationDetached"],true);assert_eq!(r["preparationSteps"],json!(["thread/start"]));assert!(r.get("nativeSteps").is_none());assert_eq!(r["queuedTurnId"],"q");
  // A late renderer preparation save cannot revive its dead owner or its latch.
  let mut late=r.clone();late["ownerHandle"]=json!("prep");late["nativeSteps"]=json!(["thread/start"]);super::super::store::save_delivery_receipt(&mut f.db,"device","op",1,&late).unwrap();let r=super::super::store::delivery_receipt(&f.db,"device","op",1).unwrap().unwrap();assert!(r.get("ownerHandle").is_none());assert!(r.get("nativeSteps").is_none());assert!(r["nativeCommitted"]==true);
  assert_eq!(super::super::commit::commit_state(&mut f.db,&f.inner,&f.stamp,&mut writes,&[],true,None).unwrap()["replayed"],true);
  super::super::hostbridge::test_attach(&f.inner,2);assert!(!r["ownerHandle"].is_string());assert_eq!(r["disposition"],"queued");
 }
 #[test]
 fn schedule_refuses_pending_or_paid_preparation_without_changing_queue(){
  let mut f=super::super::threads::tests::fixture("prompt.scheduleNew");preparation(&mut f);f.inner.lock().owners.owners.get_mut("prep").unwrap().pending.insert("pending-write".into());assert!(validate_schedule_preparation(&f.inner.lock(),&f.db,&f.stamp,"t").is_err());f.inner.lock().owners.owners.get_mut("prep").unwrap().pending.clear();assert!(validate_schedule_preparation(&f.inner.lock(),&f.db,&f.stamp,"t").is_ok());
  f.db.execute("UPDATE remote_op_journal SET delivery_json=json_set(delivery_json,'$.nativeSteps',json('[\"turn/start\"]'))",[]).unwrap();assert!(!schedule_admissible(&f.db,&f.stamp).unwrap());assert!(validate_schedule_preparation(&f.inner.lock(),&f.db,&f.stamp,"t").is_err());assert!(f.inner.lock().owners.owners.contains_key("prep"));
 }
}
#[cfg(test)]
mod replacement_tests{
 use super::*;
 #[test]
 fn replacement_steering_receipt_is_distinct_and_cannot_also_start_a_turn(){
  let mut db=rusqlite::Connection::open_in_memory().unwrap();super::super::store::init(&db).unwrap();super::super::store::claim_operation(&mut db,"device","root",1,"agents.replace","root").unwrap();let mut r=json!({"threadId":"parent","disposition":"dispatched"});super::super::store::save_delivery_receipt(&mut db,"device","root",1,&r).unwrap();
  let make=|db:&rusqlite::Connection,target:Option<&str>|engine_step_record(db,"device","root","owner","replacement-input","prompt",Some("parent"),"claude","ask",&Some("p".into()),1,1,target);
  assert!(make(&db,Some("target")).is_err());r["agentCutoffConfirmed"]=json!("child");super::super::store::save_delivery_receipt(&mut db,"device","root",1,&r).unwrap();let step=make(&db,Some("target")).unwrap();assert_eq!(make(&db,Some("target")).unwrap(),step);assert!(make(&db,Some("different")).is_err());assert!(make(&db,None).is_err());let id=step["delivery"]["opId"].as_str().unwrap();assert!(super::super::store::claim_native_step(&mut db,"device",id,1,"turn/start").is_err());assert!(super::super::store::claim_native_step(&mut db,"device",id,1,"cursor_turn_steer").is_err());super::super::store::claim_native_step(&mut db,"device",id,1,"claude_turn_steer").unwrap();assert!(super::super::store::claim_native_step(&mut db,"device",id,1,"claude_turn_steer").is_err());assert!(super::super::store::claim_native_step(&mut db,"device",id,1,"claude_prompt").is_err());
 }
}

/// Actual native thread/start/resume proof or a native-owned live start/turn.
pub(super) fn preparation_thread(core:&Core,meta:&RemoteDelivery,thread:&str)->bool{
    check(core,meta).is_ok() && meta.owner_handle.as_ref().and_then(|h|core.owners.owners.get(h)).is_some_and(|owner|
        owner.thread.as_deref()==Some(thread)||owner.prepared_threads.contains(thread)||owner.children.values().any(|child|matches!(child,Child::Native(target) if target.thread_id.as_deref()==Some(thread))))
}

pub(super) fn preparation_owner(core:&Core,meta:&RemoteDelivery,workspace:Option<&str>)->bool{
    meta.owner_handle.as_ref().is_some_and(|handle|
        core.owners.bindings.get(&(meta.device.clone(),meta.op_id.clone()))==Some(handle)
        &&core.owners.owners.get(handle).is_some_and(|owner|!owner.local&&!owner.closed&&owner.stamp.generation==meta.generation&&owner.stamp.device==meta.device&&owner.stamp.workspace_id.as_deref()==workspace))
}

#[cfg(test)]
pub(super) fn test_preparation_owner(core:&mut Core,stamp:Stamp)->String{
    let handle=uuid::Uuid::new_v4().to_string();core.owners.bindings.insert((stamp.device.clone(),stamp.op_id.clone()),handle.clone());
    core.owners.owners.insert(handle.clone(),Owner{local:false,thread:stamp.thread_id.clone(),stamp,kind:"start".into(),prepared_threads:HashSet::new(),run:uuid::Uuid::new_v4().to_string(),closed:false,pending:HashSet::new(),children:HashMap::new(),signal:Arc::new(Notify::new())});handle
}
