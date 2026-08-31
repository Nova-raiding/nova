import { describe, expect, it, vi } from 'vitest'
import type { DurableOutboxEvent } from './durable.js'
import { createExecutionAuthorizationGuard, createReservedExecutionGate, type WorkerAuthorizationRecheck } from './execution-authorization.js'

const checkedAt = '2026-08-31T09:59:59.000Z'
const baseRecheck: WorkerAuthorizationRecheck = {
  recheckId: 'recheck-1', actorId: 'merchant-1', identityId: 'identity-1', workspaceId: 'ws-a', workbench: 'workspace', contextId: 'workspace:ws-a',
  contextVersion: 'ctx-2', policyVersion: 'policy-2', grantRevision: 'grant-2', grantIds: [], scopeHash: 'a'.repeat(64),
  capability: 'publish.execute', resourceId: 'job-1', resourceRevision: '1', requestId: 'req-1', traceId: 'trace-1', authorized: true, checkedAt,
}
const event = (): DurableOutboxEvent => ({
  id: 'event-1', workspaceId: 'ws-a', aggregateId: 'job-1', eventType: 'publish.requested', sequence: 1, createdAt: checkedAt,
  payload: { authorization_snapshot: {
    schema_version: 1, decision_id: 'decision-1', actor_id: 'merchant-1', identity_id: 'identity-1', workspace_id: 'ws-a', workbench: 'workspace', context_id: 'workspace:ws-a',
    context_version: 'ctx-1', policy_version: 'policy-1', grant_revision: 'grant-1', grant_ids: [], scope_hash: 'a'.repeat(64),
    capability: 'publish.execute', resource_id: 'job-1', resource_revision: '1', request_id: 'req-1', trace_id: 'trace-1', authorized: true, decided_at: checkedAt,
  } },
})

function gate(reserve: Parameters<typeof createReservedExecutionGate>[1]) {
  const guard = createExecutionAuthorizationGuard(async () => baseRecheck, { now: () => Date.parse('2026-08-31T10:00:00.000Z') })
  return createReservedExecutionGate(guard, reserve)
}

describe('worker execution reservation boundary', () => {
  it('reserves before the caller is allowed to create an external side effect', async () => {
    const order: string[] = []
    const reserve = vi.fn(async ({ reservationId, event: inputEvent, operation }: Parameters<Parameters<typeof createReservedExecutionGate>[1]>[0]) => {
      order.push('reserve')
      return { reservationId, eventId: inputEvent.id, workspaceId: inputEvent.workspaceId, operation, reservedAt: checkedAt }
    })
    const execute = vi.fn(() => order.push('effect'))
    await gate(reserve)(event(), 'publish.execute')
    execute()
    expect(order).toEqual(['reserve', 'effect'])
    expect(reserve).toHaveBeenCalledWith(expect.objectContaining({ reservationId: 'worker-execution:publish.execute:event-1', event: expect.objectContaining({ id: 'event-1' }) }))
  })

  it('does not allow an effect when reservation is denied', async () => {
    const reserve = vi.fn(async () => undefined)
    const effect = vi.fn()
    await expect(gate(reserve)(event(), 'publish.execute')).rejects.toMatchObject({ code: 'AUTHZ_EXECUTION_RESERVATION_CONFLICT', retryable: false })
    expect(reserve).toHaveBeenCalledOnce()
    expect(effect).not.toHaveBeenCalled()
  })

  it('preserves unavailable/revoked fail-closed behavior before reservation', async () => {
    const reserve = vi.fn()
    const revokedGuard = { assertAuthorized: vi.fn(async () => { throw new Error('revoked') }) }
    const effect = vi.fn()
    await expect(createReservedExecutionGate(revokedGuard, reserve)(event(), 'publish.execute')).rejects.toThrow('revoked')
    expect(reserve).not.toHaveBeenCalled()
    expect(effect).not.toHaveBeenCalled()
  })

  it('uses the same reservation key for replay and never hides a reservation outage', async () => {
    const keys: string[] = []
    const reserve = vi.fn(async ({ reservationId, event: inputEvent, operation }: Parameters<Parameters<typeof createReservedExecutionGate>[1]>[0]) => {
      keys.push(reservationId)
      return { reservationId, eventId: inputEvent.id, workspaceId: inputEvent.workspaceId, operation, reservedAt: checkedAt }
    })
    const run = gate(reserve)
    await run(event(), 'publish.execute')
    await run(event(), 'publish.execute')
    expect(keys).toEqual(['worker-execution:publish.execute:event-1', 'worker-execution:publish.execute:event-1'])

    const unavailable = vi.fn(async () => { throw new Error('database unavailable') })
    await expect(gate(unavailable)(event(), 'publish.execute')).rejects.toMatchObject({ code: 'AUTHZ_EXECUTION_RESERVATION_UNAVAILABLE', retryable: true })
  })

  it('rejects a reservation bound to another workspace or event', async () => {
    const reserve = vi.fn(async () => ({ reservationId: 'worker-execution:publish.execute:event-1', eventId: 'event-2', workspaceId: 'ws-b', operation: 'publish.execute' as const, reservedAt: checkedAt }))
    await expect(gate(reserve)(event(), 'publish.execute')).rejects.toMatchObject({ code: 'AUTHZ_EXECUTION_RESERVATION_INVALID', retryable: false })
  })
})
