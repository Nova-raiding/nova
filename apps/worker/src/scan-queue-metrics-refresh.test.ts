import { describe, expect, it, vi } from 'vitest'
import { refreshScanQueueMetrics } from './main.js'
import { WorkerMetricsRegistry } from './worker-metrics.js'
import type { SqlPool } from '../../../packages/persistence/src/index.js'

/**
 * A pool whose metrics query either returns one aggregate row per workspace or
 * fails the way an unreachable database does.
 */
function pool(options: { fail?: boolean; backlog?: number; deadLetter?: number } = {}) {
  const client = {
    query: vi.fn(async (sql: string) => {
      if (sql.startsWith('SELECT\n')) {
        if (options.fail) throw Object.assign(new Error('connection terminated unexpectedly'), { code: 'ECONNRESET' })
        return { rows: [{ backlog: options.backlog ?? 3, dead_letter: options.deadLetter ?? 0, last_callback_accepted_at: null, oldest_pending_at: null }] }
      }
      return { rows: [] }
    }),
    release: vi.fn(),
  }
  return { pool: { connect: vi.fn(async () => client) } as unknown as SqlPool, client }
}

function series(text: string, name: string, labels = '[^}]*'): number | undefined {
  const match = new RegExp(`^${name}\\{${labels}\\} (-?[0-9.eE+]+)$`, 'mu').exec(text)
  return match ? Number(match[1]) : undefined
}

describe('refreshScanQueueMetrics', () => {
  it('projects a successful read onto the scan queue gauges', async () => {
    const { pool: stub } = pool({ backlog: 7, deadLetter: 2 })
    const registry = new WorkerMetricsRegistry({ role: 'scan' })
    const onFailure = vi.fn()

    await expect(refreshScanQueueMetrics({ pool: stub, workspaces: ['ws_a'], scanMaxAttempts: 12, metrics: registry, onFailure })).resolves.toBe(true)

    const text = registry.render()
    expect(onFailure).not.toHaveBeenCalled()
    expect(text).toContain('merchant_queue_depth{queue="scan"} 7')
    expect(text).toContain('merchant_queue_dead_letter_events{queue="scan"} 2')
    expect(series(text, 'merchant_worker_scanner_queue_reads_total', 'role="scan",outcome="ok"')).toBe(1)
    expect(series(text, 'merchant_worker_scanner_queue_reads_total', 'role="scan",outcome="failed"')).toBe(0)
  })

  it('reports and counts a failed read instead of swallowing it', async () => {
    const { pool: stub } = pool({ fail: true })
    const registry = new WorkerMetricsRegistry({ role: 'scan' })
    const onFailure = vi.fn()

    await expect(refreshScanQueueMetrics({ pool: stub, workspaces: ['ws_a'], scanMaxAttempts: 12, metrics: registry, onFailure })).resolves.toBe(false)

    // The failure is reported with its code, not discarded by `.catch(() => undefined)`.
    expect(onFailure).toHaveBeenCalledOnce()
    expect(onFailure).toHaveBeenCalledWith(expect.objectContaining({ code: 'ECONNRESET', message: 'connection terminated unexpectedly' }))
    const text = registry.render()
    expect(series(text, 'merchant_worker_scanner_queue_reads_total', 'role="scan",outcome="failed"')).toBe(1)
    expect(text).toContain('merchant_worker_scanner_queue_reads_total')
  })

  it('withholds the scan queue family after a failure instead of serving the stale reading', async () => {
    const registry = new WorkerMetricsRegistry({ role: 'scan' })
    await refreshScanQueueMetrics({ pool: pool({ backlog: 5, deadLetter: 1 }).pool, workspaces: ['ws_a'], scanMaxAttempts: 12, metrics: registry, onFailure: vi.fn() })
    expect(registry.render()).toContain('merchant_queue_depth{queue="scan"} 5')

    // The read now fails. The previously observed backlog must not keep being
    // served as if it were current: `= 5` is indistinguishable from "this read
    // has been failing for twenty minutes", which is the exact condition the
    // backlog rule exists to catch. Absence (plus the failed counter) is honest.
    await refreshScanQueueMetrics({ pool: pool({ fail: true }).pool, workspaces: ['ws_a'], scanMaxAttempts: 12, metrics: registry, onFailure: vi.fn() })
    const text = registry.render()
    expect(text).not.toContain('merchant_queue_depth')
    expect(text).not.toContain('merchant_queue_dead_letter_events')
    expect(text).not.toContain('merchant_queue_oldest_job_age_seconds')
    expect(series(text, 'merchant_worker_scanner_queue_reads_total', 'role="scan",outcome="ok"')).toBe(1)
    expect(series(text, 'merchant_worker_scanner_queue_reads_total', 'role="scan",outcome="failed"')).toBe(1)

    // And a later success republishes the family rather than latching the omission.
    await refreshScanQueueMetrics({ pool: pool({ backlog: 9 }).pool, workspaces: ['ws_a'], scanMaxAttempts: 12, metrics: registry, onFailure: vi.fn() })
    expect(registry.render()).toContain('merchant_queue_depth{queue="scan"} 9')
  })

  it('counts a workspace lookup failure as a failed read too', async () => {
    const registry = new WorkerMetricsRegistry({ role: 'scan' })
    const onFailure = vi.fn()
    await expect(refreshScanQueueMetrics({
      pool: pool().pool,
      workspaces: Promise.reject(Object.assign(new Error('workspace discovery failed'), { code: 'WORKSPACE_DISCOVERY_FAILED' })),
      scanMaxAttempts: 12,
      metrics: registry,
      onFailure,
    })).resolves.toBe(false)
    expect(onFailure).toHaveBeenCalledWith(expect.objectContaining({ code: 'WORKSPACE_DISCOVERY_FAILED' }))
    expect(registry.render()).toContain('merchant_worker_scanner_queue_reads_total{role="scan",outcome="failed"} 1')
  })
})
