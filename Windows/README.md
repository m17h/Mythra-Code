# OpenKiwi for Windows

This directory contains the Windows build pipeline for the independent
[`m17h/OpenKiwi-Windows`](https://github.com/m17h/OpenKiwi-Windows) repository.
macOS is built, signed, notarized, and released separately from the owner's
MacBook in its own repository.

## Build directly on Windows

Run PowerShell from a clean checkout:

```powershell
npm run release:windows
```

You can also invoke `./Windows/build.ps1` directly. On the publisher's Windows
account, the encrypted updater key defaults to
`~/.tauri/openkiwi-windows-updater.key`, and its password is loaded from the
Windows DPAPI-protected
`~/.tauri/openkiwi-windows-updater-password.xml`. Environment variables remain
available as an override for another secure publisher setup.

At the start of every release build, the script deletes the previous generated
files from the repository-root `RELEASE ASSETS/` directory. This happens before
verification or compilation so a failed build cannot leave stale assets that
look current. The tracked `RELEASE ASSETS/README.md` is preserved.

The script runs the complete verification suite, builds the x64 NSIS setup
executable, verifies that it uses the Windows GUI subsystem so no terminal
window appears, performs a launch smoke test, validates version and updater
signature metadata, and stages only the current release's:

- `OpenKiwi_<version>_x64-setup.exe`
- `OpenKiwi_<version>_x64-setup.exe.sig`
- `build-info.json`
- `latest.json`

`latest.json` points only to the `m17h/OpenKiwi-Windows` GitHub release channel.
After the build commit has been pushed and the Windows Verify workflow passes,
publish these assets to that repository with:

```powershell
npm run release:publish
```

## Signing policy

OpenKiwi for Windows installers are intentionally not Authenticode-signed.
Windows SmartScreen may therefore identify the publisher as unknown. The Tauri
updater artifact still carries a Windows-repository-specific cryptographic
signature so installed copies can verify that an update was produced by this
release process. This updater signature is independent of Windows publisher
signing.
