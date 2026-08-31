import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { Pool } from 'pg'
import { describe, expect, it } from 'vitest'
import { BusinessSnapshotVersionConflictError, PostgresBusinessRepository, type SaveBusinessSnapshotInput } from './business-repository.js'
import { loadMigrations, MigrationRunner } from './migration.js'

const run = promisify(execFile)
const databaseUrlValue = process.env.PERSISTENCE_RELEASE_DATABASE_URL ?? process.env.PLATFORM_MEDIA_SPEC_DATABASE_URL
const postgresIt = databaseUrlValue ? it : it.skip
const digest = (value: string) => value.repeat(64)

function databaseUrl(base: URL, name: string, user?: string, password?: string) {
  const result = new URL(base)
  result.pathname = `/${name}`
  if (user) result.username = user
  if (password) result.password = password
  return result.toString()
}

async function platformScopeFingerprint(pool: Pool) {
  const relations = await pool.query(`SELECT c.relname,c.relrowsecurity,c.relforcerowsecurity
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname IN ('platform_accounts','products','tasks','publish_jobs') ORDER BY c.relname`)
  const index = await pool.query(`SELECT indexname,indexdef FROM pg_indexes
    WHERE schemaname='public' AND indexname='platform_accounts_workspace_platform_id_key'`)
  const triggers = await pool.query(`SELECT c.relname AS table_name,t.tgname,pg_get_triggerdef(t.oid,true) AS definition
    FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND NOT t.tgisinternal AND t.tgname IN
      ('products_platform_account_scope','tasks_platform_account_scope','publish_jobs_platform_account_scope')
    ORDER BY c.relname,t.tgname`)
  const policies = await pool.query(`SELECT tablename,policyname,permissive,roles,cmd,qual,with_check FROM pg_policies
    WHERE schemaname='public' AND tablename IN ('products','tasks','publish_jobs') ORDER BY tablename,policyname`)
  const routine = await pool.query(`SELECT pg_get_functiondef(p.oid) AS definition,p.proconfig,
      has_function_privilege('merchant_app',p.oid,'EXECUTE') AS app_execute,
      has_function_privilege('merchant_ops',p.oid,'EXECUTE') AS ops_execute,
      EXISTS (SELECT 1 FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) acl WHERE acl.grantee=0 AND acl.privilege_type='EXECUTE') AS public_execute
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname='assert_platform_account_scope'`)
  return { relations: relations.rows, index: index.rows, triggers: triggers.rows, policies: policies.rows, routine: routine.rows }
}

async function roleTableAcl(pool: Pool) {
  return (await pool.query(`SELECT grantee,table_name,privilege_type FROM information_schema.role_table_grants
    WHERE table_schema='public' AND grantee IN ('merchant_app','merchant_ops')
      AND table_name IN ('platform_accounts','products','tasks','publish_jobs')
    ORDER BY grantee,table_name,privilege_type`)).rows
}

async function grantRuntimeBaseline(pool: Pool) {
  await pool.query('GRANT SELECT ON TABLE platform_accounts TO merchant_app')
  await pool.query('GRANT SELECT, INSERT, UPDATE ON TABLE products, tasks, publish_jobs, content_versions, business_entity_snapshots TO merchant_app')
}

const productSnapshot = (title: string, version: number): SaveBusinessSnapshotInput => ({
  workspaceId: 'ws_069_a',
  entityType: 'product',
  entityId: 'product_069_cas',
  entityVersion: version,
  payload: {
    id: 'product_069_cas', workspaceId: 'ws_069_a', platform: 'taobao', accountId: 'account_069_tb',
    title, storeName: 'Release store', skuCount: 1, stock: 1, images: [], attributes: {}, factsConfirmed: true,
    source: 'official_api', version,
  },
})

describe('persistence migration 069 release acceptance', () => {
  postgresIt('supports fresh install, 068 upgrade, idempotency, RLS/ACL, restore, disconnect, and concurrent CAS', async () => {
    const base = new URL(databaseUrlValue!)
    const suffix = randomUUID().replaceAll('-', '')
    const freshName = `release_069_fresh_${suffix}`
    const upgradeName = `release_069_upgrade_${suffix}`
    const restoreName = `release_069_restore_${suffix}`
    const probeRole = `release_069_public_${suffix}`
    const temporary = await mkdtemp(join(tmpdir(), 'persistence-069-release-'))
    const dumpPath = join(temporary, 'schema.dump')
    const admin = new Pool({ connectionString: base.toString() })
    let fresh: Pool | undefined
    let upgrade: Pool | undefined
    let restored: Pool | undefined
    let appA: Pool | undefined
    let appB: Pool | undefined

    try {
      for (const name of [freshName, upgradeName, restoreName]) await admin.query(`CREATE DATABASE "${name}"`)
      await admin.query(`CREATE ROLE "${probeRole}" NOLOGIN`)
      fresh = new Pool({ connectionString: databaseUrl(base, freshName) })
      upgrade = new Pool({ connectionString: databaseUrl(base, upgradeName) })
      restored = new Pool({ connectionString: databaseUrl(base, restoreName) })
      const migrations = (await loadMigrations()).filter(item => item.version <= 69)
      expect(migrations.at(-1)?.version).toBe(69)

      expect(await new MigrationRunner(fresh, migrations).run()).toEqual(migrations.map(item => item.version))
      expect(await new MigrationRunner(fresh, migrations).run()).toEqual([])

      const fingerprint = await platformScopeFingerprint(fresh)
      expect(fingerprint.relations).toHaveLength(4)
      for (const relation of fingerprint.relations.filter(row => row.relname !== 'platform_accounts')) {
        expect(relation).toMatchObject({ relrowsecurity: true, relforcerowsecurity: true })
      }
      expect(fingerprint.index).toHaveLength(1)
      expect(fingerprint.triggers).toHaveLength(3)
      expect(fingerprint.routine).toEqual([expect.objectContaining({ proconfig: ['search_path=pg_catalog, public'], app_execute: false, ops_execute: false, public_execute: false })])

      await grantRuntimeBaseline(fresh)

      await fresh.query("INSERT INTO workspaces (id,status) VALUES ('ws_069_a','active'),('ws_069_b','active')")
      await fresh.query(`INSERT INTO platform_accounts (id,workspace_id,platform,remote_account_id,credential_ref,token_state) VALUES
        ('account_069_tb','ws_069_a','taobao','remote-tb','secret://tb','connected'),
        ('account_069_jd','ws_069_a','jd','remote-jd','secret://jd','connected'),
        ('account_069_b','ws_069_b','taobao','remote-b','secret://b','connected')`)
      await fresh.query(`INSERT INTO products (id,workspace_id,platform,platform_account_id,title,source)
        VALUES ('product_069_b','ws_069_b','taobao','account_069_b','Other tenant','official_api')`)

      const appUrl = databaseUrl(base, freshName, 'merchant_app', 'merchant_app_local_only')
      appA = new Pool({ connectionString: appUrl, max: 2 })
      appB = new Pool({ connectionString: appUrl, max: 2 })
      const client = await appA.connect()
      try {
        await client.query('BEGIN')
        await client.query("SELECT set_config('app.workspace_id','ws_069_a',true)")
        await client.query(`INSERT INTO products (id,workspace_id,platform,platform_account_id,title,source)
          VALUES ('product_069_direct','ws_069_a','taobao','account_069_tb','Direct','official_api')`)
        await client.query(`INSERT INTO tasks (id,workspace_id,product_id,platform,platform_account_id,state)
          VALUES ('task_069','ws_069_a','product_069_direct','taobao','account_069_tb','draft')`)
        await client.query(`INSERT INTO content_versions (id,workspace_id,task_id,version,body,state,created_by)
          VALUES ('content_069','ws_069_a','task_069',1,'{}','draft','release-test')`)
        await client.query(`INSERT INTO publish_jobs (id,workspace_id,task_id,content_version_id,platform,platform_account_id,idempotency_key,confirmation_hash,remote_snapshot_hash,state)
          VALUES ('publish_069','ws_069_a','task_069','content_069','taobao','account_069_tb','publish-069',$1,$2,'queued')`, [digest('a'), digest('b')])
        await expect(client.query('SELECT id FROM products ORDER BY id')).resolves.toMatchObject({ rows: [{ id: 'product_069_direct' }] })
        await expect(client.query("UPDATE products SET title='hidden' WHERE workspace_id='ws_069_b'")).resolves.toMatchObject({ rowCount: 0 })
        await client.query('COMMIT')

        for (const [table, id] of [['products', 'product_069_direct'], ['tasks', 'task_069'], ['publish_jobs', 'publish_069']] as const) {
          await client.query('BEGIN')
          await client.query("SELECT set_config('app.workspace_id','ws_069_a',true)")
          await expect(client.query(`UPDATE ${table} SET platform_account_id='account_069_jd' WHERE workspace_id='ws_069_a' AND id=$1`, [id])).rejects.toMatchObject({ code: '23514' })
          await client.query('ROLLBACK')
        }

        await client.query('BEGIN')
        await client.query("SELECT set_config('app.workspace_id','ws_069_a',true)")
        await client.query('CREATE TEMP TABLE platform_accounts (workspace_id text,id text,platform text)')
        await client.query("INSERT INTO platform_accounts VALUES ('ws_069_a','account_069_jd','taobao')")
        await client.query("SELECT set_config('search_path','pg_temp,public',true)")
        await expect(client.query(`INSERT INTO products (id,workspace_id,platform,platform_account_id,title,source)
          VALUES ('product_069_hijack','ws_069_a','taobao','account_069_jd','Hijack','official_api')`)).rejects.toMatchObject({ code: '23514' })
        await client.query('ROLLBACK')
      } finally {
        client.release()
      }

      const first = new PostgresBusinessRepository(appA, { normalizedProjection: true })
      const second = new PostgresBusinessRepository(appB, { normalizedProjection: true })
      await first.save(productSnapshot('Initial', 1))
      const raced = await Promise.allSettled([first.save(productSnapshot('Replica A', 2)), second.save(productSnapshot('Replica B', 2))])
      expect(raced.filter(result => result.status === 'fulfilled')).toHaveLength(1)
      expect(raced.find(result => result.status === 'rejected')).toMatchObject({ reason: expect.any(BusinessSnapshotVersionConflictError) })

      await Promise.all([appA.end(), appB.end()])
      appA = undefined
      appB = new Pool({ connectionString: appUrl, max: 2 })
      const reconnected = new PostgresBusinessRepository(appB)
      const durable = await reconnected.get('ws_069_a', 'product', 'product_069_cas')
      expect(durable.entityVersion).toBe(2)
      expect(['Replica A', 'Replica B']).toContain(durable.payload.title)

      const acl = await fresh.query(`SELECT
        has_function_privilege('merchant_app','assert_platform_account_scope()','EXECUTE') AS app_execute,
        has_function_privilege('merchant_ops','assert_platform_account_scope()','EXECUTE') AS ops_execute,
        has_table_privilege('merchant_app','products','SELECT,INSERT,UPDATE') AS app_products_write,
        has_table_privilege('merchant_app','products','DELETE') AS app_products_delete,
        has_table_privilege('merchant_ops','products','SELECT') AS ops_products_select`)
      expect(acl.rows[0]).toEqual({ app_execute: false, ops_execute: false, app_products_write: true, app_products_delete: false, ops_products_select: false })
      const probe = await fresh.connect()
      try {
        await probe.query('BEGIN')
        await probe.query(`SET LOCAL ROLE "${probeRole}"`)
        await expect(probe.query('SELECT id FROM products')).rejects.toThrow(/permission denied/u)
        await probe.query('ROLLBACK')
      } finally {
        probe.release()
      }

      const through068 = migrations.filter(item => item.version <= 68)
      expect(await new MigrationRunner(upgrade, through068).run()).toEqual(through068.map(item => item.version))
      await grantRuntimeBaseline(upgrade)
      const aclBefore = await roleTableAcl(upgrade)
      expect(await new MigrationRunner(upgrade, migrations.filter(item => item.version === 69)).run()).toEqual([69])
      expect(await new MigrationRunner(upgrade, migrations).run()).toEqual([])
      expect(await roleTableAcl(upgrade)).toEqual(aclBefore)
      expect(await platformScopeFingerprint(upgrade)).toEqual(await platformScopeFingerprint(fresh))

      await run('pg_dump', ['--format=custom', '--schema-only', '--no-owner', '--file', dumpPath, databaseUrl(base, freshName)])
      await run('pg_restore', ['--dbname', databaseUrl(base, restoreName), '--no-owner', dumpPath])
      expect(await platformScopeFingerprint(restored)).toEqual(await platformScopeFingerprint(fresh))
    } finally {
      await Promise.all([appA?.end(), appB?.end()])
      await Promise.all([fresh?.end(), upgrade?.end(), restored?.end()])
      for (const name of [freshName, upgradeName, restoreName]) {
        await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1', [name])
        await admin.query(`DROP DATABASE IF EXISTS "${name}"`)
      }
      await admin.query(`DROP ROLE IF EXISTS "${probeRole}"`)
      await admin.end()
      await rm(temporary, { recursive: true, force: true })
    }
  }, 240_000)
})
