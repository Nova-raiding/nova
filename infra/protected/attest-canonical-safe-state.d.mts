export type CanonicalSafeStateBinding = {
  release_id: string
  release_git_sha: string
  candidate_manifest_sha256: string
  release_manifest_sha256: string
  image_set_digest: string
  deployment_nonce_sha256: string
}

export type CanonicalSafeStatePolicy = {
  schema_version: string
  collector_sha256: string
  database_identity: {
    system_identifier_sha256: string
    database_oid: number
    database_name_sha256: string
    endpoint_sha256: string
  }
  source_policy_sha256: string
}

export function candidateBinding(environment: Record<string, string | undefined>): CanonicalSafeStateBinding
export function endpointDigest(serviceBytes: Buffer, serviceName: string): string
export function validateSourcePolicy(bytes: Buffer, collectorDigest: string, endpointDigest: string): CanonicalSafeStatePolicy
export function buildCanonicalSafeStateEvidence(input: {
  snapshot: { workspaces: unknown[] }
  summary: Record<string, any>
  binding: CanonicalSafeStateBinding
  policy: CanonicalSafeStatePolicy
  collectorDigest: string
  privatePem: string | Buffer
  publicPem: string | Buffer
  keyId: string
  now?: Date
}): Record<string, any>
