import { randomUUID } from 'node:crypto'
import { requireWorkspaceScope, type SqlPool, withWorkspaceTransaction } from './repository.js'

export type OperationalAlertStatus = 'open' | 'acknowledged'
export type OperationalAlertSeverity = 'high' | 'medium'

export interface OperationalAlert {
  id: string
  workspaceId: string
  alertKey: string
  code: string
  severity: OperationalAlertSeverity
  platform?: string
  accountId?: string
  entityType: string
  entityId: string
  title: string
  status: OperationalAlertStatus
  observedAt: string
  evidence: Record<string, unknown>
  nextAction: string
  acknowledgedBy?: string
  acknowledgedAt?: string
  acknowledgementReason?: string
  updatedAt: string
}

export interface OperationalAlertsRepository {
  upsert(input: Omit<OperationalAlert, 'id' | 'status' | 'acknowledgedBy' | 'acknowledgedAt' | 'acknowledgementReason' | 'updatedAt'>): Promise<OperationalAlert>
  list(workspaceId: string, status?: OperationalAlertStatus, limit?: number): Promise<OperationalAlert[]>
  acknowledge(input: { workspaceId: string; id: string; actorId: string; reason: string }): Promise<OperationalAlert>
}

const keyOf = (workspaceId: string, alertKey: string) => `${workspaceId}:${alertKey}`

export class MemoryOperationalAlertsRepository implements OperationalAlertsRepository {
  private readonly rows = new Map<string, OperationalAlert>()

  async upsert(input: Omit<OperationalAlert, 'id' | 'status' | 'acknowledgedBy' | 'acknowledgedAt' | 'acknowledgementReason' | 'updatedAt'>) {
    const key = keyOf(input.workspaceId, input.alertKey)
    const existing = this.rows.get(key)
    const row: OperationalAlert = {
      ...input,
      id: existing?.id ?? `alert_${randomUUID()}`,
      status: existing?.status ?? 'open',
      ...(existing?.acknowledgedBy ? { acknowledgedBy: existing.acknowledgedBy } : {}),
      ...(existing?.acknowledgedAt ? { acknowledgedAt: existing.acknowledgedAt } : {}),
      ...(existing?.acknowledgementReason ? { acknowledgementReason: existing.acknowledgementReason } : {}),
      updatedAt: new Date().toISOString(),
    }
    this.rows.set(key, row)
    return row
  }

  async list(workspaceId: string, status?: OperationalAlertStatus, limit = 100) {
    return [...this.rows.values()].filter(row => row.workspaceId === workspaceId && (!status || row.status === status)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, Math.min(500, Math.max(1, limit)))
  }

  async acknowledge(input: { workspaceId: string; id: string; actorId: string; reason: string }) {
    const row = [...this.rows.values()].find(item => item.workspaceId === input.workspaceId && item.id === input.id)
    if (!row) throw new Error('OPERATIONAL_ALERT_NOT_FOUND')
    const updated = { ...row, status: 'acknowledged' as const, acknowledgedBy: input.actorId, acknowledgedAt: new Date().toISOString(), acknowledgementReason: input.reason, updatedAt: new Date().toISOString() }
    this.rows.set(keyOf(row.workspaceId, row.alertKey), updated)
    return updated
  }
}

export class PostgresOperationalAlertsRepository implements OperationalAlertsRepository {
  constructor(private readonly pool: SqlPool) {}

  async upsert(input: Omit<OperationalAlert, 'id' | 'status' | 'acknowledgedBy' | 'acknowledgedAt' | 'acknowledgementReason' | 'updatedAt'>) {
    requireWorkspaceScope(input.workspaceId)
    return withWorkspaceTransaction(this.pool, input.workspaceId, async client => {
      const result = await client.query<OperationalAlert>(`INSERT INTO workspace_operation_alerts (id, workspace_id, alert_key, code, severity, platform, account_id, entity_type, entity_id, title, observed_at, evidence_json, next_action)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
        ON CONFLICT (workspace_id, alert_key) DO UPDATE SET code=EXCLUDED.code, severity=EXCLUDED.severity, platform=EXCLUDED.platform, account_id=EXCLUDED.account_id, entity_type=EXCLUDED.entity_type, entity_id=EXCLUDED.entity_id, title=EXCLUDED.title, observed_at=EXCLUDED.observed_at, evidence_json=EXCLUDED.evidence_json, next_action=EXCLUDED.next_action, updated_at=now()
        RETURNING id, workspace_id AS "workspaceId", alert_key AS "alertKey", code, severity, platform, account_id AS "accountId", entity_type AS "entityType", entity_id AS "entityId", title, status, observed_at AS "observedAt", evidence_json AS evidence, next_action AS "nextAction", acknowledged_by AS "acknowledgedBy", acknowledged_at AS "acknowledgedAt", acknowledgement_reason AS "acknowledgementReason", updated_at AS "updatedAt"`, [randomUUID(), input.workspaceId, input.alertKey, input.code, input.severity, input.platform ?? null, input.accountId ?? null, input.entityType, input.entityId, input.title, input.observedAt, input.evidence, input.nextAction])
      return result.rows[0]!
    })
  }

  async list(workspaceId: string, status?: OperationalAlertStatus, limit = 100) {
    requireWorkspaceScope(workspaceId)
    return withWorkspaceTransaction(this.pool, workspaceId, async client => {
      const result = await client.query<OperationalAlert>(`SELECT id, workspace_id AS "workspaceId", alert_key AS "alertKey", code, severity, platform, account_id AS "accountId", entity_type AS "entityType", entity_id AS "entityId", title, status, observed_at AS "observedAt", evidence_json AS evidence, next_action AS "nextAction", acknowledged_by AS "acknowledgedBy", acknowledged_at AS "acknowledgedAt", acknowledgement_reason AS "acknowledgementReason", updated_at AS "updatedAt" FROM workspace_operation_alerts WHERE workspace_id=$1 AND ($2::text IS NULL OR status=$2) ORDER BY updated_at DESC, id DESC LIMIT $3`, [workspaceId, status ?? null, Math.min(500, Math.max(1, limit))])
      return result.rows
    })
  }

  async acknowledge(input: { workspaceId: string; id: string; actorId: string; reason: string }) {
    requireWorkspaceScope(input.workspaceId)
    return withWorkspaceTransaction(this.pool, input.workspaceId, async client => {
      const result = await client.query<OperationalAlert>(`UPDATE workspace_operation_alerts SET status='acknowledged', acknowledged_by=$3, acknowledged_at=now(), acknowledgement_reason=$4, updated_at=now() WHERE workspace_id=$1 AND id=$2 RETURNING id, workspace_id AS "workspaceId", alert_key AS "alertKey", code, severity, platform, account_id AS "accountId", entity_type AS "entityType", entity_id AS "entityId", title, status, observed_at AS "observedAt", evidence_json AS evidence, next_action AS "nextAction", acknowledged_by AS "acknowledgedBy", acknowledged_at AS "acknowledgedAt", acknowledgement_reason AS "acknowledgementReason", updated_at AS "updatedAt"`, [input.workspaceId, input.id, input.actorId, input.reason])
      if (!result.rows[0]) throw new Error('OPERATIONAL_ALERT_NOT_FOUND')
      return result.rows[0]
    })
  }
}
