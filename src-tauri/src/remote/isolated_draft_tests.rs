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
async fn isolated_draft_real_managed_root_binds_exact_thread_and_retries_once() {
    let f = Fixture::new(false);
    let created = f.prepare("isolatedCreate").await.unwrap();
    let path = created["worktree"]["path"].as_str().unwrap();
    assert!(std::fs::canonicalize(path).unwrap().starts_with(std::fs::canonicalize(f.data.join("worktrees")).unwrap()));
    assert_eq!(git(Path::new(path), &["rev-parse", "HEAD"]).stdout, git(&f.root, &["rev-parse", "HEAD"]).stdout);
    assert!(bind(f.inner.clone(), f.stamp.clone(), f.owner.clone(), "new-thread".into()).await.is_err());
    owners::prepared_thread(&mut f.inner.lock(), &meta(&f.stamp, &f.owner), "new-thread").unwrap();
    let bound = bind(f.inner.clone(), f.stamp.clone(), f.owner.clone(), "new-thread".into()).await.unwrap();
    let trees = bound["rows"].as_array().unwrap().iter().find(|r| r["key"] == "kiwi.threadWorktrees").unwrap();
    assert_eq!(trees["value"]["new-thread"]["path"], path);
    assert_eq!(trees["value"]["new-thread"]["projectId"], "p");
    assert_eq!(f.prepare("isolatedCreate").await.unwrap()["worktree"], created["worktree"]);
    bind(f.inner.clone(), f.stamp.clone(), f.owner.clone(), "new-thread".into()).await.unwrap();
    let count = String::from_utf8(git(&f.root, &["worktree", "list", "--porcelain"]).stdout).unwrap().lines().filter(|line| line.starts_with("worktree ")).count();
    assert_eq!(count, 2, "one shared checkout plus exactly one isolated checkout");
}

#[tokio::test]
async fn isolated_draft_without_terminal_or_with_wrong_owner_has_no_effect() {
    let f = Fixture::new(false);
    f.inner.lock().devices.get_mut(&f.stamp.device).unwrap().grant.as_mut().unwrap().capabilities.terminal = false;
    assert_eq!(f.prepare("isolatedCreate").await.unwrap_err(), work::refused("forbidden"));
    assert!(!f.data.join("worktrees").exists());
    f.inner.lock().devices.get_mut(&f.stamp.device).unwrap().grant.as_mut().unwrap().capabilities.terminal = true;
    assert!(prepare(f.inner.clone(), f.data.clone(), f.stamp.clone(), "wrong-owner".into(), "isolatedCreate".into(), None, None).await.is_err());
    assert!(!f.data.join("worktrees").exists());
}

#[tokio::test]
async fn isolated_draft_git_failure_is_explicit_and_cannot_repeat_effect() {
    let f = Fixture::new(false);
    // Refuse creation at the local helper's normal managed-root step.
    std::fs::write(f.data.join("worktrees"), "not a directory").unwrap();
    let error = f.prepare("isolatedCreate").await.unwrap_err();
    assert!(error.starts_with("MYTHRA_DELIVERY_UNCERTAIN:"));
    assert!(error.contains("worktree or checkpoint may already exist"));
    assert!(f.prepare("isolatedCreate").await.unwrap_err().starts_with("MYTHRA_DELIVERY_UNCERTAIN:"));
    let db = f.inner.test_database.get().unwrap().lock().unwrap();
    assert_eq!(saved(&db, &f.stamp, "isolatedCreate").unwrap().unwrap().1, "started");
    assert!(row(&db, "kiwi.threadWorktrees").unwrap().is_null());
    assert!(row(&db, "kiwi.threadProjects").unwrap().is_null());
}

#[tokio::test]
async fn prepared_checkpoint_keeps_accepted_turn_for_selected_checkpoint_fork() {
    let f = Fixture::new(true);
    let before = f.prepare("checkpointBefore").await.unwrap();
    let s = f.stamp.clone();
    super::super::finish_write(f.inner.enqueue_write(false, move |db| {
        let mut receipt = store::delivery_receipt(db, &s.device, &s.op_id, s.op_seq)?.unwrap();
        receipt["disposition"] = json!("accepted");
        receipt["turnId"] = json!("native-completed-turn");
        store::save_native_delivery_receipt(db, &s.device, &s.op_id, s.op_seq, &receipt)
    })).await.unwrap();
    f.prepare("checkpointAfter").await.unwrap();
    let db = f.inner.test_database.get().unwrap().lock().unwrap();
    let records = row(&db, "kiwi.checkpoints").unwrap();
    assert_eq!(records[0]["id"], before["checkpointId"]);
    assert_eq!(records[0]["turnId"], "native-completed-turn");
}
