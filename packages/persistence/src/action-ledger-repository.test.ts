import { describe, expect, it } from 'vitest'
import { ActionLedgerSettlementConflictError, MemoryActionLedgerRepository, PostgresActionLedgerRepository } from './action-ledger-repository.js'
import type { SqlClient, SqlPool } from './repository.js'

type Row = Record<string, unknown>

class RecordingClient implements SqlClient {
  readonly calls: Array<{ text: string; values?: readonly unknown[] }> = []
  private readonly responses: Array<{ rows: Row[]; rowCount?: number }> = []
  enqueue(rows: Row[] = [], rowCount?: number) { this.responses.push({ rows, ...(rowCount === undefined ? {} : { rowCount }) }) }
  async query<RowType = Row>(text: string, values?: readonly unknown[]) {
    this.calls.push({ text, values })
    return (this.responses.shift() ?? { rows: [] }) as { rows: RowType[]; rowCount?: number }
  }
  release() {}
}

class RecordingPool implements SqlPool {
  constructor(readonly client: RecordingClient) {}
  async connect() { return this.client }
}

const postgresRow = (overrides: Row = {}) => ({
  id: 'action_1', workspace_id: 'ws_action', action_key: 'model:receipt', action_kind: 'model_text', settlement: 'wallet_overage', state: 'settled', units: 1, amount_fen: 1, actor_id: 'merchant', description: '模型预扣', created_at: '2026-08-28T01:00:00.000Z', task_id: 'task_1', campaign_item_id: 'item_1', context_link_id: 'context_link_1', context_hash: 'a'.repeat(64), provider_request_id: null, reserved_amount_fen: 1, multiplier: '2.5000', settlement_status: 'authorized', refunded_at: null, refund_reason: null, ...overrides,
})

describe('MemoryActionLedgerRepository', () => {
  it('keeps settlement idempotent and records refund state', async () => {
    const repository = new MemoryActionLedgerRepository()
    const first = await repository.record({ workspaceId: 'ws_action', actionKey: 'model:one', actionKind: 'model_text', settlement: 'included_quota', units: 1, amountFen: 0, actorId: 'merchant', description: '套餐行动额度' })
    await expect(repository.record({ workspaceId: 'ws_action', actionKey: 'model:one', actionKind: 'model_text', settlement: 'wallet', units: 1, amountFen: 1, actorId: 'other', description: '不应覆盖' })).rejects.toThrow('ACTION_LEDGER_IDEMPOTENCY_CONFLICT')
    await expect(repository.record({ workspaceId: 'ws_action', actionKey: 'model:one', actionKind: 'model_text', settlement: 'included_quota', units: 1, amountFen: 0, actorId: 'merchant', description: '套餐行动额度' })).resolves.toEqual(first)
    expect(await repository.refund({ workspaceId: 'ws_action', actionKey: 'model:one', reason: 'provider failed' })).toMatchObject({ refunded: true, record: { state: 'refunded', refundReason: 'provider failed' } })
    expect((await repository.refund({ workspaceId: 'ws_action', actionKey: 'model:one', reason: 'retry' })).refunded).toBe(false)
  })

  it('supports zero-cost entitlement settlement separately from wallet settlement', async () => {
    const repository = new MemoryActionLedgerRepository()
    const record = await repository.record({ workspaceId: 'ws_action_entitlement', actionKey: 'image-addon:one', actionKind: 'model_image', settlement: 'entitlement', units: 1, amountFen: 0, actorId: 'merchant', description: '商品主图生成权益' })
    expect(record).toMatchObject({ settlement: 'entitlement', amountFen: 0, state: 'settled' })
  })

  it('updates the wallet action to the provider-reported final amount', async () => {
    const repository = new MemoryActionLedgerRepository()
    await repository.record({ workspaceId: 'ws_action', actionKey: 'model:receipt', actionKind: 'model_text', settlement: 'wallet_overage', units: 1, amountFen: 1, actorId: 'merchant', description: '模型预扣', taskId: 'task_1', providerRequestId: 'relay_1', reservedAmountFen: 1, multiplier: 2.5, settlementStatus: 'authorized' })
    await repository.settleProviderUsage({ workspaceId: 'ws_action', actionKey: 'model:receipt', providerRequestId: 'relay_1', actualAmountFen: 5 })
    await expect(repository.get('ws_action', 'model:receipt')).resolves.toMatchObject({ actionKey: 'model:receipt', taskId: 'task_1', providerRequestId: 'relay_1', reservedAmountFen: 1, multiplier: 2.5, amountFen: 5, settlementStatus: 'settled' })
  })

  it('enriches an idempotent action with queryable task, campaign item, and context associations', async () => {
    const repository = new MemoryActionLedgerRepository()
    const base = { workspaceId: 'ws_action', actionKey: 'model:scoped', actionKind: 'model_text' as const, settlement: 'included_quota' as const, units: 1, amountFen: 0, actorId: 'merchant', description: '模型调用' }
    await repository.record({ ...base, taskId: 'task_1', campaignItemId: 'item_1' })
    const enriched = await repository.record({ ...base, taskId: 'task_1', campaignItemId: 'item_1', contextLinkId: 'context_link_1', contextHash: 'a'.repeat(64) })
    expect(enriched).toMatchObject({ taskId: 'task_1', campaignItemId: 'item_1', contextLinkId: 'context_link_1', contextHash: 'a'.repeat(64) })
    await expect(repository.listByScope({ workspaceId: 'ws_action', taskId: 'task_1', campaignItemId: 'item_1' })).resolves.toEqual([enriched])
    await expect(repository.listByScope({ workspaceId: 'ws_action', contextHash: 'a'.repeat(64) })).resolves.toEqual([enriched])
    await expect(repository.record({ ...base, taskId: 'task_other' })).rejects.toThrow('ACTION_LEDGER_ASSOCIATION_CONFLICT')
    await expect(repository.record({ ...base, contextLinkId: 'context_link_without_hash' })).rejects.toThrow('ACTION_LEDGER_CONTEXT_PAIR_REQUIRED')
    await expect(repository.listByScope({ workspaceId: 'ws_action' })).rejects.toThrow('ACTION_LEDGER_QUERY_SCOPE_REQUIRED')
  })

  it('makes identical provider settlement replay idempotent and rejects conflicts', async () => {
    const repository = new MemoryActionLedgerRepository()
    await repository.record({ workspaceId: 'ws_action', actionKey: 'model:receipt', actionKind: 'model_text', settlement: 'wallet_overage', units: 1, amountFen: 1, actorId: 'merchant', description: '模型预扣', settlementStatus: 'authorized' })
    await repository.settleProviderUsage({ workspaceId: 'ws_action', actionKey: 'model:receipt', providerRequestId: 'relay_1', actualAmountFen: 5 })
    await expect(repository.settleProviderUsage({ workspaceId: 'ws_action', actionKey: 'model:receipt', providerRequestId: 'relay_1', actualAmountFen: 5 })).resolves.toBeUndefined()
    await expect(repository.settleProviderUsage({ workspaceId: 'ws_action', actionKey: 'model:receipt', providerRequestId: 'relay_2', actualAmountFen: 5 })).rejects.toBeInstanceOf(ActionLedgerSettlementConflictError)
    await expect(repository.settleProviderUsage({ workspaceId: 'ws_action', actionKey: 'model:receipt', providerRequestId: 'relay_1', actualAmountFen: 6 })).rejects.toThrow('ACTION_LEDGER_SETTLEMENT_CONFLICT')
    await expect(repository.settleProviderUsage({ workspaceId: 'ws_action', actionKey: 'missing', providerRequestId: 'relay_1', actualAmountFen: 5 })).rejects.toThrow('ACTION_LEDGER_RECORD_NOT_FOUND')
  })

  it('advances authorization status idempotently without skipping state boundaries', async () => {
    const repository = new MemoryActionLedgerRepository()
    await repository.record({ workspaceId: 'ws_action', actionKey: 'model:pending', actionKind: 'model_text', settlement: 'wallet_overage', units: 1, amountFen: 1, actorId: 'merchant', description: '模型预扣', settlementStatus: 'authorized' })
    await expect(repository.transitionSettlementStatus({ workspaceId: 'ws_action', actionKey: 'model:pending', from: ['authorized'], to: 'pending_receipt' })).resolves.toMatchObject({ settlementStatus: 'pending_receipt' })
    await expect(repository.transitionSettlementStatus({ workspaceId: 'ws_action', actionKey: 'model:pending', from: ['authorized'], to: 'pending_receipt' })).resolves.toMatchObject({ settlementStatus: 'pending_receipt' })
    await expect(repository.transitionSettlementStatus({ workspaceId: 'ws_action', actionKey: 'model:pending', from: ['authorized'], to: 'manual_attention' })).rejects.toThrow('ACTION_LEDGER_STATUS_CONFLICT')
  })
})

describe('PostgresActionLedgerRepository', () => {
  it('records and maps provider authorization metadata and supports get', async () => {
    const client = new RecordingClient()
    client.enqueue(); client.enqueue(); client.enqueue([postgresRow({ provider_request_id: 'authorization_1' })]); client.enqueue()
    const repository = new PostgresActionLedgerRepository(new RecordingPool(client))
    await expect(repository.record({ workspaceId: 'ws_action', actionKey: 'model:receipt', actionKind: 'model_text', settlement: 'wallet_overage', units: 1, amountFen: 1, actorId: 'merchant', description: '模型预扣', taskId: 'task_1', campaignItemId: 'item_1', contextLinkId: 'context_link_1', contextHash: 'a'.repeat(64), providerRequestId: 'authorization_1', reservedAmountFen: 1, multiplier: 2.5, settlementStatus: 'authorized' })).resolves.toMatchObject({ taskId: 'task_1', campaignItemId: 'item_1', contextLinkId: 'context_link_1', contextHash: 'a'.repeat(64), providerRequestId: 'authorization_1', reservedAmountFen: 1, multiplier: 2.5, settlementStatus: 'authorized' })
    const insert = client.calls.find(call => call.text.includes('INSERT INTO action_ledger'))
    expect(insert?.values?.slice(10)).toEqual(['task_1', 'item_1', 'context_link_1', 'a'.repeat(64), 'authorization_1', 1, 2.5, 'authorized'])

    const getClient = new RecordingClient()
    getClient.enqueue(); getClient.enqueue(); getClient.enqueue([postgresRow()]); getClient.enqueue()
    await expect(new PostgresActionLedgerRepository(new RecordingPool(getClient)).get('ws_action', 'model:receipt')).resolves.toMatchObject({ taskId: 'task_1', campaignItemId: 'item_1', contextLinkId: 'context_link_1', contextHash: 'a'.repeat(64), reservedAmountFen: 1, multiplier: 2.5 })
  })

  it('queries action associations by normalized scope columns', async () => {
    const client = new RecordingClient()
    client.enqueue(); client.enqueue(); client.enqueue([postgresRow()]); client.enqueue()
    const rows = await new PostgresActionLedgerRepository(new RecordingPool(client)).listByScope({ workspaceId: 'ws_action', taskId: 'task_1', campaignItemId: 'item_1', contextLinkId: 'context_link_1', contextHash: 'a'.repeat(64), limit: 25 })
    expect(rows[0]).toMatchObject({ taskId: 'task_1', campaignItemId: 'item_1', contextLinkId: 'context_link_1' })
    const query = client.calls.find(call => call.text.includes('($2::text IS NULL OR task_id=$2)'))
    expect(query?.values).toEqual(['ws_action', 'task_1', 'item_1', 'context_link_1', 'a'.repeat(64), 25])
  })

  it('locks before first settlement and persists the provider receipt', async () => {
    const client = new RecordingClient()
    client.enqueue(); client.enqueue(); client.enqueue([postgresRow()]); client.enqueue([], 1); client.enqueue()
    await new PostgresActionLedgerRepository(new RecordingPool(client)).settleProviderUsage({ workspaceId: 'ws_action', actionKey: 'model:receipt', providerRequestId: 'relay_1', actualAmountFen: 5 })
    const selectIndex = client.calls.findIndex(call => call.text.includes('FOR UPDATE'))
    const updateIndex = client.calls.findIndex(call => call.text.includes('UPDATE action_ledger SET amount_fen'))
    expect(selectIndex).toBeGreaterThan(-1)
    expect(updateIndex).toBeGreaterThan(selectIndex)
    expect(client.calls[updateIndex]?.values).toEqual(['ws_action', 'model:receipt', 5, 'relay_1'])
  })

  it('treats an identical receipt and amount as an idempotent replay without update', async () => {
    const client = new RecordingClient()
    client.enqueue(); client.enqueue(); client.enqueue([postgresRow({ amount_fen: 5, provider_request_id: 'relay_1', settlement_status: 'settled' })]); client.enqueue()
    await expect(new PostgresActionLedgerRepository(new RecordingPool(client)).settleProviderUsage({ workspaceId: 'ws_action', actionKey: 'model:receipt', providerRequestId: 'relay_1', actualAmountFen: 5 })).resolves.toBeUndefined()
    expect(client.calls.some(call => call.text.includes('UPDATE action_ledger SET amount_fen'))).toBe(false)
  })

  it.each([
    ['a different receipt', 'relay_2', 5],
    ['a different amount', 'relay_1', 6],
  ])('rejects %s instead of overwriting settlement', async (_label, providerRequestId, actualAmountFen) => {
    const client = new RecordingClient()
    client.enqueue(); client.enqueue(); client.enqueue([postgresRow({ amount_fen: 5, provider_request_id: 'relay_1', settlement_status: 'settled' })]); client.enqueue()
    await expect(new PostgresActionLedgerRepository(new RecordingPool(client)).settleProviderUsage({ workspaceId: 'ws_action', actionKey: 'model:receipt', providerRequestId, actualAmountFen })).rejects.toThrow('ACTION_LEDGER_SETTLEMENT_CONFLICT')
    expect(client.calls.some(call => call.text.includes('UPDATE action_ledger SET amount_fen'))).toBe(false)
  })

  it('throws not found after the locked lookup returns no row', async () => {
    const client = new RecordingClient()
    client.enqueue(); client.enqueue(); client.enqueue(); client.enqueue()
    await expect(new PostgresActionLedgerRepository(new RecordingPool(client)).settleProviderUsage({ workspaceId: 'ws_action', actionKey: 'missing', providerRequestId: 'relay_1', actualAmountFen: 5 })).rejects.toThrow('ACTION_LEDGER_RECORD_NOT_FOUND')
  })

  it('persists an allowed settlement status transition', async () => {
    const client = new RecordingClient()
    client.enqueue(); client.enqueue(); client.enqueue([postgresRow({ settlement_status: 'pending_receipt' })]); client.enqueue()
    await expect(new PostgresActionLedgerRepository(new RecordingPool(client)).transitionSettlementStatus({ workspaceId: 'ws_action', actionKey: 'model:receipt', from: ['authorized'], to: 'pending_receipt' })).resolves.toMatchObject({ settlementStatus: 'pending_receipt' })
    expect(client.calls.find(call => call.text.includes('UPDATE action_ledger SET settlement_status'))?.values).toEqual(['ws_action', 'model:receipt', ['authorized'], 'pending_receipt'])
  })
})
