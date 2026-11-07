import type { TurnRunnerContext } from "../../../hooks/useTurnRunner";
import type { DeviceGrant } from "../types";
import type { HostRequest, RemoteOperationIdentity, RemoteWorkResult } from "../wire";
import { nativeHostTransport, type HostTransport } from "./bridge";
import { currentGrant, HostReadError, idArg } from "./scope";
import type { HostContextSources } from "./hostContext";
import { resolveThreadExecutionContext } from "./executionContext";

const terminals = new Set(["terminal.open", "terminal.write", "terminal.resize", "terminal.close"]);
export const isTerminalMutation = (op: string): boolean => terminals.has(op);
export function nativeRefusal(reason: unknown): HostReadError {
  const code = typeof reason === "string" ? /^MYTHRA_REMOTE_REJECTED:([a-z_]+)/.exec(reason)?.[1] : undefined;
  return new HostReadError(code ?? "uncertain", code === "forbidden" ? "Access changed before the other device could apply this action."
    : code === "stale_target" ? "This resource on the other device changed. Refresh before trying again."
    : code === "unsupported" ? "The other device cannot perform that action yet."
    : "The other device couldn't confirm this action. Check its original operation before retrying.");
}
export function strictNativeKeys(args: Record<string, unknown>, keys: readonly string[]): void {
  if (Object.keys(args).some((key) => !["opId", "opSeq", ...keys].includes(key))) throw new HostReadError("unsupported", "This action is not valid.");
}
export interface NativeTarget {
  context: TurnRunnerContext; root: string;
  stamp: { generation: number; device: string; opId: string; opSeq: number; grantRevision: number; workspaceId: string; threadId?: string };
  assertAllowed(): DeviceGrant;
}
/** A host-resolved root is frozen across preparation. Native checks the same
 * stamped grant at the actual provider/filesystem dispatch, not only here. */
export function nativeTarget(sources: HostContextSources, request: HostRequest, args: Record<string, unknown>,
  identity: RemoteOperationIdentity, isCurrent: () => boolean): NativeTarget {
  const target = args.threadId === undefined ? { workspaceId: idArg(args.workspaceId) } : { threadId: idArg(args.threadId) };
  const resolve = () => resolveThreadExecutionContext(sources, target, request.device);
  const context = resolve(), workspace = context.activeWorkspace!;
  if (args.workspaceId !== undefined && args.workspaceId !== workspace.id || workspace.isChat) throw new HostReadError("forbidden", "This action needs a shared project.");
  const root = sources.executionPathFor(context.activeThread?.id ?? "", workspace.path);
  const assertAllowed = () => {
    if (!isCurrent()) throw new HostReadError("host_unavailable", "The other device is recovering. Try again shortly.");
    const grant = currentGrant(sources, request.device, request.grant);
    if (!grant.work || !grant.capabilities.terminal) throw new HostReadError("forbidden", "This action needs Work and Terminal access.");
    const now = resolve();
    if (now.activeWorkspace?.id !== workspace.id || now.activeWorkspace?.path !== workspace.path
      || sources.executionPathFor(now.activeThread?.id ?? "", workspace.path) !== root
      || now.effectiveSettings.permission !== context.effectiveSettings.permission) throw new HostReadError("stale_target", "The other device's checkout or permission changed.");
    return grant;
  };
  assertAllowed();
  return { context, root, assertAllowed, stamp: { generation: request.generation, ...identity, grantRevision: request.grant.revision,
    workspaceId: workspace.id, ...(context.activeThread ? { threadId: context.activeThread.id } : {}) } };
}
export async function executeTerminal(sources: HostContextSources, request: HostRequest, args: Record<string, unknown>,
  identity: RemoteOperationIdentity, isCurrent: () => boolean, transport: HostTransport = nativeHostTransport): Promise<RemoteWorkResult> {
  const action = request.op.slice("terminal.".length);
  strictNativeKeys(args, ["workspaceId", ...(action === "open" ? ["threadId", "command", "columns", "rows"]
    : ["terminalId", ...(action === "write" ? ["data"] : action === "resize" ? ["columns", "rows"] : [])])]);
  idArg(args.workspaceId);
  const target = nativeTarget(sources, request, args, identity, isCurrent);
  if (action === "open" && (typeof args.command !== "string" || !args.command.trim() || new TextEncoder().encode(args.command).length > 32768 || args.command.includes("\0"))) throw new HostReadError("unsupported", "Enter a valid bounded command.");
  if (action === "open" || action === "resize") for (const key of ["columns", "rows"]) {
    if (typeof args[key] !== "number" || !Number.isInteger(args[key]) || args[key] < 1 || args[key] > 1000) throw new HostReadError("unsupported", "That terminal size is not valid.");
  }
  if (action === "write") {
    if (typeof args.data !== "string" || args.data.length > 16384 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(args.data)) throw new HostReadError("unsupported", "That terminal input is not valid.");
  }
  const terminalId = action === "open" ? undefined : idArg(args.terminalId);
  target.assertAllowed();
  try {
    const raw = await transport.invoke<{ opId: string; state: string; terminalId: string }>(action === "open" ? "remote_terminal_start" : "remote_terminal_action",
      action === "open" ? { stamp: target.stamp, root: target.root, command: args.command, permission: target.context.effectiveSettings.permission, columns: args.columns, rows: args.rows }
        : { stamp: target.stamp, terminalId, action, data: args.data ?? null, columns: args.columns ?? null, rows: args.rows ?? null });
    if (raw?.opId !== identity.opId || raw.state !== "accepted") throw new Error("Unconfirmed terminal result");
    return { opId: identity.opId, state: "accepted", terminalId: idArg(raw.terminalId) };
  } catch (reason) { throw nativeRefusal(reason); }
}
