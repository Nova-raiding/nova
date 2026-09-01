import { afterEach, describe, expect, it } from 'vitest'
import { server } from './server.js'

type ErrorEnvelope = {
  request_id: string
  trace_id: string
  workspace_id: string
  data: null
  warnings: unknown[]
  next_actions: unknown[]
  error: { code: string; message: string; details?: Record<string, unknown> } | null
}

async function start() {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error)
    server.once('error', onError)
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', onError)
      resolve()
    })
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('server did not bind')
  return `http://127.0.0.1:${address.port}`
}

afterEach(async () => {
  if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()))
})

describe('API request scope error contract', () => {
  it('keeps request and trace IDs identical across the MCP error body and response headers', async () => {
    const base = await start()
    const response = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-workspace-id': 'ws_scope_header',
        'x-request-id': 'req_scope_mismatch_01',
        'x-trace-id': 'trace_scope_mismatch_01',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'scope-contract-1',
        method: 'canonical.product.consistency',
        params: { workspace_id: 'ws_scope_body' },
      }),
    })
    const body = await response.json() as ErrorEnvelope

    expect(response.status).toBe(403)
    expect(body).toMatchObject({
      request_id: 'req_scope_mismatch_01',
      trace_id: 'trace_scope_mismatch_01',
      workspace_id: 'ws_scope_header',
      data: null,
      error: { code: 'WORKSPACE_SCOPE_MISMATCH' },
    })
    expect(body.error?.message).toBeTruthy()
    expect(response.headers.get('x-request-id')).toBe(body.request_id)
    expect(response.headers.get('x-trace-id')).toBe(body.trace_id)
  })

  it('does not expose the body workspace in a scope mismatch error', async () => {
    const base = await start()
    const response = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-workspace-id': 'ws_scope_visible',
        'x-request-id': 'req_scope_mismatch_02',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'scope-contract-2',
        method: 'workspace.health',
        params: { workspace_id: 'ws_scope_secret_body' },
      }),
    })
    const body = await response.json() as ErrorEnvelope

    expect(response.status).toBe(403)
    expect(body.error?.code).toBe('WORKSPACE_SCOPE_MISMATCH')
    expect(body.workspace_id).toBe('ws_scope_visible')
    expect(JSON.stringify(body)).not.toContain('ws_scope_secret_body')
  })
})
