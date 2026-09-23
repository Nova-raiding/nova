export interface ReleaseBinding {
  releaseId: string
  gitSha: string
  manifestSha256: string
  imageSetDigest: string
}

export interface RecoveryBinding extends ReleaseBinding {
  composeSha256: string
  envSha256: string
  imageDigestsSha256: string
  migrationTail: number
  allowedPrefixSha256: Record<number, string>
  services: string[]
}

export interface ObservedRecoveryState {
  composeProject: string
  containers: Array<{ service: string; id: string; imageId: string; configHash: string; state: string }>
  inventory: Array<Record<string, unknown>>
  candidateImageIds: string[]
  candidateServiceImageIds?: Record<string, string>
  unlabeledTakeover?: UnlabeledTakeoverPair[]
  candidateExclusiveRunning?: boolean
  candidateIdentityRunning?: boolean
  database: { version: number; historySha256: string; invalidConcurrentIndexes: string[] }
}

export interface UnlabeledTakeoverPair {
  service: string
  old_name: string
  candidate_name: string
  parked_name: string
  old: { id: string; image_id: string; config_sha256: string; host_sha256: string; networks: Array<{ name: string; id: string; aliases: string[] }> }
  candidate: { id: string; image_id: string; config_sha256: string; host_sha256: string; networks: Array<{ name: string; id: string; aliases: string[] }> }
}

export interface SignedRecoveryJournal extends Record<string, unknown> {
  phase: string
  signature_base64: string
  deployment_mode?: 'bridge_code_only' | 'bridge_unlabeled_code_only'
  candidate_service_image_ids?: Record<string, string>
  unlabeled_takeover?: UnlabeledTakeoverPair[]
  predeployment_workload: {
    services: Array<Record<string, unknown>>
    container_set_digest: string
    inventory_digest: string
  }
  database_before: { migration_version: number; migration_history_sha256: string }
  deployment_nonce_sha256: string
}

export function createSignedSnapshot(
  observed: ObservedRecoveryState,
  binding: { attemptId: string; deploymentNonce: string; keyId: string; candidate: ReleaseBinding; recovery: RecoveryBinding; mode?: 'bridge_code_only' | 'bridge_unlabeled_code_only' },
  privatePem: string | Buffer,
  publicPem: string | Buffer,
  now?: Date,
): SignedRecoveryJournal

export function transitionJournal(document: SignedRecoveryJournal, nextPhase: string, privatePem: string | Buffer, publicPem: string | Buffer, now?: Date): SignedRecoveryJournal

export function verifyRecoveryAuthorization(
  document: SignedRecoveryJournal,
  input: {
    observed: Pick<ObservedRecoveryState, 'composeProject' | 'containers' | 'inventory'>
    deploymentNonce: string
    recovery: RecoveryBinding
    candidateContainersRunning?: boolean
    database: ObservedRecoveryState['database']
  },
  publicPem: string | Buffer,
  now?: Date,
): { authorized: true; targetMigration: number }

export function verifyBridgeRecoveryAuthorization(
  document: SignedRecoveryJournal,
  input: {
    observed: {
      composeProject: string
      containers: Array<{ service: string; id?: string; imageId?: string; configHash?: string; state?: string; missing?: boolean; releaseIdentity?: { release_id?: string; release_git_sha?: string; manifest_sha256?: string; image_set_digest?: string } }>
      inventory: Array<Record<string, unknown>>
    }
    deploymentNonce: string
    recovery: RecoveryBinding
    database: ObservedRecoveryState['database']
  },
  publicPem: string | Buffer,
  now?: Date,
): { authorized: true; targetMigration: 242 }

export function productionApiBaseUrl(value: string): string
export function switchUnlabeledPairs(pairs: UnlabeledTakeoverPair[], actions: {
  stop(id: string): void; rename(id: string, name: string): void; start(id: string): void
}): void
export function recoverUnlabeledPairs(pairs: UnlabeledTakeoverPair[], actions: {
  inspect(id: string): { name: string; running: boolean }; stop(id: string): void; rename(id: string, name: string): void; start(id: string): void
}): void
