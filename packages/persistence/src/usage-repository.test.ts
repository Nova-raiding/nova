import { describe, expect, it } from 'vitest'
import { MemoryUsageRepository, PostgresUsageRepository, UsageIdempotencyConflictError } from './usage-repository.js'
import type { SqlClient, SqlPool } from './repository.js'

type Row = Record<string, unknown>

class RecordingClient implements SqlClient {
  readonly calls: string[] = []
  private readonly responses: Array<{ rows: Row[]; rowCount?: number }> = []
  enqueue(response: { rows?: Row[]; rowCount?: number } = {}) { this.responses.push({ rows: response.rows ?? [], rowCount: response.rowCount }) }
  async query<T = Row>(text: string) {
    this.calls.push(text)
    return (this.responses.shift() ?? { rows: [] }) as { rows: T[]; rowCount?: number }
  }
  release() {}
}

class RecordingPool implements SqlPool {
  constructor(readonly client: RecordingClient) {}
  async connect() { return this.client }
}

describe('PostgresUsageRepository', () => {
  it('locks the workspace quota row before looking up an idempotency key', async () => {
    const client = new RecordingClient()
    client.enqueue() // BEGIN
    client.enqueue() // workspace scope
    client.enqueue() // ensure settings row
    client.enqueue() // lock settings row
    client.enqueue() // reset period
    client.enqueue({ rows: [] }) // idempotency lookup
    client.enqueue({ rowCount: 1 }) // increment quota
    client.enqueue() // ledger insert
    client.enqueue({ rows: [{ periodStart: '2026-08-01', includedTasks: 5, usedTasks: 1 }] })
    client.enqueue() // COMMIT

    await new PostgresUsageRepository(new RecordingPool(client)).consume({ workspaceId: 'ws_usage', taskId: 'task_1', idempotencyKey: 'charge_1', actorId: 'actor_1' })

    const lockIndex = client.calls.findIndex(call => call.includes('workspace_commercial_settings') && call.includes('FOR UPDATE'))
    const lookupIndex = client.calls.findIndex(call => call.includes('FROM workspace_usage_ledger'))
    expect(lockIndex).toBeGreaterThan(-1)
    expect(lookupIndex).toBeGreaterThan(lockIndex)
  })

  it('resets a stale usage period before reporting the snapshot', async () => {
    const client = new RecordingClient()
    client.enqueue()
    client.enqueue()
    client.enqueue()
    client.enqueue()
    client.enqueue({ rows: [{ periodStart: '2026-08-01', includedTasks: 5, usedTasks: 0 }] })
    client.enqueue()

    const snapshot = await new PostgresUsageRepository(new RecordingPool(client)).get('ws_usage')

    expect(snapshot).toEqual({ workspaceId: 'ws_usage', periodStart: '2026-08-01', includedTasks: 5, usedTasks: 0, remainingTasks: 5 })
    expect(client.calls[3]).toContain('usage_period_start=date_trunc')
  })

  it('rolls the period before applying a refund', async () => {
    const client = new RecordingClient()
    client.enqueue()
    client.enqueue()
    client.enqueue()
    client.enqueue({ rowCount: 1 })
    client.enqueue({ rowCount: 1 })
    client.enqueue({ rows: [{ periodStart: '2026-08-01', includedTasks: 5, usedTasks: 0 }] })
    client.enqueue()

    const result = await new PostgresUsageRepository(new RecordingPool(client)).refund({ workspaceId: 'ws_usage', taskId: 'task_1', idempotencyKey: 'charge_1', actorId: 'actor_1', reason: 'provider failed' })

    expect(result).toEqual({ snapshot: { workspaceId: 'ws_usage', periodStart: '2026-08-01', includedTasks: 5, usedTasks: 0, remainingTasks: 5 }, refunded: true })
    expect(client.calls[2]).toContain('usage_period_start=date_trunc')
  })
})

describe('MemoryUsageRepository', () => {
  it('rejects idempotency reuse for a different task', async () => {
    const repository = new MemoryUsageRepository(async () => ({ includedTasks: 3 }))
    await repository.consume({ workspaceId: 'ws_usage', taskId: 'task_1', idempotencyKey: 'charge_1', actorId: 'actor_1' })

    await expect(repository.consume({ workspaceId: 'ws_usage', taskId: 'task_2', idempotencyKey: 'charge_1', actorId: 'actor_1' })).rejects.toBeInstanceOf(UsageIdempotencyConflictError)
  })
})
