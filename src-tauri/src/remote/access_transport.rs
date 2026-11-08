//! Bounded native delivery; a link's TCP direction and application data role
//! do not change which TLS key owns an access request or its answer.
use super::*;
use crate::remote::{begin_task, canonical_socket, MAX_DIALS};

pub(super) fn connected(inner: &Arc<Inner>, link: &Arc<Link>) {
    let run = {
        let mut core = inner.lock();
        let relevant = core.access.outgoing.values().any(|r| {
            r.view.fingerprint.as_deref() == Some(&link.peer_fingerprint)
                && ((r.active() && r.pin_saved)
                    || (r.view.state == "cancelled" && !r.cancel_delivered))
        }) || core
            .access
            .incoming
            .get(&link.peer_fingerprint)
            .is_some_and(|r| !r.acked);
        relevant && core.access.syncing.insert(link.id)
    };
    if !run {
        return;
    }
    link.pairing_started.store(true, Ordering::Release);
    let inner = inner.clone();
    let link = link.clone();
    tauri::async_runtime::spawn(async move {
        sync(&inner, &link).await;
        inner.lock().access.syncing.remove(&link.id);
        inner.changed();
    });
}
fn candidates(core: &Core, peer: Option<&str>, stored: &[SocketAddr]) -> Vec<SocketAddr> {
    let mut addresses: Vec<_> = core
        .nearby
        .values()
        .filter(|e| peer.is_some() && e.proven.as_deref() == peer)
        .flat_map(|e| e.addresses.iter().copied())
        .chain(stored.iter().copied())
        .map(canonical_socket)
        .collect();
    addresses.sort_by_key(|a| crate::remote::address_is_vpn_range(a.ip()));
    addresses.dedup();
    addresses.truncate(crate::remote::MAX_ADDRESSES);
    addresses
}
fn existing(core: &Core, peer: Option<&str>, addresses: &[SocketAddr]) -> Option<Arc<Link>> {
    if let Some(peer) = peer {
        return core
            .links
            .values()
            .filter(|l| l.peer_fingerprint == peer && l.is_open())
            .max_by_key(|l| l.is_paired())
            .cloned();
    }
    // A DNS name isn't identity. For an unpinned selection, use only a saved
    // authenticated peer endpoint and only if the match is unambiguous.
    let peers: HashSet<_> = core
        .devices
        .values()
        .filter(|d| {
            d.addresses
                .iter()
                .filter_map(|a| a.parse::<SocketAddr>().ok())
                .any(|a| {
                    addresses
                        .iter()
                        .any(|b| canonical_socket(a) == canonical_socket(*b))
                })
        })
        .map(|d| d.fingerprint.as_str())
        .collect();
    if peers.len() != 1 {
        return None;
    }
    existing(core, peers.into_iter().next(), addresses)
}
#[derive(Clone)]
struct Job {
    key: String,
    peer: Option<String>,
    addresses: Vec<SocketAddr>,
    outgoing: Option<String>,
}
pub(super) fn kick(inner: &Arc<Inner>, peer: &str) {
    let links = {
        let mut core = inner.lock();
        if let Some(retry) = core.access.retry.get_mut(peer) {
            retry.at = Instant::now();
            retry.attempt = 0;
        }
        core.links
            .values()
            .filter(|l| l.peer_fingerprint == peer && l.is_open())
            .cloned()
            .collect::<Vec<_>>()
    };
    for link in links {
        connected(inner, &link);
    }
    inner.wake.notify_one();
}
pub(super) fn schedule(inner: &Arc<Inner>) {
    let due = {
        let mut core = inner.lock();
        let mut jobs = HashMap::new();
        for row in core.access.outgoing.values().filter(|r| {
            (r.active() && !core.access.cancelled.contains(&r.view.request_id))
                || (r.view.state == "cancelled" && !r.cancel_delivered)
        }) {
            let key = row
                .view
                .fingerprint
                .clone()
                .unwrap_or_else(|| row.view.request_id.clone());
            jobs.entry(key.clone()).or_insert(Job {
                key,
                peer: row.view.fingerprint.clone(),
                addresses: row.addresses.clone(),
                outgoing: Some(row.view.request_id.clone()),
            });
        }
        {
            for row in core
                .access
                .incoming
                .values()
                .filter(|r| !r.acked && (core.settings.hosting || r.decision != "pending"))
            {
                let key = row.view.fingerprint.clone();
                jobs.entry(key.clone()).or_insert(Job {
                    key,
                    peer: Some(row.view.fingerprint.clone()),
                    addresses: row.addresses.clone(),
                    outgoing: None,
                });
            }
        }
        let mut due = Vec::new();
        for (_, mut job) in jobs {
            job.addresses = candidates(&core, job.peer.as_deref(), &job.addresses);
            let retry = core.access.retry.entry(job.key.clone()).or_insert(Retry {
                at: Instant::now(),
                in_flight: false,
                attempt: 0,
            });
            if retry.in_flight || Instant::now() < retry.at {
                continue;
            }
            retry.in_flight = true;
            due.push(job);
        }
        due
    };
    for job in due {
        if !begin_task(&inner.active_dials, MAX_DIALS) {
            if let Some(r) = inner.lock().access.retry.get_mut(&job.key) {
                r.in_flight = false;
            }
            continue;
        }
        let inner = inner.clone();
        tauri::async_runtime::spawn(async move {
            // Never cancel a queued pin/save: its SQL may finish after a
            // timeout. Only the network dial phase has a deadline.
            deliver(&inner, &job).await;
            inner.active_dials.fetch_sub(1, Ordering::AcqRel);
            let mut core = inner.lock();
            if let Some(retry) = core.access.retry.get_mut(&job.key) {
                retry.in_flight = false;
                retry.at =
                    Instant::now() + Duration::from_secs([2, 5, 10, 30, 60][retry.attempt.min(4)]);
                retry.attempt = retry.attempt.saturating_add(1);
            }
            drop(core);
            inner.changed();
        });
    }
}
async fn deliver(inner: &Arc<Inner>, job: &Job) {
    let existing = { existing(&inner.lock(), job.peer.as_deref(), &job.addresses) };
    let mut reverse = false;
    let link = if let Some(link) = existing {
        reverse = job.outgoing.is_some() && link.role == Role::Host;
        Some(link)
    } else {
        tokio::time::timeout(Duration::from_secs(30), open_link(inner, job))
            .await
            .ok()
            .flatten()
    };
    let Some(link) = link else {
        return;
    };
    if let Some(id) = &job.outgoing {
        let cancelled = inner
            .lock()
            .access
            .outgoing
            .get(id)
            .is_some_and(|r| r.view.state == "cancelled");
        if !cancelled {
            if let Err(message) = pin(inner, id, &link, reverse).await {
                // Saving may recover, and a stale concurrent capture must
                // not kill the request already pinned by another attempt.
                let duplicate = message == "An access request to that computer is already waiting.";
                failure(inner, job, &message, duplicate);
                return;
            }
        }
    }
    connected(inner, &link);
}
async fn open_link(inner: &Arc<Inner>, job: &Job) -> Option<Arc<Link>> {
    let Some(identity) = inner.identity.get().cloned() else {
        return None;
    };
    let mut result = None;
    for address in &job.addresses {
        let policy = job.peer.as_ref().map_or(ServerKeyPolicy::Capture, |p| {
            ServerKeyPolicy::Pinned(p.clone())
        });
        let role = if job.outgoing.is_some() {
            Role::Viewer
        } else {
            Role::Host
        };
        match session::dial(
            inner,
            &identity,
            *address,
            policy,
            super::super::session::DialPurpose::Access(role),
        )
        .await
        {
            Ok(link) => {
                result = Some(link);
                break;
            }
            Err(super::super::session::DialError::KeyRejected(_)) => {
                failure(inner,job,"The computer that answered has a different identity. Cancel this request and choose the correct computer.",true);
                return None;
            }
            Err(
                super::super::session::DialError::UpdateRequired
                | super::super::session::DialError::PeerUpdateRequired,
            ) => {
                failure(
                    inner,
                    job,
                    "Update Mythra Code on both computers, then request access again.",
                    true,
                );
                return None;
            }
            Err(super::super::session::DialError::LocalNetworkMayBeBlocked) => {
                failure(inner,job,"macOS may be blocking local connections. Open System Settings → Privacy & Security → Local Network and turn on Mythra Code. We'll keep trying.",false);
            }
            Err(_) => {}
        }
    }
    result
}

fn failure(inner: &Arc<Inner>, job: &Job, message: &str, terminal: bool) {
    let mut core = inner.lock();
    let write = if let Some(row) = job
        .outgoing
        .as_ref()
        .and_then(|id| core.access.outgoing.get_mut(id))
        .filter(|r| r.active())
    {
        row.view.error = Some(message.into());
        if terminal {
            row.view.state = "failed".into();
            Some(row.clone())
        } else {
            None
        }
    } else {
        None
    };
    if let Some(row) = write {
        let _ = inner.enqueue_write(true, move |db| persistence::outgoing(db, &row));
    }
}
async fn pin(inner: &Arc<Inner>, id: &str, link: &Arc<Link>, reverse: bool) -> Result<(), String> {
    let _serial = inner.access_serial.lock().await;
    let (row, saved) = {
        let mut core = inner.lock();
        let mut row = core
            .access
            .outgoing
            .get(id)
            .filter(|r| r.active() && !core.access.cancelled.contains(id))
            .cloned()
            .ok_or_else(save_failed)?;
        if row
            .view
            .fingerprint
            .as_ref()
            .is_some_and(|fp| *fp != link.peer_fingerprint)
        {
            return Err("The computer's identity changed.".into());
        }
        if core.access.outgoing.values().any(|other| {
            other.view.request_id != id
                && other.active()
                && other.view.state != "declined"
                && other.view.fingerprint.as_deref() == Some(&link.peer_fingerprint)
        }) {
            return Err("An access request to that computer is already waiting.".into());
        }
        if row.view.fingerprint.is_none() {
            row.relationship = core.relationship(&link.peer_fingerprint);
            row.grant_revision = core
                .devices
                .get(&link.peer_fingerprint)
                .and_then(|r| r.grant.as_ref())
                .map(|g| g.revision);
        }
        row.view.fingerprint = Some(link.peer_fingerprint.clone());
        row.spki = link.peer_spki.clone();
        if core
            .access
            .consent_cutoffs
            .get(&link.peer_fingerprint)
            .is_some_and(|at| *at >= row.view.created_at)
        {
            row.view.reciprocal = false;
        }
        row.view.reverse_connecting = reverse;
        // Pin immediately in memory, before waiting for SQL. A slow writer
        // must never leave a retry free to Capture a different key.
        core.access.outgoing.insert(id.into(), row.clone());
        let mut write = row.clone();
        write.pin_saved = true;
        let saved = inner.enqueue_write(false, move |db| persistence::outgoing(db, &write));
        row.pin_saved = true;
        (row, saved)
    };
    crate::remote::finish_write(saved)
        .await
        .map_err(|_| save_failed())?;
    inner.lock().access.outgoing.insert(id.into(), row);
    inner.changed();
    Ok(())
}
async fn sync(inner: &Arc<Inner>, link: &Arc<Link>) {
    let outgoing: Vec<_> = {
        let core = inner.lock();
        core.access
            .outgoing
            .values()
            .filter(|r| {
                r.view.fingerprint.as_deref() == Some(&link.peer_fingerprint)
                    && ((r.active() && r.pin_saved)
                        || (r.view.state == "cancelled" && !r.cancel_delivered))
            })
            .cloned()
            .collect()
    };
    for row in outgoing {
        if row.view.state == "cancelled" {
            if link
                .request(
                    "access.cancel",
                    json!({"requestId":row.view.request_id}),
                    WAIT,
                )
                .await
                .is_ok()
            {
                // Cancellation remains visible, but no network retry is needed.
                let _serial = inner.access_serial.lock().await;
                let mut current = {
                    inner
                        .lock()
                        .access
                        .outgoing
                        .get(&row.view.request_id)
                        .cloned()
                };
                if let Some(ref mut current) = current {
                    current.cancel_delivered = true;
                    let write = current.clone();
                    let saved = {
                        let _c = inner.lock();
                        inner.enqueue_write(false, move |db| persistence::outgoing(db, &write))
                    };
                    if crate::remote::finish_write(saved).await.is_ok() {
                        inner
                            .lock()
                            .access
                            .outgoing
                            .insert(row.view.request_id.clone(), current.clone());
                    }
                }
            }
            continue;
        }
        let args = {
            let core = inner.lock();
            json!({"requestId":row.view.request_id,"name":crate::remote::device_name(&core),"platform":wire::platform_name(),"reciprocal":row.view.reciprocal,"port":core.listener.as_ref().map(|l|l.port)})
        };
        let reply = link.request("access.request", args, WAIT).await;
        let _serial = inner.access_serial.lock().await;
        let saved = {
            let core = inner.lock();
            let Some(mut current) = core
                .access
                .outgoing
                .get(&row.view.request_id)
                .filter(|r| r.active() && !core.access.cancelled.contains(&r.view.request_id))
                .cloned()
            else {
                continue;
            };
            match reply {
                Ok(value) => {
                    let was_declined = current.view.state == "declined";
                    current.view.state = if was_declined { "declined" } else { "waiting" }.into();
                    current.view.error = None;
                    current.view.reverse_connecting = false;
                    current.view.code = value
                        .get("code")
                        .and_then(Value::as_str)
                        .filter(|s| s.len() == 6 && s.bytes().all(|b| b.is_ascii_digit()))
                        .map(str::to_string);
                    if let Some(name) = value
                        .get("name")
                        .and_then(Value::as_str)
                        .and_then(wire::clean_name)
                    {
                        current.view.name = name;
                    }
                }
                Err(error) => {
                    current.view.reverse_connecting = false;
                    current.view.error=Some(match error.code.as_str(){"inbox_full"=>"That computer has five waiting requests. Ask its owner to answer one, then request access again.".into(),"unsupported"=>"Update Mythra Code on both computers, then request access again.".into(),"hosting_off"=>"On the other computer, turn on Let my other computers use this one, then try again.".into(),_=>"The other computer couldn't receive the request yet. We'll keep trying.".into()});
                    if matches!(error.code.as_str(), "inbox_full" | "unsupported") {
                        current.view.state = "failed".into();
                    }
                }
            }
            let write = current.clone();
            let saved = inner.enqueue_write(false, move |db| persistence::outgoing(db, &write));
            (current, saved)
        };
        if crate::remote::finish_write(saved.1).await.is_ok() {
            inner
                .lock()
                .access
                .outgoing
                .insert(saved.0.view.request_id.clone(), saved.0);
            inner.changed();
        }
    }
    let incoming = {
        inner
            .lock()
            .access
            .incoming
            .get(&link.peer_fingerprint)
            .filter(|r| r.decision != "pending" && !r.acked)
            .cloned()
    };
    if let Some(row) = incoming {
        let args = {
            let core = inner.lock();
            let decision = if matches!(row.decision.as_str(), "allow" | "viewOnly")
                && !core
                    .devices
                    .get(&link.peer_fingerprint)
                    .is_some_and(|d| d.grant.as_ref().is_some_and(|g| g.view))
            {
                "removed"
            } else {
                row.decision.as_str()
            };
            json!({"requestId":row.view.request_id,"decision":decision,"name":crate::remote::device_name(&core),"platform":wire::platform_name()})
        };
        if let Ok(reply) = link.request("access.answer", args, WAIT).await {
            let _ = ack(
                inner,
                link,
                &row,
                reply.get("reciprocal").and_then(Value::as_bool) == Some(true),
            )
            .await;
        }
    }
}
async fn ack(
    inner: &Arc<Inner>,
    link: &Arc<Link>,
    row: &Incoming,
    reciprocal: bool,
) -> Result<(), String> {
    let _serial = inner.access_serial.lock().await;
    let (write, epoch, saved) = {
        let mut core = inner.lock();
        let mut write = core
            .access
            .incoming
            .get(&link.peer_fingerprint)
            .filter(|r| {
                r.view.request_id == row.view.request_id
                    && !r.acked
                    && r.answer_revision == row.answer_revision
                    && r.decision == row.decision
            })
            .cloned()
            .ok_or_else(save_failed)?;
        let epoch = core.relationship(&link.peer_fingerprint);
        let viewer = reciprocal
            && write.view.reciprocal
            && matches!(write.decision.as_str(), "allow" | "viewOnly")
            && write.relationship == epoch;
        let mut device = record(
            &core,
            &link.peer_fingerprint,
            &write.spki,
            &write.view.name,
            write.view.platform.clone(),
            &write.addresses,
        );
        device.they_host = true;
        device.access_removed = false;
        write.acked = true;
        let token = format!(
            "reciprocal:{}:{}",
            link.peer_fingerprint, write.view.request_id
        );
        let sql = write.clone();
        core.begin_device_save(&link.peer_fingerprint);
        let saved = inner.enqueue_write(false, move |db| {
            if viewer {
                persistence::commit(db, &token, &device, false, true, Some(&sql), None).map(Some)
            } else {
                persistence::save_incoming(db, &sql).map(|_| None)
            }
        });
        (write, epoch, saved)
    };
    let result = crate::remote::finish_write(saved).await;
    let mut core = inner.lock();
    core.end_device_save(&link.peer_fingerprint);
    let device = result?;
    if core.relationship(&link.peer_fingerprint) != epoch {
        return Ok(());
    }
    if let Some(device) = device {
        publish(&mut core, device, false, true, None);
    }
    core.access
        .incoming
        .insert(link.peer_fingerprint.clone(), write);
    drop(core);
    inner.changed();
    inner.wake.notify_one();
    Ok(())
}
/// Reserved for known peers whose ordinary paired-role handshake cannot be
/// used. No request-supplied endpoint is ever dialed by this control message.
pub(super) async fn reverse(
    inner: &Arc<Inner>,
    link: &Arc<Link>,
    args: Value,
) -> Result<Value, WireError> {
    if !args.is_null() {
        return Err(wire_error("invalid_args", "That request isn't valid."));
    }
    let mut core = inner.lock();
    if !registered(&core, link) || !link.is_paired() {
        return Err(wire_error("not_paired", "That computer is not connected."));
    }
    if let Some(retry) = core.access.retry.get_mut(&link.peer_fingerprint) {
        if !retry.in_flight {
            retry.at = Instant::now();
        }
    }
    drop(core);
    inner.wake.notify_one();
    Ok(Value::Null)
}
