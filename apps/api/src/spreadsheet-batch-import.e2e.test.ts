import { createHash } from 'node:crypto'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'

let api: typeof import('./server.js')

async function start() {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error)
    api.server.once('error', onError)
    api.server.listen(0, '127.0.0.1', () => { api.server.removeListener('error', onError); resolve() })
  })
  const address = api.server.address()
  if (!address || typeof address === 'string') throw new Error('server did not bind')
  return `http://127.0.0.1:${address.port}`
}

describe('spreadsheet batch import API', () => {
  beforeAll(async () => { api = await import('./server.js'); api.enableCommercialFixtureHarnessForTests() })
  afterEach(async () => { if (api.server.listening) await new Promise<void>(resolve => api.server.close(() => resolve())) })

  it('imports products from confirmed parsed CSV facts through the MCP batch entry', async () => {
    const base = await start()
    const workspaceId = `ws_spreadsheet_import_${Date.now()}`
    const actorId = 'spreadsheet-reviewer'
    const store = api.service.registerPlatformAccount({ workspaceId, platform: 'taobao', remoteAccountId: `spreadsheet-store-${Date.now()}`, credentialRef: `fixture-secret/taobao/${workspaceId}` })
    const asset = api.service.registerAsset({ workspaceId, name: 'products.csv', mimeType: 'text/csv', sizeBytes: 64, sha256: `${String(Date.now()).padStart(64, '0')}`, storageKey: `quarantine/${workspaceId}/products.csv`, uploadedByActorId: actorId })
    asset.scanStatus = 'clean'
    asset.scanVerdict = 'clean'
    asset.scanReceiptId = `receipt:${asset.id}`
    asset.scanReceiptDigest = createHash('sha256').update(asset.scanReceiptId).digest('hex')
    asset.storageKey = `clean/${workspaceId}/${asset.id}/source`
    api.service.updateAssetParse({ workspaceId, assetId: asset.id, state: 'succeeded', source: 'manual', confirmedBy: actorId, facts: { format: 'csv', rows: [{ platform: 'platform', title: 'title', account_id: 'account_id' }, { platform: 'taobao', title: '表格外套', account_id: store.id }] } })
    const response = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-workspace-id': workspaceId, 'x-actor-id': actorId, 'x-test-commercial-fixture': 'server-e2e' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'catalog.import.batch', params: { source_asset_id: asset.id } }) })
    const body = await response.json() as { data?: { result?: { count?: number; products?: Array<{ title?: string }> } }; error?: { code?: string } }
    expect(response.status, JSON.stringify(body)).toBe(200)
    expect(body.error).toBeNull()
    expect(body.data?.result).toMatchObject({ count: 1, products: [{ title: '表格外套' }] })
  })

  it('exposes and completes the post-batch product-facts confirmation state machine', async () => {
    const base = await start()
    const workspaceId = `ws_batch_facts_flow_${Date.now()}`
    const actorId = 'batch-facts-reviewer'
    const store = api.service.registerPlatformAccount({ workspaceId, platform: 'taobao', remoteAccountId: `batch-facts-store-${Date.now()}`, credentialRef: `fixture-secret/taobao/${workspaceId}` })
    const headers = { 'content-type': 'application/json', 'x-workspace-id': workspaceId, 'x-actor-id': actorId, 'x-test-commercial-fixture': 'server-e2e' }
    const batchResponse = await fetch(`${base}/mcp`, {
      method: 'POST', headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'catalog.import.batch', params: { products_json: JSON.stringify([
        { platform: 'taobao', account_id: store.id, local_product_key: 'facts-a', title: '事实商品 A', price: 19, stock: 3 },
        { platform: 'taobao', account_id: store.id, local_product_key: 'facts-b', title: '事实商品 B', price: 29, stock: 4 },
      ]) } }),
    })
    const batchBody = await batchResponse.json() as {
      data?: {
        result?: {
          products?: Array<{ id: string; factsConfirmed: boolean; facts_confirmation: { state: string } }>
          factsConfirmationRequired?: boolean
          facts_confirmation?: { state: string; pending_product_ids: string[]; next_actions: Array<{ method: string; params: { product_id: string } }> }
        }
      }
      error?: unknown
    }
    expect(batchResponse.status, JSON.stringify(batchBody)).toBe(200)
    const batch = batchBody.data?.result
    expect(batch).toMatchObject({ factsConfirmationRequired: true, facts_confirmation: { state: 'awaiting_confirmation', pending_product_ids: expect.arrayContaining([expect.any(String)]), next_actions: expect.arrayContaining([expect.objectContaining({ method: 'catalog.facts.confirm' })]) } })
    expect(batch?.products).toEqual(expect.arrayContaining([expect.objectContaining({ factsConfirmed: false, facts_confirmation: expect.objectContaining({ state: 'awaiting_confirmation' }) })]))
    const productId = batch!.products![0]!.id
    const versionBefore = api.service.products.get(productId)!.version

    const confirmResponse = await fetch(`${base}/v1/products/${encodeURIComponent(productId)}/confirm`, { method: 'POST', headers })
    const confirmBody = await confirmResponse.json() as { data?: { factsConfirmed?: boolean; factsConfirmationRequired?: boolean; facts_confirmation?: { state: string; required: boolean }; resumed_task_ids?: string[] }; error?: unknown }
    expect(confirmResponse.status, JSON.stringify(confirmBody)).toBe(200)
    expect(confirmBody.data).toMatchObject({ factsConfirmed: true, factsConfirmationRequired: false, facts_confirmation: { state: 'confirmed', required: false }, resumed_task_ids: [] })
    const versionAfter = api.service.products.get(productId)!.version
    expect(versionAfter).toBe((versionBefore ?? 0) + 1)

    const retryResponse = await fetch(`${base}/v1/products/${encodeURIComponent(productId)}/confirm`, { method: 'POST', headers })
    const retryBody = await retryResponse.json() as { data?: { factsConfirmed?: boolean; version?: number; facts_confirmation?: { state: string } }; error?: unknown }
    expect(retryResponse.status, JSON.stringify(retryBody)).toBe(200)
    expect(retryBody.data).toMatchObject({ factsConfirmed: true, version: versionAfter, facts_confirmation: { state: 'confirmed' } })

    const secondId = batch!.products![1]!.id
    const secondConfirm = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'catalog.facts.confirm', params: { product_id: secondId } }) })
    const secondBody = await secondConfirm.json() as { data?: { result?: { factsConfirmed?: boolean; factsConfirmationRequired?: boolean; facts_confirmation?: { state: string } } }; error?: unknown }
    expect(secondConfirm.status, JSON.stringify(secondBody)).toBe(200)
    expect(secondBody.data?.result).toMatchObject({ factsConfirmed: true, factsConfirmationRequired: false, facts_confirmation: { state: 'confirmed' } })
  })
})
