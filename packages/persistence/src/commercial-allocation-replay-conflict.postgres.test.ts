import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { PostgresCommercialCatalogRepository, type CommercialCatalogBenefit, type CommercialCatalogSkuSnapshot } from './commercial-catalog-repository.js'
import { PostgresCommercialContractRepository } from './commercial-contract-repository.js'
import { PostgresCommercialReceiptRepository } from './commercial-receipt-repository.js'
import { loadMigrations, MigrationRunner } from './migration.js'
import { dropDrainedPostgresFixture, withPostgresFixtureCleanup } from './postgres-scope-fixture-cleanup.js'

const source = process.env.PERSISTENCE_RELEASE_DATABASE_URL
const at = '2027-01-31T00:00:00.000Z'
const benefit = (code: string, quantity: number, unit: string): CommercialCatalogBenefit => ({ code, quantity, normalizedValue: quantity, rawValue: null, rawUnit: unit, policyRef: 'isolated-allocation-replay-policy', metadata: {} })

describe.skipIf(!source)('commercial allocation replay conflict on isolated PostgreSQL', () => {
  const databaseName = `allocation_replay_${randomUUID().replaceAll('-', '')}`
  let admin: Pool | undefined
  let database: Pool | undefined
  let app: Pool | undefined
  let ops: Pool | undefined
  let catalog: PostgresCommercialCatalogRepository
  let transactions: PostgresCommercialContractRepository
  let opening: CommercialCatalogSkuSnapshot
  let basic: CommercialCatalogSkuSnapshot

  beforeAll(async () => {
    admin = new Pool({ connectionString: source!, connectionTimeoutMillis: 10000 })
    await admin.query(`CREATE DATABASE "${databaseName}"`)
    const databaseUrl = new URL(source!)
    databaseUrl.pathname = `/${databaseName}`
    database = new Pool({ connectionString: databaseUrl.toString(), max: 6 })
    await new MigrationRunner(database, await loadMigrations()).run()
    await database.query(await readFile(new URL('../../../infra/local/ensure-app-role.sql', import.meta.url), 'utf8'))

    const roleUrl = (role: string) => {
      const url = new URL(databaseUrl)
      url.username = role
      url.password = `${role}_local_only`
      return url.toString()
    }
    app = new Pool({ connectionString: roleUrl('merchant_app'), max: 4 })
    ops = new Pool({ connectionString: roleUrl('merchant_ops'), max: 4 })
    catalog = new PostgresCommercialCatalogRepository(ops)
    transactions = new PostgresCommercialContractRepository(app)

    const publish = async (code: string, kind: CommercialCatalogSkuSnapshot['kind'], priceFen: number, rank?: number) => {
      const payload = {
        blockers: [],
        sourceRecoveryPolicy: { approved: true, version: 'isolated-replay-v1', effect: 'cancel_contract' },
        purchasePolicy: { approved: true, version: 'isolated-replay-v1', expiresInSeconds: 604800 },
        ...(kind === 'onboarding'
          ? { policyRef: { policyId: 'commercial.onboarding', version: 'v2' }, grantSchedule: { policyRef: { policyId: 'commercial.onboarding', version: 'v2' }, grantCount: 6, pointsPerGrant: 500, cadence: 'monthly', timezone: 'UTC', startsAt: 'payment_verified', grantExpiresAtRule: 'next_monthly_anniversary', schedulingStatus: 'resolved' } }
          : { cycle: { unit: 'month', count: 1 }, pointGrantPolicy: { cadence: 'once' }, planFamily: 'isolated-replay', tierRank: rank, upgradePolicy: { approved: true, version: 'isolated-replay-v1' } }),
      }
      const benefits = kind === 'onboarding'
        ? [benefit('creative_points', 500, 'point')]
        : [benefit('monthly_creative_points', 5000, 'point'), benefit('max_brands', rank!, 'brand'), benefit('max_stores', rank! * 5, 'store'), benefit('cloud_storage', rank! * 1000, 'byte'), benefit('feature.image_generation', 1, 'permission')]
      await catalog.mutate({ action: 'create', code, kind, priceFen, payload, benefits, expectedRevision: 0, idempotencyKey: `${code}:create`, actorId: 'catalog-maker', reason: 'isolated replay conflict fixture', evidence: {} })
      const approved = await catalog.mutate({ action: 'approve', code, expectedRevision: 1, idempotencyKey: `${code}:approve`, actorId: 'catalog-approver', reason: 'isolated replay conflict fixture', evidence: { approval_ref: 'test-only' } })
      return catalog.mutate({ action: 'publish', code, versionId: approved.versionId, expectedRevision: 2, idempotencyKey: `${code}:publish`, actorId: 'catalog-publisher', reason: 'isolated replay conflict fixture', evidence: {} })
    }
    opening = await publish('isolated-opening', 'onboarding', 500000)
    basic = await publish('isolated-basic', 'monthly', 200000, 1)
  }, 120000)

  afterAll(async () => {
    await withPostgresFixtureCleanup(async () => {
      await app?.end()
      await ops?.end()
      await database?.end()
      if (admin) await dropDrainedPostgresFixture(admin, databaseName)
    }, undefined, [async () => { await admin?.end() }])
  }, 60000)

  it('rejects a reused allocation key with changed amount without changing cash or creating a verified payment', async () => {
    const workspaceId = `allocation-replay-${randomUUID()}`
    await database!.query("INSERT INTO workspaces(id,status) VALUES($1,'active')", [workspaceId])
    const checkout = await transactions.createFirstCheckout({ workspaceId, actorId: 'buyer', onboardingSku: opening, subscriptionSku: basic, paymentProvider: 'manual_transfer', idempotencyKey: 'isolated-replay-checkout', reason: 'isolated replay conflict fixture', now: at })
    const receipts = new PostgresCommercialReceiptRepository(ops!, ops!)
    const receipt = await receipts.record({ workspaceId, source: 'manual_transfer', receivingAccountRef: 'isolated-fixture-bank', externalTradeId: `cash:${workspaceId}`, payerRef: 'fixture-payer', amountFen: 700000, currency: 'CNY', receivedAt: at, verifiedAt: at, actorId: 'finance', evidence: { bank_receipt_ref: 'fixture-only-not-real-cash' } })
    const allocation = { workspaceId, receiptId: receipt.id, orderId: checkout.subscription.id, amountFen: 50000, expectedRevision: receipt.revision, idempotencyKey: 'allocation-replay-conflict-key', actorId: 'finance', at }
    const verifyPayment = vi.fn(async () => { throw new Error('partial or conflicting allocation must not verify payment') })

    await expect(receipts.allocateAndFulfill(allocation, verifyPayment)).resolves.toMatchObject({ allocatedFen: 50000, replayed: false, status: 'partially_received' })
    await expect(receipts.allocateAndFulfill({ ...allocation, amountFen: 60000 }, verifyPayment))
      .rejects.toMatchObject({ code: 'COMMERCIAL_RECEIPT_CONFLICT', message: 'allocation key has another intent' })

    expect(verifyPayment).not.toHaveBeenCalled()
    await expect(receipts.get(workspaceId, receipt.id)).resolves.toMatchObject({ allocatedFen: 50000, availableFen: 650000 })
    await expect(receipts.getAllocationByIdempotencyKey(workspaceId, allocation.idempotencyKey)).resolves.toMatchObject({ amountFen: 50000, actorId: 'finance' })
    await expect(database!.query('SELECT count(*)::int AS count FROM commercial_payment_events_v2 WHERE workspace_id=$1 AND order_id=$2', [workspaceId, checkout.subscription.id])).resolves.toMatchObject({ rows: [{ count: 0 }] })
  }, 90000)
})
