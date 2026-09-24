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
  require_approved_asset_for_generation: true,
  model_relay_base_url: 'https://relay.production.test/v1',
  text_model: 'text-v1', image_model: 'image-v1', image_edit_model: 'image-edit-v1', ocr_model: 'ocr-v1', video_model: 'video-v1', embedding_model: 'embedding-v1', embedding_dimensions: 1536, embedding_max_request_cny: '0.10', knowledge_vector_index_enabled: false,
  approved_requests_per_minute: 120, approved_tokens_per_minute: 120000, maximum_task_cost_cny: '10.00',
  object_storage_bucket: 'merchant-production-assets', object_storage_region: 'cn-prod-1', object_storage_endpoint: 'https://storage.production.test', object_storage_versioning: true,
  asset_display_base_url: 'https://merchant.production.test', image_artifact_allowed_hosts: 'images.merchant-assets.cn', video_artifact_allowed_hosts: 'videos.merchant-assets.cn', asset_quarantine_retention_days: 7, asset_clean_retention_days: 90, deletion_request_grace_days: 7, backup_retention_days: 30,
  lifecycle_policy_ref: 'policy://production/assets-v1', asset_scanner_mode: 'clamav_worker', allow_local_asset_scan_fixture: false,
  asset_scan_policy_version: 'scan-policy-v1', clamav_signature_max_age_minutes: 1440, clamav_max_file_bytes: 104857600,
  payment_mode: 'provider', payment_provider_adapters: 'alipay', payment_checkout_base_url: 'https://pay.yxsona.com/checkout',
  payment_provider_checkout_api_url: 'https://pay.yxsona.com/v1/checkout', payment_provider_query_api_url: 'https://pay.yxsona.com/v1/query', payment_provider_refund_query_api_url: 'https://pay.yxsona.com/v1/refund/query', payment_provider_refund_api_url: 'https://pay.yxsona.com/v1/refund',
  payment_provider_merchant_id: '2088123456789012', payment_callback_base_url: 'https://merchant.production.test/v1', payment_reconciliation_enabled: true, payment_refund_enabled: true,
  commercial_payment_provider: 'alipay',
  platform_rule_sync_manifest_url: 'https://rules.production.test/platform-rules/v1/manifest.json', platform_rule_sync_interval_hours: 24,
})

function run(configDocument: unknown, manifestDocument: unknown) {
  const directory = mkdtempSync(join(tmpdir(), 'merchant-config-manifest-binding-'))
  const configPath = join(directory, 'production.yaml')
  const manifestPath = join(directory, 'rendered.yaml')
  writeFileSync(configPath, typeof configDocument === 'string' ? configDocument : JSON.stringify(configDocument))
  writeFileSync(manifestPath, typeof manifestDocument === 'string' ? manifestDocument : JSON.stringify(manifestDocument))
  return () => execFileSync('ruby', ['infra/scripts/validate-rendered-production-config.rb', configPath, manifestPath], { encoding: 'utf8', stdio: 'pipe' })
}

describe('production Kubernetes overlay binding gate', () => {
  it('binds the checked-in runtime and ingress contract in every production scale overlay', () => {
    const overlayConfig = {
      ...config(),
      merchant_bearer_hostname: 'yxsona.com',
      public_endpoints: { app_base_url: 'https://yxsona.com', ops_base_url: 'https://ops.yxsona.com', oauth_callback_base_url: 'https://yxsona.com/v1/oauth/callback' },
      codex: { mcp: { base_url: 'https://yxsona.com' } },
      model_relay_base_url: 'https://model-relay.example.com/v1', text_model: 'merchant-main-text', image_model: 'merchant-main-image', image_edit_model: 'merchant-main-image-edit', ocr_model: 'merchant-vision-ocr', video_model: 'merchant-video', embedding_model: 'merchant-embedding', embedding_dimensions: 1536, embedding_max_request_cny: '0.00', knowledge_vector_index_enabled: false,
      approved_requests_per_minute: 0, approved_tokens_per_minute: 0, maximum_task_cost_cny: '0.00',
      object_storage_bucket: 'codex-image-20260914', object_storage_region: 'cn-beijing', object_storage_endpoint: 'https://s3.oss-cn-beijing.aliyuncs.com', asset_display_base_url: 'https://yxsona.com',
      lifecycle_policy_ref: 'vault://merchant-asset-lifecycle-policy', asset_scan_policy_version: '2026-08-30',
      payment_checkout_base_url: 'https://pay.yxsona.com/checkout', payment_provider_checkout_api_url: 'https://pay.yxsona.com/v1/checkout', payment_provider_query_api_url: 'https://pay.yxsona.com/v1/query', payment_provider_refund_query_api_url: 'https://pay.yxsona.com/v1/refund/query', payment_provider_refund_api_url: 'https://pay.yxsona.com/v1/refund', payment_provider_merchant_id: '2088123456789012', payment_callback_base_url: 'https://yxsona.com/v1',
      platform_rule_sync_manifest_url: 'https://rules.example.com/platform-rules/v1/manifest.json',
    }
    for (const overlay of ['pilot-50', 'wave-100', 'wave-250', 'target-500']) {
      const rendered = execFileSync('kustomize', ['build', `infra/kubernetes/overlays/${overlay}`], { encoding: 'utf8', stdio: 'pipe' })
        .replaceAll('https://payments.example.com', 'https://pay.yxsona.com')
        .replaceAll('merchant-example', '2088123456789012')
        // The artifact allowlists are template values too: the binding gate
        // requires each to equal the operator's production config value, so an
        // unsubstituted manifest fails rather than shipping an allowlist that
        // rejects every real artifact host.
        .replaceAll('video-cdn.example.com', 'videos.merchant-assets.cn')
        .replaceAll('image-cdn.example.com', 'images.merchant-assets.cn')
      expect(run(overlayConfig, rendered)()).toContain('binding gate passed')
    }
  })
})
