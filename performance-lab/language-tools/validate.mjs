import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { Session } from './protocol.mjs'
import { fixture } from './fixture.mjs'

const project = await fixture()
const originalOption = process.env.NODE_OPTIONS
process.env.NODE_OPTIONS = '--invalid-benchmark-option'
process.env.BENCH_FIXTURE_SECRET = 'synthetic-must-not-inherit'
const session = new Session(process.execPath, [fileURLToPath(new URL('./fake-server.mjs', import.meta.url))], project.root, 3000)
if (originalOption === undefined) delete process.env.NODE_OPTIONS
else process.env.NODE_OPTIONS = originalOption
delete process.env.BENCH_FIXTURE_SECRET
let result
try {
  session.rootUri = project.rootUri
  await session.request('initialize', {})
  const environment = (await session.request('fixture/environment', {})).result
  assert.ok(!environment.includes('NODE_OPTIONS'))
  assert.ok(!environment.includes('BENCH_FIXTURE_SECRET'))
  await assert.rejects(session.request('fixture/missing-result', {}), /omitted result/)
  session.notify('initialized')
  session.notify('textDocument/didOpen', { textDocument: { uri: project.uri, text: 'old source' } })
  assert.equal((await session.request('textDocument/hover', {})).result.contents, 'old source')
  session.notify('textDocument/didClose', { textDocument: { uri: project.uri } })
  session.notify('textDocument/didOpen', { textDocument: { uri: project.uri, text: 'fresh source 😀' } })
  assert.equal((await session.request('textDocument/hover', {})).result.contents, 'fresh source 😀')
  session.timeoutMs = 50
  await assert.rejects(session.request('fixture/delayed', {}), /Timed out/)
  await new Promise(resolve => setTimeout(resolve, 150))
  assert.equal(session.pending.size, 0)
  assert.equal((await session.request('textDocument/hover', {})).result.contents, 'fresh source 😀')
  await assert.rejects(session.request('fixture/hang', {}), /Timed out/)
  assert.equal(session.pending.size, 0)
  assert.equal(session.metrics.initializeRequests, 1)
  assert.equal(session.metrics.starts, 1)
  assert.equal(session.metrics.serverRequests, 1)
  const oversized = Array.from({ length: 1000 }, (_, index) => ({ name: `symbol${index}`, detail: 'x'.repeat(180), range: { start: { line: index, character: 0 }, end: { line: index, character: 1 } } }))
  const compactBytes = Buffer.byteLength(JSON.stringify(oversized))
  const prettyBytes = Buffer.byteLength(JSON.stringify(oversized, null, 2))
  assert.ok(compactBytes > 256 * 1024)
  assert.ok(prettyBytes > compactBytes)
  result = { fixture: 'protocol instrumentation only; not app correctness', starts: session.metrics.starts, initializeRequests: session.metrics.initializeRequests, pendingAfterTimeouts: session.pending.size, compactBytes, prettyBytes }
} finally { await session.stop() }
assert.equal(session.pending.size, 0)
assert.equal(session.cleanupError, undefined)
console.log(JSON.stringify({ ...result, cleanup: session.cleanup, retainedProject: project.root }))
