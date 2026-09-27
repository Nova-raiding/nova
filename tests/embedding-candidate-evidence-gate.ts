import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

export type EmbeddingCandidateEvidence = {
  schema_version: '1'
  evidence_scope: 'candidate_embedding_canary_review_only'
  production_evidence: false
  release_id: string
  release_git_sha: string
  image_set_digest: string
  manifest_sha256: string
  deployment_nonce_sha256: string
  generated_at: string
  relay_origin: 'https://ai.wormholexyz.xyz'
  endpoint: string
  model: string
  http_status: number
  provider_request_id: string
  usage: { input_tokens: number; output_tokens?: number; total_tokens?: number }
  cost: { currency: 'CNY'; actual: number; source: 'provider_receipt' | 'relay_pricing_snapshot'; pricing_version?: string; pricing_group?: string; formula_version?: string; pricing_snapshot_sha256?: string }
  embedding_response: { input_sha256: string; embedding_sha256: string; data_count: 1; dimensions: 1024 }
}

export type ExpectedEmbeddingCandidate = {
  releaseId: string
  releaseGitSha: string
  imageSetDigest: string
  manifestSha256: string
  deploymentNonce: string
}

const sha = /^[a-f0-9]{64}$/u
const gitSha = /^[a-f0-9]{40}$/u
const releaseIdPattern = /^release-[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/u
const isoInstant = (value: unknown): value is string => typeof value === 'string'
  && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value)
  && !Number.isNaN(Date.parse(value))
const safeProviderId = (value: unknown): value is string => typeof value === 'string'
  && value.trim() === value && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(value)
const exactKeys = (value: unknown, keys: readonly string[]) => !!value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join('\0') === [...keys].sort().join('\0')
const hash = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex')

export function validateEmbeddingCandidateEvidence(document: unknown, expected: ExpectedEmbeddingCandidate): string[] {
  const errors: string[] = []
  if (!exactKeys(document, ['schema_version', 'evidence_scope', 'production_evidence', 'release_id', 'release_git_sha', 'image_set_digest', 'manifest_sha256', 'deployment_nonce_sha256', 'generated_at', 'relay_origin', 'endpoint', 'model', 'http_status', 'provider_request_id', 'usage', 'cost', 'embedding_response'])) return ['evidence has unknown or missing top-level fields']
  const value = document as EmbeddingCandidateEvidence
  if (value.schema_version !== '1') errors.push('schema_version must be 1')
  if (value.evidence_scope !== 'candidate_embedding_canary_review_only' || value.production_evidence !== false) errors.push('embedding canary evidence must remain review-only and non-production evidence')
  if (!releaseIdPattern.test(value.release_id) || value.release_id !== expected.releaseId) errors.push('release_id must match expected candidate')
  if (!gitSha.test(value.release_git_sha) || value.release_git_sha !== expected.releaseGitSha) errors.push('release_git_sha must match expected candidate')
  if (!/^sha256:[a-f0-9]{64}$/u.test(value.image_set_digest) || value.image_set_digest !== expected.imageSetDigest) errors.push('image_set_digest must match expected candidate')
  if (!sha.test(value.manifest_sha256) || value.manifest_sha256 !== expected.manifestSha256) errors.push('manifest_sha256 must match expected candidate')
  if (!sha.test(value.deployment_nonce_sha256) || value.deployment_nonce_sha256 !== hash(expected.deploymentNonce)) errors.push('deployment_nonce_sha256 must match expected deployment nonce')
  if (!isoInstant(value.generated_at)) errors.push('generated_at must be a canonical UTC instant')
  if (value.relay_origin !== 'https://ai.wormholexyz.xyz') errors.push('relay_origin must be the pinned HTTPS relay origin')
  if (value.endpoint !== '/v1/embeddings') errors.push('endpoint must be the pinned /v1/embeddings path')
  if (value.model !== 'qwen3.7-text-embedding-flash' && value.model !== 'qwen3.7-text-embedding') errors.push('model must be one of the approved Qwen embedding models')
  if (!Number.isSafeInteger(value.http_status) || value.http_status < 200 || value.http_status > 299) errors.push('http_status must be successful')
  if (!safeProviderId(value.provider_request_id)) errors.push('provider_request_id is required')
  if (!exactKeys(value.usage, ['input_tokens', ...(value.usage && 'output_tokens' in value.usage ? ['output_tokens'] : []), ...(value.usage && 'total_tokens' in value.usage ? ['total_tokens'] : [])])) errors.push('usage has unknown or missing fields')
  if (!Number.isSafeInteger(value.usage?.input_tokens) || value.usage.input_tokens <= 0) errors.push('usage.input_tokens must be a positive observed integer')
  if (value.usage?.output_tokens !== undefined && (!Number.isSafeInteger(value.usage.output_tokens) || value.usage.output_tokens !== 0)) errors.push('embedding output_tokens must be zero when reported')
  if (value.usage?.total_tokens !== undefined && (!Number.isSafeInteger(value.usage.total_tokens) || value.usage.total_tokens !== value.usage.input_tokens)) errors.push('usage.total_tokens must equal observed embedding input tokens')
  if (!value.cost || typeof value.cost !== 'object' || value.cost.currency !== 'CNY' || typeof value.cost.actual !== 'number' || !Number.isFinite(value.cost.actual) || value.cost.actual < 0) errors.push('cost must be observed non-negative CNY')
  if (value.cost?.source === 'provider_receipt') {
    if (Object.keys(value.cost).some(key => !['currency', 'actual', 'source'].includes(key))) errors.push('provider receipt cost contains unsupported pricing fields')
  } else if (value.cost?.source === 'relay_pricing_snapshot') {
    if (!value.cost.pricing_version?.trim() || !value.cost.pricing_group?.trim() || !value.cost.formula_version?.trim() || !sha.test(value.cost.pricing_snapshot_sha256 ?? '')) errors.push('settlement pricing snapshot identity and digest are required')
  } else errors.push('cost.source must be provider_receipt or relay_pricing_snapshot')
  if (!exactKeys(value.embedding_response, ['input_sha256', 'embedding_sha256', 'data_count', 'dimensions'])) errors.push('embedding_response must contain only redacted hashes and shape')
  if (!sha.test(value.embedding_response?.input_sha256 ?? '') || !sha.test(value.embedding_response?.embedding_sha256 ?? '')) errors.push('embedding input/vector hashes must be SHA-256')
  if (value.embedding_response?.data_count !== 1 || value.embedding_response?.dimensions !== 1024) errors.push('provider response must contain exactly one 1024-dimensional embedding')
  return errors
}

export function parseExpectedEmbeddingCandidate(args: string[], env: Record<string, string | undefined> = process.env): ExpectedEmbeddingCandidate {
  const get = (flag: string, variable: string) => {
    const index = args.indexOf(flag)
    const value = index >= 0 ? args[index + 1] : env[variable]
    if (!value?.trim()) throw new Error(`${flag} or ${variable} is required`)
    return value.trim()
  }
  const deploymentNonce = get('--deployment-nonce', 'DEPLOYMENT_NONCE')
  return {
    releaseId: get('--release-id', 'RELEASE_ID'),
    releaseGitSha: get('--release-git-sha', 'RELEASE_GIT_SHA'),
    imageSetDigest: get('--image-set-digest', 'RELEASE_IMAGE_SET_DIGEST'),
    manifestSha256: get('--manifest-sha256', 'RELEASE_MANIFEST_SHA256'),
    deploymentNonce,
  }
}

function main() {
  const args = process.argv.slice(2)
  const fileIndex = args.indexOf('--file')
  const file = fileIndex >= 0 ? args[fileIndex + 1] : undefined
  if (!file) { console.error('--file is required'); process.exit(2) }
  try {
    const document = JSON.parse(readFileSync(file, 'utf8')) as unknown
    const errors = validateEmbeddingCandidateEvidence(document, parseExpectedEmbeddingCandidate(args))
    if (errors.length) { console.error(errors.join('\n')); process.exit(1) }
    console.log('candidate embedding canary evidence verified (review-only; not production release evidence)')
  } catch (error) {
    const message = error instanceof Error ? error.message : 'invalid evidence'
    console.error(message.includes('required') ? message : 'candidate embedding evidence could not be verified')
    process.exit(1)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main()
