import { createHash } from 'node:crypto'
import { closeSync, constants, fsyncSync, openSync, readFileSync, writeFileSync, statSync, writeSync } from 'node:fs'
import { basename } from 'node:path'
import { ConnectorRuntime } from '../packages/application/src/connector-runtime.js'
import { createVaultCredentialProviderFromEnv, type Platform } from '../packages/connectors/src/index.js'
import { runPlatformCanary } from '../packages/connectors/src/canary.js'
import type { ProviderExchangeObservation } from '../packages/connectors/src/http-connector.js'

const platform = process.env.PLATFORM_CANARY_PLATFORM?.trim() as Platform | undefined
const workspaceId = process.env.PLATFORM_CANARY_WORKSPACE_ID?.trim()
const accountId = process.env.PLATFORM_CANARY_ACCOUNT_ID?.trim()
const evidenceRef = process.env.PLATFORM_CANARY_EVIDENCE_REF?.trim()
const verifiedBy = process.env.PLATFORM_CANARY_VERIFIED_BY?.trim()
const apiVersion = process.env.PLATFORM_CANARY_API_VERSION?.trim()
const scope = process.env.PLATFORM_CANARY_SCOPE?.trim()
const expectedRemoteId = process.env.PLATFORM_CANARY_EXPECTED_REMOTE_ID?.trim()
const applicationId = process.env.PLATFORM_CANARY_APPLICATION_ID?.trim()
const confirm = process.env.PLATFORM_CANARY_CONFIRM === 'true'
const allowWrite = process.env.PLATFORM_CANARY_ALLOW_WRITE === 'true'
const allowRevoke = process.env.PLATFORM_CANARY_ALLOW_REVOKE === 'true'
const mediaFile = process.env.PLATFORM_CANARY_MEDIA_FILE?.trim()
const oauthCode = process.env.PLATFORM_CANARY_OAUTH_CODE?.trim()
const oauthState = process.env.PLATFORM_CANARY_OAUTH_STATE?.trim()
const oauthPendingState = process.env.PLATFORM_CANARY_OAUTH_PENDING_STATE?.trim()
const oauthRedirectUri = process.env.PLATFORM_CANARY_OAUTH_REDIRECT_URI?.trim()

function requireValue(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} is required`)
  return value
}

if (process.env.PLATFORM_CANARY_MODE !== 'real') throw new Error('PLATFORM_CANARY_MODE=real is required; fixture checks use platform-preflight instead')
if (!confirm) throw new Error('PLATFORM_CANARY_CONFIRM=true is required')
if (allowWrite && process.env.PLATFORM_CANARY_CONFIRM_WRITES !== 'true') throw new Error('PLATFORM_CANARY_CONFIRM_WRITES=true is required for write canary')
if (allowRevoke && process.env.PLATFORM_CANARY_CONFIRM_REVOKE !== 'true') throw new Error('PLATFORM_CANARY_CONFIRM_REVOKE=true is required for revoke canary')
if (!mediaFile) throw new Error('PLATFORM_CANARY_MEDIA_FILE is required for the production media-upload canary')
if (!oauthCode || !oauthState || !oauthPendingState || !oauthRedirectUri) throw new Error('actual controlled OAuth callback code, state, separately recorded pending state and HTTPS redirect URI are required')
if (statSync(mediaFile).size > 5 * 1024 * 1024) throw new Error('PLATFORM_CANARY_MEDIA_FILE must be at most 5 MiB')
if (!['jd', 'taobao', 'tmall', 'pinduoduo', 'xiaohongshu', 'douyin'].includes(platform ?? '')) throw new Error('PLATFORM_CANARY_PLATFORM must be jd, taobao, tmall, pinduoduo, xiaohongshu or douyin')

// Reserve a durable secret-free response journal before any provider call.
// A failed journal write aborts the connector after the response; that write
// may already have taken effect remotely, so operators must reconcile by ID.
const output = requireValue(process.env.PLATFORM_CANARY_OUTPUT?.trim(), 'PLATFORM_CANARY_OUTPUT')
const transcriptOutput = requireValue(process.env.PLATFORM_CANARY_TRANSCRIPT_OUTPUT?.trim(), 'PLATFORM_CANARY_TRANSCRIPT_OUTPUT')
const basePath = requireValue(process.env.PLATFORM_CANARY_BASE_EVIDENCE?.trim(), 'PLATFORM_CANARY_BASE_EVIDENCE')
const releaseId = requireValue(process.env.RELEASE_ID?.trim(), 'RELEASE_ID')
const document = JSON.parse(readFileSync(basePath, 'utf8')) as { schema_version?: string; release_id?: string; environment?: string; generated_at?: string; platforms?: Array<Record<string, unknown>> }
if (document.release_id !== releaseId || !Array.isArray(document.platforms) || !document.platforms.some(item => item.platform === platform)) throw new Error('base evidence must match RELEASE_ID and bind platform before provider I/O')
const transcriptName = basename(transcriptOutput)
if (!/^[A-Za-z0-9._-]+$/u.test(transcriptName)) throw new Error('canary transcript basename is unsafe')
const journal = openSync(`${transcriptOutput}.journal`, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)

const exchanges: ProviderExchangeObservation[] = []
const runtime = new ConnectorRuntime({ configSource: process.env, credentialProvider: createVaultCredentialProviderFromEnv(), onExchange: observation => {
  writeSync(journal, `${JSON.stringify(observation)}\n`)
  fsyncSync(journal)
  exchanges.push(observation)
} })
const writeFields = process.env.PLATFORM_CANARY_WRITE_FIELDS ? JSON.parse(process.env.PLATFORM_CANARY_WRITE_FIELDS) as Record<string, unknown> : undefined
const mediaBytes = readFileSync(mediaFile)
const result = await runPlatformCanary({
  connector: runtime.connector(platform!),
  context: { workspaceId: requireValue(workspaceId, 'PLATFORM_CANARY_WORKSPACE_ID'), accountId: requireValue(accountId, 'PLATFORM_CANARY_ACCOUNT_ID'), traceId: `platform-canary-${Date.now()}` },
  evidenceRef: requireValue(evidenceRef, 'PLATFORM_CANARY_EVIDENCE_REF'), verifiedBy: requireValue(verifiedBy, 'PLATFORM_CANARY_VERIFIED_BY'), apiVersion: requireValue(apiVersion, 'PLATFORM_CANARY_API_VERSION'), scope: requireValue(scope, 'PLATFORM_CANARY_SCOPE'), expectedRemoteId: requireValue(expectedRemoteId, 'PLATFORM_CANARY_EXPECTED_REMOTE_ID'),
  allowWrite, allowRevoke, ...(writeFields ? { writeFields } : {}),
  oauthCallback: { code: oauthCode, state: oauthState, pendingState: oauthPendingState, redirectUri: oauthRedirectUri, ...(process.env.PLATFORM_CANARY_OAUTH_CODE_VERIFIER ? { codeVerifier: process.env.PLATFORM_CANARY_OAUTH_CODE_VERIFIER } : {}) },
  promoteToProductionCanary: true,
  mediaFile: { bytes: mediaBytes, mimeType: process.env.PLATFORM_CANARY_MEDIA_MIME_TYPE?.trim() || 'image/png', sha256: createHash('sha256').update(mediaBytes).digest('hex') },
})
closeSync(journal)
if (output) {
  const platformEntry = document.platforms.find(item => item.platform === platform)
  if (!platformEntry) throw new Error(`base evidence is missing platform ${platform}`)
  const transcriptBytes = Buffer.from(`${JSON.stringify({ schema_version: 'provider-exchanges/1', release_id: document.release_id, platform, workspace_id: workspaceId, account_id: accountId, exchanges }, null, 2)}\n`)
  writeFileSync(transcriptOutput, transcriptBytes, { flag: 'wx', mode: 0o600 })
  platformEntry.exchange_transcript_ref = `artifact://production/${transcriptName}#${createHash('sha256').update(transcriptBytes).digest('hex')}`
  platformEntry.application_id = requireValue(applicationId, 'PLATFORM_CANARY_APPLICATION_ID')
  platformEntry.test_store_id = requireValue(process.env.PLATFORM_CANARY_TEST_STORE_ID?.trim() || accountId, 'PLATFORM_CANARY_TEST_STORE_ID')
  platformEntry.tenant_context = {
    workspace_id: requireValue(workspaceId, 'PLATFORM_CANARY_WORKSPACE_ID'),
    account_id: requireValue(accountId, 'PLATFORM_CANARY_ACCOUNT_ID'),
  }
  const previous = platformEntry.capabilities && typeof platformEntry.capabilities === 'object' && !Array.isArray(platformEntry.capabilities) ? platformEntry.capabilities as Record<string, Record<string, unknown>> : {}
  platformEntry.capabilities = Object.fromEntries(result.evidence.map(item => {
    const existing = previous[item.capability] ?? {}
    // Preserve separately attested protocol and negative-path evidence. The
    // fetch transport itself does not reveal negotiated TLS/HTTP versions.
    return [item.capability, { ...existing, state: item.state, evidence_ref: item.evidenceRef, verified_by: item.verifiedBy, verified_at: item.verifiedAt, api_version: item.apiVersion, scope: item.scope }]
  }))
  document.generated_at = new Date().toISOString()
  writeFileSync(output, `${JSON.stringify(document, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
}
console.log(JSON.stringify(result))
if (!result.passed) process.exitCode = 1
