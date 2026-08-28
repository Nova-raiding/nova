import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { REQUIRED_CAPABILITIES, REQUIRED_PLATFORMS } from './capability-evidence-gate.js'
import { signProductionEvidence } from './production-evidence-gate.js'

function run(script: string, args: string[] = [], env: Record<string, string> = {}) {
  return execFileSync('sh', [script, ...args], { encoding: 'utf8', env: { ...process.env, ...env }, stdio: 'pipe' })
}

describe('deployment operation scripts', () => {
  it('keeps read-only worker containers writable only through the readiness volume', () => {
    const manifest = readFileSync('infra/kubernetes/base/workers.yaml', 'utf8')
    expect(manifest.match(/automountServiceAccountToken: false/g)).toHaveLength(5)
    for (const role of ['sync', 'generation', 'publish', 'reconcile', 'automation']) {
      expect(manifest).toContain(`WORKER_ROLE, value: ${role}`)
      expect(manifest).toContain(`WORKER_READY_FILE, value: /tmp/merchant-worker-${role}-ready`)
      expect(manifest).toContain(`name: tmp, mountPath: /tmp`)
      expect(manifest).toContain(`name: tmp, emptyDir: {sizeLimit: 64Mi}`)
      expect(manifest).toContain('readOnlyRootFilesystem: true')
      expect(manifest).toContain('readinessProbe:')
    }
  })

  it('protects every isolated worker pool from voluntary disruption', () => {
    const manifest = readFileSync('infra/kubernetes/base/workers.yaml', 'utf8')
    for (const role of ['sync', 'generation', 'publish', 'reconcile', 'automation']) {
      expect(manifest).toContain(`metadata: {name: merchant-worker-${role}}`)
      expect(manifest).toContain(`selector: {matchLabels: {app.kubernetes.io/name: merchant-worker-${role}}}`)
    }
    expect(manifest.match(/kind: PodDisruptionBudget/g)).toHaveLength(5)
  })

  it('serializes shell-based migration runners across deployment replicas', () => {
    expect(readFileSync('infra/scripts/apply-migrations.sh', 'utf8')).toContain('pg_advisory_xact_lock(731942851)')
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
  })

  it('requires explicit rollback confirmation and command inputs', () => {
    const script = 'infra/scripts/rollback.sh'
    expect(() => run(script, [], { RELEASE_ID: 'release-1', ROLLBACK_COMMAND: 'false', CONFIRM_ROLLBACK: 'NO' })).toThrow()
    expect(() => run(script, [], { RELEASE_ID: 'release-1', CONFIRM_ROLLBACK: 'YES' })).toThrow()
    expect(() => run(script, [], { RELEASE_ID: 'release-1;touch /tmp/unsafe', ROLLBACK_COMMAND: 'true', CONFIRM_ROLLBACK: 'YES' })).toThrow(/unsafe/)
  })

  it('requires a checksum sidecar before any destructive restore command', () => {
    const directory = mkdtempSync(join(tmpdir(), 'merchant-restore-gate-'))
    const backup = join(directory, 'merchant.dump')
    writeFileSync(backup, 'not-a-real-dump')
    expect(() => run('infra/scripts/restore-postgres.sh', [], {
      DATABASE_URL: 'postgresql://db.internal/merchant?sslmode=verify-full', BACKUP_FILE: backup, CONFIRM_RESTORE: 'YES',
    })).toThrow(/checksum sidecar/)
  })

  it('blocks deployment without immutable image and production connection metadata', () => {
    const directory = mkdtempSync(join(tmpdir(), 'merchant-preflight-'))
    const config = join(directory, 'production.yaml')
    const evidence = join(directory, 'capability-evidence.json')
    const capacity = join(directory, 'capacity-evidence.json')
    const relayEvidence = join(directory, 'model-relay-evidence.json')
    const paymentEvidence = join(directory, 'payment-evidence.json')
    const restoreEvidence = join(directory, 'restore-evidence.json')
    const manifest = join(directory, 'rendered.yaml')
    const digest = 'sha256:' + 'a'.repeat(64)
    const attestationKey = 'operations-test-attestation-key-32-characters'
    writeFileSync(config, [
      'plugin_enabled: true', 'merchant_bearer_hostname: merchant.example.com', 'OPS_AUTH_MODE: oidc',
      'auth_enforcement: strict', 'session_id_hash_secret_ref: vault://merchant-identity/session-id-hash-secret',
      'jd_auth_enabled: true', 'jd_read_enabled: true', 'jd_write_enabled: true',
      'taobao_tmall_auth_enabled: true', 'taobao_tmall_read_enabled: true', 'taobao_tmall_write_enabled: true',
      'pinduoduo_auth_enabled: true', 'pinduoduo_read_enabled: true', 'pinduoduo_write_enabled: true',
      'xiaohongshu_auth_enabled: true', 'xiaohongshu_read_enabled: true', 'xiaohongshu_write_enabled: true',
      'douyin_auth_enabled: true', 'douyin_read_enabled: true', 'douyin_write_enabled: true',
      'payment_provider_query_api_url: https://payments.example.com/v1/query',
      'point_in_time_recovery_enabled: true', 'database_pooler_enabled: true', 'database_max_backend_connections: 300', 'database_connection_utilization_alert_percent: 80', 'secret_provider: vault', 'worker_api_signing_secret: vault://worker-api-signing', 'payment_mode: provider', 'payment_provider_adapters: alipay,wechat', 'payment_checkout_base_url: https://payments.example.com/checkout', 'payment_provider_checkout_api_url: https://payments.example.com/v1/checkout', 'payment_provider_query_api_url: https://payments.example.com/v1/query', 'payment_provider_refund_api_url: https://payments.example.com/v1/refund', 'payment_provider_api_key_ref: vault://merchant-payment/provider-api-key', 'payment_provider_merchant_id: merchant-example', 'payment_callback_base_url: https://merchant.example.com/v1', 'payment_callback_secret_ref: vault://merchant-payment-callback', 'payment_reconciliation_enabled: true', 'payment_refund_enabled: true', 'model_relay_base_url: https://relay.example.com', 'model_relay_api_key_ref: vault://merchant-model/relay-api-key', 'text_model: merchant-text-v1', 'image_model: merchant-image-v1', 'image_edit_model: merchant-image-edit-v1', 'ocr_model: merchant-ocr-v1', 'video_model: merchant-video-v1', 'approved_requests_per_minute: "100"', 'approved_tokens_per_minute: "100000"', 'maximum_task_cost_cny: "0.50"',
      'object_storage_bucket: merchant-assets', 'object_storage_region: cn', 'object_storage_endpoint: https://s3.example.com', 'object_storage_kms_key: vault://kms', 'merchant_ui_api_token_ref: vault://merchant-ui/api-token', 'object_storage_versioning: true', 'lifecycle_policy_ref: vault://asset-lifecycle-policy', 'asset_quarantine_retention_days: 7', 'asset_clean_retention_days: 90', 'deletion_request_grace_days: 7', 'backup_retention_days: 30', 'alert_channel_secret_ref: vault://merchant-alert-channel',
    ].join('\n'))
    writeFileSync(evidence, JSON.stringify({
      schema_version: '1', release_id: 'release-1', environment: 'production', generated_at: '2026-08-23T00:00:00Z',
      platforms: REQUIRED_PLATFORMS.map(platform => ({ platform, application_id: `${platform}-app`, test_store_id: `${platform}-store`, capabilities: Object.fromEntries(REQUIRED_CAPABILITIES.map(capability => [capability, { state: 'production_canary', evidence_ref: 'artifact://evidence/1', verified_by: 'qa', verified_at: '2026-08-23T00:00:00Z', api_version: 'v1', scope: 'product.read product.write' }])) })),
    }))
    writeFileSync(capacity, JSON.stringify({
      schema_version: '1', status: 'pass', release_id: 'release-1', config_version: 'config-1', environment: 'preproduction', target_url: 'https://capacity.example.com', started_at: '2026-08-23T00:00:00Z', ended_at: '2026-08-23T06:00:00Z', profile: 'pilot_50', cloud_gate: true, raw_metrics_ref: 'artifact://metrics/1', platform_mock_ratio: 0, model_mock_ratio: 0, sign_off: { verified_by: 'qa', verified_at: '2026-08-23T06:00:00Z' }, metrics: { workspaces: 50, client_connections: 150, sustained_rps: 30, sustained_duration_minutes: 30, burst_rps: 60, burst_duration_seconds: 60, async_jobs_per_minute: 50, p95_ms: 100, p99_ms: 150, error_count: 0, duplicate_writes: 0, lost_jobs: 0, fairness_p95_degradation_percent: 10, stability_hours: 6 },
    }))
    writeFileSync(relayEvidence, JSON.stringify({
      schema_version: '1', release_id: 'release-1', generated_at: '2026-08-23T06:00:00Z', relay: 'https://relay.example.com',
      results: ['text', 'image', 'image_edit', 'ocr', 'video'].map(modality => ({ modality, state: 'ready', endpoint: '/probe', model: `merchant-${modality}-v1`, providerRequestId: `req-${modality}`, usageObserved: true, costObserved: true })),
    }))
    const commonEvidence = { schema_version: '1', release_id: 'release-1', image_digest: digest, environment: 'production', status: 'pass', generated_at: new Date().toISOString(), simulated: false, verified_by: 'release-manager@example.com', verified_at: new Date(Date.now() - 60_000).toISOString() }
    const paymentDocument: Record<string, unknown> = { ...commonEvidence, kind: 'payment', provider: 'alipay', amount_cny: 0.01, provider_trade_id_sha256: 'b'.repeat(64), checks: Object.fromEntries(['checkout', 'callback', 'callback_replay', 'provider_query', 'reconciliation', 'refund'].map(name => [name, { status: 'pass', evidence_ref: `artifact://production/payment/${name}` }])) }
    paymentDocument.attestation_hmac_sha256 = signProductionEvidence(paymentDocument, attestationKey)
    writeFileSync(paymentEvidence, JSON.stringify(paymentDocument))
    const restoreDocument: Record<string, unknown> = { ...commonEvidence, kind: 'restore', recovery_target_isolated: true, backup_sha256: 'c'.repeat(64), source_backup_created_at: new Date(Date.now() - 3_600_000).toISOString(), recovery_point_at: new Date(Date.now() - 1_800_000).toISOString(), checks: Object.fromEntries(['backup_checksum', 'isolated_restore', 'migrations', 'data_integrity', 'application_smoke'].map(name => [name, { status: 'pass', evidence_ref: `artifact://production/restore/${name}` }])) }
    restoreDocument.attestation_hmac_sha256 = signProductionEvidence(restoreDocument, attestationKey)
    writeFileSync(restoreEvidence, JSON.stringify(restoreDocument))
    writeFileSync(manifest, [
      `image: registry.example.com/merchant-api@${digest}`,
      `image: registry.example.com/merchant-worker@${digest}`,
      `image: registry.example.com/merchant-ui@${digest}`,
    ].join('\n'))
    const script = 'infra/scripts/deploy-preflight.sh'
    const base = { PRODUCTION_CONFIG_PATH: config, CAPABILITY_EVIDENCE_PATH: evidence, CAPACITY_REPORT_PATH: capacity, MODEL_RELAY_EVIDENCE_PATH: relayEvidence, PAYMENT_EVIDENCE_PATH: paymentEvidence, RESTORE_EVIDENCE_PATH: restoreEvidence, EVIDENCE_ATTESTATION_KEY: attestationKey, RENDERED_MANIFEST_PATH: manifest, RELEASE_ID: 'release-1', IMAGE_DIGEST: digest, DATABASE_URL: 'postgresql://db.internal/merchant?sslmode=verify-full', REDIS_URL: 'rediss://redis.internal', SECRET_PROVIDER: 'vault' }
    expect(run(script, [config], base)).toContain('deploy preflight passed')
    writeFileSync(config, readFileSync(config, 'utf8').replace('xiaohongshu_write_enabled: true', '# xiaohongshu_write_enabled: true'))
    expect(() => run(script, [config], base)).toThrow(/xiaohongshu/)
    writeFileSync(config, readFileSync(config, 'utf8').replace('# xiaohongshu_write_enabled: true', 'xiaohongshu_write_enabled: true'))
    writeFileSync(config, readFileSync(config, 'utf8').replace('xiaohongshu_write_enabled: true', 'xiaohongshu_write_enabled: false'))
    expect(() => run(script, [config], base)).toThrow(/xiaohongshu/)
    writeFileSync(config, readFileSync(config, 'utf8').replace('xiaohongshu_write_enabled: false', 'xiaohongshu_write_enabled: true'))
    expect(() => run(script, [config], { ...base, IMAGE_DIGEST: 'latest' })).toThrow()
    expect(() => run(script, [config], { ...base, DATABASE_URL: 'postgres://127.0.0.1/merchant' })).toThrow()
    expect(() => run(script, [config], { ...base, REDIS_URL: 'redis://redis.internal' })).toThrow()
    writeFileSync(relayEvidence, readFileSync(relayEvidence, 'utf8').replace('https://relay.example.com', 'https://other-relay.example.com'))
    expect(() => run(script, [config], base)).toThrow(/relay|origin/)
    writeFileSync(relayEvidence, readFileSync(relayEvidence, 'utf8').replace('https://other-relay.example.com', 'https://relay.example.com'))
    expect(() => run(script, [config], { ...base, RENDERED_MANIFEST_PATH: join(directory, 'missing.yaml') })).toThrow()
    writeFileSync(manifest, 'image: REPLACE_ME/merchant-api:0.1.0')
    expect(() => run(script, [config], base)).toThrow()
  }, 30_000)

  it('provides one fail-closed launch preflight entrypoint', () => {
    expect(readFileSync('infra/scripts/launch-preflight.sh', 'utf8')).toContain('validate-production-config.sh')
    expect(readFileSync('infra/scripts/launch-preflight.sh', 'utf8')).toContain('production-ops-gate.ts')
    expect(readFileSync('infra/scripts/launch-preflight.sh', 'utf8')).toContain('deploy-preflight.sh')
    expect(() => run('infra/scripts/launch-preflight.sh', [], { PRODUCTION_CONFIG_PATH: '/not-found' })).toThrow()
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
    expect(kubernetes).toContain('readOnlyRootFilesystem: true')
    expect(kubernetes).toContain('mountPath: /var/cache/nginx')
    expect(kubernetes).toContain('name: nginx-cache, emptyDir: {sizeLimit: 16Mi}')
    expect(kubernetes).toContain('mountPath: /var/run')
    expect(kubernetes).toContain('name: nginx-run, emptyDir: {sizeLimit: 1Mi}')
  })

  it('keeps the API image build context complete for the TypeScript project references', () => {
    const dockerfile = readFileSync('infra/docker/api.Dockerfile', 'utf8')
    expect(dockerfile).toContain('COPY scripts ./scripts')
    expect(readFileSync('package-lock.json', 'utf8')).toContain('packages/knowledge')
    expect(readFileSync('package-lock.json', 'utf8')).toContain('packages/multimodal')
    expect(readFileSync('infra/docker/worker.Dockerfile', 'utf8')).toContain('COPY scripts ./scripts')
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

  it('derives Compose acceptance migration expectations from the migration loader', () => {
    const script = readFileSync('tests/compose-acceptance.ts', 'utf8')
    expect(script).toContain('loadMigrations')
    expect(script).toContain('expectedMigrationVersions')
    expect(script).not.toContain('Array.from({ length: 37 }')
  })

  it('rejects rendered Kubernetes images without the release digest', () => {
    const directory = mkdtempSync(join(tmpdir(), 'merchant-image-gate-'))
    const manifest = join(directory, 'rendered.yaml')
    const digest = 'sha256:' + 'b'.repeat(64)
    writeFileSync(manifest, `containers: [{name: api, image: registry.example.com/merchant-api@${digest}}]`)
    expect(run('infra/scripts/validate-kubernetes-release.sh', [manifest, digest])).toContain('manifest gate passed')
    writeFileSync(manifest, 'containers: [{name: api, image: registry.example.com/merchant-api:0.1.0}]')
    expect(() => run('infra/scripts/validate-kubernetes-release.sh', [manifest, digest])).toThrow()
    writeFileSync(manifest, `# containers: [{name: api, image: registry.example.com/merchant-api@${digest}}]`)
    expect(() => run('infra/scripts/validate-kubernetes-release.sh', [manifest, digest])).toThrow(/no container image/)
  })
})
