import { createHash } from 'node:crypto'
import { closeSync, constants, fsyncSync, ftruncateSync, lstatSync, openSync, realpathSync, writeSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { OpenAICompatibleEmbeddingClient } from '../packages/ai/src/embedding.js'
import { providerIdempotencyKey } from '../packages/ai/src/provider-request.js'
import { createRelayPricingClientFromEnv } from '../packages/ai/src/relay-pricing.js'
import { relaySecurityFromEnv, type RelaySecurityPolicy } from '../packages/ai/src/relay-security.js'
import type { RelayUsageRecord } from '../packages/ai/src/relay-usage.js'
import { parseExpectedEmbeddingCandidate, validateEmbeddingCandidateEvidence, type EmbeddingCandidateEvidence, type ExpectedEmbeddingCandidate } from '../tests/embedding-candidate-evidence-gate.js'
import { ALLOWED_EMBEDDING_MODELS } from '../tests/model-relay-evidence-gate.js'
import { readBoundedResponseText } from '../packages/connectors/src/bounded-response.js'
import { requireFiniteRelayTokenQuota } from './model-relay-canary.js'

export const PINNED_EMBEDDING_RELAY_ORIGIN = 'https://ai.wormholexyz.xyz' as const
const DEFAULT_CANARY_INPUT = 'Embedding candidate canary: verify the configured model relay returns one vector with auditable usage and cost.'
const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex')
const candidateActionId = (expected: ExpectedEmbeddingCandidate) => `embedding.canary.${expected.releaseGitSha}.${sha256(expected.deploymentNonce)}`
const candidateIdempotencyKey = (config: ReturnType<typeof validateCandidateEmbeddingConfig>, expected: ExpectedEmbeddingCandidate) => providerIdempotencyKey({
  operation: 'embedding', model: config.model, workspaceId: 'release-candidate', actionId: candidateActionId(expected),
  requestBody: JSON.stringify({ model: config.model, input: [config.input], encoding_format: 'float', dimensions: 1024 }),
})

type CapturedCost = EmbeddingCandidateEvidence['cost']
type EmbeddingProbe = { embedding: number[]; model: string; dimensions: number; httpStatus: number; endpoint: string; usage: RelayUsageRecord; cost: CapturedCost }
type PricingClient = NonNullable<ReturnType<typeof createRelayPricingClientFromEnv>>

export function validateCandidateEmbeddingConfig(source: Record<string, string | undefined>): {
  baseUrl: string; apiKey: string; model: string; input: string; relaySecurity: RelaySecurityPolicy; budgetCny: number; outputPath: string
} {
  const baseUrl = source.MODEL_RELAY_BASE_URL?.trim() ?? ''
  const apiKey = source.MODEL_RELAY_API_KEY?.trim() ?? ''
  const model = source.EMBEDDING_MODEL?.trim() ?? ''
  const input = source.EMBEDDING_CANARY_INPUT ?? DEFAULT_CANARY_INPUT
  const outputPath = source.EMBEDDING_CANARY_OUTPUT_PATH?.trim() ?? ''
  const budgetText = source.MODEL_RELAY_CANARY_MAX_TOTAL_CNY?.trim() ?? ''
  let url: URL
  try { url = new URL(baseUrl) } catch { throw new Error('embedding relay URL is invalid') }
  if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'ai.wormholexyz.xyz' || url.port || url.username || url.password || url.search || url.hash) throw new Error('embedding relay must use the pinned HTTPS origin')
  if (!['/v1', '/v1/'].includes(url.pathname)) throw new Error('embedding relay base path must be exactly /v1')
  if (!apiKey) throw new Error('embedding relay API key is required')
  if (!ALLOWED_EMBEDDING_MODELS.includes(model as typeof ALLOWED_EMBEDDING_MODELS[number])) throw new Error(`embedding model must be one of: ${ALLOWED_EMBEDDING_MODELS.join(', ')}`)
  if (source.EMBEDDING_DIMENSIONS?.trim() !== '1024') throw new Error('EMBEDDING_DIMENSIONS must equal 1024')
  if (!input.trim() || input.length > 2048) throw new Error('embedding canary input must be non-empty and at most 2048 characters')
  const budgetCny = /^\d+(?:\.\d{1,6})?$/u.test(budgetText) ? Number(budgetText) : NaN
  if (!Number.isFinite(budgetCny) || budgetCny <= 0) throw new Error('MODEL_RELAY_CANARY_MAX_TOTAL_CNY must be an explicit positive CNY budget')
  if (source.EMBEDDING_CANARY_CONFIRM !== 'true') throw new Error('EMBEDDING_CANARY_CONFIRM=true is required before a billable request')
  if (!outputPath || !outputPath.startsWith('/') || resolve(outputPath) !== outputPath) throw new Error('EMBEDDING_CANARY_OUTPUT_PATH must be an absolute canonical path')
  const relaySecurity = relaySecurityFromEnv(source)
  if (!relaySecurity || !relaySecurity.allowedHosts?.some(host => host.toLowerCase() === 'ai.wormholexyz.xyz')) throw new Error('MODEL_RELAY_ALLOWED_HOSTS must explicitly allow ai.wormholexyz.xyz')
  return { baseUrl: url.toString().replace(/\/$/u, ''), apiKey, model, input, relaySecurity, budgetCny, outputPath }
}

export async function runEmbeddingCandidateProbe(input: {
  expected: ExpectedEmbeddingCandidate
  model: string
  prompt: string
  provider: (input: { prompt: string; expected: ExpectedEmbeddingCandidate }) => Promise<EmbeddingProbe>
  now?: Date
  maxCostCny: number
}): Promise<EmbeddingCandidateEvidence> {
  if (!Number.isFinite(input.maxCostCny) || input.maxCostCny <= 0) throw new Error('a positive canary cost budget is required')
  const probe = await input.provider({ prompt: input.prompt, expected: input.expected })
  if (probe.httpStatus < 200 || probe.httpStatus > 299) throw new Error('embedding relay returned a non-success status')
  if (probe.model !== input.model || probe.dimensions !== 1024 || probe.embedding.length !== 1024 || probe.embedding.some(value => !Number.isFinite(value))) throw new Error('embedding provider response must contain one finite 1024-dimensional vector')
  if (probe.usage.modality !== 'embedding' || probe.usage.model !== input.model || !probe.usage.providerRequestId || probe.usage.metadata?.usage_observed !== true) throw new Error('embedding provider request identity or observed usage is missing')
  if (!Number.isSafeInteger(probe.usage.inputTokens) || (probe.usage.inputTokens ?? 0) <= 0) throw new Error('embedding input token usage is missing')
  if (probe.usage.outputTokens !== undefined && probe.usage.outputTokens !== 0) throw new Error('embedding output token usage must be zero')
  if (probe.usage.totalTokens !== undefined && probe.usage.totalTokens !== probe.usage.inputTokens) throw new Error('embedding total token usage is inconsistent')
  if (!Number.isFinite(probe.cost.actual) || probe.cost.actual < 0 || probe.cost.actual > input.maxCostCny) throw new Error('observed embedding cost is missing or exceeds the canary budget')
  const nonceHash = sha256(input.expected.deploymentNonce)
  const evidence: EmbeddingCandidateEvidence = {
    schema_version: '1', evidence_scope: 'candidate_embedding_canary_review_only', production_evidence: false,
    release_id: input.expected.releaseId, release_git_sha: input.expected.releaseGitSha,
    image_set_digest: input.expected.imageSetDigest, manifest_sha256: input.expected.manifestSha256,
    deployment_nonce_sha256: nonceHash, generated_at: (input.now ?? new Date()).toISOString(),
    relay_origin: PINNED_EMBEDDING_RELAY_ORIGIN,
    endpoint: probe.endpoint,
    model: input.model, http_status: probe.httpStatus, provider_request_id: probe.usage.providerRequestId,
    usage: { input_tokens: probe.usage.inputTokens!, ...(probe.usage.outputTokens !== undefined ? { output_tokens: probe.usage.outputTokens } : {}), ...(probe.usage.totalTokens !== undefined ? { total_tokens: probe.usage.totalTokens } : {}) },
    cost: probe.cost,
    embedding_response: { input_sha256: sha256(input.prompt), embedding_sha256: sha256(JSON.stringify(probe.embedding)), data_count: 1, dimensions: 1024 },
  }
  const errors = validateEmbeddingCandidateEvidence(evidence, input.expected)
  if (errors.length) throw new Error(`candidate embedding evidence is invalid: ${errors.join('; ')}`)
  return evidence
}

function reservePrivateEvidenceSlot(path: string): number {
  const parent = dirname(path)
  const parentStat = lstatSync(parent)
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink() || realpathSync(parent) !== parent
    || (parentStat.mode & 0o077) !== 0 || (typeof process.getuid === 'function' && parentStat.uid !== process.getuid())) {
    throw new Error('embedding evidence output parent must be canonical, private, and owned by the current user')
  }
  const descriptor = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try {
    const directory = openSync(parent, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    try { fsyncSync(directory) } finally { closeSync(directory) }
    return descriptor
  } catch (error) {
    closeSync(descriptor)
    throw error
  }
}

function writeReservedEvidence(descriptor: number, value: unknown): void {
  const contents = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
  let offset = 0
  while (offset < contents.length) offset += writeSync(descriptor, contents, offset, contents.length - offset, offset)
  ftruncateSync(descriptor, contents.length)
  fsyncSync(descriptor)
}

export async function runEmbeddingCandidateProbeToPrivateFile(input: {
  config: ReturnType<typeof validateCandidateEmbeddingConfig>
  expected: ExpectedEmbeddingCandidate
  provider: (input: { prompt: string; expected: ExpectedEmbeddingCandidate }) => Promise<EmbeddingProbe>
}): Promise<EmbeddingCandidateEvidence> {
  // A paid request cannot start until its private evidence slot exists.
  const descriptor = reservePrivateEvidenceSlot(input.config.outputPath)
  const identity = {
    evidence_scope: 'candidate_embedding_canary_review_only', production_evidence: false,
    release_id: input.expected.releaseId, release_git_sha: input.expected.releaseGitSha,
    image_set_digest: input.expected.imageSetDigest, manifest_sha256: input.expected.manifestSha256,
    deployment_nonce_sha256: sha256(input.expected.deploymentNonce),
    input_sha256: sha256(input.config.input),
    provider_idempotency_key: candidateIdempotencyKey(input.config, input.expected),
  } as const
  try {
    writeReservedEvidence(descriptor, { ...identity, state: 'pending_review_only', recorded_at: new Date().toISOString() })
    try {
      const evidence = await runEmbeddingCandidateProbe({
        expected: input.expected, model: input.config.model, prompt: input.config.input,
        maxCostCny: input.config.budgetCny, provider: input.provider,
      })
      writeReservedEvidence(descriptor, evidence)
      return evidence
    } catch {
      // Lower-layer errors may contain URLs, headers, or credentials.
      writeReservedEvidence(descriptor, { ...identity, state: 'failed_review_only', failure_category: 'embedding_probe_failed', recorded_at: new Date().toISOString(), reconciliation_required: true })
      throw new Error('embedding probe failed; inspect protected review-only failure receipt')
    }
  } finally { closeSync(descriptor) }
}

export async function runConfiguredEmbeddingCandidateCanary(input: {
  source: Record<string, string | undefined>
  expected: ExpectedEmbeddingCandidate
  provider: (config: ReturnType<typeof validateCandidateEmbeddingConfig>, probe: { prompt: string; expected: ExpectedEmbeddingCandidate }) => Promise<EmbeddingProbe>
}): Promise<{ evidence: EmbeddingCandidateEvidence; outputPath: string }> {
  const config = validateCandidateEmbeddingConfig(input.source)
  const evidence = await runEmbeddingCandidateProbeToPrivateFile({
    config, expected: input.expected, provider: probe => input.provider(config, probe),
  })
  return { evidence, outputPath: config.outputPath }
}

async function providerProbe(input: { config: ReturnType<typeof validateCandidateEmbeddingConfig>; source: Record<string, string | undefined>; expected: ExpectedEmbeddingCandidate; budgetCny: number }): Promise<EmbeddingProbe> {
  await requireFiniteRelayTokenQuota({ baseUrl: input.config.baseUrl, apiKey: input.config.apiKey, credential: 'model' })
  const responseProof: { status?: number } = {}
  const usageProof: { usage?: RelayUsageRecord; cost?: CapturedCost } = {}
  const pricingResponseDigests: Record<string, string> = {}
  const pricingFetcher: typeof fetch = async (resource, init) => {
    const response = await fetch(resource, init)
    const url = new URL(typeof resource === 'string' ? resource : resource instanceof URL ? resource.href : resource.url)
    if (url.origin === PINNED_EMBEDDING_RELAY_ORIGIN && (url.pathname === '/api/pricing' || url.pathname === '/api/status')) {
      const text = await readBoundedResponseText(response.clone(), url.pathname === '/api/status' ? 16 * 1024 : 2 * 1024 * 1024, 'relay pricing snapshot')
      pricingResponseDigests[url.pathname] = sha256(text)
    }
    return response
  }
  const pricing: PricingClient | undefined = createRelayPricingClientFromEnv(input.source, pricingFetcher)
  if (!pricing) throw new Error('authenticated relay pricing snapshot is required to reserve canary cost')
  const inputTokenUpperBound = Buffer.byteLength(input.config.input, 'utf8')
  const reservation = await pricing.estimateRequestCost({ modality: 'embedding', model: input.config.model, observedAt: new Date().toISOString(), inputTokens: inputTokenUpperBound, outputTokens: 0 })
  if (!reservation.metadata.pricing_version || !reservation.metadata.pricing_group || !Number.isFinite(reservation.costCny) || reservation.costCny <= 0) throw new Error('relay embedding price is missing or zero')
  const worstCaseCny = Math.ceil(reservation.costCny * 3 * 1_000_000) / 1_000_000
  if (!Number.isFinite(worstCaseCny) || worstCaseCny > input.budgetCny) throw new Error('embedding request exceeds MODEL_RELAY_CANARY_MAX_TOTAL_CNY')

  const client = new OpenAICompatibleEmbeddingClient({
    baseUrl: input.config.baseUrl, apiKey: input.config.apiKey, model: input.config.model, dimensions: 1024,
    timeoutMs: 90_000, relaySecurity: input.config.relaySecurity,
    fetch: async (resource, init) => {
      const response = await fetch(resource, init)
      responseProof.status = response.status
      return response
    },
    usageSink: async record => {
      usageProof.usage = record
      if (record.costCny !== undefined) {
        usageProof.cost = { currency: 'CNY', actual: record.costCny, source: 'provider_receipt', evidence_kind: 'provider_reported_actual' }
      } else {
        const quote = await pricing.quote(record)
        if (!pricingResponseDigests['/api/pricing'] || !pricingResponseDigests['/api/status']) throw new Error('relay pricing snapshot bytes were not observed')
        const snapshotDigest = sha256(JSON.stringify({ pricing: pricingResponseDigests['/api/pricing'], status: pricingResponseDigests['/api/status'] }))
        usageProof.cost = { currency: 'CNY', actual: quote.costCny, source: 'relay_pricing_snapshot', evidence_kind: 'pricing_derived_from_observed_usage', pricing_version: quote.metadata.pricing_version, pricing_group: quote.metadata.pricing_group, formula_version: quote.metadata.formula_version, pricing_snapshot_sha256: snapshotDigest }
      }
      return { recorded: true, costEvidence: true }
    },
  })
  const embedding = await client.embed({ texts: [input.config.input], usageContext: { workspaceId: 'release-candidate', actionId: candidateActionId(input.expected) } })
  const usage = usageProof.usage
  const cost = usageProof.cost
  if (!usage || !cost || responseProof.status === undefined) throw new Error('provider response, usage or cost evidence was not captured')
  return { embedding: embedding.embeddings[0] ?? [], model: embedding.model, dimensions: embedding.dimensions, httpStatus: responseProof.status, endpoint: `${new URL(input.config.baseUrl).pathname.replace(/\/$/u, '')}/embeddings`, usage, cost }
}

async function main() {
  const source = process.env
  if (source.EMBEDDING_CANARY_CONFIRM !== 'true') throw new Error('EMBEDDING_CANARY_CONFIRM=true is required before a billable request')
  const expected = parseExpectedEmbeddingCandidate(process.argv.slice(2), source)
  const { evidence, outputPath } = await runConfiguredEmbeddingCandidateCanary({
    source, expected, provider: config => providerProbe({ config, source, expected, budgetCny: config.budgetCny }),
  })
  console.log(JSON.stringify({ state: 'verified_review_only', release_id: evidence.release_id, model: evidence.model, provider_request_id: evidence.provider_request_id, input_sha256: evidence.embedding_response.input_sha256, embedding_sha256: evidence.embedding_response.embedding_sha256, evidence_path: outputPath, production_evidence: false }))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    console.error('candidate embedding canary failed; inspect protected review-only receipt if an output slot was reserved')
    process.exitCode = 1
  })
}
