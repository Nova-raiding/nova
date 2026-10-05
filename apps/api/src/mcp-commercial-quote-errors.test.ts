import { describe, expect, it, vi } from 'vitest'
import { DomainError } from '../../../packages/application/src/service.js'
import { CommercialContractError } from '../../../packages/persistence/src/commercial-contract-repository.js'
import { handleCommercialMcpMethod, type CommercialMcpDependencies } from './mcp-commercial-handlers.js'

const req = { headers: {} } as never

function depsFor(error: unknown): CommercialMcpDependencies {
  return {
    ready: Promise.resolve(),
    persistence: { commercialContracts: { createUpgradeQuote: vi.fn(async () => { throw error }) } } as never,
    required: (params: Record<string, unknown>, key: string) => String(params[key]),
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

  it('binds merchant-created checkouts to the authenticated member for private result notices', async () => {
    const memberId = 'member-merchant'
    const onboardingSku = { kind: 'onboarding', priceFen: 500000, code: 'opening' }
    const subscriptionSku = { kind: 'monthly', priceFen: 200000, code: 'basic' }
    const createFirstCheckout = vi.fn(async () => ({
      checkoutId: 'checkout-1', amountFen: 700000, onboarding: { id: 'opening-order', amountFen: 500000 }, subscription: { id: 'subscription-order', amountFen: 200000 },
    }))
    const deps = {
      ready: Promise.resolve(),
      persistence: { commercialCatalog: { resolveApprovedExecutableSku: vi.fn(async ({ code }: { code: string }) => code === 'opening' ? onboardingSku : subscriptionSku) }, commercialContracts: { createFirstCheckout } },
      required: (params: Record<string, unknown>, key: string) => String(params[key]), actor: () => 'merchant-actor', paymentProvider: () => 'manual_transfer', memberId: vi.fn(async () => memberId), viewOrder: vi.fn(async (order: unknown) => order),
    } as unknown as CommercialMcpDependencies
    await handleCommercialMcpMethod('commercial.checkout.create', { onboarding_sku_code: 'opening', subscription_sku_code: 'basic', idempotency_key: 'checkout-1', reason: 'merchant checkout' }, 'workspace-1', req, deps)
    expect(createFirstCheckout).toHaveBeenCalledWith(expect.objectContaining({ beneficiaryMemberId: memberId }))
  })
})
