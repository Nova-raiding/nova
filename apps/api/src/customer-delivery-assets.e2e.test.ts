import { createHash, randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AssetMetadata } from '../../../packages/application/src/service.js'
import type { CustomerDelivery, CustomerDeliveryVideo } from '../../../packages/persistence/src/customer-delivery-repository.js'
import { server, service } from './server.js'

type Rpc<T = unknown> = {
  data: { result: T } | null
  error: { code: string; details?: Record<string, unknown> } | null
}

const platformToken = 'customer-delivery-assets-test-platform-token'
const actorId = 'customer-delivery-assets-test-operator'
const ownedAssetIds = new Set<string>()
let base = ''
let workspaceId = ''

async function call<T>(method: string, params: Record<string, unknown>) {
  const response = await fetch(`${base}/mcp`, {
    method: 'POST',
    // Platform calls deliberately use only the explicit target workspace, not
    // an x-workspace-id header. The target remains part of the real API contract.
    headers: { authorization: `Bearer ${platformToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method, params: { target_workspace_id: workspaceId, ...params } }),
  })
  return { status: response.status, body: await response.json() as Rpc<T> }
}

function successfulResult<T>(response: Awaited<ReturnType<typeof call<T>>>): T {
  expect(response.status, JSON.stringify(response.body)).toBe(200)
  expect(response.body.error).toBeNull()
  expect(response.body.data).not.toBeNull()
  return response.body.data!.result
}

async function createDelivery() {
  return successfulResult(await call<CustomerDelivery>('ops.customer-delivery.create', { company_name: `资产门禁测试 ${randomUUID()}` }))
}

async function getDelivery(deliveryId: string) {
  return successfulResult(await call<CustomerDelivery>('ops.customer-delivery.get', { delivery_id: deliveryId }))
}

function registerAssetMetadata(targetWorkspace: string, mimeType = 'application/pdf'): AssetMetadata {
  const nonce = randomUUID()
  const extension = mimeType === 'video/mp4' ? 'mp4' : mimeType === 'image/png' ? 'png' : 'pdf'
  const asset = service.registerAsset({
    workspaceId: targetWorkspace,
    name: `registration-gate-fixture-${nonce}.${extension}`,
    mimeType,
    sizeBytes: 128,
    sha256: createHash('sha256').update(nonce).digest('hex'),
    storageKey: `quarantine/${targetWorkspace}/${nonce}/source`,
  })
  ownedAssetIds.add(asset.id)
  return asset
}

/**
 * Synthetic metadata for testing the registration authorization predicate only.
 * No bytes are uploaded, no scanner runs, and no signed receipt is admitted here.
 * These HTTP tests are not evidence of real upload transport or ClamAV scanning.
 */
function markTrustedCleanMetadata(asset: AssetMetadata) {
  asset.storageKey = `clean/${asset.workspaceId}/${asset.id}/source`
  asset.scanStatus = 'clean'
  asset.scanVerdict = 'clean'
  asset.scanReceiptId = `test-only:${asset.id}:${asset.sourceRevision ?? 1}`
  asset.scanReceiptDigest = createHash('sha256').update(`test-only:${asset.id}:${asset.sourceRevision ?? 1}`).digest('hex')
  asset.scanCompletedAt = new Date().toISOString()
  return asset
}

describe('customer delivery asset registration gates over loopback HTTP (synthetic scan metadata)', () => {
  beforeEach(async () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('MCP_AUTHZ_MODE', 'enforce')
    vi.stubEnv('SESSION_ID_HASH_SECRET', 'customer-delivery-assets-test-session-secret')
    vi.stubEnv('API_AUTH_TOKENS', JSON.stringify({
      [platformToken]: { actor_id: actorId, roles: ['platform_ops'], workbenches: ['platform'], workspaces: [] },
    }))
    workspaceId = `ws_delivery_assets_${randomUUID()}`
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error)
      server.once('error', onError)
      server.listen(0, '127.0.0.1', () => { server.removeListener('error', onError); resolve() })
    })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('server did not bind')
    base = `http://127.0.0.1:${address.port}`
  })

  afterEach(async () => {
    try {
      if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()))
    } finally {
      for (const assetId of ownedAssetIds) service.assets.delete(assetId)
      ownedAssetIds.clear()
      vi.unstubAllEnvs()
    }
  })

  it.each(['missing', 'wrong-workspace', 'quarantined', 'legacy-clean-without-receipt'] as const)(
    'rejects an unbound %s contract asset without changing the delivery revision or profile',
    async state => {
      const delivery = await createDelivery()
      let assetRef = `asset_missing_${randomUUID()}`
      if (state !== 'missing') {
        const asset = registerAssetMetadata(state === 'wrong-workspace' ? `${workspaceId}_other` : workspaceId)
        if (state === 'wrong-workspace') markTrustedCleanMetadata(asset)
        if (state === 'legacy-clean-without-receipt') {
          // Deliberately reproduce legacy clean state without scanner receipts.
          asset.scanStatus = 'clean'
          asset.storageKey = `clean/${asset.workspaceId}/${asset.id}/source`
        }
        assetRef = asset.id
      }

      const rejected = await call<CustomerDelivery>('ops.customer-delivery.update', {
        delivery_id: delivery.id,
        expected_revision: String(delivery.revision),
        patch_json: JSON.stringify({ contractRef: assetRef, companyName: '不应保存的名称' }),
      })
      expect(rejected.status).toBe(404)
      expect(rejected.body.error?.code).toBe('CUSTOMER_DELIVERY_UPLOAD_NOT_FOUND')
      expect(await getDelivery(delivery.id)).toEqual(delivery)
    },
  )

  it('rejects current-workspace trusted-clean contract metadata without a delivery upload binding', async () => {
    const delivery = await createDelivery()
    const asset = markTrustedCleanMetadata(registerAssetMetadata(workspaceId))
    const rejected = await call<CustomerDelivery>('ops.customer-delivery.update', {
      delivery_id: delivery.id,
      expected_revision: String(delivery.revision),
      patch_json: JSON.stringify({ contractRef: asset.id }),
    })
    expect(rejected.status).toBe(404)
    expect(rejected.body.error?.code).toBe('CUSTOMER_DELIVERY_UPLOAD_NOT_FOUND')
    expect(await getDelivery(delivery.id)).toEqual(delivery)
  })

  it('rejects an HTTPS contract because an external URL cannot prove upload binding or a clean scan', async () => {
    const delivery = await createDelivery()
    const contractRef = 'https://example.com/external-contract.pdf'
    const rejected = await call<CustomerDelivery>('ops.customer-delivery.update', {
      delivery_id: delivery.id,
      expected_revision: String(delivery.revision),
      patch_json: JSON.stringify({ contractRef }),
    })
    expect(rejected.status).toBe(400)
    expect(rejected.body.error?.code).toBe('INVALID_REQUEST')
    expect(await getDelivery(delivery.id)).toEqual(delivery)
  })

  it('rejects a trusted-clean image as a delivery video without changing the revision or videos', async () => {
    const delivery = await createDelivery()
    const image = markTrustedCleanMetadata(registerAssetMetadata(workspaceId, 'image/png'))
    const rejected = await call<CustomerDeliveryVideo>('ops.customer-delivery.videos.add', {
      delivery_id: delivery.id,
      title: '不是视频的图片',
      asset_ref: image.id,
    })
    expect(rejected.status).toBe(404)
    expect(rejected.body.error?.code).toBe('CUSTOMER_DELIVERY_UPLOAD_NOT_FOUND')
    expect(await getDelivery(delivery.id)).toEqual(delivery)
    expect(successfulResult(await call<{ items: CustomerDeliveryVideo[] }>('ops.customer-delivery.videos.list', { delivery_id: delivery.id })).items).toEqual([])
  })

  it('rejects current-workspace trusted-clean video metadata without a delivery upload binding', async () => {
    const delivery = await createDelivery()
    const asset = markTrustedCleanMetadata(registerAssetMetadata(workspaceId, 'video/mp4'))
    const rejected = await call<CustomerDeliveryVideo>('ops.customer-delivery.videos.add', {
      delivery_id: delivery.id,
      title: '交付视频登记测试',
      asset_ref: asset.id,
      sort_order: '0',
    })
    expect(rejected.status).toBe(404)
    expect(rejected.body.error?.code).toBe('CUSTOMER_DELIVERY_UPLOAD_NOT_FOUND')
    expect(await getDelivery(delivery.id)).toEqual(delivery)
    expect(successfulResult(await call<{ items: CustomerDeliveryVideo[] }>('ops.customer-delivery.videos.list', { delivery_id: delivery.id })).items).toEqual([])
  })
})
