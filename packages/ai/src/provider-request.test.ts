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
})
