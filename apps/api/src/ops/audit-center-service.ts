import { createHash } from 'node:crypto'
import { auditSources, parseAuditCenterQuery, parseAuditPlatformQuery, type AuditAccessRole, type AuditCenterExport, type AuditCenterQuery, type AuditSource } from '../../../../packages/contracts/src/ops/audit-center.js'
import type { AuditCenterRepository } from '../../../../packages/persistence/src/audit-center-repository.js'

export interface AuditCenterPrincipal { actorId: string; roles: readonly AuditAccessRole[]; authorizedWorkspaceIds: readonly string[] }
export class AuditCenterServiceError extends Error {
  constructor(readonly code: 'AUDIT_CENTER_FORBIDDEN' | 'AUDIT_EVENT_NOT_FOUND' | 'AUDIT_CENTER_INVALID_REQUEST', message: string) { super(message); this.name = 'AuditCenterServiceError' }
}
const canRead = (roles: readonly AuditAccessRole[]) => roles.some(role => role === 'platform_ops' || role === 'support' || role === 'finance' || role === 'reader')
const canExport = (roles: readonly AuditAccessRole[]) => roles.some(role => role === 'platform_ops' || role === 'finance')
const cell = (value: string | undefined) => { let text = value ?? ''; if (/^[=+@\-\t\r]/.test(text)) text = `'${text}`; return `"${text.replaceAll('"', '""')}"` }

export class AuditCenterService {
  constructor(private readonly repository: AuditCenterRepository, private readonly now: () => Date = () => new Date()) {}
  private authorize(principal: AuditCenterPrincipal, workspaceId: string, operation: 'read' | 'export') {
    if (!principal.actorId.trim() || !(operation === 'export' ? canExport(principal.roles) : canRead(principal.roles))) throw new AuditCenterServiceError('AUDIT_CENTER_FORBIDDEN', 'audit permission is required')
    if (!principal.roles.includes('platform_ops') && !principal.authorizedWorkspaceIds.includes(workspaceId)) throw new AuditCenterServiceError('AUDIT_CENTER_FORBIDDEN', 'workspace is outside the authorized scope')
  }
  async list(principal: AuditCenterPrincipal, rawQuery: unknown) { const query = parseAuditCenterQuery(rawQuery); this.authorize(principal, query.workspaceId, 'read'); return this.repository.list(query) }
  async listPlatform(principal: AuditCenterPrincipal, rawQuery: unknown, workspaceIds: readonly string[]) {
    if (!principal.actorId.trim() || !principal.roles.includes('platform_ops')) throw new AuditCenterServiceError('AUDIT_CENTER_FORBIDDEN', 'platform audit permission is required')
    const query = parseAuditPlatformQuery(rawQuery)
    const authorized = [...new Set(workspaceIds.map(value => value.trim()).filter(Boolean))]
    const pages = await Promise.all(authorized.map(workspaceId => this.repository.list({ ...query, workspaceId })))
    const records = pages.flatMap(page => page.records).sort((left, right) => right.occurredAt.localeCompare(left.occurredAt) || right.workspaceId.localeCompare(left.workspaceId) || right.id.localeCompare(left.id))
    const totalRecords = pages.reduce((sum, page) => sum + page.totalRecords, 0)
    return { records: records.slice(0, query.limit), totalRecords, truncated: totalRecords > query.limit }
  }
  async detail(principal: AuditCenterPrincipal, raw: { workspaceId: string; source: AuditSource; id: string }) {
    if (!raw || typeof raw.workspaceId !== 'string' || !raw.workspaceId.trim() || typeof raw.id !== 'string' || !raw.id.trim() || raw.id.length > 256 || !auditSources.includes(raw.source)) throw new AuditCenterServiceError('AUDIT_CENTER_INVALID_REQUEST', 'audit detail request is invalid')
    this.authorize(principal, raw.workspaceId, 'read'); const found = await this.repository.detail(raw.workspaceId, raw.source, raw.id)
    if (!found) throw new AuditCenterServiceError('AUDIT_EVENT_NOT_FOUND', 'audit event was not found in the authorized workspace')
    return found
  }
  async exportCsv(principal: AuditCenterPrincipal, rawQuery: unknown): Promise<AuditCenterExport> {
    const parsed = parseAuditCenterQuery(rawQuery); this.authorize(principal, parsed.workspaceId, 'export')
    const { cursor: _cursor, limit: _limit, ...query } = parsed; const exported = await this.repository.exportRows(query, 5_000)
    const header = ['source', 'workspace_id', 'event_id', 'actor_id', 'action', 'resource_type', 'resource_id', 'reason', 'occurred_at']
    const rows = exported.records.map(record => [record.source, record.workspaceId, record.id, record.actorId, record.action, record.resourceType, record.resourceId, record.reason, record.occurredAt].map(cell).join(','))
    const generatedAt = this.now().toISOString(); const exportId = `audit_export_${createHash('sha256').update(JSON.stringify({ actorId: principal.actorId, query, generatedAt })).digest('hex').slice(0, 24)}`
    return { exportId, fileName: `audit-center-${parsed.workspaceId}-${generatedAt.slice(0, 10)}.csv`, contentType: 'text/csv; charset=utf-8', csv: `\uFEFF${header.map(cell).join(',')}\r\n${rows.join('\r\n')}`, rowCount: exported.records.length, truncated: exported.truncated }
  }
}

export type { AuditCenterQuery }
