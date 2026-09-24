export const STRUCTURE_REVIEW_PATHS: readonly string[]
export const PROTECTED_OPS_PATHS: readonly string[]

export interface SanitizedStructureSummary {
  kind: string
  [field: string]: unknown
}

export type ReviewByteSummary =
  | { status: 'reviewed'; sha256: string; bytes: number; summary: SanitizedStructureSummary }
  | { status: 'unable_to_safely_parse'; sha256: string; bytes: number; reason_code: 'STRUCTURE_PARSE_REJECTED' }

export function summarizeReviewBytes(path: string, bytes: Buffer): ReviewByteSummary
