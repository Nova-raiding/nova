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

export async function listRechargeOrders<T extends RechargeOrderView>(input: {
  workspaceId: string
  params: Record<string, unknown>
  scope: 'mine' | 'workspace'
  actorId: string
  durable?: (states: RechargeState[], limit: number, actorId?: string) => Promise<{ orders: T[]; summary: Record<RechargeState, number> }>
  memoryOrders: readonly T[]
  project: (order: T) => unknown
}) {
  const { workspaceId, params, scope, actorId } = input
  const allowedStates: RechargeState[] = ['pending', 'paid', 'closed', 'failed']
  const requestedStates = typeof params.states === 'string' && params.states.trim() ? [...new Set(params.states.split(',').map(value => value.trim()).filter(Boolean))] : allowedStates
  if (requestedStates.some(state => !allowedStates.includes(state as RechargeState))) throw new DomainError('BILLING_ORDER_STATE_INVALID', '充值订单状态只能是 pending、paid、closed 或 failed', 400)
  const limit = typeof params.limit === 'string' && /^\d+$/u.test(params.limit) ? Math.min(100, Math.max(1, Number(params.limit))) : 100
  if (input.durable) {
    const { orders, summary } = await input.durable(requestedStates as RechargeState[], limit, scope === 'mine' ? actorId : undefined)
    const total = requestedStates.reduce((sum, state) => sum + (summary[state as RechargeState] ?? 0), 0)
    return { scope, orders: orders.map(input.project), summary, returned: orders.length, total, legacy_unattributed_hidden: scope === 'mine' }
  }
  const allOrders = input.memoryOrders.filter(order => order.workspaceId === workspaceId).sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id))
  const scopedOrders = allOrders.filter(order => scope === 'workspace' || order.createdByActorId === actorId)
  const orders = scopedOrders.filter(order => requestedStates.includes(order.state)).slice(0, limit)
  const summary: Record<RechargeState, number> = Object.fromEntries(allowedStates.map(state => [state, scopedOrders.filter(order => order.state === state).length])) as Record<RechargeState, number>
  const total = requestedStates.reduce((sum, state) => sum + (summary[state as RechargeState] ?? 0), 0)
  return { scope, orders: orders.map(input.project), summary, returned: orders.length, total, legacy_unattributed_hidden: scope === 'mine' }
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
