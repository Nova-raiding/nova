import { describe, expect, it } from 'vitest'
import { PostgresEntitlementRepository } from './entitlement-repository.js'
import type { SqlClient, SqlPool } from './repository.js'

type State = 'settled' | 'cancelled' | 'refunded'

function fixture(options: { actionState?: State; failConsumptionUpdate?: boolean } = {}) {
  let actionState = options.actionState ?? 'settled'
  const statements: string[] = []
  const client: SqlClient = {
    async query<Row>(sql: string) {
      const normalized = sql.replace(/\s+/g, ' ').trim()
      statements.push(normalized)
      if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(normalized)) return { rows: [] as Row[] }
      if (normalized.includes('SELECT set_config')) return { rows: [] as Row[] }
      if (normalized.includes('FROM action_ledger')) {
        return { rows: [{ state: actionState, action_kind: 'model_image', settlement_status: 'authorized', provider_request_id: null }] as Row[] }
      }
      if (normalized.includes('FROM subscription_entitlement_consumptions')) {
        return { rows: [{ id: 'consume-1', workspaceId: 'ws_fixture', entitlementId: 'ent-1', idempotencyKey: 'action-1', units: 1, createdAt: '2026-10-08T00:00:00.000Z' }] as Row[] }
      }
      if (normalized.startsWith('UPDATE action_ledger')) {
        actionState = 'refunded'
        return { rows: [] as Row[], rowCount: 1 }
      }
      if (normalized.startsWith('UPDATE subscription_entitlement_consumptions')) {
        return { rows: [] as Row[], rowCount: options.failConsumptionUpdate ? 0 : 1 }
      }
      if (normalized.startsWith('UPDATE subscription_entitlements')) return { rows: [] as Row[], rowCount: 1 }
      throw new Error(`unexpected SQL: ${normalized}`)
    },
    release() {},
  }
  const pool: SqlPool = { async connect() { return client } }
  return { repository: new PostgresEntitlementRepository(pool), statements }
}

describe('entitlement refund cancellation and atomicity regression', () => {
  const input = { workspaceId: 'ws_fixture', idempotencyKey: 'action-1', reason: 'fixture cancellation' }

  it('does not mutate entitlement or action ledger for a cancelled action', async () => {
    const f = fixture({ actionState: 'cancelled' })

    await expect(f.repository.refundWithActionLedger(input)).resolves.toMatchObject({ refunded: false })
    expect(f.statements.some(sql => sql.startsWith('UPDATE '))).toBe(false)
    expect(f.statements).toContain('COMMIT')
    expect(f.statements).not.toContain('ROLLBACK')
  })

  it('rolls back the ledger state when the consumption refund loses its conditional update', async () => {
    const f = fixture({ failConsumptionUpdate: true })

    await expect(f.repository.refundWithActionLedger(input)).rejects.toThrow('ENTITLEMENT_ATOMIC_REFUND_CONFLICT')
    expect(f.statements.some(sql => sql.startsWith('UPDATE action_ledger'))).toBe(true)
    expect(f.statements.some(sql => sql.startsWith('UPDATE subscription_entitlements'))).toBe(false)
    expect(f.statements).toContain('ROLLBACK')
    expect(f.statements).not.toContain('COMMIT')
  })
})
