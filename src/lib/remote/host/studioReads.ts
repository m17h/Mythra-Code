import type { HostRequest } from "../wire";
import type {
  AgentsListResult, AttachmentImageResult, CheckpointDiffResult, CheckpointListResult, GitLogResult, PreviewLinksResult, RevertPreviewResult,
  StudioReadOperation, WireAgent, WireCheckpoint, WireGitCommit, WireWorktreeStatus, WorktreeStatusResult,
} from "../wire-studio";
import { STUDIO_RESULT_BYTES } from "../wire-studio";
import type { CheckpointHead, CheckpointRecord } from "../../checkpoints";
import type { ThreadWorktreeRecord } from "../../worktrees";
import { useTaskStore } from "../../taskStore";
import { hostLocalPort } from "../links";
import { nativeHostTransport, type HostTransport } from "./bridge";
import type { HostCatalog } from "./catalog";
import { boundText, relativeStudioPath, type HostStudio } from "./studio";
import { HostReadError, currentGrant, idArg, normalizedHostPath, objectArgs, requireThread, requireWorkspace, type HostSources } from "./scope";

/** What only the app holds. Everything else comes from the task store or Git. */
export interface StudioReadSources {
  getCheckpoints(): readonly CheckpointRecord[];
  getCheckpointHead(root: string): CheckpointHead | undefined;
  getThreadWorktree(threadId: string): ThreadWorktreeRecord | undefined;
}
const encoder = new TextEncoder();
const size = (value: unknown) => encoder.encode(JSON.stringify(value)).byteLength;
const MAX_CHECKPOINTS = 200, MAX_AGENTS = 64, MAX_PREVIEW_PATHS = 200, MAX_PARALLEL = 4;
const MAX_HISTORY_OFFSET = 100_000, MAX_HISTORY_PAGE = 100;
const PREVIEW_TTL = 5 * 60_000, MAX_PREVIEWS = 64;
/** A larger image reads a chunk at a time. The reply limit covers its Base64. */
const IMAGE_REPLY_BYTES = 800 * 1024;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const keys: Record<StudioReadOperation, readonly string[]> = {
  "checkpoint.list": ["workspaceId", "threadId"], "checkpoint.diff": ["workspaceId", "threadId", "checkpointId"],
  "worktree.status": ["workspaceId", "threadId"], "git.log": ["workspaceId", "threadId", "offset", "limit", "headOid"],
  "git.revert.preview": ["workspaceId", "threadId", "changeId"], "agents.list": ["workspaceId", "threadId"],
  "attachment.image": ["workspaceId", "threadId", "messageId", "index", "offset"],
  "preview.links": ["workspaceId", "threadId"],
};
const MAX_PREVIEW_LINKS = 8, MAX_SCANNED_MESSAGES = 200, MAX_SCANNED_CHARS = 64 * 1024;
/** Half the host's idle limit, so a kept endpoint is always still registered. */
const ENDPOINT_TTL = 5 * 60_000;
const LOOPBACK_LINK = /\bhttps?:\/\/(?:localhost|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|\[::1\]|0\.0\.0\.0):\d{1,5}/gi;
export function isStudioRead(op: string): op is StudioReadOperation { return Object.hasOwn(keys, op); }

const invalid = () => new HostReadError("unsupported", "That Studio request is not valid.");
const unavailable = () => new HostReadError("host_unavailable", "The other device couldn't read this Studio item. Inspect it on the other device.");
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw unavailable();
  return value as Record<string, unknown>;
}
function string(value: unknown, limit: number): string {
  if (typeof value !== "string" || encoder.encode(value).byteLength > limit) throw unavailable();
  return value;
}
const optional = (value: unknown, limit: number) => typeof value === "string" && value ? value.slice(0, limit) : undefined;
function count(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw unavailable();
  return value;
}
const moment = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
const oid = (value: unknown) => {
  const text = string(value, 64);
  if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(text)) throw unavailable();
  return text;
};
const position = (value: unknown) => value === "before" || value === "after" ? value : undefined;

function wireCheckpoint(entry: CheckpointRecord): WireCheckpoint {
  // No workspacePath, repoRoot, commit or error text: any of those can name a folder.
  const saved = Boolean(entry.workspacePath && entry.beforeCommit);
  const parentPosition = position(entry.parentPosition);
  return { id: entry.id, threadId: entry.threadId, label: entry.label.slice(0, 256), createdAt: entry.createdAt,
    ...(moment(entry.completedAt) !== undefined ? { completedAt: entry.completedAt } : {}), ...(entry.status ? { status: entry.status } : {}),
    ...(entry.accepted ? { accepted: true } : {}), ...(optional(entry.threadLabel, 256) ? { threadLabel: optional(entry.threadLabel, 256) } : {}),
    ...(optional(entry.provider, 32) ? { provider: optional(entry.provider, 32) } : {}), ...(optional(entry.model, 256) ? { model: optional(entry.model, 256) } : {}),
    ...(optional(entry.branch, 256) ? { branch: optional(entry.branch, 256) } : {}), ...(optional(entry.head, 64) ? { head: optional(entry.head, 64) } : {}),
    ...(entry.parentId ? { parentId: entry.parentId } : {}), ...(parentPosition ? { parentPosition } : {}),
    ...(entry.restoredFromId ? { restoredFromId: entry.restoredFromId } : {}), ...(entry.overlappingRun ? { overlappingRun: true } : {}),
    ...(moment(entry.fileCount) !== undefined ? { fileCount: entry.fileCount } : {}), ...(moment(entry.changedFiles) !== undefined ? { changedFiles: entry.changedFiles } : {}),
    ...(moment(entry.additions) !== undefined ? { additions: entry.additions } : {}), ...(moment(entry.deletions) !== undefined ? { deletions: entry.deletions } : {}),
    restorable: { before: saved, after: saved && Boolean(entry.afterCommit) } };
}
function wireAgent(value: unknown): WireAgent {
  const raw = record(value);
  const runtime = raw.runtime === "codex" || raw.runtime === "claude" ? raw.runtime : undefined;
  const createdAt = moment(raw.createdAt);
  return { id: idArg(raw.id), prompt: optional(raw.prompt, 4000) ?? "", status: optional(raw.status, 64) ?? "unknown",
    ...(optional(raw.provider, 32) ? { provider: optional(raw.provider, 32) } : {}), ...(optional(raw.model, 256) ? { model: optional(raw.model, 256) } : {}),
    ...(runtime ? { runtime } : {}), ...(createdAt !== undefined ? { createdAt } : {}),
    ...(raw.canOpen === false ? { canOpen: false } : {}), ...(raw.canStop === false ? { canStop: false } : {}),
    ...(optional(raw.task, 4000) ? { task: optional(raw.task, 4000) } : {}), ...(optional(raw.progress, 4000) ? { progress: optional(raw.progress, 4000) } : {}),
    ...(optional(raw.result, 4000) ? { result: optional(raw.result, 4000) } : {}) };
}

interface Target { workspace: string; root: string; threadId?: string; key: string }
interface RevertPreview { device: string; revision: number; target: string; path: string | null; token: string; expires: number }

/**
 * Reads with no effect on the host. Scope is proved for every call, native work
 * happens under a root this file resolved, and the target is checked again
 * before a reply leaves, as HostStudio does. Viewers send opaque ids only.
 */
export class HostStudioReads {
  private active = 0;
  private previews = new Map<string, RevertPreview>();
  private endpoints = new Map<string, { endpointId: string; expires: number }>();
  constructor(private readonly sources: HostSources, private readonly catalog: Pick<HostCatalog, "thread" | "ownership">,
    private readonly studio: Pick<HostStudio, "changePath">, private readonly generation: number, private readonly isCurrent: () => boolean,
    private readonly extra: StudioReadSources | undefined, private readonly transport: HostTransport = nativeHostTransport) {}
  dispose(): void { this.previews.clear(); this.endpoints.clear(); }
  private target(request: HostRequest, args: Record<string, unknown>): Target {
    if (!this.isCurrent() || request.generation !== this.generation) throw new HostReadError("host_unavailable", "The other device is recovering. Try again shortly.");
    currentGrant(this.sources, request.device, request.grant);
    const workspace = requireWorkspace(this.sources, idArg(args.workspaceId), request.grant);
    let root = workspace.path, threadId: string | undefined;
    if (args.threadId !== undefined) {
      threadId = idArg(args.threadId);
      const resolved = requireThread(this.sources, this.catalog.thread(threadId), request.grant, this.catalog.ownership());
      if (resolved.workspace.id !== workspace.id) throw new HostReadError("forbidden", "This conversation is not in this workspace.");
      root = this.sources.executionPathFor(threadId, workspace.path);
    }
    if (typeof root !== "string" || !root || root.includes("\0") || !(/^[\\/]/.test(root) || /^[a-z]:[\\/]/i.test(root))) throw unavailable();
    return { workspace: workspace.id, root, ...(threadId ? { threadId } : {}), key: JSON.stringify([workspace.id, workspace.path, threadId ?? null, root]) };
  }
  private async native(request: HostRequest, args: Record<string, unknown>, target: Target, command: string, nativeArgs: Record<string, unknown>): Promise<Record<string, unknown>> {
    let result: unknown;
    try { result = await this.transport.invoke<unknown>(command, nativeArgs); }
    catch { throw unavailable(); } // No stderr or native path crosses the bridge.
    if (this.target(request, args).key !== target.key) throw new HostReadError("stale_target", "The other device's checkout changed. Refresh Studio.");
    return record(result);
  }
  async execute(request: HostRequest): Promise<unknown> {
    if (!isStudioRead(request.op)) throw invalid();
    const args = objectArgs(request.args);
    if (Object.keys(args).some((key) => !keys[request.op as StudioReadOperation].includes(key))) throw invalid();
    if (this.active >= MAX_PARALLEL) throw new HostReadError("busy", "The other device is reading other Studio items. Try again shortly.");
    const target = this.target(request, args);
    this.active += 1;
    try {
      const result = await this.read(request, args, target);
      if (this.target(request, args).key !== target.key) throw new HostReadError("stale_target", "The other device's checkout changed. Refresh Studio.");
      return result;
    } finally { this.active -= 1; }
  }
  private read(request: HostRequest, args: Record<string, unknown>, target: Target): Promise<unknown> | unknown {
    switch (request.op) {
      case "checkpoint.list": return this.checkpoints(target);
      case "checkpoint.diff": return this.checkpointDiff(request, args, target);
      case "worktree.status": return this.worktree(request, args, target);
      case "git.log": return this.history(request, args, target);
      case "git.revert.preview": return this.revertPreview(request, args, target);
      case "agents.list": return this.agents(target);
      case "attachment.image": return this.image(request, args, target);
      case "preview.links": return this.previewLinks(request, target);
      default: throw invalid();
    }
  }
  private visibleCheckpoints(target: Target): CheckpointRecord[] {
    // The same rule as the local Checkpoints tab.
    const root = normalizedHostPath(target.root);
    const project = this.sources.getWorkspaces().find((workspace) => workspace.id === target.workspace)?.path;
    return (this.extra?.getCheckpoints() ?? []).filter((entry) => {
      if (!entry.workspacePath) return target.threadId !== undefined && entry.threadId === target.threadId;
      const path = normalizedHostPath(entry.workspacePath);
      return path === root || entry.threadId === target.threadId && project !== undefined && path === normalizedHostPath(project);
    });
  }
  private checkpoints(target: Target): CheckpointListResult {
    const records = this.visibleCheckpoints(target);
    const result: CheckpointListResult = { checkpoints: [], truncated: records.length > MAX_CHECKPOINTS };
    for (const entry of records.slice(0, MAX_CHECKPOINTS)) {
      const row = wireCheckpoint(entry);
      if (size(result) + size(row) + 256 > STUDIO_RESULT_BYTES) { result.truncated = true; break; }
      result.checkpoints.push(row);
    }
    const head = this.extra?.getCheckpointHead(target.root);
    if (head && result.checkpoints.some((entry) => entry.id === head.checkpointId) && position(head.position)) result.head = { checkpointId: head.checkpointId, position: head.position };
    return result;
  }
  private async checkpointDiff(request: HostRequest, args: Record<string, unknown>, target: Target): Promise<CheckpointDiffResult> {
    const checkpointId = idArg(args.checkpointId);
    const checkpoint = this.visibleCheckpoints(target).find((entry) => entry.id === checkpointId);
    if (!checkpoint?.workspacePath || !checkpoint.afterCommit) throw new HostReadError("stale_target", "This checkpoint has no saved files to compare.");
    const raw = await this.native(request, args, target, "remote_studio_checkpoint_diff", { root: checkpoint.workspacePath, id: checkpointId });
    return boundText({ checkpointId, text: string(raw.text, 1024 * 1024), truncated: raw.truncated === true });
  }
  private async worktree(request: HostRequest, args: Record<string, unknown>, target: Target): Promise<WorktreeStatusResult> {
    const worktree = target.threadId ? this.extra?.getThreadWorktree(target.threadId) : undefined;
    if (!worktree || worktree.status === "removed") return { worktree: null, status: null };
    const raw = await this.native(request, args, target, "remote_studio_worktree_status", {
      project: worktree.projectPath, worktree: worktree.path, branch: worktree.branch, baseCommit: worktree.baseCommit });
    const text = (value: unknown) => value === null ? null : string(value, 512);
    const status: WireWorktreeStatus = { headOid: text(raw.headOid), sourceBranch: text(raw.sourceBranch), exists: raw.exists === true, registered: raw.registered === true,
      branch: text(raw.branch), baseCommit: text(raw.baseCommit), changedFiles: count(raw.changedFiles), untrackedFiles: count(raw.untrackedFiles),
      ignoredFileCount: count(raw.ignoredFileCount), ahead: count(raw.ahead), behind: count(raw.behind), clean: raw.clean === true };
    return { status, worktree: { threadId: worktree.threadId, path: string(worktree.path, 4096), branch: string(worktree.branch, 512), baseCommit: string(worktree.baseCommit, 128),
      status: string(worktree.status, 32), createdAt: worktree.createdAt, ...(moment(worktree.lastAppliedAt) !== undefined ? { lastAppliedAt: worktree.lastAppliedAt } : {}),
      ...(moment(worktree.mergedAt) !== undefined ? { mergedAt: worktree.mergedAt } : {}), ...(moment(worktree.removedAt) !== undefined ? { removedAt: worktree.removedAt } : {}),
      ...(worktree.recreatedFromMissing ? { recreatedFromMissing: true } : {}) } };
  }
  private async history(request: HostRequest, args: Record<string, unknown>, target: Target): Promise<GitLogResult> {
    const offset = args.offset === undefined ? 0 : args.offset, limit = args.limit === undefined ? 30 : args.limit;
    if (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0 || offset > MAX_HISTORY_OFFSET
      || typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_HISTORY_PAGE) throw invalid();
    const headOid = args.headOid === undefined ? null : idArg(args.headOid);
    if (headOid !== null && !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(headOid)) throw invalid();
    const raw = await this.native(request, args, target, "remote_studio_git_log", { root: target.root, offset, limit, headOid });
    if (!Array.isArray(raw.entries) || raw.entries.length > MAX_HISTORY_PAGE) throw unavailable();
    const result: GitLogResult = { repository: raw.repository === true, entries: [], hasMore: raw.hasMore === true, nextOffset: count(raw.nextOffset),
      headOid: raw.headOid === null ? null : oid(raw.headOid), truncated: raw.truncated === true };
    for (const entry of raw.entries) {
      const row = record(entry);
      const commit: WireGitCommit = { oid: oid(row.oid), shortOid: string(row.shortOid, 64), subject: string(row.subject, 4096).slice(0, 512),
        authorName: string(row.authorName, 1024).slice(0, 256), authoredAt: string(row.authoredAt, 64) };
      if (size(result) + size(commit) + 256 > STUDIO_RESULT_BYTES) { result.truncated = true; result.hasMore = true; break; }
      result.entries.push(commit);
    }
    result.nextOffset = offset + result.entries.length;
    return result;
  }
  private sweepPreviews(): void {
    for (const [key, preview] of this.previews) if (preview.expires <= Date.now()) this.previews.delete(key);
    while (this.previews.size >= MAX_PREVIEWS) this.previews.delete(this.previews.keys().next().value!);
  }
  private async revertPreview(request: HostRequest, args: Record<string, unknown>, target: Target): Promise<RevertPreviewResult> {
    // The same access as the revert it prepares: it runs Git over the checkout.
    if (!request.grant.work || !request.grant.capabilities.terminal || !request.grant.capabilities.gitWrite) throw new HostReadError("forbidden", "This action needs Work, Terminal and Git-write access.");
    const path = args.changeId === undefined ? null : this.studio.changePath(request, args, args.changeId);
    const raw = await this.native(request, args, target, "remote_studio_revert_preview", { root: target.root, path });
    const token = idArg(raw.token);
    const paths = (value: unknown) => {
      if (!Array.isArray(value)) throw unavailable();
      return value.map(relativeStudioPath);
    };
    const restore = paths(raw.restorePaths), preserved = paths(raw.preservedPaths);
    this.sweepPreviews();
    const previewId = crypto.randomUUID();
    this.previews.set(previewId, { device: request.device, revision: request.grant.revision, target: target.key, path, token, expires: Date.now() + PREVIEW_TTL });
    return { previewId, restorePaths: restore.slice(0, MAX_PREVIEW_PATHS), preservedPaths: preserved.slice(0, MAX_PREVIEW_PATHS),
      truncated: restore.length > MAX_PREVIEW_PATHS || preserved.length > MAX_PREVIEW_PATHS };
  }
  /** For the host's revert: the path and token a preview stands for, once.
   * `path` is null for revert all. The token never leaves this device. */
  takeRevert(request: HostRequest, args: Record<string, unknown>, previewId: string): { path: string | null; token: string } {
    const preview = this.previews.get(previewId);
    this.previews.delete(previewId);
    if (!preview || preview.device !== request.device || preview.revision !== request.grant.revision || preview.expires <= Date.now()
      || preview.target !== this.target(request, args).key) throw new HostReadError("stale_target", "This preview expired. Review the change again.");
    return { path: preview.path, token: preview.token };
  }
  /**
   * Ports come only from what the agent wrote in this thread on this host, never
   * from the viewer, so a viewer can't aim a preview at some other local service.
   */
  private async previewLinks(request: HostRequest, target: Target): Promise<PreviewLinksResult> {
    if (!request.grant.work) throw new HostReadError("forbidden", "This action requires Work access.");
    if (!target.threadId) return { previews: [], truncated: false };
    const ports = new Map<number, string>();
    let more = false;
    for (const message of (useTaskStore.getState().tasks[target.threadId]?.messages ?? []).slice(-MAX_SCANNED_MESSAGES).reverse()) {
      if (message.role === "user") continue;
      for (const [link] of message.text.slice(0, MAX_SCANNED_CHARS).matchAll(LOOPBACK_LINK)) {
        const port = hostLocalPort(link);
        if (port === null || ports.has(port)) continue;
        if (ports.size >= MAX_PREVIEW_LINKS) { more = true; break; }
        ports.set(port, link.includes("[::1]") ? `[::1]:${port}` : `127.0.0.1:${port}`);
      }
    }
    const result: PreviewLinksResult = { previews: [], truncated: more };
    for (const [port, address] of ports) {
      const key = `${target.workspace}\n${address}`;
      let endpoint = this.endpoints.get(key);
      if (!endpoint || endpoint.expires <= Date.now()) {
        try {
          const raw = await this.transport.invoke<{ endpointId?: unknown }>("remote_preview_register", { generation: this.generation, workspaceId: target.workspace, address });
          endpoint = { endpointId: idArg(raw?.endpointId), expires: Date.now() + ENDPOINT_TTL };
        } catch { result.truncated = true; continue; } // Hosting is off, or the host's limit is reached.
        this.endpoints.set(key, endpoint);
      }
      result.previews.push({ endpointId: endpoint.endpointId, name: `localhost:${port}`, port });
    }
    return result;
  }
  private agents(target: Target): AgentsListResult {
    if (!target.threadId) return { agents: [], truncated: false };
    const records = useTaskStore.getState().tasks[target.threadId]?.agents ?? [];
    const result: AgentsListResult = { agents: [], truncated: records.length > MAX_AGENTS };
    for (const entry of records.slice(0, MAX_AGENTS)) {
      const row = wireAgent(entry);
      if (size(result) + size(row) + 256 > STUDIO_RESULT_BYTES) { result.truncated = true; break; }
      result.agents.push(row);
    }
    return result;
  }
  private async image(request: HostRequest, args: Record<string, unknown>, target: Target): Promise<AttachmentImageResult> {
    if (!target.threadId) throw invalid();
    const messageId = idArg(args.messageId), index = args.index, offset = args.offset === undefined ? 0 : args.offset;
    if (typeof index !== "number" || !Number.isSafeInteger(index) || index < 0 || index > 7
      || typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0 || offset >= MAX_IMAGE_BYTES) throw invalid();
    // A reference into a message this device may read. The path is the host's own.
    const message = useTaskStore.getState().tasks[target.threadId]?.messages.find((entry) => entry.id === messageId);
    const attachment = message?.attachments?.[index];
    if (!attachment?.path || attachment.kind !== "image") throw new HostReadError("stale_target", "This image is no longer available.");
    const raw = await this.native(request, args, target, "remote_studio_attachment_image", { path: attachment.path, offset });
    if (raw.tooLarge === true) return { tooLarge: true };
    if (!["image/png", "image/jpeg", "image/gif", "image/webp"].includes(String(raw.mime))) throw unavailable();
    const result: AttachmentImageResult = { mime: String(raw.mime), size: count(raw.size), data: string(raw.data, IMAGE_REPLY_BYTES), done: raw.done === true };
    return result;
  }
}
