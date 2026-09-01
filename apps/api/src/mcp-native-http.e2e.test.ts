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
    expect(payload.result.tools.every(tool => tool.inputSchema.type === 'object')).toBe(true)
  })

  it('maps tools/call to the existing authorized business RPC and returns MCP content', async () => {
    const base = await start()
    const response = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 'call-1', method: 'tools/call', params: { name: 'merchant.first_value', arguments: { example: 'true' } } }) })
    const payload = await response.json() as { jsonrpc: string; id: string; result?: { content: Array<{ type: string; text: string }>; structuredContent: Record<string, unknown> } }
    expect(response.status).toBe(200)
    expect(payload).toMatchObject({ jsonrpc: '2.0', id: 'call-1', result: { content: [{ type: 'text' }], structuredContent: { execution: { simulated: true } } } })
    expect(JSON.parse(payload.result!.content[0]!.text)).toMatchObject({ previewOnly: true })
  })

  it('rejects unknown native tools with a JSON-RPC method-not-found error', async () => {
    const base = await start()
    const response = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'ops.finance.export', arguments: {} } }) })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ jsonrpc: '2.0', id: 3, error: { code: -32601 } })

    const compatibilityTool = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'asset.scan', arguments: {} } }) })
    expect(compatibilityTool.status).toBe(200)
    expect(await compatibilityTool.json()).toMatchObject({ jsonrpc: '2.0', id: 7, error: { code: -32601 } })
  })

  it('returns standard JSON-RPC invalid-request and invalid-params errors', async () => {
    const base = await start()
    const invalidRequest = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '1.0', id: 5, method: 'initialize' }) })
    expect(await invalidRequest.json()).toMatchObject({ jsonrpc: '2.0', id: 5, error: { code: -32600 } })
    const invalidParams = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'merchant.first_value', arguments: [] } }) })
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
