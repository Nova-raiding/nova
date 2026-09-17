import { dropDrainedPostgresFixture, withPostgresFixtureCleanup } from './postgres-scope-fixture-cleanup.js'
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

const rejectedPrivilege = { code: '42501' }

describe('migration 209 dedicated alert receiver role release acceptance', () => {
  postgresIt('fails closed on unsafe role attributes and gives only guarded append/readiness functions to the receiver', async () => {
    const base = new URL(databaseUrlValue!)
    const databaseName = `release_209_${randomUUID().replaceAll('-', '')}`
    const receiverPassword = randomUUID()
    const admin = new Pool({ connectionString: base.toString() })
    let database: Pool | undefined
    let app: Pool | undefined
    let ops: Pool | undefined
    let receiver: Pool | undefined

    let primaryFailure: unknown
    try {
      await admin.query(`ALTER ROLE merchant_alert_receiver WITH LOGIN INHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD '${receiverPassword}'`)
      await admin.query(`CREATE DATABASE "${databaseName}"`)
      database = new Pool({ connectionString: databaseConnection(base, databaseName) })
      const migrations = await loadMigrations()
      const through208 = migrations.filter(migration => migration.version <= 208)
      const migration209 = migrations.filter(migration => migration.version === 209)
      expect(await new MigrationRunner(database, through208).run()).toEqual(through208.map(migration => migration.version))
      ops = new Pool({ connectionString: databaseConnection(base, databaseName, 'merchant_ops', 'merchant_ops_local_only') })

      const expectHistoricalOpsGrant = async () => {
        expect((await database!.query(
          `SELECT has_table_privilege('merchant_ops','public.alert_webhook_receipts','SELECT') AS can_select,
                  has_table_privilege('merchant_ops','public.alert_webhook_receipts','INSERT') AS can_insert`,
        )).rows).toEqual([{ can_select: true, can_insert: true }])
      }
      await expectHistoricalOpsGrant()

      const absentRoleMigration = [{
        ...migration209[0]!,
        sql: migration209[0]!.sql.replaceAll('merchant_alert_receiver', `merchant_missing_${randomUUID().replaceAll('-', '')}`),
      }]
      await expect(new MigrationRunner(database, absentRoleMigration).run()).rejects.toMatchObject(rejectedPrivilege)
      expect((await database.query('SELECT version FROM schema_migrations WHERE version=209')).rowCount).toBe(0)
      await expectHistoricalOpsGrant()

      await expect(new MigrationRunner(database, migration209).run()).rejects.toMatchObject(rejectedPrivilege)
      expect((await database.query('SELECT version FROM schema_migrations WHERE version=209')).rowCount).toBe(0)
      await expectHistoricalOpsGrant()

      await admin.query('ALTER ROLE merchant_alert_receiver NOINHERIT')
      expect(await new MigrationRunner(database, migration209).run()).toEqual([209])
      expect(await new MigrationRunner(database, migration209).run()).toEqual([])
      expect((await database.query(
        `SELECT has_table_privilege('merchant_ops','public.alert_webhook_receipts','SELECT') AS can_select,
                has_table_privilege('merchant_ops','public.alert_webhook_receipts','INSERT') AS can_insert`,
      )).rows).toEqual([{ can_select: false, can_insert: false }])

      app = new Pool({ connectionString: databaseConnection(base, databaseName, 'merchant_app', 'merchant_app_local_only') })
      receiver = new Pool({ connectionString: databaseConnection(base, databaseName, 'merchant_alert_receiver', receiverPassword) })

      for (const unauthorized of [app, ops]) {
        await expect(unauthorized.query(
          `INSERT INTO alert_webhook_receipts(alert_id,request_id,received_at,sent_at,body_sha256,payload)
           VALUES('alert-denied','request-denied',now(),now(),repeat('a',64),'{}'::jsonb)`,
        )).rejects.toMatchObject(rejectedPrivilege)
        await expect(unauthorized.query(
          `SELECT public.append_alert_webhook_receipt('alert-denied','request-denied',now(),now(),repeat('a',64),'{}'::jsonb)`,
        )).rejects.toMatchObject(rejectedPrivilege)
        await expect(unauthorized.query('SELECT public.alert_webhook_receipts_ready()')).rejects.toMatchObject(rejectedPrivilege)
      }

      expect((await receiver.query('SELECT public.alert_webhook_receipts_ready() AS ready')).rows).toEqual([{ ready: true }])
      const requestId = `request-${randomUUID()}`
      const alertId = `alert-${randomUUID()}`
      const payload = {
        type: 'merchant.operation_alert', version: 1, request_id: requestId,
        sent_at: '2026-09-14T12:00:00.000Z', alert: { id: alertId, severity: 'critical' },
      }
      const digest = createHash('sha256').update(JSON.stringify(payload)).digest('hex')
      const append = () => receiver!.query(
        'SELECT public.append_alert_webhook_receipt($1,$2,now(),$3,$4,$5::jsonb) AS accepted',
        [alertId, requestId, payload.sent_at, digest, JSON.stringify(payload)],
      )
      expect((await append()).rows).toEqual([{ accepted: true }])
      expect((await append()).rows).toEqual([{ accepted: false }])

      await expect(receiver.query('SELECT * FROM public.alert_webhook_receipts')).rejects.toMatchObject(rejectedPrivilege)
      await expect(receiver.query(
        `INSERT INTO public.alert_webhook_receipts(alert_id,request_id,received_at,sent_at,body_sha256,payload)
         VALUES('alert-direct','request-direct',now(),now(),repeat('b',64),'{}'::jsonb)`,
      )).rejects.toMatchObject(rejectedPrivilege)
      await expect(receiver.query("UPDATE public.alert_webhook_receipts SET received_at=now() WHERE request_id='request-direct'"))
        .rejects.toMatchObject(rejectedPrivilege)
      await expect(receiver.query("DELETE FROM public.alert_webhook_receipts WHERE request_id='request-direct'"))
        .rejects.toMatchObject(rejectedPrivilege)
      await expect(receiver.query('TRUNCATE public.alert_webhook_receipts')).rejects.toMatchObject(rejectedPrivilege)

      await expect(database.query(
        `SELECT public.append_alert_webhook_receipt('alert-owner','request-owner',now(),now(),repeat('c',64),'{}'::jsonb)`,
      )).rejects.toMatchObject(rejectedPrivilege)
      expect((await database.query('SELECT request_id,alert_id FROM public.alert_webhook_receipts')).rows)
        .toEqual([{ request_id: requestId, alert_id: alertId }])

      const acl = (await database.query(
        `SELECT r.rolname,
                has_table_privilege(r.rolname,'public.alert_webhook_receipts','SELECT') AS can_select,
                has_table_privilege(r.rolname,'public.alert_webhook_receipts','INSERT') AS can_insert,
                has_table_privilege(r.rolname,'public.alert_webhook_receipts','UPDATE') AS can_update,
                has_table_privilege(r.rolname,'public.alert_webhook_receipts','DELETE') AS can_delete,
                has_table_privilege(r.rolname,'public.alert_webhook_receipts','TRUNCATE') AS can_truncate,
                has_function_privilege(r.rolname,'public.append_alert_webhook_receipt(text,text,timestamptz,timestamptz,text,jsonb)','EXECUTE') AS can_append,
                has_function_privilege(r.rolname,'public.alert_webhook_receipts_ready()','EXECUTE') AS can_ready
           FROM pg_catalog.pg_roles r
          WHERE r.rolname IN ('merchant_app','merchant_ops','merchant_alert_receiver')
          ORDER BY r.rolname`,
      )).rows
      expect(acl).toEqual([
        { rolname: 'merchant_alert_receiver', can_select: false, can_insert: false, can_update: false, can_delete: false, can_truncate: false, can_append: true, can_ready: true },
        { rolname: 'merchant_app', can_select: false, can_insert: false, can_update: false, can_delete: false, can_truncate: false, can_append: false, can_ready: false },
        { rolname: 'merchant_ops', can_select: false, can_insert: false, can_update: false, can_delete: false, can_truncate: false, can_append: false, can_ready: false },
      ])
      expect((await database.query(
        `SELECT p.proname,p.prosecdef,p.proconfig
           FROM pg_catalog.pg_proc p
           JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
          WHERE n.nspname='public' AND p.proname IN ('append_alert_webhook_receipt','alert_webhook_receipts_ready')
          ORDER BY p.proname`,
      )).rows).toEqual([
        { proname: 'alert_webhook_receipts_ready', prosecdef: true, proconfig: ['search_path=pg_catalog'] },
        { proname: 'append_alert_webhook_receipt', prosecdef: true, proconfig: ['search_path=pg_catalog'] },
      ])
    } catch (error) {
      primaryFailure = error
      throw error
    } finally {
      await withPostgresFixtureCleanup(async () => {
        await receiver?.end()
        await ops?.end()
        await app?.end()
        await database?.end()
        await admin.query('ALTER ROLE merchant_alert_receiver NOINHERIT')
        await dropDrainedPostgresFixture(admin, databaseName)
      }, primaryFailure, [
        () => admin.end(),
      ])
    }
  }, 300_000)
})
