//! Optional authenticated control messages. They arrange a new TCP connection;
//! they never turn Hosting on, grant access, or replace either user's approval.
use super::*;
use crate::remote::{begin_task, canonical_socket, DialState, MAX_DIALS};

pub(super) struct Expectation {
    peer: String,
    nonce: String,
    relationship: u64,
    expires: Instant,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ReverseArgs {
    nonce: String,
}
fn reverse_args(args: Value) -> Result<ReverseArgs, WireError> {
    let args: ReverseArgs = serde_json::from_value(args)
        .map_err(|_| WireError::new("invalid_args", "That connection request isn't valid."))?;
    if decode_32(&args.nonce).is_none() {
        return Err(WireError::new(
            "invalid_args",
            "That connection request isn't valid.",
        ));
    }
    Ok(args)
}
fn current_link(core: &Core, link: &Link) -> bool {
    link.is_open()
        && link.is_paired()
        && core
            .links
            .get(&link.id)
            .is_some_and(|ours| std::ptr::eq(ours.as_ref(), link))
}
/// Only the authenticated host that already lets us view it may ask us to
/// connect back. A forgotten/stale link and a newly TLS-authenticated stranger
/// do not authorize a callback. No request supplies a destination address.
fn authorize(core: &Core, link: &Link) -> Result<(), WireError> {
    if link.role != Role::Viewer
        || !current_link(core, link)
        || !core
            .devices
            .get(&link.peer_fingerprint)
            .is_some_and(|device| device.they_host && !device.access_removed)
    {
        return Err(WireError::new(
            "not_paired",
            "This connection is no longer paired.",
        ));
    }
    if !core.settings.hosting {
        return Err(WireError::new(
            "hosting_off",
            "Turn on Allow access from nearby devices on this device, then try again.",
        ));
    }
    Ok(())
}
fn control_link(core: &Core, peer: &str) -> Option<Arc<Link>> {
    let allowed = core.settings.hosting
        && core
            .devices
            .get(peer)
            .is_some_and(|device| device.grant.as_ref().is_some_and(|grant| grant.view));
    allowed
        .then(|| {
            core.links
                .values()
                .find(|link| {
                    link.peer_fingerprint == peer
                        && link.role == Role::Host
                        && current_link(core, link)
                })
                .cloned()
        })
        .flatten()
}

pub(super) async fn request_link(inner: &Arc<Inner>, peer: &str) {
    let link = { control_link(&inner.lock(), peer) };
    if let Some(link) = link {
        // The normal dial backoff bounds these requests. An old peer can refuse
        // the optional opcode; the ordinary host reconnect still works.
        let _ = link
            .request("link.reverse", Value::Null, REQUEST_WAIT)
            .await;
    }
}

pub(super) fn handle_control(inner: &Arc<Inner>, link: &Arc<Link>, op: &str, args: Value) -> Reply {
    let mut core = inner.lock();
    if let Err(error) = authorize(&core, link) {
        return Reply::Done(Err(error));
    }
    if op == "link.reverse" {
        if !args.is_null() {
            return Reply::Done(Err(WireError::new(
                "invalid_args",
                "No details are needed.",
            )));
        }
        if !core
            .devices
            .get(&link.peer_fingerprint)
            .is_some_and(|device| device.grant.as_ref().is_some_and(|grant| grant.view))
        {
            return Reply::Done(Err(WireError::new(
                "forbidden",
                "This device no longer has access.",
            )));
        }
        let dial = core
            .dials
            .entry(link.peer_fingerprint.clone())
            .or_insert_with(DialState::new);
        // A duplicate must not reset an in-progress attempt or its backoff.
        if !dial.reverse_requested {
            dial.reverse_requested = true;
            dial.next_at = Instant::now();
        }
        drop(core);
        inner.wake.notify_one();
        return Reply::Done(Ok(Value::Null));
    }
    let args = match reverse_args(args) {
        Ok(args) => args,
        Err(error) => return Reply::Done(Err(error)),
    };
    if rate_limited(&mut core, session::limit_key(link.peer_addr.ip())) {
        return Reply::Done(Err(WireError::new(
            "rate_limited",
            "Too many attempts. Wait a minute.",
        )));
    }
    // Never preempt a manual pairing window or another peer's approval.
    if core.pairing.as_ref().is_some_and(|window| {
        window.pending.is_some()
            || window.is_committing()
            || window
                .allowed_peer
                .as_deref()
                .is_some_and(|peer| peer != link.peer_fingerprint)
    }) {
        return Reply::Done(Err(WireError::new(
            "busy",
            "Another device is pairing right now.",
        )));
    }
    let mut addresses = if link.dialed {
        vec![link.peer_addr]
    } else {
        core.devices[&link.peer_fingerprint]
            .addresses
            .iter()
            .filter_map(|address| address.parse::<SocketAddr>().ok())
            .filter(|address| {
                session::limit_key(address.ip()) == session::limit_key(link.peer_addr.ip())
            })
            .take(MAX_ADDRESSES)
            .collect()
    };
    addresses
        .iter_mut()
        .for_each(|address| *address = canonical_socket(*address));
    if addresses.is_empty() {
        return Reply::Done(Err(WireError::new(
            "unreachable",
            "No return address is available. Try again.",
        )));
    }
    if !begin_task(&inner.active_dials, MAX_DIALS) {
        return Reply::Done(Err(WireError::new(
            "busy",
            "Mythra Code is connecting. Try again in a moment.",
        )));
    }
    let created = if !core.pairing.as_ref().is_some_and(PairingWindow::is_open) {
        let id = inner.next_link_id.fetch_add(1, Ordering::Relaxed);
        core.pairing = Some(PairingWindow {
            id,
            allowed_peer: Some(link.peer_fingerprint.clone()),
            expires: Instant::now() + PENDING_LIFETIME,
            expires_at_ms: crate::unix_timestamp_ms() + PENDING_LIFETIME.as_millis() as i64,
            temporary: false,
            token: String::new(),
            token_used: true,
            invitation: None,
            nearby_failures: 0,
            bad_tokens: 0,
            pending: None,
            close_requested: false,
        });
        Some(id)
    } else {
        None
    };
    drop(core);
    if let Some(id) = created {
        let inner = inner.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(PENDING_LIFETIME).await;
            end_auto_window(&inner, id, false);
        });
    }
    inner.changed();
    let inner = inner.clone();
    let peer = link.peer_fingerprint.clone();
    let control = link.clone();
    tauri::async_runtime::spawn(async move {
        let mut attempt = OfferAttempt(None);
        let result = tokio::time::timeout(OFFER_LIMIT, async {
            if authorize(&inner.lock(), &control).is_err() {
                return None;
            }
            let linked = dial_any(
                &inner,
                &addresses,
                ServerKeyPolicy::Pinned(peer),
                Role::Host,
            )
            .await
            .ok()?;
            attempt.0 = Some(linked.clone());
            linked.pairing_started.store(true, Ordering::Release);
            let result = linked
                .request("pair.offer", json!({"nonce": args.nonce}), REQUEST_WAIT)
                .await;
            if result.is_ok() {
                attempt.0 = None;
            }
            result.ok()
        })
        .await;
        drop(attempt); // A timed-out offer must not leave a registered stranger.
        inner.active_dials.fetch_sub(1, Ordering::AcqRel);
        if !matches!(result, Ok(Some(_))) {
            if let Some(id) = created {
                end_auto_window(&inner, id, true);
            }
        }
        inner.wake.notify_one();
    });
    Reply::Done(Ok(Value::Null))
}
struct OfferAttempt(Option<Arc<Link>>);
impl Drop for OfferAttempt {
    fn drop(&mut self) {
        if let Some(link) = self.0.take() {
            link.close(CloseReason::Refused);
        }
    }
}
fn end_auto_window(inner: &Arc<Inner>, id: u64, only_empty: bool) {
    let removed = {
        let mut core = inner.lock();
        if !core.pairing.as_ref().is_some_and(|window| window.id == id) {
            return;
        }
        let window = core.pairing.as_mut().unwrap();
        if only_empty && window.pending.is_some() {
            return;
        }
        if window.is_committing() {
            window.close_requested = true;
            return;
        }
        core.pairing.take()
    };
    if let Some(pending) = removed.and_then(|window| window.pending) {
        release_pending(pending, Err(closed_error()));
    }
    inner.changed();
    inner.wake.notify_one();
}

/// A returning offer is solicited only by this local user's exact pending
/// flow, this saved key, and this single-use random nonce. An ordinary manual
/// offer continues to require its existing explicit receive window.
pub(super) fn claim_offer(
    inner: &Arc<Inner>,
    link: &Arc<Link>,
    args: Value,
) -> Result<(u64, String), WireError> {
    let args = reverse_args(args)?;
    let mut core = inner.lock();
    if link.role != Role::Viewer
        || link.is_paired()
        || !link.is_open()
        || !core
            .links
            .get(&link.id)
            .is_some_and(|ours| Arc::ptr_eq(ours, link))
    {
        return Err(closed_error());
    }
    let expected = core
        .flow
        .as_ref()
        .filter(|flow| flow.stage == FlowStage::Connecting && flow.link.is_none())
        .and_then(|flow| flow.reverse.as_ref())
        .ok_or_else(closed_error)?;
    if expected.peer != link.peer_fingerprint
        || expected.expires <= Instant::now()
        || core.relationship(&expected.peer) != expected.relationship
        || !core
            .devices
            .get(&expected.peer)
            .is_some_and(|device| device.grant.as_ref().is_some_and(|grant| grant.view))
        || !constant_time_eq(expected.nonce.as_bytes(), args.nonce.as_bytes())
    {
        return Err(closed_error());
    }
    let flow = core.flow.as_mut().unwrap();
    flow.reverse = None;
    flow.link = Some(link.clone());
    Ok((flow.id, flow.target.clone()))
}

/// DNS-SD supplies reachability, not identity. Match only an existing trusted
/// peer's authenticated listener endpoint (or the invitation's pinned key),
/// never a display name. Code comparison and BOTH approvals still follow.
pub(super) async fn try_pair(
    inner: &Arc<Inner>,
    id: u64,
    addresses: &[SocketAddr],
    pinned: Option<&str>,
) -> bool {
    let nonce = match random_bytes::<32>() {
        Ok(nonce) => URL_SAFE_NO_PAD.encode(nonce),
        Err(_) => return false,
    };
    let expires = Instant::now() + OFFER_LIMIT;
    let candidate = {
        let mut core = inner.lock();
        if !core.flow.as_ref().is_some_and(|flow| {
            flow.id == id
                && matches!(flow.stage, FlowStage::Connecting | FlowStage::Failed)
                && flow.link.is_none()
        }) {
            return false;
        }
        let mut candidates = core
            .devices
            .values()
            .filter(|device| {
                pinned.map_or_else(
                    || {
                        device
                            .addresses
                            .iter()
                            .filter_map(|a| a.parse::<SocketAddr>().ok())
                            .any(|a| {
                                addresses
                                    .iter()
                                    .any(|b| canonical_socket(a) == canonical_socket(*b))
                            })
                    },
                    |peer| peer == device.fingerprint,
                )
            })
            .filter_map(|device| {
                control_link(&core, &device.fingerprint).map(|link| (link, device.name.clone()))
            });
        let Some((link, name)) = candidates.next() else {
            return false;
        };
        if candidates.next().is_some() || core.listener.is_none() {
            return false;
        }
        drop(candidates);
        let relationship = core.relationship(&link.peer_fingerprint);
        let flow = core.flow.as_mut().unwrap();
        flow.stage = FlowStage::Connecting;
        flow.error = None;
        flow.target = name.clone();
        flow.fingerprint = Some(link.peer_fingerprint.clone());
        flow.connect_started = Instant::now();
        flow.reverse = Some(Expectation {
            peer: link.peer_fingerprint.clone(),
            nonce: nonce.clone(),
            relationship,
            expires,
        });
        (link, name)
    };
    inner.changed();
    let (link, name) = candidate;
    let reply = link
        .request("pair.reverse", json!({"nonce":nonce}), REQUEST_WAIT)
        .await;
    // The callback may beat the reply. Never replace a live comparison/save
    // with a late control error; only an unattached request may fail here.
    let waiting = {
        inner
            .lock()
            .flow
            .as_ref()
            .is_some_and(|flow| flow.id == id && flow.reverse.is_some() && flow.link.is_none())
    };
    if !waiting {
        return true;
    }
    if let Err(error) = reply {
        let message = match error.code.as_str() {
            "hosting_off" => format!("On {name}, open Settings → Connections → Devices and turn on Allow access from nearby devices. Then try again."),
            "busy" | "rate_limited" => explain_refusal(&error, &name, false),
            _ => format!("{name} couldn't open the return connection. Update Mythra Code on both devices, then try again. If it still fails, check that both computers are awake and on the same non-guest network."),
        };
        fail_flow(inner, id, message);
    } else {
        let inner = inner.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep_until(tokio::time::Instant::from_std(expires)).await;
            let waiting = {
                inner.lock().flow.as_ref().is_some_and(|flow| {
                    flow.id == id && flow.reverse.is_some() && flow.link.is_none()
                })
            };
            if waiting {
                fail_flow(&inner, id, format!("{name} couldn't connect back. Keep Mythra Code open on both computers, check the firewall on {name}, then try again."));
            }
        });
    }
    true
}

#[cfg(test)]
#[path = "pairing_reverse_tests.rs"]
mod tests;
