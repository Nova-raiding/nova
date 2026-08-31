import { describe, expect, it, vi } from 'vitest'
import { SCANNER_HEARTBEAT_SCHEMA, type ScannerHeartbeat } from '../../../packages/workers/src/scanner-heartbeat.js'
import { evaluateScannerHeartbeatReadiness, evaluateScannerRecoveryAdmission, scannerHeartbeatRequiredForProbe } from './server.js'

const now = new Date('2026-08-30T06:00:00.000Z')

function heartbeat(instanceId: string, input: { ready?: boolean; expiresInMs?: number; definitionsVersion?: string; databaseReady?: boolean } = {}): ScannerHeartbeat {
  const ready = input.ready ?? true
  return {
    schemaVersion: SCANNER_HEARTBEAT_SCHEMA,
    instanceId,
    observedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + (input.expiresInMs ?? 15_000)).toISOString(),
    ready,
    recoveryCapable: ready,
    checks: { databaseReady: input.databaseReady ?? true, redisReady: true, apiReady: true },
    clamav: { reachable: true, engineVersion: '1.4.6', definitionsVersion: input.definitionsVersion ?? '28108', definitionsPublishedAt: now.toISOString(), definitionsAgeSeconds: 0 },
    eicar: { passed: true, checkedAt: now.toISOString(), ageSeconds: 0, signature: 'Eicar-Test-Signature' },
    callback: { configured: true, capable: true, lastAcceptedAt: now.toISOString(), ageSeconds: 0 },
    queue: { backlog: 0, deadLetter: 0 },
    ...(!ready || input.databaseReady === false ? { failure: { code: 'SCANNER_DEPENDENCY_UNAVAILABLE', message: 'dependency unavailable' } } : {}),
  }
}

const environment = (overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  NODE_ENV: 'production',
  ASSET_SCANNER_MODE: 'clamav_worker',
  ASSET_SCAN_MIN_DEFINITIONS_VERSION: '28000',
  SCANNER_MINIMUM_READY_INSTANCES: '2',
  ...overrides,
})

describe('scanner heartbeat API readiness', () => {
  it('reads Redis at the probe timestamp and fails closed when no heartbeat exists', async () => {
    const scannerHeartbeats = vi.fn(async () => [] as unknown[])
    const result = await evaluateScannerHeartbeatReadiness({ redis: { scannerHeartbeats }, env: environment(), now })
    expect(scannerHeartbeats).toHaveBeenCalledWith(now.getTime())
    expect(result).toMatchObject({ ready: false, code: 'SCANNER_HEARTBEAT_MISSING', summary: { live_instances: 0, ready_instances: 0, minimum_ready_instances: 2 } })
  })

  it('ignores expired Redis values even when their payload says ready', async () => {
    const expired = heartbeat('scanner-expired', { expiresInMs: -1 })
    const result = await evaluateScannerHeartbeatReadiness({ redis: { scannerHeartbeats: async () => [expired] }, env: environment(), now })
    expect(result).toMatchObject({ ready: false, code: 'SCANNER_HEARTBEAT_MISSING', summary: { live_instances: 0 } })
  })

  it('requires at least two production replicas even when configured lower', async () => {
    const result = await evaluateScannerHeartbeatReadiness({
      redis: { scannerHeartbeats: async () => [heartbeat('scanner-1')] },
      env: environment({ SCANNER_MINIMUM_READY_INSTANCES: '1' }),
      now,
    })
    expect(result).toMatchObject({ ready: false, code: 'SCANNER_READY_REPLICA_QUORUM_UNMET', summary: { live_instances: 1, ready_instances: 1, minimum_ready_instances: 2 } })
  })

  it('accepts two fresh, independent ready replicas and returns only aggregate evidence', async () => {
    const result = await evaluateScannerHeartbeatReadiness({
      redis: { scannerHeartbeats: async () => [heartbeat('scanner-secret-pod-1'), heartbeat('scanner-secret-pod-2')] },
      env: environment(),
      now,
    })
    expect(result).toMatchObject({ ready: true, summary: { live_instances: 2, ready_instances: 2, minimum_ready_instances: 2, newest_definitions_version: '28108' } })
    expect(JSON.stringify(result)).not.toContain('scanner-secret-pod')
    expect(result.summary).not.toHaveProperty('instances')
  })

  it('reports NOT_READY when quorum is live but a dependency or definitions floor fails', async () => {
    const dependencyFailure = await evaluateScannerHeartbeatReadiness({
      redis: { scannerHeartbeats: async () => [heartbeat('scanner-1'), heartbeat('scanner-2', { ready: false, databaseReady: false })] },
      env: environment(),
      now,
    })
    expect(dependencyFailure).toMatchObject({ ready: false, code: 'SCANNER_NOT_READY', summary: { live_instances: 2, ready_instances: 1 } })

    const staleDefinitions = await evaluateScannerHeartbeatReadiness({
      redis: { scannerHeartbeats: async () => [heartbeat('scanner-1'), heartbeat('scanner-2', { definitionsVersion: '27999' })] },
      env: environment(),
      now,
    })
    expect(staleDefinitions).toMatchObject({ ready: false, code: 'SCANNER_NOT_READY', summary: { live_instances: 2, ready_instances: 1 } })
  })

  it('allows recovery-capable scanners to redrive the dead letter that keeps service readiness red', async () => {
    const blocked = { ...heartbeat('scanner-1'), ready: false, recoveryCapable: true, queue: { backlog: 0, deadLetter: 1 } }
    const service = await evaluateScannerHeartbeatReadiness({ redis: { scannerHeartbeats: async () => [blocked] }, env: environment({ NODE_ENV: 'development', SCANNER_MINIMUM_READY_INSTANCES: '1' }), now })
    expect(service).toMatchObject({ ready: false, code: 'SCANNER_NOT_READY', summary: { dead_letter: 1, ready_instances: 0 } })

    const recovery = await evaluateScannerRecoveryAdmission({ redis: { scannerHeartbeats: async () => [blocked] }, env: environment({ NODE_ENV: 'development', SCANNER_MINIMUM_READY_INSTANCES: '1' }), now })
    expect(recovery).toMatchObject({ ready: true, summary: { dead_letter: 1, ready_instances: 1 } })

    const dependencyFailure = { ...blocked, recoveryCapable: false, failure: { code: 'SCANNER_DEPENDENCY_UNAVAILABLE', message: 'database unavailable' } }
    const denied = await evaluateScannerRecoveryAdmission({ redis: { scannerHeartbeats: async () => [dependencyFailure] }, env: environment({ NODE_ENV: 'development', SCANNER_MINIMUM_READY_INSTANCES: '1' }), now })
    expect(denied).toMatchObject({ ready: false, code: 'SCANNER_NOT_READY' })
  })

  it('never couples /healthz to scanner startup while controlled /readyz is gated', () => {
    const env = environment({ NODE_ENV: 'staging' })
    expect(scannerHeartbeatRequiredForProbe('/healthz', env)).toBe(false)
    expect(scannerHeartbeatRequiredForProbe('/readyz', env)).toBe(true)
    expect(scannerHeartbeatRequiredForProbe('/readyz', { ...env, ASSET_SCANNER_MODE: 'disabled' })).toBe(false)
  })
})
