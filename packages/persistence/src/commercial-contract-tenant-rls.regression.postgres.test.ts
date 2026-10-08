import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadMigrations, MigrationRunner } from './migration.js'
import { dropDrainedPostgresFixture, withPostgresFixtureCleanup } from './postgres-scope-fixture-cleanup.js'

const source = process.env.PERSISTENCE_RELEASE_DATABASE_URL

describe.skipIf(!source)('commercial contract tenant RLS regression', () => {
  const databaseName = `commercial_tenancy_${randomUUID().replaceAll('-', '')}`
  const workspaceA = `tenant-a-${randomUUID()}`
  const workspaceB = `tenant-b-${randomUUID()}`
  let admin: Pool | undefined
  let db: Pool | undefined
  let app: Pool | undefined

  beforeAll(async () => {
    admin = new Pool({ connectionString: source!, connectionTimeoutMillis: 10_000 })
    await admin.query(`CREATE DATABASE "${databaseName}"`)
    const connection = new URL(source!)
    connection.pathname = `/${databaseName}`
    db = new Pool({ connectionString: connection.toString(), max: 4 })
    await new MigrationRunner(db, await loadMigrations()).run()
    await db.query(await readFile(new URL('../../../infra/local/ensure-app-role.sql', import.meta.url), 'utf8'))
    const appConnection = new URL(connection)
    appConnection.username = 'merchant_app'
    appConnection.password = 'merchant_app_local_only'
    app = new Pool({ connectionString: appConnection.toString(), max: 2 })

    await db.query("INSERT INTO workspaces(id,status) VALUES($1,'active'),($2,'active')", [workspaceA, workspaceB])
    const checksum = 'a'.repeat(64)
    await db.query("INSERT INTO commercial_catalog_skus(id,code,kind,visibility) VALUES ('tenant-rls-sku','tenant-rls','monthly','public')")
    await db.query(`
      INSERT INTO commercial_catalog_sku_versions(id,sku_id,version,lifecycle,executable,price_fen,currency,price_mode,payload,checksum,effective_at)
      VALUES ('tenant-rls-v1','tenant-rls-sku',1,'approved',true,1000,'CNY','fixed','{}',$1,'2026-10-01T00:00:00Z')
    `, [checksum])
    for (const [workspaceId, orderId] of [[workspaceA, 'tenant-order-a'], [workspaceB, 'tenant-order-b']]) {
      await db.query(`
        INSERT INTO commercial_orders_v2(id,workspace_id,sku_id,sku_version_id,amount_fen,currency,payment_provider,status,idempotency_key,request_hash,created_by_actor_id,created_at)
        VALUES($1,$2,'tenant-rls-sku','tenant-rls-v1',1000,'CNY','manual_transfer','pending',$1,$3,'fixture','2026-10-01T00:00:00Z')
      `, [orderId, workspaceId, checksum])
      await db.query(`
        INSERT INTO commercial_order_terms_v3(workspace_id,order_id,purchase_kind,expires_at,policy_version,created_at)
        VALUES($1,$2,'purchase','2026-11-01T00:00:00Z','tenant-rls-fixture','2026-10-01T00:00:00Z')
      `, [workspaceId, orderId])
      await db.query(`
        INSERT INTO commercial_upgrade_quotes_v3(workspace_id,id,idempotency_key,request_hash,quote,target_snapshot,created_at,expires_at)
        VALUES($1,$2,$2,$3,'{}','{}','2026-10-01T00:00:00Z','2026-10-02T00:00:00Z')
      `, [workspaceId, `tenant-quote-${workspaceId}`, checksum])
    }
  }, 120_000)

  afterAll(async () => {
    await withPostgresFixtureCleanup(async () => {
      await app?.end()
      await db?.end()
      if (admin) await dropDrainedPostgresFixture(admin, databaseName)
    }, undefined, [async () => { await admin?.end() }])
  }, 60_000)

  it('isolates quote and order-term reads and rejects cross-workspace inserts or tenant reassignment', async () => {
    const client = await app!.connect()
    try {
      await client.query('BEGIN')
      await client.query("SELECT set_config('app.workspace_id',$1,true)", [workspaceA])
      expect((await client.query('SELECT id FROM commercial_upgrade_quotes_v3 ORDER BY id')).rows)
        .toEqual([{ id: `tenant-quote-${workspaceA}` }])
      expect((await client.query('SELECT order_id FROM commercial_order_terms_v3 ORDER BY order_id')).rows)
        .toEqual([{ order_id: 'tenant-order-a' }])

      await client.query('SAVEPOINT reject_foreign_quote_insert')
      await expect(client.query(`
        INSERT INTO commercial_upgrade_quotes_v3(workspace_id,id,idempotency_key,request_hash,quote,target_snapshot,created_at,expires_at)
        VALUES($1,'forged-quote','forged-quote',$2,'{}','{}','2026-10-01T00:00:00Z','2026-10-02T00:00:00Z')
      `, [workspaceB, 'b'.repeat(64)])).rejects.toMatchObject({ code: '42501' })
      await client.query('ROLLBACK TO SAVEPOINT reject_foreign_quote_insert')

      await client.query('SAVEPOINT reject_foreign_terms_insert')
      await expect(client.query(`
        INSERT INTO commercial_order_terms_v3(workspace_id,order_id,purchase_kind,expires_at,policy_version,created_at)
        VALUES($1,'tenant-order-b','purchase','2026-11-01T00:00:00Z','forged','2026-10-01T00:00:00Z')
      `, [workspaceB])).rejects.toMatchObject({ code: '42501' })
      await client.query('ROLLBACK TO SAVEPOINT reject_foreign_terms_insert')

      await client.query('SAVEPOINT reject_tenant_reassignment')
      await expect(client.query(`UPDATE commercial_order_terms_v3 SET workspace_id=$1 WHERE workspace_id=$2 AND order_id='tenant-order-a'`, [workspaceB, workspaceA]))
        .rejects.toMatchObject({ code: '42501' })
      await client.query('ROLLBACK TO SAVEPOINT reject_tenant_reassignment')

      await client.query("SELECT set_config('app.workspace_id',$1,true)", [workspaceB])
      expect((await client.query('SELECT id FROM commercial_upgrade_quotes_v3 ORDER BY id')).rows)
        .toEqual([{ id: `tenant-quote-${workspaceB}` }])
      expect((await client.query('SELECT order_id FROM commercial_order_terms_v3 ORDER BY order_id')).rows)
        .toEqual([{ order_id: 'tenant-order-b' }])
    } finally {
      await client.query('ROLLBACK')
      client.release()
    }
  }, 30_000)
})
