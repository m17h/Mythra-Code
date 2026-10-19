import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import { safeErrorText } from "./errors";
import type { TranscriptionProvider, TranscriptionSettings } from "../types";

/**
 * Voice input's provider, keys and model catalogs. A pasted key is passed to
 * native code once, to be saved in the OS credential store; no command ever
 * returns a stored key, and keys are never put in app settings or logged.
 * Nothing here runs at startup: key status and catalogs are read when Voice
 * input settings open or the microphone button is pressed.
 */

export const TRANSCRIPTION_PROVIDERS: readonly TranscriptionProvider[] = ["openai", "openrouter"];
export const TRANSCRIPTION_PROVIDER_LABELS: Record<TranscriptionProvider, string> = { openai: "OpenAI", openrouter: "OpenRouter" };
export const DEFAULT_OPENAI_TRANSCRIPTION_MODEL = "gpt-transcribe";
export const DEFAULT_TRANSCRIPTION_SETTINGS: TranscriptionSettings = {
  provider: "openai",
  models: { openai: DEFAULT_OPENAI_TRANSCRIPTION_MODEL },
};

export const TRANSCRIPTION_LINKS = {
  openai: {
    models: "https://developers.openai.com/api/docs/guides/speech-to-text#transcriptions",
    pricing: "https://developers.openai.com/api/docs/pricing#transcription-and-speech",
    keys: "https://platform.openai.com/api-keys",
  },
  openrouter: {
    models: "https://openrouter.ai/collections/speech-to-text-models",
    keys: "https://openrouter.ai/settings/keys",
  },
} as const;

const MODEL_ID = /^[A-Za-z0-9._:/-]{1,128}$/;

export function sanitizeTranscriptionSettings(value: unknown): TranscriptionSettings {
  const raw = value && typeof value === "object" ? value as Partial<TranscriptionSettings> : {};
  const provider = raw.provider === "openrouter" ? "openrouter" : "openai";
  const storedModels = raw.models && typeof raw.models === "object" ? raw.models : {};
  const models: TranscriptionSettings["models"] = {};
  for (const id of TRANSCRIPTION_PROVIDERS) {
    const model = storedModels[id];
    if (typeof model === "string" && MODEL_ID.test(model.trim())) models[id] = model.trim();
  }
  models.openai ??= DEFAULT_OPENAI_TRANSCRIPTION_MODEL;
  return { provider, models };
}

export function transcriptionModelFor(settings: TranscriptionSettings, provider = settings.provider): string {
  return settings.models[provider]?.trim() ?? "";
}

export type TranscriptionKeyState = "unknown" | "saved" | "missing" | "unavailable";
export type TranscriptionKeyOperation = "saving" | "removing" | "copying";

interface TranscriptionKeyStore {
  keys: Record<TranscriptionProvider, TranscriptionKeyState>;
  checking: boolean;
  busy: Record<TranscriptionProvider, TranscriptionKeyOperation | null>;
  errors: Record<TranscriptionProvider, string>;
  /** Confirmation of the last completed key operation. */
  notices: Record<TranscriptionProvider, string>;
  /** Bumped by every successful save, removal or copy, including key replacement. */
  revisions: Record<TranscriptionProvider, number>;
}

/** One store, so Settings and the composer always agree on whether a key exists. */
export const useTranscriptionKeys = create<TranscriptionKeyStore>(() => ({
  keys: { openai: "unknown", openrouter: "unknown" },
  checking: false,
  busy: { openai: null, openrouter: null },
  errors: { openai: "", openrouter: "" },
  notices: { openai: "", openrouter: "" },
  revisions: { openai: 0, openrouter: 0 },
}));

// A status read that started before a save or removal must not overwrite
// that operation's known result when it returns.
const writeEpochs: Record<TranscriptionProvider, number> = { openai: 0, openrouter: 0 };
let refreshInFlight: Promise<Record<TranscriptionProvider, TranscriptionKeyState>> | null = null;

function patchProvider<K extends "keys" | "busy" | "errors" | "notices" | "revisions">(
  field: K,
  provider: TranscriptionProvider,
  value: TranscriptionKeyStore[K][TranscriptionProvider],
): void {
  useTranscriptionKeys.setState((state) => ({ [field]: { ...state[field], [provider]: value } }) as unknown as Partial<TranscriptionKeyStore>);
}

/** Single-flight read of both providers' key status. */
export function refreshTranscriptionKeys(): Promise<Record<TranscriptionProvider, TranscriptionKeyState>> {
  if (refreshInFlight) return refreshInFlight;
  const epochs = { ...writeEpochs };
  useTranscriptionKeys.setState({ checking: true });
  const apply = (next: Record<TranscriptionProvider, TranscriptionKeyState>) => {
    useTranscriptionKeys.setState((state) => {
      const keys = { ...state.keys };
      for (const provider of TRANSCRIPTION_PROVIDERS) {
        if (writeEpochs[provider] === epochs[provider]) keys[provider] = next[provider];
      }
      return { keys };
    });
    return useTranscriptionKeys.getState().keys;
  };
  refreshInFlight = invoke<Record<TranscriptionProvider, "saved" | "missing" | "unavailable">>("transcription_key_status")
    .then((status) => apply({ openai: status.openai, openrouter: status.openrouter }))
    .catch(() => apply({ openai: "unavailable", openrouter: "unavailable" }))
    .finally(() => {
      refreshInFlight = null;
      useTranscriptionKeys.setState({ checking: false });
    });
  return refreshInFlight;
}

async function runKeyOperation(
  provider: TranscriptionProvider,
  operation: TranscriptionKeyOperation,
  run: () => Promise<TranscriptionKeyState | null>,
  notice: string,
): Promise<boolean> {
  if (useTranscriptionKeys.getState().busy[provider]) return false;
  patchProvider("busy", provider, operation);
  patchProvider("errors", provider, "");
  patchProvider("notices", provider, "");
  try {
    const result = await run();
    if (result === null) return false;
    writeEpochs[provider] += 1;
    patchProvider("keys", provider, result);
    patchProvider("notices", provider, notice);
    patchProvider("revisions", provider, writeEpochs[provider]);
    return true;
  } catch (reason) {
    patchProvider("errors", provider, safeErrorText(reason, "The key could not be updated."));
    return false;
  } finally {
    patchProvider("busy", provider, null);
  }
}

export function saveTranscriptionKey(provider: TranscriptionProvider, apiKey: string): Promise<boolean> {
  return runKeyOperation(provider, "saving", async () => {
    await invoke("transcription_save_key", { provider, apiKey });
    return "saved";
  }, "Saved to the OS credential store.");
}

export function removeTranscriptionKey(provider: TranscriptionProvider): Promise<boolean> {
  return runKeyOperation(provider, "removing", async () => {
    await invoke("transcription_remove_key", { provider });
    return "missing";
  }, "Key removed from this device.");
}

/** Copies the Models & accounts OpenRouter key natively; it never reaches the renderer. */
export function copyOpenRouterAccountKey(): Promise<boolean> {
  return runKeyOperation("openrouter", "copying", async () => {
    if (await invoke<boolean>("transcription_copy_openrouter_account_key")) return "saved";
    patchProvider("errors", "openrouter", "No OpenRouter key could be read from Models & accounts. Save one there, or try again if the credential store is locked.");
    return null;
  }, "Copied from Models & accounts and saved separately for voice input.");
}

export interface TranscriptionModel {
  id: string;
  name: string;
  description: string | null;
  recommended: boolean;
}

export interface TranscriptionCatalog {
  models: TranscriptionModel[];
  /** "builtin" is the documented OpenAI list, shown when the live list can't be read. */
  source: "live" | "builtin";
  notice: string | null;
}

export function listTranscriptionModels(provider: TranscriptionProvider, force = false): Promise<TranscriptionCatalog> {
  return invoke<TranscriptionCatalog>("transcription_models", { provider, force });
}

/** Native-issued monotonic IDs make IPC transport replay non-billable. */
export function createTranscriptionRequestId(): Promise<string> {
  return invoke<string>("transcription_request_id");
}

/** Uploads one WAV recording. The bytes travel as the raw IPC body. */
export function transcribeRecording(id: string, provider: TranscriptionProvider, model: string, wav: Uint8Array): Promise<string> {
  return invoke<string>("transcription_transcribe", wav, {
    headers: {
      "Mythra-Transcription-Id": id,
      "Mythra-Transcription-Provider": provider,
      "Mythra-Transcription-Model": model,
    },
  });
}

/** Aborts the native upload, not just this window's interest in its result. */
export function cancelTranscription(id: string): void {
  void invoke("transcription_cancel", { id }).catch(() => undefined);
}
