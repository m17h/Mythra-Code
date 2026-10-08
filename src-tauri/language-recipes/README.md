# Managed language recipes

These eleven private manifests and npm lockfile v3 graphs preserve the curated
catalog versions. The application embeds JSON metadata and downloads packages
from the npm registry into its private storage; it does not embed package bytes.
Every locked package has an exact version, an npm-registry HTTPS tarball and
SHA-512 integrity. Recipe identity hashes the exact manifest and lock bytes,
recipe version, and the fixed `npm ci` policy in `language_recipes.rs`.

Installs disable lifecycle scripts, auditing, funding requests and development
dependencies. Optional packages remain enabled: the Solidity graph contains
Darwin, Windows and other native variants, and npm selects those matching the
host. Preserve all platform entries when reviewing or regenerating a lock.
Do not produce locks from existing `node_modules` trees, which can omit other
platforms. The presence of `hasInstallScript` in a dependency is metadata, not
permission to execute it; the current graphs contain these flags for fsevents,
protobufjs and core-js.

Vue keeps the reviewed override of `volar-service-emmet@0.0.64`'s
`@emmetio/css-parser` to registry version `0.4.1`. npm preserves that parent's
historical Git dependency declaration in the lock, while the override resolves
the registry tarball. The validator accepts only this exact declaration,
parent, override and target; no package may resolve to a Git or local source.
The standalone Vue server stays at `2.2.12`; hybrid mode remains disabled by
the launch configuration.

Intelephense retains its proprietary `SEE LICENSE IN LICENSE.txt` metadata.
Installing it does not grant premium access or alter its license requirements.
Do not strip its license or server notices, bundle its package contents, or
enable premium features without the user's separate entitlement.

## Regeneration and review

The initial locks were generated with Node `22.23.3` and npm `10.9.9`, matching
the repository's Node 22 verification family. Before running npm, check both
versions and clear `NODE_OPTIONS`, `NODE_PATH`, and every case-insensitive
`npm_config_*` environment variable. Use an isolated directory containing the
selected manifest, with no `node_modules`, `.npmrc`, or old lock. Supply separate
empty private user/global npm configuration files and a bounded private cache.

Invoke the verified Node executable with npm's `bin/npm-cli.js` and these
arguments to generate a lock:

```text
install --package-lock-only --ignore-scripts --no-audit --no-fund
--omit=dev --include=optional --install-strategy=hoisted
--registry=https://registry.npmjs.org --userconfig=<empty-private-file>
--globalconfig=<other-empty-private-file> --cache=<private-cache>
--fetch-retries=0 --fetch-timeout=30000
```

Keep exact top-level versions and the Vue override. Compare the entire graph,
including license metadata and optional OS/CPU packages. Resolving ranges anew
can change transitive versions; a regeneration is a reviewed dependency change,
not routine formatting. Do not automatically update recipes from registry data.

Run the recipe Rust tests, then fresh isolated `npm ci` using the fixed
`NPM_CI_FLAGS` and private configurations. Check that npm leaves both JSON files
byte-identical. Verify every actual server role's protocol initialization on
each native platform, and exercise native optional functionality where present.
For Solidity, load the platform analyzer and parse a representative pragma and
import. An initialization-only check does not establish native parsing works.

Initial macOS arm64 verification passed all eleven fresh installs, all thirteen
server initialization roles and a native Solidity analyzer parse. Windows
installation/runtime evidence is separate; a cross-platform lock alone is not
a Windows execution proof.

Registry audit on 2026-10-08 reported inherited findings in PHP (13 affected
package entries: nine high, four moderate), Bash (four high), and Svelte (two
moderate); the other eight recipes had no reported findings. Counts include
dependency chains and are not unique vulnerabilities. Reachability requires
separate review. Exact locks and passing startup checks do not establish a
vulnerability-free graph. npm's suggested remediation includes server
downgrades; do not run automatic audit fixes or change catalog versions without
reviewing compatibility and the actual affected runtime paths.

The initial applicability review found no demonstrated navigation-query exploit:
Bash compiles fixed default glob/ignore patterns, not source filenames as glob
expressions; Svelte uses compiler analysis rather than executing the affected
SSR/browser rendering paths. The PHP stdio navigation path exposes no incoming
HTTP baggage, FTP PAC configuration, or demonstrated PHP-to-protobuf input
route. This is a scoped assessment, not an exhaustive safety guarantee. In
particular, Intelephense bundles dependency code into its executable: changing
only a transitive lock entry may not repair the running bundle. Keep these
servers Full-access-only, preserve residual findings, and review upstream fixes
with native compatibility checks rather than applying cosmetic audit overrides.
