import type { AppSettings, ChildAgentTarget } from "../../../types";
import type { WireCrewTarget, WireEffort, WireExecutionSettings, WireSubagents } from "../wire";
import { sanitizeChildAgentSettings } from "../../childAgents";
import { nativeSubagentOptionsAreValid, sanitizeNativeSubagentOptions, autoCompactTokensError } from "../../threadSubagentSettings";
import { HostReadError, objectArgs } from "./scope";
import type { HostContextSources } from "./hostContext";
import { loadStored, storedRevision } from "../../storage";
export const EXECUTION_PREFERENCES_KEY = "kiwi.threadExecutionPreferences";
let revision = -1, stored: Record<string, WireExecutionSettings> = {};
export function getHostThreadPreferences(id?: string): WireExecutionSettings | undefined {
  const next = storedRevision(EXECUTION_PREFERENCES_KEY);
  if (revision !== next) { stored = loadStored(EXECUTION_PREFERENCES_KEY, {}); revision = next; }
  if (!id || !stored[id]) return undefined;
  try { return validateExecutionSettings(stored[id]); } catch { return { permission: "read-only" }; }
}
const MAX_CREW = 24;
const wireEffort = (effort: string): WireEffort => (effort === "ultra" ? "max" : effort) as WireEffort;
/** The host's roster as a viewer may see it: no secrets, and nothing else to trust. */
export function publicCrew(targets: readonly ChildAgentTarget[]): WireCrewTarget[] {
  return sanitizeChildAgentSettings({ targets }).targets.slice(0, MAX_CREW).map((target) => ({ id: target.id, provider: target.provider, model: target.model,
    label: target.label, description: target.description, enabled: target.enabled, reasoningMode: target.reasoningMode,
    reasoningEffort: wireEffort(target.reasoningEffort), reasoningMaxEffort: wireEffort(target.reasoningMaxEffort),
    ...(target.autoCompactTokens !== undefined ? { autoCompactTokens: target.autoCompactTokens } : {}) }));
}
/** The local sanitizer drops what it can't accept, so a shortened list is refused
 * here rather than silently saving fewer roles than were asked for. */
function validCrew(value: unknown): WireCrewTarget[] {
  if (!Array.isArray(value) || value.length > MAX_CREW) throw invalid();
  const crew = publicCrew(value as ChildAgentTarget[]);
  if (crew.length !== value.length) throw invalid();
  return crew;
}
export function validateExecutionSettings(value: unknown, sources?: HostContextSources, base?: AppSettings): WireExecutionSettings {
  const raw = objectArgs(value), result: WireExecutionSettings = {};
  if (Object.keys(raw).some((key) => !["provider", "model", "effort", "permission", "serviceTier", "subagents", "isolated", "crew"].includes(key))) throw invalid();
  if (raw.crew !== undefined) result.crew = validCrew(raw.crew);
  if (raw.provider !== undefined) { if (!["openai", "openrouter", "lmstudio", "claude", "cursor"].includes(String(raw.provider))) throw invalid(); result.provider = raw.provider as WireExecutionSettings["provider"]; }
  if (raw.model !== undefined) { if (typeof raw.model !== "string" || !raw.model || raw.model.length > 256) throw invalid(); result.model = raw.model; }
  if (raw.effort !== undefined) { if (!["low", "medium", "high", "xhigh", "max"].includes(String(raw.effort))) throw invalid(); result.effort = raw.effort as WireExecutionSettings["effort"]; }
  if (raw.permission !== undefined) { if (!["read-only", "ask", "full"].includes(String(raw.permission))) throw invalid(); result.permission = raw.permission as WireExecutionSettings["permission"]; }
  if (raw.serviceTier !== undefined) { if (raw.serviceTier !== null && raw.serviceTier !== "standard" && raw.serviceTier !== "fast") throw invalid(); result.serviceTier = raw.serviceTier; }
  if (raw.isolated !== undefined) { if (typeof raw.isolated !== "boolean") throw invalid(); result.isolated = raw.isolated; }
  if (raw.subagents !== undefined) {
    const sub = objectArgs(raw.subagents);
    if (Object.keys(sub).some((key) => !["enabled", "engine", "maxConcurrent", "autoCompactTokens", "nativeOptions", "crew"].includes(key))
      || typeof sub.enabled !== "boolean" || sub.engine !== "mythra" && sub.engine !== "native"
      || typeof sub.maxConcurrent !== "number" || !Number.isInteger(sub.maxConcurrent) || sub.maxConcurrent < 1 || sub.maxConcurrent > 24
      || autoCompactTokensError(sub.autoCompactTokens) || !nativeSubagentOptionsAreValid(sub.nativeOptions)) throw invalid();
    result.subagents = { enabled: sub.enabled, engine: sub.engine, maxConcurrent: sub.maxConcurrent,
      ...(sub.autoCompactTokens !== undefined ? { autoCompactTokens: sub.autoCompactTokens as number } : {}),
      ...(sub.nativeOptions !== undefined ? { nativeOptions: sanitizeNativeSubagentOptions(sub.nativeOptions) as WireSubagents["nativeOptions"] } : {}),
      ...(sub.crew !== undefined ? { crew: validCrew(sub.crew) } : {}) };
  }
  if (sources && base) {
    const provider = result.provider ?? base.provider;
    const model = result.model ?? (provider === base.provider ? base.model : sources.getProviderCatalog().find((p) => p.id === provider)?.models[0]?.id);
    const catalog = sources.getProviderCatalog().find((p) => p.id === provider)?.models.find((m) => m.id === model);
    if (!catalog || result.effort && !catalog.efforts.includes(result.effort)) throw invalid();
    if (result.provider && !result.model) result.model = catalog.id;
    if (result.serviceTier === "fast" && provider !== "openai") throw invalid();
    for (const target of result.subagents?.crew ?? []) {
      // An empty model means the provider's default, which needs no catalog row.
      const models = sources.getProviderCatalog().find((entry) => entry.id === target.provider)?.models;
      if (!models || target.model && !models.some((entry) => entry.id === target.model)) throw invalid();
    }
  }
  return result;
}
function invalid() { return new HostReadError("unsupported", "The other device does not offer these execution settings."); }
/** What the local pickers show for a thread a paired device changed. */
export function sharedThreadPreferences(settings: AppSettings, prefs: WireExecutionSettings): Pick<AppSettings, "permission" | "serviceTier"> {
  const { permission, serviceTier } = applyHostExecutionPreferences(settings, prefs);
  return { permission, serviceTier };
}
export function applyHostExecutionPreferences(settings: AppSettings, prefs?: WireExecutionSettings): AppSettings {
  if (!prefs) return settings;
  const rank = { "read-only": 0, ask: 1, full: 2 };
  const permission = prefs.permission && rank[prefs.permission] <= rank[settings.permission] ? prefs.permission : settings.permission;
  const sub = prefs.subagents;
  const crew = sub?.crew ?? prefs.crew;
  return { ...settings, permission, ...(crew ? { childAgents: { enabled: crew.length > 0, targets: crew as ChildAgentTarget[] } } : {}), ...(prefs.model ? { model: prefs.model } : {}), ...(prefs.effort ? { reasoningEffort: prefs.effort, ultra: false } : {}),
    ...(prefs.serviceTier !== undefined ? { serviceTier: prefs.serviceTier === "standard" ? null : prefs.serviceTier } : {}),
    ...(sub ? { subagentsEnabled: sub.enabled, subagentEngine: sub.engine, nativeSubagentMax: sub.maxConcurrent,
      subagentMax: sub.maxConcurrent, nativeSubagentOptions: sub.nativeOptions, autoCompactTokens: sub.autoCompactTokens } : {}) };
}
