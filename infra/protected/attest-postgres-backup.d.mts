export const SNAPSHOT_SQL: readonly string[]
export function pgDumpArguments(snapshot: string, output: string): string[]
export function createProtectedEnvironment(source?: NodeJS.ProcessEnv): Record<string, string>
export type BackupSourcePolicy = { system_identifier_sha256: string; database_oid: number; database_name: string }
export type SnapshotIdentity = { systemIdentifier: string; databaseOid: number; databaseName: string; migrationVersion: number; snapshot: string; snapshotExportObservedAt: string; release(): void }
export function captureSnapshot(): Promise<SnapshotIdentity>
export function parseSourcePolicy(bytes: string | Buffer): BackupSourcePolicy
export function assertSourcePolicy(identity: Pick<SnapshotIdentity, 'systemIdentifier' | 'databaseOid' | 'databaseName'>, policy: BackupSourcePolicy): string
export function parseCreateArguments(args: string[]): { backupPath: string; checksumPath: string; attestationPath: string }
export function hashRegularFile(path: string): { sha256: string; bytes: number }
export function signBackupAttestation(input: { backupBytes: Buffer; backupFileName: string; systemIdentifier: string; databaseOid: number; databaseName: string; migrationVersion: number; snapshot: string; backupStartedAt: string; snapshotExportObservedAt: string; dumpCompletedAt: string; keyId: string; privatePem: string | Buffer; publicPem: string | Buffer; validitySeconds?: number }): Record<string, unknown>
export type ReviewOnlySnapshotIdentity = Readonly<Pick<SnapshotIdentity, 'systemIdentifier' | 'databaseOid' | 'databaseName' | 'migrationVersion'>>
export type BackupAdapter = {
  snapshot(): Promise<SnapshotIdentity>
  dump(snapshot: string, path: string): Promise<void>
  reviewOnlyObserveSnapshot?(snapshot: string, identity: ReviewOnlySnapshotIdentity): Promise<unknown>
  reviewOnlyBindBackup?(observation: unknown, signedBackup: Readonly<Record<string, unknown>>): Promise<void>
}
export function produceBackup(input: { backupPath: string; attestationPath: string; checksumPath?: string; validitySeconds?: number; privatePem: string | Buffer; publicPem: string | Buffer; keyId: string; sourcePolicy: BackupSourcePolicy; clock?: () => Date }, adapter?: BackupAdapter): Promise<Record<string, unknown>>
