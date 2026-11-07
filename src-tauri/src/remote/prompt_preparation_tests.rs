use super::super::store::{DeviceGrant, DeviceRecord};
use super::*;
struct Fixture {
    inner: Arc<Inner>,
    stamp: Stamp,
    owner: String,
    root: std::path::PathBuf,
    data: std::path::PathBuf,
}
fn git(root: &Path, args: &[&str]) -> std::process::Output {
    let out = crate::process_launch::background_std_command("git")
        .current_dir(root)
        .args(args)
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    out
}
impl Fixture {
    fn new(thread: bool) -> Self {
        let base =
            std::env::temp_dir().join(format!("mythra-preparation-{}", uuid::Uuid::new_v4()));
        let root = base.join("repo");
        let data = base.join("data");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&data).unwrap();
        git(&root, &["init", "-q"]);
        git(&root, &["config", "user.name", "Fixture"]);
        git(&root, &["config", "user.email", "fixture@example.invalid"]);
        std::fs::write(root.join("file"), "before\n").unwrap();
        git(&root, &["add", "."]);
        git(&root, &["commit", "-qm", "initial"]);
        let inner = RemoteState::default().inner;
        let mut db = Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE app_state(key TEXT PRIMARY KEY,value TEXT NOT NULL,updated_at INTEGER NOT NULL);").unwrap();
        store::init(&db).unwrap();
        let stamp = Stamp {
            generation: 1,
            device: "a".repeat(64),
            grant_revision: 1,
            op_id: "prompt".into(),
            op_seq: 1,
            workspace_id: Some("p".into()),
            thread_id: thread.then(|| "t".into()),
        };
        store::claim_operation(
            &mut db,
            &stamp.device,
            &stamp.op_id,
            1,
            "prompt.send",
            "digest",
        )
        .unwrap();
        store::save_delivery_receipt(&mut db,&stamp.device,&stamp.op_id,1,&json!({"disposition":"preparing","workspaceId":"p","threadId":stamp.thread_id,"provider":"claude","permission":"ask"})).unwrap();
        commit::write_value(&db, "kiwi.projects", &json!([{"id":"p","path":root}])).unwrap();
        inner.install_test_database(db).unwrap();
        hostbridge::test_attach(&inner, 1);
        let owner = {
            let mut core = inner.lock();
            core.settings.hosting = true;
            let mut grant = DeviceGrant::initial();
            grant.work = true;
            grant.revision = 1;
            grant.capabilities.terminal = true;
            core.devices.insert(
                stamp.device.clone(),
                DeviceRecord {
                    fingerprint: stamp.device.clone(),
                    spki: vec![1],
                    name: "Peer".into(),
                    platform: None,
                    addresses: vec![],
                    they_host: false,
                    access_removed: false,
                    paired_at: 1,
                    last_seen_at: None,
                    grant: Some(grant),
                },
            );
            owners::test_preparation_owner(&mut core, stamp.clone())
        };
        Self {
            inner,
            stamp,
            owner,
            root,
            data,
        }
    }
    async fn prepare(&self, kind: &str) -> Result<Value, String> {
        prepare(
            self.inner.clone(),
            self.data.clone(),
            self.stamp.clone(),
            self.owner.clone(),
            kind.into(),
            self.stamp.thread_id.clone(),
            None,
        )
        .await
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        owners::invalidate(&mut self.inner.lock());
        self.inner.flush_writes(std::time::Duration::from_secs(5));
        std::fs::remove_dir_all(self.root.parent().unwrap()).unwrap();
    }
}
#[tokio::test]
async fn isolated_preparation_joins_duplicates_fences_actual_root_and_never_accepts_prompt() {
    let f = Fixture::new(false);
    let (a, b) = tokio::join!(f.prepare("isolatedCreate"), f.prepare("isolatedCreate"));
    let a = a.unwrap();
    let b = b.unwrap();
    assert_eq!(a["preparationId"], b["preparationId"]);
    assert_eq!(a["worktree"], b["worktree"]);
    assert_eq!(
        f.prepare("isolatedCreate").await.unwrap()["preparationId"],
        a["preparationId"]
    );
    assert_ne!(a["replayed"], b["replayed"]);
    let path = a["worktree"]["path"].as_str().unwrap();
    assert!(Path::new(path).is_dir());
    let delivery = meta(&f.stamp, &f.owner);
    {
        let core = f.inner.lock();
        assert!(verify_native_root(&core, &delivery, f.root.to_str().unwrap()).is_err());
        let identity = verify_native_root(&core, &delivery, path).unwrap().unwrap();
        assert!(check_native_root(&core, &delivery, "thread/start", None, None).is_err());
        check_native_root(&core, &delivery, "thread/start", None, Some(&identity)).unwrap();
    }
    let db = f.inner.test_database.get().unwrap().lock().unwrap();
    let receipt = store::delivery_receipt(&db, &f.stamp.device, &f.stamp.op_id, 1)
        .unwrap()
        .unwrap();
    assert_eq!(receipt["disposition"], "preparing");
    assert!(receipt.get("nativeSteps").is_none());
    drop(db);
    // Cleanup uses the exact native-created managed checkout, before provider input.
    let before = f.prepare("checkpointBefore").await.unwrap();
    let discarded = f.prepare("isolatedDiscard").await.unwrap();
    let reference =
        crate::project_git::checkpoint_ref(before["checkpointId"].as_str().unwrap(), "before")
            .unwrap();
    assert!(
        String::from_utf8_lossy(&git(&f.root, &["for-each-ref", &reference]).stdout).is_empty()
    );
    assert_eq!(discarded["payload"]["folderRemoved"], true);
    assert!(!Path::new(path).exists());
    assert!(f.prepare("isolatedCreate").await.is_err());
}
#[tokio::test]
async fn checkpoint_preparation_replays_and_merges_metadata_without_accepting_input() {
    let f = Fixture::new(true);
    let before = f.prepare("checkpointBefore").await.unwrap();
    let duplicate = f.prepare("checkpointBefore").await.unwrap();
    assert_eq!(before["checkpointId"], duplicate["checkpointId"]);
    assert_eq!(duplicate["replayed"], true);
    std::fs::write(f.root.join("file"), "after changed\n").unwrap();
    let after = f.prepare("checkpointAfter").await.unwrap();
    assert_eq!(before["checkpointId"], after["checkpointId"]);
    assert!(after["payload"]["changedFiles"].as_u64().unwrap() > 0);
    let db = f.inner.test_database.get().unwrap().lock().unwrap();
    let checkpoints = row(&db, "kiwi.checkpoints").unwrap();
    assert_eq!(checkpoints.as_array().unwrap().len(), 1);
    assert_eq!(checkpoints[0]["status"], "ready");
    assert!(checkpoints[0]["afterCommit"].is_string());
    assert_eq!(
        store::delivery_receipt(&db, &f.stamp.device, &f.stamp.op_id, 1)
            .unwrap()
            .unwrap()["disposition"],
        "preparing"
    );
}
#[tokio::test]
async fn terminal_grant_and_exact_owner_are_required_before_any_git_preparation() {
    let f = Fixture::new(true);
    f.inner
        .lock()
        .devices
        .get_mut(&f.stamp.device)
        .unwrap()
        .grant
        .as_mut()
        .unwrap()
        .capabilities
        .terminal = false;
    assert!(f.prepare("checkpointBefore").await.is_err());
    let db = f.inner.test_database.get().unwrap().lock().unwrap();
    assert_eq!(
        db.query_row(
            "SELECT COUNT(*) FROM remote_prompt_preparations",
            [],
            |row| row.get::<_, i64>(0)
        )
        .unwrap(),
        0
    );
    drop(db);
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
    let unrelated = owners::test_preparation_owner(
        &mut f.inner.lock(),
        Stamp {
            op_id: "other".into(),
            ..f.stamp.clone()
        },
    );
    assert!(prepare(
        f.inner.clone(),
        f.data.clone(),
        f.stamp.clone(),
        unrelated,
        "checkpointBefore".into(),
        Some("t".into()),
        None
    )
    .await
    .is_err());
    let anchor = Anchor::open(&f.root).unwrap();
    let fence = domain::make_preparation_context(
        f.inner.clone(),
        f.stamp.clone(),
        "prompt.send".into(),
        anchor,
        meta(&f.stamp, &f.owner),
    );
    owners::retire_device(&mut f.inner.lock(), &f.stamp.device);
    assert!(
        domain::with_context(fence, || domain::spawn_gate(|| Ok(()))).is_err(),
        "retired owner cannot spawn even with a previously granted context"
    );
}
#[tokio::test]
async fn git_init_preparation_handles_a_project_without_a_repository() {
    let f = Fixture::new(false);
    std::fs::remove_dir_all(f.root.join(".git")).unwrap();
    let initialized = f.prepare("gitInit").await.unwrap();
    assert_eq!(initialized["payload"]["initialized"], true);
    assert!(f.root.join(".git").is_dir());
    assert_eq!(f.prepare("gitInit").await.unwrap()["replayed"], true);
}

#[tokio::test]
async fn draft_checkpoint_binds_only_after_native_thread_proof_and_replay_keeps_binding() {
    let f = Fixture::new(false);
    let before = f.prepare("checkpointBefore").await.unwrap();
    assert!(
        before["rows"]
            .as_array()
            .unwrap()
            .iter()
            .find(|r| r["key"] == "kiwi.checkpoints")
            .unwrap()["value"]
            .is_null(),
        "no fabricated thread in checkpoint list"
    );
    assert!(bind(
        f.inner.clone(),
        f.stamp.clone(),
        f.owner.clone(),
        "t".into()
    )
    .await
    .is_err());
    // This is the production owner proof seam used by native thread/start and
    // start/turn tracking. No GUI or provider response is fabricated by IPC.
    owners::prepared_thread(&mut f.inner.lock(), &meta(&f.stamp, &f.owner), "t").unwrap();
    let bound = bind(
        f.inner.clone(),
        f.stamp.clone(),
        f.owner.clone(),
        "t".into(),
    )
    .await
    .unwrap();
    assert_eq!(bound["bound"], true);
    assert_eq!(
        f.prepare("checkpointBefore").await.unwrap()["replayed"],
        true
    );
    check_native_root(
        &f.inner.lock(),
        &meta(&f.stamp, &f.owner),
        "turn/start",
        Some("t"),
        None,
    )
    .unwrap();
    assert!(check_native_root(
        &f.inner.lock(),
        &meta(&f.stamp, &f.owner),
        "turn/start",
        Some("other"),
        None
    )
    .is_err());
    let after = prepare(
        f.inner.clone(),
        f.data.clone(),
        f.stamp.clone(),
        f.owner.clone(),
        "checkpointAfter".into(),
        Some("t".into()),
        None,
    )
    .await
    .unwrap();
    assert_eq!(before["checkpointId"], after["checkpointId"]);
    let db = f.inner.test_database.get().unwrap().lock().unwrap();
    let checkpoints = row(&db, "kiwi.checkpoints").unwrap();
    assert_eq!(checkpoints[0]["threadId"], "t");
    assert_eq!(checkpoints[0]["status"], "ready");
}

#[test]
fn malformed_checkpoint_metadata_is_refused_not_replaced_with_an_empty_list() {
    let f = Fixture::new(true);
    let mut db = f.inner.test_database.get().unwrap().lock().unwrap();
    let malformed = json!({"unexpected":"keep this existing value"});
    commit::write_value(&db, "kiwi.checkpoints", &malformed).unwrap();
    assert!(save_checkpoint(
        &mut db,
        &f.stamp,
        f.root.to_str().unwrap(),
        "t",
        "Remote turn",
        "checkpointBefore",
        &json!({"checkpointId":"new","snapshot":{"commit":"oid","repoRoot":f.root,"fileCount":1}})
    )
    .is_err());
    assert_eq!(row(&db, "kiwi.checkpoints").unwrap(), malformed);
}

#[tokio::test]
async fn canceled_ipc_keeps_serialization_until_its_blocking_git_worker_ends() {
    let f = Fixture::new(false);
    let (started, waiting) = tokio::sync::oneshot::channel();
    let (release, worker_release) = std::sync::mpsc::channel();
    f.inner.lock().prompt_preparations.worker_gate = Some((started, worker_release));
    let (inner, data, stamp, owner) = (
        f.inner.clone(),
        f.data.clone(),
        f.stamp.clone(),
        f.owner.clone(),
    );
    let task = tokio::spawn(async move {
        prepare(
            inner,
            data,
            stamp,
            owner,
            "isolatedCreate".into(),
            None,
            None,
        )
        .await
    });
    tokio::time::timeout(std::time::Duration::from_secs(10), waiting)
        .await
        .unwrap()
        .unwrap();
    task.abort();
    assert!(task.await.unwrap_err().is_cancelled());
    let key = std::fs::canonicalize(&f.root).unwrap();
    let lock = f.inner.lock().prompt_preparations.locks[&key]
        .upgrade()
        .unwrap();
    assert!(
        lock.try_lock().is_err(),
        "canceling the awaiter released a still-running repository worker"
    );
    release.send(()).unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(10), async {
        while lock.try_lock().is_err() {
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    let db = f.inner.test_database.get().unwrap().lock().unwrap();
    assert_eq!(
        saved(&db, &f.stamp, "isolatedCreate").unwrap().unwrap().1,
        "started",
        "lost completion must remain uncertain, not silently repeat Git"
    );
}
