//! Live viewing bridge. Authority, sequence barriers and bounded queues stay
//! native; the renderer alone resolves projects and sanitizes opaque content.

use std::collections::{HashMap, VecDeque};
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{Emitter, State, WebviewWindow};
use tokio::sync::{oneshot, Notify};
use tokio::time::{sleep, timeout};

use super::session::{Link, Reply};
use super::store::DeviceGrant;
use super::timeline::{
    PublishedFrame, Subscription, Timelines, MAX_RESULT_BYTES, MAX_SAFE_SEQ, MAX_SUBSCRIPTIONS,
};
use super::wire::{Frame, Role, WireError};
use super::{Core, Inner, RemoteState};

const REQUEST_WAIT: Duration = Duration::from_secs(20);
const VIEWER_WAIT: Duration = Duration::from_secs(25);
const LEASE_EVERY: Duration = Duration::from_secs(5);
const TICK_EVERY: Duration = Duration::from_millis(120);
const MAX_HOST_REQUESTS: usize = 512;
const MAX_PENDING_FRAMES: usize = 64;
const MAX_VIEWER_BUFFER: usize = 64 * 1024 * 1024;

struct PendingRequest {
    link_id: u64,
    device: String,
    grant: DeviceGrant,
    op: String,
    args: Value,
    reply: Option<oneshot::Sender<Result<Value, WireError>>>,
}

struct ViewerSubscription {
    id: u64,
    link_id: u64,
    /// None until the subscribe reply establishes its exact baseline.
    baseline: Option<(String, u64)>,
    pending: bool,
    frames: VecDeque<(String, PublishedFrame, usize)>,
    bytes: usize,
}

pub(super) struct Bridge {
    pub(super) generation: u64,
    attached: bool,
    ready: bool,
    lease_waiting: bool,
    lease_misses: u8,
    lease_worker: bool,
    tick_worker: bool,
    next_tick: u64,
    tick: Option<u64>,
    signal: Arc<Notify>,
    pending: HashMap<String, PendingRequest>,
    pub(super) timelines: Timelines,
    viewers: HashMap<(String, String), ViewerSubscription>,
    viewer_bytes: usize,
}

impl Default for Bridge {
    fn default() -> Self {
        Self {
            generation: 0,
            attached: false,
            ready: false,
            lease_waiting: false,
            lease_misses: 0,
            lease_worker: false,
            tick_worker: false,
            next_tick: 0,
            tick: None,
            signal: Arc::new(Notify::new()),
            pending: HashMap::new(),
            timelines: Timelines::default(),
            viewers: HashMap::new(),
            viewer_bytes: 0,
        }
    }
}

#[derive(Serialize)]
pub(crate) struct AttachResult {
    generation: u64,
}

#[derive(Clone)]
pub(super) struct DeliveryGate {
    device: String,
    thread: String,
    generation: u64,
    revision: u64,
    epoch: String,
    terminal: Option<String>,
}

fn unavailable() -> WireError {
    WireError::new(
        "host_unavailable",
        "Mythra Code on the other device is recovering. Try again shortly.",
    )
}
fn invalid() -> WireError {
    WireError::new("unsupported", "That viewing request is not valid.")
}
fn stale() -> WireError {
    WireError::new(
        "stale_generation",
        "The other device renderer connection expired. Attach again.",
    )
}

fn emit(inner: &Inner, name: &str, value: Value) -> bool {
    #[cfg(test)]
    if let Some(result) = super::tests::emit(inner, name, &value) { return result; }
    inner
        .app
        .get()
        .is_some_and(|app| app.emit_to("main", name, value).is_ok())
}

pub(super) fn window_is_host(window: &WebviewWindow) -> Result<(), WireError> {
    if window.label() == "main" {
        Ok(())
    } else {
        Err(WireError::new(
            "forbidden",
            "Only the main application window can host conversations.",
        ))
    }
}

pub(super) fn check_generation(core: &Core, generation: u64) -> Result<(), WireError> {
    if core.bridge.attached && core.bridge.generation == generation {
        Ok(())
    } else {
        Err(stale())
    }
}

fn live_host_viewer(core: &Core) -> bool {
    core.links
        .values()
        .any(|link| link.role == Role::Host && link.is_paired() && link.is_open())
}

/// Exactly one physical link serves a logical peer/role. Losing sockets may
/// finish later, but cannot invalidate a subscription on their replacement.
pub(super) fn current_link(core: &Core, device: &str, role: Role) -> Option<Arc<Link>> {
    core.links
        .values()
        .filter(|link| {
            link.peer_fingerprint == device
                && link.role == role
                && link.is_paired()
                && link.is_open()
        })
        .max_by_key(|link| ((link.role == Role::Viewer) == link.dialed, link.id))
        .cloned()
}

pub(super) fn authorize(core: &Core, link: &Link) -> Result<DeviceGrant, WireError> {
    if link.role != Role::Host
        || !link.is_paired()
        || !link.is_open()
        || current_link(core, &link.peer_fingerprint, Role::Host)
            .is_none_or(|current| current.id != link.id)
    {
        return Err(WireError::new(
            "not_paired",
            "This viewing connection is no longer active.",
        ));
    }
    if !core.settings.hosting {
        return Err(unavailable());
    }
    let grant = core
        .devices
        .get(&link.peer_fingerprint)
        .and_then(|device| device.grant.as_ref())
        .filter(|grant| grant.view)
        .cloned()
        .ok_or_else(|| WireError::new("forbidden", "This device no longer has View access."))?;
    Ok(grant)
}

fn subscribers_changed(inner: &Inner, core: &Core, thread: &str) {
    emit(
        inner,
        "remote-host-subscribers",
        json!({
            "generation": core.bridge.generation, "threadId": thread,
            "count": core.bridge.timelines.count(thread),
        }),
    );
}

fn send_state(link: &Link, thread: &str, state: &str) {
    link.send(&Frame::Evt {
        stream: format!("thread-state:{thread}"),
        epoch: String::new(),
        seq: 0,
        data: json!({ "state": state }),
    });
}

fn remove_subscription(
    inner: &Inner,
    core: &mut Core,
    device: &str,
    thread: &str,
    state: Option<&str>,
) {
    if let Some(sub) = core
        .bridge
        .timelines
        .subscribers
        .remove(&(device.to_string(), thread.to_string()))
    {
        if let Some(state) = state {
            if let Some(link) = core.links.get(&sub.link_id) {
                send_state(link, thread, state);
            }
        }
        subscribers_changed(inner, core, thread);
        core.bridge.signal.notify_waiters();
    }
}

fn remove_viewer(core: &mut Core, key: &(String, String)) -> Option<ViewerSubscription> {
    let sub = core.bridge.viewers.remove(key)?;
    core.bridge.viewer_bytes = core.bridge.viewer_bytes.saturating_sub(sub.bytes);
    Some(sub)
}

fn viewer_state(inner: &Inner, device: &str, thread: &str, state: &str) {
    emit(
        inner,
        "remote-viewer-state",
        json!({ "device": device, "threadId": thread, "state": state }),
    );
}

/// Called under the same core lock that changes a grant or relationship. No
/// old projection survives the scope check that authorized it.
pub(super) fn retire_device_locked(inner: &Inner, core: &mut Core, device: &str) {
    super::diagnostics::record(super::diagnostics::Event::Grant,0,0,core.devices.get(device).and_then(|d|d.grant.as_ref()).map_or(0,|g|g.revision),0,"host",if core.devices.get(device).is_some_and(|d|d.grant.is_some()){"changed"}else{"revoked"});
    super::owners::retire_device(core,device);
    super::preview::retire(inner,Some(device));
    super::terminal::invalidate(core,Some(device));
    super::discovery_work::invalidate(core,Some(device));
    super::folders::invalidate(core,Some(device));
    let state = if core
        .devices
        .get(device)
        .and_then(|device| device.grant.as_ref())
        .is_some_and(|grant| grant.view)
    {
        "recovering"
    } else {
        "removed"
    };
    let threads: Vec<String> = core
        .bridge
        .timelines
        .subscribers
        .keys()
        .filter(|(peer, _)| peer == device)
        .map(|(_, thread)| thread.clone())
        .collect();
    for thread in threads {
        remove_subscription(inner, core, device, &thread, Some(state));
    }
    let requests: Vec<String> = core
        .bridge
        .pending
        .iter()
        .filter(|(_, pending)| pending.device == device)
        .map(|(id, _)| id.clone())
        .collect();
    for id in requests {
        if let Some(pending) = core.bridge.pending.remove(&id) {
            if let Some(reply) = pending.reply {
                let _ = reply.send(Err(WireError::new(
                    "forbidden",
                    "The access settings changed. Open the conversation again.",
                )));
            }
        }
    }
}

pub(super) fn forget_viewer_locked(inner: &Inner, core: &mut Core, device: &str) {
    let keys: Vec<_> = core
        .bridge
        .viewers
        .keys()
        .filter(|(peer, _)| peer == device)
        .cloned()
        .collect();
    for key in keys {
        remove_viewer(core, &key);
        viewer_state(inner, &key.0, &key.1, "removed");
    }
}

fn end_generation(inner: &Inner, core: &mut Core) {
    super::diagnostics::record(super::diagnostics::Event::Lease,0,0,core.bridge.generation,0,"host","expired");
    super::preview::retire(inner,None);
    super::terminal::invalidate(core,None);
    super::owners::invalidate(core);
    super::discovery_work::invalidate(core,None);
    super::work::generation_ended(core);
    super::folders::invalidate(core,None);
    core.bridge.ready = false;
    core.bridge.attached = false;
    core.bridge.tick = None;
    let keys: Vec<_> = core.bridge.timelines.subscribers.keys().cloned().collect();
    for (device, thread) in keys {
        remove_subscription(inner, core, &device, &thread, Some("recovering"));
    }
    for (_, pending) in core.bridge.pending.drain() {
        if let Some(reply) = pending.reply {
            let _ = reply.send(Err(unavailable()));
        }
    }
    core.bridge.timelines = Timelines::default();
    core.bridge.signal.notify_waiters();
}

pub(super) fn hosting_stopped_locked(inner: &Inner, core: &mut Core) {
    super::terminal::invalidate(core,None);
    super::folders::invalidate(core,None);
    let keys: Vec<_> = core.bridge.timelines.subscribers.keys().cloned().collect();
    for (device, thread) in keys {
        remove_subscription(inner, core, &device, &thread, Some("recovering"));
    }
    for (_, request) in core.bridge.pending.drain() {
        if let Some(reply) = request.reply {
            let _ = reply.send(Err(unavailable()));
        }
    }
    core.bridge.signal.notify_waiters();
}

pub(super) fn shutdown_locked(inner: &Inner, core: &mut Core) {
    end_generation(inner, core);
}

/// This hook runs when authenticated links change, never on an idle schedule.
pub(super) fn refresh(inner: &Arc<Inner>) {
    let (lease, tick) = {
        let mut core = inner.lock();
        let active = live_host_viewer(&core);
        let lease = active && !core.bridge.lease_worker;
        let tick = core.bridge.ready
            && !core.bridge.timelines.subscribers.is_empty()
            && !core.bridge.tick_worker;
        if lease {
            core.bridge.lease_worker = true;
            core.bridge.lease_waiting = false;
            core.bridge.lease_misses = 0;
        }
        if tick {
            core.bridge.tick_worker = true;
        }
        // Rebind logical subscriptions before a losing link's close can run.
        let hosts: Vec<_> = core.bridge.timelines.subscribers.keys().cloned().collect();
        for key in hosts {
            if let Some(link) = current_link(&core, &key.0, Role::Host) {
                if let Some(sub) = core.bridge.timelines.subscribers.get_mut(&key) {
                    sub.link_id = link.id;
                }
            }
        }
        let viewers: Vec<_> = core.bridge.viewers.keys().cloned().collect();
        for key in viewers {
            if let Some(link) = current_link(&core, &key.0, Role::Viewer) {
                if let Some(sub) = core.bridge.viewers.get_mut(&key) {
                    sub.link_id = link.id;
                }
            }
        }
        core.bridge.signal.notify_waiters();
        (lease, tick)
    };
    if lease {
        tauri::async_runtime::spawn(lease_loop(inner.clone()));
    }
    if tick {
        tauri::async_runtime::spawn(tick_loop(inner.clone()));
    }
}

async fn lease_loop(inner: Arc<Inner>) {
    loop {
        let signal = {
            let mut core = inner.lock();
            if inner.exiting.load(std::sync::atomic::Ordering::Acquire) || !live_host_viewer(&core)
            {
                core.bridge.lease_worker = false;
                core.bridge.lease_waiting = false;
                core.bridge.lease_misses = 0;
                return;
            }
            core.bridge.signal.clone()
        };
        // Notifications only wake lifecycle checks, never reset the deadline.
        let wait = sleep(LEASE_EVERY);
        tokio::pin!(wait);
        loop {
            tokio::select! {
                _ = &mut wait => break,
                _ = signal.notified() => {
                    let mut core = inner.lock();
                    if !live_host_viewer(&core) || inner.exiting.load(std::sync::atomic::Ordering::Acquire) {
                        core.bridge.lease_worker = false;
                        core.bridge.lease_waiting = false;
                        core.bridge.lease_misses = 0;
                        return;
                    }
                }
            }
        }
        let mut core = inner.lock();
        if !live_host_viewer(&core) {
            continue;
        }
        if core.bridge.lease_waiting {
            core.bridge.lease_misses = core.bridge.lease_misses.saturating_add(1);
        }
        if core.bridge.lease_misses >= 3 && core.bridge.attached {
            end_generation(&inner, &mut core);
        }
        core.bridge.lease_waiting = true;
        emit(
            &inner,
            "remote-host-lease-check",
            json!({ "generation": core.bridge.generation }),
        );
    }
}

async fn tick_loop(inner: Arc<Inner>) {
    loop {
        let signal = {
            let mut core = inner.lock();
            if !core.bridge.ready
                || core.bridge.timelines.subscribers.is_empty()
                || inner.exiting.load(std::sync::atomic::Ordering::Acquire)
            {
                core.bridge.tick_worker = false;
                core.bridge.tick = None;
                return;
            }
            core.bridge.signal.clone()
        };
        let wait = sleep(TICK_EVERY);
        tokio::pin!(wait);
        loop {
            tokio::select! {
                _ = &mut wait => break,
                _ = signal.notified() => {
                    let mut core = inner.lock();
                    if !core.bridge.ready || core.bridge.timelines.subscribers.is_empty() || inner.exiting.load(std::sync::atomic::Ordering::Acquire) {
                        core.bridge.tick_worker = false;
                        core.bridge.tick = None;
                        return;
                    }
                }
            }
        }
        let mut core = inner.lock();
        if !core.bridge.ready || core.bridge.timelines.subscribers.is_empty() {
            continue;
        }
        if core.bridge.tick.is_none() {
            core.bridge.next_tick = core.bridge.next_tick.saturating_add(1);
            let tick = core.bridge.next_tick;
            core.bridge.tick = Some(tick);
            if !emit(
                &inner,
                "remote-host-tick",
                json!({ "generation": core.bridge.generation, "tickId": tick }),
            ) {
                end_generation(&inner, &mut core);
            }
        }
    }
}

/// The writer calls this immediately before a queued stream frame is written.
pub(super) fn delivery_allowed(inner: &Inner, link: &Link, gate: &DeliveryGate) -> bool {
    let core = inner.lock();
    if let Some(id)=&gate.terminal{return super::terminal::allowed(&core,link,id);}
    core.bridge.ready
        && check_generation(&core, gate.generation).is_ok()
        && authorize(&core, link).is_ok_and(|grant| grant.revision == gate.revision)
        && core
            .bridge
            .timelines
            .subscribers
            .get(&(gate.device.clone(), gate.thread.clone()))
            .is_some_and(|sub| {
                sub.link_id == link.id && sub.epoch == gate.epoch && sub.revision == gate.revision
            })
}

fn deliver(
    inner: &Inner,
    core: &mut Core,
    device: &str,
    thread: &str,
    item: &PublishedFrame,
) -> bool {
    let key = (device.to_string(), thread.to_string());
    let Some(sub) = core.bridge.timelines.subscribers.get(&key).cloned() else {
        return false;
    };
    if item.seq <= sub.seq {
        return true;
    }
    let link = core.links.get(&sub.link_id).cloned();
    let allowed = link.as_ref().is_some_and(|link| {
        authorize(core, link).is_ok_and(|grant| grant.revision == sub.revision)
    });
    if !allowed || !core.bridge.ready || sub.generation != core.bridge.generation {
        remove_subscription(inner, core, device, thread, Some("removed"));
        return false;
    }
    if sub.seq.checked_add(1) != Some(item.seq) {
        remove_subscription(inner, core, device, thread, Some("recovering"));
        return false;
    }
    let Some(link) = link else {
        return false;
    };
    let frame = Frame::Evt {
        stream: format!("thread:{thread}"),
        epoch: sub.epoch.clone(),
        seq: item.seq,
        data: item.frame.clone(),
    };
    let gate = DeliveryGate {
        device: device.to_string(),
        thread: thread.to_string(),
        generation: sub.generation,
        revision: sub.revision,
        epoch: sub.epoch,
        terminal: None,
    };
    if !link.send_stream(&frame, gate) {
        remove_subscription(inner, core, device, thread, Some("recovering"));
        return false;
    }
    if let Some(sub) = core.bridge.timelines.subscribers.get_mut(&key) {
        sub.seq = item.seq;
    }
    true
}

pub(super) fn link_closed(inner: &Arc<Inner>, link: &Link) {
    super::preview::link_closed(inner,link);
    let mut core = inner.lock();
    let replacement = current_link(&core, &link.peer_fingerprint, link.role);
    if replacement.is_none()&&link.role==Role::Host{super::terminal::disconnected(&mut core,&link.peer_fingerprint);super::folders::invalidate(&mut core,Some(&link.peer_fingerprint));}
    let keys: Vec<_> = core
        .bridge
        .timelines
        .subscribers
        .iter()
        .filter(|(_, sub)| sub.link_id == link.id)
        .map(|(key, _)| key.clone())
        .collect();
    for (device, thread) in keys {
        if let Some(replacement) = &replacement {
            if let Some(sub) = core.bridge.timelines.subscribers.get_mut(&(device, thread)) {
                sub.link_id = replacement.id;
            }
        } else {
            remove_subscription(inner, &mut core, &device, &thread, None);
        }
    }
    let viewers: Vec<_> = core
        .bridge
        .viewers
        .iter()
        .filter(|(_, sub)| sub.link_id == link.id)
        .map(|(key, _)| key.clone())
        .collect();
    for key in viewers {
        if let Some(replacement) = &replacement {
            if let Some(sub) = core.bridge.viewers.get_mut(&key) {
                sub.link_id = replacement.id;
            }
        } else {
            remove_viewer(&mut core, &key);
            viewer_state(inner, &key.0, &key.1, "stale");
        }
    }
    let pending: Vec<_> = core
        .bridge
        .pending
        .iter()
        .filter(|(_, request)| request.link_id == link.id)
        .map(|(id, _)| id.clone())
        .collect();
    for id in pending {
        if let Some(request) = core.bridge.pending.remove(&id) {
            if let Some(reply) = request.reply {
                let _ = reply.send(Err(unavailable()));
            }
        }
    }
    core.bridge.signal.notify_waiters();
}

fn text(value: &Value, key: &str, required: bool, max: usize) -> Result<Option<String>, WireError> {
    match value.get(key) {
        None if !required => Ok(None),
        Some(Value::String(text))
            if !text.is_empty() && text.len() <= max && !text.chars().any(char::is_control) =>
        {
            Ok(Some(text.clone()))
        }
        _ => Err(invalid()),
    }
}
fn thread_id(args: &Value) -> Result<String, WireError> {
    text(args, "threadId", true, 512)?.ok_or_else(invalid)
}
fn epoch_is_valid(epoch: &str) -> bool {
    uuid::Uuid::parse_str(epoch).is_ok()
}

fn validate_args(op: &str, args: Value) -> Result<Value, WireError> {
    let args = if args.is_null() { json!({}) } else { args };
    if super::manifest::validate(op,&args)?{return Ok(args);}
    if super::work::is_mutation(op) { super::work::validate_args(op, &args)?; return Ok(args); }
    let fields: &[&str] = match op {
        "workspaces.list" | "host.info" => &[],
        "op.status" => &["opId", "opSeq"],
        "work.inspect" => &["threadId"],
        "threads.list" => &["workspaceId", "cursor", "limit"],
        "timeline.read" => &["threadId", "before", "limit"],
        "timeline.subscribe" => &["threadId", "epoch", "afterSeq"],
        "timeline.unsubscribe" => &["threadId"],
        _ => {
            return Err(WireError::new(
                "unsupported",
                "This operation is not available for remote viewing.",
            ))
        }
    };
    let object = args.as_object().ok_or_else(invalid)?;
    if object.keys().any(|key| !fields.contains(&key.as_str())) {
        return Err(invalid());
    }
    if op == "work.inspect" { thread_id(&args)?; }
    if op == "op.status" {
        text(&args, "opId", true, 256)?;
        if !args.get("opSeq").and_then(Value::as_u64).is_some_and(|seq|seq>0&&seq<=MAX_SAFE_SEQ) { return Err(invalid()); }
    }
    if op == "threads.list" {
        text(&args, "workspaceId", true, 512)?;
        text(&args, "cursor", false, 4096)?;
    }
    if op.starts_with("timeline.") {
        thread_id(&args)?;
    }
    if op == "timeline.read" {
        text(&args, "before", false, 4096)?;
    }
    if let Some(limit) = args.get("limit") {
        if !limit
            .as_u64()
            .is_some_and(|limit| (1..=200).contains(&limit))
        {
            return Err(invalid());
        }
    }
    if op == "timeline.subscribe" {
        let epoch = text(&args, "epoch", false, 64)?;
        if epoch.as_ref().is_some_and(|epoch| !epoch_is_valid(epoch)) {
            return Err(invalid());
        }
        if let Some(seq) = args.get("afterSeq") {
            if epoch.is_none() || !seq.as_u64().is_some_and(|seq| seq <= MAX_SAFE_SEQ) {
                return Err(invalid());
            }
        }
    }
    Ok(args)
}

fn cancel_thread_requests(core: &mut Core, device: &str, thread: &str) {
    let ids: Vec<_> = core
        .bridge
        .pending
        .iter()
        .filter(|(_, request)| {
            request.device == device
                && request.op == "timeline.subscribe"
                && request.args.get("threadId").and_then(Value::as_str) == Some(thread)
        })
        .map(|(id, _)| id.clone())
        .collect();
    for id in ids {
        if let Some(request) = core.bridge.pending.remove(&id) {
            if let Some(reply) = request.reply {
                let _ = reply.send(Err(WireError::new(
                    "stale_target",
                    "This conversation is no longer being watched.",
                )));
            }
        }
    }
}

/// The subscribe response and its native registration share one core-lock
/// barrier with publish. Queue the response here, before any later stream event.
pub(super) async fn handle_request(
    inner: &Arc<Inner>,
    link: &Arc<Link>,
    wire_id: u64,
    op: &str,
    args: Value,
) -> Reply {
    let outcome = request_host(inner, link, wire_id, op, args).await;
    match outcome {
        Ok(()) => Reply::Sent,
        Err(error) => Reply::Done(Err(error)),
    }
}

async fn request_host(
    inner: &Arc<Inner>,
    link: &Arc<Link>,
    wire_id: u64,
    op: &str,
    args: Value,
) -> Result<(), WireError> {
    let mut args = validate_args(op, args)?;
    let (request_id, receiver, generation) = {
        let mut core = inner.lock();
        let grant = authorize(&core, link)?;
        if op == "timeline.unsubscribe" {
            let thread = thread_id(&args)?;
            cancel_thread_requests(&mut core, &link.peer_fingerprint, &thread);
            remove_subscription(inner, &mut core, &link.peer_fingerprint, &thread, None);
            link.respond(wire_id, Ok(json!({})));
            return Ok(());
        }
        if !core.bridge.ready || !core.bridge.attached {
            return Err(unavailable());
        }
        if core.bridge.pending.len() >= MAX_HOST_REQUESTS {
            return Err(WireError::new("busy", "Too many requests are waiting."));
        }
        if op == "timeline.subscribe" {
            let thread = thread_id(&args)?;
            let existing = core
                .bridge
                .timelines
                .subscribers
                .contains_key(&(link.peer_fingerprint.clone(), thread.clone()));
            let pending = core
                .bridge
                .pending
                .values()
                .filter(|request| {
                    request.device == link.peer_fingerprint && request.op == "timeline.subscribe"
                })
                .count();
            if core.bridge.pending.values().any(|request| {
                request.device == link.peer_fingerprint
                    && request.op == "timeline.subscribe"
                    && request.args.get("threadId").and_then(Value::as_str) == Some(&thread)
            }) {
                return Err(WireError::new(
                    "busy",
                    "That conversation is already opening.",
                ));
            }
            if !existing
                && core.bridge.timelines.device_count(&link.peer_fingerprint) + pending
                    >= MAX_SUBSCRIPTIONS
            {
                return Err(WireError::new(
                    "busy",
                    "Too many conversations are being watched on this device.",
                ));
            }
            let covered = match (
                args.get("epoch").and_then(Value::as_str),
                args.get("afterSeq").and_then(Value::as_u64),
            ) {
                (Some(epoch), Some(seq)) => core.bridge.timelines.can_replay(&thread, epoch, seq),
                _ => false,
            };
            args.as_object_mut()
                .ok_or_else(invalid)?
                .insert("needSnapshot".into(), json!(!covered));
        }
        let request_id = uuid::Uuid::new_v4().to_string();
        let generation = core.bridge.generation;
        let (sender, receiver) = oneshot::channel();
        core.bridge.pending.insert(
            request_id.clone(),
            PendingRequest {
                device: link.peer_fingerprint.clone(),
                link_id: link.id,
                grant: grant.clone(),
                op: op.to_string(),
                args: args.clone(),
                reply: Some(sender),
            },
        );
        if !emit(
            inner,
            "remote-host-request",
            json!({ "requestId": request_id, "generation": generation, "device": link.peer_fingerprint, "grant": grant, "op": op, "args": args }),
        ) {
            core.bridge.pending.remove(&request_id);
            return Err(unavailable());
        }
        (request_id, receiver, generation)
    };
    let response = match timeout(REQUEST_WAIT, receiver).await {
        Ok(Ok(response)) => response,
        _ => Err(unavailable()),
    };
    let mut core = inner.lock();
    let Some(pending) = core.bridge.pending.remove(&request_id) else {
        return Err(response.err().unwrap_or_else(unavailable));
    };
    check_generation(&core, generation).map_err(|_| unavailable())?;
    let grant = authorize(&core, link)?;
    if !core.bridge.ready {
        return Err(unavailable());
    }
    if grant.revision != pending.grant.revision {
        return Err(WireError::new(
            "forbidden",
            "The access settings changed. Open the conversation again.",
        ));
    }
    let mut result = response?;
    if serde_json::to_vec(&result).map_err(|_| invalid())?.len() > MAX_RESULT_BYTES {
        return Err(WireError::new("busy", "That history window is too large."));
    }
    if op != "timeline.subscribe" {
        link.respond(wire_id, Ok(result));
        return Ok(());
    }
    let thread = thread_id(&pending.args)?;
    let epoch = text(&result, "epoch", true, 64)?.ok_or_else(invalid)?;
    let seq = result
        .get("seq")
        .and_then(Value::as_u64)
        .filter(|seq| *seq <= MAX_SAFE_SEQ)
        .ok_or_else(invalid)?;
    if !epoch_is_valid(&epoch) {
        return Err(invalid());
    }
    let snapshot = result
        .get("snapshot")
        .is_some_and(|snapshot| !snapshot.is_null());
    let replay = if snapshot {
        Vec::new()
    } else {
        let previous_epoch = pending
            .args
            .get("epoch")
            .and_then(Value::as_str)
            .ok_or_else(invalid)?;
        let after = pending
            .args
            .get("afterSeq")
            .and_then(Value::as_u64)
            .ok_or_else(invalid)?;
        if previous_epoch != epoch
            || pending.args.get("needSnapshot").and_then(Value::as_bool) != Some(false)
        {
            return Err(invalid());
        }
        core.bridge
            .timelines
            .replay(&thread, &epoch, after, seq)
            .ok_or_else(|| {
                WireError::new(
                    "stale_target",
                    "The saved updates expired. Open this conversation again.",
                )
            })?
    };
    core.bridge.timelines.baseline(&thread, &epoch, seq)?;
    let latest = core
        .bridge
        .timelines
        .rings
        .get(&thread)
        .map_or(seq, |ring| ring.seq);
    let catchup = core
        .bridge
        .timelines
        .replay(&thread, &epoch, seq, latest)
        .ok_or_else(|| {
            WireError::new(
                "stale_target",
                "The conversation changed while it was opening. Open it again.",
            )
        })?;
    if !snapshot {
        result.as_object_mut().ok_or_else(invalid)?.insert(
            "frames".into(),
            serde_json::to_value(replay).map_err(|_| invalid())?,
        );
    }
    if serde_json::to_vec(&result).map_err(|_| invalid())?.len() > MAX_RESULT_BYTES {
        return Err(WireError::new("busy", "That history window is too large."));
    }
    let key = (link.peer_fingerprint.clone(), thread.clone());
    let previous_count = core.bridge.timelines.count(&thread);
    core.bridge.timelines.subscribers.insert(
        key.clone(),
        Subscription {
            link_id: link.id,
            generation,
            revision: grant.revision,
            epoch,
            seq,
        },
    );
    if !link.respond(wire_id, Ok(result)) {
        remove_subscription(inner, &mut core, &key.0, &thread, None);
        return Ok(());
    }
    if core.bridge.timelines.count(&thread) != previous_count {
        subscribers_changed(inner, &core, &thread);
    }
    for frame in catchup {
        if !deliver(inner, &mut core, &key.0, &thread, &frame) {
            break;
        }
    }
    drop(core);
    refresh(inner);
    Ok(())
}

#[tauri::command]
pub(crate) fn remote_host_attach(
    state: State<'_, RemoteState>,
    window: WebviewWindow,
) -> Result<AttachResult, WireError> {
    window_is_host(&window)?;
    let inner = &state.inner;
    let mut core = inner.lock();
    end_generation(inner, &mut core);
    core.bridge.generation = core
        .bridge
        .generation
        .checked_add(1)
        .filter(|number| *number <= MAX_SAFE_SEQ)
        .ok_or_else(stale)?;
    core.bridge.attached = true;
    core.bridge.lease_waiting = false;
    core.bridge.lease_misses = 0;
    Ok(AttachResult {
        generation: core.bridge.generation,
    })
}

#[tauri::command]
pub(crate) fn remote_host_ready(
    state: State<'_, RemoteState>,
    window: WebviewWindow,
    generation: u64,
) -> Result<(), WireError> {
    window_is_host(&window)?;
    {
        let mut core = state.inner.lock();
        check_generation(&core, generation)?;
        core.bridge.ready = true;
    }
    refresh(&state.inner);
    Ok(())
}

#[tauri::command]
pub(crate) fn remote_host_renew(
    state: State<'_, RemoteState>,
    window: WebviewWindow,
    generation: u64,
) -> Result<(), WireError> {
    window_is_host(&window)?;
    renderer_renew(&state.inner, generation)
}

pub(super) fn renderer_renew(inner: &Inner, generation: u64) -> Result<(), WireError> {
    let mut core = inner.lock();
    check_generation(&core, generation)?;
    core.bridge.lease_waiting = false;
    core.bridge.lease_misses = 0;
    super::diagnostics::record(super::diagnostics::Event::Lease,0,0,generation,0,"host","ok");
    Ok(())
}

#[tauri::command]
pub(crate) fn remote_host_tick_ack(
    state: State<'_, RemoteState>,
    window: WebviewWindow,
    generation: u64,
    tick_id: u64,
) -> Result<(), WireError> {
    window_is_host(&window)?;
    let mut core = state.inner.lock();
    check_generation(&core, generation)?;
    if core.bridge.tick != Some(tick_id) {
        return Err(WireError::new(
            "stale_target",
            "That publishing tick has expired.",
        ));
    }
    core.bridge.tick = None;
    Ok(())
}

#[tauri::command]
pub(crate) fn remote_host_respond(
    state: State<'_, RemoteState>,
    window: WebviewWindow,
    generation: u64,
    request_id: String,
    result: Option<Value>,
    error: Option<WireError>,
) -> Result<(), WireError> {
    window_is_host(&window)?;
    renderer_respond(&state.inner, generation, request_id, result, error)
}
pub(super) fn renderer_respond(inner: &Inner, generation: u64, request_id: String, result: Option<Value>, error: Option<WireError>) -> Result<(), WireError> {
    let mut core = inner.lock();
    check_generation(&core, generation)?;
    if result.is_some() == error.is_some() {
        return Err(invalid());
    }
    if error
        .as_ref()
        .is_some_and(|error| error.code.len() > 64 || error.message.len() > 2048)
        || result.as_ref().is_some_and(|result| {
            serde_json::to_vec(result).map_or(true, |bytes| bytes.len() > MAX_RESULT_BYTES)
        })
    {
        return Err(invalid());
    }
    let pending = core
        .bridge
        .pending
        .get_mut(&request_id)
        .ok_or_else(|| WireError::new("stale_target", "That viewing request has expired."))?;
    let reply = pending.reply.take().ok_or_else(|| {
        WireError::new("stale_target", "That viewing request was already answered.")
    })?;
    let _ = reply.send(match error {
        Some(error) => Err(error),
        None => Ok(result.unwrap_or(Value::Null)),
    });
    Ok(())
}

#[tauri::command]
pub(crate) fn remote_host_publish(
    state: State<'_, RemoteState>,
    window: WebviewWindow,
    generation: u64,
    thread_id: String,
    epoch: String,
    frames: Vec<PublishedFrame>,
) -> Result<(), WireError> {
    window_is_host(&window)?;
    renderer_publish(&state.inner, generation, thread_id, epoch, frames)
}
pub(super) fn renderer_publish(inner: &Inner, generation: u64, thread_id: String, epoch: String, frames: Vec<PublishedFrame>) -> Result<(), WireError> {
    let mut core = inner.lock();
    check_generation(&core, generation)?;
    if thread_id.is_empty() || thread_id.len() > 512 || !epoch_is_valid(&epoch) {
        return Err(invalid());
    }
    let delivery = frames.clone();
    core.bridge.timelines.publish(&thread_id, &epoch, frames)?;
    super::diagnostics::record(super::diagnostics::Event::Publish,0,0,delivery.last().map_or(0,|f|f.seq),delivery.len(),"host","ok");
    let devices: Vec<String> = core
        .bridge
        .timelines
        .subscribers
        .keys()
        .filter(|(_, thread)| thread == &thread_id)
        .map(|(device, _)| device.clone())
        .collect();
    for device in devices {
        for item in &delivery {
            if !deliver(inner, &mut core, &device, &thread_id, item) {
                break;
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub(crate) fn remote_host_thread_retired(
    state: State<'_, RemoteState>,
    window: WebviewWindow,
    generation: u64,
    thread_id: String,
) -> Result<(), WireError> {
    window_is_host(&window)?;
    let mut core = state.inner.lock();
    check_generation(&core, generation)?;
    if core.bridge.timelines.count(&thread_id) != 0
        || core.bridge.pending.values().any(|request| {
            request.op == "timeline.subscribe"
                && request.args.get("threadId").and_then(Value::as_str) == Some(&thread_id)
        })
    {
        return Err(WireError::new(
            "busy",
            "That conversation is still being watched.",
        ));
    }
    core.bridge.timelines.retire(&thread_id);
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SubscribeReply {
    epoch: String,
    seq: u64,
}

/// Main-window viewer requests; only typed Phase 2 reads are exposed here.
#[tauri::command]
pub(crate) async fn remote_request(
    state: State<'_, RemoteState>,
    window: WebviewWindow,
    device: String,
    op: String,
    args: Value,
) -> Result<Value, WireError> {
    window_is_host(&window)?;
    viewer_request(&state.inner, device, op, args).await
}
pub(super) async fn viewer_request(inner: &Arc<Inner>, device: String, op: String, args: Value) -> Result<Value, WireError> {
    if !super::identity::fingerprint_is_valid(&device) {
        return Err(invalid());
    }
    let args = validate_args(&op, args)?;
    let inner = inner.clone();
    let thread = if op.starts_with("timeline.") {
        Some(thread_id(&args)?)
    } else {
        None
    };
    let (link, subscription_id) = {
        let mut core = inner.lock();
        let allowed = core
            .devices
            .get(&device)
            .is_some_and(|record| record.they_host && !record.access_removed);
        if !allowed {
            return Err(WireError::new(
                "forbidden",
                "This device no longer has access to that computer.",
            ));
        }
        let link = current_link(&core, &device, Role::Viewer).ok_or_else(unavailable)?;
        let mut id = None;
        if let Some(thread) = &thread {
            let key = (device.clone(), thread.clone());
            if op == "timeline.subscribe" {
                if core.bridge.viewers.get(&key).is_some_and(|sub| sub.pending) {
                    return Err(WireError::new(
                        "busy",
                        "That conversation is already opening.",
                    ));
                }
                if !core.bridge.viewers.contains_key(&key)
                    && core
                        .bridge
                        .viewers
                        .keys()
                        .filter(|(peer, _)| peer == &device)
                        .count()
                        >= MAX_SUBSCRIPTIONS
                {
                    return Err(WireError::new(
                        "busy",
                        "Too many conversations are being watched on this device.",
                    ));
                }
                remove_viewer(&mut core, &key);
                let next = core.take_id();
                core.bridge.viewers.insert(
                    key,
                    ViewerSubscription {
                        id: next,
                        link_id: link.id,
                        baseline: None,
                        pending: true,
                        frames: VecDeque::new(),
                        bytes: 0,
                    },
                );
                id = Some(next);
            } else if op == "timeline.unsubscribe" {
                remove_viewer(&mut core, &key);
            }
        }
        (link, id)
    };
    let response = link
        .request(&op, args, VIEWER_WAIT)
        .await
        .and_then(|value| {
            if serde_json::to_vec(&value).map_or(true, |bytes| bytes.len() > MAX_RESULT_BYTES) {
                Err(WireError::new("busy", "That history window is too large."))
            } else {
                Ok(value)
            }
        });
    if op == "work.inspect" {
        let core = inner.lock();
        if current_link(&core, &device, Role::Viewer).is_none_or(|current| current.id != link.id) {
            return Err(unavailable());
        }
        return response.map_err(|mut error| {
            // 1.32.0 first requires View and then uses this manifest refusal
            // only when Work is off. Match the exact reply on this peer link.
            if link.peer_version == "1.32.0"
                && error.code == "forbidden"
                && error.message == "This device doesn't have that access. To change it, open Settings → Connections → Devices on the other device."
            {
                error.code = "work_disabled".into();
            }
            error
        });
    }
    if let (Some(thread), Some(id)) = (thread, subscription_id) {
        let key = (device.clone(), thread.clone());
        let mut core = inner.lock();
        if !core
            .bridge
            .viewers
            .get(&key)
            .is_some_and(|sub| sub.id == id)
        {
            return Err(unavailable());
        }
        let value = match response {
            Ok(value) => value,
            Err(error) => {
                remove_viewer(&mut core, &key);
                viewer_state(
                    &inner,
                    &device,
                    &thread,
                    if error.code == "forbidden" {
                        "removed"
                    } else {
                        "recovering"
                    },
                );
                return Err(error);
            }
        };
        let parsed: SubscribeReply = match serde_json::from_value(value.clone()) {
            Ok(parsed) => parsed,
            Err(_) => {
                remove_viewer(&mut core, &key);
                return Err(invalid());
            }
        };
        if !epoch_is_valid(&parsed.epoch) || parsed.seq > MAX_SAFE_SEQ {
            remove_viewer(&mut core, &key);
            return Err(invalid());
        }
        let buffered = {
            let sub = core.bridge.viewers.get_mut(&key).ok_or_else(unavailable)?;
            sub.pending = false;
            sub.baseline = Some((parsed.epoch, parsed.seq));
            sub.bytes = 0;
            std::mem::take(&mut sub.frames)
        };
        core.bridge.viewer_bytes = core
            .bridge
            .viewer_bytes
            .saturating_sub(buffered.iter().map(|(_, _, bytes)| bytes).sum::<usize>());
        viewer_state(&inner, &device, &thread, "live");
        if let Some(current) = current_link(&core, &device, Role::Viewer) {
            for (epoch, frame, _) in buffered {
                accept_viewer_frame(&inner, &mut core, &current, &thread, epoch, frame);
            }
        }
        return Ok(value);
    }
    response
}

fn accept_viewer_frame(
    inner: &Inner,
    core: &mut Core,
    link: &Link,
    thread: &str,
    epoch: String,
    item: PublishedFrame,
) {
    let key = (link.peer_fingerprint.clone(), thread.to_string());
    if !core
        .bridge
        .viewers
        .get(&key)
        .is_some_and(|sub| sub.link_id == link.id)
    {
        return;
    }
    let bytes = serde_json::to_vec(&item.frame).map_or(MAX_RESULT_BYTES + 1, |bytes| bytes.len());
    if bytes > MAX_RESULT_BYTES {
        remove_viewer(core, &key);
        viewer_state(inner, &key.0, thread, "recovering");
        return;
    }
    let Some(sub) = core.bridge.viewers.get_mut(&key) else {
        return;
    };
    if sub.link_id != link.id {
        return;
    }
    if let Some((expected_epoch, after)) = &mut sub.baseline {
        if expected_epoch == &epoch && item.seq <= *after {
            return;
        }
        if expected_epoch != &epoch || after.checked_add(1) != Some(item.seq) {
            remove_viewer(core, &key);
            viewer_state(inner, &key.0, thread, "recovering");
            return;
        }
        *after = item.seq;
        emit(
            inner,
            "remote-viewer-frame",
            json!({ "device": key.0, "threadId": thread, "epoch": epoch, "seq": item.seq, "frame": item.frame }),
        );
    } else {
        if sub.frames.len() >= MAX_PENDING_FRAMES
            || sub.bytes.saturating_add(bytes) > MAX_RESULT_BYTES * 2
            || core.bridge.viewer_bytes.saturating_add(bytes) > MAX_VIEWER_BUFFER
        {
            remove_viewer(core, &key);
            viewer_state(inner, &key.0, thread, "recovering");
            return;
        }
        sub.bytes += bytes;
        core.bridge.viewer_bytes += bytes;
        sub.frames.push_back((epoch, item, bytes));
    }
}

pub(super) fn receive_event(
    inner: &Inner,
    link: &Link,
    stream: String,
    epoch: String,
    seq: u64,
    data: Value,
) {
    if let Some(id)=stream.strip_prefix("terminal:") {
        let core=inner.lock();let valid=link.role==Role::Viewer&&link.is_paired()&&current_link(&core,&link.peer_fingerprint,Role::Viewer).is_some_and(|current|current.id==link.id)&&core.devices.get(&link.peer_fingerprint).is_some_and(|d|d.they_host&&!d.access_removed);
        if valid&&id.len()<=512&&seq<=MAX_SAFE_SEQ&&serde_json::to_vec(&data).is_ok_and(|b|b.len()<=128*1024){emit(inner,"remote-terminal-output",json!({"device":link.peer_fingerprint,"terminalId":id,"seq":seq,"data":data}));}return;
    }
    let mut core = inner.lock();
    if link.role != Role::Viewer
        || !link.is_paired()
        || !link.is_open()
        || current_link(&core, &link.peer_fingerprint, Role::Viewer)
            .is_none_or(|current| current.id != link.id)
        || !core
            .devices
            .get(&link.peer_fingerprint)
            .is_some_and(|record| record.they_host && !record.access_removed)
    {
        return;
    }
    if let Some(thread) = stream.strip_prefix("thread-state:") {
        if thread.is_empty() || thread.len() > 512 {
            return;
        }
        let key = (link.peer_fingerprint.clone(), thread.to_string());
        if !core
            .bridge
            .viewers
            .get(&key)
            .is_some_and(|sub| sub.link_id == link.id)
        {
            return;
        }
        if let Some(state) = data
            .get("state")
            .and_then(Value::as_str)
            .filter(|state| ["live", "recovering", "stale", "removed"].contains(state))
        {
            if state != "live" {
                remove_viewer(&mut core, &key);
            }
            viewer_state(inner, &key.0, thread, state);
        }
    } else if let Some(thread) = stream.strip_prefix("thread:") {
        if thread.len() > 512 || !epoch_is_valid(&epoch) || seq > MAX_SAFE_SEQ {
            return;
        }
        accept_viewer_frame(
            inner,
            &mut core,
            link,
            thread,
            epoch,
            PublishedFrame { seq, frame: data },
        );
    }
}

/// Opaque bounded non-stream request. Native mutation admission happens before
/// this bridge; provider delivery is separately fenced at its native boundary.
pub(super) async fn request_value(inner:&Arc<Inner>,link:&Arc<Link>,op:&str,args:Value,identity:Option<(&str,u64)>)->Result<Value,WireError>{
    let args=validate_args(op,args)?;
    let context_target = (op == "host.context" && args["workspaceId"] != "openkiwi-normal-chats").then(|| args.clone());
    let (id,generation,receiver)={let mut core=inner.lock();let grant=authorize(&core,link)?;super::manifest::access(op,&grant)?;
        if !core.bridge.ready || !core.bridge.attached {return Err(unavailable());}
        if super::work::is_mutation(op)&&!grant.work {return Err(WireError::new("forbidden","Work is off for this device. To turn it on, open Settings → Connections → Devices on the other device."));}
        if core.bridge.pending.len()>=MAX_HOST_REQUESTS{return Err(WireError::new("busy","Too many requests are waiting."));}
        let id=uuid::Uuid::new_v4().to_string();let generation=core.bridge.generation;let(sender,receiver)=oneshot::channel();
        core.bridge.pending.insert(id.clone(),PendingRequest{link_id:link.id,device:link.peer_fingerprint.clone(),grant:grant.clone(),op:op.to_owned(),args:args.clone(),reply:Some(sender)});
        let mut args=args;
        if let Some(handle)=args.as_object_mut().and_then(|object|object.remove("handle")){args["target"]=handle;}
        let mut payload=json!({"requestId":id,"generation":generation,"device":link.peer_fingerprint,"grant":grant,"op":op,"args":args});
        if let Some((op_id,op_seq))=identity{payload["opId"]=json!(op_id);payload["opSeq"]=json!(op_seq);}
        if !emit(inner,"remote-host-request",payload){core.bridge.pending.remove(&id);return Err(unavailable());}(id,generation,receiver)};
    let result=match timeout(REQUEST_WAIT,receiver).await{Ok(Ok(value))=>value,_=>Err(unavailable())};
    // Only host-owned persisted targets supply these display paths. No new
    // path input or file-content authority is introduced by header metadata.
    let result = if let (Some(target), Ok(mut value)) = (context_target, result.clone()) {
        let workspace = target["workspaceId"].as_str().ok_or_else(invalid)?.to_owned();
        let thread = target["threadId"].as_str().map(str::to_owned);
        let header = inner.read_db(move |db| super::host_context::header(db, &workspace, thread.as_deref())).await;
        match header {
            Ok(header) => { value.as_object_mut().ok_or_else(invalid)?.insert("header".into(), header); Ok(value) },
            Err(_) => Err(WireError::new("stale_target", "This host execution folder changed. Refresh the conversation.")),
        }
    } else { result };
    let mut core=inner.lock();let Some(pending)=core.bridge.pending.remove(&id)else{return Err(result.err().unwrap_or_else(unavailable));};
    check_generation(&core,generation)?;let grant=authorize(&core,link)?;super::manifest::access(op,&grant)?;
    if !core.bridge.ready||grant.revision!=pending.grant.revision{return Err(unavailable());}
    let result=result?;if serde_json::to_vec(&result).map_or(true,|bytes|bytes.len()>MAX_RESULT_BYTES){return Err(invalid());}Ok(result)
}

#[cfg(test)]
pub(super) fn test_attach(inner: &Inner, generation: u64) {
    let mut core = inner.lock();
    core.bridge.generation = generation;
    core.bridge.attached = true;
    core.bridge.ready = true;
}

pub(super) fn terminal_gate(stamp:&super::commit::Stamp,id:&str)->DeliveryGate{DeliveryGate{device:stamp.device.clone(),thread:String::new(),generation:stamp.generation,revision:stamp.grant_revision,epoch:String::new(),terminal:Some(id.to_owned())}}
