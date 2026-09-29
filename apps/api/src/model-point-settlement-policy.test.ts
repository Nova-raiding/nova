import { describe, expect, it } from 'vitest'
import { OCR_FREE_THRESHOLD_POINT_POLICY_VERSION } from '../../../packages/application/src/ocr-point-lifecycle.js'
import { decideModelPointFinalization } from './model-point-settlement-policy.js'

describe('verified model cost point settlement', () => {
  for (const modality of ['text', 'image', 'image_edit', 'video', 'embedding']) {
    it.each([0, 0.00090156, 0.099999, 0.1, 0.100001, 1])(`${modality} preserves the strict 0.1 boundary for %s`, cost => {
      expect(decideModelPointFinalization({ modality, reservedPoints: 3, actualCostCny: cost, verifiedReceipt: true }))
        .toMatchObject({ action: 'settle', actualPoints: cost < 0.1 ? 0 : 3 })
    })
  }
  it.each([undefined, null, NaN, Infinity, -Infinity, -0.001, '0', '0.01'])('holds invalid/unknown cost %s', cost => {
    expect(decideModelPointFinalization({ modality: 'text', reservedPoints: 1, actualCostCny: cost, verifiedReceipt: true }))
      .toEqual({ action: 'hold', reason: 'cost_invalid' })
  })
  it('does not waive an unverified receipt', () => {
    expect(decideModelPointFinalization({ modality: 'text', reservedPoints: 1, actualCostCny: 0, verifiedReceipt: false }))
      .toEqual({ action: 'hold', reason: 'receipt_unverified' })
  })
  it.each([0, 0.1, 0.3, 0.300001])('preserves the OCR inclusive 0.3 policy for %s', cost => {
    expect(decideModelPointFinalization({ modality: 'ocr', reservedPoints: 4, actualCostCny: cost, verifiedReceipt: true, ocrPolicyVersion: OCR_FREE_THRESHOLD_POINT_POLICY_VERSION }))
      .toMatchObject({ action: 'settle', actualPoints: cost <= 0.3 ? 0 : 1 })
  })
})
