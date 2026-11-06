//! Native DNS-SD. Each platform file exposes the same entry points: `advertise`,
//! `browse`, `resolve`, `local_addresses` and `network_status`. Nothing here runs
//! until the caller decides rule 2 of the design contract allows it.

pub mod types;

#[cfg(target_os = "macos")]
#[path = "macos.rs"]
pub mod platform;

#[cfg(windows)]
#[path = "windows.rs"]
pub mod platform;

#[cfg(not(any(target_os = "macos", windows)))]
pub mod platform {
    use super::types::{
        AdvertiseRequest, DiscoveryFailure, DiscoverySink, NetworkStatus, ResolvedService,
    };
    use std::net::IpAddr;
    use std::time::Duration;

    pub struct Advertisement;
    pub struct Browser;

    impl Advertisement {
        pub fn network(&self) -> &str {
            ""
        }

        pub fn refused_registrations(&self) -> u32 {
            0
        }
    }

    fn unsupported() -> DiscoveryFailure {
        DiscoveryFailure::Unavailable("Nearby devices are not supported on this system.".into())
    }

    pub fn advertise(
        _request: &AdvertiseRequest,
        _sink: DiscoverySink,
    ) -> Result<Advertisement, DiscoveryFailure> {
        Err(unsupported())
    }

    pub fn browse(_sink: DiscoverySink) -> Result<Browser, DiscoveryFailure> {
        Err(unsupported())
    }

    pub fn resolve(_instance: &str, _wait: Duration) -> Result<ResolvedService, DiscoveryFailure> {
        Err(unsupported())
    }

    pub fn local_addresses() -> Vec<IpAddr> {
        Vec::new()
    }

    pub fn network_status() -> NetworkStatus {
        NetworkStatus::default()
    }
}
