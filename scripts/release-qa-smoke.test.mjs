import { afterEach, expect, test, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { processIdentity, readJson } from './release-state.mjs';
import { assertSmokeSource, protectWindowsProfile, runQaSmoke } from './release-qa-smoke.mjs';

const roots = [], children = [];
// The ACL helper alone allows 15s; process identity also launches PowerShell.
// Keep fixture behavior deadlines separate from integration setup and cleanup.
const windowsIntegrationTimeout = process.platform === 'win32' ? 30_000 : 5_000;
const temp = () => { const root = mkdtempSync(join(tmpdir(), 'mythra-smoke-fixture-')); roots.push(root); return root; };
afterEach(() => { for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture({ earlyExit = false, ignoredClose = false, wrongContract = false, wrongPid = false, failedClose = false, missingOpen = false, controlDelayMs = 0, missingControl = false, wrongControlPid = false, wrongControlRun = false } = {}) {
  const root = temp(), script = join(root, 'fixture-child.mjs'), temporaryDirectory = join(root, 'profiles'), evidenceDirectory = join(root, 'evidence'); mkdirSync(temporaryDirectory);
  writeFileSync(script, `import{readFileSync,writeFileSync,appendFileSync,existsSync}from'node:fs';import{join}from'node:path';import{randomUUID}from'node:crypto';
const root=process.env.MYTHRA_RELEASE_QA_ROOT;const marker=JSON.parse(readFileSync(join(root,'.mythra-release-qa.json'),'utf8'));const runId=randomUUID();
const event=(kind,details={})=>appendFileSync(join(root,'events.jsonl'),JSON.stringify({schemaVersion:1,profileId:marker.profileId,pid:${wrongPid ? 'process.pid+1' : wrongControlPid ? "kind==='control-ready'?process.pid+1:process.pid" : 'process.pid'},runId:${wrongControlRun ? "kind==='control-ready'?randomUUID():runId" : 'runId'},kind,details})+'\\n');
${missingOpen ? '' : `event('profile-open',{contractVersion:${wrongContract ? '2' : '1'},providers:'blocked',persistentWebview:true,webviewStoreId:randomUUID()});`}
${earlyExit ? "setTimeout(()=>process.exit(0),100);" : ''}
// Match native install_control: a nonce present at installation is old debris.
setTimeout(()=>{const request=join(root,'request.json');let lastNonce=existsSync(request)?JSON.parse(readFileSync(request)).nonce:null;
${missingControl ? '' : "event('control-ready');"}
const timer=setInterval(()=>{if(existsSync(request)){const r=JSON.parse(readFileSync(request));if(r.nonce===lastNonce)return;lastNonce=r.nonce;if(r.profileId!==marker.profileId||r.action!=='close')process.exit(8);${ignoredClose ? '' : `event('close-finish',{accepted:true,result:'${failedClose ? 'failed' : 'saved'}'});event('exit');clearInterval(timer);process.exit(0);`}}},10);},${controlDelayMs});`);
  let profileRoot, launches = 0, protections = 0;
  return { options: { root, commit: 'a'.repeat(40), binaryPath: process.execPath, platform: 'win32', livenessMs: 250, startupTimeoutMs: 500, closeTimeoutMs: 200, pollMs: 10, temporaryDirectory, evidenceDirectory,
    assertSourceSupport() { return { version: 1 }; }, descendantsAlive() { return false; },
    protectProfile(path, marker) { protections++; profileRoot = path; expect(readJson(marker)).toMatchObject({ schemaVersion: 1, purpose: 'mythra-release-qa', profileId: expect.any(String) }); },
    inspectProcess(pid) { return { pid, processStart: processIdentity(pid), executablePath: process.execPath }; },
    spawnCandidate(binary, options) { launches++; expect(binary).toBe(realpathSync(process.execPath)); expect(options.env.MYTHRA_RELEASE_QA_ROOT).toBe(profileRoot); const child = spawn(binary, [script], options); children.push(child); return child; } },
    get profileRoot() { return profileRoot; }, get launches() { return launches; }, get protections() { return protections; } };
}

test('fixture liveness uses private marker, exact child, normal save-close and retained evidence', async () => {
  const f = fixture(); const result = await runQaSmoke(f.options);
  expect(result).toMatchObject({ passed: true, livenessMs: 250, closeAccepted: true, cleanupComplete: true, pid: expect.any(Number), runId: expect.any(String) });
  expect(result.elapsedMs).toBeGreaterThanOrEqual(250); expect(f.launches).toBe(1); expect(f.protections).toBe(1);
  expect(existsSync(f.profileRoot)).toBe(false);
  expect(readFileSync(join(result.evidenceDirectory, 'native-events.jsonl'), 'utf8')).toContain('close-finish');
  expect(readJson(join(result.evidenceDirectory, 'result.json')).cleanupComplete).toBe(true);
}, windowsIntegrationTimeout);

test('frozen unsupported source fails before profile creation and launch', async () => {
  const f = fixture(); f.options.assertSourceSupport = () => { throw new Error('unsupported frozen source'); };
  await expect(runQaSmoke(f.options)).rejects.toThrow('unsupported frozen source');
  expect(f.launches).toBe(0); expect(f.protections).toBe(0); expect(f.profileRoot).toBeUndefined();
});

test('ACL denial fails before launch and cleans only its owned temporary root', async () => {
  const f = fixture(), sentinel = join(f.options.root, 'user-profile'); mkdirSync(sentinel); writeFileSync(join(sentinel, 'data'), 'preserve');
  f.options.protectProfile = () => { throw new Error('ACL denied'); };
  await expect(runQaSmoke(f.options)).rejects.toThrow('ACL denied');
  expect(f.launches).toBe(0); expect(readFileSync(join(sentinel, 'data'), 'utf8')).toBe('preserve');
});

test.each([{ wrongContract: true }, { wrongPid: true }, { missingOpen: true }])('rejects unsupported or missing process-bound profile proof %o', async (mode) => {
  const f = fixture(mode); await expect(runQaSmoke(f.options)).rejects.toThrow(/profile/);
  expect(existsSync(f.profileRoot)).toBe(false); expect(children.at(-1).exitCode !== null || children.at(-1).signalCode !== null).toBe(true);
}, windowsIntegrationTimeout);

test('executable identity mismatch fails and stops only the owned fixture child', async () => {
  const f = fixture(), sentinel = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' }); children.push(sentinel);
  f.options.inspectProcess = (pid) => ({ pid, processStart: processIdentity(pid), executablePath: f.options.root });
  await expect(runQaSmoke(f.options)).rejects.toThrow(/exact built executable/);
  expect(sentinel.exitCode).toBe(null); expect(sentinel.signalCode).toBe(null);
  expect(existsSync(f.profileRoot)).toBe(false);
}, windowsIntegrationTimeout);

test('early exit fails the uptime requirement', async () => {
  const f = fixture();
  let now = 0;
  const child = Object.assign(new EventEmitter(), {
    pid: 4242, exitCode: null, signalCode: null,
    kill(signal) { this.signalCode = signal; return true; },
  });
  // Drive this negative uptime branch with an owned fake process and clock.
  // A real child's startup can exhaust 250ms before its own 100ms exit timer
  // starts. Other fixtures retain actual process/identity/normal-close checks.
  const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
  f.options.identifyProcess = (pid) => pid === child.pid ? 'fixture:4242' : undefined;
  f.options.inspectProcess = (pid) => ({ pid, processStart: f.options.identifyProcess(pid), executablePath: process.execPath });
  f.options.spawnCandidate = () => {
    const marker = readJson(join(f.profileRoot, '.mythra-release-qa.json'));
    const runId = 'f4444444-4444-4444-8444-444444444444';
    const event = (kind, details = {}) => ({ schemaVersion: 1, profileId: marker.profileId, pid: child.pid, runId, kind, details });
    writeFileSync(join(f.profileRoot, 'events.jsonl'), [
      event('profile-open', { contractVersion: 1, providers: 'blocked', persistentWebview: true, webviewStoreId: runId }),
      event('control-ready'),
    ].map((value) => JSON.stringify(value) + '\n').join(''));
    children.push(child);
    return child;
  };
  f.options.sleep = async (ms) => { now += ms; if (now >= 100) child.exitCode = 0; };
  try {
    await expect(runQaSmoke(f.options)).rejects.toThrow(/five-second smoke/);
    expect(now).toBeLessThan(f.options.livenessMs);
    expect(child.exitCode).toBe(0);
    expect(existsSync(f.profileRoot)).toBe(false);
  } finally { clock.mockRestore(); }
});

test('close deadline fails and terminates only its isolated candidate', async () => {
  const f = fixture({ ignoredClose: true }); await expect(runQaSmoke(f.options)).rejects.toThrow(/bounded normal close/);
  const results = children.at(-1); expect(results.signalCode).not.toBe(null); expect(existsSync(f.profileRoot)).toBe(false);
}, windowsIntegrationTimeout);

test('exit without successful production save-close evidence fails', async () => {
  const f = fixture({ failedClose: true }); await expect(runQaSmoke(f.options)).rejects.toThrow(/save\/exit evidence/);
  expect(existsSync(f.profileRoot)).toBe(false);
}, windowsIntegrationTimeout);

test('protected Windows ACLs use encoded structured paths and verify the allowlist', () => {
  let observed;
  const fakePath = "C:/temporary/path'; Remove-Item real-data";
  const result = protectWindowsProfile(fakePath, `${fakePath}/marker`, { execute: (command, args) => {
    expect(command).toBe('powershell.exe'); const source = Buffer.from(args.at(-1), 'base64').toString('utf16le');
    expect(source).not.toContain(fakePath); expect(source).toContain('SetAccessRuleProtection($true, $false)'); expect(source).toContain('S-1-5-18'); expect(source).toContain('S-1-5-32-544');
    expect(source).toContain('$directory.SetAccessControl($acl)'); expect(source).toContain('$file.SetAccessControl($markerAcl)'); expect(source).toContain('$item.GetAccessControl()');
    expect(source).not.toMatch(/\b(?:Set-Acl|Get-Acl|Get-Item)\b/);
    observed = JSON.parse(Buffer.from(source.match(/FromBase64String\('([^']+)'\)/)[1], 'base64').toString());
    return JSON.stringify({ protected: true, owner: 'S-1-5-21-123' });
  } });
  expect(observed.root).toBe(fakePath); expect(result.protected).toBe(true);
});

test.runIf(process.platform === 'win32')('actual Windows private root and marker ACLs pass independent ownership verification', () => {
  const root = temp(), marker = join(root, '.mythra-release-qa.json'); writeFileSync(marker, JSON.stringify({ schemaVersion: 1, purpose: 'mythra-release-qa', profileId: 'f4444444-4444-4444-8444-444444444444' }));
  expect(protectWindowsProfile(root, marker)).toMatchObject({ protected: true, owner: expect.stringMatching(/^S-1-/) });
}, windowsIntegrationTimeout);


test('remaining descendants fail bounded cleanup and preserve the private root', async () => {
  const f = fixture(); f.options.descendantsAlive = () => true;
  await expect(runQaSmoke(f.options)).rejects.toThrow(/descendants did not exit/);
  expect(children.at(-1).exitCode).toBe(0); expect(existsSync(f.profileRoot)).toBe(true);
}, windowsIntegrationTimeout);


test('exact HEAD guard rejects a different source before reading its QA contract', () => {
  const calls = [];
  expect(() => assertSmokeSource({ root: '/unused', plan: { commit: 'a'.repeat(40) }, execute: (_command, args) => { calls.push(args); return 'b'.repeat(40); } })).toThrow(/exact checkout HEAD/);
  expect(calls).toEqual([['rev-parse', 'HEAD']]);
});


test('delayed control installation beyond uptime snapshots old nonces before close is sent', async () => {
  const f = fixture({ controlDelayMs: 400 }); f.options.startupTimeoutMs = 1_000; f.options.closeTimeoutMs = 700;
  const result = await runQaSmoke(f.options);
  expect(result.cleanupComplete).toBe(true); expect(result.elapsedMs).toBeGreaterThanOrEqual(400);
  const events = readFileSync(join(result.evidenceDirectory, 'native-events.jsonl'), 'utf8');
  expect(events.indexOf('control-ready')).toBeLessThan(events.indexOf('close-finish'));
}, windowsIntegrationTimeout);

test.each([{ missingControl: true }, { wrongControlPid: true }, { wrongControlRun: true }])('missing or mismatched control readiness blocks close %o', async (mode) => {
  const f = fixture(mode);
  await expect(runQaSmoke(f.options)).rejects.toThrow(/control readiness/);
  expect(existsSync(f.profileRoot)).toBe(false);
}, windowsIntegrationTimeout);
