use super::*;
use super::tests::fixture;

fn checkpoint(f: &tests::Fixture) -> Value {
    json!({"id":"selected", "threadId":"t", "workspacePath":f.path, "turnId":"turn-before-latest", "status":"ready"})
}

#[test]
fn checkpoint_fork_resolves_host_turn_and_refuses_missing_foreign_or_unbound_selection() {
    let f = fixture("thread.fork");
    let root = f.path.to_str().unwrap();
    assert_eq!(fork_turn(&f.db, &f.stamp, root, &json!({})).unwrap(), None);
    let args = json!({"checkpointId":"selected"});
    assert!(fork_turn(&f.db, &f.stamp, root, &args).is_err());
    let valid = checkpoint(&f);
    commit::write_value(&f.db, "kiwi.checkpoints", &json!([valid])).unwrap();
    assert_eq!(fork_turn(&f.db, &f.stamp, root, &args).unwrap().as_deref(), Some("turn-before-latest"));
    for (field, bad) in [("threadId", json!("other")), ("workspacePath", json!(f.path.join("other"))), ("turnId", Value::Null), ("turnId", json!(""))] {
        let mut row = valid.clone(); row[field] = bad;
        commit::write_value(&f.db, "kiwi.checkpoints", &json!([row])).unwrap();
        assert!(fork_turn(&f.db, &f.stamp, root, &args).is_err(), "{field}");
    }
    commit::write_value(&f.db, "kiwi.checkpoints", &json!([{"id":"selected","threadId":"t"}])).unwrap();
    let old = fork_turn(&f.db, &f.stamp, root, &args).unwrap_err();
    assert!(old.contains("checkpoint_turn_unavailable"));
    assert!(old.contains("older checkpoint has no saved conversation turn"));
    commit::write_value(&f.db, "kiwi.checkpoints", &json!([valid, valid])).unwrap();
    assert!(fork_turn(&f.db, &f.stamp, root, &args).is_err());
}

#[test]
fn checkpoint_fork_snapshot_cas_and_work_permission_match_latest_fork() {
    let mut f = fixture("thread.fork");
    let root = f.path.to_str().unwrap().to_owned();
    let valid = checkpoint(&f);
    commit::write_value(&f.db, "kiwi.checkpoints", &json!([valid])).unwrap();
    let book = Book { version: 1, rows: rows(&f.db, "thread.fork").unwrap() };
    let args = json!({"checkpointId":"selected"});
    let effect = json!({"thread":{"id":"fork","cwd":root,"modelProvider":"claude","turns":[{"id":"turn-before-latest"}]}});
    f.inner.lock().devices.get_mut("device").unwrap().grant.as_mut().unwrap().work = false;
    assert!(finish_thread(&mut f.db, &f.inner, &f.stamp, "claude", &root, "thread.fork", &args, &book, &effect, false).is_err());
    assert!(commit::prior(&f.db, &f.stamp).unwrap().is_none());
    f.inner.lock().devices.get_mut("device").unwrap().grant.as_mut().unwrap().work = true;
    let mut changed = valid.clone(); changed["turnId"] = json!("different-turn");
    commit::write_value(&f.db, "kiwi.checkpoints", &json!([changed])).unwrap();
    assert!(verify(&f.db, "thread.fork", &book).is_err());
    commit::write_value(&f.db, "kiwi.checkpoints", &json!([valid])).unwrap();
    let book = Book { version: 1, rows: rows(&f.db, "thread.fork").unwrap() };
    // Terminal is false in the fixture: selecting history does not grant or
    // require the unrelated ability to run repository hooks.
    let result = finish_thread(&mut f.db, &f.inner, &f.stamp, "claude", &root, "thread.fork", &args, &book, &effect, false).unwrap();
    assert_eq!(result["result"]["threadId"], "fork");
    let saved = commit::prior(&f.db, &f.stamp).unwrap().unwrap();
    assert_eq!(saved["threadId"], "fork");
    assert_eq!(value(&f.db, "kiwi.threadProjects").unwrap()["fork"], root);
    assert_eq!(value(&f.db, "kiwi.checkpoints").unwrap(), json!([valid]));
}

#[test]
fn checkpoint_fork_wire_accepts_only_checkpoint_identity_not_paths_or_rpc_arguments() {
    let base = json!({"opId":"op", "opSeq":1, "threadId":"t", "checkpointId":"selected"});
    assert!(super::super::manifest::validate("thread.fork", &base).unwrap());
    for bad in [Value::Null, json!(42), json!(""), json!("bad\nturn")] {
        let mut args = base.clone(); args["checkpointId"] = bad;
        assert!(super::super::manifest::validate("thread.fork", &args).is_err());
    }
    for key in ["cwd", "lastTurnId", "config"] {
        let mut args = base.clone(); args[key] = json!("viewer-supplied");
        assert!(super::super::manifest::validate("thread.fork", &args).is_err());
    }
}
