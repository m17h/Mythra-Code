import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { isPermissionGranted, sendNotification } from "@tauri-apps/plugin-notification";
import { AlertTriangle, Archive, ArchiveRestore, Check, ChevronDown, Circle, Clock, CornerUpRight, Copy, Download, Folder, Gauge, GitBranch, GitFork, LoaderCircle, MessageSquare, PanelLeftOpen, Paperclip, Pencil, Pin, PinOff, Settings, Trash2, X } from "lucide-react";
import type { Activity, ChatFont, ChatMessage, Provider } from "../../types";
import { TimelinePresentation } from "../ChatTimeline";
import { AnimatedMythraLogo } from "../AnimatedMythraLogo";
import { ConversationSearchBar } from "../ConversationSearchBar";
import { ProjectPromptControl } from "../ProjectPromptControl";
import { ProjectRunControl } from "../ProjectRunControl";
import { SubAgentParentGroup } from "../SubAgentParentGroup";
import { Composer, draftFor, seedComposerDraft, type ComposerHandle } from "../Composer";
import { ThreadTitle } from "../ThreadTitle";
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
import { accessReason, hostProjectWrite, hostRead, hostRows, hostWrite, captureDroppedFiles, readDroppedFile, uploadToHost } from "../../lib/remote/remoteActions";
import { addRemoteNotice, machineActions, setMachineActions, useActiveMachine } from "../../lib/remote/activeMachine";
import { hostLinkPath, hostLocalPort, isPublicWebLink } from "../../lib/remote/links";
import { listRemotePreviews, openRemotePreview } from "../../lib/remote/remotePreviews";
import { addRemoteEcho, newThreadDraftKey, newThreadTargetFor, removeOutboxEntry, removeRemoteEcho, setNewThreadTarget, threadDraftKey, useRemoteEchoes, useRemoteOutbox, type OutboxEntry, type RemoteEcho } from "../../lib/remote/outbox";
import {
  clearRemoteCapabilities, alignRemoteDevice, reconcileRemoteOutbox, refreshRemoteCapabilities, refreshRemoteContext, remoteContextKey, retryRemotePrompt,
  deliverRemoteSteerNow, forkRemoteThread, listRemoteSteers, runRemoteRowAction, setRemoteDraftIsolation, searchRemoteFiles, sendRemotePrompt, setRemoteThreadSettings, stopRemoteTurn, UNCONFIRMED_TEXT,
  useRemoteContext, useRemoteWork, type RemoteSendOutcome,
} from "../../lib/remote/remoteWork";
import { remoteFindNearby } from "../../lib/remote/client";
import { acceptRemoteSnapshot, deviceHelp, deviceHelpOffersRetry, namingDevice, useRemoteDevices, startRemoteDevices } from "../../lib/remote/devices";
import {
  useRemoteStore, mountRemoteDevice, openRemoteThread, selectRemoteWorkspace, selectRemoteThread,
  loadRemoteThreads, loadRemoteEarlier, readRemoteTranscript, refreshRemoteDevice, watchRemoteThreads, type RemoteTimeline, type ViewState,
} from "../../lib/remote/remoteStore";
import type { WireResourceResult } from "../../lib/remote/wire-resources";
import type { WireQueuedSteer } from "../../lib/remote/wire";
import type { HostContextResult, RemoteRowOperation, WireApproval, WireExecutionSettings, WireMessage, WireActivity, WireParityReadResult, WireThread, WireWorkspace } from "../../lib/remote/wire";
import type { SubAgentParentState } from "../../lib/subAgentParents";
import type { QueuedTurn } from "../../lib/taskStore";
import type { WorkflowDefinition } from "../../lib/workflows";
import type { ThreadHistoryState } from "../../lib/threadHistory";
import { RemoteFolderBrowser } from "./RemoteFolderBrowser";
import { RemoteProjectEditor } from "./RemoteProjectEditor";
import { RemoteComposerControls } from "./RemoteComposerControls";
import { RemoteImage } from "./RemoteImage";
import { RemotePreviews } from "./RemotePreviews";
import { useRemoteCommand } from "./useRemoteCommand";
import { useRemoteDiscovery } from "./useRemoteDiscovery";
import { useFeedbackMessageSource } from "../FeedbackProvider";
import { FeedbackTray } from "../FeedbackTray";
import { ThreadPullRequestChip } from "../ThreadPullRequestChip";
import { ScheduledCountBadge } from "../ScheduledCountBadge";
import { remoteGuide, type RemoteGuide } from "../../lib/remote/firstRun";
import { remotePullRequests } from "../../lib/remote/remotePullRequests";
import type { GitView } from "../../lib/projectGit";
import type { ModelFavorites } from "../../lib/modelFavorites";
import { providerHeaderUsage, type HeaderUsageWindows } from "../../lib/providerUsage";
import { hostQuotaAccountView } from "../../lib/remote/remoteActions";
import type { UsageDisplayMode } from "../../types";
import { UsagePopover } from "../UsagePopover";
import type { PullRequest } from "../../lib/pullRequests";
import { feedbackSkillInvocationText, formatFeedbackPrompt, isFeedbackAnchorStale, type FeedbackNote } from "../../lib/reviewFeedback";
import { expectRemoteRun, remoteTerminal, remoteTerminalKey, useRemoteTerminals } from "../../lib/remote/remoteTerminal";
import { removeRemoteFeedback, removeSentRemoteFeedback, setRemoteFeedbackScope, updateRemoteFeedback, useRemoteFeedback } from "../../lib/remote/remoteFeedback";
import { useRemoteQueueEdit } from "./useRemoteQueueEdit";
import { RemoteModelControls } from "./RemoteModelControls";
import { useRemoteWorkflowLaunch } from "./RemoteWorkflowLaunch";
import { hostSkillLinks, hostSkillName, RemoteSkillViewer, useRemoteSkillAnalyzer } from "./RemoteSkills";
import { RemoteMessageQuestions, RemoteRequests, RemoteThreadContext, type RemoteThreadScope } from "./RemoteRequests";
export { RemoteStudio } from "./RemoteStudio";
export { RemoteNotices } from "./RemoteNotices";
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
    detail: source.truncated ? `${source.detail ?? ""}\n${SHORTENED}` : source.detail,
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
const NO_WIRE_MESSAGES: WireMessage[] = [];
const NO_QUEUE: QueuedTurn[] = [];
const LINK_DOWN = new Set(["stale", "offline", "unreachable", "incompatible", "connecting"]);
const WORK_SWITCH = (name: string) => `On ${name}, turn on Work for this device in Settings → Connections → Devices.`;

/** Resubscribing on a healthy link is "stale" for a round trip, which isn't news. */
const SETTLE_MS = 1_500;
const WATCH_MS = 15_000;
const THREAD_BATCH = 100;
function useOutlasted(active: boolean, ms: number): boolean {
  const [outlasted, setOutlasted] = useState(false);
  useEffect(() => {
    setOutlasted(false);
    if (!active) return;
    const timer = setTimeout(() => setOutlasted(true), ms);
    return () => clearTimeout(timer);
  }, [active, ms]);
  return outlasted;
}
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
interface DraftToken { handle: string; startTarget?: string }

const pendingEntries = new WeakMap<ChatMessage, OutboxEntry>();
const pendingByEntry = new WeakMap<OutboxEntry, ChatMessage>();
function messageForEcho(echo: RemoteEcho): ChatMessage {
  return { id: `outbox:${echo.id}`, role: "user", text: echo.text, streaming: false, timelineOrder: Number.MAX_SAFE_INTEGER };
}
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
  const others = names.map((name, index) => ({ name, index })).filter(({ index }) => !images.includes(index));
  // Where each file sits on the host is shown and can be copied. It is never read from here.
  const hostPath = (index: number) => source.attachmentMetadata?.find((entry) => entry.index === index)?.originalHostPath;
  const [copied, setCopied] = useState<number | null>(null);
  return <>
    {scope?.workspaceId && images.length > 0 && <div className="message-image-previews" aria-label="Attached images">{images.map((index) => <RemoteImage key={index} name={names[index]}
      image={{ device: scope.device, workspaceId: scope.workspaceId!, threadId: scope.threadId, messageId: source.id, index }} />)}</div>}
    {others.length > 0 && <p className="remote-note">Attachments on the host: {others.map(({ name: file, index }, position) => {
      const path = hostPath(index);
      return <span key={index}>{position ? ", " : ""}<span title={path}>{file}</span>{path && <button type="button" className="remote-copy-path" aria-label={`Copy the path of ${file} on the host`} title={path}
        onClick={() => { void navigator.clipboard.writeText(path).then(() => setCopied(index)).catch(() => undefined); }}>{copied === index ? <Check size={11} /> : <Copy size={11} />}</button>}</span>;
    })}.</p>}
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
/** The header's pull request, read from the thread's saved link on the other machine. */
function RemotePullRequestChip({ device, name, target, connected, onOpen }: { device: string; name: string; target: { workspaceId?: string; threadId?: string }; connected: boolean; onOpen: () => void }) {
  const [state, setState] = useState<{ repository: string | null; pullRequest: PullRequest | null; linked: boolean }>({ repository: null, pullRequest: null, linked: false });
  const { workspaceId, threadId } = target;
  useEffect(() => {
    if (!workspaceId || !connected) return;
    let current = true;
    const pullRequests = remotePullRequests({ device, name, target: { workspaceId, ...(threadId ? { threadId } : {}) }, revision: () => "" });
    void (async () => {
      const access = await pullRequests.access();
      if (!current) return;
      setState({ repository: access.repository, pullRequest: null, linked: false });
      const saved = access.savedLink;
      if (!saved) return;
      const pullRequest = await pullRequests.view("", saved.repository, saved.number);
      if (current) setState({ repository: access.repository, pullRequest, linked: true });
    })().catch(() => undefined);
    return () => { current = false; };
  }, [connected, device, name, threadId, workspaceId]);
  return state.repository ? <ThreadPullRequestChip repository={state.repository} pullRequest={state.pullRequest} linked={state.linked} onClick={onOpen} /> : null;
}

function RemoteGuideCard({ guide, onAddProject, onOpenChats, onCheckAgain }: { guide: RemoteGuide; onAddProject: () => void; onOpenChats: () => void; onCheckAgain: () => void }) {
  return <div className="remote-guide" role="status">
    {guide.kind === "opening" ? <LoaderCircle className="spin" size={18} aria-hidden="true" /> : null}
    <h2>{guide.title}</h2>
    <p>{guide.body}</p>
    {guide.actions.length > 0 && <div className="remote-guide-actions">
      {guide.actions.includes("addProject") && <button type="button" className="primary-button" onClick={onAddProject}>Add a project</button>}
      {guide.actions.includes("openChats") && <button type="button" className="secondary-button" onClick={onOpenChats}>Start a normal chat</button>}
      {guide.actions.includes("checkAgain") && <button type="button" className="secondary-button" onClick={onCheckAgain}>Check again</button>}
    </div>}
  </div>;
}

/** Replies stay selectable for notes. The note itself goes out with the next message. */
function RemoteMessageFeedback({ message, children }: { message: ChatMessage; children: (open: ((trigger: HTMLElement) => void) | null) => ReactNode }) {
  return <>{children(useFeedbackMessageSource(message))}</>;
}
const SHORTENED = "[Activity shortened on the host.]";
/** A long step arrives shortened. Its whole output is one click away, and only then read. */
function RemoteActivityDetail({ activity, children }: { activity: Activity; children: ReactNode }) {
  const scope = useContext(RemoteThreadContext);
  const [full, setFull] = useState<{ text: string; truncated: boolean } | null>(null);
  const [state, setState] = useState<"idle" | "reading" | "failed">("idle");
  if (!activity.detail?.endsWith(SHORTENED) || !scope?.workspaceId) return <>{children}</>;
  if (full) return <><pre className="activity-step-output">{full.text}</pre>{full.truncated && <p className="activity-step-note">This output is too long to show in full here.</p>}</>;
  const read = () => {
    setState("reading");
    hostRead<WireResourceResult>(scope.device, "activity.read", { workspaceId: scope.workspaceId, threadId: scope.threadId, activityId: activity.id }).then((result) => {
      if (result.activity) { setFull({ text: result.activity.detail, truncated: result.activity.truncated }); setState("idle"); } else setState("failed");
    }, () => setState("failed"));
  };
  return <>{children}<button type="button" className="activity-step-more" disabled={state === "reading"} onClick={read}>
    {state === "reading" ? "Reading…" : state === "failed" ? `Couldn't read this from ${scope.name}. Try again.` : "Show full output"}
  </button></>;
}
/** The host's record of each queued steer, and the way to ask for it now. */
const steerKey = (steer: Pick<WireQueuedSteer, "turnId" | "runtimeId">) => `${steer.turnId ?? ""}|${steer.runtimeId ?? ""}`;
/** The host's record of each queued steer, and the way to ask for it now. */
const RemoteSteers = createContext<{ steers: ReadonlyMap<string, WireQueuedSteer>; available: boolean; requested: ReadonlySet<string>; deliver: (steer: WireQueuedSteer) => Promise<string | null> } | null>(null);
/** The local steer row, filled from the host's own status. Nothing here guesses that Claude read it. */
function RemoteQueuedSteer({ message }: { message: ChatMessage }) {
  const remote = useContext(RemoteSteers);
  const name = useContext(RemoteMachineName);
  const steer = remote?.steers.get(message.id);
  const [delivering, setDelivering] = useState(false);
  const [failure, setFailure] = useState("");
  if (!remote?.available) return <div className="message-steer-status unconfirmed" role="status" title={`Mythra Code couldn't read this message's status from ${name}.`}>
    <AlertTriangle size={11} aria-hidden="true" />Status unavailable from {name}</div>;
  if (steer?.status === "read") return <div className="message-steer-status read" role="status" title="Claude confirmed reading this message."><Check size={11} aria-hidden="true" />Read by Claude</div>;
  if (steer?.status === "accepted") return <div className="message-steer-status accepted" role="status" title="Runtime input delivery confirmed."><Check size={11} aria-hidden="true" />Steer delivered to runtime input</div>;
  if (steer?.status === "unconfirmed") return <div className="message-steer-status unconfirmed" role="status" title="Claude has not confirmed reading this message in its original turn. Inspect the conversation before sending it again.">
    <AlertTriangle size={11} aria-hidden="true" />Steer reading unconfirmed</div>;
  if (steer?.status === "sending") return <div className="message-steer-status sending" role="status"><CornerUpRight size={11} aria-hidden="true" />Sending steer…</div>;
  const requested = Boolean(steer && (steer.deliveryRequested || remote.requested.has(steerKey(steer))));
  const label = delivering ? "Requesting delivery…" : requested ? "Delivery requested; waiting for Claude to read" : `Waiting for Claude's next step on ${name}`;
  return <div className="message-steer-status queued" role="status" title="Claude reads new messages between steps. This message is queued for a later step.">
    <Clock size={11} aria-hidden="true" />{label}
    {steer?.canDeliver && !requested && <button type="button" className="message-steer-now" disabled={delivering} aria-busy={delivering}
      title={`Interrupt Claude's current step on ${name} so it can read this message. Sub-agents may continue in the background.`}
      onClick={() => {
        setDelivering(true); setFailure("");
        void remote.deliver(steer).then((problem) => { if (problem) setFailure(problem); }).finally(() => setDelivering(false));
      }}>{failure ? "Retry send now" : "Send now"}</button>}
    {failure && <span className="message-steer-error" role="alert">Could not request delivery: {failure}</span>}
  </div>;
}
const REMOTE_ENVIRONMENT: TimelineEnvironment = Object.freeze({
  Questions: RemoteQuestions, MessageExtras: RemoteMessageExtras, Feedback: RemoteMessageFeedback, ActivityDetail: RemoteActivityDetail, canApprove: true, queuedSteerLabel: "Queued on the other device", QueuedSteer: RemoteQueuedSteer,
  canOpenSkills: true, skillLinkTitle: (skill: string) => `Open @${skill} on the other device`,
  openExternalUrl: (url: string) => isPublicWebLink(url) ? openUrl(url) : Promise.resolve(),
  canOpenLink: isPublicWebLink,
});

const NO_NOTES: readonly FeedbackNote[] = [];
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
      scheduledPromptCount={thread.scheduled} presence={threadPresence(thread, timeline)} onOpen={onOpen} />}
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
  const addProjectRequest = useActiveMachine((state) => state.remoteAddProject);
  const addProjectSeen = useRef(addProjectRequest);
  useEffect(() => { if (addProjectRequest !== addProjectSeen.current) { addProjectSeen.current = addProjectRequest; setBrowsing(true); } }, [addProjectRequest]);
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
  /** Native takes up to 100 at a time and records each thread on its own. */
  const eachThread = async (ids: readonly string[], op: "thread.archiveMany" | "thread.deleteMany", extra: Record<string, unknown> = {}) => {
    const workspaceId = remote?.workspaceId;
    if (!workspaceId) return;
    for (let start = 0; start < ids.length; start += THREAD_BATCH) {
      const outcome = await hostProjectWrite(device, name, workspaceId, op, { threadIds: ids.slice(start, start + THREAD_BATCH), ...extra });
      if (!outcome.ok) { setError(outcome.message); break; }
    }
    refreshRemoteDevice(device);
  };
  const archiveAll = () => {
    const ids = shown.map((thread) => thread.id);
    if (!ids.length || !remote?.workspaceId) return;
    void confirmDialog(`Archive ${ids.length} ${kind === "subagents" ? "sub-agent" : "main"} thread${ids.length === 1 ? "" : "s"} on ${name}?\n\nYou can restore them from Archived.`).then((confirmed) => {
      if (!confirmed) return;
      void eachThread(ids, "thread.archiveMany");
    });
  };
  const deleteAllArchived = () => {
    const ids = archived.map((thread) => thread.id);
    if (!ids.length || !remote?.workspaceId) return;
    void confirmDialog(`Permanently delete all ${ids.length} archived threads on ${name}?\n\nThis can't be undone.`).then((confirmed) => {
      if (!confirmed) return;
      void eachThread(ids, "thread.deleteMany", { confirmed: true });
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
  const projectRow = (project: WireWorkspace) => <WorkspaceRow key={project.id} counts={<ScheduledCountBadge {...project.scheduled} />} name={project.name} title={`${project.name} on ${name}`} label={project.name} pinned={project.pinned} scale={scale}
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
  // A new thread you started typing and left, kept until it's sent or cleared.
  const savedDraft = workspace && !composing && kind !== "subagents" ? draftFor(newThreadDraftKey(device, newThreadTargetFor(workspace.id))).trim().slice(0, 140) : "";
  const threadRow = (thread: WireThread) => <RemoteThreadRow key={thread.id} device={device} name={name} thread={thread} workspaceName={workspace?.name ?? name}
    timeline={remote?.timelines.get(thread.id)} selected={!composing && remote?.threadId === thread.id} active={active} scale={scale} canWork={canWork}
    onError={setError} onCopyPath={() => { if (remote?.workspaceId) copyProjectPath(remote.workspaceId); }}
    onOpen={() => { setNewThreadTarget(device, undefined); selectRemoteThread(device, thread.id); }} />;
  return <div className="sidebar-machine-lists" inert={leaving || undefined} aria-label={`Workspaces and threads on ${name}`} role="group">
    <WorkspacesSection onAdd={() => setBrowsing(true)} addDisabled={!addAllowed}
      addTitle={addAllowed ? `Add a project on ${name}` : `On ${name}, turn on Work with all projects and Manage projects for this device in Settings → Connections → Devices.`}>
      {chats && <ChatsRow scheduled={chats.scheduled} active={remote?.workspaceId === chats.id} onOpen={() => { setNewThreadTarget(device, undefined); selectRemoteWorkspace(device, chats.id); }} label="Chats" />}
      {pinnedProjects.length > 0 && <PinnedWorkspaceGroup count={pinnedProjects.length} containsActiveWorkspace={pinnedProjects.some((project) => project.id === remote?.workspaceId)}>
        {pinnedProjects.map(projectRow)}
      </PinnedWorkspaceGroup>}
      {projects.filter((entry) => !entry.pinned).map(projectRow)}
      {!remote?.workspaces.length && <p className="empty-threads" role="status">{remote?.loading ? "" : `On ${name}, share a project with this device in Settings → Connections → Devices.`}</p>}
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
        {savedDraft && <>
          <span className="section-label">Saved drafts</span>
          <div className="thread-row-wrap">
            <button className="thread-card" onClick={() => setNewThreadTarget(device, newThreadTargetFor(workspace!.id))} aria-label={`Open saved draft: ${savedDraft}`}>
              <span className="thread-card-context"><span className="thread-card-workspace"><MessageSquare size={14} /><span>Draft</span></span></span>
              <ThreadTitle className="thread-card-title" title={savedDraft} pending={false} />
            </button>
          </div>
        </>}
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
            <ScheduledCountBadge threadPrompts={thread.scheduled ?? 0} label={`${thread.scheduled ?? 0} scheduled prompts in this archived thread`} />
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
    {browsing && <RemoteFolderBrowser device={device} name={name} canClone={Boolean(context?.capabilities.terminal)} onClose={() => setBrowsing(false)} onAdded={() => { setBrowsing(false); refreshRemoteDevice(device); }} />}
  </div>;
}

/** Sits over the local main pane, which stays mounted and laid out underneath. */
export function RemoteConversation({ device, notifications, leaving, sidebarOpen, chatFont, voiceInput, actions, studioToggle, modelFavorites, onToggleModelFavorite, headerUsageWindows, onHeaderUsageWindow, usageDisplay, onShowSidebar, onManageDevices, onOpenTool }: {
  device: string;
  /** This person's chosen quota window per provider, the same choice the local header keeps. */
  headerUsageWindows?: HeaderUsageWindows;
  onHeaderUsageWindow?: (provider: "openai" | "claude", label: string) => void;
  usageDisplay?: UsageDisplayMode;
  /** This person's starred models, the same ones the local pickers show. */
  modelFavorites?: ModelFavorites;
  onToggleModelFavorite?: (provider: Provider, model: string) => void;
  /** The notifications setting on this device. */
  notifications: boolean;
  /** The user has already chosen another machine and this is on its way out. */
  leaving: boolean;
  sidebarOpen: boolean;
  chatFont: ChatFont;
  voiceInput?: VoiceInputConfig;
  actions: ReactNode;
  studioToggle: ReactNode;
  onShowSidebar: () => void;
  onManageDevices: () => void;
  onOpenTool: (tab: StudioTab, gitView?: GitView) => void;
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
  const timelineRef = useRef<readonly WireMessage[]>(NO_WIRE_MESSAGES);
  timelineRef.current = timeline?.messages ?? NO_WIRE_MESSAGES;
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
  const shownThread = compose ? undefined : remote?.threadId ?? undefined;
  const allEchoes = useRemoteEchoes((state) => state.echoes);
  const echoes = useMemo(() => allEchoes.filter((echo) => echo.device === device && (echo.draftKey === draftKey || (shownThread !== undefined && echo.threadId === shownThread))), [allEchoes, device, draftKey, shownThread]);
  // Already in the thread, so showing it again would be a duplicate.
  const arrived = useMemo(() => {
    const rows = !compose && timeline ? timeline.messages : NO_WIRE_MESSAGES;
    return new Set(echoes.filter((echo) => rows.filter((row) => row.role === "user" && row.text === echo.text).length > echo.known
      || (echo.queued && (!compose && timeline?.queuedTurns.some((row) => row.text === echo.text)))).map((echo) => echo.id));
  }, [compose, echoes, timeline]);
  useEffect(() => { for (const echo of echoes) if (echo.accepted && arrived.has(echo.id)) removeRemoteEcho(echo.id); }, [arrived, echoes]);
  const [notice, setNotice] = useState("");
  const queueEditScope = `${device}/${threadId ?? "new"}`;
  const queueRowIds = useMemo(() => !compose && timeline?.state === "live" ? timeline.queuedTurns.map((entry) => entry.id) : null, [compose, timeline?.queuedTurns, timeline?.state]);
  const { isEditing, begin: beginQueueEdit, finish: finishQueueEdit } = useRemoteQueueEdit({ device, name, threadId, workspaceId: workspaceId ?? undefined, draftScope: queueEditScope, rowIds: queueRowIds, onNotice: setNotice });
  const [allSchedules, setSchedules] = useState<QueuedTurn[]>(NO_QUEUE);
  // One render can pass before the effect below clears them, so these never show on another thread.
  const schedules = useMemo(() => allSchedules.filter((entry) => entry.threadId === threadId), [allSchedules, threadId]);
  const scheduleRead = useRef(0);
  const projectedMessages = useMemo(() => {
    const known = !compose && timeline ? timeline.messages.map(messageForTimeline) : NO_MESSAGES;
    const held = new Set(pending.map((entry) => entry.opId));
    const waiting = [
      ...pending.filter((entry) => entry.op !== "prompt.queue" && !arrived.has(entry.opId)).map(messageForEntry),
      ...echoes.filter((echo) => !echo.queued && !held.has(echo.id) && !arrived.has(echo.id)).map(messageForEcho),
    ];
    return waiting.length ? [...known, ...waiting] : known;
  }, [arrived, compose, echoes, pending, timeline?.messages]);
  const projectedActivities = useMemo(() => !compose && timeline ? timeline.activities.map(activityForTimeline) : NO_ACTIVITIES, [compose, timeline?.activities]);
  const queuedTurns = useMemo<QueuedTurn[]>(() => [
    ...(!compose && timeline ? timeline.queuedTurns.map((entry) => ({
      id: entry.id, threadId: remote?.threadId ?? "", text: entry.text, attachments: entry.attachmentNames?.length ? entry.attachmentNames.map((attachment) => ({ path: attachment, name: attachment, kind: "file" as const })) : NO_ATTACHMENTS, createdAt: entry.createdAt, status: entry.status,
      ...(isEditing(entry.id) ? { editing: true } : {}),
    })) : []),
    ...schedules,
    ...pending.filter((entry) => entry.op === "prompt.queue").map((entry): QueuedTurn => ({
      id: entry.opId, threadId: entry.threadId ?? "", text: entry.text, attachments: NO_ATTACHMENTS, createdAt: entry.createdAt,
      // Only a send in flight is "sending". Anything else shows what is actually known.
      status: entry.state === "sending" ? "sending" : "failed", error: outboxStatus(entry, name),
    })),
    ...echoes.filter((echo) => echo.queued && !arrived.has(echo.id) && !pending.some((entry) => entry.opId === echo.id)).map((echo): QueuedTurn => ({
      id: echo.id, threadId: echo.threadId ?? "", text: echo.text, attachments: NO_ATTACHMENTS, createdAt: 0, status: "sending",
    })),
  ], [arrived, compose, echoes, isEditing, name, pending, remote?.threadId, schedules, timeline?.queuedTurns]);
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
  const [reaching, setReaching] = useState(false);
  const tryReaching = () => {
    setReaching(true);
    void remoteFindNearby().then(acceptRemoteSnapshot).catch(() => setNotice(`Mythra Code couldn't try ${name} again. Try again.`)).finally(() => setReaching(false));
  };
  const settling = state === "stale" && connected;
  const outlasted = useOutlasted(settling, SETTLE_MS);
  const stillSettling = settling && !outlasted;
  const banner = !machine && snapshot ? `${name} isn't paired with this device anymore. Choose another device from the switcher.` : help ?? (stillSettling ? null : connectionLabel(state, name));
  const scope = useMemo<RemoteThreadScope | null>(() => threadId ? { device, name, threadId, connected, ...(workspaceId ? { workspaceId } : {}) } : null, [connected, device, name, threadId, workspaceId]);
  const timelineQuestions = useMemo(() => new Set(timeline?.messages.flatMap((message) => message.questions?.map((question) => question.id) ?? [])),
    [timeline?.messages]);
  const context = useHostContext(device, workspaceId, threadId);
  const header = context?.header;
  const [uploads, setUploads] = useState<Record<string, AttachmentRecord[]>>({});
  const attachments = uploads[draftKey] ?? NO_ATTACHMENTS;
  const dropHover = useActiveMachine((state) => state.remoteDropHover);
  const [draftTokens, setDraftTokens] = useState<Record<string, DraftToken>>({});
  const draftTokenRef = useRef<Record<string, DraftToken>>({});
  const draftWork = useRef(new Map<string, { generation: number; tail: Promise<DraftToken | null> }>());
  const [draftChoice, setDraftChoice] = useState<Record<string, RemoteSettingsChange>>({});
  // A picker shows the choice at once. The host's own answer takes over when it comes.
  const [threadChoice, setThreadChoice] = useState<Record<string, RemoteSettingsChange>>({});
  const chosen = compose ? draftChoice[draftKey] : threadId ? threadChoice[threadId] : undefined;
  const provider: Provider = chosen?.provider ?? context?.selected.provider ?? thread?.provider ?? "openai";
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const [findIndex, setFindIndex] = useState(0);
  const findInput = useRef<HTMLInputElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const composerRef = useRef<ComposerHandle>(null);
  const [editingProject, setEditingProject] = useState(false);
  const canWork = threadId ? capabilities !== null : true;
  const viewOnly = Boolean(threadId && capabilities === null);
  const canRun = Boolean(context?.capabilities.terminal);
  const blockedIsolation = context?.execution?.isolationBlocked;
  const isolationReason = blockedIsolation === "repository" ? `Needs a Git repository on ${name}` : blockedIsolation === "root" ? "Open the repository root folder" : blockedIsolation === "commit" ? "Requires at least one Git commit"
    : blockedIsolation === "terminal" || context?.execution?.canCreateIsolated === false ? accessReason(name, "create worktrees", "Terminal") : undefined;
  const revision = context?.revision ?? "";
  /** Same as the local new-thread choice: a project without a repository or a
   * first commit offers to make one, on the host, instead of a worktree. */
  const initChoice = blockedIsolation === "repository" ? "init" as const : blockedIsolation === "commit" ? "snapshot" as const : null;
  const canGitWrite = Boolean(context?.capabilities.gitWrite && context.capabilities.terminal);
  const [gitInitializing, setGitInitializing] = useState(false);
  const initializeGit = async () => {
    if (!workspaceId || gitInitializing) return;
    if (!canGitWrite) { setNotice(accessReason(name, "set up Git", "Git changes and Terminal")); return; }
    setGitInitializing(true);
    const outcome = await hostWrite(device, name, "git.write", { ...parityTarget, revision, action: "init" });
    setGitInitializing(false);
    if (!outcome.ok) { setNotice(outcome.message); return; }
    // The choice turning into "Isolated worktree" is the confirmation; this banner is for problems.
    setNotice("");
    void refreshRemoteContext(device, workspaceId, threadId);
  };
  const parityTarget = useMemo(() => ({ ...(workspaceId ? { workspaceId } : {}), ...(threadId ? { threadId } : {}) }), [threadId, workspaceId]);
  const { handle: runHandle, latest: lastRun, set: setRunHandle } = useRemoteCommand(device, "run.status", parityTarget, connected);
  // Run prints where it does locally: into the Terminal tab of that project.
  const expectedRun = useRemoteTerminals((state) => workspaceId ? state.expected[remoteTerminalKey(device, workspaceId)] : undefined);
  useEffect(() => {
    if (!workspaceId || !lastRun?.command) return;
    const live = lastRun.status === "starting" || lastRun.status === "running";
    remoteTerminal(device, workspaceId).mirror(lastRun.id, lastRun.command, lastRun.text ?? "", live ? null : lastRun.status === "completed" && !lastRun.value ? "Finished." : `Stopped${lastRun.value === undefined ? "" : ` · exit ${lastRun.value}`}.`, lastRun.id === expectedRun);
  }, [device, expectedRun, lastRun, workspaceId]);
  useEffect(() => { if (expectedRun) setRunHandle(expectedRun); }, [expectedRun, setRunHandle]);
  const runDiscovery = useRemoteDiscovery(device, name, "run", parityTarget, revision);
  const report = useCallback((outcome: { ok: boolean; message: string }) => { setNotice(outcome.message); return outcome.ok; }, []);
  const upload = useCallback(async (files: readonly File[]) => {
    if (!workspaceId) { setNotice(`Choose a workspace on ${name} first.`); return; }
    for (const file of files) {
      const result = await uploadToHost(device, name, workspaceId, file);
      if (result.ok) setUploads((current) => ({ ...current, [draftKey]: [...(current[draftKey] ?? []), { path: result.id, name: result.name, kind: result.kind, ...(result.originalHostPath ? { displayPath: result.originalHostPath } : {}) }] }));
      else setNotice(result.message);
    }
  }, [device, draftKey, name, workspaceId]);
  const refreshSchedules = useCallback(() => {
    const read = ++scheduleRead.current;
    if (!threadId || !workspaceId) { setSchedules(NO_QUEUE); return; }
    hostRead<WireParityReadResult>(device, "schedules.read", parityTarget).then((result) => {
      if (read !== scheduleRead.current) return;
      setSchedules(hostRows(result).flatMap((row): QueuedTurn[] => row.deliverAt ? [{ id: row.id, threadId, text: row.text ?? "", attachments: NO_ATTACHMENTS,
        createdAt: row.createdAt ?? Date.now(), status: "queued", deliverAt: row.deliverAt }] : []));
    }, () => { if (read === scheduleRead.current) setSchedules(NO_QUEUE); });
  }, [device, parityTarget, threadId, workspaceId]);
  useEffect(() => { setSchedules(NO_QUEUE); refreshSchedules(); }, [refreshSchedules]);
  useEffect(() => { setFindOpen(false); setFindQuery(""); }, [threadId]);
  const findCount = useMemo(() => {
    const words = findQuery.trim().toLowerCase();
    if (!words) return 0;
    return projectedMessages.reduce((total, message) => total + (message.text.toLowerCase().split(words).length - 1), 0);
  }, [findQuery, projectedMessages]);
  const exportTranscript = useCallback(async () => {
    if (!threadId) return;
    const label = thread?.title || thread?.preview || "Mythra Code thread";
    const path = await save({ title: `Export conversation from ${name}`, defaultPath: `${label.replace(/[\\/:*?"<>|]/g, "-").slice(0, 60).trim() || "mythra-thread"}.md`, filters: [{ name: "Markdown", extensions: ["md"] }] });
    if (!path) return;
    const { buildTranscriptMarkdown } = await import("../../lib/transcript");
    // The whole conversation, including what has scrolled out of the window here.
    const whole = await readRemoteTranscript(device, threadId);
    await exportTextFile(path, buildTranscriptMarkdown(`${label} (${name})`, whole.messages.map(messageForTimeline), whole.activities.map(activityForTimeline)));
    if (!whole.complete) setNotice(`That conversation is very long, or part of it couldn't be read, so the saved file has only its most recent part.`);
  }, [device, name, thread?.preview, thread?.title, threadId]);
  // Handles belong to one moment on the host. Ask again whenever that moment
  // changes, and hold no controls for a thread or link that has gone.
  const approvalsKey = timeline?.approvals.map((entry) => entry.id).join(",");
  useEffect(() => {
    if (!threadId || !connected) { clearRemoteCapabilities(device); return; }
    void refreshRemoteCapabilities(device, threadId);
  }, [approvalsKey, connected, device, threadId, timeline?.activeTurnId, timeline?.status]);
  useEffect(() => {
    if (!connected) return;
    void reconcileRemoteOutbox(device, name);
    void alignRemoteDevice(device).catch(() => undefined);
  }, [connected, device, name]);
  // The host's revision moves with the conversation, so an old one would refuse the next change.
  const timelineStatus = timeline?.status, timelineTurn = timeline?.activeTurnId, timelineLength = timeline?.messages.length, queueLength = timeline?.queuedTurns.length;
  useEffect(() => {
    if (connected && workspaceId) void refreshRemoteContext(device, workspaceId, threadId);
  }, [connected, device, queueLength, threadId, timelineLength, timelineStatus, timelineTurn, workspaceId]);
  // Labeled with the machine, because this device did none of the work.
  const announce = useCallback((about: { id: string }, title: string, body: string) => {
    addRemoteNotice({ id: `${device}/${about.id}`, machine: device, name, title, body, open: () => selectRemoteThread(device, about.id) });
    if (notifications) void isPermissionGranted().then((granted) => { if (granted) sendNotification({ title, body }); }).catch(() => undefined);
  }, [device, name, notifications]);
  const lastSeen = useRef({ threadId, running, approvals: 0 });
  useEffect(() => {
    const before = lastSeen.current;
    const approvals = timeline?.approvals.length ?? 0;
    lastSeen.current = { threadId, running, approvals };
    if (before.threadId !== threadId || !thread || document.hasFocus()) return;
    const title = approvals > before.approvals ? "Mythra Code needs your approval" : before.running && !running ? "Mythra Code task complete" : null;
    if (!title) return;
    const body = `“${thread.title || thread.preview || "A thread"}” on ${name}`;
    announce(thread, title, body);
  }, [announce, name, running, thread, threadId, timeline?.approvals.length]);
  // Other threads over there have no open timeline, so this is how they're heard from.
  const announceRef = useRef({ announce, threadId });
  announceRef.current = { announce, threadId };
  useEffect(() => {
    if (!connected || leaving || !workspaceId) return;
    let current = true;
    const look = () => {
      void watchRemoteThreads(device).then((changes) => {
        if (!current) return;
        for (const { thread: changed, kind } of changes) {
          if (changed.id === announceRef.current.threadId) continue;
          announceRef.current.announce(changed, kind === "waiting" ? "Mythra Code needs your approval" : "Mythra Code task complete",
            `“${changed.title || changed.preview || "A thread"}” on ${name}`);
        }
        const rows = useRemoteStore.getState().devices[device]?.lists.get(workspaceId)?.threads.filter((row) => row.id !== announceRef.current.threadId && !row.archived) ?? [];
        const next = { working: rows.filter((row) => row.status === "running" || row.status === "starting").length, approvals: rows.filter((row) => row.waiting).length };
        const before = useActiveMachine.getState().remoteElsewhere;
        if (before.working !== next.working || before.approvals !== next.approvals) useActiveMachine.setState({ remoteElsewhere: next });
      }, () => undefined);
    };
    const timer = setInterval(look, WATCH_MS);
    return () => { current = false; clearInterval(timer); useActiveMachine.setState({ remoteElsewhere: { working: 0, approvals: 0 } }); };
  }, [connected, device, leaving, name, workspaceId]);
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
  /** Every launch is reviewed first, as it is here: the same dialog, with its inputs. */
  const workflowProjects = useMemo(() => remote?.workspaces.filter((entry) => !entry.isChat) ?? [], [remote?.workspaces]);
  const { review: reviewWorkflow, dialog: workflowDialog } = useRemoteWorkflowLaunch({ device, name, workspaceId, threadId, revision, projects: workflowProjects, onNotice: setNotice });
  useEffect(() => {
    if (leaving) return;
    setMachineActions({
      dropFiles,
      stopTurn: () => { if (running || starting) stop(); },
      newThread: () => { if (workspaceId) setNewThreadTarget(device, newThreadTargetFor(workspaceId)); },
      forkThread: () => {
        // Opens the new conversation, as a local fork does.
        if (!threadId || !workspaceId) return;
        const fromThread = threadId, fromWorkspace = workspaceId;
        void forkRemoteThread(device, name, fromThread).then(async (result) => {
          if ("failure" in result) { setNotice(result.failure); return; }
          // Opened once the host lists it, and only if the person hasn't moved on.
          const stillHere = () => { const view = useRemoteStore.getState().devices[device]; return view?.workspaceId === fromWorkspace && view.threadId === fromThread && !useRemoteOutbox.getState().compose[device]; };
          await openRemoteThread(device, fromWorkspace, result.threadId, stillHere);
        });
      },
      findInConversation: () => { if (threadId) { setFindOpen(true); requestAnimationFrame(() => findInput.current?.focus()); } },
      attachHostFile: (fileId) => {
        if (!canWork) { setNotice(WORK_SWITCH(name)); return; }
        void hostWrite<{ attachmentId?: string; name?: string; kind?: "image" | "file"; originalHostPath?: string }>(device, name, "attachment.reference", { ...parityTarget, revision, fileId }).then((outcome) => {
          const { attachmentId, name: fileName, kind, originalHostPath } = outcome.result ?? {};
          if (!outcome.ok || !attachmentId || !fileName || !kind) { setNotice(outcome.message); return; }
          setUploads((current) => ({ ...current, [draftKey]: [...(current[draftKey] ?? []), { path: attachmentId, name: fileName, kind, ...(originalHostPath ? { displayPath: originalHostPath } : {}) }] }));
          composerRef.current?.focus();
        });
      },
      exportTranscript: () => { void exportTranscript().catch(() => setNotice("Mythra Code couldn't save that file.")); },
      runWorkflow: (id) => { void reviewWorkflow(id); },
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
  }, [canWork, device, draftKey, dropFiles, exportTranscript, leaving, name, parityTarget, report, reviewWorkflow, revision, running, starting, stop, threadId, timeline?.approvals.length, workspaceId]);
  const storeDraftToken = useCallback((key: string, token: DraftToken | null) => {
    const { [key]: _previous, ...rest } = draftTokenRef.current;
    draftTokenRef.current = token ? { ...rest, [key]: token } : rest;
    setDraftTokens(draftTokenRef.current);
  }, []);
  /** One at a time per draft, newest wins. A token always answers the choices last
   * shown, so a send can't start with an older model or permission. */
  /**
   * One lane per draft. Every choice adds to what the draft should be; the lane
   * sends whatever still differs from what the host last confirmed, in order,
   * so no change is ever dropped because a later one arrived. The worktree
   * choice goes through its own prepared check first.
   */
  const desiredDraft = useRef<Record<string, RemoteSettingsChange>>({});
  const confirmedDraft = useRef<Record<string, RemoteSettingsChange>>({});
  const [draftUnconfirmed, setDraftUnconfirmed] = useState<Record<string, boolean>>({});
  const syncDraft = useCallback((key: string, change: RemoteSettingsChange = {}) => {
    desiredDraft.current[key] = { ...desiredDraft.current[key], ...change };
    const slot = draftWork.current.get(key) ?? { generation: 0, tail: Promise.resolve<DraftToken | null>(null) };
    draftWork.current.set(key, slot);
    slot.generation += 1;
    slot.tail = slot.tail.catch(() => null).then(async () => {
      if (!workspaceId) return null;
      for (let step = 0; step < 4; step += 1) {
        const desired = desiredDraft.current[key] ?? {};
        const confirmed = confirmedDraft.current[key] ?? {};
        const token = draftTokenRef.current[key];
        const isolation = desired.isolated !== undefined && desired.isolated !== (confirmed.isolated ?? false);
        const others = (Object.keys(desired) as (keyof RemoteSettingsChange)[]).some((field) => field !== "isolated" && desired[field] !== confirmed[field]);
        if (token && !isolation && !others) return token;
        if (isolation) {
          const result = await setRemoteDraftIsolation(device, name, workspaceId, Boolean(desired.isolated), token?.handle);
          if ("failure" in result) {
            setNotice(result.failure);
            storeDraftToken(key, null);
            if (/^We couldn't confirm/.test(result.failure)) {
              // Unknown, not refused: the choice stays, marked, and is checked again on send.
              setDraftUnconfirmed((current) => ({ ...current, [key]: true }));
            } else {
              // Refused: back to what the host last confirmed.
              const previous = confirmed.isolated ?? false;
              desiredDraft.current[key] = { ...desiredDraft.current[key], isolated: previous };
              setDraftChoice((current) => ({ ...current, [key]: { ...current[key], isolated: previous } }));
              setDraftUnconfirmed((current) => ({ ...current, [key]: false }));
            }
            return null;
          }
          confirmedDraft.current[key] = { ...confirmed, isolated: result.settings.isolated };
          setDraftUnconfirmed((current) => current[key] ? { ...current, [key]: false } : current);
          storeDraftToken(key, { handle: result.draftHandle, startTarget: result.startTarget });
          continue;
        }
        const outcome = await hostWrite<{ draftHandle?: string; startTarget?: string }>(device, name, "draft.settings.set", { workspaceId, ...(token ? { draftHandle: token.handle } : {}), ...desired });
        const handle = outcome.result?.draftHandle;
        if (!outcome.ok || !handle) {
          if (!outcome.ok) setNotice(outcome.message);
          // The old token no longer matches what's on screen. What's wanted is kept for the next try.
          storeDraftToken(key, null);
          return null;
        }
        confirmedDraft.current[key] = { ...desired };
        storeDraftToken(key, { handle, ...(outcome.result?.startTarget ? { startTarget: outcome.result.startTarget } : {}) });
      }
      return draftTokenRef.current[key] ?? null;
    });
    return slot.tail;
  }, [device, name, storeDraftToken, workspaceId]);
  const deliver = useCallback(async (typed: string, mode: "send" | "queue" | "steer", handle?: string): Promise<RemoteSendOutcome> => {
    setNotice("");
    if (!connected) return { status: "rejected", message: `Your draft is saved. You can send once ${name} is connected.` };
    if (!threadId && !workspaceId) return { status: "rejected", message: `Choose a workspace on ${name} first.` };
    if (threadId && capabilities === null) return { status: "rejected", message: `This device can view ${name} but can't work on it. ${WORK_SWITCH(name)}` };
    // On screen straight away, as it is locally. Everything below happens behind it.
    const opId = crypto.randomUUID();
    const notes = useRemoteFeedback.getState().drafts[draftKey] ?? NO_NOTES;
    const text = notes.length ? formatFeedbackPrompt(typed, notes) : typed;
    const body = text.trim();
    addRemoteEcho({ id: opId, device, draftKey, text: body, queued: mode === "queue", ...(threadId ? { threadId } : {}),
      known: threadId ? timelineRef.current.filter((row) => row.role === "user" && row.text === body).length : 0 });
    const attachmentIds = (uploads[draftKey] ?? NO_ATTACHMENTS).map((entry) => entry.path);
    // Asked for first so Stop has something to name while the thread is starting.
    // Any change still on its way finishes first, and a send never goes without one.
    let draftHandle: string | undefined;
    if (!threadId) {
      // Anything chosen but not yet confirmed goes first; a send never uses older choices.
      draftHandle = (await syncDraft(draftKey))?.handle;
      if (!draftHandle) { removeRemoteEcho(opId); return { status: "rejected", message: `Mythra Code couldn't set up this thread on ${name}. Your draft is saved. Try again.` }; }
    }
    const outcome = await sendRemotePrompt({ device, name, draftKey, text, mode, opId,
      ...(threadId ? { threadId } : { workspaceId }), ...(handle ? { handle } : {}), ...(draftHandle ? { draftHandle } : {}),
      ...(attachmentIds.length ? { attachmentIds } : {}), ...(notes.length ? { skillInvocationText: feedbackSkillInvocationText(typed, notes) } : {}) });
    if (outcome.status === "rejected") { removeRemoteEcho(opId); setNotice(outcome.message); }
    else {
      setUploads((current) => { const next = { ...current }; delete next[draftKey]; return next; });
      if (notes.length) removeSentRemoteFeedback(draftKey, notes);
    }
    // A draft handle works for one send.
    if (!threadId) { storeDraftToken(draftKey, null); confirmedDraft.current[draftKey] = {}; }
    return outcome;
  }, [capabilities, connected, device, draftKey, name, syncDraft, storeDraftToken, threadId, uploads, workspaceId]);
  // Only while this conversation is the one on screen.
  useEffect(() => {
    if (leaving) return;
    captureDroppedFiles(true);
    return () => captureDroppedFiles(false);
  }, [leaving]);
  useEffect(() => {
    if (leaving) return;
    setRemoteFeedbackScope(threadId ? draftKey : null);
    return () => setRemoteFeedbackScope(null);
  }, [draftKey, leaving, threadId]);
  const notes = useRemoteFeedback((state) => state.drafts[draftKey] ?? NO_NOTES);
  const parentTitle = useRemoteStore((state) => { const entry = state.devices[device]?.lists.get(workspaceId ?? "")?.threads.find((row) => row.id === thread?.parentThreadId); return entry?.title || entry?.preview || "Parent thread"; });
  // Where a handed-off thread came from. The host only names sources this device may open.
  const [lineage, setLineage] = useState<WireResourceResult["lineage"]>();
  useEffect(() => {
    setLineage(undefined);
    if (!threadId || !workspaceId || !connected) return;
    let current = true;
    hostRead<WireResourceResult>(device, "thread.handoff.lineage", { workspaceId, threadId }).then((result) => { if (current) setLineage(result.lineage); }, () => undefined);
    return () => { current = false; };
  }, [connected, device, threadId, workspaceId]);
  // Queued steers are read from the host while any is waiting, as the local row follows its runtime.
  // Everything is tagged with the conversation it belongs to, so one thread's answer never lands on another.
  const steerScope = `${device}/${workspaceId ?? ""}/${threadId ?? ""}`;
  const steerScopeRef = useRef(steerScope);
  steerScopeRef.current = steerScope;
  const [steerState, setSteerState] = useState<{ scope: string; steers: ReadonlyMap<string, WireQueuedSteer>; available: boolean; requested: ReadonlySet<string> }>(
    () => ({ scope: steerScope, steers: new Map(), available: true, requested: new Set() }));
  const steerWaiting = !compose && Boolean(timeline?.messages.some((message) => message.steerStatus === "queued"));
  const steerInFlight = useRef(false);
  const steerGeneration = useRef(0);
  const readSteers = useCallback(() => {
    const scope = steerScope;
    if (!threadId || !workspaceId || !connected || steerInFlight.current) return;
    steerInFlight.current = true;
    const generation = steerGeneration.current;
    const current = () => generation === steerGeneration.current && steerScopeRef.current === scope;
    listRemoteSteers(device, workspaceId, threadId).then((list) => {
      if (!current()) return;
      setSteerState((state) => ({ scope, steers: new Map(list.steers.flatMap((steer) => steer.messageId ? [[steer.messageId, steer] as const] : [])), available: true,
        requested: state.scope === scope ? state.requested : new Set() }));
    }, () => { if (current()) setSteerState((state) => ({ ...(state.scope === scope ? state : { steers: new Map(), requested: new Set() }), scope, available: false })); })
      .finally(() => { if (generation === steerGeneration.current) steerInFlight.current = false; });
  }, [connected, device, steerScope, threadId, workspaceId]);
  useEffect(() => {
    steerGeneration.current += 1;
    steerInFlight.current = false;
    if (!steerWaiting) { setSteerState({ scope: steerScope, steers: new Map(), available: true, requested: new Set() }); return; }
    readSteers();
    const timer = setInterval(readSteers, 3_000);
    return () => { clearInterval(timer); steerGeneration.current += 1; steerInFlight.current = false; };
  }, [readSteers, steerScope, steerWaiting, timelineLength]);
  const steerControls = useMemo(() => ({
    steers: steerState.scope === steerScope ? steerState.steers : new Map<string, WireQueuedSteer>(),
    available: steerState.scope !== steerScope || steerState.available,
    requested: steerState.scope === steerScope ? steerState.requested : new Set<string>(),
    deliver: async (steer: WireQueuedSteer) => {
      const scope = steerScope;
      if (!workspaceId || !threadId || !steer.turnId || !steer.runtimeId) return `This message can't be sent now from ${name}.`;
      const problem = await deliverRemoteSteerNow(device, name, workspaceId, threadId, steer.turnId, steer.runtimeId);
      // The host took the request for exactly this turn and runtime. That is not a read.
      if (!problem && steerScopeRef.current === scope) setSteerState((state) => state.scope === scope ? { ...state, requested: new Set([...state.requested, steerKey(steer)]) } : state);
      if (steerScopeRef.current === scope) readSteers();
      return problem;
    } }), [device, name, readSteers, steerScope, steerState, threadId, workspaceId]);
  // A reply that has since changed is marked. One that isn't loaded is unknown, so it isn't.
  const staleNotes = useMemo(() => notes.filter(({ anchor }) => {
    if (anchor.kind !== "assistant") return false;
    const message = projectedMessages.find((entry) => entry.id === anchor.messageId);
    return message ? isFeedbackAnchorStale(anchor, { message }) : false;
  }).map((note) => note.id), [notes, projectedMessages]);
  const paletteWorkflows = useMemo(() => (context?.workflows ?? []).map((workflow) => ({ id: workflow.id, name: workflow.name, description: workflow.description, enabled: true, steps: [],
    paletteDetail: `On ${name}${workflow.description ? ` · ${workflow.description}` : ""}` })) as unknown as WorkflowDefinition[], [context?.workflows, name]);
  const steerHandle = running && capabilities?.canSteer ? capabilities.steer?.handle : undefined;
  const search = useCallback((query: string) => workspaceId ? searchRemoteFiles(device, workspaceId, threadId, query) : Promise.resolve([]), [device, threadId, workspaceId]);
  const skills = useMemo(() => context?.skills.filter((skill) => skill.enabled).map((skill) => ({ name: skill.name, description: skill.description })), [context?.skills]);
  // A skill named in a message opens the host's copy, as a mention opens Settings → Skills here.
  const skillLinks = useMemo(() => hostSkillLinks(context?.skills), [context?.skills]);
  const [viewingSkill, setViewingSkill] = useState<string | null>(null);
  const openSkill = useCallback((id: string) => { const skill = hostSkillName(id); if (skill) setViewingSkill(skill); }, []);
  useEffect(() => setViewingSkill(null), [device, workspaceId]);
  const analyzeSkills = useRemoteSkillAnalyzer(device, name, parityTarget, context?.skills);
  const changeSettings = (change: RemoteSettingsChange) => {
    if (!workspaceId) return;
    // A started thread keeps its provider, as it does here: another one means a new thread.
    if (threadId && change.provider && change.provider !== thread?.provider) {
      void handOff(change.provider);
      return;
    }
    if (threadId) {
      setThreadChoice((current) => ({ ...current, [threadId]: { ...current[threadId], ...change } }));
      void setRemoteThreadSettings(device, name, { threadId, ...change }, workspaceId).then((message) => {
        setThreadChoice(({ [threadId]: _settled, ...rest }) => rest);
        if (message) setNotice(message);
      });
      return;
    }
    // A new thread's choices wait on the host until its first prompt.
    setDraftChoice((current) => ({ ...current, [draftKey]: { ...current[draftKey], ...change } }));
    // Choosing what is already chosen changes nothing.
    const wanted = { ...draftChoice[draftKey], ...change };
    if ((Object.keys(change) as (keyof RemoteSettingsChange)[]).every((field) => field === "isolated" ? Boolean(change.isolated) === Boolean(draftChoice[draftKey]?.isolated) : change[field] === draftChoice[draftKey]?.[field])) return;
    void syncDraft(draftKey, wanted);
  };
  /** The same handoff as local: a confirmation, then a new thread with a briefing to edit and send. */
  const [handoffDrafts, setHandoffDrafts] = useState<Record<string, { from: Provider; to: Provider }>>({});
  const handOff = async (provider: Provider) => {
    if (!workspaceId || !threadId) return;
    if (running) { setNotice("Stop the running task before starting a thread with another provider."); return; }
    if (context?.execution?.isolated) { setNotice("Provider handoff is unavailable while this conversation owns an isolated worktree. Apply or merge its changes, remove the worktree, then continue in the shared project."); return; }
    if (!await confirmDialog(`Hand off this thread on ${name}?\n\nA separate thread starts in the same workspace, with a briefing of this conversation to review before you send it.`)) return;
    let prompt: string | undefined, handoffHandle: string | undefined;
    try { ({ prompt, handoffHandle } = hostRows(await hostRead<WireParityReadResult>(device, "thread.handoff.read", { ...parityTarget, provider }))[0] ?? {}); }
    catch { setNotice(`Mythra Code couldn't prepare the handoff on ${name}. Try again.`); return; }
    if (!prompt) { setNotice(`${name} didn't prepare a handoff for this thread.`); return; }
    const target = newThreadTargetFor(workspaceId);
    const key = newThreadDraftKey(device, target);
    setDraftChoice((current) => ({ ...current, [key]: { provider } }));
    seedComposerDraft(key, prompt);
    setHandoffDrafts((current) => ({ ...current, [key]: { from: thread?.provider ?? provider, to: provider } }));
    setNewThreadTarget(device, target);
    // The host keeps where this came from, so the new thread can name its source.
    void syncDraft(key, { provider, ...(handoffHandle ? { handoffHandle } : {}) });
  };
  const copyWorktreePath = () => {
    // The header already names this folder on the host; it is copied, never opened here.
    if (header?.checkout === "worktree" && header.executionPath) { void navigator.clipboard.writeText(header.executionPath).catch(() => undefined); return; }
    hostRead<{ worktree?: { path?: string } | null }>(device, "worktree.status", parityTarget).then((result) => {
      if (result?.worktree?.path) void navigator.clipboard.writeText(result.worktree.path).catch(() => undefined);
      else setNotice(`${name} didn't share this path.`);
    }, () => setNotice(`Mythra Code couldn't read the worktree's path on ${name}. Try again.`));
  };
  const timelineEnvironment = useMemo<TimelineEnvironment>(() => ({
    ...REMOTE_ENVIRONMENT,
    skillLinkTitle: (skill) => `Open @${skill} on ${name}`,
    // `localhost` here means the other machine, so it goes through a preview.
    canOpenLink: (url) => isPublicWebLink(url) || (canWork && hostLocalPort(url) !== null),
    openExternalUrl: async (url) => {
      if (isPublicWebLink(url)) return openUrl(url);
      const port = hostLocalPort(url);
      if (port === null || !workspaceId) return;
      try {
        const match = (await listRemotePreviews(device, workspaceId, threadId)).find((entry) => entry.port === port);
        if (!match) { setNotice(`That web app isn't available from ${name} right now.`); return; }
        setNotice((await openRemotePreview(device, match.endpointId, hostLinkPath(url))).notice);
      } catch { setNotice(`Mythra Code couldn't open that preview from ${name}. Check that it's still running.`); }
    },
  }), [canWork, device, name, threadId, workspaceId]);
  const awaiting = timeline?.approvals.length ? timeline.approvals.some((entry) => entry.kind === "question") ? "input" as const : "approval" as const : null;
  // The host's account windows in the local popover. Which window shows is this person's choice.
  const quota = provider === "openai" || provider === "claude" ? context?.quotas?.find((entry) => entry.provider === provider) : undefined;
  const quotaUsage = useMemo(() => quota ? hostQuotaAccountView(quota, usageDisplay) : null, [quota, usageDisplay]);
  const quotaHeader = useMemo(() => quotaUsage ? providerHeaderUsage(provider, quotaUsage, { selectedWindow: provider === "openai" || provider === "claude" ? headerUsageWindows?.[provider] : undefined }) : null, [headerUsageWindows, provider, quotaUsage]);
  const contextPercent = context?.usage?.contextTokens && context.usage.contextWindow ? Math.round(context.usage.contextTokens / context.usage.contextWindow * 100) : null;
  const known = Boolean(compose || (thread && timeline?.baseline) || pending.length || echoes.length);
  const waiting = state === "removed" ? `This thread is not available from ${name}.` : thread ? "" : remote?.loading ? "" : `Choose a thread on ${name}, or start a new one.`;
  // The moment someone first switches: never a blank page, and always the next step.
  const guide = !connected || state === "removed" ? null : remoteGuide({ name, loading: Boolean(remote?.loading), workspaces: remote ? remote.workspaces : null, chosenWorkspace: Boolean(workspaceId) && !workspace?.isChat || Boolean(compose) || Boolean(thread),
    providers: context ? context.providers : null, canWork: viewOnly === false, canAddProjects: Boolean(context?.capabilities.manageProjects) });
  const checkAgain = () => { refreshRemoteDevice(device); if (workspaceId) void refreshRemoteContext(device, workspaceId, threadId); };
  const guideCard = guide && <RemoteGuideCard guide={guide} onAddProject={() => useActiveMachine.setState((current) => ({ remoteAddProject: current.remoteAddProject + 1 }))}
    onOpenChats={() => { const chats = remote?.workspaces.find((entry) => entry.isChat); if (chats) { selectRemoteWorkspace(device, chats.id); setNewThreadTarget(device, newThreadTargetFor(chats.id)); } }} onCheckAgain={checkAgain} />;
  return <section className="remote-stage" data-remote-device={device} inert={leaving || undefined} aria-label={`Conversation on ${name}`}>
    <header className="topbar">
      <div className="topbar-left">
        {!sidebarOpen && <button className="icon-button" onClick={onShowSidebar} title="Show sidebar" aria-label="Show sidebar"><PanelLeftOpen size={18} /></button>}
        <div className="project-heading">
          <span>{workspace?.isChat ? "Normal chat" : workspace?.name ?? name}</span>
          {/* As here: an isolated thread names its branch and folder, a project with no thread its folder. Always on that machine. */}
          <small title={header ? header.executionPath : undefined}>{name}{compose ? " · New thread"
            : header?.checkout === "worktree" && header.worktreeStatus !== "removed" && thread ? ` · ${header.branch ? `${header.branch} · ` : ""}${header.executionPath}`
            : thread ? ` · ${thread.title || thread.preview || "New thread"}` : header && !workspace?.isChat ? ` · ${header.projectPath}` : ""}</small>
        </div>
        {thread && context?.execution?.isolated && <button className="isolation-chip" title={header?.checkout === "worktree" ? `${header.executionPath} · Copy path` : "Copy path"} onClick={copyWorktreePath}>
          <GitBranch size={12} /> <span>Isolated</span>
        </button>}
        {workspace && !workspace.isChat && workspaceId && <RemotePullRequestChip key={`${workspaceId}:${threadId ?? ""}`} device={device} name={name} target={parityTarget} connected={connected} onOpen={() => onOpenTool("git", "pulls")} />}
        {thread && lineage?.threadId === thread.id && lineage.sourceThreadId && lineage.sourceProvider && <button className="handoff-chip" title={`Open source task: ${lineage.sourceTitle || "Source thread"}`} onClick={() => selectRemoteThread(device, lineage.sourceThreadId!)}>
          <GitFork size={12} /> <span>From {providerDisplayName(lineage.sourceProvider)}</span>
        </button>}
        {thread?.parentThreadId && <button type="button" className="handoff-chip parent-chip" title={`Open parent conversation: ${parentTitle}`} aria-label={`Open parent conversation: ${parentTitle}`} onClick={() => selectRemoteThread(device, thread.parentThreadId!)}>
          <GitFork size={12} aria-hidden="true" /> <span>Parent: {parentTitle}</span>
        </button>}
        {workspace && !workspace.isChat && <ProjectPromptControl key={workspaceId} projectName={workspace.name} projectPrompt={context?.projectPrompt} promptMode={context?.projectPromptMode ?? "replace"}
          appPrompt="" provider={provider} threadStarted={Boolean(threadId)} skills={skills}
          onSave={(prompt, mode) => {
            if (!context?.capabilities.manageProjects) { setNotice(accessReason(name, "change project instructions", "Manage projects")); return; }
            void hostProjectWrite(device, name, workspaceId!, "projects.instructions.set", { prompt: prompt ?? "", mode }).then((outcome) => { if (report(outcome) && workspaceId) void refreshRemoteContext(device, workspaceId, threadId); });
          }}
          onAppPromptSettings={() => setEditingProject(true)} />}
        {workspace && !workspace.isChat && workspaceId && canWork && <RemotePreviews device={device} workspaceId={workspaceId} threadId={threadId} name={name} onNotice={setNotice} />}
        {workspace && !workspace.isChat && <ProjectRunControl key={`run-${workspaceId}`} projectName={workspace.name}
          run={context?.run ? { ...context.run, updatedAt: 0 } : undefined} running={Boolean(runHandle)}
          onRun={() => {
            if (!canRun) { setNotice(accessReason(name, "run this project", "Terminal")); return; }
            // The host's own reason, e.g. read-only access or a run already going there.
            const blocked = context?.processPolicy?.runBlockedReason ?? context?.processPolicy?.processPolicyReason;
            if (blocked) { setNotice(blocked); return; }
            onOpenTool("terminal");
            void hostWrite<{ processHandle?: string }>(device, name, "run.start", { ...parityTarget, revision }).then((outcome) => { if (report(outcome) && workspaceId && outcome.result?.processHandle) expectRemoteRun(device, workspaceId, outcome.result.processHandle); });
          }}
          onStop={() => { if (runHandle) void hostWrite(device, name, "run.stop", { ...parityTarget, revision, processHandle: runHandle }).then((outcome) => { if (report(outcome)) setRunHandle(null); }); }}
          onSave={(next) => {
            if (!canRun) { setNotice(accessReason(name, "save this command", "Terminal")); return; }
            void hostProjectWrite(device, name, workspaceId!, "projects.run.set", { command: next?.command ?? "", ...(next?.label ? { label: next.label } : {}), ...(next?.setupCommand ? { setupCommand: next.setupCommand } : {}) }).then((outcome) => { if (report(outcome) && workspaceId) void refreshRemoteContext(device, workspaceId, threadId); });
          }} remoteDiscovery={canRun ? runDiscovery : undefined} discoveryModelNote={`The model saved on ${name}${context?.discovery?.model ? ` · ${context.discovery.model}` : ""}`} />}
      </div>
      <div className="topbar-right">
        {thread && <button className="icon-button topbar-export-button" onClick={() => machineActions()?.exportTranscript()} title="Export conversation as Markdown" aria-label="Export conversation as Markdown"><Download size={15} /></button>}
        {actions}
        <div className="runtime-status" title={`Status on ${name}`}>
          {running ? <LoaderCircle className="spin" size={13} /> : <Circle size={8} fill="currentColor" />}
          <span>{running ? "Working" : connected ? "Ready" : "Not connected"}</span>
        </div>
        {quotaUsage && quotaHeader && (provider === "openai" || provider === "claude") ? <UsagePopover key={provider} provider={provider} usage={quotaUsage} header={{ ...quotaHeader, title: `${quotaHeader.title} · on ${name}` }}
          selectedLabel={headerUsageWindows?.[provider]} onSelect={(label) => onHeaderUsageWindow?.(provider, label)}
          onConnect={() => setNotice(`Sign in on ${name} to see its usage.`)} onDetails={() => onOpenTool("usage")}
          onOpen={() => { if (connected && workspaceId) void refreshRemoteContext(device, workspaceId, threadId); }} />
        : contextPercent !== null && <button className="topbar-usage-chip" type="button" title={`Context used on ${name}`} onClick={() => onOpenTool("usage")}>
          <Gauge size={13} aria-hidden="true" /><span>{contextPercent}%</span>
        </button>}
        {studioToggle}
      </div>
    </header>
    <section className="conversation">
      {banner && <div className="remote-banner" role="status"><span>{banner}</span>
        {(help || !machine) && <button type="button" className="secondary-button" onClick={onManageDevices}>Open Devices settings</button>}
        {machine && help && deviceHelpOffersRetry(machine) && <button type="button" className="secondary-button" disabled={reaching} onClick={tryReaching}>Try again</button>}
      </div>}
      {remote?.error && <div className="remote-banner" role="status">{namingDevice(remote.error, name)}</div>}
      {timeline?.error && <div className="remote-banner" role="status">{namingDevice(timeline.error, name)}</div>}
      {!compose && scope && <RemoteRequests scope={scope} summaries={timeline?.approvals ?? NO_APPROVALS} capabilities={capabilities} questionsInTimeline={timelineQuestions} />}
      {!compose && thread && guide && (guide.kind === "noProviders" || guide.kind === "viewOnly") && <div className="remote-banner" role="status"><strong>{guide.title}.</strong> {guide.body}
        <button type="button" className="secondary-button" onClick={checkAgain}>Check again</button></div>}
      {findOpen && threadId && <ConversationSearchBar inputRef={findInput} query={findQuery} index={findIndex} count={findCount}
        onQuery={(query) => { setFindQuery(query); setFindIndex(0); }} onIndex={setFindIndex} onClose={() => { setFindOpen(false); setFindQuery(""); }} />}
      <div className="remote-timeline">
        {!compose && !thread && guideCard ? guideCard : compose && !pending.length && !echoes.length ? <div className="thread-empty-state">
          {guideCard}
          {handoffDrafts[draftKey] && <div className="handoff-draft-banner">
            <GitFork size={15} />
            <span><strong>Provider handoff ready</strong><small>From {providerDisplayName(handoffDrafts[draftKey].from)} · review the visible context below, then send it to {providerDisplayName(handoffDrafts[draftKey].to)}.</small></span>
          </div>}
          {!guideCard && <>
            <AnimatedMythraLogo />
            <h1>{workspace?.isChat ? "Start a normal chat." : "What should we build?"}</h1>
            <p>This conversation runs on {name}, with its files and accounts.</p>
          </>}
          <div className="trust-strip">
            <span><Check size={13} /> {workspace?.isChat ? "No project folder" : `${workspace?.name ?? "Project"} on ${name}`}</span>
            <span><Check size={13} /> Approval controls</span>
          </div>
          {workspace && !workspace.isChat && <div className="isolation-choice" aria-label="Thread workspace mode">
            <button className={!chosen?.isolated ? "active" : ""} aria-pressed={!chosen?.isolated} onClick={() => changeSettings({ isolated: false })}>
              <Folder size={15} /><span><strong>Shared project</strong><small>Work directly in {workspace.name}</small></span>
            </button>
            {initChoice ? <button className="git-initialize-choice" onClick={() => void initializeGit()} disabled={gitInitializing || !canGitWrite} aria-busy={gitInitializing}
              title={canGitWrite ? `Create a local Git repository and initial snapshot on ${name}. Nothing is pushed.` : accessReason(name, "set up Git", "Git changes and Terminal")}>
              {gitInitializing ? <LoaderCircle className="spin" size={15} /> : <GitBranch size={15} />}
              <span><strong>{initChoice === "snapshot" ? "Create initial Git snapshot" : "Initialize Git repository"}</strong>
                <small>{gitInitializing ? "Preparing this project…" : "Local only; respects .gitignore"}</small></span>
            </button> : <button className={chosen?.isolated ? "active" : ""} aria-pressed={Boolean(chosen?.isolated)} disabled={!canRun || Boolean(isolationReason)}
              title={!canRun ? accessReason(name, "create worktrees", "Terminal") : isolationReason} onClick={() => changeSettings({ isolated: true })}>
              <GitBranch size={15} /><span><strong>Isolated worktree</strong><small>{isolationReason ?? (chosen?.isolated && draftUnconfirmed[draftKey] ? `Not confirmed by ${name} yet · checked again when you send` : `A separate branch and folder on ${name}`)}</small></span>
            </button>}
          </div>}
        </div> : known ? <RemoteMachineName.Provider value={name}><RemoteThreadContext.Provider value={scope}><RemoteSteers.Provider value={steerControls}><TimelinePresentation key={`${device}:${compose ? "new" : thread?.id}`} environment={timelineEnvironment}
          messages={projectedMessages} activities={projectedActivities} provider={thread?.provider ?? provider}
          running={running} activeTurnId={timeline?.activeTurnId ?? undefined} awaitingState={awaiting}
          thinkingLabel={`Working on ${name}`} history={compose ? undefined : history} skills={skillLinks} onOpenSkill={openSkill}
          searchQuery={findOpen ? findQuery : ""} searchActiveMatch={findIndex}
          onLoadEarlier={!compose && !stale && !timeline?.historyLimited ? () => loadRemoteEarlier(device) : undefined} /></RemoteSteers.Provider></RemoteThreadContext.Provider></RemoteMachineName.Provider>
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
          ref={composerRef}
          threadKey={draftKey}
          chatFont={chatFont}
          running={running || starting}
          queueing={running && Boolean(capabilities?.canQueue)}
          canSteer={Boolean(steerHandle)}
          dropActive={dropHover}
          placeholder={compose ? `Start a thread on ${name}` : running ? `Queue a follow-up on ${name}` : `Message ${name}`}
          attachments={attachments}
          hasFeedback={notes.length > 0}
          feedbackTray={<FeedbackTray key={draftKey} notes={notes} staleIds={staleNotes} onUpdate={(id, comment) => updateRemoteFeedback(draftKey, id, comment)} onRemove={(id) => removeRemoteFeedback(draftKey, id)} />}
          queuedTurns={queuedTurns}
          searchFiles={search}
          skills={skills}
          onAnalyzeSkillDependencies={analyzeSkills}
          workflows={context?.workflows}
          onWorkflow={(id, prompt) => reviewWorkflow(id, prompt)}
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
          editDraftScope={queueEditScope}
          onBeginEditQueued={beginQueueEdit}
          onFinishEditQueued={finishQueueEdit}
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
            {...(modelFavorites ? { favorites: modelFavorites } : {})} {...(onToggleModelFavorite ? { onToggleFavorite: onToggleModelFavorite } : {})}
            onSettings={changeSettings} onDefaults={() => setEditingProject(true)} onNotice={setNotice} />}
          controls={<>
            <RemoteComposerControls device={device} workspaceId={workspaceId} revision={revision} onOpenThread={(id) => { setNewThreadTarget(device, undefined); selectRemoteThread(device, id); }} context={context} chosen={chosen} name={name} provider={provider} running={running} threadId={threadId} scopeKey={draftKey}
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
    {workflowDialog}
    {viewingSkill && <RemoteSkillViewer device={device} name={name} skillName={viewingSkill} target={parityTarget} skills={context?.skills} onClose={() => setViewingSkill(null)} />}
    {editingProject && workspaceId && workspace && <RemoteProjectEditor device={device} name={name} workspaceId={workspaceId} projectName={workspace.name} context={context}
      onClose={() => setEditingProject(false)} onSaved={() => { setEditingProject(false); refreshRemoteDevice(device); void refreshRemoteContext(device, workspaceId, threadId); }} />}
  </section>;
}
