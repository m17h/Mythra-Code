//! Links: one authenticated TLS connection between two devices. The dial
//! direction and the application role are independent. After `hello`, either
//! direction can carry host or viewer behavior, which is what reverse links use.
//!
//! Every wait here is bounded, every queue has a limit, and authorization always
//! comes from the key TLS proved, never from anything in a message.

use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Weak, Mutex as StdMutex, PoisonError};
use std::time::Duration;

use serde::Deserialize;
use serde_json::{json, Value};
use tokio::io::{AsyncRead, AsyncWrite, AsyncWriteExt, ReadHalf, WriteHalf};
use tokio::net::TcpStream;
use tokio::sync::{mpsc, oneshot, watch, OwnedSemaphorePermit, Semaphore};
use tokio::time::{interval, timeout, Instant, MissedTickBehavior};
use tokio_rustls::{TlsAcceptor, TlsConnector};

use super::discovery::types::canonical_socket;
use super::identity::{fingerprint_of, DeviceIdentity};
use super::store;
use super::tls::{self, ServerKeyPolicy};
use super::wire::{
    self, clean_name, decode, encode, platform_name, read_frame, Decoded, Frame, Hello,
    HelloExtras, Refusal, Role, WireError, MAX_FRAME, PREAUTH_MAX_FRAME, PROTO,
};
use super::{pairing, Core, DialState, Inner};

const HANDSHAKE_LIMIT: Duration = Duration::from_secs(10);
const CONNECT_LIMIT: Duration = Duration::from_secs(5);
const WRITE_LIMIT: Duration = Duration::from_secs(10);
const KEEPALIVE_EVERY: Duration = Duration::from_secs(5);
const VIEWER_SILENCE_LIMIT: Duration = Duration::from_secs(15);
// Host-side tolerance stays longer for a slow viewer; the interactive viewer
// must stop offering a seemingly live session after three missed heartbeats.
const LINK_DEAD_AFTER: Duration = Duration::from_secs(45);
const SHUTDOWN_LIMIT: Duration = Duration::from_secs(1);
/// An unpaired peer has this long after `hello` to begin pairing.
const UNPAIRED_IDLE_LIMIT: Duration = Duration::from_secs(10);
/// Longest any unpaired link may live, even mid-pairing.
const UNPAIRED_LIFETIME: Duration = Duration::from_secs(5 * 60 + 30);
const UNPAIRED_FRAME_BUDGET: u32 = 256;
const OUTGOING_QUEUE: usize = 256;
/// Stream output cannot consume the slots needed for replies and recovery.
const STREAM_CONTROL_RESERVE: usize = 64;
const MAX_PENDING_REQUESTS: usize = 32;
const REQUEST_SLOTS: usize = 32;
const MAX_OP_ID_BYTES: usize = 128;
const EXPORTER_LABEL: &[u8] = b"EXPORTER-mythra-remote-pairing-v1";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum CloseReason {
    Finished,
    Revoked,
    Dead,
    Protocol,
    Overloaded,
    Replaced,
    HostingOff,
    Refused,
}

pub(super) enum Reply {
    /// The bridge queued a response under its subscription/publication barrier.
    Sent,
    Done(Result<Value, WireError>),
    DoneThenClose(Result<Value, WireError>),
}

enum Outbound {
    Frame(Vec<u8>),
    Stream(Vec<u8>, super::hostbridge::DeliveryGate, OwnedSemaphorePermit),
    Close(CloseReason),
}

pub(super) struct UnauthGuard {
    inner: Arc<Inner>,
    ip: IpAddr,
    _permit: OwnedSemaphorePermit,
}

impl UnauthGuard {
    /// `None` when either the total limit or the per-address limit is reached.
    fn acquire(inner: &Arc<Inner>, ip: IpAddr) -> Option<Self> {
        let permit = inner.unauthenticated.clone().try_acquire_owned().ok()?;
        let mut counts = inner
            .unauthenticated_by_ip
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        let count = counts.entry(ip).or_insert(0);
        if *count >= super::MAX_UNAUTHENTICATED_PER_IP {
            return None;
        }
        *count += 1;
        Some(Self {
            inner: inner.clone(),
            ip,
            _permit: permit,
        })
    }
}

impl Drop for UnauthGuard {
    fn drop(&mut self) {
        let mut counts = self
            .inner
            .unauthenticated_by_ip
            .lock()
            .unwrap_or_else(PoisonError::into_inner);
        if let Some(count) = counts.get_mut(&self.ip) {
            *count = count.saturating_sub(1);
            if *count == 0 {
                counts.remove(&self.ip);
            }
        }
    }
}

/// Addresses are compared per host: IPv4-mapped forms collapse to IPv4, and
/// IPv6 to its /64 so one machine cannot dodge limits by changing addresses.
pub(super) fn limit_key(ip: IpAddr) -> IpAddr {
    match ip.to_canonical() {
        IpAddr::V4(v4) => IpAddr::V4(v4),
        IpAddr::V6(v6) => {
            let segments = v6.segments();
            IpAddr::V6(std::net::Ipv6Addr::new(
                segments[0], segments[1], segments[2], segments[3], 0, 0, 0, 0,
            ))
        }
    }
}

/// Material for the pairing code. Both sides hold the same exporter value only
/// if they share one TLS session.
pub(super) type Exporter = [u8; 32];

pub(super) struct Link {
    inner: Weak<Inner>,
    pub(super) id: u64,
    pub(super) peer_fingerprint: String,
    pub(super) peer_spki: Vec<u8>,
    pub(super) peer_addr: SocketAddr,
    /// This side's application role.
    pub(super) role: Role,
    /// True when this side opened the TCP connection.
    pub(super) dialed: bool,
    paired: AtomicBool,
    readiness: AtomicU64,
    paired_at_ms:AtomicU64,
    write_failed: AtomicBool,
    last_received_ms: AtomicU64,
    pub(super) pairing_started: AtomicBool,
    pub(super) exporter: Exporter,
    pub(super) peer_name: StdMutex<Option<String>>,
    pub(super) peer_version: String,
    pub(super) rtt_ms: AtomicU32,
    #[cfg(test)]
    trace: StdMutex<Vec<&'static str>>,
    frames_left: AtomicU32,
    next_request: AtomicU64,
    outgoing: mpsc::Sender<Outbound>,
    stream_bytes: Arc<Semaphore>,
    closed: watch::Sender<Option<CloseReason>>,
    /// `None` once closed, so a late request fails at once.
    pending: StdMutex<Option<HashMap<u64, oneshot::Sender<Result<Value, WireError>>>>>,
    request_slots: Arc<Semaphore>,
    unauth: StdMutex<Option<UnauthGuard>>,
    /// Links this one takes over from, kept alive until the dialer proves it
    /// registered this link too. Until then the old link may be the only one.
    replaces: StdMutex<Vec<Arc<Link>>>,
}

impl Link {
    pub(super) fn is_paired(&self) -> bool {
        self.paired.load(Ordering::Acquire)
    }

    #[cfg(test)]
    pub(super) fn test_last_receive_ms(&self) -> u64 {
        self.last_received_ms.load(Ordering::Acquire)
    }
    #[cfg(test)]
    pub(super) fn test_trace(&self) -> Vec<&'static str> {
        self.trace.lock().unwrap_or_else(PoisonError::into_inner).clone()
    }
    #[cfg(test)]
    fn trace(&self, event: &'static str) {
        let mut trace = self.trace.lock().unwrap_or_else(PoisonError::into_inner);
        if trace.len() < 96 { trace.push(event); }
    }
    pub(super) fn close_reason(&self) -> Option<CloseReason> {
        *self.closed.borrow()
    }

    pub(super) fn closed(&self) -> watch::Receiver<Option<CloseReason>> { self.closed.subscribe() }

    pub(super) fn is_open(&self) -> bool {
        !self.write_failed.load(Ordering::Acquire) && self.closed.borrow().is_none()
    }

    fn receive_idle(&self) -> Duration {
        if self.role == Role::Viewer {
            VIEWER_SILENCE_LIMIT
        } else {
            LINK_DEAD_AFTER
        }
    }

    pub(super) fn set_paired(&self) {
        if !self.paired.swap(true,Ordering::AcqRel){self.paired_at_ms.store(wire_clock_ms(),Ordering::Release);}
        // A paired device no longer occupies a place among strangers.
        let guard = self
            .unauth
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take();
        drop(guard);
    }

    /// Any frame from the peer proves it registered this link.
    fn confirm_replacement(&self) {
        let replaced = std::mem::take(
            &mut *self.replaces.lock().unwrap_or_else(PoisonError::into_inner),
        );
        for other in replaced {
            other.close(CloseReason::Replaced);
        }
    }

    pub(super) fn close(&self, reason: CloseReason) {
        #[cfg(test)] self.trace(match reason { CloseReason::Dead=>"close_dead", CloseReason::Refused=>"close_refused", _=>"close_other" });
        let changed=self.closed.send_if_modified(|current| {
            if current.is_none() {
                *current = Some(reason);
                true
            } else {
                false
            }
        });
        if changed{super::diagnostics::record(super::diagnostics::Event::Closed,self.id,0,0,0,if self.role==Role::Host{"host"}else{"viewer"},match reason{CloseReason::Finished=>"finished",CloseReason::Revoked=>"revoked",CloseReason::Dead=>"dead",CloseReason::Protocol=>"protocol",CloseReason::Overloaded=>"overloaded",CloseReason::Replaced=>"replaced",CloseReason::HostingOff=>"hosting_off",CloseReason::Refused=>"refused"});}
    }

    /// Queues a close behind anything already queued, so a final response
    /// reaches the peer first.
    pub(super) fn close_after_flush(&self, reason: CloseReason) {
        if self.outgoing.try_send(Outbound::Close(reason)).is_err() {
            self.close(reason);
        }
    }

    pub(super) fn send(&self, frame: &Frame) -> bool {
        if !self.is_open() { return false; }
        let Ok(bytes) = encode(frame) else {
            return false;
        };
        if self.outgoing.try_send(Outbound::Frame(bytes)).is_err() {
            // A peer that stops reading is treated as gone; it must not make
            // this side buffer without limit.
            self.close(CloseReason::Overloaded);
            return false;
        }
        true
    }

    /// Stream backpressure retires one subscription, not the whole host. The
    /// permit follows the queued bytes until the writer sends or discards them.
    pub(super) fn send_stream(&self, frame: &Frame, gate: super::hostbridge::DeliveryGate) -> bool {
        if !self.is_open() || self.outgoing.capacity() <= STREAM_CONTROL_RESERVE { return false; }
        let Ok(bytes) = encode(frame) else { return false; };
        let Ok(permit) = self.stream_bytes.clone().try_acquire_many_owned(bytes.len() as u32) else { return false; };
        self.outgoing.try_send(Outbound::Stream(bytes, gate, permit)).is_ok()
    }

    pub(super) fn respond(&self, id: u64, result: Result<Value, WireError>) -> bool {
        let seq=result.as_ref().ok().and_then(|v|v.get("seq")).and_then(Value::as_u64).unwrap_or(0);
        let count=result.as_ref().ok().and_then(|v|v.get("frames")).and_then(Value::as_array).map_or(0,Vec::len);
        super::diagnostics::record(super::diagnostics::Event::Reply,self.id,id,seq,count,if self.role==Role::Host{"host"}else{"viewer"},result.as_ref().err().map_or("ok",|e|e.code.as_str()));
        let frame = match result {
            Ok(result) => Frame::Res {
                id,
                ok: true,
                result: Some(result),
                error: None,
            },
            Err(error) => Frame::Res {
                id,
                ok: false,
                result: None,
                error: Some(error),
            },
        };
        self.send(&frame)
    }

    /// Sends one request and waits at most `wait` for its response.
    pub(super) async fn request(
        &self,
        op: &str,
        args: Value,
        wait: Duration,
    ) -> Result<Value, WireError> {
        self.note_readiness(op);
        let lost = || WireError::new("host_unavailable", "The connection was lost.");
        let id = self.next_request.fetch_add(1, Ordering::Relaxed);
        let (sender, receiver) = oneshot::channel();
        {
            let mut pending = self.pending.lock().unwrap_or_else(PoisonError::into_inner);
            let Some(pending) = pending.as_mut() else {
                return Err(lost());
            };
            if pending.len() >= MAX_PENDING_REQUESTS {
                return Err(WireError::new("busy", "Too many requests are waiting."));
            }
            pending.insert(id, sender);
        }
        let seq=args.get("opSeq").and_then(Value::as_u64).unwrap_or(0);
        super::diagnostics::record(super::diagnostics::Event::Request,self.id,id,seq,0,op,"out");
        let sent = self.send(&Frame::Req {
            id,
            op: op.to_string(),
            args,
        });
        if !sent {
            self.forget_request(id);
            return Err(lost());
        }
        let result=match timeout(wait, receiver).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err(lost()),
            Err(_) => {
                self.forget_request(id);
                Err(WireError::new("host_unavailable", "The device did not answer in time."))
            }
        };
        super::diagnostics::record(super::diagnostics::Event::Reply,self.id,id,seq,0,op,result.as_ref().err().map_or("ok",|e|e.code.as_str()));
        result
    }

    fn forget_request(&self, id: u64) {
        if let Some(pending) = self
            .pending
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .as_mut()
        {
            pending.remove(&id);
        }
    }

    fn resolve_request(&self, id: u64, result: Result<Value, WireError>) {
        #[cfg(test)] self.trace("resolve_response");
        let sender = self
            .pending
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .as_mut()
            .and_then(|pending| pending.remove(&id));
        if let Some(sender) = sender {
            let _ = sender.send(result);
        }
    }

    fn fail_pending(&self) {
        #[cfg(test)] self.trace("fail_pending");
        let pending = self
            .pending
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .take();
        drop(pending);
    }
}

pub(super) struct LinkSetup {
    pub(super) peer_spki: Vec<u8>,
    pub(super) peer_addr: SocketAddr,
    pub(super) role: Role,
    pub(super) dialed: bool,
    pub(super) paired: bool,
    pub(super) exporter: Exporter,
    pub(super) peer_name: Option<String>,
    pub(super) peer_version: String,
    pub(super) unauth: Option<UnauthGuard>,
    /// The relationship generation when this attempt began.
    pub(super) relationship: u64,
    /// The listener that accepted this link. `None` when this side dialed.
    pub(super) listener: Option<u64>,
}

/// Only one link serves a peer and role. A viewer-dialed link beats a host-dialed
/// one at both ends, and within one direction the newer wins, because the older
/// socket may already be dead. `Err` means this link must not exist; `Ok` lists
/// the links it would replace.
fn arbitrate(core: &Core, fingerprint: &str, role: Role, dialed: bool) -> Result<Vec<Arc<Link>>, ()> {
    let viewer_dialed = |role: Role, dialed: bool| (role == Role::Viewer) == dialed;
    let mut replaced = Vec::new();
    for other in core.links.values() {
        if other.peer_fingerprint == fingerprint
            && other.role == role
            && other.is_paired()
            && other.is_open()
        {
            if viewer_dialed(other.role, other.dialed) && !viewer_dialed(role, dialed) {
                return Err(());
            }
            replaced.push(other.clone());
        }
    }
    Ok(replaced)
}

#[cfg(test)]
pub(super) fn test_start_link<S: AsyncRead + AsyncWrite + Send + 'static>(inner: &Arc<Inner>, stream: S, setup: LinkSetup) -> Arc<Link> {
    start_link(inner, stream, setup).expect("test link admission")
}

/// Registers the link and starts its tasks. `None` when it may not exist: the
/// table is full, or something changed since the hello, so everything that
/// allowed it is decided again here, under the lock that registers it.
fn start_link<S>(inner: &Arc<Inner>, stream: S, setup: LinkSetup) -> Option<Arc<Link>>
where
    S: AsyncRead + AsyncWrite + Send + 'static,
{
    let (outgoing, outgoing_rx) = mpsc::channel(OUTGOING_QUEUE);
    let (closed, _) = watch::channel(None);
    let link = Arc::new(Link {
        inner: Arc::downgrade(inner),
        id: inner.next_link_id.fetch_add(1, Ordering::Relaxed),
        peer_fingerprint: fingerprint_of(&setup.peer_spki),
        peer_spki: setup.peer_spki,
        peer_addr: setup.peer_addr,
        role: setup.role,
        dialed: setup.dialed,
        paired: AtomicBool::new(false),readiness:AtomicU64::new(0),paired_at_ms:AtomicU64::new(0),
        write_failed: AtomicBool::new(false),
        last_received_ms: AtomicU64::new(wire_clock_ms()),
        pairing_started: AtomicBool::new(false),
        exporter: setup.exporter,
        peer_name: StdMutex::new(setup.peer_name),
        peer_version: setup.peer_version,
        rtt_ms: AtomicU32::new(0),
        #[cfg(test)] trace: StdMutex::new(Vec::new()),
        frames_left: AtomicU32::new(UNPAIRED_FRAME_BUDGET),
        next_request: AtomicU64::new(1),
        outgoing,
        stream_bytes: Arc::new(Semaphore::new(8 * 1024 * 1024)),
        closed,
        pending: StdMutex::new(Some(HashMap::new())),
        request_slots: Arc::new(Semaphore::new(REQUEST_SLOTS)),
        unauth: StdMutex::new(setup.unauth),
        replaces: StdMutex::new(Vec::new()),
    });

    let mut replaced = Vec::new();
    {
        let mut core = inner.lock();
        if inner.exiting.load(Ordering::Acquire)
            || core.relationship(&link.peer_fingerprint) != setup.relationship
        {
            return None;
        }
        let listener = core.listener.as_ref().map(|listener| listener.generation);
        if setup.listener.is_some() && setup.listener != listener {
            return None;
        }
        if link.role == Role::Host && !core.settings.hosting {
            return None;
        }
        if setup.paired {
            let device = core.devices.get(&link.peer_fingerprint);
            let allowed = device.is_some_and(|device| match link.role {
                Role::Host => device.grant.is_some(),
                Role::Viewer => device.they_host,
            });
            if !allowed {
                return None;
            }
            replaced = arbitrate(&core, &link.peer_fingerprint, link.role, link.dialed).ok()?;
            if super::authenticated_links(&core).saturating_sub(replaced.len())
                >= super::MAX_AUTHENTICATED_LINKS
            {
                return None;
            }
            link.paired.store(true, Ordering::Release);
            if let Some(dial) = core.dials.get_mut(&link.peer_fingerprint) {
                dial.lost = false;
                dial.update_on = None;
            }
        }
        core.links.insert(link.id, link.clone());
    }
    if link.dialed {
        // The peer's hello already admitted this link.
        for other in replaced {
            other.close(CloseReason::Replaced);
        }
    } else {
        // The dialer has yet to register its end. Its first frame confirms it.
        *link.replaces.lock().unwrap_or_else(PoisonError::into_inner) = replaced;
    }
    if setup.paired {
        link.set_paired();
    }

    super::diagnostics::record(super::diagnostics::Event::Link,link.id,0,0,usize::from(link.dialed),if link.role==Role::Host{"host"}else{"viewer"},if setup.paired{"paired"}else{"unpaired"});
    let (reader, writer) = tokio::io::split(stream);
    let task_inner = inner.clone();
    let task_link = link.clone();
    tauri::async_runtime::spawn(async move {
        let read = tauri::async_runtime::spawn(reader_task(
            task_inner.clone(),
            task_link.clone(),
            reader,
        ));
        let write = tauri::async_runtime::spawn(writer_task(
            task_link.clone(),
            writer,
            outgoing_rx,
        ));
        let keep = tauri::async_runtime::spawn(keepalive_task(task_link.clone()));
        let watch = tauri::async_runtime::spawn(unpaired_watchdog(task_link.clone()));
        let _ = read.await;
        // The reader only ends after the link is closed.
        task_link.close(CloseReason::Finished);
        super::hostbridge::link_closed(&task_inner, &task_link);
        let _ = write.await;
        let _ = keep.await;
        let _ = watch.await;
        // Anyone still waiting on this link gets an answer now.
        task_link.fail_pending();
        task_inner.link_finished(&task_link).await;
    });
    Some(link)
}

async fn wait_closed(link: &Link) {
    let mut closed = link.closed.subscribe();
    let _ = closed.wait_for(Option::is_some).await;
}

// Count actual plaintext progress, including partial large frames. A healthy
// slow stream is not silence, but a frame that stalls halfway must still go stale.
struct Receiving<R> {
    io: R,
    link: Arc<Link>,
}
impl<R: AsyncRead + Unpin> AsyncRead for Receiving<R> {
    fn poll_read(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
        buf: &mut tokio::io::ReadBuf<'_>,
    ) -> std::task::Poll<std::io::Result<()>> {
        let before = buf.filled().len();
        let result = std::pin::Pin::new(&mut self.io).poll_read(cx, buf);
        if matches!(&result, std::task::Poll::Ready(Ok(()))) && buf.filled().len() > before {
            self.link
                .last_received_ms
                .store(wire_clock_ms(), Ordering::Release);
        }
        result
    }
}
async fn reader_task<S: AsyncRead>(inner: Arc<Inner>, link: Arc<Link>, reader: ReadHalf<S>) {
    let mut reader = Receiving { io: reader, link: link.clone() };
    loop {
        let limit = if link.is_paired() { MAX_FRAME } else { PREAUTH_MAX_FRAME };
        let frame = tokio::select! {
            _ = wait_closed(&link) => { #[cfg(test)] link.trace("reader_cancelled"); return; },
            read = read_frame(&mut reader, limit, link.receive_idle()) => read,
        };
        let bytes = match frame {
            Ok(bytes) => { #[cfg(test)] link.trace("reader_frame"); bytes },
            Err(error) if error.kind() == std::io::ErrorKind::InvalidData => {
                link.close(CloseReason::Protocol);
                return;
            }
            Err(_) => {
                #[cfg(test)] link.trace("reader_error");
                link.close(CloseReason::Dead);
                return;
            }
        };
        // A one-way failed link is not proof it can replace a healthy one.
        if link.is_open() { link.confirm_replacement(); }
        if !link.is_paired()
            && link
                .frames_left
                .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |left| left.checked_sub(1))
                .is_err()
        {
            link.close(CloseReason::Protocol);
            return;
        }
        match decode(&bytes) {
            Ok(Decoded::Frame(frame)) => dispatch(&inner, &link, frame),
            Ok(Decoded::Unknown) => {}
            Err(()) => {
                link.close(CloseReason::Protocol);
                return;
            }
        }
    }
}

fn dispatch(inner: &Arc<Inner>, link: &Arc<Link>, frame: Frame) {
    // A failed writer cannot start work, deliver events, or answer a ping. Only
    // finish requests whose final response may already be on the read half.
    if link.write_failed.load(Ordering::Acquire) && !matches!(&frame, Frame::Res { .. }) { return; }
    match frame {
        Frame::Ping { t } => {
            #[cfg(test)] link.trace("reader_ping");
            link.send(&Frame::Pong { t });
        }
        Frame::Pong { t } => {
            let rtt = wire_clock_ms().saturating_sub(t);
            link.rtt_ms
                .store(u32::try_from(rtt).unwrap_or(u32::MAX), Ordering::Relaxed);
        }
        Frame::Res {
            id,
            ok,
            result,
            error,
        } => {
            let outcome = if ok {
                Ok(result.unwrap_or(Value::Null))
            } else {
                Err(error.unwrap_or_else(|| WireError::new("internal", "Request failed.")))
            };
            link.resolve_request(id, outcome);
        }
        Frame::Req { id, op, args } => {
            link.note_readiness(&op);
            super::diagnostics::record(super::diagnostics::Event::Request,link.id,id,args.get("opSeq").and_then(Value::as_u64).unwrap_or(0),0,&op,"in");
            let Ok(slot) = link.request_slots.clone().try_acquire_owned() else {
                link.respond(id, Err(WireError::new("busy", "Too many requests at once.")));
                return;
            };
            let inner = inner.clone();
            let link = link.clone();
            tauri::async_runtime::spawn(async move {
                let reply = handle_request(&inner, &link, id, &op, args).await;
                drop(slot);
                match reply {
                    Reply::Sent => {}
                    Reply::Done(result) => { link.respond(id, result); }
                    Reply::DoneThenClose(result) => {
                        link.respond(id, result);
                        link.close_after_flush(CloseReason::Refused);
                    }
                }
            });
        }
        Frame::Evt { stream, epoch, seq, data } => {
            #[cfg(test)]
            if stream == "transport-probe" { link.trace("probe_frame"); }
            if !super::preview::receive_event(inner,link,&stream,&data) {
                super::hostbridge::receive_event(inner, link, stream, epoch, seq, data)
            }
        },
        Frame::Hello(_) => {}
    }
}

async fn writer_task<S: AsyncWrite>(
    link: Arc<Link>,
    mut writer: WriteHalf<S>,
    mut outgoing: mpsc::Receiver<Outbound>,
) {
    loop {
        let item = tokio::select! {
            biased;
            _ = wait_closed(&link) => break,
            item = outgoing.recv() => item,
        };
        let (bytes, _permit) = match item {
            Some(Outbound::Frame(bytes)) => { #[cfg(test)] link.trace("writer_frame"); (bytes, None) },
            Some(Outbound::Stream(bytes, gate, permit)) => {
                let allowed = link.inner.upgrade().is_some_and(|inner| super::hostbridge::delivery_allowed(&inner, &link, &gate));
                if !allowed { continue; }
                (bytes, Some(permit))
            }
            Some(Outbound::Close(reason)) => { #[cfg(test)] link.trace("writer_ordered_close"); link.close(reason); break; }
            None => break,
        };
        let written = tokio::select! {
            _ = wait_closed(&link) => break,
            result = timeout(WRITE_LIMIT, async {
                writer.write_all(&bytes).await?;
                writer.flush().await
            }) => result,
        };
        if !matches!(written, Ok(Ok(()))) {
            #[cfg(test)] link.trace("writer_error");
            // TCP/TLS is duplex: a late keepalive write can fail after the peer
            // flushed a final refusal/acknowledgement. Closing the read task now
            // would erase that answer and report an incorrect unknown outcome.
            // Disable new traffic immediately, but let pending replies drain for
            // at most the bounded shutdown grace. Revocation/explicit close still
            // cancels this wait immediately, and the queue remains owned here.
            link.write_failed.store(true, Ordering::Release);
            let _ = timeout(SHUTDOWN_LIMIT, wait_closed(&link)).await;
            link.close(CloseReason::Dead);
            break;
        }
        #[cfg(test)] link.trace("writer_flushed");
    }
    let _ = timeout(SHUTDOWN_LIMIT, writer.shutdown()).await;
}

/// A monotonic millisecond clock for `ping.t`; each side only compares its own
/// values, so the two machines' clocks never need to agree.
fn wire_clock_ms() -> u64 {
    static START: std::sync::OnceLock<Instant> = std::sync::OnceLock::new();
    START.get_or_init(Instant::now).elapsed().as_millis() as u64
}

async fn wait_silent(link: &Link) {
    loop {
        let elapsed = Duration::from_millis(
            wire_clock_ms().saturating_sub(link.last_received_ms.load(Ordering::Acquire)),
        );
        let Some(remaining) = link
            .receive_idle()
            .checked_sub(elapsed)
            .filter(|d| !d.is_zero())
        else {
            return;
        };
        tokio::time::sleep(remaining).await;
    }
}
async fn keepalive_task(link: Arc<Link>) {
    let mut ticks = interval(KEEPALIVE_EVERY);
    ticks.set_missed_tick_behavior(MissedTickBehavior::Delay);
    loop {
        tokio::select! {
            _ = wait_closed(&link) => return,
            _ = wait_silent(&link) => { link.close(CloseReason::Dead); return; }
            _ = ticks.tick() => {
                link.report_readiness();
                if !link.send(&Frame::Ping { t: wire_clock_ms() }) {
                    return;
                }
            }
        }
    }
}

async fn unpaired_watchdog(link: Arc<Link>) {
    if link.is_paired() {
        return;
    }
    tokio::select! {
        _ = wait_closed(&link) => return,
        _ = tokio::time::sleep(UNPAIRED_IDLE_LIMIT) => {}
    }
    if !link.is_paired() && !link.pairing_started.load(Ordering::Acquire) {
        link.close(CloseReason::Refused);
        return;
    }
    tokio::select! {
        _ = wait_closed(&link) => return,
        _ = tokio::time::sleep(UNPAIRED_LIFETIME) => {}
    }
    if !link.is_paired() {
        link.close(CloseReason::Refused);
    }
}

// ---- Establishing links ----

fn local_hello(core: &Core, role: Role, peer_known: bool, peer_paired: Option<bool>) -> Hello {
    Hello {
        proto: PROTO,
        role,
        app_version: super::app_version(core),
        name: (peer_known || core.settings.share_name).then(|| super::device_name(core)),
        extras: if peer_known {
            HelloExtras {
                paired: peer_paired,
                port: super::advertised_port(core),
                platform: Some(platform_name().to_string()),
                refused: None,
            }
        } else {
            HelloExtras::default()
        },
    }
}

fn peer_listener_address(address: SocketAddr, hello: &Hello) -> Option<String> {
    hello
        .extras
        .port
        .filter(|port| *port != 0)
        .map(|port| SocketAddr::new(address.ip(), port).to_string())
}

fn read_peer_name(hello: &Hello) -> Option<String> {
    hello.name.as_deref().and_then(clean_name)
}

/// Runs for every inbound TCP connection. Keeps the unauthenticated slot until
/// the peer is known to be paired or the link ends. `listener` names the listener
/// that accepted it, which may have been replaced by the time this finishes.
pub(super) async fn accept(
    inner: Arc<Inner>,
    acceptor: TlsAcceptor,
    tcp: TcpStream,
    peer: SocketAddr,
    listener: u64,
) {
    let peer = canonical_socket(peer);
    let Some(guard) = UnauthGuard::acquire(&inner, limit_key(peer.ip())) else {
        return;
    };
    let Some(identity) = inner.identity.get().cloned() else {
        return;
    };
    let _ = tcp.set_nodelay(true);
    let handshake = timeout(HANDSHAKE_LIMIT, async {
        let mut stream = acceptor.accept(tcp).await.ok()?;
        let (_, connection) = stream.get_ref();
        if connection.alpn_protocol() != Some(tls::ALPN) {
            return None;
        }
        let spki = connection.peer_certificates()?.first()?.as_ref().to_vec();
        if !tls::spki_is_ed25519(&spki) || spki == identity.spki {
            return None;
        }
        let exporter = connection
            .export_keying_material([0u8; 32], EXPORTER_LABEL, None)
            .ok()?;
        let bytes = read_frame(&mut stream, PREAUTH_MAX_FRAME, HANDSHAKE_LIMIT)
            .await
            .ok()?;
        let Ok(Decoded::Frame(Frame::Hello(hello))) = decode(&bytes) else {
            return None;
        };
        if hello.proto == 0 {
            return None;
        }
        let fingerprint = fingerprint_of(&spki);
        let local_role = match hello.role {
            Role::Viewer => Role::Host,
            Role::Host => Role::Viewer,
        };
        let (reply, paired, refusal, relationship, recorded) = {
            let mut core = inner.lock();
            let device = core.devices.get(&fingerprint);
            let known = device.is_some();
            let paired = device.is_some_and(|device| match hello.role {
                Role::Viewer => device.grant.is_some(),
                Role::Host => device.they_host,
            });
            // With hosting off this is a temporary listener. It takes pairing
            // offers and paired reverse links, and nobody can ask to view this
            // device through it.
            let hosting_refused = local_role == Role::Host && !core.settings.hosting;
            let retired = inner.exiting.load(Ordering::Acquire)
                || core.listener.as_ref().map(|listener| listener.generation) != Some(listener);
            let refusal = if hello.proto > PROTO {
                Some(Refusal::Version)
            } else if hosting_refused || retired {
                Some(Refusal::Closed)
            } else if paired && arbitrate(&core, &fingerprint, local_role, false).is_err() {
                Some(Refusal::Link)
            } else {
                None
            };
            // A paired device on a newer protocol is reported once and left
            // alone. Strangers never get an entry here.
            let recorded = refusal == Some(Refusal::Version) && known;
            if recorded {
                let dial = core
                    .dials
                    .entry(fingerprint.clone())
                    .or_insert_with(DialState::new);
                dial.update_on = Some(super::UPDATE_THIS_DEVICE);
                dial.next_at = std::time::Instant::now() + super::REFUSED_RETRY;
            }
            let mut reply = local_hello(&core, local_role, known, known.then_some(paired));
            reply.extras.refused = refusal;
            let relationship = core.relationship(&fingerprint);
            (reply, paired, refusal, relationship, recorded)
        };
        if recorded {
            inner.changed();
        }
        let encoded = encode(&Frame::Hello(reply)).ok()?;
        stream.write_all(&encoded).await.ok()?;
        stream.flush().await.ok()?;
        if refusal.is_some() {
            let _ = stream.shutdown().await;
            return None;
        }
        Some((stream, spki, hello, local_role, paired, exporter, relationship))
    })
    .await;
    let Ok(Some((stream, spki, hello, role, paired, exporter, relationship))) = handshake else {
        super::diagnostics::record(super::diagnostics::Event::Link,0,0,0,0,"tls.accept","failed");
        return;
    };
    let peer_name = read_peer_name(&hello);
    let peer_port = peer_listener_address(peer, &hello);
    let link = start_link(
        &inner,
        stream,
        LinkSetup {
            peer_spki: spki,
            peer_addr: peer,
            role,
            dialed: false,
            paired,
            exporter,
            peer_name: peer_name.clone(),
            peer_version: wire_version(&hello),
            unauth: Some(guard),
            relationship,
            listener: Some(listener),
        },
    );
    if let Some(link) = link {
        if paired {
            inner.refresh_keep_active();
            inner.note_peer(
                &link.peer_fingerprint,
                peer_name,
                hello.extras.platform.clone(),
                peer_port,
                link.role == Role::Viewer,
            );
        }
        inner.changed();
    }
}

fn wire_version(hello: &Hello) -> String {
    hello.app_version.chars().take(32).collect()
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) enum DialError {
    Unreachable,
    /// A device proved a key the policy does not accept.
    KeyRejected(Option<String>),
    /// The peer's protocol is newer, so this device has to update.
    UpdateRequired,
    /// The peer's protocol is older, so it has to update.
    PeerUpdateRequired,
    /// The right device, which no longer accepts this one.
    NotAllowed,
    /// The peer is not taking this kind of connection right now.
    NotAccepting,
    /// The peer is paired and already has every link it needs, or another
    /// attempt is making one.
    NotNeeded(String),
    Failed,
}

/// Holds the one attempt for a peer and role until the dial is over, however it
/// ends.
struct Reservation {
    inner: Arc<Inner>,
    key: (String, Role),
}

impl Drop for Reservation {
    fn drop(&mut self) {
        self.inner.lock().reservations.remove(&self.key);
    }
}

#[derive(Clone, Copy, Debug)]
pub(super) enum DialPurpose {
    /// Reach a paired device; the role follows from the record of that device.
    Paired,
    /// Reach a device to pair with, taking this role.
    Pairing(Role),
}

pub(super) async fn dial(
    inner: &Arc<Inner>,
    identity: &Arc<DeviceIdentity>,
    address: SocketAddr,
    policy: ServerKeyPolicy,
    purpose: DialPurpose,
) -> Result<Arc<Link>, DialError> {
    let address = canonical_socket(address);
    let proven: tls::ProvenKey = Default::default();
    let config =
        tls::client_config(identity, policy, proven.clone()).map_err(|_| DialError::Failed)?;
    let name = tls::server_name().map_err(|_| DialError::Failed)?;
    let tcp=match timeout(CONNECT_LIMIT,TcpStream::connect(address)).await {
        Ok(Ok(tcp))=>tcp,
        other=>{let outcome=match &other{Err(_)=>"timeout",Ok(Err(e))=>super::diagnostics::network_outcome(e),_=>"failed"};super::diagnostics::record(super::diagnostics::Event::Link,0,0,if address.is_ipv4(){4}else{6},0,"tcp.dial",outcome);return Err(DialError::Unreachable);}
    };
    let _ = tcp.set_nodelay(true);
    let handshake = timeout(HANDSHAKE_LIMIT, async {
        let mut stream = TlsConnector::from(config)
            .connect(name, tcp)
            .await
            .map_err(|error| {
                if tls::is_key_rejection(&error) {
                    DialError::KeyRejected(
                        proven.lock().unwrap_or_else(PoisonError::into_inner).clone(),
                    )
                } else {
                    DialError::Failed
                }
            })?;
        let (_, connection) = stream.get_ref();
        if connection.alpn_protocol() != Some(tls::ALPN) {
            return Err(DialError::Failed);
        }
        let spki = connection
            .peer_certificates()
            .and_then(|certificates| certificates.first())
            .map(|certificate| certificate.as_ref().to_vec())
            .ok_or(DialError::Failed)?;
        if !tls::spki_is_ed25519(&spki) || spki == identity.spki {
            return Err(DialError::Failed);
        }
        let exporter = connection
            .export_keying_material([0u8; 32], EXPORTER_LABEL, None)
            .map_err(|_| DialError::Failed)?;
        let fingerprint = fingerprint_of(&spki);
        let (hello, role, relationship, reservation) = {
            let mut core = inner.lock();
            let known = core.devices.contains_key(&fingerprint);
            let role = match purpose {
                DialPurpose::Pairing(role) => role,
                DialPurpose::Paired => match super::role_for_peer(&core, &fingerprint) {
                    Some(role) => role,
                    None => return Err(DialError::NotNeeded(fingerprint)),
                },
            };
            let reservation = if matches!(purpose, DialPurpose::Paired) {
                let key = (fingerprint.clone(), role);
                if !core.reservations.insert(key.clone()) {
                    return Err(DialError::NotNeeded(fingerprint));
                }
                Some(Reservation { inner: inner.clone(), key })
            } else {
                None
            };
            let relationship = core.relationship(&fingerprint);
            (local_hello(&core, role, known, None), role, relationship, reservation)
        };
        let encoded = encode(&Frame::Hello(hello)).map_err(|_| DialError::Failed)?;
        stream.write_all(&encoded).await.map_err(|_| DialError::Failed)?;
        stream.flush().await.map_err(|_| DialError::Failed)?;
        let bytes = read_frame(&mut stream, PREAUTH_MAX_FRAME, HANDSHAKE_LIMIT)
            .await
            .map_err(|_| DialError::Failed)?;
        let Ok(Decoded::Frame(Frame::Hello(reply))) = decode(&bytes) else {
            return Err(DialError::Failed);
        };
        if reply.proto > PROTO {
            return Err(DialError::UpdateRequired);
        }
        if reply.proto == 0 || reply.role == role {
            return Err(DialError::Failed);
        }
        // A refused link is never registered, whatever else the reply says.
        match reply.extras.refused {
            None => {}
            Some(Refusal::Link) => return Err(DialError::NotNeeded(fingerprint)),
            Some(Refusal::Closed) => return Err(DialError::NotAccepting),
            Some(Refusal::Version) => return Err(DialError::PeerUpdateRequired),
            Some(Refusal::Other) => return Err(DialError::Failed),
        }
        Ok((stream, spki, reply, role, exporter, relationship, reservation))
    })
    .await
    .map_err(|_| DialError::Unreachable)?;
    if let Err(error)=&handshake{super::diagnostics::record(super::diagnostics::Event::Link,0,0,0,0,"tls.dial",if matches!(error,DialError::KeyRejected(_)){"key_rejected"}else{"failed"});}
    let (stream, spki, reply, role, exporter, relationship, _reservation) = handshake?;

    let peer_paired = reply.extras.paired == Some(true);
    if matches!(purpose, DialPurpose::Paired) && !peer_paired {
        // The pinned key itself said no. As a viewer that means this device
        // lost its access; as a host it only means the viewer moved on.
        if role == Role::Viewer {
            inner.mark_access_removed(&fingerprint_of(&spki), relationship);
        }
        return Err(DialError::NotAllowed);
    }
    let peer_name = read_peer_name(&reply);
    let peer_port = peer_listener_address(address, &reply);
    let platform = reply.extras.platform.clone();
    let paired = matches!(purpose, DialPurpose::Paired);
    let fingerprint = fingerprint_of(&spki);
    let link = start_link(
        inner,
        stream,
        LinkSetup {
            peer_spki: spki,
            peer_addr: address,
            role,
            dialed: true,
            paired,
            exporter,
            peer_name: peer_name.clone(),
            peer_version: wire_version(&reply),
            unauth: None,
            relationship,
            listener: None,
        },
    )
    .ok_or(DialError::Failed)?;
    if paired {
        inner.refresh_keep_active();
        inner.note_peer(
            &fingerprint,
            peer_name,
            platform,
            peer_port.or_else(|| Some(address.to_string())),
            role == Role::Viewer,
        );
    }
    inner.changed();
    Ok(link)
}

// ---- Operations ----

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct OpStatusArgs {
    op_id: String,
    /// Needed to tell "never admitted" from "evicted".
    #[serde(default)]
    op_seq: Option<u64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeviceUpdateArgs {
    #[serde(default)]
    name: Option<String>,
    #[serde(default)]
    platform: Option<String>,
    #[serde(default)]
    port: Option<u16>,
}

/// Rule 3: the answer comes from the key TLS proved on this link and the
/// host's own records, never from anything the peer wrote in a message.
fn authorize_paired_operation(inner: &Arc<Inner>, link: &Link) -> Result<(), WireError> {
    let core = inner.lock();
    let granted = core
        .devices
        .get(&link.peer_fingerprint)
        .is_some_and(|device| device.grant.is_some());
    if link.role != Role::Host || !link.is_paired() || !granted {
        return Err(WireError::new("not_paired", "This device is not paired."));
    }
    if !core.settings.hosting {
        return Err(WireError::new("host_unavailable", "Access is turned off."));
    }
    Ok(())
}

async fn handle_request(inner: &Arc<Inner>, link: &Arc<Link>, id: u64, op: &str, args: Value) -> Reply {
    let result = match op {
        "preview.list" | "preview.open" | "preview.ready" | "preview.http" | "preview.close" | "preview.ws.open" | "preview.ws.write" | "preview.stream.read" | "preview.stream.close" => return Reply::Done(super::preview::handle_request(inner,link,op,args).await),
        "terminal.ack" => return Reply::Done(super::terminal::ack(inner,link,&args)),
        op if super::work::is_mutation(op) => return Reply::Done(super::work::handle_request(inner,link,op,args).await),
        op if super::manifest::fields(op).is_some()=>return Reply::Done(super::hostbridge::request_value(inner,link,op,args,None).await),
        "pair.offer" => return pairing::handle_offer(inner, link),
        "pair.request" => return pairing::handle_request(inner, link, args),
        "pair.reveal" => return pairing::handle_reveal(inner, link, args),
        "pair.await" => return pairing::handle_await(inner, link).await,
        "prompt.send" | "prompt.queue" | "prompt.steer" | "turn.stop" | "approval.answer" | "question.answer" => return Reply::Done(super::work::handle_request(inner,link,op,args).await),
        "work.inspect" => return Reply::Done(super::hostbridge::request_value(inner,link,op,args,None).await),
        "workspaces.list" | "threads.list" | "timeline.read" | "timeline.subscribe" | "timeline.unsubscribe" =>
            return super::hostbridge::handle_request(inner, link, id, op, args).await,
        "ping" => authorize_paired_operation(inner, link).map(|()| json!({ "ok": true })),
        "host.info" => match authorize_paired_operation(inner, link) {
            Ok(()) => host_info(inner, link).await,
            Err(error) => Err(error),
        },
        "op.status" => match authorize_paired_operation(inner, link) {
            Ok(()) => op_status(inner, link, args).await,
            Err(error) => Err(error),
        },
        "device.update" if link.is_paired() => {
            match serde_json::from_value::<DeviceUpdateArgs>(args) {
                Ok(update) => {
                    let address = update
                        .port
                        .filter(|port| *port != 0)
                        .map(|port| SocketAddr::new(link.peer_addr.ip(), port).to_string());
                    let name = update.name.as_deref().and_then(clean_name);
                    if let Some(name) = &name {
                        *link
                            .peer_name
                            .lock()
                            .unwrap_or_else(PoisonError::into_inner) = Some(name.clone());
                    }
                    inner.note_peer(&link.peer_fingerprint, name, update.platform, address, false);
                    inner.changed();
                    Ok(Value::Null)
                }
                Err(_) => Err(WireError::new("internal", "That request was not valid.")),
            }
        }
        "device.update" => Err(WireError::new("not_paired", "This device is not paired.")),
        _ => Err(WireError::new(
            "unsupported",
            "This version of Mythra Code does not support that.",
        )),
    };
    Reply::Done(result)
}

async fn host_info(inner: &Arc<Inner>, link: &Link) -> Result<Value, WireError> {
    let fingerprint = link.peer_fingerprint.clone();
    let highest = inner
        .read_db(move |connection| {
            store::highest_op_seq(connection, &fingerprint).map_err(|error| error.to_string())
        })
        .await
        .map_err(|_| WireError::new("internal", "The other device couldn't read that."))?;
    let core = inner.lock();
    Ok(json!({
        "name": super::device_name(&core),
        "appVersion": super::app_version(&core),
        "platform": wire::platform_name(),
        "proto": PROTO,
        "highestOpSeq": highest,
    }))
}

async fn op_status(inner: &Arc<Inner>, link: &Link, args: Value) -> Result<Value, WireError> {
    let invalid = || WireError::new("internal", "That request was not valid.");
    let args: OpStatusArgs = serde_json::from_value(args).map_err(|_| invalid())?;
    if args.op_id.is_empty() || args.op_id.len() > MAX_OP_ID_BYTES {
        return Err(invalid());
    }
    let fingerprint = link.peer_fingerprint.clone();
    let status = inner
        .read_db(move |connection| {
            let status=store::op_status(connection, &fingerprint, &args.op_id, args.op_seq).map_err(|error|error.to_string())?;
            if matches!(status.state.as_str(),"unknown"|"expired"){return serde_json::to_value(status).map_err(|_|"The delivery record could not be read.".to_string());}
            let mut result=store::operation_result(connection,&fingerprint,&args.op_id)?;
            // op.status retains its original accepted-with-queuedTurnId shape,
            // while replay also retains the additional safe mutation identities.
            if result.get("state").and_then(Value::as_str)==Some("queued"){result["state"]=json!("accepted");}
            if let Some(code)=result.pointer("/error/code").cloned(){result["errorCode"]=code;}
            Ok(result)
        })
        .await
        .map_err(|_| WireError::new("internal", "The other device couldn't read that."))?;
    Ok(status)
}


impl Link{
 fn note_readiness(&self,op:&str){let flag=match op{"workspaces.list"=>1,"threads.list"=>2,"timeline.subscribe"=>4,_=>0};if flag!=0{self.readiness.fetch_or(flag,Ordering::AcqRel);}}
 fn report_readiness(&self){let began=self.paired_at_ms.load(Ordering::Acquire);if !self.is_paired()||wire_clock_ms().saturating_sub(began)<15_000{return;}let stages=self.readiness.fetch_or(8,Ordering::AcqRel);if stages&8!=0{return;}let outcome=if stages&1==0{"no_catalog_requests"}else if stages&2==0{"no_thread_requests"}else if stages&4==0{"no_subscribe"}else{"subscribe_requested"};super::diagnostics::record(super::diagnostics::Event::Readiness,self.id,0,stages&7,0,if self.role==Role::Viewer{"viewer"}else{"host"},outcome);}
}
