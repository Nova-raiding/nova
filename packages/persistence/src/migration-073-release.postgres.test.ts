import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { describe, expect, it } from 'vitest'
import { loadMigrations, MigrationRunner } from './migration.js'
import { PostgresOpsDataRepository } from './ops-data-repository.js'

const databaseUrlValue = process.env.PERSISTENCE_RELEASE_DATABASE_URL
const postgresIt = databaseUrlValue ? it : it.skip

function databaseUrl(base: URL, name: string, user?: string, password?: string) {
  const result = new URL(base)
  result.pathname = `/${name}`
  if (user) result.username = user
  if (password) result.password = password
  return result.toString()
}

async function seed(pool: Pool) {
  await pool.query(`INSERT INTO workspaces (id,status,created_at) VALUES
    ('ws_ops_default','active','2026-08-28T00:00:00Z'),
    ('ws_ops_configured','disabled','2026-08-29T00:00:00Z')`)
  await pool.query(`INSERT INTO workspace_commercial_settings
    (workspace_id,plan_name,monthly_tasks_used,included_tasks,monthly_price_cny)
    VALUES ('ws_ops_configured','Growth',12,80,499)`)
  await pool.query(`INSERT INTO workspace_subscriptions (workspace_id,status,plan_code,plan_name)
    VALUES ('ws_ops_configured','active','growth','Growth')`)
  await pool.query(`INSERT INTO workspace_members (id,workspace_id,external_subject,role,status,invited_by) VALUES
    ('00000000-0000-0000-0000-000000000731','ws_ops_configured','actor_ops_1','workspace_owner','active','release-test'),
    ('00000000-0000-0000-0000-000000000732','ws_ops_configured','actor_ops_2','operator','active','release-test')`)
}

async function grantRuntimeBaseline(pool: Pool) {
  await pool.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
    workspaces, workspace_commercial_settings, workspace_subscriptions, workspace_members
    TO merchant_app`)
}

describe('migration 073 PostgreSQL release acceptance', () => {
  postgresIt('supports fresh/072 upgrade, empty state, idempotency, platform reads, tenant writes, and ACL', async () => {
    const base = new URL(databaseUrlValue!)
    const suffix = randomUUID().replaceAll('-', '')
    const freshName = `release_073_fresh_${suffix}`
    const upgradeName = `release_073_upgrade_${suffix}`
    const admin = new Pool({ connectionString: base.toString() })
    let fresh: Pool | undefined
    let upgrade: Pool | undefined
    let app: Pool | undefined

    try {
      await admin.query(`CREATE DATABASE "${freshName}"`)
      await admin.query(`CREATE DATABASE "${upgradeName}"`)
      fresh = new Pool({ connectionString: databaseUrl(base, freshName) })
      upgrade = new Pool({ connectionString: databaseUrl(base, upgradeName) })
      const migrations = (await loadMigrations()).filter(item => item.version <= 73)
      const through72 = migrations.filter(item => item.version <= 72)

      expect(await new MigrationRunner(fresh, migrations).run()).toEqual(migrations.map(item => item.version))
      expect(await new MigrationRunner(fresh, migrations).run()).toEqual([])
      await expect(fresh.query(`SELECT count(*)::int AS count, min(version)::int AS min, max(version)::int AS max
        FROM schema_migrations`)).resolves.toMatchObject({
        rows: [{ count: 73, min: 1, max: 73 }],
      })
      await grantRuntimeBaseline(fresh)
      app = new Pool({ connectionString: databaseUrl(base, freshName, 'merchant_app', 'merchant_app_local_only') })
      await expect(new PostgresOpsDataRepository(app).listWorkspaceSummaries()).resolves.toEqual([])

      await seed(fresh)
      await expect(new PostgresOpsDataRepository(app).listWorkspaceSummaries()).resolves.toEqual([
        {
          workspaceId: 'ws_ops_configured', status: 'disabled', planName: 'Growth', monthlyPriceCny: 499,
          usedTasks: 12, includedTasks: 80, subscriptionStatus: 'active', memberCount: 2,
        },
        {
          workspaceId: 'ws_ops_default', status: 'active', planName: 'Starter', monthlyPriceCny: 199,
          usedTasks: 0, includedTasks: 30, subscriptionStatus: 'trialing', memberCount: 0,
        },
      ])

      const tenant = await app.connect()
      try {
        await tenant.query('BEGIN')
        await tenant.query("SELECT set_config('app.workspace_id','ws_ops_default',true)")
        const scoped = await tenant.query('SELECT workspace_id FROM ops_workspace_summaries ORDER BY workspace_id')
        expect(scoped.rows).toEqual([{ workspace_id: 'ws_ops_default' }])
        await expect(tenant.query(`INSERT INTO workspace_commercial_settings (workspace_id)
          VALUES ('ws_ops_configured')`)).rejects.toMatchObject({ code: '42501' })
        await tenant.query('ROLLBACK')

        await tenant.query('BEGIN')
        await tenant.query("SELECT set_config('app.platform_scope','platform_ops',true)")
        await expect(tenant.query(`UPDATE workspace_subscriptions SET status='cancelled'
          WHERE workspace_id='ws_ops_configured'`)).resolves.toMatchObject({ rowCount: 0 })
        await tenant.query('ROLLBACK')
      } finally {
        tenant.release()
      }

      const acl = await fresh.query(`SELECT
        has_table_privilege('merchant_app','ops_workspace_summaries','SELECT') AS app_select,
        has_table_privilege('merchant_app','ops_workspace_summaries','INSERT') AS app_insert,
        has_table_privilege('merchant_ops','ops_workspace_summaries','SELECT') AS ops_select`)
      expect(acl.rows[0]).toEqual({ app_select: true, app_insert: false, ops_select: false })

      const opsProbe = await fresh.connect()
      try {
        await opsProbe.query('BEGIN')
        await opsProbe.query('SET LOCAL ROLE merchant_ops')
        await expect(opsProbe.query('SELECT workspace_id FROM ops_workspace_summaries')).rejects.toMatchObject({ code: '42501' })
        await opsProbe.query('ROLLBACK')
        await opsProbe.query('BEGIN')
        await opsProbe.query('SET LOCAL ROLE merchant_ops')
        await expect(opsProbe.query('SELECT workspace_id FROM workspace_commercial_settings')).rejects.toMatchObject({ code: '42501' })
        await opsProbe.query('ROLLBACK')
      } finally {
        opsProbe.release()
      }

      expect(await new MigrationRunner(upgrade, through72).run()).toEqual(through72.map(item => item.version))
      await grantRuntimeBaseline(upgrade)
      await seed(upgrade)
      expect(await new MigrationRunner(upgrade, migrations).run()).toEqual([73])
      expect(await new MigrationRunner(upgrade, migrations).run()).toEqual([])
      await expect(upgrade.query(`SELECT count(*)::int AS count, min(version)::int AS min, max(version)::int AS max
        FROM schema_migrations`)).resolves.toMatchObject({
        rows: [{ count: 73, min: 1, max: 73 }],
      })
      const upgradeClient = await upgrade.connect()
      try {
        await upgradeClient.query('BEGIN')
        await upgradeClient.query("SELECT set_config('app.platform_scope','platform_ops',true)")
        const upgradedRows = await upgradeClient.query('SELECT workspace_id, plan_name FROM ops_workspace_summaries ORDER BY workspace_id')
        expect(upgradedRows.rows).toEqual([
          { workspace_id: 'ws_ops_configured', plan_name: 'Growth' },
          { workspace_id: 'ws_ops_default', plan_name: 'Starter' },
        ])
        await upgradeClient.query('ROLLBACK')
      } finally {
        upgradeClient.release()
      }
    } finally {
      await app?.end()
      await Promise.all([fresh?.end(), upgrade?.end()])
      for (const name of [freshName, upgradeName]) {
        await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1', [name])
        await admin.query(`DROP DATABASE IF EXISTS "${name}"`)
      }
      await admin.end()
    }
  }, 240_000)
})
