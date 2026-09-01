import { describe, expect, it } from 'vitest'
import { assertProviderResponseAccepted, ProviderOutcomeUnknownError, ProviderRequestFailedError } from './provider-request.js'
import { emitRelayUsage } from './relay-usage.js'

describe('five-modality relay contract audit', () => {
  it.each([408, 500, 502, 503, 504])('keeps HTTP %s fail-closed as an ambiguous provider outcome', status => {
    expect(() => assertProviderResponseAccepted(new Response('', { status }), 'model_provider_audit', 'relay')).toThrowError(ProviderOutcomeUnknownError)
    try {
      assertProviderResponseAccepted(new Response('', { status }), 'model_provider_audit', 'relay')
    } catch (error) {
      expect(error).toMatchObject({
        code: 'MODEL_PROVIDER_OUTCOME_UNKNOWN',
        providerSucceeded: true,
        providerOutcome: 'unknown',
        reconciliationRequired: true,
        retryable: false,
        status,
        details: { provider_status: status, reconciliation_required: true },
      })
    }
  })

  it.each([400, 401, 403, 404, 422, 429])('records HTTP %s as an explicit failed provider outcome', status => {
    expect(() => assertProviderResponseAccepted(new Response('', { status }), 'model_provider_audit', 'relay')).toThrowError(ProviderRequestFailedError)
    try {
      assertProviderResponseAccepted(new Response('', { status }), 'model_provider_audit', 'relay')
    } catch (error) {
      expect(error).toMatchObject({
        code: 'MODEL_PROVIDER_REQUEST_FAILED',
        providerSucceeded: false,
        providerOutcome: 'failed',
        reconciliationRequired: false,
        retryable: false,
        status,
        details: { provider_status: status },
      })
    }
  })

  it.each(['text', 'image', 'image_edit', 'ocr', 'video'] as const)('retains the %s relay request id on an ambiguous response', modality => {
    const requestId = `relay-${modality}-failure`
    try {
      assertProviderResponseAccepted(new Response('', { status: 503, headers: { 'x-oneapi-request-id': requestId } }), 'model_provider_audit', `${modality} relay`)
    } catch (error) {
      expect(error).toMatchObject({
        code: 'MODEL_PROVIDER_OUTCOME_UNKNOWN',
        providerRequestId: requestId,
        details: { provider_request_id: requestId, reconciliation_required: true },
      })
      return
    }
    throw new Error('expected provider outcome to be blocked')
  })

  it.each(['text', 'image', 'image_edit', 'ocr', 'video'] as const)('requires durable cost evidence for %s usage', async modality => {
    await expect(emitRelayUsage(
      async () => {},
      { id: `audit-${modality}`, usage: { total_tokens: 3 } },
      new Headers(),
      { modality, model: `${modality}-model`, context: { providerAttemptId: `attempt-${modality}` } },
    )).rejects.toMatchObject({ code: 'MODEL_USAGE_EVIDENCE_MISSING', missing: 'cost' })
  })

  it.each(['text', 'image', 'image_edit', 'ocr', 'video'] as const)('does not settle %s when request identity exists but cost evidence is absent', async modality => {
    await expect(emitRelayUsage(
      async () => {},
      { data: { request_id: `relay-${modality}-usage`, usage: { total_tokens: 3 } } },
      new Headers(),
      { modality, model: `${modality}-model`, context: { providerAttemptId: `attempt-${modality}` } },
    )).rejects.toMatchObject({ code: 'MODEL_USAGE_EVIDENCE_MISSING', missing: 'cost', providerSucceeded: true })
  })
})
