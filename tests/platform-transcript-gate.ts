import { createHash } from 'node:crypto'
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from 'node:fs'
import { resolve, sep } from 'node:path'

const artifact = /^artifact:\/\/production\/([A-Za-z0-9._-]+)#[a-f0-9]{64}$/u
const operations = new Set(['exchange_code', 'refresh_credential', 'revoke', 'sync_products', 'create_product', 'update_product', 'query_write', 'upload_media'])
const safeKeys = new Set(['platform', 'operation', 'workspaceId', 'accountId', 'method', 'origin', 'status', 'observedAt', 'providerRequestId', 'errorCode', 'errorMessage', 'retryable', 'transport'])
const safeTopLevelKeys = new Set(['schema_version', 'release_id', 'platform', 'workspace_id', 'account_id', 'exchanges'])
const required = ['exchange_code', 'refresh_credential', 'sync_products', 'create_product', 'update_product', 'query_write', 'upload_media', 'revoke']
const capabilityOperation: Record<string, string> = { authorize: 'exchange_code', refresh: 'refresh_credential', read: 'sync_products', full_sync: 'sync_products', incremental_sync: 'sync_products', create: 'create_product', update: 'update_product', query_status: 'query_write', revoke: 'revoke', media_upload: 'upload_media' }
const strictUtcInstant = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u
export const PLATFORM_TRANSCRIPT_CANDIDATE_MAX_AGE_MS = 24 * 60 * 60_000
export const PLATFORM_TRANSCRIPT_FUTURE_SKEW_MS = 5 * 60_000

export function validatePlatformExchangeTranscripts(document: unknown, artifactRoot: string, now = new Date()): string[] {
  const errors: string[] = []
  if (!document || typeof document !== 'object' || !Array.isArray((document as Record<string, unknown>).platforms)) return ['platform capability document is invalid']
  const value = document as { release_id?: unknown; generated_at?: unknown; platforms: Array<Record<string, unknown>> }
  const generatedAt = typeof value.generated_at === 'string' && strictUtcInstant.test(value.generated_at) ? Date.parse(value.generated_at) : Number.NaN
  if (!Number.isFinite(generatedAt)) errors.push('generated_at must be a strict UTC ISO timestamp')
  else {
    if (generatedAt > now.getTime() + PLATFORM_TRANSCRIPT_FUTURE_SKEW_MS) errors.push('generated_at must not be more than five minutes in the future')
    if (now.getTime() - generatedAt > PLATFORM_TRANSCRIPT_CANDIDATE_MAX_AGE_MS) errors.push('generated_at is outside the platform transcript candidate window')
  }
  const realRoot = realpathSync(artifactRoot)
  if (realRoot !== resolve(artifactRoot) || lstatSync(artifactRoot).isSymbolicLink()) return ['platform transcript artifact root must be canonical and non-symlink']
  for (const entry of value.platforms) {
    const platform = String(entry.platform ?? '')
    const reference = entry.exchange_transcript_ref
    const ref = typeof reference === 'string' ? reference : ''
    const match = artifact.exec(ref)
    if (!match) { errors.push(`${platform}.exchange_transcript_ref must be a SHA-256 production artifact`); continue }
    const path = resolve(realRoot, match[1]!)
    if (!path.startsWith(`${realRoot}${sep}`)) { errors.push(`${platform}.exchange_transcript_ref escapes artifact root`); continue }
    let bytes: Buffer
    try {
      const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        if (!fstatSync(descriptor).isFile() || fstatSync(descriptor).size > 1024 * 1024) throw new Error('unsafe transcript file')
        bytes = readFileSync(descriptor)
      } finally { closeSync(descriptor) }
    } catch { errors.push(`${platform}.exchange_transcript_ref is missing or unsafe`); continue }
    if (createHash('sha256').update(bytes).digest('hex') !== ref.slice(-64)) { errors.push(`${platform}.exchange_transcript_ref SHA-256 mismatch`); continue }
    let transcript: Record<string, unknown>
    try { transcript = JSON.parse(bytes.toString('utf8')) as Record<string, unknown> } catch { errors.push(`${platform}.exchange_transcript_ref is not JSON`); continue }
    if (Object.keys(transcript).some(key => !safeTopLevelKeys.has(key))) errors.push(`${platform}.exchange_transcript_ref contains disallowed top-level fields`)
    if (transcript.schema_version !== 'provider-exchanges/1' || transcript.release_id !== value.release_id || transcript.platform !== platform) errors.push(`${platform}.exchange_transcript_ref release/platform binding is invalid`)
    const tenant = entry.tenant_context as { workspace_id?: unknown; account_id?: unknown } | undefined
    if (transcript.workspace_id !== tenant?.workspace_id || transcript.account_id !== tenant?.account_id) errors.push(`${platform}.exchange_transcript_ref tenant binding is invalid`)
    if (!Array.isArray(transcript.exchanges) || transcript.exchanges.length === 0) { errors.push(`${platform}.exchange_transcript_ref has no provider responses`); continue }
    const seen = new Set<string>()
    const failures: Array<Record<string, unknown>> = []
    const usedFailures = new Set<number>()
    let previousObservedAt = Number.NEGATIVE_INFINITY
    for (const item of transcript.exchanges) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) { errors.push(`${platform}.exchange_transcript_ref contains an invalid exchange`); continue }
      const exchange = item as Record<string, unknown>
      if (Object.keys(exchange).some(key => !safeKeys.has(key))) errors.push(`${platform}.exchange_transcript_ref contains disallowed exchange fields`)
      if (exchange.platform !== platform || exchange.workspaceId !== tenant?.workspace_id || (exchange.accountId !== undefined && exchange.accountId !== tenant?.account_id)) errors.push(`${platform}.exchange_transcript_ref exchange scope mismatch`)
      const methodValid = exchange.operation === 'sync_products' ? exchange.method === 'GET' : exchange.method === 'POST'
      if (!operations.has(String(exchange.operation)) || exchange.transport !== 'fetch' || !Number.isInteger(exchange.status) || Number(exchange.status) < 100 || Number(exchange.status) > 599 || !methodValid) errors.push(`${platform}.exchange_transcript_ref exchange operation/status/method invalid`)
      try { const origin = new URL(String(exchange.origin)); if (origin.protocol !== 'https:' || origin.origin !== exchange.origin || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw new Error('unsafe origin') } catch { errors.push(`${platform}.exchange_transcript_ref exchange origin invalid`) }
      const observedAt = typeof exchange.observedAt === 'string' && strictUtcInstant.test(exchange.observedAt) ? Date.parse(exchange.observedAt) : Number.NaN
      if (!Number.isFinite(observedAt)) errors.push(`${platform}.exchange_transcript_ref exchange timestamp invalid`)
      else {
        if (observedAt < previousObservedAt) errors.push(`${platform}.exchange_transcript_ref exchange timestamps must be monotonic`)
        if (Number.isFinite(generatedAt) && observedAt > generatedAt) errors.push(`${platform}.exchange_transcript_ref exchange timestamp is after candidate generation`)
        if (Number.isFinite(generatedAt) && generatedAt - observedAt > PLATFORM_TRANSCRIPT_CANDIDATE_MAX_AGE_MS) errors.push(`${platform}.exchange_transcript_ref exchange timestamp is outside the candidate generation window`)
        previousObservedAt = observedAt
      }
      if (['create_product', 'update_product', 'query_write'].includes(String(exchange.operation)) && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(String(exchange.providerRequestId ?? ''))) errors.push(`${platform}.exchange_transcript_ref provider request ID missing for write/status`)
      if (Number(exchange.status) >= 200 && Number(exchange.status) < 300) seen.add(String(exchange.operation))
      else failures.push(exchange)
    }
    for (const operation of required) if (!seen.has(operation)) errors.push(`${platform}.exchange_transcript_ref missing ${operation} response`)
    const capabilities = entry.capabilities
    if (capabilities && typeof capabilities === 'object' && !Array.isArray(capabilities)) {
      for (const [name, raw] of Object.entries(capabilities)) {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw) || (raw as Record<string, unknown>).state !== 'production_canary') continue
        const evidence = (raw as Record<string, unknown>).error_evidence
        const detail = evidence && typeof evidence === 'object' && !Array.isArray(evidence) ? evidence as Record<string, unknown> : {}
        const operation = capabilityOperation[name]
        const failureIndex = failures.findIndex((item, index) => !usedFailures.has(index) &&
          item.operation === operation && item.providerRequestId === detail.request_id && item.errorCode === detail.code && item.errorMessage === detail.message && item.observedAt === detail.observed_at && item.retryable === detail.retryable
        )
        if (!operation || typeof detail.request_id !== 'string' || typeof detail.code !== 'string' || typeof detail.message !== 'string' || typeof detail.observed_at !== 'string' || typeof detail.retryable !== 'boolean' || failureIndex < 0) errors.push(`${platform}.${name} production canary error evidence lacks matching provider failure`)
        else usedFailures.add(failureIndex)
      }
    }
  }
  return errors
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = (name: string) => { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : undefined }
  const file = arg('--file'); const root = arg('--artifact-root')
  if (!file || !root) { console.error('platform transcript gate requires --file and --artifact-root'); process.exit(2) }
  let errors: string[]
  try { errors = validatePlatformExchangeTranscripts(JSON.parse(readFileSync(file, 'utf8')), root) } catch { errors = ['platform transcript gate could not read document or artifact root'] }
  if (errors.length) { console.error(errors.map(error => `- ${error}`).join('\n')); process.exit(1) }
  console.log('platform transcript metadata gate passed; negative-path and protocol evidence remain separate requirements')
}
