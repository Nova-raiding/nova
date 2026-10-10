import { describe, expect, it, vi } from 'vitest'
import { assertUsageSinkConfiguredBeforeDispatch, emitRelayUsage, ModelUsageEvidenceMissingError, ModelUsageSettlementPendingError, parseRelayUsage, relayUsageReceiptKey, type RelayUsageRecord } from './relay-usage.js'

describe('relay usage normalization', () => {
  it('fails closed before production dispatch when the durable usage sink is absent', () => {
    expect(() => assertUsageSinkConfiguredBeforeDispatch(undefined, 'production')).toThrow(expect.objectContaining({
      code: 'MODEL_USAGE_EVIDENCE_MISSING',
      missing: 'sink',
    }))
    expect(() => assertUsageSinkConfiguredBeforeDispatch(undefined, 'test')).not.toThrow()
    expect(() => assertUsageSinkConfiguredBeforeDispatch(undefined, 'development')).not.toThrow()
  })

  it.each([
    ['text', { usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6, cost_cny: 0.01 } }, {}],
    ['image', { usage: { output_image_count: 1, cost_cny: 0.12 }, data: [{ url: 'https://cdn.example/image.png' }] }, { observedArtifactCount: 1 }],
    ['image_edit', { usage: { output_image_count: 1, cost_cny: 0.13 }, data: [{ url: 'https://cdn.example/edited.png' }] }, { observedArtifactCount: 1 }],
    ['ocr', { usage: { prompt_tokens: 8, completion_tokens: 3, total_tokens: 11, cost_cny: 0.02 } }, {}],
    ['video', { data: { task_id: 'video-job-success', status: 'completed', usage: { duration_seconds: 4, cost_cny: 0.8 } } }, {}],
    ['embedding', { usage: { prompt_tokens: 10, total_tokens: 10, cost_cny: 0.001 } }, {}],
  ] as const)('settles complete usage, cost, and provider receipt for %s without external provider I/O', async (modality, payload, context) => {
    const sink = vi.fn(async () => ({ recorded: true as const, costEvidence: true as const }))
    const providerRequestId = `receipt-${modality}`
    const usage = await emitRelayUsage(
      sink,
      payload,
      new Headers({ 'x-provider-request-id': providerRequestId }),
      { modality, model: `${modality}-stub-model`, context: { providerAttemptId: `attempt-${modality}`, ...context } },
    )

    expect(usage).toMatchObject({
      modality,
      model: `${modality}-stub-model`,
      providerRequestId,
      costCny: expect.any(Number),
      metadata: { usage_observed: true, settlement: 'recorded' },
    })
    expect(sink).toHaveBeenCalledOnce()
    expect(sink).toHaveBeenCalledWith(expect.objectContaining({ modality, providerRequestId, providerAttemptId: `attempt-${modality}` }))
  })

  it('normalizes OpenAI-compatible token usage and provider request id', () => {
    const usage = parseRelayUsage({ id: 'req_123', usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20, cost_cny: '0.013' } }, new Headers({ 'x-request-id': 'header_req' }), { modality: 'text', model: 'merchant-v1', context: { workspaceId: 'ws_usage', actionId: 'task_1', contextLinkId: 'context_link_1', contextHash: 'a'.repeat(64) } })
    expect(usage).toMatchObject({ workspaceId: 'ws_usage', actionId: 'task_1', contextLinkId: 'context_link_1', contextHash: 'a'.repeat(64), modality: 'text', model: 'merchant-v1', providerRequestId: 'header_req', inputTokens: 12, outputTokens: 8, totalTokens: 20, costCny: 0.013 })
  })

  it('rejects malformed or non-CNY explicit provider cost instead of deriving a fallback', () => {
    expect(parseRelayUsage({ usage: { prompt_tokens: 1, cost_cny: 0.01 }, cost_cny: 0.02 }, new Headers({ 'x-request-id': 'conflicting-cost' }), { modality: 'text', model: 'm' })).toBeUndefined()
    expect(parseRelayUsage({ usage: { prompt_tokens: 1, cost_cny: 'not-a-number' } }, new Headers({ 'x-request-id': 'bad-cost' }), { modality: 'text', model: 'm' })).toBeUndefined()
    expect(parseRelayUsage({ usage: { prompt_tokens: 1, cost_cny: 0.01, currency: 'USD' } }, new Headers({ 'x-request-id': 'usd-cost' }), { modality: 'text', model: 'm' })).toBeUndefined()
    expect(parseRelayUsage({ usage: { prompt_tokens: 1, currency: 'CNY' } }, new Headers({ 'x-request-id': 'currency-only' }), { modality: 'text', model: 'm' })).toBeUndefined()
  })

  it.each([
    ['conflicting input aliases', { prompt_tokens: 100, input_tokens: 1, completion_tokens: 1, total_tokens: 2, cost_cny: 0.01 }],
    ['malformed preferred alias', { prompt_tokens: 'unknown', input_tokens: 1, completion_tokens: 1, total_tokens: 2, cost_cny: 0.01 }],
    ['inconsistent total', { prompt_tokens: 5, completion_tokens: 2, total_tokens: 99, cost_cny: 0.01 }],
    ['conflicting output aliases', { prompt_tokens: 5, completion_tokens: 2, output_tokens: 7, total_tokens: 12, cost_cny: 0.01 }],
  ])('does not settle token usage with %s', async (_label, usageEvidence) => {
    const sink = vi.fn(() => ({ recorded: true as const, costEvidence: true as const }))
    const payload = { usage: usageEvidence }
    const headers = new Headers({ 'x-request-id': 'invalid-token-evidence' })

    expect(parseRelayUsage(payload, headers, { modality: 'text', model: 'text-v1' })).toMatchObject({
      costCny: 0.01,
      metadata: { usage_observed: false, token_evidence_invalid: true },
    })
    await expect(emitRelayUsage(sink, payload, headers, { modality: 'text', model: 'text-v1' })).rejects.toMatchObject({
      code: 'MODEL_USAGE_EVIDENCE_MISSING', missing: 'usage',
    })
    expect(sink).not.toHaveBeenCalled()
  })

  it('rejects conflicting usage objects across supported response envelopes', async () => {
    const sink = vi.fn(() => ({ recorded: true as const, costEvidence: true as const }))
    const textPayload = {
      usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6, cost_cny: 0.01 },
      data: { usage: { prompt_tokens: 50, completion_tokens: 1, total_tokens: 51, cost_cny: 0.01 } },
    }
    const imagePayload = {
      usage: { output_image_count: 1, cost_cny: 0.12 },
      data: { usage: { image_count: 2, cost_cny: 0.12 } },
    }

    expect(parseRelayUsage(textPayload, new Headers({ 'x-request-id': 'nested-text-conflict' }), { modality: 'text', model: 'text-v1' })).toMatchObject({
      metadata: { usage_observed: false, token_evidence_invalid: true },
    })
    expect(parseRelayUsage(imagePayload, new Headers({ 'x-request-id': 'nested-image-conflict' }), { modality: 'image', model: 'image-v1' })).toMatchObject({
      metadata: { usage_observed: false, billing_units_evidence_invalid: true },
    })
    await expect(emitRelayUsage(sink, textPayload, new Headers({ 'x-request-id': 'nested-text-conflict' }), { modality: 'text', model: 'text-v1' })).rejects.toMatchObject({
      code: 'MODEL_USAGE_EVIDENCE_MISSING', missing: 'usage',
    })
    await expect(emitRelayUsage(sink, imagePayload, new Headers({ 'x-request-id': 'nested-image-conflict' }), { modality: 'image', model: 'image-v1' })).rejects.toMatchObject({
      code: 'MODEL_USAGE_EVIDENCE_MISSING', missing: 'usage',
    })
    expect(sink).not.toHaveBeenCalled()
  })

  it('accepts identical usage copied across supported response envelopes', () => {
    const usage = { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6, cost_cny: 0.01 }
    expect(parseRelayUsage({ usage, data: { usage: { ...usage } } }, new Headers({ 'x-request-id': 'nested-identical-usage' }), { modality: 'text', model: 'text-v1' })).toMatchObject({
      inputTokens: 5,
      outputTokens: 1,
      totalTokens: 6,
      costCny: 0.01,
      metadata: { usage_observed: true },
    })
  })

  it.each([
    ['text', { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6, cost_cny: 0.01 }],
    ['image', { output_image_count: 1, cost_cny: 0.12 }],
    ['image_edit', { output_image_count: 1, cost_cny: 0.12 }],
    ['ocr', { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6, cost_cny: 0.01 }],
    ['video', { duration_seconds: 4, cost_cny: 0.5 }],
    ['embedding', { prompt_tokens: 5, total_tokens: 5, cost_cny: 0.01 }],
  ] as const)('blocks %s settlement when another supported usage envelope is malformed', async (modality, usage) => {
    const sink = vi.fn(() => ({ recorded: true as const, costEvidence: true as const }))
    const payload = { usage, data: { usage: 'unknown' } }
    const headers = new Headers({ 'x-request-id': `malformed-secondary-${modality}` })

    expect(parseRelayUsage(payload, headers, { modality, model: `${modality}-v1` })).toMatchObject({
      metadata: { usage_observed: false, malformed_usage_envelope: true },
    })
    await expect(emitRelayUsage(sink, payload, headers, { modality, model: `${modality}-v1` })).rejects.toMatchObject({
      code: 'MODEL_USAGE_EVIDENCE_MISSING', missing: 'usage',
    })
    expect(sink).not.toHaveBeenCalled()
  })

  it.each(['image', 'image_edit'] as const)('preserves image-unit settlement but drops invalid token aliases for %s', async modality => {
    const sink = vi.fn(async (_record: RelayUsageRecord) => ({ recorded: true as const, costEvidence: true as const }))
    const payload = {
      usage: {
        output_image_count: 1,
        prompt_tokens: 100,
        input_tokens: 1,
        completion_tokens: 2,
        output_tokens: 3,
        total_tokens: 103,
        cost_cny: 0.12,
      },
      data: [{ url: 'https://cdn.example/image.png' }],
    }
    const headers = new Headers({ 'x-request-id': `invalid-image-token-evidence-${modality}` })

    const parsed = parseRelayUsage(payload, headers, { modality, model: 'image-v1' })
    expect(parsed).toMatchObject({ costCny: 0.12, metadata: { usage_observed: true, token_evidence_invalid: true, billing_units: 1 } })
    expect(parsed).not.toHaveProperty('inputTokens')
    expect(parsed).not.toHaveProperty('outputTokens')
    expect(parsed).not.toHaveProperty('totalTokens')

    const settled = await emitRelayUsage(sink, payload, headers, { modality, model: 'image-v1' })
    expect(settled.metadata).toMatchObject({ usage_observed: true, token_evidence_invalid: true, settlement: 'recorded' })
    expect(sink).toHaveBeenCalledOnce()
    expect(sink.mock.calls[0]?.[0]).not.toHaveProperty('inputTokens')
    expect(sink.mock.calls[0]?.[0]).not.toHaveProperty('outputTokens')
    expect(sink.mock.calls[0]?.[0]).not.toHaveProperty('totalTokens')
  })

  it.each([
    ['conflicting image aliases', { output_image_count: 1, image_count: 2 }],
    ['malformed secondary image alias', { output_image_count: 1, image_count: 'one' }],
    ['zero secondary image alias', { output_image_count: 1, image_count: 0 }],
  ])('blocks image settlement with %s', async (_label, imageUsage) => {
    const sink = vi.fn(() => ({ recorded: true as const, costEvidence: true as const }))
    const payload = {
      usage: { ...imageUsage, cost_cny: 0.12 },
      data: [{ url: 'https://cdn.example/image.png' }],
    }
    const headers = new Headers({ 'x-request-id': 'ambiguous-image-units' })

    expect(parseRelayUsage(payload, headers, { modality: 'image', model: 'image-v1' })).toMatchObject({
      costCny: 0.12,
      metadata: { usage_observed: false, billing_units_evidence_invalid: true },
    })
    expect(parseRelayUsage(payload, headers, { modality: 'image', model: 'image-v1' })?.metadata).not.toHaveProperty('billing_units')
    await expect(emitRelayUsage(sink, payload, headers, { modality: 'image', model: 'image-v1' })).rejects.toMatchObject({
      code: 'MODEL_USAGE_EVIDENCE_MISSING', missing: 'usage',
    })
    expect(sink).not.toHaveBeenCalled()
  })

  it('prefers the New API request id used by its user log', () => {
    const usage = parseRelayUsage({ usage: { total_tokens: 1 } }, new Headers({ 'x-oneapi-request-id': 'new-api-request', 'x-request-id': 'response-request' }), { modality: 'text', model: 'm' })
    expect(usage?.providerRequestId).toBe('new-api-request')
  })

  it('does not treat a completion id as a provider request id', () => {
    const usage = parseRelayUsage({ id: 'completion_123', usage: { total_tokens: 1 } }, new Headers(), { modality: 'text', model: 'm', context: { providerAttemptId: 'attempt_1' } })
    expect(usage?.providerRequestId).toBeUndefined()
    expect(usage?.providerAttemptId).toBe('attempt_1')
  })

  it('rejects unsafe provider request identifiers before settlement', async () => {
    const sinkRecords: unknown[] = []
    await expect(emitRelayUsage(
      record => { sinkRecords.push(record) },
      { usage: { total_tokens: 3, cost_cny: 0.01 }, provider_request_id: 'provider-\u0001-injected' },
      new Headers(),
      { modality: 'text', model: 'relay-text' },
    )).rejects.toMatchObject({ code: 'MODEL_USAGE_EVIDENCE_MISSING', missing: 'identity' })
    expect(sinkRecords).toHaveLength(0)
  })

  it('normalizes relay-specific nested request and usage evidence without pricing raw quota as CNY', () => {
    const usage = parseRelayUsage({ data: { task_id: 'job_1', quota: 999, data: { request_id: 'request_nested', usage: { input_tokens: 4, output_tokens: 6, total_tokens: 10 } } } }, new Headers(), { modality: 'video', model: 'video-v1', context: { providerAttemptId: 'attempt_nested' } })
    expect(usage).toMatchObject({ providerRequestId: 'request_nested', providerAttemptId: 'attempt_nested', inputTokens: 4, outputTokens: 6, totalTokens: 10 })
    expect(usage).not.toHaveProperty('costCny')
  })

  it('keeps an accepted video job and requested duration as preauthorization evidence only', () => {
    const usage = parseRelayUsage({ data: { id: 'video_job_1', status: 'queued' } }, new Headers({ 'x-request-id': 'video_request_1' }), { modality: 'video', model: 'video-v1', context: { durationSeconds: 5 } })
    expect(usage).toMatchObject({ providerRequestId: 'video_request_1', metadata: { usage_observed: false, video_request_accepted: true, preauthorization_duration_seconds: 5, preauthorization_estimate: true } })
    expect(usage?.metadata).not.toHaveProperty('duration_seconds')
  })

  it('persists the accepted video job id so an unsettled job stays reconcilable', () => {
    const usage = parseRelayUsage({ data: { task_id: 'job_1', status: 'queued' } }, new Headers({ 'x-request-id': 'video_request_1' }), { modality: 'video', model: 'video-v1' })
    expect(usage?.metadata).toMatchObject({ video_request_accepted: true, provider_job_id: 'job_1' })
    const statusBound = parseRelayUsage({ data: { id: 'video_job_2', status: 'queued' } }, new Headers({ 'x-request-id': 'video_request_2' }), { modality: 'video', model: 'video-v1' })
    expect(statusBound?.metadata).toMatchObject({ video_request_accepted: true, provider_job_id: 'video_job_2' })
    // A relay that merely echoes an id without an async lifecycle status has
    // not accepted a job, so it must not contribute a job identity.
    const echoed = parseRelayUsage({ data: { id: 'echoed_response_id' } }, new Headers({ 'x-request-id': 'video_request_3' }), { modality: 'video', model: 'video-v1' })
    expect(echoed?.metadata).not.toHaveProperty('provider_job_id')
    expect(parseRelayUsage({ data: [{ url: 'https://cdn.example/image.png' }] }, new Headers(), { modality: 'image', model: 'image-v1' })?.metadata).not.toHaveProperty('provider_job_id')
  })

  it('uses only provider-reported video duration as observed settlement evidence', () => {
    const usage = parseRelayUsage({ data: { task_id: 'video_job_1', status: 'completed', usage: { duration_seconds: '7' } } }, new Headers({ 'x-request-id': 'video_request_1' }), { modality: 'video', model: 'video-v1', context: { preauthorizationDurationSeconds: 5 } })
    expect(usage).toMatchObject({ metadata: { usage_observed: true, duration_seconds: 7, duration_evidence: 'provider_usage', preauthorization_duration_seconds: 5 } })
  })

  it('settles the New API video envelope using provider duration evidence', () => {
    const usage = parseRelayUsage({
      code: 'success',
      data: {
        task_id: 'task_new_api_video',
        status: 'SUCCESS',
        data: {
          request_id: 'new-api-video-request',
          usage: { duration: 5, output_video_duration: 5 },
        },
      },
    }, new Headers(), { modality: 'video', model: 'wan3.0-video', context: { preauthorizationDurationSeconds: 5 } })
    expect(usage).toMatchObject({
      providerRequestId: 'new-api-video-request',
      metadata: { usage_observed: true, duration_seconds: 5, duration_evidence: 'provider_usage', preauthorization_duration_seconds: 5 },
    })
  })

  it.each([
    ['conflicting aliases', { duration_seconds: 3, output_video_duration: 8 }],
    ['malformed preferred alias', { duration_seconds: 'invalid', duration: 3 }],
    ['malformed secondary alias', { duration_seconds: 3, output_video_duration: null }],
    ['zero secondary alias', { duration_seconds: 3, duration: 0 }],
    ['negative secondary alias', { duration_seconds: 3, duration: -1 }],
  ])('blocks video settlement with %s instead of choosing a cheaper duration', async (_label, duration) => {
    const sink = vi.fn(async () => ({ recorded: true as const, costEvidence: true as const }))
    const payload = { data: { task_id: 'video-ambiguous-duration', status: 'completed', usage: { ...duration, total_tokens: 10, cost_cny: 0.5 } } }
    const headers = new Headers({ 'x-request-id': 'video-duration-receipt' })
    const defaults = { modality: 'video' as const, model: 'video-v1', context: { preauthorizationDurationSeconds: 5 } }
    const usage = parseRelayUsage(payload, headers, defaults)
    expect(usage).toMatchObject({
      providerRequestId: 'video-duration-receipt',
      totalTokens: 10,
      costCny: 0.5,
      metadata: { usage_observed: false, duration_evidence_invalid: true, provider_job_id: 'video-ambiguous-duration' },
    })
    expect(usage?.metadata).not.toHaveProperty('duration_seconds')
    expect(usage?.metadata).not.toHaveProperty('duration_evidence')
    await expect(emitRelayUsage(sink, payload, headers, defaults)).rejects.toMatchObject({
      code: 'MODEL_USAGE_EVIDENCE_MISSING', missing: 'usage', providerRequestId: 'video-duration-receipt',
    })
    expect(sink).not.toHaveBeenCalled()
  })

  it('accepts numerically equal provider duration aliases without using the requested duration', () => {
    const usage = parseRelayUsage({ usage: { duration_seconds: '3.5', duration: 3.5, output_video_duration: '3.50' } },
      new Headers({ 'x-request-id': 'video-consistent-duration' }),
      { modality: 'video', model: 'video-v1', context: { preauthorizationDurationSeconds: 5 } })
    expect(usage?.metadata).toMatchObject({ usage_observed: true, duration_seconds: 3.5, duration_evidence: 'provider_usage', preauthorization_duration_seconds: 5 })
    expect(usage?.metadata).not.toHaveProperty('duration_evidence_invalid')
  })

  it('rejects accepted-only video jobs as observed usage', async () => {
    await expect(emitRelayUsage(
      () => ({ recorded: true, costEvidence: true }),
      { data: { task_id: 'video_job_1', status: 'queued' } },
      new Headers({ 'x-request-id': 'video_request_1' }),
      { modality: 'video', model: 'video-v1', context: { preauthorizationDurationSeconds: 5 } },
    )).rejects.toMatchObject({ code: 'MODEL_USAGE_EVIDENCE_MISSING', missing: 'usage', providerRequestId: 'video_request_1' })
  })

  it('normalizes provider usage and request identity inside the API envelope result', () => {
    const usage = parseRelayUsage({ data: { result: { request_id: 'request_result', usage: { input_tokens: 7, output_tokens: 3, total_tokens: 10 }, cost_cny: '0.02' } } }, new Headers(), { modality: 'text', model: 'relay-text' })
    expect(usage).toMatchObject({ providerRequestId: 'request_result', inputTokens: 7, outputTokens: 3, totalTokens: 10, costCny: 0.02, metadata: { usage_observed: true } })
  })

  it('requires actual image units instead of promoting an artifact-only response to metered usage', async () => {
    const sink = vi.fn(() => ({ recorded: true as const, costEvidence: true as const }))
    await expect(emitRelayUsage(
      sink,
      { id: 'unmetered-image', cost_cny: 0.01, data: [{ url: 'https://cdn.example/image.png' }] },
      new Headers(),
      { modality: 'image', model: 'image-v1', context: { providerAttemptId: 'attempt_unmetered_image' } },
    )).rejects.toMatchObject({ code: 'MODEL_USAGE_EVIDENCE_MISSING', missing: 'usage', providerRequestId: 'unmetered-image' })
    expect(sink).not.toHaveBeenCalled()
  })

  it('uses an image response body id when the relay omits request-id headers', () => {
    expect(parseRelayUsage({ id: 'image-response-123', usage: { output_image_count: 1 }, data: [{ url: 'https://cdn.example/image.png' }] }, new Headers(), { modality: 'image', model: 'image-v1', context: { observedArtifactCount: 1 } })).toMatchObject({ providerRequestId: 'image-response-123', metadata: { usage_observed: true, billing_units: 1, billing_units_evidence: 'provider_usage' } })
  })

  it('normalizes New API preserved Qwen image_count usage as provider billing units', () => {
    const usage = parseRelayUsage({
      data: [{ url: 'https://cdn.example/qwen.png' }],
      metadata: {
        request_id: 'qwen-provider-request',
        usage: { image_count: 1, height: 1024, width: 1024 },
        output: { choices: [{ message: { content: [{ image: 'https://cdn.example/qwen.png' }] } }] },
      },
    }, new Headers(), { modality: 'image', model: 'qwen-image-2.0', context: { observedArtifactCount: 1 } })
    expect(usage).toMatchObject({
      providerRequestId: 'qwen-provider-request',
      metadata: { usage_observed: true, billing_units: 1, billing_units_evidence: 'provider_usage', observed_artifact_count: 1 },
    })
  })

  it('recognizes top-level image arrays through the sanitized usage parser', () => {
    expect(parseRelayUsage({ id: 'image-response-456', usage: { output_image_count: 1 }, images: [{ url: 'https://cdn.example/image.png' }] }, new Headers(), { modality: 'image', model: 'image-v1', context: { observedArtifactCount: 1 } })).toMatchObject({ providerRequestId: 'image-response-456', metadata: { usage_observed: true } })
  })

  it('rejects unsafe request ids on top-level image responses before the usage sink', async () => {
    const sink = vi.fn(() => ({ recorded: true as const, costEvidence: true as const }))
    await expect(emitRelayUsage(
      sink,
      { id: 'image-\u0001-injected', usage: { output_image_count: 1 }, images: [{ url: 'https://cdn.example/image.png' }] },
      new Headers(),
      { modality: 'image', model: 'image-v1', context: { observedArtifactCount: 1 } },
    )).rejects.toMatchObject({ code: 'MODEL_USAGE_EVIDENCE_MISSING', missing: 'identity' })
    expect(sink).not.toHaveBeenCalled()
  })

  it.each([
    ['zero', 0],
    ['fractional', 1.5],
    ['malformed', 'one'],
  ])('fails closed for %s provider image unit count', async (_label, outputImageCount) => {
    const sink = vi.fn(() => ({ recorded: true as const, costEvidence: true as const }))
    expect(parseRelayUsage(
      { id: 'image-count-invalid', usage: { output_image_count: outputImageCount, cost_cny: 0.01 }, data: [{ url: 'https://cdn.example/image.png' }] },
      new Headers(),
      { modality: 'image', model: 'image-v1', context: { observedArtifactCount: 1 } },
    )).toMatchObject({ providerRequestId: 'image-count-invalid', costCny: 0.01, metadata: { usage_observed: false } })
    await expect(emitRelayUsage(
      sink,
      { id: 'image-count-invalid', usage: { output_image_count: outputImageCount, cost_cny: 0.01 }, data: [{ url: 'https://cdn.example/image.png' }] },
      new Headers(),
      { modality: 'image', model: 'image-v1', context: { observedArtifactCount: 1, providerAttemptId: 'attempt_image_count_invalid' } },
    )).rejects.toMatchObject({ code: 'MODEL_USAGE_EVIDENCE_MISSING', missing: 'usage' })
    expect(sink).not.toHaveBeenCalled()
  })

  it('fails closed when provider image units disagree with the returned artifact count', async () => {
    const sink = vi.fn(() => ({ recorded: true as const, costEvidence: true as const }))
    await expect(emitRelayUsage(
      sink,
      { id: 'image-count-mismatch', usage: { output_image_count: 2, cost_cny: 0.02 }, data: [{ url: 'https://cdn.example/image.png' }] },
      new Headers(),
      { modality: 'image', model: 'image-v1', context: { observedArtifactCount: 1, providerAttemptId: 'attempt_image_count_mismatch' } },
    )).resolves.toMatchObject({ providerRequestId: 'image-count-mismatch', costCny: 0.02, metadata: { usage_observed: true, billing_units: 2, billing_units_evidence: 'provider_usage', observed_artifact_count: 1, artifact_count_mismatch: true } })
    expect(sink).toHaveBeenCalledOnce()
  })

  it('does not treat a cost-only response as usage evidence', async () => {
    await expect(emitRelayUsage(
      async () => {},
      { id: 'req_cost_only', usage: { cost_cny: 0.01 } },
      new Headers(),
      { modality: 'text', model: 'relay-text', context: { providerAttemptId: 'attempt_cost_only' } },
    )).rejects.toMatchObject({ code: 'MODEL_USAGE_EVIDENCE_MISSING', missing: 'usage' })
  })

  it('accepts only integer token counts and drops an inconsistent reported total', () => {
    expect(parseRelayUsage({ usage: { input_tokens: 1.5, output_tokens: 2, total_tokens: 3.5 } }, new Headers(), { modality: 'text', model: 'm' })).not.toHaveProperty('inputTokens')
    const usage = parseRelayUsage({ usage: { input_tokens: 2, output_tokens: 3, total_tokens: 99 } }, new Headers(), { modality: 'text', model: 'm' })
    expect(usage).toMatchObject({ inputTokens: 2, outputTokens: 3 })
    expect(usage).not.toHaveProperty('totalTokens')
  })

  it('derives zero embedding output tokens only from an exact provider total/input equality', () => {
    const equal = parseRelayUsage(
      { usage: { prompt_tokens: 42, total_tokens: 42 } },
      new Headers(),
      { modality: 'embedding', model: 'qwen3.7-text-embedding-flash' },
    )
    expect(equal).toMatchObject({ inputTokens: 42, outputTokens: 0, totalTokens: 42, metadata: { usage_observed: true, output_tokens_derivation: 'embedding_total_equals_prompt_tokens' } })

    const inconsistent = parseRelayUsage(
      { usage: { prompt_tokens: 42, total_tokens: 43 } },
      new Headers(),
      { modality: 'embedding', model: 'qwen3.7-text-embedding-flash' },
    )
    expect(inconsistent).toMatchObject({ inputTokens: 42, totalTokens: 43, metadata: { usage_observed: true } })
    expect(inconsistent).not.toHaveProperty('outputTokens')
    expect(inconsistent?.metadata).not.toHaveProperty('output_tokens_derivation')

    const malformedExplicitOutput = parseRelayUsage(
      { usage: { prompt_tokens: 42, total_tokens: 42, completion_tokens: null } },
      new Headers(),
      { modality: 'embedding', model: 'qwen3.7-text-embedding-flash' },
    )
    expect(malformedExplicitOutput).not.toHaveProperty('outputTokens')
    expect(malformedExplicitOutput?.metadata).not.toHaveProperty('output_tokens_derivation')

    // This narrowly handles the embedding contract; do not reinterpret a
    // missing completion count for text generations as a zero-token answer.
    const text = parseRelayUsage(
      { usage: { prompt_tokens: 42, total_tokens: 42 } },
      new Headers(),
      { modality: 'text', model: 'chat-model' },
    )
    expect(text).not.toHaveProperty('outputTokens')
  })

  it('passes the derived zero through durable settlement for embedding usage', async () => {
    const sink = vi.fn(async () => ({ recorded: true as const, costEvidence: true as const }))
    await expect(emitRelayUsage(
      sink,
      { usage: { prompt_tokens: 42, total_tokens: 42 } },
      new Headers({ 'x-provider-request-id': 'embed-42' }),
      { modality: 'embedding', model: 'qwen3.7-text-embedding-flash', context: { workspaceId: 'ws_qwen' } },
    )).resolves.toMatchObject({ inputTokens: 42, outputTokens: 0, totalTokens: 42, metadata: { output_tokens_derivation: 'embedding_total_equals_prompt_tokens', cost_evidence: 'settlement_sink', settlement: 'recorded' } })
    expect(sink).toHaveBeenCalledWith(expect.objectContaining({ outputTokens: 0, totalTokens: 42 }))
  })

  it('marks usage as recorded only after the sink succeeds', async () => {
    let metadataAtSink: Record<string, unknown> | undefined
    const usage = await emitRelayUsage(
      value => { metadataAtSink = { ...(value.metadata ?? {}) }; return { recorded: true, costEvidence: true } },
      { id: 'req_recorded', usage: { total_tokens: 3, cost_cny: 0.01 } },
      new Headers(),
      { modality: 'text', model: 'merchant-v1', context: { workspaceId: 'ws_usage', actionId: 'action_recorded', providerAttemptId: 'attempt_recorded' } },
    )

    expect(metadataAtSink).toEqual({ usage_observed: true, provider_response_id: 'req_recorded' })
    expect(usage?.metadata).toEqual({ usage_observed: true, provider_response_id: 'req_recorded', settlement: 'recorded' })
  })

  it('accepts missing provider cost only when the settlement sink attests derived cost', async () => {
    const usage = await emitRelayUsage(
      async () => ({ recorded: true, costEvidence: true }),
      { id: 'req_derived_cost', usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } },
      new Headers({ 'x-request-id': 'request_derived_cost' }),
      { modality: 'text', model: 'relay-text', context: { providerAttemptId: 'attempt_derived_cost' } },
    )
    expect(usage.metadata).toMatchObject({ usage_observed: true, cost_evidence: 'settlement_sink', settlement: 'recorded' })
  })

  it('fails closed when a settlement sink attests cost without recording the usage', async () => {
    await expect(emitRelayUsage(
      async () => ({ recorded: false, costEvidence: true } as never),
      { id: 'req_unrecorded_cost', usage: { total_tokens: 3 } },
      new Headers({ 'x-request-id': 'request_unrecorded_cost' }),
      { modality: 'text', model: 'relay-text', context: { providerAttemptId: 'attempt_unrecorded_cost' } },
    )).rejects.toMatchObject({ code: 'MODEL_USAGE_EVIDENCE_MISSING', missing: 'sink' })
  })

  it('fails closed on a malformed settlement receipt even when provider cost exists', async () => {
    await expect(emitRelayUsage(
      async () => ({ recorded: false, costEvidence: false } as never),
      { id: 'req_malformed_receipt', usage: { total_tokens: 3, cost_cny: 0.01 } },
      new Headers(),
      { modality: 'text', model: 'relay-text', context: { providerAttemptId: 'attempt_malformed_receipt' } },
    )).rejects.toMatchObject({ code: 'MODEL_USAGE_EVIDENCE_MISSING', missing: 'sink' })
  })

  it('wraps settlement failure without exposing provider or sink details', async () => {
    const providerSecret = 'provider-response-secret'
    let caught: unknown
    try {
      await emitRelayUsage(
        async () => { throw new Error(`ledger unavailable: ${providerSecret}`) },
        { id: 'req_unknown', secret: providerSecret, usage: { total_tokens: 3, cost_cny: 0.01 } },
        new Headers(),
        { modality: 'text', model: 'merchant-v1', context: { workspaceId: 'ws_usage', actionId: 'action_unknown', providerAttemptId: 'attempt_unknown' } },
      )
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(ModelUsageSettlementPendingError)
    expect(caught).toMatchObject({ code: 'MODEL_USAGE_SETTLEMENT_PENDING', providerSucceeded: true, receiptKey: expect.stringMatching(/^relay_usage_[a-f0-9]{64}$/u), message: 'model usage settlement is pending' })
    expect(JSON.stringify(caught)).not.toContain(providerSecret)
  })

  it('fails closed before settlement when a response has no actual cost', async () => {
    const sinkError = Object.assign(new Error('cost missing'), { code: 'MODEL_USAGE_COST_MISSING' })
    const rejection = emitRelayUsage(
      async () => { throw sinkError },
      { id: 'req_cost_missing', usage: { total_tokens: 3 } },
      new Headers(),
      { modality: 'text', model: 'relay-text', context: { workspaceId: 'ws_cost', actionId: 'task_cost', providerAttemptId: 'attempt_cost' } },
    )
    await expect(rejection).rejects.toBe(sinkError)
  })

  it.each([
    ['usage', undefined, { cost_cny: 0.01 }],
    ['cost', { total_tokens: 3 }, undefined],
  ] as const)('fails closed when production %s evidence is missing', async (missing, usage, cost) => {
    const payload = { id: `req_missing_${missing}`, usage: { ...usage, ...(cost ? cost : {}) } }
    await expect(emitRelayUsage(
      async () => {},
      missing === 'usage' ? { id: payload.id } : payload,
      new Headers(),
      { modality: 'text', model: 'relay-text', context: { providerAttemptId: `attempt_${missing}` } },
    )).rejects.toMatchObject({ code: 'MODEL_USAGE_EVIDENCE_MISSING', missing: missing === 'usage' ? 'usage' : 'cost' })
  })

  it('fails closed when production settlement sink is missing', async () => {
    await expect(emitRelayUsage(
      undefined,
      { id: 'req_missing_sink', usage: { total_tokens: 3, cost_cny: 0.01 } },
      new Headers(),
      { modality: 'text', model: 'relay-text', context: { providerAttemptId: 'attempt_missing_sink' } },
    )).rejects.toBeInstanceOf(ModelUsageEvidenceMissingError)
  })

  it('fails closed when a sink records nothing even if the provider returned cost', async () => {
    await expect(emitRelayUsage(
      async () => {},
      { id: 'req_unrecorded', usage: { total_tokens: 3, cost_cny: 0.01 } },
      new Headers(),
      { modality: 'text', model: 'relay-text', context: { providerAttemptId: 'attempt_unrecorded' } },
    )).rejects.toMatchObject({ code: 'MODEL_USAGE_EVIDENCE_MISSING', missing: 'sink' })
  })

  it('fails closed when metering has no provider request or attempt identity', async () => {
    await expect(emitRelayUsage(
      async () => {},
      { id: 'completion_only', usage: { total_tokens: 3, cost_cny: 0.01 } },
      new Headers(),
      { modality: 'text', model: 'relay-text' },
    )).rejects.toMatchObject({ code: 'MODEL_USAGE_EVIDENCE_MISSING', missing: 'identity' })
  })

  it('preserves a committed actual-cost overrun at the provider boundary', async () => {
    const sinkError = Object.assign(new Error('task actual exceeded'), { code: 'MODEL_TASK_COST_ACTUAL_EXCEEDED', providerSucceeded: true })
    const rejection = emitRelayUsage(
      async () => { throw sinkError },
      { id: 'req_cost_overrun', usage: { total_tokens: 3, cost_cny: 2 } },
      new Headers(),
      { modality: 'text', model: 'relay-text', context: { workspaceId: 'ws_overrun', actionId: 'action_overrun', providerAttemptId: 'attempt_overrun' } },
    )
    await expect(rejection).rejects.toBe(sinkError)
  })

  it('binds local attempt keys while preserving provider receipt identity for reconciliation', () => {
    const input = { workspaceId: ' ws_usage ', actionId: ' action_1 ', providerAttemptId: ' attempt_1 ', modality: 'image' as const, model: ' image-v1 ' }
    const first = relayUsageReceiptKey(input)
    const replay = relayUsageReceiptKey({ ...input })
    const differentAction = relayUsageReceiptKey({ ...input, actionId: 'action_2' })
    const providerReceipt = relayUsageReceiptKey({ ...input, providerRequestId: ' req_provider ' })

    expect(first).toMatch(/^relay_usage_[a-f0-9]{64}$/u)
    expect(replay).toBe(first)
    expect(differentAction).not.toBe(first)
    expect(relayUsageReceiptKey({ ...input, providerAttemptId: 'attempt_2' })).not.toBe(first)
    expect(providerReceipt).toBe('req_provider')
    expect(relayUsageReceiptKey({ ...input, providerRequestId: 'req_provider', providerAttemptId: 'another_local_attempt' })).toBe(providerReceipt)
    expect(relayUsageReceiptKey({ ...input, workspaceId: 'ws_other', providerRequestId: 'req_provider' })).toBe(providerReceipt)
    expect(relayUsageReceiptKey({ ...input, model: 'image-v2', providerRequestId: 'req_provider' })).toBe(providerReceipt)
    expect(relayUsageReceiptKey({ ...input, modality: 'image_edit', providerRequestId: 'req_provider' })).toBe(providerReceipt)
  })

  it('fails closed when neither provider request nor provider attempt identity exists', () => {
    expect(() => relayUsageReceiptKey({ workspaceId: 'ws_1', actionId: 'action_1', modality: 'text', model: 'm' })).toThrow(expect.objectContaining({ code: 'MODEL_USAGE_RECEIPT_IDENTITY_MISSING' }))
  })

  it('does not use unsafe provider identities as settlement keys', () => {
    expect(() => relayUsageReceiptKey({ workspaceId: 'ws_1', actionId: 'action_1', modality: 'text', model: 'm', providerRequestId: `relay-\u0001-injected`, providerAttemptId: 'attempt_safe' })).not.toThrow()
    expect(relayUsageReceiptKey({ workspaceId: 'ws_1', actionId: 'action_1', modality: 'text', model: 'm', providerRequestId: `relay-\u0001-injected`, providerAttemptId: 'attempt_safe' })).toMatch(/^relay_usage_[a-f0-9]{64}$/u)
    expect(() => relayUsageReceiptKey({ workspaceId: 'ws_1', actionId: 'action_1', modality: 'text', model: 'm', providerRequestId: 'x'.repeat(257), providerAttemptId: 'attempt_safe' })).not.toThrow()
  })
})
