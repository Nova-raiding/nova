export const BRIDGE_254_PROTECTED_STATE_PATHS: Readonly<{
  directory: string; ledgerPath: string; consumerPath: string; lockPath: string
}>
export interface Bridge254StateStore {
  capture(input: { attemptId: string; journalBody: Record<string, unknown>; frozenCapture: unknown; expected: unknown }): unknown
  read(input: { attemptId: string; expected: unknown }): { journal: any; capture: unknown; bytes: Buffer }
  advance(input: { attemptId: string; fromPhase: string; toPhase: string; observedPrefix: unknown;
    observationDigest: string; expected: unknown; deploymentNonce: string }): { journal: any; observation_digest: string; deployable: false }
  recordPrefix(input: { attemptId: string; expectedVersion: number; observedPrefix: unknown;
    observationDigest: string; expected: unknown }): { journal: any; observation_digest: string; deployable: false }
}
export function createBridge254StateStore(options: {
  directory: string; ledgerPath: string; consumerPath: string; privateKeyPem: string; publicKeyPem: string;
  trustedKeyId: string; expectedUid?: number; requireProductionLock?: boolean;
  consume?: ((nonce: string, journal: any) => void) | null
}): Bridge254StateStore
export function openProtectedBridge254StateStore(): Bridge254StateStore
export function invocationOwnsFlockRecord(procLocks: string, deviceInode: string, ownerPids: number[]): boolean
export function assertReviewOnlyMutationAllowed(requireProductionLock: boolean): void
export function linuxDeviceInode(stat: { dev: number | bigint; ino: number | bigint }): string
