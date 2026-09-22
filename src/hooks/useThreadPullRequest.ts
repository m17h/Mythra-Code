import { useCallback, useEffect, useRef, useState } from "react";
import { friendlyError } from "../lib/errors";
import { normalizedProjectPath } from "../lib/paths";
import { acquirePullRequestMutation, releasePullRequestMutation } from "../lib/pullRequestOperations";
import {
  createPullRequest,
  createPullRequestBranch,
  findPullRequest,
  getPullRequest,
  getPullRequestContext,
  mergePullRequest,
  markPullRequestReady,
  parsePullRequestReference,
  type CreatePullRequestInput,
  type PullRequest,
  type PullRequestContext,
  type PullRequestMergeMethod,
  type ThreadPullRequestLink,
} from "../lib/pullRequests";
import { usePersistedStateRef } from "./usePersistedState";

const REFRESH_MS = 60_000;
const CACHE_LIMIT = 64;
const viewCache = new Map<string, { value: PullRequest; at: number }>();
const viewRequests = new Map<string, Promise<PullRequest>>();
const viewGenerations = new Map<string, { generation: number; active: number }>();
function cacheKey(cwd: string, repository: string, number: number) {
  return `${normalizedProjectPath(cwd)}\0${repository.toLowerCase()}#${number}`;
}

async function cachedPullRequest(cwd: string, repository: string, number: number, force = false) {
  const key = cacheKey(cwd, repository, number);
  const cached = viewCache.get(key);
  if (!force && cached && Date.now() - cached.at < REFRESH_MS) return cached.value;
  const pending = viewRequests.get(key);
  if (pending) return pending;
  if (viewRequests.size >= CACHE_LIMIT) throw new Error("Too many pull request status reads are already running.");
  const generationState = viewGenerations.get(key) ?? { generation: 0, active: 0 };
  viewGenerations.set(key, generationState);
  const generation = generationState.generation;
  generationState.active += 1;
  const request = getPullRequest(cwd, repository, number).then((value) => {
    if (generationState.generation !== generation) throw new Error("Pull request status changed while this read was running.");
    viewCache.delete(key);
    viewCache.set(key, { value, at: Date.now() });
    while (viewCache.size > CACHE_LIMIT) viewCache.delete(viewCache.keys().next().value!);
    return value;
  }).finally(() => {
    if (viewRequests.get(key) === request) viewRequests.delete(key);
    generationState.active -= 1;
    if (generationState.active === 0 && viewGenerations.get(key) === generationState) viewGenerations.delete(key);
  });
  viewRequests.set(key, request);
  return request;
}

function invalidatePullRequest(cwd: string, repository: string, number: number) {
  const key = cacheKey(cwd, repository, number);
  const generationState = viewGenerations.get(key);
  if (generationState) generationState.generation += 1;
  viewCache.delete(key);
  viewRequests.delete(key);
}

export interface UseThreadPullRequestOptions {
  threadId: string | null;
  cwd: string | null;
  projectPath: string | null;
  isolated: boolean;
  enabled: boolean;
  visible: boolean;
  mutationBlockedReason: string | null;
  checkMutationAllowed: (cwd: string) => string | null;
  onChanged?: () => void;
}

interface Scoped<T> { scope: string; value: T }
const stateScope = (threadId: string, cwd: string | null) => `${threadId}\0${cwd ?? ""}`;
interface RefreshSnapshot {
  threadId: string;
  cwd: string | null;
  projectPath: string | null;
  enabled: boolean;
  visible: boolean;
}

export function useThreadPullRequest(options: UseThreadPullRequestOptions) {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const [links, setLinks, linksRef] = usePersistedStateRef<Record<string, ThreadPullRequestLink>>("kiwi.threadPullRequests", {});
  const [contextState, setContextState] = useState<Scoped<PullRequestContext | null> | null>(null);
  const [candidateState, setCandidateState] = useState<Scoped<PullRequest | null> | null>(null);
  const [loadingState, setLoadingState] = useState<Scoped<boolean> | null>(null);
  const [busyState, setBusyState] = useState<Scoped<boolean> | null>(null);
  const [errorState, setErrorState] = useState<Scoped<string | null> | null>(null);
  const [noticeState, setNoticeState] = useState<Scoped<string | null> | null>(null);
  const readRevisionsRef = useRef(new Map<string, number>());
  const mutationRevisionsRef = useRef(new Map<string, number>());
  const readSequenceRef = useRef(0);
  const mutationSequenceRef = useRef(0);
  const operationCountsRef = useRef(new Map<string, number>());
  const attachLocksRef = useRef(new Set<string>());
  const refreshRequestsRef = useRef(new Map<string, Promise<void>>());
  const forcedRefreshesRef = useRef(new Map<string, RefreshSnapshot>());
  const lastRefreshesRef = useRef(new Map<string, number>());
  const requestRefreshRef = useRef<(snapshot: RefreshSnapshot, force?: boolean) => void>(() => undefined);
  const contextCacheRef = useRef(new Map<string, PullRequestContext | null>());
  const candidateCacheRef = useRef(new Map<string, PullRequest | null>());

  const threadId = options.threadId;
  const currentScope = threadId ? stateScope(threadId, options.cwd) : "";
  const link = threadId ? links[threadId] ?? null : null;
  const linked = Boolean(link);
  const scopedContext = threadId && contextState?.scope === currentScope ? contextState.value : contextCacheRef.current.get(currentScope) ?? null;
  const scopedCandidate = threadId && candidateState?.scope === currentScope ? candidateState.value : candidateCacheRef.current.get(currentScope) ?? null;
  const pullRequest = link?.snapshot ?? scopedCandidate;

  const bumpReadRevision = useCallback((id: string) => {
    const next = readSequenceRef.current += 1;
    readRevisionsRef.current.set(id, next);
    return next;
  }, []);

  const rememberContext = useCallback((scope: string, value: PullRequestContext | null) => {
    contextCacheRef.current.delete(scope);
    contextCacheRef.current.set(scope, value);
    while (contextCacheRef.current.size > CACHE_LIMIT) contextCacheRef.current.delete(contextCacheRef.current.keys().next().value!);
    const current = optionsRef.current;
    if (current.threadId && stateScope(current.threadId, current.cwd) === scope) setContextState({ scope, value });
  }, []);

  const rememberCandidate = useCallback((scope: string, value: PullRequest | null) => {
    candidateCacheRef.current.delete(scope);
    candidateCacheRef.current.set(scope, value);
    while (candidateCacheRef.current.size > CACHE_LIMIT) candidateCacheRef.current.delete(candidateCacheRef.current.keys().next().value!);
    const current = optionsRef.current;
    if (current.threadId && stateScope(current.threadId, current.cwd) === scope) setCandidateState({ scope, value });
  }, []);

  const persistLink = useCallback((id: string, pullRequest: PullRequest, expectedMutationRevision?: number) => {
    if (expectedMutationRevision !== undefined && (mutationRevisionsRef.current.get(id) ?? 0) !== expectedMutationRevision) return false;
    setLinks((current) => ({
      ...current,
      [id]: {
        repository: pullRequest.repository,
        number: pullRequest.number,
        url: pullRequest.url,
        attachedAt: current[id]?.attachedAt ?? Date.now(),
        snapshot: pullRequest,
      },
    }));
    return true;
  }, [setLinks]);

  const refreshThread = useCallback(async (snapshot: RefreshSnapshot, force = false) => {
    if (!snapshot.enabled || !snapshot.visible) return;
    const currentLink = linksRef.current[snapshot.threadId];
    const readRevision = bumpReadRevision(snapshot.threadId);
    const uiScope = stateScope(snapshot.threadId, snapshot.cwd);
    setLoadingState({ scope: uiScope, value: true });
    setErrorState({ scope: uiScope, value: null });
    try {
      if (currentLink) {
        const paths = [snapshot.cwd, snapshot.projectPath].filter((value, index, all): value is string => Boolean(value) && all.indexOf(value) === index);
        if (!paths.length) return;
        const contextRequest = snapshot.cwd
          ? getPullRequestContext(snapshot.cwd).then((context) => {
            if (readRevisionsRef.current.get(snapshot.threadId) === readRevision) rememberContext(uiScope, context);
          }).catch(() => undefined)
          : Promise.resolve();
        let result: PullRequest | null = null;
        let failure: unknown;
        for (const path of paths) {
          try {
            result = await cachedPullRequest(path, currentLink.repository, currentLink.number, force);
            break;
          } catch (error) {
            failure = error;
            if (readRevisionsRef.current.get(snapshot.threadId) !== readRevision) return;
          }
        }
        if (!result) throw failure;
        if (readRevisionsRef.current.get(snapshot.threadId) !== readRevision) return;
        const latest = linksRef.current[snapshot.threadId];
        if (!latest || latest.repository !== currentLink.repository || latest.number !== currentLink.number) return;
        persistLink(snapshot.threadId, result);
        await contextRequest;
        return;
      }
      if (!snapshot.cwd) return;
      const context = await getPullRequestContext(snapshot.cwd);
      if (readRevisionsRef.current.get(snapshot.threadId) !== readRevision) return;
      rememberContext(uiScope, context);
      const candidate = await findPullRequest(snapshot.cwd, context.repository, context.branch);
      if (readRevisionsRef.current.get(snapshot.threadId) !== readRevision || linksRef.current[snapshot.threadId]) return;
      rememberCandidate(uiScope, candidate);
    } catch (error) {
      if (optionsRef.current.threadId && stateScope(optionsRef.current.threadId, optionsRef.current.cwd) === uiScope && readRevisionsRef.current.get(snapshot.threadId) === readRevision) {
        setErrorState({ scope: uiScope, value: friendlyError(error) });
      }
    } finally {
      if (optionsRef.current.threadId && stateScope(optionsRef.current.threadId, optionsRef.current.cwd) === uiScope && readRevisionsRef.current.get(snapshot.threadId) === readRevision) {
        setLoadingState({ scope: uiScope, value: false });
      }
      if (readRevisionsRef.current.get(snapshot.threadId) === readRevision) readRevisionsRef.current.delete(snapshot.threadId);
    }
  }, [bumpReadRevision, linksRef, persistLink, rememberCandidate, rememberContext]);

  const requestRefresh = useCallback((snapshot: RefreshSnapshot, force = false) => {
    if (!snapshot.enabled || !snapshot.visible) return;
    const key = stateScope(snapshot.threadId, snapshot.cwd);
    const lastRefresh = lastRefreshesRef.current.get(key);
    if (!force && lastRefresh !== undefined && Date.now() - lastRefresh < REFRESH_MS) return;
    const pending = refreshRequestsRef.current.get(key);
    if (pending) {
      if (force) forcedRefreshesRef.current.set(key, snapshot);
      return;
    }
    if (refreshRequestsRef.current.size >= CACHE_LIMIT) return;
    const request = refreshThread(snapshot, force).finally(() => {
      if (refreshRequestsRef.current.get(key) !== request) return;
      refreshRequestsRef.current.delete(key);
      lastRefreshesRef.current.set(key, Date.now());
      while (lastRefreshesRef.current.size > CACHE_LIMIT) lastRefreshesRef.current.delete(lastRefreshesRef.current.keys().next().value!);
      const queued = forcedRefreshesRef.current.get(key);
      if (!queued) return;
      forcedRefreshesRef.current.delete(key);
      requestRefreshRef.current(queued, true);
    });
    refreshRequestsRef.current.set(key, request);
  }, [refreshThread]);
  requestRefreshRef.current = requestRefresh;

  const refreshCurrent = useCallback((force = true) => {
    const current = optionsRef.current;
    if (!current.threadId) return;
    requestRefresh({ threadId: current.threadId, cwd: current.cwd, projectPath: current.projectPath, enabled: current.enabled, visible: current.visible }, force);
  }, [requestRefresh]);

  useEffect(() => {
    if (!threadId) return;
    if (!options.enabled || !options.visible) return;
    requestRefresh({ threadId, cwd: options.cwd, projectPath: options.projectPath, enabled: options.enabled, visible: options.visible });
  }, [threadId, options.cwd, options.projectPath, options.enabled, options.visible, requestRefresh]);

  useEffect(() => {
    if (!threadId || !linked || !options.enabled || !options.visible) return;
    const refresh = () => {
      if (document.visibilityState === "hidden") return;
      refreshCurrent(false);
    };
    const timer = window.setInterval(refresh, REFRESH_MS);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [threadId, linked, link?.repository, link?.number, options.enabled, options.visible, refreshCurrent]);

  const beginMutation = useCallback((cwd: string, id: string) => {
    const initial = optionsRef.current.mutationBlockedReason ?? optionsRef.current.checkMutationAllowed(cwd);
    if (initial) throw new Error(initial);
    const lockKey = acquirePullRequestMutation(cwd);
    if (!lockKey) throw new Error("A pull request action is already running for this project.");
    const revision = mutationRevisionsRef.current.get(id) ?? 0;
    operationCountsRef.current.set(id, (operationCountsRef.current.get(id) ?? 0) + 1);
    const uiScope = stateScope(id, cwd);
    const readRevision = bumpReadRevision(id);
    setBusyState({ scope: uiScope, value: true });
    setErrorState({ scope: uiScope, value: null });
    setNoticeState({ scope: uiScope, value: null });
    return { key: lockKey, revision, readRevision };
  }, [bumpReadRevision]);

  const runMutation = useCallback(async <T,>(id: string, cwd: string, operation: (revision: number) => Promise<T>) => {
    let lock: { key: string; revision: number; readRevision: number };
    try {
      lock = beginMutation(cwd, id);
    } catch (error) {
      setErrorState({ scope: stateScope(id, cwd), value: friendlyError(error) });
      throw error;
    }
    try {
      const latestBlock = optionsRef.current.checkMutationAllowed(cwd);
      if (latestBlock) throw new Error(latestBlock);
      return await operation(lock.revision);
    } catch (error) {
      setErrorState({ scope: stateScope(id, cwd), value: friendlyError(error) });
      throw error;
    } finally {
      releasePullRequestMutation(lock.key);
      if (readRevisionsRef.current.get(id) === lock.readRevision) readRevisionsRef.current.delete(id);
      const remaining = (operationCountsRef.current.get(id) ?? 1) - 1;
      if (remaining > 0) operationCountsRef.current.set(id, remaining);
      else {
        operationCountsRef.current.delete(id);
        mutationRevisionsRef.current.delete(id);
      }
      const uiScope = stateScope(id, cwd);
      setBusyState((current) => current?.scope === uiScope ? { scope: uiScope, value: false } : current);
    }
  }, [beginMutation]);

  const onAttach = useCallback(async (reference: string) => {
    const snapshot = optionsRef.current;
    if (!snapshot.threadId) throw new Error("No thread is selected.");
    const uiScope = stateScope(snapshot.threadId, snapshot.cwd);
    const currentContext = contextState?.scope === uiScope ? contextState.value : null;
    const parsed = parsePullRequestReference(reference, currentContext?.repository);
    if (!parsed) {
      const error = new Error("Enter a GitHub pull request URL or a number for this repository.");
      setErrorState({ scope: uiScope, value: error.message });
      throw error;
    }
    const executionCwd = snapshot.cwd ?? snapshot.projectPath;
    const nativeCwd = snapshot.projectPath ?? executionCwd;
    if (!executionCwd || !nativeCwd) throw new Error("This thread has no project path.");
    const lockKey = `${cacheKey(nativeCwd, parsed.repository, parsed.number)}\0attach`;
    if (attachLocksRef.current.has(lockKey)) throw new Error("This pull request is already being attached.");
    attachLocksRef.current.add(lockKey);
    operationCountsRef.current.set(snapshot.threadId, (operationCountsRef.current.get(snapshot.threadId) ?? 0) + 1);
    const revision = mutationRevisionsRef.current.get(snapshot.threadId) ?? 0;
    const readRevision = bumpReadRevision(snapshot.threadId);
    setBusyState({ scope: uiScope, value: true });
    setErrorState({ scope: uiScope, value: null });
    try {
      const pullRequest = await cachedPullRequest(nativeCwd, parsed.repository, parsed.number, true);
      if (persistLink(snapshot.threadId!, pullRequest, revision)) {
        setNoticeState({ scope: uiScope, value: `Attached pull request #${pullRequest.number}.` });
        snapshot.onChanged?.();
      }
    } catch (error) {
      setErrorState({ scope: uiScope, value: friendlyError(error) });
      throw error;
    } finally {
      attachLocksRef.current.delete(lockKey);
      if (readRevisionsRef.current.get(snapshot.threadId) === readRevision) readRevisionsRef.current.delete(snapshot.threadId);
      const remaining = (operationCountsRef.current.get(snapshot.threadId) ?? 1) - 1;
      if (remaining > 0) operationCountsRef.current.set(snapshot.threadId, remaining);
      else {
        operationCountsRef.current.delete(snapshot.threadId);
        mutationRevisionsRef.current.delete(snapshot.threadId);
      }
      setBusyState((current) => current?.scope === uiScope ? { scope: uiScope, value: false } : current);
    }
  }, [bumpReadRevision, contextState, persistLink]);

  const onDetach = useCallback(() => {
    const id = optionsRef.current.threadId;
    if (!id) return;
    bumpReadRevision(id);
    readRevisionsRef.current.delete(id);
    mutationRevisionsRef.current.set(id, mutationSequenceRef.current += 1);
    setLinks((current) => {
      if (!current[id]) return current;
      const next = { ...current };
      delete next[id];
      return next;
    });
    const uiScope = stateScope(id, optionsRef.current.cwd);
    rememberCandidate(uiScope, null);
    setNoticeState({ scope: uiScope, value: "Pull request detached." });
    optionsRef.current.onChanged?.();
    if (!operationCountsRef.current.has(id)) mutationRevisionsRef.current.delete(id);
  }, [bumpReadRevision, rememberCandidate, setLinks]);

  const onCreate = useCallback(async (input: CreatePullRequestInput) => {
    const snapshot = optionsRef.current;
    if (!snapshot.threadId || !snapshot.cwd) throw new Error("This thread has no working directory.");
    const uiScope = stateScope(snapshot.threadId, snapshot.cwd);
    const repository = contextState?.scope === uiScope ? contextState.value?.repository : null;
    if (!repository) throw new Error("Refresh pull request status before creating a pull request.");
    const id = snapshot.threadId;
    const cwd = snapshot.cwd;
    const capturedRepository = repository;
    await runMutation(id, cwd, async (revision) => {
      const pullRequest = await createPullRequest(cwd, capturedRepository, { ...input });
      if (!persistLink(id, pullRequest, revision)) return;
      const creationOutcome = "creationOutcome" in pullRequest ? pullRequest.creationOutcome : "created";
      const notice = creationOutcome === "existing"
        ? `Attached existing pull request #${pullRequest.number}. No local changes were committed or pushed. Use Push commits or Commit & push to update it.`
        : creationOutcome === "updated"
          ? `Pushed the branch and attached existing pull request #${pullRequest.number}.`
        : `Created and attached pull request #${pullRequest.number}.`;
      setNoticeState({ scope: uiScope, value: notice });
      snapshot.onChanged?.();
      try {
        const refreshed = await cachedPullRequest(cwd, pullRequest.repository, pullRequest.number, true);
        persistLink(id, refreshed, revision);
      } catch {
        // The create result remains the durable snapshot when the follow-up
        // status read is temporarily unavailable.
      }
    });
    requestRefresh({ threadId: id, cwd, projectPath: snapshot.projectPath, enabled: snapshot.enabled, visible: snapshot.visible }, true);
  }, [contextState, persistLink, requestRefresh, runMutation]);

  const onMerge = useCallback(async (method: PullRequestMergeMethod, auto: boolean) => {
    const snapshot = optionsRef.current;
    if (!snapshot.threadId) throw new Error("No thread is selected.");
    const stored = linksRef.current[snapshot.threadId];
    if (!stored) throw new Error("Attach a pull request before merging.");
    const cwd = snapshot.cwd ?? snapshot.projectPath;
    const nativeCwd = snapshot.projectPath ?? cwd;
    if (!cwd || !nativeCwd) throw new Error("This thread has no project path.");
    const id = snapshot.threadId;
    const uiScope = stateScope(id, snapshot.cwd);
    await runMutation(id, cwd, async (revision) => {
      invalidatePullRequest(nativeCwd, stored.repository, stored.number);
      if (nativeCwd !== cwd) invalidatePullRequest(cwd, stored.repository, stored.number);
      const result = await mergePullRequest(nativeCwd, stored.repository, stored.number, method, stored.snapshot.headOid, auto);
      if (!persistLink(id, result, revision)) return;
      const message = result.state === "MERGED"
        ? `Pull request #${result.number} merged.`
        : auto ? `Auto-merge queued for pull request #${result.number}.` : `Merge requested for pull request #${result.number}; it remains open.`;
      setNoticeState({ scope: uiScope, value: message });
      snapshot.onChanged?.();
    });
  }, [linksRef, persistLink, runMutation]);

  const onReady = useCallback(async () => {
    const snapshot = optionsRef.current;
    if (!snapshot.threadId) throw new Error("No thread is selected.");
    const stored = linksRef.current[snapshot.threadId];
    if (!stored) throw new Error("Attach a pull request before marking it ready.");
    const cwd = snapshot.cwd ?? snapshot.projectPath;
    const nativeCwd = snapshot.projectPath ?? cwd;
    if (!cwd || !nativeCwd) throw new Error("This thread has no project path.");
    const id = snapshot.threadId;
    const uiScope = stateScope(id, snapshot.cwd);
    await runMutation(id, cwd, async (revision) => {
      invalidatePullRequest(nativeCwd, stored.repository, stored.number);
      if (nativeCwd !== cwd) invalidatePullRequest(cwd, stored.repository, stored.number);
      const result = await markPullRequestReady(nativeCwd, stored.repository, stored.number, stored.snapshot.headOid);
      if (!persistLink(id, result, revision)) return;
      setNoticeState({ scope: uiScope, value: `Pull request #${result.number} is ready for review.` });
      snapshot.onChanged?.();
    });
  }, [linksRef, persistLink, runMutation]);

  const onCreateBranch = useCallback(async (name: string) => {
    const snapshot = optionsRef.current;
    if (!snapshot.threadId || !snapshot.cwd) throw new Error("This thread has no working directory.");
    if (snapshot.isolated) throw new Error("Branch creation is only available for shared project threads.");
    const uiScope = stateScope(snapshot.threadId, snapshot.cwd);
    const currentContext = contextState?.scope === uiScope ? contextState.value : null;
    if (!currentContext) throw new Error("Refresh pull request status before creating a branch.");
    await runMutation(snapshot.threadId, snapshot.cwd, async () => {
      await createPullRequestBranch(snapshot.cwd!, name, currentContext.headOid);
      setNoticeState({ scope: uiScope, value: `Created branch ${name}.` });
      snapshot.onChanged?.();
      requestRefresh({ threadId: snapshot.threadId!, cwd: snapshot.cwd, projectPath: snapshot.projectPath, enabled: snapshot.enabled, visible: snapshot.visible }, true);
    });
  }, [contextState, requestRefresh, runMutation]);

  const forgetThread = useCallback((id: string) => {
    bumpReadRevision(id);
    readRevisionsRef.current.delete(id);
    mutationRevisionsRef.current.set(id, mutationSequenceRef.current += 1);
    setLinks((current) => {
      if (!current[id]) return current;
      const next = { ...current };
      delete next[id];
      return next;
    });
    for (const scope of contextCacheRef.current.keys()) if (scope.startsWith(`${id}\0`)) contextCacheRef.current.delete(scope);
    for (const scope of candidateCacheRef.current.keys()) if (scope.startsWith(`${id}\0`)) candidateCacheRef.current.delete(scope);
    if (!operationCountsRef.current.has(id)) mutationRevisionsRef.current.delete(id);
  }, [bumpReadRevision, setLinks]);

  return {
    context: scopedContext,
    pullRequest,
    linked,
    loading: Boolean(threadId && loadingState?.scope === currentScope && loadingState.value),
    busy: Boolean(threadId && busyState?.scope === currentScope && busyState.value),
    error: threadId && errorState?.scope === currentScope ? errorState.value : null,
    notice: threadId && noticeState?.scope === currentScope ? noticeState.value : null,
    onRefresh: refreshCurrent,
    onAttach,
    onDetach,
    onCreate,
    onMerge,
    onReady,
    onCreateBranch,
    forgetThread,
  };
}
