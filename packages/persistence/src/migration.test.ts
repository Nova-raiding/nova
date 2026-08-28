import { describe, expect, it } from 'vitest'
import { loadInitialMigration, loadMigrations, MigrationRunner } from './migration.js'
import { SqlClient, SqlPool } from './repository.js'

class MigrationClient implements SqlClient {
  readonly calls: Array<{ text: string; values?: readonly unknown[] }> = []
  constructor(private readonly alreadyApplied: number[] = []) {}
  async query<Row = Record<string, unknown>>(text: string, values?: readonly unknown[]) {
    this.calls.push({ text, values })
    if (text.startsWith('SELECT version')) return { rows: this.alreadyApplied.map(version => ({ version })) as Row[] }
    return { rows: [] as Row[] }
  }
  release() {}
}

describe('MigrationRunner', () => {
  it('loads the executable 001 SQL asset', async () => {
    const migration = await loadInitialMigration()
    expect(migration).toMatchObject({ version: 1, name: 'initial' })
    expect(migration.sql).toContain('CREATE TABLE IF NOT EXISTS outbox_events')
    expect(migration.sql).toContain('CREATE POLICY outbox_events_workspace_isolation')
  })

  it('loads the ordered production migration set', async () => {
    const migrations = await loadMigrations()
    expect(migrations.map(migration => migration.version)).toEqual(Array.from({ length: 47 }, (_, index) => index + 1))
    expect(migrations[1]?.sql).toContain('FORCE ROW LEVEL SECURITY')
    expect(migrations.at(-3)).toMatchObject({ version: 45, name: 'platform_identity_lifecycle' })
    expect(migrations.at(-3)?.sql).toContain("current_setting('app.platform_scope', true) = 'platform_ops'")
    expect(migrations.at(-2)).toMatchObject({ version: 46, name: 'model_usage_settlement' })
    expect(migrations.at(-2)?.sql).toContain('model_usage_ledger_workspace_receipt_key')
    expect(migrations.at(-1)).toMatchObject({ version: 47, name: 'route_b_task_projection' })
    expect(migrations.at(-1)?.sql).toContain('tasks_campaign_item_scope_fk')
    expect(migrations[2]?.sql).toContain('lease_token')
    expect(migrations[3]?.sql).toContain('CREATE TABLE IF NOT EXISTS products')
    expect(migrations[3]?.name).toBe('business_entities')
    expect(migrations[3]?.sql).toContain('CREATE TABLE IF NOT EXISTS publish_jobs')
    expect(migrations[5]?.name).toBe('brand_assets')
    expect(migrations[6]?.name).toBe('multi_account_products')
    expect(migrations[7]?.name).toBe('rule_center')
    expect(migrations[7]?.sql).toContain('CREATE TABLE IF NOT EXISTS rule_pack_versions')
    expect(migrations[7]?.sql).toContain('rule_audit_events_append_only')
    expect(migrations[8]?.name).toBe('feedback')
    expect(migrations[8]?.sql).toContain('task_feedback_workspace_isolation')
    expect(migrations[9]?.name).toBe('workspace_rls')
    expect(migrations[9]?.sql).toContain('workspaces_workspace_isolation')
    expect(migrations[12]?.name).toBe('billing')
    expect(migrations[12]?.sql).toContain('CREATE TABLE IF NOT EXISTS billing_orders')
    expect(migrations[13]?.name).toBe('store_aliases')
    expect(migrations[13]?.sql).toContain('platform_accounts_store_alias_unique')
    expect(migrations[14]?.name).toBe('platform_authorization_health')
    expect(migrations[15]?.name).toBe('image_generation_jobs')
    expect(migrations[22]?.name).toBe('commercial_extensions')
    expect(migrations[23]?.name).toBe('subscription_order_commercial_snapshot')
    expect(migrations[24]?.name).toBe('growth_events')
    expect(migrations[25]?.name).toBe('operation_alerts')
    expect(migrations[26]?.name).toBe('data_deletion_requests')
    expect(migrations[27]?.name).toBe('data_deletion_approvals')
    expect(migrations[28]?.name).toBe('rule_effectivity')
    expect(migrations[29]?.name).toBe('data_deletion_execution_proof')
    expect(migrations[30]?.name).toBe('social_commerce_platforms')
    expect(migrations[30]?.sql).toContain('xiaohongshu')
    expect(migrations[31]?.name).toBe('automation_policies')
    expect(migrations[31]?.sql).toContain('automation_policy')
    expect(migrations[32]?.name).toBe('workspace_id_text')
    expect(migrations[32]?.sql).toContain('ALTER COLUMN workspace_id TYPE text')
    expect(migrations[32]?.sql).not.toContain('::uuid')
    expect(migrations[35]?.name).toBe('subscription_entitlements')
    expect(migrations[36]?.name).toBe('entitlement_consumptions')
    expect(migrations[37]?.name).toBe('action_ledger_kinds')
    expect(migrations[38]?.name).toBe('multi_brand_batch')
    expect(migrations[38]?.sql).toContain('CREATE TABLE IF NOT EXISTS brands')
    expect(migrations[39]?.name).toBe('force_commercial_settings_rls')
    expect(migrations[39]?.sql).toContain('ALTER TABLE workspace_commercial_settings FORCE ROW LEVEL SECURITY')
    expect(migrations[39]?.sql).toContain('ALTER TABLE workspace_platform_settings FORCE ROW LEVEL SECURITY')
    expect(migrations[14]?.sql).toContain('credential_metadata_observed_at')
    expect(migrations[10]?.name).toBe('sync_jobs')
    expect(migrations[10]?.sql).toContain("'sync_job'")
    expect(migrations[11]?.name).toBe('nullable_remote_product_id')
  })

  it('ships tenant-safe business schema assets with constraints and query indexes', async () => {
    const migration = (await loadMigrations())[3]!
    expect(migration.sql).toContain('UNIQUE (workspace_id, platform, remote_product_id)')
    expect(migration.sql).toContain('UNIQUE (workspace_id, idempotency_key)')
    expect(migration.sql).toContain('tasks_product_workspace_fk')
    expect(migration.sql).toContain('publish_jobs_content_version_workspace_fk')
    expect(migration.sql).toContain("WITH CHECK (workspace_id = current_setting('app.workspace_id', true))")
    for (const table of ['products', 'tasks', 'content_versions', 'publish_jobs']) {
      expect(migration.sql).toContain(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`)
      expect(migration.sql).toContain(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`)
      expect(migration.sql).toContain(`CREATE POLICY ${table}_workspace_isolation ON ${table}`)
    }
    for (const index of [
      'products_workspace_updated_idx',
      'tasks_workspace_state_idx',
      'content_versions_workspace_task_idx',
      'publish_jobs_dispatch_idx',
      'publish_jobs_workspace_state_idx',
      'publish_jobs_workspace_task_idx',
    ]) expect(migration.sql).toContain(index)
    expect(migration.sql).toContain('publish_observations_request_id_idx')
    expect(migration.sql).toContain('CREATE TABLE IF NOT EXISTS business_entity_snapshots')
    expect(migration.sql).toContain('business_entity_snapshots_workspace_type_idx')
    expect(migration.sql).toContain('business_entity_snapshots_workspace_isolation')
  })

  it('keeps every workspace-scoped migration compatible with opaque text tenant ids', async () => {
    const migrations = await loadMigrations()
    const laterSql = migrations.slice(16).map(migration => migration.sql).join('\n')
    expect(laterSql).not.toMatch(/workspace_id\s+UUID/i)
    expect(laterSql).not.toContain("current_setting('app.workspace_id', true)::uuid")
    expect(laterSql).toContain('workspace_id TEXT NOT NULL REFERENCES workspaces(id)')
    expect(migrations.find(migration => migration.version === 33)?.sql).toContain('workspace_id TYPE text')
    const workspaceTextMigration = migrations.find(migration => migration.version === 33)?.sql ?? ''
    expect(workspaceTextMigration.indexOf('DROP POLICY')).toBeGreaterThanOrEqual(0)
    expect(workspaceTextMigration.indexOf('DROP POLICY')).toBeLessThan(workspaceTextMigration.indexOf('ALTER TABLE %I ALTER COLUMN workspace_id TYPE text'))
  })

  it('does not narrow existing business snapshot rows during the social-platform migration', async () => {
    const migration = (await loadMigrations()).find(item => item.version === 31)
    expect(migration?.sql).toContain("'generation_job'")
    expect(migration?.sql).toContain("'image_generation_job'")
    expect(migration?.sql).toContain("'automation_policy'")
  })

  it('runs 001 in order and records the version in one transaction', async () => {
    const client = new MigrationClient()
    const pool: SqlPool = { connect: async () => client }
    const applied = await new MigrationRunner(pool, [
      { version: 2, name: 'second', sql: 'CREATE TABLE second_table (id integer)' },
      { version: 1, name: 'initial', sql: 'CREATE TABLE first_table (id integer)' },
    ]).run()
    expect(applied).toEqual([1, 2])
    expect(client.calls.map(call => call.text)).toEqual([
      'BEGIN', 'SELECT pg_advisory_xact_lock($1)', expect.stringContaining('CREATE TABLE IF NOT EXISTS schema_migrations'), 'SELECT version FROM schema_migrations ORDER BY version ASC',
      'CREATE TABLE first_table (id integer)', 'INSERT INTO schema_migrations (version, name) VALUES ($1, $2)',
      'CREATE TABLE second_table (id integer)', 'INSERT INTO schema_migrations (version, name) VALUES ($1, $2)', 'COMMIT',
    ])
    expect(client.calls[1]?.values).toEqual([731942851])
    expect(client.calls[5]?.values).toEqual([1, 'initial'])
  })

  it('skips versions already recorded', async () => {
    const client = new MigrationClient([1])
    const pool: SqlPool = { connect: async () => client }
    expect(await new MigrationRunner(pool, [{ version: 1, name: 'initial', sql: 'SHOULD NOT RUN' }]).run()).toEqual([])
    expect(client.calls.some(call => call.text === 'SHOULD NOT RUN')).toBe(false)
  })
})
