# Local Git and thread pull requests

Mythra Code treats the checked-out folder as the primary workspace. Local branches, staging and commits work without GitHub. A connected GitHub repository adds explicit publishing and pull-request actions; it does not change the meaning of local work.

## Local-first workflow

The Git dock identifies the current branch and whether the thread is using the shared project folder or an isolated worktree. From there a user can:

- create or switch a named branch in the shared project without GitHub sign-in, `gh`, an origin remote or network access;
- inspect changed and staged file counts;
- stage or unstage individual paths, stage or unstage everything, and commit only the staged set;
- explicitly choose the all-files commit path whether or not a staged set already exists; and
- enter one commit message that is used by the selected commit action.

Branch changes validate the expected branch and commit again immediately before checkout. Dirty folders, detached `HEAD`, stale snapshots and branches already checked out by another worktree are refused. Changing a shared-folder branch moves every thread using that folder. An isolated thread keeps the branch assigned to its worktree; use the worktree workflow rather than the shared branch picker. None of these local actions publishes anything by itself; when automatic publication is enabled, resulting branches and commits can be published by the controller described below.

## Connecting and publishing to GitHub

Manual push remains available. Automatic publication is a separate project-level option named **Automatically publish branches and commits**. It is off by default.

When enabled, Mythra Code pins the repository identity, Git common directory, remote name, exact push URL and local-to-remote branch mappings. It takes a baseline of every existing local branch. Existing branches already checked out in the project or any linked worktree are queued for initial publication; other historical branches are only baselined. After enablement, every newly created branch and every new committed tip is queued, including commits made by the UI, an agent, a terminal or another worktree. A scan also runs after restart, so committed changes made while the app was closed are discovered when Mythra Code observes the project again.

The automation publishes commits only. It never stages or commits files, creates or switches local branches, pulls, rebases, resets, deletes, or cleans up. Uncommitted files stay local and do not prevent an already committed tip from being published. Publication does not update local files from GitHub.

Publication is serialized with other app Git operations and coalesces newer tips. A captured commit is pushed to its captured remote branch by immutable SHA, and normal Git `pre-push` hooks remain in force. Before network mutation, native code rechecks the repository, remote URLs, branch mapping and ancestry while holding the repository lock. After a branch has been published successfully, later publication uses the exact confirmed remote SHA as a compare-and-swap lease only after proving the intended commit descends from it. This guard cannot authorize a history rewrite. An unknown-outcome retry first accepts the exact intended remote SHA as idempotent success; a deleted or independently changed remote ref pauses instead of being recreated or overwritten.

Temporary network and authentication failures retain durable pending work and retry with bounded backoff. Rewritten local history, a changed repository or remote, duplicate local branches targeting one remote branch, upstream mismatches, permission failures and server rejection pause automatic publication for the whole project. A paused identity or mapping is not silently accepted: turn the option off, review the destination and branch history, then turn it on again to establish a new baseline. Pending state survives restart, and corrupt or partial persisted state is rejected before it can drive a push.

## Pull-request flow

A thread can keep one primary GitHub pull request. The attachment is durable thread metadata, not ownership of a branch.

1. Attach an existing PR by full URL or by repository-relative number. Branch discovery is a suggestion until explicitly attached.
2. To create a PR, use a topic branch or isolated worktree. Review the source, target, changed files, commit subjects, title and description. Including every uncommitted folder change requires an explicit checkbox; otherwise only committed history is pushed. Draft creation is supported.
3. The attached card reports open, draft, closed or merged state, checks and review status. Drafts can be marked ready.
4. **Merge on GitHub** confirms the repository, PR, exact head commit and allowed merge method. GitHub auto-merge is offered only when that repository enables it.
5. Removing the attachment changes only the thread metadata. It does not close the PR or alter either local or remote branches.

PR creation distinguishes three outcomes: an already-existing PR found before mutation, an existing PR found after this attempt pushed the branch, and a newly created PR. Failures also distinguish local commit, push, PR creation and follow-up confirmation.

## After a GitHub merge

A GitHub merge changes GitHub only. The merged card explicitly says the local folder is unchanged and offers **Update local _target_** for the shared project. That action is distinct from pulling the feature branch: it confirms the current shared branch and commit, verifies a single matching GitHub remote, fetches the remote, and switches or fast-forwards the named base only when the folder is clean and history is safe. Dirty files, divergent history, stale state, active work, or the base branch being checked out in another worktree stop the action without forcing or overwriting local work.

## Isolated worktree completion

Worktree actions use deliberately different names:

- **Copy changes to project** applies the resulting files without claiming to merge branch history.
- **Merge into local project…** merges committed branch history into the shared local project and does not touch GitHub.
- **Continue in shared project** confirms removal of a finished worktree and branch, then moves future thread work back to the shared folder.

A historical `merged` flag is not enough to declare completion. Mythra Code records the isolated head that was merged and compares it with the current worktree head and clean state. A new commit or new local change restores the appropriate unfinished state and merge action. Returning to shared mode does not silently copy files, remove a worktree, delete a branch or discard data. Removal remains an explicit, guarded operation with a destructive-data summary when necessary.

## Ownership and supported scope

Thread PR links live in durable `kiwi.threadPullRequests` state. Automatic publication state lives in durable `kiwi.gitAutoPublish` state. Async results are scoped to the project or thread that started them and cannot re-enable a disabled publisher or resurrect a removed PR link.

The current GitHub workflow supports github.com and one primary PR per thread. New PR creation uses the configured repository rather than creating fork-to-upstream PRs. Existing fork PRs can still be attached by full URL. Review comments are bound to the attached repository and PR number when one is attached.

## Verification and limits

Focused frontend tests cover local branch controls, staged commits, per-path unstage, automatic-publication baselines and retries, restart recovery, navigation and disable races, history rewrites, remote identity changes, PR attachment and mutation races, post-merge local update controls, and worktree completion transitions. Native tests use disposable repositories to exercise branch guards, safe fetch/update behavior, immutable-SHA publication, exact remote leases, idempotent retry and refusal of rewritten or unexpectedly changed refs.

These tests do not establish successful real-world publication or PR mutation for every GitHub repository policy, credential helper, network, macOS configuration or Windows configuration. Source changes also do not update an installed release. See [the performance notes](performance/thread-pull-requests.md) for polling and measurement boundaries.
