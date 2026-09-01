import { describe, expect, it } from 'vitest'
import { attachCorrelation, auditPayloadDigest, createRequestCorrelation, isolateSensitiveFields, ReplayGuard } from './request-security.js'

describe('request correlation and audit evidence', () => {
  it('keeps one request/trace/workspace spine while attaching downstream identifiers', () => {
    const root = createRequestCorrelation({ workspaceId: 'ws_1', requestId: 'req_1', traceId: 'trace_1' })
    expect(attachCorrelation(root, { jobId: 'job_1', connectorRequestId: 'remote_1' })).toMatchObject({ ...root, jobId: 'job_1', connectorRequestId: 'remote_1' })
    expect(() => createRequestCorrelation({ workspaceId: 'ws_1', requestId: 'req\n1' })).toThrow(/requestId/)
    expect(() => attachCorrelation(root, { jobId: '../other' })).toThrow(/jobId/)
  })

  it('rejects a nonce replay, expires entries, and bounds memory', () => {
    let now = 1_000
    const guard = new ReplayGuard(100, 1, () => now)
    expect(guard.checkAndRecord({ workspaceId: 'ws_1', nonce: 'nonce_1234567890123456' }).accepted).toBe(true)
    expect(guard.checkAndRecord({ workspaceId: 'ws_1', nonce: 'nonce_1234567890123456' })).toEqual({ accepted: false, reason: 'replayed' })
    expect(guard.checkAndRecord({ workspaceId: 'ws_2', nonce: 'nonce_1234567890123456' })).toEqual({ accepted: false, reason: 'invalid' })
    now = 1_101
    expect(guard.checkAndRecord({ workspaceId: 'ws_2', nonce: 'nonce_1234567890123456' }).accepted).toBe(true)
    expect(guard.checkAndRecord({ workspaceId: 'ws_1', nonce: 'short' })).toEqual({ accepted: false, reason: 'invalid' })
  })

  it('isolates secrets, raw payloads, circular values and oversized strings', () => {
    const value: Record<string, unknown> = { authorization: 'Bearer secret', nested: { api_key: 'key', safe: 'ok' }, raw_payload: { pii: 'do not retain' }, long: 'x'.repeat(2050) }
    value.self = value
    expect(isolateSensitiveFields(value)).toEqual({ authorization: '[REDACTED]', nested: { api_key: '[REDACTED]', safe: 'ok' }, raw_payload: '[REDACTED]', long: `${'x'.repeat(2048)}...[TRUNCATED]`, self: '[CIRCULAR]' })
    expect(auditPayloadDigest(value)).toMatch(/^[a-f0-9]{64}$/u)
  })
})
