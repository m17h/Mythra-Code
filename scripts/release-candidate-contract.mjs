import { execFileSync } from 'node:child_process';
import { hostname } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertPlan, leaseStatus, processIdentity, readJson, realPath } from './release-state.mjs';

// This authorizes only provisional native packaging. CI remains a mandatory
// parent of the draft receipt, and no candidate contract is publication proof.
// OEM best-fit can turn Unicode quotes into unescaped ASCII JSON quotes.
export const WINDOWS_CANDIDATE_PROCESS_COMMAND =
  '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false); '
  + 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress';

export function candidateProcesses() {
  if (process.platform === 'win32') {
    const rows = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      WINDOWS_CANDIDATE_PROCESS_COMMAND], { encoding: 'utf8' }));
    return (Array.isArray(rows) ? rows : [rows]).map((p) => ({ pid: p.ProcessId, parentPid: p.ParentProcessId, command: p.CommandLine ?? '' }));
  }
  return execFileSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8' }).trim().split('\n').map((row) => {
    const match = row.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
    return match && { pid: Number(match[1]), parentPid: Number(match[2]), command: match[3] };
  }).filter(Boolean);
}

export function assertCandidateContract({ root, stateRoot, ownerToken, workerPid, workerStart, flags = [],
  identity = processIdentity, processes = candidateProcesses, candidatePid = process.pid }) {
  if (flags.length) throw new Error('Provisional candidates reject verification, install, smoke and dirty overrides');
  if (!stateRoot || !ownerToken || !Number.isInteger(workerPid) || !workerStart) throw new Error('Provisional candidate needs an owned release worker contract');
  const plan = assertPlan(readJson(resolve(stateRoot, 'plan.json')));
  if (!plan.baseline?.publicEvidence || plan.reviewRequired.length) throw new Error('Candidate needs an approved frozen release plan');
  const git = (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  if (git(['rev-parse', 'HEAD']) !== plan.commit || git(['status', '--porcelain'])
    || !/^(https:\/\/github\.com\/|git@github\.com:)m17h\/Mythra-Code(?:\.git)?$/.test(git(['remote', 'get-url', 'origin']))
    || readJson(resolve(root, 'package.json')).version !== plan.version) throw new Error('Candidate checkout must be clean at the frozen release source and version');
  const lease = readJson(resolve(stateRoot, 'lease.json'));
  const active = readJson(resolve(stateRoot, 'active-stage.json'));
  if (leaseStatus(lease, identity) !== 'running' || lease.token !== ownerToken || lease.planHash !== plan.planHash
    || lease.commit !== plan.commit || lease.root !== realPath(root) || lease.allowBuild !== true
    || typeof lease.coordinatorCommand !== 'string' || !lease.coordinatorCommand) throw new Error('Candidate has no matching live coordinator owner');
  if (active.status !== 'running' || active.checkId !== 'build:windows-x86_64' || active.ownerToken !== ownerToken
    || active.planHash !== plan.planHash || active.commit !== plan.commit || active.root !== realPath(root)
    || active.worker?.host !== hostname() || active.worker.pid !== workerPid || active.worker.processStart !== workerStart
    || leaseStatus(active.worker, identity) !== 'running') throw new Error('Candidate has no matching live native worker');
  const rows = processes(), worker = rows.find((p) => p.pid === workerPid), coordinator = rows.find((p) => p.pid === lease.pid);
  const normalize = (value) => value.replaceAll('\\', '/').toLowerCase();
  const argument = (command, value) => {
    const escaped = normalize(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?:^|\\s)(?:"${escaped}"|'${escaped}'|${escaped})(?=\\s|$)`).test(command);
  };
  const script = normalize(resolve(root, 'scripts/release-coordinator.mjs'));
  const workerCommand = normalize(worker?.command ?? ''), coordinatorCommand = normalize(coordinator?.command ?? '');
  // PID liveness alone cannot authorize packaging: require the owned process
  // commands, direct coordinator child and the validator's actual ancestry.
  if (worker?.parentPid !== lease.pid || !argument(workerCommand, script) || !workerCommand.includes(' build-worker ')
    || coordinatorCommand !== normalize(lease.coordinatorCommand)
    || !argument(workerCommand, ownerToken) || !argument(workerCommand, 'build:windows-x86_64')
    || !argument(workerCommand, stateRoot)) throw new Error('Candidate process commands do not match release ownership');
  const ancestors = new Set();
  let pid = candidatePid;
  while (pid && !ancestors.has(pid)) { ancestors.add(pid); pid = rows.find((p) => p.pid === pid)?.parentPid; }
  if (candidatePid === workerPid || !ancestors.has(workerPid) || !ancestors.has(lease.pid)) throw new Error('Candidate validator must descend from the owned native build worker');
  return { schemaVersion: 1, planHash: plan.planHash, commit: plan.commit, version: plan.version, provisional: true };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [root, ...flags] = process.argv.slice(2);
  if (!root) throw new Error('Candidate validator requires the checkout root');
  assertCandidateContract({ root: resolve(root), stateRoot: process.env.MYTHRA_RELEASE_CANDIDATE_STATE,
    ownerToken: process.env.MYTHRA_RELEASE_CANDIDATE_OWNER, workerPid: Number(process.env.MYTHRA_RELEASE_CANDIDATE_WORKER_PID),
    workerStart: process.env.MYTHRA_RELEASE_CANDIDATE_WORKER_START, flags });
  console.log('Owned provisional candidate accepted; hosted source CI is still required before draft upload.');
}
