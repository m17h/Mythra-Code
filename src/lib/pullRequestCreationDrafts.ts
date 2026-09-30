import type { PullRequestCreationDraft, PullRequestCreationDraftStore } from "./pullRequests";

export const emptyPullRequestCreationDraft = (): PullRequestCreationDraft => ({
  title: "", titleSource: null, body: "", base: "", draft: false, commitAll: false, commitMessage: "",
});

/** Owned by the thread controller, never localStorage or a component-global cache. */
export function createPullRequestCreationDraftStore(limit = 64): PullRequestCreationDraftStore {
  const drafts = new Map<string, PullRequestCreationDraft>();
  return {
    read: (scope) => drafts.get(scope),
    write: (scope, draft) => {
      drafts.delete(scope);
      drafts.set(scope, { ...draft });
      while (drafts.size > limit) drafts.delete(drafts.keys().next().value!);
    },
    clear: (scope) => { drafts.delete(scope); },
    forgetThread: (threadId) => {
      for (const scope of drafts.keys()) if (scope.startsWith(`${threadId}\0`)) drafts.delete(scope);
    },
  };
}
