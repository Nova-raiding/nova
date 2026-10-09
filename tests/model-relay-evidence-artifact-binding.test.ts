import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { validateModelRelayEvidence } from './model-relay-evidence-gate.js'

const modalities = ['text', 'image', 'image_edit', 'ocr', 'video'] as const
const generatedAt = '2026-01-31T00:00:00.000Z'
const now = new Date('2026-01-31T00:01:00.000Z')
const nonce = 'candidate-relay-nonce-0123456789'
const expectedCandidate = {
  releaseGitSha: 'a'.repeat(40),
  imageSetDigest: `sha256:${'b'.repeat(64)}`,
  manifestSha256: 'c'.repeat(64),
  deploymentNonce: nonce,
}
const candidateBinding = {
  release_git_sha: expectedCandidate.releaseGitSha,
  image_set_digest: expectedCandidate.imageSetDigest,
  manifest_sha256: expectedCandidate.manifestSha256,
  deployment_nonce_sha256: createHash('sha256').update(nonce).digest('hex'),
}

function fixture() {
  const artifactRoot = mkdtempSync(join(tmpdir(), 'model-relay-artifact-binding-'))
  mkdirSync(join(artifactRoot, 'relay'), { recursive: true })
  const results = modalities.map(modality => {
    const usage = modality === 'text' || modality === 'ocr'
      ? { inputTokens: 1, outputTokens: 1, totalTokens: 2 }
      : modality === 'video' ? { durationSeconds: 1 } : { billingUnits: 1 }
    const result = {
      modality, state: 'ready', endpoint: '/probe', model: `model-${modality}`, httpStatus: 200,
      providerRequestId: `request-${modality}`, usageObserved: true, usage,
      usageProviderRequestId: `request-${modality}`, costObserved: true, costCny: 0.01,
      costSource: 'provider_receipt',
    }
    const artifact = {
      schema_version: '1', release_id: 'release-current', modality, observed_at: generatedAt,
      http_status: 200, response_headers: {}, result, candidate_binding: candidateBinding,
      ...(modality === 'video' ? { relay_response: { data: { status: 'completed', video_url: 'https://relay.example.test/video.mp4' } } } : {}),
    }
    const bytes = JSON.stringify(artifact)
    const name = `${modality}.json`
    writeFileSync(join(artifactRoot, 'relay', name), bytes)
    return { ...result, evidence_ref: `artifact://production/relay/${name}#${createHash('sha256').update(bytes).digest('hex')}` }
  })
  const document = {
    schema_version: '1', release_id: 'release-current', release_git_sha: expectedCandidate.releaseGitSha,
    image_set_digest: expectedCandidate.imageSetDigest, manifest_sha256: expectedCandidate.manifestSha256,
    deployment_nonce_sha256: candidateBinding.deployment_nonce_sha256,
    generated_at: generatedAt, expires_at: '2026-01-31T00:30:00.000Z', environment: 'production', simulated: false,
    relay: 'https://relay.example.test', results,
  }
  const options = {
    requireProduction: true,
    requireCandidateBinding: true,
    expectedCandidate,
    artifactRoot,
    now,
  }
  return { artifactRoot, document, options }
}

function rewriteArtifact(root: string, document: ReturnType<typeof fixture>['document'], modality: typeof modalities[number], mutate: (artifact: Record<string, any>) => void) {
  const path = join(root, 'relay', `${modality}.json`)
  const artifact = JSON.parse(readFileSync(path, 'utf8')) as Record<string, any>
  mutate(artifact)
  const bytes = JSON.stringify(artifact)
  writeFileSync(path, bytes)
  const result = (document.results as Array<Record<string, any>>).find(item => item.modality === modality)!
  result.evidence_ref = `artifact://production/relay/${modality}.json#${createHash('sha256').update(bytes).digest('hex')}`
}

describe('production model relay receipt candidate and timestamp binding', () => {
  it.each(modalities)('requires %s receipt artifact schema_version 1', modality => {
    const current = fixture()
    rewriteArtifact(current.artifactRoot, current.document, modality, artifact => { artifact.schema_version = '2' })
    expect(validateModelRelayEvidence(current.document, current.options))
      .toContain(`${modality}.evidence_ref schema_version must be 1`)
  })

  it.each(modalities)('requires every %s receipt to bind the expected candidate nonce', modality => {
    const current = fixture()
    rewriteArtifact(current.artifactRoot, current.document, modality, artifact => {
      artifact.candidate_binding.deployment_nonce_sha256 = 'd'.repeat(64)
    })
    expect(validateModelRelayEvidence(current.document, current.options))
      .toContain(`${modality}.evidence_ref receipt must bind the exact release candidate identity`)
  })

  it.each(modalities)('rejects a %s receipt with missing candidate binding', modality => {
    const current = fixture()
    rewriteArtifact(current.artifactRoot, current.document, modality, artifact => { delete artifact.candidate_binding })
    expect(validateModelRelayEvidence(current.document, current.options))
      .toContain(`${modality}.evidence_ref receipt must bind the exact release candidate identity`)
  })

  it.each(modalities)('rejects a stale %s receipt even when the summary is fresh', modality => {
    const current = fixture()
    rewriteArtifact(current.artifactRoot, current.document, modality, artifact => { artifact.observed_at = '2026-01-29T23:00:00.000Z' })
    expect(validateModelRelayEvidence(current.document, current.options))
      .toContain(`${modality}.evidence_ref observed_at must be a valid timestamp no later than generated_at and within 24 hours`)
  })

  it.each(modalities)('rejects a future-observed %s receipt', modality => {
    const current = fixture()
    rewriteArtifact(current.artifactRoot, current.document, modality, artifact => { artifact.observed_at = '2026-01-31T00:00:01.000Z' })
    expect(validateModelRelayEvidence(current.document, current.options))
      .toContain(`${modality}.evidence_ref observed_at must be a valid timestamp no later than generated_at and within 24 hours`)
  })

  it.each(modalities.flatMap(modality => [
    [modality, 'missing', undefined] as const,
    [modality, 'malformed', '2026-01-31'] as const,
  ]))('rejects a %s receipt with %s observed_at', (modality, _case, observedAt) => {
    const current = fixture()
    rewriteArtifact(current.artifactRoot, current.document, modality, artifact => {
      if (observedAt === undefined) delete artifact.observed_at
      else artifact.observed_at = observedAt
    })
    expect(validateModelRelayEvidence(current.document, current.options))
      .toContain(`${modality}.evidence_ref observed_at must be a valid timestamp no later than generated_at and within 24 hours`)
  })
})
