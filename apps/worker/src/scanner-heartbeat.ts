import { unlink, writeFile } from 'node:fs/promises'
import { createScannerHeartbeat, parseClamAvVersion, type ScannerHeartbeat, type ScannerHeartbeatThresholds } from '../../../packages/workers/src/scanner-heartbeat.js'
import type { ClamAvScanner } from './clamav-scanner.js'
import type { ScannerHeartbeatRedisPort } from './redis-transport.js'

export const EICAR_SELF_TEST_BYTES = Buffer.from('X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*', 'ascii')

export interface ScannerHeartbeatControllerOptions {
  instanceId: string
  readyFile: string
  scanner: Pick<ClamAvScanner, 'version' | 'scan'>
  redis: ScannerHeartbeatRedisPort
  thresholds: ScannerHeartbeatThresholds
  intervalMs: number
  callbackConfigured: boolean
  dependencyProbe: () => Promise<{ databaseReady: boolean; apiReady: boolean }>
  queueProbe: () => Promise<{ backlog: number; deadLetter: number }>
  now?: () => Date
  onHeartbeat?: (heartbeat: ScannerHeartbeat) => void
}

export class ScannerHeartbeatController {
  private timer?: ReturnType<typeof setInterval>
  private inFlight?: Promise<ScannerHeartbeat>
  private lastEicar?: ScannerHeartbeat['eicar']
  private latestHeartbeat?: ScannerHeartbeat

  constructor(private readonly options: ScannerHeartbeatControllerOptions) {}

  async tick(): Promise<ScannerHeartbeat> {
    if (this.inFlight) return this.inFlight
    this.inFlight = this.probe().finally(() => { this.inFlight = undefined })
    return this.inFlight
  }

  async start(): Promise<ScannerHeartbeat> {
    const first = await this.tick()
    this.timer = setInterval(() => { void this.tick().catch(() => undefined) }, this.options.intervalMs)
    this.timer.unref?.()
    return first
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    await this.inFlight?.catch(() => undefined)
    await unlink(this.options.readyFile).catch(() => undefined)
    await this.options.redis.remove(this.options.instanceId).catch(() => undefined)
  }

  /**
   * Business scans may run only after the same live probes used by readiness
   * have proved the API dependencies, ClamAV definitions, and EICAR behavior.
   * Callback history and existing dead letters remain readiness gates, but do
   * not deadlock a fresh scanner or prevent it from draining unrelated work.
   */
  canProcessScans(): boolean {
    const heartbeat = this.latestHeartbeat
    if (!heartbeat || !Object.values(heartbeat.checks).every(Boolean) || !heartbeat.clamav.reachable || !heartbeat.clamav.engineVersion || !heartbeat.clamav.definitionsVersion || !heartbeat.clamav.definitionsPublishedAt || !heartbeat.eicar.passed || !heartbeat.callback.configured || heartbeat.failure) return false
    const now = this.options.now?.() ?? new Date()
    const eicarAt = heartbeat.eicar.checkedAt ? Date.parse(heartbeat.eicar.checkedAt) : Number.NaN
    if (!Number.isFinite(eicarAt) || now.getTime() - eicarAt > this.options.thresholds.eicarMaxAgeSeconds * 1000) return false
    const publishedAt = Date.parse(heartbeat.clamav.definitionsPublishedAt)
    const definitionsAgeMs = now.getTime() - publishedAt
    return Number.isFinite(publishedAt) && definitionsAgeMs >= 0 && definitionsAgeMs <= this.options.thresholds.definitionsMaxAgeSeconds * 1000
  }

  private async probe(): Promise<ScannerHeartbeat> {
    const now = this.options.now?.() ?? new Date()
    let heartbeat: ScannerHeartbeat
    const checks: ScannerHeartbeat['checks'] = { databaseReady: false, apiReady: false, redisReady: true }
    let clamav: ScannerHeartbeat['clamav'] = { reachable: false }
    let callback: Omit<ScannerHeartbeat['callback'], 'ageSeconds'> = { configured: this.options.callbackConfigured, capable: false }
    let queue: ScannerHeartbeat['queue'] = { backlog: 0, deadLetter: 0 }
    try {
      const dependency = await this.options.dependencyProbe()
      if (!dependency.databaseReady || !dependency.apiReady) throw Object.assign(new Error('scanner database or API readiness dependency is unavailable'), { code: 'SCANNER_DEPENDENCY_UNAVAILABLE' })
      checks.databaseReady = dependency.databaseReady
      checks.apiReady = dependency.apiReady
      const [lastAcceptedAt, queueResult] = await Promise.all([this.options.redis.lastCallbackAcceptedAt(this.options.instanceId), this.options.queueProbe()])
      callback = { configured: this.options.callbackConfigured, capable: Boolean(lastAcceptedAt), ...(lastAcceptedAt ? { lastAcceptedAt } : {}) }
      queue = queueResult
      const version = await this.options.scanner.version()
      clamav = { reachable: true, ...parseClamAvVersion(version, now) }
      const previousEicarAt = this.lastEicar?.checkedAt ? Date.parse(this.lastEicar.checkedAt) : 0
      if (!this.lastEicar?.passed || now.getTime() - previousEicarAt >= this.options.thresholds.eicarMaxAgeSeconds * 500) {
        const result = await this.options.scanner.scan(EICAR_SELF_TEST_BYTES)
        if (result.status !== 'infected' || result.signature !== 'Eicar-Test-Signature') throw Object.assign(new Error('ClamAV EICAR self-test did not return Eicar-Test-Signature'), { code: 'CLAMAV_EICAR_SELF_TEST_FAILED' })
        this.lastEicar = { passed: true, checkedAt: now.toISOString(), signature: result.signature }
      }
      heartbeat = createScannerHeartbeat({
        instanceId: this.options.instanceId,
        now,
        thresholds: this.options.thresholds,
        checks,
        clamav,
        eicar: this.lastEicar,
        callback,
        queue,
      })
    } catch (error) {
      await unlink(this.options.readyFile).catch(() => undefined)
      const candidate = error as { code?: unknown; message?: unknown }
      heartbeat = createScannerHeartbeat({
        instanceId: this.options.instanceId,
        now,
        thresholds: this.options.thresholds,
        checks,
        clamav,
        eicar: this.lastEicar ?? { passed: false },
        callback,
        queue,
        failure: { code: typeof candidate.code === 'string' ? candidate.code : 'SCANNER_HEARTBEAT_PROBE_FAILED', message: typeof candidate.message === 'string' ? candidate.message : String(error) },
      })
    }
    try {
      await this.options.redis.publish(heartbeat, this.options.thresholds.ttlSeconds)
    } catch (error) {
      await unlink(this.options.readyFile).catch(() => undefined)
      throw error
    }
    this.latestHeartbeat = heartbeat
    if (heartbeat.ready) await writeFile(this.options.readyFile, JSON.stringify(heartbeat))
    else await unlink(this.options.readyFile).catch(() => undefined)
    this.options.onHeartbeat?.(heartbeat)
    return heartbeat
  }
}
