export interface LocalPluginTestAttestation {
  schema_version: 'local-plugin-tests/2'
  release_id: string
  git_sha: string
  platform: string
  descriptor_sha256: string
  suite_sha256: string
  status: 'pass'
  generated_at: string
  expires_at: string
  key_id: string
  signature_base64: string
}

export const PLUGIN_CONTRACT_TESTS: readonly string[]

export function verifyLocalPluginTestAttestation(record: LocalPluginTestAttestation, options: {
  publicKeyPem: string | Buffer
  keyId: string
  releaseId: string
  gitSha: string
  platform: string
  descriptorSha256: string
  now?: number
}): LocalPluginTestAttestation
