import { useCallback, useEffect, useRef } from "react";
import { friendlyError } from "../lib/errors";
import { normalizedProjectPath } from "../lib/paths";
import type { ProjectGitCommit } from "../lib/gitInspection";
import type { ProjectGitInspection } from "../lib/projectGit";
import { createScopedStore, useScopedStore } from "../lib/scopedStore";

export const HISTORY_PAGE = 30;

export interface ProjectHistoryState {
  entries: ProjectGitCommit[];
  /** The commit the first page was read from; later pages stay on it. */
  headOid: string | null;
  hasMore: boolean;
  nextOffset: number;
  loaded: boolean;
  loading: boolean;
  error: string | null;
  failedRequest: "reload" | "more" | null;
  truncated: boolean;
  loadedAt: number | null;
}

export const projectHistoryStore = createScopedStore<ProjectHistoryState>({
  entries: [], headOid: null, hasMore: false, nextOffset: 0, loaded: false,
  loading: false, error: null, failedRequest: null, truncated: false, loadedAt: null,
});

const generations = new Map<string, number>();

async function readPage(api: ProjectGitInspection, cwd: string, first: boolean) {
  const scope = normalizedProjectPath(cwd);
  const current = projectHistoryStore.get(scope);
  if (current.loading && !first) return;
  const generation = (generations.get(scope) ?? 0) + (first ? 1 : 0);
  generations.set(scope, generation);
  const offset = first ? 0 : current.nextOffset;
  const headOid = first ? null : current.headOid;
  projectHistoryStore.update(scope, { loading: true, error: null, failedRequest: null });
  try {
    const page = await api.getHistory(cwd, offset, HISTORY_PAGE, headOid);
    if (generations.get(scope) !== generation) return;
    if (!page || !Array.isArray(page.entries)) throw new Error("Git returned no commit history for this folder.");
    projectHistoryStore.update(scope, {
      // The bounded checkout cache can evict this scope during a slow read.
      // Retain this request's immutable base page and pinned HEAD, not the
      // store's empty fallback. Generation checks still reject overtaken reads.
      entries: first ? page.entries : [...current.entries, ...page.entries],
      headOid: first ? page.headOid : current.headOid,
      hasMore: page.hasMore,
      nextOffset: page.nextOffset,
      truncated: page.truncated,
      loaded: true,
      loading: false,
      error: null,
      failedRequest: null,
      loadedAt: first ? Date.now() : current.loadedAt,
    });
  } catch (error) {
    if (generations.get(scope) !== generation) return;
    // Preserve the same base if eviction happens before a failed page, so a
    // retry can still use the exact offset and HEAD the user requested.
    projectHistoryStore.update(scope, { ...current, loading: false, error: friendlyError(error), failedRequest: first ? "reload" : "more" });
  }
}

/** Real Git commits, one page at a time, only once History is opened. */
export function useProjectGitHistory(api: ProjectGitInspection | undefined, visible: boolean) {
  const cwd = api?.cwd ?? "";
  const scope = cwd ? normalizedProjectPath(cwd) : "";
  const state = useScopedStore(projectHistoryStore, scope);
  const apiRef = useRef(api);
  apiRef.current = api;

  useEffect(() => {
    const current = apiRef.current;
    if (!visible || !current?.cwd) return;
    const saved = projectHistoryStore.get(normalizedProjectPath(current.cwd));
    if (!saved.loaded && !saved.loading) void readPage(current, current.cwd, true);
  }, [visible, cwd]);

  const reload = useCallback(() => {
    const current = apiRef.current;
    if (current?.cwd) void readPage(current, current.cwd, true);
  }, []);
  const loadMore = useCallback(() => {
    const current = apiRef.current;
    if (current?.cwd) void readPage(current, current.cwd, false);
  }, []);
  const retry = useCallback(() => {
    const current = apiRef.current;
    if (!current?.cwd) return;
    const failed = projectHistoryStore.get(normalizedProjectPath(current.cwd)).failedRequest;
    if (failed) void readPage(current, current.cwd, failed === "reload");
  }, []);

  return { ...state, available: Boolean(api), reload, loadMore, retry };
}
