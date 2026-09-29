import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { Pool } from 'pg'
import { describe, expect, it } from 'vitest'
import { repairLocal212Collision } from '../../../infra/scripts/repair-local-212-collision.js'
import { loadMigrations, MigrationRunner } from './migration.js'
import { dropDrainedPostgresFixture, withPostgresFixtureCleanup } from './postgres-scope-fixture-cleanup.js'

const baseUrl = process.env.PERSISTENCE_RELEASE_DATABASE_URL
const postgresIt = baseUrl ? it : it.skip
process.env.LOCAL_MIGRATION_212_COLLISION_APPROVED = 'true'
async function fixture(body: (pool: Pool, url: string) => Promise<void>) {
  const base = new URL(baseUrl!); const name = `release_211_${randomUUID().replaceAll('-', '')}`
  const admin = new Pool({ connectionString: base.toString() }); const target = new URL(base); target.pathname = `/${name}`
  let pool: Pool | undefined; let primaryFailure: unknown
  try {
    await admin.query(`CREATE DATABASE "${name}"`); pool = new Pool({ connectionString: target.toString() })
    await new MigrationRunner(pool, (await loadMigrations()).filter(m => m.version <= 211)).run()
    const old = (await readFile(new URL('./migrations/215_customer_delivery_account_binding.sql', import.meta.url), 'utf8')).replaceAll('pg_catalog, public, pg_temp', 'pg_catalog, public')
    await pool.query(old); await pool.query("INSERT INTO schema_migrations(version,name,checksum) VALUES(212,'customer_delivery_account_binding','eada99cb91760dcea0d26a771e281e9f7d3654e93ad3a4088c8af1ffa409aa66')")
    await body(pool, target.toString())
  } catch (e) { primaryFailure = e; throw e } finally {
    await withPostgresFixtureCleanup(async () => { await pool?.end(); await dropDrainedPostgresFixture(admin, name) }, primaryFailure, [() => admin.end()])
  }
}

describe('local 212 collision bridge', { timeout: 30_000 }, () => {
  it('requires explicit approval before connecting to any database', async () => {
    const previous = process.env.LOCAL_MIGRATION_212_COLLISION_APPROVED
    delete process.env.LOCAL_MIGRATION_212_COLLISION_APPROVED
    try {
      await expect(repairLocal212Collision('postgres://localhost/test_approval')).rejects.toThrow('LOCAL_212_BRIDGE_APPROVAL_REQUIRED')
    } finally {
      if (previous === undefined) delete process.env.LOCAL_MIGRATION_212_COLLISION_APPROVED
      else process.env.LOCAL_MIGRATION_212_COLLISION_APPROVED = previous
    }
  })

  postgresIt('converges exact legacy state', () => fixture(async (pool, url) => {
    await expect(repairLocal212Collision(url)).resolves.toEqual({ repaired: true, through: 215 })
    expect((await pool.query('SELECT version,name FROM schema_migrations WHERE version>=212 ORDER BY version')).rows).toEqual([
      { version: 212, name: 'customer_delivery_training_without_evidence' }, { version: 213, name: 'customer_delivery_manual_verification' },
      { version: 214, name: 'customer_delivery_archival' }, { version: 215, name: 'customer_delivery_account_binding' },
    ])
  }))
  postgresIt('rejects wrong checksum', () => fixture(async (pool, url) => {
    await pool.query("UPDATE schema_migrations SET checksum=repeat('0',64) WHERE version=212")
    await expect(repairLocal212Collision(url)).rejects.toThrow('LOCAL_212_BRIDGE_IDENTITY_MISMATCH')
  }))
  postgresIt('rejects missing catalog object', () => fixture(async (pool, url) => {
    await pool.query('DROP TRIGGER customer_delivery_account_binding_guard ON workspace_customer_deliveries')
    await expect(repairLocal212Collision(url)).rejects.toThrow('LOCAL_212_BRIDGE_CATALOG_MISMATCH')
  }))
  postgresIt('rejects existing binding', () => fixture(async (pool, url) => {
    await pool.query('ALTER TABLE workspace_customer_deliveries DISABLE TRIGGER ALL')
    await pool.query("INSERT INTO workspaces(id,status) VALUES('bridge_ws','active')")
    await pool.query("INSERT INTO workspace_customer_deliveries(id,workspace_id,company_name,payment_status,customer_profile_status,system_integration_status,functional_acceptance_status,training_completed,revision,created_by_actor_id,updated_by_actor_id,payment_evidence_refs,training_evidence_refs,target_account_id,target_identity_id) VALUES('d','bridge_ws','bridge','unpaid','incomplete','incomplete','incomplete',false,1,'a','a','{}','{}','00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000001')")
    await expect(repairLocal212Collision(url)).rejects.toThrow('LOCAL_212_BRIDGE_BOUND_DELIVERY_PRESENT')
  }))
  postgresIt('rejects concurrent bridge', () => fixture(async (pool, url) => {
    const held = await pool.connect(); try { await held.query('BEGIN'); await held.query('SELECT pg_advisory_xact_lock(731942851)'); await expect(repairLocal212Collision(url)).rejects.toThrow('LOCAL_212_BRIDGE_LOCK_BUSY') } finally { await held.query('ROLLBACK'); held.release() }
  }))
})
