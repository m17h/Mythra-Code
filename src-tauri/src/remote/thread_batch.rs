//! Bulk rows use distinct durable instructions, not one provider receipt N times.
use super::{
    commit::{self, Stamp},
    hostbridge, instructions, store,
    threads::{self, Book},
    work, RemoteState,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, State, WebviewWindow};
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Target {
    thread_id: String,
    provider: String,
    root: String,
}
fn stale() -> String {
    work::refused("stale_target")
}
fn action(op: &str) -> Result<&'static str, String> {
    match op {
        "thread.archiveMany" => Ok("thread.archive"),
        "thread.deleteMany" => Ok("thread.delete"),
        _ => Err(work::refused("unsupported")),
    }
}
#[tauri::command]
pub(crate) async fn remote_thread_batch_snapshot(
    state: State<'_, RemoteState>,
    window: WebviewWindow,
    stamp: Stamp,
) -> Result<Value, String> {
    hostbridge::window_is_host(&window).map_err(|_| stale())?;
    let inner = state.inner.clone();
    state
        .inner
        .read_db(move |db| {
            let op = commit::operation(db, &stamp)?;
            stamp.check(&inner.lock(), &op)?;
            Ok(json!({"version":1,"rows":threads::rows(db,action(&op)?)?}))
        })
        .await
}
#[tauri::command]
pub(crate) async fn remote_thread_batch_execute(
    app: AppHandle,
    state: State<'_, RemoteState>,
    window: WebviewWindow,
    stamp: Stamp,
    targets: Vec<Target>,
    args: Value,
    bookkeeping: Book,
) -> Result<Value, String> {
    hostbridge::window_is_host(&window).map_err(|_| stale())?;
    if targets.is_empty()
        || targets.len() > 100
        || serde_json::to_vec(&targets).map_or(true, |b| b.len() > 512 * 1024)
    {
        return Err(stale());
    }
    let mut ids = std::collections::HashSet::new();
    for t in &targets {
        if t.thread_id.is_empty()
            || t.thread_id.len() > 256
            || !ids.insert(t.thread_id.clone())
            || !matches!(
                t.provider.as_str(),
                "openai" | "openrouter" | "lmstudio" | "claude" | "cursor"
            )
        {
            return Err(stale());
        }
    }
    let inner = state.inner.clone();
    tauri::async_runtime::spawn(async move {
        execute(app, inner, stamp, targets, args, bookkeeping).await
    })
    .await
    .map_err(|_| stale())?
}
async fn execute(
    app: AppHandle,
    inner: std::sync::Arc<super::Inner>,
    stamp: Stamp,
    targets: Vec<Target>,
    args: Value,
    book: Book,
) -> Result<Value, String> {
    let s = stamp.clone();
    let worker = inner.clone();
    let plan = targets.clone();
    let a = args.clone();
    let prepared=super::finish_write(inner.enqueue_write(false,move|db|{
        let op=commit::operation(db,&s)?;let action=action(&op)?;
        if let Some(result)=commit::prior(db,&s)?{return Ok(Err(json!({"result":result,"rows":threads::rows(db,action)?,"replayed":true})));}
        let tx=db.transaction().map_err(|_|stale())?;threads::verify(&tx,action,&book)?;
        let core=worker.lock();s.check(&core,&op)?;
        let mut receipt=store::delivery_receipt(&tx,&s.device,&s.op_id,s.op_seq)?.ok_or_else(stale)?;
        if receipt["batchStarted"]==true{return Err("MYTHRA_DELIVERY_UNCERTAIN: This batch may still be settling. Refresh its conversations before trying again.".into());}
        let mut children=Vec::new();
        for (index,t) in plan.iter().enumerate(){
            let child=instructions::child(&tx,&s,&format!("row-{index}"),action,Some(&t.thread_id),&json!(t))?;
            threads::eligibility(&tx,&child,&t.provider,&t.root,action,&a)?;
            if super::owners::thread_busy(&core,&t.thread_id){return Err(work::refused("busy"));}
            children.push(child);
        }
        receipt["batchStarted"]=json!(true);receipt["disposition"]=json!("dispatched");
        tx.execute("UPDATE remote_op_journal SET delivery_json=?4 WHERE device_fingerprint=?1 AND op_id=?2 AND op_seq=?3",rusqlite::params![s.device,s.op_id,s.op_seq as i64,receipt.to_string()]).map_err(|_|stale())?;
        tx.commit().map_err(|_|stale())?;Ok(Ok((op,action.to_owned(),children)))
    })).await?;
    let (op, action, children) = match prepared {
        Ok(p) => p,
        Err(replay) => return Ok(replay),
    };
    let mut completed = Vec::new();
    let mut failure = false;
    for (target, child) in targets.iter().zip(children) {
        let o = action.clone();
        let current = inner
            .read_db(move |db| {
                Ok(Book {
                    version: 1,
                    rows: threads::rows(db, &o)?,
                })
            })
            .await?;
        match threads::execute(
            app.clone(),
            inner.clone(),
            child,
            target.provider.clone(),
            target.root.clone(),
            args.clone(),
            current,
        )
        .await
        {
            Ok(_) => completed.push(target.thread_id.clone()),
            Err(_) => {
                failure = true;
                break;
            }
        }
    }
    let remaining: Vec<_> = targets
        .iter()
        .filter(|t| !completed.contains(&t.thread_id))
        .map(|t| t.thread_id.clone())
        .collect();
    let worker = inner.clone();
    super::finish_write(inner.enqueue_write(false,move|db|{
        let tx=db.transaction().map_err(|_|stale())?;
        let core=worker.lock();let current=stamp.check(&core,&op).is_ok();
        let result=json!({"opId":stamp.op_id,"state":if failure||!current{"uncertain"}else{"accepted"},"workspaceId":stamp.workspace_id,"completedThreadIds":completed,"remainingThreadIds":remaining});
        // Saving the outcome isn't new work. A revoked grant must not erase
        // already committed child effects or manufacture a safe retry.
        commit::complete(&tx,&stamp,&op,&result,false)?;
        let rows=threads::rows(&tx,&action)?;tx.commit().map_err(|_|stale())?;
        Ok(json!({"result":result,"rows":rows,"replayed":false}))
    })).await
}
