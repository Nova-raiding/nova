import { describe, expect, it, vi } from 'vitest'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { MerchantService } from '../../../packages/application/src/service.js'
import { handleHttpImageGenerationJobRead, type HttpImageGenerationJobReadDependencies } from './http-image-generation-job-read.js'

describe('HTTP image-generation job tenant projection', () => {
  it('rejects malformed encoded job IDs as a client input error', async () => {
    const getImageGenerationJob = vi.fn()
    const dependencies = {
      service: { getImageGenerationJob },
      resolveWorkspace: vi.fn(() => 'workspace-a'),
      hydrateWorkspace: vi.fn(async () => undefined),
    } as unknown as HttpImageGenerationJobReadDependencies

    await expect(handleHttpImageGenerationJobRead(
      { method: 'GET' } as IncomingMessage,
      {} as ServerResponse,
      '/v1/image-generation-jobs/%',
      new URL('http://localhost/v1/image-generation-jobs/%'),
      dependencies,
    )).rejects.toMatchObject({ code: 'INVALID_REQUEST', status: 400 })

    expect(getImageGenerationJob).not.toHaveBeenCalled()
    expect(dependencies.resolveWorkspace).not.toHaveBeenCalled()
    expect(dependencies.hydrateWorkspace).not.toHaveBeenCalled()
  })

  it('does not expose display fields for a product owned by another workspace', async () => {
    const foreignProductId = 'product-owned-by-workspace-b'
    const job = { id: 'job-owned-by-workspace-a', productId: foreignProductId } as never
    const service = {
      listImageGenerationJobs: vi.fn(() => [job]),
      products: new Map([[foreignProductId, {
        id: foreignProductId,
        workspaceId: 'workspace-b',
        title: 'Private product title',
        platform: 'jd',
        storeName: 'Private store name',
      }]]),
    } as unknown as MerchantService
    let responsePayload: unknown
    const dependencies = {
      service,
      resolveWorkspace: () => 'workspace-a',
      hydrateWorkspace: vi.fn(async () => undefined),
      accessibleProductIds: vi.fn(async () => undefined),
      paginationRequest: () => ({ limit: 20, offset: 0 }),
      chargedImageCandidatesReadable: vi.fn(async () => true),
      publicImageJobExecutionProjection: vi.fn(async () => ({ reconciliationRequired: false })),
      publicImageJobForCommercialRead: vi.fn(() => ({ id: 'job-owned-by-workspace-a', productId: foreignProductId })),
      enrichRequestObservation: vi.fn(),
      isExemptUnboundImageCandidateProduct: vi.fn(async () => false),
      enforceProductBrandAccess: vi.fn(async () => undefined),
      demoUnscannedAssetsEnabled: () => false,
      persistSnapshot: vi.fn(async () => undefined),
      imageJobOutputsAreClean: vi.fn(() => true),
      readArchivedGeneratedImages: vi.fn(async () => []),
      respond: vi.fn((_res, _status, _workspaceId, payload) => {
        responsePayload = payload
        return true as const
      }),
    } as unknown as HttpImageGenerationJobReadDependencies

    await handleHttpImageGenerationJobRead(
      { method: 'GET' } as IncomingMessage,
      {} as ServerResponse,
      '/v1/image-generation-jobs',
      new URL('http://localhost/v1/image-generation-jobs'),
      dependencies,
    )

    expect(responsePayload).toMatchObject({ items: [{ productTitle: null, platform: null, storeName: null }] })
    expect(JSON.stringify(responsePayload)).not.toContain('Private product title')
    expect(JSON.stringify(responsePayload)).not.toContain('Private store name')
  })
})
