import { describe, expect, it } from 'vitest'
import { MemoryReconciliationStatusRepository, PostgresReconciliationStatusRepository, ReconciliationIdempotencyConflictError } from './reconciliation-status-repository.js'
import type { SqlClient, SqlPool } from './repository.js'

class RecordingClient implements SqlClient {
  readonly calls: string[] = []
  private responses: Array<{ rows: any[] }> = []
  enqueue(...rows: any[]) { this.responses.push({ rows }) }
  async query<T = Record<string, unknown>>(text: string) { this.calls.push(text); return (this.responses.shift() ?? { rows: [] }) as { rows: T[] } }
  release() {}
}

describe('reconciliation status repository', () => {
  it('upserts idempotently and reads the latest workspace status', async () => {
    const repository = new MemoryReconciliationStatusRepository()
    const first = await repository.upsert({ workspaceId: 'ws-a', resourceType: 'asset', resourceId: 'asset-1', status: 'running', idempotencyKey: 'run-1', observedAt: '2026-08-29T00:00:00.000Z' })
    const replay = await repository.upsert({ workspaceId: 'ws-a', resourceType: 'asset', resourceId: 'asset-1', status: 'running', idempotencyKey: 'run-1', observedAt: '2026-08-29T00:00:00.000Z' })
    expect(replay).toEqual(first)
    const latest = await repository.upsert({ workspaceId: 'ws-a', resourceType: 'asset', resourceId: 'asset-1', status: 'succeeded', idempotencyKey: 'run-2', details: { clean: true }, observedAt: '2026-08-29T00:00:01.000Z' })
    expect(latest.revision).toBe(2)
    expect(await repository.getLatest({ workspaceId: 'ws-a', resourceType: 'asset', resourceId: 'asset-1' })).toEqual(latest)
    expect(await repository.list({ workspaceId: 'ws-a', resourceType: 'asset' })).toEqual([latest])
    expect(await repository.getLatest({ workspaceId: 'ws-b' })).toBeUndefined()
    expect(await repository.list({ workspaceId: 'ws-b' })).toEqual([])
  })

  it('rejects reuse of an idempotency key with different content', async () => {
    const repository = new MemoryReconciliationStatusRepository()
    await repository.upsert({ workspaceId: 'ws-a', resourceType: 'quota', resourceId: 'workspace', status: 'failed', idempotencyKey: 'same-key' })
    await expect(repository.upsert({ workspaceId: 'ws-a', resourceType: 'quota', resourceId: 'workspace', status: 'succeeded', idempotencyKey: 'same-key' })).rejects.toBeInstanceOf(ReconciliationIdempotencyConflictError)
  })

  it('does not let a late observation overwrite a newer snapshot or advance revision', async () => {
    const repository = new MemoryReconciliationStatusRepository()
    const current = await repository.upsert({ workspaceId: 'ws-a', resourceType: 'asset', resourceId: 'asset-1', status: 'succeeded', idempotencyKey: 'run-new', details: { clean: true }, observedAt: '2026-08-29T00:00:02.000Z' })
    const stale = await repository.upsert({ workspaceId: 'ws-a', resourceType: 'asset', resourceId: 'asset-1', status: 'failed', idempotencyKey: 'run-old', details: { clean: false }, observedAt: '2026-08-29T00:00:01.000Z' })
    expect(stale).toEqual(current)
    expect(await repository.getLatest({ workspaceId: 'ws-a', resourceType: 'asset', resourceId: 'asset-1' })).toEqual(current)
  })

  it('lists durable rows through a workspace-scoped Postgres transaction', async () => {
    const client = new RecordingClient()
    client.enqueue()
    client.enqueue()
    client.enqueue({ workspace_id: 'ws-a', resource_type: 'storage_inventory', resource_id: 'workspace', status: 'failed', last_idempotency_key: 'run-1', details: { runStatus: 'failed' }, observed_at: '2026-08-29T00:00:00.000Z', revision: 1, created_at: '2026-08-29T00:00:00.000Z', updated_at: '2026-08-29T00:00:00.000Z' })
    client.enqueue()
    const rows = await new PostgresReconciliationStatusRepository({ connect: async () => client } satisfies SqlPool).list({ workspaceId: 'ws-a', resourceType: 'storage_inventory' })
    expect(rows).toMatchObject([{ workspaceId: 'ws-a', status: 'failed', details: { runStatus: 'failed' } }])
    expect(client.calls).toContain('SELECT workspace_id,resource_type,resource_id,status,last_idempotency_key,details,observed_at,revision,created_at,updated_at FROM workspace_reconciliation_status WHERE workspace_id=$1 AND ($2::text IS NULL OR resource_type=$2) ORDER BY updated_at DESC, resource_type ASC, resource_id ASC LIMIT $3')
  })
})
