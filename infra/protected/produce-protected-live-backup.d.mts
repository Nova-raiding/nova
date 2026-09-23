export function verifyProducedBackupV2(
  document: Record<string, unknown>,
  backupSha256: string,
  backupName: string,
  policy: { system_identifier_sha256: string; database_oid: number; database_name: string },
  migrationVersion: number,
  publicPem: string | Buffer,
  keyId: string,
  now?: Date,
): void
