import { describe, expect, it } from 'vitest'
import { emitRelayUsage, ModelUsageSettlementPendingError, parseRelayUsage, relayUsageReceiptKey } from './relay-usage.js'

describe('relay usage normalization', () => {
  it('normalizes OpenAI-compatible token usage and provider request id', () => {
    const usage = parseRelayUsage({ id: 'req_123', usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20, cost_cny: '0.013' } }, new Headers({ 'x-request-id': 'header_req' }), { modality: 'text', model: 'merchant-v1', context: { workspaceId: 'ws_usage', actionId: 'task_1' } })
    expect(usage).toMatchObject({ workspaceId: 'ws_usage', actionId: 'task_1', modality: 'text', model: 'merchant-v1', providerRequestId: 'header_req', inputTokens: 12, outputTokens: 8, totalTokens: 20, costCny: 0.013 })
  })

  it('records an unmetered provider response instead of silently losing cost evidence', () => {
    expect(parseRelayUsage({ data: [{ url: 'https://cdn.example/image.png' }] }, new Headers(), { modality: 'image', model: 'image-v1' })).toMatchObject({ modality: 'image', model: 'image-v1', metadata: { usage_observed: false } })
  })

  it('marks usage as recorded only after the sink succeeds', async () => {
    let metadataAtSink: Record<string, unknown> | undefined
    const usage = await emitRelayUsage(
      value => { metadataAtSink = { ...(value.metadata ?? {}) } },
      { id: 'req_recorded', usage: { total_tokens: 3, cost_cny: 0.01 } },
      new Headers(),
      { modality: 'text', model: 'merchant-v1', context: { workspaceId: 'ws_usage', actionId: 'action_recorded' } },
    )

    expect(metadataAtSink).toEqual({ usage_observed: true })
    expect(usage?.metadata).toEqual({ usage_observed: true, settlement: 'recorded' })
  })

  it('wraps settlement failure without exposing provider or sink details', async () => {
    const providerSecret = 'provider-response-secret'
    let caught: unknown
    try {
      await emitRelayUsage(
        async () => { throw new Error(`ledger unavailable: ${providerSecret}`) },
        { id: 'req_unknown', secret: providerSecret, usage: { total_tokens: 3, cost_cny: 0.01 } },
        new Headers(),
        { modality: 'text', model: 'merchant-v1', context: { workspaceId: 'ws_usage', actionId: 'action_unknown' } },
      )
    } catch (error) {
      caught = error
    }

    expect(caught).toBeInstanceOf(ModelUsageSettlementPendingError)
    expect(caught).toMatchObject({ code: 'MODEL_USAGE_SETTLEMENT_PENDING', providerSucceeded: true, receiptKey: 'req_unknown', message: 'model usage settlement is pending' })
    expect(JSON.stringify(caught)).not.toContain(providerSecret)
  })

  it('fails closed when the production sink rejects a response without actual cost', async () => {
    const sinkError = Object.assign(new Error('cost missing'), { code: 'MODEL_USAGE_COST_MISSING' })
    const rejection = emitRelayUsage(
      async () => { throw sinkError },
      { id: 'req_cost_missing', usage: { total_tokens: 3 } },
      new Headers(),
      { modality: 'text', model: 'relay-text', context: { workspaceId: 'ws_cost', actionId: 'task_cost' } },
    )
    await expect(rejection).rejects.toBe(sinkError)
  })

  it('uses a stable hashed receipt key when the provider request id is absent', () => {
    const input = { workspaceId: ' ws_usage ', actionId: ' action_1 ', modality: 'image' as const, model: ' image-v1 ' }
    const first = relayUsageReceiptKey(input)
    const replay = relayUsageReceiptKey({ ...input })
    const differentAction = relayUsageReceiptKey({ ...input, actionId: 'action_2' })

    expect(first).toMatch(/^relay_usage_[a-f0-9]{64}$/u)
    expect(replay).toBe(first)
    expect(differentAction).not.toBe(first)
    expect(relayUsageReceiptKey({ ...input, providerRequestId: ' req_provider ' })).toBe('req_provider')
  })
})
