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
  PAYMENT_PROVIDER_REFUND_QUERY_API_URL: 'https://pay.example.test/v1/refund/query',
  PAYMENT_PROVIDER_REFUND_API_URL: 'https://pay.example.test/v1/refund',
  PAYMENT_PROVIDER_API_KEY: 'test-provider-key',
  PAYMENT_PROVIDER_MERCHANT_ID: 'test-alipay-merchant',
  PAYMENT_CALLBACK_BASE_URL: 'https://api.example.test/v1',
  PAYMENT_CALLBACK_SECRET: 'test-callback-secret',
  PAYMENT_RECONCILIATION_ENABLED: 'true',
  PAYMENT_REFUND_ENABLED: 'true',
  PAYMENT_PROTECTED_RECEIPT_HOST_DIR: '/tmp/codex-test-payment-receipts',
  ALIPAY_APP_ID: 'test-alipay-app',
  MERCHANT_API_TOKEN: 'test-merchant-token',
  MERCHANT_WORKSPACE_ID: 'ws_pilot_parity',
  CAPABILITY_EVIDENCE_PATH: '/tmp/test-capability-evidence.json',
  CAPACITY_REPORT_PATH: '/tmp/test-capacity-report.json',
  ASSET_STORAGE_BUCKET: 'test-production-bucket',
  ASSET_STORAGE_REGION: 'cn-test',
  ASSET_STORAGE_ENDPOINT: 'https://s3.oss-cn-test.aliyuncs.com',
  ASSET_STORAGE_ECS_RAM_ROLE: 'test-production-role',
  ASSET_STORAGE_QUOTA_BYTES: '50000000000',
  OBJECT_STORAGE_VERSIONING: 'true',
  DATA_RETENTION_DAYS: '90',
  ASSET_QUARANTINE_RETENTION_DAYS: '7',
  ASSET_CLEAN_RETENTION_DAYS: '90',
  DELETION_REQUEST_GRACE_DAYS: '7',
  BACKUP_RETENTION_DAYS: '30',
  LIFECYCLE_POLICY_REF: 'oss://test-assets/lifecycle-v1',
  ASSET_SCANNER_API_TOKEN: 'test-production-scanner-token',
  ASSET_SCANNER_WORKSPACE_SIGNING_SECRET: 'test-production-scanner-signing-secret',
  ASSET_SCAN_TRUSTED_PUBLIC_KEYS: '{"prod-scanner-key":"test-public-key"}',
  ASSET_SCAN_APPROVED_SCANNER_SERVICE_IDS: 'merchant-asset-scanner-production',
  ASSET_SCAN_MIN_DEFINITIONS_VERSION: '28000',
  ASSET_SCAN_POLICY_VERSION: 'scan-policy-2026-09-14',
  ASSET_SCAN_RECEIPT_KEY_ID: 'prod-scanner-key',
  ASSET_SCAN_RECEIPT_PRIVATE_KEY_PEM_B64: 'dGVzdC1wcml2YXRlLWtleQ==',
  ASSET_SCANNER_SERVICE_ID: 'merchant-asset-scanner-production',
  API_AUTH_TOKENS: '{"production-test":{"workspaces":["ws_production_test"],"actor_id":"actor_production_test","bootstrap":false,"workbenches":["workspace"],"roles":["merchant_admin"]}}',
  OPS_AUTH_MODE: 'password',
  SESSION_ID_HASH_SECRET: 'test-production-session-hash-secret',
  WORKER_API_CREDENTIALS: '{"sync":{"token":"prod-sync","signing_secret":"prod-sync-signing"}}',
  ASSET_DISPLAY_URL_SIGNING_SECRET: 'test-production-display-signing-secret',
  ASSET_DISPLAY_URL_SIGNING_KEY_ID: 'display-production',
  WORKER_WORKSPACES: 'auto',
  WORKER_SYNC_API_TOKEN: 'prod-sync-token',
  WORKER_SYNC_API_SIGNING_SECRET: 'prod-sync-signing-secret',
  WORKER_GENERATION_API_TOKEN: 'prod-generation-token',
  WORKER_GENERATION_API_SIGNING_SECRET: 'prod-generation-signing-secret',
  WORKER_PUBLISH_API_TOKEN: 'prod-publish-token',
  WORKER_PUBLISH_API_SIGNING_SECRET: 'prod-publish-signing-secret',
  WORKER_RECONCILE_API_TOKEN: 'prod-reconcile-token',
  WORKER_RECONCILE_API_SIGNING_SECRET: 'prod-reconcile-signing-secret',
  WORKER_AUTOMATION_API_TOKEN: 'prod-automation-token',
  WORKER_AUTOMATION_API_SIGNING_SECRET: 'prod-automation-signing-secret',
  DATABASE_URL: 'postgres://merchant_app:opaque-production-secret@postgres:5432/merchant',
  OPS_DATABASE_URL: 'postgres://merchant_ops:opaque-production-ops-secret@postgres:5432/merchant',
  PGPASSWORD: 'opaque-production-schema-owner-secret',
  MODEL_COST_ESTIMATE_VERSION: 'production-rate-card-2026-09-15',
}

const requiredPaymentKeys = [
  'PAYMENT_MODE',
  'PAYMENT_PROVIDER_ADAPTERS',
  'PAYMENT_CHECKOUT_BASE_URL',
  'PAYMENT_PROVIDER_CHECKOUT_API_URL',
  'PAYMENT_PROVIDER_QUERY_API_URL',
  'PAYMENT_PROVIDER_REFUND_QUERY_API_URL',
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
  // Router-gateway API selectors. They are part of the signed request, so a
  // replica that renders a different value (or none at all) signs a different
  // API — or refuses terminally — for the same operation. Only the platforms
  // whose signers resolve a selector carry them.
  ...['JD', 'TAOBAO', 'TMALL', 'PDD'].flatMap(prefix => [
    `${prefix}_SYNC_METHOD`, `${prefix}_CREATE_METHOD`, `${prefix}_UPDATE_METHOD`, `${prefix}_QUERY_METHOD`, `${prefix}_MEDIA_METHOD`,
  ]),
  'JD_APP_KEY', 'JD_APP_SECRET',
  'TAOBAO_APP_KEY', 'TAOBAO_APP_SECRET', 'TAOBAO_OAUTH_REFRESH_URL', 'TAOBAO_OAUTH_REVOKE_URL', 'TAOBAO_OAUTH_SCOPES',
  'TMALL_CLIENT_ID', 'TMALL_CLIENT_SECRET', 'TMALL_OAUTH_REFRESH_URL', 'TMALL_OAUTH_REVOKE_URL', 'TMALL_OAUTH_SCOPES',
  'PDD_APP_KEY', 'PDD_APP_SECRET', 'XHS_CLIENT_ID', 'XHS_CLIENT_SECRET', 'DOUYIN_CLIENT_ID', 'DOUYIN_CLIENT_SECRET',
] as const

const douyinProductMappingEnvironment = {
  DOUYIN_TITLE_PATH: 'data.product.name',
  DOUYIN_DESCRIPTION_PATH: 'data.product.description',
  DOUYIN_PRICE_PATH: 'data.product.price',
  DOUYIN_STOCK_PATH: 'data.product.stock',
  DOUYIN_SKU_PATH: 'data.product.skus',
  DOUYIN_SKU_ID_PATH: 'sku_id',
  DOUYIN_SKU_NAME_PATH: 'sku_name',
  DOUYIN_SKU_PRICE_PATH: 'price',
  DOUYIN_SKU_STOCK_PATH: 'stock',
  DOUYIN_IMAGES_PATH: 'data.product.images',
  DOUYIN_CATEGORY_PATH: 'data.product.category',
  DOUYIN_ATTRIBUTES_PATH: 'data.product.attributes',
} as const

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
  it('removes every local bootstrap identity from the fully rendered production services', () => {
    const services = render().services
    for (const service of ['api', 'api-replica']) {
      expect(services[service]?.environment).toMatchObject({
        OPS_LOCAL_SESSION_ENABLED: 'false', OPS_LOCAL_SESSION_TOKEN: '',
        OPS_LOCAL_SESSION_WORKSPACE_ID: '',
        PLATFORM_ACCOUNT_LOGIN: '', PLATFORM_ACCOUNT_PASSWORD_HASH: '',
        ALLOW_WILDCARD_WORKSPACE_GRANT: 'false',
        OPS_AUTH_MODE: 'password',
        SESSION_ID_HASH_SECRET: 'test-production-session-hash-secret',
        ASSET_DISPLAY_URL_SIGNING_SECRET: 'test-production-display-signing-secret',
        ASSET_DISPLAY_URL_SIGNING_KEY_ID: 'display-production',
        DATABASE_URL: 'postgres://merchant_app:opaque-production-secret@postgres:5432/merchant',
        OPS_DATABASE_URL: 'postgres://merchant_ops:opaque-production-ops-secret@postgres:5432/merchant',
        MODEL_COST_ESTIMATE_VERSION: 'production-rate-card-2026-09-15',
      })
      const serialized = JSON.stringify(services[service]?.environment)
      expect(serialized).not.toMatch(/pilot-local|workspace-local|actor_demo|workspace_admin_demo|local-primary|ws_demo|local-acceptance/u)
      expect(services[service]?.environment?.API_AUTH_TOKENS).not.toContain('"workspaces":["*"]')
    }

    for (const service of ['worker-sync', 'worker-generation', 'worker-publish', 'worker-reconcile', 'worker-automation', 'worker-scan']) {
      expect(services[service]?.environment?.NODE_ENV, service).toBe('production')
      expect(services[service]?.environment?.DATABASE_URL, service).toBe('postgres://merchant_app:opaque-production-secret@postgres:5432/merchant')
      expect(services[service]?.environment?.WORKER_WORKSPACES, service).toBe('auto')
      const serialized = JSON.stringify(services[service]?.environment)
      expect(serialized, service).not.toMatch(/(?:ws_demo|workspace_demo|demo-workspace|local-token|local-signing-secret)/u)
    }
  })

  it.each([
    'API_AUTH_TOKENS', 'SESSION_ID_HASH_SECRET', 'WORKER_API_CREDENTIALS',
    'ASSET_DISPLAY_URL_SIGNING_SECRET', 'ASSET_DISPLAY_URL_SIGNING_KEY_ID', 'WORKER_WORKSPACES',
    'DATABASE_URL', 'OPS_DATABASE_URL', 'MODEL_COST_ESTIMATE_VERSION',
    'WORKER_SYNC_API_TOKEN', 'WORKER_SYNC_API_SIGNING_SECRET',
    'WORKER_GENERATION_API_TOKEN', 'WORKER_GENERATION_API_SIGNING_SECRET',
    'WORKER_PUBLISH_API_TOKEN', 'WORKER_PUBLISH_API_SIGNING_SECRET',
    'WORKER_RECONCILE_API_TOKEN', 'WORKER_RECONCILE_API_SIGNING_SECRET',
    'WORKER_AUTOMATION_API_TOKEN', 'WORKER_AUTOMATION_API_SIGNING_SECRET',
  ])('fails closed when production identity setting %s is absent', (key) => {
    expect(() => render({ [key]: '' })).toThrow(new RegExp(`${key}.*required`))
  })

  it('hardens both APIs as production ECS runtimes and ignores stale local/fixture host values', () => {
    const services = render({
      NODE_ENV: 'development',
      DEPLOYMENT_PROFILE: 'local_acceptance',
      LOCAL_COMPOSE: 'true',
      CONNECTOR_FIXTURE_MODE: 'true',
      MERCHANT_TEST_APPROVED_RATES: 'true',
      OPS_ALERT_NOTIFICATIONS_ENABLED: 'true',
      ALERT_CHANNEL_SECRET_REF: 'vault://stale-alert-channel',
      OPS_ALERT_WEBHOOK_URL: 'https://stale.example.test/hook',
      OPS_ALERT_WEBHOOK_ALLOWED_HOSTS: 'stale.example.test',
      OPS_ALERT_WEBHOOK_SECRET_FILE: '/tmp/stale-alert-secret',
    }).services

    for (const service of ['api', 'api-replica']) {
      expect(services[service]?.environment).toMatchObject({
        NODE_ENV: 'production',
        DEPLOYMENT_PROFILE: 'ecs',
        LOCAL_COMPOSE: 'false',
        CONNECTOR_FIXTURE_MODE: 'false',
        MERCHANT_TEST_APPROVED_RATES: 'false',
        OPS_ALERT_NOTIFICATIONS_ENABLED: 'false',
        ALERT_CHANNEL_SECRET_REF: '',
        OPS_ALERT_WEBHOOK_URL: '',
        OPS_ALERT_WEBHOOK_ALLOWED_HOSTS: '',
        OPS_ALERT_WEBHOOK_SECRET_FILE: '',
      })
    }
  })

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

  it('passes every Douyin product mapping path to both API instances', () => {
    const services = render(douyinProductMappingEnvironment).services

    for (const service of ['api', 'api-replica']) {
      expect(services[service]?.environment).toMatchObject(douyinProductMappingEnvironment)
    }
  })

  it('renders the same public and payment configuration on both API instances', () => {
    const services = render().services
    const api = services.api?.environment
    const replica = services['api-replica']?.environment
    const invariantKeys = [
      'PUBLIC_APP_BASE_URL',
      'OPS_AUTH_MODE',
      'PUBLIC_ASSET_BASE_URL',
      'PUBLIC_OAUTH_REDIRECT_URI',
      'MERCHANT_BEARER_HOSTNAME',
      'ALLOWED_ORIGINS',
      'OPS_ALERT_NOTIFICATIONS_ENABLED',
      'OPS_ALERT_WEBHOOK_URL',
      'OPS_ALERT_WEBHOOK_ALLOWED_HOSTS',
      'OPS_ALERT_WEBHOOK_SECRET',
      'PAYMENT_MODE',
      'PAYMENT_PROVIDER_ADAPTERS',
      'PAYMENT_CHECKOUT_BASE_URL',
      'PAYMENT_PROVIDER_CHECKOUT_API_URL',
      'PAYMENT_PROVIDER_QUERY_API_URL',
      'PAYMENT_PROVIDER_REFUND_QUERY_API_URL',
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
      'CONNECTOR_FIXTURE_MODE',
      'PLUGIN_WRITE_ENABLED',
      'CAPABILITY_EVIDENCE_PATH',
      'CAPACITY_REPORT_PATH',
      'VAULT_ADDR',
      'JD_APP_KEY',
      'JD_API_BASE_URL',
      'TAOBAO_APP_KEY',
      'TMALL_APP_KEY',
      'PDD_CLIENT_ID',
      'XHS_CLIENT_ID',
      'DOUYIN_CLIENT_ID',
    ]

    expect(api).toBeDefined()
    expect(replica).toBeDefined()
    for (const key of invariantKeys) expect(replica?.[key]).toBe(api?.[key])
    expect(api).toMatchObject({ NODE_ENV: 'production', CONNECTOR_FIXTURE_MODE: 'false', PLUGIN_WRITE_ENABLED: 'false', CAPABILITY_EVIDENCE_PATH: '/run/release-evidence/platform-capability.json', CAPACITY_REPORT_PATH: '/run/release-evidence/capacity-report.json' })
    expect(services['payment-gateway']?.environment?.PAYMENT_GATEWAY_API_KEY)
      .toBe(api?.PAYMENT_PROVIDER_API_KEY)
  })
})
