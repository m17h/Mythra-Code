import { invoke, isTauri } from "@tauri-apps/api/core";
import type { Thread } from "../types";

export interface ThreadSearchResult {
  thread: Thread;
  snippet: string;
}

export interface ThreadSearchResponse {
  data: ThreadSearchResult[];
  nextCursor?: string | null;
  backwardsCursor?: string | null;
}

export function threadSearchParams(searchTerm: string, limit = 50) {
  return { searchTerm, limit };
}

function normalizedPath(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  return normalized || "/";
}

export function threadsForWorkspace(
  results: ThreadSearchResult[],
  workspacePath: string,
  bindings: Record<string, string>,
): Thread[] {
  const normalizedWorkspacePath = normalizedPath(workspacePath);
  return results
    .map((result) => result.thread)
    .filter((thread) => normalizedPath(bindings[thread.id] || thread.cwd) === normalizedWorkspacePath);
}

export interface LocalTranscriptSearchHit {
  provider: "claude" | "cursor";
  threadId: string;
  snippet: string;
}

/** Content search across locally stored Claude and Cursor conversations. */
export async function searchLocalTranscripts(query: string, limit = 50): Promise<LocalTranscriptSearchHit[]> {
  if (!isTauri()) return [];
  const hits = await invoke<unknown>("local_transcript_search", { query, limit });
  return Array.isArray(hits)
    ? hits.filter((hit): hit is LocalTranscriptSearchHit => Boolean(hit) && typeof hit === "object"
      && typeof (hit as LocalTranscriptSearchHit).threadId === "string" && typeof (hit as LocalTranscriptSearchHit).snippet === "string")
    : [];
}
