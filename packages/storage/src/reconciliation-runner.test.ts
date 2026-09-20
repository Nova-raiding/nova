import { describe, expect, it } from 'vitest'
import { MemoryReconciliationStatusStore, runReconciliationCycle, type ReconciliationStatusStore } from './reconciliation-runner.js'

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
    await status.put({ workspaceId: 'ws_a', status: 'clean', quota: { reservedBytes: 0, usedBytes: 4, projectedBytes: 4 }, counts: { references: 1, inventoryObjects: 1, matched: 1, missing: 0, metadataMismatches: 0, orphans: 0, crossWorkspace: 0, duplicates: 0, invalidMetadata: 0 }, findings: [] })
    const errors: string[] = []
    const result = await runReconciliationCycle({ workspaces: ['ws_a', 'ws_b'], inventory: { list: async workspaceId => { if (workspaceId === 'ws_b') throw new Error('provider unavailable'); return inventory } }, references: { list: async () => refs }, status, onError: (workspaceId) => errors.push(workspaceId) })
    expect(result).toMatchObject({ completed: 1, failed: 1 })
    expect(errors).toEqual(['ws_b'])
    await expect(status.get('ws_a')).resolves.toMatchObject({ status: 'clean' })
    await expect(status.get('ws_b')).resolves.toMatchObject({
      status: 'attention_required',
      runStatus: 'failed',
      error: { code: 'RECONCILIATION_PROVIDER_FAILED', message: 'provider unavailable', retryable: true, nextActions: ['retry'] },
    })
    await expect(status.list('ws_b')).resolves.toHaveLength(1)
  })

  it('rejects malformed workspace batches before invoking providers', async () => {
    const status = new MemoryReconciliationStatusStore()
    const list = async () => { throw new Error('provider must not be called') }
    await expect(runReconciliationCycle({ workspaces: ['ws_a', ''], inventory: { list }, references: { list }, status }))
      .rejects.toThrow('RECONCILIATION_WORKSPACE_REQUIRED')
    await expect(runReconciliationCycle({ workspaces: ['ws_a', 'ws_a'], inventory: { list }, references: { list }, status }))
      .rejects.toThrow('RECONCILIATION_WORKSPACE_DUPLICATE')
  })

  it('records retryable evidence for transient failures and manual review for unknown failures', async () => {
    const status = new MemoryReconciliationStatusStore()
    await runReconciliationCycle({ workspaces: ['ws_transient', 'ws_unknown'], inventory: { list: async workspaceId => { throw new Error(workspaceId === 'ws_transient' ? 'provider temporarily unavailable' : 'schema mismatch') } }, references: { list: async () => refs }, status })
    await expect(status.get('ws_transient')).resolves.toMatchObject({ error: { retryable: true, nextActions: ['retry'] } })
    await expect(status.get('ws_unknown')).resolves.toMatchObject({ error: { retryable: false, nextActions: ['manual_review'] } })
  })

  it('redacts provider credentials and query material from persisted retry evidence', async () => {
    const status = new MemoryReconciliationStatusStore()
    await runReconciliationCycle({
      workspaces: ['ws_sensitive'],
      inventory: { list: async () => { throw new Error('request failed https://provider.example/reconcile?access_token=secret-token&workspace=ws_sensitive Bearer super-secret-api-key api_key=another-secret') } },
      references: { list: async () => refs },
      status,
    })

    const report = await status.get('ws_sensitive')
    expect(report?.error?.message).toBe('request failed https://provider.example/reconcile?[REDACTED] Bearer [REDACTED] api_key=[REDACTED]')
    expect(report?.error?.message).not.toContain('secret-token')
    expect(report?.error?.message).not.toContain('super-secret-api-key')
    expect(report?.error?.message).not.toContain('another-secret')
  })

  it('redacts camelCase credentials from persisted error evidence', async () => {
    const status = new MemoryReconciliationStatusStore()
    await runReconciliationCycle({
      workspaces: ['ws_camel_case'],
      inventory: { list: async () => { throw new Error('request accessToken=secret-a apiKey:secret-b clientSecret=secret-c codeVerifier=secret-d') } },
      references: { list: async () => refs },
      status,
    })
    const message = (await status.get('ws_camel_case'))?.error?.message ?? ''
    expect(message).toBe('request accessToken=[REDACTED] apiKey=[REDACTED] clientSecret=[REDACTED] codeVerifier=[REDACTED]')
    expect(message).not.toMatch(/secret-[a-d]/u)
  })

  it('reports the provider failure to onError even when the failure snapshot cannot be written', async () => {
    const storeFailure = new Error('status store unavailable')
    const status: ReconciliationStatusStore = {
      put: async () => { throw storeFailure },
      get: async () => undefined,
      list: async () => [],
    }
    const reported: Array<{ workspaceId: string; error: unknown }> = []
    const providerError = new Error('provider unavailable')
    // The store that holds the failure snapshot is the component most likely to
    // be down when a cycle fails. Its rejection must not skip the caller's
    // reporter, and the reporter must name the provider failure that caused the
    // cycle to fail rather than the store failure that followed it.
    await expect(runReconciliationCycle({
      workspaces: ['ws_report'],
      inventory: { list: async () => { throw providerError } },
      references: { list: async () => refs },
      status,
      onError: (workspaceId, error) => reported.push({ workspaceId, error }),
    })).rejects.toThrow('status store unavailable')
    expect(reported).toEqual([{ workspaceId: 'ws_report', error: providerError }])
  })
})
