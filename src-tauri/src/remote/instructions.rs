//! Native-only child instructions. They never consume a viewer sequence number.
use super::{
    commit::{self, Stamp},
    store, work,
};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
pub(super) fn child(
    db: &Connection,
    root: &Stamp,
    step: &str,
    op: &str,
    thread: Option<&str>,
    extra: &Value,
) -> Result<Stamp, String> {
    let stale = || work::refused("stale_target");
    let root_op = commit::operation(db, root)?;
    if !matches!(
        (root_op.as_str(), op),
        ("thread.archiveMany", "thread.archive")
            | ("thread.deleteMany", "thread.delete")
            | (
                "discovery.run.start" | "discovery.check.start",
                "engine.discovery"
            )
    ) {
        return Err(stale());
    }
    let digest = store::request_digest(op, &json!({"thread":thread,"extra":extra}));
    let old:Option<(String,String)>=db.query_row("SELECT op_id,request_digest FROM remote_op_journal WHERE device_fingerprint=?1 AND engine_root=?2 AND engine_step=?3",params![root.device,root.op_id,step],|r|Ok((r.get(0)?,r.get(1)?))).optional().map_err(|_|stale())?;
    let id = if let Some((id, old)) = old {
        if old != digest {
            return Err(stale());
        }
        id
    } else {
        let count:i64=db.query_row("SELECT COUNT(*) FROM remote_op_journal WHERE device_fingerprint=?1 AND engine_root=?2",params![root.device,root.op_id],|r|r.get(0)).map_err(|_|stale())?;
        if count >= 256 {
            return Err(work::refused("busy"));
        }
        let id = format!("engine:{}", uuid::Uuid::new_v4());
        let now = crate::unix_timestamp_ms();
        let receipt = json!({"op":op,"generation":root.generation,"device":root.device,"opId":id,"opSeq":1,"threadId":thread,"workspaceId":root.workspace_id,"grantRevision":root.grant_revision,"disposition":"dispatched"});
        db.execute("INSERT INTO remote_op_journal(device_fingerprint,op_id,op_seq,op,request_digest,state,created_at,updated_at,engine_root,engine_step,delivery_json) VALUES(?1,?2,1,?3,?4,'pending',?5,?5,?6,?7,?8)",params![root.device,id,op,digest,now,root.op_id,step,receipt.to_string()]).map_err(|_|stale())?;
        id
    };
    Ok(Stamp {
        op_id: id,
        op_seq: 1,
        thread_id: thread.map(str::to_owned),
        ..root.clone()
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bulk_children_are_durable_distinct_deduplicated_and_preserve_viewer_sequence() {
        let mut db = Connection::open_in_memory().unwrap();
        store::init(&db).unwrap();
        store::claim_operation(&mut db, "device", "bulk", 41, "thread.deleteMany", "root").unwrap();
        store::save_delivery_receipt(
            &mut db,
            "device",
            "bulk",
            41,
            &json!({"disposition":"dispatched","batchStarted":true}),
        )
        .unwrap();
        store::save_delivery_receipt(
            &mut db,
            "device",
            "bulk",
            41,
            &json!({"disposition":"dispatched"}),
        )
        .unwrap();
        assert_eq!(
            store::delivery_receipt(&db, "device", "bulk", 41)
                .unwrap()
                .unwrap()["batchStarted"],
            true
        );
        let root = Stamp {
            generation: 1,
            device: "device".into(),
            grant_revision: 1,
            op_id: "bulk".into(),
            op_seq: 41,
            workspace_id: Some("p".into()),
            thread_id: None,
        };
        let first = child(
            &db,
            &root,
            "row-0",
            "thread.delete",
            Some("a"),
            &json!({"provider":"claude"}),
        )
        .unwrap();
        let second = child(
            &db,
            &root,
            "row-1",
            "thread.delete",
            Some("b"),
            &json!({"provider":"cursor"}),
        )
        .unwrap();
        assert_ne!(first.op_id, second.op_id);
        assert_eq!(
            child(
                &db,
                &root,
                "row-0",
                "thread.delete",
                Some("a"),
                &json!({"provider":"claude"})
            )
            .unwrap()
            .op_id,
            first.op_id
        );
        assert!(child(
            &db,
            &root,
            "row-0",
            "thread.delete",
            Some("different"),
            &json!({"provider":"claude"})
        )
        .is_err());
        assert!(child(&db, &root, "row-2", "thread.archive", Some("a"), &json!({})).is_err());
        let receipt =
            store::claim_native_step(&mut db, &first.device, &first.op_id, 1, "thread/delete")
                .unwrap();
        assert_eq!(receipt["threadId"], "a");
        assert!(
            store::claim_native_step(&mut db, &first.device, &first.op_id, 1, "thread/delete")
                .is_err()
        );
        assert!(matches!(
            store::claim_operation(&mut db, "device", "later", 42, "thread.rename", "next")
                .unwrap(),
            store::JournalClaim::Claimed
        ));
    }
    #[test]
    fn discovery_model_inputs_cannot_reuse_a_prior_rounds_receipt() {
        let mut db = Connection::open_in_memory().unwrap();
        store::init(&db).unwrap();
        store::claim_operation(
            &mut db,
            "device",
            "discovery",
            7,
            "discovery.check.start",
            "root",
        )
        .unwrap();
        let root = Stamp {
            generation: 1,
            device: "device".into(),
            grant_revision: 1,
            op_id: "discovery".into(),
            op_seq: 7,
            workspace_id: Some("p".into()),
            thread_id: None,
        };
        let a = child(
            &db,
            &root,
            "round-0",
            "engine.discovery",
            None,
            &json!({"phase":"http"}),
        )
        .unwrap();
        let b = child(
            &db,
            &root,
            "round-1",
            "engine.discovery",
            None,
            &json!({"phase":"http"}),
        )
        .unwrap();
        assert_ne!(a.op_id, b.op_id);
        assert!(child(&db, &root, "bad", "engine.command", None, &json!({})).is_err());
    }
}
