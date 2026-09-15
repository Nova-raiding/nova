import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createWorkerRequestProof, type WorkerRequestRole } from '../../../packages/security/src/worker-request-proof.js'
import { CUSTOMER_DELIVERY_SCAN_OPERATION } from '../../../packages/workers/src/customer-delivery-scan-admission.js'

const credentials = {
  scan: { token: 'isolated-delivery-scan-token', signing_secret: 'isolated-delivery-scan-secret' },
  generation: { token: 'isolated-delivery-generation-token', signing_secret: 'isolated-delivery-generation-secret' },
}
const workspaceId = 'ws_delivery_scan_boundary'
const workerId = 'delivery-scan-boundary-test'
let base = ''
let server: typeof import('./server.js').server

function target(eventId = `event_${randomUUID()}`) {
  return `/v1/worker-events/${eventId}/execution-check?aggregate_id=asset_delivery_boundary&operation=${CUSTOMER_DELIVERY_SCAN_OPERATION}`
}

function signedHeaders(path: string, role: 'scan' | 'generation' = 'scan') {
  const credential = credentials[role]
  return { authorization: `Bearer ${credential.token}`, 'x-workspace-id': workspaceId,
    ...createWorkerRequestProof({ secret: credential.signing_secret, workerId, role, method: 'GET', requestTarget: path, workspaceId }).headers }
}

async function call(path: string, headers: Record<string, string> = {}) {
  const response = await fetch(`${base}${path}`, { headers })
  return { status: response.status, body: await response.json() as { data: unknown; error: { code: string } | null } }
}

/** Real loopback request authentication. Deliberately no database, scanner,
 * fake clean receipt, or successful admission evidence is supplied here. */
describe('delivery scan signed-worker HTTP boundary', () => {
  beforeAll(async () => {
    for (const key of ['DATABASE_URL', 'OPS_DATABASE_URL', 'REDIS_URL', 'PGHOST', 'ASSET_STORAGE_ENDPOINT']) {
      if (process.env[key]) throw new Error(`Use scripts/run-safe-tests.ts; inherited ${key} is forbidden`)
    }
    vi.stubEnv('NODE_ENV', 'test')
    vi.stubEnv('AUTH_ENFORCEMENT', 'strict')
    vi.stubEnv('WORKER_API_CREDENTIALS', JSON.stringify(credentials))
    vi.stubEnv('ALLOW_LOCAL_ASSET_SCAN_FIXTURE', 'false')
    server = (await import('./server.js')).server
    await new Promise<void>((resolve, reject) => {
      const failed = (error: Error) => reject(error)
      server.once('error', failed)
      server.listen(0, '127.0.0.1', () => { server.removeListener('error', failed); resolve() })
    })
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('loopback API did not bind')
    base = `http://127.0.0.1:${address.port}`
  })

  afterAll(async () => {
    try {
      if (server?.listening) await new Promise<void>(resolve => server.close(() => resolve()))
    } finally { vi.unstubAllEnvs() }
  })

  it('rejects missing credentials', async () => {
    const result = await call(target(), { 'x-workspace-id': workspaceId })
    expect(result.status).toBe(403)
    expect(result.body.error?.code).toBe('FORBIDDEN')
    expect(result.body.data).toBeNull()
  })

  it('rejects a scan token without its request signature', async () => {
    const result = await call(target(), { authorization: `Bearer ${credentials.scan.token}`, 'x-workspace-id': workspaceId, 'x-worker-id': workerId, 'x-worker-role': 'scan' })
    expect(result.status).toBe(403)
    expect(result.body.error?.code).toBe('FORBIDDEN')
  })

  it('rejects a valid signed generation worker despite access to the shared execution-check route', async () => {
    const path = target()
    const result = await call(path, signedHeaders(path, 'generation'))
    expect(result.status).toBe(403)
    expect(result.body.error?.code).toBe('FORBIDDEN')
  })

  it.each(['workspace', 'event', 'aggregate', 'role', 'signature'] as const)('rejects %s tampering after request signing', async field => {
    const path = target()
    const headers = signedHeaders(path)
    let destination = path
    if (field === 'workspace') headers['x-workspace-id'] = 'ws_other'
    if (field === 'event') destination = path.replace(/event_[^/]+/u, 'event_other')
    if (field === 'aggregate') destination = path.replace('asset_delivery_boundary', 'asset_other')
    if (field === 'role') headers['x-worker-role'] = 'generation' as WorkerRequestRole
    if (field === 'signature') headers['x-worker-workspace-signature'] = '0'.repeat(64)
    const result = await call(destination, headers)
    expect(result.status).toBe(403)
    expect(result.body.error?.code).toBe('FORBIDDEN')
  })

  it('requires durable repositories after valid scan authentication and consumes the proof nonce', async () => {
    const path = target()
    const headers = signedHeaders(path)
    const first = await call(path, headers)
    expect(first.status).toBe(503)
    expect(first.body.error?.code).toBe('CUSTOMER_DELIVERY_SCAN_REPOSITORY_UNAVAILABLE')
    expect(first.body.data).toBeNull()
    const replay = await call(path, headers)
    expect(replay.status).toBe(409)
    expect(replay.body.error?.code).toBe('WORKER_NONCE_REPLAY')
  })

  it('never treats a local-auth bypass as verified platform scan authority', async () => {
    vi.stubEnv('AUTH_ENFORCEMENT', 'local')
    try {
      const path = target()
      const result = await call(path, signedHeaders(path))
      expect(result.status).toBe(403)
      expect(result.body.error?.code).toBe('FORBIDDEN')
    } finally { vi.stubEnv('AUTH_ENFORCEMENT', 'strict') }
  })
})
