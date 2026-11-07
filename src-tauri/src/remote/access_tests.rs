use super::*;
use crate::remote::{pairing::cancellation_tests::Node, NearbyEntry, RemoteState};
const TEST_WAIT: Duration = Duration::from_secs(12);
fn addr(node: &Node) -> SocketAddr {
    SocketAddr::new(
        "127.0.0.1".parse().unwrap(),
        node.inner.lock().listener.as_ref().unwrap().port,
    )
}
fn nearby(a: &Node, b: &Node) {
    let mut entry = NearbyEntry::new(1);
    entry.addresses = vec![addr(b)];
    entry.name = Some("Test PC 💻".into());
    a.inner
        .lock()
        .nearby
        .insert("mythra-aabbccdd".into(), entry);
}
fn snapshot(node: &Node) -> Value {
    serde_json::to_value(node.inner.snapshot()).unwrap()
}
async fn drive(a: &Node, b: &Node, mut done: impl FnMut() -> bool) {
    tokio::time::timeout(TEST_WAIT, async {
        while !done() {
            schedule(&a.inner);
            schedule(&b.inner);
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
    })
    .await
    .expect("access delivery timed out");
}
async fn begin(a: &Node, b: &Node, reciprocal: bool) -> String {
    nearby(a, b);
    request(&a.inner, "mythra-aabbccdd", reciprocal)
        .await
        .unwrap();
    drive(a, b, || {
        snapshot(a)["outgoingRequests"][0]["state"] == "waiting"
            && snapshot(b)["accessRequests"][0]["requestId"].is_string()
    })
    .await;
    let id = snapshot(a)["outgoingRequests"][0]["requestId"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_eq!(
        snapshot(a)["outgoingRequests"][0]["code"],
        snapshot(b)["accessRequests"][0]["code"]
    );
    id
}
fn saved(node: &Node) -> HashMap<String, DeviceRecord> {
    store::load_devices(&node.inner.test_database.get().unwrap().lock().unwrap()).unwrap()
}
#[tokio::test]
async fn one_allow_durably_sets_up_both_directions_without_windows_or_code_steps() {
    let a = Node::new().await;
    let b = Node::new().await;
    a.inner.lock().settings.hosting = false;
    let id = begin(&a, &b, true).await;
    {
        let core = a.inner.lock();
        assert!(core.settings.hosting && core.settings.share_name);
        assert!(core
            .devices
            .get(&b.identity.fingerprint)
            .and_then(|d| d.grant.as_ref())
            .is_none());
    }
    assert!(a.inner.lock().pairing.is_none() && b.inner.lock().pairing.is_none());
    respond(&b.inner, &a.identity.fingerprint, &id, "allow")
        .await
        .unwrap();
    drive(&a, &b, || {
        snapshot(&a)["outgoingRequests"][0]["state"] == "allowed"
            && saved(&b)
                .get(&a.identity.fingerprint)
                .is_some_and(|d| d.they_host)
    })
    .await;
    for (node, peer) in [(&a, &b), (&b, &a)] {
        let rows = saved(node);
        let d = &rows[&peer.identity.fingerprint];
        assert!(d.they_host);
        let g = d.grant.as_ref().unwrap();
        assert!(
            g.view
                && g.work
                && g.capabilities.full_access
                && g.capabilities.terminal
                && g.capabilities.git_write
                && g.capabilities.checkpoint_restore
                && g.capabilities.manage_projects
        );
    }
}
#[tokio::test]
async fn unchecked_view_only_never_grants_reverse_authority() {
    let a = Node::new().await;
    let b = Node::new().await;
    a.inner.lock().settings.hosting = false;
    let id = begin(&a, &b, false).await;
    respond(&b.inner, &a.identity.fingerprint, &id, "viewOnly")
        .await
        .unwrap();
    drive(&a, &b, || {
        snapshot(&a)["outgoingRequests"][0]["state"] == "viewOnly"
    })
    .await;
    let a_saved = saved(&a);
    assert!(a_saved[&b.identity.fingerprint].they_host);
    assert!(a_saved[&b.identity.fingerprint].grant.is_none());
    let b_saved = saved(&b);
    let grant = b_saved[&a.identity.fingerprint].grant.as_ref().unwrap();
    assert!(grant.view && !grant.work && !grant.capabilities.terminal);
    assert!(!b_saved[&a.identity.fingerprint].they_host);
    assert!(!a.inner.lock().settings.hosting);
}
#[tokio::test]
async fn decline_survives_reload_and_host_can_immediately_allow_it() {
    let a = Node::new().await;
    let b = Node::new().await;
    let id = begin(&a, &b, true).await;
    respond(&b.inner, &a.identity.fingerprint, &id, "decline")
        .await
        .unwrap();
    drive(&a, &b, || {
        snapshot(&a)["outgoingRequests"][0]["state"] == "declined"
    })
    .await;
    assert!(saved(&a).is_empty() && saved(&b).is_empty());
    for node in [&a, &b] {
        let reloaded = load(&node.inner.test_database.get().unwrap().lock().unwrap()).unwrap();
        node.inner.lock().access = reloaded;
    }
    assert_eq!(snapshot(&b)["accessRequests"][0]["status"], "declined");
    assert!(request(&a.inner, "mythra-aabbccdd", true)
        .await
        .unwrap_err()
        .contains("minute"));
    respond(&b.inner, &a.identity.fingerprint, &id, "allow")
        .await
        .unwrap();
    drive(&a, &b, || {
        snapshot(&a)["outgoingRequests"][0]["state"] == "allowed"
    })
    .await;
    assert!(saved(&a)[&b.identity.fingerprint].grant.is_some());
}
#[tokio::test]
async fn cancel_is_durable_and_late_allow_cannot_grant_reciprocal_access() {
    let a = Node::new().await;
    let b = Node::new().await;
    let id = begin(&a, &b, true).await;
    cancel(&a.inner, &id).await.unwrap();
    // Host has not received Cancel yet; even a real Allow cannot revive it.
    respond(&b.inner, &a.identity.fingerprint, &id, "allow")
        .await
        .unwrap();
    drive(&a, &b, || {
        b.inner.lock().access.incoming[&a.identity.fingerprint].decision == "cancelled"
    })
    .await;
    assert_eq!(snapshot(&a)["outgoingRequests"][0]["state"], "cancelled");
    assert!(saved(&a)
        .get(&b.identity.fingerprint)
        .and_then(|d| d.grant.as_ref())
        .is_none());
    assert!(saved(&b)
        .get(&a.identity.fingerprint)
        .and_then(|d| d.grant.as_ref())
        .is_none());
    assert!(respond(&b.inner, &a.identity.fingerprint, &id, "allow")
        .await
        .is_err());
}
#[tokio::test]
async fn durable_request_survives_connection_loss_and_registry_reload_before_host_answers() {
    let a = Node::new().await;
    let b = Node::new().await;
    let id = begin(&a, &b, false).await;
    for node in [&a, &b] {
        for link in node.inner.lock().links.values() {
            link.close(session::CloseReason::Finished);
        }
        let registry = load(&node.inner.test_database.get().unwrap().lock().unwrap()).unwrap();
        node.inner.lock().access = registry;
    }
    respond(&b.inner, &a.identity.fingerprint, &id, "viewOnly")
        .await
        .unwrap();
    drive(&a, &b, || {
        snapshot(&a)["outgoingRequests"][0]["state"] == "viewOnly"
    })
    .await;
    assert!(saved(&a)[&b.identity.fingerprint].they_host);
}
#[tokio::test]
async fn blocked_outgoing_request_uses_same_authenticated_peer_link_without_manual_offer() {
    let a = Node::new().await;
    let b = Node::new().await;
    let record_a = DeviceRecord {
        fingerprint: b.identity.fingerprint.clone(),
        spki: b.identity.spki.clone(),
        name: "PC".into(),
        platform: None,
        addresses: vec![addr(&b).to_string()],
        they_host: false,
        access_removed: false,
        paired_at: 1,
        last_seen_at: None,
        grant: Some(full().succeeding(None)),
    };
    let mut record_b = record_a.clone();
    record_b.fingerprint = a.identity.fingerprint.clone();
    record_b.spki = a.identity.spki.clone();
    record_b.addresses = vec![addr(&a).to_string()];
    record_b.they_host = true;
    record_b.grant = None;
    for (node, row) in [(&a, record_a), (&b, record_b)] {
        store::save_device(
            &mut node.inner.test_database.get().unwrap().lock().unwrap(),
            &row,
        )
        .unwrap();
        node.inner
            .lock()
            .devices
            .insert(row.fingerprint.clone(), row);
    }
    let original = session::dial(
        &b.inner,
        &b.identity,
        addr(&a),
        ServerKeyPolicy::Pinned(a.identity.fingerprint.clone()),
        session::DialPurpose::Paired,
    )
    .await
    .unwrap();
    a.inner.test_block_outgoing.store(true, Ordering::Release);
    let id = begin(&a, &b, true).await;
    respond(&b.inner, &a.identity.fingerprint, &id, "allow")
        .await
        .unwrap();
    drive(&a, &b, || {
        snapshot(&a)["outgoingRequests"][0]["state"] == "allowed"
    })
    .await;
    assert!(original.is_open());
    assert!(a.inner.lock().pairing.is_none() && b.inner.lock().pairing.is_none());
}
#[tokio::test]
async fn cancellation_tombstone_precedes_a_reordered_request() {
    let a = Node::new().await;
    let b = Node::new().await;
    let link = session::dial(
        &a.inner,
        &a.identity,
        addr(&b),
        ServerKeyPolicy::Pinned(b.identity.fingerprint.clone()),
        session::DialPurpose::Pairing(Role::Viewer),
    )
    .await
    .unwrap();
    let id = uuid::Uuid::new_v4().to_string();
    link.request("access.cancel", json!({"requestId":id}), TEST_WAIT)
        .await
        .unwrap();
    let error = link
        .request(
            "access.request",
            json!({"requestId":id,"name":"Delayed","platform":"macos","reciprocal":true}),
            TEST_WAIT,
        )
        .await
        .unwrap_err();
    assert_eq!(error.code, "cancelled");
    assert!(snapshot(&b)["accessRequests"]
        .as_array()
        .unwrap()
        .is_empty());
}
#[tokio::test]
async fn seven_day_expiry_drops_requests_and_never_commits_pending_consent() {
    let a = Node::new().await;
    let b = Node::new().await;
    let id = begin(&a, &b, true).await;
    a.inner
        .lock()
        .access
        .outgoing
        .get_mut(&id)
        .unwrap()
        .view
        .expires_at = now() - 1;
    b.inner
        .lock()
        .access
        .incoming
        .get_mut(&a.identity.fingerprint)
        .unwrap()
        .view
        .expires_at = now() - 1;
    drive(&a, &b, || {
        a.inner.lock().access.outgoing[&id].view.state == "expired"
            && !b
                .inner
                .lock()
                .access
                .incoming
                .contains_key(&a.identity.fingerprint)
    })
    .await;
    assert!(saved(&a).is_empty() && saved(&b).is_empty());
    assert!(respond(&b.inner, &a.identity.fingerprint, &id, "allow")
        .await
        .is_err());
}
#[test]
fn never_used_local_mode_has_no_request_network_demand() {
    let state = RemoteState::default();
    let core = state.inner.lock();
    assert!(!core.access.demand() && !core.access.receive());
}

#[tokio::test]
async fn remembered_decline_delivers_after_hosting_is_off_without_exposing_data() {
    let a = Node::new().await;
    let b = Node::new().await;
    let id = begin(&a, &b, false).await;
    for node in [&a, &b] {
        for link in node.inner.lock().links.values() {
            link.close(session::CloseReason::Finished);
        }
    }
    b.inner.lock().settings.hosting = false;
    respond(&b.inner, &a.identity.fingerprint, &id, "decline")
        .await
        .unwrap();
    drive(&a, &b, || {
        snapshot(&a)["outgoingRequests"][0]["state"] == "declined"
    })
    .await;
    assert!(saved(&a).is_empty() && saved(&b).is_empty());
    for node in [&a, &b] {
        assert!(node.inner.lock().links.values().all(|l| !l.is_paired()));
    }
}

#[tokio::test]
async fn retry_is_pinned_to_the_exact_peer_not_a_matching_display_name() {
    let a = Node::new().await;
    let b = Node::new().await;
    let id = begin(&a, &b, false).await;
    respond(&b.inner, &a.identity.fingerprint, &id, "decline")
        .await
        .unwrap();
    drive(&a, &b, || {
        snapshot(&a)["outgoingRequests"][0]["state"] == "declined"
    })
    .await;
    assert!(snapshot(&a)["outgoingRequests"][0]["retryAfter"]
        .as_i64()
        .is_some());
    assert!(retry(&a.inner, &id).await.unwrap_err().contains("minute"));
    a.inner
        .lock()
        .access
        .outgoing
        .get_mut(&id)
        .unwrap()
        .declined_at = Some(now() - 61_000);
    b.inner
        .lock()
        .access
        .incoming
        .get_mut(&a.identity.fingerprint)
        .unwrap()
        .answered_at = Some(now() - 61_000);
    b.inner
        .lock()
        .access
        .incoming
        .get_mut(&a.identity.fingerprint)
        .unwrap()
        .view
        .created_at = now() - 61_000;
    let imposter = Node::new().await;
    nearby(&a, &imposter); // Same display name, wrong key/address.
    a.inner.lock().access.retry.insert(
        b.identity.fingerprint.clone(),
        Retry {
            at: Instant::now() + Duration::from_secs(60),
            in_flight: false,
            attempt: 4,
        },
    );
    retry(&a.inner, &id).await.unwrap();
    let new_id = a
        .inner
        .lock()
        .access
        .outgoing
        .values()
        .find(|r| r.view.request_id != id)
        .unwrap()
        .view
        .request_id
        .clone();
    assert_eq!(
        a.inner.lock().access.outgoing[&new_id]
            .view
            .fingerprint
            .as_deref(),
        Some(b.identity.fingerprint.as_str())
    );
    drive(&a, &b, || {
        b.inner
            .lock()
            .access
            .incoming
            .get(&a.identity.fingerprint)
            .is_some_and(|r| r.view.request_id == new_id)
    })
    .await;
    assert!(imposter.inner.lock().access.incoming.is_empty());
}

#[tokio::test]
async fn persisted_retirement_fence_covers_a_request_missing_from_the_memory_snapshot() {
    let a = Node::new().await;
    let b = Node::new().await;
    let id = begin(&a, &b, true).await;
    // A creation save can be queued/durable before its finisher publishes the
    // outgoing row. Revoke must fence that row even when its snapshot misses it.
    let queued = {
        let mut core = a.inner.lock();
        core.access.outgoing.remove(&id);
        core.end_relationship(&b.identity.fingerprint);
        core.access.retire(&b.identity.fingerprint);
        core.devices.remove(&b.identity.fingerprint);
        a.inner.enqueue_device_state(&core, &b.identity.fingerprint)
    };
    crate::remote::finish_write(queued).await.unwrap();
    a.inner.lock().relationships.clear();
    crate::remote::load(&a.inner).await;
    assert_eq!(snapshot(&a)["outgoingRequests"][0]["state"], "cancelled");
    respond(&b.inner, &a.identity.fingerprint, &id, "allow")
        .await
        .unwrap();
    drive(&a, &b, || {
        b.inner.lock().access.incoming[&a.identity.fingerprint].acked
    })
    .await;
    assert!(saved(&a)
        .get(&b.identity.fingerprint)
        .and_then(|d| d.grant.as_ref())
        .is_none());
    assert!(!saved(&a)
        .get(&b.identity.fingerprint)
        .is_some_and(|d| d.they_host));
}

#[tokio::test]
async fn decline_withdraws_older_crossed_reciprocal_consent_without_cancelling_own_view_request() {
    for undo in [false, true] {
        let a = Node::new().await;
        let b = Node::new().await;
        let a_id = begin(&a, &b, true).await;
        let b_id = begin(&b, &a, true).await;
        respond(&a.inner, &b.identity.fingerprint, &b_id, "decline")
            .await
            .unwrap();
        assert!(!a.inner.lock().access.outgoing[&a_id].view.reciprocal);
        assert!(a.inner.lock().access.outgoing[&a_id].active());
        // Undoing the decline grants exactly View only, not an implicit Full
        // upgrade when the older checked proposal receives its answer later.
        if undo {
            respond(&a.inner, &b.identity.fingerprint, &b_id, "viewOnly")
                .await
                .unwrap();
        }
        respond(&b.inner, &a.identity.fingerprint, &a_id, "allow")
            .await
            .unwrap();
        drive(&a, &b, || {
            a.inner.lock().access.outgoing[&a_id].view.state == "allowed"
        })
        .await;
        let saved_a = saved(&a);
        let device = &saved_a[&b.identity.fingerprint];
        assert!(device.they_host);
        if undo {
            let grant = device.grant.as_ref().unwrap();
            assert!(grant.view && !grant.work && !grant.capabilities.terminal);
        } else {
            assert!(device.grant.is_none());
        }
        let reloaded = load(&a.inner.test_database.get().unwrap().lock().unwrap()).unwrap();
        assert!(!reloaded.outgoing[&a_id].view.reciprocal);
    }
}

#[tokio::test]
async fn cancellation_history_caps_refuse_excess_and_bounded_cache_does_not_reopen_ids() {
    let a = Node::new().await;
    let b = Node::new().await;
    let known = uuid::Uuid::new_v4().to_string();
    {
        let mut db = b.inner.test_database.get().unwrap().lock().unwrap();
        let tx = db.transaction().unwrap();
        for i in 0..persistence::PER_PEER_HISTORY {
            tx.execute(
                "INSERT INTO remote_access_seen(peer,request_id,created_at) VALUES(?1,?2,?3)",
                rusqlite::params![
                    a.identity.fingerprint,
                    if i == 0 {
                        known.clone()
                    } else {
                        uuid::Uuid::new_v4().to_string()
                    },
                    now()
                ],
            )
            .unwrap();
        }
        tx.commit().unwrap();
    }
    let link = session::dial(
        &a.inner,
        &a.identity,
        addr(&b),
        ServerKeyPolicy::Pinned(b.identity.fingerprint.clone()),
        session::DialPurpose::Access(Role::Viewer),
    )
    .await
    .unwrap();
    let error = link
        .request(
            "access.cancel",
            json!({"requestId":uuid::Uuid::new_v4().to_string()}),
            TEST_WAIT,
        )
        .await
        .unwrap_err();
    assert_eq!(error.code, "rate_limited");
    assert!(error.message.contains("7 days"));
    link.request("access.cancel", json!({"requestId":known}), TEST_WAIT)
        .await
        .unwrap();
    let mut hidden = Vec::new();
    {
        let mut db = b.inner.test_database.get().unwrap().lock().unwrap();
        let tx = db.transaction().unwrap();
        tx.execute("DELETE FROM remote_access_seen", []).unwrap();
        for i in 0..persistence::GLOBAL_HISTORY {
            tx.execute(
                "INSERT INTO remote_access_seen(peer,request_id,created_at) VALUES(?1,?2,?3)",
                rusqlite::params![
                    format!("{:064x}", i / persistence::PER_PEER_HISTORY),
                    uuid::Uuid::new_v4().to_string(),
                    now()
                ],
            )
            .unwrap();
        }
        tx.commit().unwrap();
    }
    let error = link
        .request(
            "access.cancel",
            json!({"requestId":uuid::Uuid::new_v4().to_string()}),
            TEST_WAIT,
        )
        .await
        .unwrap_err();
    assert_eq!(error.code, "rate_limited");
    // Model a pre-fix database larger than today's cap. Startup may cache only
    // a bounded set, but a missing cache entry must still be refused in SQL.
    {
        let mut db = b.inner.test_database.get().unwrap().lock().unwrap();
        let tx = db.transaction().unwrap();
        for _ in 0..=persistence::GLOBAL_HISTORY {
            let id = uuid::Uuid::new_v4().to_string();
            tx.execute(
                "INSERT INTO remote_access_seen(peer,request_id,created_at) VALUES(?1,?2,?3)",
                rusqlite::params![a.identity.fingerprint, id, now()],
            )
            .unwrap();
            hidden.push(id);
        }
        tx.commit().unwrap();
    }
    let loaded = load(&b.inner.test_database.get().unwrap().lock().unwrap()).unwrap();
    assert!(loaded.seen.len() <= persistence::GLOBAL_HISTORY);
    let old = hidden
        .into_iter()
        .find(|id| {
            !loaded
                .seen
                .contains(&(a.identity.fingerprint.clone(), id.clone()))
        })
        .unwrap();
    b.inner.lock().access.seen = loaded.seen;
    let error = link
        .request(
            "access.request",
            json!({"requestId":old,"name":"Old replay","platform":"macos","reciprocal":false}),
            TEST_WAIT,
        )
        .await
        .unwrap_err();
    assert_eq!(error.code, "cancelled");
    assert!(b.inner.lock().access.incoming.is_empty());
}
#[tokio::test]
async fn seven_day_history_prune_frees_cancel_capacity_and_keeps_committed_grants() {
    let a = Node::new().await;
    let b = Node::new().await;
    let id = begin(&a, &b, false).await;
    respond(&b.inner, &a.identity.fingerprint, &id, "viewOnly")
        .await
        .unwrap();
    drive(&a, &b, || {
        a.inner.lock().access.outgoing[&id].view.state == "viewOnly"
            && b.inner.lock().access.incoming[&a.identity.fingerprint].acked
    })
    .await;
    let grant = saved(&b)[&a.identity.fingerprint].grant.clone();
    {
        let db = b.inner.test_database.get().unwrap().lock().unwrap();
        let old = now() - LIFETIME - 1;
        db.execute(
            "UPDATE remote_access_requests SET updated_at=?1",
            rusqlite::params![old],
        )
        .unwrap();
        db.execute(
            "UPDATE remote_access_effects SET created_at=?1",
            rusqlite::params![old],
        )
        .unwrap();
        db.execute(
            "UPDATE remote_access_seen SET created_at=?1",
            rusqlite::params![old],
        )
        .unwrap();
    }
    let link = a
        .inner
        .lock()
        .links
        .values()
        .find(|l| l.is_open())
        .cloned()
        .unwrap();
    link.request(
        "access.cancel",
        json!({"requestId":uuid::Uuid::new_v4().to_string()}),
        TEST_WAIT,
    )
    .await
    .unwrap();
    {
        let db = b.inner.test_database.get().unwrap().lock().unwrap();
        assert_eq!(
            db.query_row("SELECT COUNT(*) FROM remote_access_requests", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert_eq!(
            db.query_row("SELECT COUNT(*) FROM remote_access_effects", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert_eq!(
            db.query_row("SELECT COUNT(*) FROM remote_access_seen", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            1
        );
    }
    assert_eq!(saved(&b)[&a.identity.fingerprint].grant, grant);
}

#[tokio::test]
async fn reload_preserves_delivery_phase_instead_of_guessing_receipt_from_a_pin() {
    let a = Node::new().await;
    let b = Node::new().await;
    nearby(&a, &b);
    a.inner
        .lock()
        .nearby
        .get_mut("mythra-aabbccdd")
        .unwrap()
        .proven = Some(b.identity.fingerprint.clone());
    request(&a.inner, "mythra-aabbccdd", false).await.unwrap();
    let mut row = a
        .inner
        .lock()
        .access
        .outgoing
        .values()
        .next()
        .unwrap()
        .clone();
    assert!(row.view.fingerprint.is_some());
    assert_eq!(row.view.state, "connecting");
    row.view.reverse_connecting = true;
    persistence::outgoing(&a.inner.test_database.get().unwrap().lock().unwrap(), &row).unwrap();
    let loaded = load(&a.inner.test_database.get().unwrap().lock().unwrap()).unwrap();
    assert_eq!(
        loaded.outgoing[&row.view.request_id].view.state,
        "connecting"
    );
    assert!(
        !loaded.outgoing[&row.view.request_id]
            .view
            .reverse_connecting
    );
    let c = Node::new().await;
    let d = Node::new().await;
    let id = begin(&c, &d, false).await;
    let mut waiting = c.inner.lock().access.outgoing[&id].clone();
    waiting.view.reverse_connecting = true;
    persistence::outgoing(
        &c.inner.test_database.get().unwrap().lock().unwrap(),
        &waiting,
    )
    .unwrap();
    let loaded = load(&c.inner.test_database.get().unwrap().lock().unwrap()).unwrap();
    assert_eq!(loaded.outgoing[&id].view.state, "waiting");
    assert!(!loaded.outgoing[&id].view.reverse_connecting);
}
#[tokio::test]
async fn dismiss_failed_expired_history_never_undoes_an_independent_committed_grant() {
    for (decision, terminal) in [("allow", "failed"), ("viewOnly", "expired")] {
        let a = Node::new().await;
        let b = Node::new().await;
        let id = begin(&a, &b, true).await;
        respond(&b.inner, &a.identity.fingerprint, &id, decision)
            .await
            .unwrap();
        drive(&a, &b, || {
            matches!(
                a.inner.lock().access.outgoing[&id].view.state.as_str(),
                "allowed" | "viewOnly"
            ) && b.inner.lock().access.incoming[&a.identity.fingerprint].acked
        })
        .await;
        let before = saved(&a)[&b.identity.fingerprint].clone();
        assert!(before.grant.is_some());
        assert!(
            cancel(&a.inner, &id).await.is_err(),
            "a completed grant is not a dismissible proposal"
        );
        let row = {
            let mut core = a.inner.lock();
            let row = core.access.outgoing.get_mut(&id).unwrap();
            row.view.state = terminal.into();
            row.clone()
        };
        persistence::outgoing(&a.inner.test_database.get().unwrap().lock().unwrap(), &row).unwrap();
        cancel(&a.inner, &id).await.unwrap();
        let after = saved(&a)[&b.identity.fingerprint].clone();
        assert_eq!(before.grant, after.grant);
        assert_eq!(before.they_host, after.they_host);
        assert_eq!(before.access_removed, after.access_removed);
        let core = a.inner.lock();
        assert_eq!(core.access.outgoing[&id].view.state, "cancelled");
        assert!(core.access.outgoing[&id].cancel_delivered);
    }
}
