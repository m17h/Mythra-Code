import { useEffect, useMemo, useState } from "react";
import {
  Bot,
  Boxes,
  Check,
  ChevronDown,
  ChevronRight,
  CircleStop,
  Clock3,
  CodeXml,
  Eye,
  FilePlus2,
  FolderOpen,
  GitBranch,
  GitCommitHorizontal,
  GitFork,
  Gauge,
  History,
  Paperclip,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  RotateCw,
  SearchCode,
  Shrink,
  ShieldCheck,
  TerminalSquare,
  Trash2,
  Upload,
  UsersRound,
  Workflow as WorkflowIcon,
  Wrench,
  X,
} from "lucide-react";
import { FileBrowser } from "./FileBrowser";
import { XtermPanel } from "./XtermPanel";
import type { ProjectAction } from "../types";
import type { TerminalOutputStore } from "../hooks/useTerminal";
import type { WorkflowDefinition, WorkflowRunRecord } from "../lib/workflows";
import {
  checkpointIsRestorable,
  checkpointStatusLabel,
  type CheckpointHead,
  type CheckpointRecord,
  type CheckpointRestoreTarget,
} from "../lib/checkpoints";
import type { ThreadWorktreeRecord, WorktreeStatus } from "../lib/worktrees";
import type { GitHubRepoStatus } from "../lib/github";

export type StudioTab = "files" | "review" | "agents" | "terminal" | "checkpoints" | "worktrees" | "context" | "usage" | "tools" | "git";

export interface AgentRecord {
  id: string;
  prompt: string;
  status: string;
  path?: string;
}

export interface AttachmentRecord {
  path: string;
  name: string;
  kind: "image" | "file";
}

export interface TokenUsageView {
  totalTokens: number;
  /** Tokens currently occupying runtime context. This can shrink after
   * compaction or when a resumed runtime rebaselines its counters. */
  contextTokens?: number;
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens?: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  contextWindow?: number | null;
}

export interface SkillView { name: string; description?: string; path: string; enabled?: boolean }
export interface McpView { name: string; status: string; tools: number }

export const STUDIO_DOCK_EXIT_MS = 320;

const TABS: Array<{ id: StudioTab; label: string; icon: typeof CodeXml }> = [
  { id: "files", label: "Files", icon: FilePlus2 },
  { id: "review", label: "Review", icon: SearchCode },
  { id: "agents", label: "Agents", icon: UsersRound },
  { id: "terminal", label: "Terminal", icon: TerminalSquare },
  { id: "checkpoints", label: "Checkpoints", icon: History },
  { id: "worktrees", label: "Worktrees", icon: GitFork },
  { id: "context", label: "Context", icon: Paperclip },
  { id: "usage", label: "Usage", icon: Gauge },
  { id: "tools", label: "Tools", icon: Wrench },
  { id: "git", label: "Git", icon: GitBranch },
];

function PanelHeader({ icon: Icon, title, subtitle, onClose }: { icon: typeof CodeXml; title: string; subtitle: string; onClose: () => void }) {
  return <div className="studio-header"><span className="studio-header-icon"><Icon size={16} /></span><div><h2>{title}</h2><p>{subtitle}</p></div><button className="icon-button" onClick={onClose} aria-label="Close workspace tools"><X size={16} /></button></div>;
}

export function StudioDock(props: {
  open: boolean;
  width?: number;
  onResizeStart?: (event: React.PointerEvent) => void;
  tab: StudioTab;
  projectName?: string;
  projectPath?: string;
  activeThread: boolean;
  diff: string;
  agents: AgentRecord[];
  terminalOutput: TerminalOutputStore;
  terminalCommand: string;
  terminalRunning: boolean;
  checkpoints: CheckpointRecord[];
  checkpointHead?: CheckpointHead;
  checkpointBusyId?: string | null;
  checkpointPreview?: { id: string; diff: string } | null;
  worktree?: ThreadWorktreeRecord;
  worktreeStatus?: WorktreeStatus | null;
  worktreeBusy?: boolean;
  attachments: AttachmentRecord[];
  usage: TokenUsageView | null;
  costEstimate?: string;
  costTotals?: string;
  accountUsage: { label: string; summary: string };
  skills: SkillView[];
  mcpServers: McpView[];
  gitOutput: string;
  gitCommitMessage: string;
  githubAuthenticated: boolean;
  githubRepoStatus: GitHubRepoStatus | null;
  githubRepoError?: string;
  gitActionsReadOnly: boolean;
  githubRemoteInput: string;
  githubRepoName: string;
  githubRepoVisibility: "private" | "public";
  promptAudit: Array<{ label: string; value: string }>;
  projectActions: ProjectAction[];
  workflows: WorkflowDefinition[];
  workflowRuns: WorkflowRunRecord[];
  onTab: (tab: StudioTab) => void;
  onClose: () => void;
  onRefreshDiff: () => void;
  onReview: () => void;
  onOpenAgent: (id: string) => void;
  onStopAgent: (id: string) => void;
  onTerminalCommand: (value: string) => void;
  onRunTerminal: () => void;
  onStopTerminal: () => void;
  onTerminalInput: (value: string) => void;
  onTerminalResize: (columns: number, rows: number) => void;
  onCheckpoint: () => void;
  onFork: (checkpoint?: CheckpointRecord) => void;
  onCheckpointRestore: (checkpoint: CheckpointRecord, target: CheckpointRestoreTarget) => void;
  onCheckpointAccept: (checkpoint: CheckpointRecord) => void;
  onCheckpointPreview: (checkpoint: CheckpointRecord) => void;
  onCheckpointDelete: (checkpoint: CheckpointRecord) => void;
  onRollback: () => void;
  onWorktreeReview: () => void;
  onWorktreeApply: () => void;
  onWorktreeMerge: () => void;
  onWorktreeReveal: () => void;
  onWorktreeRefresh: () => void;
  onWorktreeRemove: () => void;
  onWorktreeRecreate: () => void;
  onWorktreeContinueShared: () => void;
  onAddAttachment: () => void;
  onRemoveAttachment: (path: string) => void;
  onRefreshUsage: () => void;
  onCompact: () => void;
  onRefreshTools: () => void;
  onGitAction: (action: "status" | "diff" | "stage" | "revert" | "commit" | "commitPush" | "fetch" | "pull" | "push" | "comments" | "ci" | "pr") => void;
  onGitCommitMessage: (value: string) => void;
  onGitHubRemoteInput: (value: string) => void;
  onGitHubRepoName: (value: string) => void;
  onGitHubRepoVisibility: (value: "private" | "public") => void;
  onGitHubAttach: () => void;
  onGitHubCreate: () => void;
  onOpenGitHubSettings: () => void;
  onGitPathAction: (action: "stage" | "revert", path: string) => void;
  onAttachPath: (path: string) => void;
  onProjectAction: (action: ProjectAction) => void;
  onRunWorkflow: (workflow: WorkflowDefinition) => void;
  onStopWorkflow: (workflowId: string) => void;
  onOpenWorkflowRun: (threadId: string) => void;
  onToggleSkill: (path: string) => void;
  onConnectMcp: (server: McpView) => void;
}) {
  // Keep the expensive panel contents mounted just long enough for the close
  // transition to play. Previously the closed branch removed them in the same
  // render that added `.closed`, so opacity/transform had nothing to animate.
  const [contentMounted, setContentMounted] = useState(props.open);
  useEffect(() => {
    if (props.open) {
      setContentMounted(true);
      return;
    }
    const timer = window.setTimeout(() => setContentMounted(false), STUDIO_DOCK_EXIT_MS);
    return () => window.clearTimeout(timer);
  }, [props.open]);
  const renderContent = props.open || contentMounted;
  const diffSections = useMemo(() => {
    if (!renderContent || !props.diff) return [];
    const sections: Array<{ path: string; text: string; additions: number; deletions: number }> = [];
    let current: { path: string; lines: string[]; additions: number; deletions: number } | null = null;
    const push = () => {
      if (current) sections.push({ path: current.path, text: current.lines.join("\n"), additions: current.additions, deletions: current.deletions });
    };
    for (const line of props.diff.split("\n")) {
      if (line.startsWith("diff --git ")) {
        push();
        current = { path: line.match(/^diff --git a\/(.+?) b\/(.+)$/)?.[2] ?? line, lines: [line], additions: 0, deletions: 0 };
      } else if (current) {
        current.lines.push(line);
        if (line.startsWith("+") && !line.startsWith("+++")) current.additions += 1;
        else if (line.startsWith("-") && !line.startsWith("---")) current.deletions += 1;
      }
    }
    push();
    return sections;
  }, [props.diff, renderContent]);
  const diffFiles = useMemo(() => diffSections.map((section) => section.path), [diffSections]);
  const checkpointById = useMemo(
    () => new Map(props.checkpoints.map((checkpoint) => [checkpoint.id, checkpoint])),
    [props.checkpoints],
  );
  // When the dock is closed, skip all panel work (diff parsing, xterm,
  // file browser) — it re-rendered fully even while hidden.
  if (!renderContent) {
    return <aside className="studio-dock closed" style={props.width ? { "--dock-width": `${props.width}px` } as React.CSSProperties : undefined} aria-label="Project workspace tools" aria-hidden inert />;
  }
  return (
    <aside className={`studio-dock ${props.open ? "open" : "closed"}`} style={props.width ? { "--dock-width": `${props.width}px` } as React.CSSProperties : undefined} aria-label="Project workspace tools" aria-hidden={!props.open} inert={!props.open ? true : undefined}>
      {props.onResizeStart && <div className="pane-resize dock-resize" onPointerDown={props.onResizeStart} role="separator" aria-orientation="vertical" aria-label="Resize workspace tools" />}
      <nav className="studio-tabs" aria-label="Workspace tools">
        {TABS.map(({ id, label, icon: Icon }) => <button key={id} className={props.tab === id ? "active" : ""} onClick={() => props.onTab(id)} title={label} aria-label={`${label} workspace tool`} aria-current={props.tab === id ? "page" : undefined}><Icon size={16} /><span>{label}</span></button>)}
      </nav>
      <div className="studio-panel">
        {props.tab === "files" && <>
          <PanelHeader icon={FilePlus2} title="Project files" subtitle="Search, preview, and attach local context" onClose={props.onClose} />
          {props.projectPath ? <FileBrowser root={props.projectPath} onAttach={props.onAttachPath} /> : <Empty icon={FilePlus2} title="No project folder" text="Open a project to browse its files." />}
        </>}

        {props.tab === "review" && <>
          <PanelHeader icon={SearchCode} title="Review center" subtitle="Inspect the live turn diff" onClose={props.onClose} />
          <div className="studio-actions"><button onClick={props.onRefreshDiff}><RefreshCw size={13} /> Refresh</button><button onClick={props.onReview} disabled={!props.activeThread}><Bot size={13} /> AI review</button></div>
          <div className="diff-summary"><span><CodeXml size={13} /> Working changes</span><small>{diffSections.length ? `${diffSections.length} file${diffSections.length === 1 ? "" : "s"} changed` : "No changes loaded"}</small></div>
          {diffSections.length ? (
            <div className="diff-file-sections">
              {diffSections.map((section) => (
                <details className="diff-file" key={section.path} open={diffSections.length === 1}>
                  <summary>
                    <code>{section.path}</code>
                    <span className="diff-file-stats"><em className="added">+{section.additions}</em> <em className="removed">−{section.deletions}</em></span>
                    <span className="diff-file-actions">
                      <button
                        onClick={(event) => {
                          event.preventDefault();
                          props.onGitPathAction("stage", section.path);
                        }}
                        disabled={props.gitActionsReadOnly}
                        title={`Stage ${section.path}`}
                      >
                        <Plus size={10} /> Stage
                      </button>
                      <button
                        className="danger-action"
                        onClick={(event) => {
                          event.preventDefault();
                          props.onGitPathAction("revert", section.path);
                        }}
                        disabled={props.gitActionsReadOnly}
                        title={`Revert ${section.path}`}
                      >
                        <RotateCcw size={10} />
                      </button>
                    </span>
                  </summary>
                  <DiffText text={section.text} />
                </details>
              ))}
            </div>
          ) : (
            <pre className="diff-view">{props.diff || "Run a task or refresh to inspect the current Git diff."}</pre>
          )}
        </>}

        {props.tab === "agents" && <>
          <PanelHeader icon={UsersRound} title="Agent control" subtitle="Direct children and delegated work" onClose={props.onClose} />
          <div className="metric-grid"><div><strong>{props.agents.length}</strong><span>Observed</span></div><div><strong>{props.agents.filter((a) => a.status === "inProgress" || a.status === "started").length}</strong><span>Active</span></div></div>
          <div className="studio-list">{props.agents.length ? props.agents.map((agent) => <div className="studio-list-row" key={agent.id}><span className={`status-orb ${agent.status}`} /><div><strong>{agent.prompt || "Delegated task"}</strong><small>{agent.status} · {agent.id.slice(0, 8)}</small></div><button onClick={() => props.onOpenAgent(agent.id)} title="Open child thread" aria-label={`Open sub-agent ${agent.id.slice(0, 8)}`}><ChevronRight size={14} /></button><button onClick={() => props.onStopAgent(agent.id)} title="Stop child agent" aria-label={`Stop sub-agent ${agent.id.slice(0, 8)}`}><CircleStop size={14} /></button></div>) : <Empty icon={UsersRound} title="No sub-agents yet" text="When the model delegates, each child appears here." />}</div>
        </>}

        {props.tab === "terminal" && <>
          <PanelHeader icon={TerminalSquare} title="Terminal" subtitle={props.projectName || "Project shell"} onClose={props.onClose} />
          <XtermPanel outputStore={props.terminalOutput} placeholder={"OPENKIWI terminal ready\n"} running={props.terminalRunning} onInput={props.onTerminalInput} onResize={props.onTerminalResize} />
          <div className="terminal-input"><span>$</span><input aria-label="Terminal command" value={props.terminalCommand} onChange={(e) => props.onTerminalCommand(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") props.onRunTerminal(); }} placeholder="npm test" /><button aria-label={props.terminalRunning ? "Stop terminal command" : "Run terminal command"} onClick={props.terminalRunning ? props.onStopTerminal : props.onRunTerminal}>{props.terminalRunning ? <CircleStop size={14} /> : <Play size={14} />}</button></div>
        </>}

        {props.tab === "checkpoints" && <>
          <PanelHeader icon={History} title="Checkpoints" subtitle="Automatic, reversible project snapshots" onClose={props.onClose} />
          <div className="studio-actions wrap">
            <button onClick={props.onCheckpoint} disabled={!props.activeThread || Boolean(props.checkpointBusyId)}><Plus size={13} /> Save current state</button>
          </div>
          <div className="checkpoint-note"><ShieldCheck size={14} /><div><strong>Every model run is protected automatically.</strong><span>Restore moves the complete source worktree to that point. OpenKiwi saves the current state first, while Git commits and ignored files remain unchanged.</span></div></div>
          <div className="checkpoint-list">
            {props.checkpoints.length ? props.checkpoints.map((checkpoint) => {
              const currentPosition = props.checkpointHead?.checkpointId === checkpoint.id
                ? props.checkpointHead.position
                : null;
              const workingHere = props.checkpointBusyId === checkpoint.id || props.checkpointBusyId === "manual";
              const busy = Boolean(props.checkpointBusyId);
              const legacy = !checkpoint.workspacePath || checkpoint.status === "legacy" || !checkpoint.beforeCommit;
              const canRestoreBefore = checkpointIsRestorable(checkpoint, "before");
              const canRestoreAfter = checkpointIsRestorable(checkpoint, "after");
              const stats = checkpoint.changedFiles !== undefined
                ? `${checkpoint.changedFiles} file${checkpoint.changedFiles === 1 ? "" : "s"} · +${checkpoint.additions ?? 0} −${checkpoint.deletions ?? 0}`
                : `${checkpoint.fileCount ?? 0} source file${checkpoint.fileCount === 1 ? "" : "s"} saved`;
              return (
                <article className={`checkpoint-card ${currentPosition ? "current" : ""} ${checkpoint.accepted ? "accepted" : ""}`} key={checkpoint.id}>
                  <div className="checkpoint-card-head">
                    <span className={`checkpoint-state-icon ${checkpoint.status ?? "legacy"}`}>
                      {checkpoint.status === "running" || workingHere ? <RefreshCw className="spin" size={14} /> : checkpoint.accepted ? <Check size={14} /> : <Clock3 size={14} />}
                    </span>
                    <div>
                      <strong>{checkpoint.label}</strong>
                      <small>{checkpointStatusLabel(checkpoint)}{currentPosition ? ` · current ${currentPosition} state` : ""}</small>
                    </div>
                  </div>
                  <div className="checkpoint-meta">
                    <span>{new Date(checkpoint.completedAt ?? checkpoint.createdAt).toLocaleString()}</span>
                    {checkpoint.threadLabel && <span>{checkpoint.threadLabel}</span>}
                    {(checkpoint.provider || checkpoint.model) && <span>{[checkpoint.provider, checkpoint.model].filter(Boolean).join(" · ")}</span>}
                    {checkpoint.branch && <span>{checkpoint.branch}</span>}
                  </div>
                  {!legacy && checkpoint.status !== "running" && checkpoint.status !== "failed" && <div className="checkpoint-stats">{stats}</div>}
                  {checkpoint.parentId && <div className="checkpoint-lineage">Continues from {checkpointById.get(checkpoint.parentId)?.label ?? "an earlier saved state"}{checkpoint.parentPosition ? ` · ${checkpoint.parentPosition}` : ""}</div>}
                  {checkpoint.restoredFromId && <div className="checkpoint-lineage">Safety copy created before a restore</div>}
                  {checkpoint.overlappingRun && <div className="checkpoint-error">Another thread was editing this shared worktree during the run, so this snapshot can include both threads’ changes.</div>}
                  {checkpoint.error && <div className="checkpoint-error">{checkpoint.error}</div>}
                  <div className="checkpoint-actions">
                    {legacy ? (
                      <button onClick={() => props.onFork(checkpoint)} disabled={busy}><GitFork size={12} /> Fork conversation</button>
                    ) : <>
                      <button onClick={() => props.onCheckpointPreview(checkpoint)} disabled={!checkpoint.afterCommit || busy}><Eye size={12} /> {props.checkpointPreview?.id === checkpoint.id ? "Hide changes" : "Preview"}</button>
                      {checkpoint.status === "safety" ? (
                        <button onClick={() => props.onCheckpointRestore(checkpoint, "after")} disabled={!canRestoreAfter || busy}><RotateCw size={12} /> Restore safety copy</button>
                      ) : <>
                        <button className="danger-action" onClick={() => props.onCheckpointRestore(checkpoint, "before")} disabled={!canRestoreBefore || busy}><RotateCcw size={12} /> Restore before</button>
                        <button onClick={() => props.onCheckpointRestore(checkpoint, "after")} disabled={!canRestoreAfter || busy}><RotateCw size={12} /> {checkpoint.status === "restored-before" ? "Reapply run" : "Restore result"}</button>
                      </>}
                      {checkpoint.status !== "safety" && <button className={checkpoint.accepted ? "approved" : ""} onClick={() => props.onCheckpointAccept(checkpoint)} disabled={checkpoint.status === "running" || busy}><Check size={12} /> {checkpoint.accepted ? "Undo accept" : "Accept"}</button>}
                    </>}
                    <button className="danger-action icon-only" onClick={() => props.onCheckpointDelete(checkpoint)} disabled={checkpoint.status === "running" || busy} title={`Delete ${checkpoint.label}`} aria-label={`Delete ${checkpoint.label}`}><Trash2 size={12} /></button>
                  </div>
                  {props.checkpointPreview?.id === checkpoint.id && (
                    <div className="checkpoint-preview">
                      {props.checkpointPreview.diff
                        ? <DiffText text={props.checkpointPreview.diff} />
                        : <span>No source changes were recorded in this run.</span>}
                    </div>
                  )}
                </article>
              );
            }) : <Empty icon={History} title="No checkpoints yet" text="The first project run will automatically create a restorable checkpoint." />}
          </div>
          <h3 className="panel-label">Conversation history</h3>
          <div className="studio-actions wrap"><button onClick={() => props.onFork()} disabled={!props.activeThread}><GitFork size={13} /> Fork thread</button><button onClick={props.onRollback} disabled={!props.activeThread}><RotateCcw size={13} /> Undo conversation turn</button></div>
          <div className="history-warning"><ShieldCheck size={13} /> Conversation undo changes chat history only. Checkpoint restore changes project files without rewriting Git commits.</div>
        </>}

        {props.tab === "worktrees" && <>
          <PanelHeader icon={GitFork} title="Worktrees" subtitle="Isolated branches and project handoff" onClose={props.onClose} />
          <div className="checkpoint-note"><ShieldCheck size={14} /><div><strong>Experiment without touching the shared project.</strong><span>Apply copies the resulting files into your project. Merge preserves committed branch history. Removing an unapplied worktree leaves the shared project unchanged.</span></div></div>
          {props.worktree ? (
            <div className="worktree-card">
              <div className="worktree-card-head">
                <span><GitBranch size={14} /></span>
                <div><strong>{props.worktree.branch}</strong><small>{props.worktree.path}</small></div>
                <em>{props.worktree.status}</em>
              </div>
              {props.worktreeStatus && (
                <div className="worktree-metrics">
                  <span><strong>{props.worktreeStatus.changedFiles}</strong> changed</span>
                  <span><strong>{props.worktreeStatus.ahead}</strong> commits ahead</span>
                  <span><strong>{props.worktreeStatus.ignoredFiles.length}</strong> ignored</span>
                </div>
              )}
              {props.worktree.status === "missing" || props.worktree.status === "removed" ? (
                <div className="studio-actions wrap">
                  {props.worktree.status === "missing" && <button onClick={props.onWorktreeRecreate} disabled={props.worktreeBusy}><RotateCw size={13} /> Recreate from branch</button>}
                  {props.worktree.status === "removed" && <button onClick={props.onWorktreeContinueShared} disabled={props.worktreeBusy}><FolderOpen size={13} /> Continue shared</button>}
                </div>
              ) : (
                <div className="studio-actions wrap">
                  <button onClick={props.onWorktreeReview} disabled={props.worktreeBusy}><SearchCode size={13} /> Review</button>
                  <button onClick={props.onWorktreeApply} disabled={props.worktreeBusy}><RotateCw size={13} /> Apply to project</button>
                  <button onClick={props.onWorktreeMerge} disabled={props.worktreeBusy}><GitCommitHorizontal size={13} /> Merge branch</button>
                  <button onClick={props.onWorktreeReveal} disabled={props.worktreeBusy}><Eye size={13} /> Reveal</button>
                  <button onClick={props.onWorktreeRefresh} disabled={props.worktreeBusy}><RefreshCw size={13} /> Refresh</button>
                  <button className="danger-action" onClick={props.onWorktreeRemove} disabled={props.worktreeBusy}><Trash2 size={13} /> Remove worktree…</button>
                </div>
              )}
            </div>
          ) : (
            <div className="history-warning"><ShieldCheck size={13} /> This thread uses the shared project folder. Choose Isolated worktree before sending the first message in a new thread.</div>
          )}
          <div className="history-warning"><ShieldCheck size={13} /> Worktrees and their branches stay local unless you explicitly push them to a Git remote.</div>
        </>}

        {props.tab === "context" && <>
          <PanelHeader icon={Paperclip} title="Context" subtitle="Files, images, and task references" onClose={props.onClose} />
          <button className="attachment-drop" onClick={props.onAddAttachment}><FilePlus2 size={21} /><strong>Add files or images</strong><small>Images are sent natively; file paths become explicit task context.</small></button>
          <div className="studio-list">{props.attachments.map((item) => <div className="studio-list-row" key={item.path}><Paperclip size={14} /><div><strong>{item.name}</strong><small>{item.kind} · {item.path}</small></div><button onClick={() => props.onRemoveAttachment(item.path)} aria-label={`Remove ${item.name}`}><X size={13} /></button></div>)}</div>
        </>}

        {props.tab === "usage" && <>
          <PanelHeader icon={Gauge} title="Usage & audit" subtitle="Cumulative thread totals, context pressure, and visible request fields" onClose={props.onClose} />
          <div className="studio-actions"><button onClick={props.onRefreshUsage}><RefreshCw size={13} /> Refresh</button><button onClick={props.onCompact} disabled={!props.activeThread} title="Summarize older turns to free context in this thread"><Shrink size={13} /> Compact context</button></div>
          {props.usage?.contextWindow && (props.usage.contextTokens ?? props.usage.totalTokens) / props.usage.contextWindow >= 0.7 ? (
            <div className="history-warning"><ShieldCheck size={13} /> This thread has used {Math.min(100, Math.round(((props.usage.contextTokens ?? props.usage.totalTokens) / props.usage.contextWindow) * 100))}% of its context window. Compact before the limit if responses begin losing older detail.</div>
          ) : null}
          <div className="usage-hero">
            <span>Thread tokens</span>
            <strong>{props.usage?.totalTokens.toLocaleString() ?? "—"}</strong>
            <small>
              Cumulative in this thread
              {props.usage?.contextWindow ? ` · ${Math.min(100, Math.round(((props.usage.contextTokens ?? props.usage.totalTokens) / props.usage.contextWindow) * 100))}% of context` : ""}
              {props.costEstimate ? ` · ${props.costEstimate}` : ""}
            </small>
            {props.usage?.contextWindow ? <i style={{ width: `${Math.min(100, ((props.usage.contextTokens ?? props.usage.totalTokens) / props.usage.contextWindow) * 100)}%` }} /> : null}
          </div>
          <div className="metric-grid usage-token-metrics"><div><strong>{props.usage?.inputTokens.toLocaleString() ?? "—"}</strong><span>Input</span></div><div><strong>{props.usage?.outputTokens.toLocaleString() ?? "—"}</strong><span>Output</span></div><div className="usage-reasoning-metric"><strong>{props.usage?.reasoningOutputTokens.toLocaleString() ?? "—"}</strong><span>Reasoning</span></div></div>
          {props.usage && (props.usage.cachedInputTokens > 0 || (props.usage.cacheWriteInputTokens ?? 0) > 0) ? (
            <div className="usage-cache-note">
              Prompt caching: {props.usage.cachedInputTokens.toLocaleString()} read · {(props.usage.cacheWriteInputTokens ?? 0).toLocaleString()} written
            </div>
          ) : null}
          <div className="rate-card"><span>{props.accountUsage.label}</span><strong>{props.accountUsage.summary}</strong></div>
          {props.costTotals && <div className="rate-card"><span>OpenRouter history</span><strong>{props.costTotals}</strong></div>}
          <h3 className="panel-label">Request audit</h3><div className="audit-table">{props.promptAudit.map((row) => <div key={row.label}><span>{row.label}</span><code>{row.value}</code></div>)}</div>
        </>}

        {props.tab === "tools" && <>
          <PanelHeader icon={Wrench} title="Tools & skills" subtitle="Harness capabilities available to the model" onClose={props.onClose} />
          <div className="studio-actions"><button onClick={props.onRefreshTools}><RefreshCw size={13} /> Rescan</button></div>
          <div className="tool-policy-card"><ShieldCheck size={14} /><div><strong>Permission-aware tools</strong><small>Terminal, Git, MCP, and agent actions follow the permission mode selected beneath the composer. Annotated destructive MCP actions still require approval.</small></div></div>
          <h3 className="panel-label">Agent workflows</h3><div className="studio-list compact">{props.workflows.length ? props.workflows.map((workflow) => {
            const latest = props.workflowRuns.find((run) => run.workflowId === workflow.id);
            const running = latest?.status === "running";
            return <div className="studio-list-row" key={workflow.id}><WorkflowIcon size={14} /><div><strong>{workflow.name}</strong><small>{workflow.steps.length} step{workflow.steps.length === 1 ? "" : "s"} · {running ? `step ${latest.currentStep} of ${latest.stepCount}` : latest?.status ?? "ready"}</small></div>{running ? <button className="danger-action" onClick={() => props.onStopWorkflow(workflow.id)} title="Stop workflow"><CircleStop size={13} /></button> : <button onClick={() => props.onRunWorkflow(workflow)} title="Run workflow"><Play size={13} /></button>}{latest?.threadId && <button onClick={() => props.onOpenWorkflowRun(latest.threadId!)} title="Open workflow thread"><ChevronRight size={13} /></button>}</div>;
          }) : <span className="tool-empty-line">Add agent workflows in Settings.</span>}</div>
          <h3 className="panel-label">Project actions</h3><div className="studio-list compact">{props.projectActions.length ? props.projectActions.map((action) => <div className="studio-list-row" key={action.id}><Play size={14} /><div><strong>{action.name}</strong><small>{action.command}</small></div><button onClick={() => props.onProjectAction(action)} title="Run action"><Play size={13} /></button></div>) : <span className="tool-empty-line">Add reusable actions in Settings.</span>}</div>
          <h3 className="panel-label">Skills</h3><div className="studio-list compact">{props.skills.length ? props.skills.map((skill) => <div className={`studio-list-row ${skill.enabled === false ? "disabled-tool" : ""}`} key={`${skill.name}-${skill.path}`}><Boxes size={14} /><div><strong>${skill.name}</strong><small>{skill.description || skill.path || "Reusable workflow"}</small></div><button onClick={() => props.onToggleSkill(skill.path)} title={skill.enabled === false ? "Enable skill" : "Disable skill"}>{skill.enabled === false ? <Plus size={13} /> : <Check size={13} />}</button></div>) : <Empty icon={Boxes} title="No skills found" text="Choose a local skills folder in Settings → Skills." />}</div>
          <h3 className="panel-label">MCP servers</h3><div className="studio-list compact">{props.mcpServers.length ? props.mcpServers.map((server) => <div className="studio-list-row" key={server.name}><span className={`status-orb ${server.status}`} /><div><strong>{server.name}</strong><small>{server.status} · {server.tools} tools</small></div>{!['ready','oAuth','bearerToken'].includes(server.status) && <button onClick={() => props.onConnectMcp(server)} title="Connect server"><ChevronRight size={13} /></button>}</div>) : <Empty icon={Wrench} title="No MCP servers" text="Configured servers and their tool counts appear here." />}</div>
        </>}

        {props.tab === "git" && <>
          <PanelHeader icon={GitBranch} title="Git workspace" subtitle="Shape changes without leaving OPENKIWI" onClose={props.onClose} />
          {props.gitActionsReadOnly && <div className="history-warning"><ShieldCheck size={13} /> Read only allows Status and Diff. Switch thread access to Ask or Full access before changing Git or contacting GitHub.</div>}
          <div className="github-repo-card">
            <span className="github-repo-icon"><GitFork size={16} /></span>
            <div>
              <strong>{props.githubRepoStatus?.repository || (props.githubRepoError ? "GitHub status unavailable" : "No GitHub repository attached")}</strong>
              <small>{props.githubRepoError || (props.githubRepoStatus?.repository
                ? `${props.githubRepoStatus.branch || "detached"}${props.githubRepoStatus.upstream ? ` · ${props.githubRepoStatus.ahead} ahead · ${props.githubRepoStatus.behind} behind` : " · not pushed yet"}`
                : props.githubAuthenticated ? "Attach an existing repository or create a new one." : "Connect GitHub in Settings to publish this project.")}</small>
            </div>
            {!props.githubAuthenticated && <button className="github-secondary-button" onClick={props.onOpenGitHubSettings}>Connect</button>}
          </div>
          {!props.githubRepoStatus?.repository && props.githubAuthenticated && (
            <div className="github-connect-project">
              <label className="dock-field"><span>Existing repository URL</span><input value={props.githubRemoteInput} onChange={(event) => props.onGitHubRemoteInput(event.target.value)} placeholder="https://github.com/owner/repository.git" /></label>
              <button className="github-secondary-button" onClick={props.onGitHubAttach} disabled={props.gitActionsReadOnly || !props.githubRemoteInput.trim()}><GitFork size={13} /> Attach remote</button>
              <div className="github-create-divider"><span>or create one</span></div>
              <div className="github-create-row">
                <input className="github-repo-name-input" value={props.githubRepoName} onChange={(event) => props.onGitHubRepoName(event.target.value)} placeholder="repository-name" aria-label="New GitHub repository name" />
                <span className="github-visibility-select">
                  <select value={props.githubRepoVisibility} onChange={(event) => props.onGitHubRepoVisibility(event.target.value as "private" | "public")} aria-label="Repository visibility"><option value="private">Private</option><option value="public">Public</option></select>
                  <ChevronDown size={13} aria-hidden="true" />
                </span>
                <button className="github-create-button" onClick={props.onGitHubCreate} disabled={props.gitActionsReadOnly || !props.githubRepoName.trim()}><Plus size={13} /> Create</button>
              </div>
            </div>
          )}
          <div className="studio-actions wrap"><button onClick={() => props.onGitAction("status")}><RefreshCw size={13} /> Status</button><button onClick={() => props.onGitAction("diff")}><CodeXml size={13} /> Diff</button><button onClick={() => props.onGitAction("stage")} disabled={props.gitActionsReadOnly}><Plus size={13} /> Stage all</button><button className="danger-action" onClick={() => props.onGitAction("revert")} aria-label="Revert all Git changes" disabled={props.gitActionsReadOnly}><RotateCcw size={13} /> Revert all</button></div>
          {diffFiles.length > 0 && <><h3 className="panel-label">Changed files</h3><div className="git-file-list">{diffFiles.map((path) => <div key={path}><code>{path}</code><button onClick={() => props.onGitPathAction("stage", path)} disabled={props.gitActionsReadOnly}><Plus size={11} /> Stage</button><button className="danger-action" onClick={() => props.onGitPathAction("revert", path)} disabled={props.gitActionsReadOnly}><RotateCcw size={11} /></button></div>)}</div></>}
          <pre className="git-screen">{props.gitOutput || "Choose an action to inspect the repository."}</pre>
          <label className="dock-field"><span>Commit message</span><input value={props.gitCommitMessage} onChange={(e) => props.onGitCommitMessage(e.target.value)} placeholder="Describe this change" /></label>
          <div className="studio-actions wrap"><button onClick={() => props.onGitAction("commit")} disabled={props.gitActionsReadOnly || !props.gitCommitMessage.trim()}><GitCommitHorizontal size={13} /> Commit staged</button><button onClick={() => props.onGitAction("commitPush")} disabled={props.gitActionsReadOnly || !props.gitCommitMessage.trim() || !props.githubRepoStatus?.repository || !props.githubRepoStatus.branch}><Upload size={13} /> Commit & push</button><button onClick={() => props.onGitAction("fetch")} disabled={props.gitActionsReadOnly || !props.githubRepoStatus?.repository}><RefreshCw size={13} /> Fetch</button><button onClick={() => props.onGitAction("pull")} disabled={props.gitActionsReadOnly || !props.githubRepoStatus?.upstream}><RotateCw size={13} /> Pull</button><button onClick={() => props.onGitAction("push")} disabled={props.gitActionsReadOnly || !props.githubRepoStatus?.repository || !props.githubRepoStatus.branch} title={!props.githubRepoStatus?.branch ? "Check out a named branch before pushing" : "Push committed changes to GitHub"}><Upload size={13} /> Push commits</button><button onClick={() => props.onGitAction("comments")} disabled={props.gitActionsReadOnly || !props.githubRepoStatus?.repository}><CodeXml size={13} /> Review comments</button><button onClick={() => props.onGitAction("ci")} disabled={props.gitActionsReadOnly || !props.githubRepoStatus?.repository}><ShieldCheck size={13} /> CI checks</button><button onClick={() => props.onGitAction("pr")} disabled={props.gitActionsReadOnly || !props.githubRepoStatus?.repository}><GitFork size={13} /> Draft PR</button></div>
        </>}
      </div>
    </aside>
  );
}

function Empty({ icon: Icon, title, text }: { icon: typeof CodeXml; title: string; text: string }) {
  return <div className="studio-empty"><Icon size={21} /><strong>{title}</strong><span>{text}</span></div>;
}

function DiffText({ text }: { text: string }) {
  return (
    <pre className="diff-view">
      {text.split("\n").map((line, index) => {
        const kind = line.startsWith("+") && !line.startsWith("+++")
          ? "diff-line-add"
          : line.startsWith("-") && !line.startsWith("---")
            ? "diff-line-del"
            : line.startsWith("@@")
              ? "diff-line-hunk"
              : undefined;
        return <span key={index} className={kind}>{`${line}\n`}</span>;
      })}
    </pre>
  );
}
