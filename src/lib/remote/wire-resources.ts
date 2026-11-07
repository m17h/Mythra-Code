import type { WireProvider } from "./wire";
export type HostResourceOperation = "activity.read" | "review.diff" | "git.autoPublish.read" | "agents.read" | "mail.read" | "workflows.view" | "actions.list" | "usage.thread.read" | "usage.thread.details" | "thread.handoff.lineage" | "git.suggestion.read" | "terminal.list" | "git.context" | "usage.prices.refresh" | "tools.mcp.list" | "agents.presets.read";
export interface HostResourceArgs { workspaceId: string; threadId?: string; activityId?: string; agentId?: string; workflowId?: string; limit?: number }
export const REMOTE_ACTIVITY_BYTES = 256 * 1024;
export interface WireWorker {
  id: string; kind: "cross-provider" | "native"; status: string; title: string; detail: string; createdAt: number;
  target: string; provider?: WireProvider; model?: string; task?: string; progress?: string; result?: string;
  canOpen: boolean; canStop: boolean; canAccept: boolean; review?: "awaiting" | "accepted";
  finishedAt?: number; targetId?: string; nativeRuntime?: "codex" | "claude";
}
export interface WireMailMessage { id: string; direction: "toParent" | "toChild"; kind: "question" | "update" | "guidance"; text: string; state: string; createdAt: number; answeredAt?: number; closedAt?: number; settledAt?: number; uncertain?: boolean; replyTo?: string; via?: "steer" | "turn" | "read" }
export interface WireMailbox { agentId: string; dropped: number; messages: WireMailMessage[]; truncated: boolean }
export interface WireUsageAmounts { usage: { totalTokens: number; inputTokens: number; outputTokens: number; cachedInputTokens: number; reasoningOutputTokens: number; cacheWriteInputTokens?: number; cacheWrite1hInputTokens?: number; outputTokensReported?: boolean; cacheReadReported?: boolean; cacheWriteReported?: boolean; cacheReadUnknownTokens?: number; cacheWriteUnknownTokens?: number; serviceTier?: string; serviceTierSource?: "reported" | "requested" | "unknown"; requestedServiceTier?: string; tokenAvailability?: "reported" | "partial" | "unavailable" } | null; estimatedCost: number | null; pricedTokens: number; unpricedTokens: number }
export interface WireUsageDetail { threadId: string; own: WireUsageAmounts; subagents: WireUsageAmounts; total: WireUsageAmounts; context: { totalTokens?: number; inputTokens?: number; outputTokens?: number; cachedInputTokens?: number; reasoningOutputTokens?: number; contextWindow?: number | null }; descendants: { threadId: string; amounts: WireUsageAmounts }[]; missingThreadIds: string[]; historyPartialThreadIds: string[]; claudeNativeIncluded: boolean; detailsAvailable: false }
export interface WireWorkflowView { digest: string; id: string; name: string; description: string; enabled: boolean; provider: WireProvider; model: string; variables: { id: string; name: string; value: string; promptOnRun: boolean }[]; steps: { id: string; name: string; type: "agent" | "command"; prompt?: string; command?: string; continueOnError: boolean }[]; runs: { id: string; status: string; startedAt: number; finishedAt?: number; threadId?: string }[] }
export interface WireTerminalSummary { terminalId: string; command: string; state: string; startedAt: number; owned: boolean; threadId?: string; columns?: number; rows?: number; seq?: number }
export interface WireResourceResult {
  revision: string; truncated: boolean; workers?: WireWorker[]; mailboxes?: WireMailbox[]; workflows?: WireWorkflowView[];
  actions?: { id: string; name: string; command: string; icon?: string }[]; usage?: WireUsageDetail;
  lineage?: { threadId: string; sourceThreadId?: string; sourceTitle?: string; sourceProvider?: WireProvider; targetProvider?: WireProvider; createdAt?: number };
  suggestion?: { id: string; message: string; stagedMessage?: string; token: string; stale: boolean } | null;
  pricing?: { available: boolean; checking: boolean; updatedAt?: string };
  tools?: { name: string; status: string; tools: number }[]; toolsAvailability?: "ready" | "unavailable";
  presets?: { id: string; name: string; subagents: import("./wire").WireSubagents }[];
  git?: { headOid: string | null; branch: string | null; branches: { name: string; current: boolean }[]; stagedFiles: number; unstagedFiles: number; changedFiles: number };
  terminals?: WireTerminalSummary[];
  /** The whole of one work-history row, up to REMOTE_ACTIVITY_BYTES. */
  activity?: { id: string; detail: string; truncated: boolean };
  /** What the current turn changed, when the host has that. Empty means use the repository. */
  reviewDiff?: { text: string; source: "runtime" | "repository"; baseline: string; untrackedPaths: string[]; truncated: boolean };
  autoPublish?: { enabled: boolean; status: string; message: string; repository?: string };
}
