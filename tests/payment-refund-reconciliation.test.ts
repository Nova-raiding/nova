import { describe, expect, it } from 'vitest'
import { runPaymentReconciliationAcceptance } from './verify-payment-reconciliation.js'

describe('isolated payment/refund reconciliation acceptance', () => {
  it('reconciles confirmed, failed and unknown refunds without duplicate or cross-tenant ledger writes', async () => {
    const report = await runPaymentReconciliationAcceptance()

    expect(report.schemaVersion).toBe(1)
    expect(report.fixtureOnly).toBe(true)
    expect(report.provider).toContain('localhost synthetic')
    expect(report.realPaymentCalls).toBe(0)
    expect(report.realModelCalls).toBe(0)
    expect(report.sharedContainersTouched).toBe(false)
    expect(report.errors).toEqual([])
    expect(report.fingerprintsAfter).toEqual(report.fingerprintsBefore)
    expect(report.disposal?.leftRunning).toEqual([])

    // The verifier also records every worker HTTP exchange with this stage;
    // the final entry is the post-settlement ledger invariant summary.
    const settlement = report.checks.filter(check => check.stage === 'settlement_and_refund_idempotency').at(-1)
    expect(settlement).toMatchObject({
      otherTenantUnchanged: true,
      refundHolds: 'synthetic-seeded-not-refund-dispatch-proof',
    })
    expect(JSON.stringify(settlement)).toContain('refund_success')
    expect(JSON.stringify(settlement)).toContain('refund_failed')
    expect(JSON.stringify(settlement)).toContain('refund_unknown')

    expect(report.checks.some(check => check.stage === 'limit_one_oldest_queue_fairness')).toBe(true)
    expect(report.checks.some(check => check.stage === 'durable_audits')).toBe(true)
    expect(report.checks.some(check => check.stage?.startsWith('sql_lock_lease_loss_'))).toBe(true)
  }, 250_000)
})
