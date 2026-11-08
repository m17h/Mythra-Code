import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent, type Ref } from "react";
import { Bot, Boxes, ChevronRight, CircleStop, CodeXml, FilePlus2, FolderGit2, Gauge, GitCommitHorizontal, Play, RefreshCw, SearchCode, ShieldCheck, TerminalSquare, Workflow as WorkflowIcon, Wrench } from "lucide-react";
import { DiffFileSections } from "../DiffView";
import { FileBrowser, type FileBrowserSource } from "../FileBrowser";
import { ChecksControl } from "../ChecksControl";
import type { GitPathAction } from "../GitChangesView";
import { GitPanel, type GitPanelAction, type GitPanelDraft } from "../GitPanel";
import { ThreadUsagePanel } from "../ThreadUsagePanel";
import { ThreadPullRequestPanel } from "../ThreadPullRequestPanel";
import { useSessionThreadPullRequest } from "../../hooks/useThreadPullRequest";
import { RemotePullRequestActivity } from "./RemotePullRequestActivity";
import { useRemoteCommand } from "./useRemoteCommand";
import { useRemoteDiscovery } from "./useRemoteDiscovery";
import { useRemoteWorkers } from "./useRemoteWorkers";
import { workerRuntime } from "../../lib/remote/workerReads";
import { useRemoteOutbox } from "../../lib/remote/outbox";
import { AgentsPanel, CheckpointsPanel, Empty, PanelHeader, StudioDockFrame, TerminalPanelHost, WorktreesPanel, type AgentRecord, type StudioTab } from "../StudioDock";
import { confirmDialog } from "../../lib/confirmDialog";
import { mcpStatusLabel } from "../../lib/statusLabels";
import type { CheckpointRecord, CheckpointRestoreTarget } from "../../lib/checkpoints";
import type { ProjectCheckResult } from "../../lib/projectChecks";
import { parseDiffSections } from "../../lib/gitDiff";
import type { GitChangeArea } from "../../lib/gitInspection";
import { joinPath } from "../../lib/paths";
import type { GitRoute, GitView, ProjectGitInspection, ProjectPullRequestAccess } from "../../lib/projectGit";
import { accessReason, hostProjectWrite, hostRead, hostWrite, writeHostRepository } from "../../lib/remote/remoteActions";
import { expectRemoteRun, remoteTerminal, remoteTerminalKey, useRemoteTerminals, type RemoteTerminalStatus } from "../../lib/remote/remoteTerminal";
import { useRemoteWorkflowLaunch } from "./RemoteWorkflowLaunch";
import { elapsedLabel, HostTerminalSessionList, useHostTerminalSessions, useHostTerminalViewer, useReattachOwnSession } from "./RemoteTerminalSessions";
import { cachedPanel, panelKey, rememberPanel } from "../../lib/remote/panelCache";
import { remotePullRequests } from "../../lib/remote/remotePullRequests";
import { forkRemoteThread, refreshRemoteContext, remoteContextKey, runRemoteRowAction, useRemoteContext } from "../../lib/remote/remoteWork";
import { viewerRequest } from "../../lib/remote/viewerBridge";
import { useRemoteDevices } from "../../lib/remote/devices";
import { machineActions } from "../../lib/remote/activeMachine";
import { openRemoteThread, selectRemoteThread, useRemoteStore } from "../../lib/remote/remoteStore";
import type { CheckpointDiffResult, CheckpointListResult, FilePreviewResult, FilesListResult, GitDiffResult, GitLogResult, GitStatusResult, RepositoryWriteAction, RevertPreviewResult, WireHostProcessPolicy, StudioTarget, WireGitHubAccess, WireCheckpoint, WireGitChange, WorktreeStatusResult } from "../../lib/remote/wire-studio";
import type { HostContextResult } from "../../lib/remote/wire";
import type { WireResourceResult, WireUsageDetail } from "../../lib/remote/wire-resources";
import { addRemoteFeedback } from "../../lib/remote/remoteFeedback";
import type { CommitMessageSuggestion } from "../../lib/commitMessages";
import type { OwnershipLinks } from "../../lib/nativeAgentLinks";
import type { Provider } from "../../types";
import type { GitWorkflowControls, GitWorkspaceSnapshot } from "../../lib/gitWorkspace";
import type { ThreadUsageSummary } from "../../lib/threadUsage";
import type { ThreadWorktreeRecord } from "../../lib/worktrees";

const MAX_LIST_PAGES = 5;
type HostGitAction = "init" | "branch" | "stage" | "unstage" | "commit" | "push" | "pull" | "fetch" | "revert" | "revertAll";
const noop = () => undefined;

/** The host hands out opaque handles. The browser thinks in paths, so this
 * remembers which handle each shown path came from. */
function hostFiles(device: string, target: StudioTarget): FileBrowserSource & { fileId(path: string): string | undefined } {
  const handles = new Map<string, string>();
  return {
    fileId: (path) => handles.get(path),
    async list(path) {
      const parentId = handles.get(path);
      const entries = [];
      let cursor: string | undefined;
      for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
        const result: FilesListResult = await viewerRequest(device, "files.list", { ...target, ...(parentId ? { parentId } : {}), ...(cursor ? { cursor } : {}) });
        for (const entry of Array.isArray(result?.entries) ? result.entries : []) {
          handles.set(joinPath(path, entry.name), entry.id);
          entries.push({ fileName: entry.name, isDirectory: entry.kind === "directory", isFile: entry.kind === "file" });
        }
        cursor = result.cursor;
        if (!cursor) break;
      }
      return { entries };
    },
    async search(query, root) {
      const result = await viewerRequest<{ files: { id: string; name: string; relativePath: string }[] }>(device, "files.search", { ...target, query });
      return { files: (Array.isArray(result?.files) ? result.files : []).map((file) => {
        handles.set(joinPath(root, file.relativePath), file.id);
        return { root, path: file.relativePath, file_name: file.name, score: 0 };
      }) };
    },
    async preview(_root, path) {
      const fileId = handles.get(path);
      if (!fileId) throw new Error("That file is no longer available.");
      const result = await viewerRequest<FilePreviewResult>(device, "files.preview", { ...target, fileId });
      return { text: result.text, truncated: result.truncated, binary: result.binary };
    },
  };
}

/** Reads one thing from the host for an open panel. Nothing here polls. */
function useHostData<T>(load: (() => Promise<T>) | null, key: string): { data: T | null; failed: boolean; reload: () => void } {
  const [data, setData] = useState<T | null>(() => (cachedPanel(key) as T | undefined) ?? null);
  const [failed, setFailed] = useState(false);
  const [revision, setRevision] = useState(0);
  const latest = useRef(load);
  latest.current = load;
  useEffect(() => {
    setData((cachedPanel(key) as T | undefined) ?? null);
    setFailed(false);
    const read = latest.current;
    if (!read) return;
    let current = true;
    read().then((value) => { rememberPanel(key, value); if (current) setData(value); }, () => { if (current) setFailed(true); });
    return () => { current = false; };
  }, [key, revision]);
  return { data, failed, reload: useCallback(() => setRevision((value) => value + 1), []) };
}

function Reason({ text }: { text: string | null | undefined }) {
  return text ? <div className="worktree-note" role="status"><ShieldCheck size={13} aria-hidden="true" /><span>{text}</span></div> : null;
}

const REVIEW_BASELINE = { baseline: "HEAD", source: "repository" } as const;
const CHANGE_AREAS: Record<GitPathAction, readonly GitChangeArea[]> = { stage: ["unstaged", "untracked"], unstage: ["staged"], revert: ["unstaged", "staged", "untracked"] };

/** Git changes on the other machine, from the Git tab or Review center alike. */
function useHostGitWrites({ device, name, target, revision, allowed, reason, onResult, onChanged }: {
  device: string; name: string; target: StudioTarget; revision: string; allowed: boolean; reason: string;
  onResult: (message: string) => void; onChanged?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const changeIds = useRef(new Map<string, string>());
  const remember = useCallback((changes: readonly WireGitChange[]) => { changeIds.current = new Map(changes.map((change) => [`${change.area}:${change.path}`, change.id])); }, []);
  const write = useCallback(async (action: HostGitAction, extra: Record<string, unknown> = {}) => {
    if (!allowed) { onResult(reason); return false; }
    setBusy(true);
    const outcome = await hostWrite<{ output?: string }>(device, name, "git.write", { ...target, revision, action, ...extra });
    onResult(outcome.ok ? outcome.result?.output ?? "" : outcome.message);
    setBusy(false);
    if (outcome.ok) onChanged?.();
    return outcome.ok;
  }, [allowed, device, name, onChanged, onResult, reason, revision, target]);
  /** The host says what would change first, and the write answers that preview. */
  const revert = useCallback((action: "revert" | "revertAll", question: string, changeId?: string) => {
    if (!allowed) { onResult(reason); return; }
    hostRead<RevertPreviewResult>(device, "git.revert.preview", { ...target, ...(changeId ? { changeId } : {}) }).then(async (preview) => {
      const kept = preview.preservedPaths.length ? `\n\n${preview.preservedPaths.length} staged ${preview.preservedPaths.length === 1 ? "file stays" : "files stay"} as ${preview.preservedPaths.length === 1 ? "it is" : "they are"}.` : "";
      if (await confirmDialog(`${question}\n\n${preview.restorePaths.length} ${preview.restorePaths.length === 1 ? "file goes" : "files go"} back to the last commit. This can't be undone.${kept}`)) void write(action, { resourceId: preview.previewId, confirmed: true });
    }, () => onResult(`Mythra Code couldn't check that change on ${name}. Refresh and try again.`));
  }, [allowed, device, name, onResult, reason, target, write]);
  const pathAction = useCallback((action: GitPathAction, path: string) => {
    const resourceId = CHANGE_AREAS[action].map((area) => changeIds.current.get(`${area}:${path}`)).find(Boolean);
    if (!resourceId) { onResult("That change is no longer available. Refresh and try again."); return; }
    if (action !== "revert") { void write(action, { resourceId }); return; }
    revert("revert", `Undo the changes to “${path}” on ${name}?`, resourceId);
  }, [name, onResult, revert, write]);
  return { busy, changeIds, remember, write, revert, pathAction };
}

function HostChanges({ device, name, target, context, onOpenGit, onClose }: { device: string; name: string; target: StudioTarget; context: HostContextResult | undefined; onOpenGit: () => void; onClose: () => void }) {
  const connected = useRemoteDevices((state) => state.snapshot?.devices.find((entry) => entry.fingerprint === device)?.state === "connected");
  const { handle: checking, latest: lastCheck, set: setChecking } = useRemoteCommand(device, "checks.status", target, connected);
  const revision = context?.revision ?? "";
  const discovery = useRemoteDiscovery(device, name, "check", target, revision);
  // The host's last finished run, in the shape the real control shows.
  const checkResult = useMemo<ProjectCheckResult | null>(() => !lastCheck?.command || !lastCheck.updatedAt ? null : {
    id: lastCheck.id, projectId: target.workspaceId, threadId: target.threadId ?? null, cwd: `On ${name}`, command: lastCheck.command, head: null,
    startedAt: lastCheck.createdAt ?? lastCheck.updatedAt, finishedAt: lastCheck.updatedAt, exitCode: lastCheck.value ?? null, output: lastCheck.text ?? "", outputTruncated: (lastCheck.text?.length ?? 0) >= 12_000,
    status: lastCheck.status === "interrupted" ? "cancelled" : lastCheck.status === "completed" && !lastCheck.value ? "passed" : lastCheck.status === "uncertain" ? "error" : "failed",
  }, [lastCheck, name, target.threadId, target.workspaceId]);
  const [notice, setNotice] = useState("");
  const canCheck = Boolean(context?.capabilities.terminal);
  const canGit = Boolean(context?.capabilities.gitWrite && context.capabilities.terminal);
  const checkRevision = { workspaceId: target.workspaceId, ...(target.threadId ? { threadId: target.threadId } : {}), revision };
  const { data: status, failed, reload } = useHostData(() => viewerRequest<GitStatusResult>(device, "git.status", target), panelKey(device, "git.status", target));
  const [selected, setSelected] = useState<WireGitChange | null>(null);
  const [diff, setDiff] = useState("");
  const request = useRef(0);
  const reloadTurnRef = useRef<() => void>(noop);
  const open = useCallback((change: WireGitChange) => {
    setSelected(change);
    setDiff("");
    const current = ++request.current;
    viewerRequest<GitDiffResult>(device, "git.diff", { ...target, changeId: change.id })
      .then((result) => { if (current === request.current) setDiff(result.binary ? "This file is binary." : `${result.text}${result.truncated ? "\n… Diff shortened." : ""}`); })
      .catch(() => { if (current === request.current) setDiff(`Mythra Code couldn't read that change on ${name}. Try again.`); });
  }, [device, name, target]);
  const refresh = useCallback(() => { setSelected(null); setDiff(""); request.current += 1; reload(); reloadTurnRef.current(); }, [reload]);
  const { busy: gitBusy, remember, pathAction } = useHostGitWrites({ device, name, target, revision, allowed: canGit, reason: accessReason(name, "change Git", "Git changes and Terminal"), onResult: setNotice, onChanged: refresh });
  const changes = useMemo(() => Array.isArray(status?.changes) ? status.changes : [], [status?.changes]);
  useEffect(() => { remember(changes); }, [changes, remember]);
  // What this turn changed, when the host has that. Picking a file shows just that file.
  const { data: turn, reload: reloadTurn } = useHostData(target.threadId ? () => hostRead<WireResourceResult>(device, "review.diff", { ...target }) : null, panelKey(device, "review.diff", target));
  reloadTurnRef.current = reloadTurn;
  const turnDiff = turn?.reviewDiff?.text ? turn.reviewDiff : null;
  const shownDiff = diff || (selected ? "" : turnDiff?.text ?? "");
  const sections = useMemo(() => parseDiffSections(shownDiff), [shownDiff]);
  const stagedPaths = useMemo(() => changes.filter((change) => change.area === "staged").map((change) => change.path), [changes]);
  const [reviewing, setReviewing] = useState(false);
  const review = () => {
    setReviewing(true);
    void hostWrite(device, name, "review.start", { ...checkRevision }).then((outcome) => { setReviewing(false); setNotice(outcome.message); });
  };
  /** Stays on this device until it goes out with the next message. */
  const addCheckNote = (result: ProjectCheckResult) => addRemoteFeedback({
    kind: "check", command: result.command, cwd: result.cwd, checkedAt: result.finishedAt, status: result.status, exitCode: result.exitCode,
    output: result.output, outputTruncated: result.outputTruncated,
  }, result.status === "error" ? "Investigate why this check could not run, fix the cause, and rerun it." : "Investigate and fix this failed check, then rerun it to verify the fix.");
  return <>
    <PanelHeader icon={SearchCode} title="Review center" subtitle={`Inspect changes on ${name}`} onClose={onClose} />
    {/* Read only still lets checks run, as it does here; it is a warning, not a block. */}
    {canCheck && !context?.processPolicy?.checksBlockedReason && context?.processPolicy?.readOnly && <Reason text={context.processPolicy.readOnlyReason ?? `This thread is Read only on ${name}. Checks can still run.`} />}
    <div className="studio-actions wrap review-actions">
      <button onClick={refresh}><RefreshCw size={13} /> Refresh</button>
      <button onClick={review} disabled={!target.threadId || !context || reviewing} title={target.threadId ? `Ask the model on ${name} to review the working changes` : "Open a thread to request a review"}><Bot size={13} /> AI review</button>
      <ChecksControl command={context?.check?.command} running={Boolean(checking)} runningCommand={lastCheck?.command} startedAt={checking ? lastCheck?.createdAt ?? null : null} result={checkResult} onAddFeedback={addCheckNote}
        disabledReason={!canCheck ? accessReason(name, "run checks", "Terminal") : context?.processPolicy?.checksBlockedReason ?? undefined}
        discovery={canCheck ? discovery : undefined} discoveryModelNote={`The model saved on ${name}${context?.discovery?.model ? ` · ${context.discovery.model}` : ""}`}
        onRun={() => { void hostWrite<{ processHandle?: string }>(device, name, "checks.start", checkRevision).then((outcome) => { setNotice(outcome.message); if (outcome.ok) setChecking(outcome.result?.processHandle ?? "running"); }); }}
        onStop={() => { if (checking) void hostWrite(device, name, "checks.stop", { ...checkRevision, processHandle: checking }).then((outcome) => { setNotice(outcome.message); if (outcome.ok) setChecking(null); }); }}
        onSave={(command) => { void hostProjectWrite(device, name, target.workspaceId, "projects.check.set", { command }).then((outcome) => { setNotice(outcome.message); if (outcome.ok) void refreshRemoteContext(device, target.workspaceId, target.threadId); }); }} />
      <button onClick={onOpenGit} title="Open Git Changes to see staged and unstaged files separately and commit them"><GitCommitHorizontal size={13} /> Stage &amp; commit in Git</button>
    </div>
    <Reason text={notice} />
    <div className="diff-summary">
      <span><CodeXml size={13} /> {turnDiff?.source === "runtime" && !selected ? "Working changes" : "Repository changes"}</span>
      <small>{status ? `${status.changedFiles} file${status.changedFiles === 1 ? "" : "s"} changed` : failed ? "Not available" : "Reading changes…"}</small>
    </div>
    {failed && <Reason text={`Mythra Code couldn't read changes on ${name}. Try again.`} />}
    <div className="studio-list">{changes.map((change) => <button key={change.id} className="studio-list-row remote-change-row" aria-pressed={selected?.id === change.id} onClick={() => open(change)}>
      <div><strong>{change.path}</strong><small>{change.status} · {change.area}</small></div>
    </button>)}</div>
    {sections.length ? <DiffFileSections sections={sections} readOnly={!canGit || gitBusy} readOnlyReason={canGit ? "Mythra Code is finishing the last change." : accessReason(name, "change Git", "Git changes and Terminal")}
      stagedPaths={stagedPaths} feedbackDiff={!selected && turnDiff ? { baseline: turnDiff.baseline, source: turnDiff.source } : REVIEW_BASELINE} onPathAction={pathAction} onUnstage={(path) => pathAction("unstage", path)} />
      : shownDiff && <pre className="diff-view">{shownDiff}</pre>}
    {turnDiff?.truncated && !selected && <Reason text="This turn's diff is shortened here. Pick a file to read it in full." />}
  </>;
}

function HostTerminal({ device, name, target, allowed, policy, onClose }: { device: string; name: string; target: StudioTarget; allowed: boolean; policy: WireHostProcessPolicy | undefined; onClose: () => void }) {
  const session = useMemo(() => remoteTerminal(device, target.workspaceId), [device, target.workspaceId]);
  const view = useRemoteTerminals((state) => state.views[remoteTerminalKey(device, target.workspaceId)]);
  const platform = useRemoteDevices((state) => state.snapshot?.devices.find((entry) => entry.fingerprint === device)?.platform);
  const connectionState = useRemoteDevices((state) => state.snapshot?.devices.find((entry) => entry.fingerprint === device)?.state);
  // Each time the link comes back is a new chance to reconnect a command started here.
  const [connection, setConnection] = useState(0);
  const lastState = useRef(connectionState);
  useEffect(() => { if (lastState.current !== "connected" && connectionState === "connected") setConnection((value) => value + 1); lastState.current = connectionState; }, [connectionState]);
  const connected = connectionState === "connected";
  const { list: sessions, error: listError, reload: reloadSessions } = useHostTerminalSessions(device, target.workspaceId, allowed && connected);
  const { failure: reattachFailure, retry: retryReattach } = useReattachOwnSession(device, target.workspaceId, allowed && connected, String(connection));
  // A session picked from the list: reattached when the host allows it, otherwise shown read-only.
  const [watching, setWatching] = useState<string | null>(null);
  const viewer = useHostTerminalViewer(device, target.workspaceId, watching);
  const busy = Boolean(view?.running || view?.opening);
  useEffect(() => { if (!busy) reloadSessions(); }, [busy, reloadSessions]);
  const select = (entry: RemoteTerminalStatus) => {
    if (watching === entry.terminalId) { setWatching(null); return; }
    if (entry.attachable && entry.running && !busy) { setWatching(null); void session.attach(entry.terminalId).catch(() => reloadSessions()); return; }
    setWatching(entry.terminalId);
  };
  // Starting, typing and stopping need Terminal access and a command this device may control.
  // Read only (the sandbox) still allows safe commands, so it is only a warning.
  const observer = Boolean(view?.readOnly);
  const canRunHere = allowed && connected;
  const canControl = canRunHere && !observer && !watching;
  const controlReason = !allowed ? accessReason(name, "run commands", "Terminal")
    : !connected ? `${name} isn't connected right now.`
    : watching ? "This is a read-only view of that command. Choose it again to go back."
    : observer ? `This command was started on ${name}, so only it can type into it or stop it. You can watch it here.` : undefined;
  const reason = !allowed ? accessReason(name, "run commands", "Terminal")
    : watching ? viewer.status?.notice || (viewer.status ? viewer.status.running ? `Watching a command on ${name}. Choose it again to go back.` : `That command has ended${viewer.status.exitCode === null ? "" : ` · exit ${viewer.status.exitCode}`} · ${elapsedLabel(viewer.status.elapsedMs)}.` : `Reading that command's output from ${name}…`)
    : observer ? `This command was started on ${name}. You can watch it here.`
    : policy?.processPolicyReason ?? (policy?.terminalBusy && !busy ? `A terminal command is already running on ${name}.` : null)
    ?? (view?.notice || (view && !view.running && typeof view.exitCode === "number" && view.exitCode !== 0 ? `Stopped · exit ${view.exitCode}.` : ""));
  const onInput = useCallback((data: string) => session.write(name, data), [name, session]);
  const onResize = useCallback((columns: number, rows: number) => session.resize(name, columns, rows), [name, session]);
  const onRun = useCallback(async (command: string) => {
    await session.run(name, target.threadId, command);
    const after = useRemoteTerminals.getState().views[remoteTerminalKey(device, target.workspaceId)];
    reloadSessions();
    return Boolean(after?.running || after?.terminalId);
  }, [device, name, reloadSessions, session, target.threadId, target.workspaceId]);
  const onStop = useCallback(() => session.stop(name), [name, session]);
  const onClear = useCallback(() => session.clear(), [session]);
  return <>
    <PanelHeader icon={TerminalSquare} title="Terminal" subtitle={`Runs on ${name}`} onClose={onClose} />
    <Reason text={reason} />
    {reattachFailure && <div className="worktree-note" role="alert"><ShieldCheck size={13} aria-hidden="true" /><span>{reattachFailure}</span>
      <button type="button" className="secondary-button" onClick={retryReattach}>Retry</button></div>}
    <TerminalPanelHost outputStore={watching ? viewer.store : session.store} scope={`${device}/${target.workspaceId}${watching ? `/${watching}` : ""}`} scopeLabel={name} shell={platform === "windows" ? "Command Prompt" : platform === "macos" ? "zsh" : "shell"}
      running={watching ? Boolean(viewer.status?.running) : busy}
      runningCommand={watching ? viewer.status?.command ?? "" : view?.command ?? ""} runningElsewhere={NO_ELSEWHERE} readOnly={Boolean(policy?.readOnly)}
      canRun={canRunHere && !watching} canControl={canControl} {...(controlReason ? { controlReason } : {})}
      sessionList={<HostTerminalSessionList sessions={sessions} name={name} selected={watching} ownId={view?.terminalId} error={listError} onSelect={select} />}
      onRun={onRun} onStop={onStop} onClear={onClear} onInput={onInput} onResize={onResize} />
  </>;
}
const NO_ELSEWHERE: { scope: string; command: string }[] = [];

const AREA_MARK: Partial<Record<GitChangeArea, string>> = { staged: "M ", unstaged: " M", untracked: "??" };
const PUBLISH_RECHECK_MS = 15_000;
const MOST_DIFF_FILES = 40;
const MOST_DIFF_CHARS = 256 * 1024;
const NO_CREW: readonly { id: string; label?: string; enabled?: boolean }[] = [];
const NO_LINKS = {};
const NO_MANAGED_LINKS: OwnershipLinks = {};
const NOT_HERE_YET = (what: string, name: string) => `${what} on ${name} isn't available from here yet.`;
/** Which of the host's listed changes a path action means. */
/** The host keeps a checkpoint's commits and folder. Their presence is all the panel needs. */
const HOST_ONLY = "host";
const checkpointRecord = ({ restorable, status, ...checkpoint }: WireCheckpoint): CheckpointRecord => ({ ...checkpoint, status: status as CheckpointRecord["status"],
  ...(restorable.before ? { workspacePath: HOST_ONLY, beforeCommit: HOST_ONLY } : {}), ...(restorable.after ? { afterCommit: HOST_ONLY } : {}) });
function HostGit({ device, name, target, revision, allowed, canWork, threadBusy, view, route, draft, onDraft, onView, onTab, onClose }: {
  device: string; name: string; target: StudioTarget; revision: string; allowed: boolean; canWork: boolean; threadBusy: boolean; view: GitView; route: GitRoute | null;
  draft: GitPanelDraft | undefined; onDraft: (draft: GitPanelDraft) => void;
  onView: (view: GitView) => void; onTab: (tab: StudioTab) => void; onClose: () => void;
}) {
  const [output, setOutput] = useState("");
  const reason = accessReason(name, "change Git", "Git changes and Terminal");
  const { data: checkout, reload: reloadCheckout } = useHostData(() => hostRead<WireResourceResult>(device, "git.context", { ...target }), panelKey(device, "git.context", target));
  const { busy, changeIds, remember, write, revert, pathAction } = useHostGitWrites({ device, name, target, revision, allowed, reason, onResult: setOutput, onChanged: reloadCheckout });
  const inspection = useMemo<ProjectGitInspection>(() => ({
    cwd: `${device}/${target.workspaceId}/${target.threadId ?? ""}`,
    getChanges: async () => {
      const status = await viewerRequest<GitStatusResult>(device, "git.status", target);
      const changes = Array.isArray(status?.changes) ? status.changes : [];
      remember(changes);
      return { rootPath: "", rows: changes.map(({ path, originalPath, area, status: state }) => ({ path, originalPath, area, status: state })),
        stagedFiles: status.stagedFiles, unstagedFiles: status.unstagedFiles, untrackedFiles: status.untrackedFiles, changedFiles: status.changedFiles, truncated: status.truncated };
    },
    getFileDiff: async (_cwd, path, area: GitChangeArea) => {
      const changeId = changeIds.current.get(`${area}:${path}`);
      if (!changeId) throw new Error("That change is no longer available.");
      const diff = await viewerRequest<GitDiffResult>(device, "git.diff", { ...target, changeId });
      return { path: diff.path, area: diff.area, text: diff.text, binary: diff.binary, truncated: diff.truncated };
    },
    getHistory: (_cwd, offset, limit, headOid) => hostRead<GitLogResult>(device, "git.log", { ...target, offset, limit, ...(headOid ? { headOid } : {}) }),
  }), [changeIds, device, remember, target]);
  const { data: repository, reload: reloadRepository } = useHostData(() => hostRead<GitLogResult>(device, "git.log", { ...target, limit: 1 }), panelKey(device, "git.log", target));
  const label = `remote:${device}/${target.workspaceId}/${target.threadId ?? ""}`;
  const revisionRef = useRef(revision);
  revisionRef.current = revision;
  const pullRequests = useMemo(() => remotePullRequests({ device, name, target, revision: () => revisionRef.current }), [device, name, target]);
  const { data: github, reload: reloadGitHub } = useHostData<WireGitHubAccess>(() => pullRequests.access(), panelKey(device, "github", target));
  const blocked = allowed ? null : reason;
  const threadId = target.threadId;
  const threadPullRequest = useSessionThreadPullRequest({
    threadId: target.threadId ? `${device}/${target.threadId}` : null, cwd: label, projectPath: label, isolated: github?.isolated === true,
    enabled: Boolean(target.threadId && github?.authenticated && github.repository), visible: true,
    mutationBlockedReason: blocked, checkMutationAllowed: () => null, backend: pullRequests, onChanged: reloadGitHub,
    // Offered once the host can really do it, so a merge never ends in a half-finished archive.
    ...(threadId && github?.canArchive ? { archiveThread: async () => {
      const failure = await runRemoteRowAction(device, name, "thread.archive", { threadId });
      if (failure) throw new Error(`The pull request merged, but ${failure.charAt(0).toLowerCase()}${failure.slice(1)}`);
    } } : {}),
  }, github?.savedLink);
  /** The shared project on that machine moves to the merged branch, as Update local does here. */
  const updateLocal = useCallback(async (base: string) => {
    if (!allowed) throw new Error(reason);
    if (!await confirmDialog(`Update the shared project on ${name} to ${base} from GitHub?\n\nIt needs no uncommitted changes. An isolated thread stays in its own folder.`)) return;
    await viewerRequest<GitStatusResult>(device, "git.status", target).catch(() => undefined);
    const outcome = await hostWrite(device, name, "git.write", { ...target, revision: revisionRef.current, action: "update", base, confirmed: true });
    setOutput(outcome.ok ? `The shared project on ${name} is updated to ${base}.` : outcome.message);
    if (!outcome.ok) throw new Error(outcome.message);
  }, [allowed, device, name, reason, target]);
  const { onAttach: attachHere, onDetach: detachHere, linked, pullRequest } = threadPullRequest;
  /** The link belongs to the thread on the host, so it outlasts this session. */
  const saveLink = useCallback((reference: string | null) => {
    void hostWrite(device, name, "thread.pullRequest.set", { ...target, revision: revisionRef.current, reference }).then((outcome) => {
      if (outcome.ok) reloadGitHub(); else setOutput(outcome.message);
    });
  }, [device, name, reloadGitHub, target]);
  const onAttach = attachHere;
  const onDetach = useCallback(() => { detachHere(); saveLink(null); }, [detachHere, saveLink]);
  // Attach and create both end here, and a saved link that came from the host doesn't go back.
  const linkedUrl = linked ? pullRequest?.url ?? null : null;
  const savedNumber = github?.savedLink?.number, linkedNumberNow = linked ? pullRequest?.number : undefined;
  useEffect(() => {
    if (linkedUrl && github && linkedNumberNow !== savedNumber) saveLink(linkedUrl);
  }, [github, linkedNumberNow, linkedUrl, saveLink, savedNumber]);
  const linkedRepository = linked ? pullRequest?.repository ?? null : null, linkedNumber = linked ? pullRequest?.number ?? null : null;
  const projectAccess = useMemo<ProjectPullRequestAccess>(() => ({
    ...pullRequests, cwd: label, projectPath: label, repository: github?.repository ?? null, authenticated: github?.authenticated === true,
    threadActive: Boolean(target.threadId), isolated: github?.isolated === true, mutationBlockedReason: blocked, checkMutationAllowed: () => null,
    list: (_cwd, _repository, query) => pullRequests.list(query),
    ...(target.threadId ? { attachToThread: onAttach } : {}),
    threadLink: linkedRepository && linkedNumber ? { repository: linkedRepository, number: linkedNumber } : null,
    onUpdateLocal: (_repository, base) => updateLocal(base),
    onChanged: reloadGitHub,
  }), [blocked, github, label, linkedNumber, linkedRepository, onAttach, pullRequests, reloadGitHub, target.threadId, updateLocal]);
  const signInHere = () => setOutput(`GitHub sign-in stays on ${name}. Connect it there in Settings → GitHub.`);
  /** The same Connect form as here. The host runs Git and GitHub in its own checkout, with its own sign-in. */
  const [repositoryBusy, setRepositoryBusy] = useState(false);
  /** A create whose answer never came back, or a repository made but not attached. Either is
   * recovered by checking or attaching, never by creating again. */
  const [recovery, setRecovery] = useState<{ kind: "unknown" } | { kind: "unattached"; url: string } | null>(null);
  const [checking, setChecking] = useState(false);
  const changeRepository = useCallback(async (action: RepositoryWriteAction, success: string) => {
    if (!allowed) { setOutput(reason); return; }
    setRepositoryBusy(true); setOutput("");
    const outcome = await writeHostRepository(device, name, target.workspaceId, action, target.threadId);
    setRepositoryBusy(false);
    const made = outcome.result?.repository;
    if (action.action === "createRepository" && outcome.unknown) {
      setRecovery({ kind: "unknown" });
      setOutput(`We couldn't confirm whether the repository was created on ${name}. Check before trying again.`);
      return;
    }
    if (outcome.ok && made && made.attached === false && made.url) {
      setRecovery({ kind: "unattached", url: made.url });
      setOutput(made.message || `The repository was created at ${made.url}, but ${name} couldn't attach it to this project.`);
      reloadGitHub();
      return;
    }
    setOutput(outcome.ok ? outcome.message || success : outcome.message);
    if (outcome.ok) { setRecovery(null); reloadGitHub(); reloadCheckout(); reloadRepository(); }
  }, [allowed, device, name, reason, reloadCheckout, reloadGitHub, reloadRepository, target.threadId, target.workspaceId]);
  // The project now names a repository: whatever was in doubt is settled.
  useEffect(() => { if (github?.repository && recovery) { setRecovery(null); setOutput(`This project is connected to ${github.repository} on ${name}.`); } }, [github?.repository, name, recovery]);
  const checkRepository = () => {
    setChecking(true);
    reloadGitHub(); reloadCheckout();
    void refreshRemoteContext(device, target.workspaceId, target.threadId).finally(() => setChecking(false));
  };
  /** The host's latest suggestion. It changes when a turn on that machine writes a new one. */
  const threadScoped = Boolean(target.threadId);
  const { data: suggested, reload: reloadSuggestion } = useHostData(threadScoped ? () => hostRead<WireResourceResult>(device, "git.suggestion.read", { ...target }) : null, panelKey(device, "git.suggestion", target));
  useEffect(() => { if (threadScoped && !threadBusy) reloadSuggestion(); }, [reloadSuggestion, threadBusy, threadScoped]);
  const hostSuggestion = suggested?.suggestion;
  const commitSuggestion = useMemo<CommitMessageSuggestion | undefined>(() => hostSuggestion && !hostSuggestion.stale ? { id: hostSuggestion.id, message: hostSuggestion.message, ...(hostSuggestion.stagedMessage ? { stagedMessage: hostSuggestion.stagedMessage } : {}),
    context: { rootPath: "", headOid: null, branch: null, token: hostSuggestion.token, stagedToken: hostSuggestion.token, changesToken: hostSuggestion.token } } : undefined, [hostSuggestion]);
  // A suggestion fills an untouched message, as it does locally. Typing always wins.
  const emptyDraft = useRef<GitPanelDraft>({ commitMessage: "", remoteInput: "", repositoryName: "", visibility: "private" });
  const currentDraft = draft ?? emptyDraft.current;
  useEffect(() => {
    if (!commitSuggestion || currentDraft.commitMessageEdited || currentDraft.commitMessage && !currentDraft.commitMessageSuggestionId || currentDraft.commitMessageSuggestionId === commitSuggestion.id) return;
    onDraft({ ...currentDraft, commitMessage: commitSuggestion.message, commitMessageSuggestionId: commitSuggestion.id, commitMessageToken: commitSuggestion.context.changesToken });
  }, [commitSuggestion, currentDraft, onDraft]);
  const readCommitContext = useCallback(async () => {
    const latest = await hostRead<WireResourceResult>(device, "git.suggestion.read", { ...target });
    const token = latest.suggestion && !latest.suggestion.stale ? latest.suggestion.token : "";
    return { stagedToken: token, changesToken: token };
  }, [device, target]);
  const regenerate = () => { void hostWrite(device, name, "git.suggestCommit", { ...target, revision }).then((outcome) => setOutput(outcome.message)); };
  /** Branches come from the host, and a switch answers what it last reported. */
  const hostCheckout = checkout?.git;
  const snapshot = useMemo<GitWorkspaceSnapshot | null>(() => hostCheckout ? { branch: hostCheckout.branch, headOid: hostCheckout.headOid, upstream: github?.upstream ?? null, upstreamRemote: github?.upstream ? "origin" : null,
    ahead: github?.ahead ?? null, behind: github?.behind ?? null, branches: hostCheckout.branches.map((branch) => ({ ...branch, worktreePath: null })), stagedFiles: hostCheckout.stagedFiles, unstagedFiles: hostCheckout.unstagedFiles,
    changedFiles: hostCheckout.changedFiles, stagedPaths: [], rootPath: "", isRoot: true } : null, [github?.ahead, github?.behind, github?.upstream, hostCheckout]);
  const switchBranch = useCallback(async (branch: string, create: boolean) => {
    await viewerRequest<GitStatusResult>(device, "git.status", target).catch(() => undefined);
    return await write("branch", { name: branch, create });
  }, [device, target, write]);
  /** Publishing belongs to the project on that machine, and keeps running without this view. */
  const { data: publishing, reload: reloadPublishing } = useHostData(() => hostRead<WireResourceResult>(device, "git.autoPublish.read", { ...target }), panelKey(device, "git.autoPublish", target));
  const publishState = publishing?.autoPublish;
  useEffect(() => {
    if (!publishState?.enabled) return;
    const timer = setInterval(reloadPublishing, PUBLISH_RECHECK_MS);
    return () => clearInterval(timer);
  }, [publishState?.enabled, reloadPublishing]);
  const repositoryName = github?.repository;
  // Status only. Turning publishing on can push code, so that stays on the machine itself.
  const autoPublish = useMemo<GitWorkflowControls["autoPublish"]>(() => publishState && (repositoryName || publishState.repository) ? { enabled: publishState.enabled, status: publishState.status, message: publishState.message,
    repository: publishState.repository ?? repositoryName ?? undefined, hostOnly: `Change this on ${name}.` } : undefined, [name, publishState, repositoryName]);
  const workflow = useMemo<GitWorkflowControls | undefined>(() => snapshot ? { snapshot, busy, isolated: github?.isolated === true, onBranch: switchBranch, onRefresh: reloadCheckout, ...(output ? { notice: output } : {}), ...(autoPublish ? { autoPublish } : {}) } : undefined,
    [autoPublish, busy, github?.isolated, output, reloadCheckout, snapshot, switchBranch]);
  /** The same answers as local `git status` and `git diff`, built from what the host reads. */
  const fullStatus = async () => {
    try {
      const status = await viewerRequest<GitStatusResult>(device, "git.status", target);
      const heading = hostCheckout?.branch ? `## ${hostCheckout.branch}${github?.upstream ? `...${github.upstream}` : ""}` : "";
      const rows = (Array.isArray(status?.changes) ? status.changes : []).map((change) => `${AREA_MARK[change.area] ?? "  "} ${change.originalPath ? `${change.originalPath} -> ` : ""}${change.path}`);
      setOutput([heading, ...rows, ...(status.truncated ? ["… List shortened."] : [])].filter(Boolean).join("\n") || "Nothing to commit.");
    } catch { setOutput(`Mythra Code couldn't read the status on ${name}. Try again.`); }
  };
  const fullDiff = async () => {
    try {
      const status = await viewerRequest<GitStatusResult>(device, "git.status", target);
      const changes = (Array.isArray(status?.changes) ? status.changes : []).slice(0, MOST_DIFF_FILES);
      let text = "";
      for (const change of changes) {
        if (text.length >= MOST_DIFF_CHARS) break;
        const diff = await viewerRequest<GitDiffResult>(device, "git.diff", { ...target, changeId: change.id });
        text += `${diff.binary ? `Binary file: ${change.path}` : diff.text}\n`;
      }
      const shortened = text.length >= MOST_DIFF_CHARS || status.truncated || (status.changes?.length ?? 0) > MOST_DIFF_FILES;
      setOutput(`${text.slice(0, MOST_DIFF_CHARS)}${shortened ? "\n… Diff shortened." : ""}`.trim() || "No changes.");
    } catch { setOutput(`Mythra Code couldn't read the diff on ${name}. Try again.`); }
  };
  const panelAction = (action: GitPanelAction, message?: string) => {
    switch (action) {
      case "stage": case "unstage": case "fetch": case "pull": case "push": void write(action); return;
      case "revert":
        revert("revertAll", `Undo every uncommitted change on ${name}?`);
        return;
      case "commit": case "commitStaged": case "commitPush": case "commitStagedPush": {
        const stagedOnly = action === "commitStaged" || action === "commitStagedPush";
        void write("commit", { ...(message ? { message } : {}), stagedOnly }).then((saved) => { if (saved && action.endsWith("Push")) void write("push"); });
        return;
      }
      case "comments": case "ci": case "pr": onView("pulls"); return;
      case "status": void fullStatus(); return;
      case "diff": void fullDiff(); return;
      default: setOutput(NOT_HERE_YET("That", name));
    }
  };
  return <>
    <PanelHeader icon={FolderGit2} title="Git" subtitle={`Changes on ${name}`} onClose={onClose} />
    {recovery && <div className="worktree-note" role="alert"><ShieldCheck size={13} aria-hidden="true" />
      {recovery.kind === "unknown"
        ? <><span>We couldn't confirm whether the GitHub repository was created on {name}. Check this project before trying anything else.</span>
          <button type="button" className="secondary-button" disabled={checking} onClick={checkRepository}>{checking ? "Checking…" : "Check again"}</button>
          <button type="button" className="secondary-button" onClick={() => { setRecovery(null); setOutput(""); }} title="Only if you've checked on GitHub that it wasn't created">It wasn't created</button></>
        : <><span>The repository <code>{recovery.url}</code> exists but isn't attached to this project on {name}.</span>
          <button type="button" className="secondary-button" disabled={repositoryBusy} onClick={() => void changeRepository({ action: "attachRemote", url: recovery.url }, `GitHub repository attached on ${name}.`)}>Attach it</button></>}
    </div>}
    <GitPanel repositoryState={repository?.repository === false ? "absent" : "ready"} gitInitializing={busy} gitOutput={output} gitCommitSuccess="" gitCommitBusy={busy} githubAuthenticated={github?.authenticated === true}
      githubRepoStatus={github ? { isRepo: true, repository: github.repository, branch: github.branch, upstream: github.upstream, ahead: github.ahead, behind: github.behind } : null}
      hasPullRequestWorkflow pullRequests={projectAccess}
      pullRequestPanel={target.threadId && github?.repository && github.authenticated ? <>
        <ThreadPullRequestPanel {...threadPullRequest} onDetach={onDetach} threadId={`${device}/${target.threadId}`} isolated={github.isolated} mutationBlockedReason={blocked}
          onUpdateLocal={threadPullRequest.pullRequest?.state === "MERGED" ? () => updateLocal(threadPullRequest.pullRequest!.baseRefName) : undefined}
          onOpenWorktrees={() => onTab("worktrees")} onOpenGitHubSettings={signInHere} />
        {linked && pullRequest && <RemotePullRequestActivity pullRequests={pullRequests} pullRequest={pullRequest} allowed={allowed} reason={reason} name={name} />}
      </> : undefined}
      readOnly={!allowed} readOnlyReason={reason} gitOperationBusy={busy} defaultRepositoryName="" inspection={inspection} workflow={workflow} draft={currentDraft} onDraftChange={onDraft}
      commitSuggestion={commitSuggestion} commitSuggestionBusy={threadBusy} readCommitContext={readCommitContext} onRegenerateCommitMessage={target.threadId && canWork ? regenerate : undefined} view={view} onViewChange={onView} focusRequest={route}
      onOpenTool={onTab} onPathAction={pathAction} onAction={panelAction}
      onInitializeGit={() => { void write("init").then((done) => { if (done) reloadRepository(); }); }} githubBusy={repositoryBusy || recovery?.kind === "unknown"}
      onGitHubAttach={(url) => { if (url.trim()) void changeRepository({ action: "attachRemote", url: url.trim() }, `GitHub repository attached on ${name}.`); }}
      onGitHubCreate={(repository, visibility) => { if (recovery) { setOutput("Finish checking the last repository first."); return; } if (repository.trim()) void changeRepository({ action: "createRepository", name: repository.trim(), visibility }, `${visibility === "private" ? "Private" : "Public"} GitHub repository created on ${name}.`); }} onOpenGitHubSettings={signInHere} />
  </>;
}

function HostCheckpoints({ device, name, target, revision, threadOpen, allowed, onFork, onClose }: {
  device: string; name: string; target: StudioTarget; revision: string; threadOpen: boolean; allowed: boolean; onFork: () => void; onClose: () => void;
}) {
  const { data, failed, reload } = useHostData(() => hostRead<CheckpointListResult>(device, "checkpoint.list", { ...target }), panelKey(device, "checkpoint.list", target));
  const [busy, setBusy] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ id: string; diff: string } | null>(null);
  const [notice, setNotice] = useState("");
  const checkpoints = useMemo(() => (Array.isArray(data?.checkpoints) ? data.checkpoints : []).map(checkpointRecord), [data?.checkpoints]);
  const run = (id: string, op: string, args: Record<string, unknown>) => {
    setBusy(id);
    setNotice("");
    void hostWrite(device, name, op, { ...target, revision, ...args }).then((outcome) => {
      setBusy(null);
      setNotice(outcome.message);
      if (outcome.ok) reload();
    });
  };
  return <>
    <Reason text={failed ? `Mythra Code couldn't read checkpoints on ${name}. Try again.` : notice} />
    <CheckpointsPanel activeThread={threadOpen} checkpoints={checkpoints} checkpointHead={data?.head} checkpointBusyId={busy} checkpointPreview={preview} onClose={onClose}
      onCheckpoint={() => run("manual", "checkpoint.create", { checkpointId: crypto.randomUUID(), label: "Manual checkpoint" })}
      forkSavedCheckpoints
      onFork={(checkpoint) => {
        if (!checkpoint) { onFork(); return; }
        // From the chosen checkpoint's own conversation, as here. A refusal never falls back to the latest turn.
        const fromThread = checkpoint.threadId, workspaceId = target.workspaceId, shownThread = target.threadId;
        if (!fromThread) return;
        setBusy(checkpoint.id); setNotice("");
        void forkRemoteThread(device, name, fromThread, checkpoint.id).then(async (result) => {
          setBusy(null);
          if ("failure" in result) { setNotice(result.failure); return; }
          // Opened once the host lists it, and only if the person is still where they started.
          const stillHere = () => { const view = useRemoteStore.getState().devices[device]; return view?.workspaceId === workspaceId && (view.threadId ?? undefined) === shownThread; };
          await openRemoteThread(device, workspaceId, result.threadId, stillHere);
        });
      }}
      onCheckpointRestore={(checkpoint, restore: CheckpointRestoreTarget) => {
        if (!allowed) { setNotice(accessReason(name, "restore checkpoints", "Restore checkpoints and Terminal")); return; }
        void confirmDialog(`Restore “${checkpoint.label}” on ${name}?\n\nA safety copy is saved first.`).then((confirmed) => { if (confirmed) run(checkpoint.id, "checkpoint.restore", { checkpointId: checkpoint.id, target: restore, confirmed: true }); });
      }}
      onCheckpointAccept={(checkpoint) => run(checkpoint.id, "checkpoint.accept", { checkpointId: checkpoint.id })}
      onCheckpointPreview={(checkpoint) => {
        if (preview?.id === checkpoint.id) { setPreview(null); return; }
        hostRead<CheckpointDiffResult>(device, "checkpoint.diff", { ...target, checkpointId: checkpoint.id }).then(
          (result) => setPreview({ id: checkpoint.id, diff: result.text }), () => setNotice(`Mythra Code couldn't read that checkpoint on ${name}.`));
      }}
      onCheckpointDelete={(checkpoint) => {
        void confirmDialog(`Delete “${checkpoint.label}” on ${name}?\n\nThis can't be undone.`).then((confirmed) => { if (confirmed) run(checkpoint.id, "checkpoint.delete", { checkpointId: checkpoint.id, confirmed: true }); });
      }}
      onRollback={() => {
        void confirmDialog(`Undo the last turn on ${name}?\n\nThis permanently removes the latest exchange from the conversation.`).then((confirmed) => { if (confirmed) run("rollback", "thread.rollback", { confirmed: true }); });
      }} />
  </>;
}

function HostWorktrees({ device, name, target, revision, allowed, onReview, onFiles, onClose }: { device: string; name: string; target: StudioTarget; revision: string; allowed: boolean; onReview: () => void; onFiles: () => void; onClose: () => void }) {
  const { data, failed, reload } = useHostData(target.threadId ? () => hostRead<WorktreeStatusResult>(device, "worktree.status", { ...target }) : null,
    panelKey(device, "worktree.status", target));
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const worktree = useMemo<ThreadWorktreeRecord | undefined>(() => data?.worktree ? { ...data.worktree, status: data.worktree.status as ThreadWorktreeRecord["status"], projectId: "", projectPath: "", gitDir: "" } : undefined, [data?.worktree]);
  const run = (op: "worktree.apply" | "worktree.merge" | "worktree.remove" | "worktree.recreate" | "worktree.continueShared" | "worktree.returnShared", confirmText: string | null, extra: Record<string, unknown> = {}) => {
    void (confirmText ? confirmDialog(confirmText) : Promise.resolve(true)).then((confirmed) => {
      if (!confirmed) return;
      setBusy(true);
      void hostWrite(device, name, op, { ...target, revision, ...extra, ...(op === "worktree.recreate" ? { label: worktree?.branch ?? "" } : { confirmed: true }) }).then((outcome) => { setBusy(false); setNotice(outcome.message); if (outcome.ok) reload(); });
    });
  };
  /** The same choice as local: what would be lost is read fresh and named, then confirmed. */
  const remove = (returnToShared: boolean) => {
    setBusy(true);
    hostRead<WorktreeStatusResult>(device, "worktree.status", { ...target }).then((latest) => {
      setBusy(false);
      const status = latest?.status;
      if (!status) { setNotice(`Mythra Code couldn't check this worktree on ${name}. Refresh and try again.`); return; }
      const destructive = !status.clean || status.ignoredFileCount > 0 || status.ahead > 0;
      const details = [
        status.changedFiles ? `${status.changedFiles} changed or untracked file${status.changedFiles === 1 ? "" : "s"}` : "",
        status.ahead ? `${status.ahead} unmerged commit${status.ahead === 1 ? "" : "s"}` : "",
        status.ignoredFileCount ? `${status.ignoredFileCount} ignored file${status.ignoredFileCount === 1 ? "" : "s"}` : "",
      ].filter(Boolean).join(", ");
      const question = returnToShared ? `Remove the finished worktree and return to the shared project on ${name}?` : `Remove this isolated worktree and delete its branch on ${name}?`;
      run(returnToShared ? "worktree.returnShared" : "worktree.remove", destructive
        ? `${question}\n\nIt contains ${details}. Those worktree-only files and commits will be permanently deleted. The shared project and GitHub are not changed.`
        : `${question}\n\nThe shared project, GitHub repository, and conversation remain available.`, { force: destructive });
    }, () => { setBusy(false); setNotice(`Mythra Code couldn't check this worktree on ${name}. Refresh and try again.`); });
  };
  return <>
    <Reason text={failed ? `Mythra Code couldn't read worktrees on ${name}. Try again.` : !allowed ? accessReason(name, "copy or merge worktree changes", "Terminal") : notice} />
    <WorktreesPanel worktree={worktree} worktreeStatus={data?.status ?? undefined} worktreeBusy={busy} gitActionsReadOnly={!allowed} revealLabel="Show folder" onClose={onClose}
      onWorktreeReview={onReview} onWorktreeApply={() => run("worktree.apply", `Copy this worktree's changes into the shared project on ${name}?`)} onWorktreeMerge={() => run("worktree.merge", `Merge this branch into the shared project on ${name}?`)}
      // A window opened over there would be seen by nobody. Files shows this same folder here.
      onWorktreeReveal={onFiles}
      onWorktreeRefresh={reload} onWorktreeRemove={() => remove(false)} onWorktreeRecreate={() => run("worktree.recreate", null)}
      onWorktreeContinueShared={() => run("worktree.continueShared", `Continue this conversation in the shared project on ${name}?\n\nThe worktree's folder and branch stay as they are.`)}
      onWorktreeReturnShared={() => remove(true)} />
  </>;
}

function HostAgents({ device, name, target, revision, running, crew, onClose }: { device: string; name: string; target: StudioTarget; revision: string; running: boolean; crew: readonly { id: string; label?: string; enabled?: boolean }[]; onClose: () => void }) {
  const threadScoped = Boolean(target.threadId);
  const { rows, act } = useRemoteWorkers(device, name, target, revision, running);
  const { data: mail, reload: reloadMail } = useHostData(threadScoped ? () => hostRead<WireResourceResult>(device, "mail.read", { ...target }) : null, panelKey(device, "mail.read", target));
  const [notice, setNotice] = useState("");
  const agents = useMemo<AgentRecord[]>(() => rows.map((worker) => ({ id: worker.id, prompt: worker.title, status: worker.status, ...(worker.provider ? { provider: worker.provider as Provider } : {}), ...(worker.model ? { model: worker.model } : {}),
    runtime: worker.kind === "native" ? workerRuntime(worker) : "codex", task: worker.task, progress: worker.progress, result: worker.result, canOpen: worker.canOpen, canStop: worker.canStop, canAccept: worker.canAccept })), [rows]);
  const run = (op: "agents.stop" | "agents.accept" | "agents.replace", id: string, extra?: Record<string, unknown>) => { void act(op, id, extra).then((message) => { setNotice(message); reloadMail(); }); };
  const replacements = crew.filter((entry) => entry.enabled !== false);
  const detail = (id: string) => {
    const messages = mail?.mailboxes?.find((entry) => entry.agentId === id)?.messages;
    const worker = rows.find((entry) => entry.id === id);
    return <>
      {messages?.length ? <details><summary>Messages</summary>{messages.map((message) => <div key={message.id}>
        <small>{message.direction === "toParent" ? `From this agent · ${message.kind}` : "To this agent"}</small>
        <p style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{message.text}</p>
      </div>)}</details> : null}
      {worker?.canStop && replacements.length > 0 && <details><summary>Replace on another model</summary>{replacements.map((entry) => <button key={entry.id} type="button" className="secondary-button" onClick={() => {
        void confirmDialog(`Stop “${worker.title}” on ${name} and restart its task with ${entry.label || entry.id}?`).then((confirmed) => { if (confirmed) run("agents.replace", id, { targetId: entry.id }); });
      }}>{entry.label || entry.id}</button>)}</details>}
    </>;
  };
  return <>
    <Reason text={notice} />
    <AgentsPanel agents={agents} onClose={onClose} onOpenAgent={(id) => selectRemoteThread(device, id)} agentDetail={detail}
      onStopAgent={(id) => run("agents.stop", id)} onAcceptAgent={(id) => run("agents.accept", id)} />
  </>;
}

const usageSummary = (detail: WireUsageDetail): ThreadUsageSummary => ({ ...detail, own: detail.own as ThreadUsageSummary["own"], subagents: detail.subagents as ThreadUsageSummary["subagents"], total: detail.total as ThreadUsageSummary["total"],
  descendants: detail.descendants as ThreadUsageSummary["descendants"] });

function HostUsage({ device, target, context, name, provider, title, busy, onClose }: { device: string; target: StudioTarget | null; context: HostContextResult | undefined; name: string; provider?: Provider; title?: string; busy: boolean; onClose: () => void }) {
  const [notice, setNotice] = useState("");
  const threadTarget = target?.threadId ? target : null;
  const { data, failed, reload } = useHostData(threadTarget ? () => hostRead<WireResourceResult>(device, "usage.thread.read", { ...threadTarget }) : null, threadTarget ? panelKey(device, "usage.thread.read", threadTarget) : "usage:none");
  // New numbers land when a turn ends, so that's when this asks again.
  useEffect(() => { if (threadTarget && !busy) reload(); }, [busy, reload, threadTarget]);
  const summary = useMemo(() => data?.usage ? usageSummary(data.usage) : null, [data?.usage]);
  const usage = context?.usage;
  const refreshPrices = () => {
    if (!target) return;
    hostRead<WireResourceResult>(device, "usage.prices.refresh", { ...target }).then((result) => {
      setNotice(result.pricing?.available === false ? `${name} couldn't update prices right now.` : "");
      reload();
    }, () => setNotice(`${name} couldn't update prices right now.`));
  };
  const compact = () => {
    if (!target) return;
    setNotice("");
    void hostWrite(device, name, "thread.compact", { ...target, revision: context?.revision ?? "" }).then((outcome) => setNotice(outcome.message));
  };
  return <>
    <PanelHeader icon={Gauge} title="Thread usage" subtitle={`As reported by ${name}`} onClose={onClose} />
    <Reason text={notice || (failed ? `Mythra Code couldn't read usage on ${name}. Try again.` : "")} />
    <ThreadUsagePanel activeThread={Boolean(threadTarget)} threadId={target?.threadId} provider={provider} threadTitle={title} nativeLinks={NO_LINKS} managedLinks={NO_MANAGED_LINKS} hostSummary={summary}
      context={usage?.contextTokens !== undefined ? { totalTokens: usage.totalTokens, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cachedInputTokens: usage.cachedInputTokens, reasoningOutputTokens: usage.reasoningOutputTokens, contextTokens: usage.contextTokens, contextWindow: usage.contextWindow } : null}
      onRefresh={threadTarget ? refreshPrices : undefined} onCompact={busy ? noop : compact} />
  </>;
}

function HostTools({ device, name, target, context, onOpenThread, onTab, onClose }: { device: string; name: string; target: StudioTarget | null; context: HostContextResult | undefined; onOpenThread: (id: string) => void; onTab: (tab: StudioTab) => void; onClose: () => void }) {
  const [notice, setNotice] = useState("");
  const { data: workflows, reload: reloadWorkflows } = useHostData(target ? () => hostRead<WireResourceResult>(device, "workflows.view", { ...target }) : null, target ? panelKey(device, "workflows.view", target) : "tools:none");
  const { data: actions, reload: reloadActions } = useHostData(target ? () => hostRead<WireResourceResult>(device, "actions.list", { ...target }) : null, target ? panelKey(device, "actions.list", target) : "actions:none");
  const { data: inventory, reload: reloadInventory } = useHostData(target ? () => hostRead<WireResourceResult>(device, "tools.mcp.list", { ...target }) : null, target ? panelKey(device, "tools.mcp.list", target) : "mcp:none");
  const revision = context?.revision ?? "";
  const canRun = Boolean(context?.capabilities.terminal);
  const finish = (outcome: { ok: boolean; message: string }) => { setNotice(outcome.message); if (outcome.ok) reloadWorkflows(); };
  const scoped = target ? { ...target, revision } : null;
  const skills = context?.skills ?? [];
  // The same reviewed launch as the palette and composer: inputs first, then the host starts it.
  const projectList = useRemoteStore((state) => state.devices[device]?.workspaces);
  const projects = useMemo(() => projectList?.filter((entry) => !entry.isChat) ?? [], [projectList]);
  const { review, dialog } = useRemoteWorkflowLaunch({ device, name, workspaceId: target?.workspaceId, threadId: target?.threadId, revision, projects, onNotice: setNotice });
  return <>
    {dialog}
    <PanelHeader icon={Wrench} title="Tools & skills" subtitle={`Available on ${name}`} onClose={onClose} />
    <div className="studio-actions"><button onClick={() => { reloadWorkflows(); reloadActions(); reloadInventory(); if (target) void refreshRemoteContext(device, target.workspaceId, target.threadId); }}><RefreshCw size={13} /> Rescan</button></div>
    <Reason text={notice} />
    <h3 className="panel-label">Agent workflows</h3><div className="studio-list compact">{workflows?.workflows?.length ? workflows.workflows.map((workflow) => {
      const latest = workflow.runs[workflow.runs.length - 1];
      const running = latest?.status === "running";
      const asks = workflow.variables.some((variable) => variable.promptOnRun);
      return <div className="studio-list-row" key={workflow.id}><WorkflowIcon size={14} /><div><strong>{workflow.name}</strong><small>{workflow.steps.length} step{workflow.steps.length === 1 ? "" : "s"} · {latest?.status ?? "ready"}</small></div>
        {running ? <button className="danger-action" title="Stop workflow" aria-label={`Stop ${workflow.name}`} onClick={() => { if (scoped) void hostWrite(device, name, "workflows.stop", { ...scoped, workflowId: workflow.id, runId: latest.id }).then(finish); }}><CircleStop size={13} /></button>
          : <button title={asks ? "Review this workflow's inputs, then run it" : "Run workflow"} aria-label={`Run ${workflow.name}`} onClick={() => { void review(workflow.id).then((started) => { if (started) reloadWorkflows(); }); }}><Play size={13} /></button>}
        {latest?.threadId && <button title="Open workflow thread" aria-label={`Open ${workflow.name} thread`} onClick={() => onOpenThread(latest.threadId!)}><ChevronRight size={13} /></button>}</div>;
    }) : <span className="tool-empty-line">{target ? `No agent workflows on ${name}.` : `Choose a project on ${name}.`}</span>}</div>
    <h3 className="panel-label">Project actions</h3><div className="studio-list compact">{actions?.actions?.length ? actions.actions.map((action) => <div className="studio-list-row" key={action.id}><Play size={14} /><div><strong>{action.name}</strong><small>{action.command}</small></div>
      <button disabled={!canRun} title={canRun ? `Run ${action.name} on ${name}` : accessReason(name, "run actions", "Terminal") ?? undefined} aria-label={`Run ${action.name}`} onClick={() => {
        if (!scoped || !target) return;
        onTab("terminal");
        void hostWrite<{ processHandle?: string }>(device, name, "actions.run", { ...scoped, actionId: action.id }).then((outcome) => { setNotice(outcome.message); if (outcome.ok && outcome.result?.processHandle) expectRemoteRun(device, target.workspaceId, outcome.result.processHandle); });
      }}><Play size={13} /></button></div>)
      : <span className="tool-empty-line">{`No project actions on ${name}.`}</span>}</div>
    <h3 className="panel-label">Skills</h3><div className="studio-list compact">{skills.length ? skills.map((skill) => <div className={`studio-list-row ${skill.enabled === false ? "disabled-tool" : ""}`} key={skill.id}><Boxes size={14} /><div><strong>@{skill.name}</strong><small>{skill.description || "Reusable workflow"}</small></div></div>)
      : <Empty icon={Boxes} title="No skills" text={`${name} has no skills to show here.`} />}</div>
    <h3 className="panel-label">MCP servers</h3><div className="studio-list compact">{inventory?.tools?.length ? inventory.tools.map((server) => <div className="studio-list-row" key={server.name}><span className={`status-orb ${server.status}`} /><div><strong>{server.name}</strong><small>{mcpStatusLabel(server.status)} · {server.tools} tool{server.tools === 1 ? "" : "s"}</small></div></div>)
      : <span className="tool-empty-line">{inventory?.toolsAvailability === "ready" ? `No MCP servers on ${name}.` : `${name} shows these while this project is open there.`}</span>}</div>
  </>;
}

/** The real dock and panels, reading this machine's project through the host. */
export function RemoteStudio({ device, open, rootRef, onResizeStart, onResizeKeyDown, resizeValue, tab, gitRoute, onTab, onClose, onFork }: {
  device: string;
  open: boolean;
  rootRef?: Ref<HTMLElement>;
  onResizeStart?: (event: PointerEvent) => void;
  onResizeKeyDown?: (event: KeyboardEvent) => void;
  resizeValue?: number;
  tab: StudioTab;
  gitRoute: GitRoute | null;
  onTab: (tab: StudioTab) => void;
  onClose: () => void;
  onFork: () => void;
}) {
  // A new draft owns the panels too, as it does locally, not the thread it was opened from.
  const compose = useRemoteOutbox((state) => state.compose[device]);
  const selectedWorkspaceId = useRemoteStore((state) => state.devices[device]?.workspaceId ?? null);
  const selectedThreadId = useRemoteStore((state) => state.devices[device]?.threadId ?? undefined);
  const workspaceId = compose?.workspaceId ?? selectedWorkspaceId;
  const threadId = compose ? undefined : selectedThreadId;
  const workspaceName = useRemoteStore((state) => state.devices[device]?.workspaces.find((entry) => entry.id === workspaceId)?.name);
  const threadProvider = useRemoteStore((state) => state.devices[device]?.lists.get(workspaceId ?? "")?.threads.find((entry) => entry.id === threadId)?.provider);
  const threadTitle = useRemoteStore((state) => { const entry = state.devices[device]?.lists.get(workspaceId ?? "")?.threads.find((row) => row.id === threadId); return entry?.title || entry?.preview; });
  const threadBusy = useRemoteStore((state) => { const status = state.devices[device]?.timelines.get(threadId ?? "")?.status; return status === "running" || status === "starting"; });
  const name = useRemoteDevices((state) => state.snapshot?.devices.find((entry) => entry.fingerprint === device)?.name) ?? "the other device";
  const context = useRemoteContext((state) => workspaceId ? state.contexts[device]?.get(remoteContextKey(workspaceId, threadId)) ?? state.contexts[device]?.get(remoteContextKey(workspaceId)) : undefined);
  const target = useMemo<StudioTarget | null>(() => workspaceId ? { workspaceId, ...(threadId ? { threadId } : {}) } : null, [threadId, workspaceId]);
  const files = useMemo(() => target ? hostFiles(device, target) : null, [device, target]);
  // Open details belong to one thread, so a panel starts over when the thread changes.
  const targetKey = `${device}:${workspaceId ?? ""}:${threadId ?? ""}`;
  const [gitView, setGitView] = useState<GitView>("changes");
  // A half-written commit message outlives a trip to another tab, as it does locally.
  const [gitDrafts, setGitDrafts] = useState<Record<string, GitPanelDraft>>({});
  const saveGitDraft = useCallback((draft: GitPanelDraft) => setGitDrafts((current) => ({ ...current, [targetKey]: draft })), [targetKey]);
  useEffect(() => { if (gitRoute) setGitView(gitRoute.view); }, [gitRoute]);
  const capabilities = context?.capabilities;
  const revision = context?.revision ?? "";
  const empty = <Empty icon={FilePlus2} title="No project selected" text={`Choose a project on ${name}.`} />;
  return <StudioDockFrame open={open} rootRef={rootRef} onResizeStart={onResizeStart} onResizeKeyDown={onResizeKeyDown} resizeValue={resizeValue} tab={tab} onTab={onTab}>
    {tab === "files" && <>
      <PanelHeader icon={FilePlus2} title="Project files" subtitle={`Search and preview files on ${name}`} onClose={onClose} />
      {files ? <FileBrowser key={targetKey} root={`/${workspaceName ?? name}`} source={files} onAttach={(path) => { const fileId = files.fileId(path); if (fileId) machineActions()?.attachHostFile(fileId); }} /> : empty}
    </>}
    {!target && tab !== "files" && tab !== "usage" && tab !== "tools" && <><PanelHeader icon={FolderGit2} title="Thread tools" subtitle={name} onClose={onClose} />{empty}</>}
    {target && tab === "review" && <HostChanges key={targetKey} device={device} name={name} target={target} context={context} onOpenGit={() => { setGitView("changes"); onTab("git"); }} onClose={onClose} />}
    {target && tab === "terminal" && <HostTerminal key={`${device}:${target.workspaceId}`} device={device} name={name} target={target} allowed={Boolean(capabilities?.terminal)} policy={context?.processPolicy} onClose={onClose} />}
    {target && tab === "git" && <HostGit key={targetKey} device={device} name={name} target={target} revision={revision} allowed={Boolean(capabilities?.gitWrite && capabilities.terminal)} canWork={Boolean(capabilities)} threadBusy={threadBusy} draft={gitDrafts[targetKey]} onDraft={saveGitDraft} view={gitView} route={gitRoute} onView={setGitView} onTab={onTab} onClose={onClose} />}
    {target && tab === "checkpoints" && <HostCheckpoints key={targetKey} device={device} name={name} target={target} revision={revision} threadOpen={Boolean(threadId)} allowed={Boolean(capabilities?.checkpointRestore && capabilities.terminal)} onFork={onFork} onClose={onClose} />}
    {target && tab === "worktrees" && <HostWorktrees key={targetKey} device={device} name={name} target={target} revision={revision} allowed={Boolean(capabilities?.terminal)} onReview={() => onTab("review")} onFiles={() => onTab("files")} onClose={onClose} />}
    {target && tab === "agents" && <HostAgents key={targetKey} device={device} name={name} target={target} revision={revision} running={threadBusy} crew={context?.execution?.subagents?.crew ?? NO_CREW} onClose={onClose} />}
    {tab === "usage" && <HostUsage device={device} target={target} context={context} name={name} provider={threadProvider} title={threadTitle} busy={threadBusy} onClose={onClose} />}
    {tab === "tools" && <HostTools device={device} name={name} target={target} context={context} onOpenThread={(id) => selectRemoteThread(device, id)} onTab={onTab} onClose={onClose} />}
  </StudioDockFrame>;
}
