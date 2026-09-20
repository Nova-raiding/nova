import { describe, expect, it } from 'vitest'
import { MemoryWorkspaceDataExportRepository } from '../../persistence/src/workspace-data-export-repository.js'
import { WorkspaceDataExportService } from './workspace-data-export.js'

describe('WorkspaceDataExportService', () => {
  it('keeps full workspace export separate from content export and never invents a delivery artifact', async () => {
    const service = new WorkspaceDataExportService(new MemoryWorkspaceDataExportRepository(() => new Date('2026-09-02T00:00:00.000Z')))
    const result = await service.request({ workspaceId: 'ws_export', actorId: 'owner-a', reason: '合规迁移导出', idempotencyKey: 'export-1' })
    expect(result).toMatchObject({ scope: 'workspace', status: 'pending', content_export_equivalent: false, delivery: { available: false, artifact_ref: null } })
    expect(await service.get({ workspaceId: 'ws_export', requestId: result.request_id })).toEqual(result)
    expect(await service.get({ workspaceId: 'ws_other', requestId: result.request_id })).toBeUndefined()
  })

  it('never offers an artifact whose expiry has passed', async () => {
    let clock = new Date('2026-09-02T00:00:00.000Z')
    const repository = new MemoryWorkspaceDataExportRepository(() => clock)
    const service = new WorkspaceDataExportService(repository, () => clock)
    const requested = await service.request({ workspaceId: 'ws_export', actorId: 'owner-a', reason: '合规迁移导出', idempotencyKey: 'export-expiry' })
    await repository.markProcessing({ workspaceId: 'ws_export', id: requested.request_id, workerId: 'worker-1' })
    const completed = await repository.complete({
      workspaceId: 'ws_export', id: requested.request_id, workerId: 'worker-1',
      artifactRef: 'workspace-export://ws_export/2026-09-02/bundle.zip', artifactSha256: 'a'.repeat(64), artifactSizeBytes: 1024,
      artifactExpiresAt: '2026-09-02T01:00:00.000Z', deliveryEvidenceRef: 'evidence://workspace-export/1',
    })
    expect(await service.get({ workspaceId: 'ws_export', requestId: completed.id })).toMatchObject({ status: 'ready', delivery: { available: true, artifact_ref: 'workspace-export://ws_export/2026-09-02/bundle.zip', expires_at: '2026-09-02T01:00:00.000Z' } })
    clock = new Date('2026-09-02T01:00:00.000Z')
    expect(await service.get({ workspaceId: 'ws_export', requestId: completed.id })).toMatchObject({ delivery: { available: false, artifact_ref: null }, next_actions: ['重新提交工作区数据导出申请'] })
  })
})
