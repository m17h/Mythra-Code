import { basename } from "./paths";
import type { AttachmentRecord } from "../components/StudioDock";

/**
 * Extensions the runtimes accept as native image inputs. This is the only
 * classification in the app: the composer picker, drag-and-drop, and the
 * Files tab's Attach button all resolve a path through here, so the same
 * screenshot is never sent as an image from one surface and as a bare file
 * path from another.
 */
const IMAGE_EXTENSION_PATTERN = /\.(png|jpe?g|gif|webp|heic)$/i;

export function attachmentKind(path: string): AttachmentRecord["kind"] {
  return IMAGE_EXTENSION_PATTERN.test(path) ? "image" : "file";
}

export function attachmentRecord(path: string): AttachmentRecord {
  return { path, name: basename(path), kind: attachmentKind(path) };
}

/** Adds paths that are not attached yet, preserving the existing order. */
export function withAttachedPaths(
  current: AttachmentRecord[],
  paths: string[],
): AttachmentRecord[] {
  const seen = new Set(current.map((item) => item.path));
  const added: AttachmentRecord[] = [];
  for (const path of paths) {
    if (seen.has(path)) continue;
    seen.add(path);
    added.push(attachmentRecord(path));
  }
  return added.length ? [...current, ...added] : current;
}
