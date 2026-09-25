import { describe, expect, it } from 'vitest'
import { PostgresEntitlementRepository } from './entitlement-repository.js'
import type { SqlClient, SqlPool } from './repository.js'

type FixtureOptions = {
  action?: 'settled' | 'refunded' | 'missing' | 'ineligible'
  consumption?: 'active' | 'refunded' | 'missing'
  failEntitlementUpdate?: boolean
}

function fixture(options: FixtureOptions = {}) {
  let action = options.action ?? 'settled'
  let consumption = options.consumption ?? 'active'
  const statements: string[] = []
  const client: SqlClient = {
    async query<Row>(sql: string) {
      statements.push(sql)
      const normalized = sql.replace(/\s+/g, ' ').trim()
      if (normalized === 'BEGIN') return { rows: [] as Row[] }
      if (normalized === 'COMMIT') return { rows: [] as Row[] }
      if (normalized === 'ROLLBACK') return { rows: [] as Row[] }
      if (normalized.includes('SELECT set_config')) return { rows: [] as Row[] }
      if (normalized.includes('FROM action_ledger')) {
        if (action === 'missing') return { rows: [] as Row[] }
        return { rows: [{ state: action === 'refunded' ? 'refunded' : 'settled', action_kind: 'model_image', settlement_status: action === 'ineligible' ? 'settled' : 'authorized', provider_request_id: null }] as Row[] }
      }
      if (normalized.includes('FROM subscription_entitlement_consumptions')) {
        if (consumption === 'missing') return { rows: [] as Row[] }
        return { rows: [{ id: 'consumption-1', workspaceId: 'ws-test', entitlementId: 'entitlement-1', idempotencyKey: 'action-test', units: 1, createdAt: '2026-09-25T00:00:00.000Z', ...(consumption === 'refunded' ? { refundedAt: '2026-09-25T00:01:00.000Z' } : {}) }] as Row[] }
      }
      if (normalized.startsWith('UPDATE action_ledger')) {
        action = 'refunded'
        return { rows: [] as Row[], rowCount: 1 }
      }
      if (normalized.startsWith('UPDATE subscription_entitlement_consumptions')) {
        consumption = 'refunded'
        return { rows: [] as Row[], rowCount: 1 }
      }
      if (normalized.startsWith('UPDATE subscription_entitlements')) {
        return { rows: [] as Row[], rowCount: options.failEntitlementUpdate ? 0 : 1 }
      }
      throw new Error(`unexpected SQL: ${normalized}`)
    },
    release() {},
  }
  const pool: SqlPool = { async connect() { return client } }
  return { repository: new PostgresEntitlementRepository(pool), statements }
}

describe('PostgresEntitlementRepository atomic action refund', () => {
  const input = { workspaceId: 'ws-test', idempotencyKey: 'action-test', reason: 'provider failed' }

  it('refunds both records in one transaction and treats replay as an idempotent no-op', async () => {
    const f = fixture()
    await expect(f.repository.refundWithActionLedger(input)).resolves.toMatchObject({ refunded: true, consumption: { refundedAt: expect.any(String) } })
    const firstCommit = f.statements.indexOf('COMMIT')
    expect(firstCommit).toBeGreaterThan(f.statements.findIndex(sql => sql.includes('UPDATE action_ledger')))
    expect(firstCommit).toBeGreaterThan(f.statements.findIndex(sql => sql.includes('UPDATE subscription_entitlement_consumptions')))
    expect(firstCommit).toBeGreaterThan(f.statements.findIndex(sql => sql.includes('UPDATE subscription_entitlements')))

    await expect(f.repository.refundWithActionLedger(input)).resolves.toMatchObject({ refunded: false })
    expect(f.statements.filter(sql => sql.includes('UPDATE action_ledger'))).toHaveLength(1)
    expect(f.statements.filter(sql => sql.includes('UPDATE subscription_entitlement_consumptions'))).toHaveLength(1)
    expect(f.statements.filter(sql => sql.includes('UPDATE subscription_entitlements'))).toHaveLength(1)
  })

  it.each([
    ['missing ledger record', { action: 'missing' as const }],
    ['ineligible ledger record', { action: 'ineligible' as const }],
    ['missing consumption record', { consumption: 'missing' as const }],
    ['already refunded consumption', { action: 'refunded' as const, consumption: 'refunded' as const }],
  ])('does not refund either side for %s', async (_label, options) => {
    const f = fixture(options)
    await expect(f.repository.refundWithActionLedger(input)).resolves.toMatchObject({ refunded: false })
    expect(f.statements.some(sql => sql.startsWith('UPDATE action_ledger'))).toBe(false)
    expect(f.statements.some(sql => sql.startsWith('UPDATE subscription_entitlement_consumptions'))).toBe(false)
    expect(f.statements.some(sql => sql.startsWith('UPDATE subscription_entitlements'))).toBe(false)
  })

  it('rolls back the action and consumption updates if entitlement balance adjustment fails', async () => {
    const f = fixture({ failEntitlementUpdate: true })
    await expect(f.repository.refundWithActionLedger(input)).rejects.toThrow('ENTITLEMENT_ATOMIC_REFUND_BALANCE_CONFLICT')
    expect(f.statements).toContain('ROLLBACK')
    expect(f.statements).not.toContain('COMMIT')
  })
})
