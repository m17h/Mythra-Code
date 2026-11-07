import type { TurnRunnerContext } from "../../../hooks/useTurnRunner";
import type { PermissionMode, Provider } from "../../../types";
import type { QueuedTurn, RemoteQueuedDelivery } from "../../taskStore";
import type { HostRequest, HostResponse, RemoteOperationIdentity, RemoteWorkResult } from "../wire";

export interface RemoteDispatchInfo {
  threadId: string; messageId: string; provider: Provider; startRequestId?: string; turnId?: string;
  permission?: PermissionMode;
}
/** Optional remote-only hooks. Local delivery never calls or awaits these. */
export interface RemoteTurnDelivery {
  identity: RemoteOperationIdentity;
  attemptId: string;
  messageId: string;
  /** Native lifetime for all children of an orchestration, not permission to replay a step. */
  openOwner?(kind: "parent" | "workflow" | "start", runId: string, threadId?: string): Promise<string>;
  /** Only after native atomically detached an empty queued preparation. */
  adoptDetachedOwner?(): void;
  readonly ownerHandle?: string;
  readonly ownerRunId?: string;
  bindOwner?(threadId: string): Promise<void>;
  childStep?(stepId: string, threadId?: string, kind?: "prompt" | "command", targetHandle?: string): Promise<RemoteTurnDelivery>;
  assertAllowed(): void;
  beforeCreate(): Promise<void>;
  queued(threadId: string, queuedTurnId: string): Promise<void>;
  bindThread(threadId: string): Promise<void>;
  beforeDispatch(info: RemoteDispatchInfo): Promise<void>;
  accepted(info: Partial<RemoteDispatchInfo>): Promise<void>;
  uncertain(info?: Partial<RemoteDispatchInfo>): Promise<void>;
  rejected(code?: string): Promise<void>;
  failure(reason: unknown): Promise<void>;
  metadata(): RemoteOperationIdentity & { generation: number; attemptId: string; messageId: string; ownerHandle?: string };
  invokeSteer<T>(action: string, args: Record<string, unknown>): Promise<T>;
  result(): RemoteWorkResult;
}
export interface RemoteStopSnapshot {
  threadId: string; turnId?: string; startRequestId?: string; agentRunId?: string; runStartedAt?: number;
  parentRunId?: string; workflowId?: string; workflowRunId?: string; ownerHandle?: string; ownerRunId?: string;
}
export interface RemoteTurnRunner {
  continueParentTo?(context: TurnRunnerContext, request: { parentRunId: string; notice: string; progress: string; wokenQuestions: string[] }): Promise<RemoteWorkResult>;
  sendPromptTo(context: TurnRunnerContext, text: string): Promise<RemoteWorkResult>;
  steerThread(context: TurnRunnerContext, text: string, expected: RemoteStopSnapshot): Promise<RemoteWorkResult>;
  queuePromptTo(context: TurnRunnerContext, text: string, delivery: RemoteQueuedDelivery): Promise<RemoteWorkResult>;
  stopThreadTurn(context: TurnRunnerContext, expected: RemoteStopSnapshot): Promise<void>;
  getThreadStopTarget(threadId: string): RemoteStopSnapshot;
  pumpRemoteQueue(threadId: string): void;
}
export interface RemoteWorkAdapter {
  /** Shared Studio handle namespaces for reads and stamped mutations. */
  studio?: import("./studio").HostStudio;
  studioReads?: import("./studioReads").HostStudioReads;
  dispatch(request: HostRequest): Promise<NonNullable<HostResponse["result"]>>;
  resolveQueued(entry: QueuedTurn): Promise<TurnRunnerContext>;
  reconcileQueues(pump?: boolean): Promise<void>;
  dispose(): void;
}
