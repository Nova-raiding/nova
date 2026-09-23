import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { validateModelRelayEvidence } from './model-relay-evidence-gate.js'

const evidence = {
  schema_version: '1', release_id: 'release-1', generated_at: '2026-08-26T01:00:00Z', environment: 'production', simulated: false, relay: 'https://relay.example.com',
  results: ['text', 'image', 'image_edit', 'ocr', 'video'].map((modality, index) => ({ modality, state: 'ready', endpoint: '/probe', model: `merchant-${modality}-v1`, providerRequestId: `req-${modality}`, usageObserved: true, usage: modality === 'text' || modality === 'ocr' ? { totalTokens: 1 } : modality === 'video' ? { durationSeconds: 5 } : { billingUnits: 1 }, usageProviderRequestId: `req-${modality}`, costObserved: true, costCny: index === 0 ? 0.01 : 0.02 })),
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
      const body = JSON.stringify({ schema_version: '1', release_id: bound.release_id, modality: result.modality, result: receiptResult })
      const digest = createHash('sha256').update(body).digest('hex')
      writeFileSync(join(root, 'relay', `${result.modality}.json`), body)
      return { ...summarizedResult, evidence_ref: `artifact://production/relay/${result.modality}.json#${digest}` }
    })
    expect(validateModelRelayEvidence(bound, { requireProduction: true, artifactRoot: root, now: new Date('2026-08-26T02:00:00Z') })).toContain('text.evidence_ref receipt must match the summarized request, model, state, endpoint, usage and cost')
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
      const body = JSON.stringify({ schema_version: '1', release_id: result.modality === 'text' ? 'older-release' : bound.release_id, modality: result.modality, result: summarizedResult })
      const digest = createHash('sha256').update(body).digest('hex')
      writeFileSync(join(root, 'relay', `${result.modality}.json`), body)
      return { ...summarizedResult, evidence_ref: `artifact://production/relay/${result.modality}.json#${digest}` }
    })
    expect(validateModelRelayEvidence(bound, { requireProduction: true, artifactRoot: root, now: new Date('2026-08-27T00:00:00Z') })).toContain('text.evidence_ref release_id must match the evidence release_id')
  })
})
