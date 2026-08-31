import { describe, expect, it } from 'vitest'
import type { SqlClient, SqlPool } from './repository.js'
import { PostgresOpsDataRepository } from './ops-data-repository.js'

class Client implements SqlClient {
  readonly calls: string[] = []
  readonly values: unknown[][] = []
  released = false
  constructor(private readonly rows: Record<string, unknown>[] = [], private readonly totalCount?: number) {}
  async query<Row = Record<string, unknown>>(text: string, values: readonly unknown[] = []) {
    this.calls.push(text)
    this.values.push([...values])
    if (text.includes('count(*)::integer')) return { rows: [{ totalCount: this.totalCount ?? this.rows[0]?.totalCount ?? 0 }] as Row[] }
    return { rows: (text.includes('FROM ops_workspace_summaries') ? this.rows : []) as Row[] }
  }
  release() { this.released = true }
}

class Pool implements SqlPool {
  constructor(readonly client: Client) {}
  async connect() { return this.client }
}

describe('PostgresOpsDataRepository', () => {
  it('uses a read-only platform-scoped transaction and returns safe empty state', async () => {
    const client = new Client()
    await expect(new PostgresOpsDataRepository(new Pool(client)).listWorkspaceSummaries()).resolves.toEqual([])
    expect(client.calls[0]).toBe('BEGIN READ ONLY')
    expect(client.calls[1]).toContain("set_config('app.platform_scope', 'platform_ops', true)")
    expect(client.calls[2]).toContain('FROM ops_workspace_summaries')
    expect(client.calls.at(-1)).toBe('COMMIT')
    expect(client.released).toBe(true)
  })

  it('rolls back and releases a failed query', async () => {
    const client = new Client()
    client.query = async (text: string) => {
      client.calls.push(text)
      if (text.includes('FROM ops_workspace_summaries')) throw new Error('connection lost')
      return { rows: [] }
    }
    await expect(new PostgresOpsDataRepository(new Pool(client)).listWorkspaceSummaries()).rejects.toThrow('connection lost')
    expect(client.calls.at(-1)).toBe('ROLLBACK')
    expect(client.released).toBe(true)
  })

  it('applies server-side filters and pagination inside the platform-scoped read transaction', async () => {
    const client = new Client([{ workspaceId: 'ws_b', status: 'active', planName: 'Pro' }], 3)
    const page = await new PostgresOpsDataRepository(new Pool(client)).listWorkspaceDirectory({ query: 'Pro', status: 'active', subscriptionStatus: 'trialing', offset: 1, limit: 1 })
    expect(page).toEqual({ items: [{ workspaceId: 'ws_b', status: 'active', planName: 'Pro' }], total: 3, offset: 1, limit: 1, hasMore: true })
    const query = client.calls.findIndex(call => call.includes('OFFSET'))
    expect(client.values[query]).toEqual(['%Pro%', 'active', 'trialing', 1, 1])
    expect(client.calls[query]).not.toContain('count(*) OVER()')
    expect(client.calls[query]).toContain('OFFSET $4 LIMIT $5')
  })

  it('preserves the total when the requested offset is beyond the final page', async () => {
    const client = new Client([], 3)
    const page = await new PostgresOpsDataRepository(new Pool(client)).listWorkspaceDirectory({ offset: 3, limit: 2 })
    expect(page).toEqual({ items: [], total: 3, offset: 3, limit: 2, hasMore: false })
    const countQuery = client.calls.find(call => call.includes('count(*)::integer'))
    expect(countQuery).toContain('FROM ops_workspace_summaries')
    expect(client.calls.filter(call => call.includes('FROM ops_workspace_summaries'))).toHaveLength(2)
  })
})
