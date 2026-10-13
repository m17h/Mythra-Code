# Building and publishing a release

A release needs Morgan's explicit request and chosen version. Everything else
is one script, run on the Mac: `scripts/release.mjs`. It builds macOS locally
and Windows over SSH at the same time, from the same commit, then publishes one
GitHub release containing both platforms and a combined `latest.json`.

## Instructions for agents (any model)

Follow these steps exactly. The script already handles signing, notarization,
the Windows build, leftover processes, retries and publication. Your job is to
run it, write the release notes, and fix real errors it reports.

1. **Confirm the request.** Morgan must have asked for a release and named the
   version `X.Y.Z`. A merge or "it's ready" is not a release request.
2. **Prepare.** From the Mac checkout of this repository, with unrestricted
   sandbox, network and Keychain access:
   ```sh
   npm run release:prepare -- X.Y.Z --merge
   ```
   This opens and merges the version-bump PR (the release request authorizes
   that merge, with no separate merge chat or reviewers) and drafts notes at
   `~/.mythra-release/notes/X.Y.Z.md`.
3. **Write the notes.** Rewrite the drafted commit subjects in that file as
   short user-facing bullets under `# Mythra Code X.Y.Z` (see earlier releases
   on GitHub for the style) and delete the `<!-- DRAFT ... -->` line.
4. **Publish in the background:**
   ```sh
   npm run release -- X.Y.Z --background
   ```
   It returns once preflight passes (a few seconds). Then check progress every
   minute or two with `npm run release:status`. A release normally finishes in
   5–15 minutes. Status ends as `published` with the URL, or `failed` with a
   message.
5. **If it fails,** read the message and the log tail (`release:status`, or
   `~/.mythra-release/out/X.Y.Z/{mac,windows,release}.log`). Fix the actual
   cause (for a source error, a normal PR to `main`) and run step 4 again.
   Finished platform builds are reused, and leftover processes from the
   previous attempt are stopped automatically. If the same error repeats after
   three honest fixes, stop and report it to Morgan with the error text.
6. **Report** the release URL only after status says `published`.

Do not:

- add tests, CI waits, QA, smoke tests, audits, reviewers or verification
  stages, or "check" the published downloads;
- build or sign Windows by hand, log into Windows to babysit the build, or
  create scheduled tasks, services or diagnostic folders on either machine;
- write wrapper scripts, supervisors, monitors, heartbeat automations, journals
  or state files around the script, or start a second release run (the script
  refuses one while a run is active);
- change updater keys, edit `latest.json` by hand, publish one platform alone,
  or replace binaries in a published release (ship a new version instead).

To cancel a run: `npm run release:stop`. It stops the builds on both machines
and only reports success once nothing is left running on either. If it reports
anything unconfirmed (for example, the PC is unreachable), run it again.

## Commands

| Command | What it does |
| --- | --- |
| `npm run release:prepare -- X.Y.Z [--merge]` | Version-bump PR (reuses an open one), optional merge, notes draft |
| `npm run release -- X.Y.Z [--background]` | Preflight, build both platforms, publish |
| `npm run release:status [-- X.Y.Z]` | State of the current or named run, last log lines, GitHub state |
| `npm run release:stop` | Cancel the running release and confirm nothing is left on either machine (safe to repeat) |

`release` options: `--no-publish` builds both platforms without touching
GitHub; `--rebuild` ignores finished builds; `--commit <sha>` releases a commit
other than `origin/main`; `--notes <file>` uses another notes file.

## What `release` does

1. **Preflight (seconds).** It checks:
   - `gh` auth, and that `package.json` and `tauri.conf.json` at the commit are
     the requested version;
   - that the version is newer than the latest release and not already
     published;
   - that the notes exist, mention the version, and are no longer the draft;
   - the Developer ID identity, updater password and notarization credentials
     in the Mac Keychain;
   - that the Windows PC answers over SSH and has its updater key.

   It refuses to start while another run is active, and stops anything left
   behind by an interrupted run.
2. **Builds both platforms in parallel.**
   - macOS: a persistent worktree is checked out at the commit, then
     `npm ci` and `scripts/build-release.mjs` build, sign, notarize and staple
     the app and DMG and sign the updater archive.
   - Windows: `scripts/release-windows.ps1` is copied to the PC and run over
     SSH. It stops leftover processes from earlier runs (Windows keeps them
     alive after SSH disconnects), checks out the commit in a persistent
     checkout and runs `Windows/build.ps1`, which uses
     `src-tauri/tauri.windows.conf.json` and the Windows updater key. The
     assets are copied back and their SHA-256 is checked against the build
     record.

   If one platform fails, the other still finishes so its output can be reused.
   A platform is reused only if every file it publishes is present and matches
   the commit, so a half-finished download is rebuilt rather than reused.
   Each step has a generous deadline (two hours for a build with notarization)
   so a hung step fails with its name instead of stalling.
3. **Publishes.**
   - Writes one `latest.json` with `darwin-aarch64` and `windows-x86_64`.
   - Creates a draft `vX.Y.Z` targeting the commit, replacing an unpublished
     draft left by an earlier attempt at another commit.
   - Uploads all assets (retrying up to three times) and confirms each one
     arrived at full size.
   - Publishes the draft as the latest release.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `Cannot reach the Windows PC over SSH` | PC asleep, off the LAN, or its IP changed. Wake it or see the private LAN access guide. |
| Keychain, signing identity or notarization error in preflight | Running inside an agent sandbox. Re-run with unrestricted permissions as Morgan's Mac user. |
| `... is version X, not Y` | The version PR is not merged. Run `release:prepare -- Y --merge`. |
| `still the drafted commit list` | Rewrite the notes and delete the DRAFT line. |
| Compile error in both logs | A real source error on `main`. Fix it in a normal PR, then re-run. |
| Notarization rejected | Read `xcrun notarytool log <id> --keychain-profile <profile>` for the submission ID in `mac.log`. |
| `is already running` | Another run is active. Watch it with `release:status` or cancel with `release:stop`. |
| `did not finish within N minutes` | That step hung (often Apple notarization or the network). Its processes were stopped; re-run. |
| `could not be confirmed stopped` or `interrupted while taking over` | Run `npm run release:stop` (repeat until it confirms nothing is left), then re-run. |
| `Tag vX.Y.Z already exists at ...` | A tag from an earlier attempt points at other source. Delete it as the message shows, then re-run. |

## Machine setup (already done on Morgan's machines)

The script reads machine settings from the private
`~/.mythra-release/release.config.json`, kept out of this repository:

```json
{
  "mac": { "buildDir": "/absolute/mac/release/worktree", "notaryKeychainProfile": "notary-profile-name" },
  "windows": { "sshHost": "ssh-alias", "buildDir": "C:/short/build/path", "runnerPath": "C:/path/release-windows.ps1" }
}
```

Run state is `~/.mythra-release/run.json`; logs and built assets are in
`~/.mythra-release/out/<version>/`.

- **Mac:** Developer ID Application identity in the keychain, a `notarytool`
  keychain profile, the updater key at `~/.tauri/openkiwi-updater.key` with its
  password in Keychain as `com.openkiwi.updater-signing`, `create-dmg`, Rust,
  Node and `gh` authenticated for `m17h/Mythra-Code`.
- **Windows:** key-based SSH from the Mac, Git, Node, Rust with MSVC build
  tools, and the Windows updater key at
  `%USERPROFILE%\.tauri\openkiwi-windows-updater.key` with its DPAPI password
  file beside it. Keep the build path short to avoid Windows path-length limits.

macOS and Windows use different updater public keys (see `tauri.conf.json` and
`tauri.windows.conf.json`). Never replace either key without a migration plan,
or installed apps stop accepting updates. The Windows installer is updater-signed
but not Authenticode-signed.
