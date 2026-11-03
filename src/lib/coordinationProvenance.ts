import type { CoordinationMetadata, CoordinationTool } from "../types";

const TOOLS = new Set<CoordinationTool>([
  "spawn_mythra_agent", "agent_status", "collect_agent", "cancel_agent", "send_agent_message",
  "accept_agent", "message_parent", "read_parent_messages", "propose_agent_settings",
]);

type RecordValue = Record<string, unknown>;
const object = (value: unknown): RecordValue | undefined => value && typeof value === "object" && !Array.isArray(value)
  ? value as RecordValue : undefined;
const exactString = (value: unknown, max = 1024): string | undefined => typeof value === "string" && value.trim() && value.length <= max
  ? value : undefined;

/** Only a complete own-server namespace and exact known tool qualify. Never
 * infer ownership from bare tool names, native tools, prose or output shape. */
export function ownCoordinationTool(name: string): CoordinationTool | undefined {
  const tool = /^(?:mcp__mythra_agents__|mythra_agents(?:__|\s*[.:/]\s*))([a-z_]+)$/.exec(name)?.[1];
  return tool && TOOLS.has(tool as CoordinationTool) ? tool as CoordinationTool : undefined;
}

function parsed(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return undefined; }
}

export function coordinationInput(name: string, value: unknown, previous?: CoordinationMetadata): CoordinationMetadata | undefined {
  const tool = ownCoordinationTool(name);
  if (!tool) return undefined;
  const input = object(parsed(value));
  const childId = exactString(input?.childId);
  const sameInput = previous?.provenance === "mythra_agents" && previous.tool === tool
    && (childId === undefined || previous.childId === childId);
  return { ...(sameInput ? previous : {}), provenance: "mythra_agents", tool,
    ...(childId ? { childId } : {}) };
}

const STRING_HEADERS = ["status", "phase", "provider", "model", "title", "error", "state", "via",
  "delivery", "reason", "kind", "acceptedBy", "guidanceNote", "note", "acceptanceNote", "questionsNote", "followUpWaiting",
  "earlierFollowUpUncertain", "slotReleasePending"] as const;
const BOOLEAN_HEADERS = ["isError", "superseded", "needsResponse", "awaitsSignoff", "followUpPending", "duplicate"] as const;
const NUMBER_HEADERS = ["guidanceNotDeliveredTotal", "guidanceNextOffset", "acceptedAt", "unreadRemaining"] as const;
const PROSE_HEADERS = new Set<string>(["error", "reason", "guidanceNote", "note", "acceptanceNote", "questionsNote", "followUpWaiting",
  "earlierFollowUpUncertain", "slotReleasePending"]);

/** Read the ORIGINAL complete result before its display tail is bounded.
 * Preserve failures and uncertainty as well as the child/message identities. */
export function coordinationResult(metadata: CoordinationMetadata | undefined, value: unknown, isError = false): CoordinationMetadata | undefined {
  if (!metadata) return undefined;
  let result = object(parsed(value));
  let envelopeError = isError || result?.isError === true;
  if (result && Array.isArray(result.content)) {
    const content = result.content.map((entry) => {
      const block = object(entry);
      return block?.type === "text" && typeof block.text === "string" ? block.text : "";
    }).join("\n");
    result = object(parsed(content));
  }
  if (!result && !envelopeError) return { ...metadata, receipt: { receiptSummary: true, resultUnconfirmed: true } };
  const receipt: RecordValue = { receiptSummary: true };
  const childId = exactString(result?.childId);
  const messageId = exactString(result?.messageId);
  if (childId) receipt.childId = childId;
  if (messageId) receipt.messageId = messageId;
  for (const key of STRING_HEADERS) {
    const field = result?.[key];
    if (typeof field === "string") {
      if (PROSE_HEADERS.has(key)) receipt[key] = field.slice(0, 2048);
      else if (field.length <= (key === "title" ? 200 : 1024)) receipt[key] = field;
    }
  }
  for (const key of BOOLEAN_HEADERS) if (typeof result?.[key] === "boolean") receipt[key] = result[key];
  for (const key of NUMBER_HEADERS) if (typeof result?.[key] === "number" && Number.isFinite(result[key])) receipt[key] = result[key];
  if (Array.isArray(result?.messages)) receipt.messageCount = result.messages.length;
  if (Array.isArray(result?.siblingsNeedingResponse)) receipt.siblingsNeedingResponseCount = result.siblingsNeedingResponse.length;
  if (Array.isArray(result?.guidanceNotDelivered)) receipt.hasGuidanceNotDelivered = result.guidanceNotDelivered.length > 0;
  if (typeof result?.result === "string") receipt.hasResult = Boolean(result.result.trim());
  // The bridge reports refusals as a bare error result. A richer child report
  // may contain its own error without the coordination operation having failed.
  envelopeError ||= Boolean(typeof result?.error === "string" && result.error
    && Object.keys(result).every((key) => key === "error" || key === "isError"));
  if (envelopeError) receipt.isError = true;
  // Input ownership wins if malformed output names another child. Preserve
  // that refusal as evidence; never use it to pair somebody else's app row.
  if (metadata.childId && childId && metadata.childId !== childId) receipt.identityConflict = true;
  return { ...metadata, ...(!metadata.childId && childId ? { childId } : {}),
    ...(messageId ? { messageId } : {}), receipt };
}
