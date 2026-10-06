import { afterEach, expect, test } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createPlan } from './release-plan.mjs';
import { atomicJson, fileHash, readJson, saveReceipt } from './release-state.mjs';
import { exportHandoff, mergeHandoff } from './release-handoff.mjs';
import { createSshTransport, encodedPowerShell, runWindowsWorker, windowsRunnerSource } from './release-remote.mjs';
import { expectedReceipts } from './verify-ci.mjs';

const roots = [];
const temp = () => { const root = mkdtempSync(join(tmpdir(), 'mythra-transport-')); roots.push(root); return root; };
afterEach(() => roots.splice(0).forEach((r) => rmSync(r, { recursive: true, force: true })));
const plan = () => createPlan({ commit: 'a'.repeat(40), version: '1.2.3', baseline: { commit: 'b'.repeat(40), tag: 'v1.2.2', reason: 'Previous accepted release' }, changedFiles: [], policyHash: 'c'.repeat(64) });
const capability = { host: 'ZEDS-PC', user: 'puzzl', base: 'C:/Users/puzzl/Documents/MythraCode-Releases', node: 'C:/Program Files/nodejs/node.exe', version: '24.0.0' };
function fixture() { const stateRoot = temp(), p = plan(); atomicJson(join(stateRoot, 'plan.json'), p); return { root: temp(), stateRoot, plan: p }; }
function windowsEvidence(p, root) {
  atomicJson(join(root, 'plan.json'), p);
  const put = (id, details, checkerVersion = 'release-coordinator-v1') => {
    const name = id === 'build:windows-x86_64' ? `MythraCode_${p.version}_x64-setup.exe` : `${id.replaceAll(':', '_')}.txt`;
    writeFileSync(join(root, name), id);
    const evidence = [{ path: name, sha256: fileHash(join(root, name)) }];
    saveReceipt(root, p, { schemaVersion: 1, checkId: id, status: 'passed', planHash: p.planHash, commit: p.commit, checkerVersion,
      ...(id.includes('windows-x86_64') ? { platform: 'windows-x86_64' } : {}), startedAt: '2026-01-01T00:00:00Z', completedAt: '2026-01-01T00:00:01Z', evidence,
      details: typeof details === 'function' ? details(evidence[0]) : details });
  };
  const jobs = ['WebKit (macOS 15)', 'Verify gate', ...['macos-latest', 'windows-latest'].flatMap((os) => [`Rust (${os})`, `Renderer (${os})`, `Unit (${os}, 1/2)`, `Unit (${os}, 2/2)`])];
  put('ci', { repository: p.repository, commit: p.commit, runId: 123, input: { checkout: p.commit, head: p.commit, event: 'push' }, receiptHashes: expectedReceipts().map((id) => ({ id, sha256: 'd'.repeat(64) })), jobs: jobs.map((name) => ({ name, status: 'completed', conclusion: 'success' })) });
  put('build:windows-x86_64', (item) => ({ packageSha256: item.sha256, packagePath: item.path, command: ['npm.cmd', 'run', 'release:build'], exitCode: 0, node: 'v24', host: 'ZEDS-PC' }));
  put('audit:windows-x86_64', { packageSha256: fileHash(join(root, `MythraCode_${p.version}_x64-setup.exe`)), executableSha256: 'e'.repeat(64), payloadPe: { machine: 0x8664, subsystem: 'WindowsGui' }, payloadVersion: p.version, authenticodeStatus: 'NotSigned' }, 'native-integrity-v1');
}
function fakeTransport({ result, complete = true } = {}) {
  let worker = { status: 'absent' }, launches = 0, downloads = 0;
  const t = { async preflight() { return capability; }, async prepare() {}, async upload() {},
    async start(paths) { launches++; worker = { status: 'running', planHash: paths.planHash, pid: 42, processStart: 'ticks', alive: true }; return worker; },
    async status(paths) { if (worker.status !== 'absent') worker = result ?? { status: 'complete', planHash: paths.planHash, exportPath: paths.exportPath }; return worker; },
    async download(_remote, local) {
      downloads++; const p = plan(), source = temp();
      if (complete) windowsEvidence(p, source); else atomicJson(join(source, 'plan.json'), p);
      exportHandoff(source, local, 'windows-x86_64');
    }, get launches() { return launches; }, get downloads() { return downloads; }, set worker(value) { worker = value; } };
  return t;
}

test('roundtrip collects typed receipts and resumes without launching or downloading again', async () => {
  const f = fixture(), transport = fakeTransport(), updates = [];
  const local = await runWindowsWorker({ ...f, transport, sleep: async () => {}, onStatus: (s) => updates.push(s.status) });
  expect(updates).toEqual(['queued', 'queued', 'running', 'complete']);
  expect(transport.launches).toBe(1);
  expect(readJson(join(local, 'handoff.json')).checks).toEqual(['ci', 'build:windows-x86_64', 'audit:windows-x86_64']);
  expect(mergeHandoff(local, f.stateRoot).imported).toHaveLength(3);
  expect(await runWindowsWorker({ ...f, transport })).toBe(local);
  expect(transport.launches).toBe(1); expect(transport.downloads).toBe(1);
});

test('exit 2 with missing Windows evidence remains waiting, even when remote says complete', async () => {
  const f = fixture(), transport = fakeTransport({ complete: false });
  const local = await runWindowsWorker({ ...f, transport, sleep: async () => {} });
  expect(existsSync(join(local, 'handoff.json'))).toBe(true);
  expect(readJson(join(f.stateRoot, 'remote/windows-x86_64/worker.json')).status).toBe('waiting');
});

test('SSH interruption preserves process ownership and resumes collection without a duplicate', async () => {
  const f = fixture(), transport = fakeTransport();
  const original = transport.status; let polls = 0;
  transport.status = async (...args) => { if (++polls === 2) throw Object.assign(new Error('socket lost'), { code: 'ECONNRESET' }); return original(...args); };
  await expect(runWindowsWorker({ ...f, transport, sleep: async () => {} })).rejects.toThrow('socket lost');
  expect(readJson(join(f.stateRoot, 'remote/windows-x86_64/worker.json')).status).toBe('waiting');
  await runWindowsWorker({ ...f, transport, sleep: async () => {} });
  expect(transport.launches).toBe(1);
});

test('dead PID and descendants cannot silently trigger another builder', async () => {
  const f = fixture(), transport = fakeTransport({ result: { status: 'running', alive: false, descendantsAlive: true } });
  await expect(runWindowsWorker({ ...f, transport, sleep: async () => {} })).rejects.toMatchObject({ status: 'waiting' });
  await expect(runWindowsWorker({ ...f, transport, sleep: async () => {} })).rejects.toMatchObject({ status: 'waiting' });
  expect(transport.launches).toBe(1);
});

test('bounded poll deadline preserves running worker for a later collection', async () => {
  const f = fixture(), transport = fakeTransport({ result: { status: 'running', alive: true } });
  await expect(runWindowsWorker({ ...f, transport, timeoutMs: 5, pollMs: 1 })).rejects.toMatchObject({ status: 'waiting' });
  expect(transport.launches).toBe(1);
});

test('remote failures remain failed and require diagnosis instead of automatic retry', async () => {
  const f = fixture(), transport = fakeTransport({ result: { status: 'failed', reason: 'Bad signature' } });
  await expect(runWindowsWorker({ ...f, transport, sleep: async () => {} })).rejects.toThrow('Bad signature');
  await expect(runWindowsWorker({ ...f, transport })).rejects.toThrow(/Previous Windows worker failed/);
  expect(transport.launches).toBe(1);
});

test('remote handoff path and evidence changes are rejected', async () => {
  const f = fixture(), transport = fakeTransport({ result: { status: 'complete', exportPath: 'C:/outside' } });
  await expect(runWindowsWorker({ ...f, transport, sleep: async () => {} })).rejects.toThrow(/escaped/);
  const g = fixture(), tampered = fakeTransport(), download = tampered.download;
  tampered.download = async (...args) => { await download(...args); writeFileSync(join(args[1], 'MythraCode_1.2.3_x64-setup.exe'), 'modified'); };
  await expect(runWindowsWorker({ ...g, transport: tampered, sleep: async () => {} })).rejects.toThrow(/invalid evidence/);
});

test('PowerShell data cannot escape encoding and the LAN guide is read first', async () => {
  const evil = `C:/path ' ; Remove-Item secrets; $(Get-Secret)`;
  const args = encodedPowerShell('$p.path | ConvertTo-Json -Compress', { path: evil });
  const source = Buffer.from(args.at(-1), 'base64').toString('utf16le');
  expect(source).not.toContain(evil);
  const payload = source.match(/FromBase64String\('([^']+)'\)/)[1];
  expect(JSON.parse(Buffer.from(payload, 'base64').toString())).toEqual({ path: evil });
  const calls = [];
  const transport = createSshTransport({ command: async (file, commandArgs) => {
    calls.push({ file, args: commandArgs, source: Buffer.from(commandArgs.at(-1), 'base64').toString('utf16le') });
    return { stdout: calls.length === 1 ? 'Authoritative guide' : JSON.stringify(capability) };
  } });
  await transport.preflight();
  expect(calls[0].source).toContain('lan_access.md'); expect(calls[1].source).toContain("'ZEDS-PC'");
  expect(calls.every((c) => c.file === 'ssh' && c.args.includes('zeds-pc-ai'))).toBe(true);
});

test('persistent runner executes the real child/export boundary using a local fixture, with build scope only', () => {
  const root = temp(), stateRoot = temp(), directory = temp(), p = plan();
  mkdirSync(join(root, 'scripts'));
  for (const name of ['release-state.mjs', 'release-handoff.mjs']) {
    const module = pathToFileURL(resolve(import.meta.dirname, name)).href;
    writeFileSync(join(root, 'scripts', name), `export * from ${JSON.stringify(module)};`);
  }
  writeFileSync(join(root, 'scripts/release-coordinator.mjs'), `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(join(directory, 'args.json'))},JSON.stringify(process.argv.slice(2))); process.exitCode=2;`);
  atomicJson(join(stateRoot, 'plan.json'), p);
  const workerFile = join(directory, 'worker.json'), exportPath = join(directory, 'returned');
  atomicJson(workerFile, { schemaVersion: 1, status: 'queued', planHash: p.planHash });
  const runner = join(directory, 'runner.mjs'); writeFileSync(runner, windowsRunnerSource({ root, stateRoot, workerFile, exportPath }));
  execFileSync(process.execPath, [runner]);
  expect(readJson(join(directory, 'args.json'))).toEqual(['run', '--state', stateRoot, '--build']);
  expect(readJson(workerFile)).toMatchObject({ status: 'waiting', exitCode: 2, planHash: p.planHash, pid: expect.any(Number), processStart: expect.any(String) });
  expect(readJson(join(exportPath, 'handoff.json')).checks).toEqual([]);
});


test('preflight network interruption before path allocation resumes safely', async () => {
  const f = fixture(), transport = fakeTransport(); const preflight = transport.preflight; let calls = 0;
  transport.preflight = async () => { if (++calls === 1) throw Object.assign(new Error('preflight disconnected'), { code: 'ECONNRESET' }); return preflight(); };
  await expect(runWindowsWorker({ ...f, transport })).rejects.toThrow('preflight disconnected');
  await runWindowsWorker({ ...f, transport, sleep: async () => {} });
  expect(transport.launches).toBe(1);
});

test('cached evidence is validated again before reuse', async () => {
  const f = fixture(), transport = fakeTransport();
  const local = await runWindowsWorker({ ...f, transport, sleep: async () => {} });
  writeFileSync(join(local, 'MythraCode_1.2.3_x64-setup.exe'), 'changed after collection');
  await expect(runWindowsWorker({ ...f, transport })).rejects.toThrow(/invalid evidence/);
  expect(transport.launches).toBe(1);
});
