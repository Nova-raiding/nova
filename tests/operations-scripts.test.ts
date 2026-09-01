import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { REQUIRED_CAPABILITIES, REQUIRED_PLATFORMS } from './capability-evidence-gate.js'
import { buildReleaseManifest } from '../scripts/release-manifest.js'

function run(script: string, args: string[] = [], env: Record<string, string> = {}) {
  return execFileSync('sh', [script, ...args], { encoding: 'utf8', env: { ...process.env, ...env }, stdio: 'pipe' })
}

describe('deployment operation scripts', () => {
  it('keeps read-only worker containers writable only through the readiness volume', () => {
    const manifest = readFileSync('infra/kubernetes/base/workers.yaml', 'utf8')
    expect(manifest.match(/automountServiceAccountToken: false/g)).toHaveLength(6)
    for (const role of ['sync', 'generation', 'publish', 'reconcile', 'automation']) {
      expect(manifest).toContain(`WORKER_ROLE, value: ${role}`)
      expect(manifest).toContain(`WORKER_READY_FILE, value: /tmp/merchant-worker-${role}-ready`)
      expect(manifest).toContain(`name: tmp, mountPath: /tmp`)
      expect(manifest).toContain(`name: tmp, emptyDir: {sizeLimit: 64Mi}`)
      expect(manifest).toContain('readOnlyRootFilesystem: true')
      expect(manifest).toContain('readinessProbe:')
    }
  })

  it('ships the explicit 15-minute storage reconciliation interval to Kubernetes workers', () => {
    const config = readFileSync('infra/kubernetes/base/configmap.yaml', 'utf8')
    expect(config).toContain('STORAGE_RECONCILIATION_INTERVAL_MS: "900000"')
  })

  it('protects every isolated worker pool from voluntary disruption', () => {
    const manifest = readFileSync('infra/kubernetes/base/workers.yaml', 'utf8')
    for (const role of ['sync', 'generation', 'publish', 'reconcile', 'automation']) {
      expect(manifest).toContain(`metadata: {name: merchant-worker-${role}}`)
      expect(manifest).toContain(`selector: {matchLabels: {app.kubernetes.io/name: merchant-worker-${role}}}`)
    }
    expect(manifest.match(/kind: PodDisruptionBudget/g)).toHaveLength(6)
  })

  it('serializes shell-based migration runners across deployment replicas', () => {
    const script = readFileSync('infra/scripts/apply-migrations.sh', 'utf8')
    expect(script).toContain('pg_advisory_xact_lock(731942851)')
    expect(script).toContain('pg_advisory_lock(731942851)')
    expect(script).not.toContain('applied=$(psql')
    expect(script.match(/SELECT EXISTS \(SELECT 1 FROM schema_migrations WHERE version = :migration_version\)/g)).toHaveLength(2)
    expect(script).toContain('MIGRATION_NAME_MISMATCH')
    expect(script).toContain('MIGRATION_CHECKSUM_MISMATCH')
    expect(script).toContain('MIGRATION_VERSION_UNKNOWN')
    expect(script).toContain('MIGRATION_HISTORY_GAP')
    expect(script).toContain('MIGRATION_FILENAME_INVALID')
    expect(script).toContain('MIGRATION_ARTIFACT_CHAIN_GAP')
    expect(script).toContain('MIGRATION_ARTIFACTS_EMPTY')
    expect(script).toContain("grep -Eq '^[0-9]{3}_[a-z0-9][a-z0-9_]*\\.sql$'")
    expect(script.indexOf('MIGRATION_ARTIFACT_CHAIN_GAP')).toBeLessThan(script.indexOf("CREATE TABLE IF NOT EXISTS schema_migrations"))
    expect(script).toContain('generate_series(1, :latest_version)')
    expect(script).toContain('sha256_file')
    expect(script.indexOf('pg_advisory_lock(731942851)')).toBeLessThan(script.indexOf('SELECT EXISTS'))
    expect(script.indexOf('pg_advisory_xact_lock(731942851)')).toBeLessThan(script.lastIndexOf('SELECT EXISTS'))
  })

  it('keeps role bootstrap atomic and verifies runtime ACL/RLS before seeding', () => {
    const compose = readFileSync('infra/local/docker-compose.yml', 'utf8')
    const roleSql = readFileSync('infra/local/ensure-app-role.sql', 'utf8')
    const seedSql = readFileSync('infra/local/seed-demo.sql', 'utf8')
    expect(roleSql).toContain('BEGIN;\nSELECT pg_advisory_xact_lock(731942852);')
    expect(roleSql.trimEnd().endsWith('COMMIT;')).toBe(true)
    expect(seedSql).toContain('BEGIN;\nSELECT pg_advisory_xact_lock(731942853);')
    expect(compose).toContain('/bin/sh /ops/verify-runtime-db-role.sh')
    expect(compose.indexOf('/ops/ensure-app-role.sql')).toBeLessThan(compose.indexOf('/ops/verify-runtime-db-role.sh'))
    expect(compose.indexOf('/ops/verify-runtime-db-role.sh')).toBeLessThan(compose.indexOf('/ops/seed-demo.sql'))
  })

  it('grants the runtime role only the worker workspace catalog function', () => {
    const roleSql = readFileSync('infra/local/ensure-app-role.sql', 'utf8')
    expect(roleSql).toContain('REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM merchant_app')
    expect(roleSql).toContain('REVOKE ALL ON FUNCTION public.worker_active_workspace_catalog() FROM PUBLIC')
    expect(roleSql).toContain('GRANT EXECUTE ON FUNCTION public.worker_active_workspace_catalog() TO merchant_app')
    expect(roleSql).not.toContain('GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO merchant_app')
    expect(roleSql).toContain('REVOKE ALL ON platform_feature_flags, platform_feature_flag_targets, platform_feature_flag_events FROM merchant_app')
    expect(roleSql).toContain('CREATE ROLE merchant_ops')
  })

  it('keeps shell migration filename versions unique and contiguous', () => {
    const versions = readdirSync('packages/persistence/src/migrations')
      .filter(file => /^\d{3}_.+\.sql$/.test(file))
      .map(file => Number(file.slice(0, 3)))
      .sort((left, right) => left - right)
    expect(versions).toEqual(Array.from({ length: versions.at(-1) ?? 0 }, (_, index) => index + 1))
  })

  it('keeps the real-platform canary shell boundary injection-safe and HTTPS-only', () => {
    const script = readFileSync('infra/scripts/run-production-canary.sh', 'utf8')
    expect(() => run('infra/scripts/run-production-canary.sh', [], {
      RELEASE_ID: 'release-1', PLATFORM_CANARY_BASE_EVIDENCE: '/not-found', PLATFORM_CANARY_OUTPUT: '/tmp/out.json',
      PLATFORM_CANARY_MODE: 'real', PLATFORM_CANARY_CONFIRM: 'true', PAYMENT_MODE: 'provider',
      PAYMENT_CALLBACK_BASE_URL: 'https://merchant.example.com', PAYMENT_CALLBACK_SECRET_REF: 'vault://callback',
      PAYMENT_PROVIDER_QUERY_API_URL: 'https://payments.example.com/query', PAYMENT_PROVIDER_REFUND_API_URL: 'http://payments.example.com/refund',
    })).toThrow(/HTTPS|base evidence/)
    expect(script).not.toMatch(/\beval\s+["']/)
    expect(script).toContain('printenv "$1"')
    expect(execFileSync('sh', ['-n', 'infra/scripts/run-production-canary.sh'], { encoding: 'utf8' })).toBe('')
  })

  it('keeps all documented capacity profiles deterministic and dry-run by default', () => {
    const script = 'infra/scripts/scale-workloads.sh'
    expect(run(script, ['pilot_50'])).toContain('profile=pilot_50 api=3 sync=2 generation=2 publish=3 reconcile=2')
    expect(run(script, ['wave_100'])).toContain('profile=wave_100 api=3 sync=2 generation=2 publish=3 reconcile=2')
    expect(run(script, ['wave_250'])).toContain('profile=wave_250 api=6 sync=4 generation=6 publish=5 reconcile=3')
    expect(run(script, ['target_500'])).toContain('profile=target_500 api=12 sync=12 generation=16 publish=8 reconcile=4')
    expect(() => run(script, ['invalid'])).toThrow()
    const source = readFileSync(script, 'utf8')
    expect(source).not.toContain('eval ')
    expect(source).not.toContain('sh -c')
    expect(source).toContain('deployment/merchant-worker-automation')
  })

  it('requires an immutable rollback manifest and never executes operator-provided shell', () => {
    const script = 'infra/scripts/rollback.sh'
    const source = readFileSync(script, 'utf8')
    expect(() => run(script, [], { RELEASE_ID: 'release-1', CONFIRM_ROLLBACK: 'NO' })).toThrow()
    expect(() => run(script, [], { RELEASE_ID: 'release-1', CONFIRM_ROLLBACK: 'YES' })).toThrow()
    expect(() => run(script, [], { RELEASE_ID: 'release-1;touch /tmp/unsafe', CONFIRM_ROLLBACK: 'YES' })).toThrow()
    expect(source).not.toContain('ROLLBACK_COMMAND')
    expect(source).not.toContain('sh -c')
    expect(source).toContain('validate-kubernetes-release.sh')
    expect(source).toContain('ROLLBACK_MANIFEST_SHA256')
    expect(source).toContain('run-production-canary.sh')
    expect(source).toContain('merchant-worker-reconcile merchant-worker-automation merchant-worker-scan')
    expect(source).toContain('WORKER_ROLE=generation')
    expect(source).toContain('WORKER_ROLE=scan')
    expect(source).not.toContain('WORKER_ROLE=all')
    expect(source).toContain('rollback image is incompatible with live migration')
    expect(source).toContain('PostgresAssetScanAttemptRepository')
    expect(source).toContain('asset-scan-receipt/1.0')
    expect(source).toContain('x-scanner-timestamp')
    expect(source).toContain('x-scanner-nonce')
    expect(source).toContain('x-scanner-body-sha256')
    expect(source.indexOf('rollback image failed scanner and migration compatibility gate')).toBeLessThan(source.indexOf('kubectl apply -f "$verified_manifest"'))
    expect(execFileSync('sh', ['-n', script], { encoding: 'utf8' })).toBe('')
  })

  it('requires a checksum sidecar before any destructive restore command', () => {
    const directory = mkdtempSync(join(tmpdir(), 'merchant-restore-gate-'))
    const backup = join(directory, 'merchant.dump')
    writeFileSync(backup, 'not-a-real-dump')
    expect(() => run('infra/scripts/restore-postgres.sh', [], {
      DATABASE_URL: 'postgresql://merchant@127.0.0.1:5432/merchant', BACKUP_FILE: backup, CONFIRM_RESTORE: 'YES', RESTORE_ALLOW_UNSIGNED_LOCAL: 'YES',
    })).toThrow(/checksum sidecar/)
  })

  it('blocks deployment without immutable image and production connection metadata', () => {
    const directory = mkdtempSync(join(tmpdir(), 'merchant-preflight-'))
    const config = join(directory, 'production.yaml')
    const evidence = join(directory, 'capability-evidence.json')
    const capacity = join(directory, 'capacity-evidence.json')
    const relayEvidence = join(directory, 'model-relay-evidence.json')
    const hostEvidence = join(directory, 'codex-app-host-evidence.json')
    const storageEvidence = join(directory, 'object-storage-evidence.json')
    const canonicalCutoverEvidence = join(directory, 'canonical-cutover-evidence.json')
    const releaseManifest = join(directory, 'release-manifest.json')
    const paymentEvidence = join(directory, 'payment-evidence.json')
    const restoreEvidence = join(directory, 'restore-evidence.json')
    const manifest = join(directory, 'rendered.yaml')
    const imageDigests = {
      'merchant-api': 'sha256:' + 'a'.repeat(64),
      'merchant-worker': 'sha256:' + 'b'.repeat(64),
      'merchant-ui': 'sha256:' + 'c'.repeat(64),
      'merchant-ops-ui': 'sha256:' + 'd'.repeat(64),
      clamav: 'sha256:' + 'f'.repeat(64),
    }
    writeFileSync(config, [
      'plugin_enabled: true', 'merchant_bearer_hostname: merchant.example.com', 'app_base_url: https://merchant.example.com', 'ops_base_url: https://ops.merchant.example.com', 'mcp_base_url: https://merchant.example.com', 'oauth_callback_base_url: https://merchant.example.com/v1/oauth/callback', 'OPS_AUTH_MODE: oidc',
      'auth_enforcement: strict', 'mcp_authorization_mode: enforce', 'durable_platform_assignments_required: true', 'session_id_hash_secret_ref: vault://merchant-identity/session-id-hash-secret',
      'jd_auth_enabled: true', 'jd_read_enabled: true', 'jd_write_enabled: true',
      'taobao_tmall_auth_enabled: true', 'taobao_tmall_read_enabled: true', 'taobao_tmall_write_enabled: true',
      'pinduoduo_auth_enabled: true', 'pinduoduo_read_enabled: true', 'pinduoduo_write_enabled: true',
      'xiaohongshu_auth_enabled: true', 'xiaohongshu_read_enabled: true', 'xiaohongshu_write_enabled: true',
      'douyin_auth_enabled: true', 'douyin_read_enabled: true', 'douyin_write_enabled: true',
      'point_in_time_recovery_enabled: true', 'database_pooler_enabled: true', 'database_max_backend_connections: 300', 'database_connection_utilization_alert_percent: 80', 'secret_provider: vault', 'worker_api_credentials_ref: vault://worker-api-credentials', ...['sync', 'generation', 'publish', 'reconcile', 'automation'].flatMap(role => [`worker_${role}_api_token_ref: vault://worker-${role}-token`, `worker_${role}_api_signing_secret_ref: vault://worker-${role}-signing`]), 'payment_mode: provider', 'payment_provider_adapters: alipay,wechat', 'payment_checkout_base_url: https://payments.example.com/checkout', 'payment_provider_checkout_api_url: https://payments.example.com/v1/checkout', 'payment_provider_query_api_url: https://payments.example.com/v1/query', 'payment_provider_refund_api_url: https://payments.example.com/v1/refund', 'payment_provider_api_key_ref: vault://merchant-payment/provider-api-key', 'payment_provider_merchant_id: merchant-example', 'payment_callback_base_url: https://merchant.example.com/v1', 'payment_callback_secret_ref: vault://merchant-payment-callback', 'payment_reconciliation_enabled: true', 'payment_refund_enabled: true', 'model_relay_base_url: https://relay.example.com', 'model_relay_api_key_ref: vault://merchant-model/relay-api-key', 'text_model: merchant-text-v1', 'image_model: merchant-image-v1', 'image_edit_model: merchant-image-edit-v1', 'ocr_model: merchant-ocr-v1', 'video_model: merchant-video-v1', 'approved_requests_per_minute: "100"', 'approved_tokens_per_minute: "100000"', 'maximum_task_cost_cny: "0.50"', 'platform_rule_sync_manifest_url: https://rules.example.com/platform-rules/v1/manifest.json', 'platform_rule_sync_signing_secret_ref: vault://merchant-rules/manifest-signing-secret', 'platform_rule_sync_interval_hours: "24"',
      'asset_scanner_mode: clamav_worker', 'allow_local_asset_scan_fixture: false', 'asset_scanner_api_token_ref: vault://merchant-scanner/api-token', 'asset_scanner_workspace_signing_secret_ref: vault://merchant-scanner/workspace-signing', 'asset_scan_receipt_key_id: scanner-production-2026-08', 'asset_scan_receipt_private_key_ref: vault://merchant-scanner/receipt-private-key', 'asset_scan_trusted_public_keys_ref: vault://merchant-scanner/trusted-public-keys', 'asset_scan_policy_version: scan-policy-2026-08-30', `clamav_image_digest: ${imageDigests.clamav}`, 'clamav_signature_max_age_minutes: 1440', 'clamav_max_file_bytes: 52428800',
      'object_storage_bucket: merchant-assets', 'object_storage_region: cn', 'object_storage_endpoint: https://s3.example.com', 'object_storage_kms_key: vault://kms', 'asset_display_base_url: https://merchant.example.com', 'asset_display_url_signing_secret_ref: vault://merchant-assets/display-url-signing-secret', 'merchant_ui_api_token_ref: vault://merchant-ui/api-token', 'object_storage_versioning: true', 'lifecycle_policy_ref: vault://asset-lifecycle-policy', 'asset_quarantine_retention_days: 7', 'asset_clean_retention_days: 90', 'deletion_request_grace_days: 7', 'backup_retention_days: 30', 'alert_channel_secret_ref: vault://merchant-alert-channel',
    ].join('\n'))
    writeFileSync(evidence, JSON.stringify({
      schema_version: '1', release_id: 'release-1', environment: 'production', generated_at: '2026-08-23T00:00:00Z',
      platforms: REQUIRED_PLATFORMS.map(platform => ({ platform, application_id: `${platform}-app`, test_store_id: `${platform}-store`, capabilities: Object.fromEntries(REQUIRED_CAPABILITIES.map(capability => [capability, { state: 'production_canary', evidence_ref: 'artifact://evidence/1', verified_by: 'qa', verified_at: '2026-08-23T00:00:00Z', api_version: 'v1', scope: 'product.read product.write' }])) })),
    }))
    writeFileSync(capacity, JSON.stringify({
      schema_version: '1', status: 'pass', release_id: 'release-1', config_version: 'config-1', environment: 'preproduction', target_url: 'https://capacity.example.com', started_at: '2026-08-23T00:00:00Z', ended_at: '2026-08-23T06:00:00Z', profile: 'pilot_50', cloud_gate: true, raw_metrics_ref: 'artifact://metrics/1', platform_mock_ratio: 0, model_mock_ratio: 0, sign_off: { verified_by: 'qa', verified_at: '2026-08-23T06:00:00Z' }, metrics: { workspaces: 50, client_connections: 150, sustained_rps: 30, sustained_duration_minutes: 30, burst_rps: 60, burst_duration_seconds: 60, async_jobs_per_minute: 50, p95_ms: 100, p99_ms: 150, error_count: 0, duplicate_writes: 0, lost_jobs: 0, fairness_p95_degradation_percent: 10, stability_hours: 6 },
    }))
    writeFileSync(relayEvidence, JSON.stringify({
      schema_version: '1', release_id: 'release-1', generated_at: '2026-08-23T06:00:00Z', environment: 'production', simulated: false, relay: 'https://relay.example.com',
      results: ['text', 'image', 'image_edit', 'ocr', 'video'].map(modality => ({ modality, state: 'ready', endpoint: '/probe', model: `merchant-${modality}-v1`, providerRequestId: `req-${modality}`, usageObserved: true, costObserved: true, costCny: 0.01 })),
    }))
    writeFileSync(hostEvidence, JSON.stringify({
      schema_version: '2', release_id: 'release-1', environment: 'preproduction', generated_at: '2026-08-23T06:00:00Z',
      host: 'codex-app-ci-arm64', app_version: '0.150.1', plugin_version: '0.1.0', simulated: false,
      mcp_base_url: 'https://merchant.example.com', bridge_sha256: createHash('sha256').update(readFileSync('apps/plugin/mcp/bridge.mjs')).digest('hex'),
      scenarios: ['plugin_discovery', 'merchant_start', 'wallet_recharge_entry', 'platform_oauth_entry', 'asset_attachment', 'error_recovery', 'image_generation', 'automatic_scan', 'candidate_images_rendered', 'candidate_primary_cta', 'candidate_selection_persisted', 'selection_not_reviewed', 'selection_not_published', 'automation_read_only', 'automation_host_absent'].map(id => ({ id, state: 'passed', evidence_ref: `artifact://production/codex-host/${id}#${'a'.repeat(64)}`, console_errors: 0, network_errors: 0 })),
    }))
    writeFileSync(storageEvidence, JSON.stringify({
      schema_version: '1', release_id: 'release-1', environment: 'production', generated_at: '2026-08-23T06:00:00Z', expires_at: '2026-09-23T06:00:00Z', provider: 's3-compatible', bucket: 'merchant-assets', endpoint: 'https://s3.example.com', versioning: true, public_access_blocked: true, kms_encryption: true, lifecycle_policy_id: 'asset-lifecycle-v1', simulated: false, attestation_ref: `artifact://production/storage/attestation#${'a'.repeat(64)}`,
      checks: ['quarantine_clean_metadata', 'version_restore', 'integrity_sample', 'deletion_protection', 'orphan_recovery', 'generated_video_archive'].map(id => ({ id, state: 'passed', evidence_ref: `artifact://production/storage/${id}#${'a'.repeat(64)}` })),
    }))
    writeFileSync(canonicalCutoverEvidence, JSON.stringify({ schema_version: '1', release_id: 'release-1', environment: 'production', generated_at: '2026-08-23T06:00:00Z', expires_at: '2026-09-23T06:00:00Z', simulated: false, source: 'production_database', database_identity_sha256: 'b'.repeat(64), cutover_state: 'not_cut_over', canonical_read_mode: 'legacy_shadow', canonical_read_enabled: false, workspace_count: 1, shadow_check_cycles: 2, status_counts: { verified: 0, backfilled: 0, legacy_only: 1, conflict: 0, blocked: 0 }, evidence_ref: `artifact://production/canonical/snapshot#${'a'.repeat(64)}`, rollback_evidence_ref: `artifact://production/canonical/rollback#${'a'.repeat(64)}` }))
    writeFileSync(releaseManifest, JSON.stringify(buildReleaseManifest({ root: process.cwd(), releaseId: 'release-1', capabilityEvidenceRef: `artifact://production/evidence/capability#${'a'.repeat(64)}`, capacityEvidenceRef: `artifact://production/evidence/capacity#${'a'.repeat(64)}`, modelRelayEvidenceRef: `artifact://production/evidence/relay#${'a'.repeat(64)}`, paymentEvidenceRef: `artifact://production/evidence/payment#${'a'.repeat(64)}`, restoreEvidenceRef: `artifact://production/evidence/restore#${'a'.repeat(64)}`, objectStorageEvidenceRef: `artifact://production/evidence/storage#${'a'.repeat(64)}`, codexAppHostEvidenceRef: `artifact://production/evidence/codex-host#${'a'.repeat(64)}`, canonicalCutoverEvidenceRef: `artifact://production/evidence/canonical-cutover#${'a'.repeat(64)}` })))
    const commonEvidence = { schema_version: '2', release_id: 'release-1', image_set_digest: 'sha256:' + 'e'.repeat(64), environment: 'production', status: 'pass', generated_at: new Date().toISOString(), simulated: false, verified_by: 'release-manager@example.com', verified_at: new Date(Date.now() - 60_000).toISOString() }
    const paymentDocument: Record<string, unknown> = { ...commonEvidence, kind: 'payment', provider: 'alipay', amount_cny: 0.01, provider_trade_id_sha256: 'b'.repeat(64), checks: Object.fromEntries(['checkout', 'callback', 'callback_replay', 'provider_query', 'reconciliation', 'refund'].map(name => [name, { status: 'pass', evidence_ref: `artifact://production/payment/${name}` }])) }
    writeFileSync(paymentEvidence, JSON.stringify(paymentDocument))
    const restoreDocument: Record<string, unknown> = { ...commonEvidence, kind: 'restore', recovery_target_isolated: true, backup_sha256: 'c'.repeat(64), source_backup_created_at: new Date(Date.now() - 3_600_000).toISOString(), recovery_point_at: new Date(Date.now() - 1_800_000).toISOString(), checks: Object.fromEntries(['backup_checksum', 'isolated_restore', 'migrations', 'data_integrity', 'application_smoke'].map(name => [name, { status: 'pass', evidence_ref: `artifact://production/restore/${name}` }])) }
    writeFileSync(restoreEvidence, JSON.stringify(restoreDocument))
    const scannerRuntime = {
      MERCHANT_BEARER_HOSTNAME: 'merchant.example.com', MCP_AUTHZ_MODE: 'enforce', AUTHZ_DURABLE_ASSIGNMENTS_REQUIRED: 'true',
      MODEL_RELAY_BASE_URL: 'https://relay.example.com', MODEL_RELAY_ALLOWED_HOSTS: 'relay.example.com', AI_MODEL: 'merchant-text-v1', IMAGE_MODEL: 'merchant-image-v1', IMAGE_EDIT_MODEL: 'merchant-image-edit-v1', OCR_MODEL: 'merchant-ocr-v1', VIDEO_MODEL: 'merchant-video-v1', MODEL_RPM_LIMIT: '100', MODEL_TPM_LIMIT: '100000', MODEL_MAX_TASK_COST_CNY: '0.50',
      ASSET_STORAGE_BUCKET: 'merchant-assets', ASSET_STORAGE_REGION: 'cn', ASSET_STORAGE_ENDPOINT: 'https://s3.example.com', OBJECT_STORAGE_VERSIONING: 'true', PUBLIC_ASSET_BASE_URL: 'https://merchant.example.com', PUBLIC_OAUTH_REDIRECT_URI: 'https://merchant.example.com/v1/oauth/callback/{platform}',
      ASSET_QUARANTINE_RETENTION_DAYS: '7', ASSET_CLEAN_RETENTION_DAYS: '90', DELETION_REQUEST_GRACE_DAYS: '7', BACKUP_RETENTION_DAYS: '30', LIFECYCLE_POLICY_REF: 'vault://asset-lifecycle-policy',
      ALLOW_LOCAL_ASSET_SCAN_FIXTURE: 'false', ASSET_SCANNER_MODE: 'clamav_worker', ASSET_SCAN_POLICY_VERSION: 'scan-policy-2026-08-30', CLAMAV_HOST: '127.0.0.1', CLAMAV_PORT: '3310', CLAMAV_MAX_FILE_BYTES: '52428800', CLAMAV_SIGNATURE_MAX_AGE_MINUTES: '1440', PLATFORM_RULE_SYNC_INTERVAL_HOURS: '24',
      PAYMENT_MODE: 'provider', PAYMENT_PROVIDER_ADAPTERS: 'alipay,wechat', PAYMENT_CHECKOUT_BASE_URL: 'https://payments.example.com/checkout', PAYMENT_PROVIDER_CHECKOUT_API_URL: 'https://payments.example.com/v1/checkout', PAYMENT_PROVIDER_QUERY_API_URL: 'https://payments.example.com/v1/query', PAYMENT_PROVIDER_REFUND_API_URL: 'https://payments.example.com/v1/refund', PAYMENT_PROVIDER_MERCHANT_ID: 'merchant-example', PAYMENT_CALLBACK_BASE_URL: 'https://merchant.example.com/v1', PAYMENT_RECONCILIATION_ENABLED: 'true', PAYMENT_REFUND_ENABLED: 'true', PLATFORM_RULE_SYNC_MANIFEST_URL: 'https://rules.example.com/platform-rules/v1/manifest.json',
    }
    const scannerSecret = (name: string, key = name) => ({ name, valueFrom: { secretKeyRef: { name: 'merchant-scanner-secrets', key } } })
    const runtimeSecret = (name: string, key = name) => ({ name, valueFrom: { secretKeyRef: { name: 'merchant-runtime-secrets', key } } })
    const scannerConfigCanonical = `merchant-runtime\n${Object.entries(scannerRuntime).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([key, value]) => `data.${key}=${value}\n`).join('')}`
    const scannerConfigAnnotation = { 'merchant.example.com/config-sha256': `sha256:${createHash('sha256').update(scannerConfigCanonical).digest('hex')}` }
    writeFileSync(manifest, JSON.stringify({ apiVersion: 'v1', kind: 'List', items: [
      { apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'merchant-runtime' }, data: scannerRuntime },
      { apiVersion: 'networking.k8s.io/v1', kind: 'Ingress', metadata: { name: 'merchant' }, spec: { tls: [{ hosts: ['merchant.example.com', 'ops.merchant.example.com'], secretName: 'merchant-tls' }], rules: [
        { host: 'merchant.example.com', http: { paths: [
          { path: '/mcp', pathType: 'Exact', backend: { service: { name: 'merchant-api', port: { name: 'http' } } } },
          { path: '/v1', pathType: 'Prefix', backend: { service: { name: 'merchant-api', port: { name: 'http' } } } },
          { path: '/', pathType: 'Prefix', backend: { service: { name: 'merchant-ui', port: { name: 'http' } } } },
        ] } },
        { host: 'ops.merchant.example.com', http: { paths: [
          { path: '/', pathType: 'Prefix', backend: { service: { name: 'merchant-ops-ui', port: { name: 'http' } } } },
        ] } },
      ] } },
      { apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: 'merchant-api' }, spec: { template: { metadata: { annotations: scannerConfigAnnotation }, spec: { containers: [{ name: 'api', image: `registry.example.com/merchant-api@${imageDigests['merchant-api']}`, envFrom: [{ configMapRef: { name: 'merchant-runtime' } }], env: [scannerSecret('ASSET_SCANNER_API_TOKEN'), scannerSecret('ASSET_SCANNER_WORKSPACE_SIGNING_SECRET'), scannerSecret('ASSET_SCAN_TRUSTED_PUBLIC_KEYS'), runtimeSecret('MODEL_RELAY_API_KEY'), runtimeSecret('PLATFORM_RULE_SYNC_SIGNING_SECRET'), runtimeSecret('PAYMENT_PROVIDER_API_KEY'), runtimeSecret('PAYMENT_CALLBACK_SECRET')] }] } } } },
      { apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: 'merchant-worker-scan' }, spec: { template: { metadata: { annotations: scannerConfigAnnotation }, spec: { nodeSelector: { 'kubernetes.io/arch': 'amd64' }, containers: [
        { name: 'worker', image: `registry.example.com/merchant-worker@${imageDigests['merchant-worker']}`, envFrom: [{ configMapRef: { name: 'merchant-runtime' } }], env: [{ name: 'WORKER_ROLE', value: 'scan' }, scannerSecret('WORKER_API_TOKEN', 'ASSET_SCANNER_API_TOKEN'), scannerSecret('WORKER_API_SIGNING_SECRET', 'ASSET_SCANNER_WORKSPACE_SIGNING_SECRET'), scannerSecret('ASSET_SCANNER_API_TOKEN'), scannerSecret('ASSET_SCANNER_WORKSPACE_SIGNING_SECRET'), scannerSecret('ASSET_SCAN_RECEIPT_KEY_ID'), scannerSecret('ASSET_SCAN_RECEIPT_PRIVATE_KEY_PEM')] },
        { name: 'clamav', image: `registry.example.com/clamav@${imageDigests.clamav}`, startupProbe: { exec: { command: ['sh', '-c', 'clamdscan --ping 1'] } }, readinessProbe: { exec: { command: ['sh', '-c', 'clamdscan --ping 1 && find /var/lib/clamav -mmin -1440'] } }, livenessProbe: { exec: { command: ['sh', '-c', 'clamdscan --ping 1'] } } },
      ] } } } },
      { apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: 'merchant-ui' }, spec: { template: { spec: { containers: [{ name: 'ui', image: `registry.example.com/merchant-ui@${imageDigests['merchant-ui']}` }] } } } },
      { apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: 'merchant-ops-ui' }, spec: { template: { spec: { containers: [{ name: 'ops-ui', image: `registry.example.com/merchant-ops-ui@${imageDigests['merchant-ops-ui']}` }] } } } },
    ] }))
    const script = 'infra/scripts/deploy-preflight.sh'
    const base = { PRODUCTION_CONFIG_PATH: config, CAPABILITY_EVIDENCE_PATH: evidence, CAPACITY_REPORT_PATH: capacity, MODEL_RELAY_EVIDENCE_PATH: relayEvidence, CODEX_APP_HOST_EVIDENCE_PATH: hostEvidence, OBJECT_STORAGE_EVIDENCE_PATH: storageEvidence, CANONICAL_CUTOVER_EVIDENCE_PATH: canonicalCutoverEvidence, PRODUCTION_EVIDENCE_ARTIFACT_ROOT: directory, EXPECTED_MIGRATION_VERSION: '078', RELEASE_MANIFEST_PATH: releaseManifest, PAYMENT_EVIDENCE_PATH: paymentEvidence, RESTORE_EVIDENCE_PATH: restoreEvidence, RENDERED_MANIFEST_PATH: manifest, RELEASE_ID: 'release-1', IMAGE_DIGESTS_JSON: JSON.stringify(imageDigests), API_IMAGE_REF: `registry.example.com/merchant-api@${imageDigests['merchant-api']}`, WORKER_IMAGE_REF: `registry.example.com/merchant-worker@${imageDigests['merchant-worker']}`, DATABASE_URL: 'postgresql://db.internal/merchant?sslmode=verify-full', OPS_DATABASE_URL: 'postgresql://ops-db.internal/merchant?sslmode=verify-full', REDIS_URL: 'rediss://redis.internal', SECRET_PROVIDER: 'vault' }
    expect(() => run(script, [config], base)).toThrow(/scanner|merchant-worker-scan|ConfigMap\/merchant-runtime/i)
    const matchingManifest = readFileSync(manifest, 'utf8')
    const driftedManifest = JSON.parse(matchingManifest)
    driftedManifest.items[0].data.MODEL_RELAY_BASE_URL = 'https://different-relay.example.com'
    const driftedRuntimeCanonical = `merchant-runtime\n${Object.entries(driftedManifest.items[0].data as Record<string, string>).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([key, value]) => `data.${key}=${value}\n`).join('')}`
    const driftedAnnotation = `sha256:${createHash('sha256').update(driftedRuntimeCanonical).digest('hex')}`
    for (const item of driftedManifest.items) {
      const containers = item.spec?.template?.spec?.containers
      if (containers?.some((container: any) => container.envFrom?.some((source: any) => source.configMapRef?.name === 'merchant-runtime'))) item.spec.template.metadata.annotations['merchant.example.com/config-sha256'] = driftedAnnotation
    }
    writeFileSync(manifest, JSON.stringify(driftedManifest))
    expect(() => run(script, [config], base)).toThrow(/production config and rendered manifest mismatch: model_relay_base_url/)
    writeFileSync(manifest, matchingManifest)
    writeFileSync(config, readFileSync(config, 'utf8').replace('xiaohongshu_write_enabled: true', '# xiaohongshu_write_enabled: true'))
    expect(() => run(script, [config], base)).toThrow(/xiaohongshu/)
    writeFileSync(config, readFileSync(config, 'utf8').replace('# xiaohongshu_write_enabled: true', 'xiaohongshu_write_enabled: true'))
    writeFileSync(config, readFileSync(config, 'utf8').replace('xiaohongshu_write_enabled: true', 'xiaohongshu_write_enabled: false'))
    expect(() => run(script, [config], base)).toThrow(/xiaohongshu/)
    writeFileSync(config, readFileSync(config, 'utf8').replace('xiaohongshu_write_enabled: false', 'xiaohongshu_write_enabled: true'))
    expect(() => run(script, [config], { ...base, IMAGE_DIGESTS_JSON: '{"merchant-api":"latest"}' })).toThrow()
    expect(() => run(script, [config], { ...base, DATABASE_URL: 'postgres://127.0.0.1/merchant' })).toThrow()
    expect(() => run(script, [config], { ...base, DATABASE_URL: 'postgres://127.0.0.2/merchant?sslmode=verify-full' })).toThrow(/DATABASE_URL.*local/)
    expect(() => run(script, [config], { ...base, OPS_DATABASE_URL: 'postgresql://ops-db.internal/merchant' })).toThrow(/OPS_DATABASE_URL.*TLS/)
    expect(() => run(script, [config], { ...base, OPS_DATABASE_URL: 'postgresql:\/\/localhost\/merchant?sslmode=verify-full' })).toThrow(/OPS_DATABASE_URL.*local/)
    expect(() => run(script, [config], { ...base, OPS_DATABASE_URL: 'postgresql://127.0.0.9/merchant?sslmode=verify-full' })).toThrow(/OPS_DATABASE_URL.*local/)
    expect(() => run(script, [config], { ...base, REDIS_URL: 'redis://redis.internal' })).toThrow()
    writeFileSync(relayEvidence, readFileSync(relayEvidence, 'utf8').replace('https://relay.example.com', 'https://other-relay.example.com'))
    expect(() => run(script, [config], base)).toThrow(/scanner|merchant-worker-scan|ConfigMap\/merchant-runtime/i)
    writeFileSync(relayEvidence, readFileSync(relayEvidence, 'utf8').replace('https://other-relay.example.com', 'https://relay.example.com'))
    expect(() => run(script, [config], { ...base, RENDERED_MANIFEST_PATH: join(directory, 'missing.yaml') })).toThrow()
    writeFileSync(manifest, 'image: REPLACE_ME/merchant-api:0.1.0')
    expect(() => run(script, [config], base)).toThrow()
  }, 120_000)

  it('provides one fail-closed launch preflight entrypoint', () => {
    expect(readFileSync('infra/scripts/launch-preflight.sh', 'utf8')).toContain('validate-production-config.sh')
    expect(readFileSync('infra/scripts/launch-preflight.sh', 'utf8')).toContain('production-ops-gate.ts')
    expect(readFileSync('infra/scripts/launch-preflight.sh', 'utf8')).toContain('deploy-preflight.sh')
    const deployPreflight = readFileSync('infra/scripts/deploy-preflight.sh', 'utf8')
    expect(deployPreflight).toContain('codex-app-host-evidence-gate.ts')
    expect(deployPreflight.match(/model-relay-evidence-gate\.ts[^\n]*/g)?.every(line => line.includes('--require-artifacts'))).toBe(true)
    expect(deployPreflight.match(/codex-app-host-evidence-gate\.ts[^\n]*/g)?.every(line => line.includes('--require-artifacts'))).toBe(true)
    expect(deployPreflight).toContain('--expected-mcp-base-url')
    expect(deployPreflight).toContain('--expected-bridge-sha256')
    expect(deployPreflight).toContain('release-manifest-gate.ts')
    expect(deployPreflight).toContain('validate-rendered-production-config.rb')
    expect(deployPreflight).toContain('validate-scanner-contract.rb')
    expect(deployPreflight.indexOf('validate-rendered-production-config.rb')).toBeLessThan(deployPreflight.indexOf('capability-evidence-gate.ts'))
    expect(deployPreflight.indexOf('validate-scanner-contract.rb')).toBeLessThan(deployPreflight.indexOf('capability-evidence-gate.ts'))
    for (const binding of ['--artifact-root', '--public-key', '--key-id', '--capability-evidence', '--capacity-evidence', '--model-relay-evidence', '--payment-evidence', '--restore-evidence', '--object-storage-evidence', '--codex-app-host-evidence', '--canonical-cutover-evidence']) expect(deployPreflight).toContain(binding)
    expect(() => run('infra/scripts/launch-preflight.sh', [], { PRODUCTION_CONFIG_PATH: '/not-found' })).toThrow()
    expect(() => run('infra/scripts/launch-preflight.sh', [], { PRODUCTION_CONFIG_PATH: '/not-found', SKIP_LOCAL_OPS_GATE: 'true', NODE_ENV: 'production' })).toThrow(/SKIP_LOCAL_OPS_GATE/)
    expect(() => run('infra/scripts/launch-preflight.sh', [], { PRODUCTION_CONFIG_PATH: '/not-found', SKIP_LOCAL_OPS_GATE: 'true', NODE_ENV: 'test' })).toThrow(/SKIP_LOCAL_OPS_GATE.*forbidden/)
    expect(() => run('infra/scripts/deploy-preflight.sh', [], { VITEST: 'true', NODE_ENV: 'production' })).toThrow(/VITEST.*NODE_ENV=test/)
  })

  it('deploys the exact verified manifest bytes instead of re-rendering kustomize', () => {
    const script = readFileSync('infra/scripts/deploy-verified-manifest.sh', 'utf8')
    expect(script).toContain('kubectl apply -f "$RENDERED_MANIFEST_PATH"')
    expect(script).not.toContain('kubectl apply -k')
    expect(script).toContain('[ "$before" = "$after" ]')
    expect(script).toContain('verified_config=$(mktemp')
    expect(script).toContain('[ "$config_source_before" = "$config_source_after" ]')
    expect(script).toContain('[ "$config_before" = "$config_after" ]')
    expect(script).toContain('PRODUCTION_CONFIG_PATH=$verified_config')
    expect(script).toContain('merchant.example.com/deployment-phase=migration')
    expect(script).toContain('kubectl wait --for=condition=complete job/merchant-schema-migration')
    expect(script).toContain('kubectl rollout status')
    expect(script).toContain('merchant-worker-reconcile merchant-worker-automation merchant-worker-scan')
    expect(script).toContain('WORKER_ROLE=generation')
    expect(script).toContain('WORKER_ROLE=scan')
    expect(script).not.toContain('WORKER_ROLE=all')
    expect(script).toContain('scanner acceptance requires at least two deployed scanner pods')
    expect(script).toContain('scanner-heartbeat/1.0')
    expect(script).toContain('Eicar-Test-Signature')
    expect(script).toContain('x-scanner-timestamp')
    expect(script).toContain('x-scanner-nonce')
    expect(script).toContain('x-scanner-body-sha256')
    expect(script).toContain('scanner HMAC nonces are not unique per request')
    expect(script).toContain('run-production-canary.sh')
    expect(script).toContain('/readyz')
    expect(execFileSync('sh', ['-n', 'infra/scripts/deploy-verified-manifest.sh'], { encoding: 'utf8' })).toBe('')
  })

  it('isolates owner migration credentials from runtime pods and disables startup migrations', () => {
    const migration = readFileSync('infra/kubernetes/base/migration.yaml', 'utf8')
    const runtimeConfig = readFileSync('infra/kubernetes/base/configmap.yaml', 'utf8')
    const api = readFileSync('infra/kubernetes/base/api.yaml', 'utf8')
    const workers = readFileSync('infra/kubernetes/base/workers.yaml', 'utf8')
    expect(migration).toContain('name: merchant-migration-secrets')
    expect(migration).toContain('dist/apps/api/src/migrate.js')
    expect(runtimeConfig).toContain('RUN_MIGRATIONS_ON_STARTUP: "false"')
    expect(api).not.toContain('merchant-migration-secrets')
    expect(workers).not.toContain('merchant-migration-secrets')
    expect(api).not.toContain('secretRef:')
    expect(workers).not.toContain('secretRef:')
    expect(api).toContain('key: SESSION_ID_HASH_SECRET')
    expect(api).not.toContain('key: MERCHANT_UI_API_TOKEN')
    for (const role of ['SYNC', 'GENERATION', 'PUBLISH', 'RECONCILE', 'AUTOMATION']) {
      expect(workers).toContain(`secretKeyRef: {name: merchant-runtime-secrets, key: WORKER_${role}_API_TOKEN}`)
      expect(workers).toContain(`secretKeyRef: {name: merchant-runtime-secrets, key: WORKER_${role}_API_SIGNING_SECRET}`)
    }
    expect(api).toContain('secretKeyRef: {name: merchant-runtime-secrets, key: WORKER_API_CREDENTIALS}')
    expect(workers).not.toContain('key: WORKER_API_TOKEN}')
    expect(workers).not.toContain('key: WORKER_API_SIGNING_SECRET}')
    expect(workers).not.toContain('key: API_AUTH_TOKENS')
    expect(workers).not.toContain('key: OIDC_PROXY_SIGNING_SECRET')
    expect(workers).not.toContain('key: OPS_DATABASE_URL')
    expect(readFileSync('infra/kubernetes/base/ui.yaml', 'utf8')).toContain('secretKeyRef: {name: merchant-runtime-secrets, key: MERCHANT_UI_API_TOKEN}')
    expect(readFileSync('infra/kubernetes/secret-contract.example.yaml', 'utf8')).toContain('neverExposeSecretAsConfigMap')
    expect(readFileSync('infra/kubernetes/base/kustomization.yaml', 'utf8')).toContain('- migration.yaml')
    expect(readFileSync('infra/kubernetes/base/ingress.yaml', 'utf8')).toContain('hosts: [merchant.example.com, ops.merchant.example.com]')
    for (const profile of ['pilot-50', 'wave-100', 'wave-250', 'target-500']) {
      const overlay = readFileSync(`infra/kubernetes/overlays/${profile}/kustomization.yaml`, 'utf8')
      expect(overlay).toContain('digest: SET_API_IMAGE_DIGEST')
      expect(overlay).toContain('digest: SET_WORKER_IMAGE_DIGEST')
      expect(overlay).toContain('digest: SET_UI_IMAGE_DIGEST')
      expect(overlay).toContain('digest: SET_OPS_UI_IMAGE_DIGEST')
    }
  })

  it('keeps the Merchant Studio API proxy resolvable in both Compose and Kubernetes', () => {
    const nginx = readFileSync('infra/nginx/merchant-studio.conf', 'utf8')
    const compose = readFileSync('infra/local/docker-compose.yml', 'utf8')
    const ingress = readFileSync('infra/kubernetes/base/ingress.yaml', 'utf8')
    expect(nginx).toContain('resolver ${MERCHANT_API_RESOLVER} valid=10s')
    expect(nginx).toContain('set $merchant_api_host merchant-api')
    expect(nginx).toContain('rewrite ^/api/(.*)$ /$1 break')
    expect(nginx).toContain('proxy_pass http://$merchant_api_host:8787')
    expect(compose).toContain('aliases: [merchant-api]')
    expect(compose).toContain('"actor_id":"actor_demo"')
    expect(compose).toContain('/ops/seed-demo.sql')
    expect(readFileSync('infra/local/seed-demo.sql', 'utf8')).toContain("set_config('app.workspace_id', 'ws_demo', true)")
    expect(ingress).toContain('path: /v1')
    expect(ingress).toContain('name: merchant-api')
  })

  it('builds the local API image once and reuses it for the replica', () => {
    const compose = readFileSync('infra/local/docker-compose.yml', 'utf8')
    expect(compose).toContain('image: local-api')
    expect(compose).toContain('build: !reset null')
    const rendered = JSON.parse(execFileSync('docker', ['compose', '-f', 'infra/local/docker-compose.yml', 'config', '--format', 'json'], { encoding: 'utf8' })) as { services: Record<string, { image?: string; build?: unknown }> }
    expect(rendered.services.api?.image).toBe('local-api')
    expect(rendered.services['api-replica']?.image).toBe('local-api')
    expect(rendered.services.api?.build).toBeTruthy()
    expect(rendered.services['api-replica']?.build).toBeUndefined()
  })

  it('injects the Merchant Studio bearer token only at container startup', () => {
    const nginx = readFileSync('infra/nginx/merchant-studio.conf', 'utf8')
    const dockerfile = readFileSync('infra/docker/ui.Dockerfile', 'utf8')
    const entrypoint = readFileSync('infra/nginx/merchant-studio-entrypoint.sh', 'utf8')
    const kubernetes = readFileSync('infra/kubernetes/base/ui.yaml', 'utf8')
    expect(nginx).toContain('${MERCHANT_API_TOKEN}')
    expect(nginx).not.toContain('pilot-local-token')
    expect(dockerfile).toContain('/etc/nginx/merchant-studio.conf.template')
    expect(dockerfile).toContain('40-merchant-studio-token.sh')
    expect(entrypoint).toContain("envsubst '${MERCHANT_API_TOKEN} ${MERCHANT_API_RESOLVER}'")
    expect(entrypoint).toContain("awk '/^nameserver[[:space:]]+/{print $2; exit}' /etc/resolv.conf")
    expect(entrypoint).toContain('/etc/nginx/merchant-studio.conf.template')
    expect(kubernetes).toContain('key: MERCHANT_UI_API_TOKEN')
    expect(kubernetes).toContain('mountPath: /tmp')
    expect(kubernetes).toContain('name: tmp, emptyDir: {sizeLimit: 16Mi}')
    expect(kubernetes).toContain('mountPath: /etc/nginx/conf.d')
    expect(kubernetes).toContain('name: nginx-conf, emptyDir: {sizeLimit: 1Mi}')
    expect(kubernetes).toContain('mountPath: /var/cache/nginx')
    expect(kubernetes).toContain('name: nginx-cache, emptyDir: {sizeLimit: 16Mi}')
    expect(kubernetes).toContain('mountPath: /var/run')
    expect(kubernetes).toContain('name: nginx-run, emptyDir: {sizeLimit: 1Mi}')
  })

  it('keeps the read-only Ops Console Nginx runtime writable at its cache and pid paths', () => {
    const kubernetes = readFileSync('infra/kubernetes/base/ops-ui.yaml', 'utf8')
    const dockerfile = readFileSync('infra/docker/ops-console.Dockerfile', 'utf8')
    const nginx = readFileSync('infra/nginx/ops-console.conf', 'utf8')
    expect(kubernetes).toContain('readOnlyRootFilesystem: true')
    expect(kubernetes).toContain('mountPath: /etc/nginx/conf.d')
    expect(kubernetes).toContain('name: nginx-conf, emptyDir: {sizeLimit: 1Mi}')
    expect(kubernetes).toContain('mountPath: /var/cache/nginx')
    expect(kubernetes).toContain('name: nginx-cache, emptyDir: {sizeLimit: 16Mi}')
    expect(kubernetes).toContain('mountPath: /var/run')
    expect(kubernetes).toContain('name: nginx-run, emptyDir: {sizeLimit: 1Mi}')
    expect(kubernetes.match(/path: \/healthz/g)?.length).toBe(2)
    expect(kubernetes).toContain('path: /readyz')
    expect(kubernetes).toContain('name: OPS_API_UPSTREAM, value: http://merchant-api:8787')
    expect(dockerfile).toContain('ARG VITE_API_BASE')
    expect(dockerfile).toContain('AS validate')
    expect(dockerfile).toContain('FROM validate AS build')
    expect(dockerfile).not.toContain('ARG VITE_API_BASE=')
    expect(dockerfile).toContain('api_base="${VITE_API_BASE:-}"')
    expect(dockerfile).toContain('test -n "$api_base"')
    expect(dockerfile).not.toContain('ARG VITE_OPS_AUTH_MODE')
    expect(dockerfile).toContain('auth_mode=oidc')
    expect(dockerfile).toContain('auth_mode=local')
    expect(dockerfile).toContain('OPS_CONSOLE_BUILD_MODE=production')
    expect(dockerfile).toContain('http://localhost:*|http://127.0.0.1:*')
    expect(dockerfile).toContain('/etc/nginx/templates/default.conf.template')
    expect(dockerfile).toContain('8080/healthz')
    expect(dockerfile).not.toMatch(/ARG\s+\w*TOKEN/iu)
    expect(nginx).toContain('location = /healthz')
    expect(nginx).toContain('location /api/')
    expect(nginx).toContain('set $ops_api_upstream ${OPS_API_UPSTREAM}')
    expect(nginx).toContain('proxy_pass $ops_api_upstream')
    expect(nginx).toContain('proxy_set_header Authorization $http_authorization')
    expect(nginx).toContain('proxy_set_header Cookie $http_cookie')
    expect(nginx).not.toMatch(/proxy_set_header\s+Authorization\s+["']?Bearer/iu)
    expect(nginx).not.toMatch(/Bearer\s+[A-Za-z0-9._-]+/u)
    const healthLocation = nginx.split('location = /healthz {')[1]?.split('}')[0] ?? ''
    expect(healthLocation).toContain('return 200 "ok\\n"')
    expect(healthLocation).not.toContain('try_files')
  })

  it('keeps the API image build context complete for the TypeScript project references', () => {
    const dockerfile = readFileSync('infra/docker/api.Dockerfile', 'utf8')
    const workerDockerfile = readFileSync('infra/docker/worker.Dockerfile', 'utf8')
    expect(dockerfile).toContain('COPY scripts ./scripts')
    expect(readFileSync('package-lock.json', 'utf8')).toContain('packages/knowledge')
    expect(readFileSync('package-lock.json', 'utf8')).toContain('packages/multimodal')
    expect(workerDockerfile).toContain('COPY scripts ./scripts')
    for (const runtimeDockerfile of [dockerfile, workerDockerfile]) {
      expect(runtimeDockerfile).toContain('COPY --from=build /app/packages ./packages')
      expect(runtimeDockerfile).toContain('mkdir -p node_modules/@merchant-marketing')
      expect(runtimeDockerfile).toContain('ln -sfn "../../$package_dir" "node_modules/$package_name"')
      expect(runtimeDockerfile.indexOf('COPY --from=build /app/packages ./packages')).toBeLessThan(runtimeDockerfile.indexOf('mkdir -p node_modules/@merchant-marketing'))
    }
  })

  it('rebuilds every exported package alongside the root build', () => {
    const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as { scripts?: { build?: string; 'build:packages'?: string } }
    expect(packageJson.scripts?.build).toContain('npm run build:packages')
    for (const packageName of ['config', 'contracts', 'knowledge', 'multimodal', 'persistence', 'storage']) {
      expect(packageJson.scripts?.['build:packages']).toContain(`@merchant-marketing/${packageName}`)
    }
    const persistenceSource = readFileSync('packages/persistence/src/subscription-repository.ts', 'utf8')
    const persistenceDist = readFileSync('packages/persistence/dist/subscription-repository.js', 'utf8')
    const staleSubscriptionProjection = 'price_cny::float8 AS "priceCny", payment_amount_cny::float8 AS "paymentAmountCny", included_stores'
    const sourceGet = persistenceSource.split('  async get(')[1]?.split('  async createOrder(')[0] ?? ''
    const distGet = persistenceDist.split('    async get(')[1]?.split('    async createOrder(')[0] ?? ''
    expect(sourceGet).not.toContain(staleSubscriptionProjection)
    expect(distGet).not.toContain(staleSubscriptionProjection)
  })

  it('exits the API container when persistence cannot initialize', () => {
    const server = readFileSync('apps/api/src/server.ts', 'utf8')
    expect(server).toContain('process.exit(1)')
    expect(server).toContain('Do not leave a live Node process with no listener')
  })

  it('bounds Worker database connection attempts during dependency outages', () => {
    expect(readFileSync('apps/worker/src/main.ts', 'utf8')).toContain('WORKER_DB_CONNECTION_TIMEOUT_MS')
    expect(readFileSync('infra/kubernetes/base/configmap.yaml', 'utf8')).toContain('WORKER_DB_CONNECTION_TIMEOUT_MS: "3000"')
    expect(readFileSync('infra/local/docker-compose.yml', 'utf8')).toContain('WORKER_DB_CONNECTION_TIMEOUT_MS: 3000')
  })

  it('derives backup-restore migration expectations from the checked-in migrations', () => {
    const script = readFileSync('tests/backup-restore-acceptance.sh', 'utf8')
    expect(script).toContain('packages/persistence/src/migrations')
    expect(script).toContain('expected_schema_versions=')
    expect(script).not.toContain("test \"$schema_versions\" = '1,2,3,4,5,6,7,8,9,10,11,12'")
    expect(execFileSync('sh', ['-n', 'tests/backup-restore-acceptance.sh'], { encoding: 'utf8' })).toBe('')
  })

  it('writes database backups through a verified temporary file and atomic rename', () => {
    const script = readFileSync('infra/scripts/backup-postgres.sh', 'utf8')
    expect(script).toContain('temporary=$(mktemp "$BACKUP_DIR/.merchant-${timestamp}.XXXXXX.dump")')
    expect(script).toContain('trap cleanup EXIT HUP INT TERM')
    expect(script).toContain('test -s "$temporary"')
    expect(script).toContain('sha256sum "$temporary" > "$temporary_checksum"')
    expect(script).toContain('mv -f -- "$temporary" "$output"')
    expect(script).toContain('mv -f -- "$temporary_checksum" "$output.sha256"')
    expect(script).toContain('rm -f -- "$temporary" "$temporary_checksum"')
    expect(execFileSync('sh', ['-n', 'infra/scripts/backup-postgres.sh'], { encoding: 'utf8' })).toBe('')
  })

  it('derives Compose acceptance migration expectations from the migration loader', () => {
    const script = readFileSync('tests/compose-acceptance.ts', 'utf8')
    const runner = readFileSync('tests/run-compose-acceptance.sh', 'utf8')
    expect(script).toContain('loadMigrations')
    expect(script).toContain('expectedMigrationVersions')
    expect(script).not.toContain('Array.from({ length: 37 }')
    expect(script).toMatch(/'worker-scan', 'clamav'/u)
    expect(runner).toContain('--env-file "$repo_root/.env"')
    expect(runner).toMatch(/ui ops-ui clamav/u)
    expect(runner).toMatch(/worker-automation worker-scan/u)
    expect(runner).toContain('COMPOSE_ACCEPTANCE_SKIP_BUILD')
    expect(runner).toContain('for service in api ui ops-ui')
    expect(runner).toContain('for service in worker-sync worker-generation worker-publish worker-reconcile worker-automation worker-scan')
    expect(runner).not.toMatch(/up -d --build/u)
    expect(runner.match(/compose up -d --no-build/g)).toHaveLength(2)
  })

  it('rejects rendered Kubernetes images without the release digest', () => {
    const directory = mkdtempSync(join(tmpdir(), 'merchant-image-gate-'))
    const manifest = join(directory, 'rendered.yaml')
    const digest = 'sha256:' + 'b'.repeat(64)
    const deployment = (image: string) => ['apiVersion: apps/v1', 'kind: Deployment', 'metadata: {name: api}', 'spec:', '  template:', '    spec:', `      containers: [{name: api, image: ${image}}]`].join('\n')
    writeFileSync(manifest, deployment(`registry.example.com/merchant-api@${digest}`))
    expect(run('infra/scripts/validate-kubernetes-release.sh', [manifest, digest])).toContain('manifest gate passed')
    writeFileSync(manifest, deployment('registry.example.com/merchant-api:0.1.0'))
    expect(() => run('infra/scripts/validate-kubernetes-release.sh', [manifest, digest])).toThrow()
    writeFileSync(manifest, `# ${deployment(`registry.example.com/merchant-api@${digest}`).replaceAll('\n', '\n# ')}`)
    expect(() => run('infra/scripts/validate-kubernetes-release.sh', [manifest, digest])).toThrow(/no resources|no supported workload container image/)
  })
})
