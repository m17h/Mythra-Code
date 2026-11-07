//! Host-owner state commits. The renderer must serialize its normal persistence
//! queue around snapshot -> commit -> adoption; no second state store is created.
use super::{finish_write, folders, hostbridge, manifest, store, work, Core, RemoteState};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{State, WebviewWindow};

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Stamp {
    pub generation: u64,
    pub device: String,
    pub grant_revision: u64,
    pub op_id: String,
    pub op_seq: u64,
    pub workspace_id: Option<String>,
    pub thread_id: Option<String>,
}
impl Stamp {
    pub(super) fn meta(&self) -> work::RemoteDelivery {
        work::RemoteDelivery {
            owner_handle: None,
            generation: self.generation,
            device: self.device.clone(),
            op_id: self.op_id.clone(),
            op_seq: self.op_seq,
            attempt_id: None,
            message_id: None,
        }
    }
    pub(super) fn check(&self, core: &Core, op: &str) -> Result<(), String> {
        hostbridge::check_generation(core, self.generation)
            .map_err(|_| work::refused("host_unavailable"))?;
        let grant = work::authorize(core, &self.meta(), self.workspace_id.as_deref())
            .map_err(|_| work::refused("forbidden"))?;
        if grant.revision != self.grant_revision {
            return Err(work::refused("forbidden"));
        }
        manifest::access(op, &grant).map_err(|_| work::refused("forbidden"))
    }
}
fn failed() -> String {
    "MYTHRA_DELIVERY_UNCERTAIN: The other device couldn't confirm this saved change.".into()
}
fn stale() -> String {
    work::refused("stale_target")
}

pub(super) fn operation(db: &Connection, stamp: &Stamp) -> Result<String, String> {
    db.query_row(
        "SELECT op FROM remote_op_journal WHERE device_fingerprint=?1 AND op_id=?2 AND op_seq=?3",
        params![stamp.device, stamp.op_id, stamp.op_seq as i64],
        |row| row.get(0),
    )
    .map_err(|_| stale())
}
pub(super) fn prior(db: &Connection, stamp: &Stamp) -> Result<Option<Value>, String> {
    let state:String=db.query_row("SELECT state FROM remote_op_journal WHERE device_fingerprint=?1 AND op_id=?2 AND op_seq=?3",params![stamp.device,stamp.op_id,stamp.op_seq as i64],|row|row.get(0)).map_err(|_|stale())?;
    let receipt = store::delivery_receipt(db, &stamp.device, &stamp.op_id, stamp.op_seq)?;
    if receipt
        .as_ref()
        .and_then(|r| r.get("nativeCommitted"))
        .and_then(Value::as_bool)
        == Some(true)
    {
        return store::operation_result(db, &stamp.device, &stamp.op_id).map(Some);
    }
    if matches!(state.as_str(), "rejected" | "uncertain")
        || receipt.as_ref().is_some_and(|r| {
            r.get("nativeSteps")
                .and_then(Value::as_array)
                .is_some_and(|steps| !steps.is_empty())
                || matches!(
                    r.get("disposition").and_then(Value::as_str),
                    Some("accepted" | "uncertain")
                )
        })
    {
        return Err(stale());
    }
    Ok(None)
}
/// Called inside the same SQL transaction and authority lock as the mutation.
pub(super) fn complete(
    db: &Connection,
    stamp: &Stamp,
    op: &str,
    result: &Value,
    queued: bool,
) -> Result<(), String> {
    let mut receipt = json!({"op":op,"device":stamp.device,"opId":stamp.op_id,"opSeq":stamp.op_seq,"generation":stamp.generation,"workspaceId":stamp.workspace_id,"threadId":stamp.thread_id,"disposition":if queued{"queued"}else{"accepted"},"nativeCommitted":true});
    for key in [
        "threadId",
        "workspaceId",
        "queuedTurnId",
        "messageId",
        "attemptId",
        "provider",
        "permission",
    ] {
        if let Some(value) = result.get(key).filter(|v| !v.is_null()) {
            receipt[key] = value.clone();
        }
    }
    if let Some(previous) = store::delivery_receipt(db, &stamp.device, &stamp.op_id, stamp.op_seq)?
    {
        for key in ["ownerHandle", "engineOwnerHandle"] {
            if let Some(value) = previous.get(key) {
                receipt[key] = value.clone();
            }
        }
    }
    if queued {
        if let Some(previous) =
            store::delivery_receipt(db, &stamp.device, &stamp.op_id, stamp.op_seq)?
        {
            for key in ["queueAuthorized", "permissionCeiling", "permission"] {
                if let Some(value) = previous.get(key) {
                    receipt[key] = value.clone();
                }
            }
        }
        receipt["queueAdmissionCommitted"] = json!(true);
    }
    if queued {
        super::attachments::retain_instruction(
            db,
            &stamp.device,
            &stamp.op_id,
            stamp.op_seq,
            &receipt,
        )?;
    }
    // This is an authoritative transaction, not a late renderer result.
    db.execute("UPDATE remote_op_journal SET state='pending',delivery_json=NULL WHERE device_fingerprint=?1 AND op_id=?2 AND op_seq=?3",params![stamp.device,stamp.op_id,stamp.op_seq as i64]).map_err(|_|failed())?;
    store::save_operation_result(db, &stamp.device, &stamp.op_id, stamp.op_seq, result)?;
    db.execute("UPDATE remote_op_journal SET delivery_json=?4 WHERE device_fingerprint=?1 AND op_id=?2 AND op_seq=?3",params![stamp.device,stamp.op_id,stamp.op_seq as i64,receipt.to_string()]).map_err(|_|failed())?;
    Ok(())
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct StateWrite {
    key: String,
    expected_revision: Option<i64>,
    value: Value,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Rejection {
    device: String,
    op_id: String,
    op_seq: u64,
}
fn key_allowed(op: &str, key: &str) -> bool {
    match op {
        "projects.add" | "projects.remove" | "projects.pin" | "projects.reorder" => {
            key == "kiwi.projects"
        }
        "projects.settings.set"
        | "projects.instructions.set"
        | "projects.profiles.save"
        | "projects.profiles.delete"
        | "projects.profiles.select"
        | "projects.run.set"
        | "projects.check.set" => key == "kiwi.projects",
        "thread.settings.set" => matches!(
            key,
            "kiwi.threadModels"
                | "kiwi.threadReasoning"
                | "kiwi.threadSubagentSettings"
                | "kiwi.threadExecutionPreferences"
        ),
        "thread.rename" | "thread.fork" => matches!(
            key,
            "kiwi.knownThreads"
                | "kiwi.threadProjects"
                | "kiwi.threadModels"
                | "kiwi.threadReasoning"
        ),
        "thread.pin" => key == "kiwi.pinnedThreads",
        "thread.archive" | "thread.restore" | "thread.archiveMany" => key == "kiwi.archivedThreads",
        "thread.delete" | "thread.deleteMany" => matches!(
            key,
            "kiwi.knownThreads"
                | "kiwi.threadProjects"
                | "kiwi.threadModels"
                | "kiwi.threadReasoning"
                | "kiwi.archivedThreads"
                | "kiwi.pinnedThreads"
                | "kiwi.queuedTurns"
                | "kiwi.parentRuns"
                | "kiwi.threadWorktrees"
                | "kiwi.checkpoints"
                | "kiwi.checkpointHeads"
        ),
        "prompt.send" | "prompt.queue" | "queue.edit.begin" | "queue.edit.finish"
        | "queue.retry" | "queue.steer" | "queue.remove" => key == "kiwi.queuedTurns",
        "prompt.schedule"
        | "prompt.scheduleNew"
        | "schedules.edit"
        | "schedules.reschedule"
        | "schedules.release"
        | "schedules.remove" => matches!(
            key,
            "kiwi.queuedTurns"
                | "kiwi.newThreadTimedPrompts"
                | "kiwi.scheduledTasks"
                | "kiwi.scheduleRuns"
        ),
        "workflows.start" | "workflows.stop" => matches!(
            key,
            "kiwi.workflowRuns" | "kiwi.queuedTurns" | "kiwi.parentRuns"
        ),
        "parent.continue" | "parent.dismiss" => key == "kiwi.parentRuns",
        "thread.handoff.prepare" | "thread.handoff.send" => matches!(
            key,
            "kiwi.threadHandoffs" | "kiwi.pendingHandoff" | "kiwi.queuedTurns"
        ),
        "discovery.settings.set" => matches!(key, "kiwi.runDiscovery" | "kiwi.projects"),
        _ => false,
    }
}
pub(super) fn state_row(db: &Connection, key: &str) -> Result<Value, String> {
    let row: Option<(String, i64)> = db
        .query_row(
            "SELECT value,updated_at FROM app_state WHERE key=?1",
            [key],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()
        .map_err(|_| failed())?;
    match row {
        Some((text, revision)) => Ok(
            json!({"key":key,"value":serde_json::from_str::<Value>(&text).map_err(|_|failed())?,"revision":revision}),
        ),
        None => Ok(json!({"key":key,"value":null,"revision":null})),
    }
}
pub(super) fn write_value(db: &Connection, key: &str, value: &Value) -> Result<(), String> {
    db.execute("INSERT INTO app_state(key,value,updated_at) VALUES(?1,?2,?3) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=MAX(excluded.updated_at,app_state.updated_at+1)",params![key,value.to_string(),crate::unix_timestamp_ms()]).map_err(|_|failed())?;
    Ok(())
}
fn reject(db: &Connection, items: &[Rejection]) -> Result<(), String> {
    for item in items {
        let Some(mut receipt) =
            store::delivery_receipt(db, &item.device, &item.op_id, item.op_seq)?
        else {
            return Err(stale());
        };
        if !matches!(
            receipt.get("disposition").and_then(Value::as_str),
            Some("preparing" | "queued" | "rejected")
        ) || receipt
            .get("nativeSteps")
            .and_then(Value::as_array)
            .is_some_and(|steps| !steps.is_empty())
        {
            return Err(stale());
        }
        receipt["disposition"] = json!("rejected");
        receipt["errorCode"] = json!("cancelled");
        let result = json!({"opId":item.op_id,"state":"rejected","error":{"code":"cancelled","message":"This queued instruction was cancelled on the other device."}});
        db.execute("UPDATE remote_op_journal SET state='rejected',delivery_json=?4,result_json=?5,error_code='cancelled',updated_at=?6 WHERE device_fingerprint=?1 AND op_id=?2 AND op_seq=?3",params![item.device,item.op_id,item.op_seq as i64,receipt.to_string(),result.to_string(),crate::unix_timestamp_ms()]).map_err(|_|failed())?;
    }
    Ok(())
}
#[tauri::command]
pub(crate) async fn remote_state_snapshot(
    state: State<'_, RemoteState>,
    window: WebviewWindow,
    stamp: Stamp,
    keys: Vec<String>,
) -> Result<Value, String> {
    hostbridge::window_is_host(&window).map_err(|_| stale())?;
    if keys.is_empty() || keys.len() > 16 {
        return Err(stale());
    }
    let inner = state.inner.clone();
    state
        .inner
        .read_db(move |db| {
            let op = operation(db, &stamp)?;
            let core = inner.lock();
            stamp.check(&core, &op)?;
            if keys.iter().any(|key| !key_allowed(&op, key)) {
                return Err(stale());
            }
            let rows = keys
                .iter()
                .map(|key| state_row(db, key))
                .collect::<Result<Vec<_>, _>>()?;
            if serde_json::to_vec(&rows).map_or(true, |v| v.len() > 4 * 1024 * 1024) {
                return Err(stale());
            }
            Ok(json!({"rows":rows}))
        })
        .await
}
#[tauri::command]
pub(crate) async fn remote_state_commit(
    state: State<'_, RemoteState>,
    window: WebviewWindow,
    stamp: Stamp,
    writes: Vec<StateWrite>,
    reject_queued: Vec<Rejection>,
    queued: bool,
) -> Result<Value, String> {
    hostbridge::window_is_host(&window).map_err(|_| stale())?;
    if writes.is_empty()
        || writes.len() > 16
        || reject_queued.len() > 100
        || serde_json::to_vec(&writes.iter().map(|w| &w.value).collect::<Vec<_>>())
            .map_or(true, |v| v.len() > 4 * 1024 * 1024)
    {
        return Err(stale());
    }
    let inner = state.inner.clone();
    let saved=state.inner.enqueue_write(false,move|db|{
        let op=operation(db,&stamp)?;
        if op=="projects.add"||writes.iter().any(|w|!key_allowed(&op,&w.key))||writes.iter().enumerate().any(|(i,w)|writes[..i].iter().any(|other|other.key==w.key)){return Err(stale());}
        if let Some(result)=prior(db,&stamp)?{let rows=writes.iter().map(|write|state_row(db,&write.key)).collect::<Result<Vec<_>,_>>()?;return Ok(json!({"result":result,"rows":rows,"replayed":true}));}
        let tx=db.transaction().map_err(|_|failed())?;
        for write in &writes{let current=state_row(&tx,&write.key)?;if current.get("revision").and_then(Value::as_i64)!=write.expected_revision{return Err(stale());}}
        let core=inner.lock();stamp.check(&core,&op)?;
        if queued&&!matches!(op.as_str(),"prompt.send"|"prompt.queue"|"prompt.schedule"|"prompt.scheduleNew"|"queue.edit.finish"|"queue.retry"|"schedules.edit"){return Err(stale());}
        reject(&tx,&reject_queued)?;
        if op=="thread.settings.set"{let grant=work::authorize(&core,&stamp.meta(),stamp.workspace_id.as_deref()).map_err(|_|stale())?;if !grant.capabilities.full_access {if let Some(thread)=stamp.thread_id.as_deref(){if writes.iter().any(|w|w.key=="kiwi.threadExecutionPreferences"&&w.value.get(thread).and_then(|v|v.get("permission")).and_then(Value::as_str)==Some("full")){return Err(work::refused("forbidden"));}}}}
        for write in &writes{write_value(&tx,&write.key,&write.value)?;}
        let mut result=json!({"opId":stamp.op_id,"state":if queued{"queued"}else{"accepted"},"threadId":stamp.thread_id,"workspaceId":stamp.workspace_id});
        if queued {let entry=writes.iter().filter(|w|w.key=="kiwi.queuedTurns").filter_map(|w|w.value.as_object()).flat_map(|map|map.values()).filter_map(Value::as_array).flatten().find(|row|row.get("remoteDelivery").is_some_and(|r|r.get("device").and_then(Value::as_str)==Some(&stamp.device)&&r.get("opId").and_then(Value::as_str)==Some(&stamp.op_id)&&r.get("opSeq").and_then(Value::as_u64)==Some(stamp.op_seq)));
            let row=entry.ok_or_else(stale)?;let remote=&row["remoteDelivery"];if remote.get("workspaceId").and_then(Value::as_str)!=stamp.workspace_id.as_deref()||remote.get("disposition").and_then(Value::as_str)!=Some("queued"){return Err(stale());}
            for (key,source) in [("queuedTurnId",row.get("id")),("threadId",row.get("threadId")),("attemptId",remote.get("attemptId")),("messageId",remote.get("messageId"))]{let id=source.and_then(Value::as_str).filter(|id|!id.is_empty()&&id.len()<=512).ok_or_else(stale)?;result[key]=json!(id);}
        }
        complete(&tx,&stamp,&op,&result,queued)?;
        let rows=writes.iter().map(|w|state_row(&tx,&w.key)).collect::<Result<Vec<_>,_>>()?;
        tx.commit().map_err(|_|failed())?;drop(core);Ok(json!({"result":result,"rows":rows,"replayed":false}))
    });
    finish_write(saved).await
}
#[tauri::command]
pub(crate) async fn remote_work_reject_queued(
    state: State<'_, RemoteState>,
    window: WebviewWindow,
    generation: u64,
    device: String,
    op_id: String,
    op_seq: u64,
) -> Result<(), String> {
    hostbridge::window_is_host(&window).map_err(|_| stale())?;
    hostbridge::check_generation(&state.inner.lock(), generation).map_err(|_| stale())?;
    let inner = state.inner.clone();
    finish_write(state.inner.enqueue_write(false, move |db| {
        let tx = db.transaction().map_err(|_| failed())?;
        let core = inner.lock();
        hostbridge::check_generation(&core, generation).map_err(|_| stale())?;
        reject(
            &tx,
            &[Rejection {
                device,
                op_id,
                op_seq,
            }],
        )?;
        tx.commit().map_err(|_| failed())
    }))
    .await
}
#[tauri::command]
pub(crate) async fn remote_projects_add(
    state: State<'_, RemoteState>,
    window: WebviewWindow,
    stamp: Stamp,
    folder_token: String,
    expected_revision: Option<i64>,
) -> Result<Value, String> {
    hostbridge::window_is_host(&window).map_err(|_| stale())?;
    // Native token revalidation happens again IN the actual commit worker.
    let inner = state.inner.clone();
    let saved=state.inner.enqueue_write(false,move|db|{
        let op=operation(db,&stamp)?;if op!="projects.add"{return Err(stale());}
        if let Some(result)=prior(db,&stamp)?{return Ok(json!({"result":result,"rows":[state_row(db,"kiwi.projects")?],"replayed":true}));}
        let selected=folders::selection(&inner,stamp.generation,&stamp.device,stamp.grant_revision,&folder_token)?;
        let tx=db.transaction().map_err(|_|failed())?;let row=state_row(&tx,"kiwi.projects")?;
        if row.get("revision").and_then(Value::as_i64)!=expected_revision{return Err(stale());}
        let mut projects=if row["value"].is_null(){Vec::new()}else{row["value"].as_array().ok_or_else(stale)?.clone()};
        if projects.len()>10000{return Err(stale());}
        let existing=projects.iter().find(|p|p.get("isChat")!=Some(&Value::Bool(true))&&p.get("path").and_then(Value::as_str).and_then(|path|std::fs::canonicalize(path).ok()).is_some_and(|path|path==selected.path)).cloned();
        let project=existing.unwrap_or_else(||json!({"id":uuid::Uuid::new_v4().to_string(),"name":selected.name,"path":selected.path.to_string_lossy(),"isChat":false}));
        let core=inner.lock();stamp.check(&core,&op)?;selected.validate()?;
        if !projects.iter().any(|p|p.get("id")==project.get("id")){projects.push(project.clone());}
        write_value(&tx,"kiwi.projects",&json!(projects))?;
        let result=json!({"opId":stamp.op_id,"state":"accepted","workspaceId":project["id"],"workspace":{"id":project["id"],"name":project["name"],"isChat":false}});
        complete(&tx,&stamp,&op,&result,false)?;let rows=vec![state_row(&tx,"kiwi.projects")?];tx.commit().map_err(|_|failed())?;drop(core);
        Ok(json!({"result":result,"project":project,"rows":rows,"replayed":false}))
    });
    finish_write(saved).await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct OriginalAttempt {
    device: String,
    op_id: String,
    op_seq: u64,
}
#[tauri::command]
pub(crate) async fn remote_work_cancel_attempt(
    state: State<'_, RemoteState>,
    window: WebviewWindow,
    generation: u64,
    device: String,
    op_id: String,
    op_seq: u64,
    workspace_id: String,
    original: OriginalAttempt,
    attempt_id: String,
) -> Result<Value, String> {
    hostbridge::window_is_host(&window).map_err(|_| stale())?;
    if original.device != device || attempt_id.is_empty() || attempt_id.len() > 256 {
        return Err(stale());
    }
    let inner = state.inner.clone();
    let saved=state.inner.enqueue_write(false,move|db|{
        let revision=work::grant_locked(&inner.lock(),&device).ok_or_else(stale)?.revision;
        let stamp=Stamp{generation,device:device.clone(),grant_revision:revision,op_id,op_seq,workspace_id:Some(workspace_id.clone()),thread_id:None};
        if operation(db,&stamp)?!="prompt.cancel"{return Err(stale());}
        if let Some(result)=prior(db,&stamp)?{return Ok(json!({"confirmed":result.get("confirmed").and_then(Value::as_bool).unwrap_or(false)}));}
        let tx=db.transaction().map_err(|_|failed())?;
        let Some(mut receipt)=store::delivery_receipt(&tx,&original.device,&original.op_id,original.op_seq)? else{return Ok(json!({"confirmed":false}));};
        let original_op:String=tx.query_row("SELECT op FROM remote_op_journal WHERE device_fingerprint=?1 AND op_id=?2 AND op_seq=?3",params![original.device,original.op_id,original.op_seq as i64],|r|r.get(0)).map_err(|_|stale())?;if !matches!(original_op.as_str(),"prompt.send"|"prompt.queue"){return Err(stale());}
        if receipt.get("workspaceId").and_then(Value::as_str)!=Some(&workspace_id)||receipt.get("attemptId").and_then(Value::as_str)!=Some(&attempt_id){return Err(stale());}
        // Thread creation/resume is preparatory, not provider prompt delivery.
        // Any actual prompt latch is uncertain and must use its exact Stop owner.
        let latched=receipt.get("nativeSteps").and_then(Value::as_array).is_some_and(|steps|steps.iter().any(|step|!matches!(step.as_str(),Some("thread/start"|"thread/resume"))));
        if latched||!matches!(receipt.get("disposition").and_then(Value::as_str),Some("preparing"|"queued"|"rejected")){return Ok(json!({"confirmed":false}));}
        let mut core=inner.lock();stamp.check(&core,"prompt.cancel")?;work::cancel_preparation(&mut core,&original.device,&original.op_id)?;
        receipt["disposition"]=json!("rejected");receipt["errorCode"]=json!("cancelled");let result=json!({"opId":original.op_id,"state":"rejected","error":{"code":"cancelled","message":"This prompt was cancelled before it was sent."}});
        tx.execute("UPDATE remote_op_journal SET state='rejected',delivery_json=?4,result_json=?5,error_code='cancelled' WHERE device_fingerprint=?1 AND op_id=?2 AND op_seq=?3",params![original.device,original.op_id,original.op_seq as i64,receipt.to_string(),result.to_string()]).map_err(|_|failed())?;
        complete(&tx,&stamp,"prompt.cancel",&json!({"opId":stamp.op_id,"state":"accepted","confirmed":true}),false)?;tx.commit().map_err(|_|failed())?;drop(core);Ok(json!({"confirmed":true}))
    });
    finish_write(saved).await
}

#[tauri::command]
pub(crate) async fn remote_work_queue_authorize(
    state: State<'_, RemoteState>,
    window: WebviewWindow,
    stamp: Stamp,
    attempt_id: String,
    message_id: String,
    permission: Option<String>,
    owner_handle: Option<String>,
) -> Result<Value, String> {
    hostbridge::window_is_host(&window).map_err(|_| stale())?;
    if attempt_id.is_empty()
        || message_id.is_empty()
        || attempt_id.len() > 256
        || message_id.len() > 256
    {
        return Err(stale());
    }
    let permission = permission.unwrap_or_else(|| "ask".into());
    if !matches!(permission.as_str(), "read-only" | "ask" | "full") {
        return Err(stale());
    }
    let inner = state.inner.clone();
    let saved=state.inner.enqueue_write(false,move|db|{
        let op=operation(db,&stamp)?;if !matches!(op.as_str(),"queue.edit.finish"|"queue.retry"|"prompt.schedule"|"prompt.scheduleNew"|"schedules.edit"){return Err(work::refused("unsupported"));}
        let mut core=inner.lock();stamp.check(&core,&op)?;if permission=="full"&&!work::authorize(&core,&stamp.meta(),stamp.workspace_id.as_deref()).map_err(|_|stale())?.capabilities.full_access{return Err(work::refused("forbidden"));}
        let mut meta=stamp.meta();meta.owner_handle=owner_handle.clone();super::owners::check(&core,&meta)?;
        let ticket=uuid::Uuid::new_v4().to_string();super::owners::attach(&mut core,&meta,stamp.workspace_id.as_deref(),&ticket)?;super::owners::release(&mut core,&meta,&ticket);
        if let Some(receipt)=store::delivery_receipt(db,&stamp.device,&stamp.op_id,stamp.op_seq)?{if receipt.get("queueAuthorized").and_then(Value::as_bool)==Some(true){return if receipt.get("attemptId").and_then(Value::as_str)==Some(&attempt_id)&&receipt.get("messageId").and_then(Value::as_str)==Some(&message_id){Ok(json!({"ready":true}))}else{Err(stale())};}}
        store::save_delivery_receipt(db,&stamp.device,&stamp.op_id,stamp.op_seq,&json!({"generation":stamp.generation,"device":stamp.device,"opId":stamp.op_id,"opSeq":stamp.op_seq,"workspaceId":stamp.workspace_id,"threadId":stamp.thread_id,"attemptId":attempt_id,"messageId":message_id,"permission":permission,"permissionCeiling":permission,"ownerHandle":owner_handle,"disposition":"preparing","queueAuthorized":true}))?;
        Ok(json!({"ready":true}))
    });
    finish_write(saved).await
}
