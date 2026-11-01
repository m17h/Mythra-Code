import { invoke } from "@tauri-apps/api/core";

/** Claude summary detail uses local estimates, not token-count API calls. */
export interface ClaudeContextCategory {
  id: string | null;
  name: string;
  tokens: number | null;
  kind: "used" | "free" | "buffer" | "deferred" | null;
}

export interface ClaudeContextTokenGroup {
  name: string;
  tokens: number | null;
}

export interface ClaudeContextMessageBreakdown {
  toolCallTokens: number | null;
  toolResultTokens: number | null;
  attachmentTokens: number | null;
  assistantMessageTokens: number | null;
  userMessageTokens: number | null;
  redirectedContextTokens: number | null;
  unattributedTokens: number | null;
  attachmentsByType: ClaudeContextTokenGroup[] | null;
}

export interface ClaudeContextReport {
  categories: ClaudeContextCategory[];
  totalTokens: number;
  maxTokens: number | null;
  rawMaxTokens: number | null;
  percentage: number | null;
  model: string | null;
  messageBreakdown: ClaudeContextMessageBreakdown | null;
}

export interface ClaudeThreadContextResult {
  status: "live" | "cached" | "unavailable";
  threadId: string;
  turnId: string;
  /** Milliseconds since epoch. A cached report keeps its original timestamp. */
  sampledAt: number | null;
  reason: string | null;
  report: ClaudeContextReport | null;
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/** Missing/invalid counts remain unknown; never turn them into measured zero. */
function count(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function tokenGroups(value: unknown): ClaudeContextTokenGroup[] | null {
  if (!Array.isArray(value)) return null;
  return value.flatMap((entry) => {
    const row = object(entry);
    const name = text(row?.name);
    return name ? [{ name, tokens: count(row?.tokens) }] : [];
  });
}

/** Stable control-response IDs arrived after summary support. Unknown IDs
 * stay unknown; category names can change or be localized. */
function contextCategoryId(value: unknown): string | null {
  switch (value) {
    case "system_prompt": case "system_tools": case "mcp_tools":
    case "mcp_instructions": case "mcp_tools_deferred": case "system_tools_deferred":
    case "custom_agents": case "memory_files": case "skills": case "messages":
    case "autocompact_buffer": case "compact_buffer": case "free_space":
      return value;
    default:
      return null;
  }
}

function contextCategoryKind(row: Record<string, unknown>, id: string | null): ClaudeContextCategory["kind"] {
  if (row.kind === "used" || row.kind === "free" || row.kind === "buffer" || row.kind === "deferred") return row.kind;
  // Older summary-capable CLIs expose isDeferred without kind or stable IDs.
  if (row.isDeferred === true) return "deferred";
  switch (id) {
    case "mcp_tools_deferred": case "system_tools_deferred": return "deferred";
    case "autocompact_buffer": case "compact_buffer": return "buffer";
    case "free_space": return "free";
    case "system_prompt": case "system_tools": case "mcp_tools":
    case "mcp_instructions": case "custom_agents": case "memory_files":
    case "skills": case "messages": return "used";
    default: return null;
  }
}

export function parseClaudeContextReport(value: unknown): ClaudeContextReport | null {
  const payload = object(value);
  const totalTokens = count(payload?.totalTokens);
  if (!payload || totalTokens === null || !Array.isArray(payload.categories)) return null;
  const breakdown = object(payload.messageBreakdown);
  return {
    totalTokens,
    maxTokens: count(payload.maxTokens),
    rawMaxTokens: count(payload.rawMaxTokens),
    percentage: count(payload.percentage),
    model: text(payload.model),
    categories: payload.categories.flatMap((entry): ClaudeContextCategory[] => {
      const row = object(entry);
      const name = text(row?.name);
      if (!name || !row) return [];
      const id = contextCategoryId(row.id);
      return [{
        id, name, tokens: count(row.tokens), kind: contextCategoryKind(row, id),
      }];
    }),
    messageBreakdown: breakdown ? {
      toolCallTokens: count(breakdown.toolCallTokens),
      toolResultTokens: count(breakdown.toolResultTokens),
      attachmentTokens: count(breakdown.attachmentTokens),
      assistantMessageTokens: count(breakdown.assistantMessageTokens),
      userMessageTokens: count(breakdown.userMessageTokens),
      redirectedContextTokens: count(breakdown.redirectedContextTokens),
      unattributedTokens: count(breakdown.unattributedTokens),
      attachmentsByType: tokenGroups(breakdown.attachmentsByType),
    } : null,
  };
}

/** Exact-turn read. Idle/unavailable runtimes return a cached snapshot or an
 * explicit unavailable result; this never starts or resumes Claude. */
export async function readClaudeThreadContext(threadId: string, turnId: string): Promise<ClaudeThreadContextResult> {
  const unavailable = (reason: string): ClaudeThreadContextResult => ({
    status: "unavailable", threadId, turnId, sampledAt: null, reason, report: null,
  });
  if (!threadId || !turnId) return unavailable("A thread and turn are required for a context summary.");
  try {
    const payload = object(await invoke<unknown>("claude_thread_context_usage", { threadId, turnId }));
    if (!payload || payload.threadId !== threadId || payload.turnId !== turnId) {
      return unavailable("The context summary did not match this turn.");
    }
    const report = parseClaudeContextReport(payload.report);
    if (!report || (payload.status !== "live" && payload.status !== "cached")) {
      return unavailable(text(payload.reason) ?? "Claude has not provided a context summary for this turn.");
    }
    return {
      status: payload.status, threadId, turnId,
      sampledAt: count(payload.sampledAt),
      reason: text(payload.reason),
      report,
    };
  } catch {
    return unavailable("Claude context details are unavailable. They can be read while the thread is running.");
  }
}
