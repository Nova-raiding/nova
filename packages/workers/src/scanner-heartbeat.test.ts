import { describe, expect, it } from 'vitest'
import { aggregateScannerHeartbeats, assertClamAvExecutionAdmission, createScannerHeartbeat, parseClamAvVersion, scannerHeartbeatKey } from './scanner-heartbeat.js'

const now = new Date('2026-08-30T10:00:00.000Z')
const thresholds = { ttlSeconds: 15, definitionsMaxAgeSeconds: 86_400, eicarMaxAgeSeconds: 900, callbackMaxAgeSeconds: 86_400 }

function healthy(instanceId: string) {
  return createScannerHeartbeat({ instanceId, now, thresholds, checks: { databaseReady: true, redisReady: true, apiReady: true }, clamav: { reachable: true, ...parseClamAvVersion('ClamAV 1.4.2/28108/Sat Aug 30 09:30:00 2026', now) }, eicar: { passed: true, checkedAt: '2026-08-30T09:59:00.000Z', signature: 'Eicar-Test-Signature' }, callback: { configured: true, capable: true, lastAcceptedAt: '2026-08-30T09:58:00.000Z' }, queue: { backlog: 2, deadLetter: 0 } })
}

describe('scanner heartbeat contract', () => {
  it('parses engine and definition freshness from clamd VERSION', () => {
    expect(parseClamAvVersion('ClamAV 1.4.2/28108/Sat Aug 30 09:30:00 2026', now)).toEqual({ engineVersion: '1.4.2', definitionsVersion: '28108', definitionsPublishedAt: '2026-08-30T09:30:00.000Z', definitionsAgeSeconds: 1800 })
    expect(parseClamAvVersion('ClamAV 1.4.6/28110/Tue Sep  1 06:26:54 2026', new Date('2026-09-01T07:00:00.000Z'))).toEqual({ engineVersion: '1.4.6', definitionsVersion: '28110', definitionsPublishedAt: '2026-09-01T06:26:54.000Z', definitionsAgeSeconds: 1986 })
  })

  it('admits only strictly parsed definitions inside the execution freshness window', () => {
    expect(assertClamAvExecutionAdmission('ClamAV 1.4.2/28108/Sat Aug 30 09:30:00 2026', { now, definitionsMaxAgeSeconds: 1800 })).toMatchObject({ definitionsVersion: '28108', definitionsAgeSeconds: 1800 })
    expect(() => assertClamAvExecutionAdmission('ClamAV 1.4.2/28108/Sat Aug 30 09:30:00 2026', { now, definitionsMaxAgeSeconds: 1799 })).toThrow(expect.objectContaining({ code: 'CLAMAV_DEFINITIONS_STALE', retryable: true }))
    expect(() => assertClamAvExecutionAdmission('ClamAV malformed', { now, definitionsMaxAgeSeconds: 86_400 })).toThrow(expect.objectContaining({ code: 'CLAMAV_VERSION_INVALID', retryable: true }))
  })

  it('fails closed when EICAR, definitions, callback or dependencies are stale', () => {
    const base = healthy('scan-a')
    expect(base.ready).toBe(true)
    expect(createScannerHeartbeat({ instanceId: 'scan-a', now, thresholds, checks: base.checks, clamav: base.clamav, eicar: { passed: false }, callback: base.callback, queue: base.queue }).ready).toBe(false)
    expect(createScannerHeartbeat({ instanceId: 'scan-a', now, thresholds, checks: base.checks, clamav: { ...base.clamav, definitionsAgeSeconds: 90_000 }, eicar: base.eicar, callback: base.callback, queue: base.queue }).ready).toBe(false)
    expect(createScannerHeartbeat({ instanceId: 'scan-a', now, thresholds, checks: base.checks, clamav: base.clamav, eicar: base.eicar, callback: { configured: true, capable: false }, queue: base.queue }).ready).toBe(false)
    expect(createScannerHeartbeat({ instanceId: 'scan-a', now, thresholds, checks: base.checks, clamav: base.clamav, eicar: base.eicar, callback: base.callback, queue: { backlog: 0, deadLetter: 1 } }).ready).toBe(false)
  })

  it('fails closed and records malformed queue evidence instead of coercing it to healthy', () => {
    const base = healthy('scan-a')
    for (const queue of [{ backlog: -1, deadLetter: 0 }, { backlog: Number.NaN, deadLetter: 0 }, { backlog: 0, deadLetter: 1.5 }]) {
      const heartbeat = createScannerHeartbeat({ instanceId: 'scan-a', now, thresholds, checks: base.checks, clamav: base.clamav, eicar: base.eicar, callback: base.callback, queue })
      expect(heartbeat.ready).toBe(false)
      expect(heartbeat.failure).toMatchObject({ code: 'SCANNER_QUEUE_EVIDENCE_INVALID' })
    }
  })

  it('aggregates two replicas, excludes expired records and exposes degradation', () => {
    const first = healthy('scan-a')
    const second = { ...healthy('scan-b'), ready: false, failure: { code: 'CLAMAV_UNREACHABLE', message: 'connection failed' } }
    const expired = { ...healthy('scan-old'), expiresAt: '2026-08-30T09:59:59.000Z' }
    expect(aggregateScannerHeartbeats([first, second, expired], { now })).toMatchObject({ ready: true, degraded: true, liveInstances: 2, readyInstances: 1, backlog: 2, deadLetter: 0 })
    expect(aggregateScannerHeartbeats([first, second], { now, minimumReadyInstances: 2 })).toMatchObject({ ready: false, reasons: expect.arrayContaining(['SCANNER_READY_REPLICA_QUORUM_UNMET']) })
  })

  it('uses a bounded Redis key namespace', () => {
    expect(scannerHeartbeatKey('scanner-pod-1')).toBe('merchant:scanner:heartbeats:v1:scanner-pod-1')
    expect(() => scannerHeartbeatKey('../bad')).toThrow('SCANNER_INSTANCE_ID_INVALID')
  })
})
