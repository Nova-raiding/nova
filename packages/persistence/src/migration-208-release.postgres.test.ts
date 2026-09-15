import { createHash, randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { describe, expect, it } from 'vitest'
import { loadMigrations, MigrationRunner } from './migration.js'

const databaseUrlValue = process.env.PERSISTENCE_RELEASE_DATABASE_URL
const postgresIt = databaseUrlValue ? it : it.skip

const databaseConnection = (base: URL, database: string, user?: string, password?: string) => {
  const url = new URL(base)
  url.pathname = `/${database}`
  if (user) url.username = user
  if (password) url.password = password
  return url.toString()
}

const payload = (requestId: string, alertId: string) => ({
  type: 'merchant.operation_alert',
  version: 1,
  request_id: requestId,
  sent_at: '2026-09-14T12:00:00.000Z',
  alert: { id: alertId, severity: 'critical' },
})

describe('migration 208 alert webhook receipt release acceptance', () => {
  postgresIt('preserves the historical ops grant while the owner ledger rejects mutation, replay, and identity drift', async () => {
    const base = new URL(databaseUrlValue!)
    const databaseName = `release_208_${randomUUID().replaceAll('-', '')}`
    const admin = new Pool({ connectionString: base.toString() })
    let database: Pool | undefined
    let app: Pool | undefined
    let ops: Pool | undefined

    try {
      await admin.query(`CREATE DATABASE "${databaseName}"`)
      database = new Pool({ connectionString: databaseConnection(base, databaseName) })
      const migrations = (await loadMigrations()).filter(migration => migration.version <= 208)
      expect(await new MigrationRunner(database, migrations).run()).toEqual(migrations.map(migration => migration.version))
      expect(await new MigrationRunner(database, migrations).run()).toEqual([])

      ops = new Pool({
        connectionString: databaseConnection(base, databaseName, 'merchant_ops', 'merchant_ops_local_only'),
      })
      app = new Pool({
        connectionString: databaseConnection(base, databaseName, 'merchant_app', 'merchant_app_local_only'),
      })
      await expect(app.query('SELECT * FROM public.alert_webhook_receipts')).rejects.toMatchObject({ code: '42501' })
      await expect(app.query(
          `INSERT INTO public.alert_webhook_receipts (
             request_id,alert_id,received_at,sent_at,body_sha256,payload
           ) VALUES ('request-denied','alert-denied',now(),now(),repeat('a',64),'{}'::jsonb)`,
        )).rejects.toMatchObject({ code: '42501' })
      expect((await database.query(
        `SELECT r.rolname,
                has_table_privilege(r.rolname,'public.alert_webhook_receipts','SELECT') AS can_select,
                has_table_privilege(r.rolname,'public.alert_webhook_receipts','INSERT') AS can_insert
           FROM pg_catalog.pg_roles r
          WHERE r.rolname IN ('merchant_app','merchant_ops')
          ORDER BY r.rolname`,
      )).rows).toEqual([
        { rolname: 'merchant_app', can_select: false, can_insert: false },
        { rolname: 'merchant_ops', can_select: true, can_insert: true },
      ])
      const requestId = `request-${randomUUID()}`
      const alertId = `alert-${randomUUID()}`
      const envelope = payload(requestId, alertId)
      const insert = async (candidateRequestId: string, candidateAlertId: string, candidatePayload: unknown) => database!.query(
        `INSERT INTO alert_webhook_receipts (
           request_id,alert_id,received_at,sent_at,body_sha256,payload
         ) VALUES ($1,$2,now(),$3,$4,$5::jsonb)`,
        [candidateRequestId, candidateAlertId, envelope.sent_at,
          createHash('sha256').update(JSON.stringify(candidatePayload)).digest('hex'),
          JSON.stringify(candidatePayload)],
      )

      await expect(insert(requestId, alertId, envelope)).resolves.toMatchObject({ rowCount: 1 })
      expect((await database.query(
        'SELECT request_id,alert_id FROM alert_webhook_receipts WHERE request_id=$1', [requestId],
      )).rows).toEqual([{ request_id: requestId, alert_id: alertId }])

      await expect(database.query(
        'UPDATE alert_webhook_receipts SET received_at=now() WHERE request_id=$1', [requestId],
      )).rejects.toMatchObject({ code: '42501' })
      await expect(database.query(
        'DELETE FROM alert_webhook_receipts WHERE request_id=$1', [requestId],
      )).rejects.toMatchObject({ code: '42501' })
      await expect(database.query('TRUNCATE alert_webhook_receipts')).rejects.toMatchObject({ code: '42501' })

      const replayAlertId = `alert-${randomUUID()}`
      await expect(insert(requestId, replayAlertId, payload(requestId, replayAlertId)))
        .rejects.toMatchObject({ code: '23505' })
      const replayRequestId = `request-${randomUUID()}`
      await expect(insert(replayRequestId, alertId, payload(replayRequestId, alertId)))
        .rejects.toMatchObject({ code: '23505' })

      const mismatchedRequestId = `request-${randomUUID()}`
      const matchingAlertId = `alert-${randomUUID()}`
      await expect(insert(mismatchedRequestId, matchingAlertId, payload(`request-${randomUUID()}`, matchingAlertId)))
        .rejects.toMatchObject({ code: '23514' })
      const mismatchedAlertId = `alert-${randomUUID()}`
      const matchingRequestId = `request-${randomUUID()}`
      await expect(insert(matchingRequestId, mismatchedAlertId, payload(matchingRequestId, `alert-${randomUUID()}`)))
        .rejects.toMatchObject({ code: '23514' })

      await expect(database.query('TRUNCATE alert_webhook_receipts')).rejects.toMatchObject({ code: '42501' })
      expect((await database.query('SELECT count(*)::int AS count FROM alert_webhook_receipts')).rows)
        .toEqual([{ count: 1 }])
    } finally {
      await app?.end()
      await ops?.end()
      await database?.end()
      await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1', [databaseName])
      await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`)
      await admin.end()
    }
  }, 300_000)
})
