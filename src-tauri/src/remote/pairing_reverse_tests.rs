use super::super::cancellation_tests::Node;
use super::*;
use crate::remote::{advertised_port, schedule_dials, wants_listener, NearbyEntry, RemoteState};
const WAIT: Duration = Duration::from_secs(10);
fn address(node: &Node) -> SocketAddr {
    SocketAddr::new(
        "127.0.0.1".parse().unwrap(),
        node.inner.lock().listener.as_ref().unwrap().port,
    )
}
fn seed(node: &Node, peer: &Node, they_host: bool, grant: bool) {
    let record = DeviceRecord {
        fingerprint: peer.identity.fingerprint.clone(),
        spki: peer.identity.spki.clone(),
        name: "Trusted 💻 PC".into(),
        platform: None,
        addresses: vec![address(peer).to_string()],
        they_host,
        access_removed: false,
        paired_at: 1,
        last_seen_at: None,
        grant: grant.then(DeviceGrant::initial),
    };
    store::save_device(
        &mut node.inner.test_database.get().unwrap().lock().unwrap(),
        &record,
    )
    .unwrap();
    node.inner
        .lock()
        .devices
        .insert(record.fingerprint.clone(), record);
}
async fn until(mut ready: impl FnMut() -> bool) {
    tokio::time::timeout(WAIT, async {
        while !ready() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("reverse pairing condition timed out");
}
fn snap(node: &Node) -> Value {
    serde_json::to_value(node.inner.snapshot()).unwrap()
}
async fn control(mac: &Node, pc: &Node) -> Arc<Link> {
    pc.inner.lock().settings.device_name = Some("Trusted 💻 PC".into());
    seed(mac, pc, false, true);
    seed(pc, mac, true, false);
    let link = session::dial(
        &pc.inner,
        &pc.identity,
        address(mac),
        ServerKeyPolicy::Pinned(mac.identity.fingerprint.clone()),
        DialPurpose::Paired,
    )
    .await
    .unwrap();
    assert_eq!(link.role, Role::Viewer);
    assert!(link.is_paired());
    link
}
async fn blocked_pair(mac: &Node, pc: &Node) -> u64 {
    let mut entry = NearbyEntry::new(1);
    entry.addresses = vec![address(pc)];
    entry.resolved_at = Some(Instant::now());
    entry.name = Some("Untrusted DNS name".into());
    mac.inner
        .lock()
        .nearby
        .insert("mythra-aabbccdd".into(), entry);
    mac.inner.test_block_outgoing.store(true, Ordering::Release);
    start_nearby(&mac.inner, "mythra-aabbccdd").await.unwrap();
    until(|| {
        snap(mac)["flow"]["stage"] == "offered"
            && snap(pc)["pairing"]["request"]["code"].is_string()
    })
    .await;
    let flow = snap(mac);
    assert_eq!(flow["flow"]["target"], "Trusted 💻 PC");
    assert_eq!(flow["flow"]["code"], snap(pc)["pairing"]["request"]["code"]);
    flow["flow"]["id"].as_u64().unwrap()
}

#[tokio::test]
async fn blocked_nearby_pairing_automatically_returns_over_trusted_link_but_needs_both_approvals() {
    let mac = Node::new().await;
    let pc = Node::new().await;
    let original = control(&mac, &pc).await;
    let flow = blocked_pair(&mac, &pc).await;
    assert!(
        pc.inner
            .lock()
            .pairing
            .as_ref()
            .unwrap()
            .allowed_peer
            .as_deref()
            == Some(&mac.identity.fingerprint)
    );
    let request = snap(&pc)["pairing"]["request"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    // Even a host approving itself cannot finish until the viewer accepts its code.
    respond(&pc.inner, &request, true, None).await.unwrap();
    assert!(pc.inner.lock().devices[&mac.identity.fingerprint]
        .grant
        .is_none());
    assert!(!mac.inner.lock().devices[&pc.identity.fingerprint].they_host);
    respond_offer(&mac.inner, flow, true).unwrap();
    until(|| snap(&mac)["flow"]["stage"] == "done").await;
    assert!(
        original.is_open(),
        "the original opposite-direction viewer must survive"
    );
    let viewer = mac
        .inner
        .lock()
        .links
        .values()
        .find(|link| link.role == Role::Viewer && link.is_paired() && link.is_open())
        .cloned()
        .unwrap();
    assert!(!viewer.dialed);
    assert!(viewer.request("ping", Value::Null, WAIT).await.is_ok());
    for (node, peer) in [(&mac, &pc), (&pc, &mac)] {
        let saved =
            store::load_devices(&node.inner.test_database.get().unwrap().lock().unwrap()).unwrap();
        assert!(saved[&peer.identity.fingerprint].they_host);
        assert!(saved[&peer.identity.fingerprint].grant.is_some());
    }
}
#[tokio::test]
async fn declining_automatic_return_offer_keeps_original_direction_and_never_grants_reverse() {
    let mac = Node::new().await;
    let pc = Node::new().await;
    let original = control(&mac, &pc).await;
    let flow = blocked_pair(&mac, &pc).await;
    respond_offer(&mac.inner, flow, false).unwrap();
    until(|| {
        !mac.inner
            .lock()
            .flow
            .as_ref()
            .is_some_and(ViewerFlow::is_active)
    })
    .await;
    assert!(pc.inner.lock().devices[&mac.identity.fingerprint]
        .grant
        .is_none());
    assert!(!mac.inner.lock().devices[&pc.identity.fingerprint].they_host);
    assert!(original.request("ping", Value::Null, WAIT).await.is_ok());
}
#[tokio::test]
async fn paired_host_reconnects_to_receive_only_viewer_after_link_loss_without_manual_offer() {
    let mac = Node::new().await;
    let pc = Node::new().await;
    seed(&mac, &pc, true, false);
    seed(&pc, &mac, false, true);
    mac.inner.lock().settings.hosting = false;
    mac.inner.test_block_outgoing.store(true, Ordering::Release);
    assert!(wants_listener(&mac.inner.lock()));
    let port = address(&mac).port();
    assert_eq!(advertised_port(&mac.inner.lock()), Some(port));
    for _ in 0..2 {
        pc.inner.lock().dials.clear();
        schedule_dials(&pc.inner);
        // The first reconcile creates the peer backoff slot; the next is due.
        schedule_dials(&pc.inner);
        until(|| {
            mac.inner
                .lock()
                .links
                .values()
                .any(|link| link.role == Role::Viewer && link.is_paired() && link.is_open())
        })
        .await;
        let viewer = mac
            .inner
            .lock()
            .links
            .values()
            .find(|link| link.is_paired() && link.is_open())
            .cloned()
            .unwrap();
        assert!(!viewer.dialed);
        assert!(viewer.request("ping", Value::Null, WAIT).await.is_ok());
        let host = pc
            .inner
            .lock()
            .links
            .values()
            .find(|link| link.is_paired() && link.is_open())
            .cloned()
            .unwrap();
        let error = host.request("ping", Value::Null, WAIT).await.unwrap_err();
        assert_eq!(
            error.code, "not_paired",
            "receive-only must not expose this viewer's threads"
        );
        viewer.close(CloseReason::Finished);
        host.close(CloseReason::Finished);
        until(|| pc.inner.active_dials.load(Ordering::Acquire) == 0).await;
    }
    assert!(pc.inner.lock().pairing.is_none() && mac.inner.lock().pairing.is_none());
}
#[tokio::test]
async fn authenticated_reverse_nudge_prioritizes_host_over_blocked_direct_viewer_upgrade() {
    let mac = Node::new().await;
    let pc = Node::new().await;
    let old = control(&mac, &pc).await;
    old.close(CloseReason::Finished);
    for link in mac.inner.lock().links.values() {
        link.close(CloseReason::Finished);
    }
    let reverse_host = session::dial(
        &mac.inner,
        &mac.identity,
        address(&pc),
        ServerKeyPolicy::Pinned(pc.identity.fingerprint.clone()),
        DialPurpose::Paired,
    )
    .await
    .unwrap();
    assert_eq!(reverse_host.role, Role::Host);
    // Already approved both directions, but PC currently has only a reverse viewer link.
    seed(&mac, &pc, true, true);
    seed(&pc, &mac, true, true);
    mac.inner.test_block_outgoing.store(true, Ordering::Release);
    assert_eq!(
        crate::remote::role_for_peer(&pc.inner.lock(), &mac.identity.fingerprint),
        Some(Role::Viewer)
    );
    // Run the real blocked-viewer scheduler, including its authenticated nudge.
    mac.inner.lock().dials.clear();
    schedule_dials(&mac.inner);
    schedule_dials(&mac.inner);
    until(|| {
        pc.inner
            .lock()
            .dials
            .get(&mac.identity.fingerprint)
            .is_some_and(|dial| dial.reverse_requested)
    })
    .await;
    schedule_dials(&pc.inner);
    until(|| {
        mac.inner
            .lock()
            .links
            .values()
            .any(|link| link.role == Role::Viewer && link.is_paired() && link.is_open())
    })
    .await;
    assert!(reverse_host.is_open());
}
#[tokio::test]
async fn reverse_control_cannot_enable_hosting_preempt_approval_or_follow_caller_addresses() {
    let mac = Node::new().await;
    let pc = Node::new().await;
    let viewer = control(&mac, &pc).await;
    let host = mac
        .inner
        .lock()
        .links
        .values()
        .find(|link| link.role == Role::Host)
        .cloned()
        .unwrap();
    // Wrong direction, even though authenticated.
    assert_eq!(
        viewer
            .request(
                "pair.reverse",
                json!({"nonce":URL_SAFE_NO_PAD.encode([1;32])}),
                WAIT
            )
            .await
            .unwrap_err()
            .code,
        "not_paired"
    );
    pc.inner.lock().settings.hosting = false;
    assert_eq!(
        host.request(
            "pair.reverse",
            json!({"nonce":URL_SAFE_NO_PAD.encode([1;32])}),
            WAIT
        )
        .await
        .unwrap_err()
        .code,
        "hosting_off"
    );
    {
        let core = pc.inner.lock();
        assert!(!core.settings.hosting && core.pairing.is_none());
    }
    pc.inner.lock().settings.hosting = true;
    assert_eq!(
        host.request(
            "pair.reverse",
            json!({"nonce":URL_SAFE_NO_PAD.encode([1;32]),"address":"evil"}),
            WAIT
        )
        .await
        .unwrap_err()
        .code,
        "invalid_args"
    );
    test_open_window(&pc.inner, false, WAIT);
    let window = pc.inner.lock().pairing.as_ref().unwrap().id;
    pc.inner.lock().pairing.as_mut().unwrap().allowed_peer = Some("other".into());
    assert_eq!(
        host.request(
            "pair.reverse",
            json!({"nonce":URL_SAFE_NO_PAD.encode([1;32])}),
            WAIT
        )
        .await
        .unwrap_err()
        .code,
        "busy"
    );
    assert_eq!(pc.inner.lock().pairing.as_ref().unwrap().id, window);
    pc.inner.lock().devices.remove(&mac.identity.fingerprint);
    assert_eq!(
        host.request("link.reverse", Value::Null, WAIT)
            .await
            .unwrap_err()
            .code,
        "not_paired"
    );
}
#[tokio::test]
async fn returning_offer_requires_exact_peer_nonce_unexpired_local_flow_and_is_single_use() {
    let mac = Node::new().await;
    let pc = Node::new().await;
    seed(&mac, &pc, false, true);
    // A real unpaired TLS link supplies the exact key and immutable local role.
    let pc_host = session::dial(
        &pc.inner,
        &pc.identity,
        address(&mac),
        ServerKeyPolicy::Pinned(mac.identity.fingerprint.clone()),
        DialPurpose::Pairing(Role::Host),
    )
    .await
    .unwrap();
    let viewer = mac
        .inner
        .lock()
        .links
        .values()
        .find(|link| link.role == Role::Viewer)
        .cloned()
        .unwrap();
    let id = begin_flow(&mac.inner, "Trusted PC".into()).unwrap();
    let nonce = URL_SAFE_NO_PAD.encode([2; 32]);
    let args = json!({"nonce":nonce});
    assert!(claim_offer(&mac.inner, &viewer, args.clone()).is_err());
    let set = |peer: String, expires: Instant| {
        let mut core = mac.inner.lock();
        let relationship = core.relationship(&peer);
        core.flow.as_mut().unwrap().reverse = Some(Expectation {
            peer,
            nonce: nonce.clone(),
            relationship,
            expires,
        });
    };
    set("other".into(), Instant::now() + WAIT);
    assert!(claim_offer(&mac.inner, &viewer, args.clone()).is_err());
    set(pc.identity.fingerprint.clone(), Instant::now() - WAIT);
    assert!(claim_offer(&mac.inner, &viewer, args.clone()).is_err());
    set(pc.identity.fingerprint.clone(), Instant::now() + WAIT);
    assert!(claim_offer(
        &mac.inner,
        &viewer,
        json!({"nonce":URL_SAFE_NO_PAD.encode([3;32])})
    )
    .is_err());
    mac.inner.lock().end_relationship(&pc.identity.fingerprint);
    assert!(
        claim_offer(&mac.inner, &viewer, args.clone()).is_err(),
        "local revocation fences a returning callback"
    );
    set(pc.identity.fingerprint.clone(), Instant::now() + WAIT);
    assert_eq!(
        claim_offer(&mac.inner, &viewer, args.clone()).unwrap().0,
        id
    );
    assert!(claim_offer(&mac.inner, &viewer, args).is_err());
    cancel_flow(&mac.inner);
    assert!(pc_host.is_open() || pc_host.close_reason().is_some());
}
#[tokio::test]
async fn no_authenticated_same_peer_channel_never_bootstraps_or_pins_from_dns_name() {
    let inner = RemoteState::default().inner;
    let id = begin_flow(&inner, "Nearby PC".into()).unwrap();
    fail_flow(&inner, id, "No connection".into());
    assert!(!try_pair(&inner, id, &["127.0.0.1:1234".parse().unwrap()], None).await);
    assert!(inner.lock().flow.as_ref().unwrap().stage == FlowStage::Failed);
    {
        let core = inner.lock();
        assert!(core.devices.is_empty() && core.pairing.is_none());
    }
    let mac = Node::new().await;
    let pc = Node::new().await;
    let _original = control(&mac, &pc).await;
    let id = begin_flow(&mac.inner, "Imposter DNS".into()).unwrap();
    fail_flow(&mac.inner, id, "No connection".into());
    assert!(!try_pair(&mac.inner, id, &["127.0.0.1:1234".parse().unwrap()], None).await);
    assert!(!try_pair(&mac.inner, id, &[address(&pc)], Some(&"0".repeat(64))).await);
    assert!(pc.inner.lock().pairing.is_none());
}
#[tokio::test]
async fn hosting_off_retires_host_links_but_keeps_receive_only_reverse_viewer() {
    let mac = Node::new().await;
    let pc = Node::new().await;
    let _old = control(&mac, &pc).await;
    seed(&mac, &pc, true, true);
    seed(&pc, &mac, true, true);
    request_link(&mac.inner, &pc.identity.fingerprint).await;
    schedule_dials(&pc.inner);
    until(|| {
        mac.inner
            .lock()
            .links
            .values()
            .any(|link| link.role == Role::Viewer && link.is_open())
    })
    .await;
    mac.inner.lock().settings.hosting = false;
    crate::remote::retire_hosting(&mac.inner);
    let core = mac.inner.lock();
    assert!(core.listener.as_ref().unwrap().temporary);
    assert!(core
        .links
        .values()
        .all(|link| link.role != Role::Host || !link.is_open()));
    assert!(core
        .links
        .values()
        .any(|link| link.role == Role::Viewer && link.is_open()));
}

#[tokio::test]
async fn blocked_pairing_to_hosting_off_ends_with_actionable_failure_and_allows_retry() {
    let mac = Node::new().await;
    let pc = Node::new().await;
    let _old = control(&mac, &pc).await;
    pc.inner.lock().settings.hosting = false;
    let mut entry = NearbyEntry::new(1);
    entry.addresses = vec![address(&pc)];
    mac.inner
        .lock()
        .nearby
        .insert("mythra-aabbccdd".into(), entry);
    mac.inner.test_block_outgoing.store(true, Ordering::Release);
    start_nearby(&mac.inner, "mythra-aabbccdd").await.unwrap();
    until(|| {
        snap(&mac)["flow"]["error"]
            .as_str()
            .is_some_and(|message| message.contains("Allow access from nearby devices"))
    })
    .await;
    assert!(!mac.inner.lock().flow.as_ref().unwrap().is_active());
    assert!(begin_flow(&mac.inner, "Retry".into()).is_ok());
    let core = pc.inner.lock();
    assert!(!core.settings.hosting && core.pairing.is_none());
    assert!(core.devices[&mac.identity.fingerprint].grant.is_none());
}
