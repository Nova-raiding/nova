import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { describe, expect, it } from 'vitest'
import { loadMigrations, MigrationRunner } from './migration.js'

const databaseUrlValue = process.env.PERSISTENCE_RELEASE_DATABASE_URL
const postgresIt = databaseUrlValue ? it : it.skip

const connection = (base: URL, database: string, user?: string, password?: string) => {
  const url = new URL(base)
  url.pathname = `/${database}`
  if (user) url.username = user
  if (password) url.password = password
  return url.toString()
}

describe('merchant_ops workspace summary RLS boundary', () => {
  postgresIt('exposes only the approved aggregate view and rejects customer detail tables', async () => {
    const base = new URL(databaseUrlValue!)
    const databaseName = `probe_ops_summary_${randomUUID().replaceAll('-', '')}`
    const admin = new Pool({ connectionString: base.toString() })
    let database: Pool | undefined
    let ops: Pool | undefined

    try {
      await admin.query(`CREATE DATABASE "${databaseName}"`)
      database = new Pool({ connectionString: connection(base, databaseName) })
      const migrations = await loadMigrations()
      expect(await new MigrationRunner(database, migrations).run()).toEqual(migrations.map(item => item.version))

      await database.query(`
        INSERT INTO workspaces (id, status) VALUES
          ('ops_summary_a', 'active'), ('ops_summary_b', 'active')
      `)
      await database.query(`
        INSERT INTO workspace_commercial_settings
          (workspace_id, plan_code, plan_name, monthly_price_cny, included_tasks)
        VALUES ('ops_summary_a', 'pro', 'Pro', 399, 100), ('ops_summary_b', 'starter', 'Starter', 199, 30)
      `)
      await database.query(`
        INSERT INTO workspace_subscriptions (workspace_id, status, plan_code, plan_name)
        VALUES ('ops_summary_a', 'active', 'pro', 'Pro'), ('ops_summary_b', 'trialing', 'trial', 'Trial')
      `)
      await database.query(`
        INSERT INTO products
          (id, workspace_id, platform, store_name, remote_product_id, title, source)
        VALUES ('ops_summary_product_a', 'ops_summary_a', 'taobao', 'A store', 'remote-a', 'Customer detail A', 'fixture')
      `)
      await database.query(`
        INSERT INTO tasks (id, workspace_id, product_id, platform, state)
        VALUES ('ops_summary_task_a', 'ops_summary_a', 'ops_summary_product_a', 'taobao', 'draft')
      `)
      await database.query(`
        INSERT INTO content_versions
          (id, workspace_id, task_id, version, body, state, created_by)
        VALUES ('ops_summary_content_a', 'ops_summary_a', 'ops_summary_task_a', 1,
          '{"body":"private customer正文"}'::jsonb, 'draft', 'probe')
      `)

      ops = new Pool({ connectionString: connection(base, databaseName, 'merchant_ops', 'merchant_ops_local_only'), max: 1 })

      await ops.query('BEGIN')
      await ops.query("SELECT set_config('app.platform_scope', 'platform_ops', true)")
      const summary = await ops.query<{ workspace_id: string; plan_name: string; member_count: number }>(
        'SELECT workspace_id, plan_name, member_count FROM ops_workspace_summaries ORDER BY workspace_id',
      )
      expect(summary.rows).toEqual([
        { workspace_id: 'ops_summary_a', plan_name: 'Pro', member_count: 0 },
        { workspace_id: 'ops_summary_b', plan_name: 'Starter', member_count: 0 },
      ])

      // Platform scope is not a blanket customer-data grant. The ops role has
      // no direct privilege on customer product/content tables.
      for (const table of ['products', 'tasks', 'content_versions']) {
        await expect(ops.query(`SELECT * FROM ${table}`)).rejects.toMatchObject({ code: '42501' })
      }
      await ops.query('COMMIT')

      const customerTableAcl = await database.query<{ table_name: string; can_select: boolean }>(`
        SELECT table_name, has_table_privilege('merchant_ops', table_name, 'SELECT') AS can_select
        FROM unnest(ARRAY['products', 'tasks', 'content_versions']::text[]) AS tables(table_name)
        ORDER BY table_name
      `)
      expect(customerTableAcl.rows).toEqual([
        { table_name: 'content_versions', can_select: false },
        { table_name: 'products', can_select: false },
        { table_name: 'tasks', can_select: false },
      ])
    } finally {
      await ops?.end()
      await database?.end()
      await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1', [databaseName])
      await admin.query(`DROP DATABASE IF EXISTS "${databaseName}"`)
      await admin.end()
    }
  }, 240_000)
})
