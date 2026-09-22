import { useCallback, useEffect, useRef } from "react";
import {
  getGitPublishSnapshot,
  publishGitCommit,
  type GitAutoPublishBranch,
  type GitAutoPublishProject,
  type GitPublishBinding,
  type GitPublishSnapshot,
} from "../lib/gitPublishing";
import { acquirePullRequestMutation, releasePullRequestMutation } from "../lib/pullRequestOperations";
import { usePersistedStateRef } from "./usePersistedState";

export const GIT_AUTO_PUBLISH_STORAGE_KEY = "kiwi.gitAutoPublish";
const POLL_MS = 15_000;
const RETRY_BASE_MS = 5_000;
const MAX_RETRY_MS = 60_000;
const SAFE_KEY = /^(?!__proto__$|prototype$|constructor$).+/;
const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const STATUSES = new Set<GitAutoPublishProject["status"]>(["idle", "publishing", "waiting", "paused"]);

export interface GitAutoPublishOptions {
  projects: { id: string; path: string }[];
  blocked: (path: string) => boolean;
}

export interface GitAutoPublishController {
  configs: Record<string, GitAutoPublishProject>;
  enable: (projectId: string, path: string) => Promise<void>;
  disable: (projectId: string) => void;
  retry: (projectId: string) => void;
  refresh: () => void;
}

function sameBinding(left: GitPublishBinding, right: GitPublishBinding): boolean {
  return left.repository === right.repository
    && left.remote === right.remote
    && left.remoteUrl === right.remoteUrl
    && left.commonDir === right.commonDir;
}

function errorText(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

function branchRecord(branch: GitPublishSnapshot["branches"][number]): GitAutoPublishBranch {
  return {
    observedOid: branch.headOid,
    remoteBranch: branch.remoteBranch,
    ...(branch.checkedOut ? { pendingOid: branch.headOid } : {}),
  };
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** Reject partial or poisoned durable records before they can drive a push. */
function sanitizeStoredConfigs(value: unknown): Record<string, GitAutoPublishProject> {
  const safe: Record<string, GitAutoPublishProject> = Object.create(null) as Record<string, GitAutoPublishProject>;
  if (!value || typeof value !== "object" || Array.isArray(value)) return safe;
  for (const [id, candidate] of Object.entries(value)) {
    if (!SAFE_KEY.test(id) || !candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const record = candidate as Partial<GitAutoPublishProject>;
    const binding = record.binding as Partial<GitPublishBinding> | undefined;
    if (!binding || !nonEmpty(binding.repository) || !nonEmpty(binding.remote)
      || !nonEmpty(binding.remoteUrl) || !nonEmpty(binding.commonDir)) continue;
    if (!record.branches || typeof record.branches !== "object" || Array.isArray(record.branches)) continue;
    if (typeof record.enabled !== "boolean" || !STATUSES.has(record.status as GitAutoPublishProject["status"])) continue;
    const branches: Record<string, GitAutoPublishBranch> = Object.create(null) as Record<string, GitAutoPublishBranch>;
    let invalid = false;
    for (const [name, rawBranch] of Object.entries(record.branches)) {
      if (!SAFE_KEY.test(name) || !rawBranch || typeof rawBranch !== "object" || Array.isArray(rawBranch)) { invalid = true; break; }
      const branch = rawBranch as Partial<GitAutoPublishBranch>;
      if (!OID.test(branch.observedOid ?? "") || !nonEmpty(branch.remoteBranch)
        || (branch.publishedOid !== undefined && !OID.test(branch.publishedOid))
        || (branch.pendingOid !== undefined && !OID.test(branch.pendingOid))
        || (branch.paused !== undefined && typeof branch.paused !== "string")) { invalid = true; break; }
      branches[name] = {
        observedOid: branch.observedOid!,
        remoteBranch: branch.remoteBranch,
        ...(branch.publishedOid ? { publishedOid: branch.publishedOid } : {}),
        ...(branch.pendingOid ? { pendingOid: branch.pendingOid } : {}),
        ...(branch.paused ? { paused: branch.paused } : {}),
      };
    }
    if (invalid || typeof record.message !== "string" || typeof record.updatedAt !== "number" || !Number.isFinite(record.updatedAt)
      || (record.retryAt !== undefined && (typeof record.retryAt !== "number" || !Number.isFinite(record.retryAt)))) continue;
    const interrupted = record.status === "publishing";
    const hasPending = Object.values(branches).some((branch) => branch.pendingOid);
    safe[id] = {
      enabled: record.enabled,
      binding: binding as GitPublishBinding,
      branches,
      status: interrupted ? (hasPending ? "waiting" : "idle") : record.status!,
      message: interrupted
        ? (hasPending ? "Resuming interrupted automatic publishing…" : "Committed changes publish automatically.")
        : record.message,
      updatedAt: record.updatedAt,
      ...(!interrupted && record.retryAt !== undefined ? { retryAt: record.retryAt } : {}),
    };
  }
  return safe;
}

/**
 * Publishes committed branch tips without changing a checkout. Enabling takes a
 * baseline of every existing local branch, and initially queues only branches
 * checked out by the project or one of its worktrees. Later scans queue every
 * newly-created branch and every new committed tip, regardless of its source.
 */
export function useGitAutoPublish(options: GitAutoPublishOptions): GitAutoPublishController {
  const [configs, setConfigs, configsRef] = usePersistedStateRef<Record<string, GitAutoPublishProject>>(
    GIT_AUTO_PUBLISH_STORAGE_KEY,
    {},
    { init: (load) => sanitizeStoredConfigs(load()) },
  );
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const generationsRef = useRef(new Map<string, number>());
  const retryCountsRef = useRef(new Map<string, number>());
  const runningRef = useRef<Promise<void> | null>(null);
  const rerunRef = useRef(false);
  const mountedRef = useRef(true);
  const hasEnabledProject = Object.values(configs).some((config) => config.enabled);
  const nextRetryAt = Object.values(configs)
    .filter((config) => config.enabled && config.retryAt !== undefined)
    .reduce<number | undefined>((soonest, config) => Math.min(soonest ?? config.retryAt!, config.retryAt!), undefined);

  const generation = useCallback((id: string) => generationsRef.current.get(id) ?? 0, []);
  const advanceGeneration = useCallback((id: string) => {
    const next = generation(id) + 1;
    generationsRef.current.set(id, next);
    return next;
  }, [generation]);

  const replaceConfig = useCallback((id: string, next: GitAutoPublishProject, expectedGeneration?: number) => {
    if (expectedGeneration !== undefined && generation(id) !== expectedGeneration) return false;
    let changed = false;
    setConfigs((current) => {
      if (expectedGeneration !== undefined && generation(id) !== expectedGeneration) return current;
      if (current[id] && JSON.stringify(current[id]) === JSON.stringify(next)) return current;
      changed = true;
      return { ...current, [id]: next };
    });
    return changed;
  }, [generation, setConfigs]);

  const updateConfig = useCallback((id: string, update: (current: GitAutoPublishProject) => GitAutoPublishProject, expectedGeneration: number) => {
    let result: GitAutoPublishProject | null = null;
    setConfigs((current) => {
      if (generation(id) !== expectedGeneration || !current[id]?.enabled) return current;
      const next = update(current[id]);
      result = next;
      if (JSON.stringify(next) === JSON.stringify(current[id])) return current;
      return { ...current, [id]: next };
    });
    return result;
  }, [generation, setConfigs]);

  const pause = useCallback((id: string, message: string, expectedGeneration: number) => {
    retryCountsRef.current.delete(id);
    updateConfig(id, (current) => ({
      ...current,
      status: "paused",
      message,
      updatedAt: Date.now(),
      retryAt: undefined,
    }), expectedGeneration);
  }, [updateConfig]);

  const waitToRetry = useCallback((id: string, message: string, expectedGeneration: number) => {
    const attempts = (retryCountsRef.current.get(id) ?? 0) + 1;
    retryCountsRef.current.set(id, attempts);
    const delay = Math.min(MAX_RETRY_MS, RETRY_BASE_MS * (2 ** Math.min(attempts - 1, 4)));
    updateConfig(id, (current) => ({
      ...current,
      status: "waiting",
      message,
      updatedAt: Date.now(),
      retryAt: Date.now() + delay,
    }), expectedGeneration);
  }, [updateConfig]);

  const publishPending = useCallback(async (id: string, path: string, expectedGeneration: number) => {
    while (mountedRef.current && generation(id) === expectedGeneration) {
      const config = configsRef.current[id];
      if (!config?.enabled || config.status === "paused") return;
      if (optionsRef.current.blocked(path)) {
        updateConfig(id, (current) => current.status === "waiting" && current.message === "Waiting for the current workspace operation to finish."
          ? current
          : { ...current, status: "waiting", message: "Waiting for the current workspace operation to finish.", updatedAt: Date.now() }, expectedGeneration);
        return;
      }
      const entry = Object.entries(config.branches).find(([, branch]) => branch.pendingOid);
      if (!entry) {
        retryCountsRef.current.delete(id);
        updateConfig(id, (current) => current.status === "idle" && current.retryAt === undefined
          ? current
          : { ...current, status: "idle", message: "Committed changes publish automatically.", updatedAt: Date.now(), retryAt: undefined }, expectedGeneration);
        return;
      }
      const [name, branch] = entry;
      const pendingOid = branch.pendingOid!;
      const lock = acquirePullRequestMutation(path);
      if (!lock) {
        updateConfig(id, (current) => current.status === "waiting" && current.message === "Waiting for another Git operation to finish."
          ? current
          : { ...current, status: "waiting", message: "Waiting for another Git operation to finish.", updatedAt: Date.now() }, expectedGeneration);
        return;
      }
      updateConfig(id, (current) => ({ ...current, status: "publishing", message: `Publishing ${name}…`, updatedAt: Date.now(), retryAt: undefined }), expectedGeneration);
      try {
        // For an initial checked-out tip pendingOid equals observedOid, so there
        // is no ancestry floor. For later tips observedOid remains the durable
        // prior tip until publication succeeds, including across restarts.
        const ancestryFloor = branch.publishedOid ?? (branch.observedOid !== pendingOid ? branch.observedOid : undefined);
        const result = await publishGitCommit(
          path,
          config.binding,
          name,
          pendingOid,
          branch.remoteBranch,
          ancestryFloor,
          branch.publishedOid,
        );
        if (!mountedRef.current || generation(id) !== expectedGeneration) return;
        retryCountsRef.current.delete(id);
        updateConfig(id, (current) => {
          const latest = current.branches[name];
          if (!latest || latest.pendingOid !== pendingOid) return current;
          return {
            ...current,
            branches: {
              ...current.branches,
              [name]: { ...latest, observedOid: pendingOid, publishedOid: result.publishedOid, pendingOid: undefined, paused: undefined },
            },
            status: "idle",
            message: `Published ${name}.`,
            updatedAt: Date.now(),
            retryAt: undefined,
          };
        }, expectedGeneration);
      } catch (reason) {
        if (!mountedRef.current || generation(id) !== expectedGeneration) return;
        const message = errorText(reason);
        // A failed network operation can also be the first visible symptom of
        // a changed remote. Re-read the immutable binding before retaining a
        // retryable state; disable/re-enable is required for a new identity.
        try {
          const latest = await getGitPublishSnapshot(path);
          if (!mountedRef.current || generation(id) !== expectedGeneration) return;
          if (!sameBinding(config.binding, latest.binding)) {
            pause(id, "The repository or publishing remote changed. Turn automatic publishing off and on again after reviewing it.", expectedGeneration);
            return;
          }
        } catch {
          // Preserve the native publish classification when the diagnostic
          // snapshot is unavailable for the same network problem.
        }
        if (message.startsWith("RETRY:")) waitToRetry(id, message.slice(6).trim() || "GitHub is unavailable. Trying again soon.", expectedGeneration);
        else pause(id, message.replace(/^PAUSED:\s*/, "") || "Automatic publishing needs attention.", expectedGeneration);
        return;
      } finally {
        releasePullRequestMutation(lock);
      }
    }
  }, [configsRef, generation, pause, updateConfig, waitToRetry]);

  const scanProject = useCallback(async (id: string, path: string) => {
    const expectedGeneration = generation(id);
    const before = configsRef.current[id];
    if (!before?.enabled || before.status === "paused" || (before.retryAt && before.retryAt > Date.now())) return;
    let snapshot: GitPublishSnapshot;
    try {
      snapshot = await getGitPublishSnapshot(path);
    } catch (reason) {
      if (generation(id) !== expectedGeneration) return;
      const message = errorText(reason);
      if (message.startsWith("RETRY:")) waitToRetry(id, message.slice(6).trim() || "GitHub is unavailable. Trying again soon.", expectedGeneration);
      else pause(id, message.replace(/^PAUSED:\s*/, "") || "Automatic publishing needs attention.", expectedGeneration);
      return;
    }
    if (!mountedRef.current || generation(id) !== expectedGeneration) return;
    if (!sameBinding(before.binding, snapshot.binding)) {
      pause(id, "The repository or publishing remote changed. Turn automatic publishing off and on again after reviewing it.", expectedGeneration);
      return;
    }
    let mappingProblem = "";
    updateConfig(id, (current) => {
      const branches = { ...current.branches };
      let changed = false;
      for (const branch of snapshot.branches) {
        const known = branches[branch.name];
        if (!known) {
          branches[branch.name] = { observedOid: branch.headOid, remoteBranch: branch.remoteBranch, pendingOid: branch.headOid };
          changed = true;
          continue;
        }
        if (known.remoteBranch !== branch.remoteBranch) {
          mappingProblem = `The upstream mapping for ${branch.name} changed. Turn automatic publishing off and on again after reviewing it.`;
          break;
        }
        const queuedTip = known.pendingOid ?? known.observedOid;
        if (queuedTip !== branch.headOid) {
          branches[branch.name] = { ...known, pendingOid: branch.headOid, paused: undefined };
          changed = true;
        }
      }
      return changed ? { ...current, branches, updatedAt: Date.now(), retryAt: undefined } : current;
    }, expectedGeneration);
    if (mappingProblem) {
      pause(id, mappingProblem, expectedGeneration);
      return;
    }
    await publishPending(id, path, expectedGeneration);
  }, [configsRef, generation, pause, publishPending, updateConfig, waitToRetry]);

  const runCycle = useCallback(() => {
    if (runningRef.current) {
      rerunRef.current = true;
      return runningRef.current;
    }
    const run = (async () => {
      do {
        rerunRef.current = false;
        const paths = new Map(optionsRef.current.projects.map((project) => [project.id, project.path]));
        for (const [id, config] of Object.entries(configsRef.current)) {
          const path = paths.get(id);
          if (path && config.enabled) await scanProject(id, path);
        }
      } while (rerunRef.current && mountedRef.current);
    })().finally(() => {
      if (runningRef.current === run) runningRef.current = null;
    });
    runningRef.current = run;
    return run;
  }, [configsRef, scanProject]);

  const enable = useCallback(async (projectId: string, path: string) => {
    const expectedGeneration = advanceGeneration(projectId);
    const alreadyEnabled = Object.values(configsRef.current).some((config) => config.enabled);
    const snapshot = await getGitPublishSnapshot(path);
    if (!mountedRef.current || generation(projectId) !== expectedGeneration) return;
    const branches = Object.fromEntries(snapshot.branches.map((branch) => [branch.name, branchRecord(branch)]));
    replaceConfig(projectId, {
      enabled: true,
      binding: snapshot.binding,
      branches,
      status: Object.values(branches).some((branch) => branch.pendingOid) ? "waiting" : "idle",
      message: Object.values(branches).some((branch) => branch.pendingOid)
        ? "Publishing checked-out branches…"
        : "Committed changes publish automatically.",
      updatedAt: Date.now(),
    }, expectedGeneration);
    if (alreadyEnabled) void runCycle();
  }, [advanceGeneration, configsRef, generation, replaceConfig, runCycle]);

  const disable = useCallback((projectId: string) => {
    advanceGeneration(projectId);
    retryCountsRef.current.delete(projectId);
    setConfigs((current) => {
      const config = current[projectId];
      if (!config || !config.enabled) return current;
      return {
        ...current,
        [projectId]: { ...config, enabled: false, status: "idle", message: "Automatic publishing is off.", retryAt: undefined, updatedAt: Date.now() },
      };
    });
  }, [advanceGeneration, setConfigs]);

  const retry = useCallback((projectId: string) => {
    const config = configsRef.current[projectId];
    // Identity/history failures require an explicit disable/re-enable so the
    // pinned binding and baseline are visibly reviewed rather than accepted.
    if (!config?.enabled || config.status === "paused") return;
    retryCountsRef.current.delete(projectId);
    setConfigs((current) => current[projectId]?.enabled ? {
      ...current,
      [projectId]: { ...current[projectId], status: "waiting", message: "Retrying automatic publishing…", retryAt: undefined, updatedAt: Date.now() },
    } : current);
    void runCycle();
  }, [configsRef, runCycle, setConfigs]);

  const refresh = useCallback(() => { void runCycle(); }, [runCycle]);

  useEffect(() => {
    mountedRef.current = true;
    if (!hasEnabledProject) return () => { mountedRef.current = false; };
    void runCycle();
    const timer = window.setInterval(() => { void runCycle(); }, POLL_MS);
    return () => {
      mountedRef.current = false;
      window.clearInterval(timer);
    };
  }, [hasEnabledProject, runCycle]);

  useEffect(() => {
    if (nextRetryAt === undefined) return;
    const timer = window.setTimeout(() => { void runCycle(); }, Math.max(0, nextRetryAt - Date.now()));
    return () => { window.clearTimeout(timer); };
  }, [nextRetryAt, runCycle]);

  return { configs, enable, disable, retry, refresh };
}
