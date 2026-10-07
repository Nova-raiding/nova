import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { MerchantService } from '../../../packages/application/src/service.js'
import type { ObjectMetadata, StoredObject } from '../../../packages/storage/src/index.js'
import { createImageArchiveHelpers } from './image-archive-helpers.js'

// Synthetic JPEG SOF bytes: enough for the production signature/dimension
// parsers, but deliberately not a decodable/provider-produced image. This test
// proves only local archive/readback behavior, never provider output or quality.
function jpegSof(width: number, height: number) {
  return Uint8Array.from([
    0xff, 0xd8, 0xff, 0xc0, 0x00, 0x0b, 0x08,
    (height >> 8) & 0xff, height & 0xff,
    (width >> 8) & 0xff, width & 0xff,
    0x01, 0x01, 0x11, 0x00, 0xff, 0xd9,
  ])
}

function localArchiveHarness(actualBytes: Uint8Array) {
  const workspaceId = 'ws_demo'
  const service = new MerchantService({ allowUnscannedAssets: true })
  const job = service.enqueueImageGeneration({
    workspaceId,
    productId: 'prod_fixture_1',
    size: '1024x1024',
    count: 1,
    idempotencyKey: `archive-readback-${Math.random()}`,
  })
  const storedObjects = new Map<string, StoredObject>()
  const persistAssetSnapshotAndEvent = vi.fn(async () => undefined)
  const compensateStoredAsset = vi.fn(async (_workspace: string, _assetId: string, key: string) => {
    storedObjects.delete(key)
  })
  const helpers = createImageArchiveHelpers({
    service,
    demoUnscannedAssetsEnabled: () => true,
    putQuarantineObject: async ({ workspaceId: targetWorkspace, assetId, body, contentType }) => {
      const key = `quarantine/${targetWorkspace}/${assetId}/candidate-1.jpg`
      const sha256 = createHash('sha256').update(body).digest('hex')
      const createdAt = '2026-10-07T00:00:00.000Z'
      const metadata: ObjectMetadata = {
        key, workspaceId: targetWorkspace, zone: 'quarantine', contentType,
        sizeBytes: body.byteLength, sha256, createdAt,
      }
      storedObjects.set(key, { body: new Uint8Array(body), metadata })
      return metadata
    },
    persistAssetSnapshotAndEvent,
    compensateStoredAsset,
    assetForWorkspace: (targetWorkspace: string, assetId: string) => {
      const asset = service.assets.get(assetId)
      if (!asset || asset.workspaceId !== targetWorkspace) throw new Error('ASSET_NOT_FOUND')
      return asset
    },
    automaticallyScanLocalFixture: async (_targetWorkspace: string, asset) => ({
      asset,
      scanAutomation: {
        state: 'configuration_required' as const,
        mode: 'unconfigured' as const,
        userActionRequired: false,
        message: 'local test fixture keeps the generated asset unscanned',
      },
    }),
    getStoredObjectWithRetry: async (_targetWorkspace: string, key: string) => {
      const object = storedObjects.get(key)
      if (!object) throw new Error('OBJECT_NOT_FOUND')
      return object
    },
  })
  const image = `data:image/jpeg;base64,${Buffer.from(actualBytes).toString('base64')}`
  return { workspaceId, service, job, helpers, image, storedObjects, persistAssetSnapshotAndEvent, compensateStoredAsset }
}

describe('local generated-image archive/readback contract', () => {
  it('returns only the persisted bytes after receipt-backed archive and rejects a size mismatch before readback', async () => {
    const matching = localArchiveHarness(jpegSof(1024, 1024))
    const archived = await matching.helpers.archiveGeneratedImages(matching.workspaceId, matching.job.id, [matching.image])

    expect(archived.archiveState).toBe('archived')
    expect(archived.outputs).toEqual([expect.objectContaining({ assetId: expect.any(String), archiveReceiptId: expect.any(String), archiveReceiptDigest: expect.stringMatching(/^[a-f0-9]{64}$/u), mimeType: 'image/jpeg', sizeBytes: jpegSof(1024, 1024).byteLength })])
    expect(matching.persistAssetSnapshotAndEvent).toHaveBeenCalledWith(
      matching.workspaceId,
      expect.objectContaining({ id: archived.outputs?.[0]?.assetId, scanStatus: 'unscanned', imageDimensions: { width: 1024, height: 1024, sourceRevision: 1, sha256: expect.any(String) } }),
      'asset.generated_unscanned',
      expect.objectContaining({ archive_receipt_id: archived.outputs?.[0]?.archiveReceiptId }),
      expect.any(Object),
    )
    const readback = await matching.helpers.readArchivedGeneratedImages(matching.workspaceId, archived)
    expect(readback).toEqual([matching.image])

    const mismatched = localArchiveHarness(jpegSof(640, 480))
    await expect(mismatched.helpers.archiveGeneratedImages(mismatched.workspaceId, mismatched.job.id, [mismatched.image]))
      .rejects.toMatchObject({ code: 'GENERATED_IMAGE_DIMENSIONS_MISMATCH' })
    expect(mismatched.persistAssetSnapshotAndEvent).not.toHaveBeenCalled()
    expect(mismatched.compensateStoredAsset).toHaveBeenCalledOnce()
    expect(mismatched.storedObjects.size).toBe(0)
    expect(mismatched.service.assets.size).toBe(0)
    const unchangedJob = mismatched.service.getImageGenerationJob(mismatched.workspaceId, mismatched.job.id)
    expect(unchangedJob).toMatchObject({ state: 'queued', archiveState: 'pending' })
    expect(unchangedJob.outputs).toBeUndefined()
  })
})
