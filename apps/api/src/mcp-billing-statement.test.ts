import { describe, expect, it, vi } from 'vitest'
import type { ActionLedgerCursor, ActionLedgerPage, ActionLedgerRecord } from '../../../packages/persistence/src/action-ledger-repository.js'
import { billingReconciliationStatement, type BillingStatementDependencies } from './mcp-billing-statement.js'

const action = (overrides: Partial<ActionLedgerRecord> = {}): ActionLedgerRecord => ({
  id: 'internal-id', workspaceId: 'ws_finance', actionKey: 'model:orphan-1', actionKind: 'model_text', settlement: 'wallet_overage', state: 'settled', units: 1,
  amountFen: 500, actorId: 'actor_a', description: 'sensitive internal note', createdAt: '2026-09-01T00:00:00.000Z', providerRequestId: 'provider-secret', contextHash: 'f'.repeat(64),
  settlementStatus: 'manual_attention', ...overrides,
})

function dependencies(overrides: Partial<BillingStatementDependencies> = {}): BillingStatementDependencies {
  return {
    workspaceId: 'ws_finance', params: { limit: '1' }, billingScope: { scope: 'workspace', actorId: 'actor_a' }, canViewProviderCosts: true, storageMode: 'postgres',
    listTransactions: vi.fn(async () => []), listModelUsage: vi.fn(async () => []), listActions: vi.fn(async () => [action()]),
    listManualAttentionActions: vi.fn(async () => ({ items: [action()], hasMore: false } satisfies ActionLedgerPage)),
    balanceFen: vi.fn(async () => 0), walletEffectiveDebitFens: vi.fn(async () => new Map()),
    externalProviderUsageStatement: vi.fn(async () => ({ status: 'balanced' })), paymentProviderReadiness: vi.fn(() => ({ ready: true, reasons: [] })),
    ...overrides,
  }
}

describe('billingReconciliationStatement manual attention history', () => {
  it('returns paged read-only action identifiers without billing or provider secrets', async () => {
    const nextCursor: ActionLedgerCursor = { createdAt: '2026-09-01T00:00:00.000Z', id: 'internal-id' }
    const deps = dependencies({
      listManualAttentionActions: vi.fn(async () => ({ items: [action()], hasMore: true, nextCursor })),
    })
    const result = await billingReconciliationStatement(deps)
    const page = (result.action_ledger as Record<string, unknown>).manual_attention as Record<string, unknown>
    expect(deps.listManualAttentionActions).toHaveBeenCalledWith({ limit: 1 })
    expect(page).toMatchObject({
      items: [{ action_id: 'model:orphan-1', action_kind: 'model_text', settlement_status: 'manual_attention', created_at: '2026-09-01T00:00:00.000Z' }],
      limit: 1,
      has_more: true,
    })
    expect(page.next_cursor).toBe(Buffer.from(JSON.stringify({ v: 1, created_at: nextCursor.createdAt, id: nextCursor.id }), 'utf8').toString('base64url'))
    expect(JSON.stringify(page)).not.toMatch(/amountFen|sensitive internal note|provider-secret|contextHash|actorId/u)

    const preciseCursor = { createdAt: '2026-09-01 00:00:00.123456+00', id: 'microsecond-id' }
    const preciseDeps = dependencies({ params: { manual_attention_cursor: Buffer.from(JSON.stringify({ v: 1, created_at: preciseCursor.createdAt, id: preciseCursor.id }), 'utf8').toString('base64url') } })
    await billingReconciliationStatement(preciseDeps)
    expect(preciseDeps.listManualAttentionActions).toHaveBeenCalledWith({ cursor: preciseCursor, limit: 100 })
  })

  it('filters personal pages by the authenticated actor and rejects malformed cursors', async () => {
    const mine = dependencies({ billingScope: { scope: 'mine', actorId: 'actor_a' } })
    await billingReconciliationStatement(mine)
    expect(mine.listManualAttentionActions).toHaveBeenCalledWith({ actorId: 'actor_a', limit: 1 })

    const invalid = dependencies({ params: { manual_attention_cursor: '../invalid' } })
    await expect(billingReconciliationStatement(invalid)).rejects.toMatchObject({ code: 'MODEL_USAGE_STATEMENT_CURSOR_INVALID', status: 400 })
    expect(invalid.listManualAttentionActions).not.toHaveBeenCalled()
  })
})
