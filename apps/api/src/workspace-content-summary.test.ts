import { describe, expect, it, vi } from 'vitest'
import type { IncomingMessage } from 'node:http'
import { workspaceContentSummary, type WorkspaceContentSummaryDependencies } from './workspace-content-summary.js'

const request = {} as IncomingMessage
function fixture() {
  return {
    service: {
      listProducts: vi.fn(() => [{ id: 'candidate' }, { id: 'hidden' }]),
      listTasks: vi.fn(() => [{ id: 'draft', brandId: 'allowed' }, { id: 'hidden', brandId: 'other' }, { id: 'unbound' }]),
      listAssets: vi.fn(() => [
        { id: 'ready-unscanned', scanStatus: 'unscanned', readiness: { status: 'ready' } },
        { id: 'deleted', readiness: { status: 'ready' } },
        { id: 'hidden', readiness: { status: 'ready' } },
        { id: 'draft', readiness: { status: 'draft' } },
      ]),
    },
    accessibleTaskBrandIds: vi.fn(async () => ['allowed']),
    accessibleProductIds: vi.fn(async () => new Set(['candidate'])),
    accessibleAssetIds: vi.fn(async () => new Set(['ready-unscanned', 'deleted', 'draft'])),
    filterActiveAssets: vi.fn(async (_workspace: string, assets: Array<{ id: string }>) => assets.filter(asset => asset.id !== 'deleted')),
  }
}

describe('workspace content summary', () => {
  it('includes unbound candidate tasks for workspace-wide members without a store requirement', async () => {
    const deps = { ...fixture(),
      accessibleTaskBrandIds: vi.fn(async () => undefined),
      accessibleProductIds: vi.fn(async () => undefined),
      accessibleAssetIds: vi.fn(async () => undefined),
    }
    expect(await workspaceContentSummary(request, 'ws_one', deps as unknown as WorkspaceContentSummaryDependencies))
      .toEqual({ scope: 'visible_workspace', products: 2, tasks: 3, assets: 3, readyAssets: 2 })
  })

  it('counts visible candidates and active assets with the configured readiness projection', async () => {
    const deps = fixture()
    expect(await workspaceContentSummary(request, 'ws_one', deps as unknown as WorkspaceContentSummaryDependencies))
      .toEqual({ scope: 'visible_workspace', products: 1, tasks: 1, assets: 2, readyAssets: 1 })
    expect(deps.service.listTasks).toHaveBeenCalledWith('ws_one')
  })

  it('uses durable totals instead of stale in-memory products and tasks, with brand scope before pagination', async () => {
    const deps = { ...fixture(), business: {
      listProductsPage: vi.fn(async () => ({ total: 25, items: [] })),
      listTasksPage: vi.fn(async () => ({ total: 8, items: [] })),
    } }
    const result = await workspaceContentSummary(request, 'ws_one', deps as unknown as WorkspaceContentSummaryDependencies)
    expect(result).toMatchObject({ products: 25, tasks: 8, assets: 2, readyAssets: 1 })
    for (const method of [deps.business.listProductsPage, deps.business.listTasksPage]) {
      expect(method).toHaveBeenCalledWith('ws_one', { limit: 1, offset: 0, accessibleBrandIds: ['allowed'] })
    }
    expect(deps.service.listProducts).not.toHaveBeenCalled()
    expect(deps.service.listTasks).not.toHaveBeenCalled()
  })

  it('does not turn an empty grant set into workspace-wide access', async () => {
    const deps = fixture()
    deps.accessibleTaskBrandIds.mockResolvedValue([])
    deps.accessibleProductIds.mockResolvedValue(new Set())
    deps.accessibleAssetIds.mockResolvedValue(new Set())
    expect(await workspaceContentSummary(request, 'ws_one', deps as unknown as WorkspaceContentSummaryDependencies))
      .toMatchObject({ products: 0, tasks: 0, assets: 0, readyAssets: 0 })
  })

  it('propagates scope failures instead of returning zero or unfiltered counts', async () => {
    const deps = fixture()
    deps.accessibleTaskBrandIds.mockRejectedValue(new Error('scope unavailable'))
    await expect(workspaceContentSummary(request, 'ws_one', deps as unknown as WorkspaceContentSummaryDependencies)).rejects.toThrow('scope unavailable')
    expect(deps.service.listAssets).not.toHaveBeenCalled()
  })
})
