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
import { DEFAULT_CLAUDE_MODEL, DEFAULT_OPENAI_MODEL, DEFAULT_SETTINGS, RELEASE_NOTES_URL, THEMES } from "../lib/appConfig";
import { friendlyError } from "../lib/errors";
import { useModalFocus } from "../hooks/useModalFocus";
import { ClaudeLogo, OpenAILogo } from "./BrandLogos";
import { updateProgress, type AppUpdater } from "../lib/appUpdater";
import type { LocalSkill } from "../lib/skills";
import type { WorkflowDefinition, WorkflowRunRecord } from "../lib/workflows";
import { HarnessSettings } from "./HarnessSettings";
import { SkillLibrary } from "./SkillLibrary";
import type { McpView } from "./StudioDock";
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
      { id: "prompts", label: "Prompts", icon: NotebookPen, detail: "Your complete harness instruction and reusable profiles" },
      { id: "agents", label: "Agents", icon: UsersRound, detail: "Delegation limits and specialist configurations" },
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
  openRouterReady,
  onClose,
  onSave,
  onThemePreview,
  onAccountChange,
  onSignIn,
  onClaudeSignIn = async () => {},
  onClaudeRefresh = async () => ({ available: false, path: null, version: null, loggedIn: false, authMethod: null, email: null, subscriptionType: null, warning: null }),
  onRuntimeRequired,
  onWorkspaceTools,
  onOpenRouterChange,
  onError,
  profiles,
  agents,
  actions,
  schedules,
  workflows,
  workflowRuns,
  projects,
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
  openRouterReady: boolean;
  onClose: () => void;
  onSave: (settings: AppSettings) => void;
  onThemePreview: (theme: ThemeName) => void;
  onAccountChange: () => Promise<void>;
  onSignIn: () => Promise<void>;
  onClaudeSignIn?: () => Promise<void>;
  onClaudeRefresh?: () => Promise<ClaudeRuntimeStatus>;
  onRuntimeRequired: () => void;
  onWorkspaceTools: () => void;
  onOpenRouterChange: (ready: boolean) => void;
  onError: (error: string | null) => void;
  profiles: PromptProfile[];
  agents: CustomAgentProfile[];
  actions: ProjectAction[];
  schedules: ScheduledTask[];
  workflows: WorkflowDefinition[];
  workflowRuns: WorkflowRunRecord[];
  projects: Project[];
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
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [settingsSection, setSettingsSection] = useState<SettingsSection>(initialSection);

  // Buffered edits (theme, prompt, toggles) are discarded on close — warn
  // before silently throwing away work like a hand-written system prompt.
  const dirty = open && JSON.stringify(local) !== JSON.stringify(settings);
  const requestClose = () => {
    if (dirty && !window.confirm("Discard unsaved settings changes?")) return;
    onClose();
  };
  const requestOnboarding = () => {
    if (dirty && !window.confirm("Discard unsaved settings changes?")) return;
    onOpenOnboarding();
  };

  useEffect(() => {
    if (open) {
      setLocal(settings);
      onThemePreview(settings.theme);
      setSettingsSection(initialSection);
    }
  }, [initialSection, onThemePreview, open, settings]);

  useEffect(() => {
    if (open && initialSection === "general" && appUpdater.phase === "available") {
      setSettingsSection("updates");
    }
  }, [appUpdater.phase, initialSection, open]);

  const dialogRef = useRef<HTMLDivElement>(null);
  useModalFocus(dialogRef, open);

  const requestCloseRef = useRef(requestClose);
  requestCloseRef.current = requestClose;
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") requestCloseRef.current();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
              <div><h3>Instruction prompt</h3><p>Sent as the thread’s complete base instruction. Empty means OpenKiwi supplies no base prompt.</p></div>
            </div>
            <textarea
              className="prompt-editor"
              value={local.systemPrompt}
              onChange={(event) => setLocal({ ...local, systemPrompt: event.target.value })}
              placeholder="Empty — add your own instructions here"
              rows={7}
            />
            <div className="prompt-audit-row">
              <span><Check size={13} /> Base prompt visible</span>
              <span><Check size={13} /> Developer prompt empty</span>
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

          {settingsSection === "projects" && <ProjectOverridesSettings projects={projects} onProjects={onProjects} />}

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
            <div className="settings-section-heading"><div className="settings-icon"><Wrench size={17} /></div><div><h3>Runtime behavior</h3><p>Control project guidance, background alerts, service tier, and terminal memory.</p></div></div>
            <div className="behavior-grid">
              <div><span><strong>AGENTS.md discovery</strong><small>Allow AGENTS.md guidance for project threads (up to 32 KB).</small></span><button type="button" role="switch" aria-checked={local.projectInstructionsEnabled} className={`toggle-switch ${local.projectInstructionsEnabled ? "on" : ""}`} onClick={() => setLocal({ ...local, projectInstructionsEnabled: !local.projectInstructionsEnabled })}><span /></button></div>
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
            <div className={`agent-settings-card ${local.subagentsEnabled ? "enabled" : ""}`}>
              <div className="agent-toggle-copy">
                <strong>Allow sub-agent spawning</strong>
                <small>{local.subagentsEnabled ? "The model may delegate when it decides that parallel work helps." : "No sub-agent tools are exposed to the model."}</small>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={local.subagentsEnabled}
                className={`toggle-switch ${local.subagentsEnabled ? "on" : ""}`}
                onClick={() => setLocal({ ...local, subagentsEnabled: !local.subagentsEnabled })}
              >
                <span />
              </button>
            </div>
            <div className={`agent-limit-row ${local.subagentsEnabled ? "" : "disabled"}`}>
              <div>
                <strong>{local.provider === "claude" ? "Available specialist agents" : "Maximum concurrent sub-agents"}</strong>
                <small>{local.provider === "claude" ? "Choose how many enabled custom profiles OpenKiwi exposes. Claude Code manages native concurrency." : "Choose 1–24 active at once per thread, excluding the root agent."}</small>
              </div>
              <div className="number-stepper" aria-label={local.provider === "claude" ? "Available Claude specialist agents" : "Maximum concurrent sub-agents"}>
                <button type="button" onClick={() => setLocal({ ...local, subagentMax: Math.max(1, local.subagentMax - 1) })} disabled={!local.subagentsEnabled || local.subagentMax <= 1}><Minus size={13} /></button>
                <strong>{local.subagentMax}</strong>
                <button type="button" onClick={() => setLocal({ ...local, subagentMax: Math.min(24, local.subagentMax + 1) })} disabled={!local.subagentsEnabled || local.subagentMax >= 24}><Plus size={13} /></button>
              </div>
            </div>
            <div className="agent-safety-row">
              <span><ShieldCheck size={13} /> Inherits permissions</span>
              <span><Check size={13} /> Direct children only</span>
              <span><Check size={13} /> Off by default</span>
            </div>
          </section>}

          {settingsSection === "models" &&
          <section className="settings-section">
            <div className="settings-section-heading">
              <div className="settings-icon"><KeyRound size={17} /></div>
              <div><h3>Default model provider</h3><p>New threads start with this provider. Each thread keeps its own provider after it starts.</p></div>
            </div>
            <div className="provider-cards">
              <button className={`provider-card ${local.provider === "openai" ? "selected" : ""}`} onClick={() => setLocal({ ...local, provider: "openai", model: local.model.includes("/") || local.model.startsWith("claude-") ? DEFAULT_OPENAI_MODEL : (local.model || DEFAULT_OPENAI_MODEL), ultra: false })}>
                <span className="provider-logo openai"><OpenAILogo size={17} /></span>
                <span><strong>OpenAI</strong><small>Official ChatGPT subscription sign-in</small></span>
                {local.provider === "openai" && <Check size={16} />}
              </button>
              <button className={`provider-card ${local.provider === "openrouter" ? "selected" : ""}`} onClick={() => setLocal({ ...local, provider: "openrouter", model: local.model.includes("/") ? local.model : "", ultra: false })}>
                <span className="provider-logo openrouter"><RotateCcw size={17} /></span>
                <span><strong>OpenRouter</strong><small>Responses-compatible model routing</small></span>
                {local.provider === "openrouter" && <Check size={16} />}
              </button>
              <button className={`provider-card ${local.provider === "claude" ? "selected" : ""}`} onClick={() => setLocal({ ...local, provider: "claude", model: local.model.startsWith("claude-") ? local.model : DEFAULT_CLAUDE_MODEL, ultra: false })}>
                <span className="provider-logo claude"><ClaudeLogo size={17} /></span>
                <span><strong>Claude</strong><small>Official Claude Code subscription login</small></span>
                {local.provider === "claude" && <Check size={16} />}
              </button>
            </div>
            <p className="provider-default-note">Use the provider control above the conversation to choose a different provider for one new thread without changing this default.</p>

            {local.provider === "openai" ? (
              <div className="credential-panel">
                <div>
                  <strong>{account?.type === "chatgpt" ? account.email || "ChatGPT account" : "ChatGPT subscription"}</strong>
                  <small>{account?.type === "chatgpt" ? `${account.planType ?? "ChatGPT"} plan connected` : runtimeStatus?.available ? `Official browser sign-in · ${runtimeStatus.source} detected` : "Codex CLI or ChatGPT for macOS required"}</small>
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
            ) : (
              <div className="credential-panel">
                <div>
                  <strong>{claudeStatus?.loggedIn ? claudeStatus.email || "Claude subscription" : "Claude Code subscription"}</strong>
                  <small>{claudeStatus?.loggedIn
                    ? `${claudeStatus.subscriptionType || claudeStatus.authMethod || "Claude"} plan connected · ${claudeStatus.version || "Claude Code"}`
                    : claudeStatus?.available ? "Claude Code detected · sign in to continue" : "Claude Code must be installed first"}</small>
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
            )}

            <label className="field-label">
              <span>Model</span>
              <input
                value={local.model}
                onChange={(event) => setLocal({ ...local, model: event.target.value })}
                readOnly={local.provider !== "openrouter"}
                placeholder={local.provider === "openrouter" ? "e.g. anthropic/claude-sonnet-4" : local.provider === "claude" ? "Select Fable, Opus, Sonnet, or Haiku below the composer" : "Select Sol, Terra, or Luna below the composer"}
              />
              <small>{local.provider === "openrouter" ? "Use the searchable picker beneath the composer, or enter any valid provider/model slug here." : local.provider === "claude" ? "Use the Claude selector beneath the composer. Availability follows your signed-in Claude Code subscription." : "Use the animated selector beneath the composer. Availability follows the signed-in ChatGPT account."}</small>
            </label>
          </section>}
          </div>
        </div>

        <div className="modal-footer">
          {dirty && <span className="unsaved-hint">Unsaved changes</span>}
          <button className="secondary-button" onClick={requestClose}>Cancel</button>
          <button className="primary-button" onClick={() => onSave({ ...local, subagentMax: Math.min(24, Math.max(1, local.subagentMax)) })}>Save settings</button>
        </div>
      </div>
    </div>
  );
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
    <div className="update-trust-row"><ShieldCheck size={14} /><span><strong>Verified release channel</strong><small>Manifest and packages come from github.com/m17h/OpenKiwi and must match OpenKiwi’s embedded updater key.</small></span></div>
  </section>;
}
