import type { HostRequest } from "../wire";
import { nativeHostTransport, type HostTransport } from "./bridge";
import type { HostContextSources } from "./hostContext";
import { hostDiscoveryPreferences } from "./discoverySettings";
import { nativeRefusal } from "./nativeActions";
import { HostReadError, idArg } from "./scope";
import { operationStamp } from "./stateCommit";
import type { HostMutationContext } from "./workActions";

const STATES = new Set(["running", "stopping", "completed", "failed", "stopped", "uncertain"]);
const text = (value: unknown, maximum: number) => typeof value === "string" ? value.slice(0, maximum) : "";
export interface WireDiscoveryStatus {
  state: string; processHandle: string; message?: string;
  discovery?: { command: string; setupCommand?: string; label?: string; explanation: string; warning?: string };
}
function wireStatus(value: unknown, handle: string): WireDiscoveryStatus {
  const row = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  if (typeof row.state !== "string" || !STATES.has(row.state)) throw new HostReadError("uncertain", "This search couldn't be confirmed.");
  const found = row.discovery && typeof row.discovery === "object" ? row.discovery as Record<string, unknown> : undefined;
  return { state: row.state, processHandle: handle, ...(typeof row.message === "string" ? { message: text(row.message, 2048) } : {}),
    ...(found ? { discovery: { command: text(found.command, 8192), ...(found.setupCommand ? { setupCommand: text(found.setupCommand, 8192) } : {}),
      ...(found.label ? { label: text(found.label, 256) } : {}), explanation: text(found.explanation, 4096), ...(found.warning ? { warning: text(found.warning, 2048) } : {}) } } : {}) };
}

/** Finding a Run or Checks command, on the host's own saved model. Native owns the
 * worker and its files. Acceptance only means it started, and nothing is saved here. */
export function createHostDiscovery(sources: HostContextSources, transport: HostTransport = nativeHostTransport) {
  const start = async (operation: HostMutationContext) => {
    const context = operation.context, workspace = context.activeWorkspace!;
    const { provider, model, effort, fast } = hostDiscoveryPreferences();
    const root = sources.executionPathFor(context.activeThread?.id ?? "", workspace.path);
    operation.assertAllowed();
    try {
      const reply = await transport.invoke<{ state?: string; processHandle?: string }>("remote_discovery_start", { stamp: operationStamp(operation), root,
        options: { provider, model, effort, fast, lmStudioBaseUrl: sources.getSettings().lmStudioBaseUrl } });
      if (reply?.state !== "accepted") throw new HostReadError("uncertain", "This search couldn't be confirmed.");
      return { state: "accepted" as const, processHandle: idArg(reply.processHandle) };
    } catch (reason) { if (reason instanceof HostReadError) throw reason; throw nativeRefusal(reason); }
  };
  const stop = async (operation: HostMutationContext, processHandle: string) => {
    operation.assertAllowed();
    try {
      const reply = await transport.invoke<{ state?: string; confirmed?: boolean }>("remote_discovery_stop", { stamp: operationStamp(operation), processHandle });
      if (reply?.state !== "accepted" || reply.confirmed !== true) throw new HostReadError("uncertain", "This search may still be stopping.");
      return { state: "accepted" as const };
    } catch (reason) { if (reason instanceof HostReadError) throw reason; throw nativeRefusal(reason); }
  };
  const status = async (request: HostRequest, workspaceId: string, processHandle: string) => {
    try {
      return wireStatus(await transport.invoke("remote_discovery_status", { generation: request.generation, device: request.device, grantRevision: request.grant.revision, workspaceId, processHandle }), processHandle);
    } catch (reason) { if (reason instanceof HostReadError) throw reason; throw nativeRefusal(reason); }
  };
  return { start, stop, status };
}
