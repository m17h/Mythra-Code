//! Pairing: explicit approval on the host, with a 6-digit comparison code.
//!
//! A bare exporter-derived code is not enough. An active machine in the middle
//! holds every secret of its own TLS session, so it could search offline for a
//! session whose code matches. The commit-reveal exchange stops that:
//!
//! 1. The initiator commits to its nonce (`pair.request`).
//! 2. The responder stores the commit, then returns its own nonce.
//! 3. The initiator reveals its nonce only after receiving the responder's.
//! 4. The responder checks the commit. Only then does either side show a code.
//!
//! Each side is locked to its nonce before seeing the other's, so an attacker
//! gets about a one-in-a-million guess per attempt, and attempts are limited.
//! Commit and code both bind the protocol version and the pairing mode, using
//! length-prefixed fields so no two different inputs hash alike.
//!
//! "Initiator" is the side that sent `pair.request` and "responder" the other,
//! whichever side dialed, so all of this works unchanged over a reverse link.
//!
//! The commit point on the host is the moment its approval is claimed under the
//! lock, which is also when the save takes its place in the write order. Cancel,
//! close, expiry or a dropped link before that stops the pairing. After it they
//! do nothing and the pairing stands, unless saving fails, and the user can
//! Revoke it. On the viewer, Cancel always wins: a save that finishes after it
//! restores only that save's viewer relationship, unless a newer viewer decision
//! has already superseded it.

use std::net::{IpAddr, SocketAddr};
use std::sync::atomic::Ordering;
use std::sync::{Arc, PoisonError};
use std::time::{Duration, Instant};

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::sync::oneshot;

use super::discovery::{platform as discovery_platform, types::MAX_ADDRESSES};
use super::identity::fingerprint_is_valid;
use super::session::{self, CloseReason, DialError, DialPurpose, Link, Reply};
use super::store::{self, DeviceGrant, DeviceRecord};
use super::tls::ServerKeyPolicy;
use super::wire::{clean_name, platform_name, Role, WireError, MAX_NAME_CHARS, PROTO};
use super::{Core, Inner};

const WINDOW_LIFETIME: Duration = Duration::from_secs(5 * 60);
const PENDING_LIFETIME: Duration = Duration::from_secs(60);
const MAX_NEARBY_FAILURES: u32 = 5;
const MAX_BAD_TOKENS: u32 = 5;
const RATE_LIMIT: u32 = 10;
const RATE_PERIOD: Duration = Duration::from_secs(60);
const MAX_RATE_ENTRIES: usize = 256;
const REQUEST_WAIT: Duration = Duration::from_secs(10);
/// Slightly longer than `PENDING_LIFETIME`, so the host's answer arrives first.
const APPROVAL_WAIT: Duration = Duration::from_secs(75);
const OFFER_LIMIT: Duration = Duration::from_secs(30);
const VIEWER_DIAL_LIMIT: Duration = Duration::from_secs(30);
const MAC_LOCAL_NETWORK_HELP:&str="macOS may be blocking Mythra Code from connecting to your local network. On this Mac, open System Settings → Privacy & Security → Local Network and turn on Mythra Code. If a permission prompt is open, choose Allow. Then choose Try again.";
const INVITATION_PREFIX: &str = "mythra-invite:1:";
const MAX_INVITATION_CHARS: usize = 2_048;
const TOKEN_BYTES: usize = 16;
const COMMIT_LABEL: &[u8] = b"mythra-remote-pair-commit-v1";
const CODE_LABEL: &[u8] = b"mythra-remote-pair-code-v1";
const UNNAMED_DEVICE: &str = "Unnamed device";
const INVITATION_CLOCK_SLACK_MS: i64 = 60_000;

fn random_bytes<const N: usize>() -> Result<[u8; N], String> {
    let mut bytes = [0u8; N];
    getrandom::fill(&mut bytes).map_err(|_| "Could not create a secure random value.".to_string())?;
    Ok(bytes)
}

fn decode_32(value: &str) -> Option<[u8; 32]> {
    if value.len() != 43 {
        return None;
    }
    URL_SAFE_NO_PAD.decode(value).ok()?.try_into().ok()
}

/// How a pairing started. Both sides work this out for themselves, so a
/// disagreement fails the commit check rather than producing a matching code.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum PairingMode {
    Nearby,
    Invitation,
    Offer,
}

impl PairingMode {
    fn label(self) -> &'static [u8] {
        match self {
            Self::Nearby => b"nearby",
            Self::Invitation => b"invitation",
            Self::Offer => b"offer",
        }
    }
}

/// Each field is preceded by its length, so fields cannot run into each other.
fn hash_fields(fields: &[&[u8]]) -> [u8; 32] {
    let mut digest = Sha256::new();
    for field in fields {
        digest.update((field.len() as u32).to_be_bytes());
        digest.update(field);
    }
    digest.finalize().into()
}

fn commitment(mode: PairingMode, exporter: &[u8; 32], nonce: &[u8; 32]) -> [u8; 32] {
    hash_fields(&[
        COMMIT_LABEL,
        &PROTO.to_be_bytes(),
        mode.label(),
        exporter,
        nonce,
    ])
}

fn pairing_code(
    mode: PairingMode,
    exporter: &[u8; 32],
    initiator_spki: &[u8],
    responder_spki: &[u8],
    initiator_nonce: &[u8; 32],
    responder_nonce: &[u8; 32],
) -> String {
    let hash = hash_fields(&[
        CODE_LABEL,
        &PROTO.to_be_bytes(),
        mode.label(),
        exporter,
        initiator_spki,
        responder_spki,
        initiator_nonce,
        responder_nonce,
    ]);
    let mut head = [0u8; 8];
    head.copy_from_slice(&hash[..8]);
    // A 64-bit value reduced by a million: the bias is below 2^-44.
    format!("{:06}", u64::from_be_bytes(head) % 1_000_000)
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    left.len() == right.len()
        && left
            .iter()
            .zip(right)
            .fold(0u8, |difference, (a, b)| difference | (a ^ b))
            == 0
}

// ---- Responder state (the host's window) ----

enum PendingStage {
    AwaitingReveal {
        commit: [u8; 32],
        nonce: [u8; 32],
    },
    AwaitingApproval {
        code: String,
        waiter: Option<oneshot::Sender<Result<Value, WireError>>>,
        /// The user approved before the peer asked for the answer.
        approved: Option<DeviceGrant>,
    },
    /// Past the commit point. Nothing but `finish_approval` may end this.
    Committing {
        code: String,
        waiter: oneshot::Sender<Result<Value, WireError>>,
    },
    /// On the viewer: an offer holding the slot. `accepted` means the local user
    /// said yes, so only the peer's answer is outstanding.
    Offered {
        accepted: bool,
    },
}

pub(super) struct PendingPair {
    pub(super) id: String,
    pub(super) link: Arc<Link>,
    stage: PendingStage,
    name: Option<String>,
    mode: PairingMode,
}

impl PendingPair {
    fn invited(&self) -> bool {
        self.mode == PairingMode::Invitation
    }

    fn committing(&self) -> bool {
        matches!(self.stage, PendingStage::Committing { .. })
    }

    /// Whether the slot timer still applies.
    fn can_expire(&self) -> bool {
        !matches!(
            self.stage,
            PendingStage::Committing { .. } | PendingStage::Offered { accepted: true }
        )
    }
}

pub(super) struct PairingWindow {
    id: u64,
    expires: Instant,
    expires_at_ms: i64,
    /// Hosting is off, so this window only receives offers. It has no
    /// invitation and never admits `pair.request`: nobody can gain access to
    /// this device through it.
    pub(super) temporary: bool,
    token: String,
    token_used: bool,
    invitation: Option<String>,
    nearby_failures: u32,
    bad_tokens: u32,
    pub(super) pending: Option<PendingPair>,
    /// Asked to close while a pairing was past its commit point. It closes when
    /// that pairing finishes, and nothing new starts meanwhile.
    close_requested: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct PairingRequestView {
    id: String,
    name: Option<String>,
    code: String,
    invited: bool,
    /// The user approved. Waiting for the other device or for the save.
    approved: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct PairingWindowView {
    invitation: Option<String>,
    expires_at: i64,
    temporary: bool,
    /// Five denied or failed attempts stopped nearby requests in this window.
    nearby_stopped: bool,
    /// The invitation was used, or five wrong tokens voided it.
    invitation_spent: bool,
    /// Someone holds the one pending slot, and the host can cancel them.
    waiting: bool,
    /// Filled only after the reveal is verified, so no code is shown early.
    request: Option<PairingRequestView>,
}

impl PairingWindow {
    pub(super) fn view(&self) -> PairingWindowView {
        PairingWindowView {
            invitation: self.invitation_usable().then(|| self.invitation.clone()).flatten(),
            expires_at: self.expires_at_ms,
            temporary: self.temporary,
            nearby_stopped: self.nearby_failures >= MAX_NEARBY_FAILURES,
            invitation_spent: self.invitation.is_some() && !self.invitation_usable(),
            waiting: self.pending.is_some(),
            request: self.pending.as_ref().and_then(|pending| {
                let (code, approved) = match &pending.stage {
                    PendingStage::AwaitingApproval { code, approved, .. } => {
                        (code, approved.is_some())
                    }
                    PendingStage::Committing { code, .. } => (code, true),
                    PendingStage::AwaitingReveal { .. } | PendingStage::Offered { .. } => {
                        return None;
                    }
                };
                Some(PairingRequestView {
                    id: pending.id.clone(),
                    name: pending.name.clone(),
                    code: code.clone(),
                    invited: pending.invited(),
                    approved,
                })
            }),
        }
    }

    pub(super) fn is_open(&self) -> bool {
        !self.close_requested && Instant::now() < self.expires
    }

    fn is_committing(&self) -> bool {
        self.pending.as_ref().is_some_and(PendingPair::committing)
    }

    fn invitation_usable(&self) -> bool {
        self.invitation.is_some() && !self.token_used && self.bad_tokens < MAX_BAD_TOKENS
    }

    /// Neither way in remains. A temporary window only ends by timing out,
    /// being closed, or finishing an offer.
    fn is_spent(&self) -> bool {
        !self.temporary
            && self.pending.is_none()
            && self.nearby_failures >= MAX_NEARBY_FAILURES
            && !self.invitation_usable()
    }
}

#[derive(Serialize, Deserialize)]
struct Invitation {
    fp: String,
    addrs: Vec<IpAddr>,
    port: u16,
    token: String,
    exp: i64,
}

fn encode_invitation(invitation: &Invitation) -> Result<String, String> {
    let body = serde_json::to_vec(invitation).map_err(|error| error.to_string())?;
    Ok(format!("{INVITATION_PREFIX}{}", URL_SAFE_NO_PAD.encode(body)))
}

fn parse_invitation(text: &str) -> Result<Invitation, String> {
    const INVALID: &str = "That doesn't look like a Mythra Code invitation. Copy the whole invitation and try again.";
    let text = text.trim();
    if text.len() > MAX_INVITATION_CHARS {
        return Err(INVALID.into());
    }
    let body = text.strip_prefix(INVITATION_PREFIX).ok_or(INVALID)?;
    let bytes = URL_SAFE_NO_PAD.decode(body).map_err(|_| INVALID)?;
    let mut invitation: Invitation = serde_json::from_slice(&bytes).map_err(|_| INVALID)?;
    if !fingerprint_is_valid(&invitation.fp)
        || invitation.port == 0
        || invitation.addrs.is_empty()
        || URL_SAFE_NO_PAD.decode(&invitation.token).map(|token| token.len()) != Ok(TOKEN_BYTES)
    {
        return Err(INVALID.into());
    }
    invitation.addrs.truncate(MAX_ADDRESSES);
    Ok(invitation)
}

/// With hosting on, this opens the normal window. With hosting off it opens a
/// temporary one, which the caller then backs with a temporary listener.
pub(super) async fn open_window(inner: &Arc<Inner>) -> Result<(), String> {
    const NO_NETWORK: &str = "This device isn't connected to a network. Connect to one, then try again.";
    let identity = inner.ensure_identity().await?;
    let (hosting, port) = {
        let core = inner.lock();
        if core.pairing.as_ref().is_some_and(PairingWindow::is_open) {
            return Ok(());
        }
        if core.pairing.as_ref().is_some_and(PairingWindow::is_committing) {
            return Err("Mythra Code is finishing a pairing. Try again in a moment.".into());
        }
        (core.settings.hosting, core.listener.as_ref().map(|listener| listener.port))
    };
    let addrs = discovery_platform::local_addresses();
    if addrs.is_empty() {
        return Err(NO_NETWORK.into());
    }
    let expires_at_ms = crate::unix_timestamp_ms() + WINDOW_LIFETIME.as_millis() as i64;
    let mut token = String::new();
    let mut invitation = None;
    if hosting {
        let port = port.ok_or("Mythra Code is still turning on access. Try again in a moment.")?;
        token = URL_SAFE_NO_PAD.encode(random_bytes::<TOKEN_BYTES>()?);
        invitation = Some(encode_invitation(&Invitation {
            fp: identity.fingerprint.clone(),
            addrs,
            port,
            token: token.clone(),
            exp: expires_at_ms,
        })?);
    }
    let id = inner.next_link_id.fetch_add(1, Ordering::Relaxed);
    {
        let mut core = inner.lock();
        // Only this function fills the slot, and it may have run twice at once.
        if core
            .pairing
            .as_ref()
            .is_some_and(|window| window.is_open() || window.is_committing())
        {
            return Ok(());
        }
        core.pairing = Some(PairingWindow {
            id,
            expires: Instant::now() + WINDOW_LIFETIME,
            expires_at_ms,
            temporary: !hosting,
            token,
            token_used: false,
            invitation,
            nearby_failures: 0,
            bad_tokens: 0,
            pending: None,
            close_requested: false,
        });
    }
    let expiry = inner.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(WINDOW_LIFETIME).await;
        let current = expiry.lock().pairing.as_ref().map(|window| window.id) == Some(id);
        if current {
            close_window(&expiry);
            expiry.changed();
        }
    });
    Ok(())
}

/// Closes the window and turns away anyone still waiting on it. A pairing past
/// its commit point stands, so that window closes when the pairing finishes.
pub(super) fn close_window(inner: &Arc<Inner>) {
    let window = {
        let mut core = inner.lock();
        if core.pairing.as_ref().is_some_and(PairingWindow::is_committing) {
            if let Some(window) = core.pairing.as_mut() {
                window.close_requested = true;
            }
            None
        } else {
            core.pairing.take()
        }
    };
    if let Some(pending) = window.and_then(|window| window.pending) {
        release_pending(pending, Err(closed_error()));
    }
    // A temporary listener stops with its window.
    inner.wake.notify_one();
}

fn closed_error() -> WireError {
    WireError::new("pairing_closed", "This device is not accepting pairing requests.")
}

fn release_pending(pending: PendingPair, result: Result<Value, WireError>) {
    let failed = result.is_err();
    let waiter = match pending.stage {
        PendingStage::AwaitingApproval { waiter, .. } => waiter,
        PendingStage::Committing { waiter, .. } => Some(waiter),
        PendingStage::AwaitingReveal { .. } | PendingStage::Offered { .. } => None,
    };
    let answered = waiter.is_some_and(|waiter| waiter.send(result).is_ok());
    if failed && !answered {
        pending.link.close(CloseReason::Refused);
    }
}

/// An attempt failed. Only nearby attempts spend the nearby budget; an invited
/// attempt has already spent its single-use token.
fn count_failure(core: &mut Core, mode: PairingMode) {
    if mode != PairingMode::Invitation {
        if let Some(window) = core.pairing.as_mut() {
            window.nearby_failures = window.nearby_failures.saturating_add(1);
        }
    }
    close_if_spent(core);
}

fn close_if_spent(core: &mut Core) {
    if core.pairing.as_ref().is_some_and(PairingWindow::is_spent) {
        core.pairing = None;
    }
}

/// Requests per source address per minute. The table cannot grow without limit:
/// when full, the entry that started longest ago is dropped.
fn rate_limited(core: &mut Core, ip: IpAddr) -> bool {
    let now = Instant::now();
    core.rate.retain(|_, (started, _)| now.duration_since(*started) < RATE_PERIOD);
    if core.rate.len() >= MAX_RATE_ENTRIES && !core.rate.contains_key(&ip) {
        if let Some(oldest) = core
            .rate
            .iter()
            .min_by_key(|(_, (started, _))| *started)
            .map(|(ip, _)| *ip)
        {
            core.rate.remove(&oldest);
        }
    }
    let entry = core.rate.entry(ip).or_insert((now, 0));
    entry.1 += 1;
    entry.1 > RATE_LIMIT
}

#[derive(Deserialize)]
struct PairRequestArgs {
    commit: String,
    #[serde(default)]
    token: Option<String>,
    #[serde(default)]
    name: Option<String>,
}

#[derive(Deserialize)]
struct PairRevealArgs {
    nonce: String,
}

fn refused_paired() -> WireError {
    WireError::new("forbidden", "This device is already paired.")
}

/// `pair.*` is valid only on an unpaired link, and only toward the host.
fn pairing_allowed(inner: &Arc<Inner>, link: &Link) -> Result<(), WireError> {
    let core = inner.lock();
    let granted = core
        .devices
        .get(&link.peer_fingerprint)
        .is_some_and(|device| device.grant.is_some());
    if link.role != Role::Host || link.is_paired() || granted {
        return Err(refused_paired());
    }
    Ok(())
}

pub(super) fn handle_request(inner: &Arc<Inner>, link: &Arc<Link>, args: Value) -> Reply {
    if let Err(error) = pairing_allowed(inner, link) {
        return Reply::DoneThenClose(Err(error));
    }
    let invalid = || WireError::new("forbidden", "That pairing request was not valid.");
    let Ok(args) = serde_json::from_value::<PairRequestArgs>(args) else {
        return Reply::DoneThenClose(Err(invalid()));
    };
    let Some(commit) = decode_32(&args.commit) else {
        return Reply::DoneThenClose(Err(invalid()));
    };
    let Ok(nonce) = random_bytes::<32>() else {
        return Reply::DoneThenClose(Err(WireError::new("internal", "Try again.")));
    };
    let (result, preempted) = {
        let mut core = inner.lock();
        admit(&mut core, link, &args, commit, nonce)
    };
    if let Some(pending) = preempted {
        release_pending(pending, Err(WireError::new("busy", "An invited device took this slot.")));
    }
    inner.changed();
    inner.wake.notify_one();
    match result {
        Ok(id) => {
            link.pairing_started.store(true, Ordering::Release);
            expire_pending_later(inner, id);
            Reply::Done(Ok(json!({ "nonce": URL_SAFE_NO_PAD.encode(nonce) })))
        }
        Err(error) => Reply::DoneThenClose(Err(error)),
    }
}

/// The limits, in order. A token is judged before anything else in the window
/// is touched, so a wrong one cannot take the slot, and a right one cannot be
/// blocked by a nearby attempt holding it.
fn admit(
    core: &mut Core,
    link: &Arc<Link>,
    args: &PairRequestArgs,
    commit: [u8; 32],
    nonce: [u8; 32],
) -> (Result<String, WireError>, Option<PendingPair>) {
    if rate_limited(core, session::limit_key(link.peer_addr.ip())) {
        return (
            Err(WireError::new("rate_limited", "Too many attempts. Wait a minute.")),
            None,
        );
    }
    let Some(window) = core
        .pairing
        .as_mut()
        .filter(|window| window.is_open() && !window.temporary)
    else {
        return (Err(closed_error()), None);
    };
    let mut preempted = None;
    let mode = if let Some(token) = args.token.as_deref() {
        let valid = window.invitation_usable()
            && constant_time_eq(token.as_bytes(), window.token.as_bytes());
        if !valid {
            window.bad_tokens = window.bad_tokens.saturating_add(1);
            close_if_spent(core);
            return (Err(WireError::new("forbidden", "That invitation is not valid.")), None);
        }
        // Past the commit point nothing can take the slot, so the token is kept.
        if window.is_committing() {
            return (Err(WireError::new("busy", "Another device is pairing right now.")), None);
        }
        // Single use: burned here, whatever the user later decides.
        window.token_used = true;
        preempted = window.pending.take();
        PairingMode::Invitation
    } else {
        if window.nearby_failures >= MAX_NEARBY_FAILURES {
            return (Err(closed_error()), None);
        }
        if window.pending.is_some() {
            // Costs the asker nothing, and costs the window nothing.
            return (Err(WireError::new("busy", "Another device is pairing right now.")), None);
        }
        if link.dialed {
            PairingMode::Offer
        } else {
            PairingMode::Nearby
        }
    };
    let id = uuid::Uuid::new_v4().to_string();
    // The commit is stored before this side's nonce leaves the machine.
    window.pending = Some(PendingPair {
        id: id.clone(),
        link: link.clone(),
        stage: PendingStage::AwaitingReveal { commit, nonce },
        name: args.name.as_deref().and_then(clean_name),
        mode,
    });
    (Ok(id), preempted)
}

/// A stranger who starts and stalls cannot hold the slot for long.
fn expire_pending_later(inner: &Arc<Inner>, id: String) {
    let inner = inner.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(PENDING_LIFETIME).await;
        let released = {
            let mut core = inner.lock();
            let pending = core
                .pairing
                .as_mut()
                .filter(|window| {
                    window
                        .pending
                        .as_ref()
                        .is_some_and(|pending| pending.id == id && pending.can_expire())
                })
                .and_then(|window| window.pending.take());
            if let Some(pending) = &pending {
                count_failure(&mut core, pending.mode);
            }
            pending
        };
        if let Some(pending) = released {
            release_pending(pending, Err(WireError::new("expired", "This request timed out.")));
            inner.changed();
            inner.wake.notify_one();
        }
    });
}

/// The host stops whoever is waiting, without spending any budget. Past the
/// commit point there is nothing left to stop.
pub(super) fn cancel_pending(inner: &Arc<Inner>) {
    let pending = inner
        .lock()
        .pairing
        .as_mut()
        .filter(|window| !window.is_committing())
        .and_then(|window| window.pending.take());
    if let Some(pending) = pending {
        release_pending(pending, Err(closed_error()));
    }
}

pub(super) fn handle_reveal(inner: &Arc<Inner>, link: &Arc<Link>, args: Value) -> Reply {
    if let Err(error) = pairing_allowed(inner, link) {
        return Reply::DoneThenClose(Err(error));
    }
    let Some(initiator_nonce) = serde_json::from_value::<PairRevealArgs>(args)
        .ok()
        .and_then(|args| decode_32(&args.nonce))
    else {
        return Reply::DoneThenClose(Err(WireError::new("forbidden", "That reveal was not valid.")));
    };
    let Some(identity) = inner.identity.get().cloned() else {
        return Reply::DoneThenClose(Err(WireError::new("internal", "Try again.")));
    };
    let verified = {
        let mut core = inner.lock();
        let outcome = core
            .pairing
            .as_mut()
            .and_then(|window| window.pending.as_mut())
            .filter(|pending| pending.link.id == link.id)
            .and_then(|pending| match &pending.stage {
                PendingStage::AwaitingReveal { commit, nonce } => {
                    Some((*commit, *nonce, pending.mode))
                }
                _ => None,
            })
            .map(|(commit, responder_nonce, mode)| {
                let matches = constant_time_eq(
                    &commitment(mode, &link.exporter, &initiator_nonce),
                    &commit,
                );
                (matches, responder_nonce, mode)
            });
        match outcome {
            Some((true, responder_nonce, mode)) => {
                let code = pairing_code(
                    mode,
                    &link.exporter,
                    &link.peer_spki,
                    &identity.spki,
                    &initiator_nonce,
                    &responder_nonce,
                );
                if let Some(pending) = core.pairing.as_mut().and_then(|window| window.pending.as_mut()) {
                    pending.stage = PendingStage::AwaitingApproval {
                        code,
                        waiter: None,
                        approved: None,
                    };
                }
                true
            }
            Some((false, _, mode)) => {
                // A failed commit check counts toward the window's limit.
                if let Some(window) = core.pairing.as_mut() {
                    window.pending = None;
                }
                count_failure(&mut core, mode);
                false
            }
            None => false,
        }
    };
    inner.changed();
    inner.wake.notify_one();
    if verified {
        Reply::Done(Ok(Value::Null))
    } else {
        Reply::DoneThenClose(Err(WireError::new("forbidden", "The pairing check failed.")))
    }
}

pub(super) async fn handle_await(inner: &Arc<Inner>, link: &Arc<Link>) -> Reply {
    if let Err(error) = pairing_allowed(inner, link) {
        return Reply::DoneThenClose(Err(error));
    }
    let (sender, receiver) = oneshot::channel();
    let installed = {
        let mut core = inner.lock();
        core.pairing
            .as_mut()
            .and_then(|window| window.pending.as_mut())
            .filter(|pending| pending.link.id == link.id)
            .and_then(|pending| {
                let id = pending.id.clone();
                match &mut pending.stage {
                    PendingStage::AwaitingApproval { waiter, approved, .. } if waiter.is_none() => {
                        *waiter = Some(sender);
                        Some((id, approved.take()))
                    }
                    _ => None,
                }
            })
    };
    let Some((request_id, approved)) = installed else {
        return Reply::DoneThenClose(Err(closed_error()));
    };
    // The user already said yes. A failure puts the request back on their screen.
    if let Some(grant) = approved {
        let inner = inner.clone();
        tauri::async_runtime::spawn(async move {
            let _ = commit_approval(&inner, &request_id, grant).await;
            inner.changed();
        });
    }
    match tokio::time::timeout(APPROVAL_WAIT, receiver).await {
        Ok(Ok(Ok(value))) => Reply::Done(Ok(value)),
        Ok(Ok(Err(error))) => Reply::DoneThenClose(Err(error)),
        _ => Reply::DoneThenClose(Err(closed_error())),
    }
}

const REQUEST_ENDED: &str = "That request has already ended.";

/// The host's answer to the approval sheet. Only ever called from local IPC.
pub(super) async fn respond(
    inner: &Arc<Inner>,
    request_id: &str,
    approve: bool,
    grant: Option<DeviceGrant>,
) -> Result<(), String> {
    if !approve {
        let released = {
            let mut core = inner.lock();
            let matched = core
                .pairing
                .as_ref()
                .and_then(|window| window.pending.as_ref())
                .is_some_and(|pending| pending.id == request_id && !pending.committing());
            if !matched {
                return Err(REQUEST_ENDED.into());
            }
            let pending = core.pairing.as_mut().and_then(|window| window.pending.take());
            if let Some(pending) = &pending {
                count_failure(&mut core, pending.mode);
            }
            pending
        };
        if let Some(pending) = released {
            release_pending(pending, Err(WireError::new("forbidden", "The request was declined.")));
        }
        inner.changed();
        inner.wake.notify_one();
        return Ok(());
    }

    let grant = grant.unwrap_or_else(DeviceGrant::initial).normalized()?;
    let peer_has_asked = {
        let mut core = inner.lock();
        let pending = core
            .pairing
            .as_mut()
            .filter(|window| window.is_open())
            .and_then(|window| window.pending.as_mut())
            .filter(|pending| pending.id == request_id && pending.link.is_open())
            .ok_or(REQUEST_ENDED)?;
        match &mut pending.stage {
            PendingStage::AwaitingApproval { waiter: Some(_), .. } => true,
            PendingStage::AwaitingApproval { approved, .. } => {
                *approved = Some(grant.clone());
                false
            }
            _ => return Err(REQUEST_ENDED.into()),
        }
    };
    if !peer_has_asked {
        // With an offer the viewer's user may still be deciding. The pairing
        // completes when both have said yes, whichever came first.
        inner.changed();
        return Ok(());
    }
    commit_approval(inner, request_id, grant).await
}

/// Exactly which approval is being saved, so the end of the save can only ever
/// act on this one, never on a newer window or a newer waiter.
struct ApprovalClaim {
    window_id: u64,
    request_id: String,
    link: Arc<Link>,
    relationship: u64,
    record: DeviceRecord,
}

/// Claims the approval and queues the save in one step under the lock. That step
/// is the commit point.
async fn commit_approval(
    inner: &Arc<Inner>,
    request_id: &str,
    grant: DeviceGrant,
) -> Result<(), String> {
    let (claim, saved) = {
        let mut core = inner.lock();
        if super::authenticated_links(&core) >= super::MAX_AUTHENTICATED_LINKS {
            return Err("Too many devices are connected right now. Disconnect one, then try again.".into());
        }
        let window = core
            .pairing
            .as_mut()
            .filter(|window| window.is_open())
            .ok_or(REQUEST_ENDED)?;
        let window_id = window.id;
        let pending = window
            .pending
            .as_mut()
            .filter(|pending| pending.id == request_id && pending.link.is_open())
            .ok_or(REQUEST_ENDED)?;
        let stage = std::mem::replace(&mut pending.stage, PendingStage::Offered { accepted: false });
        let (code, waiter) = match stage {
            PendingStage::AwaitingApproval { code, waiter: Some(waiter), .. } => (code, waiter),
            other => {
                pending.stage = other;
                return Err(REQUEST_ENDED.into());
            }
        };
        pending.stage = PendingStage::Committing { code, waiter };
        let link = pending.link.clone();
        let name = pending.name.clone();
        let mut record = core
            .devices
            .get(&link.peer_fingerprint)
            .cloned()
            .unwrap_or_else(|| new_record(&link));
        record.spki = link.peer_spki.clone();
        record.grant = Some(grant.succeeding(record.grant.as_ref()));
        if let Some(name) = name {
            record.name = name;
        }
        let relationship = core.relationship(&link.peer_fingerprint);
        let write = record.clone();
        core.begin_device_save(&link.peer_fingerprint);
        let saved =
            inner.enqueue_write(false, move |connection| store::save_pairing_host(connection, &write));
        (
            ApprovalClaim {
                window_id,
                request_id: request_id.to_string(),
                link,
                relationship,
                record,
            },
            saved,
        )
    };
    inner.changed();
    // Saved first: a device is never told it is paired before that is durable.
    let result = super::finish_write(saved)
        .await
        .map_err(|_| "Mythra Code could not save the device. Try again.".to_string());
    finish_approval(inner, claim, result)
}

/// Finishes exactly the claimed approval. A failed save puts the request back so
/// the user can try again. A revoke or forget of this device during the save
/// wins: its own write is already queued behind this one.
fn finish_approval(
    inner: &Arc<Inner>,
    claim: ApprovalClaim,
    result: Result<(), String>,
) -> Result<(), String> {
    let fingerprint = claim.link.peer_fingerprint.clone();
    let (pending, answer) = {
        let mut core = inner.lock();
        core.end_device_save(&fingerprint);
        inner.wake.notify_one();
        let unchanged = core.relationship(&fingerprint) == claim.relationship;
        let Some(window) = core
            .pairing
            .as_mut()
            .filter(|window| window.id == claim.window_id)
        else {
            return Err(REQUEST_ENDED.into());
        };
        let ours = window.pending.as_ref().is_some_and(|pending| {
            pending.id == claim.request_id
                && pending.link.id == claim.link.id
                && pending.committing()
        });
        if !ours {
            return Err(REQUEST_ENDED.into());
        }
        let window_open = window.is_open();
        match result {
            Err(message) if window_open && claim.link.is_open() => {
                if let Some(pending) = window.pending.as_mut() {
                    let stage =
                        std::mem::replace(&mut pending.stage, PendingStage::Offered { accepted: false });
                    if let PendingStage::Committing { code, waiter } = stage {
                        pending.stage = PendingStage::AwaitingApproval {
                            code,
                            waiter: Some(waiter),
                            approved: None,
                        };
                    }
                }
                drop(core);
                inner.changed();
                return Err(message);
            }
            Err(message) => {
                let pending = window.pending.take();
                if !window_open {
                    core.pairing = None;
                }
                (pending, Err(message))
            }
            Ok(()) if !unchanged => {
                let pending = window.pending.take();
                if !window_open {
                    core.pairing = None;
                }
                (pending, Err("This device's access changed. Pair it again.".to_string()))
            }
            Ok(()) => {
                let pending = window.pending.take();
                core.pairing = None;
                match core.devices.get_mut(&fingerprint) {
                    Some(device) => {
                        device.spki = claim.record.spki.clone();
                        device.name = claim.record.name.clone();
                        device.grant = claim.record.grant.clone();
                    }
                    None => {
                        core.devices.insert(fingerprint.clone(), claim.record.clone());
                    }
                }
                claim.link.set_paired();
                let reply = json!({
                    "name": super::device_name(&core),
                    "platform": platform_name(),
                    "port": super::advertised_port(&core),
                });
                (pending, Ok(reply))
            }
        }
    };
    let outcome = match answer {
        Ok(reply) => {
            inner.refresh_keep_active();
            if let Some(pending) = pending {
                release_pending(pending, Ok(reply));
            }
            Ok(())
        }
        Err(message) => {
            if let Some(pending) = pending {
                release_pending(pending, Err(closed_error()));
            }
            Err(message)
        }
    };
    inner.changed();
    inner.wake.notify_one();
    outcome
}

fn new_record(link: &Link) -> DeviceRecord {
    let name = link
        .peer_name
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .clone()
        .unwrap_or_else(|| UNNAMED_DEVICE.to_string());
    DeviceRecord {
        fingerprint: link.peer_fingerprint.clone(),
        spki: link.peer_spki.clone(),
        name,
        platform: None,
        addresses: Vec::new(),
        they_host: false,
        access_removed: false,
        paired_at: crate::unix_timestamp_ms() as i64,
        last_seen_at: Some(crate::unix_timestamp_ms() as i64),
        grant: None,
    }
}

/// Called when a link ends, so a dropped peer does not hold the window. Leaving
/// after the code was shown counts as a failed attempt.
pub(super) fn link_ended(inner: &Arc<Inner>, link: &Link) {
    let released = {
        let mut core = inner.lock();
        // Past the commit point the pairing stands, and its save will finish it.
        let ours = core
            .pairing
            .as_ref()
            .and_then(|window| window.pending.as_ref())
            .is_some_and(|pending| pending.link.id == link.id && !pending.committing());
        let pending = ours
            .then(|| core.pairing.as_mut().and_then(|window| window.pending.take()))
            .flatten();
        if let Some(pending) = &pending {
            count_failure(&mut core, pending.mode);
        }
        pending
    };
    if let Some(pending) = released {
        release_pending(pending, Err(closed_error()));
        inner.wake.notify_one();
    }
}

// ---- Initiator state (the viewer's flow) ----

#[derive(Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) enum FlowStage {
    Connecting,
    /// An offer with its code, waiting for this device's user.
    Offered,
    Comparing,
    Done,
    Failed,
}

pub(super) struct ViewerFlow {
    pub(super) id: u64,
    connect_started: Instant,
    target: String,
    pub(super) stage: FlowStage,
    code: Option<String>,
    error: Option<String>,
    fingerprint: Option<String>,
    pub(super) link: Option<Arc<Link>>,
    /// The user's answer to an offer.
    decision: Option<oneshot::Sender<bool>>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct FlowView {
    /// Names this flow when answering an offer.
    id: u64,
    target: String,
    stage: FlowStage,
    code: Option<String>,
    error: Option<String>,
    fingerprint: Option<String>,
}

impl ViewerFlow {
    pub(super) fn view(&self) -> FlowView {
        FlowView {
            id: self.id,
            target: self.target.clone(),
            stage: self.stage,
            code: self.code.clone(),
            error: self.error.clone(),
            fingerprint: self.fingerprint.clone(),
        }
    }

    pub(super) fn is_active(&self) -> bool {
        matches!(
            self.stage,
            FlowStage::Connecting | FlowStage::Offered | FlowStage::Comparing
        )
    }
}

fn begin_flow_locked(
    core: &mut Core,
    id: u64,
    target: String,
    link: Option<Arc<Link>>,
) -> Result<(), String> {
    if let Some(flow)=core.flow.as_mut().filter(|flow|flow.stage==FlowStage::Connecting&&flow.link.is_none()&&flow.connect_started.elapsed()>=VIEWER_DIAL_LIMIT){
        flow.stage=FlowStage::Failed;flow.error=Some("The connection attempt timed out. Choose Try again.".into());
    }
    if core.flow.as_ref().is_some_and(ViewerFlow::is_active) {
        return Err("Finish the pairing that is already in progress first.".into());
    }
    core.flow = Some(ViewerFlow {
        id,
        connect_started:Instant::now(),
        target,
        stage: FlowStage::Connecting,
        code: None,
        error: None,
        fingerprint: None,
        link,
        decision: None,
    });
    Ok(())
}

fn begin_flow(inner: &Arc<Inner>, target: String) -> Result<u64, String> {
    let id = inner.next_link_id.fetch_add(1, Ordering::Relaxed);
    begin_flow_locked(&mut inner.lock(), id, target, None)?;
    Ok(id)
}

fn update_flow(inner: &Arc<Inner>, id: u64, change: impl FnOnce(&mut ViewerFlow)) -> bool {
    let applied = {
        let mut core = inner.lock();
        match core.flow.as_mut().filter(|flow| flow.id == id) {
            Some(flow) => {
                change(flow);
                true
            }
            None => false,
        }
    };
    if applied {
        inner.changed();
    }
    applied
}

fn fail_flow(inner: &Arc<Inner>, id: u64, message: String) {
    let link={let mut core=inner.lock();let Some(flow)=core.flow.as_mut().filter(|flow|flow.id==id&&flow.is_active())else{return;};
        flow.stage=FlowStage::Failed;flow.code=None;flow.error=Some(message);flow.decision=None;flow.link.take()};
    if let Some(link)=link{link.close(CloseReason::Finished);}
    super::diagnostics::record(super::diagnostics::Event::Link,0,0,id,0,"pair.connect","failed");
    inner.changed();inner.wake.notify_one();
}

struct ConnectingAttempt{inner:Arc<Inner>,id:u64,armed:bool}
impl Drop for ConnectingAttempt{fn drop(&mut self){if self.armed{fail_flow(&self.inner,self.id,"The connection attempt ended before pairing finished. Choose Try again.".into());}}}
async fn viewer_dial_with_limit(
    inner:&Arc<Inner>,id:u64,target:&str,limit:Duration,
    dial:impl std::future::Future<Output=Result<Arc<Link>,DialError>>,
)->Result<Arc<Link>,DialError>{
    let mut guard=ConnectingAttempt{inner:inner.clone(),id,armed:true};
    super::diagnostics::record(super::diagnostics::Event::Link,0,0,id,0,"pair.connect","out");
    let result=tokio::time::timeout(limit,dial).await;
    let result=match result{Ok(result)=>result,Err(_)=>{super::diagnostics::record(super::diagnostics::Event::Link,0,0,id,0,"pair.connect","timeout");Err(DialError::Unreachable)}};
    if let Err(error)=&result{fail_flow(inner,id,explain_dial(inner,error,target));}
    guard.armed=false;result
}

fn explain_refusal(error: &WireError, target: &str, approving: bool) -> String {
    match error.code.as_str() {
        "pairing_closed" => format!(
            "{target} isn't ready to pair. On that device, open Settings, go to Connections, then Devices, and choose Pair a device. Then try again."
        ),
        "busy" => format!("{target} is reviewing another request. Try again in a moment."),
        "expired" => format!("{target} didn't approve in time. Try again."),
        "rate_limited" => "Too many attempts. Wait a minute, then try again.".into(),
        "forbidden" if approving => format!("{target} declined the request."),
        "forbidden" => format!(
            "{target} didn't accept this request. If it already lists this device, remove it there, then pair again."
        ),
        _ => format!("The connection to {target} was lost. Try again."),
    }
}

fn explain_dial(inner: &Inner, error: &DialError, target: &str) -> String {
    let (denied, this_device) = {
        let core = inner.lock();
        (core.denied_since.is_some()||core.outgoing_denied_since.is_some_and(|at|at.elapsed()<Duration::from_secs(120)), super::device_name(&core))
    };
    if (denied && cfg!(target_os = "macos"))||matches!(error,DialError::LocalNetworkMayBeBlocked) {
        return MAC_LOCAL_NETWORK_HELP.into();
    }
    match error {
        // Refused because the other side is newer, so this is the one to update.
        DialError::UpdateRequired => format!("These versions of Mythra Code can't connect. Update Mythra Code on {this_device} in Settings → Updates, then try again."),
        // Refused because this side is newer, so the other one has to update.
        DialError::PeerUpdateRequired => format!("These versions of Mythra Code can't connect. Update Mythra Code on {target} in Settings → Updates, then try again."),
        DialError::NotAccepting => format!("{target} isn't ready to pair. On that device, open Settings, go to Connections, then Devices, and choose Pair a device. Then try again."),
        DialError::KeyRejected(_) => format!("The device that answered isn't {target}. Check the invitation and try again."),
        // A timeout proves nothing about why, so everything here says "may".
        _ => format!("Mythra Code couldn't connect to {target}. It may be asleep, or Mythra Code may be closed there. This network may keep devices apart. Connect both computers to the same non-guest network, or ask the network owner to allow devices to connect. An invitation won't bypass this restriction."),
    }
}

/// Everything the initiator does once a link exists.
async fn run_initiator(
    inner: Arc<Inner>,
    flow_id: u64,
    link: Arc<Link>,
    token: Option<String>,
    target: String,
    mode: PairingMode,
) {
    let Some(identity) = inner.identity.get().cloned() else {
        fail_flow(&inner, flow_id, "Try again.".into());
        return;
    };
    link.pairing_started.store(true, Ordering::Release);
    let attached = update_flow(&inner, flow_id, |flow| {
        flow.link = Some(link.clone());
        flow.fingerprint = Some(link.peer_fingerprint.clone());
    });
    if !attached {
        link.close(CloseReason::Finished);
        return;
    }
    let Ok(nonce) = random_bytes::<32>() else {
        fail_flow(&inner, flow_id, "Try again.".into());
        return;
    };
    // An offer sends none of this device's details until its user accepts.
    let name = {
        let core = inner.lock();
        (mode != PairingMode::Offer && core.settings.share_name).then(|| super::device_name(&core))
    };
    let mut args =
        json!({ "commit": URL_SAFE_NO_PAD.encode(commitment(mode, &link.exporter, &nonce)) });
    if let Some(token) = token {
        args["token"] = json!(token);
    }
    if let Some(name) = name {
        args["name"] = json!(name);
    }
    let reply = match link.request("pair.request", args, REQUEST_WAIT).await {
        Ok(reply) => reply,
        Err(error) => {
            fail_flow(&inner, flow_id, explain_refusal(&error, &target, false));
            return;
        }
    };
    // Revealed only now, after the responder's nonce has been received.
    let Some(responder_nonce) = reply
        .get("nonce")
        .and_then(Value::as_str)
        .and_then(decode_32)
    else {
        fail_flow(&inner, flow_id, format!("The connection to {target} was lost. Try again."));
        return;
    };
    let revealed = link
        .request(
            "pair.reveal",
            json!({ "nonce": URL_SAFE_NO_PAD.encode(nonce) }),
            REQUEST_WAIT,
        )
        .await;
    if let Err(error) = revealed {
        fail_flow(&inner, flow_id, explain_refusal(&error, &target, false));
        return;
    }
    // The reveal was accepted, so a code may now be shown on this side too.
    let code = pairing_code(
        mode,
        &link.exporter,
        &identity.spki,
        &link.peer_spki,
        &nonce,
        &responder_nonce,
    );
    if mode == PairingMode::Offer {
        // A hostile host can approve itself, so nothing further happens until
        // this device's own user has seen the code and said yes. `pair.await`
        // is what lets the other side finish, and it has not been sent.
        let (decision, decided) = oneshot::channel();
        let shown = update_flow(&inner, flow_id, |flow| {
            flow.stage = FlowStage::Offered;
            flow.code = Some(code);
            flow.decision = Some(decision);
        });
        if !shown {
            link.close(CloseReason::Finished);
            return;
        }
        match tokio::time::timeout(PENDING_LIFETIME, decided).await {
            Ok(Ok(true)) => {}
            // Declined or cancelled: the flow is already gone.
            Ok(_) => {
                link.close(CloseReason::Finished);
                return;
            }
            Err(_) => {
                fail_flow(&inner, flow_id, format!("The offer from {target} timed out. Try again."));
                return;
            }
        }
    } else {
        update_flow(&inner, flow_id, |flow| {
            flow.stage = FlowStage::Comparing;
            flow.code = Some(code);
        });
    }
    let approved = match link.request("pair.await", Value::Null, APPROVAL_WAIT).await {
        Ok(approved) => approved,
        Err(error) => {
            fail_flow(&inner, flow_id, explain_refusal(&error, &target, true));
            return;
        }
    };

    let name = approved
        .get("name")
        .and_then(Value::as_str)
        .and_then(clean_name)
        .unwrap_or_else(|| target.chars().take(MAX_NAME_CHARS).collect());
    let port = approved
        .get("port")
        .and_then(Value::as_u64)
        .and_then(|port| u16::try_from(port).ok())
        .filter(|port| *port != 0);
    let platform: Option<String> = approved
        .get("platform")
        .and_then(Value::as_str)
        .map(|platform| platform.chars().take(16).collect());
    let mut addresses = Vec::new();
    if let Some(port) = port {
        addresses.push(SocketAddr::new(link.peer_addr.ip(), port).to_string());
    } else if link.dialed {
        addresses.push(link.peer_addr.to_string());
    }
    let is_current = |core: &Core| {
        core.flow
            .as_ref()
            .is_some_and(|flow| flow.id == flow_id && flow.stage == FlowStage::Comparing)
    };
    let fingerprint = link.peer_fingerprint.clone();
    // The flow is rechecked and the save queued in one step under the lock, so
    // a cancel lands wholly before this or wholly after it.
    let claimed = {
        let mut core = inner.lock();
        is_current(&core).then(|| {
            let mut record = core
                .devices
                .get(&fingerprint)
                .cloned()
                .unwrap_or_else(|| new_record(&link));
            record.spki = link.peer_spki.clone();
            record.name = name;
            record.platform = platform;
            record.they_host = true;
            record.access_removed = false;
            record.addresses = addresses;
            let relationship = core.relationship(&fingerprint);
            let undo = store::ViewerPairingUndo::new(&fingerprint, flow_id, core.devices.get(&fingerprint));
            let write = record.clone();
            let save_undo = undo.clone();
            core.begin_device_save(&fingerprint);
            let saved = inner
                .enqueue_write(false, move |connection| store::save_pairing_viewer(connection, &write, &save_undo));
            (record, relationship, undo, saved)
        })
    };
    let Some((record, relationship, undo, saved)) = claimed else {
        link.close(CloseReason::Finished);
        return;
    };
    let result = super::finish_write(saved).await;
    let finished = {
        let mut core = inner.lock();
        core.end_device_save(&fingerprint);
        inner.wake.notify_one();
        if !is_current(&core) {
            // A failed transactional save changed nothing. A successful one
            // needs its own viewer-only undo, not a stale full device snapshot.
            // The persisted token fences newer pairing/revoke/forget decisions.
            if result.is_ok() {
                core.unsaved.remember_viewer_undo(undo);
                core.unsaved.retry_at = None;
            }
            Err(None)
        } else if let Err(message) = result {
            Err(Some(message))
        } else if core.relationship(&fingerprint) != relationship {
            // A forget's own write is already queued behind this one.
            Err(Some("This device's access changed. Pair it again.".to_string()))
        } else {
            match core.devices.get_mut(&fingerprint) {
                // Details only: the grant here is the host side's and is not ours to replace.
                Some(device) => {
                    device.spki = record.spki;
                    device.name = record.name;
                    device.platform = record.platform;
                    device.they_host = true;
                    device.access_removed = false;
                    device.addresses = record.addresses;
                }
                None => {
                    core.devices.insert(fingerprint.clone(), record);
                }
            }
            link.set_paired();
            let others: Vec<Arc<Link>> = core
                .links
                .values()
                .filter(|other| {
                    other.id != link.id
                        && other.peer_fingerprint == fingerprint
                        && other.role == link.role
                        && other.is_paired()
                })
                .cloned()
                .collect();
            // The window here only existed to receive this offer. Dropping the
            // slot without releasing it leaves the now-paired link alone.
            let offer_slot = core
                .pairing
                .as_ref()
                .and_then(|window| window.pending.as_ref())
                .is_some_and(|pending| pending.link.id == link.id);
            if offer_slot {
                core.pairing = None;
            }
            Ok((
                others,
                json!({
                    "name": super::device_name(&core),
                    "platform": platform_name(),
                    "port": super::advertised_port(&core),
                }),
            ))
        }
    };
    let (others, update) = match finished {
        Ok(finished) => finished,
        Err(Some(message)) => {
            fail_flow(&inner, flow_id, message);
            return;
        }
        Err(None) => {
            link.close(CloseReason::Finished);
            inner.wake.notify_one();
            return;
        }
    };
    for other in others {
        other.close(CloseReason::Replaced);
    }
    inner.wake.notify_one();
    let _ = link.request("device.update", update, REQUEST_WAIT).await;
    update_flow(&inner, flow_id, |flow| {
        flow.stage = FlowStage::Done;
        flow.code = None;
        flow.link = None;
    });
    inner.wake.notify_one();
}

/// Dials addresses in order. Reports the most useful failure.
async fn dial_any(
    inner: &Arc<Inner>,
    addresses: &[SocketAddr],
    policy: ServerKeyPolicy,
    role: Role,
) -> Result<Arc<Link>, DialError> {
    let identity = inner.ensure_identity().await.map_err(|_| DialError::Failed)?;
    let mut failure = DialError::Unreachable;
    for address in addresses {
        match session::dial(inner, &identity, *address, policy.clone(), DialPurpose::Pairing(role)).await {
            Ok(link) => return Ok(link),
            Err(DialError::Unreachable) => {}
            Err(error) => failure = error,
        }
    }
    Err(failure)
}

pub(super) async fn start_nearby(inner: &Arc<Inner>, instance: &str) -> Result<(), String> {
    let (addresses, target) = inner.nearby_target(instance).await?;
    let flow_id = begin_flow(inner, target.clone())?;
    inner.changed();
    let inner = inner.clone();
    tauri::async_runtime::spawn(async move {
        match viewer_dial_with_limit(&inner,flow_id,&target,VIEWER_DIAL_LIMIT,dial_any(&inner, &addresses, ServerKeyPolicy::Capture, Role::Viewer)).await {
            Ok(link) => {
                run_initiator(inner, flow_id, link, None, target, PairingMode::Nearby).await;
            }
            Err(error) => {
                let message = explain_dial(&inner, &error, &target);
                fail_flow(&inner, flow_id, message);
            }
        }
    });
    Ok(())
}

pub(super) async fn start_invitation(inner: &Arc<Inner>, text: &str) -> Result<(), String> {
    let invitation = parse_invitation(text)?;
    if invitation.exp + INVITATION_CLOCK_SLACK_MS < crate::unix_timestamp_ms() as i64 {
        return Err("This invitation has expired. Create a new one and try again.".into());
    }
    let target = "That device".to_string();
    let flow_id = begin_flow(inner, target.clone())?;
    inner.changed();
    let addresses: Vec<SocketAddr> = invitation
        .addrs
        .iter()
        .map(|ip| SocketAddr::new(*ip, invitation.port))
        .collect();
    let inner = inner.clone();
    tauri::async_runtime::spawn(async move {
        // The invitation pins the host's key, so only that device can answer.
        match viewer_dial_with_limit(&inner,flow_id,&target,VIEWER_DIAL_LIMIT,dial_any(&inner, &addresses, ServerKeyPolicy::Pinned(invitation.fp), Role::Viewer)).await {
            Ok(link) => {
                let token = Some(invitation.token);
                run_initiator(inner, flow_id, link, token, target, PairingMode::Invitation).await;
            }
            Err(error) => {
                let message = explain_dial(&inner, &error, &target);
                fail_flow(&inner, flow_id, message);
            }
        }
    });
    Ok(())
}

/// Reverse pairing: a host that cannot accept connections dials a viewer whose
/// own window is open and offers to be paired. The viewer still sends
/// `pair.request`, and the approval sheet still appears on this host.
pub(super) async fn start_offer(inner: &Arc<Inner>, instance: &str) -> Result<(), String> {
    let (addresses, target) = inner.nearby_target(instance).await?;
    let window_open = inner
        .lock()
        .pairing
        .as_ref()
        .is_some_and(|window| window.is_open() && !window.temporary);
    if !window_open {
        return Err("Turn on Allow access from nearby devices, then choose Pair a device.".into());
    }
    let offer = async {
        let link = dial_any(inner, &addresses, ServerKeyPolicy::Capture, Role::Host)
            .await
            .map_err(|error| explain_dial(inner, &error, &target))?;
        link.pairing_started.store(true, Ordering::Release);
        match link.request("pair.offer", Value::Null, REQUEST_WAIT).await {
            Ok(_) => Ok(()),
            Err(error) => {
                link.close(CloseReason::Refused);
                Err(explain_refusal(&error, &target, false))
            }
        }
    };
    tokio::time::timeout(OFFER_LIMIT, offer)
        .await
        .map_err(|_| format!("{target} did not answer. Try again."))?
}

/// The viewer's side of an offer. Refused and invisible unless this device has
/// its own pairing window open, so a stranger cannot start anything here. An
/// offer is one more pending attempt: it takes the one slot, counts against the
/// source address, and a failed one spends the window's budget.
pub(super) fn handle_offer(inner: &Arc<Inner>, link: &Arc<Link>) -> Reply {
    if link.role != Role::Viewer || link.is_paired() {
        return Reply::DoneThenClose(Err(refused_paired()));
    }
    let target = link
        .peer_name
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .clone()
        .unwrap_or_else(|| "That device".to_string());
    let flow_id = inner.next_link_id.fetch_add(1, Ordering::Relaxed);
    let slot_id = uuid::Uuid::new_v4().to_string();
    let admitted: Result<(), WireError> = {
        let mut core = inner.lock();
        let busy = || WireError::new("busy", "Already pairing.");
        if rate_limited(&mut core, session::limit_key(link.peer_addr.ip())) {
            Err(WireError::new("rate_limited", "Too many attempts. Wait a minute."))
        } else if !core
            .pairing
            .as_ref()
            .is_some_and(|window| window.is_open() && window.nearby_failures < MAX_NEARBY_FAILURES)
        {
            Err(closed_error())
        } else if core.pairing.as_ref().is_some_and(|window| window.pending.is_some()) {
            Err(busy())
        } else if begin_flow_locked(&mut core, flow_id, target.clone(), Some(link.clone())).is_err() {
            Err(busy())
        } else {
            if let Some(window) = core.pairing.as_mut() {
                window.pending = Some(PendingPair {
                    id: slot_id.clone(),
                    link: link.clone(),
                    stage: PendingStage::Offered { accepted: false },
                    name: None,
                    mode: PairingMode::Offer,
                });
            }
            Ok(())
        }
    };
    if let Err(error) = admitted {
        return Reply::DoneThenClose(Err(error));
    }
    link.pairing_started.store(true, Ordering::Release);
    expire_pending_later(inner, slot_id);
    inner.changed();
    let task_inner = inner.clone();
    let task_link = link.clone();
    tauri::async_runtime::spawn(async move {
        run_initiator(task_inner, flow_id, task_link, None, target, PairingMode::Offer).await;
    });
    Reply::Done(Ok(Value::Null))
}

/// The local user's answer to an offer on screen. Only ever called from local
/// IPC, and only the offer named by `flow_id` can be answered.
pub(super) fn respond_offer(inner: &Arc<Inner>, flow_id: u64, accept: bool) -> Result<(), String> {
    const ENDED: &str = "That offer has already ended.";
    let decision = {
        let mut core = inner.lock();
        let flow = core
            .flow
            .as_mut()
            .filter(|flow| flow.id == flow_id && flow.stage == FlowStage::Offered)
            .ok_or(ENDED)?;
        let decision = flow.decision.take().ok_or(ENDED)?;
        let link_id = flow.link.as_ref().map(|link| link.id);
        if accept {
            flow.stage = FlowStage::Comparing;
            if let Some(pending) = core
                .pairing
                .as_mut()
                .and_then(|window| window.pending.as_mut())
                .filter(|pending| Some(pending.link.id) == link_id)
            {
                pending.stage = PendingStage::Offered { accepted: true };
            }
        }
        decision
    };
    if accept {
        let _ = decision.send(true);
    } else {
        // Closing the link ends the slot and spends the window's budget.
        cancel_flow(inner);
    }
    Ok(())
}

pub(super) fn cancel_flow(inner: &Arc<Inner>) {
    let link = {
        let mut core = inner.lock();
        core.flow.take().and_then(|flow| flow.link)
    };
    if let Some(link) = link {
        link.close(CloseReason::Finished);
    }
}

/// A link dropping mid-flow ends the flow.
pub(super) fn flow_link_ended(inner: &Arc<Inner>, link: &Link) {
    let affected = {
        let core = inner.lock();
        core.flow
            .as_ref()
            .filter(|flow| {
                flow.is_active()
                    && flow.link.as_ref().is_some_and(|ours| ours.id == link.id)
            })
            .map(|flow| (flow.id, flow.target.clone()))
    };
    if let Some((id, target)) = affected {
        fail_flow(inner, id, format!("The connection to {target} was lost. Try again."));
    }
}

// Loopback-only test fixture: bypass keychain/LAN enumeration, not the protocol.
#[cfg(test)]
pub(super) fn test_open_window(inner: &Arc<Inner>, temporary: bool, lifetime: Duration) -> String {
    let identity = inner.identity.get().unwrap();
    let mut core = inner.lock();
    let port = core.listener.as_ref().unwrap().port;
    let token = URL_SAFE_NO_PAD.encode(random_bytes::<TOKEN_BYTES>().unwrap());
    let invitation = encode_invitation(&Invitation {
        fp: identity.fingerprint.clone(), addrs: vec!["127.0.0.1".parse().unwrap()],
        port, token: token.clone(), exp: crate::unix_timestamp_ms() + 300_000,
    }).unwrap();
    let id = core.take_id();
    core.pairing = Some(PairingWindow {
        id, expires: Instant::now() + lifetime, expires_at_ms: crate::unix_timestamp_ms() + 300_000,
        temporary, token, token_used: false, invitation: (!temporary).then(|| invitation.clone()),
        nearby_failures: 0, bad_tokens: 0, pending: None, close_requested: false,
    });
    invitation
}

#[cfg(test)]
#[path = "pairing_cancel_tests.rs"]
mod cancellation_tests;

#[cfg(test)]
#[path="pairing_network_tests.rs"]
mod network_tests;
