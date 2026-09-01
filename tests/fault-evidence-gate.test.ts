import { describe, expect, it } from 'vitest'
import { validateLocalFaultEvidence, type LocalFaultEvidence } from './fault-acceptance.js'

const base: LocalFaultEvidence = {
  schema_version: '1', release_id: 'local-test-release', software_version: 'local-api@workspace', config_version: 'compose-test-v1', data_version: 'migration-128', environment: 'test', cloud_gate: false, status: 'pass',
  generated_at: '2026-09-01T00:00:00.000Z', ended_at: '2026-09-01T00:00:03.000Z',
  runtime_services: ['api', 'api-replica', 'clamav', 'ops-ui', 'postgres', 'redis', 'ui', 'worker-automation', 'worker-generation', 'worker-publish', 'worker-reconcile', 'worker-scan', 'worker-sync'].map(service => ({ service, state: 'running', health: 'healthy' })),
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

  it('rejects evidence that is not bound to the tested release and local versions', () => {
    const unbound = { ...base, release_id: '', software_version: '', config_version: '', data_version: '' }
    expect(validateLocalFaultEvidence(unbound)).toEqual(expect.arrayContaining([
      'release_id is required',
      'software_version is required',
      'config_version is required',
      'data_version is required',
    ]))
  })

  it('rejects a failed report that contains only successful scenarios', () => {
    expect(validateLocalFaultEvidence({ ...base, status: 'fail' })).toContain('fail evidence must contain a failed scenario')
  })

  it('rejects evidence without a complete healthy Docker runtime snapshot', () => {
    expect(validateLocalFaultEvidence({ ...base, runtime_services: base.runtime_services.filter(service => service.service !== 'worker-scan') })).toContain('runtime_services is missing worker-scan')
    expect(validateLocalFaultEvidence({ ...base, runtime_services: base.runtime_services.map(service => service.service === 'redis' ? { ...service, health: 'starting' } : service) })).toContain('runtime_services.redis.health must be healthy')
  })

  it('rejects duplicate scenario names instead of collapsing evidence', () => {
    expect(validateLocalFaultEvidence({ ...base, scenarios: [base.scenarios[0], { ...base.scenarios[0] }] })).toContain('scenario names must be unique')
  })

  it('accepts an explicitly failed recovery scenario in a failed report', () => {
    expect(validateLocalFaultEvidence({ ...base, status: 'fail', scenarios: [{ ...base.scenarios[0], status: 'fail', recovered_status: 503, recovered_ready: false }] })).toEqual([])
  })
})
