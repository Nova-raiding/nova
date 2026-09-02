import { describe, expect, it, vi } from 'vitest'
import { createOutboxHandler } from './handler.js'
import type { DurableOutboxEvent } from '../../../packages/workers/src/durable.js'
import type { WorkerExecutionAuthorizationGuard } from '../../../packages/workers/src/execution-authorization.js'
import { createCommercialAccessGuard, parseWorkerCommercialAccessSnapshot, type WorkerCommercialAccessGuard } from '../../../packages/workers/src/commercial-access.js'

function event(eventType = 'generation.requested', operation = 'generation.execute'): DurableOutboxEvent {
  return {
    id: `evt_${eventType}`, workspaceId: 'ws_a', aggregateId: 'job_1', eventType, sequence: 1, createdAt: new Date().toISOString(),
    payload: {
      authorization_snapshot: { schema_version: 1, decision_id: 'auth_enqueue', actor_id: 'merchant_1', identity_id: 'identity_1', workspace_id: 'ws_a', workbench: 'workspace', context_id: 'workspace:ws_a', context_version: 'ctx_1', policy_version: 'policy_1', grant_revision: 'grant_1', grant_ids: [], scope_hash: 'a'.repeat(64), capability: operation, resource_id: 'job_1', resource_revision: '1', request_id: 'request_1', trace_id: 'trace_1', authorized: true, decided_at: new Date().toISOString() },
      commercial_access_snapshot: { schema_version: 1, decision_id: 'commercial_enqueue', workspace_id: 'ws_a', operation, access_mode: 'POINT_CHARGED', access_revision: 'access_1', balance_state: 'known', entitlement_snapshot_id: 'entitlement_1', entitlement_snapshot_checksum: 'b'.repeat(64), rate_version: 'rate_1', quoted_points: 1, reservation_id: 'reservation_1', decided_at: new Date().toISOString() },
    },
  }
}

describe('worker commercial recheck ordering', () => {
  it('runs authorization, then commercial recheck, then the provider', async () => {
    const order: string[] = []
    const executionAuthorization = { assertAuthorized: vi.fn(async () => { order.push('authorization'); return {} as never }) } satisfies WorkerExecutionAuthorizationGuard
    const commercialAccess = { assertCommercialAccess: vi.fn(async () => { order.push('commercial'); return {} as never }) } satisfies WorkerCommercialAccessGuard
    const provider = vi.fn(async () => { order.push('provider'); return { body: 'ok' } as never })
    const handler = createOutboxHandler({ executionAuthorization, commercialAccess, generationRequested: provider })
    await handler({ event: event(), attempt: 1, now: Date.now() })
    expect(order).toEqual(['authorization', 'commercial', 'provider'])
  })

  it('does not call the provider when commercial readiness is stale or unavailable', async () => {
    const executionAuthorization = { assertAuthorized: vi.fn(async () => ({} as never)) } satisfies WorkerExecutionAuthorizationGuard
    const commercialAccess = { assertCommercialAccess: vi.fn(async () => { throw Object.assign(new Error('access revision stale'), { code: 'COMMERCIAL_EXECUTION_REVISION_STALE', retryable: false, unknown: false }) }) } satisfies WorkerCommercialAccessGuard
    const provider = vi.fn()
    const handler = createOutboxHandler({ executionAuthorization, commercialAccess, generationRequested: provider })
    await expect(handler({ event: event(), attempt: 1, now: Date.now() })).rejects.toMatchObject({ error: { code: 'COMMERCIAL_EXECUTION_REVISION_STALE', retryable: false, unknown: false, decisionId: 'commercial_enqueue', accessRevision: 'access_1', reservationId: 'reservation_1', entitlementSnapshotId: 'entitlement_1', entitlementSnapshotChecksum: 'b'.repeat(64), rateVersion: 'rate_1' } })
    expect(provider).not.toHaveBeenCalled()
  })

  it.each([
    ['revision', { accessRevision: 'access_2' }, 'COMMERCIAL_EXECUTION_REVISION_STALE'],
    ['entitlement', { entitlementSnapshotChecksum: 'c'.repeat(64) }, 'COMMERCIAL_EXECUTION_ENTITLEMENT_STALE'],
    ['rate', { rateVersion: 'rate_2' }, 'COMMERCIAL_EXECUTION_RATE_STALE'],
    ['reservation', { reservationState: 'consumed' as const }, 'COMMERCIAL_EXECUTION_RESERVATION_INVALID'],
    ['readiness', { ready: false }, 'COMMERCIAL_EXECUTION_NOT_READY'],
  ])('blocks %s drift before the provider boundary', async (_case, override, code) => {
    const durableEvent = event()
    const snapshot = parseWorkerCommercialAccessSnapshot(durableEvent, 'generation.execute')
    const executionAuthorization = { assertAuthorized: vi.fn(async () => ({} as never)) } satisfies WorkerExecutionAuthorizationGuard
    const commercialAccess = createCommercialAccessGuard(async () => ({
      recheckId: 'commercial_recheck',
      workspaceId: snapshot.workspaceId,
      operation: snapshot.operation,
      accessMode: snapshot.accessMode,
      accessRevision: snapshot.accessRevision,
      balanceState: snapshot.balanceState,
      entitlementSnapshotId: snapshot.entitlementSnapshotId,
      entitlementSnapshotChecksum: snapshot.entitlementSnapshotChecksum,
      rateVersion: snapshot.rateVersion,
      quotedPoints: snapshot.quotedPoints,
      reservationId: snapshot.reservationId,
      reservationState: 'active',
      allowed: true,
      ready: true,
      checkedAt: new Date().toISOString(),
      ...override,
    }))
    const provider = vi.fn()
    const handler = createOutboxHandler({ executionAuthorization, commercialAccess, generationRequested: provider })

    await expect(handler({ event: durableEvent, attempt: 1, now: Date.now() }))
      .rejects.toMatchObject({ error: { code } })
    expect(provider).not.toHaveBeenCalled()
  })

  it('records an accepted provider result once and will not initiate a second call after reservation consumption', async () => {
    const executionAuthorization = { assertAuthorized: vi.fn(async () => ({} as never)) } satisfies WorkerExecutionAuthorizationGuard
    let consumed = false
    const commercialAccess = {
      assertCommercialAccess: vi.fn(async () => {
        if (consumed) throw Object.assign(new Error('reservation consumed'), { code: 'COMMERCIAL_EXECUTION_RESERVATION_INVALID', retryable: false, unknown: false })
        return {} as never
      }),
    } satisfies WorkerCommercialAccessGuard
    const provider = vi.fn(async () => { consumed = true; return { body: 'accepted' } as never })
    const completion = vi.fn(async () => undefined)
    const handler = createOutboxHandler({ executionAuthorization, commercialAccess, generationRequested: provider, onGenerationResult: completion })
    const durableEvent = event()
    await expect(handler({ event: durableEvent, attempt: 1, now: Date.now() })).resolves.toBeDefined()
    await expect(handler({ event: durableEvent, attempt: 2, now: Date.now() })).rejects.toMatchObject({ error: { code: 'COMMERCIAL_EXECUTION_RESERVATION_INVALID' } })
    expect(provider).toHaveBeenCalledOnce()
    expect(completion).toHaveBeenCalledOnce()
  })

  it('commercial-gates initial asset scans without imposing actor authorization on system delivery', async () => {
    const executionAuthorization = { assertAuthorized: vi.fn() } satisfies WorkerExecutionAuthorizationGuard
    const commercialAccess = { assertCommercialAccess: vi.fn(async () => ({} as never)) } satisfies WorkerCommercialAccessGuard
    const scan = vi.fn(async () => ({ verdict: 'clean' }))
    const handler = createOutboxHandler({ executionAuthorization, commercialAccess, scanRequested: scan })
    const scanEvent = event('asset.uploaded', 'asset.scan.execute')
    await handler({ event: { ...scanEvent, payload: { commercial_access_snapshot: scanEvent.payload.commercial_access_snapshot } }, attempt: 1, now: Date.now() })
    expect(executionAuthorization.assertAuthorized).not.toHaveBeenCalled()
    expect(commercialAccess.assertCommercialAccess).toHaveBeenCalledOnce()
    expect(scan).toHaveBeenCalledOnce()
  })

  it('does not commercial-gate pure system projection events', async () => {
    const commercialAccess = { assertCommercialAccess: vi.fn() } satisfies WorkerCommercialAccessGuard
    const handler = createOutboxHandler({ commercialAccess })
    await handler({ event: { id: 'evt_snapshot', workspaceId: 'ws_a', aggregateId: 'task_1', eventType: 'state.snapshot', sequence: 1, createdAt: new Date().toISOString(), payload: { entityType: 'task', entity: { id: 'task_1', workspaceId: 'ws_a' } } }, attempt: 1, now: Date.now() })
    expect(commercialAccess.assertCommercialAccess).not.toHaveBeenCalled()
  })

  it('does not turn entitlement drift into an automatic retry or dead-letter replay', async () => {
    const executionAuthorization = { assertAuthorized: vi.fn(async () => ({} as never)) } satisfies WorkerExecutionAuthorizationGuard
    const commercialAccess = {
      assertCommercialAccess: vi.fn(async () => {
        throw Object.assign(new Error('entitlement snapshot changed'), {
          code: 'COMMERCIAL_EXECUTION_ENTITLEMENT_STALE', retryable: true, unknown: false,
        })
      }),
    } satisfies WorkerCommercialAccessGuard
    const provider = vi.fn()
    const handler = createOutboxHandler({ executionAuthorization, commercialAccess, generationRequested: provider })
    await expect(handler({ event: event(), attempt: 1, now: Date.now() })).rejects.toMatchObject({
      error: { code: 'COMMERCIAL_EXECUTION_ENTITLEMENT_STALE', retryable: false, unknown: false, decisionId: 'commercial_enqueue', eventId: 'evt_generation.requested', workspaceId: 'ws_a' },
    })
    expect(provider).not.toHaveBeenCalled()
  })
})
