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
export function validateMigrationAssets(names: string[], expectedMigrationVersion: number): void
export function validateArchiveCommit(actual: string, expected: string): void
export function retainedNonceBinding(nonce: string): { deployment_nonce_sha256: string }
export function composeDigestArgument(digestFile: Record<string, string>, imageDigests: Record<string, string>): string
export function postgresContainerArgs(input: { containerName: string; network: string; volume: string; image: string }): string[]
export function migrationContainerArgs(input: { migrationName: string; containerName: string; network: string; migrations: string; script: string; image: string }): string[]
export function readArchiveCommit(path: string): string
export function validateContainerInspection(value: Record<string, unknown>, options: { id: string; expectedImageId: string; expectedNetwork: string; expectedVolume: string }): Record<string, unknown>
