//! Real loopback TLS and the real ordered SQLite writer. No desktop, discovery,
//! credentials, LAN sockets or provider subprocesses are involved.
use super::*;
use crate::remote::session::CloseReason;
use crate::remote::{
    self,
    identity::{self, DeviceIdentity},
    tls, ListenerHandle, NearbyEntry, RemoteState,
};
use ring::{rand::SystemRandom, signature::Ed25519KeyPair};
use rusqlite::Connection;
use rustls::{
    pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer},
    sign::CertifiedKey,
};
use std::path::PathBuf;
use tokio::{net::TcpListener, sync::watch, task::JoinHandle};
use tokio_rustls::TlsAcceptor;

const TEST_WAIT: Duration = Duration::from_secs(15);
struct Database(PathBuf);
impl Database {
    fn new() -> Arc<Self> {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join("simple-pairing-tests")
            .join(uuid::Uuid::new_v4().to_string());
        std::fs::create_dir_all(&path).unwrap();
        Arc::new(Self(path))
    }
    fn open(&self) -> Connection {
        Connection::open(self.0.join("state.sqlite")).unwrap()
    }
}
impl Drop for Database {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}
fn identity() -> Arc<DeviceIdentity> {
    let pkcs8 = Ed25519KeyPair::generate_pkcs8(&SystemRandom::new()).unwrap();
    let key = rustls::crypto::ring::default_provider()
        .key_provider
        .load_private_key(PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(
            pkcs8.as_ref().to_vec(),
        )))
        .unwrap();
    let spki = key.public_key().unwrap().as_ref().to_vec();
    Arc::new(DeviceIdentity {
        fingerprint: identity::fingerprint_of(&spki),
        spki: spki.clone(),
        certified: Arc::new(CertifiedKey::new(vec![CertificateDer::from(spki)], key)),
    })
}
struct Node {
    inner: Arc<Inner>,
    identity: Arc<DeviceIdentity>,
    address: SocketAddr,
    accept: JoinHandle<()>,
    database: Arc<Database>,
}
impl Node {
    async fn new() -> Self {
        Self::open(identity(), Database::new(), true).await
    }
    async fn open(
        identity: Arc<DeviceIdentity>,
        database: Arc<Database>,
        initialize: bool,
    ) -> Self {
        let inner = RemoteState::default().inner;
        assert!(inner.identity.set(identity.clone()).is_ok());
        let db = database.open();
        store::init(&db).unwrap();
        if initialize {
            store::set_hosting(&db, true).unwrap();
        }
        inner.install_test_database(db).unwrap();
        remote::load(&inner).await;
        assert!(!inner.lock().load_failed);
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let generation = {
            let mut core = inner.lock();
            let generation = core.take_id();
            core.listener = Some(ListenerHandle {
                port: address.port(),
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
                let (tcp, peer) = listener.accept().await.unwrap();
                tokio::spawn(session::accept(
                    accepted.clone(),
                    acceptor.clone(),
                    tcp,
                    peer,
                    generation,
                ));
            }
        });
        Self {
            inner,
            identity,
            address,
            accept,
            database,
        }
    }
    async fn restart(self) -> Self {
        let identity = self.identity.clone();
        let database = self.database.clone();
        // No delayed old-process work may continue writing into the reopened fixture.
        self.inner.exiting.store(true, Ordering::Release);
        close(&self);
        self.inner.flush_writes(TEST_WAIT);
        drop(self);
        Self::open(identity, database, false).await
    }
    fn discover(&self, peer: &Node) -> String {
        let instance = format!("mythra-{}", &peer.identity.fingerprint[..8]);
        let mut entry = NearbyEntry::new(1);
        entry.addresses = vec![peer.address];
        entry.resolved_at = Some(Instant::now());
        entry.name = Some("Test computer".into());
        entry.proven = Some(peer.identity.fingerprint.clone());
        self.inner.lock().nearby.insert(instance.clone(), entry);
        instance
    }
    async fn link(&self, peer: &Node, role: Role) -> Arc<Link> {
        session::dial(
            &self.inner,
            &self.identity,
            peer.address,
            ServerKeyPolicy::Pinned(peer.identity.fingerprint.clone()),
            session::DialPurpose::Pairing(role),
        )
        .await
        .expect("real TLS loopback link")
    }
    fn outgoing(&self) -> Vec<OutgoingView> {
        self.inner.lock().access.views().1
    }
    fn incoming(&self) -> Vec<RequestView> {
        self.inner.lock().access.views().0
    }
    fn device(&self, peer: &Node) -> Option<DeviceRecord> {
        self.inner
            .lock()
            .devices
            .get(&peer.identity.fingerprint)
            .cloned()
    }
    fn durable_devices(&self) -> HashMap<String, DeviceRecord> {
        store::load_devices(&self.database.open()).unwrap()
    }
}
impl Drop for Node {
    fn drop(&mut self) {
        self.inner.exiting.store(true, Ordering::Release);
        self.accept.abort();
        close(self);
    }
}
fn close(node: &Node) {
    let links: Vec<_> = node.inner.lock().links.values().cloned().collect();
    for link in links {
        link.close(CloseReason::Finished);
    }
}
async fn until(nodes: &[&Node], mut condition: impl FnMut() -> bool) {
    tokio::time::timeout(TEST_WAIT, async {
        loop {
            if condition() {
                return;
            }
            for node in nodes {
                schedule(&node.inner);
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("simple pairing condition timed out");
}
async fn begin(sender: &Node, host: &Node, reciprocal: bool) -> String {
    let instance = sender.discover(host);
    request(&sender.inner, &instance, reciprocal).await.unwrap();
    let id = sender.outgoing().last().unwrap().request_id.clone();
    until(&[sender, host], || {
        host.incoming().iter().any(|r| r.request_id == id)
            && sender
                .outgoing()
                .iter()
                .any(|r| r.request_id == id && r.state == "waiting")
    })
    .await;
    id
}
async fn answer(sender: &Node, host: &Node, id: &str, decision: &str) {
    respond(&host.inner, &sender.identity.fingerprint, id, decision)
        .await
        .unwrap();
    let state = if decision == "allow" {
        "allowed"
    } else if decision == "viewOnly" {
        "viewOnly"
    } else {
        "declined"
    };
    until(&[sender, host], || {
        sender
            .outgoing()
            .iter()
            .any(|r| r.request_id == id && r.state == state)
    })
    .await;
}
fn no_access(a: &Node, b: &Node) {
    assert!(a
        .device(b)
        .is_none_or(|d| d.grant.is_none() && !d.they_host));
    assert!(b
        .device(a)
        .is_none_or(|d| d.grant.is_none() && !d.they_host));
}
async fn raw_request(sender: &Node, host: &Node, id: &str) -> Result<Value, WireError> {
    let link = sender.link(host, Role::Viewer).await;
    let result = link
        .request(
            "access.request",
            json!({"requestId":id,"name":"Test computer",
        "platform":"windows","reciprocal":false,"port":sender.address.port()}),
            TEST_WAIT,
        )
        .await;
    close(sender);
    close(host);
    until(&[], || {
        host.inner.unauthenticated.available_permits() == remote::MAX_UNAUTHENTICATED
    })
    .await;
    result
}

#[tokio::test]
async fn requests_survive_real_database_reopen_on_both_computers() {
    let sender = Node::new().await;
    let host = Node::new().await;
    let id = begin(&sender, &host, false).await;
    let code = host.incoming()[0].code.clone();
    assert_eq!(sender.outgoing()[0].code.as_deref(), Some(code.as_str()));
    no_access(&sender, &host);
    let sender = sender.restart().await;
    let host = host.restart().await;
    assert_eq!(host.incoming()[0].request_id, id);
    assert_eq!(host.incoming()[0].code, code);
    assert_eq!(sender.outgoing()[0].request_id, id);
    assert_eq!(sender.outgoing()[0].state, "waiting");
    no_access(&sender, &host);
    sender.discover(&host);
    host.discover(&sender);
    answer(&sender, &host, &id, "allow").await;
    assert!(sender.durable_devices()[&host.identity.fingerprint].they_host);
    assert!(host.durable_devices()[&sender.identity.fingerprint]
        .grant
        .is_some());
}

#[tokio::test]
async fn allow_view_only_and_decline_work_from_either_computer() {
    for swap in [false, true] {
        for decision in ["allow", "viewOnly", "decline"] {
            let a = Node::new().await;
            let b = Node::new().await;
            let (sender, host) = if swap { (&b, &a) } else { (&a, &b) };
            let id = begin(sender, host, false).await;
            no_access(sender, host);
            let link = sender
                .inner
                .lock()
                .links
                .values()
                .find(|l| l.is_open())
                .unwrap()
                .clone();
            let denied = link
                .request("workspaces.list", Value::Null, TEST_WAIT)
                .await
                .unwrap_err();
            assert!(
                matches!(
                    denied.code.as_str(),
                    "not_paired" | "forbidden" | "host_unavailable"
                ),
                "{denied:?}"
            );
            answer(sender, host, &id, decision).await;
            if decision == "decline" {
                no_access(sender, host);
            } else {
                let grant = host.durable_devices()[&sender.identity.fingerprint]
                    .grant
                    .clone()
                    .unwrap();
                assert!(grant.view);
                assert_eq!(grant.work, decision == "allow");
                assert_eq!(grant.capabilities.full_access, decision == "allow");
                assert_eq!(grant.capabilities.terminal, decision == "allow");
                assert_eq!(grant.capabilities.git_write, decision == "allow");
                assert_eq!(grant.capabilities.manage_projects, decision == "allow");
                assert_eq!(grant.capabilities.checkpoint_restore, decision == "allow");
                assert!(matches!(grant.scope, store::GrantScope::All));
                assert!(sender.durable_devices()[&host.identity.fingerprint].they_host);
            }
        }
    }
}

#[tokio::test]
async fn reciprocal_consent_commits_both_directions_only_after_answer() {
    for decision in ["allow", "viewOnly", "decline"] {
        let sender = Node::new().await;
        let host = Node::new().await;
        let id = begin(&sender, &host, true).await;
        no_access(&sender, &host);
        answer(&sender, &host, &id, decision).await;
        if decision == "decline" {
            no_access(&sender, &host);
        } else {
            until(&[&sender, &host], || {
                host.device(&sender).is_some_and(|d| d.they_host)
            })
            .await;
            let grant = sender.durable_devices()[&host.identity.fingerprint]
                .grant
                .clone()
                .unwrap();
            assert!(grant.work && grant.capabilities.full_access && grant.capabilities.terminal);
            assert!(host.durable_devices()[&sender.identity.fingerprint].they_host);
        }
    }
}

#[tokio::test]
async fn request_and_answer_use_an_existing_reverse_role_link() {
    let sender = Node::new().await;
    let host = Node::new().await;
    let reverse = host.link(&sender, Role::Host).await;
    assert!(reverse.dialed);
    assert_eq!(reverse.role, Role::Host);
    let id = begin(&sender, &host, false).await;
    assert!(sender
        .inner
        .lock()
        .links
        .values()
        .any(|l| !l.dialed && l.role == Role::Viewer));
    answer(&sender, &host, &id, "allow").await;
    assert!(sender.durable_devices()[&host.identity.fingerprint].they_host);
}

#[tokio::test]
async fn answer_is_delivered_on_new_reverse_tcp_after_request_link_is_lost() {
    let sender = Node::new().await;
    let host = Node::new().await;
    let id = begin(&sender, &host, false).await;
    close(&sender);
    close(&host);
    respond(&host.inner, &sender.identity.fingerprint, &id, "allow")
        .await
        .unwrap();
    host.link(&sender, Role::Host).await;
    until(&[], || sender.outgoing()[0].state == "allowed").await;
    assert!(sender.durable_devices()[&host.identity.fingerprint].they_host);
}

#[tokio::test]
async fn decline_is_durable_and_duplicate_delivery_cannot_reopen_it_without_local_consent() {
    let sender = Node::new().await;
    let host = Node::new().await;
    let id = begin(&sender, &host, false).await;
    answer(&sender, &host, &id, "decline").await;
    let sender = sender.restart().await;
    let host = host.restart().await;
    assert_eq!(
        host.inner.lock().access.incoming[&sender.identity.fingerprint].decision,
        "decline"
    );
    assert_eq!(sender.outgoing()[0].state, "declined");
    raw_request(&sender, &host, &id).await.unwrap();
    assert_eq!(
        host.inner.lock().access.incoming[&sender.identity.fingerprint].decision,
        "decline"
    );
    no_access(&sender, &host);
    // A fresh explicit request is still subject to a short anti-harassment cooldown.
    let error = raw_request(&sender, &host, &uuid::Uuid::new_v4().to_string())
        .await
        .unwrap_err();
    assert_eq!(error.code, "rate_limited");
}

#[tokio::test]
async fn incoming_cap_five_refuses_sixth_and_answer_frees_a_slot() {
    let host = Node::new().await;
    let mut senders = Vec::new();
    for _ in 0..6 {
        senders.push(Node::new().await);
    }
    for sender in &senders[..5] {
        raw_request(sender, &host, &uuid::Uuid::new_v4().to_string())
            .await
            .unwrap();
    }
    assert_eq!(
        host.inner
            .lock()
            .access
            .incoming
            .values()
            .filter(|r| r.pending())
            .count(),
        5
    );
    let sixth = uuid::Uuid::new_v4().to_string();
    assert_eq!(
        raw_request(&senders[5], &host, &sixth)
            .await
            .unwrap_err()
            .code,
        "inbox_full"
    );
    let first = host.incoming()[0].clone();
    respond(
        &host.inner,
        &first.fingerprint,
        &first.request_id,
        "decline",
    )
    .await
    .unwrap();
    raw_request(&senders[5], &host, &sixth).await.unwrap();
    assert_eq!(
        host.inner
            .lock()
            .access
            .incoming
            .values()
            .filter(|r| r.pending())
            .count(),
        5
    );
}

#[tokio::test]
async fn per_key_and_source_budgets_refuse_excess_new_requests_not_duplicates() {
    let host = Node::new().await;
    let sender = Node::new().await;
    for i in 0..3 {
        let id = uuid::Uuid::new_v4().to_string();
        raw_request(&sender, &host, &id).await.unwrap();
        raw_request(&sender, &host, &id).await.unwrap();
        // Advance only the record's age, leaving the real admission clock intact.
        respond(&host.inner, &sender.identity.fingerprint, &id, "decline")
            .await
            .unwrap();
        {
            let mut core = host.inner.lock();
            let row = core
                .access
                .incoming
                .get_mut(&sender.identity.fingerprint)
                .unwrap();
            row.view.created_at -= 61_000;
            row.answered_at = Some(now() - 61_000);
        }
        assert_eq!(
            host.incoming().len(),
            1,
            "one slot per proven key, iteration {i}"
        );
    }
    assert_eq!(
        raw_request(&sender, &host, &uuid::Uuid::new_v4().to_string())
            .await
            .unwrap_err()
            .code,
        "rate_limited"
    );
    let host = Node::new().await;
    for _ in 0..10 {
        let sender = Node::new().await;
        let id = uuid::Uuid::new_v4().to_string();
        raw_request(&sender, &host, &id).await.unwrap();
        respond(&host.inner, &sender.identity.fingerprint, &id, "decline")
            .await
            .unwrap();
    }
    let sender = Node::new().await;
    assert_eq!(
        raw_request(&sender, &host, &uuid::Uuid::new_v4().to_string())
            .await
            .unwrap_err()
            .code,
        "rate_limited"
    );
}

#[tokio::test]
async fn cancellation_prevents_late_answer_and_reciprocal_grant() {
    let sender = Node::new().await;
    let host = Node::new().await;
    let id = begin(&sender, &host, true).await;
    cancel(&sender.inner, &id).await.unwrap();
    let reverse = host.link(&sender, Role::Host).await;
    let _ = reverse
        .request(
            "access.answer",
            json!({"requestId":id,"decision":"allow",
        "name":"Test computer","platform":"windows"}),
            TEST_WAIT,
        )
        .await;
    assert_eq!(sender.outgoing()[0].state, "cancelled");
    no_access(&sender, &host);
    let sender = sender.restart().await;
    assert_eq!(sender.outgoing()[0].state, "cancelled");
    no_access(&sender, &host);
}

#[tokio::test]
async fn expired_requests_cannot_be_allowed_and_do_not_consume_inbox_slots() {
    let sender = Node::new().await;
    let host = Node::new().await;
    let id = begin(&sender, &host, true).await;
    assert!(host.incoming()[0].expires_at - host.incoming()[0].created_at <= LIFETIME);
    {
        let mut core = host.inner.lock();
        let row = core
            .access
            .incoming
            .get_mut(&sender.identity.fingerprint)
            .unwrap();
        row.view.expires_at = now() - 1;
    }
    {
        let mut core = sender.inner.lock();
        let row = core.access.outgoing.get_mut(&id).unwrap();
        row.view.expires_at = now() - 1;
    }
    assert!(host.incoming().is_empty());
    assert_eq!(sender.outgoing()[0].state, "expired");
    assert!(
        respond(&host.inner, &sender.identity.fingerprint, &id, "allow")
            .await
            .is_err()
    );
    no_access(&sender, &host);
}

#[tokio::test]
async fn allow_reconnects_as_usable_pinned_links_with_real_public_keys() {
    let sender = Node::new().await;
    let host = Node::new().await;
    let id = begin(&sender, &host, true).await;
    answer(&sender, &host, &id, "allow").await;
    until(&[&sender, &host], || {
        remote::schedule_dials(&sender.inner);
        remote::schedule_dials(&host.inner);
        [&sender, &host].iter().all(|node| {
            node.inner
                .lock()
                .links
                .values()
                .any(|l| l.is_open() && l.is_paired() && l.role == Role::Viewer)
        })
    })
    .await;
    for (a, b) in [(&sender, &host), (&host, &sender)] {
        assert_eq!(
            a.durable_devices()[&b.identity.fingerprint].spki,
            b.identity.spki
        );
        let link = a
            .inner
            .lock()
            .links
            .values()
            .find(|l| l.is_open() && l.is_paired() && l.role == Role::Viewer)
            .unwrap()
            .clone();
        assert_eq!(
            link.request("ping", Value::Null, TEST_WAIT).await.unwrap()["ok"],
            true
        );
    }
}

#[tokio::test]
async fn a_different_proven_key_cannot_answer_another_computers_request() {
    let sender = Node::new().await;
    let host = Node::new().await;
    let stranger = Node::new().await;
    let id = begin(&sender, &host, true).await;
    let link = stranger.link(&sender, Role::Host).await;
    let error = link
        .request(
            "access.answer",
            json!({"requestId":id,"decision":"allow",
        "name":"Test computer","platform":"windows"}),
            TEST_WAIT,
        )
        .await
        .unwrap_err();
    assert_eq!(error.code, "not_found");
    no_access(&sender, &host);
    no_access(&sender, &stranger);
    assert_eq!(sender.outgoing()[0].state, "waiting");
}

#[tokio::test]
async fn cancelled_outgoing_consent_stays_cancelled_after_restart_and_answer_replay() {
    let sender = Node::new().await;
    let host = Node::new().await;
    let id = begin(&sender, &host, true).await;
    cancel(&sender.inner, &id).await.unwrap();
    let sender = sender.restart().await;
    let link = host.link(&sender, Role::Host).await;
    let _ = link
        .request(
            "access.answer",
            json!({"requestId":id,"decision":"allow",
        "name":"Test computer","platform":"windows"}),
            TEST_WAIT,
        )
        .await;
    assert_eq!(sender.outgoing()[0].state, "cancelled");
    no_access(&sender, &host);
}

#[tokio::test]
async fn narrowing_is_durable_and_old_answer_cannot_restore_reciprocal_authority() {
    let sender = Node::new().await;
    let host = Node::new().await;
    let id = begin(&sender, &host, true).await;
    // The real device-narrowing writer path persists request retirement in the
    // same transaction as Revoke/Forget. The commands themselves require IPC.
    let saved = {
        let mut core = sender.inner.lock();
        core.end_relationship(&host.identity.fingerprint);
        core.access.retire(&host.identity.fingerprint);
        sender
            .inner
            .enqueue_device_state(&core, &host.identity.fingerprint)
    };
    remote::finish_write(saved).await.unwrap();
    let sender = sender.restart().await;
    let link = host.link(&sender, Role::Host).await;
    let _ = link
        .request(
            "access.answer",
            json!({"requestId":id,"decision":"allow",
        "name":"Test computer","platform":"windows"}),
            TEST_WAIT,
        )
        .await;
    assert_eq!(sender.outgoing()[0].state, "cancelled");
    no_access(&sender, &host);
}

#[tokio::test]
async fn cancellation_from_another_key_cannot_undo_an_approved_grant() {
    let sender = Node::new().await;
    let host = Node::new().await;
    let stranger = Node::new().await;
    let id = uuid::Uuid::new_v4().to_string();
    raw_request(&sender, &host, &id).await.unwrap();
    respond(&host.inner, &sender.identity.fingerprint, &id, "allow")
        .await
        .unwrap();
    let before = host.durable_devices()[&sender.identity.fingerprint]
        .grant
        .clone();
    assert!(before.is_some());
    let link = stranger.link(&host, Role::Viewer).await;
    let _ = link
        .request("access.cancel", json!({"requestId":id}), TEST_WAIT)
        .await;
    assert_eq!(
        host.durable_devices()[&sender.identity.fingerprint].grant,
        before,
        "an unapproved different key must not address the approved peer's effect token"
    );
}

#[tokio::test]
async fn request_over_opposite_paired_data_role_does_not_borrow_or_overwrite_its_grant() {
    for decision in ["allow", "decline"] {
        let sender = Node::new().await;
        let host = Node::new().await;
        // B already views A. A now asks to view B over B's existing connection.
        for (a, b, they_host, grant) in [
            (&sender, &host, false, Some(DeviceGrant::initial())),
            (&host, &sender, true, None),
        ] {
            let row = DeviceRecord {
                fingerprint: b.identity.fingerprint.clone(),
                spki: b.identity.spki.clone(),
                name: "Test computer".into(),
                platform: None,
                addresses: vec![b.address.to_string()],
                they_host,
                access_removed: false,
                paired_at: now(),
                last_seen_at: None,
                grant,
            };
            store::save_device(&mut a.database.open(), &row).unwrap();
            a.inner.lock().devices.insert(row.fingerprint.clone(), row);
        }
        let original = session::dial(
            &host.inner,
            &host.identity,
            sender.address,
            ServerKeyPolicy::Pinned(sender.identity.fingerprint.clone()),
            session::DialPurpose::Paired,
        )
        .await
        .unwrap();
        assert!(original.is_paired());
        let before = sender.device(&host).unwrap().grant.clone();
        let id = begin(&sender, &host, false).await;
        assert!(sender
            .inner
            .lock()
            .links
            .values()
            .any(|l| l.is_open() && l.is_paired() && l.role == Role::Host));
        assert!(!sender.device(&host).unwrap().they_host);
        assert!(host.device(&sender).unwrap().grant.is_none());
        answer(&sender, &host, &id, decision).await;
        assert_eq!(sender.device(&host).unwrap().grant, before);
        assert_eq!(
            sender.durable_devices()[&host.identity.fingerprint].grant,
            before
        );
        assert!(host.device(&sender).unwrap().they_host);
        assert_eq!(sender.device(&host).unwrap().they_host, decision == "allow");
        assert_eq!(
            host.device(&sender).unwrap().grant.is_some(),
            decision == "allow"
        );
    }
}

#[tokio::test]
async fn equal_request_ids_from_different_proven_keys_have_independent_effects() {
    let host = Node::new().await;
    let a = Node::new().await;
    let b = Node::new().await;
    let id = uuid::Uuid::new_v4().to_string();
    for sender in [&a, &b] {
        raw_request(sender, &host, &id).await.unwrap();
        respond(&host.inner, &sender.identity.fingerprint, &id, "allow")
            .await
            .expect("an untrusted peer cannot reserve another peer's UUID namespace");
    }
    assert!(host.durable_devices()[&a.identity.fingerprint]
        .grant
        .is_some());
    assert!(host.durable_devices()[&b.identity.fingerprint]
        .grant
        .is_some());
}

#[tokio::test]
async fn host_can_change_accidental_decline_to_allow_or_view_only_without_cooldown() {
    for decision in ["allow", "viewOnly"] {
        let sender = Node::new().await;
        let host = Node::new().await;
        let id = begin(&sender, &host, false).await;
        answer(&sender, &host, &id, "decline").await;
        assert_eq!(host.incoming()[0].request_id, id);
        answer(&sender, &host, &id, decision).await;
        let grant = host.durable_devices()[&sender.identity.fingerprint]
            .grant
            .clone()
            .unwrap();
        assert!(grant.view);
        assert_eq!(grant.work, decision == "allow");
        assert!(sender.durable_devices()[&host.identity.fingerprint].they_host);
    }
}

#[tokio::test]
async fn old_decline_ack_cannot_acknowledge_a_newer_allow_or_view_only_decision() {
    for decision in ["allow", "viewOnly"] {
        let sender = Node::new().await;
        let host = Node::new().await;
        let id = begin(&sender, &host, false).await;
        until(&[], || {
            sender.inner.lock().access.syncing.is_empty()
                && host.inner.lock().access.syncing.is_empty()
                && sender.inner.active_dials.load(Ordering::Acquire) == 0
                && host.inner.active_dials.load(Ordering::Acquire) == 0
        })
        .await;
        // Stop the requester's handler, not TCP. The decline reply cannot
        // arrive until after the host changes its decision locally.
        let receiver_gate = sender.inner.access_serial.lock().await;
        respond(&host.inner, &sender.identity.fingerprint, &id, "decline")
            .await
            .unwrap();
        let host_link = host
            .inner
            .lock()
            .links
            .values()
            .find(|l| l.is_open())
            .unwrap()
            .clone();
        // This fresh host has not answered anything before this Decline.
        // Its automatic connected callback may already have started the send;
        // do not demand an extra request beyond that in-flight first answer.
        until(&[], || {
            connected(&host.inner, &host_link);
            host_link.test_trace().contains(&"request_started")
        })
        .await;
        respond(&host.inner, &sender.identity.fingerprint, &id, decision)
            .await
            .unwrap();
        drop(receiver_gate);
        until(&[], || host.inner.lock().access.syncing.is_empty()).await;
        let acked = host.inner.lock().access.incoming[&sender.identity.fingerprint].acked;
        let state = sender.outgoing()[0].state.clone();
        assert!(!acked||state=="allowed"||state=="viewOnly",
            "a stale decline response acknowledged the replacement {decision} decision: requester={state}, host acked={acked}");
        let expected = if decision == "allow" {
            "allowed"
        } else {
            "viewOnly"
        };
        // Drive the replacement answer directly: this test checks revision
        // fencing, not the independent reconnect backoff clock.
        connected(&host.inner, &host_link);
        until(&[&sender, &host], || sender.outgoing()[0].state == expected).await;
    }
}

#[tokio::test]
async fn reasking_replaces_a_declined_id_and_fences_old_host_buttons_and_answers() {
    let sender = Node::new().await;
    let host = Node::new().await;
    let old = begin(&sender, &host, true).await;
    answer(&sender, &host, &old, "decline").await;
    // Cross the cooldown only after any real ack/save has published: a bare
    // test mutation must not race a captured pre-shift row in the writer.
    let sender_clock_guard=sender.inner.access_serial.lock().await;
    let host_clock_guard=host.inner.access_serial.lock().await;
    {
        let mut core = sender.inner.lock();
        core.access.outgoing.get_mut(&old).unwrap().declined_at = Some(now() - 61_000);
    }
    {
        let mut core = host.inner.lock();
        let row = core
            .access
            .incoming
            .get_mut(&sender.identity.fingerprint)
            .unwrap();
        row.answered_at = Some(now() - 61_000);
        row.view.created_at -= 61_000;
    }
    drop(host_clock_guard);
    drop(sender_clock_guard);
    let instance = sender.discover(&host);
    request(&sender.inner, &instance, false).await.unwrap();
    let new = sender
        .outgoing()
        .iter()
        .find(|r| r.request_id != old)
        .unwrap()
        .request_id
        .clone();
    until(&[&sender, &host], || {
        host.incoming().iter().any(|r| r.request_id == new)
    })
    .await;
    assert_ne!(old, new);
    assert!(
        respond(&host.inner, &sender.identity.fingerprint, &old, "allow")
            .await
            .is_err()
    );
    let link = host
        .inner
        .lock()
        .links
        .values()
        .find(|l| l.is_open())
        .unwrap()
        .clone();
    let _ = link
        .request(
            "access.answer",
            json!({"requestId":old,"decision":"allow",
        "name":"Test computer","platform":"windows"}),
            TEST_WAIT,
        )
        .await;
    no_access(&sender, &host);
    assert_eq!(
        sender
            .outgoing()
            .iter()
            .find(|r| r.request_id == old)
            .unwrap()
            .state,
        "cancelled"
    );
    answer(&sender, &host, &new, "viewOnly").await;
    assert!(
        sender.device(&host).unwrap().grant.is_none(),
        "old reciprocal checkbox must not apply to the new unchecked request"
    );
}

#[tokio::test]
async fn outgoing_capacity_is_enforced_after_restart_and_cancel_frees_a_slot() {
    let sender = Node::new().await;
    let mut hosts = Vec::new();
    for _ in 0..6 {
        hosts.push(Node::new().await);
    }
    for host in &hosts[..5] {
        let instance = sender.discover(host);
        request(&sender.inner, &instance, false).await.unwrap();
    }
    let instance = sender.discover(&hosts[5]);
    assert!(request(&sender.inner, &instance, false).await.is_err());
    assert_eq!(sender.outgoing().len(), 5);
    let sender = sender.restart().await;
    let instance = sender.discover(&hosts[5]);
    assert!(request(&sender.inner, &instance, false).await.is_err());
    let id = sender.outgoing()[0].request_id.clone();
    cancel(&sender.inner, &id).await.unwrap();
    request(&sender.inner, &instance, false).await.unwrap();
    assert_eq!(
        sender
            .outgoing()
            .iter()
            .filter(|r| matches!(r.state.as_str(), "connecting" | "waiting"))
            .count(),
        5
    );
}

#[tokio::test]
async fn completed_initial_sync_does_not_prevent_cancel_delivery_on_the_same_link() {
    let sender = Node::new().await;
    let host = Node::new().await;
    let id = begin(&sender, &host, true).await;
    until(&[], || {
        sender.inner.lock().access.syncing.is_empty()
            && host.inner.lock().access.syncing.is_empty()
            && sender.inner.active_dials.load(Ordering::Acquire) == 0
            && host.inner.active_dials.load(Ordering::Acquire) == 0
    })
    .await;
    cancel(&sender.inner, &id).await.unwrap();
    until(&[&sender, &host], || {
        host.inner.lock().access.incoming[&sender.identity.fingerprint].decision == "cancelled"
    })
    .await;
    no_access(&sender, &host);
}

/// Holds the real ordered writer at a known point without sleeping.
struct WriteGate {
    release: Option<std::sync::mpsc::Sender<()>>,
    done: Option<tokio::sync::oneshot::Receiver<Result<(), String>>>,
}
impl WriteGate {
    async fn hold(inner: &Arc<Inner>) -> Self {
        let (ready, started) = tokio::sync::oneshot::channel();
        let (release, released) = std::sync::mpsc::channel();
        let done = {
            let _core = inner.lock();
            inner.enqueue_write(false, move |_| {
                let _ = ready.send(());
                released
                    .recv_timeout(TEST_WAIT)
                    .map_err(|e| e.to_string())?;
                Ok(())
            })
        };
        tokio::time::timeout(TEST_WAIT, started)
            .await
            .unwrap()
            .unwrap();
        Self {
            release: Some(release),
            done: Some(done),
        }
    }
    async fn release(mut self) {
        self.release.take().unwrap().send(()).unwrap();
        remote::finish_write(self.done.take().unwrap())
            .await
            .unwrap();
    }
}
impl Drop for WriteGate {
    fn drop(&mut self) {
        if let Some(tx) = self.release.take() {
            let _ = tx.send(());
        }
    }
}

#[tokio::test]
async fn forget_during_unpublished_request_save_cannot_restore_consent_after_restart() {
    let sender = Node::new().await;
    let host = Node::new().await;
    let peer = host.identity.fingerprint.clone();
    let device = DeviceRecord {
        fingerprint: peer.clone(),
        spki: host.identity.spki.clone(),
        name: "Test computer".into(),
        platform: None,
        addresses: vec![host.address.to_string()],
        they_host: true,
        access_removed: true,
        paired_at: now(),
        last_seen_at: None,
        grant: None,
    };
    store::save_device(&mut sender.database.open(), &device).unwrap();
    sender.inner.lock().devices.insert(peer.clone(), device);
    let instance = sender.discover(&host);
    let gate = WriteGate::hold(&sender.inner).await;
    let pending = sender.inner.clone();
    let creating = tokio::spawn(async move { request(&pending, &instance, true).await });
    until(&[], || !sender.inner.writes.lock().unwrap().jobs.is_empty()).await;
    assert!(
        sender.outgoing().is_empty(),
        "creation has not been published yet"
    );
    let narrowed = {
        let mut core = sender.inner.lock();
        // Same authority and persistence changes as remote_device_forget.
        core.devices.remove(&peer);
        core.dials.remove(&peer);
        core.end_relationship(&peer);
        core.access.retire(&peer);
        sender.inner.enqueue_device_state(&core, &peer)
    };
    gate.release().await;
    let _ = creating.await.unwrap();
    remote::finish_write(narrowed).await.unwrap();
    let sender = sender.restart().await;
    if sender.outgoing().iter().any(|r| {
        r.fingerprint.as_deref() == Some(&peer)
            && matches!(r.state.as_str(), "connecting" | "waiting")
    }) {
        // Show the actual authority consequence, not just a stale UI card.
        until(&[&sender, &host], || !host.incoming().is_empty()).await;
        let id = host.incoming()[0].request_id.clone();
        answer(&sender, &host, &id, "allow").await;
    }
    assert!(
        sender.device(&host).is_none_or(|d| d.grant.is_none()),
        "Forget must fence an unpublished reciprocal proposal durably, not only until process exit"
    );
    assert!(!sender
        .outgoing()
        .iter()
        .any(|r| r.fingerprint.as_deref() == Some(&peer)
            && matches!(r.state.as_str(), "connecting" | "waiting" | "declined")));
}
