import { useEffect, useRef, useState } from "react";
import { Check, Info } from "lucide-react";
import type { Project, Provider } from "../types";
import type { PreferenceHistoryProgress } from "../hooks/usePreferenceLearning";
import { providerDisplayName } from "../lib/childAgents";
import { confirmDialog } from "../lib/confirmDialog";
import { resolvePreferenceLearningModel } from "../lib/preferenceLearning";
import { PREFERENCE_LEARNING_LIMITS } from "../lib/preferenceLearningTypes";
import {
  clearPreferenceLearning,
  configurePreferenceLearning,
  editPreferenceLearning,
  forgetPreferenceLearning,
  loadPreferenceLearning,
  usePreferenceLearningHydrated,
  usePreferenceLearningJob,
  usePreferenceLearningScope,
  usePreferenceLearningSavedScopeKeys,
} from "../lib/preferenceLearningStore";
import { AppSelectMenu, type AppSelectOption } from "./AppSelectMenu";
import type { ChildAgentModelOption } from "./ChildAgentRoster";
import { PixelWorkingMark } from "./PixelWorkingMark";
import { InfoPopover } from "./InfoPopover";
import "./PreferenceLearningSettings.css";

type Props = {
  projects: Project[];
  modelCatalogs: Partial<Record<Provider, ChildAgentModelOption[]>>;
  onLearnPastConversations?: (scopeKey: string) => Promise<void>;
  onCancelLearning?: (scopeKey: string) => void;
  historyProgress?: PreferenceHistoryProgress | null;
  onChanged?: (message: string) => void;
};

const PROVIDERS: Provider[] = ["openai", "claude", "cursor", "openrouter", "lmstudio"];
const historyCount = (value: number, label: string) => `${value} ${label}${value === 1 ? "" : "s"}`;

function LearningExperimentalNotice() {
  return <InfoPopover className="preference-learning-experimental" triggerClassName="preference-learning-info"
    label="About experimental preference learning" trigger={<><Info size={14} aria-hidden="true" /><span>Experimental</span></>}>
    <p className="preference-learning-info-message">
      <strong>Experimental feature.</strong> Designed to be low-risk: learning adds a separate system prompt for the app or selected project. It does not overwrite your existing prompts or edit project files. Learned instructions can still affect answers; review or disable them at any time. Analyzing chats shares selected text with your chosen provider and uses quota or credits.
    </p>
  </InfoPopover>;
}

function settingsError(failure: unknown): string {
  try {
    const text = failure instanceof Error ? failure.message : String(failure);
    if (/revision|changed.*(?:sav|clear|forget|remov)|conflict/i.test(text)) return "The learned preferences changed. Review the latest preferences and try again.";
    if (/too large|invalid text/i.test(text)) return "The learned instructions are too long or contain invalid text. Shorten the document and try again.";
    if (/permission denied|operation not permitted/i.test(text)) return "Mythra Code could not save learned preferences because storage access was denied.";
  } catch { /* Native failures may not have a safe message getter. */ }
  return "Could not save learned preferences. Your existing preferences were preserved. Try again.";
}

/** These settings have their own durable store and never edit authored prompts. */
export function PreferenceLearningSettings(props: Props) {
  const [selectedScope, setSelectedScope] = useState("app");
  const [scopeBusy, setScopeBusy] = useState(false);
  const [scopeFocusRequest, setScopeFocusRequest] = useState(0);
  const scopePickerRef = useRef<HTMLFieldSetElement>(null);
  const savedScopeKeys = usePreferenceLearningSavedScopeKeys();
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (!scopeFocusRequest) return;
    const frame = requestAnimationFrame(() => scopePickerRef.current?.querySelector("button")?.focus());
    return () => cancelAnimationFrame(frame);
  }, [scopeFocusRequest]);
  const projectScopeKeys = new Set(props.projects.map((project) => `project:${project.id}`));
  const removedScopeKeys = savedScopeKeys.filter((key) => key.startsWith("project:") && !projectScopeKeys.has(key));
  const scopes: AppSelectOption[] = [
    { value: "app", label: "App", detail: "All projects and chats" },
    ...props.projects.map((project) => ({ value: `project:${project.id}`, label: project.name, detail: "Only this project's chats" })),
    ...removedScopeKeys.map((key) => ({ value: key, label: `Removed project · ${key.slice(8)}`, detail: "Saved preferences · project no longer listed" })),
  ];
  const selectedScopeAvailable = scopes.some((scope) => scope.value === selectedScope);
  const scopeKey = selectedScopeAvailable ? selectedScope : "app";
  useEffect(() => { if (!selectedScopeAvailable) setSelectedScope("app"); }, [selectedScopeAvailable]);
  return <div className="set-group preference-learning-settings">
    <div className="set-group-head"><h4>Learned preferences</h4><span className="set-group-note">Saves automatically</span><LearningExperimentalNotice /></div>
    <p>Learn how you like to work from finished conversations. Learned instructions are added as their own layer; your prompts are never edited. You get a notification whenever they change.</p>
    <fieldset ref={scopePickerRef} className="preference-learning-scope" disabled={scopeBusy}>
      <span>Scope</span>
      <AppSelectMenu ariaLabel="Preference learning scope" value={scopeKey} options={scopes} portal searchable={scopes.length > 8} onChange={setSelectedScope} />
    </fieldset>
    <ScopeEditor key={scopeKey} {...props} scopeKey={scopeKey} scopeName={scopes.find((scope) => scope.value === scopeKey)?.label ?? "Project"} removedProject={removedScopeKeys.includes(scopeKey)} onBusyChange={setScopeBusy} onForgot={(scopeName) => {
      if (!mounted.current) return;
      setSelectedScope("app");
      setScopeBusy(false);
      setScopeFocusRequest((request) => request + 1);
      props.onChanged?.(`Saved preferences forgotten for ${scopeName}.`);
    }} />
  </div>;
}

function ScopeEditor({ scopeKey, scopeName, removedProject, modelCatalogs, onLearnPastConversations, onCancelLearning, historyProgress, onChanged, onBusyChange, onForgot }: Props & { scopeKey: string; scopeName: string; removedProject: boolean; onBusyChange: (busy: boolean) => void; onForgot: (scopeName: string) => void }) {
  const scope = usePreferenceLearningScope(scopeKey);
  const hydrated = usePreferenceLearningHydrated();
  const job = usePreferenceLearningJob(scopeKey);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [historyPending, setHistoryPending] = useState(false);
  const lastRequestedHistoryRun = useRef<string | undefined>(undefined);
  const [draft, setDraft] = useState<{ markdown: string; revision: number; baseMarkdown: string } | null>(null);
  const [recoverable, setRecoverable] = useState<{ markdown: string; revision: number } | null>(null);
  const mounted = useRef(true);
  const writing = useRef(false);
  useEffect(() => {
    mounted.current = true;
    void loadPreferenceLearning().catch(() => {
      if (mounted.current) setError("Could not load learned preferences. Reopen Settings to retry.");
    });
    return () => { mounted.current = false; onBusyChange(false); };
  }, [onBusyChange]);
  useEffect(() => {
    // Request accounting and provider settings advance the CAS revision without
    // editing the document. Keep an authored draft against that newer revision
    // only while its original saved text remains unchanged.
    setDraft((current) => current && scope.revision > current.revision && current.baseMarkdown === scope.markdown
      ? { ...current, revision: scope.revision } : current);
  }, [scope.markdown, scope.revision]);

  const catalog = modelCatalogs[scope.provider] ?? [];
  const luna = resolvePreferenceLearningModel("openai", "", modelCatalogs);
  const options: AppSelectOption[] = [
    ...(scope.provider === "openai" ? [{ value: "", label: "Automatic · latest GPT-6 Luna", detail: luna ?? "Unavailable until the live catalog includes GPT-6 Luna" }] : []),
    ...catalog.map((entry) => ({ value: entry.id, label: entry.label, detail: entry.detail ?? entry.id, keywords: entry.keywords })),
  ];
  const missingModel = Boolean(scope.model && !catalog.some((entry) => entry.id === scope.model));
  const usableModel = Boolean(scope.model || (scope.provider === "openai" && luna));
  const processing = job.status === "running" || job.status === "queued";
  const selectedHistory = historyProgress?.scopeKey === scopeKey ? historyProgress : null;
  // Hide a prior result as soon as a new request starts, before its first
  // progress snapshot arrives. Run identity also keeps its final save distinct.
  const history = historyPending && selectedHistory?.runId === lastRequestedHistoryRun.current ? null : selectedHistory;
  const historyWorking = Boolean(history && ["reading", "queued", "analyzing", "saving"].includes(history.status)) || (historyPending && !history);
  const historyActiveElsewhere = Boolean(historyProgress && historyProgress.scopeKey !== scopeKey && ["reading", "queued", "analyzing", "saving"].includes(historyProgress.status));
  const historySaving = history?.status === "saving";
  const historyFinished = Boolean(history && (history.status === "complete" || history.status === "partial"));
  const historyOwnsJob = Boolean(history && job.historyRunId === history.runId);
  const analysisProvider = history?.provider ?? scope.provider;
  const analysisModel = history?.model ?? resolvePreferenceLearningModel(scope.provider, scope.model, modelCatalogs);
  const historyPhase = history?.status === "queued" ? "Waiting for preference analysis…"
    : history?.status === "analyzing" ? `Analyzing recent conversations with ${providerDisplayName(analysisProvider)}${analysisModel ? ` · ${analysisModel}` : ""}…`
      : history?.status === "saving" ? "Saving learned preferences…" : "Reading recent conversations…";
  const completion = history?.superseded ? "Learning saved — review latest preferences"
    : history?.changed ? "Learning complete — preferences updated"
    : history?.messages === 0 ? "Learning complete — no eligible authored messages"
      : "Learning complete — no changes needed";
  const markdown = draft?.markdown ?? scope.markdown;
  const conflict = draft !== null && draft.revision !== scope.revision;
  const dirty = draft !== null && markdown !== scope.markdown;
  // Progressive disclosure: the document appears once there is something to
  // review or edit; a scope that has never learned anything needs only its
  // switch, account and model.
  const showDocument = scope.enabled || Boolean(scope.markdown) || draft !== null || recoverable !== null || removedProject;
  const historyActive = historyWorking || Boolean(history);
  const [historyOpen, setHistoryOpen] = useState(historyActive);
  useEffect(() => { if (historyActive) setHistoryOpen(true); }, [historyActive]);

  const run = async (action: () => Promise<unknown>, message?: string) => {
    if (writing.current || !hydrated) return;
    writing.current = true;
    setBusy(true);
    onBusyChange(true);
    setError("");
    try {
      await action();
      if (mounted.current && message) onChanged?.(message);
    } catch (failure) {
      if (mounted.current) setError(settingsError(failure));
    } finally {
      writing.current = false;
      if (mounted.current) { setBusy(false); onBusyChange(false); }
    }
  };

  const clear = () => run(async () => {
    const confirmed = await confirmDialog(`Clear the learned preferences for ${scopeName}?\n\nAuthored prompts and conversations are preserved. You can undo this clear while this panel remains open.`, { confirmLabel: "Clear preferences" });
    if (!confirmed || !mounted.current) return;
    const previous = scope.markdown;
    const cleared = await clearPreferenceLearning(scopeKey, scope.revision);
    if (mounted.current) {
      setRecoverable({ markdown: previous, revision: cleared.revision });
      setDraft(null);
      onChanged?.(`Learned preferences cleared for ${scopeName}.`);
    }
  });

  const learnHistory = async () => {
    if (removedProject || !onLearnPastConversations || historyWorking || historyActiveElsewhere || processing) return;
    lastRequestedHistoryRun.current = selectedHistory?.runId;
    setHistoryPending(true);
    setError("");
    try { await onLearnPastConversations(scopeKey); }
    catch (failure) { if (mounted.current) setError(settingsError(failure)); }
    finally { if (mounted.current) setHistoryPending(false); }
  };

  const historyStatus = <div className="preference-learning-history-progress" aria-live="polite">
    {!historyWorking && !history && <p className="preference-learning-history-state">{historyActiveElsewhere ? "Another history analysis is running. Select that scope to view its progress." : removedProject ? "History analysis is unavailable for this removed project." : scope.enabled ? "Ready to analyze recent conversations." : "Enable this scope to analyze recent conversations."}</p>}
    {historyWorking && <p className="preference-learning-history-state" data-history-status={history?.status ?? "reading"}><PixelWorkingMark /><span>{historyPhase}</span></p>}
    {historyWorking && <p>{providerDisplayName(analysisProvider)} · {analysisModel ?? "No available learning model"}</p>}
    {historyFinished && <p className="preference-learning-history-state complete" data-history-status={history?.status}><Check size={16} aria-hidden="true" /><span>{completion}</span></p>}
    {historyFinished && <p className="preference-learning-history-coverage">This bounded history pass does not cover all history.</p>}
    {history?.status === "cancelled" && <p className="preference-learning-history-state" data-history-status="cancelled">Preference learning cancelled.</p>}
    {history && <>
      <p>{historyCount(history.threads, "conversation attempt")} · {historyCount(history.pages, "page attempt")} · {historyCount(history.messages, "authored message")} · {historyCount(history.skipped, "skipped item")}{history.limited ? " · Limited to a bounded selection of recent history" : ""}</p>
      {history.message && !historyWorking && (!historyFinished || history.superseded) && <p role={history.status === "error" ? "alert" : undefined}>{history.message}</p>}
    </>}
  </div>;

  return <div className="set-card">
    <fieldset className="preference-learning-controls" disabled={busy || !hydrated} aria-busy={busy}>
      <div className="preference-learning-disclosure" role="note">
        {removedProject && <p>This project is no longer in your project list. Automatic learning and history analysis are unavailable. You can review its saved preferences or forget them.</p>}
        <div className="preference-learning-consent"><strong>{providerDisplayName(scope.provider)} receives conversation content from this scope</strong> and it uses your quota or credits.{" "}
          <InfoPopover className="preference-learning-inline-info" triggerClassName="preference-learning-info compact" label="What learning sends" trigger={<><Info size={12} aria-hidden="true" /><span>Details</span></>}>
            <p className="preference-learning-info-message">Learning sends selected conversation messages and your existing learned preferences to the chosen provider, using your account&rsquo;s quota or API credits. App scope includes chats across projects; project scope includes only that project&rsquo;s chats. Learning is off by default and starts with new completed conversations. Past conversations are included only when you choose to analyze them.</p>
          </InfoPopover>
        </div>
      </div>
      <fieldset className="preference-learning-controls" disabled={removedProject}>
      <div className="set-row">
        <div className="set-copy"><strong>Automatically learn preferences</strong><small>Changes are saved immediately, independently of Save settings.</small></div>
        <div className="set-control"><button type="button" role="switch" aria-label="Automatically learn preferences" aria-checked={scope.enabled} className={`toggle-switch ${scope.enabled ? "on" : ""}`} disabled={!scope.enabled && !usableModel} onClick={() => void run(() => configurePreferenceLearning(scopeKey, { enabled: !scope.enabled }), `Preference learning ${scope.enabled ? "disabled" : "enabled"} for ${scopeName}.`)}><span /></button></div>
      </div>
      <div className="set-row">
        <div className="set-copy"><strong>Learning provider</strong><small>The account used to learn preferences.</small></div>
        <div className="set-control"><AppSelectMenu ariaLabel="Preference learning provider" value={scope.provider} options={PROVIDERS.map((provider) => ({ value: provider, label: providerDisplayName(provider) }))} portal onChange={(provider) => void run(() => configurePreferenceLearning(scopeKey, { provider: provider as Provider, model: "", enabled: false }))} /></div>
      </div>
      <div className="set-row">
        <div className="set-copy"><strong>Learning model</strong><small>{missingModel ? "The saved model is absent from this live catalog; its exact ID is preserved." : scope.provider === "openai" ? "Automatic follows the newest available GPT-6 Luna." : "Choose from this provider's live catalog."}</small></div>
        <div className="set-control"><AppSelectMenu ariaLabel="Preference learning model" value={scope.model} options={options} portal selectedDisplay={missingModel ? { label: scope.model, detail: "Saved model · not in current catalog" } : undefined} placeholder={scope.provider === "openai" ? "Automatic · latest GPT-6 Luna" : "Choose a model"} searchable={options.length > 8} emptyMessage="No live models available. Refresh this provider's catalog in Models & accounts." onChange={(model) => void run(() => configurePreferenceLearning(scopeKey, { model }))} /></div>
      </div>
      {!usableModel && <p className="preference-learning-unavailable" role="status">{scope.provider === "openai" ? "Automatic learning is waiting for GPT-6 Luna in the live model catalog. Choose an available model or refresh Models & accounts." : "Choose a learning model before enabling."}</p>}
      </fieldset>
      {showDocument && <div className="set-row stack">
        <div className="set-copy"><strong>Learned instructions</strong><small>Added as a separate system prompt layer. Your global, provider, project, and profile prompts stay as you wrote them. Disabling this scope stops learning and applying its layer.</small></div>
        <div className="set-control"><textarea aria-label={`Learned instructions for ${scopeName}`} className="prompt-editor preference-learning-editor" rows={7} maxLength={PREFERENCE_LEARNING_LIMITS.documentChars} value={markdown} placeholder="No learned preferences yet" onChange={(event) => setDraft({ markdown: event.target.value, revision: draft?.revision ?? scope.revision, baseMarkdown: draft?.baseMarkdown ?? scope.markdown })} /></div>
        {conflict && <p role="status">Preferences changed while you were editing. Copy your draft if needed, then load the latest preferences before saving.</p>}
        <div className="preference-learning-actions">
          <button type="button" className="secondary-button" disabled={!dirty || conflict} onClick={() => void run(async () => { await editPreferenceLearning(scopeKey, markdown, draft?.revision ?? scope.revision); if (mounted.current) setDraft(null); }, `Learned preferences updated for ${scopeName}.`)}>Save learned instructions</button>
          {draft && <button type="button" className="secondary-button" onClick={() => setDraft(null)}>{conflict ? "Load latest preferences" : "Discard edits"}</button>}
          <button type="button" className="secondary-button" disabled={!scope.markdown} onClick={() => void clear()}>Clear learned preferences</button>
          {recoverable !== null && <button type="button" className="secondary-button" disabled={recoverable.revision !== scope.revision} onClick={() => void run(async () => { await editPreferenceLearning(scopeKey, recoverable.markdown, recoverable.revision); if (mounted.current) { setRecoverable(null); setDraft(null); } }, `Learned preferences restored for ${scopeName}.`)}>Undo clear</button>}
          {removedProject && <button type="button" className="secondary-button" onClick={() => void run(async () => {
            const confirmed = await confirmDialog(`Forget the saved preferences for ${scopeName}?\n\nThis removes only this project's learned preferences and learning metadata. Conversations and authored prompts are preserved. This cannot be undone.`, { confirmLabel: "Forget preferences" });
            if (!confirmed || !mounted.current) return;
            await forgetPreferenceLearning(scopeKey, scope.revision);
            onForgot(scopeName);
          })}>Forget removed project preferences</button>}
        </div>
      </div>}
    </fieldset>
      {onLearnPastConversations && <details className="set-body preference-learning-history" open={historyOpen} onToggle={(event) => setHistoryOpen(event.currentTarget.open)}>
        <summary>Learn from past conversations</summary>
        <p>Analyze a bounded selection of recent conversations in this scope: up to eight chats and three pages per chat in one pass, not all history. The chosen provider receives those older messages, using additional quota or credits. Older conversations may contain unmarked automated input, so review what is learned.</p>
        {historyStatus}
        <div className="preference-learning-actions">
          <button type="button" className="secondary-button" disabled={busy || !hydrated || removedProject || !scope.enabled || !usableModel || processing || historyWorking || historyActiveElsewhere} onClick={() => void learnHistory()}>Analyze recent past conversations</button>
          {historyWorking && onCancelLearning && <button type="button" className="secondary-button" disabled={historySaving} onClick={() => onCancelLearning(scopeKey)}>{historySaving ? "Finishing save…" : "Cancel preference learning"}</button>}
        </div>
      </details>}
    <div className="set-body preference-learning-status" aria-live="polite">
      {!hydrated && !error && <p>Loading learned preferences…</p>}
      {busy && <p>Saving…</p>}
      {processing && !historyWorking && onCancelLearning && <button type="button" className="secondary-button" disabled={job.saving} onClick={() => onCancelLearning(scopeKey)}>{job.saving ? "Finishing save…" : "Cancel preference learning"}</button>}
      {!onLearnPastConversations && history && historyStatus}
      {processing && !historyWorking && !historyOwnsJob && <p>{job.status === "queued" ? "Preference learning queued…" : "Learning preferences…"}</p>}
      {job.message && job.status !== "error" && !historyWorking && !historyOwnsJob && <p>{job.message}</p>}
      {Boolean(scope.updatedAt) && <p>Last updated {new Date(scope.updatedAt).toLocaleString()}.</p>}
      {(error || (job.status === "error" && !historyOwnsJob)) && <p role="alert">{error || job.message || "Preference learning failed. Your existing preferences were preserved."}</p>}
    </div>
  </div>;
}
