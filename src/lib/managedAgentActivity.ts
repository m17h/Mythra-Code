import type { Activity, Provider } from "../types";
import type { ChildMailbox, ChildMailMessage } from "./childAgentMailbox";
import { providerDisplayName } from "./childAgents";
import { ownCoordinationTool } from "./coordinationProvenance";

/**
 * Presentation of Mythra Code's own sub-agent coordination, for the timeline
 * and the work history only. Provider records stay untouched in the store and
 * on disk; this module never writes anything back.
 *
 * Two record sources describe the same coordination:
 * - `bridge`: the provider's raw call of a `mythra_agents` MCP tool (for
 *   example `mcp__mythra_agents__collect_agent`) with its JSON receipt.
 * - `app`: the named rows Mythra Code records itself (`child-wait-…`,
 *   `child-guidance-…`, `child-message-…`, …).
 * Arbitrary MCP servers and provider-native harness tools never match.
 */

export type CoordinationOperation =
  | "spawn" | "status" | "check" | "stop" | "message" | "followUp" | "accept"
  | "fromChild" | "toParent" | "readParent" | "settings";

type Tool = "spawn_mythra_agent" | "agent_status" | "collect_agent" | "cancel_agent" | "send_agent_message"
  | "accept_agent" | "message_parent" | "read_parent_messages" | "propose_agent_settings";

type Receipt = Record<string, unknown>;

export interface CoordinationRecord {
  source: "bridge" | "app";
  operation: CoordinationOperation;
  childId?: string;
  /** Mailbox message this row is about, when its identity is exact. */
  messageId?: string;
  /** The bridge's own JSON answer: this row's, or the paired bridge call's. */
  receipt?: Receipt;
  /** Original bridge output, retained behind a disclosure on paired app rows. */
  receiptDetail?: string;
}

export type CoordinationTone = "live" | "bad" | "stopped" | "";

export interface CoordinationView {
  /** Direction of the communication. `about` names only the sub-agent. */
  direction: "toChild" | "toParent" | "about";
  /** Display participants: `from → to`, or the single subject for `about`. */
  from: string;
  to?: string;
  /** Replaces the generic status word when this row's outcome is specific. */
  state?: { label: string; tone: CoordinationTone };
  note?: string;
}

/** What the timeline knows about a child: the same identity the crew shows. */
export interface CoordinationParticipant {
  title: string;
  /** e.g. `Claude · claude-fable-5`. */
  detail: string;
}

const OPERATION: Record<Tool, CoordinationOperation> = {
  spawn_mythra_agent: "spawn",
  agent_status: "status",
  collect_agent: "check",
  cancel_agent: "stop",
  send_agent_message: "message",
  accept_agent: "accept",
  message_parent: "toParent",
  read_parent_messages: "readParent",
  propose_agent_settings: "settings",
};

/** Titles for bridge calls: [active, completed, failed, stopped, unknown]. */
const TITLES: Record<Tool, readonly [string, string, string, string, string]> = {
  spawn_mythra_agent: ["Starting sub-agent", "Started sub-agent", "Could not start sub-agent", "Sub-agent start stopped", "Sub-agent start"],
  agent_status: ["Checking sub-agent status", "Checked sub-agent status", "Could not check sub-agent status", "Status check stopped", "Sub-agent status check"],
  collect_agent: ["Checking sub-agent", "Checked sub-agent", "Could not check sub-agent", "Sub-agent check stopped", "Sub-agent check"],
  cancel_agent: ["Stopping sub-agent", "Requested sub-agent stop", "Could not stop sub-agent", "Stop request interrupted", "Sub-agent stop request"],
  send_agent_message: ["Messaging sub-agent", "Message to sub-agent", "Could not message sub-agent", "Message to sub-agent stopped", "Message to sub-agent"],
  accept_agent: ["Accepting sub-agent work", "Accepted sub-agent work", "Could not accept sub-agent work", "Sign-off stopped", "Sub-agent sign-off"],
  message_parent: ["Messaging parent", "Message to parent", "Could not message parent", "Message to parent stopped", "Message to parent"],
  read_parent_messages: ["Reading parent messages", "Read parent messages", "Could not read parent messages", "Parent message read stopped", "Parent message read"],
  propose_agent_settings: ["Proposing sub-agent settings", "Proposed sub-agent settings", "Could not propose sub-agent settings", "Settings proposal stopped", "Sub-agent settings proposal"],
};

/** App rows a bridge call can be represented by, one-to-one. A follow-up
 * start is a later consequence of a message, not that message's receipt. */
const REPRESENTED_BY: Partial<Record<CoordinationOperation, Tool>> = {
  spawn: "spawn_mythra_agent",
  check: "collect_agent",
  message: "send_agent_message",
  accept: "accept_agent",
};

const ACTIVE = new Set(["inProgress", "running", "started", "starting", "pending"]);
const DONE = new Set(["completed", "succeeded", "success"]);
const FAILED = new Set(["failed", "error", "declined"]);
const STOPPED = new Set(["interrupted", "cancelled"]);
const PROVIDERS = new Set<string>(["openai", "openrouter", "lmstudio", "claude", "cursor"]);

type Outcome = "active" | "done" | "failed" | "stopped" | "unknown";

function outcomeOf(status: string | undefined): Outcome {
  if (ACTIVE.has(status ?? "")) return "active";
  if (DONE.has(status ?? "")) return "done";
  if (FAILED.has(status ?? "")) return "failed";
  if (STOPPED.has(status ?? "")) return "stopped";
  return "unknown";
}

function isRecord(value: unknown): value is Receipt {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

// Activity records are immutable. Caches keyed by the record avoid reparsing
// old tool output and keep displayed row identities stable while another row
// (the live thinking, say) streams.
const tools = new WeakMap<Activity, Tool | null>();
const receipts = new WeakMap<Activity, Receipt | null>();
const records = new WeakMap<Activity, CoordinationRecord | null>();
const relabeled = new WeakMap<Activity, Activity>();
const enriched = new WeakMap<Activity, { bridge: Activity; row: Activity }>();

function bridgeTool(activity: Activity): Tool | undefined {
  const cached = tools.get(activity);
  if (cached !== undefined) return cached ?? undefined;
  let tool: Tool | null = null;
  if ((activity.kind === "command" || activity.kind === "agent") && !activity.agent) {
    const metadata = activity.coordination;
    const name = metadata?.provenance === "mythra_agents" && Object.hasOwn(OPERATION, metadata.tool)
      ? metadata.tool : ownCoordinationTool(activity.title.trim());
    if (name) tool = name;
  }
  tools.set(activity, tool);
  return tool ?? undefined;
}

function parseRecord(value: string): Receipt | undefined {
  if (!value.startsWith("{")) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** The bridge's JSON answer (or, while a call is live, its JSON arguments).
 * New records retain an authoritative summary before display output is cut. */
function receiptOf(activity: Activity): Receipt | undefined {
  const cached = receipts.get(activity);
  if (cached !== undefined) return cached ?? undefined;
  let result = activity.detail ? parseRecord(activity.detail.trim()) : undefined;
  // Some runtimes keep the whole MCP envelope around the bridge's JSON text.
  if (result && Array.isArray(result.content)) {
    const inner = parseRecord(result.content.map((entry) => isRecord(entry) && typeof entry.text === "string" ? entry.text : "").join("").trim());
    if (inner) result = result.isError === true ? { ...inner, isError: true } : inner;
  }
  const metadata = activity.coordination;
  if (metadata?.provenance === "mythra_agents" && metadata.tool === bridgeTool(activity)) {
    const summary = metadata.receipt;
    if (!result) result = summary;
    else if (summary) result = { ...result, ...summary };
  }
  receipts.set(activity, result ?? null);
  return result;
}

function failedReceipt(receipt: Receipt | undefined): boolean {
  if (!receipt) return false;
  // A child report may contain its own `error`; that does not mean the check
  // failed. Only an MCP error or the bridge's bare refusal is a call failure.
  return receipt.isError === true || Boolean(text(receipt.error)
    && Object.keys(receipt).every((key) => key === "error" || key === "isError"));
}

/** Input arguments can remain as `detail` when an old provider result was
 * empty. A child id alone therefore never proves a completed operation. */
function representedResult(tool: Tool, receipt: Receipt | undefined): boolean {
  if (!receipt || receipt.resultUnconfirmed === true || receipt.identityConflict === true) return false;
  if (tool === "collect_agent" || tool === "spawn_mythra_agent") {
    return ["running", "starting", "completed", "failed", "cancelled", "unknown"].includes(text(receipt.status) ?? "");
  }
  if (tool === "send_agent_message") {
    return Boolean(text(receipt.messageId)) && ["queued", "starting", "started", "delivered", "failed", "cancelled", "unknown"].includes(text(receipt.state) ?? "");
  }
  if (tool === "accept_agent") return receipt.phase === "accepted";
  return true;
}

function receiptChild(receipt: Receipt | undefined): string | undefined {
  return text(receipt?.childId);
}

function childIdOf(activity: Activity, receipt: Receipt | undefined): string | undefined {
  const metadata = activity.coordination;
  return metadata?.provenance === "mythra_agents" && metadata.tool === bridgeTool(activity)
    ? text(metadata.childId) ?? receiptChild(receipt) : receiptChild(receipt);
}

function messageIdOf(activity: Activity, receipt: Receipt | undefined): string | undefined {
  const metadata = activity.coordination;
  return metadata?.provenance === "mythra_agents" && metadata.tool === "send_agent_message"
    ? text(metadata.messageId) ?? text(receipt?.messageId) : text(receipt?.messageId);
}

function appRecord(activity: Activity): CoordinationRecord | undefined {
  const agent = activity.agent;
  if (activity.kind !== "agent" || agent?.threadIds?.length !== 1) return undefined;
  const childId = agent.threadIds[0];
  const { id } = activity;
  const suffix = (prefix: string) => id.startsWith(`${prefix}${childId}-`) ? id.slice(prefix.length + childId.length + 1) || undefined : undefined;
  if (agent.action === "spawn" && id === `child-agent-${childId}`) return { source: "app", operation: "spawn", childId };
  if (agent.action === "wait" && id.startsWith("child-wait-")) return { source: "app", operation: "check", childId };
  if (agent.action === "sendInput" && suffix("child-guidance-")) return { source: "app", operation: "message", childId, messageId: suffix("child-guidance-") };
  // Failed, stale-bridge and stop notes use their own prefixes (and are warnings).
  if (agent.action === "resume" && suffix("child-followup-")) return { source: "app", operation: "followUp", childId };
  if (agent.action === "close" && suffix("child-accepted-")) return { source: "app", operation: "accept", childId };
  if (agent.action === "status" && suffix("child-message-")) return { source: "app", operation: "fromChild", childId, messageId: suffix("child-message-") };
  return undefined;
}

/** Coordination identity of a displayed row, or undefined for other work. */
export function coordinationRecord(activity: Activity): CoordinationRecord | undefined {
  const cached = records.get(activity);
  if (cached !== undefined) return cached ?? undefined;
  const tool = bridgeTool(activity);
  const receipt = tool ? receiptOf(activity) : undefined;
  const result = tool
    ? { source: "bridge" as const, operation: OPERATION[tool], childId: childIdOf(activity, receipt),
      messageId: tool === "send_agent_message" ? messageIdOf(activity, receipt) : undefined, receipt }
    : appRecord(activity);
  records.set(activity, result ?? null);
  return result;
}

function bridgeTitle(tool: Tool, outcome: Outcome, receipt: Receipt | undefined): string {
  const [active, done, failed, stopped, unknown] = TITLES[tool];
  if (outcome === "failed") return failed;
  if (outcome === "stopped") return stopped;
  if (outcome === "active") return active;
  if (!representedResult(tool, receipt)) return unknown;
  let title = outcome === "done" ? done : unknown;
  if (tool === "message_parent" && receipt?.kind === "question") title = "Question to parent";
  const name = receipt?.identityConflict === true ? undefined : text(receipt?.title);
  return name && name.length <= 200 && tool !== "message_parent" && tool !== "read_parent_messages" ? `${title}: ${name}` : title;
}

function relabel(activity: Activity, tool: Tool): Activity {
  const previous = relabeled.get(activity);
  if (previous) return previous;
  const receipt = receiptOf(activity);
  const status = failedReceipt(receipt) ? "failed" : activity.status;
  const outcome = outcomeOf(status);
  // A bare `{ "error": … }` envelope reads better as its message. Anything
  // richer keeps the bridge's full answer, folded behind the row.
  const keys = receipt ? Object.keys(receipt).filter((key) => key !== "isError") : [];
  const error = keys.length === 1 ? text(receipt?.error) : undefined;
  const { workType: _workType, ...rest } = activity;
  const row: Activity = { ...rest, kind: "agent", status, title: bridgeTitle(tool, outcome, receipt), ...(error ? { detail: error } : {}) };
  relabeled.set(activity, row);
  records.set(row, { source: "bridge", operation: OPERATION[tool], childId: childIdOf(activity, receipt),
    messageId: tool === "send_agent_message" ? messageIdOf(activity, receipt) : undefined, receipt });
  return row;
}

/** An app row that also carries its paired bridge call's receipt. */
function withReceipt(activity: Activity, bridge: Activity, record: CoordinationRecord): Activity {
  const previous = enriched.get(activity);
  if (previous?.bridge === bridge) return previous.row;
  const row = { ...activity };
  enriched.set(activity, { bridge, row });
  records.set(row, { ...record, receipt: receiptOf(bridge), receiptDetail: bridge.detail });
  return row;
}

function pairable(bridge: Activity): boolean {
  const receipt = receiptOf(bridge);
  const outcome = outcomeOf(failedReceipt(receipt) ? "failed" : bridge.status);
  // A successful check can still report a failed child or an uncertain result.
  // Its full receipt is useful evidence and must remain available in history.
  const childOutcome = outcomeOf(text(receipt?.status));
  if (outcome === "done" && !representedResult(bridgeTool(bridge)!, receipt)) return false;
  if (receipt && (receipt.identityConflict === true || receipt.resultUnconfirmed === true
    || text(receipt.error) || text(receipt.guidanceNote) || text(receipt.slotReleasePending)
    || receipt.slotReleasePending === true || text(receipt.earlierFollowUpUncertain) || receipt.earlierFollowUpUncertain === true
    || receipt.hasGuidanceNotDelivered === true
    || Number(receipt.guidanceNotDeliveredTotal) > 0
    || Array.isArray(receipt.guidanceNotDelivered) && receipt.guidanceNotDelivered.length > 0)) return false;
  return outcome !== "failed" && outcome !== "stopped" && childOutcome !== "failed"
    && childOutcome !== "stopped" && receipt?.status !== "unknown" && receipt?.superseded !== true
    && (bridge.itemCount ?? 1) <= 1;
}

/** Rows that can stand for each other share this exact turn evidence, so
 * hiding one never removes a turn's only status or duration carrier. */
function laneKey(activity: Activity, tool: Tool): string {
  return JSON.stringify([activity.turnId, activity.turnStatus, activity.turnDurationMs, tool]);
}

function timelineIndexes(activities: Activity[]): number[] {
  const indexes = activities.map((_, index) => index);
  const sorted = activities.every((activity, index) => index === 0
    || (activities[index - 1].timelineOrder ?? Number.MAX_SAFE_INTEGER) <= (activity.timelineOrder ?? Number.MAX_SAFE_INTEGER));
  return sorted ? indexes : indexes.sort((left, right) =>
    (activities[left].timelineOrder ?? Number.MAX_SAFE_INTEGER) - (activities[right].timelineOrder ?? Number.MAX_SAFE_INTEGER));
}

/**
 * Display rows for one thread. Each app row represents at most one earlier
 * bridge call of the same operation and turn outcome with an exact child owner.
 * Ambiguous calls and unreadable legacy receipts remain visible; adjacency is
 * never evidence that one child's receipt belongs to another child.
 * A represented successful or live call is hidden and lends its receipt to the
 * app row; a failed or stopped one stays visible with its original detail.
 * Unpaired calls get readable labels. Callers must derive run/answer inference
 * from the original rows before projecting them for display.
 */
export function presentManagedAgentActivities(activities: Activity[]): Activity[] {
  if (!activities.some((activity) => bridgeTool(activity))) return activities;
  // Unpaired bridge calls per lane, oldest first. Failed calls stay in their
  // lane too: they still separate an app row from an older unrelated call.
  const lanes = new Map<string, Map<string, number[]>>();
  const bridgeToApp = new Map<number, number>();
  const appToBridge = new Map<number, number>();
  for (const index of timelineIndexes(activities)) {
    const activity = activities[index];
    if (!activity.turnId || activity.timelineOrder === undefined) continue;
    const tool = bridgeTool(activity);
    if (tool) {
      const key = laneKey(activity, tool);
      const receipt = receiptOf(activity);
      const childId = childIdOf(activity, receipt);
      const messageId = messageIdOf(activity, receipt);
      if (!childId || tool === "send_agent_message" && !messageId) continue;
      const owner = JSON.stringify([childId, tool === "send_agent_message" ? messageId : undefined]);
      let lane = lanes.get(key);
      if (!lane) lanes.set(key, lane = new Map());
      const candidates = lane.get(owner);
      if (candidates) candidates.push(index);
      else lane.set(owner, [index]);
      continue;
    }
    const record = appRecord(activity);
    const represents = record && REPRESENTED_BY[record.operation];
    if (!represents || !record.childId) continue;
    const lane = lanes.get(laneKey(activity, represents));
    const owner = JSON.stringify([record.childId, record.operation === "message" ? record.messageId : undefined]);
    const candidates = lane?.get(owner);
    if (candidates?.length !== 1) continue;
    const bridge = candidates[0];
    lane!.delete(owner);
    bridgeToApp.set(bridge, index);
    appToBridge.set(index, bridge);
  }
  return activities.flatMap((activity, index): Activity[] => {
    const tool = bridgeTool(activity);
    if (tool) return bridgeToApp.has(index) && pairable(activity) ? [] : [relabel(activity, tool)];
    const bridge = appToBridge.get(index);
    if (bridge === undefined || !pairable(activities[bridge])) return [activity];
    const record = appRecord(activity);
    return record ? [withReceipt(activity, activities[bridge], record)] : [activity];
  });
}

/** Provider · model exactly as the crew shows it, from the bridge receipt. */
function receiptParticipant(receipt: Receipt | undefined): CoordinationParticipant | undefined {
  const provider = text(receipt?.provider);
  if (!provider || !PROVIDERS.has(provider)) return undefined;
  const model = text(receipt?.model);
  return { title: text(receipt?.title) ?? "", detail: `${providerDisplayName(provider as Provider)} · ${model || "model unknown"}` };
}

function childLabel(activity: Activity, participant: CoordinationParticipant | undefined): string {
  if (!participant) return "Sub-agent";
  // The row title usually names the task already; then add only who runs it.
  const title = participant.title.trim();
  return title && !activity.title.includes(title) ? `${title} · ${participant.detail}` : participant.detail;
}

function mailMessage(mailbox: ChildMailbox | undefined, record: CoordinationRecord, activity: Activity): ChildMailMessage | undefined {
  if (!record.messageId) return undefined;
  // A raw receipt does not retain the message text. Mailbox sequence ids can
  // be reused after history is cleared, so its immutable delivery receipt is
  // safer than assigning the live state of an unproven replacement message.
  if (record.source !== "app") return undefined;
  const message = mailbox?.messages.find((entry) => entry.id === record.messageId);
  if (!message) return undefined;
  if (!activity.agent?.messageCreatedAt || activity.agent.messageCreatedAt !== message.createdAt) return undefined;
  const direction = record.operation === "fromChild" ? "toParent" : "toChild";
  if (message.direction !== direction) return undefined;
  // App rows hold the message text; a different text means another message
  // reused this identity, so its state is not this row's evidence.
  const detail = activity.detail;
  if (!detail) return undefined;
  const preview = message.text.length > 600 ? `${message.text.slice(0, 600)}…` : message.text;
  if (detail !== preview) return undefined;
  return message;
}

/** Parent → child delivery, never presenting queued as delivered. */
function deliveryState(message: ChildMailMessage): Pick<CoordinationView, "state" | "note"> {
  const note = message.reason;
  if (message.state === "queued") return { state: { label: "Queued", tone: "" }, note: "Not delivered yet" };
  if (message.state === "delivering") return { state: { label: "Delivering", tone: "live" }, note: "Delivery not confirmed yet" };
  if (message.state === "delivered") {
    return { state: { label: message.via === "read" ? "Read by sub-agent" : message.via === "turn" ? "Delivered in follow-up" : "Delivered", tone: "" },
      ...(message.via === "steer" ? { note: "Accepted into its running turn" } : {}) };
  }
  if (message.uncertain) return { state: { label: message.state === "cancelled" ? "Cancelled · unconfirmed" : "Delivery unconfirmed", tone: "stopped" }, note: note ?? "May have reached the sub-agent" };
  if (message.state === "failed") return { state: { label: "Not delivered", tone: "bad" }, note };
  return { state: { label: "Cancelled", tone: "stopped" }, note };
}

/** Child → parent mailbox state. A question is answered only by a delivered reply. */
function parentMailState(message: ChildMailMessage): Pick<CoordinationView, "state" | "note"> {
  const read = message.state === "unread" ? "Not read by parent yet" : "Read by parent";
  if (message.kind !== "question") return { state: { label: message.state === "unread" ? "Unread" : "Read by parent", tone: "" } };
  if (message.answeredAt) return { state: { label: "Answered", tone: "" }, note: read };
  if (message.closedAt) return { state: { label: "Closed, not answered", tone: "stopped" }, note: read };
  return { state: { label: "Awaiting answer", tone: "" }, note: read };
}

/** What the child's own state was when the check returned. Not the check's outcome. */
function childReport(receipt: Receipt | undefined): string | undefined {
  if (!receipt) return undefined;
  if (receipt.resultUnconfirmed === true) return "The check returned no readable result";
  if (receipt.superseded === true) return "Result changed while loading; not collected";
  const uncertainty = text(receipt.earlierFollowUpUncertain) ?? text(receipt.slotReleasePending);
  if (uncertainty) return uncertainty.slice(0, 400);
  if (receipt.earlierFollowUpUncertain === true || receipt.slotReleasePending === true) return "Earlier work or its concurrency slot remains unconfirmed";
  if (text(receipt.guidanceNote) || receipt.hasGuidanceNotDelivered === true || Number(receipt.guidanceNotDeliveredTotal) > 0
    || Array.isArray(receipt.guidanceNotDelivered) && receipt.guidanceNotDelivered.length > 0) return "Guidance delivery failed or is unconfirmed";
  if (receipt.needsResponse === true) return "Sub-agent asked a question";
  if ((Array.isArray(receipt.messages) && receipt.messages.length > 0 || Number(receipt.messageCount) > 0)
    && !text(receipt.result) && receipt.hasResult !== true) return "Sub-agent sent an update";
  if (Array.isArray(receipt.siblingsNeedingResponse) && receipt.siblingsNeedingResponse.length
    || Number(receipt.siblingsNeedingResponseCount) > 0) return "Another sub-agent asked a question";
  if (receipt.followUpPending === true) return "Follow-up not running yet";
  const status = text(receipt.status);
  if (status === "running" || status === "starting") return "Sub-agent still working";
  if (status === "failed") return text(receipt.error) ? `Sub-agent failed: ${text(receipt.error)!.slice(0, 400)}` : "Sub-agent failed";
  if (status === "cancelled") return "Sub-agent was stopped";
  if (status === "unknown") return "Sub-agent status unconfirmed";
  if (status === "completed") {
    // `phase: accepted` also covers work that never needed sign-off.
    if (receipt.acceptedBy) return "Sub-agent finished · accepted";
    return receipt.awaitsSignoff === true ? "Sub-agent finished · awaiting sign-off" : "Sub-agent finished";
  }
  return undefined;
}

function bridgeDeliveryState(receipt: Receipt | undefined): Pick<CoordinationView, "state" | "note"> {
  const state = text(receipt?.state);
  if (state === "queued") return { state: { label: "Queued when sent", tone: "" }, note: "Current delivery state unknown" };
  if (state === "starting") return { state: { label: "Delivery was pending", tone: "" }, note: "Delivery was in progress when sent; current state unknown" };
  if (state === "started") return { state: { label: "Delivered in follow-up", tone: "" } };
  if (state === "delivered") return { state: { label: receipt?.via === "read" ? "Read by sub-agent" : "Delivered", tone: "" } };
  if (state === "unknown") return { state: { label: "Delivery unknown", tone: "" } };
  if (state === "failed" || state === "cancelled") {
    return { state: { label: receipt?.delivery === "uncertain" ? "Delivery unconfirmed" : state === "failed" ? "Not delivered" : "Cancelled", tone: state === "failed" && receipt?.delivery !== "uncertain" ? "bad" : "stopped" },
      note: text(receipt?.reason) };
  }
  return { state: { label: "Delivery unknown", tone: "" } };
}

/**
 * Direction, participants and truthful state for one coordination row.
 * `participant` is the crew's identity for the row's child, when known.
 * Without evidence the generic status word stands; nothing is inferred.
 */
export function coordinationView(
  activity: Activity, record: CoordinationRecord, participant: CoordinationParticipant | undefined, mailbox: ChildMailbox | undefined,
): CoordinationView {
  const receipt = record.receipt;
  const outcome = outcomeOf(failedReceipt(receipt) ? "failed" : activity.status);
  const recorded = receipt?.identityConflict === true ? undefined : receiptParticipant(receipt);
  const known = recorded ?? participant;
  const child = childLabel(activity, known);
  // `about` rows name only their subject; an unknown one is left unnamed.
  const route = (direction: CoordinationView["direction"]): CoordinationView => direction === "toChild"
    ? { direction, from: "Parent", to: child }
    : direction === "toParent" ? { direction, from: child, to: "Parent" } : { direction, from: known ? child : "" };
  // Specific wording only describes a completed operation. Live, failed and
  // stopped rows keep their generic state, and failures their own detail.
  const settled = (view: CoordinationView, extra: Pick<CoordinationView, "state" | "note"> = {}): CoordinationView =>
    outcome === "done" ? { ...view, ...extra } : view;
  if (receipt?.identityConflict === true && outcome === "done") {
    return { ...route(record.operation === "message" || record.operation === "spawn" ? "toChild" : "about"),
      state: { label: "Identity unconfirmed", tone: "stopped" }, note: "The returned sub-agent identity did not match the request" };
  }
  if (receipt?.resultUnconfirmed === true && outcome === "done") {
    return { ...route(record.operation === "message" || record.operation === "spawn" ? "toChild" : "about"),
      state: { label: "Result unconfirmed", tone: "stopped" }, note: "The tool returned no readable result" };
  }
  const representedTool = REPRESENTED_BY[record.operation];
  if (record.source === "bridge" && representedTool && outcome === "done" && !representedResult(representedTool, receipt)) {
    return { ...route(record.operation === "message" || record.operation === "spawn" ? "toChild" : "about"),
      state: { label: "Result unconfirmed", tone: "stopped" }, note: "No recorded result confirms this operation" };
  }
  switch (record.operation) {
    case "message": {
      const message = mailMessage(mailbox, record, activity);
      const view = route("toChild");
      if (message && outcome === "done") return { ...view, ...deliveryState(message) };
      // Recording a message is not delivering it; never fall back to "Done".
      return settled(view, receipt ? bridgeDeliveryState(receipt) : { state: { label: "Delivery unknown", tone: "" } });
    }
    case "fromChild": {
      const message = mailMessage(mailbox, record, activity);
      // Posting is delivery to the parent's mailbox; reading is not known.
      const sent: Pick<CoordinationView, "state" | "note"> = message ? parentMailState(message) : { state: { label: "Sent", tone: "" } };
      return settled(route("toParent"), sent);
    }
    case "followUp":
      return settled(route("toChild"), { state: { label: "Follow-up started", tone: "" } });
    case "check": {
      const view = route("about");
      if (outcome === "active") return { ...view, state: { label: record.source === "app" ? "Waiting" : "Checking", tone: "live" } };
      return settled(view, { state: { label: "Checked", tone: "" }, note: childReport(receipt) });
    }
    case "status":
      return settled(record.childId ? route("about") : { direction: "about", from: "Sub-agent status" },
        { state: { label: "Checked", tone: "" }, note: record.childId ? childReport(receipt) : undefined });
    case "stop":
      return settled(route("about"), { state: { label: "Stop requested", tone: "" } });
    case "accept":
      return settled(route("about"), { state: { label: "Accepted", tone: "" } });
    case "spawn":
      return settled(route("toChild"), receipt?.status === "unknown" ? { state: { label: "Status unconfirmed", tone: "stopped" } } : undefined);
    case "toParent":
      // Shown in the sub-agent's own conversation: it is the sender.
      return settled({ direction: "toParent", from: "This sub-agent", to: "Parent" },
        !text(receipt?.messageId) || receipt?.kind !== "question" && receipt?.kind !== "update"
          || receipt?.state !== "unread" && receipt?.state !== "read"
          ? { state: { label: "Delivery unknown", tone: "" } }
          : receipt?.duplicate === true ? { state: { label: "Already sent", tone: "" } } : { state: { label: "In parent's mailbox", tone: "" } });
    case "readParent": {
      const messages = receipt?.messages;
      const count = Array.isArray(messages) ? messages.length : typeof receipt?.messageCount === "number" ? receipt.messageCount : undefined;
      return settled({ direction: "toChild", from: "Parent", to: "This sub-agent" }, count === undefined ? undefined
        : { state: { label: count ? `${count} message${count === 1 ? "" : "s"}` : "No new messages", tone: "" } });
    }
    case "settings":
      return settled({ direction: "about", from: "Sub-agent settings" },
        receipt?.status === "awaiting_user" ? { state: { label: "Approval requested", tone: "" } } : undefined);
  }
}
