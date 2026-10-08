import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { resolve, dirname, isAbsolute } from 'node:path'
import { createHash } from 'node:crypto'
import { platform, arch, cpus, release } from 'node:os'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'
import { Session } from './protocol.mjs'
import { fixture } from './fixture.mjs'
import { sampleTree } from './resources.mjs'

const HELP = `Opt-in direct LSP benchmark; no models, installs, app profile or CI.
Node 22 performance-lab/language-tools/bench.mjs \\
  --command /absolute/server-command --args-json '["/absolute/cli.mjs","--stdio"]' \\
  --initialization-json '{"disableAutomaticTypingAcquisition":true}' \\
  --output /absolute/report.json [--mode cold|linger] [--rounds 3] [--idle-ms 300]
  [--source-dir /absolute/src-tauri/src] [--timeout-ms 12000]
Cold starts/initializes once per operation. Linger is a direct-protocol experiment,
not an application feature. Fixtures and failure reports are retained. Neither
mode establishes actual Rust/AppHandle query, UI, authorization or release evidence.`
function options(argv) {
  if (argv.includes('--help')) { console.log(HELP); process.exit(0) }
  const result = { mode: 'cold', rounds: 3, 'idle-ms': 300, 'timeout-ms': 12000, 'source-dir': fileURLToPath(new URL('../../src-tauri/src/', import.meta.url)), 'args-json': '[]', 'initialization-json': '{"disableAutomaticTypingAcquisition":true}' }
  const known = new Set(['command', 'args-json', 'initialization-json', 'output', 'mode', 'rounds', 'idle-ms', 'source-dir', 'timeout-ms'])
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]?.replace(/^--/, '')
    if (!known.has(key) || argv[index + 1] === undefined) throw new Error(`Unknown/missing option: ${argv[index]}`)
    result[key] = argv[index + 1]
  }
  if (!isAbsolute(result.command ?? '') || !isAbsolute(result.output ?? '')) throw new Error('Explicit absolute --command and --output are required')
  if (!['cold', 'linger'].includes(result.mode)) throw new Error('Mode must be cold or linger')
  for (const [key, minimum, maximum] of [['rounds', 1, 20], ['idle-ms', 0, 10000], ['timeout-ms', 50, 30000]]) {
    result[key] = Number(result[key])
    if (!Number.isInteger(result[key]) || result[key] < minimum || result[key] > maximum) throw new Error(`Invalid ${key}`)
  }
  result.args = JSON.parse(result['args-json'])
  result.initialization = JSON.parse(result['initialization-json'])
  if (!Array.isArray(result.args) || result.args.some(arg => typeof arg !== 'string')) throw new Error('args-json must be a string array')
  return result
}
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
async function sourceHashes(directory) {
  const result = {}
  for (const name of ['agents.rs', 'lib.rs', 'language_tools.rs', 'language_queries.rs']) {
    try { result[name] = hash(await readFile(resolve(directory, name))) } catch { result[name] = null }
  }
  return result
}
async function launchHashes(config) {
  const paths = new Set([config.command, ...config.args.filter(isAbsolute)])
  if (typeof config.initialization?.tsserver?.path === 'string') paths.add(config.initialization.tsserver.path)
  const result = {}
  for (const path of paths) {
    try { result[path] = hash(await readFile(path)) } catch { result[path] = null }
  }
  return result
}
async function harnessHashes() {
  return Object.fromEntries(await Promise.all(['bench.mjs', 'protocol.mjs', 'fixture.mjs', 'resources.mjs'].map(async name => [name, hash(await readFile(new URL(name, import.meta.url)))])))
}
function quantile(values, q) { const ordered = [...values].sort((a, b) => a - b); return ordered[Math.max(0, Math.ceil(q * ordered.length) - 1)] ?? null }
function summary(samples) {
  const result = {}
  for (const operation of ['definition', 'references', 'hover', 'symbols']) {
    const values = samples.filter(s => s.operation === operation && s.status === 'complete' && s.correctness).map(s => s.totalMs)
    result[operation] = { successfulSamples: values.length, p50Ms: quantile(values, 0.5), p95Ms: quantile(values, 0.95) }
  }
  return result
}
const methods = { definition: 'textDocument/definition', references: 'textDocument/references', hover: 'textDocument/hover', symbols: 'textDocument/documentSymbol' }
async function initialize(session, project, initialization) {
  session.rootUri = project.rootUri
  const response = await session.request('initialize', { processId: process.pid, rootUri: project.rootUri, workspaceFolders: [{ uri: project.rootUri, name: 'fixture' }], capabilities: { general: { positionEncodings: ['utf-16'] }, workspace: { configuration: true, workspaceFolders: true }, textDocument: { definition: { linkSupport: true }, documentSymbol: { hierarchicalDocumentSymbolSupport: true } } }, initializationOptions: initialization })
  if (!response.result?.capabilities || (response.result.capabilities.positionEncoding && response.result.capabilities.positionEncoding !== 'utf-16')) throw new Error('Missing capabilities or unsupported encoding')
  session.notify('initialized')
  return response
}
function check(operation, result) {
  if (operation === 'definition') {
    const items = Array.isArray(result) ? result : [result]
    return items.some(item => (item?.targetUri ?? item?.uri)?.endsWith('/src/base.ts'))
  }
  if (operation === 'references') return Array.isArray(result) && result.some(item => item.uri?.endsWith('/src/main.ts') && item.range?.start?.line === 1)
  if (operation === 'hover') return JSON.stringify(result).includes('benchmarkValue')
  if (operation === 'symbols') return Array.isArray(result) && result.length === 151 && result.some(item => item.name === 'symbol149')
  return false
}
async function main() {
  const config = options(process.argv.slice(2))
  if (process.platform === 'win32') throw new Error('Direct benchmarks require process-tree ownership unavailable in this Node Windows runner; use the native OwnedProcess measurements')
  const project = await fixture()
  const report = {
    schema: 1, evidence: 'direct-LSP; not native application query or UI', status: 'running', startedAt: new Date().toISOString(),
    environment: { node: process.version, platform: platform(), osRelease: release(), arch: arch(), cpu: cpus()[0]?.model },
    mode: config.mode, rounds: config.rounds, command: config.command, args: config.args, initialization: config.initialization,
    project: { root: project.root, sourceSha256: project.sourceSha256, importChainLength: 12, functionSymbols: 150 },
    sourceHashes: await sourceHashes(config['source-dir']),
    launchFileHashes: await launchHashes(config),
    harnessHashes: await harnessHashes(),
    resourceMethod: 'ps CPU time/RSS or Windows Get-Process CPU/WorkingSet; live identified parent+descendants, no exited-child CPU, no peak guarantee; sampling overhead included in totalMs',
    serverEnvironment: 'Explicit small OS allowlist and command-directory/system PATH; NODE_OPTIONS, NODE_PATH and inherited credentials omitted. HOME/USERPROFILE remain for server compatibility; no app profile selected.',
    samples: [], sessions: [], failures: [],
  }
  await mkdir(dirname(config.output), { recursive: true })
  const checkpoint = () => writeFile(config.output, `${JSON.stringify(report, null, 2)}\n`)
  await checkpoint()
  let active = null
  try {
    for (let round = 0; round < config.rounds; round++) {
      for (const operation of Object.keys(methods)) {
        const started = performance.now()
        let initializationMs = 0
        let sourceReadMs = 0
        let before
        let sessionRecord
        try {
          if (!active) {
            active = new Session(config.command, config.args, project.root, config['timeout-ms'])
            sessionRecord = { round, cause: config.mode === 'cold' ? operation : 'first-linger-query', pid: active.child.pid }
            report.sessions.push(sessionRecord)
            initializationMs = (await initialize(active, project, config.initialization)).milliseconds
          }
          before = await sampleTree(active.child.pid)
          const sourceStart = performance.now()
          const source = await readFile(project.file, 'utf8')
          sourceReadMs = performance.now() - sourceStart
          active.notify('textDocument/didOpen', { textDocument: { uri: project.uri, languageId: 'typescript', version: round + 1, text: source } })
          const params = { textDocument: { uri: project.uri } }
          if (operation !== 'symbols') params.position = project.position
          if (operation === 'references') params.context = { includeDeclaration: true }
          const answer = await active.request(methods[operation], params)
          active.notify('textDocument/didClose', { textDocument: { uri: project.uri } })
          const resources = await sampleTree(active.child.pid)
          const correctness = check(operation, answer.result)
          report.samples.push({ round, operation, status: 'complete', correctness, initializationMs, sourceReadMs, queryMs: answer.milliseconds, totalMs: performance.now() - started, rawCompactResultBytes: answer.resultBytes, rawPrettyResultBytes: Buffer.byteLength(JSON.stringify(answer.result, null, 2)), resultSha256: hash(JSON.stringify(answer.result)), sourceSha256: hash(source), resourcesBefore: before, resourcesAfter: resources, sampledCpuDeltaSeconds: resources.cpuSeconds !== undefined && before.cpuSeconds !== undefined ? Math.max(0, resources.cpuSeconds - before.cpuSeconds) : null })
          if (!correctness) report.failures.push({ round, operation, error: 'Fixture correctness did not match expected result' })
        } catch (error) {
          report.samples.push({ round, operation, status: 'failed', error: error.message, totalMs: performance.now() - started })
          report.failures.push({ round, operation, error: error.message })
          // A broken linger session must not quietly turn into a successful cold retry.
          throw error
        } finally {
          if (active && config.mode === 'cold') {
            const record = report.sessions.at(-1)
            record.metrics = { ...active.metrics }
            record.stderrTail = active.stderr
            const cleanupStarted = performance.now()
            await active.stop()
            record.cleanupMs = performance.now() - cleanupStarted
            record.metricsAfterCleanup = { ...active.metrics }
            record.exit = active.exit ?? null
            record.cleanup = active.cleanup
            record.cleanupError = active.cleanupError ?? null
            if (record.cleanupError) report.failures.push({ round, operation, error: `Cleanup: ${record.cleanupError}` })
            active = null
          }
          await checkpoint()
        }
      }
    }
    if (active) {
      const before = await sampleTree(active.child.pid)
      const began = performance.now()
      await new Promise(resolve => setTimeout(resolve, config['idle-ms']))
      const after = await sampleTree(active.child.pid)
      report.idle = { wallMs: performance.now() - began, before, after, sampledCpuDeltaSeconds: before.cpuSeconds !== undefined && after.cpuSeconds !== undefined ? Math.max(0, after.cpuSeconds - before.cpuSeconds) : null }
    }
    report.status = report.failures.length ? 'failed' : 'complete'
  } catch (error) { report.status = 'failed'; report.error = error.message }
  finally {
    if (active) {
      report.sessions.at(-1).metrics = { ...active.metrics }
      report.sessions.at(-1).stderrTail = active.stderr
      await active.stop()
      report.sessions.at(-1).metricsAfterCleanup = { ...active.metrics }
      report.sessions.at(-1).exit = active.exit ?? null
      report.sessions.at(-1).cleanup = active.cleanup
      report.sessions.at(-1).cleanupError = active.cleanupError ?? null
      if (active.cleanupError) { report.status = 'failed'; report.failures.push({ error: `Cleanup: ${active.cleanupError}` }) }
    }
    report.completedAt = new Date().toISOString()
    report.sourceHashesAfter = await sourceHashes(config['source-dir'])
    report.sourceChanged = JSON.stringify(report.sourceHashes) !== JSON.stringify(report.sourceHashesAfter)
    report.harnessHashesAfter = await harnessHashes()
    report.harnessChanged = JSON.stringify(report.harnessHashes) !== JSON.stringify(report.harnessHashesAfter)
    report.summary = summary(report.samples)
    report.cleanupVerified = report.sessions.every(session => session.cleanup?.state === 'observed-absent' || session.cleanup?.state === 'not-started')
    if (!report.cleanupVerified || report.sourceChanged || report.harnessChanged) {
      report.status = 'failed'
      report.failures.push({ error: 'Cleanup was unverified or source/harness changed during measurement; do not accept this comparison' })
    }
    await checkpoint()
    console.log(JSON.stringify({ status: report.status, mode: report.mode, sessions: report.sessions.length, summary: report.summary, output: config.output }))
    if (report.status !== 'complete') process.exitCode = 1
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1 })
