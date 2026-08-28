import { describe, expect, it } from 'vitest'
import { OutboxEventNotFoundError, PostgresOutboxRepository, SqlClient, SqlPool, TenantScopeError, withWorkspaceTransaction } from './repository.js'

type Row = Record<string, unknown>

class RecordingClient implements SqlClient {
  readonly calls: Array<{ text: string; values?: readonly unknown[] }> = []
  private readonly responses: Array<{ rows: Row[] }> = []

  enqueue(...rows: Row[]) { this.responses.push({ rows }) }

  async query<RowType = Row>(text: string, values?: readonly unknown[]) {
    this.calls.push({ text, values })
    return (this.responses.shift() ?? { rows: [] }) as { rows: RowType[] }
  }

  release() {}
}

class RecordingPool implements SqlPool {
  constructor(readonly client: RecordingClient) {}
  async connect() { return this.client }
}

const row = (overrides: Partial<Row> = {}): Row => ({
  id: 'evt_1', workspace_id: 'ws_1', aggregate_id: 'task_1', event_type: 'task.created',
  sequence: 1, payload: { task: 'task_1' }, published_at: null, created_at: '2026-08-22T00:00:00.000Z', ...overrides,
})

describe('PostgresOutboxRepository', () => {
  it('rejects missing workspace before acquiring a pooled connection', async () => {
    const client = new RecordingClient()
    const pool = new RecordingPool(client)
    await expect(new PostgresOutboxRepository(pool).pending('  ')).rejects.toBeInstanceOf(TenantScopeError)
    expect(client.calls).toHaveLength(0)
  })

  it('appends with stable SQL parameter order and returns the inserted event', async () => {
    const client = new RecordingClient()
    client.enqueue(row()) // BEGIN
    client.enqueue() // set_config
    client.enqueue(row()) // insert
    client.enqueue() // COMMIT
    const repository = new PostgresOutboxRepository(new RecordingPool(client))
    const result = await repository.append({ workspaceId: 'ws_1', aggregateId: 'task_1', eventType: 'task.created', sequence: 1, payload: { a: 1 } })
    expect(result.id).toBe('evt_1')
    expect(client.calls[1]).toEqual({ text: `SELECT set_config('app.workspace_id', $1, true)`, values: ['ws_1'] })
    const insert = client.calls.find(call => call.text.includes('INSERT INTO outbox_events'))
    expect(insert?.values?.slice(1)).toEqual(['ws_1', 'task_1', 'task.created', 1, JSON.stringify({ a: 1 })])
    expect(client.calls.at(-1)?.text).toBe('COMMIT')
  })

  it('returns the canonical existing event on unique conflict', async () => {
    const client = new RecordingClient()
    client.enqueue(); client.enqueue(); client.enqueue() // begin, scope, insert no rows
    client.enqueue(row({ id: 'evt_existing', published_at: '2026-08-22T01:00:00.000Z' }))
    client.enqueue() // commit
    const result = await new PostgresOutboxRepository(new RecordingPool(client)).append({ workspaceId: 'ws_1', aggregateId: 'task_1', eventType: 'task.created', sequence: 1, payload: { a: 1 } })
    expect(result.id).toBe('evt_existing')
    const lookup = client.calls.find(call => call.text.includes('SELECT id, workspace_id'))
    expect(lookup?.values).toEqual(['ws_1', 'task_1', 'task.created', 1])
  })

  it('lists only pending events in deterministic order and marks publication idempotently', async () => {
    const client = new RecordingClient()
    client.enqueue(); client.enqueue(); client.enqueue(row({ id: 'evt_2' })); client.enqueue() // pending tx
    client.enqueue(); client.enqueue(); client.enqueue(row({ id: 'evt_2', published_at: '2026-08-22T02:00:00.000Z' })); client.enqueue() // mark tx
    const repository = new PostgresOutboxRepository(new RecordingPool(client))
    expect(await repository.pending('ws_1', 25)).toHaveLength(1)
    const marked = await repository.markPublished('ws_1', 'evt_2', '2026-08-22T02:00:00.000Z')
    expect(marked.publishedAt).toBe('2026-08-22T02:00:00.000Z')
    const pending = client.calls.find(call => call.text.includes('published_at IS NULL'))
    expect(pending?.values).toEqual(['ws_1', 25])
    const update = client.calls.find(call => call.text.includes('UPDATE outbox_events'))
    expect(update?.values).toEqual(['ws_1', 'evt_2', '2026-08-22T02:00:00.000Z'])
  })

  it('lists a tenant-scoped aggregate timeline including delivered and unknown events', async () => {
    const client = new RecordingClient()
    client.enqueue(); client.enqueue(); client.enqueue(
      row({ id: 'evt_created', event_type: 'task.created' }),
      row({ id: 'evt_unknown', event_type: 'publish.observation', sequence: 2, unknown_at: '2026-08-22T02:00:00.000Z', published_at: null }),
    ); client.enqueue()
    const repository = new PostgresOutboxRepository(new RecordingPool(client))
    const events = await repository.listAggregateEvents('ws_1', 'task_1', 25)
    expect(events.map(event => event.eventType)).toEqual(['task.created', 'publish.observation'])
    expect(events[1]?.unknownAt).toBe('2026-08-22T02:00:00.000Z')
    const query = client.calls.find(call => call.text.includes('WHERE workspace_id = $1 AND aggregate_id = $2'))
    expect(query?.values).toEqual(['ws_1', 'task_1', 25])
  })

  it('does not expose cross-workspace events as markable', async () => {
    const client = new RecordingClient()
    client.enqueue(); client.enqueue(); client.enqueue(); client.enqueue() // begin, scope, update no rows, rollback
    const repository = new PostgresOutboxRepository(new RecordingPool(client))
    await expect(repository.markPublished('ws_other', 'evt_1', '2026-08-22T02:00:00.000Z')).rejects.toBeInstanceOf(OutboxEventNotFoundError)
    expect(client.calls.at(-1)?.text).toBe('ROLLBACK')
  })

  it('rolls back and releases when scoped work fails', async () => {
    const client = new RecordingClient()
    const pool = new RecordingPool(client)
    await expect(withWorkspaceTransaction(pool, undefined, async () => 'never')).rejects.toBeInstanceOf(TenantScopeError)
    expect(client.calls).toHaveLength(0)
    await expect(withWorkspaceTransaction(pool, 'ws_1', async () => { throw new Error('boom') })).rejects.toThrow('boom')
    expect(client.calls.map(call => call.text)).toEqual(['BEGIN', `SELECT set_config('app.workspace_id', $1, true)`, 'ROLLBACK'])
  })
})
