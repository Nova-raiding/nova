import { describe, expect, it, vi } from 'vitest'
import type { FinanceSearchRepository } from '../../../../packages/persistence/src/finance-search-repository.js'
import { FinanceSearchService, FinanceSearchServiceError } from './finance-search-service.js'

const record = {
  id: '=formula', kind: 'recharge_order' as const, workspaceId: 'ws_a', status: 'paid', label: '充值订单', reference: '+channel', amountCny: 10,
  occurredAt: '2026-08-28T00:00:00.000Z', updatedAt: '2026-08-28T00:00:00.000Z', version: 'v1', redacted: true as const,
}

function repository(): FinanceSearchRepository {
  return {
    search: vi.fn(async (access, query) => ({ records: [record], summary: { totalRecords: 1, rechargeOrderCny: 10, subscriptionOrderCny: 0, walletCreditCny: 0, walletDebitCny: 0, walletNetCny: 0, providerCostCny: 0, customerChargeCny: 0, usageUnits: 0, byKind: { recharge_order: 1, wallet_transaction: 0, subscription_order: 0, usage_entry: 0, model_usage: 0 } }, snapshotAt: '2026-08-29T00:00:00.000Z', scope: { role: access.role, workspaceCount: query.workspaceIds?.length ?? 1 } })),
    detail: vi.fn(async () => ({ ...record, attributes: Object.freeze({ 支付渠道: 'alipay' }) })),
    exportRows: vi.fn(async (_access, query) => ({ records: [record], snapshotAt: query.snapshotAt!, truncated: false })),
  }
}

const finance = { actorId: 'finance_1', roles: ['finance'], authorizedWorkspaceIds: ['ws_a'] }

describe('FinanceSearchService', () => {
  it('rejects roles outside the read-only finance policy', async () => {
    const service = new FinanceSearchService(repository())
    await expect(service.search({ actorId: 'support_1', roles: ['support'], authorizedWorkspaceIds: ['ws_a'] }, {})).rejects.toBeInstanceOf(FinanceSearchServiceError)
  })

  it('passes server-authorized workspaces to the repository for finance', async () => {
    const repo = repository()
    const service = new FinanceSearchService(repo)
    await service.search(finance, { workspace_ids: ['ws_a'], limit: 20 })
    expect(repo.search).toHaveBeenCalledWith({ role: 'finance', authorizedWorkspaceIds: ['ws_a'] }, expect.objectContaining({ workspaceIds: ['ws_a'], limit: 20 }))
  })

  it('allows platform_ops to request cross-tenant search without client-supplied workspace scope', async () => {
    const repo = repository()
    const service = new FinanceSearchService(repo)
    await service.search({ actorId: 'ops_1', roles: ['platform_ops'], authorizedWorkspaceIds: [] }, {})
    expect(repo.search).toHaveBeenCalledWith({ role: 'platform_ops' }, expect.objectContaining({ limit: 50 }))
  })

  it('creates deterministic bounded exports and neutralizes spreadsheet formulas', async () => {
    const repo = repository()
    const service = new FinanceSearchService(repo, () => new Date('2026-08-29T00:00:00.000Z'))
    const first = await service.exportCsv(finance, { kinds: ['recharge_order'] })
    const replay = await service.exportCsv(finance, { kinds: ['recharge_order'], snapshot_at: first.snapshotAt })
    expect(first.exportId).toBe(replay.exportId)
    expect(first.csv).toContain("\"'=formula\"")
    expect(first.csv).toContain("\"'+channel\"")
    expect(repo.exportRows).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ snapshotAt: '2026-08-29T00:00:00.000Z' }), 5_000)
  })

  it('validates detail kind and preserves optimistic version checks', async () => {
    const repo = repository()
    const service = new FinanceSearchService(repo)
    await service.detail(finance, { workspaceId: 'ws_a', kind: 'recharge_order', id: 'order_1', expectedVersion: 'v1' })
    expect(repo.detail).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ expectedVersion: 'v1' }))
    await expect(service.detail(finance, { workspaceId: 'ws_a', kind: 'secret' as never, id: 'order_1' })).rejects.toMatchObject({ code: 'FINANCE_SEARCH_INVALID_REQUEST' })
  })
})
