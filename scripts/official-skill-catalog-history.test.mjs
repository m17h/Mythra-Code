import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { retainCatalogHistory } from './official-skill-catalog-history.mjs';
import { fetchBytes, safePath, skillRequirements, validatePackageNodes } from './update-official-skill-catalog.mjs';

const snapshot = (revision = 'a'.repeat(40)) => ({
  id: 'anthropic-example', publisher: 'anthropic', title: 'Example', description: 'Example skill',
  repository: 'anthropics/skills', path: 'skills/example', revision, license: 'Apache-2.0', notes: '',
  files: [{ path: 'SKILL.md', sha256: '1'.repeat(64), size: 100 }],
});

test('unchanged regeneration keeps initial history empty', () => {
  const entry = snapshot();
  assert.deepEqual(retainCatalogHistory([entry], [], [structuredClone(entry)]), []);
});

test('replacement and removal retain complete prior snapshots without mutating inputs', () => {
  const old = snapshot();
  const replacement = snapshot('b'.repeat(40));
  const removed = { ...snapshot('c'.repeat(40)), id: 'anthropic-removed' };
  const previous = [old, removed];
  const original = structuredClone(previous);
  assert.deepEqual(retainCatalogHistory(previous, [], [replacement]), original);
  assert.deepEqual(previous, original);
});

test('repeated refresh deduplicates exact snapshots and retains restored pins', () => {
  const old = snapshot();
  const next = snapshot('b'.repeat(40));
  const history = retainCatalogHistory([old], [old, structuredClone(old)], [next]);
  assert.deepEqual(history, [old]);
  assert.deepEqual(retainCatalogHistory([next], history, [old]), [old, next]);
  assert.deepEqual(retainCatalogHistory([old], [old, next], [next]), [old, next]);
});

test('copy corrections archive full metadata while preserving immutable content', () => {
  const old = snapshot();
  const corrected = { ...old, notes: 'Clarified runtime dependency.' };
  assert.deepEqual(retainCatalogHistory([old], [], [corrected]), [old]);
  assert.deepEqual(retainCatalogHistory([corrected], [old], [corrected]), [old]);
});

test('optional requirements preserve historical snapshots and immutable package identity', () => {
  const old = snapshot();
  const withRequirements = { ...old, requirements: 'Python and Playwright.' };
  assert.deepEqual(retainCatalogHistory([old], [], [withRequirements]), [old]);
  assert.deepEqual(retainCatalogHistory([withRequirements], [old], [withRequirements]), [old]);
  assert.deepEqual(retainCatalogHistory([withRequirements], [], [old]), [withRequirements]);
  for (const requirements of [null, 42, [], '', '   ', 'x'.repeat(2_001)]) {
    assert.throws(() => retainCatalogHistory([], [], [{ ...old, requirements }]), /Invalid catalog snapshot/);
  }
});

test('catalog reproduces reviewed requirements only for specific external dependencies', async () => {
  const catalog = JSON.parse(await readFile(new URL('../src-tauri/src/official-skills-catalog.json', import.meta.url), 'utf8'));
  assert.deepEqual(catalog.filter((entry) => entry.requirements).map((entry) => entry.id), Object.keys(skillRequirements));
  for (const entry of catalog) {
    assert.equal(entry.requirements, skillRequirements[entry.id], entry.id);
  }
  assert.match(skillRequirements['anthropic-algorithmic-art'], /p5\.js.*CDNs/);
  assert.match(skillRequirements['anthropic-webapp-testing'], /Python.*Playwright.*Chromium/);
  assert.match(skillRequirements['anthropic-mcp-builder'], /Node\.js.*or Python.*optional evaluator.*Anthropic API key/);
  assert.match(skillRequirements['openai-wrangler'], /Node\.js.*Wrangler CLI v4.*Cloudflare account and authentication/);
});

test('immutable revision rejects content drift from current or historical manifests', () => {
  const old = snapshot();
  for (const changed of [
    { ...old, path: 'skills/other' },
    { ...old, publisher: 'openai', repository: 'openai/plugins' },
    { ...old, license: 'MIT' },
    { ...old, files: [{ ...old.files[0], sha256: '2'.repeat(64) }] },
    { ...old, files: [{ ...old.files[0], size: 101 }] },
    { ...old, files: [{ ...old.files[0], executable: true }] },
    { ...old, files: [...old.files, { path: 'LICENSE.txt', sha256: '3'.repeat(64), size: 10 }] },
  ]) {
    assert.throws(() => retainCatalogHistory([old], [], [changed]), /Immutable catalog content drift/);
    assert.throws(() => retainCatalogHistory([], [old], [changed]), /Immutable catalog content drift/);
  }
});

test('manifest formatting and file order do not invent historical snapshots', () => {
  const entry = snapshot();
  entry.files.push({ path: 'LICENSE.txt', sha256: '3'.repeat(64), size: 10 });
  const reordered = Object.fromEntries(Object.entries(entry).reverse());
  reordered.files = [...entry.files].reverse().map((file) => ({ ...file, executable: false }));
  assert.deepEqual(retainCatalogHistory([entry], [], [reordered]), []);
});

test('malformed manifests and duplicate active IDs fail closed', () => {
  const entry = snapshot();
  assert.throws(() => retainCatalogHistory({}, [], []), /must be an array/);
  assert.throws(() => retainCatalogHistory([], [{ ...entry, revision: 'main' }], []), /Invalid catalog snapshot/);
  assert.throws(() => retainCatalogHistory([entry, entry], [], []), /Duplicate active catalog ID/);
  for (const malformed of [
    { id: entry.id, revision: entry.revision, files: [{}] },
    { ...entry, repository: 'unreviewed/repository' },
    { ...entry, repository: 'openai/plugins' },
    { ...entry, publisher: 'openai' },
    { ...entry, files: [{ ...entry.files[0], sha256: 'invalid' }] },
    { ...entry, files: [{ ...entry.files[0], executable: 'true' }] },
    { ...entry, files: [{ ...entry.files[0], size: -1 }] },
    { ...entry, files: [{ ...entry.files[0], path: 'CON.txt' }] },
    { ...entry, files: [entry.files[0], { ...entry.files[0], path: 'skill.md' }] },
    { ...entry, unknownField: 'runtime rejects this' },
  ]) {
    assert.throws(() => retainCatalogHistory([malformed], [], []), /Invalid catalog snapshot/);
    assert.throws(() => retainCatalogHistory([], [malformed], []), /Invalid catalog snapshot/);
  }
});

test('maintenance paths match the cross-platform installer boundary', () => {
  for (const path of ['CON.txt', 'assets/nul.png', 'COM1', 'assets/FILE.', 'assets/foo ',
    'assets/Foo:bar', 'assets/foo%20bar', 'assets/a#b', 'assets/a\u0000b', 'x'.repeat(513)]) {
    assert.equal(safePath(path), false, path);
  }
  for (const path of ['SKILL.md', 'assets/cloudflare-small.svg', 'scripts/with_server.py']) {
    assert.equal(safePath(path), true, path);
  }
});

test('maintenance downloads bound declared and streamed response bytes', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => new Response('12345', { headers: { 'Content-Length': '5' } });
  await assert.rejects(fetchBytes('https://raw.githubusercontent.com/example', 4), /byte limit/);
  let cancelled = false;
  globalThis.fetch = async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('12345')); },
    cancel() { cancelled = true; },
  }));
  await assert.rejects(fetchBytes('https://raw.githubusercontent.com/example', 4), /byte limit/);
  assert.equal(cancelled, true);
  globalThis.fetch = async () => new Response('1234');
  assert.equal((await fetchBytes('https://raw.githubusercontent.com/example', 4)).toString(), '1234');
  // Fetch exposes decoded bytes; tiny gzip bodies can have a larger wire length.
  globalThis.fetch = async () => new Response('1234', { headers: { 'Content-Length': '24', 'Content-Encoding': 'gzip' } });
  assert.equal((await fetchBytes('https://raw.githubusercontent.com/example', 4)).toString(), '1234');
});

test('maintenance rejects oversized packages and path collisions before downloading', () => {
  const node = (path, size = 1) => ({ path: `skills/example/${path}`, type: 'blob', mode: '100644', size, sha: 'a'.repeat(40) });
  assert.throws(() => validatePackageNodes(Array.from({ length: 7 }, (_, i) => node(`file${i}`, 8 * 1_048_576)), 'skills/example'), /Package too large/);
  assert.throws(() => validatePackageNodes([node('SKILL.md'), node('skill.md')], 'skills/example'), /path collision/);
  assert.throws(() => validatePackageNodes([node('assets'), node('ASSETS/image.png')], 'skills/example'), /file\/directory collision/);
  for (const invalid of [node('CON.txt'), node('file', -1), node('file', 0.5), { ...node('file'), mode: '120000' }]) {
    assert.throws(() => validatePackageNodes([invalid], 'skills/example'), /Unsupported package entry/);
  }
  assert.doesNotThrow(() => validatePackageNodes([node('SKILL.md'), node('assets/image.png')], 'skills/example'));
});
