import { useCallback, useEffect, useRef } from "react";
import { formatGitError } from "../lib/errors";
import { normalizedProjectPath } from "../lib/paths";
import { changeKey } from "../lib/gitChanges";
import type { GitChangeArea, ProjectGitChanges, ProjectGitFileDiff } from "../lib/gitInspection";
import type { ProjectGitInspection } from "../lib/projectGit";
import { createScopedStore, useScopedStore } from "../lib/scopedStore";

export interface ChangeSelection { path: string; area: GitChangeArea }

export interface ProjectChangesState {
  changes: ProjectGitChanges | null;
  loading: boolean;
  error: string | null;
  loadedAt: number | null;
  selected: ChangeSelection | null;
  diff: ProjectGitFileDiff | null;
  diffKey: string | null;
  diffLoading: boolean;
  diffError: string | null;
}

export const projectChangesStore = createScopedStore<ProjectChangesState>({
  changes: null, loading: false, error: null, loadedAt: null,
  selected: null, diff: null, diffKey: null, diffLoading: false, diffError: null,
});

const reads = new Map<string, { rerun: boolean }>();
const diffSequences = new Map<string, number>();

/** One file, one area, one bounded read — never every diff in the repository. */
async function readDiff(api: ProjectGitInspection, scope: string, cwd: string, selection: ChangeSelection) {
  const sequence = (diffSequences.get(scope) ?? 0) + 1;
  diffSequences.set(scope, sequence);
  const key = changeKey(selection);
  projectChangesStore.update(scope, (current) => ({
    diffKey: key,
    diffLoading: true,
    diffError: null,
    // A refresh of the same file keeps its text on screen until the new one lands.
    diff: current.diffKey === key ? current.diff : null,
  }));
  try {
    const diff = await api.getFileDiff(cwd, selection.path, selection.area);
    if (diffSequences.get(scope) !== sequence) return;
    if (!diff || typeof diff.text !== "string") throw new Error("Git returned no preview for this file.");
    projectChangesStore.update(scope, { diff, diffLoading: false });
  } catch (error) {
    if (diffSequences.get(scope) !== sequence) return;
    projectChangesStore.update(scope, { diff: null, diffLoading: false, diffError: formatGitError(error) });
  }
}

async function readChanges(api: ProjectGitInspection, cwd: string) {
  const scope = normalizedProjectPath(cwd);
  const pending = reads.get(scope);
  if (pending) { pending.rerun = true; return; }
  const entry = { rerun: false };
  reads.set(scope, entry);
  projectChangesStore.update(scope, { loading: true });
  try {
    const changes = await api.getChanges(cwd);
    if (!changes || !Array.isArray(changes.rows)) throw new Error("Git returned no Changes list for this folder.");
    let selected = projectChangesStore.get(scope).selected;
    if (selected && !changes.rows.some((row) => row.path === selected!.path && row.area === selected!.area)) {
      // Staging moves a file between groups; keep following that file.
      const moved = changes.rows.find((row) => row.path === selected!.path);
      selected = moved ? { path: moved.path, area: moved.area } : null;
    }
    projectChangesStore.update(scope, {
      changes, loading: false, error: null, loadedAt: Date.now(), selected,
      ...(selected ? {} : { diff: null, diffKey: null, diffError: null, diffLoading: false }),
    });
    if (selected) void readDiff(api, scope, cwd, selected);
    else diffSequences.set(scope, (diffSequences.get(scope) ?? 0) + 1);
  } catch (error) {
    projectChangesStore.update(scope, { loading: false, error: formatGitError(error) });
  } finally {
    reads.delete(scope);
    if (entry.rerun) void readChanges(api, cwd);
  }
}

/**
 * The checkout's staged, unstaged and new files, read only while the Changes
 * view is on screen. `revision` includes the owner's successful-read revision,
 * not only summary metadata: content edits can leave all counts unchanged.
 * Owner refreshes and busy transitions reach the list without another poller.
 */
export function useProjectGitChanges(api: ProjectGitInspection | undefined, visible: boolean, revision: string) {
  const cwd = api?.cwd ?? "";
  const scope = cwd ? normalizedProjectPath(cwd) : "";
  const state = useScopedStore(projectChangesStore, scope);
  const apiRef = useRef(api);
  apiRef.current = api;

  const refresh = useCallback(() => {
    const current = apiRef.current;
    if (current?.cwd) void readChanges(current, current.cwd);
  }, []);

  useEffect(() => {
    if (visible && cwd) refresh();
  }, [visible, cwd, revision, refresh]);

  useEffect(() => {
    if (!visible || !cwd) return;
    const onFocus = () => { if (!document.hidden) refresh(); };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [visible, cwd, refresh]);

  const select = useCallback((selection: ChangeSelection | null) => {
    const current = apiRef.current;
    if (!current?.cwd) return;
    const target = normalizedProjectPath(current.cwd);
    if (!selection) {
      diffSequences.set(target, (diffSequences.get(target) ?? 0) + 1);
      projectChangesStore.update(target, { selected: null, diff: null, diffKey: null, diffError: null, diffLoading: false });
      return;
    }
    projectChangesStore.update(target, { selected: selection });
    void readDiff(current, target, current.cwd, selection);
  }, []);

  return { ...state, available: Boolean(api), refresh, select };
}
