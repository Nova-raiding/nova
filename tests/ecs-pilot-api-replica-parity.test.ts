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
  ALIPAY_APP_ID: 'test-alipay-app',
  MERCHANT_API_TOKEN: 'test-merchant-token',
  MERCHANT_WORKSPACE_ID: 'ws_pilot_parity',
  MCP_OAUTH_CLIENTS: JSON.stringify({ 'chatgpt-test': ['https://chatgpt.example.test/oauth/callback'] }),
  CAPABILITY_EVIDENCE_PATH: '/tmp/test-capability-evidence.json',
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

  it('renders the same public and payment configuration on both API instances', () => {
    const services = render().services
    const api = services.api?.environment
    const replica = services['api-replica']?.environment
    const invariantKeys = [
      'PUBLIC_APP_BASE_URL',
      'MCP_OAUTH_REQUIRED',
      'MCP_OAUTH_ISSUER',
      'MCP_OAUTH_AUTHORIZATION_ENDPOINT',
      'MCP_OAUTH_TOKEN_ENDPOINT',
      'MCP_OAUTH_CLIENTS',
      'OPENAI_APPS_CHALLENGE_TOKEN',
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
    expect(api).toMatchObject({ NODE_ENV: 'production', CONNECTOR_FIXTURE_MODE: 'false', PLUGIN_WRITE_ENABLED: 'false', CAPABILITY_EVIDENCE_PATH: '/run/release-evidence/platform-capability.json' })
    expect(services['payment-gateway']?.environment?.PAYMENT_GATEWAY_API_KEY)
      .toBe(api?.PAYMENT_PROVIDER_API_KEY)
  })
})
