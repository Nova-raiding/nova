import { describe, expect, it } from 'vitest'
import { assertProviderResponseAccepted } from '../packages/ai/src/provider-request.js'
import { OpenAICompatibleVideoGenerator } from '../packages/ai/src/video-generator.js'
import { blockHttpProbe, evaluateRelayUsageEvidence, evaluateVideoProbePayload, extractProviderRequestId, finalizeSuccessfulProbe } from '../scripts/model-relay-canary.js'
import { validateModelRelayEvidence } from './model-relay-evidence-gate.js'

describe('production model relay contract', () => {
  const completeProbe = (modality: 'text' | 'image' | 'image_edit' | 'ocr' | 'video') => ({
    modality,
    endpoint: '/probe',
    model: `${modality}-v1`,
    httpStatus: 200,
    providerRequestId: `req-${modality}`,
    usageObserved: true,
    costObserved: true,
    costSource: 'provider_receipt' as const,
    costCny: 0.01,
    responseValid: true,
  })

  it('does not disguise a response or async job id as a provider request id', () => {
    expect(extractProviderRequestId({ id: 'completion_1', task_id: 'job_1' }, new Headers())).toBeUndefined()
    expect(extractProviderRequestId({ provider_request_id: 'provider_req_1' }, new Headers())).toBe('provider_req_1')
    expect(extractProviderRequestId({}, new Headers({ 'x-oneapi-request-id': 'header_req_1' }))).toBe('header_req_1')
    expect(extractProviderRequestId({ data: { task_id: 'job_1', data: { request_id: 'nested_request_1' } } }, new Headers())).toBe('nested_request_1')
    expect(extractProviderRequestId({ data: { result: { request_id: 'envelope_request_1' } } }, new Headers())).toBe('envelope_request_1')
  })

  it('keeps fixed-price image usage separate from a provider cost receipt', async () => {
    await expect(evaluateRelayUsageEvidence(
      { data: [{ url: 'https://cdn.example/image.png' }], cost_cny: 0.02 },
      new Headers(),
      'image',
      'image-v1',
    )).resolves.toEqual({ usageObserved: true, costObserved: true, costSource: 'provider_receipt', costCny: 0.02 })
  })

  it('uses the bounded request unit as fixed-price image usage evidence', async () => {
    const pricing = { quote: async () => ({ costCny: 0.12, metadata: {
      cost_source: 'relay_pricing_snapshot' as const, pricing_version: 'pricing-v1', pricing_group: 'VIP', group_ratio: 1,
      usd_exchange_rate: 7, quota_per_unit: 500_000, quota_type: 1, model_ratio: 0, model_price: 0.12,
      completion_ratio: 1, raw_quota: 60_000, rounded_quota: 60_000, formula_version: 'new-api-quota-v1' as const,
    } }) }
    await expect(evaluateRelayUsageEvidence(
      { data: [{ url: 'https://cdn.example/image.png' }] },
      new Headers(),
      'image',
      'image-v1',
      { pricing },
    )).resolves.toEqual({ usageObserved: true, costObserved: true, costSource: 'relay_pricing_snapshot', costCny: 0.12, pricingVersion: 'pricing-v1', pricingGroup: 'VIP' })
  })

  it('requires a numeric non-negative provider cost receipt', async () => {
    await expect(evaluateRelayUsageEvidence(
      { usage: { total_tokens: 1 }, cost_cny: 'not-a-number' },
      new Headers(),
      'text',
      'text-v1',
    )).resolves.toEqual({ usageObserved: true, costObserved: false })
  })

  it('blocks queued and failed async video states until an HTTPS artifact is complete', () => {
    expect(evaluateVideoProbePayload({ task_id: 'job_queued', status: 'queued' })).toMatchObject({ ready: false, providerJobId: 'job_queued', reason: 'video_async_pending' })
    expect(evaluateVideoProbePayload({ task_id: 'job_failed', status: 'failed' })).toMatchObject({ ready: false, providerJobId: 'job_failed', reason: 'video_async_failed' })
    expect(evaluateVideoProbePayload({ task_id: 'job_failure', status: 'FAILURE', result_url: 'task failed' })).toMatchObject({ ready: false, providerJobId: 'job_failure', reason: 'video_async_failed' })
    expect(evaluateVideoProbePayload({ task_id: 'job_done', status: 'completed', output_url: 'https://cdn.example/video.mp4' })).toEqual({ ready: true, providerJobId: 'job_done' })
    expect(evaluateVideoProbePayload({ code: 0, message: 'ok', data: { task_id: 'job_nested', status: 'SUCCESS', result_url: 'https://cdn.example/result.mp4', quota: 123, data: { request_id: 'request_nested', usage: { duration_seconds: 5 } } } })).toEqual({ ready: true, providerJobId: 'job_nested' })
    expect(evaluateVideoProbePayload({ code: 'success', data: { task_id: 'job_string_success', status: 'SUCCESS', result_url: 'https://cdn.example/result.mp4' } })).toEqual({ ready: true, providerJobId: 'job_string_success' })
    expect(evaluateVideoProbePayload({ data: { task_id: 'job_output', status: 'SUCCESS', data: { output: { url: 'https://cdn.example/output.mp4' } } } })).toEqual({ ready: true, providerJobId: 'job_output' })
    expect(evaluateVideoProbePayload({ code: 5001, data: { task_id: 'job_error', status: 'SUCCESS', result_url: 'https://cdn.example/stale.mp4' } })).toEqual({ ready: false, providerJobId: 'job_error', reason: 'video_relay_error_code' })
  })

  it('keeps an async pending video canary blocked even when usage and cost exist', () => {
    expect(finalizeSuccessfulProbe({
      ...completeProbe('video'),
      providerJobId: 'job_pending',
      responseValid: false,
      responseFailure: 'video_async_pending',
    })).toMatchObject({ state: 'blocked', providerJobId: 'job_pending', detail: 'video_async_pending' })
  })

  it('keeps OCR 503 as an explicit HTTP failure rather than success evidence', () => {
    expect(blockHttpProbe({ modality: 'ocr', endpoint: '/chat/completions', model: 'ocr-v1' }, 503, 'req-ocr')).toEqual({
      modality: 'ocr', endpoint: '/chat/completions', model: 'ocr-v1', state: 'blocked', httpStatus: 503,
      providerRequestId: 'req-ocr', usageObserved: false, costObserved: false, detail: 'relay returned HTTP 503',
    })
  })

  it.each(['text', 'image', 'image_edit', 'ocr', 'video'] as const)(
    'fails %s closed when request identity, usage, or cost evidence is missing',
    modality => {
      expect(finalizeSuccessfulProbe({ ...completeProbe(modality), providerRequestId: undefined })).toMatchObject({ state: 'blocked', detail: 'provider_request_id_missing' })
      expect(finalizeSuccessfulProbe({ ...completeProbe(modality), usageObserved: false })).toMatchObject({ state: 'blocked', detail: 'usage_evidence_missing' })
      expect(finalizeSuccessfulProbe({ ...completeProbe(modality), costObserved: false, costCny: undefined })).toMatchObject({ state: 'blocked', detail: 'cost_evidence_missing' })
    },
  )

  it.each(['text', 'image', 'image_edit', 'ocr', 'video'] as const)('marks %s ready only with complete attributable evidence', modality => {
    expect(finalizeSuccessfulProbe(completeProbe(modality))).toMatchObject({ state: 'ready' })
  })

  it('reads nested relay usage but never treats unversioned quota as CNY', async () => {
    await expect(evaluateRelayUsageEvidence(
      { data: { quota: 12345, data: { request_id: 'request_nested', usage: { duration_seconds: 5, billed_units: 1 } } } },
      new Headers(),
      'video',
      'video-v1',
    )).resolves.toEqual({ usageObserved: true, costObserved: false })
  })

  it('reads usage from the API envelope result without requiring real relay configuration', async () => {
    await expect(evaluateRelayUsageEvidence(
      { data: { result: { request_id: 'envelope_request_1', usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6, cost_cny: 0.03 } } } },
      new Headers(),
      'text',
      'relay-text',
    )).resolves.toMatchObject({ usageObserved: true, costObserved: true, costCny: 0.03, costSource: 'provider_receipt' })
  })

  it('treats relay gateway failures as unknown outcomes requiring reconciliation', () => {
    expect(() => assertProviderResponseAccepted(new Response('', { status: 502 }), 'model_provider_test', 'image provider')).toThrow(expect.objectContaining({
      code: 'MODEL_PROVIDER_OUTCOME_UNKNOWN',
      providerOutcome: 'unknown',
      reconciliationRequired: true,
      retryable: false,
    }))
  })

  it('classifies video status transport and gateway failures without marking the job failed', async () => {
    const generator = new OpenAICompatibleVideoGenerator({
      baseUrl: 'https://relay.example',
      apiKey: 'redacted-test-value',
      model: 'video-v1',
      fetch: (async () => new Response('', { status: 503 })) as typeof fetch,
    })
    await expect(generator.getStatus('job_1')).rejects.toMatchObject({
      code: 'MODEL_PROVIDER_OUTCOME_UNKNOWN',
      providerOutcome: 'unknown',
      reconciliationRequired: true,
    })
  })

  it('rejects production evidence without attributable cost source and pricing snapshot identity', () => {
    const results = ['text', 'image', 'image_edit', 'ocr', 'video'].map(modality => ({
      modality,
      state: 'ready',
      endpoint: '/probe',
      model: `${modality}-v1`,
      providerRequestId: `req-${modality}`,
      usageObserved: true,
      costObserved: true,
      costCny: 0.01,
    }))
    const errors = validateModelRelayEvidence({
      schema_version: '1',
      release_id: 'release-1',
      generated_at: new Date().toISOString(),
      environment: 'production',
      simulated: false,
      relay: 'https://relay.example',
      results,
    }, { requireProduction: true })
    expect(errors).toEqual(expect.arrayContaining([
      'text.costSource must identify provider_receipt or relay_pricing_snapshot',
      'video.costSource must identify provider_receipt or relay_pricing_snapshot',
    ]))
  })
})
