import { describe, expect, it } from 'vitest'
import { MemoryMembersRepository } from './members-repository.js'
import { MemoryOperationsRepository } from './operations-repository.js'
import { MemoryWorkspaceBootstrapRepository } from './workspace-bootstrap-repository.js'

describe('MemoryWorkspaceBootstrapRepository', () => {
  it('serializes concurrent bootstrap calls and reuses the owner workspace', async () => {
    const members = new MemoryMembersRepository()
    const operations = new MemoryOperationsRepository()
    const statuses = new Map<string, 'active' | 'disabled'>()
    const repository = new MemoryWorkspaceBootstrapRepository(members, operations, workspaceId => statuses.set(workspaceId, 'active'), workspaceId => statuses.get(workspaceId) ?? 'active')

    const [first, second] = await Promise.all([
      repository.bootstrap({ issuer: 'https://issuer.example', externalSubject: 'merchant-1', identityId: 'identity-1', candidateWorkspaceId: 'ws_candidate_a', displayName: '第一工作区', actorId: 'merchant-1' }),
      repository.bootstrap({ issuer: 'https://issuer.example', externalSubject: 'merchant-1', identityId: 'identity-1', candidateWorkspaceId: 'ws_candidate_b', displayName: '第二工作区', actorId: 'merchant-1' }),
    ])

    expect(new Set([first.workspaceId, second.workspaceId])).toEqual(new Set(['ws_candidate_a']))
    expect([first.created, second.created].sort()).toEqual([false, true])
    expect(await members.list('ws_candidate_a')).toEqual([expect.objectContaining({ externalSubject: 'merchant-1', identityId: 'identity-1', role: 'workspace_owner', status: 'active' })])
    expect(await members.list('ws_candidate_b')).toEqual([])
    expect(await operations.list('ws_candidate_a')).toHaveLength(1)
  })

  it('isolates the same subject under different trusted issuers', async () => {
    const members = new MemoryMembersRepository()
    const operations = new MemoryOperationsRepository()
    const statuses = new Map<string, 'active' | 'disabled'>()
    const repository = new MemoryWorkspaceBootstrapRepository(members, operations, workspaceId => statuses.set(workspaceId, 'active'), workspaceId => statuses.get(workspaceId) ?? 'active')

    const left = await repository.bootstrap({ issuer: 'https://issuer-a.example', externalSubject: 'shared-subject', candidateWorkspaceId: 'ws_issuer_a', displayName: 'A', actorId: 'shared-subject' })
    const right = await repository.bootstrap({ issuer: 'https://issuer-b.example', externalSubject: 'shared-subject', candidateWorkspaceId: 'ws_issuer_b', displayName: 'B', actorId: 'shared-subject' })

    expect(left.workspaceId).toBe('ws_issuer_a')
    expect(right.workspaceId).toBe('ws_issuer_b')
  })
})
