import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { describe, expect, it } from 'vitest'
import { loadMigrations, MigrationRunner } from './migration.js'

const databaseUrlValue = process.env.PERSISTENCE_RELEASE_DATABASE_URL ?? process.env.PLATFORM_MEDIA_SPEC_DATABASE_URL
const postgresIt = databaseUrlValue ? it : it.skip

function databaseUrl(base: URL, databaseName: string) {
  const result = new URL(base)
  result.pathname = `/${databaseName}`
  return result.toString()
}

describe('migration 126 context snapshot canonical scope integrity', () => {
  it('registers a non-destructive fail-closed task snapshot guard', async () => {
    const migrations = await loadMigrations()
    expect(migrations.find(item => item.version === 126)).toMatchObject({
      version: 126,
      name: 'context_snapshot_canonical_scope_integrity',
    })

    const sql = await readFile(new URL('./migrations/126_context_snapshot_canonical_scope_integrity.sql', import.meta.url), 'utf8')
    expect(sql).toContain('context_snapshot_links_canonical_scope')
    expect(sql).toContain('canonical and listing scope must be provided together')
    expect(sql).toContain('task_scope.canonical_product_id IS DISTINCT FROM NEW.canonical_product_id')
    expect(sql).toContain('listing_scope.canonical_product_id IS DISTINCT FROM NEW.canonical_product_id')
    expect(sql).not.toMatch(/\bDELETE\s+FROM|\bUPDATE\s+context_snapshot_links\b/iu)
  })

  postgresIt('rejects task snapshots whose canonical scope disagrees with the task or listing', async () => {
    const base = new URL(databaseUrlValue!)
    const databaseName = `release_126_${randomUUID().replaceAll('-', '')}`
    const admin = new Pool({ connectionString: base.toString() })
    let database: Pool | undefined
    try {
      await admin.query(`CREATE DATABASE "${databaseName}"`)
      database = new Pool({ connectionString: databaseUrl(base, databaseName) })
      const migrations = await loadMigrations()
      await new MigrationRunner(database, migrations).run()

      await database.query("INSERT INTO workspaces (id,status) VALUES ('ws_126','active')")
      await database.query(`INSERT INTO platform_accounts
        (id,workspace_id,platform,remote_account_id,credential_ref,token_state)
        VALUES ('acct_126','ws_126','taobao','remote-126','secret://126','connected')`)
      await database.query("INSERT INTO brands (id,workspace_id,name) VALUES ('brand_126','ws_126','Brand 126')")
      await database.query(`INSERT INTO brand_store_bindings
        (workspace_id,brand_id,platform,platform_account_id)
        VALUES ('ws_126','brand_126','taobao','acct_126')`)
      await database.query(`INSERT INTO products
        (id,workspace_id,platform,platform_account_id,remote_product_id,title,source,data)
        VALUES ('product_126','ws_126','taobao','acct_126','remote-product-126','Product 126','official_api','{"brandId":"brand_126"}')`)
      await database.query(`INSERT INTO canonical_products
        (id,workspace_id,brand_id,title,legacy_product_id)
        VALUES ('canonical_126','ws_126','brand_126','Canonical 126','product_126')`)
      await database.query(`INSERT INTO product_listings
        (id,workspace_id,brand_id,canonical_product_id,platform,platform_account_id)
        VALUES ('listing_126','ws_126','brand_126','canonical_126','taobao','acct_126')`)
      await database.query(`INSERT INTO tasks
        (id,workspace_id,product_id,brand_id,canonical_product_id,listing_id,platform,platform_account_id,state)
        VALUES ('task_126','ws_126','product_126','brand_126','canonical_126','listing_126','taobao','acct_126','draft')`)
      await database.query(`INSERT INTO context_blobs
        (workspace_id,context_hash,envelope,input_tokens_estimate,max_input_tokens)
        VALUES ('ws_126',repeat('a',64),'{}',1,10)`)

      await expect(database.query(`INSERT INTO context_snapshot_links
        (id,workspace_id,context_hash,brand_id,task_id,canonical_product_id,listing_id)
        VALUES ('link_126_good','ws_126',repeat('a',64),'brand_126','task_126','canonical_126','listing_126')`))
        .resolves.toMatchObject({ rowCount: 1 })
      await expect(database.query(`INSERT INTO context_snapshot_links
        (id,workspace_id,context_hash,brand_id,task_id,canonical_product_id,listing_id)
        VALUES ('link_126_bad','ws_126',repeat('a',64),'brand_126','task_126','canonical_other','listing_126')`))
        .rejects.toMatchObject({ code: '23514' })
      await expect(database.query(`INSERT INTO context_snapshot_links
        (id,workspace_id,context_hash,brand_id,task_id,canonical_product_id)
        VALUES ('link_126_incomplete','ws_126',repeat('a',64),'brand_126','task_126','canonical_126')`))
        .rejects.toMatchObject({ code: '23514' })
    } finally {
      await database?.end()
      await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1', [databaseName])
      await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`)
      await admin.end()
    }
  }, 240_000)
})
