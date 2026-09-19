import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { request as httpRequest } from 'node:http'
import { createWorkerRequestProof } from '../../../packages/security/src/worker-request-proof.js'
import { server, service, workspaceMembers } from './server.js'

async function start() {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error)
    server.once('error', onError)
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', onError); resolve() })
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('server did not bind')
  return `http://127.0.0.1:${address.port}`
}

describe('API request observability wiring', () => {
  beforeEach(() => {
    vi.stubEnv('REQUEST_OBSERVABILITY_LOGS', 'true')
    vi.stubEnv('AUTH_ENFORCEMENT', 'strict')
    vi.stubEnv('SESSION_ID_HASH_SECRET', 'request-observability-e2e-secret')
  })
  afterEach(async () => {
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()))
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
  })

  it('keeps request/trace ids stable and emits only whitelisted received/completed fields', async () => {
    const lines: string[] = []
    vi.spyOn(console, 'info').mockImplementation(value => lines.push(String(value)))
    const workspaceId = `ws_observed_${Date.now()}`
    const actorId = `trusted-observer-${Date.now()}`
    const token = `observer-token-${Date.now()}`
    await workspaceMembers.upsert({ workspaceId, externalSubject: actorId, displayName: actorId, role: 'workspace_owner', status: 'active', invitedBy: 'observability-test' })
    vi.stubEnv('API_AUTH_TOKENS', JSON.stringify({ [token]: { workspaces: [workspaceId], actor_id: actorId, roles: ['workspace_owner'], capabilities: ['workspace.summary.read'] } }))
    const base = await start()
    const response = await fetch(`${base}/mcp?query_secret=must-not-log`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-workspace-id': workspaceId, 'x-account-id': 'forged-store', 'x-request-id': 'req-observed', 'x-trace-id': 'trace-observed', authorization: `Bearer ${token}`, cookie: 'session=cookie-secret' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ops.session', params: {}, body_secret: 'must-not-log-body' }),
    })
    const envelope = await response.json() as { request_id: string; trace_id: string }
    expect(envelope).toMatchObject({ request_id: 'req-observed', trace_id: 'trace-observed' })
    expect(response.headers.get('x-request-id')).toBe('req-observed')
    expect(response.headers.get('x-trace-id')).toBe('trace-observed')

    const events = lines.map(line => JSON.parse(line) as Record<string, unknown>)
    expect(events.map(event => event.event)).toEqual(['request.received', 'request.completed'])
    expect(events[0]).toMatchObject({ workspace_id: null, task_id: null, job_id: null, attempt: null, platform: null, account_id: null, actor_id: null })
    expect(events[1]).toMatchObject({ request_id: 'req-observed', trace_id: 'trace-observed', workspace_id: workspaceId, account_id: null, actor_id: actorId, method: 'POST', route: '/mcp', status: 200, error_code: null })
    expect(Object.keys(events[1]!)).toEqual(['event', 'request_id', 'trace_id', 'workspace_id', 'task_id', 'job_id', 'attempt', 'platform', 'account_id', 'actor_id', 'method', 'route', 'status', 'duration_ms', 'error_code', 'authz_decision_id', 'authz_policy_version', 'authz_mode', 'authz_result', 'authz_reason', 'authz_capability', 'worker_role', 'worker_credential_slot', 'worker_proof_timestamp', 'worker_body_sha256', 'worker_nonce_sha256', 'worker_verified_at'])
    expect(lines.join('\n')).not.toMatch(/forged-store|forged-actor|cookie-secret|query_secret|must-not-log-body|Bearer|cookie|body_secret/u)
  })

  it('emits one failed terminal event with MCP context and no completed duplicate', async () => {
    const lines: string[] = []
    vi.spyOn(console, 'info').mockImplementation(value => lines.push(String(value)))
    const workspaceId = `ws_failed_observed_${Date.now()}`
    const actorId = `trusted-failed-observer-${Date.now()}`
    const token = `failed-observer-token-${Date.now()}`
    await workspaceMembers.upsert({ workspaceId, externalSubject: actorId, displayName: actorId, role: 'workspace_owner', status: 'active', invitedBy: 'observability-test' })
    vi.stubEnv('API_AUTH_TOKENS', JSON.stringify({ [token]: { workspaces: [workspaceId], actor_id: actorId, roles: ['workspace_owner'] } }))
    const base = await start()
    const response = await fetch(`${base}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-workspace-id': workspaceId, 'x-account-id': 'forged-failed-store', 'x-actor-id': 'forged-failed-actor', 'x-request-id': 'req-failed-observed', authorization: `Bearer ${token}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'unknown.method', params: { workspace_id: workspaceId, task_id: 'untrusted-task', attempt: '3', platform: 'douyin', account_id: 'untrusted-store' }, token: 'body-token-secret' }),
    })
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({
      request_id: 'req-failed-observed', trace_id: 'req-failed-observed', data: null,
      error: { code: 'FORBIDDEN' },
    })
    const events = lines.map(line => JSON.parse(line) as Record<string, unknown>)
    expect(events.map(event => event.event)).toEqual(['request.received', 'request.failed'])
    expect(events[0]).toMatchObject({ workspace_id: null, task_id: null, job_id: null, attempt: null, platform: null, account_id: null, actor_id: null })
    expect(events[1]).toMatchObject({ request_id: 'req-failed-observed', trace_id: 'req-failed-observed', workspace_id: workspaceId, task_id: null, attempt: null, platform: null, account_id: null, actor_id: actorId, status: 403, error_code: 'FORBIDDEN' })
    expect(lines.join('\n')).not.toMatch(/body-token-secret|forged-failed-store|forged-failed-actor|untrusted-task|untrusted-store/u)
  })

  it('classifies a directly returned readiness error as failed instead of completed', async () => {
    const lines: string[] = []
    vi.spyOn(console, 'info').mockImplementation(value => lines.push(String(value)))
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('RELEASE_SHA', '')
    vi.stubEnv('RELEASE_BUILD_ID', '')
    vi.stubEnv('RELEASE_AT', '')
    const base = await start()

    const response = await fetch(`${base}/healthz`, { headers: { 'x-request-id': 'req-readiness-failed' } })

    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({
      request_id: 'req-readiness-failed', trace_id: 'req-readiness-failed', data: null,
      error: { code: expect.stringMatching(/^(?:RELEASE_METADATA_UNAVAILABLE|REDIS_UNAVAILABLE)$/u) },
    })
    const events = lines.map(line => JSON.parse(line) as Record<string, unknown>)
    expect(events.map(event => event.event)).toEqual(['request.received', 'request.failed'])
    expect(events[1]).toMatchObject({ request_id: 'req-readiness-failed', workspace_id: 'system', status: 503, error_code: expect.stringMatching(/^(?:RELEASE_METADATA_UNAVAILABLE|REDIS_UNAVAILABLE)$/u) })
  })

  it('correlates a publish observation with its durable publish job id', async () => {
    const lines: string[] = []
    vi.spyOn(console, 'info').mockImplementation(value => lines.push(String(value)))
    vi.stubEnv('NODE_ENV', 'test')
    vi.stubEnv('AUTH_ENFORCEMENT', 'local')
    const workspaceId = `ws_publish_job_observed_${Date.now()}`
    const account = service.registerPlatformAccount({ workspaceId, platform: 'taobao', remoteAccountId: `taobao-observed-${Date.now()}`, credentialRef: `fixture-secret/taobao/${workspaceId}` })
    const product = service.importProduct({ workspaceId, platform: 'taobao', accountId: account.id, title: '观测关联商品', stock: 3 })
    service.confirmProductFacts(workspaceId, product.id)
    const task = service.createTask({ workspaceId, productId: product.id, platform: 'taobao', accountId: account.id })
    service.selectDirection(task.id, 'A')
    const draft = service.createDraft(task.id)
    service.approveContent(task.id, draft.id)
    const preview = service.preparePublish(task.id)
    const job = service.confirmPublish({ workspaceId, taskId: task.id, contentVersionId: draft.id, confirmationHash: preview.confirmationHash, remoteSnapshotHash: preview.remoteSnapshotHash, idempotencyKey: `observed-${Date.now()}`, accountId: account.id })
    const base = await start()
    const response = await fetch(`${base}/v1/publish-jobs/${job.id}/observation`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-workspace-id': workspaceId, 'x-request-id': 'req-publish-observed' },
      body: JSON.stringify({ status: { found: true, state: 'published', remote_id: 'remote-observed', request_id: 'request-observed', simulated: false } }),
    })

    expect(response.status).toBe(200)
    const events = lines.map(line => JSON.parse(line) as Record<string, unknown>)
    expect(events.map(event => event.event)).toEqual(['request.received', 'request.completed'])
    // Only the publish-observation route enriches `job_id`. Deleting that call
    // left the terminal line at `job_id: null` while every other suite passed,
    // so this is the assertion that keeps the ops runbook correlation real.
    expect(events[0]).toMatchObject({ event: 'request.received', job_id: null })
    expect(events[1]).toMatchObject({
      event: 'request.completed',
      request_id: 'req-publish-observed',
      route: `/v1/publish-jobs/${job.id}/observation`,
      workspace_id: workspaceId,
      job_id: job.id,
      status: 200,
    })
  })

  it('records a client-disconnected request as an aborted 499 instead of a completed 200', async () => {
    const lines: string[] = []
    vi.spyOn(console, 'info').mockImplementation(value => lines.push(String(value)))
    const workspaceId = `ws_aborted_observed_${Date.now()}`
    const actorId = `aborted-observer-${Date.now()}`
    const token = `aborted-observer-token-${Date.now()}`
    await workspaceMembers.upsert({ workspaceId, externalSubject: actorId, displayName: actorId, role: 'workspace_owner', status: 'active', invitedBy: 'observability-test' })
    vi.stubEnv('API_AUTH_TOKENS', JSON.stringify({ [token]: { workspaces: [workspaceId], actor_id: actorId, roles: ['workspace_owner'] } }))
    const base = await start()
    const address = new URL(base)
    // The scrape itself is an in-flight request, so the gauge reads 1 while it
    // is being served. An abort that only decremented on 'finish' left that
    // number permanently higher for every later scrape.
    const inFlightGauge = async () => {
      const metrics = await (await fetch(`${base}/metrics`)).text()
      return Number(/^merchant_http_inflight_requests (\d+)$/mu.exec(metrics)?.[1])
    }
    const idleGauge = await inFlightGauge()
    // Announce more body bytes than are ever sent, then destroy the socket: the
    // handler is still awaiting the request body when the client goes away, so
    // the response never finishes and 'close' (not 'finish') ends the request.
    await new Promise<void>(resolve => {
      const request = httpRequest({ hostname: address.hostname, port: Number(address.port), path: '/mcp', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': '256', 'x-workspace-id': workspaceId, 'x-request-id': 'req-aborted-observed', authorization: `Bearer ${token}` } })
      request.on('error', () => resolve())
      request.write('{"jsonrpc":"2.0"')
      setTimeout(() => { request.destroy(); resolve() }, 50)
    })
    await new Promise(resolve => setTimeout(resolve, 200))

    const events = (lines.map(line => JSON.parse(line) as Record<string, unknown>)).filter(event => event.request_id === 'req-aborted-observed')
    expect(events[0]).toMatchObject({ event: 'request.received' })
    // The terminal classification for a client disconnect: an abort with the
    // 499 status, never the `request.completed status:200` that used to be
    // written into the audit stream for a request the client never received.
    // The disconnect happens while the body is still unread, so the request
    // never reached workspace enrichment: the aborted line carries the 499
    // classification and the correlation ids, not the tenant context.
    expect(events[1]).toMatchObject({ event: 'request.aborted', status: 499, workspace_id: null, error_code: null, route: '/mcp' })
    expect(events.some(event => event.event === 'request.completed')).toBe(false)
    // The rejected await also emits `request.failed`; that redundancy is the
    // current behaviour and is asserted so a change to it is visible here.
    expect(events.some(event => event.event === 'request.failed')).toBe(true)
    // The in-flight gauge must come back down on the abort path too.
    expect(await inFlightGauge()).toBe(idleGauge)
  })

  it('emits redacted worker role and rotation proof evidence on the real API surface', async () => {
    const lines: string[] = []
    vi.spyOn(console, 'info').mockImplementation(value => lines.push(String(value)))
    vi.stubEnv('NODE_ENV', 'staging')
    vi.stubEnv('WORKER_API_CREDENTIALS', JSON.stringify({ automation: [
      { token: 'current-worker-token', signing_secret: 'current-worker-signing-secret' },
      { token: 'rotation-worker-token', signing_secret: 'rotation-worker-signing-secret' },
    ] }))
    const base = await start()
    const path = '/v1/internal/automation/tick'
    const workspaceId = 'ws_worker_observed'
    const proof = createWorkerRequestProof({ role: 'automation', workerId: 'automation', secret: 'rotation-worker-signing-secret', method: 'POST', requestTarget: path, workspaceId, nonce: 'worker-observation-nonce-0001' })
    const response = await fetch(`${base}${path}`, { method: 'POST', headers: {
      authorization: 'Bearer rotation-worker-token', 'x-workspace-id': workspaceId, 'x-request-id': 'req-worker-observed', ...proof.headers,
    } })

    expect(response.status).toBe(200)
    const events = lines.map(line => JSON.parse(line) as Record<string, unknown>)
    expect(events.at(-1)).toMatchObject({
      event: 'request.completed', request_id: 'req-worker-observed', workspace_id: workspaceId, actor_id: 'worker:automation',
      worker_role: 'automation', worker_credential_slot: 'rotation', worker_proof_timestamp: Number(proof.timestamp),
      worker_body_sha256: proof.bodySha256, worker_nonce_sha256: expect.stringMatching(/^[a-f0-9]{64}$/u), worker_verified_at: expect.any(String),
    })
    expect(lines.join('\n')).not.toMatch(/rotation-worker-token|rotation-worker-signing-secret|worker-observation-nonce-0001|x-worker-workspace-signature|authorization/u)
  })
})
