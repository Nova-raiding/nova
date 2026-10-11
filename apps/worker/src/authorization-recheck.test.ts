import { describe, expect, it, vi } from 'vitest'
import { createOutboxHandler } from './handler.js'
import type { DurableOutboxEvent } from '../../../packages/workers/src/durable.js'
import type { WorkerExecutionAuthorizationGuard } from '../../../packages/workers/src/execution-authorization.js'
import type { CriticalWorkerOperation } from '../../../packages/workers/src/execution-authorization.js'
import type { WorkerCommercialAccessGuard } from '../../../packages/workers/src/commercial-access.js'

describe('worker execution authorization boundary', () => {
  it.each([
    { eventType: 'publish.requested' as const, operation: 'publish.execute' as const },
    { eventType: 'publish.reconcile_requested' as const, operation: 'publish.reconcile' as const },
  ])('does not invoke $operation after authoritative revocation', async ({ eventType, operation }) => {
    const connector = vi.fn()
    const assertAuthorized = vi.fn(async (_event: DurableOutboxEvent, _operation: CriticalWorkerOperation) => { throw Object.assign(new Error('grant revoked'), { code: 'AUTHZ_EXECUTION_REVOKED', retryable: false, unknown: false }) })
    const executionAuthorization: WorkerExecutionAuthorizationGuard = { assertAuthorized }
    const commercialAccess: WorkerCommercialAccessGuard = { assertCommercialAccess: vi.fn() }
    const handler = createOutboxHandler({
      ...(operation === 'publish.execute' ? { publishRequested: connector } : { reconcileRequested: connector }),
      executionAuthorization,
      commercialAccess,
    })
    const event: DurableOutboxEvent = {
      id: `evt_authz_revoked_${operation}`, workspaceId: 'ws_a', aggregateId: 'job_authz_revoked', eventType, sequence: 1,
      payload: { authorization_snapshot: { schema_version: 1, decision_id: 'decision_revoked', actor_id: 'merchant_1', identity_id: 'identity_1', workspace_id: 'ws_a', workbench: 'workspace', context_id: 'workspace:ws_a', context_version: 'ctx_1', policy_version: 'policy_1', grant_revision: 'grant:g:1:identity:1', grant_ids: [], scope_hash: 'a'.repeat(64), capability: operation, resource_id: 'job_authz_revoked', resource_revision: 'resource_1', request_id: 'request_1', trace_id: 'trace_1', authorized: true, decided_at: new Date().toISOString() } },
      createdAt: new Date().toISOString(),
    }
    await expect(handler({ event, attempt: 1, now: Date.now() })).rejects.toMatchObject({
      error: {
        code: 'AUTHZ_EXECUTION_REVOKED', retryable: false, unknown: false,
        decisionId: 'decision_revoked', eventId: event.id, workspaceId: 'ws_a', traceId: 'trace_1',
      },
    })
    expect(executionAuthorization.assertAuthorized).toHaveBeenCalledOnce()
    expect(assertAuthorized.mock.calls[0]?.[1]).toBe(operation)
    expect(commercialAccess.assertCommercialAccess).not.toHaveBeenCalled()
    expect(connector).not.toHaveBeenCalled()
  })
})
