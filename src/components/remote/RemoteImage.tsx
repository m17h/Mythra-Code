import { useEffect, useState } from "react";
import { hostRead } from "../../lib/remote/remoteActions";
import type { AttachmentImageResult } from "../../lib/remote/wire-studio";
import { LocalMessageImagePreview } from "../MessageImagePreview";

const MAX_CHUNKS = 32;
const MAX_KEPT = 32;
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
export interface RemoteImageRef { device: string; workspaceId: string; threadId: string; messageId: string; index: number }

const kept = new Map<string, Promise<string | null>>();
/** Bytes arrive a piece at a time, so an image larger than one reply still shows. */
async function fetchImage({ device, workspaceId, threadId, messageId, index }: RemoteImageRef): Promise<string | null> {
  const parts: Uint8Array<ArrayBuffer>[] = [];
  let offset = 0;
  for (let chunk = 0; chunk < MAX_CHUNKS; chunk += 1) {
    const reply = await hostRead<AttachmentImageResult>(device, "attachment.image", { workspaceId, threadId, messageId, index, ...(offset ? { offset } : {}) });
    if (reply.tooLarge || !reply.data || !reply.mime || !IMAGE_TYPES.has(reply.mime)) return null;
    const bytes = Uint8Array.from(atob(reply.data), (char) => char.charCodeAt(0));
    if (!bytes.length) return null;
    parts.push(bytes);
    offset += bytes.length;
    if (reply.done) return URL.createObjectURL(new Blob(parts, { type: reply.mime }));
  }
  return null;
}
function imageUrl(image: RemoteImageRef): Promise<string | null> {
  const key = JSON.stringify(image);
  const known = kept.get(key);
  if (known) return known;
  const loading = fetchImage(image).catch(() => null);
  kept.set(key, loading);
  if (kept.size > MAX_KEPT) {
    const [oldest, url] = kept.entries().next().value!;
    kept.delete(oldest);
    void url.then((value) => { if (value) URL.revokeObjectURL(value); });
  }
  void loading.then((value) => { if (!value) kept.delete(key); });
  return loading;
}

/** The real image preview, fed from the other device. The name stands in until
 * the bytes arrive, and stays if they can't be shown. */
export function RemoteImage({ image, name }: { image: RemoteImageRef; name: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const { device, workspaceId, threadId, messageId, index } = image;
  useEffect(() => {
    let current = true;
    void imageUrl({ device, workspaceId, threadId, messageId, index }).then((value) => { if (current) setUrl(value); });
    return () => { current = false; };
  }, [device, index, messageId, threadId, workspaceId]);
  return url ? <LocalMessageImagePreview path={url} name={name} /> : <span className="message-image-preview unavailable">{name}</span>;
}
