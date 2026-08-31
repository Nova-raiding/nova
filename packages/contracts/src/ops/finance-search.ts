export const financeRecordKinds = [
  'recharge_order',
  'wallet_transaction',
  'subscription_order',
  'usage_entry',
  'model_usage',
] as const

export type FinanceRecordKind = (typeof financeRecordKinds)[number]
export type FinanceAccessRole = 'platform_ops' | 'finance'
export type FinanceDirection = 'credit' | 'debit'

export interface FinanceSearchQuery {
  workspaceIds?: string[]
  kinds?: FinanceRecordKind[]
  statuses?: string[]
  text?: string
  fromAt?: string
  toAt?: string
  cursor?: string
  snapshotAt?: string
  limit: number
}

export interface FinanceSearchRecord {
  id: string
  kind: FinanceRecordKind
  workspaceId: string
  status: string
  label: string
  reference?: string
  amountCny?: number
  direction?: FinanceDirection
  providerCostCny?: number
  customerChargeCny?: number
  units?: number
  occurredAt: string
  updatedAt: string
  version: string
  redacted: true
}

export interface FinanceSearchSummary {
  totalRecords: number
  rechargeOrderCny: number
  subscriptionOrderCny: number
  walletCreditCny: number
  walletDebitCny: number
  walletNetCny: number
  providerCostCny: number
  customerChargeCny: number
  usageUnits: number
  byKind: Record<FinanceRecordKind, number>
}

export interface FinanceSearchPage {
  records: FinanceSearchRecord[]
  summary: FinanceSearchSummary
  nextCursor?: string
  snapshotAt: string
  scope: { role: FinanceAccessRole; workspaceCount: number }
}

export interface FinanceRecordDetail extends FinanceSearchRecord {
  attributes: Readonly<Record<string, string | number | boolean | null>>
}

export interface FinanceExport {
  exportId: string
  fileName: string
  contentType: 'text/csv; charset=utf-8'
  csv: string
  rowCount: number
  truncated: boolean
  snapshotAt: string
}

export class FinanceSearchValidationError extends Error {
  readonly code = 'FINANCE_SEARCH_INVALID_REQUEST'
  constructor(message: string) { super(message); this.name = 'FinanceSearchValidationError' }
}

const iso = (value: unknown, field: string) => {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new FinanceSearchValidationError(`${field} must be an ISO timestamp`)
  return new Date(value).toISOString()
}

const strings = (value: unknown, field: string, maxItems: number, maxLength: number) => {
  if (value === undefined || value === null) return undefined
  if (!Array.isArray(value) || value.length > maxItems) throw new FinanceSearchValidationError(`${field} must be a bounded array`)
  const normalized = [...new Set(value.map(item => {
    if (typeof item !== 'string' || !item.trim() || item.trim().length > maxLength) throw new FinanceSearchValidationError(`${field} contains an invalid value`)
    return item.trim()
  }))]
  return normalized.length ? normalized : undefined
}

export function parseFinanceSearchQuery(value: unknown): FinanceSearchQuery {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new FinanceSearchValidationError('query must be an object')
  const input = value as Record<string, unknown>
  const workspaceIds = strings(input.workspaceIds ?? input.workspace_ids, 'workspaceIds', 250, 128)
  const rawKinds = strings(input.kinds, 'kinds', financeRecordKinds.length, 64)
  if (rawKinds?.some(kind => !financeRecordKinds.includes(kind as FinanceRecordKind))) throw new FinanceSearchValidationError('kinds contains an unsupported value')
  const statuses = strings(input.statuses, 'statuses', 20, 64)
  const rawText = input.text
  if (rawText !== undefined && (typeof rawText !== 'string' || rawText.trim().length > 200)) throw new FinanceSearchValidationError('text must be at most 200 characters')
  const rawCursor = input.cursor
  if (rawCursor !== undefined && (typeof rawCursor !== 'string' || rawCursor.length > 4096)) throw new FinanceSearchValidationError('cursor is invalid')
  const fromAt = iso(input.fromAt ?? input.from_at, 'fromAt')
  const toAt = iso(input.toAt ?? input.to_at, 'toAt')
  const snapshotAt = iso(input.snapshotAt ?? input.snapshot_at, 'snapshotAt')
  if (fromAt && toAt && Date.parse(fromAt) > Date.parse(toAt)) throw new FinanceSearchValidationError('fromAt must not be after toAt')
  const limit = input.limit === undefined ? 50 : Number(input.limit)
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new FinanceSearchValidationError('limit must be an integer between 1 and 100')
  return {
    ...(workspaceIds ? { workspaceIds } : {}),
    ...(rawKinds ? { kinds: rawKinds as FinanceRecordKind[] } : {}),
    ...(statuses ? { statuses } : {}),
    ...(typeof rawText === 'string' && rawText.trim() ? { text: rawText.trim() } : {}),
    ...(fromAt ? { fromAt } : {}),
    ...(toAt ? { toAt } : {}),
    ...(typeof rawCursor === 'string' && rawCursor ? { cursor: rawCursor } : {}),
    ...(snapshotAt ? { snapshotAt } : {}),
    limit,
  }
}
