import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { describe, expect, it, vi } from 'vitest'
import { COMMERCIAL_OPERATION_REGISTRY, type CommercialOperationPolicy } from '@merchant-marketing/contracts'
import { CommercialAccessService } from '../packages/application/src/commercial-access-service.js'
import { PostgresCreativePointRepository } from '../packages/persistence/src/creative-point-repository.js'
import { loadMigrations, MigrationRunner } from '../packages/persistence/src/migration.js'

const databaseUrlValue = process.env.PERSISTENCE_RELEASE_DATABASE_URL
const postgresIt = databaseUrlValue ? it : it.skip
const sideEffectNames = ['outbox', 'queue', 'storage', 'relay', 'scanner', 'connector'] as const
const createEffectSpy = () => vi.fn((_policy: CommercialOperationPolicy) => undefined)

function databaseUrl(base: URL, name: string, user?: string, password?: string) {
  const value = new URL(base)
  value.pathname = `/${name}`
  if (user) value.username = user
  if (password) value.password = password
  return value.toString()
}

async function commercialFactCounts(database: Pool) {
  const result = await database.query<Record<string, string>>(`SELECT
    (SELECT count(*)::text FROM creative_point_operations) AS operations,
    (SELECT count(*)::text FROM creative_point_grants) AS grants,
    (SELECT count(*)::text FROM creative_point_reservations) AS reservations,
    (SELECT count(*)::text FROM creative_point_allocations) AS allocations,
    (SELECT count(*)::text FROM creative_point_ledger_events) AS ledger,
    (SELECT count(*)::text FROM commercial_orders_v2) AS orders,
    (SELECT count(*)::text FROM commercial_payment_events_v2) AS payment_events,
    (SELECT count(*)::text FROM outbox_events) AS outbox`)
  return result.rows[0]
}

describe('commercial zero-side-effect PostgreSQL E2 matrix', () => {
  postgresIt('keeps durable facts and all external ports unchanged for the registry-derived zero/unknown/insufficient matrix', async () => {
    const base = new URL(databaseUrlValue!)
    const databaseName = `commercial_side_effect_e2_${randomUUID().replaceAll('-', '')}`
    const admin = new Pool({ connectionString: base.toString() })
    let database: Pool | undefined
    let app: Pool | undefined
    try {
      await admin.query(`CREATE DATABASE "${databaseName}"`)
      database = new Pool({ connectionString: databaseUrl(base, databaseName) })
      await new MigrationRunner(database, await loadMigrations()).run()
      await database.query("INSERT INTO workspaces(id,status) VALUES ('ws_zero','active'),('ws_unknown','active'),('ws_insufficient','active')")
      app = new Pool({ connectionString: databaseUrl(base, databaseName, 'merchant_app', 'merchant_app_local_only'), max: 12 })
      const points = new PostgresCreativePointRepository(app)
      await points.grant({ workspaceId: 'ws_zero', idempotencyKey: 'grant-zero', sourceType: 'test_approved_adjustment', sourceId: 'zero-seed', points: 1 })
      await points.reserve({ workspaceId: 'ws_zero', idempotencyKey: 'reserve-zero', actionKey: 'test.seed', rateCardVersion: 'test-rate-v1', points: 1 })
      await points.grant({ workspaceId: 'ws_insufficient', idempotencyKey: 'grant-insufficient', sourceType: 'test_approved_adjustment', sourceId: 'insufficient-seed', points: 1 })

      const external = Object.fromEntries(sideEffectNames.map(name => [name, createEffectSpy()])) as Record<typeof sideEffectNames[number], ReturnType<typeof createEffectSpy>>
      const createService = (registry: readonly CommercialOperationPolicy[]) => new CommercialAccessService({
        registry,
        registry_version: 'commercial-side-effect-e2.v1',
        balance_projection: {
          async projectCreativePointBalance({ workspace_id }) {
            const balance = await points.getBalance(workspace_id)
            return balance.availablePoints === null
              ? { state: 'unknown' as const }
              : { state: 'known' as const, available_points: balance.availablePoints, access_revision: String(balance.revision), freshness: 'fresh' as const }
          },
        },
        rate_resolver: { resolveApprovedRate: vi.fn(async () => ({ state: 'approved' as const, quoted_points: 2, rate_card_version: 'test-rate-v1' })) },
        entitlement_projection: { listV2EntitlementSnapshots: vi.fn(async () => { throw new Error('must not be consulted before point rejection') }) },
      })
      const dispatch = async (service: CommercialAccessService, policy: CommercialOperationPolicy, workspaceId: string) => {
        const result = await service.decide({ surface: policy.surface, operation: policy.operation, workspace_id: workspaceId })
        if (result.outcome === 'DECISION' && result.decision.allowed) for (const name of sideEffectNames) (external[name] as unknown as (policy: CommercialOperationPolicy) => void)(policy)
        return result
      }

      const enabledBusiness = COMMERCIAL_OPERATION_REGISTRY.filter(policy =>
        policy.domain === 'COMMERCIAL' && policy.enabled && policy.classification !== 'RECOVERY_CONTROL')
      const before = await commercialFactCounts(database)
      const service = createService(COMMERCIAL_OPERATION_REGISTRY)
      for (const policy of enabledBusiness) {
        await expect(dispatch(service, policy, 'ws_zero')).resolves.toMatchObject({ outcome: 'DECISION', decision: { allowed: false, error_code: 'CREATIVE_POINTS_EXHAUSTED' } })
        await expect(dispatch(service, policy, 'ws_unknown')).resolves.toMatchObject({ outcome: 'DECISION', decision: { allowed: false, error_code: 'CREATIVE_POINTS_UNAVAILABLE' } })
      }

      const enabledCharged = COMMERCIAL_OPERATION_REGISTRY.map(policy =>
        policy.domain === 'COMMERCIAL' && policy.classification === 'POINT_CHARGED' ? { ...policy, enabled: true } : policy)
      const chargedService = createService(enabledCharged)
      for (const policy of enabledCharged.filter(item => item.domain === 'COMMERCIAL' && item.classification === 'POINT_CHARGED')) {
        await expect(dispatch(chargedService, policy, 'ws_insufficient')).resolves.toMatchObject({ outcome: 'DECISION', decision: { allowed: false, error_code: 'CREATIVE_POINTS_INSUFFICIENT' } })
      }

      expect(await commercialFactCounts(database)).toEqual(before)
      for (const effect of Object.values(external)) expect(effect).not.toHaveBeenCalled()
    } finally {
      await app?.end()
      await database?.end()
      await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`)
      await admin.end()
    }
  }, 300_000)
})
