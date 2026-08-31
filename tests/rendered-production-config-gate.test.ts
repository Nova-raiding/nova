import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const config = () => ({
  merchant_bearer_hostname: 'merchant.production.test',
  public_endpoints: { app_base_url: 'https://merchant.production.test', ops_base_url: 'https://ops.production.test', oauth_callback_base_url: 'https://merchant.production.test/v1/oauth/callback' },
  codex: { mcp: { base_url: 'https://merchant.production.test' } },
  mcp_authorization_mode: 'enforce',
  durable_platform_assignments_required: true,
  model_relay_base_url: 'https://relay.production.test/v1',
  text_model: 'text-v1', image_model: 'image-v1', image_edit_model: 'image-edit-v1', ocr_model: 'ocr-v1', video_model: 'video-v1',
  approved_requests_per_minute: 120, approved_tokens_per_minute: 120000, maximum_task_cost_cny: '10.00',
  object_storage_bucket: 'merchant-production-assets', object_storage_region: 'cn-prod-1', object_storage_endpoint: 'https://storage.production.test', object_storage_versioning: true,
  asset_display_base_url: 'https://merchant.production.test', asset_quarantine_retention_days: 7, asset_clean_retention_days: 90, deletion_request_grace_days: 7, backup_retention_days: 30,
  lifecycle_policy_ref: 'policy://production/assets-v1', asset_scanner_mode: 'clamav_worker', allow_local_asset_scan_fixture: false,
  asset_scan_policy_version: 'scan-policy-v1', clamav_signature_max_age_minutes: 1440, clamav_max_file_bytes: 52428800,
  payment_mode: 'provider', payment_provider_adapters: 'alipay,wechat', payment_checkout_base_url: 'https://payments.production.test/checkout',
  payment_provider_checkout_api_url: 'https://payments.production.test/v1/checkout', payment_provider_query_api_url: 'https://payments.production.test/v1/query', payment_provider_refund_api_url: 'https://payments.production.test/v1/refund',
  payment_provider_merchant_id: 'merchant-production', payment_callback_base_url: 'https://merchant.production.test/v1', payment_reconciliation_enabled: true, payment_refund_enabled: true,
  platform_rule_sync_manifest_url: 'https://rules.production.test/platform-rules/v1/manifest.json', platform_rule_sync_interval_hours: 24,
})

const manifest = () => ({ apiVersion: 'v1', kind: 'List', items: [
  { apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'merchant-runtime' }, data: {
    MERCHANT_BEARER_HOSTNAME: 'merchant.production.test', MCP_AUTHZ_MODE: 'enforce', AUTHZ_DURABLE_ASSIGNMENTS_REQUIRED: 'true',
    MODEL_RELAY_BASE_URL: 'https://relay.production.test/v1', MODEL_RELAY_ALLOWED_HOSTS: 'relay.production.test',
    AI_MODEL: 'text-v1', IMAGE_MODEL: 'image-v1', IMAGE_EDIT_MODEL: 'image-edit-v1', OCR_MODEL: 'ocr-v1', VIDEO_MODEL: 'video-v1', MODEL_RPM_LIMIT: '120', MODEL_TPM_LIMIT: '120000', MODEL_MAX_TASK_COST_CNY: '10.00',
    ASSET_STORAGE_BUCKET: 'merchant-production-assets', ASSET_STORAGE_REGION: 'cn-prod-1', ASSET_STORAGE_ENDPOINT: 'https://storage.production.test', OBJECT_STORAGE_VERSIONING: 'true',
    PUBLIC_ASSET_BASE_URL: 'https://merchant.production.test', PUBLIC_OAUTH_REDIRECT_URI: 'https://merchant.production.test/v1/oauth/callback/{platform}',
    ASSET_QUARANTINE_RETENTION_DAYS: '7', ASSET_CLEAN_RETENTION_DAYS: '90', DELETION_REQUEST_GRACE_DAYS: '7', BACKUP_RETENTION_DAYS: '30', LIFECYCLE_POLICY_REF: 'policy://production/assets-v1',
    ASSET_SCANNER_MODE: 'clamav_worker', ALLOW_LOCAL_ASSET_SCAN_FIXTURE: 'false', ASSET_SCAN_POLICY_VERSION: 'scan-policy-v1', CLAMAV_SIGNATURE_MAX_AGE_MINUTES: '1440', CLAMAV_MAX_FILE_BYTES: '52428800', PLATFORM_RULE_SYNC_INTERVAL_HOURS: '24',
    PAYMENT_MODE: 'provider', PAYMENT_PROVIDER_ADAPTERS: 'alipay,wechat', PAYMENT_CHECKOUT_BASE_URL: 'https://payments.production.test/checkout',
    PAYMENT_PROVIDER_CHECKOUT_API_URL: 'https://payments.production.test/v1/checkout', PAYMENT_PROVIDER_QUERY_API_URL: 'https://payments.production.test/v1/query', PAYMENT_PROVIDER_REFUND_API_URL: 'https://payments.production.test/v1/refund',
    PAYMENT_PROVIDER_MERCHANT_ID: 'merchant-production', PAYMENT_CALLBACK_BASE_URL: 'https://merchant.production.test/v1', PAYMENT_RECONCILIATION_ENABLED: 'true', PAYMENT_REFUND_ENABLED: 'true',
    PLATFORM_RULE_SYNC_MANIFEST_URL: 'https://rules.production.test/platform-rules/v1/manifest.json',
  } },
  { apiVersion: 'networking.k8s.io/v1', kind: 'Ingress', metadata: { name: 'merchant' }, spec: {
    tls: [{ hosts: ['merchant.production.test', 'ops.production.test'], secretName: 'merchant-tls' }],
    rules: [
      { host: 'merchant.production.test', http: { paths: [
        { path: '/mcp', pathType: 'Exact', backend: { service: { name: 'merchant-api', port: { name: 'http' } } } },
        { path: '/v1', pathType: 'Prefix', backend: { service: { name: 'merchant-api', port: { name: 'http' } } } },
        { path: '/', pathType: 'Prefix', backend: { service: { name: 'merchant-ui', port: { name: 'http' } } } },
      ] } },
      { host: 'ops.production.test', http: { paths: [{ path: '/', pathType: 'Prefix', backend: { service: { name: 'merchant-ops-ui', port: { name: 'http' } } } }] } },
    ],
  } },
] })

function run(configDocument: unknown, manifestDocument: unknown) {
  const directory = mkdtempSync(join(tmpdir(), 'merchant-config-manifest-binding-'))
  const configPath = join(directory, 'production.yaml')
  const manifestPath = join(directory, 'rendered.yaml')
  writeFileSync(configPath, typeof configDocument === 'string' ? configDocument : JSON.stringify(configDocument))
  writeFileSync(manifestPath, typeof manifestDocument === 'string' ? manifestDocument : JSON.stringify(manifestDocument))
  return () => execFileSync('ruby', ['infra/scripts/validate-rendered-production-config.rb', configPath, manifestPath], { encoding: 'utf8', stdio: 'pipe' })
}

describe('production config and rendered manifest binding gate', () => {
  it('binds the checked-in runtime and ingress contract in every production scale overlay', () => {
    const overlayConfig = {
      ...config(),
      merchant_bearer_hostname: 'merchant.example.com',
      public_endpoints: { app_base_url: 'https://merchant.example.com', ops_base_url: 'https://ops.merchant.example.com', oauth_callback_base_url: 'https://merchant.example.com/v1/oauth/callback' },
      codex: { mcp: { base_url: 'https://merchant.example.com' } },
      model_relay_base_url: 'https://model-relay.example.com/v1', text_model: 'merchant-main-text', image_model: 'merchant-main-image', image_edit_model: 'merchant-main-image-edit', ocr_model: 'merchant-vision-ocr', video_model: 'merchant-video',
      approved_requests_per_minute: 0, approved_tokens_per_minute: 0, maximum_task_cost_cny: '0.00',
      object_storage_region: 'cn', object_storage_endpoint: 'https://s3.cn.example-provider.com', asset_display_base_url: 'https://merchant.example.com',
      lifecycle_policy_ref: 'vault://merchant-asset-lifecycle-policy', asset_scan_policy_version: '2026-08-30',
      payment_checkout_base_url: 'https://payments.example.com/checkout', payment_provider_checkout_api_url: 'https://payments.example.com/v1/checkout', payment_provider_query_api_url: 'https://payments.example.com/v1/query', payment_provider_refund_api_url: 'https://payments.example.com/v1/refund', payment_provider_merchant_id: 'merchant-example', payment_callback_base_url: 'https://merchant.example.com/v1',
      platform_rule_sync_manifest_url: 'https://rules.example.com/platform-rules/v1/manifest.json',
    }
    for (const overlay of ['pilot-50', 'wave-100', 'wave-250', 'target-500']) {
      const rendered = execFileSync('kustomize', ['build', `infra/kubernetes/overlays/${overlay}`], { encoding: 'utf8', stdio: 'pipe' })
      expect(run(overlayConfig, rendered)()).toContain('binding gate passed')
    }
  })

  it('accepts one exact non-secret runtime and ingress projection', () => {
    expect(run(config(), manifest())()).toContain('binding gate passed')
  })

  it.each([
    ['model_relay_base_url', 'MODEL_RELAY_BASE_URL'],
    ['object_storage_endpoint', 'ASSET_STORAGE_ENDPOINT'],
    ['merchant_bearer_hostname', 'MERCHANT_BEARER_HOSTNAME'],
    ['approved_requests_per_minute', 'MODEL_RPM_LIMIT'],
    ['asset_scan_policy_version', 'ASSET_SCAN_POLICY_VERSION'],
    ['payment_mode', 'PAYMENT_MODE'],
    ['payment_provider_adapters', 'PAYMENT_PROVIDER_ADAPTERS'],
    ['payment_checkout_base_url', 'PAYMENT_CHECKOUT_BASE_URL'],
    ['payment_provider_checkout_api_url', 'PAYMENT_PROVIDER_CHECKOUT_API_URL'],
    ['payment_provider_query_api_url', 'PAYMENT_PROVIDER_QUERY_API_URL'],
    ['payment_provider_refund_api_url', 'PAYMENT_PROVIDER_REFUND_API_URL'],
    ['payment_provider_merchant_id', 'PAYMENT_PROVIDER_MERCHANT_ID'],
    ['payment_callback_base_url', 'PAYMENT_CALLBACK_BASE_URL'],
    ['payment_reconciliation_enabled', 'PAYMENT_RECONCILIATION_ENABLED'],
    ['payment_refund_enabled', 'PAYMENT_REFUND_ENABLED'],
    ['platform_rule_sync_manifest_url', 'PLATFORM_RULE_SYNC_MANIFEST_URL'],
  ])('rejects drift between %s and %s without echoing values', (configKey, runtimeKey) => {
    const rendered = manifest()
    const runtime = rendered.items[0]!.data as Record<string, string>
    runtime[runtimeKey] = 'drifted-value'
    expect(run(config(), rendered)).toThrow(new RegExp(`mismatch: ${configKey} -> ${runtimeKey}`, 'u'))
  })

  it.each([
    'PAYMENT_MODE', 'PAYMENT_PROVIDER_ADAPTERS', 'PAYMENT_CHECKOUT_BASE_URL',
    'PAYMENT_PROVIDER_CHECKOUT_API_URL', 'PAYMENT_PROVIDER_QUERY_API_URL', 'PAYMENT_PROVIDER_REFUND_API_URL',
    'PAYMENT_PROVIDER_MERCHANT_ID', 'PAYMENT_CALLBACK_BASE_URL', 'PAYMENT_RECONCILIATION_ENABLED', 'PAYMENT_REFUND_ENABLED',
    'PLATFORM_RULE_SYNC_MANIFEST_URL',
  ])('rejects a missing required runtime projection %s', runtimeKey => {
    const rendered = manifest()
    delete (rendered.items[0]!.data as Record<string, string>)[runtimeKey]
    expect(run(config(), rendered)).toThrow(new RegExp(`missing: ${runtimeKey}`, 'u'))
  })

  it('rejects a widened relay allowlist and missing merchant TLS/routing', () => {
    const widened = manifest()
    ;(widened.items[0]!.data as Record<string, string>).MODEL_RELAY_ALLOWED_HOSTS = 'relay.production.test,evil.test'
    expect(run(config(), widened)).toThrow(/must exactly match/)

    const noTls = manifest()
    ;(noTls.items[1]!.spec as any).tls = []
    expect(run(config(), noTls)).toThrow(/TLS does not cover/)

    const noMcp = manifest()
    ;(noMcp.items[1]!.spec as any).rules[0].http.paths = []
    expect(run(config(), noMcp)).toThrow(/Exact \/mcp/)
  })

  it('binds the Codex root origin and the isolated ops ingress', () => {
    const wrongMcp = config()
    wrongMcp.codex.mcp.base_url = 'https://mcp.production.test'
    expect(run(wrongMcp, manifest())).toThrow(/plugin appends \/mcp/)

    const opsMcp = manifest()
    ;(opsMcp.items[1]!.spec as any).rules[1].http.paths.unshift({ path: '/mcp', pathType: 'Exact', backend: { service: { name: 'merchant-api', port: { name: 'http' } } } })
    expect(run(config(), opsMcp)).toThrow(/ops host must not expose \/mcp/)

    const wrongOpsUi = manifest()
    ;(wrongOpsUi.items[1]!.spec as any).rules[1].http.paths[0].backend.service.name = 'merchant-ui'
    expect(run(config(), wrongOpsUi)).toThrow(/merchant-ops-ui/)
  })

  it.each([
    ['payment_callback_base_url', 'https://other.production.test/v1'],
    ['payment_provider_query_api_url', 'http://payments.production.test/v1/query'],
    ['platform_rule_sync_manifest_url', 'https://rules.production.test/manifest.json?token=secret'],
    ['platform_rule_sync_manifest_url', 'https://127.0.0.1/manifest.json'],
  ])('rejects unsafe or misrouted URL field %s', (field, value) => {
    expect(run({ ...config(), [field]: value }, manifest())).toThrow(new RegExp(field, 'u'))
  })

  it('rejects ambiguous leaves, duplicate YAML keys, and aliases', () => {
    expect(run({ ...config(), nested: { model_relay_base_url: 'https://second.test/v1' } }, manifest())).toThrow(/ambiguous: model_relay_base_url/)
    expect(run('merchant_bearer_hostname: merchant.production.test\nmerchant_bearer_hostname: other.test\n', manifest())).toThrow(/duplicate YAML key/)
    expect(run('merchant_bearer_hostname: &host merchant.production.test\nalias: *host\n', manifest())).toThrow(/aliases are forbidden/)
  })
})
