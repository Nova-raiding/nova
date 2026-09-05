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
  beforeAll(async () => { api = await import('./server.js') })
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
})
