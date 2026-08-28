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
    expect(outbox.pending()).toHaveLength(1)
    outbox.markPublished(first.id)
    expect(outbox.pending()).toHaveLength(0)
  })
})
