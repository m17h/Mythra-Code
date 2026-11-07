//! Real loopback TCP, production TLS/protocol handlers, SQLite and ring code.
//! No desktop App, keychain, DNS-SD, LAN sockets or external services.
use super::*;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use ring::{rand::SystemRandom, signature::Ed25519KeyPair};
use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};
use rustls::sign::CertifiedKey;
use sha2::{Digest, Sha256};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpStream,
    task::JoinHandle,
};
use tokio_rustls::TlsConnector;
use wire::{Frame, MAX_FRAME, PREAUTH_MAX_FRAME};
const WAIT: Duration = Duration::from_secs(5);
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
async fn until(mut ready: impl FnMut() -> bool) {
    timeout(WAIT, async {
        while !ready() {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("condition timed out");
}
fn snapshot(inner: &Inner) -> Value {
    serde_json::to_value(inner.snapshot()).unwrap()
}
fn device(peer: &DeviceIdentity, host: bool, viewer: bool) -> DeviceRecord {
    DeviceRecord {
        fingerprint: peer.fingerprint.clone(),
        spki: peer.spki.clone(),
        name: "Test device".into(),
        platform: None,
        addresses: Vec::new(),
        they_host: host,
        access_removed: false,
        paired_at: 1,
        last_seen_at: None,
        grant: viewer.then(DeviceGrant::initial),
    }
}
struct Node {
    inner: Arc<Inner>,
    identity: Arc<DeviceIdentity>,
    address: SocketAddr,
    accept: JoinHandle<()>,
}
impl Node {
    async fn new(hosting: bool) -> Self {
        let identity = identity();
        let inner = RemoteState::default().inner;
        assert!(inner.identity.set(identity.clone()).is_ok());
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let generation = {
            let mut core = inner.lock();
            core.loaded = true;
            core.settings.hosting = hosting;
            let generation = core.take_id();
            core.listener = Some(ListenerHandle {
                port: address.port(),
                temporary: !hosting,
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
            address,
            accept,
        }
    }
    async fn connect(&self, host: &Node, role: Role) -> Arc<Link> {
        session::dial(
            &self.inner,
            &self.identity,
            host.address,
            ServerKeyPolicy::Capture,
            DialPurpose::Pairing(role),
        )
        .await
        .expect("loopback TLS/hello")
    }
    fn window(&self, temporary: bool, lifetime: Duration) -> String {
        pairing::test_open_window(&self.inner, temporary, lifetime)
    }
}
impl Drop for Node {
    fn drop(&mut self) {
        self.accept.abort();
        if let Some(events) = EVENTS.get() {
            events
                .lock()
                .unwrap()
                .remove(&(Arc::as_ptr(&self.inner) as usize));
        }
        for link in self.inner.lock().links.values() {
            link.close(CloseReason::Finished);
        }
    }
}
async fn raw_handshake(
    policy: ServerKeyPolicy,
    client: Arc<DeviceIdentity>,
    server: Arc<DeviceIdentity>,
    expected: bool,
) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let acceptor = TlsAcceptor::from(tls::server_config(&server).unwrap());
    let server_task = tokio::spawn(async move {
        let (tcp, _) = listener.accept().await.unwrap();
        let mut stream = acceptor.accept(tcp).await.map_err(|_| ())?;
        let key = stream.get_ref().1.peer_certificates().unwrap()[0]
            .as_ref()
            .to_vec();
        let exporter = stream
            .get_ref()
            .1
            .export_keying_material([0u8; 32], b"test-exporter", None)
            .unwrap();
        let request = wire::read_frame(&mut stream, PREAUTH_MAX_FRAME, WAIT)
            .await
            .map_err(|_| ())?;
        assert!(matches!(
            wire::decode(&request),
            Ok(wire::Decoded::Frame(Frame::Ping { t: 42 }))
        ));
        stream
            .write_all(&wire::encode(&Frame::Pong { t: 42 }).unwrap())
            .await
            .map_err(|_| ())?;
        stream.flush().await.map_err(|_| ())?;
        Ok::<_, ()>((key, exporter))
    });
    let proven: tls::ProvenKey = Default::default();
    let connector =
        TlsConnector::from(tls::client_config(&client, policy, proven.clone()).unwrap());
    let tcp = TcpStream::connect(address).await.unwrap();
    let result = timeout(WAIT, connector.connect(tls::server_name().unwrap(), tcp))
        .await
        .unwrap();
    if expected {
        let mut stream = result.expect("accepted raw key");
        assert_eq!(
            stream.get_ref().1.peer_certificates().unwrap()[0].as_ref(),
            server.spki
        );
        let exporter = stream
            .get_ref()
            .1
            .export_keying_material([0u8; 32], b"test-exporter", None)
            .unwrap();
        stream
            .write_all(&wire::encode(&Frame::Ping { t: 42 }).unwrap())
            .await
            .unwrap();
        stream.flush().await.unwrap();
        let reply = wire::read_frame(&mut stream, PREAUTH_MAX_FRAME, WAIT)
            .await
            .unwrap();
        assert!(matches!(
            wire::decode(&reply),
            Ok(wire::Decoded::Frame(Frame::Pong { t: 42 }))
        ));
        let (key, other_exporter) = timeout(WAIT, server_task).await.unwrap().unwrap().unwrap();
        assert_eq!(key, client.spki);
        assert_eq!(exporter, other_exporter);
    } else {
        assert!(result.is_err(), "wrong server key accepted");
        assert!(
            timeout(WAIT, server_task).await.unwrap().unwrap().is_err(),
            "rejected server received authenticated data"
        );
    }
    assert_eq!(*proven.lock().unwrap(), Some(server.fingerprint.clone()));
}
#[tokio::test]
async fn tls_pinned_key_accepts_and_wrong_key_refuses() {
    let client = identity();
    let server = identity();
    raw_handshake(
        ServerKeyPolicy::Pinned(server.fingerprint.clone()),
        client.clone(),
        server.clone(),
        true,
    )
    .await;
    raw_handshake(
        ServerKeyPolicy::Pinned(identity().fingerprint.clone()),
        client,
        server,
        false,
    )
    .await;
}
#[tokio::test]
async fn tls_paired_set_accepts_only_members() {
    let client = identity();
    let server = identity();
    raw_handshake(
        ServerKeyPolicy::PairedSet(HashSet::from([server.fingerprint.clone()])),
        client.clone(),
        server.clone(),
        true,
    )
    .await;
    raw_handshake(
        ServerKeyPolicy::PairedSet(HashSet::new()),
        client,
        server,
        false,
    )
    .await;
}
#[tokio::test]
async fn tls_capture_proves_keys_and_exporters_match() {
    raw_handshake(ServerKeyPolicy::Capture, identity(), identity(), true).await;
}
fn hash_fields(fields: &[&[u8]]) -> [u8; 32] {
    let mut hash = Sha256::new();
    for field in fields {
        hash.update((field.len() as u32).to_be_bytes());
        hash.update(field);
    }
    hash.finalize().into()
}
fn commitment(link: &Link, mode: &[u8], nonce: &[u8; 32]) -> String {
    URL_SAFE_NO_PAD.encode(hash_fields(&[
        b"mythra-remote-pair-commit-v1",
        &wire::PROTO.to_be_bytes(),
        mode,
        &link.exporter,
        nonce,
    ]))
}
async fn reveal(
    host: &Node,
    viewer: &Node,
    link: &Link,
    mode: &[u8],
    token: Option<&str>,
    valid: bool,
) -> String {
    let nonce = [17u8; 32];
    let mut args = json!({"commit":commitment(link, mode, &nonce)});
    if let Some(token) = token {
        args["token"] = json!(token);
    }
    let reply = link.request("pair.request", args, WAIT).await.unwrap();
    assert!(
        snapshot(&host.inner)["pairing"]["request"].is_null(),
        "code shown before reveal"
    );
    let responder: [u8; 32] = URL_SAFE_NO_PAD
        .decode(reply["nonce"].as_str().unwrap())
        .unwrap()
        .try_into()
        .unwrap();
    let sent = if valid { nonce } else { [18u8; 32] };
    let response = link
        .request(
            "pair.reveal",
            json!({"nonce":URL_SAFE_NO_PAD.encode(sent)}),
            WAIT,
        )
        .await;
    if !valid {
        assert!(response.is_err());
        return String::new();
    }
    response.unwrap();
    let request = snapshot(&host.inner)["pairing"]["request"].clone();
    let hash = hash_fields(&[
        b"mythra-remote-pair-code-v1",
        &wire::PROTO.to_be_bytes(),
        mode,
        &link.exporter,
        &viewer.identity.spki,
        &host.identity.spki,
        &nonce,
        &responder,
    ]);
    let expected = format!(
        "{:06}",
        u64::from_be_bytes(hash[..8].try_into().unwrap()) % 1_000_000
    );
    assert_eq!(request["code"], expected);
    request["id"].as_str().unwrap().into()
}
fn invitation_value(invitation: &str) -> Value {
    serde_json::from_slice(
        &URL_SAFE_NO_PAD
            .decode(invitation.strip_prefix("mythra-invite:1:").unwrap())
            .unwrap(),
    )
    .unwrap()
}
#[tokio::test]
async fn pairing_checks_commit_before_code_and_caps_failed_attempts() {
    let host = Node::new(true).await;
    let viewer = Node::new(false).await;
    host.window(false, Duration::from_secs(60));
    for _ in 0..5 {
        let link = viewer.connect(&host, Role::Viewer).await;
        reveal(&host, &viewer, &link, b"nearby", None, false).await;
        link.close(CloseReason::Finished);
        until(|| host.inner.lock().links.is_empty()).await;
    }
    assert_eq!(snapshot(&host.inner)["pairing"]["nearbyStopped"], true);
    let link = viewer.connect(&host, Role::Viewer).await;
    let error = link
        .request(
            "pair.request",
            json!({"commit":commitment(&link,b"nearby",&[17;32])}),
            WAIT,
        )
        .await
        .unwrap_err();
    assert_eq!(error.code, "pairing_closed");
    assert!(host.inner.lock().devices.is_empty());
}
#[tokio::test]
async fn five_bad_tokens_void_invitation_without_occupying_nearby_slot() {
    let host = Node::new(true).await;
    let viewer = Node::new(false).await;
    host.window(false, Duration::from_secs(60));
    for attempt in 0..5 {
        let link = viewer.connect(&host, Role::Viewer).await;
        let inbound = host.inner.lock().links.values().next().cloned();
        let error = link
            .request(
                "pair.request",
                json!({"commit":commitment(&link,b"invitation",&[17;32]),"token":"wrong"}),
                WAIT,
            )
            .await
            .unwrap_err();
        assert_eq!(error.code, "forbidden", "attempt={attempt} viewer={:?} host={:?}", link.test_trace(), inbound.map(|link|link.test_trace()));
        assert_eq!(snapshot(&host.inner)["pairing"]["waiting"], false);
        link.close(CloseReason::Finished);
        until(|| host.inner.lock().links.is_empty()).await;
    }
    assert_eq!(snapshot(&host.inner)["pairing"]["invitationSpent"], true);
    let link = viewer.connect(&host, Role::Viewer).await;
    let id = reveal(&host, &viewer, &link, b"nearby", None, true).await;
    pairing::respond(&host.inner, &id, false, None)
        .await
        .unwrap();
}
#[tokio::test]
async fn expired_window_and_invitation_refuse_pairing() {
    let host = Node::new(true).await;
    let viewer = Node::new(false).await;
    let invitation = host.window(false, Duration::ZERO);
    let link = viewer.connect(&host, Role::Viewer).await;
    let error = link
        .request(
            "pair.request",
            json!({"commit":commitment(&link,b"nearby",&[17;32])}),
            WAIT,
        )
        .await
        .unwrap_err();
    assert_eq!(error.code, "pairing_closed");
    let mut value = invitation_value(&invitation);
    value["exp"] = json!(1);
    let expired = format!(
        "mythra-invite:1:{}",
        URL_SAFE_NO_PAD.encode(serde_json::to_vec(&value).unwrap())
    );
    assert!(pairing::start_invitation(&viewer.inner, &expired)
        .await
        .unwrap_err()
        .contains("expired"));
    assert!(viewer.inner.lock().devices.is_empty());
}
#[tokio::test]
async fn valid_invitation_preempts_nearby_pending_slot() {
    let host = Node::new(true).await;
    let viewer = Node::new(false).await;
    let invited = Node::new(false).await;
    let invitation = host.window(false, Duration::from_secs(60));
    let first = viewer.connect(&host, Role::Viewer).await;
    first
        .request(
            "pair.request",
            json!({"commit":commitment(&first,b"nearby",&[17;32])}),
            WAIT,
        )
        .await
        .unwrap();
    let next = invited.connect(&host, Role::Viewer).await;
    let token = invitation_value(&invitation)["token"]
        .as_str()
        .unwrap()
        .to_string();
    let id = reveal(&host, &invited, &next, b"invitation", Some(&token), true).await;
    assert_eq!(snapshot(&host.inner)["pairing"]["request"]["invited"], true);
    until(|| !first.is_open()).await;
    pairing::respond(&host.inner, &id, false, None)
        .await
        .unwrap();
}
#[tokio::test]
async fn losing_reverse_link_cannot_kill_direct_paired_link() {
    let host = Node::new(true).await;
    let viewer = Node::new(false).await;
    host.inner.lock().devices.insert(
        viewer.identity.fingerprint.clone(),
        device(&viewer.identity, false, true),
    );
    viewer.inner.lock().devices.insert(
        host.identity.fingerprint.clone(),
        device(&host.identity, true, false),
    );
    let direct = session::dial(
        &viewer.inner,
        &viewer.identity,
        host.address,
        ServerKeyPolicy::Pinned(host.identity.fingerprint.clone()),
        DialPurpose::Paired,
    )
    .await
    .unwrap();
    assert_eq!(
        direct.request("ping", json!({}), WAIT).await.unwrap()["ok"],
        true
    );
    let reverse = session::dial(
        &host.inner,
        &host.identity,
        viewer.address,
        ServerKeyPolicy::Pinned(viewer.identity.fingerprint.clone()),
        DialPurpose::Paired,
    )
    .await;
    assert!(matches!(reverse, Err(DialError::NotNeeded(_))));
    assert!(direct.is_open());
    assert_eq!(
        direct.request("ping", json!({}), WAIT).await.unwrap()["ok"],
        true
    );
}
async fn raw_frame(bytes: Vec<u8>, limit: usize) -> std::io::Result<Vec<u8>> {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let sender = tokio::spawn(async move {
        let mut stream = TcpStream::connect(address).await.unwrap();
        stream.write_all(&bytes).await.unwrap();
        stream.shutdown().await.unwrap();
    });
    let (mut stream, _) = listener.accept().await.unwrap();
    let result = wire::read_frame(&mut stream, limit, WAIT).await;
    sender.await.unwrap();
    result
}
#[tokio::test]
async fn wire_limits_and_partial_frames_over_real_tcp() {
    for length in [0, (PREAUTH_MAX_FRAME + 1) as u32, u32::MAX] {
        assert_eq!(
            raw_frame(length.to_be_bytes().to_vec(), PREAUTH_MAX_FRAME)
                .await
                .unwrap_err()
                .kind(),
            std::io::ErrorKind::InvalidData
        );
    }
    assert_eq!(
        raw_frame(vec![0, 0, 0, 5, b'{'], MAX_FRAME)
            .await
            .unwrap_err()
            .kind(),
        std::io::ErrorKind::UnexpectedEof
    );
    assert!(matches!(
        wire::decode(
            &raw_frame(wire::encode(&Frame::Ping { t: 1 }).unwrap(), MAX_FRAME)
                .await
                .unwrap()
        ),
        Ok(wire::Decoded::Frame(Frame::Ping { t: 1 }))
    ));
    assert!(wire::encode(&Frame::Req {
        id: 1,
        op: "x".into(),
        args: json!({"text":"x".repeat(MAX_FRAME)})
    })
    .is_err());
    assert!(wire::decode(br#"{"k":"req","id":"wrong"}"#).is_err());
}
#[test]
fn journal_claim_existing_digest_mismatch_and_expired() {
    let mut db = Connection::open_in_memory().unwrap();
    store::init(&db).unwrap();
    let digest = store::request_digest("prompt.send", &json!({"text":"hello","threadId":"t"}));
    assert_eq!(
        digest,
        store::request_digest("prompt.send", &json!({"threadId":"t","text":"hello"}))
    );
    assert!(matches!(
        store::claim_operation(&mut db, "peer", "one", 1, "prompt.send", &digest).unwrap(),
        store::JournalClaim::Claimed
    ));
    assert!(matches!(
        store::claim_operation(&mut db, "peer", "one", 1, "prompt.send", &digest).unwrap(),
        store::JournalClaim::Existing(_)
    ));
    assert!(matches!(
        store::claim_operation(&mut db, "peer", "one", 1, "prompt.send", "different").unwrap(),
        store::JournalClaim::DigestMismatch
    ));
    db.execute("UPDATE remote_op_journal SET state='accepted'", [])
        .unwrap();
    for seq in 2..=1001 {
        assert!(matches!(
            store::claim_operation(
                &mut db,
                "peer",
                &format!("op-{seq}"),
                seq,
                "prompt.send",
                &digest
            )
            .unwrap(),
            store::JournalClaim::Claimed
        ));
        db.execute(
            "UPDATE remote_op_journal SET state='accepted' WHERE op_id=?1",
            [format!("op-{seq}")],
        )
        .unwrap();
    }
    assert!(matches!(
        store::claim_operation(&mut db, "peer", "one", 1, "prompt.send", &digest).unwrap(),
        store::JournalClaim::Expired
    ));
    assert_eq!(
        store::op_status(&db, "peer", "one", Some(1)).unwrap().state,
        "expired"
    );
    assert_eq!(
        store::op_status(&db, "other-peer", "one", Some(1))
            .unwrap()
            .state,
        "unknown"
    );
}
#[test]
fn stale_details_after_revoke_do_not_recreate_grant_or_device() {
    let mut db = Connection::open_in_memory().unwrap();
    store::init(&db).unwrap();
    let peer = identity();
    let stale = device(&peer, true, true);
    store::save_device(&mut db, &stale).unwrap();
    let mut revoked = stale.clone();
    revoked.grant = None;
    store::save_device(&mut db, &revoked).unwrap();
    store::update_device_details(&db, &stale).unwrap();
    assert!(store::load_devices(&db).unwrap()[&peer.fingerprint]
        .grant
        .is_none());
    store::delete_device(&mut db, &peer.fingerprint).unwrap();
    store::update_device_details(&db, &stale).unwrap();
    assert!(!store::load_devices(&db)
        .unwrap()
        .contains_key(&peer.fingerprint));
}
#[test]
fn timeline_replay_eviction_epoch_and_atomic_validation() {
    let mut timelines = timeline::Timelines::default();
    timelines.baseline("t", "epoch", 0).unwrap();
    let frame = |seq| timeline::PublishedFrame {
        seq,
        frame: json!({"text":seq}),
    };
    timelines
        .publish("t", "epoch", (1..=512).map(frame).collect())
        .unwrap();
    assert_eq!(timelines.replay("t", "epoch", 0, 512).unwrap().len(), 512);
    timelines
        .publish("t", "epoch", (513..=520).map(frame).collect())
        .unwrap();
    assert!(!timelines.can_replay("t", "epoch", 0));
    assert_eq!(timelines.replay("t", "epoch", 8, 520).unwrap().len(), 512);
    assert!(!timelines.can_replay("t", "other", 519));
    assert!(timelines
        .publish("t", "epoch", vec![frame(521), frame(523)])
        .is_err());
    assert_eq!(timelines.rings["t"].seq, 520);
    assert!(timelines.publish("t", "new", vec![frame(521)]).is_err());
    timelines.retire("t");
    timelines.baseline("t", "new", 7).unwrap();
    assert!(timelines.can_replay("t", "new", 7));
    assert!(!timelines.can_replay("t", "epoch", 7));
}

#[tokio::test]
async fn initiator_and_responder_show_matching_codes_over_forward_link() {
    let host = Node::new(true).await;
    let viewer = Node::new(false).await;
    let invitation = host.window(false, Duration::from_secs(60));
    pairing::start_invitation(&viewer.inner, &invitation)
        .await
        .unwrap();
    until(|| {
        snapshot(&host.inner)["pairing"]["request"]["code"].is_string()
            && snapshot(&viewer.inner)["flow"]["code"].is_string()
    })
    .await;
    let host_view = snapshot(&host.inner);
    let viewer_view = snapshot(&viewer.inner);
    assert_eq!(
        host_view["pairing"]["request"]["code"],
        viewer_view["flow"]["code"]
    );
    assert_eq!(viewer_view["flow"]["stage"], "comparing");
    assert!(viewer.inner.lock().devices.is_empty());
    assert!(host.inner.lock().devices.is_empty());
    pairing::respond(
        &host.inner,
        host_view["pairing"]["request"]["id"].as_str().unwrap(),
        false,
        None,
    )
    .await
    .unwrap();
    until(|| snapshot(&viewer.inner)["flow"]["stage"] == "failed").await;
}
async fn offer(host: &Node, viewer: &Node) {
    host.window(false, Duration::from_secs(60));
    viewer.window(true, Duration::from_secs(60));
    let instance = "mythra-01020304";
    let mut entry = NearbyEntry::new(1);
    entry.addresses.push(viewer.address);
    host.inner.lock().nearby.insert(instance.into(), entry);
    pairing::start_offer(&host.inner, instance).await.unwrap();
    until(|| {
        snapshot(&host.inner)["pairing"]["request"]["code"].is_string()
            && snapshot(&viewer.inner)["flow"]["stage"] == "offered"
    })
    .await;
}
#[tokio::test]
async fn unsolicited_reverse_offer_requires_local_accept_even_if_host_approves() {
    let host = Node::new(true).await;
    let viewer = Node::new(false).await;
    offer(&host, &viewer).await;
    let host_view = snapshot(&host.inner);
    let viewer_view = snapshot(&viewer.inner);
    assert_eq!(
        host_view["pairing"]["request"]["code"],
        viewer_view["flow"]["code"]
    );
    pairing::respond(
        &host.inner,
        host_view["pairing"]["request"]["id"].as_str().unwrap(),
        true,
        None,
    )
    .await
    .unwrap();
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(
        viewer.inner.lock().devices.is_empty(),
        "host's own approval must not pin its key on viewer"
    );
    assert!(
        host.inner.lock().devices.is_empty(),
        "viewer must not send pair.await before local acceptance"
    );
    assert_eq!(snapshot(&viewer.inner)["flow"]["stage"], "offered");
    let flow_id = viewer_view["flow"]["id"].as_u64().unwrap();
    pairing::respond_offer(&viewer.inner, flow_id, false).unwrap();
    until(|| viewer.inner.lock().flow.is_none()).await;
    assert!(viewer.inner.lock().devices.is_empty());
}
#[tokio::test]
async fn reverse_link_does_not_let_host_read_viewer_data() {
    let host = Node::new(true).await;
    let viewer = Node::new(false).await;
    host.inner.lock().devices.insert(
        viewer.identity.fingerprint.clone(),
        device(&viewer.identity, false, true),
    );
    viewer.inner.lock().devices.insert(
        host.identity.fingerprint.clone(),
        device(&host.identity, true, false),
    );
    let reverse = session::dial(
        &host.inner,
        &host.identity,
        viewer.address,
        ServerKeyPolicy::Pinned(viewer.identity.fingerprint.clone()),
        DialPurpose::Paired,
    )
    .await
    .unwrap();
    assert!(reverse.is_paired());
    let denied = reverse
        .request("host.info", json!({}), WAIT)
        .await
        .unwrap_err();
    assert_eq!(denied.code, "not_paired");
    let viewer_link = viewer
        .inner
        .lock()
        .links
        .values()
        .find(|link| link.role == Role::Viewer && link.is_paired())
        .unwrap()
        .clone();
    assert_eq!(
        viewer_link.request("ping", json!({}), WAIT).await.unwrap()["ok"],
        true
    );
}

#[derive(Debug)]
struct MismatchedSigner {
    advertised: Vec<u8>,
    actual: Arc<dyn rustls::sign::SigningKey>,
}
impl rustls::sign::SigningKey for MismatchedSigner {
    fn choose_scheme(
        &self,
        offered: &[rustls::SignatureScheme],
    ) -> Option<Box<dyn rustls::sign::Signer>> {
        self.actual.choose_scheme(offered)
    }
    fn algorithm(&self) -> rustls::SignatureAlgorithm {
        self.actual.algorithm()
    }
    fn public_key(&self) -> Option<rustls::pki_types::SubjectPublicKeyInfoDer<'_>> {
        Some(self.advertised.as_slice().into())
    }
}
fn mismatched_identity() -> Arc<DeviceIdentity> {
    let claimed = identity();
    let signer = identity();
    let wrong = Arc::new(MismatchedSigner {
        advertised: claimed.spki.clone(),
        actual: signer.certified.key.clone(),
    });
    Arc::new(DeviceIdentity {
        fingerprint: claimed.fingerprint.clone(),
        spki: claimed.spki.clone(),
        certified: Arc::new(CertifiedKey::new(
            vec![CertificateDer::from(claimed.spki.clone())],
            wrong,
        )),
    })
}
#[tokio::test]
async fn every_server_verifier_rejects_a_forged_handshake_signature() {
    for policy in 0..3 {
        let server = mismatched_identity();
        let client = identity();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let acceptor = TlsAcceptor::from(tls::server_config(&server).unwrap());
        let task = tokio::spawn(async move {
            let (tcp, _) = listener.accept().await.unwrap();
            acceptor.accept(tcp).await.is_err()
        });
        let policy = match policy {
            0 => ServerKeyPolicy::Capture,
            1 => ServerKeyPolicy::Pinned(server.fingerprint.clone()),
            _ => ServerKeyPolicy::PairedSet(HashSet::from([server.fingerprint.clone()])),
        };
        let proven: tls::ProvenKey = Default::default();
        let connector =
            TlsConnector::from(tls::client_config(&client, policy, proven.clone()).unwrap());
        let result = connector
            .connect(
                tls::server_name().unwrap(),
                TcpStream::connect(address).await.unwrap(),
            )
            .await;
        assert!(
            result.is_err(),
            "a claimed public key is not proof of its signature"
        );
        assert!(timeout(WAIT, task).await.unwrap().unwrap());
        assert!(
            proven.lock().unwrap().is_none(),
            "forged key must not enter discovery's proven-key set"
        );
    }
}
#[tokio::test]
async fn server_client_verifier_rejects_forged_client_signature() {
    let server = identity();
    let client = mismatched_identity();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let acceptor = TlsAcceptor::from(tls::server_config(&server).unwrap());
    let task = tokio::spawn(async move {
        let (tcp, _) = listener.accept().await.unwrap();
        acceptor.accept(tcp).await.is_err()
    });
    let connector = TlsConnector::from(
        tls::client_config(&client, ServerKeyPolicy::Capture, Default::default()).unwrap(),
    );
    let result = connector
        .connect(
            tls::server_name().unwrap(),
            TcpStream::connect(address).await.unwrap(),
        )
        .await;
    // TLS1.3's client can finish sending its flight before learning the server
    // refused its signature. The server must never admit that connection.
    if let Ok(mut stream) = result {
        assert!(wire::read_frame(&mut stream, PREAUTH_MAX_FRAME, WAIT)
            .await
            .is_err());
    }
    assert!(timeout(WAIT, task).await.unwrap().unwrap());
}

#[test]
fn saving_project_commands_requires_manage_all_and_terminal() {
    let mut grant = DeviceGrant::initial();
    grant.work = true;
    grant.capabilities.terminal = true;
    for op in ["projects.run.set", "projects.check.set"] {
        assert!(
            super::manifest::access(op, &grant).is_err(),
            "{op} bypassed Manage projects"
        );
    }
    grant.capabilities.manage_projects = true;
    for op in ["projects.run.set", "projects.check.set"] {
        assert!(super::manifest::access(op, &grant).is_ok());
    }
    grant.scope = store::GrantScope::Projects {
        project_ids: vec!["shared".into()],
    };
    for op in ["projects.run.set", "projects.check.set"] {
        assert!(super::manifest::access(op, &grant).is_err());
    }
}

// Fake renderer delivery replaces only Tauri's event sink. Protocol handlers,
// subscription barriers, grant checks, writer queues and framed TCP remain real.
type TestEvent = (String, Value);
static EVENTS: OnceLock<StdMutex<HashMap<usize, tokio::sync::mpsc::Sender<TestEvent>>>> =
    OnceLock::new();
pub(super) fn emit(inner: &Inner, name: &str, value: &Value) -> Option<bool> {
    EVENTS
        .get()?
        .lock()
        .unwrap()
        .get(&(inner as *const Inner as usize))
        .map(|sink| sink.try_send((name.into(), value.clone())).is_ok())
}
fn events(inner: &Arc<Inner>) -> tokio::sync::mpsc::Receiver<TestEvent> {
    let (tx, rx) = tokio::sync::mpsc::channel(128);
    EVENTS
        .get_or_init(Default::default)
        .lock()
        .unwrap()
        .insert(Arc::as_ptr(inner) as usize, tx);
    rx
}
struct Renderer {
    task: JoinHandle<()>,
    seq: Arc<AtomicU64>,
    calls: Arc<std::sync::atomic::AtomicUsize>,
    epoch: String,
}
impl Drop for Renderer {
    fn drop(&mut self) {
        self.task.abort();
    }
}
fn renderer(inner: &Arc<Inner>) -> Renderer {
    let mut rx = events(inner);
    hostbridge::test_attach(inner, 1);
    let target = inner.clone();
    let epoch = uuid::Uuid::new_v4().to_string();
    let seq = Arc::new(AtomicU64::new(0));
    let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let (renderer_epoch, renderer_seq, renderer_calls) =
        (epoch.clone(), seq.clone(), calls.clone());
    let task = tokio::spawn(async move {
        while let Some((event, payload)) = rx.recv().await {
            if event != "remote-host-request" {
                continue;
            }
            let op = payload["op"].as_str().unwrap();
            let args = &payload["args"];
            let result = match op {
                "workspaces.list" => {
                    json!({"workspaces":[{"id":"project","name":"Host project","isChat":false}]})
                }
                "timeline.read" => {
                    json!({"messages":[],"activities":[],"history":{"hasMore":false}})
                }
                "timeline.subscribe" => {
                    let mut result =
                        json!({"epoch":renderer_epoch,"seq":renderer_seq.load(Ordering::Acquire)});
                    if args["needSnapshot"] != false {
                        result["snapshot"] = json!({"messages":[],"activities":[],"approvals":[],"queuedTurns":[],"status":"idle","availability":"ready","activeTurnId":null,"workingStartedAt":null,"error":null,"history":{"hasMore":false}});
                    }
                    result
                }
                "prompt.send" => {
                    renderer_calls.fetch_add(1, Ordering::AcqRel);
                    tokio::time::sleep(Duration::from_millis(30)).await;
                    json!({"opId":args["opId"],"state":"accepted","threadId":"once"})
                }
                _ => panic!("unexpected fake renderer operation {op}"),
            };
            hostbridge::renderer_respond(
                &target,
                payload["generation"].as_u64().unwrap(),
                payload["requestId"].as_str().unwrap().into(),
                Some(result),
                None,
            )
            .unwrap();
        }
    });
    Renderer {
        task,
        seq,
        calls,
        epoch,
    }
}
async fn paired_nodes() -> (Node, Node, Arc<Link>) {
    let host = Node::new(true).await;
    let viewer = Node::new(false).await;
    host.inner
        .install_test_database(Connection::open_in_memory().unwrap())
        .unwrap();
    viewer
        .inner
        .install_test_database(Connection::open_in_memory().unwrap())
        .unwrap();
    let mut record = device(&viewer.identity, false, true);
    record.grant.as_mut().unwrap().work = true;
    host.inner
        .lock()
        .devices
        .insert(viewer.identity.fingerprint.clone(), record);
    viewer.inner.lock().devices.insert(
        host.identity.fingerprint.clone(),
        device(&host.identity, true, false),
    );
    let link = session::dial(
        &viewer.inner,
        &viewer.identity,
        host.address,
        ServerKeyPolicy::Pinned(host.identity.fingerprint.clone()),
        DialPurpose::Paired,
    )
    .await
    .unwrap();
    (host, viewer, link)
}
async fn event(rx: &mut tokio::sync::mpsc::Receiver<TestEvent>, expected: &str) -> Value {
    timeout(WAIT, async {
        loop {
            let (name, value) = rx.recv().await.expect("event channel closed");
            if name == expected {
                return value;
            }
        }
    })
    .await
    .expect("renderer event missing")
}
#[tokio::test]
async fn successful_pairing_is_durable_in_both_dial_directions() {
    for reverse in [false, true] {
        let host = Node::new(true).await;
        let viewer = Node::new(false).await;
        let host_db = host
            .inner
            .install_test_database(Connection::open_in_memory().unwrap())
            .unwrap();
        let viewer_db = viewer
            .inner
            .install_test_database(Connection::open_in_memory().unwrap())
            .unwrap();
        if reverse {
            offer(&host, &viewer).await;
            let flow = snapshot(&viewer.inner)["flow"]["id"].as_u64().unwrap();
            pairing::respond_offer(&viewer.inner, flow, true).unwrap();
        } else {
            let invitation = host.window(false, Duration::from_secs(60));
            pairing::start_invitation(&viewer.inner, &invitation)
                .await
                .unwrap();
            until(|| {
                snapshot(&host.inner)["pairing"]["request"]["code"].is_string()
                    && snapshot(&viewer.inner)["flow"]["code"].is_string()
            })
            .await;
        }
        let request = snapshot(&host.inner)["pairing"]["request"].clone();
        assert_eq!(request["code"], snapshot(&viewer.inner)["flow"]["code"]);
        pairing::respond(&host.inner, request["id"].as_str().unwrap(), true, None)
            .await
            .unwrap();
        until(|| snapshot(&viewer.inner)["flow"]["stage"] == "done").await;
        assert!(store::load_devices(&host_db.lock().unwrap()).unwrap()
            [&viewer.identity.fingerprint]
            .grant
            .is_some());
        assert!(
            store::load_devices(&viewer_db.lock().unwrap()).unwrap()[&host.identity.fingerprint]
                .they_host
        );
        let link = viewer
            .inner
            .lock()
            .links
            .values()
            .find(|link| link.is_paired() && link.role == Role::Viewer)
            .unwrap()
            .clone();
        assert_eq!(
            link.request("ping", json!({}), WAIT).await.unwrap()["ok"],
            true
        );
    }
}
#[tokio::test]
async fn real_writer_serializes_delayed_stale_save_then_revoke_and_late_details() {
    let (host, viewer, link) = paired_nodes().await;
    let db = host.inner.test_database.get().unwrap().clone();
    let stale = host.inner.lock().devices[&viewer.identity.fingerprint].clone();
    let (started_tx, started_rx) = std::sync::mpsc::channel();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    let initial = {
        let _core = host.inner.lock();
        let stale = stale.clone();
        host.inner.enqueue_write(false, move |db| {
            started_tx.send(()).unwrap();
            release_rx.recv_timeout(WAIT).unwrap();
            store::save_device(db, &stale)
        })
    };
    started_rx.recv_timeout(WAIT).unwrap();
    let revoked = {
        let mut core = host.inner.lock();
        core.devices
            .get_mut(&viewer.identity.fingerprint)
            .unwrap()
            .grant = None;
        host.inner
            .enqueue_device_state(&core, &viewer.identity.fingerprint)
    };
    {
        let _core = host.inner.lock();
        host.inner.enqueue_details(stale);
    }
    assert!(
        link.request("ping", json!({}), WAIT).await.is_err(),
        "memory revoke must reject before slow DB finishes"
    );
    release_tx.send(()).unwrap();
    finish_write(initial).await.unwrap();
    finish_write(revoked).await.unwrap();
    let saved = host
        .inner
        .read_db(|db| store::load_devices(db).map_err(|e| e.to_string()))
        .await
        .unwrap();
    assert!(saved[&viewer.identity.fingerprint].grant.is_none());
    assert!(
        store::load_devices(&db.lock().unwrap()).unwrap()[&viewer.identity.fingerprint]
            .grant
            .is_none()
    );
}
#[tokio::test]
async fn phase2_fake_renderers_snapshot_live_reconnect_replay_and_revoke() {
    let (host, viewer, link) = paired_nodes().await;
    let fake = renderer(&host.inner);
    let mut received = events(&viewer.inner);
    let device = host.identity.fingerprint.clone();
    let list = hostbridge::viewer_request(
        &viewer.inner,
        device.clone(),
        "workspaces.list".into(),
        json!({}),
    )
    .await
    .unwrap();
    assert_eq!(list["workspaces"][0]["name"], "Host project");
    let initial = hostbridge::viewer_request(
        &viewer.inner,
        device.clone(),
        "timeline.subscribe".into(),
        json!({"threadId":"thread"}),
    )
    .await
    .unwrap();
    assert!(initial["snapshot"].is_object());
    assert_eq!(initial["seq"], 0);
    fake.seq.store(1, Ordering::Release);
    hostbridge::renderer_publish(
        &host.inner,
        1,
        "thread".into(),
        fake.epoch.clone(),
        vec![timeline::PublishedFrame {
            seq: 1,
            frame: json!({"text":"live"}),
        }],
    )
    .unwrap();
    let live = event(&mut received, "remote-viewer-frame").await;
    assert_eq!(live["seq"], 1);
    assert_eq!(live["frame"]["text"], "live");
    link.close(CloseReason::Finished);
    until(|| host.inner.lock().links.is_empty() && viewer.inner.lock().links.is_empty()).await;
    fake.seq.store(2, Ordering::Release);
    hostbridge::renderer_publish(
        &host.inner,
        1,
        "thread".into(),
        fake.epoch.clone(),
        vec![timeline::PublishedFrame {
            seq: 2,
            frame: json!({"text":"missed"}),
        }],
    )
    .unwrap();
    let _reconnected = session::dial(
        &viewer.inner,
        &viewer.identity,
        host.address,
        ServerKeyPolicy::Pinned(device.clone()),
        DialPurpose::Paired,
    )
    .await
    .unwrap();
    let replay = hostbridge::viewer_request(
        &viewer.inner,
        device.clone(),
        "timeline.subscribe".into(),
        json!({"threadId":"thread","epoch":fake.epoch,"afterSeq":1}),
    )
    .await
    .unwrap();
    assert!(replay.get("snapshot").is_none());
    assert_eq!(replay["frames"][0]["seq"], 2);
    assert_eq!(replay["frames"][0]["frame"]["text"], "missed");
    {
        let mut core = host.inner.lock();
        core.devices
            .get_mut(&viewer.identity.fingerprint)
            .unwrap()
            .grant = None;
        hostbridge::retire_device_locked(&host.inner, &mut core, &viewer.identity.fingerprint);
    }
    timeout(WAIT, async {
        loop {
            if event(&mut received, "remote-viewer-state").await["state"] == "removed" {
                break;
            }
        }
    })
    .await
    .unwrap();
    hostbridge::renderer_publish(
        &host.inner,
        1,
        "thread".into(),
        fake.epoch.clone(),
        vec![timeline::PublishedFrame {
            seq: 3,
            frame: json!({"text":"must not arrive"}),
        }],
    )
    .unwrap();
    assert!(hostbridge::viewer_request(
        &viewer.inner,
        device,
        "timeline.read".into(),
        json!({"threadId":"thread"})
    )
    .await
    .is_err());
    assert!(timeout(
        Duration::from_millis(40),
        event(&mut received, "remote-viewer-frame")
    )
    .await
    .is_err());
}
#[tokio::test]
async fn duplicate_mutation_opid_dispatches_once_and_replays_after_completion() {
    let (host, viewer, link) = paired_nodes().await;
    let fake = renderer(&host.inner);
    let args = json!({"opId":"exactly-once","opSeq":1,"workspaceId":"project","text":"do once"});
    let (a, b) = tokio::join!(
        link.request("prompt.send", args.clone(), WAIT),
        link.request("prompt.send", args.clone(), WAIT)
    );
    assert_eq!(a.as_ref().unwrap()["state"], "accepted");
    assert_eq!(a.unwrap(), b.unwrap());
    assert_eq!(
        link.request("prompt.send", args, WAIT).await.unwrap()["state"],
        "accepted"
    );
    assert_eq!(fake.calls.load(Ordering::Acquire), 1);
    let _ = viewer; // own the viewer until every response is checked
}

async fn preview_backend(
    body: &'static str,
) -> (
    SocketAddr,
    tokio::sync::oneshot::Receiver<String>,
    JoinHandle<()>,
) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (sent, received) = oneshot::channel();
    let task = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let mut header = Vec::new();
        loop {
            let byte = stream.read_u8().await.unwrap();
            header.push(byte);
            if header.ends_with(b"\r\n\r\n") {
                break;
            }
            assert!(header.len() < 32768);
        }
        sent.send(String::from_utf8(header).unwrap()).unwrap();
        stream.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: {}\r\nSet-Cookie: upstream=secret\r\nConnection: close\r\n\r\n{body}",body.len()).as_bytes()).await.unwrap();
    });
    (address, received, task)
}
// Pin test DNS explicitly. This exercises a real TCP listener and exact
// browser Host/Origin checks, NOT the OS/browser's *.localhost resolver.
fn browser_client(url: &str) -> reqwest::Client {
    let url = reqwest::Url::parse(url).unwrap();
    super::preview::http_client_builder()
        .unwrap()
        .resolve(
            url.host_str().unwrap(),
            SocketAddr::new(std::net::Ipv4Addr::LOCALHOST.into(), url.port().unwrap()),
        )
        .timeout(WAIT)
        .build()
        .unwrap()
}
async fn preview_cookie(url: &str) -> String {
    let response = browser_client(url).get(url).send().await.unwrap();
    assert_eq!(response.status(), 303);
    let cookie = response
        .headers()
        .get("set-cookie")
        .unwrap()
        .to_str()
        .unwrap()
        .to_owned();
    assert!(cookie.contains("HttpOnly"));
    assert!(cookie.contains("SameSite=Strict"));
    cookie.split(';').next().unwrap().into()
}
#[tokio::test]
async fn preview_real_http_tunnel_rewrites_host_and_does_not_forward_browser_credentials() {
    let (host, viewer, _link) = paired_nodes().await;
    let _renderer = renderer(&host.inner);
    let (address, received, backend) = preview_backend("host preview").await;
    let endpoint = super::preview::register(&host.inner, 1, "project".into(), address).unwrap();
    let opened = super::preview::open_browser(&viewer.inner, &host.identity.fingerprint, &endpoint)
        .await
        .unwrap();
    let url = opened["url"].as_str().unwrap();
    let parsed = reqwest::Url::parse(url).unwrap();
    let root = format!("{}/", parsed.origin().ascii_serialization());
    assert!(parsed.host_str().unwrap().starts_with("p-"));
    assert!(parsed.host_str().unwrap().ends_with(".localhost"));
    assert_ne!(parsed.port().unwrap(), address.port());
    assert_eq!(
        browser_client(&root)
            .get(&root)
            .send()
            .await
            .unwrap()
            .status(),
        403
    );
    let cookie = preview_cookie(url).await;
    let response = browser_client(&root)
        .get(&root)
        .header("cookie", format!("{cookie}; provider_key=must-not-cross"))
        .header("authorization", "Bearer must-not-cross")
        .header("sec-fetch-site", "same-origin")
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    assert_eq!(response.headers()["cache-control"], "no-store");
    assert!(response
        .headers()
        .get_all("set-cookie")
        .iter()
        .any(|value| value.to_str().unwrap().starts_with("upstream=secret")));
    assert_eq!(response.text().await.unwrap(), "host preview");
    let request = received.await.unwrap().to_lowercase();
    assert!(request.contains(&format!("host: {address}")));
    assert!(!request.contains("must-not-cross"));
    assert!(!request.contains("cookie:"));
    assert!(!request.contains("authorization:"));
    backend.await.unwrap();
    super::preview::retire(&host.inner, Some(&viewer.identity.fingerprint));
    let local = SocketAddr::new(std::net::Ipv4Addr::LOCALHOST.into(), parsed.port().unwrap());
    timeout(WAIT, async {
        loop {
            if TcpStream::connect(local).await.is_err() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("revocation must close browser listener");
}
#[tokio::test]
async fn preview_refuses_nonloopback_view_only_and_cross_origin_cookie_requests() {
    let (host, viewer, link) = paired_nodes().await;
    let _renderer = renderer(&host.inner);
    for address in [
        "192.168.1.2:3000",
        "0.0.0.0:3000",
        "[::ffff:192.168.1.2]:3000",
        "127.0.0.1:0",
    ] {
        assert!(super::preview::register(
            &host.inner,
            1,
            "project".into(),
            address.parse().unwrap()
        )
        .is_err());
    }
    let endpoint = super::preview::register(
        &host.inner,
        1,
        "project".into(),
        "127.0.0.1:9".parse().unwrap(),
    )
    .unwrap();
    host.inner
        .lock()
        .devices
        .get_mut(&viewer.identity.fingerprint)
        .unwrap()
        .grant
        .as_mut()
        .unwrap()
        .work = false;
    assert_eq!(
        link.request("preview.open", json!({"endpointId":endpoint}), WAIT)
            .await
            .unwrap_err()
            .code,
        "forbidden"
    );
    host.inner
        .lock()
        .devices
        .get_mut(&viewer.identity.fingerprint)
        .unwrap()
        .grant
        .as_mut()
        .unwrap()
        .work = true;
    let opened = super::preview::open_browser(&viewer.inner, &host.identity.fingerprint, &endpoint)
        .await
        .unwrap();
    let url = opened["url"].as_str().unwrap();
    let parsed = reqwest::Url::parse(url).unwrap();
    let root = format!("{}/", parsed.origin().ascii_serialization());
    let cookie = preview_cookie(url).await;
    let response = browser_client(&root)
        .get(root)
        .header("cookie", cookie)
        .header("origin", "https://attacker.invalid")
        .header("sec-fetch-site", "cross-site")
        .send()
        .await
        .unwrap();
    assert_eq!(response.status(), 403);
    link.close(CloseReason::Finished);
    let local = SocketAddr::new(std::net::Ipv4Addr::LOCALHOST.into(), parsed.port().unwrap());
    timeout(WAIT, async {
        loop {
            if TcpStream::connect(local).await.is_err() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
}

#[tokio::test]
async fn preview_scope_revision_and_session_caps_are_native_and_fail_closed() {
    let (host, viewer, link) = paired_nodes().await;
    let _renderer = renderer(&host.inner);
    let endpoint = super::preview::register(
        &host.inner,
        1,
        "project".into(),
        "127.0.0.1:9".parse().unwrap(),
    )
    .unwrap();
    let listed = link
        .request("preview.list", json!({"workspaceId":"project"}), WAIT)
        .await
        .unwrap();
    assert_eq!(listed["previews"][0]["endpointId"], endpoint);
    assert!(!listed.to_string().contains("127.0.0.1"));
    assert!(!listed.to_string().contains("address"));
    host.inner
        .lock()
        .devices
        .get_mut(&viewer.identity.fingerprint)
        .unwrap()
        .grant
        .as_mut()
        .unwrap()
        .scope = store::GrantScope::Projects {
        project_ids: vec!["other".into()],
    };
    assert_eq!(
        link.request("preview.list", json!({"workspaceId":"project"}), WAIT)
            .await
            .unwrap_err()
            .code,
        "forbidden"
    );
    assert_eq!(
        link.request("preview.open", json!({"endpointId":endpoint}), WAIT)
            .await
            .unwrap_err()
            .code,
        "forbidden"
    );
    host.inner
        .lock()
        .devices
        .get_mut(&viewer.identity.fingerprint)
        .unwrap()
        .grant
        .as_mut()
        .unwrap()
        .scope = store::GrantScope::All;
    let first = link
        .request("preview.open", json!({"endpointId":endpoint}), WAIT)
        .await
        .unwrap();
    link.request("preview.open", json!({"endpointId":endpoint}), WAIT)
        .await
        .unwrap();
    assert_eq!(
        link.request("preview.open", json!({"endpointId":endpoint}), WAIT)
            .await
            .unwrap_err()
            .code,
        "busy"
    );
    assert!(link
        .request(
            "preview.ready",
            json!({"sessionId":first["sessionId"]}),
            WAIT
        )
        .await
        .is_ok());
    // Each malformed request must fail before touching the registered port.
    for (method, path, headers, body) in [
        ("CONNECT", "/", json!([]), String::new()),
        ("GET", "http://attacker.invalid/", json!([]), String::new()),
        ("GET", "//attacker.invalid/", json!([]), String::new()),
        ("GET", "/\\attacker.invalid/", json!([]), String::new()),
        (
            "GET",
            "/",
            json!([["host", "attacker.invalid"]]),
            String::new(),
        ),
        (
            "GET",
            "/",
            json!([["accept", "ok\r\ninjected: true"]]),
            String::new(),
        ),
        ("POST", "/", json!([]), "A".repeat(1_398_105)),
    ] {
        assert_eq!(link.request("preview.http",json!({"sessionId":first["sessionId"],"method":method,"path":path,"headers":headers,"body":body}),WAIT).await.unwrap_err().code,"invalid");
    }
    host.inner
        .lock()
        .devices
        .get_mut(&viewer.identity.fingerprint)
        .unwrap()
        .grant
        .as_mut()
        .unwrap()
        .revision += 1;
    assert_eq!(
        link.request(
            "preview.ready",
            json!({"sessionId":first["sessionId"]}),
            WAIT
        )
        .await
        .unwrap_err()
        .code,
        "forbidden"
    );
    assert_eq!(link.request("preview.http",json!({"sessionId":first["sessionId"],"method":"GET","path":"/","headers":[],"body":""}),WAIT).await.unwrap_err().code,"forbidden");
}

#[tokio::test]
async fn preview_browser_parser_rejects_bad_host_framing_and_reused_bootstrap() {
    let (host, viewer, _link) = paired_nodes().await;
    let _renderer = renderer(&host.inner);
    let endpoint = super::preview::register(
        &host.inner,
        1,
        "project".into(),
        "127.0.0.1:9".parse().unwrap(),
    )
    .unwrap();
    let opened = super::preview::open_browser(&viewer.inner, &host.identity.fingerprint, &endpoint)
        .await
        .unwrap();
    let url = opened["url"].as_str().unwrap();
    let parsed = reqwest::Url::parse(url).unwrap();
    let root = format!("{}/", parsed.origin().ascii_serialization());
    let cookie = preview_cookie(url).await;
    assert_eq!(
        browser_client(url).get(url).send().await.unwrap().status(),
        403
    );
    assert_eq!(
        browser_client(&root)
            .get(&root)
            .header("host", "attacker.invalid")
            .header("cookie", &cookie)
            .header("sec-fetch-site", "same-origin")
            .send()
            .await
            .unwrap()
            .status(),
        403
    );
    let local = SocketAddr::new(std::net::Ipv4Addr::LOCALHOST.into(), parsed.port().unwrap());
    let authority = format!("{}:{}", parsed.host_str().unwrap(), parsed.port().unwrap());
    for framing in [
        "Content-Length: 1048577\r\n".to_owned(),
        "Content-Length: 0\r\nContent-Length: 0\r\n".into(),
        "Transfer-Encoding: chunked\r\n".into(),
        "Upgrade: websocket\r\n".into(),
        format!("X-Oversized: {}\r\n", "x".repeat(16 * 1024)),
    ] {
        let mut socket = TcpStream::connect(local).await.unwrap();
        socket.write_all(format!("POST / HTTP/1.1\r\nHost: {authority}\r\nCookie: {cookie}\r\nSec-Fetch-Site: same-origin\r\n{framing}\r\n").as_bytes()).await.unwrap();
        let mut response = Vec::new();
        timeout(WAIT, socket.read_to_end(&mut response))
            .await
            .unwrap()
            .unwrap();
        assert!(response.starts_with(b"HTTP/1.1 403"));
    }
}

#[tokio::test]
async fn preview_sse_arrives_before_eof_and_cookies_stay_in_their_preview() {
    let (host, viewer, _link) = paired_nodes().await;
    let _renderer = renderer(&host.inner);
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (release, hold) = oneshot::channel::<()>();
    let (seen, request) = oneshot::channel();
    let backend = tokio::spawn(async move {
        let (mut login, _) = listener.accept().await.unwrap();
        let mut header = Vec::new();
        while !header.ends_with(b"\r\n\r\n") {
            header.push(login.read_u8().await.unwrap());
        }
        login.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nSet-Cookie: sid=only-this-session; Domain=localhost; Path=/; HttpOnly; SameSite=Lax\r\nConnection: close\r\n\r\nok").await.unwrap();
        drop(login);
        let (mut events, _) = listener.accept().await.unwrap();
        let mut header = Vec::new();
        while !header.ends_with(b"\r\n\r\n") {
            header.push(events.read_u8().await.unwrap());
        }
        seen.send(String::from_utf8(header).unwrap()).unwrap();
        events.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\nb\r\ndata: one\n\n\r\n").await.unwrap();
        hold.await.unwrap();
        events.write_all(b"0\r\n\r\n").await.unwrap();
    });
    let endpoint = super::preview::register(&host.inner, 1, "project".into(), address).unwrap();
    let opened = super::preview::open_browser(&viewer.inner, &host.identity.fingerprint, &endpoint)
        .await
        .unwrap();
    let url = opened["url"].as_str().unwrap();
    let parsed = reqwest::Url::parse(url).unwrap();
    let root = format!("{}/", parsed.origin().ascii_serialization());
    let gate = preview_cookie(url).await;
    let login = browser_client(&root)
        .get(&root)
        .header("cookie", &gate)
        .header("sec-fetch-site", "same-origin")
        .send()
        .await
        .unwrap();
    assert_eq!(login.status(), 200);
    let app = login
        .headers()
        .get_all("set-cookie")
        .iter()
        .map(|v| v.to_str().unwrap())
        .find(|v| v.starts_with("sid="))
        .unwrap();
    assert!(!app.to_lowercase().contains("domain="));
    assert!(app.contains("HttpOnly"));
    assert!(app.contains("SameSite=Strict"));
    let app = app.split(';').next().unwrap().to_owned();
    assert_eq!(login.text().await.unwrap(), "ok");
    let mut events = browser_client(&root)
        .get(format!("{root}events"))
        .header(
            "cookie",
            format!("{gate}; {app}; provider_key=never-forward"),
        )
        .header("sec-fetch-site", "same-origin")
        .send()
        .await
        .unwrap();
    assert_eq!(events.status(), 200);
    let first = timeout(WAIT, events.chunk())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(&first[..], b"data: one\n\n");
    let header = request.await.unwrap();
    assert!(header.contains("sid=only-this-session"));
    assert!(!header.contains("never-forward"));
    assert!(!header.contains("mythra_preview_"));
    // The backend has NOT sent EOF yet: receiving the event proves streaming.
    release.send(()).unwrap();
    assert!(timeout(WAIT, events.chunk())
        .await
        .unwrap()
        .unwrap()
        .is_none());
    backend.await.unwrap();
}

#[tokio::test]
async fn preview_websocket_echo_subprotocol_and_host_rewrite_use_real_sockets() {
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::{self, client::IntoClientRequest, Message};
    let (host, viewer, _link) = paired_nodes().await;
    let _renderer = renderer(&host.inner);
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let backend = tokio::spawn(async move {
        let (tcp, _) = listener.accept().await.unwrap();
        let mut ws = tokio_tungstenite::accept_hdr_async(
            tcp,
            move |request: &tungstenite::handshake::server::Request,
                  mut response: tungstenite::handshake::server::Response| {
                assert_eq!(request.headers()["host"], address.to_string());
                assert_eq!(request.headers()["origin"], format!("http://{address}"));
                assert_eq!(request.headers()["sec-websocket-protocol"], "vite-hmr");
                response
                    .headers_mut()
                    .insert("sec-websocket-protocol", "vite-hmr".parse().unwrap());
                Ok(response)
            },
        )
        .await
        .unwrap();
        ws.send(Message::Text("initial reload state".into()))
            .await
            .unwrap();
        for _ in 0..2 {
            let message = ws.next().await.unwrap().unwrap();
            ws.send(message).await.unwrap();
        }
        let _ = ws
            .close(Some(tungstenite::protocol::CloseFrame {
                code: tungstenite::protocol::frame::coding::CloseCode::Restart,
                reason: "hmr-restart".into(),
            }))
            .await;
    });
    let endpoint = super::preview::register(&host.inner, 1, "project".into(), address).unwrap();
    let opened = super::preview::open_browser(&viewer.inner, &host.identity.fingerprint, &endpoint)
        .await
        .unwrap();
    let url = opened["url"].as_str().unwrap();
    let parsed = reqwest::Url::parse(url).unwrap();
    let cookie = preview_cookie(url).await;
    let origin = parsed.origin().ascii_serialization();
    let websocket = format!(
        "ws://{}:{}/hmr",
        parsed.host_str().unwrap(),
        parsed.port().unwrap()
    );
    let mut request = websocket.into_client_request().unwrap();
    request
        .headers_mut()
        .insert("origin", origin.parse().unwrap());
    request
        .headers_mut()
        .insert("cookie", cookie.parse().unwrap());
    request
        .headers_mut()
        .insert("sec-websocket-protocol", "vite-hmr".parse().unwrap());
    let tcp = TcpStream::connect((std::net::Ipv4Addr::LOCALHOST, parsed.port().unwrap()))
        .await
        .unwrap();
    let mut bad = request.clone();
    bad.headers_mut()
        .insert("origin", "https://attacker.invalid".parse().unwrap());
    let bad_tcp = TcpStream::connect((std::net::Ipv4Addr::LOCALHOST, parsed.port().unwrap()))
        .await
        .unwrap();
    assert!(
        matches!(tokio_tungstenite::client_async(bad,bad_tcp).await,Err(tungstenite::Error::Http(response))if response.status()==403)
    );
    let (mut ws, response) = tokio_tungstenite::client_async(request, tcp).await.unwrap();
    assert_eq!(response.headers()["sec-websocket-protocol"], "vite-hmr");
    assert_eq!(
        timeout(WAIT, ws.next()).await.unwrap().unwrap().unwrap(),
        Message::Text("initial reload state".into())
    );
    for message in [
        Message::Text("reload me".into()),
        Message::Binary(vec![1, 2, 3].into()),
    ] {
        ws.send(message.clone()).await.unwrap();
        assert_eq!(
            timeout(WAIT, ws.next()).await.unwrap().unwrap().unwrap(),
            message
        );
    }
    assert!(
        matches!(timeout(WAIT,ws.next()).await.unwrap().unwrap().unwrap(),Message::Close(Some(frame))if u16::from(frame.code)==1012&&frame.reason=="hmr-restart")
    );
    backend.await.unwrap();
}

#[test]
fn preview_cookie_rewriting_is_host_only_ephemeral_and_cannot_replace_gateway() {
    let (name, value) = super::preview::rewrite_cookie(
        "sid=abc; Domain=.localhost; Path=/api; HttpOnly; Secure; SameSite=None; Max-Age=999999",
    )
    .unwrap();
    assert_eq!(name, "sid");
    assert!(value.contains("Path=/api"));
    assert!(value.contains("HttpOnly"));
    assert!(value.contains("Secure"));
    assert!(value.contains("SameSite=Strict"));
    assert!(!value.contains("Domain="));
    assert!(value.contains("Max-Age=86400"));
    assert!(!value.contains("Expires="));
    assert!(super::preview::rewrite_cookie("sid=; Path=/; Max-Age=0")
        .unwrap()
        .1
        .contains("Max-Age=0"));
    for bad in [
        "mythra_preview_bearer=stolen",
        "sid=abc\r\nLocation: https://attacker.invalid",
        "sid=abc; Path=//attacker.invalid",
    ] {
        assert!(super::preview::rewrite_cookie(bad).is_err());
    }
}

#[tokio::test]
async fn preview_revocation_cuts_an_active_sse_response_and_its_listener() {
    let (host, viewer, _link) = paired_nodes().await;
    let _renderer = renderer(&host.inner);
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let backend = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut header = Vec::new();
        while !header.ends_with(b"\r\n\r\n") {
            header.push(socket.read_u8().await.unwrap());
        }
        socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\nb\r\ndata: one\n\n\r\n").await.unwrap();
        let mut byte = [0];
        let _ = timeout(WAIT, socket.read(&mut byte)).await;
    });
    let endpoint = super::preview::register(&host.inner, 1, "project".into(), address).unwrap();
    let opened = super::preview::open_browser(&viewer.inner, &host.identity.fingerprint, &endpoint)
        .await
        .unwrap();
    let url = opened["url"].as_str().unwrap();
    let parsed = reqwest::Url::parse(url).unwrap();
    let root = format!("{}/", parsed.origin().ascii_serialization());
    let cookie = preview_cookie(url).await;
    let mut events = browser_client(&root)
        .get(&root)
        .header("cookie", cookie)
        .header("sec-fetch-site", "same-origin")
        .send()
        .await
        .unwrap();
    assert_eq!(events.status(), 200);
    assert!(timeout(WAIT, events.chunk())
        .await
        .unwrap()
        .unwrap()
        .is_some());
    {
        let mut core = host.inner.lock();
        core.devices
            .get_mut(&viewer.identity.fingerprint)
            .unwrap()
            .grant = None;
        hostbridge::retire_device_locked(&host.inner, &mut core, &viewer.identity.fingerprint);
    }
    assert!(!matches!(
        timeout(WAIT, events.chunk())
            .await
            .expect("revocation must cut the stream"),
        Ok(Some(_))
    ));
    let local = SocketAddr::new(std::net::Ipv4Addr::LOCALHOST.into(), parsed.port().unwrap());
    timeout(WAIT, async {
        loop {
            if TcpStream::connect(local).await.is_err() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .unwrap();
    backend.await.unwrap();
}

#[tokio::test]
async fn preview_deep_path_preserves_path_and_query_but_refuses_url_or_fragment() {
    let (host, viewer, _link) = paired_nodes().await;
    let _renderer = renderer(&host.inner);
    let (address, received, backend) = preview_backend("deep preview").await;
    let endpoint = super::preview::register(&host.inner, 1, "project".into(), address).unwrap();
    for path in [
        "https://attacker.invalid/",
        "//attacker.invalid/",
        "/\\attacker.invalid/",
        "/nested#fragment",
        "/bad\r\nheader",
        "?query-only",
    ] {
        assert_eq!(
            super::preview::open_browser_at(
                &viewer.inner,
                &host.identity.fingerprint,
                &endpoint,
                path
            )
            .await
            .unwrap_err()
            .code,
            "invalid"
        );
    }
    let path = "/nested/page?reload=1&name=two%20words";
    let opened =
        super::preview::open_browser_at(&viewer.inner, &host.identity.fingerprint, &endpoint, path)
            .await
            .unwrap();
    let url = opened["url"].as_str().unwrap();
    let parsed = reqwest::Url::parse(url).unwrap();
    let bootstrap = browser_client(url).get(url).send().await.unwrap();
    assert_eq!(bootstrap.status(), 303);
    assert_eq!(bootstrap.headers()["location"], path);
    let cookie = bootstrap.headers()["set-cookie"]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_owned();
    let target = format!("{}{path}", parsed.origin().ascii_serialization());
    let result = browser_client(&target)
        .get(&target)
        .header("cookie", cookie)
        .header("sec-fetch-site", "same-origin")
        .send()
        .await
        .unwrap();
    assert_eq!(result.status(), 200);
    assert_eq!(result.text().await.unwrap(), "deep preview");
    assert!(received
        .await
        .unwrap()
        .starts_with(&format!("GET {path} HTTP/1.1\r\n")));
    backend.await.unwrap();
}


/// Reproduce a late Ping/Pong failing after a peer has flushed its final
/// refusal. Read gating makes the scheduling race deterministic over real TCP.
#[tokio::test]
async fn failed_reverse_write_does_not_discard_the_peers_flushed_refusal() {
    use std::{
        pin::Pin,
        sync::atomic::{AtomicBool, Ordering},
        task::{Context, Poll},
    };
    use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
    struct Gated {
        stream: TcpStream,
        gate: Option<tokio::sync::oneshot::Receiver<()>>,
        fail: Arc<AtomicBool>,
    }
    impl AsyncRead for Gated {
        fn poll_read(
            mut self: Pin<&mut Self>,
            cx: &mut Context<'_>,
            buf: &mut ReadBuf<'_>,
        ) -> Poll<std::io::Result<()>> {
            if let Some(gate) = self.gate.as_mut() {
                if std::future::Future::poll(Pin::new(gate), cx).is_pending() {
                    return Poll::Pending;
                }
                self.gate = None;
            }
            Pin::new(&mut self.stream).poll_read(cx, buf)
        }
    }
    impl AsyncWrite for Gated {
        fn poll_write(
            mut self: Pin<&mut Self>,
            cx: &mut Context<'_>,
            buf: &[u8],
        ) -> Poll<std::io::Result<usize>> {
            if self.fail.load(Ordering::Acquire) {
                return Poll::Ready(Err(std::io::ErrorKind::BrokenPipe.into()));
            }
            Pin::new(&mut self.stream).poll_write(cx, buf)
        }
        fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
            Pin::new(&mut self.stream).poll_flush(cx)
        }
        fn poll_shutdown(
            mut self: Pin<&mut Self>,
            cx: &mut Context<'_>,
        ) -> Poll<std::io::Result<()>> {
            Pin::new(&mut self.stream).poll_shutdown(cx)
        }
    }
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (stream, accepted) = tokio::join!(TcpStream::connect(address), listener.accept());
    let stream = stream.unwrap();
    let (mut peer, _) = accepted.unwrap();
    let inner = RemoteState::default().inner;
    inner.lock().loaded = true;
    let fail = Arc::new(AtomicBool::new(false));
    let (release, gate) = tokio::sync::oneshot::channel();
    let link = session::test_start_link(
        &inner,
        Gated {
            stream,
            gate: Some(gate),
            fail: fail.clone(),
        },
        session::LinkSetup {
            peer_spki: vec![7; 32],
            peer_addr: address,
            role: Role::Viewer,
            dialed: true,
            paired: false,
            exporter: [0; 32],
            peer_name: None,
            peer_version: "test".into(),
            unauth: None,
            relationship: 0,
            listener: None,
        },
    );
    let asker = link.clone();
    let mut request =
        tokio::spawn(async move { asker.request("pair.request", json!({}), WAIT).await });
    let id = loop {
        let bytes = wire::read_frame(&mut peer, PREAUTH_MAX_FRAME, WAIT)
            .await
            .unwrap();
        if let wire::Decoded::Frame(Frame::Req { id, .. }) = wire::decode(&bytes).unwrap() {
            break id;
        }
    };
    peer.write_all(
        &wire::encode(&Frame::Res {
            id,
            ok: false,
            result: None,
            error: Some(wire::WireError::new("forbidden", "Test refusal.")),
        })
        .unwrap(),
    )
    .await
    .unwrap();
    peer.flush().await.unwrap();
    fail.store(true, Ordering::Release);
    assert!(link.send(&Frame::Ping { t: 0 }));
    until(|| link.test_trace().contains(&"writer_error")).await;
    // The reader cannot receive the flushed response yet. A write failure must
    // NOT destroy pending requests while those bytes are waiting to be read.
    let premature = timeout(Duration::from_millis(20), &mut request).await;
    let _ = release.send(());
    let outcome = match premature {
        Ok(done) => done.unwrap(),
        Err(_) => request.await.unwrap(),
    };
    let trace = link.test_trace();
    link.close(CloseReason::Finished);
    assert_eq!(outcome.unwrap_err().code, "forbidden", "{trace:?}");
}
