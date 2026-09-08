import { randomUUID } from 'node:crypto'
import { requireWorkspaceScope, type SqlClient, type SqlPool, withWorkspaceTransaction } from './repository.js'

export interface OnboardingGrantDispatchResult {
  workspaceId: string
  dispatched: number
  expired: number
  skipped: number
  grantIds: string[]
}

type ScheduleRow = {
  id: string
  workspaceId: string
  onboardingOrderId: string
  entitlementSnapshotId: string
  sequence: number | string
  points: number | string
  dueAt: string | Date
  expiresAt: string | Date
  policyRef: string
  sourceChecksum: string
}

const iso = (value: string | Date) => new Date(value).toISOString()
const integer = (value: number | string, name: string) => {
  const result = Number(value)
  if (!Number.isSafeInteger(result) || result < 1) throw new Error(`${name} must be a positive integer`)
  return result
}

/**
 * Dispatches due onboarding batches without mutating the immutable schedule.
 * A schedule can therefore be retried after a worker crash by replaying the
 * same dispatch idempotency key; the dispatch table is the grant linkage fact.
 */
export class PostgresOnboardingGrantDispatchRepository {
  constructor(private readonly pool: SqlPool) {}

  async dispatchDue(input: { workspaceId: string; now?: string; limit?: number }): Promise<OnboardingGrantDispatchResult> {
    const workspaceId = requireWorkspaceScope(input.workspaceId)
    const now = new Date(input.now ?? new Date().toISOString())
    if (Number.isNaN(now.valueOf())) throw new TypeError('now must be an ISO timestamp')
    const limit = input.limit ?? 25
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new TypeError('limit must be between 1 and 100')
    return withWorkspaceTransaction(this.pool, workspaceId, async client => {
      const schedules = await client.query<ScheduleRow>(
        `SELECT id, workspace_id AS "workspaceId", onboarding_order_id AS "onboardingOrderId",
                entitlement_snapshot_id AS "entitlementSnapshotId", sequence, points,
                due_at AS "dueAt", expires_at AS "expiresAt", policy_ref AS "policyRef",
                source_checksum AS "sourceChecksum"
           FROM onboarding_point_grant_schedules_v2
          WHERE workspace_id=$1 AND status='scheduled' AND blockers='[]'::jsonb
            AND due_at <= $2::timestamptz AND expires_at > $2::timestamptz
            AND policy_ref='commercial.onboarding.v2'
          ORDER BY due_at, sequence, id
          FOR UPDATE SKIP LOCKED LIMIT $3`, [workspaceId, now.toISOString(), limit],
      )
      const expired = await client.query<ScheduleRow>(
        `SELECT id, workspace_id AS "workspaceId", onboarding_order_id AS "onboardingOrderId",
                entitlement_snapshot_id AS "entitlementSnapshotId", sequence, points,
                due_at AS "dueAt", expires_at AS "expiresAt", policy_ref AS "policyRef",
                source_checksum AS "sourceChecksum"
           FROM onboarding_point_grant_schedules_v2 s
          WHERE s.workspace_id=$1 AND s.status='scheduled' AND s.blockers='[]'::jsonb
            AND s.expires_at <= $2::timestamptz AND s.policy_ref='commercial.onboarding.v2'
            AND NOT EXISTS (SELECT 1 FROM onboarding_point_grant_dispatches_v2 d WHERE d.workspace_id=s.workspace_id AND d.schedule_id=s.id)
            AND NOT EXISTS (SELECT 1 FROM onboarding_point_grant_expirations_v2 e WHERE e.workspace_id=s.workspace_id AND e.schedule_id=s.id)
          ORDER BY s.expires_at, s.sequence, s.id
          FOR UPDATE SKIP LOCKED LIMIT $3`, [workspaceId, now.toISOString(), limit],
      )
      let dispatched = 0
      let expiredCount = 0
      let skipped = 0
      const grantIds: string[] = []
      for (const row of expired.rows) {
        const sequence = integer(row.sequence, 'sequence')
        const points = integer(row.points, 'points')
        if (points !== 500) throw new Error('onboarding schedule points must equal 500')
        await client.query(
          `INSERT INTO onboarding_point_grant_expirations_v2
             (id,workspace_id,schedule_id,onboarding_order_id,sequence,points,policy_ref,entitlement_snapshot_id,source_checksum,expired_at,reason,evidence)
           VALUES ($1,$2,$3,$4,$5,$6,'commercial.onboarding.v2',$7,$8,$9::timestamptz,$10,$11::jsonb)
           ON CONFLICT (workspace_id,schedule_id) DO NOTHING`,
          [`opge_${randomUUID()}`, workspaceId, row.id, row.onboardingOrderId, sequence, points, row.entitlementSnapshotId, row.sourceChecksum, iso(row.expiresAt), 'scheduled grant window elapsed before dispatch', JSON.stringify({ schedule_id: row.id, sequence, policy_ref: 'commercial.onboarding.v2' })],
        )
        expiredCount += 1
      }
      for (const row of schedules.rows) {
        const sequence = integer(row.sequence, 'sequence')
        const points = integer(row.points, 'points')
        if (points !== 500) throw new Error('onboarding schedule points must equal 500')
        const idempotencyKey = `onboarding-schedule:${row.id}`
        const existing = await client.query<{ grantId: string }>(`SELECT grant_id AS "grantId" FROM onboarding_point_grant_dispatches_v2 WHERE workspace_id=$1 AND schedule_id=$2`, [workspaceId, row.id])
        if (existing.rows[0]) { skipped += 1; grantIds.push(existing.rows[0].grantId); continue }
        const operationId = `cpo_${randomUUID()}`
        const operation = await client.query<{ id: string }>(
          `INSERT INTO creative_point_operations (id,workspace_id,kind,idempotency_key,status,request,created_at)
           VALUES ($1,$2,'grant',$3,'pending',$4::jsonb,$5::timestamptz)
           ON CONFLICT (workspace_id,kind,idempotency_key) DO NOTHING RETURNING id`,
          [operationId, workspaceId, idempotencyKey, JSON.stringify({ source_type: 'onboarding_schedule_v2', source_id: row.id, points, expires_at: iso(row.expiresAt), policy_ref: row.policyRef }), now.toISOString()],
        )
        if (!operation.rows[0]) {
          const prior = await client.query<{ operationId: string; grantId: string }>(
            `SELECT o.id AS "operationId", g.id AS "grantId"
               FROM creative_point_operations o JOIN creative_point_grants g ON g.workspace_id=o.workspace_id AND g.operation_id=o.id
              WHERE o.workspace_id=$1 AND o.kind='grant' AND o.idempotency_key=$2`, [workspaceId, idempotencyKey],
          )
          if (prior.rows[0]) { skipped += 1; grantIds.push(prior.rows[0].grantId); continue }
          throw new Error('onboarding grant operation exists without its grant fact')
        }
        await client.query(`INSERT INTO creative_point_access_state (workspace_id,available_points,reserved_points,settled_points,revision,updated_at) VALUES ($1,0,0,0,0,$2::timestamptz) ON CONFLICT (workspace_id) DO NOTHING`, [workspaceId, now.toISOString()])
        await client.query(`SELECT workspace_id FROM creative_point_access_state WHERE workspace_id=$1 FOR UPDATE`, [workspaceId])
        const grantId = `cpg_${randomUUID()}`
        const grant = await client.query<{ id: string }>(
          `INSERT INTO creative_point_grants (id,workspace_id,operation_id,source_type,source_id,points,expires_at,metadata,created_at)
           VALUES ($1,$2,$3,'onboarding_schedule_v2',$4,$5,$6::timestamptz,$7::jsonb,$8::timestamptz)
           RETURNING id`, [grantId, workspaceId, operationId, row.id, points, iso(row.expiresAt), JSON.stringify({ schedule_id: row.id, onboarding_order_id: row.onboardingOrderId, sequence, policy_ref: 'commercial.onboarding.v2', entitlement_snapshot_id: row.entitlementSnapshotId, source_checksum: row.sourceChecksum }), now.toISOString()],
        )
        if (!grant.rows[0]) throw new Error('onboarding grant was not created')
        const balance = await client.query<{ available: string | number; reserved: string | number; settled: string | number; revision: string | number }>(
          `UPDATE creative_point_access_state SET available_points=COALESCE(available_points,0)+$2, reserved_points=COALESCE(reserved_points,0), settled_points=COALESCE(settled_points,0), revision=revision+1, updated_at=$3::timestamptz WHERE workspace_id=$1 RETURNING available_points AS available,reserved_points AS reserved,settled_points AS settled,revision`, [workspaceId, points, now.toISOString()],
        )
        const state = balance.rows[0]
        if (!state) throw new Error('creative point access state is unavailable')
        await client.query(`INSERT INTO creative_point_ledger_events (id,workspace_id,operation_id,event_type,points_delta,available_after,reserved_after,settled_after,access_revision,metadata,created_at) VALUES ($1,$2,$3,'granted',$4,$5,$6,$7,$8,$9::jsonb,$10::timestamptz)`, [`cpl_${randomUUID()}`, workspaceId, operationId, points, state.available, state.reserved, state.settled, state.revision, JSON.stringify({ schedule_id: row.id, policy_ref: 'commercial.onboarding.v2' }), now.toISOString()])
        await client.query(`UPDATE creative_point_operations SET status='completed',result=jsonb_build_object('entity_id',$3::text),completed_at=$4::timestamptz WHERE workspace_id=$1 AND id=$2`, [workspaceId, operationId, grantId, now.toISOString()])
        await client.query(`INSERT INTO onboarding_point_grant_dispatches_v2 (id,workspace_id,schedule_id,onboarding_order_id,sequence,grant_id,points,policy_ref,entitlement_snapshot_id,source_checksum,dispatched_at,idempotency_key,evidence) VALUES ($1,$2,$3,$4,$5,$6,$7,'commercial.onboarding.v2',$8,$9,$10::timestamptz,$11,$12::jsonb)`, [`opgd_${randomUUID()}`, workspaceId, row.id, row.onboardingOrderId, sequence, grantId, points, row.entitlementSnapshotId, row.sourceChecksum, now.toISOString(), idempotencyKey, JSON.stringify({ schedule_id: row.id, sequence, policy_ref: 'commercial.onboarding.v2', due_at: iso(row.dueAt), expires_at: iso(row.expiresAt) })])
        dispatched += 1
        grantIds.push(grantId)
      }
      return { workspaceId, dispatched, expired: expiredCount, skipped, grantIds }
    })
  }
}
