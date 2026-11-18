import { rovingChoiceKeyDown, SettingInfo } from "./SettingsBits";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { AudioLines, Check, ExternalLink, Info, KeyRound, LoaderCircle, RotateCcw, Trash2, Voicemail } from "lucide-react";
import { AppSelectMenu, type AppSelectOption } from "./AppSelectMenu";
import { OpenAILogo, OpenRouterLogo } from "./BrandLogos";
import { safeErrorText } from "../lib/errors";
import {
  copyOpenRouterAccountKey,
  listTranscriptionModels,
  refreshTranscriptionKeys,
  removeTranscriptionKey,
  sanitizeTranscriptionSettings,
  saveTranscriptionKey,
  transcriptionModeFor,
  transcriptionModelFor,
  TRANSCRIPTION_LINKS,
  TRANSCRIPTION_PROVIDER_LABELS,
  TRANSCRIPTION_PROVIDERS,
  useTranscriptionKeys,
  type TranscriptionCatalog,
  type TranscriptionKeyState,
  type TranscriptionMode,
} from "../lib/transcription";
import { MAX_RECORDING_SECONDS } from "../lib/voiceRecorder";
import type { TranscriptionProvider, TranscriptionSettings as TranscriptionSettingsValue } from "../types";
import "./TranscriptionSettings.css";

type CatalogState = { status: "idle" | "loading" | "ready" | "error"; catalog: TranscriptionCatalog | null; error: string };

const IDLE_CATALOG: CatalogState = { status: "idle", catalog: null, error: "" };

function openExternal(url: string): void {
  void openUrl(url).catch(() => undefined);
}

function ExternalButton({ url, children }: { url: string; children: string }) {
  return <button type="button" className="transcription-link" onClick={() => openExternal(url)}>{children} <ExternalLink size={11} aria-hidden="true" /></button>;
}

const MODE_LABELS: Record<TranscriptionMode, string> = { live: "Live dictation", recorded: "After recording" };

function ModeIcon({ mode }: { mode: TranscriptionMode }) {
  return (
    <span className={`transcription-mode-icon ${mode}`} aria-hidden="true">
      {mode === "live" ? <AudioLines size={13} /> : <Voicemail size={13} />}
    </span>
  );
}

function keyStatusLabel(state: TranscriptionKeyState, checking: boolean): string {
  if (state === "saved") return "Key saved";
  if (state === "missing") return "No key";
  if (state === "unavailable") return "Can't check";
  return checking ? "Checking…" : "Not checked";
}

/**
 * Voice input settings. Provider and model are ordinary drafts saved with
 * Save settings. Keys are saved or removed immediately in the OS credential
 * store and never pass through the settings draft.
 */
export function TranscriptionSettings({ visible, value, onChange, accountOpenRouterKeySaved, onOpenAccounts }: {
  /** The pane is on screen; key status and catalogs load only then. */
  visible: boolean;
  value: TranscriptionSettingsValue | undefined;
  onChange: (next: TranscriptionSettingsValue) => void;
  accountOpenRouterKeySaved: boolean;
  onOpenAccounts: () => void;
}) {
  const settings = useMemo(() => sanitizeTranscriptionSettings(value), [value]);
  const provider = settings.provider;
  const keys = useTranscriptionKeys((state) => state.keys);
  const checking = useTranscriptionKeys((state) => state.checking);

  useEffect(() => {
    if (visible) void refreshTranscriptionKeys();
  }, [visible]);

  const [catalogs, setCatalogs] = useState<Record<TranscriptionProvider, CatalogState>>({ openai: IDLE_CATALOG, openrouter: IDLE_CATALOG });
  // Only the newest request per provider may update its list.
  const requestRef = useRef<Record<TranscriptionProvider, number>>({ openai: 0, openrouter: 0 });
  const loadCatalog = useCallback((target: TranscriptionProvider, force = false, clear = false) => {
    const request = ++requestRef.current[target];
    setCatalogs((current) => ({ ...current, [target]: { status: "loading", catalog: clear ? null : current[target].catalog, error: "" } }));
    listTranscriptionModels(target, force)
      .then((catalog) => {
        if (requestRef.current[target] !== request) return;
        setCatalogs((current) => ({ ...current, [target]: { status: "ready", catalog, error: "" } }));
      })
      .catch((reason) => {
        if (requestRef.current[target] !== request) return;
        setCatalogs((current) => ({ ...current, [target]: { status: "error", catalog: current[target].catalog, error: safeErrorText(reason, "The model list couldn't be loaded.") } }));
      });
  }, []);

  // Reopening the pane rechecks the native cache's freshness. OpenAI's list
  // also depends on its key, including replacements that keep "saved" status.
  // Clear the old key's choices while loading and ignore completions after
  // the pane is hidden, switched or a newer key revision takes over.
  const catalogRevision = useTranscriptionKeys((state) => provider === "openai" ? state.revisions.openai : 0);
  useEffect(() => {
    if (!visible) return;
    loadCatalog(provider, false, true);
    return () => { requestRef.current[provider] += 1; };
  }, [catalogRevision, loadCatalog, provider, visible]);

  const catalogState = catalogs[provider];
  const models = useMemo(() => catalogState.catalog?.models ?? [], [catalogState.catalog]);
  const selectedModel = transcriptionModelFor(settings, provider);
  // Live or after-recording comes from the app's own list of streaming
  // models, never from a catalog description that mentions streaming.
  const modelOptions = useMemo<AppSelectOption[]>(() => models.map((model) => {
    const mode = transcriptionModeFor(provider, model.id);
    return {
      value: model.id,
      label: model.name,
      icon: <ModeIcon mode={mode} />,
      detail: [MODE_LABELS[mode], model.id !== model.name ? model.id : "", model.recommended ? "Recommended" : model.description ?? ""].filter(Boolean).join(" · "),
      keywords: `${model.id} ${MODE_LABELS[mode]} ${model.description ?? ""}`,
    };
  }), [models, provider]);
  const selectedMode = transcriptionModeFor(provider, selectedModel);
  const selectedDisplay = selectedModel && !models.some((model) => model.id === selectedModel)
    ? {
      label: selectedModel,
      icon: <ModeIcon mode={selectedMode} />,
      // A default is never a warning: name it plainly until the list loads.
      detail: catalogState.status === "loading" || catalogState.status === "idle" ? "Checking the model list…" : settings.models?.[provider] ? "Your saved choice" : "Default",
    }
    : undefined;
  const providerLabel = TRANSCRIPTION_PROVIDER_LABELS[provider];
  const catalogNote = catalogState.status === "loading"
    ? "Loading models…"
    : catalogState.status === "error"
      ? catalogState.error
      : catalogState.catalog?.source === "builtin"
        ? `Showing OpenAI's documented transcription models. ${catalogState.catalog.notice ?? ""}`.trim()
        : catalogState.catalog?.notice
          ?? (provider === "openai" ? "Transcription models this OpenAI key can use." : "Every model OpenRouter lists for speech-to-text.");

  const chooseProvider = (next: TranscriptionProvider) => {
    if (next !== provider) onChange({ ...settings, provider: next });
  };

  return (
    <section className="settings-section transcription-settings">
      <div className="set-group">
        <h4>Transcription provider</h4>
        <p>In the message box, choose More (…) → Voice input and speak. Text lands in your draft and is never sent automatically. <SettingInfo label="How voice input works">With a live dictation model your words appear in the draft as you talk; with other models the recording is transcribed when you press Done. The text stays in your draft to edit.</SettingInfo></p>
        <div className="provider-cards transcription-provider-cards" role="radiogroup" aria-label="Transcription provider" onKeyDown={rovingChoiceKeyDown}>
          {TRANSCRIPTION_PROVIDERS.map((id) => (
            <button key={id} type="button" role="radio" aria-checked={provider === id} tabIndex={provider === id ? 0 : -1} className={`provider-card ${provider === id ? "selected" : ""}`} onClick={() => chooseProvider(id)}>
              <span className={`provider-logo ${id}`}>{id === "openai" ? <OpenAILogo size={17} /> : <OpenRouterLogo size={18} />}</span>
              <span><strong>{TRANSCRIPTION_PROVIDER_LABELS[id]}</strong><small>{id === "openai" ? "OpenAI API key" : "OpenRouter API key"}</small></span>
              <span className={`provider-status ${keys[id] === "saved" ? "on" : ""}`}>{keyStatusLabel(keys[id], checking)}</span>
              {provider === id && <Check size={16} />}
            </button>
          ))}
        </div>
      </div>

      <div className="set-group">
        <h4>Transcription API key</h4>
        <TranscriptionKeyPanel
          key={provider}
          visible={visible}
          provider={provider}
          accountKeySaved={accountOpenRouterKeySaved}
          onOpenAccounts={onOpenAccounts}
        />
      </div>

      <div className="set-group">
        <h4>Transcription model</h4>
        <div className="set-card"><div className="set-row stack">
          <div className="set-control transcription-model-row">
            <AppSelectMenu
              key={provider}
              value={selectedModel}
              options={modelOptions}
              selectedDisplay={selectedDisplay}
              ariaLabel={`${TRANSCRIPTION_PROVIDER_LABELS[provider]} transcription model`}
              placeholder="Choose a transcription model"
              searchable={modelOptions.length > 8}
              portal
              emptyMessage={catalogState.status === "loading" ? "Loading models…" : "No transcription models are available."}
              onChange={(model) => onChange({ ...settings, models: { ...settings.models, [provider]: model } })}
            />
            <button type="button" className="icon-button" onClick={() => loadCatalog(provider, true)} disabled={catalogState.status === "loading"} title="Refresh the model list" aria-label="Refresh the model list">
              {catalogState.status === "loading" ? <LoaderCircle className="spin" size={14} /> : <RotateCcw size={14} />}
            </button>
          </div>
          {selectedModel && (
            <div className={`transcription-mode-note ${selectedMode}`}>
              <span className="transcription-mode-pill"><ModeIcon mode={selectedMode} /> {MODE_LABELS[selectedMode]}</span>
              <small>
                {selectedMode === "live"
                  ? `Words appear in your draft while you speak.`
                  : `Text appears when you press Done.`}
                {" "}<SettingInfo label="When audio is sent">{selectedMode === "live"
                  ? `Audio streams to ${providerLabel} as you talk, so Cancel removes this dictation's text but can't recall audio already sent.`
                  : `The recording is uploaded to ${providerLabel} when you press Done. Cancel before that discards it.`}</SettingInfo>
              </small>
            </div>
          )}
          <small className={`set-control-help${catalogState.status === "error" ? " transcription-error-text" : ""}`} role={catalogState.status === "error" ? "alert" : undefined}>{catalogNote}</small>
          <div className="transcription-links">
            {provider === "openai" ? <>
              <ExternalButton url={TRANSCRIPTION_LINKS.openai.models}>Transcription models</ExternalButton>
              <ExternalButton url={TRANSCRIPTION_LINKS.openai.pricing}>Pricing</ExternalButton>
            </> : <ExternalButton url={TRANSCRIPTION_LINKS.openrouter.models}>Speech-to-text models and pricing</ExternalButton>}
          </div>
        </div></div>
      </div>

      <p className="settings-footnote" role="note">
        <Info size={13} aria-hidden="true" />
        <span>Billed to this API key; subscriptions don&rsquo;t cover it. <SettingInfo label="Billing and privacy">{TRANSCRIPTION_PROVIDER_LABELS[provider]} bills transcription to the API key you add here. ChatGPT, Claude and Cursor subscriptions don&rsquo;t cover it. Only the selected provider receives your audio, and both keys stay saved when you switch. Voice input stops after {MAX_RECORDING_SECONDS / 60} minutes. Mythra Code processes audio in memory and never saves it to disk; {TRANSCRIPTION_PROVIDER_LABELS[provider]} processes and retains it under its own policies.</SettingInfo></span>
      </p>
    </section>
  );
}

function TranscriptionKeyPanel({ visible, provider, accountKeySaved, onOpenAccounts }: {
  visible: boolean;
  provider: TranscriptionProvider;
  accountKeySaved: boolean;
  onOpenAccounts: () => void;
}) {
  // Typed text belongs to this provider's panel only; status refreshes never
  // write into it, and switching provider remounts the panel empty.
  const [input, setInput] = useState("");
  // Settings stays mounted while closed. Do not retain an unsaved secret in
  // its hidden input after the user leaves the dialog.
  useEffect(() => {
    if (!visible) setInput("");
  }, [visible]);
  const state = useTranscriptionKeys((store) => store.keys[provider]);
  const checking = useTranscriptionKeys((store) => store.checking);
  const busy = useTranscriptionKeys((store) => store.busy[provider]);
  const error = useTranscriptionKeys((store) => store.errors[provider]);
  const notice = useTranscriptionKeys((store) => store.notices[provider]);
  const label = TRANSCRIPTION_PROVIDER_LABELS[provider];

  const save = async () => {
    const submitted = input.trim();
    if (!submitted || busy) return;
    if (await saveTranscriptionKey(provider, submitted)) setInput((current) => current.trim() === submitted ? "" : current);
  };

  const statusCopy = state === "saved"
    ? "Stored securely on this device"
    : state === "missing"
      ? "Next step: paste an API key to turn on voice input"
      : state === "unavailable"
        ? "The OS credential store didn't respond. Try again in a moment."
        : checking ? "Checking…" : "Not checked yet";

  return (
    // M10 (round 6): with no key saved, the key field is the next step and
    // reads as one (accent edge); the model and billing below can wait.
    <div className={`credential-panel stacked${state === "missing" ? " needs-key" : ""}`} data-settings-row="transcription-key">
      <div className="credential-status">
        <div><strong>{label} transcription key</strong><small>{statusCopy}</small></div>
        
      </div>
      <div className="key-input-row">
        <input
          type="password"
          value={input}
          autoComplete="off"
          spellCheck={false}
          aria-label={`${label} transcription API key`}
          placeholder={state === "saved" ? "Paste a new key to replace the saved one" : provider === "openai" ? "sk-…" : "sk-or-v1-…"}
          disabled={Boolean(busy)}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void save();
            }
          }}
        />
        <button type="button" className="secondary-button" onClick={() => void save()} disabled={!input.trim() || Boolean(busy)}>
          {busy === "saving" && <LoaderCircle className="spin" size={13} />} Save key
        </button>
        {state === "saved" && (
          <button type="button" className="secondary-button" onClick={() => void removeTranscriptionKey(provider)} disabled={Boolean(busy)}>
            {busy === "removing" ? <LoaderCircle className="spin" size={13} /> : <Trash2 size={13} />} Remove
          </button>
        )}
      </div>
      {provider === "openrouter" && (
        <div className="transcription-key-copy">
          <button type="button" className="secondary-button" onClick={() => void copyOpenRouterAccountKey()} disabled={Boolean(busy)}>
            {busy === "copying" ? <LoaderCircle className="spin" size={13} /> : <KeyRound size={13} />} Use key from Models &amp; accounts
          </button>
          <small>
            {accountKeySaved
              ? "Saves a separate copy for voice input. The key isn't shown or put on the clipboard, and your chat key stays as it is."
              : "No OpenRouter key is saved in Models & accounts yet."}
            {" "}
            {!accountKeySaved && <button type="button" className="transcription-link" onClick={onOpenAccounts}>Open Models &amp; accounts</button>}
          </small>
        </div>
      )}
      {(error || notice) && (
        <small className={error ? "transcription-error-text" : "transcription-notice-text"} role={error ? "alert" : "status"}>
          {error || notice}
          {error && provider === "openrouter" && /Models & accounts/.test(error) && accountKeySaved && <> <button type="button" className="transcription-link" onClick={onOpenAccounts}>Open Models &amp; accounts</button></>}
        </small>
      )}
      <small className="transcription-key-help">
        Stored in your OS credential store, separately from your chat accounts.
        {" "}<ExternalButton url={TRANSCRIPTION_LINKS[provider].keys}>{`Create an ${label} API key`}</ExternalButton>
      </small>
    </div>
  );
}
