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
    ['limit', '0'], ['limit', '101'], ['offset', '-1'], ['offset', '01'], ['offset', '10000000000'],
  ])('rejects invalid task.history %s=%s before forwarding', async (field, value) => {
    const responses = await runBridge([
      { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'task.history', arguments: { [field]: value } } },
    ], {
      DEPLOY_ENV: 'local_desktop',
      MERCHANT_MCP_BASE_URL: 'https://merchant.example.com',
      MERCHANT_WORKSPACE_ID: 'ws_task_history_pagination',
    })
    expect(responses[0]).toMatchObject({ result: { isError: true, structuredContent: { code: 'TOOL_ARGUMENTS_INVALID' } } })
  })

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

  it('keeps local recovery blocking fail-closed and gives workspace login guidance when the recovery read is unauthorized', async () => {
    const forwarded: string[] = []
    const server = createServer(async (req, res) => {
      let body = ''
      for await (const chunk of req) body += String(chunk)
      const { method } = JSON.parse(body)
      forwarded.push(method)
      res.setHeader('content-type', 'application/json')
      if (method === 'creative.brief') {
        res.statusCode = 402
        res.end(JSON.stringify({ error: { code: 'CREATIVE_POINTS_EXHAUSTED', message: 'zero points', details: { balance_state: 'known', available_points: 0, next_actions: ['billing.status'] } } }))
        return
      }
      if (method === 'billing.status') {
        res.statusCode = 401
        res.end(JSON.stringify({ error: { code: 'MCP_AUTH_REQUIRED', message: 'login required' } }))
        return
      }
      res.end(JSON.stringify({ data: { jsonrpc: '2.0', id: 1, result: { accepted: true } }, error: null }))
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('test server did not bind')
    try {
      const responses = await runBridge([
        { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'workspace.interactive.confirm', arguments: { confirmation: 'I_CONFIRM_INTERACTIVE_WRITES' } } },
        { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'creative.brief', arguments: { product_id: 'product_1', asset_type: 'banner' } } },
        { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'creative.brief', arguments: { product_id: 'product_1', asset_type: 'banner' } } },
        { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'billing.status', arguments: {} } },
      ], {
        DEPLOY_ENV: 'local_desktop',
        MERCHANT_MCP_BASE_URL: `http://127.0.0.1:${address.port}`,
        MERCHANT_WORKSPACE_ID: 'ws_recovery_auth',
        MERCHANT_MCP_TOKEN: 'isolated-test-token',
        MERCHANT_MCP_REFRESH_TOKEN: '',
        MERCHANT_STRICT_AUTH: 'true',
        MERCHANT_ALLOW_FIXTURE_FALLBACK: 'false',
        MERCHANT_MCP_WRITE_ENABLED: 'true',
      })
      const responseText = (response: Record<string, unknown> | undefined) => {
        const result = response?.result as { content?: Array<{ text?: string }> } | undefined
        return result?.content?.[0]?.text ?? ''
      }
      expect(responses[2]).toMatchObject({ result: { isError: true, structuredContent: { code: 'CREATIVE_POINTS_EXHAUSTED', recovery_only: true } } })
      expect(responseText(responses[2] ?? {})).toContain('服务端授权的创意点恢复入口')
      expect(responses[3]).toMatchObject({ result: { isError: true, structuredContent: { code: 'MCP_AUTH_REQUIRED' } } })
      expect(responseText(responses[3] ?? {})).toContain('ws_... 工作区 ID')
      expect(responseText(responses[3] ?? {})).toContain('login.sh --workspace ws_...')
      expect(responseText(responses[3] ?? {})).toContain('login.cmd --workspace ws_...')
      expect(forwarded).toEqual(['workspace.interactive.confirm', 'creative.brief', 'billing.status'])
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
