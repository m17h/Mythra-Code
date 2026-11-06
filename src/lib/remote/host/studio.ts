import type { HostRequest } from "../wire";
import type {
  StudioOperation, StudioResult, StudioGitArea, StudioFileKind,
  FilesListResult, FilePreviewResult, GitStatusResult, GitDiffResult, WireGitChange,
} from "../wire-studio";
import { STUDIO_MAX_ROWS, STUDIO_RESULT_BYTES, STUDIO_TEXT_BYTES } from "../wire-studio";
import { nativeHostTransport, type HostTransport } from "./bridge";
import type { HostCatalog } from "./catalog";
import { HostReadError, currentGrant, idArg, objectArgs, requireThread, requireWorkspace, type HostSources } from "./scope";

const encoder = new TextEncoder();
const bytes = (value: unknown): number => encoder.encode(JSON.stringify(value)).byteLength;
const HANDLE_TTL = 5 * 60_000;
const MAX_HANDLES = 2048;
const MAX_DEVICE_HANDLES = 512;
const MAX_PARALLEL_READS = 4;
const operations = new Set<string>(["files.list", "files.preview", "git.status", "git.diff"]);
const areas = new Set<string>(["staged", "unstaged", "untracked"]);
const keys: Record<StudioOperation, readonly string[]> = {
  "files.list": ["workspaceId", "threadId", "parentId", "cursor", "limit"],
  "files.preview": ["workspaceId", "threadId", "fileId"],
  "git.status": ["workspaceId", "threadId", "limit"],
  "git.diff": ["workspaceId", "threadId", "changeId"],
};
interface Target { root: string; key: string }
interface Handle {
  device: string; revision: number; target: string; expires: number;
  kind: StudioFileKind | "change" | "cursor"; relative: string;
  area?: StudioGitArea; after?: string;
}
const invalid = () => new HostReadError("unsupported", "That Studio request is not valid.");
const unavailable = () => new HostReadError("host_unavailable", "The host could not read this Studio item. Inspect it on the host.");
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw unavailable();
  return value as Record<string, unknown>;
}
function string(value: unknown, limit: number): string {
  if (typeof value !== "string" || encoder.encode(value).byteLength > limit) throw unavailable();
  return value;
}
function boolean(value: unknown): boolean { if (typeof value !== "boolean") throw unavailable(); return value; }
function count(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw unavailable();
  return value;
}
/** Common denominator of Windows and POSIX names: no ADS, devices or separators. */
function component(value: unknown): string {
  const name = string(value, 512);
  if (!name || name === "." || name === ".." || name.toLowerCase() === ".git"
    || /[\\/:\u0000-\u001f\u007f]/.test(name) || /[. ]$/.test(name)
    || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) throw unavailable();
  return name;
}
function relative(value: unknown): string {
  const path = string(value, 4096);
  const parts = path.split("/");
  if (parts.length > 32) throw unavailable();
  parts.forEach(component);
  return path;
}
function limit(value: unknown): number {
  if (value === undefined) return 100;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw invalid();
  return Math.min(STUDIO_MAX_ROWS, value);
}
function join(root: string, path: string): string { return `${root.replace(/[\\/]+$/, "")}/${path}`; }
function textPrefix(value: string, maximum: number): string {
  if (encoder.encode(value).byteLength <= maximum) return value;
  let low = 0, high = value.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (encoder.encode(value.slice(0, mid)).byteLength <= maximum) low = mid; else high = mid - 1;
  }
  if (low && /[\uD800-\uDBFF]/.test(value[low - 1])) low -= 1;
  return value.slice(0, low);
}
/** JSON escaping can expand text sixfold; enforce the final envelope too. */
function boundText<T extends { text: string; truncated: boolean }>(result: T): T {
  const original = result.text;
  result.text = textPrefix(original, STUDIO_TEXT_BYTES);
  result.truncated ||= original !== result.text;
  while (bytes(result) > STUDIO_RESULT_BYTES) {
    result.text = textPrefix(result.text, Math.floor(encoder.encode(result.text).byteLength / 2));
    result.truncated = true;
    if (!result.text && bytes(result) > STUDIO_RESULT_BYTES) throw unavailable();
  }
  return result;
}
export function isStudioOperation(op: string): op is StudioOperation { return operations.has(op); }

/**
 * No selected-UI state, providers or shell commands. Call execute from the host
 * dispatcher; Rust must also authorize these four operations and gate replies.
 * New remote_studio_* native commands below intentionally have no unsafe local
 * fallback. Their containment/cancellation contract is in slice4-rust-needs.md.
 */
export class HostStudio {
  private handles = new Map<string, Handle>();
  private active = 0;
  private disposed = false;
  constructor(private readonly sources: HostSources,
    private readonly catalog: Pick<HostCatalog, "thread" | "ownership">,
    private readonly generation: number, private readonly isCurrent: () => boolean,
    private readonly transport: HostTransport = nativeHostTransport) {}
  dispose(): void { this.disposed = true; this.handles.clear(); }
  private check(request: HostRequest): void {
    if (this.disposed || !this.isCurrent() || request.generation !== this.generation) {
      throw new HostReadError("host_unavailable", "The host is recovering.");
    }
    if (!/^[0-9a-f]{64}$/.test(request.device)) throw invalid();
    currentGrant(this.sources, request.device, request.grant);
  }
  private target(request: HostRequest, args: Record<string, unknown>): Target {
    this.check(request);
    const workspace = requireWorkspace(this.sources, idArg(args.workspaceId), request.grant);
    let root = workspace.path;
    let threadId: string | undefined;
    if (args.threadId !== undefined) {
      threadId = idArg(args.threadId);
      const resolved = requireThread(this.sources, this.catalog.thread(threadId), request.grant, this.catalog.ownership());
      if (resolved.workspace.id !== workspace.id) throw new HostReadError("forbidden", "This conversation is not in this workspace.");
      root = this.sources.executionPathFor(threadId, workspace.path);
    }
    if (typeof root !== "string" || !root || root.includes("\0") || root.length > 32768
      || !(/^[\\/]/.test(root) || /^[a-z]:[\\/]/i.test(root))) throw unavailable();
    return { root, key: JSON.stringify([workspace.id, workspace.path, threadId ?? null, root]) };
  }
  private assertTarget(request: HostRequest, args: Record<string, unknown>, expected: Target): void {
    if (this.target(request, args).key !== expected.key) throw new HostReadError("stale_target", "The host checkout changed. Refresh Studio.");
  }
  private sweep(): void {
    for (const [key, handle] of this.handles) if (handle.expires <= Date.now()) this.handles.delete(key);
  }
  private remember(request: HostRequest, target: Target, value: Pick<Handle, "kind" | "relative" | "area" | "after">): string {
    // Bound both each viewer and the complete session, including cursors.
    const own = [...this.handles].filter(([, handle]) => handle.device === request.device);
    if (own.length >= MAX_DEVICE_HANDLES) this.handles.delete(own[0][0]);
    while (this.handles.size >= MAX_HANDLES) this.handles.delete(this.handles.keys().next().value!);
    const id = crypto.randomUUID();
    this.handles.set(id, { ...value, device: request.device, revision: request.grant.revision,
      target: target.key, expires: Date.now() + HANDLE_TTL });
    return id;
  }
  private handle(request: HostRequest, target: Target, value: unknown, kind: Handle["kind"]): Handle {
    const handle = this.handles.get(idArg(value));
    if (!handle || handle.kind !== kind || handle.device !== request.device || handle.target !== target.key
      || handle.revision !== request.grant.revision || handle.expires <= Date.now()) {
      throw new HostReadError("stale_target", "This Studio item expired. Refresh its list.");
    }
    return handle;
  }
  private async native(request: HostRequest, args: Record<string, unknown>, target: Target,
    command: string, nativeArgs: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.assertTarget(request, args, target);
    let result: unknown;
    try { result = await this.transport.invoke<unknown>(command, nativeArgs); }
    catch { throw unavailable(); } // No stderr, exception, credential URL or absolute path crosses the bridge.
    this.assertTarget(request, args, target);
    return record(result);
  }
  async execute(request: HostRequest): Promise<StudioResult> {
    this.check(request);
    if (!isStudioOperation(request.op)) throw invalid();
    const args = objectArgs(request.args);
    if (Object.keys(args).some((key) => !keys[request.op as StudioOperation].includes(key))) throw invalid();
    this.sweep();
    if (this.active >= MAX_PARALLEL_READS) throw new HostReadError("busy", "The host is reading other Studio items. Try again shortly.");
    const target = this.target(request, args);
    this.active += 1;
    try {
      let result: StudioResult;
      switch (request.op) {
        case "files.list": result = await this.list(request, args, target); break;
        case "files.preview": result = await this.preview(request, args, target); break;
        case "git.status": result = await this.status(request, args, target); break;
        case "git.diff": result = await this.diff(request, args, target); break;
        default: throw invalid();
      }
      this.assertTarget(request, args, target);
      if (bytes(result) > STUDIO_RESULT_BYTES) throw unavailable();
      return result;
    } finally { this.active -= 1; }
  }
  private async list(request: HostRequest, args: Record<string, unknown>, target: Target): Promise<FilesListResult> {
    const directory = args.parentId === undefined ? "" : this.handle(request, target, args.parentId, "directory").relative;
    const cursor = args.cursor === undefined ? undefined : this.handle(request, target, args.cursor, "cursor");
    if (cursor && cursor.relative !== directory) throw invalid();
    const maximum = limit(args.limit);
    const raw = await this.native(request, args, target, "remote_studio_files_list", {
      root: target.root, relativeDirectory: directory, after: cursor?.after ?? null, limit: maximum,
    });
    if (!Array.isArray(raw.entries) || raw.entries.length > STUDIO_MAX_ROWS) throw unavailable();
    const result: FilesListResult = { entries: [], truncated: boolean(raw.truncated) };
    const names = new Set<string>();
    let last: string | undefined;
    let byteLimited = false;
    for (const entry of raw.entries) {
      const row = record(entry);
      const name = component(row.name);
      if (names.has(name)) throw unavailable();
      names.add(name);
      if (row.kind !== "file" && row.kind !== "directory") throw unavailable();
      const path = relative(directory ? `${directory}/${name}` : name);
      const value = { id: "", name, path, kind: row.kind as StudioFileKind,
        ...(row.size === undefined ? {} : { size: count(row.size) }) };
      // Leave room for UUID and cursor fields before committing a row.
      if (result.entries.length >= maximum || bytes(result) + bytes(value) + 256 > STUDIO_RESULT_BYTES) { byteLimited = true; break; }
      value.id = this.remember(request, target, { kind: value.kind, relative: path });
      result.entries.push(value); last = name;
    }
    const next = raw.next === undefined || raw.next === null ? undefined : component(raw.next);
    if (byteLimited) {
      if (!last) throw unavailable();
      result.truncated = true;
      result.cursor = this.remember(request, target, { kind: "cursor", relative: directory, after: last });
    } else if (next !== undefined) {
      // Native paging is strictly after the final returned name, never a path.
      if (!last || next !== last || cursor?.after === next) throw unavailable();
      result.cursor = this.remember(request, target, { kind: "cursor", relative: directory, after: next });
    }
    return result;
  }
  private async preview(request: HostRequest, args: Record<string, unknown>, target: Target): Promise<FilePreviewResult> {
    const file = this.handle(request, target, args.fileId, "file");
    // Existing native command canonicalizes containment, then uses anchored,
    // opened-handle checks and bounded regular-file reads on both platforms.
    const raw = await this.native(request, args, target, "preview_project_file", { root: target.root, path: join(target.root, file.relative) });
    const binary = boolean(raw.binary);
    return boundText({ fileId: idArg(args.fileId), path: file.relative, binary,
      text: binary ? "" : string(raw.text, 1024 * 1024), truncated: boolean(raw.truncated) });
  }
  private async status(request: HostRequest, args: Record<string, unknown>, target: Target): Promise<GitStatusResult> {
    const maximum = limit(args.limit);
    const raw = await this.native(request, args, target, "remote_studio_git_status", { root: target.root, limit: maximum });
    if (!Array.isArray(raw.rows) || raw.rows.length > STUDIO_MAX_ROWS) throw unavailable();
    const result: GitStatusResult = { changes: [], stagedFiles: count(raw.stagedFiles), unstagedFiles: count(raw.unstagedFiles),
      untrackedFiles: count(raw.untrackedFiles), changedFiles: count(raw.changedFiles), truncated: boolean(raw.truncated) };
    const seen = new Set<string>();
    for (const entry of raw.rows) {
      const row = record(entry);
      const path = relative(row.path);
      const originalPath = row.originalPath === null || row.originalPath === undefined ? null : relative(row.originalPath);
      if (typeof row.area !== "string" || !areas.has(row.area) || typeof row.status !== "string" || !/^[ MADRCUT?!]{1,2}$/.test(row.status)) throw unavailable();
      const identity = JSON.stringify([path, row.area]);
      if (seen.has(identity)) throw unavailable();
      seen.add(identity);
      const value: WireGitChange = { id: "", path, originalPath, area: row.area as StudioGitArea, status: row.status };
      if (result.changes.length >= maximum || bytes(result) + bytes(value) + 128 > STUDIO_RESULT_BYTES) { result.truncated = true; break; }
      value.id = this.remember(request, target, { kind: "change", relative: path, area: value.area });
      result.changes.push(value);
    }
    return result;
  }
  private async diff(request: HostRequest, args: Record<string, unknown>, target: Target): Promise<GitDiffResult> {
    const change = this.handle(request, target, args.changeId, "change");
    const raw = await this.native(request, args, target, "remote_studio_git_diff", { root: target.root, path: change.relative, area: change.area });
    if (raw.path !== change.relative || raw.area !== change.area) throw unavailable();
    const binary = boolean(raw.binary);
    return boundText({ changeId: idArg(args.changeId), path: change.relative, area: change.area!, binary,
      text: binary ? "" : string(raw.text, 1024 * 1024), truncated: boolean(raw.truncated) });
  }
}
