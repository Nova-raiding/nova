import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import type { SqlClient } from './repository.js'
import {
  MemorySupportRepository,
  PostgresSupportRepository,
  SupportTicketIdempotencyConflictError,
  SupportTicketRevisionConflictError,
} from './support-repository.js'

const createInput = (overrides: Partial<Parameters<MemorySupportRepository['create']>[0]> = {}) => ({
  workspaceId: 'ws_1', subject: '支付订单异常', description: '客户已付款但余额未到账', priority: 'high' as const,
  customerId: 'customer_1', customerName: '云朵商家', customerEmail: 'owner@example.test', tags: ['Payment', ' payment '],
  actorId: 'support_1', idempotencyKey: 'create-ticket-001', ...overrides,
})

describe('MemorySupportRepository', () => {
  it('creates an idempotent ticket and immutable first event', async () => {
    const repository = new MemorySupportRepository()
    const first = await repository.create(createInput())
    const replay = await repository.create(createInput())

    expect(first.replayed).toBe(false)
    expect(replay.replayed).toBe(true)
    expect(replay.ticket.id).toBe(first.ticket.id)
    expect(replay.ticket.tags).toEqual(['payment'])
    expect(await repository.listEvents('ws_1', first.ticket.id)).toMatchObject([
      { sequence: 1, eventType: 'created', actorId: 'support_1' },
    ])
  })

  it('rejects an idempotency key reused for a different create identity', async () => {
    const repository = new MemorySupportRepository()
    await repository.create(createInput())
    await expect(repository.create(createInput({ subject: '另一个问题' }))).rejects.toBeInstanceOf(SupportTicketIdempotencyConflictError)
    await expect(repository.create(createInput({ actorId: 'support_2' }))).rejects.toBeInstanceOf(SupportTicketIdempotencyConflictError)
  })

  it('uses optimistic revision and append-only ordered events for every mutation', async () => {
    const repository = new MemorySupportRepository()
    const created = await repository.create(createInput())
    const assigned = await repository.assign({ workspaceId: 'ws_1', ticketId: created.ticket.id, assigneeId: 'support_2', expectedRevision: 1, actorId: 'ops_1', idempotencyKey: 'assign-ticket-001' })
    const assignmentReplay = await repository.assign({ workspaceId: 'ws_1', ticketId: created.ticket.id, assigneeId: 'support_2', expectedRevision: 1, actorId: 'ops_1', idempotencyKey: 'assign-ticket-001' })
    const transitioned = await repository.transition({ workspaceId: 'ws_1', ticketId: created.ticket.id, status: 'in_progress', reason: '开始排查', expectedRevision: 2, actorId: 'support_2', idempotencyKey: 'transition-ticket-001' })
    const commented = await repository.comment({ workspaceId: 'ws_1', ticketId: created.ticket.id, body: '已核对支付回调。', visibility: 'internal', expectedRevision: 3, actorId: 'support_2', idempotencyKey: 'comment-ticket-001' })

    expect(commented.ticket).toMatchObject({ assignedTo: 'support_2', status: 'in_progress', revision: 4 })
    expect(assignmentReplay).toMatchObject({ replayed: true, ticket: { revision: 2 } })
    expect((await repository.listEvents('ws_1', created.ticket.id)).map(event => [event.sequence, event.eventType])).toEqual([
      [1, 'created'], [2, 'assigned'], [3, 'status_changed'], [4, 'commented'],
    ])
    await expect(repository.assign({ workspaceId: 'ws_1', ticketId: created.ticket.id, assigneeId: 'support_3', expectedRevision: 2, actorId: 'ops_1', idempotencyKey: 'assign-ticket-002' })).rejects.toBeInstanceOf(SupportTicketRevisionConflictError)
    await expect(repository.assign({ workspaceId: 'ws_1', ticketId: created.ticket.id, assigneeId: 'support_3', expectedRevision: 1, actorId: 'ops_1', idempotencyKey: 'assign-ticket-001' })).rejects.toBeInstanceOf(SupportTicketIdempotencyConflictError)
    await expect(repository.assign({ workspaceId: 'ws_1', ticketId: created.ticket.id, assigneeId: 'support_2', expectedRevision: 1, actorId: 'ops_2', idempotencyKey: 'assign-ticket-001' })).rejects.toBeInstanceOf(SupportTicketIdempotencyConflictError)
    expect(transitioned.event.payload).toMatchObject({ from: 'open', to: 'in_progress', reason: '开始排查' })
  })

  it('isolates tenants and paginates with a stable created-at/id cursor', async () => {
    const repository = new MemorySupportRepository()
    await repository.create(createInput({ idempotencyKey: 'create-ticket-001' }))
    await repository.create(createInput({ subject: '第二个工单', idempotencyKey: 'create-ticket-002' }))
    await repository.create(createInput({ workspaceId: 'ws_2', subject: '其他租户工单', idempotencyKey: 'create-ticket-003' }))

    const first = await repository.list({ workspaceId: 'ws_1', limit: 1 })
    const second = await repository.list({ workspaceId: 'ws_1', limit: 1, cursor: first.nextCursor })
    expect(first.items).toHaveLength(1)
    expect(second.items).toHaveLength(1)
    expect(first.items[0]?.id).not.toBe(second.items[0]?.id)
    expect([...first.items, ...second.items].every(ticket => ticket.workspaceId === 'ws_1')).toBe(true)
  })

  it('builds a tenant-scoped CRM projection without exposing event comments', async () => {
    const repository = new MemorySupportRepository()
    const one = await repository.create(createInput())
    await repository.create(createInput({ subject: '同客户第二单', idempotencyKey: 'create-ticket-002', priority: 'urgent' }))
    await repository.comment({ workspaceId: 'ws_1', ticketId: one.ticket.id, body: '内部敏感备注', visibility: 'internal', expectedRevision: 1, actorId: 'support_1', idempotencyKey: 'comment-ticket-001' })

    const crm = await repository.listCrmProjection('ws_1')
    expect(crm).toEqual([expect.objectContaining({ customerId: 'customer_1', totalTickets: 2, openTickets: 2, urgentTickets: 1 })])
    expect(JSON.stringify(crm)).not.toContain('内部敏感备注')
  })
})

describe('PostgresSupportRepository', () => {
  it('defines tenant RLS and database-enforced append-only support events', () => {
    const migration = readFileSync(new URL('./migrations/055_support_crm.sql', import.meta.url), 'utf8')
    expect(migration).toContain('ALTER TABLE workspace_support_tickets FORCE ROW LEVEL SECURITY')
    expect(migration).toContain("workspace_id = current_setting('app.workspace_id', true)")
    expect(migration).toContain('BEFORE UPDATE OR DELETE ON workspace_support_ticket_events')
    expect(migration).toContain('REVOKE UPDATE, DELETE, TRUNCATE ON workspace_support_ticket_events FROM PUBLIC')
    expect(migration).toContain('UNIQUE (workspace_id, idempotency_key)')
  })

  it('sets transaction-local tenant scope for reads', async () => {
    const queries: Array<{ sql: string; values?: readonly unknown[] }> = []
    const query = vi.fn(async (sql: string, values?: readonly unknown[]) => {
      queries.push({ sql, values })
      return { rows: [] }
    })
    const client: SqlClient = { query: query as SqlClient['query'], release: vi.fn() }
    const repository = new PostgresSupportRepository({ connect: async () => client })

    await repository.list({ workspaceId: 'ws_tenant', limit: 20 })

    expect(queries.map(item => item.sql)).toEqual(expect.arrayContaining(['BEGIN', "SELECT set_config('app.workspace_id', $1, true)", 'COMMIT']))
    expect(queries.find(item => item.sql.includes('set_config'))?.values).toEqual(['ws_tenant'])
    expect(queries.find(item => item.sql.includes('FROM workspace_support_tickets'))?.values?.[0]).toBe('ws_tenant')
    expect(client.release).toHaveBeenCalledOnce()
  })

  it('orders the bounded CRM projection by latest activity before applying its limit', async () => {
    const queries: string[] = []
    const query = vi.fn(async (sql: string) => {
      queries.push(sql)
      return { rows: [] }
    })
    const client: SqlClient = { query: query as SqlClient['query'], release: vi.fn() }
    const repository = new PostgresSupportRepository({ connect: async () => client })

    await repository.listCrmProjection('ws_1', 25)

    const projectionQuery = queries.find(sql => sql.includes('WITH ranked AS')) ?? ''
    expect(projectionQuery).toContain('ROW_NUMBER() OVER (PARTITION BY customer_id ORDER BY created_at DESC, id DESC)')
    expect(projectionQuery).toMatch(/WHERE customer_rank=1\s+ORDER BY created_at DESC, id DESC\s+LIMIT \$2/)
  })

  it('rolls back when an append-only event cannot be persisted', async () => {
    const ticketRow = {
      id: '11111111-1111-4111-8111-111111111111', workspace_id: 'ws_1', ticket_number: 'SUP-1', subject: '支付订单异常',
      description: '客户已付款但余额未到账', status: 'open', priority: 'high', customer_id: 'customer_1', customer_name: '云朵商家',
      customer_email: null, assigned_to: null, related_order_id: null, related_task_id: null, tags: [], revision: 1,
      created_by: 'support_1', created_at: new Date(), updated_at: new Date(),
    }
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('pg_advisory_xact_lock')) return { rows: [] }
      if (sql.includes('SELECT id, workspace_id, ticket_id')) return { rows: [] }
      if (sql.startsWith('INSERT INTO workspace_support_tickets')) return { rows: [ticketRow] }
      if (sql.startsWith('INSERT INTO workspace_support_ticket_events')) throw new Error('event store unavailable')
      return { rows: [] }
    })
    const client: SqlClient = { query: query as SqlClient['query'], release: vi.fn() }
    const repository = new PostgresSupportRepository({ connect: async () => client })

    await expect(repository.create(createInput())).rejects.toThrow('event store unavailable')
    expect(query).toHaveBeenCalledWith('ROLLBACK')
    expect(query).toHaveBeenCalledWith('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', ['support:ws_1:create-ticket-001'])
  })
})
