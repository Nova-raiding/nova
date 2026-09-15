import { describe, expect, it } from 'vitest'
import { assertRelayEvidence } from './relay-evidence.mjs'

describe('relay evidence lifecycle', () => {
  it('treats queued execution envelopes as pending before provider evidence exists', () => {
    const result = {
      job_id: 'image-job-1',
      execution: { state: 'queued', provider: 'configured relay' },
    }

    expect(() => assertRelayEvidence('catalog.image.generate', result, { environment: 'production', fixtureFallback: false })).not.toThrow()
  })

  it('still blocks a terminal result that omits provider evidence', () => {
    const result = { execution: { state: 'completed', providerExecuted: false } }

    expect(() => assertRelayEvidence('catalog.image.generate', result, { environment: 'production', fixtureFallback: false })).toThrowError(/relay evidence is incomplete/u)
  })
})
