//! Native session reads and exact queued-steer delivery. No renderer-selected
//! paths or provider settings; every response is scoped again at publication.
use super::{
    commit::{self, Stamp},
    fs_guard::Anchor,
    hostbridge,
    session::Link,
    store,
    wire::{Role, WireError},
    work, Core, Inner,
};
use rusqlite::Connection;
use serde_json::{json, Value};
use std::{collections::HashSet, sync::Arc};

fn stale() -> String {
    work::refused("stale_target")
}
fn error() -> WireError {
    WireError::new(
        "stale_target",
        "This message is no longer available in that shared conversation.",
    )
}
pub(super) fn project_roots(db: &Connection, workspace: &str) -> Result<HashSet<String>, String> {
    let projects = commit::state_row(db, "kiwi.projects")?;
    let project = projects["value"]
        .as_array()
        .and_then(|p| p.iter().find(|p| p["id"] == workspace))
        .ok_or_else(stale)?;
    let root = project["path"].as_str().ok_or_else(stale)?;
    let mut roots = HashSet::from([Anchor::open(std::path::Path::new(root))?.identity()?]);
    let trees = commit::state_row(db, "kiwi.threadWorktrees")?;
    for tree in trees["value"]
        .as_object()
        .into_iter()
        .flat_map(|m| m.values())
        .filter(|r| r["projectId"] == workspace && r["status"] != "removed")
    {
        if let Some(path) = tree["path"].as_str() {
            if let Ok(anchor) = Anchor::open(std::path::Path::new(path)) {
                if let Ok(id) = anchor.identity() {
                    roots.insert(id);
                }
            }
        }
    }
    Ok(roots)
}
fn thread_anchor(
    db: &Connection,
    stamp: &Stamp,
    app: Option<&tauri::AppHandle>,
) -> Result<Anchor, String> {
    let workspace = stamp.workspace_id.as_deref().ok_or_else(stale)?;
    let thread = stamp.thread_id.as_deref().ok_or_else(stale)?;
    let known = commit::state_row(db, "kiwi.knownThreads")?;
    let record = known["value"].get(thread).ok_or_else(stale)?;
    if record
        .get("modelProvider")
        .or_else(|| record.get("provider"))
        .and_then(Value::as_str)
        != Some("claude")
    {
        return Err(stale());
    }
    let raw: String = db.query_row("SELECT thread_json FROM local_transcript_meta WHERE provider='claude' AND thread_id=?1",[thread],|r|r.get(0)).map_err(|_|stale())?;
    let meta: Value = serde_json::from_str(&raw).map_err(|_| stale())?;
    if meta["id"] != thread {
        return Err(stale());
    }
    let cwd = meta["cwd"].as_str().ok_or_else(stale)?;
    let anchor = Anchor::open(std::path::Path::new(cwd))?;
    if workspace == "openkiwi-normal-chats" {
        let app = app.ok_or_else(stale)?;
        if !crate::normal_chat::contains(app, cwd)? {
            return Err(stale());
        }
        let bindings = commit::state_row(db, "kiwi.threadProjects")?;
        let bound = bindings["value"]
            .get(thread)
            .and_then(Value::as_str)
            .ok_or_else(stale)?;
        if Anchor::open(std::path::Path::new(bound))?.identity()? != anchor.identity()? {
            return Err(stale());
        }
        return Ok(anchor);
    }
    let roots = project_roots(db, workspace)?;
    if !roots.contains(&anchor.identity()?) {
        return Err(stale());
    }
    // A project/worktree path collision cannot reassign a known conversation.
    let bindings = commit::state_row(db, "kiwi.threadProjects")?;
    let trees = commit::state_row(db, "kiwi.threadWorktrees")?;
    let projects = commit::state_row(db, "kiwi.projects")?;
    let base = projects["value"]
        .as_array()
        .and_then(|p| p.iter().find(|p| p["id"] == workspace))
        .and_then(|p| p["path"].as_str())
        .ok_or_else(stale)?;
    let bound = bindings["value"]
        .get(thread)
        .and_then(Value::as_str)
        .or_else(|| record["cwd"].as_str())
        .ok_or_else(stale)?;
    let shared = Anchor::open(std::path::Path::new(bound))?.identity()?
        == Anchor::open(std::path::Path::new(base))?.identity()?;
    if !shared
        && !trees["value"]
            .get(thread)
            .is_some_and(|r| r["projectId"] == workspace && r["status"] != "removed")
    {
        return Err(stale());
    }
    Ok(anchor)
}
fn authorize(core: &Core, link: &Link, stamp: &Stamp, write: bool) -> Result<(), String> {
    if link.role != Role::Host
        || !link.is_paired()
        || link.peer_fingerprint != stamp.device
        || !hostbridge::current_link(core, &stamp.device, Role::Host)
            .is_some_and(|l| l.id == link.id)
    {
        return Err(stale());
    }
    hostbridge::check_generation(core, stamp.generation).map_err(|_| stale())?;
    let grant = work::grant_locked(core, &stamp.device)
        .filter(|g| g.view && g.revision == stamp.grant_revision && (!write || g.work))
        .ok_or_else(|| work::refused("forbidden"))?;
    if let store::GrantScope::Projects { project_ids } = &grant.scope {
        if !stamp
            .workspace_id
            .as_ref()
            .is_some_and(|p| project_ids.contains(p))
        {
            return Err(work::refused("forbidden"));
        }
    }
    Ok(())
}
/// Bounds are applied by SQL before materializing message bodies. Steer text is
/// already visible in the timeline, so this API needs only identities/status.
fn saved_steers(db: &Connection, thread: &str) -> Result<Vec<Value>, String> {
    let sql = "SELECT json_extract(j.value,'$.entry.id'),json_extract(j.value,'$.entry.turnId'),
        json_extract(j.value,'$.entry.steerRuntimeId'),json_extract(j.value,'$.entry.steerStatus')
        FROM (SELECT seq,entries_json FROM local_transcript_chunks WHERE provider='claude' AND thread_id=?1 ORDER BY seq DESC LIMIT 32) c,json_each(c.entries_json) j
        WHERE json_extract(j.value,'$.kind')='message' AND json_extract(j.value,'$.entry.role')='user'
        AND json_extract(j.value,'$.entry.steerStatus') IN ('sending','accepted','queued','read','unconfirmed') ORDER BY c.seq DESC,CAST(j.key AS INTEGER) DESC LIMIT 128";
    let mut statement = db.prepare(sql).map_err(|_| stale())?;
    let rows = statement
        .query_map([thread], |r| {
            Ok((
                r.get::<_, Option<String>>(0)?,
                r.get::<_, Option<String>>(1)?,
                r.get::<_, Option<String>>(2)?,
                r.get::<_, String>(3)?,
            ))
        })
        .map_err(|_| stale())?;
    let mut result = Vec::new();
    for row in rows {
        let (message, turn, runtime, status) = row.map_err(|_| stale())?;
        if [message.as_deref(), turn.as_deref(), runtime.as_deref()]
            .iter()
            .flatten()
            .any(|s| s.len() > 512 || s.chars().any(char::is_control))
        {
            continue;
        }
        result.push(json!({"messageId":message,"turnId":turn,"runtimeId":runtime,"status":status,"deliveryRequested":false,"canDeliver":false}));
    }
    Ok(result)
}
pub(crate) struct SteerFence {
    inner: Arc<Inner>,
    link: Arc<Link>,
    stamp: Stamp,
    anchor: Anchor,
    begun: bool,
}
impl SteerFence {
    pub(crate) fn poll<F: std::future::Future<Output = Result<(), String>>>(
        &mut self,
        cx: &mut std::task::Context<'_>,
        future: std::pin::Pin<&mut F>,
    ) -> std::task::Poll<Result<(), String>> {
        if self.begun {
            return future.poll(cx);
        }
        let core = self.inner.lock();
        if let Err(e) =
            authorize(&core, &self.link, &self.stamp, true).and_then(|_| self.anchor.validate())
        {
            return std::task::Poll::Ready(Err(e));
        }
        self.begun = true;
        future.poll(cx)
    }
}
pub(super) async fn steer(
    inner: &Arc<Inner>,
    link: &Arc<Link>,
    op: &str,
    args: Value,
) -> Result<Value, WireError> {
    super::manifest::validate(op, &args)?;
    let write = op == "steer.deliver";
    let workspace = args["workspaceId"].as_str().ok_or_else(error)?.to_owned();
    let thread = args["threadId"].as_str().ok_or_else(error)?.to_owned();
    let stamp = {
        let core = inner.lock();
        let grant = work::grant_locked(&core, &link.peer_fingerprint).ok_or_else(error)?;
        let stamp = Stamp {
            generation: core.bridge.generation,
            device: link.peer_fingerprint.clone(),
            grant_revision: grant.revision,
            op_id: args["opId"].as_str().unwrap_or("").to_owned(),
            op_seq: args["opSeq"].as_u64().unwrap_or(0),
            workspace_id: Some(workspace),
            thread_id: Some(thread.clone()),
        };
        authorize(&core, link, &stamp, write).map_err(|_| {
            WireError::new("forbidden", "This conversation is not shared for steering.")
        })?;
        stamp
    };
    let app = inner.app.get().ok_or_else(error)?.clone();
    let read_app = app.clone();
    let worker = inner.clone();
    let peer = link.clone();
    let copy = stamp.clone();
    let (anchor, mut saved) = inner
        .read_db(move |db| {
            let anchor = thread_anchor(db, &copy, Some(&read_app))?;
            let rows = saved_steers(db, copy.thread_id.as_deref().unwrap())?;
            authorize(&worker.lock(), &peer, &copy, write)?;
            Ok((anchor, rows))
        })
        .await
        .map_err(|_| error())?;
    if !write {
        let live = crate::remote_claude_steers(&app, &thread).await;
        merge_live(&mut saved, &live);
        let core = inner.lock();
        authorize(&core, link, &stamp, false).map_err(|_| error())?;
        anchor.validate().map_err(|_| error())?;
        if !work::grant_locked(&core, &stamp.device).is_some_and(|g| g.work) {
            for row in &mut saved {
                row["canDeliver"] = json!(false);
            }
        }
        return Ok(json!({"threadId":thread,"steers":saved,"truncated":saved.len() >= 128}));
    }
    let turn = args["turnId"].as_str().ok_or_else(error)?.to_owned();
    let runtime = args["runtimeId"].as_str().ok_or_else(error)?.to_owned();
    // Exact request identity is durable before taking the provider input lock.
    let worker = inner.clone();
    let peer = link.clone();
    let copy = stamp.clone();
    let digest = store::request_digest("steer.deliver", &args);
    let write_app = app.clone();
    let admission = super::finish_write(inner.enqueue_write(false, move |db| {
        let core = worker.lock();
        authorize(&core, &peer, &copy, true)?;
        thread_anchor(db, &copy, Some(&write_app))?.validate()?;
        claim_delivery(db, &copy, &digest)
    }))
    .await
    .map_err(|_| error())?;
    if let Some(result) = admission {
        return Ok(result);
    }
    let mut fence = SteerFence {
        inner: inner.clone(),
        link: link.clone(),
        stamp: stamp.clone(),
        anchor,
        begun: false,
    };
    let outcome =
        crate::remote_deliver_claude_steer(&app, &thread, &turn, &runtime, &mut fence).await;
    let result = match outcome {
        Ok(()) => {
            json!({"opId":stamp.op_id,"state":"accepted","threadId":thread,"turnId":turn,"runtimeId":runtime,"deliveryRequested":true})
        }
        Err(_) if fence.begun => json!({"opId":stamp.op_id,"state":"uncertain","threadId":thread}),
        Err(_) => {
            json!({"opId":stamp.op_id,"state":"rejected","error":{"code":"stale_target","message":"That steer is no longer queued in this turn, or delivery is not supported."}})
        }
    };
    let returned = result.clone();
    let copy = stamp.clone();
    super::finish_write(inner.enqueue_write(false, move |db| {
        store::save_operation_result(db, &copy.device, &copy.op_id, copy.op_seq, &result)
    }))
    .await
    .map_err(|_| error())?;
    Ok(returned)
}
fn merge_live(saved: &mut Vec<Value>, live: &Value) {
    for row in saved.iter_mut() {
        row["deliveryRequested"] = json!(false);
        row["canDeliver"] = json!(false);
        let same_turn = row["turnId"] == live["turnId"];
        let actual = live["steers"]
            .as_array()
            .and_then(|rows| rows.iter().find(|r| r["runtimeId"] == row["runtimeId"]));
        if same_turn {
            if let Some(actual) = actual {
                row["status"] = actual["status"].clone();
                row["deliveryRequested"] = actual["deliveryRequested"].clone();
                row["canDeliver"] = json!(
                    live["supported"] == true
                        && actual["status"] == "queued"
                        && actual["deliveryRequested"] != true
                );
            } else if row["status"] == "queued" {
                row["status"] = json!("unconfirmed");
            }
        } else if row["status"] == "queued" {
            row["status"] = json!("unconfirmed");
        }
    }
    // A freshly written steer may not have reached transcript persistence yet.
    for actual in live["steers"].as_array().into_iter().flatten() {
        if !saved
            .iter()
            .any(|r| r["turnId"] == live["turnId"] && r["runtimeId"] == actual["runtimeId"])
        {
            saved.insert(0,json!({"messageId":Value::Null,"turnId":live["turnId"],"runtimeId":actual["runtimeId"],"status":actual["status"],
                "deliveryRequested":actual["deliveryRequested"],"canDeliver":live["supported"] == true && actual["status"] == "queued" && actual["deliveryRequested"] != true}));
            saved.truncate(128);
        }
    }
}

fn claim_delivery(
    db: &mut Connection,
    stamp: &Stamp,
    digest: &str,
) -> Result<Option<Value>, String> {
    match store::claim_operation(
        db,
        &stamp.device,
        &stamp.op_id,
        stamp.op_seq,
        "steer.deliver",
        digest,
    )
    .map_err(|_| stale())?
    {
        store::JournalClaim::Claimed => {
            store::save_delivery_receipt(
                db,
                &stamp.device,
                &stamp.op_id,
                stamp.op_seq,
                &json!({"op":"steer.deliver","generation":stamp.generation,"device":stamp.device,"opId":stamp.op_id,"opSeq":stamp.op_seq,"workspaceId":stamp.workspace_id,"threadId":stamp.thread_id,"grantRevision":stamp.grant_revision,"disposition":"dispatched"}),
            )?;
            Ok(None)
        }
        store::JournalClaim::Existing(_) => {
            store::operation_result(db, &stamp.device, &stamp.op_id).map(Some)
        }
        _ => Err(stale()),
    }
}

#[cfg(test)]
pub(super) mod tests {
    use super::*;
    pub(in crate::remote) fn link(
        inner: &Arc<Inner>,
        stamp: &mut Stamp,
    ) -> (Arc<Link>, tokio::io::DuplexStream) {
        let spki = vec![7; 32];
        let device = super::super::identity::fingerprint_of(&spki);
        {
            let mut core = inner.lock();
            let mut record = core.devices.remove(&stamp.device).unwrap();
            record.fingerprint = device.clone();
            stamp.device = device.clone();
            core.devices.insert(device, record);
        }
        let (stream, peer) = tokio::io::duplex(1024 * 1024);
        let link = super::super::session::test_start_link(
            inner,
            stream,
            super::super::session::LinkSetup {
                peer_spki: spki,
                peer_addr: "127.0.0.1:12345".parse().unwrap(),
                role: Role::Host,
                dialed: true,
                paired: true,
                exporter: [0; 32],
                peer_name: None,
                peer_version: "test".into(),
                unauth: None,
                relationship: 0,
                listener: None,
            },
        );
        (link, peer)
    }
    #[test]
    fn catalog_roots_include_only_the_requested_projects_live_worktrees() {
        let f = super::super::threads::tests::fixture("steer.deliver");
        let live = f.path.join("live");
        let removed = f.path.join("removed");
        let other = f.path.join("other");
        for path in [&live, &removed, &other] {
            std::fs::create_dir(path).unwrap();
        }
        commit::write_value(
            &f.db,
            "kiwi.threadWorktrees",
            &json!({
                "live":{"projectId":"p","path":live,"status":"ready"},
                "removed":{"projectId":"p","path":removed,"status":"removed"},
                "other":{"projectId":"other","path":other,"status":"ready"}
            }),
        )
        .unwrap();
        let roots = project_roots(&f.db, "p").unwrap();
        assert_eq!(roots.len(), 2);
        assert!(roots.contains(&Anchor::open(&live).unwrap().identity().unwrap()));
        assert!(!roots.contains(&Anchor::open(&other).unwrap().identity().unwrap()));
        assert!(!roots.contains(&Anchor::open(&removed).unwrap().identity().unwrap()));
        assert!(project_roots(&f.db, "not-shared").is_err());
        assert!(thread_anchor(&f.db, &f.stamp, None).is_ok());
        let mut forged = f.stamp.clone();
        forged.workspace_id = Some("other".into());
        assert!(thread_anchor(&f.db, &forged, None).is_err());
    }
    #[test]
    fn queued_delivery_journal_is_replayable_but_never_dispatches_twice() {
        let mut f = super::super::threads::tests::fixture("steer.deliver");
        f.stamp.op_id = "deliver".into();
        f.stamp.op_seq = 2;
        assert!(claim_delivery(&mut f.db, &f.stamp, "exact")
            .unwrap()
            .is_none());
        assert!(
            claim_delivery(&mut f.db, &f.stamp, "exact")
                .unwrap()
                .is_some(),
            "a concurrent duplicate never acquires a second input attempt"
        );
        assert!(claim_delivery(&mut f.db, &f.stamp, "substituted-runtime").is_err());
        let result = json!({"opId":"deliver","state":"accepted","deliveryRequested":true});
        store::save_operation_result(&f.db, &f.stamp.device, "deliver", 2, &result).unwrap();
        assert_eq!(
            claim_delivery(&mut f.db, &f.stamp, "exact")
                .unwrap()
                .unwrap(),
            result
        );
        f.stamp.op_id = "new-at-old-sequence".into();
        assert!(claim_delivery(&mut f.db, &f.stamp, "new").is_err());
    }
    #[test]
    fn persisted_steer_projection_is_bounded_and_omits_text_provider_payloads_and_paths() {
        let f = super::super::threads::tests::fixture("steer.deliver");
        f.db.execute(
            "ALTER TABLE local_transcript_chunks ADD COLUMN seq INTEGER DEFAULT 0",
            [],
        )
        .unwrap();
        let entries: Vec<_> = (0..140).map(|i|json!({"kind":"message","entry":{"id":format!("m{i}"),"role":"user","turnId":"original","steerRuntimeId":format!("r{i}"),"steerStatus":"queued","text":"DO-NOT-SEND","cwd":"/private/path"}})).collect();
        f.db.execute("INSERT INTO local_transcript_chunks(provider,thread_id,entries_json,seq) VALUES('claude','t',?1,1)",[json!(entries).to_string()]).unwrap();
        let rows = saved_steers(&f.db, "t").unwrap();
        assert_eq!(rows.len(), 128);
        let encoded = serde_json::to_string(&rows).unwrap();
        assert!(!encoded.contains("DO-NOT-SEND"));
        assert!(!encoded.contains("/private/path"));
        assert_eq!(rows[0]["turnId"], "original");
        assert_eq!(rows[0]["canDeliver"], false);
    }
    #[test]
    fn persisted_queue_status_tracks_only_its_original_turn_and_read_is_not_inferred_from_send_now()
    {
        let mut saved = vec![
            json!({"messageId":"m","turnId":"turn","runtimeId":"runtime","status":"queued"}),
            json!({"messageId":"older","turnId":"old","runtimeId":"runtime","status":"queued"}),
        ];
        let live = json!({"turnId":"turn","supported":true,"steers":[{"runtimeId":"runtime","status":"queued","deliveryRequested":true}]});
        merge_live(&mut saved, &live);
        assert_eq!(saved[0]["status"], "queued");
        assert_eq!(saved[0]["deliveryRequested"], true);
        assert_eq!(saved[0]["canDeliver"], false);
        assert_eq!(saved[1]["status"], "unconfirmed");
        assert_eq!(saved[1]["canDeliver"], false);
        let live = json!({"turnId":"turn","supported":true,"steers":[{"runtimeId":"runtime","status":"read","deliveryRequested":false}]});
        merge_live(&mut saved, &live);
        assert_eq!(saved[0]["status"], "read");
        let mut unseen = vec![];
        merge_live(
            &mut unseen,
            &json!({"turnId":"turn","supported":true,"steers":[{"runtimeId":"fresh","status":"queued","deliveryRequested":false}]}),
        );
        assert_eq!(unseen[0]["messageId"], Value::Null);
        assert_eq!(unseen[0]["canDeliver"], true);
    }
    #[tokio::test]
    async fn grant_scope_and_input_fence_refuse_revocation_before_poll_but_not_list_with_work_off()
    {
        let mut f = super::super::threads::tests::fixture("steer.deliver");
        let (peer, _wire) = link(&f.inner, &mut f.stamp);
        assert!(authorize(&f.inner.lock(), &peer, &f.stamp, true).is_ok());
        let mut fence = SteerFence {
            inner: f.inner.clone(),
            link: peer.clone(),
            stamp: f.stamp.clone(),
            anchor: Anchor::open(&f.path).unwrap(),
            begun: false,
        };
        f.inner
            .lock()
            .devices
            .get_mut(&f.stamp.device)
            .unwrap()
            .grant
            .as_mut()
            .unwrap()
            .work = false;
        assert!(authorize(&f.inner.lock(), &peer, &f.stamp, false).is_ok());
        assert!(authorize(&f.inner.lock(), &peer, &f.stamp, true).is_err());
        let polled = std::sync::atomic::AtomicBool::new(false);
        let write = async {
            polled.store(true, std::sync::atomic::Ordering::Release);
            Ok(())
        };
        tokio::pin!(write);
        assert!(std::future::poll_fn(|cx| fence.poll(cx, write.as_mut()))
            .await
            .is_err());
        assert!(!polled.load(std::sync::atomic::Ordering::Acquire));
        assert!(!fence.begun);
        let mut forged = f.stamp.clone();
        forged.workspace_id = Some("outside".into());
        assert!(authorize(&f.inner.lock(), &peer, &forged, false).is_err());
        f.inner
            .lock()
            .devices
            .get_mut(&f.stamp.device)
            .unwrap()
            .grant = None;
        assert!(authorize(&f.inner.lock(), &peer, &f.stamp, false).is_err());
    }
    #[test]
    fn strict_session_fields_bound_read_bytes_numeric_cursor_and_exact_steer_identity() {
        let validate = super::super::manifest::validate;
        assert!(validate(
            "terminal.read",
            &json!({"workspaceId":"p","terminalId":"id","cursor":100,"limit":65536})
        )
        .unwrap());
        assert!(validate(
            "terminal.read",
            &json!({"workspaceId":"p","terminalId":"id","cursor":"path"})
        )
        .is_err());
        assert!(validate(
            "terminal.read",
            &json!({"workspaceId":"p","terminalId":"id","limit":65537})
        )
        .is_err());
        assert!(validate(
            "terminal.attach",
            &json!({"workspaceId":"p","terminalId":"id","root":"/viewer"})
        )
        .is_err());
        let mut args = json!({"workspaceId":"p","threadId":"t","opId":"id","opSeq":1,"turnId":"turn","runtimeId":"runtime"});
        assert!(validate("steer.deliver", &args).unwrap());
        args["runtimeId"] = Value::Null;
        assert!(validate("steer.deliver", &args).is_err());
        let mut grant = store::DeviceGrant::initial();
        grant.capabilities.terminal = true;
        assert!(super::super::manifest::access("terminal.attach", &grant).is_ok());
        assert!(super::super::manifest::access("steer.deliver", &grant).is_err());
    }
}
