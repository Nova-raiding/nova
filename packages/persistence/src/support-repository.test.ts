import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import type { SqlClient, SqlPool } from './repository.js'
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

type SupportPgRow = Record<string, any>

/** Serves the per-ticket event read and the batched `ticket_id = ANY($2)` form
 * from one fixture, and honours the workspace predicate so tenant scoping is
 * still observable from the unit suite. */
class BatchedSupportPool implements SqlPool {
  readonly statements: string[] = []
  constructor(private readonly tickets: readonly SupportPgRow[], private readonly events: readonly SupportPgRow[]) {}
  async connect(): Promise<SqlClient> {
    return {
      query: async <Row>(text: string, values: readonly unknown[] = []) => {
        this.statements.push(text)
        if (text.includes('FROM workspace_support_tickets')) {
          return { rows: this.tickets.filter(ticket => ticket.workspace_id === values[0]).map(ticket => ({ ...ticket })) as Row[] }
        }
        if (text.includes('FROM workspace_support_ticket_events')) {
          const selector = values[1]
          const ticketIds = Array.isArray(selector) ? selector.map(String) : [String(selector)]
          const rows = this.events
            .filter(event => ticketIds.includes(String(event.ticket_id)) && event.workspace_id === values[0])
            .map(event => ({ ...event }))
            .sort((left, right) => Number(left.sequence) - Number(right.sequence))
          return { rows: rows as Row[] }
        }
        return { rows: [] as Row[] }
      },
      release: () => {},
    }
  }
}

const slaSnapshotRow = (overrides: SupportPgRow = {}): SupportPgRow => ({
  policy: { version: 1, calendar: 'business_weekday_utc', firstResponseMinutes: 480, resolutionMinutes: 2880 },
  firstResponseDueAt: '2099-09-11T12:00:00.000Z',
  resolutionDueAt: '2099-09-14T12:00:00.000Z',
  pausedMinutes: 0,
  state: 'on_track',
  ...overrides,
})

const supportTicketRow = (id: string, ticketNumber: string, createdAt: string, overrides: SupportPgRow = {}): SupportPgRow => ({
  id: `00000000-0000-4000-8000-00000000000${id}`,
  workspace_id: 'ws_1',
  ticket_number: ticketNumber,
  subject: `工单 ${ticketNumber}`,
  description: '描述',
  status: 'open',
  priority: 'normal',
  customer_id: 'customer_1',
  customer_name: '云朵商家',
  customer_email: null,
  assigned_to: null,
  related_order_id: null,
  related_task_id: null,
  tags: [],
  revision: 1,
  created_by: 'support_1',
  created_at: createdAt,
  updated_at: createdAt,
  sla_snapshot_json: slaSnapshotRow(),
  ...overrides,
})

const supportEventRow = (id: string, ticketId: string, sequence: number, eventType: string, createdAt: string, payload: Record<string, unknown>): SupportPgRow => ({
  id: `10000000-0000-4000-8000-00000000000${id}`,
  workspace_id: 'ws_1',
  ticket_id: `00000000-0000-4000-8000-00000000000${ticketId}`,
  sequence,
  event_type: eventType,
  actor_id: 'support_1',
  idempotency_key: `idem-${id}-padpadpad`,
  payload_json: payload,
  created_at: createdAt,
})

// Newest first: created_at DESC, id DESC is the page order.
const supportTicketRows = [
  supportTicketRow('1', 'SUP-1', '2026-09-10T04:00:00.000Z', { priority: 'high', revision: 2, tags: ['payment'] }),
  supportTicketRow('2', 'SUP-2', '2026-09-10T03:00:00.000Z', { priority: 'urgent', revision: 3, status: 'resolved' }),
  supportTicketRow('3', 'SUP-3', '2026-09-10T02:00:00.000Z', { priority: 'low' }),
  supportTicketRow('4', 'SUP-4', '2026-09-10T01:00:00.000Z', {}),
  supportTicketRow('9', 'SUP-9', '2026-09-10T05:00:00.000Z', { workspace_id: 'ws_2' }),
]

const supportEventRows = [
  supportEventRow('11', '1', 1, 'created', '2026-09-10T04:00:00.000Z', { status: 'open', priority: 'high' }),
  // the only customer-visible reply in the fixture: it must stay on ticket 1
  supportEventRow('12', '1', 2, 'commented', '2026-09-10T05:00:00.000Z', { body: '已回复客户', visibility: 'customer' }),
  supportEventRow('21', '2', 1, 'created', '2026-09-10T03:00:00.000Z', { status: 'open', priority: 'urgent' }),
  supportEventRow('22', '2', 2, 'status_changed', '2026-09-10T08:00:00.000Z', { from: 'open', to: 'waiting_customer', reason: '等待客户' }),
  supportEventRow('23', '2', 3, 'status_changed', '2026-09-10T20:00:00.000Z', { from: 'waiting_customer', to: 'resolved', reason: '客户确认' }),
  supportEventRow('31', '3', 1, 'created', '2026-09-10T02:00:00.000Z', { status: 'open', priority: 'low' }),
  supportEventRow('91', '9', 1, 'created', '2026-09-10T05:00:00.000Z', { status: 'open', priority: 'normal' }),
]

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

  it('records an idempotent SLA action without changing ticket status', async () => {
    const repository = new MemorySupportRepository()
    const created = await repository.create(createInput())
    const action = await repository.recordSlaAction({ workspaceId: 'ws_1', ticketId: created.ticket.id, state: 'at_risk', dueAt: created.ticket.sla.firstResponseDueAt, expectedRevision: 1, actorId: 'sla-worker', idempotencyKey: 'sla-action-001' })
    const replay = await repository.recordSlaAction({ workspaceId: 'ws_1', ticketId: created.ticket.id, state: 'at_risk', dueAt: created.ticket.sla.firstResponseDueAt, expectedRevision: 1, actorId: 'sla-worker', idempotencyKey: 'sla-action-001' })
    expect(action.ticket.status).toBe('open')
    expect(action.event.eventType).toBe('sla_at_risk')
    expect(replay.replayed).toBe(true)
    expect((await repository.listEvents('ws_1', created.ticket.id)).at(-1)).toMatchObject({ eventType: 'sla_at_risk', sequence: 2 })
  })

  it('filters the queue by the projected SLA state', async () => {
    const repository = new MemorySupportRepository()
    const created = await repository.create(createInput({ idempotencyKey: 'sla-filter-001' }))
    expect((await repository.list({ workspaceId: 'ws_1', slaState: 'on_track' })).items.map(ticket => ticket.id)).toContain(created.ticket.id)

    await repository.transition({ workspaceId: 'ws_1', ticketId: created.ticket.id, status: 'in_progress', reason: '开始处理', expectedRevision: 1, actorId: 'support_1', idempotencyKey: 'sla-filter-transition-001' })
    await repository.transition({ workspaceId: 'ws_1', ticketId: created.ticket.id, status: 'resolved', reason: '问题已解决', expectedRevision: 2, actorId: 'support_1', idempotencyKey: 'sla-filter-transition-002' })
    expect((await repository.list({ workspaceId: 'ws_1', slaState: 'met' })).items.map(ticket => ticket.id)).toContain(created.ticket.id)
    expect((await repository.list({ workspaceId: 'ws_1', slaState: 'on_track' })).items.map(ticket => ticket.id)).not.toContain(created.ticket.id)
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

  it('reads the whole ticket page event stream in one batched query instead of one query per ticket', async () => {
    const pool = new BatchedSupportPool(supportTicketRows, supportEventRows)
    const repository = new PostgresSupportRepository(pool)
    const page = await repository.list({ workspaceId: 'ws_1', limit: 2 })

    const eventQueries = pool.statements.filter(statement => statement.includes('FROM workspace_support_ticket_events'))
    expect(eventQueries).toHaveLength(1)
    expect(eventQueries[0]).toContain('ticket_id = ANY(')
    expect(eventQueries[0]).toContain('workspace_id=$1')
    expect(eventQueries[0]).toContain('ORDER BY ticket_id, sequence ASC')
    expect(page.items.map(item => item.ticketNumber)).toEqual(['SUP-1', 'SUP-2'])
    expect(page.nextCursor).toEqual({ createdAt: '2026-09-10T03:00:00.000Z', id: '00000000-0000-4000-8000-000000000002' })

    const emptyPool = new BatchedSupportPool(supportTicketRows, supportEventRows)
    expect(await new PostgresSupportRepository(emptyPool).list({ workspaceId: 'ws_absent', limit: 2 })).toEqual({ items: [] })
    expect(emptyPool.statements.filter(statement => statement.includes('FROM workspace_support_ticket_events'))).toHaveLength(0)
  })

  it('keeps every ticket projected from its own event stream after the batched read', async () => {
    const pool = new BatchedSupportPool(supportTicketRows, supportEventRows)
    const page = await new PostgresSupportRepository(pool).list({ workspaceId: 'ws_1', limit: 4 })

    expect(page.items.map(item => item.ticketNumber)).toEqual(['SUP-1', 'SUP-2', 'SUP-3', 'SUP-4'])
    expect(page.nextCursor).toBeUndefined()
    expect(page.items[0]).toMatchObject({ tags: ['payment'], priority: 'high', revision: 2 })
    // the only customer-visible reply stays on ticket 1
    expect(page.items[0]!.sla).toMatchObject({ firstResponseAt: '2026-09-10T05:00:00.000Z', pausedMinutes: 0, state: 'on_track' })
    expect(page.items[0]!.sla.resolvedAt).toBeUndefined()
    // the waiting-customer pause and the resolution stay on ticket 2
    expect(page.items[1]!.sla).toMatchObject({ resolvedAt: '2026-09-10T20:00:00.000Z', pausedMinutes: 540, state: 'met' })
    expect(page.items[1]!.sla.firstResponseAt).toBeUndefined()
    expect(page.items[2]!.sla).toMatchObject({ pausedMinutes: 0, state: 'on_track' })
    expect(page.items[2]!.sla.firstResponseAt).toBeUndefined()
    expect(page.items[2]!.sla.resolvedAt).toBeUndefined()
    // ticket 4 has no events at all: the projection keeps its snapshot facts
    expect(page.items[3]!.sla).toMatchObject({ pausedMinutes: 0, state: 'on_track' })
    expect(page.items[3]!.sla.firstResponseAt).toBeUndefined()

    expect(pool.statements.filter(statement => statement.includes('FROM workspace_support_ticket_events'))).toHaveLength(1)
  })
})
