import { expect, test } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPlan } from './release-plan.mjs';
import { atomicJson, processIdentity, workerTreeAlive } from './release-state.mjs';
import { runRelease } from './release-coordinator.mjs';

async function until(predicate, message) {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise((accept) => setTimeout(accept, 20));
  }
}

test.skipIf(process.platform === 'win32')('a killed native worker cannot release ownership while its builder grandchild survives', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mythra-worker-tree-'));
  const stateRoot = mkdtempSync(join(tmpdir(), 'mythra-worker-tree-state-'));
  const ready = join(stateRoot, 'grandchild-ready.json');
  const grandchild = `require('node:fs').writeFileSync(${JSON.stringify(ready)},JSON.stringify({pid:process.pid,parent:process.ppid}));setInterval(()=>{},1000);`;
  const builder = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{stdio:'ignore'});setInterval(()=>{},1000);`;
  const workerCode = `require('node:child_process').spawnSync(process.execPath,['-e',${JSON.stringify(builder)}],{stdio:'ignore'});`;
  const worker = spawn(process.execPath, ['-e', workerCode], { detached: true, stdio: 'ignore' });
  const exited = once(worker, 'exit');
  let grandchildPid, builderPid;
  try {
    await until(() => existsSync(ready), 'Controlled native grandchild did not start');
    const spawned = JSON.parse(readFileSync(ready, 'utf8'));
    grandchildPid = spawned.pid; builderPid = spawned.parent;
    const identity = { host: hostname(), pid: worker.pid, processStart: processIdentity(worker.pid) };
    expect(identity.processStart).toBeTruthy();
    expect(workerTreeAlive(identity)).toBe(true);
    process.kill(worker.pid, 'SIGKILL'); await exited;
    expect(processIdentity(worker.pid)).toBeNull();
    expect(processIdentity(builderPid)).toBeTruthy();
    expect(processIdentity(grandchildPid)).toBeTruthy();
    expect(workerTreeAlive(identity)).toBe(true);

    const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    git('init'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid');
    git('remote', 'add', 'origin', 'https://github.com/m17h/Mythra-Code.git');
    writeFileSync(join(root, 'source'), 'frozen'); git('add', '.'); git('commit', '-m', 'fixture');
    const commit = git('rev-parse', 'HEAD');
    const plan = createPlan({ commit, version: '1.2.3', baseline: { commit, tag: 'v1.2.2', reason: 'Accepted baseline' },
      changedFiles: [], policyHash: 'c'.repeat(64) });
    atomicJson(join(stateRoot, 'plan.json'), plan);
    atomicJson(join(stateRoot, 'active-stage.json'), { checkId: 'build:darwin-aarch64', status: 'running', worker: identity });
    let restarted = false;
    await expect(runRelease({ root, stateRoot, resume: true, allowBuild: true,
      retryReason: 'Worker PID exited', handlers: { ci: () => { restarted = true; throw new Error('Must not restart'); } },
    })).rejects.toThrow(/descendants are still running/);
    expect(restarted).toBe(false);

    process.kill(-worker.pid, 'SIGKILL');
    await until(() => !workerTreeAlive(identity), 'Killed owned process group was not reaped');
    expect(workerTreeAlive(identity)).toBe(false);
  } finally {
    try { process.kill(-worker.pid, 'SIGKILL'); } catch { /* Already reaped. */ }
    for (const pid of [grandchildPid, builderPid]) if (pid) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* Already reaped. */ }
    }
    worker.kill('SIGKILL');
    rmSync(root, { recursive: true, force: true }); rmSync(stateRoot, { recursive: true, force: true });
  }
}, 15_000);
