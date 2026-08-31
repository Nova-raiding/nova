import { mkdtemp, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { ScannerHeartbeat } from '../../../packages/workers/src/scanner-heartbeat.js'
import { EICAR_SELF_TEST_BYTES, ScannerHeartbeatController } from './scanner-heartbeat.js'

describe('scanner heartbeat controller', () => {
  it('publishes real probe evidence and immediately revokes the ready marker on dependency loss', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'scanner-heartbeat-'))
    const readyFile = join(directory, 'ready')
    const published: ScannerHeartbeat[] = []
    let dependencyReady = true
    const redis = {
      publish: vi.fn(async (heartbeat: ScannerHeartbeat) => { published.push(heartbeat) }), remove: vi.fn(async () => undefined),
      recordCallbackAccepted: vi.fn(async () => undefined), lastCallbackAcceptedAt: vi.fn(async () => '2026-08-30T09:58:00.000Z'),
    }
    const scanner = {
      version: vi.fn(async () => 'ClamAV 1.4.2/28108/Sat Aug 30 09:30:00 2026'),
      scan: vi.fn(async (bytes: Buffer) => { expect(bytes.equals(EICAR_SELF_TEST_BYTES)).toBe(true); return { status: 'infected' as const, target: 'stream', signature: 'Eicar-Test-Signature', raw: 'stream: Eicar-Test-Signature FOUND' } }),
    }
    const controller = new ScannerHeartbeatController({ instanceId: 'scan-a', readyFile, scanner, redis, thresholds: { ttlSeconds: 15, definitionsMaxAgeSeconds: 86_400, eicarMaxAgeSeconds: 900, callbackMaxAgeSeconds: 86_400, minimumReadyInstances: 1 }, intervalMs: 5000, callbackConfigured: true, dependencyProbe: async () => ({ databaseReady: dependencyReady, apiReady: dependencyReady }), queueProbe: async () => ({ backlog: 3, deadLetter: 0 }), now: () => new Date('2026-08-30T10:00:00.000Z') })
    expect(controller.canProcessScans()).toBe(false)
    expect((await controller.tick()).ready).toBe(true)
    expect(controller.canProcessScans()).toBe(true)
    expect(redis.lastCallbackAcceptedAt).toHaveBeenCalledWith('scan-a')
    expect(JSON.parse(await readFile(readyFile, 'utf8'))).toMatchObject({ ready: true, queue: { backlog: 3, deadLetter: 0 } })
    dependencyReady = false
    expect((await controller.tick()).ready).toBe(false)
    expect(controller.canProcessScans()).toBe(false)
    await expect(stat(readyFile)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(published.at(-1)).toMatchObject({ ready: false, failure: { code: 'SCANNER_DEPENDENCY_UNAVAILABLE' } })
  })

  it('preserves successful dependency and queue observations when ClamAV fails', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'scanner-heartbeat-'))
    const controller = new ScannerHeartbeatController({ instanceId: 'scan-c', readyFile: join(directory, 'ready'), scanner: { version: async () => { throw Object.assign(new Error('connection failed'), { code: 'CLAMAV_CONNECTION_ERROR' }) }, scan: async () => ({ status: 'clean', target: 'stream', raw: 'OK' }) }, redis: { publish: async () => undefined, remove: async () => undefined, recordCallbackAccepted: async () => undefined, lastCallbackAcceptedAt: async () => '2026-08-30T09:58:00.000Z' }, thresholds: { ttlSeconds: 15, definitionsMaxAgeSeconds: 86_400, eicarMaxAgeSeconds: 900, callbackMaxAgeSeconds: 86_400, minimumReadyInstances: 1 }, intervalMs: 5000, callbackConfigured: true, dependencyProbe: async () => ({ databaseReady: true, apiReady: true }), queueProbe: async () => ({ backlog: 4, deadLetter: 2 }), now: () => new Date('2026-08-30T10:00:00.000Z') })
    expect(await controller.tick()).toMatchObject({ ready: false, checks: { databaseReady: true, apiReady: true, redisReady: true }, clamav: { reachable: false }, callback: { capable: true }, queue: { backlog: 4, deadLetter: 2 }, failure: { code: 'CLAMAV_CONNECTION_ERROR' } })
  })

  it('stays unready until a recent accepted API callback exists', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'scanner-heartbeat-'))
    const controller = new ScannerHeartbeatController({ instanceId: 'scan-b', readyFile: join(directory, 'ready'), scanner: { version: async () => 'ClamAV 1.4.2/28108/Sat Aug 30 09:30:00 2026', scan: async () => ({ status: 'infected', target: 'stream', signature: 'Eicar-Test-Signature', raw: 'FOUND' }) }, redis: { publish: async () => undefined, remove: async () => undefined, recordCallbackAccepted: async () => undefined, lastCallbackAcceptedAt: async () => undefined }, thresholds: { ttlSeconds: 15, definitionsMaxAgeSeconds: 86_400, eicarMaxAgeSeconds: 900, callbackMaxAgeSeconds: 86_400, minimumReadyInstances: 1 }, intervalMs: 5000, callbackConfigured: true, dependencyProbe: async () => ({ databaseReady: true, apiReady: true }), queueProbe: async () => ({ backlog: 0, deadLetter: 0 }), now: () => new Date('2026-08-30T10:00:00.000Z') })
    expect(await controller.tick()).toMatchObject({ ready: false, callback: { configured: true, capable: false } })
    expect(controller.canProcessScans()).toBe(true)
  })

  it('blocks business scans when ClamAV definitions exceed the freshness threshold', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'scanner-heartbeat-'))
    const controller = new ScannerHeartbeatController({ instanceId: 'scan-stale', readyFile: join(directory, 'ready'), scanner: { version: async () => 'ClamAV 1.4.2/28107/Fri Aug 28 09:30:00 2026', scan: async () => ({ status: 'infected', target: 'stream', signature: 'Eicar-Test-Signature', raw: 'FOUND' }) }, redis: { publish: async () => undefined, remove: async () => undefined, recordCallbackAccepted: async () => undefined, lastCallbackAcceptedAt: async () => '2026-08-30T09:58:00.000Z' }, thresholds: { ttlSeconds: 15, definitionsMaxAgeSeconds: 86_400, eicarMaxAgeSeconds: 900, callbackMaxAgeSeconds: 86_400, minimumReadyInstances: 1 }, intervalMs: 5000, callbackConfigured: true, dependencyProbe: async () => ({ databaseReady: true, apiReady: true }), queueProbe: async () => ({ backlog: 1, deadLetter: 0 }), now: () => new Date('2026-08-30T10:00:00.000Z') })
    expect(await controller.tick()).toMatchObject({ ready: false, clamav: { reachable: true, definitionsAgeSeconds: 174_600 } })
    expect(controller.canProcessScans()).toBe(false)
  })
})
