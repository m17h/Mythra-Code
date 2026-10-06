import { afterEach, describe, expect, test } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createPlan, planFromCheckout } from './release-plan.mjs';

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const plan = (extra = {}) => createPlan({ commit: 'a'.repeat(40), version: '1.2.3',
  baseline: { commit: 'b'.repeat(40), tag: 'v1.2.2', reason: 'Accepted public baseline' },
  changedFiles: [], policyHash: 'c'.repeat(64), ...extra });
const required = (p, name) => p.checks.filter((c) => c.required && c.id.startsWith(`${name}:`)).map((c) => c.platform);
const both = ['darwin-aarch64', 'windows-x86_64'];

describe('native release scope safety', () => {
  test.each(['src/hooks/usePersistedState.ts', 'src/lib/localTranscriptPersistence.ts', 'src/lib/transcriptSaveScheduler.ts', 'src/lib/taskStore.ts'])(
    '%s selects durable native state checks', (path) => {
      expect(required(plan({ changedFiles: [path] }), 'native-storage')).toEqual(both);
    });
  test.each(['src/lib/localTranscriptPersistence.ts', 'src/lib/transcriptSaveScheduler.ts'])(
    '%s selects the final close flush boundary', (path) => {
      expect(required(plan({ changedFiles: [path] }), 'native-close')).toEqual(both);
    });
  test.each(['src/lib/newStateMigration.ts', 'src/hooks/useNewLifecycle.ts'])(
    'unknown semantic module %s needs review before native checks can be skipped', (path) => {
      expect(plan({ changedFiles: [path] }).reviewRequired).toEqual([path]);
      const reviewed = plan({ changedFiles: [path], classifications: [{ path, boundaries: [],
        reason: 'Only formats existing output', evidence: 'Reviewed every changed function' }] });
      expect(reviewed.reviewRequired).toEqual([]);
      expect(reviewed.checks.filter((c) => c.kind === 'native' && c.required)).toEqual([]);
    });
  test('ordinary UI components, styling, documentation and tests do not add native checks', () => {
    const p = plan({ changedFiles: ['src/components/UsageCalendar.tsx', 'src/components/UsageDashboard.css',
      'docs/usage.md', 'src/hooks/usePersistedState.test.tsx', 'src/lib/localTranscriptPersistence.test.ts'] });
    expect(p.reviewRequired).toEqual([]);
    expect(p.checks.filter((c) => c.kind === 'native' && c.required)).toEqual([]);
  });
  test('unrelated App UI changes require symbol review without adding native startup', () => {
    const path = 'src/App.tsx';
    expect(plan({ changedFiles: [path] }).reviewRequired).toEqual([path]);
    const reviewed = plan({ changedFiles: [path], classifications: [{ path, boundaries: [],
      reason: 'Only provider display props changed', evidence: 'Reviewed changed providerBadge prop symbols' }] });
    expect(reviewed.reviewRequired).toEqual([]);
    expect(reviewed.checks.filter((c) => c.kind === 'native' && c.required)).toEqual([]);
  });
  test.each(['Windows/installer.nsi', 'Windows/installer.nsh', 'src-tauri/tauri.windows.conf.json'])(
    '%s selects native checks only on Windows, including shipped predecessors', (path) => {
      for (const scope of [{ changedFiles: [path] }, { predecessors: [{ tag: 'v1.2.2-withdrawn', commit: 'd'.repeat(40), reason: 'Installed withdrawn build', changedFiles: [path] }] }]) {
        const p = plan(scope);
        expect(required(p, 'native-installer')).toEqual(['windows-x86_64']);
        expect(p.checks.filter((c) => c.kind === 'native' && c.required).every((c) => c.platform === 'windows-x86_64')).toBe(true);
      }
    });
  test('Windows build changes require a reviewed installer decision in each cumulative scope', () => {
    const path = 'Windows/build.ps1';
    const classification = { path, boundaries: [], reason: 'Verification and staging only',
      evidence: 'Reviewed hosted CI, asset staging and isolated executable smoke hunks; installer/update/recovery unchanged' };
    const predecessor = { tag: 'v1.2.2-withdrawn', commit: 'd'.repeat(40), reason: 'Installed withdrawn build', changedFiles: [path] };
    const pending = plan({ changedFiles: [path], predecessors: [predecessor] });
    expect(pending.reviewRequired).toEqual([path, `${predecessor.tag}:${path}`]);
    expect(required(pending, 'native-startup')).toEqual(['windows-x86_64']);
    const currentReviewed = plan({ changedFiles: [path], classifications: [classification], predecessors: [predecessor] });
    expect(currentReviewed.reviewRequired).toEqual([`${predecessor.tag}:${path}`]);
    const reviewed = plan({ changedFiles: [path], classifications: [classification],
      predecessors: [{ ...predecessor, classifications: [classification] }] });
    expect(reviewed.reviewRequired).toEqual([]);
    expect(required(reviewed, 'native-installer')).toEqual([]);
    expect(required(reviewed, 'native-startup')).toEqual(['windows-x86_64']);
    for (const id of ['ci', 'build:darwin-aarch64', 'build:windows-x86_64', 'audit:darwin-aarch64', 'audit:windows-x86_64', 'draft', 'publish', 'public']) {
      expect(reviewed.checks.find((c) => c.id === id).required).toBe(true);
    }
  });
  test.each([false, true])('reviewed Windows installer semantics retain their gate (predecessor: %s)', (historical) => {
    const path = 'Windows/build.ps1';
    const installer = { path, boundaries: ['native-installer'], reason: 'Installer invocation changed', evidence: 'Reviewed NSIS bundling arguments' };
    const verification = { path, boundaries: [], reason: 'Verification only', evidence: 'Reviewed hosted CI retrieval' };
    const p = plan(historical ? { changedFiles: [path], classifications: [verification], predecessors: [{
      tag: 'v1.2.2-withdrawn', commit: 'd'.repeat(40), reason: 'Installed withdrawn build', changedFiles: [path], classifications: [installer],
    }] } : { changedFiles: [path], classifications: [installer] });
    expect(p.reviewRequired).toEqual([]);
    expect(required(p, 'native-installer')).toEqual(['windows-x86_64']);
    expect(required(p, 'native-startup')).toEqual(['windows-x86_64']);
  });
  test.each(['knownIssues', 'overrides', 'boundaryHints'])('reviewed Windows verification cannot suppress shared %s', (field) => {
    const path = 'Windows/build.ps1';
    const p = plan({ changedFiles: [path], classifications: [{ path, boundaries: [], reason: 'Verification only', evidence: 'Reviewed CI retrieval' }],
      [field]: [{ check: 'native-installer', reason: 'Shared update/recovery needs replay', path }] });
    expect(required(p, 'native-installer')).toEqual(both);
  });
  test('predecessor boundary hints remain shared despite a Windows verification classification', () => {
    const path = 'Windows/build.ps1';
    const p = plan({ predecessors: [{ tag: 'v1.2.2-withdrawn', commit: 'd'.repeat(40), reason: 'Installed withdrawn build', changedFiles: [path],
      classifications: [{ path, boundaries: [], reason: 'Verification only', evidence: 'Reviewed CI retrieval' }],
      boundaryHints: [{ check: 'native-installer', reason: 'Shared recovery changed', path }],
    }] });
    expect(required(p, 'native-installer')).toEqual(both);
  });
  test.each(['Windows/installer.nsi', 'Windows/installer.nsh', 'src-tauri/tauri.windows.conf.json', 'src-tauri/capabilities/default.json', 'src/lib/updater.ts'])(
    'semantic classification cannot suppress fixed installer boundary %s', (path) => {
      const p = plan({ changedFiles: [path], classifications: [{ path, boundaries: [], reason: 'Comment-only classification', evidence: 'Reviewed hunk' }] });
      expect(required(p, 'native-installer')).toEqual(path.startsWith('Windows/') || path.endsWith('tauri.windows.conf.json') ? ['windows-x86_64'] : both);
    });
  test('shared Tauri config still selects both platform native checks', () => {
    const p = plan({ changedFiles: ['src-tauri/tauri.conf.json'] });
    expect(required(p, 'native-startup')).toEqual(both);
    expect(required(p, 'native-installer')).toEqual(both);
  });
  test('a presentation classification cannot suppress a known durable state boundary', () => {
    const path = 'src/hooks/usePersistedState.ts';
    const p = plan({ changedFiles: [path], classifications: [{ path, boundaries: [],
      reason: 'Comment-only classification', evidence: 'Reviewed hunk' }] });
    expect(required(p, 'native-storage')).toEqual(both);
  });
  test('unknown modules in a shipped predecessor need their own semantic review', () => {
    const predecessor = { commit: 'd'.repeat(40), tag: 'v1.2.2-withdrawn', reason: 'Users installed this version',
      changedFiles: ['src/hooks/useNewLifecycle.ts'] };
    expect(plan({ predecessors: [predecessor] }).reviewRequired).toEqual(['v1.2.2-withdrawn:src/hooks/useNewLifecycle.ts']);
    predecessor.classifications = [{ path: 'src/hooks/useNewLifecycle.ts', boundaries: ['native-close'],
      reason: 'Changed native close handling', evidence: 'Reviewed predecessor-to-release diff' }];
    const p = plan({ predecessors: [predecessor] });
    expect(p.reviewRequired).toEqual([]);
    expect(required(p, 'native-close')).toEqual(both);
  });
  test('checkout planning blocks unreviewed Windows build hunks in current and predecessor scopes', () => {
    const root = mkdtempSync(join(tmpdir(), 'mythra-build-scope-')); roots.push(root);
    const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    const write = (file, text) => { mkdirSync(dirname(join(root, file)), { recursive: true }); writeFileSync(join(root, file), text); };
    const commit = (message) => { git('add', '.'); git('commit', '-m', message); };
    git('init'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid');
    git('remote', 'add', 'origin', 'https://github.com/m17h/Mythra-Code.git');
    for (const file of ['AGENTS.md', '.github/workflows/verify.yml', 'scripts/verify-ci.mjs', 'scripts/release-plan.mjs', 'scripts/release-state.mjs', 'scripts/release-upgrade-coverage.mjs']) write(file, 'policy\n');
    write('package.json', JSON.stringify({ version: '1.2.3' }));
    write('Windows/build.ps1', 'npm run verify\n'); commit('shipped builder'); git('tag', 'v1.2.2-withdrawn'); git('tag', 'v1.2.2');
    write('Windows/build.ps1', 'node scripts/release-evidence.mjs\n'); commit('builder verification');
    const execute = (_command, args) => JSON.stringify(args[1].endsWith('/releases/latest')
      ? { id: 123, tag_name: 'v1.2.2', draft: false, prerelease: false, published_at: '2026-01-01T00:00:00Z' }
      : { object: { type: 'commit', sha: git('rev-parse', 'v1.2.2^{commit}') } });
    const input = { baseline: { tag: 'v1.2.2', reason: 'Accepted public baseline' } };
    expect(() => planFromCheckout(root, input, { execute })).toThrow(/requires review notes for: Windows\/build\.ps1/);
    const classification = { path: 'Windows/build.ps1', boundaries: [], reason: 'Verification only', evidence: 'Reviewed npm verification replacement' };
    input.classifications = [classification];
    const reviewed = planFromCheckout(root, input, { execute });
    expect(required(reviewed, 'native-installer')).toEqual([]);
    expect(required(reviewed, 'native-startup')).toEqual(['windows-x86_64']);
    input.predecessors = [{ tag: 'v1.2.2-withdrawn', reason: 'Installed before accepted baseline' }];
    expect(() => planFromCheckout(root, input, { execute })).toThrow(/v1.2.2-withdrawn:Windows\/build\.ps1/);
    input.predecessors[0].classifications = [classification];
    expect(planFromCheckout(root, input, { execute }).reviewRequired).toEqual([]);
  }, 15_000);
  test('real shipped predecessor integration diffs add coverage even after their source was reverted', () => {
    const root = mkdtempSync(join(tmpdir(), 'mythra-predecessor-scope-')); roots.push(root);
    const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    const write = (file, text) => { mkdirSync(dirname(join(root, file)), { recursive: true }); writeFileSync(join(root, file), text); };
    const commit = (message) => { git('add', '.'); git('commit', '-m', message); };
    git('init'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid');
    git('remote', 'add', 'origin', 'https://github.com/m17h/Mythra-Code.git');
    for (const file of ['AGENTS.md', '.github/workflows/verify.yml', 'scripts/verify-ci.mjs', 'scripts/release-plan.mjs', 'scripts/release-state.mjs', 'scripts/release-upgrade-coverage.mjs']) write(file, 'policy\n');
    write('package.json', JSON.stringify({ version: '1.2.3' }));
    write('src-tauri/src/lib.rs', 'fn integration() {}\n'); commit('accepted baseline'); git('tag', 'v1.2.2');
    write('src-tauri/src/lib.rs', 'fn integration() { open_state_db(); report_renderer_ready(); CloseRequested(); }\n');
    commit('withdrawn shipped integration'); git('tag', 'v1.2.2-withdrawn');
    write('src-tauri/src/lib.rs', 'fn integration() {}\n'); commit('revert withdrawn integration');
    const input = { baseline: { tag: 'v1.2.2', reason: 'Accepted public baseline' }, predecessors: [{
      tag: 'v1.2.2-withdrawn', reason: 'Users installed this version', classifications: [{ path: 'src-tauri/src/lib.rs',
        boundaries: [], reason: 'Known integration reverted', evidence: 'Reviewed exact reverted integration hunk' }] }] };
    const execute = (_command, args) => JSON.stringify(args[1].endsWith('/releases/latest')
      ? { id: 123, tag_name: 'v1.2.2', draft: false, prerelease: false, published_at: '2026-01-01T00:00:00Z' }
      : { object: { type: 'commit', sha: git('rev-parse', 'v1.2.2^{commit}') } });
    const p = planFromCheckout(root, input, { execute });
    expect(p.changedFiles).toEqual([]);
    for (const check of ['native-startup', 'native-close', 'native-storage']) expect(required(p, check)).toEqual(both);
    expect(p.predecessors[0].boundaryHints.map((h) => h.check)).toEqual(['native-startup', 'native-close', 'native-storage']);
    expect(() => planFromCheckout(root, { baseline: input.baseline, predecessors: [{
      tag: 'v1.2.2-withdrawn', reason: 'Users installed this version',
    }] }, { execute })).toThrow(/v1.2.2-withdrawn:src-tauri\/src\/lib.rs/);
    expect(() => planFromCheckout(root, { ...input, predecessors: [{ ...input.predecessors[0],
      commit: 'f'.repeat(40),
    }] }, { execute })).toThrow(/Predecessor tag moved/);
    // An intermediate version that nobody installed is absent from the plan.
    const reverted = planFromCheckout(root, { baseline: input.baseline }, { execute });
    expect(reverted.checks.filter((c) => c.kind === 'native' && c.required)).toEqual([]);
    write('src/App.tsx', 'export const providerBadge = "new badge";\n'); commit('presentation change');
    const uiInput = { baseline: input.baseline, classifications: [{ path: 'src/App.tsx', boundaries: [],
      reason: 'Provider badge text only', evidence: 'Reviewed providerBadge declaration' }] };
    const ui = planFromCheckout(root, uiInput, { execute });
    expect(ui.checks.filter((c) => c.kind === 'native' && c.required)).toEqual([]);
    write('src/App.tsx', 'markRendererLaunchComposerMounted(); usePersistedState("settings"); useFlushOnClose(flushBeforeClose);\n');
    commit('native App integration'); git('tag', 'v1.2.3-withdrawn');
    const integration = planFromCheckout(root, uiInput, { execute });
    for (const check of ['native-startup', 'native-close', 'native-storage']) expect(required(integration, check)).toEqual(both);
    write('src/App.tsx', 'export const providerBadge = "new badge";\n'); commit('revert App integration');
    const upgraded = planFromCheckout(root, { ...uiInput, predecessors: [{ tag: 'v1.2.3-withdrawn', reason: 'Installed withdrawn integration',
      classifications: [{ path: 'src/App.tsx', boundaries: [], reason: 'Integration reverted', evidence: 'Reviewed reverted App call symbols' }] }] }, { execute });
    for (const check of ['native-startup', 'native-close', 'native-storage']) expect(required(upgraded, check)).toEqual(both);
    // This integration creates six real Git commits and evaluates seven release plans.
    // Windows hosted process startup took 5.8s; keep all assertions with a bounded budget.
  }, 15_000);
});
