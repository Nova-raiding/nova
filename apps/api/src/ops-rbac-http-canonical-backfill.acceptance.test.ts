import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { server, setAuthorizationRepositoryForTests } from './server.js'
import { AUTHZ_POLICY_VERSION } from '../../../packages/contracts/src/authz.js'

type Envelope = {
  request_id?: string
  trace_id?: string
  data: { result: unknown } | null
  error: { code: string; details?: Record<string, unknown> } | null
}

async function start() {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error)
    server.once('error', onError)
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', onError)
      resolve()
    })
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('server did not bind')
  return `http://127.0.0.1:${address.port}`
}

beforeEach(() => {
  vi.stubEnv('NODE_ENV', 'production')
  vi.stubEnv('SESSION_ID_HASH_SECRET', 'ops-rbac-canonical-backfill-secret')
  vi.stubEnv('API_RATE_LIMIT_PER_MINUTE', '10000')
})

afterEach(async () => {
  if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()))
  setAuthorizationRepositoryForTests(undefined)
  vi.unstubAllEnvs()
})

describe('Ops RBAC real HTTP canonical backfill route', () => {
  it('allows platform operations before batch handling and denies a workspace operator', async () => {
    const workspaceId = `ws_ops_http_backfill_${Date.now()}`
    const allowedActorId = `ops-http-backfill-allowed-${Date.now()}`
    const deniedActorId = `ops-http-backfill-denied-${Date.now()}`
    vi.stubEnv('API_AUTH_TOKENS', JSON.stringify({
      'ops-http-backfill-allowed-token': { workspaces: [workspaceId], actor_id: allowedActorId, roles: ['platform_ops'], workbenches: ['platform'] },
      'ops-http-backfill-denied-token': { workspaces: [workspaceId], actor_id: deniedActorId, roles: ['merchant_admin'], workbenches: ['workspace'] },
    }))
    const base = await start()
    const path = `${base}/v1/canonical-backfill/conflicts/scan`
    const body = JSON.stringify({ workspace_id: workspaceId, audit_batch_id: 'missing-local-batch', reason: 'HTTP acceptance authorization probe' })

    const allowedResponse = await fetch(path, {
      method: 'POST',
      headers: { authorization: 'Bearer ops-http-backfill-allowed-token', 'content-type': 'application/json', 'x-workspace-id': workspaceId, 'x-ops-workbench': 'platform' },
      body,
    })
    const allowedBody = await allowedResponse.json() as Envelope
    // The request passed the shared HTTP/MCP authorization boundary and then
    // reached the deterministic missing-batch business precondition.
    expect(allowedResponse.status).toBe(404)
    expect(allowedBody.data).toBeNull()
    expect(allowedBody.error).toMatchObject({ code: 'CANONICAL_BACKFILL_RUN_NOT_FOUND' })
    expect(allowedBody.request_id).toMatch(/^req_/)
    expect(allowedBody.trace_id).toBe(allowedBody.request_id)

    const deniedResponse = await fetch(path, {
      method: 'POST',
      headers: { authorization: 'Bearer ops-http-backfill-denied-token', 'content-type': 'application/json', 'x-workspace-id': workspaceId, 'x-ops-workbench': 'workspace' },
      body,
    })
    const deniedBody = await deniedResponse.json() as Envelope
    expect(deniedResponse.status).toBe(403)
    expect(deniedBody.data).toBeNull()
    expect(deniedBody.error).toMatchObject({
      code: 'FORBIDDEN',
      details: { reason_code: 'AUTHZ_WORKBENCH_MISMATCH', decision_id: expect.any(String), policy_version: AUTHZ_POLICY_VERSION },
    })
    expect(deniedBody.error?.details).not.toHaveProperty('audit_batch_id')
    expect(deniedBody.error?.details).not.toHaveProperty('workspace_id')
    expect(deniedBody.request_id).toMatch(/^req_/)
    expect(deniedBody.trace_id).toBe(deniedBody.request_id)
  })
})
