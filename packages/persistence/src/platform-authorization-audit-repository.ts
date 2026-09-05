import { randomUUID } from 'node:crypto'
import type { SqlClient, SqlPool } from './repository.js'

export type PlatformAuthorizationAuditResult = 'allow' | 'deny'

export interface PlatformAuthorizationAudit {
  id: string
  decisionId: string
  policyVersion: string
  actorId: string
  workbench: 'platform'
  capability: string
  method: string
  result: PlatformAuthorizationAuditResult
  reasonCode: string
  resourceType: string
  resourceId: string
  resourceScope: Record<string, unknown>
  requestId: string
  traceId: string
  evidence: Record<string, unknown>
  createdAt: string
}

export type PlatformAuthorizationAuditInput = Omit<PlatformAuthorizationAudit, 'id' | 'createdAt'> & { id?: string; createdAt?: string }

export interface PlatformAuthorizationAuditRepository {
  append(input: PlatformAuthorizationAuditInput): Promise<PlatformAuthorizationAudit>
  getByDecisionId(decisionId: string): Promise<PlatformAuthorizationAudit | undefined>
  list(input?: { actorId?: string; method?: string; result?: PlatformAuthorizationAuditResult; limit?: number }): Promise<PlatformAuthorizationAudit[]>
}

const text = (value: string, code: string, max = 256) => {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error(code)
  return value.trim()
}
const object = (value: Record<string, unknown>, code: string, maxBytes = 32_768) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(code)
  const serialized = JSON.stringify(value)
  if (serialized === undefined || Buffer.byteLength(serialized, 'utf8') > maxBytes) throw new Error(code)
  return structuredClone(value)
}
const instant = (value: string) => {
  if (!Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) throw new Error('PLATFORM_AUTHZ_AUDIT_TIMESTAMP_INVALID')
  return value
}
const limitValue = (value?: number) => {
  const limit = value ?? 100
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) throw new RangeError('PLATFORM_AUTHZ_AUDIT_LIMIT_INVALID')
  return limit
}
const validate = (input: PlatformAuthorizationAuditInput): PlatformAuthorizationAudit => ({
  id: input.id ? text(input.id, 'PLATFORM_AUTHZ_AUDIT_ID_INVALID') : randomUUID(),
  decisionId: text(input.decisionId, 'PLATFORM_AUTHZ_AUDIT_DECISION_ID_REQUIRED'),
  policyVersion: text(input.policyVersion, 'PLATFORM_AUTHZ_AUDIT_POLICY_VERSION_REQUIRED', 128),
  actorId: text(input.actorId, 'PLATFORM_AUTHZ_AUDIT_ACTOR_ID_REQUIRED'),
  workbench: input.workbench === 'platform' ? 'platform' : (() => { throw new Error('PLATFORM_AUTHZ_AUDIT_WORKBENCH_INVALID') })(),
  capability: text(input.capability, 'PLATFORM_AUTHZ_AUDIT_CAPABILITY_REQUIRED', 128),
  method: text(input.method, 'PLATFORM_AUTHZ_AUDIT_METHOD_REQUIRED', 128),
  result: input.result === 'allow' || input.result === 'deny' ? input.result : (() => { throw new Error('PLATFORM_AUTHZ_AUDIT_RESULT_INVALID') })(),
  reasonCode: text(input.reasonCode, 'PLATFORM_AUTHZ_AUDIT_REASON_REQUIRED', 128),
  resourceType: text(input.resourceType, 'PLATFORM_AUTHZ_AUDIT_RESOURCE_TYPE_REQUIRED', 128),
  resourceId: text(input.resourceId, 'PLATFORM_AUTHZ_AUDIT_RESOURCE_ID_REQUIRED'),
  resourceScope: object(input.resourceScope, 'PLATFORM_AUTHZ_AUDIT_SCOPE_INVALID'),
  requestId: text(input.requestId, 'PLATFORM_AUTHZ_AUDIT_REQUEST_ID_REQUIRED'),
  traceId: text(input.traceId, 'PLATFORM_AUTHZ_AUDIT_TRACE_ID_REQUIRED'),
  evidence: object(input.evidence, 'PLATFORM_AUTHZ_AUDIT_EVIDENCE_INVALID'),
  createdAt: instant(input.createdAt ?? new Date().toISOString()),
})

const clone = <T>(value: T): T => structuredClone(value)
const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`
  }
  return JSON.stringify(value)
}
const sameDecision = (left: PlatformAuthorizationAudit, right: PlatformAuthorizationAudit) => canonicalJson({
  decisionId: left.decisionId, policyVersion: left.policyVersion, actorId: left.actorId, workbench: left.workbench,
  capability: left.capability, method: left.method, result: left.result, reasonCode: left.reasonCode,
  resourceType: left.resourceType, resourceId: left.resourceId, resourceScope: left.resourceScope,
  requestId: left.requestId, traceId: left.traceId, evidence: left.evidence,
}) === canonicalJson({
  decisionId: right.decisionId, policyVersion: right.policyVersion, actorId: right.actorId, workbench: right.workbench,
  capability: right.capability, method: right.method, result: right.result, reasonCode: right.reasonCode,
  resourceType: right.resourceType, resourceId: right.resourceId, resourceScope: right.resourceScope,
  requestId: right.requestId, traceId: right.traceId, evidence: right.evidence,
})

export class PlatformAuthorizationAuditConflictError extends Error {
  readonly code = 'PLATFORM_AUTHZ_AUDIT_DECISION_CONFLICT'
  constructor() { super('authorization decision id was reused with different audit facts'); this.name = 'PlatformAuthorizationAuditConflictError' }
}

export class PlatformAuthorizationAuditConnectionProbeError extends Error {
  readonly code = 'PLATFORM_AUTHZ_AUDIT_CONNECTION_PROBE_FAILED'
  constructor() {
    super('platform authorization audit requires the merchant_ops role and platform_ops session scope')
    this.name = 'PlatformAuthorizationAuditConnectionProbeError'
  }
}

export class MemoryPlatformAuthorizationAuditRepository implements PlatformAuthorizationAuditRepository {
  private readonly rows = new Map<string, PlatformAuthorizationAudit>()
  async append(input: PlatformAuthorizationAuditInput) {
    const row = validate(input)
    const existing = this.rows.get(row.decisionId)
    if (existing) {
      if (!sameDecision(existing, row)) throw new PlatformAuthorizationAuditConflictError()
      return clone(existing)
    }
    this.rows.set(row.decisionId, row)
    return clone(row)
  }
  async getByDecisionId(decisionId: string) {
    return clone(this.rows.get(text(decisionId, 'PLATFORM_AUTHZ_AUDIT_DECISION_ID_REQUIRED')))
  }
  async list(input: { actorId?: string; method?: string; result?: PlatformAuthorizationAuditResult; limit?: number } = {}) {
    const limit = limitValue(input.limit)
    if (input.actorId) text(input.actorId, 'PLATFORM_AUTHZ_AUDIT_ACTOR_ID_INVALID')
    if (input.method) text(input.method, 'PLATFORM_AUTHZ_AUDIT_METHOD_INVALID', 128)
    const rows = [...this.rows.values()]
      .filter(row => (!input.actorId || row.actorId === input.actorId) && (!input.method || row.method === input.method) && (!input.result || row.result === input.result))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id))
    return rows.slice(0, limit).map(clone)
  }
}

type AuditRow = Omit<PlatformAuthorizationAudit, 'decisionId' | 'policyVersion' | 'actorId' | 'reasonCode' | 'resourceType' | 'resourceId' | 'resourceScope' | 'requestId' | 'traceId' | 'createdAt'> & {
  decision_id: string; policy_version: string; actor_id: string; reason_code: string; resource_type: string; resource_id: string; resource_scope: Record<string, unknown>; request_id: string; trace_id: string; created_at: string | Date
}
const projection = 'id,decision_id,policy_version,actor_id,workbench,capability,method,result,reason_code,resource_type,resource_id,resource_scope,request_id,trace_id,evidence,created_at'
const map = (row: AuditRow): PlatformAuthorizationAudit => ({ id: row.id, decisionId: row.decision_id, policyVersion: row.policy_version, actorId: row.actor_id, workbench: 'platform', capability: row.capability, method: row.method, result: row.result, reasonCode: row.reason_code, resourceType: row.resource_type, resourceId: row.resource_id, resourceScope: clone(row.resource_scope), requestId: row.request_id, traceId: row.trace_id, evidence: clone(row.evidence), createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at })

async function withPlatformTransaction<T>(pool: SqlPool, callback: (client: SqlClient) => Promise<T>) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(`SELECT set_config('app.platform_scope', 'platform_ops', true)`)
    const probe = await client.query<{ current_user?: unknown; platform_scope?: unknown }>(
      `SELECT current_user AS current_user, current_setting('app.platform_scope', true) AS platform_scope`,
    )
    const identity = probe.rows[0]
    if (probe.rows.length !== 1 || identity?.current_user !== 'merchant_ops' || identity.platform_scope !== 'platform_ops') {
      throw new PlatformAuthorizationAuditConnectionProbeError()
    }
    const value = await callback(client)
    await client.query('COMMIT')
    return value
  } catch (error) {
    try { await client.query('ROLLBACK') } catch { /* preserve original */ }
    throw error
  } finally { client.release?.() }
}

export class PostgresPlatformAuthorizationAuditRepository implements PlatformAuthorizationAuditRepository {
  constructor(private readonly pool: SqlPool) {}
  async append(input: PlatformAuthorizationAuditInput) {
    const row = validate(input)
    return withPlatformTransaction(this.pool, async client => {
      const result = await client.query<AuditRow>(`INSERT INTO platform_authorization_audit (${projection}) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14,$15::jsonb,$16) ON CONFLICT (decision_id) DO NOTHING RETURNING ${projection}`, [row.id, row.decisionId, row.policyVersion, row.actorId, row.workbench, row.capability, row.method, row.result, row.reasonCode, row.resourceType, row.resourceId, JSON.stringify(row.resourceScope), row.requestId, row.traceId, JSON.stringify(row.evidence), row.createdAt])
      if (result.rows[0]) return map(result.rows[0])
      const existing = await client.query<AuditRow>(`SELECT ${projection} FROM platform_authorization_audit WHERE decision_id=$1`, [row.decisionId])
      if (!existing.rows[0]) throw new Error('PLATFORM_AUTHZ_AUDIT_APPEND_FAILED')
      const existingValue = map(existing.rows[0])
      if (!sameDecision(existingValue, row)) throw new PlatformAuthorizationAuditConflictError()
      return existingValue
    })
  }
  async getByDecisionId(decisionId: string) {
    const value = text(decisionId, 'PLATFORM_AUTHZ_AUDIT_DECISION_ID_REQUIRED')
    return withPlatformTransaction(this.pool, async client => { const result = await client.query<AuditRow>(`SELECT ${projection} FROM platform_authorization_audit WHERE decision_id=$1`, [value]); return result.rows[0] ? map(result.rows[0]) : undefined })
  }
  async list(input: { actorId?: string; method?: string; result?: PlatformAuthorizationAuditResult; limit?: number } = {}) {
    const limit = limitValue(input.limit); const actorId = input.actorId ? text(input.actorId, 'PLATFORM_AUTHZ_AUDIT_ACTOR_ID_INVALID') : undefined; const method = input.method ? text(input.method, 'PLATFORM_AUTHZ_AUDIT_METHOD_INVALID', 128) : undefined
    return withPlatformTransaction(this.pool, async client => { const result = await client.query<AuditRow>(`SELECT ${projection} FROM platform_authorization_audit WHERE ($1::text IS NULL OR actor_id=$1) AND ($2::text IS NULL OR method=$2) AND ($3::text IS NULL OR result=$3) ORDER BY created_at DESC,id DESC LIMIT $4`, [actorId ?? null, method ?? null, input.result ?? null, limit]); return result.rows.map(map) })
  }
}
