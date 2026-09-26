import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { validateCapacityEvidence } from './capacity-evidence-gate.js'

const root = resolve(import.meta.dirname, '..')
const CAPACITY_FIXTURE = 'doc/todo/infra/capacity-evidence.example.json'
const runGate = (args: string[]) => spawnSync(process.execPath, ['--import', 'tsx', 'tests/capacity-evidence-gate.ts', ...args], {
  cwd: root,
  encoding: 'utf8',
  timeout: 120_000,
})

const base = {
  schema_version: '1', status: 'pass', release_id: 'release-1', software_version: 'rc-1', config_version: 'config-1', data_version: 'fixture-v1', environment: 'preproduction', target_url: 'https://capacity.example.com', started_at: '2026-08-23T00:00:00Z', ended_at: '2026-08-23T06:00:00Z', expires_at: '2026-09-30T00:00:00Z', profile: 'pilot_50', cloud_gate: true, raw_metrics_ref: 'artifact://metrics/1', platform_mock_ratio: 0, model_mock_ratio: 0, duration: { sustained_minutes: 30, burst_seconds: 60, stability_hours: 6 }, tenant: { workspace_count: 50, noise_multiplier: 10, isolation_verified: true, max_p95_degradation_percent: 20 }, fault: { injected: true, scenarios: ['redis_restart', 'db_pool_exhaustion', 'platform_timeout'], passed: true }, steady_state: { verified: true, queue_converged: true, stability_hours: 6 }, sign_off: { verified_by: 'qa', verified_at: '2026-08-23T06:00:00Z' }, metrics: { workspaces: 50, client_connections: 150, sustained_rps: 30, sustained_duration_minutes: 30, burst_rps: 60, burst_duration_seconds: 60, async_jobs_per_minute: 50, p95_ms: 100, p99_ms: 150, error_count: 0, duplicate_writes: 0, lost_jobs: 0, fairness_p95_degradation_percent: 10, stability_hours: 6 },
}

describe('capacity evidence gate', () => {
  it('accepts an explicit no-load declaration for subsequent signed bundle binding', () => {
    const value = { schema_version: '1', status: 'not_performed', release_id: 'release-1', software_version: 'sha-1', config_version: 'config-1', data_version: 'migration-242', environment: 'production', target_url: 'https://yxsona.com', started_at: '2026-09-22T00:00:00Z', ended_at: '2026-09-22T01:00:00Z', profile: 'no_load', cloud_gate: false, scope: 'no_load', capacity_commitment: 'none', reason: 'load_testing_excluded_by_release_scope', sign_off: { verified_by: 'owner', verified_at: '2026-09-22T01:00:00Z' }, generated_at: '2026-09-22T01:00:00Z' }
    const declaration = { ...value, expires_at: '2026-09-23T01:00:00Z' }
    const options = { expectedReleaseId: 'release-1', expectedProfile: 'no_load' as const, now: new Date('2026-09-22T02:00:00Z') }
    expect(validateCapacityEvidence(declaration, options)).toEqual([])
    expect(validateCapacityEvidence({ ...declaration, started_at: '2026-09-22T01:00:00+01:00', ended_at: '2026-09-22T02:00:00+01:00', sign_off: { verified_by: 'owner', verified_at: '2026-09-22T02:00:00+01:00' }, expires_at: '2026-09-24T01:00:00+01:00' }, options)).toEqual([])
    expect(validateCapacityEvidence(declaration, { ...options, expectedProfile: undefined })).toContain('no_load evidence requires explicit expected profile no_load')
    for (const mutation of [
      { release_id: 'different-release' },
      { expires_at: undefined },
      { expires_at: '2026-09-22T01:30:00Z' },
      { reason: 'arbitrary' },
      { target_url: 'https://user:secret@example.com' },
      { target_url: 'http://yxsona.com' },
      { target_url: 'https://yxsona.com/#fragment' },
      { target_url: 'not-a-url' },
      { sign_off: { verified_by: 'owner', verified_at: 'invalid' } },
      { ended_at: '2026-09-24T00:00:00Z' },
    ]) expect(validateCapacityEvidence({ ...declaration, ...mutation }, options).length).toBeGreaterThan(0)
    expect(validateCapacityEvidence(value, { requireCloudGate: true, expectedReleaseId: 'release-1', expectedProfile: 'no_load' })).toContain('no_load evidence cannot satisfy cloud gate')
  })
  it.each([
    ['metrics', {}],
    ['duration', {}],
    ['tenant', {}],
    ['fault', {}],
    ['steady_state', {}],
    ['raw_metrics_ref', 'artifact://metrics/1'],
    ['platform_mock_ratio', 0],
    ['model_mock_ratio', 0],
    ['accepted_jobs', 0],
    ['completeness', { observations_valid: true }],
    ['p95_ms', 100],
    ['future_measurement', 100],
  ])('rejects no-load declarations containing unsupported field %s', (field, fieldValue) => {
    const declaration = { schema_version: '1', status: 'not_performed', release_id: 'release-1', software_version: 'sha-1', config_version: 'migration-242', data_version: 'migration-242', environment: 'production', target_url: 'https://yxsona.com', started_at: '2026-09-22T00:00:00Z', ended_at: '2026-09-22T01:00:00Z', profile: 'no_load', cloud_gate: false, scope: 'no_load', capacity_commitment: 'none', reason: 'load_testing_excluded_by_release_scope', sign_off: { verified_by: 'owner', verified_at: '2026-09-22T01:00:00Z' }, expires_at: '2026-09-23T01:00:00Z' }
    expect(validateCapacityEvidence({ ...declaration, [field]: fieldValue }, { expectedReleaseId: 'release-1', expectedProfile: 'no_load', now: new Date('2026-09-22T02:00:00Z') }))
      .toContain(`no_load evidence contains unsupported fields: ${field}`)
  })
  it.each([
    ['metrics', {}],
    ['future_signoff_field', 'unexpected'],
  ])('rejects no-load sign_off containing unsupported field %s', (field, fieldValue) => {
    const declaration = { schema_version: '1', status: 'not_performed', release_id: 'release-1', software_version: 'sha-1', config_version: 'migration-242', data_version: 'migration-242', environment: 'production', target_url: 'https://yxsona.com', started_at: '2026-09-22T00:00:00Z', ended_at: '2026-09-22T01:00:00Z', profile: 'no_load', cloud_gate: false, scope: 'no_load', capacity_commitment: 'none', reason: 'load_testing_excluded_by_release_scope', sign_off: { verified_by: 'owner', verified_at: '2026-09-22T01:00:00Z' }, expires_at: '2026-09-23T01:00:00Z' }
    expect(validateCapacityEvidence({ ...declaration, sign_off: { ...declaration.sign_off, [field]: fieldValue } }, { expectedReleaseId: 'release-1', expectedProfile: 'no_load', now: new Date('2026-09-22T02:00:00Z') }))
      .toContain(`no_load sign_off contains unsupported fields: ${field}`)
  })
  it('requires software and data bindings when evidence is used as a release input', () => {
    const value = { ...base, software_version: undefined, data_version: undefined }
    expect(validateCapacityEvidence(value, { requireEvidenceBinding: true })).toEqual(expect.arrayContaining([
      'software_version is required for evidence binding',
      'data_version is required for evidence binding',
    ]))
  })
  it('accepts a complete real-cloud pilot report', () => expect(validateCapacityEvidence(base, { requireCloudGate: true })).toEqual([]))
  it('rejects a report that does not meet the target profile', () => expect(validateCapacityEvidence({ ...base, profile: 'target_500' }, { requireCloudGate: true }).some(error => error.includes('workspaces'))).toBe(true))
  it('accepts the intermediate wave profiles when their thresholds are met', () => {
    expect(validateCapacityEvidence({ ...base, profile: 'wave_100', tenant: { ...base.tenant, workspace_count: 100 }, metrics: { ...base.metrics, workspaces: 100, client_connections: 300, sustained_rps: 60, burst_rps: 120, async_jobs_per_minute: 100 } }, { requireCloudGate: true })).toEqual([])
    expect(validateCapacityEvidence({ ...base, profile: 'wave_250', tenant: { ...base.tenant, workspace_count: 250 }, metrics: { ...base.metrics, workspaces: 250, client_connections: 375, sustained_rps: 75, burst_rps: 150, async_jobs_per_minute: 250 } }, { requireCloudGate: true })).toEqual([])
  })
  it('rejects mock-only evidence as a real-cloud report', () => expect(validateCapacityEvidence({ ...base, platform_mock_ratio: 1 }, { requireCloudGate: true })).toContain('cloud gate requires zero platform/model mock ratio'))
  it('rejects non-finite mock ratios instead of allowing malformed evidence', () => {
    for (const field of ['platform_mock_ratio', 'model_mock_ratio'] as const) {
      expect(validateCapacityEvidence({ ...base, [field]: Number.NaN }, { requireCloudGate: true })).toContain(`${field} must be between 0 and 1`)
    }
  })
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
  it('requires duration, tenant, fault and steady-state evidence for cloud gates', () => {
    for (const field of ['duration', 'tenant', 'fault', 'steady_state'] as const) {
      const value = { ...base, [field]: undefined }
      expect(validateCapacityEvidence(value, { requireCloudGate: true, now: new Date('2026-08-24T00:00:00Z') })).toContain(`${field} is required`)
    }
  })
  it('rejects inconsistent duration and tenant evidence', () => {
    const value = { ...base, duration: { ...base.duration, sustained_minutes: 29 }, tenant: { ...base.tenant, workspace_count: 49 } }
    expect(validateCapacityEvidence(value, { requireCloudGate: true, now: new Date('2026-08-24T00:00:00Z') })).toEqual(expect.arrayContaining([
      'duration.sustained_minutes must match metrics.sustained_duration_minutes',
      'tenant.workspace_count must match metrics.workspaces',
    ]))
  })
  it('rejects missing fault recovery, steady state, and expired evidence', () => {
    const value = { ...base, expires_at: '2026-08-23T06:00:00Z', fault: { ...base.fault, passed: false }, steady_state: { ...base.steady_state, queue_converged: false } }
    expect(validateCapacityEvidence(value, { requireCloudGate: true, now: new Date('2026-08-24T00:00:00Z') })).toEqual(expect.arrayContaining([
      'capacity evidence is expired', 'fault.passed must be true', 'steady_state.queue_converged must be true',
    ]))
  })
  it('rejects duplicate fault scenarios after trimming names', () => {
    const value = { ...base, fault: { ...base.fault, scenarios: ['redis_restart', ' redis_restart '] } }
    expect(validateCapacityEvidence(value, { requireCloudGate: true })).toContain('fault.scenarios must contain unique scenario names')
  })

  it('accepts the on-disk example fixture through the real CLI entrypoint', () => {
    const result = runGate(['--file', CAPACITY_FIXTURE])
    expect(result.error).toBeUndefined()
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain(`capacity evidence schema passed: ${CAPACITY_FIXTURE}`)
    // The fixture is not real-cloud evidence and the CLI must say so.
    expect(result.stdout).toContain('fixture/non-production validation only')
  })

  it('requires an explicit --file rather than defaulting to the example fixture', () => {
    const result = runGate([])
    expect(result.status, result.stderr).toBe(2)
    expect(result.stderr).toContain('--file is required')
    expect(result.stdout).not.toContain('passed')
  })
})
