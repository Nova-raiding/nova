export const auditSources = ['operation', 'rule', 'incident', 'support'] as const
export type AuditSource = (typeof auditSources)[number]
/** `reader` means the shared capability evaluator already authorized an exact
 * workspace-scoped audit.read decision; it never permits export/platform use. */
export type AuditAccessRole = 'platform_ops' | 'support' | 'finance' | 'reader'

export interface AuditCenterQuery {
  workspaceId: string
  text?: string
  sources?: AuditSource[]
  actorId?: string
  action?: string
  resourceType?: string
  fromAt?: string
  toAt?: string
  cursor?: string
  limit: number
}

export type AuditPlatformQuery = Omit<AuditCenterQuery, 'workspaceId' | 'cursor'>

export interface AuditCenterRecord {
  id: string
  source: AuditSource
  workspaceId: string
  actorId: string
  action: string
  resourceType: string
  resourceId: string
  reason: string
  occurredAt: string
  redacted: true
}

export interface AuditEvidence {
  redacted: true
  fields: Readonly<Record<string, string | number | boolean | null>>
  omittedFields: number
}

export interface AuditCenterDetail extends AuditCenterRecord { evidence: AuditEvidence }
/** A stable server-side page. totalRecords is calculated before the cursor is applied. */
export interface AuditCenterPage { records: AuditCenterRecord[]; totalRecords: number; truncated: boolean; nextCursor?: string }
export interface AuditCenterExport {
  exportId: string
  fileName: string
  contentType: 'text/csv; charset=utf-8'
  csv: string
  rowCount: number
  truncated: boolean
}

export class AuditCenterContractError extends Error {
  readonly code = 'AUDIT_CENTER_INVALID_REQUEST'
  constructor(message: string) { super(message); this.name = 'AuditCenterContractError' }
}

const optionalText = (value: unknown, field: string, max: number) => {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) throw new AuditCenterContractError(`${field} is invalid`)
  return value.trim()
}
const timestamp = (value: unknown, field: string) => {
  const text = optionalText(value, field, 64)
  if (!text) return undefined
  if (!Number.isFinite(Date.parse(text))) throw new AuditCenterContractError(`${field} must be an ISO timestamp`)
  return new Date(text).toISOString()
}

export function parseAuditCenterQuery(value: unknown): AuditCenterQuery {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AuditCenterContractError('query must be an object')
  const input = value as Record<string, unknown>
  const workspaceId = optionalText(input.workspaceId ?? input.workspace_id, 'workspaceId', 128)
  if (!workspaceId) throw new AuditCenterContractError('workspaceId is required')
  const rawSources = input.sources
  let sources: AuditSource[] | undefined
  if (rawSources !== undefined) {
    if (!Array.isArray(rawSources) || rawSources.length > auditSources.length || rawSources.some(item => typeof item !== 'string' || !auditSources.includes(item as AuditSource))) throw new AuditCenterContractError('sources is invalid')
    const unique = [...new Set(rawSources as AuditSource[])]
    if (unique.length) sources = unique
  }
  const fromAt = timestamp(input.fromAt ?? input.from_at, 'fromAt')
  const toAt = timestamp(input.toAt ?? input.to_at, 'toAt')
  if (fromAt && toAt && Date.parse(fromAt) > Date.parse(toAt)) throw new AuditCenterContractError('fromAt must not be after toAt')
  const limit = input.limit === undefined ? 50 : Number(input.limit)
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new AuditCenterContractError('limit must be between 1 and 100')
  const cursor = optionalText(input.cursor, 'cursor', 4096)
  return {
    workspaceId,
    ...(optionalText(input.text, 'text', 200) ? { text: optionalText(input.text, 'text', 200) } : {}),
    ...(sources ? { sources } : {}),
    ...(optionalText(input.actorId ?? input.actor_id, 'actorId', 256) ? { actorId: optionalText(input.actorId ?? input.actor_id, 'actorId', 256) } : {}),
    ...(optionalText(input.action, 'action', 256) ? { action: optionalText(input.action, 'action', 256) } : {}),
    ...(optionalText(input.resourceType ?? input.resource_type, 'resourceType', 128) ? { resourceType: optionalText(input.resourceType ?? input.resource_type, 'resourceType', 128) } : {}),
    ...(fromAt ? { fromAt } : {}), ...(toAt ? { toAt } : {}), ...(cursor ? { cursor } : {}), limit,
  }
}

/** Platform-wide audit reads deliberately have no workspace wildcard or
 * cursor. The API resolves the authorized tenant set and merges bounded,
 * redacted tenant pages server-side. */
export function parseAuditPlatformQuery(value: unknown): AuditPlatformQuery {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AuditCenterContractError('query must be an object')
  const raw = value as Record<string, unknown>
  if (raw.workspaceId !== undefined || raw.workspace_id !== undefined) throw new AuditCenterContractError('platform audit query must not include workspaceId')
  const input = { ...raw, workspaceId: '__platform_scope__' }
  const parsed = parseAuditCenterQuery(input)
  const { workspaceId: _workspaceId, cursor: _cursor, ...platform } = parsed
  return platform
}
