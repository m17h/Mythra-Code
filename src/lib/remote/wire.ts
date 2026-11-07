import type { WireResourceResult } from "./wire-resources";
export type * from "./wire-resources";
import type { StudioResult, ProjectNavigationResult } from "./wire-studio";
/** Phase 2 protocol. These are allowlists, never serialized local store objects. */
import type { DeviceGrant } from "./types";

export type WireProvider = "openai" | "openrouter" | "lmstudio" | "claude" | "cursor";
export type WireTaskStatus = "idle" | "starting" | "running" | "completed" | "interrupted" | "error";
export type WireTurnStatus = "inProgress" | "completed" | "interrupted" | "failed";
export type WireAvailability = "ready" | "recovering";

export interface WireWorkspace { id: string; name: string; isChat: boolean; pinned?: boolean; scheduled?: { newConversations: number; threadPrompts: number } }
export interface WireThread {
  id: string; workspaceId: string; provider: WireProvider; title: string;
  preview: string; updatedAt: number; status: WireTaskStatus;
  archived?: boolean; child?: boolean; parentThreadId?: string; pinned?: boolean; unread?: boolean;
  /** Stopped until someone answers an approval or question. */
  waiting?: boolean;
  /** Prompts timed for later in this thread. */
  scheduled?: number;
}
export interface WireQuestion {
  id: string; title: string; secret: boolean; options: string[];
  answered: boolean;
  /** Secret answers are represented only by a redacted marker. */
  answers?: string[];
}
export interface WireMessage {
  id: string; order: number; role: "user" | "assistant"; text: string;
  turnId: string | null; streaming: boolean; turnStatus: WireTurnStatus | null;
  phase?: "commentary" | "final";
  turnDurationMs?: number;
  provenance?: "mythra-notice";
  steerStatus?: "sending" | "accepted" | "queued" | "read" | "unconfirmed";
  attachmentNames?: string[];
  /** Positions in the message's attachments that hold an image to ask for. */
  attachmentImages?: number[];
  questions?: WireQuestion[];
  truncated?: boolean;
}
export interface WireActivity {
  id: string; order: number;
  kind: "command" | "file" | "reasoning" | "agent" | "warning" | "compaction";
  title: string; detail?: string; status: string | null;
  turnId: string | null; turnStatus: WireTurnStatus | null;
  workType?: "research" | "files" | "commands";
  turnDurationMs?: number;
  itemCount?: number;
  agent?: { action: "spawn" | "sendInput" | "resume" | "wait" | "close" | "status";
    provider?: WireProvider; model?: string; count?: number };
  truncated?: boolean;
}
export interface WireApproval {
  id: string;
  kind: "command" | "file" | "permissions" | "question" | "settings" | "other";
  summary: string;
  hostOnly: true;
}
export interface WireQueuedTurn {
  id: string; text: string; status: "queued" | "sending" | "failed";
  createdAt: number; attachmentNames: string[]; truncated?: boolean;
}
export interface WireHistory { hasMore: boolean; cursor?: string }
export interface WireThreadState {
  status: WireTaskStatus;
  availability: WireAvailability;
  activeTurnId: string | null;
  workingStartedAt: number | null;
  error: string | null;
}
export interface ThreadSnapshot extends WireThreadState {
  messages: WireMessage[]; activities: WireActivity[];
  approvals: WireApproval[]; queuedTurns: WireQueuedTurn[]; history: WireHistory;
}
export interface ThreadFrame extends WireThreadState {
  upsertMessages?: WireMessage[];
  appendMessageText?: { id: string; text: string }[];
  removeMessageIds?: string[];
  upsertActivities?: WireActivity[];
  removeActivityIds?: string[];
  approvals?: WireApproval[];
  queuedTurns?: WireQueuedTurn[];
  history?: WireHistory;
  reset?: { messages: WireMessage[]; activities: WireActivity[] };
}
export interface ThreadReadResult {
  messages: WireMessage[]; activities: WireActivity[]; history: WireHistory;
}
export interface WorkspacesListResult { workspaces: WireWorkspace[] }
export interface ThreadsListResult { threads: WireThread[]; cursor?: string }
/** Renderer -> Rust. Rust registers the subscriber at this exact boundary. */
export interface HostTimelineSubscribeResult { epoch: string; seq: number; snapshot?: ThreadSnapshot }
/** Rust -> viewer. Replay frames are supplied by Rust, not by the host renderer. */
export interface TimelineSubscribeResult extends HostTimelineSubscribeResult { frames?: { seq: number; frame: ThreadFrame }[] }
export interface ThreadsListArgs { workspaceId: string; cursor?: string; limit?: number }
export interface TimelineReadArgs { threadId: string; before?: string; limit?: number }
export interface TimelineSubscribeArgs { threadId: string; epoch?: string; afterSeq?: number; needSnapshot?: boolean }
export type HostViewOperation = "workspaces.list" | "threads.list" | "timeline.read" | "timeline.subscribe";
export interface RemoteWireError { code: string; message: string }
export interface HostRequest {
  requestId: string; generation: number; device: string; grant: DeviceGrant;
  op: string; args: unknown;
  /** Present only after Rust has durably claimed a mutating operation. */
  opId?: string;
  opSeq?: number;
}
export interface HostAttachResult { generation: number }
export interface HostLeaseCheck { generation: number }
export interface HostTick { tickId: number; generation: number }
export interface HostSubscribers { generation: number; threadId: string; count: number }
export interface HostPublish {
  generation: number; threadId: string; epoch: string; frames: { seq: number; frame: ThreadFrame }[];
}
export interface HostResponse {
  generation: number; requestId: string;
  result?: WireResourceResult | WorkspacesListResult | ThreadsListResult | ThreadReadResult | HostTimelineSubscribeResult | RemoteWorkResult | WireWorkCapabilities | HostContextResult | FilesSearchResult | WireParityReadResult | StudioResult | ProjectNavigationResult | WireDomainReadResult;
  error?: RemoteWireError;
}
export interface RemoteViewerFrame { device: string; threadId: string; epoch: string; seq: number; frame: ThreadFrame }
export interface RemoteViewerState { device: string; threadId: string; state: "live" | "recovering" | "stale" | "removed" }

/** Leave room below the 2 MiB transport ceiling for bridge and TLS envelopes. */
export const REMOTE_WINDOW_BYTES = 512 * 1024;
export const REMOTE_RESULT_BYTES = 1024 * 1024;
export const REMOTE_MAX_ROWS = 200;
export const REMOTE_DEFAULT_ROWS = 80;
export const REMOTE_GRACE_MS = 120_000;

// Phase 3 is separate from the presentation-only Phase 2 timeline shapes.
export type RemoteWorkOperation = "draft.settings.set" | "prompt.cancel" | "prompt.send" | "prompt.steer" | "prompt.queue" | "turn.stop" | "approval.answer" | "question.answer"
  | "thread.settings.set" | RemoteRowOperation | ParityMutationOperation;
export interface RemoteOperationIdentity { device: string; opId: string; opSeq: number }
export interface RemoteWorkResult {
  opId: string;
  state: "accepted" | "queued" | "rejected" | "uncertain";
  threadId?: string; turnId?: string; queuedTurnId?: string; messageId?: string; attemptId?: string;
  workspaceId?: string;
  workflowRunId?: string; editHandle?: string; processHandle?: string;
  terminalId?: string; output?: string;
  draftHandle?: string; startTarget?: string; settings?: WireExecutionSettings;
  error?: RemoteWireError;
}
export interface WireWorkTarget { handle: string; kind: "turn" | "start" | "parent" | "approval" | "question" }
export interface WireWorkApproval {
  target: WireWorkTarget; summary: string; canAllowOnce: boolean; canDeny: boolean;
  questions?: WireQuestion[];
}
export interface WireWorkCapabilities {
  threadId: string; provider: WireProvider; canSend: boolean; canQueue: boolean; canSteer: boolean;
  stop?: WireWorkTarget; steer?: WireWorkTarget; approvals: WireWorkApproval[];
}

// Same-app host context: explicit public fields, never AppSettings, raw model
// configuration, native paths, account records, tool inputs or credentials.
export type WireEffort = "low" | "medium" | "high" | "xhigh" | "max";
export interface WireHostModel { id: string; name: string; efforts: WireEffort[]; defaultEffort?: WireEffort }
export interface WireHostProvider { id: WireProvider; name: string; ready: boolean; models: WireHostModel[] }
export interface WireHostSkill { id: string; name: string; description: string; enabled: boolean }
export interface WireHostWorkflow { id: string; name: string; description: string }
export interface WireHostUsage {
  totalTokens: number; inputTokens: number; outputTokens: number; cachedInputTokens: number;
  reasoningOutputTokens: number; contextTokens?: number; contextWindow?: number;
}
export interface WireRemoteCapabilities {
  fullAccess: boolean; gitWrite: boolean; checkpointRestore: boolean; terminal: boolean;
  /** Absent native/older grant fields are always treated as false. */
  manageProjects: boolean;
}
export interface HostContextArgs { workspaceId: string; threadId?: string }
export interface HostContextResult {
  execution?: WireExecutionSettings;
  /** Present when the host's contextual mutation adapter supplies revisions. */
  revision?: string;
  workspaceId: string; threadId?: string; providers: WireHostProvider[];
  selected: { provider: WireProvider; model: string; effort: WireEffort };
  saved?: { model?: string; effort?: WireEffort };
  projectPrompt: string; projectPromptMode: "append" | "replace";
  skills: WireHostSkill[]; workflows: WireHostWorkflow[];
  run?: { command: string; setupCommand?: string; label?: string };
  check?: { command: string }; usage: WireHostUsage | null;
  discovery?: { provider: WireProvider; model: string; effort: WireEffort | "default"; fast: boolean };
  capabilities: WireRemoteCapabilities; truncated: boolean;
}
export interface FilesSearchArgs { workspaceId: string; threadId?: string; query: string }
export interface FilesSearchResult {
  /** Paths are project-relative display/mention text only, never native roots. */
  files: { id: string; name: string; relativePath: string }[]; truncated: boolean;
}
export interface ThreadSettingsSetArgs {
  opId: string; opSeq: number; threadId: string; model?: string; effort?: WireEffort; provider?: WireProvider;
  permission?: "read-only" | "ask" | "full"; serviceTier?: "standard" | "fast" | null; subagents?: WireSubagents;
}
export interface WireCrewTarget {
  id: string; provider: WireProvider; model: string; label: string; description: string; enabled: boolean;
  reasoningMode: "inherit" | "fixed" | "agent"; reasoningEffort: WireEffort; reasoningMaxEffort: WireEffort; autoCompactTokens?: number;
}
export interface WireSubagents {
  enabled: boolean; engine: "mythra" | "native"; maxConcurrent: number; autoCompactTokens?: number;
  /** Who the Mythra engine may delegate to. Checked against the host's own catalog. */
  crew?: WireCrewTarget[];
  nativeOptions?: { claude?: { model?: string; autoCompactTokens?: number }; codex?: { model?: string; reasoningEffort?: WireEffort; autoCompactTokens?: number } };
}
export interface WireExecutionSettings {
  provider?: WireProvider; model?: string; effort?: WireEffort; permission?: "read-only" | "ask" | "full";
  serviceTier?: "standard" | "fast" | null; subagents?: WireSubagents; isolated?: boolean;
  /** A saved thread's crew. A draft carries it in `subagents.crew`. */
  crew?: WireCrewTarget[];
}
export interface DraftSettingsSetArgs extends WireExecutionSettings { opId: string; opSeq: number; workspaceId: string; draftHandle?: string; handoffHandle?: string }
/** Formatted evidence is not an invocation source. Persist this authored source
 * with the outbox entry, including empty string for feedback-only prompts. */
export interface RemotePromptArgs {
  opId: string; opSeq: number; text: string; threadId?: string; workspaceId?: string;
  draftHandle?: string; attachmentIds?: string[]; skillInvocationText?: string;
  target?: string;
}
export interface PromptCancelArgs { opId: string; opSeq: number; workspaceId: string; startTarget: string }
export type RemoteRowOperation = "thread.rename" | "thread.archive" | "thread.restore" | "thread.delete" | "thread.pin" | "thread.fork"
  | "projects.pin" | "projects.remove" | "projects.reorder";
export interface ThreadRenameArgs { opId: string; opSeq: number; threadId: string; name: string }
export interface ThreadRowArgs { opId: string; opSeq: number; threadId: string }
export interface ThreadDeleteArgs extends ThreadRowArgs { confirmed: true }
export interface ThreadPinArgs extends ThreadRowArgs { pinned: boolean }
export interface ProjectRowArgs { opId: string; opSeq: number; workspaceId: string }
export interface ProjectRemoveArgs extends ProjectRowArgs { confirmed: true }
export interface ProjectPinArgs extends ProjectRowArgs { pinned: boolean }
export interface ProjectReorderArgs extends ProjectRowArgs { relativeTo: string; position: "before" | "after" }

/** Extended non-Studio parity operations. All mutations are journaled. */
export type ParityReadOperation = "queue.read" | "schedules.read" | "workflows.list" | "workflows.read"
  | "projects.settings.read" | "projects.instructions.read" | "models.list" | "models.refresh" | "models.search"
  | "skills.list" | "skills.read" | "skills.analyze" | "usage.account.read" | "usage.account.refresh"
  | "threads.search" | "threads.archived" | "parent.read" | "thread.handoff.read" | "run.status" | "checks.read" | "checks.status"
  | "discovery.run.status" | "discovery.check.status";
export type ParityMutationOperation = "queue.edit.begin" | "queue.edit.finish" | "queue.retry" | "queue.steer" | "queue.remove"
  | "prompt.schedule" | "prompt.scheduleNew" | "schedules.edit" | "schedules.reschedule" | "schedules.release" | "schedules.remove"
  | "thread.pullRequest.set" | "thread.compact" | "thread.rollback" | "thread.handoff.prepare" | "thread.handoff.send" | "parent.continue" | "parent.dismiss"
  | "thread.archiveMany" | "thread.deleteMany" | "workflows.start" | "workflows.stop"
  | "projects.settings.set" | "projects.instructions.set" | "projects.profiles.save" | "projects.profiles.delete" | "projects.profiles.select"
  | "projects.run.set" | "projects.check.set" | "run.start" | "run.stop" | "checks.start" | "checks.stop"
  | "discovery.run.start" | "discovery.run.stop" | "discovery.check.start" | "discovery.check.stop" | "discovery.settings.set"
  | "checkpoint.accept" | "agents.stop" | "agents.accept" | "agents.replace" | "actions.run" | "review.start" | "git.suggestCommit";
export type HostParityOperation = ParityReadOperation | ParityMutationOperation;
/** Host-generated resource revision; never a timestamp supplied as authority. */
export interface ParityTarget { workspaceId: string; threadId?: string }
export interface ParityMutationArgs extends ParityTarget { opId: string; opSeq: number; revision: string }
export interface QueueMutationArgs extends ParityMutationArgs {
  threadId: string; queueId: string; editHandle?: string; text?: string; cancel?: true; target?: string;
}
/** A new scheduled prompt uses a host-owned draft token, never provider options. */
export interface PromptScheduleNewArgs extends ParityMutationArgs { text: string; deliverAt: number; draftHandle?: string }
export interface ProviderHandoffReadArgs extends ParityTarget { threadId: string; provider: WireProvider }
export interface WorkflowStartArgs extends ParityMutationArgs { workflowId: string; variables?: Record<string, string>; userPrompt?: string }
export interface WorkflowStopArgs extends ParityMutationArgs { workflowId: string; runId: string }
/** Shared allowlisted records for contextual controls, never raw persisted state. */
export interface WireParityRow {
  id: string; name?: string; description?: string; text?: string; status?: string; handoffHandle?: string;
  provider?: WireProvider; model?: string; effort?: WireEffort;
  threadId?: string; parentThreadId?: string; runId?: string; queueId?: string;
  enabled?: boolean; pinned?: boolean; archived?: boolean; editing?: boolean;
  createdAt?: number; updatedAt?: number; deliverAt?: number; value?: number; limit?: number;
  command?: string; setupCommand?: string; prompt?: string; mode?: string;
  variables?: { id: string; label: string; required: boolean; default?: string }[];
  steps?: { id: string; type: "agent" | "command" | "wait"; name: string; prompt?: string; command?: string; provider?: WireProvider; model?: string }[];
}
export interface WireParityReadResult { revision: string; rows: WireParityRow[]; cursor?: string; truncated: boolean; timezone?: string }

// Domain presentation is deliberately separate from host filesystem records.
export type NativeTerminalOperation = "terminal.open" | "terminal.write" | "terminal.resize" | "terminal.close";
export interface TerminalOpenArgs { opId: string; opSeq: number; workspaceId: string; threadId?: string; command: string; columns: number; rows: number }
/** Studio uses one shared presentation contract and one opaque-handle namespace. */
export type WireDomainReadResult = import("./wire-studio").CheckpointListResult | import("./wire-studio").WorktreeStatusResult
  | import("./wire-studio").RevertPreviewResult;
