//! Real loopback TCP, production TLS/protocol handlers, SQLite and ring code.
//! No desktop App, keychain, DNS-SD, LAN sockets or external services.
use super::*;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use ring::{rand::SystemRandom, signature::Ed25519KeyPair};
use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};
use rustls::sign::CertifiedKey;
use sha2::{Digest, Sha256};
use tokio::{io::AsyncWriteExt, net::TcpStream, task::JoinHandle};
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
    for _ in 0..5 {
        let link = viewer.connect(&host, Role::Viewer).await;
        let error = link
            .request(
                "pair.request",
                json!({"commit":commitment(&link,b"invitation",&[17;32]),"token":"wrong"}),
                WAIT,
            )
            .await
            .unwrap_err();
        assert_eq!(error.code, "forbidden");
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
