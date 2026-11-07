//! Remote work over a local network. See `docs/features/remote-lan.md`, the
//! binding design contract.
//!
//! Nothing here touches the network unless the user has opted in: no listener
//! or advertisement without Allow access, and no browsing until hosting is on,
//! a device is paired, or the user chooses Find nearby devices.

pub(crate) mod discovery;
pub(crate) mod hostbridge;
mod identity;
pub(crate) mod diagnostics;
mod manifest;
pub(crate) mod fs_guard;
pub(crate) mod studio;
pub(crate) mod studio_extra;
pub(crate) mod folders;
#[cfg(target_os = "macos")]
mod macos_activity;
mod pairing;
mod session;
pub(crate) mod store;
mod tls;
mod timeline;
mod wire;
pub(crate) mod work;
pub(crate) mod commit;
pub(crate) mod attachments;
pub(crate) mod clone;
pub(crate) mod preview;
pub(crate) mod terminal;
pub(crate) mod upload_source;
pub(crate) mod domain;
pub(crate) mod prompt_preparation;
pub(crate) mod owners;
pub(crate) mod bookkeeping;
pub(crate) mod safe_git;
mod git_metadata;
pub(crate) mod queue;
pub(crate) mod agent_actions;
pub(crate) mod pending;
pub(crate) mod threads;
mod instructions;
pub(crate) mod thread_batch;
pub(crate) mod discovery_work;
pub(crate) mod github;
#[cfg(test)]
mod tests;
#[cfg(all(test, windows))]
mod windows_tests;

use std::collections::{HashMap, HashSet, VecDeque};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex, MutexGuard, OnceLock, PoisonError};
use std::time::{Duration, Instant, SystemTime};

use rusqlite::Connection;
use serde::Serialize;
use serde_json::{json, Value};
use socket2::{Domain, Protocol, Socket, Type};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::net::TcpListener;
use tokio::sync::{oneshot, watch, Mutex, Notify, Semaphore};
use tokio::time::timeout;
use tokio_rustls::TlsAcceptor;

use discovery::platform::{self, Advertisement, Browser};
use discovery::types::{
    address_is_usable, address_is_vpn_range, canonical_socket, instance_is_valid, AdvertiseRequest,
    DiscoveryEvent, DiscoveryFailure, DiscoverySink, ResolvedService, MAX_ADDRESSES, MAX_SERVICES,
};
use identity::{fingerprint_is_valid, DeviceIdentity};
use pairing::{FlowView, PairingWindow, PairingWindowView, ViewerFlow};
use session::{CloseReason, DialError, DialPurpose, Link};
use store::{DeviceGrant, DeviceRecord, Settings};
use tls::ServerKeyPolicy;
use wire::{clean_name, platform_name, Role};

pub(crate) const CHANGED_EVENT: &str = "remote-changed";
const MAX_UNAUTHENTICATED: usize = 8;
const MAX_UNAUTHENTICATED_PER_IP: usize = 3;
/// Authenticated links in total. Connections still being checked have their
/// own limit, `MAX_UNAUTHENTICATED`.
const MAX_AUTHENTICATED_LINKS: usize = 16;
const MAX_RESOLVES: usize = 4;
const MAX_DIALS: usize = 8;
const MAX_PROBES: usize = 4;
const SUPERVISOR_TICK: Duration = Duration::from_secs(1);
const SEARCH_LIFETIME: Duration = Duration::from_secs(10 * 60);
const RECONNECT_BACKOFF: [u64; 5] = [1, 2, 5, 10, 30];
const REFUSED_RETRY: Duration = Duration::from_secs(5 * 60);
const RESOLVE_WAIT: Duration = Duration::from_secs(5);
const RESOLVE_REFRESH: Duration = Duration::from_secs(60);
const RESOLVE_FAILURES_BEFORE_DROP: u32 = 3;
const PROBE_RETRY_UNKNOWN: Duration = Duration::from_secs(5 * 60);
const PROBE_RETRY_UNREACHABLE: Duration = Duration::from_secs(60);
const DISCOVERY_RETRY: Duration = Duration::from_secs(30);
const DENIAL_SETTLE: Duration = Duration::from_secs(5);
/// The first Bonjour attempt can fail while the Local Network prompt is still
/// on screen, so a denial this recent is retried quickly and reported as waiting.
const PROMPT_GRACE: Duration = Duration::from_secs(60);
const PROMPT_RETRY: Duration = Duration::from_secs(3);
const IDENTITY_RETRY: Duration = Duration::from_secs(30);
/// Reads only. A write has no timer, because it could still commit after one
/// fired, and its caller would then have reported the wrong outcome.
const DB_WAIT: Duration = Duration::from_secs(10);
const MAX_QUEUED_WRITES: usize = 256;
/// Details a peer reports must never crowd out a change the user made.
const MAX_BACKGROUND_WRITES: usize = 128;
const UNSAVED_RETRY: Duration = Duration::from_secs(5);
const EXIT_WRITE_WAIT: Duration = Duration::from_secs(1);
const NETWORK_RECHECK: Duration = Duration::from_secs(30);
const NETWORK_CHECK_WAIT: Duration = Duration::from_secs(10);
const SAVE_FAILED: &str = "Mythra Code could not save that change. Try again.";
/// Which side has to update before two devices can connect.
const UPDATE_THIS_DEVICE: &str = "this";
const UPDATE_PEER: &str = "peer";
const PING_WAIT: Duration = Duration::from_secs(10);
const MAX_TXT_NAME_BYTES: usize = 200;
const FALLBACK_NAME: &str = "This device";
const NEARBY_FALLBACK_NAME: &str = "Nearby device";

struct ListenerHandle {
    port: u16,
    /// Receive-only: Hosting is off (paired reverse links or an offer window).
    temporary: bool,
    /// A connection accepted by an older listener cannot register.
    generation: u64,
    stop: watch::Sender<bool>,
}

struct NearbyEntry {
    /// A resolve or probe started for a replaced entry is ignored.
    id: u64,
    name: Option<String>,
    addresses: Vec<SocketAddr>,
    resolved_at: Option<Instant>,
    resolve_failures: u32,
    resolving: bool,
    /// Which paired device this service turned out to be.
    matched: Option<String>,
    /// The key this service proved. Several services or addresses with one key
    /// are one device, however many interfaces it answers on.
    proven: Option<String>,
    probing: bool,
    probe_at: Instant,
}

impl NearbyEntry {
    fn new(id: u64) -> Self {
        Self {
            id,
            name: None,
            addresses: Vec::new(),
            resolved_at: None,
            resolve_failures: 0,
            resolving: false,
            matched: None,
            proven: None,
            probing: false,
            probe_at: Instant::now(),
        }
    }
}

struct DialState {
    attempt: usize,
    next_at: Instant,
    in_flight: bool,
    /// `UPDATE_THIS_DEVICE` or `UPDATE_PEER` while the versions can't connect.
    update_on: Option<&'static str>,
    /// A link to view this device dropped and has not come back.
    lost: bool,
    /// A paired viewer asked its host to open the missing reverse-role link.
    reverse_requested: bool,
}

impl DialState {
    fn new() -> Self {
        Self {
            attempt: 0,
            next_at: Instant::now(),
            in_flight: false,
            update_on: None,
            lost: false,
            reverse_requested: false,
        }
    }
}

/// Narrowing changes that took effect in memory but are not on disk yet. The
/// supervisor keeps writing the current state until one attempt succeeds.
#[derive(Default)]
struct Unsaved {
    devices: HashSet<String>,
    viewer_undos: HashMap<String, store::ViewerPairingUndo>,
    hosting: bool,
    share_name: bool,
    retrying: bool,
    retry_at: Option<Instant>,
}

impl Unsaved {
    fn pending(&self) -> bool {
        self.retrying || self.hosting || self.share_name || !self.devices.is_empty() || !self.viewer_undos.is_empty()
    }

    fn remember_viewer_undo(&mut self, undo: store::ViewerPairingUndo) {
        // Only successful viewer saves need undoing. If two canceled saves
        // finish out of order, the newer persisted token supersedes the older.
        let entry = self.viewer_undos.entry(undo.fingerprint.clone());
        match entry {
            std::collections::hash_map::Entry::Occupied(mut entry) => {
                if entry.get().sequence < undo.sequence { entry.insert(undo); }
            }
            std::collections::hash_map::Entry::Vacant(entry) => { entry.insert(undo); }
        }
    }
}

/// The latest edit of each setting, so an older save finishing late cannot
/// overwrite a newer decision.
#[derive(Default)]
struct SettingEdits {
    hosting: u64,
    share_name: u64,
    device_name: u64,
}

struct Core {
    bridge: hostbridge::Bridge,
    work: work::WorkState,
    prompt_preparations: prompt_preparation::Registry,
    folders: folders::Registry,
    loaded: bool,
    load_failed: bool,
    settings: Settings,
    default_name: String,
    app_version: String,
    devices: HashMap<String, DeviceRecord>,
    links: HashMap<u64, Arc<Link>>,
    terminals: terminal::Registry,
    discovery_jobs: discovery_work::Registry,
    owners: owners::Registry,
    nearby: HashMap<String, NearbyEntry>,
    pairing: Option<PairingWindow>,
    flow: Option<ViewerFlow>,
    listener: Option<ListenerHandle>,
    advertiser: Option<Advertisement>,
    advertised: Option<AdvertiseRequest>,
    advertise_retry_at: Option<Instant>,
    /// Identifies the current advertiser. Bumped when it is retired.
    advertise_generation: u64,
    /// When the network was last compared with what is advertised. Wall time,
    /// so a sleeping machine is rechecked as soon as it wakes.
    network_checked_at: Option<SystemTime>,
    /// `None` is unknown. Only set while advertising.
    public_network: Option<bool>,
    browser: Option<Browser>,
    /// Identifies the current browser. Bumped when it is retired.
    browse_generation: u64,
    browse_started_at: Option<Instant>,
    browse_retry_at: Option<Instant>,
    identity_retry_at: Option<Instant>,
    search_until: Option<Instant>,
    rate: HashMap<IpAddr, (Instant, u32)>,
    dials: HashMap<String, DialState>,
    /// One attempt per peer and role, shared by probes and ordinary dials.
    reservations: HashSet<(String, Role)>,
    /// Bumped by revoke and forget, so work that began before either cannot
    /// finish after it. Only a local user action adds an entry.
    relationships: HashMap<String, u64>,
    /// A queued pairing/grant save has not yet published its outcome in memory.
    /// Full-state narrowing retries must wait, then take a fresh snapshot.
    unpublished_device_saves: HashMap<String, usize>,
    next_id: u64,
    unsaved: Unsaved,
    edits: SettingEdits,
    host_error: Option<String>,
    /// When the OS first refused local network access. DNS-SD policy denial is
    /// the only evidence that counts; macOS has no way to ask directly.
    denied_since: Option<Instant>,
    /// DNS-SD found this LAN peer, but outgoing TCP got host/network-unreachable.
    /// This is a hint, not proof: inbound links and Bonjour cannot clear it.
    outgoing_denied_since: Option<Instant>,
    discovery_error: Option<String>,
    #[cfg(target_os = "macos")]
    activity: Option<macos_activity::HostingActivity>,
}

impl Core {
    fn take_id(&mut self) -> u64 {
        let id = self.next_id;
        self.next_id += 1;
        id
    }

    fn relationship(&self, fingerprint: &str) -> u64 {
        self.relationships.get(fingerprint).copied().unwrap_or(0)
    }

    fn end_relationship(&mut self, fingerprint: &str) {
        let generation = self.take_id();
        self.relationships.insert(fingerprint.to_string(), generation);
    }

    fn begin_device_save(&mut self, fingerprint: &str) {
        *self.unpublished_device_saves.entry(fingerprint.to_string()).or_default() += 1;
    }

    fn end_device_save(&mut self, fingerprint: &str) {
        if let Some(count) = self.unpublished_device_saves.get_mut(fingerprint) {
            *count -= 1;
            if *count == 0 { self.unpublished_device_saves.remove(fingerprint); }
        }
    }

    fn retire_advertiser(&mut self) -> Option<Advertisement> {
        self.advertise_generation = self.take_id();
        self.advertised = None;
        self.network_checked_at = None;
        self.public_network = None;
        self.advertiser.take()
    }

    fn retire_browser(&mut self) -> Option<Browser> {
        self.browse_generation = self.take_id();
        self.browser.take()
    }
}

impl Default for Core {
    fn default() -> Self {
        Self {
            bridge: hostbridge::Bridge::default(),
            work: work::WorkState::default(),
            prompt_preparations: prompt_preparation::Registry::default(),
            folders: folders::Registry::default(),
            loaded: false,
            load_failed: false,
            settings: Settings::default(),
            default_name: FALLBACK_NAME.to_string(),
            app_version: String::new(),
            devices: HashMap::new(),
            links: HashMap::new(),
            terminals: terminal::Registry::default(),
            discovery_jobs: discovery_work::Registry::default(),
            owners: owners::Registry::default(),
            nearby: HashMap::new(),
            pairing: None,
            flow: None,
            listener: None,
            advertiser: None,
            advertised: None,
            advertise_retry_at: None,
            advertise_generation: 0,
            network_checked_at: None,
            public_network: None,
            browser: None,
            browse_generation: 0,
            browse_started_at: None,
            browse_retry_at: None,
            identity_retry_at: None,
            search_until: None,
            rate: HashMap::new(),
            dials: HashMap::new(),
            reservations: HashSet::new(),
            relationships: HashMap::new(),
            unpublished_device_saves: HashMap::new(),
            next_id: 1,
            unsaved: Unsaved::default(),
            edits: SettingEdits::default(),
            host_error: None,
            denied_since: None,
            outgoing_denied_since: None,
            discovery_error: None,
            #[cfg(target_os = "macos")]
            activity: None,
        }
    }
}

pub(crate) struct RemoteState {
    inner: Arc<Inner>,
}

impl Default for RemoteState {
    fn default() -> Self {
        Self {
            inner: Arc::new(Inner {
                app: OnceLock::new(),
                core: StdMutex::new(Core::default()),
                wake: Notify::new(),
                identity: OnceLock::new(),
                identity_gate: Arc::new(Mutex::new(())),
                writes: Arc::new(StdMutex::new(WriteQueue::default())),
                #[cfg(test)]
                test_database: OnceLock::new(),
                #[cfg(test)]
                test_block_outgoing: AtomicBool::new(false),
                lifecycle: Mutex::new(()),
                generation: AtomicU64::new(0),
                unauthenticated: Arc::new(Semaphore::new(MAX_UNAUTHENTICATED)),
                unauthenticated_by_ip: StdMutex::new(HashMap::new()),
                next_link_id: AtomicU64::new(1),
                active_resolves: AtomicU32::new(0),
                active_dials: AtomicU32::new(0),
                active_probes: AtomicU32::new(0),
                dirty: AtomicBool::new(false),
                exiting: AtomicBool::new(false),
            }),
        }
    }
}

struct Inner {
    app: OnceLock<AppHandle>,
    core: StdMutex<Core>,
    wake: Notify,
    identity: OnceLock<Arc<DeviceIdentity>>,
    identity_gate: Arc<Mutex<()>>,
    /// Lock order is `core` first. See `enqueue_write`.
    writes: Arc<StdMutex<WriteQueue>>,
    #[cfg(test)]
    test_database: OnceLock<Arc<StdMutex<Connection>>>,
    #[cfg(test)]
    test_block_outgoing: AtomicBool,
    /// One reconcile at a time, so switch changes and the supervisor agree.
    lifecycle: Mutex<()>,
    generation: AtomicU64,
    unauthenticated: Arc<Semaphore>,
    /// Its own lock, because guards can drop while `core` is held.
    unauthenticated_by_ip: StdMutex<HashMap<IpAddr, usize>>,
    next_link_id: AtomicU64,
    active_resolves: AtomicU32,
    active_dials: AtomicU32,
    active_probes: AtomicU32,
    /// Set from OS callbacks; the supervisor sends the update.
    dirty: AtomicBool,
    exiting: AtomicBool,
}

type WriteJob = Box<dyn FnOnce(Option<&mut Connection>) + Send>;

#[derive(Default)]
struct WriteQueue {
    jobs: VecDeque<WriteJob>,
    /// A drainer exists only while there is work, so nothing idles.
    running: bool,
}

#[derive(Clone)]
enum WriteDatabase {
    App(AppHandle),
    #[cfg(test)]
    Memory(Arc<StdMutex<Connection>>),
}
impl WriteDatabase {
    fn connection(&self)->Result<Arc<StdMutex<Connection>>,String>{match self {
        Self::App(app)=>crate::shared_state_db(app),
        #[cfg(test)] Self::Memory(database)=>Ok(database.clone()),
    }}
}
fn drain_writes(source: WriteDatabase, queue: Arc<StdMutex<WriteQueue>>) {
    loop {
        let job = {
            let mut queue = queue.lock().unwrap_or_else(PoisonError::into_inner);
            match queue.jobs.pop_front() {
                Some(job) => job,
                None => {
                    queue.running = false;
                    return;
                }
            }
        };
        let database = source.connection().ok();
        let mut connection = database
            .as_ref()
            .and_then(|database| crate::lock_state_db(database).ok());
        // A panic must not stall every later write. Its caller sees a failure.
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            job(connection.as_deref_mut());
        }));
    }
}

async fn finish_write<T>(saved: oneshot::Receiver<Result<T, String>>) -> Result<T, String> {
    saved.await.unwrap_or_else(|_| Err(SAVE_FAILED.to_string()))
}

fn device_name(core: &Core) -> String {
    core.settings
        .device_name
        .clone()
        .unwrap_or_else(|| core.default_name.clone())
}

fn app_version(core: &Core) -> String {
    core.app_version.clone()
}

/// Paired viewers keep a receive-only listener for reverse reconnects.
/// A one-off, unpaired offer window is still not a stable saved address.
fn advertised_port(core: &Core) -> Option<u16> {
    (core.settings.hosting || core.devices.values().any(|device| device.they_host && !device.access_removed))
        .then(|| core.listener.as_ref().map(|listener| listener.port))
        .flatten()
}

fn authenticated_links(core: &Core) -> usize {
    core.links.values().filter(|link| link.is_paired()).count()
}

/// Hosting, a paired viewer needing reverse reconnects, or an offer window.
fn wants_listener(core: &Core) -> bool {
    core.settings.hosting
        || core.devices.values().any(|device| device.they_host && !device.access_removed)
        || core
            .pairing
            .as_ref()
            .is_some_and(|window| window.temporary && window.is_open())
}

fn network_access(core: &Core) -> &'static str {
    if core.outgoing_denied_since.is_some_and(|at|at.elapsed()<Duration::from_secs(120)){return "blocked";}
    match core.denied_since {
        None => "ok",
        Some(since) if since.elapsed() < PROMPT_GRACE => "waiting",
        Some(_) => "blocked",
    }
}

/// Which role this side should take with a paired device, if it needs a link.
fn role_for_peer(core: &Core, fingerprint: &str) -> Option<Role> {
    let device = core.devices.get(fingerprint)?;
    let linked = |role: Role| {
        core.links.values().any(|link| {
            link.peer_fingerprint == fingerprint
                && link.role == role
                && link.is_paired()
                && link.is_open()
        })
    };
    // A viewer keeps trying for a direct link even over a reverse one, because
    // the direct link is preferred and replaces it as soon as it connects.
    let direct = core.links.values().any(|link| {
        link.peer_fingerprint == fingerprint
            && link.role == Role::Viewer
            && link.dialed
            && link.is_paired()
            && link.is_open()
    });
    let missing_host = core.settings.hosting
        && device.grant.as_ref().is_some_and(|grant| grant.view) && !linked(Role::Host);
    if missing_host && core.dials.get(fingerprint).is_some_and(|dial| dial.reverse_requested) {
        Some(Role::Host)
    } else if device.they_host && !device.access_removed && !direct {
        Some(Role::Viewer)
    } else if core.settings.hosting && device.grant.is_some() && !linked(Role::Host) {
        Some(Role::Host)
    } else {
        None
    }
}

/// Rule 2: browsing needs hosting, a paired device, or an explicit search.
fn should_browse(core: &Core) -> bool {
    core.settings.hosting
        || !core.devices.is_empty()
        || core.search_until.is_some_and(|until| Instant::now() < until)
}

fn feature_active(core: &Core) -> bool {
    core.loaded
        && (should_browse(core)
            || !core.links.is_empty()
            || core.pairing.is_some()
            || core.unsaved.pending()
            // Still running, so the next reconcile has something to stop.
            || core.browser.is_some()
            || core.listener.is_some())
}

fn paired_key_set(core: &Core) -> HashSet<String> {
    core.devices
        .values()
        .filter(|device| !device.access_removed)
        .map(|device| device.fingerprint.clone())
        .collect()
}

fn dial_candidates(core: &Core, device: &DeviceRecord) -> Vec<SocketAddr> {
    let nearby = core
        .nearby
        .values()
        .filter(|entry| entry.matched.as_deref() == Some(device.fingerprint.as_str()))
        .flat_map(|entry| entry.addresses.iter().copied());
    let stored = device
        .addresses
        .iter()
        .filter_map(|text| text.parse::<SocketAddr>().ok());
    // Deduplicated before the cap, so one address seen by several services
    // cannot push a different one out.
    let mut addresses: Vec<SocketAddr> = Vec::new();
    for address in nearby.chain(stored).map(canonical_socket) {
        if !addresses.contains(&address) {
            addresses.push(address);
        }
    }
    // A device is a set of addresses to try. VPN addresses go last, and the
    // same LAN seen twice costs nothing: the first proof of the key wins.
    addresses.sort_by_key(|address| address_is_vpn_range(address.ip()));
    addresses.truncate(MAX_ADDRESSES);
    addresses
}

fn usable_addresses(service: ResolvedService) -> Vec<SocketAddr> {
    let mut addresses: Vec<SocketAddr> = Vec::new();
    for address in service.addresses.into_iter().map(canonical_socket) {
        if address_is_usable(address.ip()) && !addresses.contains(&address) {
            addresses.push(address);
        }
    }
    addresses.truncate(MAX_ADDRESSES);
    addresses
}

fn short_fingerprint(fingerprint: &str) -> String {
    fingerprint.chars().take(12).collect()
}

impl Inner {
    fn lock(&self) -> MutexGuard<'_, Core> {
        self.core.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn snapshot(&self) -> RemoteSnapshot {
        let core = self.lock();
        build_snapshot(
            &core,
            self.generation.load(Ordering::Acquire),
            self.identity.get().map(|identity| identity.fingerprint.clone()),
        )
    }

    /// Scheduling and App Nap protection follow live viewers, not the hosting
    /// switch, so an idle host saves power as usual.
    fn refresh_keep_active(self: &Arc<Self>) {
        let live = self.lock().links.values().any(|link| {
            link.role == Role::Host && link.is_paired() && link.is_open()
        });
        apply_keep_active(self, live);
        hostbridge::refresh(self);
    }

    /// Tells the renderer. The payload has no secrets: public fingerprints,
    /// names and the short-lived pairing state the user is looking at.
    fn changed(&self) {
        self.generation.fetch_add(1, Ordering::AcqRel);
        if let Some(app) = self.app.get() {
            let _ = app.emit(CHANGED_EVENT, self.snapshot());
        }
    }

    fn write_database(&self)->Option<WriteDatabase>{
        #[cfg(test)]
        if let Some(database)=self.test_database.get(){return Some(WriteDatabase::Memory(database.clone()));}
        self.app.get().cloned().map(WriteDatabase::App)
    }
    #[cfg(test)]
    fn install_test_database(&self,connection:Connection)->Result<Arc<StdMutex<Connection>>,String>{
        store::init(&connection).map_err(|error|error.to_string())?;
        let database=Arc::new(StdMutex::new(connection));
        self.test_database.set(database.clone()).map_err(|_|"This fixture already has a database.".to_string())?;
        Ok(database)
    }

    /// For reads only: every write goes through `enqueue_write`.
    async fn read_db<T: Send + 'static>(
        &self,
        work: impl FnOnce(&mut Connection) -> Result<T, String> + Send + 'static,
    ) -> Result<T, String> {
        const FAILED: &str = "Mythra Code could not read its saved data. Try again.";
        let database = self.write_database().ok_or(FAILED)?.connection().map_err(|_|FAILED.to_string())?;
        let task = tauri::async_runtime::spawn_blocking(move || {
            let mut connection =
                crate::lock_state_db(&database).map_err(|_| FAILED.to_string())?;
            work(&mut connection)
        });
        match timeout(DB_WAIT, task).await {
            Ok(Ok(result)) => result,
            _ => Err(FAILED.into()),
        }
    }

    /// Takes a place in the one write order. Call this while holding `core`, at
    /// the moment the decision is made, so writes land in the order they were
    /// decided. It never blocks. The caller awaits the receiver for the real
    /// outcome. Only a full queue fails at once, and then nothing was written.
    fn enqueue_write<T: Send + 'static>(
        &self,
        background: bool,
        work: impl FnOnce(&mut Connection) -> Result<T, String> + Send + 'static,
    ) -> oneshot::Receiver<Result<T, String>> {
        let (sender, receiver) = oneshot::channel();
        let Some(database) = self.write_database() else {
            let _ = sender.send(Err(SAVE_FAILED.to_string()));
            return receiver;
        };
        let limit = if background {
            MAX_BACKGROUND_WRITES
        } else {
            MAX_QUEUED_WRITES
        };
        let start = {
            let mut queue = self.writes.lock().unwrap_or_else(PoisonError::into_inner);
            if queue.jobs.len() >= limit {
                drop(queue);
                let _ = sender.send(Err(SAVE_FAILED.to_string()));
                return receiver;
            }
            queue.jobs.push_back(Box::new(move |connection| {
                let result = match connection {
                    Some(connection) => work(connection),
                    None => Err(SAVE_FAILED.to_string()),
                };
                let _ = sender.send(result);
            }));
            !std::mem::replace(&mut queue.running, true)
        };
        if start {
            let queue = self.writes.clone();
            tauri::async_runtime::spawn_blocking(move || drain_writes(database, queue));
        }
        receiver
    }

    /// Queues whatever memory now says about one device: its whole record, or
    /// its removal. Call while holding `core`.
    fn enqueue_device_state(
        &self,
        core: &Core,
        fingerprint: &str,
    ) -> oneshot::Receiver<Result<(), String>> {
        match core.devices.get(fingerprint).cloned() {
            Some(record) => {
                self.enqueue_write(false, move |connection| store::save_device(connection, &record))
            }
            None => {
                let fingerprint = fingerprint.to_string();
                self.enqueue_write(false, move |connection| {
                    store::delete_device(connection, &fingerprint)
                })
            }
        }
    }

    /// Queues details only, never a grant. See `store::update_device_details`.
    /// Best effort: the next change saves the same fields again.
    fn enqueue_details(&self, record: DeviceRecord) {
        let _ = self.enqueue_write(true, move |connection| {
            store::update_device_details(connection, &record)
        });
    }

    /// A narrowing change failed to save. Memory keeps it, and the supervisor
    /// keeps trying.
    fn note_unsaved(&self, change: impl FnOnce(&mut Unsaved)) {
        {
            let mut core = self.lock();
            change(&mut core.unsaved);
            core.unsaved.retry_at = Some(Instant::now() + UNSAVED_RETRY);
        }
        self.wake.notify_one();
    }

    /// Bounded, for exit only.
    fn flush_writes(&self, wait: Duration) {
        let deadline = Instant::now() + wait;
        loop {
            let idle = {
                let queue = self.writes.lock().unwrap_or_else(PoisonError::into_inner);
                queue.jobs.is_empty() && !queue.running
            };
            if idle || Instant::now() >= deadline {
                return;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    async fn ensure_identity(self: &Arc<Self>) -> Result<Arc<DeviceIdentity>, String> {
        if let Some(identity) = self.identity.get() {
            return Ok(identity.clone());
        }
        let app = self.app.get().ok_or("Mythra Code is still starting.")?;
        let publish = self.clone();
        identity::load_or_create(app, &self.identity_gate, move |identity| {
            let _ = publish.identity.set(identity);
        })
        .await
    }

    /// Records what a proven peer says about itself. Only called once the peer
    /// is known to be paired, so strangers cannot write into the device table.
    /// `viewer_authorized` means this device just connected as a viewer, which
    /// is the only thing here that can clear Access removed. Being viewed says
    /// nothing about being allowed to view.
    fn note_peer(
        &self,
        fingerprint: &str,
        name: Option<String>,
        platform: Option<String>,
        address: Option<String>,
        viewer_authorized: bool,
    ) {
        let mut core = self.lock();
        let Some(device) = core.devices.get_mut(fingerprint) else {
            return;
        };
        let platform =
            platform.filter(|platform| matches!(platform.as_str(), "macos" | "windows" | "other"));
        let mut changed = false;
        if let Some(name) = name.filter(|name| *name != device.name) {
            device.name = name;
            changed = true;
        }
        if platform.is_some() && platform != device.platform {
            device.platform = platform;
            changed = true;
        }
        if let Some(address) = address {
            if device.addresses.first() != Some(&address) {
                device.addresses.retain(|existing| *existing != address);
                device.addresses.insert(0, address);
                device.addresses.truncate(MAX_ADDRESSES);
                changed = true;
            }
        }
        if viewer_authorized && device.access_removed {
            device.access_removed = false;
            changed = true;
        }
        device.last_seen_at = Some(crate::unix_timestamp_ms() as i64);
        // Otherwise last_seen_at is saved when the link ends.
        if changed {
            let record = device.clone();
            self.enqueue_details(record);
        }
    }

    async fn link_finished(self: &Arc<Self>, link: &Arc<Link>) {
        hostbridge::link_closed(self, link);
        pairing::link_ended(self, link);
        pairing::flow_link_ended(self, link);
        {
            let mut core = self.lock();
            core.links.remove(&link.id);
            if let Some(dial) = core.dials.get_mut(&link.peer_fingerprint) {
                dial.attempt = 0;
                dial.next_at = Instant::now() + Duration::from_secs(RECONNECT_BACKOFF[0]);
            }
            let dropped = link.is_paired()
                && link.role == Role::Viewer
                && !matches!(link.close_reason(), Some(CloseReason::Replaced));
            let replaced_elsewhere = core.links.values().any(|other| {
                other.peer_fingerprint == link.peer_fingerprint
                    && other.role == Role::Viewer
                    && other.is_paired()
            });
            let can_view = core
                .devices
                .get(&link.peer_fingerprint)
                .is_some_and(|device| device.they_host);
            if dropped && !replaced_elsewhere && can_view {
                core.dials
                    .entry(link.peer_fingerprint.clone())
                    .or_insert_with(DialState::new)
                    .lost = true;
            }
            if link.is_paired() {
                if let Some(device) = core.devices.get_mut(&link.peer_fingerprint) {
                    device.last_seen_at = Some(crate::unix_timestamp_ms() as i64);
                    let record = device.clone();
                    self.enqueue_details(record);
                }
            }
        }
        self.refresh_keep_active();
        self.changed();
        self.wake.notify_one();
    }

    /// The pinned key said no. Ignored if the relationship changed since the
    /// attempt began, so a stale answer cannot mark a newer pairing.
    fn mark_access_removed(&self, fingerprint: &str, relationship: u64) {
        let mut core = self.lock();
        if core.relationship(fingerprint) != relationship {
            return;
        }
        if let Some(device) = core.devices.get_mut(fingerprint).filter(|device| device.they_host) {
            device.access_removed = true;
            let record = device.clone();
            self.enqueue_details(record);
        }
    }

    /// Addresses and a display label for a nearby service, resolving now if
    /// the supervisor has not got to it yet.
    async fn nearby_target(&self, instance: &str) -> Result<(Vec<SocketAddr>, String), String> {
        const GONE: &str = "That device is no longer nearby. Look for it again.";
        if !instance_is_valid(instance) {
            return Err(GONE.into());
        }
        let known = {
            let core = self.lock();
            let entry = core.nearby.get(instance).ok_or(GONE)?;
            // Every service that proved this key is the same device, so all of
            // their addresses are worth trying.
            let mut addresses = entry.addresses.clone();
            if entry.proven.is_some() {
                for other in core.nearby.values().filter(|other| other.proven == entry.proven) {
                    for address in &other.addresses {
                        if !addresses.contains(address) {
                            addresses.push(*address);
                        }
                    }
                }
            }
            addresses.truncate(MAX_ADDRESSES);
            (addresses, entry.name.clone(), entry.id)
        };
        let (addresses, name) = if known.0.is_empty() {
            let name = instance.to_string();
            let resolved = tauri::async_runtime::spawn_blocking(move || {
                platform::resolve(&name, RESOLVE_WAIT)
            })
            .await
            .map_err(|_| GONE.to_string())?
            .map_err(|_| GONE.to_string())?;
            let addresses=usable_addresses(resolved);
            if let Some(entry)=self.lock().nearby.get_mut(instance).filter(|entry|entry.id==known.2){
                entry.addresses=addresses.clone();entry.resolved_at=Some(Instant::now());entry.resolve_failures=0;
            }
            (addresses, known.1)
        } else {
            (known.0,known.1)
        };
        if addresses.is_empty() {
            return Err(GONE.into());
        }
        Ok((addresses, name.unwrap_or_else(|| NEARBY_FALLBACK_NAME.to_string())))
    }

    /// `generation` names the handle that produced the event. Anything from a
    /// handle that has since been retired is ignored.
    fn on_discovery(self: &Arc<Self>, event: DiscoveryEvent, advertising: bool, generation: u64) {
        {
            let mut core = self.lock();
            let current = if advertising {
                core.advertise_generation
            } else {
                core.browse_generation
            };
            if generation != current {
                return;
            }
            diagnostics::record(diagnostics::Event::Discovery,0,0,generation,0,if advertising{"advertise"}else{"browse"},match &event{DiscoveryEvent::Found(_)=>"found",DiscoveryEvent::Lost(_)=>"lost",DiscoveryEvent::Failed(DiscoveryFailure::Denied)=>"denied",DiscoveryEvent::Failed(DiscoveryFailure::NameConflict)=>"name_conflict",DiscoveryEvent::Failed(DiscoveryFailure::Unavailable(_))=>"failed",DiscoveryEvent::Narrowed=>"narrowed"});
            match event {
                DiscoveryEvent::Found(instance) => {
                    core.denied_since = None;
                    core.discovery_error = None;
                    let own = core
                        .advertised
                        .as_ref()
                        .is_some_and(|advertised| advertised.instance == instance);
                    if !own
                        && !core.nearby.contains_key(&instance)
                        && core.nearby.len() < MAX_SERVICES
                    {
                        let id = core.take_id();
                        core.nearby.insert(instance, NearbyEntry::new(id));
                    }
                }
                DiscoveryEvent::Lost(instance) => {
                    core.nearby.remove(&instance);
                }
                // Only the snapshot changes.
                DiscoveryEvent::Narrowed => {}
                DiscoveryEvent::Failed(failure) => {
                    let mut wait = DISCOVERY_RETRY;
                    match &failure {
                        DiscoveryFailure::Denied => {
                            let since = *core.denied_since.get_or_insert_with(Instant::now);
                            if since.elapsed() < PROMPT_GRACE {
                                wait = PROMPT_RETRY;
                            }
                        }
                        DiscoveryFailure::NameConflict => {}
                        DiscoveryFailure::Unavailable(message) => {
                            core.discovery_error = Some(message.clone());
                        }
                    }
                    // Stopped by the supervisor, never here: this runs on the
                    // thread that would have to be joined.
                    let retry = Some(Instant::now() + wait);
                    if advertising {
                        core.advertise_retry_at = retry;
                    } else {
                        core.browse_retry_at = retry;
                    }
                }
            }
        }
        self.dirty.store(true, Ordering::Release);
        self.wake.notify_one();
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DeviceView {
    fingerprint: String,
    short_fingerprint: String,
    name: String,
    platform: Option<String>,
    paired_at: i64,
    last_seen_at: Option<i64>,
    /// We can view this device.
    can_view: bool,
    /// This device can view us, within `grant`.
    grant: Option<DeviceGrant>,
    /// The viewing relationship alone. Being viewed never shows up here, and
    /// `none` means this device cannot view that one.
    state: &'static str,
    /// A live link where this device views that one.
    viewing: bool,
    /// A live link where that device views this one.
    hosting: bool,
    /// `this` or `peer`: which side must update before they can connect.
    update_on: Option<&'static str>,
    route: Option<&'static str>,
    rtt_ms: Option<u32>,
    app_version: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct NearbyView {
    instance: String,
    name: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RemoteSnapshot {
    generation: u64,
    ready: bool,
    platform: &'static str,
    device_name: String,
    fingerprint: Option<String>,
    hosting: bool,
    listening: bool,
    port: Option<u16>,
    share_name: bool,
    browsing: bool,
    searching: bool,
    /// `ok`, `waiting` while the OS prompt may still be open, or `blocked`.
    network_access: &'static str,
    discovery_error: Option<String>,
    host_error: Option<String>,
    /// True when Windows marks an advertised network Public. Null is unknown.
    public_network: Option<bool>,
    /// Network adapters Windows refused to announce on while others stayed up.
    refused_adapters: u32,
    /// A change took effect but is not on disk yet, and saving is being retried.
    /// Quitting now could undo it.
    unsaved_changes: bool,
    pairing: Option<PairingWindowView>,
    flow: Option<FlowView>,
    devices: Vec<DeviceView>,
    nearby: Vec<NearbyView>,
}

fn build_snapshot(core: &Core, generation: u64, fingerprint: Option<String>) -> RemoteSnapshot {
    let mut devices: Vec<DeviceView> = core
        .devices
        .values()
        .map(|device| {
            let find = |role: Role| {
                core.links.values().find(|link| {
                    link.peer_fingerprint == device.fingerprint
                        && link.role == role
                        && link.is_paired()
                        && link.is_open()
                })
            };
            let viewing = find(Role::Viewer);
            let hosting = find(Role::Host);
            let dial = core.dials.get(&device.fingerprint);
            let update_on = dial.and_then(|dial| dial.update_on);
            let state = if !device.they_host {
                "none"
            } else if viewing.is_some() {
                "connected"
            } else if device.access_removed {
                "accessRemoved"
            } else if update_on.is_some() {
                "incompatible"
            } else if dial.is_some_and(|dial| dial.lost) {
                "stale"
            } else if dial.is_some_and(|dial| dial.in_flight) {
                "connecting"
            } else if dial.is_some_and(|dial| dial.attempt >= 3) {
                "unreachable"
            } else {
                "offline"
            };
            let shown = viewing.or(hosting);
            DeviceView {
                fingerprint: device.fingerprint.clone(),
                short_fingerprint: short_fingerprint(&device.fingerprint),
                name: device.name.clone(),
                platform: device.platform.clone(),
                paired_at: device.paired_at,
                last_seen_at: device.last_seen_at,
                can_view: device.they_host,
                grant: device.grant.clone(),
                state,
                viewing: viewing.is_some(),
                hosting: hosting.is_some(),
                update_on,
                route: viewing.map(|link| if link.dialed { "direct" } else { "reverse" }),
                rtt_ms: shown
                    .map(|link| link.rtt_ms.load(Ordering::Relaxed))
                    .filter(|rtt| *rtt > 0),
                app_version: shown.map(|link| link.peer_version.clone()),
            }
        })
        .collect();
    devices.sort_by(|left, right| left.name.cmp(&right.name));
    let mut listed: Vec<(&String, &NearbyEntry)> = core
        .nearby
        .iter()
        .filter(|(_, entry)| {
            entry.matched.is_none()
                && !entry.addresses.is_empty()
                && !entry.proven.as_ref().is_some_and(|key| {
                    Some(key) == fingerprint.as_ref()
                        || core.devices.get(key).is_some_and(|device| !device.access_removed)
                })
        })
        .collect();
    listed.sort_by(|left, right| left.0.cmp(right.0));
    let mut seen_keys: HashSet<&String> = HashSet::new();
    let mut nearby: Vec<NearbyView> = listed
        .into_iter()
        .filter(|(_, entry)| entry.proven.as_ref().is_none_or(|key| seen_keys.insert(key)))
        .map(|(instance, entry)| NearbyView {
            instance: instance.clone(),
            name: entry
                .name
                .clone()
                .unwrap_or_else(|| NEARBY_FALLBACK_NAME.to_string()),
        })
        .collect();
    nearby.sort_by(|left, right| left.name.cmp(&right.name).then(left.instance.cmp(&right.instance)));
    RemoteSnapshot {
        generation,
        ready: core.loaded && !core.load_failed,
        platform: platform_name(),
        device_name: device_name(core),
        fingerprint,
        hosting: core.settings.hosting,
        listening: core.listener.is_some(),
        port: core.listener.as_ref().map(|listener| listener.port),
        share_name: core.settings.share_name,
        browsing: core.browser.is_some(),
        searching: core.search_until.is_some_and(|until| Instant::now() < until),
        network_access: network_access(core),
        discovery_error: core.discovery_error.clone(),
        host_error: core.host_error.clone(),
        public_network: core.public_network,
        refused_adapters: core
            .advertiser
            .as_ref()
            .map_or(0, Advertisement::refused_registrations),
        unsaved_changes: core.unsaved.pending(),
        pairing: core
            .pairing
            .as_ref()
            .filter(|window| window.is_open())
            .map(PairingWindow::view),
        flow: core.flow.as_ref().map(ViewerFlow::view),
        devices,
        nearby,
    }
}

// ---- Listener ----

fn bind_listener(address: SocketAddr) -> std::io::Result<TcpListener> {
    let socket = Socket::new(Domain::for_address(address), Type::STREAM, Some(Protocol::TCP))?;
    if address.is_ipv6() {
        socket.set_only_v6(true)?;
    }
    // On Windows this flag would let another process take the port.
    #[cfg(unix)]
    socket.set_reuse_address(true)?;
    socket.set_nonblocking(true)?;
    socket.bind(&address.into())?;
    socket.listen(32)?;
    TcpListener::from_std(socket.into())
}

fn bind_listeners(preferred: Option<u16>) -> std::io::Result<(TcpListener, Option<TcpListener>, u16)> {
    let any_v4 = |port| SocketAddr::new(IpAddr::V4(Ipv4Addr::UNSPECIFIED), port);
    let first = preferred
        .filter(|port| *port != 0)
        .and_then(|port| bind_listener(any_v4(port)).ok());
    let v4 = match first {
        Some(listener) => listener,
        None => bind_listener(any_v4(0))?,
    };
    let port = v4.local_addr()?.port();
    // IPv6 is a convenience; IPv4 is enough to carry on without it.
    let v6 = bind_listener(SocketAddr::new(IpAddr::V6(Ipv6Addr::UNSPECIFIED), port)).ok();
    Ok((v4, v6, port))
}

fn spawn_accept_loop(
    inner: Arc<Inner>,
    listener: TcpListener,
    acceptor: TlsAcceptor,
    generation: u64,
    mut stop: watch::Receiver<bool>,
) {
    tauri::async_runtime::spawn(async move {
        loop {
            let accepted = tokio::select! {
                _ = stop.wait_for(|stopped| *stopped) => return,
                accepted = listener.accept() => accepted,
            };
            match accepted {
                Ok((tcp, peer)) => {
                    diagnostics::record(diagnostics::Event::Link,0,0,0,1,"tls.accept","tcp_received");
                    tauri::async_runtime::spawn(session::accept(
                        inner.clone(),
                        acceptor.clone(),
                        tcp,
                        peer,
                        generation,
                    ));
                }
                // Out of file descriptors and the like. Never spin.
                Err(_) => tokio::time::sleep(Duration::from_millis(200)).await,
            }
        }
    });
}

async fn start_listener(inner: &Arc<Inner>, identity: &Arc<DeviceIdentity>) -> Result<(), String> {
    const FAILED: &str = "Mythra Code couldn't open a network port. Close anything that might be blocking it, then try again.";
    let preferred = inner.lock().settings.port;
    let config = tls::server_config(identity)?;
    let (v4, v6, port) = bind_listeners(preferred).map_err(|error|{diagnostics::record(diagnostics::Event::Start,0,0,0,0,"listener",diagnostics::network_outcome(&error));FAILED.to_string()})?;
    diagnostics::record(diagnostics::Event::Start,0,0,0,if v6.is_some(){2}else{1},"listener","listening");
    let (stop, stopped) = watch::channel(false);
    let generation = {
        let mut core = inner.lock();
        // The reason to listen may have gone while the sockets were opening.
        if inner.exiting.load(Ordering::Acquire)
            || !wants_listener(&core)
            || core.listener.is_some()
        {
            return Ok(());
        }
        core.settings.port = Some(port);
        let temporary = !core.settings.hosting;
        let generation = core.take_id();
        core.listener = Some(ListenerHandle { port, temporary, generation, stop });
        if preferred != Some(port) {
            // Only a preference, so a failed save costs a different port next time.
            let _ = inner.enqueue_write(true, move |connection| {
                store::set_port(connection, port).map_err(|error| error.to_string())
            });
        }
        generation
    };
    let acceptor = TlsAcceptor::from(config);
    spawn_accept_loop(inner.clone(), v4, acceptor.clone(), generation, stopped.clone());
    if let Some(v6) = v6 {
        spawn_accept_loop(inner.clone(), v6, acceptor, generation, stopped);
    }
    Ok(())
}

fn random_instance() -> Result<String, String> {
    let mut bytes = [0u8; 4];
    getrandom::fill(&mut bytes).map_err(|_| "Could not create a secure random value.".to_string())?;
    Ok(format!(
        "{}{:02x}{:02x}{:02x}{:02x}",
        discovery::types::INSTANCE_PREFIX,
        bytes[0],
        bytes[1],
        bytes[2],
        bytes[3]
    ))
}

fn discovery_sink(inner: &Arc<Inner>, advertising: bool, generation: u64) -> DiscoverySink {
    let inner = Arc::downgrade(inner);
    Arc::new(move |event| {
        if let Some(inner) = inner.upgrade() {
            inner.on_discovery(event, advertising, generation);
        }
    })
}

/// One TXT string holds 255 bytes including `n=`. Cut on a character boundary.
fn txt_safe_name(name: &str) -> String {
    let mut end = name.len().min(MAX_TXT_NAME_BYTES);
    while !name.is_char_boundary(end) {
        end -= 1;
    }
    name[..end].to_string()
}

/// Drops slow OS handles away from async workers and any lock.
fn drop_off_runtime<T: Send + 'static>(value: T) {
    tauri::async_runtime::spawn_blocking(move || drop(value));
}

#[cfg(target_os = "macos")]
fn apply_keep_active(inner: &Inner, keep_active: bool) {
    {
        let mut core = inner.lock();
        if core.activity.is_some() == keep_active {
            return;
        }
        core.activity = keep_active.then(macos_activity::HostingActivity::begin);
    }
    if let Some(window) = inner.app.get().and_then(|app| app.get_webview_window("main")) {
        let _ = window.with_webview(move |webview| {
            crate::macos_text::set_keep_active(webview.inner(), keep_active);
        });
    }
}

#[cfg(not(target_os = "macos"))]
fn apply_keep_active(_inner: &Inner, _keep_active: bool) {}

/// Brings listening, advertising and browsing in line with the settings. The
/// reasons can change during a pass, so every start rechecks them under the lock
/// at the moment it installs its resource, and a pass that lost its reason
/// releases what it just opened.
async fn reconcile(inner: &Arc<Inner>) {
    let _guard = inner.lifecycle.lock().await;
    if inner.exiting.load(Ordering::Acquire) {
        return;
    }
    let now = Instant::now();
    let (listen, wants_identity, stale) = {
        let mut core = inner.lock();
        if !core.loaded {
            return;
        }
        if core.search_until.is_some_and(|until| now >= until) {
            core.search_until = None;
        }
        let listen = wants_listener(&core);
        let mut stale: Vec<Box<dyn std::any::Any + Send>> = Vec::new();
        if core.advertise_retry_at.is_some() {
            if let Some(advertisement) = core.retire_advertiser() {
                stale.push(Box::new(advertisement));
            }
        }
        if core.browse_retry_at.is_some() {
            if let Some(browser) = core.retire_browser() {
                stale.push(Box::new(browser));
            }
        }
        let wants_identity = (listen || !core.devices.is_empty())
            && core.identity_retry_at.is_none_or(|at| now >= at);
        (listen, wants_identity, stale)
    };
    if !stale.is_empty() {
        drop_off_runtime(stale);
    }

    if wants_identity && inner.identity.get().is_none() {
        match inner.ensure_identity().await {
            Ok(_) => {
                let mut core = inner.lock();
                core.identity_retry_at = None;
                core.host_error = None;
            }
            Err(message) => {
                let mut core = inner.lock();
                core.identity_retry_at = Some(now + IDENTITY_RETRY);
                core.host_error = Some(message);
            }
        }
    }

    if listen {
        if let Some(identity) = inner.identity.get().cloned() {
            if inner.lock().listener.is_none() {
                match start_listener(inner, &identity).await {
                    Ok(()) => inner.lock().host_error = None,
                    Err(message) => inner.lock().host_error = Some(message),
                }
            }
        }
        reconcile_advertisement(inner, now);
    } else {
        stop_listening(inner);
    }

    let browse_generation = {
        let mut core = inner.lock();
        let start = should_browse(&core)
            && !inner.exiting.load(Ordering::Acquire)
            && core.browser.is_none()
            && core.browse_retry_at.is_none_or(|at| now >= at);
        start.then(|| {
            core.browse_retry_at = None;
            core.browse_generation = core.take_id();
            core.browse_generation
        })
    };
    if let Some(generation) = browse_generation {
        match platform::browse(discovery_sink(inner, false, generation)) {
            Ok(browser) => {
                let unwanted = {
                    let mut core = inner.lock();
                    let wanted = core.browse_generation == generation
                        && should_browse(&core)
                        && !inner.exiting.load(Ordering::Acquire);
                    if wanted {
                        core.browser = Some(browser);
                        core.browse_started_at = Some(now);
                        None
                    } else {
                        Some(browser)
                    }
                };
                if let Some(browser) = unwanted {
                    drop_off_runtime(browser);
                }
            }
            Err(failure) => inner.on_discovery(DiscoveryEvent::Failed(failure), false, generation),
        }
    } else {
        let browser = {
            let mut core = inner.lock();
            if should_browse(&core) {
                None
            } else {
                core.nearby.clear();
                core.retire_browser()
            }
        };
        if let Some(browser) = browser {
            drop_off_runtime(browser);
        }
    }
}

fn reconcile_advertisement(inner: &Arc<Inner>, now: Instant) {
    let (wanted, generation) = {
        let mut core = inner.lock();
        let Some(port) = core.listener.as_ref().map(|listener| listener.port) else {
            return;
        };
        if core.advertiser.is_some() || core.advertise_retry_at.is_some_and(|at| now < at) {
            return;
        }
        core.advertise_retry_at = None;
        let mut txt = vec![("v".to_string(), "1".to_string())];
        if core.settings.share_name {
            txt.push(("n".to_string(), txt_safe_name(&device_name(&core))));
        }
        // Regenerated each time, so an observer cannot follow the instance.
        let Ok(instance) = random_instance() else {
            return;
        };
        let request = AdvertiseRequest { instance, port, txt };
        core.advertised = Some(request.clone());
        core.advertise_generation = core.take_id();
        (request, core.advertise_generation)
    };
    match platform::advertise(&wanted, discovery_sink(inner, true, generation)) {
        Ok(advertisement) => {
            let unwanted = {
                let mut core = inner.lock();
                let listening = core
                    .listener
                    .as_ref()
                    .is_some_and(|listener| listener.port == wanted.port);
                let current = core.advertise_generation == generation
                    && listening
                    && wants_listener(&core)
                    && !inner.exiting.load(Ordering::Acquire);
                if current {
                    core.advertiser = Some(advertisement);
                    None
                } else {
                    Some(advertisement)
                }
            };
            if let Some(advertisement) = unwanted {
                drop_off_runtime(advertisement);
            }
        }
        Err(failure) => inner.on_discovery(DiscoveryEvent::Failed(failure), true, generation),
    }
}

/// Rule 1: with no reason to listen there is no listener and no advertisement.
/// Links this device dialed as a viewer always stay. When the user turned
/// hosting off, links through the listener go too. When only a temporary
/// listener ended, paired links where this device is the viewer stay: they
/// expose nothing here, and closing them would undo the reverse pairing that
/// just finished.
fn stop_listening(inner: &Arc<Inner>) {
    let (listener, advertiser, links) = {
        let mut core = inner.lock();
        if wants_listener(&core) {
            return;
        }
        hostbridge::hosting_stopped_locked(inner, &mut core);
        core.advertise_retry_at = None;
        let was_temporary = !core.settings.hosting
            && core.listener.as_ref().is_some_and(|listener| listener.temporary);
        (
            core.listener.take(),
            core.retire_advertiser(),
            core.links
                .values()
                .filter(|link| {
                    let viewer = link.role == Role::Viewer;
                    !(viewer && (link.dialed || (was_temporary && link.is_paired())))
                })
                .cloned()
                .collect::<Vec<_>>(),
        )
    };
    let was_listening = listener.is_some();
    if let Some(listener) = listener {
        let _ = listener.stop.send(true);
    }
    if let Some(advertiser) = advertiser {
        drop_off_runtime(advertiser);
    }
    if was_listening {
        for link in links {
            link.close(CloseReason::HostingOff);
        }
        pairing::close_window(inner);
    }
}

/// Replaces the announcement, for example after the name changes.
fn refresh_advertisement(inner: &Arc<Inner>) {
    let advertiser = inner.lock().retire_advertiser();
    if let Some(advertiser) = advertiser {
        drop_off_runtime(advertiser);
    }
    inner.wake.notify_one();
}

/// While advertising, and only then: compares the network with what was
/// announced, and rebuilds the announcement only if it changed.
async fn check_network(inner: &Arc<Inner>) {
    let now = SystemTime::now();
    {
        let mut core = inner.lock();
        let due = core.advertiser.is_some()
            && core.network_checked_at.is_none_or(|at| {
                now.duration_since(at).map_or(true, |elapsed| elapsed >= NETWORK_RECHECK)
            });
        if !due {
            return;
        }
        core.network_checked_at = Some(now);
    }
    let task = tauri::async_runtime::spawn_blocking(platform::network_status);
    let status = match timeout(NETWORK_CHECK_WAIT, task).await {
        Ok(Ok(status)) => status,
        // Unknown, and the announcement stays as it is.
        _ => {
            let mut core = inner.lock();
            if core.public_network.take().is_some() {
                inner.dirty.store(true, Ordering::Release);
            }
            return;
        }
    };
    let changed = {
        let mut core = inner.lock();
        if core.advertiser.is_none() {
            return;
        }
        if core.public_network != status.public {
            core.public_network = status.public;
            inner.dirty.store(true, Ordering::Release);
        }
        core.advertiser
            .as_ref()
            .is_some_and(|advertiser| advertiser.network() != status.fingerprint)
    };
    if changed {
        refresh_advertisement(inner);
    }
}

// ---- Supervisor ----

fn begin_task(counter: &AtomicU32, limit: usize) -> bool {
    counter
        .fetch_update(Ordering::AcqRel, Ordering::Acquire, |active| {
            ((active as usize) < limit).then_some(active + 1)
        })
        .is_ok()
}

fn schedule_resolves(inner: &Arc<Inner>) {
    let now = Instant::now();
    let due: Vec<(String, u64)> = {
        let core = inner.lock();
        core.nearby
            .iter()
            .filter(|(_, entry)| {
                !entry.resolving
                    && entry
                        .resolved_at
                        .is_none_or(|at| now.duration_since(at) >= RESOLVE_REFRESH)
            })
            .map(|(instance, entry)| (instance.clone(), entry.id))
            .collect()
    };
    for (instance, entry_id) in due {
        if !begin_task(&inner.active_resolves, MAX_RESOLVES) {
            return;
        }
        if let Some(entry) = inner
            .lock()
            .nearby
            .get_mut(&instance)
            .filter(|entry| entry.id == entry_id)
        {
            entry.resolving = true;
        }
        let inner = inner.clone();
        tauri::async_runtime::spawn(async move {
            let name = instance.clone();
            let result = tauri::async_runtime::spawn_blocking(move || {
                platform::resolve(&name, RESOLVE_WAIT)
            })
            .await;
            inner.active_resolves.fetch_sub(1, Ordering::AcqRel);
            {
                let mut core = inner.lock();
                let mut drop_entry = false;
                if let Some(entry) = core
                    .nearby
                    .get_mut(&instance)
                    .filter(|entry| entry.id == entry_id)
                {
                    entry.resolving = false;
                    entry.resolved_at = Some(Instant::now());
                    match result {
                        Ok(Ok(service)) => {
                            entry.resolve_failures = 0;
                            entry.name = service
                                .txt
                                .iter()
                                .find(|(key, _)| key == "n")
                                .and_then(|(_, value)| clean_name(value));
                            entry.addresses = usable_addresses(service);
                        }
                        _ => {
                            entry.resolve_failures += 1;
                            drop_entry = entry.resolve_failures >= RESOLVE_FAILURES_BEFORE_DROP;
                        }
                    }
                }
                if drop_entry {
                    core.nearby.remove(&instance);
                }
            }
            inner.changed();
            inner.wake.notify_one();
        });
    }
}

fn schedule_probes(inner: &Arc<Inner>) {
    let Some(identity) = inner.identity.get().cloned() else {
        return;
    };
    let now = Instant::now();
    let (keys, due): (HashSet<String>, Vec<(String, u64, Vec<SocketAddr>)>) = {
        let core = inner.lock();
        let keys = paired_key_set(&core);
        let due = core
            .nearby
            .iter()
            .filter(|(_, entry)| {
                entry.matched.is_none()
                    && !entry.probing
                    && !entry.addresses.is_empty()
                    && now >= entry.probe_at
            })
            .map(|(instance, entry)| (instance.clone(), entry.id, entry.addresses.clone()))
            .collect();
        (keys, due)
    };
    // Probing runs with nothing paired too. An empty set rejects every server
    // before anything of ours is sent, and the proven key still identifies it.
    for (instance, entry_id, addresses) in due {
        if !begin_task(&inner.active_probes, MAX_PROBES) {
            return;
        }
        if let Some(entry) = inner
            .lock()
            .nearby
            .get_mut(&instance)
            .filter(|entry| entry.id == entry_id)
        {
            entry.probing = true;
        }
        let inner = inner.clone();
        let identity = identity.clone();
        let keys = keys.clone();
        tauri::async_runtime::spawn(async move {
            let mut matched = None;
            let mut proven = None;
            let mut retry = PROBE_RETRY_UNREACHABLE;
            for address in addresses {
                let policy = ServerKeyPolicy::PairedSet(keys.clone());
                match session::dial(&inner, &identity, address, policy, DialPurpose::Paired).await {
                    Ok(link) => {
                        proven = Some(link.peer_fingerprint.clone());
                        matched = proven.clone();
                        break;
                    }
                    Err(DialError::NotNeeded(fingerprint)) => {
                        proven = Some(fingerprint.clone());
                        matched = Some(fingerprint);
                        break;
                    }
                    Err(DialError::KeyRejected(key)) => {
                        // Not a paired device: it stays "nearby, available to pair".
                        proven = key;
                        retry = PROBE_RETRY_UNKNOWN;
                        break;
                    }
                    Err(_) => {}
                }
            }
            inner.active_probes.fetch_sub(1, Ordering::AcqRel);
            if let Some(entry) = inner
                .lock()
                .nearby
                .get_mut(&instance)
                .filter(|entry| entry.id == entry_id)
            {
                entry.probing = false;
                entry.probe_at = Instant::now() + retry;
                entry.matched = matched;
                if proven.is_some() {
                    entry.proven = proven;
                }
            }
            inner.changed();
            inner.wake.notify_one();
        });
    }
}

fn schedule_dials(inner: &Arc<Inner>) {
    let Some(identity) = inner.identity.get().cloned() else {
        return;
    };
    let now = Instant::now();
    let due: Vec<(String, Vec<SocketAddr>)> = {
        let mut core = inner.lock();
        let fingerprints: Vec<(String, Role)> = core
            .devices
            .keys()
            .filter_map(|fingerprint| {
                role_for_peer(&core, fingerprint).map(|role| (fingerprint.clone(), role))
            })
            .collect();
        let mut due = Vec::new();
        for (fingerprint, role) in fingerprints {
            let Some(device) = core.devices.get(&fingerprint) else {
                continue;
            };
            // A probe already holds this peer and role.
            if core.reservations.contains(&(fingerprint.clone(), role)) {
                continue;
            }
            let addresses = dial_candidates(&core, device);
            if addresses.is_empty() {
                continue;
            }
            let dial = core.dials.entry(fingerprint.clone()).or_insert_with(DialState::new);
            if dial.in_flight || now < dial.next_at {
                continue;
            }
            due.push((fingerprint, addresses));
        }
        due
    };
    for (fingerprint, addresses) in due {
        if !begin_task(&inner.active_dials, MAX_DIALS) {
            return;
        }
        if let Some(dial) = inner.lock().dials.get_mut(&fingerprint) {
            dial.in_flight = true;
        }
        inner.changed();
        let inner = inner.clone();
        let identity = identity.clone();
        tauri::async_runtime::spawn(async move {
            let mut outcome = Err(DialError::Unreachable);
            for address in addresses {
                let policy = ServerKeyPolicy::Pinned(fingerprint.clone());
                outcome = session::dial(&inner, &identity, address, policy, DialPurpose::Paired)
                    .await
                    .map(|_| ());
                if matches!(
                    outcome,
                    Ok(())
                        | Err(DialError::UpdateRequired
                            | DialError::PeerUpdateRequired
                            | DialError::NotAllowed
                            | DialError::NotAccepting
                            | DialError::NotNeeded(_))
                ) {
                    break;
                }
            }
            inner.active_dials.fetch_sub(1, Ordering::AcqRel);
            if matches!(outcome, Err(DialError::Unreachable | DialError::LocalNetworkMayBeBlocked)) {
                pairing::request_reverse_link(&inner, &fingerprint).await;
            }
            finish_dial(&inner, &fingerprint, outcome).await;
        });
    }
}

async fn finish_dial(inner: &Arc<Inner>, fingerprint: &str, outcome: Result<(), DialError>) {
    {
        let mut core = inner.lock();
        if outcome.is_ok() {
            core.denied_since = None;
        }
        let dial = core
            .dials
            .entry(fingerprint.to_string())
            .or_insert_with(DialState::new);
        dial.in_flight = false;
        match outcome {
            Ok(()) => {
                dial.attempt = 0;
                dial.update_on = None;
            }
            Err(DialError::UpdateRequired) => {
                dial.update_on = Some(UPDATE_THIS_DEVICE);
                dial.next_at = Instant::now() + REFUSED_RETRY;
            }
            Err(DialError::PeerUpdateRequired) => {
                dial.update_on = Some(UPDATE_PEER);
                dial.next_at = Instant::now() + REFUSED_RETRY;
            }
            Err(DialError::NotAllowed) => {
                dial.next_at = Instant::now() + REFUSED_RETRY;
            }
            // Not a failure: a link serves this peer, or one is being made.
            Err(DialError::NotNeeded(_)) => {
                dial.attempt = 0;
                dial.next_at = Instant::now() + Duration::from_secs(RECONNECT_BACKOFF[0]);
            }
            Err(_) => {
                let delay = RECONNECT_BACKOFF[dial.attempt.min(RECONNECT_BACKOFF.len() - 1)];
                dial.attempt = dial.attempt.saturating_add(1);
                dial.next_at = Instant::now() + Duration::from_secs(delay);
            }
        }
    }
    inner.changed();
}

/// A browse that keeps running means the OS now allows it, for example after
/// the user turned Local Network access on in System Settings.
fn clear_stale_denial(inner: &Inner) {
    let mut core = inner.lock();
    let settled = core
        .browse_started_at
        .is_some_and(|started| started.elapsed() >= DENIAL_SETTLE);
    let stale = core.denied_since.is_some() || core.discovery_error.is_some();
    if stale && core.browser.is_some() && settled {
        core.denied_since = None;
        core.discovery_error = None;
        inner.dirty.store(true, Ordering::Release);
    }
}

/// Retries narrowing decisions from current memory, plus token-fenced viewer
/// undos. An outgoing cancellation never takes a full device/grant snapshot.
fn retry_unsaved(inner: &Arc<Inner>) {
    let now = Instant::now();
    let (devices, viewer_undos, hosting, share_name, saved) = {
        let mut core = inner.lock();
        if core.unsaved.retrying
            || !core.unsaved.pending()
            || core.unsaved.retry_at.is_some_and(|at| now < at)
        { return; }
        let devices: Vec<String> = core.unsaved.devices.iter()
            .filter(|fingerprint| !core.unpublished_device_saves.contains_key(*fingerprint))
            .cloned().collect();
        // Do not enqueue an empty retry every supervisor tick while a pairing
        // save is pending. Its finisher wakes us after publishing under core.
        if devices.is_empty() && core.unsaved.viewer_undos.is_empty()
            && !core.unsaved.hosting && !core.unsaved.share_name { return; }
        let unsaved = &mut core.unsaved;
        unsaved.retrying = true;
        for fingerprint in &devices { unsaved.devices.remove(fingerprint); }
        let viewer_undos: Vec<store::ViewerPairingUndo> = unsaved.viewer_undos.drain().map(|(_, undo)| undo).collect();
        let write_undos = viewer_undos.clone();
        let hosting = std::mem::take(&mut unsaved.hosting);
        let share_name = std::mem::take(&mut unsaved.share_name);
        let records: Vec<(String, Option<DeviceRecord>)> = devices
            .iter()
            .map(|fingerprint| (fingerprint.clone(), core.devices.get(fingerprint).cloned()))
            .collect();
        let hosting_value = hosting.then_some(core.settings.hosting);
        let share_value = share_name.then_some(core.settings.share_name);
        let saved = inner.enqueue_write(false, move |connection| {
            for (fingerprint, record) in &records {
                match record {
                    Some(record) => store::save_device(connection, record)?,
                    None => store::delete_device(connection, fingerprint)?,
                }
            }
            for undo in &write_undos {
                store::undo_pairing_viewer(connection, undo)?;
            }
            if let Some(enabled) = hosting_value {
                store::set_hosting(connection, enabled).map_err(|error| error.to_string())?;
            }
            if let Some(shared) = share_value {
                store::set_share_name(connection, shared).map_err(|error| error.to_string())?;
            }
            Ok(())
        });
        (devices, viewer_undos, hosting, share_name, saved)
    };
    let inner = inner.clone();
    tauri::async_runtime::spawn(async move {
        let result = finish_write(saved).await;
        {
            let mut core = inner.lock();
            core.unsaved.retrying = false;
            if result.is_err() {
                core.unsaved.devices.extend(devices);
                for undo in viewer_undos { core.unsaved.remember_viewer_undo(undo); }
                core.unsaved.hosting |= hosting;
                core.unsaved.share_name |= share_name;
                core.unsaved.retry_at = Some(Instant::now() + UNSAVED_RETRY);
            }
        }
        inner.changed();
        inner.wake.notify_one();
    });
}

async fn load(inner: &Arc<Inner>) {
    let default_name = sysinfo::System::host_name()
        .map(|name| name.trim_end_matches(".local").to_string())
        .and_then(|name| clean_name(&name))
        .unwrap_or_else(|| FALLBACK_NAME.to_string());
    let loaded = inner
        .read_db(|connection| {
            let settings = store::load_settings(connection).map_err(|error| error.to_string())?;
            let devices = store::load_devices(connection).map_err(|error| error.to_string())?;
            Ok((settings, devices))
        })
        .await;
    let version = inner
        .app
        .get()
        .map(|app| app.package_info().version.to_string())
        .unwrap_or_default();
    let mut core = inner.lock();
    core.default_name = default_name;
    core.app_version = version;
    core.loaded = true;
    match loaded {
        Ok((settings, devices)) => {
            core.settings = settings;
            core.devices = devices;
        }
        Err(_) => core.load_failed = true,
    }
}

async fn supervise(inner: Arc<Inner>) {
    load(&inner).await;
    inner.changed();
    loop {
        if inner.exiting.load(Ordering::Acquire) {
            return;
        }
        let active = feature_active(&inner.lock());
        if active {
            reconcile(&inner).await;
            check_network(&inner).await;
            clear_stale_denial(&inner);
            retry_unsaved(&inner);
            if inner.dirty.swap(false, Ordering::AcqRel) {
                inner.changed();
            }
            schedule_resolves(&inner);
            schedule_dials(&inner);
            schedule_probes(&inner);
            let _ = timeout(SUPERVISOR_TICK, inner.wake.notified()).await;
        } else {
            // Nothing is turned on, so nothing runs until a setting changes.
            inner.wake.notified().await;
        }
    }
}

/// Called once from setup. Never blocks startup and, with the feature off,
/// never touches the network or the credential store.
pub(crate) fn start(app: &AppHandle) {
    if crate::release_qa::active() {
        return;
    }
    let Some(state) = app.try_state::<RemoteState>() else {
        return;
    };
    if state.inner.app.set(app.clone()).is_err() {
        return;
    }
    diagnostics::start(app);
    tauri::async_runtime::spawn(supervise(state.inner.clone()));
}

/// Sends the DNS-SD goodbye and closes links so peers see the exit at once.
pub(crate) fn shutdown_on_exit(app: &AppHandle) {
    let Some(state) = app.try_state::<RemoteState>() else {
        return;
    };
    let inner = &state.inner;
    if inner.exiting.swap(true, Ordering::AcqRel) {
        return;
    }
    inner.wake.notify_one();
    let (listener, advertiser, browser, links) = {
        let mut core = inner.lock();
        hostbridge::shutdown_locked(inner, &mut core);
        (
            core.listener.take(),
            core.retire_advertiser(),
            core.retire_browser(),
            core.links.values().cloned().collect::<Vec<_>>(),
        )
    };
    if let Some(listener) = listener {
        let _ = listener.stop.send(true);
    }
    for link in links {
        link.close(CloseReason::Finished);
    }
    drop(advertiser);
    drop(browser);
    // One last try for anything not yet on disk, so a revoke made just before
    // quitting survives if the disk allows it.
    if inner.lock().unsaved.pending() {
        inner.lock().unsaved.retry_at = None;
        retry_unsaved(inner);
    }
    inner.flush_writes(EXIT_WRITE_WAIT);
}

// ---- Commands ----

/// Waits until the supervisor has read the saved state.
async fn ready(inner: &Arc<Inner>) -> Result<(), String> {
    for _ in 0..100 {
        {
            let core = inner.lock();
            if core.load_failed {
                return Err("Mythra Code could not read its device settings. Restart the app and try again.".into());
            }
            if core.loaded {
                return Ok(());
            }
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    Err("Mythra Code is still starting. Try again in a moment.".into())
}

fn current_snapshot(inner: &Arc<Inner>) -> RemoteSnapshot {
    inner.wake.notify_one();
    inner.snapshot()
}

#[tauri::command]
pub(crate) async fn remote_snapshot(state: State<'_, RemoteState>) -> Result<RemoteSnapshot, String> {
    Ok(state.inner.snapshot())
}

/// Hosting can stop without stopping a paired viewer's receive-only socket.
fn retire_hosting(inner: &Arc<Inner>) {
    let links = {
        let mut core = inner.lock();
        hostbridge::hosting_stopped_locked(inner, &mut core);
        if let Some(listener) = core.listener.as_mut() { listener.temporary = true; }
        core.links.values().filter(|link| link.role == Role::Host).cloned().collect::<Vec<_>>()
    };
    for link in links { link.close(session::CloseReason::HostingOff); }
}

/// Everything that follows a change to the hosting setting in memory.
async fn apply_hosting(inner: &Arc<Inner>, enabled: bool) {
    let upgrade = {
        let core = inner.lock();
        // A receive-only window can't become a real one: it has no invitation.
        core.pairing.as_ref().is_some_and(|window| window.temporary)
            || (!enabled && core.pairing.is_some())
    };
    if upgrade {
        pairing::close_window(inner);
    }
    if !enabled { retire_hosting(inner); }
    if enabled {
        // What was a temporary listener now serves hosting.
        if let Some(listener) = inner.lock().listener.as_mut() {
            listener.temporary = false;
        }
    }
    reconcile(inner).await;
    inner.changed();
}

/// Turning hosting off narrows access, so it takes effect at once and the save
/// is retried if it fails. Turning it on takes effect only once it is saved.
#[tauri::command]
pub(crate) async fn remote_set_hosting(
    state: State<'_, RemoteState>,
    enabled: bool,
) -> Result<RemoteSnapshot, String> {
    let inner = state.inner.clone();
    ready(&inner).await?;
    if enabled {
        // First use: this is where the device key is created.
        inner.ensure_identity().await?;
    }
    let (edit, saved) = {
        let mut core = inner.lock();
        core.edits.hosting = core.take_id();
        if !enabled {
            core.settings.hosting = false;
        }
        let saved = inner.enqueue_write(false, move |connection| {
            store::set_hosting(connection, enabled).map_err(|error| error.to_string())
        });
        (core.edits.hosting, saved)
    };
    if !enabled {
        apply_hosting(&inner, false).await;
        if finish_write(saved).await.is_err() {
            inner.note_unsaved(|unsaved| unsaved.hosting = true);
        }
        inner.changed();
        return Ok(current_snapshot(&inner));
    }
    finish_write(saved).await?;
    let applied = {
        let mut core = inner.lock();
        // A newer change, already applied, wins over this late result.
        let current = core.edits.hosting == edit;
        if current {
            core.settings.hosting = true;
        }
        current
    };
    if !applied {
        return Ok(current_snapshot(&inner));
    }
    apply_hosting(&inner, true).await;
    let failed = {
        let core = inner.lock();
        core.settings.hosting && core.listener.is_none()
    };
    if failed {
        let message = inner
            .lock()
            .host_error
            .clone()
            .unwrap_or_else(|| "Mythra Code couldn't turn on access. Try again.".to_string());
        return Err(message);
    }
    Ok(current_snapshot(&inner))
}

fn tell_paired_devices(inner: &Arc<Inner>) {
    let (links, update) = {
        let core = inner.lock();
        (
            core.links
                .values()
                .filter(|link| link.is_paired())
                .cloned()
                .collect::<Vec<_>>(),
            json!({ "name": device_name(&core), "platform": platform_name() }),
        )
    };
    for link in links {
        let update = update.clone();
        tauri::async_runtime::spawn(async move {
            let _ = link.request("device.update", update, PING_WAIT).await;
        });
    }
}

#[tauri::command]
pub(crate) async fn remote_set_device_name(
    state: State<'_, RemoteState>,
    name: String,
) -> Result<RemoteSnapshot, String> {
    let inner = state.inner.clone();
    ready(&inner).await?;
    let name = clean_name(&name).ok_or("Enter a name for this device.")?;
    let saved_name = name.clone();
    let (edit, saved) = {
        let mut core = inner.lock();
        core.edits.device_name = core.take_id();
        let saved = inner.enqueue_write(false, move |connection| {
            store::set_device_name(connection, &saved_name).map_err(|error| error.to_string())
        });
        (core.edits.device_name, saved)
    };
    finish_write(saved).await?;
    let (applied, shared) = {
        let mut core = inner.lock();
        let current = core.edits.device_name == edit;
        if current {
            core.settings.device_name = Some(name);
        }
        (current, core.settings.share_name)
    };
    if applied {
        if shared {
            refresh_advertisement(&inner);
        }
        tell_paired_devices(&inner);
        inner.changed();
    }
    Ok(current_snapshot(&inner))
}

/// Stopping sharing narrows what strangers can see, so it takes effect at once
/// and the save is retried. Starting to share takes effect once it is saved.
#[tauri::command]
pub(crate) async fn remote_set_share_name(
    state: State<'_, RemoteState>,
    shared: bool,
) -> Result<RemoteSnapshot, String> {
    let inner = state.inner.clone();
    ready(&inner).await?;
    let (edit, saved) = {
        let mut core = inner.lock();
        core.edits.share_name = core.take_id();
        if !shared {
            core.settings.share_name = false;
        }
        let saved = inner.enqueue_write(false, move |connection| {
            store::set_share_name(connection, shared).map_err(|error| error.to_string())
        });
        (core.edits.share_name, saved)
    };
    if !shared {
        refresh_advertisement(&inner);
        inner.changed();
        if finish_write(saved).await.is_err() {
            inner.note_unsaved(|unsaved| unsaved.share_name = true);
            inner.changed();
        }
        return Ok(current_snapshot(&inner));
    }
    finish_write(saved).await?;
    let applied = {
        let mut core = inner.lock();
        let current = core.edits.share_name == edit;
        if current {
            core.settings.share_name = true;
        }
        current
    };
    if applied {
        refresh_advertisement(&inner);
        inner.changed();
    }
    Ok(current_snapshot(&inner))
}

/// The user chose Find nearby devices. This is what allows browsing on a device
/// with hosting off and nothing paired.
#[tauri::command]
pub(crate) async fn remote_find_nearby(state: State<'_, RemoteState>) -> Result<RemoteSnapshot, String> {
    let inner = state.inner.clone();
    ready(&inner).await?;
    {
        let mut core = inner.lock();
        core.search_until = Some(Instant::now() + SEARCH_LIFETIME);
        core.browse_retry_at = None;
        // Also the Try again button: every device gets an attempt right now.
        core.advertise_retry_at = None;
        let now = Instant::now();
        for dial in core.dials.values_mut() {
            dial.attempt = 0;
            dial.next_at = now;
        }
        // A fresh grace period, in case the user has only just allowed access.
        core.denied_since = None;
        core.outgoing_denied_since = None;
    }
    reconcile(&inner).await;
    inner.changed();
    Ok(current_snapshot(&inner))
}

#[tauri::command]
pub(crate) async fn remote_pairing_open(state: State<'_, RemoteState>) -> Result<RemoteSnapshot, String> {
    let inner = state.inner.clone();
    ready(&inner).await?;
    pairing::open_window(&inner).await?;
    // With hosting off this starts the temporary listener.
    reconcile(&inner).await;
    let listening = inner.lock().listener.is_some();
    if !listening {
        pairing::close_window(&inner);
        let message = inner.lock().host_error.clone();
        inner.changed();
        return Err(message.unwrap_or_else(|| "Mythra Code couldn't start pairing. Try again.".to_string()));
    }
    inner.changed();
    Ok(current_snapshot(&inner))
}

/// Stops whoever holds the pending slot, without counting it against them.
#[tauri::command]
pub(crate) async fn remote_pairing_cancel_request(
    state: State<'_, RemoteState>,
) -> Result<RemoteSnapshot, String> {
    let inner = state.inner.clone();
    pairing::cancel_pending(&inner);
    inner.changed();
    Ok(current_snapshot(&inner))
}

#[tauri::command]
pub(crate) async fn remote_pairing_close(state: State<'_, RemoteState>) -> Result<RemoteSnapshot, String> {
    let inner = state.inner.clone();
    pairing::close_window(&inner);
    inner.changed();
    Ok(current_snapshot(&inner))
}

#[tauri::command]
pub(crate) async fn remote_pairing_respond(
    state: State<'_, RemoteState>,
    request_id: String,
    approve: bool,
    grant: Option<DeviceGrant>,
) -> Result<RemoteSnapshot, String> {
    let inner = state.inner.clone();
    pairing::respond(&inner, &request_id, approve, grant).await?;
    Ok(current_snapshot(&inner))
}

#[tauri::command]
pub(crate) async fn remote_pair_nearby(
    state: State<'_, RemoteState>,
    instance: String,
) -> Result<RemoteSnapshot, String> {
    let inner = state.inner.clone();
    ready(&inner).await?;
    pairing::start_nearby(&inner, &instance).await?;
    Ok(current_snapshot(&inner))
}

#[tauri::command]
pub(crate) async fn remote_pair_invitation(
    state: State<'_, RemoteState>,
    invitation: String,
) -> Result<RemoteSnapshot, String> {
    let inner = state.inner.clone();
    ready(&inner).await?;
    pairing::start_invitation(&inner, &invitation).await?;
    Ok(current_snapshot(&inner))
}

#[tauri::command]
pub(crate) async fn remote_pair_offer(
    state: State<'_, RemoteState>,
    instance: String,
) -> Result<RemoteSnapshot, String> {
    let inner = state.inner.clone();
    ready(&inner).await?;
    pairing::start_offer(&inner, &instance).await?;
    Ok(current_snapshot(&inner))
}

/// The viewer's user answers an offer. `flow_id` names the offer they were
/// looking at, so a newer offer cannot collect an answer meant for this one.
#[tauri::command]
pub(crate) async fn remote_pair_offer_respond(
    state: State<'_, RemoteState>,
    flow_id: u64,
    accept: bool,
) -> Result<RemoteSnapshot, String> {
    let inner = state.inner.clone();
    pairing::respond_offer(&inner, flow_id, accept)?;
    inner.changed();
    Ok(current_snapshot(&inner))
}

#[tauri::command]
pub(crate) async fn remote_pair_cancel(state: State<'_, RemoteState>) -> Result<RemoteSnapshot, String> {
    let inner = state.inner.clone();
    pairing::cancel_flow(&inner);
    inner.changed();
    Ok(current_snapshot(&inner))
}

fn require_fingerprint(fingerprint: &str) -> Result<(), String> {
    if fingerprint_is_valid(fingerprint) {
        Ok(())
    } else {
        Err("That device could not be found.".into())
    }
}

/// Waits for a narrowing write. On failure the change stays in force and the
/// supervisor keeps saving it, so the command still reports success.
async fn settle_narrowing(
    inner: &Arc<Inner>,
    fingerprint: String,
    saved: oneshot::Receiver<Result<(), String>>,
) {
    if finish_write(saved).await.is_err() {
        inner.note_unsaved(|unsaved| {
            unsaved.devices.insert(fingerprint);
        });
    }
}

fn close_links(inner: &Arc<Inner>, fingerprint: &str, role: Role, reason: CloseReason) {
    let links: Vec<Arc<Link>> = inner
        .lock()
        .links
        .values()
        .filter(|link| link.peer_fingerprint == fingerprint && link.role == role)
        .cloned()
        .collect();
    for link in links {
        link.close(reason);
    }
}

/// Removes a device's access to this one. Memory first, so operations stop and
/// the link closes at once even if the disk is slow. Accepted work keeps going
/// under host control.
#[tauri::command]
pub(crate) async fn remote_device_revoke(
    state: State<'_, RemoteState>,
    fingerprint: String,
) -> Result<RemoteSnapshot, String> {
    let inner = state.inner.clone();
    require_fingerprint(&fingerprint)?;
    let saved = {
        let mut core = inner.lock();
        let device = core
            .devices
            .get_mut(&fingerprint)
            .ok_or("That device could not be found.")?;
        device.grant = None;
        if !device.they_host {
            core.devices.remove(&fingerprint);
            core.dials.remove(&fingerprint);
        }
        core.end_relationship(&fingerprint);
        hostbridge::retire_device_locked(&inner, &mut core, &fingerprint);
        inner.enqueue_device_state(&core, &fingerprint)
    };
    close_links(&inner, &fingerprint, Role::Host, CloseReason::Revoked);
    inner.changed();
    settle_narrowing(&inner, fingerprint, saved).await;
    inner.changed();
    Ok(current_snapshot(&inner))
}

/// Stops using another device from this one. Its grant to us lives over there.
#[tauri::command]
pub(crate) async fn remote_device_forget(
    state: State<'_, RemoteState>,
    fingerprint: String,
) -> Result<RemoteSnapshot, String> {
    let inner = state.inner.clone();
    require_fingerprint(&fingerprint)?;
    let saved = {
        let mut core = inner.lock();
        let device = core
            .devices
            .get_mut(&fingerprint)
            .ok_or("That device could not be found.")?;
        device.they_host = false;
        device.access_removed = false;
        if device.grant.is_none() {
            core.devices.remove(&fingerprint);
        }
        core.dials.remove(&fingerprint);
        core.end_relationship(&fingerprint);
        hostbridge::forget_viewer_locked(&inner, &mut core, &fingerprint);
        inner.enqueue_device_state(&core, &fingerprint)
    };
    close_links(&inner, &fingerprint, Role::Viewer, CloseReason::Finished);
    inner.changed();
    settle_narrowing(&inner, fingerprint, saved).await;
    inner.changed();
    Ok(current_snapshot(&inner))
}

/// Grants change here and only here: no wire operation can reach this.
/// `expected_revision` is the revision the edit started from, and a stale edit is
/// refused. While the new grant is saving, only what both grants allow is in
/// force, so anything narrowed stops at once and anything widened waits for the
/// disk. A failed save leaves that overlap in force, and it is saved in turn.
#[tauri::command]
pub(crate) async fn remote_device_set_grant(
    state: State<'_, RemoteState>,
    fingerprint: String,
    grant: DeviceGrant,
    expected_revision: u64,
) -> Result<RemoteSnapshot, String> {
    const CHANGED: &str = "This device's access changed. Check it and try again.";
    let inner = state.inner.clone();
    require_fingerprint(&fingerprint)?;
    let grant = grant.normalized()?;
    let (next, relationship, saved) = {
        let mut core = inner.lock();
        let relationship = core.relationship(&fingerprint);
        let device = core
            .devices
            .get_mut(&fingerprint)
            .ok_or("That device could not be found.")?;
        let current = device.grant.as_ref().ok_or("That device could not be found.")?;
        if current.revision != expected_revision {
            return Err(CHANGED.into());
        }
        let next = grant.succeeding(Some(current));
        let overlap = current.overlap(&next);
        device.grant = Some(next.clone());
        let record = device.clone();
        device.grant = Some(overlap);
        core.begin_device_save(&fingerprint);
        let saved =
            inner.enqueue_write(false, move |connection| store::save_device(connection, &record));
        hostbridge::retire_device_locked(&inner, &mut core, &fingerprint);
        (next, relationship, saved)
    };
    inner.changed();
    let result = finish_write(saved).await;
    if let Err(message) = result {
        inner.lock().end_device_save(&fingerprint);
        inner.note_unsaved(|unsaved| {
            unsaved.devices.insert(fingerprint);
        });
        inner.changed();
        return Err(message);
    }
    let applied = {
        let mut core = inner.lock();
        core.end_device_save(&fingerprint);
        inner.wake.notify_one();
        let unchanged = core.relationship(&fingerprint) == relationship;
        match core
            .devices
            .get_mut(&fingerprint)
            .filter(|device| unchanged && device.grant.as_ref().is_some_and(|grant| grant.revision == next.revision))
        {
            Some(device) => {
                device.grant = Some(next);
                true
            }
            None => false,
        }
    };
    inner.changed();
    if applied {
        Ok(current_snapshot(&inner))
    } else {
        Err(CHANGED.into())
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PingResult {
    rtt_ms: u64,
    route: &'static str,
    host: Value,
    op_status: Value,
}

/// The Phase 1 proof: an authenticated round trip, with synthetic data only.
#[tauri::command]
pub(crate) async fn remote_device_ping(
    state: State<'_, RemoteState>,
    fingerprint: String,
) -> Result<PingResult, String> {
    let inner = state.inner.clone();
    require_fingerprint(&fingerprint)?;
    let link = inner
        .lock()
        .links
        .values()
        .find(|link| {
            link.peer_fingerprint == fingerprint
                && link.role == Role::Viewer
                && link.is_paired()
                && link.is_open()
        })
        .cloned()
        .ok_or("That device isn't connected right now.")?;
    let explain = |error: wire::WireError| match error.code.as_str() {
        "not_paired" => "That device no longer lets this one connect.".to_string(),
        "host_unavailable" => "That device stopped answering.".to_string(),
        _ => "That device couldn't answer.".to_string(),
    };
    let started = Instant::now();
    link.request("ping", json!({}), PING_WAIT).await.map_err(explain)?;
    let rtt_ms = started.elapsed().as_millis() as u64;
    let host = link
        .request("host.info", json!({}), PING_WAIT)
        .await
        .map_err(explain)?;
    let op_status = link
        .request(
            "op.status",
            // A sequence number past anything used proves this one was never admitted.
            json!({ "opId": uuid::Uuid::new_v4().to_string(), "opSeq": u32::MAX }),
            PING_WAIT,
        )
        .await
        .map_err(explain)?;
    Ok(PingResult {
        rtt_ms,
        route: if link.dialed { "direct" } else { "reverse" },
        host,
        op_status,
    })
}


fn outgoing_privacy_hint(core:&Core,address:SocketAddr,error:&std::io::Error,macos:bool)->bool{
    if !macos||!matches!(error.kind(),std::io::ErrorKind::NetworkUnreachable|std::io::ErrorKind::HostUnreachable){return false;}
    let address=discovery::types::canonical_socket(address);
    let lan=match address.ip(){IpAddr::V4(ip)=>ip.is_private()||ip.is_link_local(),IpAddr::V6(ip)=>ip.is_unique_local()};
    lan&&core.nearby.values().any(|entry|entry.resolve_failures==0&&entry.resolved_at.is_some_and(|at|at.elapsed()<Duration::from_secs(120))&&entry.addresses.iter().any(|peer|discovery::types::canonical_socket(*peer)==address))
}
impl Inner{
    fn note_tcp_failure(&self,address:SocketAddr,error:&std::io::Error)->bool{
        let mut core=self.lock();
        let likely=outgoing_privacy_hint(&core,address,error,macos_local_network_privacy_available());
        if likely{core.outgoing_denied_since=Some(Instant::now());self.dirty.store(true,Ordering::Release);self.wake.notify_one();}
        likely
    }
    fn note_tcp_connected(&self){
        if self.lock().outgoing_denied_since.take().is_some(){self.dirty.store(true,Ordering::Release);self.wake.notify_one();}
    }
}

fn macos_local_network_privacy_available()->bool{
    #[cfg(target_os="macos")]
    {static AVAILABLE:OnceLock<bool>=OnceLock::new();*AVAILABLE.get_or_init(||objc2_foundation::NSProcessInfo::processInfo().operatingSystemVersion().majorVersion>=15)}
    #[cfg(not(target_os="macos"))]
    {false}
}
