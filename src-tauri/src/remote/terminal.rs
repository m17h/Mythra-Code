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
        STANDARD.encode(script.encode_utf16().flat_map(u16::to_le_bytes).collect::<Vec<_>>())
    };
    let direct = encode(format!("$ErrorActionPreference='Stop';$command='{}'{start}", command.replace('\'', "''")));
    let nested = encode(format!("$ErrorActionPreference='Stop';$command=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('{}')){start}", STANDARD.encode(command.as_bytes())));
    let encoded = if direct.len() <= nested.len() { direct } else { nested };
    if encoded.len() > 30_000 {
        return Err(work::refused("invalid"));
    }
    Ok(json!(["powershell.exe", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded]))
}

#[derive(Default)]
pub(super) struct Registry {
    routes: HashMap<String, Arc<Route>>,
    local:HashMap<String,LocalSummary>,
}
pub(super) struct Route {
    id: String,
    command:String,
    started_at:i64,
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
    // Encoding/length failure is a definite pre-dispatch refusal: no route,
    // provider startup or dispatched journal receipt may have been created yet.
    let argv = terminal_argv(&command)?;
    let anchor = super::studio::blocking(move || Anchor::open(std::path::Path::new(&root))).await?;
    let server = crate::ensure_server(&app, &app.state::<crate::RuntimeState>()).await?;
    let id = format!("remote-terminal-{}", uuid::Uuid::new_v4());
    let route = Arc::new(Route {
        id: id.clone(),command:command.clone(),started_at:crate::unix_timestamp_ms(),
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

struct LocalSummary{id:String,root_identity:String,command:String,started_at:i64,proof:Arc<super::owners::EngineCommand>}
/// Tracking only. Invalid metadata/full registry never changes a local command.
pub(crate) fn observe_local(app:&AppHandle,proof:Arc<super::owners::EngineCommand>,params:&Value){
 if params["tty"]!=true||proof.process.starts_with("remote-terminal-"){return;}
 let Some(cwd)=params["cwd"].as_str()else{return;};let Ok(anchor)=Anchor::open(std::path::Path::new(cwd))else{return;};let Ok(identity)=anchor.identity()else{return;};
 let Some(argv)=params["command"].as_array()else{return;};
 let label=if argv.len()>=3&&matches!(argv[0].as_str(),Some("/bin/zsh"|"/bin/bash"|"cmd.exe"|"powershell.exe")){argv.last().and_then(Value::as_str).unwrap_or("").to_owned()}else{argv.iter().filter_map(Value::as_str).collect::<Vec<_>>().join(" ")};
 let state=app.state::<RemoteState>();let mut core=state.inner.lock();
 if core.terminals.local.len()>=64{let old=core.terminals.local.iter().filter(|(_,s)|super::owners::command_state(&s.proof)=="completed").min_by_key(|(_,s)|s.started_at).map(|(k,_)|k.clone());if let Some(id)=old{core.terminals.local.remove(&id);}else{return;}}
 let id=uuid::Uuid::new_v4().to_string();core.terminals.local.insert(id.clone(),LocalSummary{id,root_identity:identity,command:label.chars().take(512).collect(),started_at:crate::unix_timestamp_ms(),proof});
}
#[tauri::command]
pub(crate) async fn remote_terminal_list(app:AppHandle,state:State<'_,RemoteState>,window:WebviewWindow,generation:u64,device:String,grant_revision:u64,workspace_id:String,root:String)->Result<Value,String>{
 hostbridge::window_is_host(&window).map_err(|_|stale())?;super::studio::check_scope(&state,generation,&device,grant_revision,Some(&workspace_id),false)?;
 let inner=state.inner.clone();let worker=inner.clone();
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
   terminals.push(json!({"terminalId":if owned{route.id.clone()}else{format!("read-only:{}",route.id)},"command":route.command.chars().take(512).collect::<String>(),"state":if route.finished.load(Ordering::Acquire){"completed"}else if !route.alive.load(Ordering::Acquire){"stopping"}else if route.started.load(Ordering::Acquire){"running"}else{"starting"},"startedAt":route.started_at,"threadId":route.stamp.thread_id,"seq":route.credit.lock().unwrap_or_else(std::sync::PoisonError::into_inner).seq,"owned":owned}));
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
            ("echo native-terminal && exit /b 7".to_owned(), "0b63392821f78bdbaaae8ef75a792c3e6cbb3557c94e042b3dc6fff01cd865ad", false),
            ("cd /d \"é quoted & spaced\" && type \"file name.txt\" && exit /b 7".to_owned(), "0f88a40053de6cf8ddd06b94989e7b1d9ac42fc6d56579aa953e38d5f15e9b1b", false),
            ("echo 'apostrophe' \"quote\" 😀\r\nexit /b 7".to_owned(), "626251440b9d6253e97456220bd75b1aea715326c105270a85fa959fe81e2c97", false),
            ("'".repeat(4096), "33a3dc592238f02dd50fde6f4919a1b7471c130ce619c66ef3ee3cee4eba8b22", true),
        ] {
            let argv = windows_terminal_argv(&command).unwrap();
            assert_eq!(argv.as_array().unwrap().len(), 5);
            assert_eq!(argv[0], "powershell.exe");
            assert_eq!(argv[1], "-NoProfile");
            assert_eq!(argv[2], "-NonInteractive");
            assert_eq!(argv[3], "-EncodedCommand");
            let bytes = STANDARD.decode(argv[4].as_str().unwrap()).unwrap();
            assert_eq!(format!("{:x}", Sha256::digest(&bytes)), expected);
            let script = String::from_utf16(&bytes.chunks_exact(2).map(|b| u16::from_le_bytes([b[0], b[1]])).collect::<Vec<_>>()).unwrap();
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
        assert_eq!(terminal_argv(command).unwrap(), json!(["/bin/zsh", "-lc", command]));
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
