import { describe, expect, it } from 'vitest'
import { emitRelayUsage, ModelUsageEvidenceMissingError, ModelUsageSettlementPendingError, parseRelayUsage, relayUsageReceiptKey } from './relay-usage.js'

describe('relay usage normalization', () => {
  it('normalizes OpenAI-compatible token usage and provider request id', () => {
    const usage = parseRelayUsage({ id: 'req_123', usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20, cost_cny: '0.013' } }, new Headers({ 'x-request-id': 'header_req' }), { modality: 'text', model: 'merchant-v1', context: { workspaceId: 'ws_usage', actionId: 'task_1', contextLinkId: 'context_link_1', contextHash: 'a'.repeat(64) } })
    expect(usage).toMatchObject({ workspaceId: 'ws_usage', actionId: 'task_1', contextLinkId: 'context_link_1', contextHash: 'a'.repeat(64), modality: 'text', model: 'merchant-v1', providerRequestId: 'header_req', inputTokens: 12, outputTokens: 8, totalTokens: 20, costCny: 0.013 })
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

  it('normalizes relay-specific nested request and usage evidence without pricing raw quota as CNY', () => {
    const usage = parseRelayUsage({ data: { task_id: 'job_1', quota: 999, data: { request_id: 'request_nested', usage: { input_tokens: 4, output_tokens: 6, total_tokens: 10 } } } }, new Headers(), { modality: 'video', model: 'video-v1', context: { providerAttemptId: 'attempt_nested' } })
    expect(usage).toMatchObject({ providerRequestId: 'request_nested', providerAttemptId: 'attempt_nested', inputTokens: 4, outputTokens: 6, totalTokens: 10 })
    expect(usage).not.toHaveProperty('costCny')
  })

  it('records an unmetered provider response instead of silently losing cost evidence', () => {
    expect(parseRelayUsage({ data: [{ url: 'https://cdn.example/image.png' }] }, new Headers(), { modality: 'image', model: 'image-v1' })).toMatchObject({ modality: 'image', model: 'image-v1', metadata: { usage_observed: false } })
  })

  it('accepts only integer token counts and drops an inconsistent reported total', () => {
    expect(parseRelayUsage({ usage: { input_tokens: 1.5, output_tokens: 2, total_tokens: 3.5 } }, new Headers(), { modality: 'text', model: 'm' })).not.toHaveProperty('inputTokens')
    const usage = parseRelayUsage({ usage: { input_tokens: 2, output_tokens: 3, total_tokens: 99 } }, new Headers(), { modality: 'text', model: 'm' })
    expect(usage).toMatchObject({ inputTokens: 2, outputTokens: 3 })
    expect(usage).not.toHaveProperty('totalTokens')
  })

  it('marks usage as recorded only after the sink succeeds', async () => {
    let metadataAtSink: Record<string, unknown> | undefined
    const usage = await emitRelayUsage(
      value => { metadataAtSink = { ...(value.metadata ?? {}) } },
      { id: 'req_recorded', usage: { total_tokens: 3, cost_cny: 0.01 } },
      new Headers(),
      { modality: 'text', model: 'merchant-v1', context: { workspaceId: 'ws_usage', actionId: 'action_recorded', providerAttemptId: 'attempt_recorded' } },
    )

    expect(metadataAtSink).toEqual({ usage_observed: true, provider_response_id: 'req_recorded' })
    expect(usage?.metadata).toEqual({ usage_observed: true, provider_response_id: 'req_recorded', settlement: 'recorded' })
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
    await expect(rejection).rejects.toMatchObject({ code: 'MODEL_USAGE_EVIDENCE_MISSING', missing: 'cost' })
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
    )).rejects.toMatchObject({ code: 'MODEL_USAGE_EVIDENCE_MISSING', missing })
  })

  it('fails closed when production settlement sink is missing', async () => {
    await expect(emitRelayUsage(
      undefined,
      { id: 'req_missing_sink', usage: { total_tokens: 3, cost_cny: 0.01 } },
      new Headers(),
      { modality: 'text', model: 'relay-text', context: { providerAttemptId: 'attempt_missing_sink' } },
    )).rejects.toBeInstanceOf(ModelUsageEvidenceMissingError)
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

  it('uses a stable hashed receipt key when the provider request id is absent', () => {
    const input = { workspaceId: ' ws_usage ', actionId: ' action_1 ', providerAttemptId: ' attempt_1 ', modality: 'image' as const, model: ' image-v1 ' }
    const first = relayUsageReceiptKey(input)
    const replay = relayUsageReceiptKey({ ...input })
    const differentAction = relayUsageReceiptKey({ ...input, actionId: 'action_2' })

    expect(first).toMatch(/^relay_usage_[a-f0-9]{64}$/u)
    expect(replay).toBe(first)
    expect(differentAction).not.toBe(first)
    expect(relayUsageReceiptKey({ ...input, providerAttemptId: 'attempt_2' })).not.toBe(first)
    expect(relayUsageReceiptKey({ ...input, providerRequestId: ' req_provider ' })).toBe('req_provider')
  })

  it('fails closed when neither provider request nor provider attempt identity exists', () => {
    expect(() => relayUsageReceiptKey({ workspaceId: 'ws_1', actionId: 'action_1', modality: 'text', model: 'm' })).toThrow(expect.objectContaining({ code: 'MODEL_USAGE_RECEIPT_IDENTITY_MISSING' }))
  })
})
