import type { TurnRunnerContext } from "../../../hooks/useTurnRunner";
import type { PermissionMode, Provider } from "../../../types";
import type { QueuedTurn, RemoteQueuedDelivery } from "../../taskStore";
import type { HostRequest, HostContextResult, FilesSearchResult, RemoteOperationIdentity, RemoteWorkResult, WireWorkCapabilities, WireParityReadResult } from "../wire";

export interface RemoteDispatchInfo {
  threadId: string; messageId: string; provider: Provider; startRequestId?: string; turnId?: string;
  permission?: PermissionMode;
}
/** Optional remote-only hooks. Local delivery never calls or awaits these. */
export interface RemoteTurnDelivery {
  identity: RemoteOperationIdentity;
  attemptId: string;
  messageId: string;
  assertAllowed(): void;
  beforeCreate(): Promise<void>;
  queued(threadId: string, queuedTurnId: string): Promise<void>;
  bindThread(threadId: string): Promise<void>;
  beforeDispatch(info: RemoteDispatchInfo): Promise<void>;
  accepted(info: Partial<RemoteDispatchInfo>): Promise<void>;
  uncertain(info?: Partial<RemoteDispatchInfo>): Promise<void>;
  rejected(code?: string): Promise<void>;
  failure(reason: unknown): Promise<void>;
  metadata(): RemoteOperationIdentity & { generation: number; attemptId: string; messageId: string };
  invokeSteer<T>(action: string, args: Record<string, unknown>): Promise<T>;
  result(): RemoteWorkResult;
}
export interface RemoteStopSnapshot {
  threadId: string; turnId?: string; startRequestId?: string; agentRunId?: string; runStartedAt?: number;
  parentRunId?: string; workflowId?: string; workflowRunId?: string;
}
export interface RemoteTurnRunner {
  sendPromptTo(context: TurnRunnerContext, text: string): Promise<RemoteWorkResult>;
  steerThread(context: TurnRunnerContext, text: string, expected: RemoteStopSnapshot): Promise<RemoteWorkResult>;
  queuePromptTo(context: TurnRunnerContext, text: string, delivery: RemoteQueuedDelivery): Promise<RemoteWorkResult>;
  stopThreadTurn(context: TurnRunnerContext, expected: RemoteStopSnapshot): Promise<void>;
  getThreadStopTarget(threadId: string): RemoteStopSnapshot;
  pumpRemoteQueue(threadId: string): void;
}
export interface RemoteWorkAdapter {
  dispatch(request: HostRequest): Promise<RemoteWorkResult | WireWorkCapabilities | HostContextResult | FilesSearchResult | WireParityReadResult>;
  resolveQueued(entry: QueuedTurn): Promise<TurnRunnerContext>;
  reconcileQueues(pump?: boolean): Promise<void>;
  dispose(): void;
}
