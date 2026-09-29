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
    const first = await repository.record({ workspaceId: 'ws_action', actionKey: 'model:one', actionKind: 'model_text', settlement: 'included_quota', units: 1, amountFen: 0, actorId: 'merchant', description: '套餐行动额度', settlementStatus: 'authorized' })
    await expect(repository.record({ workspaceId: 'ws_action', actionKey: 'model:one', actionKind: 'model_text', settlement: 'wallet', units: 1, amountFen: 1, actorId: 'other', description: '不应覆盖' })).rejects.toThrow('ACTION_LEDGER_IDEMPOTENCY_CONFLICT')
    await expect(repository.record({ workspaceId: 'ws_action', actionKey: 'model:one', actionKind: 'model_text', settlement: 'included_quota', units: 1, amountFen: 0, actorId: 'merchant', description: '套餐行动额度', settlementStatus: 'authorized' })).resolves.toEqual(first)
    expect(await repository.refund({ workspaceId: 'ws_action', actionKey: 'model:one', reason: 'provider failed' })).toMatchObject({ refunded: true, record: { state: 'refunded', refundReason: 'provider failed' } })
    expect((await repository.refund({ workspaceId: 'ws_action', actionKey: 'model:one', reason: 'retry' })).refunded).toBe(false)
  })

  it('supports zero-cost entitlement settlement separately from wallet settlement', async () => {
    const repository = new MemoryActionLedgerRepository()
    const record = await repository.record({ workspaceId: 'ws_action_entitlement', actionKey: 'image-addon:one', actionKind: 'model_image', settlement: 'entitlement', units: 1, amountFen: 0, actorId: 'merchant', description: '商品主图生成权益' })
    expect(record).toMatchObject({ settlement: 'entitlement', amountFen: 0, state: 'settled' })
  })

  it('pages durable model manual-attention actions by workspace, actor, and stable timestamp/id cursor', async () => {
    const repository = new MemoryActionLedgerRepository()
    const record = (workspaceId: string, actionKey: string, createdAt: string, actorId = 'finance_a', actionKind: 'model_text' | 'other' = 'model_text') => repository.record({ workspaceId, actionKey, actionKind, settlement: 'wallet_overage', units: 1, amountFen: 1, actorId, description: 'fixture', createdAt, settlementStatus: 'manual_attention' })
    const sameTime = '2026-08-28T01:00:00.000Z'
    const older = '2026-08-27T01:00:00.000Z'
    const rows = await Promise.all([
      record('ws_attention', 'a', sameTime),
      record('ws_attention', 'b', sameTime),
      record('ws_attention', 'c', older),
      record('ws_attention', 'other-actor', older, 'finance_b'),
      record('ws_attention', 'other-kind', older, 'finance_a', 'other'),
      record('ws_other', 'other-workspace', sameTime),
    ])

    const first = await repository.listManualAttention({ workspaceId: 'ws_attention', actorId: 'finance_a', limit: 2 })
    expect(first.items).toHaveLength(2)
    expect(first.hasMore).toBe(true)
    expect(first.nextCursor).toEqual({ createdAt: first.items[1]!.createdAt, id: first.items[1]!.id })
    const second = await repository.listManualAttention({ workspaceId: 'ws_attention', actorId: 'finance_a', limit: 2, cursor: first.nextCursor })
    expect(second.hasMore).toBe(false)
    expect(second.items).toHaveLength(1)
    expect([...first.items, ...second.items].map(row => row.actionKey)).toEqual(rows.slice(0, 3).sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt) || right.id.localeCompare(left.id)).map(row => row.actionKey))
    expect([...first.items, ...second.items].every(row => row.workspaceId === 'ws_attention' && row.actorId === 'finance_a' && row.actionKind.startsWith('model_'))).toBe(true)
    await expect(repository.listManualAttention({ workspaceId: '', limit: 10 })).rejects.toThrow('workspace scope is required')
    await expect(repository.listManualAttention({ workspaceId: 'ws_attention', limit: 101 })).rejects.toThrow(RangeError)
    await expect(repository.listManualAttention({ workspaceId: 'ws_attention', cursor: { createdAt: 'invalid', id: 'a' } })).rejects.toThrow('ACTION_LEDGER_CURSOR_INVALID')
  })

  it('keeps Memory microsecond ordering aligned with its keyset cursor', async () => {
    const repository = new MemoryActionLedgerRepository()
    const rows = [
      { actionKey: 'micro-123456', createdAt: '2026-08-28T01:00:00.123456Z' },
      { actionKey: 'micro-123789', createdAt: '2026-08-28T01:00:00.123789Z' },
      { actionKey: 'micro-123455', createdAt: '2026-08-28T01:00:00.123455Z' },
    ]
    for (const row of rows) await repository.record({ workspaceId: 'ws_micro_cursor', ...row, actionKind: 'model_text', settlement: 'wallet_overage', units: 1, amountFen: 1, actorId: 'finance_a', description: 'fixture', settlementStatus: 'manual_attention' })
    const first = await repository.listManualAttention({ workspaceId: 'ws_micro_cursor', limit: 1 })
    const second = await repository.listManualAttention({ workspaceId: 'ws_micro_cursor', cursor: first.nextCursor, limit: 1 })
    const third = await repository.listManualAttention({ workspaceId: 'ws_micro_cursor', cursor: second.nextCursor, limit: 1 })
    expect([first.items[0]?.actionKey, second.items[0]?.actionKey, third.items[0]?.actionKey]).toEqual(['micro-123789', 'micro-123456', 'micro-123455'])
    expect([first, second, third].map(page => page.hasMore)).toEqual([true, true, false])
  })

  it('scans only aged pending model receipts in oldest-first order, independent of unrelated ledger volume', async () => {
    const repository = new MemoryActionLedgerRepository()
    const insert = (workspaceId: string, actionKey: string, createdAt: string, actionKind: 'model_text' | 'other', settlementStatus: 'pending_receipt' | 'settled' = 'pending_receipt') => repository.record({ workspaceId, actionKey, createdAt, actionKind, settlement: 'included_quota', units: 1, amountFen: 0, actorId: 'merchant', description: 'fixture', settlementStatus })
    for (let index = 0; index < 1200; index += 1) await insert('ws_orphan_scan', `unrelated_${index}`, '2026-08-28T00:00:00.000Z', 'other', 'settled')
    await insert('ws_orphan_scan', 'recent_pending', '2026-09-29T00:00:00.000Z', 'model_text')
    await insert('ws_orphan_scan', 'aged_newer', '2026-09-28T00:00:00.000Z', 'model_text')
    await insert('ws_orphan_scan', 'aged_oldest', '2026-09-27T00:00:00.000Z', 'model_text')
    await insert('ws_other_orphan_scan', 'foreign', '2026-09-26T00:00:00.000Z', 'model_text')

    const rows = await repository.listPendingReceiptActions({ workspaceId: 'ws_orphan_scan', before: '2026-09-29T00:00:00.000Z', limit: 1 })
    expect(rows.map(row => row.actionKey)).toEqual(['aged_oldest'])
    await expect(repository.listPendingReceiptActions({ workspaceId: 'ws_orphan_scan', before: 'invalid' })).rejects.toThrow('ACTION_LEDGER_CUTOFF_INVALID')
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

  it('does not settle a refunded provider action', async () => {
    const repository = new MemoryActionLedgerRepository()
    await repository.record({ workspaceId: 'ws_action', actionKey: 'model:refunded', actionKind: 'model_text', settlement: 'included_quota', units: 1, amountFen: 0, actorId: 'merchant', description: '套餐行动额度', settlementStatus: 'authorized' })
    await repository.refund({ workspaceId: 'ws_action', actionKey: 'model:refunded', reason: 'provider 调用前失败' })
    await expect(repository.settleProviderUsage({ workspaceId: 'ws_action', actionKey: 'model:refunded', providerRequestId: 'relay_late', actualAmountFen: 0 })).rejects.toBeInstanceOf(ActionLedgerSettlementConflictError)
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

  it('queries aged pending model receipts oldest-first without a generic ledger window', async () => {
    const client = new RecordingClient()
    client.enqueue(); client.enqueue(); client.enqueue([postgresRow({ settlement_status: 'pending_receipt' })]); client.enqueue()
    const rows = await new PostgresActionLedgerRepository(new RecordingPool(client)).listPendingReceiptActions({ workspaceId: 'ws_action', before: '2026-09-28T00:00:00.000Z', limit: 37 })
    expect(rows).toHaveLength(1)
    const query = client.calls.find(call => call.text.includes("settlement_status='pending_receipt'"))
    expect(query?.text).toMatch(/a\.workspace_id=\$1/u)
    expect(query?.text).toMatch(/a\.action_kind IN \('model_text','model_image','model_ocr','model_video'\)/u)
    expect(query?.text).toMatch(/a\.created_at<\$2::timestamptz/u)
    expect(query?.text).toMatch(/EXISTS \(SELECT 1 FROM creative_point_reservations r WHERE r\.workspace_id=a\.workspace_id AND r\.action_key=a\.action_key AND r\.status='active'\)/u)
    expect(query?.text).toMatch(/NOT EXISTS \(SELECT 1 FROM model_usage_ledger u WHERE u\.workspace_id=a\.workspace_id AND u\.action_id=a\.action_key\)/u)
    expect(query?.text).toMatch(/ORDER BY a\.created_at ASC,a\.id ASC LIMIT \$3/u)
    expect(query?.values).toEqual(['ws_action', '2026-09-28T00:00:00.000Z', 37])
  })

  it('atomically rechecks the active point hold and missing usage row while locking the action', async () => {
    const client = new RecordingClient()
    client.enqueue(); client.enqueue()
    client.enqueue([postgresRow({ created_at: '2026-08-28T01:00:00.000Z', settlement_status: 'pending_receipt' })])
    client.enqueue([{ status: 'active' }])
    client.enqueue([])
    client.enqueue([postgresRow({ created_at: '2026-08-28T01:00:00.000Z', settlement_status: 'manual_attention' })])
    client.enqueue()
    const repository = new PostgresActionLedgerRepository(new RecordingPool(client))

    await expect(repository.markPendingReceiptOrphanForAttention({ workspaceId: 'ws_action', actionKey: 'model:receipt', before: '2026-09-28T00:00:00.000Z' }))
      .resolves.toMatchObject({ actionKey: 'model:receipt', settlementStatus: 'manual_attention' })

    const lock = client.calls.find(call => call.text.includes('FROM action_ledger WHERE workspace_id=$1 AND action_key=$2 FOR UPDATE'))
    const reservation = client.calls.find(call => call.text.includes('FROM creative_point_reservations'))
    const usage = client.calls.find(call => call.text.includes('FROM model_usage_ledger WHERE workspace_id=$1 AND action_id=$2'))
    const update = client.calls.find(call => call.text.startsWith("UPDATE action_ledger SET settlement_status='manual_attention'"))
    expect(lock).toBeDefined()
    expect(reservation?.text).toContain('FOR UPDATE')
    expect(usage?.values).toEqual(['ws_action', 'model:receipt'])
    expect(update?.text).toContain("settlement_status='pending_receipt'")
    expect(client.calls.at(-1)?.text).toBe('COMMIT')
  })

  it('uses tenant/status/actor/cursor predicates before the page limit for manual attention', async () => {
    const client = new RecordingClient()
    client.enqueue(); client.enqueue();
    client.enqueue([postgresRow({ id: 'action_2', created_at: '2026-08-28T01:00:00.123456Z', cursor_created_at: '2026-08-28 01:00:00.123456+00', settlement_status: 'manual_attention' }), postgresRow({ id: 'action_1', created_at: '2026-08-28T01:00:00.123456Z', cursor_created_at: '2026-08-28 01:00:00.123456+00', settlement_status: 'manual_attention' })]);
    client.enqueue()
    const page = await new PostgresActionLedgerRepository(new RecordingPool(client)).listManualAttention({ workspaceId: 'ws_action', actorId: 'finance_a', cursor: { createdAt: '2026-08-29T01:00:00.000Z', id: 'action_3' }, limit: 1 })
    expect(page).toMatchObject({ items: [expect.objectContaining({ settlementStatus: 'manual_attention' })], hasMore: true, nextCursor: { createdAt: '2026-08-28 01:00:00.123456+00', id: 'action_2' } })
    const query = client.calls.find(call => call.text.includes("settlement_status='manual_attention'"))
    expect(query?.text).toMatch(/workspace_id=\$1/u)
    expect(query?.text).toMatch(/action_kind IN \('model_text','model_image','model_ocr','model_video'\)/u)
    expect(query?.text).toMatch(/actor_id=\$2/u)
    expect(query?.text).toMatch(/\(created_at,id\)<\(\$3::timestamptz,\$4::text\)/u)
    expect(query?.text).toMatch(/ORDER BY created_at DESC,id DESC LIMIT \$5/u)
    expect(query?.values).toEqual(['ws_action', 'finance_a', '2026-08-29T01:00:00.000Z', 'action_3', 2])
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
