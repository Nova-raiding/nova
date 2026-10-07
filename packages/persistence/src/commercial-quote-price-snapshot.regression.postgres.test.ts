import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PostgresCommercialCatalogRepository, type CommercialCatalogBenefit, type CommercialCatalogSkuSnapshot } from './commercial-catalog-repository.js'
import { PostgresCommercialContractRepository } from './commercial-contract-repository.js'
import { loadMigrations, MigrationRunner } from './migration.js'
import { dropDrainedPostgresFixture, withPostgresFixtureCleanup } from './postgres-scope-fixture-cleanup.js'

const source = process.env.PERSISTENCE_RELEASE_DATABASE_URL
const at = '2027-01-31T00:00:00.000Z'
const quoteAt = '2027-02-14T00:00:00.000Z'
const digest = 'b'.repeat(64)
const benefit = (code: string, quantity: number, unit: string): CommercialCatalogBenefit => ({
  code, quantity, normalizedValue: quantity, rawValue: null, rawUnit: unit,
  policyRef: 'quote-price-snapshot-regression', metadata: {},
})

describe.skipIf(!source)('upgrade quote price snapshot PostgreSQL regression', () => {
  const databaseName = `quote_snapshot_${randomUUID().replaceAll('-', '')}`
  let admin: Pool
  let db: Pool
  let app: Pool
  let ops: Pool
  let catalog: PostgresCommercialCatalogRepository
  let contracts: PostgresCommercialContractRepository
  let onboarding: CommercialCatalogSkuSnapshot
  let basic: CommercialCatalogSkuSnapshot
  let growth: CommercialCatalogSkuSnapshot

  beforeAll(async () => {
    admin = new Pool({ connectionString: source!, connectionTimeoutMillis: 10_000 })
    await admin.query(`CREATE DATABASE "${databaseName}"`)
    const connection = new URL(source!)
    connection.pathname = `/${databaseName}`
    db = new Pool({ connectionString: connection.toString(), max: 6 })
    await new MigrationRunner(db, await loadMigrations()).run()
    await db.query(await readFile(new URL('../../../infra/local/ensure-app-role.sql', import.meta.url), 'utf8'))

    const roleConnection = (role: string) => {
      const value = new URL(connection)
      value.username = role
      value.password = `${role}_local_only`
      return value.toString()
    }
    app = new Pool({ connectionString: roleConnection('merchant_app'), max: 6 })
    ops = new Pool({ connectionString: roleConnection('merchant_ops'), max: 4 })
    catalog = new PostgresCommercialCatalogRepository(ops)
    contracts = new PostgresCommercialContractRepository(app)

    const publish = async (code: string, kind: 'onboarding' | 'monthly', priceFen: number, rank?: number) => {
      const payload = {
        blockers: [],
        sourceRecoveryPolicy: { approved: true, version: 'quote-snapshot-recovery-v1', effect: 'cancel_contract' },
        purchasePolicy: { approved: true, version: 'quote-snapshot-window-v1', expiresInSeconds: 604800 },
        ...(kind === 'onboarding'
          ? {
              policyRef: { policyId: 'commercial.onboarding', version: 'v2' },
              grantSchedule: { policyRef: { policyId: 'commercial.onboarding', version: 'v2' }, grantCount: 6, pointsPerGrant: 500, cadence: 'monthly', timezone: 'UTC', startsAt: 'payment_verified', grantExpiresAtRule: 'next_monthly_anniversary', schedulingStatus: 'resolved' },
            }
          : {
              cycle: { unit: 'month', count: 1 },
              pointGrantPolicy: { cadence: 'once' },
              planFamily: 'quote-snapshot-family',
              tierRank: rank,
              upgradePolicy: { approved: true, version: 'remaining-period-quote-snapshot-v1' },
            }),
      }
      const benefits = kind === 'onboarding'
        ? [benefit('creative_points', 500, 'point')]
        : [benefit('monthly_creative_points', rank === 1 ? 5_000 : 12_500, 'point'), benefit('max_brands', rank!, 'brand'), benefit('max_stores', rank! * 5, 'store'), benefit('cloud_storage', rank! * 1_000, 'byte')]
      await catalog.mutate({ action: 'create', code, kind, priceFen, payload, benefits, expectedRevision: 0, idempotencyKey: `${code}:create`, actorId: 'qa-maker', reason: 'isolated quote snapshot fixture', evidence: {} })
      const approved = await catalog.mutate({ action: 'approve', code, expectedRevision: 1, idempotencyKey: `${code}:approve`, actorId: 'qa-approver', reason: 'isolated quote snapshot fixture', evidence: { approval_ref: 'fixture-only' } })
      return catalog.mutate({ action: 'publish', code, versionId: approved.versionId, expectedRevision: 2, idempotencyKey: `${code}:publish`, actorId: 'qa-publisher', reason: 'isolated quote snapshot fixture', evidence: {} })
    }

    onboarding = await publish('quote-snapshot-opening', 'onboarding', 500_000)
    basic = await publish('quote-snapshot-basic', 'monthly', 200_000, 1)
    growth = await publish('quote-snapshot-growth', 'monthly', 500_000, 2)
  }, 120_000)

  afterAll(async () => {
    await withPostgresFixtureCleanup(async () => {
      await app?.end()
      await ops?.end()
      await db?.end()
      if (admin) await dropDrainedPostgresFixture(admin, databaseName)
    }, undefined, [async () => { await admin?.end() }])
  }, 60_000)

  it('persists and reads back the quoted target SKU version, price, and benefits after the live catalog is repriced', async () => {
    const workspaceId = `quote-snapshot-${randomUUID()}`
    await db.query("INSERT INTO workspaces(id,status) VALUES($1,'active')", [workspaceId])
    const checkout = await contracts.createFirstCheckout({
      workspaceId, actorId: 'buyer', onboardingSku: onboarding, subscriptionSku: basic,
      paymentProvider: 'manual_transfer', idempotencyKey: 'quote-snapshot-checkout',
      reason: 'isolated regression setup', now: at,
    })
    for (const order of [checkout.onboarding, checkout.subscription]) {
      await contracts.recordVerifiedPaymentAndGrant({
        workspaceId, orderId: order.id, provider: 'manual_transfer', providerOrderId: `fixture:${order.id}`,
        providerEventId: `fixture-event:${order.id}`, nonce: `fixture-nonce:${order.id}`,
        payloadHash: digest, amountFen: order.amountFen, currency: 'CNY', paidAt: at, verifiedAt: at,
      })
    }
    expect((await contracts.getOnboardingStatus(workspaceId)).qualified).toBe(true)

    const quote = await contracts.createUpgradeQuote({ workspaceId, actorId: 'buyer', targetSkuCode: growth.code, idempotencyKey: 'quote-snapshot-upgrade', now: quoteAt })
    const frozenTargetVersionId = quote.targetSkuVersionId
    const frozenPriceFen = quote.targetCyclePriceFen
    const frozenBenefits = quote.resolvedTargetBenefits
    expect(quote.amountFen).toBe(150_000)

    const draft = await catalog.mutate({ action: 'create', code: growth.code, priceFen: 650_000, expectedRevision: 3, idempotencyKey: 'quote-snapshot-reprice', actorId: 'qa-maker', reason: 'isolated catalog repricing', evidence: {} })
    const approved = await catalog.mutate({ action: 'approve', code: growth.code, versionId: draft.versionId, expectedRevision: 4, idempotencyKey: 'quote-snapshot-reprice-approve', actorId: 'qa-approver', reason: 'isolated catalog repricing', evidence: { approval_ref: 'fixture-only' } })
    await catalog.mutate({ action: 'publish', code: growth.code, versionId: approved.versionId, expectedRevision: 5, idempotencyKey: 'quote-snapshot-reprice-publish', actorId: 'qa-publisher', reason: 'isolated catalog repricing', evidence: {} })
    const currentSale = await catalog.get(growth.code)
    expect(currentSale?.versionId).not.toBe(frozenTargetVersionId)
    expect(currentSale?.priceFen).toBe(650_000)

    const order = await contracts.createOrder({
      workspaceId, sku: growth, idempotencyKey: 'quote-snapshot-upgrade-order', createdByActorId: 'buyer',
      paymentProvider: 'manual_transfer', reason: 'honor immutable quote', purchaseKind: 'upgrade',
      upgradeQuoteId: quote.id, now: quoteAt,
    })
    const readback = await contracts.getOrderSnapshot(workspaceId, order.id)
    const stored = (await db.query<{ skuVersionId: string; amountFen: number; snapshot: { sku: CommercialCatalogSkuSnapshot; purchase_terms: { upgradeQuoteId: string } } }>(
      `SELECT o.sku_version_id AS "skuVersionId",o.amount_fen::int AS "amountFen",s.snapshot
       FROM commercial_orders_v2 o JOIN commercial_order_snapshots_v2 s ON s.workspace_id=o.workspace_id AND s.order_id=o.id
       WHERE o.workspace_id=$1 AND o.id=$2`, [workspaceId, order.id],
    )).rows[0]

    expect(order).toMatchObject({ amountFen: quote.amountFen, skuVersionId: frozenTargetVersionId, purchaseKind: 'upgrade', upgradeQuoteId: quote.id })
    expect(readback).not.toBeNull()
    expect(readback!.order).toMatchObject({ id: order.id, amountFen: quote.amountFen, skuVersionId: frozenTargetVersionId, upgradeQuoteId: quote.id })
    expect(readback!.snapshot.sku).toMatchObject({ versionId: frozenTargetVersionId, priceFen: frozenPriceFen, benefits: frozenBenefits })
    expect(stored).toMatchObject({ skuVersionId: frozenTargetVersionId, amountFen: quote.amountFen })
    expect(stored!.snapshot).toEqual(readback!.snapshot)
    expect(stored!.snapshot.purchase_terms.upgradeQuoteId).toBe(quote.id)
    expect(stored!.snapshot.sku.versionId).not.toBe(currentSale!.versionId)
    expect(stored!.snapshot.sku.priceFen).not.toBe(currentSale!.priceFen)
  }, 90_000)
})
