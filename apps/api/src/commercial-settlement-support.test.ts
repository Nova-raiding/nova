import { describe, expect, it, vi } from 'vitest'
import { refundActionSettlement, refundEntitlement } from './commercial-settlement-support.js'

describe('commercial settlement refund fail-closed behavior', () => {
  it('rejects a direct refund when the action ledger is unavailable', async () => {
    await expect(refundActionSettlement(
      { workspaceId: 'ws-test', actionKey: 'action-test', reason: 'provider failed' },
      { ready: Promise.resolve(), actionLedger: () => undefined },
    )).rejects.toMatchObject({ code: 'ACTION_LEDGER_UNAVAILABLE', status: 503 })
  })

  it('does not consume a legacy entitlement before verifying the action ledger', async () => {
    const entitlementRefund = vi.fn()
    await expect(refundEntitlement(
      { workspaceId: 'ws-test', actionKey: 'action-test', reason: 'provider failed' },
      {
        ready: Promise.resolve(),
        entitlements: () => ({ refund: entitlementRefund } as never),
        actionLedger: () => undefined,
        refundActionSettlement: vi.fn(),
      },
    )).rejects.toMatchObject({ code: 'ACTION_LEDGER_UNAVAILABLE', status: 503 })
    expect(entitlementRefund).not.toHaveBeenCalled()
  })
})
