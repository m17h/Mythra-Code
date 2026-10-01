import { useCallback, useEffect, useRef, useState } from "react";
import { formatGitError } from "../lib/errors";
import { normalizedProjectPath } from "../lib/paths";
import { acquirePullRequestMutation, releasePullRequestMutation } from "../lib/pullRequestOperations";
import { changeGitBranch, fetchGitWorkspace, getGitWorkspace, updateLocalGitBase, type GitWorkspaceSnapshot } from "../lib/gitWorkspace";

interface Options {
  cwd: string | null;
  projectPath: string | null;
  enabled: boolean;
  isolated: boolean;
  blocked: (paths: string[]) => string | null;
  onChanged?: () => void;
  confirmUpdate: (snapshot: GitWorkspaceSnapshot, base: string) => Promise<boolean>;
}
interface State {
  cwd: string | null;
  snapshot: GitWorkspaceSnapshot | null;
  busy: boolean;
  error: string;
  readError: string;
  notice: string;
  branchNotice: string;
  /** Successful reads, including reads whose summary did not change. */
  readRevision: number;
  lastFetchedAt?: number;
}
const empty = (cwd: string | null): State => ({ cwd, snapshot: null, busy: false, error: "", readError: "", notice: "", branchNotice: "", readRevision: 0 });

/** The checkout is the scope: thread navigation must never retarget a Git action. */
export function useGitWorkspace(options: Options) {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const viewerRef = useRef({ cwd: options.cwd, projectPath: options.projectPath, enabled: options.enabled, isolated: options.isolated, generation: 0 });
  const viewer = viewerRef.current;
  if (viewer.cwd !== options.cwd || viewer.projectPath !== options.projectPath
    || viewer.enabled !== options.enabled || viewer.isolated !== options.isolated) {
    viewerRef.current = { cwd: options.cwd, projectPath: options.projectPath, enabled: options.enabled, isolated: options.isolated, generation: viewer.generation + 1 };
  }
  const [state, setState] = useState<State>(() => empty(options.cwd));
  const stateRef = useRef(state);
  stateRef.current = state;
  const generation = useRef(0);
  const mounted = useRef(true);
  const readSequence = useRef(0);
  const successfulReads = useRef(0);
  const readsPending = useRef(new Map<string, { request: number; rerun: boolean; invalidated: boolean }>());
  const mutationsPending = useRef(new Set<string>());
  const update = useCallback((cwd: string, value: Partial<State>) => {
    if (!mounted.current || optionsRef.current.cwd !== cwd) return;
    setState((old) => {
      const next = { ...(old.cwd === cwd ? old : empty(cwd)), ...value, cwd };
      return JSON.stringify(old) === JSON.stringify(next) ? old : next;
    });
  }, []);
  const accept = useCallback((cwd: string, snapshot: GitWorkspaceSnapshot, value: Partial<State> = {}) => {
    if (!snapshot || !mounted.current || optionsRef.current.cwd !== cwd) return;
    const previous = stateRef.current.cwd === cwd ? stateRef.current.snapshot : null;
    const branchNotice = previous?.branch && previous.branch !== snapshot.branch
      ? `${optionsRef.current.isolated ? "This folder" : "The shared project"} moved from ${previous.branch} to ${snapshot.branch ?? "a detached commit"}.${optionsRef.current.isolated ? "" : " All shared threads use this branch."}`
      : stateRef.current.cwd === cwd ? stateRef.current.branchNotice : "";
    // Counts, HEAD and staging paths cannot reveal same-count content edits.
    // Consumers may lazily reread their selected preview after this signal.
    successfulReads.current += 1;
    update(cwd, { snapshot, branchNotice, readError: "", ...value, readRevision: successfulReads.current });
  }, [update]);

  const refresh = useCallback(async (invalidate = true) => {
    const { cwd, enabled } = optionsRef.current;
    const scope = cwd ? normalizedProjectPath(cwd) : "";
    if (!mounted.current || !cwd || !enabled || mutationsPending.current.has(scope)) return;
    const pending = readsPending.current.get(scope);
    if (pending) {
      // App mutations also call refresh when they settle. A read started before
      // that operation must not overwrite its result with pre-operation state.
      // Coalesce further requests until the pending read finishes.
      pending.rerun = true;
      if (invalidate && !pending.invalidated) {
        pending.invalidated = true;
        generation.current += 1;
      }
      return;
    }
    const revision = generation.current;
    const request = readSequence.current += 1;
    const entry = { request, rerun: false, invalidated: false };
    readsPending.current.set(scope, entry);
    try {
      const snapshot = await getGitWorkspace(cwd);
      if (revision === generation.current) accept(cwd, snapshot, { error: "" });
    } catch (error) {
      if (revision === generation.current) update(cwd, { readError: formatGitError(error) });
    } finally {
      if (readsPending.current.get(scope) === entry) {
        readsPending.current.delete(scope);
        if (entry.rerun || revision !== generation.current) {
          window.setTimeout(() => {
            // Navigation or another refresh can supersede this scheduled read.
            // Never retry an old checkout or invalidate a newer pending read.
            if (mounted.current && optionsRef.current.enabled && optionsRef.current.cwd
              && normalizedProjectPath(optionsRef.current.cwd) === scope
              && !readsPending.current.has(scope)) void refresh(false);
          }, 0);
        }
      }
    }
  }, [accept, update]);

  useEffect(() => {
    generation.current += 1;
    void refresh(false);
    if (!options.enabled) return;
    const timer = window.setInterval(() => { if (!document.hidden) void refresh(false); }, 10_000);
    const focus = () => void refresh(false);
    window.addEventListener("focus", focus);
    return () => { generation.current += 1; window.clearInterval(timer); window.removeEventListener("focus", focus); };
  }, [options.cwd, options.enabled, refresh]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; generation.current += 1; }; }, []);

  const mutate = useCallback(async (operation: (captured: Options) => Promise<boolean>): Promise<boolean> => {
    const captured = optionsRef.current;
    if (!captured.cwd) return false;
    const scope = normalizedProjectPath(captured.cwd);
    if (mutationsPending.current.has(scope)) return false;
    const paths = [...new Set([captured.cwd, captured.projectPath].filter((p): p is string => !!p).map(normalizedProjectPath))];
    const reason = captured.blocked(paths);
    if (reason) { update(captured.cwd, { error: reason }); return false; }
    const leases: string[] = [];
    for (const path of paths) {
      const lease = acquirePullRequestMutation(path);
      if (!lease) {
        leases.forEach(releasePullRequestMutation);
        update(captured.cwd, { error: "Wait for the current Git operation to finish." });
        return false;
      }
      leases.push(lease);
    }
    mutationsPending.current.add(scope);
    generation.current += 1;
    update(captured.cwd, { busy: true, error: "", notice: "" });
    let changed = false;
    let failed = false;
    try { changed = await operation(captured); }
    catch (error) { failed = true; update(captured.cwd, { error: formatGitError(error) }); }
    finally {
      leases.forEach(releasePullRequestMutation);
      mutationsPending.current.delete(scope);
      update(captured.cwd, { busy: false });
      if (changed && optionsRef.current.cwd === captured.cwd) captured.onChanged?.();
      if (!failed) void refresh();
    }
    return changed && !failed;
  }, [refresh, update]);

  const onBranch = useCallback((name: string, create: boolean) => mutate(async (captured) => {
    const cwd = captured.cwd!;
    if (captured.isolated) throw new Error("This isolated thread keeps its own branch. Use a shared project thread to create or switch branches.");
    const before = stateRef.current.cwd === cwd && stateRef.current.snapshot ? stateRef.current.snapshot : await getGitWorkspace(cwd);
    if (!before?.headOid || !before.branch) throw new Error("Create an initial commit and use a named branch first.");
    const next = await changeGitBranch(cwd, name.trim(), create, before.headOid, before.branch);
    accept(cwd, next, { notice: `${create ? "Created" : "Switched to"} local branch ${next.branch}. All shared threads now use it.` });
    return true;
  }), [accept, mutate]);

  const fetch = useCallback(async () => {
    await mutate(async (captured) => {
      const next = await fetchGitWorkspace(captured.cwd!);
      accept(captured.cwd!, next, { lastFetchedAt: Date.now(), notice: "Remote status refreshed. Your working files are unchanged." });
      return true;
    });
  }, [accept, mutate]);

  const updateBase = useCallback(async (repository: string, base: string) => {
    const intent = viewerRef.current.generation;
    const stillSelected = () => mounted.current && optionsRef.current.enabled && viewerRef.current.generation === intent;
    if (!stillSelected()) return;
    await mutate(async (captured) => {
      const path = captured.projectPath || captured.cwd!;
      const before = await getGitWorkspace(path);
      if (!stillSelected()) return false;
      if (!before.headOid || !before.branch) throw new Error("The local project needs a named branch and an initial commit before updating.");
      if (!await captured.confirmUpdate(before, base)) return false;
      if (!stillSelected()) return false;
      const reason = optionsRef.current.blocked([...new Set(
        [captured.cwd, captured.projectPath]
          .filter((value): value is string => Boolean(value))
          .map(normalizedProjectPath),
      )]);
      if (reason) throw new Error(reason);
      const next = await updateLocalGitBase(path, repository, base, before.headOid, before.branch);
      if (path === captured.cwd) accept(path, next);
      update(captured.cwd!, { lastFetchedAt: Date.now(), notice: `Local project updated to ${base} from GitHub.${captured.isolated ? " This isolated thread stays in its own folder." : " Shared threads now use this branch."}` });
      return true;
    });
  }, [accept, mutate, update]);

  return { ...(state.cwd === options.cwd ? state : empty(options.cwd)),
    busy: Boolean(options.cwd && mutationsPending.current.has(normalizedProjectPath(options.cwd))),
    refresh, onBranch, fetch, updateBase };
}
