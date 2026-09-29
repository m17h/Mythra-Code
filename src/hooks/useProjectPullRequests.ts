import { useCallback, useEffect, useRef } from "react";
import { formatGitError } from "../lib/errors";
import { normalizedProjectPath } from "../lib/paths";
import { acquirePullRequestMutation, releasePullRequestMutation } from "../lib/pullRequestOperations";
import { createPullRequestCreationDraftStore } from "../lib/pullRequestCreationDrafts";
import type {
  CreatePullRequestInput,
  PullRequest,
  PullRequestContext,
  PullRequestListState,
  PullRequestMergeMethod,
  PullRequestSummary,
} from "../lib/pullRequests";
import type { ProjectPullRequestAccess } from "../lib/projectGit";
import { createScopedStore, useScopedStore } from "../lib/scopedStore";

export const PULL_REQUEST_PAGE = 30;
const STALE_MS = 60_000;

export interface PullRequestRef { repository: string; number: number }
export interface ConfirmedPullRequest extends PullRequestRef { headOid: string }

export interface ProjectPullRequestState {
  query: string;
  appliedQuery: string;
  filter: PullRequestListState;
  items: PullRequestSummary[] | null;
  /** The query the items answer, so a changed search never shows old rows as its own. */
  itemsQuery: string | null;
  listLoading: boolean;
  listError: string | null;
  listAt: number | null;
  selected: PullRequestRef | null;
  /** Navigation intent is independent of read freshness, including same-target reselection. */
  selectionRevision: number;
  detail: PullRequest | null;
  detailLoading: boolean;
  detailError: string | null;
  detailAt: number | null;
  context: PullRequestContext | null;
  contextLoading: boolean;
  contextError: string | null;
  contextAt: number | null;
  /** A pull request found for the checkout's current branch. Found, not attached. */
  branchPullRequest: PullRequest | null;
  busy: boolean;
  operationLabel: string | null;
  error: string | null;
  notice: string | null;
}

export const projectPullRequestStore = createScopedStore<ProjectPullRequestState>({
  query: "", appliedQuery: "", filter: "open", items: null, itemsQuery: null, listLoading: false, listError: null, listAt: null,
  selected: null, selectionRevision: 0, detail: null, detailLoading: false, detailError: null, detailAt: null,
  context: null, contextLoading: false, contextError: null, contextAt: null, branchPullRequest: null,
  busy: false, operationLabel: null, error: null, notice: null,
});

/** Session-only creation text for project-owned pull requests, per checkout. */
export const projectPullRequestDrafts = createPullRequestCreationDraftStore(64);

export function projectPullRequestScope(cwd: string, repository: string | null): string {
  return `${normalizedProjectPath(cwd)}\0${(repository ?? "").toLowerCase()}`;
}

export const projectPullRequestListKey = (query: string, filter: PullRequestListState) => JSON.stringify([query.trim(), filter]);
const sameTarget = (left: PullRequestRef | null, right: PullRequestRef | null) => Boolean(left && right
  && left.repository.toLowerCase() === right.repository.toLowerCase() && left.number === right.number);
const sequences = new Map<string, number>();
function nextSequence(key: string): number {
  const value = (sequences.get(key) ?? 0) + 1;
  sequences.set(key, value);
  return value;
}
const current = (key: string, value: number) => sequences.get(key) === value;

/** A write supersedes every read already started, including reads made while it was busy. */
function invalidateReads(scope: string) {
  for (const read of ["list", "detail", "context"]) nextSequence(`${scope}\0${read}`);
}

async function readList(access: ProjectPullRequestAccess, scope: string, query: string, filter: PullRequestListState) {
  const repository = access.repository;
  if (!repository || !access.authenticated) return;
  const sequence = nextSequence(`${scope}\0list`);
  projectPullRequestStore.update(scope, { listLoading: true, listError: null });
  try {
    const items = await access.list(access.projectPath, repository, { search: query.trim() || undefined, state: filter, limit: PULL_REQUEST_PAGE });
    if (!current(`${scope}\0list`, sequence)) return;
    if (!Array.isArray(items)) throw new Error("GitHub returned no pull request list.");
    projectPullRequestStore.update(scope, { items, itemsQuery: projectPullRequestListKey(query, filter), listLoading: false, listAt: Date.now() });
  } catch (error) {
    if (!current(`${scope}\0list`, sequence)) return;
    projectPullRequestStore.update(scope, { listLoading: false, listError: formatGitError(error) });
  }
}

async function readDetail(access: ProjectPullRequestAccess, scope: string, target: PullRequestRef) {
  const sequence = nextSequence(`${scope}\0detail`);
  projectPullRequestStore.update(scope, (state) => ({
    detailLoading: true,
    detailError: null,
    detail: state.detail && state.detail.repository === target.repository && state.detail.number === target.number ? state.detail : null,
  }));
  try {
    const detail = await access.view(access.projectPath, target.repository, target.number);
    if (!current(`${scope}\0detail`, sequence)) return;
    if (!detail || !sameTarget(detail, target)) throw new Error("GitHub returned a different pull request. Refresh its status before trying again.");
    projectPullRequestStore.update(scope, { detail, detailLoading: false, detailAt: Date.now() });
  } catch (error) {
    if (!current(`${scope}\0detail`, sequence)) return;
    projectPullRequestStore.update(scope, { detailLoading: false, detailError: formatGitError(error) });
  }
}

/** Publish into the originating checkout, never into a later selection or read generation. */
function finishMutation(access: ProjectPullRequestAccess, scope: string, notice: string | null, result?: PullRequest, selectCreated = false) {
  invalidateReads(scope);
  projectPullRequestStore.update(scope, (state) => {
    const selected = selectCreated && result ? { repository: result.repository, number: result.number } : state.selected;
    const showResult = result && sameTarget(selected, result);
    const itemsMatch = state.itemsQuery === projectPullRequestListKey(state.appliedQuery, state.filter);
    const matchesFilter = !result || state.filter === "all" || result.state.toLowerCase() === state.filter;
    const branchMatches = result && state.context?.repository.toLowerCase() === result.repository.toLowerCase()
      && state.context.branch === result.headRefName;
    return {
      selected,
      selectionRevision: state.selectionRevision + (selectCreated ? 1 : 0),
      ...(showResult ? { detail: result, detailAt: Date.now(), detailError: null } : {}),
      ...(result && itemsMatch && state.items ? { items: state.items.flatMap((item) => !sameTarget(item, result) ? [item]
        : matchesFilter ? [{ ...item, title: result.title, url: result.url, state: result.state, isDraft: result.isDraft,
          headRefName: result.headRefName, baseRefName: result.baseRefName, updatedAt: result.updatedAt }] : []) } : {}),
      ...(branchMatches ? { branchPullRequest: result.state === "OPEN" ? result : null } : {}),
      listLoading: false, detailLoading: false, contextLoading: false,
      listAt: null, contextAt: null,
      ...(notice ? { notice } : {}),
    };
  });
  const saved = projectPullRequestStore.get(scope);
  void readList(access, scope, saved.appliedQuery, saved.filter);
  void readContext(access, scope);
  // The user may be waiting on a different PR's now-invalidated read. Resume it,
  // but never reread the just-written target over its authoritative result.
  if (saved.selected && (!result || !sameTarget(saved.selected, result))) void readDetail(access, scope, saved.selected);
}

function requireConfirmedTarget(scope: string, confirmed: ConfirmedPullRequest) {
  const saved = projectPullRequestStore.get(scope);
  if (!sameTarget(saved.selected, confirmed) || !sameTarget(saved.detail, confirmed) || saved.detail?.headOid !== confirmed.headOid) {
    throw new Error("The selected pull request changed. Review its current details before trying again.");
  }
}

async function readContext(access: ProjectPullRequestAccess, scope: string) {
  if (!access.authenticated) return;
  const sequence = nextSequence(`${scope}\0context`);
  projectPullRequestStore.update(scope, { contextLoading: true, contextError: null });
  try {
    const context = await access.context(access.cwd);
    if (!current(`${scope}\0context`, sequence)) return;
    if (!context || typeof context.branch !== "string") throw new Error("Mythra Code could not read this checkout's pull request context.");
    projectPullRequestStore.update(scope, (saved) => ({
      context,
      // Discovery belongs to the branch/repository that produced it, not a
      // newer context whose lookup is still pending or may fail.
      branchPullRequest: saved.branchPullRequest
        && saved.branchPullRequest.repository.toLowerCase() === context.repository.toLowerCase()
        && saved.branchPullRequest.headRefName === context.branch ? saved.branchPullRequest : null,
    }));
    const branchPullRequest = (await access.find(access.cwd, context.repository, context.branch)) ?? null;
    if (!current(`${scope}\0context`, sequence)) return;
    projectPullRequestStore.update(scope, { branchPullRequest, contextLoading: false, contextAt: Date.now() });
  } catch (error) {
    if (!current(`${scope}\0context`, sequence)) return;
    projectPullRequestStore.update(scope, { contextLoading: false, contextError: formatGitError(error) });
  }
}

/**
 * Project-owned pull requests: browse, inspect, and — without any AI thread —
 * create or merge through the same validated native commands and operation
 * leases the conversation workflow uses. Nothing here attaches or archives.
 */
export function useProjectPullRequests(access: ProjectPullRequestAccess | undefined, visible: boolean) {
  const scope = access ? projectPullRequestScope(access.cwd, access.repository) : "";
  const state = useScopedStore(projectPullRequestStore, scope);
  const accessRef = useRef(access);
  accessRef.current = access;
  const viewerRef = useRef({ scope, visible, threadActive: access?.threadActive, mounted: true, generation: 0 });
  const viewer = viewerRef.current;
  if (viewer.scope !== scope || viewer.visible !== visible || viewer.threadActive !== access?.threadActive) {
    viewerRef.current = { scope, visible, threadActive: access?.threadActive, mounted: viewer.mounted, generation: viewer.generation + 1 };
  }
  useEffect(() => {
    viewerRef.current.mounted = true;
    return () => { viewerRef.current.mounted = false; viewerRef.current.generation += 1; };
  }, []);
  const ready = Boolean(access?.authenticated && access.repository);

  useEffect(() => {
    const latest = accessRef.current;
    if (!visible || !latest || !ready) return;
    const saved = projectPullRequestStore.get(scope);
    const now = Date.now();
    if (!saved.contextLoading && (!saved.contextAt || now - saved.contextAt > STALE_MS)) void readContext(latest, scope);
    if (!saved.listLoading && (!saved.listAt || now - saved.listAt > STALE_MS)) void readList(latest, scope, saved.appliedQuery, saved.filter);
    if (saved.selected && !saved.detailLoading && (!saved.detailAt || now - saved.detailAt > STALE_MS)) void readDetail(latest, scope, saved.selected);
  }, [visible, ready, scope]);

  const search = useCallback((query: string, filter: PullRequestListState) => {
    const latest = accessRef.current;
    if (!latest) return;
    const target = projectPullRequestScope(latest.cwd, latest.repository);
    projectPullRequestStore.update(target, { query, appliedQuery: query.trim(), filter });
    void readList(latest, target, query, filter);
  }, []);

  const retryList = useCallback(() => {
    const latest = accessRef.current;
    if (!latest) return;
    const target = projectPullRequestScope(latest.cwd, latest.repository);
    const saved = projectPullRequestStore.get(target);
    void readList(latest, target, saved.appliedQuery, saved.filter);
  }, []);

  const setQuery = useCallback((query: string) => {
    const latest = accessRef.current;
    if (latest) projectPullRequestStore.update(projectPullRequestScope(latest.cwd, latest.repository), { query });
  }, []);

  const select = useCallback((target: PullRequestRef | null) => {
    const latest = accessRef.current;
    if (!latest) return;
    const key = projectPullRequestScope(latest.cwd, latest.repository);
    if (!target) {
      nextSequence(`${key}\0detail`);
      projectPullRequestStore.update(key, (saved) => ({ selected: null, selectionRevision: saved.selectionRevision + 1,
        detail: null, detailError: null, detailLoading: false, notice: null, error: null }));
      return;
    }
    projectPullRequestStore.update(key, (saved) => ({ selected: target, selectionRevision: saved.selectionRevision + 1, notice: null, error: null }));
    void readDetail(latest, key, target);
  }, []);

  const refresh = useCallback(() => {
    const latest = accessRef.current;
    if (!latest) return;
    const key = projectPullRequestScope(latest.cwd, latest.repository);
    const saved = projectPullRequestStore.get(key);
    void readContext(latest, key);
    void readList(latest, key, saved.appliedQuery, saved.filter);
    if (saved.selected) void readDetail(latest, key, saved.selected);
  }, []);

  const refreshDetail = useCallback(() => {
    const latest = accessRef.current;
    if (!latest) return;
    const key = projectPullRequestScope(latest.cwd, latest.repository);
    const saved = projectPullRequestStore.get(key);
    if (saved.selected) void readDetail(latest, key, saved.selected);
  }, []);

  const refreshContext = useCallback(() => {
    const latest = accessRef.current;
    if (latest) void readContext(latest, projectPullRequestScope(latest.cwd, latest.repository));
  }, []);

  /** Every write holds the same per-folder lease as Git and thread PR actions. */
  const mutate = useCallback(async <T,>(expectedScope: string, operationLabel: string,
    operation: (access: ProjectPullRequestAccess, key: string, intent: number, viewerGeneration: number) => Promise<T>): Promise<T> => {
    const captured = accessRef.current;
    if (!captured) throw new Error("Open a project first.");
    const key = expectedScope;
    const fail = (message: string): never => {
      projectPullRequestStore.update(key, { error: message });
      throw new Error(message);
    };
    if (!viewerRef.current.mounted || projectPullRequestScope(captured.cwd, captured.repository) !== key) fail("The selected checkout changed. Review its current details before trying again.");
    if (!captured.authenticated) fail("Connect your GitHub account before changing a pull request.");
    const blocked = captured.mutationBlockedReason ?? captured.checkMutationAllowed(captured.cwd);
    if (blocked) fail(blocked);
    const leases: string[] = [];
    for (const path of [...new Set([captured.cwd, captured.projectPath].map(normalizedProjectPath))]) {
      const lease = acquirePullRequestMutation(path);
      if (!lease) {
        leases.forEach(releasePullRequestMutation);
        fail("Wait for the current Git operation to finish.");
      }
      leases.push(lease!);
    }
    const intent = projectPullRequestStore.get(key).selectionRevision;
    const viewerGeneration = viewerRef.current.generation;
    projectPullRequestStore.update(key, { busy: true, operationLabel, error: null, notice: null });
    try {
      const latest = captured.checkMutationAllowed(captured.cwd);
      if (latest) throw new Error(latest);
      return await operation(captured, key, intent, viewerGeneration);
    } catch (error) {
      // A rejected native request can have partially changed remote/local state.
      // Its older reads must not win either; errors still belong to this checkout.
      finishMutation(captured, key, null);
      projectPullRequestStore.update(key, { error: formatGitError(error) });
      throw error;
    } finally {
      leases.forEach(releasePullRequestMutation);
      projectPullRequestStore.update(key, { busy: false, operationLabel: null });
    }
  }, []);

  const create = useCallback((input: CreatePullRequestInput) => mutate(scope, "Creating a pull request…", async (captured, key, intent, viewerGeneration) => {
    if (captured.threadActive) throw new Error("Use this conversation's pull request workflow to create its pull request.");
    const context = projectPullRequestStore.get(key).context;
    if (!context) throw new Error("Refresh pull request status before creating a pull request.");
    if (context.branch !== input.head || context.headOid !== input.expectedHeadOid) throw new Error("The checkout changed. Review its current details before creating a pull request.");
    const result = await captured.create(captured.cwd, context.repository, { ...input });
    if (!result || result.repository.toLowerCase() !== context.repository.toLowerCase()
      || result.headRefName !== input.head || result.baseRefName !== input.base) {
      throw new Error("GitHub returned a different pull request. Refresh its status before trying again.");
    }
    const notice = result.creationOutcome === "existing"
      ? `Found existing pull request #${result.number}. Nothing was committed or pushed.`
      : result.creationOutcome === "updated"
        ? `Pushed the branch and found existing pull request #${result.number}.`
        : `Created pull request #${result.number}.`;
    const currentViewer = viewerRef.current;
    const canSelect = currentViewer.mounted && currentViewer.visible && currentViewer.scope === key
      && currentViewer.generation === viewerGeneration && projectPullRequestStore.get(key).selectionRevision === intent;
    finishMutation(captured, key, `${notice} It is not attached to any conversation.`, result, canSelect);
    captured.onChanged?.(captured.cwd);
  }), [mutate, scope]);

  const merge = useCallback((method: PullRequestMergeMethod, auto: boolean, confirmed: ConfirmedPullRequest) => mutate(scope, `Merging #${confirmed.number} on GitHub…`, async (captured, key) => {
    requireConfirmedTarget(key, confirmed);
    const result = await captured.merge(captured.projectPath, confirmed.repository, confirmed.number, method, confirmed.headOid, auto);
    if (!sameTarget(result, confirmed)) {
      throw new Error("GitHub returned a different pull request. Refresh its status before trying again.");
    }
    const notice = result.state === "MERGED"
        ? `Pull request #${result.number} merged on GitHub. Your local folder is unchanged.`
        : auto ? `GitHub will merge pull request #${result.number} when its requirements pass. Not merged yet.` : `Merge requested for pull request #${result.number}; it remains open.`;
    finishMutation(captured, key, notice, result);
    captured.onChanged?.(captured.cwd);
  }), [mutate, scope]);

  const markReady = useCallback((confirmed: ConfirmedPullRequest) => mutate(scope, `Marking #${confirmed.number} ready for review…`, async (captured, key) => {
    requireConfirmedTarget(key, confirmed);
    const result = await captured.ready(captured.projectPath, confirmed.repository, confirmed.number, confirmed.headOid);
    if (!sameTarget(result, confirmed)) throw new Error("GitHub returned a different pull request. Refresh its status before trying again.");
    finishMutation(captured, key, `Pull request #${result.number} is ready for review.`, result);
    captured.onChanged?.(captured.cwd);
  }), [mutate, scope]);

  const createBranch = useCallback((name: string) => mutate(scope, `Creating branch ${name}…`, async (captured, key) => {
    if (captured.isolated) throw new Error("Branch creation is only available in the shared project folder.");
    const context = projectPullRequestStore.get(key).context;
    if (!context) throw new Error("Refresh pull request status before creating a branch.");
    await captured.createBranch(captured.cwd, name, context.headOid);
    finishMutation(captured, key, `Created branch ${name}. Every thread using this folder moves to it too.`);
    captured.onChanged?.(captured.cwd);
  }), [mutate, scope]);

  return {
    ...state,
    scope,
    ready,
    search,
    retryList,
    setQuery,
    select,
    refresh,
    refreshDetail,
    refreshContext,
    create,
    merge,
    markReady,
    createBranch,
  };
}
