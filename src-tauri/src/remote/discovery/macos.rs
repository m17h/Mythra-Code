//! DNS-SD through `dns_sd.h`, which lives in libSystem. Each service ref is
//! owned by exactly one thread, as the header requires. Waits use `poll` with a
//! short timeout so a stop request is seen quickly and no call blocks forever.

use std::collections::{HashMap, HashSet};
use std::ffi::{c_char, c_int, c_void, CStr, CString};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, SocketAddrV4, SocketAddrV6};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc};
use std::time::{Duration, Instant};

use super::types::{
    instance_is_valid, tidy_addresses, txt_pairs, AdvertiseRequest, DiscoveryEvent,
    DiscoveryFailure, DiscoverySink, NetworkStatus, ResolvedService, MAX_ADDRESSES,
    MAX_INTERFACES_PER_SERVICE, MAX_SERVICES, SERVICE_TYPE,
};

type DnsServiceRef = *mut c_void;

const FLAG_MORE_COMING: u32 = 0x1;
const FLAG_ADD: u32 = 0x2;
const FLAG_NO_AUTO_RENAME: u32 = 0x8;
const PROTOCOL_IPV4: u32 = 0x1;
const PROTOCOL_IPV6: u32 = 0x2;
const ERR_NAME_CONFLICT: i32 = -65548;
const ERR_POLICY_DENIED: i32 = -65570;
const POLL_INTERVAL_MS: c_int = 150;
const ADDRESS_SETTLE: Duration = Duration::from_millis(250);
/// How long stopping waits for a pump thread. One stuck in the OS is left to
/// finish on its own: it owns everything it uses.
const STOP_WAIT: Duration = Duration::from_secs(1);
const LOCAL_DOMAIN: &CStr = c"local.";

type RegisterReply = unsafe extern "C" fn(
    DnsServiceRef,
    u32,
    i32,
    *const c_char,
    *const c_char,
    *const c_char,
    *mut c_void,
);
type BrowseReply = unsafe extern "C" fn(
    DnsServiceRef,
    u32,
    u32,
    i32,
    *const c_char,
    *const c_char,
    *const c_char,
    *mut c_void,
);
type ResolveReply = unsafe extern "C" fn(
    DnsServiceRef,
    u32,
    u32,
    i32,
    *const c_char,
    *const c_char,
    u16,
    u16,
    *const u8,
    *mut c_void,
);
type AddrInfoReply = unsafe extern "C" fn(
    DnsServiceRef,
    u32,
    u32,
    i32,
    *const c_char,
    *const libc::sockaddr,
    u32,
    *mut c_void,
);

extern "C" {
    fn DNSServiceRegister(
        sd_ref: *mut DnsServiceRef,
        flags: u32,
        interface_index: u32,
        name: *const c_char,
        regtype: *const c_char,
        domain: *const c_char,
        host: *const c_char,
        port: u16,
        txt_len: u16,
        txt_record: *const c_void,
        callback: Option<RegisterReply>,
        context: *mut c_void,
    ) -> i32;
    fn DNSServiceBrowse(
        sd_ref: *mut DnsServiceRef,
        flags: u32,
        interface_index: u32,
        regtype: *const c_char,
        domain: *const c_char,
        callback: Option<BrowseReply>,
        context: *mut c_void,
    ) -> i32;
    fn DNSServiceResolve(
        sd_ref: *mut DnsServiceRef,
        flags: u32,
        interface_index: u32,
        name: *const c_char,
        regtype: *const c_char,
        domain: *const c_char,
        callback: Option<ResolveReply>,
        context: *mut c_void,
    ) -> i32;
    fn DNSServiceGetAddrInfo(
        sd_ref: *mut DnsServiceRef,
        flags: u32,
        interface_index: u32,
        protocol: u32,
        hostname: *const c_char,
        callback: Option<AddrInfoReply>,
        context: *mut c_void,
    ) -> i32;
    fn DNSServiceRefSockFD(sd_ref: DnsServiceRef) -> c_int;
    fn DNSServiceProcessResult(sd_ref: DnsServiceRef) -> i32;
    fn DNSServiceRefDeallocate(sd_ref: DnsServiceRef);
}

fn failure(code: i32) -> DiscoveryFailure {
    match code {
        ERR_POLICY_DENIED => DiscoveryFailure::Denied,
        ERR_NAME_CONFLICT => DiscoveryFailure::NameConflict,
        other => DiscoveryFailure::Unavailable(format!("Network discovery failed ({other}).")),
    }
}

fn service_type() -> Result<CString, DiscoveryFailure> {
    CString::new(SERVICE_TYPE)
        .map_err(|_| DiscoveryFailure::Unavailable("Invalid service type.".into()))
}

/// `Ok(true)` when the socket has data, `Ok(false)` on timeout.
fn wait_readable(fd: c_int, timeout_ms: c_int) -> Result<bool, ()> {
    let mut entry = libc::pollfd {
        fd,
        events: libc::POLLIN,
        revents: 0,
    };
    // SAFETY: `entry` is one valid pollfd for the duration of the call.
    let ready = unsafe { libc::poll(&mut entry, 1, timeout_ms) };
    if ready < 0 {
        return if std::io::Error::last_os_error().kind() == std::io::ErrorKind::Interrupted {
            Ok(false)
        } else {
            Err(())
        };
    }
    Ok(ready > 0)
}

/// A service ref moved whole into the one thread that may touch it.
struct OwnedRef(DnsServiceRef);
// SAFETY: the ref is never shared; ownership transfers to a single thread.
unsafe impl Send for OwnedRef {}

impl Drop for OwnedRef {
    fn drop(&mut self) {
        // SAFETY: created by a successful DNSService* call and released once.
        unsafe { DNSServiceRefDeallocate(self.0) };
    }
}

/// Reclaims a callback context after its service ref has been released.
struct OwnedContext<T>(*mut T);
// SAFETY: the context moves with its service ref to a single thread.
unsafe impl<T: Send> Send for OwnedContext<T> {}

impl<T> Drop for OwnedContext<T> {
    fn drop(&mut self) {
        // SAFETY: produced by Box::into_raw and reclaimed exactly once, after
        // the service ref that could call back has been deallocated.
        drop(unsafe { Box::from_raw(self.0) });
    }
}

struct Pump {
    stop: Arc<AtomicBool>,
    /// Disconnects when the thread has released everything it owned.
    finished: mpsc::Receiver<()>,
}

impl Pump {
    fn start<T: Send + 'static>(
        name: &str,
        service: OwnedRef,
        context: OwnedContext<T>,
        sink: DiscoverySink,
    ) -> Result<Self, DiscoveryFailure> {
        let stop = Arc::new(AtomicBool::new(false));
        let flag = stop.clone();
        let (done, finished) = mpsc::channel::<()>();
        std::thread::Builder::new()
            .name(name.to_string())
            .spawn(move || {
                let _done = done;
                // Field order matters: the ref must be released before its context.
                let context = context;
                let service = service;
                // SAFETY: the ref is valid and owned by this thread.
                let fd = unsafe { DNSServiceRefSockFD(service.0) };
                if fd < 0 {
                    sink(DiscoveryEvent::Failed(DiscoveryFailure::Unavailable(
                        "Network discovery stopped.".into(),
                    )));
                }
                while fd >= 0 && !flag.load(Ordering::Relaxed) {
                    match wait_readable(fd, POLL_INTERVAL_MS) {
                        Ok(true) => {
                            // SAFETY: data is ready, so this does not block; the
                            // context outlives the ref.
                            let code = unsafe { DNSServiceProcessResult(service.0) };
                            if code != 0 {
                                sink(DiscoveryEvent::Failed(failure(code)));
                                break;
                            }
                        }
                        Ok(false) => {}
                        Err(()) => {
                            sink(DiscoveryEvent::Failed(DiscoveryFailure::Unavailable(
                                "Network discovery stopped.".into(),
                            )));
                            break;
                        }
                    }
                }
                drop(service);
                drop(context);
            })
            .map_err(|_| DiscoveryFailure::Unavailable("Could not start discovery.".into()))?;
        Ok(Self { stop, finished })
    }
}

impl Drop for Pump {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        let _ = self.finished.recv_timeout(STOP_WAIT);
    }
}

// ---- Advertise ----

pub struct Advertisement {
    _pump: Pump,
}

impl Advertisement {
    /// Bonjour follows address changes itself, so there is nothing to compare.
    pub fn network(&self) -> &str {
        ""
    }

    pub fn refused_registrations(&self) -> u32 {
        0
    }
}

struct RegisterContext {
    sink: DiscoverySink,
}

unsafe extern "C" fn register_reply(
    _service: DnsServiceRef,
    _flags: u32,
    error: i32,
    _name: *const c_char,
    _regtype: *const c_char,
    _domain: *const c_char,
    context: *mut c_void,
) {
    if error != 0 {
        // SAFETY: `context` is the live RegisterContext owned by the pump thread.
        let context = unsafe { &*(context as *const RegisterContext) };
        (context.sink)(DiscoveryEvent::Failed(failure(error)));
    }
}

fn encode_txt(entries: &[(String, String)]) -> Result<Vec<u8>, DiscoveryFailure> {
    let mut record = Vec::new();
    for (key, value) in entries {
        let entry = format!("{key}={value}");
        let length = u8::try_from(entry.len())
            .map_err(|_| DiscoveryFailure::Unavailable("The device name is too long.".into()))?;
        record.push(length);
        record.extend_from_slice(entry.as_bytes());
    }
    Ok(record)
}

pub fn advertise(
    request: &AdvertiseRequest,
    sink: DiscoverySink,
) -> Result<Advertisement, DiscoveryFailure> {
    let name = CString::new(request.instance.as_str())
        .map_err(|_| DiscoveryFailure::Unavailable("Invalid service name.".into()))?;
    let regtype = service_type()?;
    let txt = encode_txt(&request.txt)?;
    let txt_len = u16::try_from(txt.len())
        .map_err(|_| DiscoveryFailure::Unavailable("The announcement is too large.".into()))?;
    let context = Box::into_raw(Box::new(RegisterContext { sink: sink.clone() }));
    let owned_context = OwnedContext(context);
    let mut service: DnsServiceRef = std::ptr::null_mut();
    // SAFETY: every pointer is valid for the call; dns_sd copies the strings and
    // TXT bytes. `context` stays alive until after the ref is released.
    let code = unsafe {
        DNSServiceRegister(
            &mut service,
            FLAG_NO_AUTO_RENAME,
            0,
            name.as_ptr(),
            regtype.as_ptr(),
            LOCAL_DOMAIN.as_ptr(),
            std::ptr::null(),
            request.port.to_be(),
            txt_len,
            txt.as_ptr().cast(),
            Some(register_reply),
            context.cast(),
        )
    };
    if code != 0 {
        return Err(failure(code));
    }
    Ok(Advertisement {
        _pump: Pump::start("mythra-dnssd-register", OwnedRef(service), owned_context, sink)?,
    })
}

// ---- Browse ----

pub struct Browser {
    _pump: Pump,
}

struct BrowseContext {
    sink: DiscoverySink,
    /// One service shows up once per interface; it is gone after the last.
    interfaces: HashMap<String, HashSet<u32>>,
}

unsafe extern "C" fn browse_reply(
    _service: DnsServiceRef,
    flags: u32,
    interface_index: u32,
    error: i32,
    name: *const c_char,
    _regtype: *const c_char,
    _domain: *const c_char,
    context: *mut c_void,
) {
    // SAFETY: `context` is the live BrowseContext, used only on the pump thread.
    let context = unsafe { &mut *(context as *mut BrowseContext) };
    if error != 0 {
        (context.sink)(DiscoveryEvent::Failed(failure(error)));
        return;
    }
    if name.is_null() {
        return;
    }
    // SAFETY: dns_sd passes a NUL-terminated string valid during this call.
    let Ok(name) = unsafe { CStr::from_ptr(name) }.to_str() else {
        return;
    };
    if !instance_is_valid(name) {
        return;
    }
    if flags & FLAG_ADD != 0 {
        if !context.interfaces.contains_key(name) && context.interfaces.len() >= MAX_SERVICES {
            return;
        }
        let interfaces = context.interfaces.entry(name.to_string()).or_default();
        let first = interfaces.is_empty();
        if interfaces.len() < MAX_INTERFACES_PER_SERVICE {
            interfaces.insert(interface_index);
        }
        if first {
            (context.sink)(DiscoveryEvent::Found(name.to_string()));
        }
    } else if let Some(interfaces) = context.interfaces.get_mut(name) {
        interfaces.remove(&interface_index);
        if interfaces.is_empty() {
            context.interfaces.remove(name);
            (context.sink)(DiscoveryEvent::Lost(name.to_string()));
        }
    }
}

pub fn browse(sink: DiscoverySink) -> Result<Browser, DiscoveryFailure> {
    let regtype = service_type()?;
    let context = Box::into_raw(Box::new(BrowseContext {
        sink: sink.clone(),
        interfaces: HashMap::new(),
    }));
    let owned_context = OwnedContext(context);
    let mut service: DnsServiceRef = std::ptr::null_mut();
    // SAFETY: pointers are valid for the call and `context` outlives the ref.
    let code = unsafe {
        DNSServiceBrowse(
            &mut service,
            0,
            0,
            regtype.as_ptr(),
            LOCAL_DOMAIN.as_ptr(),
            Some(browse_reply),
            context.cast(),
        )
    };
    if code != 0 {
        return Err(failure(code));
    }
    Ok(Browser {
        _pump: Pump::start("mythra-dnssd-browse", OwnedRef(service), owned_context, sink)?,
    })
}

// ---- Resolve ----

#[derive(Default)]
struct ResolveContext {
    host: Option<CString>,
    port: u16,
    txt: Vec<(String, String)>,
    error: Option<i32>,
    done: bool,
}

/// Length-prefixed TXT strings; every read is bounds-checked because the bytes
/// came from an arbitrary device on the network.
fn parse_txt(record: &[u8]) -> Vec<(String, String)> {
    let mut strings = Vec::new();
    let mut offset = 0;
    while let Some(length) = record.get(offset).map(|byte| usize::from(*byte)) {
        let Some(entry) = record.get(offset + 1..offset + 1 + length) else {
            break;
        };
        offset += 1 + length;
        if let Ok(text) = std::str::from_utf8(entry) {
            if let Some((key, value)) = text.split_once('=') {
                strings.push((key, value));
            }
        }
    }
    txt_pairs(strings.into_iter())
}

unsafe extern "C" fn resolve_reply(
    _service: DnsServiceRef,
    _flags: u32,
    _interface_index: u32,
    error: i32,
    _full_name: *const c_char,
    host_target: *const c_char,
    port: u16,
    txt_len: u16,
    txt_record: *const u8,
    context: *mut c_void,
) {
    // SAFETY: `context` is the ResolveContext on the waiting thread's stack frame.
    let context = unsafe { &mut *(context as *mut ResolveContext) };
    context.done = true;
    if error != 0 {
        context.error = Some(error);
        return;
    }
    if !host_target.is_null() {
        // SAFETY: NUL-terminated and valid during this call.
        context.host = Some(unsafe { CStr::from_ptr(host_target) }.to_owned());
    }
    context.port = u16::from_be(port);
    if !txt_record.is_null() {
        // SAFETY: dns_sd guarantees `txt_len` readable bytes during this call.
        context.txt = parse_txt(unsafe { std::slice::from_raw_parts(txt_record, txt_len.into()) });
    }
}

#[derive(Default)]
struct AddressContext {
    addresses: Vec<SocketAddr>,
    settled: bool,
    error: Option<i32>,
}

unsafe extern "C" fn address_reply(
    _service: DnsServiceRef,
    flags: u32,
    _interface_index: u32,
    error: i32,
    _hostname: *const c_char,
    address: *const libc::sockaddr,
    _ttl: u32,
    context: *mut c_void,
) {
    // SAFETY: `context` is the AddressContext on the waiting thread's stack frame.
    let context = unsafe { &mut *(context as *mut AddressContext) };
    if error != 0 {
        context.error = Some(error);
        return;
    }
    if flags & FLAG_ADD != 0 && !address.is_null() && context.addresses.len() < MAX_ADDRESSES {
        // SAFETY: dns_sd passes a valid sockaddr for the family it declares.
        if let Some(parsed) = unsafe { read_sockaddr(address) } {
            if !context.addresses.contains(&parsed) {
                context.addresses.push(parsed);
            }
        }
    }
    context.settled = flags & FLAG_MORE_COMING == 0;
}

/// # Safety
/// `address` must point to a readable sockaddr of the declared family.
unsafe fn read_sockaddr(address: *const libc::sockaddr) -> Option<SocketAddr> {
    // SAFETY: guaranteed by the caller.
    match i32::from(unsafe { (*address).sa_family }) {
        libc::AF_INET => {
            // SAFETY: AF_INET means this is a sockaddr_in; it may be unaligned.
            let ipv4 = unsafe { std::ptr::read_unaligned(address.cast::<libc::sockaddr_in>()) };
            Some(SocketAddr::V4(SocketAddrV4::new(
                Ipv4Addr::from(u32::from_be(ipv4.sin_addr.s_addr)),
                0,
            )))
        }
        libc::AF_INET6 => {
            // SAFETY: AF_INET6 means this is a sockaddr_in6; it may be unaligned.
            let ipv6 = unsafe { std::ptr::read_unaligned(address.cast::<libc::sockaddr_in6>()) };
            Some(SocketAddr::V6(SocketAddrV6::new(
                Ipv6Addr::from(ipv6.sin6_addr.s6_addr),
                0,
                0,
                ipv6.sin6_scope_id,
            )))
        }
        _ => None,
    }
}

/// Runs one service ref on this thread until `finished` says stop or the
/// deadline passes. The ref is released before this returns.
fn pump_until(
    service: DnsServiceRef,
    deadline: Instant,
    mut finished: impl FnMut() -> bool,
) -> Result<bool, i32> {
    let service = OwnedRef(service);
    // SAFETY: the ref is valid and used only on this thread.
    let fd = unsafe { DNSServiceRefSockFD(service.0) };
    if fd < 0 {
        return Err(-1);
    }
    loop {
        if finished() {
            return Ok(true);
        }
        let now = Instant::now();
        if now >= deadline {
            return Ok(false);
        }
        let wait = deadline
            .saturating_duration_since(now)
            .as_millis()
            .min(POLL_INTERVAL_MS as u128) as c_int;
        match wait_readable(fd, wait.max(1)) {
            Ok(true) => {
                // SAFETY: data is ready, so this returns without blocking.
                let code = unsafe { DNSServiceProcessResult(service.0) };
                if code != 0 {
                    return Err(code);
                }
            }
            Ok(false) => {}
            Err(()) => return Err(-1),
        }
    }
}

/// Blocking and bounded by `wait`. Call off the async runtime.
pub fn resolve(instance: &str, wait: Duration) -> Result<ResolvedService, DiscoveryFailure> {
    if !instance_is_valid(instance) {
        return Err(DiscoveryFailure::Unavailable("Invalid service name.".into()));
    }
    let deadline = Instant::now() + wait;
    let name = CString::new(instance)
        .map_err(|_| DiscoveryFailure::Unavailable("Invalid service name.".into()))?;
    let regtype = service_type()?;

    let mut resolved = ResolveContext::default();
    let mut service: DnsServiceRef = std::ptr::null_mut();
    // SAFETY: pointers are valid; `resolved` outlives the ref, which pump_until
    // releases before returning.
    let code = unsafe {
        DNSServiceResolve(
            &mut service,
            0,
            0,
            name.as_ptr(),
            regtype.as_ptr(),
            LOCAL_DOMAIN.as_ptr(),
            Some(resolve_reply),
            (&raw mut resolved).cast(),
        )
    };
    if code != 0 {
        return Err(failure(code));
    }
    let answered = {
        let flag: *const bool = &raw const resolved.done;
        // SAFETY: the callback writes only on this thread, inside
        // DNSServiceProcessResult, so this read cannot overlap a write.
        pump_until(service, deadline, || unsafe { flag.read_volatile() }).map_err(failure)?
    };
    if let Some(code) = resolved.error {
        return Err(failure(code));
    }
    let host = match (answered, resolved.host.take()) {
        (true, Some(host)) => host,
        _ => return Err(DiscoveryFailure::Unavailable("The device did not answer.".into())),
    };
    // The target came from the network. Only ever look it up over mDNS, so a
    // hostile record cannot send this app to an outside DNS server.
    let lowered = host.to_string_lossy().to_ascii_lowercase();
    if !(lowered.ends_with(".local.") || lowered.ends_with(".local")) || resolved.port == 0 {
        return Err(DiscoveryFailure::Unavailable("The device gave an invalid address.".into()));
    }

    let mut found = AddressContext::default();
    let mut lookup: DnsServiceRef = std::ptr::null_mut();
    // SAFETY: pointers are valid; `found` outlives the ref, as above.
    let code = unsafe {
        DNSServiceGetAddrInfo(
            &mut lookup,
            0,
            0,
            PROTOCOL_IPV4 | PROTOCOL_IPV6,
            host.as_ptr(),
            Some(address_reply),
            (&raw mut found).cast(),
        )
    };
    if code != 0 {
        return Err(failure(code));
    }
    let mut settled_at: Option<Instant> = None;
    {
        let state: *const AddressContext = &raw const found;
        // SAFETY: same single-thread reasoning as the resolve wait above.
        pump_until(lookup, deadline, || unsafe {
            let state = &*state;
            if state.error.is_some() {
                return true;
            }
            if state.settled && !state.addresses.is_empty() {
                let since = *settled_at.get_or_insert_with(Instant::now);
                return since.elapsed() >= ADDRESS_SETTLE;
            }
            false
        })
        .map_err(failure)?;
    }
    if found.addresses.is_empty() {
        return Err(match found.error {
            Some(code) => failure(code),
            None => DiscoveryFailure::Unavailable("The device has no address yet.".into()),
        });
    }
    let port = resolved.port;
    let mut addresses = found.addresses;
    for address in &mut addresses {
        address.set_port(port);
    }
    addresses.sort_by_key(|address| !address.is_ipv4());
    Ok(ResolvedService {
        addresses,
        txt: resolved.txt,
    })
}

pub fn local_addresses() -> Vec<IpAddr> {
    let mut list: *mut libc::ifaddrs = std::ptr::null_mut();
    // SAFETY: getifaddrs fills `list`, released below with freeifaddrs.
    if unsafe { libc::getifaddrs(&mut list) } != 0 {
        return Vec::new();
    }
    let mut addresses = Vec::new();
    let mut cursor = list;
    while !cursor.is_null() {
        // SAFETY: `cursor` is a live node of the list getifaddrs returned.
        let entry = unsafe { &*cursor };
        let usable = entry.ifa_flags & libc::IFF_UP as u32 != 0
            && entry.ifa_flags & libc::IFF_LOOPBACK as u32 == 0
            // utun and ppp interfaces are VPNs, not this network.
            && entry.ifa_flags & libc::IFF_POINTOPOINT as u32 == 0
            && !entry.ifa_addr.is_null();
        if usable {
            // SAFETY: non-null ifa_addr points to a sockaddr of its family.
            if let Some(address) = unsafe { read_sockaddr(entry.ifa_addr) } {
                addresses.push(address.ip());
            }
        }
        cursor = entry.ifa_next;
    }
    // SAFETY: `list` came from getifaddrs and is freed once.
    unsafe { libc::freeifaddrs(list) };
    tidy_addresses(addresses)
}

/// macOS has no Public network profile, and Bonjour tracks addresses itself.
pub fn network_status() -> NetworkStatus {
    NetworkStatus::default()
}
