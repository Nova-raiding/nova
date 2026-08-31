import { describe, expect, it } from 'vitest'
import { assertProviderResponseAccepted } from '../packages/ai/src/provider-request.js'
import { OpenAICompatibleVideoGenerator } from '../packages/ai/src/video-generator.js'
import { evaluateRelayUsageEvidence, evaluateVideoProbePayload, extractProviderRequestId } from '../scripts/model-relay-canary.js'
import { validateModelRelayEvidence } from './model-relay-evidence-gate.js'

describe('production model relay contract', () => {
  it('does not disguise a response or async job id as a provider request id', () => {
    expect(extractProviderRequestId({ id: 'completion_1', task_id: 'job_1' }, new Headers())).toBeUndefined()
    expect(extractProviderRequestId({ provider_request_id: 'provider_req_1' }, new Headers())).toBe('provider_req_1')
    expect(extractProviderRequestId({}, new Headers({ 'x-oneapi-request-id': 'header_req_1' }))).toBe('header_req_1')
    expect(extractProviderRequestId({ data: { task_id: 'job_1', data: { request_id: 'nested_request_1' } } }, new Headers())).toBe('nested_request_1')
  })

  it('does not invent media usage evidence from a successful response shape', async () => {
    await expect(evaluateRelayUsageEvidence(
      { data: [{ url: 'https://cdn.example/image.png' }], cost_cny: 0.02 },
      new Headers(),
      'image',
      'image-v1',
    )).resolves.toEqual({ usageObserved: false, costObserved: true, costSource: 'provider_receipt', costCny: 0.02 })
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
    expect(evaluateVideoProbePayload({ task_id: 'job_done', status: 'completed', output_url: 'https://cdn.example/video.mp4' })).toEqual({ ready: true, providerJobId: 'job_done' })
    expect(evaluateVideoProbePayload({ code: 0, message: 'ok', data: { task_id: 'job_nested', status: 'SUCCESS', result_url: 'https://cdn.example/result.mp4', quota: 123, data: { request_id: 'request_nested', usage: { duration_seconds: 5 } } } })).toEqual({ ready: true, providerJobId: 'job_nested' })
    expect(evaluateVideoProbePayload({ data: { task_id: 'job_output', status: 'SUCCESS', data: { output: { url: 'https://cdn.example/output.mp4' } } } })).toEqual({ ready: true, providerJobId: 'job_output' })
    expect(evaluateVideoProbePayload({ code: 5001, data: { task_id: 'job_error', status: 'SUCCESS', result_url: 'https://cdn.example/stale.mp4' } })).toEqual({ ready: false, providerJobId: 'job_error', reason: 'video_relay_error_code' })
  })

  it('reads nested relay usage but never treats unversioned quota as CNY', async () => {
    await expect(evaluateRelayUsageEvidence(
      { data: { quota: 12345, data: { request_id: 'request_nested', usage: { duration_seconds: 5, billed_units: 1 } } } },
      new Headers(),
      'video',
      'video-v1',
    )).resolves.toEqual({ usageObserved: true, costObserved: false })
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
