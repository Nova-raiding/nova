import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import { handleSyncJobRoute, type SyncJobRouteDependencies } from './http-sync-job-routes.js'

describe('sync job progress callback input validation', () => {
  it.each([
    ['missing', undefined],
    ['null', null],
    ['boolean', true],
    ['zero', 0],
    ['negative', -1],
    ['fractional number', 1.5],
    ['numeric string', '2'],
    ['exponent string', '1e2'],
    ['unsafe integer', Number.MAX_SAFE_INTEGER + 1],
  ])('rejects malformed page_number (%s) for running jobs before any progress side effect', async (_label, pageNumber) => {
    const job = { id: 'job-running', state: 'running', pages: 0, itemsUpserted: 0, itemsFailed: 0, failedItems: [], platform: 'jd', accountId: 'account-a' } as const
    const send = vi.fn()
    const enrichRequestObservation = vi.fn()
    const upsertSyncedProducts = vi.fn()
    const updateSyncJob = vi.fn()
    const persistProgress = vi.fn(async () => undefined)
    const invalidateCanonicalFactsAfterSync = vi.fn(async () => undefined)
    const scanImportedProductRules = vi.fn(async () => undefined)
    const deps = {
      requireWorkerAuthorization: vi.fn(async () => undefined),
      resolveWorkspace: vi.fn(() => 'workspace-a'),
      readBody: vi.fn(async () => ({ ...(pageNumber === undefined ? {} : { page_number: pageNumber }), items: [{ remote_id: 'must-not-upsert', title: '不能写入' }] })),
      service: {
        getSyncJob: vi.fn(() => job),
        upsertSyncedProducts,
        updateSyncJob,
      },
      send,
      enrichRequestObservation,
      invalidateCanonicalFactsAfterSync,
      scanImportedProductRules,
      persistProgress,
    } as unknown as SyncJobRouteDependencies

    await expect(handleSyncJobRoute(
      { method: 'POST' } as IncomingMessage,
      {} as ServerResponse,
      '/v1/sync-jobs/job-running/progress',
      deps,
    )).rejects.toMatchObject({ code: 'INVALID_REQUEST', status: 400 })

    expect(send).not.toHaveBeenCalled()
    expect(enrichRequestObservation).not.toHaveBeenCalled()
    expect(upsertSyncedProducts).not.toHaveBeenCalled()
    expect(invalidateCanonicalFactsAfterSync).not.toHaveBeenCalled()
    expect(scanImportedProductRules).not.toHaveBeenCalled()
    expect(updateSyncJob).not.toHaveBeenCalled()
    expect(persistProgress).not.toHaveBeenCalled()
  })

  it('rejects malformed page_number for terminal jobs before acknowledgement or observation', async () => {
    const job = { id: 'job-terminal', state: 'succeeded' } as const
    const send = vi.fn()
    const enrichRequestObservation = vi.fn()
    const deps = {
      requireWorkerAuthorization: vi.fn(async () => undefined),
      resolveWorkspace: vi.fn(() => 'workspace-a'),
      readBody: vi.fn(async () => ({ page_number: true, items: [] })),
      service: { getSyncJob: vi.fn(() => job) },
      send,
      enrichRequestObservation,
    } as unknown as SyncJobRouteDependencies

    await expect(handleSyncJobRoute(
      { method: 'POST' } as IncomingMessage,
      {} as ServerResponse,
      '/v1/sync-jobs/job-terminal/progress',
      deps,
    )).rejects.toMatchObject({ code: 'INVALID_REQUEST', status: 400 })

    expect(send).not.toHaveBeenCalled()
    expect(enrichRequestObservation).not.toHaveBeenCalled()
  })

  it('continues to acknowledge valid progress replays for terminal jobs', async () => {
    const job = { id: 'job-terminal', state: 'succeeded' } as const
    const send = vi.fn()
    const deps = {
      requireWorkerAuthorization: vi.fn(async () => undefined),
      resolveWorkspace: vi.fn(() => 'workspace-a'),
      readBody: vi.fn(async () => ({ page_number: 1, items: [] })),
      service: { getSyncJob: vi.fn(() => job) },
      send,
      enrichRequestObservation: vi.fn(),
    } as unknown as SyncJobRouteDependencies

    await expect(handleSyncJobRoute(
      { method: 'POST' } as IncomingMessage,
      {} as ServerResponse,
      '/v1/sync-jobs/job-terminal/progress',
      deps,
    )).resolves.toBe(true)

    expect(send).toHaveBeenCalledWith(200, 'workspace-a', job)
  })

  it.each([
    ['terminal', { id: 'job-terminal', state: 'succeeded', pages: 1 }, 1, [null]],
    ['duplicate page', { id: 'job-running', state: 'running', pages: 1 }, 1, undefined],
  ] as const)('rejects malformed items on %s callbacks before acknowledgement', async (_label, job, pageNumber, items) => {
    const send = vi.fn()
    const enrichRequestObservation = vi.fn()
    const deps = {
      requireWorkerAuthorization: vi.fn(async () => undefined),
      resolveWorkspace: vi.fn(() => 'workspace-a'),
      readBody: vi.fn(async () => ({ page_number: pageNumber, ...(items === undefined ? {} : { items }) })),
      service: { getSyncJob: vi.fn(() => job) },
      send,
      enrichRequestObservation,
    } as unknown as SyncJobRouteDependencies

    await expect(handleSyncJobRoute(
      { method: 'POST' } as IncomingMessage,
      {} as ServerResponse,
      `/v1/sync-jobs/${job.id}/progress`,
      deps,
    )).rejects.toMatchObject({ code: 'INVALID_REQUEST', status: 400 })

    expect(send).not.toHaveBeenCalled()
    expect(enrichRequestObservation).not.toHaveBeenCalled()
  })
})
