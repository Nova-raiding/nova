import { createHash } from 'node:crypto'
import { chmodSync, lstatSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runConfiguredEmbeddingCandidateCanary, runEmbeddingCandidateProbe, runEmbeddingCandidateProbeToPrivateFile, validateCandidateEmbeddingConfig } from '../scripts/embedding-candidate-canary.js'
import type { ExpectedEmbeddingCandidate } from './embedding-candidate-evidence-gate.js'

const expected: ExpectedEmbeddingCandidate = {
  releaseId: 'release-test-embedding', releaseGitSha: 'a'.repeat(40), imageSetDigest: `sha256:${'b'.repeat(64)}`,
  manifestSha256: 'c'.repeat(64), deploymentNonce: 'test-deployment-nonce-value',
}
const usage = { modality: 'embedding' as const, model: 'qwen3.7-text-embedding-flash', providerRequestId: 'req_embed_test_1', inputTokens: 42, outputTokens: 0, totalTokens: 42, observedAt: '2026-09-27T00:00:00.000Z', metadata: { usage_observed: true } }
const vector = Array.from({ length: 1024 }, (_, index) => index / 1024)
const sha = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex')

function provider(cost: { currency: 'CNY'; actual: number; source: 'provider_receipt' | 'relay_pricing_snapshot'; evidence_kind: 'provider_reported_actual' | 'pricing_derived_from_observed_usage'; pricing_version?: string; pricing_group?: string; formula_version?: string; pricing_snapshot_sha256?: string } = { currency: 'CNY', actual: 0.0001, source: 'provider_receipt', evidence_kind: 'provider_reported_actual' }) {
  return async () => ({ embedding: vector, model: usage.model, dimensions: 1024, httpStatus: 200, endpoint: '/v1/embeddings', usage, cost })
}

describe('candidate embedding canary config', () => {
  const valid: Record<string, string> = {
    MODEL_RELAY_BASE_URL: 'https://ai.wormholexyz.xyz/v1', MODEL_RELAY_API_KEY: 'synthetic-key',
    MODEL_RELAY_ALLOWED_HOSTS: 'ai.wormholexyz.xyz', NODE_ENV: 'production', EMBEDDING_MODEL: usage.model,
    EMBEDDING_DIMENSIONS: '1024', MODEL_RELAY_CANARY_MAX_TOTAL_CNY: '0.05', EMBEDDING_CANARY_CONFIRM: 'true',
    EMBEDDING_CANARY_OUTPUT_PATH: '/var/lib/release-evidence/embedding/candidate.json',
  }
  it('accepts only the pinned HTTPS relay and explicit bounded probe settings', () => {
    expect(validateCandidateEmbeddingConfig(valid).baseUrl).toBe('https://ai.wormholexyz.xyz/v1')
    for (const base of ['http://ai.wormholexyz.xyz/v1', 'https://evil.example/v1', 'https://user@ai.wormholexyz.xyz/v1', 'https://ai.wormholexyz.xyz:9443/v1']) {
      expect(() => validateCandidateEmbeddingConfig({ ...valid, MODEL_RELAY_BASE_URL: base })).toThrow()
    }
    for (const base of ['https://ai.wormholexyz.xyz/other', 'https://ai.wormholexyz.xyz/v2/embeddings']) {
      expect(() => validateCandidateEmbeddingConfig({ ...valid, MODEL_RELAY_BASE_URL: base })).toThrow()
    }
    expect(() => validateCandidateEmbeddingConfig({ ...valid, MODEL_RELAY_ALLOWED_HOSTS: 'example.com' })).toThrow()
    expect(() => validateCandidateEmbeddingConfig({ ...valid, EMBEDDING_DIMENSIONS: '1536' })).toThrow()
    expect(() => validateCandidateEmbeddingConfig({ ...valid, EMBEDDING_CANARY_CONFIRM: 'false' })).toThrow()
    expect(() => validateCandidateEmbeddingConfig({ ...valid, MODEL_RELAY_CANARY_MAX_TOTAL_CNY: '0' })).toThrow()
  })
})

describe('candidate embedding private evidence slot', () => {
  const source = {
    MODEL_RELAY_BASE_URL: 'https://ai.wormholexyz.xyz/v1', MODEL_RELAY_API_KEY: 'secret-canary-key',
    MODEL_RELAY_ALLOWED_HOSTS: 'ai.wormholexyz.xyz', NODE_ENV: 'production', EMBEDDING_MODEL: usage.model,
    EMBEDDING_DIMENSIONS: '1024', MODEL_RELAY_CANARY_MAX_TOTAL_CNY: '0.05', EMBEDDING_CANARY_CONFIRM: 'true',
  }
  const privateDirectory = () => { const directory = realpathSync(mkdtempSync(join(tmpdir(), 'embedding-canary-evidence-'))); chmodSync(directory, 0o700); return directory }

  it('rejects a wrong relay endpoint before reserving output or calling the provider', async () => {
    const outputPath = join(privateDirectory(), 'candidate.json')
    let calls = 0
    await expect(runConfiguredEmbeddingCandidateCanary({
      source: { ...source, MODEL_RELAY_BASE_URL: 'https://ai.wormholexyz.xyz/other', EMBEDDING_CANARY_OUTPUT_PATH: outputPath }, expected,
      provider: async () => { calls++; return provider()() },
    })).rejects.toThrow('embedding relay base path must be exactly /v1')
    expect(calls).toBe(0)
    expect(() => lstatSync(outputPath)).toThrow()
  })

  it('refuses an existing output file before calling the provider', async () => {
    const outputPath = join(privateDirectory(), 'candidate.json')
    writeFileSync(outputPath, 'existing evidence', { mode: 0o600 })
    const config = validateCandidateEmbeddingConfig({ ...source, EMBEDDING_CANARY_OUTPUT_PATH: outputPath })
    let calls = 0
    await expect(runEmbeddingCandidateProbeToPrivateFile({ config, expected, provider: async () => { calls++; return provider()() } })).rejects.toThrow()
    expect(calls).toBe(0)
    expect(readFileSync(outputPath, 'utf8')).toBe('existing evidence')
  })

  it('refuses a symlink and a writable parent before calling the provider', async () => {
    const directory = privateDirectory()
    const target = join(directory, 'target.json')
    const link = join(directory, 'candidate.json')
    writeFileSync(target, 'target', { mode: 0o600 })
    symlinkSync(target, link)
    let calls = 0
    const providerProbe = async () => { calls++; return provider()() }
    await expect(runEmbeddingCandidateProbeToPrivateFile({ config: validateCandidateEmbeddingConfig({ ...source, EMBEDDING_CANARY_OUTPUT_PATH: link }), expected, provider: providerProbe })).rejects.toThrow()
    chmodSync(directory, 0o777)
    await expect(runEmbeddingCandidateProbeToPrivateFile({ config: validateCandidateEmbeddingConfig({ ...source, EMBEDDING_CANARY_OUTPUT_PATH: join(directory, 'new.json') }), expected, provider: providerProbe })).rejects.toThrow()
    expect(calls).toBe(0)
    expect(readFileSync(target, 'utf8')).toBe('target')
    chmodSync(directory, 0o700)
  })

  it('persists a private review-only failure receipt without provider error text or credentials', async () => {
    const outputPath = join(privateDirectory(), 'failed.json')
    const config = validateCandidateEmbeddingConfig({ ...source, EMBEDDING_CANARY_OUTPUT_PATH: outputPath })
    await expect(runEmbeddingCandidateProbeToPrivateFile({ config, expected, provider: async () => { throw new Error('Bearer secret-canary-key upstream rejected') } })).rejects.toThrow('embedding probe failed')
    const receipt = readFileSync(outputPath, 'utf8')
    expect(JSON.parse(receipt)).toMatchObject({ state: 'failed_review_only', production_evidence: false, release_id: expected.releaseId, reconciliation_required: true })
    expect(receipt).not.toContain('secret-canary-key')
    expect(receipt).not.toContain('Bearer')
    expect(lstatSync(outputPath).mode & 0o777).toBe(0o600)
  })

  it('binds the pending provider idempotency identity to the release and nonce', async () => {
    const firstPath = join(privateDirectory(), 'first.json')
    const secondPath = join(privateDirectory(), 'second.json')
    const failure = async () => { throw new Error('synthetic transport failure') }
    await expect(runConfiguredEmbeddingCandidateCanary({ source: { ...source, EMBEDDING_CANARY_OUTPUT_PATH: firstPath }, expected, provider: failure })).rejects.toThrow()
    await expect(runConfiguredEmbeddingCandidateCanary({ source: { ...source, EMBEDDING_CANARY_OUTPUT_PATH: secondPath }, expected: { ...expected, releaseGitSha: 'f'.repeat(40) }, provider: failure })).rejects.toThrow()
    const first = JSON.parse(readFileSync(firstPath, 'utf8')) as Record<string, unknown>
    const second = JSON.parse(readFileSync(secondPath, 'utf8')) as Record<string, unknown>
    expect(first.provider_idempotency_key).toMatch(/^model_provider_[a-f0-9]{64}$/u)
    expect(second.provider_idempotency_key).toMatch(/^model_provider_[a-f0-9]{64}$/u)
    expect(second.provider_idempotency_key).not.toBe(first.provider_idempotency_key)
  })

  it('writes the validated review-only evidence into the reserved slot', async () => {
    const outputPath = join(privateDirectory(), 'success.json')
    const config = validateCandidateEmbeddingConfig({ ...source, EMBEDDING_CANARY_OUTPUT_PATH: outputPath })
    const evidence = await runEmbeddingCandidateProbeToPrivateFile({ config, expected, provider: provider() })
    expect(JSON.parse(readFileSync(outputPath, 'utf8'))).toEqual(evidence)
    expect(lstatSync(outputPath).mode & 0o777).toBe(0o600)
  })
})

describe('candidate embedding canary evidence', () => {
  const base = { expected, model: usage.model, prompt: 'synthetic prompt must only become a hash', maxCostCny: 0.1, now: new Date('2026-09-27T00:01:00.000Z') }
  it('records hashes, candidate identity, observed usage and provider CNY receipt without storing prompt or vector', async () => {
    const evidence = await runEmbeddingCandidateProbe({ ...base, provider: provider() })
    expect(evidence).toMatchObject({
      evidence_scope: 'candidate_embedding_canary_review_only', production_evidence: false,
      release_id: expected.releaseId, release_git_sha: expected.releaseGitSha, image_set_digest: expected.imageSetDigest,
      manifest_sha256: expected.manifestSha256,
      deployment_nonce_sha256: sha(expected.deploymentNonce),
      provider_request_id: usage.providerRequestId, http_status: 200,
      usage: { input_tokens: 42, output_tokens: 0, total_tokens: 42 },
      cost: { currency: 'CNY', actual: 0.0001, source: 'provider_receipt', evidence_kind: 'provider_reported_actual' },
      embedding_response: { input_sha256: sha(base.prompt), embedding_sha256: sha(JSON.stringify(vector)), data_count: 1, dimensions: 1024 },
    })
    const serialized = JSON.stringify(evidence)
    expect(serialized).not.toContain(base.prompt)
    expect(serialized).not.toContain(JSON.stringify(vector))
    expect(serialized).not.toContain('synthetic-key')
  })

  it('accepts only an actual settlement pricing snapshot, never an estimate', async () => {
    const cost = { currency: 'CNY' as const, actual: 0, source: 'relay_pricing_snapshot' as const, evidence_kind: 'pricing_derived_from_observed_usage' as const, pricing_version: 'pricing-v1', pricing_group: 'default', formula_version: 'new-api-quota-v1', pricing_snapshot_sha256: 'd'.repeat(64) }
    await expect(runEmbeddingCandidateProbe({ ...base, provider: provider(cost) })).resolves.toMatchObject({ cost })
    const incomplete = { ...cost, pricing_snapshot_sha256: undefined }
    await expect(runEmbeddingCandidateProbe({ ...base, provider: provider(incomplete) })).rejects.toThrow()
    const estimate = { currency: 'CNY' as const, actual: 0.001, source: 'relay_pricing_snapshot_estimate' as 'relay_pricing_snapshot', evidence_kind: 'pricing_derived_from_observed_usage' as const }
    await expect(runEmbeddingCandidateProbe({ ...base, provider: provider(estimate) })).rejects.toThrow()
  })

  it('fails closed on missing provider ID/usage, wrong dimensions, over-budget cost and unpinned endpoint', async () => {
    await expect(runEmbeddingCandidateProbe({ ...base, provider: async () => ({ ...(await provider())(), usage: { ...usage, providerRequestId: undefined } }) })).rejects.toThrow()
    await expect(runEmbeddingCandidateProbe({ ...base, provider: async () => ({ ...(await provider())(), usage: { ...usage, metadata: {} } }) })).rejects.toThrow()
    await expect(runEmbeddingCandidateProbe({ ...base, provider: async () => ({ ...(await provider())(), dimensions: 1536 }) })).rejects.toThrow()
    await expect(runEmbeddingCandidateProbe({ ...base, maxCostCny: 0.00001, provider: provider() })).rejects.toThrow(/budget/u)
    await expect(runEmbeddingCandidateProbe({ ...base, provider: async () => ({ ...(await provider())(), endpoint: 'https://evil.example/v1/embeddings' }) })).rejects.toThrow()
  })
})
