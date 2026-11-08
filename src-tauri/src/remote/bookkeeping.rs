//! Versioned, host-only metadata for native checkpoint/worktree side effects.
use super::{
    commit::{self, Stamp},
    hostbridge, work, RemoteState,
};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{State, WebviewWindow};
#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Row {
    key: String,
    value: Value,
    revision: Option<i64>,
}
#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Bookkeeping {
    version: u32,
    rows: Vec<Row>,
}
fn stale() -> String {
    work::refused("stale_target")
}
pub(super) fn keys(op: &str) -> Vec<&'static str> {
    if op == "checkpoint.restore" {
        vec![
            "kiwi.checkpoints",
            "kiwi.checkpointHeads",
            "kiwi.threadWorktrees",
        ]
    } else if op.starts_with("checkpoint.") {
        vec!["kiwi.checkpoints", "kiwi.checkpointHeads"]
    } else if matches!(
        op,
        "worktree.apply" | "worktree.merge" | "worktree.remove" | "worktree.returnShared"
    ) {
        vec![
            "kiwi.threadWorktrees",
            "kiwi.checkpoints",
            "kiwi.checkpointHeads",
        ]
    } else if op.starts_with("worktree.") {
        vec!["kiwi.threadWorktrees"]
    } else {
        vec![]
    }
}
pub(super) fn rows(db: &Connection, op: &str) -> Result<Vec<Value>, String> {
    keys(op)
        .iter()
        .map(|key| commit::state_row(db, key))
        .collect()
}
pub(super) fn verify(
    db: &Connection,
    op: &str,
    expected: Option<&Bookkeeping>,
) -> Result<(), String> {
    let keys = keys(op);
    if keys.is_empty() {
        return Ok(());
    }
    let expected = expected.ok_or_else(|| work::refused("unsupported"))?;
    if expected.version != 1
        || expected.rows.len() != keys.len()
        || serde_json::to_vec(expected).map_or(true, |bytes| bytes.len() > 4 * 1024 * 1024)
    {
        return Err(stale());
    }
    for key in keys {
        let row = expected
            .rows
            .iter()
            .find(|r| r.key == key)
            .ok_or_else(stale)?;
        if expected.rows.iter().filter(|r| r.key == key).count() != 1 {
            return Err(stale());
        }
        let actual = commit::state_row(db, key)?;
        if row.revision != actual["revision"].as_i64() || row.value != actual["value"] {
            return Err(stale());
        }
    }
    Ok(())
}
fn read<'a>(book: &'a Bookkeeping, key: &str) -> Result<&'a Value, String> {
    book.rows
        .iter()
        .find(|r| r.key == key)
        .map(|r| &r.value)
        .ok_or_else(stale)
}
fn checkpoint_rows(book: &Bookkeeping) -> Result<Vec<Value>, String> {
    let v = read(book, "kiwi.checkpoints")?;
    if v.is_null() {
        Ok(Vec::new())
    } else {
        v.as_array().cloned().ok_or_else(stale)
    }
}
fn object(value: &Value) -> Result<serde_json::Map<String, Value>, String> {
    if value.is_null() {
        Ok(serde_json::Map::new())
    } else {
        value.as_object().cloned().ok_or_else(stale)
    }
}
fn text<'a>(value: &'a Value, key: &str) -> Result<&'a str, String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty() && s.len() <= 32768 && !s.contains('\0'))
        .ok_or_else(stale)
}
fn path_key(root: &str) -> String {
    let key = root.replace('\\', "/").trim_end_matches('/').to_owned();
    if key.is_empty() {
        "/".into()
    } else {
        key
    }
}
pub(super) fn preflight(
    op: &str,
    stamp: &Stamp,
    root: &str,
    args: &Value,
    book: Option<&Bookkeeping>,
) -> Result<(), String> {
    if keys(op).is_empty() {
        return Ok(());
    }
    let book = book.ok_or_else(stale)?;
    let thread = stamp.thread_id.as_deref().ok_or_else(stale)?;
    if op.starts_with("checkpoint.") {
        let records = checkpoint_rows(book)?;
        let id = text(args, "checkpointId")?;
        let record = records
            .iter()
            .find(|r| r.get("id").and_then(Value::as_str) == Some(id));
        if op == "checkpoint.create" {
            if record.is_some() || args.get("threadId").and_then(Value::as_str) != Some(thread) {
                return Err(stale());
            }
        } else {
            let r = record.ok_or_else(stale)?;
            if r.get("threadId").and_then(Value::as_str) != Some(thread)
                || r.get("workspacePath").and_then(Value::as_str) != Some(root)
                || r.get("status").and_then(Value::as_str) == Some("running")
            {
                return Err(stale());
            }
        }
    } else {
        let map = object(read(book, "kiwi.threadWorktrees")?)?;
        let record = map.get(thread);
        if op == "worktree.create" {
            if record.is_some() {
                return Err(stale());
            }
        } else {
            let r = record.ok_or_else(stale)?;
            if op == "worktree.continueShared"
                && r.get("status").and_then(Value::as_str) == Some("missing")
            {
                return Err(stale());
            }
            if matches!(op, "worktree.remove" | "worktree.returnShared")
                && (r.get("path") != args.get("worktreePath")
                    || r.get("branch") != args.get("branch"))
            {
                return Err(stale());
            }
            if r.get("projectId").and_then(Value::as_str) != stamp.workspace_id.as_deref()
                || r.get("projectPath").and_then(Value::as_str) != Some(root)
            {
                return Err(stale());
            }
        }
    }
    Ok(())
}
fn refresh(db: &Connection, op: &str) -> Result<Bookkeeping, String> {
    Ok(Bookkeeping {
        version: 1,
        rows: rows(db, op)?
            .into_iter()
            .map(|row| serde_json::from_value(row).map_err(|_| stale()))
            .collect::<Result<Vec<Row>, _>>()?,
    })
}
pub(super) fn save_safety(
    db: &Connection,
    stamp: &Stamp,
    op: &str,
    root: &str,
    args: &Value,
    book: &Bookkeeping,
    id: &str,
    label: &str,
    before: &Value,
    after: &Value,
) -> Result<Bookkeeping, String> {
    verify(db, op, Some(book))?;
    let mut records = checkpoint_rows(book)?;
    let mut heads = object(read(book, "kiwi.checkpointHeads")?)?;
    let key = path_key(root);
    let parent = heads.get(&key).cloned().unwrap_or(Value::Null);
    let now = crate::unix_timestamp_ms();
    let mut record = json!({"id":id,"threadId":stamp.thread_id,"workspacePath":root,"repoRoot":after["repoRoot"],"label":label,"createdAt":now,"completedAt":now,"status":"safety","beforeCommit":before["commit"],"afterCommit":after["commit"],"fileCount":after["fileCount"],"parentId":parent["checkpointId"],"parentPosition":parent["position"]});
    if op.starts_with("worktree.") || op == "checkpoint.restore" {
        let map = object(read(book, "kiwi.threadWorktrees")?)?;
        let related = if op == "checkpoint.restore" {
            checkpoint_rows(book)?
                .iter()
                .find(|r| r.get("id") == args.get("checkpointId"))
                .and_then(|r| r.get("worktreeThreadId"))
                .and_then(Value::as_str)
                .map(str::to_owned)
        } else {
            stamp.thread_id.clone()
        };
        if let Some((thread, old)) = related
            .as_ref()
            .and_then(|id| map.get(id).map(|row| (id, row)))
        {
            record["worktreeThreadId"] = json!(thread);
            record["worktreeBaseline"] = old
                .get("appliedTree")
                .or_else(|| old.get("baseCommit"))
                .cloned()
                .unwrap_or(Value::Null);
        }
    }
    if op == "checkpoint.restore" {
        record["restoredFromId"] = args["checkpointId"].clone();
    }
    records.insert(0, record);
    heads.insert(key, json!({"checkpointId":id,"position":"after"}));
    commit::write_value(db, "kiwi.checkpoints", &json!(records))?;
    commit::write_value(db, "kiwi.checkpointHeads", &json!(heads))?;
    refresh(db, op)
}
pub(super) fn finish(
    db: &Connection,
    stamp: &Stamp,
    op: &str,
    root: &str,
    args: &Value,
    payload: &Value,
    book: Option<&Bookkeeping>,
) -> Result<Vec<Value>, String> {
    verify(db, op, book)?;
    if keys(op).is_empty() {
        return Ok(vec![]);
    }
    let book = book.ok_or_else(stale)?;
    let thread = stamp.thread_id.as_deref().ok_or_else(stale)?;
    let now = crate::unix_timestamp_ms();
    if op.starts_with("checkpoint.") {
        let mut records = checkpoint_rows(book)?;
        let mut heads = object(read(book, "kiwi.checkpointHeads")?)?;
        let id = text(args, "checkpointId")?;
        let key = path_key(root);
        if op == "checkpoint.create" {
            let parent = heads.get(&key).cloned().unwrap_or(Value::Null);
            records.insert(0,json!({"id":id,"threadId":thread,"workspacePath":root,"repoRoot":payload["repoRoot"],"label":args["label"],"provider":args["provider"],"model":args["model"],"createdAt":args.get("createdAt").and_then(Value::as_i64).unwrap_or(now),"completedAt":now,"status":"ready","beforeCommit":payload["commit"],"fileCount":payload["fileCount"],"branch":payload["branch"],"head":payload["head"],"parentId":parent["checkpointId"],"parentPosition":parent["position"]}));
            heads.insert(key, json!({"checkpointId":id,"position":"before"}));
        } else if op == "checkpoint.delete" {
            records.retain(|r| r.get("id").and_then(Value::as_str) != Some(id));
            heads.retain(|_, head| head.get("checkpointId").and_then(Value::as_str) != Some(id));
        } else {
            let record = records
                .iter_mut()
                .find(|r| r.get("id").and_then(Value::as_str) == Some(id))
                .ok_or_else(stale)?;
            if op == "checkpoint.complete" {
                record["afterCommit"] = payload["snapshot"]["commit"].clone();
                record["repoRoot"] = payload["snapshot"]["repoRoot"].clone();
                for key in ["changedFiles", "additions", "deletions"] {
                    record[key] = payload[key].clone();
                }
                record["completedAt"] = json!(now);
                record["status"] = json!("ready");
                if heads
                    .get(&key)
                    .and_then(|head| head.get("checkpointId"))
                    .and_then(Value::as_str)
                    == Some(id)
                {
                    heads.insert(key, json!({"checkpointId":id,"position":"after"}));
                }
            } else if op == "checkpoint.restore" {
                let target = text(args, "target")?;
                record["status"] = json!(format!("restored-{target}"));
                heads.insert(key, json!({"checkpointId":id,"position":target}));
            }
        }
        if op == "checkpoint.restore" {
            if let Some((thread, _, baseline)) = restore_baseline(stamp, book, args)? {
                let mut map = object(read(book, "kiwi.threadWorktrees")?)?;
                let row = map.get_mut(&thread).ok_or_else(stale)?;
                row["appliedTree"] = payload
                    .get("worktreeAppliedTree")
                    .cloned()
                    .unwrap_or_else(|| json!(baseline));
                row["status"] = json!(if row.get("baseCommit").and_then(Value::as_str)
                    == Some(baseline.as_str())
                {
                    "active"
                } else {
                    "applied"
                });
                commit::write_value(db, "kiwi.threadWorktrees", &json!(map))?;
            }
        }
        commit::write_value(db, "kiwi.checkpoints", &json!(records))?;
        commit::write_value(db, "kiwi.checkpointHeads", &json!(heads))?;
    } else {
        let mut map = object(read(book, "kiwi.threadWorktrees")?)?;
        if matches!(op, "worktree.create" | "worktree.recreate") {
            let mut record = json!({"threadId":thread,"projectId":stamp.workspace_id,"projectPath":root,"path":payload["path"],"branch":payload["branch"],"baseCommit":payload["baseCommit"],"gitDir":payload["gitDir"],"createdAt":now,"status":"active"});
            if op == "worktree.recreate" {
                let mut previous = map.get(thread).cloned().ok_or_else(stale)?;
                if let (Some(old), Some(new)) = (previous.as_object_mut(), record.as_object()) {
                    for key in [
                        "appliedTree",
                        "lastAppliedAt",
                        "mergedAt",
                        "mergedHeadOid",
                        "removedAt",
                        "retainedBranch",
                        "retainedBranchOid",
                        "branchDeleteError",
                    ] {
                        old.remove(key);
                    }
                    for (key, value) in new {
                        old.insert(key.clone(), value.clone());
                    }
                }
                record = previous;
                record["recreatedFromMissing"] = json!(true);
            }
            map.insert(thread.into(), record);
        } else if matches!(op, "worktree.continueShared" | "worktree.returnShared") {
            if op == "worktree.returnShared"
                && payload.get("folderRemoved").and_then(Value::as_bool) != Some(true)
            {
                return Err(stale());
            }
            map.remove(thread).ok_or_else(stale)?;
        } else {
            let record = map.get_mut(thread).ok_or_else(stale)?;
            match op {
                "worktree.apply" => {
                    record["appliedTree"] = payload["isolatedTree"].clone();
                    record["status"] = json!("applied");
                    record["lastAppliedAt"] = json!(now);
                }
                "worktree.merge" => {
                    record["appliedTree"] = payload["isolatedTree"].clone();
                    record["mergedHeadOid"] = payload["sourceCommit"].clone();
                    record["status"] = json!("merged");
                    record["mergedAt"] = json!(now);
                }
                "worktree.baseline" => {
                    record["appliedTree"] = payload.clone();
                }
                "worktree.remove" => {
                    if payload.get("folderRemoved").and_then(Value::as_bool) != Some(true) {
                        return Err(stale());
                    }
                    record["status"] = json!("removed");
                    record["removedAt"] = json!(now);
                    for key in ["retainedBranch", "retainedBranchOid", "branchDeleteError"] {
                        if let Some(value) = payload.get(key) {
                            record[key] = value.clone();
                        }
                    }
                }
                _ => return Err(stale()),
            }
        }
        if matches!(op, "worktree.remove" | "worktree.returnShared") {
            let path = text(args, "worktreePath")?;
            let mut checkpoints = checkpoint_rows(book)?;
            let mut invalid = std::collections::HashSet::new();
            for row in &mut checkpoints {
                if row
                    .get("workspacePath")
                    .and_then(Value::as_str)
                    .is_some_and(|p| path_key(p) == path_key(path))
                {
                    if let Some(id) = row.get("id").and_then(Value::as_str) {
                        invalid.insert(id.to_owned());
                    }
                    row["status"] = json!("failed");
                    row["beforeCommit"] = Value::Null;
                    row["afterCommit"] = Value::Null;
                    row["error"]=json!("The isolated worktree was removed; this historical checkpoint is no longer restorable.");
                }
            }
            let mut heads = object(read(book, "kiwi.checkpointHeads")?)?;
            heads.retain(|_, head| {
                !head
                    .get("checkpointId")
                    .and_then(Value::as_str)
                    .is_some_and(|id| invalid.contains(id))
            });
            commit::write_value(db, "kiwi.checkpoints", &json!(checkpoints))?;
            commit::write_value(db, "kiwi.checkpointHeads", &json!(heads))?;
        }
        commit::write_value(db, "kiwi.threadWorktrees", &json!(map))?;
    }
    rows(db, op)
}
#[tauri::command]
pub(crate) async fn remote_domain_snapshot(
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
            let core = inner.lock();
            stamp.check(&core, &op)?;
            if keys(&op).is_empty() {
                return Err(work::refused("unsupported"));
            }
            let rows = rows(db, &op)?;
            if serde_json::to_vec(&rows).map_or(true, |b| b.len() > 4 * 1024 * 1024) {
                return Err(stale());
            }
            Ok(json!({"version":1,"rows":rows}))
        })
        .await
}

pub(super) fn restore_baseline(
    stamp: &Stamp,
    book: &Bookkeeping,
    args: &Value,
) -> Result<Option<(String, String, String)>, String> {
    if args.get("target").and_then(Value::as_str) != Some("after") {
        return Ok(None);
    }
    let records = checkpoint_rows(book)?;
    let record = records
        .iter()
        .find(|r| r.get("id") == args.get("checkpointId"))
        .ok_or_else(stale)?;
    let (Some(thread), Some(baseline)) = (
        record.get("worktreeThreadId").and_then(Value::as_str),
        record.get("worktreeBaseline").and_then(Value::as_str),
    ) else {
        return Ok(None);
    };
    let map = object(read(book, "kiwi.threadWorktrees")?)?;
    let row = map.get(thread).ok_or_else(stale)?;
    if row.get("projectId").and_then(Value::as_str) != stamp.workspace_id.as_deref() {
        return Err(stale());
    }
    Ok(Some((
        thread.into(),
        text(row, "projectPath")?.into(),
        baseline.into(),
    )))
}

pub(super) fn removed_checkpoint_ids(
    book: &Bookkeeping,
    path: &str,
) -> Result<Vec<String>, String> {
    Ok(checkpoint_rows(book)?
        .iter()
        .filter(|row| {
            row.get("workspacePath")
                .and_then(Value::as_str)
                .is_some_and(|p| path_key(p) == path_key(path))
        })
        .filter_map(|row| row.get("id").and_then(Value::as_str).map(str::to_owned))
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture(op: &str) -> (Connection, Stamp, Bookkeeping) {
        let mut db = Connection::open_in_memory().unwrap();
        super::super::store::init(&db).unwrap();
        db.execute_batch("CREATE TABLE app_state(key TEXT PRIMARY KEY,value TEXT NOT NULL,updated_at INTEGER NOT NULL);").unwrap();
        super::super::store::claim_operation(&mut db, "device", "op", 1, op, "digest").unwrap();
        commit::write_value(&db,"kiwi.threadWorktrees",&json!({"thread":{"threadId":"thread","projectId":"project","projectPath":"/project","path":"/isolated","branch":"isolated","status":"removed"}})).unwrap();
        commit::write_value(&db,"kiwi.checkpoints",&json!([{"id":"historical","threadId":"thread","workspacePath":"/isolated","status":"ready","beforeCommit":"before","afterCommit":"after"}])).unwrap();
        commit::write_value(
            &db,
            "kiwi.checkpointHeads",
            &json!({"/isolated":{"checkpointId":"historical","position":"after"}}),
        )
        .unwrap();
        let stamp = Stamp {
            generation: 1,
            device: "device".into(),
            op_id: "op".into(),
            op_seq: 1,
            grant_revision: 1,
            workspace_id: Some("project".into()),
            thread_id: Some("thread".into()),
        };
        let book = refresh(&db, op).unwrap();
        (db, stamp, book)
    }
    #[test]
    fn destructive_actions_require_expanded_rows_and_cas() {
        for op in [
            "checkpoint.restore",
            "worktree.apply",
            "worktree.merge",
            "worktree.remove",
            "worktree.returnShared",
        ] {
            let (db, _, mut book) = fixture(op);
            assert_eq!(book.rows.len(), 3);
            assert!(verify(&db, op, Some(&book)).is_ok());
            book.rows.pop();
            assert!(verify(&db, op, Some(&book)).is_err());
            let book = refresh(&db, op).unwrap();
            commit::write_value(&db, "kiwi.checkpoints", &json!([])).unwrap();
            assert!(verify(&db, op, Some(&book)).is_err());
        }
    }
    #[test]
    fn shared_mode_does_not_remove_files_and_bookkeeping_and_receipt_are_atomic() {
        let (mut db, stamp, book) = fixture("worktree.continueShared");
        let args = json!({"confirmed":true});
        {
            let tx = db.transaction().unwrap();
            finish(
                &tx,
                &stamp,
                "worktree.continueShared",
                "/project",
                &args,
                &json!({}),
                Some(&book),
            )
            .unwrap();
            commit::complete(
                &tx,
                &stamp,
                "worktree.continueShared",
                &json!({"opId":"op","state":"accepted"}),
                false,
            )
            .unwrap(); /* drop simulates a failing final commit */
        }
        assert!(
            commit::state_row(&db, "kiwi.threadWorktrees").unwrap()["value"]
                .get("thread")
                .is_some()
        );
        assert!(commit::prior(&db, &stamp).unwrap().is_none());
        {
            let tx = db.transaction().unwrap();
            finish(
                &tx,
                &stamp,
                "worktree.continueShared",
                "/project",
                &args,
                &json!({}),
                Some(&book),
            )
            .unwrap();
            commit::complete(
                &tx,
                &stamp,
                "worktree.continueShared",
                &json!({"opId":"op","state":"accepted"}),
                false,
            )
            .unwrap();
            tx.commit().unwrap();
        }
        assert!(
            commit::state_row(&db, "kiwi.threadWorktrees").unwrap()["value"]
                .get("thread")
                .is_none()
        );
        assert!(commit::prior(&db, &stamp).unwrap().is_some());
        assert_eq!(
            commit::state_row(&db, "kiwi.checkpoints").unwrap()["value"][0]["status"],
            "ready"
        );
    }
    #[test]
    fn return_shared_invalidates_isolated_checkpoints_but_requires_folder_proof() {
        let (db, stamp, book) = fixture("worktree.returnShared");
        let args = json!({"worktreePath":"/isolated"});
        assert!(finish(
            &db,
            &stamp,
            "worktree.returnShared",
            "/project",
            &args,
            &json!({"folderRemoved":false}),
            Some(&book)
        )
        .is_err());
        finish(
            &db,
            &stamp,
            "worktree.returnShared",
            "/project",
            &args,
            &json!({"folderRemoved":true}),
            Some(&book),
        )
        .unwrap();
        assert!(
            commit::state_row(&db, "kiwi.threadWorktrees").unwrap()["value"]
                .get("thread")
                .is_none()
        );
        assert_eq!(
            commit::state_row(&db, "kiwi.checkpoints").unwrap()["value"][0]["status"],
            "failed"
        );
        assert_eq!(
            commit::state_row(&db, "kiwi.checkpointHeads").unwrap()["value"],
            json!({})
        );
    }
}
