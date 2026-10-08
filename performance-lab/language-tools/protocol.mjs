import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { performance } from 'node:perf_hooks'
import { dirname, delimiter } from 'node:path'
const execute = promisify(execFile)
function serverEnvironment(command) {
  const environment = {}
  for (const key of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL']) {
    if (process.env[key] !== undefined) environment[key] = process.env[key]
  }
  environment.PATH = [dirname(command), ...(process.platform === 'win32' ? [process.env.SystemRoot ? `${process.env.SystemRoot}\\System32` : 'C:\\Windows\\System32'] : ['/usr/bin', '/bin'])].join(delimiter)
  return environment
}

// Independent direct-LSP instrument. This does not import the application's
// protocol implementation and therefore cannot establish native-path correctness.
export class Session {
  constructor(command, args, cwd, timeoutMs = 12000) {
    this.child = spawn(command, args, { cwd, env: serverEnvironment(command), stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' })
    this.buffer = Buffer.alloc(0)
    this.pending = new Map()
    this.nextId = 1
    this.timeoutMs = timeoutMs
    this.metrics = { spawnAttempts: 1, starts: this.child.pid ? 1 : 0, initializeRequests: 0, requestCount: 0, wireReceivedBytes: 0, wireSentBytes: 0, notifications: 0, serverRequests: 0 }
    this.stderr = ''
    this.child.stdin.on('error', error => this.fail(error))
    this.rootUri = null
    this.child.stderr.on('data', chunk => { this.stderr = (this.stderr + chunk).slice(-4000) })
    this.child.stdout.on('data', chunk => {
      this.metrics.wireReceivedBytes += chunk.length
      this.buffer = Buffer.concat([this.buffer, chunk])
      try { this.drain() } catch (error) { this.fail(error) }
    })
    this.child.on('error', error => this.fail(error))
    this.child.on('exit', (code, signal) => {
      this.exit = { code, signal }
      this.fail(new Error(`Server exited: ${code ?? signal}`))
    })
  }
  fail(error) {
    this.failure = error
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error) }
    this.pending.clear()
  }
  drain() {
    while (true) {
      const end = this.buffer.indexOf('\r\n\r\n')
      if (end < 0) {
        if (this.buffer.length > 4096) throw new Error('Oversized protocol header')
        return
      }
      if (end > 4096) throw new Error('Oversized protocol header')
      const matches = [...this.buffer.subarray(0, end).toString().matchAll(/^content-length:\s*(\d+)\s*$/gim)]
      if (matches.length !== 1) throw new Error('Invalid protocol length')
      const size = Number(matches[0][1])
      if (size > 1024 * 1024) throw new Error('Protocol body exceeds 1 MiB')
      if (this.buffer.length < end + 4 + size) return
      const message = JSON.parse(this.buffer.subarray(end + 4, end + 4 + size).toString())
      this.buffer = this.buffer.subarray(end + 4 + size)
      if (message.method && message.id !== undefined) {
        this.metrics.serverRequests++
        const result = message.method === 'workspace/configuration'
          ? (message.params?.items ?? []).map(() => ({}))
          : message.method === 'workspace/workspaceFolders' ? [{ uri: this.rootUri, name: 'fixture' }]
            : message.method === 'workspace/applyEdit' ? { applied: false } : null
        this.send({ jsonrpc: '2.0', id: message.id, result })
      } else if (message.method) this.metrics.notifications++
      else {
        const pending = this.pending.get(message.id)
        if (!pending) continue
        this.pending.delete(message.id)
        clearTimeout(pending.timer)
        if (message.error) pending.reject(new Error(message.error.message))
        else if (!Object.hasOwn(message, 'result')) pending.reject(new Error('Server response omitted result'))
        else pending.resolve({ result: message.result, milliseconds: performance.now() - pending.started, resultBytes: Buffer.byteLength(JSON.stringify(message.result)) })
      }
    }
  }
  send(message) {
    const body = Buffer.from(JSON.stringify(message))
    const frame = Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body])
    this.metrics.wireSentBytes += frame.length
    this.child.stdin.write(frame)
  }
  notify(method, params = {}) { this.send({ jsonrpc: '2.0', method, params }) }
  request(method, params) {
    if (this.failure) return Promise.reject(this.failure)
    const id = this.nextId++
    this.metrics.requestCount++
    if (method === 'initialize') this.metrics.initializeRequests++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        this.notify('$/cancelRequest', { id })
        reject(new Error(`Timed out: ${method}`))
      }, this.timeoutMs)
      this.pending.set(id, { resolve, reject, timer, started: performance.now() })
      this.send({ jsonrpc: '2.0', id, method, params })
    })
  }
  async stop() {
    if (!this.exit && !this.failure) {
      const oldTimeout = this.timeoutMs
      this.timeoutMs = 1000
      try { await this.request('shutdown', null) } catch { /* Record original query error separately. */ }
      this.timeoutMs = oldTimeout
      this.notify('exit')
    }
    if (!this.exit) await new Promise(resolve => {
      const timer = setTimeout(resolve, 200)
      this.child.once('exit', () => { clearTimeout(timer); resolve() })
    })
    if (process.platform === 'win32') {
      if (!this.exit && Number.isInteger(this.child.pid) && this.child.pid > 0) await new Promise(resolve => {
        const killer = spawn('taskkill', ['/PID', String(this.child.pid), '/T', '/F'], { stdio: 'ignore' })
        killer.once('exit', resolve)
        killer.once('error', resolve)
      })
      // Node does not supply the application's kill-on-close Job Object. Parent
      // exit cannot prove descendant cleanup; callers must retain this limitation.
      this.cleanup = { state: 'unverified', reason: 'No Windows Job Object; direct-parent exit does not prove descendant termination' }
    } else if (Number.isInteger(this.child.pid) && this.child.pid > 0) {
      // Children may survive a graceful parent exit; kill the owned process group.
      try {
        const { stdout } = await execute('ps', ['-axo', 'pid=,pgid='], { timeout: 5000 })
        const liveGroup = stdout.trim().split('\n').some(line => Number(line.trim().split(/\s+/)[1]) === this.child.pid)
        if (liveGroup) {
          try { process.kill(-this.child.pid, 'SIGKILL') } catch (error) {
            // The group can finish between observation and the signal. Still
            // perform the independent post-shutdown observation below.
            if (error.code !== 'ESRCH') throw error
          }
        }
        let remaining = []
        const deadline = performance.now() + 1000
        do {
          const after = (await execute('ps', ['-axo', 'pid=,pgid='], { timeout: 5000 })).stdout
          remaining = after.trim().split('\n').filter(line => Number(line.trim().split(/\s+/)[1]) === this.child.pid)
          if (!remaining.length) break
          await new Promise(resolve => setTimeout(resolve, 20))
        } while (performance.now() < deadline)
        this.cleanup = { state: remaining.length ? 'unverified' : 'observed-absent', remainingProcesses: remaining.length, scope: 'Owned process group at bounded post-shutdown observation; not parent-crash lifetime guarantee' }
        if (remaining.length) this.cleanupError = 'Owned process group was still present after bounded shutdown observation'
      } catch (error) {
        if (error.code !== 'ESRCH') this.cleanupError = error.message
      }
    }
    this.cleanup ??= { state: this.child.pid ? 'unverified' : 'not-started' }
    this.child.stdin.destroy()
    this.child.stdout.destroy()
    this.child.stderr.destroy()
    this.fail(new Error('Session closed'))
  }
}
