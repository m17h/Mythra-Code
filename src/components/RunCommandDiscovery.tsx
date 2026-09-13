import { useEffect, useState } from "react";
import { LoaderCircle, Settings2, Sparkles } from "lucide-react";
import { AppSelectMenu } from "./AppSelectMenu";
import { usePersistedState } from "../hooks/usePersistedState";
import type { useRunCommandDiscovery } from "../hooks/useRunCommandDiscovery";
import { DEFAULT_RUN_DISCOVERY, DISCOVERY_PROVIDERS, DISCOVERY_EFFORTS, RUN_DISCOVERY_PREFERENCES_KEY, sanitizeRunDiscoveryPreferences, switchRunDiscoveryProvider, type RunDiscoveryProvider, type RunDiscoveryCatalogs, type RunDiscoverySuggestion } from "../lib/runDiscovery";
import "./RunCommandDiscovery.css";

const EFFORT_LABELS: Record<string, string> = { default: "Model default", none: "None", minimal: "Minimal", low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Maximum", ultra: "Ultra" };
export default function RunCommandDiscovery({ discovery, catalogs = {}, onAccounts, onFound }: {
  discovery: ReturnType<typeof useRunCommandDiscovery>;
  catalogs?: RunDiscoveryCatalogs;
  onAccounts?: () => void;
  onFound: (command: Pick<RunDiscoverySuggestion, "command" | "label">) => void;
}) {
  const [preferences, setPreferences] = usePersistedState(RUN_DISCOVERY_PREFERENCES_KEY, DEFAULT_RUN_DISCOVERY, { init: (load) => sanitizeRunDiscoveryPreferences(load()) });
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [modelDraft, setModelDraft] = useState(preferences.model);
  useEffect(() => setModelDraft(preferences.model), [preferences.model, preferences.provider]);
  const catalog = catalogs[preferences.provider] ?? [];
  const model = catalog.find((entry) => entry.id === preferences.model);
  const efforts = preferences.provider === "cursor" ? [] : model?.efforts ?? (preferences.provider === "openai" || preferences.provider === "claude" ? DISCOVERY_EFFORTS : ["default", "low", "medium", "high"]);
  const effort = efforts.includes(preferences.effort) ? preferences.effort : efforts[0] ?? "default";
  const unavailable = catalog.length > 0 && !model;
  const missingModel = !modelDraft.trim();
  return <section className="run-discovery" aria-label="Find a run command">
    <div className="run-discovery-actions">
      <button type="button" className="secondary-button" disabled={discovery.pending || unavailable || missingModel} onClick={() => { setSettingsOpen(false); const selected = { ...preferences, model: modelDraft.trim(), effort }; if (selected.model !== preferences.model || selected.effort !== preferences.effort) setPreferences(selected); void discovery.discover(selected, ({ command, label }) => onFound({ command, label })); }}>
        {discovery.pending ? <LoaderCircle size={14} className="spin" /> : <Sparkles size={14} />}
        {discovery.pending ? "Finding command…" : "Find run command"}
      </button>
      {discovery.pending && <button type="button" className="secondary-button" onClick={() => void discovery.cancel()}>Stop discovery</button>}
      <button type="button" className="icon-button" aria-label="Discovery model settings" aria-expanded={settingsOpen} onClick={() => setSettingsOpen(!settingsOpen)}><Settings2 size={15} /></button>
    </div>
    <small>{DISCOVERY_PROVIDERS.find((entry) => entry.value === preferences.provider)?.label} · {model?.label ?? (preferences.model || "Choose a model")}{efforts.length ? ` · ${EFFORT_LABELS[effort] ?? effort}` : ""}{preferences.provider === "openai" && preferences.fast ? " · Fast" : ""}</small>
    <p>Investigates the project and saves its dev command to Run. Nothing launches until you press Run. No chat is saved.</p>
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
    {discovery.suggestion && <div className="run-discovery-result" role="status">
      <strong>Saved to Run</strong><pre>{discovery.suggestion.command}</pre>
      <p>{discovery.suggestion.explanation}</p>
      {discovery.suggestion.warning && <p role="alert">{discovery.suggestion.warning}</p>}
    </div>}
  </section>;
}
