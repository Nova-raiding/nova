import { describe, expect, it } from 'vitest'
import {
  assertEnvironmentIsolation,
  assertSensitiveConfiguration,
  ConfigurationError,
  isPlaceholderValue,
  loadRuntimeConfig,
} from './index.js'

const productionBase = {
  NODE_ENV: 'production',
  PUBLIC_BASE_URL: 'https://merchant.test',
  MODEL_RELAY_API_KEY: 'relay-live-key',
  OIDC_PROXY_SIGNING_SECRET: 'oidc-live-secret',
  SESSION_ID_HASH_SECRET: 'session-live-secret',
  WORKER_API_SIGNING_SECRET: 'worker-live-secret',
  PAYMENT_CALLBACK_SECRET: 'payment-live-secret',
}

describe('runtime configuration gates', () => {
  it('recognizes common copied example values as placeholders', () => {
    expect(isPlaceholderValue('change-me')).toBe(true)
    expect(isPlaceholderValue('your-secret-here')).toBe(true)
    expect(isPlaceholderValue('relay-live-key')).toBe(false)
    expect(isPlaceholderValue(undefined)).toBe(true)
  })

  it('allows local development without production secrets', () => {
    expect(loadRuntimeConfig({ NODE_ENV: 'development', PUBLIC_BASE_URL: 'http://localhost:18080' })).toMatchObject({
      environment: 'development',
      public_base_url: 'http://localhost:18080',
      capacity: { name: 'pilot_50' },
    })
  })

  it('requires HTTPS and non-placeholder secrets in production', () => {
    expect(() => loadRuntimeConfig({ ...productionBase, PUBLIC_BASE_URL: 'http://merchant.test' })).toThrowError(
      expect.objectContaining({ code: 'CONFIG_INVALID', key: 'PUBLIC_BASE_URL' }),
    )
    expect(() => assertSensitiveConfiguration({ ...productionBase, MODEL_RELAY_API_KEY: 'change-me' })).toThrowError(
      expect.objectContaining({ code: 'CONFIG_PLACEHOLDER', key: 'MODEL_RELAY_API_KEY' }),
    )
    expect(() => loadRuntimeConfig({ ...productionBase, PUBLIC_BASE_URL: 'https://example.com' })).toThrowError(
      expect.objectContaining({ code: 'CONFIG_PLACEHOLDER', key: 'PUBLIC_BASE_URL' }),
    )
  })

  it('rejects fixture and memory configuration in production', () => {
    expect(() => assertEnvironmentIsolation({ ...productionBase, PAYMENT_MODE: 'fixture' })).toThrowError(
      expect.objectContaining({ code: 'CONFIG_ENVIRONMENT_MISMATCH', key: 'PAYMENT_MODE' }),
    )
    expect(() => loadRuntimeConfig({ ...productionBase, PERSISTENCE_MODE: 'memory' })).toThrowError(ConfigurationError)
  })

  it('supports the explicit scale capacity profile and rejects unknown profiles', () => {
    expect(loadRuntimeConfig({ ...productionBase, CAPACITY_PROFILE: 'scale_500' }).capacity).toMatchObject({
      name: 'scale_500',
      max_concurrent_workspaces: 500,
    })
    expect(() => loadRuntimeConfig({ ...productionBase, CAPACITY_PROFILE: 'custom' })).toThrowError(
      expect.objectContaining({ code: 'CONFIG_INVALID', key: 'CAPACITY_PROFILE' }),
    )
  })
})
