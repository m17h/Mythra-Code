//! Remote PTYs reuse the existing app-server command/exec runtime, not a second
//! shell launcher. Native ownership/credit are separate from renderer selection.
use super::{
    commit::{self, Stamp},
    fs_guard::Anchor,
    hostbridge,
    session::Link,
    store,
    wire::{Frame, Role, WireError},
    work, Core, Inner, RemoteState,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, VecDeque},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};
use tokio::sync::Notify;
#[derive(Default)]
pub(super) struct Registry {
    routes: HashMap<String, Arc<Route>>,
}
pub(super) struct Route {
    id: String,
    stamp: Stamp,
    server: Arc<crate::AppServer>,
    anchor: Anchor,
    alive: AtomicBool,
    finished: AtomicBool,
    started: AtomicBool,
    notify: Notify,
    credit: std::sync::Mutex<Credit>,
}
#[derive(Default)]
struct Credit {
    seq: u64,
    through: u64,
    bytes: usize,
    pending: VecDeque<(u64, usize)>,
    deadline: Option<Instant>,
}
fn stale() -> String {
    work::refused("stale_target")
}
fn uncertain() -> String {
    "MYTHRA_DELIVERY_UNCERTAIN: The other device couldn't confirm this terminal action.".into()
}
fn cancel(route: Arc<Route>) {
    if !route.alive.swap(false, Ordering::AcqRel) {
        return;
    }
    route.notify.notify_waiters();
    tauri::async_runtime::spawn(async move {
        let stopped = tokio::time::timeout(Duration::from_secs(12), async {
            route
                .server
                .request(
                    "command/exec/terminate",
                    json!({"processId":route_id(&route)}),
                )
                .await?;
            wait_finished(&route).await
        })
        .await;
        if !matches!(stopped, Ok(Ok(()))) {
            let _=route.server.app.emit("remote-runtime-warning",json!({"device":route.stamp.device,"message":"A remote terminal may still be running. Open Terminal on this device and stop it before continuing."}));
        }
    });
}
fn route_id(route: &Route) -> String {
    route.id.clone()
}
pub(super) fn invalidate(core: &mut Core, device: Option<&str>) {
    let keys: Vec<_> = core
        .terminals
        .routes
        .iter()
        .filter(|(_, r)| device.is_none_or(|d| r.stamp.device == d))
        .map(|(id, _)| id.clone())
        .collect();
    for id in keys {
        if let Some(route) = core.terminals.routes.remove(&id) {
            cancel(route);
        }
    }
}
pub(super) fn allowed(core: &Core, link: &Link, id: &str) -> bool {
    link.role == Role::Host
        && link.is_paired()
        && hostbridge::current_link(core, &link.peer_fingerprint, Role::Host)
            .is_some_and(|current| current.id == link.id)
        && core.terminals.routes.get(id).is_some_and(|r| {
            r.alive.load(Ordering::Acquire)
                && r.stamp.device == link.peer_fingerprint
                && r.stamp.check(core, "terminal.open").is_ok()
        })
}
pub(crate) fn started(app: &AppHandle, process: &str) {
    if let Some(state) = app.try_state::<RemoteState>() {
        if let Some(route) = state.inner.lock().terminals.routes.get(process) {
            route.started.store(true, Ordering::Release);
            route.notify.notify_waiters();
        }
    }
}
pub(crate) fn capture(app: &AppHandle, instance: &str, message: &Value) -> bool {
    if message.get("method").and_then(Value::as_str) != Some("command/exec/outputDelta") {
        return false;
    }
    let Some(id) = message.pointer("/params/processId").and_then(Value::as_str) else {
        return false;
    };
    // Retired remote IDs must never fall through to the selected local terminal.
    if !id.starts_with("remote-terminal-") {
        return false;
    }
    let Some(state) = app.try_state::<RemoteState>() else {
        return true;
    };
    let inner = &state.inner;
    let core = inner.lock();
    let Some(route) = core.terminals.routes.get(id).cloned() else {
        return true;
    };
    let data = message
        .pointer("/params/deltaBase64")
        .and_then(Value::as_str)
        .unwrap_or("");
    if route.server.instance != instance
        || route.stamp.check(&core, "terminal.open").is_err()
        || data.len() > 87384
        || STANDARD
            .decode(data)
            .map_or(true, |bytes| bytes.len() > 65536)
    {
        cancel(route);
        return true;
    }
    let mut credit = route
        .credit
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if credit.bytes + data.len() > 128 * 1024 || credit.pending.len() >= 128 {
        drop(credit);
        cancel(route);
        return true;
    }
    let Some(link) = hostbridge::current_link(&core, &route.stamp.device, Role::Host) else {
        drop(credit);
        cancel(route);
        return true;
    };
    credit.seq += 1;
    let seq = credit.seq;
    credit.bytes += data.len();
    credit.pending.push_back((seq, data.len()));
    if credit.deadline.is_none() {
        credit.deadline = Some(Instant::now() + Duration::from_secs(15));
    }
    let frame = Frame::Evt {
        stream: format!("terminal:{id}"),
        epoch: String::new(),
        seq,
        data: json!({"terminalId":id,"deltaBase64":data}),
    };
    let gate = hostbridge::terminal_gate(&route.stamp, id);
    if !link.send_stream(&frame, gate) {
        drop(credit);
        cancel(route);
    } else {
        route.notify.notify_one();
    }
    true
}
async fn watch(inner: Arc<Inner>, id: String, route: Arc<Route>) {
    loop {
        let changed = route.notify.notified();
        tokio::pin!(changed);
        changed.as_mut().enable();
        if !route.alive.load(Ordering::Acquire) {
            break;
        }
        if route.finished.load(Ordering::Acquire)
            && route
                .credit
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .pending
                .is_empty()
        {
            route.alive.store(false, Ordering::Release);
            break;
        }
        let deadline = route
            .credit
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .deadline;
        if let Some(deadline) = deadline {
            if tokio::time::timeout_at(deadline.into(), changed)
                .await
                .is_err()
            {
                cancel(route.clone());
                break;
            }
        } else {
            changed.await;
        }
    }
    let mut core = inner.lock();
    if core
        .terminals
        .routes
        .get(&id)
        .is_some_and(|r| Arc::ptr_eq(r, &route))
    {
        core.terminals.routes.remove(&id);
    }
}
#[tauri::command]
pub(crate) async fn remote_terminal_start(
    app: AppHandle,
    state: State<'_, RemoteState>,
    window: WebviewWindow,
    stamp: Stamp,
    root: String,
    command: String,
    permission: String,
    columns: u16,
    rows: u16,
    owner_handle: Option<String>,
) -> Result<Value, String> {
    hostbridge::window_is_host(&window).map_err(|_| stale())?;
    if command.is_empty()
        || command.len() > 32768
        || command.contains('\0')
        || columns == 0
        || rows == 0
        || columns > 1000
        || rows > 1000
        || !matches!(permission.as_str(), "read-only" | "ask" | "full")
    {
        return Err(stale());
    }
    let anchor = super::studio::blocking(move || Anchor::open(std::path::Path::new(&root))).await?;
    let server = crate::ensure_server(&app, &app.state::<crate::RuntimeState>()).await?;
    let id = format!("remote-terminal-{}", uuid::Uuid::new_v4());
    let route = Arc::new(Route {
        id: id.clone(),
        stamp: stamp.clone(),
        server: server.clone(),
        anchor,
        alive: AtomicBool::new(true),
        finished: AtomicBool::new(false),
        started: AtomicBool::new(false),
        notify: Notify::new(),
        credit: std::sync::Mutex::new(Credit::default()),
    });
    {
        let mut core = state.inner.lock();
        stamp.check(&core, "terminal.open")?;
        if core.terminals.routes.contains_key(&id) {
            return Err(stale());
        }
        if core.terminals.routes.len() >= 8
            || core
                .terminals
                .routes
                .values()
                .filter(|r| r.stamp.device == stamp.device)
                .count()
                >= 2
        {
            return Err(work::refused("busy"));
        }
        super::owners::record_terminal(&mut core, owner_handle.as_deref(), &id, route.clone())?;
        core.terminals.routes.insert(id.clone(), route.clone());
    }
    let for_db = stamp.clone();
    let for_receipt = id.clone();
    let for_permission = permission.clone();
    let inner = state.inner.clone();
    let saved=state.inner.enqueue_write(false,move|db|{if commit::operation(db,&for_db)?!="terminal.open"{return Err(stale());}if commit::prior(db,&for_db)?.is_some(){return Err(stale());}let core=inner.lock();for_db.check(&core,"terminal.open")?;store::save_delivery_receipt(db,&for_db.device,&for_db.op_id,for_db.op_seq,&json!({"generation":for_db.generation,"device":for_db.device,"opId":for_db.op_id,"opSeq":for_db.op_seq,"workspaceId":for_db.workspace_id,"threadId":for_db.thread_id,"permission":for_permission,"terminalId":for_receipt,"grantRevision":for_db.grant_revision,"disposition":"dispatched"}))});
    if super::finish_write(saved).await.is_err() {
        let mut core = state.inner.lock();
        core.terminals.routes.remove(&id);
        route.alive.store(false, Ordering::Release);
        return Err(stale());
    }
    let cwd = route.anchor.path.to_string_lossy().into_owned();
    let sandbox = match permission.as_str() {
        "read-only" => json!({"type":"readOnly","networkAccess":false}),
        "ask" => {
            json!({"type":"workspaceWrite","writableRoots":[cwd],"networkAccess":true,"excludeTmpdirEnvVar":false,"excludeSlashTmp":false})
        }
        _ => json!({"type":"dangerFullAccess"}),
    };
    let argv = if cfg!(windows) {
        json!(["cmd.exe", "/d", "/s", "/c", command])
    } else {
        json!(["/bin/zsh", "-lc", command])
    };
    let params = json!({"command":argv,"processId":id,"tty":true,"streamStdoutStderr":true,"streamStdin":true,"size":{"cols":columns,"rows":rows},"cwd":cwd,"disableTimeout":true,"sandboxPolicy":sandbox});
    crate::validate_rpc_params("command/exec", &params)?;
    let worker = state.inner.clone();
    let task_route = route.clone();
    let task_id = id.clone();
    tauri::async_runtime::spawn(async move {
        let mut meta = stamp.meta();
        meta.owner_handle = owner_handle;
        let result = server
            .request_remote("command/exec", params, Some(meta))
            .await;
        let core = worker.lock();
        if let Some(link) = hostbridge::current_link(&core, &stamp.device, Role::Host) {
            if stamp.check(&core, "terminal.open").is_ok() {
                link.send_stream(&Frame::Evt{stream:format!("terminal:{task_id}"),epoch:String::new(),seq:{let mut c=task_route.credit.lock().unwrap_or_else(std::sync::PoisonError::into_inner);c.seq+=1;let seq=c.seq;c.pending.push_back((seq,64));c.bytes+=64;c.deadline=Some(Instant::now()+Duration::from_secs(15));seq},data:json!({"terminalId":task_id,"finished":true,"exitCode":result.as_ref().ok().and_then(|v|v.get("exitCode")).cloned(),"failed":result.is_err()})},hostbridge::terminal_gate(&stamp,&task_id));
            }
        }
        drop(core);
        task_route.finished.store(true, Ordering::Release);
        task_route.notify.notify_waiters();
    });
    tauri::async_runtime::spawn(watch(state.inner.clone(), id.clone(), route.clone()));
    let ready = async {
        loop {
            let changed = route.notify.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            if route.started.load(Ordering::Acquire) {
                return Ok(());
            }
            if !route.alive.load(Ordering::Acquire) {
                return Err(uncertain());
            }
            changed.await;
        }
    };
    if !matches!(
        tokio::time::timeout(Duration::from_secs(15), ready).await,
        Ok(Ok(()))
    ) {
        cancel(route);
        return Err(uncertain());
    }
    Ok(json!({"opId":route.stamp.op_id,"state":"accepted","terminalId":id}))
}
#[tauri::command]
pub(crate) async fn remote_terminal_action(
    state: State<'_, RemoteState>,
    window: WebviewWindow,
    stamp: Stamp,
    terminal_id: String,
    action: String,
    data: Option<String>,
    columns: Option<u16>,
    rows: Option<u16>,
) -> Result<Value, String> {
    hostbridge::window_is_host(&window).map_err(|_| stale())?;
    let route = {
        let core = state.inner.lock();
        stamp.check(&core, &format!("terminal.{action}"))?;
        core.terminals
            .routes
            .get(&terminal_id)
            .filter(|r| {
                r.stamp.device == stamp.device
                    && r.stamp.workspace_id == stamp.workspace_id
                    && r.alive.load(Ordering::Acquire)
                    && !r.finished.load(Ordering::Acquire)
            })
            .cloned()
            .ok_or_else(stale)?
    };
    let method = match action.as_str() {
        "write" => "command/exec/write",
        "resize" => "command/exec/resize",
        "close" => "command/exec/terminate",
        _ => return Err(stale()),
    };
    let params = match action.as_str() {
        "write" => {
            let data = data.ok_or_else(stale)?;
            if data.len() > 16384 || STANDARD.decode(&data).map_or(true, |v| v.len() > 12288) {
                return Err(stale());
            }
            json!({"processId":terminal_id,"deltaBase64":data})
        }
        "resize" => {
            let c = columns.filter(|v| *v > 0 && *v <= 1000).ok_or_else(stale)?;
            let r = rows.filter(|v| *v > 0 && *v <= 1000).ok_or_else(stale)?;
            json!({"processId":terminal_id,"size":{"cols":c,"rows":r}})
        }
        _ => json!({"processId":terminal_id}),
    };
    // Each viewer input has its own journal instruction and final native fence.
    let receipt = json!({"generation":stamp.generation,"device":stamp.device,"opId":stamp.op_id,"opSeq":stamp.op_seq,"workspaceId":stamp.workspace_id,"threadId":stamp.thread_id,"disposition":"dispatched","terminalId":terminal_id,"permission":"ask","grantRevision":stamp.grant_revision});
    let copy = stamp.clone();
    super::finish_write(state.inner.enqueue_write(false, move |db| {
        if commit::operation(db, &copy)? != format!("terminal.{action}") {
            return Err(stale());
        }
        store::save_delivery_receipt(db, &copy.device, &copy.op_id, copy.op_seq, &receipt)
    }))
    .await?;
    route
        .server
        .request_remote(method, params, Some(stamp.meta()))
        .await?;
    Ok(json!({"opId":stamp.op_id,"state":"accepted","terminalId":terminal_id}))
}
pub(super) fn ack(inner: &Inner, link: &Link, args: &Value) -> Result<Value, WireError> {
    let core = inner.lock();
    let id = args
        .get("terminalId")
        .and_then(Value::as_str)
        .ok_or_else(|| WireError::new("invalid", "Invalid terminal acknowledgement."))?;
    if !allowed(&core, link, id) {
        return Err(WireError::new(
            "forbidden",
            "This terminal is no longer shared.",
        ));
    }
    let route = core.terminals.routes.get(id).unwrap();
    if route.stamp.workspace_id.as_deref() != args.get("workspaceId").and_then(Value::as_str) {
        return Err(WireError::new(
            "forbidden",
            "This terminal is not in that project.",
        ));
    }
    let seq = args
        .get("through")
        .and_then(Value::as_u64)
        .ok_or_else(|| WireError::new("invalid", "Invalid terminal acknowledgement."))?;
    let mut credit = route
        .credit
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if seq < credit.through || seq > credit.seq {
        return Err(WireError::new(
            "invalid",
            "Invalid terminal acknowledgement.",
        ));
    }
    credit.through = seq;
    while credit.pending.front().is_some_and(|(n, _)| *n <= seq) {
        if let Some((_, size)) = credit.pending.pop_front() {
            credit.bytes = credit.bytes.saturating_sub(size);
        }
    }
    credit.deadline =
        (!credit.pending.is_empty()).then(|| Instant::now() + Duration::from_secs(15));
    route.notify.notify_one();
    Ok(json!({"ok":true}))
}

pub(super) fn dispatch_allowed(core: &Core, id: &str) -> bool {
    core.terminals.routes.get(id).is_some_and(|route| {
        route.alive.load(Ordering::Acquire)
            && !route.finished.load(Ordering::Acquire)
            && route.stamp.check(core, "terminal.open").is_ok()
            && route.anchor.validate().is_ok()
    })
}

async fn wait_finished(route: &Route) -> Result<(), String> {
    loop {
        let change = route.notify.notified();
        tokio::pin!(change);
        change.as_mut().enable();
        if route.finished.load(Ordering::Acquire) {
            return Ok(());
        }
        change.await;
    }
}
pub(crate) async fn confirm_finished(app: &AppHandle, id: &str) -> Result<(), String> {
    let state = app.state::<RemoteState>();
    let route = state
        .inner
        .lock()
        .terminals
        .routes
        .get(id)
        .cloned()
        .ok_or_else(uncertain)?;
    tokio::time::timeout(Duration::from_secs(10), wait_finished(&route))
        .await
        .map_err(|_| uncertain())?
}

pub(super) async fn retire_exact(route: Arc<Route>) -> Result<(), String> {
    if route.finished.load(Ordering::Acquire) {
        return Ok(());
    }
    cancel(route.clone());
    tokio::time::timeout(Duration::from_secs(12), wait_finished(&route))
        .await
        .map_err(|_| uncertain())?
}

pub(super) fn is_finished(route: &Route) -> bool {
    route.finished.load(Ordering::Acquire)
}
