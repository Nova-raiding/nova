/** Calculate OCR creative points from a verified actual cost in CNY. */
export function ocrCreativePointsFromCost(costCny: unknown): number {
  if (typeof costCny !== 'number' || !Number.isFinite(costCny) || costCny < 0) {
    throw new TypeError('OCR_COST_CNY_INVALID')
  }
  const rawPoints = costCny * 2
  if (!Number.isFinite(rawPoints) || rawPoints > Number.MAX_SAFE_INTEGER) {
    throw new RangeError('OCR_CREATIVE_POINTS_OVERFLOW')
  }
  const points = Math.max(1, Math.ceil(rawPoints))
  if (!Number.isSafeInteger(points)) throw new RangeError('OCR_CREATIVE_POINTS_OVERFLOW')
  return points
}

/** The v4 OCR rate waives verified costs up to and including ¥0.30. */
export function ocrCreativePointsFromCostWithFreeThreshold(costCny: unknown): number {
  if (typeof costCny !== 'number' || !Number.isFinite(costCny) || costCny < 0) {
    throw new TypeError('OCR_COST_CNY_INVALID')
  }
  if (costCny <= 0.3) return 0
  return ocrCreativePointsFromCost(costCny)
}
