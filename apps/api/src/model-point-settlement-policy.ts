import { decideOcrPointFinalization, type OcrPointPolicyVersion } from '../../../packages/application/src/ocr-point-lifecycle.js'

export const MODEL_FREE_THRESHOLD_POINT_POLICY_VERSION = 'model.cost_cny_free_lt_0_1.v1'

/** Decide customer points only; provider cost, budgets and receipts remain payable evidence. */
export function decideModelPointFinalization(input: {
  modality: string
  reservedPoints: number
  actualCostCny?: unknown
  verifiedReceipt: boolean
  ocrPolicyVersion?: OcrPointPolicyVersion
}): { action: 'settle'; actualPoints: number; policyVersion: string } | { action: 'hold'; reason: string } {
  if (!Number.isSafeInteger(input.reservedPoints) || input.reservedPoints < 1) throw new TypeError('MODEL_POINT_HOLD_INVALID')
  if (input.modality === 'ocr') {
    const decision = decideOcrPointFinalization({ ...input, providerOutcome: 'succeeded', policyVersion: input.ocrPolicyVersion })
    if (decision.action === 'release') return { action: 'hold', reason: 'receipt_unverified' }
    return decision
  }
  if (!input.verifiedReceipt) return { action: 'hold', reason: 'receipt_unverified' }
  if (typeof input.actualCostCny !== 'number' || !Number.isFinite(input.actualCostCny) || input.actualCostCny < 0) return { action: 'hold', reason: 'cost_invalid' }
  return {
    action: 'settle',
    actualPoints: input.actualCostCny < 0.1 ? 0 : input.reservedPoints,
    policyVersion: MODEL_FREE_THRESHOLD_POINT_POLICY_VERSION,
  }
}
