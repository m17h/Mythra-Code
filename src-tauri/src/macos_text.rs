//! App-wide Writing Tools policy. Ordinary spelling services remain enabled.

use objc2::{msg_send, rc::Retained, runtime::Bool, sel, ClassType, MainThreadMarker};
use objc2_app_kit::NSWritingToolsBehavior;
use objc2_foundation::{NSArray, NSObject, NSObjectProtocol, NSProcessInfo, NSString, NSUUID};
use objc2_web_kit::{WKPreferences, WKWebViewConfiguration, WKWebsiteDataStore};

pub(crate) fn configuration(
    mtm: MainThreadMarker,
    incognito: bool,
    store_identifier: Option<[u8; 16]>,
) -> Retained<WKWebViewConfiguration> {
    // SAFETY: Window setup calls this on the AppKit main thread. Each selector
    // newer than our deployment target is guarded before sending it.
    unsafe {
        let config = WKWebViewConfiguration::new(mtm);

        // Supplying a configuration makes Wry use its store rather than apply
        // the builder's incognito/data-store options. Preserve those semantics,
        // including isolated profiles, instead of silently opening another store.
        let store = if incognito {
            WKWebsiteDataStore::nonPersistentDataStore(mtm)
        } else {
            let supports_identifiers: Bool = msg_send![
                WKWebsiteDataStore::class(),
                respondsToSelector: sel![dataStoreForIdentifier:]
            ];
            match store_identifier.filter(|_| supports_identifiers.as_bool()) {
                Some(identifier) => {
                    WKWebsiteDataStore::dataStoreForIdentifier(&NSUUID::from_bytes(identifier), mtm)
                }
                None => WKWebsiteDataStore::defaultDataStore(mtm),
            }
        };
        config.setWebsiteDataStore(&store);

        // Public macOS 15+ API, absent from our older-SDK Rust bindings. This
        // must be set BEFORE WKWebView creation: webview.configuration is a copy.
        if config.respondsToSelector(sel![setWritingToolsBehavior:]) {
            let _: () = msg_send![&config, setWritingToolsBehavior: NSWritingToolsBehavior::None];
            suppress_siri_affordance(&config);
        }
        config
    }
}

unsafe fn suppress_siri_affordance(config: &WKWebViewConfiguration) {
    // macOS 27 initially ignored writingToolsBehavior for the new Siri icon.
    // Upstream fix: WebKit 92c99b29d3a64dd7c5243c5b104c66a7141c103e.
    // Until the system WebKit includes it, disable only the selection updates
    // used by that affordance. This guarded SPI affects this webview's preferences,
    // not system Siri, text selection, spellcheck, or automatic correction.
    if NSProcessInfo::processInfo()
        .operatingSystemVersion()
        .majorVersion
        < 27
    {
        return;
    }
    let supports_features: Bool = msg_send![
        WKPreferences::class(), respondsToSelector: sel![_features]
    ];
    let preferences = config.preferences();
    if !supports_features.as_bool()
        || !preferences.respondsToSelector(sel![_setEnabled:forFeature:])
    {
        return;
    }
    let features: Retained<NSArray<NSObject>> = msg_send![WKPreferences::class(), _features];
    for feature in features.iter() {
        if !feature.respondsToSelector(sel![key]) {
            continue;
        }
        let key: Retained<NSString> = msg_send![&feature, key];
        if key.to_string() == "TextInputClientSelectionUpdatesEnabled" {
            let _: () = msg_send![&preferences, _setEnabled: Bool::NO, forFeature: &*feature];
            break;
        }
    }
}
