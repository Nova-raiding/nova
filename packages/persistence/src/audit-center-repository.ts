import { createHash } from 'node:crypto'
import type { AuditCenterDetail, AuditCenterPage, AuditCenterQuery, AuditCenterRecord, AuditEvidence, AuditSource } from '@merchant-marketing/contracts'
import { requireWorkspaceScope, type SqlPool, withWorkspaceTransaction } from './repository.js'

type AuditRow = { id: string; source: AuditSource; workspace_id: string; actor_id: string; action: string; resource_type: string; resource_id: string; reason: string; occurred_at: string | Date; evidence: Record<string, unknown> }
type Cursor = { v: 1; fingerprint: string; occurredAt: string; source: AuditSource; id: string }
export interface AuditCenterRepository { list(query: AuditCenterQuery): Promise<AuditCenterPage>; detail(workspaceId: string, source: AuditSource, id: string): Promise<AuditCenterDetail | undefined>; exportRows(query: Omit<AuditCenterQuery, 'cursor' | 'limit'>, limit: number): Promise<{ records: AuditCenterRecord[]; truncated: boolean }> }
export class AuditCenterCursorError extends Error { readonly code = 'AUDIT_CENTER_CURSOR_INVALID'; constructor() { super('audit cursor is invalid'); this.name = 'AuditCenterCursorError' } }

const sensitive = /(authorization|cookie|credential|password|secret|token|payment.?url|idempotency|receipt.?hash|request.?hash|raw|metadata|error|email|phone|address|content|description|body|title|detail|payload|text|html|markdown|selling.?points|facts|attributes|images|sku)/i
const sensitiveReasonValue = /(authorization|cookie|credential|password|secret|token|payment.?url|api.?key|access.?key|private.?key)\s*[:=]\s*[^\s,;]+/gi
const sensitiveFreeTextValue = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|(?:\+?86[-\s]?)?1[3-9](?:[-\s]?\d){9}/gi
const MAX_AUDIT_REASON_LENGTH = 1_000
const primitive = (value: unknown): value is string | number | boolean | null => value === null || ['string', 'number', 'boolean'].includes(typeof value)
const redactFreeText = (value: string) => value
  .replace(sensitiveReasonValue, '$1=[REDACTED]')
  .replace(sensitiveFreeTextValue, '[REDACTED]')
export function redactAuditReason(reason: string): string {
  return redactFreeText(reason.trim()).slice(0, MAX_AUDIT_REASON_LENGTH)
}
export function redactAuditEvidence(input: unknown): AuditEvidence {
  const fields: Record<string, string | number | boolean | null> = {}; let omittedFields = 0
  const walk = (value: unknown, prefix: string, depth: number) => {
    if (Object.keys(fields).length >= 64 || depth > 4) { omittedFields += 1; return }
    if (!value || typeof value !== 'object' || Array.isArray(value)) { if (primitive(value)) fields[prefix || 'value'] = typeof value === 'string' ? redactFreeText(value).slice(0, 500) : value; else omittedFields += 1; return }
    for (const [key, child] of Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))) {
      const path = prefix ? `${prefix}.${key}` : key
      if (sensitive.test(key)) { omittedFields += 1; continue }
      walk(child, path, depth + 1)
    }
  }
  walk(input, '', 0); return { redacted: true, fields, omittedFields }
}
const iso = (value: string | Date) => value instanceof Date ? value.toISOString() : new Date(value).toISOString()
const summary = (row: AuditRow): AuditCenterRecord => ({ id: row.id, source: row.source, workspaceId: row.workspace_id, actorId: row.actor_id, action: row.action, resourceType: row.resource_type, resourceId: row.resource_id, reason: redactAuditReason(row.reason), occurredAt: iso(row.occurred_at), redacted: true })
const detail = (row: AuditRow): AuditCenterDetail => ({ ...summary(row), evidence: redactAuditEvidence(row.evidence) })
const fingerprint = (query: Omit<AuditCenterQuery, 'cursor' | 'limit'>) => createHash('sha256').update(JSON.stringify({ workspaceId: query.workspaceId, text: query.text ?? '', sources: query.sources ? [...query.sources].sort() : [], actorId: query.actorId ?? '', action: query.action ?? '', resourceType: query.resourceType ?? '', fromAt: query.fromAt ?? '', toAt: query.toAt ?? '' })).digest('hex')
const encode = (value: Cursor) => Buffer.from(JSON.stringify(value)).toString('base64url')
const decode = (value: string, expected: string): Cursor => { try { const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Cursor; if (parsed.v !== 1 || parsed.fingerprint !== expected || !Number.isFinite(Date.parse(parsed.occurredAt)) || !parsed.id || !['operation', 'rule', 'incident', 'support'].includes(parsed.source)) throw new Error(); return parsed } catch { throw new AuditCenterCursorError() } }
const before = (row: AuditRow, cursor?: Cursor) => !cursor || iso(row.occurred_at) < cursor.occurredAt || (iso(row.occurred_at) === cursor.occurredAt && (row.source < cursor.source || (row.source === cursor.source && row.id < cursor.id)))
const matches = (row: AuditRow, query: AuditCenterQuery) => row.workspace_id === query.workspaceId && (!query.sources || query.sources.includes(row.source)) && (!query.actorId || row.actor_id === query.actorId) && (!query.action || row.action === query.action) && (!query.resourceType || row.resource_type === query.resourceType) && (!query.fromAt || iso(row.occurred_at) >= query.fromAt) && (!query.toAt || iso(row.occurred_at) <= query.toAt) && (!query.text || [row.actor_id, row.action, row.resource_type, row.resource_id, row.reason].join(' ').toLocaleLowerCase().includes(query.text.toLocaleLowerCase()))

export class MemoryAuditCenterRepository implements AuditCenterRepository {
  constructor(private readonly rows: readonly AuditRow[] = []) {}
  async list(query: AuditCenterQuery): Promise<AuditCenterPage> {
    requireWorkspaceScope(query.workspaceId); const fp = fingerprint(query); const cursor = query.cursor ? decode(query.cursor, fp) : undefined
    const matchingRows = this.rows.filter(row => matches(row, query)).sort((a, b) => iso(b.occurred_at).localeCompare(iso(a.occurred_at)) || b.source.localeCompare(a.source) || b.id.localeCompare(a.id))
    const rows = matchingRows.filter(row => before(row, cursor))
    const page = rows.slice(0, query.limit); const last = page.at(-1)
    const truncated = rows.length > query.limit
    return { records: page.map(summary), totalRecords: matchingRows.length, truncated, ...(truncated && last ? { nextCursor: encode({ v: 1, fingerprint: fp, occurredAt: iso(last.occurred_at), source: last.source, id: last.id }) } : {}) }
  }
  async detail(workspaceId: string, source: AuditSource, id: string) { requireWorkspaceScope(workspaceId); const row = this.rows.find(item => item.workspace_id === workspaceId && item.source === source && item.id === id); return row ? detail(row) : undefined }
  async exportRows(query: Omit<AuditCenterQuery, 'cursor' | 'limit'>, limit: number) { const page = await this.list({ ...query, limit: Math.min(limit + 1, 5_001) }); return { records: page.records.slice(0, limit), truncated: page.records.length > limit } }
}

const projection = `id, source, workspace_id, actor_id, action, resource_type, resource_id, reason, occurred_at, evidence`
export class PostgresAuditCenterRepository implements AuditCenterRepository {
  constructor(private readonly pool: SqlPool) {}
  async list(query: AuditCenterQuery): Promise<AuditCenterPage> {
    const workspaceId = requireWorkspaceScope(query.workspaceId); const fp = fingerprint(query); const cursor = query.cursor ? decode(query.cursor, fp) : undefined
    return withWorkspaceTransaction(this.pool, workspaceId, async client => {
      const filterSql = `workspace_id=$1 AND (cardinality($2::text[])=0 OR source=ANY($2::text[])) AND ($3::text IS NULL OR actor_id=$3) AND ($4::text IS NULL OR action=$4) AND ($5::text IS NULL OR resource_type=$5) AND ($6::timestamptz IS NULL OR occurred_at >= $6) AND ($7::timestamptz IS NULL OR occurred_at <= $7) AND ($8::text IS NULL OR position(lower($8) in lower(concat_ws(' ',actor_id,action,resource_type,resource_id,reason))) > 0)`
      const filterParams = [workspaceId, query.sources ?? [], query.actorId ?? null, query.action ?? null, query.resourceType ?? null, query.fromAt ?? null, query.toAt ?? null, query.text ?? null]
      const countResult = await client.query<{ total_records: number | string }>(`SELECT count(*)::int AS total_records FROM ops_audit_center WHERE ${filterSql}`, filterParams)
      const result = await client.query<AuditRow>(`SELECT ${projection} FROM ops_audit_center WHERE ${filterSql} AND ($9::timestamptz IS NULL OR (occurred_at,source,id) < ($9::timestamptz,$10::text,$11::text)) ORDER BY occurred_at DESC,source DESC,id DESC LIMIT $12`, [...filterParams, cursor?.occurredAt ?? null, cursor?.source ?? null, cursor?.id ?? null, query.limit + 1])
      const rows = result.rows.slice(0, query.limit); const last = rows.at(-1)
      const truncated = result.rows.length > query.limit
      return { records: rows.map(summary), totalRecords: Number(countResult.rows[0]?.total_records ?? 0), truncated, ...(truncated && last ? { nextCursor: encode({ v: 1, fingerprint: fp, occurredAt: iso(last.occurred_at), source: last.source, id: last.id }) } : {}) }
    })
  }
  async detail(workspaceId: string, source: AuditSource, id: string) { return withWorkspaceTransaction(this.pool, requireWorkspaceScope(workspaceId), async client => { const result = await client.query<AuditRow>(`SELECT ${projection} FROM ops_audit_center WHERE workspace_id=$1 AND source=$2 AND id=$3 LIMIT 1`, [workspaceId, source, id]); return result.rows[0] ? detail(result.rows[0]) : undefined }) }
  async exportRows(query: Omit<AuditCenterQuery, 'cursor' | 'limit'>, limit: number) { const page = await this.list({ ...query, limit: Math.min(limit + 1, 5_001) }); return { records: page.records.slice(0, limit), truncated: page.records.length > limit } }
}
