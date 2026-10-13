# Native release QA retired

Automated and mandatory native GUI testing is disabled until Morgan explicitly
reintroduces it. Releases do not select startup, onboarding, save/close/reopen,
storage, installer, predecessor-upgrade or performance test cases. They do not
launch QA agents, require screenshots/accessibility receipts, or create
upgrade-coverage evidence.

Build and package each requested version on its native OS, sign updater assets,
notarize macOS, upload both platform asset sets, and publish one combined updater
manifest. Follow [releasing.md](releasing.md) and the
[release coordinator](release-coordinator.md).

Existing QA profiles and release records may contain useful user-owned evidence.
Disabling QA does not authorize deleting them, changing production profiles or
closing an active application. If cancelling an existing worker, stop only its
owned process tree and preserve data/records. Do not treat a cancelled release
or an old QA receipt as a published release.
