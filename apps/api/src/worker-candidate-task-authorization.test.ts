import { expect, it, vi } from 'vitest'
import type { IncomingMessage } from 'node:http'
import type { Task } from '../../../packages/application/src/service.js'
import { AUTHZ_POLICY_VERSION, type AuthorizationDecision } from '../../../packages/contracts/src/index.js'
import { MemoryAuthorizationRepository, type WorkspaceMember } from '../../../packages/persistence/src/index.js'
import { createWorkerAuthorizationRuntime } from './worker-authorization-runtime.js'

function fixture() {
  const task = { id: 'task_candidate', workspaceId: 'ws_candidate', candidateOnly: true } as Task
  const decision: AuthorizationDecision = { method: 'content.generate', mode: 'enforce', enforced: true, allowed: true, result: 'allow', reason_code: 'AUTHZ_ALLOWED', explicit_deny: false, obligations: { required: [], satisfied: [], missing: [] }, authorized: true, decision_id: 'decision', capability: 'customer.content.update', workbench: 'workspace', policy_version: AUTHZ_POLICY_VERSION, scope: { required: 'brand', resource_id: `task:${task.id}`, resolved: [{ type: 'workspace', ids: [task.workspaceId] }] } }
  const repository = new MemoryAuthorizationRepository()
  const hasBrandAccess = vi.fn(async () => false)
  const access = vi.fn(async () => {})
  const member = { identityId: 'identity', externalSubject: 'merchant@example.test', role: 'merchant_admin', status: 'active' } as WorkspaceMember
  const runtime = createWorkerAuthorizationRuntime({
    getDecision: () => decision, getPrincipal: () => ({ actorId: 'identity', identityId: 'identity', authorizationRevision: 0 }),
    getTrustedTask: id => id === task.id ? task : undefined, getConsumedGrant: () => undefined,
    getRequestId: () => 'request', getTraceId: () => 'trace', getAuthorizationRepository: () => repository,
    requireActiveWorkspace: access, checkCustomerDeliveryAccess: access, listMembers: async () => [member], hasBrandAccess,
  })
  const snapshot = runtime.workerAuthorizationSnapshot({} as IncomingMessage, task.workspaceId, 'job_candidate', 'generation.execute', { task_id: task.id, task_version: 1 })!
  return { task, member, runtime, snapshot, hasBrandAccess, access }
}

it('mints and rechecks a server-owned candidate task scope while retaining membership and delivery checks', async () => {
  const f = fixture()
  expect(f.snapshot.contextId).toBe(`task:${f.task.id}`)
  await expect(f.runtime.recheckWorkerAuthorizationSnapshot(f.snapshot, f.task.workspaceId, 'job_candidate')).resolves.toMatchObject({ authorized: true })
  expect(f.hasBrandAccess).not.toHaveBeenCalled()
  expect(f.access).toHaveBeenCalledTimes(2)
  f.member.status = 'suspended'
  await expect(f.runtime.recheckWorkerAuthorizationSnapshot(f.snapshot, f.task.workspaceId, 'job_candidate')).rejects.toMatchObject({ code: 'AUTHZ_EXECUTION_REVOKED' })
})

it.each(['foreign', 'missing', 'bound', 'not-candidate', 'publish', 'image'] as const)('rejects invalid candidate scope: %s', async failure => {
  const f = fixture()
  if (failure === 'foreign') f.task.workspaceId = 'other'
  if (failure === 'missing') f.snapshot.contextId = 'task:absent'
  if (failure === 'bound') f.task.brandId = 'brand_real'
  if (failure === 'not-candidate') f.task.candidateOnly = false
  const snapshot = { ...f.snapshot, capability: failure === 'publish' ? 'publish.execute' as const : failure === 'image' ? 'image_generation.execute' as const : f.snapshot.capability }
  await expect(f.runtime.recheckWorkerAuthorizationSnapshot(snapshot, 'ws_candidate', 'job_candidate')).rejects.toMatchObject({ code: 'AUTHZ_EXECUTION_REVOKED' })
  expect(f.hasBrandAccess).not.toHaveBeenCalled()
})

it('keeps legacy synthetic brand snapshots and real brand grants fail-closed', async () => {
  const f = fixture()
  for (const brandId of [`task:${f.task.id}`, 'brand_real']) {
    await expect(f.runtime.recheckWorkerAuthorizationSnapshot({ ...f.snapshot, contextId: `brand:${brandId}` }, f.task.workspaceId, 'job_candidate')).rejects.toMatchObject({ code: 'AUTHZ_EXECUTION_REVOKED' })
    if (brandId === 'brand_real') expect(f.hasBrandAccess).toHaveBeenLastCalledWith({ workspaceId: f.task.workspaceId, brandId, externalSubject: f.member.externalSubject, minimumRole: 'editor' })
    else expect(f.hasBrandAccess).not.toHaveBeenCalled()
  }
})
