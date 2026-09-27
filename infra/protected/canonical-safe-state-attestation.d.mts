export type CanonicalSafeStateBinding = {
  release_id: string
  release_git_sha: string
  candidate_manifest_sha256: string
  release_manifest_sha256: string
  image_set_digest: string
  deployment_nonce_sha256: string
}
export type CanonicalSafeStateSourcePolicy = {
  source_policy_sha256: string
  collector_sha256: string
  database_identity: {
    system_identifier_sha256: string
    database_oid: number
    database_name_sha256: string
    endpoint_sha256: string
  }
}
export function canonicalSafeStateDatabaseIdentity(value: CanonicalSafeStateSourcePolicy['database_identity']): string
export function canonicalSafeStateBindingFromEnvironment(environment: Record<string, string | undefined>): CanonicalSafeStateBinding
export function validateCanonicalSafeStateAttestation(
  document: unknown,
  options: {
    expectedBinding?: CanonicalSafeStateBinding
    expectedSourcePolicy?: CanonicalSafeStateSourcePolicy
    publicKeyPem?: string
    trustedKeyId?: string
    now?: Date
  },
): string[]
