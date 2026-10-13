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

Release only when Morgan explicitly requests a version. Follow
[Building and publishing a release](../docs/operations/releasing.md) and the
[release coordinator](../docs/operations/release-coordinator.md).
Release 1.25.3 was cancelled and must not be resumed.

The coordinator invokes the native Windows builder from its frozen checkout:

```powershell
npm run release:windows:build
```

The builder installs pinned dependencies, compiles using
`src-tauri/tauri.windows.conf.json` over the shared configuration, retains
the existing Windows updater signing key, produces the NSIS installer/updater
signature, and stages generated assets in `RELEASE ASSETS/`. It does not run
repository verification, startup smoke, native GUI or package-audit tests.
Signing credentials stay on the native machine and out of GitHub/logs.
Do not claim Authenticode signing unless it was configured and actually done.

The designated publisher owns uploads. `release:windows:publish` attaches
Windows assets to the same draft/tag/version as macOS. Both platform entries
belong in one `latest.json`, with Windows key `windows-x86_64`, before
`release:finalize` publishes the combined release. Do not publish independently
from a native Windows worker or create a platform-specific release.

Preserve active applications, real profiles and existing source. Resume an
interrupted worker through its existing coordinator state; cancellation must
stop its owned descendants before a replacement owner starts.
