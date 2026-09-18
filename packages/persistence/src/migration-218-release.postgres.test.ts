import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { describe, expect, it } from 'vitest'
import { loadMigrations, MigrationRunner } from './migration.js'

const databaseUrlValue = process.env.PERSISTENCE_RELEASE_DATABASE_URL
const postgresIt = databaseUrlValue ? it : it.skip

function databaseUrl(base: URL, databaseName: string, user?: string, password?: string) {
  const url = new URL(base)
  url.pathname = `/${databaseName}`
  if (user) url.username = user
  if (password) url.password = password
  return url.toString()
}

describe('migration 218 PostgreSQL manual publish evidence acceptance', () => {
  postgresIt('upgrades 217 and enforces tenant isolation, referential scope and append-only access', async () => {
    const base = new URL(databaseUrlValue!)
    const databaseName = `release_218_${randomUUID().replaceAll('-', '')}`
    const admin = new Pool({ connectionString: base.toString() })
    let database: Pool | undefined
    let app: Pool | undefined
    try {
      await admin.query(`CREATE DATABASE "${databaseName}"`)
      database = new Pool({ connectionString: databaseUrl(base, databaseName) })
      const migrations = await loadMigrations()
      const through217 = migrations.filter(migration => migration.version <= 217)
      const migration218 = migrations.filter(migration => migration.version === 218)
      expect(migration218).toHaveLength(1)
      await new MigrationRunner(database, through217).run()

      await database.query("INSERT INTO workspaces(id,status) VALUES ('ws_218_a','active'),('ws_218_b','active')")
      await database.query(`INSERT INTO platform_accounts(id,workspace_id,platform,remote_account_id,credential_ref,token_state) VALUES
        ('acct_218_a','ws_218_a','taobao','remote-a','secret://a','connected'),
        ('acct_218_b','ws_218_b','taobao','remote-b','secret://b','connected')`)
      await database.query(`INSERT INTO products(id,workspace_id,platform,platform_account_id,title,source) VALUES
        ('product_218_a','ws_218_a','taobao','acct_218_a','A','official_api'),
        ('product_218_b','ws_218_b','taobao','acct_218_b','B','official_api')`)
      await database.query(`INSERT INTO tasks(id,workspace_id,product_id,platform,platform_account_id,state) VALUES
        ('task_218_a','ws_218_a','product_218_a','taobao','acct_218_a','draft'),
        ('task_218_b','ws_218_b','product_218_b','taobao','acct_218_b','draft')`)
      await database.query(`INSERT INTO content_versions(id,workspace_id,task_id,version,body,state,created_by) VALUES
        ('content_218_a','ws_218_a','task_218_a',1,'{}','approved','test'),
        ('content_218_b','ws_218_b','task_218_b',1,'{}','approved','test')`)

      expect(await new MigrationRunner(database, migration218).run()).toEqual([218])
      app = new Pool({ connectionString: databaseUrl(base, databaseName, 'merchant_app', 'merchant_app_local_only') })
      const client = await app.connect()
      try {
        await client.query('BEGIN')
        await client.query("SELECT set_config('app.workspace_id','ws_218_a',true)")
        await client.query(`INSERT INTO manual_publish_evidence
          (id,workspace_id,platform,platform_account_id,product_id,task_id,approved_content_version_id,delivery_bundle_sha256,evidence_manifest_sha256,status,created_by_actor_id,updated_by_actor_id)
          VALUES ('manual_218_a','ws_218_a','taobao','acct_218_a','product_218_a','task_218_a','content_218_a',$1,$2,'export_ready','actor-a','actor-a')`, ['a'.repeat(64), 'b'.repeat(64)])
        await expect(client.query('SELECT id FROM manual_publish_evidence')).resolves.toMatchObject({ rows: [{ id: 'manual_218_a' }] })
        await expect(client.query("SELECT id FROM manual_publish_evidence WHERE workspace_id='ws_218_b'")).resolves.toMatchObject({ rows: [] })
        await expect(client.query("DELETE FROM manual_publish_evidence WHERE id='manual_218_a'")).rejects.toMatchObject({ code: '42501' })
        await client.query('ROLLBACK')
      } finally {
        client.release()
      }

      await expect(database.query(`INSERT INTO manual_publish_evidence
        (id,workspace_id,platform,platform_account_id,product_id,task_id,approved_content_version_id,delivery_bundle_sha256,evidence_manifest_sha256,status,created_by_actor_id,updated_by_actor_id)
        VALUES ('manual_218_cross','ws_218_a','taobao','acct_218_b','product_218_a','task_218_a','content_218_a',$1,$2,'export_ready','actor-a','actor-a')`, ['c'.repeat(64), 'd'.repeat(64)]))
        .rejects.toMatchObject({ code: '23503' })
      expect((await database.query('SELECT max(version)::int AS version FROM schema_migrations')).rows).toEqual([{ version: 218 }])
    } finally {
      await app?.end()
      await database?.end()
      await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`)
      await admin.end()
    }
  }, 240_000)
})
