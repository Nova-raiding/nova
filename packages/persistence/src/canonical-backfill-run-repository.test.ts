import { describe, expect, it } from 'vitest'
import { CanonicalBackfillRunRevisionConflictError, MemoryCanonicalBackfillRunRepository } from './canonical-backfill-run-repository.js'

describe('canonical backfill run repository', () => {
  it('creates, advances and rejects stale concurrent updates', async () => {
    const repository = new MemoryCanonicalBackfillRunRepository()
    const run = await repository.create({ workspaceId: 'ws_run_test', dryRun: true, batchLimit: 25, createdBy: 'ops', reason: '审计前预览' })
    expect(run).toMatchObject({ status: 'planned', revision: 1, dryRun: true, batchLimit: 25 })
    const advanced = await repository.update({ id: run.id, workspaceId: run.workspaceId, expectedRevision: run.revision, status: 'paused', cursorProductId: 'prod_25', lastResult: { conflicts: 2 } })
    expect(advanced).toMatchObject({ status: 'paused', revision: 2, cursorProductId: 'prod_25', lastResult: { conflicts: 2 } })
    await expect(repository.update({ id: run.id, workspaceId: run.workspaceId, expectedRevision: run.revision, status: 'running' })).rejects.toBeInstanceOf(CanonicalBackfillRunRevisionConflictError)
  })

  it('does not leak a run across workspace scope', async () => {
    const repository = new MemoryCanonicalBackfillRunRepository()
    const run = await repository.create({ workspaceId: 'ws_run_owner', dryRun: false, createdBy: 'ops', reason: '执行' })
    await expect(repository.get({ workspaceId: 'ws_run_other', id: run.id })).resolves.toBeUndefined()
  })
})
