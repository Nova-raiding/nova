import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { describe, expect, it } from 'vitest'
import { PostgresBillingRepository } from './billing-repository.js'
import { loadMigrations, MigrationRunner } from './migration.js'
import type { SqlClient, SqlPool } from './repository.js'

const databaseUrlValue = process.env.PERSISTENCE_RELEASE_DATABASE_URL
const postgresIt = databaseUrlValue ? it : it.skip

function connection(base: URL, database: string, user?: string, password?: string): string {
  const url = new URL(base)
  url.pathname = `/${database}`
  if (user) url.username = user
  if (password) url.password = password
  return url.toString()
}

/** The evidence for `billing-effective-amount` in `tests/invariants`.
 *
 * Two properties of one wallet action, both of which the fast suite can only
 * approximate because they are properties of the ledger's *history* rather than
 * of any single statement:
 *
 *   1. A debit key's effective amount is read the same way by every consumer,
 *      so a reversal that is already on the ledger is not invisible to the
 *      settlement that reconciles the same action later.
 *   2. Concurrent replays of one idempotency key replay each other's row
 *      instead of racing into `UNIQUE (workspace_id, order_id, type)`, which
 *      the endpoint reads as a 500 rather than as `created:false`.
 *
 * Both are asserted against real PostgreSQL as the app role, because both
 * failures live in transaction interleaving and constraint behaviour that a
 * mocked client cannot exhibit.
 */
describe('billing effective debit amount PostgreSQL acceptance', () => {
  postgresIt('keeps one definition of the effective amount and serializes concurrent debits on one key', async () => {
    const base = new URL(databaseUrlValue!)
    const databaseName = `release_billing_effective_${randomUUID().replaceAll('-', '')}`
    const admin = new Pool({ connectionString: base.toString() })
    let database: Pool | undefined
    let app: Pool | undefined
    let createdDatabase = false

    try {
      await admin.query(`CREATE DATABASE "${databaseName}"`)
      createdDatabase = true
      database = new Pool({ connectionString: connection(base, databaseName) })
      const migrations = await loadMigrations()
      expect(await new MigrationRunner(database, migrations).run()).toEqual(migrations.map(item => item.version))

      // CI provisions merchant_app before migration acceptance. The grants
      // apply only to this UUID database; the ledger stays append-only.
      await database.query('GRANT USAGE ON SCHEMA public TO merchant_app')
      await database.query('GRANT SELECT, INSERT, UPDATE ON workspaces, billing_orders TO merchant_app')
      await database.query('GRANT SELECT, INSERT ON billing_transactions TO merchant_app')

      const appUrl = connection(base, databaseName, 'merchant_app', 'merchant_app_local_only')
      app = new Pool({ connectionString: appUrl, max: 1 })
      const repository = new PostgresBillingRepository(app)
      const ledger = async (workspaceId: string) => (await database!.query<{ type: string; amount_fen: string; order_id: string }>(
        'SELECT type, amount_fen, order_id FROM billing_transactions WHERE workspace_id=$1 ORDER BY created_at, id', [workspaceId])).rows

      // ---------------------------------------------------------------------
      // 1. Reversal before settlement. The reversal is already on the ledger
      //    when the usage receipt for the same action is reconciled, so the
      //    settlement's delta has to be measured against the post-reversal
      //    effective amount. Read only the settlement rows and the reservation
      //    looks untouched, the delta comes out negative, and the workspace is
      //    handed the whole pre-authorization on top of the reversal.
      // ---------------------------------------------------------------------
      const reversalWorkspace = 'ws_billing_effective_reversal'
      const reversalKey = 'model_effective_reversal'
      await database.query("INSERT INTO workspaces (id,status) VALUES ($1,'active')", [reversalWorkspace])
      await database.query("INSERT INTO billing_transactions (id,workspace_id,type,amount_fen,order_id,description) VALUES ('tx_effective_topup',$1,'recharge',1000,'recharge_effective','充值')", [reversalWorkspace])

      expect(await repository.debit({ workspaceId: reversalWorkspace, amountFen: 100, idempotencyKey: reversalKey, actorId: 'merchant_effective', description: '模型生成预授权' })).toMatchObject({ amountFen: 100, created: true })
      expect(await repository.refundDebit({ workspaceId: reversalWorkspace, debitIdempotencyKey: reversalKey, actorId: 'merchant_effective', reason: 'provider 调用后落库失败' })).toMatchObject({ type: 'refund', amountFen: 100, orderId: `refund:${reversalKey}` })
      expect(await repository.balanceFen(reversalWorkspace)).toBe(1000)

      const settled = await repository.settleDebit({ workspaceId: reversalWorkspace, debitIdempotencyKey: reversalKey, finalAmountFen: 40, actorId: 'merchant_effective', description: '模型真实用量结算' })
      // The provider charged 40 for the action, so the workspace is charged the
      // whole 40 — a negative delta here credits the reservation twice.
      expect(settled.delta, 'the settlement delta the ledger records for a reversal-first debit key').toMatchObject({ type: 'debit', amountFen: 40, orderId: `settlement:${reversalKey}` })
      expect(await repository.balanceFen(reversalWorkspace)).toBe(960)
      expect((await ledger(reversalWorkspace)).map(row => `${row.type}:${row.amount_fen}:${row.order_id}`))
        .toEqual(['recharge:1000:recharge_effective', `debit:100:${reversalKey}`, `refund:100:refund:${reversalKey}`, `debit:40:settlement:${reversalKey}`])
      // A replayed settlement reads the same effective amount and appends
      // nothing, which is only true while both consumers share one definition.
      expect(await repository.settleDebit({ workspaceId: reversalWorkspace, debitIdempotencyKey: reversalKey, finalAmountFen: 40, actorId: 'merchant_effective', description: '模型真实用量结算' })).toMatchObject({ delta: { amountFen: 40 } })
      expect(await repository.balanceFen(reversalWorkspace)).toBe(960)

      // The other order stays where it was: settle first, reverse the settled
      // amount afterwards, and the failed action nets to zero.
      const settledFirstWorkspace = 'ws_billing_effective_settle_first'
      const settledFirstKey = 'model_effective_settle_first'
      await database.query("INSERT INTO workspaces (id,status) VALUES ($1,'active')", [settledFirstWorkspace])
      await database.query("INSERT INTO billing_transactions (id,workspace_id,type,amount_fen,order_id,description) VALUES ('tx_effective_topup_b',$1,'recharge',1000,'recharge_effective_b','充值')", [settledFirstWorkspace])
      await repository.debit({ workspaceId: settledFirstWorkspace, amountFen: 100, idempotencyKey: settledFirstKey, actorId: 'merchant_effective', description: '模型生成预授权' })
      await repository.settleDebit({ workspaceId: settledFirstWorkspace, debitIdempotencyKey: settledFirstKey, finalAmountFen: 40, actorId: 'merchant_effective', description: '模型真实用量结算' })
      expect(await repository.refundDebit({ workspaceId: settledFirstWorkspace, debitIdempotencyKey: settledFirstKey, actorId: 'merchant_effective', reason: 'provider 调用后落库失败' }), 'the reversal hands back what the key cost, not the original reservation').toMatchObject({ amountFen: 40 })
      expect(await repository.balanceFen(settledFirstWorkspace)).toBe(1000)

      // ---------------------------------------------------------------------
      // 2. Two concurrent debits on one idempotency key. The gate suspends the
      //    first the instant it holds the workspace row lock, and the replay is
      //    started into exactly that window. Read the key before taking the
      //    lock and the second transaction sees an empty ledger — the winner's
      //    row is still uncommitted — so it reaches the INSERT and PostgreSQL
      //    rejects it with a duplicate key instead of returning the replayed
      //    transaction the caller compensates on.
      // ---------------------------------------------------------------------
      const replayWorkspace = 'ws_billing_effective_replay'
      const replayKey = 'model_effective_replay'
      await database.query("INSERT INTO workspaces (id,status) VALUES ($1,'active')", [replayWorkspace])
      await database.query("INSERT INTO billing_transactions (id,workspace_id,type,amount_fen,order_id,description) VALUES ('tx_effective_topup_c',$1,'recharge',1000,'recharge_effective_c','充值')", [replayWorkspace])

      const firstPool = new Pool({ connectionString: appUrl, max: 1 })
      const secondPool = new Pool({ connectionString: appUrl, max: 1 })
      let releaseFirst: (() => void) | undefined
      try {
        let firstLocked!: () => void
        const lockObserved = new Promise<void>(resolve => { firstLocked = resolve })
        const held = new Promise<void>(resolve => { releaseFirst = resolve })
        const firstStatements: string[] = []
        const gatedPool: SqlPool = {
          async connect(): Promise<SqlClient> {
            const client = await firstPool.connect()
            return {
              async query<R = Record<string, unknown>>(text: string, values?: readonly unknown[]) {
                firstStatements.push(text)
                const result = await client.query(text, values as unknown[])
                if (text.includes('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE')) { firstLocked(); await held }
                return result as { rows: R[] }
              },
              release: (error?: Error) => client.release(error),
            }
          },
        }
        const secondStatements: string[] = []
        const recordingPool: SqlPool = {
          async connect(): Promise<SqlClient> {
            const client = await secondPool.connect()
            return {
              async query<R = Record<string, unknown>>(text: string, values?: readonly unknown[]) {
                secondStatements.push(text)
                return await client.query(text, values as unknown[]) as unknown as { rows: R[] }
              },
              release: (error?: Error) => client.release(error),
            }
          },
        }

        const input = { workspaceId: replayWorkspace, amountFen: 100, idempotencyKey: replayKey, actorId: 'merchant_effective', description: '模型生成预授权' }
        const first = new PostgresBillingRepository(gatedPool).debit(input)
        await lockObserved
        // The replay's outcome is captured rather than awaited directly: a
        // replay that is *refused by the lock* (`FOR UPDATE NOWAIT`) instead of
        // being answered from the ledger has to fail the named assertion below
        // rather than the whole test with an unhandled rejection.
        const second = new PostgresBillingRepository(recordingPool).debit(input).then(
          value => ({ value, error: undefined as unknown }),
          error => ({ value: undefined as never, error }),
        )
        // Give the replay the whole window to reach its write before the holder
        // is allowed to commit.
        await new Promise(resolve => setTimeout(resolve, 250))
        releaseFirst!()
        const winner = await first
        const secondResult = await second
        expect(
          secondResult.error,
          'the replay of one idempotency key is serialized by the workspace row lock and answered from the ledger',
        ).toBeUndefined()
        const replay = secondResult.value

        expect(winner).toMatchObject({ amountFen: 100, created: true })
        expect(replay).toMatchObject({ amountFen: 100, created: false })
        expect(replay.id).toBe(winner.id)
        // The lock is the first statement of the replay too, and precedes the
        // idempotency lookup that has to see the winner's committed row.
        const lockIndex = secondStatements.findIndex(statement => statement.includes('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE'))
        const lookupIndex = secondStatements.findIndex(statement => statement.includes("order_id=$2 AND type='debit'"))
        expect(lockIndex, 'the replay of one idempotency key is serialized by the workspace row lock and answered from the ledger').toBeGreaterThan(0)
        expect(lookupIndex, 'the replay of one idempotency key is serialized by the workspace row lock and answered from the ledger').toBeGreaterThan(lockIndex)
        expect(firstStatements.some(statement => statement.includes("order_id=$2 AND type='debit'"))).toBe(true)
        expect(await repository.balanceFen(replayWorkspace)).toBe(900)
        expect((await ledger(replayWorkspace)).map(row => `${row.type}:${row.amount_fen}:${row.order_id}`))
          .toEqual(['recharge:1000:recharge_effective_c', `debit:100:${replayKey}`])
      } finally {
        releaseFirst?.()
        await firstPool.end()
        await secondPool.end()
      }
    } finally {
      try {
        await app?.end()
        await database?.end()
        if (createdDatabase) await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`)
      } finally {
        await admin.end()
      }
    }
  }, 240_000)
})
