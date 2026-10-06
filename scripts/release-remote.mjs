import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { acquireLease, assertPlan, atomicJson, readJson, reconcile } from './release-state.mjs';
import { exportHandoff } from './release-handoff.mjs';

const PLATFORM = 'windows-x86_64';
const SSH = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=2'];
const execute = promisify(execFile);
const delay = (ms) => new Promise((accept) => setTimeout(accept, ms));

// Only a fixed PowerShell program is executed. All variable arguments travel as
// JSON inside a base64 string and never become executable shell expressions.
export function encodedPowerShell(program, payload = {}) {
  const data = Buffer.from(JSON.stringify(payload)).toString('base64');
  const prefix = `$ErrorActionPreference = 'Stop'; $p = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${data}')) | ConvertFrom-Json;\n`;
  return ['powershell.exe', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(prefix + program, 'utf16le').toString('base64')];
}

// This runner survives an SSH client/coordinator exit. It only invokes native
// build/check stages; uploading and publication remain with the Mac owner.
export function windowsRunnerSource({ root, stateRoot, workerFile, exportPath }) {
  const config = JSON.stringify({ root, stateRoot, workerFile, exportPath });
  return `import { spawn } from 'node:child_process';
import { openSync, closeSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const c = ${config};
const { atomicJson, assertPlan, readJson, reconcile, processIdentity } = await import(pathToFileURL(resolve(c.root, 'scripts/release-state.mjs')).href);
const { exportHandoff } = await import(pathToFileURL(resolve(c.root, 'scripts/release-handoff.mjs')).href);
const plan = assertPlan(readJson(resolve(c.stateRoot, 'plan.json')));
const old = readJson(c.workerFile);
const record = { ...old, status: 'running', pid: process.pid, processStart: processIdentity(), startedAt: new Date().toISOString() };
atomicJson(c.workerFile, record);
if (!record.processStart) { atomicJson(c.workerFile, { ...record, status: 'failed', reason: 'Cannot establish Windows runner process identity' }); throw new Error('Cannot establish Windows runner process identity'); }
const log = openSync(resolve(c.stateRoot, 'transport-worker.log'), 'a', 0o600);
try {
  const child = spawn(process.execPath, [resolve(c.root, 'scripts/release-coordinator.mjs'), 'run', '--state', c.stateRoot, '--build'], { cwd: c.root, stdio: ['ignore', log, log], windowsHide: true });
  atomicJson(c.workerFile, { ...record, childPid: child.pid });
  const exitCode = await new Promise((accept, reject) => { child.once('error', reject); child.once('exit', accept); });
  const stages = reconcile(plan, c.stateRoot);
  const needed = plan.checks.filter((s) => s.required && (s.id === 'ci' || s.platform === 'windows-x86_64'));
  const pending = needed.map((s) => stages.find((r) => r.id === s.id)).filter((s) => s.status !== 'passed');
  const active = existsSync(resolve(c.stateRoot, 'active-stage.json')) ? readJson(resolve(c.stateRoot, 'active-stage.json')) : null;
  if (![0, 2].includes(exitCode) || pending.some((s) => s.status === 'invalid') || active?.status === 'blocked') throw new Error('Windows stage failed; inspect preserved transport-worker.log and active-stage.json');
  exportHandoff(c.stateRoot, c.exportPath, 'windows-x86_64');
  atomicJson(c.workerFile, { ...record, status: pending.length ? 'waiting' : 'complete', exitCode, pending, exportPath: c.exportPath, completedAt: new Date().toISOString() });
} catch (error) {
  atomicJson(c.workerFile, { ...record, status: 'failed', reason: error.message, stoppedAt: new Date().toISOString() });
  process.exitCode = 1;
} finally { closeSync(log); }
`;
}

const identityProgram = `
if ($env:COMPUTERNAME -ne 'ZEDS-PC' -or [Environment]::UserName -ne 'puzzl') { throw 'Unexpected Windows builder identity' }
$node = (Get-Command node.exe -ErrorAction Stop).Source
$version = & $node -p 'process.versions.node'; if ($LASTEXITCODE -ne 0) { throw 'Node preflight failed' }
[void](Get-Command git.exe -ErrorAction Stop); [void](Get-Command npm.cmd -ErrorAction Stop); [void](Get-Command gh.exe -ErrorAction Stop)
@{host=$env:COMPUTERNAME; user=[Environment]::UserName; base=(Join-Path $env:USERPROFILE 'Documents/MythraCode-Releases'); node=$node; version=$version} | ConvertTo-Json -Compress`;

const prepareProgram = `
if ($env:COMPUTERNAME -ne 'ZEDS-PC' -or [Environment]::UserName -ne 'puzzl') { throw 'Unexpected Windows builder identity' }
[void][IO.Directory]::CreateDirectory($p.directory)
if (!(Test-Path -LiteralPath $p.root)) {
  & git.exe clone --no-checkout --filter=blob:none -- 'https://github.com/m17h/Mythra-Code.git' $p.root
  if ($LASTEXITCODE -ne 0) { throw 'Dedicated Windows checkout clone failed' }
  & git.exe -C $p.root fetch origin $p.commit; if ($LASTEXITCODE -ne 0) { throw 'Exact source fetch failed' }
  & git.exe -C $p.root checkout --detach $p.commit; if ($LASTEXITCODE -ne 0) { throw 'Exact source checkout failed' }
}
$head = & git.exe -C $p.root rev-parse HEAD; if ($LASTEXITCODE -ne 0 -or $head -ne $p.commit) { throw 'Windows checkout source changed' }
$dirty = & git.exe -C $p.root status --porcelain; if ($LASTEXITCODE -ne 0 -or $dirty) { throw 'Windows release checkout is dirty' }
$origin = & git.exe -C $p.root remote get-url origin
if ($LASTEXITCODE -ne 0 -or $origin -notmatch '^(https://github.com/|git@github.com:)m17h/Mythra-Code(\\.git)?$') { throw 'Wrong Windows repository' }
[void][IO.Directory]::CreateDirectory($p.incoming)
@{ready=$true} | ConvertTo-Json -Compress`;

const launchProgram = `
$guard = $null
try {
  $guard = [IO.File]::Open($p.lock, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
  if (Test-Path -LiteralPath $p.workerFile) { Get-Content -Raw -LiteralPath $p.workerFile; exit 0 }
  if (Test-Path -LiteralPath $p.stateRoot) { throw 'Remote state already exists without transport ownership; inspect before restarting' }
  Move-Item -LiteralPath $p.incoming -Destination $p.stateRoot
  $queued = @{schemaVersion=1; planHash=$p.planHash; status='queued'; queuedAt=[DateTime]::UtcNow.ToString('o')}
  [IO.File]::WriteAllText($p.workerFile, ($queued | ConvertTo-Json -Compress), [Text.UTF8Encoding]::new($false))
  [IO.File]::WriteAllText($p.runner, $p.source, [Text.UTF8Encoding]::new($false))
  # The durable queued record precedes spawn. An ambiguous launch is diagnosed,
  # never automatically replaced by another build process.
  $proc = Start-Process -FilePath $p.node -ArgumentList ('"' + $p.runner + '"') -WorkingDirectory $p.root -WindowStyle Hidden -PassThru
  $proc.Refresh()
  @{schemaVersion=1; planHash=$p.planHash; status='running'; pid=$proc.Id; processStart=$proc.StartTime.ToUniversalTime().Ticks.ToString()} | ConvertTo-Json -Compress
} finally { if ($null -ne $guard) { $guard.Dispose(); Remove-Item -LiteralPath $p.lock } }`;

const statusProgram = `
if (!(Test-Path -LiteralPath $p.workerFile)) { @{status='absent'} | ConvertTo-Json -Compress; exit 0 }
$w = Get-Content -Raw -LiteralPath $p.workerFile | ConvertFrom-Json
if ($w.status -eq 'running' -and $w.pid) {
  $proc = Get-Process -Id $w.pid -ErrorAction SilentlyContinue
  $alive = $null -ne $proc -and $proc.StartTime.ToUniversalTime().Ticks.ToString() -eq $w.processStart
  $w | Add-Member -NotePropertyName alive -NotePropertyValue $alive -Force
  # Preserve descendants on an interrupted wrapper. The coordinator and its
  # native builder can remain alive after the transport runner exits.
  $descendants = @(Get-CimInstance Win32_Process | Where-Object { $_.ParentProcessId -eq $w.pid -or ($w.childPid -and $_.ParentProcessId -eq $w.childPid) })
  $w | Add-Member -NotePropertyName descendantsAlive -NotePropertyValue ($descendants.Count -gt 0) -Force
}
$w | ConvertTo-Json -Depth 12 -Compress`;

export function createSshTransport({ command = execute } = {}) {
  const run = async (program, payload = {}, timeout = 60_000) => {
    const result = await command('ssh', [...SSH, 'zeds-pc-ai', ...encodedPowerShell(program, payload)], { timeout, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' });
    // Setup commands can write logs before their final JSON object.
    return JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));
  };
  return {
    async preflight() {
      // The authoritative LAN guide must be read before further PC access.
      await command('ssh', [...SSH, 'zeds-pc-ai', ...encodedPowerShell("Get-Content -Raw -LiteralPath 'C:\\Users\\puzzl\\Documents\\lan_access.md'")], { timeout: 30_000, maxBuffer: 1024 * 1024, encoding: 'utf8' });
      const result = await run(identityProgram);
      if (result.host !== 'ZEDS-PC' || result.user !== 'puzzl' || !/^\d+\.\d+\.\d+$/.test(result.version)) throw new Error('Unexpected Windows capability response');
      const [major, minor] = result.version.split('.').map(Number);
      if (major < 20 || (major === 20 && minor < 19)) throw new Error('Windows Node must be at least 20.19');
      if (![result.base, result.node].every((p) => typeof p === 'string' && /^[A-Z]:[\\/]/i.test(p) && !/["\r\n]/.test(p))) throw new Error('Invalid Windows builder paths');
      return result;
    },
    prepare: (payload) => run(prepareProgram, payload, 20 * 60_000),
    async upload(local, remote) {
      await command('scp', ['-r', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', `${local}/.`, `zeds-pc-ai:${remote.replaceAll('\\', '/')}`], { timeout: 20 * 60_000, maxBuffer: 1024 * 1024 });
    },
    start: (payload) => run(launchProgram, payload),
    status: (payload) => run(statusProgram, payload),
    async download(remote, local) {
      mkdirSync(local, { recursive: true });
      await command('scp', ['-r', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', `zeds-pc-ai:${remote.replaceAll('\\', '/')}/.`, local], { timeout: 20 * 60_000, maxBuffer: 1024 * 1024 });
    },
  };
}

function validateHandoff(plan, local) {
  const imported = assertPlan(readJson(resolve(local, 'plan.json')));
  if (imported.planHash !== plan.planHash) throw new Error('Returned Windows handoff is for another release');
  const statuses = reconcile(plan, local);
  const manifest = readJson(resolve(local, 'handoff.json'));
  if (manifest.planHash !== plan.planHash || manifest.schemaVersion !== 1 || !Array.isArray(manifest.checks)
    || new Set(manifest.checks).size !== manifest.checks.length
    || manifest.checks.some((id) => statuses.find((s) => s.id === id)?.status !== 'passed' || ['draft', 'publish', 'public'].includes(id))) throw new Error('Returned Windows handoff has invalid evidence');
  return plan.checks.filter((c) => c.required && (c.id === 'ci' || c.platform === PLATFORM)).every((c) => manifest.checks.includes(c.id) && statuses.find((s) => s.id === c.id)?.status === 'passed');
}

function waiting(message) { return Object.assign(new Error(message), { status: 'waiting' }); }
function blockedPartial() { return Object.assign(new Error('Windows handoff is incomplete; inspect preserved remote native worker ownership and results, then export a NEW handoff for manual merge. Automatic collection cannot refresh this terminal handoff and will not restart or rebuild the worker.'), { status: 'blocked' }); }

export async function runWindowsWorker({ root, stateRoot, plan, onStatus = () => {}, transport = createSshTransport(), pollMs = 5_000, timeoutMs = 2 * 60 * 60_000, sleep = delay }) {
  assertPlan(plan);
  if (readJson(resolve(stateRoot, 'plan.json')).planHash !== plan.planHash) throw new Error('Windows transport plan differs from coordinator state');
  if (!Number.isFinite(pollMs) || pollMs < 1 || !Number.isFinite(timeoutMs) || timeoutMs < 1) throw new Error('Windows transport needs a bounded polling interval and timeout');
  const directory = resolve(stateRoot, 'remote', PLATFORM);
  mkdirSync(directory, { recursive: true });
  let release;
  try { release = acquireLease(directory, { recover: true }); } catch (error) {
    if (/Release already has a (running|foreign-host) owner/.test(error.message)) throw waiting('Another Windows transport collector owns this worker; wait for its result and resume collection');
    throw error;
  }
  const recordPath = resolve(directory, 'worker.json');
  let record = existsSync(recordPath) ? readJson(recordPath) : null;
  const update = async (status, extra = {}) => {
    record = { ...record, schemaVersion: 1, planHash: plan.planHash, status, ...extra, updatedAt: new Date().toISOString() };
    atomicJson(recordPath, record); await onStatus(record);
  };
  const started = Date.now();
  try {
    if (record && record.planHash !== plan.planHash) throw new Error('Windows transport belongs to another release plan');
    if (record?.status === 'failed') {
      if (record.blocked) throw blockedPartial();
      throw new Error(`Previous Windows worker failed: ${record.reason}; diagnose before creating a replacement`);
    }
    if (record?.localHandoff && existsSync(resolve(record.localHandoff, 'handoff.json'))) {
      if (!validateHandoff(plan, record.localHandoff)) throw blockedPartial();
      return record.localHandoff;
    }
    const capability = await transport.preflight();
    if (!record?.paths) {
      const remoteDirectory = `${capability.base.replaceAll('\\', '/')}/${plan.planHash}`;
      const paths = { directory: remoteDirectory, root: `${remoteDirectory}/checkout`, stateRoot: `${remoteDirectory}/state`, incoming: `${remoteDirectory}/incoming`,
        workerFile: `${remoteDirectory}/worker.json`, runner: `${remoteDirectory}/worker.mjs`, lock: `${remoteDirectory}/launch.lock`, exportPath: `${remoteDirectory}/returned` };
      await update('queued', { paths, queuedAt: new Date().toISOString() });
    }
    const paths = record.paths;
    let observed = await transport.status(paths);
    if (observed.status === 'absent') {
      if (record.launchedAt) throw waiting('Windows launch was recorded but its remote ownership file is missing; inspect before restarting');
      const outbound = resolve(directory, `outbound-${randomUUID()}`);
      exportHandoff(stateRoot, outbound, PLATFORM);
      await transport.prepare({ ...paths, commit: plan.commit });
      await transport.upload(outbound, paths.incoming);
      await update('queued', { launchedAt: new Date().toISOString() });
      observed = await transport.start({ ...paths, planHash: plan.planHash, node: capability.node, source: windowsRunnerSource(paths) });
    }
    for (;;) {
      if (observed.planHash && observed.planHash !== plan.planHash) throw new Error('Remote worker changed its frozen release plan');
      if (observed.status === 'failed') throw new Error(observed.reason || 'Windows worker failed; inspect preserved remote logs');
      if (['complete', 'waiting'].includes(observed.status) && observed.exportPath) {
        if (observed.exportPath !== paths.exportPath) throw new Error('Remote handoff escaped the dedicated release directory');
        const local = resolve(directory, `returned-${randomUUID()}`);
        await transport.download(paths.exportPath, local);
        const complete = validateHandoff(plan, local);
        await update(complete ? 'complete' : 'failed', { localHandoff: local, remote: observed, blocked: !complete });
        if (!complete) throw blockedPartial();
        return local;
      }
      if (observed.status === 'running' && observed.alive === false) throw waiting(observed.descendantsAlive
        ? 'Windows runner ended while native descendants remain alive; preserve their work and inspect remote logs'
        : 'Windows worker exited without a terminal result; inspect remote logs before retry');
      if (!['queued', 'running', 'waiting'].includes(observed.status)) throw new Error('Invalid remote Windows worker status');
      await update(observed.status, { remote: observed });
      if (Date.now() - started >= timeoutMs) throw waiting('Windows polling deadline reached; the remote worker remains owned and can be collected on resume');
      await sleep(Math.min(pollMs, Math.max(1, timeoutMs - (Date.now() - started))));
      observed = await transport.status(paths);
    }
  } catch (error) {
    // SSH/SCP interruptions preserve remote ownership. Resume inspects the same PID;
    // it never guesses that a disconnected client means the builder stopped.
    const transient = error.status === 'waiting' || ['ETIMEDOUT', 'ECONNRESET', 'ENETUNREACH'].includes(error.code) || error.killed || (/^(?:ssh|scp) /.test(error.cmd ?? '') && error.code === 255);
    await update(transient ? 'waiting' : 'failed', { blocked: error.status === 'blocked', reason: transient ? 'Remote Windows transport interrupted; inspect worker status and resume collection' : error.message });
    throw error;
  } finally { release(); }
}
