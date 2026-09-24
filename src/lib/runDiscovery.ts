import { invoke } from "@tauri-apps/api/core";
import type { Provider } from "../types";

export type RunDiscoveryProvider = Provider;
export const DISCOVERY_PROVIDERS = [
  { value: "openai", label: "OpenAI" }, { value: "claude", label: "Claude" },
  { value: "cursor", label: "Cursor" }, { value: "openrouter", label: "OpenRouter" },
  { value: "lmstudio", label: "LM Studio" },
] satisfies { value: Provider; label: string }[];
const FALLBACK_MODELS: Record<Provider, string> = { openai: "gpt-5.6-luna", claude: "claude-sonnet-5", cursor: "auto", openrouter: "", lmstudio: "" };
export interface RunDiscoveryPreferences { provider: RunDiscoveryProvider; model: string; effort: string; fast: boolean; models?: Partial<Record<RunDiscoveryProvider, string>>; efforts?: Partial<Record<RunDiscoveryProvider, string>> }
export interface RunDiscoverySuggestion { command: string; setupCommand?: string; label: string; explanation: string; warning?: string }
export type RunDiscoveryPurpose = "run" | "checks";
export interface RunDiscoveryModel { id: string; label: string; efforts?: string[] }
export type RunDiscoveryCatalogs = Partial<Record<RunDiscoveryProvider, RunDiscoveryModel[]>>;
export const RUN_DISCOVERY_PREFERENCES_KEY = "kiwi.runDiscovery";
export const DEFAULT_RUN_DISCOVERY: RunDiscoveryPreferences = { provider: "openai", model: "gpt-5.6-luna", effort: "high", fast: true };
export const DISCOVERY_EFFORTS = ["low", "medium", "high", "xhigh", "max"];
function defaultEffort(provider: Provider): string { return provider === "openai" ? "high" : provider === "claude" ? "low" : "default"; }
function isProvider(value: unknown): value is Provider { return DISCOVERY_PROVIDERS.some((entry) => entry.value === value); }
function cleanToken(value: unknown, limit: number): string | undefined {
  return typeof value === "string" && value.trim() && value.length <= limit && !/[\u0000-\u001f]/.test(value) ? value.trim() : undefined;
}
function cleanChoices(value: unknown, limit: number): Partial<Record<Provider, string>> | undefined {
  if (!value || typeof value !== "object") return undefined;
  return Object.fromEntries(Object.entries(value).flatMap(([key, token]) => {
    const cleaned = cleanToken(token, limit);
    return isProvider(key) && cleaned ? [[key, cleaned]] : [];
  }));
}
export function sanitizeRunDiscoveryPreferences(value: unknown): RunDiscoveryPreferences {
  if (!value || typeof value !== "object") return { ...DEFAULT_RUN_DISCOVERY };
  const raw = value as Partial<RunDiscoveryPreferences>;
  const provider = isProvider(raw.provider) ? raw.provider : "openai";
  const models = cleanChoices(raw.models, 200), efforts = cleanChoices(raw.efforts, 64);
  return {
    ...(models ? { models } : {}), ...(efforts ? { efforts } : {}), provider,
    model: cleanToken(raw.model, 200) ?? FALLBACK_MODELS[provider],
    effort: isProvider(raw.provider) ? raw.effort === "ultra" ? "max" : cleanToken(raw.effort, 64) ?? defaultEffort(provider) : "high",
    fast: typeof raw.fast === "boolean" ? raw.fast : true,
  };
}
export function discoverRunCommand(requestId: string, cwd: string, preferences: RunDiscoveryPreferences, lmStudioBaseUrl?: string, purpose: RunDiscoveryPurpose = "run"): Promise<RunDiscoverySuggestion> {
  const { provider, model, effort, fast } = preferences;
  return invoke("run_discovery_start", { options: { requestId, cwd, provider, model: model.trim(), effort, fast: provider === "openai" && fast, ...(purpose === "checks" ? { purpose } : {}), ...(provider === "lmstudio" && lmStudioBaseUrl ? { lmStudioBaseUrl } : {}) } });
}
export function discoverCheckCommand(requestId: string, cwd: string, preferences: RunDiscoveryPreferences, lmStudioBaseUrl?: string): Promise<RunDiscoverySuggestion> {
  return discoverRunCommand(requestId, cwd, preferences, lmStudioBaseUrl, "checks");
}
export function cancelRunDiscovery(requestId: string): Promise<void> {
  return invoke("run_discovery_cancel", { requestId });
}

export function switchRunDiscoveryProvider(preferences: RunDiscoveryPreferences, provider: RunDiscoveryProvider, catalogs: RunDiscoveryCatalogs): RunDiscoveryPreferences {
  const models = { ...preferences.models, [preferences.provider]: preferences.model };
  const efforts = { ...preferences.efforts, [preferences.provider]: preferences.effort };
  const fallback = FALLBACK_MODELS[provider];
  const catalog = catalogs[provider];
  const model = cleanToken(models[provider], 200) ?? (!catalog?.length || catalog.some((entry) => entry.id === fallback) ? fallback : catalog[0].id);
  return { ...preferences, provider, model, models, efforts, effort: efforts[provider] ?? defaultEffort(provider) };
}
