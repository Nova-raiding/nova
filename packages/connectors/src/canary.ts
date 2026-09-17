import { createHash } from 'node:crypto'
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
  /** The controlled test-store product that a read canary must actually return. */
  expectedRemoteId: string
  /** Authorization code and state from an actual controlled OAuth callback. */
  oauthCallback?: { code: string; state: string; pendingState?: string; redirectUri: string; codeVerifier?: string }
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

function validCanaryText(value: unknown, maxLength: number): value is string {
  return typeof value === 'string'
    && value.trim().length > 0
    && value.trim().length <= maxLength
    && !/[\u0000-\u001F\u007F]/u.test(value)
    && !/^(?:SET_|CHANGE_ME|REPLACE_ME|TODO|TBD|<[^>]+>)/iu.test(value.trim())
}

function validScopeId(value: unknown): value is string {
  return validCanaryText(value, 256) && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value.trim())
}

function canaryInputErrors(input: PlatformCanaryInput): string[] {
  const errors: string[] = []
  if (!validCanaryText(input.evidenceRef, 512)) errors.push('evidenceRef is invalid')
  if (!validCanaryText(input.verifiedBy, 128)) errors.push('verifiedBy is invalid')
  if (!validCanaryText(input.apiVersion, 128)) errors.push('apiVersion is invalid')
  if (!validCanaryText(input.scope, 512)) errors.push('scope is invalid')
  if (!validScopeId(input.context.workspaceId)) errors.push('workspaceId is invalid')
  if (!validScopeId(input.context.accountId)) errors.push('accountId is invalid')
  if (!validCanaryText(input.expectedRemoteId, 256)) errors.push('expectedRemoteId is invalid')
  if (input.oauthCallback && (!validCanaryText(input.oauthCallback.code, 4096) || !validCanaryText(input.oauthCallback.state, 512) || !/^https:\/\//u.test(input.oauthCallback.redirectUri))) errors.push('OAuth callback is invalid')
  if (input.promoteToProductionCanary && !input.oauthCallback) errors.push('production OAuth callback is required')
  if (input.promoteToProductionCanary && (!validCanaryText(input.oauthCallback?.pendingState, 512) || input.oauthCallback?.state !== input.oauthCallback.pendingState)) errors.push('production OAuth callback state must match the separately recorded pending state')
  if (input.mediaFile) {
    if (!validCanaryText(input.mediaFile.mimeType, 128)) errors.push('media mimeType is invalid')
    if (input.mediaFile.bytes.byteLength > 5 * 1024 * 1024) errors.push('media file exceeds 5 MiB')
    if (!/^[a-f0-9]{64}$/iu.test(input.mediaFile.sha256)) errors.push('media sha256 is invalid')
    else if (createHash('sha256').update(input.mediaFile.bytes).digest('hex') !== input.mediaFile.sha256.toLowerCase()) errors.push('media sha256 does not match bytes')
  }
  return errors
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
  const result = (passed: boolean): PlatformCanaryResult => ({
    platform: input.connector.platform,
    passed,
    checks,
    evidence: passed
      ? evidenceItems
      : evidenceItems.map(item => item.state === 'production_canary' ? { ...item, state: 'test_e2e' as const } : item),
  })

  const inputErrors = canaryInputErrors(input)
  if (inputErrors.length) {
    // Evidence is an authorization input. Reject malformed attribution before
    // touching the connector so a bad canary cannot create provider side effects.
    for (const capability of ['authorize', 'refresh', 'read', 'full_sync', 'incremental_sync', 'create', 'update', 'query_status', 'revoke', 'media_upload'] as const) {
      add(capability, false, false, 'canary input rejected: invalid evidence, scope, or media attribution')
    }
    return result(false)
  }

  let exchangedCredential: Awaited<ReturnType<PlatformConnector['exchangeCode']>> | undefined
  let credentialForRevoke: Awaited<ReturnType<PlatformConnector['exchangeCode']>> | undefined
  let exchangeAccepted = false
  try {
    const callback = input.oauthCallback
    const authorization = await input.connector.authorize({ workspaceId: input.context.workspaceId, actorId: 'platform-canary', redirectUri: callback?.redirectUri ?? 'https://canary.invalid/oauth/callback', state: callback?.state ?? `canary-${input.connector.platform}-${Date.now()}` })
    if (!authorization.ok || authorization.mode !== 'real') add('authorize', false, authorization.mode !== 'real', authorization.message)
    else if (!callback) add('authorize', true, false)
    else {
      exchangedCredential = await input.connector.exchangeCode({ code: callback.code, state: callback.state, redirectUri: callback.redirectUri, ...(callback.codeVerifier ? { codeVerifier: callback.codeVerifier } : {}), workspaceId: input.context.workspaceId })
      exchangeAccepted = exchangedCredential.workspaceId === input.context.workspaceId && exchangedCredential.accountId === input.context.accountId && Boolean(exchangedCredential.credentialRef.trim())
      if (exchangeAccepted) credentialForRevoke = exchangedCredential
      add('authorize', exchangeAccepted, false, 'OAuth callback exchanged with controlled test account')
    }
  } catch (error) { add('authorize', false, false, error instanceof Error ? error.message : String(error)) }

  if (!exchangedCredential || !exchangeAccepted) add('refresh', false, false, 'refresh canary requires an accepted credential returned by OAuth exchange')
  else {
    try {
      const refreshed = await input.connector.refreshCredential(exchangedCredential)
      const passed = refreshed.workspaceId === input.context.workspaceId
        && refreshed.accountId === input.context.accountId
        && Boolean(refreshed.credentialRef.trim())
      if (passed) credentialForRevoke = refreshed
      add('refresh', passed, false, passed ? 'OAuth credential refreshed and rebound to the controlled test account' : 'refreshed credential was not bound to the controlled test account')
    } catch (error) { add('refresh', false, false, error instanceof Error ? error.message : String(error)) }
  }

  if (input.promoteToProductionCanary && !checks.find(item => item.capability === 'authorize')?.passed) {
    for (const capability of ['read', 'full_sync', 'incremental_sync', 'create', 'update', 'query_status', 'revoke', 'media_upload'] as const) add(capability, false, false, 'OAuth authorization failed; provider canary stopped before further requests')
    return result(false)
  }
  if (input.promoteToProductionCanary && !checks.find(item => item.capability === 'refresh')?.passed) {
    for (const capability of ['read', 'full_sync', 'incremental_sync', 'create', 'update', 'query_status', 'revoke', 'media_upload'] as const) add(capability, false, false, 'OAuth refresh failed; provider canary stopped before further requests')
    return result(false)
  }

  let full: Awaited<ReturnType<PlatformConnector['syncProducts']>> | undefined
  try {
    full = await input.connector.syncProducts(input.context)
    const containsExpected = full.items.some(item => item.remoteId === input.expectedRemoteId)
    const passed = full.source === 'official_api' && !full.simulated && containsExpected
    const detail = containsExpected ? undefined : `read canary did not return expected remote product ${input.expectedRemoteId}`
    add('read', passed, full.simulated, detail)
    add('full_sync', passed, full.simulated, detail)
  } catch (error) {
    add('read', false, false, error instanceof Error ? error.message : String(error))
    add('full_sync', false, false, error instanceof Error ? error.message : String(error))
  }
  if (!full?.nextCursor?.value) add('incremental_sync', false, false, 'full sync returned no provider cursor for incremental verification')
  else {
    try {
      const incremental = await input.connector.syncProducts(input.context, full.nextCursor)
      add('incremental_sync', incremental.source === 'official_api' && !incremental.simulated, incremental.simulated)
    } catch (error) { add('incremental_sync', false, false, error instanceof Error ? error.message : String(error)) }
  }

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
      add('create', receipt.operation === 'create' && !receipt.simulated && Boolean(receipt.remoteId.trim() && receipt.requestId.trim()), receipt.simulated)
      if (!receipt.remoteId.trim() || !receipt.requestId.trim()) add('query_status', false, false, 'create returned no attributable provider remote ID or request ID')
      else {
        const status = await input.connector.queryWrite(input.context, { idempotencyKey: receipt.idempotencyKey, remoteId: receipt.remoteId })
        add('query_status', status.found && !status.simulated && status.requestId === receipt.requestId && status.remoteId === receipt.remoteId && status.state === 'published', status.simulated)
      }
    } catch (error) {
      add('create', false, false, error instanceof Error ? error.message : String(error))
      add('query_status', false, false, 'create did not return an attributable request')
    }
    if (!remoteId?.trim()) add('update', false, false, 'create did not return a provider remote product ID to update')
    else {
      try {
        const receipt = await input.connector.updateProduct(input.context, { fields, remoteId, idempotencyKey: `platform-canary-update-${input.connector.platform}-${Date.now()}` })
        add('update', receipt.operation === 'update' && !receipt.simulated && receipt.remoteId === remoteId && Boolean(receipt.requestId.trim()), receipt.simulated)
      } catch (error) { add('update', false, false, error instanceof Error ? error.message : String(error)) }
    }
  }

  if (!input.allowRevoke) add('revoke', false, false, 'revoke canary disabled; set explicit allowRevoke for a disposable test account')
  else if (!credentialForRevoke) add('revoke', false, false, 'revoke canary requires the credential returned by OAuth exchange')
  else {
    try {
      await input.connector.revoke(credentialForRevoke)
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
  const passed = checks.every(item => item.passed && !item.simulated)
  return result(passed)
}
