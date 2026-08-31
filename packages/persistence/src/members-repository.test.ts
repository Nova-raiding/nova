import { describe, expect, it, vi } from 'vitest'
import { MemoryMembersRepository, PostgresMembersRepository } from './members-repository.js'
import type { SqlClient, SqlPool } from './repository.js'

describe('PostgresMembersRepository', () => {
  it('upserts a member and its audit atomically with an optimistic revision', async () => {
    const now = '2026-08-28T00:00:00.000Z'
    const current = { id: 'member_1', workspaceId: 'ws_1', externalSubject: 'user_1', displayName: '用户一', role: 'operator', status: 'active', invitedBy: 'admin', revision: 2, createdAt: now, updatedAt: now }
    const calls: string[] = []
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      calls.push(sql.split(' ')[0]!)
      if (sql.startsWith('SELECT id')) return { rows: [current] }
      if (sql.startsWith('INSERT INTO workspace_members')) return { rows: [{ ...current, role: 'support', revision: 3 }] }
      if (sql.startsWith('INSERT INTO workspace_operation_audit')) {
        expect(params?.[0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u)
        return { rows: [{ id: params?.[0], workspaceId: 'ws_1', actorId: 'admin', action: 'member.upsert', resourceType: 'workspace_member', resourceId: 'user_1', before: current, after: { ...current, role: 'support', revision: 3 }, reason: '角色调整', createdAt: now }] }
      }
      return { rows: [] }
    })
    const client: SqlClient = { query: query as unknown as SqlClient['query'], release: vi.fn() }
    const result = await new PostgresMembersRepository({ connect: async () => client }).upsertWithAudit({ workspaceId: 'ws_1', externalSubject: 'user_1', displayName: '用户一', role: 'support', status: 'active', expectedRevision: 2, actorId: 'admin', action: 'member.upsert', reason: '角色调整' })

    expect(result.member).toMatchObject({ role: 'support', status: 'active', revision: 3 })
    expect(result.audit).toMatchObject({ before: { role: 'operator' }, after: { role: 'support' } })
    expect(calls).toEqual(['BEGIN', 'SELECT', 'SELECT', 'INSERT', 'INSERT', 'COMMIT'])
  })

  it('changes member status and writes the audit in one transaction', async () => {
    const now = '2026-08-28T00:00:00.000Z'
    const current = { id: 'member_1', workspaceId: 'ws_1', externalSubject: 'user_1', displayName: '用户一', role: 'operator', status: 'active', invitedBy: 'admin', revision: 2, createdAt: now, updatedAt: now }
    const calls: string[] = []
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      calls.push(sql.split(' ')[0]!)
      if (sql.startsWith('SELECT id')) return { rows: [current] }
      if (sql.startsWith('UPDATE workspace_members')) return { rows: [{ ...current, status: 'suspended', revision: 3 }] }
      if (sql.startsWith('INSERT INTO workspace_operation_audit')) {
        expect(params?.[0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u)
        return { rows: [{ id: params?.[0], workspaceId: 'ws_1', actorId: 'admin', action: 'user.suspend', resourceType: 'workspace_member', resourceId: 'user_1', before: current, after: { ...current, status: 'suspended', revision: 3 }, reason: '风险工单', createdAt: now }] }
      }
      return { rows: [] }
    })
    const client: SqlClient = { query: query as unknown as SqlClient['query'], release: vi.fn() }
    const result = await new PostgresMembersRepository({ connect: async () => client }).changeStatusWithAudit({ workspaceId: 'ws_1', externalSubject: 'user_1', targetStatus: 'suspended', expectedRevision: 2, actorId: 'admin', action: 'user.suspend', reason: '风险工单' })

    expect(result.member).toMatchObject({ status: 'suspended', revision: 3 })
    expect(result.audit).toMatchObject({ action: 'user.suspend', reason: '风险工单' })
    expect(calls).toEqual(['BEGIN', 'SELECT', 'SELECT', 'UPDATE', 'INSERT', 'COMMIT'])
  })

  it('rolls back the member update when the audit insert fails', async () => {
    const now = '2026-08-28T00:00:00.000Z'
    const current = { id: 'member_1', workspaceId: 'ws_1', externalSubject: 'user_1', displayName: '用户一', role: 'operator', status: 'active', invitedBy: 'admin', revision: 2, createdAt: now, updatedAt: now }
    const query = vi.fn(async (sql: string) => {
      if (sql.startsWith('SELECT id')) return { rows: [current] }
      if (sql.startsWith('UPDATE workspace_members')) return { rows: [{ ...current, status: 'suspended', revision: 3 }] }
      if (sql.startsWith('INSERT INTO workspace_operation_audit')) throw new Error('audit unavailable')
      return { rows: [] }
    })
    const client: SqlClient = { query: query as unknown as SqlClient['query'], release: vi.fn() }
    const repository = new PostgresMembersRepository({ connect: async () => client })

    await expect(repository.changeStatusWithAudit({ workspaceId: 'ws_1', externalSubject: 'user_1', targetStatus: 'suspended', expectedRevision: 2, actorId: 'admin', action: 'user.suspend', reason: '风险工单' })).rejects.toThrow('audit unavailable')
    expect(query).toHaveBeenCalledWith('ROLLBACK')
  })

  it('normalizes pg timestamp Date values to the string contract', async () => {
    const createdAt = new Date('2026-08-01T00:00:00.000Z')
    const updatedAt = new Date('2026-08-02T00:00:00.000Z')
    const query = vi.fn(async (sql: string) => sql.includes('FROM workspace_members')
      ? { rows: [{ id: 'member_1', workspaceId: 'ws_1', externalSubject: 'user_1', displayName: '用户一', role: 'operator', status: 'active', invitedBy: 'admin', revision: 1, createdAt, updatedAt }] }
      : { rows: [] })
    const client: SqlClient = { query: query as unknown as SqlClient['query'], release: vi.fn() }
    const pool: SqlPool = { connect: async () => client }

    const rows = await new PostgresMembersRepository(pool).list('ws_1')

    expect(rows[0]).toMatchObject({ createdAt: createdAt.toISOString(), updatedAt: updatedAt.toISOString() })
    expect(query).toHaveBeenCalledWith("SELECT set_config('app.workspace_id', $1, true)", ['ws_1'])
  })
})

describe('MemoryMembersRepository', () => {
  it('preserves status during an audited role-only update', async () => {
    const repository = new MemoryMembersRepository()
    const current = await repository.upsert({ workspaceId: 'ws_1', externalSubject: 'user_1', displayName: '用户一', role: 'operator', status: 'active', invitedBy: 'admin' })
    const changed = await repository.upsertWithAudit({ workspaceId: 'ws_1', externalSubject: 'user_1', displayName: '用户一', role: 'support', status: current.status, expectedRevision: current.revision, actorId: 'admin', action: 'member.upsert', reason: '角色调整' })
    expect(changed).toMatchObject({ member: { role: 'support', status: 'active', revision: current.revision + 1 }, audit: { before: { role: 'operator' }, after: { role: 'support' } } })
  })

  it('uses optimistic revision checks for audited status changes', async () => {
    const repository = new MemoryMembersRepository()
    const current = await repository.upsert({ workspaceId: 'ws_1', externalSubject: 'user_1', displayName: '用户一', role: 'operator', status: 'active', invitedBy: 'admin' })
    const changed = await repository.changeStatusWithAudit({ workspaceId: 'ws_1', externalSubject: 'user_1', targetStatus: 'suspended', expectedRevision: current.revision, actorId: 'admin', action: 'user.suspend', reason: '风险工单' })
    expect(changed).toMatchObject({ member: { status: 'suspended', revision: current.revision + 1 }, audit: { action: 'user.suspend', before: { status: 'active' }, after: { status: 'suspended' } } })
    await expect(repository.changeStatusWithAudit({ workspaceId: 'ws_1', externalSubject: 'user_1', targetStatus: 'active', expectedRevision: current.revision, actorId: 'admin', action: 'user.activate', reason: '过期版本' })).rejects.toThrow('MEMBER_REVISION_CONFLICT')
  })
})
