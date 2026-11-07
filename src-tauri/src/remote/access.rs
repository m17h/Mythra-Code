//! Simple, persistent access requests. TLS proves the key; only local IPC
//! approves authority. The short code is a detail, not a second blocking step.
use super::{
    session::{self, Link, Reply},
    store,
    tls::ServerKeyPolicy,
    wire::{self, Role, WireError},
    Core, DeviceGrant, DeviceRecord, Inner,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::net::SocketAddr;
use std::sync::{atomic::Ordering, Arc};
use std::time::{Duration, Instant};

#[path = "access_store.rs"]
mod persistence;
#[path = "access_transport.rs"]
mod transport;
pub(super) fn init(db: &rusqlite::Connection) -> rusqlite::Result<()> {
    persistence::init(db)
}
pub(super) fn connected(inner: &Arc<Inner>, link: &Arc<Link>) {
    transport::connected(inner, link)
}
pub(super) fn schedule(inner: &Arc<Inner>) {
    expire(inner);
    transport::schedule(inner)
}
const LIFETIME: i64 = 7 * 24 * 60 * 60 * 1000;
const CAP: usize = 5;
const WAIT: Duration = Duration::from_secs(10);
fn now() -> i64 {
    crate::unix_timestamp_ms()
}
fn save_failed() -> String {
    "Mythra Code couldn't save this access request. Try again.".into()
}
fn save_refusal(message: String) -> WireError {
    if message == persistence::HISTORY_FULL {
        wire_error("rate_limited", message)
    } else {
        wire_error("save_failed", save_failed())
    }
}
fn wire_error(code: &str, message: impl Into<String>) -> WireError {
    WireError::new(code, message)
}
fn request_id(id: &str) -> bool {
    uuid::Uuid::parse_str(id).is_ok()
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct RequestView {
    pub(super) request_id: String,
    pub(super) fingerprint: String,
    pub(super) name: String,
    pub(super) platform: Option<String>,
    pub(super) created_at: i64,
    pub(super) expires_at: i64,
    pub(super) reciprocal: bool,
    pub(super) code: String,
    pub(super) status: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct OutgoingView {
    pub(super) request_id: String,
    pub(super) fingerprint: Option<String>,
    pub(super) name: String,
    pub(super) platform: Option<String>,
    pub(super) created_at: i64,
    pub(super) expires_at: i64,
    pub(super) reciprocal: bool,
    pub(super) code: Option<String>,
    pub(super) state: String,
    pub(super) error: Option<String>,
    pub(super) reverse_connecting: bool,
    #[serde(default)]
    pub(super) retry_after: Option<i64>,
}
#[derive(Clone, Serialize, Deserialize)]
struct Incoming {
    view: RequestView,
    spki: Vec<u8>,
    addresses: Vec<SocketAddr>,
    decision: String,
    #[serde(default)]
    acked: bool,
    #[serde(default)]
    relationship: u64,
    #[serde(default)]
    answered_at: Option<i64>,
    #[serde(default)]
    answer_revision: u64,
    #[serde(default)]
    grant_revision: Option<u64>,
}
#[derive(Clone, Serialize, Deserialize)]
struct Outgoing {
    view: OutgoingView,
    spki: Vec<u8>,
    addresses: Vec<SocketAddr>,
    relationship: u64,
    grant_revision: Option<u64>,
    #[serde(default)]
    reciprocal_committed: bool,
    #[serde(default)]
    cancel_delivered: bool,
    #[serde(default)]
    declined_at: Option<i64>,
    #[serde(default)]
    pin_saved: bool,
}
impl Incoming {
    fn pending(&self) -> bool {
        self.decision == "pending" && self.view.expires_at > now()
    }
    fn actionable(&self) -> bool {
        matches!(self.decision.as_str(), "pending" | "decline") && self.view.expires_at > now()
    }
}
impl Outgoing {
    fn active(&self) -> bool {
        matches!(
            self.view.state.as_str(),
            "connecting" | "waiting" | "declined"
        ) && self.view.expires_at > now()
    }
}
struct Retry {
    at: Instant,
    in_flight: bool,
    attempt: usize,
}
#[derive(Default)]
pub(super) struct Registry {
    incoming: HashMap<String, Incoming>,
    outgoing: HashMap<String, Outgoing>,
    retry: HashMap<String, Retry>,
    syncing: HashSet<u64>,
    cancelled: HashSet<String>,
    key_rate: HashMap<String, (Instant, u32)>,
    maintaining: bool,
    seen: HashSet<(String, String)>,
    pub(super) fences: HashMap<String, u64>,
    consent_cutoffs: HashMap<String, i64>,
}
impl Registry {
    fn remember_seen(&mut self, peer: String, id: String) {
        if self.seen.len() >= persistence::GLOBAL_HISTORY {
            self.seen.clear();
        }
        self.seen.insert((peer, id));
    }
    pub(super) fn views(&self) -> (Vec<RequestView>, Vec<OutgoingView>) {
        let mut incoming: Vec<_> = self
            .incoming
            .values()
            .filter(|r| r.actionable())
            .map(|r| r.view.clone())
            .collect();
        incoming.sort_by_key(|r| r.created_at);
        let mut outgoing: Vec<_> = self
            .outgoing
            .values()
            .map(|r| {
                let mut view = r.view.clone();
                view.retry_after = (view.state == "declined")
                    .then(|| r.declined_at.map(|at| at + 60_000))
                    .flatten();
                if r.view.expires_at <= now()
                    && matches!(view.state.as_str(), "connecting" | "waiting" | "declined")
                {
                    view.state = "expired".into();
                    view.reverse_connecting = false;
                }
                view
            })
            .collect();
        outgoing.sort_by_key(|r| r.created_at);
        (incoming, outgoing)
    }
    pub(super) fn demand(&self) -> bool {
        self.incoming.values().any(|r| r.pending() || !r.acked)
            || self
                .outgoing
                .values()
                .any(|r| r.active() || (r.view.state == "cancelled" && !r.cancel_delivered))
    }
    pub(super) fn control_peer(&self, peer: &str) -> bool {
        self.incoming
            .get(peer)
            .is_some_and(|r| r.actionable() || !r.acked)
            || self.outgoing.values().any(|r| {
                r.view.fingerprint.as_deref() == Some(peer)
                    && (r.active() || (r.view.state == "cancelled" && !r.cancel_delivered))
            })
    }
    pub(super) fn receive(&self) -> bool {
        self.outgoing.values().any(Outgoing::active)
            || self
                .incoming
                .values()
                .any(|r| !r.acked && r.decision != "pending")
    }
}
pub(super) fn load(db: &rusqlite::Connection) -> Result<Registry, String> {
    let (mut incoming, mut outgoing, seen) = persistence::load(db)?;
    let fences = persistence::fences(db)?;
    let consent_cutoffs = persistence::consent_cutoffs(db)?;
    let mut cancelled = HashSet::new();
    for row in outgoing.values_mut() {
        if row.active()
            && row
                .view
                .fingerprint
                .as_ref()
                .is_some_and(|peer| row.relationship != fences.get(peer).copied().unwrap_or(0))
        {
            row.view.state = "cancelled".into();
            row.view.reverse_connecting = false;
            row.cancel_delivered = false;
            row.reciprocal_committed = false;
            cancelled.insert(row.view.request_id.clone());
        }
    }
    for row in incoming.values_mut() {
        if row.relationship != fences.get(&row.view.fingerprint).copied().unwrap_or(0) {
            row.decision = "removed".into();
            row.acked = false;
        }
    }
    Ok(Registry {
        incoming,
        outgoing,
        seen,
        fences,
        consent_cutoffs,
        cancelled,
        ..Registry::default()
    })
}
fn full() -> DeviceGrant {
    let mut g = DeviceGrant::initial();
    g.work = true;
    g.capabilities = store::GrantCapabilities {
        full_access: true,
        git_write: true,
        checkpoint_restore: true,
        terminal: true,
        manage_projects: true,
    };
    g
}
fn code(id: &str, requester: &str, host: &str) -> String {
    let digest = Sha256::digest(format!("mythra-access-v1\0{id}\0{requester}\0{host}"));
    format!(
        "{:06}",
        u64::from_be_bytes(digest[..8].try_into().unwrap()) % 1_000_000
    )
}
fn registered(core: &Core, link: &Arc<Link>) -> bool {
    link.is_open()
        && core
            .links
            .get(&link.id)
            .is_some_and(|ours| Arc::ptr_eq(ours, link))
}
fn record(
    core: &Core,
    peer: &str,
    spki: &[u8],
    name: &str,
    platform: Option<String>,
    addresses: &[SocketAddr],
) -> DeviceRecord {
    core.devices
        .get(peer)
        .cloned()
        .unwrap_or_else(|| DeviceRecord {
            fingerprint: peer.into(),
            spki: spki.to_vec(),
            name: name.into(),
            platform,
            addresses: addresses.iter().map(ToString::to_string).collect(),
            they_host: false,
            access_removed: false,
            paired_at: now(),
            last_seen_at: Some(now()),
            grant: None,
        })
}
fn publish(core: &mut Core, device: DeviceRecord, host: bool, viewer: bool, baseline: Option<u64>) {
    match core.devices.get_mut(&device.fingerprint) {
        Some(current) => {
            if viewer {
                current.they_host = device.they_host;
                current.access_removed = device.access_removed;
            }
            if host && current.grant.as_ref().map(|g| g.revision) == baseline {
                current.grant = device.grant;
            }
        }
        None => {
            core.devices.insert(device.fingerprint.clone(), device);
        }
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RequestArgs {
    request_id: String,
    name: String,
    platform: Option<String>,
    reciprocal: bool,
    #[serde(default)]
    port: Option<u16>,
}
fn public_platform(platform: Option<String>) -> Option<String> {
    platform.filter(|s| matches!(s.as_str(), "macos" | "windows"))
}

pub(super) async fn handle(inner: &Arc<Inner>, link: &Arc<Link>, op: &str, args: Value) -> Reply {
    link.pairing_started.store(true, Ordering::Release);
    let result = match op {
        "access.request" => receive_request(inner, link, args).await,
        "access.answer" => receive_answer(inner, link, args).await,
        "access.cancel" => receive_cancel(inner, link, args).await,
        "access.reverse" => transport::reverse(inner, link, args).await,
        _ => Err(wire_error(
            "unsupported",
            "Update Mythra Code on both computers, then try again.",
        )),
    };
    Reply::Done(result)
}
async fn receive_request(
    inner: &Arc<Inner>,
    link: &Arc<Link>,
    args: Value,
) -> Result<Value, WireError> {
    let args: RequestArgs = serde_json::from_value(args)
        .map_err(|_| wire_error("invalid_args", "That access request isn't valid."))?;
    let name = wire::clean_name(&args.name)
        .filter(|_| request_id(&args.request_id))
        .ok_or_else(|| wire_error("invalid_args", "That access request isn't valid."))?;
    let _serial = inner.access_serial.lock().await;
    // Startup/cache loading is bounded. Check the indexed durable tombstone on
    // a cache miss too, so that bound never reopens a cancelled request.
    let peer = link.peer_fingerprint.clone();
    let id = args.request_id.clone();
    let persisted_seen = inner
        .read_db(move |db| persistence::has_seen(db, &peer, &id))
        .await
        .map_err(save_refusal)?;
    let (row, saved) = {
        let mut core = inner.lock();
        if !registered(&core, link) || !core.settings.hosting {
            return Err(wire_error(
                "hosting_off",
                "Turn on Let my other computers use this one, then try again.",
            ));
        }
        if let Some(existing) = core
            .access
            .incoming
            .get(&link.peer_fingerprint)
            .filter(|r| r.view.request_id == args.request_id)
        {
            return Ok(json!({"code":existing.view.code,"name":super::device_name(&core)}));
        }
        if persisted_seen
            || core
                .access
                .seen
                .contains(&(link.peer_fingerprint.clone(), args.request_id.clone()))
        {
            return Err(wire_error(
                "cancelled",
                "That request has ended. Request access again.",
            ));
        }
        if let Some(prior) = core.access.incoming.get(&link.peer_fingerprint) {
            if prior.pending() {
                return Err(wire_error(
                    "busy",
                    "An access request from this computer is already waiting.",
                ));
            }
            if prior.decision == "decline"
                && prior.answered_at.is_some_and(|at| now() - at < 60_000)
            {
                return Err(wire_error("rate_limited","Wait a minute before requesting access again. The other computer can still allow the existing request."));
            }
        }
        if core
            .access
            .incoming
            .values()
            .filter(|r| r.pending())
            .count()
            >= CAP
        {
            return Err(wire_error("inbox_full","This computer has five waiting requests. Ask its owner to answer one, then try again."));
        }
        if super::pairing::rate_limited(&mut core, session::limit_key(link.peer_addr.ip())) {
            return Err(wire_error(
                "rate_limited",
                "Too many access requests. Wait a minute, then try again.",
            ));
        }
        if core.access.key_rate.len() > 256 {
            core.access
                .key_rate
                .retain(|_, (at, _)| at.elapsed() < Duration::from_secs(60));
        }
        let rate = core
            .access
            .key_rate
            .entry(link.peer_fingerprint.clone())
            .or_insert((Instant::now(), 0));
        if rate.0.elapsed() >= Duration::from_secs(60) {
            *rate = (Instant::now(), 0);
        }
        if rate.1 >= 3 {
            return Err(wire_error(
                "rate_limited",
                "Too many access requests. Wait a minute, then try again.",
            ));
        }
        rate.1 += 1;
        if core
            .access
            .incoming
            .get(&link.peer_fingerprint)
            .is_some_and(|r| now() - r.view.created_at < 20_000)
        {
            return Err(wire_error(
                "rate_limited",
                "Wait a moment before asking this computer again.",
            ));
        }
        let host = &inner
            .identity
            .get()
            .ok_or_else(|| wire_error("unavailable", "Try again."))?
            .fingerprint;
        let comparison = code(&args.request_id, &link.peer_fingerprint, host);
        let row = Incoming {
            view: RequestView {
                request_id: args.request_id,
                fingerprint: link.peer_fingerprint.clone(),
                name,
                platform: public_platform(args.platform),
                created_at: now(),
                expires_at: now() + LIFETIME,
                reciprocal: args.reciprocal,
                code: comparison,
                status: "pending".into(),
            },
            spki: link.peer_spki.clone(),
            addresses: args
                .port
                .filter(|p| *p != 0)
                .map(|p| SocketAddr::new(link.peer_addr.ip(), p))
                .into_iter()
                .collect(),
            decision: "pending".into(),
            acked: false,
            relationship: core.relationship(&link.peer_fingerprint),
            answered_at: None,
            answer_revision: 0,
            grant_revision: None,
        };
        let write = row.clone();
        let saved = inner.enqueue_write(false, move |db| persistence::save_incoming(db, &write));
        (row, saved)
    };
    super::finish_write(saved).await.map_err(save_refusal)?;
    let result = {
        let mut core = inner.lock();
        let result = json!({"code":row.view.code,"name":super::device_name(&core)});
        core.access
            .remember_seen(row.view.fingerprint.clone(), row.view.request_id.clone());
        core.access
            .incoming
            .insert(row.view.fingerprint.clone(), row);
        result
    };
    inner.changed();
    inner.wake.notify_one();
    Ok(result)
}

pub(super) async fn request(
    inner: &Arc<Inner>,
    instance: &str,
    reciprocal: bool,
) -> Result<(), String> {
    let (addresses, name) = inner.nearby_target(instance).await?;
    inner.ensure_identity().await?;
    let _serial = inner.access_serial.lock().await;
    let (row, saved, edit) = {
        let mut core = inner.lock();
        if core.access.outgoing.values().filter(|r| r.active()).count() >= CAP {
            return Err(
                "You already have five waiting requests. Cancel one, then try again.".into(),
            );
        }
        let pinned = core
            .nearby
            .get(instance)
            .and_then(|entry| entry.proven.clone());
        if core.access.outgoing.values().any(|r| {
            r.active()
                && r.view.state != "declined"
                && (pinned.is_some() && r.view.fingerprint == pinned || r.addresses == addresses)
        }) {
            return Err("An access request to that computer is already waiting.".into());
        }
        if core.access.outgoing.values().any(|r| {
            r.view.state == "declined"
                && (pinned.is_some() && r.view.fingerprint == pinned || r.addresses == addresses)
                && r.declined_at.is_some_and(|at| now() - at < 60_000)
        }) {
            return Err("Wait a minute before asking again. The other computer can still allow your existing request.".into());
        }
        let replaced: Vec<_> = core
            .access
            .outgoing
            .values()
            .filter(|r| {
                r.view.state == "declined"
                    && (pinned.is_some() && r.view.fingerprint == pinned
                        || r.addresses == addresses)
            })
            .map(|r| r.view.request_id.clone())
            .collect();
        let mut old_rows = Vec::new();
        for id in replaced {
            core.access.cancelled.insert(id.clone());
            let row = core.access.outgoing.get_mut(&id).unwrap();
            row.view.state = "cancelled".into();
            row.cancel_delivered = false;
            old_rows.push(row.clone());
        }
        let relationship = pinned.as_ref().map_or(0, |p| core.relationship(p));
        let grant_revision = pinned
            .as_ref()
            .and_then(|p| core.devices.get(p))
            .and_then(|d| d.grant.as_ref())
            .map(|g| g.revision);
        let row = Outgoing {
            view: OutgoingView {
                request_id: uuid::Uuid::new_v4().to_string(),
                fingerprint: pinned,
                name,
                platform: None,
                created_at: now(),
                expires_at: now() + LIFETIME,
                reciprocal,
                code: None,
                state: "connecting".into(),
                error: None,
                reverse_connecting: false,
                retry_after: None,
            },
            spki: vec![],
            addresses,
            relationship,
            grant_revision,
            reciprocal_committed: false,
            cancel_delivered: false,
            declined_at: None,
            pin_saved: false,
        };
        let edit = core.take_id();
        if reciprocal {
            core.edits.hosting = edit;
            core.edits.share_name = edit;
        }
        let write = row.clone();
        let saved = inner.enqueue_write(false, move |db| {
            let tx = db.transaction().map_err(|_| save_failed())?;
            persistence::outgoing(&tx, &write)?;
            for row in &old_rows {
                persistence::outgoing(&tx, row)?;
            }
            if reciprocal {
                store::set_hosting(&tx, true).map_err(|_| save_failed())?;
                store::set_share_name(&tx, true).map_err(|_| save_failed())?;
            }
            tx.commit().map_err(|_| save_failed())
        });
        (row, saved, edit)
    };
    super::finish_write(saved)
        .await
        .map_err(|_| save_failed())?;
    let peer_to_kick = row.view.fingerprint.clone();
    {
        let mut core = inner.lock();
        if reciprocal && core.edits.hosting == edit {
            core.settings.hosting = true;
        }
        if reciprocal && core.edits.share_name == edit {
            core.settings.share_name = true;
        }
        core.access
            .outgoing
            .insert(row.view.request_id.clone(), row);
    }
    if let Some(peer) = peer_to_kick {
        transport::kick(inner, &peer);
    }
    inner.changed();
    inner.wake.notify_one();
    Ok(())
}

pub(super) async fn respond(
    inner: &Arc<Inner>,
    peer: &str,
    id: &str,
    decision: &str,
) -> Result<(), String> {
    if !matches!(decision, "allow" | "viewOnly" | "decline") {
        return Err("Choose Allow, View only, or Decline.".into());
    }
    let _serial = inner.access_serial.lock().await;
    let (row, epoch, baseline, withdrawn, cutoff, saved) = {
        let mut core = inner.lock();
        let mut row = core
            .access
            .incoming
            .get(peer)
            .filter(|r| r.view.request_id == id && r.actionable())
            .cloned()
            .ok_or(
                "That request has already ended. Ask the other computer to request access again.",
            )?;
        if !core.settings.hosting && decision != "decline" {
            return Err(
                "Turn on Let my other computers use this one before allowing access.".into(),
            );
        }
        if core.unpublished_device_saves.contains_key(peer) {
            return Err("Access settings are still saving. Try again in a moment.".into());
        }
        row.answer_revision = row.answer_revision.saturating_add(1);
        row.decision = decision.into();
        row.view.status = if decision == "decline" {
            "declined"
        } else {
            "pending"
        }
        .into();
        row.answered_at = Some(now());
        if decision == "decline" {
            row.view.expires_at = now() + LIFETIME;
        }
        row.acked = false;
        let epoch = core.relationship(peer);
        let baseline = core
            .devices
            .get(peer)
            .and_then(|r| r.grant.as_ref())
            .map(|g| g.revision);
        let mut device = record(
            &core,
            peer,
            &row.spki,
            &row.view.name,
            row.view.platform.clone(),
            &row.addresses,
        );
        device.grant = Some(if decision == "allow" {
            full()
        } else {
            DeviceGrant::initial()
        });
        row.relationship = epoch;
        row.grant_revision =
            (decision != "decline").then_some(baseline.unwrap_or(0).saturating_add(1));
        let cutoff = now();
        let withdrawn: Vec<_> = if decision == "decline" {
            core.access
                .outgoing
                .values()
                .filter(|out| {
                    out.active()
                        && out.view.reciprocal
                        && out.view.created_at <= cutoff
                        && (out.view.fingerprint.as_deref() == Some(peer)
                            || (out.view.fingerprint.is_none()
                                && out.addresses.iter().any(|a| {
                                    row.addresses.iter().any(|b| {
                                        super::canonical_socket(*a) == super::canonical_socket(*b)
                                    })
                                })))
                })
                .cloned()
                .map(|mut out| {
                    out.view.reciprocal = false;
                    out
                })
                .collect()
        } else {
            Vec::new()
        };
        let write = row.clone();
        let outgoing = withdrawn.clone();
        let token = format!("in:{peer}:{id}");
        let declined = decision == "decline";
        core.begin_device_save(peer);
        let saved = inner.enqueue_write(false, move |db| {
            if declined {
                persistence::decline(db, &write, &outgoing, cutoff).map(|_| None)
            } else {
                persistence::commit(db, &token, &device, true, false, Some(&write), None).map(Some)
            }
        });
        (row, epoch, baseline, withdrawn, cutoff, saved)
    };
    let result = super::finish_write(saved).await;
    {
        let mut core = inner.lock();
        core.end_device_save(peer);
        let saved = result.map_err(|_| save_failed())?;
        if decision == "decline" {
            core.access.consent_cutoffs.insert(peer.into(), cutoff);
            for old in &withdrawn {
                if let Some(current) = core.access.outgoing.get_mut(&old.view.request_id) {
                    current.view.reciprocal = false;
                }
            }
        }
        if core.relationship(peer) != epoch {
            return Err(
                "This computer's access changed while saving. Check Devices and try again.".into(),
            );
        }
        if let Some(device) = saved {
            publish(&mut core, device, true, false, baseline);
        }
        core.access.incoming.insert(peer.into(), row);
    }
    transport::kick(inner, peer);
    inner.changed();
    inner.wake.notify_one();
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AnswerArgs {
    request_id: String,
    decision: String,
    name: String,
    platform: Option<String>,
}
async fn receive_answer(
    inner: &Arc<Inner>,
    link: &Arc<Link>,
    args: Value,
) -> Result<Value, WireError> {
    let answer: AnswerArgs = serde_json::from_value(args)
        .map_err(|_| wire_error("invalid_args", "That answer isn't valid."))?;
    if !matches!(
        answer.decision.as_str(),
        "allow" | "viewOnly" | "decline" | "expired" | "removed" | "cancelled"
    ) {
        return Err(wire_error("invalid_args", "That answer isn't valid."));
    }
    let _serial = inner.access_serial.lock().await;
    let (row, epoch, baseline, reciprocal, saved) = {
        let mut core = inner.lock();
        if !registered(&core, link) {
            return Err(wire_error("unavailable", "The connection ended."));
        }
        let mut row = core
            .access
            .outgoing
            .get(&answer.request_id)
            .filter(|r| {
                r.pin_saved && r.view.fingerprint.as_deref() == Some(&link.peer_fingerprint)
            })
            .cloned()
            .ok_or_else(|| wire_error("not_found", "That request has ended."))?;
        if !row.active() {
            return Ok(
                json!({"reciprocal":row.reciprocal_committed&&core.devices.get(&link.peer_fingerprint).is_some_and(|d|d.grant.as_ref().is_some_and(|g|g.view))}),
            );
        }
        if row.view.state == "declined" && answer.decision == "decline" {
            return Ok(json!({"reciprocal":false}));
        }
        if core.access.cancelled.contains(&row.view.request_id) {
            return Err(wire_error("cancelled", "That request was cancelled."));
        }
        if row.relationship != core.relationship(&link.peer_fingerprint) {
            return Err(wire_error(
                "cancelled",
                "Access settings changed. Request access again.",
            ));
        }
        if core
            .unpublished_device_saves
            .contains_key(&link.peer_fingerprint)
        {
            return Err(wire_error("busy", "Access settings are still saving."));
        }
        let allowed = matches!(answer.decision.as_str(), "allow" | "viewOnly");
        if answer.decision == "decline" {
            row.declined_at = Some(now());
            row.view.expires_at = now() + LIFETIME;
        }
        row.view.state = match answer.decision.as_str() {
            "allow" => "allowed",
            "viewOnly" => "viewOnly",
            "decline" => "declined",
            "removed" => "failed",
            other => other,
        }
        .into();
        row.view.error = (answer.decision == "removed")
            .then(|| "Access was removed. Request access again.".into());
        row.view.reverse_connecting = false;
        row.view.name = wire::clean_name(&answer.name).unwrap_or(row.view.name);
        row.view.platform = public_platform(answer.platform);
        let peer = &link.peer_fingerprint;
        let epoch = core.relationship(peer);
        let baseline = core
            .devices
            .get(peer)
            .and_then(|d| d.grant.as_ref())
            .map(|g| g.revision);
        let reciprocal = allowed
            && row.view.reciprocal
            && baseline == row.grant_revision
            && core
                .access
                .consent_cutoffs
                .get(peer)
                .is_none_or(|at| *at < row.view.created_at);
        row.reciprocal_committed = reciprocal;
        let mut device = record(
            &core,
            peer,
            &link.peer_spki,
            &row.view.name,
            row.view.platform.clone(),
            &row.addresses,
        );
        device.they_host = true;
        device.access_removed = false;
        if reciprocal {
            device.grant = Some(full());
        }
        let write = row.clone();
        let token = format!("out:{}:{}", link.peer_fingerprint, row.view.request_id);
        core.begin_device_save(peer);
        let saved = inner.enqueue_write(false, move |db| {
            if allowed {
                persistence::commit(db, &token, &device, reciprocal, true, None, Some(&write))
                    .map(Some)
            } else {
                persistence::outgoing(db, &write).map(|_| None)
            }
        });
        (row, epoch, baseline, reciprocal, saved)
    };
    let result = super::finish_write(saved).await;
    let obsolete = {
        let mut core = inner.lock();
        core.end_device_save(&link.peer_fingerprint);
        let device = result.map_err(|_| wire_error("save_failed", save_failed()))?;
        let obsolete = core.relationship(&link.peer_fingerprint) != epoch
            || core.access.cancelled.contains(&row.view.request_id);
        if !obsolete {
            if let Some(device) = device {
                publish(&mut core, device, reciprocal, true, baseline);
            }
            core.access
                .outgoing
                .insert(row.view.request_id.clone(), row.clone());
        }
        obsolete
    };
    if obsolete {
        let token = format!("out:{}:{}", link.peer_fingerprint, row.view.request_id);
        let saved = {
            let _core = inner.lock();
            inner.enqueue_write(false, move |db| persistence::undo(db, &token))
        };
        super::finish_write(saved)
            .await
            .map_err(|_| wire_error("save_failed", save_failed()))?;
        return Err(wire_error(
            "cancelled",
            "That request was cancelled or access changed.",
        ));
    }
    inner.changed();
    inner.wake.notify_one();
    Ok(json!({"reciprocal":reciprocal}))
}

pub(super) async fn cancel(inner: &Arc<Inner>, id: &str) -> Result<(), String> {
    {
        let mut core = inner.lock();
        let row = core
            .access
            .outgoing
            .get(id)
            .ok_or("That request could not be found.")?;
        let expired = matches!(
            row.view.state.as_str(),
            "connecting" | "waiting" | "declined"
        ) && row.view.expires_at <= now();
        if !row.active() && !expired && !matches!(row.view.state.as_str(), "failed" | "expired") {
            return Err("That request has already ended.".into());
        }
        core.access.cancelled.insert(id.into());
    }
    let _serial = inner.access_serial.lock().await;
    let (row, saved) = {
        let core = inner.lock();
        let mut row = core
            .access
            .outgoing
            .get(id)
            .cloned()
            .ok_or("That request has ended.")?;
        let dismiss_only = !row.active();
        row.view.state = "cancelled".into();
        row.cancel_delivered = dismiss_only || row.view.fingerprint.is_none();
        row.view.error = None;
        row.view.reverse_connecting = false;
        let write = row.clone();
        let saved = inner.enqueue_write(false, move |db| {
            if dismiss_only {
                persistence::outgoing(db, &write)
            } else {
                persistence::cancel_outgoing(db, &write)
            }
        });
        (row, saved)
    };
    super::finish_write(saved)
        .await
        .map_err(|_| save_failed())?;
    let peer = row.view.fingerprint.clone();
    inner.lock().access.outgoing.insert(id.into(), row);
    if let Some(peer) = peer {
        transport::kick(inner, &peer);
    }
    inner.changed();
    inner.wake.notify_one();
    Ok(())
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CancelArgs {
    request_id: String,
}
async fn receive_cancel(
    inner: &Arc<Inner>,
    link: &Arc<Link>,
    args: Value,
) -> Result<Value, WireError> {
    let args: CancelArgs = serde_json::from_value(args)
        .map_err(|_| wire_error("invalid_args", "That cancellation isn't valid."))?;
    if !request_id(&args.request_id) {
        return Err(wire_error("invalid_args", "That cancellation isn't valid."));
    }
    let _serial = inner.access_serial.lock().await;
    let (row, epoch, saved) = {
        let mut core = inner.lock();
        if !registered(&core, link) {
            return Err(wire_error("unavailable", "The connection ended."));
        }
        if super::pairing::rate_limited(&mut core, session::limit_key(link.peer_addr.ip())) {
            return Err(wire_error("rate_limited", "Wait a minute, then try again."));
        }
        let mut row = core
            .access
            .incoming
            .get(&link.peer_fingerprint)
            .filter(|r| r.view.request_id == args.request_id)
            .cloned();
        let epoch = core.relationship(&link.peer_fingerprint);
        if let Some(row) = row.as_mut() {
            if core
                .devices
                .get(&link.peer_fingerprint)
                .and_then(|d| d.grant.as_ref())
                .map(|g| g.revision)
                == row.grant_revision
                && row.grant_revision.is_some()
            {
                if let Some(device) = core.devices.get_mut(&link.peer_fingerprint) {
                    device.grant = None;
                }
                super::hostbridge::retire_device_locked(inner, &mut core, &link.peer_fingerprint);
                for link in core
                    .links
                    .values()
                    .filter(|l| l.role == Role::Host && l.peer_fingerprint == row.view.fingerprint)
                {
                    link.close(super::session::CloseReason::Revoked);
                }
            }
            row.decision = "cancelled".into();
            row.acked = true;
        }
        let write = row.clone();
        let peer = link.peer_fingerprint.clone();
        let id = args.request_id.clone();
        core.begin_device_save(&peer);
        let saved = inner.enqueue_write(false, move |db| {
            persistence::undo(db, &format!("in:{peer}:{id}"))?;
            let tx = db.transaction().map_err(|_| save_failed())?;
            persistence::tombstone(&tx, &peer, &id)?;
            if let Some(row) = &write {
                persistence::incoming(&tx, row)?;
            }
            tx.commit().map_err(|_| save_failed())?;
            Ok(store::load_devices(db)
                .map_err(|_| save_failed())?
                .remove(&peer))
        });
        (row, epoch, saved)
    };
    let result = super::finish_write(saved).await;
    let mut core = inner.lock();
    core.end_device_save(&link.peer_fingerprint);
    let device = result.map_err(save_refusal)?;
    core.access
        .remember_seen(link.peer_fingerprint.clone(), args.request_id);
    if core.relationship(&link.peer_fingerprint) == epoch {
        if let Some(device) = device {
            publish(&mut core, device, true, false, None);
        }
        if let Some(row) = row {
            core.access
                .incoming
                .insert(link.peer_fingerprint.clone(), row);
        }
    }
    drop(core);
    inner.changed();
    Ok(Value::Null)
}

/// Revoke/Forget also retire proposals so a delayed answer cannot undo that
/// local decision, including after restart. Saved with the device narrowing.
#[derive(Clone)]
pub(super) struct Narrowing {
    fence: u64,
    incoming: Option<Incoming>,
    outgoing: Vec<Outgoing>,
}
impl Registry {
    pub(super) fn retire(&mut self, peer: &str) {
        for row in self
            .outgoing
            .values_mut()
            .filter(|r| r.view.fingerprint.as_deref() == Some(peer))
        {
            if row.active() {
                row.view.state = "cancelled".into();
                row.view.reverse_connecting = false;
                row.cancel_delivered = false;
                self.cancelled.insert(row.view.request_id.clone());
            }
            row.reciprocal_committed = false;
        }
        if let Some(row) = self.incoming.get_mut(peer) {
            row.decision = if row.pending() || row.decision == "decline" {
                "decline"
            } else {
                "removed"
            }
            .into();
            row.view.status = "declined".into();
            row.acked = false;
            row.answered_at = Some(now());
        }
    }
    pub(super) fn narrowing(&self, peer: &str, fence: u64) -> Narrowing {
        Narrowing {
            fence,
            incoming: self.incoming.get(peer).cloned(),
            outgoing: self
                .outgoing
                .values()
                .filter(|r| r.view.fingerprint.as_deref() == Some(peer))
                .cloned()
                .collect(),
        }
    }
}
impl Narrowing {
    pub(super) fn save(
        &self,
        db: &mut rusqlite::Connection,
        peer: &str,
        record: Option<&DeviceRecord>,
    ) -> Result<(), String> {
        if self.incoming.is_none() && self.outgoing.is_empty() && self.fence == 0 {
            return match record {
                Some(row) => store::save_device(db, row),
                None => store::delete_device(db, peer),
            };
        }
        let tx = db.transaction().map_err(|_| save_failed())?;
        tx.execute("INSERT INTO remote_access_fences(peer,generation) VALUES(?1,?2) ON CONFLICT(peer) DO UPDATE SET generation=MAX(generation,excluded.generation)",rusqlite::params![peer,self.fence as i64]).map_err(|_|save_failed())?;
        match record {
            Some(row) => store::save_device_fields(&tx, row, 0, None)?,
            None => store::delete_device_fields(&tx, peer)?,
        }
        if let Some(row) = &self.incoming {
            persistence::incoming(&tx, row)?;
        }
        for row in &self.outgoing {
            persistence::outgoing(&tx, row)?;
        }
        tx.commit().map_err(|_| save_failed())
    }
}

#[cfg(test)]
#[path = "simple_pairing_tests.rs"]
mod simple_pairing_tests;

fn expire(inner: &Arc<Inner>) {
    let due = {
        let mut core = inner.lock();
        if core.access.maintaining {
            return;
        }
        let due = core.access.incoming.values().any(|r| {
            matches!(r.decision.as_str(), "pending" | "decline") && r.view.expires_at <= now()
        }) || core.access.outgoing.values().any(|r| {
            matches!(r.view.state.as_str(), "connecting" | "waiting" | "declined")
                && r.view.expires_at <= now()
        });
        if due {
            core.access.maintaining = true;
        }
        due
    };
    if !due {
        return;
    }
    let inner = inner.clone();
    tauri::async_runtime::spawn(async move {
        let _serial = inner.access_serial.lock().await;
        let (incoming, outgoing, saved) = {
            let core = inner.lock();
            let incoming: Vec<_> = core
                .access
                .incoming
                .values()
                .filter(|r| {
                    matches!(r.decision.as_str(), "pending" | "decline")
                        && r.view.expires_at <= now()
                })
                .cloned()
                .map(|mut r| {
                    r.decision = "expired".into();
                    r.acked = true;
                    r
                })
                .collect();
            let outgoing: Vec<_> = core
                .access
                .outgoing
                .values()
                .filter(|r| {
                    matches!(r.view.state.as_str(), "connecting" | "waiting" | "declined")
                        && r.view.expires_at <= now()
                })
                .cloned()
                .map(|mut r| {
                    r.view.state = "expired".into();
                    r.view.reverse_connecting = false;
                    r.reciprocal_committed = false;
                    r
                })
                .collect();
            let i = incoming.clone();
            let o = outgoing.clone();
            let saved = inner.enqueue_write(true, move |db| {
                let tx = db.transaction().map_err(|_| save_failed())?;
                for r in &i {
                    persistence::drop_expired(&tx, r)?;
                }
                for r in &o {
                    persistence::outgoing(&tx, r)?;
                }
                tx.commit().map_err(|_| save_failed())
            });
            (incoming, outgoing, saved)
        };
        let result = super::finish_write(saved).await;
        let mut core = inner.lock();
        core.access.maintaining = false;
        if result.is_ok() {
            for r in incoming {
                core.access.incoming.remove(&r.view.fingerprint);
            }
            for r in outgoing {
                core.access.outgoing.insert(r.view.request_id.clone(), r);
            }
        }
        drop(core);
        inner.changed();
    });
}

#[cfg(test)]
#[path = "access_tests.rs"]
mod tests;

/// Ask again without guessing identity from a display name or a recycled DNS
/// service instance. Only a previously TLS-proven key can be retried here.
pub(super) async fn retry(inner: &Arc<Inner>, id: &str) -> Result<(), String> {
    inner.ensure_identity().await?;
    let _serial = inner.access_serial.lock().await;
    let (old, row, edit, saved) = {
        let mut core = inner.lock();
        let mut old = core.access.outgoing.get(id).cloned().ok_or(
            "That request could not be found. Find the computer nearby and request access again.",
        )?;
        let peer = old
            .view
            .fingerprint
            .clone()
            .ok_or("Find this computer nearby and choose Request access again.")?;
        if !matches!(
            old.view.state.as_str(),
            "declined" | "expired" | "failed" | "cancelled"
        ) {
            return Err("That request is already waiting or has been allowed.".into());
        }
        if old.view.state == "declined" && old.declined_at.is_some_and(|at| now() < at + 60_000) {
            return Err("Wait a minute before asking again. The other computer can still allow your existing request.".into());
        }
        if core.access.outgoing.values().any(|r| {
            r.view.request_id != id && r.active() && r.view.fingerprint.as_deref() == Some(&peer)
        }) {
            return Err("An access request to that computer is already waiting.".into());
        }
        if core
            .access
            .outgoing
            .values()
            .filter(|r| r.active() && r.view.request_id != id)
            .count()
            >= CAP
        {
            return Err(
                "You already have five waiting requests. Cancel one, then try again.".into(),
            );
        }
        let mut row = old.clone();
        row.view.request_id = uuid::Uuid::new_v4().to_string();
        row.view.created_at = now();
        row.view.expires_at = now() + LIFETIME;
        row.view.state = "connecting".into();
        row.view.code = None;
        row.view.error = None;
        row.view.reverse_connecting = false;
        row.view.retry_after = None;
        row.relationship = core.relationship(&peer);
        row.grant_revision = core
            .devices
            .get(&peer)
            .and_then(|d| d.grant.as_ref())
            .map(|g| g.revision);
        row.reciprocal_committed = false;
        row.cancel_delivered = false;
        row.declined_at = None;
        old.view.state = "cancelled".into();
        old.view.reverse_connecting = false;
        old.cancel_delivered = false;
        let edit = core.take_id();
        let reciprocal = row.view.reciprocal;
        if reciprocal {
            core.edits.hosting = edit;
            core.edits.share_name = edit;
        }
        let first = old.clone();
        let next = row.clone();
        let saved = inner.enqueue_write(false, move |db| {
            let tx = db.transaction().map_err(|_| save_failed())?;
            persistence::outgoing(&tx, &first)?;
            persistence::outgoing(&tx, &next)?;
            if reciprocal {
                store::set_hosting(&tx, true).map_err(|_| save_failed())?;
                store::set_share_name(&tx, true).map_err(|_| save_failed())?;
            }
            tx.commit().map_err(|_| save_failed())
        });
        (old, row, edit, saved)
    };
    super::finish_write(saved)
        .await
        .map_err(|_| save_failed())?;
    let peer_to_kick = row.view.fingerprint.clone();
    {
        let mut core = inner.lock();
        core.access.cancelled.insert(old.view.request_id.clone());
        core.access
            .outgoing
            .insert(old.view.request_id.clone(), old);
        if row.view.reciprocal && core.edits.hosting == edit {
            core.settings.hosting = true;
        }
        if row.view.reciprocal && core.edits.share_name == edit {
            core.settings.share_name = true;
        }
        core.access
            .outgoing
            .insert(row.view.request_id.clone(), row);
    }
    if let Some(peer) = peer_to_kick {
        transport::kick(inner, &peer);
    }
    inner.changed();
    inner.wake.notify_one();
    Ok(())
}
