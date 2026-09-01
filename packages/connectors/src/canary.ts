import type { CapabilityEvidence, CapabilityName } from './capability-evidence.js'
import type { ConnectorContext, MediaUploadInput, Platform, PlatformConnector } from './types.js'

export interface PlatformCanaryInput {
  connector: PlatformConnector
  context: ConnectorContext
  evidenceRef: string
  verifiedBy: string
  verifiedAt?: string
  apiVersion: string
  scope: string
  /** Real create/update calls are opt-in because they mutate a test store. */
  allowWrite: boolean
  /** Revoke is separately opt-in because it invalidates the test account. */
  allowRevoke: boolean
  /** Production promotion is an explicit, separately reviewed release action. */
  promoteToProductionCanary?: boolean
  writeFields?: Record<string, unknown>
  /** A controlled test image used to prove the platform media-upload mapping. */
  mediaFile?: { bytes: Uint8Array; mimeType: string; sha256: string }
}

export interface PlatformCanaryCheck {
  capability: CapabilityName
  passed: boolean
  simulated: boolean
  detail?: string
}

export interface PlatformCanaryResult {
  platform: Platform
  passed: boolean
  checks: readonly PlatformCanaryCheck[]
  evidence: readonly CapabilityEvidence[]
}

function check(capability: CapabilityName, passed: boolean, simulated: boolean, detail?: string): PlatformCanaryCheck {
  return { capability, passed, simulated, ...(detail ? { detail } : {}) }
}

function evidence(input: PlatformCanaryInput, capability: CapabilityName, state: CapabilityEvidence['state'], simulated = false): CapabilityEvidence {
  return {
    platform: input.connector.platform, capability, state,
    apiVersion: input.apiVersion, scope: input.scope, testAccountId: input.context.accountId,
    evidenceRef: input.evidenceRef, verifiedBy: input.verifiedBy, verifiedAt: input.verifiedAt ?? new Date().toISOString(),
    ...(simulated ? { evidenceRef: `${input.evidenceRef}#simulated` } : {}),
  }
}

/**
 * Executes the real connector boundary against a controlled test store. This
 * runner never invents production_canary evidence: every write/revoke check
 * must be explicitly enabled and every response must be non-simulated.
 */
export async function runPlatformCanary(input: PlatformCanaryInput): Promise<PlatformCanaryResult> {
  const checks: PlatformCanaryCheck[] = []
  const evidenceItems: CapabilityEvidence[] = []
  const add = (capability: CapabilityName, passed: boolean, simulated: boolean, detail?: string) => {
    checks.push(check(capability, passed, simulated, detail))
    const state = passed && !simulated
      ? input.promoteToProductionCanary === true ? 'production_canary' : 'test_e2e'
      : passed ? 'test_e2e' : 'unverified'
    evidenceItems.push(evidence(input, capability, state, simulated))
  }

  try {
    const authorization = await input.connector.authorize({ workspaceId: input.context.workspaceId, actorId: 'platform-canary', redirectUri: 'https://canary.invalid/oauth/callback', state: `canary-${input.connector.platform}-${Date.now()}` })
    add('authorize', authorization.ok && authorization.mode === 'real', authorization.mode !== 'real', authorization.message)
  } catch (error) { add('authorize', false, false, error instanceof Error ? error.message : String(error)) }

  let full: Awaited<ReturnType<PlatformConnector['syncProducts']>> | undefined
  try {
    full = await input.connector.syncProducts(input.context)
    const passed = full.source === 'official_api' && !full.simulated && full.items.length >= 0
    add('read', passed, full.simulated)
    add('full_sync', passed, full.simulated)
  } catch (error) {
    add('read', false, false, error instanceof Error ? error.message : String(error))
    add('full_sync', false, false, error instanceof Error ? error.message : String(error))
  }
  try {
    const incremental = await input.connector.syncProducts(input.context, full?.nextCursor ?? { value: `canary-${Date.now()}` })
    add('incremental_sync', incremental.source === 'official_api' && !incremental.simulated, incremental.simulated)
  } catch (error) { add('incremental_sync', false, false, error instanceof Error ? error.message : String(error)) }

  let remoteId: string | undefined
  if (!input.allowWrite) {
    add('create', false, false, 'write canary disabled; set explicit allowWrite for a controlled test store')
    add('update', false, false, 'write canary disabled; set explicit allowWrite for a controlled test store')
    add('query_status', false, false, 'write canary disabled; no attributable request to query')
  } else {
    const fields = input.writeFields ?? { title: `Canary ${input.connector.platform}`, category: 'canary', price: 1, stock: 1 }
    try {
      const receipt = await input.connector.createProduct(input.context, { fields, idempotencyKey: `platform-canary-create-${input.connector.platform}-${Date.now()}` })
      remoteId = receipt.remoteId
      add('create', receipt.operation === 'create' && !receipt.simulated, receipt.simulated)
      const status = await input.connector.queryWrite(input.context, { idempotencyKey: receipt.idempotencyKey, remoteId: receipt.remoteId })
      add('query_status', status.found && !status.simulated, status.simulated)
    } catch (error) {
      add('create', false, false, error instanceof Error ? error.message : String(error))
      add('query_status', false, false, 'create did not return an attributable request')
    }
    try {
      const receipt = await input.connector.updateProduct(input.context, { fields, ...(remoteId ? { remoteId } : {}), idempotencyKey: `platform-canary-update-${input.connector.platform}-${Date.now()}` })
      add('update', receipt.operation === 'update' && !receipt.simulated, receipt.simulated)
    } catch (error) { add('update', false, false, error instanceof Error ? error.message : String(error)) }
  }

  if (!input.allowRevoke) add('revoke', false, false, 'revoke canary disabled; set explicit allowRevoke for a disposable test account')
  else {
    try {
      await input.connector.revoke({ accountId: input.context.accountId, credentialRef: `canary://${input.context.accountId}` })
      add('revoke', true, false)
    } catch (error) { add('revoke', false, false, error instanceof Error ? error.message : String(error)) }
  }
  if (!input.mediaFile || !input.connector.uploadMedia) {
    add('media_upload', false, false, !input.connector.uploadMedia ? 'media upload adapter is not available' : 'media canary requires an explicit controlled test image')
  } else {
    try {
      const media: MediaUploadInput = { visualRef: `canary-${input.connector.platform}`, role: 'main', mimeType: input.mediaFile.mimeType, sha256: input.mediaFile.sha256, bytes: input.mediaFile.bytes, idempotencyKey: `platform-canary-media-${input.connector.platform}-${Date.now()}` }
      const receipt = await input.connector.uploadMedia(input.context, media)
      add('media_upload', receipt.platform === input.connector.platform && receipt.mediaId.trim().length > 0 && !receipt.simulated, receipt.simulated)
    } catch (error) { add('media_upload', false, false, error instanceof Error ? error.message : String(error)) }
  }
  return { platform: input.connector.platform, passed: checks.every(item => item.passed && !item.simulated), checks, evidence: evidenceItems }
}
