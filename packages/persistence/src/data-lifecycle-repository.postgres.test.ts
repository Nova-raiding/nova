import { describe, expect, it } from 'vitest'
import { PostgresDataLifecycleRepository } from './data-lifecycle-repository.js'
import type { SqlClient, SqlPool } from './repository.js'

type Row = Record<string, unknown>

class RecordingClient implements SqlClient {
  readonly calls: Array<{ text: string; values?: readonly unknown[] }> = []
  private readonly responses: Array<{ rows: Row[]; rowCount?: number }> = []

  enqueue(response: { rows?: Row[]; rowCount?: number } = {}) { this.responses.push({ rows: response.rows ?? [], rowCount: response.rowCount }) }

  async query<T = Row>(text: string, values?: readonly unknown[]) {
    this.calls.push({ text, values })
    return (this.responses.shift() ?? { rows: [] }) as { rows: T[]; rowCount?: number }
  }

  release() {}
}

class RecordingPool implements SqlPool {
  constructor(readonly client: RecordingClient) {}
  async connect() { return this.client }
}

const row = (overrides: Row = {}): Row => ({
  id: 'deletion-1', workspaceId: 'ws_delete', scope: 'assets', reason: '删除历史素材', requestedBy: 'owner',
  requestedAt: '2026-08-20T00:00:00.000Z', gracePeriodDays: 7, scheduledFor: '2026-08-27T00:00:00.000Z',
  status: 'pending', approvals: [], ...overrides,
})

describe('PostgresDataLifecycleRepository', () => {
  it('uses a workspace transaction and replays an existing request by intent', async () => {
    const client = new RecordingClient()
    client.enqueue()
    client.enqueue()
    client.enqueue({ rows: [row()] })
    const repository = new PostgresDataLifecycleRepository(new RecordingPool(client))

    const result = await repository.request({ workspaceId: 'ws_delete', scope: 'assets', reason: '删除历史素材', requestedBy: 'owner', gracePeriodDays: 7, idempotencyKey: 'delete-1' })

    expect(result.id).toBe('deletion-1')
    expect(client.calls.map(call => call.text)).toEqual([
      'BEGIN',
      "SELECT set_config('app.workspace_id', $1, true)",
      expect.stringContaining('WHERE workspace_id=$1 AND idempotency_key=$2'),
      'COMMIT',
    ])
    expect(client.calls[2]?.values).toEqual(['ws_delete', 'delete-1'])
  })

  it('locks approvals and only completes an approved request after the grace period', async () => {
    const client = new RecordingClient()
    client.enqueue()
    client.enqueue()
    client.enqueue({ rows: [row({ approvals: [{ actorId: 'operator-a', approvedAt: '2026-08-20T00:00:00.000Z', reason: '复核范围' }] })] })
    client.enqueue({ rows: [row({ status: 'approved', approvals: [{ actorId: 'operator-a' }, { actorId: 'operator-b' }] })] })
    client.enqueue()
    client.enqueue()
    client.enqueue()
    client.enqueue({ rows: [row({ status: 'completed', completedBy: 'deletion-worker', executionProofRef: 'artifact://delete/1' })] })
    const repository = new PostgresDataLifecycleRepository(new RecordingPool(client))

    const approved = await repository.approve({ workspaceId: 'ws_delete', id: 'deletion-1', actorId: 'operator-b', reason: '独立复核通过' })
    const completed = await repository.complete({ workspaceId: 'ws_delete', id: 'deletion-1', workerId: 'deletion-worker', proofRef: 'artifact://delete/1', now: '2026-08-28T00:00:00.000Z' })

    expect(approved.status).toBe('approved')
    expect(completed).toMatchObject({ status: 'completed', completedBy: 'deletion-worker' })
    const approvalSelect = client.calls.find(call => call.text.includes('FOR UPDATE'))
    expect(approvalSelect?.text).toContain('WHERE workspace_id=$1 AND id=$2 FOR UPDATE')
    const completion = client.calls.find(call => call.text.includes("SET status='completed'"))
    expect(completion?.text).toContain("status='approved'")
    expect(completion?.text).toContain('jsonb_array_length(approvals) >= 2')
    expect(completion?.text).toContain('scheduled_for <= $5::timestamptz')
    expect(completion?.values?.at(-1)).toBe('2026-08-28T00:00:00.000Z')
  })

  it('rejects missing workspace scope before connecting to PostgreSQL', async () => {
    let connections = 0
    const repository = new PostgresDataLifecycleRepository({ connect: async () => { connections += 1; throw new Error('must not connect') } })
    await expect(repository.list('')).rejects.toThrow(/workspace/i)
    expect(connections).toBe(0)
  })
})
