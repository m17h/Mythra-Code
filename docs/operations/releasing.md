# Building and publishing a release

A release needs Morgan's explicit request and chosen version. Everything else
is one script, run on the Mac: `scripts/release.mjs`. It builds macOS locally
and Windows over SSH at the same time, from the same commit, then publishes one
GitHub release containing both platforms and a combined `latest.json`.

There are no test, CI, QA, audit or review stages. Compilation, signing,
notarization and upload still have to succeed; when one fails, the script stops
with the error and the end of the log, and you fix the cause and run it again.

## Release in three commands

```sh
# 1. Open and merge the version-bump PR, and draft release notes.
npm run release:prepare -- 1.26.0 --merge

# 2. Edit the drafted notes into user-facing bullets.
$EDITOR ~/.mythra-release/notes/1.26.0.md

# 3. Build both platforms and publish.
npm run release -- 1.26.0
```

Step 3 normally takes 10–20 minutes with warm caches (longer the first time on
a machine). It prints a progress line for each platform every minute and ends
with the release URL. Agents should run it as a background command and read
the logs rather than wrapping it in extra supervision.

A release request from Morgan authorizes merging its own version-bump PR with
`--merge`; that PR changes only version numbers. Drop `--merge` to leave the PR
open for review instead, and merge it before step 3.

## What `release` does

1. **Preflight (seconds).** Checks `gh` auth, resolves `origin/main` (or
   `--commit <sha>`), confirms `package.json` and `tauri.conf.json` at that
   commit are the requested version, that the version is newer than the
   current published release and not already published, that the notes file
   exists and mentions the version, and that the Windows PC answers over SSH.
2. **Build both platforms in parallel.**
   - macOS: a persistent worktree is checked out at the commit, then
     `npm ci` and `scripts/build-release.mjs` build, sign, notarize and staple
     the app and DMG and sign the updater archive.
   - Windows: `scripts/release-windows.ps1` is copied to the PC and run over
     SSH. It checks out the commit in a persistent checkout and runs
     `Windows/build.ps1`, which uses `src-tauri/tauri.windows.conf.json` and
     the Windows updater key. The assets are copied back and their SHA-256 is
     checked against the build record.
   If one platform fails, the other still finishes so its output can be reused.
3. **Publish.** Writes one `latest.json` with `darwin-aarch64` and
   `windows-x86_64`, creates a draft `vX.Y.Z` targeting the commit, uploads
   all assets (retrying up to three times), confirms every asset arrived at full
   size, then publishes the draft as the latest release.

## When something fails

Run the same command again. Each platform is skipped when its finished assets
already match the version and commit, so a Windows-only failure rebuilds only
Windows, and an upload failure rebuilds nothing. Use `--rebuild` to force fresh
builds. `--no-publish` builds both platforms without touching GitHub.

| Symptom | Likely cause |
| --- | --- |
| `Cannot reach the Windows PC over SSH` | PC asleep, off the LAN, or its IP changed. See the private LAN access guide. |
| `package.json ... is version X, not Y` | The version PR is not merged yet. |
| Compile error in both logs | A real source error on `main`. Fix it in a normal PR. |
| Notarization error | Check `xcrun notarytool history --keychain-profile <profile>` on the Mac. |
| `A stale draft vX.Y.Z targets ...` | A draft from an older commit exists. Delete it with `gh release delete vX.Y.Z` (drafts are never public). |

Pressing Ctrl-C stops both builds; closing the SSH session ends the Windows
build. Nothing is published until every asset is uploaded.

## Machine setup (already done on Morgan's machines)

The script reads machine settings from the private
`~/.mythra-release/release.config.json`, kept out of this repository:

```json
{
  "mac": { "buildDir": "/absolute/mac/release/worktree", "notaryKeychainProfile": "notary-profile-name" },
  "windows": { "sshHost": "ssh-alias", "buildDir": "C:/short/build/path", "runnerPath": "C:/path/release-windows.ps1" }
}
```

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

## Rules that stay

- Never publish a one-platform `latest.json` or replace binaries in a published
  release; ship a new version instead.
- Generated assets stay out of Git (`release-assets/`, `RELEASE ASSETS/`, and
  `~/.mythra-release/out/<version>/`).
- Report a release as done only after the script prints the published URL.
