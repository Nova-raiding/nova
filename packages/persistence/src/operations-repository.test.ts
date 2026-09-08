import { describe, expect, it, vi } from 'vitest'
import { MemoryOperationsRepository, OperationAuditValidationError, PostgresOperationsRepository } from './operations-repository.js'
import type { SqlClient, SqlPool } from './repository.js'

const valid = () => ({ workspaceId: 'ws_a', actorId: 'actor_a', action: 'member.update', resourceType: 'workspace_member', resourceId: 'member_a', before: {}, after: { status: 'active' }, reason: '授权成员变更' })

describe('OperationsRepository audit sink boundary', () => {
  it.each([
    ['blank actor', { actorId: '   ' }],
    ['control-character resource', { resourceId: 'member\nforged' }],
    ['control-character reason', { reason: 'ticket\u0000forged' }],
    ['array evidence', { before: [] }],
  ])('rejects %s before the memory sink accepts it', async (_label, override) => {
    const repository = new MemoryOperationsRepository()
    await expect(repository.append({ ...valid(), ...override } as Parameters<typeof repository.append>[0])).rejects.toBeInstanceOf(OperationAuditValidationError)
    await expect(repository.list('ws_a')).resolves.toEqual([])
  })

  it('rejects malformed input before opening a Postgres transaction', async () => {
    const connect = vi.fn()
    const pool: SqlPool = { connect } as unknown as SqlPool
    await expect(new PostgresOperationsRepository(pool).append({ ...valid(), action: ' ' })).rejects.toMatchObject({ code: 'OPERATION_AUDIT_CONTEXT_INVALID' })
    expect(connect).not.toHaveBeenCalled()
  })

  it('preserves the workspace transaction boundary for valid input', async () => {
    const query = vi.fn(async (sql: string) => sql.startsWith('SELECT set_config') ? { rows: [] } : sql.startsWith('INSERT') ? { rows: [{ ...valid(), id: 'audit_a', createdAt: '2026-09-01T00:00:00.000Z' }] } : { rows: [] })
    const client: SqlClient = { query: query as unknown as SqlClient['query'], release: vi.fn() }
    await new PostgresOperationsRepository({ connect: async () => client }).append(valid())
    expect(query.mock.calls.map(([sql]) => sql)).toEqual(['BEGIN', "SELECT set_config('app.workspace_id', $1, true)", expect.stringContaining('INSERT INTO workspace_operation_audit'), 'COMMIT'])
  })

  it('finds an exact audit resource without depending on the bounded list window', async () => {
    const repository = new MemoryOperationsRepository()
    const appended = await repository.append(valid())
    await expect(repository.find('ws_a', 'member.update', 'workspace_member', 'member_a')).resolves.toEqual(appended)
    await expect(repository.find('ws_a', 'member.update', 'workspace_member', 'missing')).resolves.toBeUndefined()

    const query = vi.fn(async (sql: string) => sql.startsWith('SELECT set_config') ? { rows: [] } : sql.includes('FROM workspace_operation_audit') ? { rows: [appended] } : { rows: [] })
    const client: SqlClient = { query: query as unknown as SqlClient['query'], release: vi.fn() }
    await expect(new PostgresOperationsRepository({ connect: async () => client }).find('ws_a', 'member.update', 'workspace_member', 'member_a')).resolves.toEqual(appended)
    expect(query.mock.calls.some(([sql]) => String(sql).includes('action=$2 AND resource_type=$3 AND resource_id=$4'))).toBe(true)
  })
})
