import type { WireExecutionSettings, RemoteOperationIdentity } from "../wire";
import { HostReadError } from "./scope";
export interface DraftToken {
  handle: string; startTarget: string; device: string; workspaceId: string; expires: number; settings: WireExecutionSettings;
  attemptId: string; cancelled: boolean; phase: "draft" | "preparing" | "dispatched" | "accepted";
  original?: RemoteOperationIdentity; threadId?: string;
}
export class DraftTokens {
  private entries = new Map<string, DraftToken>();
  constructor(private readonly isCurrent: () => boolean) {}
  clear() { this.entries.clear(); }
  get(handle: string, device: string, workspaceId: string): DraftToken {
    const entry = this.entries.get(handle);
    if (!this.isCurrent() || !entry || entry.device !== device || entry.workspaceId !== workspaceId || entry.expires < Date.now()) throw new HostReadError("stale_target", "This draft expired. Refresh its settings.");
    return entry;
  }
  set(device: string, workspaceId: string, settings: WireExecutionSettings, previous?: string): DraftToken {
    for (const [id, entry] of this.entries) if (entry.expires < Date.now() && entry.phase === "draft") this.entries.delete(id);
    if (previous) { const old = this.get(previous, device, workspaceId); if (old.phase !== "draft") throw new HostReadError("stale_target", "This draft is already being sent."); this.entries.delete(previous); }
    if (this.entries.size >= 256 || [...this.entries.values()].filter((e) => e.device === device).length >= 32) throw new HostReadError("busy", "Close another remote draft first.");
    const entry: DraftToken = { device, workspaceId, settings: structuredClone(settings), handle: crypto.randomUUID(), startTarget: crypto.randomUUID(),
      attemptId: crypto.randomUUID(), expires: Date.now() + 30 * 60_000, cancelled: false, phase: "draft" };
    this.entries.set(entry.handle, entry); return entry;
  }
  claim(entry: DraftToken, identity: RemoteOperationIdentity) {
    if (entry.cancelled || entry.phase !== "draft") throw new HostReadError("stale_target", "This draft has already been sent or cancelled.");
    entry.phase = "preparing"; entry.original = identity;
  }
  cancel(target: string, device: string, workspaceId: string): DraftToken {
    const entry = [...this.entries.values()].find((e) => e.startTarget === target);
    if (!entry) throw new HostReadError("stale_target", "This starting prompt has expired.");
    this.get(entry.handle, device, workspaceId);
    entry.cancelled = true;
    return entry;
  }
}
