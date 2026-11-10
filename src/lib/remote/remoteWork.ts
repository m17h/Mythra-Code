import { endRemoteTerminals } from "./remoteTerminal";
import { forgetPanels } from "./panelCache";
import { create } from "zustand";
import { useActiveMachine } from "./activeMachine";
import { useRemoteDevices } from "./devices";
import { keepRemoteSessions, openRemoteThread, refreshRemoteDevice, useRemoteStore, type RemoteTimeline } from "./remoteStore";
import {
  admitToOutbox, markPromptRejected, MAX_PROMPT_CHARS, newThreadDraftKey, nextOperationSequence, outboxIsFull, removeOutboxEntry, removeRemoteEcho,
  setNewThreadTarget, settleRemoteEcho, updateOutboxEntry, useRemoteOutbox, type OutboxEntry, type OutboxOperation,
} from "./outbox";
import { viewerErrorCode, viewerHostOperation, viewerRequest, viewerWork } from "./viewerBridge";
import type { HostContextResult, RemoteRowOperation, RemoteWorkResult, ThreadSettingsSetArgs, WireExecutionSettings, WireWorkCapabilities } from "./wire";
import type { FoldersBrowseResult, ProjectCloneResult, ProjectCloneStatus, ProjectsAddResult } from "./wire-studio";

/** Never a boolean: a lost acknowledgement is neither success nor failure. */
export type RemoteSendOutcome =
  | { status: "accepted" }
  | { status: "rejected"; message: string }
  | { status: "awaiting confirmation" };

export const UNCONFIRMED_TEXT = "We couldn't confirm whether this was sent. Check the conversation before sending it again.";
/** Refused before anything ran. Any other failure might have reached the host. */
const DEFINITE_REFUSALS = new Set(["forbidden", "busy", "rate_limited", "stale_target", "unsupported", "not_paired", "invalid", "thread_unavailable", "checkpoint_turn_unavailable", "workflow_changed"]);

export function refusalText(code: string, name: string): string {
  switch (code) {
    case "forbidden": case "not_paired": return `${name} doesn't allow this device to do that.`;
    case "busy": case "rate_limited": return `${name} is busy. Try again in a moment.`;
    case "stale_target": return "That request has already ended.";
    case "workflow_changed": return `This workflow changed on ${name} after you reviewed it. Review it again before running.`;
    case "checkpoint_turn_unavailable": return "This older checkpoint has no saved conversation turn, so it cannot be forked. Choose a checkpoint with a saved turn or fork the latest conversation.";
    case "thread_unavailable": return `This conversation isn't available on ${name} anymore.`;
    case "unsupported": return `This version of Mythra Code on ${name} can't do that yet.`;
    default: return `${name} couldn't do that.`;
  }
}

type RemoteWorkInspection = { threadId: string } & (
  | { status: "pending" | "unavailable" | "denied" }
  | { status: "ready"; capabilities: WireWorkCapabilities }
);
interface RemoteWorkStore { capabilities: Record<string, RemoteWorkInspection | undefined> }
export const useRemoteWork = create<RemoteWorkStore>(() => ({ capabilities: {} }));

const INSPECT_RETRY_MS = [1500, 5000];
interface InspectionRequest { timer?: ReturnType<typeof setTimeout> }
interface WatchedThread { threadId: string; request?: InspectionRequest }
const watchedThreads = new Map<string, WatchedThread>();
function publishInspection(device: string, result: RemoteWorkInspection) {
  useRemoteWork.setState((state) => ({ capabilities: { ...state.capabilities, [device]: result } }));
}
function cancelInspection(thread: WatchedThread | undefined) {
  const timer = thread?.request?.timer;
  if (timer !== undefined) clearTimeout(timer);
  if (thread) thread.request = undefined;
}
function inspectionTimeline(device: string, threadId: string): RemoteTimeline | undefined {
  const view = useRemoteStore.getState().devices[device];
  if (view?.threadId !== threadId || useActiveMachine.getState().machine !== device || useRemoteOutbox.getState().compose[device]) return;
  const machine = useRemoteDevices.getState().snapshot?.devices.find((entry) => entry.fingerprint === device);
  if (machine?.state === "connected" && machine.canView) return view.timelines.get(threadId);
}
/** Only the visible conversation can start or retire an inspection scope. */
export function watchRemoteCapabilities(device: string, threadId: string): () => void {
  cancelInspection(watchedThreads.get(device));
  const thread: WatchedThread = { threadId };
  watchedThreads.set(device, thread);
  publishInspection(device, { threadId, status: "pending" });
  let previous: RemoteTimeline | undefined;
  const update = () => {
    if (watchedThreads.get(device) !== thread) return;
    const next = inspectionTimeline(device, threadId);
    if (next === previous) return;
    const before = previous;
    previous = next;
    if (next?.state !== "live") {
      if (before?.state === "live") {
        // Recovery can replay an identical timeline in the same React batch.
        // Retire old replies and handles as soon as the store sees the change.
        cancelInspection(thread);
        if (useRemoteWork.getState().capabilities[device]?.status !== "pending") publishInspection(device, { threadId, status: "pending" });
      }
      return;
    }
    if (before?.state !== "live" || before.epoch !== next.epoch || before.status !== next.status
      || before.activeTurnId !== next.activeTurnId || before.assistantOutputActive !== next.assistantOutputActive
      || (before.approvals !== next.approvals && (before.approvals.length !== next.approvals.length
        || next.approvals.some((entry, index) => entry.id !== before.approvals[index]?.id)))) {
      void refreshRemoteCapabilities(device, threadId);
    }
  };
  const unwatch = [useRemoteStore.subscribe(update), useRemoteDevices.subscribe(update), useActiveMachine.subscribe(update), useRemoteOutbox.subscribe(update)];
  update();
  return () => {
    for (const unsubscribe of unwatch) unsubscribe();
    if (watchedThreads.get(device) !== thread) return;
    cancelInspection(thread);
    watchedThreads.delete(device);
    useRemoteWork.setState((state) => {
      const capabilities = { ...state.capabilities };
      delete capabilities[device];
      return { capabilities };
    });
  };
}

/** Only an explicit host Work refusal proves the viewer is view-only. */
export async function refreshRemoteCapabilities(device: string, threadId: string, options?: { ifIdle?: boolean }): Promise<void> {
  const thread = watchedThreads.get(device);
  const live = () => inspectionTimeline(device, threadId)?.state === "live";
  if (!thread || thread.threadId !== threadId || !live()) return;
  // Quiet ownership polls must not replace a timeline-triggered inspection or
  // its pending retry. Explicit refreshes still retire obsolete replies.
  if (options?.ifIdle && thread.request) return;
  cancelInspection(thread);
  const request: InspectionRequest = {};
  thread.request = request;
  const current = () => watchedThreads.get(device) === thread && thread.request === request && live();
  if (useRemoteWork.getState().capabilities[device]?.status === "unavailable") {
    publishInspection(device, { threadId, status: "pending" });
  }

  const inspect = async (attempt: number) => {
    if (!current()) return;
    let result: RemoteWorkInspection = { threadId, status: "unavailable" };
    try {
      const value = await viewerRequest<WireWorkCapabilities>(device, "work.inspect", { threadId });
      if (value?.threadId === threadId && typeof value.canSend === "boolean" && typeof value.canQueue === "boolean"
        && typeof value.canSteer === "boolean" && Array.isArray(value.approvals)) {
        result = { threadId, status: "ready", capabilities: value };
      }
    } catch (reason) {
      if (viewerErrorCode(reason) === "work_disabled") result = { threadId, status: "denied" };
    }
    if (!current()) return;
    publishInspection(device, result);
    if (result.status === "unavailable" && attempt < INSPECT_RETRY_MS.length && current()) {
      request.timer = setTimeout(() => {
        request.timer = undefined;
        void inspect(attempt + 1);
      }, INSPECT_RETRY_MS[attempt]);
    } else if (current()) thread.request = undefined;
  };
  await inspect(0);
}

/** Once per session, resume above whatever the host has seen from this device. */
const alignedDevices = new Set<string>();
const MAX_WAITING_ACTIONS = 256;
const sequencing = new Map<string, { tail: Promise<unknown>; waiting: number }>();
const nextTask = () => new Promise<void>((resolve) => { setTimeout(resolve, 0); });
/**
 * The host refuses an opSeq at or below the highest it has seen, so a later
 * action that overtakes an earlier one expires it for good. Each action for a
 * device takes its number, saves what it must and hands its frame over before
 * the next may start. Replies are not waited for. The task gap lets the native
 * side take the frame before the next one follows it.
 */
export function sequenced<T>(device: string, prepare: (opSeq: number) => Promise<void> | void, send: (opSeq: number) => Promise<T>): Promise<T> {
  const turn = sequencing.get(device) ?? { tail: Promise.resolve(), waiting: 0 };
  if (turn.waiting >= MAX_WAITING_ACTIONS) return Promise.reject({ code: "busy" });
  turn.waiting += 1;
  sequencing.set(device, turn);
  const admitted = turn.tail.then(async () => {
    const opSeq = await operationSequence(device);
    await prepare(opSeq);
    const response = send(opSeq);
    response.catch(() => undefined);
    await nextTask();
    return { response };
  });
  turn.tail = admitted.catch(() => undefined).finally(() => {
    turn.waiting -= 1;
    if (!turn.waiting && sequencing.get(device) === turn) sequencing.delete(device);
  });
  return admitted.then(({ response }) => response);
}
const alignedFloors = new Map<string, number>();
const aligning = new Map<string, Promise<void>>();
/** Asked for on connecting, so the first send doesn't spend a round trip on it. */
export function alignRemoteDevice(device: string): Promise<void> {
  if (alignedDevices.has(device)) return Promise.resolve();
  let pending = aligning.get(device);
  if (!pending) {
    pending = viewerRequest<{ highestOpSeq?: number }>(device, "host.info").then((info) => {
      alignedFloors.set(device, typeof info?.highestOpSeq === "number" ? info.highestOpSeq : 0);
      alignedDevices.add(device);
    }).finally(() => aligning.delete(device));
    aligning.set(device, pending);
  }
  return pending;
}
async function operationSequence(device: string): Promise<number> {
  await alignRemoteDevice(device);
  const floor = alignedFloors.get(device) ?? 0;
  alignedFloors.delete(device);
  return nextOperationSequence(device, floor);
}

function promptArgs(entry: OutboxEntry): Record<string, unknown> {
  return {
    opId: entry.opId, opSeq: entry.opSeq, text: entry.text,
    ...(entry.threadId ? { threadId: entry.threadId } : {}),
    ...(entry.workspaceId && !entry.threadId ? { workspaceId: entry.workspaceId } : {}),
    ...(entry.handle ? { handle: entry.handle } : {}),
    ...(entry.draftHandle ? { draftHandle: entry.draftHandle } : {}),
    ...(entry.attachmentIds?.length ? { attachmentIds: entry.attachmentIds } : {}),
    ...(entry.skillInvocationText !== undefined ? { skillInvocationText: entry.skillInvocationText } : {}),
  };
}

function settleAccepted(entry: OutboxEntry, threadId: string | undefined): void {
  removeOutboxEntry(entry.opId);
  settleRemoteEcho(entry.opId, threadId ?? entry.threadId);
  if (entry.op !== "prompt.send" || entry.threadId || !entry.workspaceId) return;
  // Only a draft still on screen follows its new thread. A late reply never moves
  // someone off whatever they went to meanwhile: the thread just joins the list.
  const { device, workspaceId, draftKey } = entry;
  const watching = () => {
    const target = useRemoteOutbox.getState().compose[device];
    const view = useRemoteStore.getState().devices[device];
    return target ? newThreadDraftKey(device, target) === draftKey : !view?.threadId && view?.workspaceId === workspaceId;
  };
  if (!watching()) { refreshRemoteDevice(device); return; }
  // The draft stays on screen until the thread is ready to take over from it.
  const leaveDraft = () => { const target = useRemoteOutbox.getState().compose[device]; if (target && newThreadDraftKey(device, target) === draftKey) setNewThreadTarget(device, undefined); };
  if (!threadId) { leaveDraft(); return; }
  void openRemoteThread(device, workspaceId, threadId, watching).then(leaveDraft, leaveDraft);
}

async function dispatchPrompt(entry: OutboxEntry, name: string): Promise<RemoteSendOutcome> {
  updateOutboxEntry(entry.opId, { state: "sending" });
  let result: RemoteWorkResult;
  try {
    result = await viewerWork<RemoteWorkResult>(entry.device, entry.op, promptArgs(entry));
  } catch (reason) {
    const code = viewerErrorCode(reason);
    if (!DEFINITE_REFUSALS.has(code)) {
      updateOutboxEntry(entry.opId, { state: "awaiting" });
      recheckOutbox(entry.device, name);
      return { status: "awaiting confirmation" };
    }
    const message = refusalText(code, name);
    removeOutboxEntry(entry.opId);
    removeRemoteEcho(entry.opId);
    return { status: "rejected", message };
  }
  if (result?.state === "accepted" || result?.state === "queued") {
    settleAccepted(entry, result.threadId);
    return { status: "accepted" };
  }
  if (result?.state === "rejected") {
    const message = refusalText(result.error?.code ?? "", name);
    removeOutboxEntry(entry.opId);
    removeRemoteEcho(entry.opId);
    return { status: "rejected", message };
  }
  updateOutboxEntry(entry.opId, { state: "uncertain" });
  return { status: "awaiting confirmation" };
}

const OPERATION_FOR_MODE = { send: "prompt.send", queue: "prompt.queue", steer: "prompt.steer" } as const satisfies Record<string, OutboxOperation>;
const claimedDrafts = new Set<string>();

/** A failure here ends here: there is no path from this function to the local
 * machine. */
export async function sendRemotePrompt(request: {
  device: string; name: string; draftKey: string; text: string; mode: keyof typeof OPERATION_FOR_MODE;
  /** Chosen by the caller when something is already showing under this identity. */
  opId?: string;
  threadId?: string; workspaceId?: string; handle?: string; draftHandle?: string; attachmentIds?: string[]; skillInvocationText?: string;
}): Promise<RemoteSendOutcome> {
  const { device, name, draftKey, mode, threadId, workspaceId, handle, draftHandle, attachmentIds, skillInvocationText } = request;
  const text = request.text.trim();
  if (!text) return { status: "rejected", message: "Write a message first." };
  if (text.length > MAX_PROMPT_CHARS) return { status: "rejected", message: "That message is too long to send to another device." };
  if (claimedDrafts.has(draftKey)) return { status: "rejected", message: "Wait until your last message is confirmed." };
  const unresolved = useRemoteOutbox.getState().entries.some((entry) => entry.draftKey === draftKey && entry.state !== "rejected");
  if (unresolved) return { status: "rejected", message: "Wait until your last message is confirmed." };
  if (outboxIsFull()) return { status: "rejected", message: "Too many messages are waiting. Dismiss some first." };
  claimedDrafts.add(draftKey);
  let entry: OutboxEntry | undefined;
  try {
    return await sequenced(device, async (opSeq) => {
      entry = {
        opId: request.opId ?? crypto.randomUUID(), opSeq, device, op: OPERATION_FOR_MODE[mode], draftKey, text,
        state: "sending", createdAt: Date.now(),
        ...(threadId ? { threadId } : {}), ...(workspaceId ? { workspaceId } : {}), ...(handle ? { handle } : {}),
        ...(draftHandle ? { draftHandle } : {}), ...(attachmentIds?.length ? { attachmentIds } : {}),
        ...(skillInvocationText !== undefined ? { skillInvocationText } : {}),
      };
      await admitToOutbox(entry);
    }, () => dispatchPrompt(entry!, name));
  } catch {
    if (entry) {
      removeOutboxEntry(entry.opId);
      return { status: "rejected", message: "Mythra Code couldn't save this message, so it wasn't sent." };
    }
    return { status: "rejected", message: `Mythra Code can't reach ${name} right now. Your draft is saved.` };
  } finally { claimedDrafts.delete(draftKey); }
}

/** Only ever the same `opId`, and only after the host proved it never saw it. */
export async function retryRemotePrompt(entry: OutboxEntry, name: string): Promise<void> {
  if (entry.state !== "retry") return;
  const outcome = await dispatchPrompt(entry, name);
  // The composer has moved on, so the refused text stays where the user can see it.
  if (outcome.status === "rejected") {
    await admitToOutbox({ ...entry, state: "rejected", error: outcome.message });
  }
}

const reconciling = new Set<string>();
const RECHECK_MS = [1_000, 2_000, 5_000, 10_000, 30_000] as const;
const rechecks = new Map<string, { timer?: ReturnType<typeof setTimeout>; attempt: number }>();
/** The one wait here that needs a timer: the host can answer "pending" on a healthy
 * link, and no connection change will come to ask again. */
function recheckOutbox(device: string, name: string): void {
  const slot = rechecks.get(device) ?? { attempt: 0 };
  if (slot.timer !== undefined) return;
  rechecks.set(device, slot);
  slot.timer = setTimeout(() => { slot.timer = undefined; void reconcileRemoteOutbox(device, name); }, RECHECK_MS[Math.min(slot.attempt, RECHECK_MS.length - 1)]);
  slot.attempt += 1;
}
const awaitingEntries = (device: string) => useRemoteOutbox.getState().entries.filter((entry) => entry.device === device && entry.state === "awaiting");
/** Asks the host about every prompt whose outcome this device doesn't know: when a
 * device connects, and then again for as long as the answer is "pending". A broken
 * link stops the asking, and the next connection starts it. */
export async function reconcileRemoteOutbox(device: string, name: string): Promise<void> {
  if (reconciling.has(device)) return;
  reconciling.add(device);
  try {
    for (const entry of awaitingEntries(device)) {
      let status: { state?: string; threadId?: string; errorCode?: string };
      try { status = await viewerRequest(device, "op.status", { opId: entry.opId, opSeq: entry.opSeq }); }
      catch { rechecks.delete(device); return; }
      switch (status?.state) {
        case "accepted": settleAccepted(entry, status.threadId); break;
        case "rejected": markPromptRejected(entry.opId, refusalText(status.errorCode ?? "", name)); break;
        case "unknown": updateOutboxEntry(entry.opId, { state: "retry" }); break;
        case "uncertain": case "expired": updateOutboxEntry(entry.opId, { state: "uncertain" }); break;
        default: break;
      }
    }
    if (awaitingEntries(device).length) recheckOutbox(device, name);
    else rechecks.delete(device);
  } finally { reconciling.delete(device); }
}

/** `null` when done, otherwise what to tell the user. Stop and answers aren't
 * prompts, so a lost acknowledgement reports and leaves nothing to resend. */
async function runAction(device: string, name: string, op: "turn.stop" | "approval.answer" | "question.answer" | "thread.settings.set" | RemoteRowOperation, args: object): Promise<string | null> {
  try {
    const result = await sequenced(device, () => undefined, (opSeq) => viewerWork<RemoteWorkResult>(device, op, { opId: crypto.randomUUID(), opSeq, ...args }));
    if (result?.state === "accepted" || result?.state === "queued") return null;
    if (result?.state === "rejected") return refusalText(result.error?.code ?? "", name);
    return "We couldn't confirm that reached the other device. Check the conversation.";
  } catch (reason) {
    const code = viewerErrorCode(reason);
    return DEFINITE_REFUSALS.has(code) ? refusalText(code, name) : "We couldn't confirm that reached the other device. Check the conversation.";
  }
}
export const stopRemoteTurn = (device: string, name: string, threadId: string, handle: string) =>
  runAction(device, name, "turn.stop", { threadId, handle });
export const answerRemoteApproval = (device: string, name: string, threadId: string, handle: string, decision: "allowOnce" | "deny") =>
  runAction(device, name, "approval.answer", { threadId, handle, decision });
/** Answers go straight to the host. They are never written to the outbox or a
 * draft, because some of them are marked secret. */
export const answerRemoteQuestion = (device: string, name: string, threadId: string, handle: string, answers: Record<string, string[]> | null) =>
  runAction(device, name, "question.answer", answers ? { threadId, handle, answers } : { threadId, handle, cancel: true });

/** Row actions and setting changes run on the host, which checks them. */
export const runRemoteRowAction = (device: string, name: string, op: RemoteRowOperation, args: object) => runAction(device, name, op, args);
export async function setRemoteThreadSettings(device: string, name: string, change: Omit<ThreadSettingsSetArgs, "opId" | "opSeq">, workspaceId: string): Promise<string | null> {
  const failure = await runAction(device, name, "thread.settings.set", change);
  if (!failure) await refreshRemoteContext(device, workspaceId, change.threadId);
  return failure;
}

interface RemoteContextStore {
  /** The host's models, skills and defaults. Memory only, newest last. */
  contexts: Record<string, Map<string, HostContextResult>>;
}
const MAX_CONTEXTS = 32;
export const useRemoteContext = create<RemoteContextStore>(() => ({ contexts: {} }));
export const remoteContextKey = (workspaceId: string, threadId?: string) => `${workspaceId}/${threadId ?? ""}`;
export function forgetRemoteContext(device: string): void {
  useRemoteContext.setState((state) => {
    const contexts = { ...state.contexts };
    delete contexts[device];
    return { contexts };
  });
}
/** A failed read keeps what is known. The pickers stay as they were. */
export async function refreshRemoteContext(device: string, workspaceId: string, threadId?: string): Promise<void> {
  let result: HostContextResult;
  try { result = await viewerRequest<HostContextResult>(device, "host.context", threadId ? { workspaceId, threadId } : { workspaceId }); }
  catch { return; }
  if (result?.workspaceId !== workspaceId) return;
  useRemoteContext.setState((state) => {
    const known = new Map(state.contexts[device]);
    const key = remoteContextKey(workspaceId, threadId);
    known.delete(key);
    known.set(key, result);
    for (const stale of known.keys()) if (known.size > MAX_CONTEXTS) known.delete(stale);
    return { contexts: { ...state.contexts, [device]: known } };
  });
}
export async function searchRemoteFiles(device: string, workspaceId: string, threadId: string | undefined, query: string): Promise<string[]> {
  const result = await viewerRequest<{ files?: { relativePath: string }[] }>(device, "files.search", { workspaceId, ...(threadId ? { threadId } : {}), query });
  return result?.files?.map((file) => file.relativePath) ?? [];
}
export const browseRemoteFolders = (device: string, folderId?: string, cursor?: string) =>
  viewerRequest<FoldersBrowseResult>(device, "folders.browse", { ...(folderId ? { folderId } : {}), ...(cursor ? { cursor } : {}) });
/** `null` when the project was added, otherwise what to tell the user. */
export async function addRemoteProject(device: string, name: string, folderId: string): Promise<string | null> {
  try {
    const result = await sequenced(device, () => undefined, (opSeq) => viewerWork<ProjectsAddResult>(device, "projects.add", { opId: crypto.randomUUID(), opSeq, folderId }));
    return result?.state === "accepted" ? null : `We couldn't confirm that the project was added. Check the list on ${name}.`;
  } catch (reason) {
    const code = viewerErrorCode(reason);
    return DEFINITE_REFUSALS.has(code) ? refusalText(code, name) : `We couldn't confirm that the project was added. Check the list on ${name}.`;
  }
}
/** The handle to follow, or what to tell the user. A clone only starts here. */
export async function startRemoteClone(device: string, name: string, folderId: string, url: string): Promise<{ handle: string; folder: string } | { failure: string }> {
  try {
    const result = await sequenced(device, () => undefined, (opSeq) => viewerWork<ProjectCloneResult>(device, "projects.clone", { opId: crypto.randomUUID(), opSeq, folderId, url }));
    return result?.state === "accepted" && result.processHandle && result.name ? { handle: result.processHandle, folder: result.name } : { failure: `We couldn't confirm that the clone started. Check the folder on ${name}.` };
  } catch (reason) {
    const code = viewerErrorCode(reason);
    if (code === "invalid") return { failure: "Enter a valid GitHub repository address." };
    if (code === "busy") return { failure: `That folder already exists there, or ${name} is busy with another clone. Choose another folder or try again shortly.` };
    return { failure: DEFINITE_REFUSALS.has(code) ? refusalText(code, name) : `We couldn't confirm that the clone started. Check the folder on ${name}.` };
  }
}
export const readRemoteClone = (device: string, processHandle: string) => viewerHostOperation<ProjectCloneStatus>(device, "projects.clone.status", { processHandle });
export function keepRemoteDevices(paired: readonly string[], online: readonly string[]): void {
  keepRemoteSessions(paired, online);
  forgetPanels(paired);
  for (const device of paired) if (!online.includes(device)) endRemoteTerminals(device);
  for (const device of Object.keys(useRemoteContext.getState().contexts)) if (!paired.includes(device)) forgetRemoteContext(device);
}

/** Returns an opaque host draft token. Sending it with sendRemotePrompt lets
 * the prompt's owner/opId create and bind the checkout natively, exactly once.
 * No worktree is created just by changing this choice. */
export async function setRemoteDraftIsolation(device: string, name: string, workspaceId: string, isolated: boolean, draftHandle?: string): Promise<
  { draftHandle: string; startTarget: string; settings: WireExecutionSettings } | { failure: string }
> {
  const uncertain = `We couldn't confirm this draft's settings on ${name}. Refresh them before sending.`;
  try {
    const result = await sequenced(device, () => undefined, (opSeq) => viewerHostOperation<RemoteWorkResult & {
      draftHandle?: string; startTarget?: string; settings?: WireExecutionSettings;
    }>(device, "draft.settings.set", { opId: crypto.randomUUID(), opSeq, workspaceId, isolated, ...(draftHandle ? { draftHandle } : {}) }));
    if (result?.state === "accepted" && result.workspaceId === workspaceId && result.draftHandle && result.startTarget && result.settings?.isolated === isolated) {
      return { draftHandle: result.draftHandle, startTarget: result.startTarget, settings: result.settings };
    }
    if (result?.state === "rejected") return { failure: result.error?.code === "forbidden" && isolated
      ? "Isolated drafts need Terminal access. Enable it in the host device settings." : refusalText(result.error?.code ?? "", name) };
    return { failure: uncertain };
  } catch (reason) {
    const code = viewerErrorCode(reason);
    return { failure: code === "forbidden" && isolated ? "Isolated drafts need Terminal access. Enable it in the host device settings."
      : DEFINITE_REFUSALS.has(code) ? refusalText(code, name) : uncertain };
  }
}

/** Omit checkpointId for latest. A failed selected fork never falls back to
 * latest and an unconfirmed provider effect is never automatically resent. */
export async function forkRemoteThread(device: string, name: string, threadId: string, checkpointId?: string): Promise<{ threadId: string } | { failure: string }> {
  const uncertain = `We couldn't confirm whether the conversation was forked on ${name}. Check the conversation list before trying again.`;
  if (checkpointId !== undefined && (!checkpointId || checkpointId.length > 256 || /[\u0000-\u001f]/.test(checkpointId))) return { failure: "Choose an available checkpoint first." };
  try {
    const result = await sequenced(device, () => undefined, (opSeq) => viewerWork<RemoteWorkResult>(device, "thread.fork", {
      opId: crypto.randomUUID(), opSeq, threadId, ...(checkpointId !== undefined ? { checkpointId } : {}),
    }));
    if (result?.state === "accepted" && result.threadId && result.threadId !== threadId) return { threadId: result.threadId };
    return { failure: result?.state === "rejected" ? refusalText(result.error?.code ?? "", name) : uncertain };
  } catch (reason) {
    const code = viewerErrorCode(reason);
    return { failure: DEFINITE_REFUSALS.has(code) ? refusalText(code, name) : uncertain };
  }
}

/** Persisted steering identities reconciled with the original native Claude
 * turn, never with whichever thread happens to be selected on the host. */
export const listRemoteSteers = (device: string, workspaceId: string, threadId: string) =>
  viewerHostOperation<import("./wire").RemoteSteerList>(device, "steer.list", { workspaceId, threadId });
const steerDeliveryRequests = new Map<string, { opId: string; opSeq: number }>();
/** A successful request is NOT evidence that Claude read it. Refresh steer.list
 * until the lifecycle says "read". Repeated clicks retain the same op identity. */
export async function deliverRemoteSteerNow(device: string, name: string, workspaceId: string, threadId: string, turnId: string, runtimeId: string): Promise<string | null> {
  const key = JSON.stringify([device, workspaceId, threadId, turnId, runtimeId]);
  const uncertain = "We couldn't confirm that delivery was requested. Check the message's delivery status before trying again.";
  try {
    const result = await sequenced(device, () => undefined, (opSeq) => {
      let identity = steerDeliveryRequests.get(key);
      if (!identity) {
        if (steerDeliveryRequests.size >= 256) steerDeliveryRequests.delete(steerDeliveryRequests.keys().next().value!);
        identity = { opId: crypto.randomUUID(), opSeq };
        steerDeliveryRequests.set(key, identity);
      }
      return viewerHostOperation<RemoteWorkResult>(device, "steer.deliver", { ...identity, workspaceId, threadId, turnId, runtimeId });
    });
    if (result?.state === "accepted") return null;
    return result?.state === "rejected" ? refusalText(result.error?.code ?? "", name) : uncertain;
  } catch (reason) {
    const code = viewerErrorCode(reason);
    return DEFINITE_REFUSALS.has(code) ? refusalText(code, name) : uncertain;
  }
}
