# Pull requests and merging

Automated tests and checks are disabled locally and on GitHub until Morgan
explicitly reintroduces them. There is no Verify gate, lint/type/unit/browser/
native/performance requirement, mandatory audit ceremony or CI waiting period.

1. Work on a topic branch with one coherent concern. Inspect the diff and Git
   state, preserve unrelated work, and describe the resulting behavior honestly.
2. The originating development chat commits and pushes the intended changes,
   creates or updates the PR, and attaches it to that chat. Inspect existing PRs
   before creating one. A PR request alone does not authorize merging.
3. If Morgan requested the merge, hand the exact repository, PR URL, head SHA,
   base SHA, scope and known findings to one separate persisted merge chat.
   Use a clean topic worktree and actual unrestricted filesystem/network access
   with shell approval policy `never`. Verify the launcher's effective
   permissions; a written instruction cannot change runtime permissions.
   Any available model can perform this work; no model-specific reviewers are
   required.
4. The merge chat inspects the current head/base and resolves in-scope review
   findings. If source changes, update the PR description and include the actual
   final head in the handoff/report. Merge only within Morgan's authorization.
   Do not run tests or wait for automated checks before or after merging.
5. Confirm the PR's merged state and merge commit through GitHub, including
   squash/rebase evidence. Delete the obsolete topic branch locally and remotely
   after switching off it and preserving additional unmerged commits, protected
   branches, open-PR branches and branches in active worktrees. Fetch/prune and
   synchronize local main only when this will not disturb another chat's work.
6. Report the PR URL, merge commit, known limitations and cleanup state. Archive
   the completed manager's disposable managed worktree recoverably, then archive
   only that merge chat. Keep the originating development chat available.

A merge does not authorize a release. A release needs Morgan's explicit request
and chosen version; follow [releasing.md](releasing.md). GitHub branch protection
must not require removed automated checks. Do not recreate legacy gates or
enable a different check to replace them.
