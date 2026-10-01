# Mythra Code unified repository instructions

## Scope

This is the canonical cross-platform Mythra Code repository:
`https://github.com/m17h/Mythra-Code`.

Application behavior should remain shared across macOS and Windows unless an
operating-system boundary genuinely requires a platform-specific implementation.
Do not create platform forks or point application, updater, pricing, CI, or
release URLs at another repository.

## Development

- Work on a topic branch; do not push directly to `main`.
- Preserve unrelated changes and never commit secrets or generated release assets.
- Add focused tests for behavioral changes.
- Follow the merge rules below; hosted CI owns complete pre-merge verification.
- Exercise native behavior on the operating system it targets.
- Keep user-facing copy platform-neutral unless the behavior is platform-specific.

## Merging

These are the repository's authoritative merge rules. The operational commands
are in `docs/operations/merging.md`; release-only instructions stay in `build.md`.

- Keep one coherent concern per PR. Continue unrelated work on another topic
  branch/worktree while checks run; never mix changes just to fill the wait.
- Locally run focused regressions, relevant lint/type checks, and actual UI or
  native verification at the affected boundary. Do not repeat the full local
  `npm run verify` solely because a merge is requested. It remains available for
  diagnosing integration failures or when explicitly requested.
- Before merging, require successful **Verify gate** on the final tested PR
  head/base combination. It must include both native OS suites, both complete
  unit shards per OS, Chromium, all current production targets and startup/
  performance checks, and the full pinned macOS WebKit lane. Never treat missing,
  cancelled, skipped, or stale evidence as a pass. No assets-only fast path.
- Verify the PR head, base freshness, tested merge input and review findings.
  If the head changes or `main` advances, refresh and revalidate the combination.
  Merge only after explicit user authorization, matching the approved head SHA.
- Diagnose failed tests; do not suppress assertions or add blind automatic
  retries. A bounded manual rerun of only a failed lane may help investigation
  when inputs are unchanged, but intermittency is not a proven root cause.
- Follow `docs/operations/merging.md` when changing CI: preserve complete command
  and test-file coverage, exercise gate failures, and measure execution/queue/
  rerun time separately. Keep unit workers and WebKit isolation bounded.
- Delete obsolete merged topic branches locally and on GitHub after verifying
  merge evidence (including squash/rebase), switching off the branch, and
  preserving unmerged work, protected/open-PR branches and active worktrees.
- Report pre-merge and post-merge CI separately. A release still requires CI on
  its exact final merged commit; PR checks do not substitute for that evidence.

During migration, if the tested commit predates the split workflow and has no
Verify gate, require all three legacy checks: `Verify (macos-latest)`,
`Verify (windows-latest)`, and `WebKit (macOS 15)`. This is a versioned compatibility
rule, not permission to bypass a failed or missing new gate.

## Native builds

- macOS builds must run on macOS and use the base Tauri configuration.
- Windows builds must run on Windows and add
  `src-tauri/tauri.windows.conf.json`, which preserves the Windows updater key.
- The embedded updater keys are compatibility boundaries. Do not replace either
  key without an explicit migration plan.
- Generated macOS artifacts go in `release-assets/`; generated Windows artifacts
  go in `RELEASE ASSETS/`. Do not commit either directory's generated files.

## Releases

One version tag and one GitHub release in `m17h/Mythra-Code` owns the assets for
both platforms. Build on each native OS, attach both platform artifact sets to
the same draft release, then run `npm run release:finalize`. Never publish a
one-platform updater manifest.

Never change the version, build release assets, tag, sign, notarize, or publish
unless the user explicitly requests a release. Never weaken signing, hashes,
provenance, clean-tree, or CI checks to force a release through.
