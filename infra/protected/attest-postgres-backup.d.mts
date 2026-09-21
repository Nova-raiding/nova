export const SNAPSHOT_SQL: readonly string[]
export function pgDumpArguments(snapshot: string, output: string): string[]
export function createProtectedEnvironment(source?: NodeJS.ProcessEnv): Record<string, string>
export function captureSnapshot(): Promise<{ systemIdentifier: string; migrationVersion: number; snapshot: string; release(): void }>
export function parseCreateArguments(args: string[]): { backupPath: string; checksumPath: string; attestationPath: string }
export function signBackupAttestation(input: { backupBytes: Buffer; backupFileName: string; systemIdentifier: string; migrationVersion: number; keyId: string; privatePem: string | Buffer; publicPem: string | Buffer; now?: Date; validitySeconds?: number }): Record<string, unknown>
export function produceBackup(input: { backupPath: string; attestationPath: string; checksumPath?: string; validitySeconds?: number; now?: Date; privatePem: string | Buffer; publicPem: string | Buffer; keyId: string }, adapter?: { snapshot(): Promise<{ systemIdentifier: string; migrationVersion: number; snapshot: string; release(): void }>; dump(snapshot: string, path: string): Promise<void> }): Promise<Record<string, unknown>>
