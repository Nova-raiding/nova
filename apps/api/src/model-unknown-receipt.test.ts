import { describe, expect, it } from 'vitest'
import { unknownModelProviderReceipt } from './model-unknown-receipt.js'

describe('unknown model provider receipt', () => {
  it('persists the stable relay attempt key when no provider response id exists', () => {
    const error = { code: 'MODEL_PROVIDER_OUTCOME_UNKNOWN', providerOutcome: 'unknown', providerIdempotencyKey: 'mm-attempt-1' }
    const receipt = unknownModelProviderReceipt(error, 'ws_one', 'cpo_one')
    expect(receipt).toMatchObject({ workspaceId: 'ws_one', operationId: 'cpo_one', provider: 'model-relay', providerRequestId: 'mm-attempt-1', outcome: 'unknown' })
    expect(receipt?.receiptHash).toMatch(/^[a-f0-9]{64}$/u)
    expect(unknownModelProviderReceipt(error, 'ws_one', 'cpo_one')?.receiptHash).toBe(receipt?.receiptHash)
  })

  it('prefers the provider response id and never represents unknown as success', () => {
    expect(unknownModelProviderReceipt({ code: 'MODEL_PROVIDER_OUTCOME_UNKNOWN', providerOutcome: 'unknown', providerRequestId: 'relay-response', providerIdempotencyKey: 'mm-attempt' }, 'ws_one', 'cpo_one')).toMatchObject({ providerRequestId: 'relay-response', outcome: 'unknown' })
    expect(unknownModelProviderReceipt({ code: 'MODEL_PROVIDER_REQUEST_FAILED', providerOutcome: 'failed', providerIdempotencyKey: 'mm-attempt' }, 'ws_one', 'cpo_one')).toBeNull()
    expect(unknownModelProviderReceipt({ code: 'MODEL_PROVIDER_OUTCOME_UNKNOWN', providerOutcome: 'unknown', providerIdempotencyKey: 'bad\nkey' }, 'ws_one', 'cpo_one')).toBeNull()
  })
})
