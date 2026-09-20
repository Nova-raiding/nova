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

describe('billing PostgreSQL bigint release acceptance', () => {
  postgresIt('preserves numeric amounts and idempotency through real app-role payment and settlement queries', async () => {
    const base = new URL(databaseUrlValue!)
    const databaseName = `release_billing_${randomUUID().replaceAll('-', '')}`
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

      // CI provisions merchant_app before migration acceptance. Grants below
      // apply only to this UUID database; ledger updates/deletes stay forbidden.
      await database.query('GRANT USAGE ON SCHEMA public TO merchant_app')
      await database.query('GRANT SELECT, INSERT, UPDATE ON workspaces, billing_orders TO merchant_app')
      await database.query('GRANT SELECT, INSERT ON billing_transactions TO merchant_app')
      await database.query("INSERT INTO workspaces (id,status) VALUES ('ws_billing_roundtrip','active')")

      app = new Pool({
        connectionString: connection(base, databaseName, 'merchant_app', 'merchant_app_local_only'),
        max: 1,
      })
      expect((await app.query('SELECT current_user AS role, rolsuper, rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows)
        .toEqual([{ role: 'merchant_app', rolsuper: false, rolbypassrls: false }])
      expect((await app.query('SELECT 1000::bigint AS amount')).rows).toEqual([{ amount: '1000' }])

      const repository = new PostgresBillingRepository(app)
      const workspaceId = 'ws_billing_roundtrip'
      const intent = { id: 'order_roundtrip', workspaceId, channel: 'alipay' as const, amountFen: 1000, state: 'pending' as const, paymentMode: 'provider' as const, createdByActorId: 'merchant_roundtrip', idempotencyKey: 'recharge_roundtrip' }
      const created = await repository.createOrder(intent)
      expect(created).toMatchObject({ id: intent.id, amountFen: 1000, state: 'pending' })
      expect(await repository.createOrder({ ...intent, id: 'order_retry' })).toEqual(created)
      expect(await repository.getOrderForActor(workspaceId, created.id, 'merchant_roundtrip')).toEqual(created)
      expect(await repository.getOrderForActor(workspaceId, created.id, 'merchant_other')).toBeUndefined()
      expect(await repository.getOrderForActor('ws_other_billing', created.id, 'merchant_roundtrip')).toBeUndefined()

      const payment = { workspaceId, orderId: created.id, providerTradeId: 'trade_roundtrip', amountFen: 1000, eventSource: 'release_test' }
      const paid = await repository.markPaid(payment)
      expect(paid).toMatchObject({ amountFen: 1000, state: 'paid' })
      expect(await repository.markPaid(payment)).toEqual(paid)
      expect(await repository.balanceFen(workspaceId)).toBe(1000)

      const debitInput = { workspaceId, amountFen: 100, idempotencyKey: 'model_roundtrip', actorId: 'merchant_roundtrip', description: 'release model reservation' }
      const debit = await repository.debit(debitInput)
      expect(debit).toMatchObject({ amountFen: 100, created: true })
      expect(await repository.debit(debitInput)).toEqual({ ...debit, created: false })

      const settlementInput = { workspaceId, debitIdempotencyKey: debitInput.idempotencyKey, finalAmountFen: 150, actorId: debitInput.actorId, description: 'release model usage settlement' }
      const settled = await repository.settleDebit(settlementInput)
      expect(settled).toMatchObject({ original: { amountFen: 100 }, delta: { amountFen: 50 } })
      expect(await repository.settleDebit(settlementInput)).toEqual(settled)
      expect(await repository.balanceFen(workspaceId)).toBe(850)

      const transactions = await repository.listTransactions(workspaceId)
      expect(transactions).toHaveLength(3)
      expect(transactions.map(item => item.amountFen).sort((left, right) => left - right)).toEqual([50, 100, 1000])
      expect(transactions.every(item => typeof item.amountFen === 'number' && Number.isSafeInteger(item.amountFen))).toBe(true)
      expect(await repository.getOrder('ws_other_billing', created.id)).toBeUndefined()
      // The same pooled app connection has no tenant visibility after COMMIT.
      expect((await app.query('SELECT id FROM billing_transactions')).rows).toEqual([])
      expect((await database.query('SELECT count(*)::int AS orders FROM billing_orders')).rows).toEqual([{ orders: 1 }])
      expect((await database.query('SELECT count(*)::int AS transactions FROM billing_transactions')).rows).toEqual([{ transactions: 3 }])

      // A failed action must net to zero: the reversal has to cover the
      // settlement delta settleDebit appended, not just the reservation.
      const refund = await repository.refundDebit({ workspaceId, debitIdempotencyKey: debitInput.idempotencyKey, actorId: debitInput.actorId, reason: 'provider 调用后落库失败' })
      expect(refund).toMatchObject({ type: 'refund', amountFen: 150, orderId: `refund:${debitInput.idempotencyKey}` })
      expect(await repository.balanceFen(workspaceId)).toBe(1000)
      expect(await repository.refundDebit({ workspaceId, debitIdempotencyKey: debitInput.idempotencyKey, actorId: debitInput.actorId, reason: 'provider 调用后落库失败' })).toEqual(refund)
      expect((await database.query('SELECT count(*)::int AS transactions FROM billing_transactions')).rows).toEqual([{ transactions: 4 }])

      // ---------------------------------------------------------------------
      // Interleaved settlement and model-failure reversal on one debit key.
      //
      // Both derive their amount from the same settlement aggregate, so they
      // must take the same workspace row lock. The gate suspends `settleDebit`
      // the instant it holds that lock — after it has read the aggregate but
      // before it appends its delta — and the reversal is then started into
      // exactly that window. Unserialized, the reversal fixes its amount
      // against the pre-settlement aggregate while the settlement fixes its
      // delta against the pre-reversal one: the wallet gets the reservation
      // back and is charged only the delta, so a failed action stops netting to
      // zero against what the provider actually charged. Migration 013's
      // `UNIQUE (workspace_id, order_id, type)` does not help — the two rows
      // have different keys.
      // ---------------------------------------------------------------------
      const raceWorkspace = 'ws_billing_settle_race'
      const raceDebitKey = 'model_settle_race'
      await database.query("INSERT INTO workspaces (id,status) VALUES ($1,'active')", [raceWorkspace])
      await database.query("INSERT INTO billing_transactions (id,workspace_id,type,amount_fen,order_id,description) VALUES ('tx_settle_race_topup',$1,'recharge',1000,'recharge_settle_race','充值')", [raceWorkspace])

      const settlePool = new Pool({ connectionString: connection(base, databaseName, 'merchant_app', 'merchant_app_local_only'), max: 1 })
      const refundPool = new Pool({ connectionString: connection(base, databaseName, 'merchant_app', 'merchant_app_local_only'), max: 1 })
      let releaseSettle: (() => void) | undefined
      try {
        const plain = new PostgresBillingRepository(settlePool)
        expect(await plain.debit({ workspaceId: raceWorkspace, amountFen: 100, idempotencyKey: raceDebitKey, actorId: 'merchant_race', description: '模型生成预授权' })).toMatchObject({ amountFen: 100, created: true })

        let settleLocked!: () => void
        const lockObserved = new Promise<void>(resolve => { settleLocked = resolve })
        const settleHeld = new Promise<void>(resolve => { releaseSettle = resolve })

        const gatedPool: SqlPool = {
          async connect(): Promise<SqlClient> {
            const client = await settlePool.connect()
            return {
              async query<R = Record<string, unknown>>(text: string, values?: readonly unknown[]) {
                const result = await client.query(text, values as unknown[])
                if (text.includes('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE')) { settleLocked(); await settleHeld }
                return result as { rows: R[] }
              },
              release: (error?: Error) => client.release(error),
            }
          },
        }
        const refundStatements: string[] = []
        const recordingPool: SqlPool = {
          async connect(): Promise<SqlClient> {
            const client = await refundPool.connect()
            return {
              async query<R = Record<string, unknown>>(text: string, values?: readonly unknown[]) {
                refundStatements.push(text)
                return await client.query(text, values as unknown[]) as unknown as { rows: R[] }
              },
              release: (error?: Error) => client.release(error),
            }
          },
        }

        const settling = new PostgresBillingRepository(gatedPool).settleDebit({ workspaceId: raceWorkspace, debitIdempotencyKey: raceDebitKey, finalAmountFen: 150, actorId: 'merchant_race', description: '模型真实用量结算' })
        await lockObserved
        const refunding = new PostgresBillingRepository(recordingPool).refundDebit({ workspaceId: raceWorkspace, debitIdempotencyKey: raceDebitKey, actorId: 'merchant_race', reason: 'provider 调用后落库失败' })
        // Give the reversal the whole window to read the aggregate and append a
        // stale refund before the settlement is allowed to commit.
        await new Promise(resolve => setTimeout(resolve, 250))
        releaseSettle!()
        const [settlement, reversal] = await Promise.all([settling, refunding])

        expect(settlement.delta).toMatchObject({ amountFen: 50 })
        expect(reversal.amountFen).toBe(150)
        // The reversal serialized on the same workspace row, and took the lock
        // before it read the aggregate its amount is derived from.
        const lockIndex = refundStatements.findIndex(statement => statement.includes('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE'))
        const aggregateIndex = refundStatements.findIndex(statement => statement.includes('AS effective_fen'))
        expect(lockIndex).toBeGreaterThan(0)
        expect(aggregateIndex).toBeGreaterThan(lockIndex)
        // The failed action nets to zero against the provider charge.
        expect(await plain.balanceFen(raceWorkspace)).toBe(1000)
      } finally {
        releaseSettle?.()
        await settlePool.end()
        await refundPool.end()
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
