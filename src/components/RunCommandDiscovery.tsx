import { useEffect, useState, useSyncExternalStore } from "react";
import { LoaderCircle, Settings2, Sparkles } from "lucide-react";
import { AppSelectMenu } from "./AppSelectMenu";
import { loadStored, storeValue } from "../lib/storage";
import { DEFAULT_RUN_DISCOVERY, DISCOVERY_PROVIDERS, DISCOVERY_EFFORTS, RUN_DISCOVERY_PREFERENCES_KEY, sanitizeRunDiscoveryPreferences, switchRunDiscoveryProvider, type RunDiscoveryPreferences, type RunDiscoveryProvider, type RunDiscoveryCatalogs } from "../lib/runDiscovery";
import "./RunCommandDiscovery.css";

const EFFORT_LABELS: Record<string, string> = { default: "Model default", none: "None", minimal: "Minimal", low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Maximum", ultra: "Ultra" };

/** What a discovery worker reports. An empty `command` means nothing suitable was found. */
export interface DiscoveredCommandSuggestion { command: string; setupCommand?: string; label?: string; explanation: string; warning?: string }

/** The shared shape of `useRunCommandDiscovery` and `useCheckCommandDiscovery`. */
export interface CommandDiscoveryState {
  pending: boolean;
  suggestion: DiscoveredCommandSuggestion | null;
  error: string;
  discover: (preferences: RunDiscoveryPreferences, onFound?: (result: DiscoveredCommandSuggestion) => void) => unknown;
  cancel: () => unknown;
  clearSuggestion: () => void;
}

export type DiscoveryPurpose = "run" | "checks";

const COPY: Record<DiscoveryPurpose, { region: string; find: string; finding: string; intro: string; saved: string; none: string }> = {
  run: {
    region: "Find a run command",
    find: "Find run command",
    finding: "Finding command…",
    intro: "Finds and saves this project’s setup and dev command. Nothing launches until you press Run.",
    saved: "Saved to Run",
    none: "No run command found",
  },
  checks: {
    region: "Find a check command",
    find: "Find checks",
    finding: "Finding checks…",
    intro: "Finds and saves this project’s test or check command. Nothing runs until you press Run checks.",
    saved: "Saved to Run checks",
    none: "No check command found",
  },
};

// One live copy of the discovery model preferences, so the Run popover and
// Review checks always show and use the same explicit choice.
const preferenceListeners = new Set<() => void>();
let preferenceRaw: string | undefined;
let preferenceSnapshot: RunDiscoveryPreferences = DEFAULT_RUN_DISCOVERY;
function readPreferences(): RunDiscoveryPreferences {
  const raw = JSON.stringify(loadStored<unknown>(RUN_DISCOVERY_PREFERENCES_KEY, null));
  if (raw !== preferenceRaw) {
    preferenceRaw = raw;
    preferenceSnapshot = sanitizeRunDiscoveryPreferences(JSON.parse(raw));
  }
  return preferenceSnapshot;
}
function writePreferences(next: RunDiscoveryPreferences) {
  storeValue(RUN_DISCOVERY_PREFERENCES_KEY, next);
  preferenceListeners.forEach((listener) => listener());
}
function subscribePreferences(listener: () => void) {
  preferenceListeners.add(listener);
  return () => { preferenceListeners.delete(listener); };
}

/** Shared discovery model choice plus everything needed to start a worker with it. */
export function useDiscoveryPreferences(catalogs: RunDiscoveryCatalogs = {}) {
  const preferences = useSyncExternalStore(subscribePreferences, readPreferences, readPreferences);
  const catalog = catalogs[preferences.provider] ?? [];
  const model = catalog.find((entry) => entry.id === preferences.model);
  const efforts = preferences.provider === "cursor" ? [] : model?.efforts ?? (preferences.provider === "openai" || preferences.provider === "claude" ? DISCOVERY_EFFORTS : ["default", "low", "medium", "high"]);
  const effort = efforts.includes(preferences.effort) ? preferences.effort : efforts[0] ?? "default";
  const unavailable = catalog.length > 0 && !model;
  const summary = `${DISCOVERY_PROVIDERS.find((entry) => entry.value === preferences.provider)?.label} · ${model?.label ?? (preferences.model || "Choose a model")}${efforts.length ? ` · ${EFFORT_LABELS[effort] ?? effort}` : ""}${preferences.provider === "openai" && preferences.fast ? " · Fast" : ""}`;
  /** Why a worker cannot start with the saved choice, if it cannot. */
  const blockedReason = !preferences.model.trim()
    ? "Choose a model in Discovery model settings to get started."
    : unavailable ? "Your saved model is unavailable. Choose another in Discovery model settings." : "";
  return { preferences, setPreferences: writePreferences, catalog, model, efforts, effort, unavailable, summary, blockedReason };
}

export default function RunCommandDiscovery({ discovery, purpose = "run", catalogs = {}, onAccounts, onFound }: {
  discovery: CommandDiscoveryState;
  /** Chooses the copy; both purposes share one model setting. */
  purpose?: DiscoveryPurpose;
  catalogs?: RunDiscoveryCatalogs;
  onAccounts?: () => void;
  /** Called only with a non-empty command. Nothing is launched from here. */
  onFound: (command: { command: string; label: string; setupCommand?: string }) => void;
}) {
  const copy = COPY[purpose];
  const { preferences, setPreferences, catalog, efforts, effort, unavailable, summary } = useDiscoveryPreferences(catalogs);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [modelDraft, setModelDraft] = useState(preferences.model);
  useEffect(() => setModelDraft(preferences.model), [preferences.model, preferences.provider]);
  const missingModel = !modelDraft.trim();
  const found = discovery.suggestion?.command.trim() ? discovery.suggestion : null;
  const setup = found?.setupCommand?.trim();
  return <section className="run-discovery" aria-label={copy.region}>
    <div className="run-discovery-actions">
      <button type="button" className="secondary-button" disabled={discovery.pending || unavailable || missingModel} onClick={() => {
        setSettingsOpen(false);
        const selected = { ...preferences, model: modelDraft.trim(), effort };
        if (selected.model !== preferences.model || selected.effort !== preferences.effort) setPreferences(selected);
        void discovery.discover(selected, ({ command, label, setupCommand }) => {
          if (!command.trim()) return;
          onFound({ command, label: label ?? "", ...(setupCommand?.trim() ? { setupCommand: setupCommand.trim() } : {}) });
        });
      }}>
        {discovery.pending ? <LoaderCircle size={14} className="spin" /> : <Sparkles size={14} />}
        {discovery.pending ? copy.finding : copy.find}
      </button>
      {discovery.pending && <button type="button" className="secondary-button" onClick={() => void discovery.cancel()}>Stop discovery</button>}
      <button type="button" className="icon-button" aria-label="Discovery model settings" aria-expanded={settingsOpen} onClick={() => setSettingsOpen(!settingsOpen)}><Settings2 size={15} /></button>
    </div>
    <small>{summary}</small>
    <p title="Keeps working if you switch projects. No chat is saved. Uses the same model as the other finder.">{copy.intro}</p>
    {settingsOpen && <fieldset className="run-discovery-settings" disabled={discovery.pending}>
      <legend>Discovery model · saved for all projects</legend>
      <div className="run-discovery-field"><span>Provider</span><AppSelectMenu portal menuPlacement="top" value={preferences.provider} ariaLabel="Discovery provider" options={DISCOVERY_PROVIDERS} onChange={(provider) => {
        const next = provider as RunDiscoveryProvider;
        setPreferences(switchRunDiscoveryProvider(preferences, next, catalogs));
      }} /></div>
      <div className="run-discovery-field"><span>Model</span><AppSelectMenu portal menuPlacement="top" value={preferences.model} ariaLabel="Discovery model" searchable options={catalog.map((entry) => ({ value: entry.id, label: entry.label }))} selectedDisplay={{ label: preferences.model }} emptyMessage="Connect this provider in Models and accounts" onChange={(value) => setPreferences({ ...preferences, model: value })} /></div>
      {!catalog.length && <label>Model ID<input aria-label="Discovery model ID" maxLength={200} value={modelDraft} onChange={(event) => setModelDraft(event.target.value)} onBlur={() => { if (modelDraft.trim() !== preferences.model) setPreferences({ ...preferences, model: modelDraft.trim() }); }} /></label>}
      {efforts.length > 0 && <div className="run-discovery-field"><span>Reasoning</span><AppSelectMenu portal menuPlacement="top" value={effort} ariaLabel="Discovery reasoning" options={efforts.map((value) => ({ value, label: EFFORT_LABELS[value] ?? value }))} onChange={(value) => setPreferences({ ...preferences, effort: value })} /></div>}
      {preferences.provider === "openai" && <label className="run-discovery-fast"><input type="checkbox" checked={preferences.fast} onChange={(event) => setPreferences({ ...preferences, fast: event.target.checked })} />Fast mode (priority service)</label>}
      {preferences.provider === "cursor" && <small>Cursor uses the selected model’s own reasoning settings.</small>}
      {onAccounts && <button type="button" className="secondary-button" onClick={onAccounts}>Models and accounts</button>}
    </fieldset>}
    {missingModel && <p role="status">Choose a model in Discovery model settings to get started.</p>}
    {unavailable && <p role="status">Your saved model is unavailable. Choose another in Discovery model settings.</p>}
    {discovery.error && <p role="alert">{discovery.error}</p>}
    {found && <div className="run-discovery-result" role="status">
      <strong>{copy.saved}</strong>
      {setup && <><pre aria-label="Setup before each run">{setup}</pre><small>then</small></>}
      <pre>{found.command}</pre>
      <p>{found.explanation}</p>
      {found.warning && <p role="alert">{found.warning}</p>}
    </div>}
    {discovery.suggestion && !found && <div className="run-discovery-result empty" role="status">
      <strong>{copy.none}</strong>
      {discovery.suggestion.explanation && <p>{discovery.suggestion.explanation}</p>}
    </div>}
  </section>;
}
