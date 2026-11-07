import { invoke } from "@tauri-apps/api/core";
import { hostRead } from "./remoteActions";
import type { PreviewLinksResult } from "./wire-studio";

export interface RemotePreview { endpointId: string; name: string; port?: number }
interface PreviewOpened { previewId?: string; url?: string; opened?: boolean; reason?: string }
export interface PreviewOutcome { previewId?: string; notice: string }

/** With a thread, what it has named on the host. Without one, what is registered. */
export async function listRemotePreviews(device: string, workspaceId: string, threadId?: string): Promise<RemotePreview[]> {
  if (threadId) {
    const result = await hostRead<PreviewLinksResult>(device, "preview.links", { workspaceId, threadId });
    return Array.isArray(result?.previews) ? result.previews : [];
  }
  const result = await invoke<{ previews?: RemotePreview[] }>("remote_preview_list", { device, workspaceId });
  return Array.isArray(result?.previews) ? result.previews : [];
}

/** The native side opens the browser on a tunnel to that one host port. Nothing
 * here opens it again: if the browser didn't start, the address is shown instead. */
export async function openRemotePreview(device: string, endpointId: string): Promise<PreviewOutcome> {
  const result = await invoke<PreviewOpened>("remote_preview_open", { device, endpointId });
  if (result?.opened) return { previewId: result.previewId, notice: "" };
  const reason = result?.reason ?? "Your browser didn't open.";
  const address = typeof result?.url === "string" && result.url.startsWith("http://127.0.0.1:") ? ` Open ${result.url} in a browser on this device.` : "";
  return { previewId: result?.previewId, notice: `${reason}${address}` };
}
export const closeRemotePreview = (previewId: string) => invoke<void>("remote_preview_close", { previewId });
