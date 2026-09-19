import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { Pool, type PoolClient } from 'pg'
import { describe, expect, it } from 'vitest'
import { loadMigrations, MigrationRunner } from './migration.js'
import { PostgresCommercialContractRepository } from './commercial-contract-repository.js'
import { PostgresCreativePointRepository } from './creative-point-repository.js'
import { PostgresCreativePointLifecycleRepository } from './creative-point-lifecycle-repository.js'
import type { CommercialCatalogSkuSnapshot } from './commercial-catalog-repository.js'
import { ContinuousFeatureEntitlementService } from '../../application/src/continuous-feature-entitlement.js'

const databaseUrlValue = process.env.PERSISTENCE_RELEASE_DATABASE_URL
const postgresIt = databaseUrlValue ? it : it.skip
const databaseUrl = (base: URL, name: string, user?: string, password?: string) => { const value = new URL(base); value.pathname = `/${name}`; if (user) value.username = user; if (password) value.password = password; return value.toString() }

describe('commercial contract PostgreSQL E2', () => {
  postgresIt('commits and replays payment→period→entitlement→grant→revision→audit→outbox atomically', async () => {
    const base = new URL(databaseUrlValue!)
    const name = `commercial_contract_e2_${randomUUID().replaceAll('-', '')}`
    const admin = new Pool({ connectionString: base.toString() })
    let database: Pool | undefined
    let app: Pool | undefined
    try {
      await admin.query(`CREATE DATABASE "${name}"`)
      database = new Pool({ connectionString: databaseUrl(base, name) })
      await new MigrationRunner(database, await loadMigrations()).run()
      await database.query("INSERT INTO workspaces(id,status) VALUES ('ws-commercial','active')")
      const sku: CommercialCatalogSkuSnapshot = {
        id: 'sku-monthly-e2', code: 'monthly_e2', kind: 'monthly', visibility: 'public', requiredCapability: null,
        versionId: 'sku-monthly-e2-v1', version: 1, lifecycle: 'approved', executable: true,
        priceFen: 200000, currency: 'CNY', priceMode: 'fixed', durationDays: null, payload: { blockers: [] },
        checksum: 'a'.repeat(64), effectiveAt: '2026-09-01T00:00:00.000Z',
        benefits: [{ code: 'monthly_creative_points', quantity: 5000, rawValue: null, rawUnit: 'creative_points', normalizedValue: null, policyRef: null, metadata: {} }],
      }
      await database.query(`INSERT INTO commercial_catalog_skus(id,code,kind,visibility) VALUES ($1,$2,'monthly','public')`, [sku.id, sku.code])
      await database.query(`INSERT INTO commercial_catalog_sku_versions(id,sku_id,version,lifecycle,executable,price_fen,currency,price_mode,payload,checksum,effective_at) VALUES ($1,$2,1,'approved',true,200000,'CNY','fixed',$3::jsonb,$4,$5)`, [sku.versionId, sku.id, JSON.stringify(sku.payload), sku.checksum, sku.effectiveAt])
      await database.query(`INSERT INTO commercial_catalog_sku_benefits(id,sku_version_id,benefit_code,quantity,raw_unit) VALUES ('benefit-e2',$1,'monthly_creative_points',5000,'creative_points')`, [sku.versionId])
      app = new Pool({ connectionString: databaseUrl(base, name, 'merchant_app', 'merchant_app_local_only') })
      const repository = new PostgresCommercialContractRepository(app)
      const order = await repository.createOrder({ workspaceId: 'ws-commercial', sku, paymentProvider: 'alipay', createdByActorId: 'actor-1', idempotencyKey: 'order-e2', reason: 'subscribe', now: '2026-09-02T00:00:00Z' })
      const payment = { workspaceId: 'ws-commercial', orderId: order.id, provider: 'alipay', providerEventId: 'event-e2', providerOrderId: 'trade-e2', nonce: 'nonce-e2', payloadHash: 'b'.repeat(64), amountFen: 200000, currency: 'CNY' as const, paidAt: '2026-09-02T00:00:00Z', period: { start: '2026-09-02T00:00:00Z', end: '2026-10-02T00:00:00Z' } }
      await expect(repository.recordVerifiedPaymentAndGrant(payment)).resolves.toMatchObject({ availablePoints: 5000, accessRevision: 1, replayed: false })
      await expect(repository.recordVerifiedPaymentAndGrant(payment)).resolves.toMatchObject({ availablePoints: 5000, accessRevision: 1, replayed: true })
      const lifecycle = new PostgresCreativePointLifecycleRepository(app)
      await expect(lifecycle.adjust({ workspaceId: 'ws-commercial', approvalId: 'approval-e2', pointsDelta: 100, expectedAccessRevision: 1, actorId: 'support-maker', approvedByActorId: 'finance-approver', reason: 'approved support correction', evidence: { ticket: 'T-E2' }, idempotencyKey: 'adjust-e2', at: '2026-09-02T00:00:01Z' })).resolves.toMatchObject({ availablePoints: 5100, revision: 2 })
      const points = new PostgresCreativePointRepository(app)
      const reserved = await points.reserve({ workspaceId: 'ws-commercial', idempotencyKey: 'reserve-e2', actionKey: 'image.generate.standard', rateCardVersion: 'rate-approved-e2', points: 10, at: '2026-09-02T00:00:02Z' })
      await points.settle({ workspaceId: 'ws-commercial', reservationId: reserved.value.id, actualPoints: 10, idempotencyKey: 'settle-e2', at: '2026-09-02T00:00:03Z' })
      await expect(lifecycle.reverseSettlement({ workspaceId: 'ws-commercial', reservationId: reserved.value.id, points: 5, kind: 'refund', actorId: 'finance-1', reason: 'verified refund', evidence: { refund: 'R-E2' }, idempotencyKey: 'refund-e2', at: '2026-09-02T00:00:04Z' })).resolves.toMatchObject({ availablePoints: 5095, settledPoints: 5, revision: 5 })
      await lifecycle.recordProviderReceipt({ workspaceId: 'ws-commercial', operationId: reserved.value.operationId, provider: 'relay', providerRequestId: 'relay-e2', outcome: 'unknown', receiptHash: 'c'.repeat(64), at: '2026-09-02T00:00:05Z' })
      await expect(lifecycle.expireGrant({ workspaceId: 'ws-commercial', grantId: (await database.query<{ id: string }>("SELECT id FROM creative_point_grants WHERE workspace_id='ws-commercial' AND source_type='commercial_order_v2'")).rows[0]!.id, idempotencyKey: 'expire-e2', at: '2026-10-02T00:00:00Z' })).resolves.toMatchObject({ availablePoints: 100, settledPoints: 5, revision: 6 })
      const facts = await database.query<{ orders: number; snapshots: number; periods: number; entitlements: number; payments: number; grants: number; decisions: number; outbox: number }>(`SELECT
        (SELECT count(*)::int FROM commercial_orders_v2 WHERE workspace_id='ws-commercial') orders,
        (SELECT count(*)::int FROM commercial_order_snapshots_v2 WHERE workspace_id='ws-commercial') snapshots,
        (SELECT count(*)::int FROM workspace_subscription_periods_v2 WHERE workspace_id='ws-commercial') periods,
        (SELECT count(*)::int FROM workspace_entitlement_snapshots_v2 WHERE workspace_id='ws-commercial') entitlements,
        (SELECT count(*)::int FROM commercial_payment_events_v2 WHERE workspace_id='ws-commercial') payments,
        (SELECT count(*)::int FROM creative_point_grants WHERE workspace_id='ws-commercial') grants,
        (SELECT count(*)::int FROM commercial_access_decisions_v2 WHERE workspace_id='ws-commercial') decisions,
        (SELECT count(*)::int FROM outbox_events WHERE workspace_id='ws-commercial') outbox`)
      expect(facts.rows[0]).toEqual({ orders: 1, snapshots: 1, periods: 1, entitlements: 1, payments: 1, grants: 2, decisions: 2, outbox: 2 })
    } finally {
      await app?.end(); await database?.end()
      let active = 1
      for (let attempt = 0; attempt < 80 && active > 0; attempt += 1) {
        active = Number((await admin.query<{ count: string }>('SELECT count(*)::text AS count FROM pg_stat_activity WHERE datname=$1', [name])).rows[0]?.count ?? 0)
        if (active > 0) await new Promise(resolve => setTimeout(resolve, 25))
      }
      expect(active, `database clients did not close for ${name}`).toBe(0)
      await admin.query(`DROP DATABASE IF EXISTS "${name}"`)
      await admin.end()
    }
  }, 180_000)

  postgresIt('stacks a renewal on the running period instead of locking the paying customer out', async () => {
    const base = new URL(databaseUrlValue!)
    const name = `commercial_renewal_${randomUUID().replaceAll('-', '')}`
    const admin = new Pool({ connectionString: base.toString() })
    let database: Pool | undefined
    let app: Pool | undefined
    try {
      await admin.query(`CREATE DATABASE "${name}"`)
      database = new Pool({ connectionString: databaseUrl(base, name) })
      await new MigrationRunner(database, await loadMigrations()).run()
      await database.query("INSERT INTO workspaces(id,status) VALUES ('ws-renewal','active')")
      // `featureBearingBenefits` only accepts a snapshot as continuous-feature
      // evidence when the benefits carry BOTH codes, so a realistic monthly SKU
      // has to declare them or the test would pass for the wrong reason.
      const sku: CommercialCatalogSkuSnapshot = {
        id: 'sku-monthly-renewal', code: 'monthly_renewal', kind: 'monthly', visibility: 'public', requiredCapability: null,
        versionId: 'sku-monthly-renewal-v1', version: 1, lifecycle: 'approved', executable: true,
        priceFen: 200000, currency: 'CNY', priceMode: 'fixed', durationDays: null, payload: { blockers: [] },
        checksum: 'd'.repeat(64), effectiveAt: '2026-09-01T00:00:00.000Z',
        benefits: [
          { code: 'max_brands', quantity: 3, rawValue: null, rawUnit: 'brands', normalizedValue: null, policyRef: null, metadata: {} },
          { code: 'max_stores', quantity: 3, rawValue: null, rawUnit: 'stores', normalizedValue: null, policyRef: null, metadata: {} },
          { code: 'monthly_creative_points', quantity: 5000, rawValue: null, rawUnit: 'creative_points', normalizedValue: null, policyRef: null, metadata: {} },
        ],
      }
      await database.query(`INSERT INTO commercial_catalog_skus(id,code,kind,visibility) VALUES ($1,$2,'monthly','public')`, [sku.id, sku.code])
      await database.query(`INSERT INTO commercial_catalog_sku_versions(id,sku_id,version,lifecycle,executable,price_fen,currency,price_mode,payload,checksum,effective_at) VALUES ($1,$2,1,'approved',true,200000,'CNY','fixed',$3::jsonb,$4,$5)`, [sku.versionId, sku.id, JSON.stringify(sku.payload), sku.checksum, sku.effectiveAt])
      app = new Pool({ connectionString: databaseUrl(base, name, 'merchant_app', 'merchant_app_local_only') })
      // The deployed migrate entrypoint runs the role bootstrap *after*
      // migrations, and `ensure-app-role.sql` issues a blanket
      // `GRANT ... ON ALL TABLES IN SCHEMA public TO merchant_app`. That grant
      // used to be the only reason the runtime could read
      // `commercial_catalog_sku_versions` at all — migration 146's REVOKE was
      // undone by it. Reproduce the deployed posture rather than the bare
      // post-migration one, or this test exercises a privilege state no
      // environment runs in. The bootstrap now pins the catalog deny list at
      // the end of the script, so the same `ALL TABLES` + `REVOKE` pair is what
      // a real deployment leaves behind and `listEntitlementSnapshots` has to
      // work through migration 223's SECURITY DEFINER projection instead of a
      // catalog join.
      await database.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO merchant_app`)
      await database.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO merchant_app`)
      await database.query(`REVOKE ALL ON TABLE commercial_catalog_skus, commercial_catalog_sku_versions,
        commercial_catalog_sku_benefits, creative_point_rate_card_versions_v2,
        creative_point_rate_rules_v2, commercial_catalog_events_v2 FROM merchant_app`)
      await database.query(`REVOKE ALL ON FUNCTION public.merchant_entitlement_snapshots_v2(integer) FROM PUBLIC`)
      await database.query(`GRANT EXECUTE ON FUNCTION public.merchant_entitlement_snapshots_v2(integer) TO merchant_app`)
      await database.query(`REVOKE ALL ON FUNCTION public.merchant_onboarding_sku_v2() FROM PUBLIC`)
      await database.query(`GRANT EXECUTE ON FUNCTION public.merchant_onboarding_sku_v2() TO merchant_app`)
      const repository = new PostgresCommercialContractRepository(app)

      const subscribe = async (key: string, event: string, paidAt: string, period: { start: string; end: string }) => {
        const order = await repository.createOrder({ workspaceId: 'ws-renewal', sku, paymentProvider: 'alipay', createdByActorId: 'actor-1', idempotencyKey: key, reason: 'subscribe', now: paidAt })
        await repository.recordVerifiedPaymentAndGrant({
          workspaceId: 'ws-renewal', orderId: order.id, provider: 'alipay', providerEventId: event, providerOrderId: `trade-${event}`, nonce: `nonce-${event}`,
          payloadHash: 'e'.repeat(64), amountFen: 200000, currency: 'CNY', paidAt,
          period,
        })
      }
      await subscribe('renewal-order-1', 'renewal-event-1', '2026-09-02T00:00:00.000Z', { start: '2026-09-02T00:00:00.000Z', end: '2026-10-02T00:00:00.000Z' })
      // Renew on 09-20: inside the first month, and with a period the caller
      // derives from the payment instant — the shape `commercialMonthlyPeriod`
      // produces and the one that used to overlap.
      await subscribe('renewal-order-2', 'renewal-event-2', '2026-09-20T00:00:00.000Z', { start: '2026-09-20T00:00:00.000Z', end: '2026-10-20T00:00:00.000Z' })

      const periods = await database.query<{ start: string | Date; end: string | Date }>(
        `SELECT period_start AS start, period_end AS end FROM workspace_subscription_periods_v2 WHERE workspace_id='ws-renewal' ORDER BY period_start`,
      )
      const windows = periods.rows.map(row => [new Date(row.start).toISOString(), new Date(row.end).toISOString()])
      // The renewal starts where the first month ends: the customer keeps the
      // days already paid for, and no two windows overlap.
      expect(windows).toEqual([
        ['2026-09-02T00:00:00.000Z', '2026-10-02T00:00:00.000Z'],
        ['2026-10-02T00:00:00.000Z', '2026-11-02T00:00:00.000Z'],
      ])

      // Both months are on file; the guard must be satisfied by the windows,
      // not by hiding one of them.
      const snapshots = await repository.listEntitlementSnapshots('ws-renewal')
      expect(snapshots.map(snapshot => [snapshot.periodStart, snapshot.periodEnd, snapshot.periodStatus])).toEqual([
        ['2026-10-02T00:00:00.000Z', '2026-11-02T00:00:00.000Z', 'active'],
        ['2026-09-02T00:00:00.000Z', '2026-10-02T00:00:00.000Z', 'active'],
      ])

      // The property that actually matters: the paying customer is not locked
      // out. Two overlapping windows made `decide` return
      // COMMERCIAL_ENTITLEMENT_AMBIGUOUS and denied every non-recovery method.
      const entitlementAt = (iso: string) => new ContinuousFeatureEntitlementService({
        projection: { listV2EntitlementSnapshots: input => repository.listEntitlementSnapshots(input.workspace_id) },
        now: () => new Date(iso),
      })
      await expect(entitlementAt('2026-09-25T00:00:00.000Z').decide({ workspace_id: 'ws-renewal' })).resolves.toMatchObject({ allowed: true, code: 'OK' })
      // ...and stays unlocked once the renewal itself becomes the current month.
      await expect(entitlementAt('2026-10-10T00:00:00.000Z').decide({ workspace_id: 'ws-renewal' })).resolves.toMatchObject({ allowed: true, code: 'OK' })
    } finally {
      await app?.end(); await database?.end()
      let active = 1
      for (let attempt = 0; attempt < 80 && active > 0; attempt += 1) {
        active = Number((await admin.query<{ count: string }>('SELECT count(*)::text AS count FROM pg_stat_activity WHERE datname=$1', [name])).rows[0]?.count ?? 0)
        if (active > 0) await new Promise(resolve => setTimeout(resolve, 25))
      }
      expect(active, `database clients did not close for ${name}`).toBe(0)
      await admin.query(`DROP DATABASE IF EXISTS "${name}"`)
      await admin.end()
    }
  }, 180_000)

  postgresIt('serves entitlements and the onboarding SKU through SECURITY DEFINER projections once the catalog is revoked', async () => {
    const base = new URL(databaseUrlValue!)
    const name = `commercial_projection_${randomUUID().replaceAll('-', '')}`
    const admin = new Pool({ connectionString: base.toString() })
    let database: Pool | undefined
    let app: Pool | undefined
    let unscoped: Pool | undefined
    try {
      await admin.query(`CREATE DATABASE "${name}"`)
      database = new Pool({ connectionString: databaseUrl(base, name) })
      const appUrl = databaseUrl(base, name, 'merchant_app', 'merchant_app_local_only')
      const bootstrap = await readFile(new URL('../../../infra/local/ensure-app-role.sql', import.meta.url), 'utf8')
      // The deployed migrate entrypoint is
      // bootstrap -> migrations -> bootstrap -> verify. The *second* bootstrap
      // is the one whose blanket `GRANT ... ON ALL TABLES IN SCHEMA public` used
      // to re-arm the six catalog base tables that migration 146 revokes, and
      // whose blanket `REVOKE EXECUTE ON ALL FUNCTIONS` strips the projection
      // grant migration 223 installs. Running the real script in that order is
      // the only way this test can fail for the reason a deployment would.
      await database.query(bootstrap)
      await new MigrationRunner(database, await loadMigrations()).run()
      await database.query(bootstrap)

      const revoked = await database.query<Record<string, boolean>>(`SELECT
        has_table_privilege('merchant_app','public.commercial_catalog_skus','SELECT') AS skus,
        has_table_privilege('merchant_app','public.commercial_catalog_sku_versions','SELECT') AS sku_versions,
        has_table_privilege('merchant_app','public.commercial_catalog_sku_benefits','SELECT') AS sku_benefits,
        has_table_privilege('merchant_app','public.creative_point_rate_card_versions_v2','SELECT') AS rate_cards,
        has_table_privilege('merchant_app','public.creative_point_rate_rules_v2','SELECT') AS rate_rules,
        has_table_privilege('merchant_app','public.commercial_catalog_events_v2','SELECT') AS catalog_events,
        has_table_privilege('merchant_app','public.commercial_catalog_skus','INSERT') AS skus_insert,
        has_table_privilege('merchant_ops','public.commercial_catalog_sku_versions','SELECT') AS ops_sku_versions,
        has_table_privilege('merchant_ops','public.commercial_catalog_skus','SELECT') AS ops_skus`)
      expect(revoked.rows[0]).toEqual({
        skus: false, sku_versions: false, sku_benefits: false, rate_cards: false,
        rate_rules: false, catalog_events: false, skus_insert: false,
        // Operations keeps the catalog: 146 grants it and the tenant deny list
        // deliberately does not touch merchant_ops.
        ops_sku_versions: true, ops_skus: true,
      })

      const routines = await database.query<{
        proname: string; prosecdef: boolean; proconfig: string[] | null
        app_execute: boolean; public_execute: boolean; definition: string
      }>(`SELECT p.proname, p.prosecdef, p.proconfig,
            has_function_privilege('merchant_app', p.oid, 'EXECUTE') AS app_execute,
            EXISTS (SELECT 1 FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) acl
                     WHERE acl.grantee = 0 AND acl.privilege_type = 'EXECUTE') AS public_execute,
            pg_get_functiondef(p.oid) AS definition
           FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
          WHERE n.nspname = 'public'
            AND p.proname IN ('merchant_entitlement_snapshots_v2','merchant_onboarding_sku_v2')
          ORDER BY p.proname`)
      expect(routines.rows.map(row => row.proname)).toEqual(['merchant_entitlement_snapshots_v2', 'merchant_onboarding_sku_v2'])
      for (const routine of routines.rows) {
        expect(routine.prosecdef, routine.proname).toBe(true)
        expect(routine.proconfig, routine.proname).toEqual(expect.arrayContaining(['search_path=pg_catalog', 'row_security=off']))
        // The second bootstrap grants EXECUTE back after its blanket revoke.
        expect(routine.app_execute, routine.proname).toBe(true)
        expect(routine.public_execute, routine.proname).toBe(false)
      }
      // `row_security = off` means the function does not inherit the caller's
      // tenant scope from the policy migration 153 created, so the workspace
      // predicate has to live in the function body itself.
      const entitlementDefinition = routines.rows.find(row => row.proname === 'merchant_entitlement_snapshots_v2')!.definition
      expect(entitlementDefinition).toContain("current_setting('app.workspace_id'")
      expect(entitlementDefinition).toContain('workspace_entitlement_snapshots_v2')

      await database.query("INSERT INTO workspaces(id,status) VALUES ('ws-projection-a','active'),('ws-projection-b','active')")
      const sku: CommercialCatalogSkuSnapshot = {
        id: 'sku-monthly-projection', code: 'monthly_projection', kind: 'monthly', visibility: 'public', requiredCapability: null,
        versionId: 'sku-monthly-projection-v1', version: 1, lifecycle: 'approved', executable: true,
        priceFen: 200000, currency: 'CNY', priceMode: 'fixed', durationDays: null, payload: { blockers: [] },
        checksum: 'a'.repeat(64), effectiveAt: '2026-09-01T00:00:00.000Z',
        benefits: [
          { code: 'max_brands', quantity: 3, rawValue: null, rawUnit: 'brands', normalizedValue: null, policyRef: null, metadata: {} },
          { code: 'max_stores', quantity: 3, rawValue: null, rawUnit: 'stores', normalizedValue: null, policyRef: null, metadata: {} },
          { code: 'monthly_creative_points', quantity: 5000, rawValue: null, rawUnit: 'creative_points', normalizedValue: null, policyRef: null, metadata: {} },
        ],
      }
      await database.query(`INSERT INTO commercial_catalog_skus(id,code,kind,visibility) VALUES ($1,$2,'monthly','public')`, [sku.id, sku.code])
      await database.query(`INSERT INTO commercial_catalog_sku_versions(id,sku_id,version,lifecycle,executable,price_fen,currency,price_mode,payload,checksum,effective_at) VALUES ($1,$2,1,'approved',true,200000,'CNY','fixed',$3::jsonb,$4,$5)`, [sku.versionId, sku.id, JSON.stringify(sku.payload), sku.checksum, sku.effectiveAt])
      for (const benefit of sku.benefits) {
        await database.query(`INSERT INTO commercial_catalog_sku_benefits(id,sku_version_id,benefit_code,quantity,raw_unit) VALUES ($1,$2,$3,$4,$5)`, [`benefit-${randomUUID()}`, sku.versionId, benefit.code, benefit.quantity, benefit.rawUnit])
      }

      app = new Pool({ connectionString: appUrl })
      const repository = new PostgresCommercialContractRepository(app)
      const subscribe = async (workspaceId: string, key: string, event: string, paidAt: string, period: { start: string; end: string }) => {
        const order = await repository.createOrder({ workspaceId, sku, paymentProvider: 'alipay', createdByActorId: 'actor-1', idempotencyKey: key, reason: 'subscribe', now: paidAt })
        await repository.recordVerifiedPaymentAndGrant({
          workspaceId, orderId: order.id, provider: 'alipay', providerEventId: event, providerOrderId: `trade-${event}`, nonce: `nonce-${event}`,
          payloadHash: 'c'.repeat(64), amountFen: 200000, currency: 'CNY', paidAt, period,
        })
      }
      await subscribe('ws-projection-a', 'projection-order-a', 'projection-event-a', '2026-09-02T00:00:00.000Z', { start: '2026-09-02T00:00:00.000Z', end: '2026-10-02T00:00:00.000Z' })
      await subscribe('ws-projection-b', 'projection-order-b', 'projection-event-b', '2026-09-03T00:00:00.000Z', { start: '2026-09-03T00:00:00.000Z', end: '2026-10-03T00:00:00.000Z' })

      // A caller that never set `app.workspace_id` must see nothing: the guard
      // is the function's own predicate, not the RLS policy it bypasses.
      unscoped = new Pool({ connectionString: appUrl, max: 1 })
      expect((await unscoped.query<{ count: number }>('SELECT count(*)::int AS count FROM public.merchant_entitlement_snapshots_v2(50)')).rows[0]).toEqual({ count: 0 })

      // The two reads the runtime lost when 146's REVOKE started working.
      const orders = await repository.listOrders('ws-projection-a')
      expect(orders.map(order => [order.workspaceId, order.skuCode])).toEqual([['ws-projection-a', 'monthly_projection']])
      const snapshots = await repository.listEntitlementSnapshots('ws-projection-a')
      expect(snapshots.map(snapshot => [snapshot.workspaceId, snapshot.skuCode, snapshot.periodStatus, snapshot.unresolvedBlockers])).toEqual([
        ['ws-projection-a', 'monthly_projection', 'active', []],
      ])
      // Migration 166 published exactly one approved executable
      // `onboarding_once` version; 146's source row stays a draft.
      const onboarding = await app.query<{ code: string; versionId: string; priceFen: string | number; benefits: { code: string }[] }>(
        `SELECT code, version_id AS "versionId", price_fen AS "priceFen", benefits FROM public.merchant_onboarding_sku_v2()`,
      )
      expect(onboarding.rows).toHaveLength(1)
      expect(onboarding.rows[0]!.code).toBe('onboarding_once')
      expect(onboarding.rows[0]!.versionId).toBe('sku-version-onboarding-once-v2')
      expect(Number(onboarding.rows[0]!.priceFen)).toBe(500000)
      expect(onboarding.rows[0]!.benefits.map(benefit => benefit.code)).toEqual(['grant_count', 'points_per_grant'])

      // And the decision that read path feeds: the paying customer still has
      // continuous feature access from the projection alone.
      await expect(new ContinuousFeatureEntitlementService({
        projection: { listV2EntitlementSnapshots: input => repository.listEntitlementSnapshots(input.workspace_id) },
        now: () => new Date('2026-09-25T00:00:00.000Z'),
      }).decide({ workspace_id: 'ws-projection-a' })).resolves.toMatchObject({ allowed: true, code: 'OK' })

      // Cross-tenant isolation: each scope sees exactly its own snapshot, even
      // though the function runs as a role with `row_security = off`, so the
      // narrowing is the predicate inside the function body and nothing else.
      // `withWorkspaceTransaction` uses SET LOCAL, hence one transaction per
      // probe; a denied statement aborts its transaction, so nothing else may
      // share it.
      const inScope = async <T>(scope: string, work: (client: PoolClient) => Promise<T>): Promise<T> => {
        const scoped = await app!.connect()
        try {
          await scoped.query('BEGIN')
          await scoped.query(`SELECT set_config('app.workspace_id',$1,true)`, [scope])
          const value = await work(scoped)
          await scoped.query('ROLLBACK')
          return value
        } catch (error) {
          await scoped.query('ROLLBACK').catch(() => undefined)
          throw error
        } finally {
          scoped.release()
        }
      }
      for (const scope of ['ws-projection-a', 'ws-projection-b', 'ws-projection-none']) {
        const scoped = await inScope(scope, client => client.query<{ workspace_id: string }>(`SELECT workspace_id FROM public.merchant_entitlement_snapshots_v2(50)`))
        expect(scoped.rows.map(row => row.workspace_id), scope).toEqual(scope === 'ws-projection-none' ? [] : [scope])
      }
      const count = (scope: string, limit: string) => inScope(scope, async client => (await client.query<{ rows: number }>(`SELECT count(*)::int AS rows FROM public.merchant_entitlement_snapshots_v2(${limit})`)).rows[0])
      // The function clamps the caller-supplied limit instead of trusting it.
      expect(await count('ws-projection-a', '0')).toEqual({ rows: 1 })
      expect(await count('ws-projection-a', '100000')).toEqual({ rows: 1 })
      expect(await count('ws-projection-a', 'NULL')).toEqual({ rows: 1 })
      // The catalog base tables stay unreadable for the runtime role even
      // though the projection it is allowed to call reads them.
      for (const statement of [
        'SELECT code FROM public.commercial_catalog_skus LIMIT 1',
        'SELECT id FROM public.commercial_catalog_sku_versions LIMIT 1',
        'SELECT id FROM public.commercial_catalog_sku_benefits LIMIT 1',
        'SELECT id FROM public.creative_point_rate_card_versions_v2 LIMIT 1',
        'SELECT id FROM public.creative_point_rate_rules_v2 LIMIT 1',
        'SELECT id FROM public.commercial_catalog_events_v2 LIMIT 1',
      ]) {
        await inScope('ws-projection-a', async client => {
          await expect(client.query(statement), statement).rejects.toMatchObject({ code: '42501' })
        })
      }
    } finally {
      await unscoped?.end()
      await app?.end(); await database?.end()
      let active = 1
      for (let attempt = 0; attempt < 80 && active > 0; attempt += 1) {
        active = Number((await admin.query<{ count: string }>('SELECT count(*)::text AS count FROM pg_stat_activity WHERE datname=$1', [name])).rows[0]?.count ?? 0)
        if (active > 0) await new Promise(resolve => setTimeout(resolve, 25))
      }
      expect(active, `database clients did not close for ${name}`).toBe(0)
      await admin.query(`DROP DATABASE IF EXISTS "${name}"`)
      await admin.end()
    }
  }, 240_000)

  postgresIt('keeps concurrent grants from producing two overlapping windows', async () => {
    // The invariant the stacking path claims is "exactly one window is
    // authoritative at every instant", and it does not hold under concurrency
    // without serialization: PostgreSQL has no gap lock, so two verifications
    // for one workspace both read the pre-insert row set, neither blocks, and
    // both insert a period — two overlapping `active` windows, and
    // `COMMERCIAL_ENTITLEMENT_AMBIGUOUS` for a customer who just paid. This is
    // what `stackSubscriptionPeriod`'s workspace advisory lock is for, so this
    // test is what keeps it there.
    const base = new URL(databaseUrlValue!)
    const name = `commercial_concurrent_${randomUUID().replaceAll('-', '')}`
    const admin = new Pool({ connectionString: base.toString() })
    let database: Pool | undefined
    let app: Pool | undefined
    try {
      await admin.query(`CREATE DATABASE "${name}"`)
      database = new Pool({ connectionString: databaseUrl(base, name) })
      await new MigrationRunner(database, await loadMigrations()).run()
      await database.query("INSERT INTO workspaces(id,status) VALUES ('ws-concurrent','active')")
      const sku: CommercialCatalogSkuSnapshot = {
        id: 'sku-monthly-concurrent', code: 'monthly_concurrent', kind: 'monthly', visibility: 'public', requiredCapability: null,
        versionId: 'sku-monthly-concurrent-v1', version: 1, lifecycle: 'approved', executable: true,
        priceFen: 200000, currency: 'CNY', priceMode: 'fixed', durationDays: null, payload: { blockers: [] },
        checksum: 'e'.repeat(64), effectiveAt: '2026-01-01T00:00:00.000Z',
        benefits: [
          { code: 'max_brands', quantity: 3, rawValue: null, rawUnit: 'brands', normalizedValue: null, policyRef: null, metadata: {} },
          { code: 'max_stores', quantity: 3, rawValue: null, rawUnit: 'stores', normalizedValue: null, policyRef: null, metadata: {} },
          { code: 'monthly_creative_points', quantity: 5000, rawValue: null, rawUnit: 'creative_points', normalizedValue: null, policyRef: null, metadata: {} },
        ],
      }
      await database.query(`INSERT INTO commercial_catalog_skus(id,code,kind,visibility) VALUES ($1,$2,'monthly','public')`, [sku.id, sku.code])
      await database.query(`INSERT INTO commercial_catalog_sku_versions(id,sku_id,version,lifecycle,executable,price_fen,currency,price_mode,payload,checksum,effective_at) VALUES ($1,$2,1,'approved',true,200000,'CNY','fixed',$3::jsonb,$4,$5)`, [sku.versionId, sku.id, JSON.stringify(sku.payload), sku.checksum, sku.effectiveAt])
      app = new Pool({ connectionString: databaseUrl(base, name, 'merchant_app', 'merchant_app_local_only') })
      await database.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO merchant_app`)
      await database.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO merchant_app`)
      const repository = new PostgresCommercialContractRepository(app)

      const grant = async (key: string, event: string, paidAt: string, period: { start: string; end: string }) => {
        const order = await repository.createOrder({ workspaceId: 'ws-concurrent', sku, paymentProvider: 'alipay', createdByActorId: 'actor-1', idempotencyKey: key, reason: 'subscribe', now: paidAt })
        return repository.recordVerifiedPaymentAndGrant({
          workspaceId: 'ws-concurrent', orderId: order.id, provider: 'alipay', providerEventId: event, providerOrderId: `trade-${event}`, nonce: `nonce-${event}`,
          payloadHash: 'e'.repeat(64), amountFen: 200000, currency: 'CNY', paidAt, period,
        })
      }
      // Two orders paid in the same month, verified at the same moment.
      await Promise.all([
        grant('concurrent-order-1', 'concurrent-event-1', '2026-09-02T00:00:00.000Z', { start: '2026-09-02T00:00:00.000Z', end: '2026-10-02T00:00:00.000Z' }),
        grant('concurrent-order-2', 'concurrent-event-2', '2026-09-20T00:00:00.000Z', { start: '2026-09-20T00:00:00.000Z', end: '2026-10-20T00:00:00.000Z' }),
      ])

      const windows = (await database.query<{ start: string | Date; end: string | Date }>(
        `SELECT period_start AS start, period_end AS end FROM workspace_subscription_periods_v2 WHERE workspace_id='ws-concurrent' ORDER BY period_start`,
      )).rows.map(row => [new Date(row.start).toISOString(), new Date(row.end).toISOString()] as const)
      expect(windows).toHaveLength(2)
      // No two windows may overlap — that is the whole property.
      expect(windows[0]![1] <= windows[1]![0], `windows overlap: ${JSON.stringify(windows)}`).toBe(true)

      const entitlement = new ContinuousFeatureEntitlementService({
        projection: { listV2EntitlementSnapshots: input => repository.listEntitlementSnapshots(input.workspace_id) },
        now: () => new Date('2026-09-25T00:00:00.000Z'),
      })
      await expect(entitlement.decide({ workspace_id: 'ws-concurrent' })).resolves.toMatchObject({ allowed: true, code: 'OK' })
    } finally {
      await app?.end(); await database?.end()
      let active = 1
      for (let attempt = 0; attempt < 80 && active > 0; attempt += 1) {
        active = Number((await admin.query<{ count: string }>('SELECT count(*)::text AS count FROM pg_stat_activity WHERE datname=$1', [name])).rows[0]?.count ?? 0)
        if (active > 0) await new Promise(resolve => setTimeout(resolve, 25))
      }
      expect(active, `database clients did not close for ${name}`).toBe(0)
      await admin.query(`DROP DATABASE IF EXISTS "${name}"`)
      await admin.end()
    }
  }, 240_000)

  postgresIt('grants a renewal that starts after the previous period already ended', async () => {
    // The ordinary renewal: the customer's first month is over before they pay
    // again. This is the case an earlier version of the stacking fix broke — it
    // expired elapsed windows with `revision = revision + 1`, which violates
    // `workspace_entitlement_snapshots_v2_period_fk` (the grant path writes the
    // snapshot with revision 1, so a granted period's revision is an immutable
    // key). The whole payment verification aborted: payment landed, order stuck
    // pending, no period, no points, no payment event, and the provider webhook
    // retried into the same failure forever.
    //
    // It went unnoticed because the renewal test above only covers renewing
    // *inside* the running period, where no window is elapsed and the UPDATE
    // matches nothing.
    const base = new URL(databaseUrlValue!)
    const name = `commercial_renewal_after_end_${randomUUID().replaceAll('-', '')}`
    const admin = new Pool({ connectionString: base.toString() })
    let database: Pool | undefined
    let app: Pool | undefined
    try {
      await admin.query(`CREATE DATABASE "${name}"`)
      database = new Pool({ connectionString: databaseUrl(base, name) })
      await new MigrationRunner(database, await loadMigrations()).run()
      await database.query("INSERT INTO workspaces(id,status) VALUES ('ws-lapse','active')")
      const sku: CommercialCatalogSkuSnapshot = {
        id: 'sku-monthly-lapse', code: 'monthly_lapse', kind: 'monthly', visibility: 'public', requiredCapability: null,
        versionId: 'sku-monthly-lapse-v1', version: 1, lifecycle: 'approved', executable: true,
        priceFen: 200000, currency: 'CNY', priceMode: 'fixed', durationDays: null, payload: { blockers: [] },
        checksum: 'f'.repeat(64), effectiveAt: '2026-01-01T00:00:00.000Z',
        benefits: [
          { code: 'max_brands', quantity: 3, rawValue: null, rawUnit: 'brands', normalizedValue: null, policyRef: null, metadata: {} },
          { code: 'max_stores', quantity: 3, rawValue: null, rawUnit: 'stores', normalizedValue: null, policyRef: null, metadata: {} },
          // `pointBenefit` requires exactly one positive `monthly_creative_points`
          // benefit for a monthly SKU, so the grant cannot proceed without it.
          { code: 'monthly_creative_points', quantity: 5000, rawValue: null, rawUnit: 'creative_points', normalizedValue: null, policyRef: null, metadata: {} },
        ],
      }
      await database.query(`INSERT INTO commercial_catalog_skus(id,code,kind,visibility) VALUES ($1,$2,'monthly','public')`, [sku.id, sku.code])
      await database.query(`INSERT INTO commercial_catalog_sku_versions(id,sku_id,version,lifecycle,executable,price_fen,currency,price_mode,payload,checksum,effective_at) VALUES ($1,$2,1,'approved',true,200000,'CNY','fixed',$3::jsonb,$4,$5)`, [sku.versionId, sku.id, JSON.stringify(sku.payload), sku.checksum, sku.effectiveAt])
      app = new Pool({ connectionString: databaseUrl(base, name, 'merchant_app', 'merchant_app_local_only') })
      await database.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO merchant_app`)
      await database.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO merchant_app`)
      const repository = new PostgresCommercialContractRepository(app)

      const subscribe = async (key: string, event: string, paidAt: string, period: { start: string; end: string }) => {
        const order = await repository.createOrder({ workspaceId: 'ws-lapse', sku, paymentProvider: 'alipay', createdByActorId: 'actor-1', idempotencyKey: key, reason: 'subscribe', now: paidAt })
        await repository.recordVerifiedPaymentAndGrant({
          workspaceId: 'ws-lapse', orderId: order.id, provider: 'alipay', providerEventId: event, providerOrderId: `trade-${event}`, nonce: `nonce-${event}`,
          payloadHash: 'f'.repeat(64), amountFen: 200000, currency: 'CNY', paidAt, period,
        })
        return order.id
      }
      // First month: 2026-05-01 → 2026-06-01. Long over by the time the customer
      // renews, which is what makes the elapsed-window branch run.
      await subscribe('lapse-order-1', 'lapse-event-1', '2026-05-01T00:00:00.000Z', { start: '2026-05-01T00:00:00.000Z', end: '2026-06-01T00:00:00.000Z' })
      const secondOrderId = await subscribe('lapse-order-2', 'lapse-event-2', '2026-09-18T00:00:00.000Z', { start: '2026-09-18T00:00:00.000Z', end: '2026-10-18T00:00:00.000Z' })

      // The whole verification transaction committed: order paid, payment event
      // recorded, both periods on file, and the elapsed one closed.
      const facts = await database.query<{ status: string; periods: number; expired: number; events: number }>(
        `SELECT (SELECT status FROM commercial_orders_v2 WHERE workspace_id='ws-lapse' AND id=$1) AS status,
                (SELECT count(*)::int FROM workspace_subscription_periods_v2 WHERE workspace_id='ws-lapse') AS periods,
                (SELECT count(*)::int FROM workspace_subscription_periods_v2 WHERE workspace_id='ws-lapse' AND status='expired') AS expired,
                (SELECT count(*)::int FROM commercial_payment_events_v2 WHERE workspace_id='ws-lapse') AS events`,
        [secondOrderId],
      )
      expect(facts.rows[0]).toEqual({ status: 'paid', periods: 2, expired: 1, events: 2 })

      // And the customer is entitled on the new window.
      const entitlement = new ContinuousFeatureEntitlementService({
        projection: { listV2EntitlementSnapshots: input => repository.listEntitlementSnapshots(input.workspace_id) },
        now: () => new Date('2026-09-25T00:00:00.000Z'),
      })
      await expect(entitlement.decide({ workspace_id: 'ws-lapse' })).resolves.toMatchObject({ allowed: true, code: 'OK' })
    } finally {
      await app?.end(); await database?.end()
      let active = 1
      for (let attempt = 0; attempt < 80 && active > 0; attempt += 1) {
        active = Number((await admin.query<{ count: string }>('SELECT count(*)::text AS count FROM pg_stat_activity WHERE datname=$1', [name])).rows[0]?.count ?? 0)
        if (active > 0) await new Promise(resolve => setTimeout(resolve, 25))
      }
      expect(active, `database clients did not close for ${name}`).toBe(0)
      await admin.query(`DROP DATABASE IF EXISTS "${name}"`)
      await admin.end()
    }
  }, 240_000)
})
