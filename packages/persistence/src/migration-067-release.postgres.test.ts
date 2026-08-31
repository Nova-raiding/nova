import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { describe, expect, it } from 'vitest'
import { loadMigrations, MigrationRunner } from './migration.js'
import { PostgresMappingPreflightApprovalRepository } from './mapping-preflight-approval-repository.js'
import { PostgresPlatformMediaSpecRepository } from './platform-media-spec-repository.js'

const run = promisify(execFile)
const databaseUrlValue = process.env.PERSISTENCE_RELEASE_DATABASE_URL ?? process.env.PLATFORM_MEDIA_SPEC_DATABASE_URL
const postgresIt = databaseUrlValue ? it : it.skip
const digest = (value: string) => value.repeat(64)
const releaseInstant = '2030-01-01T00:00:00.000Z'
const expiresAt = '2030-02-01T00:00:00.000Z'

function databaseUrl(base: URL, name: string, user?: string, password?: string) {
  const result = new URL(base); result.pathname = `/${name}`
  if (user) result.username = user
  if (password) result.password = password
  return result.toString()
}

async function schemaFingerprint(pool: Pool) {
  const relations = await pool.query(`SELECT c.relname AS name,c.relkind AS kind
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relname IN ('platform_media_specs','platform_media_spec_audit','active_platform_media_specs','platform_mapping_preflight_approvals') ORDER BY c.relname`)
  const columns = await pool.query(`SELECT table_name,column_name,data_type,is_nullable,column_default,is_generated,generation_expression
    FROM information_schema.columns WHERE table_schema='public' AND table_name IN ('platform_media_specs','platform_media_spec_audit','active_platform_media_specs','platform_mapping_preflight_approvals') ORDER BY table_name,ordinal_position`)
  const constraints = await pool.query(`SELECT c.conrelid::regclass::text AS table_name,c.conname,pg_get_constraintdef(c.oid,true) AS definition
    FROM pg_constraint c WHERE c.conrelid IN ('platform_media_specs'::regclass,'platform_media_spec_audit'::regclass,'platform_mapping_preflight_approvals'::regclass) ORDER BY table_name,c.conname`)
  const indexes = await pool.query(`SELECT tablename,indexname,indexdef FROM pg_indexes WHERE schemaname='public' AND tablename IN ('platform_media_specs','platform_media_spec_audit','platform_mapping_preflight_approvals') ORDER BY tablename,indexname`)
  const policies = await pool.query(`SELECT tablename,policyname,permissive,roles,cmd,qual,with_check FROM pg_policies WHERE schemaname='public' AND tablename='platform_mapping_preflight_approvals' ORDER BY policyname`)
  const views = await pool.query(`SELECT viewname,definition FROM pg_views WHERE schemaname='public' AND viewname='active_platform_media_specs'`)
  const acl = await pool.query(`SELECT grantee,table_name,privilege_type FROM information_schema.role_table_grants WHERE table_schema='public' AND grantee IN ('merchant_app','merchant_ops') AND table_name IN ('platform_media_specs','platform_media_spec_audit','active_platform_media_specs','platform_mapping_preflight_approvals') ORDER BY grantee,table_name,privilege_type`)
  return { relations: relations.rows, columns: columns.rows, constraints: constraints.rows, indexes: indexes.rows, policies: policies.rows, views: views.rows, acl: acl.rows }
}

describe('persistence 001-067 release acceptance', () => {
  postgresIt('migrates fresh and upgraded databases, enforces runtime ACL/CAS, and restores the schema', async () => {
    const base = new URL(databaseUrlValue!)
    const suffix = randomUUID().replaceAll('-', '')
    const freshName = `release_fresh_${suffix}`
    const upgradeName = `release_upgrade_${suffix}`
    const restoreName = `release_restore_${suffix}`
    const probeRole = `release_public_${suffix}`
    const temporary = await mkdtemp(join(tmpdir(), 'persistence-release-'))
    const dumpPath = join(temporary, 'schema.dump')
    const admin = new Pool({ connectionString: base.toString() })
    let fresh: Pool | undefined
    let upgrade: Pool | undefined
    let restored: Pool | undefined
    let appA: Pool | undefined
    let appB: Pool | undefined
    let ops: Pool | undefined
    try {
      for (const name of [freshName, upgradeName, restoreName]) await admin.query(`CREATE DATABASE "${name}"`)
      await admin.query(`CREATE ROLE "${probeRole}" NOLOGIN`)
      fresh = new Pool({ connectionString: databaseUrl(base, freshName) })
      upgrade = new Pool({ connectionString: databaseUrl(base, upgradeName) })
      restored = new Pool({ connectionString: databaseUrl(base, restoreName) })
      const migrations = (await loadMigrations()).filter(item => item.version <= 67)
      expect(migrations.at(-1)?.version).toBe(67)

      expect(await new MigrationRunner(fresh, migrations).run()).toEqual(migrations.map(item => item.version))
      expect(await new MigrationRunner(fresh, migrations).run()).toEqual([])
      await fresh.query("INSERT INTO workspaces (id,status) VALUES ('ws_release_a','active'),('ws_release_b','active')")
      await fresh.query("INSERT INTO products (id,workspace_id,platform,remote_product_id,title,source) VALUES ('product-release','ws_release_a','taobao','remote-release','Release','official_api')")

      const appUrl = databaseUrl(base, freshName, 'merchant_app', 'merchant_app_local_only')
      const opsUrl = databaseUrl(base, freshName, 'merchant_ops', 'merchant_ops_local_only')
      appA = new Pool({ connectionString: appUrl, max: 2 }); appB = new Pool({ connectionString: appUrl, max: 2 }); ops = new Pool({ connectionString: opsUrl, max: 2 })

      const media = new PostgresPlatformMediaSpecRepository(ops, () => new Date(releaseInstant))
      const mediaDraft = await media.createDraft({ platform: 'taobao', placement: 'release-hero', device: 'mobile', version: 'v1', specJson: { width: 800, height: 800, formats: ['webp'], maxFileBytes: 2_000_000 }, sourceUrl: 'https://official.example/release-spec', sourceSha256: digest('a'), checkedAt: '2029-12-31T00:00:00.000Z', evidenceArtifactRef: 'artifact://release/spec', evidenceArtifactSha256: digest('b'), expiresAt, actorId: 'release-ops', actorRole: 'merchant_ops', reason: 'release acceptance', idempotencyKey: 'release-media-create' })
      const approved = await media.approve({ id: mediaDraft.spec.id, expectedRevision: 1, actorId: 'release-ops', actorRole: 'merchant_ops', reason: 'release approval', idempotencyKey: 'release-media-approve' })
      const appClient = await appA.connect()
      try {
        await appClient.query('BEGIN'); await appClient.query("SELECT set_config('app.workspace_id','ws_release_a',true)")
        await expect(appClient.query('SELECT id FROM active_platform_media_specs')).resolves.toMatchObject({ rows: [{ id: approved.spec.id }] })
        await expect(appClient.query('SELECT id FROM platform_media_specs')).rejects.toThrow(/permission denied/u)
        await appClient.query('ROLLBACK')
      } finally { appClient.release() }

      const acl = await fresh.query(`SELECT
        has_table_privilege('merchant_app','platform_media_specs','SELECT') AS app_media_select,
        has_table_privilege('merchant_app','platform_media_specs','INSERT') AS app_media_insert,
        has_table_privilege('merchant_app','platform_media_spec_audit','SELECT') AS app_audit_select,
        has_table_privilege('merchant_app','active_platform_media_specs','SELECT') AS app_active_select,
        has_table_privilege('merchant_app','platform_mapping_preflight_approvals','SELECT,INSERT,UPDATE') AS app_mapping_write,
        has_table_privilege('merchant_app','platform_mapping_preflight_approvals','DELETE') AS app_mapping_delete,
        has_table_privilege('merchant_ops','platform_media_specs','SELECT,INSERT,UPDATE') AS ops_media_write,
        has_table_privilege('merchant_ops','platform_media_specs','DELETE') AS ops_media_delete,
        has_table_privilege('merchant_ops','platform_media_spec_audit','SELECT,INSERT') AS ops_audit_append,
        has_table_privilege('merchant_ops','platform_media_spec_audit','UPDATE') AS ops_audit_update,
        has_table_privilege('merchant_ops','active_platform_media_specs','SELECT') AS ops_active_select,
        has_table_privilege('merchant_ops','platform_mapping_preflight_approvals','SELECT') AS ops_mapping_select,
        has_function_privilege('merchant_ops','platform_media_spec_json_depth(jsonb)','EXECUTE') AS ops_json_validator,
        has_function_privilege('merchant_ops','protect_platform_media_spec_immutable_evidence()','EXECUTE') AS ops_trigger_function,
        has_function_privilege('merchant_app','platform_media_spec_scope_safe(text,integer)','EXECUTE') AS app_scope_validator`)
      expect(acl.rows[0]).toEqual({ app_media_select: false, app_media_insert: false, app_audit_select: false, app_active_select: true, app_mapping_write: true, app_mapping_delete: false, ops_media_write: true, ops_media_delete: false, ops_audit_append: true, ops_audit_update: false, ops_active_select: false, ops_mapping_select: false, ops_json_validator: true, ops_trigger_function: false, app_scope_validator: false })

      const mappingA = new PostgresMappingPreflightApprovalRepository(appA, () => new Date(releaseInstant))
      const mappingB = new PostgresMappingPreflightApprovalRepository(appB, () => new Date(releaseInstant))
      const baseApproval = { workspaceId: 'ws_release_a', platform: 'taobao' as const, productId: 'product-release', productVersion: 1, mappedPayloadHash: digest('c'), remoteSnapshotHash: digest('d'), schemaVersion: 'schema-v1', schemaEvidenceHash: digest('e'), mappingVersion: 'mapping-v1', mappingEvidenceHash: digest('f'), publishable: true, confirmationValid: true, externallyUnverified: false, findingCodes: [], evaluatedAt: releaseInstant, expiresAt, createdBy: 'release-reviewer' }
      await mappingA.upsert({ ...baseApproval, expectedRevision: 0 })
      const raced = await Promise.allSettled([mappingA.upsert({ ...baseApproval, mappedPayloadHash: digest('1'), expectedRevision: 1 }), mappingB.upsert({ ...baseApproval, mappedPayloadHash: digest('2'), expectedRevision: 1 })])
      expect(raced.filter(result => result.status === 'fulfilled')).toHaveLength(1)
      expect(raced.find(result => result.status === 'rejected')).toMatchObject({ reason: { code: 'MAPPING_PREFLIGHT_REVISION_CONFLICT' } })

      const probe = await fresh.connect()
      try {
        await probe.query('BEGIN'); await probe.query(`SET LOCAL ROLE "${probeRole}"`)
        await expect(probe.query('SELECT id FROM active_platform_media_specs')).rejects.toThrow(/permission denied/u)
        await probe.query('ROLLBACK')
      } finally { probe.release() }

      expect(await new MigrationRunner(upgrade, migrations.filter(item => item.version <= 63)).run()).toEqual(migrations.filter(item => item.version <= 63).map(item => item.version))
      expect(await new MigrationRunner(upgrade, migrations.filter(item => item.version >= 64)).run()).toEqual([64, 65, 66, 67])
      expect(await new MigrationRunner(upgrade, migrations).run()).toEqual([])
      expect(await schemaFingerprint(upgrade)).toEqual(await schemaFingerprint(fresh))

      await run('pg_dump', ['--format=custom', '--schema-only', '--no-owner', '--file', dumpPath, databaseUrl(base, freshName)])
      await run('pg_restore', ['--dbname', databaseUrl(base, restoreName), '--no-owner', dumpPath])
      expect(await schemaFingerprint(restored)).toEqual(await schemaFingerprint(fresh))
    } finally {
      await Promise.all([appA?.end(), appB?.end(), ops?.end()]); await Promise.all([fresh?.end(), upgrade?.end(), restored?.end()])
      for (const name of [freshName, upgradeName, restoreName]) { await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1', [name]); await admin.query(`DROP DATABASE IF EXISTS "${name}"`) }
      await admin.query(`DROP ROLE IF EXISTS "${probeRole}"`); await admin.end(); await rm(temporary, { recursive: true, force: true })
    }
  }, 240_000)
})
