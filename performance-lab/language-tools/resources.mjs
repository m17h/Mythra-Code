import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
const execute = promisify(execFile)
function cpuSeconds(value) {
  const [days, time] = value.includes('-') ? value.split('-') : ['0', value]
  const components = time.split(':').map(Number)
  return Number(days) * 86400 + components.reduce((total, part) => total * 60 + part, 0)
}
export async function sampleTree(rootPid) {
  try {
    let rows
    if (process.platform === 'win32') {
      const script = '$r=Get-CimInstance Win32_Process | ForEach-Object { $p=Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue; if($p){ [pscustomobject]@{pid=$_.ProcessId;ppid=$_.ParentProcessId;cpu=$p.CPU;rss=$p.WorkingSet64} } }; ConvertTo-Json -Compress -InputObject @($r)'
      rows = JSON.parse((await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 5000 })).stdout)
    } else {
      const { stdout } = await execute('ps', ['-axo', 'pid=,ppid=,time=,rss='], { timeout: 5000 })
      rows = stdout.trim().split('\n').map(line => {
        const [pid, ppid, cpu, rss] = line.trim().split(/\s+/)
        return { pid: Number(pid), ppid: Number(ppid), cpu: cpuSeconds(cpu), rss: Number(rss) * 1024 }
      })
    }
    const owned = new Set([rootPid])
    let changed
    do { changed = false; for (const row of rows) if (owned.has(row.ppid) && !owned.has(row.pid)) { owned.add(row.pid); changed = true } } while (changed)
    const processes = rows.filter(row => owned.has(row.pid))
    return { processes, sampledProcessCount: processes.length, cpuSeconds: processes.reduce((sum, p) => sum + (p.cpu ?? 0), 0), rssBytes: processes.reduce((sum, p) => sum + p.rss, 0) }
  } catch (error) { return { unavailable: error.message } }
}
