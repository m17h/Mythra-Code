# Local skills and nested references

Choose a folder in **Settings → Skills**. Mythra Code discovers top-level `.md` files and nested `SKILL.md` packages. Enable a skill and use its displayed invocation name, for example `@review`, in a message or in effective system instructions. The editor offers completion and highlights recognized names. App-only renaming changes the invocation alias; it does not rename the source file.

Direct message and system-prompt mentions use a standalone plain alias such as `@review`, separated from surrounding words. Inside a loaded skill or reference document, visible Markdown mentions can be plain, bold (`**@tests**`), or italic (`*@tests*`). Mentions in inline code, fenced code blocks, image text, or escaped as `\@tests` are examples rather than dependencies.

An unknown or disabled alias typed directly in a message or system prompt remains ordinary text. Once an enabled root skill loads, an unknown or disabled nested alias is a broken dependency and blocks that turn.

## Building a dependency graph

A skill can invoke another enabled skill using its alias:

```markdown
Review the changes, then use @tests to check the test plan.
Read [the checklist](references/checklist.txt).
```

The checklist is a local reference document, while `@tests` loads another skill's instructions. Both can contain more nested skill mentions and document links. Inline and reference-style Markdown text links are supported:

```markdown
Read [the checklist][checklist].

[checklist]: references/checklist.md
```

Document targets must be UTF-8 text files ending in `.md`, `.markdown`, or `.txt`. They resolve relative to the containing file, including percent-encoded UTF-8 filenames. A path using `../` is allowed only if its canonical destination remains inside the selected skills folder. A link that reaches a detected skill source requires that skill to be enabled and present in the app's library; linking a removed or disabled skill file does not bypass its state. Put supporting Markdown documents in a reference subfolder rather than using a detected skill source as an ordinary document.

A local Markdown text link inside a loaded skill or reference document is a required dependency. Unsupported targets—including `.pdf`, `.docx`, `.csv`, `.json`, directory links such as `references/`, and extensionless paths—block the turn with an `unsupported-document` diagnostic and the complete reference chain. This resolver does not extract PDF or Word content, and this restriction does not change ordinary attachment workflows. Convert required material to a supported UTF-8 text file and update the link; merely naming `checklist.txt` in prose does not load it.

Web URLs, anchors, images, links in code examples, and bare filenames do not load reference documents. This process does not fetch websites. Write a Markdown text link when you intend to include a local reference document; an ordinary website link remains an ordinary link.

Mythra Code resolves the graph before delivering a turn. It adds the referenced skill instructions and local document material to the relevant provider context. Loading a file records what was supplied; it does not guarantee that a model obeys every instruction or uses every document correctly.

## Limits and blocked turns

The system prompt and user message share one graph and one set of limits:

| Limit | Per turn |
| --- | --- |
| Dependency depth | 4 hops from any directly mentioned root skill at depth 0 |
| Skills | 8 distinct skills |
| Files | 24 distinct files, including skill sources and documents |
| Text | 120,000 Unicode characters across loaded files |
| Individual file | 1 MiB (1,048,576 bytes) |
| Local dependency references | 128; repeated document-link occurrences count separately |

Repeated references load the same canonical file once. Shared dependencies are allowed, and depth uses the shortest chain from any directly mentioned root. A longer route to a file already reachable within the limit does not fail. A reference back to an ancestor is a cycle and blocks the graph. Disabled dependencies, unsupported document targets, missing or unreadable files, paths escaping the folder, invalid UTF-8 text files, and exceeded limits also block the entire turn. Mythra Code does not deliver a partially resolved subset of a failed graph.

The resolver also bounds unusually large inputs to 64 recognized direct roots and 1,000 configured aliases. These checks stop resolution with a diagnostic instead of truncating the graph.

Blocked previews show the reference, reason, and complete chain in red, for example `@review → @tests → references/missing.md`. A root mention turns red when a nested dependency fails. System-only failures also appear in the composer when the message is empty.

## Editing and inspecting context

The system prompt, composer, and skill source editor preview dependencies after a short typing pause. The source editor checks unsaved Markdown. Closing an editor or replacing a request discards stale preview results. Sending resolves the current files again; a preview is not permission to reuse an earlier file snapshot.

Sent user messages contain a collapsed **Skill context** disclosure, including skills loaded only by system instructions. Expand it to inspect root channels, skill and document paths, nested reference edges, load outcomes, and character counts. The disclosure stores graph metadata, not an additional copy of loaded file contents. Provider transcripts can retain the delivered context just like other prompts. A skill link opens only the exact source currently known in the selected folder; a different skill reusing its old alias cannot become its destination. Document paths are shown as read-only text.

The local Claude plugin and Codex skill bridges remain provider integration surfaces. The app's dependency resolution and report cover context prepared by Mythra Code, not every file a provider may later choose to read with its own tools.

## Prompt caching

Supported provider runtimes, including Codex and Claude Code, manage their prompt caching. Mythra Code prepares fresh context with stable ordering where possible; it does not freeze old file contents to obtain a cache hit. User-only tracking data is excluded from system-skill instructions so changing a message's skill selection does not change that system context. The complete dependency report is retained in the user-turn envelope so Codex history can restore the context details after reload.

Caching support and savings depend on the provider, model, runtime, and request. Other providers may require cache controls their runtime does not supply. Cache hits, cache duration, and monetary savings are not guaranteed. Mythra Code does not send artificial keepalive requests. Local preview/file reads are separate from provider prompt caching.
