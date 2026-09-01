import { describe, expect, it } from 'vitest'
import { CanonicalBackfillRunRevisionConflictError, CanonicalBackfillRunStateError, MemoryCanonicalBackfillRunRepository } from './canonical-backfill-run-repository.js'

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

  it('enforces terminal and pause/resume transitions at the repository boundary', async () => {
    const repository = new MemoryCanonicalBackfillRunRepository()
    const run = await repository.create({ workspaceId: 'ws_state', dryRun: false, createdBy: 'ops', reason: '执行' })
    const started = await repository.update({ id: run.id, workspaceId: run.workspaceId, expectedRevision: run.revision, status: 'running' })
    const paused = await repository.update({ id: run.id, workspaceId: run.workspaceId, expectedRevision: started.revision, status: 'paused' })
    const resumed = await repository.update({ id: run.id, workspaceId: run.workspaceId, expectedRevision: paused.revision, status: 'running' })
    const completed = await repository.update({ id: run.id, workspaceId: run.workspaceId, expectedRevision: resumed.revision, status: 'completed' })
    await expect(repository.update({ id: run.id, workspaceId: run.workspaceId, expectedRevision: completed.revision, status: 'running' })).rejects.toBeInstanceOf(CanonicalBackfillRunStateError)
  })

  it('permits a failed executor run to resume with a revision check', async () => {
    const repository = new MemoryCanonicalBackfillRunRepository()
    const run = await repository.create({ workspaceId: 'ws_retry', dryRun: false, createdBy: 'ops', reason: '重试失败批次' })
    const failed = await repository.update({ id: run.id, workspaceId: run.workspaceId, expectedRevision: run.revision, status: 'failed', lastResult: { error: 'temporary database timeout' } })
    const retried = await repository.update({ id: run.id, workspaceId: run.workspaceId, expectedRevision: failed.revision, status: 'running' })
    expect(retried).toMatchObject({ status: 'running', revision: 3, lastResult: { error: 'temporary database timeout' } })
    await expect(repository.update({ id: run.id, workspaceId: run.workspaceId, expectedRevision: failed.revision, status: 'running' })).rejects.toBeInstanceOf(CanonicalBackfillRunRevisionConflictError)
  })
})
