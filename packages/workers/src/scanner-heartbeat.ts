export const SCANNER_HEARTBEAT_SCHEMA = 'scanner-heartbeat/1.0' as const
export const SCANNER_HEARTBEAT_INDEX_KEY = 'merchant:scanner:heartbeats:v1'

export interface ScannerHeartbeat {
  schemaVersion: typeof SCANNER_HEARTBEAT_SCHEMA
  instanceId: string
  observedAt: string
  expiresAt: string
  ready: boolean
  /** True when the scanner can safely execute a recovery scan. Unlike the
   * general readiness bit, an existing dead letter does not make this false;
   * the recovery path is what resolves that evidence. */
  recoveryCapable: boolean
  checks: {
    databaseReady: boolean
    redisReady: boolean
    apiReady: boolean
  }
  clamav: {
    reachable: boolean
    engineVersion?: string
    definitionsVersion?: string
    definitionsPublishedAt?: string
    definitionsAgeSeconds?: number
  }
  eicar: {
    passed: boolean
    checkedAt?: string
    ageSeconds?: number
    signature?: string
  }
  callback: {
    configured: boolean
    capable: boolean
    lastAcceptedAt?: string
    ageSeconds?: number
  }
  queue: {
    backlog: number
    deadLetter: number
  }
  failure?: { code: string; message: string }
}

export interface ScannerHeartbeatThresholds {
  ttlSeconds: number
  definitionsMaxAgeSeconds: number
  eicarMaxAgeSeconds: number
  callbackMaxAgeSeconds: number
  minimumReadyInstances: number
}

export interface ScannerHeartbeatAggregate {
  ready: boolean
  degraded: boolean
  observedAt: string
  readyInstances: number
  liveInstances: number
  minimumReadyInstances: number
  backlog: number
  deadLetter: number
  newestDefinitionsVersion?: string
  latestEicarAt?: string
  latestCallbackAcceptedAt?: string
  instances: ScannerHeartbeat[]
  reasons: string[]
}

const isoMs = (value: string | undefined): number | undefined => {
  if (!value) return undefined
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

const ageSeconds = (nowMs: number, value: string | undefined): number | undefined => {
  const parsed = isoMs(value)
  return parsed === undefined ? undefined : Math.max(0, Math.floor((nowMs - parsed) / 1000))
}

/** Parses the clamd VERSION response without trusting locale-specific Date parsing. */
export function parseClamAvVersion(raw: string, now = new Date()): Pick<ScannerHeartbeat['clamav'], 'engineVersion' | 'definitionsVersion' | 'definitionsPublishedAt' | 'definitionsAgeSeconds'> {
  const match = /^ClamAV ([^/\s]+)\/(\d+)\/(?:[A-Za-z]{3} )?([A-Za-z]{3}) (\d{1,2}) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/u.exec(raw.trim())
  if (!match) throw new Error('CLAMAV_VERSION_INVALID')
  const months: Record<string, number> = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 }
  const month = months[match[3]!]
  if (month === undefined) throw new Error('CLAMAV_DEFINITIONS_DATE_INVALID')
  const publishedMs = Date.UTC(Number(match[8]), month, Number(match[4]), Number(match[5]), Number(match[6]), Number(match[7]))
  if (!Number.isFinite(publishedMs)) throw new Error('CLAMAV_DEFINITIONS_DATE_INVALID')
  const publishedAt = new Date(publishedMs).toISOString()
  return {
    engineVersion: match[1],
    definitionsVersion: match[2],
    definitionsPublishedAt: publishedAt,
    definitionsAgeSeconds: Math.max(0, Math.floor((now.getTime() - publishedMs) / 1000)),
  }
}

export function assertClamAvExecutionAdmission(raw: string, input: { now?: Date; definitionsMaxAgeSeconds: number }): ReturnType<typeof parseClamAvVersion> {
  let parsed: ReturnType<typeof parseClamAvVersion>
  try {
    parsed = parseClamAvVersion(raw, input.now)
  } catch (error) {
    throw Object.assign(error instanceof Error ? error : new Error(String(error)), { code: 'CLAMAV_VERSION_INVALID', retryable: true })
  }
  const now = input.now ?? new Date()
  const publishedAt = Date.parse(parsed.definitionsPublishedAt!)
  const ageSeconds = Math.floor((now.getTime() - publishedAt) / 1000)
  if (!Number.isFinite(ageSeconds) || ageSeconds < 0 || ageSeconds > input.definitionsMaxAgeSeconds) {
    throw Object.assign(new Error('ClamAV definitions are outside the allowed freshness window'), { code: 'CLAMAV_DEFINITIONS_STALE', retryable: true })
  }
  return { ...parsed, definitionsAgeSeconds: ageSeconds }
}

export function createScannerHeartbeat(input: {
  instanceId: string
  now?: Date
  thresholds: Omit<ScannerHeartbeatThresholds, 'minimumReadyInstances'>
  checks: ScannerHeartbeat['checks']
  clamav: ScannerHeartbeat['clamav']
  eicar: Omit<ScannerHeartbeat['eicar'], 'ageSeconds'>
  callback: Omit<ScannerHeartbeat['callback'], 'ageSeconds'>
  queue: ScannerHeartbeat['queue']
  failure?: ScannerHeartbeat['failure']
}): ScannerHeartbeat {
  const now = input.now ?? new Date()
  const nowMs = now.getTime()
  const eicarAge = ageSeconds(nowMs, input.eicar.checkedAt)
  const callbackAge = ageSeconds(nowMs, input.callback.lastAcceptedAt)
  const definitionsFresh = input.clamav.definitionsAgeSeconds !== undefined && input.clamav.definitionsAgeSeconds <= input.thresholds.definitionsMaxAgeSeconds
  const eicarFresh = input.eicar.passed && eicarAge !== undefined && eicarAge <= input.thresholds.eicarMaxAgeSeconds
  const callbackFresh = input.callback.configured && input.callback.capable && callbackAge !== undefined && callbackAge <= input.thresholds.callbackMaxAgeSeconds
  // Scanner dead letters are unresolved user uploads, not a harmless metric.
  // Keep the worker out of readiness until they are redriven or explicitly
  // resolved so uploads cannot remain "processing" behind a green service.
  const queueHealthy = Number.isFinite(input.queue.deadLetter) && input.queue.deadLetter === 0
  const recoveryCapable = Object.values(input.checks).every(Boolean) && input.clamav.reachable && definitionsFresh && eicarFresh && callbackFresh && !input.failure
  const ready = recoveryCapable && queueHealthy
  return {
    schemaVersion: SCANNER_HEARTBEAT_SCHEMA,
    instanceId: input.instanceId,
    observedAt: now.toISOString(),
    expiresAt: new Date(nowMs + input.thresholds.ttlSeconds * 1000).toISOString(),
    ready,
    recoveryCapable,
    checks: { ...input.checks },
    clamav: { ...input.clamav },
    eicar: { ...input.eicar, ...(eicarAge !== undefined ? { ageSeconds: eicarAge } : {}) },
    callback: { ...input.callback, ...(callbackAge !== undefined ? { ageSeconds: callbackAge } : {}) },
    queue: { backlog: Math.max(0, Math.floor(input.queue.backlog)), deadLetter: Math.max(0, Math.floor(input.queue.deadLetter)) },
    ...(input.failure ? { failure: { ...input.failure } } : {}),
  }
}

export function aggregateScannerHeartbeats(raw: readonly ScannerHeartbeat[], input: { now?: Date; minimumReadyInstances?: number } = {}): ScannerHeartbeatAggregate {
  const now = input.now ?? new Date()
  const nowMs = now.getTime()
  const minimumReadyInstances = Math.max(1, Math.floor(input.minimumReadyInstances ?? 1))
  const instances = raw
    .filter(item => item.schemaVersion === SCANNER_HEARTBEAT_SCHEMA && isoMs(item.expiresAt) !== undefined && isoMs(item.expiresAt)! > nowMs)
    .sort((left, right) => left.instanceId.localeCompare(right.instanceId))
  const ready = instances.filter(item => item.ready)
  const reasons: string[] = []
  if (instances.length === 0) reasons.push('SCANNER_HEARTBEAT_MISSING')
  if (ready.length < minimumReadyInstances) reasons.push('SCANNER_READY_REPLICA_QUORUM_UNMET')
  for (const instance of instances.filter(item => !item.ready)) reasons.push(`${instance.instanceId}:${instance.failure?.code ?? 'SCANNER_INSTANCE_NOT_READY'}`)
  const latest = (values: Array<string | undefined>) => values.filter((value): value is string => Boolean(value)).sort().at(-1)
  return {
    ready: ready.length >= minimumReadyInstances,
    degraded: instances.length > ready.length,
    observedAt: now.toISOString(),
    readyInstances: ready.length,
    liveInstances: instances.length,
    minimumReadyInstances,
    // Every scanner replica probes the same durable database queue. Summing
    // would multiply one backlog by the replica count; the maximum is the
    // latest conservative view of that shared queue.
    backlog: Math.max(0, ...instances.map(item => item.queue.backlog)),
    deadLetter: Math.max(0, ...instances.map(item => item.queue.deadLetter)),
    ...(latest(instances.map(item => item.clamav.definitionsVersion)) ? { newestDefinitionsVersion: latest(instances.map(item => item.clamav.definitionsVersion)) } : {}),
    ...(latest(instances.map(item => item.eicar.checkedAt)) ? { latestEicarAt: latest(instances.map(item => item.eicar.checkedAt)) } : {}),
    ...(latest(instances.map(item => item.callback.lastAcceptedAt)) ? { latestCallbackAcceptedAt: latest(instances.map(item => item.callback.lastAcceptedAt)) } : {}),
    instances,
    reasons,
  }
}

export function scannerHeartbeatKey(instanceId: string): string {
  if (!/^[A-Za-z0-9._:-]{1,160}$/u.test(instanceId)) throw new Error('SCANNER_INSTANCE_ID_INVALID')
  return `${SCANNER_HEARTBEAT_INDEX_KEY}:${instanceId}`
}
