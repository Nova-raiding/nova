import { createHash, randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createWorkerRequestProof } from '../../../packages/security/src/worker-request-proof.js'
import { enableCommercialFixtureHarnessForTests, grantCreativePointsForTests, knowledgeDocumentsForTests, server } from './server.js'

type Envelope<T = unknown> = { data: T | null; error: { code: string; message: string } | null }

function providerAttemptIdentity(input: { workspaceId: string; eventId: string; aggregateId: string; taskId: string; logicalAttempt: number; transportAttempt: number; providerAttemptKey: string; requestBodySha256: string }) {
  const seed = JSON.stringify([input.workspaceId, input.eventId, input.aggregateId, input.taskId, input.logicalAttempt, input.transportAttempt, input.providerAttemptKey, input.requestBodySha256])
  const uuid = (domain: string) => {
    const hex = createHash('sha256').update(`${domain}\0${seed}`, 'utf8').digest('hex')
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`
  }
  return { provider_attempt_id: uuid('knowledge-provider-attempt-v1'), request_nonce: uuid('knowledge-provider-nonce-v1') }
}

async function startApi() {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error)
    server.once('error', onError)
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', onError); resolve() })
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('server did not bind')
  return `http://127.0.0.1:${address.port}`
}

async function json<T>(response: Response) { return await response.json() as Envelope<T> }

function signedWorkerHeaders(input: { role: 'generation' | 'publish'; method: 'POST' | 'PATCH'; target: string; workspaceId: string; body: string }) {
  const secret = input.role === 'generation' ? 'knowledge-claim-generation-secret' : 'knowledge-claim-publish-secret'
  const proof = createWorkerRequestProof({ secret, workerId: `test-${input.role}`, role: input.role, method: input.method, requestTarget: input.target, workspaceId: input.workspaceId, body: input.body })
  return { 'content-type': 'application/json', authorization: `Bearer ${input.role}-token`, 'x-workspace-id': input.workspaceId, ...proof.headers }
}

describe('signed generation knowledge claim API', () => {
  afterEach(async () => {
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()))
    vi.unstubAllEnvs()
  })

  it('accepts an empty frozen document set but rejects missing and oversized expected_documents', async () => {
    vi.stubEnv('NODE_ENV', 'test')
    vi.stubEnv('API_RATE_LIMIT_PER_MINUTE', '10000')
    enableCommercialFixtureHarnessForTests()
    const workspaceId = 'ws_demo'
    await grantCreativePointsForTests(workspaceId)
    const base = await startApi()
    const merchantHeaders = { 'content-type': 'application/json', 'x-workspace-id': workspaceId, 'x-test-commercial-fixture': 'server-e2e' }
    const task = await fetch(`${base}/v1/tasks`, { method: 'POST', headers: merchantHeaders, body: JSON.stringify({ product_id: 'prod_fixture_1', platform: 'taobao' }) }).then(json<{ id: string }>)
    expect(task.error).toBeNull()
    const taskId = task.data!.id
    await fetch(`${base}/v1/tasks/${taskId}/directions`, { method: 'POST', headers: merchantHeaders, body: JSON.stringify({ direction_id: 'A' }) })
    await fetch(`${base}/v1/tasks/${taskId}/plan/confirm`, { method: 'POST', headers: merchantHeaders, body: JSON.stringify({ expected_version: 2 }) })
    const queued = await fetch(`${base}/v1/tasks/${taskId}/content-jobs`, { method: 'POST', headers: { ...merchantHeaders, 'idempotency-key': `knowledge-empty-${randomUUID()}` }, body: '{}' }).then(json<{ id: string }>)
    expect(queued.error).toBeNull()
    const jobId = queued.data!.id
    const timeline = await fetch(`${base}/v1/tasks/${taskId}/timeline?limit=100`, { headers: merchantHeaders }).then(json<Array<{ id: string; aggregate_id: string; event_type: string; payload: Record<string, unknown> }>>)
    const event = timeline.data!.find(item => item.aggregate_id === jobId && item.event_type === 'generation.requested')!
    const frozenInput = event.payload.input as { product: { id: string }; knowledgeContext?: { documents?: unknown[] } }
    expect(frozenInput.knowledgeContext?.documents ?? []).toEqual([])
    vi.stubEnv('AUTH_ENFORCEMENT', 'strict')
    vi.stubEnv('WORKER_API_CREDENTIALS', JSON.stringify({ generation: { token: 'generation-token', signing_secret: 'knowledge-claim-generation-secret' } }))
    const claimPath = '/v1/internal/knowledge/generation-claims'
    const request = {
      workspace_id: workspaceId, event_id: event.id, aggregate_id: jobId, task_id: taskId,
      logical_attempt: 1, transport_attempt: 1, provider_attempt_key: `mm-${'a'.repeat(64)}`,
      request_body_sha256: 'b'.repeat(64), product_id: frozenInput.product.id,
      context_hash: event.payload.context_hash, expected_documents: [] as unknown[],
    }
    Object.assign(request, providerAttemptIdentity({ workspaceId, eventId: event.id, aggregateId: jobId, taskId, logicalAttempt: 1, transportAttempt: 1, providerAttemptKey: request.provider_attempt_key, requestBodySha256: request.request_body_sha256 }))
    const call = async (input: Record<string, unknown>) => {
      const body = JSON.stringify(input)
      return fetch(`${base}${claimPath}`, { method: 'POST', headers: signedWorkerHeaders({ role: 'generation', method: 'POST', target: claimPath, workspaceId, body }), body }).then(json<Record<string, unknown>>)
    }
    expect((await call({ ...request, expected_documents: undefined })).error?.code).toBe('INVALID_REQUEST')
    expect((await call({ ...request, expected_documents: {} })).error?.code).toBe('INVALID_REQUEST')
    expect((await call({ ...request, expected_documents: Array(9).fill({}) })).error?.code).toBe('INVALID_REQUEST')
    const accepted = await call(request)
    expect(accepted.error).toBeNull()
    expect(accepted.data).toMatchObject({ claim_state: 'claimed', document_count: 0, event_id: event.id })
    const transitionPath = `${claimPath}/${encodeURIComponent(String(accepted.data!.claim_id))}`
    for (const to of ['provider_started', 'completed']) {
      const body = JSON.stringify({ ...request, to })
      const transition = await fetch(`${base}${transitionPath}`, { method: 'PATCH', headers: signedWorkerHeaders({ role: 'generation', method: 'PATCH', target: transitionPath, workspaceId, body }), body }).then(json<Record<string, unknown>>)
      expect(transition.error).toBeNull()
    }
  })

  it('binds claim and transitions to a durable task snapshot, blocks mutation until completion, and rejects other worker roles', async () => {
    vi.stubEnv('NODE_ENV', 'test')
    vi.stubEnv('API_RATE_LIMIT_PER_MINUTE', '10000')
    enableCommercialFixtureHarnessForTests()
    const workspaceId = 'ws_demo'
    await grantCreativePointsForTests(workspaceId)
    const text = `claim-fence-${randomUUID()}: approved product fact`
    const document = await knowledgeDocumentsForTests.createDocument({
      workspaceId,
      productId: 'prod_fixture_1',
      knowledgeType: 'product_facts',
      title: 'claim fence e2e',
      contentHash: createHash('sha256').update(text).digest('hex'),
      extractedText: text,
      approvalStatus: 'approved',
      rightsStatus: 'cleared',
      indexState: 'ready',
    })
    const base = await startApi()
    const merchantHeaders = { 'content-type': 'application/json', 'x-workspace-id': workspaceId, 'x-test-commercial-fixture': 'server-e2e' }
    const taskResponse = await fetch(`${base}/v1/tasks`, { method: 'POST', headers: merchantHeaders, body: JSON.stringify({ product_id: 'prod_fixture_1', platform: 'taobao' }) }).then(json<{ id: string }>)
    expect(taskResponse.error).toBeNull()
    const taskId = taskResponse.data!.id
    await fetch(`${base}/v1/tasks/${taskId}/directions`, { method: 'POST', headers: merchantHeaders, body: JSON.stringify({ direction_id: 'A' }) })
    await fetch(`${base}/v1/tasks/${taskId}/plan/confirm`, { method: 'POST', headers: merchantHeaders, body: JSON.stringify({ expected_version: 2 }) })
    const queued = await fetch(`${base}/v1/tasks/${taskId}/content-jobs`, { method: 'POST', headers: { ...merchantHeaders, 'idempotency-key': `knowledge-claim-${randomUUID()}` }, body: '{}' }).then(json<{ id: string }>)
    expect(queued.error).toBeNull()
    const jobId = queued.data!.id
    const timeline = await fetch(`${base}/v1/tasks/${taskId}/timeline?limit=100`, { headers: merchantHeaders }).then(json<Array<{ id: string; aggregate_id: string; event_type: string; payload: Record<string, unknown> }>>)
    const event = timeline.data!.find(item => item.aggregate_id === jobId && item.event_type === 'generation.requested')
    expect(event).toBeDefined()
    const frozenInput = event!.payload.input as { product: { id: string }; knowledgeContext?: { documents?: Array<{ id: string; revision: number; content: string }> } }
    const frozenDocuments = frozenInput.knowledgeContext?.documents ?? []
    expect(frozenDocuments.some(item => item.id === document.id)).toBe(true)
    const contextHash = event!.payload.context_hash as string
    const body = {
      workspace_id: workspaceId,
      event_id: event!.id,
      aggregate_id: jobId,
      task_id: taskId,
      logical_attempt: 1,
      transport_attempt: 1,
      provider_attempt_key: `mm-${'a'.repeat(64)}`,
      request_body_sha256: 'b'.repeat(64),
      product_id: frozenInput.product.id,
      context_hash: contextHash,
      expected_documents: frozenDocuments.map(item => ({ document_id: item.id, revision: item.revision, content_sha256: createHash('sha256').update(item.content).digest('hex') })),
    }
    Object.assign(body, providerAttemptIdentity({ workspaceId, eventId: event!.id, aggregateId: jobId, taskId, logicalAttempt: 1, transportAttempt: 1, providerAttemptKey: body.provider_attempt_key, requestBodySha256: body.request_body_sha256 }))
    vi.stubEnv('AUTH_ENFORCEMENT', 'strict')
    vi.stubEnv('WORKER_API_CREDENTIALS', JSON.stringify({ generation: { token: 'generation-token', signing_secret: 'knowledge-claim-generation-secret' }, publish: { token: 'publish-token', signing_secret: 'knowledge-claim-publish-secret' } }))
    const claimPath = '/v1/internal/knowledge/generation-claims'
    const postBody = JSON.stringify(body)
    const wrongRole = await fetch(`${base}${claimPath}`, { method: 'POST', headers: signedWorkerHeaders({ role: 'publish', method: 'POST', target: claimPath, workspaceId, body: postBody }), body: postBody }).then(json)
    expect(wrongRole.error?.code).toBe('FORBIDDEN')
    const first = await fetch(`${base}${claimPath}`, { method: 'POST', headers: signedWorkerHeaders({ role: 'generation', method: 'POST', target: claimPath, workspaceId, body: postBody }), body: postBody }).then(json<Record<string, unknown>>)
    expect(first.error).toBeNull()
    expect(first.data).toMatchObject({ ok: true, workspace_id: workspaceId, event_id: event!.id, aggregate_id: jobId, task_id: taskId, product_id: frozenInput.product.id, context_hash: contextHash, document_count: frozenDocuments.length, claim_state: 'claimed' })
    const replay = await fetch(`${base}${claimPath}`, { method: 'POST', headers: signedWorkerHeaders({ role: 'generation', method: 'POST', target: claimPath, workspaceId, body: postBody }), body: postBody }).then(json<Record<string, unknown>>)
    expect(replay.data).toMatchObject({ claim_id: first.data!.claim_id, claim_state: 'claimed' })
    await expect(knowledgeDocumentsForTests.transitionIndexState(workspaceId, document.id, 'stale')).rejects.toThrow('KNOWLEDGE_GENERATION_ACTIVE')

    const claimId = String(first.data!.claim_id)
    const transitionPath = `${claimPath}/${encodeURIComponent(claimId)}`
    const identityBody = { ...body, to: 'provider_started' }
    const transitionJson = JSON.stringify(identityBody)
    const started = await fetch(`${base}${transitionPath}`, { method: 'PATCH', headers: signedWorkerHeaders({ role: 'generation', method: 'PATCH', target: transitionPath, workspaceId, body: transitionJson }), body: transitionJson }).then(json<Record<string, unknown>>)
    expect(started.error).toBeNull()
    expect(started.data).toMatchObject({ claim_id: claimId, claim_state: 'provider_started', claimed_at: first.data!.claimed_at })
    const forgedIdentity = JSON.stringify({ ...body, event_id: randomUUID(), to: 'completed' })
    const forgedTransition = await fetch(`${base}${transitionPath}`, { method: 'PATCH', headers: signedWorkerHeaders({ role: 'generation', method: 'PATCH', target: transitionPath, workspaceId, body: forgedIdentity }), body: forgedIdentity }).then(json<Record<string, unknown>>)
    expect(forgedTransition.error?.code).toBe('KNOWLEDGE_GENERATION_ATTEMPT_IDENTITY_MISMATCH')
    const completeBody = JSON.stringify({ ...body, to: 'completed' })
    const completed = await fetch(`${base}${transitionPath}`, { method: 'PATCH', headers: signedWorkerHeaders({ role: 'generation', method: 'PATCH', target: transitionPath, workspaceId, body: completeBody }), body: completeBody }).then(json<Record<string, unknown>>)
    expect(completed.data).toMatchObject({ claim_id: claimId, claim_state: 'completed', claimed_at: first.data!.claimed_at })
    await expect(knowledgeDocumentsForTests.transitionIndexState(workspaceId, document.id, 'stale')).resolves.toMatchObject({ indexState: 'stale' })
  })
})
