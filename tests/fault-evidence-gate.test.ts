import { describe, expect, it } from 'vitest'
import { validateLocalFaultEvidence, type LocalFaultEvidence } from './fault-acceptance.js'

const base: LocalFaultEvidence = {
  schema_version: '1', environment: 'test', cloud_gate: false, status: 'pass',
  generated_at: '2026-09-01T00:00:00.000Z', ended_at: '2026-09-01T00:00:03.000Z',
  scenarios: [{ name: 'redis_restart', status: 'pass', degraded_status: 503, degraded_code: 'REDIS_UNAVAILABLE', recovered_status: 200, recovered_ready: true, request_id: 'req-local-fault', trace_id: 'trace-local-fault' }],
}

describe('local fault evidence gate', () => {
  it('accepts Docker-test-shaped recovery evidence and keeps it test-only', () => {
    expect(validateLocalFaultEvidence(base)).toEqual([])
  })

  it('rejects cloud or production claims and incomplete correlation evidence', () => {
    expect(validateLocalFaultEvidence({ ...base, environment: 'production', cloud_gate: true, scenarios: [{ ...base.scenarios[0], trace_id: '' }] })).toEqual(expect.arrayContaining([
      'environment must be test',
      'cloud_gate must be false for local fault evidence',
      'scenarios[0].trace_id is required',
    ]))
  })

  it('rejects a recovery result that did not prove the dependency became ready', () => {
    expect(validateLocalFaultEvidence({ ...base, scenarios: [{ ...base.scenarios[0], recovered_ready: false }] })).toContain('scenarios[0].recovered_ready must be true')
  })
})
