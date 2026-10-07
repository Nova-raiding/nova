import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const bridgePath = fileURLToPath(new URL('./bridge.mjs', import.meta.url))

async function runBridge(requests: unknown[]) {
  const child = spawn(process.execPath, [bridgePath], {
    env: { ...process.env, NODE_ENV: 'test', MERCHANT_MCP_TOKEN_SOURCE: 'environment' },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const output: string[] = []
  let buffer = ''
  child.stdout.on('data', chunk => {
    buffer += String(chunk)
    for (;;) {
      const newline = buffer.indexOf('\n')
      if (newline < 0) break
      output.push(buffer.slice(0, newline))
      buffer = buffer.slice(newline + 1)
    }
  })
  for (const request of requests) child.stdin.write(`${JSON.stringify(request)}\n`)
  child.stdin.end()
  await once(child, 'close')
  if (buffer.trim()) output.push(buffer.trim())
  return output.map(line => JSON.parse(line) as Record<string, unknown>)
}

describe('local stdio bridge JSON-RPC error contract', () => {
  it('rejects malformed request objects and non-scalar request ids', async () => {
    const responses = await runBridge([
      { jsonrpc: '2.0' },
      { jsonrpc: '2.0', id: true, method: 'ping' },
      { jsonrpc: '2.0', id: {}, method: 'ping' },
      { jsonrpc: '2.0', id: [], method: 'ping' },
    ])

    expect(responses).toEqual([
      { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'JSON-RPC method 必须是非空字符串' } },
      { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'JSON-RPC 请求格式无效' } },
      { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'JSON-RPC 请求格式无效' } },
      { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'JSON-RPC 请求格式无效' } },
    ])
  })

  it('keeps notifications without ids silent', async () => {
    await expect(runBridge([
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 41 } },
      { jsonrpc: '2.0', method: 'notifications/custom-event', params: { ignored: true } },
      { jsonrpc: '2.0', id: 'after-notifications', method: 'ping' },
    ])).resolves.toEqual([{ jsonrpc: '2.0', id: 'after-notifications', result: {} }])
  })
})
