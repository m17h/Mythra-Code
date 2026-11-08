import type { Project } from "../../../types";
import type { HostRequest } from "../wire";
import type { DeviceGrant } from "../types";
import { nativeRefusal } from "./nativeActions";
import type { FoldersBrowseResult, ProjectCloneResult, ProjectCloneStatus, ProjectNavigationOperation, ProjectNavigationResult, ProjectsAddResult, WireFolder } from "../wire-studio";
import { STUDIO_MAX_ROWS, STUDIO_RESULT_BYTES } from "../wire-studio";
import { nativeHostTransport, type HostTransport } from "./bridge";
import { HostReadError, currentGrant, idArg, objectArgs, type HostSources } from "./scope";

const encoder = new TextEncoder();
const TTL = 5 * 60_000;
const MAX_HANDLES = 2048;
const MAX_PER_DEVICE = 512;
const busy = () => new HostReadError("busy", "The other device is browsing other folders. Try again shortly.");
const invalid = () => new HostReadError("unsupported", "That folder request is not valid.");
const unavailable = () => new HostReadError("host_unavailable", "The other device couldn't open that folder. Inspect it on the other device.");
interface Handle { device: string; revision: number; expires: number; kind: "folder" | "cursor"; token: string; parentToken?: string | null; canAdd?: boolean }
/** Host-only native selection. Never serialize this object into a response. */
export interface HostFolderSelection { path: string; name: string; identity: string; token: string }
export interface ProjectRegistrationOperation {
  device: string; generation: number; grantRevision: number; opId: string; opSeq: number;
  /** Recheck at native admission AND immediately before the host state commit. */
  assertAllowed(): void;
}
export interface HostProjectRegistration {
  /**
   * App adapter: one ordered/durable project-state write; deduplicate canonical
   * folder identity and native journal (device, opId, opSeq), preserve concurrent
   * project edits, never move local selection or initialize Git/start a command.
   * No default adapter: an unintegrated projects.add fails closed.
   */
  register(selection: HostFolderSelection, operation: ProjectRegistrationOperation): Promise<
    { state: "accepted"; project: Project } | { state: "uncertain" }
  >;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw unavailable();
  return value as Record<string, unknown>;
}
function text(value: unknown, maximum: number): string {
  if (typeof value !== "string" || !value || encoder.encode(value).byteLength > maximum || /[\u0000-\u001f\u007f]/.test(value)) throw unavailable();
  return value;
}
function token(value: unknown): string {
  const result = text(value, 256);
  if (!/^[a-zA-Z0-9_-]+$/.test(result)) throw unavailable();
  return result;
}
function flag(value: unknown): boolean { if (typeof value !== "boolean") throw unavailable(); return value; }
function name(value: unknown): string {
  const result = text(value, 512);
  if (result === "." || result === ".." || /[\\/:]/.test(result)) throw unavailable();
  return result;
}
function allowed(grant: DeviceGrant): boolean {
  // Missing/older capability data is denied, never inferred from Work or all.
  const capabilities = grant.capabilities as DeviceGrant["capabilities"] & { manageProjects?: boolean };
  return grant.view && grant.work && grant.scope.kind === "all" && capabilities.manageProjects === true;
}
export function isProjectNavigationOperation(op: string): op is ProjectNavigationOperation {
  return op === "folders.browse" || op === "projects.add" || op === "projects.clone" || op === "projects.clone.status";
}

/** Folders only, no file/content API and no conversion into Studio file handles. */
export class HostProjectNavigation {
  private handles = new Map<string, Handle>();
  private active = 0;
  private disposed = false;
  constructor(private readonly sources: HostSources, private readonly generation: number,
    private readonly isCurrent: () => boolean, private readonly registration?: HostProjectRegistration,
    private readonly transport: HostTransport = nativeHostTransport) {}
  dispose(): void { this.disposed = true; this.handles.clear(); }
  private check(request: HostRequest): void {
    if (this.disposed || !this.isCurrent() || request.generation !== this.generation) throw unavailable();
    if (!/^[0-9a-f]{64}$/.test(request.device)) throw invalid();
    const current = currentGrant(this.sources, request.device, request.grant);
    if (!allowed(request.grant) || !allowed(current)) {
      throw new HostReadError("forbidden", "Opening folders on the other device needs Work, all projects and Manage projects.");
    }
  }
  private sweep(): void {
    for (const [id, handle] of this.handles) if (handle.expires <= Date.now()) this.handles.delete(id);
  }
  private remember(request: HostRequest, value: Pick<Handle, "kind" | "token" | "parentToken" | "canAdd">): string {
    for (const [id, handle] of this.handles) {
      if (handle.device === request.device && handle.revision === request.grant.revision
        && handle.kind === value.kind && handle.token === value.token && handle.parentToken === value.parentToken) {
        handle.expires = Date.now() + TTL; handle.canAdd = value.canAdd;
        return id;
      }
    }
    const own = [...this.handles].filter(([, handle]) => handle.device === request.device);
    if (own.length >= MAX_PER_DEVICE) this.handles.delete(own[0][0]);
    while (this.handles.size >= MAX_HANDLES) this.handles.delete(this.handles.keys().next().value!);
    const id = crypto.randomUUID();
    this.handles.set(id, { ...value, device: request.device, revision: request.grant.revision, expires: Date.now() + TTL });
    return id;
  }
  private handle(request: HostRequest, value: unknown, kind: Handle["kind"]): Handle {
    const handle = this.handles.get(idArg(value));
    if (!handle || handle.kind !== kind || handle.device !== request.device || handle.revision !== request.grant.revision || handle.expires <= Date.now()) {
      throw new HostReadError("stale_target", "This folder selection expired. Browse again.");
    }
    return handle;
  }
  private authority(request: HostRequest): Record<string, unknown> {
    return { generation: this.generation, device: request.device, grantRevision: request.grant.revision };
  }
  private async native(request: HostRequest, command: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.check(request);
    let result: unknown;
    try { result = await this.transport.invoke<unknown>(command, { ...args, ...this.authority(request) }); }
    catch { throw unavailable(); }
    this.check(request);
    return object(result);
  }
  async execute(request: HostRequest): Promise<ProjectNavigationResult> {
    this.check(request);
    if (!isProjectNavigationOperation(request.op)) throw invalid();
    const args = objectArgs(request.args);
    const keys = request.op === "folders.browse" ? ["folderId", "cursor", "limit"] : request.op === "projects.clone" ? ["folderId", "url", "opId", "opSeq"]
      : request.op === "projects.clone.status" ? ["processHandle"] : ["folderId", "opId", "opSeq"];
    if (Object.keys(args).some((key) => !keys.includes(key))) throw invalid();
    this.sweep();
    if (this.active >= 4) throw busy();
    this.active += 1;
    try {
      const result = request.op === "folders.browse" ? await this.browse(request, args) : request.op === "projects.clone" ? await this.clone(request, args)
        : request.op === "projects.clone.status" ? await this.cloneStatus(request, args) : await this.add(request, args);
      this.check(request);
      if (encoder.encode(JSON.stringify(result)).byteLength > STUDIO_RESULT_BYTES) throw unavailable();
      return result;
    } finally { this.active -= 1; }
  }
  private folder(request: HostRequest, value: unknown): WireFolder | null {
    if (value === null) return null;
    const row = object(value);
    const nativeToken = token(row.token), displayName = name(row.name), canAdd = flag(row.canAdd);
    return { id: this.remember(request, { kind: "folder", token: nativeToken, canAdd }), name: displayName, canAdd };
  }
  private async browse(request: HostRequest, args: Record<string, unknown>): Promise<FoldersBrowseResult> {
    const folder = args.folderId === undefined ? undefined : this.handle(request, args.folderId, "folder");
    const cursor = args.cursor === undefined ? undefined : this.handle(request, args.cursor, "cursor");
    if (cursor && cursor.parentToken !== (folder?.token ?? null)) throw invalid();
    const limit = args.limit === undefined ? 100 : args.limit;
    if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 || limit > STUDIO_MAX_ROWS) throw invalid();
    const raw = await this.native(request, "remote_folders_browse", { folderToken: folder?.token ?? null, cursor: cursor?.token ?? null, limit });
    if (!Array.isArray(raw.folders) || raw.folders.length > limit) throw unavailable();
    if (folder && object(raw.folder).token !== folder.token || !folder && raw.folder !== null) throw unavailable();
    const current = this.folder(request, raw.folder), parent = this.folder(request, raw.parent);
    const seen = new Set<string>();
    const folders = raw.folders.map((entry) => {
      const value = this.folder(request, entry);
      if (!value || seen.has(value.id)) throw unavailable();
      seen.add(value.id); return value;
    });
    const result: FoldersBrowseResult = { folder: current, parent, folders, truncated: flag(raw.truncated) };
    if (raw.next !== null && raw.next !== undefined) {
      if (!folders.length) throw unavailable();
      const next = token(raw.next);
      if (cursor?.token === next) throw unavailable();
      result.cursor = this.remember(request, { kind: "cursor", token: next, parentToken: folder?.token ?? null });
    }
    return result;
  }
  /** Only starts it. Native checks the address and folder, and owns the process. */
  private async clone(request: HostRequest, args: Record<string, unknown>): Promise<ProjectCloneResult> {
    if (!request.grant.capabilities.terminal || !currentGrant(this.sources, request.device, request.grant).capabilities.terminal) throw new HostReadError("forbidden", "Cloning needs Terminal as well as Manage projects.");
    const folder = this.handle(request, args.folderId, "folder");
    const opId = idArg(args.opId);
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(opId) || typeof args.opSeq !== "number" || !Number.isSafeInteger(args.opSeq) || args.opSeq < 1 || typeof args.url !== "string") throw invalid();
    this.check(request);
    try {
      const raw = object(await this.transport.invoke("remote_projects_clone", { stamp: { generation: this.generation, device: request.device, opId, opSeq: args.opSeq, grantRevision: request.grant.revision },
        folderToken: folder.token, url: args.url }));
      if (raw.state !== "accepted") return { opId, state: "uncertain" };
      return { opId, state: "accepted", processHandle: idArg(raw.processHandle), name: name(raw.name) };
    } catch (reason) { if (typeof reason === "string" && /not found|unknown command/i.test(reason)) throw new HostReadError("unsupported", "This device can't clone repositories yet."); throw nativeRefusal(reason); }
  }
  private async cloneStatus(request: HostRequest, args: Record<string, unknown>): Promise<ProjectCloneStatus> {
    const raw = await this.native(request, "remote_projects_clone_status", { processHandle: idArg(args.processHandle) });
    if (raw.state !== "running" && raw.state !== "completed" && raw.state !== "failed" && raw.state !== "timedOut") throw unavailable();
    return { state: raw.state };
  }
  private async add(request: HostRequest, args: Record<string, unknown>): Promise<ProjectsAddResult> {
    const folder = this.handle(request, args.folderId, "folder");
    if (!folder.canAdd) throw new HostReadError("forbidden", "This folder on the other device cannot be added as a project.");
    const opId = idArg(args.opId);
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(opId) || typeof args.opSeq !== "number" || !Number.isSafeInteger(args.opSeq) || args.opSeq < 1) throw invalid();
    if (!this.registration) throw new HostReadError("unsupported", "The other device does not support adding projects remotely yet.");
    const raw = await this.native(request, "remote_folders_select", { folderToken: folder.token });
    const path = text(raw.path, 32768);
    if (!(/^(?:\/|[a-z]:[\\/]|\\\\)/i.test(path))) throw unavailable();
    const selection: HostFolderSelection = { path, name: name(raw.name), identity: token(raw.identity), token: folder.token };
    this.check(request);
    let outcome: Awaited<ReturnType<HostProjectRegistration["register"]>>;
    try {
      outcome = await this.registration.register(selection, { device: request.device, generation: this.generation,
        grantRevision: request.grant.revision, opId, opSeq: args.opSeq, assertAllowed: () => this.check(request) });
    } catch {
      // The adapter may have committed already. Never tell the viewer to retry
      // as a new operation, and never expose its exception or filesystem path.
      return { opId, state: "uncertain" };
    }
    // A grant change after durable acceptance must not turn the receipt into a rejection.
    if (this.disposed || !this.isCurrent()) throw unavailable();
    if (outcome.state !== "accepted") return { opId, state: "uncertain" };
    // Only public workspace metadata crosses the wire; never spread Project.
    return { opId, state: "accepted", workspace: { id: idArg(outcome.project.id), name: name(outcome.project.name), isChat: false } };
  }
}
