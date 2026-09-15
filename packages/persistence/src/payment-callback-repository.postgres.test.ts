import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { describe, expect, it } from 'vitest'
import { PostgresBillingRepository } from './billing-repository.js'
import { loadMigrations, MigrationRunner } from './migration.js'
import { PostgresPaymentCallbackNonceRepository } from './payment-callback-repository.js'
import { dropDrainedPostgresFixture, withPostgresFixtureCleanup } from './postgres-scope-fixture-cleanup.js'

const databaseUrlValue = process.env.PERSISTENCE_RELEASE_DATABASE_URL
const postgresIt = databaseUrlValue ? it : it.skip

function connection(base: URL, database: string, user?: string, password?: string): string {
  const url = new URL(base)
  url.pathname = `/${database}`
  if (user) url.username = user
  if (password) url.password = password
  return url.toString()
}

describe('payment callback nonce PostgreSQL recovery', () => {
  postgresIt('allows the same signed payload to recover after a transient locked payment write and rejects a different payload on the nonce', async () => {
    const base = new URL(databaseUrlValue!)
    const databaseName = `release_payment_callback_${randomUUID().replaceAll('-', '')}`
    const admin = new Pool({ connectionString: base.toString() })
    let database: Pool | undefined
    let app: Pool | undefined
    let createdDatabase = false
    let primaryFailure: unknown

    try {
      await admin.query(`CREATE DATABASE "${databaseName}"`)
      createdDatabase = true
      database = new Pool({ connectionString: connection(base, databaseName) })
      const migrations = await loadMigrations()
      expect(await new MigrationRunner(database, migrations).run()).toEqual(migrations.map(item => item.version))
      await database.query("INSERT INTO workspaces (id,status) VALUES ('ws_callback_retry','active')")

      app = new Pool({ connectionString: connection(base, databaseName, 'merchant_app', 'merchant_app_local_only'), max: 3 })
      const billing = new PostgresBillingRepository(app)
      const nonces = new PostgresPaymentCallbackNonceRepository(app)
      const workspaceId = 'ws_callback_retry'
      const created = await billing.createOrder({ id: 'order_callback_retry', workspaceId, channel: 'alipay', amountFen: 1000, state: 'pending', paymentMode: 'provider', createdByActorId: 'merchant_callback', idempotencyKey: 'callback-retry' })
      const proof = { workspaceId, channel: 'alipay' as const, nonce: 'nonce_callback_retry_1234', signedAt: '2026-09-15T12:00:00.000Z', payloadHash: 'a'.repeat(64) }
      const payment = { workspaceId, orderId: created.id, providerTradeId: 'trade_callback_retry', amountFen: 1000, eventSource: 'provider_callback' }

      const locker = await app.connect()
      try {
        await locker.query('BEGIN')
        await locker.query(`SELECT set_config('app.workspace_id', $1, true)`, [workspaceId])
        await locker.query('SELECT id FROM billing_orders WHERE workspace_id=$1 AND id=$2 FOR UPDATE', [workspaceId, created.id])

        await expect(nonces.consume(proof)).resolves.toBe(true)
        await expect(billing.markPaid(payment)).rejects.toThrow(/lock timeout|canceling statement|timeout/u)
        await expect(billing.getOrder(workspaceId, created.id)).resolves.toMatchObject({ state: 'pending' })
        await expect(billing.balanceFen(workspaceId)).resolves.toBe(0)
      } finally {
        await locker.query('ROLLBACK').catch(() => undefined)
        locker.release()
      }

      await expect(nonces.consume(proof)).resolves.toBe(false)
      await expect(nonces.replayPayloadMatches(proof)).resolves.toBe(true)
      await expect(billing.markPaid(payment)).resolves.toMatchObject({ state: 'paid', providerTradeId: payment.providerTradeId })
      await expect(billing.markPaid(payment)).resolves.toMatchObject({ state: 'paid', providerTradeId: payment.providerTradeId })
      await expect(nonces.consume({ ...proof, payloadHash: 'b'.repeat(64) })).resolves.toBe(false)
      await expect(nonces.replayPayloadMatches({ ...proof, payloadHash: 'b'.repeat(64) })).resolves.toBe(false)
      await expect(billing.balanceFen(workspaceId)).resolves.toBe(1000)
      await expect(billing.listTransactions(workspaceId)).resolves.toEqual([expect.objectContaining({ type: 'recharge', amountFen: 1000, orderId: created.id })])
    } catch (error) {
      primaryFailure = error
      throw error
    } finally {
      await withPostgresFixtureCleanup(async () => {
        await app?.end()
        await database?.end()
        if (createdDatabase) await dropDrainedPostgresFixture(admin, databaseName)
      }, primaryFailure, [() => admin.end()])
    }
  }, 240_000)
})
