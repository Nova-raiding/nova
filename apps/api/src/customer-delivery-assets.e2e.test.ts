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
    'rejects a %s contract asset without changing the delivery revision or profile',
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
      expect(rejected.status).toBe(409)
      expect(rejected.body.error?.code).toBe('CUSTOMER_DELIVERY_CONTRACT_ASSET_NOT_READY')
      expect(await getDelivery(delivery.id)).toEqual(delivery)
    },
  )

  it('saves a current-workspace PDF contract with trusted-clean test metadata and reads it back', async () => {
    const delivery = await createDelivery()
    const asset = markTrustedCleanMetadata(registerAssetMetadata(workspaceId))
    const saved = successfulResult(await call<CustomerDelivery>('ops.customer-delivery.update', {
      delivery_id: delivery.id,
      expected_revision: String(delivery.revision),
      patch_json: JSON.stringify({ contractRef: asset.id }),
    }))
    expect(saved.contractRef).toBe(asset.id)
    expect(saved.revision).toBe(delivery.revision + 1)
    expect(await getDelivery(delivery.id)).toEqual(saved)
  })

  it('rechecks a saved contract when the independent profile-completion endpoint is called after scan trust is revoked', async () => {
    const delivery = await createDelivery()
    const asset = markTrustedCleanMetadata(registerAssetMetadata(workspaceId))
    // Keep payment and every required profile field valid so asset trust is
    // the only reason the subsequent completion request must be rejected.
    const saved = successfulResult(await call<CustomerDelivery>('ops.customer-delivery.update', {
      delivery_id: delivery.id,
      expected_revision: String(delivery.revision),
      patch_json: JSON.stringify({
        contractRef: asset.id,
        contractNumber: 'CONTRACT-RESCAN-TEST',
        paymentStatus: 'paid',
        paymentDate: '2026-09-14',
        projectOwner: '项目负责人',
        supportOwner: '客服负责人',
        plannedGoLiveAt: '2026-10-01T01:00:00.000Z',
      }),
    }))
    expect(saved.contractRef).toBe(asset.id)
    expect(saved.customerProfileStatus).toBe('incomplete')
    expect(saved.revision).toBe(delivery.revision + 1)

    // Synthetic rescan state only, not an actual scanner execution.
    asset.scanStatus = 'quarantined'
    asset.storageKey = `quarantine/${asset.workspaceId}/${asset.id}/source`
    asset.sourceRevision = (asset.sourceRevision ?? 1) + 1
    delete asset.scanReceiptId
    delete asset.scanReceiptDigest
    delete asset.scanVerdict
    delete asset.scanCompletedAt
    delete asset.scanFindings

    const rejected = await call<CustomerDelivery>('ops.customer-delivery.checklist.update', {
      delivery_id: delivery.id,
      checklist_key: 'customer_profile',
      completed: 'true',
      expected_revision: String(saved.revision),
    })
    expect(rejected.status).toBe(409)
    expect(rejected.body.error?.code).toBe('CUSTOMER_DELIVERY_CONTRACT_ASSET_NOT_READY')
    expect(await getDelivery(delivery.id)).toEqual(saved)
  })

  it('still saves an HTTPS contract as an external reference without claiming an asset scan', async () => {
    const delivery = await createDelivery()
    const contractRef = 'https://example.com/external-contract.pdf'
    const saved = successfulResult(await call<CustomerDelivery>('ops.customer-delivery.update', {
      delivery_id: delivery.id,
      expected_revision: String(delivery.revision),
      patch_json: JSON.stringify({ contractRef }),
    }))
    expect(saved.contractRef).toBe(contractRef)
    expect(saved.revision).toBe(delivery.revision + 1)
    expect(await getDelivery(delivery.id)).toEqual(saved)
  })

  it('rejects a trusted-clean image as a delivery video without changing the revision or videos', async () => {
    const delivery = await createDelivery()
    const image = markTrustedCleanMetadata(registerAssetMetadata(workspaceId, 'image/png'))
    const rejected = await call<CustomerDeliveryVideo>('ops.customer-delivery.videos.add', {
      delivery_id: delivery.id,
      title: '不是视频的图片',
      asset_ref: image.id,
    })
    expect(rejected.status).toBe(409)
    expect(rejected.body.error?.code).toBe('CUSTOMER_DELIVERY_VIDEO_ASSET_NOT_READY')
    expect(await getDelivery(delivery.id)).toEqual(delivery)
    expect(successfulResult(await call<{ items: CustomerDeliveryVideo[] }>('ops.customer-delivery.videos.list', { delivery_id: delivery.id })).items).toEqual([])
  })

  it('registers a current-workspace video with trusted-clean test metadata and reads it back', async () => {
    const delivery = await createDelivery()
    const asset = markTrustedCleanMetadata(registerAssetMetadata(workspaceId, 'video/mp4'))
    const saved = successfulResult(await call<CustomerDeliveryVideo>('ops.customer-delivery.videos.add', {
      delivery_id: delivery.id,
      title: '交付视频登记测试',
      asset_ref: asset.id,
      sort_order: '0',
    }))
    expect(saved).toMatchObject({ workspaceId, deliveryId: delivery.id, assetRef: asset.id, title: '交付视频登记测试', sortOrder: 0, uploadedByActorId: actorId })
    const reloaded = await getDelivery(delivery.id)
    expect(reloaded.revision).toBe(delivery.revision + 1)
    expect(reloaded.videos).toEqual([saved])
    expect(successfulResult(await call<{ items: CustomerDeliveryVideo[] }>('ops.customer-delivery.videos.list', { delivery_id: delivery.id })).items).toEqual([saved])
  })
})
