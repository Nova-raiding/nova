import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadMigrations, MigrationRunner } from './migration.js'

const source = process.env.PERSISTENCE_RELEASE_DATABASE_URL

describe.skipIf(!source)('catalog batch import tenant RLS on isolated PostgreSQL', () => {
  const databaseName = `catalog_import_rls_${randomUUID().replaceAll('-', '')}`
  const workspaceA = `catalog-rls-a-${randomUUID()}`
  const workspaceB = `catalog-rls-b-${randomUUID()}`
  let admin: Pool | undefined
  let database: Pool | undefined
  let app: Pool | undefined

  beforeAll(async () => {
    admin = new Pool({ connectionString: source!, connectionTimeoutMillis: 10000 })
    await admin.query(`CREATE DATABASE "${databaseName}"`)
    const url = new URL(source!); url.pathname = `/${databaseName}`
    database = new Pool({ connectionString: url.toString(), max: 4 })
    await database.query(await readFile(new URL('../../../infra/local/ensure-app-role.sql', import.meta.url), 'utf8'))
    await new MigrationRunner(database, await loadMigrations()).run()
    const appUrl = new URL(url); appUrl.username = 'merchant_app'; appUrl.password = 'merchant_app_local_only'
    app = new Pool({ connectionString: appUrl.toString(), max: 1 })
    await database.query("INSERT INTO workspaces(id,status) VALUES($1,'active'),($2,'active')", [workspaceA, workspaceB])
    await database.query(`INSERT INTO catalog_batch_import_idempotency
      (workspace_id,actor_id,operation,idempotency_key,request_hash,status,claim_token,claim_expires_at)
      VALUES ($1,'actor-a','catalog.import.batch.v1','catalog-rls-seed-a','${'a'.repeat(64)}','claimed',$3,now()+interval '5 minutes'),
             ($2,'actor-b','catalog.import.batch.v1','catalog-rls-seed-b','${'b'.repeat(64)}','claimed',$4,now()+interval '5 minutes')`,
    [workspaceA, workspaceB, randomUUID(), randomUUID()])
  }, 120000)

  afterAll(async () => {
    await app?.end()
    await database?.end()
    if (admin) {
      try { await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`) }
      finally { await admin.end() }
    }
  }, 60000)

  it('filters reads and rejects cross-workspace writes for a real merchant_app session', async () => {
    await app!.query('BEGIN')
    try {
      await app!.query("SELECT set_config('app.workspace_id',$1,true)", [workspaceA])
      const visible = await app!.query<{ workspace_id: string }>(
        'SELECT workspace_id FROM catalog_batch_import_idempotency ORDER BY workspace_id',
      )
      expect(visible.rows).toEqual([{ workspace_id: workspaceA }])

      const crossTenantUpdate = await app!.query(
        "UPDATE catalog_batch_import_idempotency SET status='in_progress',claim_expires_at=NULL,started_at=now() WHERE workspace_id=$1 AND idempotency_key='catalog-rls-seed-b'",
        [workspaceB],
      )
      expect(crossTenantUpdate.rowCount).toBe(0)

      await expect(app!.query(`INSERT INTO catalog_batch_import_idempotency
        (workspace_id,actor_id,operation,idempotency_key,request_hash,status,claim_token,claim_expires_at)
        VALUES ($1,'forged','catalog.import.batch.v1','catalog-rls-forged','${'c'.repeat(64)}','claimed',$2,now()+interval '5 minutes')`,
      [workspaceB, randomUUID()])).rejects.toMatchObject({ code: '42501' })
    } finally {
      await app!.query('ROLLBACK')
    }
  }, 30000)
})
