import { afterEach, expect, test } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { atomicJson, processIdentity, readJson } from './release-state.mjs';
import { collectNativeWorker, effectiveSession, launchNativeWorker, resolveCodexBinary } from './release-native-check.mjs';

const roots = [];
const fixtures = [];
const temp = () => { const root = mkdtempSync(join(tmpdir(), 'mythra-native-launch-')); roots.push(root); return root; };
afterEach(async () => {
  // A durable terminal result precedes wrapper exit. Windows retains its cwd
  // until then; wait for the exact fixture owners, rather than retrying rmdir.
  const deadline = Date.now() + 5_000;
  for (const c of fixtures) {
    const status = existsSync(c.statusPath) ? readJson(c.statusPath) : {};
    const spawned = existsSync(`${c.statusPath}.spawn.json`) ? readJson(`${c.statusPath}.spawn.json`) : null;
    const owners = [status.worker, status.childWorker, spawned].filter((owner) => owner?.processStart);
    while (owners.some((owner) => processIdentity(owner.pid) === owner.processStart)) {
      if (Date.now() >= deadline) throw new Error(`Native fixture owners did not exit; evidence preserved at ${c.root}`);
      await new Promise((accept) => setTimeout(accept, 10));
    }
  }
  fixtures.splice(0);
  roots.splice(0).forEach((r) => rmSync(r, { recursive: true, force: true }));
}, 15_000);
const sessionId = '01a10d39-6aec-7721-9b90-ab146f5b533e';
function config({ script, deadlineMs = 5_000 } = {}) {
  const root = temp(), cli = join(root, 'fixture-cli.mjs'), resultPath = join(root, 'result.json');
  writeFileSync(cli, script || `import {writeFileSync} from 'node:fs'; process.stdin.resume(); console.log(JSON.stringify({type:'thread.started',thread_id:'${sessionId}'})); setTimeout(()=>{writeFileSync(${JSON.stringify(resultPath)},'{}');console.log(JSON.stringify({type:'turn.completed'}));},200);`);
  const promptPath = join(root, 'prompt.txt'); writeFileSync(promptPath, 'Fixture only');
  const c = { binary: process.execPath, args: [cli], root, promptPath, statusPath: join(root, 'status.json'), resultPath, eventsPath: join(root, 'events.jsonl'), errorsPath: join(root, 'stderr.log'), deadlineMs, terminationGraceMs: 10, contractHash: 'c'.repeat(64) };
  fixtures.push(c);
  return c;
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
}, 15_000);

test.each(['result-ready', 'passed'])('collection rereads %s written while the ownership query finishes', async (terminal) => {
  const root = temp(), statusPath = join(root, 'status.json');
  const running = { status: 'running', worker: { pid: 42, processStart: 'fixture' }, contractHash: 'c'.repeat(64) };
  atomicJson(statusPath, running);
  const finished = { ...running, status: terminal, sessionId };
  let probes = 0;
  expect(await collectNativeWorker(statusPath, { timeoutMs: 10, ownershipAlive(status) {
    expect(status).toEqual(running); probes++; atomicJson(statusPath, finished); return false;
  } })).toEqual(finished);
  expect(probes).toBe(1);
});

test('collection retains a blocker written during the ownership query', async () => {
  const root = temp(), statusPath = join(root, 'status.json');
  atomicJson(statusPath, { status: 'running', worker: { pid: 42, processStart: 'fixture' } });
  await expect(collectNativeWorker(statusPath, { ownershipAlive() {
    atomicJson(statusPath, { status: 'blocked', reason: 'invalid native result' }); return false;
  } })).rejects.toThrow(/blocked: invalid native result/);
});

test('a dead owner without a terminal record stays fail closed and preserves evidence', async () => {
  const root = temp(), statusPath = join(root, 'status.json');
  const running = { status: 'running', worker: { pid: 42, processStart: 'fixture' } };
  atomicJson(statusPath, running);
  await expect(collectNativeWorker(statusPath, { ownershipAlive: () => false })).rejects.toMatchObject({ status: 'waiting', message: expect.stringMatching(/without a terminal result/) });
  expect(readJson(statusPath)).toEqual(running);
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
