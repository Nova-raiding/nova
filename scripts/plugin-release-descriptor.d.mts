export interface PluginReleaseDescriptor {
  schema_version: 'plugin-release/2'
  release_id: string
  git_sha: string
  plugin_id: string
  plugin_version: string
  platform: string
  package_sha256: string
  package_bytes: number
  bridge_sha256: string
  manifest_sha256: string
  skill_sha256: string
  mcp_methods_sha256: string
  release_readiness: 'signed_installable'
  key_id: string
  signature_base64: string
}

export function verifyPluginReleaseDescriptor(document: PluginReleaseDescriptor, options: {
  publicKeyPem: string | Buffer
  keyId: string
  releaseId?: string
  gitSha?: string
  platform?: string
  mcpMethodsSha256?: string
  packagePath?: string
}): PluginReleaseDescriptor
