import { createHash } from 'node:crypto'
import { DomainError } from '../../../packages/application/src/service.js'
import type { BillingExportTransaction } from './mcp-billing-export.js'

export type RechargeState = 'pending' | 'paid' | 'closed' | 'failed'
export interface RechargeOrderView {
  id: string
  workspaceId: string
  state: RechargeState
  createdAt: string
  createdByActorId?: string
}

type RechargeOrderCursor = { createdAt: string; id: string }
type RechargeOrderCursorPayload = { v: 1; fingerprint: string; createdAt: string; id: string }

function rechargeOrderFingerprint(input: { workspaceId: string; scope: 'mine' | 'workspace'; actorId: string; states: RechargeState[] }) {
  return createHash('sha256').update(JSON.stringify({
    workspaceId: input.workspaceId,
    scope: input.scope,
    actorId: input.scope === 'mine' ? input.actorId : null,
    states: [...input.states].sort(),
  })).digest('base64url')
}

function decodeRechargeOrderCursor(value: unknown, fingerprint: string): RechargeOrderCursor | undefined {
  if (value === undefined || value === null || value === '') return undefined
  try {
    if (typeof value !== 'string' || value.length > 2048) throw new Error()
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Partial<RechargeOrderCursorPayload>
    if (parsed.v !== 1 || parsed.fingerprint !== fingerprint || typeof parsed.id !== 'string' || !parsed.id.trim()
      || typeof parsed.createdAt !== 'string' || !Number.isFinite(Date.parse(parsed.createdAt))) throw new Error()
    return { id: parsed.id, createdAt: new Date(parsed.createdAt).toISOString() }
  } catch {
    throw new DomainError('BILLING_ORDER_CURSOR_INVALID', '充值订单分页游标无效或与当前筛选范围不匹配，请刷新后重试', 400)
  }
}

function encodeRechargeOrderCursor(cursor: RechargeOrderCursor | undefined, fingerprint: string) {
  return cursor ? Buffer.from(JSON.stringify({ v: 1, fingerprint, ...cursor } satisfies RechargeOrderCursorPayload)).toString('base64url') : null
}

export async function listRechargeOrders<T extends RechargeOrderView>(input: {
  workspaceId: string
  params: Record<string, unknown>
  scope: 'mine' | 'workspace'
  actorId: string
  durable?: (states: RechargeState[], limit: number, actorId: string | undefined, cursor?: RechargeOrderCursor) => Promise<{ orders: T[]; summary: Record<RechargeState, number>; nextCursor?: RechargeOrderCursor }>
  memoryOrders: readonly T[]
  project: (order: T) => unknown
}) {
  const { workspaceId, params, scope, actorId } = input
  const allowedStates: RechargeState[] = ['pending', 'paid', 'closed', 'failed']
  const requestedStates = typeof params.states === 'string' && params.states.trim() ? [...new Set(params.states.split(',').map(value => value.trim()).filter(Boolean))] : allowedStates
  if (requestedStates.some(state => !allowedStates.includes(state as RechargeState))) throw new DomainError('BILLING_ORDER_STATE_INVALID', '充值订单状态只能是 pending、paid、closed 或 failed', 400)
  const limit = typeof params.limit === 'string' && /^\d+$/u.test(params.limit) ? Math.min(100, Math.max(1, Number(params.limit))) : 100
  const fingerprint = rechargeOrderFingerprint({ workspaceId, scope, actorId, states: requestedStates as RechargeState[] })
  const cursor = decodeRechargeOrderCursor(params.cursor, fingerprint)
  if (input.durable) {
    const { orders, summary, nextCursor } = await input.durable(requestedStates as RechargeState[], limit, scope === 'mine' ? actorId : undefined, cursor)
    const total = requestedStates.reduce((sum, state) => sum + (summary[state as RechargeState] ?? 0), 0)
    return { scope, orders: orders.map(input.project), summary, returned: orders.length, total, next_cursor: encodeRechargeOrderCursor(nextCursor, fingerprint), legacy_unattributed_hidden: scope === 'mine' }
  }
  const allOrders = input.memoryOrders.filter(order => order.workspaceId === workspaceId).sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id))
  const scopedOrders = allOrders.filter(order => scope === 'workspace' || order.createdByActorId === actorId)
  const matchingOrders = scopedOrders.filter(order => requestedStates.includes(order.state)
    && (!cursor || order.createdAt < cursor.createdAt || (order.createdAt === cursor.createdAt && order.id < cursor.id)))
  const page = matchingOrders.slice(0, limit + 1)
  const orders = page.slice(0, limit)
  const hasMore = page.length > limit
  const last = orders.at(-1)
  const nextCursor = hasMore && last ? { createdAt: last.createdAt, id: last.id } : undefined
  const summary: Record<RechargeState, number> = Object.fromEntries(allowedStates.map(state => [state, scopedOrders.filter(order => order.state === state).length])) as Record<RechargeState, number>
  const total = requestedStates.reduce((sum, state) => sum + (summary[state as RechargeState] ?? 0), 0)
  return { scope, orders: orders.map(input.project), summary, returned: orders.length, total, next_cursor: encodeRechargeOrderCursor(nextCursor, fingerprint), legacy_unattributed_hidden: scope === 'mine' }
}

export async function listBillingTransactions<T extends BillingExportTransaction>(input: {
  workspaceId: string
  params: Record<string, unknown>
  scope: 'mine' | 'workspace'
  actorId: string
  ready: Promise<unknown>
  durable?: (limit: number, actorId?: string) => Promise<{ balanceFen: number; transactions: T[] }>
  memory: (limit: number) => { balanceFen: number; transactions: T[] }
  project: (transaction: T) => unknown
}) {
  const { params, scope, actorId } = input
  const limit = typeof params.limit === 'string' && /^\d+$/u.test(params.limit) ? Math.min(100, Math.max(1, Number(params.limit))) : 20
  await input.ready
  const { balanceFen, transactions } = input.durable ? await input.durable(limit, scope === 'mine' ? actorId : undefined) : input.memory(limit)
  return { scope, wallet_scope: 'workspace', balance_cny: (balanceFen / 100).toFixed(2), transactions: transactions.map(input.project), legacy_unattributed_hidden: scope === 'mine' }
}
