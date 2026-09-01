import { describe, expect, it } from 'vitest'
import { assertProviderResponseAccepted, ProviderOutcomeUnknownError, ProviderRequestFailedError } from '../packages/ai/src/provider-request.js'
import { emitRelayUsage } from '../packages/ai/src/relay-usage.js'
import { evaluatePlatformModelGate } from '../packages/ai/src/platform-model-gate.js'

const modalities = ['text', 'image', 'image_edit', 'ocr', 'video'] as const

const completeRelayEnvironment = {
  NODE_ENV: 'test',
  MODEL_RELAY_BASE_URL: 'https://relay.test.invalid/v1',
  MODEL_RELAY_API_KEY: 'test-relay-key',
  AI_MODEL: 'text-v1',
  IMAGE_MODEL: 'image-v1',
  IMAGE_EDIT_MODEL: 'image-edit-v1',
  OCR_MODEL: 'ocr-v1',
  VIDEO_MODEL: 'video-v1',
}

describe('local model relay contract', () => {
  it.each(modalities)('fails %s closed when the test relay endpoint is missing', modality => {
    const source = { ...completeRelayEnvironment, MODEL_RELAY_BASE_URL: undefined }
    expect(evaluatePlatformModelGate(source, modality)).toMatchObject({
      ready: false,
      reasons: expect.arrayContaining(['endpoint_missing']),
    })
  })

  it.each([
    [401, ProviderRequestFailedError, false, false],
    [403, ProviderRequestFailedError, false, false],
    [500, ProviderOutcomeUnknownError, true, true],
    [502, ProviderOutcomeUnknownError, true, true],
    [503, ProviderOutcomeUnknownError, true, true],
  ] as const)('does not convert relay HTTP %s into a successful model result', (status, errorType, providerSucceeded, reconciliationRequired) => {
    try {
      assertProviderResponseAccepted(new Response('', { status }), `model_provider_test_${status}`, 'local model relay')
      throw new Error(`HTTP ${status} was incorrectly accepted`)
    } catch (error) {
      expect(error).toBeInstanceOf(errorType)
      expect(error).toMatchObject({
        code: status >= 500 ? 'MODEL_PROVIDER_OUTCOME_UNKNOWN' : 'MODEL_PROVIDER_REQUEST_FAILED',
        providerSucceeded,
        reconciliationRequired,
        retryable: false,
      })
    }
  })

  it('requires usage, actual cost, and attributable request identity before settlement', async () => {
    await expect(emitRelayUsage(
      async () => {},
      { id: 'completion-only', usage: { cost_cny: 0.01 } },
      new Headers(),
      { modality: 'text', model: 'text-v1', context: { providerAttemptId: 'attempt-1' } },
    )).rejects.toMatchObject({ code: 'MODEL_USAGE_EVIDENCE_MISSING', missing: 'usage' })

    await expect(emitRelayUsage(
      async () => {},
      { id: 'provider-request-1', usage: { total_tokens: 3 } },
      new Headers(),
      { modality: 'text', model: 'text-v1' },
    )).rejects.toMatchObject({ code: 'MODEL_USAGE_EVIDENCE_MISSING', missing: 'cost' })

    await expect(emitRelayUsage(
      async () => {},
      { id: 'completion-only', usage: { total_tokens: 3, cost_cny: 0.01 } },
      new Headers(),
      { modality: 'text', model: 'text-v1' },
    )).rejects.toMatchObject({ code: 'MODEL_USAGE_EVIDENCE_MISSING', missing: 'identity' })
  })

  it.each(modalities)('requires complete usage/cost/request identity evidence for %s', async modality => {
    const sinkRecords: unknown[] = []
    const usage = await emitRelayUsage(
      record => { sinkRecords.push(record) },
      { id: `completion-${modality}`, provider_request_id: `provider-${modality}`, usage: { total_tokens: 3, cost_cny: 0.01 } },
      new Headers(),
      { modality, model: `${modality}-v1`, context: { workspaceId: 'ws-test', providerAttemptId: `attempt-${modality}` } },
    )

    expect(usage).toMatchObject({
      modality,
      model: `${modality}-v1`,
      providerRequestId: `provider-${modality}`,
      providerAttemptId: `attempt-${modality}`,
      totalTokens: 3,
      costCny: 0.01,
      metadata: { usage_observed: true, settlement: 'recorded' },
    })
    expect(sinkRecords).toHaveLength(1)
  })

  it.each(modalities)('fails %s closed when the provider attempt has no usage or cost', async modality => {
    await expect(emitRelayUsage(
      async () => {},
      { id: `provider-${modality}` },
      new Headers(),
      { modality, model: `${modality}-v1`, context: { providerAttemptId: `attempt-${modality}` } },
    )).rejects.toMatchObject({ code: 'MODEL_USAGE_EVIDENCE_MISSING', missing: 'usage' })
  })
})
