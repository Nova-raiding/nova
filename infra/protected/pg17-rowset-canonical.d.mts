export type RlsPolicyObservation = {
  enabled: boolean
  forced: boolean
  policies: Array<{
    name: string
    cmd: string
    permissive: boolean
    roles: string[]
    qual: string | null
    with_check: string | null
  }>
}
export function canonicalRowsDigest(rows: Buffer[]): { row_count: number; canonical_rows_sha256: string }
export function rlsPolicyDigest(observation: RlsPolicyObservation): string
