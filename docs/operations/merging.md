# Merging Mythra Code

`AGENTS.md` owns the rules. This runbook describes their implementation; it does
not authorize a merge, release, or repository-settings change by itself.

## Normal development and merge

1. Work on a topic branch with one coherent concern. Run focused regression
   tests and relevant lint/type checks, and replay actual UI/native behavior at
   the affected boundary. Preserve unrelated work and user data.
2. When authorized, commit/push the topic branch and create/update its PR. Start
   CI early and review while it runs. Unrelated work can use another worktree.
3. Inspect the PR head and latest base, checks and reviews:

   ```sh
   gh pr view <number> --json headRefOid,baseRefName,mergeStateStatus,statusCheckRollup
   gh pr checks <number>
   ```

   Require `Verify gate`. The workflow checks the PR's synthetic merge checkout
   and records head/base/checkout SHAs in its receipts and gate summary. A green
   run for an older head or older base does not approve the current combination.
   Refresh/rebase and rerun when the base moves; do not merely rerun an obsolete
   checkout. GitHub branch protection should require an up-to-date gate.
4. Resolve real review findings. If explicitly authorized to merge, match the
   reviewed final head:

   ```sh
   gh pr merge <number> --squash --match-head-commit <approved-head-sha> --delete-branch
   git fetch --prune origin
   git switch main
   git merge --ff-only origin/main
   ```

5. Confirm merge evidence and preserve additional unmerged commits/worktrees
   before deleting the local topic branch. Confirm its remote counterpart is
   gone and `main...origin/main` is synchronized. Report post-merge CI separately.
   For a release, `build.md` still requires successful CI on the exact merged
   release commit. Do not run a redundant full local suite just to repeat it.

`npm run verify` remains the complete sequential local diagnostic command.
The hosted workflow distributes the same commands instead of duplicating it
locally on every merge. A contract check fails when the two command sets drift.

## Coverage and failure handling

- Native macOS/Windows lanes retain Clippy, Cargo check and every Rust test,
  sequentially so compilation is reused.
- Two unit shards on each OS retain `maxWorkers: 2`. The gate verifies that their
  executed-file union equals the full Vitest inventory, without duplicates.
- Renderer lanes retain configuration, lint, TypeScript, Chromium and production
  build/startup/performance. The first pilot preserves Safari13 on macOS and
  **both Safari13 and Chrome105 on Windows**; these are different outputs.
- WebKit stays on macOS 15 with serial file isolation and bounded batches. Its
  results must cover the same browser files as Chromium.
- The final gate rejects failed/cancelled/skipped/missing lanes, missing shards,
  missing or invalid reports, differing commit inputs and coverage drift.
- Rerun only failed lanes when the tested inputs are unchanged, as a bounded
  diagnostic action. Keep logs and investigate recurring failures. Never turn
  retries into an automatic substitute for synchronization or containment.
- Failed-lane reruns retain earlier uploads. The gate lists artifacts through
  GitHub's REST API and downloads the newest exact lane artifact IDs, preserving
  prior failed evidence. Missing, expired, ambiguous or foreign uploads fail;
  there is no fallback to an older successful receipt. All existing receipt,
  head/base, inventory and lane-result validation remains mandatory.
- Browser production-startup checks cover emitted modules, visible shell, lazy
  Settings and reload. They do not establish installed-app/native IPC behavior.
  Native checks remain targeted to changed behavior, as described in `build.md`.

## Measuring improvements and caching

Compare existing runs with the next representative normal PRs: execution time,
queue time, failed-lane rerun time, first-pass success and runner minutes. Shard
balance matters. Do not add ten mandatory test runs to every merge or release.

Compiled Rust dependency caching is initially **off**. Trial it with the Verify
workflow's `compiled_rust_cache` manual input. After coverage parity and measured
benefit, the repository variable `MYTHRA_COMPILED_RUST_CACHE=true` enables it for
normal checks. Never enable it merely because the cache action succeeded.

The immutable Rust-cache action keys dependencies by compiler/manifests/lockfile/
flags plus OS/architecture and native build inputs. Workspace crates and cargo
binaries are excluded. Only trusted `main` runs save; PRs restore only. Cargo and
all tests still run. This execution cache is not a release artifact or validation
result and is not wired into privileged signing/packaging workflows.

Measure restore/save duration, size, hit rate and compilation saved. Disable the
trial if restoration erases the gain. Do not loosen assertions or increase
same-machine concurrency to reach an arbitrary timing target.

## GitHub enforcement rollout

`Verify gate` should become the required status check with an up-to-date base.
Do **not** require it on `main` before the new workflow is adopted: older topic
branches otherwise wait forever for a check they cannot emit. Update existing
branches after adoption. No mandatory human approval count, paid runners, merge
queue, automatic merging or new routine release tours are introduced here.

Until adoption, legacy workflow commits require both `Verify (...)` OS checks
and `WebKit (macOS 15)`. Keep `build.md` and release finalization compatible with
their exact-commit evidence; a missing new gate is not a valid fallback when the
commit contains the new workflow.
