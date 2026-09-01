import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, statSync } from 'node:fs'
import { ConnectorRuntime } from '../packages/application/src/connector-runtime.js'
import { createVaultCredentialProviderFromEnv, type Platform } from '../packages/connectors/src/index.js'
import { runPlatformCanary } from '../packages/connectors/src/canary.js'

const platform = process.env.PLATFORM_CANARY_PLATFORM?.trim() as Platform | undefined
const workspaceId = process.env.PLATFORM_CANARY_WORKSPACE_ID?.trim()
const accountId = process.env.PLATFORM_CANARY_ACCOUNT_ID?.trim()
const evidenceRef = process.env.PLATFORM_CANARY_EVIDENCE_REF?.trim()
const verifiedBy = process.env.PLATFORM_CANARY_VERIFIED_BY?.trim()
const apiVersion = process.env.PLATFORM_CANARY_API_VERSION?.trim()
const scope = process.env.PLATFORM_CANARY_SCOPE?.trim()
const applicationId = process.env.PLATFORM_CANARY_APPLICATION_ID?.trim()
const confirm = process.env.PLATFORM_CANARY_CONFIRM === 'true'
const allowWrite = process.env.PLATFORM_CANARY_ALLOW_WRITE === 'true'
const allowRevoke = process.env.PLATFORM_CANARY_ALLOW_REVOKE === 'true'
const mediaFile = process.env.PLATFORM_CANARY_MEDIA_FILE?.trim()

function requireValue(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} is required`)
  return value
}

if (process.env.PLATFORM_CANARY_MODE !== 'real') throw new Error('PLATFORM_CANARY_MODE=real is required; fixture checks use platform-preflight instead')
if (!confirm) throw new Error('PLATFORM_CANARY_CONFIRM=true is required')
if (allowWrite && process.env.PLATFORM_CANARY_CONFIRM_WRITES !== 'true') throw new Error('PLATFORM_CANARY_CONFIRM_WRITES=true is required for write canary')
if (allowRevoke && process.env.PLATFORM_CANARY_CONFIRM_REVOKE !== 'true') throw new Error('PLATFORM_CANARY_CONFIRM_REVOKE=true is required for revoke canary')
if (!mediaFile) throw new Error('PLATFORM_CANARY_MEDIA_FILE is required for the production media-upload canary')
if (statSync(mediaFile).size > 5 * 1024 * 1024) throw new Error('PLATFORM_CANARY_MEDIA_FILE must be at most 5 MiB')
if (!['jd', 'taobao', 'tmall', 'pinduoduo', 'xiaohongshu', 'douyin'].includes(platform ?? '')) throw new Error('PLATFORM_CANARY_PLATFORM must be jd, taobao, tmall, pinduoduo, xiaohongshu or douyin')

const runtime = new ConnectorRuntime({ configSource: process.env, credentialProvider: createVaultCredentialProviderFromEnv() })
const writeFields = process.env.PLATFORM_CANARY_WRITE_FIELDS ? JSON.parse(process.env.PLATFORM_CANARY_WRITE_FIELDS) as Record<string, unknown> : undefined
const mediaBytes = readFileSync(mediaFile)
const result = await runPlatformCanary({
  connector: runtime.connector(platform!),
  context: { workspaceId: requireValue(workspaceId, 'PLATFORM_CANARY_WORKSPACE_ID'), accountId: requireValue(accountId, 'PLATFORM_CANARY_ACCOUNT_ID'), traceId: `platform-canary-${Date.now()}` },
  evidenceRef: requireValue(evidenceRef, 'PLATFORM_CANARY_EVIDENCE_REF'), verifiedBy: requireValue(verifiedBy, 'PLATFORM_CANARY_VERIFIED_BY'), apiVersion: requireValue(apiVersion, 'PLATFORM_CANARY_API_VERSION'), scope: requireValue(scope, 'PLATFORM_CANARY_SCOPE'),
  allowWrite, allowRevoke, ...(writeFields ? { writeFields } : {}),
  promoteToProductionCanary: true,
  mediaFile: { bytes: mediaBytes, mimeType: process.env.PLATFORM_CANARY_MEDIA_MIME_TYPE?.trim() || 'image/png', sha256: createHash('sha256').update(mediaBytes).digest('hex') },
})
const output = process.env.PLATFORM_CANARY_OUTPUT?.trim()
if (output) {
  const basePath = process.env.PLATFORM_CANARY_BASE_EVIDENCE?.trim()
  if (!basePath) throw new Error('PLATFORM_CANARY_BASE_EVIDENCE is required when PLATFORM_CANARY_OUTPUT is set')
  const document = JSON.parse(readFileSync(basePath, 'utf8')) as { schema_version?: string; release_id?: string; environment?: string; generated_at?: string; platforms?: Array<Record<string, unknown>> }
  if (!Array.isArray(document.platforms)) throw new Error('PLATFORM_CANARY_BASE_EVIDENCE must contain a platforms array')
  const platformEntry = document.platforms.find(item => item.platform === platform)
  if (!platformEntry) throw new Error(`base evidence is missing platform ${platform}`)
  platformEntry.application_id = requireValue(applicationId, 'PLATFORM_CANARY_APPLICATION_ID')
  platformEntry.test_store_id = requireValue(process.env.PLATFORM_CANARY_TEST_STORE_ID?.trim() || accountId, 'PLATFORM_CANARY_TEST_STORE_ID')
  platformEntry.capabilities = Object.fromEntries(result.evidence.map(item => [item.capability, {
    state: item.state, evidence_ref: item.evidenceRef, verified_by: item.verifiedBy, verified_at: item.verifiedAt, api_version: item.apiVersion, scope: item.scope,
  }]))
  document.generated_at = new Date().toISOString()
  writeFileSync(output, `${JSON.stringify(document, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
}
console.log(JSON.stringify(result))
if (!result.passed) process.exitCode = 1
