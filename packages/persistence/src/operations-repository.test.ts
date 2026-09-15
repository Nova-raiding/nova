import { describe, expect, it, vi } from 'vitest'
import { MemoryOperationsRepository, OperationAuditValidationError, PostgresOperationsRepository, type OperationAudit } from './operations-repository.js'
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

describe('PostgresOperationsRepository timestamp contract (controlled SQL rows, not PostgreSQL evidence)', () => {
  type AuditRow = Omit<OperationAudit, 'createdAt'> & { createdAt: Date | string }
  const fixture = (rows: readonly AuditRow[]) => {
    const query = vi.fn(async (sql: string, _values?: readonly unknown[]) => ({
      rows: sql.startsWith('INSERT INTO workspace_operation_audit') || sql.includes('FROM workspace_operation_audit') ? rows : [],
    }))
    const release = vi.fn()
    const client: SqlClient = { query: query as unknown as SqlClient['query'], release }
    return { repository: new PostgresOperationsRepository({ connect: async () => client }), query, release }
  }
  const read = async (repository: PostgresOperationsRepository, method: 'append' | 'list' | 'find') => {
    if (method === 'append') return repository.append(valid())
    if (method === 'find') return repository.find('ws_a', 'member.update', 'workspace_member', 'member_a')
    return (await repository.list('ws_a'))[0]
  }

  it('lets user detail sort two PostgreSQL Date audits after a member suspension', async () => {
    const rows = [
      { ...valid(), id: 'audit_suspend', action: 'user.suspend', createdAt: new Date('2026-09-15T05:42:00.456Z') },
      { ...valid(), id: 'audit_activate', action: 'user.activate', createdAt: new Date('2026-09-15T05:41:00.123Z') },
    ]
    const { repository, query } = fixture(rows)
    const audits = await repository.list('ws_a', 200)
    // Same in-process comparison as ops.user.detail, before JSON serialization.
    expect(() => audits.sort((left, right) => right.createdAt.localeCompare(left.createdAt))).not.toThrow()
    expect(audits).toEqual(rows.map(row => ({ ...row, createdAt: row.createdAt.toISOString() })))
    expect(query.mock.calls.find(([sql]) => sql.includes('FROM workspace_operation_audit'))).toEqual([
      expect.stringContaining('ORDER BY created_at DESC, id DESC LIMIT $2'), ['ws_a', 200],
    ])
  })

  for (const method of ['append', 'list', 'find'] as const) {
    it.each([
      ['Date', new Date('2026-09-15T05:42:00.123Z')],
      ['UTC string', '2026-09-15T05:42:00.123Z'],
      ['offset string', '2026-09-15T13:42:00.123+08:00'],
    ])(`${method} returns canonical ISO for %s without changing audit evidence`, async (_label, createdAt) => {
      const row = Object.freeze({ ...valid(), id: 'audit_a', createdAt })
      const { repository, query, release } = fixture([row])
      const audit = await read(repository, method)
      expect(audit).toEqual({ ...row, createdAt: '2026-09-15T05:42:00.123Z' })
      expect(audit).not.toBe(row)
      expect(audit?.before).toBe(row.before)
      expect(audit?.after).toBe(row.after)
      expect(row.createdAt).toBe(createdAt)
      expect(query.mock.calls.at(-1)?.[0]).toBe('COMMIT')
      expect(release).toHaveBeenCalledOnce()
      const writes = query.mock.calls.filter(([sql]) => /^(INSERT|UPDATE|DELETE)/u.test(sql))
      if (method === 'append') {
        expect(writes).toEqual([[expect.stringContaining('INSERT INTO workspace_operation_audit'), [
          expect.any(String), row.workspaceId, row.actorId, row.action, row.resourceType, row.resourceId, row.before, row.after, row.reason,
        ]]])
      } else expect(writes).toEqual([])
    })

    it.each([new Date('invalid'), 'not-a-timestamp'])(`${method} rejects an invalid timestamp without inventing the current time`, async createdAt => {
      const { repository, query, release } = fixture([{ ...valid(), id: 'audit_a', createdAt }])
      await expect(read(repository, method)).rejects.toBeInstanceOf(RangeError)
      expect(query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK')
      expect(query.mock.calls.some(([sql]) => sql === 'COMMIT')).toBe(false)
      expect(release).toHaveBeenCalledOnce()
    })
  }

  it('keeps empty list and missing exact audit results unchanged', async () => {
    const { repository, query } = fixture([])
    await expect(repository.list('ws_a')).resolves.toEqual([])
    await expect(repository.find('ws_a', 'member.update', 'workspace_member', 'missing')).resolves.toBeUndefined()
    expect(query.mock.calls.filter(([sql]) => /^(INSERT|UPDATE|DELETE)/u.test(sql))).toEqual([])
  })
})
