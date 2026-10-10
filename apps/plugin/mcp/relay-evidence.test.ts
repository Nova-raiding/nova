import { describe, expect, it } from 'vitest'
import { assertRelayEvidence } from './relay-evidence.mjs'

describe('relay evidence lifecycle', () => {
  it.each(['production', 'staging', 'preview'] as const)('treats queued execution envelopes as pending before provider evidence exists in %s', environment => {
    const result = {
      job_id: 'image-job-1',
      execution: { state: 'queued', provider: 'configured relay' },
    }

    expect(() => assertRelayEvidence('catalog.image.generate', result, { environment, fixtureFallback: false })).not.toThrow()
    expect(result.job_id).toBe('image-job-1')
  })

  it('still blocks a terminal result that omits provider evidence', () => {
    const result = { execution: { state: 'completed', providerExecuted: false } }

    expect(() => assertRelayEvidence('catalog.image.generate', result, { environment: 'production', fixtureFallback: false })).toThrowError(/relay evidence is incomplete/u)
  })

  it.each(['production', 'staging', 'preview'] as const)('blocks a terminal result with provider and usage evidence but no cost evidence in %s', environment => {
    const result = {
      execution: {
        state: 'completed',
        providerExecuted: true,
        providerRequestId: 'provider-request-1',
        usage: { output_tokens: 120 },
      },
    }

    try {
      assertRelayEvidence('catalog.image.generate', result, { environment, fixtureFallback: false })
      throw new Error('expected missing cost evidence to block delivery')
    } catch (error) {
      expect(error).toMatchObject({
        code: 'MODEL_RELAY_EVIDENCE_REQUIRED',
        details: { operation_status: 'blocked', missing: ['cost_cny'] },
      })
    }
  })
})
