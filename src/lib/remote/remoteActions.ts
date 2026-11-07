import { invoke } from "@tauri-apps/api/core";
import { viewerErrorCode, viewerHostOperation } from "./viewerBridge";
import { refusalText, sequenced } from "./remoteWork";
import type { WireParityReadResult, WireParityRow } from "./wire";

export interface HostWriteResult<T = Record<string, unknown>> {
  ok: boolean; message: string; result?: T;
  /** The reply was lost, so the change may or may not have happened. */
  unknown?: boolean;
  /** Why it was refused, when the host said. */
  code?: string;
}

/** A plain read from the host. Whatever it refuses is thrown to the caller. */
export const hostRead = <T>(device: string, op: string, args: Record<string, unknown> = {}) => viewerHostOperation<T>(device, op, args);

/** Rows from a host reply, which is only ever trusted to be a reply. */
export const hostRows = (result: { rows?: WireParityRow[] } | null | undefined): WireParityRow[] => Array.isArray(result?.rows) ? result.rows : [];

const UNCONFIRMED = "We couldn't confirm that reached the other device. Check before trying again.";
const DEFINITE = new Set(["forbidden", "busy", "rate_limited", "stale_target", "unsupported", "not_paired", "invalid", "thread_unavailable"]);

/** One journaled change on the host. A lost reply is reported as unknown, never
 * as a failure that is safe to repeat. */
export async function hostWrite<T = Record<string, unknown>>(device: string, name: string, op: string, args: Record<string, unknown>): Promise<HostWriteResult<T>> {
  try {
    const result = await sequenced(device, () => undefined, (opSeq) => viewerHostOperation<T & { state?: string; error?: { code?: string } }>(device, op, { opId: crypto.randomUUID(), opSeq, ...args }));
    if (result?.state === "rejected") return { ok: false, message: refusalText(result.error?.code ?? "", name), result, code: result.error?.code };
    if (result?.state === "uncertain") return { ok: false, message: UNCONFIRMED, result, unknown: true };
    return { ok: true, message: "", result };
  } catch (reason) {
    const code = viewerErrorCode(reason);
    return DEFINITE.has(code) ? { ok: false, message: refusalText(code, name), code } : { ok: false, message: UNCONFIRMED, unknown: true };
  }
}

/** A project's own settings are checked against the project, not the thread on
 * screen, so the revision has to be read for exactly that target. */
export async function hostProjectWrite(device: string, name: string, workspaceId: string, op: string, args: Record<string, unknown>): Promise<HostWriteResult> {
  let revision: string | undefined;
  try { revision = (await hostRead<WireParityReadResult>(device, "projects.settings.read", { workspaceId })).revision; }
  catch { return { ok: false, message: `Mythra Code couldn't reach ${name}. Try again.` }; }
  return hostWrite(device, name, op, { workspaceId, revision, ...args });
}

/** The sentence every switch-gated control shows. */
export function accessReason(name: string, what: string, switchName: string): string {
  return `To ${what} on ${name}, turn on ${switchName} for this device in Settings → Connections → Devices on ${name}.`;
}

const UPLOAD_CHUNK_BYTES = 60_000;
const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map((value) => value.toString(16).padStart(2, "0")).join("");
function base64(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 8192) binary += String.fromCharCode(...bytes.subarray(index, index + 8192));
  return btoa(binary);
}
export type HostUpload = { ok: true; id: string; name: string; kind: "image" | "file" } | { ok: false; message: string };
/** Sends a file the user chose to the host. The host only ever hands back an
 * id, so nothing on this device learns where it was stored. */
const IMAGE_TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", bmp: "image/bmp", tif: "image/tiff", tiff: "image/tiff", heic: "image/heic" };
/** A file dropped on the window. The drop gives a path on this device, and
 * the app's native side reads it only because that drop really happened. */
export async function readDroppedFile(path: string): Promise<File> {
  const buffer = await invoke<ArrayBuffer>("remote_upload_read_dropped", { path });
  const name = path.split(/[\\/]/).pop() || "file";
  return new File([buffer], name, { type: IMAGE_TYPES[name.split(".").pop()?.toLowerCase() ?? ""] ?? "" });
}

export async function uploadToHost(device: string, name: string, workspaceId: string, file: File): Promise<HostUpload> {
  const kind = file.type.startsWith("image/") ? "image" as const : "file" as const;
  const bytes = new Uint8Array(await file.arrayBuffer());
  const begin = await hostWrite<{ uploadId?: string }>(device, name, "attachment.put", { workspaceId, phase: "begin", name: file.name, kind, size: bytes.length });
  const uploadId = begin.result?.uploadId;
  if (!begin.ok || !uploadId) return { ok: false, message: begin.message || `${name} didn't accept that file.` };
  for (let offset = 0; offset < bytes.length; offset += UPLOAD_CHUNK_BYTES) {
    const data = base64(bytes.subarray(offset, offset + UPLOAD_CHUNK_BYTES));
    const chunk = await hostWrite(device, name, "attachment.put", { workspaceId, phase: "chunk", uploadId, offset, data });
    if (!chunk.ok) {
      void hostWrite(device, name, "attachment.put", { workspaceId, phase: "cancel", uploadId });
      return { ok: false, message: chunk.message };
    }
  }
  const sha256 = hex(await crypto.subtle.digest("SHA-256", bytes));
  const finish = await hostWrite<{ attachmentId?: string }>(device, name, "attachment.put", { workspaceId, phase: "finish", uploadId, sha256 });
  const id = finish.result?.attachmentId;
  return finish.ok && id ? { ok: true, id, name: file.name, kind } : { ok: false, message: finish.message || `${name} didn't accept that file.` };
}
