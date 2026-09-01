import { describe, expect, it } from 'vitest'
import { assertProviderResponseAccepted, ProviderOutcomeUnknownError, ProviderRequestFailedError } from './provider-request.js'

describe('provider request outcome evidence', () => {
  it('preserves a 503 relay response status while failing closed', () => {
    expect(() => assertProviderResponseAccepted(new Response(JSON.stringify({ error: { message: 'No available channel' } }), { status: 503 }), 'model_provider_test', 'model relay'))
      .toThrowError(ProviderOutcomeUnknownError)

    try {
      assertProviderResponseAccepted(new Response('', { status: 503 }), 'model_provider_test', 'model relay')
    } catch (error) {
      expect(error).toMatchObject({
        code: 'MODEL_PROVIDER_OUTCOME_UNKNOWN',
        providerOutcome: 'unknown',
        reconciliationRequired: true,
        retryable: false,
        status: 503,
        details: { provider_status: 503, reconciliation_required: true },
      })
      return
    }
    throw new Error('expected provider outcome to be blocked')
  })

  it('keeps client errors failed rather than treating them as ambiguous', () => {
    expect(() => assertProviderResponseAccepted(new Response('', { status: 401 }), 'model_provider_test', 'model relay'))
      .toThrowError(ProviderRequestFailedError)
  })

  it('preserves a bounded relay request id in failure evidence for reconciliation', () => {
    try {
      assertProviderResponseAccepted(new Response('', { status: 503, headers: { 'x-oneapi-request-id': 'relay-failure-123' } }), 'model_provider_test', 'model relay')
    } catch (error) {
      expect(error).toMatchObject({
        providerRequestId: 'relay-failure-123',
        details: { provider_request_id: 'relay-failure-123' },
      })
      return
    }
    throw new Error('expected provider outcome to be blocked')
  })

  it('does not copy unsafe relay request ids into failure evidence', () => {
    try {
      assertProviderResponseAccepted(new Response('', { status: 401, headers: { 'x-request-id': 'relay-\u0001-injected' } }), 'model_provider_test', 'model relay')
    } catch (error) {
      expect(error).toMatchObject({ providerRequestId: undefined, details: { provider_idempotency_key: 'model_provider_test' } })
      expect(error).not.toMatchObject({ details: { provider_request_id: expect.anything() } })
      return
    }
    throw new Error('expected provider request to be rejected')
  })
})
