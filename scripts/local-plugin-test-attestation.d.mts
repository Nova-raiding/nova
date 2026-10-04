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

export function runAndSignLocalPluginTests(options: {
  root: string
  descriptorPath: string
  packagePath: string
  publicKeyPath: string
  privateKeyPath: string
  keyId: string
  releaseId: string
  gitSha: string
}): LocalPluginTestAttestation

export function generateLocalPluginReleaseEvidence(options: {
  root: string
  pluginRoot: string
  packagePath: string
  platform: string
  publicKeyPath: string
  privateKeyPath: string
  keyId: string
  releaseId: string
  gitSha: string
  mcpMethodsSha256: string
  descriptorPath: string
  attestationPath: string
  buildAttestation: Record<string, unknown>
  buildAttestationPublicKeyPem: string | Buffer
  buildAttestationKeyId: string
}): { descriptor: Record<string, unknown>; attestation: LocalPluginTestAttestation; descriptorPath: string; attestationPath: string }

export function verifyLocalPluginTestAttestation(record: LocalPluginTestAttestation, options: {
  publicKeyPem: string | Buffer
  keyId: string
  releaseId: string
  gitSha: string
  platform: string
  descriptorSha256: string
  now?: number
}): LocalPluginTestAttestation
