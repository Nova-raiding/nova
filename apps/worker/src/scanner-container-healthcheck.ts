import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SCANNER_HEARTBEAT_SCHEMA, type ScannerHeartbeat } from '../../../packages/workers/src/scanner-heartbeat.js'

export interface ScannerReadinessMarker {
  state?: unknown
  heartbeat?: Partial<ScannerHeartbeat>
}

/**
 * Container health means the scanner process can safely recover scan work.
 * API /readyz uses heartbeat.ready and remains stricter until callback evidence
 * and queue health prove normal business readiness.
 */
export function scannerContainerCanRecover(marker: ScannerReadinessMarker, nowMs = Date.now()): boolean {
  const heartbeat = marker.heartbeat
  if (!heartbeat || heartbeat.schemaVersion !== SCANNER_HEARTBEAT_SCHEMA || typeof heartbeat.instanceId !== 'string' || !heartbeat.instanceId) return false
  if (!heartbeat.checks || heartbeat.checks.databaseReady !== true || heartbeat.checks.apiReady !== true || heartbeat.checks.redisReady !== true
    || heartbeat.clamav?.reachable !== true || heartbeat.eicar?.passed !== true || heartbeat.callback?.configured !== true
    || heartbeat.failure !== undefined || !Number.isSafeInteger(heartbeat.queue?.backlog) || heartbeat.queue!.backlog < 0
    || !Number.isSafeInteger(heartbeat.queue?.deadLetter) || heartbeat.queue!.deadLetter < 0) return false
  const observedAt = typeof heartbeat.observedAt === 'string' ? Date.parse(heartbeat.observedAt) : Number.NaN
  const expiresAt = typeof heartbeat.expiresAt === 'string' ? Date.parse(heartbeat.expiresAt) : Number.NaN
  if (!Number.isFinite(observedAt) || observedAt > nowMs || !Number.isFinite(expiresAt) || expiresAt <= nowMs || expiresAt <= observedAt) return false

  const businessReady = marker.state === 'ready' && heartbeat.ready === true && heartbeat.recoveryCapable === true
  const recoveryOnly = marker.state === 'recovery' && heartbeat.ready === false && heartbeat.recoveryCapable === true
  return businessReady || recoveryOnly
}

function runHealthcheck(): void {
  try {
    const readyFile = process.env.WORKER_READY_FILE
    if (!readyFile) process.exit(1)
    const marker = JSON.parse(readFileSync(readyFile, 'utf8')) as ScannerReadinessMarker
    if (!scannerContainerCanRecover(marker)) process.exit(1)
  } catch {
    process.exit(1)
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) runHealthcheck()
