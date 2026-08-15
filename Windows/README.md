# OpenKiwi for Windows

This directory contains the Windows build pipeline for the independent
[`m17h/OpenKiwi-Windows`](https://github.com/m17h/OpenKiwi-Windows) repository.
macOS is built, signed, notarized, and released separately from the owner's
MacBook in its own repository.

## Build directly on Windows

Run PowerShell from a clean checkout:

```powershell
$env:TAURI_SIGNING_PRIVATE_KEY = "path or content of the updater private key"
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = "password from secure storage"
npm run release:windows
```

You can also invoke `./Windows/build.ps1` directly. Use `-AllowUnsigned` only
when the release has explicitly approved an unsigned Windows installer.

At the start of every release build, the script deletes the previous generated
files from the repository-root `RELEASE ASSETS/` directory. This happens before
verification or compilation so a failed build cannot leave stale assets that
look current. The tracked `RELEASE ASSETS/README.md` is preserved.

The script runs the complete verification suite, builds the x64 NSIS setup
executable, verifies that it uses the Windows GUI subsystem so no terminal
window appears, performs a launch smoke test, validates version and signature
metadata, and stages only the current release's:

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

## Signing

Until a trusted Authenticode certificate is installed, an unsigned build
requires the explicit `-AllowUnsigned` switch. Unsigned installers still need a
valid Tauri updater signature, but Windows SmartScreen will identify their
publisher as unknown. Do not remove the override requirement; install a trusted
Authenticode certificate instead.

When one valid code-signing certificate with a private key exists in
`Cert:\CurrentUser\My`, the build selects it automatically. If more than one is
installed, set `OPENKIWI_WINDOWS_CERTIFICATE_THUMBPRINT` to the intended
certificate. `OPENKIWI_WINDOWS_TIMESTAMP_URL` can override the default trusted
timestamp service.
