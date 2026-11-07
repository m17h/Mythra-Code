import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { RemoteViewerFrame, RemoteViewerState, RemoteWorkOperation } from "./wire";

/** Viewer-only bridge: no provider commands, paths or credentials. */
export type ViewerOperation = "workspaces.list" | "threads.list" | "timeline.read" | "timeline.subscribe" | "timeline.unsubscribe" | "work.inspect" | "op.status" | "host.info" | "host.context" | "files.search" | "files.list" | "files.preview" | "git.status" | "git.diff" | "folders.browse";
const VIEWER_OPERATIONS = new Set<ViewerOperation>(["workspaces.list", "threads.list", "timeline.read", "timeline.subscribe", "timeline.unsubscribe", "work.inspect", "op.status", "host.info", "host.context", "files.search", "files.list", "files.preview", "git.status", "git.diff", "folders.browse"]);
const WORK_OPERATIONS = new Set<RemoteWorkOperation | "projects.add" | "projects.clone">(["projects.clone", "prompt.send", "prompt.steer", "prompt.queue", "turn.stop", "approval.answer", "question.answer", "thread.settings.set", "thread.rename", "thread.archive", "thread.restore", "thread.delete", "thread.pin", "thread.fork", "projects.pin", "projects.remove", "projects.reorder", "projects.add"]);
export function viewerRequest<T>(device: string, op: ViewerOperation, args: object = {}): Promise<T> {
  if (!/^[0-9a-f]{64}$/.test(device) || !VIEWER_OPERATIONS.has(op) || !args || Array.isArray(args)) {
    return Promise.reject({ code: "forbidden", message: "That viewer request is not valid." });
  }
  return invoke<T>("remote_request", { device, op, args });
}
/** Reads and journaled writes reach the host by name. Rust and the host decide
 * what each one may do, and an op neither knows comes back as a refusal. */
export function viewerHostOperation<T>(device: string, op: string, args: Record<string, unknown>): Promise<T> {
  if (!/^[0-9a-f]{64}$/.test(device) || !/^[a-z]+(\.[a-zA-Z]+)+$/.test(op)) {
    return Promise.reject({ code: "forbidden", message: "That request is not valid." });
  }
  return invoke<T>("remote_request", { device, op, args });
}
/** Mutations travel the same route, and every one carries a journal identity. */
export function viewerWork<T>(device: string, op: RemoteWorkOperation | "projects.add" | "projects.clone", args: { opId?: unknown; opSeq?: unknown; [key: string]: unknown }): Promise<T> {
  if (!/^[0-9a-f]{64}$/.test(device) || !WORK_OPERATIONS.has(op) || typeof args.opId !== "string" || typeof args.opSeq !== "number") {
    return Promise.reject({ code: "forbidden", message: "That request is not valid." });
  }
  return invoke<T>("remote_request", { device, op, args });
}
export async function listenViewer(
  frame: (event: RemoteViewerFrame) => void,
  state: (event: RemoteViewerState) => void,
): Promise<() => void> {
  const frames = await listen<RemoteViewerFrame>("remote-viewer-frame", ({ payload }) => frame(payload));
  try {
    const states = await listen<RemoteViewerState>("remote-viewer-state", ({ payload }) => state(payload));
    return () => { frames(); states(); };
  } catch (error) { frames(); throw error; }
}
export function viewerErrorCode(reason: unknown): string {
  if (reason && typeof reason === "object" && "code" in reason && typeof reason.code === "string"
    && /^[a-z_]{1,64}$/.test(reason.code)) return reason.code;
  if (typeof reason === "string") {
    try { const value: unknown = JSON.parse(reason); return viewerErrorCode(value); } catch { /* Unstructured IPC errors disclose no extra host details. */ }
  }
  return "host_unavailable";
}
