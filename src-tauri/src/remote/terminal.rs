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
/// Windows command/exec quotes argv using CRT rules, not CMD rules. Match the
/// local shellCommandWithWindowsQuotes transport, leaving CMD's recipe intact.
fn terminal_argv(command: &str) -> Result<Value, String> {
    #[cfg(windows)]
    {
        windows_terminal_argv(command)
    }
    #[cfg(not(windows))]
    {
        Ok(json!(["/bin/zsh", "-lc", command]))
    }
}

#[cfg(any(windows, test))]
fn windows_terminal_argv(command: &str) -> Result<Value, String> {
    if command.contains('\0') {
        return Err(work::refused("invalid"));
    }
    let start = ";$start=[Diagnostics.ProcessStartInfo]::new();$start.FileName=$env:ComSpec;$start.Arguments='/d /s /c \"'+$command+'\"';$start.UseShellExecute=$false;$process=[Diagnostics.Process]::Start($start);$process.WaitForExit();exit $process.ExitCode";
    let encode = |script: String| {
        STANDARD.encode(
            script
                .encode_utf16()
                .flat_map(u16::to_le_bytes)
                .collect::<Vec<_>>(),
        )
    };
    let direct = encode(format!(
        "$ErrorActionPreference='Stop';$command='{}'{start}",
        command.replace('\'', "''")
    ));
    let nested = encode(format!("$ErrorActionPreference='Stop';$command=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('{}')){start}", STANDARD.encode(command.as_bytes())));
    let encoded = if direct.len() <= nested.len() {
        direct
    } else {
        nested
    };
    if encoded.len() > 30_000 {
        return Err(work::refused("invalid"));
    }
    Ok(json!([
        "powershell.exe",
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        encoded
    ]))
}

#[derive(Default)]
pub(super) struct Registry {
    routes: HashMap<String, Arc<Route>>,
    local: HashMap<String, LocalSummary>,
    subscribers: HashMap<(String, String), Subscriber>,
}
pub(super) struct Route {
    id: String,
    command: String,
    started_at: i64,
    stamp: Stamp,
    runtime: TerminalRuntime,
    anchor: Anchor,
    alive: AtomicBool,
    finished: Arc<AtomicBool>,
    started: AtomicBool,
    notify: Notify,
    history: std::sync::Mutex<History>,
    detached: std::sync::Mutex<Option<Instant>>,
}
enum TerminalRuntime {
    Server(Arc<crate::AppServer>),
    #[cfg(test)]
    Fixture {
        stopped: Arc<AtomicBool>,
        finished: Arc<AtomicBool>,
    },
}
impl TerminalRuntime {
    fn instance(&self) -> &str {
        match self {
            Self::Server(server) => &server.instance,
            #[cfg(test)]
            Self::Fixture { .. } => "fixture",
        }
    }
    async fn request(
        &self,
        method: &str,
        params: Value,
        meta: Option<work::RemoteDelivery>,
    ) -> Result<Value, String> {
        match self {
            Self::Server(server) => {
                if let Some(meta) = meta {
                    server.request_remote(method, params, Some(meta)).await
                } else {
                    server.request(method, params).await
                }
            }
            #[cfg(test)]
            Self::Fixture { stopped, finished } => {
                if method == "command/exec/terminate" {
                    stopped.store(true, Ordering::Release);
                    finished.store(true, Ordering::Release);
                }
                Ok(json!({}))
            }
        }
    }
    fn warn(&self, device: &str) {
        match self {
            Self::Server(server) => {
                let _ = server.app.emit("remote-runtime-warning",json!({"device":device,"message":"A remote terminal may still be running. Open Terminal on this device and stop it before continuing."}));
            }
            #[cfg(test)]
            Self::Fixture { .. } => {}
        }
    }
}
const MAX_HISTORY: usize = 256 * 1024;
const MAX_READ: usize = 64 * 1024;
const REATTACH_GRACE: Duration = Duration::from_secs(5 * 60);
#[derive(Default)]
struct History {
    bytes: VecDeque<u8>,
    cursor: u64,
    seq: u64,
    exit_code: Option<i64>,
    ended_at: Option<i64>,
    failed: bool,
}
impl History {
    fn append(&mut self, bytes: &[u8]) {
        self.cursor += bytes.len() as u64;
        self.seq += 1;
        if bytes.len() >= MAX_HISTORY {
            self.bytes.clear();
            self.bytes.extend(&bytes[bytes.len() - MAX_HISTORY..]);
        } else {
            let excess = (self.bytes.len() + bytes.len()).saturating_sub(MAX_HISTORY);
            self.bytes.drain(..excess);
            self.bytes.extend(bytes);
        }
    }
    fn read(&self, cursor: Option<u64>, limit: usize) -> Result<Value, String> {
        if limit == 0 || limit > MAX_READ || cursor.is_some_and(|c| c > self.cursor) {
            return Err(stale());
        }
        let start = self.cursor - self.bytes.len() as u64;
        let wanted = cursor.unwrap_or(self.cursor.saturating_sub(limit as u64));
        let from = wanted.max(start);
        let data: Vec<u8> = self
            .bytes
            .iter()
            .skip((from - start) as usize)
            .take(limit)
            .copied()
            .collect();
        Ok(
            json!({"deltaBase64":STANDARD.encode(&data),"cursor":from + data.len() as u64,
            "truncated":wanted < start || cursor.is_none() && from > 0,"hasMore":from + (data.len() as u64) < self.cursor,"seq":self.seq}),
        )
    }
}
struct Subscriber {
    stamp: Stamp,
    link_id: u64,
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
                .runtime
                .request(
                    "command/exec/terminate",
                    json!({"processId":route_id(&route)}),
                    None,
                )
                .await?;
            wait_finished(&route).await
        })
        .await;
        if !matches!(stopped, Ok(Ok(()))) {
            route.runtime.warn(&route.stamp.device);
        }
    });
}
fn route_id(route: &Route) -> String {
    route.id.clone()
}
pub(super) fn invalidate(core: &mut Core, device: Option<&str>) {
    core.terminals
        .subscribers
        .retain(|(peer, _), _| device.is_some_and(|d| peer != d));
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
    core.terminals
        .subscribers
        .get(&(link.peer_fingerprint.clone(), id.to_owned()))
        .is_some_and(|sub| {
            sub.link_id == link.id
                && catalog_access(core, link, &sub.stamp).is_ok()
                && (core.terminals.routes.get(id).is_some_and(|r| {
                    r.stamp.workspace_id == sub.stamp.workspace_id && r.anchor.validate().is_ok()
                }) || core
                    .terminals
                    .local
                    .get(id)
                    .is_some_and(|s| s.anchor.validate().is_ok()))
        })
}
fn catalog_access(core: &Core, link: &Link, stamp: &Stamp) -> Result<(), String> {
    if link.role != Role::Host
        || !link.is_paired()
        || !hostbridge::current_link(core, &link.peer_fingerprint, Role::Host)
            .is_some_and(|l| l.id == link.id)
        || stamp.device != link.peer_fingerprint
    {
        return Err(stale());
    }
    hostbridge::check_generation(core, stamp.generation).map_err(|_| stale())?;
    let grant = work::grant_locked(core, &stamp.device)
        .filter(|g| g.view && g.capabilities.terminal && g.revision == stamp.grant_revision)
        .ok_or_else(stale)?;
    if let store::GrantScope::Projects { project_ids } = &grant.scope {
        if !stamp
            .workspace_id
            .as_ref()
            .is_some_and(|p| project_ids.contains(p))
        {
            return Err(stale());
        }
    }
    Ok(())
}
fn detach_route(route: &Route) {
    let mut detached = route
        .detached
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if detached.is_none() {
        *detached = Some(Instant::now());
    }
    route.notify.notify_one();
}
/// Only plain transport loss gets a grace period. Revocation still calls invalidate.
pub(super) fn disconnected(core: &mut Core, device: &str) {
    core.terminals
        .subscribers
        .retain(|(peer, _), _| peer != device);
    for route in core
        .terminals
        .routes
        .values()
        .filter(|r| r.stamp.device == device)
    {
        detach_route(route);
    }
}
fn publish(core: &mut Core, id: &str, seq: u64, data: Value) {
    let keys: Vec<_> = core
        .terminals
        .subscribers
        .keys()
        .filter(|(_, terminal)| terminal == id)
        .cloned()
        .collect();
    for key in keys {
        let sub = &core.terminals.subscribers[&key];
        let link = hostbridge::current_link(core, &key.0, Role::Host);
        let size = serde_json::to_vec(&data).map_or(MAX_READ * 2, |v| v.len());
        let valid = link
            .as_ref()
            .is_some_and(|l| sub.link_id == l.id && catalog_access(core, l, &sub.stamp).is_ok())
            && sub.bytes + size <= 128 * 1024
            && sub.pending.len() < 128
            && sub.deadline.is_none_or(|d| d > Instant::now());
        if !valid {
            core.terminals.subscribers.remove(&key);
            if let Some(route) = core
                .terminals
                .routes
                .get(id)
                .filter(|r| r.stamp.device == key.0)
            {
                detach_route(route);
            }
            continue;
        }
        let sub = core.terminals.subscribers.get_mut(&key).unwrap();
        sub.seq = seq;
        sub.bytes += size;
        sub.pending.push_back((seq, size));
        sub.deadline
            .get_or_insert(Instant::now() + Duration::from_secs(15));
        let frame = Frame::Evt {
            stream: format!("terminal:{id}"),
            epoch: String::new(),
            seq,
            data: data.clone(),
        };
        if !link
            .unwrap()
            .send_stream(&frame, hostbridge::terminal_gate(&sub.stamp, id))
        {
            core.terminals.subscribers.remove(&key);
            if let Some(route) = core
                .terminals
                .routes
                .get(id)
                .filter(|r| r.stamp.device == key.0)
            {
                detach_route(route);
            }
        }
    }
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
    let remote = id.starts_with("remote-terminal-");
    let Some(state) = app.try_state::<RemoteState>() else {
        return remote;
    };
    let data = message
        .pointer("/params/deltaBase64")
        .and_then(Value::as_str)
        .unwrap_or("");
    if data.len() > 87384 {
        return remote;
    }
    let Ok(bytes) = STANDARD.decode(data) else {
        return remote;
    };
    if bytes.len() > 65536 {
        return remote;
    }
    let mut core = state.inner.lock();
    if remote {
        let Some(route) = core
            .terminals
            .routes
            .get(id)
            .filter(|r| r.runtime.instance() == instance)
            .cloned()
        else {
            return true;
        };
        if route.stamp.check(&core, "terminal.open").is_err() {
            cancel(route);
            return true;
        }
        let seq = {
            let mut h = route
                .history
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            h.append(&bytes);
            h.seq
        };
        publish(
            &mut core,
            id,
            seq,
            json!({"terminalId":id,"deltaBase64":data}),
        );
    } else {
        let ids: Vec<_> = core
            .terminals
            .local
            .iter()
            .filter(|(_, s)| {
                s.proof.instance == instance
                    && s.proof.process == id
                    && super::owners::command_state(&s.proof) != "uncertain"
            })
            .map(|(key, _)| key.clone())
            .collect();
        for key in ids {
            let seq = {
                let mut h = core.terminals.local[&key]
                    .history
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                h.append(&bytes);
                h.seq
            };
            publish(
                &mut core,
                &key,
                seq,
                json!({"terminalId":key,"deltaBase64":data}),
            );
        }
    }
    remote // Local events still reach the local Terminal panel.
}
async fn watch(_inner: Arc<Inner>, _id: String, route: Arc<Route>) {
    loop {
        let changed = route.notify.notified();
        tokio::pin!(changed);
        changed.as_mut().enable();
        if !route.alive.load(Ordering::Acquire) || route.finished.load(Ordering::Acquire) {
            break;
        }
        let deadline = route
            .detached
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .map(|t| t + REATTACH_GRACE);
        if let Some(deadline) = deadline {
            if tokio::time::timeout_at(deadline.into(), changed)
                .await
                .is_err()
            {
                let detached = route
                    .detached
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                if detached.is_some_and(|at| grace_expired(at, Instant::now())) {
                    cancel(route.clone());
                    break;
                }
            }
        } else {
            changed.await;
        }
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
    // Encoding/length failure is a definite pre-dispatch refusal: no route,
    // provider startup or dispatched journal receipt may have been created yet.
    let argv = terminal_argv(&command)?;
    let anchor = super::studio::blocking(move || Anchor::open(std::path::Path::new(&root))).await?;
    let server = crate::ensure_server(&app, &app.state::<crate::RuntimeState>()).await?;
    let id = format!("remote-terminal-{}", uuid::Uuid::new_v4());
    let route = Arc::new(Route {
        id: id.clone(),
        command: command.clone(),
        started_at: crate::unix_timestamp_ms(),
        stamp: stamp.clone(),
        runtime: TerminalRuntime::Server(server.clone()),
        anchor,
        alive: AtomicBool::new(true),
        finished: Arc::new(AtomicBool::new(false)),
        started: AtomicBool::new(false),
        notify: Notify::new(),
        history: std::sync::Mutex::new(History::default()),
        detached: std::sync::Mutex::new(None),
    });
    {
        let mut core = state.inner.lock();
        stamp.check(&core, "terminal.open")?;
        if core.terminals.routes.contains_key(&id) {
            return Err(stale());
        }
        prune(&mut core.terminals);
        if core
            .terminals
            .routes
            .values()
            .filter(|r| !r.finished.load(Ordering::Acquire))
            .count()
            >= 8
            || core
                .terminals
                .routes
                .values()
                .filter(|r| r.stamp.device == stamp.device && !r.finished.load(Ordering::Acquire))
                .count()
                >= 2
        {
            return Err(work::refused("busy"));
        }
        let link = hostbridge::current_link(&core, &stamp.device, Role::Host).ok_or_else(stale)?;
        core.terminals.subscribers.retain(|(peer, _), sub| {
            peer != &stamp.device || sub.stamp.workspace_id != stamp.workspace_id
        });
        if core.terminals.subscribers.len() >= 128
            || core
                .terminals
                .subscribers
                .keys()
                .filter(|(peer, _)| peer == &stamp.device)
                .count()
                >= 8
        {
            return Err(work::refused("busy"));
        }
        super::owners::record_terminal(&mut core, owner_handle.as_deref(), &id, route.clone())?;
        core.terminals.subscribers.insert(
            (stamp.device.clone(), id.clone()),
            subscriber(stamp.clone(), link.id, 0),
        );
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
        core.terminals
            .subscribers
            .remove(&(route.stamp.device.clone(), id.clone()));
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
        let mut core = worker.lock();
        let (seq, code) = {
            let mut h = task_route
                .history
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            h.seq += 1;
            h.exit_code = result
                .as_ref()
                .ok()
                .and_then(|v| v.get("exitCode"))
                .and_then(Value::as_i64);
            h.failed = result.is_err();
            h.ended_at = Some(crate::unix_timestamp_ms());
            (h.seq, h.exit_code)
        };
        task_route.finished.store(true, Ordering::Release);
        task_route.alive.store(false, Ordering::Release);
        publish(
            &mut core,
            &task_id,
            seq,
            json!({"terminalId":task_id,"finished":true,"exitCode":code,"failed":result.is_err()}),
        );
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
        .runtime
        .request(method, params, Some(stamp.meta()))
        .await?;
    Ok(json!({"opId":stamp.op_id,"state":"accepted","terminalId":terminal_id}))
}
pub(super) fn ack(inner: &Inner, link: &Link, args: &Value) -> Result<Value, WireError> {
    let mut core = inner.lock();
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
    let sub = core
        .terminals
        .subscribers
        .get_mut(&(link.peer_fingerprint.clone(), id.to_owned()))
        .unwrap();
    if sub.stamp.workspace_id.as_deref() != args.get("workspaceId").and_then(Value::as_str) {
        return Err(WireError::new(
            "forbidden",
            "This terminal is not in that project.",
        ));
    }
    let seq = args
        .get("through")
        .and_then(Value::as_u64)
        .ok_or_else(|| WireError::new("invalid", "Invalid terminal acknowledgement."))?;
    if seq < sub.through || seq > sub.seq {
        return Err(WireError::new(
            "invalid",
            "Invalid terminal acknowledgement.",
        ));
    }
    sub.through = seq;
    while sub.pending.front().is_some_and(|(n, _)| *n <= seq) {
        if let Some((_, size)) = sub.pending.pop_front() {
            sub.bytes = sub.bytes.saturating_sub(size);
        }
    }
    sub.deadline = (!sub.pending.is_empty()).then(|| Instant::now() + Duration::from_secs(15));
    let empty = sub.pending.is_empty();
    let finished = core
        .terminals
        .routes
        .get(id)
        .is_some_and(|r| r.finished.load(Ordering::Acquire))
        || core.terminals.local.get(id).is_some_and(|s| {
            s.history
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .ended_at
                .is_some()
        });
    if empty && finished {
        core.terminals
            .subscribers
            .remove(&(link.peer_fingerprint.clone(), id.to_owned()));
    }
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

struct LocalSummary {
    id: String,
    root_identity: String,
    anchor: Anchor,
    command: String,
    started_at: i64,
    proof: Arc<super::owners::EngineCommand>,
    history: std::sync::Mutex<History>,
}
/// Tracking only. Invalid metadata/full registry never changes a local command.
pub(crate) fn observe_local(
    app: &AppHandle,
    proof: Arc<super::owners::EngineCommand>,
    params: &Value,
) {
    if params["tty"] != true || proof.process.starts_with("remote-terminal-") {
        return;
    }
    let Some(cwd) = params["cwd"].as_str() else {
        return;
    };
    let Ok(anchor) = Anchor::open(std::path::Path::new(cwd)) else {
        return;
    };
    let Ok(identity) = anchor.identity() else {
        return;
    };
    let Some(argv) = params["command"].as_array() else {
        return;
    };
    let label = if argv.len() >= 3
        && matches!(
            argv[0].as_str(),
            Some("/bin/zsh" | "/bin/bash" | "cmd.exe" | "powershell.exe")
        ) {
        argv.last().and_then(Value::as_str).unwrap_or("").to_owned()
    } else {
        argv.iter()
            .filter_map(Value::as_str)
            .collect::<Vec<_>>()
            .join(" ")
    };
    let state = app.state::<RemoteState>();
    let mut core = state.inner.lock();
    if core.terminals.local.len() >= 64 {
        let old = core
            .terminals
            .local
            .iter()
            .filter(|(_, s)| super::owners::command_state(&s.proof) == "completed")
            .min_by_key(|(_, s)| s.started_at)
            .map(|(k, _)| k.clone());
        if let Some(id) = old {
            core.terminals.local.remove(&id);
            core.terminals
                .subscribers
                .retain(|(_, terminal), _| terminal != &id);
        } else {
            return;
        }
    }
    let id = uuid::Uuid::new_v4().to_string();
    core.terminals.local.insert(
        id.clone(),
        LocalSummary {
            id,
            root_identity: identity,
            anchor,
            command: label.chars().take(512).collect(),
            started_at: crate::unix_timestamp_ms(),
            proof,
            history: std::sync::Mutex::new(History::default()),
        },
    );
}
#[tauri::command]
pub(crate) async fn remote_terminal_list(
    app: AppHandle,
    state: State<'_, RemoteState>,
    window: WebviewWindow,
    generation: u64,
    device: String,
    grant_revision: u64,
    workspace_id: String,
    root: String,
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
    let inner = state.inner.clone();
    let worker = inner.clone();
    inner.read_db(move|db|{
  let anchor=Anchor::open(std::path::Path::new(&root))?;let identity=anchor.identity()?;
  let projects=commit::state_row(db,"kiwi.projects")?["value"].clone();let project=projects.as_array().and_then(|p|p.iter().find(|p|p["id"]==workspace_id));
  let allowed=if workspace_id=="openkiwi-normal-chats"{crate::normal_chat::contains(&app,&root)?}else if let Some(project)=project{
   let base=project["path"].as_str().ok_or_else(stale)?;
   if Anchor::open(std::path::Path::new(base))?.identity()?==identity{true}else{
    commit::state_row(db,"kiwi.threadWorktrees")?["value"].as_object().is_some_and(|rows|rows.values().any(|r|r["status"]!="removed"&&r["projectId"]==workspace_id&&r["path"].as_str().is_some_and(|p|std::fs::canonicalize(p).ok()==std::fs::canonicalize(&root).ok())))
   }
  }else{false};if !allowed{return Err(stale());}
  let core=worker.lock();hostbridge::check_generation(&core,generation).map_err(|_|stale())?;let grant=work::grant_locked(&core,&device).filter(|g|g.view&&g.capabilities.terminal&&g.revision==grant_revision).ok_or_else(stale)?;
  if let store::GrantScope::Projects{project_ids}=&grant.scope{if !project_ids.contains(&workspace_id){return Err(stale());}}
  let mut terminals=Vec::new();
  for route in core.terminals.routes.values().filter(|r|r.stamp.workspace_id.as_deref()==Some(&workspace_id)&&r.anchor.identity().is_ok_and(|id|id==identity)){
   let owned=route.stamp.device==device&&route.stamp.generation==generation&&route.stamp.grant_revision==grant_revision;
   terminals.push(json!({"terminalId":if owned{route.id.clone()}else{format!("read-only:{}",route.id)},"command":route.command.chars().take(512).collect::<String>(),"state":if route.finished.load(Ordering::Acquire){"completed"}else if !route.alive.load(Ordering::Acquire){"stopping"}else if route.started.load(Ordering::Acquire){"running"}else{"starting"},"startedAt":route.started_at,"threadId":route.stamp.thread_id,"seq":route.history.lock().unwrap_or_else(std::sync::PoisonError::into_inner).seq,"owned":owned}));
  }
  for summary in core.terminals.local.values().filter(|s|s.root_identity==identity){terminals.push(json!({"terminalId":summary.id,"command":summary.command,"state":super::owners::command_state(&summary.proof),"startedAt":summary.started_at,"owned":false}));}
  terminals.sort_by_key(|r|std::cmp::Reverse(r["startedAt"].as_i64().unwrap_or(0)));let truncated=terminals.len()>32;terminals.truncate(32);anchor.validate()?;Ok(json!({"terminals":terminals,"truncated":truncated}))
 }).await
}

#[cfg(test)]
mod encoding_tests {
    use super::*;
    use sha2::{Digest, Sha256};

    #[test]
    fn windows_encoder_matches_local_recipe_transport_bytes() {
        // SHA-256 of decoded scripts produced by the real
        // src/lib/shellCommand.ts::shellCommandWithWindowsQuotes on these
        // inputs, not another copy of the Rust algorithm. Cover BOTH branches.
        for (command, expected, nested) in [
            (
                "echo native-terminal && exit /b 7".to_owned(),
                "0b63392821f78bdbaaae8ef75a792c3e6cbb3557c94e042b3dc6fff01cd865ad",
                false,
            ),
            (
                "cd /d \"é quoted & spaced\" && type \"file name.txt\" && exit /b 7".to_owned(),
                "0f88a40053de6cf8ddd06b94989e7b1d9ac42fc6d56579aa953e38d5f15e9b1b",
                false,
            ),
            (
                "echo 'apostrophe' \"quote\" 😀\r\nexit /b 7".to_owned(),
                "626251440b9d6253e97456220bd75b1aea715326c105270a85fa959fe81e2c97",
                false,
            ),
            (
                "'".repeat(4096),
                "33a3dc592238f02dd50fde6f4919a1b7471c130ce619c66ef3ee3cee4eba8b22",
                true,
            ),
        ] {
            let argv = windows_terminal_argv(&command).unwrap();
            assert_eq!(argv.as_array().unwrap().len(), 5);
            assert_eq!(argv[0], "powershell.exe");
            assert_eq!(argv[1], "-NoProfile");
            assert_eq!(argv[2], "-NonInteractive");
            assert_eq!(argv[3], "-EncodedCommand");
            let bytes = STANDARD.decode(argv[4].as_str().unwrap()).unwrap();
            assert_eq!(format!("{:x}", Sha256::digest(&bytes)), expected);
            let script = String::from_utf16(
                &bytes
                    .chunks_exact(2)
                    .map(|b| u16::from_le_bytes([b[0], b[1]]))
                    .collect::<Vec<_>>(),
            )
            .unwrap();
            assert_eq!(script.contains("FromBase64String"), nested);
        }
    }

    #[test]
    fn windows_encoder_refuses_nul_and_overlong_before_dispatch() {
        assert!(windows_terminal_argv("hello\0").is_err());
        assert!(windows_terminal_argv(&"x".repeat(32768)).is_err());
    }

    #[cfg(not(windows))]
    #[test]
    fn local_unix_shell_argv_is_unchanged() {
        let command = "echo 'quoted' \"text\" é 😀";
        assert_eq!(
            terminal_argv(command).unwrap(),
            json!(["/bin/zsh", "-lc", command])
        );
    }
}

#[cfg(all(test, windows))]
mod windows_tests {
    use super::super::windows_tests::{run, TempRoot};
    use super::*;
    fn execute(command: &str, root: &std::path::Path) -> std::process::Output {
        let argv = terminal_argv(command).expect("encode fixture recipe");
        let values = argv.as_array().unwrap();
        let mut process =
            crate::process_launch::background_std_command(values[0].as_str().unwrap());
        process.current_dir(root);
        for value in &values[1..] {
            process.arg(value.as_str().unwrap());
        }
        run(&mut process)
    }
    #[test]
    fn windows_terminal_argv_runs_a_real_headless_shell_and_preserves_exit_code() {
        let temp = TempRoot::new("terminal");
        let result = execute("echo native-terminal && exit /b 7", &temp.0);
        assert_eq!(result.status.code(), Some(7));
        assert!(String::from_utf8_lossy(&result.stdout).contains("native-terminal"));
    }
    #[test]
    fn windows_terminal_argv_preserves_quoted_setup_and_file_names() {
        let temp = TempRoot::new("terminal-quotes");
        let folder = temp.0.join("é quoted & spaced");
        std::fs::create_dir(&folder).unwrap();
        std::fs::write(folder.join("file name.txt"), b"quoted fixture").unwrap();
        let result = execute(
            "cd /d \"é quoted & spaced\" && type \"file name.txt\" && exit /b 7",
            &temp.0,
        );
        assert_eq!(
            result.status.code(),
            Some(7),
            "test uses production terminal argv, not a hand-fixed CMD raw_arg"
        );
        assert_eq!(result.stdout, b"quoted fixture");
    }
}

fn subscriber(stamp: Stamp, link_id: u64, seq: u64) -> Subscriber {
    Subscriber {
        stamp,
        link_id,
        seq,
        through: seq,
        bytes: 0,
        pending: VecDeque::new(),
        deadline: None,
    }
}
fn prune(registry: &mut Registry) {
    while registry.routes.len() >= 32 {
        let old = registry
            .routes
            .iter()
            .filter(|(_, r)| r.finished.load(Ordering::Acquire))
            .min_by_key(|(_, r)| r.started_at)
            .map(|(id, _)| id.clone());
        let Some(old) = old else {
            break;
        };
        registry.routes.remove(&old);
        registry.subscribers.retain(|(_, id), _| id != &old);
    }
}
pub(crate) fn local_finished(
    app: &AppHandle,
    proof: &Arc<super::owners::EngineCommand>,
    result: &Result<Value, String>,
    replied: bool,
) {
    let Some(state) = app.try_state::<RemoteState>() else {
        return;
    };
    let mut core = state.inner.lock();
    let ids: Vec<_> = core
        .terminals
        .local
        .iter()
        .filter(|(_, s)| Arc::ptr_eq(&s.proof, proof))
        .map(|(id, _)| id.clone())
        .collect();
    for id in ids {
        if let Ok(result) = result {
            for key in ["stdout", "stderr"] {
                if let Some(text) = result.get(key).and_then(Value::as_str) {
                    for bytes in text.as_bytes().chunks(65536) {
                        let seq = {
                            let mut h = core.terminals.local[&id]
                                .history
                                .lock()
                                .unwrap_or_else(std::sync::PoisonError::into_inner);
                            h.append(bytes);
                            h.seq
                        };
                        publish(
                            &mut core,
                            &id,
                            seq,
                            json!({"terminalId":id,"deltaBase64":STANDARD.encode(bytes)}),
                        );
                    }
                }
            }
        }
        let (seq, code) = {
            let mut h = core.terminals.local[&id]
                .history
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            h.seq += 1;
            h.exit_code = result
                .as_ref()
                .ok()
                .and_then(|v| v.get("exitCode"))
                .and_then(Value::as_i64);
            h.failed = result.is_err();
            // A broken provider pipe does not prove the command exited.
            if replied || !proof.started.load(Ordering::Acquire) {
                h.ended_at = Some(crate::unix_timestamp_ms());
            }
            (h.seq, h.exit_code)
        };
        publish(
            &mut core,
            &id,
            seq,
            json!({"terminalId":id,"finished":true,"exitCode":code,"failed":result.is_err()}),
        );
    }
}

fn status(
    id: &str,
    command: &str,
    started: i64,
    running: bool,
    state: &str,
    owned: bool,
    attachable: bool,
    history: &History,
) -> Value {
    json!({"terminalId":id,"command":command.chars().take(512).collect::<String>(),"startedAt":started,
        "running":running,"state":state,"exitCode":history.exit_code,
        "elapsedMs":history.ended_at.unwrap_or_else(crate::unix_timestamp_ms).saturating_sub(started).max(0),
        "owned":owned,"attachable":attachable,"seq":history.seq})
}
/// All root identities come from persisted host project/worktree records. The
/// viewer supplies only a project id; never a path, process id, or instance id.
pub(super) async fn catalog(
    inner: &Arc<Inner>,
    link: &Arc<Link>,
    op: &str,
    args: Value,
) -> Result<Value, WireError> {
    super::manifest::validate(op, &args)?;
    let workspace = args
        .get("workspaceId")
        .and_then(Value::as_str)
        .ok_or_else(|| WireError::new("invalid", "Choose a shared project."))?
        .to_owned();
    let (stamp, link_id) = {
        let core = inner.lock();
        let grant = work::grant_locked(&core, &link.peer_fingerprint)
            .ok_or_else(|| WireError::new("forbidden", "Terminal access is not allowed."))?;
        let stamp = Stamp {
            generation: core.bridge.generation,
            device: link.peer_fingerprint.clone(),
            grant_revision: grant.revision,
            op_id: String::new(),
            op_seq: 0,
            workspace_id: Some(workspace.clone()),
            thread_id: None,
        };
        catalog_access(&core, link, &stamp).map_err(|_| {
            WireError::new(
                "forbidden",
                "This project is not shared with Terminal access.",
            )
        })?;
        (stamp, link.id)
    };
    let worker = inner.clone();
    let link = link.clone();
    let op = op.to_owned();
    inner
        .read_db(move |db| {
            let roots = super::session_catalog::project_roots(db, &workspace)?;
            let mut core = worker.lock();
            catalog_access(&core, &link, &stamp)?;
            let limit =
                args.get("limit")
                    .and_then(Value::as_u64)
                    .unwrap_or(if op == "terminal.list" {
                        32
                    } else {
                        MAX_READ as u64
                    }) as usize;
            if op == "terminal.list" {
                if limit == 0 || limit > 32 {
                    return Err(stale());
                }
                let mut terminals = Vec::new();
                for route in core.terminals.routes.values().filter(|r| {
                    r.stamp.workspace_id.as_deref() == Some(&workspace)
                        && r.anchor.identity().is_ok_and(|i| roots.contains(&i))
                        && r.anchor.validate().is_ok()
                }) {
                    let owned = route.stamp.device == stamp.device;
                    let h = route
                        .history
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner);
                    let mut row = status(
                        &route.id,
                        &route.command,
                        route.started_at,
                        !route.finished.load(Ordering::Acquire),
                        if route.finished.load(Ordering::Acquire) {
                            "exited"
                        } else {
                            "running"
                        },
                        owned,
                        owned,
                        &h,
                    );
                    row["threadId"] = json!(route.stamp.thread_id);
                    terminals.push(row);
                }
                for local in core
                    .terminals
                    .local
                    .values()
                    .filter(|s| roots.contains(&s.root_identity) && s.anchor.validate().is_ok())
                {
                    let h = local
                        .history
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner);
                    terminals.push(status(
                        &local.id,
                        &local.command,
                        local.started_at,
                        h.ended_at.is_none(),
                        if h.ended_at.is_some() {
                            "exited"
                        } else {
                            super::owners::command_state(&local.proof)
                        },
                        false,
                        true,
                        &h,
                    ));
                }
                terminals.sort_by_key(|r| std::cmp::Reverse(r["startedAt"].as_i64().unwrap_or(0)));
                let truncated = terminals.len() > limit;
                terminals.truncate(limit);
                return Ok(json!({"terminals":terminals,"truncated":truncated}));
            }
            if limit == 0 || limit > MAX_READ {
                return Err(stale());
            }
            let id = args
                .get("terminalId")
                .and_then(Value::as_str)
                .ok_or_else(stale)?
                .to_owned();
            let (mut row, seq, finished) = if let Some(route) = core.terminals.routes.get(&id) {
                if route.stamp.workspace_id.as_deref() != Some(&workspace)
                    || !route.anchor.identity().is_ok_and(|i| roots.contains(&i))
                {
                    return Err(stale());
                }
                route.anchor.validate()?;
                let owned = route.stamp.device == stamp.device;
                if op == "terminal.attach"
                    && (!owned
                        || !route.finished.load(Ordering::Acquire)
                            && (!route.alive.load(Ordering::Acquire)
                                || route
                                    .detached
                                    .lock()
                                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                                    .is_some_and(|at| grace_expired(at, Instant::now()))))
                {
                    return Err(work::refused("forbidden"));
                }
                let h = route
                    .history
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                let mut row = status(
                    &id,
                    &route.command,
                    route.started_at,
                    !route.finished.load(Ordering::Acquire),
                    if route.finished.load(Ordering::Acquire) {
                        "exited"
                    } else {
                        "running"
                    },
                    owned,
                    owned,
                    &h,
                );
                if op != "terminal.status" {
                    merge_read(&mut row, &h, &args, limit, op == "terminal.attach")?;
                }
                (row, h.seq, route.finished.load(Ordering::Acquire))
            } else if let Some(local) = core.terminals.local.get(&id) {
                if !roots.contains(&local.root_identity) {
                    return Err(stale());
                }
                local.anchor.validate()?;
                let h = local
                    .history
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                let mut row = status(
                    &id,
                    &local.command,
                    local.started_at,
                    h.ended_at.is_none(),
                    if h.ended_at.is_some() {
                        "exited"
                    } else {
                        super::owners::command_state(&local.proof)
                    },
                    false,
                    true,
                    &h,
                );
                if op != "terminal.status" {
                    merge_read(&mut row, &h, &args, limit, op == "terminal.attach")?;
                }
                (row, h.seq, h.ended_at.is_some())
            } else {
                return Err(stale());
            };
            if op == "terminal.attach" && !finished {
                // This renderer exposes one selected terminal per project. Switching
                // its selected session releases the previous bounded stream slot.
                core.terminals.subscribers.retain(|(peer, _), sub| {
                    peer != &stamp.device || sub.stamp.workspace_id != stamp.workspace_id
                });
                // Per-viewer and global bounds also cover local session observers.
                if core.terminals.subscribers.len() >= 128
                    || core
                        .terminals
                        .subscribers
                        .keys()
                        .filter(|(d, _)| d == &stamp.device)
                        .count()
                        >= 8
                {
                    if !core
                        .terminals
                        .subscribers
                        .contains_key(&(stamp.device.clone(), id.clone()))
                    {
                        return Err(work::refused("busy"));
                    }
                }
                if let Some(route) = core.terminals.routes.get(&id) {
                    let mut detached = route
                        .detached
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner);
                    if !route.alive.load(Ordering::Acquire)
                        || detached.is_some_and(|at| grace_expired(at, Instant::now()))
                    {
                        return Err(stale());
                    }
                    *detached = None;
                    route.notify.notify_one();
                }
                core.terminals
                    .subscribers
                    .insert((stamp.device.clone(), id), subscriber(stamp, link_id, seq));
            }
            row["finished"] = json!(finished);
            Ok(row)
        })
        .await
        .map_err(|e| {
            WireError::new(
                if e.contains("forbidden") {
                    "forbidden"
                } else if e.contains("busy") {
                    "busy"
                } else {
                    "stale_target"
                },
                "This terminal is not available in that shared project.",
            )
        })
}
fn merge_read(
    row: &mut Value,
    history: &History,
    args: &Value,
    limit: usize,
    attach: bool,
) -> Result<(), String> {
    let cursor = if attach {
        None
    } else {
        args.get("cursor").and_then(Value::as_u64)
    };
    let read = history.read(cursor, limit)?;
    for (key, value) in read.as_object().unwrap() {
        row[key] = value.clone();
    }
    Ok(())
}

fn grace_expired(detached: Instant, now: Instant) -> bool {
    now.saturating_duration_since(detached) >= REATTACH_GRACE
}

#[cfg(test)]
mod catalog_tests {
    use super::*;
    #[test]
    fn output_ring_and_cursor_reads_are_bounded_and_report_lost_prefix() {
        let mut history = History::default();
        history.append(&vec![b'a'; MAX_HISTORY + 100]);
        history.append(b"recent");
        assert_eq!(history.bytes.len(), MAX_HISTORY);
        let page = history.read(Some(0), 1024).unwrap();
        assert_eq!(page["truncated"], true);
        assert_eq!(page["hasMore"], true);
        assert_eq!(
            STANDARD
                .decode(page["deltaBase64"].as_str().unwrap())
                .unwrap()
                .len(),
            1024
        );
        let tail = history.read(None, 6).unwrap();
        assert_eq!(
            STANDARD
                .decode(tail["deltaBase64"].as_str().unwrap())
                .unwrap(),
            b"recent"
        );
        assert_eq!(tail["cursor"], history.cursor);
        assert!(history.read(Some(history.cursor + 1), 1).is_err());
        assert!(history.read(None, MAX_READ + 1).is_err());
        assert!(history.read(None, 0).is_err());
    }
    #[test]
    fn disconnected_grace_is_bounded_to_five_minutes_without_extension_by_output() {
        let detached = Instant::now();
        assert!(!grace_expired(
            detached,
            detached + Duration::from_secs(299)
        ));
        assert!(grace_expired(detached, detached + Duration::from_secs(300)));
        assert!(grace_expired(detached, detached + Duration::from_secs(999)));
        let mut history = History::default();
        history.append(b"offline output");
        assert!(
            grace_expired(detached, detached + Duration::from_secs(300)),
            "output cannot renew the detach timer"
        );
    }
    #[tokio::test]
    async fn subscriber_reconnect_requires_current_same_viewer_link_and_scoped_terminal_grant() {
        let mut f = super::super::threads::tests::fixture("terminal.open");
        f.inner
            .lock()
            .devices
            .get_mut(&f.stamp.device)
            .unwrap()
            .grant
            .as_mut()
            .unwrap()
            .capabilities
            .terminal = true;
        let (old, _old_wire) = super::super::session_catalog::tests::link(&f.inner, &mut f.stamp);
        let (r, _) = super::route_tests::route(f.stamp.clone(), &f.path, "stable", b"");
        f.inner.lock().terminals.routes.insert("stable".into(), r);
        f.inner.lock().terminals.subscribers.insert(
            (f.stamp.device.clone(), "stable".into()),
            subscriber(f.stamp.clone(), old.id, 5),
        );
        assert!(allowed(&f.inner.lock(), &old, "stable"));
        disconnected(&mut f.inner.lock(), &f.stamp.device);
        assert!(!allowed(&f.inner.lock(), &old, "stable"));
        let (new, _new_wire) = super::super::session_catalog::tests::link(&f.inner, &mut f.stamp);
        f.inner.lock().terminals.subscribers.insert(
            (f.stamp.device.clone(), "stable".into()),
            subscriber(f.stamp.clone(), new.id, 10),
        );
        assert!(allowed(&f.inner.lock(), &new, "stable"));
        assert!(
            !allowed(&f.inner.lock(), &old, "stable"),
            "stale TLS stream can never consume a reattached session"
        );
        let mut core = f.inner.lock();
        core.devices
            .get_mut(&f.stamp.device)
            .unwrap()
            .grant
            .as_mut()
            .unwrap()
            .scope = store::GrantScope::Projects {
            project_ids: vec!["outside".into()],
        };
        assert!(!allowed(&core, &new, "stable"));
        invalidate(&mut core, Some(&f.stamp.device));
        assert!(core.terminals.subscribers.is_empty());
    }
    #[tokio::test]
    async fn ack_is_workspace_bound_and_credit_cannot_ack_future_output_or_grow_unbounded() {
        let mut f = super::super::threads::tests::fixture("terminal.open");
        f.inner
            .lock()
            .devices
            .get_mut(&f.stamp.device)
            .unwrap()
            .grant
            .as_mut()
            .unwrap()
            .capabilities
            .terminal = true;
        let (link, _wire) = super::super::session_catalog::tests::link(&f.inner, &mut f.stamp);
        let (r, _) = super::route_tests::route(f.stamp.clone(), &f.path, "stable", b"");
        f.inner.lock().terminals.routes.insert("stable".into(), r);
        f.inner.lock().terminals.subscribers.insert(
            (f.stamp.device.clone(), "stable".into()),
            subscriber(f.stamp.clone(), link.id, 0),
        );
        publish(
            &mut f.inner.lock(),
            "stable",
            1,
            json!({"deltaBase64":"x".repeat(87384)}),
        );
        assert!(ack(
            &f.inner,
            &link,
            &json!({"terminalId":"stable","workspaceId":"outside","through":1})
        )
        .is_err());
        assert!(ack(
            &f.inner,
            &link,
            &json!({"terminalId":"stable","workspaceId":"p","through":2})
        )
        .is_err());
        assert!(ack(
            &f.inner,
            &link,
            &json!({"terminalId":"stable","workspaceId":"p","through":1})
        )
        .is_ok());
        let key = (f.stamp.device.clone(), "stable".into());
        assert_eq!(f.inner.lock().terminals.subscribers[&key].bytes, 0);
        publish(
            &mut f.inner.lock(),
            "stable",
            2,
            json!({"deltaBase64":"x".repeat(87384)}),
        );
        publish(
            &mut f.inner.lock(),
            "stable",
            3,
            json!({"deltaBase64":"x".repeat(87384)}),
        );
        assert!(
            !f.inner.lock().terminals.subscribers.contains_key(&key),
            "a slow reader is detached instead of growing queues or killing local commands"
        );
    }
    #[test]
    fn terminal_status_keeps_exit_code_command_and_frozen_elapsed_time() {
        let h = History {
            exit_code: Some(7),
            ended_at: Some(1500),
            ..History::default()
        };
        let row = status("id", "echo failed", 1000, false, "exited", false, true, &h);
        assert_eq!(row["exitCode"], 7);
        assert_eq!(row["elapsedMs"], 500);
        assert_eq!(row["command"], "echo failed");
        assert_eq!(row["running"], false);
        assert!(row.get("processId").is_none());
        assert!(row.get("root").is_none());
    }
}

#[cfg(test)]
pub(super) mod route_tests {
    use super::*;
    pub(in crate::remote) fn route(
        stamp: Stamp,
        root: &std::path::Path,
        id: &str,
        text: &[u8],
    ) -> (Arc<Route>, Arc<AtomicBool>) {
        let finished = Arc::new(AtomicBool::new(false));
        let stopped = Arc::new(AtomicBool::new(false));
        let mut history = History::default();
        history.append(text);
        (
            Arc::new(Route {
                id: id.into(),
                command: "echo tracked".into(),
                started_at: 1000,
                stamp,
                runtime: TerminalRuntime::Fixture {
                    stopped: stopped.clone(),
                    finished: finished.clone(),
                },
                anchor: Anchor::open(root).unwrap(),
                alive: AtomicBool::new(true),
                finished,
                started: AtomicBool::new(true),
                notify: Notify::new(),
                history: std::sync::Mutex::new(history),
                detached: std::sync::Mutex::new(None),
            }),
            stopped,
        )
    }
    fn install(f: &mut super::super::threads::tests::Fixture) {
        let db = std::mem::replace(&mut f.db, rusqlite::Connection::open_in_memory().unwrap());
        f.inner.install_test_database(db).unwrap();
    }
    #[tokio::test]
    async fn native_catalog_is_scoped_bounded_and_reattaches_retained_output_after_viewer_restart()
    {
        let mut f = super::super::threads::tests::fixture("terminal.open");
        f.inner
            .lock()
            .devices
            .get_mut(&f.stamp.device)
            .unwrap()
            .grant
            .as_mut()
            .unwrap()
            .capabilities
            .terminal = true;
        let (old, _old_wire) = super::super::session_catalog::tests::link(&f.inner, &mut f.stamp);
        let (tracked, stopped) = route(
            f.stamp.clone(),
            &f.path,
            "remote-terminal-stable",
            b"before",
        );
        let mut hidden_stamp = f.stamp.clone();
        hidden_stamp.workspace_id = Some("outside".into());
        let (hidden, _) = route(
            hidden_stamp,
            &f.path,
            "remote-terminal-hidden",
            b"DO-NOT-DISCLOSE",
        );
        {
            let mut core = f.inner.lock();
            core.terminals
                .routes
                .insert(tracked.id.clone(), tracked.clone());
            core.terminals.routes.insert(hidden.id.clone(), hidden);
        }
        install(&mut f);
        let list = catalog(&f.inner, &old, "terminal.list", json!({"workspaceId":"p"}))
            .await
            .unwrap();
        assert_eq!(list["terminals"].as_array().unwrap().len(), 1);
        assert!(!list.to_string().contains("hidden"));
        assert!(!list.to_string().contains("DO-NOT"));
        assert!(catalog(
            &f.inner,
            &old,
            "terminal.status",
            json!({"workspaceId":"p","terminalId":"remote-terminal-hidden"})
        )
        .await
        .is_err());
        assert!(catalog(
            &f.inner,
            &old,
            "terminal.read",
            json!({"workspaceId":"outside","terminalId":"remote-terminal-hidden"})
        )
        .await
        .is_err());
        disconnected(&mut f.inner.lock(), &f.stamp.device);
        assert!(tracked.alive.load(Ordering::Acquire));
        assert!(!stopped.load(Ordering::Acquire));
        tracked.history.lock().unwrap().append(b"-while-away");
        let (new, mut wire) = super::super::session_catalog::tests::link(&f.inner, &mut f.stamp);
        let attached = catalog(
            &f.inner,
            &new,
            "terminal.attach",
            json!({"workspaceId":"p","terminalId":tracked.id,"limit":65536}),
        )
        .await
        .unwrap();
        assert_eq!(
            STANDARD
                .decode(attached["deltaBase64"].as_str().unwrap())
                .unwrap(),
            b"before-while-away"
        );
        assert_eq!(attached["seq"], 2);
        assert!(tracked.detached.lock().unwrap().is_none());
        assert!(allowed(&f.inner.lock(), &new, &tracked.id));
        assert!(!allowed(&f.inner.lock(), &old, &tracked.id));
        let seq = {
            let mut h = tracked.history.lock().unwrap();
            h.append(b"-live");
            h.seq
        };
        publish(
            &mut f.inner.lock(),
            &tracked.id,
            seq,
            json!({"terminalId":tracked.id,"deltaBase64":STANDARD.encode(b"-live")}),
        );
        // Keepalive pings can arrive first when the suite is under load; skip them.
        let (bytes, event) = loop {
            let bytes = super::super::wire::read_frame(
                &mut wire,
                super::super::wire::MAX_FRAME,
                Duration::from_secs(3),
            )
            .await
            .unwrap();
            let event: Frame = serde_json::from_slice(&bytes).unwrap();
            if !matches!(event, Frame::Ping { .. }) {
                break (bytes, event);
            }
        };
        assert!(matches!(event, Frame::Evt { seq: 3, .. }), "got {:?}", String::from_utf8_lossy(&bytes));
        assert!(catalog(
            &f.inner,
            &new,
            "terminal.read",
            json!({"workspaceId":"p","terminalId":tracked.id,"limit":65537})
        )
        .await
        .is_err());
        {
            let mut core = f.inner.lock();
            for i in 0..40 {
                let (r, _) = route(
                    f.stamp.clone(),
                    &f.path,
                    &format!("remote-terminal-{i}"),
                    b"",
                );
                core.terminals.routes.insert(r.id.clone(), r);
            }
        }
        let list = catalog(&f.inner, &new, "terminal.list", json!({"workspaceId":"p"}))
            .await
            .unwrap();
        assert_eq!(list["terminals"].as_array().unwrap().len(), 32);
        assert_eq!(list["truncated"], true);
    }
    #[tokio::test]
    async fn another_viewer_cannot_reattach_a_remote_owned_pty_even_in_the_same_project() {
        let mut f = super::super::threads::tests::fixture("terminal.open");
        f.inner
            .lock()
            .devices
            .get_mut(&f.stamp.device)
            .unwrap()
            .grant
            .as_mut()
            .unwrap()
            .capabilities
            .terminal = true;
        let (link, _wire) = super::super::session_catalog::tests::link(&f.inner, &mut f.stamp);
        let mut other = f.stamp.clone();
        other.device = "another-owner".into();
        let (r, _) = route(other, &f.path, "remote-terminal-other", b"scoped output");
        f.inner.lock().terminals.routes.insert(r.id.clone(), r);
        install(&mut f);
        let read = catalog(
            &f.inner,
            &link,
            "terminal.read",
            json!({"workspaceId":"p","terminalId":"remote-terminal-other"}),
        )
        .await
        .unwrap();
        assert_eq!(read["owned"], false);
        assert_eq!(read["attachable"], false);
        assert!(catalog(
            &f.inner,
            &link,
            "terminal.attach",
            json!({"workspaceId":"p","terminalId":"remote-terminal-other"})
        )
        .await
        .is_err());
    }
    #[tokio::test]
    async fn expired_grace_cancels_owned_runtime_and_revocation_forget_hosting_stop_cancel_immediately(
    ) {
        let mut f = super::super::threads::tests::fixture("terminal.open");
        f.inner
            .lock()
            .devices
            .get_mut(&f.stamp.device)
            .unwrap()
            .grant
            .as_mut()
            .unwrap()
            .capabilities
            .terminal = true;
        let (_link, _wire) = super::super::session_catalog::tests::link(&f.inner, &mut f.stamp);
        let (expired, stopped) = route(f.stamp.clone(), &f.path, "remote-terminal-expired", b"");
        *expired.detached.lock().unwrap() =
            Some(Instant::now() - REATTACH_GRACE - Duration::from_secs(1));
        watch(f.inner.clone(), expired.id.clone(), expired).await;
        for _ in 0..100 {
            if stopped.load(Ordering::Acquire) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
        assert!(stopped.load(Ordering::Acquire));
        for cause in ["scope", "revoke", "forget", "hosting", "generation"] {
            let (r, stopped) = route(
                f.stamp.clone(),
                &f.path,
                &format!("remote-terminal-{cause}"),
                b"",
            );
            {
                let mut core = f.inner.lock();
                core.terminals.routes.insert(r.id.clone(), r.clone());
                match cause {
                    "scope" => {
                        core.devices
                            .get_mut(&f.stamp.device)
                            .unwrap()
                            .grant
                            .as_mut()
                            .unwrap()
                            .scope = store::GrantScope::Projects {
                            project_ids: vec![],
                        };
                        hostbridge::retire_device_locked(&f.inner, &mut core, &f.stamp.device);
                    }
                    "revoke" => {
                        core.devices.get_mut(&f.stamp.device).unwrap().grant = None;
                        hostbridge::retire_device_locked(&f.inner, &mut core, &f.stamp.device);
                    }
                    "forget" => {
                        core.devices.remove(&f.stamp.device);
                        hostbridge::retire_device_locked(&f.inner, &mut core, &f.stamp.device);
                    }
                    "hosting" => {
                        core.settings.hosting = false;
                        hostbridge::hosting_stopped_locked(&f.inner, &mut core);
                    }
                    _ => {
                        invalidate(&mut core, None);
                    }
                }
                assert!(
                    !r.alive.load(Ordering::Acquire),
                    "{cause}: no five-minute grace for authority loss"
                );
                assert!(!core.terminals.routes.contains_key(&r.id));
            }
            for _ in 0..100 {
                if stopped.load(Ordering::Acquire) {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(2)).await;
            }
            assert!(stopped.load(Ordering::Acquire), "{cause}");
            // Restore the paired fixture for the next authority loss.
            if cause == "forget" {
                let mut grant = store::DeviceGrant::initial();
                grant.work = true;
                grant.capabilities.terminal = true;
                f.inner.lock().devices.insert(
                    f.stamp.device.clone(),
                    store::DeviceRecord {
                        fingerprint: f.stamp.device.clone(),
                        spki: vec![7; 32],
                        name: "fixture".into(),
                        platform: None,
                        addresses: vec![],
                        they_host: false,
                        access_removed: false,
                        paired_at: 0,
                        last_seen_at: None,
                        grant: Some(grant),
                    },
                );
            } else if let Some(record) = f.inner.lock().devices.get_mut(&f.stamp.device) {
                let mut grant = store::DeviceGrant::initial();
                grant.work = true;
                grant.capabilities.terminal = true;
                record.grant = Some(grant);
            }
        }
    }
}
