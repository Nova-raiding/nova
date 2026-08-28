import { afterEach, describe, expect, it } from 'vitest'
import { server, service } from './server.js'

type Envelope<T> = { data: T | null; error: { code: string; message: string } | null }

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

describe('historical asset preference API', () => {
  afterEach(async () => { if (server.listening) await new Promise<void>(resolve => server.close(() => resolve())) })

  it('requires merchant reasons and exposes the saved preference through REST and MCP', async () => {
    const base = await start()
    const workspaceId = `ws_asset_preference_${Date.now()}`
    const headers = { 'content-type': 'application/json', 'x-workspace-id': workspaceId, 'x-actor-id': 'merchant-test' }
    const asset = service.registerAsset({ workspaceId, name: '历史主图.png', mimeType: 'image/png', sizeBytes: 9, sha256: '2'.repeat(64), storageKey: `quarantine/${workspaceId}/history.png` })

    const missingReason = await fetch(`${base}/v1/assets/${asset.id}/preference`, { method: 'PUT', headers, body: JSON.stringify({ verdict: 'excellent', reasons: [] }) }).then(response => response.json()) as Envelope<unknown>
    expect(missingReason.error?.code).toBe('ASSET_PREFERENCE_REASON_REQUIRED')

    const saved = await fetch(`${base}/v1/assets/${asset.id}/preference`, { method: 'PUT', headers, body: JSON.stringify({ verdict: 'excellent', reasons: ['主体清晰', '留白合理'], note: '春季上新参考', expected_revision: asset.revision }) }).then(response => response.json()) as Envelope<{ revision: number; preference: { verdict: string; reasons: string[]; updatedBy: string } }>
    expect(saved.error).toBeNull()
    expect(saved.data?.preference).toEqual(expect.objectContaining({ verdict: 'excellent', reasons: ['主体清晰', '留白合理'], updatedBy: 'merchant-test' }))

    const listed = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'asset.list', params: {} }) }).then(response => response.json()) as { data: { result: { assets: Array<{ id: string; preference?: { verdict: string } }> } } }
    expect(listed.data.result.assets.find(item => item.id === asset.id)?.preference?.verdict).toBe('excellent')

    const disliked = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'asset.preference.update', params: { asset_id: asset.id, verdict: 'disliked', reasons_json: '["背景干扰主体"]', expected_revision: String(saved.data?.revision) } }) }).then(response => response.json()) as { data: { result: { preference: { verdict: string; reasons: string[] } } } }
    expect(disliked.data.result.preference).toEqual(expect.objectContaining({ verdict: 'disliked', reasons: ['背景干扰主体'] }))

    const foreign = await fetch(`${base}/v1/assets/${asset.id}/preference`, { method: 'PUT', headers: { ...headers, 'x-workspace-id': `${workspaceId}_other` }, body: JSON.stringify({ verdict: 'excellent', reasons: ['越权'] }) }).then(response => response.json()) as Envelope<unknown>
    expect(foreign.error?.code).toBe('ASSET_NOT_FOUND')
  })
})
