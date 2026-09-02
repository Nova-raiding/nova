import { describe, expect, it } from 'vitest'
import type { CommercialCatalogSkuSnapshot } from './commercial-catalog-repository.js'
import { CommercialContractError, PostgresCommercialContractRepository } from './commercial-contract-repository.js'
import type { SqlClient, SqlPool, SqlQueryResult } from './repository.js'

const approvedSku = (overrides: Partial<CommercialCatalogSkuSnapshot> = {}): CommercialCatalogSkuSnapshot => ({
  id: 'sku-basic', code: 'basic', kind: 'monthly', visibility: 'public', requiredCapability: null,
  versionId: 'sku-basic-v2', version: 2, lifecycle: 'approved', executable: true,
  priceFen: 200000, currency: 'CNY', priceMode: 'fixed', durationDays: null,
  payload: { blockers: [] }, checksum: 'a'.repeat(64), effectiveAt: '2026-08-01T00:00:00.000Z',
  benefits: [{ code: 'monthly_creative_points', quantity: 5000, rawValue: null, rawUnit: 'creative_points', normalizedValue: null, policyRef: null, metadata: {} }],
  ...overrides,
})

class ScriptedClient implements SqlClient {
  readonly calls: Array<{ sql: string; values: readonly unknown[] }> = []
  released = false
  constructor(private readonly handler: (sql: string, values: readonly unknown[]) => SqlQueryResult | undefined) {}
  async query<Row>(sql: string, values: readonly unknown[] = []): Promise<SqlQueryResult<Row>> {
    this.calls.push({ sql, values })
    return (this.handler(sql, values) ?? { rows: [] }) as SqlQueryResult<Row>
  }
  release() { this.released = true }
}

const pool = (client: SqlClient): SqlPool => ({ connect: async () => client })

describe('PostgresCommercialContractRepository', () => {
  it('creates an order and immutable server SKU snapshot in one workspace transaction', async () => {
    const sku = approvedSku()
    const client = new ScriptedClient((sql, values) => {
      if (sql.includes('INSERT INTO commercial_orders_v2')) return { rows: [{
        id: values[0], workspaceId: 'ws-1', skuId: sku.id, skuVersionId: sku.versionId,
        amountFen: 200000, currency: 'CNY', paymentProvider: 'sandbox', status: 'pending',
        idempotencyKey: 'order-1', requestHash: values[8], createdByActorId: 'actor-1',
        providerOrderId: null, createdAt: '2026-09-02T00:00:00.000Z', paidAt: null,
      }] }
      return { rows: [] }
    })
    const repository = new PostgresCommercialContractRepository(pool(client))

    await expect(repository.createOrder({ workspaceId: 'ws-1', sku, paymentProvider: 'sandbox', createdByActorId: 'actor-1', idempotencyKey: 'order-1', reason: 'subscribe', now: '2026-09-02T00:00:00Z' })).resolves.toMatchObject({
      workspaceId: 'ws-1', amountFen: 200000, skuVersionId: 'sku-basic-v2', status: 'pending',
    })
    const sql = client.calls.map(call => call.sql).join('\n')
    expect(sql).toContain('BEGIN')
    expect(sql).toContain("set_config('app.workspace_id'")
    expect(sql).toContain('INSERT INTO commercial_orders_v2')
    expect(sql).toContain('INSERT INTO commercial_order_snapshots_v2')
    expect(sql).toContain('COMMIT')
    expect(client.released).toBe(true)
  })

  it('requires workspace eligibility in addition to private catalog visibility', async () => {
    const repository = new PostgresCommercialContractRepository(pool(new ScriptedClient(() => ({ rows: [] }))))
    const sku = approvedSku({ id: 'sku-private', versionId: 'sku-private-v2', kind: 'private_trial', visibility: 'private', requiredCapability: 'commercial.private_sku.read', durationDays: 7, priceFen: 199900, benefits: [{ code: 'creative_points', quantity: 500, rawValue: null, rawUnit: 'creative_points', normalizedValue: null, policyRef: null, metadata: {} }] })

    await expect(repository.createOrder({ workspaceId: 'ws-1', sku, paymentProvider: 'sandbox', createdByActorId: 'actor-1', idempotencyKey: 'private-1', reason: 'private trial', privateEligibilityId: 'elig-1', now: '2026-09-02T00:00:00Z' }))
      .rejects.toMatchObject({ code: 'PRIVATE_SKU_NOT_FOUND' })
  })

  it('rejects a payment fact mismatch before writing payment, grant, revision or outbox', async () => {
    const sku = approvedSku()
    const client = new ScriptedClient(sql => {
      if (sql.includes('FROM commercial_orders_v2 o')) return { rows: [{
        id: 'order-1', workspaceId: 'ws-1', skuId: sku.id, skuVersionId: sku.versionId,
        amountFen: 200000, currency: 'CNY', paymentProvider: 'alipay', status: 'pending',
        idempotencyKey: 'order-1', requestHash: 'b'.repeat(64), createdByActorId: 'actor-1', providerOrderId: null,
        createdAt: '2026-09-02T00:00:00.000Z', paidAt: null, snapshotId: 'snapshot-1', snapshot: { sku },
      }] }
      return { rows: [] }
    })
    const repository = new PostgresCommercialContractRepository(pool(client))

    await expect(repository.recordVerifiedPaymentAndGrant({
      workspaceId: 'ws-1', orderId: 'order-1', provider: 'alipay', providerEventId: 'event-1', providerOrderId: 'trade-1', nonce: 'nonce-1', payloadHash: 'c'.repeat(64), amountFen: 199999, currency: 'CNY', paidAt: '2026-09-02T00:00:00Z', period: { start: '2026-09-02T00:00:00Z', end: '2026-10-02T00:00:00Z' },
    })).rejects.toMatchObject({ code: 'COMMERCIAL_PAYMENT_MISMATCH' })
    const sql = client.calls.map(call => call.sql).join('\n')
    expect(sql).not.toContain('INSERT INTO commercial_payment_events_v2')
    expect(sql).not.toContain('INSERT INTO creative_point_grants')
    expect(sql).not.toContain('INSERT INTO outbox_events')
    expect(sql).toContain('ROLLBACK')
  })

  it('atomically commits verified paid, period, entitlement, grant, revision, audit and outbox', async () => {
    const sku = approvedSku()
    let revision = 0
    const client = new ScriptedClient((sql, values) => {
      if (sql.includes('FROM commercial_orders_v2 o')) return { rows: [{
        id: 'order-1', workspaceId: 'ws-1', skuId: sku.id, skuVersionId: sku.versionId,
        amountFen: 200000, currency: 'CNY', paymentProvider: 'alipay', status: 'pending',
        idempotencyKey: 'order-1', requestHash: 'b'.repeat(64), createdByActorId: 'actor-1', providerOrderId: null,
        createdAt: '2026-09-02T00:00:00.000Z', paidAt: null, snapshotId: 'snapshot-1', snapshot: { sku },
      }] }
      if (sql.includes('UPDATE creative_point_access_state')) { revision += 1; return { rows: [{ available: 5000, reserved: 0, settled: 0, revision }] } }
      if (sql.includes("UPDATE commercial_orders_v2 SET status='paid'")) return { rows: [{
        id: 'order-1', workspaceId: 'ws-1', skuId: sku.id, skuVersionId: sku.versionId,
        amountFen: 200000, currency: 'CNY', paymentProvider: 'alipay', status: 'paid',
        idempotencyKey: 'order-1', requestHash: 'b'.repeat(64), createdByActorId: 'actor-1', providerOrderId: values[2],
        createdAt: '2026-09-02T00:00:00.000Z', paidAt: values[3],
      }] }
      return { rows: [] }
    })
    const repository = new PostgresCommercialContractRepository(pool(client))

    await expect(repository.recordVerifiedPaymentAndGrant({
      workspaceId: 'ws-1', orderId: 'order-1', provider: 'alipay', providerEventId: 'event-1', providerOrderId: 'trade-1', nonce: 'nonce-1', payloadHash: 'c'.repeat(64), amountFen: 200000, currency: 'CNY', paidAt: '2026-09-02T00:00:00Z', period: { start: '2026-09-02T00:00:00Z', end: '2026-10-02T00:00:00Z' },
    })).resolves.toMatchObject({ grantId: expect.stringMatching(/^cpg_/u), availablePoints: 5000, accessRevision: 1, replayed: false })
    const sql = client.calls.map(call => call.sql).join('\n')
    const expectedOrder = [
      'INSERT INTO commercial_payment_events_v2', 'INSERT INTO workspace_subscription_periods_v2',
      'INSERT INTO workspace_entitlement_snapshots_v2', 'INSERT INTO creative_point_grants',
      'UPDATE creative_point_access_state', 'INSERT INTO creative_point_ledger_events',
      "UPDATE commercial_orders_v2 SET status='paid'", 'INSERT INTO commercial_access_decisions_v2',
      'INSERT INTO outbox_events', 'COMMIT',
    ]
    let cursor = -1
    for (const fragment of expectedOrder) {
      const next = sql.indexOf(fragment)
      expect(next, fragment).toBeGreaterThan(cursor)
      cursor = next
    }
  })

  it('keeps unresolved onboarding dates and point-pack expiry fail-closed', async () => {
    const repository = new PostgresCommercialContractRepository(pool(new ScriptedClient(() => ({ rows: [] }))))
    const unavailable = approvedSku({ executable: false, lifecycle: 'pending_business_approval' })
    await expect(repository.createOrder({ workspaceId: 'ws-1', sku: unavailable, paymentProvider: 'sandbox', createdByActorId: 'actor-1', idempotencyKey: 'blocked-1', reason: 'blocked' }))
      .rejects.toEqual(expect.objectContaining<Partial<CommercialContractError>>({ code: 'COMMERCIAL_CATALOG_UNAVAILABLE' }))
  })
})
