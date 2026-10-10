import { useCallback, useEffect, useRef } from "react";
import { formatGitError } from "../lib/errors";
import { normalizedProjectPath } from "../lib/paths";
import { changeKey } from "../lib/gitChanges";
import type { GitChangeArea, ProjectGitChanges, ProjectGitFileDiff } from "../lib/gitInspection";
import type { ProjectGitInspection } from "../lib/projectGit";
import type { GitWorkspaceSnapshot } from "../lib/gitWorkspace";
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

const reads = new Map<string, { rerun: boolean; superseded: boolean }>();
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

function acceptChanges(api: ProjectGitInspection, cwd: string, changes: ProjectGitChanges) {
  const scope = normalizedProjectPath(cwd);
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
}

async function readChanges(api: ProjectGitInspection, cwd: string) {
  const scope = normalizedProjectPath(cwd);
  const pending = reads.get(scope);
  if (pending) { pending.rerun = true; return; }
  const entry = { rerun: false, superseded: false };
  reads.set(scope, entry);
  projectChangesStore.update(scope, { loading: true });
  try {
    const changes = await api.getChanges(cwd);
    if (entry.superseded) return;
    if (!changes || !Array.isArray(changes.rows)) throw new Error("Git returned no Changes list for this folder.");
    acceptChanges(api, cwd, changes);
  } catch (error) {
    if (!entry.superseded) projectChangesStore.update(scope, { loading: false, error: formatGitError(error) });
  } finally {
    reads.delete(scope);
    if (entry.rerun && !entry.superseded) void readChanges(api, cwd);
  }
}

/**
 * The checkout's staged, unstaged and new files, read only while the Changes
 * view is on screen. `revision` includes the owner's successful-read revision,
 * not only summary metadata: content edits can leave all counts unchanged.
 * Owner refreshes and busy transitions reach the list without another poller.
 */
export function useProjectGitChanges(
  api: ProjectGitInspection | undefined,
  visible: boolean,
  revision: string,
  workspace?: { snapshot: GitWorkspaceSnapshot | null; onRefresh: () => void; onRefreshIfIdle?: (observedRevision?: number) => void; readRevision?: number; readError?: string },
) {
  const cwd = api?.cwd ?? "";
  const scope = cwd ? normalizedProjectPath(cwd) : "";
  const state = useScopedStore(projectChangesStore, scope);
  const apiRef = useRef(api);
  apiRef.current = api;
  const workspaceRef = useRef(workspace);
  workspaceRef.current = workspace;
  const shared = workspace?.snapshot?.changes;
  // An omitted list belongs to older runtimes and can be read separately.
  // An explicit failure is authoritative; rescanning cannot make those
  // filenames safe and cached rows must not retain per-file controls.
  const sharedError = workspace?.snapshot?.changesError
    || (shared === null ? "Git returned no Changes list for this folder." : null);
  const waitingForOwner = Boolean(workspace && !workspace.snapshot);

  const refresh = useCallback(() => {
    const current = apiRef.current;
    const owner = workspaceRef.current;
    if (owner) owner.onRefresh();
    else if (current?.cwd) void readChanges(current, current.cwd);
  }, []);

  useEffect(() => {
    if (!cwd || !api) return;
    if (sharedError) {
      const pending = reads.get(scope);
      if (pending) pending.superseded = true;
      diffSequences.set(scope, (diffSequences.get(scope) ?? 0) + 1);
      projectChangesStore.update(scope, {
        changes: null, loading: false, error: sharedError, loadedAt: null,
        selected: null, diff: null, diffKey: null, diffLoading: false, diffError: null,
      });
      return;
    }
    if (!visible) return;
    if (shared) {
      const pending = reads.get(scope);
      if (pending) pending.superseded = true;
      acceptChanges(api, cwd, shared);
    } else if (!waitingForOwner) void readChanges(api, cwd);
  }, [visible, cwd, revision, api, shared, sharedError, waitingForOwner, scope]);

  useEffect(() => {
    if (!visible || !cwd) return;
    let disposed = false;
    const observedRevision = workspaceRef.current?.readRevision;
    // Parent mount/enable effects start the owner's read. Let those run before
    // requesting current rows so an initial open shares that pending request.
    void Promise.resolve().then(() => {
      if (!disposed) workspaceRef.current?.onRefreshIfIdle?.(observedRevision);
    });
    return () => { disposed = true; };
  }, [visible, cwd]);

  useEffect(() => {
    // The workspace owner already listens for focus. A second listener would
    // queue another snapshot and reread the selected diff twice.
    if (!visible || !cwd || workspace) return;
    const onFocus = () => { if (!document.hidden) refresh(); };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [visible, cwd, refresh, workspace]);

  const select = useCallback((selection: ChangeSelection | null) => {
    const current = apiRef.current;
    if (!current?.cwd) return;
    const ownerSnapshot = workspaceRef.current?.snapshot;
    if (selection && (ownerSnapshot?.changesError || ownerSnapshot?.changes === null)) return;
    const target = normalizedProjectPath(current.cwd);
    if (!selection) {
      diffSequences.set(target, (diffSequences.get(target) ?? 0) + 1);
      projectChangesStore.update(target, { selected: null, diff: null, diffKey: null, diffError: null, diffLoading: false });
      return;
    }
    projectChangesStore.update(target, { selected: selection });
    void readDiff(current, target, current.cwd, selection);
  }, []);

  return { ...state,
    ...(sharedError ? { changes: null, selected: null, diff: null, diffKey: null, diffLoading: false, diffError: null, loadedAt: null } : {}),
    loading: !sharedError && (waitingForOwner && !workspace?.readError || state.loading),
    error: sharedError || workspace?.readError || state.error, available: Boolean(api), refresh, select };
}
