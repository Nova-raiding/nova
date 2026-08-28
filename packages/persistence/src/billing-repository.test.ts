import { describe, expect, it } from 'vitest'
import { BillingOrderIdempotencyConflictError, PostgresBillingRepository, WalletDebitIdempotencyConflictError } from './billing-repository.js'
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
    expect(insert?.values?.slice(1)).toEqual(['ws_wallet', 1, 'refund:model:request-1', '模型失败退款（merchant）：provider timeout'])
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
})
