# Release coordination

Release authorization, version selection and machine-specific operator policy
belong to the release operator. Repository scripts do not grant that authority.
Personal agent instructions, local retention rules, credentials and machine
paths should remain outside the source repository.

See [release-coordinator.md](release-coordinator.md) for portable planning,
stage status, ownership, native handoffs, evidence and recovery commands.

The release source is frozen in an isolated checkout. Native package builds
may overlap each other and pending verification on that exact merged source.
Such packages remain provisional: draft upload, publication and public acceptance
require the full CI evidence and applicable platform audits. No signing,
startup, package-hash, provenance or combined-manifest checks are bypassed.

Completed stages are immutable and reusable only while their source, dependency
and package evidence remains valid. Diagnose failures before a bounded retry;
an upload failure alone does not require rebuilding an approved package.

Source worktrees do not isolate application data. Required native checks must
use supported isolated profiles and verify the intended application/window.
Missing drivers or incomplete native evidence are blockers, not passing checks.

Post-publication local housekeeping is deliberately not part of the release
acceptance graph. An operator may independently reclaim owned generated output
under a private policy after public verification. It must not alter retained
release evidence or turn a published successful release into a failed one.
