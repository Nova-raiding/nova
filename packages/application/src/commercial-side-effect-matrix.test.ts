import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import {
  COMMERCIAL_OPERATION_REGISTRY,
  type CommercialOperationPolicy,
} from '@merchant-marketing/contracts'
import { CommercialAccessService, type CreativePointBalanceProjection } from './commercial-access-service.js'

const sideEffectNames = ['dbMutation', 'outbox', 'queue', 'storage', 'relay', 'scanner', 'connector'] as const
type SideEffectName = typeof sideEffectNames[number]
type SideEffectSpy = ReturnType<typeof vi.fn<(policy: CommercialOperationPolicy) => void>>

function sideEffectSpies(): Record<SideEffectName, SideEffectSpy> {
  return Object.fromEntries(sideEffectNames.map(name => [name, vi.fn<(policy: CommercialOperationPolicy) => void>()])) as Record<SideEffectName, SideEffectSpy>
}

async function guardedDispatch(
  service: CommercialAccessService,
  policy: CommercialOperationPolicy,
  effects: Record<SideEffectName, SideEffectSpy>,
) {
  const result = await service.decide({ surface: policy.surface, operation: policy.operation, workspace_id: 'ws_matrix' })
  if (result.outcome === 'DECISION' && result.decision.allowed) {
    for (const name of sideEffectNames) effects[name](policy)
  }
  return result
}

function serviceFor(registry: readonly CommercialOperationPolicy[], balance: CreativePointBalanceProjection, quote = 2) {
  return new CommercialAccessService({
    registry,
    registry_version: 'commercial-side-effect-matrix.v1',
    balance_projection: { projectCreativePointBalance: vi.fn(async () => balance) },
    rate_resolver: { resolveApprovedRate: vi.fn(async () => ({ state: 'approved' as const, quoted_points: quote, rate_card_version: 'rate-approved-v1' })) },
    entitlement_projection: { listV2EntitlementSnapshots: vi.fn(async () => [{
      id: 'entitlement-v2-matrix', workspaceId: 'ws_matrix', subscriptionPeriodId: 'period-matrix',
      periodStart: '2026-01-01T00:00:00.000Z', periodEnd: '2027-01-01T00:00:00.000Z', periodStatus: 'active',
      catalogVersionId: 'catalog-matrix', skuCode: 'monthly_basic',
      resolvedBenefits: [{ code: 'max_brands', quantity: 1 }, { code: 'max_stores', quantity: 5 }],
      unresolvedBlockers: [], executable: true, checksum: 'a'.repeat(64), createdAt: '2026-01-01T00:00:00.000Z',
    }]) },
    id_factory: () => 'decision-matrix',
    now: () => new Date('2026-09-02T00:00:00.000Z'),
  })
}

function expectNoSideEffects(effects: Record<SideEffectName, SideEffectSpy>) {
  for (const name of sideEffectNames) expect(effects[name], `${name} must remain untouched`).not.toHaveBeenCalled()
}

function policyId(policy: CommercialOperationPolicy) {
  return `${policy.surface}:${policy.operation}`
}

function inventoryDiagnostic(policies: readonly CommercialOperationPolicy[]) {
  const bySurface = policies.reduce<Record<string, number>>((counts, policy) => {
    counts[policy.surface] = (counts[policy.surface] ?? 0) + 1
    return counts
  }, {})
  return JSON.stringify({ total: policies.length, bySurface })
}

function expectExactExecution(
  expectedPolicies: readonly CommercialOperationPolicy[],
  executedIds: ReadonlySet<string>,
  label: string,
) {
  const expectedIds = expectedPolicies.map(policyId).sort()
  expect(
    [...executedIds].sort(),
    `${label}; registry inventory ${inventoryDiagnostic(expectedPolicies)}`,
  ).toEqual(expectedIds)
}

const enabledBusiness = COMMERCIAL_OPERATION_REGISTRY.filter(policy =>
  policy.domain === 'COMMERCIAL' && policy.enabled && policy.classification !== 'RECOVERY_CONTROL')
const disabledBusiness = COMMERCIAL_OPERATION_REGISTRY.filter(policy =>
  policy.domain === 'COMMERCIAL' && !policy.enabled && policy.classification !== 'RECOVERY_CONTROL')
const chargedInventory = COMMERCIAL_OPERATION_REGISTRY.filter(policy =>
  policy.domain === 'COMMERCIAL' && policy.classification === 'POINT_CHARGED')

describe('commercial registry generated zero-side-effect E1 matrix', () => {
  it('covers every current enabled MCP/HTTP business entry from the shared registry', () => {
    const ids = enabledBusiness.map(policyId)
    expect(enabledBusiness.length, inventoryDiagnostic(enabledBusiness)).toBeGreaterThan(0)
    expect(new Set(enabledBusiness.map(policy => policy.surface))).toEqual(new Set(['MCP', 'HTTP']))
    expect(new Set(ids).size, `duplicate operation ID; ${inventoryDiagnostic(enabledBusiness)}`).toBe(ids.length)
  })

  it('keeps the two central API dispatch gates before hydration and handler dispatch', () => {
    const source = readFileSync(new URL('../../../apps/api/src/server.ts', import.meta.url), 'utf8')
    const mcpStart = source.indexOf('async function routeMcp(')
    const mcp = source.slice(mcpStart, source.indexOf('export async function route(', mcpStart))
    const mcpGate = mcp.indexOf('await enforceMcpCommercialAccess(req, workspaceId, method)')
    expect(mcpGate).toBeGreaterThan(0)
    expect(mcpGate).toBeLessThan(mcp.indexOf('requireStoreOnboarding(workspaceId, method)'))
    expect(mcpGate).toBeLessThan(mcp.indexOf('await hydrateKnowledge(workspaceId)'))
    expect(mcpGate).toBeLessThan(mcp.indexOf('switch (method)'))

    const http = source.slice(source.indexOf("if (req.method === 'OPTIONS')"), source.indexOf("if (req.method === 'GET' && path === '/v1/commercial/access')"))
    const httpGate = http.indexOf('await enforceHttpCommercialAccess(req, requestWorkspace, httpOperationPolicy.operation)')
    expect(httpGate).toBeGreaterThan(0)
    expect(httpGate).toBeLessThan(http.indexOf('await hydrateWorkspaceFromPersistence(hydrateRequestWorkspace)'))
  })

  it.each([
    ['zero', { state: 'known', available_points: 0, access_revision: '7', freshness: 'fresh' } as const, 'CREATIVE_POINTS_EXHAUSTED'],
    ['unknown', { state: 'unknown' } as const, 'CREATIVE_POINTS_UNAVAILABLE'],
  ])('rejects the complete enabled non-recovery inventory at %s before every side-effect port', async (_state, balance, code) => {
    const effects = sideEffectSpies()
    const service = serviceFor(COMMERCIAL_OPERATION_REGISTRY, balance)
    const executedIds = new Set<string>()
    for (const policy of enabledBusiness) {
      const result = await guardedDispatch(service, policy, effects)
      expect(result, policyId(policy)).toMatchObject({ outcome: 'DECISION', decision: { allowed: false, error_code: code } })
      executedIds.add(policyId(policy))
    }
    expectExactExecution(enabledBusiness, executedIds, `${_state} rejection execution coverage`)
    expectNoSideEffects(effects)
  })

  it('rejects every disabled business entry before balance, quote, or side-effect work', async () => {
    const effects = sideEffectSpies()
    const service = serviceFor(COMMERCIAL_OPERATION_REGISTRY, { state: 'known', available_points: 100, access_revision: '7', freshness: 'fresh' })
    const executedIds = new Set<string>()
    for (const policy of disabledBusiness) {
      const result = await guardedDispatch(service, policy, effects)
      expect(result, policyId(policy)).toMatchObject({ outcome: 'DENY_DISABLED' })
      executedIds.add(policyId(policy))
    }
    expectExactExecution(disabledBusiness, executedIds, 'disabled rejection execution coverage')
    expectNoSideEffects(effects)
  })

  it('proves the registry-derived charged inventory fails insufficient before every side-effect port when enabled after approval', async () => {
    // No charged entry is currently enabled. Derive the future cutover matrix
    // from the authoritative inventory and change only `enabled` so the real
    // decision engine can exercise the insufficient branch before approval.
    const enabledCharged = COMMERCIAL_OPERATION_REGISTRY.map(policy =>
      policy.domain === 'COMMERCIAL' && policy.classification === 'POINT_CHARGED'
        ? { ...policy, enabled: true }
        : policy)
    const effects = sideEffectSpies()
    const service = serviceFor(enabledCharged, { state: 'known', available_points: 1, access_revision: '7', freshness: 'fresh' }, 2)
    const executedIds = new Set<string>()
    for (const policy of chargedInventory) {
      const result = await guardedDispatch(service, { ...policy, enabled: true }, effects)
      expect(result, policyId(policy)).toMatchObject({
        outcome: 'DECISION',
        decision: { allowed: false, error_code: 'CREATIVE_POINTS_INSUFFICIENT', available_points: 1, quoted_points: 2 },
      })
      executedIds.add(policyId(policy))
    }
    expectExactExecution(chargedInventory, executedIds, 'insufficient rejection execution coverage')
    expectNoSideEffects(effects)
  })
})
