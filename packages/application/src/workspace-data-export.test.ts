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
})
