# Shared language tools

Settings → Tools & MCP contains the language-tool inventory. Installations are
shared across projects on the current computer, not across computers. Settings
are saved immediately; the modal's general Save button is not required.

Users can install supported tools individually, disable individual tools, or
switch automatic setup off. New project threads inspect a bounded set of source
file extensions. In Full access, enabled missing tools with a supported recipe
are installed in private application storage before the provider starts. Ask to
act and Read only use existing installations; users install missing tools from
Settings. Ordinary chats do not trigger project setup.

Project threads expose `language_tools_status` through the existing authenticated
local MCP bridge. Full-access threads also advertise `install_language_tool`;
restricted threads use existing tools or ask the user to install from Settings.
These tools work without
enabling sub-agents. Child threads receive language tools only, not delegation
or project-control powers, including on their first delegated turn. Installation
accepts curated identifiers, never model-provided packages, executable paths, or
commands. Automatic setup and individual disable switches are checked again
when a model requests an install.

## Provider boundary

Tool-capable providers can query installed, enabled servers through
`language_tool_query`: find a definition, find references, inspect symbol
information (hover), or list symbols in a file. The request names an existing
project-relative file, never a different workspace or an arbitrary server
command. Locations use one-based lines and UTF-16 columns. Returned file
locations are limited to the current project; dependency locations outside that
folder are omitted. Queries cannot rename symbols, edit files, install software,
or send arbitrary protocol requests.

Status defaults to languages detected in the current project. A curated tool ID
or project-relative path narrows it further; `fullCatalog: true` explicitly asks
for the complete inventory. Status is a cheap inventory read by default; `verify:
true` explicitly checks the selected servers. Settings has a separate Refresh
action for current health checks.

Queries return compact, project-relative results, with 50 entries by default and
an explicit `maxResults` limit up to 1,000. `pathFilter` narrows locations and
`nameFilter` narrows symbols; filters are substring matches, not filesystem
commands. Truncated results say so and include counts. Large protocol responses
still have a hard limit; this interface does not promise unlimited pagination.

Claude Code receives an explicit app-generated LSP-only plugin. This is necessary
because Mythra intentionally does not inherit Claude's user/project settings.
The plugin points to verified language servers; it does not alter project files
or replace the existing skills plugin. Installing a server during a running turn
does not reload that process: newly installed servers become available to
Claude's built-in LSP tool on the next turn. The shared query tool can use an
installation immediately. Claude's built-in integration additionally provides
native diagnostics; the shared query tool does not promise that capability.
Claude sessions prefer the native integration where available, with shared
queries as the fallback. Other providers receive the shared-query guidance.

Models must support tool calling to use the bridge. Installing a language server
does not force a model to choose it or guarantee that the server supports every
operation. Missing capabilities and prerequisites are reported rather than
represented as successful queries.

TypeScript/JavaScript, Python, HTML/CSS/JSON, and YAML queries are available in
Ask and Read-only modes. Other servers require Full access: framework and native
language servers can execute project configuration while analyzing source.
This restriction applies both to shared queries and the plugin supplied to
Claude. A read-only protocol method alone is not a filesystem sandbox.

## Ownership and failure behavior

The native `language_tools` module owns the curated recipes, private storage,
preferences, install serialization, project detection and protocol probes.
The settings component reads cheap authoritative inventory snapshots and
coalesces native change events rather than polling or starting a process for
every refresh. Available means an installation was found but its health is not
currently verified; Installed requires a current successful LSP initialize
observation. Expired observations are shown as stale, not silently accepted as
current verification. Explicit Refresh checks health again.

Successful health observations are reused for up to two minutes only while the
tracked executable, runtime and launch configuration match. Machine-health
failures have a short ten-second cooldown; explicit Refresh clears that
cooldown. Project authorization and containment are checked independently.
An actual query's successful initialization supplies health evidence for that
launch role, avoiding a separate preliminary handshake. Multi-server tool groups
still require evidence for every role before the whole group is verified.

Managed npm recipes include their complete dependency lockfiles and install with
`npm ci` and package scripts disabled. This makes later installations use the
reviewed dependency graph rather than resolving new transitive versions. Node
is reused from the user's computer, not bundled separately for every tool.

The query module bounds source reads, protocol messages, results, concurrency,
and server lifetimes. It opens the requested file against the actual project
root and stops its owned server after the request. Read-only query operations
do not mean every third-party server is a filesystem sandbox: servers may read
project configuration. Rust queries disable build scripts and procedural macros.
Project-scoped setup, status and queries reject server executables, scripts and
TypeScript runtimes linked back into that project before starting a probe.
Source is reread and its position revalidated immediately before opening the
document, after server initialization; results include that source's fingerprint.
Protocol framing uses a bounded buffered reader, and the final model-visible
result has an independent size limit after JSON escaping.

Ordinary provider setup no longer writes Claude plugin files. Claude's native
launch creates its plugin only when needed and reuses unchanged private files.
Server persistence, general automatic storage deletion, dependency hardlinking,
and shared edit diagnostics are not enabled by this feature. They need separate
freshness, lifecycle and resource evidence before being safe defaults.

Missing prerequisites and failed installations are reported in Settings. They
do not prevent a normal model turn from starting. No model/API calls are made
to detect languages or install tools. Runtime/toolchain prerequisites that do
not have a safe private installation recipe remain explicit manual setup steps.

## Catalog coverage

The catalog covers TypeScript/JavaScript, Python, PHP, HTML/CSS/JSON, YAML, Rust,
Go, C/C++/Objective-C, C#, Swift, Java, Kotlin, Lua, Ruby, Bash, Dockerfile,
Svelte, Astro, Vue, Solidity, TOML, Markdown, Dart/Flutter, Zig, and Terraform.
Tools are installed only when needed or explicitly selected, not all at once.
Some native servers require the user's existing language toolchain; Mythra does
not automatically install whole compiler ecosystems.

Vue uses a deliberately pinned standalone server with its verified TypeScript
runtime. Newer Vue servers require additional client-side TypeScript integration
and are not interchangeable with this recipe. Its private manifest replaces a
transitive Git dependency with a verified registry release, so Git is not an
installation prerequisite. Dockerfile names are handled by
project detection and shared queries; Claude's suffix-based plugin mapping does
not cover extensionless filenames by itself.

GraphQL, Prisma, Liquid, and Elm are deferred rather than represented as working
integrations: unresolved dependencies, cache ownership, or client integration
must be addressed before adding a reliable shared recipe.

Focused unit, protocol and real-browser checks cover this feature separately
from the repository's complete hosted merge verification.
