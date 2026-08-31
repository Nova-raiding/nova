import { describe, expect, it } from 'vitest'
import { InMemoryOutbox, requireWorkspaceScope, TenantScopeError } from './repository.js'

describe('tenant-scoped outbox', () => {
  it('deduplicates the same aggregate event and never accepts an empty scope', () => {
    const outbox = new InMemoryOutbox()
    expect(() => requireWorkspaceScope('')).toThrowError(TenantScopeError)
    const input = { workspaceId: 'ws_1', aggregateId: 'task_1', eventType: 'task.created', sequence: 1, payload: { task: 'task_1' } }
    const first = outbox.append(input)
    const second = outbox.append(input)
    expect(second.id).toBe(first.id)
    expect(outbox.pending('ws_1')).toHaveLength(1)
    outbox.markPublished('ws_1', first.id)
    expect(outbox.pending('ws_1')).toHaveLength(0)
  })

  it('does not read or mark another workspace event in memory mode', () => {
    const outbox = new InMemoryOutbox()
    const event = outbox.append({ workspaceId: 'ws_a', aggregateId: 'a', eventType: 'task.created', sequence: 1, payload: {} })
    expect(outbox.pending('ws_b')).toEqual([])
    expect(() => outbox.markPublished('ws_b', event.id)).toThrowError(expect.objectContaining({ code: 'OUTBOX_EVENT_NOT_FOUND' }))
    expect(outbox.pending('ws_a')).toHaveLength(1)
  })

  it('pages workspace events strictly after the compound cursor', () => {
    const outbox = new InMemoryOutbox()
    outbox.append({ workspaceId: 'ws_1', aggregateId: 'a', eventType: 'knowledge.rule.created', sequence: 1, payload: {}, })
    outbox.append({ workspaceId: 'ws_1', aggregateId: 'b', eventType: 'knowledge.rule.created', sequence: 1, payload: {}, })
    outbox.append({ workspaceId: 'ws_1', aggregateId: 'c', eventType: 'knowledge.rule.created', sequence: 1, payload: {}, })
    const ordered = outbox.listWorkspaceEvents('ws_1')
    const pivot = ordered[0]!
    const page = outbox.listWorkspaceEventsAfter('ws_1', { createdAt: pivot.createdAt, eventId: pivot.id })
    expect(page.map(item => item.id)).toEqual(ordered.slice(1).map(item => item.id))
    expect(outbox.listWorkspaceEventsAfter('ws_2', undefined)).toEqual([])
  })
})
