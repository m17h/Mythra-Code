# Windows build and release

Build the Windows application from the shared
[m17h/Mythra-Code](https://github.com/m17h/Mythra-Code) source tree on Windows.

## Development

```powershell
npm ci
npm run desktop
```

Automated tests and checks are disabled locally and on GitHub until Morgan
explicitly reintroduces them. Compilation remains available.

## Releases

Releases are started from the Mac with `npm run release -- <version>`; see
[Building and publishing a release](../docs/operations/releasing.md). The Mac
copies `scripts/release-windows.ps1` to this PC over SSH, which checks out the
release commit in a persistent build checkout and runs:

```powershell
npm run release:windows:build
```

`Windows/build.ps1` installs pinned dependencies, compiles with
`src-tauri/tauri.windows.conf.json`, signs the NSIS installer with the Windows
updater key and stages the installer, its `.sig`, `build-info.json` and a
Windows `latest.json` in `RELEASE ASSETS/`. The Mac downloads these and
publishes them together with macOS; this PC never publishes on its own.
Signing credentials stay on this machine. The installer is not
Authenticode-signed.
