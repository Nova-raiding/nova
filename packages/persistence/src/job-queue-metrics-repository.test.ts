import { describe, expect, it } from 'vitest'
import { JOB_QUEUE_GROUPS_SQL, PostgresMerchantJobQueueMetricsRepository } from './job-queue-metrics-repository.js'
import type { SqlClient, SqlPool } from './repository.js'

class RecordingClient implements SqlClient {
  readonly calls: { text: string; values?: readonly unknown[] }[] = []
  private responses: Array<{ rows: any[] }> = []
  enqueue(...rows: any[]) { this.responses.push({ rows }) }
  async query<T = Record<string, unknown>>(text: string, values?: readonly unknown[]) {
    this.calls.push({ text, ...(values ? { values } : {}) })
    return (this.responses.shift() ?? { rows: [] }) as { rows: T[] }
  }
  release() {}
}

const poolFor = (client: RecordingClient): SqlPool => ({ connect: async () => client })

describe('durable job-queue metrics repository', () => {
  it('aggregates all three durable job sources in one workspace-scoped read-only statement', async () => {
    const client = new RecordingClient()
    client.enqueue() // BEGIN
    client.enqueue() // set_config
    client.enqueue({
      queue: 'publish', state: 'unknown', job_count: '2',
      oldest_created_at: new Date('2026-09-19T00:00:00.000Z'),
      oldest_updated_at: new Date('2026-09-19T00:10:00.000Z'),
      oldest_remote_observed_at: new Date('2026-09-19T00:05:00.000Z'),
    }, {
      queue: 'sync', state: 'running', job_count: 3,
      oldest_created_at: '2026-09-19T01:00:00.000Z',
      oldest_updated_at: '2026-09-19T01:00:30.000Z',
      oldest_remote_observed_at: null,
    })
    client.enqueue() // COMMIT
    const repository = new PostgresMerchantJobQueueMetricsRepository(poolFor(client))

    const groups = await repository.jobQueueGroups('ws_metrics')

    expect(groups).toEqual([
      { queue: 'publish', state: 'unknown', count: 2, oldestCreatedAt: '2026-09-19T00:00:00.000Z', oldestUpdatedAt: '2026-09-19T00:10:00.000Z', oldestRemoteObservedAt: '2026-09-19T00:05:00.000Z' },
      { queue: 'sync', state: 'running', count: 3, oldestCreatedAt: '2026-09-19T01:00:00.000Z', oldestUpdatedAt: '2026-09-19T01:00:30.000Z', oldestRemoteObservedAt: null },
    ])

    // Every job source is covered by the same statement, and `sync` is read from
    // the snapshot table because there is no `sync_jobs` relation.
    const aggregate = client.calls.find(call => call.text.includes('publish_jobs'))
    expect(aggregate?.text).toBe(JOB_QUEUE_GROUPS_SQL)
    expect(aggregate?.text).toContain('FROM generation_jobs')
    expect(aggregate?.text).toContain("entity_type = 'sync_job'")
    expect(aggregate?.values).toEqual(['ws_metrics'])
    // A single round trip per workspace: no per-state fan-out. (`set_config` is
    // a SELECT too, so count statement that actually read a relation.)
    expect(client.calls.filter(call => call.text.includes(' FROM '))).toHaveLength(1)
    for (const call of client.calls) expect(call.text).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/u)
  })

  it('scopes the read to the caller workspace through the RLS transaction, never across tenants', async () => {
    const client = new RecordingClient()
    client.enqueue()
    client.enqueue()
    await new PostgresMerchantJobQueueMetricsRepository(poolFor(client)).jobQueueGroups('ws_owner')

    expect(client.calls.map(call => call.text)).toEqual([
      'BEGIN',
      `SELECT set_config('app.workspace_id', $1, true)`,
      JOB_QUEUE_GROUPS_SQL,
      'COMMIT',
    ])
    expect(client.calls[1]?.values).toEqual(['ws_owner'])
    expect(client.calls[2]?.values).toEqual(['ws_owner'])
  })

  it('refuses an absent workspace scope instead of aggregating every tenant', async () => {
    const client = new RecordingClient()
    await expect(new PostgresMerchantJobQueueMetricsRepository(poolFor(client)).jobQueueGroups('')).rejects.toThrow()
    expect(client.calls).toEqual([])
  })
})
