import { readFile } from 'node:fs/promises'
import { SqlPool } from './repository.js'

export interface Migration {
  version: number
  name: string
  sql: string
}

type MigrationRow = { version: number }

const migrationTable = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version integer PRIMARY KEY,
  name text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
)`
const MIGRATION_ADVISORY_LOCK = 731942851

/** Applies migrations in ascending version order in one deployment transaction. */
export class MigrationRunner {
  constructor(private readonly pool: SqlPool, private readonly migrations: readonly Migration[]) {}

  async run(): Promise<number[]> {
    const client = await this.pool.connect()
    const applied: number[] = []
    try {
      await client.query('BEGIN')
      // Serialize migration runners across API replicas. The lock is scoped
      // to this transaction and is released automatically on COMMIT/ROLLBACK.
      await client.query('SELECT pg_advisory_xact_lock($1)', [MIGRATION_ADVISORY_LOCK])
      await client.query(migrationTable)
      const result = await client.query<MigrationRow>('SELECT version FROM schema_migrations ORDER BY version ASC')
      const versions = new Set(result.rows.map(row => row.version))
      const pending = [...this.migrations].sort((a, b) => a.version - b.version)
      for (const migration of pending) {
        if (versions.has(migration.version)) continue
        await client.query(migration.sql)
        await client.query(
          'INSERT INTO schema_migrations (version, name) VALUES ($1, $2)',
          [migration.version, migration.name],
        )
        applied.push(migration.version)
      }
      await client.query('COMMIT')
      return applied
    } catch (error) {
      try { await client.query('ROLLBACK') } catch { /* preserve original error */ }
      throw error
    } finally {
      client.release?.()
    }
  }
}

/** Loads the executable SQL asset that is shipped beside the source module. */
export async function loadInitialMigration(): Promise<Migration> {
  const sql = await readFile(new URL('./migrations/001_initial.sql', import.meta.url), 'utf8')
  return { version: 1, name: 'initial', sql }
}

export async function loadMigrations(): Promise<Migration[]> {
  const initial = await loadInitialMigration()
  const forceRls = await readFile(new URL('./migrations/002_force_rls.sql', import.meta.url), 'utf8')
  const deliveryState = await readFile(new URL('./migrations/003_outbox_delivery_state.sql', import.meta.url), 'utf8')
  const businessEntities = await readFile(new URL('./migrations/004_business_entities.sql', import.meta.url), 'utf8')
  const generationJobs = await readFile(new URL('./migrations/005_generation_jobs.sql', import.meta.url), 'utf8')
  const brandAssets = await readFile(new URL('./migrations/006_brand_assets.sql', import.meta.url), 'utf8')
  const multiAccountProducts = await readFile(new URL('./migrations/007_multi_account_products.sql', import.meta.url), 'utf8')
  const ruleCenter = await readFile(new URL('./migrations/008_rule_center.sql', import.meta.url), 'utf8')
  const feedback = await readFile(new URL('./migrations/009_feedback.sql', import.meta.url), 'utf8')
  const workspaceRls = await readFile(new URL('./migrations/010_workspace_rls.sql', import.meta.url), 'utf8')
  const syncJobs = await readFile(new URL('./migrations/011_sync_jobs.sql', import.meta.url), 'utf8')
  const nullableRemoteProductId = await readFile(new URL('./migrations/012_nullable_remote_product_id.sql', import.meta.url), 'utf8')
  const billing = await readFile(new URL('./migrations/013_billing.sql', import.meta.url), 'utf8')
  const storeAliases = await readFile(new URL('./migrations/014_store_aliases.sql', import.meta.url), 'utf8')
  const platformAuthorizationHealth = await readFile(new URL('./migrations/015_platform_authorization_health.sql', import.meta.url), 'utf8')
  const imageGenerationJobs = await readFile(new URL('./migrations/016_image_generation_jobs.sql', import.meta.url), 'utf8')
  const commercialSettings = await readFile(new URL('./migrations/017_commercial_settings.sql', import.meta.url), 'utf8')
  const commercialPriceCny = await readFile(new URL('./migrations/018_commercial_price_cny.sql', import.meta.url), 'utf8')
  const usageLedger = await readFile(new URL('./migrations/019_usage_ledger.sql', import.meta.url), 'utf8')
  const operationAudit = await readFile(new URL('./migrations/020_operation_audit.sql', import.meta.url), 'utf8')
  const subscriptions = await readFile(new URL('./migrations/021_subscriptions.sql', import.meta.url), 'utf8')
  const workspaceMembers = await readFile(new URL('./migrations/022_workspace_members.sql', import.meta.url), 'utf8')
  const commercialExtensions = await readFile(new URL('./migrations/023_commercial_extensions.sql', import.meta.url), 'utf8')
  const subscriptionCommercialSnapshot = await readFile(new URL('./migrations/024_subscription_order_commercial_snapshot.sql', import.meta.url), 'utf8')
  const growthEvents = await readFile(new URL('./migrations/025_growth_events.sql', import.meta.url), 'utf8')
  const operationAlerts = await readFile(new URL('./migrations/026_operation_alerts.sql', import.meta.url), 'utf8')
  const dataDeletionRequests = await readFile(new URL('./migrations/027_data_deletion_requests.sql', import.meta.url), 'utf8')
  const dataDeletionApprovals = await readFile(new URL('./migrations/028_data_deletion_approvals.sql', import.meta.url), 'utf8')
  const ruleEffectivity = await readFile(new URL('./migrations/029_rule_effectivity.sql', import.meta.url), 'utf8')
  const dataDeletionExecutionProof = await readFile(new URL('./migrations/030_data_deletion_execution_proof.sql', import.meta.url), 'utf8')
  const socialCommercePlatforms = await readFile(new URL('./migrations/031_social_commerce_platforms.sql', import.meta.url), 'utf8')
  const automationPolicies = await readFile(new URL('./migrations/032_automation_policies.sql', import.meta.url), 'utf8')
  const workspaceIdText = await readFile(new URL('./migrations/033_workspace_id_text.sql', import.meta.url), 'utf8')
  const modelUsageLedger = await readFile(new URL('./migrations/034_model_usage_ledger.sql', import.meta.url), 'utf8')
  const actionLedger = await readFile(new URL('./migrations/035_action_ledger.sql', import.meta.url), 'utf8')
  const subscriptionEntitlements = await readFile(new URL('./migrations/036_subscription_entitlements.sql', import.meta.url), 'utf8')
  const entitlementConsumptions = await readFile(new URL('./migrations/037_entitlement_consumptions.sql', import.meta.url), 'utf8')
  const actionLedgerKinds = await readFile(new URL('./migrations/038_action_ledger_kinds.sql', import.meta.url), 'utf8')
  const multiBrandBatch = await readFile(new URL('./migrations/039_multi_brand_batch.sql', import.meta.url), 'utf8')
  const forceCommercialSettingsRls = await readFile(new URL('./migrations/040_force_commercial_settings_rls.sql', import.meta.url), 'utf8')
  const subscriptionPaymentCheckout = await readFile(new URL('./migrations/041_subscription_payment_checkout.sql', import.meta.url), 'utf8')
  const modelMarkupPolicy = await readFile(new URL('./migrations/042_model_markup_policy.sql', import.meta.url), 'utf8')
  const routeBExpand = await readFile(new URL('./migrations/043_route_b_expand.sql', import.meta.url), 'utf8')
  const platformWorkspaceDirectory = await readFile(new URL('./migrations/044_platform_workspace_directory.sql', import.meta.url), 'utf8')
  const platformIdentityLifecycle = await readFile(new URL('./migrations/045_platform_identity_lifecycle.sql', import.meta.url), 'utf8')
  const modelUsageSettlement = await readFile(new URL('./migrations/046_model_usage_settlement.sql', import.meta.url), 'utf8')
  const routeBTaskProjection = await readFile(new URL('./migrations/047_route_b_task_projection.sql', import.meta.url), 'utf8')
  return [
    initial,
    { version: 2, name: 'force_rls', sql: forceRls },
    { version: 3, name: 'outbox_delivery_state', sql: deliveryState },
    { version: 4, name: 'business_entities', sql: businessEntities },
    { version: 5, name: 'generation_jobs', sql: generationJobs },
    { version: 6, name: 'brand_assets', sql: brandAssets },
    { version: 7, name: 'multi_account_products', sql: multiAccountProducts },
    { version: 8, name: 'rule_center', sql: ruleCenter },
    { version: 9, name: 'feedback', sql: feedback },
    { version: 10, name: 'workspace_rls', sql: workspaceRls },
    { version: 11, name: 'sync_jobs', sql: syncJobs },
    { version: 12, name: 'nullable_remote_product_id', sql: nullableRemoteProductId },
    { version: 13, name: 'billing', sql: billing },
    { version: 14, name: 'store_aliases', sql: storeAliases },
    { version: 15, name: 'platform_authorization_health', sql: platformAuthorizationHealth },
    { version: 16, name: 'image_generation_jobs', sql: imageGenerationJobs },
    { version: 17, name: 'commercial_settings', sql: commercialSettings },
    { version: 18, name: 'commercial_price_cny', sql: commercialPriceCny },
    { version: 19, name: 'usage_ledger', sql: usageLedger },
    { version: 20, name: 'operation_audit', sql: operationAudit },
    { version: 21, name: 'subscriptions', sql: subscriptions },
    { version: 22, name: 'workspace_members', sql: workspaceMembers },
    { version: 23, name: 'commercial_extensions', sql: commercialExtensions },
    { version: 24, name: 'subscription_order_commercial_snapshot', sql: subscriptionCommercialSnapshot },
    { version: 25, name: 'growth_events', sql: growthEvents },
    { version: 26, name: 'operation_alerts', sql: operationAlerts },
    { version: 27, name: 'data_deletion_requests', sql: dataDeletionRequests },
    { version: 28, name: 'data_deletion_approvals', sql: dataDeletionApprovals },
    { version: 29, name: 'rule_effectivity', sql: ruleEffectivity },
    { version: 30, name: 'data_deletion_execution_proof', sql: dataDeletionExecutionProof },
    { version: 31, name: 'social_commerce_platforms', sql: socialCommercePlatforms },
    { version: 32, name: 'automation_policies', sql: automationPolicies },
    { version: 33, name: 'workspace_id_text', sql: workspaceIdText },
    { version: 34, name: 'model_usage_ledger', sql: modelUsageLedger },
    { version: 35, name: 'action_ledger', sql: actionLedger },
    { version: 36, name: 'subscription_entitlements', sql: subscriptionEntitlements },
    { version: 37, name: 'entitlement_consumptions', sql: entitlementConsumptions },
    { version: 38, name: 'action_ledger_kinds', sql: actionLedgerKinds },
    { version: 39, name: 'multi_brand_batch', sql: multiBrandBatch },
    { version: 40, name: 'force_commercial_settings_rls', sql: forceCommercialSettingsRls },
    { version: 41, name: 'subscription_payment_checkout', sql: subscriptionPaymentCheckout },
    { version: 42, name: 'model_markup_policy', sql: modelMarkupPolicy },
    { version: 43, name: 'route_b_expand', sql: routeBExpand },
    { version: 44, name: 'platform_workspace_directory', sql: platformWorkspaceDirectory },
    { version: 45, name: 'platform_identity_lifecycle', sql: platformIdentityLifecycle },
    { version: 46, name: 'model_usage_settlement', sql: modelUsageSettlement },
    { version: 47, name: 'route_b_task_projection', sql: routeBTaskProjection },
  ]
}

export async function runMigrations(pool: SqlPool, migrations: readonly Migration[]): Promise<number[]> {
  return new MigrationRunner(pool, migrations).run()
}
