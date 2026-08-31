import { createHash } from 'node:crypto'
import {
  financeRecordKinds,
  parseFinanceSearchQuery,
  type FinanceExport,
  type FinanceRecordDetail,
  type FinanceRecordKind,
  type FinanceSearchPage,
  type FinanceSearchQuery,
} from '../../../../packages/contracts/src/ops/finance-search.js'
import type {
  FinanceSearchAccess,
  FinanceSearchRepository,
} from '../../../../packages/persistence/src/finance-search-repository.js'

export interface FinanceSearchPrincipal {
  actorId: string
  roles: readonly string[]
  authorizedWorkspaceIds: readonly string[]
}

export class FinanceSearchServiceError extends Error {
  constructor(readonly code: 'FINANCE_SEARCH_FORBIDDEN' | 'FINANCE_RECORD_NOT_FOUND' | 'FINANCE_SEARCH_INVALID_REQUEST', message: string) {
    super(message); this.name = 'FinanceSearchServiceError'
  }
}

export interface FinanceDetailRequest {
  workspaceId: string
  kind: FinanceRecordKind
  id: string
  expectedVersion?: string
  snapshotAt?: string
}

const required = (value: unknown, field: string, max = 256) => {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) throw new FinanceSearchServiceError('FINANCE_SEARCH_INVALID_REQUEST', `${field} is invalid`)
  return value.trim()
}

const optionalTimestamp = (value: unknown) => {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new FinanceSearchServiceError('FINANCE_SEARCH_INVALID_REQUEST', 'snapshotAt is invalid')
  return new Date(value).toISOString()
}

function csvCell(value: string | number | undefined) {
  let text = value === undefined ? '' : String(value)
  if (/^[=+@\-\t\r]/.test(text)) text = `'${text}`
  return `"${text.replaceAll('"', '""')}"`
}

function stableExportId(principal: FinanceSearchPrincipal, query: FinanceSearchQuery, snapshotAt: string) {
  const canonicalQuery = {
    workspaceIds: query.workspaceIds ? [...query.workspaceIds].sort() : [],
    kinds: query.kinds ? [...query.kinds].sort() : [],
    statuses: query.statuses ? [...query.statuses].sort() : [],
    text: query.text ?? '',
    fromAt: query.fromAt ?? '',
    toAt: query.toAt ?? '',
    cursor: query.cursor ?? '',
    limit: query.limit,
  }
  return `finance_export_${createHash('sha256').update(JSON.stringify({ actorId: principal.actorId, roles: [...principal.roles].sort(), workspaces: [...principal.authorizedWorkspaceIds].sort(), query: canonicalQuery, snapshotAt })).digest('hex').slice(0, 24)}`
}

export class FinanceSearchService {
  constructor(private readonly repository: FinanceSearchRepository, private readonly now: () => Date = () => new Date()) {}

  private access(principal: FinanceSearchPrincipal): FinanceSearchAccess {
    if (!principal.actorId.trim()) throw new FinanceSearchServiceError('FINANCE_SEARCH_FORBIDDEN', 'authenticated finance actor is required')
    if (principal.roles.includes('platform_ops')) return { role: 'platform_ops' }
    if (principal.roles.includes('finance')) {
      const workspaces = [...new Set(principal.authorizedWorkspaceIds.map(value => value.trim()).filter(Boolean))]
      if (!workspaces.length) throw new FinanceSearchServiceError('FINANCE_SEARCH_FORBIDDEN', 'finance role has no authorized workspace')
      return { role: 'finance', authorizedWorkspaceIds: workspaces }
    }
    throw new FinanceSearchServiceError('FINANCE_SEARCH_FORBIDDEN', 'platform_ops or finance role is required')
  }

  async search(principal: FinanceSearchPrincipal, rawQuery: unknown): Promise<FinanceSearchPage> {
    return this.repository.search(this.access(principal), parseFinanceSearchQuery(rawQuery))
  }

  async detail(principal: FinanceSearchPrincipal, raw: FinanceDetailRequest): Promise<FinanceRecordDetail> {
    const workspaceId = required(raw?.workspaceId, 'workspaceId', 128)
    const id = required(raw?.id, 'id', 256)
    const kind = required(raw?.kind, 'kind', 64) as FinanceRecordKind
    if (!financeRecordKinds.includes(kind)) throw new FinanceSearchServiceError('FINANCE_SEARCH_INVALID_REQUEST', 'kind is invalid')
    const expectedVersion = raw.expectedVersion === undefined ? undefined : required(raw.expectedVersion, 'expectedVersion', 128)
    const result = await this.repository.detail(this.access(principal), { workspaceId, id, kind, ...(expectedVersion ? { expectedVersion } : {}), ...(raw.snapshotAt ? { snapshotAt: optionalTimestamp(raw.snapshotAt) } : {}) })
    if (!result) throw new FinanceSearchServiceError('FINANCE_RECORD_NOT_FOUND', 'finance record was not found in the authorized scope')
    return result
  }

  async exportCsv(principal: FinanceSearchPrincipal, rawQuery: unknown): Promise<FinanceExport> {
    const access = this.access(principal)
    const parsed = parseFinanceSearchQuery(rawQuery)
    const snapshotAt = parsed.snapshotAt ?? this.now().toISOString()
    const query = { ...parsed, snapshotAt }
    const exported = await this.repository.exportRows(access, query, 5_000)
    const header = ['类型', '工作区', '记录号', '状态', '摘要', '业务引用', '金额_CNY', '方向', 'Provider成本_CNY', '客户计费_CNY', '用量', '发生时间', '更新时间', '版本']
    const rows = exported.records.map(record => [
      record.kind, record.workspaceId, record.id, record.status, record.label, record.reference,
      record.amountCny, record.direction, record.providerCostCny, record.customerChargeCny, record.units,
      record.occurredAt, record.updatedAt, record.version,
    ].map(csvCell).join(','))
    return {
      exportId: stableExportId(principal, query, exported.snapshotAt),
      fileName: `finance-search-${exported.snapshotAt.slice(0, 10)}.csv`,
      contentType: 'text/csv; charset=utf-8',
      csv: `\uFEFF${header.map(csvCell).join(',')}\r\n${rows.join('\r\n')}`,
      rowCount: exported.records.length,
      truncated: exported.truncated,
      snapshotAt: exported.snapshotAt,
    }
  }
}
