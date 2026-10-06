import { describe, expect, test } from 'vitest';
import { createPlan } from './release-plan.mjs';
import { assertPlan, objectHash, PLATFORMS } from './release-state.mjs';
import { hostname } from 'node:os';

const plan = (extra = {}) => createPlan({ commit: 'a'.repeat(40), version: '1.2.3',
  baseline: { commit: 'b'.repeat(40), tag: 'v1.2.2', reason: 'Accepted baseline' },
  changedFiles: [], policyHash: 'c'.repeat(64), ...extra });
const rehash = (p) => { const { planHash: _hash, ...payload } = p; return { ...payload, planHash: objectHash(payload) }; };
const check = (p, id) => p.checks.find((c) => c.id === id);

describe('fixed release plan contract', () => {
  test.each([
    ['missing publisher host', (p) => { delete p.publisherHost; }],
    ['unsafe publisher host', (p) => { p.publisherHost = '../host'; }],
    ['blank publisher host', (p) => { p.publisherHost = ''; }],
    ['CI kind', (p) => { check(p, 'ci').kind = 'native'; }],
    ['audit kind', (p) => { check(p, 'audit:windows-x86_64').kind = 'build'; }],
    ['native kind', (p) => { check(p, 'native-startup:windows-x86_64').kind = 'ci'; }],
    ['unknown ID', (p) => { p.checks.push({ id: 'skip-all', kind: 'ci', required: false, reason: 'test', dependsOn: [] }); }],
    ['missing native inventory', (p) => { p.checks = p.checks.filter((c) => c.id !== 'native-startup:windows-x86_64'); }],
    ['cross-platform audit', (p) => { check(p, 'audit:windows-x86_64').platform = 'darwin-aarch64'; }],
    ['missing platform', (p) => { delete check(p, 'build:windows-x86_64').platform; }],
    ['platform added to CI', (p) => { check(p, 'ci').platform = 'windows-x86_64'; }],
    ['audit build dependency omitted', (p) => { check(p, 'audit:windows-x86_64').dependsOn = []; }],
    ['native audit dependency omitted', (p) => { check(p, 'native-startup:windows-x86_64').dependsOn = []; }],
    ['draft audit dependency omitted', (p) => { check(p, 'draft').dependsOn = ['ci']; }],
    ['publish draft dependency omitted', (p) => { check(p, 'publish').dependsOn = []; }],
    ['public publish dependency omitted', (p) => { check(p, 'public').dependsOn = []; }],
    ['duplicate dependency', (p) => { check(p, 'draft').dependsOn.push('ci'); }],
    ['dependency cycle', (p) => { check(p, 'ci').dependsOn = ['publish']; }],
    ['added build dependency', (p) => { check(p, 'build:windows-x86_64').dependsOn = ['ci']; }],
    ['disabled native reason inconsistency', (p) => { check(p, 'native-startup:windows-x86_64').required = true; }],
  ])('rejects rehashed %s mutation', (_name, mutate) => {
    const p = plan(); mutate(p);
    expect(() => assertPlan(rehash(p))).toThrow();
  });
  test('draft must depend on every required native leaf', () => {
    const p = plan({ knownIssues: [{ check: 'native-startup', platform: 'windows-x86_64', reason: 'Reported blank native window' }] });
    check(p, 'draft').dependsOn = check(p, 'draft').dependsOn.filter((id) => !id.startsWith('native-startup:'));
    expect(() => assertPlan(rehash(p))).toThrow();
  });
  test.each(['knownIssues', 'overrides', 'boundaryHints'])('cannot disable a persisted %s addition with a rehash', (field) => {
    const p = plan({ [field]: [{ check: 'native-close', platform: 'windows-x86_64', reason: 'Close flush changed' }] });
    const leaf = check(p, 'native-close:windows-x86_64');
    leaf.required = false; leaf.reason = 'Unaffected cumulative source and shipped upgrade predecessors';
    check(p, 'draft').dependsOn = check(p, 'draft').dependsOn.filter((id) => id !== leaf.id);
    expect(() => assertPlan(rehash(p))).toThrow();
  });
  test('classifications for source and shipped predecessors cannot be dropped from the native gate', () => {
    for (const predecessor of [false, true]) {
      const c = { path: 'src/lib/newState.ts', boundaries: ['native-storage'], reason: 'Changed durable state', evidence: 'Reviewed hunk' };
      const p = plan(predecessor ? { predecessors: [{ commit: 'd'.repeat(40), tag: 'v1.2.2-withdrawn', reason: 'Previously shipped', changedFiles: [c.path], classifications: [c] }] }
        : { changedFiles: [c.path], classifications: [c] });
      for (const platform of PLATFORMS) {
        const leaf = check(p, `native-storage:${platform}`); leaf.required = false; leaf.reason = 'Unaffected cumulative source and shipped upgrade predecessors';
        check(p, 'draft').dependsOn = check(p, 'draft').dependsOn.filter((id) => id !== leaf.id);
      }
      expect(() => assertPlan(rehash(p))).toThrow();
    }
  });
  test('accepts generated scope and dependency order permutations', () => {
    for (const extra of [{}, { changedFiles: ['src/lib/storage.ts'] },
      { knownIssues: [{ check: 'native-onboarding', platform: 'windows-x86_64', reason: 'Reported onboarding failure' }] }]) {
      const p = plan(extra);
      p.checks.reverse(); for (const c of p.checks) c.dependsOn.reverse();
      expect(() => assertPlan(rehash(p))).not.toThrow();
    }
  });
  test('freezes the default publisher identity at plan creation', () => {
    expect(plan().publisherHost).toBe(hostname());
    expect(plan({ publisherHost: 'release-host.example' }).publisherHost).toBe('release-host.example');
  });
  test.each([
    ['repository', 'other/repository'], ['tag', 'v9.9.9'], ['commit', 'd'.repeat(40)],
    ['releaseId', null], ['latestReleaseId', 999], ['latestCommit', 'd'.repeat(40)],
    ['latestTag', 'v1.2.3'], ['publishedAt', null], ['verifiedAt', '2036-01-01T00:00:00Z'],
  ])('rejects rehashed public baseline %s mismatch', (field, value) => {
    const p = plan();
    p.baseline.publicEvidence = { schemaVersion: 1, repository: p.repository, tag: p.baseline.tag, commit: p.baseline.commit,
      releaseId: 123, latestReleaseId: 123, latestTag: p.baseline.tag, latestCommit: p.baseline.commit,
      publishedAt: '2026-01-01T00:00:00Z', verifiedAt: new Date().toISOString() };
    expect(() => assertPlan(rehash(p))).not.toThrow();
    p.baseline.publicEvidence[field] = value;
    expect(() => assertPlan(rehash(p))).toThrow(/public baseline evidence/);
  });
  test('an older public baseline retains the exact recorded superseding predecessor', () => {
    const p = plan({ predecessors: [{ tag: 'v1.2.3', commit: 'd'.repeat(40), reason: 'Installed before withdrawal', changedFiles: [] }] });
    p.baseline.publicEvidence = { schemaVersion: 1, repository: p.repository, tag: p.baseline.tag, commit: p.baseline.commit,
      releaseId: 123, latestReleaseId: 124, latestTag: 'v1.2.3', latestCommit: 'd'.repeat(40),
      publishedAt: '2026-01-01T00:00:00Z', verifiedAt: new Date().toISOString() };
    expect(() => assertPlan(rehash(p))).not.toThrow();
    p.predecessors[0].commit = 'e'.repeat(40);
    expect(() => assertPlan(rehash(p))).toThrow(/public baseline evidence/);
  });
});
