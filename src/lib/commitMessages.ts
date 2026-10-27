import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import { useTaskStore } from "./taskStore";

export interface CommitMessageContext {
  rootPath: string;
  headOid: string | null;
  branch: string | null;
  token: string;
  stagedToken: string;
  /** Combined content only; staging alone does not change it. */
  changesToken: string;
  hasChanges: boolean;
  hasStaged: boolean;
  status: string;
  diff: string;
  stagedDiff: string;
  untrackedPaths: string[];
  previewTruncated: boolean;
}

export interface CommitMessageSuggestion {
  id: string;
  /** App-owned ordering: an older asynchronous read cannot replace a newer draft. */
  sequence?: number;
  context: Pick<CommitMessageContext, "rootPath" | "headOid" | "branch" | "token" | "stagedToken" | "changesToken">;
  message: string;
  stagedMessage?: string;
}

export const getCommitMessageContext = (cwd: string) => invoke<CommitMessageContext>("git_commit_message_context", { cwd });

// Execution paths already come from the app's worktree routing. Do not fold
// case: two different checkouts can exist on a case-sensitive filesystem.
export const commitMessageScope = (cwd: string) => cwd.replace(/\\/g, "/").replace(/\/$/, "");

export const useCommitMessageStore = create<{ suggestions: Record<string, CommitMessageSuggestion> }>(() => ({ suggestions: {} }));
// One waiting draft per conversation in a checkout: parents sharing a checkout
// must not cancel each other's drafts; freshness tokens decide which survives.
const pending = new Map<string, () => void>();
const pendingKey = (scope: string, threadId: string) => `${scope}\0${threadId}`;
let suggestionSequence = 0;

export function clearCommitMessageSuggestion(cwd: string): void {
  const scope = commitMessageScope(cwd);
  for (const [key, cancel] of [...pending]) if (key.startsWith(`${scope}\0`)) cancel();
  useCommitMessageStore.setState(({ suggestions }) => {
    const next = { ...suggestions };
    delete next[scope];
    return { suggestions: next };
  });
}

/** Publish only the exact successful turn's final, still-current changes. */
export function queueCommitMessageSuggestion(cwd: string, threadId: string, suggestion: CommitMessageSuggestion): void {
  const task = useTaskStore.getState().tasks[threadId];
  const turnId = task?.activeTurnId;
  if (!turnId || !["running", "starting"].includes(task.status)) throw new Error("Commit suggestions require an active model turn.");
  const scope = commitMessageScope(cwd);
  const key = pendingKey(scope, threadId);
  // Retain only the draft and identity, not source patches, in the UI cache.
  const { rootPath, headOid, branch, token, stagedToken, changesToken } = suggestion.context;
  suggestion = { ...suggestion, sequence: ++suggestionSequence, context: { rootPath, headOid, branch, token, stagedToken, changesToken } };
  pending.get(key)?.();
  // A later submission, commit, or Stop invalidates any in-flight completion read.
  let cancelled = false;
  let unsubscribe = () => {};
  const cancel = () => {
    cancelled = true;
    unsubscribe();
    if (pending.get(key) === cancel) pending.delete(key);
  };
  pending.set(key, cancel);
  const settle = () => {
    if (cancelled) return;
    const current = useTaskStore.getState().tasks[threadId];
    // The per-turn receipt, not the thread status: a queued follow-up can
    // already be running by the time this turn's completion is recorded.
    if (current?.lastCompletedTurnId !== turnId) {
      // Codex's thread/status/changed can say idle before turn/completed.
      // Idle is not a failure and cannot stand in for that turn's receipt.
      if (current?.activeTurnId === turnId && current.status !== "error" && current.status !== "interrupted") return;
      cancel();
      return;
    }
    unsubscribe();
    if (current.lastCompletedTurnStatus !== "completed") {
      cancel();
      return;
    }
    void getCommitMessageContext(cwd).then((context) => {
      const latest = useTaskStore.getState().tasks[threadId];
      if (cancelled || !latest || context.token !== suggestion.context.token
        || latest.lastCompletedTurnId === turnId && latest.lastCompletedTurnStatus !== "completed") return;
      useCommitMessageStore.setState(({ suggestions }) => {
        if ((suggestions[scope]?.sequence ?? 0) > suggestion.sequence!) return { suggestions };
        const entries = Object.entries(suggestions).filter(([entry]) => entry !== scope).slice(-99);
        return { suggestions: { ...Object.fromEntries(entries), [scope]: suggestion } };
      });
    }).catch(() => { /* A draft must never turn a completed run into an error. */ })
      .finally(() => { if (pending.get(key) === cancel) pending.delete(key); });
  };
  unsubscribe = useTaskStore.subscribe((state, previous) => {
    const next = state.tasks[threadId];
    const before = previous.tasks[threadId];
    if (next?.status !== before?.status || next?.activeTurnId !== before?.activeTurnId
      || next?.lastCompletedTurnId !== before?.lastCompletedTurnId
      || next?.lastCompletedTurnStatus !== before?.lastCompletedTurnStatus) settle();
  });
  settle();
}
