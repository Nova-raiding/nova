import { afterEach, describe, expect, it } from 'vitest'
import { grantContinuousFeatureEntitlementForTests, grantCreativePointsForTests, server, service } from './server.js'

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
    await grantCreativePointsForTests(workspaceId)
    grantContinuousFeatureEntitlementForTests(workspaceId)
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
    const readBack = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'asset.list', params: {} }) }).then(response => response.json()) as { data: { result: { assets: Array<{ id: string; preference?: { verdict: string; reasons: string[]; updatedBy: string } }> } } }
    expect(readBack.data.result.assets.find(item => item.id === asset.id)?.preference).toEqual(expect.objectContaining({ verdict: 'disliked', reasons: ['背景干扰主体'], updatedBy: 'merchant-test' }))

    const foreign = await fetch(`${base}/v1/assets/${asset.id}/preference`, { method: 'PUT', headers: { ...headers, 'x-workspace-id': `${workspaceId}_other` }, body: JSON.stringify({ verdict: 'excellent', reasons: ['越权'] }) }).then(response => response.json()) as Envelope<unknown>
    expect(foreign.error?.code).toBe('ASSET_NOT_FOUND')
  })
})

describe('merchant material category API', () => {
  afterEach(async () => { if (server.listening) await new Promise<void>(resolve => server.close(() => resolve())) })

  it('saves a workspace-scoped editor category with revision checking and returns it from the asset list', async () => {
    const base = await start()
    const workspaceId = `ws_asset_material_category_${Date.now()}`
    await grantCreativePointsForTests(workspaceId)
    grantContinuousFeatureEntitlementForTests(workspaceId)
    const headers = { 'content-type': 'application/json', 'x-workspace-id': workspaceId, 'x-actor-id': 'merchant-editor' }
    const asset = service.registerAsset({ workspaceId, name: '主图.png', mimeType: 'image/png', sizeBytes: 16, sha256: '3'.repeat(64), storageKey: `quarantine/${workspaceId}/main.png` })
    const initialRevision = asset.revision

    const unboundStores = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'platform.store.list', params: {} }) }).then(response => response.json()) as { data?: { result: { items: Array<{ state: string }> } } }
    expect(unboundStores.data?.result.items.length).toBeGreaterThan(0)
    expect(unboundStores.data?.result.items.every(item => item.state !== 'connected')).toBe(true)

    const saved = await fetch(`${base}/v1/assets/${asset.id}/metadata`, { method: 'PUT', headers, body: JSON.stringify({ material_category: '商品主图', expected_revision: initialRevision }) }).then(response => response.json()) as Envelope<{ materialCategory: string; revision: number }>
    expect(saved.error).toBeNull()
    expect(saved.data).toMatchObject({ materialCategory: '商品主图', revision: initialRevision + 1 })

    const listed = await fetch(`${base}/v1/assets`, { headers }).then(response => response.json()) as Envelope<Array<{ id: string; materialCategory?: string }>>
    expect(listed.data?.find(row => row.id === asset.id)?.materialCategory).toBe('商品主图')

    const stale = await fetch(`${base}/v1/assets/${asset.id}/metadata`, { method: 'PUT', headers, body: JSON.stringify({ material_category: '详情页图', expected_revision: initialRevision }) }).then(response => response.json()) as Envelope<unknown>
    expect(stale.error?.code).toBe('VERSION_CONFLICT')
    const mcpUpdated = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'asset.metadata.update', params: { asset_id: asset.id, material_category: 'SKU 图', expected_revision: String(saved.data?.revision) } }) }).then(response => response.json()) as { error?: { code: string }; data?: { result: { materialCategory: string; revision: number } } }
    expect(mcpUpdated.error).toBeNull()
    expect(mcpUpdated.data?.result).toMatchObject({ materialCategory: 'SKU 图', revision: (saved.data?.revision ?? 0) + 1 })
    const mcpListed = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'asset.list', params: {} }) }).then(response => response.json()) as { error?: { code: string }; data?: { result: { assets: Array<{ id: string; materialCategory?: string }> } } }
    expect(mcpListed.error).toBeNull()
    expect(mcpListed.data?.result.assets.find(row => row.id === asset.id)?.materialCategory).toBe('SKU 图')
    const foreign = await fetch(`${base}/v1/assets/${asset.id}/metadata`, { method: 'PUT', headers: { ...headers, 'x-workspace-id': `${workspaceId}_other` }, body: JSON.stringify({ material_category: '详情页图', expected_revision: saved.data?.revision }) }).then(response => response.json()) as Envelope<unknown>
    expect(foreign.error?.code).toBe('ASSET_NOT_FOUND')
  })
})
