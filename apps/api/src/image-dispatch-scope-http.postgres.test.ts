import { describe, it, expect } from 'vitest'
import { startImageSignedFixture } from '../../../tests/fixtures/image-signed-http-test-fixture.js'

describe('isolated signed image execution HTTP scope', () => {
  it('rejects tenant and execution identity tampering without changing either tenant core rows', async () => {
    const f = await startImageSignedFixture()
    try {
      const a = await f.seedJob(); const b = await f.seedJob()
      const badBudget = await f.seedJob({ badBudget: true }); const badEvent = await f.seedJob({ badEvent: true })
      const before = await f.fingerprint()
      const rejected: Array<{ name: string; code: string }> = []
      const deny = async (name: string, response: Awaited<ReturnType<typeof f.request>>, codes: string[]) => {
        expect(response.status, name).toBeGreaterThanOrEqual(400)
        expect(codes, name).toContain(response.body.error?.code)
        expect(await f.fingerprint(), name).toEqual(before)
        rejected.push({ name, code: response.body.error!.code })
      }
      for (const operation of ['begin_provider_dispatch', 'fail_before_provider']) {
        const payload = { operation, owner_token: a.execution.ownerToken, event_id: a.event.id, error_code: 'FIXTURE_ZERO_DISPATCH', error_message: 'fixture rejection' }
        await deny(`${operation}:foreign-workspace`, await f.request(a.jobId, b.workspaceId, payload), ['AUTHZ_EXECUTION_SNAPSHOT_INVALID', 'TENANT_SCOPE_DENIED', 'IMAGE_GENERATION_JOB_NOT_FOUND', 'NOT_FOUND', 'MODEL_USAGE_BUDGET_LINK_CONFLICT'])
        await deny(`${operation}:foreign-job`, await f.request(b.jobId, a.workspaceId, payload), ['AUTHZ_EXECUTION_SNAPSHOT_INVALID', 'TENANT_SCOPE_DENIED', 'IMAGE_GENERATION_JOB_NOT_FOUND', 'NOT_FOUND', 'MODEL_USAGE_BUDGET_LINK_CONFLICT'])
        await deny(`${operation}:wrong-owner`, await f.request(a.jobId, a.workspaceId, { ...payload, owner_token: b.execution.ownerToken }), ['IMAGE_GENERATION_EXECUTION_LEASE_LOST'])
        const path = `/v1/internal/image-generation-jobs/${a.jobId}/execution`
        const headers = f.signedHeaders(path, a.workspaceId, JSON.stringify(payload))
        await deny(`${operation}:invalid-signature`, await f.request(a.jobId, a.workspaceId, payload, { ...headers, 'x-worker-workspace-signature': '0'.repeat(64) }), ['FORBIDDEN'])
        await deny(`${operation}:signed-workspace-tamper`, await f.request(a.jobId, b.workspaceId, payload, { ...headers, 'x-workspace-id': b.workspaceId }), ['FORBIDDEN'])
        const wrong = { ...payload, owner_token: 'wrong-owner' }
        const once = await f.request(a.jobId, a.workspaceId, wrong)
        await deny(`${operation}:nonce-first-invalid-owner`, once, ['IMAGE_GENERATION_EXECUTION_LEASE_LOST'])
        await deny(`${operation}:nonce-replay`, await f.request(a.jobId, a.workspaceId, wrong, once.headers), ['WORKER_NONCE_REPLAY'])
        await deny(`${operation}:foreign-budget-link`, await f.request(badBudget.jobId, badBudget.workspaceId, { ...payload, owner_token: badBudget.execution.ownerToken, event_id: badBudget.event.id }), ['MODEL_USAGE_BUDGET_LINK_CONFLICT'])
      }
      await deny('cleanup:foreign-event', await f.request(a.jobId, a.workspaceId, { operation: 'fail_before_provider', owner_token: a.execution.ownerToken, event_id: b.event.id, error_code: 'FIXTURE_ZERO_DISPATCH', error_message: 'fixture rejection' }), ['MODEL_USAGE_BUDGET_LINK_CONFLICT'])
      await deny('begin:unbound-durable-event', await f.request(badEvent.jobId, badEvent.workspaceId, { operation: 'begin_provider_dispatch', owner_token: badEvent.execution.ownerToken }), ['AUTHZ_EXECUTION_SNAPSHOT_INVALID'])
      // Positive control traverses the same signed HTTP boundary, real execution
      // CAS and production budget release. It does not settle points or ACK an
      // outbox; those are separate worker lifecycle responsibilities.
      const closed = await f.request(a.jobId, a.workspaceId, { operation: 'fail_before_provider', owner_token: a.execution.ownerToken, event_id: a.event.id, error_code: 'FIXTURE_ZERO_DISPATCH', error_message: 'fixture rejection' })
      expect(closed.status).toBe(200)
      expect((await f.persistence.imageGenerationExecutions!.get({ workspaceId: a.workspaceId, jobId: a.jobId }))?.state).toBe('failed')
      expect((await f.admin.query('SELECT status FROM model_cost_budget_reservations WHERE workspace_id=$1 AND reservation_key=$2', [a.workspaceId, a.action])).rows).toEqual([{ status: 'released' }])
      const after = await f.fingerprint()
      expect(after.creative_point_reservations).toBe(before.creative_point_reservations)
      expect(after.creative_point_operations).toBe(before.creative_point_operations)
      expect(after.outbox_events).toBe(before.outbox_events)
      expect(rejected).toHaveLength(18)
    } finally { await f.close() }
  }, 180_000)
})
