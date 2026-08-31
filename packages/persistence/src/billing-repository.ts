import { randomUUID } from 'node:crypto'
import { withWorkspaceTransaction, requireWorkspaceScope, type OutboxEventInput, type SqlClient, type SqlPool } from './repository.js'

export type BillingChannel = 'alipay' | 'wechat'
export type BillingOrderState = 'pending' | 'paid' | 'closed' | 'failed'

export interface BillingOrder {
  id: string
  workspaceId: string
  channel: BillingChannel
  amountFen: number
  state: BillingOrderState
  paymentMode: 'fixture' | 'provider'
  paymentUrl?: string
  providerTradeId?: string
  createdByActorId?: string
  createdAt: string
  updatedAt: string
}

export interface BillingTransaction {
  id: string
  workspaceId: string
  type: 'recharge' | 'debit' | 'refund'
  amountFen: number
  orderId?: string
  actorId?: string
  description: string
  createdAt: string
}
export interface WalletDebitResult extends BillingTransaction { created: boolean }
export interface WalletDebitInput { workspaceId: string; amountFen: number; idempotencyKey: string; actorId: string; description: string }
export interface RechargeRefundReservation extends WalletDebitResult { completed: boolean }

export class WalletDebitIdempotencyConflictError extends Error {
  readonly code = 'WALLET_DEBIT_IDEMPOTENCY_CONFLICT'
  constructor() { super('wallet debit idempotency key was reused with a different amount or description'); this.name = 'WalletDebitIdempotencyConflictError' }
}

export class BillingOrderIdempotencyConflictError extends Error {
  readonly code = 'BILLING_ORDER_IDEMPOTENCY_CONFLICT'
  constructor() { super('billing order idempotency key was reused with a different payment intent'); this.name = 'BillingOrderIdempotencyConflictError' }
}

export class RechargeRefundBalanceUnavailableError extends Error {
  readonly code = 'BILLING_REFUND_BALANCE_UNAVAILABLE'
  constructor() { super('recharge value is no longer available in the wallet'); this.name = 'RechargeRefundBalanceUnavailableError' }
}

type OrderRow = { id: string; workspace_id: string; channel: BillingChannel; amount_fen: number; state: BillingOrderState; payment_mode: 'fixture' | 'provider'; payment_url: string | null; provider_trade_id: string | null; created_by_actor_id?: string | null; created_at: string | Date; updated_at: string | Date }
type TransactionRow = { id: string; workspace_id: string; type: BillingTransaction['type']; amount_fen: number; order_id: string | null; actor_id?: string | null; description: string; created_at: string | Date }
const iso = (value: string | Date) => value instanceof Date ? value.toISOString() : String(value)
const order = (row: OrderRow): BillingOrder => ({ id: row.id, workspaceId: row.workspace_id, channel: row.channel, amountFen: row.amount_fen, state: row.state, paymentMode: row.payment_mode, ...(row.payment_url ? { paymentUrl: row.payment_url } : {}), ...(row.provider_trade_id ? { providerTradeId: row.provider_trade_id } : {}), ...(row.created_by_actor_id ? { createdByActorId: row.created_by_actor_id } : {}), createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) })
const transaction = (row: TransactionRow): BillingTransaction => ({ id: row.id, workspaceId: row.workspace_id, type: row.type, amountFen: row.amount_fen, ...(row.order_id ? { orderId: row.order_id } : {}), ...(row.actor_id ? { actorId: row.actor_id } : {}), description: row.description, createdAt: iso(row.created_at) })
type BillingOrderIntent = Pick<BillingOrder, 'channel' | 'amountFen' | 'paymentMode' | 'createdByActorId'>
const sameOrderIntent = (row: OrderRow, input: BillingOrderIntent) => row.channel === input.channel && row.amount_fen === input.amountFen && row.payment_mode === input.paymentMode && (row.created_by_actor_id ?? undefined) === input.createdByActorId

export class PostgresBillingRepository {
  constructor(private readonly pool: SqlPool, private readonly appendEvent?: (client: SqlClient, event: OutboxEventInput) => Promise<unknown>) {}

  async createOrder(input: Omit<BillingOrder, 'createdAt' | 'updatedAt'> & { idempotencyKey: string }) {
    const workspaceId = requireWorkspaceScope(input.workspaceId)
    return withWorkspaceTransaction(this.pool, workspaceId, async client => {
      const inserted = await client.query<OrderRow>(`INSERT INTO billing_orders (id, workspace_id, channel, amount_fen, state, payment_mode, payment_url, provider_trade_id, idempotency_key, created_by_actor_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (workspace_id,idempotency_key) DO NOTHING RETURNING id,workspace_id,channel,amount_fen,state,payment_mode,payment_url,provider_trade_id,created_by_actor_id,created_at,updated_at`, [input.id, workspaceId, input.channel, input.amountFen, input.state, input.paymentMode, input.paymentUrl ?? null, input.providerTradeId ?? null, input.idempotencyKey, input.createdByActorId ?? null])
      if (inserted.rows[0]) return order(inserted.rows[0])
      const existing = await client.query<OrderRow>('SELECT id,workspace_id,channel,amount_fen,state,payment_mode,payment_url,provider_trade_id,created_by_actor_id,created_at,updated_at FROM billing_orders WHERE workspace_id=$1 AND idempotency_key=$2', [workspaceId, input.idempotencyKey])
      if (!existing.rows[0]) throw new Error('billing order disappeared before lookup')
      if (!sameOrderIntent(existing.rows[0], input)) throw new BillingOrderIdempotencyConflictError()
      return order(existing.rows[0])
    })
  }

  async getOrder(workspaceId: string, id: string) {
    return withWorkspaceTransaction(this.pool, requireWorkspaceScope(workspaceId), async client => {
      const result = await client.query<OrderRow>('SELECT id,workspace_id,channel,amount_fen,state,payment_mode,payment_url,provider_trade_id,created_by_actor_id,created_at,updated_at FROM billing_orders WHERE workspace_id=$1 AND id=$2', [workspaceId, id])
      return result.rows[0] ? order(result.rows[0]) : undefined
    })
  }

  async getOrderByIdempotencyKey(workspaceId: string, idempotencyKey: string) {
    return withWorkspaceTransaction(this.pool, requireWorkspaceScope(workspaceId), async client => {
      const result = await client.query<OrderRow>('SELECT id,workspace_id,channel,amount_fen,state,payment_mode,payment_url,provider_trade_id,created_by_actor_id,created_at,updated_at FROM billing_orders WHERE workspace_id=$1 AND idempotency_key=$2', [workspaceId, idempotencyKey])
      return result.rows[0] ? order(result.rows[0]) : undefined
    })
  }

  async listOrders(workspaceId: string, states: BillingOrderState[] = ['pending'], limit = 100, actorId?: string) {
    return withWorkspaceTransaction(this.pool, requireWorkspaceScope(workspaceId), async client => {
      const safeStates = states.length ? states : ['pending' as const]
      const result = await client.query<OrderRow>('SELECT id,workspace_id,channel,amount_fen,state,payment_mode,payment_url,provider_trade_id,created_by_actor_id,created_at,updated_at FROM billing_orders WHERE workspace_id=$1 AND state = ANY($2::text[]) AND ($4::text IS NULL OR created_by_actor_id=$4) ORDER BY created_at DESC,id DESC LIMIT $3', [workspaceId, safeStates, Math.min(100, Math.max(1, limit)), actorId ?? null])
      return result.rows.map(order)
    })
  }

  async countOrdersByState(workspaceId: string, actorId?: string): Promise<Record<BillingOrderState, number>> {
    return withWorkspaceTransaction(this.pool, requireWorkspaceScope(workspaceId), async client => {
      const result = await client.query<{ state: BillingOrderState; count: string | number }>('SELECT state, COUNT(*)::bigint AS count FROM billing_orders WHERE workspace_id=$1 AND ($2::text IS NULL OR created_by_actor_id=$2) GROUP BY state', [workspaceId, actorId ?? null])
      const counts: Record<BillingOrderState, number> = { pending: 0, paid: 0, closed: 0, failed: 0 }
      for (const row of result.rows) if (row.state in counts) counts[row.state] = Number(row.count)
      return counts
    })
  }

  async listTransactions(workspaceId: string, limit = 20, actorId?: string) {
    return withWorkspaceTransaction(this.pool, requireWorkspaceScope(workspaceId), async client => {
      const result = await client.query<TransactionRow>('SELECT id,workspace_id,type,amount_fen,order_id,actor_id,description,created_at FROM billing_transactions WHERE workspace_id=$1 AND ($3::text IS NULL OR actor_id=$3) ORDER BY created_at DESC,id DESC LIMIT $2', [workspaceId, limit, actorId ?? null])
      return result.rows.map(transaction)
    })
  }

  async balanceFen(workspaceId: string) {
    return withWorkspaceTransaction(this.pool, requireWorkspaceScope(workspaceId), async client => {
      const result = await client.query<{ balance_fen: string | number }>('SELECT COALESCE(SUM(CASE WHEN type = \'debit\' THEN -amount_fen ELSE amount_fen END),0)::bigint AS balance_fen FROM billing_transactions WHERE workspace_id=$1', [workspaceId])
      return Number(result.rows[0]?.balance_fen ?? 0)
    })
  }

  /** Atomically reserve wallet funds by serializing on the workspace row. */
  async debit(input: WalletDebitInput) {
    return withWorkspaceTransaction(this.pool, requireWorkspaceScope(input.workspaceId), async client => {
      const existing = await client.query<TransactionRow>('SELECT id,workspace_id,type,amount_fen,order_id,actor_id,description,created_at FROM billing_transactions WHERE workspace_id=$1 AND order_id=$2 AND type=\'debit\'', [input.workspaceId, input.idempotencyKey])
      if (existing.rows[0]) { if (existing.rows[0].amount_fen !== input.amountFen || existing.rows[0].description !== `${input.description}（${input.actorId}）`) throw new WalletDebitIdempotencyConflictError(); return { ...transaction(existing.rows[0]), created: false } satisfies WalletDebitResult }
      await client.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [input.workspaceId])
      const balance = await client.query<{ balance_fen: string }>('SELECT COALESCE(SUM(CASE WHEN type = \'debit\' THEN -amount_fen ELSE amount_fen END),0)::bigint AS balance_fen FROM billing_transactions WHERE workspace_id=$1', [input.workspaceId])
      if (Number(balance.rows[0]?.balance_fen ?? 0) < input.amountFen) throw new Error('BILLING_INSUFFICIENT_BALANCE')
      const inserted = await client.query<TransactionRow>('INSERT INTO billing_transactions (id,workspace_id,type,amount_fen,order_id,actor_id,description) VALUES ($1,$2,\'debit\',$3,$4,$5,$6) RETURNING id,workspace_id,type,amount_fen,order_id,actor_id,description,created_at', [billingTransactionId(), input.workspaceId, input.amountFen, input.idempotencyKey, input.actorId, `${input.description}（${input.actorId}）`])
      return { ...transaction(inserted.rows[0]!), created: true } satisfies WalletDebitResult
    })
  }

  /** Settle a small pre-debit to the provider-reported final customer charge.
   * The original debit remains immutable; only the delta is appended. */
  async settleDebit(input: { workspaceId: string; debitIdempotencyKey: string; finalAmountFen: number; actorId: string; description: string }) {
    if (!Number.isSafeInteger(input.finalAmountFen) || input.finalAmountFen <= 0) throw new Error('BILLING_FINAL_AMOUNT_INVALID')
    return withWorkspaceTransaction(this.pool, requireWorkspaceScope(input.workspaceId), async client => {
      await client.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [input.workspaceId])
      const original = await client.query<TransactionRow>("SELECT id,workspace_id,type,amount_fen,order_id,actor_id,description,created_at FROM billing_transactions WHERE workspace_id=$1 AND order_id=$2 AND type='debit'", [input.workspaceId, input.debitIdempotencyKey])
      if (!original.rows[0]) throw new Error('billing debit not found')
      const delta = input.finalAmountFen - original.rows[0].amount_fen
      if (delta === 0) return { original: transaction(original.rows[0]), delta: undefined }
      const orderId = `${delta > 0 ? 'settlement' : 'settlement-refund'}:${input.debitIdempotencyKey}`
      const type: BillingTransaction['type'] = delta > 0 ? 'debit' : 'refund'
      const existing = await client.query<TransactionRow>('SELECT id,workspace_id,type,amount_fen,order_id,description,created_at FROM billing_transactions WHERE workspace_id=$1 AND order_id=$2 AND type=$3', [input.workspaceId, orderId, type])
      if (existing.rows[0]) {
        if (existing.rows[0].amount_fen !== Math.abs(delta)) throw new WalletDebitIdempotencyConflictError()
        return { original: transaction(original.rows[0]), delta: transaction(existing.rows[0]) }
      }
      if (delta > 0) {
        const balance = await client.query<{ balance_fen: string }>("SELECT COALESCE(SUM(CASE WHEN type = 'debit' THEN -amount_fen ELSE amount_fen END),0)::bigint AS balance_fen FROM billing_transactions WHERE workspace_id=$1", [input.workspaceId])
        if (Number(balance.rows[0]?.balance_fen ?? 0) < delta) throw new Error('BILLING_INSUFFICIENT_BALANCE')
      }
      const inserted = await client.query<TransactionRow>('INSERT INTO billing_transactions (id,workspace_id,type,amount_fen,order_id,actor_id,description) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id,workspace_id,type,amount_fen,order_id,actor_id,description,created_at', [billingTransactionId(), input.workspaceId, type, Math.abs(delta), orderId, original.rows[0].actor_id ?? input.actorId, `${input.description}（${input.actorId}）`])
      return { original: transaction(original.rows[0]), delta: transaction(inserted.rows[0]!) }
    })
  }

  /** Reverse a model debit after the downstream generation request failed.
   * The debit and refund are separate immutable ledger entries; the refund
   * key is derived from the original debit key so retries remain idempotent. */
  async refundDebit(input: { workspaceId: string; debitIdempotencyKey: string; actorId: string; reason: string }) {
    return withWorkspaceTransaction(this.pool, requireWorkspaceScope(input.workspaceId), async client => {
      const debit = await client.query<TransactionRow>("SELECT id,workspace_id,type,amount_fen,order_id,actor_id,description,created_at FROM billing_transactions WHERE workspace_id=$1 AND order_id=$2 AND type='debit'", [input.workspaceId, input.debitIdempotencyKey])
      if (!debit.rows[0]) throw new Error('billing debit not found')
      const refundOrderId = `refund:${input.debitIdempotencyKey}`
      const existing = await client.query<TransactionRow>("SELECT id,workspace_id,type,amount_fen,order_id,description,created_at FROM billing_transactions WHERE workspace_id=$1 AND order_id=$2 AND type='refund'", [input.workspaceId, refundOrderId])
      if (existing.rows[0]) return transaction(existing.rows[0])
      const inserted = await client.query<TransactionRow>('INSERT INTO billing_transactions (id,workspace_id,type,amount_fen,order_id,actor_id,description) VALUES ($1,$2,\'refund\',$3,$4,$5,$6) RETURNING id,workspace_id,type,amount_fen,order_id,actor_id,description,created_at', [billingTransactionId(), input.workspaceId, debit.rows[0].amount_fen, refundOrderId, debit.rows[0].actor_id ?? input.actorId, `模型失败退款（${input.actorId}）：${input.reason}`])
      return transaction(inserted.rows[0]!)
    })
  }

  async markPaid(input: { workspaceId: string; orderId: string; providerTradeId: string; amountFen: number; eventSource: string }) {
    return withWorkspaceTransaction(this.pool, requireWorkspaceScope(input.workspaceId), async client => {
      const orderResult = await client.query<OrderRow>('SELECT id,workspace_id,channel,amount_fen,state,payment_mode,payment_url,provider_trade_id,created_by_actor_id,created_at,updated_at FROM billing_orders WHERE workspace_id=$1 AND id=$2 FOR UPDATE', [input.workspaceId, input.orderId])
      const current = orderResult.rows[0]
      if (!current) return undefined
      if (current.amount_fen !== input.amountFen) throw new Error('billing callback amount mismatch')
      if (current.state === 'paid') {
        if (current.provider_trade_id && current.provider_trade_id !== input.providerTradeId) throw new Error('billing callback replay conflict')
        return order(current)
      }
      if (current.state !== 'pending') throw new Error('billing order is not payable')
      const updated = await client.query<OrderRow>('UPDATE billing_orders SET state=\'paid\', provider_trade_id=$3, updated_at=now() WHERE workspace_id=$1 AND id=$2 RETURNING id,workspace_id,channel,amount_fen,state,payment_mode,payment_url,provider_trade_id,created_by_actor_id,created_at,updated_at', [input.workspaceId, input.orderId, input.providerTradeId])
      await client.query('INSERT INTO billing_transactions (id,workspace_id,type,amount_fen,order_id,actor_id,description) VALUES ($1,$2,\'recharge\',$3,$4,$5,$6) ON CONFLICT (workspace_id,order_id,type) DO NOTHING', [billingTransactionId(), input.workspaceId, input.amountFen, input.orderId, current.created_by_actor_id ?? null, `充值到账（${current.channel}）`])
      await this.appendEvent?.(client, { workspaceId: input.workspaceId, aggregateId: input.orderId, eventType: 'billing.recharge.paid', sequence: 1, payload: { order_id: input.orderId, provider_trade_id: input.providerTradeId, amount_fen: input.amountFen, channel: current.channel, source: input.eventSource } })
      return updated.rows[0] ? order(updated.rows[0]) : undefined
    })
  }

  async markProviderState(input: { workspaceId: string; orderId: string; state: 'closed' | 'failed' }) {
    return withWorkspaceTransaction(this.pool, requireWorkspaceScope(input.workspaceId), async client => {
      const updated = await client.query<OrderRow>("UPDATE billing_orders SET state=$3, updated_at=now() WHERE workspace_id=$1 AND id=$2 AND state='pending' RETURNING id,workspace_id,channel,amount_fen,state,payment_mode,payment_url,provider_trade_id,created_by_actor_id,created_at,updated_at", [input.workspaceId, input.orderId, input.state])
      return updated.rows[0] ? order(updated.rows[0]) : undefined
    })
  }

  /** Reserve wallet value before asking the external payment provider to refund.
   * Model debit reversals remain `refund` credits; an external recharge refund
   * is a distinct `debit` because money is leaving both the wallet and provider. */
  async reserveRechargeRefund(input: { workspaceId: string; orderId: string; actorId: string; reason: string }): Promise<RechargeRefundReservation> {
    return withWorkspaceTransaction(this.pool, requireWorkspaceScope(input.workspaceId), async client => {
      const orderResult = await client.query<OrderRow>('SELECT id,workspace_id,channel,amount_fen,state,payment_mode,payment_url,provider_trade_id,created_by_actor_id,created_at,updated_at FROM billing_orders WHERE workspace_id=$1 AND id=$2 FOR UPDATE', [input.workspaceId, input.orderId])
      const current = orderResult.rows[0]
      if (!current) throw new Error('billing order not found')
      const prefix = `recharge-refund:${input.orderId}:`
      const reservations = await client.query<TransactionRow>("SELECT id,workspace_id,type,amount_fen,order_id,actor_id,description,created_at FROM billing_transactions WHERE workspace_id=$1 AND type='debit' AND left(order_id,length($2))=$2 ORDER BY created_at,id FOR UPDATE", [input.workspaceId, prefix])
      if (current.state === 'closed') {
        const completed = reservations.rows.at(-1)
        if (!completed) throw new Error('billing order is not refundable')
        return { ...transaction(completed), created: false, completed: true }
      }
      if (current.state !== 'paid') throw new Error('billing order is not refundable')
      const releases = await client.query<TransactionRow>("SELECT id,workspace_id,type,amount_fen,order_id,description,created_at FROM billing_transactions WHERE workspace_id=$1 AND type='refund' AND left(order_id,length($2))=$2", [input.workspaceId, `release:${prefix}`])
      const releasedKeys = new Set(releases.rows.map(row => row.order_id?.replace(/^release:/u, '')))
      const active = reservations.rows.find(row => row.order_id && !releasedKeys.has(row.order_id))
      if (active) return { ...transaction(active), created: false, completed: false }
      await client.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [input.workspaceId])
      const balance = await client.query<{ balance_fen: string | number }>("SELECT COALESCE(SUM(CASE WHEN type = 'debit' THEN -amount_fen ELSE amount_fen END),0)::bigint AS balance_fen FROM billing_transactions WHERE workspace_id=$1", [input.workspaceId])
      if (Number(balance.rows[0]?.balance_fen ?? 0) < current.amount_fen) throw new RechargeRefundBalanceUnavailableError()
      const reservationKey = `${prefix}${reservations.rows.length + 1}`
      const inserted = await client.query<TransactionRow>("INSERT INTO billing_transactions (id,workspace_id,type,amount_fen,order_id,actor_id,description) VALUES ($1,$2,'debit',$3,$4,$5,$6) RETURNING id,workspace_id,type,amount_fen,order_id,actor_id,description,created_at", [billingTransactionId(), input.workspaceId, current.amount_fen, reservationKey, current.created_by_actor_id ?? input.actorId, `充值原路退款预留（${input.actorId}）：${input.reason}`])
      return { ...transaction(inserted.rows[0]!), created: true, completed: false }
    })
  }

  async completeRechargeRefund(input: { workspaceId: string; orderId: string; reservationKey: string; actorId: string; reason: string; providerRefundId: string }) {
    return withWorkspaceTransaction(this.pool, requireWorkspaceScope(input.workspaceId), async client => {
      const orderResult = await client.query<OrderRow>('SELECT id,workspace_id,channel,amount_fen,state,payment_mode,payment_url,provider_trade_id,created_by_actor_id,created_at,updated_at FROM billing_orders WHERE workspace_id=$1 AND id=$2 FOR UPDATE', [input.workspaceId, input.orderId])
      const current = orderResult.rows[0]
      if (!current) throw new Error('billing order not found')
      const reservation = await client.query<TransactionRow>("SELECT id,workspace_id,type,amount_fen,order_id,actor_id,description,created_at FROM billing_transactions WHERE workspace_id=$1 AND order_id=$2 AND type='debit' FOR UPDATE", [input.workspaceId, input.reservationKey])
      if (!reservation.rows[0] || reservation.rows[0].amount_fen !== current.amount_fen) throw new Error('recharge refund reservation not found')
      const released = await client.query<TransactionRow>("SELECT id,workspace_id,type,amount_fen,order_id,description,created_at FROM billing_transactions WHERE workspace_id=$1 AND order_id=$2 AND type='refund'", [input.workspaceId, `release:${input.reservationKey}`])
      if (released.rows[0]) throw new Error('recharge refund reservation was released')
      if (current.state === 'closed') return transaction(reservation.rows[0])
      if (current.state !== 'paid') throw new Error('billing order is not refundable')
      await client.query("UPDATE billing_orders SET state='closed',payment_url=NULL,updated_at=now() WHERE workspace_id=$1 AND id=$2", [input.workspaceId, input.orderId])
      await this.appendEvent?.(client, { workspaceId: input.workspaceId, aggregateId: input.orderId, eventType: 'billing.recharge.refunded', sequence: 1, payload: { order_id: input.orderId, provider_refund_id: input.providerRefundId, amount_fen: current.amount_fen, actor_id: input.actorId, reason: input.reason } })
      return transaction(reservation.rows[0])
    })
  }

  async releaseRechargeRefund(input: { workspaceId: string; orderId: string; reservationKey: string; actorId: string; reason: string }) {
    return withWorkspaceTransaction(this.pool, requireWorkspaceScope(input.workspaceId), async client => {
      const orderResult = await client.query<OrderRow>('SELECT id,workspace_id,channel,amount_fen,state,payment_mode,payment_url,provider_trade_id,created_by_actor_id,created_at,updated_at FROM billing_orders WHERE workspace_id=$1 AND id=$2 FOR UPDATE', [input.workspaceId, input.orderId])
      const current = orderResult.rows[0]
      if (!current) throw new Error('billing order not found')
      if (current.state === 'closed') return undefined
      const reservation = await client.query<TransactionRow>("SELECT id,workspace_id,type,amount_fen,order_id,actor_id,description,created_at FROM billing_transactions WHERE workspace_id=$1 AND order_id=$2 AND type='debit' FOR UPDATE", [input.workspaceId, input.reservationKey])
      if (!reservation.rows[0]) throw new Error('recharge refund reservation not found')
      const releaseKey = `release:${input.reservationKey}`
      const existing = await client.query<TransactionRow>("SELECT id,workspace_id,type,amount_fen,order_id,description,created_at FROM billing_transactions WHERE workspace_id=$1 AND order_id=$2 AND type='refund'", [input.workspaceId, releaseKey])
      if (existing.rows[0]) return transaction(existing.rows[0])
      const inserted = await client.query<TransactionRow>("INSERT INTO billing_transactions (id,workspace_id,type,amount_fen,order_id,actor_id,description) VALUES ($1,$2,'refund',$3,$4,$5,$6) RETURNING id,workspace_id,type,amount_fen,order_id,actor_id,description,created_at", [billingTransactionId(), input.workspaceId, reservation.rows[0].amount_fen, releaseKey, reservation.rows[0].actor_id ?? input.actorId, `充值退款失败释放预留（${input.actorId}）：${input.reason}`])
      return transaction(inserted.rows[0]!)
    })
  }
}

export function billingTransactionId() { return `billing_tx_${randomUUID()}` }
