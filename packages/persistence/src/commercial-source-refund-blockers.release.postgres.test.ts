import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PostgresCommercialCatalogRepository, type CommercialCatalogBenefit, type CommercialCatalogSkuSnapshot } from './commercial-catalog-repository.js'
import { PostgresCommercialContractRepository, type CommercialOrderV2 } from './commercial-contract-repository.js'
import { PostgresServiceFulfillmentRepository } from './service-fulfillment-repository.js'
import { PostgresCreativePointRepository } from './creative-point-repository.js'
import { PostgresCreativePointLifecycleRepository } from './creative-point-lifecycle-repository.js'
import { PostgresCommercialRefundRepository } from './commercial-refund-repository.js'
import { loadMigrations, MigrationRunner } from './migration.js'

const source = process.env.PERSISTENCE_RELEASE_DATABASE_URL
let firstAt: string
let halfAt: string
const digest = 'a'.repeat(64)
const benefit = (code: string, quantity: number, unit: string): CommercialCatalogBenefit => ({ code, quantity, normalizedValue: quantity, rawValue: null, rawUnit: unit, policyRef: 'approved-isolated-test-policy', metadata: {} })

/** New DB inside the launcher-owned container, complete immutable migration
 * chain and actual post-migration role bootstrap. No .env/shared DB fallback. */
describe.skipIf(!source)('commercial source refund blockers PostgreSQL acceptance', () => {
  const name = `source_refund_${randomUUID().replaceAll('-', '')}`
  let admin: Pool, db: Pool, app: Pool, ops: Pool
  let catalog: PostgresCommercialCatalogRepository, transactions: PostgresCommercialContractRepository
  let opening: CommercialCatalogSkuSnapshot, basic: CommercialCatalogSkuSnapshot
  beforeAll(async () => {
    admin = new Pool({ connectionString: source!, connectionTimeoutMillis: 10000 })
    await admin.query(`CREATE DATABASE "${name}"`)
    const connection = new URL(source!); connection.pathname = `/${name}`
    db = new Pool({ connectionString: connection.toString(), max: 6 })
    await new MigrationRunner(db, await loadMigrations()).run()
    await db.query(await readFile(new URL('../../../infra/local/ensure-app-role.sql', import.meta.url), 'utf8'))
    const roleConnection = (role: string) => { const v = new URL(connection); v.username = role; v.password = `${role}_local_only`; return v.toString() }
    app = new Pool({ connectionString: roleConnection('merchant_app'), max: 8 })
    ops = new Pool({ connectionString: roleConnection('merchant_ops'), max: 4 })
    catalog = new PostgresCommercialCatalogRepository(ops)
    transactions = new PostgresCommercialContractRepository(app)
    const publish = async (code: string, kind: CommercialCatalogSkuSnapshot['kind'], priceFen: number, points: number, rank?: number) => {
      const payload = { blockers: [], sourceRecoveryPolicy: { approved: true, version: 'owned-source-recovery-v1', effect: 'cancel_contract' }, purchasePolicy: { approved: true, version: 'cash-window-isolated-v1', expiresInSeconds: 604800 },
        ...(kind === 'onboarding' ? { policyRef: { policyId: 'commercial.onboarding', version: 'v2' }, grantSchedule: { policyRef: { policyId: 'commercial.onboarding', version: 'v2' }, grantCount: 6, pointsPerGrant: 500, cadence: 'monthly', timezone: 'UTC', startsAt: 'payment_verified', grantExpiresAtRule: 'next_monthly_anniversary', schedulingStatus: 'resolved' } } : { cycle: { unit: 'month', count: 1 }, planFamily: 'isolated-standard', tierRank: rank, upgradePolicy: { approved: true, version: 'remaining-period-isolated-v1' } }) }
      const benefits = kind === 'onboarding' ? [benefit('creative_points', 500, 'point')] : [benefit('monthly_creative_points', points, 'point'), benefit('max_brands', rank!, 'brand'), benefit('max_stores', rank! * 5, 'store'), benefit('feature.image_generation', 0, 'permission'), benefit('one_to_one_service_hours', 5, 'hour')]
      await catalog.mutate({ action: 'create', code, kind, priceFen, payload, benefits, expectedRevision: 0, idempotencyKey: `${code}:create`, actorId: 'catalog-maker', reason: 'owned QA approved fixture', evidence: {} })
      const approved = await catalog.mutate({ action: 'approve', code, expectedRevision: 1, idempotencyKey: `${code}:approve`, actorId: 'catalog-approver', reason: 'owned QA approved fixture', evidence: { approval_ref: 'test-only' } })
      return catalog.mutate({ action: 'publish', code, versionId: approved.versionId, expectedRevision: 2, idempotencyKey: `${code}:publish`, actorId: 'publisher', reason: 'owned QA approved fixture', evidence: {} })
    }
    opening = await publish('qa-opening', 'onboarding', 500000, 500)
    basic = await publish('qa-basic', 'monthly', 200000, 5000, 1)
    // Payment/checkout starts after publication using the actual database clock.
    // The service period is already active when real Ops fulfillment executes.
    const activation = (await db.query<{ at: Date }>('SELECT clock_timestamp() AS at')).rows[0]!.at.toISOString()
    firstAt = activation; halfAt = activation
  }, 300000)
  afterAll(async () => {
    const closures = await Promise.allSettled([app?.end(),ops?.end(),db?.end()])
    if (admin) {
      try {
        for (const closure of closures) if (closure.status === 'rejected') throw closure.reason
        let active = 1
        for (let attempt = 0; attempt < 100 && active > 0; attempt += 1) {
          active = Number((await admin.query<{ count: string }>('SELECT count(*)::text AS count FROM pg_stat_activity WHERE datname=$1',[name])).rows[0]!.count)
          if (active > 0) await new Promise(resolve=>setTimeout(resolve,25))
        }
        expect(active,`owned database clients did not exit for ${name}`).toBe(0)
        await admin.query(`DROP DATABASE IF EXISTS "${name}"`)
      } finally { await admin.end() }
    }
  }, 60000)
  const workspace = async (label: string) => { const id = `${label}-${randomUUID()}`; await db.query("INSERT INTO workspaces(id,status) VALUES($1,'active')", [id]); return id }
  const first = (workspaceId: string, key: string) => transactions.createFirstCheckout({ workspaceId, actorId: 'buyer', onboardingSku: opening, subscriptionSku: basic, paymentProvider: 'manual_transfer', idempotencyKey: key, reason: 'owned QA first purchase', now: firstAt })
  const pay = (workspaceId: string, order: CommercialOrderV2, at: string, verifiedAt = at) => transactions.recordVerifiedPaymentAndGrant({ workspaceId, orderId: order.id, provider: 'manual_transfer', providerOrderId: `bank:${order.id}`, providerEventId: `cash:${order.id}`, nonce: `nonce:${order.id}`, payloadHash: digest, amountFen: order.amountFen, currency: 'CNY', paidAt: at, verifiedAt })
  const activate = async (workspaceId: string, key: string) => { const checkout = await first(workspaceId, key); await pay(workspaceId, checkout.onboarding, firstAt); await pay(workspaceId, checkout.subscription, firstAt); return checkout }
  const create = (workspaceId: string, sku: CommercialCatalogSkuSnapshot, key: string, purchaseKind: 'renewal' | 'upgrade', now = halfAt, upgradeQuoteId?: string) => transactions.createOrder({ workspaceId, sku, idempotencyKey: key, createdByActorId: 'buyer', paymentProvider: 'manual_transfer', reason: 'owned QA purchase intent', purchaseKind, now, upgradeQuoteId })

  const refunds = () => new PostgresCommercialRefundRepository(ops, (client, input) => transactions.preflightSourceRecoveryInTransaction(client, input))
  const request = (repo: PostgresCommercialRefundRepository, ws: string, order: CommercialOrderV2, requestId: string, pointsToRevoke: number) => repo.request({ workspaceId: ws, orderId: order.id, requestId, refundKind: 'monthly_unused_points', amountFen: order.amountFen, pointsToRevoke, reason: 'source recovery test', actorId: 'maker', evidence: { supplement_agreement_ref: 'test-only-agreement' }, at: halfAt })
  const approve = (repo: PostgresCommercialRefundRepository, ws: string, requestId: string) => repo.approve({ workspaceId: ws, requestId, actorId: 'finance', reason: 'review source recovery', policyApproval: { policy_version: 'owned-source-recovery-v1', legal_review_ref: 'test-only-law' }, at: halfAt })
  const unchanged = async (ws: string, requestId: string, repo: PostgresCommercialRefundRepository) => {
    expect(await repo.latest(ws, requestId)).toMatchObject({ eventType: 'requested' })
    expect((await db.query('SELECT state FROM commercial_source_recovery_holds_v3 WHERE workspace_id=$1', [ws])).rows).toEqual([])
    expect((await db.query('SELECT points_delta FROM creative_point_adjustments_v2 WHERE workspace_id=$1', [ws])).rows).toEqual([])
    expect((await db.query('SELECT status FROM workspace_subscription_periods_v2 WHERE workspace_id=$1', [ws])).rows).toEqual([{ status: 'active' }])
    expect((await new PostgresCreativePointRepository(app).getBalance(ws)).availablePoints).toBe(5500)
  }

  it.each(['scheduled', 'completed'] as const)('blocks cancellation after real source service is %s, without revoking points or committing external cash', async state => {
    const ws = await workspace(`service-${state}`), checkout = await activate(ws, `service-${state}`)
    const sourceRow = (await db.query(`SELECT os.id AS "orderSnapshotId",es.id AS "entitlementSnapshotId",os.checksum,p.period_start AS "periodStart",p.period_end AS "periodEnd" FROM commercial_order_snapshots_v2 os JOIN workspace_subscription_periods_v2 p ON p.workspace_id=os.workspace_id AND p.order_snapshot_id=os.id JOIN workspace_entitlement_snapshots_v2 es ON es.workspace_id=p.workspace_id AND es.subscription_period_id=p.id AND es.subscription_period_revision=p.revision WHERE os.workspace_id=$1 AND os.order_id=$2`, [ws, checkout.subscription.id])).rows[0]
    expect(sourceRow).toBeDefined()
    const services = new PostgresServiceFulfillmentRepository(ops)
    let allocation = await services.createAllocation({ workspaceId: ws, expectedRevision: 0, idempotencyKey: 'real-service', orderSnapshotId: sourceRow.orderSnapshotId, entitlementSnapshotId: sourceRow.entitlementSnapshotId, serviceType: 'one_to_one_service_hours', unit: 'minute', allocatedQuantity: 60, sourceChecksum: sourceRow.checksum, periodStart: sourceRow.periodStart.toISOString(), periodEnd: sourceRow.periodEnd.toISOString(), actorId: 'service-ops', reason: 'bind actual source service', evidence: { agreement_ref: 'test-service-agreement' } })
    await expect(services.createAllocation({ workspaceId: ws, expectedRevision: 0, idempotencyKey: 'service-over-quota', orderSnapshotId: sourceRow.orderSnapshotId, entitlementSnapshotId: sourceRow.entitlementSnapshotId, serviceType: 'one_to_one_service_hours', unit: 'minute', allocatedQuantity: 301, sourceChecksum: sourceRow.checksum, actorId: 'service-ops', reason: 'prove frozen source quota', evidence: { agreement_ref: 'test-service-agreement' } })).rejects.toMatchObject({ code: 'SERVICE_FULFILLMENT_QUOTA_EXCEEDED' })
    await expect(services.createAllocation({ workspaceId: ws, expectedRevision: 0, idempotencyKey: 'service-wrong-source', orderSnapshotId: sourceRow.orderSnapshotId, entitlementSnapshotId: sourceRow.entitlementSnapshotId, serviceType: 'one_to_one_service_hours', unit: 'minute', allocatedQuantity: 1, sourceChecksum: '0'.repeat(64), actorId: 'service-ops', reason: 'prove source checksum binding', evidence: { agreement_ref: 'test-service-agreement' } })).rejects.toMatchObject({ code: 'SERVICE_ALLOCATION_SOURCE_INVALID' })
    const event = (type: 'scheduled'|'started'|'completed') => services.appendEvent({ workspaceId: ws, allocationId: allocation.id, expectedRevision: allocation.revision, idempotencyKey: `service-${type}`, type, actorId: 'service-ops', reason: 'actual source service event', scheduleAt: type === 'scheduled' ? halfAt : null, actualQuantity: type === 'completed' ? 30 : null, evidence: { service_evidence_ref: `test-${type}` } })
    allocation = (await event('scheduled')).allocation
    if (state === 'completed') { allocation = (await event('started')).allocation; allocation = (await event('completed')).allocation }
    expect(allocation).toMatchObject({ status: state, usedQuantity: state === 'completed' ? 30 : 0 })
    expect((await db.query("SELECT has_table_privilege('merchant_app','workspace_service_allocations','INSERT') allowed")).rows[0].allowed).toBe(false)
    const roleClient = await ops.connect()
    try {
      await roleClient.query('BEGIN'); await roleClient.query("SELECT set_config('app.workspace_id',$1,true)",[ws])
      await expect(roleClient.query('UPDATE workspace_service_fulfillment_events SET reason=reason WHERE workspace_id=$1',[ws])).rejects.toMatchObject({code:'42501'})
      await roleClient.query('ROLLBACK')
      await roleClient.query('BEGIN'); await roleClient.query("SELECT set_config('app.workspace_id',$1,true)",['unrelated-empty-workspace'])
      expect((await roleClient.query('SELECT id FROM workspace_service_allocations')).rows).toEqual([])
      expect((await roleClient.query('SELECT id FROM workspace_service_fulfillment_events')).rows).toEqual([])
      await roleClient.query('ROLLBACK')
    } finally { roleClient.release() }
    const repo = refunds(); await request(repo, ws, checkout.subscription, 'service-refund', 5000)
    await expect(approve(repo, ws, 'service-refund')).rejects.toMatchObject({ code: 'COMMERCIAL_POLICY_UNRESOLVED' })
    await unchanged(ws, 'service-refund', repo)
    expect((await db.query('SELECT event_type FROM workspace_service_fulfillment_events WHERE workspace_id=$1', [ws])).rows.length).toBe(state === 'completed' ? 3 : 1)
  }, 90000)

  it.each(['reserved','settled'] as const)('blocks source cancellation after real source points are %s', async state => {
    const ws = await workspace(`points-${state}`), checkout = await activate(ws, `points-${state}`)
    const points = new PostgresCreativePointRepository(app)
    const reservation = await points.reserve({ workspaceId: ws, idempotencyKey: 'source-consumption', actionKey: 'owned-ledger-test', rateCardVersion: 'owned-fixture-rate-v1', points: 600, at: halfAt })
    if (state === 'settled') await points.settle({ workspaceId: ws, idempotencyKey: 'source-settlement', reservationId: reservation.value.id, actualPoints: 600, metadata: { test_purpose: 'ledger-source-recovery-not-live-model-usage' }, at: halfAt })
    const sourceAllocations = await db.query(`SELECT a.points_delta FROM creative_point_allocations a JOIN creative_point_grants g ON g.workspace_id=a.workspace_id AND g.id=a.grant_id WHERE g.workspace_id=$1 AND g.source_type='commercial_order_v2' AND g.source_id=$2`,[ws,checkout.subscription.id])
    expect(sourceAllocations.rows.length).toBeGreaterThan(0)
    expect(sourceAllocations.rows.reduce((total,row)=>total+Number(row.points_delta),0)).toBeGreaterThan(0)
    const before = await points.getBalance(ws)
    const repo = refunds(); await request(repo, ws, checkout.subscription, 'consumed-points-refund', 5000)
    await expect(approve(repo,ws,'consumed-points-refund')).rejects.toMatchObject({ code: 'COMMERCIAL_POLICY_UNRESOLVED' })
    expect(await repo.latest(ws,'consumed-points-refund')).toMatchObject({ eventType:'requested' })
    expect(await points.getBalance(ws)).toMatchObject({ availablePoints:before.availablePoints,reservedPoints:before.reservedPoints,settledPoints:before.settledPoints })
    expect((await db.query('SELECT state FROM commercial_source_recovery_holds_v3 WHERE workspace_id=$1',[ws])).rows).toEqual([])
    expect((await db.query('SELECT points_delta FROM creative_point_adjustments_v2 WHERE workspace_id=$1',[ws])).rows).toEqual([])
  }, 90000)

  it('rejects zero-point cancellation of a contract that already granted source points', async () => {
    const ws = await workspace('zero-source'), checkout = await activate(ws, 'zero-source')
    const repo = refunds(); await request(repo, ws, checkout.subscription, 'zero-refund', 0)
    await expect(approve(repo, ws, 'zero-refund')).rejects.toMatchObject({ code: 'COMMERCIAL_POLICY_UNRESOLVED' })
    await unchanged(ws, 'zero-refund', repo)
  }, 90000)

  it('cancels an unused future source period and its scheduled points while preserving the active period and unrelated gifts', async () => {
    const ws = await workspace('future-source'); await activate(ws, 'future-source')
    const points = new PostgresCreativePointRepository(app)
    await points.grant({ workspaceId: ws, idempotencyKey: 'unrelated', sourceType: 'test_approved_adjustment', sourceId: 'independent-gift', points: 250 })
    const order = await create(ws, basic, 'future-renewal', 'renewal'); await pay(ws, order, halfAt)
    const repo = refunds(); await request(repo, ws, order, 'future-refund', 0); await approve(repo, ws, 'future-refund')
    await repo.completeWithPointRevoke({ workspaceId: ws, requestId: 'future-refund', actorId: 'finance', reason: 'factual future-source refund', externalRefundId: `test-bank-${ws}`, evidence: { bank_receipt_ref: 'fixture-not-real-money' }, at: halfAt }, new PostgresCreativePointLifecycleRepository(ops))
    expect((await points.getBalance(ws)).availablePoints).toBe(5750)
    expect((await db.query('SELECT status FROM workspace_subscription_periods_v2 WHERE workspace_id=$1 ORDER BY period_start', [ws])).rows).toEqual([{ status: 'active' }, { status: 'canceled' }])
    expect((await db.query('SELECT status FROM commercial_point_grant_schedules_v3 WHERE workspace_id=$1 AND order_id=$2', [ws, order.id])).rows).toEqual([{ status: 'canceled' }])
    expect((await db.query('SELECT id FROM creative_point_grants WHERE workspace_id=$1 AND source_id=$2', [ws, order.id])).rows).toEqual([])
  }, 90000)

  it('blocks opening-fee recovery while a paid monthly source still depends on account qualification', async () => {
    const ws = await workspace('opening-dependent'), checkout = await activate(ws, 'opening-dependent')
    const repo = refunds()
    await repo.request({ workspaceId: ws, orderId: checkout.onboarding.id, requestId: 'opening-refund', refundKind: 'onboarding_pre_deployment', amountFen: checkout.onboarding.amountFen, pointsToRevoke: 500, reason: 'opening source review', actorId: 'maker', evidence: { deployment_status: 'not_started' }, at: halfAt })
    await expect(approve(repo, ws, 'opening-refund')).rejects.toMatchObject({ code: 'COMMERCIAL_POLICY_UNRESOLVED' })
    await unchanged(ws, 'opening-refund', repo)
    expect((await transactions.getOnboardingStatus(ws)).qualified).toBe(true)
    expect((await db.query('SELECT status FROM onboarding_point_grant_schedules_v2 WHERE workspace_id=$1 ORDER BY sequence', [ws])).rows).toEqual([{ status: 'granted' }, ...Array.from({ length: 5 }, () => ({ status: 'scheduled' }))])
  }, 90000)
})
