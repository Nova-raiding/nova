import { describe, expect, it } from 'vitest'
import { verifyWorkerRequestProof } from '../../../packages/security/src/worker-request-proof.js'
import type { DurableOutboxEvent } from '../../../packages/workers/src/durable.js'
import { assertPublishExecution, workerRoleForRequest } from './main.js'

const bindingEvent: DurableOutboxEvent = {
  id: 'evt_publish_binding', workspaceId: 'ws_publish_binding', aggregateId: 'job_publish_binding',
  eventType: 'publish.requested', sequence: 1, payload: {}, createdAt: new Date().toISOString(),
}

function executionGateResponse() {
  return new Response(JSON.stringify({ data: { credential_ref: 'vault://merchant/ws_publish_binding/jd', payload_hash: 'a'.repeat(64) } }), { status: 200 })
}

function capturedRequest(captured: { url?: string; headers?: Headers }) {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    captured.url = String(input)
    captured.headers = new Headers(init?.headers)
    return executionGateResponse()
  }) as unknown as typeof fetch
}

describe('publish execution worker role', () => {
  it('resolves the publish role for execution checks unless the caller declares reconcile', () => {
    expect(workerRoleForRequest('GET', '/v1/publish-jobs/job_publish_binding/execution-check?event_id=evt_publish_binding')).toBe('publish')
    expect(workerRoleForRequest('GET', '/v1/publish-jobs/job_publish_binding/execution-check?event_id=evt_publish_binding&worker_role=reconcile')).toBe('reconcile')
    // A declaration the API does not admit on this route cannot select a role.
    expect(workerRoleForRequest('GET', '/v1/publish-jobs/job_publish_binding/execution-check?worker_role=automation')).toBe('publish')
    // Neighboring publish routes keep their existing role policy.
    expect(workerRoleForRequest('GET', '/v1/publish-jobs/job_publish_binding/media')).toBe('publish')
    expect(workerRoleForRequest('POST', '/v1/publish-jobs/job_publish_binding/observation', JSON.stringify({ source: 'reconcile' }))).toBe('reconcile')
    expect(workerRoleForRequest('POST', '/v1/publish-jobs/job_publish_binding/observation', JSON.stringify({ source: 'publish' }))).toBe('publish')
  })

  it('signs, labels and authenticates the reconcile execution check with one credential set', async () => {
    const captured: { url?: string; headers?: Headers } = {}
    await assertPublishExecution({
      apiBaseUrl: 'https://api.example', apiToken: 'reconcile-token', signingSecret: 'reconcile-secret', role: 'reconcile',
      event: bindingEvent, fetcher: capturedRequest(captured),
    })
    const target = new URL(captured.url!)
    expect(target.searchParams.get('event_id')).toBe(bindingEvent.id)
    expect(target.searchParams.get('worker_role')).toBe('reconcile')
    // The API verifies x-worker-role against WORKER_API_CREDENTIALS, so the
    // header, the signed role and the bearer token must all be the reconcile
    // worker's own credential set.
    expect(captured.headers!.get('x-worker-role')).toBe('reconcile')
    expect(captured.headers!.get('authorization')).toBe('Bearer reconcile-token')
    const proof = {
      secret: 'reconcile-secret', role: 'reconcile' as const, method: 'GET', requestTarget: `${target.pathname}${target.search}`, workspaceId: bindingEvent.workspaceId,
      timestamp: captured.headers!.get('x-worker-timestamp')!, nonce: captured.headers!.get('x-worker-nonce')!, bodySha256: captured.headers!.get('x-worker-body-sha256')!,
      signature: captured.headers!.get('x-worker-workspace-signature')!,
    }
    expect(verifyWorkerRequestProof(proof)).toBe(true)
    expect(verifyWorkerRequestProof({ ...proof, role: 'publish' })).toBe(false)
  })

  it('keeps the default publish execution check byte-identical', async () => {
    const captured: { url?: string; headers?: Headers } = {}
    await assertPublishExecution({
      apiBaseUrl: 'https://api.example', apiToken: 'publish-token', signingSecret: 'publish-secret',
      event: bindingEvent, fetcher: capturedRequest(captured),
    })
    expect(captured.url).toBe('https://api.example/v1/publish-jobs/job_publish_binding/execution-check?event_id=evt_publish_binding')
    expect(captured.headers!.get('x-worker-role')).toBe('publish')
    expect(captured.headers!.get('authorization')).toBe('Bearer publish-token')
    expect(verifyWorkerRequestProof({
      secret: 'publish-secret', role: 'publish', method: 'GET', requestTarget: '/v1/publish-jobs/job_publish_binding/execution-check?event_id=evt_publish_binding', workspaceId: bindingEvent.workspaceId,
      timestamp: captured.headers!.get('x-worker-timestamp')!, nonce: captured.headers!.get('x-worker-nonce')!, bodySha256: captured.headers!.get('x-worker-body-sha256')!,
      signature: captured.headers!.get('x-worker-workspace-signature')!,
    })).toBe(true)
  })
})

describe('publish execution authorization binding', () => {
  it('sends the durable event id to the publish execution gate', async () => {
    const event: DurableOutboxEvent = {
      id: 'evt_publish_binding', workspaceId: 'ws_publish_binding', aggregateId: 'job_publish_binding',
      eventType: 'publish.requested', sequence: 1, payload: {}, createdAt: new Date().toISOString(),
    }
    let requestedUrl = ''
    await assertPublishExecution({
      apiBaseUrl: 'https://api.example', apiToken: 'worker-token', event,
      fetcher: async (input) => {
        requestedUrl = String(input)
        return new Response(JSON.stringify({ data: { credential_ref: 'vault://merchant/ws_publish_binding/jd', payload_hash: 'a'.repeat(64) } }), { status: 200 })
      },
    })
    expect(new URL(requestedUrl).searchParams.get('event_id')).toBe(event.id)
  })
})
