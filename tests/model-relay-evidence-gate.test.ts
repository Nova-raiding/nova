import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { validateModelRelayEvidence } from './model-relay-evidence-gate.js'

const evidence = {
  schema_version: '1', release_id: 'release-1', generated_at: '2026-08-26T01:00:00Z', environment: 'production', simulated: false, relay: 'https://relay.example.com',
  results: ['text', 'image', 'image_edit', 'ocr', 'video'].map((modality, index) => ({ modality, state: 'ready', endpoint: '/probe', model: `merchant-${modality}-v1`, httpStatus: 200, providerRequestId: `req-${modality}`, usageObserved: true, usage: modality === 'text' || modality === 'ocr' ? { totalTokens: 1 } : modality === 'video' ? { durationSeconds: 5 } : { billingUnits: 1 }, usageProviderRequestId: `req-${modality}`, costObserved: true, costCny: index === 0 ? 0.01 : 0.02 })),
}

describe('model relay evidence gate', () => {
  it('requires a release-bound, five-modality real relay receipt', () => {
    expect(validateModelRelayEvidence(evidence, { expectedReleaseId: 'release-1' })).toEqual([])
  })

  it('preserves five-modality eligibility when embedding indexing is disabled', () => {
    expect(validateModelRelayEvidence(evidence, { expectedReleaseId: 'release-1', requireEmbedding: false })).toEqual([])
    expect(validateModelRelayEvidence(evidence, { expectedReleaseId: 'release-1', requireEmbedding: true })).toContain('embedding result is required')
  })

  it('requires embedding dimensions, provider accounting, and candidate-bound response evidence when enabled', () => {
    const root = mkdtempSync(join(tmpdir(), 'relay-embedding-binding-'))
    mkdirSync(join(root, 'relay'), { recursive: true })
    const nonce = 'nonce_embedding_candidate_abcdefghijkl'
    const expectedCandidate = { releaseGitSha: 'a'.repeat(40), imageSetDigest: `sha256:${'b'.repeat(64)}`, manifestSha256: 'c'.repeat(64), deploymentNonce: nonce }
    const candidateBinding = { release_git_sha: expectedCandidate.releaseGitSha, image_set_digest: expectedCandidate.imageSetDigest,
      manifest_sha256: expectedCandidate.manifestSha256, deployment_nonce_sha256: createHash('sha256').update(nonce).digest('hex') }
    const vector = Array.from({ length: 1024 }, () => 0.125)
    const input = 'release evidence synthetic embedding input'
    const results: any[] = structuredClone(evidence.results).map((result: any) => ({ ...result, costSource: 'provider_receipt' }))
    const embeddingResult = { modality: 'embedding', state: 'ready', endpoint: '/v1/embeddings', model: 'qwen3.7-text-embedding-flash', dimensions: 1024,
      httpStatus: 200, providerRequestId: 'req-embedding', usageObserved: true, usage: { inputTokens: 16, totalTokens: 16 },
      usageProviderRequestId: 'req-embedding', costObserved: true, costCny: 0.01, costSource: 'provider_receipt' }
    results.push(embeddingResult)
    for (const result of results) {
      const artifact = { schema_version: '1', release_id: 'release-1', modality: result.modality, observed_at: '2026-08-26T01:00:00Z', http_status: result.httpStatus, response_headers: {},
        result, ...(result.modality === 'video' ? { relay_response: { data: { status: 'completed', video_url: 'https://relay.example.com/output.mp4' } } } : {}),
        ...(result.modality === 'embedding' ? { candidate_binding: candidateBinding,
          embedding_response: { input_sha256: createHash('sha256').update(input, 'utf8').digest('hex'),
            embedding_sha256: createHash('sha256').update(JSON.stringify(vector), 'utf8').digest('hex'), data_count: 1, dimensions: 1024 } } : {}) }
      const body = JSON.stringify(artifact)
      const name = `${result.modality}.json`
      writeFileSync(join(root, 'relay', name), body)
      result.evidence_ref = `artifact://production/relay/${name}#${createHash('sha256').update(body).digest('hex')}`
    }
    const bound = { ...evidence, release_git_sha: expectedCandidate.releaseGitSha, image_set_digest: expectedCandidate.imageSetDigest,
      manifest_sha256: expectedCandidate.manifestSha256, deployment_nonce_sha256: candidateBinding.deployment_nonce_sha256, results }
    const options = { requireEmbedding: true, expectedEmbeddingModel: 'qwen3.7-text-embedding-flash', requireCandidateBinding: true, expectedCandidate, artifactRoot: root }
    expect(validateModelRelayEvidence(bound, options)).toEqual([])

    const snapshot = { pricing: { pricing_version: 'pricing-v1', group_ratio: { default: 1 }, data: [{ model_name: 'qwen3.7-text-embedding-flash', quota_type: 0, model_ratio: 43.375, model_price: 0, completion_ratio: 1, enable_groups: ['default'] }] }, status: { quota_per_unit: 500000, usd_exchange_rate: 7.2 } }
    const snapshotDigest = createHash('sha256').update(JSON.stringify(snapshot), 'utf8').digest('hex')
    const snapshotArtifact = { schema_version: '1', release_id: 'release-1', modality: 'embedding', observed_at: '2026-08-26T01:00:00Z', http_status: 200, response_headers: {},
      result: { modality: 'embedding', state: 'ready', endpoint: '/v1/embeddings', model: 'qwen3.7-text-embedding-flash', dimensions: 1024, httpStatus: 200, providerRequestId: 'req-embedding', usageObserved: true, usage: { inputTokens: 16, totalTokens: 16 }, usageProviderRequestId: 'req-embedding', costObserved: true, costCny: 0.0099936, costSource: 'relay_pricing_snapshot', pricingVersion: 'pricing-v1', pricingGroup: 'default', pricingSnapshotSha256: snapshotDigest },
      candidate_binding: candidateBinding,
      embedding_response: { input_sha256: createHash('sha256').update(input, 'utf8').digest('hex'), embedding_sha256: createHash('sha256').update(JSON.stringify(vector), 'utf8').digest('hex'), data_count: 1, dimensions: 1024 },
      pricing_snapshot: snapshot }
    const snapshotBody = JSON.stringify(snapshotArtifact)
    writeFileSync(join(root, 'relay', 'embedding-snapshot.json'), snapshotBody)
    const snapshotEvidence = structuredClone(bound)
    Object.assign(snapshotEvidence.results[5]!, { costSource: 'relay_pricing_snapshot', costCny: 0.0099936, pricingVersion: 'pricing-v1', pricingGroup: 'default', pricingSnapshotSha256: snapshotDigest,
      evidence_ref: `artifact://production/relay/embedding-snapshot.json#${createHash('sha256').update(snapshotBody).digest('hex')}` })
    expect(validateModelRelayEvidence(snapshotEvidence, options)).toEqual([])
    const tamperedCost = structuredClone(snapshotEvidence)
    ;(tamperedCost.results[5] as any).costCny += 0.0001
    const tamperedCostArtifact = JSON.parse(snapshotBody)
    tamperedCostArtifact.result.costCny = (tamperedCost.results[5] as any).costCny
    const tamperedCostBody = JSON.stringify(tamperedCostArtifact)
    writeFileSync(join(root, 'relay', 'embedding-snapshot.json'), tamperedCostBody)
    ;(tamperedCost.results[5] as any).evidence_ref = `artifact://production/relay/embedding-snapshot.json#${createHash('sha256').update(tamperedCostBody).digest('hex')}`
    expect(validateModelRelayEvidence(tamperedCost, options)).toContain('embedding.evidence_ref embedding receipt must contain only input/vector SHA-256, data_count 1, and 1024 dimensions (no raw vector)')
    const unsafeSnapshot = structuredClone(snapshotEvidence)
    const unsafeSnapshotArtifact = JSON.parse(snapshotBody)
    unsafeSnapshotArtifact.pricing_snapshot.api_key = 'must-not-be-stored'
    const unsafeSnapshotBody = JSON.stringify(unsafeSnapshotArtifact)
    writeFileSync(join(root, 'relay', 'embedding-snapshot.json'), unsafeSnapshotBody)
    ;(unsafeSnapshot.results[5] as any).evidence_ref = `artifact://production/relay/embedding-snapshot.json#${createHash('sha256').update(unsafeSnapshotBody).digest('hex')}`
    expect(validateModelRelayEvidence(unsafeSnapshot, options)).toContain('embedding.evidence_ref embedding receipt must contain only input/vector SHA-256, data_count 1, and 1024 dimensions (no raw vector)')

    const nonFlashModel = structuredClone(bound)
    ;(nonFlashModel.results[5] as any).model = 'qwen3.7-text-embedding'
    expect(validateModelRelayEvidence(nonFlashModel, { ...options, expectedEmbeddingModel: 'qwen3.7-text-embedding' }))
      .not.toContain('embedding.model must match the explicitly rendered embedding model')
    expect(validateModelRelayEvidence(bound, { ...options, expectedEmbeddingModel: 'provider-selected-model' }))
      .toEqual(expect.arrayContaining([
        'embedding-enabled relay gate requires --embedding-model to be one of: qwen3.7-text-embedding-flash, qwen3.7-text-embedding',
        'embedding.model must match the explicitly rendered embedding model',
      ]))
    expect(validateModelRelayEvidence(bound, { ...options, expectedEmbeddingModel: undefined }))
      .toEqual(expect.arrayContaining([
        'embedding-enabled relay gate requires --embedding-model to be one of: qwen3.7-text-embedding-flash, qwen3.7-text-embedding',
        'embedding.model must match the explicitly rendered embedding model',
      ]))

    const wrongDimension = structuredClone(bound)
    ;(wrongDimension.results[5] as any).dimensions = 1536
    expect(validateModelRelayEvidence(wrongDimension, options)).toContain('embedding.dimensions must be 1024')

    const quotedCost = structuredClone(bound)
    ;(quotedCost.results[5] as any).costSource = 'relay_pricing_snapshot'
    expect(validateModelRelayEvidence(quotedCost, { ...options, requireProduction: true }))
      .toContain('embedding.costSource must be a provider receipt')

    const wrongObservedDimensions = JSON.parse(readFileSync(join(root, 'relay', 'embedding.json'), 'utf8'))
    wrongObservedDimensions.embedding_response.dimensions = 1536
    let changedBody = JSON.stringify(wrongObservedDimensions)
    writeFileSync(join(root, 'relay', 'embedding.json'), changedBody)
    const wrongObservedDimensionEvidence = structuredClone(bound)
    ;(wrongObservedDimensionEvidence.results[5] as any).evidence_ref = `artifact://production/relay/embedding.json#${createHash('sha256').update(changedBody).digest('hex')}`
    expect(validateModelRelayEvidence(wrongObservedDimensionEvidence, options)).toContain('embedding.evidence_ref embedding receipt must contain only input/vector SHA-256, data_count 1, and 1024 dimensions (no raw vector)')

    const rawVectorArtifact = JSON.parse(changedBody)
    rawVectorArtifact.embedding_response.dimensions = 1024
    rawVectorArtifact.relay_response = { data: [{ embedding: vector }] }
    changedBody = JSON.stringify(rawVectorArtifact)
    writeFileSync(join(root, 'relay', 'embedding.json'), changedBody)
    const rawVectorEvidence = structuredClone(bound)
    ;(rawVectorEvidence.results[5] as any).evidence_ref = `artifact://production/relay/embedding.json#${createHash('sha256').update(changedBody).digest('hex')}`
    expect(validateModelRelayEvidence(rawVectorEvidence, options)).toContain('embedding.evidence_ref embedding receipt must contain only input/vector SHA-256, data_count 1, and 1024 dimensions (no raw vector)')

    const promptArtifact = JSON.parse(changedBody)
    delete promptArtifact.relay_response
    promptArtifact.result.prompt = input
    changedBody = JSON.stringify(promptArtifact)
    writeFileSync(join(root, 'relay', 'embedding.json'), changedBody)
    const promptEvidence = structuredClone(bound)
    ;(promptEvidence.results[5] as any).evidence_ref = `artifact://production/relay/embedding.json#${createHash('sha256').update(changedBody).digest('hex')}`
    expect(validateModelRelayEvidence(promptEvidence, options)).toContain('embedding.evidence_ref embedding receipt must contain only input/vector SHA-256, data_count 1, and 1024 dimensions (no raw vector)')

    const extraTopLevel = JSON.parse(changedBody)
    delete extraTopLevel.result.prompt
    extraTopLevel.raw_prompt = input
    changedBody = JSON.stringify(extraTopLevel)
    writeFileSync(join(root, 'relay', 'embedding.json'), changedBody)
    const extraEvidence = structuredClone(bound)
    ;(extraEvidence.results[5] as any).evidence_ref = `artifact://production/relay/embedding.json#${createHash('sha256').update(changedBody).digest('hex')}`
    expect(validateModelRelayEvidence(extraEvidence, options)).toContain('embedding.evidence_ref embedding receipt must contain only input/vector SHA-256, data_count 1, and 1024 dimensions (no raw vector)')

    const missingUsage = structuredClone(bound)
    ;(missingUsage.results[5] as any).usageProviderRequestId = 'other-request'
    expect(validateModelRelayEvidence(missingUsage, options)).toContain('embedding.usageProviderRequestId must match providerRequestId')

    const noTokenUsage = structuredClone(bound)
    ;(noTokenUsage.results[5] as any).usage = { billingUnits: 1 }
    expect(validateModelRelayEvidence(noTokenUsage, options)).toContain('embedding.usage must contain token units')

    for (const endpoint of ['/chat/completions', '/v1/models']) {
      const wrongEndpoint = structuredClone(bound)
      ;(wrongEndpoint.results[5] as any).endpoint = endpoint
      expect(validateModelRelayEvidence(wrongEndpoint, options)).toContain('embedding.endpoint must be an embeddings API path')
    }
    for (const usage of [{ outputTokens: 16 }, { inputTokens: 0, totalTokens: 0 }, { inputTokens: 16, outputTokens: 1, totalTokens: 17 }, { inputTokens: 16, totalTokens: 17 }]) {
      const wrongUsage = structuredClone(bound)
      ;(wrongUsage.results[5] as any).usage = usage
      expect(validateModelRelayEvidence(wrongUsage, options).some(error => error.startsWith('embedding.usage.'))).toBe(true)
    }

    const wrongCandidate = structuredClone(bound)
    const artifactPath = join(root, 'relay', 'embedding.json')
    const original = JSON.parse(readFileSync(artifactPath, 'utf8'))
    original.candidate_binding.manifest_sha256 = 'd'.repeat(64)
    const tamperedBody = JSON.stringify(original)
    writeFileSync(artifactPath, tamperedBody)
    ;(wrongCandidate.results[5] as any).evidence_ref = `artifact://production/relay/embedding.json#${createHash('sha256').update(tamperedBody).digest('hex')}`
    expect(validateModelRelayEvidence(wrongCandidate, options)).toContain('embedding.evidence_ref receipt must bind the exact release candidate identity')
  })

  it('rejects skipped probes and missing accounting evidence', () => {
    const invalid = structuredClone(evidence)
    invalid.results[2]!.state = 'skipped_input'
    invalid.results[0]!.providerRequestId = ''
    invalid.results[1]!.usageObserved = false
    invalid.results[3]!.costObserved = false
    ;(invalid.results[1] as { costCny?: number }).costCny = undefined
    expect(validateModelRelayEvidence(invalid, { expectedReleaseId: 'release-1' })).toEqual(expect.arrayContaining([
      'image_edit state must be ready',
      'text.providerRequestId is required',
      'image.usageObserved must be true',
      'ocr.costObserved must be true',
      'image.costCny must be a non-negative observed number',
    ]))
  })

  it('requires every ready modality to carry a successful HTTP status', () => {
    const invalid = structuredClone(evidence)
    invalid.results[0]!.httpStatus = 503
    ;(invalid.results[1] as { httpStatus?: number }).httpStatus = undefined
    expect(validateModelRelayEvidence(invalid)).toEqual(expect.arrayContaining([
      'text.httpStatus must be a successful 2xx status',
      'image.httpStatus must be a successful 2xx status',
    ]))
  })

  it('rejects boolean-only usage and request identity drift', () => {
    const invalid = structuredClone(evidence)
    delete (invalid.results[0] as { usage?: unknown }).usage
    invalid.results[1]!.usageProviderRequestId = 'another-request'
    invalid.results[2]!.usage = { billingUnits: -1 }
    expect(validateModelRelayEvidence(invalid)).toEqual(expect.arrayContaining([
      'text.usage must contain finite non-negative numeric units',
      'image.usageProviderRequestId must match providerRequestId',
      'image_edit.usage must contain finite non-negative numeric units',
    ]))
  })

  it('rejects local or non-HTTPS relay evidence', () => {
    expect(validateModelRelayEvidence({ ...evidence, relay: 'http://127.0.0.1:8790' })).toContain('relay must be a plain HTTPS origin')
    const invalid = structuredClone(evidence)
    invalid.results[0]!.endpoint = '//other-host/probe'
    invalid.results[1]!.endpoint = '/v1/../probe'
    expect(validateModelRelayEvidence(invalid)).toEqual(expect.arrayContaining(['text.endpoint must be a safe relative path', 'image.endpoint must be a safe relative path']))
    invalid.results[1]!.endpoint = '/v1/%2e%2e/probe'
    expect(validateModelRelayEvidence(invalid)).toContain('image.endpoint must be a safe relative path')
  })

  it('binds relay evidence to the rendered production relay origin', () => {
    expect(validateModelRelayEvidence(evidence, { expectedRelay: 'https://relay.example.com/v1' })).toEqual([])
    expect(validateModelRelayEvidence(evidence, { expectedRelay: 'https://other-relay.example.com/v1' })).toContain('relay must match the rendered production model_relay_base_url origin')
  })

  it('requires exact candidate identity in strict release validation and rejects same-release replay', () => {
    const nonce = 'nonce_candidate_abcdefghijkl'
    const expectedCandidate = { releaseGitSha: 'a'.repeat(40), imageSetDigest: `sha256:${'b'.repeat(64)}`, manifestSha256: 'c'.repeat(64), deploymentNonce: nonce }
    const bound = { ...evidence, release_git_sha: expectedCandidate.releaseGitSha, image_set_digest: expectedCandidate.imageSetDigest,
      manifest_sha256: expectedCandidate.manifestSha256, deployment_nonce_sha256: createHash('sha256').update(nonce).digest('hex') }
    expect(validateModelRelayEvidence(bound, { requireCandidateBinding: true, expectedCandidate })).toEqual([])
    expect(validateModelRelayEvidence(bound, { requireCandidateBinding: true, expectedCandidate: { ...expectedCandidate, releaseGitSha: 'd'.repeat(40) } }))
      .toContain('release_git_sha must match the expected candidate')
    expect(validateModelRelayEvidence(bound, { requireCandidateBinding: true, expectedCandidate: { ...expectedCandidate, deploymentNonce: 'nonce_another_candidate_123456' } }))
      .toContain('deployment_nonce_sha256 must match the expected candidate nonce')
    expect(validateModelRelayEvidence(evidence, { requireCandidateBinding: true, expectedCandidate })).toEqual(expect.arrayContaining([
      'release_git_sha must match the expected candidate', 'image_set_digest must match the expected candidate',
      'manifest_sha256 must match the expected candidate', 'deployment_nonce_sha256 must match the expected candidate nonce',
    ]))
  })

  it('rejects a provider request id reused by multiple modalities', () => {
    const invalid = structuredClone(evidence)
    invalid.results[1]!.providerRequestId = invalid.results[0]!.providerRequestId
    expect(validateModelRelayEvidence(invalid)).toContain(
      'providerRequestId must be unique across modalities: req-text (text, image)',
    )
  })

  it('requires unexpired production evidence with a bounded validity window', () => {
    expect(validateModelRelayEvidence(evidence, { requireProduction: true, now: new Date('2026-08-27T00:00:00Z') })).toContain('expires_at must be an ISO instant')

    const expired = { ...evidence, expires_at: '2026-08-26T12:00:00Z' }
    expect(validateModelRelayEvidence(expired, { requireProduction: true, now: new Date('2026-08-27T00:00:00Z') })).toContain('relay evidence is expired')

    const invalidWindow = { ...evidence, expires_at: '2026-08-25T12:00:00Z' }
    expect(validateModelRelayEvidence(invalidWindow, { requireProduction: true, now: new Date('2026-08-24T00:00:00Z') })).toContain('expires_at must be after generated_at')
    const tooLong = { ...evidence, expires_at: '2026-08-28T01:00:01Z' }
    expect(validateModelRelayEvidence(tooLong, { requireProduction: true, now: new Date('2026-08-26T02:00:00Z') })).toContain('relay evidence validity must not exceed 24 hours')
    const future = { ...evidence, generated_at: '2026-08-27T01:00:00Z', expires_at: '2026-08-28T01:00:00Z' }
    expect(validateModelRelayEvidence(future, { requireProduction: true, now: new Date('2026-08-26T01:00:00Z') })).toContain('generated_at must not be in the future')
    const stale = { ...evidence, expires_at: '2026-08-27T01:00:00Z' }
    expect(validateModelRelayEvidence(stale, { requireProduction: true, now: new Date('2026-08-27T02:00:00Z') })).toContain('relay evidence is stale')
  })

  it('rejects production evidence without two immutable finite token receipts', () => {
    const now = new Date('2026-08-26T02:00:00Z')
    const root = mkdtempSync(join(tmpdir(), 'relay-token-cap-binding-'))
    mkdirSync(join(root, 'relay'), { recursive: true })
    const base = { ...evidence, expires_at: '2026-08-27T01:00:00Z' }
    expect(validateModelRelayEvidence(base, { requireProduction: true, artifactRoot: root, now })).toContain('token_quota is required for production relay evidence')
    const quotas = (['model', 'video'] as const).map(credential => {
      const token_quota = { credential, observed_at: '2026-08-26T00:59:00Z', total_granted: 1000, total_used: 200, total_available: 800, expires_at: 0, unlimited_quota: false }
      const body = JSON.stringify({ schema_version: '1', release_id: 'release-1', token_quota })
      const digest = createHash('sha256').update(body).digest('hex')
      writeFileSync(join(root, 'relay', `token-${credential}.json`), body)
      return { ...token_quota, evidence_ref: `artifact://production/relay/token-${credential}.json#${digest}` }
    })
    const validErrors = validateModelRelayEvidence({ ...base, token_quota: quotas }, { requireProduction: true, artifactRoot: root, now })
    expect(validErrors.filter(error => error.startsWith('token_quota'))).toEqual([])
    const unlimited = structuredClone(quotas)
    unlimited[0]!.unlimited_quota = true
    expect(validateModelRelayEvidence({ ...base, token_quota: unlimited }, { requireProduction: true, artifactRoot: root, now })).toContain('token_quota.model must be a current finite server-enforced quota')
    const mismatched = structuredClone(quotas)
    mismatched[1]!.total_available = 700
    expect(validateModelRelayEvidence({ ...base, token_quota: mismatched }, { requireProduction: true, artifactRoot: root, now })).toContain('token_quota.video.evidence_ref token quota receipt must match the summarized finite token evidence')
  })

  it('requires a distinct, immutable 503 recovery trace for production evidence', () => {
    const root = mkdtempSync(join(tmpdir(), 'relay-recovery-binding-'))
    mkdirSync(join(root, 'relay'), { recursive: true })
    const body = JSON.stringify({ schema_version: '1', release_id: 'release-1', failure: { release_id: 'release-1', observed_at: '2026-08-26T00:58:00Z', http_status: 503, error_code: 'MODEL_PROVIDER_OUTCOME_UNKNOWN', relay_response: { error: { code: 'MODEL_PROVIDER_OUTCOME_UNKNOWN' } }, provider_request_id: 'req-failed', relay: 'https://relay.example.com', endpoint: '/probe' }, recovery: { release_id: 'release-1', observed_at: '2026-08-26T00:59:00Z', http_status: 200, provider_request_id: 'req-recovered', relay: 'https://relay.example.com', endpoint: '/probe' } })
    const digest = createHash('sha256').update(body).digest('hex')
    writeFileSync(join(root, 'relay', 'recovery.json'), body)
    const complete = {
      ...structuredClone(evidence),
      expires_at: '2026-08-27T01:00:00Z',
      error_recovery: {
        verified: true,
        failure_status: 503,
        failure_observed_at: '2026-08-26T00:58:00Z',
        recovered_at: '2026-08-26T00:59:00Z',
        failed_request_id: 'req-failed',
        recovery_request_id: 'req-recovered',
        evidence_ref: `artifact://production/relay/recovery.json#${digest}`,
      },
    }
    // Result receipts are intentionally absent in this focused fixture; the
    // recovery contract itself must add no error.
    expect(validateModelRelayEvidence(complete, { requireProduction: true, artifactRoot: root, now: new Date('2026-08-26T02:00:00Z') }))
      .not.toEqual(expect.arrayContaining([expect.stringContaining('error_recovery')]))
    expect(validateModelRelayEvidence({ ...complete, error_recovery: { ...complete.error_recovery, recovery_request_id: 'req-failed' } }, { requireProduction: true, artifactRoot: root, now: new Date('2026-08-26T02:00:00Z') }))
      .toContain('error_recovery request ids must be distinct')
    expect(validateModelRelayEvidence({ ...complete, error_recovery: { ...complete.error_recovery, evidence_ref: 'file:///relay/recovery.json' } }, { requireProduction: true, artifactRoot: root, now: new Date('2026-08-26T02:00:00Z') }))
      .toContain('error_recovery.evidence_ref must be an immutable production artifact with SHA-256 fragment')
    expect(validateModelRelayEvidence({ ...complete, error_recovery: { ...complete.error_recovery, evidence_ref: `artifact://production/relay/recovery.json#${'0'.repeat(64)}` } }, { requireProduction: true, artifactRoot: root, now: new Date('2026-08-26T02:00:00Z') }))
      .toContain('error_recovery.evidence_ref SHA-256 does not match the referenced artifact')
    expect(validateModelRelayEvidence({ ...complete, error_recovery: undefined }, { requireProduction: true, artifactRoot: root, now: new Date('2026-08-26T02:00:00Z') }))
      .toContain('error_recovery is required for production relay evidence')
  })

  it.each([
    ['artifact release', (artifact: any) => { artifact.release_id = 'other-release' }],
    ['failure release', (artifact: any) => { artifact.failure.release_id = 'other-release' }],
    ['recovery release', (artifact: any) => { artifact.recovery.release_id = 'other-release' }],
    ['failure status', (artifact: any) => { artifact.failure.http_status = 200 }],
    ['model not found 503', (artifact: any) => { artifact.failure.error_code = 'model_not_found'; artifact.failure.relay_response.error.code = 'model_not_found' }],
    ['missing semantic code', (artifact: any) => { delete artifact.failure.error_code }],
    ['missing raw response code', (artifact: any) => { delete artifact.failure.relay_response }],
    ['summary and raw code mismatch', (artifact: any) => { artifact.failure.relay_response.error.code = 'model_not_found' }],
    ['recovery status', (artifact: any) => { artifact.recovery.http_status = 503 }],
    ['failure timestamp', (artifact: any) => { artifact.failure.observed_at = '2026-08-26T00:57:00Z' }],
    ['recovery timestamp', (artifact: any) => { artifact.recovery.observed_at = '2026-08-26T00:57:00Z' }],
    ['failure request id', (artifact: any) => { artifact.failure.provider_request_id = 'other-request' }],
    ['recovery request id', (artifact: any) => { artifact.recovery.provider_request_id = 'other-request' }],
    ['failure relay', (artifact: any) => { artifact.failure.relay = 'https://other.example.com' }],
    ['recovery endpoint', (artifact: any) => { artifact.recovery.endpoint = '/other' }],
  ])('rejects a hashed recovery artifact with tampered %s', (_, tamper) => {
    const root = mkdtempSync(join(tmpdir(), 'relay-recovery-tamper-'))
    mkdirSync(join(root, 'relay'), { recursive: true })
    const artifact = { schema_version: '1', release_id: 'release-1', failure: { release_id: 'release-1', observed_at: '2026-08-26T00:58:00Z', http_status: 503, error_code: 'MODEL_PROVIDER_OUTCOME_UNKNOWN', relay_response: { error: { code: 'MODEL_PROVIDER_OUTCOME_UNKNOWN' } }, provider_request_id: 'req-failed', relay: 'https://relay.example.com', endpoint: '/probe' }, recovery: { release_id: 'release-1', observed_at: '2026-08-26T00:59:00Z', http_status: 200, provider_request_id: 'req-recovered', relay: 'https://relay.example.com', endpoint: '/probe' } }
    tamper(artifact)
    const body = JSON.stringify(artifact)
    writeFileSync(join(root, 'relay', 'recovery.json'), body)
    const digest = createHash('sha256').update(body).digest('hex')
    const document = {
      ...structuredClone(evidence),
      expires_at: '2026-08-27T01:00:00Z',
      error_recovery: { verified: true, failure_status: 503, failure_observed_at: '2026-08-26T00:58:00Z', recovered_at: '2026-08-26T00:59:00Z', failed_request_id: 'req-failed', recovery_request_id: 'req-recovered', evidence_ref: `artifact://production/relay/recovery.json#${digest}` },
    }
    expect(validateModelRelayEvidence(document, { requireProduction: true, artifactRoot: root, now: new Date('2026-08-26T02:00:00Z') }))
      .toEqual(expect.arrayContaining([expect.stringContaining('error_recovery.evidence_ref')]))
  })

  it('rejects a summary that claims observed cost when the immutable receipt disagrees', () => {
    const root = mkdtempSync(join(tmpdir(), 'relay-cost-binding-'))
    mkdirSync(join(root, 'relay'), { recursive: true })
    const bound = { ...structuredClone(evidence), expires_at: '2026-08-27T01:00:00Z' }
    bound.results = bound.results.map(result => {
      const summarizedResult = { ...result, costSource: 'provider_receipt' }
      const receiptResult = { ...summarizedResult, ...(result.modality === 'text' ? { costObserved: false, costCny: 0 } : {}) }
      const body = JSON.stringify({ schema_version: '1', release_id: bound.release_id, modality: result.modality, http_status: result.httpStatus, result: receiptResult })
      const digest = createHash('sha256').update(body).digest('hex')
      writeFileSync(join(root, 'relay', `${result.modality}.json`), body)
      return { ...summarizedResult, evidence_ref: `artifact://production/relay/${result.modality}.json#${digest}` }
    })
    expect(validateModelRelayEvidence(bound, { requireProduction: true, artifactRoot: root, now: new Date('2026-08-26T02:00:00Z') })).toContain('text.evidence_ref receipt must bind successful HTTP status and summarized request, model, state, endpoint, usage and cost')
  })

  it('rejects immutable receipts copied from another release', () => {
    const root = mkdtempSync(join(tmpdir(), 'relay-binding-'))
    mkdirSync(join(root, 'relay'), { recursive: true })
    const bound = {
      ...structuredClone(evidence),
      expires_at: '2026-08-27T01:00:00Z',
    }
    bound.results = bound.results.map(result => {
      const summarizedResult = { ...result, costSource: 'provider_receipt' }
      const body = JSON.stringify({ schema_version: '1', release_id: result.modality === 'text' ? 'older-release' : bound.release_id, modality: result.modality, http_status: result.httpStatus, result: summarizedResult })
      const digest = createHash('sha256').update(body).digest('hex')
      writeFileSync(join(root, 'relay', `${result.modality}.json`), body)
      return { ...summarizedResult, evidence_ref: `artifact://production/relay/${result.modality}.json#${digest}` }
    })
    expect(validateModelRelayEvidence(bound, { requireProduction: true, artifactRoot: root, now: new Date('2026-08-27T00:00:00Z') })).toContain('text.evidence_ref release_id must match the evidence release_id')
  })
})
