import { describe, expect, it } from 'vitest'
import { CommercialContractError } from './commercial-contract-repository.js'
import type { CommercialCatalogSkuSnapshot } from './commercial-catalog-repository.js'
import { CommercialTransactionRepositoryV3, type CommercialUpgradeQuoteV3 } from './commercial-transaction-repository.js'
import type { SqlClient, SqlPool, SqlQueryResult } from './repository.js'

const at = '2027-02-14T00:05:00.000Z'

const sku = (code: string, rank: number, priceFen: number): CommercialCatalogSkuSnapshot => ({
  id: `${code}-id`, code, kind: 'monthly', visibility: 'public', requiredCapability: null,
  versionId: `${code}-v1`, version: 1, lifecycle: 'approved', executable: true,
  priceFen, currency: 'CNY', priceMode: 'fixed', durationDays: null,
  effectiveAt: '2027-01-01T00:00:00.000Z', checksum: 'a'.repeat(64),
  payload: {
    planFamily: 'expiry-regression', tierRank: rank,
    cycle: { unit: 'month', count: 1 }, pointGrantPolicy: { cadence: 'once' },
    purchasePolicy: { approved: true, version: 'expiry-test-v1', expiresInSeconds: 3600 },
    upgradePolicy: { approved: true, version: 'expiry-test-v1' },
  },
  benefits: [],
})

const sourceSku = sku('basic', 1, 200_000)
const targetSku = sku('growth', 2, 500_000)
const expiredQuote = {
  id: 'quote-expired-between-requests', workspaceId: 'workspace-expiry-test', actorId: 'buyer',
  sourceOrderId: 'paid-source', sourcePeriodId: 'period-current', sourcePeriodRevision: 2,
  sourceEntitlementId: 'entitlement-current', sourceSkuCode: sourceSku.code,
  targetSkuCode: targetSku.code, targetSkuVersionId: targetSku.versionId,
  currentCyclePriceFen: sourceSku.priceFen, targetCyclePriceFen: targetSku.priceFen,
  amountFen: 150_000, currency: 'CNY', periodStart: '2027-02-01T00:00:00.000Z',
  periodEnd: '2027-03-01T00:00:00.000Z', quotedAt: '2027-02-14T00:00:00.000Z',
  expiresAt: '2027-02-14T00:05:00.000Z', remainingMs: 1, totalMs: 2,
  priceNumerator: '1', priceDenominator: '2', algorithmVersion: 'remaining-period-v1',
  benefitIncrements: [], resolvedTargetBenefits: [], sourceSnapshot: sourceSku, targetSnapshot: targetSku,
} as CommercialUpgradeQuoteV3

class ExpiredQuoteDatabase implements SqlClient {
  readonly statements: string[] = []

  async query<Row>(sql: string): Promise<SqlQueryResult<Row>> {
    this.statements.push(sql)
    if (sql.includes('o.idempotency_key=$2')) return { rows: [] }
    if (sql.includes('merchant_resolve_sale_sku_v3')) return { rows: [{ snapshot: targetSku }] as Row[] }
    if (sql.includes('workspace_commercial_onboarding_v3')) return { rows: [{ status: 'active', orderId: 'opening', activatedAt: at }] as Row[] }
    if (sql.includes("status='blocked'")) return { rows: [] }
    if (sql.includes('p.id AS "periodId"')) return { rows: [{
      periodId: 'period-current', revision: 2, periodStart: '2027-02-01T00:00:00.000Z',
      periodEnd: '2027-03-01T00:00:00.000Z', sourceOrderId: 'paid-source',
      entitlementId: 'entitlement-current', sku: sourceSku, resolvedBenefits: [],
    }] as Row[] }
    if (sql.includes('SELECT quote,target_snapshot AS target')) return { rows: [{ quote: expiredQuote, target: targetSku }] as Row[] }
    if (sql.includes('INSERT INTO commercial_orders_v2')) return { rows: [{ id: 'unexpected-order' }] as Row[] }
    return { rows: [] }
  }
}

describe('commercial upgrade quote expiry across requests', () => {
  it('rejects order creation when persisted quote expires before the later create-order request', async () => {
    const db = new ExpiredQuoteDatabase()
    const pool: SqlPool = { connect: async () => db }
    const repository = new CommercialTransactionRepositoryV3(pool)

    await expect(repository.createOrder({
      workspaceId: 'workspace-expiry-test', sku: targetSku, paymentProvider: 'manual_transfer',
      createdByActorId: 'buyer', idempotencyKey: 'expired-quote-order',
      reason: 'reject purchase from expired quote', purchaseKind: 'upgrade',
      upgradeQuoteId: expiredQuote.id, now: at,
    })).rejects.toMatchObject({
      code: 'COMMERCIAL_ENTITLEMENT_CONFLICT',
      message: 'quote expired or source/target changed',
    } satisfies Partial<CommercialContractError>)

    expect(db.statements.some(sql => sql.includes('INSERT INTO commercial_orders_v2'))).toBe(false)
  })
})
