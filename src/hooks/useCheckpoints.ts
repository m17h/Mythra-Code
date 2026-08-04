import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import {
  checkpointIsRestorable,
  completeCheckpointSnapshot,
  createCheckpointSnapshot,
  deleteCheckpointSnapshot,
  partitionCheckpointsForRetention,
  readCheckpointDiff,
  restoreCheckpointSnapshot,
  type CheckpointHead,
  type CheckpointRecord,
  type CheckpointRestoreTarget,
} from "../lib/checkpoints";
import { setWorktreeAppliedBaseline, type ThreadWorktreeRecord } from "../lib/worktrees";
import { useTaskStore } from "../lib/taskStore";
import { friendlyError } from "../lib/errors";
import { recordError } from "../lib/errorLog";
import { providerFromThread } from "../lib/threadProvider";
import { normalizedProjectPath } from "../lib/paths";
import type { ThreadSidebarIndex } from "../lib/threadList";
import { usePersistedStateRef, type SetPersisted } from "./usePersistedState";
import type { Project, Provider, Thread } from "../types";

export interface CheckpointsContext {
  chatWorkspacePath: string;
  activeThread: Thread | null;
  activeProject: Project | null;
  activeThreadId: string | null;
  activeExecutionPath: string;
  /** Fallback provider for checkpoint records (the global settings default). */
  defaultProvider: Provider;
  threadModels: Record<string, string>;
  knownThreadsRef: MutableRefObject<ThreadSidebarIndex | null>;
  threadProjectBindingsRef: MutableRefObject<Record<string, string> | null>;
  threadWorktreesRef: MutableRefObject<Record<string, ThreadWorktreeRecord>>;
  persistThreadWorktrees: SetPersisted<Record<string, ThreadWorktreeRecord>>;
  refreshDiffFor: (threadId: string, projectPath: string) => Promise<void>;
  setError: (error: string | null) => void;
  setTransientStatus: (message: string) => void;
}

/**
 * Owns the filesystem-checkpoint lifecycle: automatic per-run snapshots,
 * manual/safety captures, restore/preview/delete, the per-project operation
 * queue that serializes git snapshot work, and retention pruning on every
 * persist. The context is rebuilt by App each render and read through a ref,
 * so the stable callbacks always see fresh state at call time.
 */
export function useCheckpoints(context: CheckpointsContext) {
  const contextRef = useRef(context);
  contextRef.current = context;

  const [checkpoints, setCheckpointsPersisted, checkpointsRef] = usePersistedStateRef<CheckpointRecord[]>("kiwi.checkpoints", []);
  const [checkpointHeads, setCheckpointHeadsPersisted, checkpointHeadsRef] = usePersistedStateRef<Record<string, CheckpointHead>>("kiwi.checkpointHeads", {});
  const activeRunCheckpointsRef = useRef(new Map<string, string>());
  const checkpointProjectQueuesRef = useRef(new Map<string, Promise<void>>());
  const checkpointUnsupportedPathsRef = useRef(new Set<string>());
  const [checkpointBusyId, setCheckpointBusyId] = useState<string | null>(null);
  const [checkpointPreview, setCheckpointPreview] = useState<{ id: string; diff: string } | null>(null);

  const runCheckpointProjectOperation = useCallback(async <T,>(
    workspacePath: string,
    operation: () => Promise<T>,
  ): Promise<T> => {
    const key = normalizedProjectPath(workspacePath);
    const previous = checkpointProjectQueuesRef.current.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.catch(() => undefined).then(() => gate);
    checkpointProjectQueuesRef.current.set(key, tail);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (checkpointProjectQueuesRef.current.get(key) === tail) {
        checkpointProjectQueuesRef.current.delete(key);
      }
    }
  }, []);

  const persistCheckpoints = useCallback((update: (current: CheckpointRecord[]) => CheckpointRecord[]) => {
    let prunedRecords: CheckpointRecord[] = [];
    setCheckpointsPersisted((current) => {
      const next = update(current);
      // Retention: the record list is rewritten wholesale on every turn and
      // would otherwise grow forever. Prune old overflow past the per-project
      // cap, and delete each pruned record's backing git snapshot the same way
      // an explicit delete does. Heads and in-flight run checkpoints are
      // explicitly protected; the partition itself keeps anything running,
      // safety-related, worktree-linked, or newer than seven days.
      const protectedIds = new Set<string>([
        ...Object.values(checkpointHeadsRef.current).map((head) => head.checkpointId),
        ...activeRunCheckpointsRef.current.values(),
      ]);
      const { kept, pruned } = partitionCheckpointsForRetention(next, protectedIds);
      prunedRecords = pruned;
      return kept;
    });
    for (const record of prunedRecords) {
      if (!record.workspacePath || !record.beforeCommit) continue;
      void runCheckpointProjectOperation(
        record.workspacePath,
        () => deleteCheckpointSnapshot(record.id, record.workspacePath!),
      ).catch(() => undefined);
    }
  }, [checkpointHeadsRef, runCheckpointProjectOperation, setCheckpointsPersisted]);

  const persistCheckpointHead = useCallback((workspacePath: string, head: CheckpointHead | null) => {
    setCheckpointHeadsPersisted((current) => {
      const key = normalizedProjectPath(workspacePath);
      const next = { ...current };
      if (head) next[key] = head;
      else delete next[key];
      return next;
    });
  }, [setCheckpointHeadsPersisted]);

  const beginRunCheckpoint = useCallback(async (
    threadId: string,
    workspacePath: string,
    prompt: string,
    provider: Provider,
    model: string,
  ): Promise<string | undefined> => {
    const { chatWorkspacePath, knownThreadsRef, threadProjectBindingsRef } = contextRef.current;
    const pathKey = normalizedProjectPath(workspacePath);
    if (
      (chatWorkspacePath && pathKey === normalizedProjectPath(chatWorkspacePath))
      || checkpointUnsupportedPathsRef.current.has(pathKey)
    ) return undefined;
    const id = crypto.randomUUID();
    const parent = checkpointHeadsRef.current[pathKey];
    const taskState = useTaskStore.getState();
    const overlappingRun = Object.entries(taskState.statuses).some(([candidateId, taskStatus]) => {
      if (candidateId === threadId || (taskStatus !== "starting" && taskStatus !== "running")) return false;
      const binding = taskState.tasks[candidateId]?.workspacePath
        ?? threadProjectBindingsRef.current?.[candidateId];
      return Boolean(binding && normalizedProjectPath(binding) === pathKey);
    });
    const label = prompt.trim()
      ? `Run: ${prompt.trim().replace(/\s+/g, " ").slice(0, 72)}`
      : "Model run";
    const checkpoint: CheckpointRecord = {
      id,
      threadId,
      workspacePath,
      threadLabel: knownThreadsRef.current?.[threadId]?.name || knownThreadsRef.current?.[threadId]?.preview || prompt.slice(0, 72),
      provider,
      model,
      label,
      createdAt: Date.now(),
      status: "running",
      parentId: parent?.checkpointId,
      parentPosition: parent?.position,
      overlappingRun,
    };
    persistCheckpoints((current) => [
      checkpoint,
      ...current.map((entry) => (
        overlappingRun
        && entry.status === "running"
        && entry.workspacePath
        && normalizedProjectPath(entry.workspacePath) === pathKey
          ? { ...entry, overlappingRun: true }
          : entry
      )),
    ]);
    try {
      const snapshot = await runCheckpointProjectOperation(
        workspacePath,
        () => createCheckpointSnapshot(id, workspacePath, `${label} · before`),
      );
      persistCheckpoints((current) => current.map((entry) => entry.id === id ? {
        ...entry,
        repoRoot: snapshot.repoRoot,
        beforeCommit: snapshot.commit,
        fileCount: snapshot.fileCount,
        branch: snapshot.branch ?? undefined,
        head: snapshot.head ?? undefined,
      } : entry));
      activeRunCheckpointsRef.current.set(threadId, id);
      return id;
    } catch (reason) {
      const message = friendlyError(reason);
      persistCheckpoints((current) => current.filter((entry) => entry.id !== id));
      void deleteCheckpointSnapshot(id, workspacePath).catch(() => undefined);
      if (/Checkpoints (?:currently )?require/i.test(message)) {
        checkpointUnsupportedPathsRef.current.add(pathKey);
        useTaskStore.getState().upsertActivity(threadId, {
          id: `checkpoint-unavailable-${id}`,
          kind: "warning",
          title: "Automatic checkpoints unavailable",
          detail: `${message}. The model can still work, but OpenKiwi cannot create restorable file snapshots here.`,
        });
      } else {
        recordError(`Could not create the automatic checkpoint: ${message}`);
        useTaskStore.getState().upsertActivity(threadId, {
          id: `checkpoint-failed-${id}`,
          kind: "warning",
          title: "Automatic checkpoint failed",
          detail: message,
        });
      }
      return undefined;
    }
  }, [checkpointHeadsRef, persistCheckpoints, runCheckpointProjectOperation]);

  const finalizeRunCheckpoint = useCallback(async (
    threadId: string,
    turnId?: string,
    completionStatus: "ready" | "interrupted" | "recovered" = "ready",
  ) => {
    const id = activeRunCheckpointsRef.current.get(threadId);
    if (!id) return;
    activeRunCheckpointsRef.current.delete(threadId);
    const checkpoint = checkpointsRef.current.find((entry) => entry.id === id);
    if (!checkpoint?.workspacePath) return;
    try {
      const result = await runCheckpointProjectOperation(
        checkpoint.workspacePath,
        () => completeCheckpointSnapshot(id, checkpoint.workspacePath!, `${checkpoint.label} · completed`),
      );
      persistCheckpoints((current) => current.map((entry) => entry.id === id ? {
        ...entry,
        turnId: turnId ?? entry.turnId,
        status: completionStatus,
        completedAt: Date.now(),
        afterCommit: result.snapshot.commit,
        fileCount: result.snapshot.fileCount,
        changedFiles: result.changedFiles,
        additions: result.additions,
        deletions: result.deletions,
      } : entry));
      persistCheckpointHead(checkpoint.workspacePath, { checkpointId: id, position: "after" });
    } catch (reason) {
      const message = friendlyError(reason);
      persistCheckpoints((current) => current.map((entry) => entry.id === id ? {
        ...entry,
        status: "failed",
        completedAt: Date.now(),
        error: message,
      } : entry));
      recordError(`Could not finish checkpoint “${checkpoint.label}”: ${message}`);
    }
  }, [checkpointsRef, persistCheckpointHead, persistCheckpoints, runCheckpointProjectOperation]);

  const discardRunCheckpoint = useCallback((threadId: string) => {
    const id = activeRunCheckpointsRef.current.get(threadId);
    if (!id) return;
    activeRunCheckpointsRef.current.delete(threadId);
    const checkpoint = checkpointsRef.current.find((entry) => entry.id === id);
    persistCheckpoints((current) => current.filter((entry) => entry.id !== id));
    if (checkpoint?.workspacePath) {
      void runCheckpointProjectOperation(
        checkpoint.workspacePath,
        () => deleteCheckpointSnapshot(id, checkpoint.workspacePath!),
      ).catch(() => undefined);
    }
  }, [checkpointsRef, persistCheckpoints, runCheckpointProjectOperation]);

  useEffect(() => {
    for (const checkpoint of checkpointsRef.current) {
      if (checkpoint.status === "running" && (!checkpoint.workspacePath || !checkpoint.beforeCommit)) {
        persistCheckpoints((current) => current.map((entry) => entry.id === checkpoint.id ? {
          ...entry,
          status: "failed",
          completedAt: Date.now(),
          error: "OpenKiwi closed before the initial project snapshot finished.",
        } : entry));
        // checkpoint_create may have written its private Git ref immediately
        // before the renderer closed, before the returned commit could be
        // persisted. Deleting by id is safe even when no ref was created and
        // prevents that half-snapshot from leaking indefinitely.
        if (checkpoint.workspacePath) {
          void runCheckpointProjectOperation(
            checkpoint.workspacePath,
            () => deleteCheckpointSnapshot(checkpoint.id, checkpoint.workspacePath!),
          ).catch(() => undefined);
        }
        continue;
      }
      if (
        checkpoint.status !== "running"
        || !checkpoint.workspacePath
        || !checkpoint.beforeCommit
        || activeRunCheckpointsRef.current.has(checkpoint.threadId)
      ) {
        continue;
      }
      activeRunCheckpointsRef.current.set(checkpoint.threadId, checkpoint.id);
      void finalizeRunCheckpoint(checkpoint.threadId, checkpoint.turnId, "recovered");
    }
  }, [checkpointsRef, finalizeRunCheckpoint, persistCheckpoints, runCheckpointProjectOperation]);

  const projectHasActiveTask = useCallback((workspacePath: string): boolean => {
    const { threadProjectBindingsRef } = contextRef.current;
    const target = normalizedProjectPath(workspacePath);
    if (checkpointProjectQueuesRef.current.has(target)) return true;
    const state = useTaskStore.getState();
    return Object.entries(state.statuses).some(([threadId, taskStatus]) => {
      if (taskStatus !== "starting" && taskStatus !== "running") return false;
      const binding = threadProjectBindingsRef.current?.[threadId];
      const executionPath = state.tasks[threadId]?.workspacePath;
      return Boolean(
        (binding && normalizedProjectPath(binding) === target)
        || (executionPath && normalizedProjectPath(executionPath) === target),
      );
    });
  }, []);

  const captureCurrentStateCheckpoint = useCallback(async ({
    threadId,
    workspacePath,
    label,
    status = "ready",
    restoredFromId,
    worktreeThreadId,
    worktreeBaseline,
    serialize = true,
  }: {
    threadId: string;
    workspacePath: string;
    label: string;
    status?: CheckpointRecord["status"];
    restoredFromId?: string;
    worktreeThreadId?: string;
    worktreeBaseline?: string;
    serialize?: boolean;
  }): Promise<CheckpointRecord> => {
    const { defaultProvider, knownThreadsRef, threadModels } = contextRef.current;
    const id = crypto.randomUUID();
    const pathKey = normalizedProjectPath(workspacePath);
    const parent = checkpointHeadsRef.current[pathKey];
    const thread = knownThreadsRef.current?.[threadId];
    const checkpoint: CheckpointRecord = {
      id,
      threadId,
      workspacePath,
      threadLabel: thread?.name || thread?.preview || "Project state",
      provider: providerFromThread(thread, defaultProvider),
      model: threadModels[threadId],
      label,
      createdAt: Date.now(),
      status: "running",
      parentId: parent?.checkpointId,
      parentPosition: parent?.position,
      restoredFromId,
      worktreeThreadId,
      worktreeBaseline,
    };
    persistCheckpoints((current) => [checkpoint, ...current]);
    const capture = async () => {
      const before = await createCheckpointSnapshot(id, workspacePath, `${label} · saved`);
      const after = await completeCheckpointSnapshot(id, workspacePath, `${label} · saved`);
      const completed: CheckpointRecord = {
        ...checkpoint,
        repoRoot: before.repoRoot,
        beforeCommit: before.commit,
        afterCommit: after.snapshot.commit,
        branch: before.branch ?? undefined,
        head: before.head ?? undefined,
        fileCount: after.snapshot.fileCount,
        changedFiles: after.changedFiles,
        additions: after.additions,
        deletions: after.deletions,
        status,
        completedAt: Date.now(),
      };
      persistCheckpoints((current) => current.map((entry) => entry.id === id ? completed : entry));
      return completed;
    };
    try {
      return serialize
        ? await runCheckpointProjectOperation(workspacePath, capture)
        : await capture();
    } catch (reason) {
      persistCheckpoints((current) => current.filter((entry) => entry.id !== id));
      void deleteCheckpointSnapshot(id, workspacePath).catch(() => undefined);
      throw reason;
    }
  }, [checkpointHeadsRef, persistCheckpoints, runCheckpointProjectOperation]);

  const createCheckpoint = useCallback(async () => {
    const { activeThread, activeProject, activeExecutionPath, setError, setTransientStatus } = contextRef.current;
    if (!activeThread || !activeProject) return;
    if (projectHasActiveTask(activeExecutionPath)) {
      setError("Wait for active tasks in this project to finish before saving a manual checkpoint.");
      return;
    }
    setCheckpointBusyId("manual");
    try {
      const count = checkpointsRef.current.filter((item) => normalizedProjectPath(item.workspacePath ?? "") === normalizedProjectPath(activeExecutionPath)).length + 1;
      const checkpoint = await captureCurrentStateCheckpoint({
        threadId: activeThread.id,
        workspacePath: activeExecutionPath,
        label: `Manual checkpoint ${count}`,
      });
      persistCheckpointHead(activeExecutionPath, { checkpointId: checkpoint.id, position: "after" });
      setTransientStatus("Checkpoint saved");
    } catch (reason) {
      setError(friendlyError(reason));
    } finally {
      setCheckpointBusyId(null);
    }
  }, [captureCurrentStateCheckpoint, checkpointsRef, persistCheckpointHead, projectHasActiveTask]);

  const restoreCheckpoint = useCallback(async (checkpoint: CheckpointRecord, target: CheckpointRestoreTarget) => {
    const ctx = contextRef.current;
    const { activeThread, activeThreadId, activeExecutionPath, threadWorktreesRef, persistThreadWorktrees, refreshDiffFor, setError, setTransientStatus } = ctx;
    if (!checkpoint.workspacePath || !checkpointIsRestorable(checkpoint, target)) {
      setError("This older conversation marker does not contain a restorable file snapshot.");
      return;
    }
    if (projectHasActiveTask(checkpoint.workspacePath)) {
      setError("Stop every active task in this project before restoring a checkpoint.");
      return;
    }
    const action = target === "before"
      ? `restore the project to before “${checkpoint.label}”`
      : `restore the completed state of “${checkpoint.label}”`;
    if (!window.confirm(
      `Are you sure you want to ${action}?\n\n`
      + "The complete project source state will move to that point. Later work will leave the active folder, but OpenKiwi will save the current state as a new safety checkpoint first. Git commits and ignored files are not changed.",
    )) return;

    setCheckpointBusyId(checkpoint.id);
    let safetyId: string | null = null;
    try {
      await runCheckpointProjectOperation(checkpoint.workspacePath, async () => {
        const relatedWorktree = checkpoint.worktreeThreadId
          ? threadWorktreesRef.current[checkpoint.worktreeThreadId]
          : undefined;
        const safety = await captureCurrentStateCheckpoint({
          threadId: activeThread?.id ?? checkpoint.threadId,
          workspacePath: checkpoint.workspacePath!,
          label: `Safety copy before restoring ${checkpoint.label}`,
          status: "safety",
          restoredFromId: checkpoint.id,
          worktreeThreadId: relatedWorktree?.threadId,
          worktreeBaseline: relatedWorktree
            ? relatedWorktree.appliedTree ?? relatedWorktree.baseCommit
            : undefined,
          serialize: false,
        });
        safetyId = safety.id;
        await restoreCheckpointSnapshot(checkpoint.id, checkpoint.workspacePath!, target, safety.id);
        if (
          target === "after"
          && checkpoint.worktreeThreadId
          && checkpoint.worktreeBaseline
          && relatedWorktree
          && relatedWorktree.status !== "removed"
        ) {
          const restoredTree = await setWorktreeAppliedBaseline(
            checkpoint.worktreeThreadId,
            checkpoint.workspacePath!,
            checkpoint.worktreeBaseline,
          );
          persistThreadWorktrees((current) => {
            const record = current[checkpoint.worktreeThreadId!];
            if (!record) return current;
            return {
              ...current,
              [record.threadId]: {
                ...record,
                appliedTree: restoredTree,
                status: checkpoint.worktreeBaseline === record.baseCommit ? "active" : "applied",
              },
            };
          });
        }
      });
      persistCheckpoints((current) => current.map((entry) => entry.id === checkpoint.id ? {
        ...entry,
        status: target === "before" ? "restored-before" : "restored-after",
      } : entry));
      persistCheckpointHead(checkpoint.workspacePath, { checkpointId: checkpoint.id, position: target });
      setCheckpointPreview(null);
      if (activeThreadId && normalizedProjectPath(activeExecutionPath) === normalizedProjectPath(checkpoint.workspacePath)) {
        await refreshDiffFor(activeThreadId, activeExecutionPath);
      }
      setTransientStatus(target === "before" ? "Restored before run" : "Completed state restored");
    } catch (reason) {
      if (safetyId) persistCheckpointHead(checkpoint.workspacePath, { checkpointId: safetyId, position: "after" });
      setError(`Checkpoint restore stopped: ${friendlyError(reason)}${safetyId ? " Your pre-restore safety copy is available in Checkpoints." : ""}`);
    } finally {
      setCheckpointBusyId(null);
    }
  }, [captureCurrentStateCheckpoint, persistCheckpointHead, persistCheckpoints, projectHasActiveTask, runCheckpointProjectOperation]);

  const toggleCheckpointAccepted = useCallback((checkpoint: CheckpointRecord) => {
    const { setTransientStatus } = contextRef.current;
    persistCheckpoints((current) => current.map((entry) => entry.id === checkpoint.id ? {
      ...entry,
      accepted: !entry.accepted,
    } : entry));
    setTransientStatus(checkpoint.accepted ? "Acceptance undone" : "Checkpoint accepted");
  }, [persistCheckpoints]);

  const previewCheckpoint = useCallback(async (checkpoint: CheckpointRecord) => {
    const { setError } = contextRef.current;
    if (!checkpoint.workspacePath || !checkpoint.afterCommit) {
      setError("This checkpoint does not have a completed file snapshot to preview.");
      return;
    }
    let toggledOff = false;
    setCheckpointPreview((current) => {
      if (current?.id === checkpoint.id) {
        toggledOff = true;
        return null;
      }
      return current;
    });
    if (toggledOff) return;
    setCheckpointBusyId(checkpoint.id);
    try {
      const diff = await runCheckpointProjectOperation(
        checkpoint.workspacePath,
        () => readCheckpointDiff(checkpoint.id, checkpoint.workspacePath!),
      );
      setCheckpointPreview({ id: checkpoint.id, diff });
    } catch (reason) {
      setError(friendlyError(reason));
    } finally {
      setCheckpointBusyId(null);
    }
  }, [runCheckpointProjectOperation]);

  const removeCheckpoint = useCallback(async (checkpoint: CheckpointRecord) => {
    const { setError, setTransientStatus } = contextRef.current;
    if (!checkpoint.workspacePath) {
      persistCheckpoints((current) => current.filter((entry) => entry.id !== checkpoint.id));
      return;
    }
    if (checkpoint.status === "running") {
      setError("Wait for this run to finish before deleting its checkpoint.");
      return;
    }
    if (!window.confirm(`Delete “${checkpoint.label}”?\n\nIts saved file states will no longer be restorable. Your current files and Git history will not change.`)) return;
    setCheckpointBusyId(checkpoint.id);
    try {
      await runCheckpointProjectOperation(
        checkpoint.workspacePath,
        () => deleteCheckpointSnapshot(checkpoint.id, checkpoint.workspacePath!),
      );
      persistCheckpoints((current) => current.filter((entry) => entry.id !== checkpoint.id));
      const pathKey = normalizedProjectPath(checkpoint.workspacePath);
      if (checkpointHeadsRef.current[pathKey]?.checkpointId === checkpoint.id) {
        persistCheckpointHead(checkpoint.workspacePath, null);
      }
      setCheckpointPreview((current) => (current?.id === checkpoint.id ? null : current));
      setTransientStatus("Checkpoint deleted");
    } catch (reason) {
      setError(friendlyError(reason));
    } finally {
      setCheckpointBusyId(null);
    }
  }, [checkpointHeadsRef, persistCheckpointHead, persistCheckpoints, runCheckpointProjectOperation]);

  /**
   * Permanent-thread-delete cleanup: drop the thread's checkpoints, any head
   * pointing at them, and their backing git snapshots.
   */
  const forgetThreadCheckpoints = useCallback((threadId: string) => {
    const deletedCheckpointIds = new Set(
      checkpointsRef.current
        .filter((checkpoint) => checkpoint.threadId === threadId)
        .map((checkpoint) => checkpoint.id),
    );
    for (const [path, head] of Object.entries(checkpointHeadsRef.current)) {
      if (deletedCheckpointIds.has(head.checkpointId)) persistCheckpointHead(path, null);
    }
    const deletedCheckpoints = checkpointsRef.current.filter((checkpoint) => checkpoint.threadId === threadId);
    for (const checkpoint of deletedCheckpoints) {
      if (checkpoint.workspacePath) {
        void runCheckpointProjectOperation(
          checkpoint.workspacePath,
          () => deleteCheckpointSnapshot(checkpoint.id, checkpoint.workspacePath!),
        ).catch(() => undefined);
      }
    }
    persistCheckpoints((current) => current.filter((checkpoint) => checkpoint.threadId !== threadId));
  }, [checkpointHeadsRef, checkpointsRef, persistCheckpointHead, persistCheckpoints, runCheckpointProjectOperation]);

  return {
    checkpoints,
    checkpointHeads,
    checkpointsRef,
    checkpointBusyId,
    checkpointPreview,
    runCheckpointProjectOperation,
    persistCheckpoints,
    persistCheckpointHead,
    beginRunCheckpoint,
    finalizeRunCheckpoint,
    discardRunCheckpoint,
    projectHasActiveTask,
    captureCurrentStateCheckpoint,
    createCheckpoint,
    restoreCheckpoint,
    toggleCheckpointAccepted,
    previewCheckpoint,
    removeCheckpoint,
    forgetThreadCheckpoints,
  };
}
