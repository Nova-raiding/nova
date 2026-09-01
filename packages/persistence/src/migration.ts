import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { SqlPool } from './repository.js'

export interface Migration {
  version: number
  name: string
  sql: string
  transactional?: boolean
}

export interface AppliedMigration {
  version: number
  name: string
  checksum?: string | null
}

type MigrationRow = AppliedMigration

const migrationTable = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version integer PRIMARY KEY,
  name text NOT NULL,
  checksum text,
  applied_at timestamptz NOT NULL DEFAULT now()
)`
const MIGRATION_ADVISORY_LOCK = 731942851
// Preserve the immutable pre-commercial 144 artifact while migration 148
// performs the forward-only reservation hardening.
const LEGACY_MIGRATION_CHECKSUMS = new Map<number, ReadonlySet<string>>([
  [144, new Set(['9519b2dbee21371a0bc7429c50e61ab3a677a4fd3965707328bd18489f2ad2e7'])],
])

export type MigrationIntegrityErrorCode = 'MIGRATION_NAME_MISMATCH' | 'MIGRATION_CHECKSUM_MISMATCH' | 'MIGRATION_VERSION_UNKNOWN' | 'MIGRATION_DUPLICATE_VERSION' | 'MIGRATION_VERSION_INVALID'

export class MigrationIntegrityError extends Error {
  constructor(
    readonly code: MigrationIntegrityErrorCode,
    readonly version: number,
    message: string,
  ) {
    super(message)
    this.name = 'MigrationIntegrityError'
  }
}

/** Computes the release-stable digest stored with an applied migration. */
export function migrationChecksum(sql: string): string {
  return createHash('sha256').update(sql, 'utf8').digest('hex')
}

/**
 * Verifies the immutable identity of rows already recorded in schema_migrations.
 * A null checksum is intentionally accepted for one-time legacy backfill.
 */
export function verifyAppliedMigrations(
  applied: readonly AppliedMigration[],
  expected: readonly Migration[],
): void {
  const assertVersion = (version: number): void => {
    if (!Number.isInteger(version) || version < 1) {
      throw new MigrationIntegrityError('MIGRATION_VERSION_INVALID', version, `migration version must be a positive integer: ${String(version)}`)
    }
  }
  const expectedVersions = new Set<number>()
  for (const migration of expected) {
    assertVersion(migration.version)
    if (expectedVersions.has(migration.version)) {
      throw new MigrationIntegrityError('MIGRATION_DUPLICATE_VERSION', migration.version, `release contains duplicate migration version ${migration.version}`)
    }
    expectedVersions.add(migration.version)
  }
  const appliedVersions = new Set<number>()
  for (const row of applied) {
    assertVersion(row.version)
    if (appliedVersions.has(row.version)) {
      throw new MigrationIntegrityError('MIGRATION_DUPLICATE_VERSION', row.version, `migration history contains duplicate version ${row.version}`)
    }
    appliedVersions.add(row.version)
  }
  const expectedByVersion = new Map(expected.map(migration => [migration.version, migration]))
  const orderedVersions = [...expectedByVersion.keys()].sort((left, right) => left - right)
  const completeChain = orderedVersions[0] === 1 && orderedVersions.every((version, index) => version === index + 1)
  for (const row of applied) {
    const migration = expectedByVersion.get(row.version)
    // Callers may intentionally run a filtered migration slice in upgrade
    // fixtures. Those historical rows remain owned by the same database and
    // must not make a later slice fail before it can be applied.
    if (!migration) {
      // A complete release run owns the whole version history. Silently
      // ignoring a future/foreign row can make an incompatible database look
      // upgradeable. Filtered prefix/single-version runners remain supported
      // for isolated upgrade fixtures and controlled repair operations.
      if (completeChain) throw new MigrationIntegrityError('MIGRATION_VERSION_UNKNOWN', row.version, `migration ${row.version} is not present in this release`)
      continue
    }
    // Version 014 was published under the historical name
    // `read_only_schedules` before the store-alias SQL was consolidated. The
    // 071 repair migration makes the schema converge; preserve that recorded
    // name instead of rewriting history, but never accept a non-null checksum
    // for the legacy alias.
    const legacy014Alias = row.version === 14 && row.name === 'read_only_schedules' && row.checksum == null
    if (row.name !== migration.name && !legacy014Alias) {
      throw new MigrationIntegrityError('MIGRATION_NAME_MISMATCH', row.version, `migration ${row.version} name mismatch: database=${row.name}, release=${migration.name}`)
    }
    if (row.checksum != null && row.checksum !== migrationChecksum(migration.sql) && !LEGACY_MIGRATION_CHECKSUMS.get(row.version)?.has(row.checksum)) {
      throw new MigrationIntegrityError('MIGRATION_CHECKSUM_MISMATCH', row.version, `migration ${row.version} checksum mismatch: database=${row.checksum}, release=${migrationChecksum(migration.sql)}`)
    }
  }
  if (completeChain) {
    const highestApplied = Math.max(0, ...appliedVersions)
    for (let version = 1; version <= highestApplied; version += 1) {
      if (!appliedVersions.has(version)) throw new MigrationIntegrityError('MIGRATION_VERSION_UNKNOWN', version, `migration history is missing version ${version}`)
    }
  }
}

/**
 * Splits a PostgreSQL script only at top-level semicolons. Quoted strings,
 * identifiers, dollar-quoted function bodies, and nested comments stay intact.
 */
export function splitTopLevelSqlStatements(sql: string): string[] {
  const statements: string[] = []
  let statementStart = 0
  let index = 0

  const failUnterminated = (kind: string): never => {
    throw new Error(`Unterminated ${kind} in non-transactional migration SQL`)
  }

  while (index < sql.length) {
    const current = sql[index]
    const next = sql[index + 1]

    if (current === '-' && next === '-') {
      const newline = sql.indexOf('\n', index + 2)
      index = newline === -1 ? sql.length : newline + 1
      continue
    }

    if (current === '/' && next === '*') {
      let depth = 1
      index += 2
      while (index < sql.length && depth > 0) {
        if (sql[index] === '/' && sql[index + 1] === '*') {
          depth += 1
          index += 2
        } else if (sql[index] === '*' && sql[index + 1] === '/') {
          depth -= 1
          index += 2
        } else {
          index += 1
        }
      }
      if (depth > 0) failUnterminated('block comment')
      continue
    }

    if (current === "'") {
      const previous = sql[index - 1]
      const previousTwo = sql.slice(Math.max(0, index - 2), index).toUpperCase()
      const prefixBoundary = index < 2 || !/[A-Za-z0-9_$]/.test(sql[index - 2] ?? '')
      const backslashEscapes = (previous?.toUpperCase() === 'E' && prefixBoundary)
        || (previousTwo === 'U&' && (index < 3 || !/[A-Za-z0-9_$]/.test(sql[index - 3] ?? '')))
      index += 1
      let closed = false
      while (index < sql.length) {
        if (backslashEscapes && sql[index] === '\\') {
          index += 2
        } else if (sql[index] === "'" && sql[index + 1] === "'") {
          index += 2
        } else if (sql[index] === "'") {
          index += 1
          closed = true
          break
        } else {
          index += 1
        }
      }
      if (!closed) failUnterminated('string literal')
      continue
    }

    if (current === '"') {
      index += 1
      let closed = false
      while (index < sql.length) {
        if (sql[index] === '"' && sql[index + 1] === '"') {
          index += 2
        } else if (sql[index] === '"') {
          index += 1
          closed = true
          break
        } else {
          index += 1
        }
      }
      if (!closed) failUnterminated('quoted identifier')
      continue
    }

    if (current === '$' && (index === 0 || !/[A-Za-z0-9_$]/.test(sql[index - 1] ?? ''))) {
      const delimiter = sql.slice(index).match(/^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/)?.[0]
      if (delimiter) {
        const closingIndex = sql.indexOf(delimiter, index + delimiter.length)
        if (closingIndex === -1) failUnterminated(`dollar quote ${delimiter}`)
        index = closingIndex + delimiter.length
        continue
      }
    }

    if (current === ';') {
      const statement = sql.slice(statementStart, index + 1).trim()
      if (statement) statements.push(statement)
      statementStart = index + 1
    }
    index += 1
  }

  const tail = sql.slice(statementStart).trim()
  if (tail) statements.push(tail)
  return statements
}

/** Applies migrations in ascending version order in one deployment transaction. */
export class MigrationRunner {
  constructor(private readonly pool: SqlPool, private readonly migrations: readonly Migration[]) {}

  async run(): Promise<number[]> {
    const client = await this.pool.connect()
    const applied: number[] = []
    try {
      await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_ADVISORY_LOCK])
      await client.query(migrationTable)
      // Existing deployments may have created schema_migrations without checksum.
      // Keep the column nullable so this compatibility upgrade never rewrites the
      // historical migration chain or requires a new migration version.
      await client.query('ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS checksum text')
      const result = await client.query<MigrationRow>('SELECT version, name, checksum FROM schema_migrations ORDER BY version ASC')
      verifyAppliedMigrations(result.rows, this.migrations)
      const versions = new Set(result.rows.map(row => row.version))
      const pending = [...this.migrations].sort((a, b) => a.version - b.version)
      for (const row of result.rows) {
        if (row.checksum == null && !(row.version === 14 && row.name === 'read_only_schedules')) {
          const migration = pending.find(item => item.version === row.version)
          if (migration) await client.query('UPDATE schema_migrations SET checksum = $1 WHERE version = $2 AND checksum IS NULL', [migrationChecksum(migration.sql), row.version])
        }
      }
      for (const migration of pending) {
        if (versions.has(migration.version)) continue
        const checksum = migrationChecksum(migration.sql)
        if (migration.transactional === false) {
          for (const statement of splitTopLevelSqlStatements(migration.sql)) {
            await client.query(statement)
          }
          await client.query('BEGIN')
          await client.query('INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)', [migration.version, migration.name, checksum])
          await client.query('COMMIT')
        } else {
          await client.query('BEGIN')
          await client.query(migration.sql)
          await client.query('INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)', [migration.version, migration.name, checksum])
          await client.query('COMMIT')
        }
        applied.push(migration.version)
      }
      await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_ADVISORY_LOCK])
      return applied
    } catch (error) {
      try { await client.query('ROLLBACK') } catch { /* preserve original error */ }
      try { await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_ADVISORY_LOCK]) } catch { /* release also unlocks */ }
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
  const workspaceOperationAuditTruncateGuard = await readFile(new URL('./migrations/136_workspace_operation_audit_truncate_guard.sql', import.meta.url), 'utf8')
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
  const actionLedgerScopeLinks = await readFile(new URL('./migrations/048_action_ledger_scope_links.sql', import.meta.url), 'utf8')
  const legacySnapshotBackfill = await readFile(new URL('./migrations/049_legacy_snapshot_backfill.sql', import.meta.url), 'utf8')
  const paymentCallbackNonces = await readFile(new URL('./migrations/050_payment_callback_nonces.sql', import.meta.url), 'utf8')
  const activeWorkspaceCatalog = await readFile(new URL('./migrations/051_active_workspace_catalog.sql', import.meta.url), 'utf8')
  const workspaceContextSnapshots = await readFile(new URL('./migrations/052_workspace_context_snapshots.sql', import.meta.url), 'utf8')
  const terminalGenerationOutboxCleanup = await readFile(new URL('./migrations/053_terminal_generation_outbox_cleanup.sql', import.meta.url), 'utf8')
  const modelDailyCostBudget = await readFile(new URL('./migrations/054_model_daily_cost_budget.sql', import.meta.url), 'utf8')
  const supportCrm = await readFile(new URL('./migrations/055_support_crm.sql', import.meta.url), 'utf8')
  const incidents = await readFile(new URL('./migrations/056_incidents.sql', import.meta.url), 'utf8')
  const featureFlags = await readFile(new URL('./migrations/057_feature_flags.sql', import.meta.url), 'utf8')
  const financeSearchIndexes = await readFile(new URL('./migrations/058_finance_search_indexes.sql', import.meta.url), 'utf8')
  const opsAuditCenter = await readFile(new URL('./migrations/059_ops_audit_center.sql', import.meta.url), 'utf8')
  const merchantCollectionPaginationIndexes = await readFile(new URL('./migrations/060_merchant_collection_pagination_indexes.sql', import.meta.url), 'utf8')
  const platformControlPlaneAcl = await readFile(new URL('./migrations/061_platform_control_plane_acl.sql', import.meta.url), 'utf8')
  const removeDuplicatePaginationIndex = await readFile(new URL('./migrations/062_remove_duplicate_pagination_index.sql', import.meta.url), 'utf8')
  const productListingBrandCanonicalIntegrity = await readFile(new URL('./migrations/063_product_listing_brand_canonical_integrity.sql', import.meta.url), 'utf8')
  const workspaceIdentityBootstrap = await readFile(new URL('./migrations/064_workspace_identity_bootstrap.sql', import.meta.url), 'utf8')
  const assetParseLeases = await readFile(new URL('./migrations/065_asset_parse_leases.sql', import.meta.url), 'utf8')
  const platformMediaSpecRegistry = await readFile(new URL('./migrations/066_platform_media_spec_registry.sql', import.meta.url), 'utf8')
  const platformMappingPreflightApprovals = await readFile(new URL('./migrations/067_platform_mapping_preflight_approvals.sql', import.meta.url), 'utf8')
  const campaignLifecycleRuntimeGrants = await readFile(new URL('./migrations/068_campaign_lifecycle_runtime_grants.sql', import.meta.url), 'utf8')
  const platformAccountScopeIntegrity = await readFile(new URL('./migrations/069_platform_account_scope_integrity.sql', import.meta.url), 'utf8')
  const productAssetBindings = await readFile(new URL('./migrations/070_product_asset_bindings.sql', import.meta.url), 'utf8')
  const runtimeIntegrity = await readFile(new URL('./migrations/071_runtime_integrity.sql', import.meta.url), 'utf8')
  const productAssetBindingIntegrity = await readFile(new URL('./migrations/072_product_asset_binding_integrity.sql', import.meta.url), 'utf8')
  const opsDataContracts = await readFile(new URL('./migrations/073_ops_data_contracts.sql', import.meta.url), 'utf8')
  const modelUsageContextLinks = await readFile(new URL('./migrations/074_model_usage_context_links.sql', import.meta.url), 'utf8')
  const modelUsageActionLookupIndex = await readFile(new URL('./migrations/075_model_usage_action_lookup_index.sql', import.meta.url), 'utf8')
  const canonicalProductBackfillIndex = await readFile(new URL('./migrations/076_canonical_product_backfill_index.sql', import.meta.url), 'utf8')
  const canonicalPublishScopeIntegrity = await readFile(new URL('./migrations/077_canonical_publish_scope_integrity.sql', import.meta.url), 'utf8')
  const assetSnapshotBindingBackfill = await readFile(new URL('./migrations/078_asset_snapshot_binding_backfill.sql', import.meta.url), 'utf8')
  const knowledgeHydrationSnapshots = await readFile(new URL('./migrations/079_knowledge_hydration_snapshots.sql', import.meta.url), 'utf8')
  const storageQuota = await readFile(new URL('./migrations/080_storage_quota.sql', import.meta.url), 'utf8')
  const reconciliationStatus = await readFile(new URL('./migrations/081_reconciliation_status.sql', import.meta.url), 'utf8')
  const knowledgeHydrationRevisionRepair = await readFile(new URL('./migrations/082_knowledge_hydration_revision_repair.sql', import.meta.url), 'utf8')
  const billingActorAttribution = await readFile(new URL('./migrations/083_billing_actor_attribution.sql', import.meta.url), 'utf8')
  const assetScanReceipts = await readFile(new URL('./migrations/084_asset_scan_receipts.sql', import.meta.url), 'utf8')
  const assetScanAttempts = await readFile(new URL('./migrations/085_asset_scan_attempts.sql', import.meta.url), 'utf8')
  const trustedCleanAssetBackfill = await readFile(new URL('./migrations/086_trusted_clean_asset_backfill.sql', import.meta.url), 'utf8')
  const assetPromotionCleanupTasks = await readFile(new URL('./migrations/087_asset_promotion_cleanup_tasks.sql', import.meta.url), 'utf8')
  const imageGenerationContinuationLeases = await readFile(new URL('./migrations/088_image_generation_continuation_leases.sql', import.meta.url), 'utf8')
  const merchantIntentSnapshots = await readFile(new URL('./migrations/089_merchant_intent_snapshots.sql', import.meta.url), 'utf8')
  const isolateOpsWorkspaceDirectory = await readFile(new URL('./migrations/090_isolate_ops_workspace_directory.sql', import.meta.url), 'utf8')
  const bindPlatformScopeToOpsRole = await readFile(new URL('./migrations/091_bind_platform_scope_to_ops_role.sql', import.meta.url), 'utf8')
  const imageGenerationExecutions = await readFile(new URL('./migrations/092_image_generation_executions.sql', import.meta.url), 'utf8')
  const runtimeDeletePrivilegeHardening = await readFile(new URL('./migrations/093_runtime_delete_privilege_hardening.sql', import.meta.url), 'utf8')
  const imageGenerationReconciliationCursorIndex = await readFile(new URL('./migrations/094_image_generation_reconciliation_cursor_index.sql', import.meta.url), 'utf8')
  const runtimeAppendOnlyPrivileges = await readFile(new URL('./migrations/095_runtime_append_only_privileges.sql', import.meta.url), 'utf8')
  const reconciliationEvidence = await readFile(new URL('./migrations/096_reconciliation_evidence.sql', import.meta.url), 'utf8')
  const reconciliationEvidenceUnknownErrors = await readFile(new URL('./migrations/097_reconciliation_evidence_unknown_errors.sql', import.meta.url), 'utf8')
  const unifiedLinkAudit = await readFile(new URL('./migrations/098_unified_link_audit.sql', import.meta.url), 'utf8')
  const canonicalLegacyBrandIntegrity = await readFile(new URL('./migrations/099_canonical_legacy_brand_integrity.sql', import.meta.url), 'utf8')
  const operationAlertNotifications = await readFile(new URL('./migrations/100_operation_alert_notifications.sql', import.meta.url), 'utf8')
  const canonicalBackfillRuns = await readFile(new URL('./migrations/101_canonical_backfill_runs.sql', import.meta.url), 'utf8')
  const canonicalBackfillConflicts = await readFile(new URL('./migrations/102_canonical_backfill_conflicts.sql', import.meta.url), 'utf8')
  const operationAlertNotificationAcl = await readFile(new URL('./migrations/103_operation_alert_notification_acl.sql', import.meta.url), 'utf8')
  const interactiveConfirmationTickets = await readFile(new URL('./migrations/104_interactive_confirmation_tickets.sql', import.meta.url), 'utf8')
  const durableAuthorizationGrants = await readFile(new URL('./migrations/105_durable_authorization_grants.sql', import.meta.url), 'utf8')
  const canonicalLegacyBrandIntegrityGuard = await readFile(new URL('./migrations/106_canonical_legacy_brand_integrity_guard.sql', import.meta.url), 'utf8')
  const canonicalBackfillConflictVerificationEvidence = await readFile(new URL('./migrations/107_canonical_backfill_conflict_verification_evidence.sql', import.meta.url), 'utf8')
  const modelUsageSettledCostInvariant = await readFile(new URL('./migrations/108_model_usage_settled_cost_invariant.sql', import.meta.url), 'utf8')
  const assetScanRedrive = await readFile(new URL('./migrations/109_asset_scan_redrive.sql', import.meta.url), 'utf8')
  const unifiedModelRunCostBudget = await readFile(new URL('./migrations/110_unified_model_run_cost_budget.sql', import.meta.url), 'utf8')
  const hardenedModelRunBudgetLinkage = await readFile(new URL('./migrations/111_harden_model_run_budget_linkage.sql', import.meta.url), 'utf8')
  const supportSlaSnapshot = await readFile(new URL('./migrations/112_support_sla_snapshot.sql', import.meta.url), 'utf8')
  const supportSlaEvents = await readFile(new URL('./migrations/113_support_sla_events.sql', import.meta.url), 'utf8')
  const supportSlaReporting = await readFile(new URL('./migrations/114_support_sla_reporting.sql', import.meta.url), 'utf8')
  const supportSlaCorrectionDecisions = await readFile(new URL('./migrations/115_support_sla_correction_decisions.sql', import.meta.url), 'utf8')
  const supportSlaCorrectionApprovals = await readFile(new URL('./migrations/116_support_sla_correction_approvals.sql', import.meta.url), 'utf8')
  const imageGenerationProviderOperationReservation = await readFile(new URL('./migrations/117_image_generation_provider_operation_reservation.sql', import.meta.url), 'utf8')
  const imageGenerationExecutionDispatchFence = await readFile(new URL('./migrations/119_image_generation_execution_dispatch_fence.sql', import.meta.url), 'utf8')
  const enforceModelUsageBudgetRunLinkage = await readFile(new URL('./migrations/118_enforce_model_usage_budget_run_linkage.sql', import.meta.url), 'utf8')
  const authorizationExecutionReservations = await readFile(new URL('./migrations/120_authorization_execution_reservations.sql', import.meta.url), 'utf8')
  const authorizationExecutionReservationsAcl = await readFile(new URL('./migrations/121_authorization_execution_reservations_acl.sql', import.meta.url), 'utf8')
  const authorizationExecutionDecisionCorrelation = await readFile(new URL('./migrations/142_authorization_execution_decision_correlation.sql', import.meta.url), 'utf8')
  const campaignItemLegacyCanonicalIntegrity = await readFile(new URL('./migrations/122_campaign_item_legacy_canonical_integrity.sql', import.meta.url), 'utf8')
  const commercialOrderSnapshots = await readFile(new URL('./migrations/123_commercial_order_snapshots.sql', import.meta.url), 'utf8')
  const blockPlatformRoleInWorkspaceMembers = await readFile(new URL('./migrations/124_block_platform_role_in_workspace_members.sql', import.meta.url), 'utf8')
  const authorizationEventsAppendOnly = await readFile(new URL('./migrations/125_authorization_events_append_only.sql', import.meta.url), 'utf8')
  const contextSnapshotCanonicalScopeIntegrity = await readFile(new URL('./migrations/126_context_snapshot_canonical_scope_integrity.sql', import.meta.url), 'utf8')
  const validatePlatformRoleBoundary = await readFile(new URL('./migrations/127_validate_platform_role_boundary.sql', import.meta.url), 'utf8')
  const productListingIdentityUniqueness = await readFile(new URL('./migrations/128_product_listing_identity_uniqueness.sql', import.meta.url), 'utf8')
  const campaignItemListingScopeIntegrity = await readFile(new URL('./migrations/129_campaign_item_listing_scope_integrity.sql', import.meta.url), 'utf8')
  const canonicalLegacyIdentityUniqueness = await readFile(new URL('./migrations/130_canonical_legacy_identity_uniqueness.sql', import.meta.url), 'utf8')
  const taskCampaignItemScopeIntegrity = await readFile(new URL('./migrations/131_task_campaign_item_scope_integrity.sql', import.meta.url), 'utf8')
  const ruleAuditAppendOnlyAcl = await readFile(new URL('./migrations/132_rule_audit_append_only_acl.sql', import.meta.url), 'utf8')
  const parallelMigrationMergeBarrier = await readFile(new URL('./migrations/133_parallel_migration_merge_barrier.sql', import.meta.url), 'utf8')
  const authorizationEventsTruncateGuard = await readFile(new URL('./migrations/134_authorization_events_truncate_guard.sql', import.meta.url), 'utf8')
  const authorizationEventScopeIntegrity = await readFile(new URL('./migrations/135_authorization_event_scope_integrity.sql', import.meta.url), 'utf8')
  const taskCanonicalListingIdentity = await readFile(new URL('./migrations/137_task_canonical_listing_identity.sql', import.meta.url), 'utf8')
  const interactiveConfirmationTicketNonceDigest = await readFile(new URL('./migrations/138_interactive_confirmation_ticket_nonce_digest.sql', import.meta.url), 'utf8')
  const interactiveConfirmationTicketReservations = await readFile(new URL('./migrations/139_interactive_confirmation_ticket_reservations.sql', import.meta.url), 'utf8')
  const interactiveConfirmationTicketAclGuard = await readFile(new URL('./migrations/141_interactive_confirmation_ticket_acl_guard.sql', import.meta.url), 'utf8')
  const interactiveConfirmationTicketFencing = await readFile(new URL('./migrations/140_interactive_confirmation_ticket_fencing.sql', import.meta.url), 'utf8')
  const requireOpsPlatformScopeForSummary = await readFile(new URL('./migrations/143_require_ops_platform_scope_for_summary.sql', import.meta.url), 'utf8')
  const creativePointLedger = await readFile(new URL('./migrations/144_creative_point_ledger.sql', import.meta.url), 'utf8')
  const hardenOpsWorkspaceSummarySecurity = await readFile(new URL('./migrations/145_harden_ops_workspace_summary_security.sql', import.meta.url), 'utf8')
  const commercialCatalogV2 = await readFile(new URL('./migrations/146_commercial_catalog_v2.sql', import.meta.url), 'utf8')
  const platformAuthorizationAudit = await readFile(new URL('./migrations/147_platform_authorization_audit.sql', import.meta.url), 'utf8')
  const hardenCreativePointReservations = await readFile(new URL('./migrations/148_harden_creative_point_reservations.sql', import.meta.url), 'utf8')
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
    { version: 48, name: 'action_ledger_scope_links', sql: actionLedgerScopeLinks },
    { version: 49, name: 'legacy_snapshot_backfill', sql: legacySnapshotBackfill },
    { version: 50, name: 'payment_callback_nonces', sql: paymentCallbackNonces },
    { version: 51, name: 'active_workspace_catalog', sql: activeWorkspaceCatalog },
    { version: 52, name: 'workspace_context_snapshots', sql: workspaceContextSnapshots },
    { version: 53, name: 'terminal_generation_outbox_cleanup', sql: terminalGenerationOutboxCleanup },
    { version: 54, name: 'model_daily_cost_budget', sql: modelDailyCostBudget },
    { version: 55, name: 'support_crm', sql: supportCrm },
    { version: 56, name: 'incidents', sql: incidents },
    { version: 57, name: 'feature_flags', sql: featureFlags },
    { version: 58, name: 'finance_search_indexes', sql: financeSearchIndexes },
    { version: 59, name: 'ops_audit_center', sql: opsAuditCenter },
    { version: 60, name: 'merchant_collection_pagination_indexes', sql: merchantCollectionPaginationIndexes, transactional: false },
    { version: 61, name: 'platform_control_plane_acl', sql: platformControlPlaneAcl },
    { version: 62, name: 'remove_duplicate_pagination_index', sql: removeDuplicatePaginationIndex, transactional: false },
    { version: 63, name: 'product_listing_brand_canonical_integrity', sql: productListingBrandCanonicalIntegrity },
    { version: 64, name: 'workspace_identity_bootstrap', sql: workspaceIdentityBootstrap },
    { version: 65, name: 'asset_parse_leases', sql: assetParseLeases },
    { version: 66, name: 'platform_media_spec_registry', sql: platformMediaSpecRegistry },
    { version: 67, name: 'platform_mapping_preflight_approvals', sql: platformMappingPreflightApprovals },
    { version: 68, name: 'campaign_lifecycle_runtime_grants', sql: campaignLifecycleRuntimeGrants },
    { version: 69, name: 'platform_account_scope_integrity', sql: platformAccountScopeIntegrity },
    { version: 70, name: 'product_asset_bindings', sql: productAssetBindings },
    { version: 71, name: 'runtime_integrity', sql: runtimeIntegrity },
    { version: 72, name: 'product_asset_binding_integrity', sql: productAssetBindingIntegrity },
    { version: 73, name: 'ops_data_contracts', sql: opsDataContracts },
    { version: 74, name: 'model_usage_context_links', sql: modelUsageContextLinks },
    { version: 75, name: 'model_usage_action_lookup_index', sql: modelUsageActionLookupIndex },
    { version: 76, name: 'canonical_product_backfill_index', sql: canonicalProductBackfillIndex },
    { version: 77, name: 'canonical_publish_scope_integrity', sql: canonicalPublishScopeIntegrity },
    { version: 78, name: 'asset_snapshot_binding_backfill', sql: assetSnapshotBindingBackfill },
    { version: 79, name: 'knowledge_hydration_snapshots', sql: knowledgeHydrationSnapshots },
    { version: 80, name: 'storage_quota', sql: storageQuota },
    { version: 81, name: 'reconciliation_status', sql: reconciliationStatus },
    { version: 82, name: 'knowledge_hydration_revision_repair', sql: knowledgeHydrationRevisionRepair },
    { version: 83, name: 'billing_actor_attribution', sql: billingActorAttribution },
    { version: 84, name: 'asset_scan_receipts', sql: assetScanReceipts },
    { version: 85, name: 'asset_scan_attempts', sql: assetScanAttempts },
    { version: 86, name: 'trusted_clean_asset_backfill', sql: trustedCleanAssetBackfill },
    { version: 87, name: 'asset_promotion_cleanup_tasks', sql: assetPromotionCleanupTasks },
    { version: 88, name: 'image_generation_continuation_leases', sql: imageGenerationContinuationLeases },
    { version: 89, name: 'merchant_intent_snapshots', sql: merchantIntentSnapshots },
    { version: 90, name: 'isolate_ops_workspace_directory', sql: isolateOpsWorkspaceDirectory },
    { version: 91, name: 'bind_platform_scope_to_ops_role', sql: bindPlatformScopeToOpsRole },
    { version: 92, name: 'image_generation_executions', sql: imageGenerationExecutions },
    { version: 93, name: 'runtime_delete_privilege_hardening', sql: runtimeDeletePrivilegeHardening },
    { version: 94, name: 'image_generation_reconciliation_cursor_index', sql: imageGenerationReconciliationCursorIndex },
    { version: 95, name: 'runtime_append_only_privileges', sql: runtimeAppendOnlyPrivileges },
    { version: 96, name: 'reconciliation_evidence', sql: reconciliationEvidence },
    { version: 97, name: 'reconciliation_evidence_unknown_errors', sql: reconciliationEvidenceUnknownErrors },
    { version: 98, name: 'unified_link_audit', sql: unifiedLinkAudit },
    { version: 99, name: 'canonical_legacy_brand_integrity', sql: canonicalLegacyBrandIntegrity },
    { version: 100, name: 'operation_alert_notifications', sql: operationAlertNotifications },
    { version: 101, name: 'canonical_backfill_runs', sql: canonicalBackfillRuns },
    { version: 102, name: 'canonical_backfill_conflicts', sql: canonicalBackfillConflicts },
    { version: 103, name: 'operation_alert_notification_acl', sql: operationAlertNotificationAcl },
    { version: 104, name: 'interactive_confirmation_tickets', sql: interactiveConfirmationTickets },
    { version: 105, name: 'durable_authorization_grants', sql: durableAuthorizationGrants },
    { version: 106, name: 'canonical_legacy_brand_integrity_guard', sql: canonicalLegacyBrandIntegrityGuard },
    { version: 107, name: 'canonical_backfill_conflict_verification_evidence', sql: canonicalBackfillConflictVerificationEvidence },
    { version: 108, name: 'model_usage_settled_cost_invariant', sql: modelUsageSettledCostInvariant },
    { version: 109, name: 'asset_scan_redrive', sql: assetScanRedrive },
    { version: 110, name: 'unified_model_run_cost_budget', sql: unifiedModelRunCostBudget },
    { version: 111, name: 'harden_model_run_budget_linkage', sql: hardenedModelRunBudgetLinkage },
    { version: 112, name: 'support_sla_snapshot', sql: supportSlaSnapshot },
    { version: 113, name: 'support_sla_events', sql: supportSlaEvents },
    { version: 114, name: 'support_sla_reporting', sql: supportSlaReporting },
    { version: 115, name: 'support_sla_correction_decisions', sql: supportSlaCorrectionDecisions },
    { version: 116, name: 'support_sla_correction_approvals', sql: supportSlaCorrectionApprovals },
    { version: 117, name: 'image_generation_provider_operation_reservation', sql: imageGenerationProviderOperationReservation },
    { version: 118, name: 'enforce_model_usage_budget_run_linkage', sql: enforceModelUsageBudgetRunLinkage },
    { version: 119, name: 'image_generation_execution_dispatch_fence', sql: imageGenerationExecutionDispatchFence },
    { version: 120, name: 'authorization_execution_reservations', sql: authorizationExecutionReservations },
    { version: 121, name: 'authorization_execution_reservations_acl', sql: authorizationExecutionReservationsAcl },
    { version: 122, name: 'campaign_item_legacy_canonical_integrity', sql: campaignItemLegacyCanonicalIntegrity },
    { version: 123, name: 'commercial_order_snapshots', sql: commercialOrderSnapshots },
    { version: 124, name: 'block_platform_role_in_workspace_members', sql: blockPlatformRoleInWorkspaceMembers },
    { version: 125, name: 'authorization_events_append_only', sql: authorizationEventsAppendOnly },
    { version: 126, name: 'context_snapshot_canonical_scope_integrity', sql: contextSnapshotCanonicalScopeIntegrity },
    { version: 127, name: 'validate_platform_role_boundary', sql: validatePlatformRoleBoundary },
    { version: 128, name: 'product_listing_identity_uniqueness', sql: productListingIdentityUniqueness },
    { version: 129, name: 'campaign_item_listing_scope_integrity', sql: campaignItemListingScopeIntegrity },
    { version: 130, name: 'canonical_legacy_identity_uniqueness', sql: canonicalLegacyIdentityUniqueness },
    { version: 131, name: 'task_campaign_item_scope_integrity', sql: taskCampaignItemScopeIntegrity },
    { version: 132, name: 'rule_audit_append_only_acl', sql: ruleAuditAppendOnlyAcl },
    { version: 133, name: 'parallel_migration_merge_barrier', sql: parallelMigrationMergeBarrier },
    { version: 134, name: 'authorization_events_truncate_guard', sql: authorizationEventsTruncateGuard },
    { version: 135, name: 'authorization_event_scope_integrity', sql: authorizationEventScopeIntegrity },
    { version: 136, name: 'workspace_operation_audit_truncate_guard', sql: workspaceOperationAuditTruncateGuard },
    { version: 137, name: 'task_canonical_listing_identity', sql: taskCanonicalListingIdentity },
    { version: 138, name: 'interactive_confirmation_ticket_nonce_digest', sql: interactiveConfirmationTicketNonceDigest },
    { version: 139, name: 'interactive_confirmation_ticket_reservations', sql: interactiveConfirmationTicketReservations },
    { version: 140, name: 'interactive_confirmation_ticket_fencing', sql: interactiveConfirmationTicketFencing },
    { version: 141, name: 'interactive_confirmation_ticket_acl_guard', sql: interactiveConfirmationTicketAclGuard },
    { version: 142, name: 'authorization_execution_decision_correlation', sql: authorizationExecutionDecisionCorrelation },
    { version: 143, name: 'require_ops_platform_scope_for_summary', sql: requireOpsPlatformScopeForSummary },
    { version: 144, name: 'creative_point_ledger', sql: creativePointLedger },
    { version: 145, name: 'harden_ops_workspace_summary_security', sql: hardenOpsWorkspaceSummarySecurity },
    { version: 146, name: 'commercial_catalog_v2', sql: commercialCatalogV2 },
    { version: 147, name: 'platform_authorization_audit', sql: platformAuthorizationAudit },
    { version: 148, name: 'harden_creative_point_reservations', sql: hardenCreativePointReservations },
  ]
}

export async function runMigrations(pool: SqlPool, migrations: readonly Migration[]): Promise<number[]> {
  return new MigrationRunner(pool, migrations).run()
}
