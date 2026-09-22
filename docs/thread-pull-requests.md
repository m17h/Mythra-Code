# Thread pull requests

A thread can keep one primary GitHub pull request. The project folder supplies the Git repository; an isolated thread uses its worktree for commits and pushes. The compact header control opens the existing Git dock instead of adding a permanent sidebar.

## User flow

1. Open the Git control in a project thread. Sign in through the existing GitHub settings if needed.
2. Attach an existing GitHub PR by URL or repository-relative number. A PR discovered for the current branch is a suggestion until explicitly attached.
3. To create a PR, use a topic branch or the existing isolated-worktree flow. Review the branch, base, changed files, commit subjects, title and description. Committing all current folder changes requires an explicit checkbox; otherwise only committed work is pushed. Draft creation is supported.
4. The linked card shows draft/open/closed/merged state, checks and review status. Drafts can be marked ready. Merge confirms the repository, PR and exact reviewed commit, uses an allowed merge method, and respects current GitHub permissions/rules. Auto merge is offered only when the repository enables it.
5. Removing the attachment only removes the thread's link. It does not close the PR. Deleting a thread cleans its link; archiving it retains the link. Removing an isolated worktree retains the remote PR identity and status actions through the project folder.

## Ownership and boundaries

Links live in durable `kiwi.threadPullRequests` app state, independently of provider transcripts. A new storage schema registers that state for native persistence. Late responses update their original thread and cannot resurrect a deleted/detached link. Cached reads are scoped to the working directory and PR; stale reads are invalidated after mutations.

GitHub reads use the user's existing authenticated GitHub CLI. The native implementation passes structured argument lists, resolves the selected Git root, validates the repository/ref/commit, and checks fetch and push remotes before a push. Pushes target the captured commit without force. Retrying creation attaches an existing matching open PR instead of creating duplicates. If a PR already exists before work begins, the result explicitly says local changes were not committed or pushed. A PR discovered after pushing reports that the branch was pushed and the existing PR attached. Errors distinguish local commit, push, creation, and confirmation failures. Mutating controls coordinate with active agents, checkpoints and other app Git actions. External Git clients remain outside that app-level lock; native preflight and exact-head checks detect relevant branch/commit drift.

The first version supports github.com, one primary PR per thread, and creation within the origin repository. Existing upstream/fork PRs can be attached by full URL; creating a new fork-to-upstream PR is not supported yet. Review comments remain available through the existing Git action and GitHub. There is no PR-stack manager or full inline review editor.

## Verification

Frontend tests exercise attachment/reload, same-folder thread isolation, navigation during async work, retries and cache refresh, permissions, missing-worktree status actions, dirty-file inclusion, draft-ready and stale-head confirmations. Chromium and WebKit browser tests exercise 360–500px docks, long names, themes and crowded headers. Native tests use disposable Git repositories and controlled CLI results. Full native suites and authenticated read-only GitHub contract checks run on macOS and Windows.

Remote PR creation/merging through the app has not been exercised against a live repository; those mutation paths are covered by local tests and code review. Browser layout tests are not a complete Windows WebView interaction test. Source changes do not update an installed official release.

See [the measured performance review](performance/thread-pull-requests.md) for bundle-size costs and refresh limits.
