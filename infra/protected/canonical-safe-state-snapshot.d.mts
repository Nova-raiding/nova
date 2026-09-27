export function validateCandidateBinding(environment: NodeJS.ProcessEnv): {
  release_id: string
  release_git_sha: string
  candidate_manifest_sha256: string
  release_manifest_sha256: string
  image_set_digest: string
  deployment_nonce_sha256: string
}
export function resolveCanonicalSafeState(flag: Record<string, unknown> | undefined, targets: Array<Record<string, unknown>>, workspaceId: string, at: string): 'legacy_shadow' | 'dual_verify' | 'canonical_read'
export function summarizeCanonicalSafeState(snapshot: Record<string, unknown>): Record<string, unknown>
export const CAPTURE_SQL: string
