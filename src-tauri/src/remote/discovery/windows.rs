//! DNS-SD through the Windows DNS API (`DnsServiceRegister`, `DnsServiceBrowse`,
//! `DnsServiceResolve`). This file uses only `std`, the `windows` crate and the
//! sibling `types.rs`, so it compiles alone in a scratch crate.
//!
//! The OS calls back on its own threads and may do so late, even after a
//! cancel. Registration completions each own one `Arc` reference. Resolve
//! callbacks only borrow a context retained in a bounded process-wide list;
//! accepted queries are cancelled after the first result or timeout. Retired
//! contexts have a 60-second grace period, swept on the next resolve, not a
//! background timer. Windows cancellation/quiescence still needs verification
//! on a real device: this grace period is not an OS lifetime guarantee. Browsing
//! calls back many times, so its small context is never freed.

use std::cell::UnsafeCell;
use std::ffi::{c_void, CStr};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex, OnceLock, PoisonError};
use std::time::{Duration, Instant};

use ::windows::core::{GUID, PCWSTR, PWSTR};
use ::windows::Win32::Foundation::HANDLE;
use ::windows::Win32::NetworkManagement::Dns::{
    DnsFree, DnsFreeRecordList, DnsServiceBrowse, DnsServiceBrowseCancel,
    DnsServiceConstructInstance, DnsServiceDeRegister, DnsServiceFreeInstance, DnsServiceRegister,
    DnsServiceResolve, DnsServiceResolveCancel, DNS_QUERY_REQUEST_VERSION1, DNS_RECORDW,
    DNS_SERVICE_BROWSE_REQUEST, DNS_SERVICE_BROWSE_REQUEST_0, DNS_SERVICE_CANCEL,
    DNS_SERVICE_INSTANCE, DNS_SERVICE_REGISTER_REQUEST, DNS_SERVICE_RESOLVE_REQUEST, DNS_TYPE_PTR,
    IP6_ADDRESS,
};
use ::windows::Win32::NetworkManagement::IpHelper::{
    GetAdaptersAddresses, GAA_FLAG_INCLUDE_GATEWAYS, GAA_FLAG_SKIP_ANYCAST,
    GAA_FLAG_SKIP_DNS_SERVER, GAA_FLAG_SKIP_MULTICAST, IF_TYPE_SOFTWARE_LOOPBACK,
    IP_ADAPTER_ADDRESSES_LH,
};
use ::windows::Win32::NetworkManagement::Ndis::IfOperStatusUp;
use ::windows::Win32::Networking::NetworkListManager::{
    INetworkListManager, NetworkListManager, NLM_NETWORK_CATEGORY_PUBLIC,
};
use ::windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_ALL, COINIT_MULTITHREADED,
};
use ::windows::Win32::System::SystemInformation::{
    ComputerNamePhysicalDnsHostname, GetComputerNameExW,
};

use super::types::{
    address_is_usable, instance_is_valid, tidy_addresses, txt_pairs, AdvertiseRequest,
    DiscoveryEvent, DiscoveryFailure, DiscoverySink, NetworkStatus, ResolvedService, MAX_ADDRESSES,
    SERVICE_TYPE,
};

const REQUEST_PENDING: u32 = 9506;
const ERROR_ACCESS_DENIED: u32 = 5;
const DNS_ERROR_RECORD_ALREADY_EXISTS: u32 = 9711;
const ERROR_CANCELLED: u32 = 1223;
const DEREGISTER_WAIT: Duration = Duration::from_secs(1);
const MAX_WIDE_CHARS: usize = 1024;
const MAX_ADAPTERS: usize = 8;
const MAX_NETWORK_CONNECTIONS: usize = 64;
const MAX_PROPERTIES: usize = 16;
const IF_TYPE_PPP: u32 = 23;
const IF_TYPE_PROP_VIRTUAL: u32 = 53;
const IF_TYPE_TUNNEL: u32 = 131;

fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(std::iter::once(0)).collect()
}

/// # Safety
/// `text` must be null or a NUL-terminated UTF-16 string.
unsafe fn narrow(text: *const u16) -> Option<String> {
    if text.is_null() {
        return None;
    }
    let mut length = 0;
    // SAFETY: the string is NUL-terminated; the scan stops at the bound too.
    while length < MAX_WIDE_CHARS && unsafe { *text.add(length) } != 0 {
        length += 1;
    }
    // SAFETY: `length` characters were just read.
    String::from_utf16(unsafe { std::slice::from_raw_parts(text, length) }).ok()
}

fn failure(status: u32) -> DiscoveryFailure {
    match status {
        ERROR_ACCESS_DENIED => DiscoveryFailure::Denied,
        DNS_ERROR_RECORD_ALREADY_EXISTS => DiscoveryFailure::NameConflict,
        other => DiscoveryFailure::Unavailable(format!("Network discovery failed ({other}).")),
    }
}

fn full_name(instance: &str) -> String {
    format!("{instance}.{SERVICE_TYPE}.local")
}

/// `mythra-xxxxxxxx._mythra-code._tcp.local` (with or without the final dot)
/// back to its instance label, or `None` for anything else.
fn instance_from_full_name(name: &str) -> Option<String> {
    let name = name.trim_end_matches('.');
    let suffix = format!(".{SERVICE_TYPE}.local");
    let split = name.len().checked_sub(suffix.len())?;
    if !name.is_char_boundary(split) || !name[split..].eq_ignore_ascii_case(&suffix) {
        return None;
    }
    let instance = name[..split].to_ascii_lowercase();
    instance_is_valid(&instance).then_some(instance)
}

fn computer_host_name() -> Result<String, DiscoveryFailure> {
    let mut buffer = [0u16; 256];
    let mut size = buffer.len() as u32;
    // SAFETY: `buffer` holds `size` characters for the call.
    unsafe {
        GetComputerNameExW(
            ComputerNamePhysicalDnsHostname,
            Some(PWSTR(buffer.as_mut_ptr())),
            &mut size,
        )
    }
    .map_err(|_| DiscoveryFailure::Unavailable("Could not read this computer's name.".into()))?;
    let length = (size as usize).min(buffer.len());
    Ok(String::from_utf16_lossy(&buffer[..length]))
}

// ---- Advertise ----

/// What all of one advertisement's registrations share.
struct AdvertiseShared {
    sink: DiscoverySink,
    /// Registrations that have not failed.
    live: AtomicUsize,
    /// Registrations Windows refused while another one stayed up.
    refused: AtomicU32,
}

impl AdvertiseShared {
    fn lost_one(&self, failed: DiscoveryFailure) {
        if self.live.fetch_sub(1, Ordering::AcqRel) <= 1 {
            (self.sink)(DiscoveryEvent::Failed(failed));
        } else {
            self.refused.fetch_add(1, Ordering::AcqRel);
            (self.sink)(DiscoveryEvent::Narrowed);
        }
    }
}

/// Owns everything the OS reads for one registration. Registering and
/// deregistering each hand the OS one reference, so which completes first does
/// not matter, and the last reference to go frees all of it.
struct RegisterContext {
    shared: Arc<AdvertiseShared>,
    /// Our own constructed instance. The OS only reads it.
    instance: *mut DNS_SERVICE_INSTANCE,
    /// At a fixed address for the life of the context.
    request: UnsafeCell<DNS_SERVICE_REGISTER_REQUEST>,
    closing: AtomicBool,
    finished: Mutex<bool>,
    finished_changed: Condvar,
}

// SAFETY: the raw pointers are only written before the context is shared and
// are freed in Drop, when no reference remains. The OS reads them from its own
// threads, which is what the references it holds are for.
unsafe impl Send for RegisterContext {}
// SAFETY: as above; everything mutated after sharing is atomic or locked.
unsafe impl Sync for RegisterContext {}

impl Drop for RegisterContext {
    fn drop(&mut self) {
        // SAFETY: the last reference is gone, so no completion can still use it.
        unsafe { DnsServiceFreeInstance(self.instance) };
    }
}

impl RegisterContext {
    /// One reference for one native completion.
    fn hand_to_os(self: &Arc<Self>) -> *const RegisterContext {
        Arc::into_raw(self.clone())
    }

    /// Starts deregistering. True when a completion will follow.
    fn deregister(self: &Arc<Self>) -> bool {
        self.closing.store(true, Ordering::Release);
        let raw = self.hand_to_os();
        // SAFETY: `request` is the structure that registered the service, and
        // the reference above keeps it alive until the completion has run.
        let status = unsafe { DnsServiceDeRegister(self.request.get(), None) };
        if status == REQUEST_PENDING {
            return true;
        }
        // SAFETY: refused, so no completion owns the reference handed over.
        drop(unsafe { Arc::from_raw(raw) });
        false
    }

    fn wait_finished(&self, deadline: Instant) {
        let guard = self.finished.lock().unwrap_or_else(PoisonError::into_inner);
        let remaining = deadline.saturating_duration_since(Instant::now());
        let _ = self
            .finished_changed
            .wait_timeout_while(guard, remaining, |finished| !*finished)
            .unwrap_or_else(PoisonError::into_inner);
    }
}

unsafe extern "system" fn register_complete(
    status: u32,
    context: *const c_void,
    instance: *const DNS_SERVICE_INSTANCE,
) {
    // SAFETY: every registration call handed this completion one reference.
    let context = unsafe { Arc::from_raw(context.cast::<RegisterContext>()) };
    // Each callback hands over a copy that the caller must free.
    if !instance.is_null() && instance as *mut _ != context.instance {
        // SAFETY: documented ownership of the callback's instance.
        unsafe { DnsServiceFreeInstance(instance) };
    }
    if context.closing.load(Ordering::Acquire) {
        *context
            .finished
            .lock()
            .unwrap_or_else(PoisonError::into_inner) = true;
        context.finished_changed.notify_all();
    } else if status != 0 {
        context.shared.lost_one(failure(status));
    }
    // `context` is released here and never touched again.
}

pub struct Advertisement {
    registrations: Vec<Arc<RegisterContext>>,
    shared: Arc<AdvertiseShared>,
    network: String,
}

impl Advertisement {
    /// Which adapters and addresses this was built for.
    pub fn network(&self) -> &str {
        &self.network
    }

    pub fn refused_registrations(&self) -> u32 {
        self.shared.refused.load(Ordering::Acquire)
    }
}

impl Drop for Advertisement {
    /// The wait only gives the goodbyes time to leave, and it is shared by all
    /// the registrations so stopping stays bounded however many there are.
    fn drop(&mut self) {
        let deadline = Instant::now() + DEREGISTER_WAIT;
        let waiting: Vec<&Arc<RegisterContext>> = self
            .registrations
            .iter()
            .filter(|context| context.deregister())
            .collect();
        for context in waiting {
            context.wait_finished(deadline);
        }
    }
}

fn register_on(
    request: &AdvertiseRequest,
    host: &str,
    adapter: &Adapter,
    shared: &Arc<AdvertiseShared>,
) -> Result<Arc<RegisterContext>, DiscoveryFailure> {
    let service_name = wide(&full_name(&request.instance));
    let host_name = wide(host);

    let keys: Vec<Vec<u16>> = request.txt.iter().map(|(key, _)| wide(key)).collect();
    let values: Vec<Vec<u16>> = request.txt.iter().map(|(_, value)| wide(value)).collect();
    let key_pointers: Vec<PCWSTR> = keys.iter().map(|key| PCWSTR(key.as_ptr())).collect();
    let value_pointers: Vec<PCWSTR> = values.iter().map(|value| PCWSTR(value.as_ptr())).collect();

    // IP4_ADDRESS holds the bytes in network order.
    let ip4 = adapter.ipv4.map(|ip| u32::from_ne_bytes(ip.octets()));
    let ip6 = adapter.ipv6.map(|ip| IP6_ADDRESS { IP6Byte: ip.octets() });

    // SAFETY: every string is NUL-terminated and alive for the call; the API
    // copies them into the returned instance.
    let instance = unsafe {
        DnsServiceConstructInstance(
            PCWSTR(service_name.as_ptr()),
            PCWSTR(host_name.as_ptr()),
            ip4.as_ref().map(|value| value as *const u32),
            ip6.as_ref().map(|value| value as *const IP6_ADDRESS),
            request.port,
            0,
            0,
            key_pointers.len() as u32,
            key_pointers.as_ptr(),
            value_pointers.as_ptr(),
        )
    };
    if instance.is_null() {
        return Err(DiscoveryFailure::Unavailable(
            "Could not prepare the network announcement.".into(),
        ));
    }

    let context = Arc::new(RegisterContext {
        shared: shared.clone(),
        instance,
        request: UnsafeCell::new(DNS_SERVICE_REGISTER_REQUEST {
            Version: DNS_QUERY_REQUEST_VERSION1.0,
            InterfaceIndex: adapter.index,
            pServiceInstance: instance,
            pRegisterCompletionCallback: Some(register_complete),
            pQueryContext: std::ptr::null_mut(),
            hCredentials: HANDLE::default(),
            unicastEnabled: false.into(),
        }),
        closing: AtomicBool::new(false),
        finished: Mutex::new(false),
        finished_changed: Condvar::new(),
    });
    // SAFETY: nothing else can see the context yet.
    unsafe { (*context.request.get()).pQueryContext = Arc::as_ptr(&context) as *mut c_void };

    shared.live.fetch_add(1, Ordering::AcqRel);
    let raw = context.hand_to_os();
    // SAFETY: the context owns the request and instance, and the reference
    // above keeps them alive until the completion has run.
    let status = unsafe { DnsServiceRegister(context.request.get(), None) };
    if status != REQUEST_PENDING {
        shared.live.fetch_sub(1, Ordering::AcqRel);
        // SAFETY: refused, so no completion owns the reference handed over.
        drop(unsafe { Arc::from_raw(raw) });
        return Err(failure(status));
    }
    Ok(context)
}

/// One registration per eligible adapter, each with that adapter's own address.
/// A refused one is counted and the rest carry on, because a device reachable on
/// one network is still worth announcing.
pub fn advertise(
    request: &AdvertiseRequest,
    sink: DiscoverySink,
) -> Result<Advertisement, DiscoveryFailure> {
    let adapters = eligible_adapters();
    if adapters.is_empty() {
        return Err(DiscoveryFailure::Unavailable(
            "This device isn't connected to a network.".into(),
        ));
    }
    let network = network_fingerprint(&adapters);
    let host = format!("{}.local", computer_host_name()?);
    let shared = Arc::new(AdvertiseShared {
        sink,
        live: AtomicUsize::new(0),
        refused: AtomicU32::new(0),
    });
    let mut registrations = Vec::with_capacity(adapters.len());
    let mut first_failure = None;
    for adapter in &adapters {
        match register_on(request, &host, adapter, &shared) {
            Ok(context) => registrations.push(context),
            Err(failed) => {
                shared.refused.fetch_add(1, Ordering::AcqRel);
                first_failure.get_or_insert(failed);
            }
        }
    }
    if registrations.is_empty() {
        return Err(first_failure.unwrap_or_else(|| {
            DiscoveryFailure::Unavailable("Could not announce this device.".into())
        }));
    }
    Ok(Advertisement {
        registrations,
        shared,
        network,
    })
}

// ---- Browse ----

struct BrowseContext {
    sink: DiscoverySink,
    closed: AtomicBool,
    /// Kept alive with the context, which is leaked on purpose.
    _query: Vec<u16>,
    request: DNS_SERVICE_BROWSE_REQUEST,
}

unsafe extern "system" fn browse_complete(
    status: u32,
    context: *const c_void,
    records: *const DNS_RECORDW,
) {
    // SAFETY: the context is leaked in `browse`, so it is always valid.
    let context = unsafe { &*context.cast::<BrowseContext>() };
    let closed = context.closed.load(Ordering::Acquire);
    if status != 0 && status != ERROR_CANCELLED && !closed {
        (context.sink)(DiscoveryEvent::Failed(failure(status)));
    }
    let mut record = records;
    while !record.is_null() && !closed {
        // SAFETY: `record` is a live node of the list the OS passed in.
        let entry = unsafe { &*record };
        if entry.wType == DNS_TYPE_PTR.0 {
            // SAFETY: a PTR record carries a NUL-terminated target in this field.
            let target = unsafe { narrow(entry.Data.PTR.pNameHost.0) };
            if let Some(instance) = target.as_deref().and_then(instance_from_full_name) {
                // Windows repeats records. The receiver treats a repeat as a
                // no-op, and it lets a service dropped after failed lookups
                // come back the next time it answers.
                (context.sink)(if entry.dwTtl == 0 {
                    DiscoveryEvent::Lost(instance)
                } else {
                    DiscoveryEvent::Found(instance)
                });
            }
        }
        record = entry.pNext;
    }
    if !records.is_null() {
        // SAFETY: documented ownership of the record list passed to the callback.
        unsafe { DnsFree(Some(records.cast()), DnsFreeRecordList) };
    }
}

pub struct Browser {
    cancel: Box<DNS_SERVICE_CANCEL>,
    context: *const BrowseContext,
}

// SAFETY: the cancel handle and context pointer are only used from Drop.
unsafe impl Send for Browser {}

impl Drop for Browser {
    fn drop(&mut self) {
        // SAFETY: the context is leaked and therefore always valid.
        unsafe { &*self.context }.closed.store(true, Ordering::Release);
        // SAFETY: `cancel` was filled in by a successful DnsServiceBrowse.
        let status = unsafe { DnsServiceBrowseCancel(self.cancel.as_ref()) };
        if status != 0 {
            // Cancellation did not establish the end of the OS borrow. Retain
            // the original handle storage with the already-retained context.
            // The replacement is unsubmitted and safe to drop normally.
            std::mem::forget(std::mem::take(&mut self.cancel));
        }
    }
}

pub fn browse(sink: DiscoverySink) -> Result<Browser, DiscoveryFailure> {
    let query = wide(&format!("{SERVICE_TYPE}.local"));
    let query_pointer = PCWSTR(query.as_ptr());
    let context = Box::into_raw(Box::new(BrowseContext {
        sink,
        closed: AtomicBool::new(false),
        _query: query,
        request: DNS_SERVICE_BROWSE_REQUEST {
            Version: DNS_QUERY_REQUEST_VERSION1.0,
            InterfaceIndex: 0,
            QueryName: query_pointer,
            Anonymous: DNS_SERVICE_BROWSE_REQUEST_0 {
                pBrowseCallback: Some(browse_complete),
            },
            pQueryContext: std::ptr::null_mut(),
        },
    }));
    // SAFETY: `context` came from Box::into_raw and nothing else can see it yet.
    unsafe { (*context).request.pQueryContext = context.cast() };
    let mut cancel = Box::new(DNS_SERVICE_CANCEL::default());
    // SAFETY: the request and its query live in the context, which is never
    // freed once this call has been accepted.
    let status = unsafe { DnsServiceBrowse(&(*context).request, cancel.as_mut()) } as u32;
    if status != REQUEST_PENDING {
        // SAFETY: refused, so no callback can arrive.
        drop(unsafe { Box::from_raw(context) });
        return Err(failure(status));
    }
    Ok(Browser { cancel, context })
}

// ---- Resolve ----

const RESOLVE_RETIRE_GRACE: Duration = Duration::from_secs(60);
// Concurrency alone does not bound completed queries per minute. Refuse new
// work if the grace list fills; never evict a young context to make space.
const MAX_RESOLVE_CONTEXTS: usize = 128;
static RESOLVE_CONTEXTS: OnceLock<Mutex<Vec<RetiredResolve>>> = OnceLock::new();
struct RetiredResolve {
    context: Arc<ResolveContext>,
    finished_at: Option<Instant>,
}

/// The caller and retention list own references; callbacks only borrow.
struct ResolveContext {
    outcome: Mutex<Option<Result<ResolvedService, u32>>>,
    ready: Condvar,
    /// At a fixed address for the life of the context.
    request: UnsafeCell<DNS_SERVICE_RESOLVE_REQUEST>,
    cancel: UnsafeCell<DNS_SERVICE_CANCEL>,
    _query: Vec<u16>,
    finished: AtomicBool,
    callbacks: AtomicUsize,
}

// SAFETY: request/query have stable addresses and are initialized before the
// OS sees them. Only the resolving caller accesses the cancel handle. The list
// retains the context during the operation and the cancellation grace period.
unsafe impl Send for ResolveContext {}
// SAFETY: as above; callback-visible mutation is atomic or mutex-protected.
unsafe impl Sync for ResolveContext {}

/// # Safety
/// `instance` must be a valid structure from the resolve callback.
unsafe fn read_instance(instance: *const DNS_SERVICE_INSTANCE) -> Option<ResolvedService> {
    // SAFETY: guaranteed by the caller.
    let entry = unsafe { &*instance };
    if entry.wPort == 0 {
        return None;
    }
    let mut addresses: Vec<SocketAddr> = Vec::new();
    if !entry.ip4Address.is_null() {
        // SAFETY: non-null field points to one address in network byte order.
        let raw = unsafe { *entry.ip4Address };
        addresses.push(SocketAddr::new(
            IpAddr::V4(Ipv4Addr::from(raw.to_ne_bytes())),
            entry.wPort,
        ));
    }
    if !entry.ip6Address.is_null() {
        // SAFETY: non-null field points to one IPv6 address.
        let raw = unsafe { (*entry.ip6Address).IP6Byte };
        addresses.push(SocketAddr::new(IpAddr::V6(Ipv6Addr::from(raw)), entry.wPort));
    }
    addresses.truncate(MAX_ADDRESSES);
    if addresses.is_empty() {
        return None;
    }
    let mut strings: Vec<(String, String)> = Vec::new();
    let count = (entry.dwPropertyCount as usize).min(MAX_PROPERTIES);
    if !entry.keys.is_null() && !entry.values.is_null() {
        for index in 0..count {
            // SAFETY: both arrays hold `dwPropertyCount` valid string pointers.
            let (key, value) = unsafe {
                (
                    narrow((*entry.keys.add(index)).0),
                    narrow((*entry.values.add(index)).0),
                )
            };
            if let (Some(key), Some(value)) = (key, value) {
                strings.push((key, value));
            }
        }
    }
    Some(ResolvedService {
        addresses,
        txt: txt_pairs(
            strings
                .iter()
                .map(|(key, value)| (key.as_str(), value.as_str())),
        ),
    })
}

unsafe extern "system" fn resolve_complete(
    status: u32,
    context: *const c_void,
    instance: *const DNS_SERVICE_INSTANCE,
) {
    // SAFETY: the caller/list retains the context. A result must NOT consume a
    // reference: Windows documents one callback for each result, not one total.
    let context = unsafe { &*context.cast::<ResolveContext>() };
    context.callbacks.fetch_add(1, Ordering::AcqRel);
    struct Callback<'a>(&'a AtomicUsize);
    impl Drop for Callback<'_> {
        fn drop(&mut self) { self.0.fetch_sub(1, Ordering::AcqRel); }
    }
    let _callback = Callback(&context.callbacks);
    let outcome = if status != 0 {
        Err(status)
    } else if instance.is_null() {
        Err(u32::MAX)
    } else {
        // SAFETY: the OS passed a valid instance for this successful result.
        unsafe { read_instance(instance) }.ok_or(u32::MAX)
    };
    if !instance.is_null() {
        // SAFETY: documented ownership of the callback's instance.
        unsafe { DnsServiceFreeInstance(instance) };
    }
    let mut first = context.outcome.lock().unwrap_or_else(PoisonError::into_inner);
    if !context.finished.load(Ordering::Acquire) && first.is_none() {
        *first = Some(outcome);
        context.ready.notify_all();
    }
    // Borrow ends here; neither this callback nor a later one consumes an Arc.
}

/// Blocking and bounded by `wait`. Call off the async runtime.
pub fn resolve(instance: &str, wait: Duration) -> Result<ResolvedService, DiscoveryFailure> {
    let retained = RESOLVE_CONTEXTS.get_or_init(|| Mutex::new(Vec::new()));
    {
        let mut contexts = retained.lock().unwrap_or_else(PoisonError::into_inner);
        contexts.retain(|entry| entry.finished_at.is_none_or(|at| at.elapsed() < RESOLVE_RETIRE_GRACE)
            || entry.context.callbacks.load(Ordering::Acquire) != 0);
    }
    if !instance_is_valid(instance) {
        return Err(DiscoveryFailure::Unavailable("Invalid service name.".into()));
    }
    let mut query = wide(&full_name(instance));
    let query_pointer = PWSTR(query.as_mut_ptr());
    let context = Arc::new(ResolveContext {
        outcome: Mutex::new(None),
        ready: Condvar::new(),
        request: UnsafeCell::new(DNS_SERVICE_RESOLVE_REQUEST {
            Version: DNS_QUERY_REQUEST_VERSION1.0,
            InterfaceIndex: 0,
            QueryName: query_pointer,
            pResolveCompletionCallback: Some(resolve_complete),
            pQueryContext: std::ptr::null_mut(),
        }),
        cancel: UnsafeCell::new(DNS_SERVICE_CANCEL::default()),
        _query: query,
        finished: AtomicBool::new(false),
        callbacks: AtomicUsize::new(0),
    });
    // SAFETY: nothing else can see the context yet.
    unsafe { (*context.request.get()).pQueryContext = Arc::as_ptr(&context) as *mut c_void };
    {
        let mut contexts = retained.lock().unwrap_or_else(PoisonError::into_inner);
        if contexts.len() >= MAX_RESOLVE_CONTEXTS {
            return Err(DiscoveryFailure::Unavailable("Network discovery is busy. Try again shortly.".into()));
        }
        contexts.push(RetiredResolve { context: context.clone(), finished_at: None });
    }
    // SAFETY: request, query, context and cancel storage remain at stable heap
    // addresses, retained before any callback can arrive.
    let status = unsafe { DnsServiceResolve(context.request.get(), context.cancel.get()) } as u32;
    if status != REQUEST_PENDING {
        context.finished.store(true, Ordering::Release);
        let mut contexts = retained.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(entry) = contexts.iter_mut().find(|entry| Arc::ptr_eq(&entry.context, &context)) {
            entry.finished_at = Some(Instant::now());
        }
        return Err(failure(status));
    }
    let deadline = Instant::now() + wait;
    let mut outcome = context
        .outcome
        .lock()
        .unwrap_or_else(PoisonError::into_inner);
    while outcome.is_none() {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            break;
        }
        outcome = context
            .ready
            .wait_timeout(outcome, remaining)
            .unwrap_or_else(PoisonError::into_inner)
            .0;
    }
    let result = outcome.take();
    drop(outcome);
    context.finished.store(true, Ordering::Release);
    // Cancel after success, failure AND timeout. Do not hold outcome/list locks:
    // cancellation may invoke callbacks synchronously. Real Windows callback
    // quiescence after cancel is still unverified; the grace period is a
    // conservative mitigation, not a proof that arbitrarily late calls stop.
    let cancelled = unsafe { DnsServiceResolveCancel(context.cancel.get()) } as u32;
    {
        let mut contexts = retained.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(entry) = contexts.iter_mut().find(|entry| Arc::ptr_eq(&entry.context, &context)) {
            // Failed cancellation has no safe retirement point. Keep that
            // context indefinitely; the cap makes repeated failures fail closed.
            entry.finished_at = (cancelled == 0).then(Instant::now);
        }
    }
    match result {
        Some(Ok(service)) => Ok(service),
        Some(Err(code)) => Err(if code == u32::MAX {
            DiscoveryFailure::Unavailable("The device gave an invalid address.".into())
        } else {
            failure(code)
        }),
        None => {
            Err(DiscoveryFailure::Unavailable("The device did not answer.".into()))
        }
    }
}

/// One network adapter this device could be reached through.
struct Adapter {
    index: u32,
    /// The adapter's identity, as NetworkListManager reports it.
    guid: Option<GUID>,
    routed: bool,
    addresses: Vec<IpAddr>,
    ipv4: Option<Ipv4Addr>,
    ipv6: Option<Ipv6Addr>,
}

/// `{xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx}`, as `AdapterName` spells it.
fn parse_guid(text: &str) -> Option<GUID> {
    let digits: String = text
        .trim_start_matches('{')
        .trim_end_matches('}')
        .chars()
        .filter(|character| *character != '-')
        .collect();
    if digits.len() != 32 {
        return None;
    }
    u128::from_str_radix(&digits, 16).ok().map(GUID::from_u128)
}

/// Real adapters that are up and have an address worth announcing. VPN, tunnel
/// and virtual adapters are never here, so Tailscale never is. Real networks
/// come first: an adapter with a gateway beats a virtual switch.
fn read_adapters() -> Vec<Adapter> {
    let flags = GAA_FLAG_SKIP_ANYCAST
        | GAA_FLAG_SKIP_MULTICAST
        | GAA_FLAG_SKIP_DNS_SERVER
        | GAA_FLAG_INCLUDE_GATEWAYS;
    let mut size: u32 = 16 * 1024;
    // u64 storage gives the alignment IP_ADAPTER_ADDRESSES_LH needs.
    let mut buffer: Vec<u64> = Vec::new();
    let mut status = 0;
    for _ in 0..3 {
        buffer.resize((size as usize).div_ceil(8), 0);
        // SAFETY: `buffer` holds at least `size` writable bytes.
        status = unsafe {
            GetAdaptersAddresses(
                0,
                flags,
                None,
                Some(buffer.as_mut_ptr().cast::<IP_ADAPTER_ADDRESSES_LH>()),
                &mut size,
            )
        };
        if status != 111 {
            break;
        }
    }
    if status != 0 {
        return Vec::new();
    }
    let mut adapters = Vec::new();
    let mut adapter = buffer.as_ptr().cast::<IP_ADAPTER_ADDRESSES_LH>();
    while !adapter.is_null() {
        // SAFETY: a live node of the list the call just wrote into `buffer`.
        let entry = unsafe { &*adapter };
        let virtual_link = matches!(
            entry.IfType,
            IF_TYPE_SOFTWARE_LOOPBACK | IF_TYPE_PPP | IF_TYPE_TUNNEL | IF_TYPE_PROP_VIRTUAL
        );
        if !virtual_link && entry.OperStatus == IfOperStatusUp {
            let mut addresses = Vec::new();
            let mut unicast = entry.FirstUnicastAddress;
            while !unicast.is_null() {
                // SAFETY: a live node of the unicast list for this adapter.
                let item = unsafe { &*unicast };
                // SAFETY: lpSockaddr points to iSockaddrLength readable bytes.
                if let Some(address) = unsafe {
                    read_socket_address(
                        item.Address.lpSockaddr.cast::<u8>(),
                        item.Address.iSockaddrLength,
                    )
                } {
                    if address_is_usable(address) {
                        addresses.push(address);
                    }
                }
                unicast = item.Next;
            }
            let addresses = tidy_addresses(addresses);
            let ipv4 = addresses.iter().find_map(|address| match address {
                IpAddr::V4(ip) => Some(*ip),
                IpAddr::V6(_) => None,
            });
            let ipv6 = addresses.iter().find_map(|address| match address {
                IpAddr::V6(ip) => Some(*ip),
                IpAddr::V4(_) => None,
            });
            // SAFETY: the list was written with the LH layout, so the
            // Length/IfIndex arm of this union is the valid one.
            let ipv4_index = unsafe { entry.Anonymous1.Anonymous.IfIndex };
            let index = if ipv4_index != 0 { ipv4_index } else { entry.Ipv6IfIndex };
            let guid = (!entry.AdapterName.is_null())
                .then(|| {
                    // SAFETY: AdapterName is a NUL-terminated string in `buffer`.
                    let name = unsafe { CStr::from_ptr(entry.AdapterName.0.cast()) };
                    name.to_str().ok().and_then(parse_guid)
                })
                .flatten();
            if index != 0 && !addresses.is_empty() {
                adapters.push(Adapter {
                    index,
                    guid,
                    routed: !entry.FirstGatewayAddress.is_null(),
                    addresses,
                    ipv4,
                    ipv6,
                });
            }
        }
        adapter = entry.Next;
    }
    adapters.sort_by_key(|adapter| !adapter.routed);
    adapters
}

/// Adapters to announce on. With a real network present, unrouted virtual
/// switches are left out.
fn eligible_adapters() -> Vec<Adapter> {
    let mut adapters = read_adapters();
    if adapters.iter().any(|adapter| adapter.routed) {
        adapters.retain(|adapter| adapter.routed);
    }
    adapters.truncate(MAX_ADAPTERS);
    adapters
}

fn network_fingerprint(adapters: &[Adapter]) -> String {
    let mut entries: Vec<String> = adapters
        .iter()
        .map(|adapter| format!("{}/{:?}/{:?}", adapter.index, adapter.ipv4, adapter.ipv6))
        .collect();
    entries.sort();
    entries.join(";")
}

pub fn local_addresses() -> Vec<IpAddr> {
    tidy_addresses(
        read_adapters()
            .into_iter()
            .flat_map(|adapter| adapter.addresses)
            .collect(),
    )
}

/// True when Windows marks any of `adapters` as Public, false when it marks them
/// all otherwise, `None` when it could not say. Any failure is `None`.
fn read_public_network(adapters: &[GUID]) -> Option<bool> {
    // SAFETY: plain COM activation. Failure is an error result, not a crash.
    let manager: INetworkListManager =
        unsafe { CoCreateInstance(&NetworkListManager, None, CLSCTX_ALL) }.ok()?;
    // SAFETY: `manager` is a live interface pointer.
    let connections = unsafe { manager.GetNetworkConnections() }.ok()?;
    let mut matched = false;
    let mut public = false;
    for _ in 0..MAX_NETWORK_CONNECTIONS {
        let mut slot = [None];
        let mut fetched = 0u32;
        // SAFETY: `slot` has room for the one connection asked for.
        unsafe { connections.Next(&mut slot, Some(&mut fetched)) }.ok()?;
        let [connection] = slot;
        let (Some(connection), 1) = (connection, fetched) else {
            break;
        };
        // SAFETY: `connection` is a live interface pointer.
        let Ok(adapter) = (unsafe { connection.GetAdapterId() }) else {
            continue;
        };
        if !adapters.contains(&adapter) {
            continue;
        }
        // SAFETY: as above, and the network it returns is live too.
        let category = unsafe { connection.GetNetwork().and_then(|network| network.GetCategory()) }.ok()?;
        matched = true;
        public |= category == NLM_NETWORK_CATEGORY_PUBLIC;
    }
    matched.then_some(public)
}

/// Blocking. Call off the async runtime.
pub fn network_status() -> NetworkStatus {
    let adapters = eligible_adapters();
    let guids: Vec<GUID> = adapters.iter().filter_map(|adapter| adapter.guid).collect();
    let public = if guids.is_empty() {
        None
    } else {
        // SAFETY: balanced below. A thread already in another COM mode reports
        // an error here and can still make these calls.
        let joined = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
        let public = read_public_network(&guids);
        if joined.is_ok() {
            // SAFETY: pairs with the successful call above.
            unsafe { CoUninitialize() };
        }
        public
    };
    NetworkStatus {
        fingerprint: network_fingerprint(&adapters),
        public,
    }
}

/// # Safety
/// `pointer` must be null or address `length` readable bytes.
unsafe fn read_socket_address(pointer: *const u8, length: i32) -> Option<IpAddr> {
    if pointer.is_null() || length < 2 {
        return None;
    }
    // SAFETY: guaranteed by the caller.
    let bytes = unsafe { std::slice::from_raw_parts(pointer, length as usize) };
    // sockaddr_in: family, port, 4-byte address at offset 4.
    // sockaddr_in6: family, port, flow info, 16-byte address at offset 8.
    match u16::from_ne_bytes([bytes[0], bytes[1]]) {
        2 => {
            let octets: [u8; 4] = bytes.get(4..8)?.try_into().ok()?;
            Some(IpAddr::V4(Ipv4Addr::from(octets)))
        }
        23 => {
            let octets: [u8; 16] = bytes.get(8..24)?.try_into().ok()?;
            Some(IpAddr::V6(Ipv6Addr::from(octets)))
        }
        _ => None,
    }
}

#[cfg(test)]
mod windows_tests {
    use super::*;
    use std::mem::ManuallyDrop;

    fn context() -> Arc<ResolveContext> {
        let mut query = wide("mythra-0123abcd._mythra-code._tcp.local");
        let name = PWSTR(query.as_mut_ptr());
        let context = Arc::new(ResolveContext {
            outcome: Mutex::new(None),
            ready: Condvar::new(),
            request: UnsafeCell::new(DNS_SERVICE_RESOLVE_REQUEST {
                Version: DNS_QUERY_REQUEST_VERSION1.0,
                QueryName: name,
                pResolveCompletionCallback: Some(resolve_complete),
                ..Default::default()
            }),
            cancel: UnsafeCell::new(DNS_SERVICE_CANCEL::default()),
            _query: query,
            finished: AtomicBool::new(false),
            callbacks: AtomicUsize::new(0),
        });
        unsafe {
            (*context.request.get()).pQueryContext = Arc::as_ptr(&context) as *mut c_void;
        }
        context
    }
    fn service(port: u16) -> *mut DNS_SERVICE_INSTANCE {
        let name = wide("mythra-0123abcd._mythra-code._tcp.local");
        let host = wide("headless-test.local");
        let keys = [wide("proto"), wide("name")];
        let values = [wide("1"), wide("é Windows test")];
        let k: Vec<_> = keys.iter().map(|s| PCWSTR(s.as_ptr())).collect();
        let v: Vec<_> = values.iter().map(|s| PCWSTR(s.as_ptr())).collect();
        let ip = u32::from_ne_bytes([192, 168, 42, 7]);
        let instance = unsafe {
            DnsServiceConstructInstance(
                PCWSTR(name.as_ptr()),
                PCWSTR(host.as_ptr()),
                Some(&ip),
                None,
                port,
                0,
                0,
                k.len() as u32,
                k.as_ptr(),
                v.as_ptr(),
            )
        };
        assert!(!instance.is_null(), "construct owned native DNS instance");
        instance
    }

    #[test]
    fn windows_browse_cancel_storage_survives_owner_moves() {
        fn address(cancel: &DNS_SERVICE_CANCEL) -> usize {
            cancel as *const _ as usize
        }
        // No query has been started: never run Browser::drop or call DNS APIs.
        // This tests the storage-lifetime requirement independently of OS timing.
        let browser = ManuallyDrop::new(Browser {
            cancel: Default::default(),
            context: std::ptr::null(),
        });
        let passed_to_os = address(&browser.cancel);
        let mut moved = Box::new(browser);
        let moved_address = address(&moved.cancel);
        // No operation was submitted, so free only the unsubmitted cancel box.
        // ManuallyDrop prevents Browser::drop from dereferencing the dummy context.
        unsafe {
            std::ptr::drop_in_place(&mut moved.cancel);
        }
        assert_eq!(passed_to_os,moved_address,"DnsServiceBrowse retains the cancel storage until cancellation; moving Browser must not relocate it");
    }

    #[test]
    fn windows_resolve_callbacks_borrow_and_keep_only_the_first_result() {
        let context = context();
        let raw = Arc::as_ptr(&context).cast::<c_void>();
        let references = Arc::strong_count(&context);
        unsafe {
            resolve_complete(0, raw, service(4242));
        }
        unsafe {
            resolve_complete(0, raw, service(9999));
        }
        assert_eq!(
            Arc::strong_count(&context),
            references,
            "callbacks must not consume retained ownership"
        );
        assert_eq!(context.callbacks.load(Ordering::Acquire), 0);
        let resolved = context.outcome.lock().unwrap().take().unwrap().unwrap();
        assert_eq!(
            resolved.addresses[0],
            "192.168.42.7:4242".parse::<SocketAddr>().unwrap()
        );
        assert!(resolved
            .txt
            .contains(&("name".into(), "é Windows test".into())));
        context.finished.store(true, Ordering::Release);
        unsafe {
            resolve_complete(ERROR_CANCELLED, raw, std::ptr::null());
        }
        assert!(context.outcome.lock().unwrap().is_none());
        assert_eq!(Arc::strong_count(&context), references);
    }

    #[test]
    fn windows_registration_completions_own_independent_references_in_either_order() {
        for deregister_first in [false, true] {
            let shared = Arc::new(AdvertiseShared {
                sink: Arc::new(|_| {}),
                live: AtomicUsize::new(1),
                refused: AtomicU32::new(0),
            });
            let context = Arc::new(RegisterContext {
                shared,
                instance: service(4242),
                request: UnsafeCell::new(Default::default()),
                closing: AtomicBool::new(true),
                finished: Mutex::new(false),
                finished_changed: Condvar::new(),
            });
            let registered = context.hand_to_os() as usize;
            let deregistered = context.hand_to_os() as usize;
            let callbacks = if deregister_first {
                [deregistered, registered]
            } else {
                [registered, deregistered]
            };
            for address in callbacks {
                std::thread::spawn(move || unsafe {
                    register_complete(0, address as *const c_void, std::ptr::null());
                })
                .join()
                .unwrap();
            }
            assert_eq!(Arc::strong_count(&context), 1);
            assert!(*context.finished.lock().unwrap());
        }
    }

    #[test]
    fn windows_dns_names_utf16_and_socket_lengths_are_bounded() {
        for name in [
            "mythra-0123abcd._mythra-code._tcp.local",
            "MYTHRA-0123ABCD._MYTHRA-CODE._TCP.LOCAL.",
        ] {
            assert_eq!(
                instance_from_full_name(name).as_deref(),
                Some("mythra-0123abcd")
            );
        }
        for name in [
            "mythra-0123abcd._other._tcp.local",
            "é._mythra-code._tcp.local",
            "mythra-0123abcd._mythra-code._tcp.local.evil",
        ] {
            assert!(instance_from_full_name(name).is_none());
        }
        let text = wide("é UTF-16 🦀");
        assert_eq!(
            unsafe { narrow(text.as_ptr()) }.as_deref(),
            Some("é UTF-16 🦀")
        );
        assert!(unsafe { narrow([0xd800, 0].as_ptr()) }.is_none());
        assert!(unsafe { narrow(std::ptr::null()) }.is_none());
        assert!(unsafe { read_socket_address(std::ptr::null(), 32) }.is_none());
        let mut v4 = [0u8; 16];
        v4[..2].copy_from_slice(&2u16.to_ne_bytes());
        v4[4..8].copy_from_slice(&[192, 168, 1, 9]);
        assert!(unsafe { read_socket_address(v4.as_ptr(), 7) }.is_none());
        assert_eq!(
            unsafe { read_socket_address(v4.as_ptr(), 16) },
            Some(IpAddr::V4(Ipv4Addr::new(192, 168, 1, 9)))
        );
        let mut v6 = [0u8; 28];
        v6[..2].copy_from_slice(&23u16.to_ne_bytes());
        v6[8..24].copy_from_slice(&Ipv6Addr::LOCALHOST.octets());
        assert!(unsafe { read_socket_address(v6.as_ptr(), 23) }.is_none());
        assert_eq!(
            unsafe { read_socket_address(v6.as_ptr(), 28) },
            Some(IpAddr::V6(Ipv6Addr::LOCALHOST))
        );
        assert!(resolve("bad\0query", Duration::ZERO).is_err());
    }

    #[test]
    fn windows_network_status_is_bounded_on_an_already_sta_worker() {
        use ::windows::Win32::System::Com::COINIT_APARTMENTTHREADED;
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let joined = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) };
            let addresses = local_addresses();
            let status = network_status();
            if joined.is_ok() {
                unsafe { CoUninitialize() };
            }
            let _ = tx.send((addresses, status));
        });
        let (addresses, status) = rx
            .recv_timeout(Duration::from_secs(12))
            .expect("adapter/COM query on worker must finish without a desktop message loop");
        assert!(addresses.len() <= MAX_ADDRESSES);
        assert!(addresses.iter().all(|ip| address_is_usable(*ip)));
        assert!(status.fingerprint.len() < 16 * 1024);
    }

    #[test]
    #[ignore = "real LAN multicast advertise/browse/resolve and cancel; may need a Private-network firewall rule, never a desktop window"]
    fn windows_native_dns_sd_advertise_browse_resolve_and_cancel_headlessly() {
        let instance = format!("mythra-{}", &uuid::Uuid::new_v4().simple().to_string()[..8]);
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let (tx, rx) = std::sync::mpsc::sync_channel(128);
        let sink: DiscoverySink = Arc::new(move |event| {
            let _ = tx.try_send(event);
        });
        let request = AdvertiseRequest {
            instance: instance.clone(),
            port,
            txt: vec![("proto".into(), "1".into()), ("pairing".into(), "0".into())],
        };
        // Deliberately advertise first: a later browse must discover existing services.
        let advertised = advertise(&request, sink.clone())
            .expect("native DNS-SD registration/adapters unavailable");
        let browser = browse(sink).expect("native DNS-SD browse unavailable");
        let deadline = Instant::now() + Duration::from_secs(20);
        let mut found = false;
        while Instant::now() < deadline {
            match rx.recv_timeout(deadline.saturating_duration_since(Instant::now())) {
                Ok(DiscoveryEvent::Found(name)) if name == instance => {
                    found = true;
                    break;
                }
                Ok(DiscoveryEvent::Failed(reason)) => panic!("native DNS-SD failed: {reason:?}"),
                Ok(_) => {}
                Err(_) => break,
            }
        }
        assert!(found,"own DNS-SD announcement not browsed in 20s: inspect adapters, DNS Client service, multicast/firewall policy; no interactive-session API is used");
        for _ in 0..3 {
            let resolved = resolve(&instance, Duration::from_secs(5))
                .expect("native resolution of our own service");
            assert!(!resolved.addresses.is_empty());
            assert!(resolved.addresses.iter().all(|a| a.port() == port));
            assert!(resolved.txt.contains(&("pairing".into(), "0".into())));
        }
        // Move after start before Drop, like Core does. Exercise real cancellation
        // and let the documented final ERROR_CANCELLED callback arrive afterward.
        drop(Box::new(browser));
        drop(advertised);
        std::thread::sleep(Duration::from_millis(500));
        let absent = format!("mythra-{}", &uuid::Uuid::new_v4().simple().to_string()[..8]);
        let started = Instant::now();
        assert!(resolve(&absent, Duration::from_millis(100)).is_err());
        assert!(
            started.elapsed() < Duration::from_secs(3),
            "resolve cancellation must stay bounded"
        );
        std::thread::sleep(Duration::from_millis(500));
        let retained = RESOLVE_CONTEXTS.get().unwrap();
        let (before, retiring) = {
            let contexts = retained.lock().unwrap();
            (
                contexts.len(),
                contexts
                    .iter()
                    .filter(|entry| entry.finished_at.is_some())
                    .count(),
            )
        };
        eprintln!("Windows DNS-SD cancellation: contexts={before}, successfully cancelled/retiring={retiring}; exercising the real 60-second retirement grace");
        std::thread::sleep(RESOLVE_RETIRE_GRACE + Duration::from_millis(100));
        // Invalid names still sweep retirement, but cannot start another native query.
        assert!(resolve("invalid-service", Duration::ZERO).is_err());
        let after = retained.lock().unwrap().len();
        assert!(after<=before.saturating_sub(retiring),"successful cancellations must retire after the real grace; failed cancellations remain retained safely");
        std::thread::sleep(Duration::from_millis(500));
        eprintln!("Windows native DNS-SD: advertised, browsed, resolved three times, moved/cancelled browser, deregistered, cancelled missing-service resolve, retired after real grace; remaining={after}");
    }
}
