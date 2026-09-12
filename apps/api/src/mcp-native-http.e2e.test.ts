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
    const payload = await listed.json() as { result: { tools: Array<{ name: string; inputSchema: { type: string; properties?: Record<string, unknown> }; annotations?: Record<string, unknown> }> } }
    expect(listed.status).toBe(200)
    expect(payload.result.tools.length).toBeGreaterThan(0)
    expect(payload.result.tools.every(tool => !tool.name.startsWith('ops.'))).toBe(true)
    expect(payload.result.tools.some(tool => tool.name === 'asset.scan')).toBe(false)
    expect(payload.result.tools.some(tool => tool.name === 'billing.recharge.create')).toBe(false)
    expect(payload.result.tools.some(tool => tool.name === 'content.generate')).toBe(true)
    expect(payload.result.tools.some(tool => tool.name === 'commercial.access.get')).toBe(true)
    const orderCreate = payload.result.tools.find(tool => tool.name === 'commercial.order.create')
    expect(orderCreate?.inputSchema.properties).not.toHaveProperty('amount_fen')
    expect(orderCreate?.inputSchema.properties).not.toHaveProperty('currency')
    expect(payload.result.tools.some(tool => tool.name === 'commercial.order.payment.get')).toBe(true)
    // V2 orders are intentionally only recoverable/readable at this stage.
    // Do not accidentally advertise a checkout command until its provider
    // checkout, signed callback, atomic grant and reconciliation flow exist.
    expect(payload.result.tools.some(tool => tool.name === 'commercial.order.checkout.create')).toBe(false)
    expect(payload.result.tools.some(tool => tool.name === 'creative-points.balance.get')).toBe(true)
    expect(payload.result.tools.some(tool => tool.name === 'merchant.start')).toBe(true)
    expect(payload.result.tools.every(tool => tool.inputSchema.type === 'object')).toBe(true)
    expect(payload.result.tools.find(tool => tool.name === 'workspace.health')?.annotations).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: true })
    expect(payload.result.tools.find(tool => tool.name === 'merchant.first_value')?.annotations).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: true })
    expect(payload.result.tools.find(tool => tool.name === 'content.generate')?.annotations).toEqual({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false })
    expect(payload.result.tools.find(tool => tool.name === 'publish.confirm')?.annotations).toEqual({ readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true })
  })

  it('exposes V2 order recovery and fails closed when no approved executable SKU exists', async () => {
    const base = await start()
    const create = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 'order-1', method: 'tools/call', params: { name: 'commercial.order.create', arguments: { purchase_kind: 'point_pack', sku_code: 'points-500', idempotency_key: 'native-order-1', reason: '购买批准点包' } } }) })
    expect(create.status).toBe(200)
    expect(await create.json()).toMatchObject({ jsonrpc: '2.0', id: 'order-1', error: { data: { code: 'COMMERCIAL_PURCHASE_UNAVAILABLE' } } })

    const arbitraryAmount = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 'order-2', method: 'tools/call', params: { name: 'commercial.order.create', arguments: { purchase_kind: 'point_pack', sku_code: 'points-500', amount_fen: '1', idempotency_key: 'native-order-2', reason: '尝试客户端定价' } } }) })
    expect(arbitraryAmount.status).toBe(200)
    expect(await arbitraryAmount.json()).toMatchObject({ jsonrpc: '2.0', id: 'order-2', error: { code: -32602 } })
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
          classification: 'POINT_REQUIRED_NO_CHARGE',
          balance_state: 'unknown',
          available_points: null,
          quoted_points: null,
          registry_version: 'commercial-operation-registry.v1',
          retryable: true,
          rate_card_version: null,
          access_revision: null,
          next_actions: ['commercial.access.get', 'creative-points.balance.get', 'commercial.catalog.get'],
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
      headers: { ...headers, accept: 'application/json, text/event-stream', 'x-request-id': 'req_unknown_native', 'x-trace-id': 'trace_unknown_native' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'ping-1', method: 'ping', params: {} }),
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      jsonrpc: '2.0',
      id: 'ping-1',
      error: {
        code: -32601,
        message: '不支持的原生 MCP 方法: ping',
        data: { code: 'MCP_METHOD_NOT_FOUND', details: {}, request_id: 'req_unknown_native', trace_id: 'trace_unknown_native' },
      },
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
    expect(response.headers.get('www-authenticate')).toMatch(/^Bearer(?:\s|$)/)
    expect((await response.json()).error.code).toBe('UNAUTHENTICATED')
  })

  it('advertises the public HTTPS OAuth resource behind the production gateway', async () => {
    vi.stubEnv('AUTH_ENFORCEMENT', 'strict')
    const base = await start()
    const response = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { ...headers, host: 'yxsona.com', 'x-forwarded-host': 'yxsona.com', 'x-forwarded-proto': 'https' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'initialize', params: {} }),
    })
    expect(response.status).toBe(401)
    expect(response.headers.get('www-authenticate')).toBe('Bearer resource_metadata="https://yxsona.com/.well-known/oauth-protected-resource"')
  })

  it('fails closed instead of advertising dead OAuth endpoints in production', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('PUBLIC_APP_BASE_URL', 'https://yxsona.com')
    const base = await start()
    for (const path of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-authorization-server']) {
      const response = await fetch(`${base}${path}`, { headers: { host: 'yxsona.com', 'x-forwarded-host': 'yxsona.com', 'x-forwarded-proto': 'https' } })
      expect(response.status, path).toBe(503)
      expect(response.headers.get('cache-control')).toBe('no-store')
      await expect(response.json()).resolves.toEqual({ error: 'MCP_OAUTH_NOT_CONFIGURED' })
    }
  })

  it('publishes configured HTTPS OAuth metadata without leaking local fixture routes', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('PUBLIC_APP_BASE_URL', 'https://yxsona.com')
    vi.stubEnv('MCP_OAUTH_ISSUER', 'https://accounts.example.com')
    vi.stubEnv('MCP_OAUTH_AUTHORIZATION_ENDPOINT', 'https://accounts.example.com/oauth/authorize')
    vi.stubEnv('MCP_OAUTH_TOKEN_ENDPOINT', 'https://accounts.example.com/oauth/token')
    const base = await start()
    const protectedResource = await fetch(`${base}/.well-known/oauth-protected-resource`, { headers: { host: 'yxsona.com', 'x-forwarded-host': 'yxsona.com', 'x-forwarded-proto': 'https' } })
    expect(protectedResource.status).toBe(200)
    await expect(protectedResource.json()).resolves.toEqual({ resource: 'https://yxsona.com/mcp', authorization_servers: ['https://accounts.example.com'], scopes_supported: ['openid', 'profile', 'merchant'] })

    const authorizationServer = await fetch(`${base}/.well-known/oauth-authorization-server`, { headers: { host: 'yxsona.com', 'x-forwarded-host': 'yxsona.com', 'x-forwarded-proto': 'https' } })
    expect(authorizationServer.status).toBe(200)
    await expect(authorizationServer.json()).resolves.toMatchObject({ issuer: 'https://accounts.example.com', authorization_endpoint: 'https://accounts.example.com/oauth/authorize', token_endpoint: 'https://accounts.example.com/oauth/token', code_challenge_methods_supported: ['S256'] })
  })

  it('fails closed when the OpenAI Apps domain challenge token is not configured', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('PUBLIC_APP_BASE_URL', 'https://yxsona.com')
    const base = await start()
    const response = await fetch(`${base}/.well-known/openai-apps-challenge`, { headers: { host: 'yxsona.com', 'x-forwarded-host': 'yxsona.com', 'x-forwarded-proto': 'https' } })
    expect(response.status).toBe(503)
    expect(response.headers.get('cache-control')).toBe('no-store')
    await expect(response.json()).resolves.toEqual({ error: 'OPENAI_APPS_CHALLENGE_NOT_CONFIGURED' })
  })

  it('returns only the configured OpenAI Apps domain challenge token', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('PUBLIC_APP_BASE_URL', 'https://yxsona.com')
    vi.stubEnv('OPENAI_APPS_CHALLENGE_TOKEN', 'challenge-token-from-openai')
    const base = await start()
    const response = await fetch(`${base}/.well-known/openai-apps-challenge`, { headers: { host: 'yxsona.com', 'x-forwarded-host': 'yxsona.com', 'x-forwarded-proto': 'https' } })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toMatch(/^text\/plain/u)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.text()).toBe('challenge-token-from-openai')
  })
})
