import { describe, expect, it } from 'vitest'
import { decideOcrPointFinalization, OCR_FREE_THRESHOLD_POINT_POLICY_VERSION, quoteOcrPointHold } from './ocr-point-lifecycle.js'

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

  it('waives verified v4 OCR cost up to ¥0.30 and charges only above it', () => {
    const policyVersion = OCR_FREE_THRESHOLD_POINT_POLICY_VERSION
    expect(quoteOcrPointHold(20, policyVersion)).toEqual({ points: 40, policyVersion })
    expect(quoteOcrPointHold(0.3, policyVersion)).toEqual({ points: 1, policyVersion })
    expect(quoteOcrPointHold(0.01, policyVersion)).toEqual({ points: 1, policyVersion })
    for (const actualCostCny of [0, 0.0000683, 0.3]) {
      expect(decideOcrPointFinalization({ reservedPoints: 40, providerOutcome: 'succeeded', verifiedReceipt: true, actualCostCny, policyVersion }))
        .toEqual({ action: 'settle', actualPoints: 0, policyVersion })
    }
    expect(decideOcrPointFinalization({ reservedPoints: 40, providerOutcome: 'succeeded', verifiedReceipt: true, actualCostCny: 0.300001, policyVersion }))
      .toEqual({ action: 'settle', actualPoints: 1, policyVersion })
    expect(decideOcrPointFinalization({ reservedPoints: 40, providerOutcome: 'succeeded', verifiedReceipt: true, actualCostCny: 0.500001, policyVersion }))
      .toEqual({ action: 'settle', actualPoints: 2, policyVersion })
  })

  it('holds unknown, unverified and malformed outcomes; releases only definitive failure', () => {
    expect(decideOcrPointFinalization({ reservedPoints: 40, providerOutcome: 'unknown' })).toEqual({ action: 'hold', reason: 'outcome_unknown' })
    expect(decideOcrPointFinalization({ reservedPoints: 40, providerOutcome: 'failed' })).toEqual({ action: 'hold', reason: 'failure_unverified' })
    expect(decideOcrPointFinalization({ reservedPoints: 40, providerOutcome: 'failed', definitiveFailure: true })).toEqual({ action: 'release', reason: 'provider_definitively_failed' })
    expect(decideOcrPointFinalization({ reservedPoints: 40, providerOutcome: 'succeeded', actualCostCny: 1 })).toEqual({ action: 'hold', reason: 'receipt_unverified' })
    expect(decideOcrPointFinalization({ reservedPoints: 40, providerOutcome: 'succeeded', verifiedReceipt: true, actualCostCny: Number.NaN })).toEqual({ action: 'hold', reason: 'cost_invalid' })
  })
})
