import { afterEach, expect, test } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { atomicJson, readJson } from './release-state.mjs';
import { collectNativeWorker, effectiveSession, launchNativeWorker, resolveCodexBinary } from './release-native-check.mjs';

const roots = [];
const temp = () => { const root = mkdtempSync(join(tmpdir(), 'mythra-native-launch-')); roots.push(root); return root; };
afterEach(() => roots.splice(0).forEach((r) => rmSync(r, { recursive: true, force: true })));
const sessionId = '01a10d39-6aec-7721-9b90-ab146f5b533e';
function config({ script, deadlineMs = 5_000 } = {}) {
  const root = temp(), cli = join(root, 'fixture-cli.mjs'), resultPath = join(root, 'result.json');
  writeFileSync(cli, script || `import {writeFileSync} from 'node:fs'; process.stdin.resume(); console.log(JSON.stringify({type:'thread.started',thread_id:'${sessionId}'})); setTimeout(()=>{writeFileSync(${JSON.stringify(resultPath)},'{}');console.log(JSON.stringify({type:'turn.completed'}));},200);`);
  const promptPath = join(root, 'prompt.txt'); writeFileSync(promptPath, 'Fixture only');
  return { binary: process.execPath, args: [cli], root, promptPath, statusPath: join(root, 'status.json'), resultPath, eventsPath: join(root, 'events.jsonl'), errorsPath: join(root, 'stderr.log'), deadlineMs, terminationGraceMs: 10, contractHash: 'c'.repeat(64) };
}

test('native binary resolution accepts executable bytes and rejects command shims', () => {
  const root = temp(); writeFileSync(join(root, 'codex.cmd'), '@echo off');
  expect(() => resolveCodexBinary({ platform: 'win32', env: { PATH: root } })).toThrow(/Native Codex executable unavailable/);
  const vendor = join(root, 'node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/codex'); mkdirSync(vendor, { recursive: true });
  const exe = join(vendor, 'codex.exe'); writeFileSync(exe, 'MZ00fixture');
  expect(resolveCodexBinary({ platform: 'win32', env: { PATH: root } })).toBe(realpathSync(exe));
  expect(() => resolveCodexBinary({ platform: 'win32', env: { PATH: root, MYTHRA_CODEX_BINARY: join(root, 'codex.cmd') } })).toThrow(/shims/);
});

test('persisted effective session must verify Sol, high reasoning, approval and sandbox', () => {
  const root = temp(), path = join(root, `rollout-${sessionId}.jsonl`);
  const payload = { model: 'gpt-6.1-sol', effort: 'high', approval_policy: 'never', sandbox_policy: { type: 'danger-full-access' } };
  writeFileSync(path, JSON.stringify({ type: 'turn_context', payload }) + '\n');
  expect(effectiveSession(sessionId, { sessionsRoot: root })).toEqual({ model: 'gpt-6.1-sol', reasoningEffort: 'high', approvalPolicy: 'never', sandbox: 'danger-full-access' });
  for (const change of [{ effort: 'medium' }, { model: 'gpt-6-luna' }, { approval_policy: 'on-request' }, { sandbox_policy: { type: 'workspace-write' } }]) {
    writeFileSync(path, JSON.stringify({ type: 'turn_context', payload: { ...payload, ...change } }) + '\n');
    expect(() => effectiveSession(sessionId, { sessionsRoot: root })).toThrow(/effective runtime/);
  }
});

test('detached native wrapper owns terminal result and reuses it without another CLI', async () => {
  const c = config(); const status = await launchNativeWorker(c);
  expect(status).toMatchObject({ status: 'result-ready', sessionId, contractHash: c.contractHash, worker: { pid: expect.any(Number), processStart: expect.any(String) }, childWorker: { pid: expect.any(Number), processStart: expect.any(String) } });
  expect(readFileSync(c.eventsPath, 'utf8')).toContain('turn.completed');
  expect(await launchNativeWorker(c)).toEqual(status);
  expect(readFileSync(c.eventsPath, 'utf8').match(/thread.started/g)).toHaveLength(1);
});

test('coordinator exit leaves native worker logging and collection available', async () => {
  const c = config(); const parent = join(c.root, 'coordinator-fixture.mjs');
  const module = pathToFileURL(resolve(import.meta.dirname, 'release-native-check.mjs')).href;
  writeFileSync(parent, `import {launchNativeWorker} from ${JSON.stringify(module)}; import {existsSync,readFileSync} from 'node:fs'; const c=${JSON.stringify(c)}; void launchNativeWorker(c).catch(()=>{}); const timer=setInterval(()=>{if(existsSync(c.statusPath)&&JSON.parse(readFileSync(c.statusPath)).childWorker){clearInterval(timer);process.exit(0)}},10);`);
  await new Promise((accept, reject) => { const child = spawn(process.execPath, [parent], { stdio: ['ignore', 'ignore', 'pipe'] }); let errors=''; child.stderr.on('data', (chunk)=>{errors+=chunk}); child.once('error', reject); child.once('exit', (code) => code === 0 ? accept() : reject(new Error(`Fixture coordinator exited ${code}: ${errors}`))); });
  const result = await collectNativeWorker(c.statusPath, { pollMs: 10, timeoutMs: 5_000 });
  expect(result.status).toBe('result-ready');
  expect(existsSync(c.resultPath)).toBe(true); expect(readFileSync(c.eventsPath, 'utf8')).toContain('turn.completed');
});

test('deadline blocks and preserves worker identities; no automatic duplicate', async () => {
  const c = config({ script: `process.stdin.resume();console.log(JSON.stringify({type:'thread.started',thread_id:'${sessionId}'}));setInterval(()=>{},1000);`, deadlineMs: 100 });
  await expect(launchNativeWorker(c)).rejects.toThrow(/blocked/);
  expect(readJson(c.statusPath)).toMatchObject({ status: 'blocked', worker: { pid: expect.any(Number) }, childWorker: { pid: expect.any(Number) } });
  await expect(launchNativeWorker(c)).rejects.toThrow(/blocked/);
  expect(readFileSync(c.eventsPath, 'utf8').match(/thread.started/g)).toHaveLength(1);
});

test('queued ambiguous launch gets a bounded collection result and cannot be replaced', async () => {
  const root = temp(), statusPath = join(root, 'status.json'); atomicJson(statusPath, { status: 'queued', contractHash: 'c'.repeat(64) });
  await expect(collectNativeWorker(statusPath, { pollMs: 1, timeoutMs: 3 })).rejects.toMatchObject({ status: 'waiting' });
  expect(readJson(statusPath).status).toBe('queued');
});


test('resumed worker runtime is validated from its newest turn context', () => {
  const root = temp(), path = join(root, `rollout-${sessionId}.jsonl`);
  const good = { model: 'gpt-6.1-sol', effort: 'high', approval_policy: 'never', sandbox_policy: { type: 'danger-full-access' } };
  for (const drift of [{ model: 'gpt-6-astra' }, { effort: 'medium' }, { approval_policy: 'on-request' }, { sandbox_policy: { type: 'workspace-write' } }]) {
    writeFileSync(path, [good, { ...good, ...drift }].map((payload) => JSON.stringify({ type: 'turn_context', payload })).join('\n') + '\n');
    expect(() => effectiveSession(sessionId, { sessionsRoot: root })).toThrow(/effective runtime/);
  }
  // An explicitly corrected resume uses the new context, not an older drift.
  writeFileSync(path, [{ ...good, model: 'gpt-6-astra' }, good].map((payload) => JSON.stringify({ type: 'turn_context', payload })).join('\n') + '\n');
  expect(effectiveSession(sessionId, { sessionsRoot: root }).model).toBe('gpt-6.1-sol');
});
