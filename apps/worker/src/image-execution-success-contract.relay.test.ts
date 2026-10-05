import { createServer } from 'node:http'
import { once } from 'node:events'
import { describe, expect, it } from 'vitest'
import { closeRejectedImageDispatch, updateImageGenerationExecution } from './main.js'
import { verifyWorkerRequestProof } from '../../../packages/security/src/worker-request-proof.js'
import type { DurableOutboxEvent } from '../../../packages/workers/src/durable.js'
const event: DurableOutboxEvent = { id: 'event_contract', workspaceId: 'ws_contract', aggregateId: 'job_contract', eventType: 'image.generation.requested', sequence: 1, payload: {}, createdAt: new Date().toISOString() }
const bound = { state: 'provider_dispatching', workspaceId: event.workspaceId, jobId: event.aggregateId, eventId: event.id, ownerToken: 'owner_contract', providerOperationKey: 'operation_contract' }
async function request(payload: unknown) {
  let verified = false
  let requests = 0
  const server = createServer(async (req, res) => {
    requests++
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(Buffer.from(chunk))
    const body = Buffer.concat(chunks).toString()
    expect(JSON.parse(body)).toEqual({ operation: 'begin_provider_dispatch', event_id: event.id, owner_token: 'owner_contract' })
    const h = (key: string) => String(req.headers[key] ?? '')
    verified = verifyWorkerRequestProof({ secret: 'isolated-test-signing-secret', workerId: h('x-worker-id'), role: 'generation', method: 'POST', requestTarget: req.url!, workspaceId: event.workspaceId, body, timestamp: h('x-worker-timestamp'), nonce: h('x-worker-nonce'), bodySha256: h('x-worker-body-sha256'), signature: h('x-worker-workspace-signature') }) && !req.headers['x-internal-worker-signing-secret']
    res.writeHead(verified ? 200 : 403, { 'content-type': 'application/json' }); res.end(JSON.stringify(payload))
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const address = server.address() as { port: number }
  try {
    const value = await updateImageGenerationExecution({ apiBaseUrl: `http://127.0.0.1:${address.port}`, apiToken: 'isolated-test-api-token', signingSecret: 'isolated-test-signing-secret', event, operation: 'begin_provider_dispatch', ownerToken: 'owner_contract', expectedProviderOperationKey: 'operation_contract' })
    expect(verified).toBe(true); expect(requests).toBe(1)
    return value
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
}
describe('d44 signed HTTP successful execution response evidence', () => {
  it('accepts the real API execution response shape', async () => { expect(await request({ data: { execution: bound } })).toEqual(bound) })
  it.each([
    ['missing data', {}],
    ['wrong workspace', { data: { execution: { ...bound, workspaceId: 'foreign' } } }],
    ['wrong job', { data: { execution: { ...bound, jobId: 'other_job' } } }],
    ['wrong operation key', { data: { execution: { ...bound, providerOperationKey: 'other_operation' } } }],
    ['missing operation key', { data: { execution: { ...bound, providerOperationKey: '' } } }],
    ['wrong event', { data: { execution: { ...bound, eventId: 'other_event' } } }],
    ['wrong owner', { data: { execution: { ...bound, ownerToken: 'other_owner' } } }],
    ['not dispatched state', { data: { execution: { ...bound, state: 'provider_reserved' } } }],
  ])('must reject %s before caller may proceed', async (_name, payload) => { let error: unknown
    try { await request(payload) } catch (caught) { error = caught }
    expect(error).toMatchObject({ code: 'IMAGE_GENERATION_DISPATCH_RESPONSE_INVALID', reconciliationRequired: true })
    let cleanupRequests = 0
    await expect(closeRejectedImageDispatch({ apiBaseUrl: 'http://127.0.0.1:1', apiToken: 'test', event, ownerToken: 'owner_contract', providerRequests: 0, error, fetcher: async () => { cleanupRequests++; throw new Error('cleanup must not run') } })).rejects.toBe(error)
    expect(cleanupRequests).toBe(0) })
})
