import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const gate = resolve('infra/scripts/validate-production-config.sh')
const renderer = resolve('infra/scripts/render-production-config-from-env.mjs')
// Synthetic configuration references only; no network, real credentials or deployment.
function completeEnvironment(): Record<string, string> {
  const required = readFileSync(gate, 'utf8').match(/^required_keys='([^']+)'/m)![1]!.split(/\s+/)
  const env = Object.fromEntries(required.map((key, index) => [key.toUpperCase(), key.endsWith('_ref') ? `vault://acceptance/ref-${index}` : 'true']))
  Object.assign(env, {
    MERCHANT_BEARER_HOSTNAME: 'merchant.yxsona.com', AUTH_ENFORCEMENT: 'strict',
    MCP_AUTHORIZATION_MODE: 'enforce', DURABLE_PLATFORM_ASSIGNMENTS_REQUIRED: 'true',
    PLATFORM_OPERATIONS_MODE: 'manual',
    APP_BASE_URL: 'https://merchant.yxsona.com', OPS_BASE_URL: 'https://ops.yxsona.com', MCP_BASE_URL: 'https://merchant.yxsona.com',
    OPS_AUTH_MODE: 'oidc', SECRET_PROVIDER: 'vault', ALLOW_LOCAL_ASSET_SCAN_FIXTURE: 'false', ALERT_NOTIFICATIONS_ENABLED: 'false',
    DATABASE_MAX_BACKEND_CONNECTIONS: '300', DATABASE_CONNECTION_UTILIZATION_ALERT_PERCENT: '80',
    ASSET_SCANNER_MODE: 'clamav_worker', ASSET_SCAN_RECEIPT_KEY_ID: 'scanner-acceptance-v1', ASSET_SCAN_POLICY_VERSION: 'policy-acceptance-v1',
    CLAMAV_IMAGE_DIGEST: `sha256:${'a'.repeat(64)}`, CLAMAV_SIGNATURE_MAX_AGE_MINUTES: '1440', CLAMAV_MAX_FILE_BYTES: '104857600',
    PAYMENT_MODE: 'provider', PAYMENT_PROVIDER_ADAPTERS: 'alipay', PAYMENT_PROVIDER_MERCHANT_ID: '2088123456789012',
    PAYMENT_CHECKOUT_BASE_URL: 'https://pay.yxsona.com/checkout', PAYMENT_CALLBACK_BASE_URL: 'https://merchant.yxsona.com/v1',
    MODEL_RELAY_BASE_URL: 'https://relay.yxsona.com', TEXT_MODEL: 'text-v1', IMAGE_MODEL: 'image-v1', IMAGE_EDIT_MODEL: 'edit-v1', OCR_MODEL: 'ocr-v1', VIDEO_MODEL: 'video-v1',
    EMBEDDING_MODEL: 'embedding-v1', EMBEDDING_DIMENSIONS: '1536', EMBEDDING_MAX_REQUEST_CNY: '0.10', KNOWLEDGE_VECTOR_INDEX_ENABLED: 'true',
    APPROVED_REQUESTS_PER_MINUTE: '100', APPROVED_TOKENS_PER_MINUTE: '100000', MAXIMUM_TASK_COST_CNY: '0.50',
    PLATFORM_RULE_SYNC_MANIFEST_URL: 'https://rules.yxsona.com/manifest.json', PLATFORM_RULE_SYNC_INTERVAL_HOURS: '24',
    OBJECT_STORAGE_BUCKET: 'acceptance-assets', OBJECT_STORAGE_REGION: 'cn', OBJECT_STORAGE_ENDPOINT: 'https://storage.yxsona.com', OBJECT_STORAGE_SSE_MODE: 'AES256',
    ASSET_DISPLAY_BASE_URL: 'https://merchant.yxsona.com', ASSET_QUARANTINE_RETENTION_DAYS: '7', ASSET_CLEAN_RETENTION_DAYS: '90', DELETION_REQUEST_GRACE_DAYS: '7', BACKUP_RETENTION_DAYS: '30',
    RELEASE_ID: 'acceptance-release', ASSET_SCAN_TRUSTED_PUBLIC_KEYS_REF: 'vault://acceptance/trusted-keys',
  })
  for (const key of [
    'JD_AUTH_ENABLED', 'JD_READ_ENABLED', 'JD_WRITE_ENABLED',
    'TAOBAO_TMALL_AUTH_ENABLED', 'TAOBAO_TMALL_READ_ENABLED', 'TAOBAO_TMALL_WRITE_ENABLED',
    'PINDUODUO_AUTH_ENABLED', 'PINDUODUO_READ_ENABLED', 'PINDUODUO_WRITE_ENABLED',
    'XIAOHONGSHU_AUTH_ENABLED', 'XIAOHONGSHU_READ_ENABLED', 'XIAOHONGSHU_WRITE_ENABLED',
    'DOUYIN_AUTH_ENABLED', 'DOUYIN_READ_ENABLED', 'DOUYIN_WRITE_ENABLED',
  ]) env[key] = 'false'
  for (const action of ['CHECKOUT', 'QUERY', 'REFUND_QUERY', 'REFUND']) env[`PAYMENT_PROVIDER_${action}_API_URL`] = `https://pay.yxsona.com/v1/${action.toLowerCase()}`
  return env
}
function withRendered(env: Record<string, string>, check: (result: ReturnType<typeof spawnSync>, config: string, dir: string) => void) {
  const dir = mkdtempSync(resolve(tmpdir(), 'production-render-regression-'))
  try {
    const source = resolve(dir, 'source.env'), output = resolve(dir, 'production.yaml')
    writeFileSync(source, Object.entries(env).map(([key, value]) => `${key}=${value}`).join('\n'))
    const result = spawnSync(process.execPath, [renderer, source, output, gate], { encoding: 'utf8', cwd: dir })
    check(result, existsSync(output) ? readFileSync(output, 'utf8') : '', dir)
  } finally { rmSync(dir, { recursive: true, force: true }) }
}
function validate(config: string, dir: string) {
  const path = resolve(dir, 'validation.yaml'); writeFileSync(path, config)
  return spawnSync('sh', [gate, path], { encoding: 'utf8', timeout: 10_000 })
}
describe('production renderer real-gate contract regressions', () => {
  it('renders complete input accepted by the real production validator', () => {
    withRendered(completeEnvironment(), (result, config, dir) => {
      expect(result.status, String(result.stderr)).toBe(0)
      const validated = validate(config, dir)
      expect(validated.status, String(validated.stderr)).toBe(0)
      expect(config).toContain('payment_mode: "provider"')
      expect(config).toContain('object_storage_bucket: "acceptance-assets"')
      expect(statSync(resolve(dir, 'production.yaml')).mode & 0o777).toBe(0o600)
      expect(JSON.parse(String(result.stdout)).ready).toBe(false)
    })
  })
  it('satisfies the real unquoted OIDC-mode contract', () => {
    withRendered(completeEnvironment(), (_result, config, dir) => {
      // Isolate the OIDC check from the preceding legacy secret-reference grep.
      const ref = completeEnvironment().SESSION_ID_HASH_SECRET_REF!
      const probe = config.replace(`session_id_hash_secret_ref: ${JSON.stringify(ref)}`, `session_id_hash_secret_ref: ${ref}`)
      const result = validate(probe, dir)
      expect(result.status, String(result.stderr)).toBe(0)
      expect(config).toContain('OPS_AUTH_MODE: oidc\n')
      expect(String(validate(probe.replace('OPS_AUTH_MODE: oidc', 'OPS_AUTH_MODE: "oidc"'), dir).stderr)).toContain('OIDC gateway')
    })
  })
  it('preserves enabled alerts, KMS and full social opt-in through the real gate', () => {
    const env: Record<string, string> = { ...completeEnvironment(), PLATFORM_OPERATIONS_MODE: 'official_api', ALERT_NOTIFICATIONS_ENABLED: 'true', ALERT_CHANNEL_SECRET_REF: 'vault://acceptance/alerts', OBJECT_STORAGE_SSE_MODE: 'aws:kms', OBJECT_STORAGE_KMS_KEY: 'kms-key-acceptance' }
    for (const key of ['JD_AUTH_ENABLED', 'JD_READ_ENABLED', 'JD_WRITE_ENABLED', 'TAOBAO_TMALL_AUTH_ENABLED', 'TAOBAO_TMALL_READ_ENABLED', 'TAOBAO_TMALL_WRITE_ENABLED', 'PINDUODUO_AUTH_ENABLED', 'PINDUODUO_READ_ENABLED', 'PINDUODUO_WRITE_ENABLED']) env[key] = 'true'
    for (const platform of ['XIAOHONGSHU', 'DOUYIN']) for (const capability of ['AUTH', 'READ', 'WRITE']) env[`${platform}_${capability}_ENABLED`] = 'true'
    withRendered(env, (result, config, dir) => {
      expect(result.status, String(result.stderr)).toBe(0)
      expect(validate(config, dir).status).toBe(0)
      expect(config).toContain('alert_channel_secret_ref:')
      expect(config).toContain('object_storage_kms_key:')
      expect(config).toContain('douyin_write_enabled: true')
    })
  })
  it.each<{ override: Record<string, string>; missing: string }>([
    { override: { ALERT_NOTIFICATIONS_ENABLED: 'true' }, missing: 'alert_channel_secret_ref' },
    { override: { OBJECT_STORAGE_SSE_MODE: 'aws:kms' }, missing: 'object_storage_kms_key' },
    { override: { XIAOHONGSHU_AUTH_ENABLED: 'true' }, missing: 'xiaohongshu_write_enabled' },
    { override: { DOUYIN_AUTH_ENABLED: 'true', DOUYIN_READ_ENABLED: 'false', DOUYIN_WRITE_ENABLED: 'true' }, missing: 'douyin_read_enabled' },
  ])('blocks missing conditional input $missing', ({ override, missing }) => {
    withRendered({ ...completeEnvironment(), ...override }, (result, config, dir) => {
      expect(result.status).toBe(2)
      expect(JSON.parse(String(result.stdout)).missingKeys).toContain(missing)
      expect(config).toContain('BLOCKED_UNTIL_REQUIRED_PRODUCTION_INPUTS')
      expect(validate(config, dir).status).not.toBe(0)
    })
  })
  it('keeps absent or disabled optional groups out of the missing-key list', () => {
    withRendered({ ...completeEnvironment(), DOUYIN_AUTH_ENABLED: 'false' }, (result, config, dir) => {
      expect(result.status).toBe(0)
      expect(JSON.parse(String(result.stdout)).missingKeys).toEqual([])
      expect(config).not.toContain('object_storage_kms_key:')
      expect(validate(config, dir).status).toBe(0)
    })
  })
  it('accepts known deployment aliases and identical primary/alias values', () => {
    const env = completeEnvironment()
    env.MCP_AUTHZ_MODE = env.MCP_AUTHORIZATION_MODE!; delete env.MCP_AUTHORIZATION_MODE
    env.AUTHZ_DURABLE_ASSIGNMENTS_REQUIRED = env.DURABLE_PLATFORM_ASSIGNMENTS_REQUIRED!; delete env.DURABLE_PLATFORM_ASSIGNMENTS_REQUIRED
    env.PUBLIC_APP_BASE_URL = env.APP_BASE_URL!; delete env.APP_BASE_URL
    env.ASSET_STORAGE_BUCKET = env.OBJECT_STORAGE_BUCKET!
    withRendered(env, (result, config, dir) => { expect(result.status).toBe(0); expect(validate(config, dir).status).toBe(0) })
  })
  it('rejects inconsistent aliases before writing and does not disclose values', () => {
    withRendered({ ...completeEnvironment(), MCP_AUTHZ_MODE: 'private-conflicting-value' }, (result, config) => {
      expect(result.status).toBe(1); expect(config).toBe('')
      expect(String(result.stdout) + String(result.stderr)).not.toContain('private-conflicting-value')
    })
  })
  it('never evaluates environment text or emits raw credential keys', () => {
    withRendered({ ...completeEnvironment(), PLUGIN_ENABLED: '$(touch forbidden)', MODEL_RELAY_API_KEY: 'private-raw-credential' }, (result, config, dir) => {
      expect(result.status).toBe(2); expect(existsSync(resolve(dir, 'forbidden'))).toBe(false)
      expect(config + String(result.stdout) + String(result.stderr)).not.toMatch(/private-raw-credential|touch forbidden/)
    })
  })
})
