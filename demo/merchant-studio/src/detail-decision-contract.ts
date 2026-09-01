export type DecisionEvidenceStatus =
  | 'verified'
  | 'missing'
  | 'expired'
  | 'conflict'

export interface DetailPageDecisionContract {
  buyerQuestion: string
  pageTask: string
  claim: {
    limitations: readonly string[]
  }
  evidence: {
    status: DecisionEvidenceStatus
  }
}

export function moduleDecisionContract(module: unknown): DetailPageDecisionContract | null {
  if (!module || typeof module !== 'object') return null
  const contract = (module as { decisionContract?: unknown }).decisionContract
  if (!contract || typeof contract !== 'object') return null
  const candidate = contract as Record<string, unknown>
  const claim = candidate.claim
  const evidence = candidate.evidence
  if (
    typeof candidate.buyerQuestion !== 'string' ||
    typeof candidate.pageTask !== 'string' ||
    !claim ||
    typeof claim !== 'object' ||
    !Array.isArray((claim as Record<string, unknown>).limitations) ||
    !(claim as { limitations: unknown[] }).limitations.every(
      (item) => typeof item === 'string',
    ) ||
    !evidence ||
    typeof evidence !== 'object' ||
    !['verified', 'missing', 'expired', 'conflict'].includes(
      String((evidence as Record<string, unknown>).status),
    )
  ) return null
  return contract as DetailPageDecisionContract
}
