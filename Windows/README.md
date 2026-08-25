# Windows build and release

The Windows application is built from the same source tree as macOS in
[`m17h/Mythra-Code`](https://github.com/m17h/Mythra-Code). Run these commands on a
Windows machine after checking out the desired branch or tag.

## Development

```powershell
npm ci
npm run desktop
```

## Release build

```powershell
npm run release:windows:build
```

The builder:

- runs repository verification before compiling;
- layers `src-tauri/tauri.windows.conf.json` over the shared configuration;
- uses the existing Windows updater signing key;
- creates an NSIS installer and signed updater manifest; and
- stages generated files in `RELEASE ASSETS/`.

The default local signing key paths remain
`~/.tauri/openkiwi-windows-updater.key` and
`~/.tauri/openkiwi-windows-updater-password.xml`. The password file is a
PowerShell CLIXML export of a `SecureString`. Environment variables may override
those paths as documented by Tauri.

## Publish

```powershell
npm run release:windows:publish
```

Publish Windows artifacts to the draft GitHub release for the matching `vX.Y.Z`
tag in `m17h/Mythra-Code`. The macOS builder attaches its assets to that same
release and the publishers merge both entries into one `latest.json`. After both
platforms upload, run `npm run release:finalize`; do not create or publish a
platform-specific tag or release.

`latest.json` uses the canonical release URL and the Windows platform key
`windows-x86_64`.
