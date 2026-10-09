# Official skill downloads

Settings offers individually reviewed skills from public vendor repositories.
The publisher label in the download catalog and company logo in the installed
skills list identify the distribution source. The company logo precedes the
skill title; its tooltip and accessible label name the publisher. These marks
do not claim the vendor authored every skill: Cloudflare Wrangler is authored by Cloudflare and
distributed through OpenAI's repository, as its detail note explains.

The initial catalog contains seven Anthropic skills and two skills distributed
by OpenAI. Every selected package has an individual Apache-2.0 `LICENSE.txt`,
which is included in the download alongside every file in its skill directory.
The installer preserves the original files and records their source separately.
Apache-2.0 redistribution conditions include retaining applicable attribution
notices and providing the license. Its trademark clause does not grant a general
right to use vendor marks; the source labels do not claim vendor endorsement.

## Sources and licensing

- [Anthropic's public repository](https://github.com/anthropics/skills) contains
  open-source examples and separately restricted document skills.
- [Frontend design license](https://github.com/anthropics/skills/blob/9d630808e4add0a7146de4af9384155d5dee350a/skills/frontend-design/LICENSE.txt)
  permits copying and distribution subject to Apache-2.0 attribution conditions.
- Anthropic's [document skill license](https://github.com/anthropics/skills/blob/9d630808e4add0a7146de4af9384155d5dee350a/skills/docx/LICENSE.txt)
  restricts retaining, copying, modifying and distributing its materials. The
  DOCX, PDF, PPTX and XLSX skills are excluded. Public source is not by itself
  permission to redistribute.
- [OpenAI's old skills repository](https://github.com/openai/skills) is deprecated
  and directs users to [OpenAI Plugins](https://github.com/openai/plugins).
  This catalog uses the current repository.
- OpenAI's [ChatGPT app submission license](https://github.com/openai/plugins/blob/0722921d5542fc593105c27bd52630babd8b8c2a/plugins/openai-developers/skills/chatgpt-app-submission/LICENSE.txt)
  and [Wrangler license](https://github.com/openai/plugins/blob/0722921d5542fc593105c27bd52630babd8b8c2a/plugins/cloudflare/skills/wrangler/LICENSE.txt)
  are Apache-2.0. Individual licensing matters: the parent OpenAI Developers
  plugin declares Proprietary and includes separate connectors.
- [OpenAI's skill documentation](https://developers.openai.com/plugins/concepts/skills)
  describes the instruction/resource format and explains that MCP-backed skills
  rely on tools provided by their companion server.

## Compatibility boundaries

Downloading instructions does not add proprietary computer-use tools, a
connector, credentials, Python, browser installations, or a model subscription.
The selected skills use ordinary source-editing and shell workflows. Their
dependency information lists additional tools, software and credentials where
needed. These requirements are reviewed metadata, not a check of the user's
machine or an automatic dependency installer. A missing requirements field means
the skill has no identified additional tool dependency; the user's task may
still need its normal project tools. The MCP builder's optional evaluator
uses the Anthropic SDK and an API key; its server-development guidance remains
usable with other models. Installing the skill does not run its scripts.

Web app testing needs Python, the Python Playwright package and its Chromium
browser installation. A running local application also needs its normal
dependencies and server. Algorithmic art needs a browser and p5.js; its template loads p5.js and
fonts from CDNs, so offline use needs local copies. MCP server development needs
either Node.js/TypeScript or Python with the MCP SDK; the evaluator is an optional
extra. Cloudflare Wrangler needs Node.js and Wrangler v4 or later. Remote
Cloudflare operations need account authentication and can change deployed
resources. Credentials and permission to send, deploy or modify external
resources are separate from downloading instructions.

Full package files are necessary: algorithmic art includes HTML/JavaScript
templates, web app testing and MCP builder include Python helpers, and theme
factory includes its PDF showcase. Markdown instructions alone would discard
these resources. Resources remain files, not automatically injected prose.

The initial list excludes canvas design's bundled fonts, connector-only skills,
OpenAI's Sentry skill with repository-specific script paths, and plugins relying
on sibling skills or shared resources outside the selected skill directory.
Adding one requires separate licensing and runtime compatibility review.

## Skills recorded in work history

Each run's work details show a count of deduplicated recorded skill identities.
Hovering, focusing or clicking the count lists their names. A final-only run with
recorded skills also has an activity opener, without inventing tool steps.
The count includes instructions loaded for that
run from user or system prompts and their skill dependencies. Supporting
documents, available but unused skills, and a dependency graph that blocked the
model from starting do not count. Older history uses the exact captured skill
references only when it has no dependency report.

Native Claude `Skill` calls count only after a successful tool result. Native
Codex skill inputs retain the selected name and source path. The Codex transport
currently exposes no automatic skill activation event, so automatic activations
it does not report cannot be counted. Assistant prose and arbitrary commands
are never treated as activation evidence. The count records loaded instructions
or provider evidence; it does not prove the model followed those instructions.
Same-named sources remain distinct, and a native Claude name without a source
path is not assumed to be an app skill. Only the app's own
`openkiwi-skills:` namespace can be matched to a known loaded local source.

Counts update as loading evidence arrives and remain associated with their
original run, including steering within that run. History retains names, paths
and load outcomes so reopening a task does not retarget old evidence to the
current skill library or count a pending/failed load as successful. Skill
instruction text is not added to this usage metadata.

## Maintaining the catalog

`src-tauri/src/official-skills-catalog.json` is a checked-in allowlist of exact
repositories, package paths, immutable commit revisions, file lengths, executable
flags and SHA-256 hashes. Runtime downloads never follow a moving `main` branch.
These reviewed source snapshots are updated through a normal product change.
Installed skills do not update automatically. Downloaded source is read-only in
Settings; users can create a separate custom copy when they want to edit it.

`src-tauri/src/official-skills-catalog-history.json` retains the complete reviewed
manifests of replaced or removed entries. Existing installations can therefore
keep their publisher identity, read-only source view, and complete resource mirror
after the active catalog moves to a newer revision. Historical manifests are
trusted product snapshots; installer receipts cannot add arbitrary trusted
repositories or files. Removing a skill from the download list does not erase
its reviewed source history or update an existing installation.

To refresh, edit the explicit pins/candidates in
`scripts/update-official-skill-catalog.mjs`, then run:

```sh
node scripts/update-official-skill-catalog.mjs
```

The maintenance command fetches complete pinned Git trees, rejects unsupported
entry modes and paths (including Windows reserved names and case collisions),
checks original Git blob hashes and individual licenses,
audits ordinary local Markdown links, and generates SHA-256 manifests. It only
writes the active catalog and its retained history; it does not install packages
or execute upstream scripts. It limits Git-tree responses to 32 MiB, each file
to 8 MiB and each package to 48 MiB with at most 1,200 files. Package bounds are
checked before file downloads, and each streamed download is bounded by its
declared file length. It preserves replaced and removed snapshots before
writing the new list, deduplicates identical historical entries, and rejects
different package content under the same skill ID and immutable revision.
Malformed active or historical snapshots stop the refresh before either
manifest is replaced.
An optional `GITHUB_TOKEN` avoids GitHub API quotas and is never printed.

Review changes to licenses, scripts, assets, authored links and dependency notes
before accepting a refresh. The application's CommonMark dependency preflight
and installer regressions remain authoritative; the maintenance link audit is
not a replacement for runtime validation.

The maintenance script's `skillRequirements` map reproduces the optional
`requirements` field. Requirements describe the reviewed pinned source, not the
latest upstream version. Old historical snapshots without this field remain
valid, and adding or correcting it does not change installation receipts or
package file hashes.

Run the focused maintenance and history regressions with the repository's
Node 22 runtime:

```sh
npm run test:run -- scripts/official-skill-catalog-history.test.mjs
```
