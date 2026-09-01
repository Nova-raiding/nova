import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { Pool } from 'pg'
import { describe, expect, it } from 'vitest'
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

async function campaignSchemaFingerprint(pool: Pool) {
  const relations = await pool.query(`SELECT c.relname AS name,c.relkind AS kind,c.relrowsecurity,c.relforcerowsecurity
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname IN ('batch_campaigns','batch_campaign_items') ORDER BY c.relname`)
  const columns = await pool.query(`SELECT table_name,column_name,data_type,is_nullable,column_default,is_generated,generation_expression
    FROM information_schema.columns WHERE table_schema='public' AND table_name IN ('batch_campaigns','batch_campaign_items') ORDER BY table_name,ordinal_position`)
  const constraints = await pool.query(`SELECT c.conrelid::regclass::text AS table_name,c.conname,pg_get_constraintdef(c.oid,true) AS definition
    FROM pg_constraint c WHERE c.conrelid IN ('batch_campaigns'::regclass,'batch_campaign_items'::regclass) ORDER BY table_name,c.conname`)
  const indexes = await pool.query(`SELECT tablename,indexname,indexdef FROM pg_indexes
    WHERE schemaname='public' AND tablename IN ('batch_campaigns','batch_campaign_items') ORDER BY tablename,indexname`)
  const policies = await pool.query(`SELECT tablename,policyname,permissive,roles,cmd,qual,with_check FROM pg_policies
    WHERE schemaname='public' AND tablename IN ('batch_campaigns','batch_campaign_items') ORDER BY tablename,policyname`)
  const acl = await pool.query(`SELECT grantee,table_name,privilege_type FROM information_schema.role_table_grants
    WHERE table_schema='public' AND grantee IN ('merchant_app','merchant_ops') AND table_name IN ('batch_campaigns','batch_campaign_items')
    ORDER BY grantee,table_name,privilege_type`)
  return { relations: relations.rows, columns: columns.rows, constraints: constraints.rows, indexes: indexes.rows, policies: policies.rows, acl: acl.rows }
}

describe('persistence migration 068 release acceptance', () => {
  postgresIt('supports fresh install, 067 upgrade, least privilege, forced RLS, idempotency, and schema restore', async () => {
    const base = new URL(databaseUrlValue!)
    const suffix = randomUUID().replaceAll('-', '')
    const freshName = `release_068_fresh_${suffix}`
    const upgradeName = `release_068_upgrade_${suffix}`
    const restoreName = `release_068_restore_${suffix}`
    const probeRole = `release_068_public_${suffix}`
    const temporary = await mkdtemp(join(tmpdir(), 'persistence-068-release-'))
    const dumpPath = join(temporary, 'schema.dump')
    const admin = new Pool({ connectionString: base.toString() })
    let fresh: Pool | undefined
    let upgrade: Pool | undefined
    let restored: Pool | undefined
    let app: Pool | undefined

    try {
      for (const name of [freshName, upgradeName, restoreName]) await admin.query(`CREATE DATABASE "${name}"`)
      await admin.query(`CREATE ROLE "${probeRole}" NOLOGIN`)
      fresh = new Pool({ connectionString: databaseUrl(base, freshName) })
      upgrade = new Pool({ connectionString: databaseUrl(base, upgradeName) })
      restored = new Pool({ connectionString: databaseUrl(base, restoreName) })
      const migrations = (await loadMigrations()).filter(item => item.version <= 68)
      expect(migrations.at(-1)?.version).toBe(68)

      expect(await new MigrationRunner(fresh, migrations).run()).toEqual(migrations.map(item => item.version))
      expect(await new MigrationRunner(fresh, migrations).run()).toEqual([])

      const acl = await fresh.query(`SELECT
        has_table_privilege('merchant_app','batch_campaigns','SELECT,INSERT,UPDATE') AS app_campaign_write,
        has_table_privilege('merchant_app','batch_campaigns','DELETE,TRUNCATE,REFERENCES,TRIGGER') AS app_campaign_dangerous,
        has_table_privilege('merchant_app','batch_campaign_items','SELECT,INSERT,UPDATE') AS app_item_write,
        has_table_privilege('merchant_app','batch_campaign_items','DELETE,TRUNCATE,REFERENCES,TRIGGER') AS app_item_dangerous,
        has_table_privilege('merchant_ops','batch_campaigns','SELECT') AS ops_campaign_select,
        has_table_privilege('merchant_ops','batch_campaign_items','SELECT') AS ops_item_select`)
      expect(acl.rows[0]).toEqual({ app_campaign_write: true, app_campaign_dangerous: false, app_item_write: true, app_item_dangerous: false, ops_campaign_select: false, ops_item_select: false })

      const rls = await fresh.query(`SELECT c.relname,c.relrowsecurity,c.relforcerowsecurity,p.qual,p.with_check
        FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        JOIN pg_policies p ON p.schemaname=n.nspname AND p.tablename=c.relname
        WHERE n.nspname='public' AND c.relname IN ('batch_campaigns','batch_campaign_items') ORDER BY c.relname`)
      expect(rls.rows).toHaveLength(2)
      for (const row of rls.rows) {
        expect(row).toMatchObject({ relrowsecurity: true, relforcerowsecurity: true })
        expect(row.qual).toContain("current_setting('app.workspace_id'::text, true)")
        expect(row.with_check).toContain("current_setting('app.workspace_id'::text, true)")
      }

      await fresh.query("INSERT INTO workspaces (id,status) VALUES ('ws_068_a','active'),('ws_068_b','active')")
      await fresh.query("INSERT INTO brands (id,workspace_id,name) VALUES ('brand_068_a','ws_068_a','Brand A'),('brand_068_b','ws_068_b','Brand B')")
      await fresh.query(`INSERT INTO batch_campaigns (id,workspace_id,idempotency_key,manifest_hash,created_by)
        VALUES ('campaign_068_b','ws_068_b','campaign-b',$1,'release-test')`, [digest('b')])
      await fresh.query(`INSERT INTO batch_campaign_items (id,workspace_id,campaign_id,brand_id,ordinal)
        VALUES ('item_068_b','ws_068_b','campaign_068_b','brand_068_b',1)`)

      app = new Pool({ connectionString: databaseUrl(base, freshName, 'merchant_app', 'merchant_app_local_only'), max: 2 })
      const appClient = await app.connect()
      try {
        await appClient.query('BEGIN')
        await appClient.query("SELECT set_config('app.workspace_id','ws_068_a',true)")
        await appClient.query(`INSERT INTO batch_campaigns (id,workspace_id,idempotency_key,manifest_hash,created_by)
          VALUES ('campaign_068_a','ws_068_a','campaign-a',$1,'merchant-app')`, [digest('a')])
        await appClient.query(`INSERT INTO batch_campaign_items (id,workspace_id,campaign_id,brand_id,ordinal)
          VALUES ('item_068_a','ws_068_a','campaign_068_a','brand_068_a',1)`)
        await expect(appClient.query('SELECT workspace_id,id FROM batch_campaigns ORDER BY id')).resolves.toMatchObject({ rows: [{ workspace_id: 'ws_068_a', id: 'campaign_068_a' }] })
        await expect(appClient.query('SELECT workspace_id,id FROM batch_campaign_items ORDER BY id')).resolves.toMatchObject({ rows: [{ workspace_id: 'ws_068_a', id: 'item_068_a' }] })
        await expect(appClient.query("UPDATE batch_campaigns SET state='paused' WHERE workspace_id='ws_068_b'")).resolves.toMatchObject({ rowCount: 0 })
        await expect(appClient.query("UPDATE batch_campaign_items SET state='paused' WHERE workspace_id='ws_068_b'")).resolves.toMatchObject({ rowCount: 0 })
        await appClient.query('COMMIT')

        await appClient.query('BEGIN')
        await appClient.query("SELECT set_config('app.workspace_id','ws_068_a',true)")
        await expect(appClient.query(`INSERT INTO batch_campaigns (id,workspace_id,idempotency_key,manifest_hash,created_by)
          VALUES ('campaign_068_cross','ws_068_b','campaign-cross',$1,'merchant-app')`, [digest('c')])).rejects.toThrow(/row-level security policy/u)
        await appClient.query('ROLLBACK')

        await appClient.query('BEGIN')
        await appClient.query("SELECT set_config('app.workspace_id','ws_068_a',true)")
        await expect(appClient.query("DELETE FROM batch_campaigns WHERE id='campaign_068_a'")).rejects.toThrow(/permission denied/u)
        await appClient.query('ROLLBACK')
      } finally {
        appClient.release()
      }

      const probe = await fresh.connect()
      try {
        await probe.query('BEGIN')
        await probe.query(`SET LOCAL ROLE "${probeRole}"`)
        await expect(probe.query('SELECT id FROM batch_campaigns')).rejects.toThrow(/permission denied/u)
        await probe.query('ROLLBACK')
      } finally {
        probe.release()
      }

      const through067 = migrations.filter(item => item.version <= 67)
      expect(await new MigrationRunner(upgrade, through067).run()).toEqual(through067.map(item => item.version))
      await upgrade.query('GRANT ALL ON TABLE batch_campaigns, batch_campaign_items TO PUBLIC, merchant_app, merchant_ops')
      expect(await new MigrationRunner(upgrade, migrations.filter(item => item.version === 68)).run()).toEqual([68])
      expect(await new MigrationRunner(upgrade, migrations).run()).toEqual([])
      expect(await campaignSchemaFingerprint(upgrade)).toEqual(await campaignSchemaFingerprint(fresh))

      await run('pg_dump', ['--format=custom', '--schema-only', '--no-owner', '--file', dumpPath, databaseUrl(base, freshName)])
      await run('pg_restore', ['--dbname', databaseUrl(base, restoreName), '--no-owner', dumpPath])
      expect(await campaignSchemaFingerprint(restored)).toEqual(await campaignSchemaFingerprint(fresh))
    } finally {
      await app?.end()
      await Promise.all([fresh?.end(), upgrade?.end(), restored?.end()])
      for (const name of [freshName, upgradeName, restoreName]) {
        await admin.query(`DROP DATABASE IF EXISTS "${name}"`)
      }
      await admin.query(`DROP ROLE IF EXISTS "${probeRole}"`)
      await admin.end()
      await rm(temporary, { recursive: true, force: true })
    }
  }, 240_000)
})
