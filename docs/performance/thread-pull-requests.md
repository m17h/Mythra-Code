# Local Git and pull-request workflow performance notes

The expanded local/GitHub workflow has a fresh controlled production-bundle comparison against the previous thread pull-request implementation at `bb9cc78`. Both sides used the same dependencies, Node 26.0.0 and minified Vite profiles on Apple silicon macOS. This is a size review, not evidence of faster rendering, lower memory use, lower CPU use or faster Git/GitHub operations.

The current snapshot is the final production rebuild after the local merge-target guard and Git action wiring fixes. The checked-in limits match these measured bundles exactly, without additional headroom. Full repository verification remains separate from this bundle comparison.

| Target / raw bytes | Previous PR workflow | Expanded workflow | Change |
| --- | ---: | ---: | ---: |
| safari13-minified / appEntryRawBytes | 396,661 | 413,732 | +17,071 |
| safari13-minified / startupJsRawBytes | 775,653 | 793,304 | +17,651 (+2.28%) |
| safari13-minified / startupCssRawBytes | 364,225 | 364,468 | +243 |
| safari13-minified / totalJsRawBytes | 1,577,029 | 1,609,562 | +32,533 (+2.06%) |
| safari13-minified / totalCssRawBytes | 404,343 | 414,536 | +10,193 |
| chrome105-minified / appEntryRawBytes | 375,532 | 392,120 | +16,588 |
| chrome105-minified / startupJsRawBytes | 746,409 | 763,563 | +17,154 (+2.30%) |
| chrome105-minified / startupCssRawBytes | 357,706 | 357,949 | +243 |
| chrome105-minified / totalJsRawBytes | 1,536,545 | 1,567,952 | +31,407 (+2.04%) |
| chrome105-minified / totalCssRawBytes | 397,202 | 407,219 | +10,017 |

The JavaScript increase implements local branch snapshots and guarded switching, staged/unstaged commit paths, guarded local-base update, durable all-ref publication state, restart/backoff/recovery logic, immutable commit-SHA publication, exact remote compare-and-swap after descendant proof, native binding/upstream/history validation, attached-PR identity routing and worktree completion checks. No dependency or model request was added. The Git workflow stylesheet is imported by the lazy workflow components, so almost all of its roughly 10 KB raw CSS cost stays out of startup; startup CSS grew by only 243 bytes on both targets.

This is an accepted functionality and safety cost, not a speedup claim. A meaningful further reduction in the eager JavaScript would require restructuring App-owned Git state and controllers behind another runtime boundary. That is not a proportionate late-stage offset for this change.

## Current runtime bounds

Local workspace status is read on demand by native Git commands. Branch changes and local-base updates revalidate the captured branch and commit before mutation. Network fetch and publication commands are bounded and non-interactive, and repository mutations share a repository-level lock.

Automatic publication is off by default. When at least one project opts in, one controller cycle serially scans enabled projects every five seconds. A snapshot uses local Git refs and the worktree list to observe all local branches and which branches are checked out. It does not make one network call per unchanged branch. Only durable pending tips invoke remote inspection or push work. Concurrent refresh requests coalesce into the serialized cycle; unchanged idle and waiting states do not write storage or trigger React renders.

The controller keeps one durable record per opted-in project and one compact record per observed local branch. New commits are coalesced to the newest observed tip before the next publication attempt. Retryable transport/authentication failures back off from five seconds to at most sixty seconds. Paused identity, mapping and history failures do not busy-loop. Turning publication off cancels future controller work; an already-started native push may finish, but generation guards prevent its late result from re-enabling or rewriting the disabled UI state.

Pull-request status reads still share in-flight requests, cache up to 64 results and poll only the visible linked thread every 60 seconds. Document hiding pauses its recurring status reads, and closing the Git panel removes that timer. PR read caches and rendered review lists remain bounded. GitHub mutations and Git publication have bounded subprocess execution.

These are code-level limits, not measured responsiveness results. The five-second scan interval is a product latency bound while the app is running, not a promise that publication completes within five seconds; active workspace operations, backoff, authentication, network latency and server policy can extend it. Automatic publication is not a background service while Mythra Code is closed.

## Historical first PR-panel baseline

For provenance, the following table measured the earlier pull-request-only change against `0ff56d0` (v1.17.5), with identical installed dependencies and Node 26.0.0 production Vite builds on macOS. It predates the expanded workflow and is not the current comparison.

| Target / raw bytes | Before | Earlier PR-only build | Change |
| --- | ---: | ---: | ---: |
| safari13-minified / appEntryRawBytes | 380,346 | 396,661 | +16,315 |
| safari13-minified / startupJsRawBytes | 756,716 | 775,653 | +18,937 |
| safari13-minified / startupCssRawBytes | 363,306 | 364,225 | +919 |
| safari13-minified / totalJsRawBytes | 1,528,800 | 1,577,029 | +48,229 |
| chrome105-minified / appEntryRawBytes | 360,236 | 375,532 | +15,296 |
| chrome105-minified / startupJsRawBytes | 728,560 | 746,409 | +17,849 |
| chrome105-minified / startupCssRawBytes | 356,763 | 357,706 | +943 |
| chrome105-minified / totalJsRawBytes | 1,489,645 | 1,536,545 | +46,900 |

That earlier increase implemented the initial PR panel and was not evidence of faster rendering or lower memory use.

## Validation boundary

Both configured minified targets have been rebuilt after the final production wiring changes, and their stable values are recorded in `scripts/performance-budgets.json` without extra headroom. The normal full repository verification has not yet been claimed here. Runtime performance claims still require:

- production bundle and startup-chunk bytes against the agreed baseline with the same toolchain and dependencies;
- idle CPU and native process activity with automatic publication off;
- idle CPU, local Git process count and storage writes with one and several opted-in repositories;
- commit-to-publication latency for UI, terminal and worktree commits;
- offline retry cadence, restart recovery and long-running push behavior; and
- narrow-dock interaction checks plus macOS and Windows native behavior.

Functional unit, browser and disposable-repository tests establish behavior and boundedness. They do not substitute for those measurements or for an authenticated publication smoke test.
