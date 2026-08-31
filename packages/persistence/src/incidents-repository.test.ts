import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { IncidentRepositoryError, MemoryIncidentRepository } from './incidents-repository.js'

const create = (repository: MemoryIncidentRepository, workspaceId = 'ws_1', idempotencyKey = 'incident:create:1') => repository.create({ workspaceId, actorId: 'ops_1', title: 'Checkout unavailable', summary: 'Payment requests are failing', severity: 'sev1', affectedComponents: ['api'], affectedWorkspaceIds: [workspaceId], idempotencyKey, requestHash: `a`.repeat(64) })

describe('incident repository', () => {
  it('isolates tenants and paginates on a stable compound cursor', async () => {
    const repository = new MemoryIncidentRepository()
    await create(repository, 'ws_1', 'incident:create:1')
    await create(repository, 'ws_1', 'incident:create:2')
    await create(repository, 'ws_2', 'incident:create:3')
    const first = await repository.list({ workspaceId: 'ws_1', limit: 1 })
    const second = await repository.list({ workspaceId: 'ws_1', limit: 1, cursor: first.nextCursor })
    expect(first.items).toHaveLength(1)
    expect(second.items).toHaveLength(1)
    expect(second.items[0]?.id).not.toBe(first.items[0]?.id)
    expect((await repository.list({ workspaceId: 'ws_2', limit: 10 })).items).toHaveLength(1)
    await expect(repository.get('ws_2', first.items[0]!.id)).resolves.toBeUndefined()
  })

  it('replays identical mutations but rejects key reuse and stale revisions', async () => {
    const repository = new MemoryIncidentRepository()
    const created = await create(repository)
    const input = { workspaceId: 'ws_1', incidentId: created.incident.id, actorId: 'ops_1', expectedRevision: 1, operation: 'transition' as const, idempotencyKey: 'incident:transition:1', requestHash: `b`.repeat(64), event: { kind: 'status_changed' as const, body: 'Root cause found', fromStatus: 'investigating' as const, toStatus: 'identified' as const }, patch: { status: 'identified' as const } }
    const first = await repository.mutate(input)
    await expect(repository.mutate(input)).resolves.toEqual(first)
    await expect(repository.mutate({ ...input, requestHash: `c`.repeat(64) })).rejects.toMatchObject({ code: 'INCIDENT_IDEMPOTENCY_CONFLICT' })
    await expect(repository.mutate({ ...input, idempotencyKey: 'incident:transition:2', requestHash: `d`.repeat(64) })).rejects.toMatchObject({ code: 'INCIDENT_REVISION_CONFLICT' })
  })

  it('keeps timeline append-only in order', async () => {
    const repository = new MemoryIncidentRepository()
    const created = await create(repository)
    await repository.mutate({ workspaceId: 'ws_1', incidentId: created.incident.id, actorId: 'support_1', expectedRevision: 1, operation: 'comment', idempotencyKey: 'incident:comment:1', requestHash: `b`.repeat(64), event: { kind: 'comment', body: 'Customer impact confirmed' } })
    const timeline = await repository.listTimeline({ workspaceId: 'ws_1', incidentId: created.incident.id, limit: 10 })
    expect(timeline.items.map((entry) => entry.kind)).toEqual(['created', 'comment'])
    expect(timeline.items.map((entry) => entry.incidentRevision)).toEqual([1, 2])
  })

  it('rejects malformed cursors', async () => {
    const repository = new MemoryIncidentRepository()
    await expect(repository.list({ workspaceId: 'ws_1', limit: 10, cursor: 'not-a-cursor' })).rejects.toBeInstanceOf(IncidentRepositoryError)
    const forged = Buffer.from(JSON.stringify({ at: '2026-01-01T00:00:00.000Z', id: 'not-a-uuid' })).toString('base64url')
    await expect(repository.list({ workspaceId: 'ws_1', limit: 10, cursor: forged })).rejects.toMatchObject({ code: 'INCIDENT_INVALID_CURSOR' })
  })

  it('defends repository entry points with bounded limits', async () => {
    const repository = new MemoryIncidentRepository()
    const created = await create(repository)
    await expect(repository.list({ workspaceId: 'ws_1', limit: 101 })).rejects.toMatchObject({ code: 'INCIDENT_INVALID_LIMIT' })
    await expect(repository.listTimeline({ workspaceId: 'ws_1', incidentId: created.incident.id, limit: 201 })).rejects.toMatchObject({ code: 'INCIDENT_INVALID_LIMIT' })
  })

  it('defines forced RLS and immutable event/idempotency history', async () => {
    const sql = await readFile(new URL('./migrations/056_incidents.sql', import.meta.url), 'utf8')
    expect(sql).toContain('ALTER TABLE ops_incidents FORCE ROW LEVEL SECURITY')
    expect(sql).toContain('ALTER TABLE ops_incident_timeline FORCE ROW LEVEL SECURITY')
    expect(sql).toContain('ops_incident_timeline_immutable')
    expect(sql).toContain('ops_incident_idempotency_immutable')
    expect(sql).toContain('FOREIGN KEY (workspace_id, incident_id)')
  })
})
