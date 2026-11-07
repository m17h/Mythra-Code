//! This installation's long-lived Ed25519 identity. The PKCS#8 bytes live only
//! in the OS credential store and in memory; they are never logged, written to
//! SQLite or sent anywhere. A key is generated only after the store confirms
//! none exists, so a locked or slow store can never replace a working identity.

use std::sync::Arc;
use std::time::Duration;

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use ring::rand::SystemRandom;
use ring::signature::Ed25519KeyPair;
use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};
use rustls::sign::CertifiedKey;
use sha2::{Digest, Sha256};
use tauri::AppHandle;
use tokio::sync::{Mutex, OwnedMutexGuard};
use tokio::time::timeout;

use crate::KEYRING_SERVICE;

/// Longer than an ordinary read because a first run can show a system prompt.
const STORE_WAIT: Duration = Duration::from_secs(20);
const UNAVAILABLE: &str = "Mythra Code could not open this device's secure key. Check for a system prompt, make sure your login keychain or credential store is unlocked, then try again.";

/// Never derives Debug: the certified key holds the private key.
pub(crate) struct DeviceIdentity {
    pub(crate) spki: Vec<u8>,
    pub(crate) fingerprint: String,
    pub(crate) certified: Arc<CertifiedKey>,
}

pub(crate) fn fingerprint_of(spki: &[u8]) -> String {
    let digest = Sha256::digest(spki);
    let mut text = String::with_capacity(digest.len() * 2);
    for byte in digest {
        text.push_str(&format!("{byte:02x}"));
    }
    text
}

pub(crate) fn fingerprint_is_valid(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn account(app: &AppHandle) -> String {
    format!("remote-device-identity:{}", app.config().identifier)
}

fn generate_pkcs8() -> Result<Vec<u8>, String> {
    let random = SystemRandom::new();
    Ed25519KeyPair::generate_pkcs8(&random)
        .map(|document| document.as_ref().to_vec())
        .map_err(|_| "Mythra Code could not create a device key. Try again.".to_string())
}

fn identity_from(pkcs8: Vec<u8>) -> Option<DeviceIdentity> {
    let provider = rustls::crypto::ring::default_provider();
    let key = provider
        .key_provider
        .load_private_key(PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(pkcs8)))
        .ok()?;
    let spki = key.public_key()?.as_ref().to_vec();
    if !super::tls::spki_is_ed25519(&spki) {
        return None;
    }
    let certificate = CertificateDer::from(spki.clone());
    Some(DeviceIdentity {
        fingerprint: fingerprint_of(&spki),
        spki,
        certified: Arc::new(CertifiedKey::new(vec![certificate], key)),
    })
}

fn load_blocking(account: &str) -> Result<DeviceIdentity, String> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, account).map_err(|_| UNAVAILABLE.to_string())?;
    match entry.get_password() {
        Ok(stored) => {
            if let Some(identity) = URL_SAFE_NO_PAD
                .decode(stored.trim())
                .ok()
                .and_then(identity_from)
            {
                return Ok(identity);
            }
            // Unusable bytes can never sign anything. Replacing them only means
            // paired devices must pair again.
        }
        Err(keyring::Error::NoEntry) => {}
        Err(_) => return Err(UNAVAILABLE.into()),
    }
    let pkcs8 = generate_pkcs8()?;
    entry
        .set_password(&URL_SAFE_NO_PAD.encode(&pkcs8))
        .map_err(|_| UNAVAILABLE.to_string())?;
    identity_from(pkcs8).ok_or_else(|| UNAVAILABLE.to_string())
}

/// One load at a time. The guard moves into the worker, so a stuck OS prompt
/// blocks only later loads, and a caller that gave up still benefits from the
/// result through `publish`.
pub(crate) async fn load_or_create(
    app: &AppHandle,
    gate: &Arc<Mutex<()>>,
    publish: impl FnOnce(Arc<DeviceIdentity>) + Send + 'static,
) -> Result<Arc<DeviceIdentity>, String> {
    if crate::release_qa::active() {
        return Err("Nearby devices are unavailable in this profile.".into());
    }
    let guard: OwnedMutexGuard<()> = timeout(STORE_WAIT, gate.clone().lock_owned())
        .await
        .map_err(|_| UNAVAILABLE.to_string())?;
    let account = account(app);
    let task = tauri::async_runtime::spawn_blocking(move || {
        let _guard = guard;
        load_blocking(&account).map(|identity| {
            let identity = Arc::new(identity);
            publish(identity.clone());
            identity
        })
    });
    match timeout(STORE_WAIT, task).await {
        Ok(Ok(result)) => result,
        _ => Err(UNAVAILABLE.into()),
    }
}


#[cfg(all(test, windows))]
mod windows_tests {
    use super::*;

    #[test]
    fn windows_identity_codec_rejects_bad_keys_without_formatting_private_bytes() {
        assert!(identity_from(Vec::new()).is_none());
        assert!(identity_from(vec![0; 128]).is_none());
        let bytes = generate_pkcs8().unwrap();
        let first = identity_from(bytes.clone()).unwrap();
        let second = identity_from(bytes).unwrap();
        assert!(first.fingerprint == second.fingerprint);
        assert!(super::super::tls::spki_is_ed25519(&first.spki));
        assert!(fingerprint_is_valid(&first.fingerprint));
        assert!(!fingerprint_is_valid(&"A".repeat(64)));
    }

}
