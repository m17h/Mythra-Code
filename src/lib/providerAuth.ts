import { invoke } from "@tauri-apps/api/core";
import type { Account } from "../types";
import type { ClaudeRuntimeStatus } from "./claude";

/**
 * Direct API-key billing for the OpenAI (Codex) and Anthropic (Claude Code)
 * providers. Keys are saved or removed immediately in the OS credential
 * store, separately from voice-input keys and from each CLI's own sign-in;
 * no command ever returns a saved key. Choosing how a provider bills also
 * applies immediately and is refused while that provider has active work.
 */

export type ApiKeyProvider = "openai" | "anthropic";
export type ProviderKeyState = "saved" | "missing" | "unavailable";
export type ClaudeBilling = "subscription" | "apiKey";

// Native admission protects dispatched work. These leases cover the earlier
// renderer awaits, including drafts that do not have a thread id yet.
const preparations: Record<ApiKeyProvider, Set<symbol>> = { openai: new Set(), anthropic: new Set() };
const authChanges = new Map<ApiKeyProvider, symbol>();

export function providerAuthChanging(provider: ApiKeyProvider): boolean {
  return authChanges.has(provider);
}

function providerName(provider: ApiKeyProvider): string {
  return provider === "openai" ? "OpenAI" : "Claude";
}

/** Acquire synchronously before any turn/steer preparation await. */
export function beginProviderPreparation(provider: ApiKeyProvider): () => void {
  if (authChanges.has(provider)) {
    throw new Error(`${providerName(provider)} billing or credentials are changing. Wait for that operation to finish before sending.`);
  }
  const token = Symbol(provider);
  preparations[provider].add(token);
  return () => { preparations[provider].delete(token); };
}

/** Check immediately before a mutation, after any confirmation dialog. */
export function beginProviderAuthChange(provider: ApiKeyProvider): () => void {
  if (preparations[provider].size) {
    throw new Error(`Wait for ${providerName(provider)} prompts to finish preparing before changing billing or credentials.`);
  }
  if (authChanges.has(provider)) {
    throw new Error(`${providerName(provider)} billing or credentials are already changing. Try again when that operation finishes.`);
  }
  const token = Symbol(provider);
  authChanges.set(provider, token);
  return () => { if (authChanges.get(provider) === token) authChanges.delete(provider); };
}

async function changeProviderAuth<T>(provider: ApiKeyProvider, change: () => Promise<T>): Promise<T> {
  const finish = beginProviderAuthChange(provider);
  try {
    return await change();
  } finally {
    finish();
  }
}

export interface ProviderAuthStatus {
  openai: ProviderKeyState;
  anthropic: ProviderKeyState;
  openaiBilling: ClaudeBilling | null;
  /** Null when the saved choice could not be read; it is never guessed. */
  claudeBilling: ClaudeBilling | null;
}

export const PROVIDER_API_LINKS = {
  openai: {
    keys: "https://platform.openai.com/api-keys",
    limits: "https://platform.openai.com/settings/organization/limits",
    docs: "https://learn.chatgpt.com/docs/app-server#2-log-in-with-an-api-key",
  },
  anthropic: {
    keys: "https://console.anthropic.com/settings/keys",
    limits: "https://console.anthropic.com/settings/limits",
    docs: "https://code.claude.com/docs/en/authentication",
    credits: "https://support.claude.com/en/articles/17154008-monthly-api-credits-for-max-and-team-plans",
  },
} as const;

/** Codex can run turns: signed in with ChatGPT or an OpenAI API key. */
export function codexAccountReady(account: Pick<Account, "type"> | null | undefined): boolean {
  return account?.type === "chatgpt" || account?.type === "apiKey";
}

/** Codex bills an OpenAI API key, so there is no subscription quota to show. */
export function codexUsesApiKey(account: Pick<Account, "type"> | null | undefined): boolean {
  return account?.type === "apiKey";
}

/** Claude turns bill an Anthropic API key instead of the subscription. */
export function claudeUsesApiKey(status: Pick<ClaudeRuntimeStatus, "billing"> | null | undefined): boolean {
  return status?.billing === "apiKey";
}

export function getProviderAuthStatus(): Promise<ProviderAuthStatus> {
  return invoke<ProviderAuthStatus>("provider_auth_status");
}

export async function saveProviderApiKey(provider: ApiKeyProvider, apiKey: string): Promise<void> {
  await changeProviderAuth(provider, () => invoke<void>("provider_api_key_save", { provider, apiKey }));
}

/** Resolves to a notice when a related sign-out could not be confirmed. */
export function removeProviderApiKey(provider: ApiKeyProvider): Promise<string | null> {
  return changeProviderAuth(provider, () => invoke<string | null>("provider_api_key_remove", { provider }));
}

/** Signs Codex in with the saved OpenAI key; this replaces a ChatGPT sign-in. */
export async function activateOpenAiApiKey(): Promise<void> {
  await changeProviderAuth("openai", () => invoke<void>("openai_api_key_use"));
}

/** Keep pending prompts out of the gap between these two native operations. */
export async function saveAndConnectOpenAiApiKey(apiKey: string): Promise<void> {
  await changeProviderAuth("openai", async () => {
    await invoke<void>("provider_api_key_save", { provider: "openai", apiKey });
    try {
      await invoke<void>("openai_api_key_use");
    } catch {
      throw new Error("The key was saved, but Codex couldn't connect it. Use Connect saved key to retry; the billing choice has not changed.");
    }
  });
}

export async function setClaudeBilling(billing: ClaudeBilling): Promise<void> {
  await changeProviderAuth("anthropic", () => invoke<void>("claude_billing_set", { billing }));
}

export async function setOpenAiBilling(billing: ClaudeBilling): Promise<void> {
  await changeProviderAuth("openai", () => invoke<void>("openai_billing_set", { billing }));
}
