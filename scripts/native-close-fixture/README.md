# Isolated native close regression fixture

This is a nonbundled, synthetic native test harness, not a release build or a
platform fork. Candidate imports the exact production `close_guard.rs` and
`useFlushOnClose`. Baseline disables that native guard and uses the historical
JS-close behavior. Both run actual Tauri/WebView windows.

The three executables and identifiers are distinct from Mythra Code:

- `mythra-native-close-test`, `com.mythra.nativeclosetest`
- `mythra-native-close-baseline`, `com.mythra.nativeclosebaseline`
- `mythra-native-startup-test`, `com.mythra.nativestartuptest`

Only fixture-owned synthetic audit/save files are written. The dummy backend
is the fixture executable running `--synthetic-backend`, waiting for its
parent-owned stdin pipe to close. No keyring, providers, production database,
Codex CLI, network model calls, updater, or installer is initialized.

Build frontend from repository root with
`node scripts/native-close-fixture/build-frontend.mjs`. Build native bins on
the target OS with `node scripts/native-close-fixture/build-native.mjs`.
This helper mechanically seeds the generated fixture lock from the production
`src-tauri/Cargo.lock`, builds offline with four jobs, applies the authoritative
Windows overlay on Windows, and rejects differing core runtime lock versions.
Missing cached dependencies fail clearly instead of silently resolving newer
ones. Ensure at least 1,500 MiB free before compiling; the helper checks this.
An existing target dependency cache may be reused with `CARGO_TARGET_DIR`;
neither binary is named `mythra-code`. No bundling/signing/release command runs.

Before fault injection, record exact executable hash, PID, creation timestamp,
profile directory, fixture backend PID, and WebView browser parent/profile.
Require `close-listener-registered` in fixture audit before stopping only that
verified browser PID. Native Close must hang for the baseline; candidate must
show native consent, Keep open must retain the fixture, and confirmed Close
must stop its owned backend. Healthy close must record `flush-saved` first.
Independently verify the exact host and owned backend PIDs are absent after
close; `synthetic-backend-stopped` audit text alone is not termination proof.
Inspect actual native UI, not only logs. Never target an unrelated WebView or
the real Mythra app. Fixture results do not prove production provider cleanup
or establish the prior RTSS crash's cause.

The startup executable imports the exact production `startup_guard.rs` and
explicitly constructs the original configured windows. Its UI withholds ready
until you choose **Acknowledge ready**, allowing the real 60-second one-shot
deadline to run. Verify Keep waiting, Enter, Escape, and Cancel retain the
window; wait past a second deadline to confirm there is no second warning.
Explicit Close must use the unchanged close guard and stop the synthetic
backend. Acknowledge ready while a warning is open, then choose Close: the
recovered window must remain. **Show useful failure** displays a static error
and reports `app-import`, suppressing the redundant native timeout.

Startup-only command-line fixture modes (never production fault hooks):

- `--early-ready` acknowledges after construction, before timer installation;
  verify no timeout dialog after 60 seconds.
- `--setup-failed` invokes the production fatal setup dialog before any window
  or backend exists. Verify it appears without an event-loop deadlock, and its
  Close acknowledgment, Escape/X dismissal, or dialog error exits nonzero.
- `--window-failed` cancels the prepared startup generation and invokes the
  production window-construction error dialog without constructing a window.
  This exercises returned-failure containment, not a hung WebView constructor.

A fatal setup failure with no main window ends the unusable host when its
dialog finishes. If a main window exists, only an explicit Close choice enters
the normal close guard. The ordinary 60-second startup stall warning always
keeps the window open on Keep waiting, Escape, Cancel, or a dialog error.

When launched through packaged Codex Computer Use, Windows can transparently
virtualize the logical AppData paths into that package's `LocalCache`.
Locate only the exact fixture identifier directories, confirm their synthetic
audit ownership, and continue checking the browser's logical identifier path.
Never broaden filesystem inspection to real application or Codex profile data.
