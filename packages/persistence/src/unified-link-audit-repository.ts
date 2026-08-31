import { randomUUID } from 'node:crypto'
import { requireWorkspaceScope, type SqlPool, withWorkspaceTransaction } from './repository.js'

export type UnifiedLinkAuditStatus = 'verified' | 'legacy_only' | 'conflict' | 'blocked'
export type UnifiedLinkAuditEntityType = 'product' | 'canonical_product' | 'listing' | 'campaign_item' | 'task' | 'publish_job'

export interface UnifiedLinkAudit {
  id: string
  workspaceId: string
  auditKey: string
  entityType: UnifiedLinkAuditEntityType
  entityId: string
  legacyProductId?: string
  canonicalProductId?: string
  listingId?: string
  campaignItemId?: string
  taskId?: string
  publishJobId?: string
  status: UnifiedLinkAuditStatus
  codes: string[]
  checkRevision: string
  checksum: string
  firstSeenAt: string
  lastSeenAt: string
  lastError?: string
}

export type UpsertUnifiedLinkAuditInput = Omit<UnifiedLinkAudit, 'id' | 'firstSeenAt' | 'lastSeenAt'> & { observedAt: string }

export interface UnifiedLinkAuditRepository {
  upsert(input: UpsertUnifiedLinkAuditInput): Promise<UnifiedLinkAudit>
  list(input: { workspaceId: string; status?: UnifiedLinkAuditStatus; limit?: number }): Promise<UnifiedLinkAudit[]>
}

const text = (value: string, code: string, max = 255) => {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error(code)
  return value.trim()
}
const workspace = (value: string) => text(requireWorkspaceScope(value), 'UNIFIED_LINK_AUDIT_WORKSPACE_ID_REQUIRED')
const instant = (value: string) => {
  if (!Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) throw new Error('UNIFIED_LINK_AUDIT_TIMESTAMP_INVALID')
  return value
}
const limitValue = (value?: number) => {
  const limit = value ?? 100
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) throw new RangeError('UNIFIED_LINK_AUDIT_LIMIT_INVALID')
  return limit
}
const validate = (input: UpsertUnifiedLinkAuditInput) => {
  const workspaceId = workspace(input.workspaceId)
  const entityType = input.entityType
  if (!['product', 'canonical_product', 'listing', 'campaign_item', 'task', 'publish_job'].includes(entityType)) throw new Error('UNIFIED_LINK_AUDIT_ENTITY_TYPE_INVALID')
  const status = input.status
  if (!['verified', 'legacy_only', 'conflict', 'blocked'].includes(status)) throw new Error('UNIFIED_LINK_AUDIT_STATUS_INVALID')
  const codes = [...new Set(input.codes.map(code => text(code, 'UNIFIED_LINK_AUDIT_CODE_INVALID', 128)))].sort()
  if (!codes.length && status !== 'verified') throw new Error('UNIFIED_LINK_AUDIT_CODES_REQUIRED')
  return {
    workspaceId, auditKey: text(input.auditKey, 'UNIFIED_LINK_AUDIT_KEY_REQUIRED'), entityType, entityId: text(input.entityId, 'UNIFIED_LINK_AUDIT_ENTITY_ID_REQUIRED'),
    ...(input.legacyProductId ? { legacyProductId: text(input.legacyProductId, 'UNIFIED_LINK_AUDIT_LEGACY_PRODUCT_ID_INVALID') } : {}),
    ...(input.canonicalProductId ? { canonicalProductId: text(input.canonicalProductId, 'UNIFIED_LINK_AUDIT_CANONICAL_PRODUCT_ID_INVALID') } : {}),
    ...(input.listingId ? { listingId: text(input.listingId, 'UNIFIED_LINK_AUDIT_LISTING_ID_INVALID') } : {}),
    ...(input.campaignItemId ? { campaignItemId: text(input.campaignItemId, 'UNIFIED_LINK_AUDIT_CAMPAIGN_ITEM_ID_INVALID') } : {}),
    ...(input.taskId ? { taskId: text(input.taskId, 'UNIFIED_LINK_AUDIT_TASK_ID_INVALID') } : {}),
    ...(input.publishJobId ? { publishJobId: text(input.publishJobId, 'UNIFIED_LINK_AUDIT_PUBLISH_JOB_ID_INVALID') } : {}),
    status, codes, checkRevision: text(input.checkRevision, 'UNIFIED_LINK_AUDIT_REVISION_REQUIRED', 128), checksum: text(input.checksum, 'UNIFIED_LINK_AUDIT_CHECKSUM_REQUIRED', 128), observedAt: instant(input.observedAt),
    ...(input.lastError ? { lastError: text(input.lastError, 'UNIFIED_LINK_AUDIT_ERROR_INVALID', 1_000) } : {}),
  }
}
const keyOf = (workspaceId: string, auditKey: string) => `${workspaceId}\0${auditKey}`
const clone = <T>(value: T): T => structuredClone(value)

export class MemoryUnifiedLinkAuditRepository implements UnifiedLinkAuditRepository {
  private readonly rows = new Map<string, UnifiedLinkAudit>()
  async upsert(input: UpsertUnifiedLinkAuditInput) {
    const value = validate(input); const key = keyOf(value.workspaceId, value.auditKey); const current = this.rows.get(key)
    const row: UnifiedLinkAudit = { ...value, id: current?.id ?? `unified_link_audit_${randomUUID()}`, firstSeenAt: current?.firstSeenAt ?? value.observedAt, lastSeenAt: value.observedAt }
    this.rows.set(key, row); return clone(row)
  }
  async list(input: { workspaceId: string; status?: UnifiedLinkAuditStatus; limit?: number }) {
    const workspaceId = workspace(input.workspaceId); const limit = limitValue(input.limit)
    return [...this.rows.values()].filter(row => row.workspaceId === workspaceId && (!input.status || row.status === input.status)).sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt) || a.auditKey.localeCompare(b.auditKey)).slice(0, limit).map(clone)
  }
}

type AuditRow = { id: string; workspace_id: string; audit_key: string; entity_type: UnifiedLinkAuditEntityType; entity_id: string; legacy_product_id: string | null; canonical_product_id: string | null; listing_id: string | null; campaign_item_id: string | null; task_id: string | null; publish_job_id: string | null; status: UnifiedLinkAuditStatus; codes: string[]; check_revision: string; checksum: string; first_seen_at: string | Date; last_seen_at: string | Date; last_error: string | null }
const projection = 'id,workspace_id,audit_key,entity_type,entity_id,legacy_product_id,canonical_product_id,listing_id,campaign_item_id,task_id,publish_job_id,status,codes,check_revision,checksum,first_seen_at,last_seen_at,last_error'
const iso = (value: string | Date) => value instanceof Date ? value.toISOString() : String(value)
const map = (row: AuditRow): UnifiedLinkAudit => ({ id: row.id, workspaceId: row.workspace_id, auditKey: row.audit_key, entityType: row.entity_type, entityId: row.entity_id, ...(row.legacy_product_id ? { legacyProductId: row.legacy_product_id } : {}), ...(row.canonical_product_id ? { canonicalProductId: row.canonical_product_id } : {}), ...(row.listing_id ? { listingId: row.listing_id } : {}), ...(row.campaign_item_id ? { campaignItemId: row.campaign_item_id } : {}), ...(row.task_id ? { taskId: row.task_id } : {}), ...(row.publish_job_id ? { publishJobId: row.publish_job_id } : {}), status: row.status, codes: [...row.codes], checkRevision: row.check_revision, checksum: row.checksum, firstSeenAt: iso(row.first_seen_at), lastSeenAt: iso(row.last_seen_at), ...(row.last_error ? { lastError: row.last_error } : {}) })

export class PostgresUnifiedLinkAuditRepository implements UnifiedLinkAuditRepository {
  constructor(private readonly pool: SqlPool) {}
  async upsert(input: UpsertUnifiedLinkAuditInput) {
    const value = validate(input); const id = randomUUID()
    return withWorkspaceTransaction(this.pool, value.workspaceId, async client => {
      const result = await client.query<AuditRow>(`INSERT INTO unified_link_audit (id,workspace_id,audit_key,entity_type,entity_id,legacy_product_id,canonical_product_id,listing_id,campaign_item_id,task_id,publish_job_id,status,codes,check_revision,checksum,first_seen_at,last_seen_at,last_error) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,$15,$16,$16,$17) ON CONFLICT (workspace_id,audit_key) DO UPDATE SET entity_type=EXCLUDED.entity_type,entity_id=EXCLUDED.entity_id,legacy_product_id=EXCLUDED.legacy_product_id,canonical_product_id=EXCLUDED.canonical_product_id,listing_id=EXCLUDED.listing_id,campaign_item_id=EXCLUDED.campaign_item_id,task_id=EXCLUDED.task_id,publish_job_id=EXCLUDED.publish_job_id,status=EXCLUDED.status,codes=EXCLUDED.codes,check_revision=EXCLUDED.check_revision,checksum=EXCLUDED.checksum,last_seen_at=EXCLUDED.last_seen_at,last_error=EXCLUDED.last_error RETURNING ${projection}`, [id, value.workspaceId, value.auditKey, value.entityType, value.entityId, value.legacyProductId ?? null, value.canonicalProductId ?? null, value.listingId ?? null, value.campaignItemId ?? null, value.taskId ?? null, value.publishJobId ?? null, value.status, JSON.stringify(value.codes), value.checkRevision, value.checksum, value.observedAt, value.lastError ?? null])
      return map(result.rows[0]!)
    })
  }
  async list(input: { workspaceId: string; status?: UnifiedLinkAuditStatus; limit?: number }) { const workspaceId = workspace(input.workspaceId); const limit = limitValue(input.limit); return withWorkspaceTransaction(this.pool, workspaceId, async client => { const result = await client.query<AuditRow>(`SELECT ${projection} FROM unified_link_audit WHERE workspace_id=$1 AND ($2::text IS NULL OR status=$2) ORDER BY last_seen_at DESC,audit_key ASC LIMIT $3`, [workspaceId, input.status ?? null, limit]); return result.rows.map(map) }) }
}
