import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

let api: typeof import('./server.js')
let base = ''

describe('MCP upload sessions in the API runtime', () => {
  beforeAll(async () => {
    vi.stubEnv('NODE_ENV', 'test')
    api = await import('./server.js')
    await new Promise<void>((resolve, reject) => {
      api.server.once('error', reject)
      api.server.listen(0, '127.0.0.1', resolve)
    })
    const address = api.server.address()
    if (!address || typeof address === 'string') throw new Error('server did not bind')
    base = `http://127.0.0.1:${address.port}`
  })

  afterAll(async () => {
    if (api?.server.listening) await new Promise<void>(resolve => api.server.close(() => resolve()))
    vi.unstubAllEnvs()
  })

  it.each([
    ['upload.session.create', { file_name: 'source.txt', content_type: 'text/plain', size_bytes: '3', sha256: 'a'.repeat(64) }],
    ['upload.session.part', { session_id: 'missing', part_number: '1', content_base64: 'YWJj' }],
    ['upload.session.complete', { session_id: 'missing' }],
  ])('%s fails closed when no transport is configured', async (method, params) => {
    const response = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-workspace-id': 'ws_upload_session_gate', 'x-actor-id': 'merchant-owner' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    })
    const envelope = await response.json() as { error?: { code: string }; data?: unknown }
    expect(envelope.data).toBeNull()
    expect(envelope.error?.code).toBe('UPLOAD_TRANSPORT_NOT_CONFIGURED')
  })
})
