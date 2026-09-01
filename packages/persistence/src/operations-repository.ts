import { randomUUID } from 'node:crypto'
import { requireWorkspaceScope, type SqlPool, withWorkspaceTransaction } from './repository.js'

export interface OperationAudit { id: string; workspaceId: string; actorId: string; action: string; resourceType: string; resourceId: string; before: Record<string, unknown>; after: Record<string, unknown>; reason: string; createdAt: string }
export interface OperationsRepository { append(input: Omit<OperationAudit, 'id' | 'createdAt'>): Promise<OperationAudit>; list(workspaceId: string, limit?: number): Promise<OperationAudit[]> }

const auditIdentity = /^[^\u0000-\u001f\u007f]+$/u
const MAX_AUDIT_REASON_LENGTH = 1_000

export class OperationAuditValidationError extends Error {
  readonly code = 'OPERATION_AUDIT_CONTEXT_INVALID'
  constructor() {
    super('operation audit context is invalid')
    this.name = 'OperationAuditValidationError'
  }
}

/** Reject unverifiable audit evidence before either sink can accept it. */
export function validateOperationAuditInput(input: Omit<OperationAudit, 'id' | 'createdAt'>): void {
  const identities = [input.workspaceId, input.actorId, input.action, input.resourceType, input.resourceId]
  if (identities.some(value => typeof value !== 'string' || value.trim() !== value || !value || !auditIdentity.test(value))) throw new OperationAuditValidationError()
  if (typeof input.reason !== 'string' || input.reason.length > MAX_AUDIT_REASON_LENGTH || /[\u0000-\u001f\u007f]/u.test(input.reason)) throw new OperationAuditValidationError()
  if (!input.before || typeof input.before !== 'object' || Array.isArray(input.before) || !input.after || typeof input.after !== 'object' || Array.isArray(input.after)) throw new OperationAuditValidationError()
}

export class MemoryOperationsRepository implements OperationsRepository {
  private readonly rows: OperationAudit[] = []
  async append(input: Omit<OperationAudit, 'id' | 'createdAt'>) { validateOperationAuditInput(input); const row = { ...input, id: `audit_${randomUUID()}`, createdAt: new Date().toISOString() }; this.rows.push(row); return row }
  async list(workspaceId: string, limit = 100) { return this.rows.filter(row => row.workspaceId === workspaceId).slice(-Math.min(500, Math.max(1, limit))).reverse() }
}

export class PostgresOperationsRepository implements OperationsRepository {
  constructor(private readonly pool: SqlPool) {}
  async append(input: Omit<OperationAudit, 'id' | 'createdAt'>) { validateOperationAuditInput(input); requireWorkspaceScope(input.workspaceId); return withWorkspaceTransaction(this.pool, input.workspaceId, async client => { const result = await client.query<OperationAudit>(`INSERT INTO workspace_operation_audit (id, workspace_id, actor_id, action, resource_type, resource_id, before_json, after_json, reason) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id, workspace_id AS "workspaceId", actor_id AS "actorId", action, resource_type AS "resourceType", resource_id AS "resourceId", before_json AS "before", after_json AS "after", reason, created_at AS "createdAt"`, [randomUUID(), input.workspaceId, input.actorId, input.action, input.resourceType, input.resourceId, input.before, input.after, input.reason]); return result.rows[0]! }) }
  async list(workspaceId: string, limit = 100) { requireWorkspaceScope(workspaceId); return withWorkspaceTransaction(this.pool, workspaceId, async client => { const result = await client.query<OperationAudit>(`SELECT id, workspace_id AS "workspaceId", actor_id AS "actorId", action, resource_type AS "resourceType", resource_id AS "resourceId", before_json AS "before", after_json AS "after", reason, created_at AS "createdAt" FROM workspace_operation_audit WHERE workspace_id=$1 ORDER BY created_at DESC, id DESC LIMIT $2`, [workspaceId, Math.min(500, Math.max(1, limit))]); return result.rows }) }
}
