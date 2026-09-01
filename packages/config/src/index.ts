export interface CapacityProfile {
  readonly name: 'pilot_50' | 'scale_500'
  readonly max_concurrent_workspaces: number
  readonly max_active_jobs_per_workspace: number
  readonly api_rate_limit_rps: number
  readonly publish_rate_limit_per_minute: number
}

export const DEFAULT_CAPACITY_PROFILE: CapacityProfile = {
  name: 'pilot_50',
  max_concurrent_workspaces: 50,
  max_active_jobs_per_workspace: 3,
  api_rate_limit_rps: 30,
  publish_rate_limit_per_minute: 50,
}

export interface RuntimeConfig {
  readonly environment: 'development' | 'test' | 'staging' | 'production'
  readonly public_base_url: string
  readonly capacity: CapacityProfile
}

export type ConfigSource = Readonly<Record<string, string | undefined>>

export type ConfigurationErrorCode =
  | 'CONFIG_REQUIRED'
  | 'CONFIG_PLACEHOLDER'
  | 'CONFIG_INVALID'
  | 'CONFIG_ENVIRONMENT_MISMATCH'

export class ConfigurationError extends Error {
  readonly code: ConfigurationErrorCode
  readonly key?: string

  constructor(code: ConfigurationErrorCode, message: string, key?: string) {
    super(message)
    this.name = 'ConfigurationError'
    this.code = code
    this.key = key
  }
}

const ENVIRONMENTS = ['development', 'test', 'staging', 'production'] as const

function required(source: ConfigSource, key: string): string {
  const value = source[key]?.trim()
  if (!value) {
    throw new ConfigurationError('CONFIG_REQUIRED', `${key} is required`, key)
  }
  return value
}

export function isPlaceholderValue(value: string | undefined): boolean {
  if (!value) return true
  const normalized = value.trim().toLowerCase()
  if (!normalized) return true
  return [
    'change-me',
    'changeme',
    'replace-me',
    'replace_me',
    'example',
    'example.com',
    'dummy',
    'test-secret',
    'your-secret',
    'your-secret-here',
    '<secret>',
    '<value>',
  ].some((marker) => normalized === marker || normalized.includes(marker))
}

function rejectPlaceholder(source: ConfigSource, key: string): string {
  const value = required(source, key)
  if (isPlaceholderValue(value)) {
    throw new ConfigurationError('CONFIG_PLACEHOLDER', `${key} must not use a placeholder`, key)
  }
  return value
}

function parseEnvironment(source: ConfigSource): RuntimeConfig['environment'] {
  const value = (source.NODE_ENV ?? 'development').trim().toLowerCase()
  if (!(ENVIRONMENTS as readonly string[]).includes(value)) {
    throw new ConfigurationError('CONFIG_INVALID', `NODE_ENV is invalid: ${value}`, 'NODE_ENV')
  }
  return value as RuntimeConfig['environment']
}

function parsePositiveInt(source: ConfigSource, key: string, fallback: number): number {
  const raw = source[key]?.trim()
  if (!raw) return fallback
  if (!/^\d+$/.test(raw) || Number(raw) <= 0 || !Number.isSafeInteger(Number(raw))) {
    throw new ConfigurationError('CONFIG_INVALID', `${key} must be a positive integer`, key)
  }
  return Number(raw)
}

export const SENSITIVE_CONFIGURATION_KEYS = [
  'MODEL_RELAY_API_KEY',
  'OIDC_PROXY_SIGNING_SECRET',
  'SESSION_ID_HASH_SECRET',
  'WORKER_API_SIGNING_SECRET',
  'PAYMENT_CALLBACK_SECRET',
] as const

/** Reject secrets that are absent or look like copied example configuration. */
export function assertSensitiveConfiguration(
  source: ConfigSource,
  keys: readonly string[] = SENSITIVE_CONFIGURATION_KEYS,
): void {
  for (const key of keys) rejectPlaceholder(source, key)
}

/**
 * Checks that production cannot accidentally boot with local fixtures or local
 * persistence. This is intentionally side-effect free so release gates can use it.
 */
export function assertEnvironmentIsolation(
  source: ConfigSource,
  environment = parseEnvironment(source),
): void {
  if (environment !== 'production') return

  const forbidden = [
    ['LOCAL_COMPOSE', 'true'],
    ['PERSISTENCE_MODE', 'memory'],
    ['PAYMENT_MODE', 'fixture'],
    ['CONNECTOR_FIXTURE_MODE', 'true'],
    ['ALLOW_LOCAL_ASSET_SCAN_FIXTURE', 'true'],
    ['ALLOW_LOCAL_DURABLE_OBJECT_STORAGE', 'true'],
  ] as const
  for (const [key, value] of forbidden) {
    if (source[key]?.trim().toLowerCase() === value) {
      throw new ConfigurationError(
        'CONFIG_ENVIRONMENT_MISMATCH',
        `${key}=${value} is not allowed in production`,
        key,
      )
    }
  }
}

export function loadRuntimeConfig(source: ConfigSource = process.env): RuntimeConfig {
  const environment = parseEnvironment(source)
  const publicBaseUrl = required(source, 'PUBLIC_BASE_URL')
  if (environment === 'production' && isPlaceholderValue(publicBaseUrl)) {
    throw new ConfigurationError('CONFIG_PLACEHOLDER', 'PUBLIC_BASE_URL must not use a placeholder', 'PUBLIC_BASE_URL')
  }
  try {
    const url = new URL(publicBaseUrl)
    if (environment === 'production' && url.protocol !== 'https:') {
      throw new ConfigurationError('CONFIG_INVALID', 'PUBLIC_BASE_URL must use HTTPS in production', 'PUBLIC_BASE_URL')
    }
  } catch (error) {
    if (error instanceof ConfigurationError) throw error
    throw new ConfigurationError('CONFIG_INVALID', 'PUBLIC_BASE_URL must be a valid URL', 'PUBLIC_BASE_URL')
  }

  assertEnvironmentIsolation(source, environment)
  if (environment === 'production') assertSensitiveConfiguration(source)

  const profile = source.CAPACITY_PROFILE?.trim() || DEFAULT_CAPACITY_PROFILE.name
  const capacity: CapacityProfile = profile === 'scale_500'
    ? {
        name: 'scale_500',
        max_concurrent_workspaces: parsePositiveInt(source, 'MAX_CONCURRENT_WORKSPACES', 500),
        max_active_jobs_per_workspace: parsePositiveInt(source, 'MAX_ACTIVE_JOBS_PER_WORKSPACE', 10),
        api_rate_limit_rps: parsePositiveInt(source, 'API_RATE_LIMIT_RPS', 150),
        publish_rate_limit_per_minute: parsePositiveInt(source, 'PUBLISH_RATE_LIMIT_PER_MINUTE', 300),
      }
    : profile === 'pilot_50'
      ? DEFAULT_CAPACITY_PROFILE
      : (() => { throw new ConfigurationError('CONFIG_INVALID', `CAPACITY_PROFILE is invalid: ${profile}`, 'CAPACITY_PROFILE') })()

  return { environment, public_base_url: publicBaseUrl, capacity }
}

export function parseBoolean(value: string | undefined, fallback = false): boolean {
  if (value === undefined) return fallback
  return value === '1' || value.toLowerCase() === 'true'
}
