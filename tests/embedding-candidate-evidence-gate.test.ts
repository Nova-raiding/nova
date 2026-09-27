import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { validateEmbeddingCandidateEvidence, type EmbeddingCandidateEvidence, type ExpectedEmbeddingCandidate } from './embedding-candidate-evidence-gate.js'

const expected: ExpectedEmbeddingCandidate = {
  releaseId: 'release-embed-review', releaseGitSha: 'a'.repeat(40), imageSetDigest: `sha256:${'b'.repeat(64)}`,
  manifestSha256: 'c'.repeat(64), deploymentNonce: 'candidate-nonce-test',
}
const sha = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex')
const evidence: EmbeddingCandidateEvidence = {
  schema_version: '1', evidence_scope: 'candidate_embedding_canary_review_only', production_evidence: false,
  release_id: expected.releaseId, release_git_sha: expected.releaseGitSha, image_set_digest: expected.imageSetDigest,
  manifest_sha256: expected.manifestSha256, deployment_nonce_sha256: sha(expected.deploymentNonce),
  generated_at: '2026-09-27T00:00:00.000Z', relay_origin: 'https://ai.wormholexyz.xyz', endpoint: '/v1/embeddings',
  model: 'qwen3.7-text-embedding-flash', http_status: 200, provider_request_id: 'req-safe-id',
  usage: { input_tokens: 42, output_tokens: 0, total_tokens: 42 },
  cost: { currency: 'CNY', actual: 0.0001, source: 'provider_receipt' },
  embedding_response: { input_sha256: 'd'.repeat(64), embedding_sha256: 'e'.repeat(64), data_count: 1, dimensions: 1024 },
}

describe('embedding candidate evidence gate', () => {
  it('accepts correctly bound review-only evidence with provider-reported CNY cost', () => {
    expect(validateEmbeddingCandidateEvidence(evidence, expected)).toEqual([])
  })

  it('accepts actual pricing snapshot provenance and rejects estimate-shaped costs', () => {
    const snapshot: EmbeddingCandidateEvidence = { ...evidence, cost: { currency: 'CNY', actual: 0.0002, source: 'relay_pricing_snapshot', pricing_version: 'v1', pricing_group: 'default', formula_version: 'new-api-quota-v1', pricing_snapshot_sha256: 'f'.repeat(64) } }
    expect(validateEmbeddingCandidateEvidence(snapshot, expected)).toEqual([])
    const estimate = { ...snapshot, cost: { ...snapshot.cost, source: 'relay_pricing_snapshot_estimate' } }
    expect(validateEmbeddingCandidateEvidence(estimate, expected)).toContain('cost.source must be provider_receipt or relay_pricing_snapshot')
  })

  it('rejects a wrong candidate nonce/image/manifest, missing metering/request ID, and raw prompt/vector fields', () => {
    expect(validateEmbeddingCandidateEvidence({ ...evidence, deployment_nonce_sha256: '0'.repeat(64) }, expected)).toContain('deployment_nonce_sha256 must match expected deployment nonce')
    expect(validateEmbeddingCandidateEvidence({ ...evidence, image_set_digest: `sha256:${'0'.repeat(64)}` }, expected)).toContain('image_set_digest must match expected candidate')
    expect(validateEmbeddingCandidateEvidence({ ...evidence, manifest_sha256: '0'.repeat(64) }, expected)).toContain('manifest_sha256 must match expected candidate')
    expect(validateEmbeddingCandidateEvidence({ ...evidence, provider_request_id: '' }, expected)).toContain('provider_request_id is required')
    expect(validateEmbeddingCandidateEvidence({ ...evidence, usage: { input_tokens: 0 } }, expected)).toContain('usage.input_tokens must be a positive observed integer')
    expect(validateEmbeddingCandidateEvidence({ ...evidence, prompt: 'must not be persisted' }, expected)).toContain('evidence has unknown or missing top-level fields')
    expect(validateEmbeddingCandidateEvidence({ ...evidence, embedding_response: { ...evidence.embedding_response, vector: [0.1] } }, expected)).toContain('embedding_response must contain only redacted hashes and shape')
  })

  it('does not allow this probe to be represented as production-ready evidence', () => {
    expect(validateEmbeddingCandidateEvidence({ ...evidence, production_evidence: true }, expected)).toContain('embedding canary evidence must remain review-only and non-production evidence')
    expect(validateEmbeddingCandidateEvidence({ ...evidence, relay_origin: 'https://other.example' }, expected)).toContain('relay_origin must be the pinned HTTPS relay origin')
    expect(validateEmbeddingCandidateEvidence({ ...evidence, embedding_response: { ...evidence.embedding_response, dimensions: 1536 } }, expected)).toContain('provider response must contain exactly one 1024-dimensional embedding')
    expect(validateEmbeddingCandidateEvidence({ ...evidence, model: 'other-embedding' }, expected)).toContain('model must be one of the approved Qwen embedding models')
    expect(validateEmbeddingCandidateEvidence({ ...evidence, endpoint: '/custom/embeddings' }, expected)).toContain('endpoint must be the pinned /v1/embeddings path')
  })
})
