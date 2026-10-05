import { describe, expect, it, vi } from 'vitest'
import { handleHttpHealthRoute, type HttpHealthRouteDependencies } from './http-health-routes.js'
import type { IncomingMessage, ServerResponse } from 'node:http'

function fixture() {
  const send = vi.fn(), fail = vi.fn()
  const attestation = vi.fn(async () => ({ instanceId: 'api-instance', salesProtocol: 'commercial.sales.v3', manifestSha256: 'a'.repeat(64), schemaSha256: 'b'.repeat(64) }))
  const deps = { send, fail, commercialRuntimeAttestation: attestation } as unknown as HttpHealthRouteDependencies
  const req = { method: 'GET' } as IncomingMessage, res = {} as ServerResponse
  return { send, fail, attestation, deps, req, res }
}

describe('commercial runtime identity probe', () => {
  it('exposes only the observed protocol and runtime identity', async () => {
    const f = fixture()
    expect(await handleHttpHealthRoute(f.req, f.res, '/internal/commercial-runtime-attestation', f.deps)).toBe(true)
    expect(f.send).toHaveBeenCalledWith(f.res, 200, 'system', { instanceId: 'api-instance', salesProtocol: 'commercial.sales.v3', manifestSha256: 'a'.repeat(64), schemaSha256: 'b'.repeat(64) }, null, f.req)
  })
  it('fails closed on missing or invalid live database evidence', async () => {
    const f = fixture()
    f.attestation.mockRejectedValue(new Error('live schema differs'))
    await handleHttpHealthRoute(f.req, f.res, '/internal/commercial-runtime-attestation', f.deps)
    expect(f.send).not.toHaveBeenCalled()
    expect(f.fail).toHaveBeenCalledWith(f.res, 503, 'system', 'COMMERCIAL_RUNTIME_ATTESTATION_UNAVAILABLE', expect.any(String), f.req)
  })
})
