import { ocrCreativePointsFromCost, ocrCreativePointsFromCostWithFreeThreshold } from './ocr-cost-points.js'

export const OCR_COST_POINT_POLICY_VERSION = 'ocr.cost_cny_x2_ceil_min1.v1'
export const OCR_FREE_THRESHOLD_POINT_POLICY_VERSION = 'ocr.cost_cny_free_lte_0_3_x2_ceil_min1.v1'
export type OcrPointPolicyVersion = typeof OCR_COST_POINT_POLICY_VERSION | typeof OCR_FREE_THRESHOLD_POINT_POLICY_VERSION

function pointsForPolicy(costCny: unknown, policyVersion: OcrPointPolicyVersion): number {
  if (policyVersion === OCR_FREE_THRESHOLD_POINT_POLICY_VERSION) return ocrCreativePointsFromCostWithFreeThreshold(costCny)
  if (policyVersion === OCR_COST_POINT_POLICY_VERSION) return ocrCreativePointsFromCost(costCny)
  throw new TypeError('OCR_POINT_POLICY_UNSUPPORTED')
}

/** Reserve the whole task ceiling before the OCR relay request can leave. */
export function quoteOcrPointHold(taskCapCny: unknown, policyVersion: OcrPointPolicyVersion = OCR_COST_POINT_POLICY_VERSION) {
  if (typeof taskCapCny !== 'number' || !Number.isFinite(taskCapCny) || taskCapCny <= 0) {
    throw new TypeError('OCR_TASK_COST_CAP_INVALID')
  }
  return { points: Math.max(1, pointsForPolicy(taskCapCny, policyVersion)), policyVersion }
}

export type OcrPointDecision =
  | { action: 'settle'; actualPoints: number; policyVersion: OcrPointPolicyVersion }
  | { action: 'release'; reason: 'provider_definitively_failed' }
  | { action: 'hold'; reason: 'outcome_unknown' | 'failure_unverified' | 'receipt_unverified' | 'cost_invalid' | 'cost_exceeds_hold' }

/**
 * This is a decision only. The caller must persist a provider receipt and use
 * an idempotent creative-point repository operation before delivering facts.
 */
export function decideOcrPointFinalization(input: {
  reservedPoints: number
  providerOutcome: 'succeeded' | 'failed' | 'unknown'
  definitiveFailure?: boolean
  verifiedReceipt?: boolean
  actualCostCny?: unknown
  policyVersion?: OcrPointPolicyVersion
}): OcrPointDecision {
  const policyVersion = input.policyVersion ?? OCR_COST_POINT_POLICY_VERSION
  if (policyVersion !== OCR_COST_POINT_POLICY_VERSION && policyVersion !== OCR_FREE_THRESHOLD_POINT_POLICY_VERSION) {
    throw new TypeError('OCR_POINT_POLICY_UNSUPPORTED')
  }
  if (!Number.isSafeInteger(input.reservedPoints) || input.reservedPoints < 1) throw new TypeError('OCR_POINT_HOLD_INVALID')
  if (input.providerOutcome === 'unknown') return { action: 'hold', reason: 'outcome_unknown' }
  if (input.providerOutcome === 'failed') return input.definitiveFailure === true
    ? { action: 'release', reason: 'provider_definitively_failed' }
    : { action: 'hold', reason: 'failure_unverified' }
  if (input.verifiedReceipt !== true) return { action: 'hold', reason: 'receipt_unverified' }
  let actualPoints: number
  try { actualPoints = pointsForPolicy(input.actualCostCny, policyVersion) }
  catch { return { action: 'hold', reason: 'cost_invalid' } }
  if (actualPoints > input.reservedPoints) return { action: 'hold', reason: 'cost_exceeds_hold' }
  return { action: 'settle', actualPoints, policyVersion }
}
