import { describe, expect, it } from 'vitest'
import { PostgresCreativePointRepository } from './creative-point-repository.js'
import type { SqlClient, SqlPool } from './repository.js'

const recordedAt = '2026-09-01T00:00:00.000Z'
const readAt = '2026-09-29T00:00:00.000Z'

function balancePool(queries: string[]): SqlPool {
  const client: SqlClient = {
    async query<Row>(sql: string, values?: readonly unknown[]) {
      queries.push(sql)
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK' || sql.includes("set_config('app.workspace_id'")) {
        return { rows: [] as Row[] }
      }
      if (sql.includes('FROM creative_point_access_state WHERE workspace_id=$1')) {
        expect(values?.[0]).toBe('ws_read_purity')
        return { rows: [{
          workspaceId: 'ws_read_purity', availablePoints: '50', reservedPoints: '1',
          settledPoints: '2', revision: '7', updatedAt: recordedAt,
        }] as Row[] }
      }
      if (sql.includes('SELECT EXISTS(SELECT 1 FROM creative_point_grants')) {
        expect(values).toEqual(['ws_read_purity', readAt])
        // One grant expired since the last mutation. A read should show the
        // current balance without rewriting the last real mutation timestamp.
        return { rows: [{ known: true, available: '40', reserved: '1', settled: '2' }] as Row[] }
      }
      if (sql.includes('WITH remaining AS (')) {
        return { rows: [{ nextExpiry: '2026-10-01T00:00:00.000Z', expiringPoints: '40' }] as Row[] }
      }
      if (sql.startsWith('UPDATE creative_point_access_state')) {
        return { rows: [{
          workspaceId: 'ws_read_purity', availablePoints: '40', reservedPoints: '1',
          settledPoints: '2', revision: '7', updatedAt: readAt,
        }] as Row[] }
      }
      throw new Error(`unexpected query: ${sql}`)
    },
    release() {},
  }
  return { async connect() { return client } }
}

describe('creative-point PostgreSQL balance read purity', () => {
  it('computes expiry at read time without mutating balance or its last mutation timestamp', async () => {
    const queries: string[] = []
    const repository = new PostgresCreativePointRepository(balancePool(queries))

    expect(await repository.getBalance('ws_read_purity', readAt)).toMatchObject({
      workspaceId: 'ws_read_purity', availablePoints: 40, reservedPoints: 1,
      settledPoints: 2, revision: 7, updatedAt: recordedAt,
    })
    expect(await repository.getBalanceDetails('ws_read_purity', readAt)).toMatchObject({
      availablePoints: 40, revision: 7, updatedAt: recordedAt,
      nextExpiry: '2026-10-01T00:00:00.000Z', expiringPoints: 40,
    })
    expect(queries.filter(sql => sql.startsWith('UPDATE creative_point_access_state'))).toEqual([])
    expect(queries.filter(sql => sql.startsWith('INSERT INTO creative_point_'))).toEqual([])
    expect(queries.filter(sql => sql.includes('FROM creative_point_access_state WHERE workspace_id=$1 FOR SHARE'))).toHaveLength(2)
  })
})
