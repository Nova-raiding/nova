import { afterEach, describe, expect, it } from 'vitest'
import { server } from './server.js'

async function start() {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error)
    server.once('error', onError)
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', onError); resolve() })
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('server did not bind')
  return `http://127.0.0.1:${address.port}`
}

afterEach(async () => {
  if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()))
})

describe('MCP envelope validation', () => {
  it.each([
    { label: 'wrong JSON-RPC version', envelope: { jsonrpc: '1.0', id: 1 }, expected: 'jsonrpc must be 2.0' },
    { label: 'missing request id', envelope: { jsonrpc: '2.0' }, expected: 'id must be a string, number, or null' },
    { label: 'object request id', envelope: { jsonrpc: '2.0', id: { attacker: true } }, expected: 'id must be a string, number, or null' },
  ])('rejects $label before dispatching schema-override methods', async ({ envelope, expected }) => {
    const base = await start()
    const response = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-workspace-id': 'ws_demo' },
      body: JSON.stringify({ ...envelope, method: 'catalog.image.review', params: {} }),
    })
    const payload = await response.json() as { error?: { code?: string; message?: string } }

    expect(response.status).toBe(400)
    expect(payload.error?.code).toBe('INVALID_REQUEST')
    expect(payload.error?.message).toContain(expected)
  })
})
