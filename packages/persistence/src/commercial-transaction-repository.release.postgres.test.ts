import { PostgresCommercialPointOriginReadRepository } from './commercial-point-origin-read-repository.js'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { CommercialAccessService } from '../../application/src/commercial-access-service.js'
import { COMMERCIAL_OPERATION_REGISTRY } from '@merchant-marketing/contracts'
import { PostgresCommercialCatalogRepository, type CommercialCatalogBenefit, type CommercialCatalogSkuSnapshot } from './commercial-catalog-repository.js'
import { PostgresCommercialContractRepository, type CommercialOrderV2 } from './commercial-contract-repository.js'
import { PostgresCommercialReceiptRepository } from './commercial-receipt-repository.js'
import { PostgresStorageQuotaRepository } from './storage-quota-repository.js'
import { PostgresBusinessRepository } from './business-repository.js'
import { PostgresBrandUnitRepository } from './brand-unit-repository.js'
import { PostgresCreativePointRepository } from './creative-point-repository.js'
import { PostgresCreativePointLifecycleRepository } from './creative-point-lifecycle-repository.js'
import { PostgresOnboardingGrantDispatchRepository } from './onboarding-grant-dispatch-repository.js'
import { PostgresCommercialRefundRepository } from './commercial-refund-repository.js'
import { loadMigrations, MigrationRunner } from './migration.js'

const source = process.env.PERSISTENCE_RELEASE_DATABASE_URL
const firstAt = '2027-01-31T00:00:00.000Z'
const halfAt = '2027-02-14T00:00:00.000Z'
const endAt = '2027-02-28T00:00:00.000Z'
const digest = 'a'.repeat(64)
const benefit = (code: string, quantity: number, unit: string): CommercialCatalogBenefit => ({ code, quantity, normalizedValue: quantity, rawValue: null, rawUnit: unit, policyRef: 'approved-isolated-test-policy', metadata: {} })

/** New DB inside the launcher-owned container, complete immutable migration
 * chain and actual post-migration role bootstrap. No .env/shared DB fallback. */
describe.skipIf(!source)('commercial transactions full-chain PostgreSQL acceptance', () => {
  const name = `commercial_transactions_${randomUUID().replaceAll('-', '')}`
  let admin: Pool, db: Pool, app: Pool, ops: Pool
  let catalog: PostgresCommercialCatalogRepository, transactions: PostgresCommercialContractRepository
  let opening: CommercialCatalogSkuSnapshot, basic: CommercialCatalogSkuSnapshot, growth: CommercialCatalogSkuSnapshot, premium: CommercialCatalogSkuSnapshot, recoveryGrowth: CommercialCatalogSkuSnapshot, pointPack: CommercialCatalogSkuSnapshot
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
    const publish = async (code: string, kind: CommercialCatalogSkuSnapshot['kind'], priceFen: number, points: number, rank?: number, featureEnabled = rank !== 1, cycle = { unit: 'month', count: 1 }, cadence: 'once' | 'monthly' = 'once') => {
      const payload = { blockers: [], sourceRecoveryPolicy: { approved: true, version: 'owned-source-recovery-v1', effect: 'cancel_contract' }, purchasePolicy: { approved: true, version: 'cash-window-isolated-v1', expiresInSeconds: 604800 },
        ...(kind === 'onboarding' ? { policyRef: { policyId: 'commercial.onboarding', version: 'v2' }, grantSchedule: { policyRef: { policyId: 'commercial.onboarding', version: 'v2' }, grantCount: 6, pointsPerGrant: 500, cadence: 'monthly', timezone: 'UTC', startsAt: 'payment_verified', grantExpiresAtRule: 'next_monthly_anniversary', schedulingStatus: 'resolved' } } : kind === 'point_pack' ? { expiryDays: 30, expiryRule: 'purchase_plus_30_natural_days' } : { cycle, pointGrantPolicy: { cadence }, planFamily: 'isolated-standard', tierRank: rank, upgradePolicy: { approved: true, version: 'remaining-period-isolated-v1' } }) }
      const benefits = kind === 'onboarding' ? [benefit('creative_points', 500, 'point')] : kind === 'point_pack' ? [benefit('creative_points', points, 'point')] : [benefit('monthly_creative_points', points, 'point'), benefit('max_brands', rank!, 'brand'), benefit('max_stores', rank! * 5, 'store'), benefit('cloud_storage',rank! * 1000,'byte'),benefit('feature.image_generation', featureEnabled ? 1 : 0, 'permission')]
      await catalog.mutate({ action: 'create', code, kind, priceFen, payload, benefits, expectedRevision: 0, idempotencyKey: `${code}:create`, actorId: 'catalog-maker', reason: 'owned QA approved fixture', evidence: {} })
      const approved = await catalog.mutate({ action: 'approve', code, expectedRevision: 1, idempotencyKey: `${code}:approve`, actorId: 'catalog-approver', reason: 'owned QA approved fixture', evidence: { approval_ref: 'test-only' } })
      return catalog.mutate({ action: 'publish', code, versionId: approved.versionId, expectedRevision: 2, idempotencyKey: `${code}:publish`, actorId: 'publisher', reason: 'owned QA approved fixture', evidence: {} })
    }
    opening = await publish('qa-opening', 'onboarding', 500000, 500)
    basic = await publish('qa-basic', 'monthly', 200000, 5000, 1)
    growth = await publish('qa-growth', 'monthly', 500000, 12500, 2)
    premium = await publish('qa-premium', 'monthly', 1000000, 25000, 3)
    recoveryGrowth = await publish('qa-recovery-growth','monthly',500000,12500,2,false)
    pointPack = await publish('qa-point-pack','point_pack',10000,100)
  }, 120000)
  afterAll(async () => {
    await app?.end(); await ops?.end(); await db?.end()
    if (admin) { await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`); await admin.end() }
  }, 60000)
  const workspace = async (label: string) => { const id = `${label}-${randomUUID()}`; await db.query("INSERT INTO workspaces(id,status) VALUES($1,'active')", [id]); return id }
  const first = (workspaceId: string, key: string) => transactions.createFirstCheckout({ workspaceId, actorId: 'buyer', onboardingSku: opening, subscriptionSku: basic, paymentProvider: 'manual_transfer', idempotencyKey: key, reason: 'owned QA first purchase', now: firstAt })
  const pay = (workspaceId: string, order: CommercialOrderV2, at: string, verifiedAt = at) => transactions.recordVerifiedPaymentAndGrant({ workspaceId, orderId: order.id, provider: 'manual_transfer', providerOrderId: `bank:${order.id}`, providerEventId: `cash:${order.id}`, nonce: `nonce:${order.id}`, payloadHash: digest, amountFen: order.amountFen, currency: 'CNY', paidAt: at, verifiedAt })
  const activate = async (workspaceId: string, key: string) => { const checkout = await first(workspaceId, key); await pay(workspaceId, checkout.onboarding, firstAt); await pay(workspaceId, checkout.subscription, firstAt); return checkout }
  const create = (workspaceId: string, sku: CommercialCatalogSkuSnapshot, key: string, purchaseKind: 'renewal' | 'upgrade', now = halfAt, upgradeQuoteId?: string) => transactions.createOrder({ workspaceId, sku, idempotencyKey: key, createdByActorId: 'buyer', paymentProvider: 'manual_transfer', reason: 'owned QA purchase intent', purchaseKind, now, upgradeQuoteId })
  const publishPlan = async (code: string, cycle: { unit: 'month' | 'day'; count: number }, cadence: 'once' | 'monthly', priceFen: number, points: number, rank: number) => {
    const payload = { blockers: [], sourceRecoveryPolicy: { approved: true, version: 'owned-source-recovery-v1', effect: 'cancel_contract' }, purchasePolicy: { approved: true, version: 'cash-window-isolated-v1', expiresInSeconds: 604800 }, cycle, pointGrantPolicy: { cadence }, planFamily: 'isolated-standard', tierRank: rank, upgradePolicy: { approved: true, version: 'remaining-period-isolated-v1' } }
    await catalog.mutate({ action: 'create', code, kind: 'monthly', priceFen, payload, benefits: [benefit('monthly_creative_points', points, 'point'), benefit('max_brands', rank, 'brand'), benefit('max_stores', rank * 5, 'store'), benefit('cloud_storage', rank * 1000, 'byte'), benefit('feature.image_generation', rank > 1 ? 1 : 0, 'permission')], expectedRevision: 0, idempotencyKey: `${code}:create`, actorId: 'cycle-maker', reason: 'owned cycle acceptance fixture', evidence: {} })
    const approved = await catalog.mutate({ action: 'approve', code, expectedRevision: 1, idempotencyKey: `${code}:approve`, actorId: 'cycle-approver', reason: 'owned cycle acceptance fixture', evidence: { approval_ref: 'test-only' } })
    return catalog.mutate({ action: 'publish', code, versionId: approved.versionId, expectedRevision: 2, idempotencyKey: `${code}:publish`, actorId: 'cycle-publisher', reason: 'owned cycle acceptance fixture', evidence: {} })
  }

  it('atomically allocates first-checkout cash, rolls back failed grants, preserves 6 gift batches and enforces runtime roles/RLS', async () => {
    const ws = await workspace('first'), other = await workspace('other')
    const checkout = await first(ws, 'first-key')
    expect(checkout.amountFen).toBe(700000)
    expect(await first(ws, 'first-key')).toMatchObject({ checkoutId: checkout.checkoutId, onboarding: { id: checkout.onboarding.id }, subscription: { id: checkout.subscription.id } })
    await expect(first(ws, 'other-first-key')).rejects.toMatchObject({ code: 'COMMERCIAL_ENTITLEMENT_CONFLICT' })
    const receipts = new PostgresCommercialReceiptRepository(ops, ops)
    const receipt = await receipts.record({ workspaceId: ws, source: 'manual_transfer', receivingAccountRef: 'owned-fixture-bank', externalTradeId: `cash:${ws}`, payerRef: 'test-payer', amountFen: 700000, currency: 'CNY', receivedAt: firstAt, verifiedAt: firstAt, actorId: 'finance', evidence: { bank_receipt_ref: 'fixture-only-not-real-cash' } })
    const allocations = [{ orderId: checkout.subscription.id, amountFen: 200000 }, { orderId: checkout.onboarding.id, amountFen: 500000 }].map((line, n) => ({ ...line, workspaceId: ws, receiptId: receipt.id, expectedRevision: 1, idempotencyKey: `allocation:${n}`, actorId: 'finance', at: firstAt }))
    await expect(receipts.allocateBatchAndFulfill(allocations, async () => { throw new Error('injected grant failure') })).rejects.toThrow('injected grant failure')
    expect(await receipts.get(ws, receipt.id)).toMatchObject({ availableFen: 700000, allocatedFen: 0 })
    expect((await transactions.getOnboardingStatus(ws)).qualified).toBe(false)
    const fulfilled = await receipts.allocateBatchAndFulfill(allocations, (client, payment) => transactions.recordVerifiedPaymentAndGrantInTransaction(client, { ...payment, providerOrderId: payment.orderId, paymentSubjectRef: payment.providerEventId }))
    expect(fulfilled.map(v => v.status)).toEqual(['fully_received', 'fully_received'])
    expect((await transactions.getOnboardingStatus(ws)).qualified).toBe(true)
    expect((await new PostgresCreativePointRepository(app).getBalance(ws)).availablePoints).toBe(5500)
    expect((await db.query('SELECT sequence,points::int AS points,status FROM onboarding_point_grant_schedules_v2 WHERE workspace_id=$1 ORDER BY sequence', [ws])).rows).toEqual([1,2,3,4,5,6].map(sequence => ({ sequence, points: 500, status: sequence === 1 ? 'granted' : 'scheduled' })))
    await receipts.allocateBatchAndFulfill(allocations, (client, payment) => transactions.recordVerifiedPaymentAndGrantInTransaction(client, { ...payment, providerOrderId: payment.orderId, paymentSubjectRef: payment.providerEventId }))
    expect((await new PostgresCreativePointRepository(app).getBalance(ws)).availablePoints).toBe(5500)
    expect(await transactions.getOrderSnapshot(other, checkout.onboarding.id)).toBeNull()
    expect((await db.query("SELECT has_table_privilege('merchant_app','commercial_catalog_sales_v3','SELECT') allowed")).rows[0].allowed).toBe(false)
    const roles = (await db.query("SELECT rolname,rolsuper,rolbypassrls FROM pg_roles WHERE rolname IN ('merchant_app','merchant_ops') ORDER BY rolname")).rows
    expect(roles).toEqual([{ rolname: 'merchant_app', rolsuper: false, rolbypassrls: false }, { rolname: 'merchant_ops', rolsuper: false, rolbypassrls: false }])
    const client = await app.connect(); try { await client.query('BEGIN'); await client.query("SELECT set_config('app.workspace_id',$1,true)", [other]); expect((await client.query('SELECT id FROM commercial_orders_v2 WHERE id=$1', [checkout.onboarding.id])).rows).toEqual([]); await client.query('ROLLBACK') } finally { client.release() }
  }, 90000)

  it('keeps a valid point pack visible after more than 100 newer orders', async () => {
    const ws = await workspace('pack-portfolio')
    await activate(ws, 'pack-portfolio-onboarding')
    const order = await transactions.createOrder({ workspaceId: ws, sku: pointPack, idempotencyKey: 'old-valid-pack', createdByActorId: 'buyer', paymentProvider: 'manual_transfer', reason: 'owned QA point pack purchase', purchaseKind: 'point_pack', now: firstAt })
    await pay(ws, order, firstAt)

    const newerAt = '2027-02-01T00:00:00.000Z'
    const snapshot = JSON.stringify({ schema_version: 'commercial-order.v3', sku: basic })
    await db.query(`INSERT INTO commercial_orders_v2(id,workspace_id,sku_id,sku_version_id,amount_fen,currency,payment_provider,status,idempotency_key,request_hash,created_by_actor_id,created_at)
      SELECT 'portfolio-newer-'||$1||'-'||n,$1,$2,$3,$4,'CNY','manual_transfer','pending','portfolio-newer-'||n,repeat('b',64),'portfolio-fixture',$5::timestamptz
      FROM generate_series(1,101) n`, [ws,basic.id,basic.versionId,basic.priceFen,newerAt])
    await db.query(`INSERT INTO commercial_order_snapshots_v2(id,workspace_id,order_id,sku_id,sku_version_id,catalog_checksum,snapshot,checksum,created_at)
      SELECT 'portfolio-snapshot-'||$1||'-'||n,$1,'portfolio-newer-'||$1||'-'||n,$2,$3,$4,$5::jsonb,repeat('c',64),$6::timestamptz
      FROM generate_series(1,101) n`, [ws,basic.id,basic.versionId,basic.checksum,snapshot,newerAt])
    await db.query(`INSERT INTO commercial_order_terms_v3(workspace_id,order_id,purchase_kind,expires_at,policy_version,created_at)
      SELECT $1,'portfolio-newer-'||$1||'-'||n,'purchase','2027-03-01T00:00:00Z','portfolio-fixture',$2::timestamptz
      FROM generate_series(1,101) n`, [ws,newerAt])

    const portfolio = await transactions.getSubscriptionSummary({ workspaceId: ws, now: halfAt })
    expect(portfolio.orders).toHaveLength(100)
    expect(portfolio.orders.some(value => value.id === order.id)).toBe(false)
    expect(portfolio.packs).toEqual([expect.objectContaining({ orderId: order.id, skuCode: pointPack.code, skuVersionId: pointPack.versionId, expiresAt: expect.any(String), grantStatus: 'active' })])
  }, 90000)

  it('executes supported multi-month and fixed-day cycles with replay-safe grants and same-cycle upgrade', async () => {
    const quarter = await publishPlan('qa-quarterly-monthly', { unit: 'month', count: 3 }, 'monthly', 300000, 6000, 1)
    const quarterGrowth = await publishPlan('qa-quarterly-growth', { unit: 'month', count: 3 }, 'monthly', 750000, 15000, 2)
    const quarterOnce = await publishPlan('qa-quarterly-once', { unit: 'month', count: 3 }, 'once', 1000000, 20000, 3)
    const days = await publishPlan('qa-thirty-days', { unit: 'day', count: 30 }, 'once', 200000, 5000, 1)

    const quarterWorkspace = await workspace('quarter-cycle')
    const quarterStart = '2028-01-31T00:00:00.000Z', quarterEnd = '2028-04-30T00:00:00.000Z'
    const quarterCheckout = await transactions.createFirstCheckout({ workspaceId: quarterWorkspace, actorId: 'buyer', onboardingSku: opening, subscriptionSku: quarter, paymentProvider: 'manual_transfer', idempotencyKey: 'quarter-checkout', reason: 'owned quarter-cycle test', now: quarterStart })
    await pay(quarterWorkspace, quarterCheckout.onboarding, quarterStart)
    const quarterPayment = await pay(quarterWorkspace, quarterCheckout.subscription, quarterStart)
    expect(quarterPayment.grantStatus).toBe('active')
    expect(await pay(quarterWorkspace, quarterCheckout.subscription, quarterStart)).toMatchObject({ replayed: true, grantId: quarterPayment.grantId })
    expect((await db.query(`SELECT period_start,period_end FROM workspace_subscription_periods_v2 WHERE workspace_id=$1`, [quarterWorkspace])).rows).toEqual([{ period_start: new Date(quarterStart), period_end: new Date(quarterEnd) }])
    expect((await db.query(`SELECT sequence,due_at,expires_at,status FROM commercial_point_grant_schedules_v3 WHERE workspace_id=$1 AND order_id=$2 ORDER BY sequence`, [quarterWorkspace, quarterCheckout.subscription.id])).rows).toEqual([
      { sequence: 2, due_at: new Date('2028-02-29T00:00:00.000Z'), expires_at: new Date('2028-03-31T00:00:00.000Z'), status: 'scheduled' },
      { sequence: 3, due_at: new Date('2028-03-31T00:00:00.000Z'), expires_at: new Date(quarterEnd), status: 'scheduled' },
    ])
    expect((await db.query(`SELECT count(*)::int AS count FROM creative_point_grants WHERE workspace_id=$1 AND source_type='commercial_order_v2' AND source_id=$2`, [quarterWorkspace, quarterCheckout.subscription.id])).rows[0]!.count).toBe(1)
    expect(await transactions.dispatchDueScheduledGrants({ workspaceId: quarterWorkspace, now: '2028-02-29T00:00:00.000Z' })).toMatchObject({ dispatched: 1 })
    expect(await transactions.dispatchDueScheduledGrants({ workspaceId: quarterWorkspace, now: '2028-02-29T00:00:00.000Z' })).toMatchObject({ dispatched: 0 })
    await new PostgresCreativePointLifecycleRepository(app).expireGrant({ workspaceId: quarterWorkspace, grantId: quarterPayment.grantId!, idempotencyKey: 'quarter-first-batch-expiry', at: '2028-02-29T00:00:00.000Z' })

    const quote = await transactions.createUpgradeQuote({ workspaceId: quarterWorkspace, actorId: 'buyer', targetSkuCode: quarterGrowth.code, idempotencyKey: 'quarter-growth-quote', now: '2028-03-01T00:00:00.000Z' })
    expect(quote).toMatchObject({ currentCyclePriceFen: 300000, targetCyclePriceFen: 750000, periodStart: quarterStart, periodEnd: quarterEnd })
    await expect(transactions.createUpgradeQuote({ workspaceId: quarterWorkspace, actorId: 'buyer', targetSkuCode: quarterOnce.code, idempotencyKey: 'quarter-cadence-change-quote', now: '2028-03-01T00:00:00.000Z' })).rejects.toThrow('COMMERCIAL_UPGRADE_CYCLE_MISMATCH')
    const upgrade = await transactions.createOrder({ workspaceId: quarterWorkspace, sku: quarterGrowth, idempotencyKey: 'quarter-growth-upgrade', createdByActorId: 'buyer', paymentProvider: 'manual_transfer', reason: 'owned same-cycle upgrade', purchaseKind: 'upgrade', upgradeQuoteId: quote.id, now: '2028-03-01T00:00:00.000Z' })
    await pay(quarterWorkspace, upgrade, '2028-03-01T00:00:00.000Z')
    await pay(quarterWorkspace, upgrade, '2028-03-01T00:00:00.000Z')
    expect((await db.query(`SELECT period_end,revision::int AS revision FROM workspace_subscription_periods_v2 WHERE workspace_id=$1`, [quarterWorkspace])).rows).toEqual([{ period_end: new Date(quarterEnd), revision: 2 }])
    expect(await transactions.getSubscriptionSummary({ workspaceId: quarterWorkspace, now: '2028-03-01T00:00:00.000Z' })).toMatchObject({ current: { skuCode: quarterGrowth.code, periodEnd: quarterEnd } })
    expect((await db.query(`SELECT count(*)::int AS count FROM commercial_upgrade_events_v3 WHERE workspace_id=$1 AND order_id=$2`, [quarterWorkspace, upgrade.id])).rows[0]!.count).toBe(1)
    expect(await transactions.dispatchDueScheduledGrants({ workspaceId: quarterWorkspace, now: '2028-03-31T00:00:00.000Z' })).toMatchObject({ dispatched: 1 })

    const dayWorkspace = await workspace('day-cycle')
    const dayStart = '2028-02-28T00:00:00.000Z', dayEnd = '2028-03-29T00:00:00.000Z'
    const dayCheckout = await transactions.createFirstCheckout({ workspaceId: dayWorkspace, actorId: 'buyer', onboardingSku: opening, subscriptionSku: days, paymentProvider: 'manual_transfer', idempotencyKey: 'day-checkout', reason: 'owned fixed-day test', now: dayStart })
    await pay(dayWorkspace, dayCheckout.onboarding, dayStart)
    const dayPayment = await pay(dayWorkspace, dayCheckout.subscription, dayStart)
    expect(await pay(dayWorkspace, dayCheckout.subscription, dayStart)).toMatchObject({ replayed: true, grantId: dayPayment.grantId })
    expect((await db.query(`SELECT period_start,period_end FROM workspace_subscription_periods_v2 WHERE workspace_id=$1`, [dayWorkspace])).rows).toEqual([{ period_start: new Date(dayStart), period_end: new Date(dayEnd) }])
    expect((await db.query(`SELECT expires_at FROM creative_point_grants WHERE workspace_id=$1 AND source_type='commercial_order_v2' AND source_id=$2`, [dayWorkspace, dayCheckout.subscription.id])).rows).toEqual([{ expires_at: new Date(dayEnd) }])
    expect((await db.query(`SELECT count(*)::int AS count FROM commercial_point_grant_schedules_v3 WHERE workspace_id=$1 AND order_id=$2`, [dayWorkspace, dayCheckout.subscription.id])).rows[0]!.count).toBe(0)

    const expectedEnds = { 1: '2028-02-29T00:00:00.000Z', 3: '2028-04-30T00:00:00.000Z', 6: '2028-07-31T00:00:00.000Z', 12: '2029-01-31T00:00:00.000Z' } as const
    for (const count of [1, 3, 6, 12] as const) {
      for (const cadence of ['once', 'monthly'] as const) {
        if (count === 3 && cadence === 'monthly') continue // exercised above with expiry, replay, dispatch and upgrade
        const sku = await publishPlan(`qa-month-${count}-${cadence}`, { unit: 'month', count }, cadence, 100000 * count, 5000 * count, 1)
        const ws = await workspace(`month-${count}-${cadence}`)
        const checkout = await transactions.createFirstCheckout({ workspaceId: ws, actorId: 'buyer', onboardingSku: opening, subscriptionSku: sku, paymentProvider: 'manual_transfer', idempotencyKey: `month-${count}-${cadence}-checkout`, reason: 'owned cycle matrix test', now: quarterStart })
        await pay(ws, checkout.onboarding, quarterStart)
        const payment = await pay(ws, checkout.subscription, quarterStart)
        expect(await pay(ws, checkout.subscription, quarterStart)).toMatchObject({ replayed: true, grantId: payment.grantId })
        expect((await db.query(`SELECT period_start,period_end FROM workspace_subscription_periods_v2 WHERE workspace_id=$1`, [ws])).rows).toEqual([{ period_start: new Date(quarterStart), period_end: new Date(expectedEnds[count]) }])
        const scheduled = (await db.query(`SELECT sequence,status FROM commercial_point_grant_schedules_v3 WHERE workspace_id=$1 AND order_id=$2 ORDER BY sequence`, [ws, checkout.subscription.id])).rows
        expect(scheduled).toHaveLength(cadence === 'monthly' ? count - 1 : 0)
        expect((await db.query(`SELECT count(*)::int AS count FROM creative_point_grants WHERE workspace_id=$1 AND source_type='commercial_order_v2' AND source_id=$2`, [ws, checkout.subscription.id])).rows[0]!.count).toBe(1)
      }
    }
  }, 90000)

  it('rejects unsupported and legacy cycle snapshots before publishing, ordering, or upgrading', async () => {
    for (const [index, invalid] of [
      { cycle: { unit: 'month', count: 2 }, cadence: 'once' },
      { cycle: { unit: 'day', count: 30 }, cadence: 'monthly' },
      { cycle: { unit: 'month', count: 3 }, cadence: undefined },
    ].entries()) {
      const code = `qa-unsupported-cycle-${index}-${randomUUID()}`
      const payload = { blockers: [], sourceRecoveryPolicy: { approved: true, version: 'owned-source-recovery-v1', effect: 'cancel_contract' }, purchasePolicy: { approved: true, version: 'cash-window-isolated-v1', expiresInSeconds: 604800 }, cycle: invalid.cycle, ...(invalid.cadence ? { pointGrantPolicy: { cadence: invalid.cadence } } : {}), planFamily: 'isolated-standard', tierRank: 1, upgradePolicy: { approved: true, version: 'remaining-period-isolated-v1' } }
      await catalog.mutate({ action: 'create', code, kind: 'monthly', priceFen: 200000, payload, benefits: [benefit('monthly_creative_points', 5000, 'point')], expectedRevision: 0, idempotencyKey: `${code}:create`, actorId: 'maker', reason: 'unsupported period test', evidence: {} })
      await catalog.mutate({ action: 'approve', code, expectedRevision: 1, idempotencyKey: `${code}:approve`, actorId: 'approver', reason: 'unsupported period test', evidence: {} })
      await expect(catalog.mutate({ action: 'publish', code, expectedRevision: 2, idempotencyKey: `${code}:publish`, actorId: 'publisher', reason: 'unsupported period test', evidence: {} })).rejects.toMatchObject({ code: 'COMMERCIAL_CATALOG_UNAVAILABLE' })
    }

    const code = `qa-legacy-cycle-${randomUUID()}`, skuId = `sku-${code}`, versionId = `version-${code}`
    const payload = { blockers: [], purchasePolicy: { approved: true, version: 'legacy-compatible-window', expiresInSeconds: 3600 }, planFamily: 'isolated-standard', tierRank: 1, upgradePolicy: { approved: true, version: 'remaining-period-isolated-v1' } }
    await db.query(`INSERT INTO commercial_catalog_skus(id,code,kind,visibility,required_capability) VALUES($1,$2,'monthly','public',NULL)`, [skuId, code])
    await db.query(`INSERT INTO commercial_catalog_sku_versions(id,sku_id,version,lifecycle,executable,price_fen,currency,price_mode,payload,checksum,effective_at) VALUES($1,$2,1,'approved',true,200000,'CNY','fixed',$3::jsonb,$4,'2026-01-01T00:00:00Z')`, [versionId, skuId, JSON.stringify(payload), digest])
    await db.query(`INSERT INTO commercial_catalog_sku_benefits(id,sku_version_id,benefit_code,quantity,raw_value,raw_unit,normalized_value,policy_ref,metadata) VALUES($1,$2,'monthly_creative_points',5000,'5000','point',5000,'legacy-v1','{}')`, [`benefit-${code}`, versionId])
    await db.query(`INSERT INTO commercial_catalog_sales_v3(sku_id,current_version_id,state,revision) VALUES($1,$2,'on_sale',1)`, [skuId, versionId])
    const legacy = { ...basic, id: skuId, code, versionId, payload }
    const ws = await workspace('legacy-cycle')
    await expect(transactions.createOrder({ workspaceId: ws, sku: legacy, idempotencyKey: 'unsupported-legacy-order', createdByActorId: 'buyer', paymentProvider: 'manual_transfer', reason: 'must fail before order', purchaseKind: 'purchase', now: firstAt })).rejects.toMatchObject({ code: 'COMMERCIAL_POLICY_UNRESOLVED' })
    await expect(transactions.createUpgradeQuote({ workspaceId: ws, actorId: 'buyer', targetSkuCode: code, idempotencyKey: 'unsupported-legacy-upgrade', now: firstAt })).rejects.toMatchObject({ code: 'COMMERCIAL_POLICY_UNRESOLVED' })
    expect((await db.query(`SELECT count(*)::int AS count FROM commercial_orders_v2 WHERE workspace_id=$1 AND sku_id=$2`, [ws, skuId])).rows[0]!.count).toBe(0)
  }, 90000)

  it('recovers a first-period payment waiting on onboarding without duplicate grants or losing factual paidAt', async () => {
    const ws = await workspace('dependency'), checkout = await first(ws, 'dependency-key')
    expect(await pay(ws, checkout.subscription, firstAt)).toMatchObject({ grantStatus: 'awaiting_dependency', availablePoints: 0 })
    const verifiedAt = '2027-02-01T00:00:00.000Z'
    await pay(ws, checkout.onboarding, firstAt, verifiedAt)
    expect(await transactions.getOrderSnapshot(ws, checkout.subscription.id)).toMatchObject({ order: { status: 'paid', grantStatus: 'active', paidAt: firstAt } })
    expect((await new PostgresCreativePointRepository(app).getBalance(ws)).availablePoints).toBe(5500)
  }, 90000)

  it('prorates consecutive upgrades, retains expiry and grants target boolean features through the real admission consumer', async () => {
    const ws = await workspace('upgrade'); await activate(ws, 'upgrade-key')
    const access = new CommercialAccessService({ registry: COMMERCIAL_OPERATION_REGISTRY, registry_version: 'owned-pg-v3', qualification_projection: { projectCommercialQualification: async () => ({ state: 'known', qualified: (await transactions.getOnboardingStatus(ws)).qualified }) }, balance_projection: { projectCreativePointBalance: async () => ({ state: 'known', available_points: 15500, freshness: 'fresh', access_revision: '3' }) }, rate_resolver: { resolveApprovedRate: async () => ({ state: 'approved', quoted_points: 1, rate_card_version: 'owned-v1' }) }, entitlement_projection: { listV2EntitlementSnapshots: ({ workspace_id }) => transactions.listEntitlementSnapshots(workspace_id) }, now: () => new Date(halfAt) })
    expect(await access.decide({ surface: 'MCP', operation: 'catalog.image.generate', workspace_id: ws })).toMatchObject({ outcome: 'DECISION', decision: { allowed: false, error_code: 'COMMERCIAL_ENTITLEMENT_REQUIRED' } })
    const quote = await transactions.createUpgradeQuote({ workspaceId: ws, actorId: 'buyer', targetSkuCode: growth.code, idempotencyKey: 'growth-quote', now: halfAt })
    expect(quote.amountFen).toBe(150000)
    const order = await create(ws, growth, 'growth-upgrade', 'upgrade', halfAt, quote.id)
    await pay(ws, order, halfAt)
    await expect(transactions.createUpgradeQuote({ workspaceId: ws, actorId: 'buyer', targetSkuCode: basic.code, idempotencyKey: 'basic-downgrade-quote', now: halfAt })).rejects.toThrow('new plan tier must not be lower than the current or already-paid future contract')
    expect((await db.query(`SELECT count(*)::int AS count FROM commercial_upgrade_quotes_v3 WHERE workspace_id=$1 AND idempotency_key='basic-downgrade-quote'`, [ws])).rows[0]!.count).toBe(0)
    const next = await transactions.createUpgradeQuote({ workspaceId: ws, actorId: 'buyer', targetSkuCode: premium.code, idempotencyKey: 'premium-quote', now: halfAt })
    expect(next).toMatchObject({ currentCyclePriceFen: 500000, targetCyclePriceFen: 1000000, amountFen: 250000, periodEnd: endAt })
    await pay(ws, await create(ws, premium, 'premium-upgrade', 'upgrade', halfAt, next.id), halfAt)
    expect((await db.query('SELECT period_start,period_end,revision::int AS revision FROM workspace_subscription_periods_v2 WHERE workspace_id=$1', [ws])).rows).toEqual([{ period_start: new Date(firstAt), period_end: new Date(endAt), revision: 3 }])
    expect((await new PostgresCreativePointRepository(app).getBalance(ws)).availablePoints).toBe(15500)
    expect(await access.decide({ surface: 'MCP', operation: 'catalog.image.generate', workspace_id: ws })).toMatchObject({ outcome: 'DECISION', decision: { allowed: true } })
  }, 90000)

  it('keeps a valid quote price after catalog repricing and routes late source-expired cash to disposition', async () => {
    const ws = await workspace('quote'); await activate(ws, 'quote-key')
    const quote = await transactions.createUpgradeQuote({ workspaceId: ws, actorId: 'buyer', targetSkuCode: growth.code, idempotencyKey: 'locked-growth', now: halfAt })
    const draft = await catalog.mutate({ action: 'create', code: growth.code, priceFen: 600000, expectedRevision: 3, idempotencyKey: 'growth-reprice', actorId: 'maker', reason: 'owned QA price change', evidence: {} })
    const approved = await catalog.mutate({ action: 'approve', code: growth.code, versionId: draft.versionId, expectedRevision: 4, idempotencyKey: 'growth-reprice-approve', actorId: 'approver', reason: 'owned QA price change', evidence: {} })
    await catalog.mutate({ action: 'publish', code: growth.code, versionId: approved.versionId, expectedRevision: 5, idempotencyKey: 'growth-reprice-publish', actorId: 'publisher', reason: 'owned QA price change', evidence: {} })
    const order = await create(ws, growth, 'locked-price-order', 'upgrade', halfAt, quote.id)
    expect(order.amountFen).toBe(150000)
    expect(await pay(ws, order, halfAt, '2027-03-01T00:00:00.000Z')).toMatchObject({ grantStatus: 'reconciliation_required', availablePoints: 5500 })
    expect((await db.query('SELECT revision::int AS revision FROM workspace_subscription_periods_v2 WHERE workspace_id=$1', [ws])).rows[0].revision).toBe(1)
  }, 90000)

  it('serializes paid renewals into future periods and releases future points once without extending expired windows', async () => {
    const ws = await workspace('renewal'); await activate(ws, 'renewal-key')
    const a = await create(ws, basic, 'renewal-a', 'renewal'), b = await create(ws, basic, 'renewal-b', 'renewal')
    await Promise.all([pay(ws, a, halfAt), pay(ws, b, halfAt)])
    const periods = (await db.query('SELECT period_start,period_end FROM workspace_subscription_periods_v2 WHERE workspace_id=$1 ORDER BY period_start', [ws])).rows
    expect(periods).toEqual([{ period_start: new Date(firstAt), period_end: new Date(endAt) }, { period_start: new Date(endAt), period_end: new Date('2027-03-28T00:00:00.000Z') }, { period_start: new Date('2027-03-28T00:00:00.000Z'), period_end: new Date('2027-04-28T00:00:00.000Z') }])
    const points = new PostgresCreativePointRepository(app)
    expect((await points.getBalance(ws)).availablePoints).toBe(5500)
    expect(await transactions.dispatchDueScheduledGrants({ workspaceId: ws, now: halfAt })).toMatchObject({ dispatched: 0 })
    expect(await transactions.dispatchDueScheduledGrants({ workspaceId: ws, now: endAt })).toMatchObject({ dispatched: 1 })
    expect(await transactions.dispatchDueScheduledGrants({ workspaceId: ws, now: endAt })).toMatchObject({ dispatched: 0 })
    expect((await points.getBalance(ws)).availablePoints).toBe(10500)
    expect(await transactions.dispatchDueScheduledGrants({ workspaceId: ws, now: '2027-05-01T00:00:00.000Z' })).toMatchObject({ expired: 1, dispatched: 0 })
    expect((await db.query('SELECT count(*)::int n FROM workspace_subscription_periods_v2 WHERE workspace_id=$1', [ws])).rows[0].n).toBe(3)
  }, 90000)

  it('restores only the latest unused upgrade source while preserving opening gifts and unrelated point grants', async () => {
    vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date(halfAt))
    try {
    const ws = await workspace('refund'); await activate(ws, 'refund-key')
    const storage = new PostgresStorageQuotaRepository(app)
    await storage.reserve({workspaceId:ws,reservationKey:'stored-before-upgrade',assetId:'asset-base',bytes:200,limitBytes:0,commercialEntitlement:true})
    await storage.settle({workspaceId:ws,reservationKey:'stored-before-upgrade',actualBytes:150})
    const points = new PostgresCreativePointRepository(app)
    await points.grant({ workspaceId: ws, idempotencyKey: 'unrelated-points', sourceType: 'test_approved_adjustment', sourceId: 'unrelated-pack', points: 250 })
    const quote = await transactions.createUpgradeQuote({ workspaceId: ws, actorId: 'buyer', targetSkuCode: recoveryGrowth.code, idempotencyKey: 'refund-quote', now: halfAt })
    const order = await create(ws, recoveryGrowth, 'refund-upgrade', 'upgrade', halfAt, quote.id)
    await pay(ws, order, halfAt)
    await storage.reserve({workspaceId:ws,reservationKey:'reserved-after-upgrade',assetId:'asset-upgraded',bytes:100,limitBytes:0,commercialEntitlement:true})
    expect(await storage.getSnapshot(ws)).toEqual({limitBytes:2000,usedBytes:150,reservedBytes:100})
    const pointsToRevoke = quote.benefitIncrements.find(value => value.code === 'monthly_creative_points')!.quantity
    const refunds = new PostgresCommercialRefundRepository(ops, (client, input) => transactions.transactionsV3.preflightSourceRecoveryInTransaction(client, input))
    await refunds.request({ workspaceId: ws, orderId: order.id, requestId: 'source-refund', refundKind: 'monthly_unused_points', amountFen: order.amountFen, pointsToRevoke, reason: 'owned QA unused upgrade return', actorId: 'maker', evidence: { supplement_agreement_ref: 'owned-QA-consent' }, at: halfAt })
    await refunds.approve({ workspaceId: ws, requestId: 'source-refund', actorId: 'finance', reason: 'approved source recovery', policyApproval: { policy_version: 'owned-source-recovery-v1', legal_review_ref: 'owned-QA-law' }, at: halfAt })
    expect((await db.query('SELECT status FROM workspace_subscription_periods_v2 WHERE workspace_id=$1', [ws])).rows[0].status).toBe('blocked')
    await expect(storage.reserve({workspaceId:ws,reservationKey:'blocked-during-refund',assetId:'blocked',bytes:1,limitBytes:0,commercialEntitlement:true})).rejects.toMatchObject({code:'COMMERCIAL_ENTITLEMENT_REQUIRED'})
    expect(await storage.getSnapshot(ws)).toEqual({limitBytes:2000,usedBytes:150,reservedBytes:100})
    const completion = { workspaceId: ws, requestId: 'source-refund', actorId: 'finance', reason: 'owned QA factual external refund', externalRefundId: 'owned-QA-refund-bank', evidence: { bank_receipt_ref: 'fixture-only-not-real-money' }, at: halfAt }
    await refunds.completeWithPointRevoke(completion, new PostgresCreativePointLifecycleRepository(ops))
    await refunds.completeWithPointRevoke(completion, new PostgresCreativePointLifecycleRepository(ops))
    expect((await points.getBalance(ws)).availablePoints).toBe(5750)
    await storage.reserve({workspaceId:ws,reservationKey:'after-restoration',assetId:'restored',bytes:1,limitBytes:0,commercialEntitlement:true})
    expect(await storage.getSnapshot(ws)).toEqual({limitBytes:1000,usedBytes:150,reservedBytes:101})
    expect((await db.query('SELECT period_start,period_end,status,revision::int AS revision FROM workspace_subscription_periods_v2 WHERE workspace_id=$1', [ws])).rows[0]).toEqual({ period_start: new Date(firstAt), period_end: new Date(endAt), status: 'active', revision: 3 })
    const restored = await transactions.createUpgradeQuote({ workspaceId: ws, actorId: 'buyer', targetSkuCode: premium.code, idempotencyKey: 'restored-baseline', now: halfAt })
    expect(restored).toMatchObject({ currentCyclePriceFen: 200000, amountFen: 400000, periodEnd: endAt })
    expect((await db.query('SELECT count(*)::int n FROM creative_point_grants WHERE workspace_id=$1 AND source_id=$2', [ws, 'unrelated-pack'])).rows[0].n).toBe(1)
    } finally {vi.useRealTimers()}
  }, 90000)
  it('blocks full source restoration when real stored plus reserved bytes exceed the prior quota without clearing usage',async()=>{
    vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date(halfAt))
    try {
      const ws=await workspace('storage-block');await activate(ws,'storage-block')
      const quote=await transactions.createUpgradeQuote({workspaceId:ws,actorId:'buyer',targetSkuCode:recoveryGrowth.code,idempotencyKey:'storage-block-quote',now:halfAt})
      const order=await create(ws,recoveryGrowth,'storage-block-upgrade','upgrade',halfAt,quote.id);await pay(ws,order,halfAt)
      const storage=new PostgresStorageQuotaRepository(app)
      await storage.reserve({workspaceId:ws,reservationKey:'actual-upgraded-object',assetId:'actual-upgraded-object',bytes:1100,limitBytes:0,commercialEntitlement:true})
      await storage.settle({workspaceId:ws,reservationKey:'actual-upgraded-object',actualBytes:900})
      await storage.reserve({workspaceId:ws,reservationKey:'pending-upgraded-object',assetId:'pending-upgraded-object',bytes:200,limitBytes:0,commercialEntitlement:true})
      const refunds=new PostgresCommercialRefundRepository(ops,(client,input)=>transactions.preflightSourceRecoveryInTransaction(client,input))
      await refunds.request({workspaceId:ws,orderId:order.id,requestId:'blocked-storage-refund',refundKind:'monthly_unused_points',amountFen:order.amountFen,pointsToRevoke:quote.benefitIncrements.find(b=>b.code==='monthly_creative_points')!.quantity,actorId:'maker',reason:'actual source capacity preflight',evidence:{supplement_agreement_ref:'owned-QA'},at:halfAt})
      await expect(refunds.approve({workspaceId:ws,requestId:'blocked-storage-refund',actorId:'finance',reason:'cannot silently erase bytes',policyApproval:{policy_version:'owned-source-recovery-v1',legal_review_ref:'owned-QA-law'},at:halfAt})).rejects.toMatchObject({code:'COMMERCIAL_POLICY_UNRESOLVED'})
      expect(await storage.getSnapshot(ws)).toEqual({limitBytes:2000,usedBytes:900,reservedBytes:200})
      expect((await db.query("SELECT status FROM workspace_subscription_periods_v2 WHERE workspace_id=$1",[ws])).rows[0].status).toBe('active')
      expect((await db.query("SELECT count(*)::int n FROM commercial_source_recovery_holds_v3 WHERE workspace_id=$1",[ws])).rows[0].n).toBe(0)
    } finally {vi.useRealTimers()}
  },90000)

  it('blocks source restoration below actual created brands and connected store counts',async()=>{
    vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date(halfAt))
    try {
    for (const resource of ['brand','store']) {
      const ws=await workspace(`${resource}-block`);await activate(ws,`${resource}-block`)
      const quote=await transactions.createUpgradeQuote({workspaceId:ws,actorId:'buyer',targetSkuCode:recoveryGrowth.code,idempotencyKey:`${resource}-block-quote`,now:halfAt})
      const order=await create(ws,recoveryGrowth,`${resource}-block-upgrade`,'upgrade',halfAt,quote.id);await pay(ws,order,halfAt)
      if (resource==='brand') {
        const brands=new PostgresBrandUnitRepository(app,{commercialEntitlement:true})
        await brands.createBrand({workspaceId:ws,id:'actual-brand-one',name:'actual brand one'})
        await brands.createBrand({workspaceId:ws,id:'actual-brand-two',name:'actual brand two'})
      } else {
        const accounts=new PostgresBusinessRepository(app,{normalizedProjection:true,commercialEntitlement:true})
        for(let n=0;n<6;n++) await accounts.save({workspaceId:ws,entityType:'platform_account',entityId:`${ws}-account-${n}`,entityVersion:1,payload:{id:`${ws}-account-${n}`,workspaceId:ws,platform:'taobao',remoteAccountId:`shop-${n}`,credentialRef:'vault://isolated-QA',tokenState:'active'}})
      }
      const refunds=new PostgresCommercialRefundRepository(ops,(client,input)=>transactions.preflightSourceRecoveryInTransaction(client,input))
      await refunds.request({workspaceId:ws,orderId:order.id,requestId:'blocked-count-refund',refundKind:'monthly_unused_points',amountFen:order.amountFen,pointsToRevoke:quote.benefitIncrements.find(b=>b.code==='monthly_creative_points')!.quantity,actorId:'maker',reason:'actual source count preflight',evidence:{supplement_agreement_ref:'owned-QA'},at:halfAt})
      await expect(refunds.approve({workspaceId:ws,requestId:'blocked-count-refund',actorId:'finance',reason:'actual resources exceed prior contract',policyApproval:{policy_version:'owned-source-recovery-v1',legal_review_ref:'owned-QA-law'},at:halfAt})).rejects.toMatchObject({code:'COMMERCIAL_POLICY_UNRESOLVED'})
      expect((await db.query("SELECT status FROM workspace_subscription_periods_v2 WHERE workspace_id=$1",[ws])).rows[0].status).toBe('active')
    }
    } finally {vi.useRealTimers()}
  },90000)

  it('blocks automatic feature downgrade when source-bound unused operation evidence is unavailable',async()=>{
    const ws=await workspace('feature-block');await activate(ws,'feature-block')
    const quote=await transactions.createUpgradeQuote({workspaceId:ws,actorId:'buyer',targetSkuCode:growth.code,idempotencyKey:'feature-block-quote',now:halfAt})
    const order=await create(ws,growth,'feature-block-upgrade','upgrade',halfAt,quote.id);await pay(ws,order,halfAt)
    const refunds=new PostgresCommercialRefundRepository(ops,(client,input)=>transactions.preflightSourceRecoveryInTransaction(client,input))
    await refunds.request({workspaceId:ws,orderId:order.id,requestId:'feature-source-refund',refundKind:'monthly_unused_points',amountFen:order.amountFen,pointsToRevoke:quote.benefitIncrements.find(b=>b.code==='monthly_creative_points')!.quantity,actorId:'maker',reason:'feature usage source cannot be inferred from points',evidence:{supplement_agreement_ref:'owned-QA'},at:halfAt})
    await expect(refunds.approve({workspaceId:ws,requestId:'feature-source-refund',actorId:'finance',reason:'controlled feature recovery required',policyApproval:{policy_version:'owned-source-recovery-v1',legal_review_ref:'owned-QA-law'},at:halfAt})).rejects.toMatchObject({code:'COMMERCIAL_POLICY_UNRESOLVED'})
    expect((await db.query("SELECT count(*)::int n FROM commercial_source_recovery_holds_v3 WHERE workspace_id=$1",[ws])).rows[0].n).toBe(0)
  },90000)

  it('reads frozen onboarding gifts and actual ledger origins with tenant isolation, later schedules and ambiguous consumption', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(firstAt))
    try {
      const ws = await workspace('gift-read'), other = await workspace('gift-read-other')
      const checkout = await activate(ws, 'gift-read-first')
      const reader = new PostgresCommercialPointOriginReadRepository(app), points = new PostgresCreativePointRepository(app)
      const plan = await reader.readOnboardingGifts(ws)
      expect(plan).toMatchObject({ status: 'available', blockers: [], plans: [{ source_order_id: checkout.onboarding.id, sku_version_id: opening.versionId, points_per_grant: 500, grant_count: 6, policy_ref: opening.payload.policyRef }] })
      expect(plan.plans![0]!.batches).toHaveLength(6)
      expect(plan.plans![0]!.batches[0]).toMatchObject({ sequence: 1, points: 500, schedule_status: 'granted', grant_id: expect.any(String), granted_at: firstAt, dispatch_id: null })
      const initial = (await points.listStatement(ws)).items
      const initialOrigins = await reader.readStatementOrigins(ws, initial.map(entry => entry.id))
      expect(Object.values(initialOrigins).map(origin => origin.kind).sort()).toEqual(['onboarding_gift', 'subscription_points'])
      expect(Object.values(initialOrigins).find(origin => origin.kind === 'onboarding_gift')).toMatchObject({ source_order_id: checkout.onboarding.id, sequence: 1 })
      expect(await reader.readOnboardingGifts(other)).toEqual({ status: 'available', plans: [], blockers: [] })
      expect(Object.values(await reader.readStatementOrigins(other, initial.map(entry => entry.id))).every(origin => origin.status === 'unknown' && origin.source_order_id === null)).toBe(true)
      const reservation = await points.reserve({ workspaceId: ws, idempotencyKey: 'gift-read-reserve', actionKey: 'gift-read-mixed', points: 5500, rateCardVersion: 'owned-fixture', at: firstAt })
      expect((await db.query('SELECT count(DISTINCT grant_id)::int n FROM creative_point_allocations WHERE workspace_id=$1 AND reservation_id=$2', [ws, reservation.value.id])).rows[0].n).toBe(2)
      const reserved = (await points.listStatement(ws)).items.find(entry => entry.eventType === 'reserved')!
      expect((await reader.readStatementOrigins(ws, [reserved.id]))[reserved.id]).toMatchObject({ status: 'unknown', source_order_id: null })
      await points.release({ workspaceId: ws, reservationId: reservation.value.id, idempotencyKey: 'gift-read-release', at: firstAt })
      const code = `gift-read-three-month-${randomUUID()}`
      await catalog.mutate({ action: 'create', code, kind: 'monthly', priceFen: 400000, payload: { ...basic.payload, cycle: { unit: 'month', count: 3 }, pointGrantPolicy: { cadence: 'monthly' } }, benefits: basic.benefits, expectedRevision: 0, idempotencyKey: `${code}:create`, actorId: 'maker', reason: 'owned approved three-month read fixture', evidence: {} })
      const approved = await catalog.mutate({ action: 'approve', code, expectedRevision: 1, idempotencyKey: `${code}:approve`, actorId: 'approver', reason: 'owned approved three-month read fixture', evidence: {} })
      const threeMonth = await catalog.mutate({ action: 'publish', code, versionId: approved.versionId, expectedRevision: 2, idempotencyKey: `${code}:publish`, actorId: 'publisher', reason: 'owned approved three-month read fixture', evidence: {} })
      const renewal = await create(ws, threeMonth, 'gift-read-renewal', 'renewal'); await pay(ws, renewal, halfAt)
      const firstGrant = plan.plans![0]!.batches[0]!.grant_id!
      vi.setSystemTime(new Date(endAt))
      await new PostgresCreativePointLifecycleRepository(app).expireGrant({ workspaceId: ws, grantId: firstGrant, idempotencyKey: 'gift-read-expiry', at: endAt })
      expect(await new PostgresOnboardingGrantDispatchRepository(app).dispatchDue({ workspaceId: ws, now: endAt })).toMatchObject({ dispatched: 1 })
      expect(await transactions.dispatchDueScheduledGrants({ workspaceId: ws, now: endAt })).toMatchObject({ dispatched: 1 })
      const march = '2027-03-28T00:00:00.000Z'; vi.setSystemTime(new Date(march))
      expect(await transactions.dispatchDueScheduledGrants({ workspaceId: ws, now: march })).toMatchObject({ dispatched: 1 })
      const laterPlan = await reader.readOnboardingGifts(ws)
      expect(laterPlan?.status).toBe('available')
      expect(laterPlan?.plans?.[0]?.points_per_grant).toBe(500)
      expect(laterPlan?.plans?.[0]?.batches?.slice(0, 2)).toEqual(expect.arrayContaining([
        expect.objectContaining({ expired_by_time: true, expiration_id: expect.any(String), expired_at: endAt }),
        expect.objectContaining({ sequence: 2, points: 500, dispatch_id: expect.any(String), dispatched_at: endAt, grant_id: expect.any(String) }),
      ]))
      const statement = (await points.listStatement(ws, { limit: 100 })).items
      const origins = await reader.readStatementOrigins(ws, statement.map(entry => entry.id))
      const expiry = statement.find(entry => (entry.eventType as string) === 'expired')!
      expect(origins[expiry.id]).toMatchObject({ status: 'known', kind: 'onboarding_gift', source_order_id: checkout.onboarding.id, grant_id: firstGrant })
      const scheduled = statement.find(entry => entry.grantSourceType === 'commercial_schedule_v3')!
      expect(origins[scheduled.id]).toMatchObject({ status: 'known', kind: 'subscription_points', source_order_id: renewal.id, sequence: 2, schedule_id: expect.any(String) })
      expect(Object.values(origins).some(origin => origin.kind === 'onboarding_gift' && origin.sequence === 2)).toBe(true)
    } finally { vi.useRealTimers() }
  }, 90000)

  it('dispatches frozen six monthly gifts, expires each anniversary and does not backfill missed windows after repricing to 600', async () => {
    const ws = await workspace('frozen-gifts'), missedWs = await workspace('missed-gifts')
    const checkout = await first(ws, 'frozen-gifts'), missedCheckout = await first(missedWs, 'missed-gifts')
    const firstGift = await pay(ws, checkout.onboarding, firstAt)
    await pay(missedWs, missedCheckout.onboarding, firstAt)
    expect(firstGift.availablePoints).toBe(500)
    const draft = await catalog.mutate({ action: 'create', code: opening.code, priceFen: 600000, payload: { ...opening.payload, grantSchedule: { ...(opening.payload.grantSchedule as Record<string, unknown>), pointsPerGrant: 600 } }, benefits: [benefit('creative_points', 600, 'point')], expectedRevision: 3, idempotencyKey: 'opening-600-draft', actorId: 'maker', reason: 'owned QA approved new gift policy', evidence: {} })
    const approved = await catalog.mutate({ action: 'approve', code: opening.code, versionId: draft.versionId, expectedRevision: 4, idempotencyKey: 'opening-600-approve', actorId: 'approver', reason: 'owned QA gift policy approval', evidence: {} })
    const newOpening = await catalog.mutate({ action: 'publish', code: opening.code, versionId: approved.versionId, expectedRevision: 5, idempotencyKey: 'opening-600-publish', actorId: 'publisher', reason: 'owned QA gift policy publication', evidence: {} })
    const newWs = await workspace('new-600-gifts')
    const newCheckout = await transactions.createFirstCheckout({ workspaceId: newWs, actorId: 'buyer', onboardingSku: newOpening, subscriptionSku: basic, paymentProvider: 'manual_transfer', idempotencyKey: 'new-600-gifts', reason: 'new approved gift policy', now: firstAt })
    expect(await pay(newWs, newCheckout.onboarding, firstAt)).toMatchObject({ availablePoints: 600 })
    const schedules = (await db.query<{ sequence: number; points: number; due_at: Date; expires_at: Date }>('SELECT sequence,points::int AS points,due_at,expires_at FROM onboarding_point_grant_schedules_v2 WHERE workspace_id=$1 ORDER BY sequence', [ws])).rows
    expect(schedules.map(row => row.points)).toEqual([500,500,500,500,500,500])
    const dispatcher = new PostgresOnboardingGrantDispatchRepository(app), lifecycle = new PostgresCreativePointLifecycleRepository(app)
    let previousGrant = firstGift.grantId!
    for (const schedule of schedules.slice(1)) {
      const due = schedule.due_at.toISOString()
      expect((await lifecycle.expireGrant({ workspaceId: ws, grantId: previousGrant, idempotencyKey: `expiry-${schedule.sequence - 1}`, at: due })).availablePoints).toBe(0)
      const dispatched = await dispatcher.dispatchDue({ workspaceId: ws, now: due, limit: 100 })
      expect(dispatched).toMatchObject({ dispatched: 1, expired: 0 })
      previousGrant = dispatched.grantIds[0]!
      expect((await db.query('SELECT points::int AS points,expires_at FROM creative_point_grants WHERE workspace_id=$1 AND id=$2', [ws, previousGrant])).rows[0]).toEqual({ points: 500, expires_at: schedule.expires_at })
      expect(await dispatcher.dispatchDue({ workspaceId: ws, now: due, limit: 100 })).toMatchObject({ dispatched: 0, expired: 0 })
      expect((await new PostgresCreativePointRepository(app).getBalance(ws, due)).availablePoints).toBe(500)
    }
    const finalExpiry = schedules[5]!.expires_at.toISOString()
    expect((await lifecycle.expireGrant({ workspaceId: ws, grantId: previousGrant, idempotencyKey: 'expiry-final', at: finalExpiry })).availablePoints).toBe(0)
    expect((await db.query('SELECT count(*)::int AS grants,sum(points)::int AS total FROM creative_point_grants WHERE workspace_id=$1', [ws])).rows[0]).toEqual({ grants: 6, total: 3000 })
    expect(await dispatcher.dispatchDue({ workspaceId: newWs, now: schedules[1]!.due_at.toISOString() })).toMatchObject({ dispatched: 1 })
    expect((await db.query("SELECT points::int AS points FROM creative_point_grants WHERE workspace_id=$1 AND source_type='onboarding_schedule_v2'", [newWs])).rows).toEqual([{ points: 600 }])
    expect(await dispatcher.dispatchDue({ workspaceId: missedWs, now: schedules[2]!.due_at.toISOString() })).toMatchObject({ dispatched: 1, expired: 1 })
    expect((await db.query('SELECT sequence,points::int AS points FROM onboarding_point_grant_expirations_v2 WHERE workspace_id=$1', [missedWs])).rows).toEqual([{ sequence: 2, points: 500 }])
    expect(await dispatcher.dispatchDue({ workspaceId: missedWs, now: '2027-08-31T00:00:00.000Z' })).toMatchObject({ dispatched: 0, expired: 3 })
  }, 90000)


})
