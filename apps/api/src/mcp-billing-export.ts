import { DomainError } from '../../../packages/application/src/service.js'
import { csvCell } from './ops/csv-cell.js'

export interface BillingExportTransaction {
  id: string
  type: string
  amountFen: number
  orderId?: string
  description: string
  createdAt: string
}

export async function exportBillingTransactions(input: {
  workspaceId: string
  params: Record<string, unknown>
  scope: 'mine' | 'workspace'
  actorId: string
  listTransactions: (limit: number, actorId?: string) => Promise<BillingExportTransaction[]>
}) {
  const { workspaceId, params, scope, actorId } = input
  const limit = typeof params.limit === 'string' && /^\d+$/u.test(params.limit) ? Math.min(1000, Math.max(1, Number(params.limit))) : 1000
  const format = params.format === 'json' ? 'json' : 'csv'
  const parseExportTime = (value: unknown) => { if (typeof value !== 'string' || !value.trim()) return undefined; const parsed = new Date(value); return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null }
  const fromAt = parseExportTime(params.from_at)
  const toAt = parseExportTime(params.to_at)
  if (fromAt === null || toAt === null || (fromAt && toAt && fromAt >= toAt)) throw new DomainError('BILLING_EXPORT_PERIOD_INVALID', 'from_at/to_at 必须是有效且递增的 ISO 时间', 400)
  const allTransactions = await input.listTransactions(limit, scope === 'mine' ? actorId : undefined)
  const transactions = allTransactions.filter(item => (!fromAt || item.createdAt >= fromAt) && (!toAt || item.createdAt < toAt))
  const rows = transactions.map(item => ({ id: item.id, type: item.type, amount_cny: (item.amountFen / 100).toFixed(2), order_id: item.orderId ?? '', description: item.description, created_at: item.createdAt }))
  const filenameBase = scope === 'mine' ? 'my-billing' : `billing-${workspaceId}`
  if (format === 'json') return { scope, filename: `${filenameBase}.json`, contentType: 'application/json', content: JSON.stringify(rows) }
  const content = ['id,type,amount_cny,order_id,description,created_at', ...rows.map(row => [row.id, row.type, row.amount_cny, row.order_id, row.description, row.created_at].map(csvCell).join(','))].join('\n')
  return { scope, filename: `${filenameBase}.csv`, contentType: 'text/csv; charset=utf-8', content }
}
