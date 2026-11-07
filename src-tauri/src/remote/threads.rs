//! Typed thread effects, with one native journal latch and atomic host metadata.
//! Caller owns normal persistence flush/adoption; no App callbacks or generic RPC.
use super::{
    commit::{self, Stamp},
    hostbridge, store, work, RemoteState,
};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, State, WebviewWindow};
fn stale() -> String {
    work::refused("stale_target")
}
fn uncertain() -> String {
    "MYTHRA_DELIVERY_UNCERTAIN: This conversation may already have changed. Refresh it before trying again.".into()
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Book {
    version: u32,
    rows: Vec<Value>,
}
fn keys(op: &str) -> Result<Vec<&'static str>, String> {
    let mut k = vec![
        "kiwi.knownThreads",
        "kiwi.threadProjects",
        "kiwi.archivedThreads",
        "kiwi.threadWorktrees",
    ];
    match op {
        "thread.rename" | "thread.archive" | "thread.restore" | "thread.compact"
        | "thread.rollback" => {}
        "thread.fork" => k.extend([
            "kiwi.threadModels",
            "kiwi.threadReasoning",
            "kiwi.threadSubagentSettings",
            "kiwi.threadExecutionPreferences",
        ]),
        "thread.delete" => k.extend([
            "kiwi.threadModels",
            "kiwi.threadReasoning",
            "kiwi.threadSubagentSettings",
            "kiwi.threadExecutionPreferences",
            "kiwi.pinnedThreads",
            "kiwi.queuedTurns",
            "kiwi.parentRuns",
            "kiwi.checkpoints",
            "kiwi.checkpointHeads",
            "kiwi.turnDurations",
            "kiwi.threadPullRequests",
            "kiwi.childAgentPolicies",
            "kiwi.childAgentLinks",
            "kiwi.nativeAgentLinks",
            "kiwi.childAgentMailbox",
            "kiwi.threadHandoffs",
            "kiwi.pendingHandoff",
            "kiwi.agentQuestions",
            "kiwi.turnContextReceipts",
        ]),
        _ => return Err(work::refused("unsupported")),
    };
    Ok(k)
}
fn rows(db: &Connection, op: &str) -> Result<Vec<Value>, String> {
    keys(op)?.iter().map(|k| commit::state_row(db, k)).collect()
}
fn verify(db: &Connection, op: &str, book: &Book) -> Result<(), String> {
    let keys = keys(op)?;
    if book.version != 1
        || book.rows.len() != keys.len()
        || serde_json::to_vec(book).map_or(true, |b| b.len() > 4 * 1024 * 1024)
    {
        return Err(stale());
    }
    for key in keys {
        let matches: Vec<_> = book.rows.iter().filter(|r| r["key"] == key).collect();
        if matches.len() != 1 || *matches[0] != commit::state_row(db, key)? {
            return Err(stale());
        }
    }
    Ok(())
}
fn value(db: &Connection, key: &str) -> Result<Value, String> {
    Ok(commit::state_row(db, key)?["value"].clone())
}
fn object(v: Value) -> Result<serde_json::Map<String, Value>, String> {
    if v.is_null() {
        Ok(Default::default())
    } else {
        v.as_object().cloned().ok_or_else(stale)
    }
}
fn array(v: Value) -> Result<Vec<Value>, String> {
    if v.is_null() {
        Ok(vec![])
    } else {
        v.as_array().cloned().ok_or_else(stale)
    }
}
fn path_eq(a: &str, b: &str) -> bool {
    match (std::fs::canonicalize(a), std::fs::canonicalize(b)) {
        (Ok(a), Ok(b)) => a == b,
        _ => false,
    }
}
// A removed isolation checkout may no longer exist. This comparison is ONLY
// against that thread's durable removed-worktree record, never viewer input.
fn saved_path_eq(a: &str, b: &str) -> bool {
    use std::path::{Component, Path};
    let safe = |p: &str| {
        Path::new(p).is_absolute()
            && !Path::new(p)
                .components()
                .any(|c| matches!(c, Component::ParentDir | Component::CurDir))
    };
    if !safe(a) || !safe(b) {
        return false;
    }
    #[cfg(windows)]
    {
        a.replace('\\', "/")
            .trim_end_matches('/')
            .eq_ignore_ascii_case(b.replace('\\', "/").trim_end_matches('/'))
    }
    #[cfg(not(windows))]
    {
        Path::new(a) == Path::new(b)
    }
}
fn removed_checkout(db: &Connection, stamp: &Stamp, op: &str) -> Result<Option<String>, String> {
    if op != "thread.delete" {
        return Ok(None);
    }
    Ok(object(value(db, "kiwi.threadWorktrees")?)?
        .get(stamp.thread_id.as_deref().ok_or_else(stale)?)
        .filter(|row| row["status"] == "removed")
        .and_then(|row| row["path"].as_str())
        .map(str::to_owned))
}
fn binding(db: &Connection, stamp: &Stamp, provider: &str, root: &str) -> Result<Value, String> {
    let id = stamp
        .thread_id
        .as_deref()
        .filter(|s| !s.is_empty())
        .ok_or_else(stale)?;
    let receipt = store::delivery_receipt(db, &stamp.device, &stamp.op_id, stamp.op_seq)?
        .ok_or_else(stale)?;
    if receipt.get("threadId").and_then(Value::as_str) != Some(id)
        || receipt.get("workspaceId").and_then(Value::as_str) != stamp.workspace_id.as_deref()
    {
        return Err(stale());
    }
    let known = object(value(db, "kiwi.knownThreads")?)?;
    let archived = array(value(db, "kiwi.archivedThreads")?)?;
    let record = known
        .get(id)
        .cloned()
        .or_else(|| archived.iter().find(|r| r["id"] == id).cloned())
        .ok_or_else(stale)?;
    if record
        .get("modelProvider")
        .or_else(|| record.get("provider"))
        .and_then(Value::as_str)
        .is_some_and(|p| !provider_matches(provider, p))
    {
        return Err(stale());
    }
    let bindings = object(value(db, "kiwi.threadProjects")?)?;
    let bound = bindings
        .get(id)
        .and_then(Value::as_str)
        .or_else(|| {
            record
                .get("cwd")
                .or_else(|| record.get("path"))
                .and_then(Value::as_str)
        })
        .ok_or_else(stale)?;
    let worktrees = object(value(db, "kiwi.threadWorktrees")?)?;
    let execution = worktrees
        .get(id)
        .filter(|r| r.get("status").and_then(Value::as_str) != Some("removed"))
        .and_then(|r| r.get("path"))
        .and_then(Value::as_str)
        .unwrap_or(bound);
    if !path_eq(execution, root) {
        return Err(stale());
    }
    let workspace = stamp.workspace_id.as_deref().ok_or_else(stale)?;
    if workspace != "openkiwi-normal-chats"
        && !array(value(db, "kiwi.projects")?)?.iter().any(|p| {
            p["id"] == workspace
                && p.get("path")
                    .and_then(Value::as_str)
                    .is_some_and(|path| path_eq(path, bound))
        })
    {
        return Err(stale());
    }
    Ok(record)
}
fn eligibility(
    db: &Connection,
    stamp: &Stamp,
    provider: &str,
    root: &str,
    op: &str,
    args: &Value,
) -> Result<Value, String> {
    let record = binding(db, stamp, provider, root)?;
    let id = stamp.thread_id.as_deref().ok_or_else(stale)?;
    let archived = array(value(db, "kiwi.archivedThreads")?)?
        .iter()
        .any(|r| r["id"] == id);
    if (op == "thread.restore" && !archived)
        || (matches!(
            op,
            "thread.archive"
                | "thread.rename"
                | "thread.fork"
                | "thread.compact"
                | "thread.rollback"
        ) && archived)
    {
        return Err(stale());
    }
    if matches!(op, "thread.delete" | "thread.fork")
        && object(value(db, "kiwi.threadWorktrees")?)?
            .get(id)
            .is_some_and(|r| r.get("status").and_then(Value::as_str) != Some("removed"))
    {
        return Err(work::refused("busy"));
    }
    if op == "thread.delete" && args.get("confirmed") != Some(&json!(true)) {
        return Err(stale());
    }
    if op == "thread.rename"
        && !args.get("name").and_then(Value::as_str).is_some_and(|s| {
            !s.trim().is_empty() && s.chars().count() <= 256 && !s.chars().any(char::is_control)
        })
    {
        return Err(stale());
    }
    if op == "thread.rollback"
        && (args.get("confirmed") != Some(&json!(true))
            || args.get("numTurns").and_then(Value::as_u64) != Some(1))
    {
        return Err(stale());
    }
    Ok(record)
}
#[tauri::command]
pub(crate) async fn remote_thread_snapshot(
    state: State<'_, RemoteState>,
    window: WebviewWindow,
    stamp: Stamp,
    provider: String,
    root: String,
) -> Result<Value, String> {
    hostbridge::window_is_host(&window).map_err(|_| stale())?;
    let inner = state.inner.clone();
    state
        .inner
        .read_db(move |db| {
            let op = commit::operation(db, &stamp)?;
            let core = inner.lock();
            stamp.check(&core, &op)?;
            binding(db, &stamp, &provider, &root)?;
            Ok(json!({"version":1,"rows":rows(db,&op)?}))
        })
        .await
}
#[tauri::command]
pub(crate) async fn remote_thread_execute(
    app: AppHandle,
    state: State<'_, RemoteState>,
    window: WebviewWindow,
    stamp: Stamp,
    provider: String,
    root: String,
    args: Value,
    bookkeeping: Book,
) -> Result<Value, String> {
    hostbridge::window_is_host(&window).map_err(|_| stale())?;
    if !matches!(
        provider.as_str(),
        "openai" | "openrouter" | "lmstudio" | "claude" | "cursor"
    ) || serde_json::to_vec(&args).map_or(true, |b| b.len() > 128 * 1024)
    {
        return Err(stale());
    }
    let inner = state.inner.clone();
    // Detached owner: abandoning an invoke cannot abandon metadata after a
    // confirmed provider effect. Never re-enter a latched helper on retry.
    tauri::async_runtime::spawn(async move {
        execute(app, inner, stamp, provider, root, args, bookkeeping).await
    })
    .await
    .map_err(|_| uncertain())?
}
async fn execute(
    app: AppHandle,
    inner: std::sync::Arc<super::Inner>,
    stamp: Stamp,
    provider: String,
    root: String,
    args: Value,
    book: Book,
) -> Result<Value, String> {
    let op = {
        let copy = stamp.clone();
        inner
            .read_db(move |db| commit::operation(db, &copy))
            .await?
    };
    keys(&op)?;
    let s = stamp.clone();
    let o = op.clone();
    if let Some(result) = inner
        .read_db(move |db| {
            commit::prior(db, &s)?
                .map(|r| Ok(json!({"result":r,"rows":rows(db,&o)?,"replayed":true})))
                .transpose()
        })
        .await?
    {
        return Ok(result);
    }
    let local = matches!(provider.as_str(), "claude" | "cursor");
    if stamp.workspace_id.as_deref() == Some("openkiwi-normal-chats")
        && !crate::normal_chat::contains(&app, &root)?
    {
        return Err(stale());
    }
    if local
        && matches!(
            op.as_str(),
            "thread.fork" | "thread.compact" | "thread.rollback"
        )
    {
        return Err(work::refused("unsupported"));
    }
    let replay = {
        let s = stamp.clone();
        let o = op.clone();
        let p = provider.clone();
        let r = root.clone();
        let a = args.clone();
        let b = book.clone();
        let worker = inner.clone();
        inner
            .read_db(move |db| {
                if let Some(result) = commit::prior(db, &s)? {
                    return Ok(Some(
                        json!({"result":result,"rows":rows(db,&o)?,"replayed":true}),
                    ));
                }
                verify(db, &o, &b)?;
                eligibility(db, &s, &p, &r, &o, &a)?;
                let core = worker.lock();
                s.check(&core, &o)?;
                Ok(None)
            })
            .await?
    };
    if let Some(result) = replay {
        return Ok(result);
    }
    let proof = if local {
        None
    } else {
        let s = stamp.clone();
        let o = op.clone();
        let removed = inner
            .read_db(move |db| removed_checkout(db, &s, &o))
            .await?;
        Some(
            crate::remote_thread_provider_proof(
                &app,
                &provider,
                stamp.thread_id.as_deref().ok_or_else(stale)?,
                &root,
                &op,
                removed.as_deref(),
            )
            .await?,
        )
    };
    let worker = inner.clone();
    let s = stamp.clone();
    let o = op.clone();
    let p = provider.clone();
    let r = root.clone();
    let a = args.clone();
    let b = book.clone();
    let proof_meta = proof.as_ref().map(|p| p.metadata()).transpose()?;
    let saved = super::finish_write(inner.enqueue_write(false, move |db| {
        if let Some(result) = commit::prior(db, &s)? {
            return Ok(Some(
                json!({"result":result,"rows":rows(db,&o)?,"replayed":true}),
            ));
        }
        verify(db, &o, &b)?;
        eligibility(db, &s, &p, &r, &o, &a)?;
        let core = worker.lock();
        s.check(&core, &o)?;
        if o != "thread.rename"
            && super::owners::thread_busy(&core, s.thread_id.as_deref().ok_or_else(stale)?)
        {
            return Err(work::refused("busy"));
        }
        if local {
            crate::persistence::remote_prepare_local_transcript(
                db,
                &p,
                s.thread_id.as_deref().ok_or_else(stale)?,
            )?;
        }
        let mut receipt =
            store::delivery_receipt(db, &s.device, &s.op_id, s.op_seq)?.ok_or_else(stale)?;
        if receipt.get("threadEffectStarted") == Some(&json!(true)) {
            return Err(uncertain());
        }
        receipt["threadEffectStarted"] = json!(true);
        receipt["grantRevision"] = json!(s.grant_revision);
        receipt["nativeThreadRoot"] = json!(r);
        receipt["nativeThreadProvider"] = json!(p);
        receipt["disposition"] = json!("dispatched");
        if let Some(meta) = proof_meta {
            receipt["nativeThreadProof"] = meta;
        }
        store::save_delivery_receipt(db, &s.device, &s.op_id, s.op_seq, &receipt)?;
        Ok(None)
    }))
    .await?;
    if let Some(result) = saved {
        return Ok(result);
    }
    let effect = if let Some(proof) = &proof {
        crate::remote_thread_provider_apply(&app, proof, stamp.meta(), &op, &root, &args).await?
    } else {
        Value::Null
    };
    let worker = inner.clone();
    super::finish_write(inner.enqueue_write(false, move |db| {
        let mut apply = || {
            finish_thread(
                db, &worker, &stamp, &provider, &root, &op, &args, &book, &effect, local,
            )
        };
        if local {
            crate::remote_local_thread_gate(
                &app,
                &provider,
                stamp.thread_id.as_deref().ok_or_else(stale)?,
                &op,
                apply,
            )
        } else if let Some(proof) = &proof {
            proof.commit_gate(apply)
        } else {
            apply()
        }
    }))
    .await
}
fn local_effect(
    db: &Connection,
    provider: &str,
    id: &str,
    root: &str,
    op: &str,
    args: &Value,
    removed: Option<&str>,
) -> Result<(), String> {
    let raw: Option<String> = db
        .query_row(
            "SELECT thread_json FROM local_transcript_meta WHERE provider=?1 AND thread_id=?2",
            params![provider, id],
            |r| r.get(0),
        )
        .optional()
        .map_err(|_| stale())?;
    let mut thread: Value =
        serde_json::from_str(&raw.ok_or_else(|| work::refused("thread_unavailable"))?)
            .map_err(|_| stale())?;
    if thread["id"] != id
        || !thread
            .get("cwd")
            .and_then(Value::as_str)
            .is_some_and(|cwd| {
                path_eq(cwd, root) || removed.is_some_and(|saved| saved_path_eq(cwd, saved))
            })
    {
        return Err(stale());
    }
    if op == "thread.rename" {
        thread["name"] = args["name"].clone();
        crate::persistence::remote_remember_thread_name(
            db,
            provider,
            id,
            args["name"].as_str().ok_or_else(stale)?,
        )?;
        db.execute("UPDATE local_transcript_meta SET thread_json=?3,updated_at=MAX(updated_at+1,?4) WHERE provider=?1 AND thread_id=?2",params![provider,id,thread.to_string(),crate::unix_timestamp_ms()]).map_err(|_|uncertain())?;
    }
    if op == "thread.delete" {
        let key = if provider == "claude" {
            format!("kiwi.claudeThread.{id}")
        } else {
            format!("kiwi.cursorThread.{id}")
        };
        db.execute("DELETE FROM app_state WHERE key=?1", [key])
            .map_err(|_| uncertain())?;
        for table in [
            "local_transcript_tail_state",
            "local_transcript_chunks",
            "local_transcript_meta",
        ] {
            db.execute(
                &format!("DELETE FROM {table} WHERE provider=?1 AND thread_id=?2"),
                params![provider, id],
            )
            .map_err(|_| uncertain())?;
        }
        db.execute_batch("CREATE TABLE IF NOT EXISTS remote_deleted_transcripts(provider TEXT NOT NULL,thread_id TEXT NOT NULL,PRIMARY KEY(provider,thread_id));").map_err(|_|uncertain())?;
        db.execute(
            "INSERT OR IGNORE INTO remote_deleted_transcripts VALUES(?1,?2)",
            params![provider, id],
        )
        .map_err(|_| uncertain())?;
    }
    Ok(())
}
fn adopt_effect(
    db: &Connection,
    stamp: &Stamp,
    provider: &str,
    root: &str,
    op: &str,
    args: &Value,
    previous: &Value,
    effect: &Value,
) -> Result<String, String> {
    let id = stamp.thread_id.as_deref().ok_or_else(stale)?;
    let mut known = object(value(db, "kiwi.knownThreads")?)?;
    let mut archived = array(value(db, "kiwi.archivedThreads")?)?;
    let mut target = id.to_owned();
    match op {
        "thread.rename" => {
            let record = known.get_mut(id).ok_or_else(stale)?;
            record["name"] = args["name"].clone();
        }
        "thread.archive" => {
            archived.retain(|r| r["id"] != id);
            archived.insert(0,json!({"id":id,"label":previous.get("name").or_else(||previous.get("preview")).and_then(Value::as_str).unwrap_or("Untitled thread"),"path":object(value(db,"kiwi.threadProjects")?)?.get(id).and_then(Value::as_str).unwrap_or(root),"provider":provider,"archivedAt":crate::unix_timestamp_ms()}));
        }
        "thread.restore" => {
            archived.retain(|r| r["id"] != id);
            if !known.contains_key(id) {
                let actual = if let Some(thread) = effect.get("thread").filter(|v| v["id"] == id) {
                    thread.clone()
                } else if matches!(provider, "claude" | "cursor") {
                    let raw:String=db.query_row("SELECT thread_json FROM local_transcript_meta WHERE provider=?1 AND thread_id=?2",params![provider,id],|r|r.get(0)).map_err(|_|stale())?;
                    serde_json::from_str(&raw).map_err(|_| stale())?
                } else {
                    return Err(uncertain());
                };
                if actual["id"] != id {
                    return Err(stale());
                }
                let mut sidebar = serde_json::Map::new();
                for key in [
                    "id",
                    "name",
                    "preview",
                    "cwd",
                    "updatedAt",
                    "createdAt",
                    "modelProvider",
                    "status",
                ] {
                    if let Some(v) = actual.get(key) {
                        sidebar.insert(key.into(), v.clone());
                    }
                }
                known.insert(id.into(), Value::Object(sidebar));
            }
        }
        "thread.fork" => {
            let fork = effect
                .get("thread")
                .filter(|t| t.is_object())
                .ok_or_else(uncertain)?;
            target = fork
                .get("id")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty() && *s != id)
                .ok_or_else(uncertain)?
                .into();
            if known.contains_key(&target) {
                return Err(stale());
            }
            let mut sidebar = serde_json::Map::new();
            for key in [
                "id",
                "name",
                "preview",
                "cwd",
                "updatedAt",
                "createdAt",
                "modelProvider",
                "status",
            ] {
                if let Some(v) = fork.get(key) {
                    sidebar.insert(key.into(), v.clone());
                }
            }
            known.insert(target.clone(), Value::Object(sidebar));
            for key in [
                "kiwi.threadProjects",
                "kiwi.threadModels",
                "kiwi.threadReasoning",
                "kiwi.threadSubagentSettings",
            ] {
                let mut map = object(value(db, key)?)?;
                if key == "kiwi.threadSubagentSettings" {
                    let mut defaults =
                        json!({"enabled":false,"engine":"mythra","nativeMaxConcurrent":6});
                    if let Some(tokens) = args
                        .get("autoCompactTokens")
                        .or_else(|| map.get(id).and_then(|v| v.get("autoCompactTokens")))
                    {
                        defaults["autoCompactTokens"] = tokens.clone();
                    }
                    map.insert(target.clone(), defaults);
                } else if key == "kiwi.threadModels" && args.get("model").is_some() {
                    map.insert(target.clone(), args["model"].clone());
                } else if key == "kiwi.threadReasoning" && args.get("reasoning").is_some() {
                    map.insert(target.clone(), args["reasoning"].clone());
                } else if let Some(v) = map.get(id).cloned() {
                    map.insert(target.clone(), v);
                } else if key == "kiwi.threadProjects" {
                    map.insert(target.clone(), json!(root));
                }
                commit::write_value(db, key, &json!(map))?;
            }
        }
        "thread.delete" => {
            known.remove(id);
            archived.retain(|r| r["id"] != id);
            for key in [
                "kiwi.threadProjects",
                "kiwi.threadModels",
                "kiwi.threadReasoning",
                "kiwi.threadSubagentSettings",
                "kiwi.threadExecutionPreferences",
                "kiwi.parentRuns",
                "kiwi.threadWorktrees",
                "kiwi.turnDurations",
                "kiwi.threadPullRequests",
                "kiwi.childAgentLinks",
                "kiwi.nativeAgentLinks",
                "kiwi.childAgentMailbox",
                "kiwi.threadHandoffs",
                "kiwi.turnContextReceipts",
            ] {
                let mut map = object(value(db, key)?)?;
                map.remove(id);
                commit::write_value(db, key, &json!(map))?;
            }
            // Keep classification/mailboxes of surviving children of a deleted
            // root, exactly like the ordinary local removal helpers.
            for key in ["kiwi.childAgentPolicies", "kiwi.agentQuestions"] {
                let mut map = object(value(db, key)?)?;
                let field = if key == "kiwi.childAgentPolicies" {
                    "rootThreadId"
                } else {
                    "threadId"
                };
                map.retain(|_, v| v.get(field).and_then(Value::as_str) != Some(id));
                commit::write_value(db, key, &json!(map))?;
            }
            let handoff = value(db, "kiwi.pendingHandoff")?;
            if handoff.get("sourceThreadId").and_then(Value::as_str) == Some(id)
                || handoff.get("targetThreadId").and_then(Value::as_str) == Some(id)
            {
                commit::write_value(db, "kiwi.pendingHandoff", &Value::Null)?;
            }
            let mut pins = array(value(db, "kiwi.pinnedThreads")?)?;
            pins.retain(|v| v.as_str() != Some(id));
            commit::write_value(db, "kiwi.pinnedThreads", &json!(pins))?;
            let mut queue = object(value(db, "kiwi.queuedTurns")?)?;
            queue.remove(id);
            commit::write_value(db, "kiwi.queuedTurns", &json!(queue))?;
            super::store::reject_thread_queue(db, id)?;
            let mut checkpoints = array(value(db, "kiwi.checkpoints")?)?;
            let gone: std::collections::HashSet<String> = checkpoints
                .iter()
                .filter(|v| v["threadId"] == id)
                .filter_map(|v| v["id"].as_str().map(str::to_owned))
                .collect();
            checkpoints.retain(|v| v["threadId"] != id);
            commit::write_value(db, "kiwi.checkpoints", &json!(checkpoints))?;
            let mut heads = object(value(db, "kiwi.checkpointHeads")?)?;
            heads.retain(|_, v| {
                !v["checkpointId"]
                    .as_str()
                    .is_some_and(|id| gone.contains(id))
            });
            commit::write_value(db, "kiwi.checkpointHeads", &json!(heads))?;
        }
        "thread.rollback" => {
            let actual = effect.get("thread").ok_or_else(uncertain)?;
            let record = known.get_mut(id).ok_or_else(stale)?;
            for key in [
                "name",
                "preview",
                "updatedAt",
                "createdAt",
                "modelProvider",
                "status",
            ] {
                if let Some(value) = actual.get(key) {
                    record[key] = value.clone();
                }
            }
        }
        "thread.compact" => {}
        _ => return Err(stale()),
    }
    commit::write_value(db, "kiwi.knownThreads", &json!(known))?;
    commit::write_value(db, "kiwi.archivedThreads", &json!(archived))?;
    Ok(target)
}

pub(crate) struct RootProof(super::fs_guard::Anchor);
impl RootProof {
    pub(crate) fn new(expected: &str, actual: &str) -> Result<Self, String> {
        let expected = super::fs_guard::Anchor::open(std::path::Path::new(expected))?;
        let actual = super::fs_guard::Anchor::open(std::path::Path::new(actual))?;
        if expected.identity()? != actual.identity()? {
            return Err(stale());
        }
        Ok(Self(expected))
    }
    pub(crate) fn validate(&self) -> Result<(), String> {
        self.0.validate()
    }
    pub(crate) fn new_removed(expected: &str, actual: &str, saved: &str) -> Result<Self, String> {
        if !saved_path_eq(actual, saved) {
            return Err(stale());
        }
        Ok(Self(super::fs_guard::Anchor::open(std::path::Path::new(
            expected,
        ))?))
    }
    pub(crate) fn metadata(&self) -> Result<Value, String> {
        self.validate()?;
        Ok(json!({"root":self.0.path,"rootIdentity":self.0.identity()?}))
    }
    pub(crate) fn check_metadata(proof: &Value) -> Result<(), String> {
        let root = proof
            .get("root")
            .and_then(Value::as_str)
            .ok_or_else(stale)?;
        let opened = super::fs_guard::Anchor::open(std::path::Path::new(root))?;
        if proof.get("rootIdentity").and_then(Value::as_str) != Some(opened.identity()?.as_str()) {
            return Err(stale());
        }
        opened.validate()
    }
}

pub(crate) fn provider_matches(provider: &str, actual: &str) -> bool {
    if provider == "lmstudio" {
        matches!(
            actual,
            "lmstudio" | "lmstudio_openkiwi" | "openkiwi-lmstudio"
        )
    } else {
        provider == actual
    }
}
fn finish_thread(
    db: &mut Connection,
    inner: &super::Inner,
    stamp: &Stamp,
    provider: &str,
    root: &str,
    op: &str,
    args: &Value,
    book: &Book,
    effect: &Value,
    local: bool,
) -> Result<Value, String> {
    let tx = db.transaction().map_err(|_| uncertain())?;
    verify(&tx, op, book)?;
    let previous = eligibility(&tx, stamp, provider, root, op, args)?;
    let core = inner.lock();
    stamp.check(&core, op)?;
    if op != "thread.rename"
        && super::owners::thread_busy(&core, stamp.thread_id.as_deref().ok_or_else(stale)?)
    {
        return Err(work::refused("busy"));
    }
    if local {
        let removed = removed_checkout(&tx, stamp, op)?;
        local_effect(
            &tx,
            provider,
            stamp.thread_id.as_deref().ok_or_else(stale)?,
            root,
            op,
            args,
            removed.as_deref(),
        )?;
    }
    let thread = adopt_effect(&tx, stamp, provider, root, op, args, &previous, effect)?;
    let result = json!({"opId":stamp.op_id,"state":"accepted","workspaceId":stamp.workspace_id,"threadId":thread});
    commit::complete(&tx, stamp, op, &result, false)?;
    let result_rows = rows(&tx, op)?;
    tx.commit().map_err(|_| uncertain())?;
    Ok(
        json!({"result":result,"rows":result_rows,"thread":if matches!(op,"thread.fork"|"thread.rollback"){effect.get("thread").cloned().unwrap_or(Value::Null)}else{Value::Null},"replayed":false}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Fixture {
        path: std::path::PathBuf,
        db: Connection,
        inner: std::sync::Arc<super::super::Inner>,
        stamp: Stamp,
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.path);
        }
    }
    fn fixture(op: &str) -> Fixture {
        let path =
            std::env::temp_dir().join(format!("mythra-thread-row-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&path).unwrap();
        let mut db = Connection::open_in_memory().unwrap();
        store::init(&db).unwrap();
        db.execute_batch("CREATE TABLE app_state(key TEXT PRIMARY KEY,value TEXT NOT NULL,updated_at INTEGER NOT NULL);CREATE TABLE local_transcript_meta(provider TEXT,thread_id TEXT,thread_json TEXT,updated_at INTEGER);CREATE TABLE local_transcript_chunks(provider TEXT,thread_id TEXT);CREATE TABLE local_transcript_tail_state(provider TEXT,thread_id TEXT);").unwrap();
        let thread = json!({"id":"t","name":"before","cwd":path,"modelProvider":"claude"});
        commit::write_value(
            &db,
            "kiwi.knownThreads",
            &json!({"t":thread,"other":{"id":"other","name":"keep"}}),
        )
        .unwrap();
        commit::write_value(&db, "kiwi.projects", &json!([{"id":"p","path":path}])).unwrap();
        commit::write_value(&db, "kiwi.threadProjects", &json!({"t":path})).unwrap();
        commit::write_value(&db, "kiwi.archivedThreads", &json!([])).unwrap();
        commit::write_value(&db, "kiwi.threadWorktrees", &json!({})).unwrap();
        db.execute(
            "INSERT INTO local_transcript_meta VALUES('claude','t',?1,1)",
            [thread.to_string()],
        )
        .unwrap();
        commit::write_value(&db, "kiwi.claudeThread.t", &json!({"thread":thread})).unwrap();
        store::claim_operation(&mut db, "device", "op", 1, op, "digest").unwrap();
        store::save_delivery_receipt(
            &mut db,
            "device",
            "op",
            1,
            &json!({"disposition":"dispatched","threadId":"t","workspaceId":"p"}),
        )
        .unwrap();
        let inner = RemoteState::default().inner;
        super::super::hostbridge::test_attach(&inner, 1);
        {
            let mut core = inner.lock();
            core.settings.hosting = true;
            let mut grant = store::DeviceGrant::initial();
            grant.work = true;
            grant.scope = store::GrantScope::Projects {
                project_ids: vec!["p".into()],
            };
            core.devices.insert(
                "device".into(),
                store::DeviceRecord {
                    fingerprint: "device".into(),
                    spki: vec![],
                    name: "device".into(),
                    platform: None,
                    addresses: vec![],
                    they_host: false,
                    access_removed: false,
                    paired_at: 1,
                    last_seen_at: None,
                    grant: Some(grant),
                },
            );
        }
        let revision = inner.lock().devices["device"]
            .grant
            .as_ref()
            .unwrap()
            .revision;
        Fixture {
            path,
            db,
            inner,
            stamp: Stamp {
                generation: 1,
                device: "device".into(),
                grant_revision: revision,
                op_id: "op".into(),
                op_seq: 1,
                workspace_id: Some("p".into()),
                thread_id: Some("t".into()),
            },
        }
    }
    fn book(f: &Fixture, op: &str) -> Book {
        Book {
            version: 1,
            rows: rows(&f.db, op).unwrap(),
        }
    }
    #[test]
    fn rename_is_atomic_with_receipt_and_rechecks_live_grant() {
        let mut f = fixture("thread.rename");
        let expected = book(&f, "thread.rename");
        let args = json!({"name":"after"});
        f.inner
            .lock()
            .devices
            .get_mut("device")
            .unwrap()
            .grant
            .as_mut()
            .unwrap()
            .work = false;
        assert!(finish_thread(
            &mut f.db,
            &f.inner,
            &f.stamp,
            "claude",
            f.path.to_str().unwrap(),
            "thread.rename",
            &args,
            &expected,
            &Value::Null,
            true
        )
        .is_err());
        assert_eq!(
            value(&f.db, "kiwi.knownThreads").unwrap()["t"]["name"],
            "before"
        );
        assert!(commit::prior(&f.db, &f.stamp).unwrap().is_none());
        f.inner
            .lock()
            .devices
            .get_mut("device")
            .unwrap()
            .grant
            .as_mut()
            .unwrap()
            .work = true;
        let result = finish_thread(
            &mut f.db,
            &f.inner,
            &f.stamp,
            "claude",
            f.path.to_str().unwrap(),
            "thread.rename",
            &args,
            &expected,
            &Value::Null,
            true,
        )
        .unwrap();
        assert_eq!(result["result"]["state"], "accepted");
        assert!(commit::prior(&f.db, &f.stamp).unwrap().is_some());
        assert_eq!(
            value(&f.db, "kiwi.knownThreads").unwrap()["other"]["name"],
            "keep"
        );
        let raw: String =
            f.db.query_row("SELECT thread_json FROM local_transcript_meta", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&raw).unwrap()["name"],
            "after"
        );
    }
    #[test]
    fn delete_bookkeeping_queue_rejection_and_local_tombstone_commit_together() {
        let mut f = fixture("thread.delete");
        for key in [
            "kiwi.childAgentLinks",
            "kiwi.nativeAgentLinks",
            "kiwi.childAgentMailbox",
            "kiwi.threadHandoffs",
            "kiwi.turnContextReceipts",
        ] {
            commit::write_value(
                &f.db,
                key,
                &json!({"t":{"rootThreadId":"parent"},"survivor":{"rootThreadId":"t"}}),
            )
            .unwrap();
        }
        commit::write_value(
            &f.db,
            "kiwi.childAgentPolicies",
            &json!({"dead":{"rootThreadId":"t"},"keep":{"rootThreadId":"other"}}),
        )
        .unwrap();
        commit::write_value(
            &f.db,
            "kiwi.agentQuestions",
            &json!({"dead":{"threadId":"t"},"keep":{"threadId":"other"}}),
        )
        .unwrap();
        commit::write_value(&f.db, "kiwi.pendingHandoff", &json!({"sourceThreadId":"t"})).unwrap();
        commit::write_value(
            &f.db,
            "kiwi.queuedTurns",
            &json!({"t":[{"id":"q","threadId":"t"}],"other":[{"id":"keep"}]}),
        )
        .unwrap();
        store::claim_operation(
            &mut f.db,
            "device",
            "queue",
            2,
            "prompt.queue",
            "queued-digest",
        )
        .unwrap();
        store::save_delivery_receipt(
            &mut f.db,
            "device",
            "queue",
            2,
            &json!({"disposition":"queued","threadId":"t","workspaceId":"p"}),
        )
        .unwrap();
        let expected = book(&f, "thread.delete");
        let result = finish_thread(
            &mut f.db,
            &f.inner,
            &f.stamp,
            "claude",
            f.path.to_str().unwrap(),
            "thread.delete",
            &json!({"confirmed":true}),
            &expected,
            &Value::Null,
            true,
        )
        .unwrap();
        assert_eq!(result["result"]["state"], "accepted");
        assert!(value(&f.db, "kiwi.knownThreads")
            .unwrap()
            .get("t")
            .is_none());
        assert!(value(&f.db, "kiwi.queuedTurns").unwrap().get("t").is_none());
        assert!(value(&f.db, "kiwi.queuedTurns")
            .unwrap()
            .get("other")
            .is_some());
        assert_eq!(
            store::operation_result(&f.db, "device", "queue").unwrap()["state"],
            "rejected"
        );
        let count: i64 =
            f.db.query_row(
                "SELECT COUNT(*) FROM remote_deleted_transcripts WHERE thread_id='t'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(count, 1);
        for key in [
            "kiwi.childAgentLinks",
            "kiwi.nativeAgentLinks",
            "kiwi.childAgentMailbox",
            "kiwi.threadHandoffs",
            "kiwi.turnContextReceipts",
        ] {
            let retained = value(&f.db, key).unwrap();
            assert!(retained.get("t").is_none(), "{key}");
            assert_eq!(retained["survivor"]["rootThreadId"], "t", "{key}");
        }
        for key in ["kiwi.childAgentPolicies", "kiwi.agentQuestions"] {
            let retained = value(&f.db, key).unwrap();
            assert!(retained.get("dead").is_none());
            assert!(retained.get("keep").is_some());
        }
        assert!(value(&f.db, "kiwi.pendingHandoff").unwrap().is_null());
        assert_eq!(
            f.db.query_row("SELECT COUNT(*) FROM local_transcript_meta", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }
    #[test]
    fn provider_project_and_cas_cannot_be_substituted() {
        let f = fixture("thread.rename");
        assert!(binding(&f.db, &f.stamp, "cursor", f.path.to_str().unwrap()).is_err());
        let mut forged = f.stamp.clone();
        forged.workspace_id = Some("other-project".into());
        assert!(binding(&f.db, &forged, "claude", f.path.to_str().unwrap()).is_err());
        let expected = book(&f, "thread.rename");
        commit::write_value(&f.db, "kiwi.knownThreads", &json!({})).unwrap();
        assert!(verify(&f.db, "thread.rename", &expected).is_err());
    }
    #[test]
    fn restore_rebuilds_missing_sidebar_metadata_from_the_actual_transcript() {
        let mut f = fixture("thread.restore");
        commit::write_value(&f.db, "kiwi.knownThreads", &json!({"other":{"id":"other"}})).unwrap();
        commit::write_value(
            &f.db,
            "kiwi.archivedThreads",
            &json!([{"id":"t","label":"old label","path":f.path,"provider":"claude"}]),
        )
        .unwrap();
        let expected = book(&f, "thread.restore");
        finish_thread(
            &mut f.db,
            &f.inner,
            &f.stamp,
            "claude",
            f.path.to_str().unwrap(),
            "thread.restore",
            &json!({}),
            &expected,
            &Value::Null,
            true,
        )
        .unwrap();
        assert_eq!(
            value(&f.db, "kiwi.knownThreads").unwrap()["t"]["name"],
            "before"
        );
        assert_eq!(value(&f.db, "kiwi.archivedThreads").unwrap(), json!([]));
    }
    #[test]
    fn removed_checkout_delete_requires_that_exact_threads_saved_lineage() {
        let mut f = fixture("thread.delete");
        let gone = f.path.join("removed-checkout");
        commit::write_value(
            &f.db,
            "kiwi.threadWorktrees",
            &json!({"t":{"status":"removed","path":gone}}),
        )
        .unwrap();
        f.db.execute(
            "UPDATE local_transcript_meta SET thread_json=?1",
            [json!({"id":"t","cwd":gone,"modelProvider":"claude"}).to_string()],
        )
        .unwrap();
        let expected = book(&f, "thread.delete");
        assert!(RootProof::new_removed(
            f.path.to_str().unwrap(),
            gone.to_str().unwrap(),
            f.path.join("other").to_str().unwrap()
        )
        .is_err());
        let proof = RootProof::new_removed(
            f.path.to_str().unwrap(),
            gone.to_str().unwrap(),
            gone.to_str().unwrap(),
        )
        .unwrap();
        let mut meta = proof.metadata().unwrap();
        RootProof::check_metadata(&meta).unwrap();
        meta["rootIdentity"] = json!("wrong identity");
        assert!(RootProof::check_metadata(&meta).is_err());
        finish_thread(
            &mut f.db,
            &f.inner,
            &f.stamp,
            "claude",
            f.path.to_str().unwrap(),
            "thread.delete",
            &json!({"confirmed":true}),
            &expected,
            &Value::Null,
            true,
        )
        .unwrap();
        assert!(value(&f.db, "kiwi.knownThreads")
            .unwrap()
            .get("t")
            .is_none());
    }
}
