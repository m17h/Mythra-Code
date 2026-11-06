import { drainTaskDeltas, pinTaskTranscript, useTaskStore } from "../../taskStore";
import type { HostRequest, HostResponse, ThreadsListResult, WireThread } from "../wire";
import { REMOTE_RESULT_BYTES } from "../wire";
import { HostBridge } from "./bridge";
import { HostCatalog } from "./catalog";
import { HostHistory } from "./history";
import { HostPublishers } from "./publisher";
import { HostWindows, jsonBytes, rowLimit } from "./window";
import { boundedText } from "./projection";
import { HostReadError, currentGrant, idArg, objectArgs, requireThread, requireWorkspace, workspaceAllowed, wireError, type HostSources } from "./scope";
import { isRemoteWorkOperation } from "./workActions";
import type { RemoteWorkAdapter } from "./workTypes";
import { isParityRead } from "./parityActions";

interface ListPage { workspaceId: string; rows: WireThread[]; offset: number; expires: number }
export class HostDispatcher {
  private lists = new Map<string, ListPage>();
  private pins = new Set<() => void>();
  constructor(private readonly sources: HostSources, private readonly catalog: HostCatalog,
    private readonly history: HostHistory, private readonly windows: HostWindows,
    private readonly publishers: HostPublishers, private readonly bridge: HostBridge, private readonly isCurrent: () => boolean,
    private readonly work?: RemoteWorkAdapter) {}
  dispose(): void {
    for (const release of this.pins) release();
    this.pins.clear(); this.lists.clear();
  }
  private check(request: HostRequest): void {
    if (!this.isCurrent() || request.generation !== this.bridge.generation) throw new HostReadError("host_unavailable", "The host is recovering.");
    currentGrant(this.sources, request.device, request.grant);
  }
  async dispatch(request: HostRequest): Promise<void> {
    let response: HostResponse;
    let subscription: string | undefined;
    let release: (() => void) | undefined;
    try {
      this.check(request);
      const args = objectArgs(request.args);
      let result: HostResponse["result"];
      const isWork = isRemoteWorkOperation(request.op);
      if (isWork) {
        if (!this.work) throw new HostReadError("unsupported", "This host has not enabled remote work yet.");
        result = await this.work.dispatch(request);
      } else if (request.op === "workspaces.list") {
        result = { workspaces: this.sources.getWorkspaces().filter((workspace) => workspaceAllowed(workspace, request.grant)).slice(0, 256)
          .map((workspace) => ({ id: workspace.id, name: boundedText(workspace.name, 256), isChat: workspace.isChat === true, pinned: workspace.pinned === true })) };
      } else if (request.op === "threads.list") {
        result = await this.list(request, args);
      } else if (request.op === "timeline.read" || request.op === "timeline.subscribe") {
        const threadId = idArg(args.threadId);
        const target = () => {
          this.check(request);
          const thread = this.catalog.thread(threadId);
          if (!thread || !this.catalog.eligible(thread)) throw new HostReadError("thread_unavailable", "This conversation is not available.");
          return requireThread(this.sources, thread, request.grant, this.catalog.ownership());
        };
        const resolved = target();
        this.sources.rememberThread?.(resolved.thread);
        const assertCurrent = () => {
          const current = target();
          if (current.workspace.id !== resolved.workspace.id || current.workspace.path !== resolved.workspace.path) throw new HostReadError("stale_target", "This conversation changed workspaces.");
        };
        release = pinTaskTranscript(threadId);
        this.pins.add(release);
        const historyTarget = { thread: resolved.thread, workspacePath: resolved.workspace.path, assertCurrent };
        if (request.op === "timeline.read") {
          const before = args.before === undefined ? undefined : idArg(args.before);
          const limit = rowLimit(args.limit);
          await this.history.preparePage(historyTarget, this.windows.anchor(threadId, before), limit);
          assertCurrent();
          drainTaskDeltas();
          const task = useTaskStore.getState().tasks[threadId];
          if (!task) throw new HostReadError("thread_unavailable", "This conversation is unavailable.");
          result = this.windows.page(threadId, task, before, limit);
        } else {
          await this.history.ensure(historyTarget);
          assertCurrent();
          subscription = threadId;
          result = this.publishers.subscribe(threadId, request.device, request.grant, {
            epoch: typeof args.epoch === "string" ? args.epoch.slice(0, 128) : undefined,
            needSnapshot: args.needSnapshot !== false,
          });
        }
      } else throw new HostReadError("unsupported", "This host supports live viewing only.");
      // A grant may be removed after a provider accepted work. Never turn that
      // accepted receipt into a rejected send; the journal remains authoritative.
      if (!isWork || isParityRead(request.op) || request.op === "work.inspect" || request.op === "host.context" || request.op === "files.search") this.check(request);
      else if (!this.isCurrent()) throw new HostReadError("host_unavailable", "The host is recovering.");
      if (jsonBytes(result) > REMOTE_RESULT_BYTES) throw new HostReadError("busy", "This page is too large. Request fewer rows.");
      response = { generation: request.generation, requestId: request.requestId, result };
    } catch (reason) {
      response = { generation: request.generation, requestId: request.requestId, error: wireError(reason) };
    }
    try { if (this.isCurrent()) await this.bridge.respond(response); }
    finally { if (release) { release(); this.pins.delete(release); } if (subscription) this.publishers.settle(subscription); }
  }
  private async list(request: HostRequest, args: Record<string, unknown>): Promise<ThreadsListResult> {
    const workspaceId = idArg(args.workspaceId);
    const workspace = requireWorkspace(this.sources, workspaceId, request.grant);
    const limit = rowLimit(args.limit);
    let rows: WireThread[];
    let offset = 0;
    if (args.cursor !== undefined) {
      const page = this.lists.get(idArg(args.cursor));
      if (!page || page.workspaceId !== workspaceId || page.expires < Date.now()) throw new HostReadError("stale_target", "This thread list expired. Refresh it.");
      rows = page.rows;
      offset = page.offset;
    } else {
      const threads = await this.catalog.list(workspace);
      this.check(request);
      requireWorkspace(this.sources, workspaceId, request.grant);
      rows = threads.map((thread) => this.catalog.row(thread, workspaceId));
    }
    const allowed = rows.slice(offset).filter((row) => {
      const thread = this.catalog.thread(row.id);
      if (!thread || !this.catalog.eligible(thread)) return false;
      try { return requireThread(this.sources, thread, request.grant, this.catalog.ownership()).workspace.id === workspaceId; } catch { return false; }
    });
    const threads: WireThread[] = [];
    let bytes = 2048;
    for (const row of allowed.slice(0, limit)) {
      const size = jsonBytes(row) + 2;
      if (bytes + size > REMOTE_RESULT_BYTES) break;
      threads.push(row);
      bytes += size;
    }
    if (!threads.length && allowed.length) throw new HostReadError("busy", "This thread list is too large.");
    if (allowed.length <= threads.length) return { threads };
    for (const [key, page] of this.lists) if (page.expires < Date.now()) this.lists.delete(key);
    while (this.lists.size >= 128) this.lists.delete(this.lists.keys().next().value!);
    const cursor = crypto.randomUUID();
    this.lists.set(cursor, { workspaceId, rows: allowed, offset: threads.length, expires: Date.now() + 5 * 60_000 });
    return { threads, cursor };
  }
}
