// Developer maintenance only. Pins and candidates are reviewed source changes;
// the application's installer never discovers or trusts a moving branch.
import { createHash } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { retainCatalogHistory, safePath } from './official-skill-catalog-history.mjs';
export { safePath } from './official-skill-catalog-history.mjs';

const revisions = {
  'anthropics/skills': '9d630808e4add0a7146de4af9384155d5dee350a',
  'openai/plugins': '0722921d5542fc593105c27bd52630babd8b8c2a',
};
const candidates = [
  ['anthropic', 'frontend-design', 'Frontend design', 'Design distinctive interfaces with deliberate typography, color, and layout.', 'Use with any model that can edit frontend code.'],
  ['anthropic', 'brand-guidelines', 'Anthropic brand guidelines', 'Apply Anthropic colors and typography to designs and documents.', 'This skill applies Anthropic branding; it is not a general brand strategy guide.'],
  ['anthropic', 'internal-comms', 'Internal communications', 'Write project updates, newsletters, FAQs, and other internal messages.', 'Includes reference examples. Sending messages still requires the user\'s authorization.'],
  ['anthropic', 'theme-factory', 'Theme factory', 'Choose and apply coordinated color and typography themes.', 'Includes ten theme references and a PDF showcase. Previewing the showcase requires a PDF viewer.'],
  ['anthropic', 'algorithmic-art', 'Algorithmic art', 'Create original generative artwork with p5.js and interactive controls.', 'Includes JavaScript and HTML templates. Viewing the artwork requires a browser and p5.js.'],
  ['anthropic', 'webapp-testing', 'Web app testing', 'Test local web applications with Playwright and Python helpers.', 'Requires Python, Playwright, and its browser installation. These dependencies are not installed with the skill.'],
  ['anthropic', 'mcp-builder', 'MCP server builder', 'Build MCP servers with TypeScript or Python and practical reference guides.', 'Requires a TypeScript or Python development environment. The optional evaluation helper requires the Anthropic SDK and an API key.'],
  ['openai', 'chatgpt-app-submission', 'ChatGPT app submission', 'Inspect MCP app behavior and prepare submission metadata and test cases.', 'Published by OpenAI. Works by reading app source and writing JSON; installing it does not submit or publish an app.'],
  ['openai', 'wrangler', 'Cloudflare Wrangler', 'Develop and manage Cloudflare Workers with Wrangler CLI guidance.', 'Authored by Cloudflare and distributed in OpenAI\'s public repository. Requires Node.js and Wrangler; account operations require Cloudflare authentication.'],
];

// Reviewed against these exact pinned instructions and helpers. This is product
// metadata, not an installation plan: fetching a skill never installs its tools.
export const skillRequirements = Object.freeze({
  'anthropic-algorithmic-art': 'A browser and p5.js are needed to view the artwork. The included HTML template loads p5.js and fonts from CDNs, so it needs network access unless those resources are provided locally.',
  'anthropic-webapp-testing': 'Requires Python, the Python Playwright package, and Playwright’s Chromium browser installation. For a running local app, its normal dependencies and server must also be available.',
  'anthropic-mcp-builder': 'Requires Node.js with TypeScript and the MCP SDK, or Python with the MCP SDK. The optional evaluator needs Python packages from scripts/requirements.txt (Anthropic and MCP SDKs) and an Anthropic API key. Connecting external services may require their credentials.',
  'openai-wrangler': 'Requires Node.js and Wrangler CLI v4 or later. Deployments and account operations require a Cloudflare account and authentication.',
});

const repositoryFor = (publisher) => publisher === 'anthropic' ? 'anthropics/skills' : 'openai/plugins';
const packagePathFor = (publisher, slug) => publisher === 'anthropic'
  ? `skills/${slug}`
  : `plugins/${slug === 'wrangler' ? 'cloudflare' : 'openai-developers'}/skills/${slug}`;

const MAX_FILE_BYTES = 8 * 1_048_576;
const MAX_PACKAGE_BYTES = 48 * 1_048_576;
const MAX_TREE_BYTES = 32 * 1_048_576;

export async function fetchBytes(url, maximumBytes = MAX_TREE_BYTES) {
  const headers = { 'User-Agent': 'Mythra-Code-skill-catalog-maintenance' };
  // Optional authentication avoids public API quotas. Never log this value.
  if (process.env.GITHUB_TOKEN && new URL(url).hostname === 'api.github.com') {
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Fetch failed (${response.status}): ${url}`);
  // Fetch decodes content encodings; Content-Length describes the wire body.
  // The streamed decoded-byte bound remains authoritative for compressed data.
  const encoding = response.headers.get('Content-Encoding');
  if ((!encoding || encoding.toLowerCase() === 'identity')
    && Number(response.headers.get('Content-Length')) > maximumBytes) {
    await response.body?.cancel();
    throw new Error(`Response byte limit exceeded: ${url}`);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error(`Missing response body: ${url}`);
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maximumBytes) {
        await reader.cancel();
        throw new Error(`Response byte limit exceeded: ${url}`);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, length);
}

// Check the full tree before fetching any blobs, including case-insensitive
// collisions that would otherwise break the same package on Windows.
export function validatePackageNodes(nodes, packagePath) {
  if (!nodes.length || nodes.length > 1_200) throw new Error(`Invalid file count: ${packagePath}`);
  const paths = new Set();
  let total = 0;
  for (const node of nodes) {
    const relative = node.path.slice(packagePath.length + 1);
    if (!node.path.startsWith(`${packagePath}/`) || node.type !== 'blob'
      || !['100644', '100755'].includes(node.mode) || !safePath(relative)
      || !Number.isSafeInteger(node.size) || node.size < 0 || node.size > MAX_FILE_BYTES
      || !/^[a-f0-9]{40}$/.test(node.sha)) {
      throw new Error(`Unsupported package entry: ${node.path}`);
    }
    const folded = relative.toLowerCase();
    if (paths.has(folded)) throw new Error(`Package path collision: ${node.path}`);
    paths.add(folded);
    total += node.size;
    if (total > MAX_PACKAGE_BYTES) throw new Error(`Package too large: ${packagePath}`);
  }
  for (const path of paths) {
    const parts = path.split('/');
    while (parts.length > 1) {
      parts.pop();
      if (paths.has(parts.join('/'))) throw new Error(`Package file/directory collision: ${path}`);
    }
  }
}

// This catches ordinary authored Markdown links for maintenance review. The
// application uses its CommonMark parser as the authoritative import preflight.
function reviewLocalLinks(path, bytes, files) {
  if (!/\.(md|markdown)$/i.test(path)) return;
  const text = bytes.toString('utf8')
    .replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '')
    .replace(/^\s*(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\s*\1[^\n]*$/gm, '')
    .replace(/(`+)[\s\S]*?\1/g, '');
  for (const match of text.matchAll(/(!?)\[[^\]]*\]\(([^\s)]+)(?:\s+[^)]*)?\)/g)) {
    const target = match[2].replace(/^<|>$/g, '');
    if (/^[a-z][a-z\d+.-]*:/i.test(target) || target.startsWith('#') || target.startsWith('//')) continue;
    const decoded = decodeURIComponent(target.split(/[?#]/)[0]);
    const parts = path.split('/').slice(0, -1);
    for (const part of decoded.split('/')) {
      if (part === '.') continue;
      if (part === '..') {
        if (!parts.length) throw new Error(`${path}: link escapes package: ${target}`);
        parts.pop();
      } else parts.push(part);
    }
    const resolved = parts.join('/');
    if (match[1] || !/\.(md|markdown|txt)$/i.test(resolved) || !files.has(resolved)) {
      throw new Error(`${path}: unsupported or missing authored local link: ${target}`);
    }
  }
}

export async function fetchPinnedTree(repository, revision) {
  if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error(`Invalid immutable pin: ${repository}`);
  const commit = JSON.parse((await fetchBytes(`https://api.github.com/repos/${repository}/git/commits/${revision}`)).toString('utf8'));
  const treeSha = commit?.tree?.sha;
  if (commit?.sha !== revision || !/^[a-f0-9]{40}$/.test(treeSha ?? '')) throw new Error(`Invalid pinned commit: ${repository}`);
  const tree = JSON.parse((await fetchBytes(`https://api.github.com/repos/${repository}/git/trees/${treeSha}?recursive=1`)).toString('utf8'));
  if (tree?.truncated !== false || tree.sha !== treeSha || !Array.isArray(tree.tree)) throw new Error(`Incomplete or wrong tree: ${repository}`);
  return tree.tree;
}

async function main() {
const trees = new Map();
for (const [repository, revision] of Object.entries(revisions)) {
  trees.set(repository, await fetchPinnedTree(repository, revision));
}

const catalog = [];
for (const [publisher, slug, title, description, notes] of candidates) {
  const repository = repositoryFor(publisher);
  const revision = revisions[repository];
  const path = packagePathFor(publisher, slug);
  const nodes = trees.get(repository).filter((node) => node.path.startsWith(`${path}/`) && node.type !== 'tree');
  validatePackageNodes(nodes, path);
  const localFiles = new Map();
  const files = [];
  // Small bounded batches keep downloads quick without flooding the origin.
  for (let index = 0; index < nodes.length; index += 6) {
    const results = await Promise.all(nodes.slice(index, index + 6).map(async (node) => {
      const relative = node.path.slice(path.length + 1);
      const bytes = await fetchBytes(`https://raw.githubusercontent.com/${repository}/${revision}/${node.path}`, node.size);
      const gitHash = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
      if (bytes.length !== node.size || gitHash !== node.sha) throw new Error(`Upstream file mismatch: ${node.path}`);
      return { relative, bytes, file: {
        path: relative,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        size: bytes.length,
        ...(node.mode === '100755' ? { executable: true } : {}),
      } };
    }));
    for (const { relative, bytes, file } of results) {
      localFiles.set(relative, bytes);
      files.push(file);
    }
  }
  const licenseText = localFiles.get('LICENSE.txt')?.toString('utf8').trimStart() ?? '';
  if (!licenseText.startsWith('Apache License') || !licenseText.includes('Version 2.0')) {
    throw new Error(`Candidate needs individual license review: ${path}`);
  }
  if (!localFiles.has('SKILL.md')) throw new Error(`Missing SKILL.md: ${path}`);
  for (const [relative, bytes] of localFiles) reviewLocalLinks(relative, bytes, localFiles);
  const id = `${publisher}-${slug}`;
  const requirements = skillRequirements[id];
  catalog.push({ id, publisher, title, description, repository, path, revision,
    license: 'Apache-2.0', notes, ...(requirements ? { requirements } : {}),
    files: files.sort((a, b) => a.path.localeCompare(b.path, 'en')) });
  console.log(`${publisher}/${slug}: ${files.length} verified files`);
}

const output = fileURLToPath(new URL('../src-tauri/src/official-skills-catalog.json', import.meta.url));
const historyOutput = fileURLToPath(new URL('../src-tauri/src/official-skills-catalog-history.json', import.meta.url));
async function readManifest(path) {
  // Both manifests are checked-in product data. A missing or malformed file
  // must stop the refresh instead of silently discarding trusted history.
  return JSON.parse(await readFile(path, 'utf8'));
}
const previous = await readManifest(output);
const history = retainCatalogHistory(previous, await readManifest(historyOutput), catalog);
async function saveManifest(path, entries) {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(entries, null, 2)}\n`, { flag: 'wx' });
  await rename(temporary, path);
}
// Persist old snapshots first. Even if the second write fails, no previous
// trusted pin is lost and the active catalog remains at its prior state.
await saveManifest(historyOutput, history);
await saveManifest(output, catalog);
console.log('Catalog generated. Review the manifest diff and licenses, then run the installer regressions.');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await main();
}
