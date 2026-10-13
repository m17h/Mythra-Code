# Release coordination

Release authorization and version selection belong to Morgan. Personal machine
paths, credentials, local retention rules and operator instructions stay outside
the repository. Follow [releasing.md](releasing.md) and
[release-coordinator.md](release-coordinator.md) for portable commands.

Automated tests and checks are disabled locally and on GitHub until Morgan
explicitly reintroduces them. No CI receipt, native GUI result, upgrade-coverage
plan, performance scorecard or independent audit is a merge or release gate.

Freeze the requested version at one clean merged source in a dedicated checkout.
Build macOS and Windows on their native machines, retaining their updater keys.
Sign the updater packages and notarize macOS. Upload both platform asset sets to
one draft, generate the combined manifest, and finalize publication through one
publisher. Compilation, signing, notarization and publication must actually
complete; a queued worker or successful merge is not a published release.

Resume the existing owned worker/state after a transport interruption. Reuse
completed packages when their source/version and package records still match;
an upload failure alone does not call for rebuilding. Diagnose the failure
before a bounded retry. Cancellation must stop owned descendants before a
replacement publisher starts.

Cleanup preserves source, real profiles, active applications and retained
release records. A Git worktree does not isolate application data. No automatic
application launch or native QA tour is part of publication.
