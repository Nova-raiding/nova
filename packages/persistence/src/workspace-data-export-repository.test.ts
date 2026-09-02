import { describe, expect, it } from 'vitest'
import { MemoryWorkspaceDataExportRepository } from './workspace-data-export-repository.js'

describe('workspace data export repository', () => {
  it('creates one full-workspace export request and requires delivery evidence before ready', async () => {
    let now = new Date('2026-09-02T00:00:00.000Z')
    const repository = new MemoryWorkspaceDataExportRepository(() => now)
    const input = { workspaceId: 'ws_export', requestedBy: 'owner-a', reason: '迁移前导出本工作区全部自有数据', idempotencyKey: 'export-1' }
    const requested = await repository.request(input)
    expect(requested).toMatchObject({ workspaceId: 'ws_export', requestedBy: 'owner-a', status: 'pending' })
    expect(await repository.request(input)).toEqual(requested)
    expect(await repository.get('ws_other', requested.id)).toBeUndefined()

    await repository.markProcessing({ workspaceId: 'ws_export', id: requested.id, workerId: 'export-worker' })
    await expect(repository.complete({
      workspaceId: 'ws_export', id: requested.id, workerId: 'export-worker', artifactRef: 'workspace-export://ws_export/1', artifactSha256: '0'.repeat(64), artifactSizeBytes: 1, artifactExpiresAt: '2026-09-09T00:00:00.000Z', deliveryEvidenceRef: '',
    })).rejects.toThrow('WORKSPACE_DATA_EXPORT_DELIVERY_EVIDENCE_REQUIRED')

    now = new Date('2026-09-02T00:01:00.000Z')
    const ready = await repository.complete({
      workspaceId: 'ws_export', id: requested.id, workerId: 'export-worker', artifactRef: 'workspace-export://ws_export/1', artifactSha256: 'a'.repeat(64), artifactSizeBytes: 42, artifactExpiresAt: '2026-09-09T00:00:00.000Z', deliveryEvidenceRef: 'evidence://workspace-export/ws_export/1',
    })
    expect(ready).toMatchObject({ status: 'ready', artifactSizeBytes: 42, deliveryEvidenceRef: 'evidence://workspace-export/ws_export/1' })
  })

  it('rejects cross-intent idempotency reuse and invalid transitions', async () => {
    const repository = new MemoryWorkspaceDataExportRepository()
    const request = await repository.request({ workspaceId: 'ws_export', requestedBy: 'owner-a', reason: '合规导出', idempotencyKey: 'export-2' })
    await expect(repository.request({ workspaceId: 'ws_export', requestedBy: 'owner-a', reason: '不同导出意图', idempotencyKey: 'export-2' })).rejects.toMatchObject({ code: 'WORKSPACE_DATA_EXPORT_IDEMPOTENCY_CONFLICT' })
    await expect(repository.complete({ workspaceId: 'ws_export', id: request.id, workerId: 'export-worker', artifactRef: 'workspace-export://a', artifactSha256: 'a'.repeat(64), artifactSizeBytes: 1, artifactExpiresAt: '2099-01-01T00:00:00.000Z', deliveryEvidenceRef: 'evidence://a' })).rejects.toThrow('WORKSPACE_DATA_EXPORT_STATE_CONFLICT')
  })
})
