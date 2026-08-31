import { randomUUID } from 'node:crypto'
import { requireWorkspaceScope, type SqlPool, withWorkspaceTransaction } from './repository.js'

export type OperationalAlertStatus = 'open' | 'acknowledged'
export type OperationalAlertSeverity = 'high' | 'medium'
export type OperationalAlertNotificationDelivery = 'disabled' | 'blocked' | 'delivered' | 'failed'

export interface OperationalAlertNotification {
  delivery: OperationalAlertNotificationDelivery
  attempts: number
  requestId?: string
  reason?: string
  updatedAt: string
}

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
  notification?: OperationalAlertNotification
}

export interface OperationalAlertsRepository {
  upsert(input: Omit<OperationalAlert, 'id' | 'status' | 'acknowledgedBy' | 'acknowledgedAt' | 'acknowledgementReason' | 'updatedAt'>): Promise<OperationalAlert>
  list(workspaceId: string, status?: OperationalAlertStatus, limit?: number): Promise<OperationalAlert[]>
  acknowledge(input: { workspaceId: string; id: string; actorId: string; reason: string }): Promise<OperationalAlert>
  recordNotification(input: { workspaceId: string; alertId: string; delivery: OperationalAlertNotificationDelivery; attempts: number; requestId?: string; reason?: string }): Promise<void>
}

const keyOf = (workspaceId: string, alertKey: string) => `${workspaceId}:${alertKey}`

export class MemoryOperationalAlertsRepository implements OperationalAlertsRepository {
  private readonly rows = new Map<string, OperationalAlert>()
  private readonly notifications = new Map<string, { workspaceId: string; alertId: string; delivery: OperationalAlertNotificationDelivery; attempts: number; requestId?: string; reason?: string; updatedAt: string }>()

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
    return [...this.rows.values()].filter(row => row.workspaceId === workspaceId && (!status || row.status === status)).map(row => {
      const notification = this.notifications.get(`${workspaceId}:${row.id}`)
      return notification ? { ...row, notification: { delivery: notification.delivery, attempts: notification.attempts, ...(notification.requestId ? { requestId: notification.requestId } : {}), ...(notification.reason ? { reason: notification.reason } : {}), updatedAt: notification.updatedAt } } : row
    }).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, Math.min(500, Math.max(1, limit)))
  }

  async acknowledge(input: { workspaceId: string; id: string; actorId: string; reason: string }) {
    const row = [...this.rows.values()].find(item => item.workspaceId === input.workspaceId && item.id === input.id)
    if (!row) throw new Error('OPERATIONAL_ALERT_NOT_FOUND')
    const updated = { ...row, status: 'acknowledged' as const, acknowledgedBy: input.actorId, acknowledgedAt: new Date().toISOString(), acknowledgementReason: input.reason, updatedAt: new Date().toISOString() }
    this.rows.set(keyOf(row.workspaceId, row.alertKey), updated)
    return updated
  }

  async recordNotification(input: { workspaceId: string; alertId: string; delivery: OperationalAlertNotificationDelivery; attempts: number; requestId?: string; reason?: string }) {
    this.notifications.set(`${input.workspaceId}:${input.alertId}`, { ...input, updatedAt: new Date().toISOString() })
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
      // migration 100 keeps alert_id as text for compatibility with older
      // installs while workspace_operation_alerts.id is UUID. Compare using
      // the stable text representation so PostgreSQL does not attempt the
      // invalid text = uuid operator (which would turn every alert read into
      // a 500 and make the Ops Console fail closed with stale data).
      const result = await client.query<OperationalAlert>(`SELECT a.id, a.workspace_id AS "workspaceId", a.alert_key AS "alertKey", a.code, a.severity, a.platform, a.account_id AS "accountId", a.entity_type AS "entityType", a.entity_id AS "entityId", a.title, a.status, a.observed_at AS "observedAt", a.evidence_json AS evidence, a.next_action AS "nextAction", a.acknowledged_by AS "acknowledgedBy", a.acknowledged_at AS "acknowledgedAt", a.acknowledgement_reason AS "acknowledgementReason", a.updated_at AS "updatedAt", CASE WHEN n.alert_id IS NULL THEN NULL ELSE jsonb_build_object('delivery', n.delivery, 'attempts', n.attempts, 'requestId', n.request_id, 'reason', n.reason, 'updatedAt', n.updated_at) END AS notification FROM workspace_operation_alerts a LEFT JOIN workspace_operation_alert_notifications n ON n.workspace_id=a.workspace_id AND n.alert_id=a.id::text WHERE a.workspace_id=$1 AND ($2::text IS NULL OR a.status=$2) ORDER BY a.updated_at DESC, a.id DESC LIMIT $3`, [workspaceId, status ?? null, Math.min(500, Math.max(1, limit))])
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

  async recordNotification(input: { workspaceId: string; alertId: string; delivery: OperationalAlertNotificationDelivery; attempts: number; requestId?: string; reason?: string }) {
    requireWorkspaceScope(input.workspaceId)
    await withWorkspaceTransaction(this.pool, input.workspaceId, async client => {
      await client.query(`INSERT INTO workspace_operation_alert_notifications (workspace_id, alert_id, delivery, attempts, request_id, reason)
        VALUES ($1,$2,$3,$4,$5,$6)
        ON CONFLICT (workspace_id, alert_id) DO UPDATE SET delivery=EXCLUDED.delivery, attempts=EXCLUDED.attempts, request_id=EXCLUDED.request_id, reason=EXCLUDED.reason, updated_at=now()`, [input.workspaceId, input.alertId, input.delivery, input.attempts, input.requestId ?? null, input.reason ?? null])
    })
  }
}
