import { afterEach, expect, test } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createPlan } from './release-plan.mjs';
import { atomicJson, readJson, realPath } from './release-state.mjs';
import { assertCandidateContract } from './release-candidate-contract.mjs';

const roots = [];
const temp = () => { const path = mkdtempSync(join(tmpdir(), 'mythra-candidate-contract-')); roots.push(path); return path; };
afterEach(() => roots.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })));

function fixture() {
  const root = temp(), stateRoot = temp();
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid');
  git('remote', 'add', 'origin', 'https://github.com/m17h/Mythra-Code.git');
  writeFileSync(join(root, 'package.json'), JSON.stringify({ version: '1.2.3' })); git('add', '.'); git('commit', '-m', 'fixture');
  const commit = git('rev-parse', 'HEAD');
  const plan = createPlan({ commit, version: '1.2.3', baseline: { commit, tag: 'v1.2.2', reason: 'Accepted baseline',
    publicEvidence: { schemaVersion: 1, repository: 'm17h/Mythra-Code', releaseId: 1, tag: 'v1.2.2', commit, publishedAt: '2026-01-01T00:00:00Z', latestReleaseId: 1, latestTag: 'v1.2.2', latestCommit: commit, verifiedAt: '2026-01-01T00:00:01Z' } }, changedFiles: [], policyHash: 'c'.repeat(64) });
  atomicJson(join(stateRoot, 'plan.json'), plan);
  const lease = { token: 'owner', host: hostname(), pid: 100, processStart: 'coordinator-start', root: realPath(root), planHash: plan.planHash, commit };
  atomicJson(join(stateRoot, 'lease.json'), lease);
  const active = { checkId: 'build:windows-x86_64', status: 'running', ownerToken: lease.token, root: realPath(root), planHash: plan.planHash, commit,
    worker: { host: hostname(), pid: 101, processStart: 'worker-start' } };
  atomicJson(join(stateRoot, 'active-stage.json'), active);
  const script = resolve(root, 'scripts/release-coordinator.mjs');
  const rows = [{ pid: 100, parentPid: 1, command: `node "${script}" run --state "${stateRoot}" --build --native-only` },
    { pid: 101, parentPid: 100, command: `node "${script}" build-worker --state "${stateRoot}" --check build:windows-x86_64 --owner owner` },
    { pid: 102, parentPid: 101, command: 'powershell native build job' }, { pid: 103, parentPid: 102, command: 'candidate validator' }];
  lease.allowBuild = true; lease.coordinatorCommand = rows[0].command; atomicJson(join(stateRoot, 'lease.json'), lease);
  const args = { root, stateRoot, ownerToken: 'owner', workerPid: 101, workerStart: 'worker-start', candidatePid: 103,
    identity: (pid) => ({ 100: 'coordinator-start', 101: 'worker-start' })[pid], processes: () => rows };
  return { root, stateRoot, plan, args, rows, lease, active, git };
}

test('a clean frozen provisional candidate needs a matching live coordinator, native worker and actual ancestry', () => {
  const f = fixture();
  expect(assertCandidateContract(f.args)).toMatchObject({ provisional: true, commit: f.plan.commit, planHash: f.plan.planHash });
});

test.each(['--allow-dirty', '--skip-install', '--skip-verify', '--skip-launch-smoke'])('provisional ownership never grants %s', (flag) => {
  const f = fixture(); expect(() => assertCandidateContract({ ...f.args, flags: [flag] })).toThrow(/reject/);
});

test('stale and forged live identities, tokens, process commands and ancestry are rejected', () => {
  const f = fixture();
  for (const change of [{ ownerToken: 'forged' }, { workerStart: 'stale-start' }, { workerPid: 999 }, { candidatePid: 100 },
    { identity: () => null }, { processes: () => f.rows.map((p) => ({ ...p, command: 'node unrelated-script.mjs' })) },
    { processes: () => f.rows.map((p) => ({ ...p, command: p.command.replace(f.stateRoot, `${f.stateRoot}-forged`) })) },
    { processes: () => f.rows.map((p) => p.pid === 103 ? { ...p, parentPid: 1 } : p) }]) {
    expect(() => assertCandidateContract({ ...f.args, ...change })).toThrow();
  }
  atomicJson(join(f.stateRoot, 'active-stage.json'), { ...f.active, status: 'passed' });
  expect(() => assertCandidateContract(f.args)).toThrow(/live native/);
  atomicJson(join(f.stateRoot, 'active-stage.json'), f.active);
  atomicJson(join(f.stateRoot, 'lease.json'), { ...f.lease, commit: 'd'.repeat(40) });
  expect(() => assertCandidateContract(f.args)).toThrow(/live coordinator/);
});

test('dirty, wrong source/version and modified plans cannot use provisional ownership', () => {
  const f = fixture();
  writeFileSync(join(f.root, 'package.json'), JSON.stringify({ version: '9.9.9' }));
  expect(() => assertCandidateContract(f.args)).toThrow(/clean/);
  const plan = readJson(join(f.stateRoot, 'plan.json'));
  atomicJson(join(f.stateRoot, 'plan.json'), { ...plan, version: '9.9.9' });
  expect(() => assertCandidateContract(f.args)).toThrow(/modified/);
});

test('real coordinator/native/validator child ancestry authorizes a frozen provisional candidate without building', () => {
  const f = fixture();
  const stateModule = pathToFileURL(resolve(import.meta.dirname, 'release-state.mjs')).href;
  const validator = resolve(import.meta.dirname, 'release-candidate-contract.mjs');
  const workerSource = `import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { hostname } from 'node:os';
import { atomicJson, readJson, realPath, processIdentity } from ${JSON.stringify(stateModule)};
import { candidateProcesses } from ${JSON.stringify(pathToFileURL(validator).href)};
const args=process.argv.slice(2), command=args[0], stateRoot=args[args.indexOf('--state')+1], root=resolve(import.meta.dirname,'..');
const plan=readJson(resolve(stateRoot,'plan.json')), token='owned-probe-worker';
if(command==='run') {
 atomicJson(resolve(stateRoot,'lease.json'),{token,host:hostname(),pid:process.pid,processStart:processIdentity(),root:realPath(root),planHash:plan.planHash,commit:plan.commit,allowBuild:true,coordinatorCommand:candidateProcesses().find(p=>p.pid===process.pid).command});
 const result=spawnSync(process.execPath,[import.meta.filename,'build-worker','--state',stateRoot,'--check','build:windows-x86_64','--owner',token],{stdio:'pipe',encoding:'utf8'});
 process.stdout.write(result.stdout??''); process.stderr.write(result.stderr??''); process.exitCode=result.status??1;
} else if(command==='build-worker') {
 const processStart=processIdentity();
 atomicJson(resolve(stateRoot,'active-stage.json'),{checkId:'build:windows-x86_64',status:'running',ownerToken:token,root:realPath(root),planHash:plan.planHash,commit:plan.commit,worker:{host:hostname(),pid:process.pid,processStart}});
 const result=spawnSync(process.execPath,[${JSON.stringify(validator)},root],{stdio:'pipe',encoding:'utf8',env:{...process.env,MYTHRA_RELEASE_CANDIDATE_STATE:stateRoot,MYTHRA_RELEASE_CANDIDATE_OWNER:token,MYTHRA_RELEASE_CANDIDATE_WORKER_PID:String(process.pid),MYTHRA_RELEASE_CANDIDATE_WORKER_START:processStart}});
 process.stdout.write(result.stdout??''); process.stderr.write(result.stderr??''); process.exitCode=result.status??1;
} else throw new Error('Unexpected probe command');`;
  mkdirSync(join(f.root, 'scripts'));
  const coordinator = join(f.root, 'scripts/release-coordinator.mjs'); writeFileSync(coordinator, workerSource);
  f.git('add', '.'); f.git('commit', '-m', 'controlled native ownership probe');
  const plan = createPlan({ ...f.plan, commit: f.git('rev-parse', 'HEAD') }); atomicJson(join(f.stateRoot, 'plan.json'), plan);
  const output = execFileSync(process.execPath, [coordinator, 'run', '--state', f.stateRoot, '--build', '--native-only'], { encoding: 'utf8', timeout: 30_000 });
  expect(output).toContain('Owned provisional candidate accepted');
  expect(readFileSync(join(f.root, 'package.json'), 'utf8')).toContain('1.2.3');
}, process.platform === 'win32' ? 45_000 : 10_000);
