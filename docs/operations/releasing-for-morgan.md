# Releasing Mythra Code

## What you say

In the Mythra Code project, say:

> Run build.md. Release version X.Y.Z. Tell me on Telegram when it is released.

That authorizes the version change, native builds, signing, draft uploads,
publication and completion message under the existing release rules. You do not
need to prepare a plan JSON, choose test commands, coordinate the Windows worker,
or approve each routine step. Those are the release agent's responsibilities.

You can keep working on other branches. The agent must freeze the release source
in its own checkout and keep its packages and progress outside development output.
An isolated native test profile is a separate requirement; a Git worktree does
not protect your application data by itself.

## What happens

1. The agent prepares and merges the version change through the normal verified
   PR workflow, then freezes the exact merged commit.
2. It compares that source with the last accepted public release, including any
   withdrawn version users installed. The saved plan explains each extra check.
3. Mac and Windows build their native packages. Complete verification on the
   exact merged source is reused where the maintained builder supports it.
4. Native startup, close, saved-data, onboarding or installer checks run when
   the changed boundary or a known failure requires them. An ordinary unrelated
   UI change does not need a fresh manual tour.
5. One publisher uploads both platforms, audits the downloaded draft, publishes
   it, and checks the public downloads and updater feed. Only then is the release
   complete and the Telegram completion message sent.

Signing, notarization, package hashes, provenance, complete hosted verification
and the combined updater manifest stay required. These are release protections,
not optional tours through the application.

## Checking progress

Ask the release chat:

> What stage is the release at, and what is actually blocking it?

The answer should name a saved stage and actual worker state. A request being
queued, a helper finishing its prompt, and a package being built are different
from a published, verified release.

For an operator, the coordinator commands are:

```sh
npm run release:status -- --state /absolute/release-state
npm run release:resume -- --state /absolute/release-state --build --upload --publish
```

The release agent records the actual state directory at kickoff. See
[the operator runbook](release-coordinator.md) for plan creation, native machine
handoffs, evidence and recovery details.

## Interruptions and failures

A restart should reuse valid completed stages. An upload failure does not need
another build. A changed source or regenerated package invalidates the affected
checks. A failed assertion needs a diagnosis before a retry.

A real blank window remains a blocker. The agent should investigate it and
preserve your data, rather than announce a successful release or ask you to
click through a known failure. If your input is genuinely necessary, it should
explain the missing fact in plain language.

Automatic continuation must have a verified running worker or monitor. The
agent must state any missing driver or unavailable machine explicitly. These
commands alone are not proof that unattended native UI automation is installed;
the operator runbook describes the supported adapters and their current limits.

When workers may outlive the active chat turn, the agent creates and verifies a
supported follow-up heartbeat in that same chat for the actual version and saved
state. It checks ownership before resuming, stays quiet when nothing actionable
changes, and pauses after public verification and the authorized notification.

Some selected native cases still need capabilities beyond the current harness:
save-failure injection and an isolated OS for installer tests are not implemented.
A terminal partial Windows handoff needs the release agent to diagnose and
collect its existing evidence. The agent owns those recovery commands; it should
not hand routine export/merge work back to you or claim a missing adapter passed.

There is one current Mac limitation: the computer-use tool can select the working
app instead of a second copy with the same app identity, even when given the
second copy's full path. A native check must verify the isolated window's unique
title before acting. If it cannot select that window safely, it reports a blocker.
It must not click in your working app or claim that the isolated check passed.
Routine releases that do not need those additional native checks can still use
the automated build, audit and publication stages.

## Why this approach

T3 Code fixes the source commit for a release and coordinates parallel native
builds with ordered publication. We adopt that separation between development,
building and publishing. Mythra still needs its own platform outputs and signing
rules. [T3 Code's release guide](https://github.com/pingdotgg/t3code/blob/main/docs/operations/release.md)
and [workflow](https://github.com/pingdotgg/t3code/blob/main/.github/workflows/release.yml).

The successful 1.22.2 source verification took about 10 minutes and its Windows
builder about 12 minutes. Hours of repeated coordination and fragile profile
setup were additional time. Saved stages and reliable isolation address those
delays; removing tests alone would not. There is no guaranteed release duration:
compiler caches, runner queues, notarization and genuine defects still vary.
