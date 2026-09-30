import { createHash } from 'node:crypto'
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readBoundedResponseText } from '../packages/connectors/src/bounded-response.js'
import { createRelayPricingClientFromEnv, type RelayPricingMetadata } from '../packages/ai/src/relay-pricing.js'
import { parseRelayUsage, type RelayUsageRecord } from '../packages/ai/src/relay-usage.js'
import { retryAfterMilliseconds } from '../packages/ai/src/provider-request.js'
import { assertRelayUrl, relaySecurityFromEnv } from '../packages/ai/src/relay-security.js'
import { ALLOWED_EMBEDDING_MODELS, validateModelRelayEvidence } from '../tests/model-relay-evidence-gate.js'

export type ProbeResult = {
  modality: 'text' | 'image' | 'image_edit' | 'ocr' | 'video' | 'embedding'
  state: 'ready' | 'blocked' | 'not_run_cost_guard' | 'skipped_input'
  endpoint: string
  model: string
  dimensions?: number
  httpStatus?: number
  providerRequestId?: string
  providerJobId?: string
  usageObserved?: boolean
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number; billingUnits?: number; durationSeconds?: number }
  usageProviderRequestId?: string
  costObserved?: boolean
  costSource?: 'provider_receipt' | 'relay_pricing_snapshot'
  costEvidenceKind?: 'provider_reported_actual' | 'pricing_derived_from_observed_usage'
  costCny?: number
  pricingVersion?: string
  pricingGroup?: string
  pricingSnapshotSha256?: string
  evidence_ref?: string
  detail?: string
}

type SuccessfulProbe = Omit<ProbeResult, 'state' | 'detail'> & {
  responseValid: boolean
  responseFailure?: string
}

const source = process.env.MODEL_RELAY_BASE_URL?.trim() ?? ''
const key = process.env.MODEL_RELAY_API_KEY?.trim() ?? ''
const videoKey = process.env.VIDEO_MODEL_RELAY_API_KEY?.trim() || key
const confirmCost = process.env.MODEL_RELAY_CANARY_CONFIRM === 'true'
const timeoutMs = resolveBoundedInteger(process.env.MODEL_RELAY_CANARY_TIMEOUT_MS, 120_000, 2_000, 120_000, 'MODEL_RELAY_CANARY_TIMEOUT_MS')
const rawVideoDurationSeconds = Number(process.env.VIDEO_DURATION_SECONDS ?? 5)
const videoDurationSeconds = Number.isFinite(rawVideoDurationSeconds) ? Math.max(3, Math.min(15, rawVideoDurationSeconds)) : 5
// Keep the default canary prompt deliberately neutral. Some relay safety
// filters reject vague or non-deterministic test prompts before a provider
// job is created, which would test the filter rather than video readiness.
const videoCanaryPrompt = process.env.MODEL_RELAY_CANARY_VIDEO_PROMPT?.trim()
  || 'A simple blue geometric cube on a plain white background, no people, no text.'
const base = source.replace(/\/+$/u, '')
type SanitizedEmbeddingPricingSnapshot = {
  pricing: { pricing_version: string; group_ratio: Record<string, number>; data: Array<Record<string, unknown>> }
  status: { quota_per_unit: number; usd_exchange_rate: number }
}
const embeddingPricingSnapshot: { value?: SanitizedEmbeddingPricingSnapshot; pricing?: SanitizedEmbeddingPricingSnapshot['pricing']; status?: SanitizedEmbeddingPricingSnapshot['status']; digest?: string } = {}
const pricingFetch: typeof fetch = async (resource, init) => {
  const response = await fetch(resource, init)
  const url = new URL(typeof resource === 'string' ? resource : resource instanceof URL ? resource.href : resource.url)
  if (url.origin === new URL(base || 'https://invalid.example').origin && (url.pathname === '/api/pricing' || url.pathname === '/api/status')) {
    const text = await readBoundedResponseText(response.clone(), url.pathname === '/api/status' ? 16 * 1024 : 2 * 1024 * 1024, 'relay pricing snapshot')
    const parsed = JSON.parse(text) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('relay pricing snapshot is invalid')
    const root = parsed as Record<string, unknown>
    if (url.pathname === '/api/pricing') {
      const groups = root.group_ratio
      const records = root.data
      if (typeof root.pricing_version !== 'string' || !groups || typeof groups !== 'object' || Array.isArray(groups) || !Array.isArray(records)) throw new Error('relay pricing snapshot is incomplete')
      const data = records.filter((entry): entry is Record<string, unknown> => !!entry && typeof entry === 'object' && !Array.isArray(entry)
        && ALLOWED_EMBEDDING_MODELS.includes(String((entry as Record<string, unknown>).model_name) as typeof ALLOWED_EMBEDDING_MODELS[number]))
        .map(entry => Object.fromEntries(['model_name', 'quota_type', 'model_ratio', 'model_price', 'completion_ratio', 'enable_groups', 'pricing_version', 'billing_mode']
          .filter(field => field in entry).map(field => [field, entry[field]])))
      const safeGroups = Object.fromEntries(Object.entries(groups as Record<string, unknown>).filter(([, value]) => typeof value === 'number' && Number.isFinite(value))) as Record<string, number>
      embeddingPricingSnapshot.pricing = { pricing_version: root.pricing_version, group_ratio: safeGroups, data }
    } else {
      const data = root.data && typeof root.data === 'object' && !Array.isArray(root.data) ? root.data as Record<string, unknown> : undefined
      if (!data || typeof data.quota_per_unit !== 'number' || !Number.isFinite(data.quota_per_unit) || typeof data.usd_exchange_rate !== 'number' || !Number.isFinite(data.usd_exchange_rate)) throw new Error('relay status snapshot is incomplete')
      embeddingPricingSnapshot.status = { quota_per_unit: data.quota_per_unit, usd_exchange_rate: data.usd_exchange_rate }
    }
    if (embeddingPricingSnapshot.pricing && embeddingPricingSnapshot.status) {
      embeddingPricingSnapshot.value = { pricing: embeddingPricingSnapshot.pricing, status: embeddingPricingSnapshot.status }
      const canonical = JSON.stringify(embeddingPricingSnapshot.value)
      embeddingPricingSnapshot.digest = createHash('sha256').update(canonical, 'utf8').digest('hex')
    }
  }
  return response
}
const pricingClient = createRelayPricingClientFromEnv(process.env, pricingFetch)
const relaySecurity = relaySecurityFromEnv(process.env)
const artifactRoot = process.env.MODEL_RELAY_ARTIFACT_ROOT?.trim()
const releaseId = process.env.RELEASE_ID?.trim() || ''

type CanaryPricing = { estimateRequestCost: (usage: RelayUsageRecord) => Promise<{ costCny: number; metadata: Pick<RelayPricingMetadata, 'pricing_version' | 'pricing_group' | 'quota_type' | 'formula_version'> }> }
type CanaryBudget = { limitCny: number; reservedCny: number }
type RelayTokenQuota = { credential: 'model' | 'video'; observed_at: string; total_granted: number; total_used: number; total_available: number; expires_at: number; unlimited_quota: false; evidence_ref?: string }

/** The caller's budget is not a provider-enforced ceiling. Only a finite relay
 * token can bound spend if this process crashes, retries elsewhere, or races. */
export async function requireFiniteRelayTokenQuota(input: {
  baseUrl: string
  apiKey: string
  credential: RelayTokenQuota['credential']
  fetcher?: typeof fetch
  now?: Date
}): Promise<RelayTokenQuota> {
  const origin = new URL(input.baseUrl)
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.search || origin.hash) throw new Error('relay token quota requires a canonical HTTPS origin')
  if (!input.apiKey.trim()) throw new Error(`${input.credential} relay token is missing`)
  const observedAt = input.now ?? new Date()
  const response = await (input.fetcher ?? fetch)(new URL('/api/usage/token/', origin), {
    headers: { accept: 'application/json', authorization: `Bearer ${input.apiKey}` },
    redirect: 'error', signal: AbortSignal.timeout(10_000),
  })
  if (!response.ok) throw new Error(`${input.credential} relay token quota HTTP ${response.status}`)
  let root: unknown
  try { root = JSON.parse(await readBoundedResponseText(response, 16 * 1024, 'relay token quota')) as unknown }
  catch { throw new Error(`${input.credential} relay token quota response is invalid`) }
  const envelope = root && typeof root === 'object' && !Array.isArray(root) ? root as Record<string, unknown> : undefined
  const data = envelope?.data && typeof envelope.data === 'object' && !Array.isArray(envelope.data) ? envelope.data as Record<string, unknown> : undefined
  if ((envelope?.code !== true && envelope?.success !== true) || data?.object !== 'token_usage') throw new Error(`${input.credential} relay token quota response is invalid`)
  if (data.unlimited_quota !== false) throw new Error(`${input.credential} relay token must have a finite server-enforced quota`)
  const { total_granted: granted, total_used: used, total_available: available, expires_at: expiresAt } = data
  if (![granted, used, available, expiresAt].every(value => typeof value === 'number' && Number.isSafeInteger(value))
    || (granted as number) <= 0 || (used as number) < 0 || (available as number) <= 0
    || (used as number) + (available as number) !== granted
    || (expiresAt as number) < 0 || ((expiresAt as number) !== 0 && (expiresAt as number) <= Math.floor(observedAt.getTime() / 1000))) {
    throw new Error(`${input.credential} relay token finite quota evidence is invalid or exhausted`)
  }
  return { credential: input.credential, observed_at: observedAt.toISOString(), total_granted: granted as number, total_used: used as number, total_available: available as number, expires_at: expiresAt as number, unlimited_quota: false }
}

export function writeRelayTokenQuotaArtifact(root: string, release: string, quota: RelayTokenQuota): string {
  if (!/^[A-Za-z0-9._-]+$/u.test(release)) throw new Error('RELEASE_ID must be a safe artifact path component')
  const { evidence_ref: _reference, ...snapshot } = quota
  const body = JSON.stringify({ schema_version: '1', release_id: release, token_quota: snapshot }, null, 2) + '\n'
  const digest = createHash('sha256').update(body).digest('hex')
  const directory = resolve(root, 'relay', release)
  const target = resolve(directory, `token-${quota.credential}-${digest.slice(0, 16)}.json`)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  writeImmutableRelayArtifact(target, body)
  return `artifact://production/${relative(resolve(root), target).split('\\').join('/')}#${digest}`
}

export function isPrivateRelayArtifact(stat: { isFile(): boolean; uid: number }, mode: number, currentUid: number | undefined): boolean {
  return stat.isFile() && currentUid !== undefined && stat.uid === currentUid && (mode & 0o777) === 0o600
}

function writeImmutableRelayArtifact(target: string, body: string): void {
  try { writeFileSync(target, body, { mode: 0o600, flag: 'wx' }) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    let descriptor: number | undefined
    try {
      descriptor = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW)
      const stat = fstatSync(descriptor)
      const currentUid = process.getuid?.()
      if (!isPrivateRelayArtifact(stat, stat.mode, currentUid)
        || readFileSync(descriptor, 'utf8') !== body) {
        throw new Error('relay artifact already exists with different content, owner, mode or type')
      }
    } catch (reuseError) {
      if (reuseError instanceof Error && reuseError.message.startsWith('relay artifact already exists')) throw reuseError
      throw new Error('relay artifact already exists with different content, owner, mode or type')
    } finally {
      if (descriptor !== undefined) closeSync(descriptor)
    }
  }
}

export function requireCanaryBudget(value: string | undefined): CanaryBudget {
  const limitCny = value?.trim() && /^\d+(?:\.\d+)?$/u.test(value.trim()) ? Number(value) : NaN
  if (!Number.isFinite(limitCny) || limitCny <= 0) throw new Error('MODEL_RELAY_CANARY_MAX_TOTAL_CNY must be an explicit positive CNY budget')
  return { limitCny, reservedCny: 0 }
}

/** Return an actionable, credential-safe blocker for operator-facing canary output. */
export function relayProbeFailureReason(error: unknown): string {
  const message = error instanceof Error ? error.message : ''
  if (message.endsWith('relay token must have a finite server-enforced quota')) return 'relay_token_quota_unbounded'
  if (message.endsWith('relay token finite quota evidence is invalid or exhausted')) return 'relay_token_quota_invalid_or_exhausted'
  if (message.includes('relay token quota HTTP ')) return 'relay_token_quota_http_error'
  if (message.endsWith('relay token quota response is invalid')) return 'relay_token_quota_response_invalid'
  if (message.includes('MODEL_RELAY_CANARY_MAX_TOTAL_CNY')) return 'relay_canary_budget_invalid'
  if (message.includes('MODEL_RELAY_ARTIFACT_ROOT')) return 'relay_artifact_root_missing'
  if (message.includes('MODEL_RELAY_BASE_URL/ALLOWED_HOSTS')) return 'relay_security_config_invalid'
  return 'relay_probe_failed'
}

/** Reserve the worst case of three 429 attempts before any billable relay request. */
export async function reserveCanaryCost(input: {
  pricing: CanaryPricing | undefined
  budget: CanaryBudget
  modality: ProbeResult['modality']
  model: string
  requestBody: Record<string, unknown>
  durationSeconds?: number
  resolution?: string
}): Promise<number> {
  if (!input.pricing) throw new Error('relay pricing snapshot is required before a canary request')
  const { modality, model, requestBody } = input
  if (modality === 'video' && (!['720P', '1080P'].includes(input.resolution ?? '') || !Number.isSafeInteger(input.durationSeconds) || (input.durationSeconds ?? 0) < 3 || (input.durationSeconds ?? 0) > 15)) {
    throw new Error('video canary requires explicit 720P/1080P resolution and 3-15 second duration before pricing')
  }
  const estimate = await input.pricing.estimateRequestCost({
    modality, model, observedAt: new Date().toISOString(),
    ...(modality === 'text' || modality === 'ocr' || modality === 'embedding'
      ? { inputTokens: Buffer.byteLength(JSON.stringify(requestBody), 'utf8'), outputTokens: modality === 'embedding' ? 0 : Number(requestBody.max_tokens) }
      : {}),
    metadata: modality === 'image' || modality === 'image_edit'
      ? { billing_units: 1 }
      : modality === 'video'
        ? { preauthorization_estimate: true, preauthorization_duration_seconds: input.durationSeconds, resolution: input.resolution }
        : {},
  })
  if (!estimate.metadata.pricing_version || !estimate.metadata.pricing_group || !Number.isFinite(estimate.costCny) || estimate.costCny <= 0) {
    throw new Error('relay canary price is unknown or zero')
  }
  if ((modality === 'image' || modality === 'image_edit') && estimate.metadata.quota_type !== 1) {
    throw new Error('image canary requires an explicit fixed-unit relay price')
  }
  if (modality === 'video' && !['relay-video-resolution-v1', 'relay-video-cny-per-second-v1'].includes(estimate.metadata.formula_version)) {
    throw new Error('video canary requires an explicit duration/resolution relay price')
  }
  // Round up, never down: a fractional micro-yuan must not escape the cap.
  const reservation = Math.ceil(Number((estimate.costCny * 3 * 1_000_000).toFixed(6))) / 1_000_000
  if (!Number.isFinite(reservation) || reservation <= 0 || input.budget.reservedCny + reservation > input.budget.limitCny) {
    throw new Error('relay canary request exceeds MODEL_RELAY_CANARY_MAX_TOTAL_CNY')
  }
  input.budget.reservedCny += reservation
  return reservation
}

export function resolveBoundedInteger(value: string | undefined, fallback: number, minimum: number, maximum: number, name: string): number {
  const text = value?.trim()
  if (!text) return fallback
  const parsed = Number(text)
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`)
  }
  return parsed
}

export function canaryIdempotencyKey(input: { releaseId: string; modality: ProbeResult['modality']; model: string; existingVideoTaskId?: string; requestBody?: string; candidateBinding?: { release_git_sha: string; image_set_digest: string; manifest_sha256: string; deployment_nonce_sha256: string } }): string {
  if (input.modality === 'embedding' && (typeof input.requestBody !== 'string' || !input.requestBody.trim())) throw new Error('embedding idempotency requires the canonical request body')
  const identity = JSON.stringify([input.releaseId.trim(), input.modality, input.model.trim(), input.existingVideoTaskId?.trim() ?? '',
    ...(input.modality === 'embedding' ? [input.requestBody === undefined ? '' : createHash('sha256').update(input.requestBody).digest('hex'), input.candidateBinding ?? null] : [])])
  return `model_relay_canary_${createHash('sha256').update(identity, 'utf8').digest('hex')}`
}

export function requireEmbeddingProbePreflight(input: { enabled: boolean; baseUrl: string; model: string; expectedModel?: string; dimensions?: string; confirmCost: boolean; confirmEmbedding: boolean }): void {
  if (!input.enabled) return
  if (!ALLOWED_EMBEDDING_MODELS.includes(input.model as typeof ALLOWED_EMBEDDING_MODELS[number]) || input.model !== input.expectedModel) throw new Error('embedding_model_invalid')
  if (input.dimensions !== '1024') throw new Error('embedding_dimensions_invalid')
  let url: URL
  try { url = new URL(input.baseUrl) } catch { throw new Error('embedding_relay_invalid') }
  if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'ai.wormholexyz.xyz' || url.port || url.username || url.password || url.search || url.hash || !['/v1', '/v1/'].includes(url.pathname)) throw new Error('embedding_relay_invalid')
  if (!input.confirmCost || !input.confirmEmbedding) throw new Error('embedding_cost_confirmation_missing')
}

export function embeddingResponseMatchesModel(payload: unknown, expectedModel: string): boolean {
  return !!payload && typeof payload === 'object' && !Array.isArray(payload)
    && (payload as Record<string, unknown>).model === expectedModel
}

export function canRetryCanaryResponse(status: number, attempt: number, maximumAttempts = 3): boolean {
  return status === 429 && attempt < Math.max(1, Math.min(3, Math.trunc(maximumAttempts)))
}

export function canaryRetryDelayMs(headers: Headers, attempt: number): number {
  const hinted = retryAfterMilliseconds(headers.get('retry-after')) ?? 0
  const exponential = Math.min(5_000, 250 * (2 ** Math.max(0, attempt - 1)))
  return Math.min(60_000, Math.max(hinted, exponential))
}

export function shouldBlockForCostGuard(input: {
  modality: ProbeResult['modality']
  confirmCost: boolean
  existingVideoTaskId?: string
}): boolean {
  return !input.confirmCost
    && (input.modality === 'image' || input.modality === 'image_edit' || input.modality === 'embedding' || (input.modality === 'video' && !input.existingVideoTaskId))
}

export function requireProductionReleaseBinding(input: { environment?: string; releaseId: string }): void {
  if (input.environment?.trim() === 'production' && !input.releaseId.trim()) {
    throw new Error('RELEASE_ID is required for production model relay evidence')
  }
  if (input.environment?.trim() === 'production' && !/^[A-Za-z0-9._-]+$/u.test(input.releaseId.trim())) {
    throw new Error('RELEASE_ID must be a safe production evidence identifier')
  }
}

export function requireProductionCandidateBinding(input: NodeJS.ProcessEnv = process.env) {
  const releaseGitSha = input.RELEASE_GIT_SHA?.trim() ?? ''
  const imageSetDigest = input.IMAGE_SET_DIGEST?.trim() ?? ''
  const manifestSha256 = input.MANIFEST_SHA256?.trim() ?? ''
  const deploymentNonce = input.DEPLOYMENT_NONCE?.trim() ?? ''
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(releaseGitSha)
    || !/^sha256:[a-f0-9]{64}$/u.test(imageSetDigest)
    || !/^[a-f0-9]{64}$/u.test(manifestSha256)
    || !/^[A-Za-z0-9_-]{22,128}$/u.test(deploymentNonce)) {
    throw new Error('production relay canary requires RELEASE_GIT_SHA, IMAGE_SET_DIGEST, MANIFEST_SHA256 and DEPLOYMENT_NONCE for the exact candidate')
  }
  return { release_git_sha: releaseGitSha, image_set_digest: imageSetDigest, manifest_sha256: manifestSha256,
    deployment_nonce_sha256: createHash('sha256').update(deploymentNonce).digest('hex') }
}

export function readRelayErrorRecovery(path: string | undefined): Record<string, unknown> | undefined {
  const sourcePath = path?.trim()
  if (!sourcePath) return undefined
  const value = JSON.parse(readFileSync(sourcePath, 'utf8')) as unknown
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('MODEL_RELAY_ERROR_RECOVERY_PATH must contain one JSON object')
  return value as Record<string, unknown>
}

/** Keep invalid production probes out of the immutable final evidence path. */
export function persistRelayCanaryEvidence(input: {
  path?: string
  environment?: string
  modalities: readonly ProbeResult['modality'][]
  evidence: Record<string, unknown>
  artifactRoot?: string
  expectedCandidate?: { releaseGitSha?: string; imageSetDigest?: string; manifestSha256?: string; deploymentNonce?: string }
  requireEmbedding?: boolean
  expectedEmbeddingModel?: string
}): { evidence: Record<string, unknown>; state: 'partial' | 'complete'; written: boolean; exitCode: 0 | 1 } {
  const required: ProbeResult['modality'][] = input.requireEmbedding ? ['text', 'image', 'image_edit', 'ocr', 'video', 'embedding'] : ['text', 'image', 'image_edit', 'ocr', 'video']
  const isComplete = input.modalities.length === required.length
    && required.every(modality => input.modalities.filter(item => item === modality).length === 1)
  const production = input.environment?.trim() === 'production'
  const partialProduction = production && (!isComplete || !input.artifactRoot
    || validateModelRelayEvidence(input.evidence, {
      expectedReleaseId: typeof input.evidence.release_id === 'string' ? input.evidence.release_id : undefined,
      expectedCandidate: input.expectedCandidate,
      requireEmbedding: input.requireEmbedding,
      expectedEmbeddingModel: input.expectedEmbeddingModel,
      requireCandidateBinding: true,
      requireProduction: true,
      artifactRoot: input.artifactRoot,
    }).length > 0)
  const evidence = partialProduction ? { ...input.evidence, state: 'partial' } : input.evidence
  const shouldWrite = Boolean(input.path?.trim()) && !partialProduction
  if (shouldWrite) writeFileSync(input.path!.trim(), JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
  return { evidence, state: partialProduction ? 'partial' : 'complete', written: shouldWrite, exitCode: partialProduction ? 1 : 0 }
}

function modelFor(modality: ProbeResult['modality']) {
  if (modality === 'text') return process.env.AI_MODEL?.trim() || process.env.MODEL_ID?.trim() || ''
  if (modality === 'image') return process.env.IMAGE_MODEL?.trim() || process.env.AI_IMAGE_MODEL?.trim() || ''
  if (modality === 'image_edit') return process.env.IMAGE_EDIT_MODEL?.trim() || process.env.IMAGE_MODEL?.trim() || process.env.AI_IMAGE_MODEL?.trim() || ''
  if (modality === 'ocr') return process.env.OCR_MODEL?.trim() || process.env.AI_VISION_MODEL?.trim() || ''
  if (modality === 'video') return process.env.VIDEO_MODEL?.trim() || process.env.AI_VIDEO_MODEL?.trim() || ''
  return process.env.EMBEDDING_MODEL?.trim() || ''
}

function keyFor(modality: ProbeResult['modality']) {
  return modality === 'video' ? videoKey : key
}

function endpointFor(modality: ProbeResult['modality']) {
  if (modality === 'text' || modality === 'ocr') return '/chat/completions'
  if (modality === 'image') return process.env.IMAGE_GENERATION_PATH?.trim() || '/images/generations'
  if (modality === 'image_edit') return process.env.IMAGE_EDIT_PATH?.trim() || '/images/generations'
  if (modality === 'embedding') return '/embeddings'
  return process.env.VIDEO_GENERATION_PATH?.trim()
    || (process.env.VIDEO_REQUEST_FORMAT?.trim() === 'openai-video' ? '/videos' : '/video/generations')
}

export function buildVideoProbeRequest(input: {
  model: string
  prompt: string
  durationSeconds: number
  resolution?: string
  requestFormat?: string
}): { body: string | FormData; contentType?: string } {
  if (input.requestFormat === 'openai-video') {
    const form = new FormData()
    form.set('model', input.model)
    form.set('prompt', input.prompt)
    form.set('seconds', String(input.durationSeconds))
    if (input.resolution) form.set('size', input.resolution)
    // Deliberately omit Content-Type: fetch must attach the multipart boundary.
    return { body: form }
  }
  return {
    body: JSON.stringify({
      model: input.model,
      prompt: input.prompt,
      duration: input.durationSeconds,
      ...(input.resolution ? { size: input.resolution } : {}),
    }),
    contentType: 'application/json',
  }
}

export function assertSafeRelativePath(path: string) {
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\') || path.includes('?') || path.includes('#') || path.includes('%')
    || path.split('/').some(segment => segment === '.' || segment === '..')
    || /[\u0000-\u001f\u007f]/u.test(path)) throw new Error('relay canary path must be a safe relative path')
  return path
}

function nonEmptyText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

/** Persist only the real relay response and probe metadata; never credentials. */
export function writeRelayResponseArtifact(root: string, release: string, modality: ProbeResult['modality'], response: { status: number; headers: Headers; payload: unknown; result: ProbeResult; inputText?: string; candidateBinding?: { release_git_sha: string; image_set_digest: string; manifest_sha256: string; deployment_nonce_sha256: string } }): string {
  if (!/^[A-Za-z0-9._-]+$/u.test(release)) throw new Error('RELEASE_ID must be a safe artifact path component')
  let relayResponse: unknown = response.payload
  let resultSummary: unknown = response.result
  let responseHeaders: Record<string, string> = Object.fromEntries([...response.headers].filter(([name]) => /request-id|usage|cost|quota/iu.test(name)))
  if (modality === 'embedding') {
    if (typeof response.inputText !== 'string' || !response.inputText.trim()) throw new Error('embedding artifact requires the exact non-empty input text in memory')
    if (!response.candidateBinding) throw new Error('embedding artifact requires complete candidate binding')
    const rootPayload = response.payload && typeof response.payload === 'object' && !Array.isArray(response.payload) ? response.payload as Record<string, unknown> : {}
    const data = Array.isArray(rootPayload.data) ? rootPayload.data : []
    const vector = data.length === 1 && data[0] && typeof data[0] === 'object' && Array.isArray((data[0] as Record<string, unknown>).embedding)
      ? (data[0] as { embedding: unknown[] }).embedding : undefined
    const finiteVector = vector?.every(value => typeof value === 'number' && Number.isFinite(value)) ? vector as number[] : undefined
    relayResponse = {
      embedding_response: {
        input_sha256: createHash('sha256').update(response.inputText, 'utf8').digest('hex'),
        ...(finiteVector ? { embedding_sha256: createHash('sha256').update(JSON.stringify(finiteVector), 'utf8').digest('hex') } : {}),
        data_count: data.length,
        ...(finiteVector ? { dimensions: finiteVector.length } : {}),
      },
      ...(response.candidateBinding ? { candidate_binding: response.candidateBinding } : {}),
    }
    if (response.result.costSource === 'relay_pricing_snapshot') {
      if (!embeddingPricingSnapshot.value || !embeddingPricingSnapshot.digest || response.result.pricingSnapshotSha256 !== embeddingPricingSnapshot.digest) throw new Error('embedding settlement pricing snapshot is missing or does not match the probe result')
      ;(relayResponse as Record<string, unknown>).pricing_snapshot = embeddingPricingSnapshot.value
    }
    const fields = ['modality', 'state', 'endpoint', 'model', 'dimensions', 'httpStatus', 'providerRequestId', 'usageObserved', 'usage', 'usageProviderRequestId', 'costObserved', 'costSource', 'costEvidenceKind', 'costCny', 'pricingVersion', 'pricingGroup', 'pricingSnapshotSha256'] as const
    resultSummary = Object.fromEntries(fields.filter(field => response.result[field] !== undefined).map(field => [field, response.result[field]]))
    responseHeaders = {}
  }
  const body = JSON.stringify({
    schema_version: '1', release_id: release, modality,
    observed_at: new Date().toISOString(), http_status: response.status,
    response_headers: responseHeaders,
    result: resultSummary,
    ...(modality === 'embedding' ? relayResponse as Record<string, unknown> : { relay_response: relayResponse }),
  }, null, 2) + '\n'
  const digest = createHash('sha256').update(body).digest('hex')
  const directory = resolve(root, 'relay', release)
  const canonicalTarget = resolve(directory, `${modality}.json`)
  // Evidence artifacts are immutable. Reusing a release/modality slot with a
  // different response must never silently overwrite the prior receipt.
  let target = canonicalTarget
  if (existsSync(canonicalTarget)) {
    if (!lstatSync(canonicalTarget).isFile()) throw new Error('relay artifact already exists with different content or type')
    const existing = readFileSync(canonicalTarget, 'utf8')
    const existingDigest = createHash('sha256').update(existing).digest('hex')
    if (existingDigest !== digest) target = resolve(directory, `${modality}-${digest.slice(0, 16)}.json`)
  }
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 })
  writeImmutableRelayArtifact(target, body)
  const relativePath = relative(resolve(root), target).split('\\').join('/')
  return `artifact://production/${relativePath}#${digest}`
}

export function extractProviderRequestId(payload: unknown, headers: Headers): string | undefined {
  const root = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload as Record<string, unknown> : {}
  const data = root.data && typeof root.data === 'object' && !Array.isArray(root.data) ? root.data as Record<string, unknown> : {}
  const nestedData = data.data && typeof data.data === 'object' && !Array.isArray(data.data) ? data.data as Record<string, unknown> : {}
  const result = data.result && typeof data.result === 'object' && !Array.isArray(data.result) ? data.result as Record<string, unknown> : {}
  const metadata = root.metadata && typeof root.metadata === 'object' && !Array.isArray(root.metadata) ? root.metadata as Record<string, unknown> : {}
  return nonEmptyText(headers.get('x-oneapi-request-id'))
    ?? nonEmptyText(headers.get('x-request-id'))
    ?? nonEmptyText(headers.get('x-provider-request-id'))
    ?? nonEmptyText(headers.get('request-id'))
    ?? nonEmptyText(root.provider_request_id)
    ?? nonEmptyText(root.request_id)
    ?? nonEmptyText(data.provider_request_id)
    ?? nonEmptyText(data.request_id)
    ?? nonEmptyText(nestedData.provider_request_id)
    ?? nonEmptyText(nestedData.request_id)
    ?? nonEmptyText(result.provider_request_id)
    ?? nonEmptyText(result.request_id)
    ?? nonEmptyText(metadata.provider_request_id)
    ?? nonEmptyText(metadata.request_id)
}

type PricingClient = Pick<NonNullable<ReturnType<typeof createRelayPricingClientFromEnv>>, 'quote'>

export async function evaluateRelayUsageEvidence(
  payload: unknown,
  headers: Headers,
  modality: ProbeResult['modality'],
  model: string,
  options: { pricing?: PricingClient; pricingSnapshot?: SanitizedEmbeddingPricingSnapshot; durationSeconds?: number; resolution?: string } = {},
) {
  const record = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload as Record<string, unknown> : {}
  const nested = record.data && typeof record.data === 'object' && !Array.isArray(record.data) ? record.data as Record<string, unknown> : undefined
  const nestedData = nested?.data && typeof nested.data === 'object' && !Array.isArray(nested.data) ? nested.data as Record<string, unknown> : undefined
  const result = nested?.result && typeof nested.result === 'object' && !Array.isArray(nested.result) ? nested.result as Record<string, unknown> : undefined
  const metadata = record.metadata && typeof record.metadata === 'object' && !Array.isArray(record.metadata) ? record.metadata as Record<string, unknown> : undefined
  const rawUsage = record.usage && typeof record.usage === 'object' && !Array.isArray(record.usage)
    ? record.usage as Record<string, unknown>
    : nested?.usage && typeof nested.usage === 'object' && !Array.isArray(nested.usage)
      ? nested.usage as Record<string, unknown>
      : nestedData?.usage && typeof nestedData.usage === 'object' && !Array.isArray(nestedData.usage) ? nestedData.usage as Record<string, unknown>
        : result?.usage && typeof result.usage === 'object' && !Array.isArray(result.usage) ? result.usage as Record<string, unknown>
          : metadata?.usage && typeof metadata.usage === 'object' && !Array.isArray(metadata.usage) ? metadata.usage as Record<string, unknown> : undefined
  const parsed = parseRelayUsage(payload, headers, {
    modality,
    model,
    ...(modality === 'video' ? { context: { durationSeconds: options.durationSeconds ?? videoDurationSeconds, ...(options.resolution ? { resolution: options.resolution } : {}) } } : {}),
  })
  const nonNegativeNumber = (value: unknown): number | undefined => {
    const number = typeof value === 'number' ? value : typeof value === 'string' && /^\d+(?:\.\d+)?$/u.test(value.trim()) ? Number(value) : undefined
    return number !== undefined && Number.isFinite(number) && number >= 0 ? number : undefined
  }
  // Qwen reports provider-observed generated units as `usage.image_count`.
  // New API preserves this upstream usage object under response metadata.
  // Keep this evidence provider sourced; never substitute request count or
  // the number of parsed artifacts.
  const rawImageCount = rawUsage?.output_image_count ?? rawUsage?.image_count
  const parsedImageCount = nonNegativeNumber(rawImageCount)
  const reportedBillingUnits = parsedImageCount !== undefined && Number.isSafeInteger(parsedImageCount) && parsedImageCount > 0
    ? parsedImageCount
    : undefined
  // The suffixed fields are defined in seconds. A generic `duration` is only
  // trusted when the provider explicitly says seconds or when the same
  // receipt corroborates it with `output_video_duration`. Never infer its
  // unit from the request-side duration used for preauthorization.
  const explicitDurationUnit = typeof rawUsage?.duration_unit === 'string'
    ? rawUsage.duration_unit.trim().toLowerCase()
    : typeof rawUsage?.unit === 'string' ? rawUsage.unit.trim().toLowerCase() : undefined
  const secondsUnit = explicitDurationUnit === undefined || ['s', 'sec', 'second', 'seconds'].includes(explicitDurationUnit)
  const outputVideoDuration = rawUsage?.output_video_duration
  const genericDuration = rawUsage?.duration
  const genericDurationCorroborated = outputVideoDuration !== undefined && outputVideoDuration !== null
  const rawReportedDurations = secondsUnit
    ? [rawUsage?.duration_seconds, rawUsage?.durationSeconds, outputVideoDuration,
        ...(genericDuration !== undefined && genericDuration !== null && (explicitDurationUnit !== undefined || genericDurationCorroborated) ? [genericDuration] : [])]
    .filter(value => value !== undefined && value !== null)
    : []
  const parsedReportedDurations = rawReportedDurations.map(nonNegativeNumber)
  const reportedDuration = rawReportedDurations.length > 0
    && parsedReportedDurations.every((value): value is number => value !== undefined && value > 0)
    && parsedReportedDurations.every(value => value === parsedReportedDurations[0])
    ? parsedReportedDurations[0]
    : undefined
  const rawReportedResolutions = [rawUsage?.SR, rawUsage?.resolution, rawUsage?.output_resolution]
    .filter(value => value !== undefined && value !== null)
  const normalizeVideoResolution = (value: unknown): '720P' | '1080P' | undefined => {
    const normalized = typeof value === 'number' && Number.isSafeInteger(value)
      ? String(value)
      : typeof value === 'string' ? value.trim().toUpperCase() : ''
    if (normalized === '720' || normalized === '720P') return '720P'
    if (normalized === '1080' || normalized === '1080P') return '1080P'
    return undefined
  }
  const parsedReportedResolutions = rawReportedResolutions.map(normalizeVideoResolution)
  const reportedResolution = rawReportedResolutions.length > 0
    && parsedReportedResolutions.every((value): value is '720P' | '1080P' => value !== undefined)
    && parsedReportedResolutions.every(value => value === parsedReportedResolutions[0])
    ? parsedReportedResolutions[0]
    : undefined
  const invalidReportedResolution = rawReportedResolutions.length > 0 && reportedResolution === undefined
  const usage = {
    ...(parsed?.inputTokens !== undefined ? { inputTokens: parsed.inputTokens } : {}),
    ...(parsed?.outputTokens !== undefined ? { outputTokens: parsed.outputTokens } : {}),
    ...(parsed?.totalTokens !== undefined ? { totalTokens: parsed.totalTokens } : {}),
    ...(modality === 'image' || modality === 'image_edit'
      ? reportedBillingUnits !== undefined ? { billingUnits: reportedBillingUnits } : {}
      : {}),
    ...(modality === 'video' && reportedDuration !== undefined ? { durationSeconds: reportedDuration } : {}),
  }
  // Cost alone proves money, not consumption units. Only response-derived
  // numeric units are release evidence; requested media duration/count is not.
  const usageObserved = Object.keys(usage).length > 0
  const metering = usageObserved ? { usage, ...(parsed?.providerRequestId ? { usageProviderRequestId: parsed.providerRequestId } : {}) } : {}
  const rawCost = modality === 'embedding'
    ? parsed?.costCny ?? headers.get('x-model-cost-cny')
    : parsed?.costCny ?? record.cost ?? headers.get('x-model-cost-cny')
  const providerCost = typeof rawCost === 'number'
    ? rawCost
    : typeof rawCost === 'string' && /^\d+(?:\.\d+)?$/u.test(rawCost.trim()) ? Number(rawCost) : undefined
  if (providerCost !== undefined && Number.isFinite(providerCost) && providerCost >= 0) {
    return { usageObserved, ...metering, costObserved: true, costSource: 'provider_receipt' as const, ...(modality === 'embedding' ? { costEvidenceKind: 'provider_reported_actual' as const } : {}), costCny: providerCost }
  }
  const quoteClient = options.pricing ?? pricingClient
  if (modality === 'embedding' && options.pricing && !options.pricingSnapshot) return { usageObserved, ...metering, costObserved: false }
  if (quoteClient && parsed && usageObserved && (modality !== 'video' || (reportedDuration !== undefined && !invalidReportedResolution))) {
    const { resolution: _requestResolution, ...providerNeutralMetadata } = parsed.metadata ?? {}
    const pricingUsage = modality === 'video' && reportedDuration !== undefined
      ? { ...parsed, metadata: { ...providerNeutralMetadata, duration_seconds: reportedDuration, duration_evidence: 'provider_usage', ...(reportedResolution ? { resolution: reportedResolution } : {}) } }
      : parsed
    const quote = await quoteClient.quote(pricingUsage)
    const snapshot = options.pricingSnapshot ?? embeddingPricingSnapshot.value
    const pricingSnapshotSha256 = modality === 'embedding' && snapshot
      ? createHash('sha256').update(JSON.stringify(snapshot), 'utf8').digest('hex')
      : undefined
    if (modality === 'embedding' && (!pricingSnapshotSha256 || (!options.pricingSnapshot && embeddingPricingSnapshot.digest !== pricingSnapshotSha256))) return { usageObserved: true, ...metering, costObserved: false }
    return { usageObserved: true, ...metering, costObserved: true, costSource: 'relay_pricing_snapshot' as const, ...(modality === 'embedding' ? { costEvidenceKind: 'pricing_derived_from_observed_usage' as const } : {}), costCny: quote.costCny, pricingVersion: quote.metadata.pricing_version, pricingGroup: quote.metadata.pricing_group, ...(pricingSnapshotSha256 ? { pricingSnapshotSha256 } : {}) }
  }
  if (modality === 'embedding') return { usageObserved, ...metering, costObserved: false }
  return { usageObserved, ...metering, costObserved: false }
}

export function evaluateVideoProbePayload(payload: unknown): { ready: boolean; providerJobId?: string; reason?: string } {
  const root = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload as Record<string, unknown> : {}
  const data = root.data && typeof root.data === 'object' && !Array.isArray(root.data) ? root.data as Record<string, unknown> : root
  const nestedData = data.data && typeof data.data === 'object' && !Array.isArray(data.data) ? data.data as Record<string, unknown> : {}
  const nestedOutput = nestedData.output && typeof nestedData.output === 'object' && !Array.isArray(nestedData.output) ? nestedData.output as Record<string, unknown> : {}
  const providerJobId = nonEmptyText(data.task_id) ?? nonEmptyText(data.job_id) ?? nonEmptyText(data.id)
  const relayCode = typeof root.code === 'number' || typeof root.code === 'string' ? String(root.code).trim() : undefined
  if (relayCode && !['0', '200', 'success'].includes(relayCode.toLowerCase())) return { ready: false, ...(providerJobId ? { providerJobId } : {}), reason: 'video_relay_error_code' }
  // The local New API relay wraps async video state one level deeper as
  // `data.data.task_status` (while other providers use `status`). Treat the
  // provider's task status as first-class evidence so an accepted/running job
  // remains explicitly pending and a completed job can be validated once it
  // carries an HTTPS artifact.
  const statuses = [nestedOutput.task_status, nestedData.task_status, nestedData.status, data.status]
    .map(nonEmptyText).filter((value): value is string => Boolean(value)).map(value => value.toLowerCase())
  // The relay uses `SUCCESS` for its envelope and `SUCCEEDED` for the
  // upstream task. They describe the same terminal state and must not be
  // treated as contradictory evidence.
  const normalizedStatuses = statuses.map(value => value === 'success' ? 'succeeded' : value)
  if (new Set(normalizedStatuses).size > 1) return { ready: false, ...(providerJobId ? { providerJobId } : {}), reason: 'video_async_state_conflict' }
  const status = normalizedStatuses[0]
  const artifact = [data.result_url, data.video_url, data.output_url, data.url, nestedData.result_url, nestedData.video_url, nestedData.output_url, nestedData.url].some(isStrictHttpsUrl) || hasHttpsOutput(nestedData.output)
  if (status && ['failed', 'failure', 'error', 'cancelled', 'canceled', 'rejected', 'expired'].includes(status)) return { ready: false, ...(providerJobId ? { providerJobId } : {}), reason: 'video_async_failed' }
  // Wormhole's async wrapper reports the provider state as IN_PROGRESS while
  // the nested output uses RUNNING. Treat both as pending; otherwise a valid
  // job is incorrectly classified as "state missing" before it has finished.
  if (status && ['queued', 'pending', 'processing', 'running', 'in_progress', 'submitted'].includes(status)) return { ready: false, ...(providerJobId ? { providerJobId } : {}), reason: 'video_async_pending' }
  if (!status) return { ready: false, ...(providerJobId ? { providerJobId } : {}), reason: providerJobId ? 'video_async_state_missing' : 'video_response_missing_job_or_artifact' }
  if (['completed', 'succeeded', 'success'].includes(status) && !artifact) return { ready: false, ...(providerJobId ? { providerJobId } : {}), reason: 'video_completed_without_https_artifact' }
  if (['completed', 'succeeded', 'success'].includes(status) && artifact) return { ready: true, ...(providerJobId ? { providerJobId } : {}) }
  return { ready: false, ...(providerJobId ? { providerJobId } : {}), reason: providerJobId ? 'video_async_state_missing' : 'video_response_missing_job_or_artifact' }
}

/**
 * A successful HTTP response is not a successful canary. Production evidence
 * must remain blocked until it is attributable and both usage and cost are
 * observable. Keeping this decision pure makes every modality use the same
 * fail-closed contract, including asynchronous video status responses.
 */
export function finalizeSuccessfulProbe(input: SuccessfulProbe): ProbeResult {
  const { responseValid, responseFailure, ...result } = input
  if (!Number.isSafeInteger(result.httpStatus) || (result.httpStatus ?? 0) < 200 || (result.httpStatus ?? 0) > 299) return { ...result, state: 'blocked', detail: 'successful_http_status_missing' }
  if (!responseValid) return { ...result, state: 'blocked', detail: responseFailure ?? 'response_contract_invalid' }
  if (!result.providerRequestId) return { ...result, state: 'blocked', detail: 'provider_request_id_missing' }
  if (result.usageObserved !== true) return { ...result, state: 'blocked', detail: 'usage_evidence_missing' }
  const numericUsage = result.usage && Object.values(result.usage).filter(value => value !== undefined)
  if (!result.usage || !numericUsage?.length || numericUsage.some(value => typeof value !== 'number' || !Number.isFinite(value) || value < 0)) {
    return { ...result, state: 'blocked', detail: 'numeric_usage_evidence_missing' }
  }
  if ((result.modality === 'text' || result.modality === 'ocr' || result.modality === 'embedding')
    && result.usage.inputTokens === undefined && result.usage.outputTokens === undefined && result.usage.totalTokens === undefined) {
    return { ...result, state: 'blocked', detail: 'token_usage_evidence_missing' }
  }
  if (result.modality === 'embedding' && (result.dimensions !== 1024 || !Number.isSafeInteger(result.usage.inputTokens) || (result.usage.inputTokens ?? 0) <= 0 || (result.usage.outputTokens !== undefined && result.usage.outputTokens !== 0))) {
    return { ...result, state: 'blocked', detail: 'embedding_dimensions_or_input_usage_invalid' }
  }
  if ((result.modality === 'image' || result.modality === 'image_edit')
    && (!Number.isSafeInteger(result.usage.billingUnits) || (result.usage.billingUnits ?? 0) <= 0)) {
    return { ...result, state: 'blocked', detail: 'billing_unit_evidence_missing' }
  }
  if (result.modality === 'video' && (typeof result.usage.durationSeconds !== 'number' || result.usage.durationSeconds <= 0)) {
    return { ...result, state: 'blocked', detail: 'duration_evidence_missing' }
  }
  if (result.usage.totalTokens !== undefined && result.usage.inputTokens !== undefined && result.usage.outputTokens !== undefined
    && result.usage.totalTokens !== result.usage.inputTokens + result.usage.outputTokens) {
    return { ...result, state: 'blocked', detail: 'token_usage_evidence_inconsistent' }
  }
  if (!result.usageProviderRequestId || result.usageProviderRequestId !== result.providerRequestId) return { ...result, state: 'blocked', detail: 'usage_request_id_mismatch' }
  if (result.costObserved !== true || typeof result.costCny !== 'number' || !Number.isFinite(result.costCny) || result.costCny < 0 || !result.costSource) {
    return { ...result, state: 'blocked', detail: 'cost_evidence_missing' }
  }
  if (result.costSource === 'relay_pricing_snapshot' && (!result.pricingVersion || !result.pricingGroup)) {
    return { ...result, state: 'blocked', detail: 'pricing_snapshot_identity_missing' }
  }
  if (result.modality === 'embedding' && result.costSource === 'provider_receipt' && result.costEvidenceKind !== 'provider_reported_actual') return { ...result, state: 'blocked', detail: 'embedding_cost_evidence_kind_mismatch' }
  if (result.modality === 'embedding' && result.costSource === 'relay_pricing_snapshot' && result.costEvidenceKind !== 'pricing_derived_from_observed_usage') return { ...result, state: 'blocked', detail: 'embedding_cost_evidence_kind_mismatch' }
  if (result.modality === 'embedding' && result.costSource === 'relay_pricing_snapshot'
    && !/^[a-f0-9]{64}$/u.test(result.pricingSnapshotSha256 ?? '')) return { ...result, state: 'blocked', detail: 'embedding_pricing_snapshot_missing_or_unbound' }
  return { ...result, state: 'ready' }
}

export function blockHttpProbe(
  common: Pick<ProbeResult, 'modality' | 'endpoint' | 'model'>,
  httpStatus: number,
  providerRequestId?: string,
): ProbeResult {
  return {
    ...common,
    state: 'blocked',
    httpStatus,
    ...(providerRequestId ? { providerRequestId } : {}),
    usageObserved: false,
    costObserved: false,
    detail: `relay returned HTTP ${httpStatus}`,
  }
}

function hasHttpsOutput(value: unknown, depth = 0): boolean {
  if (depth > 2) return false
  if (typeof value === 'string') return isStrictHttpsUrl(value)
  if (Array.isArray(value)) return value.some(item => hasHttpsOutput(item, depth + 1))
  if (!value || typeof value !== 'object') return false
  const output = value as Record<string, unknown>
  return ['result_url', 'video_url', 'output_url', 'url', 'output'].some(key => hasHttpsOutput(output[key], depth + 1))
}

function isStrictHttpsUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value !== value.trim() || !/^https:\/\//iu.test(value)) return false
  const authority = /^https:\/\/([^/?#]*)/iu.exec(value)?.[1]
  if (!authority || authority.includes('@')) return false
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && Boolean(url.hostname) && !url.username && !url.password
  } catch { return false }
}

async function probe(modality: ProbeResult['modality'], budget: CanaryBudget, candidateBinding?: { release_git_sha: string; image_set_digest: string; manifest_sha256: string; deployment_nonce_sha256: string }): Promise<ProbeResult> {
  const model = modelFor(modality)
  const existingVideoTaskId = modality === 'video' ? process.env.MODEL_RELAY_CANARY_VIDEO_TASK_ID?.trim() : undefined
  const endpoint = existingVideoTaskId ? process.env.VIDEO_STATUS_PATH?.trim() || '/video/generations/{job_id}' : endpointFor(modality)
  const common = { modality, endpoint, model }
  if (!model) return { ...common, state: 'blocked', detail: 'model_missing' }
  if (modality === 'embedding' && !ALLOWED_EMBEDDING_MODELS.includes(model as typeof ALLOWED_EMBEDDING_MODELS[number])) return { ...common, state: 'blocked', detail: 'embedding_model_not_allowlisted' }
  if (!keyFor(modality)) return { ...common, state: 'blocked', detail: modality === 'video' ? 'VIDEO_MODEL_RELAY_API_KEY missing' : 'MODEL_RELAY_API_KEY missing' }
  if (shouldBlockForCostGuard({ modality, confirmCost, ...(existingVideoTaskId ? { existingVideoTaskId } : {}) })) return { ...common, state: 'not_run_cost_guard', detail: 'set MODEL_RELAY_CANARY_CONFIRM=true to run potentially billable media probes' }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    assertSafeRelativePath(endpoint)
    await assertRelayUrl(base, relaySecurity ?? {})
    if (modality === 'embedding') {
      const relayUrl = new URL(base)
      if (relayUrl.protocol !== 'https:' || relayUrl.hostname.toLowerCase() !== 'ai.wormholexyz.xyz' || relayUrl.port || relayUrl.username || relayUrl.password || relayUrl.search || relayUrl.hash || !['/v1', '/v1/'].includes(relayUrl.pathname)) throw new Error('embedding relay must use the pinned HTTPS /v1 endpoint')
      if (process.env.EMBEDDING_DIMENSIONS?.trim() !== '1024') throw new Error('embedding dimensions must be 1024')
      if (process.env.EMBEDDING_CANARY_CONFIRM !== 'true') return { ...common, state: 'not_run_cost_guard', detail: 'set EMBEDDING_CANARY_CONFIRM=true to run a billable embedding probe' }
    }
    const embeddingInput = modality === 'embedding'
      ? process.env.EMBEDDING_CANARY_INPUT ?? 'Embedding candidate canary: verify the configured model relay returns one vector with auditable usage and cost.'
      : undefined
    const body = modality === 'text'
      ? { model, temperature: 0, max_tokens: 8, messages: [{ role: 'user', content: '只返回 OK' }] }
      : modality === 'embedding'
        ? { model, input: embeddingInput, encoding_format: 'float', dimensions: 1024 }
      : modality === 'ocr'
        ? { model, temperature: 0, max_tokens: 32, messages: [{ role: 'user', content: [{ type: 'text', text: '只返回 JSON：{"ocr_text":"OK"}' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAFklEQVR4nGP4TyFgGDVg1IBRA4aLAQBdePwur/3haQAAAABJRU5ErkJggg==' } }] }] }
        : modality === 'image'
          ? { model, prompt: '生成一张纯白测试图，只用于中转站连通性验收', n: 1, size: '1024x1024', response_format: 'url' }
          : modality === 'image_edit'
            ? { model, prompt: '对测试素材做最小编辑：保持主体不变', image: ['data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAFklEQVR4nGP4TyFgGDVg1IBRA4aLAQBdePwur/3haQAAAABJRU5ErkJggg=='], image_mode: 'optimize', edit_region: { x: 0, y: 0, width: 1, height: 1 }, n: 1, size: '1024x1024', response_format: 'url' }
            : { model, prompt: videoCanaryPrompt, duration: videoDurationSeconds }
    const usesVideoStatusPath = Boolean(existingVideoTaskId && endpoint.includes('{job_id}'))
    const requestEndpoint = existingVideoTaskId ? endpoint.replace(/\{job_id\}/gu, encodeURIComponent(existingVideoTaskId)) : endpoint
    const videoRequest = modality === 'video' && !existingVideoTaskId
      ? buildVideoProbeRequest({
        model,
        prompt: videoCanaryPrompt,
        durationSeconds: videoDurationSeconds,
        ...(process.env.VIDEO_RESOLUTION?.trim() ? { resolution: process.env.VIDEO_RESOLUTION.trim().toUpperCase() } : {}),
        ...(process.env.VIDEO_REQUEST_FORMAT?.trim() ? { requestFormat: process.env.VIDEO_REQUEST_FORMAT.trim() } : {}),
      })
      : undefined
    if (!existingVideoTaskId) {
      await reserveCanaryCost({
        pricing: pricingClient, budget, modality, model, requestBody: body,
        ...(modality === 'video' ? { durationSeconds: videoDurationSeconds, resolution: process.env.VIDEO_RESOLUTION?.trim().toUpperCase() } : {}),
      })
    }
    const requestBody = !existingVideoTaskId ? videoRequest?.body ?? JSON.stringify(body) : usesVideoStatusPath ? undefined : JSON.stringify({ job_id: existingVideoTaskId })
    if (modality === 'embedding' && typeof requestBody !== 'string') throw new Error('embedding_request_body_missing')
    const idempotencyKey = canaryIdempotencyKey({ releaseId, modality, model, ...(existingVideoTaskId ? { existingVideoTaskId } : {}),
      ...(modality === 'embedding' ? { requestBody: requestBody as string, ...(candidateBinding ? { candidateBinding } : {}) } : {}) })
    let response: Response | undefined
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      response = await fetch(`${base}${requestEndpoint}`, {
        method: existingVideoTaskId ? usesVideoStatusPath ? 'GET' : 'POST' : 'POST',
        headers: {
          accept: 'application/json',
          ...(!videoRequest || videoRequest.contentType ? { 'content-type': videoRequest?.contentType ?? 'application/json' } : {}),
          authorization: `Bearer ${keyFor(modality)}`,
          'x-damai-canary': 'true',
          'x-idempotency-key': idempotencyKey,
        },
        ...(requestBody === undefined ? {} : { body: requestBody }),
        signal: controller.signal,
        redirect: 'error',
      })
      if (!canRetryCanaryResponse(response.status, attempt)) break
      await new Promise<void>((resolveWait, rejectWait) => {
        const retryTimer = setTimeout(resolveWait, canaryRetryDelayMs(response!.headers, attempt))
        controller.signal.addEventListener('abort', () => {
          clearTimeout(retryTimer)
          rejectWait(controller.signal.reason ?? new DOMException('relay canary retry aborted', 'AbortError'))
        }, { once: true })
      })
    }
    if (!response) throw new Error('relay canary produced no response')
    const payload = await readBoundedResponseText(response, 1 * 1024 * 1024, 'model relay response')
      .then(text => JSON.parse(text) as unknown)
      .catch(() => undefined)
    const providerRequestId = extractProviderRequestId(payload, response.headers)
    if (!response.ok) {
      const blocked = blockHttpProbe(common, response.status, providerRequestId)
      if (artifactRoot) {
        blocked.evidence_ref = writeRelayResponseArtifact(artifactRoot, releaseId, modality, {
          status: response.status, headers: response.headers, payload, result: blocked,
          ...(modality === 'embedding' ? { inputText: embeddingInput } : {}),
          ...(candidateBinding ? { candidateBinding } : {}),
        })
      }
      return blocked
    }
    let measured: Awaited<ReturnType<typeof evaluateRelayUsageEvidence>>
    try { measured = await evaluateRelayUsageEvidence(payload, response.headers, modality, model, { resolution: process.env.VIDEO_RESOLUTION?.trim().toUpperCase() }) }
    catch (error) {
      measured = { usageObserved: false, costObserved: false }
      const blocked: ProbeResult = {
        ...common, state: 'blocked', httpStatus: response.status,
        ...(providerRequestId ? { providerRequestId } : {}),
        ...measured,
        detail: 'pricing_evidence_failed',
      }
      if (artifactRoot) {
        blocked.evidence_ref = writeRelayResponseArtifact(artifactRoot, releaseId, modality, {
          status: response.status, headers: response.headers, payload, result: blocked,
          ...(modality === 'embedding' ? { inputText: embeddingInput } : {}),
          ...(candidateBinding ? { candidateBinding } : {}),
        })
      }
      return blocked
    }
    const videoEvaluation = modality === 'video' ? evaluateVideoProbePayload(payload) : undefined
    const embeddingData = modality === 'embedding' && payload && typeof payload === 'object' && Array.isArray((payload as Record<string, unknown>).data)
      ? (payload as { data: unknown[] }).data : undefined
    const embeddingVector = embeddingData?.length === 1 && embeddingData[0] && typeof embeddingData[0] === 'object' && Array.isArray((embeddingData[0] as Record<string, unknown>).embedding)
      ? (embeddingData[0] as { embedding: unknown[] }).embedding : undefined
    const validEmbeddingVector = embeddingVector?.length === 1024 && embeddingVector.every(value => typeof value === 'number' && Number.isFinite(value))
    const valid = modality === 'text' || modality === 'ocr'
      ? Boolean(payload && typeof payload === 'object' && Array.isArray((payload as Record<string, unknown>).choices))
      : modality === 'embedding'
        ? validEmbeddingVector === true && embeddingResponseMatchesModel(payload, model)
      : modality === 'video'
        ? videoEvaluation?.ready === true
        : Boolean(payload && typeof payload === 'object' && Array.isArray((payload as Record<string, unknown>).data))
    const finalized = finalizeSuccessfulProbe({
      ...common,
      httpStatus: response.status,
      ...(modality === 'embedding' ? { dimensions: validEmbeddingVector ? 1024 : undefined } : {}),
      ...(providerRequestId ? { providerRequestId } : {}),
      ...(videoEvaluation?.providerJobId ? { providerJobId: videoEvaluation.providerJobId } : {}),
      ...measured,
      responseValid: valid,
      ...(valid ? {} : { responseFailure: videoEvaluation?.reason ?? 'response_shape_incompatible' }),
    })
    // A successful transport can still be blocked by an async/payload/usage
    // contract. Preserve the real response for ordinary modalities; embedding
    // artifacts are intentionally reduced to candidate-bound hashes and shape.
    if (artifactRoot) {
      finalized.evidence_ref = writeRelayResponseArtifact(artifactRoot, releaseId, modality, {
        status: response.status, headers: response.headers, payload, result: finalized,
        ...(modality === 'embedding' ? { inputText: embeddingInput } : {}),
        ...(candidateBinding ? { candidateBinding } : {}),
      })
    }
    return finalized
  } catch (error) {
    return { ...common, state: 'blocked', detail: error instanceof Error && error.name === 'AbortError' ? 'timeout' : 'probe_failed' }
  } finally { clearTimeout(timer) }
}

export async function main() {
  if (process.argv.includes('--probe')) {
    const results: ProbeResult[] = []
    const embeddingEnabled = process.argv.includes('--embedding-enabled')
    const embeddingModelArgIndex = process.argv.indexOf('--embedding-model')
    const expectedEmbeddingModel = embeddingModelArgIndex >= 0 ? process.argv[embeddingModelArgIndex + 1]?.trim() : undefined
    const modalitiesArg = process.argv.find((argument) => argument.startsWith('--modalities='))
    const requestedModalities = modalitiesArg
      ? modalitiesArg.slice('--modalities='.length).split(',').map(value => value.trim()).filter(Boolean)
      : ['text', 'image', 'image_edit', 'ocr', 'video', ...(embeddingEnabled ? ['embedding'] : [])]
    const modalities = requestedModalities.filter((modality): modality is ProbeResult['modality'] => ['text', 'image', 'image_edit', 'ocr', 'video', 'embedding'].includes(modality))
    if (modalities.length !== requestedModalities.length || modalities.length === 0) {
      console.error(JSON.stringify({ state: 'blocked', reason: 'modalities must be a non-empty comma-separated subset of text,image,image_edit,ocr,video,embedding' }))
      process.exitCode = 2
      return
    }
    if (modalities.includes('embedding') !== embeddingEnabled) {
      console.error(JSON.stringify({ state: 'blocked', reason: 'embedding modality and --embedding-enabled must be selected together' }))
      process.exitCode = 2
      return
    }
    if (!base || (!key && !videoKey)) {
      console.error(JSON.stringify({ state: 'blocked', reason: !base ? 'MODEL_RELAY_BASE_URL missing' : 'MODEL_RELAY_API_KEY and VIDEO_MODEL_RELAY_API_KEY missing' }))
      process.exitCode = 1
    } else {
      try {
        requireProductionReleaseBinding({ environment: process.env.NODE_ENV, releaseId })
        const candidateBinding = process.env.NODE_ENV?.trim() === 'production' ? requireProductionCandidateBinding() : undefined
        requireEmbeddingProbePreflight({ enabled: embeddingEnabled, baseUrl: base, model: process.env.EMBEDDING_MODEL?.trim() ?? '', expectedModel: expectedEmbeddingModel,
          dimensions: process.env.EMBEDDING_DIMENSIONS?.trim(), confirmCost, confirmEmbedding: process.env.EMBEDDING_CANARY_CONFIRM === 'true' })
        if (!relaySecurity) throw new Error('MODEL_RELAY_BASE_URL/ALLOWED_HOSTS 不满足 relay 安全配置')
        if (process.env.NODE_ENV?.trim() === 'production' && !artifactRoot) throw new Error('MODEL_RELAY_ARTIFACT_ROOT is required before production relay requests')
        await assertRelayUrl(base, relaySecurity)
        const budget = requireCanaryBudget(process.env.MODEL_RELAY_CANARY_MAX_TOTAL_CNY)
        const credentials: Array<{ credential: RelayTokenQuota['credential']; apiKey: string }> = modalities.some(modality => modality !== 'video')
          ? [{ credential: 'model' as const, apiKey: key }]
          : []
        if (modalities.includes('video')) credentials.push({ credential: 'video', apiKey: videoKey })
        const tokenQuota = await Promise.all(credentials.map(async credential => {
          const quota = await requireFiniteRelayTokenQuota({ baseUrl: base, ...credential })
          return artifactRoot ? { ...quota, evidence_ref: writeRelayTokenQuotaArtifact(artifactRoot, releaseId, quota) } : quota
        }))
        for (const modality of modalities) results.push(await probe(modality, budget, candidateBinding))
        // The evidence contract stores the relay origin; each result carries its
        // endpoint path. This keeps /v1 configuration paths out of the origin
        // field and makes generated evidence compatible with its validator.
        const relayOrigin = new URL(base).origin
        const generatedAt = new Date()
        const ttlSeconds = resolveBoundedInteger(process.env.MODEL_RELAY_EVIDENCE_TTL_SECONDS, 24 * 60 * 60, 60, 7 * 24 * 60 * 60, 'MODEL_RELAY_EVIDENCE_TTL_SECONDS')
        const errorRecovery = readRelayErrorRecovery(process.env.MODEL_RELAY_ERROR_RECOVERY_PATH)
        const evidence = {
          schema_version: '1', release_id: releaseId, generated_at: generatedAt.toISOString(),
          ...(candidateBinding ?? {}),
          expires_at: new Date(generatedAt.getTime() + ttlSeconds * 1000).toISOString(),
          environment: process.env.NODE_ENV?.trim() || '', simulated: false, relay: relayOrigin, token_quota: tokenQuota, results,
          ...(errorRecovery ? { error_recovery: errorRecovery } : {}),
        }
        const evidencePath = process.env.MODEL_RELAY_EVIDENCE_PATH?.trim()
        const persisted = persistRelayCanaryEvidence({ path: evidencePath, environment: process.env.NODE_ENV, modalities, evidence, artifactRoot,
          requireEmbedding: embeddingEnabled, ...(embeddingEnabled ? { expectedEmbeddingModel } : {}),
          ...(candidateBinding ? { expectedCandidate: { releaseGitSha: candidateBinding.release_git_sha, imageSetDigest: candidateBinding.image_set_digest, manifestSha256: candidateBinding.manifest_sha256, deploymentNonce: process.env.DEPLOYMENT_NONCE?.trim() } } : {}) })
        console.log(JSON.stringify(persisted.evidence, null, 2))
        if (persisted.exitCode !== 0) process.exitCode = persisted.exitCode
        if (results.some(result => result.state !== 'ready' || result.providerRequestId === undefined || result.usageObserved !== true || result.costObserved !== true)) process.exitCode = 1
        if (process.env.NODE_ENV?.trim() === 'production' && (!artifactRoot || results.some(result => !result.evidence_ref))) process.exitCode = 1
        if (process.env.NODE_ENV?.trim() === 'production' && !errorRecovery) process.exitCode = 1
      } catch (error) {
        console.error(JSON.stringify({ state: 'blocked', reason: relayProbeFailureReason(error) }))
        process.exitCode = 1
      }
    }
  } else {
    console.error('使用 --probe 才会发起真实中转请求；可用 --modalities=text,ocr 分阶段探测；媒体请求还需要 MODEL_RELAY_CANARY_CONFIRM=true。')
    process.exitCode = 2
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) void main()
