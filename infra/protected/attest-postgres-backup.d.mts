export const SNAPSHOT_SQL: readonly string[]
export function pgDumpArguments(snapshot: string, output: string): string[]
export function createProtectedEnvironment(source?: NodeJS.ProcessEnv): Record<string, string>
export type BackupSourcePolicy = { system_identifier_sha256: string; database_oid: number; database_name: string }
export type SnapshotIdentity = { systemIdentifier: string; databaseOid: number; databaseName: string; migrationVersion: number; snapshot: string; release(): void }
export function captureSnapshot(): Promise<SnapshotIdentity>
export function parseSourcePolicy(bytes: string | Buffer): BackupSourcePolicy
export function assertSourcePolicy(identity: Pick<SnapshotIdentity, 'systemIdentifier' | 'databaseOid' | 'databaseName'>, policy: BackupSourcePolicy): string
export function parseCreateArguments(args: string[]): { backupPath: string; checksumPath: string; attestationPath: string }
export function signBackupAttestation(input: { backupBytes: Buffer; backupFileName: string; systemIdentifier: string; databaseOid: number; databaseName: string; migrationVersion: number; keyId: string; privatePem: string | Buffer; publicPem: string | Buffer; now?: Date; validitySeconds?: number }): Record<string, unknown>
export function produceBackup(input: { backupPath: string; attestationPath: string; checksumPath?: string; validitySeconds?: number; now?: Date; privatePem: string | Buffer; publicPem: string | Buffer; keyId: string; sourcePolicy: BackupSourcePolicy }, adapter?: { snapshot(): Promise<SnapshotIdentity>; dump(snapshot: string, path: string): Promise<void> }): Promise<Record<string, unknown>>
