//! Production loopback pairing, cancellation and serialized SQL retries. No LAN/keychain.
use super::*;
use crate::remote::{
    identity::{self, DeviceIdentity},
    store, tls, ListenerHandle, RemoteState,
};
use ring::{rand::SystemRandom, signature::Ed25519KeyPair};
use rusqlite::Connection;
use rustls::{
    pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer},
    sign::CertifiedKey,
};
use tokio::{net::TcpListener, sync::watch, task::JoinHandle};
use tokio_rustls::TlsAcceptor;

const WAIT: Duration = Duration::from_secs(15);
pub(super) struct Node {
    pub(super) inner: Arc<Inner>,
    pub(super) identity: Arc<DeviceIdentity>,
    accept: JoinHandle<()>,
}
impl Node {
    pub(super) async fn new() -> Self {
        let pkcs8 = Ed25519KeyPair::generate_pkcs8(&SystemRandom::new()).unwrap();
        let key = rustls::crypto::ring::default_provider()
            .key_provider
            .load_private_key(PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(
                pkcs8.as_ref().to_vec(),
            )))
            .unwrap();
        let spki = key.public_key().unwrap().as_ref().to_vec();
        let identity = Arc::new(DeviceIdentity {
            fingerprint: identity::fingerprint_of(&spki),
            spki: spki.clone(),
            certified: Arc::new(CertifiedKey::new(vec![CertificateDer::from(spki)], key)),
        });
        let inner = RemoteState::default().inner;
        assert!(inner.identity.set(identity.clone()).is_ok());
        inner
            .install_test_database(Connection::open_in_memory().unwrap())
            .unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let generation = {
            let mut core = inner.lock();
            core.loaded = true;
            core.settings.hosting = true;
            let generation = core.take_id();
            core.listener = Some(ListenerHandle {
                port: listener.local_addr().unwrap().port(),
                temporary: false,
                generation,
                stop: watch::channel(false).0,
            });
            generation
        };
        let acceptor = TlsAcceptor::from(tls::server_config(&identity).unwrap());
        let accepted = inner.clone();
        let accept = tokio::spawn(async move {
            loop {
                let (stream, peer) = listener.accept().await.unwrap();
                tokio::spawn(session::accept(
                    accepted.clone(),
                    acceptor.clone(),
                    stream,
                    peer,
                    generation,
                ));
            }
        });
        Self {
            inner,
            identity,
            accept,
        }
    }
}
impl Drop for Node {
    fn drop(&mut self) {
        self.accept.abort();
        for link in self.inner.lock().links.values() {
            link.close(CloseReason::Finished);
        }
    }
}
async fn until(mut ready: impl FnMut() -> bool) {
    tokio::time::timeout(WAIT, async {
        while !ready() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("condition timed out");
}
fn snapshot(inner: &Inner) -> Value {
    serde_json::to_value(inner.snapshot()).unwrap()
}

/// A real writer job, held without sleeps. Drop also releases it on assertion failure.
struct WriterGate {
    release: Option<std::sync::mpsc::Sender<()>>,
    saved: Option<oneshot::Receiver<Result<(), String>>>,
}
impl WriterGate {
    async fn hold(inner: &Arc<Inner>) -> Self {
        let (started, wait) = oneshot::channel();
        let (release, released) = std::sync::mpsc::channel();
        let saved = {
            let _core = inner.lock();
            inner.enqueue_write(false, move |_| {
                let _ = started.send(());
                released.recv_timeout(WAIT).map_err(|e| e.to_string())?;
                Ok(())
            })
        };
        tokio::time::timeout(WAIT, wait).await.unwrap().unwrap();
        Self {
            release: Some(release),
            saved: Some(saved),
        }
    }
    async fn release(mut self) {
        self.release.take().unwrap().send(()).unwrap();
        crate::remote::finish_write(self.saved.take().unwrap())
            .await
            .unwrap();
    }
}
impl Drop for WriterGate {
    fn drop(&mut self) {
        if let Some(release) = self.release.take() {
            let _ = release.send(());
        }
    }
}
async fn compare(host: &Node, viewer: &Node) -> String {
    let invitation = test_open_window(&host.inner, false, WAIT * 4);
    start_invitation(&viewer.inner, &invitation).await.unwrap();
    until(|| {
        snapshot(&host.inner)["pairing"]["request"]["code"].is_string()
            && snapshot(&viewer.inner)["flow"]["code"].is_string()
    })
    .await;
    snapshot(&host.inner)["pairing"]["request"]["id"]
        .as_str()
        .unwrap()
        .to_string()
}

#[tokio::test]
async fn cancelled_outgoing_save_retry_preserves_concurrent_reciprocal_approval() {
    let a = Node::new().await;
    let b = Node::new().await;
    // A accepts B's host approval, but A's own viewer save is still queued.
    let first = WriterGate::hold(&a.inner).await;
    let request = compare(&b, &a).await;
    respond(&b.inner, &request, true, None).await.unwrap();
    until(|| !a.inner.writes.lock().unwrap().jobs.is_empty()).await;
    cancel_flow(&a.inner);
    first.release().await;
    until(|| a.inner.lock().unsaved.pending()).await;

    // While A's canceled save needs repair, B independently asks to view A.
    // Hold A's SQL writer so its approved host grant is queued but not yet
    // published in memory. Queue the cancellation retry after it, deliberately.
    let second = WriterGate::hold(&a.inner).await;
    let request = compare(&a, &b).await;
    let approved = a.inner.clone();
    let approval = tokio::spawn(async move { respond(&approved, &request, true, None).await });
    until(|| !a.inner.writes.lock().unwrap().jobs.is_empty()).await;
    crate::remote::retry_unsaved(&a.inner);
    assert!(a.inner.lock().unsaved.retrying);
    second.release().await;
    approval.await.unwrap().unwrap();
    until(|| !a.inner.lock().unsaved.retrying).await;

    let fingerprint = &b.identity.fingerprint;
    assert!(
        a.inner.lock().devices[fingerprint].grant.is_some(),
        "host approval published"
    );
    let db = a.inner.test_database.get().unwrap().lock().unwrap();
    let saved = store::load_devices(&db).unwrap();
    assert!(
        saved.get(fingerprint).is_some_and(|d| d.grant.is_some()),
        "canceling A's viewing must not delete B's independently approved host access"
    );
    assert!(
        !saved[fingerprint].they_host,
        "the canceled outgoing relationship must not survive"
    );
}

fn record() -> DeviceRecord {
    DeviceRecord {
        fingerprint: "peer".into(),
        spki: vec![1],
        name: "Peer".into(),
        platform: None,
        addresses: vec![],
        they_host: false,
        access_removed: false,
        paired_at: 1,
        last_seen_at: None,
        grant: None,
    }
}

#[test]
fn canceled_viewer_undo_is_idempotent_and_cannot_undo_a_newer_pair_or_forget() {
    let mut db = Connection::open_in_memory().unwrap();
    store::init(&db).unwrap();
    let mut paired = record();
    paired.they_host = true;
    let old = store::ViewerPairingUndo::new("peer", 1, None);
    store::save_pairing_viewer(&mut db, &paired, &old).unwrap();
    let newer = store::ViewerPairingUndo::new("peer", 2, None);
    // Deliberately byte-identical contact data: only a token can distinguish it.
    store::save_pairing_viewer(&mut db, &paired, &newer).unwrap();
    store::undo_pairing_viewer(&mut db, &old).unwrap();
    assert!(store::load_devices(&db).unwrap()["peer"].they_host);
    store::undo_pairing_viewer(&mut db, &newer).unwrap();
    store::undo_pairing_viewer(&mut db, &newer).unwrap();
    assert!(!store::load_devices(&db).unwrap().contains_key("peer"));
    store::save_pairing_viewer(&mut db, &paired, &newer).unwrap();
    store::delete_device(&mut db, "peer").unwrap();
    store::undo_pairing_viewer(&mut db, &newer).unwrap();
    assert!(!store::load_devices(&db).unwrap().contains_key("peer"));
    assert_eq!(
        db.query_row(
            "SELECT COUNT(*) FROM remote_viewer_pairing_saves",
            [],
            |row| row.get::<_, i64>(0)
        )
        .unwrap(),
        0
    );
}

#[tokio::test]
async fn failed_cancel_undo_retries_without_losing_host_grant_or_queued_work() {
    let inner = RemoteState::default().inner;
    let database = inner
        .install_test_database(Connection::open_in_memory().unwrap())
        .unwrap();
    let mut before = record();
    before.they_host = true;
    before.access_removed = true;
    let mut grant = DeviceGrant::initial();
    grant.work = true;
    grant.revision = 7;
    before.grant = Some(grant.clone());
    let undo = store::ViewerPairingUndo::new("peer", 1, Some(&before));
    {
        let mut db = database.lock().unwrap();
        store::save_device(&mut db, &before).unwrap();
        store::claim_operation(&mut db, "peer", "queued", 1, "prompt.send", "digest").unwrap();
        store::save_delivery_receipt(
            &mut db,
            "peer",
            "queued",
            1,
            &json!({"disposition":"queued","workspaceId":"p","threadId":"t"}),
        )
        .unwrap();
        let mut saving = before.clone();
        saving.access_removed = false;
        store::save_pairing_viewer(&mut db, &saving, &undo).unwrap();
        db.execute_batch("CREATE TEMP TRIGGER fail_undo BEFORE UPDATE OF they_host ON remote_devices BEGIN SELECT RAISE(ABORT,'fixture write failure'); END;").unwrap();
    }
    {
        let mut core = inner.lock();
        core.devices.insert("peer".into(), before);
        core.unsaved.remember_viewer_undo(undo.clone());
    }
    crate::remote::retry_unsaved(&inner);
    until(|| !inner.lock().unsaved.retrying).await;
    assert!(
        inner.lock().unsaved.viewer_undos.contains_key("peer"),
        "failed undo must stay pending"
    );
    database
        .lock()
        .unwrap()
        .execute_batch("DROP TRIGGER fail_undo")
        .unwrap();
    inner.lock().unsaved.retry_at = None;
    crate::remote::retry_unsaved(&inner);
    until(|| !inner.lock().unsaved.pending()).await;
    let mut db = database.lock().unwrap();
    let saved = store::load_devices(&db).unwrap().remove("peer").unwrap();
    assert!(
        saved.they_host && saved.access_removed,
        "restore the preexisting viewer flags"
    );
    assert_eq!(saved.grant, Some(grant));
    assert_eq!(
        store::delivery_receipt(&db, "peer", "queued", 1)
            .unwrap()
            .unwrap()["disposition"],
        "queued"
    );
    // A late failure callback cannot restore an older undo over a newer one.
    let newer = store::ViewerPairingUndo::new("peer", 2, Some(&saved));
    let mut unsaved = crate::remote::Unsaved::default();
    unsaved.remember_viewer_undo(newer);
    unsaved.remember_viewer_undo(undo.clone());
    assert_eq!(unsaved.viewer_undos["peer"].sequence, 2);
    // A full explicit decision supersedes the canceled save, too.
    let mut narrowed = saved;
    narrowed.they_host = false;
    narrowed.access_removed = false;
    store::save_device(&mut db, &narrowed).unwrap();
    store::undo_pairing_viewer(&mut db, &undo).unwrap();
    assert!(!store::load_devices(&db).unwrap()["peer"].they_host);
}

#[tokio::test]
async fn failed_narrowing_retries_wait_for_pairing_publication_then_resnapshot() {
    for retained_contact in [false, true] {
        let a = Node::new().await;
        let b = Node::new().await;
        let fingerprint = b.identity.fingerprint.clone();
        // A prior revoke failed to save. Memory already removed the grant;
        // either a contact remains for the other direction, or it was removed.
        {
            let mut core = a.inner.lock();
            if retained_contact {
                let mut previous = record();
                previous.fingerprint = fingerprint.clone();
                previous.spki = b.identity.spki.clone();
                previous.they_host = true;
                core.devices.insert(fingerprint.clone(), previous);
            }
            core.unsaved.devices.insert(fingerprint.clone());
        }
        let gate = WriterGate::hold(&a.inner).await;
        let request = compare(&a, &b).await;
        let approved = a.inner.clone();
        let approval = tokio::spawn(async move { respond(&approved, &request, true, None).await });
        until(|| !a.inner.writes.lock().unwrap().jobs.is_empty()).await;
        assert!(a
            .inner
            .lock()
            .unpublished_device_saves
            .contains_key(&fingerprint));
        crate::remote::retry_unsaved(&a.inner);
        assert!(
            !a.inner.lock().unsaved.retrying,
            "do not snapshot an unpublished pairing"
        );
        assert!(
            a.inner.lock().unsaved.devices.contains(&fingerprint),
            "keep narrowing repair pending"
        );
        gate.release().await;
        approval.await.unwrap().unwrap();
        until(|| {
            let core = a.inner.lock();
            !core.unpublished_device_saves.contains_key(&fingerprint)
                && core
                    .devices
                    .get(&fingerprint)
                    .is_some_and(|device| device.grant.is_some())
        })
        .await;
        crate::remote::retry_unsaved(&a.inner);
        until(|| !a.inner.lock().unsaved.pending()).await;
        let db = a.inner.test_database.get().unwrap().lock().unwrap();
        let saved = store::load_devices(&db).unwrap();
        assert_eq!(
            saved[&fingerprint].grant,
            a.inner.lock().devices[&fingerprint].grant
        );
        assert!(
            saved[&fingerprint].grant.is_some(),
            "failed narrowing retry erased re-paired host grant"
        );
        assert_eq!(saved[&fingerprint].they_host, retained_contact);
    }
}
