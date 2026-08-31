import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { describe, expect, it } from 'vitest'
import { loadMigrations, MigrationRunner } from './migration.js'

const databaseUrlValue = process.env.PERSISTENCE_RELEASE_DATABASE_URL ?? process.env.PLATFORM_MEDIA_SPEC_DATABASE_URL
const postgresIt = databaseUrlValue ? it : it.skip

function databaseUrl(base: URL, name: string) {
  const result = new URL(base)
  result.pathname = `/${name}`
  return result.toString()
}

describe('persistence migration 077 canonical scope acceptance', () => {
  postgresIt('installs the triggers and rejects cross-scope task/publish writes', async () => {
    const base = new URL(databaseUrlValue!)
    const databaseName = `release_077_${randomUUID().replaceAll('-', '')}`
    const admin = new Pool({ connectionString: base.toString() })
    let db: Pool | undefined

    try {
      await admin.query(`CREATE DATABASE "${databaseName}"`)
      db = new Pool({ connectionString: databaseUrl(base, databaseName) })
      const migrations = (await loadMigrations()).filter(item => item.version <= 77)
      expect(migrations.at(-1)?.version).toBe(77)
      expect(await new MigrationRunner(db, migrations).run()).toEqual(migrations.map(item => item.version))

      const triggers = await db.query(`
        SELECT tgname FROM pg_trigger
        WHERE NOT tgisinternal AND tgname IN ('tasks_canonical_publish_scope', 'publish_jobs_task_scope')
        ORDER BY tgname
      `)
      expect(triggers.rows.map(row => row.tgname)).toEqual([
        'publish_jobs_task_scope',
        'tasks_canonical_publish_scope',
      ])

      await db.query(`INSERT INTO workspaces (id,status) VALUES ('ws_077','active')`)
      await db.query(`INSERT INTO platform_accounts
        (id,workspace_id,platform,remote_account_id,credential_ref,token_state)
        VALUES ('acct_077_tb','ws_077','taobao','remote-tb','secret://tb','connected'),
               ('acct_077_jd','ws_077','jd','remote-jd','secret://jd','connected')`)
      await db.query(`INSERT INTO brands (id,workspace_id,name) VALUES ('brand_077','ws_077','Brand 077')`)
      await db.query(`INSERT INTO brand_store_bindings
        (workspace_id,brand_id,platform,platform_account_id)
        VALUES ('ws_077','brand_077','taobao','acct_077_tb')`)
      await db.query(`INSERT INTO products
        (id,workspace_id,platform,platform_account_id,remote_product_id,title,source)
        VALUES ('product_077','ws_077','taobao','acct_077_tb','remote-product-077','Product 077','official_api')`)
      await db.query(`INSERT INTO canonical_products
        (id,workspace_id,brand_id,title,legacy_product_id)
        VALUES ('canonical_077','ws_077','brand_077','Canonical 077','product_077')`)
      await db.query(`INSERT INTO product_listings
        (id,workspace_id,brand_id,canonical_product_id,platform,platform_account_id)
        VALUES ('listing_077','ws_077','brand_077','canonical_077','taobao','acct_077_tb')`)
      await db.query(`INSERT INTO tasks
        (id,workspace_id,product_id,brand_id,canonical_product_id,listing_id,platform,platform_account_id,state)
        VALUES ('task_077','ws_077','product_077','brand_077','canonical_077','listing_077','taobao','acct_077_tb','draft')`)
      await db.query(`INSERT INTO content_versions
        (id,workspace_id,task_id,version,body,state,created_by)
        VALUES ('content_077','ws_077','task_077',1,'{}','draft','migration-077')`)
      await db.query(`INSERT INTO publish_jobs
        (id,workspace_id,task_id,content_version_id,platform,platform_account_id,idempotency_key,
         confirmation_hash,remote_snapshot_hash,state)
        VALUES ('publish_077','ws_077','task_077','content_077','taobao','acct_077_tb','publish-077',
         repeat('a',64),repeat('b',64),'queued')`)

      await expect(db.query(`UPDATE tasks SET platform='jd', platform_account_id='acct_077_jd' WHERE id='task_077'`))
        .rejects.toMatchObject({ code: '23514' })
      await expect(db.query(`UPDATE publish_jobs SET platform='jd', platform_account_id='acct_077_jd' WHERE id='publish_077'`))
        .rejects.toMatchObject({ code: '23514' })
    } finally {
      await db?.end()
      await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1', [databaseName])
      await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`)
      await admin.end()
    }
  }, 240_000)
})
