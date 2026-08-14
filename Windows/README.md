# OpenKiwi for Windows

This directory contains the Windows release pipeline. Generated installers are
written to `Windows/latest/`, which is intentionally ignored by Git.

## Build on ZEDS-PC from the release Mac

From the repository root on the Mac, after the release commit has been pushed:

```bash
npm run release:windows
```

The orchestrator clones the exact local `HEAD` on ZEDS-PC, sends the Tauri
updater key to the build process over SSH standard input (never to disk), runs
the native Windows build, and copies the validated output back to
`Windows/latest/`.

Until a trusted Authenticode certificate is installed on ZEDS-PC, an unsigned
build requires an explicit one-release override:

```bash
OPENKIWI_ALLOW_UNSIGNED_WINDOWS=1 npm run release:windows
```

Unsigned installers still carry a mandatory Tauri updater signature, but
Windows SmartScreen will identify their publisher as unknown. Do not remove the
override requirement; install a trusted Authenticode certificate instead.

When one valid code-signing certificate with a private key exists in
`Cert:\CurrentUser\My`, the build selects it automatically. If more than one is
installed, set `OPENKIWI_WINDOWS_CERTIFICATE_THUMBPRINT` to the intended
certificate. `OPENKIWI_WINDOWS_TIMESTAMP_URL` can override the default trusted
timestamp service.

## Build directly on Windows

Run PowerShell from a clean checkout:

```powershell
$env:TAURI_SIGNING_PRIVATE_KEY = "path or content of the updater private key"
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = "password from secure storage"
./Windows/build.ps1
```

Use `-AllowUnsigned` only when the release has explicitly approved an unsigned
Windows installer. The script runs the complete verification suite, builds the
x64 NSIS setup executable, performs a launch smoke test, validates version and
signature metadata, and stages:

- `OpenKiwi_<version>_x64-setup.exe`
- `OpenKiwi_<version>_x64-setup.exe.sig`
- `build-info.json`

The macOS release preparation step consumes these files and adds the
`windows-x86_64` entry to `latest.json`.
