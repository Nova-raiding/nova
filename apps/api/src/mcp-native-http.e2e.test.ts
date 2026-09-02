import { afterEach, describe, expect, it, vi } from 'vitest'
import { server } from './server.js'

async function start() {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error)
    server.once('error', onError)
    server.listen(0, () => { server.removeListener('error', onError); resolve() })
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('server did not bind')
  return `http://127.0.0.1:${address.port}`
}

const headers = { 'content-type': 'application/json', 'x-workspace-id': 'ws_demo' }

describe('native ChatGPT MCP HTTP transport', () => {
  afterEach(async () => {
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()))
    vi.unstubAllEnvs()
  })

  it('supports initialize and advertises merchant tools without ops tools', async () => {
    const base = await start()
    const initialize = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'ChatGPT', version: 'test' } } }) })
    expect(initialize.status).toBe(200)
    expect(await initialize.json()).toMatchObject({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'merchant-marketing' } } })

    const listed = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) })
    const payload = await listed.json() as { result: { tools: Array<{ name: string; inputSchema: { type: string } }> } }
    expect(listed.status).toBe(200)
    expect(payload.result.tools.length).toBeGreaterThan(0)
    expect(payload.result.tools.every(tool => !tool.name.startsWith('ops.'))).toBe(true)
    expect(payload.result.tools.some(tool => tool.name === 'asset.scan')).toBe(false)
    expect(payload.result.tools.some(tool => tool.name === 'billing.recharge.create')).toBe(false)
    expect(payload.result.tools.some(tool => tool.name === 'content.generate')).toBe(false)
    expect(payload.result.tools.some(tool => tool.name === 'commercial.access.get')).toBe(true)
    expect(payload.result.tools.some(tool => tool.name === 'creative-points.balance.get')).toBe(true)
    expect(payload.result.tools.some(tool => tool.name === 'merchant.start')).toBe(true)
    expect(payload.result.tools.every(tool => tool.inputSchema.type === 'object')).toBe(true)
  })

  it('maps tools/call to the existing authorized business RPC and returns MCP content', async () => {
    const base = await start()
    const response = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 'call-1', method: 'tools/call', params: { name: 'creative-points.balance.get', arguments: {} } }) })
    const payload = await response.json() as { jsonrpc: string; id: string; result?: { content: Array<{ type: string; text: string }>; structuredContent: Record<string, unknown> } }
    expect(response.status).toBe(200)
    expect(payload).toMatchObject({ jsonrpc: '2.0', id: 'call-1', result: { content: [{ type: 'text' }], structuredContent: { schema_version: 'creative-points.balance.v1', workspace_id: 'ws_demo' } } })
    expect(JSON.parse(payload.result!.content[0]!.text)).toMatchObject({ schema_version: 'creative-points.balance.v1', workspace_id: 'ws_demo' })
  })

  it('preserves commercial access evidence in native JSON-RPC error.data', async () => {
    const base = await start()
    const response = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { ...headers, 'x-request-id': 'req_native_points', 'x-trace-id': 'trace_native_points' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'blocked-1', method: 'tools/call', params: { name: 'merchant.start', arguments: {} } }),
    })
    const payload = await response.json() as { error?: { code: number; data?: Record<string, unknown> } }
    expect(response.status).toBe(200)
    expect(payload).toMatchObject({
      error: {
        code: -32603,
        data: {
          code: 'CREATIVE_POINTS_UNAVAILABLE',
          request_id: 'req_native_points',
          trace_id: 'trace_native_points',
          balance_state: 'unknown',
          available_points: null,
          quoted_points: null,
          access_revision: null,
          rate_card_version: null,
          classification: 'POINT_REQUIRED_NO_CHARGE',
          registry_version: 'commercial-operation-registry.v1',
          next_actions: ['commercial.access.get', 'creative-points.balance.get', 'commercial.catalog.get'],
          retryable: true,
        },
      },
    })
  })

  it('rejects unknown native tools with a JSON-RPC method-not-found error', async () => {
    const base = await start()
    const response = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'ops.finance.export', arguments: {} } }) })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ jsonrpc: '2.0', id: 3, error: { code: -32601 } })

    const compatibilityTool = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'asset.scan', arguments: {} } }) })
    expect(compatibilityTool.status).toBe(200)
    expect(await compatibilityTool.json()).toMatchObject({ jsonrpc: '2.0', id: 7, error: { code: -32601 } })

    const disabledCommercialTool = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'billing.recharge.create', arguments: {} } }) })
    expect(disabledCommercialTool.status).toBe(200)
    expect(await disabledCommercialTool.json()).toMatchObject({ jsonrpc: '2.0', id: 8, error: { code: -32601 } })
  })

  it('returns JSON-RPC method-not-found for unknown native methods instead of legacy envelopes', async () => {
    const base = await start()
    const response = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { ...headers, accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'ping-1', method: 'ping', params: {} }),
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      jsonrpc: '2.0',
      id: 'ping-1',
      error: { code: -32601, message: '不支持的原生 MCP 方法: ping' },
    })
  })

  it('returns standard JSON-RPC invalid-request and invalid-params errors', async () => {
    const base = await start()
    const invalidRequest = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '1.0', id: 5, method: 'initialize' }) })
    expect(await invalidRequest.json()).toMatchObject({ jsonrpc: '2.0', id: 5, error: { code: -32600 } })
    const invalidParams = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'creative-points.balance.get', arguments: [] } }) })
    expect(await invalidParams.json()).toMatchObject({ jsonrpc: '2.0', id: 6, error: { code: -32602 } })
  })

  it('keeps the HTTP authentication boundary outside native JSON-RPC dispatch', async () => {
    vi.stubEnv('AUTH_ENFORCEMENT', 'strict')
    const base = await start()
    const response = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'initialize', params: {} }) })
    expect(response.status).toBe(401)
    expect(response.headers.get('www-authenticate')).toBe('Bearer')
    expect((await response.json()).error.code).toBe('UNAUTHENTICATED')
  })
})
