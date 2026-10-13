import { describe, expect, it } from 'vitest'
import { billingStatusProjection } from './mcp-billing-status.js'

function project(input: Partial<Parameters<typeof billingStatusProjection>[0]> = {}) {
  return billingStatusProjection({
    workspaceId: 'ws-billing-test',
    balanceFen: 0,
    storeCapacitySnapshot: null,
    pendingAuthorizationFen: 0,
    pendingActionCount: 0,
    canViewWorkspaceBilling: true,
    pointBalance: { availablePoints: 10, reservedPoints: 0, settledPoints: 0, revision: 1 },
    capabilityEntitlements: null,
    actionCards: [],
    providerReady: false,
    ...input,
  })
}

describe('billing.status balance and eligibility projection', () => {
  it('does not turn an unknown point balance into a recharge recommendation', () => {
    expect(project({ pointBalance: undefined })).toMatchObject({
      balance_state: 'unknown',
      available_points: null,
      allowed: null,
      plugin_access: { balance_available: null },
      model_access: {
        access_state: 'eligibility_unverified',
        message: expect.stringContaining('余额待确认'),
      },
    })
  })

  it('distinguishes a known zero balance from an unknown balance', () => {
    expect(project({ pointBalance: { availablePoints: 0, reservedPoints: 0, settledPoints: 0, revision: 2 } })).toMatchObject({
      balance_state: 'known',
      available_points: 0,
      allowed: false,
      plugin_access: { balance_available: false },
      model_access: { access_state: 'recharge_required' },
    })
  })

  it('reports a positive balance without implying commercial generation eligibility', () => {
    expect(project()).toMatchObject({
      balance_state: 'known',
      available_points: 10,
      allowed: true,
      plugin_access: { balance_available: true, eligibility_state: 'not_checked' },
      model_access: { access_state: 'eligibility_unverified' },
    })
  })

  it('keeps an unauthorized workspace balance restricted', () => {
    expect(project({ canViewWorkspaceBilling: false })).toMatchObject({
      balance_state: 'restricted',
      available_points: null,
      allowed: null,
      plugin_access: { balance_available: null, eligibility_state: 'restricted' },
      model_access: { access_state: 'restricted' },
    })
  })
})
