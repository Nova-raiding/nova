import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { productionReadinessDiagnostics, route } from './server.js'

type Envelope = {
  data: unknown
  error: { code: string; message: string; details?: Record<string, unknown> } | null
}

const productionEnvironment = (): NodeJS.ProcessEnv => ({
  NODE_ENV: 'production',
  CONNECTOR_FIXTURE_MODE: 'false',
  MCP_AUTHZ_MODE: 'enforce',
  AUTHZ_DURABLE_ASSIGNMENTS_REQUIRED: 'true',
  MODEL_RELAY_BASE_URL: 'https://relay.example.test/v1',
  MODEL_RELAY_ALLOWED_HOSTS: 'relay.example.test',
  MODEL_RELAY_API_KEY: 'relay-key',
  AI_MODEL: 'text-model',
  IMAGE_MODEL: 'image-model',
  IMAGE_EDIT_MODEL: 'image-edit-model',
  OCR_MODEL: 'ocr-model',
  VIDEO_MODEL: 'video-model',
  MODEL_RPM_LIMIT: '120',
  MODEL_TPM_LIMIT: '120000',
  MODEL_DAILY_CNY_LIMIT: '100',
  MODEL_MAX_TASK_COST_CNY: '10',
  MODEL_RELAY_TEXT_COST_EVIDENCE: 'true',
  MODEL_RELAY_IMAGE_COST_EVIDENCE: 'true',
  MODEL_RELAY_IMAGE_EDIT_COST_EVIDENCE: 'true',
  MODEL_RELAY_OCR_COST_EVIDENCE: 'true',
  MODEL_RELAY_VIDEO_COST_EVIDENCE: 'true',
  OPS_AUTH_MODE: 'oidc',
  OIDC_PROXY_SIGNING_SECRET: 'oidc-signing-secret',
  SESSION_ID_HASH_SECRET: 'session-hash-secret',
  MERCHANT_BEARER_HOSTNAME: 'merchant.example.test',
  API_AUTH_TOKENS: JSON.stringify({
    'merchant-token': { actor_id: 'merchant-owner', workspaces: ['ws_production'], roles: ['workspace_owner'] },
  }),
  ASSET_STORAGE_BUCKET: 'merchant-assets',
  ASSET_STORAGE_REGION: 'cn-test-1',
  ASSET_STORAGE_ENDPOINT: 'https://storage.example.test',
  ASSET_STORAGE_KMS_KEY_ID: 'kms-key-ref',
  PUBLIC_ASSET_BASE_URL: 'https://merchant.example.test',
  ASSET_DISPLAY_URL_SIGNING_SECRET: 'production-display-signing-secret-32-bytes-minimum',
  ASSET_DISPLAY_URL_SIGNING_KEY_ID: 'display-2026-08',
  ASSET_SCANNER_MODE: 'clamav_worker',
  ASSET_SCANNER_API_TOKEN: 'scanner-api-token',
  ASSET_SCANNER_WORKSPACE_SIGNING_SECRET: 'scanner-signing-secret',
  ASSET_SCAN_POLICY_VERSION: 'asset-scan-policy-v1',
  ASSET_SCAN_APPROVED_SCANNER_SERVICE_IDS: 'scanner-production',
  ASSET_SCAN_MIN_DEFINITIONS_VERSION: '28000',
  ASSET_SCAN_TRUSTED_PUBLIC_KEYS: JSON.stringify({ scanner: '-----BEGIN PUBLIC KEY-----\nfixture\n-----END PUBLIC KEY-----' }),
  PAYMENT_MODE: 'provider',
  PAYMENT_PROVIDER_ADAPTERS: 'alipay,wechat',
  PAYMENT_CHECKOUT_BASE_URL: 'https://payments.example.test/checkout',
  PAYMENT_PROVIDER_CHECKOUT_API_URL: 'https://payments.example.test/v1/checkout',
  PAYMENT_PROVIDER_QUERY_API_URL: 'https://payments.example.test/v1/query',
  PAYMENT_PROVIDER_REFUND_API_URL: 'https://payments.example.test/v1/refund',
  PAYMENT_PROVIDER_API_KEY: 'payment-provider-key',
  PAYMENT_PROVIDER_MERCHANT_ID: 'merchant-production',
  PAYMENT_CALLBACK_BASE_URL: 'https://merchant.example.test/v1',
  PAYMENT_CALLBACK_SECRET: 'payment-callback-secret',
  PAYMENT_RECONCILIATION_ENABLED: 'true',
  PAYMENT_REFUND_ENABLED: 'true',
  PLATFORM_RULE_SYNC_MANIFEST_URL: 'https://rules.example.test/platform-rules/v1/manifest.json',
  PLATFORM_RULE_SYNC_SIGNING_SECRET: 'rule-sync-signing-secret',
  PLATFORM_RULE_SYNC_INTERVAL_HOURS: '24',
  OBJECT_STORAGE_VERSIONING: 'true',
  DATA_RETENTION_DAYS: '90',
  ASSET_QUARANTINE_RETENTION_DAYS: '7',
  ASSET_CLEAN_RETENTION_DAYS: '30',
  DELETION_REQUEST_GRACE_DAYS: '7',
  BACKUP_RETENTION_DAYS: '30',
  LIFECYCLE_POLICY_REF: 'policy://production/assets-v1',
  ALERT_CHANNEL_SECRET_REF: 'secret://production/alerts',
  RELEASE_ID: 'release-0.1.1',
  RELEASE_GIT_SHA: 'a'.repeat(40),
  RELEASE_MANIFEST_SHA256: 'b'.repeat(64),
  RELEASE_IMAGE_SET_DIGEST: `sha256:${'c'.repeat(64)}`,
  PLUGIN_VERSION: '0.1.0+production',
  SKILL_BUNDLE_VERSION: '0.1.0+production',
  MCP_VERSION: '217',
  CONNECTOR_BUILD: 'connector-production-1',
  PROMPT_BUNDLE_VERSION: 'prompt-production-1',
})

async function listen(): Promise<{ server: Server; baseUrl: string }> {
  const testServer = createServer((req, res) => { void route(req, res) })
  await new Promise<void>((resolve, reject) => {
    testServer.once('error', reject)
    testServer.listen(0, '127.0.0.1', resolve)
  })
  const address = testServer.address()
  if (!address || typeof address === 'string') throw new Error('test server did not bind')
  return { server: testServer, baseUrl: `http://127.0.0.1:${address.port}` }
}

const openServers: Server[] = []

afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(openServers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))))
})

describe('production readiness fail-closed', () => {
  it('requires every critical production gate without leaking configured secrets', () => {
    const ready = productionReadinessDiagnostics(productionEnvironment())
    expect(ready).toMatchObject({
      required: true,
      ready: true,
      gates: {
        relay: { ready: true },
        authorization: { ready: true },
        identity: { ready: true },
        object_storage: { ready: true },
        payment: { ready: true },
        rule_sync: { ready: true },
        cost: { ready: true },
        release_metadata: { ready: true },
      },
    })

    const cases: Array<{ gate: string; key: string }> = [
      { gate: 'relay', key: 'MODEL_RELAY_API_KEY' },
      { gate: 'authorization', key: 'MCP_AUTHZ_MODE' },
      { gate: 'authorization', key: 'AUTHZ_DURABLE_ASSIGNMENTS_REQUIRED' },
      { gate: 'identity', key: 'OIDC_PROXY_SIGNING_SECRET' },
      { gate: 'object_storage', key: 'ASSET_STORAGE_KMS_KEY_ID' },
      { gate: 'object_storage', key: 'ASSET_DISPLAY_URL_SIGNING_SECRET' },
      { gate: 'asset_scanner', key: 'ASSET_SCAN_APPROVED_SCANNER_SERVICE_IDS' },
      { gate: 'asset_scanner', key: 'ASSET_SCAN_MIN_DEFINITIONS_VERSION' },
      { gate: 'payment', key: 'PAYMENT_PROVIDER_API_KEY' },
      { gate: 'payment', key: 'PAYMENT_CALLBACK_SECRET' },
      { gate: 'payment', key: 'PAYMENT_RECONCILIATION_ENABLED' },
      { gate: 'rule_sync', key: 'PLATFORM_RULE_SYNC_MANIFEST_URL' },
      { gate: 'rule_sync', key: 'PLATFORM_RULE_SYNC_SIGNING_SECRET' },
      { gate: 'cost', key: 'MODEL_DAILY_CNY_LIMIT' },
      { gate: 'cost', key: 'MODEL_MAX_TASK_COST_CNY' },
      { gate: 'release_metadata', key: 'RELEASE_MANIFEST_SHA256' },
    ]
    for (const { gate, key } of cases) {
      const environment = productionEnvironment()
      delete environment[key]
      const result = productionReadinessDiagnostics(environment)
      expect(result.ready, `${gate} must fail closed`).toBe(false)
      expect(result.gates[gate]).toMatchObject({ ready: false })
      expect(JSON.stringify(result)).not.toContain('relay-key')
      expect(JSON.stringify(result)).not.toContain('oidc-signing-secret')
      expect(JSON.stringify(result)).not.toContain('merchant-token')
      expect(JSON.stringify(result)).not.toContain('payment-provider-key')
      expect(JSON.stringify(result)).not.toContain('rule-sync-signing-secret')
    }
  })

  it.each([
    ['payment', 'PAYMENT_MODE', 'fixture'],
    ['payment', 'PAYMENT_PROVIDER_ADAPTERS', 'alipay'],
    ['payment', 'PAYMENT_PROVIDER_QUERY_API_URL', 'http://payments.example.test/query'],
    ['payment', 'PAYMENT_REFUND_ENABLED', 'false'],
    ['rule_sync', 'PLATFORM_RULE_SYNC_MANIFEST_URL', 'https://127.0.0.1/manifest.json'],
    ['rule_sync', 'PLATFORM_RULE_SYNC_MANIFEST_URL', 'https://rules.example.test/manifest.json?token=secret'],
    ['rule_sync', 'PLATFORM_RULE_SYNC_INTERVAL_HOURS', '0'],
  ])('rejects unsafe %s readiness configuration %s', (gate, key, value) => {
    const environment = productionEnvironment()
    environment[key] = value
    const result = productionReadinessDiagnostics(environment)
    expect(result.ready).toBe(false)
    expect(result.gates[gate]).toMatchObject({ ready: false })
  })

  it.each([
    ['MCP_AUTHZ_MODE', 'shadow'],
    ['MCP_AUTHZ_MODE', 'staged'],
    ['MCP_AUTHZ_MODE', ' enforce '],
    ['AUTHZ_DURABLE_ASSIGNMENTS_REQUIRED', 'false'],
    ['AUTHZ_DURABLE_ASSIGNMENTS_REQUIRED', ' true '],
    ['MCP_AUTHZ_ENFORCE_DOMAINS', 'support'],
  ])('rejects non-canonical production authorization setting %s=%s', (key, value) => {
    const environment = productionEnvironment()
    environment[key] = value
    const result = productionReadinessDiagnostics(environment)
    expect(result.ready).toBe(false)
    expect(result.gates.authorization).toMatchObject({ ready: false })
  })

  it('does not let a production fixture profile bypass control-plane gates', () => {
    expect(productionReadinessDiagnostics({ NODE_ENV: 'test', CONNECTOR_FIXTURE_MODE: 'true' })).toEqual({ required: false, ready: true, gates: {} })
    expect(productionReadinessDiagnostics({ NODE_ENV: 'production', CONNECTOR_FIXTURE_MODE: 'true' })).toMatchObject({ required: true, ready: false })
    expect(productionReadinessDiagnostics({ NODE_ENV: 'production', DEPLOYMENT_PROFILE: 'local_acceptance' })).toMatchObject({ required: true, ready: false })
  })

  it('returns 503 from /readyz for an incomplete production deployment while /livez stays process-only', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('CONNECTOR_FIXTURE_MODE', 'false')
    vi.stubEnv('DEPLOYMENT_PROFILE', '')
    const running = await listen()
    openServers.push(running.server)

    const readinessResponse = await fetch(`${running.baseUrl}/readyz`)
    const readiness = await readinessResponse.json() as Envelope
    expect(readinessResponse.status).toBe(503)
    expect(readiness.error).toMatchObject({ code: 'PRODUCTION_READINESS_BLOCKED' })
    expect(readiness.error?.details).toMatchObject({
      gates: {
        relay: { ready: false },
        authorization: { ready: false },
        identity: { ready: false },
        object_storage: { ready: false },
        cost: { ready: false },
        release_metadata: { ready: false },
      },
    })

    const livenessResponse = await fetch(`${running.baseUrl}/livez`)
    const liveness = await livenessResponse.json() as Envelope
    expect(livenessResponse.status).toBe(200)
    expect(liveness.error).toBeNull()
    expect(liveness.data).toEqual({ process: { ready: true } })
  })

  it('keeps the local fixture /readyz behavior healthy', async () => {
    vi.stubEnv('NODE_ENV', 'test')
    vi.stubEnv('CONNECTOR_FIXTURE_MODE', 'true')
    const running = await listen()
    openServers.push(running.server)

    const response = await fetch(`${running.baseUrl}/readyz`)
    const body = await response.json() as Envelope
    expect(response.status).toBe(200)
    expect(body.error).toBeNull()
  })
})
