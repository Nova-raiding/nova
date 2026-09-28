export interface Bridge255StateStore {
  captureSigned(input: { plan: unknown; capture: unknown; observation: unknown }): Promise<unknown>
  advanceSigned(input: { plan: unknown; capture: unknown; previous: unknown; phase: string; observation: unknown }): Promise<unknown>
  consumeNonceOnce(input: { plan: unknown; deploymentNonce: string; namespace: string; operation: string }): Promise<unknown>
  readConsumedNonce(input: { plan?: unknown; attemptId: string; nonce_sha256: string }): Promise<unknown>
  readFrozenAttempt(input: { attemptId: string }): Promise<{
    plan_sha256: string; capture: unknown; journal: unknown; observation: unknown
  }>
  inspectApprovedAttempt(): Promise<{
    schema_version: 'ecs-bridge-255-host-status/1'; plan_sha256: string; key_id: string
    attempt_id: string; project: string; plan_expires_at: string | null; phase: string | null
    journal: { phase: string; created_at: string; expires_at: string; journal_sha256: string; history_length: number } | null
    nonce_consumed: boolean; nonce_owner: { operation: string; attempt_id: string; nonce_sha256: string } | null
    production_lock: { path: string; path_verified: true; held_by_invocation: false }
    production_mutation_authorized: false; blockers: string[]
  }>
}
export const BRIDGE_255_PROTECTED_STATE_PATHS: Readonly<{
  directory: string; ledgerPath: string; consumerPath: string; lockPath: string; approvedPlan: string
}>
export function createBridge255StateStore(options: {
  directory: string; ledgerPath: string; consumerPath: string; privateKeyPem: string; publicKeyPem: string
  trustedKeyId: string; approvedPlanSha256: string; approvedPlan: unknown; expectedUid?: number
  approvedPlanExpiresAt?: string | null
  requireProductionLock?: boolean; now?: () => Date; consume?: ((nonce: string, plan: unknown) => void) | null
}): Bridge255StateStore
export function openProtectedBridge255StateStore(): Bridge255StateStore
export function verifySignedBridge255ExecutionPlan(envelope: unknown, publicKeyPem: string,
  keyId: string, now?: Date): { plan: unknown; plan_sha256: string }
export function productionLockProbeConflicts(path: string,
  probe?: (command: string, args: string[], options: unknown) => { status: number | null }): boolean
