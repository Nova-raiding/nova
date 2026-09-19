import { describe, expect, it, vi } from 'vitest'
import { createServer } from 'node:http'
import {
  authorizeMetricsRequest,
  createWorkerMetricsServer,
  sanitizeErrorCode,
  WorkerMetricsRegistry,
  WORKER_METRICS_PATH,
} from './worker-metrics.js'

/** Every sample line must be well-formed Prometheus text format. */
function assertWellFormed(text: string): void {
  const sample = /^[a-zA-Z_:][a-zA-Z0-9_:]*(?:\{[^{}]*\})? -?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?$/
  for (const line of text.split('\n')) {
    if (line === '' || line.startsWith('#')) continue
    expect(line, `malformed exposition line: ${line}`).toMatch(sample)
  }
}

function seriesValue(text: string, name: string): number | undefined {
  const match = new RegExp(`^${name}\\{[^}]*\\} (-?[0-9.eE+]+)$`, 'mu').exec(text)
  if (!match) return undefined
  const parsed = Number(match[1])
  return Number.isFinite(parsed) ? parsed : undefined
}

describe('sanitizeErrorCode', () => {
  it('keeps ordinary error codes intact', () => {
    expect(sanitizeErrorCode('ECONNREFUSED')).toBe('ECONNREFUSED')
    expect(sanitizeErrorCode('WORKER_QUEUE_DEPTH_EXCEEDED')).toBe('WORKER_QUEUE_DEPTH_EXCEEDED')
    expect(sanitizeErrorCode('OUTBOX_EVENT_NOT_FOUND')).toBe('OUTBOX_EVENT_NOT_FOUND')
  })

  it('collapses anything that could break out of the label value', () => {
    // A quote or newline in a label value would let a thrown error forge extra
    // series in the exposition body, so both must degrade to UNKNOWN.
    expect(sanitizeErrorCode('bad"code')).toBe('UNKNOWN')
    expect(sanitizeErrorCode('bad\ncode')).toBe('UNKNOWN')
    expect(sanitizeErrorCode('bad code')).toBe('UNKNOWN')
    expect(sanitizeErrorCode('bad\\code')).toBe('UNKNOWN')
    expect(sanitizeErrorCode(undefined)).toBe('UNKNOWN')
    expect(sanitizeErrorCode('')).toBe('UNKNOWN')
  })

  it('caps length instead of emitting an unbounded label value', () => {
    expect(sanitizeErrorCode('A'.repeat(200))).toBe('A'.repeat(64))
  })
})

describe('WorkerMetricsRegistry', () => {
  it('renders a scrapeable zero heartbeat before the first successful cycle', () => {
    const registry = new WorkerMetricsRegistry({ role: 'sync', processStartMs: 1_000_000, now: () => 1_030_000 })
    const text = registry.render()
    assertWellFormed(text)
    // 0 means "never completed a poll", which `time() - value` turns into a real
    // staleness signal instead of an absent series nobody alerts on.
    expect(seriesValue(text, 'merchant_worker_heartbeat_timestamp_seconds')).toBe(0)
    expect(seriesValue(text, 'merchant_worker_up')).toBe(1)
    expect(text).toContain('merchant_worker_process_uptime_seconds{role="sync"} 30')
  })

  it('advances the heartbeat and counters only on a successful poll', () => {
    const registry = new WorkerMetricsRegistry({ role: 'publish', processStartMs: 1_000_000, now: () => 1_030_000 })
    registry.recordPollSuccess({ startedAtMs: 1_028_000, finishedAtMs: 1_030_000, result: { restored: 1, processed: 2, succeeded: 2, unknown: 1, queued: 3, deadLetter: 4 } })
    const text = registry.render()
    assertWellFormed(text)
    expect(seriesValue(text, 'merchant_worker_heartbeat_timestamp_seconds')).toBe(1030)
    expect(seriesValue(text, 'merchant_worker_last_poll_succeeded')).toBe(1)
    expect(seriesValue(text, 'merchant_worker_poll_duration_seconds')).toBe(2)
    expect(text).toContain('merchant_worker_poll_total{role="publish",outcome="success"} 1')
    expect(text).toContain('merchant_worker_poll_items_total{role="publish",outcome="unknown"} 1')
    expect(text).toContain('merchant_worker_poll_items_total{role="publish",outcome="dead_letter"} 4')
  })

  it('tracks failures by code and bounds the label cardinality', () => {
    const registry = new WorkerMetricsRegistry({ role: 'sync', processStartMs: 0, now: () => 1_000 })
    for (let index = 0; index < 40; index += 1) registry.recordPollFailure({ finishedAtMs: 1_000, code: `CODE_${index}` })
    const text = registry.render()
    assertWellFormed(text)
    expect(seriesValue(text, 'merchant_worker_last_poll_succeeded')).toBe(0)
    expect(text).toContain('merchant_worker_poll_total{role="sync",outcome="failure"} 40')
    // A bounded set plus one overflow bucket, never 40 distinct series.
    expect(text.match(/merchant_worker_poll_failures_total\{/gu)!.length).toBeLessThanOrEqual(17)
    expect(text).toContain('code="OTHER"')
    // The heartbeat must not move on failure.
    expect(seriesValue(text, 'merchant_worker_heartbeat_timestamp_seconds')).toBe(0)
  })

  it('exposes scan queue depth and age under the shared queue series names', () => {
    const now = Date.parse('2026-09-19T12:00:00.000Z')
    const registry = new WorkerMetricsRegistry({ role: 'scan', processStartMs: now - 60_000, now: () => now })
    registry.recordScannerHeartbeat({
      ready: true,
      recoveryCapable: true,
      observedAt: '2026-09-19T12:00:00.000Z',
      clamav: { definitionsAgeSeconds: 3_600 },
      eicar: { ageSeconds: 12 },
      callback: { lastAcceptedAt: '2026-09-19T11:59:00.000Z', ageSeconds: 60 },
      queue: { backlog: 5, deadLetter: 1 },
    })
    registry.recordScannerQueue({ backlog: 5, deadLetter: 1, oldestPendingAgeSeconds: 900 })
    const text = registry.render()
    assertWellFormed(text)
    expect(seriesValue(text, 'merchant_worker_scanner_ready')).toBe(1)
    expect(seriesValue(text, 'merchant_worker_scanner_definitions_age_seconds')).toBe(3_600)
    expect(seriesValue(text, 'merchant_worker_scanner_eicar_age_seconds')).toBe(12)
    expect(seriesValue(text, 'merchant_worker_scanner_callback_age_seconds')).toBe(60)
    // Same names the API exports, so one rule covers both exporters.
    expect(text).toContain('merchant_queue_depth{queue="scan"} 5')
    expect(text).toContain('merchant_queue_dead_letter_events{queue="scan"} 1')
    expect(text).toContain('merchant_queue_oldest_job_age_seconds{queue="scan"} 900')
  })

  it('withholds the scan queue family and counts the read when the aggregation fails', () => {
    const registry = new WorkerMetricsRegistry({ role: 'scan', processStartMs: 0, now: () => 1_000 })
    registry.recordScannerQueue({ backlog: 5, deadLetter: 1, oldestPendingAgeSeconds: 900 })
    expect(registry.render()).toContain('merchant_queue_depth{queue="scan"} 5')

    registry.recordScannerQueueReadFailure()
    const text = registry.render()
    assertWellFormed(text)
    // The stale observation is dropped, never re-served as a current reading:
    // "the queue is empty" and "this read has been failing" must not look alike.
    expect(text).not.toContain('merchant_queue_depth')
    expect(text).not.toContain('merchant_queue_dead_letter_events')
    expect(text).not.toContain('merchant_queue_oldest_job_age_seconds')
    expect(text).toContain('merchant_worker_scanner_queue_reads_total{role="scan",outcome="failed"} 1')
    expect(text).toContain('merchant_worker_scanner_queue_reads_total{role="scan",outcome="ok"} 1')
  })

  it('never publishes a scan queue read counter for a role that never probes', () => {
    const registry = new WorkerMetricsRegistry({ role: 'automation', processStartMs: 0, now: () => 1_000 })
    const text = registry.render()
    assertWellFormed(text)
    // An always-present zero counter would be a claim about coverage this role
    // does not have.
    expect(text).not.toContain('merchant_worker_scanner_queue_reads_total')
  })

  it('omits scanner and queue families for roles that have no such state', () => {
    const registry = new WorkerMetricsRegistry({ role: 'automation', processStartMs: 0, now: () => 1_000 })
    const text = registry.render()
    assertWellFormed(text)
    expect(text).not.toContain('merchant_worker_scanner_ready')
    expect(text).not.toContain('merchant_queue_depth')
  })

  it('never renders a tenant identifier', () => {
    const registry = new WorkerMetricsRegistry({ role: 'sync', processStartMs: 0, now: () => 1_000 })
    registry.recordPollSuccess({ startedAtMs: 0, finishedAtMs: 1_000, result: { restored: 0, processed: 0, succeeded: 0, unknown: 0, queued: 0, deadLetter: 0 } })
    const text = registry.render()
    // Only these fixed-enum label keys are ever emitted; workspace/job/asset
    // identifiers are not reachable from the registry's inputs at all.
    const keys = [...text.matchAll(/([a-zA-Z_][a-zA-Z0-9_]*)="/gu)].map(match => match[1])
    expect(new Set(keys)).toEqual(new Set(['role', 'outcome']))
    expect(text).not.toContain('workspace')
  })
})

describe('authorizeMetricsRequest', () => {
  it('mirrors the API fail-closed contract in production', () => {
    expect(authorizeMetricsRequest({ production: true })).toEqual({ authorized: false, status: 503, error: 'METRICS_AUTH_NOT_CONFIGURED' })
    expect(authorizeMetricsRequest({ production: true, token: 'secret' })).toEqual({ authorized: false, status: 401, error: 'METRICS_UNAUTHORIZED' })
    expect(authorizeMetricsRequest({ production: true, token: 'secret', authorization: 'Bearer wrong' })).toEqual({ authorized: false, status: 401, error: 'METRICS_UNAUTHORIZED' })
    expect(authorizeMetricsRequest({ production: true, token: 'secret', authorization: 'Bearer secret' })).toEqual({ authorized: true, status: 200 })
  })

  it('leaves non-production open so local verification needs no secret', () => {
    expect(authorizeMetricsRequest({ production: false })).toEqual({ authorized: true, status: 200 })
  })
})

describe('createWorkerMetricsServer', () => {
  it('serves /metrics and rejects every other method and path', async () => {
    const registry = new WorkerMetricsRegistry({ role: 'sync' })
    const server = createWorkerMetricsServer({ registry, port: 0, host: '127.0.0.1', production: false })
    expect(await server.start()).toBe(true)
    const port = server.address()!.port
    try {
      const ok = await fetch(`http://127.0.0.1:${port}${WORKER_METRICS_PATH}`)
      expect(ok.status).toBe(200)
      expect(ok.headers.get('content-type')).toBe('text/plain; version=0.0.4; charset=utf-8')
      expect(await ok.text()).toContain('merchant_worker_up')

      expect((await fetch(`http://127.0.0.1:${port}/metrics`, { method: 'POST' })).status).toBe(405)
      expect((await fetch(`http://127.0.0.1:${port}/metrics`, { method: 'DELETE' })).status).toBe(405)
      expect((await fetch(`http://127.0.0.1:${port}/healthz`)).status).toBe(404)
      expect((await fetch(`http://127.0.0.1:${port}/`)).status).toBe(404)
      // A query string would imply filter parameters this endpoint does not have.
      expect((await fetch(`http://127.0.0.1:${port}/metrics?workspace=ws_demo`)).status).toBe(404)
    } finally {
      await server.stop()
    }
  })

  it('gates production scrapes behind the bearer token', async () => {
    const registry = new WorkerMetricsRegistry({ role: 'sync' })
    const unconfigured = createWorkerMetricsServer({ registry, port: 0, host: '127.0.0.1', production: true, token: undefined })
    expect(await unconfigured.start()).toBe(true)
    try {
      const response = await fetch(`http://127.0.0.1:${unconfigured.address()!.port}/metrics`)
      expect(response.status).toBe(503)
      expect(await response.json()).toEqual({ error: 'METRICS_AUTH_NOT_CONFIGURED' })
    } finally {
      await unconfigured.stop()
    }

    const configured = createWorkerMetricsServer({ registry, port: 0, host: '127.0.0.1', production: true, token: 'metrics-secret' })
    expect(await configured.start()).toBe(true)
    const port = configured.address()!.port
    try {
      expect((await fetch(`http://127.0.0.1:${port}/metrics`)).status).toBe(401)
      expect((await fetch(`http://127.0.0.1:${port}/metrics`, { headers: { authorization: 'Bearer nope' } })).status).toBe(401)
      const authorized = await fetch(`http://127.0.0.1:${port}/metrics`, { headers: { authorization: 'Bearer metrics-secret' } })
      expect(authorized.status).toBe(200)
      expect(await authorized.text()).toContain('merchant_worker_heartbeat_timestamp_seconds')
    } finally {
      await configured.stop()
    }
  })

  it('reports a bind failure instead of failing the worker', async () => {
    const blocker = createServer(() => undefined)
    await new Promise<void>(resolve => blocker.listen(0, '127.0.0.1', () => resolve()))
    const address = blocker.address()
    const port = typeof address === 'object' && address ? address.port : 0
    const onError = vi.fn()
    const server = createWorkerMetricsServer({ registry: new WorkerMetricsRegistry({ role: 'sync' }), port, host: '127.0.0.1', production: false, onError })
    try {
      await expect(server.start()).resolves.toBe(false)
      expect(onError).toHaveBeenCalled()
      expect(server.address()).toBeUndefined()
      // Stop after a failed start must stay a no-op rather than throwing.
      await expect(server.stop()).resolves.toBeUndefined()
    } finally {
      await new Promise<void>(resolve => blocker.close(() => resolve()))
    }
  })

  it('releases the port on stop', async () => {
    const server = createWorkerMetricsServer({ registry: new WorkerMetricsRegistry({ role: 'sync' }), port: 0, host: '127.0.0.1', production: false })
    expect(await server.start()).toBe(true)
    const port = server.address()!.port
    await server.stop()
    await expect(fetch(`http://127.0.0.1:${port}/metrics`)).rejects.toThrow()
  })
})
