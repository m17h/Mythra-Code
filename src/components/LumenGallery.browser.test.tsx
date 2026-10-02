import { useState } from "react";
import { render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { commands, page } from "vitest/browser";
import {
  Archive, ArrowUp, Check, ChevronDown, Circle, Download, FileCode2, Folder, MessageSquare, Paperclip, PanelLeftClose,
  PanelRight, Plus, Search, Settings, ShieldCheck, TerminalSquare, UsersRound, X,
} from "lucide-react";
import { themeColorScheme, THEMES } from "../lib/appConfig";
import { EMPTY_REVIEW_DIFF } from "../lib/gitDiff";
import type { StudioTab } from "../lib/studioTabs";
import type { ThemeName } from "../types";
import { AnimatedMythraLogo } from "./AnimatedMythraLogo";
import { CommandPalette } from "./CommandPalette";
import { ModelPowerControl } from "./ModelPowerControl";
import { MythraMark } from "./MythraMark";
import { StudioDock } from "./StudioDock";
import { UpdateNotice } from "./UpdateNotice";
import { ThreadInboxCard } from "./ThreadInboxCard";
import "../styles.css";
import "../styles/lumen/index.css";

/*
 * FIXTURE GALLERY: NOT EVIDENCE OF NATIVE OR PROVIDER BEHAVIOUR.
 * A static composition of the real shell classes, with real components where
 * they render without native services (inbox cards, logo, workbench). It
 * exists to screenshot the Lumen redesign for visual review
 * (test-results/lumen/*.png). It sends nothing and touches no user data. All
 * titles, paths and numbers below are invented sample data.
 */

vi.mock("./XtermPanel", () => ({ XtermPanel: () => null }));

afterEach(async () => {
  await commands.setStreamTestReducedMotion(false);
  await page.viewport(1400, 900);
});

const noop = () => undefined;

function Dock({ open, initial = "checkpoints" }: { open: boolean; initial?: StudioTab }) {
  const [tab, setTab] = useState<StudioTab>(initial);
  return (
    <StudioDock
      open={open} tab={tab} onTab={setTab} projectName="Sample project" projectPath="/sample/project" activeThread reviewDiff={EMPTY_REVIEW_DIFF} agents={[]}
      terminalOutput={{} as never} terminalRunning={false} terminalRunningCommand="" terminalRunningElsewhere={[]}
      commandsReadOnly={false} attachments={[]} usage={{ inputTokens: 48210, outputTokens: 9120, reasoningOutputTokens: 2380, cachedInputTokens: 0 } as never}
      checkpoints={[
        { id: "c2", label: "Run 2 · refactor tests", createdAt: Date.now() - 60_000, status: "completed", accepted: false } as never,
        { id: "c1", label: "Run 1 · initial scaffold", createdAt: Date.now() - 3_600_000, status: "completed", accepted: true } as never,
      ]}
      accountUsage={{ label: "Sample account", summary: "Sample usage · 25% of window" }} skills={[]} mcpServers={[]}
      gitOutput="" gitCommitSuccess="" gitCommitBusy={false} gitRepositoryState="ready" gitInitializing={false}
      githubAuthenticated={false} githubRepoStatus={null} githubRepoError="" gitActionsReadOnly={false}
      defaultRepositoryName="" promptAudit={[{ label: "Model", value: "sample-model" }]} projectActions={[]} workflows={[]} workflowRuns={[]}
      onClose={noop} onRefreshDiff={noop} onReview={noop} onOpenAgent={noop} onStopAgent={noop} onRunTerminal={noop}
      onStopTerminal={noop} onClearTerminal={noop} onTerminalInput={noop} onTerminalResize={noop} onCheckpoint={noop}
      onFork={noop} onCheckpointRestore={noop} onCheckpointAccept={noop} onCheckpointPreview={noop} onCheckpointDelete={noop}
      onRollback={noop} onWorktreeReview={noop} onWorktreeApply={noop} onWorktreeMerge={noop} onWorktreeReveal={noop}
      onWorktreeRefresh={noop} onWorktreeRemove={noop} onWorktreeRecreate={noop} onWorktreeContinueShared={noop}
      onAddAttachment={noop} onRemoveAttachment={noop} onRefreshUsage={noop} onCompact={noop} onRefreshTools={noop}
      onGitAction={noop} onInitializeGit={noop} onGitHubAttach={noop} onGitHubCreate={noop} onOpenGitHubSettings={noop}
      onGitPathAction={noop} onAttachPath={noop} onProjectAction={noop} onRunWorkflow={noop} onStopWorkflow={noop}
      onOpenWorkflowRun={noop} onToggleSkill={noop} onConnectMcp={noop}
    />
  );
}

function Sidebar() {
  const threads = [
    { id: "g1", title: "Refactor the settings sheet", provider: "openai" as const },
    { id: "g2", title: "Investigate flaky timeline test", provider: "claude" as const },
    { id: "g3", title: "Draft release notes", provider: "cursor" as const },
    { id: "g4", title: "Explore model routing ideas", provider: "openrouter" as const },
  ];
  return (
    <aside className="sidebar open">
      <div className="sidebar-brand">
        <div className="brand-mark"><MythraMark /></div>
        <span>Mythra Code</span>
        <button className="icon-button subtle collapse-button" aria-label="Hide sidebar"><PanelLeftClose size={17} /></button>
      </div>
      <button className="new-thread-button"><Plus size={16} /><span>New thread</span><kbd>⌘+N</kbd></button>
      <div className="sidebar-sections">
        <div className="sidebar-section workspaces-section">
          <div className="section-label-row"><span className="section-label">Workspaces</span><button className="icon-button tiny" aria-label="Add project"><Plus size={14} /></button></div>
          <div className="workspace-list">
            <button className="workspace-row chat"><span className="workspace-icon chat"><MessageSquare size={14} /></span><span className="workspace-name">Chats</span></button>
            <div className="workspace-row-wrap active"><button className="workspace-row"><span className="workspace-icon"><Folder size={14} /></span><span className="workspace-name">Sample project</span><span className="workspace-thread-count">4</span></button></div>
            <div className="workspace-row-wrap"><button className="workspace-row"><span className="workspace-icon"><Folder size={14} /></span><span className="workspace-name">Another sample</span><span className="workspace-thread-count">2</span></button></div>
          </div>
        </div>
        <div className="sidebar-section-resize" role="separator" aria-label="Resize projects and threads" tabIndex={0} />
        <div className="sidebar-section threads-section">
          <div className="section-label-row">
            <span className="section-label">Threads</span>
            <div className="thread-kind-switch" role="group" aria-label="Thread type"><button className="active">Main <span>4</span></button><button>Sub-agents <span>1</span></button></div>
          </div>
          <div className="thread-search-actions">
            <label className="thread-search"><Search size={11} /><input placeholder="Search Sample project…" /></label>
            <button className="thread-bulk-button"><Archive size={12} /><span>Archive all</span></button>
          </div>
          <div className="thread-list">
            {threads.map((thread, index) => (
              <div key={thread.id} className={`thread-row-wrap ${index === 0 ? "active" : ""}`}>
                <ThreadInboxCard threadId={`gallery-${thread.id}`} title={thread.title} workspaceName="Sample project" directory="/sample/project" provider={thread.provider} providerName={thread.provider} pinned={index === 1} onOpen={noop} />
              </div>
            ))}
          </div>
        </div>
      </div>
      <div className="sidebar-footer"><button className="sidebar-settings"><Settings size={16} /><span>Settings</span><span className="provider-dot openai" /></button></div>
    </aside>
  );
}

function Topbar() {
  return (
    <header className="topbar">
      <div className="topbar-left">
        <div className="project-heading"><span>Sample project</span><small>/sample/project</small></div>
        <button className="project-prompt-trigger"><FileCode2 size={13} /><span>Prompt</span><small>App</small><ChevronDown size={12} /></button>
      </div>
      <div className="topbar-right">
        <button className="icon-button topbar-export-button" aria-label="Export"><Download size={15} /></button>
        <button className="command-palette-trigger"><Search size={13} /><span>Search</span><kbd>⌘+K</kbd></button>
        <div className="runtime-status"><Circle size={8} fill="currentColor" /><span>Ready</span></div>
        <button className="workspace-tools-trigger studio-toggle active"><PanelRight size={17} /><span>Workspace</span><kbd>⌘+J</kbd></button>
      </div>
    </header>
  );
}

function Composer({ rail = false }: { rail?: boolean }) {
  return (
    <section className="composer-zone ambiance-openai">
      <div className="composer">
        <div className="composer-input-wrap"><textarea aria-label="Message" placeholder="Ask Mythra Code to work in Sample project…" rows={1} /></div>
        {rail && <ModelPowerControl model="gpt-5.6-sol" effort="high" fast={false} runtimeModels={[]} signedIn onModel={noop} onEffort={noop} onFast={noop} />}
        <div className="composer-toolbar">
          <div className="composer-controls">
            <div className="permission-control"><button className="toolbar-button"><ShieldCheck size={14} />Ask<ChevronDown size={13} /></button></div>
            <button className="toolbar-button agents-button"><UsersRound size={14} />Agents</button>
            <button className="toolbar-button"><Paperclip size={14} />Attach</button>
          </div>
          <div className="composer-actions"><button className="send-button" aria-label="Send"><ArrowUp size={18} /></button></div>
        </div>
      </div>
      <div className="composer-caption">Mythra Code can make mistakes. Review commands and changes before shipping.</div>
    </section>
  );
}

function Conversation() {
  return (
    <section className="conversation">
      <div className="timeline-shell"><div className="flow-timeline"><div className="timeline-top-space" /><div className="flow-timeline-list">
        <div className="timeline-entry timeline-entry-message"><article className="message user"><div className="message-avatar"><span>You</span></div><div className="message-body"><div className="message-text">Tidy the settings sheet and make the tests pass again.</div></div></article></div>
        <div className="timeline-entry timeline-entry-activity"><div className="activity-row command-activity collapsed"><div className="activity-icon command"><TerminalSquare size={14} /></div><div className="activity-copy"><span>npm run test:browser -- settings</span></div></div></div>
        <div className="timeline-entry timeline-entry-activity"><div className="activity-row collapsed"><div className="activity-icon file"><FileCode2 size={14} /></div><div className="activity-copy"><span>Edited src/components/SettingsModal.tsx</span></div></div></div>
        <div className="timeline-entry timeline-entry-message"><article className="message assistant"><div className="message-avatar provider-openai"><span>AI</span></div><div className="message-body"><div className="rich-markdown">
          <h2>What changed</h2>
          <p>The sheet now uses one card primitive and the narrow layout collapses the navigation into a strip. The <code>set-row</code> grid keeps controls aligned.</p>
          <div className="code-block"><button className="code-copy">Copy</button><pre><code>{"npm run test:browser\n✓ 57 files passed"}</code></pre></div>
          <ul><li>Groups render as rounded cards</li><li>Toggles share one accent track</li></ul>
        </div></div></article></div>
      </div><div className="timeline-bottom-space" /></div></div>
    </section>
  );
}

function Window({ theme, mode, width = 1400, height = 900 }: { theme: ThemeName; mode: "landing" | "conversation"; width?: number; height?: number }) {
  return (
    <div className="app-shell" data-theme={theme} data-color-scheme={themeColorScheme(theme)} style={{ width, height }}>
      <Sidebar />
      <main className="main-panel">
        <Topbar />
        {mode === "landing" ? (
          <section className="conversation">
            <div className="thread-empty-state">
              <AnimatedMythraLogo />
              <h1>What should we build?</h1>
              <p>This thread works inside Sample project. Commands and file changes start in that project folder.</p>
              <div className="trust-strip"><span><Check size={13} /> No app-added system prompt</span><span><Check size={13} /> Local project access</span><span><Check size={13} /> Approval controls</span></div>
              <div className="isolation-choice"><button className="active"><Folder size={15} /><span><strong>Shared project</strong><small>Work directly in Sample project</small></span></button><button><Folder size={15} /><span><strong className="isolated-worktree-title">Isolated worktree</strong><small>Private branch; apply or<br />merge when ready</small></span></button></div>
              <div className="empty-state-actions"><button><FileCode2 size={14} /> Browse files</button><button><TerminalSquare size={14} /> Terminal</button><button><Search size={14} /> Review changes</button></div>
            </div>
          </section>
        ) : <Conversation />}
        <Composer rail={mode === "conversation"} />
      </main>
      <Dock open={mode === "conversation"} />
    </div>
  );
}

function SettingsFixture({ theme }: { theme: ThemeName }) {
  const groups = [
    { group: "App", items: ["General", "Models & accounts", "Usage"] },
    { group: "Work", items: ["Projects", "Prompts", "Skills", "Sub-agents"] },
  ];
  return (
    <div className="app-shell" data-theme={theme} data-color-scheme={themeColorScheme(theme)} style={{ width: 1400, height: 900 }}>
      <div className="modal-backdrop settings-backdrop open">
        <div className="settings-modal" role="dialog" aria-label="Settings">
          <div className="settings-layout">
            <nav className="settings-nav" aria-label="Settings categories">
              <div className="settings-nav-head"><h2>Settings</h2><div className="settings-search"><Search size={13} /><input aria-label="Search settings" placeholder="Search settings" /></div></div>
              <div className="settings-nav-scroll">{groups.map((section) => (
                <div className="settings-nav-group" key={section.group}><span className="settings-nav-label">{section.group}</span>
                  {section.items.map((label, index) => <button key={label} className={section.group === "App" && index === 0 ? "active" : ""}><Settings size={14} /><span>{label}</span></button>)}
                </div>
              ))}</div>
            </nav>
            <div className="settings-pane">
              <header className="settings-pane-heading"><div><h3>General</h3><small>Appearance, interface size and the chat typeface.</small></div><button className="icon-button settings-close" aria-label="Close settings"><X size={17} /></button></header>
              <div className="settings-content">
                <div className="set-group"><h4>Interface</h4><div className="set-card">
                  <div className="set-row"><div className="set-copy"><strong>Compact sidebar</strong><small>Sample setting row for the fixture.</small></div><div className="set-control"><button className="toggle-switch on" aria-label="Compact sidebar"><span /></button></div></div>
                  <div className="set-row"><div className="set-copy"><strong>Show token odometer</strong><small>Another sample row.</small></div><div className="set-control"><button className="toggle-switch" aria-label="Odometer"><span /></button></div></div>
                </div></div>
                <div className="set-group"><h4>Theme</h4><div className="set-card bare"><div className="set-body"><div className="theme-grid">
                  {["Mythra", "Light Mythra", "Kiwi", "Atari"].map((name, index) => <button key={name} className={`theme-card ${index === 0 ? "selected" : ""}`}><span className="theme-preview" style={{ background: "#0c1018" }} /><span><strong>{name}</strong><small>Sample description</small></span>{index === 0 && <Check size={14} />}</button>)}
                </div></div></div></div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function OverlaysFixture({ theme, dialog = true }: { theme: ThemeName; dialog?: boolean }) {
  return (
    <div className="app-shell" data-theme={theme} data-color-scheme={themeColorScheme(theme)} style={{ width: 1400, height: 900 }}>
      <Sidebar />
      <main className="main-panel">
        <Topbar />
        <UpdateNotice update={{ phase: "downloading", availableVersion: "9.9.9-sample", downloadedBytes: 9_000_000, totalBytes: 18_000_000, error: null }} onOpen={noop} />
        <section className="welcome-screen">
          <div className="welcome-orbit"><FileCode2 size={34} /></div>
          <h1>Choose how you want to work.</h1>
          <p>Open a project for coding inside a folder, or use a normal chat with no project attached.</p>
          <div className="welcome-actions"><button className="primary-button large"><Folder size={17} /> Open project</button><button className="secondary-button"><MessageSquare size={16} /> Normal chat</button></div>
        </section>
        <section className="composer-zone">
          <div className="composer">
            <div className="composer-input-wrap"><textarea aria-label="Message" rows={1} placeholder="Ask anything…" /></div>
            <div className="composer-toolbar"><div className="composer-controls">
              <div className="permission-control">
                <button className="toolbar-button" aria-expanded="true"><ShieldCheck size={14} />Ask<ChevronDown size={13} /></button>
                <div className="permission-menu" role="menu" aria-label="Permission mode">
                  {[["Read only", "Inspect without changing files"], ["Ask", "Work locally; ask for elevated actions"], ["Full access", "Unrestricted local access"]].map(([label, detail], index) => (
                    <button key={label} className={index === 1 ? "selected" : ""}><ShieldCheck size={17} /><span><strong>{label}</strong><small>{detail}</small></span>{index === 1 && <Check size={15} />}</button>
                  ))}
                </div>
              </div>
            </div><div className="composer-actions"><button className="send-button" disabled aria-label="Send"><ArrowUp size={18} /></button></div></div>
          </div>
        </section>
      </main>
      <div className="app-toast success" role="status"><span className="app-toast-icon"><Check size={14} strokeWidth={2.5} /></span><span>Sample toast: settings saved</span><button aria-label="Dismiss notification"><X size={13} /></button></div>
      {dialog && <div className="modal-backdrop confirm-backdrop">
        <div className="confirm-dialog" role="alertdialog" aria-label="Delete thread">
          <div className="confirm-dialog-icon danger"><X size={16} /></div>
          <h2>Delete “Sample thread” forever?</h2>
          <p>This sample dialog shows the destructive confirmation style. Nothing is deleted in this fixture.</p>
          <div className="confirm-dialog-actions"><button className="secondary-button">Cancel</button><button className="primary-button confirm-danger">Delete forever</button></div>
        </div>
      </div>}
    </div>
  );
}

it("FIXTURE gallery: welcome, update notice and permission menu", async () => {
  await commands.setStreamTestReducedMotion(true);
  await page.viewport(1400, 900);
  render(<OverlaysFixture theme="midnight" dialog={false} />);
  await page.screenshot({ path: "../../test-results/lumen/midnight-welcome.png" });
});

it.each(["mythra", "daylight"] as const)("FIXTURE gallery: %s overlays", async (theme) => {
  await commands.setStreamTestReducedMotion(true);
  await page.viewport(1400, 900);
  render(<OverlaysFixture theme={theme} />);
  await page.screenshot({ path: `../../test-results/lumen/${theme}-overlays.png` });
});

it("FIXTURE gallery: command palette", async () => {
  await commands.setStreamTestReducedMotion(true);
  await page.viewport(1400, 900);
  render(<div className="app-shell" data-theme="mythra" data-color-scheme="dark" style={{ width: 1400, height: 900 }}>
    <Sidebar /><main className="main-panel"><Topbar /></main>
    <CommandPalette open projects={[]} threads={[]} workflows={[]} projectActive onClose={noop} onProject={noop} onThread={noop} onWorkflow={noop} onNewThread={noop} onSettings={noop} onTool={noop} />
  </div>);
  await page.screenshot({ path: "../../test-results/lumen/mythra-palette.png" });
});

it("FIXTURE gallery: minimum window 980x680 with dock", async () => {
  await commands.setStreamTestReducedMotion(true);
  await page.viewport(980, 680);
  render(<Window theme="kiwi" mode="conversation" width={980} height={680} />);
  await page.screenshot({ path: "../../test-results/lumen/kiwi-980x680.png" });
});

it.each(THEMES.flatMap(({ id }) => [
  [id, "landing"] as const, [id, "conversation"] as const,
]))("FIXTURE gallery: %s %s", async (theme, mode) => {
  await commands.setStreamTestReducedMotion(true);
  await page.viewport(1400, 900);
  const view = render(<Window theme={theme} mode={mode} />);
  expect(view.container.querySelector(".app-shell")).not.toBeNull();
  await page.screenshot({ path: `../../test-results/lumen/${theme}-${mode}.png` });
});

it.each(THEMES.map(({ id }) => id))("FIXTURE gallery: %s settings", async (theme) => {
  await commands.setStreamTestReducedMotion(true);
  await page.viewport(1400, 900);
  render(<SettingsFixture theme={theme} />);
  await page.screenshot({ path: `../../test-results/lumen/${theme}-settings.png` });
});
