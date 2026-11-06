import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { HostPublish, HostResponse } from "../wire";

export interface HostTransport {
  invoke<T>(command: string, args?: Record<string, unknown>): Promise<T>;
  listen<T>(event: string, callback: (payload: T) => void): Promise<() => void>;
}
export const nativeHostTransport: HostTransport = {
  invoke: <T>(command: string, args?: Record<string, unknown>) => invoke<T>(command, args),
  listen: <T>(event: string, callback: (payload: T) => void) => listen<T>(event, ({ payload }) => callback(payload)),
};
export function staleGeneration(reason: unknown): boolean {
  if (reason && typeof reason === "object" && "code" in reason && reason.code === "stale_generation") return true;
  return typeof reason === "string" && reason.includes("stale_generation");
}

/** Captures happen synchronously; IPC commits are serialized before responses. */
export class HostBridge {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(readonly generation: number, private readonly transport: HostTransport,
    private readonly isCurrent: () => boolean, private readonly lost: (reason: unknown) => void) {}
  command<T = void>(command: string, args: Record<string, unknown> = {}, fatal = false): Promise<T> {
    const next = this.tail.then(async () => {
      if (!this.isCurrent()) throw { code: "stale_generation" };
      try { return await this.transport.invoke<T>(command, { ...args, generation: this.generation }); }
      catch (reason) { if (fatal || staleGeneration(reason)) this.lost(reason); throw reason; }
    });
    this.tail = next.catch(() => undefined);
    return next;
  }
  publish(payload: HostPublish): void {
    // A failed publication invalidates the lease/baseline, never skips a seq.
    void this.command("remote_host_publish", { ...payload }, true).catch(() => undefined);
  }
  invalidate(): void { this.lost({ code: "stale_generation" }); }
  respond(payload: HostResponse): Promise<void> { return this.command("remote_host_respond", { ...payload }); }
  retired(threadId: string): void { void this.command("remote_host_thread_retired", { threadId }).catch(() => undefined); }
}
