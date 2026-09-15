import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

type Service = { environment?: Record<string, string> }
type ComposeConfig = { services: Record<string, Service> }

const paymentEnvironment = {
  PAYMENT_MODE: 'provider',
  PAYMENT_PROVIDER_ADAPTERS: 'alipay',
  PAYMENT_CHECKOUT_BASE_URL: 'https://pay.example.test',
  PAYMENT_PROVIDER_CHECKOUT_API_URL: 'https://pay.example.test/v1/checkout',
  PAYMENT_PROVIDER_QUERY_API_URL: 'https://pay.example.test/v1/query',
  PAYMENT_PROVIDER_REFUND_API_URL: 'https://pay.example.test/v1/refund',
  PAYMENT_PROVIDER_API_KEY: 'test-provider-key',
  PAYMENT_PROVIDER_MERCHANT_ID: 'test-alipay-merchant',
  PAYMENT_CALLBACK_BASE_URL: 'https://api.example.test/v1',
  PAYMENT_CALLBACK_SECRET: 'test-callback-secret',
  PAYMENT_RECONCILIATION_ENABLED: 'true',
  PAYMENT_REFUND_ENABLED: 'true',
  ALIPAY_APP_ID: 'test-alipay-app',
  MERCHANT_API_TOKEN: 'test-merchant-token',
  MERCHANT_WORKSPACE_ID: 'ws_pilot_parity',
  ASSET_STORAGE_BUCKET: 'merchant-assets',
  ASSET_STORAGE_REGION: 'cn-beijing',
  ASSET_STORAGE_ENDPOINT: 'https://s3.oss-cn-beijing.aliyuncs.com',
  ASSET_STORAGE_SSE_MODE: 'AES256',
  ASSET_STORAGE_KMS_KEY_ID: '',
  ASSET_STORAGE_ECS_RAM_ROLE: 'merchant-oss-role',
  ASSET_STORAGE_QUOTA_BYTES: '50000000000',
  OBJECT_STORAGE_VERSIONING: 'true',
  DATA_RETENTION_DAYS: '90',
  ASSET_QUARANTINE_RETENTION_DAYS: '7',
  ASSET_CLEAN_RETENTION_DAYS: '90',
  DELETION_REQUEST_GRACE_DAYS: '7',
  BACKUP_RETENTION_DAYS: '30',
  LIFECYCLE_POLICY_REF: 'oss://merchant-assets/lifecycle/assets',
  ALERT_CHANNEL_SECRET_REF: 'vault://merchant-alert-channel',
  ASSET_SCANNER_API_TOKEN: 'scanner-api-token',
  ASSET_SCANNER_WORKSPACE_SIGNING_SECRET: 'scanner-workspace-secret',
  ASSET_SCAN_TRUSTED_PUBLIC_KEYS: '{"prod-scanner-key":"public-key"}',
  ASSET_SCAN_APPROVED_SCANNER_SERVICE_IDS: 'merchant-asset-scanner-production',
  ASSET_SCAN_MIN_DEFINITIONS_VERSION: '28000',
  ASSET_SCAN_POLICY_VERSION: 'scan-policy-2026-09-14',
  ASSET_SCAN_RECEIPT_KEY_ID: 'prod-scanner-key',
  ASSET_SCAN_RECEIPT_PRIVATE_KEY_PEM_B64: 'cHJpdmF0ZS1rZXk=',
  ASSET_SCANNER_SERVICE_ID: 'merchant-asset-scanner-production',
}

const requiredPaymentKeys = [
  'PAYMENT_MODE',
  'PAYMENT_PROVIDER_ADAPTERS',
  'PAYMENT_CHECKOUT_BASE_URL',
  'PAYMENT_PROVIDER_CHECKOUT_API_URL',
  'PAYMENT_PROVIDER_QUERY_API_URL',
  'PAYMENT_PROVIDER_REFUND_API_URL',
  'PAYMENT_PROVIDER_API_KEY',
  'PAYMENT_PROVIDER_MERCHANT_ID',
  'PAYMENT_CALLBACK_BASE_URL',
  'PAYMENT_CALLBACK_SECRET',
  'PAYMENT_RECONCILIATION_ENABLED',
  'PAYMENT_REFUND_ENABLED',
] as const

const requiredStorageKeys = ['ASSET_STORAGE_BUCKET', 'ASSET_STORAGE_REGION', 'ASSET_STORAGE_ENDPOINT', 'ASSET_STORAGE_ECS_RAM_ROLE', 'ASSET_STORAGE_QUOTA_BYTES'] as const

const requiredScannerKeys = [
  'ASSET_SCANNER_API_TOKEN', 'ASSET_SCANNER_WORKSPACE_SIGNING_SECRET',
  'ASSET_SCAN_TRUSTED_PUBLIC_KEYS', 'ASSET_SCAN_APPROVED_SCANNER_SERVICE_IDS',
  'ASSET_SCAN_MIN_DEFINITIONS_VERSION', 'ASSET_SCAN_POLICY_VERSION',
  'ASSET_SCAN_RECEIPT_KEY_ID', 'ASSET_SCAN_RECEIPT_PRIVATE_KEY_PEM_B64',
  'ASSET_SCANNER_SERVICE_ID',
] as const

const storageAndLifecycleKeys = [
  'ASSET_STORAGE_BUCKET',
  'ASSET_STORAGE_REGION',
  'ASSET_STORAGE_ENDPOINT',
  'ASSET_STORAGE_SSE_MODE',
  'ASSET_STORAGE_KMS_KEY_ID',
  'ASSET_STORAGE_CREDENTIAL_PROVIDER',
  'ASSET_STORAGE_ECS_RAM_ROLE',
  'ASSET_STORAGE_QUOTA_BYTES',
  'OBJECT_STORAGE_VERSIONING',
  'DATA_RETENTION_DAYS',
  'ASSET_QUARANTINE_RETENTION_DAYS',
  'ASSET_CLEAN_RETENTION_DAYS',
  'DELETION_REQUEST_GRACE_DAYS',
  'BACKUP_RETENTION_DAYS',
  'LIFECYCLE_POLICY_REF',
] as const

const platformAndVaultKeys = [
  'CONNECTOR_FIXTURE_MODE',
  'VAULT_ADDR', 'VAULT_TOKEN', 'VAULT_KV_MOUNT', 'VAULT_NAMESPACE', 'VAULT_CREDENTIAL_PATH_PREFIX',
  ...['JD', 'TAOBAO', 'TMALL', 'PDD', 'XHS', 'DOUYIN'].flatMap(prefix => [
    `${prefix}_AUTH_ENABLED`, `${prefix}_READ_ENABLED`, `${prefix}_WRITE_ENABLED`,
    `${prefix}_OAUTH_AUTHORIZE_URL`, `${prefix}_OAUTH_TOKEN_URL`, `${prefix}_OAUTH_REDIRECT_URI`,
    `${prefix}_API_BASE_URL`, `${prefix}_SYNC_PATH`, `${prefix}_CREATE_PATH`, `${prefix}_UPDATE_PATH`, `${prefix}_QUERY_PATH`,
  ]),
  'JD_APP_KEY', 'JD_APP_SECRET', 'TAOBAO_APP_KEY', 'TAOBAO_APP_SECRET',
  'TMALL_CLIENT_ID', 'TMALL_CLIENT_SECRET', 'TMALL_OAUTH_REFRESH_URL', 'TMALL_OAUTH_REVOKE_URL', 'TMALL_OAUTH_SCOPES',
  'PDD_APP_KEY', 'PDD_APP_SECRET', 'XHS_CLIENT_ID', 'XHS_CLIENT_SECRET', 'DOUYIN_CLIENT_ID', 'DOUYIN_CLIENT_SECRET',
] as const

function render(overrides: NodeJS.ProcessEnv = {}): ComposeConfig {
  return JSON.parse(execFileSync('docker', [
    'compose',
    '-f', 'infra/local/docker-compose.yml',
    '-f', 'infra/local/docker-compose.ecs-pilot.yml',
    'config', '--format', 'json',
  ], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: { ...process.env, ...paymentEnvironment, ...overrides },
    stdio: ['ignore', 'pipe', 'pipe'],
  })) as ComposeConfig
}

describe('ECS pilot API replica parity', () => {
  it.each(requiredPaymentKeys)('fails closed when %s is absent', (key) => {
    expect(() => render({ [key]: '' })).toThrow(new RegExp(`${key}.*required`))
  })

  it.each(requiredStorageKeys)('fails closed when %s is absent', (key) => {
    expect(() => render({ [key]: '' })).toThrow(new RegExp(`${key}.*required`))
  })

  it.each(requiredScannerKeys)('fails closed when scanner setting %s is absent', (key) => {
    expect(() => render({ [key]: '' })).toThrow(new RegExp(`${key}.*required`))
  })

  it('binds both APIs and the scan worker to the same production scanner identity and policy', () => {
    const services = render().services
    for (const service of ['api', 'api-replica']) {
      expect(services[service]?.environment).toMatchObject({
        ALLOW_LOCAL_ASSET_SCAN_FIXTURE: 'false',
        ASSET_SCANNER_MODE: 'clamav_worker',
        ASSET_SCAN_APPROVED_SCANNER_SERVICE_IDS: 'merchant-asset-scanner-production',
        ASSET_SCAN_POLICY_VERSION: 'scan-policy-2026-09-14',
      })
    }
    expect(services['worker-scan']?.environment).toMatchObject({
      ASSET_SCANNER_SERVICE_ID: 'merchant-asset-scanner-production',
      ASSET_SCAN_RECEIPT_KEY_ID: 'prod-scanner-key',
      ASSET_SCAN_POLICY_VERSION: 'scan-policy-2026-09-14',
      SCANNER_DEFINITIONS_MAX_AGE_SECONDS: '86400',
      CLAMAV_DEFINITIONS_MAX_AGE_SECONDS: '86400',
    })
  })

  it('supports OSS AES256 without a KMS key on both API instances', () => {
    const services = render({ ASSET_STORAGE_SSE_MODE: 'AES256', ASSET_STORAGE_KMS_KEY_ID: '' }).services
    const api = services.api?.environment
    const replica = services['api-replica']?.environment

    expect(api?.ASSET_STORAGE_SSE_MODE).toBe('AES256')
    expect(api?.ASSET_STORAGE_KMS_KEY_ID).toBe('')
    expect(replica?.ASSET_STORAGE_SSE_MODE).toBe('AES256')
    expect(replica?.ASSET_STORAGE_KMS_KEY_ID).toBe('')
  })

  it('keeps every OSS and lifecycle field identical on the API replica', () => {
    const services = render().services
    const api = services.api?.environment
    const replica = services['api-replica']?.environment

    expect(api).toBeDefined()
    expect(replica).toBeDefined()
    for (const key of storageAndLifecycleKeys) {
      expect(replica?.[key], `${key} must match the primary API`).toBe(api?.[key])
    }
  })

  it('passes reviewed platform and Vault configuration to both API instances', () => {
    const services = render({
      VAULT_ADDR: 'https://vault.example.test', VAULT_TOKEN: 'test-vault-token',
      JD_APP_KEY: 'jd-key', JD_APP_SECRET: 'jd-secret',
      JD_OAUTH_AUTHORIZE_URL: 'https://jd.example.test/oauth/authorize',
      JD_OAUTH_TOKEN_URL: 'https://jd.example.test/oauth/token',
      JD_OAUTH_REDIRECT_URI: 'https://yxsona.com/v1/oauth/callback/jd',
      JD_API_BASE_URL: 'https://jd.example.test/api', JD_AUTH_ENABLED: 'true', JD_READ_ENABLED: 'true',
    }).services
    for (const key of platformAndVaultKeys) {
      expect(services.api?.environment?.[key], `${key} must be present on primary API`).toBeDefined()
      expect(services['api-replica']?.environment?.[key], `${key} must match the primary API`).toBe(services.api?.environment?.[key])
    }
    expect(services.api?.environment?.CONNECTOR_FIXTURE_MODE).toBe('false')
    expect(services.api?.environment?.JD_APP_KEY).toBe('jd-key')
    expect(services.api?.environment?.VAULT_ADDR).toBe('https://vault.example.test')
  })

  it('renders the same public and payment configuration on both API instances', () => {
    const services = render().services
    const api = services.api?.environment
    const replica = services['api-replica']?.environment
    const invariantKeys = [
      'PUBLIC_APP_BASE_URL',
      'MCP_OAUTH_ISSUER',
      'MCP_OAUTH_AUTHORIZATION_ENDPOINT',
      'MCP_OAUTH_TOKEN_ENDPOINT',
      'OPENAI_APPS_CHALLENGE_TOKEN',
      'PUBLIC_ASSET_BASE_URL',
      'PUBLIC_OAUTH_REDIRECT_URI',
      'MERCHANT_BEARER_HOSTNAME',
      'ALLOWED_ORIGINS',
      'PAYMENT_MODE',
      'PAYMENT_PROVIDER_ADAPTERS',
      'PAYMENT_CHECKOUT_BASE_URL',
      'PAYMENT_PROVIDER_CHECKOUT_API_URL',
      'PAYMENT_PROVIDER_QUERY_API_URL',
      'PAYMENT_PROVIDER_REFUND_API_URL',
      'PAYMENT_PROVIDER_API_KEY',
      'PAYMENT_PROVIDER_MERCHANT_ID',
      'PAYMENT_CALLBACK_BASE_URL',
      'PAYMENT_CALLBACK_SECRET',
      'PAYMENT_RECONCILIATION_ENABLED',
      'PAYMENT_REFUND_ENABLED',
      'PAYMENT_ONE_FEN_TEST_ENABLED',
      'PAYMENT_ONE_FEN_TEST_WORKSPACE_ID',
      'COMMERCIAL_PAYMENT_PROVIDER',
      'NODE_ENV',
      'DEPLOYMENT_PROFILE',
      'ALLOW_LOCAL_DURABLE_OBJECT_STORAGE',
      'ASSET_STORAGE_BUCKET',
      'ASSET_STORAGE_REGION',
      'ASSET_STORAGE_ENDPOINT',
      'ASSET_STORAGE_KMS_KEY_ID',
      'ASSET_STORAGE_SSE_MODE',
      'ASSET_STORAGE_CREDENTIAL_PROVIDER',
      'ASSET_STORAGE_ECS_RAM_ROLE',
      'OBJECT_STORAGE_VERSIONING',
      'DATA_RETENTION_DAYS',
      'ASSET_QUARANTINE_RETENTION_DAYS',
      'ASSET_CLEAN_RETENTION_DAYS',
      'DELETION_REQUEST_GRACE_DAYS',
      'BACKUP_RETENTION_DAYS',
      'LIFECYCLE_POLICY_REF',
      'ALERT_CHANNEL_SECRET_REF',
    ]

    expect(api).toBeDefined()
    expect(replica).toBeDefined()
    for (const key of invariantKeys) expect(replica?.[key]).toBe(api?.[key])
    expect(services['payment-gateway']?.environment?.PAYMENT_GATEWAY_API_KEY)
      .toBe(api?.PAYMENT_PROVIDER_API_KEY)
  })
})
