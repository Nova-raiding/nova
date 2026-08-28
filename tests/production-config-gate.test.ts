import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const script = join(process.cwd(), 'infra/scripts/validate-production-config.sh')
const flags = [
  'jd_auth_enabled', 'jd_read_enabled', 'jd_write_enabled',
  'taobao_tmall_auth_enabled', 'taobao_tmall_read_enabled', 'taobao_tmall_write_enabled',
  'pinduoduo_auth_enabled', 'pinduoduo_read_enabled', 'pinduoduo_write_enabled',
]
const socialFlags = [
  'xiaohongshu_auth_enabled', 'xiaohongshu_read_enabled', 'xiaohongshu_write_enabled',
  'douyin_auth_enabled', 'douyin_read_enabled', 'douyin_write_enabled',
]

function config(overrides: Record<string, boolean> = {}) {
  return [
    'plugin_enabled: true', 'merchant_bearer_hostname: merchant.example.com',
    'OPS_AUTH_MODE: oidc',
    'auth_enforcement: strict',
    'session_id_hash_secret_ref: vault://merchant-identity/session-id-hash-secret',
    ...flags.map(flag => `${flag}: ${overrides[flag] === false ? 'false' : 'true'}`),
    ...socialFlags.map(flag => `${flag}: ${overrides[flag] === true ? 'true' : 'false'}`),
    'point_in_time_recovery_enabled: true',
    'database_pooler_enabled: true',
    'database_max_backend_connections: 300',
    'database_connection_utilization_alert_percent: 80',
    'secret_provider: vault',
    'worker_api_signing_secret: vault://worker-api-signing',
    'payment_mode: provider',
    'payment_provider_adapters: alipay,wechat',
    'payment_checkout_base_url: https://payments.example.com/checkout',
    'payment_provider_checkout_api_url: https://payments.example.com/v1/checkout',
    'payment_provider_query_api_url: https://payments.example.com/v1/query',
    'payment_provider_refund_api_url: https://payments.example.com/v1/refund',
    'payment_provider_api_key_ref: vault://merchant-payment/provider-api-key',
    'payment_provider_merchant_id: merchant-example',
    'payment_callback_base_url: https://merchant.example.com/v1',
    'payment_callback_secret_ref: vault://merchant-payment-callback',
    'payment_reconciliation_enabled: true',
    'payment_refund_enabled: true',
    'model_relay_base_url: https://relay.example.com',
    'model_relay_api_key_ref: vault://merchant-model/relay-api-key',
    'text_model: merchant-text-v1',
    'image_model: merchant-image-v1',
    'image_edit_model: merchant-image-edit-v1',
    'ocr_model: merchant-ocr-v1',
    'video_model: merchant-video-v1',
    'approved_requests_per_minute: "100"',
    'approved_tokens_per_minute: "100000"',
    'maximum_task_cost_cny: "0.50"',
    'platform_rule_sync_manifest_url: https://rules.example.com/platform-rules/v1/manifest.json',
    'platform_rule_sync_signing_secret_ref: vault://merchant-rules/manifest-signing-secret',
    'platform_rule_sync_interval_hours: "24"',
    'object_storage_bucket: merchant-assets',
    'object_storage_region: cn',
    'object_storage_endpoint: https://s3.example.com',
    'object_storage_kms_key: vault://kms', 'merchant_ui_api_token_ref: vault://merchant-ui/api-token',
    'object_storage_versioning: true',
    'lifecycle_policy_ref: vault://asset-lifecycle-policy',
    'asset_quarantine_retention_days: 7',
    'asset_clean_retention_days: 90',
    'deletion_request_grace_days: 7',
    'backup_retention_days: 30',
    'alert_channel_secret_ref: vault://merchant-alert-channel',
  ].join('\n')
}

function run(value: string) {
  const directory = mkdtempSync(join(tmpdir(), 'merchant-production-gate-'))
  const path = join(directory, 'rendered.yaml')
  writeFileSync(path, value)
  return () => execFileSync('sh', [script, path], { encoding: 'utf8', stdio: 'pipe' })
}

describe('production config gate', () => {
  it('requires all four platform capability flag groups', () => {
    expect(run(config())()).toContain('production config gate passed')
    expect(() => run(config({ pinduoduo_write_enabled: false }))()).toThrow()
  })

  it('rejects a partial social-platform rollout', () => {
    expect(() => run(config({ xiaohongshu_auth_enabled: true }))()).toThrow(/xiaohongshu/)
    expect(() => run(config({ douyin_read_enabled: true, douyin_auth_enabled: true }))()).toThrow(/douyin/)
    expect(run(config({
      xiaohongshu_auth_enabled: true,
      xiaohongshu_read_enabled: true,
      xiaohongshu_write_enabled: true,
      douyin_auth_enabled: true,
      douyin_read_enabled: true,
      douyin_write_enabled: true,
    }))()).toContain('production config gate passed')
  })

  it('accepts the nested production-config OIDC spelling used by the release document', () => {
    const nested = config().replace('OPS_AUTH_MODE: oidc', 'auth_mode: "oidc_gateway_hmac"')
    expect(run(nested)()).toContain('production config gate passed')
  })

  it('rejects unresolved Secret Manager placeholders', () => {
    expect(() => run(`${config()}\ndatabase_url: \"\${SECRET:DATABASE_URL}\"`)()).toThrow()
  })

  it('does not treat full-line comments as rendered production settings', () => {
    const commented = config().split('\n').map(line => `# ${line}`).join('\n')
    expect(() => run(commented)()).toThrow(/plugin_enabled/)
  })

  it('does not treat inline comments as rendered production settings', () => {
    const commented = `${config().replace('plugin_enabled: true\n', '')}\nplaceholder: false # plugin_enabled: true`
    expect(() => run(commented)()).toThrow(/plugin_enabled/)
  })

  it('does not treat a quoted value containing a field name as a rendered setting', () => {
    const quoted = `${config().replace('plugin_enabled: true\n', '')}\nplaceholder: "plugin_enabled: true"`
    expect(() => run(quoted)()).toThrow(/plugin_enabled/)
  })

  it('does not treat a quoted authentication mode as a rendered setting', () => {
    const quoted = `${config().replace('OPS_AUTH_MODE: oidc\n', '')}\nplaceholder: "OPS_AUTH_MODE: oidc"`
    expect(() => run(quoted)()).toThrow(/OIDC|auth/i)
  })

  it('rejects incomplete lifecycle and alert-channel policy', () => {
    expect(() => run(config().replace('object_storage_versioning: true\n', ''))()).toThrow(/versioning/)
    expect(() => run(config().replace('alert_channel_secret_ref: vault://merchant-alert-channel', ''))()).toThrow(/alert_channel/)
  })

  it('requires a provider query endpoint for payment status reconciliation', () => {
    expect(() => run(config().replace('payment_provider_query_api_url: https://payments.example.com/v1/query\n', ''))()).toThrow(/payment_provider_query_api_url/)
    expect(() => run(config().replace('payment_provider_query_api_url: https://payments.example.com/v1/query', 'payment_provider_query_api_url: http://payments.example.com/v1/query'))()).toThrow(/payment_provider_query_api_url/)
  })

  it('does not echo rendered secret-bearing lines when rejecting config', () => {
    try {
      run(`${config()}\napi_auth_tokens: super-secret-value\nvalue: SET_DATABASE_URL`)()
      throw new Error('expected production config gate to reject')
    } catch (error) {
      const stderr = String((error as { stderr?: unknown }).stderr ?? '')
      expect(stderr).not.toContain('super-secret-value')
    }
  })
})
