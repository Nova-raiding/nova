import { FakePlatformConnector } from './fake-connector.js'
import { validateConnectorReadiness, type ConnectorReadiness } from './readiness.js'
import type { CapabilityName } from './capability-evidence.js'
import type { HttpConnectorConfig, Platform, PlatformConnector } from './types.js'
import { jdProfile } from './profiles/jd.js'
import { taobaoProfile } from './profiles/taobao.js'
import { tmallProfile } from './profiles/tmall.js'
import { pinduoduoProfile } from './profiles/pinduoduo.js'
import { xiaohongshuProfile } from './profiles/xiaohongshu.js'
import { douyinProfile } from './profiles/douyin.js'

export const PLATFORM_CAPABILITY_CONTRACT_PLATFORMS = ['jd', 'taobao', 'tmall', 'pinduoduo', 'xiaohongshu', 'douyin'] as const
export const PLATFORM_CAPABILITY_CONTRACT_CAPABILITIES: readonly CapabilityName[] = [
  'authorize', 'read', 'full_sync', 'incremental_sync', 'create', 'update', 'query_status', 'revoke', 'media_upload',
]
export const PLATFORM_CAPABILITY_EVIDENCE_STATES = ['unverified', 'documented', 'fixture_verified', 'test_e2e', 'production_canary'] as const

export type PlatformCapabilityEvidenceState = typeof PLATFORM_CAPABILITY_EVIDENCE_STATES[number]

export interface PlatformCapabilityEvidenceDocument {
  schema_version?: string
  release_id?: string
  environment?: string
  generated_at?: string
  platforms?: Array<{
    platform?: string
    application_id?: string
    test_store_id?: string
    capabilities?: Record<string, {
      state?: string
      evidence_ref?: string
      verified_by?: string
      verified_at?: string
      api_version?: string
      scope?: string
    }>
  }>
}

export interface PlatformPreflightCheck {
  name: string
  passed: boolean
  detail?: string
}

export interface PlatformPreflightPlatformResult {
  platform: Platform
  contractPassed: boolean
  checks: readonly PlatformPreflightCheck[]
  readiness?: ConnectorReadiness
  productionCanaryReady: boolean
  gaps: readonly string[]
}

export interface PlatformPreflightResult {
  passed: boolean
  fixtureContractPassed: boolean
  evidenceValid: boolean
  productionReady: boolean
  platforms: readonly PlatformPreflightPlatformResult[]
  gaps: readonly string[]
}

export interface PlatformPreflightOptions {
  /** Optional real connector configs. No credential provider or token is needed for this check. */
  configs?: Partial<Record<Platform, HttpConnectorConfig>>
  /** Optional evidence JSON loaded by the caller from a secure artifact. */
  evidence?: unknown
  requireProductionCanary?: boolean
  /** Factory injection makes the fixture contract deterministic and testable. */
  createConnector?: (platform: Platform) => PlatformConnector
}

const nonEmpty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0
const hasValue = (value: unknown): boolean => value !== undefined && value !== null && value !== ''
const secretKey = /secret|token|password|access[_-]?key|private[_-]?key/i
const placeholderValue = /^(SET_|CHANGE_ME|REPLACE_ME|TODO|TBD|<[^>]+>)/i

function isIsoDate(value: unknown): boolean {
  // Date.parse accepts locale-ish and date-only strings. Evidence needs a
  // reproducible instant with an explicit timezone so it can be audited
  // across machines and systems.
  return nonEmpty(value)
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    && !Number.isNaN(Date.parse(value))
}

function evidenceObject(document: unknown): document is PlatformCapabilityEvidenceDocument {
  return Boolean(document && typeof document === 'object' && !Array.isArray(document))
}

/**
 * Validates the release-bound, secret-free evidence matrix. This is deliberately
 * independent of HTTP and credentials: it checks evidence quality, not whether
 * a platform accepted a request.
 */
export function validatePlatformCapabilityEvidence(
  document: unknown,
  options: { requireCanary?: boolean; expectedReleaseId?: string } = {},
): string[] {
  const errors: string[] = []
  if (!evidenceObject(document)) return ['document must be a JSON object']
  const value = document
  if (value.schema_version !== '1') errors.push('schema_version must be 1')
  if (options.expectedReleaseId && value.release_id !== options.expectedReleaseId) errors.push(`release_id must match ${options.expectedReleaseId}`)
  for (const field of ['release_id', 'environment', 'generated_at'] as const) if (!nonEmpty(value[field])) errors.push(`${field} is required`)
  if (!isIsoDate(value.generated_at)) errors.push('generated_at must be an ISO date')
  if (options.requireCanary && value.environment !== 'preproduction' && value.environment !== 'production') errors.push('environment must be preproduction or production for production_canary')
  if (!Array.isArray(value.platforms)) return [...errors, 'platforms must be an array']

  const seen = new Set<string>()
  for (const item of value.platforms) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      errors.push('platform entry must be an object')
      continue
    }
    const name = item?.platform
    if (!PLATFORM_CAPABILITY_CONTRACT_PLATFORMS.includes(name as typeof PLATFORM_CAPABILITY_CONTRACT_PLATFORMS[number])) {
      errors.push(`unsupported platform: ${String(name)}`)
      continue
    }
    if (seen.has(name as string)) errors.push(`duplicate platform: ${name}`)
    seen.add(name as string)
    if (!nonEmpty(item.application_id)) errors.push(`${name}.application_id is required`)
    if (!nonEmpty(item.test_store_id)) errors.push(`${name}.test_store_id is required`)
    if (!item.capabilities || typeof item.capabilities !== 'object' || Array.isArray(item.capabilities)) {
      errors.push(`${name}.capabilities is required`)
      continue
    }
    for (const capability of PLATFORM_CAPABILITY_CONTRACT_CAPABILITIES) {
      const evidence = item.capabilities[capability]
      if (!evidence || !PLATFORM_CAPABILITY_EVIDENCE_STATES.includes(evidence.state as PlatformCapabilityEvidenceState)) {
        errors.push(`${name}.${capability}.state is invalid`)
        continue
      }
      if (evidence.state !== 'unverified') {
        for (const field of ['evidence_ref', 'verified_by', 'verified_at'] as const) if (!nonEmpty(evidence[field])) errors.push(`${name}.${capability}.${field} is required for ${evidence.state}`)
        if (evidence.verified_at && !isIsoDate(evidence.verified_at)) errors.push(`${name}.${capability}.verified_at must be an ISO date`)
      }
      if (evidence.state === 'production_canary') {
        for (const field of ['api_version', 'scope'] as const) if (!nonEmpty(evidence[field])) errors.push(`${name}.${capability}.${field} is required for production_canary`)
        if (placeholderValue.test(evidence.evidence_ref ?? '') || placeholderValue.test(evidence.verified_by ?? '') || placeholderValue.test(evidence.api_version ?? '') || placeholderValue.test(evidence.scope ?? '')) {
          errors.push(`${name}.${capability} contains a placeholder production_canary field`)
        }
      }
      if (options.requireCanary && evidence.state !== 'production_canary') errors.push(`${name}.${capability} must be production_canary`)
      if (options.requireCanary) {
        if (placeholderValue.test(item.application_id ?? '') || placeholderValue.test(item.test_store_id ?? '')) errors.push(`${name}.application_id/test_store_id cannot be placeholders for production_canary`)
      }
    }
    for (const key of Object.keys(item.capabilities)) if (!PLATFORM_CAPABILITY_CONTRACT_CAPABILITIES.includes(key as CapabilityName)) errors.push(`${name} has unknown capability ${key}`)
  }
  const generatedAt = isIsoDate(value.generated_at) ? Date.parse(value.generated_at!) : undefined
  if (generatedAt !== undefined) {
    for (const item of value.platforms) {
      if (!item?.capabilities || typeof item.capabilities !== 'object' || Array.isArray(item.capabilities)) continue
      for (const [capability, evidence] of Object.entries(item.capabilities)) {
        if (!evidence || typeof evidence !== 'object') continue
        if (evidence.verified_at && isIsoDate(evidence.verified_at) && Date.parse(evidence.verified_at) > generatedAt) errors.push(`${item.platform}.${capability}.verified_at cannot be after generated_at`)
      }
    }
  }
  for (const platform of PLATFORM_CAPABILITY_CONTRACT_PLATFORMS) if (!seen.has(platform)) errors.push(`missing platform: ${platform}`)

  // Keys are checked recursively so a secret cannot be hidden in an auxiliary
  // evidence field. Values are never interpreted as credentials or emitted.
  const visit = (node: unknown, path: string): void => {
    if (!node || typeof node !== 'object') return
    for (const [key, child] of Object.entries(node)) {
      if (secretKey.test(key)) errors.push(`secret-like field is not allowed: ${path}.${key}`)
      visit(child, `${path}.${key}`)
    }
  }
  visit(value, '$')
  return [...new Set(errors)]
}

function check(name: string, passed: boolean, detail?: string): PlatformPreflightCheck {
  return { name, passed, ...(detail ? { detail } : {}) }
}

async function runFixtureContract(platform: Platform, connector: PlatformConnector): Promise<PlatformPreflightCheck[]> {
  const checks: PlatformPreflightCheck[] = []
  const context = { workspaceId: `preflight-${platform}`, accountId: `fixture-${platform}` }
  const profile = connector.profile
  const fixture = profile.fixture
  checks.push(check('profile_shape', profile.platform === platform && nonEmpty(profile.schemaProfile) && profile.requiredFields.length > 0 && profile.writableFields.length > 0 && new Set(profile.writableFields).size === profile.writableFields.length))
  checks.push(check('fixture_required_fields', profile.requiredFields.every(field => hasValue((fixture as unknown as Record<string, unknown>)[field]))))
  const unknownFieldFindings = profile.validateWrite({ idempotencyKey: `preflight-${platform}-invalid`, fields: { title: 'Preflight fixture', category: 'fixture', price: 1, stock: 1, __preflight_unknown__: true } })
  checks.push(check('rejects_unknown_write_field', unknownFieldFindings.some(finding => finding.field === '__preflight_unknown__' && finding.code === 'NOT_ALLOWED')))
  try {
    const authorization = await connector.authorize({ workspaceId: context.workspaceId, actorId: 'preflight', redirectUri: 'https://preflight.invalid/callback', state: `state-${platform}` })
    checks.push(check('authorize', authorization.ok && authorization.mode === 'fixture'))
    const credential = await connector.exchangeCode({ code: `fixture-code-${platform}`, state: `state-${platform}` })
    await connector.refreshCredential(credential)
  } catch (error) {
    checks.push(check('authorize/revoke', false, error instanceof Error ? error.message : String(error)))
  }
  try {
    const full = await connector.syncProducts(context)
    const incremental = await connector.syncProducts(context, { value: 'fixture-cursor' })
    const raw = full.items[0]
    const canonical = raw ? connector.mapToCanonical(raw, { id: `${platform}.fixture.v1` }) : undefined
    checks.push(check('read', full.source === 'fixture' && full.simulated && full.items.length > 0))
    checks.push(check('full_sync', full.items.length > 0 && Boolean(canonical) && canonical?.platform === platform))
    checks.push(check('incremental_sync', incremental.source === 'fixture' && incremental.items.length === 0))
  } catch (error) {
    checks.push(check('read/full_sync/incremental_sync', false, error instanceof Error ? error.message : String(error)))
  }
  for (const operation of ['create', 'update'] as const) {
    try {
      const input = { remoteId: `${platform}-fixture-write`, idempotencyKey: `preflight-${platform}-${operation}`, fields: { title: 'Preflight fixture', category: 'fixture', price: 1, stock: 1 } }
      const receipt = operation === 'create' ? await connector.createProduct(context, input) : await connector.updateProduct(context, input)
      const status = await connector.queryWrite(context, { idempotencyKey: input.idempotencyKey, remoteId: receipt.remoteId })
      checks.push(check(operation, receipt.simulated && receipt.operation === operation && receipt.idempotencyKey === input.idempotencyKey))
      checks.push(check('query_status', status.found && status.requestId === receipt.requestId && status.simulated))
    } catch (error) {
      checks.push(check(`${operation}/query_status`, false, error instanceof Error ? error.message : String(error)))
    }
  }
  try {
    const credential = await connector.exchangeCode({ code: `fixture-code-${platform}`, state: `state-${platform}-revoke` })
    await connector.revoke(credential)
    const isUnauthorized = (error: unknown) => {
      const normalized = (error as { normalized?: { code?: string } } | undefined)?.normalized
      return normalized?.code === 'UNAUTHORIZED' || connector.normalizeError(error).code === 'UNAUTHORIZED'
    }
    const revokedSync = await connector.syncProducts(context).then(() => false).catch(isUnauthorized)
    const revokedWrite = await connector.createProduct(context, { idempotencyKey: `preflight-${platform}-revoked`, fields: { title: 'Revoked fixture', category: 'fixture', price: 1, stock: 1 } }).then(() => false).catch(isUnauthorized)
    checks.push(check('revoke', revokedSync && revokedWrite))
  } catch (error) {
    checks.push(check('revoke', false, error instanceof Error ? error.message : String(error)))
  }
  return checks
}

/**
 * Runs the no-credential platform preflight. A passing fixture contract proves
 * the six adapters expose the same safe port; it never promotes a platform to
 * production readiness without real evidence and a ready HTTP configuration.
 */
export async function runPlatformPreflight(options: PlatformPreflightOptions = {}): Promise<PlatformPreflightResult> {
  const profiles = { jd: jdProfile, taobao: taobaoProfile, tmall: tmallProfile, pinduoduo: pinduoduoProfile, xiaohongshu: xiaohongshuProfile, douyin: douyinProfile }
  const createConnector = options.createConnector ?? (platform => new FakePlatformConnector(profiles[platform], { configured: true, allowFakeWrites: true }))
  // Keep evidenceValid separate from the promotion decision: a complete and
  // well-formed fixture/test-e2e matrix is valid evidence, but is intentionally
  // not production-ready until every capability reaches production_canary.
  const evidenceErrors = options.evidence === undefined ? [] : validatePlatformCapabilityEvidence(options.evidence)
  const results: PlatformPreflightPlatformResult[] = []
  for (const platform of PLATFORM_CAPABILITY_CONTRACT_PLATFORMS) {
    const checks = await runFixtureContract(platform, createConnector(platform))
    const readiness = options.configs?.[platform] ? validateConnectorReadiness(platform, options.configs[platform]) : undefined
    const productionCanaryReady = options.evidence !== undefined && evidenceErrors.length === 0 && Boolean((options.evidence as PlatformCapabilityEvidenceDocument).platforms?.find(item => item.platform === platform)?.capabilities && PLATFORM_CAPABILITY_CONTRACT_CAPABILITIES.every(capability => (options.evidence as PlatformCapabilityEvidenceDocument).platforms?.find(item => item.platform === platform)?.capabilities?.[capability]?.state === 'production_canary'))
    const gaps: string[] = []
    if (!readiness) gaps.push('HTTP connector config not supplied; official endpoint/signer/mapping readiness is unverified')
    else if (!readiness.ready) gaps.push(...readiness.reasons)
    if (!productionCanaryReady) gaps.push('all nine capabilities lack production_canary evidence')
    results.push({ platform, contractPassed: checks.every(item => item.passed), checks, ...(readiness ? { readiness } : {}), productionCanaryReady, gaps: [...new Set(gaps)] })
  }
  const gaps = [...new Set([...evidenceErrors, ...results.flatMap(item => item.gaps)])]
  const fixtureContractPassed = results.every(item => item.contractPassed)
  const productionReady = fixtureContractPassed && evidenceErrors.length === 0 && results.every(item => item.productionCanaryReady && item.readiness?.ready)
  return { passed: options.requireProductionCanary ? productionReady : fixtureContractPassed && evidenceErrors.length === 0, fixtureContractPassed, evidenceValid: evidenceErrors.length === 0, productionReady, platforms: results, gaps }
}
