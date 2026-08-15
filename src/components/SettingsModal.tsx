import { useEffect, useRef, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  Boxes,
  Check,
  ChevronRight,
  Download,
  ExternalLink,
  FolderCog,
  Gauge,
  GitFork,
  Info,
  KeyRound,
  LoaderCircle,
  Minus,
  NotebookPen,
  Palette,
  PanelRight,
  Play,
  Plus,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  UsersRound,
  Wrench,
  X,
} from "lucide-react";
import { exportDiagnostics, recentAuditRows, rpc, saveOpenRouterKey, type AuditRow, type CodexRuntimeStatus } from "../lib/codex";
import type { ClaudeRuntimeStatus } from "../lib/claude";
import type { CursorRuntimeStatus } from "../lib/cursor";
import { DEFAULT_CLAUDE_MODEL, DEFAULT_CURSOR_MODEL, DEFAULT_OPENAI_MODEL, DEFAULT_SETTINGS, RELEASE_NOTES_URL, THEMES } from "../lib/appConfig";
import { friendlyError } from "../lib/errors";
import { useModalFocus } from "../hooks/useModalFocus";
import { AnthropicLogo, ClaudeLogo, CodexLogo, CursorDarkAppIcon, CursorLogo, OpenAILogo } from "./BrandLogos";
import { updateProgress, type AppUpdater } from "../lib/appUpdater";
import {
  projectSubagentSettingsFromApp,
  sanitizeProjectSubagentOverrides,
  type ChildAgentReadiness,
} from "../lib/childAgents";
import type { LocalSkill } from "../lib/skills";
import type { WorkflowDefinition, WorkflowRunRecord } from "../lib/workflows";
import { ChildAgentRoster } from "./ChildAgentRoster";
import { HarnessSettings } from "./HarnessSettings";
import { SkillLibrary } from "./SkillLibrary";
import type { McpView } from "./StudioDock";
import type { GitHubAccountStatus } from "../lib/github";
import { formatEstimatedCost, type UsageTotals } from "../lib/usageLedger";
import type {
  Account,
  AppSettings,
  CustomAgentProfile,
  PermissionMode,
  Project,
  ProjectAction,
  PromptProfile,
  ScheduledTask,
  ScheduleRunRecord,
  ThemeName,
  SettingsSection,
} from "../types";

/**
 * Single source of truth for the settings navigation: the rail, the pane
 * heading, and its supporting line all read from here, so a label can never
 * drift between the button and the pane it opens.
 */
const SETTINGS_NAV: ReadonlyArray<{
  group: string;
  items: ReadonlyArray<{ id: SettingsSection; label: string; icon: typeof Palette; detail: string }>;
}> = [
  {
    group: "Workspace",
    items: [
      { id: "general", label: "General", icon: Palette, detail: "Appearance, runtime behavior, and diagnostics" },
      { id: "projects", label: "Projects", icon: FolderCog, detail: "Per-project model and permission overrides" },
    ],
  },
  {
    group: "Intelligence",
    items: [
      { id: "models", label: "Models & accounts", icon: KeyRound, detail: "Default provider, credentials, and model routing" },
      { id: "github", label: "GitHub", icon: GitFork, detail: "Account connection and repository cloning" },
      { id: "usage", label: "Usage", icon: Gauge, detail: "All-time tokens and API-equivalent inference value" },
      { id: "prompts", label: "Prompts", icon: NotebookPen, detail: "Your complete harness instruction and reusable profiles" },
      { id: "agents", label: "Sub-agents", icon: UsersRound, detail: "Project policies, destinations, and reasoning control" },
    ],
  },
  {
    group: "Automation",
    items: [
      { id: "workflows", label: "Workflows", icon: Play, detail: "Multi-step recipes, triggers, commands, skills, and traceable runs" },
      { id: "skills", label: "Skills", icon: Boxes, detail: "Local Markdown workflows with model-facing invocation names" },
      { id: "tools", label: "Tools & MCP", icon: Wrench, detail: "Model Context Protocol servers and live tool controls" },
    ],
  },
  {
    group: "System",
    items: [
      { id: "updates", label: "Updates", icon: Download, detail: "Secure releases delivered directly from the OpenKiwi repository" },
    ],
  },
];

const SETTINGS_PANES = new Map(SETTINGS_NAV.flatMap((section) => section.items.map((item) => [item.id, item] as const)));

export function SettingsModal({
  open,
  initialSection,
  appUpdater,
  settings,
  account,
  runtimeStatus,
  claudeStatus = null,
  claudeLoginStarting = false,
  cursorStatus = null,
  cursorLoginStarting = false,
  openRouterReady,
  childAgentReadiness,
  githubStatus,
  githubBusy = false,
  usageTotals,
  onClose,
  onSave,
  onThemePreview,
  onAccountChange,
  onSignIn,
  onClaudeSignIn = async () => {},
  onClaudeRefresh = async () => ({ available: false, path: null, version: null, loggedIn: false, authMethod: null, email: null, subscriptionType: null, warning: null }),
  onCursorSignIn = async () => {},
  onCursorRefresh = async () => ({ available: false, path: null, version: null, loggedIn: false, email: null, subscriptionType: null, warning: null }),
  onRuntimeRequired,
  onWorkspaceTools,
  onOpenRouterChange,
  onGitHubSignIn,
  onGitHubRefresh,
  onGitHubClone,
  onError,
  profiles,
  agents,
  actions,
  schedules,
  workflows,
  workflowRuns,
  projects,
  activeProjectId = null,
  skillsFolder,
  skills,
  skillsBusy,
  skillsError,
  mcpServers,
  onMcpChanged,
  workspaceToolsAvailable,
  onProfiles,
  onAgents,
  onActions,
  onSchedules,
  onWorkflows,
  onRunWorkflow,
  onStopWorkflow,
  onProjects,
  scheduleRuns = [],
  onOpenRun,
  onChooseSkillsFolder,
  onRefreshSkills,
  onImportSkills,
  onCreateSkill,
  onRenameSkill,
  onToggleSkill,
  onOpenOnboarding,
}: {
  open: boolean;
  initialSection: SettingsSection;
  appUpdater: AppUpdater;
  settings: AppSettings;
  account: Account | null;
  runtimeStatus: CodexRuntimeStatus | null;
  claudeStatus?: ClaudeRuntimeStatus | null;
  claudeLoginStarting?: boolean;
  cursorStatus?: CursorRuntimeStatus | null;
  cursorLoginStarting?: boolean;
  openRouterReady: boolean;
  /** Which providers a cross-provider child could be started on right now. */
  childAgentReadiness: ChildAgentReadiness;
  githubStatus: GitHubAccountStatus | null;
  githubBusy?: boolean;
  usageTotals: UsageTotals;
  onClose: () => void;
  onSave: (settings: AppSettings) => void;
  onThemePreview: (theme: ThemeName) => void;
  onAccountChange: () => Promise<void>;
  onSignIn: () => Promise<void>;
  onClaudeSignIn?: () => Promise<void>;
  onClaudeRefresh?: () => Promise<ClaudeRuntimeStatus>;
  onCursorSignIn?: () => Promise<void>;
  onCursorRefresh?: () => Promise<CursorRuntimeStatus>;
  onRuntimeRequired: () => void;
  onWorkspaceTools: () => void;
  onOpenRouterChange: (ready: boolean) => void;
  onGitHubSignIn: () => Promise<void>;
  onGitHubRefresh: () => Promise<void>;
  onGitHubClone: (url: string, folderName: string) => Promise<boolean>;
  onError: (error: string | null) => void;
  profiles: PromptProfile[];
  agents: CustomAgentProfile[];
  actions: ProjectAction[];
  schedules: ScheduledTask[];
  workflows: WorkflowDefinition[];
  workflowRuns: WorkflowRunRecord[];
  projects: Project[];
  activeProjectId?: string | null;
  skillsFolder: string;
  skills: LocalSkill[];
  skillsBusy: boolean;
  skillsError: string;
  mcpServers?: McpView[];
  onMcpChanged?: () => void;
  workspaceToolsAvailable: boolean;
  onProfiles: (value: PromptProfile[]) => void;
  onAgents: (value: CustomAgentProfile[]) => void;
  onActions: (value: ProjectAction[]) => void;
  onSchedules: (value: ScheduledTask[]) => void;
  onWorkflows: (value: WorkflowDefinition[]) => void;
  onRunWorkflow: (workflowId: string, variables?: Record<string, string>) => Promise<void> | void;
  onStopWorkflow: (workflowId: string) => Promise<boolean> | boolean;
  onProjects: (value: Project[]) => void;
  scheduleRuns?: ScheduleRunRecord[];
  onOpenRun?: (threadId: string) => void;
  onChooseSkillsFolder: () => void;
  onRefreshSkills: () => void;
  onImportSkills: () => void;
  onCreateSkill: (name: string, instructions: string) => Promise<boolean>;
  onRenameSkill: (path: string, name: string) => boolean;
  onToggleSkill: (path: string) => void;
  onOpenOnboarding: () => void;
}) {
  const [local, setLocal] = useState(settings);
  const [localProjects, setLocalProjects] = useState(projects);
  const [agentScope, setAgentScope] = useState<string>(activeProjectId ?? "global");
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [settingsSection, setSettingsSection] = useState<SettingsSection>(initialSection);
  const [cloneUrl, setCloneUrl] = useState("");
  const [cloneFolder, setCloneFolder] = useState("");
  const githubRefreshRequestedRef = useRef(false);

  // Buffered edits (theme, prompt, toggles) are discarded on close — warn
  // before silently throwing away work like a hand-written system prompt.
  const dirty = open && (JSON.stringify(local) !== JSON.stringify(settings) || JSON.stringify(localProjects) !== JSON.stringify(projects));
  const requestClose = () => {
    if (dirty && !window.confirm("Discard unsaved settings changes?")) return;
    onClose();
  };
  const requestOnboarding = () => {
    if (dirty && !window.confirm("Discard unsaved settings changes?")) return;
    onOpenOnboarding();
  };

  // Snapshot of the props the current drafts were seeded from, so external
  // updates while the modal is open can tell "user edited this" apart from
  // "still the value we started with".
  const draftBaselineRef = useRef({ settings, projects });
  const wasOpenRef = useRef(false);
  useEffect(() => {
    if (!open) {
      wasOpenRef.current = false;
      return;
    }
    if (!wasOpenRef.current) {
      // Seed drafts only on the closed→open transition — reseeding on every
      // prop change wiped in-progress edits (e.g. cloning a repo from the
      // GitHub pane updates `projects` and used to discard a drafted prompt).
      wasOpenRef.current = true;
      draftBaselineRef.current = { settings, projects };
      setLocal(settings);
      setLocalProjects(projects);
      setAgentScope(activeProjectId ?? "global");
      onThemePreview(settings.theme);
      setSettingsSection(initialSection);
      return;
    }
    const baseline = draftBaselineRef.current;
    if (settings !== baseline.settings) {
      // Adopt external settings changes only when the draft is untouched, so
      // the dirty check keeps meaning "you have unsaved edits".
      setLocal((current) => (JSON.stringify(current) === JSON.stringify(baseline.settings) ? settings : current));
    }
    if (projects !== baseline.projects) {
      // Merge external project changes: new projects appear, removed ones
      // disappear, and per-project drafts survive only where the user
      // actually diverged from the snapshot they started editing.
      const baselineById = new Map(baseline.projects.map((project) => [project.id, project]));
      setLocalProjects((current) => {
        const draftsById = new Map(current.map((project) => [project.id, project]));
        return projects.map((incoming) => {
          const draft = draftsById.get(incoming.id);
          const base = baselineById.get(incoming.id);
          return draft && base && JSON.stringify(draft) !== JSON.stringify(base) ? draft : incoming;
        });
      });
    }
    draftBaselineRef.current = { settings, projects };
  }, [activeProjectId, initialSection, onThemePreview, open, projects, settings]);

  useEffect(() => {
    if (open && initialSection === "general" && appUpdater.phase === "available") {
      setSettingsSection("updates");
    }
  }, [appUpdater.phase, initialSection, open]);

  useEffect(() => {
    if (!open) {
      githubRefreshRequestedRef.current = false;
      return;
    }
    if (settingsSection === "github" && !githubRefreshRequestedRef.current) {
      githubRefreshRequestedRef.current = true;
      void onGitHubRefresh();
    }
  }, [onGitHubRefresh, open, settingsSection]);

  const dialogRef = useRef<HTMLDivElement>(null);
  useModalFocus(dialogRef, open);

  const requestCloseRef = useRef(requestClose);
  requestCloseRef.current = requestClose;
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      // An approval modal stacked above Settings owns Escape while present.
      if (document.querySelector("[data-approval-modal]")) return;
      requestCloseRef.current();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open]);

  const signIn = async () => {
    if (!runtimeStatus?.available) {
      onRuntimeRequired();
      return;
    }
    setBusy(true);
    onError(null);
    try {
      await onSignIn();
    } catch (reason) {
      onError(friendlyError(reason));
    } finally {
      setBusy(false);
    }
  };

  const signOut = async () => {
    setBusy(true);
    try {
      await rpc("account/logout");
      await onAccountChange();
    } catch (reason) {
      onError(friendlyError(reason));
    } finally {
      setBusy(false);
    }
  };

  const storeKey = async () => {
    if (!apiKey.trim()) return;
    setBusy(true);
    try {
      await saveOpenRouterKey(apiKey);
      setApiKey("");
      onOpenRouterChange(true);
    } catch (reason) {
      onError(friendlyError(reason));
    } finally {
      setBusy(false);
    }
  };

  const previewTheme = (theme: ThemeName) => {
    setLocal((current) => ({ ...current, theme }));
    onThemePreview(theme);
  };

  const exportDiagnosticBundle = async () => {
    try {
      const path = await save({ title: "Export OpenKiwi diagnostics", defaultPath: `openkiwi-diagnostics-${new Date().toISOString().slice(0, 10)}.json`, filters: [{ name: "JSON", extensions: ["json"] }] });
      if (path) await exportDiagnostics(path);
    } catch (reason) { onError(friendlyError(reason)); }
  };

  const effectiveAgentScope = agentScope === "global" || localProjects.some((project) => project.id === agentScope)
    ? agentScope
    : "global";
  const selectedAgentProject = effectiveAgentScope === "global"
    ? null
    : localProjects.find((project) => project.id === effectiveAgentScope) ?? null;
  const customProjectPolicy = selectedAgentProject?.overrides?.subagents;
  const agentPolicy = customProjectPolicy ?? projectSubagentSettingsFromApp(local);
  const updateAgentPolicy = (next: ReturnType<typeof projectSubagentSettingsFromApp>) => {
    if (!selectedAgentProject) {
      setLocal({ ...local, subagentsEnabled: next.enabled, subagentMax: next.maxConcurrent, childAgents: next.childAgents });
      return;
    }
    setLocalProjects(localProjects.map((project) => project.id === selectedAgentProject.id
      ? { ...project, overrides: { ...(project.overrides ?? {}), subagents: next } }
      : project));
  };
  const clearProjectAgentPolicy = () => {
    if (!selectedAgentProject?.overrides?.subagents) return;
    setLocalProjects(localProjects.map((project) => {
      if (project.id !== selectedAgentProject.id) return project;
      const overrides = { ...(project.overrides ?? {}) };
      delete overrides.subagents;
      return { ...project, overrides: Object.keys(overrides).length ? overrides : undefined };
    }));
  };
  const saveSettings = () => {
    const nextProjects = sanitizeProjectSubagentOverrides(localProjects);
    const normalizedSubagents = projectSubagentSettingsFromApp(local);
    onProjects(nextProjects);
    onSave({ ...local, childAgents: normalizedSubagents.childAgents, subagentMax: normalizedSubagents.maxConcurrent });
  };

  return (
    <div className={`modal-backdrop settings-backdrop ${open ? "open" : "closed"}`} onMouseDown={requestClose} aria-hidden={!open} inert={!open ? true : undefined}>
      <div ref={dialogRef} className="settings-modal" role="dialog" aria-modal="true" aria-labelledby="settings-title" onMouseDown={(event) => event.stopPropagation()}>
        <div className="modal-header">
          <div><h2 id="settings-title">Settings</h2><p>Customize OpenKiwi without hidden configuration.</p></div>
          <button className="icon-button" onClick={requestClose} aria-label="Close settings"><X size={18} /></button>
        </div>

        <div className="settings-layout">
          <nav className="settings-nav" aria-label="Settings categories">
            {SETTINGS_NAV.map((section) => (
              <div className="settings-nav-group" key={section.group} role="group" aria-label={section.group}>
                <span className="settings-nav-label" aria-hidden>{section.group}</span>
                {section.items.map(({ id, label, icon: Icon }) => (
                  <button
                    key={id}
                    className={settingsSection === id ? "active" : ""}
                    onClick={() => setSettingsSection(id)}
                    aria-current={settingsSection === id ? "page" : undefined}
                  >
                    <Icon size={14} /><span>{label}</span><ChevronRight size={12} />
                  </button>
                ))}
              </div>
            ))}
          </nav>
          <div className="settings-content">
          <div className="settings-pane-heading">
            <span>{SETTINGS_PANES.get(settingsSection)?.label}</span>
            <small>{SETTINGS_PANES.get(settingsSection)?.detail}</small>
          </div>
          {settingsSection === "general" &&
          <section className="settings-section getting-started-settings">
            <div className="settings-section-heading settings-heading-with-action">
              <div className="settings-icon"><Sparkles size={17} /></div>
              <div><h3>Getting started</h3><p>Review model setup, projects and chats, permissions, and local skills.</p></div>
              <button type="button" className="secondary-button" onClick={requestOnboarding}>Run onboarding</button>
            </div>
          </section>}

          {settingsSection === "general" &&
          <section className="settings-section theme-settings-section">
            <div className="settings-section-heading settings-heading-with-action">
              <div className="settings-icon"><Palette size={17} /></div>
              <div><h3>Appearance</h3><p>Preview a color atmosphere instantly. Save settings to keep it.</p></div>
              <button type="button" className="default-theme-button" onClick={() => previewTheme(DEFAULT_SETTINGS.theme)} disabled={local.theme === DEFAULT_SETTINGS.theme}>
                <RotateCcw size={12} /> App default
              </button>
            </div>
            <div className="theme-grid">
              {THEMES.map((theme) => (
                <button
                  type="button"
                  key={theme.id}
                  className={`theme-card ${local.theme === theme.id ? "selected" : ""}`}
                  aria-pressed={local.theme === theme.id}
                  onClick={() => previewTheme(theme.id)}
                >
                  <span className="theme-preview" style={{ background: theme.swatches[0] }}>
                    <i style={{ background: theme.swatches[1] }} />
                    <i style={{ background: theme.swatches[2] }} />
                  </span>
                  <span><strong>{theme.name}</strong><small>{theme.description}</small></span>
                  {local.theme === theme.id && <Check size={14} />}
                </button>
              ))}
            </div>
          </section>}

          {settingsSection === "prompts" &&
          <section className="settings-section">
            <div className="settings-section-heading">
              <div className="settings-icon"><NotebookPen size={17} /></div>
              <div><h3>System prompts</h3><p>OpenKiwi applies the global layer first, followed by the selected subscription’s own layer.</p></div>
            </div>
            <div className="prompt-file-notice" role="note">
              <Info size={16} />
              <p><strong>Global instruction files are not inherited.</strong> Your global <code>CLAUDE.md</code> and <code>AGENTS.md</code> do not affect OpenKiwi. Add those instructions to the prompt fields below instead. Project-level <code>AGENTS.md</code> files can still be discovered when that setting is enabled.</p>
            </div>
            <div className="prompt-guidance-control">
              <span><strong>Project AGENTS.md discovery</strong><small>Allow AGENTS.md guidance from the active project for its threads (up to 32 KB).</small></span>
              <button type="button" role="switch" aria-label="Project AGENTS.md discovery" aria-checked={local.projectInstructionsEnabled} className={`toggle-switch ${local.projectInstructionsEnabled ? "on" : ""}`} onClick={() => setLocal({ ...local, projectInstructionsEnabled: !local.projectInstructionsEnabled })}><span /></button>
            </div>
            <label className="prompt-layer-field">
              <span><strong>Global OpenKiwi prompt</strong><small>Used by every provider.</small></span>
              <textarea
                className="prompt-editor"
                value={local.systemPrompt}
                onChange={(event) => setLocal({ ...local, systemPrompt: event.target.value })}
                placeholder="Empty — add your own instructions here"
                rows={5}
              />
            </label>
            <div className="provider-prompt-grid">
              <label className="prompt-layer-field">
                <span><strong>Codex subscription prompt</strong><small>Appended after the global prompt for ChatGPT subscription threads.</small></span>
                <textarea
                  className="prompt-editor"
                  value={local.codexSystemPrompt}
                  onChange={(event) => setLocal({ ...local, codexSystemPrompt: event.target.value })}
                  placeholder="Optional Codex-specific instructions"
                  rows={4}
                />
              </label>
              <label className="prompt-layer-field">
                <span><strong>Claude Code subscription prompt</strong><small>Appended after the global prompt for Claude subscription threads.</small></span>
                <textarea
                  className="prompt-editor"
                  value={local.claudeSystemPrompt}
                  onChange={(event) => setLocal({ ...local, claudeSystemPrompt: event.target.value })}
                  placeholder="Optional Claude-specific instructions"
                  rows={4}
                />
              </label>
            </div>
            <div className="prompt-audit-row">
              <span><Check size={13} /> Global layer first</span>
              <span><Check size={13} /> Subscription layer second</span>
              <span><Check size={13} /> AGENTS.md discovery {local.projectInstructionsEnabled ? "enabled" : "disabled"}</span>
            </div>
          </section>}

          {(["prompts", "agents", "workflows", "tools"] as const).includes(settingsSection as "prompts" | "agents" | "workflows" | "tools") && <HarnessSettings
            section={settingsSection as "prompts" | "agents" | "workflows" | "tools"}
            settings={local}
            profiles={profiles}
            agents={agents}
            actions={actions}
            schedules={schedules}
            workflows={workflows}
            workflowRuns={workflowRuns}
            projects={projects}
            skills={skills}
            onSettings={setLocal}
            onProfiles={onProfiles}
            onAgents={onAgents}
            onActions={onActions}
            onSchedules={onSchedules}
            onWorkflows={onWorkflows}
            onRunWorkflow={onRunWorkflow}
            onStopWorkflow={onStopWorkflow}
            mcpServers={mcpServers}
            onMcpChanged={onMcpChanged}
            scheduleRuns={scheduleRuns}
            onOpenRun={onOpenRun}
          />}

          {settingsSection === "tools" && <div className="settings-workspace-link"><div><strong>Live tool controls</strong><small>{workspaceToolsAvailable ? "Inspect skills, connect configured MCP servers, and run project actions in the active workspace." : "Select a project to inspect live skills, MCP servers, and project actions."}</small></div><button className="secondary-button" onClick={onWorkspaceTools} disabled={!workspaceToolsAvailable}><PanelRight size={13} /> Open workspace tools</button></div>}

          {settingsSection === "projects" && <ProjectOverridesSettings projects={localProjects} onProjects={setLocalProjects} />}

          {settingsSection === "github" &&
          <GitHubSettings
            status={githubStatus}
            busy={githubBusy}
            cloneUrl={cloneUrl}
            cloneFolder={cloneFolder}
            onCloneUrl={setCloneUrl}
            onCloneFolder={setCloneFolder}
            onSignIn={onGitHubSignIn}
            onRefresh={onGitHubRefresh}
            onClone={async () => {
              if (await onGitHubClone(cloneUrl, cloneFolder)) {
                setCloneUrl("");
                setCloneFolder("");
              }
            }}
          />}

          {settingsSection === "usage" && <AllTimeUsageSettings totals={usageTotals} />}

          {settingsSection === "skills" && <SkillLibrary
            folder={skillsFolder}
            skills={skills}
            busy={skillsBusy}
            error={skillsError}
            onChooseFolder={onChooseSkillsFolder}
            onRefresh={onRefreshSkills}
            onImport={onImportSkills}
            onCreate={onCreateSkill}
            onRename={onRenameSkill}
            onToggle={onToggleSkill}
          />}

          {settingsSection === "updates" && <UpdateSettings appUpdater={appUpdater} />}

          {settingsSection === "general" &&
          <section className="settings-section">
            <div className="settings-section-heading"><div className="settings-icon"><Wrench size={17} /></div><div><h3>Runtime behavior</h3><p>Control background alerts, service tier, and terminal memory.</p></div></div>
            <div className="behavior-grid behavior-grid-single">
              <div><span><strong>Desktop notifications</strong><small>Notify when a background task finishes.</small></span><button type="button" role="switch" aria-checked={local.notificationsEnabled} className={`toggle-switch ${local.notificationsEnabled ? "on" : ""}`} onClick={() => setLocal({ ...local, notificationsEnabled: !local.notificationsEnabled })}><span /></button></div>
            </div>
            <div className="runtime-field-grid"><label><span>OpenAI service tier</span><select value={local.serviceTier ?? ""} onChange={(event) => setLocal({ ...local, serviceTier: event.target.value || null })}><option value="">Standard</option><option value="priority">Fast / priority</option></select></label><label><span>Terminal scrollback</span><select value={local.terminalScrollback} onChange={(event) => setLocal({ ...local, terminalScrollback: Number(event.target.value) })}><option value={25000}>25k characters</option><option value={100000}>100k characters</option><option value={500000}>500k characters</option></select></label><label><span>UI size</span><select value={local.uiScale ?? 100} onChange={(event) => setLocal({ ...local, uiScale: Number(event.target.value) })}><option value={90}>Compact (90%)</option><option value={100}>Default (100%)</option><option value={110}>Comfortable (110%)</option><option value={125}>Large (125%)</option></select></label></div>
            <div className="diagnostic-card"><span><strong>Diagnostics</strong><small>{runtimeStatus?.version ?? "Runtime version unavailable"}{runtimeStatus?.warning ? ` · ${runtimeStatus.warning}` : runtimeStatus?.compatible ? " · compatible" : ""}</small></span><button className="secondary-button" onClick={() => void exportDiagnosticBundle()}>Export JSON</button></div>
            <RecentErrorsPanel active={open && settingsSection === "general"} />
          </section>}

          {settingsSection === "agents" &&
          <section className="settings-section">
            <div className="settings-section-heading">
              <div className="settings-icon"><UsersRound size={17} /></div>
              <div><h3>Sub-agents</h3><p>Let the model delegate parallel work to direct child agents. Applies when a new thread starts.</p></div>
            </div>
            <div className="subagent-scope-bar">
              <label htmlFor="subagent-scope">Policy for</label>
              <select id="subagent-scope" value={effectiveAgentScope} onChange={(event) => setAgentScope(event.target.value)}>
                <option value="global">Chats &amp; project defaults</option>
                {localProjects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
              </select>
              {selectedAgentProject && (customProjectPolicy
                ? <button type="button" className="secondary-button" onClick={clearProjectAgentPolicy}><RotateCcw size={12} /> Use defaults</button>
                : <button type="button" className="secondary-button" onClick={() => updateAgentPolicy(projectSubagentSettingsFromApp(local))}><Plus size={12} /> Customize</button>)}
            </div>
            {selectedAgentProject && !customProjectPolicy && (
              <div className="subagent-inheritance-note"><Check size={13} /> {selectedAgentProject.name} currently inherits the Chats &amp; project defaults policy. Customize it to make project-specific changes.</div>
            )}
            <SubagentPolicyEditor
              policy={agentPolicy}
              readiness={childAgentReadiness}
              disabled={Boolean(selectedAgentProject && !customProjectPolicy)}
              onChange={updateAgentPolicy}
            />
          </section>}

          {settingsSection === "models" &&
          <section className="settings-section">
            <div className="settings-section-heading">
              <div className="settings-icon"><KeyRound size={17} /></div>
              <div><h3>Default model provider</h3><p>New threads start with this provider. Each thread keeps its own provider after it starts.</p></div>
            </div>
            <div className="provider-cards">
              <button className={`provider-card ${local.provider === "openai" ? "selected" : ""}`} onClick={() => setLocal({ ...local, provider: "openai", model: local.provider === "openai" ? (local.model || DEFAULT_OPENAI_MODEL) : DEFAULT_OPENAI_MODEL, ultra: false })}>
                <span className="provider-logo openai">{local.openAiLogo === "codex" ? <CodexLogo size={18} /> : <OpenAILogo size={17} />}</span>
                <span><strong>OpenAI</strong><small>Official ChatGPT subscription sign-in</small></span>
                {local.provider === "openai" && <Check size={16} />}
              </button>
              <button className={`provider-card ${local.provider === "openrouter" ? "selected" : ""}`} onClick={() => setLocal({ ...local, provider: "openrouter", model: local.provider === "openrouter" ? local.model : "", ultra: false })}>
                <span className="provider-logo openrouter"><RotateCcw size={17} /></span>
                <span><strong>OpenRouter</strong><small>Responses-compatible model routing</small></span>
                {local.provider === "openrouter" && <Check size={16} />}
              </button>
              <button className={`provider-card ${local.provider === "claude" ? "selected" : ""}`} onClick={() => setLocal({ ...local, provider: "claude", model: local.provider === "claude" ? (local.model || DEFAULT_CLAUDE_MODEL) : DEFAULT_CLAUDE_MODEL, ultra: false })}>
                <span className={`provider-logo claude${local.claudeLogo === "anthropic" ? " anthropic-mark" : ""}`}>{local.claudeLogo === "anthropic" ? <AnthropicLogo size={17} /> : <ClaudeLogo size={17} />}</span>
                <span><strong>Claude</strong><small>Official Claude Code subscription login</small></span>
                {local.provider === "claude" && <Check size={16} />}
              </button>
              <button className={`provider-card ${local.provider === "cursor" ? "selected" : ""}`} onClick={() => setLocal({ ...local, provider: "cursor", model: local.provider === "cursor" ? local.model : DEFAULT_CURSOR_MODEL, ultra: false })}>
                <span className={`provider-logo cursor${local.cursorLogo === "app-dark" ? " app-dark" : ""}`}>{local.cursorLogo === "app-dark" ? <CursorDarkAppIcon size={23} /> : <CursorLogo size={17} />}</span>
                <span><strong>Cursor</strong><small>Official Cursor subscription login</small></span>
                {local.provider === "cursor" && <Check size={16} />}
              </button>
            </div>
            <p className="provider-default-note">Use the provider control above the conversation to choose a different provider for one new thread without changing this default.</p>

            {local.provider === "openai" ? (
              <div className="credential-panel">
                <div>
                  <strong>{account?.type === "chatgpt" ? account.email || "ChatGPT account" : "ChatGPT subscription"}</strong>
                  <small>{account?.type === "chatgpt" ? `${account.planType ?? "ChatGPT"} plan connected` : runtimeStatus?.available ? `Official browser sign-in · ${runtimeStatus.source} detected` : "Codex CLI for Windows required"}</small>
                </div>
                {account?.type === "chatgpt" ? (
                  <button className="secondary-button" onClick={() => void signOut()} disabled={busy}>Sign out</button>
                ) : (
                  <button className="secondary-button" onClick={() => void signIn()} disabled={busy}>
                    {busy ? <LoaderCircle className="spin" size={14} /> : !runtimeStatus?.available ? <Download size={14} /> : null} {runtimeStatus?.available ? "Sign in" : "Set up Codex"}
                  </button>
                )}
              </div>
            ) : local.provider === "openrouter" ? (
              <div className="credential-panel stacked">
                <div className="credential-status">
                  <div><strong>OpenRouter API key</strong><small>{openRouterReady ? "Stored securely on this device" : "No key stored"}</small></div>
                  {openRouterReady && <span className="connected-badge"><Check size={12} /> Connected</span>}
                </div>
                <div className="key-input-row">
                  <input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder="sk-or-v1-…" />
                  <button className="secondary-button" onClick={() => void storeKey()} disabled={!apiKey.trim() || busy}>Save key</button>
                </div>
              </div>
            ) : local.provider === "claude" ? (
              <div className="credential-panel">
                <div>
                  <strong>{claudeStatus?.loggedIn ? claudeStatus.email || "Claude subscription" : "Claude Code subscription"}</strong>
                  <small>{claudeStatus?.loggedIn
                    ? `${claudeStatus.subscriptionType || claudeStatus.authMethod || "Claude"} plan connected · ${claudeStatus.version || "Claude Code"}`
                    : claudeStatus?.warning || (claudeStatus?.available ? "Claude Code detected · sign in to continue" : "Claude Code must be installed first")}</small>
                </div>
                {claudeStatus?.loggedIn ? (
                  <span className="connected-badge"><Check size={12} /> Connected</span>
                ) : (
                  <button className="secondary-button" onClick={() => void (claudeStatus?.available ? onClaudeSignIn() : openUrl("https://docs.anthropic.com/en/docs/claude-code/setup"))} disabled={claudeLoginStarting}>
                    {claudeLoginStarting ? <LoaderCircle className="spin" size={14} /> : !claudeStatus?.available ? <Download size={14} /> : null}
                    {claudeLoginStarting ? "Signing in…" : claudeStatus?.available ? "Sign in" : "Install Claude Code"}
                  </button>
                )}
                <button className="icon-button" onClick={() => void onClaudeRefresh()} title="Refresh Claude status" aria-label="Refresh Claude status"><RotateCcw size={14} /></button>
              </div>
            ) : (
              <div className="credential-panel">
                <span className={`provider-logo cursor${local.cursorLogo === "app-dark" ? " app-dark" : ""}`}>{local.cursorLogo === "app-dark" ? <CursorDarkAppIcon size={23} /> : <CursorLogo size={17} />}</span>
                <div>
                  <strong>{cursorStatus?.loggedIn ? cursorStatus.email || "Cursor subscription" : "Cursor Agent subscription"}</strong>
                  <small>{cursorStatus?.loggedIn
                    ? `${cursorStatus.subscriptionType || "Cursor"} plan connected · ${cursorStatus.version || "Cursor Agent"}`
                    : cursorStatus?.warning || (cursorStatus?.available ? "Cursor Agent detected · sign in to continue" : "Cursor Agent CLI must be installed first")}</small>
                </div>
                {cursorStatus?.loggedIn ? (
                  <span className="connected-badge"><Check size={12} /> Connected</span>
                ) : (
                  <button className="secondary-button" onClick={() => void (cursorStatus?.available ? onCursorSignIn() : openUrl("https://cursor.com/docs/cli/installation"))} disabled={cursorLoginStarting}>
                    {cursorLoginStarting ? <LoaderCircle className="spin" size={14} /> : !cursorStatus?.available ? <Download size={14} /> : null}
                    {cursorLoginStarting ? "Signing in…" : cursorStatus?.available ? "Sign in" : "Install Cursor Agent"}
                  </button>
                )}
                <button className="icon-button" onClick={() => void onCursorRefresh()} title="Refresh Cursor status" aria-label="Refresh Cursor status"><RotateCcw size={14} /></button>
              </div>
            )}

            <label className="field-label">
              <span>Model</span>
              <input
                value={local.model}
                onChange={(event) => setLocal({ ...local, model: event.target.value })}
                readOnly={local.provider !== "openrouter"}
                placeholder={local.provider === "openrouter" ? "e.g. anthropic/claude-sonnet-4" : local.provider === "claude" ? "Select a Claude model below the composer" : local.provider === "cursor" ? "Select Grok 4.5 or another Cursor model below the composer" : "Select Sol, Terra, or Luna below the composer"}
              />
              <small>{local.provider === "openrouter" ? "Use the searchable picker beneath the composer, or enter any valid provider/model slug here." : local.provider === "claude" ? "Use the Claude selector beneath the composer. Availability follows your signed-in Claude Code subscription." : local.provider === "cursor" ? "Use the Cursor selector beneath the composer. Its live catalog comes from your signed-in Cursor subscription." : "Use the animated selector beneath the composer. Availability follows the signed-in ChatGPT account."}</small>
            </label>

            <div className="provider-logo-settings">
              <div>
                <strong>OpenAI model logo</strong>
                <small>Choose the mark used for OpenAI threads, responses, and provider controls throughout OpenKiwi.</small>
              </div>
              <div className="provider-logo-options" role="radiogroup" aria-label="OpenAI model logo">
                <button type="button" className={local.openAiLogo === "openai" ? "selected" : ""} role="radio" aria-checked={local.openAiLogo === "openai"} onClick={() => setLocal({ ...local, openAiLogo: "openai" })}>
                  <span className="provider-logo-preview openai"><OpenAILogo size={20} /></span>
                  <span><strong>OpenAI</strong></span>
                  {local.openAiLogo === "openai" && <Check size={14} />}
                </button>
                <button type="button" className={local.openAiLogo === "codex" ? "selected" : ""} role="radio" aria-checked={local.openAiLogo === "codex"} onClick={() => setLocal({ ...local, openAiLogo: "codex" })}>
                  <span className="provider-logo-preview codex"><CodexLogo size={22} /></span>
                  <span><strong>Codex</strong></span>
                  {local.openAiLogo === "codex" && <Check size={14} />}
                </button>
              </div>
            </div>
            <div className="provider-logo-settings">
              <div>
                <strong>Cursor model logo</strong>
                <small>Choose the official Cursor mark used for threads, responses, and model controls.</small>
              </div>
              <div className="provider-logo-options" role="radiogroup" aria-label="Cursor model logo">
                <button type="button" className={local.cursorLogo === "cube" ? "selected" : ""} role="radio" aria-checked={local.cursorLogo === "cube"} onClick={() => setLocal({ ...local, cursorLogo: "cube" })}>
                  <span className="provider-logo-preview cursor"><CursorLogo size={21} /></span>
                  <span><strong>Cursor</strong></span>
                  {local.cursorLogo === "cube" && <Check size={14} />}
                </button>
                <button type="button" className={local.cursorLogo === "app-dark" ? "selected" : ""} role="radio" aria-checked={local.cursorLogo === "app-dark"} onClick={() => setLocal({ ...local, cursorLogo: "app-dark" })}>
                  <span className="provider-logo-preview cursor-app-dark"><CursorDarkAppIcon size={30} /></span>
                  <span><strong>Cursor Dark</strong></span>
                  {local.cursorLogo === "app-dark" && <Check size={14} />}
                </button>
              </div>
            </div>
            <div className="provider-logo-settings">
              <div>
                <strong>Claude model logo</strong>
                <small>Choose the mark used for Claude threads, responses, and provider controls throughout OpenKiwi.</small>
              </div>
              <div className="provider-logo-options" role="radiogroup" aria-label="Claude model logo">
                <button type="button" className={local.claudeLogo === "claude" ? "selected" : ""} role="radio" aria-checked={local.claudeLogo === "claude"} onClick={() => setLocal({ ...local, claudeLogo: "claude" })}>
                  <span className="provider-logo-preview claude"><ClaudeLogo size={20} /></span>
                  <span><strong>Claude</strong></span>
                  {local.claudeLogo === "claude" && <Check size={14} />}
                </button>
                <button type="button" className={local.claudeLogo === "anthropic" ? "selected" : ""} role="radio" aria-checked={local.claudeLogo === "anthropic"} onClick={() => setLocal({ ...local, claudeLogo: "anthropic" })}>
                  <span className="provider-logo-preview anthropic"><AnthropicLogo size={20} /></span>
                  <span><strong>Anthropic</strong></span>
                  {local.claudeLogo === "anthropic" && <Check size={14} />}
                </button>
              </div>
            </div>
          </section>}
          </div>
        </div>

        <div className="modal-footer">
          {dirty && <span className="unsaved-hint">Unsaved changes</span>}
          <button className="secondary-button" onClick={requestClose}>Cancel</button>
          <button className="primary-button" onClick={saveSettings}>Save settings</button>
        </div>
      </div>
    </div>
  );
}

function SubagentPolicyEditor({ policy, readiness, disabled, onChange }: {
  policy: ReturnType<typeof projectSubagentSettingsFromApp>;
  readiness: ChildAgentReadiness;
  disabled: boolean;
  onChange: (next: ReturnType<typeof projectSubagentSettingsFromApp>) => void;
}) {
  return (
    <div className={`subagent-policy-editor ${disabled ? "disabled" : ""}`} inert={disabled ? true : undefined}>
      <div className={`agent-settings-card ${policy.enabled ? "enabled" : ""}`}>
        <div className="agent-toggle-copy">
          <strong>Allow sub-agent spawning</strong>
          <small>{policy.enabled ? "The model may delegate when it decides that parallel work helps." : "No sub-agent tools are exposed to the model."}</small>
        </div>
        <button
          type="button"
          role="switch"
          aria-label="Allow sub-agent spawning"
          aria-checked={policy.enabled}
          className={`toggle-switch ${policy.enabled ? "on" : ""}`}
          onClick={() => onChange({ ...policy, enabled: !policy.enabled })}
        >
          <span />
        </button>
      </div>
      <div className={`agent-limit-row ${policy.enabled ? "" : "disabled"}`}>
        <div>
          <strong>Maximum concurrent sub-agents</strong>
          <small>Choose 1–24 active at once per thread, excluding the root agent. This also limits specialist profiles exposed to Claude.</small>
        </div>
        <div className="number-stepper" aria-label="Maximum concurrent sub-agents">
          <button type="button" onClick={() => onChange({ ...policy, maxConcurrent: Math.max(1, policy.maxConcurrent - 1) })} disabled={!policy.enabled || policy.maxConcurrent <= 1}><Minus size={13} /></button>
          <strong>{policy.maxConcurrent}</strong>
          <button type="button" onClick={() => onChange({ ...policy, maxConcurrent: Math.min(24, policy.maxConcurrent + 1) })} disabled={!policy.enabled || policy.maxConcurrent >= 24}><Plus size={13} /></button>
        </div>
      </div>
      <div className="agent-safety-row">
        <span><ShieldCheck size={13} /> Inherits permissions</span>
        <span><Check size={13} /> Direct children only</span>
        <span><Check size={13} /> Frozen per thread</span>
      </div>

      <div className="settings-section-heading child-agent-heading">
        <div className="settings-icon"><Boxes size={17} /></div>
        <div><h3>Cross-provider destinations</h3><p>Choose the providers, models, and reasoning authority available to the root agent. Children run through OpenKiwi.</p></div>
      </div>
      <ChildAgentRoster
        value={policy.childAgents}
        subagentsEnabled={policy.enabled}
        readiness={readiness}
        onChange={(childAgents) => onChange({ ...policy, childAgents })}
      />
    </div>
  );
}

function GitHubSettings({
  status,
  busy,
  cloneUrl,
  cloneFolder,
  onCloneUrl,
  onCloneFolder,
  onSignIn,
  onRefresh,
  onClone,
}: {
  status: GitHubAccountStatus | null;
  busy: boolean;
  cloneUrl: string;
  cloneFolder: string;
  onCloneUrl: (value: string) => void;
  onCloneFolder: (value: string) => void;
  onSignIn: () => Promise<void>;
  onRefresh: () => Promise<void>;
  onClone: () => Promise<void>;
}) {
  return <>
    <section className="settings-section">
      <div className="settings-section-heading">
        <div className="settings-icon"><GitFork size={17} /></div>
        <div><h3>GitHub account</h3><p>OpenKiwi uses the official GitHub CLI and never injects its token into prompts or project files. Agents with command access can still run credential-aware CLI tools, so use the same care you would in a terminal.</p></div>
      </div>
      <div className="credential-panel github-account-panel">
        <span className="github-avatar-placeholder"><GitFork size={18} /></span>
        <div>
          <strong>{status?.authenticated ? status.name || status.login || "GitHub account" : status?.available ? "GitHub is ready to connect" : "GitHub CLI is required"}</strong>
          <small>{status?.authenticated ? `@${status.login}${status.email ? ` · ${status.email}` : ""}` : status?.error || "Install GitHub CLI to connect repositories."}</small>
        </div>
        {status?.authenticated ? (
          <span className="connected-badge"><Check size={12} /> Connected</span>
        ) : (
          <button className="secondary-button" onClick={() => void onSignIn()} disabled={busy || !status?.available}>
            {busy ? <LoaderCircle className="spin" size={14} /> : <GitFork size={14} />} Sign in
          </button>
        )}
        <button className="icon-button" onClick={() => void onRefresh()} disabled={busy} title="Refresh GitHub status" aria-label="Refresh GitHub status"><RotateCcw size={14} /></button>
      </div>
      {!status?.available && <button className="secondary-button settings-external-action" onClick={() => void openUrl("https://cli.github.com/")}><ExternalLink size={13} /> Install GitHub CLI</button>}
    </section>
    <section className="settings-section">
      <div className="settings-section-heading">
        <div className="settings-icon"><Download size={17} /></div>
        <div><h3>Clone a repository</h3><p>Download a GitHub repository into a new local folder and add it to OpenKiwi as a project.</p></div>
      </div>
      <div className="github-clone-grid">
        <label className="field-label"><span>Repository URL</span><input value={cloneUrl} onChange={(event) => onCloneUrl(event.target.value)} placeholder="https://github.com/owner/repository.git" /></label>
        <label className="field-label"><span>Local folder name</span><input value={cloneFolder} onChange={(event) => onCloneFolder(event.target.value)} placeholder="repository" /></label>
      </div>
      <button className="primary-button" disabled={!status?.authenticated || busy || !cloneUrl.trim() || !cloneFolder.trim()} onClick={() => void onClone()}>{busy ? <LoaderCircle className="spin" size={13} /> : <Download size={13} />} Choose location and clone</button>
    </section>
  </>;
}

function AllTimeUsageSettings({ totals }: { totals: UsageTotals }) {
  return <section className="settings-section">
    <div className="settings-section-heading">
      <div className="settings-icon"><Gauge size={17} /></div>
      <div><h3>All-time local usage</h3><p>Accumulated since local usage history was enabled on this device. Dollar values estimate standard API pricing; subscription use is not an API charge.</p></div>
    </div>
    <div className="usage-settings-hero">
      <span>Estimated API-equivalent value</span>
      <strong>{formatEstimatedCost(totals.estimatedCost)}</strong>
      <small>{totals.threads.toLocaleString()} tracked thread{totals.threads === 1 ? "" : "s"}</small>
    </div>
    <div className="metric-grid three usage-settings-metrics">
      <div><strong>{totals.inputTokens.toLocaleString()}</strong><span>Input tokens</span></div>
      <div><strong>{totals.outputTokens.toLocaleString()}</strong><span>Output tokens</span></div>
      <div><strong>{totals.totalTokens.toLocaleString()}</strong><span>Total tokens</span></div>
    </div>
    {(totals.cachedInputTokens > 0 || totals.cacheWriteInputTokens > 0) && (
      <div className="usage-cache-note">Prompt caching: {totals.cachedInputTokens.toLocaleString()} read · {totals.cacheWriteInputTokens.toLocaleString()} written</div>
    )}
    <div className="usage-pricing-note">
      <ShieldCheck size={14} />
      <span>{totals.unpricedTokens
        ? `${totals.unpricedTokens.toLocaleString()} tokens are excluded from the dollar estimate because their model has no official published price.`
        : "All tracked tokens with model metadata have a published price."} Cache-write premiums are included when providers report them; long-context, regional, batch, and priority pricing adjustments are not.</span>
    </div>
    <div className="usage-source-links">
      <span>Pricing refreshes from OpenKiwi's validated catalog each time the app opens. New rates apply only to future usage.</span>
      <button className="secondary-button" onClick={() => void openUrl("https://developers.openai.com/api/docs/models/compare")}><ExternalLink size={12} /> OpenAI pricing</button>
      <button className="secondary-button" onClick={() => void openUrl("https://www.anthropic.com/pricing")}><ExternalLink size={12} /> Anthropic pricing</button>
    </div>
  </section>;
}

function ProjectOverridesSettings({ projects, onProjects }: { projects: Project[]; onProjects: (value: Project[]) => void }) {
  const updateOverrides = (id: string, patch: Partial<NonNullable<Project["overrides"]>>) => {
    onProjects(projects.map((project) => {
      if (project.id !== id) return project;
      const overrides = { ...(project.overrides ?? {}), ...patch };
      for (const key of Object.keys(overrides) as Array<keyof typeof overrides>) {
        if (!overrides[key]) delete overrides[key];
      }
      return { ...project, overrides: Object.keys(overrides).length ? overrides : undefined };
    }));
  };
  return (
    <section className="settings-section">
      <div className="settings-section-heading">
        <div className="settings-icon"><FolderCog size={17} /></div>
        <div><h3>Per-project overrides</h3><p>Give a project its own model or permission mode. Project instructions now live beside the project name at the top of its chat window.</p></div>
      </div>
      {projects.length ? projects.map((project) => (
        <div className="project-override-card" key={project.id}>
          <div className="project-override-title"><strong>{project.name}</strong><small>{project.path}</small></div>
          <div className="runtime-field-grid">
            <label>
              <span>Permission mode</span>
              <select
                value={project.overrides?.permission ?? ""}
                onChange={(event) => updateOverrides(project.id, { permission: (event.target.value || undefined) as PermissionMode | undefined })}
              >
                <option value="">Inherit global</option>
                <option value="read-only">Read only</option>
                <option value="ask">Ask to act</option>
                <option value="full">Full access</option>
              </select>
            </label>
            <label>
              <span>Model</span>
              <input value={project.overrides?.model ?? ""} placeholder="Inherit global" onChange={(event) => updateOverrides(project.id, { model: event.target.value || undefined })} />
            </label>
          </div>
        </div>
      )) : <div className="tool-empty-line">Open a project first — each project you add appears here with its own overrides.</div>}
    </section>
  );
}

function RecentErrorsPanel({ active }: { active: boolean }) {
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [unavailable, setUnavailable] = useState(false);
  useEffect(() => {
    if (!active) return;
    recentAuditRows(20, "ui.error")
      .then((result) => {
        setRows(result);
        setUnavailable(false);
      })
      .catch(() => setUnavailable(true));
  }, [active]);
  if (unavailable || !rows.length) return null;
  return (
    <div className="recent-errors">
      <h3 className="panel-label">Recent errors</h3>
      <div className="recent-errors-list">
        {rows.map((row) => {
          const message = typeof row.payload === "object" && row.payload !== null && "message" in row.payload
            ? String((row.payload as { message?: unknown }).message ?? "")
            : String(row.payload ?? "");
          return (
            <div key={row.id}>
              <small>{new Date(row.createdAt).toLocaleString()}</small>
              <span>{message || row.kind}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function UpdateSettings({ appUpdater }: { appUpdater: AppUpdater }) {
  const progress = updateProgress(appUpdater.downloadedBytes, appUpdater.totalBytes);
  const busy = ["checking", "downloading", "installing", "restarting"].includes(appUpdater.phase);
  const detail = appUpdater.phase === "checking" ? "Checking GitHub Releases…"
    : appUpdater.phase === "current" ? "You have the newest available version."
      : appUpdater.phase === "available" ? `Version ${appUpdater.availableVersion} is available.`
        : appUpdater.phase === "downloading" ? (progress === null ? "Downloading the signed update…" : `Downloading the signed update… ${progress}%`)
          : appUpdater.phase === "installing" ? "Verifying and installing the update…"
            : appUpdater.phase === "restarting" ? "Update installed. Restarting OpenKiwi…"
              : appUpdater.phase === "error" ? appUpdater.error || "The update could not be completed."
                : "Check the public OpenKiwi repository for a newer signed release.";

  return <section className="settings-section update-settings-section">
    <div className="settings-section-heading">
      <div className="settings-icon"><Download size={17} /></div>
      <div><h3>OpenKiwi updates</h3><p>Updates are cryptographically verified before installation and are applied after OpenKiwi restarts.</p></div>
    </div>
    <div className={`update-card ${appUpdater.phase}`}>
      <div className="update-version-row">
        <span><small>Installed</small><strong>OpenKiwi {appUpdater.currentVersion}</strong></span>
        {appUpdater.availableVersion && <span className="update-version-available"><small>Available</small><strong>{appUpdater.availableVersion}</strong></span>}
      </div>
      <div className="update-status-row">
        {busy && <LoaderCircle className="spin" size={15} />}
        {!busy && appUpdater.phase === "current" && <Check size={15} />}
        {!busy && appUpdater.phase === "available" && <Download size={15} />}
        <span>{detail}</span>
      </div>
      {(appUpdater.phase === "downloading" || appUpdater.phase === "installing") && (
        <div className={`update-progress ${progress === null ? "indeterminate" : ""}`} role="progressbar" aria-label="Update download progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress ?? undefined}>
          <span style={progress === null ? undefined : { width: `${progress}%` }} />
        </div>
      )}
      {appUpdater.notes && <div className="update-notes"><strong>What’s new</strong><p>{appUpdater.notes}</p>{appUpdater.publishedAt && <small>{new Date(appUpdater.publishedAt).toLocaleDateString()}</small>}</div>}
      <div className="update-actions">
        <button className="secondary-button" onClick={() => void openUrl(RELEASE_NOTES_URL)}><ExternalLink size={13} /> View release notes</button>
        {appUpdater.phase === "available" ? (
          <button className="primary-button" onClick={() => void appUpdater.downloadAndRestart()}><Download size={13} /> Download, install, and restart</button>
        ) : (
          <button className="secondary-button" disabled={busy} onClick={() => void appUpdater.checkForUpdates()}>{appUpdater.phase === "checking" ? <LoaderCircle className="spin" size={13} /> : <RotateCcw size={13} />} {appUpdater.phase === "error" ? "Try again" : "Check for updates"}</button>
        )}
      </div>
    </div>
    <div className="update-trust-row"><ShieldCheck size={14} /><span><strong>Verified release channel</strong><small>Manifest and packages come from github.com/m17h/OpenKiwi-Windows and must match OpenKiwi’s embedded updater key.</small></span></div>
  </section>;
}
