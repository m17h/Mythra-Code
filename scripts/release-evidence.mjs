import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertGate, assertReleaseVerification, downloadVerificationReceipts } from './verify-ci.mjs';
import { atomicJson, objectHash, SHA } from './release-state.mjs';

export const REPOSITORY = 'm17h/Mythra-Code';
export function hostedWaiting(reason) { return Object.assign(new Error(reason), { status: 'waiting' }); }
export function assertHostedEvidence({ run, jobs, receipts }, commit) {
  if (!SHA.test(commit) || run.repository?.full_name !== REPOSITORY || run.head_repository?.full_name !== REPOSITORY
    || run.path !== '.github/workflows/verify.yml' || !['push', 'workflow_dispatch'].includes(run.event)
    || run.head_branch !== 'main') throw new Error('CI evidence must be the canonical final-source Verify workflow on main');
  assertReleaseVerification({ headSha: run.head_sha, status: run.status, conclusion: run.conclusion }, jobs, commit);
  const input = assertGate({ native: { result: 'success' }, unit: { result: 'success' }, renderer: { result: 'success' }, webkit: { result: 'success' } }, receipts, commit);
  if (input.event !== run.event || input.head !== commit) throw new Error('Hosted receipt input differs from the final-source run');
  return { schemaVersion: 1, repository: REPOSITORY, commit, runId: run.id, runAttempt: run.run_attempt,
    workflow: run.path, url: run.html_url, verifiedAt: new Date().toISOString(),
    timing: { createdAt: run.created_at ?? null, startedAt: run.run_started_at ?? null, updatedAt: run.updated_at ?? null },
    input, jobs: jobs.map(({ id, name, status, conclusion, started_at, completed_at }) => ({ id, name, status, conclusion, started_at, completed_at })),
    receiptHashes: receipts.map((r) => ({ id: r.id, sha256: objectHash(r) })).sort((a, b) => a.id.localeCompare(b.id)) };
}

export function verifyHostedEvidence({ root, commit, runId, execute = execFileSync }) {
  if (!SHA.test(commit)) throw new Error('An exact release commit is required');
  const gh = (args) => execute('gh', args, { cwd: root, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  let ids;
  if (runId) { if (!/^\d+$/.test(String(runId))) throw new Error('Invalid CI run ID'); ids = [runId]; }
  else {
    const runs = JSON.parse(gh(['run', 'list', '--repo', REPOSITORY, '--commit', commit, '--workflow', 'Verify', '--limit', '30', '--json', 'databaseId,status,conclusion,headSha']));
    ids = runs.filter((r) => r.headSha === commit && r.status === 'completed' && r.conclusion === 'success').map((r) => r.databaseId);
    if (!ids.length && (!runs.length || runs.some((r) => r.headSha === commit && r.status !== 'completed'))) throw hostedWaiting('Exact-source Verify is queued, running, or not yet visible');
  }
  const failures = [];
  for (const id of ids) {
    const directory = mkdtempSync(join(tmpdir(), 'mythra-release-ci-'));
    try {
      const run = JSON.parse(gh(['api', `repos/${REPOSITORY}/actions/runs/${id}`]));
      if (run.head_sha === commit && run.status !== 'completed') throw hostedWaiting('Exact-source Verify has not completed');
      const jobs = JSON.parse(gh(['api', `repos/${REPOSITORY}/actions/runs/${id}/jobs?per_page=100`])).jobs;
      const { receipts, artifacts } = downloadVerificationReceipts({ runId: id, head: commit, repository: REPOSITORY, directory, cwd: root, execute });
      return { ...assertHostedEvidence({ run, jobs, receipts }, commit), artifacts };
    } catch (error) { if (error.status === 'waiting') throw error; failures.push(`${id}: ${error.message}`); }
    finally { rmSync(directory, { recursive: true, force: true }); }
  }
  throw new Error(`No complete exact-source hosted proof for ${commit}. ${failures.join('; ')}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [commit, output, runId] = process.argv.slice(2);
  if (!output) throw new Error('Usage: node scripts/release-evidence.mjs <commit> <output.json> [run-id]');
  const proof = verifyHostedEvidence({ root: resolve(import.meta.dirname, '..'), commit, runId });
  atomicJson(output, proof);
  console.log(`Complete hosted Verify evidence: ${proof.runId} (${commit})`);
}
