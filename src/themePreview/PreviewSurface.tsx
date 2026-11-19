// The hidden theme preview's window: the app's own chrome, sidebar lists,
// inbox cards, Run control, timeline, composer, model controls and the real
// Tools panel (StudioDock → GitPanel → the Changes diff), filled with bundled
// sample content (fixtures.ts). Pane widths, sidebar tucking and top-bar
// shedding come from the same rules the app window uses. Nothing here is a
// copy of a view, so a redesign of any of them reaches the preview by
// itself. The page is never shown or given input.
//
// This fixture leaves out the composer’s Sub-agents control, saved prompts
// and dictation, the machine switcher, usage and pull request chips, project
// working/attention counts, and approval or question cards.

import { useCallback, useMemo, useRef, type CSSProperties, type ReactNode } from "react";
import { Circle, GitFork, ListFilter, Pencil } from "lucide-react";
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
import type { TerminalOutputStore } from "../hooks/useTerminal";
import { useMediaQueryMatch } from "../hooks/useMediaQueryMatch";
import { useTopbarFit } from "../hooks/useTopbarFit";
import { clampPaneSize, NARROW_WINDOW_QUERY, paneFit, paneWidthValue, sidebarTuckedFor, toolsNeedOverlay, useWindowWidth } from "../hooks/usePaneResize";
import { providerDisplayName } from "../lib/childAgents";
import { DEFAULT_CLAUDE_MODEL, DEFAULT_CURSOR_MODEL, DEFAULT_OPENAI_MODEL, DEFAULT_SETTINGS, sanitizeChatFont, sanitizeEffortSlider } from "../lib/appConfig";
import type { PreviewJob } from "../lib/customThemes/previewJob";
import type { ThemeSpec } from "../lib/customThemes/spec";
import type { Provider } from "../types";
import { SAMPLE_ACTIVITIES, SAMPLE_CHECK_COMMAND, SAMPLE_GIT, SAMPLE_GIT_WORKFLOW, SAMPLE_MESSAGES, SAMPLE_PROJECT, SAMPLE_PROJECTS, SAMPLE_REVIEW_DIFF, SAMPLE_RUN, SAMPLE_THREADS } from "./fixtures";

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

const NO_TERMINAL: TerminalOutputStore = {
  appendedLength: () => 0,
  read: (cursor) => ({ text: "", cursor }),
  generation: () => 0,
  subscribe: () => noop,
};

function ModelControls({ provider, providerControl }: { provider: Provider; providerControl: ReactNode }) {
  const common = { providerControl, effort: "high" as const, onModel: noop, onEffort: noop };
  if (provider === "claude") return <ClaudeModelControl {...common} model={DEFAULT_CLAUDE_MODEL} signedIn />;
  if (provider === "cursor") return <CursorModelControl {...common} model={DEFAULT_CURSOR_MODEL} models={[]} onRefresh={noop} />;
  if (provider === "openrouter") return <OpenRouterModelControl {...common} model="openrouter/auto" models={[]} loading={false} error="" onRefresh={noop} />;
  if (provider === "lmstudio") return <LMStudioModelControl {...common} model="local-model" models={[]} loading={false} error="" onRefresh={noop} />;
  return <ModelPowerControl {...common} model={DEFAULT_OPENAI_MODEL} fast={false} runtimeModels={[]} signedIn onFast={noop} />;
}

/** The real Tools panel on Changes, fed sample Git data and passive handlers. */
function SampleTools({ open, dockRef, provider }: { open: boolean; dockRef: (node: HTMLElement | null) => void; provider: Provider }) {
  return <StudioDock
    open={open}
    rootRef={dockRef}
    onResizeStart={noop}
    tab="changes"
    projectName={SAMPLE_PROJECT.name}
    projectPath={SAMPLE_PROJECT.path}
    activeThread
    activeThreadId={SAMPLE_THREADS[0]!.id}
    reviewDiff={SAMPLE_REVIEW_DIFF}
    initialChangesMode="diff"
    changesScope="working"
    checksControl={<ChecksControl command={SAMPLE_CHECK_COMMAND} running={false} result={null} onRun={noop} onStop={noop} onSave={noop} onAddFeedback={noop} />}
    agents={[]}
    terminalOutput={NO_TERMINAL}
    terminalRunning={false}
    terminalRunningCommand=""
    terminalRunningElsewhere={[]}
    commandsReadOnly={false}
    checkpoints={[]}
    usage={null}
    nativeAgentLinks={{}}
    managedAgentLinks={{}}
    usageProvider={provider}
    visibleAttachments={{ images: 0, documents: 0, files: 0 }}
    skills={[]}
    mcpServers={[]}
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
    onTab={noop} onClose={noop} onRefreshDiff={noop} onReview={noop} onOpenAgent={noop} onStopAgent={noop}
    onRunTerminal={noop} onStopTerminal={noop} onClearTerminal={noop} onTerminalInput={noop} onTerminalResize={noop}
    onCheckpoint={noop} onFork={noop} onCheckpointRestore={noop} onCheckpointAccept={noop} onCheckpointPreview={noop} onCheckpointDelete={noop}
    onRollback={noop} onWorktreeReview={noop} onWorktreeApply={noop} onWorktreeMerge={noop} onWorktreeReveal={noop} onWorktreeRefresh={noop}
    onWorktreeRemove={noop} onWorktreeRecreate={noop} onWorktreeContinueShared={noop} onRefreshUsage={noop} onCompact={noop} onRefreshTools={noop}
    onGitAction={noop} onInitializeGit={noop} onGitHubAttach={noop} onGitHubCreate={noop} onOpenGitHubSettings={noop} onGitPathAction={noop}
    onAttachPath={noop} onProjectAction={noop} onRunWorkflow={noop} onStopWorkflow={noop} onOpenWorkflowRun={noop} onToggleSkill={noop} onConnectMcp={noop}
  />;
}

export function PreviewSurface({ job, spec, snapshot }: { job: PreviewJob; spec: ThemeSpec | null; snapshot: { time: number; grainUrl: string } }) {
  const custom = spec ? job.theme.custom : null;
  const provider = PROVIDERS.includes(job.provider) ? job.provider : "openai";
  const chatFont = sanitizeChatFont(job.chatFont);
  const builtInFont = chatFont.startsWith("custom:") ? "system" : chatFont;
  const toolsOpen = job.view === "changes";
  const motion = job.motion.animate && spec?.motion?.enabled !== false ? "on" : "paused";
  const current = SAMPLE_THREADS.find((thread) => thread.current) ?? SAMPLE_THREADS[0]!;
  const pinned = SAMPLE_PROJECTS.filter((project) => project.pinned);
  const unpinned = SAMPLE_PROJECTS.filter((project) => !project.pinned);
  const permissionRef = useRef<HTMLDivElement>(null);
  const topbarRef = useRef<HTMLElement>(null);
  useTopbarFit(topbarRef);
  // The app window's saved pane preferences, fitted to this window by the
  // app's own rules (usePaneResize, App's sidebar tucking).
  const windowWidth = useWindowWidth();
  const sizes = { sidebar: clampPaneSize("sidebar", job.panes.sidebar), dock: clampPaneSize("dock", job.panes.dock) };
  const sidebarOpen = job.panes.sidebarOpen !== false;
  const narrow = useMediaQueryMatch(NARROW_WINDOW_QUERY);
  const { sidebarCrowded, dockMax } = paneFit(windowWidth, job.uiScale, sizes, { sidebarOpen, sidebarTucked: narrow && toolsOpen, dockOpen: toolsOpen });
  const sidebarTucked = sidebarTuckedFor(narrow, sidebarCrowded, toolsOpen);
  const sidebarShown = sidebarOpen && !sidebarTucked;
  const dockAuto = job.panes.dockAuto !== false;
  const dockRef = useCallback((node: HTMLElement | null) => {
    node?.style.setProperty("--dock-width", paneWidthValue(sizes.dock, dockAuto, dockMax));
  }, [sizes.dock, dockAuto, dockMax]);
  const providerControl = <ThreadProviderControl provider={provider} defaultProvider={provider} threadStarted onProvider={noop} onDefaultSettings={noop} />;
  const logos = {
    openai: job.logos?.openai ?? DEFAULT_SETTINGS.openAiLogo,
    claude: job.logos?.claude ?? DEFAULT_SETTINGS.claudeLogo,
    cursor: job.logos?.cursor ?? DEFAULT_SETTINGS.cursorLogo,
  };
  const projectRow = (project: (typeof SAMPLE_PROJECTS)[number]) => (
    <WorkspaceRow key={project.id} name={project.name} title={project.name} label={project.name} pinned={project.pinned} scale={job.uiScale}
      className={project.name === SAMPLE_PROJECT.name ? "active" : ""} menu={[{ label: "Rename", icon: <Pencil size={13} />, onSelect: noop }]} onOpen={noop} />
  );
  const threadList = useMemo(() => SAMPLE_THREADS.map((thread) => (
    <div key={thread.id} className={`thread-row-wrap ${thread.current ? "active" : ""}`}>
      <ThreadInboxCard threadId={thread.id} title={thread.title} workspaceName={SAMPLE_PROJECT.name} directory={SAMPLE_PROJECT.path}
        provider={provider} providerName={providerDisplayName(provider)} pinned={Boolean(thread.pinned)} scheduledPromptCount={thread.scheduled ?? 0}
        current={Boolean(thread.current)} presence={{ status: "idle", approvals: 0, unread: Boolean(thread.unread) }} onOpen={noop} />
      <RowMenu label={`Options for ${thread.title}`} scale={job.uiScale} items={[]} />
    </div>
  )), [provider, job.uiScale]);

  return (
    <div className="app-shell" inert data-tools-overlay={toolsNeedOverlay(windowWidth, job.uiScale) || undefined}
      data-effort-slider={sanitizeEffortSlider(job.effortSlider)}
      {...shellThemeAttributes({
        base: job.theme.base, customThemeId: custom?.id, motion, effects: themeEffectNames(spec), provider,
        chatFont: builtInFont, logos, uiScale: job.uiScale,
      })}>
      <CustomThemeStyle spec={spec} id={custom?.id} revision={custom?.revision} />
      <ThemeEffectsLayer spec={spec} id={custom?.id} motion={motion} snapshot={snapshot} />

      <aside className={`sidebar ${sidebarShown ? "open" : "closed"}`} inert={sidebarShown ? undefined : true} style={{ "--sidebar-width": paneWidthValue(sizes.sidebar, false, Infinity) } as CSSProperties}>
        <SidebarBrand onHide={noop} />
        <NewThreadButton onClick={noop} title={`Start a thread in ${SAMPLE_PROJECT.name}`} />
        <div className="sidebar-sections">
          <div className="sidebar-machine-lists">
            <WorkspacesSection onAdd={noop}>
              <ChatsRow active={false} onOpen={noop} label="Chats" />
              {pinned.length > 0 && <PinnedWorkspaceGroup count={pinned.length} containsActiveWorkspace={pinned.some((project) => project.name === SAMPLE_PROJECT.name)}>{pinned.map(projectRow)}</PinnedWorkspaceGroup>}
              {unpinned.map(projectRow)}
            </WorkspacesSection>
            <div className="sidebar-section-resize" role="separator" aria-orientation="horizontal" aria-label="Resize projects and threads" />
            <ThreadsSection
              menu={<RowMenu label="Filter threads and list actions" title="Filter threads: main, sub-agent or archived" icon={<ListFilter size={14} />} scale={job.uiScale} items={[]} />}
              search={<ThreadSearch value="" onChange={noop} placeholder={`Search ${SAMPLE_PROJECT.name}…`} />}
              list={threadList}
            />
          </div>
        </div>
        <SidebarFooter label="Settings" onOpen={noop} />
      </aside>

      <main className="main-panel">
        <div className="local-machine-surface">
          <header className="topbar" ref={topbarRef}>
            <div className="topbar-left">
              {!sidebarShown && <ShowSidebarButton tucked={sidebarTucked} onShow={noop} />}
              <ProjectHeading name={SAMPLE_PROJECT.name} detail={<ThreadTitle title={current.title} pending={false} />} />
            </div>
            <div className="topbar-right">
              <RuntimeStatusIndicator kind="ready" word="Ready" icon={<Circle size={8} fill="currentColor" aria-hidden="true" />} />
              <ProjectRunControl projectName={SAMPLE_PROJECT.name} run={SAMPLE_RUN} running={false} onRun={noop} onStop={noop} onSave={noop} />
              <PaletteTrigger onClick={noop} />
              <div className="thread-menu">
                <AppActionMenu compact descriptions="tooltip" label="Thread actions" ariaLabel="Thread and project actions" triggerTitle="Thread and project actions"
                  items={[
                    { id: "rename", label: "Rename thread", icon: <Pencil size={14} />, onSelect: noop },
                    { id: "fork", label: "Fork thread", icon: <GitFork size={14} />, onSelect: noop },
                  ]} />
              </div>
              <ToolsToggleButton open={toolsOpen} onClick={noop} />
            </div>
          </header>
          <div className="app-checkpoint-notice-stack">
            <div className="checkpoint-git-toast-region" aria-live="polite" />
          </div>

          <section className="conversation">
            <TimelineProjectRoot.Provider value={SAMPLE_PROJECT.path}>
              <TimelinePresentation environment={SAMPLE_TIMELINE} messages={SAMPLE_MESSAGES} activities={SAMPLE_ACTIVITIES} running={false}
                thinkingLabel={`Working in ${SAMPLE_PROJECT.name}`} provider={provider} />
            </TimelineProjectRoot.Provider>
          </section>

          <section className={`composer-zone ambiance-${provider}`}>
            <Composer
              threadKey="theme-preview"
              chatFont={builtInFont}
              running={false}
              queueing={false}
              canSteer={false}
              dropActive={false}
              placeholder={`Ask Mythra Code to work in ${SAMPLE_PROJECT.name}…`}
              attachments={[]}
              onRemoveAttachment={noop}
              onPasteImages={noop}
              onSend={declined}
              onSteer={declined}
              onSchedule={declined}
              scheduleContextLabel="Joins this thread's queue; never interrupts a running task."
              onStop={noop}
              modelControls={<ModelControls provider={provider} providerControl={providerControl} />}
              controls={<>
                <PermissionPicker value="ask" open={false} rootRef={permissionRef} description={permissionDescriptions(provider)} onOpenChange={noop} onChange={noop} />
                <AttachButton count={0} onClick={noop} />
              </>}
            />
            <ComposerCaption contextPercent={18} costEstimate="$0.04" />
          </section>
        </div>
      </main>

      <SampleTools open={toolsOpen} dockRef={dockRef} provider={provider} />
    </div>
  );
}
