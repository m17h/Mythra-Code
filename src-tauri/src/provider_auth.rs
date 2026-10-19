//! Direct API-key billing for the OpenAI (Codex) and Anthropic (Claude Code)
//! chat runtimes.
//!
//! These keys are OS credential entries of their own, separate from voice
//! input keys and from each CLI's own sign-in. A pasted key arrives once, to
//! be saved; no command returns a stored key, and keys are never logged, put
//! in argv or kept in app settings. Key and billing changes apply immediately
//! rather than with Save settings, and are refused while that provider has
//! active work instead of interrupting it.
//!
//! OpenAI: Codex keeps one sign-in per CODEX_HOME. Using the key signs Mythra
//! Code's private Codex profile in through the documented
//! `account/login/start { type: "apiKey" }`. That replaces a ChatGPT sign-in in
//! that profile; returning to ChatGPT needs the browser sign-in again. The
//! renderer can never send an API-key login itself.
//!
//! Anthropic: Claude Code keeps its own subscription login untouched. While
//! API-key billing is selected, only processes Mythra Code starts receive the
//! key, as `ANTHROPIC_API_KEY`, which Claude Code's documented precedence
//! uses instead of the subscription login. The choice is stored in app data,
//! never inferred from the environment, and never falls back to the other
//! billing when its credential is missing.

use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex as StdMutex, MutexGuard, PoisonError};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};
use tokio::sync::{watch, Mutex, OwnedRwLockReadGuard, OwnedRwLockWriteGuard, RwLock};
use tokio::time::timeout;

use crate::transcription::KeyState;
use crate::{ClaudeState, RuntimeState, KEYRING_READ_TIMEOUT, KEYRING_SERVICE};

const OPENAI_KEY_ACCOUNT: &str = "openai-api-key";
const ANTHROPIC_KEY_ACCOUNT: &str = "anthropic-api-key";
const BILLING_FILE: &str = "provider-billing.json";
/// A credential store write that does not finish in time is reported; its
/// worker keeps the provider's write guard until the OS call returns.
const KEYRING_WRITE_TIMEOUT: Duration = Duration::from_secs(10);
const EMPTY_KEY_SLOT: KeySlot = KeySlot {
    known: None,
    reading: None,
    read_serial: 0,
};
static KEY_SLOTS: [StdMutex<KeySlot>; 2] = [StdMutex::new(EMPTY_KEY_SLOT), StdMutex::new(EMPTY_KEY_SLOT)];

const BILLING_UNREADABLE: &str = "Mythra Code could not read the billing choices on this device. Choose Subscription or API key again in Settings › Models & accounts.";
const CLAUDE_BUSY: &str = "Finish or stop active Claude work before changing how Claude is billed.";

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub(crate) enum ApiKeyProvider {
    Openai,
    Anthropic,
}

impl ApiKeyProvider {
    fn index(self) -> usize {
        match self {
            Self::Openai => 0,
            Self::Anthropic => 1,
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::Openai => "OpenAI",
            Self::Anthropic => "Anthropic",
        }
    }

    fn account(self) -> &'static str {
        match self {
            Self::Openai => OPENAI_KEY_ACCOUNT,
            Self::Anthropic => ANTHROPIC_KEY_ACCOUNT,
        }
    }
}

/// The selected subscription or API-key billing method for either runtime.
#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum ClaudeBilling {
    #[default]
    Subscription,
    ApiKey,
}

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct BillingFile {
    #[serde(default = "default_billing")]
    openai: Option<ClaudeBilling>,
    #[serde(default = "default_billing")]
    claude: Option<ClaudeBilling>,
}

fn default_billing() -> Option<ClaudeBilling> { Some(ClaudeBilling::Subscription) }

impl Default for BillingFile {
    fn default() -> Self { Self { openai: default_billing(), claude: default_billing() } }
}

/// Never derives Debug: a saved key must not reach a log by accident.
#[derive(Clone)]
pub(crate) enum KeyRead {
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

/// A blocked OS read is joined by later callers instead of starting another
/// worker; a successful write is authoritative from then on.
struct KeySlot {
    known: Option<Option<String>>,
    reading: Option<(u64, watch::Receiver<Option<KeyRead>>)>,
    read_serial: u64,
}

fn key_slot(provider: ApiKeyProvider) -> MutexGuard<'static, KeySlot> {
    KEY_SLOTS[provider.index()]
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
}

#[derive(Default)]
pub(crate) struct ProviderAuthState {
    /// One credential write per provider. The guard moves into the blocking
    /// worker, so a stuck OS call blocks only later writes for that provider.
    writes: [Arc<Mutex<()>>; 2],
    /// Orders key, billing and sign-in changes for one provider.
    admission: [Arc<RwLock<()>>; 2],
    billing_write: Mutex<()>,
    billing: StdMutex<Option<BillingFile>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProviderAuthStatus {
    openai: KeyState,
    anthropic: KeyState,
    openai_billing: Option<ClaudeBilling>,
    /// Null when the saved choice could not be read; it is never guessed.
    claude_billing: Option<ClaudeBilling>,
}

/// Only a confirmed absent entry is `Missing`; locked, denied, failed or
/// slow credential store reads are `Unavailable`.
pub(crate) async fn read_key(provider: ApiKeyProvider) -> KeyRead {
    if crate::release_qa::active() {
        return KeyRead::Unavailable;
    }
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
                        // A confirmed answer is reused; a failed read is retried.
                        match &result {
                            KeyRead::Saved(key) if slot.known.is_none() => slot.known = Some(Some(key.clone())),
                            KeyRead::Missing if slot.known.is_none() => slot.known = Some(None),
                            _ => {}
                        }
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

fn validate_api_key(provider: ApiKeyProvider, value: &str) -> Result<String, String> {
    let key = value.trim();
    // Both providers issue keys of letters, digits, dashes and underscores.
    if key.len() < 20
        || key.len() > 512
        || !key.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    {
        return Err("That doesn't look like an API key. Paste the whole key and try again.".into());
    }
    if provider == ApiKeyProvider::Anthropic && key.starts_with("sk-ant-oat") {
        return Err("That is a Claude subscription sign-in token, not an API key. Create an API key in the Claude Console instead.".into());
    }
    Ok(key.to_string())
}

async fn write_key(
    app: AppHandle,
    state: &ProviderAuthState,
    provider: ApiKeyProvider,
    value: Option<String>,
    change: OwnedRwLockWriteGuard<()>,
) -> Result<(), String> {
    let label = provider.label();
    let guard = state.writes[provider.index()]
        .clone()
        .try_lock_owned()
        .map_err(|_| format!("The {label} API key is still being updated. Try again in a moment."))?;
    let account = provider.account();
    let task = tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let _guard = guard;
        // Keep admission closed even if the IPC caller times out while the
        // OS prompt is still pending. No late mutation can race a new turn.
        let _change = change;
        let entry = keyring::Entry::new(KEYRING_SERVICE, account)
            .map_err(|_| "Could not open the OS credential store. Check for a system prompt, then try again.".to_string())?;
        let written = match value.as_deref() {
            Some(key) => entry
                .set_password(key)
                .map_err(|_| format!("Could not save the {label} API key. Check that the OS credential store is unlocked, then try again.")),
            None => match entry.delete_credential() {
                Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
                Err(_) => Err(format!(
                    "Could not remove the {label} API key. Check that the OS credential store is unlocked, then try again."
                )),
            },
        };
        if written.is_ok() {
            // Published while the write guard is still held, so writes are
            // published in order, including one whose caller stopped waiting.
            key_slot(provider).known = Some(value);
            if provider == ApiKeyProvider::Anthropic {
                crate::invalidate_claude_auth(&app);
            }
        }
        written
    });
    match timeout(KEYRING_WRITE_TIMEOUT, task).await {
        Err(_) => Err(
            "The OS credential store did not respond. Check for a system prompt, then reopen Models & accounts to see whether the key changed."
                .into(),
        ),
        Ok(Err(_)) => Err("The credential task failed. Try again.".into()),
        Ok(Ok(result)) => result,
    }
}

fn billing_path(app: &AppHandle) -> Result<PathBuf, String> {
    crate::release_qa::app_data_dir(app)
        .map(|directory| directory.join(BILLING_FILE))
        .map_err(|_| BILLING_UNREADABLE.to_string())
}

/// The selected Claude billing. A missing file is the original subscription
/// behavior; an unreadable or unrecognized one is an error, not a default.
fn read_billing(app: &AppHandle) -> Result<BillingFile, String> {
    let Some(state) = app.try_state::<ProviderAuthState>() else {
        return Err(BILLING_UNREADABLE.into());
    };
    let mut cached = state.billing.lock().unwrap_or_else(PoisonError::into_inner);
    if let Some(billing) = *cached {
        return Ok(billing);
    }
    let billing = match std::fs::read(billing_path(app)?) {
        Ok(bytes) => serde_json::from_slice::<BillingFile>(&bytes)
            .map_err(|_| BILLING_UNREADABLE.to_string())?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => BillingFile::default(),
        Err(_) => return Err(BILLING_UNREADABLE.into()),
    };
    *cached = Some(billing);
    Ok(billing)
}

pub(crate) fn claude_billing(app: &AppHandle) -> Result<ClaudeBilling, String> {
    read_billing(app)?.claude.ok_or_else(|| BILLING_UNREADABLE.into())
}

pub(crate) fn openai_billing(app: &AppHandle) -> Result<ClaudeBilling, String> {
    read_billing(app)?.openai.ok_or_else(|| BILLING_UNREADABLE.into())
}

async fn write_billing(app: &AppHandle, state: &ProviderAuthState, provider: ApiKeyProvider, billing: ClaudeBilling) -> Result<(), String> {
    let _write = state.billing_write.lock().await;
    // An unreadable file must be repaired explicitly rather than inferred
    // from a CLI sign-in. Repairing one leaves the other unknown/blocked.
    let mut choices = read_billing(app).unwrap_or(BillingFile { openai: None, claude: None });
    match provider {
        ApiKeyProvider::Openai => choices.openai = Some(billing),
        ApiKeyProvider::Anthropic => choices.claude = Some(billing),
    }
    let path = billing_path(app)?;
    let bytes = serde_json::to_vec_pretty(&choices)
        .map_err(|_| "Could not save the billing choice.".to_string())?;
    let temporary = path.with_extension("json.tmp");
    let failed = |_| "Could not save the billing choice. Check that Mythra Code's app data folder is writable.".to_string();
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent).await.map_err(failed)?;
    }
    tokio::fs::write(&temporary, bytes).await.map_err(failed)?;
    tokio::fs::rename(&temporary, &path).await.map_err(failed)?;
    *state.billing.lock().unwrap_or_else(PoisonError::into_inner) = Some(choices);
    Ok(())
}

/// Held through startup registration or for the whole helper process. A
/// billing/key change cannot enter between an idle check and process spawn.
pub(crate) fn begin_use(app: &AppHandle, provider: ApiKeyProvider) -> Result<OwnedRwLockReadGuard<()>, String> {
    app.state::<ProviderAuthState>().admission[provider.index()].clone()
        .try_read_owned().map_err(|_| format!("{} billing or credentials are changing. Try again in a moment.", provider.label()))
}

pub(crate) fn begin_change(app: &AppHandle, provider: ApiKeyProvider) -> Result<OwnedRwLockWriteGuard<()>, String> {
    app.state::<ProviderAuthState>().admission[provider.index()].clone()
        .try_write_owned().map_err(|_| format!("Finish active {} work and account requests before changing billing or credentials.", provider.label()))
}

pub(crate) fn assert_openai_account(app: &AppHandle, account: &serde_json::Value) -> Result<(), String> {
    let expected = match openai_billing(app)? {
        ClaudeBilling::Subscription => "chatgpt",
        ClaudeBilling::ApiKey => "apiKey",
    };
    if account.pointer("/account/type").and_then(serde_json::Value::as_str) != Some(expected) {
        return Err(match expected {
            "apiKey" => "OpenAI is set to API key billing. Connect your saved key in Models & accounts; Mythra Code will not use your subscription instead.",
            _ => "OpenAI is set to subscription billing. Sign in with ChatGPT in Models & accounts; Mythra Code will not use an API key instead.",
        }.into());
    }
    Ok(())
}

/// Called while holding exclusive provider admission. Existing starts/turns
/// must settle; a new start cannot enter until the change is published.
pub(crate) async fn claude_idle(state: &ClaudeState) -> Result<(), String> {
    if state.starts.any_pending() {
        return Err(CLAUDE_BUSY.into());
    }
    let busy = state.turns.lock().await.values().any(|turn| {
        turn.alive.load(Ordering::Acquire) || turn.cutoff_uncertain.load(Ordering::Acquire)
    });
    if busy {
        return Err(CLAUDE_BUSY.into());
    }
    Ok(())
}

/// The Anthropic key a Claude Code process about to start must receive, or
/// None under subscription billing. Never falls back between the two.
pub(crate) async fn claude_process_api_key(app: &AppHandle) -> Result<Option<String>, String> {
    match claude_billing(app)? {
        ClaudeBilling::Subscription => {
            // Every subscription launch, including text helpers and catalog
            // requests, must verify the CLI selected subscription credentials.
            // Merely omitting our key still permits a saved Console login.
            let binary = crate::resolve_claude_binary(app).await?;
            let home = crate::release_qa::home_dir(app).ok();
            let auth = crate::probe_claude_auth(&binary, home.as_deref()).await?;
            if auth.get("loggedIn").and_then(serde_json::Value::as_bool) != Some(true) {
                return Err("Sign in with your Claude subscription in Settings › Models & accounts before starting Claude work.".into());
            }
            Ok(None)
        }
        ClaudeBilling::ApiKey => match read_key(ApiKeyProvider::Anthropic).await {
            KeyRead::Saved(key) => Ok(Some(key)),
            KeyRead::Missing => Err("Claude is set to bill an Anthropic API key, but none is saved. Add one in Settings › Models & accounts, or switch Claude back to your subscription.".into()),
            KeyRead::Unavailable => Err("The OS credential store didn't return the Anthropic API key. Check for a system prompt, then try again.".into()),
        },
    }
}

pub(crate) async fn anthropic_key_state() -> KeyState {
    read_key(ApiKeyProvider::Anthropic).await.state()
}

#[tauri::command]
pub(crate) async fn provider_auth_status(app: AppHandle) -> ProviderAuthStatus {
    let (openai, anthropic) = tokio::join!(
        read_key(ApiKeyProvider::Openai),
        read_key(ApiKeyProvider::Anthropic)
    );
    ProviderAuthStatus {
        openai: openai.state(),
        anthropic: anthropic.state(),
        openai_billing: openai_billing(&app).ok(),
        claude_billing: claude_billing(&app).ok(),
    }
}

/// Saves a key. The OpenAI key only reaches Codex through
/// `openai_api_key_use`; the Anthropic key bills the next Claude turn when
/// API-key billing is selected.
#[tauri::command]
pub(crate) async fn provider_api_key_save(
    app: AppHandle,
    state: State<'_, ProviderAuthState>,
    runtime: State<'_, RuntimeState>,
    claude: State<'_, ClaudeState>,
    provider: ApiKeyProvider,
    api_key: String,
) -> Result<(), String> {
    crate::release_qa::require_providers()?;
    let key = validate_api_key(provider, &api_key)?;
    let change = begin_change(&app, provider)?;
    match provider {
        ApiKeyProvider::Anthropic => claude_idle(&claude).await?,
        ApiKeyProvider::Openai => {
            runtime.lifecycle.auth_change_idle()?;
            // Replacing the stored API key must not leave Codex billing the
            // old key if saving or reconnecting the replacement fails.
            if openai_billing(&app)? == ClaudeBilling::ApiKey {
                crate::codex_sign_out_api_key(&app, &runtime).await?;
            }
        }
    }
    write_key(app, &state, provider, Some(key), change).await?;
    Ok(())
}

/// Removes a key. Removing the OpenAI key also signs Codex out when Codex is
/// using an API key, so the removed key cannot keep billing. The returned
/// notice, if any, describes a sign-out that could not be confirmed.
#[tauri::command]
pub(crate) async fn provider_api_key_remove(
    app: AppHandle,
    state: State<'_, ProviderAuthState>,
    runtime: State<'_, RuntimeState>,
    claude: State<'_, ClaudeState>,
    provider: ApiKeyProvider,
) -> Result<Option<String>, String> {
    crate::release_qa::require_providers()?;
    let change = begin_change(&app, provider)?;
    match provider {
        ApiKeyProvider::Openai => {
            let notice = crate::codex_sign_out_api_key(&app, &runtime).await?;
            write_key(app, &state, provider, None, change).await?;
            Ok(notice)
        }
        ApiKeyProvider::Anthropic => {
            claude_idle(&claude).await?;
            write_key(app, &state, provider, None, change).await?;
            Ok(None)
        }
    }
}

/// Signs Mythra Code's Codex profile in with the saved OpenAI key, replacing
/// any ChatGPT sign-in there, after retiring the old runtime so no start
/// prepared under the previous billing can dispatch on that process.
#[tauri::command]
pub(crate) async fn openai_api_key_use(
    app: AppHandle,
    runtime: State<'_, RuntimeState>,
) -> Result<(), String> {
    crate::release_qa::require_providers()?;
    let _change = begin_change(&app, ApiKeyProvider::Openai)?;
    if openai_billing(&app)? != ClaudeBilling::ApiKey {
        return Err("Choose API key billing for OpenAI first. Saving or connecting a key never switches billing automatically.".into());
    }
    let key = match read_key(ApiKeyProvider::Openai).await {
        KeyRead::Saved(key) => key,
        KeyRead::Missing => return Err("Save an OpenAI API key first.".into()),
        KeyRead::Unavailable => {
            return Err("The OS credential store didn't return the OpenAI API key. Check for a system prompt, then try again.".into())
        }
    };
    crate::codex_login_with_api_key(&app, &runtime, key).await
}

#[tauri::command]
pub(crate) async fn claude_billing_set(
    app: AppHandle,
    state: State<'_, ProviderAuthState>,
    claude: State<'_, ClaudeState>,
    billing: ClaudeBilling,
) -> Result<(), String> {
    crate::release_qa::require_providers()?;
    let _change = begin_change(&app, ApiKeyProvider::Anthropic)?;
    if claude_billing(&app).ok() == Some(billing) {
        return Ok(());
    }
    claude_idle(&claude).await?;
    // Publish the choice before advancing the generation, so any start that
    // reads the old choice also holds the generation this change retires.
    write_billing(&app, &state, ApiKeyProvider::Anthropic, billing).await?;
    crate::invalidate_claude_auth(&app);
    Ok(())
}

/// The selection is independent of whichever Codex credential exists. A
/// missing or mismatched credential is refused at every billable dispatch.
#[tauri::command]
pub(crate) async fn openai_billing_set(
    app: AppHandle,
    state: State<'_, ProviderAuthState>,
    runtime: State<'_, RuntimeState>,
    billing: ClaudeBilling,
) -> Result<(), String> {
    crate::release_qa::require_providers()?;
    let _change = begin_change(&app, ApiKeyProvider::Openai)?;
    if openai_billing(&app).ok() == Some(billing) { return Ok(()); }
    let _restart = runtime.lifecycle.begin_auth_switch()?;
    crate::retire_codex_for_auth_change(&app, &runtime).await?;
    write_billing(&app, &state, ApiKeyProvider::Openai, billing).await?;
    // Retire all starts prepared under the old billing and pending browser
    // login callbacks owned by that process. No automatic sign-in/fallback.
    crate::ensure_server(&app, &runtime).await.map(|_| ())
}
