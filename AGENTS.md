# Mythra Code unified repository instructions

## Scope

This is the canonical cross-platform Mythra Code repository:
`https://github.com/m17h/Mythra-Code`.

Application behavior should remain shared across macOS and Windows unless an
operating-system boundary genuinely requires a platform-specific implementation.
Do not create platform forks or point application, updater, pricing, CI, or
release URLs at another repository.

## Development

- Work on a topic branch; do not push directly to `main`.
- Preserve unrelated changes and never commit secrets or generated release assets.
- Add focused tests for behavioral changes.
- Run `npm run verify` before merging.
- Exercise native behavior on the operating system it targets.
- Keep user-facing copy platform-neutral unless the behavior is platform-specific.

## Native builds

- macOS builds must run on macOS and use the base Tauri configuration.
- Windows builds must run on Windows and add
  `src-tauri/tauri.windows.conf.json`, which preserves the Windows updater key.
- The embedded updater keys are compatibility boundaries. Do not replace either
  key without an explicit migration plan.
- Generated macOS artifacts go in `release-assets/`; generated Windows artifacts
  go in `RELEASE ASSETS/`. Do not commit either directory's generated files.

## Releases

One version tag and one GitHub release in `m17h/Mythra-Code` owns the assets for
both platforms. Build on each native OS, attach both platform artifact sets to
the same draft release, then run `npm run release:finalize`. Never publish a
one-platform updater manifest.

Never change the version, build release assets, tag, sign, notarize, or publish
unless the user explicitly requests a release. Never weaken signing, hashes,
provenance, clean-tree, or CI checks to force a release through.
