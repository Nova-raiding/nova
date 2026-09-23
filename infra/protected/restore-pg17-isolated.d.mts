export function validateRestoreInputs(input: {
  backupSha256: string
  backupName: string
  attestation: Record<string, unknown>
  publicPem: string
  keyId: string
  identity: Record<string, string>
  imageSet: Record<string, unknown>
  releaseId: string
  gitSha: string
  imageSetDigest: string
  manifestSha256: string
  deploymentNonce: string
  now?: Date
}): { backupSha256: string; sourceDatabaseIdSha256: string; postgresImage: string }
export function validateMigrationAssets(names: string[]): void
export function validateContainerInspection(value: Record<string, unknown>, options: { id: string; expectedImageId: string; expectedNetwork: string; expectedVolume: string }): Record<string, unknown>
