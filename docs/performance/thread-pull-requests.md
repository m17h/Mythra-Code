# Local Git and pull-request workflow performance notes

The expanded local/GitHub workflow has a fresh controlled production-bundle comparison against the previous thread pull-request implementation at `bb9cc78`. Both sides used the same dependencies, Node 26.0.0 and minified Vite profiles on Apple silicon macOS. This is a size review, not evidence of faster rendering, lower memory use, lower CPU use or faster Git/GitHub operations.

The current snapshot is the final production rebuild after the independent PR review fixes. The checked-in limits match these measured bundles exactly, without additional headroom. Full repository verification remains separate from this bundle comparison.

| Target / raw bytes | Previous PR workflow | Expanded workflow | Change |
| --- | ---: | ---: | ---: |
| safari13-minified / appEntryRawBytes | 396,661 | 415,285 | +18,624 |
| safari13-minified / startupJsRawBytes | 775,653 | 794,916 | +19,263 (+2.48%) |
| safari13-minified / startupCssRawBytes | 364,225 | 364,468 | +243 |
| safari13-minified / totalJsRawBytes | 1,577,029 | 1,611,298 | +34,269 (+2.17%) |
| safari13-minified / totalCssRawBytes | 404,343 | 414,536 | +10,193 |
| chrome105-minified / appEntryRawBytes | 375,532 | 393,629 | +18,097 |
| chrome105-minified / startupJsRawBytes | 746,409 | 765,131 | +18,722 (+2.51%) |
| chrome105-minified / startupCssRawBytes | 357,706 | 357,949 | +243 |
| chrome105-minified / totalJsRawBytes | 1,536,545 | 1,569,654 | +33,109 (+2.15%) |
| chrome105-minified / totalCssRawBytes | 397,202 | 407,219 | +10,017 |

The JavaScript increase implements local branch snapshots and guarded switching, staged/unstaged commit paths, guarded local-base update, durable all-ref publication state, restart/backoff/recovery logic, immutable commit-SHA publication, exact remote compare-and-swap after descendant proof, native binding/upstream/history validation, attached-PR identity routing and worktree completion checks. No dependency or model request was added. The Git workflow stylesheet is imported by the lazy workflow components, so almost all of its roughly 10 KB raw CSS cost stays out of startup; startup CSS grew by only 243 bytes on both targets.

The final independent review repairs added 1,612 Safari and 1,568 Chrome startup JavaScript bytes over the pre-review `8e3ff2b` snapshot, with no CSS growth. They cover post-confirmation workspace guards, same-thread pull-request mutation exclusion, exact attached-PR command routing, disabled-publisher timer removal and bounded polling. This is an accepted functionality, correctness and safety cost, not a speedup claim. A meaningful further reduction in the eager JavaScript would require restructuring App-owned Git state and controllers behind another runtime boundary. That is not a proportionate late-stage offset for this change.

## Current runtime bounds

Local workspace status is read on demand by native Git commands. Branch changes and local-base updates revalidate the captured branch and commit before mutation. Network fetch and publication commands are bounded and non-interactive, and repository mutations share a repository-level lock.

Automatic publication is off by default, and with no opted-in project it installs no polling timer. When at least one project opts in, one controller cycle serially scans enabled projects every fifteen seconds. App-driven Git mutations request an immediate scan; commits made outside the app, including terminal and worktree commits, are detected by the next periodic scan, within fifteen seconds while the app remains open. A snapshot uses local Git refs and the worktree list to observe all local branches and which branches are checked out. It does not make one network call per unchanged branch. Only durable pending tips invoke remote inspection or push work. Concurrent refresh requests coalesce into the serialized cycle; unchanged idle and waiting states do not write storage or trigger React renders.

The controller keeps one durable record per opted-in project and one compact record per observed local branch. New commits are coalesced to the newest observed tip before the next publication attempt. Retryable transport/authentication failures back off from five seconds to at most sixty seconds. Paused identity, mapping and history failures do not busy-loop. Turning publication off cancels future controller work; an already-started native push may finish, but generation guards prevent its late result from re-enabling or rewriting the disabled UI state.

Pull-request status reads still share in-flight requests, cache up to 64 results and poll only the visible linked thread every 60 seconds. Document hiding pauses its recurring status reads, and closing the Git panel removes that timer. An unchanged status result retains the existing durable link record, avoiding a storage write and React state update. PR read caches and rendered review lists remain bounded. GitHub mutations and Git publication have bounded subprocess execution.

The enabled-project snapshot currently uses eight local Git subprocesses. A 30-sample warm proxy benchmark ran the same eight read-only Git commands sequentially against this repository on Apple silicon macOS. It measured 137.56 ms median and 195.75 ms p95 wall time per snapshot. At the fifteen-second idle cadence, that is 32 Git subprocesses and about 550 ms of aggregate subprocess wall time per minute for each enabled project. This is an isolated subprocess benchmark, not a measurement of whole-app responsiveness, CPU use, energy use or memory use; enabled projects are scanned serially, and repository size, storage and Git configuration can change the result.

The fifteen-second scan interval is a product latency bound while the app is running, not a promise that publication completes within fifteen seconds. App-driven refreshes can detect work earlier, while active workspace operations, retry backoff, authentication, network latency and server policy can extend publication. Retryable failures retain a five-second initial backoff and increase to at most sixty seconds. Automatic publication is not a background service while Mythra Code is closed.

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

## Full pull-request comparison

The complete change from `0ff56d0` through the final reviewed build has the following JavaScript cost. The baseline values are the same controlled v1.17.5 measurements used above.

| Target / raw bytes | v1.17.5 baseline | Final reviewed build | Change |
| --- | ---: | ---: | ---: |
| safari13-minified / appEntryRawBytes | 380,346 | 415,285 | +34,939 |
| safari13-minified / startupJsRawBytes | 756,716 | 794,916 | +38,200 (+5.05%) |
| safari13-minified / totalJsRawBytes | 1,528,800 | 1,611,298 | +82,498 (+5.40%) |
| chrome105-minified / appEntryRawBytes | 360,236 | 393,629 | +33,393 |
| chrome105-minified / startupJsRawBytes | 728,560 | 765,131 | +36,571 (+5.02%) |
| chrome105-minified / totalJsRawBytes | 1,489,645 | 1,569,654 | +80,009 (+5.37%) |

## Validation boundary

Both configured minified targets have been rebuilt after the final production wiring changes, and their stable values are recorded in `scripts/performance-budgets.json` without extra headroom. The full repository verification and full Chromium/WebKit suites pass. Native Windows disposable-repository tests pass, and native macOS branch creation, switching and dirty-folder safeguards were exercised. These establish functional coverage, not a whole-app speedup. Broader runtime performance claims still require:

- idle CPU and native process activity with automatic publication off;
- idle CPU and storage writes with one and several opted-in repositories, plus native process tracing to confirm the isolated command-count proxy;
- commit-to-publication latency for UI, terminal and worktree commits;
- offline retry cadence, restart recovery and long-running push behavior; and
- a complete Windows WebView interaction session and authenticated end-to-end publication/merge through the app.

Functional unit, browser and disposable-repository tests establish behavior and boundedness. They do not substitute for those measurements or for an authenticated publication smoke test.

The ad hoc macOS development wrapper waited in the pre-existing Keychain lookup before spawning Codex, so its manual staged-commit attempt is not counted as passed. Credential protections were not changed for QA.
