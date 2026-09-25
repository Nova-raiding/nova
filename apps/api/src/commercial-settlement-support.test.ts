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

  it('fails closed when entitlement persistence has no atomic refund operation', async () => {
    await expect(refundEntitlement(
      { workspaceId: 'ws-test', actionKey: 'action-test', reason: 'provider failed' },
      {
        ready: Promise.resolve(),
        entitlements: () => ({ refund: vi.fn() } as never),
        actionLedger: () => ({ refund: vi.fn() } as never),
        refundActionSettlement: vi.fn(),
      },
    )).rejects.toMatchObject({ code: 'ATOMIC_REFUND_UNAVAILABLE', status: 503 })
  })

  it('returns the atomic repository result without attempting a second ledger refund', async () => {
    const atomicRefund = vi.fn().mockResolvedValue({ refunded: false })
    const refundActionLedger = vi.fn()
    await expect(refundEntitlement(
      { workspaceId: 'ws-test', actionKey: 'action-test', reason: 'provider failed' },
      {
        ready: Promise.resolve(),
        entitlements: () => ({ refundWithActionLedger: atomicRefund } as never),
        actionLedger: () => ({ refund: refundActionLedger } as never),
        refundActionSettlement: refundActionLedger,
      },
    )).resolves.toEqual({ refunded: false })
    expect(atomicRefund).toHaveBeenCalledWith({ workspaceId: 'ws-test', idempotencyKey: 'action-test', reason: 'provider failed' })
    expect(refundActionLedger).not.toHaveBeenCalled()
  })

  it('propagates atomic repository failures without starting a second refund', async () => {
    const failure = new Error('database transaction failed')
    const atomicRefund = vi.fn().mockRejectedValue(failure)
    const refundActionLedger = vi.fn()
    await expect(refundEntitlement(
      { workspaceId: 'ws-test', actionKey: 'action-test', reason: 'provider failed' },
      {
        ready: Promise.resolve(),
        entitlements: () => ({ refundWithActionLedger: atomicRefund } as never),
        actionLedger: () => ({ refund: refundActionLedger } as never),
        refundActionSettlement: refundActionLedger,
      },
    )).rejects.toBe(failure)
    expect(refundActionLedger).not.toHaveBeenCalled()
  })
})
