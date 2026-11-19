// The hidden theme preview's window: the app's own chrome, sidebar lists,
// inbox cards, Run control, timeline, landings, composer, model controls,
// the real Tools panel (StudioDock), Settings and the command palette, filled
// with bundled sample content (fixtures.ts). Which of them are drawn comes
// from the job's scene (src/lib/customThemes/previewScenes.ts). Pane widths,
// sidebar tucking and top-bar shedding come from the same rules the app
// window uses. Nothing here is a copy of a view, so a redesign of any of them
// reaches the preview by itself. The page is never shown or given input.
//
// This fixture leaves out the composer’s Sub-agents control, saved prompts
// and dictation, the machine switcher, usage and pull request chips, project
// working/attention counts, and approval or question cards.

import { useCallback, useMemo, useRef, type ComponentType, type CSSProperties, type ReactNode } from "react";
import { Circle, Cpu, GitBranch, GitFork, Keyboard, ListFilter, Palette, PanelLeftClose, PanelRight, Pause, Pencil, Pin, RotateCcw, Search, TextCursorInput } from "lucide-react";
import { AttachButton, ComposerCaption, NewThreadButton, PaletteTrigger, ProjectHeading, RuntimeStatusIndicator, ShowSidebarButton, SidebarBrand, SidebarFooter, shellThemeAttributes, themeEffectNames, ToolsToggleButton } from "../components/AppChrome";
import { CustomThemeStyle } from "../components/CustomThemeStyle";
import { ThemeEffectsLayer } from "../components/ThemeEffectsLayer";
import { ChatsRow, ThreadSearch, ThreadsSection, WorkspaceRow, WorkspacesSection } from "../components/SidebarLists";
import { PinnedWorkspaceGroup } from "../components/PinnedWorkspaceGroup";
import { ThreadInboxCard } from "../components/ThreadInboxCard";
import { ThreadTitle } from "../components/ThreadTitle";
import { RowMenu } from "../components/RowMenu";
import { AppActionMenu } from "../components/AppActionMenu";
import { ProjectRunControl } from "../components/ProjectRunControl";
import { ChecksControl } from "../components/ChecksControl";
import { TimelinePresentation } from "../components/ChatTimeline";
import { TimelineProjectRoot } from "../components/TimelineProjectRoot";
import type { TimelineEnvironment } from "../components/TimelineEnvironment";
import { Composer } from "../components/Composer";
import { PermissionPicker, permissionDescriptions } from "../components/PermissionPicker";
import { ThreadProviderControl } from "../components/ThreadProviderControl";
import { ModelPowerControl } from "../components/ModelPowerControl";
import { ClaudeModelControl } from "../components/ClaudeModelControl";
import { CursorModelControl } from "../components/CursorModelControl";
import { OpenRouterModelControl } from "../components/OpenRouterModelControl";
import { LMStudioModelControl } from "../components/LMStudioModelControl";
import { StudioDock } from "../components/StudioDock";
import { ThreadLanding, WelcomeLanding } from "../components/ThreadLanding";
import { CommandPalette, type PaletteCommand } from "../components/CommandPalette";
import { formatShortcut } from "../lib/shortcuts";
import { useMediaQueryMatch } from "../hooks/useMediaQueryMatch";
import { useTopbarFit } from "../hooks/useTopbarFit";
import { clampPaneSize, NARROW_WINDOW_QUERY, paneFit, paneWidthValue, sidebarTuckedFor, toolsNeedOverlay, useWindowWidth } from "../hooks/usePaneResize";
import { providerDisplayName } from "../lib/childAgents";
import { DEFAULT_CLAUDE_MODEL, DEFAULT_CURSOR_MODEL, DEFAULT_OPENAI_MODEL, DEFAULT_SETTINGS, sanitizeChatFont, sanitizeEffortSlider } from "../lib/appConfig";
import type { PreviewJob } from "../lib/customThemes/previewJob";
import { PREVIEW_SCENES } from "../lib/customThemes/previewScenes";
import type { StudioTab } from "../lib/studioTabs";
import type { ThemeSpec } from "../lib/customThemes/spec";
import type { Provider } from "../types";
import {
  SAMPLE_ACTIVITIES, SAMPLE_CHATS, SAMPLE_CHECK_COMMAND, SAMPLE_FILE_SOURCE, SAMPLE_GIT, SAMPLE_GIT_WORKFLOW, SAMPLE_MCP_SERVERS, SAMPLE_MESSAGES,
  SAMPLE_PALETTE_PROJECTS, SAMPLE_PALETTE_THREADS, SAMPLE_PROJECT, SAMPLE_PROJECTS, SAMPLE_REVIEW_DIFF, SAMPLE_RUN, SAMPLE_SKILLS, SAMPLE_TERMINAL,
  SAMPLE_THREADS, SAMPLE_WORKSPACE_GIT, SAMPLE_WORKTREE, SAMPLE_WORKTREE_STATUS,
} from "./fixtures";

const noop = () => {};
const declined = () => Promise.resolve(false as const);
const PROVIDERS: readonly Provider[] = ["openai", "claude", "cursor", "openrouter", "lmstudio"];

/** Displays sample content without a task store, mailbox, or live actions. */
const SAMPLE_TIMELINE: TimelineEnvironment = Object.freeze({
  canEdit: false,
  canApprove: false,
  canOpenSkills: false,
  openExternalUrl: async () => undefined,
});

function ModelControls({ provider, providerControl }: { provider: Provider; providerControl: ReactNode }) {
  const common = { providerControl, effort: "high" as const, onModel: noop, onEffort: noop };
  if (provider === "claude") return <ClaudeModelControl {...common} model={DEFAULT_CLAUDE_MODEL} signedIn />;
  if (provider === "cursor") return <CursorModelControl {...common} model={DEFAULT_CURSOR_MODEL} models={[]} onRefresh={noop} />;
  if (provider === "openrouter") return <OpenRouterModelControl {...common} model="openrouter/auto" models={[]} loading={false} error="" onRefresh={noop} />;
  if (provider === "lmstudio") return <LMStudioModelControl {...common} model="local-model" models={[]} loading={false} error="" onRefresh={noop} />;
  return <ModelPowerControl {...common} model={DEFAULT_OPENAI_MODEL} fast={false} runtimeModels={[]} signedIn onFast={noop} />;
}

/** The real Tools panel on the scene's tab, fed sample data and passive handlers. */
function SampleTools({ open, covered, tab, dockRef, provider }: {
  open: boolean;
  covered: boolean;
  tab: StudioTab;
  dockRef: (node: HTMLElement | null) => void;
  provider: Provider;
}) {
  const worktree = tab === "worktrees" ? SAMPLE_WORKTREE : undefined;
  return <StudioDock
    open={open}
    covered={covered}
    rootRef={dockRef}
    onResizeStart={noop}
    tab={tab}
    projectName={SAMPLE_PROJECT.name}
    projectPath={worktree?.path ?? SAMPLE_PROJECT.path}
    fileSource={SAMPLE_FILE_SOURCE}
    activeThread
    activeThreadId={SAMPLE_THREADS[0]!.id}
    reviewDiff={SAMPLE_REVIEW_DIFF}
    initialChangesMode="diff"
    changesScope="working"
    checksControl={<ChecksControl command={SAMPLE_CHECK_COMMAND} running={false} result={null} onRun={noop} onStop={noop} onSave={noop} onAddFeedback={noop} />}
    agents={[]}
    terminalOutput={SAMPLE_TERMINAL}
    terminalRunning={false}
    terminalRunningCommand=""
    terminalRunningElsewhere={[]}
    commandsReadOnly={false}
    checkpoints={[]}
    worktree={worktree}
    worktreeStatus={worktree ? SAMPLE_WORKTREE_STATUS : undefined}
    usage={null}
    nativeAgentLinks={{}}
    managedAgentLinks={{}}
    usageProvider={provider}
    visibleAttachments={{ images: 0, documents: 0, files: 0 }}
    skills={SAMPLE_SKILLS}
    mcpServers={SAMPLE_MCP_SERVERS}
    gitOutput=""
    gitCommitSuccess=""
    gitCommitBusy={false}
    gitRepositoryState="ready"
    gitInitializing={false}
    githubAuthenticated={false}
    githubRepoStatus={null}
    gitActionsReadOnly={false}
    defaultRepositoryName={SAMPLE_PROJECT.name}
    promptAudit={[]}
    projectActions={[]}
    workflows={[]}
    workflowRuns={[]}
    projectGitInspection={SAMPLE_GIT}
    gitWorkflow={SAMPLE_GIT_WORKFLOW}
    projectRun={SAMPLE_RUN}
    projectRunRunning={false}
    // Inert stand-ins, so Run and the Settings links draw enabled as in the app.
    onProjectRun={noop}
    onProjectRunStop={noop}
    onOpenSettings={noop}
    onTab={noop} onClose={noop} onRefreshDiff={noop} onReview={noop} onOpenAgent={noop} onStopAgent={noop}
    onRunTerminal={noop} onStopTerminal={noop} onClearTerminal={noop} onTerminalInput={noop} onTerminalResize={noop}
    onCheckpoint={noop} onFork={noop} onCheckpointRestore={noop} onCheckpointAccept={noop} onCheckpointPreview={noop} onCheckpointDelete={noop}
    onRollback={noop} onWorktreeReview={noop} onWorktreeApply={noop} onWorktreeMerge={noop} onWorktreeReveal={noop} onWorktreeRefresh={noop}
    onWorktreeRemove={noop} onWorktreeRecreate={noop} onWorktreeContinueShared={noop} onRefreshUsage={noop} onCompact={noop} onRefreshTools={noop}
    onGitAction={noop} onInitializeGit={noop} onGitHubAttach={noop} onGitHubCreate={noop} onOpenGitHubSettings={noop} onGitPathAction={noop}
    onAttachPath={noop} onProjectAction={noop} onRunWorkflow={noop} onStopWorkflow={noop} onOpenWorkflowRun={noop} onToggleSkill={noop} onConnectMcp={noop}
  />;
}

/**
 * Representative rows of the app's own palette commands (App.tsx builds the
 * live list from app state), with the same labels, groups, icons and
 * shortcuts. Choosing one does nothing.
 */
const SAMPLE_COMMANDS: PaletteCommand[] = [
  { id: "focus-composer", label: "Focus message box", icon: TextCursorInput, shortcut: formatShortcut("focusComposer"), run: noop },
  { id: "model-picker", label: "Choose model…", icon: Cpu, shortcut: formatShortcut("modelPicker"), run: noop },
  { id: "search-conversation", label: "Search in conversation", icon: Search, shortcut: formatShortcut("searchConversation"), run: noop },
  { id: "toggle-sidebar", label: "Hide sidebar", icon: PanelLeftClose, shortcut: formatShortcut("toggleSidebar"), run: noop },
  { id: "toggle-workspace", label: "Show Tools", icon: PanelRight, shortcut: formatShortcut("toggleWorkspace"), run: noop },
  { id: "shortcuts", label: "Keyboard shortcuts", icon: Keyboard, shortcut: formatShortcut("shortcuts"), run: noop },
  { id: "reset-theme", label: "Reset to default theme", group: "Appearance", icon: RotateCcw, shortcut: formatShortcut("resetTheme"), run: noop },
  { id: "theme-motion", label: "Pause theme animations", group: "Appearance", icon: Pause, run: noop },
  { id: "theme-library", label: "Open theme library", group: "Appearance", icon: Palette, run: noop },
  { id: "thread-rename", label: "Rename thread", group: "Thread", icon: Pencil, run: noop },
  { id: "thread-pin", label: "Pin thread", group: "Thread", icon: Pin, run: noop },
  { id: "thread-fork", label: "Fork thread", group: "Thread", icon: GitFork, run: noop },
];

/** The command palette as ⌘K opens it, listing sample commands, projects and threads. */
function SamplePalette() {
  return <CommandPalette open projects={SAMPLE_PALETTE_PROJECTS} threads={SAMPLE_PALETTE_THREADS} workflows={[]} projectActive commands={SAMPLE_COMMANDS}
    onClose={noop} onProject={noop} onThread={noop} onWorkflow={noop} onNewThread={noop} onSettings={noop} onTool={noop} onGitRoute={noop} />;
}

export function PreviewSurface({ job, spec, snapshot, Overlay, composerKey, showSidebar = false }: {
  job: PreviewJob;
  spec: ThemeSpec | null;
  snapshot: { time: number; grainUrl: string };
  /** A scene's overlay loaded ahead of the first render (Settings). */
  Overlay?: ComponentType<{ job: PreviewJob }>;
  /** The composer's draft key; main.tsx seeds a sample draft under it when Send is previewed. */
  composerKey: string;
  /** A sidebar control was asked for: show the sidebar whatever the saved panes say. */
  showSidebar?: boolean;
}) {
  const scene = PREVIEW_SCENES[job.view] ?? PREVIEW_SCENES.conversation;
  const custom = spec ? job.theme.custom : null;
  const provider = PROVIDERS.includes(job.provider) ? job.provider : "openai";
  const chatFont = sanitizeChatFont(job.chatFont);
  const builtInFont = chatFont.startsWith("custom:") ? "system" : chatFont;
  const inProject = scene.chrome === "project";
  const inChats = scene.chrome === "chats";
  const hasWorkspace = scene.chrome !== "welcome";
  const toolsOpen = Boolean(scene.tools);
  const worktree = scene.tools === "worktrees" ? SAMPLE_WORKTREE : undefined;
  const modalOpen = scene.overlay === "settings-appearance";
  const motion = job.motion.animate && spec?.motion?.enabled !== false ? "on" : "paused";
  const current = scene.stage === "conversation" ? SAMPLE_THREADS.find((thread) => thread.current) ?? SAMPLE_THREADS[0]! : null;
  const pinned = SAMPLE_PROJECTS.filter((project) => project.pinned);
  const unpinned = SAMPLE_PROJECTS.filter((project) => !project.pinned);
  const permissionRef = useRef<HTMLDivElement>(null);
  const topbarRef = useRef<HTMLElement>(null);
  useTopbarFit(topbarRef);
  // The app window's saved pane preferences, fitted to this window by the
  // app's own rules (usePaneResize, App's sidebar tucking).
  const windowWidth = useWindowWidth();
  const sizes = { sidebar: clampPaneSize("sidebar", job.panes.sidebar), dock: clampPaneSize("dock", job.panes.dock) };
  const sidebarOpen = showSidebar || job.panes.sidebarOpen !== false;
  const narrow = useMediaQueryMatch(NARROW_WINDOW_QUERY);
  const { sidebarCrowded, dockMax } = paneFit(windowWidth, job.uiScale, sizes, { sidebarOpen, sidebarTucked: narrow && toolsOpen, dockOpen: toolsOpen });
  const sidebarTucked = sidebarTuckedFor(narrow, sidebarCrowded, toolsOpen);
  const sidebarPeeking = showSidebar && sidebarTucked;
  const sidebarShown = sidebarPeeking || (sidebarOpen && !sidebarTucked);
  const dockAuto = job.panes.dockAuto !== false;
  const dockRef = useCallback((node: HTMLElement | null) => {
    node?.style.setProperty("--dock-width", paneWidthValue(sizes.dock, dockAuto, dockMax));
  }, [sizes.dock, dockAuto, dockMax]);
  const providerControl = <ThreadProviderControl provider={provider} defaultProvider={provider} threadStarted={Boolean(current)} onProvider={noop} onDefaultSettings={noop} />;
  const logos = {
    openai: job.logos?.openai ?? DEFAULT_SETTINGS.openAiLogo,
    claude: job.logos?.claude ?? DEFAULT_SETTINGS.claudeLogo,
    cursor: job.logos?.cursor ?? DEFAULT_SETTINGS.cursorLogo,
  };
  const projectRow = (project: (typeof SAMPLE_PROJECTS)[number]) => (
    <WorkspaceRow key={project.id} name={project.name} title={project.name} label={project.name} pinned={project.pinned} scale={job.uiScale}
      className={inProject && project.name === SAMPLE_PROJECT.name ? "active" : ""} menu={[{ label: "Rename", icon: <Pencil size={13} />, onSelect: noop }]} onOpen={noop} />
  );
  const currentId = current?.id;
  const threadList = useMemo(() => {
    if (!hasWorkspace) return null;
    const rows: ReadonlyArray<{ id: string; title: string; pinned?: boolean; scheduled?: number; unread?: boolean }> = inChats ? SAMPLE_CHATS.map((chat) => ({ ...chat, pinned: false, scheduled: 0, unread: false })) : SAMPLE_THREADS;
    return rows.map((thread) => {
      const selected = thread.id === currentId;
      return <div key={thread.id} className={`thread-row-wrap ${selected ? "active" : ""}`}>
        <ThreadInboxCard threadId={thread.id} title={thread.title} workspaceName={inChats ? "Chats" : SAMPLE_PROJECT.name} directory={inChats ? "" : SAMPLE_PROJECT.path}
          provider={provider} providerName={providerDisplayName(provider)} pinned={Boolean(thread.pinned)} scheduledPromptCount={thread.scheduled ?? 0}
          current={selected} presence={{ status: "idle", approvals: 0, unread: Boolean(thread.unread) }} onOpen={noop} />
        <RowMenu label={`Options for ${thread.title}`} scale={job.uiScale} items={[]} />
      </div>;
    });
  }, [provider, job.uiScale, hasWorkspace, inChats, currentId]);
  const workspaceLabel = inChats ? "Chats" : SAMPLE_PROJECT.name;
  const heading = inChats ? { name: "Chats", detail: "New chat" as ReactNode }
    : !inProject ? { name: "No project selected", detail: "Choose a project or use Chats" as ReactNode }
      : worktree ? { name: SAMPLE_PROJECT.name, detail: `${worktree.branch} · ${worktree.path}`, detailTitle: worktree.path }
      : current ? { name: SAMPLE_PROJECT.name, detail: <ThreadTitle title={current.title} pending={false} /> }
        : { name: SAMPLE_PROJECT.name, detail: <>New thread <span className="project-heading-path">· {SAMPLE_PROJECT.path}</span></>, detailTitle: SAMPLE_PROJECT.path };

  return (
    <div className="app-shell" inert data-tools-overlay={toolsNeedOverlay(windowWidth, job.uiScale) || undefined}
      data-effort-slider={sanitizeEffortSlider(job.effortSlider)}
      {...shellThemeAttributes({
        base: job.theme.base, customThemeId: custom?.id, motion, effects: themeEffectNames(spec), provider,
        chatFont: builtInFont, logos, uiScale: job.uiScale,
      })}>
      <CustomThemeStyle spec={spec} id={custom?.id} revision={custom?.revision} />
      <ThemeEffectsLayer spec={spec} id={custom?.id} motion={motion} snapshot={snapshot} />

      {sidebarPeeking && <div className="sidebar-peek-scrim" aria-hidden="true" />}
      <aside className={`sidebar ${sidebarShown ? "open" : "closed"}${sidebarPeeking ? " peek" : ""}`} inert={!sidebarShown || modalOpen || undefined} style={{ "--sidebar-width": paneWidthValue(sizes.sidebar, false, Infinity) } as CSSProperties}>
        <SidebarBrand onHide={noop} />
        <NewThreadButton onClick={noop} disabled={!hasWorkspace} title={inChats ? "Start a chat without a project folder" : inProject ? `Start a thread in ${SAMPLE_PROJECT.name}` : "Select a workspace first"} />
        <div className="sidebar-sections">
          <div className="sidebar-machine-lists">
            <WorkspacesSection onAdd={noop}>
              <ChatsRow active={inChats} onOpen={noop} label="Chats" />
              {pinned.length > 0 && <PinnedWorkspaceGroup count={pinned.length} containsActiveWorkspace={inProject && pinned.some((project) => project.name === SAMPLE_PROJECT.name)}>{pinned.map(projectRow)}</PinnedWorkspaceGroup>}
              {unpinned.map(projectRow)}
            </WorkspacesSection>
            <div className="sidebar-section-resize" role="separator" aria-orientation="horizontal" aria-label="Resize projects and threads" />
            <ThreadsSection
              menu={hasWorkspace && <RowMenu label="Filter threads and list actions" title="Filter threads: main, sub-agent or archived" icon={<ListFilter size={14} />} scale={job.uiScale} items={[]} />}
              search={hasWorkspace && <ThreadSearch value="" onChange={noop} placeholder={`Search ${inChats ? "chats" : SAMPLE_PROJECT.name}…`} />}
              list={threadList}
            />
          </div>
        </div>
        <SidebarFooter label="Settings" onOpen={noop} />
      </aside>

      <main className="main-panel" inert={modalOpen || sidebarPeeking || undefined}>
        <div className="local-machine-surface">
          <header className="topbar" ref={topbarRef}>
            <div className="topbar-left">
              {!sidebarShown && <ShowSidebarButton tucked={sidebarTucked} onShow={noop} />}
              <ProjectHeading name={heading.name} detail={heading.detail} detailTitle={"detailTitle" in heading ? heading.detailTitle : undefined} />
              {worktree && <button type="button" className="isolation-chip" onClick={noop} title={worktree.path}>
                <GitBranch size={12} /> <span>Isolated</span>
              </button>}
            </div>
            <div className="topbar-right">
              <RuntimeStatusIndicator kind="ready" word="Ready" icon={<Circle size={8} fill="currentColor" aria-hidden="true" />} />
              {inProject && <ProjectRunControl projectName={SAMPLE_PROJECT.name} run={SAMPLE_RUN} running={false} onRun={noop} onStop={noop} onSave={noop} />}
              <PaletteTrigger onClick={noop} />
              {current && <div className="thread-menu">
                <AppActionMenu compact descriptions="tooltip" label="Thread actions" ariaLabel="Thread and project actions" triggerTitle="Thread and project actions"
                  items={[
                    { id: "rename", label: "Rename thread", icon: <Pencil size={14} />, onSelect: noop },
                    { id: "fork", label: "Fork thread", icon: <GitFork size={14} />, onSelect: noop },
                  ]} />
              </div>}
              {inProject && <ToolsToggleButton open={toolsOpen} onClick={noop} />}
            </div>
          </header>
          <div className="app-checkpoint-notice-stack">
            <div className="checkpoint-git-toast-region" aria-live="polite" />
          </div>

          {!hasWorkspace ? <WelcomeLanding onOpenProject={noop} onOpenChats={noop} /> : <>
          <section className="conversation">
            {scene.stage === "conversation" ? (
              <TimelineProjectRoot.Provider value={worktree?.path ?? SAMPLE_PROJECT.path}>
                <TimelinePresentation environment={SAMPLE_TIMELINE} messages={SAMPLE_MESSAGES} activities={SAMPLE_ACTIVITIES} running={false}
                  thinkingLabel={`Working in ${SAMPLE_PROJECT.name}`} provider={provider} />
              </TimelineProjectRoot.Provider>
            ) : (
              <ThreadLanding
                isChat={inChats}
                project={inChats ? undefined : SAMPLE_PROJECT}
                isolation={inChats ? undefined : { isolated: false, onChange: noop, git: SAMPLE_WORKSPACE_GIT, initializing: false, onInitializeGit: noop }}
                onOpenTool={inChats ? undefined : noop}
                logoMotionSnapshot={job.motion.reducedMotion ? "still" : "idle"}
              />
            )}
          </section>

          <section className={`composer-zone ambiance-${provider}`}>
            <Composer
              threadKey={composerKey}
              chatFont={builtInFont}
              running={false}
              queueing={false}
              canSteer={false}
              dropActive={false}
              placeholder={inChats ? "Ask anything…" : `Ask Mythra Code to work in ${workspaceLabel}…`}
              attachments={[]}
              onRemoveAttachment={noop}
              onPasteImages={noop}
              onSend={declined}
              onSteer={declined}
              onSchedule={declined}
              scheduleContextLabel={current ? "Joins this thread's queue; never interrupts a running task." : `Starts a new ${providerDisplayName(provider)} thread with these settings.`}
              onStop={noop}
              modelControls={<ModelControls provider={provider} providerControl={providerControl} />}
              controls={<>
                <PermissionPicker value="ask" open={false} rootRef={permissionRef} description={permissionDescriptions(provider)} onOpenChange={noop} onChange={noop} />
                <AttachButton count={0} onClick={noop} />
              </>}
            />
            <ComposerCaption contextPercent={current ? 18 : null} costEstimate={current ? "$0.04" : null} />
          </section>
          </>}
        </div>
      </main>

      {inProject && <SampleTools open={toolsOpen} covered={modalOpen || sidebarPeeking} tab={scene.tools ?? "changes"} dockRef={dockRef} provider={provider} />}
      {scene.overlay === "command-palette" && <SamplePalette />}
      {scene.overlay === "settings-appearance" && Overlay && <Overlay job={job} />}
    </div>
  );
}
