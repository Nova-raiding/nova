import { describe, expect, it } from 'vitest'
import { MemoryDataLifecycleRepository } from './data-lifecycle-repository.js'

describe('data deletion lifecycle repository', () => {
  it('requires two distinct operators and records external execution proof only after the grace period', async () => {
    const repository = new MemoryDataLifecycleRepository()
    const request = await repository.request({ workspaceId: 'ws_delete', scope: 'assets', reason: '商家删除历史素材', requestedBy: 'owner', gracePeriodDays: 7, idempotencyKey: 'delete-1' })
    expect(request).toMatchObject({ status: 'pending', approvals: [] })
    await expect(repository.approve({ workspaceId: 'ws_delete', id: request.id, actorId: 'owner', reason: '申请人不能审批自己' })).rejects.toThrow('DATA_DELETION_APPROVAL_SEPARATION_REQUIRED')
    const first = await repository.approve({ workspaceId: 'ws_delete', id: request.id, actorId: 'operator-a', reason: '核对范围和宽限期' })
    expect(first).toMatchObject({ status: 'pending', approvals: [{ actorId: 'operator-a' }] })
    const approved = await repository.approve({ workspaceId: 'ws_delete', id: request.id, actorId: 'operator-b', reason: '独立复核通过，等待外部证明' })
    expect(approved).toMatchObject({ status: 'approved', approvals: [{ actorId: 'operator-a' }, { actorId: 'operator-b' }] })
    await expect(repository.approve({ workspaceId: 'ws_delete', id: request.id, actorId: 'operator-c', reason: '不得再次审批' })).rejects.toThrow('DATA_DELETION_REQUEST_NOT_PENDING')
    await expect(repository.complete({ workspaceId: 'ws_delete', id: request.id, workerId: 'deletion-worker', proofRef: 'artifact://delete/ws_delete/1', now: request.scheduledFor })).resolves.toMatchObject({ status: 'completed', completedBy: 'deletion-worker', executionProofRef: 'artifact://delete/ws_delete/1' })
  })

  it('rejects idempotency reuse for a different deletion intent', async () => {
    const repository = new MemoryDataLifecycleRepository()
    const input = { workspaceId: 'ws_delete_conflict', scope: 'assets' as const, reason: '删除历史素材', requestedBy: 'owner', gracePeriodDays: 7, idempotencyKey: 'delete-conflict-1' }
    await repository.request(input)
    await expect(repository.request({ ...input, scope: 'business' })).rejects.toMatchObject({ code: 'DATA_DELETION_IDEMPOTENCY_CONFLICT' })
  })
})
