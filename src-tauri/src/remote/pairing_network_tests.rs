use super::*;
use crate::remote::{network_access, outgoing_privacy_hint, NearbyEntry, RemoteState};

#[tokio::test]
async fn all_failed_dials_end_flow_and_allow_an_immediate_new_attempt() {
    let inner = RemoteState::default().inner;
    let id = begin_flow(&inner, "PC".into()).unwrap();
    let result = viewer_dial_with_limit(
        &inner,
        id,
        "PC",
        Duration::from_secs(1),
        async { Err(DialError::Unreachable) },
        None,
    )
    .await;
    assert_eq!(result.err(), Some(DialError::Unreachable));
    {
        let core = inner.lock();
        let flow = core.flow.as_ref().unwrap();
        assert!(flow.stage == FlowStage::Failed);
        assert!(!flow.is_active());
        assert!(flow.error.as_ref().unwrap().contains("couldn't connect"));
    }
    assert!(begin_flow(&inner, "Retry PC".into()).is_ok());
}
#[tokio::test]
async fn stalled_and_aborted_dial_futures_cannot_leave_connecting_active() {
    let inner = RemoteState::default().inner;
    let id = begin_flow(&inner, "PC".into()).unwrap();
    let result = viewer_dial_with_limit(
        &inner,
        id,
        "PC",
        Duration::from_millis(5),
        std::future::pending(),
        None,
    )
    .await;
    assert!(result.is_err());
    assert!(!inner.lock().flow.as_ref().unwrap().is_active());
    let next = begin_flow(&inner, "Again".into()).unwrap();
    let task_inner = inner.clone();
    let (ready, waiting) = oneshot::channel();
    let task = tokio::spawn(async move {
        viewer_dial_with_limit(
            &task_inner,
            next,
            "PC",
            Duration::from_secs(60),
            async move {
                let _ = ready.send(());
                std::future::pending().await
            },
            None,
        )
        .await
    });
    waiting.await.unwrap();
    task.abort();
    assert!(matches!(task.await,Err(error) if error.is_cancelled()));
    assert!(!inner.lock().flow.as_ref().unwrap().is_active());
    assert!(begin_flow(&inner, "Retry".into()).is_ok());
}
#[test]
fn stale_connecting_slot_is_recoverable_and_late_failure_never_changes_new_flow() {
    let inner = RemoteState::default().inner;
    let old = begin_flow(&inner, "Old".into()).unwrap();
    inner.lock().flow.as_mut().unwrap().connect_started =
        Instant::now() - VIEWER_DIAL_LIMIT - Duration::from_secs(1);
    let new = begin_flow(&inner, "New".into()).unwrap();
    fail_flow(&inner, old, "Old failure".into());
    assert_eq!(inner.lock().flow.as_ref().unwrap().id, new);
    assert!(inner.lock().flow.as_ref().unwrap().is_active());
}
#[test]
fn privacy_hint_requires_macos_fresh_resolved_lan_endpoint_and_route_error() {
    let mut core = Core::default();
    let address: SocketAddr = "192.168.1.40:4321".parse().unwrap();
    let error = std::io::Error::from(std::io::ErrorKind::HostUnreachable);
    assert!(!outgoing_privacy_hint(&core, address, &error, true));
    let mut entry = NearbyEntry::new(1);
    entry.addresses = vec![address];
    entry.resolved_at = Some(Instant::now());
    core.nearby.insert("mythra-pc".into(), entry);
    assert!(outgoing_privacy_hint(&core, address, &error, true));
    assert!(outgoing_privacy_hint(
        &core,
        address,
        &std::io::Error::from(std::io::ErrorKind::NetworkUnreachable),
        true
    ));
    assert!(!outgoing_privacy_hint(&core, address, &error, false));
    assert!(!outgoing_privacy_hint(
        &core,
        address,
        &std::io::Error::from(std::io::ErrorKind::ConnectionRefused),
        true
    ));
    assert!(!outgoing_privacy_hint(
        &core,
        "192.168.1.40:9999".parse().unwrap(),
        &error,
        true
    ));
    core.nearby.get_mut("mythra-pc").unwrap().resolved_at =
        Some(Instant::now() - Duration::from_secs(121));
    assert!(!outgoing_privacy_hint(&core, address, &error, true));
}
#[test]
fn bonjour_success_and_inbound_host_link_do_not_clear_outgoing_privacy_hint() {
    let inner = RemoteState::default().inner;
    {
        let mut core = inner.lock();
        core.outgoing_denied_since = Some(Instant::now());
        core.denied_since = Some(Instant::now());
    }
    inner.on_discovery(
        crate::remote::DiscoveryEvent::Found("mythra-pc".into()),
        false,
        0,
    );
    crate::remote::clear_stale_denial(&inner);
    assert_eq!(network_access(&inner.lock()), "blocked");
    assert!(
        explain_dial(&inner, &DialError::LocalNetworkMayBeBlocked, "PC")
            .contains("may be blocking")
    );
    assert!(
        explain_dial(&inner, &DialError::LocalNetworkMayBeBlocked, "PC")
            .contains("Privacy & Security → Local Network")
    );
    inner.note_tcp_connected();
    assert_eq!(network_access(&inner.lock()), "ok");
}
#[tokio::test]
async fn actual_invitation_without_identity_fails_instead_of_sticking_connecting() {
    let inner = RemoteState::default().inner;
    let text = encode_invitation(&Invitation {
        fp: "a".repeat(64),
        addrs: vec!["192.168.1.40".parse().unwrap()],
        port: 4321,
        token: URL_SAFE_NO_PAD.encode([1u8; 16]),
        exp: crate::unix_timestamp_ms() + 60_000,
    })
    .unwrap();
    start_invitation(&inner, &text).await.unwrap();
    tokio::time::timeout(Duration::from_secs(1), async {
        loop {
            if inner
                .lock()
                .flow
                .as_ref()
                .is_some_and(|flow| !flow.is_active())
            {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert!(inner.lock().flow.as_ref().unwrap().stage == FlowStage::Failed);
    assert!(begin_flow(&inner, "Retry".into()).is_ok());
}

#[tokio::test]
async fn real_closed_link_finishes_the_actual_invitation_flow() {
    use ring::{rand::SystemRandom, signature::Ed25519KeyPair};
    use rustls::{
        pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer},
        sign::CertifiedKey,
    };
    let pkcs8 = Ed25519KeyPair::generate_pkcs8(&SystemRandom::new()).unwrap();
    let key = rustls::crypto::ring::default_provider()
        .key_provider
        .load_private_key(PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(
            pkcs8.as_ref().to_vec(),
        )))
        .unwrap();
    let spki = key.public_key().unwrap().as_ref().to_vec();
    let identity = Arc::new(crate::remote::identity::DeviceIdentity {
        fingerprint: crate::remote::identity::fingerprint_of(&spki),
        spki: spki.clone(),
        certified: Arc::new(CertifiedKey::new(vec![CertificateDer::from(spki)], key)),
    });
    let inner = RemoteState::default().inner;
    assert!(inner.identity.set(identity).is_ok());
    // A real peer accepts then closes before TLS. Keep its listener owned so
    // parallel tests cannot steal a closed ephemeral port. A merely bound but
    // non-listening socket can silently drop SYNs on macOS rather than refuse.
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let peer = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        drop(stream);
    });
    let text = encode_invitation(&Invitation {
        fp: "a".repeat(64),
        addrs: vec![address.ip()],
        port: address.port(),
        token: URL_SAFE_NO_PAD.encode([1u8; 16]),
        exp: crate::unix_timestamp_ms() + 60_000,
    })
    .unwrap();
    start_invitation(&inner, &text).await.unwrap();
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            if inner
                .lock()
                .flow
                .as_ref()
                .is_some_and(|flow| !flow.is_active())
            {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert!(inner.lock().flow.as_ref().unwrap().stage == FlowStage::Failed);
    assert!(begin_flow(&inner, "Try again".into()).is_ok());
    peer.await.unwrap();
}
