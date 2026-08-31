import { describe, expect, it } from 'vitest'
import { MemoryReconciliationStatusStore, runReconciliationCycle, startReconciliationScheduler } from './reconciliation-runner.js'

const refs = [{ workspaceId: 'ws_a', assetId: 'asset_1', storageKey: 'clean/ws_a/asset_1/source.png', sha256: 'a'.repeat(64), sizeBytes: 4 }]
const inventory = [{ workspaceId: 'ws_a', storageKey: 'clean/ws_a/asset_1/source.png', sha256: 'a'.repeat(64), sizeBytes: 4 }]

describe('storage reconciliation runner', () => {
  it('runs an injected inventory cycle and leaves an ops-readable status snapshot', async () => {
    const status = new MemoryReconciliationStatusStore()
    const result = await runReconciliationCycle({
      workspaces: ['ws_a'],
      inventory: { list: async () => inventory },
      references: { list: async () => refs },
      quota: { get: async () => ({ limitBytes: 10, reservedBytes: 2 }) },
      status,
    })
    expect(result).toMatchObject({ completed: 1, failed: 0 })
    await expect(status.get('ws_a')).resolves.toMatchObject({ status: 'clean', quota: { usedBytes: 4, reservedBytes: 2, projectedBytes: 6 } })
    await expect(status.list('ws_a')).resolves.toHaveLength(1)
  })

  it('isolates provider failures per workspace and preserves the last good snapshot', async () => {
    const status = new MemoryReconciliationStatusStore()
    await status.put({ workspaceId: 'ws_a', status: 'clean', quota: { reservedBytes: 0, usedBytes: 4, projectedBytes: 4 }, counts: { references: 1, inventoryObjects: 1, matched: 1, missing: 0, metadataMismatches: 0, orphans: 0, crossWorkspace: 0, duplicates: 0 }, findings: [] })
    const errors: string[] = []
    const result = await runReconciliationCycle({ workspaces: ['ws_a', 'ws_b'], inventory: { list: async workspaceId => { if (workspaceId === 'ws_b') throw new Error('provider unavailable'); return inventory } }, references: { list: async () => refs }, status, onError: (workspaceId) => errors.push(workspaceId) })
    expect(result).toMatchObject({ completed: 1, failed: 1 })
    expect(errors).toEqual(['ws_b'])
    await expect(status.get('ws_a')).resolves.toMatchObject({ status: 'clean' })
    await expect(status.get('ws_b')).resolves.toMatchObject({
      status: 'attention_required',
      runStatus: 'failed',
      error: { code: 'RECONCILIATION_PROVIDER_FAILED', message: 'provider unavailable' },
    })
    await expect(status.list('ws_b')).resolves.toHaveLength(1)
  })

  it('coalesces overlapping timer ticks and can be stopped', async () => {
    const callbacks: Array<() => void> = []
    const cleared: unknown[] = []
    const status = new MemoryReconciliationStatusStore()
    let release!: () => void
    const blocked = new Promise<void>(resolve => { release = resolve })
    const scheduler = startReconciliationScheduler({ intervalMs: 1_000, workspaces: ['ws_a'], inventory: { list: async () => { await blocked; return inventory } }, references: { list: async () => refs }, status, setTimer: ((callback: () => void) => { callbacks.push(callback); return callbacks.length as unknown as ReturnType<typeof setInterval> }) as typeof setInterval, clearTimer: ((timer: ReturnType<typeof setInterval>) => { cleared.push(timer) }) as typeof clearInterval })
    const first = scheduler.runNow()
    callbacks[0]!()
    expect(callbacks).toHaveLength(1)
    release()
    await first
    scheduler.stop()
    expect(cleared).toEqual([1])
  })
})
