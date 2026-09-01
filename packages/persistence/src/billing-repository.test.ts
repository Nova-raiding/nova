import { describe, expect, it, vi } from 'vitest'
import { BillingOrderIdempotencyConflictError, PostgresBillingRepository, RechargeRefundBalanceUnavailableError, WalletDebitIdempotencyConflictError } from './billing-repository.js'
import type { SqlClient, SqlPool } from './repository.js'

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
})

describe('PostgresBillingRepository external recharge refund', () => {
  const paidOrder = { id: 'recharge_100', workspace_id: 'ws_wallet', channel: 'wechat', amount_fen: 10_000, state: 'paid', payment_mode: 'provider', payment_url: null, provider_trade_id: 'trade_100', created_at: '2026-08-28T01:00:00.000Z', updated_at: '2026-08-28T01:01:00.000Z' }
  const reservation = { id: 'refund_reservation_1', workspace_id: 'ws_wallet', type: 'debit', amount_fen: 10_000, order_id: 'recharge-refund:recharge_100:1', description: '充值原路退款预留（finance）：客户申请', created_at: '2026-08-28T01:02:00.000Z' }

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
})
