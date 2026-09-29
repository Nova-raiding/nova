export const provenanceFile: string
export function writeBundleProvenance(root: string, metadata: {
  plugin: string
  version: string
  platform: string
  architecture: string
  gitCommit: string
  sourceDirty: boolean
}): {
  files: Array<{ path: string; sha256: string }>
}
export function verifyBundleProvenance(root: string, options?: { installed?: boolean }): {
  ok: boolean
  errors: string[]
  git_commit?: string
  source_dirty?: boolean
  version?: string
  platform?: string
  architecture?: string
  authenticity_verified?: false
  checked_files?: number
}
