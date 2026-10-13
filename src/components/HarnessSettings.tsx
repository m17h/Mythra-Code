import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { Bot, Check, ChevronDown, Eye, Info, MessageSquare, NotebookPen, Play, Plus, RotateCcw, Save, Trash2, Workflow, Wrench } from "lucide-react";
import type { AppSettings, CustomAgentProfile, Project, ProjectAction, PromptProfile, Provider, ScheduledTask, ScheduleRunRecord, ScheduleIntervalUnit, ScheduleThreadMode } from "../types";
import { rpc } from "../lib/codex";
import { confirmDialog } from "../lib/confirmDialog";
import { friendlyError } from "../lib/errors";
import { scheduleRunSnapshot } from "../lib/turnConfig";
import { scheduleIntervalLabel, scheduleIntervalMinutes } from "../lib/schedules";
import { providerDisplayName } from "../lib/childAgents";
import { DEFAULT_OPENAI_MODEL } from "../lib/appConfig";
import { applyPromptProfile, copyGlobalInstructionProfile, globalInstructionProfiles, instructionFileStatusLabel, promptProfileIsSelected, type InstructionFileDescriptor } from "../lib/instructionFiles";
import type { LocalSkill } from "../lib/skills";
import type { WorkflowDefinition, WorkflowRunRecord } from "../lib/workflows";
import { workflowFromSchedule } from "../lib/workflows";
import { WorkflowManager } from "./WorkflowManager";
import { AppSelectMenu, type AppSelectOption } from "./AppSelectMenu";
import { ProviderLogo } from "./BrandLogos";
import { GlobalInstructionFileEditor, retainedGlobalInstructionEditorFiles, type GlobalInstructionEditorState } from "./GlobalInstructionFileEditor";
import type { ChildAgentModelOption } from "./ChildAgentRoster";

export interface McpServerView { name: string; status: string; tools: number }

const SCHEDULE_PROVIDERS: Provider[] = ["openai", "openrouter", "lmstudio"];
const EMPTY_GLOBAL_INSTRUCTION_FILES: InstructionFileDescriptor[] = [];
const SCHEDULE_CHAT_TARGET = "__mythra_normal_chats__";
const SCHEDULE_INTERVAL_UNITS: AppSelectOption[] = [
  { value: "minutes", label: "Minutes" },
  { value: "hours", label: "Hours" },
  { value: "days", label: "Days" },
];
const SCHEDULE_THREAD_MODES: AppSelectOption[] = [
  { value: "new", label: "New thread each time", detail: "Keep every run separate", icon: <Plus size={13} /> },
  { value: "reuse", label: "Continue the same thread", detail: "Build on the previous run", icon: <MessageSquare size={13} /> },
];

function scheduleModelOptions(
  provider: Provider,
  selectedModel: string,
  catalogs?: Partial<Record<Provider, ChildAgentModelOption[]>>,
): AppSelectOption[] {
  const options: AppSelectOption[] = (catalogs?.[provider] ?? []).map((model) => ({
    value: model.id,
    label: model.label,
    detail: model.detail,
    keywords: model.keywords,
    icon: <ProviderLogo provider={provider} size={15} />,
  }));
  if (selectedModel && !options.some((option) => option.value === selectedModel)) {
    options.unshift({
      value: selectedModel,
      label: selectedModel,
      detail: "Current selection",
      icon: <ProviderLogo provider={provider} size={15} />,
    });
  }
  return options;
}

function initialScheduleRun(
  settings: AppSettings,
  catalogs?: Partial<Record<Provider, ChildAgentModelOption[]>>,
) {
  const provider = SCHEDULE_PROVIDERS.includes(settings.provider) ? settings.provider : "openai";
  const model = provider === settings.provider
    ? settings.model
    : (catalogs?.[provider]?.[0]?.id ?? DEFAULT_OPENAI_MODEL);
  return scheduleRunSnapshot({ ...settings, provider, model });
}

export function HarnessSettings({ section, visible = true, settings, profiles, globalInstructionFiles = EMPTY_GLOBAL_INSTRUCTION_FILES, globalInstructionDiscoveryBusy = false, globalInstructionDiscoveryError = "", onRefreshGlobalInstructionFiles, onGlobalInstructionFileSaved, agents, actions, schedules, workflows, workflowRuns, projects, skills, modelCatalogs, onDiscoverOpenRouterModels, onSettings, onProfiles, onAgents, onActions, onSchedules, onWorkflows, onRunWorkflow, onStopWorkflow, mcpServers = [], onMcpChanged, scheduleRuns = [], onOpenRun }: {
  section: "prompts" | "agents" | "workflows" | "scheduled-tasks" | "tools";
  visible?: boolean;
  settings: AppSettings;
  profiles: PromptProfile[];
  globalInstructionFiles?: InstructionFileDescriptor[];
  globalInstructionDiscoveryBusy?: boolean;
  globalInstructionDiscoveryError?: string;
  onRefreshGlobalInstructionFiles?: () => Promise<void> | void;
  onGlobalInstructionFileSaved?: (file: InstructionFileDescriptor) => void;
  agents: CustomAgentProfile[];
  actions: ProjectAction[];
  schedules: ScheduledTask[];
  workflows: WorkflowDefinition[];
  workflowRuns: WorkflowRunRecord[];
  projects: Project[];
  skills: LocalSkill[];
  modelCatalogs?: Partial<Record<Provider, ChildAgentModelOption[]>>;
  onDiscoverOpenRouterModels?: (query: string) => void;
  onSettings: (value: AppSettings | ((current: AppSettings) => AppSettings)) => void;
  onProfiles: (value: PromptProfile[] | ((current: PromptProfile[]) => PromptProfile[])) => void;
  onAgents: (value: CustomAgentProfile[]) => void;
  onActions: (value: ProjectAction[]) => void;
  onSchedules: (value: ScheduledTask[]) => void;
  onWorkflows: (value: WorkflowDefinition[]) => void;
  onRunWorkflow: (workflowId: string, variables?: Record<string, string>, projectId?: string) => Promise<void> | void;
  onStopWorkflow: (workflowId: string) => Promise<boolean> | boolean;
  mcpServers?: McpServerView[];
  onMcpChanged?: () => void;
  scheduleRuns?: ScheduleRunRecord[];
  onOpenRun?: (threadId: string) => void;
}) {
  const [profileName, setProfileName] = useState("");
  const [previewProfileId, setPreviewProfileId] = useState<string | null>(null);
  const [savedFileProfileId, setSavedFileProfileId] = useState<string | null>(null);
  const instructionPreviewId = useId();
  const [retainedInstructionFiles, setRetainedInstructionFiles] = useState(() => {
    const files = new Map(retainedGlobalInstructionEditorFiles().map((file) => [`${file.provider}:${file.path}`, file]));
    for (const file of globalInstructionFiles) files.set(`${file.provider}:${file.path}`, file);
    return [...files.values()];
  });
  const [editorStates, setEditorStates] = useState<Record<string, GlobalInstructionEditorState>>({});
  useEffect(() => {
    // Keep owners of earlier paths mounted if override discovery changes the effective source.
    setRetainedInstructionFiles((current) => {
      const files = new Map(current.map((file) => [`${file.provider}:${file.path}`, file]));
      for (const file of globalInstructionFiles) files.set(`${file.provider}:${file.path}`, file);
      return [...files.values()];
    });
  }, [globalInstructionFiles]);
  const editorFiles = useMemo(() => {
    const files = new Map(retainedInstructionFiles.map((file) => [`${file.provider}:${file.path}`, file]));
    for (const file of globalInstructionFiles) files.set(`${file.provider}:${file.path}`, file);
    return [...files.values()];
  }, [globalInstructionFiles, retainedInstructionFiles]);
  const recordEditorState = useCallback((key: string, value: GlobalInstructionEditorState) => {
    setEditorStates((current) => {
      const previous = current[key];
      return previous?.dirty === value.dirty && previous.saving === value.saving && previous.failed === value.failed ? current : { ...current, [key]: value };
    });
  }, []);
  const discoveredProfiles = useMemo(() => globalInstructionProfiles(globalInstructionFiles), [globalInstructionFiles]);
  const cachedFileSnapshots = Boolean((globalInstructionDiscoveryError || globalInstructionDiscoveryBusy) && globalInstructionFiles.length);
  useEffect(() => {
    // Reopening Settings or returning to this pane requires a new preview action.
    if (!visible || section !== "prompts") {
      setPreviewProfileId(null);
      setSavedFileProfileId(null);
    }
  }, [section, visible]);
  const [agentName, setAgentName] = useState("");
  const [agentInstructions, setAgentInstructions] = useState("");
  const [actionName, setActionName] = useState("");
  const [actionCommand, setActionCommand] = useState("");
  const [scheduleName, setScheduleName] = useState("");
  const [schedulePrompt, setSchedulePrompt] = useState("");
  const [scheduleProject, setScheduleProject] = useState("");
  // Raw text while typing — clamping per keystroke makes values like 45
  // untypeable (the leading "4" snaps to 5). Clamped on blur and on submit.
  const [scheduleInterval, setScheduleInterval] = useState("60");
  const [scheduleIntervalUnit, setScheduleIntervalUnit] = useState<ScheduleIntervalUnit>("minutes");
  const [scheduleThreadMode, setScheduleThreadMode] = useState<ScheduleThreadMode>("new");
  const [scheduleRun, setScheduleRun] = useState(() => initialScheduleRun(settings, modelCatalogs));
  const [mcpName, setMcpName] = useState("");
  const [mcpCommand, setMcpCommand] = useState("");
  const [mcpStatus, setMcpStatus] = useState("");

  const saveProfile = () => {
    if (!profileName.trim()) return;
    const profile: PromptProfile = {
      id: crypto.randomUUID(),
      name: profileName.trim(),
      prompt: settings.systemPrompt,
      codexPrompt: settings.codexSystemPrompt,
      claudePrompt: settings.claudeSystemPrompt,
    };
    onProfiles((current) => [...current, profile]);
    onSettings((current) => ({ ...current, promptProfileId: profile.id }));
    setProfileName("");
  };

  const scheduleProviderOptions: AppSelectOption[] = SCHEDULE_PROVIDERS.map((provider) => ({
    value: provider,
    label: providerDisplayName(provider),
    detail: provider === "openai"
      ? "ChatGPT subscription"
      : provider === "openrouter"
        ? "OpenRouter account"
        : "Local LM Studio server",
    icon: <ProviderLogo provider={provider} size={15} />,
  }));
  const selectedScheduleModels = scheduleModelOptions(scheduleRun.provider, scheduleRun.model, modelCatalogs);
  const scheduleProjectOptions: AppSelectOption[] = [
    {
      value: SCHEDULE_CHAT_TARGET,
      label: "Chats",
      detail: "Normal chat — no project folder",
      icon: <MessageSquare size={14} />,
    },
    ...projects.map((project) => ({
      value: project.id,
      label: project.name,
      detail: project.path,
    })),
  ];

  return <>
    <section className="set-group global-instruction-presets" hidden={section !== "prompts"}>
      <div className="set-group-head">
        <h4>Global instruction file presets</h4>
        {onRefreshGlobalInstructionFiles && <button type="button" className="secondary-button" disabled={globalInstructionDiscoveryBusy} onClick={() => { void onRefreshGlobalInstructionFiles(); }}><RotateCcw size={12} /> {globalInstructionDiscoveryBusy ? "Refreshing…" : "Refresh files"}</button>}
      </div>
      <p>Your global Codex AGENTS.md and Claude CLAUDE.md are discovered automatically on this computer. Edit the original file here, or review a preset and choose it for that provider’s app-specific prompt layer. File edits and refresh do not change active prompts or saved copies.</p>
      <div className="prompt-file-notice" role="note"><Info size={16} /><p><strong>Review before use.</strong> These files may contain personal information or credentials. Discovery reads them locally; selecting a preset includes its instructions in future requests to its provider after you save Settings.</p></div>
      {globalInstructionDiscoveryError && <div className="instruction-discovery-error" role="alert">{globalInstructionDiscoveryError}{cachedFileSnapshots ? " The cards below are cached snapshots from the last successful discovery. Refresh files to refresh all preset cards before using a file preset." : ""}</div>}
      {globalInstructionDiscoveryBusy && globalInstructionFiles.length > 0 && <p className="instruction-file-status" role="status">Refreshing files. Showing the last discovery until refresh finishes.</p>}
      {!globalInstructionFiles.length && <div className="compact-note" role="status"><NotebookPen size={14} /><span><strong>{globalInstructionDiscoveryBusy ? "Discovering global instruction files…" : "No global instruction files available"}</strong><small>{globalInstructionDiscoveryBusy ? "Reading the configured local Codex and Claude folders." : "Refresh to discover your local AGENTS.md and CLAUDE.md."}</small></span></div>}
      <div className="instruction-file-grid">{editorFiles.map((file) => {
        const key = `${file.provider}:${file.path}`;
        const currentSource = globalInstructionFiles.some((current) => current.provider === file.provider && current.path === file.path);
        const editorState = editorStates[key];
        const editorPending = Boolean(editorState?.dirty || editorState?.saving || editorState?.failed);
        const profile = discoveredProfiles.find((item) => item.source?.path === file.path && item.source.provider === (file.provider === "codex" ? "openai" : "claude"));
        const providerLabel = file.provider === "codex" ? "Codex" : "Claude";
        const previewOpen = profile?.id === previewProfileId;
        const selected = Boolean(profile && promptProfileIsSelected(settings, profile));
        const previewId = `${instructionPreviewId}-${encodeURIComponent(`${file.provider}:${file.path}`)}`;
        return <div key={key} className={`instruction-file-card ${selected ? "selected" : ""}`} hidden={!currentSource && !editorPending}>
          <div className="instruction-file-heading"><ProviderLogo provider={file.provider === "codex" ? "openai" : "claude"} size={17} /><strong>{profile?.name ?? `Global ${providerLabel} ${file.path.split(/[\\/]/).pop() || file.name}`}</strong><span className="instruction-source-label">{!currentSource ? "Previous source · draft retained" : cachedFileSnapshots ? "Cached local snapshot" : "Local file"}</span></div>
          <code className="instruction-source-path">{file.path}</code>
          <p className="instruction-file-status">{cachedFileSnapshots ? "Last discovery: " : ""}{instructionFileStatusLabel(file)}{profile ? ` · ${file.content?.length ?? 0} characters · ${providerLabel} layer only` : ""}</p>
          {profile && <>
            <div className="instruction-file-actions">
              <button type="button" className="secondary-button" aria-expanded={previewOpen} aria-controls={previewId} onClick={() => setPreviewProfileId(previewOpen ? null : profile.id)}><Eye size={12} /> {previewOpen ? "Hide preview" : cachedFileSnapshots ? "Preview cached copy" : "Preview"}</button>
              <button type="button" className="secondary-button" disabled={cachedFileSnapshots || editorPending || !currentSource} aria-pressed={selected} onClick={() => onSettings((current) => applyPromptProfile(current, profile))}>{selected && <Check size={12} />} Use for {providerLabel}</button>
              <button type="button" className="secondary-button" disabled={editorPending} onClick={() => { const copy = copyGlobalInstructionProfile(profile); onProfiles((current) => [...current, copy]); setSavedFileProfileId(profile.id); }}><Save size={12} /> {savedFileProfileId === profile.id ? "Save another copy" : cachedFileSnapshots ? "Save cached copy" : "Save copy"}</button>
            </div>
            {savedFileProfileId === profile.id && <p className="instruction-file-status" role="status">Copy added to Prompt profiles below. Save Settings to keep it.</p>}
            {previewOpen && <div className="instruction-file-preview" id={previewId}><label>{cachedFileSnapshots ? "Cached instructions" : "Instructions"} from {file.path}<textarea aria-label={`${profile.name} preview`} value={file.content ?? ""} readOnly rows={8} spellCheck={false} /></label></div>}
          </>}
          <GlobalInstructionFileEditor
            file={file}
            visible={visible && section === "prompts" && (currentSource || editorPending)}
            currentSource={currentSource}
            onSaved={onGlobalInstructionFileSaved}
            onStateChange={(value) => recordEditorState(key, value)}
            onSaveDraftCopy={(content) => {
              const draftProfile = globalInstructionProfiles([{ ...file, content, status: "ready" }], true)[0];
              if (!draftProfile) return;
              const copy = { ...copyGlobalInstructionProfile(draftProfile), name: `Draft of ${draftProfile.name}` };
              onProfiles((current) => [...current, copy]);
              setSavedFileProfileId(profile?.id ?? draftProfile.id);
            }}
          />
        </div>;
      })}</div>
    </section>
    {section === "prompts" &&
    <section className="set-group">
      <h4>Prompt profiles</h4>
      <p>Save and switch complete global, Codex, and Claude prompt sets. Copies of instruction file presets keep their source path and apply only to their provider. To edit a copy, use it, edit its prompt layer above, then save a new profile.</p>
      {profiles.length ? (
        <div className="profile-grid">{profiles.map((profile) => {
          const characters = profile.prompt.length + (profile.codexPrompt?.length ?? 0) + (profile.claudePrompt?.length ?? 0);
          const selected = promptProfileIsSelected(settings, profile);
          const previewId = `${instructionPreviewId}-saved-${encodeURIComponent(profile.id)}`;
          return <div key={profile.id} className={`profile-card ${selected ? "selected" : ""}`}>
            <button type="button" className="profile-apply" aria-pressed={selected} onClick={() => onSettings((current) => applyPromptProfile(current, profile))}>
              <span><strong className="instruction-profile-title">{profile.source && <ProviderLogo provider={profile.source.provider} size={15} />}{profile.name}</strong><small>{profile.source ? `Saved file copy · ${profile.source.provider === "openai" ? "Codex" : "Claude"} layer only` : characters ? `${characters} characters across all layers` : "Empty prompt set"}</small>{profile.source && <small title={profile.source.path}>{profile.source.path}</small>}</span>
              {selected && <Check size={13} />}
            </button>
            <button className="profile-delete" aria-label={`Delete ${profile.name}`} onClick={async () => {
              if (!await confirmDialog(`Delete the prompt profile “${profile.name}”?`)) return;
              onProfiles((current) => current.filter((item) => item.id !== profile.id));
              onSettings((current) => current.promptProfileId === profile.id ? { ...current, promptProfileId: "" } : current);
            }}><Trash2 size={12} /></button>
            {profile.source && <div className="saved-instruction-preview">
              <button type="button" className="secondary-button" aria-expanded={previewProfileId === profile.id} aria-controls={previewId} onClick={() => setPreviewProfileId(previewProfileId === profile.id ? null : profile.id)}><Eye size={12} /> {previewProfileId === profile.id ? "Hide saved preview" : "Preview saved copy"}</button>
              {previewProfileId === profile.id && <div className="instruction-file-preview" id={previewId}><label>Saved instructions from {profile.source.path}<textarea aria-label={`${profile.name} saved preview`} value={(profile.source.provider === "openai" ? profile.codexPrompt : profile.claudePrompt) ?? ""} readOnly rows={8} spellCheck={false} /></label></div>}
            </div>}
          </div>;
        })}</div>
      ) : <div className="compact-note"><NotebookPen size={14} /><span><strong>No prompt profiles yet</strong><small>Configure the prompt layers above, then save your first custom profile.</small></span></div>}
      <div className="inline-create"><input aria-label="New prompt profile name" value={profileName} onChange={(event) => setProfileName(event.target.value)} placeholder="Profile name" /><button type="button" onClick={saveProfile} disabled={!profileName.trim()}><Save size={12} /> Save current prompts</button></div>
    </section>}

    {section === "agents" && <div className="set-group">
    <h4>Custom agents</h4>
    <details className="custom-agent-settings">
      <summary className="custom-agent-summary">
        <span className="custom-agent-mark"><Bot size={16} /></span>
        <span><strong>Custom agent profiles</strong><small>Optional specialist instructions that can be exposed alongside your sub-agent presets.</small></span>
        <ChevronDown size={15} aria-hidden="true" />
      </summary>
      <div className="custom-agent-content">
        <div className="manager-list">{agents.map((agent) => <div key={agent.id}><button className={`mini-toggle ${agent.enabled ? "on" : ""}`} aria-label={`${agent.enabled ? "Disable" : "Enable"} ${agent.name}`} aria-pressed={agent.enabled} onClick={() => onAgents(agents.map((item) => item.id === agent.id ? { ...item, enabled: !item.enabled } : item))}><span /></button><span><strong>{agent.name}</strong><small>{agent.instructions}</small></span><button className="manager-delete" aria-label={`Delete ${agent.name}`} onClick={async () => { if (await confirmDialog(`Delete the custom agent “${agent.name}” and its instructions? This cannot be undone.`)) onAgents(agents.filter((item) => item.id !== agent.id)); }}><Trash2 size={12} /></button></div>)}</div>
        <div className="stacked-create"><input value={agentName} onChange={(event) => setAgentName(event.target.value)} placeholder="Agent name (for example: reviewer)" /><textarea value={agentInstructions} onChange={(event) => setAgentInstructions(event.target.value)} placeholder="Specialist instructions" rows={3} /><button onClick={() => { if (!agentName.trim() || !agentInstructions.trim()) return; onAgents([...agents, { id: crypto.randomUUID(), name: agentName.trim(), description: agentInstructions.trim().slice(0, 90), instructions: agentInstructions.trim(), enabled: true }]); setAgentName(""); setAgentInstructions(""); }} disabled={!agentName.trim() || !agentInstructions.trim()}><Plus size={12} /> Add custom agent</button></div>
      </div>
    </details>
    </div>}

    {section === "workflows" && <>
    <WorkflowManager
      workflows={workflows}
      runs={workflowRuns}
      projects={projects}
      skills={skills}
      settings={settings}
      onWorkflows={onWorkflows}
      onRun={onRunWorkflow}
      onStop={onStopWorkflow}
      onOpenRun={onOpenRun}
    />

    <section className="set-group">
      <h4>Quick project actions</h4>
      <p>Keep lightweight one-click commands for the Workspace panel. Use an agent workflow when you need multiple ordered steps, triggers, skills, or run history.</p>
      <div className="manager-list">{actions.map((action) => <div key={action.id}><Play size={12} /><span><strong>{action.name}</strong><small>{action.command}</small></span><button className="manager-delete" aria-label={`Delete ${action.name}`} onClick={async () => { if (await confirmDialog(`Delete the project action “${action.name}”?`)) onActions(actions.filter((item) => item.id !== action.id)); }}><Trash2 size={12} /></button></div>)}</div>
      <div className="inline-create two"><input value={actionName} onChange={(event) => setActionName(event.target.value)} placeholder="Action name" /><input value={actionCommand} onChange={(event) => setActionCommand(event.target.value)} placeholder="Command" /><button onClick={() => { if (!actionName.trim() || !actionCommand.trim()) return; onActions([...actions, { id: crypto.randomUUID(), name: actionName.trim(), command: actionCommand.trim() }]); setActionName(""); setActionCommand(""); }}><Plus size={12} /> Add</button></div>
    </section>
    </>}

    {section === "scheduled-tasks" &&
    <section className="set-group">
      <h4>Simple scheduled prompts</h4>
      <p>Run one prompt on a timer in a chat or a project. When you convert a schedule into a workflow, the original is paused so the same task cannot run twice.</p>
      <div className="manager-list scheduled-workflow-list">{schedules.map((schedule) => {
        const run = schedule.run ?? scheduleRunSnapshot(settings);
        return <div key={schedule.id}><button className={`mini-toggle ${schedule.enabled ? "on" : ""}`} aria-label={`${schedule.enabled ? "Disable" : "Enable"} ${schedule.name}`} aria-pressed={schedule.enabled} onClick={() => onSchedules(schedules.map((item) => item.id === schedule.id ? { ...item, enabled: !item.enabled, nextRunAt: Date.now() + item.intervalMinutes * 60_000 } : item))}><span /></button><span><strong>{schedule.name}</strong><small>{scheduleIntervalLabel(schedule)} · {schedule.projectId === null ? "Chats" : projects.find((project) => project.id === schedule.projectId)?.name ?? "Missing project"}</small><small>{providerDisplayName(run.provider)} · {run.model || "Default model"} · {schedule.threadMode === "reuse" ? "same thread" : "new thread each run"}</small></span><span className="manager-row-actions"><button title={schedule.projectId ? `Convert ${schedule.name} to an agent workflow` : "Normal-chat schedules cannot be converted to project workflows"} aria-label={`Convert ${schedule.name} to workflow`} disabled={!schedule.projectId} onClick={() => onWorkflows([workflowFromSchedule(schedule, scheduleRunSnapshot(settings)), ...workflows])}><Workflow size={11} /></button><button className="manager-delete" aria-label={`Delete ${schedule.name}`} onClick={async () => { if (await confirmDialog(`Delete the scheduled task “${schedule.name}”? It will stop running.`)) onSchedules(schedules.filter((item) => item.id !== schedule.id)); }}><Trash2 size={12} /></button></span></div>;
      })}</div>
      {scheduleRuns.length > 0 && (
        <>
          <h3 className="panel-label">Recent runs</h3>
          <div className="schedule-run-list">
            {scheduleRuns.slice(0, 10).map((run) => (
              <div key={run.id} className={run.status === "failed" ? "failed" : ""}>
                <span className={`status-orb ${run.status === "failed" ? "failed" : "ready"}`} />
                <span className="schedule-run-copy">
                  <strong>{run.scheduleName}</strong>
                  <small>{new Date(run.at).toLocaleString()}{run.status === "failed" ? ` · ${run.error ?? "failed"}` : ""}</small>
                </span>
                {run.threadId && onOpenRun && (
                  <button onClick={() => onOpenRun(run.threadId!)} title="Open this run’s thread" aria-label={`Open run thread for ${run.scheduleName}`}><Play size={11} /> Open</button>
                )}
              </div>
            ))}
          </div>
        </>
      )}
      <div className="schedule-create">
        <div className="schedule-create-grid">
          <label><span>Task name</span><input aria-label="Schedule name" value={scheduleName} onChange={(event) => setScheduleName(event.target.value)} placeholder="Daily code review" /></label>
          <div className="schedule-field"><span>Run in</span><AppSelectMenu value={scheduleProject} options={scheduleProjectOptions} ariaLabel="Schedule location" placeholder="Choose Chats or a project…" menuPlacement="top" onChange={setScheduleProject} /></div>
          <div className="schedule-field schedule-interval-control"><span>Run every</span><div className="schedule-interval-inputs"><input type="number" min={scheduleIntervalUnit === "minutes" ? 5 : 1} aria-label="Schedule interval" value={scheduleInterval} onChange={(event) => setScheduleInterval(event.target.value)} onBlur={(event) => { const minimum = scheduleIntervalUnit === "minutes" ? 5 : 1; setScheduleInterval(String(Math.max(minimum, Math.floor(Number(event.target.value)) || minimum))); }} /><AppSelectMenu value={scheduleIntervalUnit} options={SCHEDULE_INTERVAL_UNITS} ariaLabel="Schedule interval unit" menuPlacement="top" onChange={(value) => { const unit = value as ScheduleIntervalUnit; setScheduleIntervalUnit(unit); const minimum = unit === "minutes" ? 5 : 1; setScheduleInterval((current) => String(Math.max(minimum, Math.floor(Number(current)) || minimum))); }} /></div></div>
          <div className="schedule-field"><span>Provider</span><AppSelectMenu value={scheduleRun.provider} options={scheduleProviderOptions} ariaLabel="Schedule provider" menuPlacement="top" onChange={(value) => { const provider = value as Provider; const model = modelCatalogs?.[provider]?.[0]?.id ?? (provider === "openai" ? DEFAULT_OPENAI_MODEL : ""); setScheduleRun(scheduleRunSnapshot({ ...settings, provider, model })); }} /></div>
          <div className="schedule-field schedule-model-control"><span>Model</span><AppSelectMenu value={scheduleRun.model} options={selectedScheduleModels} ariaLabel="Schedule model" placeholder="Choose model…" searchable={scheduleRun.provider === "openrouter" || selectedScheduleModels.length > 8} menuPlacement="top" emptyMessage={scheduleRun.provider === "lmstudio" ? "No LM Studio models available" : "No models available"} onSearch={scheduleRun.provider === "openrouter" ? onDiscoverOpenRouterModels : undefined} onChange={(model) => setScheduleRun({ ...scheduleRun, model })} /></div>
          <div className="schedule-field"><span>Each trigger</span><AppSelectMenu value={scheduleThreadMode} options={SCHEDULE_THREAD_MODES} ariaLabel="Schedule thread behavior" menuPlacement="top" onChange={(value) => setScheduleThreadMode(value as ScheduleThreadMode)} /></div>
        </div>
        <label className="schedule-prompt-control"><span>Prompt to run</span><textarea aria-label="Schedule prompt" value={schedulePrompt} onChange={(event) => setSchedulePrompt(event.target.value)} placeholder="Describe the unattended task" rows={3} /></label>
        <p className="schedule-runtime-note"><Bot size={12} /> Runs unattended with {providerDisplayName(scheduleRun.provider)} · {scheduleRun.model || "choose a model"}. Approval requests are disabled for scheduled runs.</p>
        <button onClick={() => {
          if (!scheduleName.trim() || !schedulePrompt.trim() || !scheduleProject || !scheduleRun.model.trim()) return;
          const minimum = scheduleIntervalUnit === "minutes" ? 5 : 1;
          const intervalValue = Math.max(minimum, Math.floor(Number(scheduleInterval)) || minimum);
          const intervalMinutes = scheduleIntervalMinutes(intervalValue, scheduleIntervalUnit);
          onSchedules([...schedules, {
            id: crypto.randomUUID(),
            name: scheduleName.trim(),
            prompt: schedulePrompt.trim(),
            projectId: scheduleProject === SCHEDULE_CHAT_TARGET ? null : scheduleProject,
            intervalValue,
            intervalUnit: scheduleIntervalUnit,
            intervalMinutes,
            threadMode: scheduleThreadMode,
            enabled: true,
            nextRunAt: Date.now() + intervalMinutes * 60_000,
            run: scheduleRun,
          }]);
          setScheduleName("");
          setSchedulePrompt("");
        }} disabled={!scheduleName.trim() || !schedulePrompt.trim() || !scheduleProject || !scheduleRun.model.trim()}><Plus size={12} /> Add schedule</button>
      </div>
    </section>
    }

    {section === "tools" &&
    <section className="set-group">
      <h4>MCP servers</h4>
      <p>Add a local stdio MCP server. Its command is written to Mythra Code’s isolated Codex configuration.</p>
      {mcpServers.length > 0 && (
        <div className="manager-list">
          {mcpServers.map((server) => (
            <div key={server.name}>
              <Wrench size={12} />
              <span><strong>{server.name}</strong><small>{server.status} · {server.tools} tool{server.tools === 1 ? "" : "s"}</small></span>
              <button
                className="manager-delete"
                aria-label={`Remove MCP server ${server.name}`}
                onClick={async () => {
                  if (!await confirmDialog(`Remove the MCP server “${server.name}” from Mythra Code’s configuration?`)) return;
                  setMcpStatus("Removing…");
                  void rpc("config/value/write", { keyPath: `mcp_servers.${server.name}`, value: null, mergeStrategy: "replace" })
                    .catch(() => rpc("config/value/delete", { keyPath: `mcp_servers.${server.name}` }))
                    .then(() => rpc("config/mcpServer/reload"))
                    .then(() => {
                      setMcpStatus(`Removed ${server.name}.`);
                      onMcpChanged?.();
                    })
                    .catch((reason) => setMcpStatus(friendlyError(reason)));
                }}
              >
                <Trash2 size={12} />
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="inline-create two"><input value={mcpName} onChange={(event) => setMcpName(event.target.value)} placeholder="Server name" /><input value={mcpCommand} onChange={(event) => setMcpCommand(event.target.value)} placeholder="Command, for example: npx -y package" /><button disabled={!mcpName.trim() || !mcpCommand.trim()} onClick={() => { const parts = mcpCommand.trim().split(/\s+/); setMcpStatus("Saving…"); void rpc("config/value/write", { keyPath: `mcp_servers.${mcpName.trim().replace(/[^a-zA-Z0-9_-]/g, "-")}`, value: { command: parts[0], args: parts.slice(1) }, mergeStrategy: "upsert" }).then(() => rpc("config/mcpServer/reload")).then(() => { setMcpStatus("Connected. Open Workspace tools → Tools to inspect it."); setMcpName(""); setMcpCommand(""); onMcpChanged?.(); }).catch((reason) => setMcpStatus(friendlyError(reason))); }}><Plus size={12} /> Add</button></div>
      {mcpStatus && <div className="manager-status">{mcpStatus}</div>}
    </section>}
  </>;
}
