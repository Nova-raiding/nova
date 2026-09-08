import { afterAll, describe, expect, it, vi } from 'vitest'
import { createHash, randomUUID } from 'node:crypto'
import { persistenceReady, recheckWorkerAuthorizationSnapshot, server, service, setAuthorizationRepositoryForTests } from './server.js'
import { MemoryAuthorizationRepository, MemoryCreativePointRepository } from '../../../packages/persistence/src/index.js'
import { InMemoryOutbox, type OutboxRepository } from '../../../packages/persistence/src/repository.js'
import { createWorkerRequestProof } from '../../../packages/security/src/worker-request-proof.js'
import type { WorkerAuthorizationSnapshot } from '../../../packages/workers/src/execution-authorization.js'
import { buildCanonicalExecutionBinding } from '../../../packages/application/src/canonical-execution-binding.js'
import type { PublishJob, Task } from '../../../packages/application/src/service.js'

// The composition root reads these at import time. Keep this suite offline
// even when the invoking shell has a development DB/Redis configuration.
const previousRuntimeEnvironment = vi.hoisted(() => {
  const previous = { NODE_ENV: process.env.NODE_ENV, REDIS_URL: process.env.REDIS_URL }
  process.env.NODE_ENV = 'test'
  delete process.env.REDIS_URL
  return previous
})
afterAll(() => {
  for (const [key, value] of Object.entries(previousRuntimeEnvironment)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

describe('worker authorization recheck API', () => {
  it('E1: reserves a consumed workspace grant for the actual job ID, not the workspace ID', async () => {
    const repository = new MemoryAuthorizationRepository()
    const workspaceId = 'ws_authz_workspace_scope'
    const resourceId = 'job_authz_workspace_scope'
    const identityId = 'identity_authz_workspace_scope'
    const now = new Date()
    const issued = await repository.issueGrant({
      grantKind: 'temporary', accessMode: 'write', subjectIdentityId: identityId, workspaceId,
      capabilities: ['customer.content.update'], resourceScope: { workspace_ids: [workspaceId] },
      reason: 'execute approved workspace job', ticketRef: 'AUTHZ-WORKSPACE-1', issuedBy: 'operator_a', approvedBy: 'security_a',
      approvedAt: now.toISOString(), expectedAuthorizationRevision: 0,
      expiresAt: new Date(now.getTime() + 60_000).toISOString(), maxUses: 1,
    })
    const grant = await repository.consumeGrant({ id: issued.id, subjectIdentityId: identityId, workspaceId, capability: 'customer.content.update', scopeHash: issued.scopeHash, expectedRevision: issued.revision, actorId: 'operator_a', reason: 'admit approved job to outbox' })
    if (!grant) throw new Error('workspace grant fixture was not consumed')
    const reserve = vi.spyOn(repository, 'reserveExecution')
    setAuthorizationRepositoryForTests(repository)
    try {
      await expect(recheckWorkerAuthorizationSnapshot({
        schemaVersion: 1, decisionId: 'decision_workspace_job', actorId: 'operator_a', identityId, workspaceId,
        workbench: 'workspace', contextId: `workspace:${workspaceId}`, contextVersion: 'policy_context', policyVersion: 'policy_1',
        grantRevision: `grant:${grant.id}:${grant.revision}:${identityId}:${grant.authorizationRevision}`, grantIds: [grant.id], scopeHash: grant.scopeHash,
        capability: 'generation.execute', resourceId, authorized: true, decidedAt: now.toISOString(),
      }, workspaceId, resourceId, { eventId: 'evt_workspace_job' })).resolves.toMatchObject({ authorized: true, resource_id: resourceId, reservation_id: 'worker-execution:evt_workspace_job:generation.execute' })
      expect(reserve).toHaveBeenCalledWith(expect.objectContaining({ workspaceId, resourceId, eventId: 'evt_workspace_job' }))
      await expect(reserve.mock.results[0]!.value).resolves.toMatchObject({ workspaceId, resourceId, eventId: 'evt_workspace_job' })
      expect(resourceId).not.toBe(workspaceId)
    } finally {
      reserve.mockRestore()
      setAuthorizationRepositoryForTests()
    }
  })

  it('rejects an exhausted grant from the authoritative Memory repository', async () => {
    const repository = new MemoryAuthorizationRepository()
    const now = new Date()
    const grant = await repository.issueGrant({
      grantKind: 'temporary', accessMode: 'write', subjectIdentityId: 'identity_authz_api', workspaceId: 'ws_authz_api',
      capabilities: ['customer.content.update'], resourceScope: { task_ids: ['task_authz_api'] },
      reason: 'execute approved task', ticketRef: 'AUTHZ-API-1', issuedBy: 'operator_a', approvedBy: 'security_a',
      approvedAt: now.toISOString(), expectedAuthorizationRevision: 0,
      expiresAt: new Date(now.getTime() + 60_000).toISOString(), maxUses: 1,
    })
    const snapshot = (revision: number, authorizationRevision: number) => ({
      schemaVersion: 1 as const, decisionId: `decision_${revision}`, actorId: 'operator_a', workspaceId: 'ws_authz_api',
      identityId: 'identity_authz_api',
      contextId: 'workspace:ws_authz_api', contextVersion: 'policy_context', policyVersion: 'policy_1',
      grantRevision: `grant:${grant.id}:${revision}:identity_authz_api:${authorizationRevision}`, scopeHash: grant.scopeHash,
      grantIds: [grant.id],
      capability: 'generation.execute' as const, resourceId: 'task_authz_api', authorized: true as const, decidedAt: now.toISOString(),
    })

    setAuthorizationRepositoryForTests(repository)
    try {
      await expect(recheckWorkerAuthorizationSnapshot(snapshot(1, 1), 'ws_authz_api', 'task_authz_api')).resolves.toMatchObject({ authorized: true })
      const consumed = await repository.consumeGrant({ id: grant.id, subjectIdentityId: 'identity_authz_api', workspaceId: 'ws_authz_api', capability: 'customer.content.update', scopeHash: grant.scopeHash, expectedRevision: 1, actorId: 'operator_a', reason: 'execute approved task' })
      expect(consumed).toMatchObject({ revision: 2, authorizationRevision: 2, useCount: 1, maxUses: 1 })
      const reserved = await recheckWorkerAuthorizationSnapshot(snapshot(2, 2), 'ws_authz_api', 'task_authz_api', { eventId: 'evt_authz_api' })
      expect(reserved).toMatchObject({ authorized: true, reservation_id: 'worker-execution:evt_authz_api:generation.execute', event_id: 'evt_authz_api' })
      await expect(recheckWorkerAuthorizationSnapshot(snapshot(2, 2), 'ws_authz_api', 'task_authz_api', { eventId: 'evt_authz_api' })).resolves.toMatchObject({ reservation_id: (reserved as { reservation_id: string }).reservation_id })
      await expect(recheckWorkerAuthorizationSnapshot({ ...snapshot(2, 2), decisionId: 'decision_conflict' }, 'ws_authz_api', 'task_authz_api', { eventId: 'evt_authz_api' })).rejects.toMatchObject({ code: 'AUTHZ_EXECUTION_SNAPSHOT_INVALID', details: { event_id: 'evt_authz_api', reservation_id: 'worker-execution:evt_authz_api:generation.execute' } })
      await expect(recheckWorkerAuthorizationSnapshot({ ...snapshot(2, 2), grantIds: ['forged-grant'] }, 'ws_authz_api', 'task_authz_api')).rejects.toMatchObject({ code: 'AUTHZ_EXECUTION_REVOKED' })
      await repository.revokeGrant({
        id: grant.id,
        subjectIdentityId: 'identity_authz_api',
        actorId: 'operator_a',
        reason: '撤销已入队的临时授权',
        expectedRevision: 2,
        expectedAuthorizationRevision: 2,
      })
      await expect(recheckWorkerAuthorizationSnapshot(snapshot(2, 2), 'ws_authz_api', 'task_authz_api')).rejects.toMatchObject({ code: 'AUTHZ_EXECUTION_REVOKED' })
      await expect(recheckWorkerAuthorizationSnapshot({ ...snapshot(2, 2), identityId: 'other-identity' }, 'ws_authz_api', 'task_authz_api')).rejects.toMatchObject({ code: 'AUTHZ_EXECUTION_SNAPSHOT_INVALID' })
      await expect(recheckWorkerAuthorizationSnapshot(snapshot(2, 2), 'ws-other', 'task_authz_api')).rejects.toMatchObject({ code: 'AUTHZ_EXECUTION_SNAPSHOT_INVALID' })
      await expect(recheckWorkerAuthorizationSnapshot(snapshot(2, 2), 'ws_authz_api', 'task-other')).rejects.toMatchObject({ code: 'AUTHZ_EXECUTION_SNAPSHOT_INVALID' })
    } finally {
      setAuthorizationRepositoryForTests()
    }
  })
})

type HttpOperation = 'generation.execute' | 'publish.execute'
type ExecutionEnvelope = {
  data: {
    allowed?: boolean
    authorization_recheck?: { authorized: boolean; resource_id: string; reservation_id: string; event_id: string }
    commercial_access_recheck?: { allowed: boolean; ready: boolean }
  } | null
  error: { code: string } | null
}

function serializeSnapshot(snapshot: WorkerAuthorizationSnapshot) {
  return {
    schema_version: snapshot.schemaVersion, decision_id: snapshot.decisionId, actor_id: snapshot.actorId,
    identity_id: snapshot.identityId, workspace_id: snapshot.workspaceId, workbench: snapshot.workbench,
    context_id: snapshot.contextId, context_version: snapshot.contextVersion, policy_version: snapshot.policyVersion,
    grant_revision: snapshot.grantRevision, grant_ids: snapshot.grantIds, scope_hash: snapshot.scopeHash,
    capability: snapshot.capability, resource_id: snapshot.resourceId, resource_revision: snapshot.resourceRevision,
    request_id: snapshot.requestId, trace_id: snapshot.traceId, authorized: snapshot.authorized, decided_at: snapshot.decidedAt,
  }
}

// E1 protocol integration: real loopback HTTP and signed worker requests, with
// controlled in-memory repositories. This is not PostgreSQL/RLS, provider,
// enqueue-workflow, or real-platform evidence. Neither route nor recheck is mocked.
async function withHttpExecutionFixture(operation: HttpOperation, test: (fixture: Awaited<ReturnType<typeof createFixture>>) => Promise<void>) {
  const persistence = await persistenceReady
  expect(persistence.mode).toBe('memory')
  const originalOutbox = persistence.outbox
  const originalCreativePoints = persistence.creativePoints
  const fixtureMaps = [service.products, service.tasks, service.platformAccounts, service.publishJobs] as const
  const initialIds = fixtureMaps.map(map => new Set(map.keys()))
  vi.stubEnv('WORKER_API_CREDENTIALS', JSON.stringify({
    generation: { token: 'test-authz-generation-token', signing_secret: 'test-authz-generation-secret' },
    publish: { token: 'test-authz-publish-token', signing_secret: 'test-authz-publish-secret' },
  }))
  vi.stubEnv('AUTH_ENFORCEMENT', 'strict')
  try {
    const fixture = await createFixture(operation)
    await test(fixture)
  } finally {
    try {
      if (server.listening) await new Promise<void>((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve())
        server.closeAllConnections()
      })
    } finally {
      persistence.outbox = originalOutbox
      persistence.creativePoints = originalCreativePoints
      setAuthorizationRepositoryForTests()
      fixtureMaps.forEach((map, index) => { for (const id of map.keys()) if (!initialIds[index]!.has(id)) map.delete(id) })
      vi.restoreAllMocks()
      vi.unstubAllEnvs()
    }
  }
}

async function createFixture(operation: HttpOperation) {
  const persistence = await persistenceReady
  const suffix = randomUUID().replaceAll('-', '')
  const workspaceId = `ws_authz_http_${suffix}`
  const identityId = `identity_${suffix}`
  const resourceId = `${operation === 'publish.execute' ? 'publish_job' : 'generation_job'}_${suffix}`
  const repository = new MemoryAuthorizationRepository()
  const outbox = new InMemoryOutbox()
  const outboxAdapter: OutboxRepository = {
    append: async input => outbox.append(input), pending: async (...args) => outbox.pending(...args),
    markPublished: async (workspace, id) => outbox.markPublished(workspace, id),
    listAggregateEvents: async (...args) => outbox.listAggregateEvents(...args),
  }
  const listEvents = vi.spyOn(outboxAdapter, 'listAggregateEvents')
  persistence.outbox = outboxAdapter
  persistence.creativePoints = new MemoryCreativePointRepository()
  await persistence.creativePoints.grant({ workspaceId, points: 10, sourceType: 'test_fixture', sourceId: suffix, idempotencyKey: suffix })
  const balance = await persistence.creativePoints.getBalance(workspaceId)
  const entitlementFact = { schema_version: 1, workspace_id: workspaceId, balance_state: 'known', available_points: balance.availablePoints, reserved_points: balance.reservedPoints, settled_points: balance.settledPoints, access_revision: String(balance.revision) }
  const now = new Date()
  const capability = operation === 'publish.execute' ? 'customer.publish.execute' : 'customer.content.update'
  const issued = await repository.issueGrant({
    grantKind: 'temporary', accessMode: 'write', subjectIdentityId: identityId, workspaceId,
    capabilities: [capability], resourceScope: { workspace_ids: [workspaceId] },
    reason: 'execute approved HTTP fixture job', ticketRef: `AUTHZ-HTTP-${suffix}`, issuedBy: 'operator_a', approvedBy: 'security_a',
    approvedAt: now.toISOString(), expectedAuthorizationRevision: 0, expiresAt: new Date(now.getTime() + 60_000).toISOString(), maxUses: 1,
  })
  const grant = await repository.consumeGrant({ id: issued.id, subjectIdentityId: identityId, workspaceId, capability, scopeHash: issued.scopeHash, expectedRevision: issued.revision, actorId: 'operator_a', reason: 'admit approved fixture event' })
  if (!grant) throw new Error('HTTP grant fixture was not consumed')
  setAuthorizationRepositoryForTests(repository)
  const reserve = vi.spyOn(repository, 'reserveExecution')
  const snapshot: WorkerAuthorizationSnapshot = {
    schemaVersion: 1, decisionId: `decision_${suffix}`, actorId: 'operator_a', identityId, workspaceId, workbench: 'workspace',
    contextId: `workspace:${workspaceId}`, contextVersion: 'policy_context', policyVersion: 'policy_1',
    grantRevision: `grant:${grant.id}:${grant.revision}:${identityId}:${grant.authorizationRevision}`, grantIds: [grant.id], scopeHash: grant.scopeHash,
    capability: operation, resourceId, resourceRevision: '1', requestId: `request_${suffix}`, traceId: `trace_${suffix}`,
    authorized: true, decidedAt: now.toISOString(),
  }
  let job: PublishJob | undefined
  if (operation === 'publish.execute') {
    // Seed a controlled queued job, but use the real service getters and all
    // execution-time tenant/account/canonical-binding/state checks over it.
    const account = service.registerPlatformAccount({ workspaceId, platform: 'taobao', remoteAccountId: `remote_${suffix}`, credentialRef: `vault://test-only/${suffix}` })
    const product = { ...structuredClone(service.products.get('prod_fixture_1')!), id: `product_${suffix}`, workspaceId, accountId: account.id }
    service.products.set(product.id, product)
    const task: Task = {
      id: `task_${suffix}`, workspaceId, productId: product.id, platform: 'taobao', accountId: account.id,
      state: 'publishing', inputSnapshotId: `input_${suffix}`, answers: {}, missingQuestions: [], deferredQuestionIds: [], deferredQuestions: [], version: 2, createdAt: now.toISOString(),
    }
    service.tasks.set(task.id, task)
    job = {
      id: resourceId, workspaceId, taskId: task.id, contentVersionId: `content_${suffix}`, platform: 'taobao', accountId: account.id,
      accountRevision: account.authRevision ?? account.revision, authorizationSnapshot: { ...snapshot, capability: 'publish.execute' },
      idempotencyKey: suffix, state: 'queued', confirmationHash: 'a'.repeat(64), remoteSnapshotHash: 'b'.repeat(64),
      payloadSnapshot: { operation: 'update', fields: { title: 'controlled fixture' }, imageMode: 'unchanged' }, payloadHash: 'c'.repeat(64), selectedVisuals: [],
      canonicalBinding: buildCanonicalExecutionBinding({ workspaceId, taskId: task.id, productId: product.id, platform: 'taobao', accountId: account.id, inputSnapshotId: task.inputSnapshotId }),
      createdAt: now.toISOString(), revision: 1,
    }
    service.publishJobs.set(job.id, job)
  }
  const event = outbox.append({ workspaceId, aggregateId: resourceId, eventType: operation === 'publish.execute' ? 'publish.requested' : 'generation.requested', sequence: 1, payload: {
    authorization_snapshot: serializeSnapshot(snapshot),
    commercial_access_snapshot: {
      schema_version: 1, decision_id: `commercial_${suffix}`, workspace_id: workspaceId, operation,
      access_mode: 'POINT_REQUIRED_NO_CHARGE', access_revision: String(balance.revision), balance_state: 'known',
      entitlement_snapshot_id: `creative-point-access:${workspaceId}:${balance.revision}`,
      entitlement_snapshot_checksum: createHash('sha256').update(JSON.stringify(entitlementFact)).digest('hex'),
      rate_version: null, quoted_points: 0, decided_at: now.toISOString(),
    },
  } })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve() })
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('HTTP fixture failed to bind loopback')
  const request = async (options: { workspaceId?: string; eventId?: string; resourceId?: string; operation?: HttpOperation; invalidProof?: boolean } = {}) => {
    const requestedWorkspace = options.workspaceId ?? workspaceId
    const requestedResource = options.resourceId ?? resourceId
    const target = operation === 'publish.execute'
      ? `/v1/publish-jobs/${requestedResource}/execution-check?event_id=${options.eventId ?? event.id}`
      : `/v1/worker-events/${options.eventId ?? event.id}/execution-check?aggregate_id=${requestedResource}&operation=${options.operation ?? operation}`
    const role = operation === 'publish.execute' ? 'publish' : 'generation'
    const proof = createWorkerRequestProof({ secret: `test-authz-${role}-secret`, role, workerId: 'authz-http-fixture', method: 'GET', requestTarget: target, workspaceId: requestedWorkspace })
    const response = await fetch(`http://127.0.0.1:${address.port}${target}`, { headers: {
      authorization: `Bearer test-authz-${role}-token`, 'x-workspace-id': requestedWorkspace, ...proof.headers,
      ...(options.invalidProof ? { 'x-worker-workspace-signature': '0'.repeat(64) } : {}),
    } })
    return { status: response.status, body: await response.json() as ExecutionEnvelope }
  }
  return { workspaceId, identityId, resourceId, repository, grant, reserve, outbox, event, snapshot, job, listEvents, request }
}

describe('E1 worker execution-check: real signed HTTP with controlled memory repositories', () => {
  it.each<HttpOperation>(['generation.execute', 'publish.execute'])('%s loads scoped records and reserves the actual resource; replay never consumes twice and revoke blocks old/new execution', async operation => {
    await withHttpExecutionFixture(operation, async fixture => {
      const { workspaceId, resourceId, event, reserve, repository, grant, request, listEvents } = fixture
      const reservationId = `worker-execution:${event.id}:${operation}`
      const first = await request()
      expect(first).toMatchObject({ status: 200, body: { error: null, data: {
        ...(operation === 'publish.execute' ? { allowed: true } : {}),
        authorization_recheck: { authorized: true, resource_id: resourceId, event_id: event.id, reservation_id: reservationId },
        commercial_access_recheck: { allowed: true, ready: true },
      } } })
      expect(listEvents).toHaveBeenCalledWith(workspaceId, resourceId, 1000)
      expect(listEvents.mock.invocationCallOrder[0]).toBeLessThan(reserve.mock.invocationCallOrder[0]!)
      expect(reserve).toHaveBeenCalledWith(expect.objectContaining({ workspaceId, resourceId, eventId: event.id, grantId: grant.id }))
      await expect(reserve.mock.results[0]!.value).resolves.toMatchObject({ workspaceId, resourceId, eventId: event.id })
      expect(resourceId).not.toBe(workspaceId)
      const replay = await request()
      expect(replay.status).toBe(200)
      expect(replay.body.data?.authorization_recheck?.reservation_id).toBe(reservationId)
      expect(await repository.getGrant(grant.id, fixture.identityId)).toMatchObject({ useCount: 1, revision: grant.revision })
      await repository.revokeGrant({ id: grant.id, subjectIdentityId: fixture.identityId, actorId: 'operator_a', reason: 'revoke queued HTTP fixture', expectedRevision: grant.revision, expectedAuthorizationRevision: grant.authorizationRevision })
      const next = fixture.outbox.append({ ...event, sequence: 2 })
      const reserveCalls = reserve.mock.calls.length
      for (const eventId of [event.id, next.id]) {
        expect(await request({ eventId })).toMatchObject({ status: 403, body: { error: { code: 'AUTHZ_EXECUTION_REVOKED' }, data: null } })
        expect(reserve).toHaveBeenCalledTimes(reserveCalls)
      }
    })
  })

  const rejectionCases = ['invalid proof', 'wrong workspace', 'nonexistent event', 'wrong aggregate', 'wrong operation', 'snapshot workspace', 'snapshot resource', 'snapshot operation', 'snapshot identity', 'snapshot scope', 'missing snapshot'] as const
  for (const operation of ['generation.execute', 'publish.execute'] as const) {
    it.each(rejectionCases)(`${operation}: rejects %s before any authorization reservation`, async failure => {
      await withHttpExecutionFixture(operation, async fixture => {
        const options: Parameters<typeof fixture.request>[0] = {}
        const authorization = fixture.event.payload.authorization_snapshot as Record<string, unknown>
        let expectedStatus = 403
        let expectedCode = 'AUTHZ_EXECUTION_SNAPSHOT_INVALID'
        if (failure === 'invalid proof') { options.invalidProof = true; expectedCode = 'FORBIDDEN' }
        if (failure === 'wrong workspace') { options.workspaceId = 'ws_other_http'; expectedStatus = operation === 'publish.execute' ? 403 : 404; expectedCode = operation === 'publish.execute' ? 'TENANT_SCOPE_DENIED' : 'AUTHORIZATION_EVENT_NOT_FOUND' }
        if (failure === 'nonexistent event') { options.eventId = 'evt_nonexistent'; expectedStatus = 404; expectedCode = 'AUTHORIZATION_EVENT_NOT_FOUND' }
        if (failure === 'wrong aggregate') {
          // Keep the publish job real: reject an event from another aggregate,
          // rather than passing this case merely because a job is missing.
          if (operation === 'publish.execute') fixture.event.aggregateId = 'job_other_http'
          else options.resourceId = 'job_other_http'
          expectedStatus = 404
          expectedCode = 'AUTHORIZATION_EVENT_NOT_FOUND'
        }
        if (failure === 'wrong operation') {
          if (operation === 'publish.execute') { fixture.event.eventType = 'generation.requested'; expectedStatus = 404; expectedCode = 'AUTHORIZATION_EVENT_NOT_FOUND' }
          else { options.operation = 'publish.execute'; expectedCode = 'AUTHZ_EXECUTION_OPERATION_MISMATCH' }
        }
        if (failure === 'snapshot workspace') authorization.workspace_id = 'ws_other_http'
        if (failure === 'snapshot resource') authorization.resource_id = 'job_other_http'
        if (failure === 'snapshot operation') authorization.capability = operation === 'publish.execute' ? 'generation.execute' : 'publish.execute'
        if (failure === 'snapshot identity') authorization.identity_id = 'identity_other_http'
        if (failure === 'snapshot scope') { authorization.scope_hash = 'f'.repeat(64); expectedCode = operation === 'publish.execute' ? 'AUTHZ_EXECUTION_SNAPSHOT_INVALID' : 'AUTHZ_EXECUTION_REVOKED' }
        if (failure === 'missing snapshot') delete fixture.event.payload.authorization_snapshot
        const response = await fixture.request(options)
        expect(response.status).toBe(expectedStatus)
        expect(response.body.error?.code).toBe(expectedCode)
        expect(response.body.data).toBeNull()
        expect(fixture.reserve).not.toHaveBeenCalled()
      })
    })
  }

  it.each(['task binding', 'account revision', 'job state', 'job snapshot'] as const)('publish.execute: re-reads the stored %s before any reservation', async changed => {
    await withHttpExecutionFixture('publish.execute', async fixture => {
      const job = fixture.job!
      if (changed === 'task binding') service.getTask(job.taskId).inputSnapshotId = 'input_changed_after_enqueue'
      if (changed === 'account revision') service.revokePlatformAccount(fixture.workspaceId, job.accountId!, job.platform)
      if (changed === 'job state') job.state = 'published'
      if (changed === 'job snapshot') job.authorizationSnapshot = { ...job.authorizationSnapshot!, decisionId: 'different_job_decision' }
      const expectedCode = {
        'task binding': 'CANONICAL_EXECUTION_BINDING_STALE', 'account revision': 'PUBLISH_AUTHORIZATION_REVOKED',
        'job state': 'PUBLISH_JOB_NOT_EXECUTABLE', 'job snapshot': 'AUTHZ_EXECUTION_SNAPSHOT_INVALID',
      }[changed]
      expect(await fixture.request()).toMatchObject({ status: changed === 'job snapshot' ? 403 : 409, body: { data: null, error: { code: expectedCode } } })
      expect(fixture.reserve).not.toHaveBeenCalled()
    })
  })

  for (const operation of ['generation.execute', 'publish.execute'] as const) {
    it.each(['decision', 'resource'] as const)(`${operation}: a historical event replay cannot replace its reserved %s`, async field => {
      await withHttpExecutionFixture(operation, async fixture => {
        expect((await fixture.request()).status).toBe(200)
        const originalReservation = await fixture.reserve.mock.results[0]!.value
        const changed = { ...fixture.snapshot, ...(field === 'decision' ? { decisionId: 'decision_replay_changed' } : { resourceId: `${fixture.resourceId}_changed` }) }
        fixture.event.payload.authorization_snapshot = serializeSnapshot(changed)
        fixture.event.aggregateId = changed.resourceId
        if (fixture.job) service.publishJobs.set(changed.resourceId, { ...fixture.job, id: changed.resourceId, authorizationSnapshot: { ...changed, capability: 'publish.execute' } })
        expect(await fixture.request({ resourceId: changed.resourceId })).toMatchObject({ status: 403, body: { error: { code: 'AUTHZ_EXECUTION_SNAPSHOT_INVALID' }, data: null } })
        expect(fixture.reserve).toHaveBeenCalledTimes(2)
        await expect(fixture.reserve.mock.results[1]!.value).rejects.toMatchObject({ code: 'AUTHORIZATION_EXECUTION_RESERVATION_CONFLICT' })
        expect(originalReservation).toMatchObject({ eventId: fixture.event.id, resourceId: fixture.resourceId, decisionId: fixture.snapshot.decisionId })
        expect(await fixture.repository.getGrant(fixture.grant.id, fixture.identityId)).toMatchObject({ useCount: 1, revision: fixture.grant.revision })
        fixture.event.payload.authorization_snapshot = serializeSnapshot(fixture.snapshot)
        fixture.event.aggregateId = fixture.resourceId
        if (fixture.job) service.publishJobs.set(fixture.job.id, fixture.job)
        expect(await fixture.request()).toMatchObject({ status: 200, body: { data: { authorization_recheck: { reservation_id: `worker-execution:${fixture.event.id}:${operation}` } } } })
        await expect(fixture.reserve.mock.results[2]!.value).resolves.toEqual(originalReservation)
      })
    })
  }
})
