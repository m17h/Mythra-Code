// Deliberately limited harness fixture, not a language implementation.
let buffer = Buffer.alloc(0)
let currentSource = ''
let initializations = 0
const timers = new Set()
function send(message) {
  const body = Buffer.from(JSON.stringify(message))
  // Fragmented framing exercises the independent instrument's buffered parser.
  process.stdout.write(`Content-Length: ${body.length}\r\n`)
  process.stdout.write('\r\n')
  process.stdout.write(body)
}
process.stdin.on('data', chunk => {
  buffer = Buffer.concat([buffer, chunk])
  while (true) {
    const end = buffer.indexOf('\r\n\r\n')
    if (end < 0) return
    const size = Number(buffer.subarray(0, end).toString().match(/Content-Length:\s*(\d+)/i)?.[1])
    if (!Number.isFinite(size)) throw new Error('Invalid fixture frame')
    if (buffer.length < end + 4 + size) return
    const message = JSON.parse(buffer.subarray(end + 4, end + 4 + size).toString())
    buffer = buffer.subarray(end + 4 + size)
    if (message.method === 'initialize') {
      initializations++
      send({ jsonrpc: '2.0', id: message.id, result: { capabilities: { hoverProvider: true, documentSymbolProvider: true, positionEncoding: 'utf-16' } } })
    } else if (message.method === 'initialized') {
      send({ jsonrpc: '2.0', id: 'server-config', method: 'workspace/configuration', params: { items: [{ section: 'fixture' }] } })
    } else if (message.method === 'textDocument/didOpen') currentSource = message.params.textDocument.text
    else if (message.method === 'fixture/environment') send({ jsonrpc: '2.0', id: message.id, result: Object.keys(process.env) })
    else if (message.method === 'fixture/missing-result') send({ jsonrpc: '2.0', id: message.id })
    else if (message.method === 'textDocument/hover') send({ jsonrpc: '2.0', id: message.id, result: { contents: currentSource, initializations } })
    else if (message.method === 'fixture/delayed') {
      const timer = setTimeout(() => { timers.delete(timer); send({ jsonrpc: '2.0', id: message.id, result: 'late-response' }) }, 120)
      timers.add(timer)
    } else if (message.method === 'fixture/hang' || message.method === '$/cancelRequest') { /* Intentionally no answer. */ }
    else if (message.method === 'shutdown') send({ jsonrpc: '2.0', id: message.id, result: null })
    else if (message.method === 'exit') { for (const timer of timers) clearTimeout(timer); process.exit(0) }
  }
})
