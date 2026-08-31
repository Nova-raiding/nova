import { describe, expect, it } from 'vitest'
import { MemoryKnowledgeHydrationRepository } from './knowledge-hydration-repository.js'

const event = (workspaceId: string, id: string, createdAt = '2026-08-29T00:00:00.000Z') => ({ id, workspaceId, aggregateId: id, sequence: 1, eventType: 'knowledge.rule.created', payload: { workspaceId, id }, createdAt })

describe('knowledge hydration repository', () => {
  it('round-trips a workspace snapshot without sharing mutable event data', async () => {
    const repository = new MemoryKnowledgeHydrationRepository()
    const saved = await repository.save({ workspaceId: 'ws_a', cursorCreatedAt: '2026-08-29T00:00:00.000Z', cursorEventId: 'evt_1', events: [event('ws_a', 'evt_1')] })
    saved.events[0]!.payload.id = 'mutated'
    const loaded = await repository.load('ws_a')
    expect(loaded?.events[0]?.payload.id).toBe('evt_1')
    expect(await repository.load('ws_b')).toBeUndefined()
  })

  it('rejects an event from another workspace', async () => {
    const repository = new MemoryKnowledgeHydrationRepository()
    await expect(repository.save({ workspaceId: 'ws_a', cursorCreatedAt: '2026-08-29T00:00:00.000Z', cursorEventId: 'evt_1', events: [event('ws_b', 'evt_1')] })).rejects.toThrow('KNOWLEDGE_SNAPSHOT_EVENT_INVALID')
  })

  it('requires the current revision for concurrent snapshot updates', async () => {
    const repository = new MemoryKnowledgeHydrationRepository()
    const first = await repository.save({ workspaceId: 'ws_a', cursorCreatedAt: '2026-08-29T00:00:00.000Z', cursorEventId: 'evt_1', events: [event('ws_a', 'evt_1')] })
    const second = await repository.save({ workspaceId: 'ws_a', cursorCreatedAt: '2026-08-29T00:01:00.000Z', cursorEventId: 'evt_2', events: [event('ws_a', 'evt_2')], expectedRevision: first.revision, expectedCursor: { createdAt: first.cursorCreatedAt, eventId: first.cursorEventId } })
    expect(second.revision).toBe(first.revision + 1)
    await expect(repository.save({ workspaceId: 'ws_a', cursorCreatedAt: '2026-08-29T00:02:00.000Z', cursorEventId: 'evt_3', events: [event('ws_a', 'evt_3')], expectedRevision: first.revision, expectedCursor: { createdAt: first.cursorCreatedAt, eventId: first.cursorEventId } })).rejects.toThrow('KNOWLEDGE_SNAPSHOT_CONFLICT')
  })
})
