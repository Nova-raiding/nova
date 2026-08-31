import { describe, expect, it, vi } from 'vitest'
import { createOutboxHandler } from './handler.js'
import type { DurableOutboxEvent } from '../../../packages/workers/src/durable.js'
import type { WorkerExecutionAuthorizationGuard } from '../../../packages/workers/src/execution-authorization.js'

describe('worker execution authorization boundary', () => {
  it('does not invoke a critical side effect after authoritative revocation', async () => {
    const connector = vi.fn()
    const executionAuthorization: WorkerExecutionAuthorizationGuard = {
      assertAuthorized: vi.fn(async () => { throw Object.assign(new Error('grant revoked'), { code: 'AUTHZ_EXECUTION_REVOKED', retryable: false, unknown: false }) }),
    }
    const handler = createOutboxHandler({ publishRequested: connector, executionAuthorization })
    const event: DurableOutboxEvent = {
      id: 'evt_authz_revoked', workspaceId: 'ws_a', aggregateId: 'job_authz_revoked', eventType: 'publish.requested', sequence: 1,
      payload: { authorization_snapshot: { schema_version: 1, decision_id: 'decision_revoked', actor_id: 'merchant_1', workspace_id: 'ws_a', context_id: 'workspace:ws_a', context_version: 'ctx_1', policy_version: 'policy_1', grant_revision: 'grant:g:1:identity:1', scope_hash: 'a'.repeat(64), capability: 'publish.execute', resource_id: 'job_authz_revoked', authorized: true, decided_at: new Date().toISOString() } },
      createdAt: new Date().toISOString(),
    }
    await expect(handler({ event, attempt: 1, now: Date.now() })).rejects.toMatchObject({ code: 'AUTHZ_EXECUTION_REVOKED', retryable: false, unknown: false })
    expect(executionAuthorization.assertAuthorized).toHaveBeenCalledOnce()
    expect(connector).not.toHaveBeenCalled()
  })
})
