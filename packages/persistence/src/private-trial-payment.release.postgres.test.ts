import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { describe, expect, it } from 'vitest'
import { loadMigrations, MigrationRunner } from './migration.js'
import { PostgresCommercialCatalogRepository } from './commercial-catalog-repository.js'
import { PostgresCommercialContractRepository } from './commercial-contract-repository.js'
import { PostgresPrivateTrialConversionRepository } from './private-trial-conversion-repository.js'

const databaseUrlValue = process.env.PERSISTENCE_RELEASE_DATABASE_URL
const postgresIt = databaseUrlValue ? it : it.skip

const databaseUrl = (base: URL, name: string, user?: string, password?: string) => {
  const value = new URL(base)
  value.pathname = `/${name}`
  if (user) value.username = user
  if (password) value.password = password
  return value.toString()
}

describe('private trial payment PostgreSQL release evidence', () => {
  postgresIt('commits invite→approval→v3 order→199900 payment→entitlement→500 grant atomically and replays without duplication', async () => {
    const base = new URL(databaseUrlValue!)
    const databaseName = `private_trial_payment_${randomUUID().replaceAll('-', '')}`
    const admin = new Pool({ connectionString: base.toString() })
    let database: Pool | undefined
    let application: Pool | undefined
    let operations: Pool | undefined
    try {
      await admin.query(`CREATE DATABASE "${databaseName}"`)
      const isolated = new URL(base)
      isolated.pathname = `/${databaseName}`
      database = new Pool({ connectionString: isolated.toString() })
      await new MigrationRunner(database, await loadMigrations()).run()
      await database.query("INSERT INTO workspaces(id,status) VALUES ('ws-private-trial-release','active')")

      const appUrl = new URL(isolated)
      appUrl.username = 'merchant_app'
      appUrl.password = 'merchant_app_local_only'
      application = new Pool({ connectionString: appUrl.toString() })
      const opsUrl = new URL(isolated)
      opsUrl.username = 'merchant_ops'
      opsUrl.password = 'merchant_ops_local_only'
      operations = new Pool({ connectionString: opsUrl.toString() })

      const conversion = new PostgresPrivateTrialConversionRepository(application)
      const catalog = new PostgresCommercialCatalogRepository(operations)
      const contracts = new PostgresCommercialContractRepository(application)
      const now = new Date()
      const invite = await conversion.createInvite({
        workspaceId: 'ws-private-trial-release',
        customerRef: 'customer-private-trial-release',
        expiresAt: new Date(now.valueOf() + 86_400_000).toISOString(),
        actorId: 'ops-invite-issuer',
        idempotencyKey: 'private-trial-release-invite',
        reason: 'release verification private trial invite',
        evidence: { release_test: true },
      })
      const eligibility = await conversion.createEligibility({
        workspaceId: 'ws-private-trial-release',
        customerRef: 'customer-private-trial-release',
        inviteCode: invite.inviteCode!,
        actorId: 'ops-eligibility-creator',
        idempotencyKey: 'private-trial-release-eligibility',
        reason: 'release verification private trial eligibility',
        evidence: { release_test: true },
      })
      await expect(conversion.approveEligibility({
        workspaceId: 'ws-private-trial-release',
        eligibilityId: eligibility.id,
        expectedRevision: eligibility.revision,
        actorId: 'ops-business-approver',
        idempotencyKey: 'private-trial-release-approval',
        reason: 'release verification business approval',
        evidence: { release_test: true, approval_ref: 'private-trial-release' },
      })).resolves.toMatchObject({ status: 'approved_pending_validation', revision: 2 })

      const paidAt = new Date(now.valueOf() + 1_000).toISOString()
      const sku = await catalog.resolveApprovedExecutableSku('private_validation_7d', {
        includePrivate: true,
        capabilities: ['commercial.private_sku.read'],
      })
      expect(sku).toMatchObject({
        code: 'private_validation_7d',
        versionId: 'sku-version-private-validation-7d-v3',
        version: 3,
        priceFen: 199900,
        durationDays: 7,
        lifecycle: 'approved',
        executable: true,
      })

      const order = await contracts.createOrder({
        workspaceId: 'ws-private-trial-release',
        sku,
        paymentProvider: 'manual_transfer',
        createdByActorId: 'ops-order-creator',
        idempotencyKey: 'private-trial-release-order',
        reason: 'release verification 199900 private trial order',
        privateEligibilityId: eligibility.id,
        now: paidAt,
      })
      expect(order).toMatchObject({ amountFen: 199900, currency: 'CNY', status: 'pending', skuVersionId: 'sku-version-private-validation-7d-v3' })

      const payment = {
        workspaceId: 'ws-private-trial-release',
        orderId: order.id,
        provider: 'manual_transfer',
        providerEventId: 'private-trial-release-payment-event',
        providerOrderId: 'private-trial-release-provider-order',
        nonce: 'private-trial-release-nonce',
        payloadHash: 'a'.repeat(64),
        amountFen: 199900,
        currency: 'CNY' as const,
        paidAt,
        paymentSubjectRef: 'private-trial-release-payment-subject',
      }
      const first = await contracts.recordVerifiedPaymentAndGrant(payment)
      expect(first).toMatchObject({ order: { id: order.id, status: 'paid', amountFen: 199900 }, availablePoints: 500, accessRevision: 1, replayed: false })
      const replay = await contracts.recordVerifiedPaymentAndGrant(payment)
      expect(replay).toMatchObject({ order: { id: order.id, status: 'paid' }, availablePoints: 500, accessRevision: 1, replayed: true })

      const facts = await database.query<{
        orders: number
        payments: number
        periods: number
        entitlements: number
        grants: number
        available: number
        revision: number
        paymentEvents: number
        paymentOutbox: number
      }>(`SELECT
          (SELECT count(*)::int FROM commercial_orders_v2 WHERE workspace_id='ws-private-trial-release' AND id=$1) AS orders,
          (SELECT count(*)::int FROM commercial_payment_events_v2 WHERE workspace_id='ws-private-trial-release' AND order_id=$1) AS payments,
          (SELECT count(*)::int FROM workspace_subscription_periods_v2 WHERE workspace_id='ws-private-trial-release' AND status='active') AS periods,
          (SELECT count(*)::int FROM workspace_entitlement_snapshots_v2 WHERE workspace_id='ws-private-trial-release') AS entitlements,
          (SELECT count(*)::int FROM creative_point_grants WHERE workspace_id='ws-private-trial-release' AND source_type='commercial_order_v2' AND source_id=$1) AS grants,
          (SELECT available_points::int FROM creative_point_access_state WHERE workspace_id='ws-private-trial-release') AS available,
          (SELECT revision::int FROM creative_point_access_state WHERE workspace_id='ws-private-trial-release') AS revision,
          (SELECT count(*)::int FROM commercial_payment_events_v2 WHERE workspace_id='ws-private-trial-release' AND provider_event_id=$2) AS "paymentEvents",
          (SELECT count(*)::int FROM outbox_events WHERE workspace_id='ws-private-trial-release' AND aggregate_id=$1 AND event_type='commercial.payment_grant_committed') AS "paymentOutbox"`, [order.id, payment.providerEventId])
      expect(facts.rows[0]).toEqual({ orders: 1, payments: 1, periods: 1, entitlements: 1, grants: 1, available: 500, revision: 1, paymentEvents: 1, paymentOutbox: 1 })

      const entitlement = await database.query<{ periodStart: string; periodEnd: string; benefits: unknown; blockers: unknown; executable: boolean }>(`SELECT p.period_start AS "periodStart", p.period_end AS "periodEnd", e.resolved_benefits AS benefits, e.unresolved_blockers AS blockers, e.executable
        FROM workspace_entitlement_snapshots_v2 e JOIN workspace_subscription_periods_v2 p
          ON p.workspace_id=e.workspace_id AND p.id=e.subscription_period_id
        WHERE e.workspace_id='ws-private-trial-release'`)
      expect(entitlement.rows).toHaveLength(1)
      const snapshot = entitlement.rows[0]!
      expect(Date.parse(snapshot.periodEnd) - Date.parse(snapshot.periodStart)).toBe(7 * 86_400_000)
      expect(snapshot).toMatchObject({ blockers: [], executable: true })
      expect(snapshot.benefits).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: 'max_brands', quantity: 1 }),
        expect.objectContaining({ code: 'max_stores', quantity: 1 }),
        expect.objectContaining({ code: 'creative_points', quantity: 500 }),
      ]))
    } finally {
      await application?.end()
      await operations?.end()
      await database?.end()
      await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1', [databaseName])
      await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`)
      await admin.end()
    }
  }, 240_000)
})
