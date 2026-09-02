import { describe, expect, it } from 'vitest'
import {
  COMMERCIAL_MCP_FOUNDATION_POLICIES,
  ERROR_CODES,
  assertCommercialAccessDecision,
  assertCommercialOperationRegistryTotality,
  createStableError,
  defineCommercialOperationRegistry,
  isCommercialAccessErrorCode,
  resolveCommercialOperation,
  type CommercialAccessDecision,
  type CommercialCatalogGetResult,
  type CreativePointsBalanceGetResult,
  type CreativePointsStatementListResult,
} from './index.js'

const registry = defineCommercialOperationRegistry([
  { surface: 'MCP', operation: 'subscription.get', domain: 'COMMERCIAL', enabled: true, classification: 'RECOVERY_CONTROL', rate_action: null },
  { surface: 'HTTP', operation: 'http:GET:/v1/products', domain: 'COMMERCIAL', enabled: true, classification: 'POINT_REQUIRED_NO_CHARGE', rate_action: null },
  { surface: 'WORKER', operation: 'generation.execute', domain: 'COMMERCIAL', enabled: true, classification: 'POINT_CHARGED', rate_action: 'content.image.generate' },
] as const)

const base = {
  schema_version: 'commercial-access.v1',
  decision_id: 'decision-test-1',
  decided_at: '2026-09-01T14:00:00.000Z',
  registry_version: 'registry-test-v1',
  workspace_id: 'workspace-1',
  next_actions: [] as const,
} as const

describe('commercial operation registry E1 contract', () => {
  it('freezes only the reviewed MCP foundation without widening recovery access', () => {
    const policy = (operation: string) => resolveCommercialOperation(COMMERCIAL_MCP_FOUNDATION_POLICIES, { surface: 'MCP', operation })
    for (const operation of ['subscription.get', 'subscription.orders.list', 'billing.status', 'billing.recharge.get', 'billing.recharge.list', 'billing.transactions', 'billing.export', 'workspace.data.export.request', 'workspace.data.export.get', 'workspace.data.delete.request', 'workspace.bootstrap', 'commercial.access.get', 'commercial.catalog.get', 'creative-points.balance.get', 'creative-points.statement.list']) {
      expect(policy(operation)).toMatchObject({ outcome: 'REGISTERED', policy: { classification: 'RECOVERY_CONTROL' } })
    }
    for (const operation of ['subscription.order.create', 'subscription.change', 'billing.recharge.create']) {
      expect(policy(operation)).toMatchObject({ outcome: 'DENY_DISABLED', policy: { classification: 'RECOVERY_CONTROL' } })
    }
    for (const operation of ['merchant.start', 'platform.connect', 'catalog.sync', 'content.export']) {
      expect(policy(operation)).toMatchObject({ outcome: 'REGISTERED', policy: { classification: 'POINT_REQUIRED_NO_CHARGE' } })
    }
    expect(policy('catalog.image.generate')).toMatchObject({ outcome: 'DENY_DISABLED', policy: { classification: 'POINT_CHARGED', rate_action: 'catalog.image.generate' } })
    expect(policy('multimodal.image.edit')).toMatchObject({ outcome: 'DENY_DISABLED', policy: { classification: 'POINT_CHARGED', rate_action: 'multimodal.image.edit' } })
    expect(policy('content.generate')).toMatchObject({ outcome: 'DENY_DISABLED' })
    expect(policy('multimodal.video.request')).toMatchObject({ outcome: 'DENY_DISABLED' })
  })

  it('uses only the three approved classifications and defaults unknown operations to deny', () => {
    expect(resolveCommercialOperation(registry, { surface: 'MCP', operation: 'subscription.get' })).toMatchObject({ outcome: 'REGISTERED', policy: { classification: 'RECOVERY_CONTROL' } })
    expect(resolveCommercialOperation(registry, { surface: 'MCP', operation: 'merchant.start' })).toEqual({ outcome: 'DENY_UNCLASSIFIED', policy: null })
    expect(resolveCommercialOperation(registry, { surface: 'HTTP', operation: 'http:GET:/v1/products/1' })).toEqual({ outcome: 'DENY_UNCLASSIFIED', policy: null })
  })

  it('requires exact total coverage of manifests from every runtime surface', () => {
    const manifest = registry.map(({ surface, operation }) => ({ surface, operation }))
    expect(assertCommercialOperationRegistryTotality(manifest, registry)).toEqual({
      registered: 3,
      manifest_operations: 3,
      by_surface: { MCP: 1, HTTP: 1, WORKER: 1 },
    })
    expect(() => assertCommercialOperationRegistryTotality(
      [...manifest, { surface: 'MCP', operation: 'merchant.start' }],
      registry,
    )).toThrow('missing classifications: MCP:merchant.start')
    expect(() => assertCommercialOperationRegistryTotality(manifest.slice(0, 2), registry)).toThrow('stale classifications: WORKER:generation.execute')
  })

  it('rejects duplicate, malformed, and semantically invalid policies', () => {
    expect(() => defineCommercialOperationRegistry([registry[0], registry[0]])).toThrow('duplicate commercial operation')
    expect(() => defineCommercialOperationRegistry([
      { surface: 'MCP', operation: ' catalog.search', domain: 'COMMERCIAL', enabled: true, classification: 'POINT_REQUIRED_NO_CHARGE', rate_action: null },
    ])).toThrow('invalid MCP commercial operation identifier')
    expect(() => defineCommercialOperationRegistry([
      { surface: 'MCP', operation: 'catalog.image.generate', domain: 'COMMERCIAL', enabled: true, classification: 'POINT_CHARGED', rate_action: '' },
    ])).toThrow('charged operation lacks an exact rate action')
  })

  it('keeps non-commercial domains outside point classification and disabled entries denied', () => {
    const domains = defineCommercialOperationRegistry([
      { surface: 'HTTP', operation: 'http:GET:/healthz', domain: 'MACHINE_INFRASTRUCTURE', enabled: true, classification: null, rate_action: null },
      { surface: 'MCP', operation: 'billing.recharge.create', domain: 'COMMERCIAL', enabled: false, classification: 'RECOVERY_CONTROL', rate_action: null },
    ] as const)
    expect(resolveCommercialOperation(domains, { surface: 'HTTP', operation: 'http:GET:/healthz' })).toMatchObject({ outcome: 'REGISTERED', policy: { domain: 'MACHINE_INFRASTRUCTURE', classification: null } })
    expect(resolveCommercialOperation(domains, { surface: 'MCP', operation: 'billing.recharge.create' })).toMatchObject({ outcome: 'DENY_DISABLED' })
  })
})

describe('CommercialAccessDecision E1 contract', () => {
  it('keeps V2 recovery read unknown states nullable instead of fabricating zero or empty data', () => {
    const catalog: CommercialCatalogGetResult = { state: 'unavailable', catalog_version: null, skus: null, error_code: 'CREATIVE_POINTS_UNAVAILABLE' }
    const balance: CreativePointsBalanceGetResult = { balance_state: 'unknown', available_points: null, access_revision: null, next_expiry_at: null, expiring_points: null, error_code: 'CREATIVE_POINTS_UNAVAILABLE' }
    const statement: CreativePointsStatementListResult = { state: 'unknown', entries: null, next_cursor: null, access_revision: null, error_code: 'CREATIVE_POINTS_UNAVAILABLE' }
    expect(catalog.skus).toBeNull()
    expect(balance.available_points).toBeNull()
    expect(balance.expiring_points).toBeNull()
    expect(statement.entries).toBeNull()
  })

  it('requires server-issued decision identity and time evidence', () => {
    const decision: CommercialAccessDecision = {
      ...base,
      surface: 'MCP', operation: 'subscription.get', classification: 'RECOVERY_CONTROL',
      balance_state: 'unknown', available_points: null, quoted_points: null, rate_card_version: null,
      access_revision: null, allowed: true, error_code: null,
    }
    expect(() => assertCommercialAccessDecision({ ...decision, decision_id: '' })).toThrow('valid decision_id')
    expect(() => assertCommercialAccessDecision({ ...decision, decided_at: 'today' })).toThrow('valid decided_at timestamp')
  })

  it('preserves unknown as null and fails business access closed', () => {
    const decision: CommercialAccessDecision = {
      ...base,
      surface: 'MCP',
      operation: 'catalog.search',
      classification: 'POINT_REQUIRED_NO_CHARGE',
      balance_state: 'unknown',
      available_points: null,
      quoted_points: null,
      rate_card_version: null,
      access_revision: null,
      allowed: false,
      error_code: ERROR_CODES.CREATIVE_POINTS_UNAVAILABLE,
    }
    expect(assertCommercialAccessDecision(decision)).toBe(decision)
    expect(() => assertCommercialAccessDecision({ ...decision, available_points: 0 } as unknown as CommercialAccessDecision)).toThrow('unknown commercial balance must use null')
    expect(() => assertCommercialAccessDecision({ ...decision, allowed: true, error_code: null })).toThrow('unknown business access must fail closed')
  })

  it('allows exact recovery controls even while the balance is unknown', () => {
    const decision: CommercialAccessDecision = {
      ...base,
      surface: 'MCP',
      operation: 'subscription.get',
      classification: 'RECOVERY_CONTROL',
      balance_state: 'unknown',
      available_points: null,
      quoted_points: null,
      rate_card_version: null,
      access_revision: null,
      allowed: true,
      error_code: null,
    }
    expect(assertCommercialAccessDecision(decision)).toBe(decision)
  })

  it('distinguishes exhausted, insufficient, rate-unavailable, and stale decisions', () => {
    const charged = {
      ...base,
      surface: 'WORKER' as const,
      operation: 'generation.execute',
      classification: 'POINT_CHARGED' as const,
      balance_state: 'known' as const,
      access_revision: 'revision-7',
      next_actions: ['BUY_POINTS'],
    }
    expect(assertCommercialAccessDecision({ ...charged, available_points: 0, quoted_points: null, rate_card_version: null, allowed: false, error_code: ERROR_CODES.CREATIVE_POINTS_EXHAUSTED })).toBeDefined()
    expect(assertCommercialAccessDecision({ ...charged, available_points: 4, quoted_points: 5, rate_card_version: 'rate-v1', allowed: false, error_code: ERROR_CODES.CREATIVE_POINTS_INSUFFICIENT })).toBeDefined()
    expect(assertCommercialAccessDecision({ ...charged, available_points: 4, quoted_points: null, rate_card_version: null, allowed: false, error_code: ERROR_CODES.RATE_CARD_UNAVAILABLE })).toBeDefined()
    expect(assertCommercialAccessDecision({ ...charged, available_points: 4, quoted_points: 1, rate_card_version: 'rate-v1', allowed: false, error_code: ERROR_CODES.COMMERCIAL_ACCESS_STALE })).toBeDefined()
  })

  it('enforces exhausted before rate lookup and insufficient only after a valid quote', () => {
    const charged = {
      ...base,
      surface: 'MCP' as const,
      operation: 'catalog.image.generate',
      classification: 'POINT_CHARGED' as const,
      balance_state: 'known' as const,
      access_revision: 'revision-priority',
      next_actions: ['BUY_POINTS'],
      allowed: false as const,
    }
    expect(() => assertCommercialAccessDecision({ ...charged, available_points: 0, quoted_points: 1, rate_card_version: 'rate-v1', error_code: ERROR_CODES.CREATIVE_POINTS_EXHAUSTED })).toThrow('must not resolve or expose a rate quote')
    expect(() => assertCommercialAccessDecision({ ...charged, available_points: 0, quoted_points: null, rate_card_version: null, error_code: ERROR_CODES.RATE_CARD_UNAVAILABLE })).toThrow('zero points must fail as CREATIVE_POINTS_EXHAUSTED')
    expect(() => assertCommercialAccessDecision({ ...charged, available_points: 1, quoted_points: null, rate_card_version: null, error_code: ERROR_CODES.CREATIVE_POINTS_EXHAUSTED })).toThrow('requires zero available_points')
    expect(() => assertCommercialAccessDecision({ ...charged, available_points: 5, quoted_points: 5, rate_card_version: 'rate-v1', error_code: ERROR_CODES.CREATIVE_POINTS_INSUFFICIENT })).toThrow('available_points below quoted_points')
  })

  it('registers the five stable errors with explicit HTTP semantics', () => {
    const expected = [
      [ERROR_CODES.CREATIVE_POINTS_EXHAUSTED, 402],
      [ERROR_CODES.CREATIVE_POINTS_INSUFFICIENT, 402],
      [ERROR_CODES.CREATIVE_POINTS_UNAVAILABLE, 503],
      [ERROR_CODES.RATE_CARD_UNAVAILABLE, 503],
      [ERROR_CODES.COMMERCIAL_ACCESS_STALE, 409],
    ] as const
    for (const [code, status] of expected) {
      expect(isCommercialAccessErrorCode(code)).toBe(true)
      expect(createStableError(code, code).status).toBe(status)
    }
  })
})
