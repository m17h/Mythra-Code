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
}
struct Owner {
    stamp: Stamp,
    kind: String,
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
        if (kind=="workflow"&&op!="workflows.start")||(kind!="workflow"&&!matches!(op.as_str(),"prompt.send"|"prompt.queue"|"queue.edit.finish"|"queue.retry"|"prompt.schedule"|"schedules.edit")){return Err(stale());}
        let mut receipt=super::store::delivery_receipt(db,&stamp.device,&stamp.op_id,stamp.op_seq)?.unwrap_or_else(||json!({"generation":stamp.generation,"device":stamp.device,"opId":stamp.op_id,"opSeq":stamp.op_seq,"workspaceId":stamp.workspace_id,"threadId":stamp.thread_id,"disposition":"preparing","op":op}));
        let mut core=inner.lock();stamp.check(&core,&op)?;
        if let Some(handle)=receipt.get("engineOwnerHandle").and_then(Value::as_str){return if core.owners.owners.get(handle).is_some_and(|owner|!owner.closed&&owner.kind==kind&&owner.run==run_id){Ok(json!({"ownerHandle":handle}))}else{Err(stale())};}
        if receipt.get("nativeSteps").and_then(Value::as_array).is_some_and(|steps|!steps.is_empty())||matches!(receipt.get("disposition").and_then(Value::as_str),Some("dispatched"|"uncertain"|"rejected"))||(kind!="workflow"&&receipt.get("disposition").and_then(Value::as_str)==Some("accepted")){return Err(stale());}
        if core.owners.owners.len()>=256||core.owners.bindings.len()>=4096{return Err(work::refused("busy"));}
        if core.owners.owners.values().any(|o|o.stamp.generation==stamp.generation&&o.stamp.device==stamp.device&&o.kind==kind&&o.run==run_id){return Err(stale());}
        let handle=uuid::Uuid::new_v4().to_string();receipt["ownerHandle"]=json!(handle);receipt["engineOwnerHandle"]=json!(handle);
        db.execute("UPDATE remote_op_journal SET delivery_json=?4 WHERE device_fingerprint=?1 AND op_id=?2 AND op_seq=?3",rusqlite::params![stamp.device,stamp.op_id,stamp.op_seq as i64,receipt.to_string()]).map_err(|_|stale())?;
        core.owners.bindings.insert((stamp.device.clone(),stamp.op_id.clone()),handle.clone());let thread=stamp.thread_id.clone();core.owners.owners.insert(handle.clone(),Owner{stamp,kind,thread,run:run_id,closed:false,pending:HashSet::new(),children:HashMap::new(),signal:Arc::new(Notify::new())});Ok(json!({"ownerHandle":handle}))
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
    for owner in core.owners.owners.values_mut() {
        owner.closed = true;
        owner.signal.notify_waiters();
    }
    core.owners.owners.clear();
    core.owners.bindings.clear();
}
pub(super) fn prove_target(core: &Core, target: &Target) -> Result<String, String> {
    let handle = target.owner_handle.as_deref().ok_or_else(stale)?;
    let owner = core.owners.owners.get(handle).ok_or_else(stale)?;
    if target.kind != "parent"
        || target.method.as_deref() != Some(format!("engine:{}:{}", owner.kind, owner.run).as_str())
        || owner.closed
        || owner.stamp.generation != target.generation
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
        let op=commit::operation(db,&copy)?;if !matches!(op.as_str(),"turn.stop"|"workflows.stop"){return Err(stale());}
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
        if owner.stamp.generation != stamp.generation
            || owner.stamp.workspace_id != stamp.workspace_id
            || owner.closed
        {
            return Err(stale());
        }
        owner.closed = true;
        owner.signal.notify_waiters();
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
    super::finish_write(state.inner.enqueue_write(false, move |db| {
        let tx = db.transaction().map_err(|_| stale())?;
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
        .ok_or_else(|| {
            super::wire::WireError::new("stale_target", "This engine owner has ended.")
        })?;
    Ok(format!("engine:{}:{}", owner.kind, owner.run))
}

pub(super) fn is_open(core: &Core, handle: &str) -> bool {
    core.owners.owners.get(handle).is_some_and(|owner| {
        !owner.closed && hostbridge::check_generation(core, owner.stamp.generation).is_ok()
    })
}

pub(super) fn retire_device(core: &mut Core, device: &str) {
    for owner in core
        .owners
        .owners
        .values_mut()
        .filter(|owner| owner.stamp.device == device)
    {
        owner.closed = true;
        owner.signal.notify_waiters();
    }
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
    let children = {
        let mut core = state.inner.lock();
        hostbridge::check_generation(&core, generation).map_err(|_| stale())?;
        let owner = core
            .owners
            .owners
            .get_mut(&owner_handle)
            .filter(|owner| owner.stamp.generation == generation)
            .ok_or_else(stale)?;
        owner.closed = true;
        owner.signal.notify_waiters();
        if !owner.pending.is_empty() {
            return Ok(json!({"confirmed":false}));
        }
        owner.children.values().cloned().collect::<Vec<_>>()
    };
    for child in &children {
        let ended = match child {
            Child::Terminal(route) => super::terminal::is_finished(route),
            Child::Native(target) => {
                let mut target = target.clone();
                crate::remote_owned_child_ended(&app, &mut target).await?
            }
        };
        if !ended {
            return Ok(json!({"confirmed":false}));
        }
    }
    let mut core = state.inner.lock();
    let owner = core
        .owners
        .owners
        .get_mut(&owner_handle)
        .ok_or_else(stale)?;
    if !owner.pending.is_empty() || owner.children.len() != children.len() {
        return Ok(json!({"confirmed":false}));
    }
    owner.children.clear();
    core.owners.owners.remove(&owner_handle);
    Ok(json!({"confirmed":true}))
}
