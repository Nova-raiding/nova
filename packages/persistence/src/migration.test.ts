import { describe, expect, it } from 'vitest'
import { readFile, readdir } from 'node:fs/promises'
import { loadInitialMigration, loadMigrations, MigrationRunner, migrationChecksum } from './migration.js'
import { SqlClient, SqlPool } from './repository.js'

class MigrationClient implements SqlClient {
  readonly calls: Array<{ text: string; values?: readonly unknown[] }> = []
  constructor(private readonly alreadyApplied: number[] = []) {}
  async query<Row = Record<string, unknown>>(text: string, values?: readonly unknown[]) {
    this.calls.push({ text, values })
    if (text.startsWith('SELECT version')) return { rows: this.alreadyApplied.map(version => ({ version, name: version === 1 ? 'initial' : `migration_${version}`, checksum: null })) as Row[] }
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
    const latestVersion = migrations.at(-1)?.version ?? 0
    expect(latestVersion).toBe(130)
    expect(migrations.map(migration => migration.version)).toEqual(Array.from({ length: latestVersion }, (_, index) => index + 1))
    expect(migrations[1]?.sql).toContain('FORCE ROW LEVEL SECURITY')
    const byVersion = new Map(migrations.map(migration => [migration.version, migration]))
    expect(byVersion.get(100)).toMatchObject({ name: 'operation_alert_notifications' })
    expect(byVersion.get(101)).toMatchObject({ name: 'canonical_backfill_runs' })
    expect(byVersion.get(102)).toMatchObject({ name: 'canonical_backfill_conflicts' })
    expect(byVersion.get(103)).toMatchObject({ name: 'operation_alert_notification_acl' })
    expect(byVersion.get(104)).toMatchObject({ name: 'interactive_confirmation_tickets' })
    expect(byVersion.get(105)).toMatchObject({ name: 'durable_authorization_grants' })
    expect(byVersion.get(45)).toMatchObject({ name: 'platform_identity_lifecycle' })
    expect(byVersion.get(45)?.sql).toContain("current_setting('app.platform_scope', true) = 'platform_ops'")
    expect(byVersion.get(46)).toMatchObject({ name: 'model_usage_settlement' })
    expect(byVersion.get(46)?.sql).toContain('model_usage_ledger_workspace_receipt_key')
    expect(byVersion.get(47)).toMatchObject({ name: 'route_b_task_projection' })
    expect(byVersion.get(47)?.sql).toContain('tasks_campaign_item_scope_fk')
    expect(byVersion.get(48)).toMatchObject({ name: 'action_ledger_scope_links' })
    expect(byVersion.get(48)?.sql).toContain('model_usage_action_context_link')
    expect(byVersion.get(49)).toMatchObject({ name: 'legacy_snapshot_backfill' })
    expect(byVersion.get(49)?.sql).toContain("snapshot.entity_type = 'generation_job'")
    expect(byVersion.get(70)).toMatchObject({ name: 'product_asset_bindings' })
    expect(byVersion.get(70)?.sql).toContain('products_asset_bindings_sync')
    expect(byVersion.get(72)).toMatchObject({ name: 'product_asset_binding_integrity' })
    expect(byVersion.get(72)?.sql).toContain('validate_product_asset_binding_asset')
    expect(byVersion.get(72)?.sql).toContain("jsonb_typeof(NEW.data->'sourceAssetIds')")
    expect(byVersion.get(73)).toMatchObject({ name: 'ops_data_contracts' })
    expect(byVersion.get(73)?.sql).toContain('CREATE OR REPLACE VIEW ops_workspace_summaries')
    expect(byVersion.get(73)?.sql).toContain('workspace_commercial_settings_select_scope')
    expect(byVersion.get(73)?.sql).toContain('workspace_subscriptions_select_scope')
    expect(byVersion.get(74)).toMatchObject({ name: 'model_usage_context_links' })
    expect(byVersion.get(74)?.sql).toContain('model_usage_context_link_hash_fk')
    expect(byVersion.get(74)?.sql).toContain('model_usage_action_fk')
    expect(byVersion.get(74)?.sql).toContain('model_usage_action_context_columns')
    expect(byVersion.get(74)?.sql).toContain('DROP TRIGGER IF EXISTS model_usage_action_context_link')
    expect(byVersion.get(74)?.sql).not.toContain('NEW.metadata')
    expect(byVersion.get(75)).toMatchObject({ name: 'model_usage_action_lookup_index' })
    expect(byVersion.get(75)?.sql).toContain('model_usage_ledger_workspace_action_observed_idx')
    expect(byVersion.get(78)).toMatchObject({ name: 'asset_snapshot_binding_backfill' })
    expect(byVersion.get(78)?.sql).toContain('asset_snapshot_product_bindings_backfill')
    expect(byVersion.get(78)?.sql).toContain('UPDATE OF payload')
    expect(byVersion.get(80)).toMatchObject({ name: 'storage_quota' })
    expect(byVersion.get(80)?.sql).toContain('storage_quota_reservations')
    expect(byVersion.get(50)).toMatchObject({ name: 'payment_callback_nonces' })
    expect(byVersion.get(50)?.sql).toContain('payment_callback_nonces_workspace_isolation')
    expect(byVersion.get(51)).toMatchObject({ name: 'active_workspace_catalog' })
    expect(byVersion.get(51)?.sql).toContain('worker_active_workspace_catalog')
    expect(byVersion.get(52)).toMatchObject({ name: 'workspace_context_snapshots' })
    expect(byVersion.get(52)?.sql).toContain('ALTER COLUMN brand_id DROP NOT NULL')
    expect(byVersion.get(53)).toMatchObject({ name: 'terminal_generation_outbox_cleanup' })
    expect(byVersion.get(53)?.sql).toContain("job.state IN ('succeeded', 'failed')")
    expect(byVersion.get(54)).toMatchObject({ name: 'model_daily_cost_budget' })
    expect(byVersion.get(54)?.sql).toContain('model_cost_budget_reservations')
    expect(byVersion.get(55)).toMatchObject({ name: 'support_crm' })
    expect(byVersion.get(55)?.sql).toContain('workspace_support_tickets')
    expect(byVersion.get(56)).toMatchObject({ name: 'incidents' })
    expect(byVersion.get(56)?.sql).toContain('ops_incident_timeline')
    expect(byVersion.get(57)).toMatchObject({ name: 'feature_flags' })
    expect(byVersion.get(57)?.sql).toContain('platform_feature_flag_events')
    expect(byVersion.get(58)).toMatchObject({ name: 'finance_search_indexes' })
    expect(byVersion.get(58)?.sql).toContain('model_usage_finance_search_idx')
    expect(byVersion.get(59)).toMatchObject({ name: 'ops_audit_center' })
    expect(byVersion.get(59)?.sql).toContain('CREATE OR REPLACE VIEW ops_audit_center')
    expect(byVersion.get(60)).toMatchObject({ name: 'merchant_collection_pagination_indexes' })
    expect(byVersion.get(60)).toMatchObject({ transactional: false })
    expect(byVersion.get(60)?.sql).toContain('tasks_workspace_brand_created_id_idx')
    expect(byVersion.get(63)).toMatchObject({ name: 'product_listing_brand_canonical_integrity' })
    expect(byVersion.get(63)?.sql).toContain('product_listings_brand_canonical_fk')
    expect(byVersion.get(64)).toMatchObject({ name: 'workspace_identity_bootstrap' })
    expect(byVersion.get(64)?.sql).toContain('workspace_identity_bindings')
    expect(byVersion.get(66)).toMatchObject({ name: 'platform_media_spec_registry' })
    expect(byVersion.get(67)).toMatchObject({ name: 'platform_mapping_preflight_approvals' })
    expect(byVersion.get(68)).toMatchObject({ name: 'campaign_lifecycle_runtime_grants' })
    expect(byVersion.get(68)?.sql).toContain('GRANT SELECT, INSERT, UPDATE ON TABLE batch_campaigns, batch_campaign_items TO merchant_app')
    expect(byVersion.get(69)).toMatchObject({ name: 'platform_account_scope_integrity' })
    expect(byVersion.get(69)?.sql).toContain('assert_platform_account_scope')
    expect(byVersion.get(69)?.sql).toContain('products_platform_account_scope')
    expect(byVersion.get(70)).toMatchObject({ name: 'product_asset_bindings' })
    expect(byVersion.get(70)?.sql).toContain('product_asset_bindings_asset_idx')
    expect(byVersion.get(70)?.sql).toContain('sync_product_asset_bindings')
    expect(byVersion.get(70)?.sql).toContain('business_entity_snapshots asset')
    expect(byVersion.get(71)).toMatchObject({ name: 'runtime_integrity' })
    expect(byVersion.get(71)?.sql).toContain('commercial_rollouts_workspace_isolation')
    expect(byVersion.get(83)).toMatchObject({ name: 'billing_actor_attribution' })
    expect(byVersion.get(83)?.sql).toContain('billing_orders_workspace_actor_created_idx')
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

  it('ships one physical SQL file per migration version for the shell runner', async () => {
    const migrations = await loadMigrations()
    const files = (await readdir(new URL('./migrations/', import.meta.url)))
      .filter(file => /^\d{3}_.+\.sql$/.test(file))
      .sort()
    const versions = files.map(file => file.slice(0, 3))
    expect(new Set(versions).size).toBe(versions.length)
    expect(files).toEqual(migrations.map(migration => `${String(migration.version).padStart(3, '0')}_${migration.name}.sql`).sort())
    const shellRunner = await readFile(new URL('../../../infra/scripts/apply-migrations.sh', import.meta.url), 'utf8')
    expect(shellRunner).toContain('/migrations/[0-9][0-9][0-9]_*.sql')
    expect(shellRunner).toContain('schema_migrations')
    expect(shellRunner).toContain('pg_advisory')
    expect(files).toContain('049_legacy_snapshot_backfill.sql')
    expect(files).toContain('050_payment_callback_nonces.sql')
    expect(files).toContain('051_active_workspace_catalog.sql')
    expect(files).toContain('053_terminal_generation_outbox_cleanup.sql')
    expect(files).toContain('054_model_daily_cost_budget.sql')
    expect(files).toContain('055_support_crm.sql')
    expect(files).toContain('056_incidents.sql')
    expect(files).toContain('057_feature_flags.sql')
    expect(files).toContain('058_finance_search_indexes.sql')
    expect(files).toContain('059_ops_audit_center.sql')
    expect(files).toContain('060_merchant_collection_pagination_indexes.sql')
    expect(files).toContain('061_platform_control_plane_acl.sql')
    expect(files).toContain('062_remove_duplicate_pagination_index.sql')
    expect(files).toContain('063_product_listing_brand_canonical_integrity.sql')
    expect(files).toContain('064_workspace_identity_bootstrap.sql')
    expect(files).toContain('067_platform_mapping_preflight_approvals.sql')
    expect(files).toContain('069_platform_account_scope_integrity.sql')
    expect(files).toContain('070_product_asset_bindings.sql')
    expect(files).toContain('072_product_asset_binding_integrity.sql')
    expect(files).toContain('073_ops_data_contracts.sql')
    expect(files).toContain('078_asset_snapshot_binding_backfill.sql')
    expect(files).not.toContain('049_payment_callback_nonces.sql')
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

  it('backfills and maintains queryable action-to-task, campaign, and context links', async () => {
    const migration = (await loadMigrations()).find(item => item.version === 48)
    expect(migration).toMatchObject({ name: 'action_ledger_scope_links' })
    expect(migration?.sql).toContain("action.action_key = 'model:' || usage.idempotency_key")
    expect(migration?.sql).toContain('SET campaign_item_id = task.campaign_item_id')
    expect(migration?.sql).toContain("link.id = usage.metadata->>'context_link_id'")
    expect(migration?.sql).toContain('CREATE TRIGGER model_usage_action_context_link')
    expect(migration?.sql).toContain('action_ledger_task_scope_idx')
    expect(migration?.sql).toContain('action_ledger_campaign_item_scope_idx')
    expect(migration?.sql).toContain('action_ledger_context_scope_idx')
    expect(migration?.sql).not.toMatch(/DROP TABLE|TRUNCATE TABLE|DROP COLUMN/i)
  })

  it('runs migrations in order under a session lock and commits each version', async () => {
    const client = new MigrationClient()
    const pool: SqlPool = { connect: async () => client }
    const applied = await new MigrationRunner(pool, [
      { version: 2, name: 'second', sql: 'CREATE TABLE second_table (id integer)' },
      { version: 1, name: 'initial', sql: 'CREATE TABLE first_table (id integer)' },
    ]).run()
    expect(applied).toEqual([1, 2])
    expect(client.calls.map(call => call.text)).toEqual([
      'SELECT pg_advisory_lock($1)', expect.stringContaining('CREATE TABLE IF NOT EXISTS schema_migrations'), 'ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS checksum text', 'SELECT version, name, checksum FROM schema_migrations ORDER BY version ASC',
      'BEGIN', 'CREATE TABLE first_table (id integer)', 'INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)', 'COMMIT',
      'BEGIN', 'CREATE TABLE second_table (id integer)', 'INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)', 'COMMIT', 'SELECT pg_advisory_unlock($1)',
    ])
    expect(client.calls[0]?.values).toEqual([731942851])
    expect(client.calls[6]?.values).toEqual([1, 'initial', migrationChecksum('CREATE TABLE first_table (id integer)')])
  })

  it('executes top-level statements in a non-transactional migration one query at a time', async () => {
    const client = new MigrationClient()
    const pool: SqlPool = { connect: async () => client }
    const sql = `
CREATE INDEX CONCURRENTLY first_idx ON first_table ("id;column");
SELECT 'a;string and ''quoted;value''';
-- a top-level line-comment semicolon ; is not a statement boundary
/* an outer comment ; /* and a nested comment ; */ still precedes the function */
DO $migration$
BEGIN
  PERFORM 'a;function-string';
END;
$migration$;
CREATE INDEX CONCURRENTLY second_idx ON second_table (id);
`

    await expect(new MigrationRunner(pool, [
      { version: 60, name: 'concurrent_indexes', sql, transactional: false },
    ]).run()).resolves.toEqual([60])

    const migrationQueries = client.calls.slice(4, 8).map(call => call.text)
    expect(migrationQueries).toHaveLength(4)
    expect(migrationQueries[0]).toBe('CREATE INDEX CONCURRENTLY first_idx ON first_table ("id;column");')
    expect(migrationQueries[1]).toBe("SELECT 'a;string and ''quoted;value''';")
    expect(migrationQueries[2]).toContain('a top-level line-comment semicolon ;')
    expect(migrationQueries[2]).toContain('an outer comment ; /* and a nested comment ; */')
    expect(migrationQueries[2]).toContain("PERFORM 'a;function-string';")
    expect(migrationQueries[2]).toContain('END;\n$migration$;')
    expect(migrationQueries[3]).toBe('CREATE INDEX CONCURRENTLY second_idx ON second_table (id);')
  })

  it('loads 060 as four independently executable non-transactional statements', async () => {
    const migration = (await loadMigrations()).find(item => item.version === 60)!
    const client = new MigrationClient()
    const pool: SqlPool = { connect: async () => client }

    await new MigrationRunner(pool, [migration]).run()

    const concurrentQueries = client.calls.filter(call => call.text.includes('INDEX CONCURRENTLY'))
    expect(concurrentQueries).toHaveLength(4)
    expect(concurrentQueries.every(call => (call.text.match(/CREATE INDEX CONCURRENTLY/g) ?? []).length === 1)).toBe(true)
  })

  it('skips versions already recorded', async () => {
    const client = new MigrationClient([1])
    const pool: SqlPool = { connect: async () => client }
    expect(await new MigrationRunner(pool, [{ version: 1, name: 'initial', sql: 'SHOULD NOT RUN' }]).run()).toEqual([])
    expect(client.calls.some(call => call.text === 'SHOULD NOT RUN')).toBe(false)
  })
})
