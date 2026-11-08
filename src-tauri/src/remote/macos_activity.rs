//! Keeps macOS from App Napping the process while hosting. It does not keep the
//! Mac awake: a sleeping Mac is simply offline.

use objc2::rc::Retained;
use objc2::runtime::ProtocolObject;
use objc2_foundation::{NSActivityOptions, NSObjectProtocol, NSProcessInfo, NSString};

pub(crate) struct HostingActivity(Retained<ProtocolObject<dyn NSObjectProtocol>>);

// SAFETY: NSProcessInfo activity tokens are opaque and only passed back to
// NSProcessInfo, which is thread-safe.
unsafe impl Send for HostingActivity {}

impl HostingActivity {
    pub(crate) fn begin() -> Self {
        let reason = NSString::from_str("Hosting Mythra Code threads for nearby devices");
        Self(NSProcessInfo::processInfo().beginActivityWithOptions_reason(
            NSActivityOptions::UserInitiatedAllowingIdleSystemSleep,
            &reason,
        ))
    }
}

impl Drop for HostingActivity {
    fn drop(&mut self) {
        // SAFETY: the token came from beginActivityWithOptions:reason: and is
        // ended exactly once.
        unsafe { NSProcessInfo::processInfo().endActivity(&self.0) };
    }
}
