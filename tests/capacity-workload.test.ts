import { describe, expect, it } from 'vitest'
import { CAPACITY_WORKLOAD_READ_PATH, LOCAL_CAPACITY_REQUIRED_SERVICES, buildCapacityEvidenceDocument, isExpectedCapacityStatus, readCapacityWorkloadConfig, selectCapacityAccount, validateLocalCapacityEvidence } from './capacity-workload.js'
import { validateCapacityEvidence } from './capacity-evidence-gate.js'

describe('capacity workload contract', () => {
  it('uses an onboarding-exempt workspace-scoped read path for baseline traffic', () => {
    expect(CAPACITY_WORKLOAD_READ_PATH).toBe('/v1/platform-accounts')
  })

  it('counts deliberate quota responses separately from service failures', () => {
    expect(isExpectedCapacityStatus(429)).toBe(true)
    expect(isExpectedCapacityStatus(401)).toBe(false)
    expect(isExpectedCapacityStatus(500)).toBe(false)
  })

  it('fails setup instead of reporting a job workload with no bound account', () => {
    expect(selectCapacityAccount([{ platform: 'taobao', accountId: 'acct_1' }])).toBe('acct_1')
    expect(() => selectCapacityAccount([{ platform: 'taobao' }])).toThrow('bound Taobao account')
  })
  it('binds pilot and target profiles to their fixed load semantics', () => {
    expect(readCapacityWorkloadConfig({ CAPACITY_WORKLOAD_URL: 'http://127.0.0.1:8787', CAPACITY_WORKLOAD_PROFILE: 'pilot_50' })).toMatchObject({ workspaces: 50, clientConnections: 150, sustainedRps: 30, burstRps: 60, asyncJobsPerMinute: 50 })
    expect(readCapacityWorkloadConfig({ CAPACITY_WORKLOAD_URL: 'http://127.0.0.1:8787', CAPACITY_WORKLOAD_PROFILE: 'target_500', CAPACITY_WORKLOAD_CONCURRENCY: '500' })).toMatchObject({ workspaces: 500, clientConnections: 750, sustainedRps: 150, burstRps: 300, asyncJobsPerMinute: 500 })
  })

  it('fails closed when real cloud evidence is not explicitly confirmed', () => {
    expect(() => readCapacityWorkloadConfig({ CAPACITY_WORKLOAD_URL: 'http://127.0.0.1:8787', CAPACITY_WORKLOAD_MODE: 'real_cloud' })).toThrow('CONFIRM_REAL_CLOUD')
    expect(() => readCapacityWorkloadConfig({ CAPACITY_WORKLOAD_URL: 'https://capacity.example.com', CAPACITY_WORKLOAD_MODE: 'real_cloud', CAPACITY_WORKLOAD_CONFIRM_REAL_CLOUD: 'true', CAPACITY_WORKLOAD_SUSTAINED_MINUTES: '1' })).toThrow('30 sustained minutes')
  })
  it('supports intermediate rollout workload profiles', () => {
    expect(readCapacityWorkloadConfig({ CAPACITY_WORKLOAD_URL: 'http://127.0.0.1:8787', CAPACITY_WORKLOAD_PROFILE: 'wave_100' })).toMatchObject({ workspaces: 100, clientConnections: 300, sustainedRps: 60, burstRps: 120, asyncJobsPerMinute: 100 })
    expect(readCapacityWorkloadConfig({ CAPACITY_WORKLOAD_URL: 'http://127.0.0.1:8787', CAPACITY_WORKLOAD_PROFILE: 'wave_250' })).toMatchObject({ workspaces: 250, clientConnections: 375, sustainedRps: 75, burstRps: 150, asyncJobsPerMinute: 250 })
  })

  it('emits schema-valid local evidence without promoting it to a cloud gate', () => {
    const config = readCapacityWorkloadConfig({ CAPACITY_WORKLOAD_URL: 'http://127.0.0.1:8787', CAPACITY_WORKLOAD_PROFILE: 'pilot_50', CAPACITY_WORKLOAD_MODE: 'compose' })
    const report = buildCapacityEvidenceDocument(config, {
      startedAt: '2026-09-01T00:00:00Z', endedAt: '2026-09-01T00:01:00Z', acceptedJobs: 0,
      timings: [
        { workspace: 'ws_capacity_0', phase: 'sustained', elapsedMs: 12, ok: true, status: 200 },
        { workspace: 'ws_capacity_1', phase: 'sustained', elapsedMs: 20, ok: true, status: 200 },
      ],
      runtimeServices: LOCAL_CAPACITY_REQUIRED_SERVICES.map(service => ({ service, state: 'running', health: 'healthy' })),
    })

    expect(validateCapacityEvidence(report, { requireEvidenceBinding: true })).toEqual([])
    expect(report).toMatchObject({ environment: 'test', cloud_gate: false, platform_mock_ratio: 1, model_mock_ratio: 1, status: 'pass', software_version: '0.1.1', data_version: 'local-fixture-v1' })
    expect(validateLocalCapacityEvidence(report)).toEqual([])
  })

  it('fails closed when local capacity evidence omits or degrades a Docker service', () => {
    const config = readCapacityWorkloadConfig({ CAPACITY_WORKLOAD_URL: 'http://127.0.0.1:8787', CAPACITY_WORKLOAD_MODE: 'compose' })
    const report = buildCapacityEvidenceDocument(config, {
      startedAt: '2026-09-01T00:00:00Z', endedAt: '2026-09-01T00:01:00Z', acceptedJobs: 0,
      timings: [{ workspace: 'ws_capacity_0', phase: 'sustained', elapsedMs: 12, ok: true, status: 200 }],
      runtimeServices: LOCAL_CAPACITY_REQUIRED_SERVICES.filter(service => service !== 'worker-scan').map(service => ({ service, state: 'running', health: 'healthy' })),
    })

    expect(validateLocalCapacityEvidence(report)).toEqual(expect.arrayContaining([
      'runtime_services is missing worker-scan',
    ]))
    expect(report.status).toBe('fail')
  })

  it('rejects a report that tries to use local evidence as a cloud attestation', () => {
    const config = readCapacityWorkloadConfig({ CAPACITY_WORKLOAD_URL: 'http://127.0.0.1:8787', CAPACITY_WORKLOAD_MODE: 'compose' })
    const report = buildCapacityEvidenceDocument(config, {
      startedAt: '2026-09-01T00:00:00Z', endedAt: '2026-09-01T00:01:00Z', acceptedJobs: 0,
      timings: [{ workspace: 'ws_capacity_0', phase: 'sustained', elapsedMs: 12, ok: true, status: 200 }],
    })

    expect(validateLocalCapacityEvidence({ ...report, environment: 'production', cloud_gate: true, target_url: 'https://capacity.example.com' })).toEqual(expect.arrayContaining([
      'environment must be test for local capacity evidence',
      'cloud_gate must be false for local capacity evidence',
      'target_url must be a local HTTP endpoint for local capacity evidence',
    ]))
  })

  it('keeps an HTTP failure visible in local evidence instead of claiming pass', () => {
    const config = readCapacityWorkloadConfig({ CAPACITY_WORKLOAD_URL: 'http://127.0.0.1:8787', CAPACITY_WORKLOAD_MODE: 'compose' })
    const report = buildCapacityEvidenceDocument(config, {
      startedAt: '2026-09-01T00:00:00Z', endedAt: '2026-09-01T00:01:00Z', acceptedJobs: 0,
      timings: [{ workspace: 'ws_capacity_0', phase: 'burst', elapsedMs: 20, ok: false, status: 503 }],
    })

    expect(report.status).toBe('fail')
    expect(report.metrics.error_count).toBe(1)
    expect(validateCapacityEvidence(report)).toContain('metrics.error_count must be 0')
  })

  it('rejects local evidence when the workload emitted no observations', () => {
    const config = readCapacityWorkloadConfig({ CAPACITY_WORKLOAD_URL: 'http://127.0.0.1:8787', CAPACITY_WORKLOAD_MODE: 'compose' })
    const report = buildCapacityEvidenceDocument(config, {
      startedAt: '2026-09-01T00:00:00Z', endedAt: '2026-09-01T00:01:00Z', acceptedJobs: 0, timings: [],
    })

    expect(report.status).toBe('fail')
    expect(validateLocalCapacityEvidence(report)).toContain('metrics.observed_request_count must be a positive integer for local capacity evidence')
  })

  it('does not serialize an unexecuted real-cloud run as passing', () => {
    const config = readCapacityWorkloadConfig({
      CAPACITY_WORKLOAD_URL: 'https://capacity.example.com',
      CAPACITY_WORKLOAD_MODE: 'real_cloud',
      CAPACITY_WORKLOAD_CONFIRM_REAL_CLOUD: 'true',
    })
    const report = buildCapacityEvidenceDocument(config, {
      startedAt: '2026-09-01T00:00:00Z', endedAt: '2026-09-01T00:01:00Z', acceptedJobs: 0, timings: [],
    })

    expect(report.status).toBe('fail')
    expect(report.metrics.observed_request_count).toBe(0)
  })
})
