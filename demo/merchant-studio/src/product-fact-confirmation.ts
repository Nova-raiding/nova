export type ProductSellingPointProof = {
  id: string
  text: string
  proofStatus: 'pending' | 'confirmed' | 'rejected'
  sourceIds: string[]
}

export function productFactConfirmationBlockers(
  sellingPoints: ProductSellingPointProof[] | undefined,
): ProductSellingPointProof[] {
  return (sellingPoints ?? []).filter(
    (point) => point.proofStatus !== 'confirmed' || point.sourceIds.length === 0,
  )
}

export function isSellingPointProofRequiredError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const candidate = error as { code?: unknown; message?: unknown }
  return candidate.code === 'SELLING_POINT_PROOF_REQUIRED'
    || (typeof candidate.message === 'string' && candidate.message.includes('核心卖点必须有来源并完成证明确认'))
}
