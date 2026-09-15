import { describe, expect, it, vi } from 'vitest'
import { BillingOrderIdempotencyConflictError, PostgresBillingRepository, RechargeRefundBalanceUnavailableError, WalletDebitIdempotencyConflictError } from './billing-repository.js'
import type { OutboxEventInput, SqlClient, SqlPool } from './repository.js'

type Row = Record<string, unknown>

class RecordingClient implements SqlClient {
  readonly calls: Array<{ text: string; values?: readonly unknown[] }> = []
  private readonly responses: Array<{ rows: Row[] }> = []
  enqueue(...rows: Row[]) { this.responses.push({ rows }) }
  async query<RowType = Row>(text: string, values?: readonly unknown[]) {
    this.calls.push({ text, values })
    return (this.responses.shift() ?? { rows: [] }) as { rows: RowType[] }
  }
  release() {}
}

class RecordingPool implements SqlPool {
  constructor(readonly client: RecordingClient) {}
  async connect() { return this.client }
}

const debit = { id: 'debit_1', workspace_id: 'ws_wallet', type: 'debit', amount_fen: 1, order_id: 'model:request-1', description: '模型生成调用', created_at: '2026-08-26T01:00:00.000Z' }
const refund = { id: 'refund_1', workspace_id: 'ws_wallet', type: 'refund', amount_fen: 1, order_id: 'refund:model:request-1', description: '模型失败退款（merchant）：provider timeout', created_at: '2026-08-26T01:00:01.000Z' }

describe('PostgresBillingRepository PostgreSQL bigint decoding', () => {
  const pending = { id: 'recharge_bigint', workspace_id: 'ws_wallet', channel: 'alipay', amount_fen: '1000', state: 'pending', payment_mode: 'provider', payment_url: null, provider_trade_id: null, created_at: '2026-08-28T01:00:00.000Z', updated_at: '2026-08-28T01:00:00.000Z' }

  it('replays the same recharge intent when PostgreSQL returns bigint as text', async () => {
    const client = new RecordingClient()
    client.enqueue(); client.enqueue(); client.enqueue(); client.enqueue(pending); client.enqueue()
    const result = await new PostgresBillingRepository(new RecordingPool(client)).createOrder({ id: 'recharge_retry', workspaceId: 'ws_wallet', channel: 'alipay', amountFen: 1000, state: 'pending', paymentMode: 'provider', idempotencyKey: 'same-key' })
    expect(result).toMatchObject({ id: 'recharge_bigint', amountFen: 1000 })
  })

  it('replays the same wallet debit without mistaking the driver type for a changed amount', async () => {
    const client = new RecordingClient()
    client.enqueue(); client.enqueue(); client.enqueue({ ...debit, amount_fen: '1', description: '模型生成调用（merchant）' }); client.enqueue()
    await expect(new PostgresBillingRepository(new RecordingPool(client)).debit({ workspaceId: 'ws_wallet', amountFen: 1, idempotencyKey: 'model:request-1', actorId: 'merchant', description: '模型生成调用' })).resolves.toMatchObject({ amountFen: 1, created: false })
    expect(client.calls.some(call => call.text.includes('INSERT INTO billing_transactions'))).toBe(false)
  })

  it('replays a provider settlement whose original and delta amounts are bigint text', async () => {
    const client = new RecordingClient()
    client.enqueue(); client.enqueue(); client.enqueue(); client.enqueue({ ...debit, amount_fen: '1' }); client.enqueue({ ...debit, id: 'debit_delta', amount_fen: '4', order_id: 'settlement:model:request-1' }); client.enqueue()
    await expect(new PostgresBillingRepository(new RecordingPool(client)).settleDebit({ workspaceId: 'ws_wallet', debitIdempotencyKey: 'model:request-1', finalAmountFen: 5, actorId: 'merchant', description: '模型真实用量结算' })).resolves.toMatchObject({ original: { amountFen: 1 }, delta: { amountFen: 4 } })
    expect(client.calls.some(call => call.text.includes('INSERT INTO billing_transactions'))).toBe(false)
  })

  it('accepts an equal numeric payment callback and returns a numeric domain amount', async () => {
    const client = new RecordingClient()
    client.enqueue(); client.enqueue(); client.enqueue(pending); client.enqueue({ ...pending, state: 'paid', provider_trade_id: 'trade_bigint' }); client.enqueue(); client.enqueue()
    await expect(new PostgresBillingRepository(new RecordingPool(client)).markPaid({ workspaceId: 'ws_wallet', orderId: 'recharge_bigint', providerTradeId: 'trade_bigint', amountFen: 1000, eventSource: 'provider_callback' })).resolves.toMatchObject({ amountFen: 1000, state: 'paid' })
    expect(client.calls.at(-1)?.text).toBe('COMMIT')
  })

  it('emits a numeric amount when a recharge refund completes', async () => {
    const client = new RecordingClient()
    const reservation = { ...debit, amount_fen: '1000', order_id: 'recharge-refund:recharge_bigint:1' }
    client.enqueue(); client.enqueue(); client.enqueue({ ...pending, state: 'paid' }); client.enqueue(reservation); client.enqueue(); client.enqueue(); client.enqueue()
    const appendEvent = vi.fn(async () => undefined)
    await expect(new PostgresBillingRepository(new RecordingPool(client), appendEvent).completeRechargeRefund({ workspaceId: 'ws_wallet', orderId: 'recharge_bigint', reservationKey: reservation.order_id, actorId: 'finance', reason: '客户申请', providerRefundId: 'refund_bigint' })).resolves.toMatchObject({ amountFen: 1000 })
    expect(appendEvent).toHaveBeenCalledWith(client, expect.objectContaining({ payload: expect.objectContaining({ amount_fen: 1000 }) }))
  })

  it('preserves the largest exactly representable amount and a negative wallet balance', async () => {
    const client = new RecordingClient()
    client.enqueue(); client.enqueue(); client.enqueue({ ...debit, amount_fen: String(Number.MAX_SAFE_INTEGER) }); client.enqueue()
    client.enqueue(); client.enqueue(); client.enqueue({ balance_fen: '-100' }); client.enqueue()
    const repository = new PostgresBillingRepository(new RecordingPool(client))
    await expect(repository.listTransactions('ws_wallet')).resolves.toMatchObject([{ amountFen: Number.MAX_SAFE_INTEGER }])
    await expect(repository.balanceFen('ws_wallet')).resolves.toBe(-100)
  })

  it.each([
    [-10, 1],
    [0, 1],
    [20, 20],
    [101, 100],
    [Number.MAX_SAFE_INTEGER, 100],
    [Number.NaN, 20],
  ])('bounds transaction list limit %s to %s before querying SQL', async (limit, expectedLimit) => {
    const client = new RecordingClient()
    client.enqueue()
    client.enqueue()
    client.enqueue({ ...debit })
    client.enqueue()
    await expect(new PostgresBillingRepository(new RecordingPool(client)).listTransactions('ws_wallet', limit)).resolves.toHaveLength(1)
    const listCall = client.calls.find(call => call.text.includes('FROM billing_transactions') && call.text.includes('LIMIT $2'))
    expect(listCall?.values?.[1]).toBe(expectedLimit)
  })

  it.each(['9007199254740993', '-9007199254740993', '1.5', 'invalid', ''])('rejects a database amount that cannot be represented safely: %s', async amount => {
    const client = new RecordingClient()
    client.enqueue(); client.enqueue(); client.enqueue({ ...debit, amount_fen: amount })
    await expect(new PostgresBillingRepository(new RecordingPool(client)).listTransactions('ws_wallet')).rejects.toThrow('BILLING_AMOUNT_INVALID')
    expect(client.calls.at(-1)?.text).toBe('ROLLBACK')
  })

  it('rejects an unsafe aggregate balance before authorizing a new debit', async () => {
    const client = new RecordingClient()
    client.enqueue(); client.enqueue(); client.enqueue(); client.enqueue(); client.enqueue({ balance_fen: '9007199254740993' })
    await expect(new PostgresBillingRepository(new RecordingPool(client)).debit({ workspaceId: 'ws_wallet', amountFen: 1, idempotencyKey: 'unsafe-balance', actorId: 'merchant', description: '模型生成调用' })).rejects.toThrow('BILLING_AMOUNT_INVALID')
    expect(client.calls.some(call => call.text.includes('INSERT INTO billing_transactions'))).toBe(false)
  })

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN])('rejects invalid debit input before starting a transaction: %s', async amountFen => {
    const client = new RecordingClient()
    await expect(new PostgresBillingRepository(new RecordingPool(client)).debit({ workspaceId: 'ws_wallet', amountFen, idempotencyKey: 'invalid-amount', actorId: 'merchant', description: '模型生成调用' })).rejects.toThrow('BILLING_AMOUNT_INVALID')
    expect(client.calls).toHaveLength(0)
  })
})

describe('PostgresBillingRepository model debit reversal', () => {
  it('writes an immutable, idempotent refund keyed to the original debit', async () => {
    const client = new RecordingClient()
    client.enqueue() // BEGIN
    client.enqueue() // tenant scope
    client.enqueue(debit) // original debit
    client.enqueue() // no existing refund
    client.enqueue(refund) // refund insert
    client.enqueue() // COMMIT
    const result = await new PostgresBillingRepository(new RecordingPool(client)).refundDebit({ workspaceId: 'ws_wallet', debitIdempotencyKey: 'model:request-1', actorId: 'merchant', reason: 'provider timeout' })
    expect(result).toMatchObject({ type: 'refund', amountFen: 1, orderId: 'refund:model:request-1' })
    const insert = client.calls.find(call => call.text.includes("INSERT INTO billing_transactions") && call.text.includes("'refund'"))
    expect(insert?.values?.slice(1)).toEqual(['ws_wallet', 1, 'refund:model:request-1', 'merchant', '模型失败退款（merchant）：provider timeout'])
  })

  it('returns an existing reversal without creating a second wallet credit', async () => {
    const client = new RecordingClient()
    client.enqueue(); client.enqueue(); client.enqueue(debit); client.enqueue(refund); client.enqueue()
    const result = await new PostgresBillingRepository(new RecordingPool(client)).refundDebit({ workspaceId: 'ws_wallet', debitIdempotencyKey: 'model:request-1', actorId: 'merchant', reason: 'retry' })
    expect(result.id).toBe('refund_1')
    expect(client.calls.some(call => call.text.includes("INSERT INTO billing_transactions") && call.text.includes("'refund'"))).toBe(false)
  })
})

describe('PostgresBillingRepository wallet debit idempotency', () => {
  it('reports whether the debit was newly created so compensation cannot refund a historical replay', async () => {
    const replayClient = new RecordingClient()
    replayClient.enqueue(); replayClient.enqueue(); replayClient.enqueue({ ...debit, description: '模型生成调用（merchant）' }); replayClient.enqueue()
    await expect(new PostgresBillingRepository(new RecordingPool(replayClient)).debit({ workspaceId: 'ws_wallet', amountFen: 1, idempotencyKey: 'model:request-1', actorId: 'merchant', description: '模型生成调用' })).resolves.toMatchObject({ created: false })

    const createdClient = new RecordingClient()
    createdClient.enqueue(); createdClient.enqueue(); createdClient.enqueue(); createdClient.enqueue(); createdClient.enqueue({ balance_fen: '100' }); createdClient.enqueue({ ...debit, description: '模型生成调用（merchant）' }); createdClient.enqueue()
    await expect(new PostgresBillingRepository(new RecordingPool(createdClient)).debit({ workspaceId: 'ws_wallet', amountFen: 1, idempotencyKey: 'model:request-1', actorId: 'merchant', description: '模型生成调用' })).resolves.toMatchObject({ created: true })
  })

  it('rejects reuse for a different amount or action', async () => {
    const client = new RecordingClient()
    client.enqueue(); client.enqueue(); client.enqueue(debit)

    await expect(new PostgresBillingRepository(new RecordingPool(client)).debit({ workspaceId: 'ws_wallet', amountFen: 99, idempotencyKey: 'model:request-1', actorId: 'merchant', description: '另一项动作' })).rejects.toBeInstanceOf(WalletDebitIdempotencyConflictError)
    expect(client.calls.some(call => call.text.includes('INSERT INTO billing_transactions'))).toBe(false)
  })
})

describe('PostgresBillingRepository provider receipt settlement', () => {
  it('appends only the delta between the one-fen reservation and final charge', async () => {
    const client = new RecordingClient()
    const adjustment = { ...debit, id: 'debit_delta', amount_fen: 4, order_id: 'settlement:model:request-1', description: '模型真实用量结算（merchant）' }
    client.enqueue(); client.enqueue(); client.enqueue(); client.enqueue(debit); client.enqueue(); client.enqueue({ balance_fen: '100' }); client.enqueue(adjustment); client.enqueue()
    const result = await new PostgresBillingRepository(new RecordingPool(client)).settleDebit({ workspaceId: 'ws_wallet', debitIdempotencyKey: 'model:request-1', finalAmountFen: 5, actorId: 'merchant', description: '模型真实用量结算' })
    expect(result.delta).toMatchObject({ type: 'debit', amountFen: 4, orderId: 'settlement:model:request-1' })
    const inserted = client.calls.find(call => call.text.includes('INSERT INTO billing_transactions') && call.values?.includes('settlement:model:request-1'))
    expect(inserted?.values?.slice(1, 5)).toEqual(['ws_wallet', 'debit', 4, 'settlement:model:request-1'])
  })

  it('releases the unused part of a larger reservation as an idempotent refund', async () => {
    const client = new RecordingClient()
    const reserved = { ...debit, amount_fen: 10 }
    const adjustment = { ...refund, id: 'settlement_refund', amount_fen: 6, order_id: 'settlement-refund:model:request-1', description: '模型真实用量结算（merchant）' }
    client.enqueue(); client.enqueue(); client.enqueue(); client.enqueue(reserved); client.enqueue(); client.enqueue(adjustment); client.enqueue()
    const result = await new PostgresBillingRepository(new RecordingPool(client)).settleDebit({ workspaceId: 'ws_wallet', debitIdempotencyKey: 'model:request-1', finalAmountFen: 4, actorId: 'merchant', description: '模型真实用量结算' })
    expect(result.delta).toMatchObject({ type: 'refund', amountFen: 6, orderId: 'settlement-refund:model:request-1' })
  })

  it('returns the existing settlement adjustment when the same final amount is replayed', async () => {
    const client = new RecordingClient()
    const adjustment = { ...debit, id: 'debit_delta', amount_fen: 4, order_id: 'settlement:model:request-1', description: '模型真实用量结算（merchant）' }
    client.enqueue(); client.enqueue(); client.enqueue(); client.enqueue(debit); client.enqueue(adjustment); client.enqueue()
    const result = await new PostgresBillingRepository(new RecordingPool(client)).settleDebit({ workspaceId: 'ws_wallet', debitIdempotencyKey: 'model:request-1', finalAmountFen: 5, actorId: 'merchant', description: '模型真实用量结算' })
    expect(result.delta).toMatchObject({ id: 'debit_delta', amountFen: 4 })
    expect(client.calls.filter(call => call.text.includes('INSERT INTO billing_transactions'))).toHaveLength(0)
  })

  it('rejects a conflicting replay for a different final amount', async () => {
    const client = new RecordingClient()
    const priorAdjustment = { ...debit, id: 'debit_delta', amount_fen: 4, order_id: 'settlement:model:request-1' }
    client.enqueue(); client.enqueue(); client.enqueue(); client.enqueue(debit); client.enqueue(priorAdjustment)
    await expect(new PostgresBillingRepository(new RecordingPool(client)).settleDebit({ workspaceId: 'ws_wallet', debitIdempotencyKey: 'model:request-1', finalAmountFen: 6, actorId: 'merchant', description: '模型真实用量结算' })).rejects.toBeInstanceOf(WalletDebitIdempotencyConflictError)
  })

  it('does not write a delta when the final amount equals the reservation', async () => {
    const client = new RecordingClient()
    client.enqueue(); client.enqueue(); client.enqueue(); client.enqueue(debit); client.enqueue()
    const result = await new PostgresBillingRepository(new RecordingPool(client)).settleDebit({ workspaceId: 'ws_wallet', debitIdempotencyKey: 'model:request-1', finalAmountFen: 1, actorId: 'merchant', description: '模型真实用量结算' })
    expect(result.delta).toBeUndefined()
    expect(client.calls.some(call => call.text.includes('INSERT INTO billing_transactions'))).toBe(false)
  })

  it('does not write an extra debit when the wallet cannot cover the settlement delta', async () => {
    const client = new RecordingClient()
    client.enqueue(); client.enqueue(); client.enqueue(); client.enqueue(debit); client.enqueue(); client.enqueue({ balance_fen: '0' })
    await expect(new PostgresBillingRepository(new RecordingPool(client)).settleDebit({ workspaceId: 'ws_wallet', debitIdempotencyKey: 'model:request-1', finalAmountFen: 5, actorId: 'merchant', description: '模型真实用量结算' })).rejects.toThrow('BILLING_INSUFFICIENT_BALANCE')
    expect(client.calls.some(call => call.text.includes('INSERT INTO billing_transactions'))).toBe(false)
  })
})

describe('PostgresBillingRepository recharge order idempotency', () => {
  it('rejects reuse for a different payment intent', async () => {
    const client = new RecordingClient()
    client.enqueue(); client.enqueue(); client.enqueue() // BEGIN, tenant scope, insert conflict
    client.enqueue({ id: 'recharge_1', workspace_id: 'ws_wallet', channel: 'alipay', amount_fen: 1000, state: 'pending', payment_mode: 'provider', payment_url: 'https://pay.example/1', provider_trade_id: null, created_at: '2026-08-26T01:00:00.000Z', updated_at: '2026-08-26T01:00:00.000Z' })
    await expect(new PostgresBillingRepository(new RecordingPool(client)).createOrder({ id: 'recharge_2', workspaceId: 'ws_wallet', channel: 'wechat', amountFen: 2000, state: 'pending', paymentMode: 'provider', idempotencyKey: 'same-key' })).rejects.toBeInstanceOf(BillingOrderIdempotencyConflictError)
    expect(client.calls.some(call => call.text.includes('INSERT INTO billing_transactions'))).toBe(false)
  })

  it('rejects reuse by a different authenticated member even when the payment fields match', async () => {
    const client = new RecordingClient()
    client.enqueue(); client.enqueue(); client.enqueue()
    client.enqueue({ id: 'recharge_1', workspace_id: 'ws_wallet', channel: 'alipay', amount_fen: 1000, state: 'pending', payment_mode: 'provider', payment_url: 'https://pay.example/1', provider_trade_id: null, created_by_actor_id: 'actor_a', created_at: '2026-08-26T01:00:00.000Z', updated_at: '2026-08-26T01:00:00.000Z' })
    await expect(new PostgresBillingRepository(new RecordingPool(client)).createOrder({ id: 'recharge_2', workspaceId: 'ws_wallet', channel: 'alipay', amountFen: 1000, state: 'pending', paymentMode: 'provider', createdByActorId: 'actor_b', idempotencyKey: 'same-key' })).rejects.toBeInstanceOf(BillingOrderIdempotencyConflictError)
  })
})

describe('PostgresBillingRepository recharge order reporting', () => {
  it('returns newest orders and exact state counts independently of the page limit', async () => {
    const client = new RecordingClient()
    const newest = { id: 'recharge_newest', workspace_id: 'ws_wallet', channel: 'alipay', amount_fen: 1000, state: 'pending', payment_mode: 'provider', payment_url: null, provider_trade_id: null, created_at: '2026-08-28T01:00:00.000Z', updated_at: '2026-08-28T01:00:00.000Z' }
    client.enqueue(); client.enqueue(); client.enqueue(newest); client.enqueue()
    const repository = new PostgresBillingRepository(new RecordingPool(client))
    expect(await repository.listOrders('ws_wallet', ['pending'], 10)).toMatchObject([{ id: 'recharge_newest' }])
    const listCall = client.calls.find(call => call.text.includes('FROM billing_orders') && call.text.includes('LIMIT $3'))
    expect(listCall?.text).toContain('ORDER BY created_at DESC,id DESC')

    client.enqueue(); client.enqueue(); client.enqueue({ state: 'pending', count: '101' }, { state: 'paid', count: '7' }); client.enqueue()
    await expect(repository.countOrdersByState('ws_wallet')).resolves.toEqual({ pending: 101, paid: 7, closed: 0, failed: 0 })
  })

  it('uses a least-recently-checked provider-only queue for automated reconciliation', async () => {
    const client = new RecordingClient()
    const pending = { id: 'recharge_oldest', workspace_id: 'ws_wallet', channel: 'alipay', amount_fen: 1000, state: 'pending', payment_mode: 'provider', payment_url: null, provider_trade_id: null, created_at: '2026-08-28T01:00:00.000Z', updated_at: '2026-08-28T01:00:00.000Z' }
    client.enqueue(); client.enqueue(); client.enqueue(pending); client.enqueue()
    await expect(new PostgresBillingRepository(new RecordingPool(client)).listPendingProviderOrdersForReconciliation('ws_wallet', 7)).resolves.toMatchObject([{ id: 'recharge_oldest' }])
    const query = client.calls.find(call => call.text.includes("payment_mode='provider'") && call.text.includes('ORDER BY updated_at,created_at,id'))
    expect(query?.values).toEqual(['ws_wallet', 7])
  })
})

describe('PostgresBillingRepository recharge settlement atomicity', () => {
  it('rejects a callback without a provider trade id before changing the order', async () => {
    const client = new RecordingClient()
    const repository = new PostgresBillingRepository(new RecordingPool(client))

    await expect(repository.markPaid({ workspaceId: 'ws_wallet', orderId: 'recharge_1', providerTradeId: '  ', amountFen: 1000, eventSource: 'provider_callback' })).rejects.toThrow('billing callback provider trade id required')
    expect(client.calls).toHaveLength(0)
  })

  it('appends the paid outbox event inside the same transaction as the order and wallet credit', async () => {
    const client = new RecordingClient()
    const pending = { id: 'recharge_1', workspace_id: 'ws_wallet', channel: 'alipay', amount_fen: 1000, state: 'pending', payment_mode: 'provider', payment_url: null, provider_trade_id: null, created_at: '2026-08-28T01:00:00.000Z', updated_at: '2026-08-28T01:00:00.000Z' }
    const paid = { ...pending, state: 'paid', provider_trade_id: 'trade_1' }
    client.enqueue(); client.enqueue(); client.enqueue(pending); client.enqueue(paid); client.enqueue(); client.enqueue()
    const appendEvent = vi.fn(async (transactionClient, event) => {
      expect(transactionClient).toBe(client)
      expect(event).toMatchObject({ workspaceId: 'ws_wallet', aggregateId: 'recharge_1', eventType: 'billing.recharge.paid', payload: { source: 'provider_callback' } })
    })
    const result = await new PostgresBillingRepository(new RecordingPool(client), appendEvent).markPaid({ workspaceId: 'ws_wallet', orderId: 'recharge_1', providerTradeId: 'trade_1', amountFen: 1000, eventSource: 'provider_callback' })
    expect(result).toMatchObject({ state: 'paid', providerTradeId: 'trade_1' })
    expect(appendEvent).toHaveBeenCalledOnce()
    expect(client.calls.at(-1)?.text).toBe('COMMIT')
  })

  it('rolls back the paid order and wallet credit when the outbox append fails', async () => {
    const client = new RecordingClient()
    const pending = { id: 'recharge_1', workspace_id: 'ws_wallet', channel: 'alipay', amount_fen: 1000, state: 'pending', payment_mode: 'provider', payment_url: null, provider_trade_id: null, created_at: '2026-08-28T01:00:00.000Z', updated_at: '2026-08-28T01:00:00.000Z' }
    client.enqueue(); client.enqueue(); client.enqueue(pending); client.enqueue({ ...pending, state: 'paid', provider_trade_id: 'trade_1' }); client.enqueue(); client.enqueue()
    const repository = new PostgresBillingRepository(new RecordingPool(client), async () => { throw new Error('outbox unavailable') })
    await expect(repository.markPaid({ workspaceId: 'ws_wallet', orderId: 'recharge_1', providerTradeId: 'trade_1', amountFen: 1000, eventSource: 'provider_callback' })).rejects.toThrow('outbox unavailable')
    expect(client.calls.at(-1)?.text).toBe('ROLLBACK')
    expect(client.calls.some(call => call.text === 'COMMIT')).toBe(false)
  })

  it('keeps a provider terminal transition and its reconciliation outbox evidence atomic', async () => {
    const client = new RecordingClient()
    const terminal = { id: 'recharge_terminal', workspace_id: 'ws_wallet', channel: 'alipay', amount_fen: 1000, state: 'failed', payment_mode: 'provider', payment_url: null, provider_trade_id: null, created_at: '2026-08-28T01:00:00.000Z', updated_at: '2026-08-28T01:01:00.000Z' }
    client.enqueue(); client.enqueue(); client.enqueue(terminal); client.enqueue()
    const appendEvent = vi.fn(async (_transactionClient, event) => {
      expect(_transactionClient).toBe(client)
      expect(event).toMatchObject({ eventType: 'billing.recharge.reconciled', payload: { order_id: terminal.id, state: 'failed', source: 'provider_reconciliation' } })
      throw new Error('outbox unavailable')
    })

    await expect(new PostgresBillingRepository(new RecordingPool(client), appendEvent).markProviderState({ workspaceId: 'ws_wallet', orderId: terminal.id, state: 'failed', eventSource: 'provider_reconciliation' })).rejects.toThrow('outbox unavailable')
    expect(client.calls.some(call => call.text.startsWith('UPDATE billing_orders'))).toBe(true)
    expect(client.calls.at(-1)?.text).toBe('ROLLBACK')
    expect(client.calls.some(call => call.text === 'COMMIT')).toBe(false)
  })
})

describe('PostgresBillingRepository external recharge refund', () => {
  const paidOrder = { id: 'recharge_100', workspace_id: 'ws_wallet', channel: 'wechat', amount_fen: 10_000, state: 'paid', payment_mode: 'provider', payment_url: null, provider_trade_id: 'trade_100', created_at: '2026-08-28T01:00:00.000Z', updated_at: '2026-08-28T01:01:00.000Z' }
  const reservation = { id: 'refund_reservation_1', workspace_id: 'ws_wallet', type: 'debit', amount_fen: 10_000, order_id: 'recharge-refund:recharge_100:1', description: '充值原路退款预留（finance）：客户申请', created_at: '2026-08-28T01:02:00.000Z' }

  it('lists active provider refund reservations without applying transaction-page truncation', async () => {
    const client = new RecordingClient()
    client.enqueue(); client.enqueue(); client.enqueue({
      ...paidOrder,
      reservation_id: reservation.id,
      reservation_type: reservation.type,
      reservation_amount_fen: reservation.amount_fen,
      reservation_order_id: reservation.order_id,
      reservation_actor_id: 'finance',
      reservation_description: reservation.description,
      reservation_created_at: reservation.created_at,
    }); client.enqueue()
    const result = await new PostgresBillingRepository(new RecordingPool(client)).listActiveRechargeRefunds('ws_wallet', 10)
    expect(result).toMatchObject([{ order: { id: 'recharge_100', state: 'paid', paymentMode: 'provider' }, reservation: { id: 'refund_reservation_1', orderId: 'recharge-refund:recharge_100:1', amountFen: 10_000 } }])
    const query = client.calls.find(call => call.text.includes('NOT EXISTS') && call.text.includes("released.order_id='release:' || r.order_id"))
    expect(query?.values).toEqual(['ws_wallet', 10])
    expect(query?.text).toContain('ORDER BY o.updated_at,r.created_at,r.id')
  })

  it('atomically deducts the recharge value instead of crediting the wallet', async () => {
    const client = new RecordingClient()
    client.enqueue(); client.enqueue(); client.enqueue(paidOrder); client.enqueue(); client.enqueue(); client.enqueue(); client.enqueue({ balance_fen: '10000' }); client.enqueue(reservation); client.enqueue()
    const result = await new PostgresBillingRepository(new RecordingPool(client)).reserveRechargeRefund({ workspaceId: 'ws_wallet', orderId: 'recharge_100', actorId: 'finance', reason: '客户申请' })
    expect(result).toMatchObject({ type: 'debit', amountFen: 10_000, orderId: 'recharge-refund:recharge_100:1', created: true, completed: false })
    const insert = client.calls.find(call => call.text.includes('INSERT INTO billing_transactions'))
    expect(insert?.values?.slice(1, 6)).toEqual(['ws_wallet', 10_000, 'recharge-refund:recharge_100:1', 'finance', '充值原路退款预留（finance）：客户申请'])
    expect(insert?.text).toContain("'debit'")
    expect(client.calls.at(-1)?.text).toBe('COMMIT')
  })

  it('rejects a recharge refund when spent funds are unavailable', async () => {
    const client = new RecordingClient()
    client.enqueue(); client.enqueue(); client.enqueue(paidOrder); client.enqueue(); client.enqueue(); client.enqueue(); client.enqueue({ balance_fen: '9999' }); client.enqueue()
    await expect(new PostgresBillingRepository(new RecordingPool(client)).reserveRechargeRefund({ workspaceId: 'ws_wallet', orderId: 'recharge_100', actorId: 'finance', reason: '客户申请' })).rejects.toBeInstanceOf(RechargeRefundBalanceUnavailableError)
    expect(client.calls.some(call => call.text.includes('INSERT INTO billing_transactions'))).toBe(false)
    expect(client.calls.at(-1)?.text).toBe('ROLLBACK')
  })

  it('reuses an active reservation so duplicate retries cannot double-adjust', async () => {
    const client = new RecordingClient()
    client.enqueue(); client.enqueue(); client.enqueue(paidOrder); client.enqueue(reservation); client.enqueue(); client.enqueue()
    const result = await new PostgresBillingRepository(new RecordingPool(client)).reserveRechargeRefund({ workspaceId: 'ws_wallet', orderId: 'recharge_100', actorId: 'finance', reason: '重复请求' })
    expect(result).toMatchObject({ id: 'refund_reservation_1', created: false, completed: false })
    expect(client.calls.some(call => call.text.includes('INSERT INTO billing_transactions'))).toBe(false)
  })

  it('marks provider completion and outbox evidence in the same transaction', async () => {
    const client = new RecordingClient()
    client.enqueue(); client.enqueue(); client.enqueue(paidOrder); client.enqueue(reservation); client.enqueue(); client.enqueue(); client.enqueue()
    const appendEvent = vi.fn(async () => undefined)
    const result = await new PostgresBillingRepository(new RecordingPool(client), appendEvent).completeRechargeRefund({ workspaceId: 'ws_wallet', orderId: 'recharge_100', reservationKey: 'recharge-refund:recharge_100:1', actorId: 'finance', reason: '客户申请', providerRefundId: 'provider_refund_100' })
    expect(result).toMatchObject({ type: 'debit', amountFen: 10_000 })
    expect(client.calls.some(call => call.text.includes("SET state='closed'"))).toBe(true)
    expect(appendEvent).toHaveBeenCalledWith(client, expect.objectContaining({ eventType: 'billing.recharge.refunded', payload: expect.objectContaining({ provider_refund_id: 'provider_refund_100', amount_fen: 10_000 }) }))
    expect(client.calls.at(-1)?.text).toBe('COMMIT')
  })

  it('rejects completion without a provider refund id before changing the ledger', async () => {
    const client = new RecordingClient()
    const repository = new PostgresBillingRepository(new RecordingPool(client))

    await expect(repository.completeRechargeRefund({
      workspaceId: 'ws_wallet', orderId: 'recharge_100', reservationKey: 'recharge-refund:recharge_100:1',
      actorId: 'finance', reason: '客户申请', providerRefundId: '  ',
    })).rejects.toThrow('billing refund provider id required')
    expect(client.calls).toHaveLength(0)
  })
})

describe('PostgresBillingRepository reconciliation lease fencing', () => {
  const workspaceId = 'ws_reconciliation_guard'
  const orderId = 'recharge_guard'
  const reservationKey = `recharge-refund:${orderId}:1`
  const pendingOrder = {
    id: orderId, workspace_id: workspaceId, channel: 'alipay', amount_fen: 1000,
    state: 'pending', payment_mode: 'provider', payment_url: null, provider_trade_id: null,
    created_at: '2026-09-15T01:00:00.000Z', updated_at: '2026-09-15T01:00:00.000Z',
  }
  const reservation = {
    id: 'refund_guard', workspace_id: workspaceId, type: 'debit', amount_fen: 1000,
    order_id: reservationKey, actor_id: 'finance', description: '退款预留',
    created_at: '2026-09-15T01:01:00.000Z',
  }
  const timeoutStatements = [
    "SET LOCAL lock_timeout='5s'",
    "SET LOCAL statement_timeout='15s'",
    "SET LOCAL idle_in_transaction_session_timeout='15s'",
  ]

  // Match business reads rather than consuming FIFO responses: adding timeout
  // statements must not accidentally turn an order lookup into an empty result.
  class GuardRecordingClient implements SqlClient {
    readonly calls: Array<{ text: string; values?: readonly unknown[] }> = []
    readonly timeline: string[] = []
    constructor(private readonly orderState: 'pending' | 'paid') {}
    async query<RowType = Row>(text: string, values?: readonly unknown[]) {
      this.calls.push({ text, values })
      this.timeline.push(text)
      let rows: Row[] = []
      if (/^SELECT .* FROM billing_orders /u.test(text)) {
        rows = [{ ...pendingOrder, state: this.orderState }]
      } else if (/^SELECT .* FROM billing_transactions .*type='debit'/u.test(text)) {
        rows = [reservation]
      } else if (/^UPDATE billing_orders /u.test(text)) {
        rows = [{ ...pendingOrder, state: text.includes('state=$3') ? values?.[2] : text.includes("state='closed'") ? 'closed' : 'paid', provider_trade_id: 'trade_guard' }]
      } else if (/^INSERT INTO billing_transactions .*RETURNING /u.test(text)) {
        rows = [{ ...reservation, id: 'release_guard', type: 'refund', order_id: `release:${reservationKey}` }]
      }
      return { rows: rows as RowType[] }
    }
    release() {}
  }

  const operations = [
    {
      name: 'markPaid', orderState: 'pending' as const, eventType: 'billing.recharge.paid',
      run: (repository: PostgresBillingRepository, assertReconciliationLease?: () => Promise<void>) => repository.markPaid({ workspaceId, orderId, providerTradeId: 'trade_guard', amountFen: 1000, eventSource: 'provider_reconciliation', assertReconciliationLease }),
    },
    {
      name: 'markProviderState', orderState: 'pending' as const, eventType: 'billing.recharge.reconciled',
      run: (repository: PostgresBillingRepository, assertReconciliationLease?: () => Promise<void>) => repository.markProviderState({ workspaceId, orderId, state: 'failed', eventSource: 'provider_reconciliation', assertReconciliationLease }),
    },
    {
      name: 'markReconciliationChecked', orderState: 'pending' as const, eventType: undefined,
      run: (repository: PostgresBillingRepository, assertReconciliationLease?: () => Promise<void>) => repository.markReconciliationChecked({ workspaceId, orderId, expectedState: 'pending', assertReconciliationLease }),
    },
    {
      name: 'completeRechargeRefund', orderState: 'paid' as const, eventType: 'billing.recharge.refunded',
      run: (repository: PostgresBillingRepository, assertReconciliationLease?: () => Promise<void>) => repository.completeRechargeRefund({ workspaceId, orderId, reservationKey, actorId: 'finance', reason: '查单确认退款成功', providerRefundId: 'provider_refund_guard', assertReconciliationLease }),
    },
    {
      name: 'releaseRechargeRefund', orderState: 'paid' as const, eventType: 'billing.recharge.refund_reservation_released',
      run: (repository: PostgresBillingRepository, assertReconciliationLease?: () => Promise<void>) => repository.releaseRechargeRefund({ workspaceId, orderId, reservationKey, actorId: 'finance', reason: '查单确认退款失败', assertReconciliationLease }),
    },
  ]

  function setup(orderState: 'pending' | 'paid') {
    const client = new GuardRecordingClient(orderState)
    const appendEvent = vi.fn(async (_transactionClient: SqlClient, event: OutboxEventInput) => {
      expect(_transactionClient).toBe(client)
      client.timeline.push(`outbox:${event.eventType}`)
    })
    const repository = new PostgresBillingRepository({ connect: async () => client }, appendEvent)
    return { client, repository, appendEvent }
  }

  function expectBoundedTransaction(client: GuardRecordingClient) {
    const statements = client.calls.map(call => call.text)
    expect(statements[0]).toBe('BEGIN')
    const firstLock = statements.findIndex(statement => statement.includes('FOR UPDATE'))
    expect(firstLock).toBeGreaterThan(0)
    const settings = statements.filter(statement => statement.startsWith('SET LOCAL '))
    expect(settings.map(statement => statement.replace(/\s*=\s*/gu, '='))).toEqual(timeoutStatements)
    for (const setting of settings) {
      expect(statements.indexOf(setting)).toBeGreaterThan(0)
      expect(statements.indexOf(setting)).toBeLessThan(firstLock)
    }
  }

  function lastMatchingIndex(entries: string[], matches: (entry: string) => boolean) {
    return entries.reduce((found, entry, index) => matches(entry) ? index : found, -1)
  }

  it('rolls back reservation release when its transactional outbox fact cannot be written', async () => {
    const { client } = setup('paid')
    const repository = new PostgresBillingRepository({ connect: async () => client }, async (_transactionClient, event) => {
      expect(event).toMatchObject({ eventType: 'billing.recharge.refund_reservation_released', payload: { order_id: orderId, reservation_key: reservationKey, release_transaction_id: expect.any(String) } })
      throw new Error('outbox unavailable')
    })
    await expect(repository.releaseRechargeRefund({ workspaceId, orderId, reservationKey, actorId: 'finance', reason: '查单退款失败' })).rejects.toThrow('outbox unavailable')
    expect(client.calls.at(-1)?.text).toBe('ROLLBACK')
    expect(client.calls.some(call => call.text === 'COMMIT')).toBe(false)
  })

  it.each(operations)('$name checks the lease after locks and after writes/outbox, before COMMIT', async operation => {
    const { client, repository, appendEvent } = setup(operation.orderState)
    const assertReconciliationLease = vi.fn(async () => { client.timeline.push('guard') })

    await expect(operation.run(repository, assertReconciliationLease)).resolves.toBeDefined()

    expectBoundedTransaction(client)
    expect(assertReconciliationLease).toHaveBeenCalledTimes(2)
    const lastLock = lastMatchingIndex(client.timeline, entry => entry.includes('FOR UPDATE'))
    const firstWrite = client.timeline.findIndex(entry => /^(?:UPDATE|INSERT INTO) billing_/u.test(entry))
    const lastWrite = lastMatchingIndex(client.timeline, entry => /^(?:UPDATE|INSERT INTO) billing_/u.test(entry))
    const firstGuard = client.timeline.indexOf('guard')
    const finalGuard = client.timeline.lastIndexOf('guard')
    expect(firstGuard).toBeGreaterThan(lastLock)
    expect(firstGuard).toBeLessThan(firstWrite)
    expect(finalGuard).toBeGreaterThan(lastWrite)
    if (operation.eventType) {
      expect(appendEvent).toHaveBeenCalledOnce()
      expect(finalGuard).toBeGreaterThan(client.timeline.indexOf(`outbox:${operation.eventType}`))
    } else {
      expect(appendEvent).not.toHaveBeenCalled()
    }
    expect(client.timeline.at(-2)).toBe('guard')
    expect(client.timeline.at(-1)).toBe('COMMIT')
  })

  it.each(operations)('$name rolls back without business writes if the post-lock lease check fails', async operation => {
    const { client, repository, appendEvent } = setup(operation.orderState)
    const leaseLost = new Error('PAYMENT_RECONCILIATION_LEASE_LOST')
    const assertReconciliationLease = vi.fn(async () => {
      client.timeline.push('guard')
      throw leaseLost
    })

    await expect(operation.run(repository, assertReconciliationLease)).rejects.toBe(leaseLost)

    expectBoundedTransaction(client)
    expect(assertReconciliationLease).toHaveBeenCalledOnce()
    expect(client.timeline.indexOf('guard')).toBeGreaterThan(lastMatchingIndex(client.timeline, entry => entry.includes('FOR UPDATE')))
    expect(client.calls.some(call => /^(?:UPDATE|INSERT INTO) billing_/u.test(call.text))).toBe(false)
    expect(appendEvent).not.toHaveBeenCalled()
    expect(client.calls.at(-1)?.text).toBe('ROLLBACK')
    expect(client.calls.some(call => call.text === 'COMMIT')).toBe(false)
  })

  it.each(operations)('$name rolls back writes/outbox if the final lease check fails', async operation => {
    const { client, repository, appendEvent } = setup(operation.orderState)
    const leaseLost = new Error('PAYMENT_RECONCILIATION_LEASE_LOST')
    let checks = 0
    const assertReconciliationLease = vi.fn(async () => {
      client.timeline.push('guard')
      if (++checks === 2) throw leaseLost
    })

    await expect(operation.run(repository, assertReconciliationLease)).rejects.toBe(leaseLost)

    expectBoundedTransaction(client)
    expect(assertReconciliationLease).toHaveBeenCalledTimes(2)
    expect(client.calls.some(call => /^(?:UPDATE|INSERT INTO) billing_/u.test(call.text))).toBe(true)
    const finalGuard = client.timeline.lastIndexOf('guard')
    expect(finalGuard).toBeGreaterThan(lastMatchingIndex(client.timeline, entry => /^(?:UPDATE|INSERT INTO) billing_/u.test(entry)))
    if (operation.eventType) {
      expect(appendEvent).toHaveBeenCalledOnce()
      expect(finalGuard).toBeGreaterThan(client.timeline.indexOf(`outbox:${operation.eventType}`))
    }
    expect(client.timeline.at(-2)).toBe('guard')
    expect(client.timeline.at(-1)).toBe('ROLLBACK')
    expect(client.calls.some(call => call.text === 'COMMIT')).toBe(false)
  })

  it.each(operations)('$name keeps non-reconciliation callers free of new timeout settings', async operation => {
    const { client, repository } = setup(operation.orderState)

    await expect(operation.run(repository)).resolves.toBeDefined()

    expect(client.calls.some(call => call.text.startsWith('SET LOCAL '))).toBe(false)
    expect(client.calls.at(-1)?.text).toBe('COMMIT')
    if (operation.name === 'markProviderState') {
      expect(client.calls.some(call => call.text.includes('FOR UPDATE'))).toBe(false)
      expect(client.calls.filter(call => call.text.includes('billing_orders'))).toHaveLength(1)
    }
  })
})
