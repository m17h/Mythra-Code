//! Platform-neutral DNS-SD vocabulary. This file depends only on `std`, so the
//! Windows backend can be compiled alone in a scratch crate.

use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;

pub const SERVICE_TYPE: &str = "_mythra-code._tcp";
pub const INSTANCE_PREFIX: &str = "mythra-";
/// Addresses kept for one service or device; everything past this is dropped.
pub const MAX_ADDRESSES: usize = 8;
/// Services discovery keeps, native bookkeeping included. Extras are dropped.
pub const MAX_SERVICES: usize = 64;
/// Interfaces remembered for one service.
#[cfg(target_os = "macos")]
pub const MAX_INTERFACES_PER_SERVICE: usize = 16;
const MAX_TXT_ENTRIES: usize = 8;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DiscoveryFailure {
    /// The OS refused local network access for this app.
    Denied,
    /// Another service already owns this instance name; pick a new one.
    NameConflict,
    Unavailable(String),
}

#[derive(Clone, Debug)]
pub enum DiscoveryEvent {
    Found(String),
    Lost(String),
    Failed(DiscoveryFailure),
    /// One of several announcements was refused and the others carry on.
    #[cfg_attr(not(windows), allow(dead_code))]
    Narrowed,
}

/// Must return quickly and must not panic: it runs on an OS callback.
pub type DiscoverySink = Arc<dyn Fn(DiscoveryEvent) + Send + Sync>;

#[derive(Clone, Debug)]
pub struct AdvertiseRequest {
    pub instance: String,
    pub port: u16,
    pub txt: Vec<(String, String)>,
}

#[derive(Clone, Debug)]
pub struct ResolvedService {
    pub addresses: Vec<SocketAddr>,
    pub txt: Vec<(String, String)>,
}

/// What the OS says about the network being advertised on.
#[derive(Clone, Debug, Default)]
pub struct NetworkStatus {
    /// Changes when the addresses to advertise change. Empty where the OS
    /// follows address changes itself.
    pub fingerprint: String,
    /// `None` means unknown, which is never reported as Public.
    pub public: Option<bool>,
}

/// Exactly `mythra-` and eight lowercase hex digits. Anything else on the
/// network is not one of ours and is never parsed further.
pub fn instance_is_valid(name: &str) -> bool {
    name.strip_prefix(INSTANCE_PREFIX).is_some_and(|suffix| {
        suffix.len() == 8
            && suffix
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    })
}

/// IPv4-mapped IPv6 becomes plain IPv4, so no rule can be dodged by spelling an
/// address differently. Anything else keeps its scope and flow details.
pub fn canonical_socket(address: SocketAddr) -> SocketAddr {
    match address.ip().to_canonical() {
        ip @ IpAddr::V4(_) if address.is_ipv6() => SocketAddr::new(ip, address.port()),
        _ => address,
    }
}

/// 100.64.0.0/10, the shared range Tailscale and similar VPNs use. Such an
/// address says nothing about being on the same network, so it is never
/// advertised. A stored one may still be tried, after every LAN address.
pub fn address_is_vpn_range(address: IpAddr) -> bool {
    match address.to_canonical() {
        IpAddr::V4(ip) => {
            let [first, second, ..] = ip.octets();
            first == 100 && (second & 0xc0) == 64
        }
        IpAddr::V6(_) => false,
    }
}

/// Addresses to announce, or to accept from discovery, for this network.
pub fn address_is_usable(address: IpAddr) -> bool {
    if address_is_vpn_range(address) {
        return false;
    }
    match address.to_canonical() {
        IpAddr::V4(ip) => {
            !(ip.is_loopback()
                || ip.is_unspecified()
                || ip.is_link_local()
                || ip.is_multicast()
                || ip.is_broadcast())
        }
        IpAddr::V6(ip) => {
            let first = ip.segments()[0];
            !(ip.is_loopback()
                || ip.is_unspecified()
                || ip.is_multicast()
                || (first & 0xffc0) == 0xfe80)
        }
    }
}

/// IPv4 first, usable only, no duplicates, bounded. Order is otherwise kept.
pub fn tidy_addresses(addresses: Vec<IpAddr>) -> Vec<IpAddr> {
    let mut tidy: Vec<IpAddr> = Vec::new();
    for address in addresses.into_iter().map(|address| address.to_canonical()) {
        if address_is_usable(address) && !tidy.contains(&address) {
            tidy.push(address);
        }
    }
    tidy.sort_by_key(|address| !address.is_ipv4());
    tidy.truncate(MAX_ADDRESSES);
    tidy
}

/// Parses `key=value` TXT strings. Keys are lowercased; a repeated key keeps
/// the first value, as RFC 6763 section 6.4 requires.
pub fn txt_pairs<'a>(entries: impl Iterator<Item = (&'a str, &'a str)>) -> Vec<(String, String)> {
    let mut pairs: Vec<(String, String)> = Vec::new();
    for (key, value) in entries.take(MAX_TXT_ENTRIES) {
        let key = key.to_ascii_lowercase();
        if !key.is_empty() && !pairs.iter().any(|(existing, _)| *existing == key) {
            pairs.push((key, value.to_string()));
        }
    }
    pairs
}
