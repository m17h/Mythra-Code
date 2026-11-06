import type { Project, Provider, Thread } from "../../../types";
import type { OwnershipLinks } from "../../nativeAgentLinks";
import type { DeviceGrant } from "../types";
import type { RemoteWireError } from "../wire";
import type { RemoteWorkLease } from "./workActions";
import type { RemoteWorkAdapter } from "./workTypes";

/** App supplies live getters, not render-captured selections or setters. */
export interface HostSources {
  getWorkspaces(): readonly Project[];
  getKnownThreads(): Readonly<Record<string, Thread>>;
  getBindings(): Readonly<Record<string, string>>;
  getOwnershipLinks(): OwnershipLinks;
  getArchivedThreadIds(): ReadonlySet<string>;
  getArchivedThreads?(): readonly Thread[];
  getPinnedThreadIds?(): ReadonlySet<string>;
  getUnavailableThreadIds(): ReadonlySet<string>;
  getRuntime(): { available: boolean; dataHome?: string | null };
  getDefaultProvider?(): Provider;
  watchThreadNames?(): { changedIds: ReadonlySet<string>; finish(): void };
  getGrant(device: string): DeviceGrant | null;
  executionPathFor(threadId: string, logicalPath: string): string;
  onCursorSession(threadId: string, sessionId: string): void;
  /** Metadata bookkeeping only; never select or replace the visible sidebar. */
  rememberThread?(thread: Thread): void;
  /** Must reconcile native ownership/pending requests before ready; never start work. */
  reconcile(isCurrent: () => boolean): Promise<void>;
  /** What the Studio reads need from app state. Without it they answer empty. */
  getStudioReads?(): import("./studioReads").StudioReadSources;
  /** Optional Phase 3 integration, created and disposed for each renderer lease. */
  createWork?(lease: RemoteWorkLease): RemoteWorkAdapter;
}

export class HostReadError extends Error {
  constructor(public readonly code: string, message: string) { super(message); }
}
export function wireError(reason: unknown): RemoteWireError {
  if (reason instanceof HostReadError) return { code: reason.code, message: reason.message };
  return { code: "host_unavailable", message: "The host could not read this conversation. Try again." };
}
export function normalizedHostPath(path: string): string {
  const value = path.replace(/\\/g, "/").replace(/\/+$/, "") || "/";
  return /^[a-z]:\//i.test(value) ? value.toLowerCase() : value;
}
export function currentGrant(sources: HostSources, device: string, expected: DeviceGrant): DeviceGrant {
  const grant = sources.getGrant(device);
  if (!expected.view || !grant?.view || grant.revision !== expected.revision) {
    throw new HostReadError("forbidden", "Access to this content has changed.");
  }
  return grant;
}
export function workspaceAllowed(workspace: Project, grant: DeviceGrant): boolean {
  return grant.view && (grant.scope.kind === "all" || grant.scope.projectIds.includes(workspace.id));
}
export function requireWorkspace(sources: HostSources, workspaceId: string, grant: DeviceGrant): Project {
  const workspace = sources.getWorkspaces().find((entry) => entry.id === workspaceId);
  if (!workspace || !workspaceAllowed(workspace, grant)) throw new HostReadError("forbidden", "This workspace is not shared.");
  return workspace;
}
export function threadWorkspace(sources: HostSources, thread: Thread): Project | undefined {
  const path = normalizedHostPath(sources.getBindings()[thread.id] || thread.cwd);
  return sources.getWorkspaces().find((workspace) => normalizedHostPath(workspace.path) === path);
}
export function threadEligible(sources: HostSources, thread: Thread, _links = sources.getOwnershipLinks()): boolean {
  // Archives and children are content in the project's scope, not an access
  // boundary. Individual mutations still apply their local lifecycle guards.
  return !sources.getUnavailableThreadIds().has(thread.id);
}
export function requireThread(sources: HostSources, thread: Thread | undefined, grant: DeviceGrant, links = sources.getOwnershipLinks()): { thread: Thread; workspace: Project } {
  if (!thread || !threadEligible(sources, thread, links)) throw new HostReadError("thread_unavailable", "This conversation is not available.");
  const workspace = threadWorkspace(sources, thread);
  if (!workspace || !workspaceAllowed(workspace, grant)) throw new HostReadError("forbidden", "This conversation is not shared.");
  return { thread, workspace };
}

/** Bound local IPC arguments too; callers cannot supply a host filesystem path. */
export function objectArgs(value: unknown): Record<string, unknown> {
  if (value === null || value === undefined) return {};
  if (typeof value !== "object" || Array.isArray(value)) throw new HostReadError("unsupported", "Invalid viewing request.");
  return value as Record<string, unknown>;
}
export function idArg(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 256) throw new HostReadError("unsupported", "Invalid viewing target.");
  return value;
}
