//! TLS 1.3 with RFC 7250 raw public keys in both directions.
//!
//! The server accepts any well-formed Ed25519 key, because authorization happens
//! afterwards from the proven key. The client checks the server key before
//! TLS 1.3 sends the client's own key, so an unknown server learns nothing about
//! this device. That check runs once the server's signature has verified, which
//! makes even a rejected key a proven one: discovery uses it to recognize one
//! device behind several services or addresses.

use std::collections::HashSet;
use std::sync::{Arc, Mutex, PoisonError};

use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::client::{AlwaysResolvesClientRawPublicKeys, Resumption};
use rustls::crypto::ring::{cipher_suite, default_provider};
use rustls::crypto::{verify_tls13_signature_with_raw_key, CryptoProvider};
use rustls::pki_types::{CertificateDer, ServerName, SubjectPublicKeyInfoDer, UnixTime};
use rustls::server::danger::{ClientCertVerified, ClientCertVerifier};
use rustls::server::{AlwaysResolvesServerRawPublicKeys, NoServerSessionStorage};
use rustls::{
    CertificateError, ClientConfig, DigitallySignedStruct, DistinguishedName, Error,
    PeerIncompatible, ServerConfig, SignatureScheme,
};

use super::identity::{fingerprint_of, DeviceIdentity};

pub(crate) const ALPN: &[u8] = b"mythra-remote";
/// Never sent (SNI is off), but the TLS API requires a name.
const UNUSED_SERVER_NAME: &str = "mythra-remote.invalid";
/// DER prefix of an Ed25519 SubjectPublicKeyInfo: exactly one encoding is
/// accepted, so one key can only ever have one fingerprint.
const ED25519_SPKI_PREFIX: [u8; 12] = [
    0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
];
const ED25519_SPKI_LENGTH: usize = ED25519_SPKI_PREFIX.len() + 32;

pub(crate) fn spki_is_ed25519(spki: &[u8]) -> bool {
    spki.len() == ED25519_SPKI_LENGTH && spki.starts_with(&ED25519_SPKI_PREFIX)
}

fn provider() -> Arc<CryptoProvider> {
    let mut provider = default_provider();
    provider.cipher_suites = vec![
        cipher_suite::TLS13_AES_256_GCM_SHA384,
        cipher_suite::TLS13_CHACHA20_POLY1305_SHA256,
        cipher_suite::TLS13_AES_128_GCM_SHA256,
    ];
    Arc::new(provider)
}

fn verify_handshake_signature(
    message: &[u8],
    spki: &CertificateDer<'_>,
    signature: &DigitallySignedStruct,
) -> Result<HandshakeSignatureValid, Error> {
    if signature.scheme != SignatureScheme::ED25519 || !spki_is_ed25519(spki.as_ref()) {
        return Err(Error::PeerIncompatible(
            PeerIncompatible::NoSignatureSchemesInCommon,
        ));
    }
    verify_tls13_signature_with_raw_key(
        message,
        &SubjectPublicKeyInfoDer::from(spki.as_ref()),
        signature,
        &default_provider().signature_verification_algorithms,
    )
}

fn no_tls12() -> Error {
    Error::General("TLS 1.3 is required".into())
}

/// How the client decides whether the server's key is acceptable.
#[derive(Debug, Clone)]
pub(crate) enum ServerKeyPolicy {
    /// One exact device, by fingerprint.
    Pinned(String),
    /// Any device already paired here. Used to match discovered services.
    PairedSet(HashSet<String>),
    /// Any well-formed key. Pairing from discovery only, and always followed
    /// by the commit-reveal code comparison.
    Capture,
}

/// The fingerprint the server proved, filled in whether or not it was accepted.
pub(crate) type ProvenKey = Arc<Mutex<Option<String>>>;

#[derive(Debug)]
struct ServerKeyVerifier {
    policy: ServerKeyPolicy,
    proven: ProvenKey,
}

impl ServerCertVerifier for ServerKeyVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, Error> {
        if !intermediates.is_empty() || !spki_is_ed25519(end_entity.as_ref()) {
            return Err(Error::InvalidCertificate(CertificateError::BadEncoding));
        }
        // The policy decision waits for the signature, below. Nothing of ours
        // is sent before that.
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        _message: &[u8],
        _cert: &CertificateDer<'_>,
        _signature: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, Error> {
        Err(no_tls12())
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        signature: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, Error> {
        let valid = verify_handshake_signature(message, cert, signature)?;
        let fingerprint = fingerprint_of(cert.as_ref());
        let accepted = match &self.policy {
            ServerKeyPolicy::Pinned(pinned) => fingerprint == *pinned,
            ServerKeyPolicy::PairedSet(paired) => paired.contains(&fingerprint),
            ServerKeyPolicy::Capture => true,
        };
        *self.proven.lock().unwrap_or_else(PoisonError::into_inner) = Some(fingerprint);
        if accepted {
            Ok(valid)
        } else {
            Err(Error::InvalidCertificate(
                CertificateError::ApplicationVerificationFailure,
            ))
        }
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        vec![SignatureScheme::ED25519]
    }

    fn requires_raw_public_keys(&self) -> bool {
        true
    }
}

/// Proves possession of a well-formed key and nothing more. Being able to
/// connect grants nothing; see `session::authorize`.
#[derive(Debug)]
struct AnyWellFormedClientKey;

impl ClientCertVerifier for AnyWellFormedClientKey {
    fn offer_client_auth(&self) -> bool {
        true
    }

    fn client_auth_mandatory(&self) -> bool {
        true
    }

    fn root_hint_subjects(&self) -> &[DistinguishedName] {
        &[]
    }

    fn verify_client_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        intermediates: &[CertificateDer<'_>],
        _now: UnixTime,
    ) -> Result<ClientCertVerified, Error> {
        if !intermediates.is_empty() || !spki_is_ed25519(end_entity.as_ref()) {
            return Err(Error::InvalidCertificate(CertificateError::BadEncoding));
        }
        Ok(ClientCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        _message: &[u8],
        _cert: &CertificateDer<'_>,
        _signature: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, Error> {
        Err(no_tls12())
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        signature: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, Error> {
        verify_handshake_signature(message, cert, signature)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        vec![SignatureScheme::ED25519]
    }

    fn requires_raw_public_keys(&self) -> bool {
        true
    }
}

pub(crate) fn server_config(identity: &DeviceIdentity) -> Result<Arc<ServerConfig>, String> {
    let mut config = ServerConfig::builder_with_provider(provider())
        .with_protocol_versions(&[&rustls::version::TLS13])
        .map_err(|_| "Could not prepare a secure connection.".to_string())?
        .with_client_cert_verifier(Arc::new(AnyWellFormedClientKey))
        .with_cert_resolver(Arc::new(AlwaysResolvesServerRawPublicKeys::new(
            identity.certified.clone(),
        )));
    config.alpn_protocols = vec![ALPN.to_vec()];
    // Every link proves both keys again; nothing is ever resumed from a ticket.
    config.session_storage = Arc::new(NoServerSessionStorage {});
    config.send_tls13_tickets = 0;
    config.max_early_data_size = 0;
    Ok(Arc::new(config))
}

pub(crate) fn client_config(
    identity: &DeviceIdentity,
    policy: ServerKeyPolicy,
    proven: ProvenKey,
) -> Result<Arc<ClientConfig>, String> {
    let mut config = ClientConfig::builder_with_provider(provider())
        .with_protocol_versions(&[&rustls::version::TLS13])
        .map_err(|_| "Could not prepare a secure connection.".to_string())?
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(ServerKeyVerifier { policy, proven }))
        .with_client_cert_resolver(Arc::new(AlwaysResolvesClientRawPublicKeys::new(
            identity.certified.clone(),
        )));
    config.alpn_protocols = vec![ALPN.to_vec()];
    config.enable_sni = false;
    config.resumption = Resumption::disabled();
    Ok(Arc::new(config))
}

pub(crate) fn server_name() -> Result<ServerName<'static>, String> {
    ServerName::try_from(UNUSED_SERVER_NAME)
        .map_err(|_| "Could not prepare a secure connection.".to_string())
}

/// True when a TLS failure means the server's key was refused by our policy.
pub(crate) fn is_key_rejection(error: &std::io::Error) -> bool {
    error
        .get_ref()
        .and_then(|inner| inner.downcast_ref::<Error>())
        .is_some_and(|inner| {
            matches!(
                inner,
                Error::InvalidCertificate(CertificateError::ApplicationVerificationFailure)
            )
        })
}
