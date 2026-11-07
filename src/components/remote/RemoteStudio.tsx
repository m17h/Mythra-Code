import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent, type Ref } from "react";
import { CodeXml, FilePlus2, FolderGit2, Gauge, RefreshCw, SearchCode, ShieldCheck, TerminalSquare, Wrench } from "lucide-react";
import { DiffFileSections } from "../DiffView";
import { FileBrowser, type FileBrowserSource } from "../FileBrowser";
import { ChecksControl } from "../ChecksControl";
import type { GitPathAction } from "../GitChangesView";
import { GitPanel, type GitPanelAction } from "../GitPanel";
import { ThreadPullRequestPanel } from "../ThreadPullRequestPanel";
import { useSessionThreadPullRequest } from "../../hooks/useThreadPullRequest";
import { RemotePullRequestActivity } from "./RemotePullRequestActivity";
import { useRemoteCommand } from "./useRemoteCommand";
import { AgentsPanel, CheckpointsPanel, Empty, PanelHeader, StudioDockFrame, TerminalPanelHost, WorktreesPanel, type AgentRecord, type StudioTab } from "../StudioDock";
import { confirmDialog } from "../../lib/confirmDialog";
import type { CheckpointRecord, CheckpointRestoreTarget } from "../../lib/checkpoints";
import type { ProjectCheckResult } from "../../lib/projectChecks";
import { parseDiffSections } from "../../lib/gitDiff";
import type { GitChangeArea } from "../../lib/gitInspection";
import { joinPath } from "../../lib/paths";
import type { GitRoute, GitView, ProjectGitInspection, ProjectPullRequestAccess } from "../../lib/projectGit";
import { accessReason, hostProjectWrite, hostRead, hostWrite } from "../../lib/remote/remoteActions";
import { remoteTerminal, remoteTerminalKey, useRemoteTerminals } from "../../lib/remote/remoteTerminal";
import { cachedPanel, panelKey, rememberPanel } from "../../lib/remote/panelCache";
import { remotePullRequests } from "../../lib/remote/remotePullRequests";
import { remoteContextKey, runRemoteRowAction, useRemoteContext } from "../../lib/remote/remoteWork";
import { viewerRequest } from "../../lib/remote/viewerBridge";
import { useRemoteDevices } from "../../lib/remote/devices";
import { selectRemoteThread, useRemoteStore } from "../../lib/remote/remoteStore";
import type { AgentsListResult, CheckpointDiffResult, CheckpointListResult, FilePreviewResult, FilesListResult, GitDiffResult, GitLogResult, GitStatusResult, RevertPreviewResult, StudioTarget, WireGitHubAccess, WireCheckpoint, WireGitChange, WorktreeStatusResult } from "../../lib/remote/wire-studio";
import type { HostContextResult } from "../../lib/remote/wire";
import type { ThreadWorktreeRecord } from "../../lib/worktrees";

const MAX_LIST_PAGES = 5;
type HostGitAction = "init" | "stage" | "unstage" | "commit" | "push" | "pull" | "fetch" | "revert" | "revertAll";
const noop = () => undefined;

/** The host hands out opaque handles. The browser thinks in paths, so this
 * remembers which handle each shown path came from. */
function hostFiles(device: string, target: StudioTarget): FileBrowserSource {
  const handles = new Map<string, string>();
  return {
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

function HostChanges({ device, name, target, context, onClose }: { device: string; name: string; target: StudioTarget; context: HostContextResult | undefined; onClose: () => void }) {
  const connected = useRemoteDevices((state) => state.snapshot?.devices.find((entry) => entry.fingerprint === device)?.state === "connected");
  const { handle: checking, latest: lastCheck, set: setChecking } = useRemoteCommand(device, "checks.status", target, connected);
  // The host's last finished run, in the shape the real control shows.
  const checkResult = useMemo<ProjectCheckResult | null>(() => !lastCheck?.command || !lastCheck.updatedAt ? null : {
    id: lastCheck.id, projectId: target.workspaceId, threadId: target.threadId ?? null, cwd: "", command: lastCheck.command, head: null,
    startedAt: lastCheck.createdAt ?? lastCheck.updatedAt, finishedAt: lastCheck.updatedAt, exitCode: lastCheck.value ?? null, output: lastCheck.text ?? "", outputTruncated: false,
    status: lastCheck.status === "interrupted" ? "cancelled" : lastCheck.status === "completed" && !lastCheck.value ? "passed" : lastCheck.status === "uncertain" ? "error" : "failed",
  }, [lastCheck, target.threadId, target.workspaceId]);
  const [notice, setNotice] = useState("");
  const canCheck = Boolean(context?.capabilities.terminal);
  const checkRevision = { workspaceId: target.workspaceId, ...(target.threadId ? { threadId: target.threadId } : {}), revision: context?.revision ?? "" };
  const { data: status, failed, reload } = useHostData(() => viewerRequest<GitStatusResult>(device, "git.status", target), panelKey(device, "git.status", target));
  const [selected, setSelected] = useState<WireGitChange | null>(null);
  const [diff, setDiff] = useState("");
  const request = useRef(0);
  const open = (change: WireGitChange) => {
    setSelected(change);
    setDiff("");
    const current = ++request.current;
    viewerRequest<GitDiffResult>(device, "git.diff", { ...target, changeId: change.id })
      .then((result) => { if (current === request.current) setDiff(result.binary ? "This file is binary." : `${result.text}${result.truncated ? "\n… Diff shortened." : ""}`); })
      .catch(() => { if (current === request.current) setDiff(`Mythra Code couldn't read that change on ${name}. Try again.`); });
  };
  const sections = useMemo(() => parseDiffSections(diff), [diff]);
  return <>
    <PanelHeader icon={SearchCode} title="Review center" subtitle={`Inspect changes on ${name}`} onClose={onClose} />
    <div className="studio-actions wrap review-actions">
      <button onClick={reload}><RefreshCw size={13} /> Refresh</button>
      <ChecksControl command={context?.check?.command} running={Boolean(checking)} result={checkResult} onAddFeedback={() => { setNotice(`Feedback notes stay on the device they were written on, so these results can't be added on ${name}.`); return false; }}
        disabledReason={canCheck ? undefined : accessReason(name, "run checks", "Terminal")}
        onRun={() => { void hostWrite<{ processHandle?: string }>(device, name, "checks.start", checkRevision).then((outcome) => { setNotice(outcome.message); if (outcome.ok) setChecking(outcome.result?.processHandle ?? "running"); }); }}
        onStop={() => { if (checking) void hostWrite(device, name, "checks.stop", { ...checkRevision, processHandle: checking }).then((outcome) => { setNotice(outcome.message); if (outcome.ok) setChecking(null); }); }}
        onSave={(command) => { void hostProjectWrite(device, name, target.workspaceId, "projects.check.set", { command }).then((outcome) => setNotice(outcome.message)); }} />
    </div>
    <Reason text={notice} />
    <div className="diff-summary">
      <span><CodeXml size={13} /> Repository changes</span>
      <small>{status ? `${status.changedFiles} file${status.changedFiles === 1 ? "" : "s"} changed` : failed ? "Not available" : "Reading changes…"}</small>
    </div>
    {failed && <Reason text={`Mythra Code couldn't read changes on ${name}. Try again.`} />}
    <div className="studio-list">{(Array.isArray(status?.changes) ? status.changes : []).map((change) => <button key={change.id} className="studio-list-row remote-change-row" aria-pressed={selected?.id === change.id} onClick={() => open(change)}>
      <div><strong>{change.path}</strong><small>{change.status} · {change.area}</small></div>
    </button>)}</div>
    {sections.length ? <DiffFileSections sections={sections} readOnly readOnlyReason={`Use the Git tab to stage or revert files on ${name}.`} onPathAction={noop} />
      : diff && <pre className="diff-view">{diff}</pre>}
  </>;
}

function HostTerminal({ device, name, target, allowed, onClose }: { device: string; name: string; target: StudioTarget; allowed: boolean; onClose: () => void }) {
  const session = useMemo(() => remoteTerminal(device, target.workspaceId), [device, target.workspaceId]);
  const view = useRemoteTerminals((state) => state.views[remoteTerminalKey(device, target.workspaceId)]);
  const platform = useRemoteDevices((state) => state.snapshot?.devices.find((entry) => entry.fingerprint === device)?.platform);
  return <>
    <PanelHeader icon={TerminalSquare} title="Terminal" subtitle={`Runs on ${name}`} onClose={onClose} />
    <Reason text={!allowed ? accessReason(name, "run commands", "Terminal") : view?.notice ?? ""} />
    <TerminalPanelHost outputStore={session.store} scope={`${device}/${target.workspaceId}`} scopeLabel={name} shell={platform === "windows" ? "Command Prompt" : platform === "macos" ? "zsh" : "shell"} running={Boolean(view?.running || view?.opening)}
      runningCommand={view?.command ?? ""} runningElsewhere={[]} readOnly={!allowed}
      onRun={(command) => { void session.run(name, target.threadId, command); }}
      onStop={() => session.stop(name)}
      onClear={() => session.clear()}
      onInput={(data) => session.write(name, data)}
      onResize={(columns, rows) => session.resize(name, columns, rows)} />
  </>;
}

const NOT_HERE_YET = (what: string, name: string) => `${what} on ${name} isn't available from here yet.`;
/** Which of the host's listed changes a path action means. */
/** The host keeps a checkpoint's commits and folder. Their presence is all the panel needs. */
const HOST_ONLY = "host";
const checkpointRecord = ({ restorable, status, ...checkpoint }: WireCheckpoint): CheckpointRecord => ({ ...checkpoint, status: status as CheckpointRecord["status"],
  ...(restorable.before ? { workspacePath: HOST_ONLY, beforeCommit: HOST_ONLY } : {}), ...(restorable.after ? { afterCommit: HOST_ONLY } : {}) });
const CHANGE_AREAS: Record<GitPathAction, readonly GitChangeArea[]> = { stage: ["unstaged", "untracked"], unstage: ["staged"], revert: ["unstaged", "staged", "untracked"] };

function HostGit({ device, name, target, revision, allowed, view, route, onView, onTab, onClose }: {
  device: string; name: string; target: StudioTarget; revision: string; allowed: boolean; view: GitView; route: GitRoute | null;
  onView: (view: GitView) => void; onTab: (tab: StudioTab) => void; onClose: () => void;
}) {
  const [output, setOutput] = useState("");
  const [busy, setBusy] = useState(false);
  const changeIds = useRef(new Map<string, string>());
  const reason = accessReason(name, "change Git", "Git changes and Terminal");
  const inspection = useMemo<ProjectGitInspection>(() => ({
    cwd: `${device}/${target.workspaceId}/${target.threadId ?? ""}`,
    getChanges: async () => {
      const status = await viewerRequest<GitStatusResult>(device, "git.status", target);
      const changes = Array.isArray(status?.changes) ? status.changes : [];
      changeIds.current = new Map(changes.map((change) => [`${change.area}:${change.path}`, change.id]));
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
  }), [device, target]);
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
  const write = async (action: HostGitAction, extra: Record<string, unknown> = {}) => {
    if (!allowed) { setOutput(reason); return false; }
    setBusy(true);
    const outcome = await hostWrite<{ output?: string }>(device, name, "git.write", { ...target, revision, action, ...extra });
    setOutput(outcome.ok ? outcome.result?.output ?? "" : outcome.message);
    setBusy(false);
    return outcome.ok;
  };
  /** The host says what would change first, and the write answers that preview. */
  const revert = (action: "revert" | "revertAll", question: string, changeId?: string) => {
    if (!allowed) { setOutput(reason); return; }
    hostRead<RevertPreviewResult>(device, "git.revert.preview", { ...target, ...(changeId ? { changeId } : {}) }).then(async (preview) => {
      const kept = preview.preservedPaths.length ? `\n\n${preview.preservedPaths.length} staged ${preview.preservedPaths.length === 1 ? "file stays" : "files stay"} as ${preview.preservedPaths.length === 1 ? "it is" : "they are"}.` : "";
      if (await confirmDialog(`${question}\n\n${preview.restorePaths.length} ${preview.restorePaths.length === 1 ? "file goes" : "files go"} back to the last commit. This can't be undone.${kept}`)) void write(action, { resourceId: preview.previewId, confirmed: true });
    }, () => setOutput(`Mythra Code couldn't check that change on ${name}. Refresh and try again.`));
  };
  const pathAction = (action: GitPathAction, path: string) => {
    const resourceId = CHANGE_AREAS[action].map((area) => changeIds.current.get(`${area}:${path}`)).find(Boolean);
    if (!resourceId) { setOutput("That change is no longer available. Refresh and try again."); return; }
    if (action !== "revert") { void write(action, { resourceId }); return; }
    revert("revert", `Undo the changes to “${path}” on ${name}?`, resourceId);
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
      default: setOutput(NOT_HERE_YET("That", name));
    }
  };
  return <>
    <PanelHeader icon={FolderGit2} title="Git" subtitle={`Changes on ${name}`} onClose={onClose} />
    <GitPanel repositoryState={repository?.repository === false ? "absent" : "ready"} gitInitializing={busy} gitOutput={output} gitCommitSuccess="" gitCommitBusy={busy} githubAuthenticated={github?.authenticated === true}
      githubRepoStatus={github ? { isRepo: true, repository: github.repository, branch: github.branch, upstream: github.upstream, ahead: github.ahead, behind: github.behind } : null}
      hasPullRequestWorkflow pullRequests={projectAccess}
      pullRequestPanel={target.threadId && github?.repository && github.authenticated ? <>
        <ThreadPullRequestPanel {...threadPullRequest} onDetach={onDetach} threadId={`${device}/${target.threadId}`} isolated={github.isolated} mutationBlockedReason={blocked}
          onUpdateLocal={threadPullRequest.pullRequest?.state === "MERGED" ? () => updateLocal(threadPullRequest.pullRequest!.baseRefName) : undefined}
          onOpenWorktrees={() => onTab("worktrees")} onOpenGitHubSettings={signInHere} />
        {linked && pullRequest && <RemotePullRequestActivity pullRequests={pullRequests} pullRequest={pullRequest} allowed={allowed} reason={reason} name={name} />}
      </> : undefined}
      readOnly={!allowed} readOnlyReason={reason} gitOperationBusy={busy} defaultRepositoryName="" inspection={inspection} view={view} onViewChange={onView} focusRequest={route}
      onOpenTool={onTab} onPathAction={pathAction} onAction={panelAction}
      onInitializeGit={() => { void write("init").then((done) => { if (done) reloadRepository(); }); }} onGitHubAttach={signInHere} onGitHubCreate={signInHere} onOpenGitHubSettings={signInHere} />
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
      onFork={onFork}
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

function HostWorktrees({ device, name, target, revision, allowed, onReview, onClose }: { device: string; name: string; target: StudioTarget; revision: string; allowed: boolean; onReview: () => void; onClose: () => void }) {
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
    <WorktreesPanel worktree={worktree} worktreeStatus={data?.status ?? undefined} worktreeBusy={busy} gitActionsReadOnly={!allowed} revealLabel="Copy path" onClose={onClose}
      onWorktreeReview={onReview} onWorktreeApply={() => run("worktree.apply", `Copy this worktree's changes into the shared project on ${name}?`)} onWorktreeMerge={() => run("worktree.merge", `Merge this branch into the shared project on ${name}?`)}
      onWorktreeReveal={() => { if (worktree) void navigator.clipboard.writeText(worktree.path).catch(noop); }}
      onWorktreeRefresh={reload} onWorktreeRemove={() => remove(false)} onWorktreeRecreate={() => run("worktree.recreate", null)}
      onWorktreeContinueShared={() => run("worktree.continueShared", `Continue this conversation in the shared project on ${name}?\n\nThe worktree's folder and branch stay as they are.`)}
      onWorktreeReturnShared={() => remove(true)} />
  </>;
}

function HostAgents({ device, name, target, revision, onClose }: { device: string; name: string; target: StudioTarget; revision: string; onClose: () => void }) {
  const { data, failed, reload } = useHostData(target.threadId ? () => hostRead<AgentsListResult>(device, "agents.list", { ...target }) : null, panelKey(device, "agents.list", target));
  const [notice, setNotice] = useState("");
  return <>
    <Reason text={failed ? `Mythra Code couldn't read agent details on ${name}. Try again.` : notice} />
    <AgentsPanel agents={(Array.isArray(data?.agents) ? data.agents : []) as AgentRecord[]} onClose={onClose} onOpenAgent={(id) => selectRemoteThread(device, id)}
      onStopAgent={(id) => { void hostWrite(device, name, "agents.stop", { ...target, revision, agentId: id }).then((outcome) => { setNotice(outcome.message); if (outcome.ok) reload(); }); }} />
  </>;
}

function HostUsage({ device, target, context, name, provider, busy, onClose }: { device: string; target: StudioTarget | null; context: HostContextResult | undefined; name: string; provider?: string; busy: boolean; onClose: () => void }) {
  const [notice, setNotice] = useState("");
  const [compacting, setCompacting] = useState(false);
  // Claude and Cursor manage their own context, here as they do locally.
  const canCompact = Boolean(target?.threadId && context?.capabilities) && provider !== "claude" && provider !== "cursor";
  const compact = () => {
    if (!target) return;
    setCompacting(true);
    setNotice("");
    void hostWrite(device, name, "thread.compact", { ...target, revision: context?.revision ?? "" }).then((outcome) => { setCompacting(false); setNotice(outcome.message); });
  };
  return <>
    <PanelHeader icon={Gauge} title="Thread usage" subtitle={`As reported by ${name}`} onClose={onClose} />
    <Reason text={notice} />
    {context?.usage ? <div className="metric-grid">
      <div><strong>{context.usage.totalTokens.toLocaleString()}</strong><span>Total tokens</span></div>
      <div><strong>{context.usage.inputTokens.toLocaleString()}</strong><span>Input</span></div>
      <div><strong>{context.usage.outputTokens.toLocaleString()}</strong><span>Output</span></div>
      <div><strong>{context.usage.cachedInputTokens.toLocaleString()}</strong><span>Cached</span></div>
    </div> : <Empty icon={Gauge} title="No usage yet" text="Usage appears after a turn finishes." />}
    {canCompact && <div className="studio-actions wrap"><button type="button" disabled={busy || compacting} title="Summarize earlier turns to free up context" onClick={compact}>Compact context</button></div>}
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
  const workspaceId = useRemoteStore((state) => state.devices[device]?.workspaceId ?? null);
  const threadId = useRemoteStore((state) => state.devices[device]?.threadId ?? undefined);
  const workspaceName = useRemoteStore((state) => state.devices[device]?.workspaces.find((entry) => entry.id === workspaceId)?.name);
  const threadProvider = useRemoteStore((state) => state.devices[device]?.lists.get(workspaceId ?? "")?.threads.find((entry) => entry.id === threadId)?.provider);
  const threadBusy = useRemoteStore((state) => { const status = state.devices[device]?.timelines.get(threadId ?? "")?.status; return status === "running" || status === "starting"; });
  const name = useRemoteDevices((state) => state.snapshot?.devices.find((entry) => entry.fingerprint === device)?.name) ?? "the other device";
  const context = useRemoteContext((state) => workspaceId ? state.contexts[device]?.get(remoteContextKey(workspaceId, threadId)) ?? state.contexts[device]?.get(remoteContextKey(workspaceId)) : undefined);
  const target = useMemo<StudioTarget | null>(() => workspaceId ? { workspaceId, ...(threadId ? { threadId } : {}) } : null, [threadId, workspaceId]);
  const files = useMemo(() => target ? hostFiles(device, target) : null, [device, target]);
  // Open details belong to one thread, so a panel starts over when the thread changes.
  const targetKey = `${device}:${workspaceId ?? ""}:${threadId ?? ""}`;
  const [gitView, setGitView] = useState<GitView>("changes");
  useEffect(() => { if (gitRoute) setGitView(gitRoute.view); }, [gitRoute]);
  const capabilities = context?.capabilities;
  const revision = context?.revision ?? "";
  const empty = <Empty icon={FilePlus2} title="No project selected" text={`Choose a project on ${name}.`} />;
  return <StudioDockFrame open={open} rootRef={rootRef} onResizeStart={onResizeStart} onResizeKeyDown={onResizeKeyDown} resizeValue={resizeValue} tab={tab} onTab={onTab}>
    {tab === "files" && <>
      <PanelHeader icon={FilePlus2} title="Project files" subtitle={`Search and preview files on ${name}`} onClose={onClose} />
      {files ? <FileBrowser key={targetKey} root={`/${workspaceName ?? name}`} source={files} /> : empty}
    </>}
    {!target && tab !== "files" && tab !== "usage" && tab !== "tools" && <><PanelHeader icon={FolderGit2} title="Thread tools" subtitle={name} onClose={onClose} />{empty}</>}
    {target && tab === "review" && <HostChanges key={targetKey} device={device} name={name} target={target} context={context} onClose={onClose} />}
    {target && tab === "terminal" && <HostTerminal key={`${device}:${target.workspaceId}`} device={device} name={name} target={target} allowed={Boolean(capabilities?.terminal)} onClose={onClose} />}
    {target && tab === "git" && <HostGit key={targetKey} device={device} name={name} target={target} revision={revision} allowed={Boolean(capabilities?.gitWrite && capabilities.terminal)} view={gitView} route={gitRoute} onView={setGitView} onTab={onTab} onClose={onClose} />}
    {target && tab === "checkpoints" && <HostCheckpoints key={targetKey} device={device} name={name} target={target} revision={revision} threadOpen={Boolean(threadId)} allowed={Boolean(capabilities?.checkpointRestore && capabilities.terminal)} onFork={onFork} onClose={onClose} />}
    {target && tab === "worktrees" && <HostWorktrees key={targetKey} device={device} name={name} target={target} revision={revision} allowed={Boolean(capabilities?.terminal)} onReview={() => onTab("review")} onClose={onClose} />}
    {target && tab === "agents" && <HostAgents key={targetKey} device={device} name={name} target={target} revision={revision} onClose={onClose} />}
    {tab === "usage" && <HostUsage device={device} target={target} context={context} name={name} provider={threadProvider} busy={threadBusy} onClose={onClose} />}
    {tab === "tools" && <>
      <PanelHeader icon={Wrench} title="Tools & skills" subtitle={`Available on ${name}`} onClose={onClose} />
      <div className="studio-list">{context?.skills.map((skill) => <div className="studio-list-row" key={skill.id}>
        <div><strong>{skill.name}</strong><small>{skill.description}</small></div>
      </div>)}</div>
      {!context?.skills.length && <Empty icon={Wrench} title="No skills" text={`${name} has no skills to show here.`} />}
    </>}
  </StudioDockFrame>;
}
