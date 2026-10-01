import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { validateCapacityEvidence } from './capacity-evidence-gate.js'
import { collectReleaseMetadata, validateReleaseMetadata } from './release-metadata-gate.js'

const baseCapacityEvidence = {
  schema_version: '1',
  status: 'pass',
  release_id: 'release-1',
  software_version: 'rc-1',
  config_version: 'config-1',
  data_version: 'fixture-v1',
  environment: 'preproduction',
  target_url: 'https://capacity.example.com',
  started_at: '2026-08-23T00:00:00Z',
  ended_at: '2026-08-23T06:00:00Z',
  expires_at: '2026-09-30T00:00:00Z',
  profile: 'pilot_50',
  cloud_gate: true,
  raw_metrics_ref: 'artifact://metrics/1',
  platform_mock_ratio: 0,
  model_mock_ratio: 0,
  duration: { sustained_minutes: 30, burst_seconds: 60, stability_hours: 6 },
  tenant: { workspace_count: 50, noise_multiplier: 10, isolation_verified: true, max_p95_degradation_percent: 20 },
  fault: { injected: true, scenarios: ['redis_restart', 'db_pool_exhaustion', 'platform_timeout'], passed: true },
  steady_state: { verified: true, queue_converged: true, stability_hours: 6 },
  sign_off: { verified_by: 'qa', verified_at: '2026-08-23T06:00:00Z' },
  metrics: {
    workspaces: 50,
    client_connections: 150,
    sustained_rps: 30,
    sustained_duration_minutes: 30,
    burst_rps: 60,
    burst_duration_seconds: 60,
    async_jobs_per_minute: 50,
    p95_ms: 100,
    p99_ms: 150,
    error_count: 0,
    duplicate_writes: 0,
    lost_jobs: 0,
    fairness_p95_degradation_percent: 10,
    stability_hours: 6,
  },
} as const

describe('release evidence fail-closed coverage', () => {
  it('fails release metadata when declared counts or migration tail binding drift', () => {
    const snapshot = collectReleaseMetadata()
    const migrationTail = Math.max(...snapshot.migrationFiles.map(file => Number(file.slice(0, 3))).filter(Number.isFinite))
    const errors = validateReleaseMetadata({
      ...snapshot,
      declared: {
        ...snapshot.declared,
        merchantBridgeToolCount: 0,
        opsDomainCount: 0,
        expectedMigrationVersion: migrationTail + 1,
      },
    })

    expect(errors).toEqual(expect.arrayContaining([
      'release-metadata merchantBridgeToolCount must be a positive integer',
      'release-metadata opsDomainCount must be a positive integer',
      'release-metadata expectedMigrationVersion must match the migration chain tail',
    ]))
  })

  it('fails pilot release evidence closed when workspace and profile counts shrink below the 50-workspace floor', () => {
    const errors = validateCapacityEvidence({
      ...baseCapacityEvidence,
      tenant: { ...baseCapacityEvidence.tenant, workspace_count: 0 },
      metrics: { ...baseCapacityEvidence.metrics, workspaces: 49 },
    }, {
      requireCloudGate: true,
      expectedReleaseId: 'release-1',
      expectedProfile: 'pilot_50',
      now: new Date('2026-08-24T00:00:00Z'),
    })

    expect(errors).toEqual(expect.arrayContaining([
      'metrics.workspaces is below pilot_50 threshold 50',
      'tenant.workspace_count must match metrics.workspaces',
      'tenant.workspace_count must be a positive safe integer',
    ]))
  })

  it('locks the production ops gate to fail closed on rollback and observability prerequisites before pass output', () => {
    const source = readFileSync(new URL('./production-ops-gate.ts', import.meta.url), 'utf8')
    const pass = source.indexOf("status: 'pass'")

    expect(source).toContain("'infra/scripts/rollback.sh'")
    expect(source).toContain("'回滚'")
    expect(source).toContain("'CONFIRM_ROLLBACK=YES'")
    expect(source).toContain("'traces:'")
    expect(source).toContain("'metrics:'")
    expect(source).toContain("'logs:'")
    expect(source).toContain("'attributes/redact'")
    expect(source).toContain("'MerchantApiHigh5xx'")
    expect(source).toContain("'MerchantOutboxPending'")

    expect(source.indexOf("'CONFIRM_ROLLBACK=YES'")).toBeGreaterThanOrEqual(0)
    expect(source.indexOf("'attributes/redact'")).toBeGreaterThanOrEqual(0)
    expect(source.indexOf("'MerchantOutboxPending'")).toBeGreaterThanOrEqual(0)
    expect(source.indexOf("'CONFIRM_ROLLBACK=YES'")).toBeLessThan(pass)
    expect(source.indexOf("'attributes/redact'")).toBeLessThan(pass)
    expect(source.indexOf("'MerchantOutboxPending'")).toBeLessThan(pass)
  })

  it('redacts Docker Compose render failures before they can reach release output', () => {
    const source = readFileSync(new URL('./production-ops-gate.ts', import.meta.url), 'utf8')
    expect(source).toContain('try {')
    expect(source).toContain('} catch {')
    expect(source).toContain('production ops gate Compose render failed')
    expect(source).not.toContain('error.stdout')
    expect(source).not.toContain('error.stderr')
  })

  it('keeps worker credentials and protected Compose diagnostics out of release output', () => {
    const productionGate = readFileSync(new URL('./production-ops-gate.ts', import.meta.url), 'utf8')
    const composeGate = readFileSync(new URL('./compose-resource-gate.ts', import.meta.url), 'utf8')
    const renderer = readFileSync(new URL('../infra/scripts/render-ecs-production-compose.sh', import.meta.url), 'utf8')
    const launcher = readFileSync(new URL('../infra/scripts/launch-preflight.sh', import.meta.url), 'utf8')
    const deployer = readFileSync(new URL('../infra/scripts/deploy-verified-ecs-compose.sh', import.meta.url), 'utf8')
    const rollback = readFileSync(new URL('../infra/scripts/rollback-ecs-compose.sh', import.meta.url), 'utf8')

    expect(productionGate).toContain('production ops gate worker credential contract failed')
    expect(productionGate).not.toContain('assert.equal(workerEnv.WORKER_API_TOKEN')
    expect(productionGate).not.toContain('assert.equal(workerEnv.WORKER_API_SIGNING_SECRET')
    expect(composeGate).toContain('compose resource gate worker credential contract failed')
    expect(composeGate).not.toContain('assert.equal(workerEnv.WORKER_API_TOKEN')
    expect(composeGate).not.toContain('assert.equal(workerEnv.WORKER_API_SIGNING_SECRET')
    expect(renderer).toContain('2>"$compose_error"')
    expect(renderer).toContain('protected diagnostics were withheld')
    expect(launcher).toContain('>"$ops_gate_log" 2>&1')
    expect(launcher).toContain('protected diagnostics were withheld')
    expect(deployer).toContain('config --format json 2>/dev/null')
    expect(rollback).toContain('config) docker compose')
    expect(rollback).toContain('"$@" 2>/dev/null')
  })
})
