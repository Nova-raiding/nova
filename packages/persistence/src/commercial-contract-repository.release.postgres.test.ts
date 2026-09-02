import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { describe, expect, it } from 'vitest'
import { loadMigrations, MigrationRunner } from './migration.js'
import { PostgresCommercialContractRepository } from './commercial-contract-repository.js'
import { PostgresCreativePointRepository } from './creative-point-repository.js'
import { PostgresCreativePointLifecycleRepository } from './creative-point-lifecycle-repository.js'
import type { CommercialCatalogSkuSnapshot } from './commercial-catalog-repository.js'

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
      const order = await repository.createOrder({ workspaceId: 'ws-commercial', sku, paymentProvider: 'alipay', createdByActorId: 'actor-1', idempotencyKey: 'order-e2', now: '2026-09-02T00:00:00Z' })
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
        (SELECT count(*)::int FROM outbox_events WHERE workspace_id='ws-commercial' AND event_type='commercial.payment_grant_committed') outbox`)
      expect(facts.rows[0]).toEqual({ orders: 1, snapshots: 1, periods: 1, entitlements: 1, payments: 1, grants: 2, decisions: 1, outbox: 1 })
    } finally {
      await app?.end(); await database?.end()
      await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`)
      await admin.end()
    }
  }, 180_000)
})
