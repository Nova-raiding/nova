import { describe, expect, it } from 'vitest'
import { decideOcrPointFinalization, quoteOcrPointHold } from './ocr-point-lifecycle.js'

describe('OCR point lifecycle decisions', () => {
  it('reserves the complete configured cost ceiling before dispatch', () => {
    expect(quoteOcrPointHold(20)).toEqual({ points: 40, policyVersion: 'ocr.cost_cny_x2_ceil_min1.v1' })
    expect(quoteOcrPointHold(0.01).points).toBe(1)
    expect(() => quoteOcrPointHold(0)).toThrow('OCR_TASK_COST_CAP_INVALID')
  })

  it('settles only a verified cost within the held points', () => {
    expect(decideOcrPointFinalization({ reservedPoints: 40, providerOutcome: 'succeeded', verifiedReceipt: true, actualCostCny: 0.003511 }))
      .toEqual({ action: 'settle', actualPoints: 1, policyVersion: 'ocr.cost_cny_x2_ceil_min1.v1' })
    expect(decideOcrPointFinalization({ reservedPoints: 40, providerOutcome: 'succeeded', verifiedReceipt: true, actualCostCny: 2.1 }))
      .toMatchObject({ action: 'settle', actualPoints: 5 })
    expect(decideOcrPointFinalization({ reservedPoints: 40, providerOutcome: 'succeeded', verifiedReceipt: true, actualCostCny: 20.01 }))
      .toEqual({ action: 'hold', reason: 'cost_exceeds_hold' })
  })

  it('holds unknown, unverified and malformed outcomes; releases only definitive failure', () => {
    expect(decideOcrPointFinalization({ reservedPoints: 40, providerOutcome: 'unknown' })).toEqual({ action: 'hold', reason: 'outcome_unknown' })
    expect(decideOcrPointFinalization({ reservedPoints: 40, providerOutcome: 'failed' })).toEqual({ action: 'hold', reason: 'failure_unverified' })
    expect(decideOcrPointFinalization({ reservedPoints: 40, providerOutcome: 'failed', definitiveFailure: true })).toEqual({ action: 'release', reason: 'provider_definitively_failed' })
    expect(decideOcrPointFinalization({ reservedPoints: 40, providerOutcome: 'succeeded', actualCostCny: 1 })).toEqual({ action: 'hold', reason: 'receipt_unverified' })
    expect(decideOcrPointFinalization({ reservedPoints: 40, providerOutcome: 'succeeded', verifiedReceipt: true, actualCostCny: Number.NaN })).toEqual({ action: 'hold', reason: 'cost_invalid' })
  })
})
