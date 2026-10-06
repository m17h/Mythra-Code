import { expect, test } from 'vitest';
import { verifyPublicBaseline } from './release-plan.mjs';

const baseline = { tag: 'v1.2.2', commit: 'a'.repeat(40) };
const release = (tag = baseline.tag) => ({ id: 123, tag_name: tag, draft: false, prerelease: false, published_at: '2026-01-01T00:00:00Z' });
function execute(responses = {}) {
  return (command, args) => {
    expect(command).toBe('gh'); expect(args[0]).toBe('api');
    expect(args[1]).toMatch(/^repos\/m17h\/Mythra-Code\//);
    const path = args[1].replace('repos/m17h/Mythra-Code/', '');
    return JSON.stringify(responses[path] ?? (path.startsWith('releases/') ? release() : { object: { type: 'commit', sha: baseline.commit } }));
  };
}
test('freezes fresh canonical public/latest baseline and source-tag proof', () => {
  expect(verifyPublicBaseline({ root: '/unused', baseline, execute: execute() })).toMatchObject({
    repository: 'm17h/Mythra-Code', releaseId: 123, tag: baseline.tag, commit: baseline.commit,
    latestTag: baseline.tag, latestCommit: baseline.commit,
  });
});
test.each([
  ['draft', { draft: true }], ['prerelease', { prerelease: true }],
  ['unpublished', { published_at: null }], ['missing release identity', { id: null }],
])('rejects a %s baseline', (_reason, patch) => {
  expect(() => verifyPublicBaseline({ root: '/unused', baseline, execute: execute({ 'releases/latest': { ...release(), ...patch } }) })).toThrow(/public and non-prerelease/);
});
test('rejects an arbitrary older baseline without an explicitly recorded superseding shipped release', () => {
  expect(() => verifyPublicBaseline({ root: '/unused', baseline, execute: execute({ 'releases/latest': release('v1.2.3') }) })).toThrow(/superseding shipped predecessor/);
});
test('a recorded withdrawn shipped predecessor permits a prior accepted public baseline', () => {
  const proof = verifyPublicBaseline({ root: '/unused', baseline, predecessors: [{ tag: 'v1.2.3', reason: 'Users installed the withdrawn version' }],
    execute: execute({ 'releases/latest': release('v1.2.3'), 'git/ref/tags/v1.2.3': { object: { type: 'commit', sha: 'b'.repeat(40) } } }),
  });
  expect(proof).toMatchObject({ tag: baseline.tag, latestTag: 'v1.2.3', latestCommit: 'b'.repeat(40) });
});
test('an explicit predecessor cannot make a draft accepted baseline public', () => {
  expect(() => verifyPublicBaseline({ root: '/unused', baseline, predecessors: [{ tag: 'v1.2.3', reason: 'Previously shipped' }],
    execute: execute({ 'releases/latest': release('v1.2.3'), 'releases/tags/v1.2.2': { ...release(), draft: true } }),
  })).toThrow(/public and non-prerelease/);
});
test('rejects a moved remote baseline tag', () => {
  expect(() => verifyPublicBaseline({ root: '/unused', baseline,
    execute: execute({ 'git/ref/tags/v1.2.2': { object: { type: 'commit', sha: 'b'.repeat(40) } } }),
  })).toThrow(/differs from the local source tag/);
});
test('annotated public tags are peeled to their exact source commit', () => {
  const proof = verifyPublicBaseline({ root: '/unused', baseline, execute: execute({
    'git/ref/tags/v1.2.2': { object: { type: 'tag', sha: 'b'.repeat(40) } },
    [`git/tags/${'b'.repeat(40)}`]: { object: { type: 'commit', sha: baseline.commit } },
  }) });
  expect(proof.commit).toBe(baseline.commit);
});
