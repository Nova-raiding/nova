import { describe, expect, it } from 'vitest'
import { PrivateTrialConversionService } from './private-trial-conversion-service.js'

const port = () => ({
  createEligibility: async () => ({ id: 'elig_1', workspaceId: 'ws_1', customerRef: 'crm_1', status: 'pending_business_approval' as const, revision: 1, expiresAt: null }),
  approveEligibility: async () => ({ id: 'elig_1', workspaceId: 'ws_1', customerRef: 'crm_1', status: 'approved_pending_validation' as const, revision: 2, expiresAt: null }),
  bindValidationCompletion: async () => ({ id: 'elig_1', workspaceId: 'ws_1', customerRef: 'crm_1', status: 'approved' as const, revision: 3, expiresAt: '2026-09-08T00:00:00.000Z' }),
  prepareCredit: async () => ({ id: 'credit_1', status: 'pending_accounting_approval' as const, expiresAt: '2026-09-08T00:00:00.000Z' }),
  approveCredit: async () => ({ id: 'credit_1', status: 'approved' as const, expiresAt: '2026-09-08T00:00:00.000Z' }),
  createConversionOrder: async () => ({ eligibility_id: 'elig_1', credit_id: 'credit_1', onboarding_order_id: 'order_1', list_amount_fen: 500000 as const, offset_amount_fen: 199900 as const, payable_amount_fen: 300100 as const, status: 'pending' as const, expires_at: '2026-09-08T00:00:00.000Z' }),
  markCreditApplied: async () => ({ id: 'credit_1', status: 'applied' as const, expiresAt: '2026-09-08T00:00:00.000Z' }),
})

describe('PrivateTrialConversionService', () => {
  it('keeps the conversion order pending and server-priced at 5000 - 1999 = 3001', async () => {
    const service = new PrivateTrialConversionService(port(), () => new Date('2026-09-02T00:00:00Z'))
    await expect(service.createConversionOrder({ workspaceId: 'ws_1', creditId: 'credit_1', actorId: 'finance_1', idempotencyKey: 'conversion_1', reason: 'approved trial conversion' })).resolves.toMatchObject({ list_amount_fen: 500000, offset_amount_fen: 199900, payable_amount_fen: 300100, status: 'pending' })
  })

  it('requires non-empty evidence and a positive concurrency revision for privileged actions', async () => {
    const service = new PrivateTrialConversionService(port())
    expect(() => service.approveEligibility({ workspaceId: 'ws_1', eligibilityId: 'elig_1', expectedRevision: 0, actorId: 'ops_1', idempotencyKey: 'approve_1', reason: 'ok', evidence: { case: 'C-1' } })).toThrow('expectedRevision')
    expect(() => service.bindValidationCompletion({ workspaceId: 'ws_1', eligibilityId: 'elig_1', trialOrderId: 'trial_1', completedAt: 'not-a-time', actorId: 'ops_1', idempotencyKey: 'validate_1', reason: 'ok', evidence: { case: 'C-1' } })).toThrow('completedAt')
    expect(() => service.prepareCredit({ workspaceId: 'ws_1', eligibilityId: 'elig_1', actorId: 'ops_1', idempotencyKey: 'credit_1', reason: 'ok', evidence: {} })).toThrow('evidence')
  })
})
