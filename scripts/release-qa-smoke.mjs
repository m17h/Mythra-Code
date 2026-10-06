import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { assertQaSourceSupport } from './release-native-check.mjs';
import { atomicJson, fileHash, processIdentity, SHA } from './release-state.mjs';
import { encodedPowerShell } from './release-remote.mjs';

const wait = (ms) => new Promise((accept) => setTimeout(accept, ms));
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

export function assertSmokeSource({ root, plan, execute = execFileSync }) {
  const head = execute('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  if (head !== plan.commit) throw new Error('QA smoke source does not match the exact checkout HEAD');
  return assertQaSourceSupport({ root, plan, execute });
}

export function protectWindowsProfile(root, marker, { execute = execFileSync } = {}) {
  const program = `
$i = [Security.Principal.WindowsIdentity]::GetCurrent(); $user = $i.User
$allowed = @($user, [Security.Principal.SecurityIdentifier]::new('S-1-5-18'), [Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))
$acl = [Security.AccessControl.DirectorySecurity]::new(); $acl.SetAccessRuleProtection($true, $false); $acl.SetOwner($user)
foreach ($sid in $allowed) {
  $rule = [Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow'); $acl.AddAccessRule($rule)
}
Set-Acl -LiteralPath $p.root -AclObject $acl
$markerAcl = [Security.AccessControl.FileSecurity]::new(); $markerAcl.SetAccessRuleProtection($true, $false); $markerAcl.SetOwner($user)
foreach ($sid in $allowed) { $markerAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', 'Allow')) }
Set-Acl -LiteralPath $p.marker -AclObject $markerAcl
foreach ($path in @($p.root, $p.marker)) {
  $item = Get-Item -LiteralPath $path -Force
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'QA smoke profile has a reparse point' }
  $check = Get-Acl -LiteralPath $path
  if (!$check.AreAccessRulesProtected -or $check.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $user.Value) { throw 'QA smoke profile ACL ownership failed' }
  foreach ($rule in $check.Access) { if ($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -notin $allowed.Value) { throw 'QA smoke profile ACL permits another principal' } }
}
@{protected=$true; owner=$user.Value} | ConvertTo-Json -Compress`;
  const result = JSON.parse(execute(...encodedCommand(program, { root, marker })));
  if (result.protected !== true || !/^S-1-/.test(result.owner)) throw new Error('Windows QA profile ACL verification failed');
  return result;
}
function encodedCommand(program, payload) {
  const [command, ...args] = encodedPowerShell(program, payload);
  return [command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15_000 }];
}

export function inspectWindowsProcess(pid, { execute = execFileSync } = {}) {
  if (!Number.isInteger(pid) || pid < 1) throw new Error('Invalid owned smoke PID');
  const program = `$proc = Get-Process -Id $p.pid -ErrorAction Stop; $native = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $p.pid); @{pid=$proc.Id; executablePath=$native.ExecutablePath; processStart=$proc.StartTime.ToUniversalTime().Ticks.ToString()} | ConvertTo-Json -Compress`;
  return JSON.parse(execute(...encodedCommand(program, { pid })));
}

export function windowsDescendantsAlive(pid, { execute = execFileSync } = {}) {
  if (!Number.isInteger(pid) || pid < 1) throw new Error('Invalid owned smoke PID');
  const program = `$rows = @(Get-CimInstance Win32_Process); $parents = [Collections.Generic.HashSet[int]]::new(); [void]$parents.Add([int]$p.pid); $found = $false; do { $changed = $false; foreach ($row in $rows) { if ($parents.Contains([int]$row.ParentProcessId) -and !$parents.Contains([int]$row.ProcessId)) { [void]$parents.Add([int]$row.ProcessId); $changed = $true; $found = $true } } } while ($changed); @{alive=$found} | ConvertTo-Json -Compress`;
  const result = JSON.parse(execute(...encodedCommand(program, { pid })));
  if (typeof result.alive !== 'boolean') throw new Error('Cannot verify owned smoke descendants');
  return result.alive;
}

function readEvents(profileRoot) {
  const path = join(profileRoot, 'events.jsonl');
  if (!existsSync(path)) return [];
  const text = readFileSync(path, 'utf8');
  // An append may be in progress. Only newline-terminated events are proof.
  const lines = text.split('\n'); lines.pop();
  return lines.filter(Boolean).map((line) => JSON.parse(line));
}
function active(child) { return child.exitCode === null && child.signalCode === null; }
function matches(event, { profileId, pid, runId }) {
  return event.schemaVersion === 1 && event.profileId === profileId && event.pid === pid && (runId === undefined || event.runId === runId);
}

export async function runQaSmoke({ root, binaryPath, commit, platform = process.platform,
  livenessMs = 5_000, startupTimeoutMs = 15_000, closeTimeoutMs = 15_000, pollMs = 50,
  assertSourceSupport = assertSmokeSource, protectProfile = protectWindowsProfile,
  inspectProcess = inspectWindowsProcess, identifyProcess = processIdentity, descendantsAlive = windowsDescendantsAlive,
  spawnCandidate = (file, options) => spawn(file, [], options), sleep = wait,
  temporaryDirectory = tmpdir(), evidenceDirectory = resolve(root, '.test-artifacts', 'release-qa-smoke') }) {
  if (platform !== 'win32') throw new Error('This production liveness helper supports Windows only');
  if (!SHA.test(commit)) throw new Error('QA smoke requires an exact source commit');
  for (const value of [livenessMs, startupTimeoutMs, closeTimeoutMs, pollMs]) if (!Number.isFinite(value) || value <= 0) throw new Error('QA smoke deadlines must be positive and bounded');
  // Unsupported old binaries may ignore the QA environment. The frozen source
  // contract is checked BEFORE creating a profile or launching any process.
  assertSourceSupport({ root, plan: { commit } });
  const executable = realpathSync(binaryPath);
  if (!statSync(executable).isFile()) throw new Error('QA smoke executable is not a file');
  const executableSha256 = fileHash(executable), profileId = randomUUID();
  const profileRoot = realpathSync(mkdtempSync(join(temporaryDirectory, 'mythra-release-smoke-')));
  const marker = join(profileRoot, '.mythra-release-qa.json');
  writeFileSync(marker, JSON.stringify({ schemaVersion: 1, purpose: 'mythra-release-qa', profileId }) + '\n', { mode: 0o600, flag: 'wx' });
  let child, launchError, processStart, runId, started, forced = false, result, failure;
  const output = resolve(evidenceDirectory, profileId);
  try {
    mkdirSync(output, { recursive: true, mode: 0o700 });
    protectProfile(profileRoot, marker);
    // The inherited environment contains credentials, but the supported profile
    // blocks provider/auth access before dispatch; no credential files are read.
    child = spawnCandidate(executable, { cwd: dirname(executable), env: { ...process.env, MYTHRA_RELEASE_QA_ROOT: profileRoot }, stdio: 'ignore', windowsHide: true });
    child.once('error', (error) => { launchError = error; });
    if (!Number.isInteger(child.pid)) throw new Error('QA smoke candidate did not obtain an owned PID');
    started = performance.now(); processStart = identifyProcess(child.pid);
    if (!processStart) throw new Error('Cannot identify isolated smoke process');
    const identity = inspectProcess(child.pid);
    if (identity.pid !== child.pid || identity.processStart !== processStart || typeof identity.executablePath !== 'string'
      || realpathSync(identity.executablePath).toLowerCase() !== executable.toLowerCase()) throw new Error('Smoke process does not match the exact built executable');
    const startupDeadline = started + startupTimeoutMs;
    for (;;) {
      if (launchError) throw launchError;
      if (!active(child)) throw new Error('Isolated candidate exited before five-second smoke acceptance');
      const opened = readEvents(profileRoot).find((event) => event.kind === 'profile-open' && matches(event, { profileId, pid: child.pid }));
      if (opened) {
        if (!UUID.test(opened.runId) || opened.details?.contractVersion !== 1 || opened.details.providers !== 'blocked' || opened.details.persistentWebview !== true || !UUID.test(opened.details.webviewStoreId)) throw new Error('Candidate did not confirm the supported isolated profile contract');
        runId = opened.runId; break;
      }
      if (performance.now() >= startupDeadline) throw new Error('Candidate did not emit matching isolated profile-open evidence');
      await sleep(pollMs);
    }
    while (performance.now() - started < livenessMs) {
      if (launchError || !active(child)) throw new Error('Isolated candidate exited during five-second smoke');
      await sleep(Math.min(pollMs, Math.max(1, livenessMs - (performance.now() - started))));
    }
    if (!active(child) || identifyProcess(child.pid) !== processStart || fileHash(executable) !== executableSha256) throw new Error('Isolated candidate changed before normal close');
    atomicJson(join(profileRoot, 'request.json'), { schemaVersion: 1, profileId, nonce: randomUUID(), action: 'close' });
    const closeDeadline = performance.now() + closeTimeoutMs;
    while (active(child)) {
      if (performance.now() >= closeDeadline) throw new Error('Isolated candidate did not exit after bounded normal close');
      await sleep(pollMs);
    }
    if (launchError || child.exitCode !== 0 || child.signalCode !== null) throw new Error('Isolated candidate did not complete a successful normal exit');
    while (descendantsAlive(child.pid)) {
      if (performance.now() >= closeDeadline) throw new Error('Isolated candidate descendants did not exit; preserving profile for recovery');
      await sleep(pollMs);
    }
    const events = readEvents(profileRoot);
    const close = events.find((event) => event.kind === 'close-finish' && matches(event, { profileId, pid: child.pid, runId }));
    if (close?.details?.accepted !== true || close.details.result !== 'saved'
      || !events.some((event) => event.kind === 'exit' && matches(event, { profileId, pid: child.pid, runId }))) throw new Error('Normal smoke close lacks matching save/exit evidence');
    result = { passed: true, pid: child.pid, processStart, profileId, runId, executableSha256, livenessMs,
      elapsedMs: Math.round(performance.now() - started), closeAccepted: true, cleanupComplete: false, evidenceDirectory: output };
  } catch (error) { failure = error; }
  finally {
    if (child && Number.isInteger(child.pid) && active(child)) {
      // Never kill by name or touch the user's working app. Termination is a
      // failure cleanup of ONLY the exact owned child in this private profile.
      if (processStart && identifyProcess(child.pid) !== processStart) failure = failure || new Error('Owned smoke process identity changed; preserving profile for recovery');
      else {
        forced = true; child.kill('SIGTERM');
        const stopDeadline = performance.now() + closeTimeoutMs;
        while (active(child) && performance.now() < stopDeadline) await sleep(pollMs);
        if (active(child)) {
          if (!processStart || identifyProcess(child.pid) === processStart) child.kill('SIGKILL');
          const forceDeadline = performance.now() + closeTimeoutMs;
          while (active(child) && performance.now() < forceDeadline) await sleep(pollMs);
        }
      }
    }
    const events = join(profileRoot, 'events.jsonl');
    if (existsSync(events)) writeFileSync(join(output, 'native-events.jsonl'), readFileSync(events), { mode: 0o600 });
    const descendantsRemain = child && Number.isInteger(child.pid) && !active(child) && descendantsAlive(child.pid);
    if ((!child || !active(child)) && !descendantsRemain) {
      // mkdtemp and the exclusive marker establish ownership; cleanup never
      // accepts a caller-supplied application profile path.
      rmSync(profileRoot, { recursive: true, force: true });
      if (result) result.cleanupComplete = true;
    } else failure = failure || new Error('Owned smoke process or descendants still active; profile preserved for recovery');
    mkdirSync(output, { recursive: true, mode: 0o700 });
    atomicJson(join(output, 'result.json'), result || { passed: false, pid: child?.pid, profileId, runId, forced, reason: failure?.message, cleanupComplete: !existsSync(profileRoot) });
  }
  if (failure) throw failure;
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [binaryPath, commit] = process.argv.slice(2);
    if (!binaryPath || !commit) throw new Error('Usage: node scripts/release-qa-smoke.mjs <binaryPath> <exactHEAD>');
    const result = await runQaSmoke({ root: resolve(import.meta.dirname, '..'), binaryPath, commit });
    console.log(JSON.stringify(result));
  } catch (error) { console.error(JSON.stringify({ passed: false, reason: error.message })); process.exitCode = 1; }
}
