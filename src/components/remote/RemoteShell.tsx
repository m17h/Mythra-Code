import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { isPermissionGranted, sendNotification } from "@tauri-apps/plugin-notification";
import { Archive, ArchiveRestore, Check, ChevronDown, Circle, Copy, Download, Folder, Gauge, GitBranch, GitFork, LoaderCircle, MessageSquare, PanelLeftOpen, Paperclip, Pencil, Pin, PinOff, Settings, Trash2, X } from "lucide-react";
import type { Activity, ChatFont, ChatMessage, Provider } from "../../types";
import { TimelinePresentation } from "../ChatTimeline";
import { AnimatedMythraLogo } from "../AnimatedMythraLogo";
import { ConversationSearchBar } from "../ConversationSearchBar";
import { ProjectPromptControl } from "../ProjectPromptControl";
import { ProjectRunControl } from "../ProjectRunControl";
import { SubAgentParentGroup } from "../SubAgentParentGroup";
import { Composer } from "../Composer";
import { ErrorBoundary } from "../ErrorBoundary";
import { PinnedWorkspaceGroup } from "../PinnedWorkspaceGroup";
import { RowMenu } from "../RowMenu";
import { ChatsRow, ThreadRenameInput, ThreadSearch, ThreadsSection, WorkspaceRow, WorkspacesSection } from "../SidebarLists";
import type { AttachmentRecord, StudioTab } from "../StudioDock";
import { ThreadInboxCard, type ThreadCardPresence } from "../ThreadInboxCard";
import type { TimelineEnvironment } from "../TimelineEnvironment";
import type { VoiceInputConfig } from "../../hooks/useVoiceInput";
import { providerDisplayName } from "../../lib/childAgents";
import { confirmDialog } from "../../lib/confirmDialog";
import { exportTextFile } from "../../lib/codex";
import { startProjectPointerDrag, type ProjectDropTarget } from "../../lib/projectPointerDrag";
import { accessReason, hostRead, hostRows, hostWrite, readDroppedFile, uploadToHost } from "../../lib/remote/remoteActions";
import { machineActions, noteNotificationTarget, setMachineActions, useActiveMachine } from "../../lib/remote/activeMachine";
import { isPublicWebLink } from "../../lib/remote/links";
import { newThreadDraftKey, newThreadTargetFor, removeOutboxEntry, setNewThreadTarget, threadDraftKey, useRemoteOutbox, type OutboxEntry } from "../../lib/remote/outbox";
import {
  clearRemoteCapabilities, reconcileRemoteOutbox, refreshRemoteCapabilities, refreshRemoteContext, remoteContextKey, retryRemotePrompt,
  runRemoteRowAction, searchRemoteFiles, sendRemotePrompt, setRemoteThreadSettings, stopRemoteTurn, UNCONFIRMED_TEXT,
  useRemoteContext, useRemoteWork, type RemoteSendOutcome,
} from "../../lib/remote/remoteWork";
import { deviceHelp, useRemoteDevices, startRemoteDevices } from "../../lib/remote/devices";
import {
  useRemoteStore, mountRemoteDevice, selectRemoteWorkspace, selectRemoteThread,
  loadRemoteThreads, loadRemoteEarlier, refreshRemoteDevice, type RemoteTimeline, type ViewState,
} from "../../lib/remote/remoteStore";
import type { HostContextResult, RemoteRowOperation, WireApproval, WireExecutionSettings, WireMessage, WireActivity, WireParityReadResult, WireThread, WireWorkspace } from "../../lib/remote/wire";
import type { SubAgentParentState } from "../../lib/subAgentParents";
import type { QueuedTurn } from "../../lib/taskStore";
import type { WorkflowDefinition } from "../../lib/workflows";
import type { ThreadHistoryState } from "../../lib/threadHistory";
import { RemoteFolderBrowser } from "./RemoteFolderBrowser";
import { RemoteProjectEditor } from "./RemoteProjectEditor";
import { RemoteComposerControls } from "./RemoteComposerControls";
import { RemoteImage } from "./RemoteImage";
import { RemoteModelControls } from "./RemoteModelControls";
import { RemoteMessageQuestions, RemoteRequests, RemoteThreadContext, type RemoteThreadScope } from "./RemoteRequests";
export { RemoteStudio } from "./RemoteStudio";
import "./RemoteShell.css";

// Weak identity caches preserve memoized local row behavior without ever putting
// host content into the task store or retaining a second durable transcript.
const messages = new WeakMap<WireMessage, ChatMessage>();
const activities = new WeakMap<WireActivity, Activity>();
const sourceMessages = new WeakMap<ChatMessage, WireMessage>();
function messageForTimeline(source: WireMessage): ChatMessage {
  const cached = messages.get(source);
  if (cached) return cached;
  const result: ChatMessage = {
    id: source.id, role: source.role, text: source.text, timelineOrder: source.order,
    ...(source.turnId === null ? {} : { turnId: source.turnId }),
    streaming: source.streaming, ...(source.turnStatus === null ? {} : { turnStatus: source.turnStatus }),
    ...(source.phase === undefined ? {} : { phase: source.phase }),
    ...(source.provenance === undefined ? {} : { provenance: source.provenance }),
    ...(source.steerStatus === undefined ? {} : { steerStatus: source.steerStatus }),
    ...(source.turnDurationMs === undefined ? {} : { turnDurationMs: source.turnDurationMs }),
    ...(source.questions === undefined ? {} : { questions: source.questions.map((question) => ({
      id: question.id, title: question.title, secret: question.secret, options: question.options,
    })) }),
  };
  // No attachment path, skill path, provider request identity or raw approval
  // object can enter the presentation model, even from a malformed host.
  messages.set(source, result); sourceMessages.set(result, source);
  return result;
}
function activityForTimeline(source: WireActivity): Activity {
  const cached = activities.get(source);
  if (cached) return cached;
  const result: Activity = {
    id: source.id, kind: source.kind, title: source.title, timelineOrder: source.order,
    detail: source.truncated ? `${source.detail ?? ""}\n[Activity shortened on the host.]` : source.detail,
    ...(source.status === null ? {} : { status: source.status }),
    ...(source.turnId === null ? {} : { turnId: source.turnId }),
    ...(source.turnStatus === null ? {} : { turnStatus: source.turnStatus }),
    workType: source.workType, turnDurationMs: source.turnDurationMs, itemCount: source.itemCount,
    ...(source.agent ? { agent: { action: source.agent.action, provider: source.agent.provider, model: source.agent.model, count: source.agent.count } } : {}),
  };
  activities.set(source, result); return result;
}
const NO_MESSAGES: ChatMessage[] = [];
const NO_ACTIVITIES: Activity[] = [];
const NO_APPROVALS: WireApproval[] = [];
const NO_THREADS: WireThread[] = [];
const NO_MATCHES: readonly { id: string }[] = [];
const NO_AGENTS: Readonly<Record<string, { status?: string }>> = {};
const NO_ATTACHMENTS: AttachmentRecord[] = [];
const NO_QUEUE: QueuedTurn[] = [];
const LINK_DOWN = new Set(["stale", "offline", "unreachable", "incompatible", "connecting"]);
const WORK_SWITCH = (name: string) => `On ${name}, turn on Work for this device in Settings → Connections → Devices.`;

function connectionLabel(state: ViewState, name: string): string | null {
  if (state === "recovering") return `${name} is recovering its live thread state. This view may be out of date.`;
  if (state === "stale") return `Connection lost. This conversation may be out of date. Work already started on ${name} may still be running.`;
  if (state === "removed") return `Access to this thread on ${name} is unavailable. Check access on that device before trying again.`;
  return null;
}
/** Reads as the device's name for as long as this window remembers one. */
function useMachineName(device: string): string {
  const paired = useRemoteDevices((state) => state.snapshot?.devices.find((entry) => entry.fingerprint === device)?.name);
  const remembered = useActiveMachine((state) => state.name);
  return paired ?? remembered ?? "Remote device";
}
function useHostContext(device: string, workspaceId: string | null | undefined, threadId: string | undefined): HostContextResult | undefined {
  return useRemoteContext((state) => workspaceId ? state.contexts[device]?.get(remoteContextKey(workspaceId, threadId))
    ?? state.contexts[device]?.get(remoteContextKey(workspaceId)) : undefined);
}

/** A prompt the host hasn't confirmed yet. It shows at once, as the user's own
 * message, with what is known about it underneath. */
function outboxStatus(entry: OutboxEntry, name: string): string {
  return entry.state === "sending" ? `Sending to ${name}…`
    : entry.state === "awaiting" ? `Waiting for ${name} to confirm it received this.`
    : entry.state === "retry" ? `${name} never received this.`
    : entry.state === "uncertain" ? UNCONFIRMED_TEXT
    : entry.error ?? `${name} didn't accept this.`;
}
function OutboxMessage({ entry, name }: { entry: OutboxEntry; name: string }) {
  const [retrying, setRetrying] = useState(false);
  const [copied, setCopied] = useState(false);
  const status = outboxStatus(entry, name);
  const settled = entry.state === "retry" || entry.state === "uncertain" || entry.state === "rejected";
  return <div className="remote-outbox-state" role="status">
    <span>{status}</span>
    {settled && <span className="remote-row-actions">
      {entry.state === "retry" && <button type="button" disabled={retrying} onClick={() => {
        setRetrying(true);
        void retryRemotePrompt(entry, name).finally(() => setRetrying(false));
      }}>Try again</button>}
      <button type="button" onClick={() => {
        void navigator.clipboard.writeText(entry.text).then(() => setCopied(true)).catch(() => undefined);
      }}>{copied ? "Copied" : "Copy text"}</button>
      <button type="button" onClick={() => removeOutboxEntry(entry.opId)}>Dismiss</button>
    </span>}
  </div>;
}
/** What a new or open thread can change. A started thread keeps its worktree choice. */
type RemoteSettingsChange = WireExecutionSettings;

const pendingEntries = new WeakMap<ChatMessage, OutboxEntry>();
const pendingByEntry = new WeakMap<OutboxEntry, ChatMessage>();
function messageForEntry(entry: OutboxEntry): ChatMessage {
  const cached = pendingByEntry.get(entry);
  if (cached) return cached;
  const result: ChatMessage = { id: `outbox:${entry.opId}`, role: "user", text: entry.text, streaming: false, timelineOrder: Number.MAX_SAFE_INTEGER };
  pendingByEntry.set(entry, result); pendingEntries.set(result, entry);
  return result;
}
const RemoteMachineName = createContext("Remote device");
function RemoteQuestions({ message }: { message: ChatMessage }) {
  const questions = sourceMessages.get(message)?.questions;
  return questions?.length ? <RemoteMessageQuestions message={message} questions={questions} /> : null;
}
/** Images show as they do here. Other files stay on the host, so they're named. */
function RemoteAttachments({ source }: { source: WireMessage }) {
  const scope = useContext(RemoteThreadContext);
  const names = source.attachmentNames ?? [];
  const images = scope?.workspaceId ? (source.attachmentImages ?? []).filter((index) => index < names.length) : [];
  const others = names.filter((_, index) => !images.includes(index));
  return <>
    {scope?.workspaceId && images.length > 0 && <div className="message-image-previews" aria-label="Attached images">{images.map((index) => <RemoteImage key={index} name={names[index]}
      image={{ device: scope.device, workspaceId: scope.workspaceId!, threadId: scope.threadId, messageId: source.id, index }} />)}</div>}
    {others.length > 0 && <p className="remote-note">Attachments on the host: {others.join(", ")}.</p>}
  </>;
}
function RemoteMessageExtras({ message }: { message: ChatMessage }) {
  const source = sourceMessages.get(message);
  const pending = pendingEntries.get(message);
  const name = useContext(RemoteMachineName);
  return <>{pending && <OutboxMessage entry={pending} name={name} />}
    {source?.attachmentNames?.length ? <RemoteAttachments source={source} /> : null}
    {source?.truncated && <p role="note">This message was shortened on the host.</p>}</>;
}
const REMOTE_ENVIRONMENT: TimelineEnvironment = Object.freeze({
  Questions: RemoteQuestions, MessageExtras: RemoteMessageExtras, queuedSteerLabel: "Queued on the host",
  openExternalUrl: (url: string) => isPublicWebLink(url) ? openUrl(url) : Promise.resolve(),
  canOpenLink: isPublicWebLink,
});

const parentState = (thread: WireThread): SubAgentParentState => thread.archived ? "archived" : "available";
function threadPresence(thread: WireThread, timeline: RemoteTimeline | undefined): ThreadCardPresence {
  const status = timeline?.status ?? thread.status;
  return { status: status === "completed" || status === "interrupted" ? "idle" : status,
    ...(timeline?.workingStartedAt ? { startedAt: timeline.workingStartedAt } : {}), approvals: timeline?.approvals.length ?? 0,
    unread: Boolean(thread.unread) };
}

function RemoteThreadRow({ device, name, thread, workspaceName, timeline, selected, active, scale, canWork, onOpen, onError, onCopyPath }: {
  device: string; name: string; thread: WireThread; workspaceName: string; timeline: RemoteTimeline | undefined;
  selected: boolean; active: boolean; scale: number; canWork: boolean;
  onOpen: () => void; onError: (message: string) => void; onCopyPath: () => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const title = thread.title || thread.preview || "Untitled thread";
  const run = (op: RemoteRowOperation, args: object = {}) => {
    void runRemoteRowAction(device, name, op, { threadId: thread.id, ...args }).then((failure) => {
      if (failure) onError(failure); else refreshRemoteDevice(device);
    });
  };
  const blocked = canWork ? undefined : WORK_SWITCH(name);
  return <div className={`thread-row-wrap ${selected ? "active" : ""}`}>
    {renaming ? <div className="thread-rename-row">
      <MessageSquare size={14} />
      <ThreadRenameInput initial={title} onCancel={() => setRenaming(false)} onCommit={(next) => { setRenaming(false); run("thread.rename", { name: next }); }} />
    </div> : <ThreadInboxCard active={active} threadId={thread.id} title={title} workspaceName={workspaceName} directory={workspaceName}
      provider={thread.provider} providerName={providerDisplayName(thread.provider)} pinned={Boolean(thread.pinned)}
      presence={threadPresence(thread, timeline)} onOpen={onOpen} />}
    <RowMenu label={`Options for ${title}`} scale={scale} items={() => [
      { label: thread.pinned ? "Unpin" : "Pin", icon: thread.pinned ? <PinOff size={13} /> : <Pin size={13} />, disabledReason: blocked, onSelect: () => run("thread.pin", { pinned: !thread.pinned }) },
      { label: "Rename", icon: <Pencil size={13} />, disabledReason: blocked, onSelect: () => setRenaming(true) },
      { label: "Copy path", icon: <Copy size={13} />, onSelect: () => onCopyPath() },
      { label: "Fork", icon: <GitFork size={13} />, disabledReason: blocked, onSelect: () => run("thread.fork") },
      { label: "Archive", icon: <Archive size={13} />, disabledReason: blocked, onSelect: () => run("thread.archive") },
      { label: "Delete forever", icon: <Trash2 size={13} />, danger: true, disabledReason: blocked, onSelect: () => {
        void confirmDialog(`Delete “${title}” from ${name}?\n\nThis can't be undone.`).then((confirmed) => { if (confirmed) run("thread.delete", { confirmed: true }); });
      } },
    ]} />
  </div>;
}

/** The sidebar's lists, filled with this machine's projects and threads. */
export function RemoteSidebar({ device, splitter, scale, active }: { device: string; splitter: ReactNode; scale: number; active: boolean }) {
  const remote = useRemoteStore((state) => state.devices[device]);
  const name = useMachineName(device);
  const composing = useRemoteOutbox((state) => Boolean(state.compose[device]));
  const leaving = useActiveMachine((state) => state.machine !== device);
  const canWork = useRemoteWork((state) => state.capabilities[device] !== null);
  const [query, setQuery] = useState("");
  const [browsing, setBrowsing] = useState(false);
  const [error, setError] = useState("");
  const workspace = remote?.workspaces.find((entry) => entry.id === remote.workspaceId);
  const list = remote?.lists.get(remote.workspaceId ?? "");
  const threads = list?.threads ?? NO_THREADS;
  const [kind, setKind] = useState<"main" | "subagents">("main");
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [dragged, setDragged] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<ProjectDropTarget | null>(null);
  const suppressClick = useRef(false);
  const [contentMatches, setContentMatches] = useState<readonly { id: string; name?: string; description?: string }[]>(NO_MATCHES);
  const live = useMemo(() => threads.filter((thread) => !thread.archived), [threads]);
  const archived = useMemo(() => threads.filter((thread) => thread.archived && Boolean(thread.child) === (kind === "subagents")), [kind, threads]);
  const subAgentCount = useMemo(() => live.filter((thread) => thread.child).length, [live]);
  const shown = useMemo(() => {
    const words = query.trim().toLowerCase();
    const ofKind = live.filter((thread) => Boolean(thread.child) === (kind === "subagents"));
    const matches = words ? ofKind.filter((thread) => `${thread.title} ${thread.preview}`.toLowerCase().includes(words)) : ofKind;
    return [...matches.filter((thread) => thread.pinned), ...matches.filter((thread) => !thread.pinned)];
  }, [kind, live, query]);
  const chats = remote?.workspaces.find((entry) => entry.isChat);
  const projects = remote?.workspaces.filter((entry) => !entry.isChat) ?? [];
  const context = useHostContext(device, remote?.workspaceId, undefined);
  const addAllowed = Boolean(context?.capabilities.manageProjects);
  const revision = context?.revision ?? "";
  // Names and previews filter at once; the host searches conversation content.
  useEffect(() => {
    const words = query.trim();
    setContentMatches(NO_MATCHES);
    const workspaceId = remote?.workspaceId;
    if (words.length < 2 || !workspaceId) return;
    let current = true;
    const timer = setTimeout(() => {
      hostRead<WireParityReadResult>(device, "threads.search", { workspaceId, query: words }).then((result) => {
        if (current) setContentMatches(hostRows(result));
      }, () => undefined);
    }, 300);
    return () => { current = false; clearTimeout(timer); };
  }, [device, query, remote?.workspaceId]);
  const copyProjectPath = (workspaceId: string) => {
    hostRead<WireParityReadResult>(device, "projects.settings.read", { workspaceId }).then((result) => {
      const path = hostRows(result)[0]?.description;
      if (path) void navigator.clipboard.writeText(path).catch(() => undefined);
      else setError(`${name} didn't share this path.`);
    }, () => setError(`Mythra Code couldn't read this path on ${name}.`));
  };
  const parents = useMemo(() => {
    const groups = new Map<string, WireThread[]>();
    for (const thread of shown) if (kind === "subagents") groups.set(thread.parentThreadId ?? "", [...(groups.get(thread.parentThreadId ?? "") ?? []), thread]);
    return groups;
  }, [kind, shown]);
  const archiveAll = () => {
    const ids = shown.map((thread) => thread.id);
    if (!ids.length || !remote?.workspaceId) return;
    const workspaceId = remote.workspaceId;
    void confirmDialog(`Archive ${ids.length} ${kind === "subagents" ? "sub-agent" : "main"} thread${ids.length === 1 ? "" : "s"} on ${name}?\n\nYou can restore them from Archived.`).then((confirmed) => {
      if (!confirmed) return;
      void hostWrite(device, name, "thread.archiveMany", { workspaceId, revision, threadIds: ids }).then((outcome) => { if (outcome.ok) refreshRemoteDevice(device); else setError(outcome.message); });
    });
  };
  const deleteAllArchived = () => {
    const ids = archived.map((thread) => thread.id);
    if (!ids.length || !remote?.workspaceId) return;
    const workspaceId = remote.workspaceId;
    void confirmDialog(`Permanently delete all ${ids.length} archived threads on ${name}?\n\nThis can't be undone.`).then((confirmed) => {
      if (!confirmed) return;
      void hostWrite(device, name, "thread.deleteMany", { workspaceId, revision, threadIds: ids, confirmed: true }).then((outcome) => { if (outcome.ok) refreshRemoteDevice(device); else setError(outcome.message); });
    });
  };
  const manageReason = addAllowed ? undefined : `On ${name}, turn on Work with all projects and Manage projects for this device in Settings → Connections → Devices.`;
  const pinProject = (id: string, pinned: boolean) => {
    void runRemoteRowAction(device, name, "projects.pin", { workspaceId: id, pinned }).then((failure) => {
      if (failure) setError(failure); else refreshRemoteDevice(device);
    });
  };
  const runArchived = (op: RemoteRowOperation, threadId: string) => {
    void runRemoteRowAction(device, name, op, { threadId }).then((failure) => {
      if (failure) setError(failure); else refreshRemoteDevice(device);
    });
  };
  const projectRow = (project: WireWorkspace) => <WorkspaceRow key={project.id} name={project.name} title={`${project.name} on ${name}`} label={project.name} pinned={project.pinned} scale={scale}
    className={[remote?.workspaceId === project.id ? "active" : "", dragged === project.id ? "dragging" : "", dropTarget?.id === project.id ? `drop-${dropTarget.position}` : ""].filter(Boolean).join(" ")}
    wrapProps={{
      "data-project-id": project.id, "data-project-pinned": project.pinned ? "true" : "false",
      onPointerDown: (event) => {
        if (!canWork) return;
        startProjectPointerDrag(event, project.id, {
          isPinned: (id) => Boolean(remote?.workspaces.find((entry) => entry.id === id)?.pinned),
          setDragged, setTarget: setDropTarget,
          onDrop: (target) => {
            suppressClick.current = true;
            setTimeout(() => { suppressClick.current = false; }, 0);
            void runRemoteRowAction(device, name, "projects.reorder", { workspaceId: project.id, relativeTo: target.id, position: target.position }).then((failure) => {
              if (failure) setError(failure); else refreshRemoteDevice(device);
            });
          },
        });
      },
    }}
    onOpen={(event) => {
      if (suppressClick.current) { event.preventDefault(); return; }
      setNewThreadTarget(device, undefined);
      selectRemoteWorkspace(device, project.id);
    }}
    menu={[
      { label: project.pinned ? "Unpin project" : "Pin project", icon: project.pinned ? <PinOff size={13} /> : <Pin size={13} />, disabledReason: canWork ? undefined : WORK_SWITCH(name), onSelect: () => pinProject(project.id, !project.pinned) },
      { label: "Project settings", icon: <Settings size={13} />, onSelect: () => { selectRemoteWorkspace(device, project.id); setEditing(project.id); } },
      { label: "Copy path", icon: <Copy size={13} />, onSelect: () => copyProjectPath(project.id) },
      { label: "Remove from Mythra Code", icon: <Trash2 size={13} />, danger: true, disabledReason: manageReason, onSelect: () => removeProject(project.id, project.name) },
    ]} />;
  const pinnedProjects = projects.filter((entry) => entry.pinned);
  const removeProject = (id: string, projectName: string) => {
    void confirmDialog(`Remove “${projectName}” from Mythra Code on ${name}?\n\nIts folder and every file inside it will remain untouched on that device.`).then((confirmed) => {
      if (!confirmed) return;
      void runRemoteRowAction(device, name, "projects.remove", { workspaceId: id, confirmed: true }).then((failure) => {
        if (failure) setError(failure); else refreshRemoteDevice(device);
      });
    });
  };
  const threadRow = (thread: WireThread) => <RemoteThreadRow key={thread.id} device={device} name={name} thread={thread} workspaceName={workspace?.name ?? name}
    timeline={remote?.timelines.get(thread.id)} selected={!composing && remote?.threadId === thread.id} active={active} scale={scale} canWork={canWork}
    onError={setError} onCopyPath={() => { if (remote?.workspaceId) copyProjectPath(remote.workspaceId); }}
    onOpen={() => { setNewThreadTarget(device, undefined); selectRemoteThread(device, thread.id); }} />;
  return <div className="sidebar-machine-lists" inert={leaving || undefined} aria-label={`Workspaces and threads on ${name}`} role="group">
    <WorkspacesSection onAdd={() => setBrowsing(true)} addDisabled={!addAllowed}
      addTitle={addAllowed ? `Add a project on ${name}` : `On ${name}, turn on Work with all projects and Manage projects for this device in Settings → Connections → Devices.`}>
      {chats && <ChatsRow active={remote?.workspaceId === chats.id} onOpen={() => { setNewThreadTarget(device, undefined); selectRemoteWorkspace(device, chats.id); }} label="Chats" />}
      {pinnedProjects.length > 0 && <PinnedWorkspaceGroup count={pinnedProjects.length} containsActiveWorkspace={pinnedProjects.some((project) => project.id === remote?.workspaceId)}>
        {pinnedProjects.map(projectRow)}
      </PinnedWorkspaceGroup>}
      {projects.filter((entry) => !entry.pinned).map(projectRow)}
      {!remote?.workspaces.length && <p className="empty-threads" role="status">{remote?.loading ? "" : `Nothing is shared from ${name}.`}</p>}
    </WorkspacesSection>
    {splitter}
    <ThreadsSection
      kindSwitch={workspace && <div className="thread-kind-switch" role="group" aria-label="Thread type">
        <button className={kind === "main" ? "active" : ""} onClick={() => setKind("main")} aria-pressed={kind === "main"}>Main <span>{live.length - subAgentCount}</span></button>
        <button className={kind === "subagents" ? "active" : ""} onClick={() => setKind("subagents")} aria-pressed={kind === "subagents"}>Sub-agents <span>{subAgentCount}</span></button>
      </div>}
      search={workspace && <ThreadSearch value={query} onChange={setQuery} placeholder={`Search ${workspace.isChat ? "chats" : workspace.name}…`}
        action={<button className="thread-bulk-button" onClick={archiveAll} disabled={shown.length === 0 || !canWork} title={canWork ? `Archive all ${kind === "subagents" ? "sub-agent" : "main"} threads here` : WORK_SWITCH(name)}>
          <Archive size={12} /><span>Archive all</span>
        </button>} />}
      list={<>
        {kind === "main" ? shown.map(threadRow) : [...parents].map(([parentId, children]) => {
          const parent = threads.find((thread) => thread.id === parentId);
          return <SubAgentParentGroup key={parentId || "parent-unknown"} title={parent?.title || "Unavailable parent"} provider={parent?.provider}
            providerName={parent ? providerDisplayName(parent.provider) : undefined} state={parent ? parentState(parent) : "unavailable"} reported={Boolean(parentId)} shortId={parentId.slice(0, 8)}
            count={children.length} threadIds={children.map((thread) => thread.id)} nativeAgents={NO_AGENTS}
            onOpenParent={parent ? () => selectRemoteThread(device, parent.id) : undefined}>{children.map(threadRow)}</SubAgentParentGroup>;
        })}
        {contentMatches.filter((match) => !shown.some((thread) => thread.id === match.id)).map((match) => <div key={match.id} className="thread-row-wrap">
          <button className="thread-card" onClick={() => { setNewThreadTarget(device, undefined); selectRemoteThread(device, match.id); }} aria-label={`Open ${match.name ?? "conversation"}`}>
            <span className="thread-card-context"><span className="thread-card-workspace"><MessageSquare size={14} /><span>Match in conversation</span></span></span>
            <span className="thread-card-title">{match.name ?? "Untitled thread"}</span>
          </button>
        </div>)}
        {error && <div className="empty-threads" role="alert">{error}</div>}
        {!shown.length && !list?.loading && workspace && <div className="empty-threads">{query ? "No matching conversations." : kind === "subagents" ? "No sub-agent threads yet" : workspace.isChat ? "No normal chats yet" : "No threads in this project yet"}</div>}
        {list?.cursor && <button type="button" className="thread-bulk-button" disabled={list.loading} onClick={() => loadRemoteThreads(device)}>More threads</button>}
      </>}
      footer={archived.length > 0 && <div className="archived-threads">
        <div className="archived-header">
          <button className="archived-toggle" onClick={() => setArchivedOpen((open) => !open)} aria-expanded={archivedOpen}>
            <Archive size={12} />
            <span>Archived</span>
            <span className="thread-count">{archived.length}</span>
            <ChevronDown className={archivedOpen ? "open" : ""} size={12} />
          </button>
          <button className="archived-delete-all" onClick={deleteAllArchived} disabled={!canWork} title={canWork ? `Permanently delete all archived threads on ${name}` : WORK_SWITCH(name)}>
            <Trash2 size={11} /><span>Delete all</span>
          </button>
        </div>
        {archivedOpen && archived.map((thread) => <div key={thread.id} className="thread-row-wrap archived">
          <span className="thread-row archived-label" role="group">
            <Archive size={13} />
            <span className="archived-thread-title">{thread.title || thread.preview || "Untitled thread"}</span>
          </span>
          <RowMenu label={`Options for archived ${thread.title}`} scale={scale} items={[
            { label: "Restore", icon: <ArchiveRestore size={13} />, disabledReason: canWork ? undefined : WORK_SWITCH(name), onSelect: () => runArchived("thread.restore", thread.id) },
            { label: "Delete forever", icon: <Trash2 size={13} />, danger: true, disabledReason: canWork ? undefined : WORK_SWITCH(name), onSelect: () => {
              void confirmDialog(`Delete “${thread.title || "this thread"}” from ${name}?\n\nThis can't be undone.`).then((confirmed) => { if (confirmed) runArchived("thread.delete", thread.id); });
            } },
          ]} />
        </div>)}
      </div>}
    />
    {editing && <RemoteProjectEditor device={device} name={name} workspaceId={editing} projectName={projects.find((entry) => entry.id === editing)?.name ?? name} context={context}
      onClose={() => setEditing(null)} onSaved={() => { setEditing(null); refreshRemoteDevice(device); void refreshRemoteContext(device, editing); }} />}
    {browsing && <RemoteFolderBrowser device={device} name={name} onClose={() => setBrowsing(false)} onAdded={() => { setBrowsing(false); refreshRemoteDevice(device); }} />}
  </div>;
}

/** Sits over the local main pane, which stays mounted and laid out underneath. */
export function RemoteConversation({ device, leaving, sidebarOpen, chatFont, voiceInput, actions, studioToggle, onShowSidebar, onManageDevices, onOpenTool }: {
  device: string;
  /** The user has already chosen another machine and this is on its way out. */
  leaving: boolean;
  sidebarOpen: boolean;
  chatFont: ChatFont;
  voiceInput?: VoiceInputConfig;
  actions: ReactNode;
  studioToggle: ReactNode;
  onShowSidebar: () => void;
  onManageDevices: () => void;
  onOpenTool: (tab: StudioTab) => void;
}) {
  const remote = useRemoteStore((state) => state.devices[device]);
  const snapshot = useRemoteDevices((state) => state.snapshot);
  const machine = snapshot?.devices.find((entry) => entry.fingerprint === device);
  const name = useMachineName(device);
  useEffect(() => { startRemoteDevices(); return mountRemoteDevice(device); }, [device]);
  const previousConnection = useRef({ device, state: machine?.state });
  useEffect(() => {
    const previous = previousConnection.current;
    previousConnection.current = { device, state: machine?.state };
    if (previous.device === device && previous.state !== "connected" && machine?.state === "connected") refreshRemoteDevice(device);
  }, [device, machine?.state]);
  const list = remote?.lists.get(remote.workspaceId ?? "");
  const thread = list?.threads.find((entry) => entry.id === remote?.threadId);
  const timeline = remote?.timelines.get(remote.threadId ?? "");
  const compose = useRemoteOutbox((state) => state.compose[device]);
  const entries = useRemoteOutbox((state) => state.entries);
  const capabilities = useRemoteWork((state) => state.capabilities[device]);
  const connected = machine?.state === "connected";
  const running = !compose && (timeline?.status === "running" || timeline?.status === "starting");
  const threadId = compose ? undefined : thread?.id;
  const workspaceId = compose?.workspaceId ?? remote?.workspaceId ?? undefined;
  const workspace = remote?.workspaces.find((entry) => entry.id === workspaceId);
  const draftKey = compose ? newThreadDraftKey(device, compose) : threadId ? threadDraftKey(device, threadId) : workspaceId ? newThreadDraftKey(device, newThreadTargetFor(workspaceId)) : `${device}/`;
  const pending = useMemo(() => entries.filter((entry) => entry.draftKey === draftKey), [draftKey, entries]);
  const [queueEdits, setQueueEdits] = useState<Record<string, string>>({});
  const [schedules, setSchedules] = useState<QueuedTurn[]>(NO_QUEUE);
  const projectedMessages = useMemo(() => {
    const known = !compose && timeline ? timeline.messages.map(messageForTimeline) : NO_MESSAGES;
    const waiting = pending.filter((entry) => entry.op !== "prompt.queue").map(messageForEntry);
    return waiting.length ? [...known, ...waiting] : known;
  }, [compose, pending, timeline?.messages]);
  const projectedActivities = useMemo(() => !compose && timeline ? timeline.activities.map(activityForTimeline) : NO_ACTIVITIES, [compose, timeline?.activities]);
  const queuedTurns = useMemo<QueuedTurn[]>(() => [
    ...(!compose && timeline ? timeline.queuedTurns.map((entry) => ({
      id: entry.id, threadId: remote?.threadId ?? "", text: entry.text, attachments: NO_ATTACHMENTS, createdAt: entry.createdAt, status: entry.status,
      ...(entry.id in queueEdits ? { editing: true } : {}),
    })) : []),
    ...schedules,
    ...pending.filter((entry) => entry.op === "prompt.queue").map((entry): QueuedTurn => ({
      id: entry.opId, threadId: entry.threadId ?? "", text: entry.text, attachments: NO_ATTACHMENTS, createdAt: entry.createdAt,
      // Only a send in flight is "sending". Anything else shows what is actually known.
      status: entry.state === "sending" ? "sending" : "failed", error: outboxStatus(entry, name),
    })),
  ], [compose, name, pending, queueEdits, remote?.threadId, schedules, timeline?.queuedTurns]);
  // A device missing from the list was removed here. The view stays on it until
  // the user picks another: this never falls back to the local machine.
  const state: ViewState = !machine || machine.state === "accessRemoved" || !machine.canView ? "removed"
    : LINK_DOWN.has(machine.state) ? "stale"
    : timeline?.state ?? remote?.state ?? "loading";
  const stale = state !== "live";
  const history = useMemo<ThreadHistoryState | undefined>(() => timeline ? {
    nextCursor: timeline.history.cursor ?? null,
    hasMore: timeline.history.hasMore && Boolean(timeline.history.cursor) && !timeline.historyLimited,
    loading: timeline.reading, paginated: true,
  } : undefined, [timeline?.history, timeline?.reading, timeline?.historyLimited]);
  const help = machine && snapshot ? deviceHelp(machine, snapshot) : null;
  const banner = !machine && snapshot ? `${name} isn't paired with this device anymore. Choose another device from the switcher.` : help ?? connectionLabel(state, name);
  const scope = useMemo<RemoteThreadScope | null>(() => threadId ? { device, name, threadId, connected, ...(workspaceId ? { workspaceId } : {}) } : null, [connected, device, name, threadId, workspaceId]);
  const timelineQuestions = useMemo(() => new Set(timeline?.messages.flatMap((message) => message.questions?.map((question) => question.id) ?? [])),
    [timeline?.messages]);
  const context = useHostContext(device, workspaceId, threadId);
  const [notice, setNotice] = useState("");
  const [uploads, setUploads] = useState<Record<string, AttachmentRecord[]>>({});
  const attachments = uploads[draftKey] ?? NO_ATTACHMENTS;
  const dropHover = useActiveMachine((state) => state.remoteDropHover);
  const [draftTokens, setDraftTokens] = useState<Record<string, { handle: string; startTarget?: string }>>({});
  const [draftChoice, setDraftChoice] = useState<Record<string, RemoteSettingsChange>>({});
  const chosen = compose ? draftChoice[draftKey] : undefined;
  const provider: Provider = chosen?.provider ?? context?.selected.provider ?? thread?.provider ?? "openai";
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const [findIndex, setFindIndex] = useState(0);
  const findInput = useRef<HTMLInputElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [runHandle, setRunHandle] = useState<string | null>(null);
  const [editingProject, setEditingProject] = useState(false);
  const canWork = threadId ? capabilities !== null : true;
  const canRun = Boolean(context?.capabilities.terminal);
  const revision = context?.revision ?? "";
  const parityTarget = useMemo(() => ({ ...(workspaceId ? { workspaceId } : {}), ...(threadId ? { threadId } : {}) }), [threadId, workspaceId]);
  const report = useCallback((outcome: { ok: boolean; message: string }) => { setNotice(outcome.message); return outcome.ok; }, []);
  const upload = useCallback(async (files: readonly File[]) => {
    if (!workspaceId) { setNotice(`Choose a workspace on ${name} first.`); return; }
    for (const file of files) {
      const result = await uploadToHost(device, name, workspaceId, file);
      if (result.ok) setUploads((current) => ({ ...current, [draftKey]: [...(current[draftKey] ?? []), { path: result.id, name: result.name, kind: result.kind }] }));
      else setNotice(result.message);
    }
  }, [device, draftKey, name, workspaceId]);
  const refreshSchedules = useCallback(() => {
    if (!threadId || !workspaceId) { setSchedules(NO_QUEUE); return; }
    hostRead<WireParityReadResult>(device, "schedules.read", parityTarget).then((result) => {
      setSchedules(hostRows(result).flatMap((row): QueuedTurn[] => row.deliverAt ? [{ id: row.id, threadId, text: row.text ?? "", attachments: NO_ATTACHMENTS,
        createdAt: row.createdAt ?? Date.now(), status: "queued", deliverAt: row.deliverAt }] : []));
    }, () => setSchedules(NO_QUEUE));
  }, [device, parityTarget, threadId, workspaceId]);
  useEffect(refreshSchedules, [refreshSchedules]);
  useEffect(() => { setFindOpen(false); setFindQuery(""); }, [threadId]);
  const findCount = useMemo(() => {
    const words = findQuery.trim().toLowerCase();
    if (!words) return 0;
    return projectedMessages.reduce((total, message) => total + (message.text.toLowerCase().split(words).length - 1), 0);
  }, [findQuery, projectedMessages]);
  const exportTranscript = useCallback(async () => {
    const label = thread?.title || thread?.preview || "Mythra Code thread";
    const path = await save({ title: `Export conversation from ${name}`, defaultPath: `${label.replace(/[\\/:*?"<>|]/g, "-").slice(0, 60).trim() || "mythra-thread"}.md`, filters: [{ name: "Markdown", extensions: ["md"] }] });
    if (!path) return;
    const { buildTranscriptMarkdown } = await import("../../lib/transcript");
    await exportTextFile(path, buildTranscriptMarkdown(`${label} (${name})`, projectedMessages, projectedActivities));
  }, [name, projectedActivities, projectedMessages, thread?.preview, thread?.title]);
  // Handles belong to one moment on the host. Ask again whenever that moment
  // changes, and hold no controls for a thread or link that has gone.
  const approvalsKey = timeline?.approvals.map((entry) => entry.id).join(",");
  useEffect(() => {
    if (!threadId || !connected) { clearRemoteCapabilities(device); return; }
    void refreshRemoteCapabilities(device, threadId);
  }, [approvalsKey, connected, device, threadId, timeline?.activeTurnId, timeline?.status]);
  useEffect(() => {
    if (connected) void reconcileRemoteOutbox(device, name);
  }, [connected, device, name]);
  useEffect(() => {
    if (connected && workspaceId) void refreshRemoteContext(device, workspaceId, threadId);
  }, [connected, device, threadId, workspaceId]);
  // Labeled with the machine, because this device did none of the work.
  const lastSeen = useRef({ threadId, running, approvals: 0 });
  useEffect(() => {
    const before = lastSeen.current;
    const approvals = timeline?.approvals.length ?? 0;
    lastSeen.current = { threadId, running, approvals };
    if (before.threadId !== threadId || !thread || document.hasFocus()) return;
    const title = approvals > before.approvals ? "Mythra Code needs your approval" : before.running && !running ? "Mythra Code task complete" : null;
    if (title) void isPermissionGranted().then((granted) => {
      if (!granted) return;
      noteNotificationTarget(device, name, () => selectRemoteThread(device, thread.id));
      sendNotification({ title, body: `“${thread.title || thread.preview || "A thread"}” on ${name}` });
    }).catch(() => undefined);
  }, [name, running, thread, threadId, timeline?.approvals.length]);
  const startTarget = draftTokens[draftKey]?.startTarget;
  // A first prompt is on its way and no thread exists yet to stop.
  const starting = Boolean(compose && startTarget && pending.some((entry) => entry.state === "sending" || entry.state === "awaiting"));
  const stop = useCallback(() => {
    if (starting && startTarget && workspaceId) {
      void hostWrite(device, name, "prompt.cancel", { workspaceId, startTarget }).then((outcome) => setNotice(outcome.ok ? "" : outcome.message));
      return;
    }
    const handle = capabilities?.stop?.handle;
    if (!handle || !threadId) { setNotice(`This device can't stop work on ${name}. ${WORK_SWITCH(name)}`); return; }
    void stopRemoteTurn(device, name, threadId, handle).then((message) => setNotice(message ?? ""));
  }, [capabilities?.stop?.handle, device, name, startTarget, starting, threadId, workspaceId]);
  const dropFiles = useCallback((paths: readonly string[]) => {
    if (!canWork) { setNotice(WORK_SWITCH(name)); return; }
    void Promise.all(paths.map((path) => readDroppedFile(path).catch((reason: unknown) => { setNotice(typeof reason === "string" ? reason : "Mythra Code couldn't read that file."); return null; })))
      .then((files) => upload(files.filter((file): file is File => file !== null)));
  }, [canWork, name, upload]);
  useEffect(() => {
    if (leaving) return;
    setMachineActions({
      dropFiles,
      stopTurn: () => { if (running || starting) stop(); },
      newThread: () => { if (workspaceId) setNewThreadTarget(device, newThreadTargetFor(workspaceId)); },
      forkThread: () => {
        if (threadId) void runRemoteRowAction(device, name, "thread.fork", { threadId }).then((failure) => { if (failure) setNotice(failure); else refreshRemoteDevice(device); });
      },
      findInConversation: () => { if (threadId) { setFindOpen(true); requestAnimationFrame(() => findInput.current?.focus()); } },
      exportTranscript: () => { void exportTranscript().catch(() => setNotice("Mythra Code couldn't save that file.")); },
      runWorkflow: (id) => {
        if (workspaceId) void hostWrite(device, name, "workflows.start", { ...parityTarget, revision, workflowId: id }).then(report);
      },
      palette: () => {
        const view = useRemoteStore.getState().devices[device];
        return {
          projects: view?.workspaces.filter((entry) => !entry.isChat).map((entry) => ({ id: entry.id, name: entry.name, path: `On ${name}` })) ?? [],
          threads: view?.lists.get(view.workspaceId ?? "")?.threads.map((entry) => ({
            id: entry.id, name: entry.title || null, preview: entry.preview, cwd: "", updatedAt: entry.updatedAt, modelProvider: entry.provider,
          })) ?? [],
          workflows: paletteWorkflows,
        };
      },
      openProject: (id) => { setNewThreadTarget(device, undefined); selectRemoteWorkspace(device, id); },
      openThread: (id) => { setNewThreadTarget(device, undefined); selectRemoteThread(device, id); },
    });
    useActiveMachine.setState({ remoteRunning: running || starting, remoteThreadOpen: Boolean(threadId), remoteApprovals: timeline?.approvals.length ?? 0 });
    return () => { setMachineActions(null); useActiveMachine.setState({ remoteRunning: false, remoteThreadOpen: false, remoteApprovals: 0 }); };
  }, [device, dropFiles, exportTranscript, leaving, name, parityTarget, report, revision, running, starting, stop, threadId, timeline?.approvals.length, workspaceId]);
  const requestDraft = useCallback(async (key: string, settings: RemoteSettingsChange, previous?: string) => {
    const outcome = await hostWrite<{ draftHandle?: string; startTarget?: string }>(device, name, "draft.settings.set", { workspaceId, ...(previous ? { draftHandle: previous } : {}), ...settings });
    const handle = outcome.result?.draftHandle;
    if (!outcome.ok || !handle) { if (!outcome.ok) setNotice(outcome.message); return null; }
    const token = { handle, ...(outcome.result?.startTarget ? { startTarget: outcome.result.startTarget } : {}) };
    setDraftTokens((current) => ({ ...current, [key]: token }));
    return token;
  }, [device, name, workspaceId]);
  const deliver = useCallback(async (text: string, mode: "send" | "queue" | "steer", handle?: string): Promise<RemoteSendOutcome> => {
    setNotice("");
    if (!connected) return { status: "rejected", message: `Your draft is saved. You can send once ${name} is connected.` };
    if (!threadId && !workspaceId) return { status: "rejected", message: `Choose a workspace on ${name} first.` };
    if (threadId && capabilities === null) return { status: "rejected", message: `This device can view ${name} but can't work on it. ${WORK_SWITCH(name)}` };
    const attachmentIds = (uploads[draftKey] ?? NO_ATTACHMENTS).map((entry) => entry.path);
    // Asked for first so Stop has something to name while the thread is starting.
    const draftHandle = threadId ? undefined : (draftTokens[draftKey] ?? await requestDraft(draftKey, draftChoice[draftKey] ?? {}))?.handle;
    const outcome = await sendRemotePrompt({ device, name, draftKey, text, mode,
      ...(threadId ? { threadId } : { workspaceId }), ...(handle ? { handle } : {}), ...(draftHandle ? { draftHandle } : {}),
      ...(attachmentIds.length ? { attachmentIds } : {}) });
    if (outcome.status === "rejected") setNotice(outcome.message);
    else setUploads((current) => { const next = { ...current }; delete next[draftKey]; return next; });
    // A draft handle works for one send.
    if (!threadId) setDraftTokens((current) => { const next = { ...current }; delete next[draftKey]; return next; });
    return outcome;
  }, [capabilities, connected, device, draftChoice, draftKey, draftTokens, name, requestDraft, threadId, uploads, workspaceId]);
  const paletteWorkflows = useMemo(() => (context?.workflows ?? []).map((workflow) => ({ id: workflow.id, name: workflow.name, description: workflow.description, enabled: true, steps: [] })) as unknown as WorkflowDefinition[], [context?.workflows]);
  const steerHandle = running && capabilities?.canSteer ? capabilities.steer?.handle : undefined;
  const search = useCallback((query: string) => workspaceId ? searchRemoteFiles(device, workspaceId, query) : Promise.resolve([]), [device, workspaceId]);
  const skills = useMemo(() => context?.skills.filter((skill) => skill.enabled).map((skill) => ({ name: skill.name, description: skill.description })), [context?.skills]);
  const changeSettings = (change: RemoteSettingsChange) => {
    if (!workspaceId) return;
    // A started thread keeps its provider, as it does here: another one means a new thread.
    if (threadId && change.provider && change.provider !== thread?.provider) {
      const target = newThreadTargetFor(workspaceId);
      const key = newThreadDraftKey(device, target);
      setDraftChoice((current) => ({ ...current, [key]: { provider: change.provider } }));
      setNewThreadTarget(device, target);
      void requestDraft(key, { provider: change.provider });
      return;
    }
    if (threadId) {
      void setRemoteThreadSettings(device, name, { threadId, ...change }, workspaceId).then((message) => { if (message) setNotice(message); });
      return;
    }
    // A new thread's choices wait on the host until its first prompt.
    setDraftChoice((current) => ({ ...current, [draftKey]: { ...current[draftKey], ...change } }));
    void requestDraft(draftKey, { ...draftChoice[draftKey], ...change }, draftTokens[draftKey]?.handle);
  };
  const copyWorktreePath = () => {
    hostRead<{ worktree?: { path?: string } | null }>(device, "worktree.status", parityTarget).then((result) => {
      if (result?.worktree?.path) void navigator.clipboard.writeText(result.worktree.path).catch(() => undefined);
      else setNotice(`${name} didn't share this path.`);
    }, () => setNotice(`The worktree's path on ${name} can't be copied from here yet.`));
  };
  const awaiting = timeline?.approvals.length ? timeline.approvals.some((entry) => entry.kind === "question") ? "input" as const : "approval" as const : null;
  const contextPercent = context?.usage?.contextTokens && context.usage.contextWindow ? Math.round(context.usage.contextTokens / context.usage.contextWindow * 100) : null;
  const known = Boolean(compose || (thread && timeline?.baseline) || pending.length);
  const waiting = state === "removed" ? `This thread is not available from ${name}.` : thread ? "" : remote?.loading ? "" : `Choose a thread on ${name}, or start a new one.`;
  return <section className="remote-stage" data-remote-device={device} inert={leaving || undefined} aria-label={`Conversation on ${name}`}>
    <header className="topbar">
      <div className="topbar-left">
        {!sidebarOpen && <button className="icon-button" onClick={onShowSidebar} title="Show sidebar" aria-label="Show sidebar"><PanelLeftOpen size={18} /></button>}
        <div className="project-heading">
          <span>{workspace?.isChat ? "Normal chat" : workspace?.name ?? name}</span>
          <small>{name}{compose ? " · New thread" : thread ? ` · ${thread.title || thread.preview || "New thread"}` : ""}</small>
        </div>
        {thread && context?.execution?.isolated && <button className="isolation-chip" title="Copy path" onClick={copyWorktreePath}>
          <GitBranch size={12} /> <span>Isolated</span>
        </button>}
        {workspace && !workspace.isChat && <ProjectPromptControl key={workspaceId} projectName={workspace.name} projectPrompt={context?.projectPrompt} promptMode={context?.projectPromptMode ?? "replace"}
          appPrompt="" provider={provider} threadStarted={Boolean(threadId)} skills={skills}
          onSave={(prompt, mode) => {
            if (!context?.capabilities.manageProjects) { setNotice(accessReason(name, "change project instructions", "Manage projects")); return; }
            void hostWrite(device, name, "projects.instructions.set", { workspaceId, revision, prompt: prompt ?? "", mode }).then((outcome) => { if (report(outcome) && workspaceId) void refreshRemoteContext(device, workspaceId, threadId); });
          }}
          onAppPromptSettings={() => setEditingProject(true)} />}
        {workspace && !workspace.isChat && <ProjectRunControl key={`run-${workspaceId}`} projectName={workspace.name}
          run={context?.run ? { ...context.run, updatedAt: 0 } : undefined} running={Boolean(runHandle)}
          onRun={() => {
            if (!canRun) { setNotice(accessReason(name, "run this project", "Use the terminal")); return; }
            void hostWrite<{ processHandle?: string }>(device, name, "run.start", { ...parityTarget, revision }).then((outcome) => { if (report(outcome)) setRunHandle(outcome.result?.processHandle ?? "running"); });
          }}
          onStop={() => { if (runHandle) void hostWrite(device, name, "run.stop", { ...parityTarget, revision, processHandle: runHandle }).then((outcome) => { if (report(outcome)) setRunHandle(null); }); }}
          onSave={(next) => {
            if (!canRun) { setNotice(accessReason(name, "save this command", "Use the terminal")); return; }
            void hostWrite(device, name, "projects.run.set", { workspaceId, revision, command: next?.command ?? "", ...(next?.label ? { label: next.label } : {}), ...(next?.setupCommand ? { setupCommand: next.setupCommand } : {}) }).then((outcome) => { if (report(outcome) && workspaceId) void refreshRemoteContext(device, workspaceId, threadId); });
          }} onDiscovered={() => undefined} />}
      </div>
      <div className="topbar-right">
        {thread && <button className="icon-button topbar-export-button" onClick={() => machineActions()?.exportTranscript()} title="Export conversation as Markdown" aria-label="Export conversation as Markdown"><Download size={15} /></button>}
        {actions}
        <div className="runtime-status" title={`Status on ${name}`}>
          {running ? <LoaderCircle className="spin" size={13} /> : <Circle size={8} fill="currentColor" />}
          <span>{running ? "Working" : connected ? "Ready" : "Not connected"}</span>
        </div>
        {contextPercent !== null && <button className="topbar-usage-chip" type="button" title={`Context used on ${name}`} onClick={() => onOpenTool("usage")}>
          <Gauge size={13} aria-hidden="true" /><span>{contextPercent}%</span>
        </button>}
        {studioToggle}
      </div>
    </header>
    <section className="conversation">
      {banner && <div className="remote-banner" role="status"><span>{banner}</span>
        {(help || !machine) && <button type="button" className="secondary-button" onClick={onManageDevices}>Open Devices settings</button>}
      </div>}
      {remote?.error && <div className="remote-banner" role="status">{remote.error}</div>}
      {timeline?.error && <div className="remote-banner" role="status">Host reported: {timeline.error}</div>}
      {!compose && scope && <RemoteRequests scope={scope} summaries={timeline?.approvals ?? NO_APPROVALS} capabilities={capabilities} questionsInTimeline={timelineQuestions} />}
      {findOpen && threadId && <ConversationSearchBar inputRef={findInput} query={findQuery} index={findIndex} count={findCount}
        onQuery={(query) => { setFindQuery(query); setFindIndex(0); }} onIndex={setFindIndex} onClose={() => { setFindOpen(false); setFindQuery(""); }} />}
      <div className="remote-timeline">
        {compose && !pending.length ? <div className="thread-empty-state">
          <AnimatedMythraLogo />
          <h1>{workspace?.isChat ? "Start a normal chat." : "What should we build?"}</h1>
          <p>This conversation runs on {name}, with its files and accounts.</p>
          <div className="trust-strip">
            <span><Check size={13} /> {workspace?.isChat ? "No project folder" : `${workspace?.name ?? "Project"} on ${name}`}</span>
            <span><Check size={13} /> Approval controls</span>
          </div>
          {workspace && !workspace.isChat && <div className="isolation-choice" aria-label="Thread workspace mode">
            <button className={!chosen?.isolated ? "active" : ""} aria-pressed={!chosen?.isolated} onClick={() => changeSettings({ isolated: false })}>
              <Folder size={15} /><span><strong>Shared project</strong><small>Work directly in {workspace.name}</small></span>
            </button>
            <button className={chosen?.isolated ? "active" : ""} aria-pressed={Boolean(chosen?.isolated)} disabled={!canRun}
              title={canRun ? undefined : accessReason(name, "create worktrees", "Use the terminal")} onClick={() => changeSettings({ isolated: true })}>
              <GitBranch size={15} /><span><strong>Isolated worktree</strong><small>A separate branch and folder on {name}</small></span>
            </button>
          </div>}
        </div> : known ? <RemoteMachineName.Provider value={name}><RemoteThreadContext.Provider value={scope}><TimelinePresentation key={`${device}:${compose ? "new" : thread?.id}`} environment={REMOTE_ENVIRONMENT}
          messages={projectedMessages} activities={projectedActivities} provider={thread?.provider ?? provider}
          running={running} activeTurnId={timeline?.activeTurnId ?? undefined} awaitingState={awaiting}
          thinkingLabel={`Working on ${name}`} history={compose ? undefined : history}
          searchQuery={findOpen ? findQuery : ""} searchActiveMatch={findIndex}
          onLoadEarlier={!compose && !stale && !timeline?.historyLimited ? () => loadRemoteEarlier(device) : undefined} /></RemoteThreadContext.Provider></RemoteMachineName.Provider>
          : waiting && <p className="remote-empty" role="status">{waiting}</p>}
      </div>
      {timeline?.historyLimited && <p className="remote-banner" role="note">The earlier-history window is unavailable or full. Refresh to load a new recent window.</p>}
    </section>
    <section className={`composer-zone ambiance-${provider} ${running ? "ambiance-live" : ""}`}>
      {notice && <div className="error-banner" role="alert"><span>{notice}</span>
        <div className="error-banner-actions"><button onClick={() => setNotice("")} aria-label="Dismiss error"><X size={14} /></button></div>
      </div>}
      <ErrorBoundary label="composer" resetKey={draftKey}>
        <Composer
          threadKey={draftKey}
          chatFont={chatFont}
          running={running || starting}
          queueing={running && Boolean(capabilities?.canQueue)}
          canSteer={Boolean(steerHandle)}
          dropActive={dropHover}
          placeholder={compose ? `Start a thread on ${name}` : running ? `Queue a follow-up on ${name}` : `Message ${name}`}
          attachments={attachments}
          queuedTurns={queuedTurns}
          searchFiles={search}
          skills={skills}
          workflows={context?.workflows}
          onWorkflow={async (id, prompt) => {
            const outcome = await hostWrite(device, name, "workflows.start", { ...parityTarget, revision, workflowId: id, ...(prompt ? { userPrompt: prompt } : {}) });
            return report(outcome);
          }}
          voiceInput={voiceInput}
          onRemoveAttachment={(path) => setUploads((current) => ({ ...current, [draftKey]: (current[draftKey] ?? []).filter((entry) => entry.path !== path) }))}
          onPasteImages={(items) => { void upload([...items].flatMap((item) => { const file = item.kind === "file" ? item.getAsFile() : null; return file ? [file] : []; })); }}
          onSchedule={async (text, deliverAt) => {
            const op = threadId ? "prompt.schedule" : "prompt.scheduleNew";
            const outcome = await hostWrite(device, name, op, { ...parityTarget, revision, text, deliverAt });
            if (outcome.ok) refreshSchedules();
            return report(outcome);
          }}
          scheduleContextLabel={`Runs on ${name}, at that time on ${name}.`}
          timedActions={{
            onReschedule: (id, deliverAt) => { void hostWrite(device, name, "schedules.reschedule", { ...parityTarget, revision, scheduleId: id, deliverAt }).then((outcome) => { report(outcome); refreshSchedules(); }); return true; },
            onRelease: (id) => { void hostWrite(device, name, "schedules.release", { ...parityTarget, revision, scheduleId: id }).then((outcome) => { report(outcome); refreshSchedules(); }); return true; },
            onRemove: (id) => { void hostWrite(device, name, "schedules.remove", { ...parityTarget, revision, scheduleId: id }).then((outcome) => { report(outcome); refreshSchedules(); }); },
          }}
          onBeginEditQueued={(id) => {
            setQueueEdits((current) => ({ ...current, [id]: "" }));
            void hostWrite<{ editHandle?: string }>(device, name, "queue.edit.begin", { ...parityTarget, revision, queueId: id }).then((outcome) => {
              const handle = outcome.result?.editHandle;
              if (outcome.ok && handle) setQueueEdits((current) => ({ ...current, [id]: handle }));
              else { setNotice(outcome.message || `${name} didn't let this message be edited.`); setQueueEdits(({ [id]: _dropped, ...rest }) => rest); }
            });
            return true;
          }}
          onFinishEditQueued={(id, text) => {
            const editHandle = queueEdits[id];
            setQueueEdits(({ [id]: _dropped, ...rest }) => rest);
            if (editHandle) void hostWrite(device, name, "queue.edit.finish", { ...parityTarget, revision, queueId: id, editHandle, ...(text === undefined ? { cancel: true } : { text }) }).then(report);
            return true;
          }}
          onSend={(text) => deliver(text, running ? "queue" : "send")}
          onSteer={(text) => deliver(text, "steer", steerHandle)}
          onRetryQueued={(id) => {
            const entry = pending.find((item) => item.opId === id);
            if (entry) void retryRemotePrompt(entry, name);
            else void hostWrite(device, name, "queue.retry", { ...parityTarget, revision, queueId: id }).then(report);
          }}
          onRemoveQueued={(id) => {
            const entry = pending.find((item) => item.opId === id);
            if (entry) { if (entry.state !== "sending" && entry.state !== "awaiting") removeOutboxEntry(id); }
            else void hostWrite(device, name, "queue.remove", { ...parityTarget, revision, queueId: id }).then(report);
          }}
          onSteerQueued={(id) => { void hostWrite(device, name, "queue.steer", { ...parityTarget, revision, queueId: id, ...(steerHandle ? { target: steerHandle } : {}) }).then(report); }}
          onStop={stop}
          modelControls={<RemoteModelControls context={context} chosen={chosen} name={name} provider={provider} running={running} threadStarted={Boolean(threadId)}
            onSettings={changeSettings} onDefaults={() => setEditingProject(true)} onNotice={setNotice} />}
          controls={<>
            <RemoteComposerControls context={context} chosen={chosen} name={name} provider={provider} running={running} threadId={threadId} scopeKey={draftKey}
              onSettings={changeSettings} onNotice={setNotice} onOpenSettings={() => setEditingProject(true)} />
            <button className={`toolbar-button ${attachments.length ? "has-attachments" : ""}`} disabled={!canWork} title={canWork ? `Attach a file from this device. It's sent to ${name}.` : WORK_SWITCH(name)} onClick={() => fileInput.current?.click()}>
              <Paperclip size={14} />{attachments.length ? attachments.length : "Attach"}
            </button>
            <input ref={fileInput} type="file" multiple hidden onChange={(event) => { const files = [...(event.target.files ?? [])]; event.target.value = ""; void upload(files); }} />
          </>}
        />
      </ErrorBoundary>
      <div className="composer-caption">
        Running on {name}. Mythra Code can make mistakes. Review commands and changes before shipping.
        {contextPercent !== null && <span className={`context-meter ${contextPercent > 80 ? "warn" : ""}`}>{" "}· Context {contextPercent}% used</span>}
      </div>
    </section>
    {editingProject && workspaceId && workspace && <RemoteProjectEditor device={device} name={name} workspaceId={workspaceId} projectName={workspace.name} context={context}
      onClose={() => setEditingProject(false)} onSaved={() => { setEditingProject(false); refreshRemoteDevice(device); void refreshRemoteContext(device, workspaceId, threadId); }} />}
  </section>;
}
