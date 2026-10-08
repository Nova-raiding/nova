import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const bridgePath = fileURLToPath(new URL('./bridge.mjs', import.meta.url))

async function runBridge(requests: unknown[], env: NodeJS.ProcessEnv = {}, entrypoint = bridgePath) {
  const child = spawn(process.execPath, [entrypoint], {
    env: { ...process.env, NODE_ENV: 'test', MERCHANT_MCP_TOKEN_SOURCE: 'environment', ...env },
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
  it.each([
    ['canonical', bridgePath],
    ['installable mirror', fileURLToPath(new URL('../../../.codex-marketplace/plugins/merchant-marketing/mcp/bridge.mjs', import.meta.url))],
  ])('accepts omitted arguments but rejects malformed and required arguments on %s', async (_name, entrypoint) => {
    const forwarded: Record<string, unknown>[] = []
    const server = createServer(async (req, res) => {
      let body = ''
      for await (const chunk of req) body += String(chunk)
      forwarded.push(JSON.parse(body))
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ data: { jsonrpc: '2.0', id: 1, result: { schema_version: 'onboarding.status.v1' } }, error: null }))
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('test server did not bind')
    try {
      const responses = await runBridge([
        { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'onboarding.status' } },
        ...[null, [], 'bad', 7].map((argumentsValue, index) => ({ jsonrpc: '2.0', id: index + 2, method: 'tools/call', params: { name: 'onboarding.status', arguments: argumentsValue } })),
        { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'catalog.image.get' } },
      ], {
        DEPLOY_ENV: 'local_desktop',
        MERCHANT_MCP_BASE_URL: `http://127.0.0.1:${address.port}`,
        MERCHANT_WORKSPACE_ID: 'ws_contract_arguments',
        MERCHANT_MCP_TOKEN: 'isolated-test-token',
        MERCHANT_MCP_REFRESH_TOKEN: '',
        MERCHANT_STRICT_AUTH: 'true',
        MERCHANT_ALLOW_FIXTURE_FALLBACK: 'false',
        MERCHANT_MCP_WRITE_ENABLED: 'false',
      }, entrypoint)
      expect(responses[0]).toMatchObject({ id: 1, result: { isError: false, structuredContent: { schema_version: 'onboarding.status.v1' } } })
      for (const response of responses.slice(1)) expect(response).toMatchObject({ result: { isError: true, structuredContent: { code: 'TOOL_ARGUMENTS_INVALID' } } })
      expect(forwarded).toEqual([expect.objectContaining({ method: 'onboarding.status', params: { workspace_id: 'ws_contract_arguments' } })])
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })

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
