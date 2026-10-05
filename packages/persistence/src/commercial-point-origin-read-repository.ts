import type { CommercialPointOriginReadPort, CommercialPointOriginView, OnboardingGiftPlanView, OnboardingGiftsView, OnboardingGiftBatchView } from '@merchant-marketing/contracts'
import { commercialCatalogContentHash } from './commercial-catalog-repository.js'
import { requireWorkspaceScope, withWorkspaceTransaction, type SqlPool } from './repository.js'

export const unknownCommercialPointOrigin = (): CommercialPointOriginView => ({ status: 'unknown', kind: null, source_order_id: null, sku_version_id: null, schedule_id: null, sequence: null, grant_id: null })
const timestamp = (value: unknown): string | null => value == null ? null : new Date(String(value)).toISOString()
const positive = (value: unknown): number => { const result = Number(value); if (!Number.isSafeInteger(result) || result <= 0) throw new Error('GIFT_POLICY_INVALID'); return result }
export function projectFrozenGiftPlan(row: { source_order_id: string; source_order_status: string; order_snapshot_id: string; sku: Record<string, unknown>; batches: readonly Record<string, unknown>[] }, observedAt: string): OnboardingGiftPlanView {
  const payload = row.sku.payload as Record<string, unknown> | undefined
  const schedule = payload?.grantSchedule as Record<string, unknown> | undefined
  if (row.sku.kind !== 'onboarding' || !schedule || typeof row.sku.versionId !== 'string' || !row.sku.versionId || typeof row.sku.code !== 'string' || typeof row.sku.checksum !== 'string' || !/^[a-f0-9]{64}$/iu.test(row.sku.checksum)) throw new Error('GIFT_SOURCE_INVALID')
  if (row.sku.lifecycle !== 'approved' || row.sku.executable !== true || !payload?.policyRef || commercialCatalogContentHash({ priceFen: row.sku.priceFen, priceMode: row.sku.priceMode, durationDays: row.sku.durationDays, payload: row.sku.payload, benefits: row.sku.benefits }) !== row.sku.checksum || schedule.cadence !== 'monthly' || schedule.startsAt !== 'payment_verified' || schedule.grantExpiresAtRule !== 'next_monthly_anniversary' || schedule.schedulingStatus !== 'resolved') throw new Error('GIFT_POLICY_UNVERIFIED')
  const count = positive(schedule.grantCount), points = positive(schedule.pointsPerGrant)
  if (!Number.isSafeInteger(count * points) || count > 24 || (['paid', 'refunded'].includes(row.source_order_status) && row.batches.length !== count)) throw new Error('GIFT_SCHEDULE_INCOMPLETE')
  const sequences = new Set<number>()
  const batches: OnboardingGiftBatchView[] = row.batches.map(batch => {
    const sequence = positive(batch.sequence), batchPoints = positive(batch.points)
    if (sequence > count || sequences.has(sequence) || batchPoints !== points || !Array.isArray(batch.blockers) || batch.source_checksum !== row.sku.checksum || batch.blockers.some(value => typeof value !== 'string')) throw new Error('GIFT_SCHEDULE_INCONSISTENT')
    sequences.add(sequence)
    if ((batch.grant_id != null && batch.granted_at == null) || (batch.schedule_status === 'granted' && batch.grant_id == null) || (batch.dispatch_id != null && (batch.dispatched_at == null || batch.grant_id == null)) || (batch.expiration_id != null && batch.expired_at == null)) throw new Error('GIFT_EXECUTION_UNVERIFIED')
    const expiresAt = timestamp(batch.expires_at)
    return { schedule_id: String(batch.schedule_id), sequence, points: batchPoints, due_at: timestamp(batch.due_at), expires_at: expiresAt,
      schedule_status: String(batch.schedule_status), grant_id: batch.grant_id == null ? null : String(batch.grant_id), granted_at: timestamp(batch.granted_at),
      dispatch_id: batch.dispatch_id == null ? null : String(batch.dispatch_id), dispatched_at: timestamp(batch.dispatched_at),
      expiration_id: batch.expiration_id == null ? null : String(batch.expiration_id), expired_at: timestamp(batch.expired_at),
      expired_by_time: expiresAt !== null && Date.parse(expiresAt) <= Date.parse(observedAt), blockers: batch.blockers.map(String) }
  })
  return { source_order_id: row.source_order_id, source_order_status: row.source_order_status, order_snapshot_id: row.order_snapshot_id,
    sku_code: row.sku.code, sku_version_id: row.sku.versionId, source_checksum: row.sku.checksum, policy_ref: payload!.policyRef,
    grant_count: count, points_per_grant: points, total_points: count * points, batches: batches.sort((a, b) => a.sequence - b.sequence) }
}

export class PostgresCommercialPointOriginReadRepository implements CommercialPointOriginReadPort {
  constructor(private readonly pool: SqlPool) {}
  async readOnboardingGifts(workspaceId: string): Promise<OnboardingGiftsView> {
    const scope = requireWorkspaceScope(workspaceId)
    try {
      return await withWorkspaceTransaction(this.pool, scope, async client => {
        const result = await client.query<Parameters<typeof projectFrozenGiftPlan>[0]>(`
          SELECT o.id AS source_order_id,o.status AS source_order_status,s.id AS order_snapshot_id,s.snapshot->'sku' AS sku,
            COALESCE((SELECT jsonb_agg(jsonb_build_object('schedule_id',p.id,'sequence',p.sequence,'points',p.points,
              'due_at',p.due_at,'expires_at',p.expires_at,'schedule_status',p.status,'blockers',p.blockers,
              'source_checksum',p.source_checksum,'grant_id',COALESCE(p.grant_id,d.grant_id),'granted_at',g.created_at,'dispatch_id',d.id,'dispatched_at',d.dispatched_at,
              'expiration_id',COALESCE(x.id,xe.id),'expired_at',COALESCE(x.expired_at,xe.created_at)) ORDER BY p.sequence)
              FROM onboarding_point_grant_schedules_v2 p
              LEFT JOIN onboarding_point_grant_dispatches_v2 d ON d.workspace_id=p.workspace_id AND d.schedule_id=p.id
              LEFT JOIN creative_point_grants g ON g.workspace_id=p.workspace_id AND g.id=COALESCE(p.grant_id,d.grant_id)
              LEFT JOIN onboarding_point_grant_expirations_v2 x ON x.workspace_id=p.workspace_id AND x.schedule_id=p.id
              LEFT JOIN LATERAL(SELECT e.id,e.created_at FROM creative_point_ledger_events e JOIN creative_point_operations op ON op.workspace_id=e.workspace_id AND op.id=e.operation_id WHERE e.workspace_id=p.workspace_id AND e.event_type='expired' AND op.request->>'grant_id'=g.id ORDER BY e.created_at DESC,e.id DESC LIMIT 1) xe ON true
              WHERE p.workspace_id=o.workspace_id AND p.onboarding_order_id=o.id),'[]'::jsonb) AS batches
          FROM commercial_orders_v2 o JOIN commercial_order_snapshots_v2 s ON s.workspace_id=o.workspace_id AND s.order_id=o.id
          WHERE o.workspace_id=$1 AND s.snapshot->'sku'->>'kind'='onboarding'
          ORDER BY o.created_at DESC,o.id DESC LIMIT 101`, [scope])
        if (result.rows.length > 100) throw new Error('GIFT_SOURCE_PAGE_LIMIT')
        return { status: 'available', plans: result.rows.map(row => projectFrozenGiftPlan(row, new Date().toISOString())), blockers: [] }
      })
    } catch { return { status: 'unknown', plans: null, blockers: ['onboarding_gift_source_unavailable'] } }
  }
  async readStatementOrigins(workspaceId: string, entryIds: readonly string[]): Promise<Readonly<Record<string, CommercialPointOriginView>>> {
    const scope = requireWorkspaceScope(workspaceId)
    if (entryIds.length > 100) throw new Error('POINT_ORIGIN_PAGE_INVALID')
    const origins: Record<string, CommercialPointOriginView> = Object.fromEntries(entryIds.map(id => [id, unknownCommercialPointOrigin()]))
    if (!entryIds.length) return origins
    try {
      return await withWorkspaceTransaction(this.pool, scope, async client => {
        const result = await client.query<{ entry_id: string; grant_id: string | null; source_type: string | null; source_order_id: string | null; sku_kind: string | null; sku_version_id: string | null; schedule_id: string | null; sequence: number | null }>(`
          SELECT e.id AS entry_id,g.id AS grant_id,g.source_type, s.order_id AS source_order_id,
            s.snapshot->'sku'->>'kind' AS sku_kind,s.snapshot->'sku'->>'versionId' AS sku_version_id,
            COALESCE(os.id,cs.id) AS schedule_id,COALESCE(os.sequence,cs.sequence) AS sequence
          FROM creative_point_ledger_events e JOIN creative_point_operations op ON op.workspace_id=e.workspace_id AND op.id=e.operation_id
          LEFT JOIN creative_point_grants g ON g.workspace_id=e.workspace_id AND (g.operation_id=e.operation_id OR g.id=op.request->>'grant_id')
          LEFT JOIN onboarding_point_grant_schedules_v2 os ON os.workspace_id=g.workspace_id AND ((g.source_type='onboarding_schedule_v2' AND os.id=g.source_id) OR os.grant_id=g.id)
          LEFT JOIN commercial_point_grant_schedules_v3 cs ON cs.workspace_id=g.workspace_id AND g.source_type='commercial_schedule_v3' AND cs.id=g.source_id
          LEFT JOIN commercial_order_snapshots_v2 s ON s.workspace_id=g.workspace_id AND s.order_id=CASE
            WHEN g.source_type='commercial_order_v2' THEN g.source_id WHEN g.source_type='onboarding_schedule_v2' THEN os.onboarding_order_id
            WHEN g.source_type='commercial_schedule_v3' THEN cs.order_id ELSE NULL END
          WHERE e.workspace_id=$1 AND e.id=ANY($2::text[])`, [scope, entryIds])
        const grouped = new Map<string, typeof result.rows>()
        for (const row of result.rows) grouped.set(row.entry_id, [...(grouped.get(row.entry_id) ?? []), row])
        for (const [entryId, rows] of grouped) {
          if (rows.length !== 1 || !rows[0]?.grant_id) continue
          const row = rows[0]
          const commercial = ['commercial_order_v2', 'onboarding_schedule_v2', 'commercial_schedule_v3'].includes(row.source_type ?? '')
          if (commercial && (!row.source_order_id || !row.sku_version_id || !['onboarding', 'monthly', 'private_trial', 'point_pack'].includes(row.sku_kind ?? ''))) continue
          if (row.source_type === 'onboarding_schedule_v2' && row.sku_kind !== 'onboarding') continue
          const kind = row.sku_kind === 'onboarding' ? 'onboarding_gift' : row.sku_kind === 'monthly' || row.sku_kind === 'private_trial' ? 'subscription_points' : row.sku_kind === 'point_pack' ? 'point_pack' : 'other'
          const sequence = row.sequence == null ? null : positive(row.sequence)
          origins[entryId] = { status: 'known', kind, source_order_id: row.source_order_id, sku_version_id: row.sku_version_id,
            schedule_id: row.schedule_id, sequence, grant_id: row.grant_id }
        }
        return origins
      })
    } catch { return Object.fromEntries(entryIds.map(id => [id, unknownCommercialPointOrigin()])) }
  }
}
