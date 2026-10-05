import { describe, expect, it, vi } from 'vitest'
import { DomainError } from '../../../packages/application/src/service.js'
import { CommercialContractError } from '../../../packages/persistence/src/commercial-contract-repository.js'
import { handleCommercialMcpMethod, type CommercialMcpDependencies } from './mcp-commercial-handlers.js'

const req = { headers: {} } as never

function depsFor(error: unknown): CommercialMcpDependencies {
  return {
    ready: Promise.resolve(),
    persistence: { commercialContracts: { createUpgradeQuote: vi.fn(async () => { throw error }) } } as never,
    actor: () => 'actor-1',
  } as unknown as CommercialMcpDependencies
}

describe('commercial upgrade quote domain errors', () => {
  it.each([
    [new CommercialContractError('COMMERCIAL_ONBOARDING_REQUIRED', 'verified onboarding required'), 'COMMERCIAL_ONBOARDING_REQUIRED', 409],
    [{ name: 'CommercialPlanChangePolicyError', code: 'COMMERCIAL_DOWNGRADE_NOT_ALLOWED', message: 'raw repository message' }, 'COMMERCIAL_DOWNGRADE_NOT_ALLOWED', 409],
    [{ name: 'CommercialPlanChangePolicyError', code: 'COMMERCIAL_PLAN_FAMILY_MISMATCH', message: 'raw repository message' }, 'COMMERCIAL_PLAN_FAMILY_MISMATCH', 409],
    [new CommercialContractError('COMMERCIAL_IDEMPOTENCY_CONFLICT', 'quote key reused'), 'COMMERCIAL_IDEMPOTENCY_CONFLICT', 409],
    [new CommercialContractError('COMMERCIAL_POLICY_UNRESOLVED', 'internal policy detail'), 'COMMERCIAL_UPGRADE_UNAVAILABLE', 503],
    [new CommercialContractError('COMMERCIAL_CATALOG_UNAVAILABLE', 'catalog internal detail'), 'COMMERCIAL_UPGRADE_UNAVAILABLE', 503],
  ])('maps %s to public code %s', async (error, code, status) => {
    await expect(handleCommercialMcpMethod('commercial.upgrade.quote.create', {
      target_sku_code: 'growth', idempotency_key: 'quote-1',
    }, 'workspace-1', req, depsFor(error))).rejects.toMatchObject({ code, status })
  })

  it('keeps unexpected infrastructure failures on the normal internal-error path', async () => {
    const failure = new Error('database socket reset')
    await expect(handleCommercialMcpMethod('commercial.upgrade.quote.create', {
      target_sku_code: 'growth', idempotency_key: 'quote-1',
    }, 'workspace-1', req, depsFor(failure))).rejects.toBe(failure)
    expect(failure).not.toBeInstanceOf(DomainError)
  })
})
