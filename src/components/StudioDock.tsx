import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type Ref } from "react";
import type { Provider, ProjectRunCommand, SettingsSection, UsageEvidence } from "../types";
import type { NativeAgentLink, NativeAgentReadout, OwnershipLinks } from "../lib/nativeAgentLinks";
import {
  Bot,
  Boxes,
  Check,
  CheckCircle2,
  ChevronRight,
  CircleStop,
  Clock3,
  CodeXml,
  Eye,
  FileDiff,
  FileX2,
  FolderOpen,
  FolderTree,
  GitBranch,
  GitCommitHorizontal,
  GitFork,
  History,
  Info,
  ListChecks,
  Maximize2,
  MessageSquareText,
  Minimize2,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  RotateCw,
  Settings as SettingsIcon,
  ShieldCheck,
  Shrink,
  Square,
  SquareChevronRight,
  Trash2,
  TriangleAlert,
  UsersRound,
  Workflow as WorkflowIcon,
  WrapText,
  Wrench,
  X,
} from "lucide-react";
import { InfoPopover } from "./InfoPopover";
import { ThreadCompactionControl, type ThreadCompactionSetting } from "./ThreadCompactionControl";
import { CHANGES_SCOPE_LABELS, STAGED_DIFF_FILE_LIMIT, STAGED_VIEW_LABEL, diffEmptyCopy, diffReadState, partialCommitNote, projectRelativePath, stagedDiffSections, type ChangesScope, type StagedDiffResult } from "../lib/changesScope";
import { useTaskStore } from "../lib/taskStore";
import { FileBrowser, type FileBrowserSource } from "./FileBrowser";
import { DiffFileSections, DiffText, setDiffWrap, useDiffWrap } from "./DiffView";
import { splitChangePath } from "../lib/gitChanges";
import { AppActionMenu, type AppActionMenuItem } from "./AppActionMenu";
import { GitPanel, type GitPanelAction, type GitPanelDraft, type GitRepositoryState } from "./GitPanel";
import { FriendlyGitError } from "./GitChangesView";

/** ChecksControl listens for this to open its command editor (kept literal: that module loads separately). */
const EDIT_CHECKS_EVENT = "mythra:edit-checks";
import { commitMessageScope, useCommitMessageStore } from "../lib/commitMessages";
import type { GitWorkflowControls } from "../lib/gitWorkspace";
import type { GitRoute, GitView, ProjectGitInspection, ProjectPullRequestAccess } from "../lib/projectGit";
import type { TerminalPanelProps } from "./TerminalPanel";
import { scheduleIdlePreload } from "../lib/settingsPreload";
import { useTurnContextReceipt, useTurnContextRecordingEnabled } from "../lib/turnContextReceipts";
import "./LastTurnInstructions.css";
import type { ProjectAction } from "../types";
import { PANE_BOUNDS, reviewWideFit } from "../hooks/usePaneResize";
import type { RunningTerminalCommand, TerminalOutputStore } from "../hooks/useTerminal";
import type { WorkflowDefinition, WorkflowRunRecord } from "../lib/workflows";
import { ThreadUsagePanel, threadUsageCanCompact } from "./ThreadUsagePanel";
import { parseDiffSections, type ReviewDiff } from "../lib/gitDiff";
import { relativeAge } from "../lib/gitChanges";
import { STUDIO_TAB_GROUPS, type StudioTab } from "../lib/studioTabs";
import { STUDIO_TAB_META } from "./studioTabMeta";
import { Switch } from "./Switch";
import { mcpServerConnected, mcpStatusLabel, worktreeStatusLabel } from "../lib/statusLabels";
import { isActiveAgentRecord, subAgentStatusLabel, workerStatusFromAgentRecord } from "../lib/subAgentActivity";
import {
  checkpointIsRestorable,
  checkpointStatusLabel,
  type CheckpointHead,
  type CheckpointRecord,
  type CheckpointRestoreTarget,
} from "../lib/checkpoints";
import type { ThreadWorktreeRecord, WorktreeStatus } from "../lib/worktrees";
import type { GitHubRepoStatus } from "../lib/github";

export type { StudioTab } from "../lib/studioTabs";

export interface AgentRecord extends NativeAgentReadout {
  id: string;
  prompt: string;
  status: string;
  path?: string;
  provider?: import("../types").Provider;
  model?: string;
  runtime?: "codex" | "claude";
  createdAt?: number;
  rootTurnId?: string;
  /** Native operation identity distinguishes reactivation while turn IDs lag. */
  canOpen?: boolean;
  canStop?: boolean;
  canAccept?: boolean;
}

export interface AttachmentRecord {
  path: string;
  name: string;
  kind: "image" | "file";
  /** Where it is shown to live, when `path` is only an id (a file kept on another device). */
  displayPath?: string;
}

export interface TokenUsageView extends UsageEvidence {
  totalTokens: number;
  /** Tokens currently occupying runtime context. This can shrink after
   * compaction or when a resumed runtime rebaselines its counters. */
  contextTokens?: number;
  /** Latest request components, separate from lifetime billed counters. */
  contextInputTokens?: number;
  contextOutputTokens?: number;
  contextCachedInputTokens?: number;
  contextReasoningOutputTokens?: number;
  /** This update carries a fresh context snapshot, including unknown fields. */
  contextSnapshotReported?: boolean;
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens?: number;
  /** Part of `cacheWriteInputTokens` written to Claude's 1-hour cache. */
  cacheWrite1hInputTokens?: number;
  outputTokens: number;
  /** False means a stored zero is unknown, not a reported output count. */
  outputTokensReported?: boolean;
  reasoningOutputTokens: number;
  contextWindow?: number | null;
}

export interface SkillView { name: string; description?: string; path: string; enabled?: boolean }
export interface McpView { name: string; status: string; tools: number }

export const STUDIO_DOCK_EXIT_MS = 320;

/** One name and icon per tab (shared with the command palette). */
export { STUDIO_TAB_META };

/** The rail in order, each tab knowing its group (for the hairlines between groups). */
const TABS: Array<{ id: StudioTab; label: string; icon: typeof CodeXml; group: number }> = STUDIO_TAB_GROUPS.flatMap((group, index) =>
  group.tabs.map((id) => ({ id, ...STUDIO_TAB_META[id], group: index })));

const EMPTY_PATHS: ReadonlySet<string> = new Set();
const EMPTY_PATH_LIST: string[] = [];
/** Files in the uncommitted diff: tracked files plus new files the diff text doesn't hold. */
const netListCount = (fileCount: number, newFiles: string[], sections: Array<{ path: string | null }>) =>
  fileCount + newFiles.filter((path) => !sections.some((section) => section.path === path)).length;
/** Wide review must add at least this much width to be offered (Sol R5 B02). */
const WIDE_REVIEW_MIN_GAIN = 120;

/** Whether Changes shows the grouped file list or every file's full diff. */
const CHANGES_MODE_KEY = "kiwi.changesMode";
function readChangesMode(): "list" | "diff" {
  try { return window.localStorage.getItem(CHANGES_MODE_KEY) === "diff" ? "diff" : "list"; } catch { return "list"; }
}

const COMMAND_READ_ONLY_REASON ="Read only: commands run without permission to write in this project. Switch the thread to Ask to act or Full access first.";

// xterm is most of this chunk's weight. Load the terminal only once the dock
// opens, so a closed dock costs nothing at launch.
type TerminalPanelComponent = typeof import("./TerminalPanel").TerminalPanel;
let loadedTerminalPanel: TerminalPanelComponent | null = null;
let terminalPanelPromise: Promise<TerminalPanelComponent> | null = null;
function loadTerminalPanel(): Promise<TerminalPanelComponent> {
  terminalPanelPromise ??= import("./TerminalPanel").then((module) => {
    loadedTerminalPanel = module.TerminalPanel;
    return module.TerminalPanel;
  }).catch((error) => {
    terminalPanelPromise = null;
    throw error;
  });
  return terminalPanelPromise;
}
function preloadTerminalPanel() {
  void loadTerminalPanel().catch(() => undefined);
}

/** Stable host that renders the resolved panel directly (no React.lazy
 * suspension on first read). Import failures reach the dock's error boundary. */
export function TerminalPanelHost(props: TerminalPanelProps) {
  const [Component, setComponent] = useState(() => loadedTerminalPanel);
  const [failure, setFailure] = useState<{ reason: unknown } | null>(null);
  useEffect(() => {
    if (Component) return;
    let disposed = false;
    loadTerminalPanel().then(
      (component) => { if (!disposed) setComponent(() => component); },
      (reason) => { if (!disposed) setFailure({ reason }); },
    );
    return () => { disposed = true; };
  }, [Component]);
  if (failure) throw failure.reason;
  return Component ? <Component {...props} /> : null;
}

type StudioDockProps = Parameters<typeof StudioDock>[0];
export type AgentsPanelProps = Pick<StudioDockProps, "agents" | "onClose" | "onOpenAgent" | "onStopAgent" | "onOpenSettings"> & {
  /** Context the rail cannot show, such as the machine a remote panel reads. */
  subtitle?: string;
  /** Sign off a finished worker. Only offered where the agent's record allows it. */
  onAcceptAgent?: (id: string) => void;
  /** Extra detail for one worker, shown with its task and progress. */
  agentDetail?: (id: string) => import("react").ReactNode;
};
/** "3 sub-agents · 1 running", only once there is something to count. */
function agentSummary(agents: AgentRecord[]): string {
  const active = agents.filter((agent) => isActiveAgentRecord(agent.status)).length;
  return `${agents.length} sub-agent${agents.length === 1 ? "" : "s"}${active ? ` · ${active} running` : ""}`;
}

/** The real panels are written once. Another machine supplies their data and actions. */
export function AgentsPanel(props: AgentsPanelProps) {
  return <>
          <PanelHeader tab="agents" subtitle={props.subtitle} onClose={props.onClose} />
          {props.agents.length > 0 && <p className="studio-panel-meta" role="status">{agentSummary(props.agents)}</p>}
          <div className="studio-list">{props.agents.length ? props.agents.map((agent) => <div className="studio-list-row" key={agent.id}>
            <span className={`status-orb ${agent.status}`} /><div><strong>{agent.prompt || "Delegated task"}</strong>
              <small>{subAgentStatusLabel(workerStatusFromAgentRecord(agent.status))}{agent.runtime ? ` · ${agent.model ? friendlyModelName(agent.model) : agent.provider === "claude" ? "Claude" : "OpenAI"}` : ""}</small>
              {agent.runtime && <small className="studio-row-detail" title={agent.model ? `${agent.modelSource === "configured" ? "Configured model" : "Reported model"}: ${agent.model}${agent.requestedModel ? ` · Requested: ${agent.requestedModel}` : ""}` : "The provider chooses the model"}>{agent.provider === "claude" ? "Claude" : "OpenAI"}{agent.model ? ` · ${agent.modelSource === "configured" ? "configured" : "reported"}` : " · model chosen by the provider"}{agent.requestedModel ? ` · requested ${friendlyModelName(agent.requestedModel)}` : ""} · {agent.id.slice(0, 8)}</small>}
              {(agent.task || agent.progress || agent.result) && <details><summary className="lm-summary"><ChevronRight size={12} aria-hidden="true" className="lm-chevron" />Task and reported progress</summary>
                {agent.task && <div><small>Assigned task</small><p style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{agent.task}</p></div>}
                {agent.progress && <div><small>Latest reported progress</small><p style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{agent.progress}</p></div>}
                {agent.result && <div><small>Reported result</small><p style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{agent.result}</p></div>}
              </details>}
              {props.agentDetail?.(agent.id)}
            </div>{agent.canAccept && props.onAcceptAgent && <button onClick={() => props.onAcceptAgent!(agent.id)} title="Sign off this work" aria-label={`Sign off sub-agent ${agent.id.slice(0, 8)}`}><Check size={14} /></button>}{agent.canOpen !== false && agent.runtime !== "claude" && <button onClick={() => props.onOpenAgent(agent.id)} title="Open child thread" aria-label={`Open sub-agent ${agent.id.slice(0, 8)}`}><ChevronRight size={14} /></button>}{agent.canStop !== false && agent.runtime !== "claude" && isActiveAgentRecord(agent.status) && <button onClick={() => props.onStopAgent(agent.id)} title="Stop child agent" aria-label={`Stop sub-agent ${agent.id.slice(0, 8)}`}><CircleStop size={14} /></button>}</div>) : <Empty icon={UsersRound} title="No sub-agents in this thread" text="They appear here when the model hands off part of the work. The Sub-agents control under the composer turns this on or off." action={props.onOpenSettings ? { label: "Sub-agent defaults", onClick: () => props.onOpenSettings!("agents") } : undefined} />}</div>
        </>;
}

export type CheckpointsPanelProps = Pick<StudioDockProps, "activeThread" | "checkpoints" | "checkpointHead" | "checkpointBusyId" | "checkpointPreview" | "onClose"
  | "onCheckpoint" | "onFork" | "onCheckpointRestore" | "onCheckpointAccept" | "onCheckpointPreview" | "onCheckpointDelete" | "onRollback"> & {
  /** Offer "Fork conversation" on saved (non-legacy) checkpoints too. Off for local, where it is only for conversation-only ones. */
  forkSavedCheckpoints?: boolean;
  /** Context the rail cannot show, such as the machine a remote panel reads. */
  subtitle?: string;
  /** The list covers every thread in the project; name it so a new thread isn't surprised. */
  projectName?: string;
};
export function CheckpointsPanel(props: CheckpointsPanelProps) {
  const checkpointById = useMemo(
    () => new Map(props.checkpoints.map((checkpoint) => [checkpoint.id, checkpoint])),
    [props.checkpoints],
  );
  const [showUnchanged, setShowUnchanged] = useState(false);
  // A run that changed no files has nothing to restore or review, so it folds
  // into one quiet line unless it is the current position or needs attention.
  const unchanged = (checkpoint: CheckpointRecord) => checkpoint.changedFiles === 0
    && checkpoint.status !== "running" && checkpoint.status !== "failed" && checkpoint.status !== "safety"
    && !checkpoint.error && !checkpoint.overlappingRun && props.checkpointHead?.checkpointId !== checkpoint.id
    && props.checkpointPreview?.id !== checkpoint.id;
  const hiddenCount = showUnchanged ? 0 : props.checkpoints.filter(unchanged).length;
  // Each run's own prompt, when its thread is loaded, so a card says what the
  // run was asked to do instead of only "Before turn 3". A joined string keeps
  // streaming updates elsewhere from re-rendering the list.
  const excerptKey = useTaskStore((state) => props.checkpoints.map((checkpoint) => {
    if (!checkpoint.turnId) return "";
    const message = state.tasks[checkpoint.threadId]?.messages.find((entry) => entry.role === "user" && entry.turnId === checkpoint.turnId && entry.provenance !== "mythra-notice");
    return message ? promptExcerpt(message.text) : "";
  }).join("\u0001"));
  const excerpts = useMemo(() => new Map(excerptKey.split("\u0001").map((excerpt, index) => [props.checkpoints[index]?.id, excerpt])), [excerptKey, props.checkpoints]);
  const visible = showUnchanged ? props.checkpoints : props.checkpoints.filter((checkpoint) => !unchanged(checkpoint));
  return <>
          <PanelHeader tab="checkpoints" subtitle={props.subtitle} onClose={props.onClose} />
          <DockToolbar>
            <button onClick={props.onCheckpoint} disabled={!props.activeThread || Boolean(props.checkpointBusyId)} title={props.activeThread ? "Save the project's files as they are now" : "Open a thread to save a checkpoint"}>
              <Plus size={13} aria-hidden="true" /> {props.checkpointBusyId === "manual" ? "Saving…" : "Save checkpoint"}
            </button>
            <InfoPopover label="About checkpoints" className="dock-note-info" triggerClassName="dock-note-info-trigger" trigger={<Info size={13} aria-hidden="true" />}>
              Every model run is saved automatically. Restoring moves the project&rsquo;s files to that point and saves the current state first. Git commits and ignored files are not changed. Accept only marks a run as reviewed; it does not commit, merge or push.
            </InfoPopover>
          </DockToolbar>
          {props.checkpoints.length > 0 && <div className="checkpoint-section-head">
            <SectionHeading>Project checkpoints</SectionHeading>
            <span className="studio-panel-meta">Every thread in {props.projectName || "this project"}</span>
          </div>}
          <div className="checkpoint-list">
            {visible.length ? visible.map((checkpoint) => {
              const currentPosition = props.checkpointHead?.checkpointId === checkpoint.id
                ? props.checkpointHead.position
                : null;
              // Only the card an operation names is working. A manual save is
              // not tied to any historical card, and treating "manual" as a
              // match made every card in the list appear to be running.
              const workingHere = props.checkpointBusyId === checkpoint.id;
              const busy = Boolean(props.checkpointBusyId);
              const legacy = !checkpoint.workspacePath || checkpoint.status === "legacy" || !checkpoint.beforeCommit;
              const canRestoreBefore = checkpointIsRestorable(checkpoint, "before");
              const canRestoreAfter = checkpointIsRestorable(checkpoint, "after");
              const stats = checkpoint.changedFiles !== undefined
                ? `${checkpoint.changedFiles} file${checkpoint.changedFiles === 1 ? "" : "s"}`
                : `${checkpoint.fileCount ?? 0} source file${checkpoint.fileCount === 1 ? "" : "s"} saved`;
              const at = checkpoint.completedAt ?? checkpoint.createdAt;
              const excerpt = excerpts.get(checkpoint.id);
              // "Ready" only restated that nothing is wrong; it is left out.
              const status = checkpointStatusLabel(checkpoint);
              const statusText = status === "Ready" ? "" : status;
              const restoreItems: AppActionMenuItem[] = checkpoint.status === "safety" ? [] : [
                {
                  id: "after",
                  label: checkpoint.status === "restored-before" ? "After this run: reapply its result" : "After this run: put its result back",
                  icon: <RotateCw size={13} aria-hidden="true" />,
                  disabled: !canRestoreAfter || busy,
                  title: "Put the files back the way this run left them. The current state is saved first.",
                  onSelect: () => props.onCheckpointRestore(checkpoint, "after"),
                },
                {
                  id: "before",
                  label: "Before this run: undo its changes",
                  icon: <RotateCcw size={13} aria-hidden="true" />,
                  disabled: !canRestoreBefore || busy,
                  title: "Undo this run's file changes. The current state is saved first.",
                  onSelect: () => props.onCheckpointRestore(checkpoint, "before"),
                },
              ];
              const moreItems: AppActionMenuItem[] = [
                ...(!legacy && checkpoint.status !== "safety" ? [{
                  id: "accept",
                  label: checkpoint.accepted ? "Undo accept" : "Accept",
                  icon: <Check size={13} aria-hidden="true" />,
                  disabled: checkpoint.status === "running" || busy,
                  title: "Mark this run as reviewed. Nothing is committed, merged or pushed.",
                  onSelect: () => props.onCheckpointAccept(checkpoint),
                }] : []),
                ...(!legacy && props.forkSavedCheckpoints && checkpoint.status !== "safety" ? [{
                  id: "fork",
                  label: "Fork conversation",
                  icon: <GitFork size={13} aria-hidden="true" />,
                  disabled: checkpoint.status === "running" || busy,
                  title: "Start a new conversation from this point",
                  onSelect: () => props.onFork(checkpoint),
                }] : []),
                {
                  id: "delete",
                  label: "Delete checkpoint…",
                  icon: <Trash2 size={13} aria-hidden="true" />,
                  danger: true,
                  disabled: checkpoint.status === "running" || busy,
                  title: `Delete ${checkpoint.label}`,
                  onSelect: () => props.onCheckpointDelete(checkpoint),
                },
              ];
              return (
                <article className={`checkpoint-card ${currentPosition ? "current" : ""} ${checkpoint.accepted ? "accepted" : ""}`} key={checkpoint.id} aria-label={excerpt ? `${checkpoint.label}: ${excerpt}` : checkpoint.label}>
                  <div className="checkpoint-card-head">
                    <span className={`checkpoint-state-icon ${checkpoint.status ?? "legacy"}`} aria-hidden="true">
                      {checkpoint.status === "running" || workingHere ? <RefreshCw className="spin" size={13} /> : checkpoint.accepted ? <Check size={13} /> : <Clock3 size={13} />}
                    </span>
                    <div>
                      {/* The point it restores to leads, with its thread; the
                          prompt that run was asked is the excerpt under it. */}
                      {/* The thread gets its own line, so a long title never cuts it (Sol M06). */}
                      <strong className="checkpoint-title" title={[checkpoint.label, checkpoint.threadLabel].filter(Boolean).join(" · ")}>{checkpoint.label}</strong>
                      {checkpoint.threadLabel && <span className="checkpoint-thread-line" title={checkpoint.threadLabel}>{checkpoint.threadLabel}</span>}
                      {excerpt && <span className="checkpoint-excerpt" title={excerpt}>{excerpt}</span>}
                      <small>
                        {[statusText, currentPosition ? `current ${currentPosition} state` : ""].filter(Boolean).join(" · ")}
                        {!legacy && checkpoint.status !== "running" && checkpoint.status !== "failed" && <>{statusText || currentPosition ? " · " : ""}{stats}{checkpoint.changedFiles !== undefined && <span className="checkpoint-counts"> <ins>+{checkpoint.additions ?? 0}</ins> <del>−{checkpoint.deletions ?? 0}</del></span>}</>}
                      </small>
                    </div>
                    <time dateTime={new Date(at).toISOString()} title={new Date(at).toLocaleString()}>{relativeAge(at) ?? new Date(at).toLocaleDateString()}</time>
                  </div>
                  {(checkpoint.model || checkpoint.branch) && <div className="checkpoint-meta">
                    {checkpoint.model && <span title={[checkpoint.provider, checkpoint.model].filter(Boolean).join(" · ")}>{friendlyModelName(checkpoint.model)}</span>}
                    {checkpoint.branch && <span className="checkpoint-branch">{checkpoint.branch}</span>}
                  </div>}
                  {checkpoint.parentId && <div className="checkpoint-lineage">Continues from {checkpointById.get(checkpoint.parentId)?.label ?? "an earlier saved state"}{checkpoint.parentPosition ? ` · ${checkpoint.parentPosition}` : ""}</div>}
                  {checkpoint.restoredFromId && <div className="checkpoint-lineage">Safety copy created before a restore</div>}
                  {checkpoint.overlappingRun && <div className="checkpoint-error">Another thread edited this folder during the run, so this snapshot can include its changes too.</div>}
                  {checkpoint.error && <div className="checkpoint-error">{checkpoint.error}</div>}
                  <div className="checkpoint-actions">
                    {legacy ? (
                      <button onClick={() => props.onFork(checkpoint)} disabled={busy}><GitFork size={12} aria-hidden="true" /> Fork conversation</button>
                    ) : <>
                      <button onClick={() => props.onCheckpointPreview(checkpoint)} disabled={!checkpoint.afterCommit || busy} aria-expanded={props.checkpointPreview?.id === checkpoint.id}><Eye size={12} aria-hidden="true" /> {props.checkpointPreview?.id === checkpoint.id ? "Hide changes" : "Preview"}</button>
                      {checkpoint.status === "safety" ? (
                        <button onClick={() => props.onCheckpointRestore(checkpoint, "after")} disabled={!canRestoreAfter || busy}><RotateCw size={12} aria-hidden="true" /> Restore safety copy</button>
                      ) : (
                        <AppActionMenu className="checkpoint-restore-menu" label="Restore…" icon={<RotateCcw size={12} aria-hidden="true" />} ariaLabel={`Restore… ${checkpoint.label}: choose before or after this run`} items={restoreItems} disabled={busy || (!canRestoreBefore && !canRestoreAfter)} align="start" />
                      )}
                    </>}
                    <AppActionMenu compact ariaLabel={`More actions for ${checkpoint.label}`} items={moreItems} />
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
            }) : props.checkpoints.length ? null : <Empty icon={History} title="No checkpoints yet" text="Each model run saves one, so you can roll the project's files back." />}
            {hiddenCount > 0 && (
              <button type="button" className="checkpoint-unchanged-toggle" onClick={() => setShowUnchanged(true)}>
                {hiddenCount} run{hiddenCount === 1 ? "" : "s"} with no file changes · Show
              </button>
            )}
            {showUnchanged && props.checkpoints.some(unchanged) && (
              <button type="button" className="checkpoint-unchanged-toggle" onClick={() => setShowUnchanged(false)}>Hide runs with no file changes</button>
            )}
          </div>
          <SectionHeading>This thread</SectionHeading>
          <div className="studio-actions wrap">
            <button onClick={() => props.onFork()} disabled={!props.activeThread} title="Continue in a new copy of this conversation"><GitFork size={13} aria-hidden="true" /> Fork thread</button>
            <button onClick={props.onRollback} disabled={!props.activeThread} title="Remove the latest exchange from the chat. Project files stay as they are."><RotateCcw size={13} aria-hidden="true" /> Undo last turn</button>
          </div>
        </>;
}

export type WorktreesPanelProps = {
  revealLabel?: string;
  /** Context the rail cannot show, such as the machine a remote panel reads. */
  subtitle?: string;
  /** The project has no Git repository, so worktrees are not possible yet. */
  repositoryAbsent?: boolean;
  onInitializeGit?: () => void;
  /** Starts a new thread with Isolated worktree already chosen. */
  onNewIsolatedThread?: () => void;
} & Pick<StudioDockProps, "worktree" | "worktreeStatus" | "worktreeBusy" | "gitActionsReadOnly" | "onClose" | "onWorktreeReview" | "onWorktreeApply"
  | "onWorktreeMerge" | "onWorktreeReveal" | "onWorktreeRefresh" | "onWorktreeRemove" | "onWorktreeRecreate" | "onWorktreeContinueShared" | "onWorktreeReturnShared">;
export function WorktreesPanel(props: WorktreesPanelProps) {
  return <>
          <PanelHeader tab="worktrees" subtitle={props.subtitle} onClose={props.onClose} />
          {props.repositoryAbsent && !props.worktree ? (
            <Empty icon={GitFork} title="Not a Git repository" text="Worktrees need Git. Initialize it to give a thread its own isolated branch." action={props.onInitializeGit ? { label: "Initialize Git", icon: GitBranch, onClick: props.onInitializeGit } : undefined} />
          ) : props.worktree ? (
            <div className="worktree-card">
              <div className="worktree-card-head">
                <span><GitBranch size={14} /></span>
                <div><strong>{props.worktree.branch}</strong><small>{props.worktree.path}</small></div>
                <em>{worktreeStatusLabel(props.worktree.status)}</em>
                <InfoPopover label="About worktrees" className="dock-note-info" triggerClassName="dock-note-info-trigger" trigger={<Info size={13} aria-hidden="true" />}>
                  This thread works on its own branch, so the shared project stays untouched. Copying brings the resulting files across; merging brings the committed history across. Both stay on this computer and never touch GitHub unless you push or turn on automatic publishing.
                </InfoPopover>
              </div>
              {props.worktreeStatus && (
                <div className="worktree-metrics">
                  <span><strong>{props.worktreeStatus.changedFiles}</strong> changed</span>
                  <span><strong>{props.worktreeStatus.ahead}</strong> commits ahead</span>
                  <span><strong>{props.worktreeStatus.ignoredFileCount}</strong> ignored</span>
                </div>
              )}
              {props.worktree.status === "missing" || props.worktree.status === "removed" ? (
                <div className="studio-actions wrap">
                  {props.worktree.status === "missing" && <button onClick={props.onWorktreeRecreate} disabled={props.worktreeBusy}><RotateCw size={13} /> Recreate from branch</button>}
                  {props.worktree.status === "removed" && <button onClick={props.onWorktreeContinueShared} disabled={props.worktreeBusy}><FolderOpen size={13} /> Continue shared</button>}
                </div>
              ) : worktreeMergeComplete(props.worktree, props.worktreeStatus) ? (
                /* A finished merge, and still finished: the branch head is
                   exactly what was merged and the folder is clean. */
                <>
                  <DockNote tone="success" icon={CheckCircle2} role="status">
                    <strong>Merged into local project.</strong> GitHub updates are separate.
                  </DockNote>
                  <div className="studio-actions wrap">
                    <button onClick={props.onWorktreeReview} disabled={props.worktreeBusy}><FileDiff size={13} /> Review merged changes</button>
                    {props.onWorktreeReturnShared && (
                      <button onClick={props.onWorktreeReturnShared} disabled={props.worktreeBusy}><FolderOpen size={13} /> Continue in shared project</button>
                    )}
                    <AppActionMenu label="More" ariaLabel="More worktree actions" items={worktreeMenuItems(props)} />
                  </div>
                </>
              ) : (
                <>
                  {/* Merged once, then worked in again — or merged once and no
                      longer verifiable. Both are reported for what they are:
                      the old completion state simply claimed the branch was
                      still fully merged, indefinitely. */}
                  {worktreeMergeFollowUp(props.worktree, props.worktreeStatus) && (
                    <DockNote tone="warning" icon={TriangleAlert}>{worktreeMergeFollowUp(props.worktree, props.worktreeStatus)}</DockNote>
                  )}
                  <div className="studio-actions wrap">
                    <button onClick={props.onWorktreeReview} disabled={props.worktreeBusy}><FileDiff size={13} /> Review changes</button>
                    <button onClick={props.onWorktreeApply} disabled={props.worktreeBusy || props.gitActionsReadOnly} title="Copy the resulting files into the shared project folder, without their commit history"><RotateCw size={13} /> Copy changes to project</button>
                    <button
                      onClick={props.onWorktreeMerge}
                      disabled={props.worktreeBusy || props.gitActionsReadOnly}
                      title={`Merge this branch's committed history into your local project${props.worktreeStatus?.sourceBranch ? ` (${props.worktreeStatus.sourceBranch})` : ""}. This is a local merge — it does not touch GitHub.`}
                    ><GitCommitHorizontal size={13} /> Merge into local project…</button>
                    <AppActionMenu label="More" ariaLabel="More worktree actions" items={worktreeMenuItems(props)} />
                  </div>
                  {props.gitActionsReadOnly && <DockNote tone="warning" icon={ShieldCheck}>Switch this thread to Ask to act or Full access before copying or merging changes into the local project.</DockNote>}
                </>
              )}
            </div>
          ) : (
            <Empty
              icon={GitFork}
              title="No worktree for this thread"
              text="This thread works in the shared project folder. An isolated branch is chosen when a new thread starts."
              action={props.onNewIsolatedThread ? { label: "New isolated thread", icon: GitBranch, onClick: props.onNewIsolatedThread } : undefined}
            />
          )}
        </>;
}

/**
 * Every Tools panel starts with this header: the tab's name (the same name
 * as its selected rail button) and small icon actions such as Refresh. The
 * Tools button in the top bar (and ⌘B) closes the dock, so the header
 * carries no second close button. `subtitle` is for context the rail cannot
 * show, such as which machine a remote panel is reading.
 */
export function PanelHeader({ tab, title, subtitle, actions }: {
  /** Supplies the title, so a panel's name always matches its tab. */
  tab?: StudioTab;
  /** @deprecated The header no longer repeats the rail's icon. */
  icon?: typeof CodeXml;
  title?: string;
  subtitle?: string;
  /** HeaderAction buttons. */
  actions?: ReactNode;
  /** @deprecated Kept for callers; the top bar's Tools button closes the dock. */
  onClose?: () => void;
}) {
  const name = title ?? (tab ? STUDIO_TAB_META[tab].label : "Tools");
  return <div className={`studio-header${actions ? " has-actions" : ""}`}>
    <div className="studio-header-title"><h2>{name}</h2>{subtitle && <span className="studio-header-context" title={subtitle}>{subtitle}</span>}</div>
    {actions && <div className="studio-header-actions">{actions}</div>}
  </div>;
}

/** A 28px icon button for the panel header; its label is its tooltip. */
export function HeaderAction({ icon: Icon, label, onClick, disabled, busy, title }: {
  icon: typeof CodeXml;
  label: string;
  onClick?: () => void;
  disabled?: boolean;
  busy?: boolean;
  title?: string;
}) {
  // The name shows as a visible tooltip on hover and keyboard focus; a longer
  // explanation, when there is one, stays in the native title.
  return <button type="button" className="icon-button studio-header-action" onClick={onClick} disabled={disabled} aria-busy={busy || undefined} aria-label={label} data-tip={label} title={title && title !== label ? title : undefined}>
    <Icon size={14} className={busy ? "spin" : undefined} aria-hidden="true" />
  </button>;
}

/** The row of labelled commands for a tab, directly under its header. */
export function DockToolbar({ children }: { children: ReactNode }) {
  return <div className="studio-actions wrap studio-toolbar">{children}</div>;
}

/** The one section heading style used in every Tools panel. */
export function SectionHeading({ children, id }: { children: ReactNode; id?: string }) {
  return <h3 className="panel-label" id={id}>{children}</h3>;
}

/**
 * The one note style: an icon, one short line, and the longer explanation
 * behind an ⓘ. Tones tint the note using the theme's status colours.
 */
export function DockNote({ tone = "info", icon: Icon = Info, info, role, children }: {
  tone?: "info" | "warning" | "error" | "success";
  icon?: typeof CodeXml;
  info?: ReactNode;
  role?: "status" | "alert";
  children: ReactNode;
}) {
  return <div className={`dock-note ${tone}`} role={role}>
    <Icon size={13} aria-hidden="true" />
    <span className="dock-note-text">{children}</span>
    {info && <InfoPopover label="More about this" className="dock-note-info" triggerClassName="dock-note-info-trigger" trigger={<Info size={13} aria-hidden="true" />}>{info}</InfoPopover>}
  </div>;
}

/** A user prompt's first line, short enough for a card title. */
function promptExcerpt(text: string): string {
  const line = text.replace(/[`*_#>]+/g, "").replace(/\s+/g, " ").trim();
  // Two lines are shown (CSS clamps them); the rest reads on hover or focus.
  return line.length > 400 ? `${line.slice(0, 398).trimEnd()}…` : line;
}

/** Display names for the model ids runs report, e.g. gpt-5.6-sol → GPT-5.6 Sol. */
export function friendlyModelName(model: string): string {
  const claude = /^claude-([a-z]+)-(\d+)(?:-(\d+))?$/.exec(model);
  if (claude) return `Claude ${claude[1][0].toUpperCase()}${claude[1].slice(1)} ${claude[2]}${claude[3] ? `.${claude[3]}` : ""}`;
  const gpt = /^gpt-([\d.]+)(?:-([a-z]+))?$/.exec(model);
  if (gpt) return `GPT-${gpt[1]}${gpt[2] ? ` ${gpt[2][0].toUpperCase()}${gpt[2].slice(1)}` : ""}`;
  return model;
}

/** The dock itself: its edge, tabs and panel. Each machine fills the panel. */
export function StudioDockFrame({ children, ...props }: {
  open: boolean;
  /** A modal (Settings, onboarding, voice input) covers the app: keep the dock out of reach. */
  covered?: boolean;
  rootRef?: Ref<HTMLElement>;
  onResizeStart?: (event: React.PointerEvent) => void;
  onResizeKeyDown?: (event: React.KeyboardEvent) => void;
  resizeValue?: number;
  /** The widest the dock may be dragged to in this window (defaults to the pane bound). */
  resizeMax?: number;
  tab: StudioTab;
  onTab: (tab: StudioTab) => void;
  /** The Changes panel lays out as header, scrolling body and a fixed commit footer. */
  fillChanges?: boolean;
  /** Changes is in wide review: the dock takes most of the window until turned off. */
  wide?: boolean;
  /** Leaves wide review (a click on the dimmed strip of conversation beside it). */
  onExitWide?: () => void;
  /** How much wider (shell px) wide review would draw the dock in this window. */
  onWideRoom?: (gain: number) => void;
  children: ReactNode;
}) {
  const tabsRef = useRef<HTMLDivElement>(null);
  const ownRootRef = useRef<HTMLElement | null>(null);
  const forwardedRef = props.rootRef;
  const setRoot = useMemo(() => (node: HTMLElement | null) => {
    ownRootRef.current = node;
    if (typeof forwardedRef === "function") forwardedRef(node);
    else if (forwardedRef) (forwardedRef as { current: HTMLElement | null }).current = node;
  }, [forwardedRef]);
  // Closing the dock while focus is inside it (⌘B from the terminal, say)
  // would drop focus to the page. Hand it to the button that reopens it.
  useEffect(() => {
    if (props.open) return;
    const root = ownRootRef.current;
    if (!root || !root.contains(document.activeElement)) return;
    const trigger = document.querySelector<HTMLElement>(".workspace-tools-trigger:not(:disabled)")
      ?? document.querySelector<HTMLElement>(".composer textarea");
    trigger?.focus();
  }, [props.open]);
  // Wide review is a drawer that starts below the top bar, so the app's
  // status, Run, Search and the Tools panel toggle stay visible and usable. Its
  // top edge follows the bar's real height (it can wrap onto two rows) and the
  // dimmed strip beside it starts where the chat column does.
  const wideShown = Boolean(props.wide && props.open);
  const [reviewEdge, setReviewEdge] = useState<{ top: number; left: number; strip: number } | null>(null);
  const onWideRoom = props.onWideRoom;
  const measuresWide = props.open && (wideShown || Boolean(onWideRoom));
  useLayoutEffect(() => {
    if (!measuresWide) { setReviewEdge(null); return; }
    const topbar = document.querySelector<HTMLElement>(".local-machine-surface > .topbar");
    const main = document.querySelector<HTMLElement>(".main-panel");
    const dock = ownRootRef.current;
    const measure = () => {
      // Layout pixels (offset*), so the values stay right under UI zoom.
      const top = topbar ? topbar.offsetTop + topbar.offsetHeight : 0;
      const left = main ? main.offsetLeft : 0;
      // In wide review the dock floats and the main panel runs to the edge.
      const docked = dock && !dock.classList.contains("review-wide") ? dock.offsetWidth : 0;
      const shellWidth = main ? main.offsetLeft + main.offsetWidth + docked : 0;
      const fit = reviewWideFit({ shellWidth, mainLeft: left, mainWidth: shellWidth - left });
      if (!wideShown && docked) onWideRoom?.(fit.width - docked);
      if (!wideShown) return;
      setReviewEdge((current) => current && current.top === top && current.left === left && current.strip === fit.strip ? current : { top, left, strip: fit.strip });
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    if (topbar) observer?.observe(topbar);
    if (main) observer?.observe(main);
    if (dock) observer?.observe(dock);
    window.addEventListener("resize", measure);
    return () => { observer?.disconnect(); window.removeEventListener("resize", measure); };
  }, [measuresWide, wideShown, onWideRoom]);
  const reviewEdgeStyle = wideShown && reviewEdge
    ? { "--review-top": `${reviewEdge.top}px`, "--review-left": `${reviewEdge.left}px`, "--review-strip": `${reviewEdge.strip}px` } as CSSProperties
    : undefined;
  // Leaving wide review (Narrow, Escape, the dimmed strip, ⌘L) must not drop
  // focus onto the page: if it isn't somewhere useful, the toggle takes it.
  const wasWide = useRef(false);
  useEffect(() => {
    const leaving = wasWide.current && !wideShown;
    wasWide.current = wideShown;
    if (!leaving || !props.open) return;
    const frame = requestAnimationFrame(() => {
      const active = document.activeElement as HTMLElement | null;
      if (active && active !== document.body && !active.closest("[inert]")) return;
      ownRootRef.current?.querySelector<HTMLElement>(".diff-wide-toggle")?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [wideShown, props.open]);
  const idPrefix = useId();
  const tabId = (tab: StudioTab) => `${idPrefix}-tab-${tab}`;
  const panelId = `${idPrefix}-panel`;

  // Vertical tablist: arrows move between tabs and select as they go, Home and
  // End jump to the ends. Focus follows selection so the panel below always
  // matches what the roving tab stop is on.
  const moveTab = (offset: number, absolute?: "first" | "last") => {
    const index = TABS.findIndex((entry) => entry.id === props.tab);
    const next = absolute === "first"
      ? 0
      : absolute === "last"
        ? TABS.length - 1
        : (index + offset + TABS.length) % TABS.length;
    const target = TABS[next];
    props.onTab(target.id);
    tabsRef.current?.querySelector<HTMLButtonElement>(`[data-studio-tab="${target.id}"]`)?.focus();
  };

  return (<>
    <aside ref={setRoot} className={`studio-dock ${props.open ? "open" : "closed"}${wideShown ? " review-wide" : ""}`} style={reviewEdgeStyle} aria-label="Tools" aria-hidden={!props.open || props.covered || undefined} inert={!props.open || props.covered ? true : undefined}>
      {props.onResizeStart && (
        <div
          className="pane-resize dock-resize"
          onPointerDown={props.onResizeStart}
          onKeyDown={props.onResizeKeyDown}
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize Tools"
          title="Drag to resize Tools (or use the arrow keys)"
          aria-valuemin={PANE_BOUNDS.dock.min}
          aria-valuemax={props.resizeMax ?? PANE_BOUNDS.dock.max}
          aria-valuenow={props.resizeValue === undefined ? undefined : Math.round(props.resizeValue)}
          tabIndex={0}
        />
      )}
      <div
        className="studio-tabs"
        role="tablist"
        aria-orientation="vertical"
        aria-label="Tools"
        ref={tabsRef}
        // Drives the sliding selection indicator below; presentation only.
        // Each group the selected tab sits below adds one separator's step.
        style={{
          "--studio-tab-index": Math.max(0, TABS.findIndex((entry) => entry.id === props.tab)),
          "--studio-tab-group": TABS.find((entry) => entry.id === props.tab)?.group ?? 0,
        } as CSSProperties}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowRight") { event.preventDefault(); moveTab(1); }
          else if (event.key === "ArrowUp" || event.key === "ArrowLeft") { event.preventDefault(); moveTab(-1); }
          else if (event.key === "Home") { event.preventDefault(); moveTab(0, "first"); }
          else if (event.key === "End") { event.preventDefault(); moveTab(0, "last"); }
        }}
      >
        {TABS.map(({ id, label, icon: Icon, group }, index) => [
          index > 0 && TABS[index - 1].group !== group && <span key={`group-${group}`} className="studio-tab-separator" aria-hidden="true" />,
          <button
            key={id}
            id={tabId(id)}
            data-studio-tab={id}
            data-studio-group={group}
            data-ct-control="tools-tab"
            role="tab"
            className={props.tab === id ? "active" : ""}
            onClick={() => props.onTab(id)}
            title={label}
            aria-label={label}
            aria-selected={props.tab === id}
            aria-controls={panelId}
            tabIndex={props.tab === id ? 0 : -1}
          >
            <Icon size={16} /><span>{label}</span>
          </button>,
        ])}
        <span className="studio-tab-indicator" aria-hidden="true" />
      </div>
      {/* The terminal sizes to the dock instead of the window, so its panel
          lays out as a column the terminal can flex into. */}
      <div className={`studio-panel${props.tab === "terminal" ? " fill" : props.tab === "changes" && props.fillChanges ? " fill changes-fill" : ""}`} role="tabpanel" id={panelId} aria-labelledby={tabId(props.tab)} tabIndex={0}>
        {children}
      </div>
    </aside>
    {/* The conversation beside wide review is dimmed and inert (App), and a
        click on it returns the Tools panel to its usual width. Pointer only:
        keyboard users have Narrow and Escape. */}
    {wideShown && !props.covered && (
      <div
        className="review-wide-scrim"
        style={reviewEdgeStyle}
        aria-hidden="true"
        title="Return Tools to its usual width"
        onPointerDown={(event) => { if (event.button === 0) { event.preventDefault(); props.onExitWide?.(); } }}
      />
    )}
  </>);
}

export function StudioDock(props: {
  open: boolean;
  /** A modal (Settings, onboarding, voice input) covers the app. */
  covered?: boolean;
  /**
   * The dock's width is published as --dock-width on the root this ref
   * receives, so a drag can move the edge without re-rendering this tree. The
   * resize props only carry the separator's behaviour and its announced value.
   */
  rootRef?: Ref<HTMLElement>;
  onResizeStart?: (event: React.PointerEvent) => void;
  onResizeKeyDown?: (event: React.KeyboardEvent) => void;
  resizeValue?: number;
  resizeMax?: number;
  tab: StudioTab;
  projectName?: string;
  projectPath?: string;
  /** A separate Files source for callers whose project isn't on this device. */
  fileSource?: FileBrowserSource;
  activeThread: boolean;
  /** For the last turn's instruction receipt in Thread usage. */
  activeThreadId?: string | null;
  /** The diff for the selected Changes scope (Uncommitted unless the person chose otherwise). */
  reviewDiff: ReviewDiff;
  /** A caller-supplied starting view that takes precedence over saved preferences. */
  initialChangesMode?: "list" | "diff";
  /** Which comparison `reviewDiff` is. Uncommitted is the default and what commits act on. */
  changesScope?: ChangesScope;
  /** The push comparison can be computed for this thread. */
  pushedScopeAvailable?: boolean;
  onChangesScope?: (scope: ChangesScope) => void;
  /** Review notes staged in the composer and not sent yet (shown while wide review covers it). */
  feedbackNoteCount?: number;
  /** Leave wide review and move to the message holding those notes. Never sends. */
  onOpenFeedbackDraft?: () => void;
  /** Re-read the uncommitted diff, in step with the Files list. */
  onRefreshWorkingDiff?: () => void;
  /**
   * Wide review, owned by App: the conversation it covers is made inert there,
   * and Escape or ⌘L leave it before anything else. Without these, the dock
   * keeps its own state.
   */
  reviewWide?: boolean;
  onReviewWideChange?: (wide: boolean) => void;
  /** This thread's automatic compaction, shown beside Compact context. */
  threadCompaction?: ThreadCompactionSetting;
  /** Starts a new thread with Isolated worktree chosen (Worktree empty state). */
  onNewIsolatedThread?: () => void;
  /** Set when AI review cannot run for this thread's provider. */
  reviewDisabledReason?: string;
  /** The project's Run checks control (ChecksControl), shown beside AI review. */
  checksControl?: ReactNode;
  agents: AgentRecord[];
  terminalOutput: TerminalOutputStore;
  terminalRunning: boolean;
  terminalRunningCommand: string;
  terminalRunningElsewhere: RunningTerminalCommand[];
  commandsReadOnly: boolean;
  checkpoints: CheckpointRecord[];
  checkpointHead?: CheckpointHead;
  checkpointBusyId?: string | null;
  checkpointPreview?: { id: string; diff: string } | null;
  worktree?: ThreadWorktreeRecord;
  worktreeStatus?: WorktreeStatus | null;
  worktreeBusy?: boolean;
  usage: TokenUsageView | null;
  nativeAgentLinks: Record<string, NativeAgentLink>;
  managedAgentLinks: OwnershipLinks;
  usageProvider: Provider;
  contextTurnId?: string;
  threadTitle?: string;
  visibleAttachments: { images: number; documents: number; files: number };
  skills: SkillView[];
  mcpServers: McpView[];
  gitOutput: string;
  gitCommitSuccess: string;
  gitCommitSuccessRevision?: number;
  gitCommitBusy: boolean;
  gitOperationBusy?: boolean;
  gitRepositoryState: GitRepositoryState;
  gitRepositoryStateDetail?: string;
  gitInitializing: boolean;
  githubAuthenticated: boolean;
  githubBusy?: boolean;
  githubOperationError?: string;
  githubRepoStatus: GitHubRepoStatus | null;
  githubRepoError?: string;
  gitActionsReadOnly: boolean;
  defaultRepositoryName: string;
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
  onRunTerminal: (command: string) => void;
  onStopTerminal: () => void;
  onClearTerminal: () => void;
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
  /** Open the explicit cleanup confirmation before returning to the shared folder. */
  onWorktreeReturnShared?: () => void;
  onRefreshUsage: () => void;
  onCompact: () => void;
  onRefreshTools: () => void;
  onGitAction: (action: GitPanelAction, commitMessage?: string) => void;
  onRegenerateCommitMessage?: () => void;
  commitSuggestionBusy?: boolean;
  onInitializeGit: () => void;
  onGitHubAttach: (url: string) => void;
  onGitHubCreate: (name: string, visibility: "private" | "public") => void;
  onOpenGitHubSettings: () => void;
  onGitPathAction: (action: "stage" | "revert", path: string) => void;
  /** Per-file unstage in Review. Optional; without it files only offer Stage. */
  onGitPathUnstage?: (path: string) => void;
  /** Repository-relative paths currently in the index, for the Review list. */
  reviewStagedPaths?: string[];
  /**
   * The per-thread pull request workflow. It is handed to the Git panel, which
   * places it after the local commit controls — a pull request is a step you
   * reach after committing, not the first thing the dock should show.
   * Optional so the dock keeps working wherever the workflow is not wired up.
   */
  pullRequestPanel?: ReactNode;
  /** Local branch state, branch switching and optional automatic publishing. */
  gitWorkflow?: GitWorkflowControls;
  /** Bounded project Changes and History reads; needs no AI thread. */
  projectGitInspection?: ProjectGitInspection;
  /** Project-owned pull request browsing, details, create and merge. */
  projectPullRequests?: ProjectPullRequestAccess;
  /** A request to show a Git view and focus one of its controls. */
  gitRoute?: GitRoute | null;
  onAttachPath: (path: string) => void;
  onProjectAction: (action: ProjectAction) => void;
  onRunWorkflow: (workflow: WorkflowDefinition) => void;
  onStopWorkflow: (workflowId: string) => void;
  onOpenWorkflowRun: (threadId: string) => void;
  onToggleSkill: (path: string) => void;
  onConnectMcp: (server: McpView) => void;
  /** Opens one Settings pane, for empty states that need setting up there. */
  /** `row` lands on one setting (a Settings row id), as search does. */
  onOpenSettings?: (section: SettingsSection, row?: string) => void;
  /** The project's Run command, also offered in the Actions tab. */
  projectRun?: ProjectRunCommand;
  projectRunRunning?: boolean;
  onProjectRun?: () => void;
  onProjectRunStop?: () => void;
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
  useEffect(() => {
    if (!props.open || loadedTerminalPanel) return;
    return scheduleIdlePreload(preloadTerminalPanel, 0);
  }, [props.open]);
  // The Git view survives dock tab switches; a route request picks it and
  // hands its focus target to the panel once.
  // The Git tab's own view (history or pull requests) survives tab switches,
  // as does the Changes tab's list or full diff.
  const [gitView, setGitView] = useState<GitView>("history");
  const [changesMode, setChangesModeState] = useState(() => props.initialChangesMode ?? readChangesMode());
  const setChangesMode = (mode: "list" | "diff") => {
    setChangesModeState(mode);
    try { window.localStorage.setItem(CHANGES_MODE_KEY, mode); } catch { /* private mode: keep it for this session */ }
  };
  const [pendingGitFocus, setPendingGitFocus] = useState<{ route: GitRoute; scope: string } | null>(null);
  // The Files list's last settled read: Refresh's tooltip says how fresh it is,
  // and each new read re-reads the uncommitted diff so Diff never lags Files.
  // The Changes "…" menu sits in the panel header with AI review and Refresh.
  const [changesMenuHost, setChangesMenuHost] = useState<HTMLElement | null>(null);
  const [changesRead, setChangesRead] = useState<{ loadedAt: number | null; loading: boolean }>({ loadedAt: null, loading: false });
  const onRefreshWorkingDiff = props.onRefreshWorkingDiff;
  const lastWorkingDiffRead = useRef<number | null>(null);
  const onChangesLoaded = useMemo(() => (state: { loadedAt: number | null; loading: boolean }) => {
    setChangesRead((current) => current.loadedAt === state.loadedAt && current.loading === state.loading ? current : state);
    if (state.loadedAt && state.loadedAt !== lastWorkingDiffRead.current) {
      lastWorkingDiffRead.current = state.loadedAt;
      onRefreshWorkingDiff?.();
    }
  }, [onRefreshWorkingDiff]);
  // A changed file named in the transcript opens here, on that exact file:
  // Changes switches to Diff (for this visit; the saved preference stays) and
  // the file's heading takes focus, or a clear "no diff" state says why not.
  const diffScope = `${props.projectPath ?? ""}\u0000${props.activeThreadId ?? ""}`;
  const [fileRequest, setFileRequest] = useState<{ scope: string; path: string; nonce: number } | null>(null);
  const [dismissedLink, setDismissedLink] = useState<number | null>(null);
  if (fileRequest && fileRequest.scope !== diffScope) setFileRequest(null);
  const projectRoot = props.gitWorkflow?.snapshot?.rootPath ?? props.projectPath;
  const selectedFileRequest = useMemo(() => fileRequest && fileRequest.scope === diffScope
    ? { path: projectRelativePath(fileRequest.path, [projectRoot]), nonce: fileRequest.nonce }
    : null, [diffScope, fileRequest, projectRoot]);
  const linkTarget = selectedFileRequest && selectedFileRequest.nonce !== dismissedLink ? selectedFileRequest : null;
  const fileRequestNonce = useRef(0);
  const linkFocusHandled = useRef(0);
  // Uncommitted can show the staged version alone: exactly what "Commit N
  // staged" records (see changesScope.ts). A view, not a saved scope.
  const [stagedViewOn, setStagedViewOn] = useState(false);
  // Room wide review would add in this window (measured by the frame).
  const [wideGain, setWideGain] = useState(Number.POSITIVE_INFINITY);
  // Wide review: the dock takes most of the window while reading a diff.
  const [ownReviewWide, setOwnReviewWide] = useState(false);
  const reviewWide = props.onReviewWideChange ? Boolean(props.reviewWide) : ownReviewWide;
  const setReviewWide = props.onReviewWideChange ?? setOwnReviewWide;
  useEffect(() => { if (!props.open) setOwnReviewWide(false); }, [props.open]);
  const diffWrap = useDiffWrap();
  useEffect(() => {
    const onOpenChanges = (event: Event) => {
      const path = (event as CustomEvent<{ path?: unknown }>).detail?.path;
      if (typeof path !== "string" || !path.trim()) return;
      fileRequestNonce.current += 1;
      setFileRequest({ scope: diffScope, path, nonce: fileRequestNonce.current });
      setStagedViewOn(false);
      setChangesModeState("diff");
    };
    window.addEventListener("mythra:open-changes", onOpenChanges);
    return () => window.removeEventListener("mythra:open-changes", onOpenChanges);
  }, [diffScope]);
  const handledGitRoute = useRef(0);
  useEffect(() => {
    const route = props.gitRoute;
    if (!route || route.nonce <= handledGitRoute.current) return;
    handledGitRoute.current = route.nonce;
    // "changes" is the Changes tab itself; the Git tab keeps its last view.
    if (route.view !== "changes") setGitView(route.view);
    // The push comparison replaces the commit editor. Open the uncommitted
    // file list for a Commit shortcut without changing the saved Diff preference.
    if (route.focus === "commit" && props.changesScope === "pushed") setChangesModeState("list");
    setPendingGitFocus({ route, scope: props.projectPath ?? "" });
  }, [props.gitRoute, props.projectPath, props.changesScope]);
  useEffect(() => {
    setPendingGitFocus((current) => current && current.scope !== (props.projectPath ?? "") ? null : current);
  }, [props.projectPath]);
  useEffect(() => {
    if (!props.open || (props.tab !== "git" && props.tab !== "changes")) setPendingGitFocus(null);
  }, [props.open, props.tab]);
  // Keep small form drafts here, not mounted Git/PR panels, when tabs close.
  // Checkout identity also separates isolated worktrees of the same project.
  const [gitDrafts, setGitDrafts] = useState<Record<string, GitPanelDraft>>({});
  const gitDraftScope = props.projectPath ?? "";
  const gitDraft = gitDrafts[gitDraftScope] ?? {
    commitMessage: "", remoteInput: "", repositoryName: props.defaultRepositoryName, visibility: "private" as const,
  };
  const suggestion = useCommitMessageStore((state) => state.suggestions[commitMessageScope(gitDraftScope)]);
  const snapshot = props.gitWorkflow?.snapshot;
  const commitSuggestion = suggestion && snapshot && suggestion.context.headOid === snapshot.headOid
    && suggestion.context.branch === snapshot.branch ? suggestion : undefined;
  const stagedDraft = (snapshot?.stagedFiles ?? 0) > 0 && gitDraft.commitScope !== "all";
  useEffect(() => {
    setGitDrafts((current) => {
      const draft = current[gitDraftScope] ?? { commitMessage: "", remoteInput: "", repositoryName: props.defaultRepositoryName, visibility: "private" as const };
      if (draft.commitMessageEdited || draft.commitMessage && !draft.commitMessageSuggestionId) return current;
      const message = commitSuggestion ? (stagedDraft ? commitSuggestion.stagedMessage : commitSuggestion.message) : undefined;
      const token = commitSuggestion ? (stagedDraft ? commitSuggestion.context.stagedToken : commitSuggestion.context.changesToken) : undefined;
      if (!message) {
        if (!draft.commitMessageSuggestionId) return current;
        return { ...current, [gitDraftScope]: { ...draft, commitMessage: "", commitMessageSuggestionId: undefined, commitMessageToken: undefined, commitScope: undefined } };
      }
      if (draft.commitMessageSuggestionId === commitSuggestion!.id && draft.commitMessageToken === token) return current;
      return { ...current, [gitDraftScope]: { ...draft, commitMessage: message, commitMessageSuggestionId: commitSuggestion!.id, commitMessageToken: token } };
    });
  }, [commitSuggestion, stagedDraft, gitDraftScope, props.defaultRepositoryName]);
  const submittedGitMessages = useRef(new Map<string, { message: string; success: string; revision?: number }>());
  useEffect(() => {
    if (!props.gitCommitSuccess || props.gitCommitBusy) return;
    const submitted = submittedGitMessages.current.get(gitDraftScope);
    if (!submitted || (props.gitCommitSuccessRevision !== undefined
      ? props.gitCommitSuccessRevision <= (submitted.revision ?? 0)
      : props.gitCommitSuccess === submitted.success)) return;
    submittedGitMessages.current.delete(gitDraftScope);
    setGitDrafts((current) => current[gitDraftScope]?.commitMessage === submitted.message
      ? { ...current, [gitDraftScope]: { ...current[gitDraftScope], commitMessage: "", commitMessageEdited: false, commitMessageSuggestionId: undefined, commitMessageToken: undefined, commitScope: undefined } }
      : current);
  }, [gitDraftScope, props.gitCommitSuccess, props.gitCommitSuccessRevision, props.gitCommitBusy]);
  // A failed read is never "No differences", and a capped one never looks complete.
  const diffRead = useMemo(() => diffReadState(props.reviewDiff), [props.reviewDiff]);
  const diffSections = useMemo(
    () => (renderContent && props.tab === "changes" ? parseDiffSections(diffRead.text) : []),
    [diffRead.text, props.tab, renderContent],
  );
  const diffFileCount = useMemo(
    () => new Set(diffSections.map((section) => section.path ?? section.displayPath)).size,
    [diffSections],
  );
  // Per-file line counts for the Files list, only when the diff is exactly
  // the uncommitted tracked changes (against HEAD). A diff against the remote
  // also holds committed work, so its counts would not describe the list.
  const lineCounts = useMemo(() => {
    if (props.reviewDiff.source !== "repository" || props.reviewDiff.baseline !== "HEAD" || diffRead.kind !== "ok") return undefined;
    const counts = new Map<string, { additions: number; deletions: number }>();
    for (const section of diffSections) {
      if (!section.path) continue;
      const current = counts.get(section.path) ?? { additions: 0, deletions: 0 };
      counts.set(section.path, { additions: current.additions + section.additions, deletions: current.deletions + section.deletions });
    }
    return counts;
  }, [diffSections, diffRead.kind, props.reviewDiff.source, props.reviewDiff.baseline]);
  const diffTotals = useMemo(() => diffSections.reduce(
    (total, section) => ({ additions: total.additions + section.additions, deletions: total.deletions + section.deletions }),
    { additions: 0, deletions: 0 },
  ), [diffSections]);
  // Opening Changes reads the diff once when none is loaded yet, so Diff
  // never says there is nothing while Files lists changed files.
  const requestedDiffScopes = useRef(new Set<string>());
  const [diffLoading, setDiffLoading] = useState(false);
  // A read that never answered: say so and offer Retry, rather than "No differences".
  const [diffStalled, setDiffStalled] = useState(false);
  const diffLoadingTimer = useRef<number | undefined>(undefined);
  const wantsDiff = props.open && props.tab === "changes" && props.gitRepositoryState !== "absent" && !props.reviewDiff.text;
  const onRefreshDiff = props.onRefreshDiff;
  const readDiff = useCallback(() => {
    setDiffLoading(true);
    setDiffStalled(false);
    onRefreshDiff();
    window.clearTimeout(diffLoadingTimer.current);
    diffLoadingTimer.current = window.setTimeout(() => { setDiffLoading(false); setDiffStalled(true); }, 8_000);
  }, [onRefreshDiff]);
  useEffect(() => {
    if (!wantsDiff || requestedDiffScopes.current.has(diffScope)) return;
    requestedDiffScopes.current.add(diffScope);
    readDiff();
  }, [wantsDiff, diffScope, readDiff]);
  useEffect(() => () => window.clearTimeout(diffLoadingTimer.current), []);
  // Any answer (a diff, an empty diff or an error) ends the wait.
  useEffect(() => { window.clearTimeout(diffLoadingTimer.current); setDiffLoading(false); setDiffStalled(false); }, [props.reviewDiff]);


  // New files in Diff read their contents through the same bounded native read as Files.
  const inspection = props.projectGitInspection;
  const loadNewFile = useMemo(() => inspection
    ? (path: string) => inspection.getFileDiff(inspection.cwd, path, "untracked")
    : undefined, [inspection]);

  // The staged view reads each staged file's index diff with the same bounded
  // per-file read Files uses, and re-reads whenever the diff is refreshed.
  const stagedPaths = props.reviewStagedPaths ?? EMPTY_PATH_LIST;
  const stagedCount = Math.max(props.gitWorkflow?.snapshot?.stagedFiles ?? 0, stagedPaths.length);
  const changedCount = props.gitWorkflow?.snapshot?.changedFiles ?? 0;
  const workingScope = !(props.changesScope === "pushed" && props.pushedScopeAvailable);
  const stagedView = stagedViewOn && workingScope && stagedPaths.length > 0 && Boolean(inspection);
  const [stagedRead, setStagedRead] = useState<{ key: string; loading: boolean; result: StagedDiffResult | null }>({ key: "", loading: false, result: null });
  const stagedReadKey = stagedView && inspection && renderContent ? `${inspection.cwd}\u0000${stagedPaths.join("\u0000")}` : "";
  const stagedReadPaths = useRef(stagedPaths);
  stagedReadPaths.current = stagedPaths;
  useEffect(() => {
    if (!stagedReadKey || !inspection) return;
    let live = true;
    const all = stagedReadPaths.current;
    const paths = all.slice(0, STAGED_DIFF_FILE_LIMIT);
    setStagedRead((current) => ({ key: stagedReadKey, loading: true, result: current.key === stagedReadKey ? current.result : null }));
    void Promise.all(paths.map((path) => inspection.getFileDiff(inspection.cwd, path, "staged").then(
      (diff) => ({ path, text: diff.text, binary: diff.binary, truncated: diff.truncated }),
      (reason: unknown) => ({ path, error: reason instanceof Error ? reason.message : String(reason) }),
    ))).then((parts) => {
      if (live) setStagedRead({ key: stagedReadKey, loading: false, result: stagedDiffSections(parts, all.length, parseDiffSections) });
    });
    return () => { live = false; };
    // A refreshed diff (props.reviewDiff) re-reads the index too.
  }, [stagedReadKey, inspection, props.reviewDiff]);

  // When the dock is closed, skip all panel work (diff parsing, xterm,
  // file browser) — it re-rendered fully even while hidden.
  if (!renderContent) {
    return <aside ref={props.rootRef} className="studio-dock closed" aria-label="Tools" aria-hidden inert />;
  }
  const projectLabel = props.projectName || "this project";
  const outsideRepositoryRoot = props.gitWorkflow?.snapshot?.isRoot === false;
  const repositoryRootReason = `Open the repository root (${props.gitWorkflow?.snapshot?.rootPath}) as your project before changing Git. This selected folder is inside that repository.`;
  const openSettings = props.onOpenSettings;
  const settingsAction = (section: SettingsSection, label: string) => openSettings ? { label, onClick: () => openSettings(section) } : undefined;
  const canCompact = threadUsageCanCompact(props.usageProvider);

  // The Changes tab's "Diff": by default the same uncommitted set as Files
  // (tracked edits against HEAD plus new files), so the counts, the list and
  // the commit button all describe one set. With files staged it can also
  // show the staged version alone, which is what "Commit N staged" records.
  // The push comparison is a named alternate scope, offered only where it can
  // be computed.
  const scope: ChangesScope = workingScope ? "working" : "pushed";
  const stagedResult = stagedView && stagedRead.key === stagedReadKey ? stagedRead.result : null;
  const stagedLoading = stagedView && !stagedResult;
  const newFilePaths = scope === "working" && !stagedView ? props.reviewDiff.untrackedPaths : [];
  const viewSections = stagedView ? stagedResult?.sections ?? [] : diffSections;
  const viewCount = stagedView ? viewSections.length : netListCount(diffFileCount, newFilePaths, diffSections);
  const viewTotals = stagedView
    ? viewSections.reduce((total, section) => ({ additions: total.additions + section.additions, deletions: total.deletions + section.deletions }), { additions: 0, deletions: 0 })
    : diffTotals;
  const viewPartial = stagedView ? Boolean(stagedResult?.partial) : diffRead.kind === "partial";
  const viewError = !stagedView && diffRead.kind === "error";
  const viewLoading = stagedView ? stagedLoading : diffLoading;
  const commitStagedOnly = stagedCount > 0 && gitDraft.commitScope !== "all";
  const emptyCopy = diffEmptyCopy({ scope, stagedView, staged: stagedCount, changed: changedCount, commitAll: stagedCount > 0 && !commitStagedOnly });
  // Uncommitted, Staged only (when something is staged) and Since last push
  // (when it can be computed) share one picker.
  const scopeChoices = [
    { id: "working", label: CHANGES_SCOPE_LABELS.working.label, detail: CHANGES_SCOPE_LABELS.working.detail, active: scope === "working" && !stagedView, select: () => { setStagedViewOn(false); props.onChangesScope?.("working"); } },
    ...(stagedCount > 0 && inspection ? [{ id: "staged", label: STAGED_VIEW_LABEL.menuLabel, detail: STAGED_VIEW_LABEL.detail, active: stagedView, select: () => { setStagedViewOn(true); props.onChangesScope?.("working"); } }] : []),
    ...(props.pushedScopeAvailable && props.onChangesScope ? [{ id: "pushed", label: CHANGES_SCOPE_LABELS.pushed.label, detail: CHANGES_SCOPE_LABELS.pushed.detail, active: scope === "pushed", select: () => { setStagedViewOn(false); props.onChangesScope?.("pushed"); } }] : []),
  ];
  const scopeItems: AppActionMenuItem[] = scopeChoices.map((choice) => ({
    id: choice.id,
    label: choice.label,
    description: choice.detail,
    icon: choice.active ? <Check size={13} aria-hidden="true" /> : <span className="diff-scope-icon-slot" aria-hidden="true" />,
    onSelect: choice.select,
  }));
  const scopeLabel = stagedView ? STAGED_VIEW_LABEL.label : CHANGES_SCOPE_LABELS[scope].label;
  const diffSummary = (liveCount: number | null) => viewError
    ? "Diff unavailable"
    : viewCount
      ? <>
        {/* A capped read's line counts describe only what was read, so a
            partial summary names itself and leaves them out. */}
        {viewPartial
          ? `Partial · ${viewCount} file${viewCount === 1 ? "" : "s"}`
          // No-break spaces keep "3 files" and "+2 −3" whole when a narrow
          // dock wraps the summary onto two lines; it breaks only at "·".
          : `${viewCount}${!stagedView && props.reviewDiff.untrackedTruncated ? "+" : ""}\u00a0file${viewCount === 1 ? "" : "s"} · +${viewTotals.additions}\u00a0−${viewTotals.deletions}`}
        {newFilePaths.length ? <span className="diff-summary-new">{` · ${newFilePaths.length} new`}</span> : null}
        {liveCount ? <span className="diff-summary-new">{` · ${liveCount} with current edits`}</span> : null}
      </>
      : viewPartial ? "Partial diff" : viewLoading ? "Reading…" : diffStalled && !stagedView ? "Not read yet"
        : emptyCopy.action === "staged" ? `${stagedCount} staged` : emptyCopy.title;
  // A file linked from the conversation: is it in the diff being shown?
  const linkInDiff = linkTarget ? diffSections.some((section) => section.path === linkTarget.path) || newFilePaths.includes(linkTarget.path) : false;
  const linkSettled = Boolean(linkTarget) && !diffLoading && !diffStalled && diffRead.kind === "ok" && (Boolean(props.reviewDiff.text) || props.reviewDiff.untrackedPaths.length > 0 || requestedDiffScopes.current.has(diffScope));
  const linkMissing = Boolean(linkTarget) && !linkInDiff && linkSettled;
  // Controls that would change nothing say why instead of acting (Opus I12):
  // a diff that couldn't be read can't be read wider, and Widen is only
  // offered where the window has room to give.
  const wideBlockedReason = reviewWide ? "" : viewError
    ? "The diff couldn't be read, so there is nothing to widen. Try again first."
    : wideGain < WIDE_REVIEW_MIN_GAIN
      ? "The window has no room to widen the review. Make the window wider, or hide the sidebar."
      : "";
  const wideToggle = (
    <button
      type="button"
      className="diff-wide-toggle"
      aria-pressed={reviewWide}
      // The accessible name starts with the visible word (voice control: "click Widen").
      aria-label={reviewWide ? "Narrow" : "Widen"}
      aria-disabled={wideBlockedReason ? true : undefined}
      onClick={() => { if (!wideBlockedReason) setReviewWide(!reviewWide); }}
      title={wideBlockedReason || (reviewWide ? "Return Tools to its usual width" : "Widen Tools for reading the diff. Turn off here, or close Tools.")}
    >
      {reviewWide ? <Minimize2 size={13} aria-hidden="true" /> : <Maximize2 size={13} aria-hidden="true" />}
      <span>{reviewWide ? "Narrow" : "Widen"}</span>
    </button>
  );
  const scopeBlockedReason = viewError ? "The diff couldn't be read. Try again, or open the Files list." : "";
  const renderChangesDiff = ({ selectedPath, onSelectPath, livePaths }: { selectedPath: string | null; onSelectPath: (path: string | null) => void; livePaths: ReadonlySet<string> | null }) => <>
    <div className="diff-scope-line">
      <span className="diff-summary-meta" title={stagedView ? "The staged version of each file, compared with the last commit" : `Compared with ${props.reviewDiff.baseline}`}>{diffSummary(scope === "pushed" && livePaths
        ? new Set(diffSections.map((section) => section.path).filter((path): path is string => Boolean(path && livePaths.has(path)))).size
        : null)}</span>
      <button
        type="button"
        className="diff-wrap-toggle icon-button"
        aria-pressed={diffWrap}
        aria-label="Wrap long lines"
        disabled={viewError}
        title={viewError ? scopeBlockedReason : diffWrap ? "Long lines wrap. Turn off to keep code's shape and scroll sideways." : "Long lines scroll sideways. Turn on to wrap them. Remembered for every diff."}
        onClick={() => setDiffWrap(!diffWrap)}
      ><WrapText size={13} aria-hidden="true" /></button>
      {wideToggle}
      {scopeChoices.length > 1 ? (
        <AppActionMenu
          className="diff-scope-menu"
          label={scopeLabel}
          ariaLabel={`Compare: ${scopeLabel}. Change what the diff compares against`}
          items={scopeItems}
          align="end"
          disabled={Boolean(scopeBlockedReason)}
          triggerTitle={scopeBlockedReason || undefined}
        />
      ) : <span className="diff-scope-static" title={CHANGES_SCOPE_LABELS.working.detail}>{CHANGES_SCOPE_LABELS.working.label}</span>}
    </div>
    {/* Since last push says it is read only once: in its footer, beside the
        action that leads to where work can be changed (Opus I4). */}
    {/* The staged view names itself in the picker ("Staged") and in the
        commit bar, beside the way back; no third notice. */}
    {viewPartial && (
      <DockNote tone="warning" icon={TriangleAlert} role="status">
        <strong>Partial diff.</strong> {stagedView ? "Some staged files or lines couldn't be read here." : "It is too large to read at once, so some files or lines aren’t shown here."}{scope === "working" ? ` ${partialCommitNote({ stagedOnly: commitStagedOnly, staged: stagedCount })}` : ""}{" "}
        <button type="button" className="dock-note-link" onClick={() => setChangesMode("list")}>Show changed files</button>
      </DockNote>
    )}
    {!viewError && !stagedView && scope === "working" && props.reviewDiff.untrackedTruncated && (
      <DockNote tone="warning" icon={TriangleAlert}>
        Only the first {props.reviewDiff.untrackedPaths.length} new files are listed here.{" "}
        <button type="button" className="dock-note-link" onClick={() => setChangesMode("list")}>Show changed files</button>
      </DockNote>
    )}
    {linkTarget && linkMissing && (() => {
      const { name, directory } = splitChangePath(linkTarget.path);
      return (
        <div className="diff-link-missing" role="status" tabIndex={-1} ref={(node) => { if (node && linkFocusHandled.current !== linkTarget.nonce) { linkFocusHandled.current = linkTarget.nonce; node.focus({ preventScroll: true }); node.scrollIntoView?.({ block: "nearest" }); } }}>
          <div className="diff-link-missing-head">
            <FileX2 size={15} aria-hidden="true" />
            <div>
              <strong>{scope === "pushed" ? `${name} isn't in this comparison` : `No uncommitted changes for ${name}`}</strong>
              {directory && <small>{directory}</small>}
            </div>
            <button type="button" className="icon-button diff-link-dismiss" aria-label="Dismiss" data-tip="Dismiss" onClick={() => setDismissedLink(linkTarget.nonce)}><X size={13} aria-hidden="true" /></button>
          </div>
          <p>The conversation linked this file, but it has no {scope === "pushed" ? "difference from the remote branch" : "uncommitted diff"} now. It may have been committed, undone or renamed since that turn.</p>
          <div className="diff-link-missing-actions">
            {scope === "working" && props.pushedScopeAvailable && props.onChangesScope && (
              <button type="button" onClick={() => props.onChangesScope?.("pushed")}><GitBranch size={12} aria-hidden="true" /> Compare since last push</button>
            )}
            <button type="button" onClick={() => { setGitView("history"); props.onTab("git"); }}><History size={12} aria-hidden="true" /> Git history</button>
            <button type="button" onClick={() => props.onTab("checkpoints")}><Clock3 size={12} aria-hidden="true" /> Checkpoints</button>
            <button type="button" onClick={() => props.onTab("files")}><FolderTree size={12} aria-hidden="true" /> Files</button>
          </div>
        </div>
      );
    })()}
    {linkTarget && linkInDiff && !stagedView && (
      <div className="diff-link-note" role="status">
        <Info size={12} aria-hidden="true" />
        <span>Opened from the conversation. This is <strong>{splitChangePath(linkTarget.path).name}</strong>&rsquo;s current diff, not a snapshot of that turn.</span>
        <button type="button" className="icon-button diff-link-dismiss" aria-label="Dismiss" data-tip="Dismiss" onClick={() => setDismissedLink(linkTarget.nonce)}><X size={12} aria-hidden="true" /></button>
      </div>
    )}
    {viewError ? (
      <div className="diff-read-error">
        <FriendlyGitError raw={diffRead.error ?? ""} onRetry={readDiff} fallback="Couldn't read the changes." />
        <p className="diff-read-error-note">This doesn&rsquo;t mean nothing changed: the diff couldn&rsquo;t be read. Files may still list what changed.</p>
        <div className="diff-read-error-actions">
          <button type="button" className="github-secondary-button" onClick={() => setChangesMode("list")}><FolderTree size={13} aria-hidden="true" /> Show changed files</button>
        </div>
      </div>
    ) : viewSections.length || newFilePaths.length ? (
      <DiffFileSections
        sections={viewSections}
        newFiles={newFilePaths}
        loadNewFile={loadNewFile}
        selectedPath={selectedPath}
        onSelectPath={onSelectPath}
        readOnly={props.gitActionsReadOnly || outsideRepositoryRoot}
        readOnlyReason={props.gitActionsReadOnly
          ? "Switch this thread from Read only to Ask to act or Full access before staging or discarding files."
          : repositoryRootReason}
        stagedPaths={props.reviewStagedPaths}
        // Line feedback cites the uncommitted diff the agent can see; the
        // staged view is for checking what a commit records.
        feedbackDiff={stagedView ? undefined : props.reviewDiff}
        onPathAction={props.onGitPathAction}
        onUnstage={props.onGitPathUnstage}
        // A comparison is read only throughout: files that also have
        // uncommitted edits are tagged, and are staged or discarded from
        // Uncommitted, where the diff shown is exactly what those act on.
        // The staged view offers only Unstage, which acts on exactly the
        // staged patch shown; Discard acts on the files on disk.
        fileActions={scope === "pushed" ? "none" : stagedView ? "unstage" : "full"}
        livePaths={scope === "pushed" ? livePaths ?? EMPTY_PATHS : null}
        focusRequest={linkTarget && linkInDiff && !stagedView ? linkTarget : null}
      />
    ) : !stagedView && diffRead.text.trim() ? (
      <pre className="diff-view">{diffRead.text}</pre>
    ) : viewLoading ? (
      <p className="git-changes-loading" role="status"><RefreshCw className="spin" size={12} aria-hidden="true" /> {stagedView ? "Reading the staged files…" : "Reading the diff…"}</p>
    ) : diffStalled && !stagedView ? (
      <Empty compact icon={FileDiff} title="The diff hasn't loaded" text="Mythra Code asked Git for the diff but got no answer yet. This doesn't mean nothing changed." action={{ label: "Try again", icon: RefreshCw, onClick: readDiff }} />
    ) : linkMissing || viewPartial ? null : (
      <Empty
        compact
        icon={FileDiff}
        title={emptyCopy.title}
        text={emptyCopy.text}
        action={emptyCopy.action === "staged" && inspection
          ? { label: "Review staged changes", icon: GitCommitHorizontal, onClick: () => setStagedViewOn(true) }
          : emptyCopy.action === "files" ? { label: "Show changed files", icon: FolderTree, onClick: () => setChangesMode("list") } : undefined}
      />
    )}
  </>;
  // Since last push is a comparison: it has neither a commit editor nor a checks control.
  const comparison = scope === "pushed" && props.onChangesScope
    ? { onSwitch: () => props.onChangesScope?.("working") }
    : undefined;
  const changesMenuItems: AppActionMenuItem[] = [
    {
      id: "ai-review",
      label: "Ask AI to review",
      icon: <Bot size={13} aria-hidden="true" />,
      disabled: !props.activeThread || Boolean(props.reviewDisabledReason),
      title: props.reviewDisabledReason || (props.activeThread ? "The model reviews the changes and reports back. Nothing is edited." : "Open a thread to request an AI review"),
      onSelect: props.onReview,
    },
    {
      id: "wide",
      label: reviewWide ? "Exit wide review" : "Wide review",
      icon: reviewWide ? <Minimize2 size={13} aria-hidden="true" /> : <Maximize2 size={13} aria-hidden="true" />,
      disabled: Boolean(wideBlockedReason),
      title: wideBlockedReason || "Widen Tools for reading diffs",
      onSelect: () => setReviewWide(!reviewWide),
    },
    ...(props.checksControl && !(comparison && changesMode === "diff") ? [{
      id: "checks",
      label: "Check command…",
      icon: <ListChecks size={13} aria-hidden="true" />,
      title: "Set up or edit the command Run checks uses for this project",
      onSelect: () => window.dispatchEvent(new CustomEvent(EDIT_CHECKS_EVENT)),
    }] : []),
    {
      id: "wrap",
      label: "Wrap long lines",
      value: diffWrap ? "On" : "Off",
      icon: <WrapText size={13} aria-hidden="true" />,
      title: "Wrap long diff lines instead of scrolling sideways. Remembered for every diff.",
      onSelect: () => setDiffWrap(!diffWrap),
    },
  ];
  // Wide review covers the composer, where a note added from the diff waits
  // to be sent. Keep the reader in the code, and the draft one click away:
  // "Open draft" narrows and moves focus to the message, sending nothing.
  const draftNotes = props.feedbackNoteCount ?? 0;
  const reviewDraftBar = reviewWide && draftNotes > 0 && props.onOpenFeedbackDraft ? (
    <div className="review-draft-bar" role="status">
      <MessageSquareText size={14} aria-hidden="true" />
      <span><strong>{draftNotes} unsent note{draftNotes === 1 ? "" : "s"}</strong> for the agent, waiting in the message box.</span>
      <button type="button" className="github-secondary-button" onClick={props.onOpenFeedbackDraft} title="Return Tools to its usual width and move to the message. Nothing is sent until you press Send.">Open draft</button>
    </div>
  ) : null;
  const gitPanel = (surface: "changes" | "repository") => (
    <GitPanel
      key={props.projectPath ?? ""}
      surface={surface}
      renderDiff={surface === "changes" ? renderChangesDiff : undefined}
      diffCount={surface === "changes" ? viewCount : undefined}
      toolbarExtra={surface === "changes" ? props.checksControl : undefined}
      onChangesLoaded={surface === "changes" ? onChangesLoaded : undefined}
      selectRequest={surface === "changes" ? selectedFileRequest : undefined}
      moreMenuHost={surface === "changes" ? changesMenuHost : undefined}
      extraMenuItems={surface === "changes" ? changesMenuItems : undefined}
      comparison={surface === "changes" ? comparison : undefined}
      stagedReview={surface === "changes" && scope === "working" && stagedCount > 0 && inspection
        ? { active: stagedView && changesMode === "diff", onChange: (on) => { setStagedViewOn(on); if (on) setChangesMode("diff"); } }
        : undefined}
      diffUnavailable={surface === "changes" ? viewError : undefined}
      footerNote={surface === "changes" ? reviewDraftBar : undefined}
      changesMode={changesMode}
      onChangesModeChange={setChangesMode}
      lineCounts={surface === "changes" ? lineCounts : undefined}
      hideChangesRefresh={Boolean(props.gitWorkflow)}
      repositoryState={props.gitRepositoryState}
      selectedFolder={props.projectPath}
      repositoryStateDetail={props.gitRepositoryStateDetail}
      gitInitializing={props.gitInitializing}
      gitOutput={props.gitOutput}
      gitCommitSuccess={props.gitCommitSuccess}
      gitCommitSuccessRevision={props.gitCommitSuccessRevision}
      gitCommitBusy={props.gitCommitBusy}
      gitOperationBusy={props.gitOperationBusy}
      githubAuthenticated={props.githubAuthenticated}
      githubBusy={props.githubBusy}
      githubOperationError={props.githubOperationError}
      githubRepoStatus={props.githubRepoStatus}
      githubRepoError={props.githubRepoError}
      readOnly={props.gitActionsReadOnly}
      defaultRepositoryName={props.defaultRepositoryName}
      draft={gitDraft}
      commitSuggestion={commitSuggestion}
      onRegenerateCommitMessage={props.onRegenerateCommitMessage}
      commitSuggestionBusy={props.commitSuggestionBusy}
      onDraftChange={(draft) => setGitDrafts((current) => ({ ...current, [gitDraftScope]: draft }))}
      onAction={(action, message) => {
        if (["commit", "commitStaged", "commitPush", "commitStagedPush"].includes(action)) submittedGitMessages.current.set(gitDraftScope, { message: message ?? "", success: props.gitCommitSuccess, revision: props.gitCommitSuccessRevision });
        props.onGitAction(action, message);
      }}
      onInitializeGit={props.onInitializeGit}
      onGitHubAttach={props.onGitHubAttach}
      onGitHubCreate={props.onGitHubCreate}
      onOpenGitHubSettings={props.onOpenGitHubSettings}
      pullRequestPanel={props.pullRequestPanel}
      workflow={props.gitWorkflow}
      hasPullRequestWorkflow={Boolean(props.pullRequestPanel || props.projectPullRequests)}
      pullRequests={props.projectPullRequests}
      inspection={props.projectGitInspection}
      onPathAction={(action, path) => {
        if (action === "unstage") props.onGitPathUnstage?.(path);
        else props.onGitPathAction(action, path);
      }}
      view={gitView}
      onViewChange={(next) => { setGitView(next); setPendingGitFocus(null); }}
      focusRequest={props.open && pendingGitFocus?.scope === gitDraftScope ? pendingGitFocus.route : null}
      onFocusHandled={(nonce) => setPendingGitFocus((current) => current?.route.nonce === nonce ? null : current)}
      onOpenTool={props.onTab}
    />
  );

  return (
    <StudioDockFrame open={props.open} covered={props.covered} rootRef={props.rootRef} onResizeStart={props.onResizeStart} onResizeKeyDown={props.onResizeKeyDown} resizeValue={props.resizeValue} resizeMax={props.resizeMax} tab={props.tab} onTab={props.onTab} fillChanges wide={reviewWide && props.tab === "changes"} onExitWide={() => setReviewWide(false)} onWideRoom={props.tab === "changes" ? setWideGain : undefined}>
        {props.tab === "changes" && <>
          <PanelHeader
            tab="changes"
            actions={props.gitRepositoryState === "absent" ? undefined : <>
              <HeaderAction
                icon={RefreshCw}
                label="Refresh changes"
                busy={changesRead.loading}
                title={`Read the changes again${changesRead.loadedAt ? ` · updated ${relativeAge(changesRead.loadedAt) ?? "just now"}` : ""}`}
                onClick={() => { props.onRefreshDiff(); props.gitWorkflow?.onRefresh?.(); }}
              />
              <span className="studio-header-slot" ref={setChangesMenuHost} />
            </>}
            onClose={props.onClose}
          />
          {gitPanel("changes")}
        </>}

        {props.tab === "git" && <>
          <PanelHeader tab="git" onClose={props.onClose} />
          {gitPanel("repository")}
        </>}

        {props.tab === "checkpoints" && <CheckpointsPanel {...props} />}

        {props.tab === "worktrees" && <WorktreesPanel {...props} repositoryAbsent={props.gitRepositoryState === "absent"} />}

        {props.tab === "files" && <>
          <PanelHeader tab="files" onClose={props.onClose} />
          {props.projectPath ? <FileBrowser root={props.projectPath} onAttach={props.onAttachPath} source={props.fileSource} /> : <Empty icon={FolderTree} title="No project folder" text="Open a project to browse its files." />}
        </>}

        {props.tab === "terminal" && <>
          <PanelHeader tab="terminal" onClose={props.onClose} />
          <TerminalPanelHost
            key={props.projectPath ?? ""}
            outputStore={props.terminalOutput}
            scope={props.projectPath ?? ""}
            scopeLabel={projectLabel}
            running={props.terminalRunning}
            runningCommand={props.terminalRunningCommand}
            runningElsewhere={props.terminalRunningElsewhere}
            readOnly={props.commandsReadOnly}
            onRun={props.onRunTerminal}
            onStop={props.onStopTerminal}
            onClear={props.onClearTerminal}
            onInput={props.onTerminalInput}
            onResize={props.onTerminalResize}
          />
        </>}

        {props.tab === "actions" && (() => {
          const hasRun = Boolean(props.projectRun);
          const hasActions = props.projectActions.length > 0;
          const hasWorkflows = props.workflows.length > 0;
          const missing = [!hasActions && "quick actions", !hasWorkflows && "agent workflows"].filter(Boolean) as string[];
          return <>
          <PanelHeader tab="actions" onClose={props.onClose} />
          {!hasRun && !hasActions && !hasWorkflows ? (
            <Empty
              icon={Play}
              title="No actions yet"
              text="Set up a run command from Run in the top bar, or add one-click actions and agent workflows in Settings."
              action={openSettings ? { label: "Add quick actions in Settings", onClick: () => openSettings("workflows", "workflows.quick-actions") } : undefined}
            />
          ) : null}
          {hasRun && props.projectRun && <>
            <SectionHeading>Run command</SectionHeading>
            <div className="studio-list compact">
              <div className="studio-list-row">
                <SquareChevronRight size={14} aria-hidden="true" />
                <div><strong>{props.projectRun.label || "Run"}</strong><small title={props.projectRun.command}>{props.projectRun.command}</small></div>
                {props.projectRunRunning
                  ? <button className="danger-action" onClick={props.onProjectRunStop} disabled={!props.onProjectRunStop} title="Stop the run command" aria-label="Stop the run command"><Square size={12} /></button>
                  : <button onClick={props.onProjectRun} disabled={!props.onProjectRun || props.commandsReadOnly} title={props.commandsReadOnly ? COMMAND_READ_ONLY_REASON : `Run ${props.projectRun.label || "the run command"} in ${projectLabel}`} aria-label={`Run ${props.projectRun.label || "the run command"}`}><Play size={13} /></button>}
              </div>
            </div>
          </>}
          {props.checksControl && <>
            <SectionHeading>Checks</SectionHeading>
            <div className="studio-actions wrap">{props.checksControl}</div>
          </>}
          {hasActions && <>
            <div className="checkpoint-section-head"><SectionHeading>Quick actions</SectionHeading>{openSettings && <button type="button" className="thread-pr-inline-button" onClick={() => openSettings("workflows", "workflows.quick-actions")} title="Add, edit or remove quick actions in Settings → Workflows">Manage in Settings</button>}</div>
            <div className="studio-list compact">{props.projectActions.map((action) => <div className="studio-list-row" key={action.id}><SquareChevronRight size={14} aria-hidden="true" /><div><strong>{action.name}</strong><small title={action.command}>{action.command}</small></div><button onClick={() => props.onProjectAction(action)} title={props.commandsReadOnly ? COMMAND_READ_ONLY_REASON : `Run ${action.name} in ${projectLabel}`} aria-label={`Run ${action.name}`}><Play size={13} /></button></div>)}</div>
            {props.commandsReadOnly && <DockNote tone="warning" icon={ShieldCheck}>{COMMAND_READ_ONLY_REASON}</DockNote>}
          </>}
          {hasWorkflows && <>
            <SectionHeading>Agent workflows</SectionHeading>
            <div className="studio-list compact">{props.workflows.map((workflow) => {
              const latest = props.workflowRuns.find((run) => run.workflowId === workflow.id);
              const running = latest?.status === "running";
              return <div className="studio-list-row" key={workflow.id}><WorkflowIcon size={14} aria-hidden="true" /><div><strong>{workflow.name}</strong><small>{workflow.steps.length} step{workflow.steps.length === 1 ? "" : "s"} · {running ? `step ${latest.currentStep} of ${latest.stepCount}` : latest?.status ?? "ready"}</small></div>{running ? <button className="danger-action" onClick={() => props.onStopWorkflow(workflow.id)} title="Stop workflow" aria-label={`Stop ${workflow.name}`}><CircleStop size={13} /></button> : <button onClick={() => props.onRunWorkflow(workflow)} title="Run workflow" aria-label={`Run ${workflow.name}`}><Play size={13} /></button>}{latest?.threadId && <button onClick={() => props.onOpenWorkflowRun(latest.threadId!)} title="Open workflow thread" aria-label={`Open ${workflow.name} thread`}><ChevronRight size={13} /></button>}</div>;
            })}</div>
          </>}
          {(hasRun || hasActions || hasWorkflows) && missing.length > 0 && openSettings && (
            <p className="studio-panel-meta studio-add-more">
              <button type="button" className="thread-pr-inline-button" onClick={() => openSettings("workflows", hasActions ? "workflows.agent-workflows" : "workflows.quick-actions")}><Plus size={12} aria-hidden="true" /> Add {missing.join(" or ")}</button>
            </p>
          )}
          </>;
        })()}

        {props.tab === "agents" && <AgentsPanel {...props} subtitle={undefined} />}

        {props.tab === "usage" && <>
          <PanelHeader
            tab="usage"
            subtitle={props.activeThread ? "This thread" : undefined}
            actions={props.activeThread ? <HeaderAction icon={RefreshCw} label="Refresh prices" onClick={props.onRefreshUsage} /> : undefined}
            onClose={props.onClose}
          />
          {props.activeThread && (() => {
            const compactNow = <button type="button" className="usage-compact-now" onClick={props.onCompact} disabled={!canCompact} title={canCompact ? "Summarize older turns now to free context" : "This provider manages its own context compaction"}><Shrink size={13} aria-hidden="true" /> Compact context</button>;
            return <div className="usage-context-controls">
              {props.threadCompaction ? <ThreadCompactionControl {...props.threadCompaction} action={compactNow} /> : compactNow}
            </div>;
          })()}
          <ThreadUsagePanel
            key={JSON.stringify([props.activeThreadId, props.contextTurnId, props.usageProvider])}
            activeThread={props.activeThread}
            threadId={props.activeThreadId ?? undefined}
            turnId={props.contextTurnId}
            provider={props.usageProvider}
            threadTitle={props.threadTitle}
            nativeLinks={props.nativeAgentLinks}
            managedLinks={props.managedAgentLinks}
            context={props.usage}
            visibleAttachments={props.visibleAttachments}
            hideToolbar
            onRefresh={props.onRefreshUsage}
            onCompact={props.onCompact}
          />
          {props.activeThread && <details className="thread-usage-details thread-usage-totals thread-usage-request-details">
            <summary><ChevronRight size={13} aria-hidden="true" />Request details</summary>
            <div className="audit-table">{props.promptAudit.map((row) => <div key={row.label}><span>{row.label}</span><code>{row.value}</code></div>)}</div>
            <LastTurnInstructions threadId={props.activeThreadId ?? null} />
          </details>}
        </>}

        {props.tab === "skills" && <>
          <PanelHeader
            tab="skills"
            subtitle="App-wide"
            actions={<HeaderAction icon={RefreshCw} label="Rescan skills and MCP servers" onClick={props.onRefreshTools} />}
            onClose={props.onClose}
          />
          <DockNote icon={ShieldCheck} info="Terminal, Git, MCP, and agent actions follow the permission mode selected beneath the composer. Annotated destructive MCP actions still require approval.">
            MCP servers and skills follow this thread's access setting.
          </DockNote>
          <div className="checkpoint-section-head">
            <SectionHeading>Skills</SectionHeading>
            {openSettings && <button type="button" className="thread-pr-inline-button" onClick={() => openSettings("skills")} title="Add, import or remove skill files in Settings">Manage in Settings</button>}
          </div>
          <div className="studio-list compact">{props.skills.length ? props.skills.map((skill) => <div className={`studio-list-row ${skill.enabled === false ? "disabled-tool" : ""}`} key={`${skill.name}-${skill.path}`}><Boxes size={14} /><div><strong>@{skill.name}</strong><small>{skill.description || skill.path || "Reusable workflow"}</small></div><span className="studio-list-switch"><Switch size="sm" checked={skill.enabled !== false} onChange={() => props.onToggleSkill(skill.path)} title={skill.enabled === false ? "Off in every project. Turn on to let the agent use it." : "On in every project. Turn off to hide it from the agent."} label={`@${skill.name}, on in every project`} /></span></div>)
            : <Empty compact icon={Boxes} title="No skills found" text="Choose a local skills folder to give the model reusable instructions." action={settingsAction("skills", "Open Skills settings")} />}</div>
          <SectionHeading>MCP servers</SectionHeading>
          <div className="studio-list compact">{props.mcpServers.length ? props.mcpServers.map((server) => <div className="studio-list-row" key={server.name}><span className={`status-orb ${server.status}`} /><div><strong>{server.name}</strong><small>{mcpStatusLabel(server.status)} · {server.tools} tool{server.tools === 1 ? "" : "s"}</small></div>{!mcpServerConnected(server.status) && <button className="studio-list-text-action" onClick={() => props.onConnectMcp(server)} title={`Connect ${server.name}`} aria-label={`Connect ${server.name}`}>Connect</button>}</div>)
            : <Empty compact icon={Wrench} title="No MCP servers" text="Configured servers and their tool counts appear here." action={settingsAction("tools", "Set up MCP servers in Settings")} />}</div>
        </>}
    </StudioDockFrame>
  );
}

/** The instruction context of the latest turn whose start was confirmed. */
function LastTurnInstructions({ threadId }: { threadId: string | null }) {
  const receipt = useTurnContextReceipt(threadId);
  const recordingEnabled = useTurnContextRecordingEnabled();
  if (!threadId) return null;
  if (!receipt) return <p className="last-turn-empty">{recordingEnabled
    ? "Instructions appear after a turn sent from this device is confirmed by its provider."
    : "Instruction recording is off. Enable Record last-turn instructions in Settings → Advanced to keep local records of future confirmed turns."}</p>;
  const total = receipt.totalInstructionChars;
  return <section className="last-turn-instructions" aria-label="Instructions for the last confirmed turn">
    <h3 className="panel-label">Last confirmed turn&rsquo;s instructions</h3>
    {!recordingEnabled && <p className="last-turn-empty">Recording is off. This is an older saved record; you can delete it with the other instruction records in Settings → Advanced.</p>}
    <div className="audit-table">
      <div><span>Start confirmed</span><code>{new Date(receipt.at).toLocaleString()}</code></div>
      <div><span>Model</span><code>{[receipt.provider, receipt.model, receipt.effort].filter(Boolean).join(" · ")}</code></div>
      {receipt.layers.map((layer) => <div key={layer.label}><span>{layer.label}</span><code>{layer.chars ? `${layer.chars.toLocaleString()} chars` : "none"}</code></div>)}
      {receipt.skills.length > 0 && <div><span>Skills referenced</span><code>{receipt.skills.join(", ")}</code></div>}
      {receipt.attachments > 0 && <div><span>Attachments</span><code>{receipt.attachments}</code></div>}
    </div>
    <details className="last-turn-text">
      <summary className="lm-summary"><ChevronRight size={12} aria-hidden="true" className="lm-chevron" />Show instruction context ({total.toLocaleString()} characters{receipt.truncated ? "; first 32,000 kept" : ""})</summary>
      <textarea readOnly rows={10} spellCheck={false} value={receipt.instructions} aria-label="Last turn's assembled instructions" placeholder="No instructions were added for this turn." />
      <small>System text is shown as assembled. Skills supplied with your message are shown separately with their delivery guidance; your message and attachments are omitted. Layer sizes include this formatting. Rejected starts, preparation cancelled before delivery and unconfirmed starts keep the previous receipt. A confirmed start is recorded even if the turn is then stopped. Mythra Code also sends operating guidance for tools and delegation, and each provider adds built-in instructions.</small>
    </details>
  </section>;
}

/**
 * The one empty state: icon, title, one sentence, and a button when there is
 * something to do about it. `compact` is for an empty section inside a panel.
 */
export function Empty({ icon: Icon, title, text, action, compact }: {
  icon: typeof CodeXml;
  title: string;
  text: string;
  action?: { label: string; onClick: () => void; icon?: typeof CodeXml };
  compact?: boolean;
}) {
  const ActionIcon = action?.icon ?? SettingsIcon;
  return <div className={`studio-empty${compact ? " compact" : ""}`}>
    <Icon size={compact ? 16 : 20} aria-hidden="true" />
    <strong>{title}</strong>
    <span>{text}</span>
    {action && <button type="button" className="studio-empty-action" onClick={action.onClick}><ActionIcon size={13} aria-hidden="true" /> {action.label}</button>}
  </div>;
}

/**
 * Is this worktree *still* in the state its merge left it in?
 *
 * A record saying `merged` only describes something that happened once. Work
 * carried on afterwards in plenty of threads, and a completion panel that
 * outlived the fact told people their new commits were already in the project.
 * So the claim is re-derived from evidence every render: the branch head has to
 * be the exact commit that was merged, and the folder has to be clean. Without
 * a recorded head commit the app cannot show that, and says nothing instead.
 */
function worktreeMergeComplete(
  worktree: ThreadWorktreeRecord,
  status: WorktreeStatus | null | undefined,
): boolean {
  if (worktree.status !== "merged" || !worktree.mergedHeadOid) return false;
  if (!status || !status.headOid) return false;
  return status.headOid === worktree.mergedHeadOid && status.clean;
}

/**
 * What to say about a worktree that was merged once and is not in that state
 * any more — distinguishing "it moved on" from "the app cannot tell". The
 * second is not evidence of the first, and saying so would be inventing a
 * fact out of a missing reading.
 */
function worktreeMergeFollowUp(
  worktree: ThreadWorktreeRecord,
  status: WorktreeStatus | null | undefined,
): string | null {
  if (worktree.status !== "merged") return null;
  if (!worktree.mergedHeadOid || !status?.headOid) {
    return "This branch was merged into your local project earlier. Mythra Code cannot confirm what has happened to it since.";
  }
  if (status.headOid !== worktree.mergedHeadOid) {
    return "This branch was merged into your local project earlier, and has changed since. Merge again to bring the new commits across.";
  }
  return "This branch was merged into your local project earlier. The files here have uncommitted changes that are not part of that merge.";
}

function worktreeMenuItems(props: {
  worktreeBusy?: boolean;
  revealLabel?: string;
  onWorktreeReveal: () => void;
  onWorktreeRefresh: () => void;
  onWorktreeRemove: () => void;
}): AppActionMenuItem[] {
  return [
    {
      id: "reveal",
      label: props.revealLabel ?? "Show folder",
      icon: <Eye size={13} aria-hidden="true" />,
      disabled: props.worktreeBusy,
      onSelect: props.onWorktreeReveal,
    },
    {
      id: "refresh",
      label: "Refresh status",
      icon: <RefreshCw size={13} aria-hidden="true" />,
      disabled: props.worktreeBusy,
      onSelect: props.onWorktreeRefresh,
    },
    {
      id: "remove",
      label: "Remove worktree…",
      description: "Deletes this checkout and its branch. Asks first.",
      icon: <Trash2 size={13} aria-hidden="true" />,
      danger: true,
      disabled: props.worktreeBusy,
      onSelect: props.onWorktreeRemove,
    },
  ];
}
