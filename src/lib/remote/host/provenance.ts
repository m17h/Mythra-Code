import type { PermissionMode } from "../../../types";
import type { HostMutationContext } from "./workActions";
/** Durable authority identity only. Never store prompt/question bodies here. */
export interface RemoteExecutionProvenance {
  device: string; rootOpId: string; rootOpSeq: number; workspaceId: string;
  executionId: string; admittedGeneration: number; permissionCeiling: PermissionMode;
  kind: "schedule" | "queue-edit" | "workflow"; stepId?: string;
}
export function remoteProvenance(operation: HostMutationContext, kind: RemoteExecutionProvenance["kind"], executionId = crypto.randomUUID()): RemoteExecutionProvenance {
  return { device: operation.identity.device, rootOpId: operation.identity.opId, rootOpSeq: operation.identity.opSeq,
    workspaceId: operation.context.activeWorkspace!.id, executionId, admittedGeneration: operation.generation,
    permissionCeiling: operation.context.effectiveSettings.permission, kind };
}

/** Restore identity-only provenance without trusting a persisted arbitrary object. */
export function restoredRemoteProvenance(value: unknown): RemoteExecutionProvenance | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).some((key) => !["device", "rootOpId", "rootOpSeq", "workspaceId", "executionId", "admittedGeneration", "permissionCeiling", "kind", "stepId"].includes(key))) return undefined;
  for (const key of ["device", "rootOpId", "workspaceId", "executionId"]) if (typeof raw[key] !== "string" || !raw[key] || (raw[key] as string).length > 256) return undefined;
  if (!Number.isSafeInteger(raw.rootOpSeq) || (raw.rootOpSeq as number) < 1 || !Number.isSafeInteger(raw.admittedGeneration) || (raw.admittedGeneration as number) < 1
    || !["read-only", "ask", "full"].includes(String(raw.permissionCeiling)) || !["schedule", "queue-edit", "workflow"].includes(String(raw.kind))
    || raw.stepId !== undefined && (typeof raw.stepId !== "string" || !raw.stepId || raw.stepId.length > 256)) return undefined;
  return { device: raw.device as string, rootOpId: raw.rootOpId as string, rootOpSeq: raw.rootOpSeq as number, workspaceId: raw.workspaceId as string,
    executionId: raw.executionId as string, admittedGeneration: raw.admittedGeneration as number, permissionCeiling: raw.permissionCeiling as PermissionMode,
    kind: raw.kind as RemoteExecutionProvenance["kind"], ...(raw.stepId === undefined ? {} : { stepId: raw.stepId as string }) };
}
