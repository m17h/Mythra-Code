# PR 108 review repairs

Three independent Sol reviews covered workflow execution and recipes, feedback
and queued prompts, and checks/discovery/native execution. The parent reviewed
the App integration and challenged the fixes.

## Confirmed repairs

- Reserve a workflow thread until the entire recipe is terminal. Queued prompts
  cannot run between steps; late question answers remain literal, and pending
  native questions retain their original response channel. Stop targets the
  whole workflow, and interruption/failure leaves queued work waiting.
- Protect workflow-owned threads from archive, delete, transcript eviction and
  conflicting checkpoint operations during command steps and between turns.
- Show saved access mode in every workflow run preview. Explain when feedback,
  attachments or queued messages prevent a selected recipe from launching.
- Reject a late Run finder result if a newer manual or agent recipe was saved.
  Navigation still saves a valid result to the originating project.
- Bound optional Git metadata collection before checks to three seconds. Stop
  unblocks this preflight immediately; timeout proceeds without a Git head.
  The underlying native lookup is not terminated by this renderer deadline.
- Only mark a workflow command as launched when its execution begins, and
  report rejected termination instead of claiming that Stop succeeded.

## Evidence

Focused tests hold workflow checkpoint finalization to reproduce the gap between
turns, cover native question routing, and exercise Composer Stop with a held queue.
Deferred discovery tests cover navigation and newer command writes. Deferred Git
tests cover cancellation, timeout, and late metadata results.

The refreshed isolated macOS development app showed access mode before launch,
completed two Claude Haiku steps, queued a follow-up and delivered it afterward.
The deterministic regression supplies the exact between-step collision evidence.

The initial hosted macOS verification passed. Windows caught a quoted setup
failure that escaped the original direct-CMD smoke tests. The reviewer reproduced
it through both Windows process spawning and Codex App Server command/exec before
repair, keeping this separate from claims based on mocked provider tests.

The Windows repair keeps the displayed command intact and uses an encoded
PowerShell transport to start one CMD with raw arguments. Setup and launch share
its environment and working directory. Both the header Run button and agent Run
tool use this path. Native Windows Vitest passes 11/11. Direct App Server probes
verified quoted executables, exit 7 and negative setup failure gating, quoted
folders and environment, PTY output, and termination without an orphaned child.
Full Windows desktop UI interaction was not exercised.

## Measured review cost

Compared with the initial PR, startup JavaScript grows by 4,267 bytes on Safari
and 4,012 bytes on Chrome (under 0.5%). Startup CSS grows by 96 bytes. Total
JavaScript grows by 4,284 and 4,020 bytes respectively. Exact limits are recorded
in scripts/performance-budgets.json. No dependencies, automatic model requests,
idle polling, or animation reductions were added. Windows encoding runs only
when launching a command.

The final cross-check reproduced quoted working-directory and executable failures
in new Checks commands through real Windows App Server execution. The proven
transport now also covers Checks and workflow command steps, retaining their
process IDs, timeouts and cancellation paths. A native Windows regression using
both a quoted folder and executable passed (5/5 shell-helper tests).
