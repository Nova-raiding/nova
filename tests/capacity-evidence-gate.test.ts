import { describe, expect, it } from 'vitest'
import { validateCapacityEvidence } from './capacity-evidence-gate.js'

const base = {
  schema_version: '1', status: 'pass', release_id: 'release-1', config_version: 'config-1', environment: 'preproduction', target_url: 'https://capacity.example.com', started_at: '2026-08-23T00:00:00Z', ended_at: '2026-08-23T06:00:00Z', profile: 'pilot_50', cloud_gate: true, raw_metrics_ref: 'artifact://metrics/1', platform_mock_ratio: 0, model_mock_ratio: 0, sign_off: { verified_by: 'qa', verified_at: '2026-08-23T06:00:00Z' }, metrics: { workspaces: 50, client_connections: 150, sustained_rps: 30, sustained_duration_minutes: 30, burst_rps: 60, burst_duration_seconds: 60, async_jobs_per_minute: 50, p95_ms: 100, p99_ms: 150, error_count: 0, duplicate_writes: 0, lost_jobs: 0, fairness_p95_degradation_percent: 10, stability_hours: 6 },
}

describe('capacity evidence gate', () => {
  it('accepts a complete real-cloud pilot report', () => expect(validateCapacityEvidence(base, { requireCloudGate: true })).toEqual([]))
  it('rejects a report that does not meet the target profile', () => expect(validateCapacityEvidence({ ...base, profile: 'target_500' }, { requireCloudGate: true }).some(error => error.includes('workspaces'))).toBe(true))
  it('accepts the intermediate wave profiles when their thresholds are met', () => {
    expect(validateCapacityEvidence({ ...base, profile: 'wave_100', metrics: { ...base.metrics, workspaces: 100, client_connections: 300, sustained_rps: 60, burst_rps: 120, async_jobs_per_minute: 100 } }, { requireCloudGate: true })).toEqual([])
    expect(validateCapacityEvidence({ ...base, profile: 'wave_250', metrics: { ...base.metrics, workspaces: 250, client_connections: 375, sustained_rps: 75, burst_rps: 150, async_jobs_per_minute: 250 } }, { requireCloudGate: true })).toEqual([])
  })
  it('rejects mock-only evidence as a real-cloud report', () => expect(validateCapacityEvidence({ ...base, platform_mock_ratio: 1 }, { requireCloudGate: true })).toContain('cloud gate requires zero platform/model mock ratio'))
  it('binds a report to both the release and requested capacity wave', () => {
    expect(validateCapacityEvidence(base, { expectedReleaseId: 'release-2', expectedProfile: 'target_500' })).toEqual(expect.arrayContaining(['release_id must match release-2', 'profile must match target_500']))
  })
  it('rejects invalid time ordering and percentile ordering', () => {
    const value = { ...base, ended_at: '2026-08-22T23:00:00Z', metrics: { ...base.metrics, p95_ms: 200, p99_ms: 100 } }
    expect(validateCapacityEvidence(value)).toEqual(expect.arrayContaining([
      'ended_at must not be before started_at',
      'metrics.p99_ms must be greater than or equal to metrics.p95_ms',
    ]))
  })
  it('rejects malformed timestamps and negative measurements', () => {
    const value = { ...base, started_at: '2026-08-23', metrics: { ...base.metrics, workspaces: -1 } }
    expect(validateCapacityEvidence(value)).toEqual(expect.arrayContaining([
      'started_at must be an ISO instant',
      'metrics.workspaces must not be negative',
    ]))
  })
  it('requires sign-off to occur during the measured interval', () => {
    const value = { ...base, sign_off: { verified_by: 'qa', verified_at: '2026-08-23T07:00:00Z' } }
    expect(validateCapacityEvidence(value)).toContain('sign_off.verified_at must fall within the test interval')
  })
})
