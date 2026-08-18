# OpenKiwi Windows Repository Instructions

## Mission

This repository is the independent Windows version of OpenKiwi. Its only GitHub
home is `https://github.com/m17h/OpenKiwi-Windows` and all work here must affect
only the Windows product.

The macOS product is maintained, built, signed, notarized, and published
separately from the owner's MacBook. macOS remains the priority product, but it
is not built or released from this repository. Never copy Windows changes into,
push to, publish to, or otherwise modify the separate macOS repository.

## Repository isolation

- `origin` must be the only configured Git remote and must point to
  `https://github.com/m17h/OpenKiwi-Windows.git` for fetch and push.
- Do not add the macOS repository as a remote, submodule, package source,
  updater endpoint, raw-content source, CI target, or publishing target.
- All GitHub URLs used by the Windows app, updater, documentation, build
  scripts, and release scripts must point to `m17h/OpenKiwi-Windows`.
- Do not create branches, tags, releases, pull requests, issues, or commits in
  any other repository from this checkout.
- Shared historical ancestry does not authorize syncing or publishing across
  repositories. Import anything external only with explicit user approval and
  review it as new Windows code.

Before any GitHub write, confirm `git remote -v` lists only the Windows origin
and confirm every explicit `--repo` target is `m17h/OpenKiwi-Windows`.

## Platform scope

This codebase targets Windows. Windows fixes may modify application code,
configuration, dependencies, tests, and build tooling directly; they do not
need to preserve macOS compilation inside this repository. Prefer Windows-native
paths, process handling, packaging, shortcuts, and integration behavior.

Do not add or run Apple signing, notarization, DMG, `.app`, macOS publishing, or
macOS CI workflows. Remove inherited macOS-only release machinery rather than
adapting it here. Do not edit generated schemas in `src-tauri/gen/schemas/` by
hand.

The embedded Tauri updater public key is a compatibility boundary. Do not
replace it casually: installed clients trust that key. A key change requires an
explicit migration plan and the user's approval.

## Required development workflow

Before editing:

- Read the relevant implementation, tests, and `Windows/README.md`.
- Run `git status --short` and preserve unrelated user changes.
- Confirm the planned behavior and validation are Windows-specific.

While editing:

- Add or update focused tests for behavioral changes.
- Keep secrets out of files, logs, commits, fixtures, and command output.
- Do not weaken updater-signing, provenance, hash, CI, or launch checks to make
  a build pass. Windows installers are intentionally not Authenticode-signed.
- Do not commit generated files from `RELEASE ASSETS/`, `dist/`, or
  `src-tauri/target/`.

After editing:

- Review `git diff --check`, `git diff`, and `git status --short`.
- Run focused tests followed by `npm run verify` for code changes.
- Exercise changed behavior on Windows. Use `npm run desktop` for a local launch
  when appropriate.
- Require the Windows GitHub Actions Verify workflow to pass before publishing.

## Dogfooding installed updates

- Treat the installed OpenKiwi application as a normal end-user installation.
- Never replace, overwrite, or copy a locally built `openkiwi.exe` into the
  installed application directory.
- Test local builds by launching them from the repository build output only.
- Validate installation and upgrades through the same published installer or
  updater-signed in-app flow that normal Windows users receive.

Documentation-only changes do not require the full build suite, but still need
diff review and link/command verification.

## Explicit release authorization

Never change the application version, create or replace release assets, run
`npm run release:build`, run `npm run release:publish`, or create, edit, or
delete a release or release tag unless the user's current request explicitly
asks to **run `BUILD.md`**. A request for a feature, fix, major update, release
planning, or release readiness is not authorization to version, build, tag, or
publish anything. When the user explicitly asks to run `BUILD.md`, follow that
file exactly and use only the version the user specifies.

## Windows release assets

All new Windows release assets must be staged in the repository-root
`RELEASE ASSETS/` directory.

Before starting a release build, delete every generated asset from the previous
release while preserving only the tracked `RELEASE ASSETS/README.md`. Clear the
old artifacts before verification or compilation so a failed build cannot leave
stale files that look current. Never accumulate multiple versions there.

A successful x64 release build must leave only the README and these current
release files:

- `OpenKiwi_<version>_x64-setup.exe`
- `OpenKiwi_<version>_x64-setup.exe.sig`
- `build-info.json`
- `latest.json`

`latest.json` and every release URL must target only the
`m17h/OpenKiwi-Windows` release channel. Generated assets are ignored local
staging and must not be committed.

Use `npm run release:build` to run the Windows verification and release build.
It requires the Windows-only Tauri updater signing credentials and produces an
intentionally unsigned Windows installer. Use `npm run release:publish` only
after the exact build commit is pushed and Windows CI passes. Never bypass its
commit, updater-signature, hash, provenance, repository-target, or CI checks.

## Git discipline

- Work on a dedicated `windows/<topic>` branch based on the Windows repository's
  current `main`; do not develop directly on `main`.
- Do not merge, push to `main`, publish a release, or modify release tags unless
  the user explicitly asks.
- Keep commits focused so Windows changes can be reviewed and reverted safely.
- Never commit credentials, private signing keys, generated installers, updater
  signatures, or release provenance files.

## Completion standard

A task is complete only when the requested behavior works on Windows, relevant
checks pass, no secret or generated artifact is tracked, repository isolation is
intact, and any remaining release or CI validation is stated clearly.
