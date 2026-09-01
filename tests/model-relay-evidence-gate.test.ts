import { describe, expect, it } from 'vitest'
import { validateModelRelayEvidence } from './model-relay-evidence-gate.js'

const evidence = {
  schema_version: '1', release_id: 'release-1', generated_at: '2026-08-26T01:00:00Z', environment: 'production', simulated: false, relay: 'https://relay.example.com',
  results: ['text', 'image', 'image_edit', 'ocr', 'video'].map((modality, index) => ({ modality, state: 'ready', endpoint: '/probe', model: `merchant-${modality}-v1`, providerRequestId: `req-${modality}`, usageObserved: true, costObserved: true, costCny: index === 0 ? 0.01 : 0.02 })),
}

describe('model relay evidence gate', () => {
  it('requires a release-bound, five-modality real relay receipt', () => {
    expect(validateModelRelayEvidence(evidence, { expectedReleaseId: 'release-1' })).toEqual([])
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

  it('rejects local or non-HTTPS relay evidence', () => {
    expect(validateModelRelayEvidence({ ...evidence, relay: 'http://127.0.0.1:8790' })).toContain('relay must be a plain HTTPS origin')
  })

  it('binds relay evidence to the rendered production relay origin', () => {
    expect(validateModelRelayEvidence(evidence, { expectedRelay: 'https://relay.example.com/v1' })).toEqual([])
    expect(validateModelRelayEvidence(evidence, { expectedRelay: 'https://other-relay.example.com/v1' })).toContain('relay must match the rendered production model_relay_base_url origin')
  })

  it('rejects a provider request id reused by multiple modalities', () => {
    const invalid = structuredClone(evidence)
    invalid.results[1]!.providerRequestId = invalid.results[0]!.providerRequestId
    expect(validateModelRelayEvidence(invalid)).toContain(
      'providerRequestId must be unique across modalities: req-text (text, image)',
    )
  })
})
