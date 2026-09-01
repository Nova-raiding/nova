import { describe, expect, it } from 'vitest'
import { createWorkerRequestProof, verifyWorkerRequestProof } from './worker-request-proof.js'

describe('worker request proof', () => {
  const base = { secret: 'role-scoped-secret', role: 'generation' as const, method: 'POST', requestTarget: '/v1/generation-jobs/job_1/result', workspaceId: 'ws_1', body: '{"ok":true}', timestampSeconds: 1_800_000_000, nonce: 'nonce_1234567890123456' }

  it('binds role, route, workspace and exact body', () => {
    const proof = createWorkerRequestProof(base)
    expect(verifyWorkerRequestProof({ ...base, timestamp: proof.timestamp, nonce: proof.nonce, bodySha256: proof.bodySha256, signature: proof.signature, nowSeconds: 1_800_000_000 })).toBe(true)
    expect(verifyWorkerRequestProof({ ...base, role: 'publish', timestamp: proof.timestamp, nonce: proof.nonce, bodySha256: proof.bodySha256, signature: proof.signature, nowSeconds: 1_800_000_000 })).toBe(false)
    expect(verifyWorkerRequestProof({ ...base, body: '{"ok":false}', timestamp: proof.timestamp, nonce: proof.nonce, bodySha256: proof.bodySha256, signature: proof.signature, nowSeconds: 1_800_000_000 })).toBe(false)
  })

  it('rejects expired proofs', () => {
    const proof = createWorkerRequestProof(base)
    expect(verifyWorkerRequestProof({ ...base, timestamp: proof.timestamp, nonce: proof.nonce, bodySha256: proof.bodySha256, signature: proof.signature, nowSeconds: 1_800_000_061 })).toBe(false)
  })

  it('fails closed for malformed runtime verification input', () => {
    const proof = createWorkerRequestProof(base)
    expect(verifyWorkerRequestProof({ ...base, requestTarget: null as unknown as string, timestamp: proof.timestamp, nonce: proof.nonce, bodySha256: proof.bodySha256, signature: proof.signature })).toBe(false)
    expect(verifyWorkerRequestProof({ ...base, secret: null as unknown as string, timestamp: proof.timestamp, nonce: proof.nonce, bodySha256: proof.bodySha256, signature: proof.signature })).toBe(false)
    expect(verifyWorkerRequestProof({ ...base, maxSkewSeconds: Number.NaN, timestamp: proof.timestamp, nonce: proof.nonce, bodySha256: proof.bodySha256, signature: proof.signature })).toBe(false)
  })

  it('rejects control characters and oversized request targets', () => {
    expect(() => createWorkerRequestProof({ ...base, requestTarget: '/v1/jobs\r\nX-Injected: 1' })).toThrow()
    expect(() => createWorkerRequestProof({ ...base, requestTarget: `/${'a'.repeat(2_048)}` })).toThrow()
    const proof = createWorkerRequestProof(base)
    expect(verifyWorkerRequestProof({ ...base, requestTarget: '/v1/jobs\n', timestamp: proof.timestamp, nonce: proof.nonce, bodySha256: proof.bodySha256, signature: proof.signature })).toBe(false)
    expect(verifyWorkerRequestProof({ ...base, requestTarget: `/${'a'.repeat(2_048)}`, timestamp: proof.timestamp, nonce: proof.nonce, bodySha256: proof.bodySha256, signature: proof.signature })).toBe(false)
  })
})
