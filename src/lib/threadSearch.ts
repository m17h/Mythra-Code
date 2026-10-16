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

export interface LocalTranscriptSearchThread {
  provider: "claude" | "cursor";
  threadId: string;
}

export interface LocalTranscriptSearchResponse {
  hits: LocalTranscriptSearchHit[];
  incomplete: boolean;
}

// One native search at a time per renderer. A new input cancels queued stale
// work; an already running query has its own native execution deadline.
let localSearchQueue: Promise<void> = Promise.resolve();

/** Content search across locally stored Claude and Cursor conversations. */
export function searchLocalTranscripts(
  query: string,
  eligibleThreads: LocalTranscriptSearchThread[],
  signal: AbortSignal,
  limit = 50,
): Promise<LocalTranscriptSearchResponse> {
  const run = localSearchQueue.then(async (): Promise<LocalTranscriptSearchResponse> => {
    if (!isTauri() || signal.aborted || !eligibleThreads.length) return { hits: [], incomplete: false };
    const result = await invoke<LocalTranscriptSearchResponse>("local_transcript_search", { query, eligibleThreads, limit });
    if (!result || !Array.isArray(result.hits) || typeof result.incomplete !== "boolean") {
      throw new Error("Local conversation search returned an invalid response.");
    }
    // Dropping invalid hits could turn a malformed response into an apparently
    // exhaustive zero. Treat the whole source as unavailable instead.
    if (!result.hits.every((hit) => Boolean(hit) && typeof hit === "object"
      && (hit.provider === "claude" || hit.provider === "cursor")
      && typeof hit.threadId === "string" && Boolean(hit.threadId.trim())
      && typeof hit.snippet === "string")) {
      throw new Error("Local conversation search returned an invalid hit.");
    }
    return {
      hits: result.hits,
      incomplete: result.incomplete,
    };
  });
  localSearchQueue = run.then(() => undefined, () => undefined);
  return run;
}
