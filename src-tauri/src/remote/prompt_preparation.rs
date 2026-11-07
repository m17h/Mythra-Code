//! Host-derived, owner-fenced implicit Git preparation. Does not accept a prompt.
use super::{
    commit::{self, Stamp},
    domain,
    fs_guard::Anchor,
    hostbridge, owners, store, work, Core, Inner, RemoteState,
};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::{collections::HashMap, path::Path, sync::Arc};
use tauri::{AppHandle, State, WebviewWindow};

#[derive(Default)]
pub(super) struct Registry {
    roots: HashMap<(String, String), PreparedRoot>,
    locks: HashMap<std::path::PathBuf, std::sync::Weak<tokio::sync::Mutex<()>>>,
    #[cfg(test)]
    worker_gate: Option<(
        tokio::sync::oneshot::Sender<()>,
        std::sync::mpsc::Receiver<()>,
    )>,
}
struct PreparedRoot {
    owner: String,
    root: Arc<Anchor>,
    display_root: String,
    thread: Option<String>,
}
fn stale() -> String {
    work::refused("stale_target")
}
fn uncertain() -> String {
    "MYTHRA_DELIVERY_UNCERTAIN: Git preparation could not be confirmed. Inspect the project on the host before trying again.".into()
}
fn meta(stamp: &Stamp, owner: &str) -> work::RemoteDelivery {
    let mut meta = stamp.meta();
    meta.owner_handle = Some(owner.into());
    meta
}
fn check(core: &Core, stamp: &Stamp, owner: &str, op: &str) -> Result<(), String> {
    stamp.check(core, op)?;
    owners::check(core, &meta(stamp, owner))?;
    if !owners::preparation_owner(core, &meta(stamp, owner), stamp.workspace_id.as_deref())
        || !work::authorize(core, &stamp.meta(), stamp.workspace_id.as_deref())
            .map_err(|_| stale())?
            .capabilities
            .terminal
    {
        return Err(work::refused("forbidden"));
    }
    Ok(())
}
fn allowed(op: &str) -> bool {
    matches!(
        op,
        "prompt.send"
            | "prompt.queue"
            | "queue.retry"
            | "queue.edit.finish"
            | "prompt.schedule"
            | "prompt.scheduleNew"
            | "schedules.edit"
            | "parent.continue"
            | "review.start"
            | "git.suggestCommit"
            | "engine.prompt"
            | "engine.command"
    )
}
fn row(db: &Connection, key: &str) -> Result<Value, String> {
    Ok(commit::state_row(db, key)?["value"].clone())
}
fn map(value: Value) -> Result<serde_json::Map<String, Value>, String> {
    if value.is_null() {
        Ok(Default::default())
    } else {
        value.as_object().cloned().ok_or_else(stale)
    }
}
fn source(db: &Connection, stamp: &Stamp) -> Result<String, String> {
    let projects = row(db, "kiwi.projects")?;
    projects
        .as_array()
        .and_then(|p| {
            p.iter()
                .find(|p| p["id"].as_str() == stamp.workspace_id.as_deref())
        })
        .and_then(|p| p["path"].as_str())
        .filter(|p| !p.is_empty())
        .map(str::to_owned)
        .ok_or_else(stale)
}
fn execution(
    db: &Connection,
    core: &Core,
    stamp: &Stamp,
    owner: &str,
    thread: Option<&str>,
) -> Result<(String, String), String> {
    let source = source(db, stamp)?;
    if let Some(thread) = thread {
        if stamp.thread_id.as_deref().is_some_and(|id| id != thread)
            || !owners::preparation_thread(core, &meta(stamp, owner), thread)
        {
            return Err(stale());
        }
        let trees = map(row(db, "kiwi.threadWorktrees")?)?;
        if let Some(tree) = trees.get(thread) {
            if tree["projectId"].as_str() != stamp.workspace_id.as_deref()
                || tree["projectPath"] != source
                || matches!(tree["status"].as_str(), Some("removed" | "missing"))
            {
                return Err(stale());
            }
            return Ok((source, tree["path"].as_str().ok_or_else(stale)?.into()));
        }
        let bindings = map(row(db, "kiwi.threadProjects")?)?;
        if bindings
            .get(thread)
            .is_some_and(|p| p.as_str() != Some(&source))
        {
            return Err(stale());
        }
    }
    let key = (stamp.device.clone(), stamp.op_id.clone());
    let target = core
        .prompt_preparations
        .roots
        .get(&key)
        .filter(|r| r.owner == owner)
        .map(|r| r.display_root.clone())
        .unwrap_or_else(|| source.clone());
    Ok((source, target))
}
fn saved(
    db: &Connection,
    stamp: &Stamp,
    kind: &str,
) -> Result<Option<(String, String, Value)>, String> {
    db.query_row("SELECT preparation_id,state,payload_json FROM remote_prompt_preparations WHERE device=?1 AND op_id=?2 AND op_seq=?3 AND kind=?4",params![stamp.device,stamp.op_id,stamp.op_seq as i64,kind],|r|Ok((r.get(0)?,r.get(1)?,r.get::<_,String>(2)?))).optional().map_err(|_|stale())?.map(|(id,state,payload)|Ok((id,state,serde_json::from_str(&payload).map_err(|_|stale())?))).transpose()
}
fn rows(db: &Connection) -> Result<Vec<Value>, String> {
    [
        "kiwi.threadWorktrees",
        "kiwi.threadProjects",
        "kiwi.checkpoints",
        "kiwi.checkpointHeads",
    ]
    .iter()
    .map(|key| commit::state_row(db, key))
    .collect()
}
fn reply(
    db: &Connection,
    stamp: &Stamp,
    kind: &str,
    id: &str,
    payload: &Value,
    replayed: bool,
) -> Result<Value, String> {
    Ok(
        json!({"preparationId":id,"kind":kind,"payload":payload,"worktree":if kind=="isolatedCreate"{payload.clone()}else{Value::Null},"checkpointId":payload.get("checkpointId"),"rows":rows(db)?,"replayed":replayed,"opId":stamp.op_id}),
    )
}
fn register(core: &mut Core, stamp: &Stamp, owner: &str, payload: &Value) -> Result<(), String> {
    let root = Arc::new(Anchor::open(Path::new(
        payload["path"].as_str().ok_or_else(stale)?,
    ))?);
    let live: std::collections::HashSet<String> = core
        .prompt_preparations
        .roots
        .values()
        .filter(|r| owners::is_open(core, &r.owner))
        .map(|r| r.owner.clone())
        .collect();
    core.prompt_preparations
        .roots
        .retain(|_, r| live.contains(&r.owner));
    let key = (stamp.device.clone(), stamp.op_id.clone());
    if core.prompt_preparations.roots.len() >= 256
        && !core.prompt_preparations.roots.contains_key(&key)
    {
        return Err(work::refused("busy"));
    }
    if let Some(previous) = core.prompt_preparations.roots.get(&key) {
        if previous.owner != owner || previous.root.identity()? != root.identity()? {
            return Err(stale());
        }
        previous.root.validate()?;
        return Ok(());
    }
    core.prompt_preparations.roots.insert(
        key,
        PreparedRoot {
            owner: owner.into(),
            root,
            display_root: payload["path"].as_str().ok_or_else(stale)?.to_string(),
            thread: None,
        },
    );
    Ok(())
}
/// A provisional isolated root must match actual provider input, not a viewer path.
pub(super) fn verify_native_root(
    core: &Core,
    delivery: &work::RemoteDelivery,
    cwd: &str,
) -> Result<Option<String>, String> {
    let Some(root) = core
        .prompt_preparations
        .roots
        .get(&(delivery.device.clone(), delivery.op_id.clone()))
    else {
        return Ok(None);
    };
    if delivery.owner_handle.as_deref() != Some(root.owner.as_str()) {
        return Err(stale());
    }
    root.root.validate()?;
    let actual = Anchor::open(Path::new(cwd))?;
    if actual.identity()? != root.root.identity()? {
        return Err(stale());
    }
    Ok(Some(actual.identity()?))
}
pub(super) fn check_native_root(
    core: &Core,
    delivery: &work::RemoteDelivery,
    step: &str,
    thread: Option<&str>,
    verified: Option<&str>,
) -> Result<(), String> {
    let Some(root) = core
        .prompt_preparations
        .roots
        .get(&(delivery.device.clone(), delivery.op_id.clone()))
    else {
        return Ok(());
    };
    if delivery.owner_handle.as_deref() != Some(root.owner.as_str()) {
        return Err(stale());
    }
    root.root.validate()?;
    if matches!(
        step,
        "thread/start" | "thread/resume" | "claude_prompt" | "cursor_prompt"
    ) && verified != Some(root.root.identity()?.as_str())
    {
        return Err(stale());
    }
    if step == "turn/start" && root.thread.as_deref() != thread {
        return Err(stale());
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn remote_prompt_prepare(
    app: AppHandle,
    state: State<'_, RemoteState>,
    window: WebviewWindow,
    stamp: Stamp,
    owner_handle: String,
    kind: String,
    thread_id: Option<String>,
    label: Option<String>,
) -> Result<Value, String> {
    hostbridge::window_is_host(&window).map_err(|_| stale())?;
    let data = crate::release_qa::app_data_dir(&app).map_err(|_| stale())?;
    prepare(
        state.inner.clone(),
        data,
        stamp,
        owner_handle,
        kind,
        thread_id,
        label,
    )
    .await
}
async fn prepare(
    inner: Arc<Inner>,
    data: std::path::PathBuf,
    stamp: Stamp,
    owner: String,
    kind: String,
    thread: Option<String>,
    label: Option<String>,
) -> Result<Value, String> {
    if !matches!(
        kind.as_str(),
        "isolatedCreate" | "checkpointBefore" | "checkpointAfter" | "gitInit" | "isolatedDiscard"
    ) || label
        .as_ref()
        .is_some_and(|s| s.len() > 256 || s.contains('\0'))
    {
        return Err(stale());
    }
    let label = label.unwrap_or_else(|| "Remote turn".into());
    let lookup = inner.clone();
    let s = stamp.clone();
    let o = owner.clone();
    let t = thread.clone();
    let (op, source_root, root) = inner
        .read_db(move |db| {
            let op = commit::operation(db, &s)?;
            let core = lookup.lock();
            check(&core, &s, &o, &op)?;
            if !allowed(&op) {
                return Err(stale());
            }
            let (source, root) = execution(db, &core, &s, &o, t.as_deref())?;
            Ok((op, source, root))
        })
        .await?;
    if kind == "isolatedCreate" && (thread.is_some() || stamp.thread_id.is_some()) {
        return Err(stale());
    }
    if kind == "checkpointAfter" && thread.is_none() {
        return Err(stale());
    }
    let root = if matches!(kind.as_str(), "isolatedCreate" | "isolatedDiscard") {
        source_root.clone()
    } else {
        root
    };
    let root_for_anchor = root.clone();
    // A small no-follow anchor open is not a Studio read. Sharing Studio's
    // fail-fast four-read budget made unrelated reads randomly refuse starts.
    let anchor = tokio::time::timeout(
        std::time::Duration::from_secs(20),
        tauri::async_runtime::spawn_blocking(move || Anchor::open(Path::new(&root_for_anchor))),
    )
    .await
    .map_err(|_| stale())?
    .map_err(|_| stale())??;
    let source_key = std::fs::canonicalize(&source_root).map_err(|_| stale())?;
    let lock = {
        let mut core = inner.lock();
        let locks = &mut core.prompt_preparations.locks;
        locks.retain(|_, lock| lock.strong_count() > 0);
        if let Some(lock) = locks.get(&source_key).and_then(std::sync::Weak::upgrade) {
            lock
        } else {
            if locks.len() >= 256 {
                return Err(work::refused("busy"));
            }
            let lock = Arc::new(tokio::sync::Mutex::new(()));
            locks.insert(source_key, Arc::downgrade(&lock));
            lock
        }
    };
    let _preparation_guard = lock.lock_owned().await;
    let repo_lock = if kind == "gitInit" && super::git_metadata::locations(&anchor.path).is_err() {
        None
    } else {
        Some(crate::git_workspace::repository_lock(&anchor.path).await?)
    };
    let guard = match repo_lock {
        Some(lock) => Some(lock.lock_owned().await),
        None => None,
    };
    let s = stamp.clone();
    let o = owner.clone();
    let k = kind.clone();
    let t = thread.clone();
    let worker = inner.clone();
    let source_copy = source_root.clone();
    let root_copy = root.clone();
    let claim=super::finish_write(inner.enqueue_write(false,move|db|{
        let tx=db.transaction().map_err(|_|stale())?;let mut core=worker.lock();let op=commit::operation(&tx,&s)?;check(&core,&s,&o,&op)?;
        if let Some((id,state,payload))=saved(&tx,&s,&k)?{if state!="done"{return Err(uncertain());}
            let (prior_thread,prior_source):(Option<String>,String)=tx.query_row("SELECT thread_id,source_root FROM remote_prompt_preparations WHERE device=?1 AND op_id=?2 AND op_seq=?3 AND kind=?4",params![s.device,s.op_id,s.op_seq as i64,k],|row|Ok((row.get(0)?,row.get(1)?))).map_err(|_|stale())?;
            if prior_source!=source_copy||prior_thread!=t{return Err(stale());}if k=="isolatedCreate"{register(&mut core,&s,&o,&payload)?;}return Ok(Err(reply(&tx,&s,&k,&id,&payload,true)?));}
        let receipt=store::delivery_receipt(&tx,&s.device,&s.op_id,s.op_seq)?.ok_or_else(stale)?;
        if receipt["engineSteer"]==true||!matches!(receipt["disposition"].as_str(),Some("preparing"|"dispatched"))&&!(k=="checkpointAfter"&&receipt["disposition"]=="accepted"){return Err(stale());}
        if (k=="isolatedCreate"||(k=="checkpointBefore"&&t.is_none()))&&receipt.get("nativeSteps").and_then(Value::as_array).is_some_and(|a|!a.is_empty()){return Err(stale());}
        let actual=execution(&tx,&core,&s,&o,t.as_deref())?;
        if actual.0!=source_copy || (!matches!(k.as_str(),"isolatedCreate"|"isolatedDiscard")&&Anchor::open(Path::new(&actual.1))?.identity()?!=Anchor::open(Path::new(&root_copy))?.identity()?){return Err(stale());}
        let discard=if k=="isolatedDiscard"{
            if receipt.get("nativeSteps").and_then(Value::as_array).is_some_and(|steps|!steps.is_empty())||core.prompt_preparations.roots.get(&(s.device.clone(),s.op_id.clone())).is_none_or(|entry|entry.owner!=o||entry.thread.is_some()){return Err(stale());}
            Some(saved(&tx,&s,"isolatedCreate")?.filter(|(_,state,_)|state=="done").ok_or_else(stale)?.2)
        }else{None};
        let id=uuid::Uuid::new_v4().to_string();
        tx.execute("INSERT INTO remote_prompt_preparations(device,op_id,op_seq,kind,preparation_id,state,payload_json,source_root,execution_root,thread_id)VALUES(?1,?2,?3,?4,?5,'started','{}',?6,?7,?8)",params![s.device,s.op_id,s.op_seq as i64,k,id,source_copy,root_copy,t]).map_err(|_|stale())?;
        let before_id=saved(&tx,&s,"checkpointBefore")?.filter(|(_,state,_)|state=="done").and_then(|(_,_,p)|p["checkpointId"].as_str().map(str::to_owned));
        let checkpoint=if k=="checkpointAfter"{Some(before_id.ok_or_else(stale)?)}else if k=="isolatedDiscard"{before_id}else{None};
        tx.commit().map_err(|_|stale())?;Ok(Ok((id,checkpoint,discard)))
    })).await?;
    let (id, checkpoint, discard) = match claim {
        Err(replayed) => return Ok(replayed),
        Ok(claim) => claim,
    };
    let fence = domain::make_preparation_context(
        inner.clone(),
        stamp.clone(),
        op.clone(),
        anchor,
        meta(&stamp, &owner),
    );
    let run_kind = kind.clone();
    let run_id = id.clone();
    let run_root = root.clone();
    let run_label = label.clone();
    // Both workers retain the locks: dropping/canceling the awaiting IPC must
    // not release repository serialization while its blocking Git still runs.
    let _held_locks = Arc::new((_preparation_guard, guard));
    let worker_locks = _held_locks.clone();
    #[cfg(test)]
    let worker_gate = inner.lock().prompt_preparations.worker_gate.take();
    let payload=tauri::async_runtime::spawn_blocking(move||{
        let _locks=worker_locks;
        #[cfg(test)]
        if let Some((started,release))=worker_gate{let _=started.send(());release.recv_timeout(std::time::Duration::from_secs(10)).map_err(|_|uncertain())?;}
        domain::with_context(fence,||{
        if run_kind!="gitInit"&&crate::project_git::checkpoint_repo(&run_root)?!=std::fs::canonicalize(&run_root).map_err(|_|stale())?{return Err(stale());}
        match run_kind.as_str(){
            "isolatedCreate"=>serde_json::to_value(crate::project_git::worktree_create_sync_with_data(&data,&run_root,&run_label)?).map_err(|_|uncertain()),
            "isolatedDiscard"=>{let prior=discard.ok_or_else(stale)?;let removed=serde_json::to_value(crate::project_git::remote_worktree_remove_sync(&data.join("worktrees"),None,&run_root,prior["path"].as_str().ok_or_else(stale)?,prior["branch"].as_str().ok_or_else(stale)?,false,true,None)?).map_err(|_|uncertain())?;
                if removed["folderRemoved"]!=true{return Err(uncertain());}
                if let Some(id)=checkpoint{let repo=crate::project_git::checkpoint_repo(&run_root)?;for phase in ["before","after"]{let reference=crate::project_git::checkpoint_ref(&id,phase)?;crate::project_git::git_stdout(&repo,&["update-ref","-d",&reference],None)?;}}Ok(removed)},
            "gitInit"=>serde_json::to_value(crate::project_git::initialize_workspace_git_sync(&run_root)?).map_err(|_|uncertain()),
            "checkpointBefore"=>{let snapshot=serde_json::to_value(crate::project_git::capture_checkpoint_snapshot(&run_id,&run_root,"before",&run_label)?).map_err(|_|uncertain())?;Ok(json!({"checkpointId":run_id,"snapshot":snapshot}))},
            "checkpointAfter"=>{let checkpoint=checkpoint.ok_or_else(stale)?;let snapshot=serde_json::to_value(crate::project_git::capture_checkpoint_snapshot(&checkpoint,&run_root,"after",&run_label)?).map_err(|_|uncertain())?;let before=crate::project_git::checkpoint_ref(&checkpoint,"before")?;let after=crate::project_git::checkpoint_ref(&checkpoint,"after")?;let repo=crate::project_git::checkpoint_repo(&run_root)?;let(changed,additions,deletions)=crate::project_git::checkpoint_diff_stats(&repo,&before,&after)?;Ok(json!({"checkpointId":checkpoint,"snapshot":snapshot,"changedFiles":changed,"additions":additions,"deletions":deletions}))},_=>Err(stale())}
    })}).await.map_err(|_|uncertain())??;
    // Native Git may have run. A failed final commit stays started/uncertain:
    // never re-run helpers, accept the prompt, or silently use local fallback.
    let s = stamp.clone();
    let o = owner;
    let k = kind;
    let t = thread;
    let worker = inner.clone();
    super::finish_write(inner.enqueue_write(false,move|db|{
        let tx=db.transaction().map_err(|_|uncertain())?;let mut core=worker.lock();check(&core,&s,&o,&op)?;
        if source(&tx,&s)?!=source_root{return Err(uncertain());}
        if k.starts_with("checkpoint")&&t.is_some(){save_checkpoint(&tx,&s,&root,t.as_deref().ok_or_else(stale)?,&label,&k,&payload)?;}
        tx.execute("UPDATE remote_prompt_preparations SET state='done',payload_json=?5 WHERE device=?1 AND op_id=?2 AND op_seq=?3 AND kind=?4",params![s.device,s.op_id,s.op_seq as i64,k,payload.to_string()]).map_err(|_|uncertain())?;
        if k=="isolatedCreate"{register(&mut core,&s,&o,&payload)?;}
        if k=="checkpointBefore"&&t.is_none()&&!core.prompt_preparations.roots.contains_key(&(s.device.clone(),s.op_id.clone())){register(&mut core,&s,&o,&json!({"path":root}))?;}
        if k=="isolatedDiscard"{
            if payload["folderRemoved"]!=true{return Err(uncertain());}
            tx.execute("UPDATE remote_prompt_preparations SET state='discarded' WHERE device=?1 AND op_id=?2 AND op_seq=?3 AND kind IN('isolatedCreate','checkpointBefore')",params![s.device,s.op_id,s.op_seq as i64]).map_err(|_|uncertain())?;
            core.prompt_preparations.roots.remove(&(s.device.clone(),s.op_id.clone()));
        }
        let result=reply(&tx,&s,&k,&id,&payload,false)?;tx.commit().map_err(|_|uncertain())?;Ok(result)
    })).await
}
fn save_checkpoint(
    db: &Connection,
    stamp: &Stamp,
    root: &str,
    thread: &str,
    label: &str,
    kind: &str,
    payload: &Value,
) -> Result<(), String> {
    let id = payload["checkpointId"].as_str().ok_or_else(stale)?;
    let saved_records = row(db, "kiwi.checkpoints")?;
    let mut records = if saved_records.is_null() {
        vec![]
    } else {
        saved_records.as_array().cloned().ok_or_else(stale)?
    };
    let mut heads = map(row(db, "kiwi.checkpointHeads")?)?;
    let key = root.replace('\\', "/").trim_end_matches('/').to_string();
    let now = crate::unix_timestamp_ms();
    if kind == "checkpointBefore" {
        if records.iter().any(|r| r["id"] == id) {
            return Err(stale());
        }
        let parent = heads.get(&key).cloned().unwrap_or(Value::Null);
        records.insert(0,json!({"id":id,"threadId":thread,"workspacePath":root,"repoRoot":payload["snapshot"]["repoRoot"],"label":label,"createdAt":now,"status":"running","remotePrepared":true,"beforeCommit":payload["snapshot"]["commit"],"fileCount":payload["snapshot"]["fileCount"],"branch":payload["snapshot"]["branch"],"head":payload["snapshot"]["head"],"parentId":parent["checkpointId"],"parentPosition":parent["position"]}));
        heads.insert(key, json!({"checkpointId":id,"position":"before"}));
    } else {
        let record = records
            .iter_mut()
            .find(|r| {
                r["id"] == id
                    && r["threadId"] == thread
                    && r["workspacePath"] == root
                    && r["status"] == "running"
            })
            .ok_or_else(stale)?;
        record["status"] = json!("ready");
        record["afterCommit"] = payload["snapshot"]["commit"].clone();
        record["completedAt"] = json!(now);
        for field in ["changedFiles", "additions", "deletions"] {
            record[field] = payload[field].clone();
        }
        if heads.get(&key).is_some_and(|h| h["checkpointId"] == id) {
            heads.insert(key, json!({"checkpointId":id,"position":"after"}));
        }
    }
    commit::write_value(db, "kiwi.checkpoints", &json!(records))?;
    commit::write_value(db, "kiwi.checkpointHeads", &json!(heads))?;
    let _ = stamp;
    Ok(())
}

#[tauri::command]
pub(crate) async fn remote_prompt_preparation_bind(
    state: State<'_, RemoteState>,
    window: WebviewWindow,
    stamp: Stamp,
    owner_handle: String,
    thread_id: String,
) -> Result<Value, String> {
    hostbridge::window_is_host(&window).map_err(|_| stale())?;
    bind(state.inner.clone(), stamp, owner_handle, thread_id).await
}
async fn bind(
    inner: Arc<Inner>,
    stamp: Stamp,
    owner_handle: String,
    thread_id: String,
) -> Result<Value, String> {
    let worker = inner.clone();
    super::finish_write(inner.enqueue_write(false,move|db|{
        let tx=db.transaction().map_err(|_|stale())?;let mut core=worker.lock();let op=commit::operation(&tx,&stamp)?;check(&core,&stamp,&owner_handle,&op)?;
        if !owners::preparation_thread(&core,&meta(&stamp,&owner_handle),&thread_id){return Err(stale());}
        let isolated=saved(&tx,&stamp,"isolatedCreate")?;
        if isolated.as_ref().is_some_and(|(_,state,_)|state!="done"){return Err(stale());}
        let before=saved(&tx,&stamp,"checkpointBefore")?;
        if isolated.is_none()&&before.as_ref().is_none_or(|(_,state,_)|state!="done"){return Err(stale());}
        let source=source(&tx,&stamp)?;let mut trees=map(row(&tx,"kiwi.threadWorktrees")?)?;let mut bindings=map(row(&tx,"kiwi.threadProjects")?)?;
        let entry=core.prompt_preparations.roots.get_mut(&(stamp.device.clone(),stamp.op_id.clone())).ok_or_else(stale)?;entry.root.validate()?;if entry.owner!=owner_handle||entry.thread.as_ref().is_some_and(|id|id!=&thread_id){return Err(stale());}
        if let Some((_,_,payload))=&isolated{
            if let Some(prior)=trees.get(&thread_id){if prior["path"]!=payload["path"]||prior["projectId"].as_str()!=stamp.workspace_id.as_deref(){return Err(stale());}}
            else{trees.insert(thread_id.clone(),json!({"threadId":thread_id,"projectId":stamp.workspace_id,"projectPath":source,"path":payload["path"],"branch":payload["branch"],"baseCommit":payload["baseCommit"],"gitDir":payload["gitDir"],"createdAt":crate::unix_timestamp_ms(),"status":"active"}));}
        }
        if bindings.get(&thread_id).is_some_and(|v|v!=&json!(source)){return Err(stale());}bindings.insert(thread_id.clone(),json!(source));
        if let Some((_,state,payload))=before{if state=="done"{
            let checkpoints=row(&tx,"kiwi.checkpoints")?;let existing=checkpoints.as_array().and_then(|records|records.iter().find(|r|r["id"]==payload["checkpointId"]));
            if let Some(existing)=existing{if existing["threadId"]!=thread_id{return Err(stale());}}
            else{let path=&entry.display_root;save_checkpoint(&tx,&stamp,path,&thread_id,"Remote turn","checkpointBefore",&payload)?;}
        }}
        commit::write_value(&tx,"kiwi.threadWorktrees",&json!(trees))?;commit::write_value(&tx,"kiwi.threadProjects",&json!(bindings))?;tx.commit().map_err(|_|uncertain())?;entry.thread=Some(thread_id);Ok(json!({"bound":true,"rows":rows(db)?}))
    })).await
}

#[tauri::command]
pub(crate) async fn remote_prompt_preparation_discard(
    app: AppHandle,
    state: State<'_, RemoteState>,
    window: WebviewWindow,
    stamp: Stamp,
    owner_handle: String,
) -> Result<Value, String> {
    hostbridge::window_is_host(&window).map_err(|_| stale())?;
    let data = crate::release_qa::app_data_dir(&app).map_err(|_| stale())?;
    prepare(
        state.inner.clone(),
        data,
        stamp,
        owner_handle,
        "isolatedDiscard".into(),
        None,
        None,
    )
    .await
}

pub(super) fn retire_owner(core: &mut Core, owner: &str) {
    core.prompt_preparations
        .roots
        .retain(|_, root| root.owner != owner);
}
pub(super) fn retire_device(core: &mut Core, device: &str) {
    core.prompt_preparations
        .roots
        .retain(|(peer, _), _| peer != device);
}
pub(super) fn invalidate(core: &mut Core) {
    core.prompt_preparations.roots.clear();
}

#[cfg(test)]
#[path = "prompt_preparation_tests.rs"]
mod tests;
