import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { describe, expect, it } from 'vitest'
import { PostgresBillingRepository } from './billing-repository.js'
import { loadMigrations, MigrationRunner } from './migration.js'

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
