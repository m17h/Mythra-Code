//! Voice input transcription.
//!
//! Transcription keys are separate OS credential entries, never the chat
//! accounts: saving or removing one restarts no runtime and touches no other
//! credential. A pasted key arrives once, to be saved; no command returns a
//! stored key, and keys are never logged or kept in app settings. Recorded
//! models use one WAV upload; live models use the native streaming module.
//! Nothing is retried, because resending uncertain audio could be billed
//! twice. Provider error text is never relayed.

use std::collections::{HashSet, VecDeque};
use std::sync::{Arc, Mutex as StdMutex, MutexGuard, OnceLock, PoisonError};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use tauri::ipc::{InvokeBody, Request};
use tauri::State;
use tokio::sync::{oneshot, watch, Mutex};
use tokio::time::timeout;

use crate::{openrouter_key, KEYRING_READ_TIMEOUT, KEYRING_SERVICE};

const OPENAI_KEY_ACCOUNT: &str = "transcription-openai-api-key";
const OPENROUTER_KEY_ACCOUNT: &str = "transcription-openrouter-api-key";
const EMPTY_KEY_SLOT: KeySlot = KeySlot {
    known: None,
    reading: None,
    read_serial: 0,
    generation: 0,
};
static KEY_SLOTS: [StdMutex<KeySlot>; 2] = [StdMutex::new(EMPTY_KEY_SLOT), StdMutex::new(EMPTY_KEY_SLOT)];

const OPENAI_TRANSCRIPTION_URL: &str = "https://api.openai.com/v1/audio/transcriptions";
const OPENAI_MODELS_URL: &str = "https://api.openai.com/v1/models";
const OPENROUTER_TRANSCRIPTION_URL: &str = "https://openrouter.ai/api/v1/audio/transcriptions";
const OPENROUTER_TRANSCRIPTION_MODELS_URL: &str =
    "https://openrouter.ai/api/v1/models?output_modalities=transcription";

/// A credential store write that does not finish in time is reported; its
/// worker keeps the provider's write guard until the OS call returns.
const KEYRING_WRITE_TIMEOUT: Duration = Duration::from_secs(10);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const CATALOG_TIMEOUT: Duration = Duration::from_secs(20);
/// Upload plus OpenRouter's 60-second upstream processing limit.
const UPLOAD_TIMEOUT: Duration = Duration::from_secs(180);
const CATALOG_TTL: Duration = Duration::from_secs(30 * 60);
/// Repeated Refresh clicks within this window reuse the catalog just fetched.
const CATALOG_REFRESH_THROTTLE: Duration = Duration::from_secs(10);
const CATALOG_RESPONSE_LIMIT: usize = 4 * 1024 * 1024;
const TRANSCRIPT_RESPONSE_LIMIT: usize = 2 * 1024 * 1024;
/// Both providers accept 25 MB uploads; stay safely below it.
const MAX_AUDIO_BYTES: usize = 24_000_000;
const MAX_TRANSCRIPT_CHARS: usize = 100_000;
const MAX_CATALOG_ROWS: usize = 1_000;
const MAX_CACHED_UPLOAD_RESULTS: usize = 16;
const MAX_CACHED_UPLOAD_BYTES: usize = 2 * 1024 * 1024;
const UPLOAD_RESULT_TTL: Duration = Duration::from_secs(10 * 60);

const ID_HEADER: &str = "mythra-transcription-id";
const PROVIDER_HEADER: &str = "mythra-transcription-provider";
const MODEL_HEADER: &str = "mythra-transcription-model";

const CANCELED: &str = "Transcription canceled.";

/// OpenAI dictation models and labels. `/v1/models` carries no modality
/// metadata, so the fetched catalog intersects this allowlist with what the
/// key can see. `gpt-live-transcribe` uses the dedicated realtime path and is
/// rejected by upload admission below. Diarization needs extra parameters and
/// is deliberately absent.
const OPENAI_MODELS: [(&str, &str, &str); 5] = [
    ("gpt-transcribe", "GPT Transcribe", "Recommended for dictation"),
    ("gpt-live-transcribe", "GPT Live Transcribe", "Streams audio while you speak"),
    ("gpt-4o-transcribe", "GPT-4o Transcribe", "Earlier high-accuracy model"),
    ("gpt-4o-mini-transcribe", "GPT-4o mini Transcribe", "Lower cost"),
    ("whisper-1", "Whisper", "The original Whisper model"),
];
/// Families whose dated snapshots (`family-YYYY-MM-DD`) use the same endpoint.
const OPENAI_SNAPSHOT_FAMILIES: [&str; 3] =
    ["gpt-transcribe", "gpt-4o-transcribe", "gpt-4o-mini-transcribe"];

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub(crate) enum TranscriptionProvider {
    Openai,
    Openrouter,
}

impl TranscriptionProvider {
    fn parse(value: &str) -> Option<Self> {
        match value {
            "openai" => Some(Self::Openai),
            "openrouter" => Some(Self::Openrouter),
            _ => None,
        }
    }

    fn index(self) -> usize {
        match self {
            Self::Openai => 0,
            Self::Openrouter => 1,
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::Openai => "OpenAI",
            Self::Openrouter => "OpenRouter",
        }
    }

    fn account(self) -> &'static str {
        match self {
            Self::Openai => OPENAI_KEY_ACCOUNT,
            Self::Openrouter => OPENROUTER_KEY_ACCOUNT,
        }
    }

    fn transcription_url(self) -> &'static str {
        match self {
            Self::Openai => OPENAI_TRANSCRIPTION_URL,
            Self::Openrouter => OPENROUTER_TRANSCRIPTION_URL,
        }
    }
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub(crate) enum KeyState {
    Saved,
    Missing,
    /// The OS credential store failed, refused access or did not answer in time.
    Unavailable,
}

#[derive(Clone)]
enum KeyRead {
    Saved(String),
    Missing,
    Unavailable,
}

impl KeyRead {
    fn state(&self) -> KeyState {
        match self {
            Self::Saved(_) => KeyState::Saved,
            Self::Missing => KeyState::Missing,
            Self::Unavailable => KeyState::Unavailable,
        }
    }

    fn from_known(known: Option<String>) -> Self {
        known.map_or(Self::Missing, Self::Saved)
    }
}

/// Per-provider credential state. A blocked OS read is joined by later
/// callers instead of starting another worker; a successful write is
/// authoritative from then on and bumps `generation`, which invalidates any
/// model list fetched with the previous key.
struct KeySlot {
    known: Option<Option<String>>,
    reading: Option<(u64, watch::Receiver<Option<KeyRead>>)>,
    read_serial: u64,
    generation: u64,
}

fn key_slot(provider: TranscriptionProvider) -> MutexGuard<'static, KeySlot> {
    KEY_SLOTS[provider.index()]
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
}

fn key_generation(provider: TranscriptionProvider) -> u64 {
    key_slot(provider).generation
}

#[derive(Debug, Serialize)]
pub(crate) struct TranscriptionKeyStatus {
    openai: KeyState,
    openrouter: KeyState,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TranscriptionModel {
    id: String,
    name: String,
    description: Option<String>,
    recommended: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TranscriptionCatalog {
    models: Vec<TranscriptionModel>,
    /// "live" came from the provider; "builtin" is the documented allowlist.
    source: &'static str,
    notice: Option<String>,
}

struct CachedCatalog {
    fetched: Instant,
    /// Key generation the list was fetched with (OpenAI lists depend on the key).
    generation: u64,
    models: Vec<TranscriptionModel>,
}

type UploadResult = Result<String, String>;
type SharedUploadResult = Arc<UploadResult>;

#[derive(PartialEq, Eq)]
struct UploadIdentity {
    provider: TranscriptionProvider,
    model: String,
    audio_digest: [u8; 32],
}

struct RunningUpload {
    id: String,
    identity: UploadIdentity,
    cancel: Option<oneshot::Sender<()>>,
    cancel_requested: bool,
    result: watch::Sender<Option<SharedUploadResult>>,
}

struct CachedUploadResult {
    id: String,
    identity: UploadIdentity,
    finished: Instant,
    result: SharedUploadResult,
}

#[derive(Default)]
struct ActiveUploads {
    current: Option<RunningUpload>,
    live_id: Option<String>,
    /// Native-issued IDs are monotonic within a random process namespace.
    /// IDs below the high-water mark can never dispatch another paid request,
    /// even after their cached result has expired or been evicted.
    issued_sequence: u64,
    consumed_sequence: u64,
    results: VecDeque<CachedUploadResult>,
    result_cleanup_running: bool,
}

impl ActiveUploads {
    fn prune_results(&mut self) {
        while self.results.front().is_some_and(|entry| entry.finished.elapsed() >= UPLOAD_RESULT_TTL) {
            self.results.pop_front();
        }
    }

    fn remember_result(&mut self, id: String, identity: UploadIdentity, result: SharedUploadResult) {
        self.prune_results();
        self.results.retain(|entry| entry.id != id);
        self.results.push_back(CachedUploadResult { id, identity, finished: Instant::now(), result });
        let result_bytes = |entry: &CachedUploadResult| match entry.result.as_ref() {
            Ok(text) | Err(text) => text.len(),
        };
        while self.results.len() > MAX_CACHED_UPLOAD_RESULTS
            || self.results.iter().map(result_bytes).sum::<usize>() > MAX_CACHED_UPLOAD_BYTES
        {
            self.results.pop_front();
        }
    }
}

#[derive(Default)]
pub(crate) struct TranscriptionState {
    /// One credential write per provider. The guard moves into the blocking
    /// worker, so a stuck OS call blocks only later writes for that provider
    /// and repeated clicks never queue more workers.
    writes: [Arc<Mutex<()>>; 2],
    /// Held across a fetch, so concurrent callers share one request.
    catalogs: [Mutex<Option<CachedCatalog>>; 2],
    uploads: Arc<StdMutex<ActiveUploads>>,
    request_namespace: OnceLock<String>,
    pub(super) live: crate::live_transcription::LiveTranscriptionState,
}

pub(super) struct LiveTranscriptionLease {
    uploads: Arc<StdMutex<ActiveUploads>>,
    id: String,
}

impl Drop for LiveTranscriptionLease {
    fn drop(&mut self) {
        let mut uploads = self.uploads.lock().unwrap_or_else(PoisonError::into_inner);
        if uploads.live_id.as_deref() == Some(self.id.as_str()) { uploads.live_id = None; }
    }
}

pub(super) async fn live_openai_key() -> Result<(String, u64), String> {
    let generation = key_generation(TranscriptionProvider::Openai);
    let key = match read_key(TranscriptionProvider::Openai).await {
        KeyRead::Saved(key) => key,
        KeyRead::Missing => return Err("No OpenAI transcription key is saved. Add one in Settings › Voice input.".into()),
        KeyRead::Unavailable => return Err("The transcription key could not be read from the OS credential store.".into()),
    };
    if live_openai_key_generation() != generation { return Err("The transcription key changed. Start dictation again.".into()); }
    Ok((key, generation))
}

pub(super) fn live_openai_key_generation() -> u64 { key_generation(TranscriptionProvider::Openai) }

struct UploadGuard<'a> {
    state: &'a TranscriptionState,
    id: String,
    finished: bool,
}

enum UploadAdmission<'a> {
    Start(UploadGuard<'a>, oneshot::Receiver<()>),
    Join(watch::Receiver<Option<SharedUploadResult>>),
    Complete(SharedUploadResult),
}

impl UploadGuard<'_> {
    fn finish(mut self, result: UploadResult) -> UploadResult {
        let result = self.state.finish_upload(&self.id, result);
        self.finished = true;
        result.as_ref().clone()
    }
}

impl Drop for UploadGuard<'_> {
    fn drop(&mut self) {
        if !self.finished {
            self.state.finish_upload(&self.id, Err(
                "The transcription stopped before its result was received. It may still be billed; Mythra Code did not retry it.".into(),
            ));
        }
    }
}

impl TranscriptionState {
    pub(super) fn reserve_live(&self, id: &str) -> Result<LiveTranscriptionLease, String> {
        let mut uploads = self.uploads.lock().unwrap_or_else(PoisonError::into_inner);
        let sequence = self.request_sequence(&uploads, id).ok_or("The dictation request ID is invalid. Start again.")?;
        if sequence <= uploads.consumed_sequence { return Err("This dictation session already ended or was canceled. Start a new recording.".into()); }
        if uploads.current.is_some() || uploads.live_id.is_some() { return Err("Another voice input session is still finishing.".into()); }
        uploads.consumed_sequence = sequence;
        uploads.live_id = Some(id.to_owned());
        Ok(LiveTranscriptionLease { uploads: self.uploads.clone(), id: id.to_owned() })
    }
    fn request_sequence(&self, uploads: &ActiveUploads, id: &str) -> Option<u64> {
        let prefix = self.request_namespace.get()?;
        let suffix = id.strip_prefix(prefix.as_str())?.strip_prefix('-')?;
        if suffix.len() != 16 || !suffix.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)) {
            return None;
        }
        let sequence = u64::from_str_radix(suffix, 16).ok()?;
        (sequence > 0 && sequence <= uploads.issued_sequence).then_some(sequence)
    }

    fn begin_upload(&self, id: &str, identity: UploadIdentity) -> Result<UploadAdmission<'_>, String> {
        let mut uploads = self
            .uploads
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        uploads.prune_results();
        let sequence = self.request_sequence(&uploads, id)
            .ok_or_else(|| "The transcription request ID is invalid. Start a new recording.".to_string())?;
        if let Some(current) = uploads.current.as_ref().filter(|current| current.id == id) {
            if current.identity != identity {
                return Err("The transcription request ID was reused for a different recording.".into());
            }
            return Ok(UploadAdmission::Join(current.result.subscribe()));
        }
        if let Some(cached) = uploads.results.iter().find(|entry| entry.id == id) {
            if cached.identity != identity {
                return Err("The transcription request ID was reused for a different recording.".into());
            }
            return Ok(UploadAdmission::Complete(cached.result.clone()));
        }
        if sequence <= uploads.consumed_sequence {
            return Err("This recording was already processed or canceled. Its result is no longer available; it was not uploaded again.".into());
        }
        if uploads.current.is_some() || uploads.live_id.is_some() {
            return Err("Another recording is still being transcribed.".into());
        }
        let (sender, receiver) = oneshot::channel();
        let (result, _) = watch::channel(None);
        uploads.consumed_sequence = sequence;
        uploads.current = Some(RunningUpload {
            id: id.to_string(), identity, cancel: Some(sender), cancel_requested: false, result,
        });
        Ok(UploadAdmission::Start(
            UploadGuard {
                state: self,
                id: id.to_string(),
                finished: false,
            },
            receiver,
        ))
    }

    fn finish_upload(&self, id: &str, result: UploadResult) -> SharedUploadResult {
        let mut uploads = self.uploads.lock().unwrap_or_else(PoisonError::into_inner);
        let Some(current) = uploads.current.take() else { return Arc::new(result); };
        if current.id != id {
            uploads.current = Some(current);
            return Arc::new(result);
        }
        let result = Arc::new(if current.cancel_requested { Err(CANCELED.into()) } else { result });
        uploads.remember_result(id.to_string(), current.identity, result.clone());
        current.result.send_replace(Some(result.clone()));
        if !uploads.result_cleanup_running {
            uploads.result_cleanup_running = true;
            let weak_uploads = Arc::downgrade(&self.uploads);
            // One expiry worker per state; it retains neither audio nor the
            // state while sleeping and releases transcripts even when idle.
            tauri::async_runtime::spawn(async move {
                loop {
                    let delay = {
                        let Some(shared) = weak_uploads.upgrade() else { return; };
                        let mut uploads = shared.lock().unwrap_or_else(PoisonError::into_inner);
                        uploads.prune_results();
                        match uploads.results.front() {
                            Some(entry) => UPLOAD_RESULT_TTL.saturating_sub(entry.finished.elapsed()),
                            None => { uploads.result_cleanup_running = false; return; }
                        }
                    };
                    tokio::time::sleep(delay).await;
                }
            });
        }
        result
    }

    fn cancel_upload(&self, id: &str) {
        let mut uploads = self
            .uploads
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let Some(sequence) = self.request_sequence(&uploads, id) else { return; };
        uploads.consumed_sequence = uploads.consumed_sequence.max(sequence);
        if let Some(current) = uploads.current.as_mut().filter(|current| current.id == id) {
            current.cancel_requested = true;
            if let Some(sender) = current.cancel.take() {
                let _ = sender.send(());
            }
            return;
        }
        // A cancel after completion also discards any retained transcript.
        uploads.results.retain(|entry| entry.id != id);
    }
}

#[tauri::command]
pub(crate) fn transcription_request_id(state: State<'_, TranscriptionState>) -> Result<String, String> {
    let namespace = state.request_namespace.get_or_init(|| uuid::Uuid::new_v4().to_string());
    let mut uploads = state.uploads.lock().unwrap_or_else(PoisonError::into_inner);
    uploads.issued_sequence = uploads.issued_sequence.checked_add(1)
        .ok_or_else(|| "Could not create a transcription request ID.".to_string())?;
    Ok(format!("{namespace}-{:016x}", uploads.issued_sequence))
}

fn client() -> Result<&'static reqwest::Client, String> {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    if let Some(client) = CLIENT.get() {
        return Ok(client);
    }
    // No redirects: a bearer key must only ever reach the fixed host it was
    // addressed to. Disable reqwest's default protocol-level retries too:
    // one recording must never be replayed by our HTTP retry policy.
    let built = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .retry(reqwest::retry::never())
        .https_only(true)
        .connect_timeout(CONNECT_TIMEOUT)
        .build()
        .map_err(|_| "Could not prepare the transcription connection.".to_string())?;
    Ok(CLIENT.get_or_init(|| built))
}

/// Only a confirmed absent entry is `Missing`; locked, denied, failed or
/// slow credential store reads are `Unavailable`.
async fn read_key(provider: TranscriptionProvider) -> KeyRead {
    let mut receiver = {
        let mut slot = key_slot(provider);
        if let Some(known) = slot.known.clone() {
            return KeyRead::from_known(known);
        }
        if let Some((_, receiver)) = slot.reading.as_ref() {
            receiver.clone()
        } else {
            slot.read_serial = slot.read_serial.wrapping_add(1);
            let serial = slot.read_serial;
            let (sender, receiver) = watch::channel(None);
            slot.reading = Some((serial, receiver.clone()));
            let account = provider.account();
            tauri::async_runtime::spawn_blocking(move || {
                let result = match keyring::Entry::new(KEYRING_SERVICE, account)
                    .and_then(|entry| entry.get_password())
                {
                    Ok(value) if !value.trim().is_empty() => KeyRead::Saved(value),
                    Ok(_) | Err(keyring::Error::NoEntry) => KeyRead::Missing,
                    Err(_) => KeyRead::Unavailable,
                };
                {
                    let mut slot = key_slot(provider);
                    if slot.reading.as_ref().is_some_and(|(current, _)| *current == serial) {
                        slot.reading = None;
                    }
                }
                let _ = sender.send(Some(result));
            });
            receiver
        }
    };
    let result = timeout(KEYRING_READ_TIMEOUT, async {
        loop {
            if let Some(value) = receiver.borrow().clone() {
                return value;
            }
            if receiver.changed().await.is_err() {
                return KeyRead::Unavailable;
            }
        }
    })
    .await
    .unwrap_or(KeyRead::Unavailable);
    // A write that finished while this read was pending is authoritative.
    if let Some(known) = key_slot(provider).known.clone() {
        return KeyRead::from_known(known);
    }
    result
}

fn validate_api_key(value: &str) -> Result<String, String> {
    let key = value.trim();
    if key.len() < 8
        || key.len() > 512
        || key.chars().any(|character| character.is_whitespace() || character.is_control())
    {
        return Err("That doesn't look like an API key. Paste the whole key and try again.".into());
    }
    Ok(key.to_string())
}

async fn write_key(
    state: &TranscriptionState,
    provider: TranscriptionProvider,
    value: Option<String>,
) -> Result<(), String> {
    let label = provider.label();
    let guard = state.writes[provider.index()]
        .clone()
        .try_lock_owned()
        .map_err(|_| {
            format!("The {label} transcription key is still being updated. Try again in a moment.")
        })?;
    let account = provider.account();
    let task = tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let _guard = guard;
        let entry = keyring::Entry::new(KEYRING_SERVICE, account)
            .map_err(|_| "Could not open the OS credential store. Check for a system prompt, then try again.".to_string())?;
        let written = match value.as_deref() {
            Some(key) => entry
                .set_password(key)
                .map_err(|_| format!("Could not save the {label} transcription key. Check that the OS credential store is unlocked, then try again.")),
            None => match entry.delete_credential() {
                Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
                Err(_) => Err(format!(
                    "Could not remove the {label} transcription key. Check that the OS credential store is unlocked, then try again."
                )),
            },
        };
        if written.is_ok() {
            // Published while the write guard is still held, so writes are
            // published in order, including one that finishes after its
            // caller stopped waiting.
            let mut slot = key_slot(provider);
            slot.known = Some(value);
            slot.generation = slot.generation.wrapping_add(1);
        }
        written
    });
    match timeout(KEYRING_WRITE_TIMEOUT, task).await {
        Err(_) => {
            return Err(
                "The OS credential store did not respond. Check for a system prompt, then reopen Voice input settings to see whether the key was saved."
                    .into(),
            )
        }
        Ok(Err(_)) => return Err("The credential task failed. Try again.".into()),
        Ok(Ok(result)) => result?,
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn transcription_key_status() -> TranscriptionKeyStatus {
    let (openai, openrouter) = tokio::join!(
        read_key(TranscriptionProvider::Openai),
        read_key(TranscriptionProvider::Openrouter)
    );
    TranscriptionKeyStatus {
        openai: openai.state(),
        openrouter: openrouter.state(),
    }
}

#[tauri::command]
pub(crate) async fn transcription_save_key(
    state: State<'_, TranscriptionState>,
    provider: TranscriptionProvider,
    api_key: String,
) -> Result<(), String> {
    let key = validate_api_key(&api_key)?;
    write_key(&state, provider, Some(key)).await
}

#[tauri::command]
pub(crate) async fn transcription_remove_key(
    state: State<'_, TranscriptionState>,
    provider: TranscriptionProvider,
) -> Result<(), String> {
    write_key(&state, provider, None).await
}

/// Copies the Models & accounts OpenRouter key into the separate transcription
/// entry without it ever reaching the renderer. `false` means there was no
/// account key to copy. The chat key itself is only read.
#[tauri::command]
pub(crate) async fn transcription_copy_openrouter_account_key(
    state: State<'_, TranscriptionState>,
) -> Result<bool, String> {
    let Some(key) = openrouter_key().await else {
        return Ok(false);
    };
    // The account key was saved for chat, so "paste the whole key" would not help.
    let key = validate_api_key(&key).map_err(|_| "The OpenRouter key saved in Models & accounts can't be used for voice input. Replace it there, or add a separate voice input key.".to_string())?;
    write_key(&state, TranscriptionProvider::Openrouter, Some(key)).await?;
    Ok(true)
}

fn valid_model_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-' | b':' | b'/'))
}

fn openai_model_supported(id: &str) -> bool {
    if OPENAI_MODELS.iter().any(|(model, _, _)| *model == id) {
        return true;
    }
    OPENAI_SNAPSHOT_FAMILIES.iter().any(|family| {
        id.strip_prefix(family)
            .and_then(|rest| rest.strip_prefix('-'))
            .is_some_and(|date| {
                let bytes = date.as_bytes();
                bytes.len() == 10
                    && bytes.iter().enumerate().all(|(index, byte)| {
                        if index == 4 || index == 7 {
                            *byte == b'-'
                        } else {
                            byte.is_ascii_digit()
                        }
                    })
            })
    })
}

fn openai_model_entry(id: &str) -> TranscriptionModel {
    let known = OPENAI_MODELS.iter().find(|(model, _, _)| *model == id);
    TranscriptionModel {
        id: id.to_string(),
        name: known.map_or_else(|| id.to_string(), |(_, name, _)| (*name).to_string()),
        description: Some(known.map_or("Dated snapshot", |(_, _, detail)| *detail).to_string()),
        recommended: id == OPENAI_MODELS[0].0,
    }
}

fn builtin_openai_models() -> Vec<TranscriptionModel> {
    OPENAI_MODELS
        .iter()
        .map(|(id, _, _)| openai_model_entry(id))
        .collect()
}

fn parse_openai_models(value: &Value) -> Vec<TranscriptionModel> {
    let mut seen = HashSet::new();
    let mut models: Vec<TranscriptionModel> = value
        .get("data")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .take(MAX_CATALOG_ROWS * 4)
        .filter_map(|row| row.get("id").and_then(Value::as_str))
        .filter(|id| openai_model_supported(id) && seen.insert(id.to_string()))
        .map(openai_model_entry)
        .collect();
    let rank = |id: &str| {
        OPENAI_MODELS
            .iter()
            .position(|(model, _, _)| *model == id)
            .unwrap_or(OPENAI_MODELS.len())
    };
    models.sort_by(|left, right| rank(&left.id).cmp(&rank(&right.id)).then(left.id.cmp(&right.id)));
    models
}

fn bounded_text(value: Option<&Value>, limit: usize) -> Option<String> {
    let text = value?.as_str()?.split_whitespace().collect::<Vec<_>>().join(" ");
    if text.is_empty() {
        return None;
    }
    Some(if text.chars().count() > limit {
        format!("{}…", text.chars().take(limit).collect::<String>())
    } else {
        text
    })
}

fn parse_openrouter_models(value: &Value) -> Vec<TranscriptionModel> {
    let has_modality = |row: &Value, field: &str, wanted: &str| {
        row.pointer(&format!("/architecture/{field}"))
            .and_then(Value::as_array)
            .is_some_and(|modalities| modalities.iter().any(|entry| entry.as_str() == Some(wanted)))
    };
    let mut seen = HashSet::new();
    let mut models: Vec<TranscriptionModel> = value
        .get("data")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .take(MAX_CATALOG_ROWS)
        .filter_map(|row| {
            let id = row.get("id").and_then(Value::as_str)?;
            // The query filter is advisory; the metadata is what qualifies a
            // model for the transcription endpoint.
            if !valid_model_id(id)
                || !has_modality(row, "input_modalities", "audio")
                || !has_modality(row, "output_modalities", "transcription")
                || !seen.insert(id.to_string())
            {
                return None;
            }
            Some(TranscriptionModel {
                id: id.to_string(),
                name: bounded_text(row.get("name"), 120).unwrap_or_else(|| id.to_string()),
                description: bounded_text(row.get("description"), 200),
                recommended: false,
            })
        })
        .collect();
    models.sort_by(|left, right| left.name.to_lowercase().cmp(&right.name.to_lowercase()));
    models
}

async fn read_limited(mut response: reqwest::Response, limit: usize) -> Result<Vec<u8>, String> {
    if response
        .content_length()
        .is_some_and(|length| length > limit as u64)
    {
        return Err("The provider's response was unexpectedly large.".into());
    }
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "The provider's response was interrupted.".to_string())?
    {
        if body.len() + chunk.len() > limit {
            return Err("The provider's response was unexpectedly large.".into());
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

/// Fixed, status-based messages only. Provider error bodies can echo key
/// fragments or request details, so they are never read into an error.
fn status_error(provider: TranscriptionProvider, status: reqwest::StatusCode) -> String {
    let label = provider.label();
    match status.as_u16() {
        401 => format!("{label} rejected the transcription API key. Replace it in Settings › Voice input."),
        402 => format!("{label} reports that the account has no credits left for transcription."),
        403 => format!("{label} denied this key access to the transcription model (HTTP 403). Check the key's permissions, or choose another model in Settings › Voice input."),
        404 => format!("{label} could not find this transcription model (HTTP 404). Choose another in Settings › Voice input."),
        408 | 504 | 524 => format!("{label} timed out while transcribing. Try a shorter recording."),
        413 => format!("The recording is too large for {label}. Try a shorter recording."),
        429 => format!("{label} rate-limited the request, or the account's quota is used up (HTTP 429)."),
        400 | 415 | 422 => format!("{label} could not process this recording with the selected model (HTTP {}). Try again, or choose another model in Settings › Voice input.", status.as_u16()),
        code if (500..600).contains(&code) => {
            format!("{label} had a temporary problem (HTTP {code}). Try again in a moment.")
        }
        code => format!("{label} returned HTTP {code}."),
    }
}

fn catalog_network_error(provider: TranscriptionProvider, error: &reqwest::Error) -> String {
    let label = provider.label();
    if error.is_timeout() {
        format!("{label} did not answer in time.")
    } else if error.is_connect() {
        format!("Could not connect to {label}. Check your internet connection.")
    } else {
        format!("Could not reach {label}.")
    }
}

async fn fetch_catalog_json(
    provider: TranscriptionProvider,
    url: &str,
    key: Option<&str>,
) -> Result<Value, String> {
    let mut request = client()?.get(url).timeout(CATALOG_TIMEOUT);
    if let Some(key) = key {
        request = request.bearer_auth(key);
    }
    if provider == TranscriptionProvider::Openrouter {
        request = request.header("X-Title", "Mythra Code");
    }
    let response = request
        .send()
        .await
        .map_err(|error| catalog_network_error(provider, &error))?;
    let status = response.status();
    if !status.is_success() {
        return Err(status_error(provider, status));
    }
    let body = read_limited(response, CATALOG_RESPONSE_LIMIT).await?;
    serde_json::from_slice(&body)
        .map_err(|_| format!("{} returned an unreadable model list.", provider.label()))
}

async fn fetch_models(provider: TranscriptionProvider) -> Result<Vec<TranscriptionModel>, String> {
    match provider {
        TranscriptionProvider::Openai => {
            let key = match read_key(provider).await {
                KeyRead::Saved(key) => key,
                KeyRead::Missing => {
                    return Err("Add an OpenAI transcription key to see which models it can use.".into())
                }
                KeyRead::Unavailable => {
                    return Err("The OS credential store could not be read.".into())
                }
            };
            let value = fetch_catalog_json(provider, OPENAI_MODELS_URL, Some(&key)).await?;
            Ok(parse_openai_models(&value))
        }
        // OpenRouter's catalog is public; no key is sent for it.
        TranscriptionProvider::Openrouter => {
            let value =
                fetch_catalog_json(provider, OPENROUTER_TRANSCRIPTION_MODELS_URL, None).await?;
            Ok(parse_openrouter_models(&value))
        }
    }
}

#[tauri::command]
pub(crate) async fn transcription_models(
    state: State<'_, TranscriptionState>,
    provider: TranscriptionProvider,
    force: Option<bool>,
) -> Result<TranscriptionCatalog, String> {
    let mut cache = state.catalogs[provider.index()].lock().await;
    // Only OpenAI's list depends on the key.
    let generation = match provider {
        TranscriptionProvider::Openai => key_generation(provider),
        TranscriptionProvider::Openrouter => 0,
    };
    if let Some(cached) = cache.as_ref() {
        let age = cached.fetched.elapsed();
        if cached.generation == generation
            && age < CATALOG_TTL
            && (force != Some(true) || age < CATALOG_REFRESH_THROTTLE)
        {
            return Ok(TranscriptionCatalog {
                models: cached.models.clone(),
                source: "live",
                notice: None,
            });
        }
    }
    if cache.as_ref().is_some_and(|cached| cached.generation != generation) {
        *cache = None;
    }
    match fetch_models(provider).await {
        Ok(models) => {
            let notice = models.is_empty().then(|| match provider {
                TranscriptionProvider::Openai => {
                    "This OpenAI key doesn't list any supported transcription models.".to_string()
                }
                TranscriptionProvider::Openrouter => {
                    "OpenRouter currently lists no transcription models.".to_string()
                }
            });
            // A key saved during the fetch bumps the generation, so this
            // entry is then treated as stale rather than served for the new key.
            *cache = Some(CachedCatalog {
                fetched: Instant::now(),
                generation,
                models: models.clone(),
            });
            Ok(TranscriptionCatalog {
                models,
                source: "live",
                notice,
            })
        }
        Err(error) => match provider {
            TranscriptionProvider::Openai => Ok(TranscriptionCatalog {
                models: builtin_openai_models(),
                source: "builtin",
                notice: Some(error),
            }),
            TranscriptionProvider::Openrouter => match cache.as_ref() {
                Some(cached) => Ok(TranscriptionCatalog {
                    models: cached.models.clone(),
                    source: "live",
                    notice: Some(format!("{error} Showing the last list.")),
                }),
                None => Err(error),
            },
        },
    }
}

/// The OpenRouter model must be one the transcription catalog lists, so a
/// chat or text-to-speech model is never billed for an upload it can't use.
async fn ensure_openrouter_model(state: &TranscriptionState, model: &str) -> Result<(), String> {
    let index = TranscriptionProvider::Openrouter.index();
    let mut cache = state.catalogs[index].lock().await;
    let stale = cache
        .as_ref()
        .is_none_or(|cached| cached.fetched.elapsed() >= CATALOG_TTL);
    if stale {
        match fetch_models(TranscriptionProvider::Openrouter).await {
            Ok(models) => {
                *cache = Some(CachedCatalog {
                    fetched: Instant::now(),
                    generation: 0,
                    models,
                })
            }
            Err(error) if cache.is_none() => {
                return Err(format!("Could not confirm the OpenRouter model: {error}"))
            }
            Err(_) => {}
        }
    }
    if cache
        .as_ref()
        .is_some_and(|cached| cached.models.iter().any(|entry| entry.id == model))
    {
        Ok(())
    } else {
        Err("This model isn't an OpenRouter transcription model. Choose another in Settings › Voice input.".into())
    }
}

/// Accepts only the 16-bit PCM WAV the recorder produces.
fn validate_wav(audio: &[u8]) -> Result<(), String> {
    if audio.len() > MAX_AUDIO_BYTES {
        return Err("The recording is too large to transcribe.".into());
    }
    let le16 = |offset: usize| u16::from_le_bytes([audio[offset], audio[offset + 1]]);
    let le32 = |offset: usize| {
        u32::from_le_bytes([audio[offset], audio[offset + 1], audio[offset + 2], audio[offset + 3]])
    };
    let valid = audio.len() > 44
        && &audio[0..4] == b"RIFF"
        && le32(4) as usize == audio.len() - 8
        && &audio[8..12] == b"WAVE"
        && &audio[12..16] == b"fmt "
        && le32(16) == 16
        && le16(20) == 1
        && le16(22) == 1
        && (8_000..=48_000).contains(&le32(24))
        && le32(28) == le32(24) * 2
        && le16(32) == 2
        && le16(34) == 16
        && &audio[36..40] == b"data"
        && le32(40) as usize == audio.len() - 44
        && (audio.len() - 44) % 2 == 0;
    if valid {
        Ok(())
    } else {
        Err("The recording is not in the expected audio format.".into())
    }
}

fn multipart_body(boundary: &str, model: &str, audio: &[u8]) -> Vec<u8> {
    let mut body = Vec::with_capacity(audio.len() + 512);
    for (name, value) in [("model", model), ("response_format", "json")] {
        body.extend_from_slice(
            format!("--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n")
                .as_bytes(),
        );
    }
    body.extend_from_slice(
        format!(
            "--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"recording.wav\"\r\nContent-Type: audio/wav\r\n\r\n"
        )
        .as_bytes(),
    );
    body.extend_from_slice(audio);
    body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
    body
}

async fn upload(
    provider: TranscriptionProvider,
    key: &str,
    model: &str,
    audio: Vec<u8>,
) -> Result<String, String> {
    let label = provider.label();
    let boundary = format!("mythra-{}", uuid::Uuid::new_v4().simple());
    let body = multipart_body(&boundary, model, &audio);
    drop(audio);
    let mut request = client()?
        .post(provider.transcription_url())
        .timeout(UPLOAD_TIMEOUT)
        .bearer_auth(key)
        .header(
            reqwest::header::CONTENT_TYPE,
            format!("multipart/form-data; boundary={boundary}"),
        )
        .body(body);
    if provider == TranscriptionProvider::Openrouter {
        request = request.header("X-Title", "Mythra Code");
    }
    let response = request.send().await.map_err(|error| {
        if error.is_connect() {
            format!("Could not connect to {label}. Check your internet connection.")
        } else if error.is_timeout() {
            format!("{label} did not finish in time. It may still bill the request; Mythra Code did not retry it.")
        } else {
            format!("The upload to {label} failed. It may still bill the request; Mythra Code did not retry it.")
        }
    })?;
    let status = response.status();
    if !status.is_success() {
        return Err(status_error(provider, status));
    }
    let body = read_limited(response, TRANSCRIPT_RESPONSE_LIMIT).await?;
    let value: Value = serde_json::from_slice(&body)
        .map_err(|_| format!("{label} returned an unreadable transcript."))?;
    let text = value
        .get("text")
        .and_then(Value::as_str)
        .ok_or_else(|| format!("{label} returned no transcript."))?
        .trim();
    if text.is_empty() {
        return Err("No speech was recognized in the recording.".into());
    }
    if text.chars().count() > MAX_TRANSCRIPT_CHARS {
        return Err(format!("{label} returned an unusually long transcript. Nothing was added to your draft. Try a shorter recording."));
    }
    Ok(text.to_string())
}

/// Body: the WAV bytes. Headers: request id, provider and model. The upload
/// is cancelled by `transcription_cancel`, which drops the HTTP request.
#[tauri::command]
pub(crate) async fn transcription_transcribe(
    state: State<'_, TranscriptionState>,
    request: Request<'_>,
) -> Result<String, String> {
    let header = |name: &str| {
        request
            .headers()
            .get(name)
            .and_then(|value| value.to_str().ok())
            .map(str::to_string)
    };
    let id = header(ID_HEADER)
        .filter(|id| {
            (8..=64).contains(&id.len())
                && id.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        })
        .ok_or_else(|| "The transcription request was incomplete.".to_string())?;
    let provider = header(PROVIDER_HEADER)
        .as_deref()
        .and_then(TranscriptionProvider::parse)
        .ok_or_else(|| "Choose OpenAI or OpenRouter for transcription.".to_string())?;
    let model = header(MODEL_HEADER)
        .filter(|model| valid_model_id(model))
        .ok_or_else(|| "Choose a transcription model in Settings › Voice input.".to_string())?;
    if provider == TranscriptionProvider::Openai && (!openai_model_supported(&model) || model == "gpt-live-transcribe") {
        return Err("This model can't transcribe uploaded audio. Choose another in Settings › Voice input.".into());
    }
    let audio = match request.body() {
        InvokeBody::Raw(bytes) => {
            validate_wav(bytes)?;
            bytes.clone()
        }
        // Tauri's channel fallback serializes a binary body as a JSON byte
        // array when custom-protocol IPC fails. Accept exactly that shape,
        // bounded before allocating, and validate the decoded WAV identically.
        InvokeBody::Json(value) => {
            let values = value.as_array()
                .ok_or_else(|| "The recording did not reach Mythra Code.".to_string())?;
            if values.len() > MAX_AUDIO_BYTES {
                return Err("The recording is too large to transcribe.".into());
            }
            let mut bytes = Vec::with_capacity(values.len());
            for value in values {
                let byte = value.as_u64().filter(|byte| *byte <= u8::MAX as u64)
                    .ok_or_else(|| "The recording did not reach Mythra Code.".to_string())?;
                bytes.push(byte as u8);
            }
            validate_wav(&bytes)?;
            bytes
        }
    };
    let identity = UploadIdentity {
        provider,
        model: model.clone(),
        audio_digest: Sha256::digest(&audio).into(),
    };
    let (guard, canceled) = match state.begin_upload(&id, identity)? {
        UploadAdmission::Start(guard, canceled) => (guard, canceled),
        UploadAdmission::Complete(result) => return result.as_ref().clone(),
        UploadAdmission::Join(mut receiver) => {
            // A transport replay waits for the same operation. It never owns
            // another HTTP request or starts work if the first caller exits.
            drop(audio);
            loop {
                if let Some(result) = receiver.borrow().clone() {
                    return result.as_ref().clone();
                }
                if receiver.changed().await.is_err() {
                    return Err("The transcription result became unavailable. It was not uploaded again.".into());
                }
            }
        }
    };
    let work = async {
        if provider == TranscriptionProvider::Openrouter {
            ensure_openrouter_model(&state, &model).await?;
        }
        let key = match read_key(provider).await {
            KeyRead::Saved(key) => key,
            KeyRead::Missing => {
                return Err(format!(
                    "No {} transcription key is saved. Add one in Settings › Voice input.",
                    provider.label()
                ))
            }
            KeyRead::Unavailable => {
                return Err(
                    "The OS credential store could not be read. Check for a system prompt, then try again."
                        .into(),
                )
            }
        };
        upload(provider, &key, &model, audio).await
    };
    let result = tokio::select! {
        // A queued cancel wins before work can dispatch an upload or return
        // a transcript that the caller has already discarded.
        biased;
        _ = canceled => Err(CANCELED.into()),
        result = work => result,
    };
    guard.finish(result)
}

#[tauri::command]
pub(crate) fn transcription_cancel(state: State<'_, TranscriptionState>, id: String) {
    if id.len() <= 64 {
        state.live.cancel(&id);
        state.cancel_upload(&id);
    }
}
