//! Remote mutation admission and durable native delivery fences. No provider
//! payloads, prompt text, question answers or credentials are persisted here.
use super::{
    finish_write, hostbridge,
    session::Link,
    store::{self, DeviceGrant, GrantScope, JournalClaim},
    wire::WireError,
    Core, Inner, RemoteState,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    future::Future,
    sync::{Arc, Mutex as StdMutex, PoisonError},
    task::Poll,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager, State, WebviewWindow};
use tokio::sync::Notify;

pub(super) const MUTATIONS: &[&str] = &[
    "prompt.send",
    "prompt.queue",
    "prompt.steer",
    "turn.stop",
    "approval.answer",
    "question.answer",
];
pub(super) fn is_mutation(op: &str) -> bool {
    MUTATIONS.contains(&op) || super::manifest::mutation(op)
}
fn invalid() -> WireError {
    WireError::new("invalid", "That remote request is not valid.")
}
fn unavailable() -> WireError {
    WireError::new(
        "host_unavailable",
        "The host is recovering. Try again shortly.",
    )
}
pub(crate) fn refused(code: &str) -> String {
    format!("MYTHRA_REMOTE_REJECTED:{code}: This instruction was not delivered.")
}
fn internal() -> WireError {
    WireError::new("internal", "The host could not save its delivery record.")
}

pub(super) struct Flight {
    digest: String,
    seq: u64,
    result: StdMutex<Option<Result<Value, WireError>>>,
    changed: Notify,
}
#[derive(Default)]
pub(super) struct WorkState {
    flights: HashMap<(String, String), Arc<Flight>>,
    pub(super) targets: HashMap<String, Target>,
    tickets: HashMap<String, bool>,
    stops: HashMap<String, (String, String)>,
    cancelled: std::collections::HashSet<(String,String)>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RemoteDelivery {
    #[serde(default)]
    pub(crate) owner_handle: Option<String>,
    pub(crate) generation: u64,
    pub(crate) device: String,
    pub(crate) op_id: String,
    pub(crate) op_seq: u64,
    #[serde(default)]
    pub(crate) attempt_id: Option<String>,
    #[serde(default)]
    pub(crate) message_id: Option<String>,
}
impl RemoteDelivery {
    fn valid(&self) -> bool {
        self.owner_handle.as_ref().is_none_or(|handle|uuid::Uuid::parse_str(handle).is_ok()) && super::identity::fingerprint_is_valid(&self.device)
            && !self.op_id.is_empty()
            && self.op_id.len() <= 256
            && self.op_seq > 0
            && self.op_seq <= super::timeline::MAX_SAFE_SEQ
    }
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Target {
    #[serde(default)]
    pub(crate) owner_handle: Option<String>,
    pub(crate) generation: u64,
    pub(crate) device: String,
    pub(crate) kind: String,
    pub(crate) thread_id: Option<String>,
    pub(crate) workspace_id: Option<String>,
    pub(crate) provider: Option<String>,
    pub(crate) request_id: Option<Value>,
    pub(crate) method: Option<String>,
    pub(crate) turn_id: Option<String>,
    pub(crate) item_id: Option<String>,
    pub(crate) start_request_id: Option<String>,
    pub(crate) agent_run_id: Option<String>,
    pub(crate) attempt_id: Option<String>,
    pub(crate) parent_run_id: Option<String>,
    #[serde(skip)]
    pub(crate) revision: u64,
    #[serde(skip)]
    pub(crate) owner: String,
    #[serde(skip)]
    pub(crate) expires: Option<Instant>,
    #[serde(skip)]
    pub(crate) claimed: Option<(String, String)>,
}
fn generation(core: &Core, meta: &RemoteDelivery) -> Result<(), WireError> {
    hostbridge::check_generation(core, meta.generation)
}
pub(super) fn grant_locked(core: &Core, device: &str) -> Option<DeviceGrant> {
    core.settings
        .hosting
        .then(|| core.devices.get(device)?.grant.clone())
        .flatten()
}
pub(super) fn authorize(
    core: &Core,
    meta: &RemoteDelivery,
    workspace: Option<&str>,
) -> Result<DeviceGrant, WireError> {
    generation(core, meta)?;
    let grant = grant_locked(core, &meta.device)
        .filter(|g| g.view && g.work)
        .ok_or_else(|| WireError::new("forbidden", "Work is no longer allowed for this device."))?;
    if let GrantScope::Projects { project_ids } = &grant.scope {
        if !workspace.is_some_and(|id| project_ids.iter().any(|allowed| allowed == id)) {
            return Err(WireError::new(
                "forbidden",
                "This project is no longer shared for work.",
            ));
        }
    }
    Ok(grant)
}
pub(super) fn validate_args(op: &str, args: &Value) -> Result<(), WireError> {
    if super::manifest::validate(op, args)? {
        return Ok(());
    }
    let object = args.as_object().ok_or_else(invalid)?;
    if op=="prompt.send"&&args.get("draftHandle").is_some()&&args.get("workspaceId").is_none(){return Err(invalid());}
    let extra: &[&str] = match op {
        "prompt.send" => &["threadId", "workspaceId", "text", "draftHandle", "attachmentIds"],
        "prompt.queue" => &["threadId", "workspaceId", "text", "attachmentIds"],
        "prompt.steer" => &["threadId", "handle", "target", "text"],
        "turn.stop" => &["threadId", "handle", "target"],
        "approval.answer" => &["threadId", "handle", "target", "decision"],
        "question.answer" => &["threadId", "handle", "target", "answers", "cancel"],
        _ => return Err(invalid()),
    };
    if object
        .keys()
        .any(|key| !["opId", "opSeq"].contains(&key.as_str()) && !extra.contains(&key.as_str()))
    {
        return Err(invalid());
    }
    if !args
        .get("opId")
        .and_then(Value::as_str)
        .is_some_and(|id| !id.is_empty() && id.len() <= 256)
        || !args
            .get("opSeq")
            .and_then(Value::as_u64)
            .is_some_and(|seq| seq > 0 && seq <= super::timeline::MAX_SAFE_SEQ)
    {
        return Err(invalid());
    }
    for field in ["threadId", "workspaceId", "handle", "target", "draftHandle"] {
        if let Some(value) = args.get(field) {
            if !value.as_str().is_some_and(|text| {
                !text.is_empty() && text.len() <= 512 && !text.chars().any(char::is_control)
            }) {
                return Err(invalid());
            }
        }
    }
    if op == "prompt.send" {
        if args.get("threadId").is_some() == args.get("workspaceId").is_some() {
            return Err(invalid());
        }
    } else if args.get("threadId").is_none() {
        return Err(invalid());
    }
    if let Some(ids)=args.get("attachmentIds"){let ids=ids.as_array().ok_or_else(invalid)?;let mut seen=std::collections::HashSet::new();if ids.len()>20||ids.iter().any(|id|!id.as_str().is_some_and(|id|uuid::Uuid::parse_str(id).is_ok()&&seen.insert(id))){return Err(invalid());}}
    if op.starts_with("prompt.")
        && !args
            .get("text")
            .and_then(Value::as_str)
            .is_some_and(|text| !text.trim().is_empty() && text.chars().count() <= 256 * 1024)
    {
        return Err(invalid());
    }
    if !["prompt.send", "prompt.queue"].contains(&op)
        && (args.get("handle").is_some() == args.get("target").is_some())
    {
        return Err(invalid());
    }
    if op == "approval.answer"
        && !args
            .get("decision")
            .and_then(Value::as_str)
            .is_some_and(|choice| ["allowOnce", "deny"].contains(&choice))
    {
        return Err(invalid());
    }
    if op == "question.answer" {
        if args.get("cancel") == Some(&json!(true)) {
            if args.get("answers").is_some() {
                return Err(invalid());
            }
        } else {
            let answers = args
                .get("answers")
                .and_then(Value::as_object)
                .ok_or_else(invalid)?;
            if answers.len() > 64
                || answers.iter().any(|(key, value)| {
                    key.len() > 256
                        || !value.as_array().is_some_and(|values| {
                            values.len() <= 64
                                && values.iter().all(|value| {
                                    value.as_str().is_some_and(|text| text.len() <= 65536)
                                })
                        })
                })
            {
                return Err(invalid());
            }
        }
        if serde_json::to_vec(&args).map_or(true, |bytes| bytes.len() > 256 * 1024) {
            return Err(invalid());
        }
    }
    Ok(())
}

pub(super) async fn handle_request(
    inner: &Arc<Inner>,
    link: &Arc<Link>,
    op: &str,
    args: Value,
) -> Result<Value, WireError> {
    validate_args(op, &args)?;
    let id = args["opId"].as_str().ok_or_else(invalid)?.to_owned();
    let seq = args["opSeq"].as_u64().ok_or_else(invalid)?;
    let digest = store::request_digest(op, &args);
    let key = (link.peer_fingerprint.clone(), id.clone());
    let (flight, new) = {
        let mut core = inner.lock();
        let grant = hostbridge::authorize(&core, link)?;
        super::manifest::access(op, &grant)?;
        if !grant.work {
            return Err(WireError::new(
                "forbidden",
                "Turn on Work for this device on the host.",
            ));
        }
        if let Some(flight) = core.work.flights.get(&key) {
            if flight.digest != digest || flight.seq != seq {
                return Err(invalid());
            }
            (flight.clone(), false)
        } else {
            if core.work.flights.len() >= 512 {
                return Err(WireError::new("busy", "Too many instructions are waiting."));
            }
            let flight = Arc::new(Flight {
                digest: digest.clone(),
                seq,
                result: StdMutex::new(None),
                changed: Notify::new(),
            });
            core.work.flights.insert(key.clone(), flight.clone());
            (flight, true)
        }
    };
    if new {
        let inner = inner.clone();
        let link = link.clone();
        let op = op.to_owned();
        let flight = flight.clone();
        let key = key.clone();
        tauri::async_runtime::spawn(async move {
            let outcome = execute(&inner, &link, &op, args, &id, seq, &digest).await;
            *flight.result.lock().unwrap_or_else(PoisonError::into_inner) = Some(outcome);
            flight.changed.notify_waiters();
            inner.lock().work.flights.remove(&key);
        });
    }
    tokio::time::timeout(Duration::from_secs(25), async {
        loop {
            let changed = flight.changed.notified();
            tokio::pin!(changed);
            changed.as_mut().enable();
            if let Some(result) = flight
                .result
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .clone()
            {
                return result;
            }
            changed.await;
        }
    })
    .await
    .unwrap_or_else(|_| Err(unavailable()))
}
async fn execute(
    inner: &Arc<Inner>,
    link: &Arc<Link>,
    op: &str,
    args: Value,
    id: &str,
    seq: u64,
    digest: &str,
) -> Result<Value, WireError> {
    let attachment_ids=args.get("attachmentIds").cloned();
    let saved = {
        let core = inner.lock();
        let grant = hostbridge::authorize(&core, link)?;
        super::manifest::access(op, &grant)?;
        if !grant.work {
            return Err(WireError::new("forbidden", "Work is no longer allowed."));
        }
        let (device, id, op, digest) = (
            link.peer_fingerprint.clone(),
            id.to_owned(),
            op.to_owned(),
            digest.to_owned(),
        );
        inner.enqueue_write(false, move |db| {
            let claim=store::claim_operation(db, &device, &id, seq, &op, &digest).map_err(|_| "The instruction could not be admitted.".to_string())?;
            if matches!(claim,JournalClaim::Claimed){if let Some(ids)=attachment_ids{db.execute("UPDATE remote_op_journal SET attachments_json=?4 WHERE device_fingerprint=?1 AND op_id=?2 AND op_seq=?3",rusqlite::params![device,id,seq as i64,ids.to_string()]).map_err(|_|"The attachment identity could not be saved.".to_string())?;}}
            Ok(claim)
        })
    };
    match finish_write(saved).await.map_err(|_| internal())? {
        JournalClaim::Existing(_) => {
            let device = link.peer_fingerprint.clone();
            let id = id.to_owned();
            return inner
                .read_db(move |db| store::operation_result(db, &device, &id))
                .await
                .map_err(|_| internal());
        }
        JournalClaim::DigestMismatch => return Err(invalid()),
        JournalClaim::Expired => {
            return Ok(
                json!({"opId":id,"state":"uncertain","error":{"code":"expired","message":"Check the conversation before sending again."}}),
            )
        }
        JournalClaim::Busy => {
            return Err(WireError::new(
                "busy",
                "The host's delivery history is full. Resolve unconfirmed instructions first.",
            ))
        }
        JournalClaim::Claimed => {}
    }
    let response = if op=="attachment.put" {
        let stamp={let core=inner.lock();let grant=hostbridge::authorize(&core,link)?;super::commit::Stamp{generation:core.bridge.generation,device:link.peer_fingerprint.clone(),grant_revision:grant.revision,op_id:id.to_owned(),op_seq:seq,workspace_id:args.get("workspaceId").and_then(Value::as_str).map(str::to_owned),thread_id:None}};
        super::attachments::put(inner,stamp,args).await.map_err(|_|WireError::new("internal","The host could not confirm this upload. Check the attachment before trying again."))
    }else{hostbridge::request_value(inner, link, op, args, Some((id, seq))).await};
    let result = match response {
        Ok(value) => value,
        Err(error) => {
            let (device, operation) = (link.peer_fingerprint.clone(), id.to_owned());
            let receipt = inner
                .read_db(move |db| store::delivery_receipt(db, &device, &operation, seq))
                .await;
            let not_dispatched = matches!(&receipt, Ok(None))
                || matches!(&receipt,Ok(Some(receipt))if matches!(receipt.get("disposition").and_then(Value::as_str),Some("preparing"|"queued"|"rejected")));
            let definitive = not_dispatched
                && [
                    "forbidden",
                    "unsupported",
                    "invalid",
                    "busy",
                    "rate_limited",
                    "stale_target",
                    "not_paired",
                    "thread_unavailable",
                ]
                .contains(&error.code.as_str());
            json!({"opId":id,"state":if definitive{"rejected"}else{"uncertain"},"error":{"code":error.code,"message":"Check the conversation before sending again."}})
        }
    };
    // Persist only the narrow result, never a host renderer's arbitrary JSON.
    let mut safe = json!({"opId":id,"state":result.get("state").and_then(Value::as_str).filter(|state|["accepted","queued","rejected","uncertain"].contains(state)).unwrap_or("uncertain")});
    for key in [
        "threadId",
        "turnId",
        "queuedTurnId",
        "messageId",
        "attemptId",
        "workspaceId",
        "workflowRunId",
        "editHandle",
        "uploadId",
        "attachmentId",
        "name",
        "kind",
        "terminalId",
        "draftHandle",
        "startTarget",
    ] {
        if let Some(value) = result
            .get(key)
            .and_then(Value::as_str)
            .filter(|text| text.len() <= 512)
        {
            safe[key] = json!(value);
        }
    }
    for key in ["nextOffset","size"] {if let Some(n)=result.get(key).and_then(Value::as_u64).filter(|n|*n<=50*1024*1024){safe[key]=json!(n);}}
    if op=="draft.settings.set"{if let Some(settings)=result.get("settings").filter(|v|v.is_object()){
        let mut check=settings.clone();check["opId"]=json!(id);check["opSeq"]=json!(seq);check["workspaceId"]=result.get("workspaceId").cloned().unwrap_or(json!("draft"));
        if super::manifest::validate("draft.settings.set",&check).is_ok(){safe["settings"]=settings.clone();}
    }}
    // Project registration is App-owned. If its durable adapter supplies the
    // explicit public projection, retain it for retries after folder expiry.
    if op == "projects.add" && safe.get("state").and_then(Value::as_str) == Some("accepted") {
        if let (Some(workspace), Some(workspace_id)) = (
            result.get("workspace"),
            safe.get("workspaceId").and_then(Value::as_str),
        ) {
            if workspace.get("id").and_then(Value::as_str) == Some(workspace_id)
                && workspace.get("isChat").and_then(Value::as_bool) == Some(false)
            {
                if let Some(name) = workspace
                    .get("name")
                    .and_then(Value::as_str)
                    .filter(|name| {
                        !name.is_empty() && name.len() <= 512 && !name.chars().any(char::is_control)
                    })
                {
                    safe["workspace"] = json!({"id":workspace_id,"name":name,"isChat":false});
                }
            }
        }
    }
    if let Some(code) = result
        .pointer("/error/code")
        .and_then(Value::as_str)
        .filter(|text| text.len() <= 64)
    {
        safe["error"] = json!({"code":code,"message":"The host could not confirm this instruction. Check the conversation."});
    }
    let saved = {
        let _core = inner.lock();
        let (device, id, value) = (link.peer_fingerprint.clone(), id.to_owned(), safe.clone());
        inner.enqueue_write(false, move |db| {
            store::save_operation_result(db, &device, &id, seq, &value)
        })
    };
    finish_write(saved).await.map_err(|_| internal())?;
    let (device, id) = (link.peer_fingerprint.clone(), id.to_owned());
    inner
        .read_db(move |db| store::operation_result(db, &device, &id))
        .await
        .map_err(|_| internal())
}

#[tauri::command]
pub(crate) fn remote_work_grant(
    state: State<'_, RemoteState>,
    window: WebviewWindow,
    generation: u64,
    device: String,
) -> Result<Option<DeviceGrant>, WireError> {
    hostbridge::window_is_host(&window)?;
    let core = state.inner.lock();
    hostbridge::check_generation(&core, generation)?;
    Ok(grant_locked(&core, &device))
}
#[tauri::command]
pub(crate) async fn remote_work_receipt(
    state: State<'_, RemoteState>,
    window: WebviewWindow,
    generation: u64,
    device: String,
    op_id: String,
    op_seq: u64,
    disposition: String,
    thread_id: Option<String>,
    workspace_id: Option<String>,
    queued_turn_id: Option<String>,
    message_id: Option<String>,
    attempt_id: Option<String>,
    start_request_id: Option<String>,
    turn_id: Option<String>,
    provider: Option<String>,
    permission: Option<String>,
    error_code: Option<String>,
    stop_handle: Option<String>,
    owner_handle: Option<String>,
) -> Result<(), WireError> {
    hostbridge::window_is_host(&window)?;
    let meta = RemoteDelivery {
        owner_handle:None,
        generation,
        device: device.clone(),
        op_id: op_id.clone(),
        op_seq,
        attempt_id: attempt_id.clone(),
        message_id: message_id.clone(),
    };
    if !meta.valid() {
        return Err(invalid());
    }
    let receipt = json!({"ownerHandle":owner_handle,"generation":generation,"device":device,"opId":op_id,"opSeq":op_seq,"disposition":disposition,"threadId":thread_id,"workspaceId":workspace_id,"queuedTurnId":queued_turn_id,"messageId":message_id,"attemptId":attempt_id,"startRequestId":start_request_id,"turnId":turn_id,"provider":provider,"permission":permission,"errorCode":error_code,"stopHandle":stop_handle});
    if serde_json::to_vec(&receipt).map_or(true, |bytes| bytes.len() > 16384) {
        return Err(invalid());
    }
    let saved = {
        let core = state.inner.lock();
        generation_check(&core, generation)?;
        if ["preparing", "queued", "dispatched"].contains(&disposition.as_str()) {
            authorize(
                &core,
                &meta,
                receipt.get("workspaceId").and_then(Value::as_str),
            )?;
        }
        state.inner.enqueue_write(false, move |db| {
            store::save_delivery_receipt(db, &device, &op_id, op_seq, &receipt)
        })
    };
    finish_write(saved).await.map_err(|_| internal())
}
fn generation_check(core: &Core, generation: u64) -> Result<(), WireError> {
    hostbridge::check_generation(core, generation)
}
#[tauri::command]
pub(crate) async fn remote_work_recover(
    state: State<'_, RemoteState>,
    window: WebviewWindow,
    generation: u64,
    device: String,
    op_id: String,
    op_seq: u64,
) -> Result<Value, WireError> {
    hostbridge::window_is_host(&window)?;
    {
        let core = state.inner.lock();
        generation_check(&core, generation)?;
    }
    let receipt = state
        .inner
        .read_db(move |db| store::delivery_receipt(db, &device, &op_id, op_seq))
        .await
        .map_err(|_| internal())?;
    let mut receipt = receipt.unwrap_or_else(|| json!({"disposition":"uncertain"}));
    if receipt.get("disposition").and_then(Value::as_str) == Some("queued") {
        let device = receipt.get("device").and_then(Value::as_str).unwrap_or("");
        let meta = RemoteDelivery {
        owner_handle:None,
            generation,
            device: device.to_owned(),
            op_id: receipt
                .get("opId")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_owned(),
            op_seq,
            attempt_id: None,
            message_id: None,
        };
        let core = state.inner.lock();
        if receipt.get("ownerHandle").and_then(Value::as_str).is_some_and(|handle|!super::owners::is_open(&core,handle)){
            receipt["disposition"]=json!("uncertain");
        }else if authorize(
            &core,
            &meta,
            receipt.get("workspaceId").and_then(Value::as_str),
        )
        .is_err()
        {
            receipt["disposition"] = json!("rejected");
            receipt["errorCode"] = json!("forbidden");
        }
    } else if receipt.get("disposition").and_then(Value::as_str) != Some("accepted") {
        receipt["disposition"] = json!("uncertain");
    }
    receipt
        .as_object_mut()
        .map(|object| object.remove("nativeSteps"));
    Ok(receipt)
}

/// A prepared, durably latched attempt. Grant validation and actual first poll
/// happen under the same core decision lock after acquiring the provider input
/// lock. No std mutex guard crosses an await. Revocation after this boundary is
/// a dispatched (possibly uncertain) write, never queued work.
pub(crate) struct NativePermit {
    inner: Arc<Inner>,
    meta: RemoteDelivery,
    receipt: Value,
    ticket: String,
    target: Option<String>,
    step: String,
    begun: bool,
}
impl NativePermit {
    pub(crate) fn begin<T>(
        &mut self,
        dispatch: impl FnOnce() -> Result<T, String>,
    ) -> Result<T, String> {
        if self.begun {
            return dispatch();
        }
        let mut core = self.inner.lock();
        let grant = authorize(
            &core,
            &self.meta,
            self.receipt.get("workspaceId").and_then(Value::as_str),
        )
        .map_err(|error| refused(&error.code))?;
        super::manifest::access(
            self.receipt
                .get("op")
                .and_then(Value::as_str)
                .unwrap_or("prompt.send"),
            &grant,
        )
        .map_err(|error| refused(&error.code))?;
        if let Some(op)=self.receipt.get("op").and_then(Value::as_str){super::manifest::access(op,&grant).map_err(|_|refused("forbidden"))?;}
        if self.receipt.get("grantRevision").and_then(Value::as_u64).is_some_and(|revision|revision!=grant.revision){return Err(refused("forbidden"));}
        if self.step.starts_with("command/exec")&&!self.receipt.get("terminalId").and_then(Value::as_str).is_some_and(|id|super::terminal::dispatch_allowed(&core,id)){return Err(refused("stale_target"));}
        if self.receipt.get("permission").and_then(Value::as_str) == Some("full")
            && !grant.capabilities.full_access
        {
            return Err(refused("forbidden"));
        }
        super::owners::check(&core,&self.meta)?;
        if core.work.cancelled.contains(&(self.meta.device.clone(),self.meta.op_id.clone())){return Err(refused("stale_target"));}
        if core.work.tickets.get(&self.ticket) != Some(&false) {
            return Err(refused("stale_target"));
        }
        if let Some(handle) = &self.target {
            let target = core
                .work
                .targets
                .get_mut(handle)
                .ok_or_else(|| refused("stale_target"))?;
            if target.revision != grant.revision
                || target.generation != self.meta.generation
                || target.device != self.meta.device
                || target
                    .expires
                    .is_none_or(|expires| expires <= Instant::now())
                || target.claimed.as_ref().is_some_and(|claim| {
                    claim != &(self.meta.device.clone(), self.meta.op_id.clone())
                })
            {
                return Err(refused("stale_target"));
            }
            target.claimed = Some((self.meta.device.clone(), self.meta.op_id.clone()));
        }
        if self.step == "turn_stop" {
            if let Some(handle) = &self.target {
                let target = core
                    .work
                    .targets
                    .get(handle)
                    .ok_or_else(|| refused("stale_target"))?;
                let owner = format!(
                    "{}:{:?}:{:?}",
                    target.owner, target.thread_id, target.turn_id
                );
                if core.work.stops.contains_key(&owner) {
                    return Err(refused("stale_target"));
                }
                if core.work.stops.len() >= 1024 {
                    return Err(refused("busy"));
                }
                core.work
                    .stops
                    .insert(owner, (self.meta.device.clone(), self.meta.op_id.clone()));
            }
        }
        core.work.tickets.remove(&self.ticket);
        self.begun = true;
        dispatch()
    }
    pub(crate) async fn write_claimed<T>(
        &mut self,
        mut claim: impl FnMut() -> Result<(), String>,
        future: impl Future<Output = Result<T, String>>,
    ) -> Result<T, String> {
        tokio::pin!(future);
        std::future::poll_fn(|cx| {
            if self.begun {
                return future.as_mut().poll(cx);
            }
            match self.begin(|| {
                claim()?;
                Ok(future.as_mut().poll(cx))
            }) {
                Ok(poll) => poll,
                Err(error) => Poll::Ready(Err(error)),
            }
        })
        .await
    }
    pub(crate) async fn accepted(&self, extra: Value) -> Result<(), String> {
        if self.meta.owner_handle.is_some(){
            let provider=match self.step.as_str(){"claude_prompt"=>Some("claude"),"cursor_prompt"=>Some("cursor"),"turn/start"=>Some("openai"),_=>None};
            if let(Some(provider),Some(turn))=(provider,extra.get("turnId").and_then(Value::as_str)){
                let thread=extra.get("threadId").and_then(Value::as_str).or_else(||self.receipt.get("threadId").and_then(Value::as_str)).ok_or_else(||refused("stale_target"))?;
                let owner=if provider=="openai"{format!("codex:{}",extra.get("runtimeInstance").and_then(Value::as_str).ok_or_else(||refused("stale_target"))?)}else{format!("{provider}:{turn}")};
                let target=Target{owner_handle:None,generation:self.meta.generation,device:self.meta.device.clone(),kind:"turn".into(),thread_id:Some(thread.into()),workspace_id:self.receipt.get("workspaceId").and_then(Value::as_str).map(str::to_owned),provider:Some(provider.into()),request_id:None,method:None,turn_id:Some(turn.into()),item_id:None,start_request_id:extra.get("startRequestId").and_then(Value::as_str).map(str::to_owned),agent_run_id:None,attempt_id:self.meta.attempt_id.clone(),parent_run_id:None,revision:0,owner,expires:None,claimed:None};
                super::owners::record(&mut self.inner.lock(),&self.meta,target)?;
            }
        }

        let mut receipt = self.receipt.clone();
        receipt["disposition"] = json!("accepted");
        if let Some(extra) = extra.as_object() {
            for (key, value) in extra {
                receipt[key] = value.clone();
            }
        }
        let saved = {
            let _core = self.inner.lock();
            let meta = self.meta.clone();
            self.inner.enqueue_write(false, move |db| {
                store::save_native_delivery_receipt(
                    db,
                    &meta.device,
                    &meta.op_id,
                    meta.op_seq,
                    &receipt,
                )
            })
        };
        finish_write(saved).await.map_err(|_|"MYTHRA_DELIVERY_UNCERTAIN: The provider accepted input but its receipt could not be saved.".into())
    }
}
pub(crate) async fn prepare_native(
    app: &AppHandle,
    meta: RemoteDelivery,
    step: &str,
    permission: Option<&str>,
    target: Option<String>,
) -> Result<NativePermit, String> {
    if !meta.valid() {
        return Err(refused("invalid"));
    }
    let inner = app.state::<RemoteState>().inner.clone();
    let saved = {
        let core = inner.lock();
        generation(&core, &meta).map_err(|error| refused(&error.code))?;
        let (meta, step) = (meta.clone(), step.to_owned());
        inner.enqueue_write(false, move |db| {
            let mut receipt=store::claim_native_step(db, &meta.device, &meta.op_id, meta.op_seq, &step)?;
            if let Some(owner)=meta.owner_handle.as_ref(){if receipt.get("ownerHandle").and_then(Value::as_str).is_some_and(|old|old!=owner){return Err(refused("stale_target"));}receipt["ownerHandle"]=json!(owner);db.execute("UPDATE remote_op_journal SET delivery_json=?4 WHERE device_fingerprint=?1 AND op_id=?2 AND op_seq=?3",rusqlite::params![meta.device,meta.op_id,meta.op_seq as i64,receipt.to_string()]).map_err(|_|refused("stale_target"))?;}
            Ok(receipt)
        })
    };
    let receipt = finish_write(saved)
        .await
        .map_err(|_| refused("stale_target"))?;
    if receipt.get("ownerHandle").and_then(Value::as_str).is_some_and(|owner|meta.owner_handle.as_deref()!=Some(owner)){return Err(refused("stale_target"));}
    if !["thread/start", "thread/resume"].contains(&step)
        && receipt.get("disposition").and_then(Value::as_str) != Some("dispatched")
    {
        return Err(refused("stale_target"));
    }
    if meta
        .attempt_id
        .as_ref()
        .is_some_and(|id| receipt.get("attemptId").and_then(Value::as_str) != Some(id))
        || meta
            .message_id
            .as_ref()
            .is_some_and(|id| receipt.get("messageId").and_then(Value::as_str) != Some(id))
    {
        return Err(refused("stale_target"));
    }
    if let Some(permission) = permission {
        let saved = receipt
            .get("permission")
            .and_then(Value::as_str)
            .ok_or_else(|| refused("forbidden"))?;
        let strength = |mode: &str| match mode {
            "read-only" => 0,
            "ask" => 1,
            "full" => 2,
            _ => 3,
        };
        if strength(permission) > strength(saved) || strength(permission) > 2 || receipt.get("permissionCeiling").and_then(Value::as_str).is_some_and(|ceiling|strength(permission)>strength(ceiling)) {
            return Err(refused("forbidden"));
        }
    }
    let ticket = uuid::Uuid::new_v4().to_string();
    {
        let mut core = inner.lock();
        authorize(
            &core,
            &meta,
            receipt.get("workspaceId").and_then(Value::as_str),
        )
        .map_err(|error| refused(&error.code))?;
        if core.work.tickets.len() >= 512 {
            return Err(refused("busy"));
        }
        super::owners::attach(&mut core,&meta,receipt.get("workspaceId").and_then(Value::as_str),&ticket)?;
        if meta.owner_handle.is_some(){if let Some(child)=target.as_ref().and_then(|handle|core.work.targets.get(handle)).filter(|child|child.owner_handle.is_none()&&matches!(child.kind.as_str(),"turn"|"start")).cloned(){super::owners::record(&mut core,&meta,child)?;}}

        core.work.tickets.insert(ticket.clone(), false);
    }
    Ok(NativePermit {
        inner,
        meta,
        receipt,
        ticket,
        target,
        step: step.to_owned(),
        begun: false,
    })
}
impl Drop for NativePermit {
    fn drop(&mut self) {
        let mut core = self.inner.lock();
        core.work.tickets.remove(&self.ticket);
        super::owners::release(&mut core,&self.meta,&self.ticket);
        if !self.begun {
            let meta = self.meta.clone();
            let mut receipt = self.receipt.clone();
            receipt["disposition"] = json!("rejected");
            receipt["errorCode"] = json!(if authorize(
                &core,
                &meta,
                receipt.get("workspaceId").and_then(Value::as_str)
            )
            .is_err()
            {
                "forbidden"
            } else {
                "stale_target"
            });
            let _ = self.inner.enqueue_write(true, move |db| {
                store::save_delivery_receipt(db, &meta.device, &meta.op_id, meta.op_seq, &receipt)
            });
        }
    }
}

impl NativePermit {
    pub(crate) fn check_spawn<T>(
        &self,
        spawn: impl FnOnce() -> Result<T, String>,
    ) -> Result<T, String> {
        let core = self.inner.lock();
        super::owners::check(&core,&self.meta)?;
        let grant = authorize(
            &core,
            &self.meta,
            self.receipt.get("workspaceId").and_then(Value::as_str),
        )
        .map_err(|error| refused(&error.code))?;
        super::manifest::access(
            self.receipt
                .get("op")
                .and_then(Value::as_str)
                .unwrap_or("prompt.send"),
            &grant,
        )
        .map_err(|error| refused(&error.code))?;
        if self.receipt.get("permission").and_then(Value::as_str) == Some("full")
            && !grant.capabilities.full_access
        {
            return Err(refused("forbidden"));
        }
        spawn()
    }
    pub(crate) async fn prepared(&self, extra: Value) -> Result<(), String> {
        let mut receipt = self.receipt.clone();
        if let Some(extra) = extra.as_object() {
            for (key, value) in extra {
                if !value.is_null() {
                    receipt[key] = value.clone();
                }
            }
        }
        let saved = {
            let _core = self.inner.lock();
            let meta = self.meta.clone();
            self.inner.enqueue_write(false, move |db| {
                store::save_delivery_receipt(db, &meta.device, &meta.op_id, meta.op_seq, &receipt)
            })
        };
        finish_write(saved).await.map_err(|_|"MYTHRA_DELIVERY_UNCERTAIN: Native preparation completed but its receipt could not be saved.".into())
    }
}
#[tauri::command]
pub(crate) async fn remote_work_target_register(
    app: AppHandle,
    state: State<'_, RemoteState>,
    window: WebviewWindow,
    generation: u64,
    device: String,
    kind: String,
    thread_id: Option<String>,
    workspace_id: Option<String>,
    provider: Option<String>,
    request_id: Option<Value>,
    method: Option<String>,
    turn_id: Option<String>,
    item_id: Option<String>,
    start_request_id: Option<String>,
    agent_run_id: Option<String>,
    attempt_id: Option<String>,
    parent_run_id: Option<String>,
    owner_handle: Option<String>,
    owner_run_id: Option<String>,
) -> Result<Value, WireError> {
    hostbridge::window_is_host(&window)?;
    if !["turn", "start", "parent", "approval", "question"].contains(&kind.as_str())
        || !super::identity::fingerprint_is_valid(&device)
    {
        return Err(invalid());
    }
    let mut target = Target {
        owner_handle,
        generation,
        device,
        kind,
        thread_id,
        workspace_id,
        provider,
        request_id,
        method,
        turn_id,
        item_id,
        start_request_id,
        agent_run_id,
        attempt_id,
        parent_run_id,
        revision: 0,
        owner: String::new(),
        expires: None,
        claimed: None,
    };
    if let Some(handle)=target.owner_handle.as_ref(){target.method=Some(super::owners::target_method(&state.inner,handle,owner_run_id.as_deref())?);}
    if serde_json::to_vec(&target).map_or(true, |bytes| bytes.len() > 8192) {
        return Err(invalid());
    }
    {
        let core = state.inner.lock();
        let meta = RemoteDelivery {
        owner_handle:None,
            generation,
            device: target.device.clone(),
            op_id: "target".into(),
            op_seq: 1,
            attempt_id: None,
            message_id: None,
        };
        target.revision = authorize(&core, &meta, target.workspace_id.as_deref())?.revision;
    }
    target.owner = crate::remote_native_owner(&app, &mut target)
        .await
        .map_err(|_| WireError::new("stale_target", "That native request or turn has ended."))?;
    let mut core = state.inner.lock();
    generation_check(&core, generation)?;
    core.work.targets.retain(|_, target| {
        target
            .expires
            .is_some_and(|expires| expires > Instant::now())
    });
    if core.work.targets.len() >= 1024 {
        return Err(WireError::new(
            "busy",
            "Too many native requests are waiting.",
        ));
    }
    let handle = uuid::Uuid::new_v4().to_string();
    target.expires = Some(Instant::now() + Duration::from_secs(300));
    core.work.targets.insert(handle.clone(), target);
    Ok(json!({"handle":handle}))
}
fn target_locked(core: &Core, meta: &RemoteDelivery, handle: &str) -> Result<Target, String> {
    let target = core
        .work
        .targets
        .get(handle)
        .filter(|target| {
            target.device == meta.device
                && target.generation == meta.generation
                && target
                    .expires
                    .is_some_and(|expires| expires > Instant::now())
                && target
                    .claimed
                    .as_ref()
                    .is_none_or(|claim| claim == &(meta.device.clone(), meta.op_id.clone()))
        })
        .cloned()
        .ok_or_else(|| refused("stale_target"))?;
    let grant = authorize(core, meta, target.workspace_id.as_deref())
        .map_err(|error| refused(&error.code))?;
    if target.revision != grant.revision {
        return Err(refused("stale_target"));
    }
    Ok(target)
}
#[tauri::command]
pub(crate) async fn remote_work_target_claim(
    app: AppHandle,
    state: State<'_, RemoteState>,
    window: WebviewWindow,
    generation: u64,
    device: String,
    op_id: String,
    op_seq: u64,
    handle: String,
) -> Result<(), String> {
    hostbridge::window_is_host(&window).map_err(|_| refused("forbidden"))?;
    let meta = RemoteDelivery {
        owner_handle:None,
        generation,
        device,
        op_id,
        op_seq,
        attempt_id: None,
        message_id: None,
    };
    let mut target = {
        let core = state.inner.lock();
        target_locked(&core, &meta, &handle)?
    };
    let owner = crate::remote_native_owner(&app, &mut target).await?;
    if owner != target.owner {
        return Err(refused("stale_target"));
    }
    // Prove this is an admitted operation, not an arbitrary local IPC opId.
    let saved = {
        let _core = state.inner.lock();
        let meta = meta.clone();
        state.inner.enqueue_write(false, move |db| {
            store::delivery_receipt(db, &meta.device, &meta.op_id, meta.op_seq)
        })
    };
    if finish_write(saved)
        .await
        .map_err(|_| refused("stale_target"))?
        .is_none()
    {
        return Err(refused("stale_target"));
    }
    crate::remote_native_claim(&app, &target, &meta, &handle).await
}
#[tauri::command]
pub(crate) async fn remote_work_dispatch(
    app: AppHandle,
    state: State<'_, RemoteState>,
    window: WebviewWindow,
    generation: u64,
    device: String,
    op_id: String,
    op_seq: u64,
    attempt_id: Option<String>,
    message_id: Option<String>,
    action: String,
    args: Value,
    target_handle: Option<String>,
) -> Result<Value, String> {
    hostbridge::window_is_host(&window).map_err(|_| refused("forbidden"))?;
    if ![
        "claude_turn_steer",
        "cursor_turn_steer",
        "codex_steer",
        "approval_answer",
        "question_answer",
        "turn_stop",
    ]
    .contains(&action.as_str())
        || serde_json::to_vec(&args).map_or(true, |bytes| bytes.len() > 1024 * 1024)
    {
        return Err(refused("unsupported"));
    }
    let meta = RemoteDelivery {
        owner_handle:None,
        generation,
        device,
        op_id,
        op_seq,
        attempt_id,
        message_id,
    };
    let handle = target_handle.ok_or_else(|| refused("stale_target"))?;
    let mut target = {
        let core = state.inner.lock();
        target_locked(&core, &meta, &handle)?
    };
    if target.thread_id.as_deref() != args.get("threadId").and_then(Value::as_str) {
        return Err(refused("stale_target"));
    }
    if target.owner_handle.is_some()&&target.kind=="parent"&&action=="turn_stop"{let revision=work_grant_revision(&state.inner,&meta)?;return super::owners::retire(&app,&state,super::commit::Stamp{generation:meta.generation,device:meta.device.clone(),grant_revision:revision,op_id:meta.op_id.clone(),op_seq:meta.op_seq,workspace_id:target.workspace_id.clone(),thread_id:target.thread_id.clone()},target.owner_handle.clone().unwrap()).await;}
    let owner = crate::remote_native_owner(&app, &mut target).await?;
    if owner != target.owner {
        return Err(refused("stale_target"));
    }
    let mut permit = prepare_native(&app, meta, &action, None, Some(handle)).await?;
    permit.verify_thread(
        target
            .thread_id
            .as_deref()
            .ok_or_else(|| refused("stale_target"))?,
    )?;
    let result = crate::remote_native_dispatch(&app, &target, &action, args, &mut permit).await?;
    permit
        .accepted(json!({"threadId":target.thread_id,"turnId":target.turn_id}))
        .await?;
    Ok(if action == "turn_stop" {
        json!({"confirmed":true})
    } else {
        result
    })
}

pub(super) fn generation_ended(core: &mut Core) {
    core.work.targets.clear();
    core.work.tickets.clear();
    core.work.stops.clear();
    core.work.cancelled.clear();
}
impl NativePermit {
    pub(crate) fn enforce_permission(&self, actual: &str) -> Result<(), String> {
        let strength = |mode: &str| match mode {
            "read-only" => 0,
            "ask" => 1,
            "full" => 2,
            _ => 3,
        };
        let core = self.inner.lock();
        let grant = authorize(
            &core,
            &self.meta,
            self.receipt.get("workspaceId").and_then(Value::as_str),
        )
        .map_err(|error| refused(&error.code))?;
        if strength(actual)
            > strength(
                self.receipt
                    .get("permission")
                    .and_then(Value::as_str)
                    .unwrap_or("read-only"),
            )
            || strength(actual) > 2
            || actual == "full" && !grant.capabilities.full_access
        {
            return Err(refused("forbidden"));
        }
        Ok(())
    }
    pub(crate) fn verify_thread(&self, thread: &str) -> Result<(), String> {
        if self.receipt.get("threadId").and_then(Value::as_str) != Some(thread) {
            return Err(refused("stale_target"));
        }
        Ok(())
    }
}

pub(crate) fn claim_target(
    app: &AppHandle,
    meta: &RemoteDelivery,
    handle: &str,
) -> Result<(), String> {
    let state = app.state::<RemoteState>();
    let mut core = state.inner.lock();
    target_locked(&core, meta, handle)?;
    core.work
        .targets
        .get_mut(handle)
        .ok_or_else(|| refused("stale_target"))?
        .claimed = Some((meta.device.clone(), meta.op_id.clone()));
    Ok(())
}

impl NativePermit {
    pub(crate) fn did_begin(&self) -> bool {
        self.begun
    }
    pub(crate) fn poll_write<T, F: Future<Output = Result<T, String>>>(
        &mut self,
        cx: &mut std::task::Context<'_>,
        mut future: std::pin::Pin<&mut F>,
        claim: impl FnOnce() -> Result<(), String>,
    ) -> Poll<Result<T, String>> {
        if self.begun {
            return future.as_mut().poll(cx);
        }
        match self.begin(|| {
            claim()?;
            Ok(future.as_mut().poll(cx))
        }) {
            Ok(poll) => poll,
            Err(error) => Poll::Ready(Err(error)),
        }
    }
}

#[tauri::command]
pub(crate) async fn remote_work_pending_requests(app:tauri::AppHandle,state:tauri::State<'_,RemoteState>,window:tauri::WebviewWindow,generation:u64)->Result<Value,WireError>{
    hostbridge::window_is_host(&window)?;hostbridge::check_generation(&state.inner.lock(),generation)?;
    let result=tokio::time::timeout(Duration::from_secs(3),crate::remote_pending_request_inventory(&app)).await.unwrap_or_else(|_|json!({"complete":false,"requests":[]}));hostbridge::check_generation(&state.inner.lock(),generation)?;Ok(result)
}

pub(super) fn cancel_preparation(core:&mut Core,device:&str,op:&str)->Result<(),String>{if core.work.cancelled.len()>=4096{return Err(refused("busy"));}core.work.cancelled.insert((device.to_owned(),op.to_owned()));Ok(())}

fn work_grant_revision(inner:&super::Inner,meta:&RemoteDelivery)->Result<u64,String>{grant_locked(&inner.lock(),&meta.device).map(|g|g.revision).ok_or_else(||refused("forbidden"))}

impl NativePermit{
 pub(crate) fn track_start(&self,provider:&str,thread:&str,turn:&str,start:Option<&str>)->Result<(),String>{
  if self.meta.owner_handle.is_none(){return Ok(());}let target=Target{owner_handle:None,generation:self.meta.generation,device:self.meta.device.clone(),kind:"start".into(),thread_id:Some(thread.into()),workspace_id:self.receipt.get("workspaceId").and_then(Value::as_str).map(str::to_owned),provider:Some(provider.into()),request_id:None,method:None,turn_id:Some(turn.into()),item_id:None,start_request_id:start.map(str::to_owned),agent_run_id:None,attempt_id:self.meta.attempt_id.clone(),parent_run_id:None,revision:0,owner:format!("{provider}-start:{turn}:{}",start.unwrap_or("")),expires:None,claimed:None};let mut core=self.inner.lock();super::owners::check(&core,&self.meta)?;super::owners::record(&mut core,&self.meta,target)
 }
}
