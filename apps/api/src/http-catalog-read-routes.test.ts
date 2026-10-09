import type { IncomingMessage, ServerResponse } from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import { ERROR_CODES } from '../../../packages/contracts/src/index.js'
import type { MerchantService, Product, Task } from '../../../packages/application/src/service.js'
import { handleHttpCatalogReadRoute } from './http-catalog-read-routes.js'

function dependencies() {
  return {
    service: {
      listProducts: vi.fn((): Product[] => []),
      listTasks: vi.fn((_workspaceId: string, _filters: NonNullable<Parameters<MerchantService['listTasks']>[1]> = {}): Task[] => []),
    },
    business: { listProductsPage: vi.fn(async (_workspaceId: string, _options: Record<string, unknown>) => ({ items: [], total: 0, limit: 20, offset: 0 })), listTasksPage: vi.fn() },
    resolveWorkspace: vi.fn(() => 'workspace-a'),
    accessibleTaskBrandIds: vi.fn(async () => undefined),
    accessibleProductIds: vi.fn(async () => undefined),
    filterByTaskBrandAccess: vi.fn(async (_req: IncomingMessage, _workspaceId: string, tasks: Task[]) => tasks),
    send: vi.fn(),
  }
}

describe('HTTP catalog search query contract', () => {
  it('rejects malformed facts_confirmed before resolving workspace or querying data', async () => {
    const deps = dependencies()
    await expect(handleHttpCatalogReadRoute(
      { method: 'GET' } as IncomingMessage,
      {} as ServerResponse,
      '/v1/products',
      new URL('http://localhost/v1/products?facts_confirmed=maybe'),
      deps,
    )).rejects.toMatchObject({ code: ERROR_CODES.INVALID_REQUEST, status: 400 })

    expect(deps.resolveWorkspace).not.toHaveBeenCalled()
    expect(deps.business.listProductsPage).not.toHaveBeenCalled()
    expect(deps.service.listProducts).not.toHaveBeenCalled()
  })

  it.each([['true', true], ['false', false]])('passes facts_confirmed=%s as boolean', async (value, expected) => {
    const deps = dependencies()
    await handleHttpCatalogReadRoute(
      { method: 'GET' } as IncomingMessage,
      {} as ServerResponse,
      '/v1/products',
      new URL(`http://localhost/v1/products?facts_confirmed=${value}`),
      deps,
    )
    expect(deps.business.listProductsPage).toHaveBeenCalledWith('workspace-a', expect.objectContaining({ factsConfirmed: expected }))
  })

  it.each([['true', true], ['false', false]])('filters service fallback products by facts_confirmed=%s', async (value, expected) => {
    const deps = { ...dependencies(), business: undefined }
    deps.service.listProducts.mockReturnValue([
      { id: 'confirmed', workspaceId: 'workspace-a', platform: 'taobao', storeName: 'store', title: 'Confirmed', skuCount: 1, stock: 1, factsConfirmed: true, source: 'fixture', updatedAt: '2026-10-01T00:00:00.000Z' },
      { id: 'unconfirmed', workspaceId: 'workspace-a', platform: 'taobao', storeName: 'store', title: 'Unconfirmed', skuCount: 1, stock: 1, factsConfirmed: false, source: 'fixture', updatedAt: '2026-10-01T00:00:00.000Z' },
    ])

    await handleHttpCatalogReadRoute(
      { method: 'GET' } as IncomingMessage,
      {} as ServerResponse,
      '/v1/products',
      new URL(`http://localhost/v1/products?facts_confirmed=${value}`),
      deps,
    )

    const sentData = vi.mocked(deps.send).mock.calls[0]?.[3] as { items: Product[] }
    expect(sentData.items.map(product => product.factsConfirmed)).toEqual([expected])
  })
})

describe('HTTP task list query contract', () => {
  it.each(['unknown', 'draft,approved'])('rejects invalid state %s before workspace or data access', async state => {
    const deps = dependencies()
    await expect(handleHttpCatalogReadRoute(
      { method: 'GET' } as IncomingMessage,
      {} as ServerResponse,
      '/v1/tasks',
      new URL(`http://localhost/v1/tasks?state=${encodeURIComponent(state)}`),
      deps,
    )).rejects.toMatchObject({ code: ERROR_CODES.INVALID_REQUEST, status: 400 })

    expect(deps.resolveWorkspace).not.toHaveBeenCalled()
    expect(deps.business.listTasksPage).not.toHaveBeenCalled()
    expect(deps.service.listTasks).not.toHaveBeenCalled()
  })

  it('rejects an invalid platform and passes valid state/platform filters to the tenant-scoped page query', async () => {
    const invalidDeps = dependencies()
    await expect(handleHttpCatalogReadRoute(
      { method: 'GET' } as IncomingMessage,
      {} as ServerResponse,
      '/v1/tasks',
      new URL('http://localhost/v1/tasks?platform=other'),
      invalidDeps,
    )).rejects.toMatchObject({ code: ERROR_CODES.INVALID_REQUEST, status: 400 })
    expect(invalidDeps.resolveWorkspace).not.toHaveBeenCalled()

    const deps = dependencies()
    await handleHttpCatalogReadRoute(
      { method: 'GET' } as IncomingMessage,
      {} as ServerResponse,
      '/v1/tasks',
      new URL('http://localhost/v1/tasks?platform=taobao&state=review_required'),
      deps,
    )
    expect(deps.business.listTasksPage).toHaveBeenCalledWith('workspace-a', expect.objectContaining({ platform: 'taobao', state: 'review_required' }))
  })

  it('passes valid task filters through the service fallback and returns the matching tasks', async () => {
    const deps = { ...dependencies(), business: undefined }
    const tasks: Task[] = [
      { id: 'matching', workspaceId: 'workspace-a', productId: 'product-a', platform: 'taobao', state: 'review_required', inputSnapshotId: 'snapshot-a', answers: {}, missingQuestions: [], deferredQuestionIds: [], deferredQuestions: [], version: 1, createdAt: '2026-10-01T00:00:00.000Z' },
      { id: 'other-state', workspaceId: 'workspace-a', productId: 'product-a', platform: 'taobao', state: 'draft', inputSnapshotId: 'snapshot-b', answers: {}, missingQuestions: [], deferredQuestionIds: [], deferredQuestions: [], version: 1, createdAt: '2026-10-01T00:00:00.000Z' },
    ]
    deps.service.listTasks.mockImplementation((_workspaceId, filters = {}) => tasks.filter(task =>
      (!filters.platform || task.platform === filters.platform) && (!filters.state || task.state === filters.state),
    ))

    await handleHttpCatalogReadRoute(
      { method: 'GET' } as IncomingMessage,
      {} as ServerResponse,
      '/v1/tasks',
      new URL('http://localhost/v1/tasks?platform=taobao&state=review_required'),
      deps,
    )

    expect(deps.service.listTasks).toHaveBeenCalledWith('workspace-a', { platform: 'taobao', state: 'review_required' })
    const sentData = vi.mocked(deps.send).mock.calls[0]?.[3] as { items: Task[] }
    expect(sentData.items.map(task => task.state)).toEqual(['review_required'])
  })
})
