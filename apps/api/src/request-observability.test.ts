import type { IncomingMessage } from 'node:http'
import { describe, expect, it } from 'vitest'
import { buildRequestLogEvent, getRequestCorrelation, serializeRequestLogEvent, type RequestLogInput } from './request-observability.js'

function request(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    headers: {},
    method: 'GET',
    url: '/',
    ...overrides,
  } as IncomingMessage
}

describe('request observability', () => {
  it('memoizes stable generated request and trace ids on the same IncomingMessage', () => {
    const incoming = request()
    const first = getRequestCorrelation(incoming)
    incoming.headers['x-request-id'] = 'changed_after_first_read'
    const second = getRequestCorrelation(incoming)

    expect(second).toBe(first)
    expect(first.requestId).toMatch(/^req_[0-9a-f-]{36}$/u)
    expect(first.traceId).toBe(first.requestId)
  })

  it('accepts, trims and NFKC-normalizes safe correlation headers', () => {
    const incoming = request({ headers: { 'x-request-id': '  request-123  ', 'x-trace-id': 'ＴＲＡＣＥ－456' } })
    expect(getRequestCorrelation(incoming)).toEqual({ requestId: 'request-123', traceId: 'TRACE-456' })
  })

  it.each([
    ['CRLF', 'attacker\r\nforged-log:true'],
    ['overlong', 'x'.repeat(129)],
  ])('rejects a malicious %s correlation header instead of reflecting it', (_label, malicious) => {
    const incoming = request({ headers: { 'x-request-id': malicious, 'x-trace-id': malicious } })
    const correlation = getRequestCorrelation(incoming)
    const serialized = serializeRequestLogEvent(buildRequestLogEvent(incoming, 'request.received'))

    expect(correlation.requestId).toMatch(/^req_[0-9a-f-]{36}$/u)
    expect(correlation.traceId).toBe(correlation.requestId)
    expect(serialized).not.toContain(malicious)
    expect(serialized).not.toContain('forged-log')
  })

  it('builds a completed event with every required field and explicit nulls', () => {
    const incoming = request({
      headers: { 'x-request-id': 'req-client', 'x-trace-id': 'trace-client' },
      method: 'post',
      url: '/v1/tasks/task-1?token=must-not-leak',
    })
    const event = buildRequestLogEvent(incoming, 'request.completed', {
      workspaceId: 'workspace-1',
      taskId: 'task-1',
      attempt: 2,
      platform: 'taobao',
      status: 201,
      durationMs: 12.3456,
    })

    expect(event).toEqual({
      event: 'request.completed',
      request_id: 'req-client',
      trace_id: 'trace-client',
      workspace_id: 'workspace-1',
      task_id: 'task-1',
      attempt: 2,
      platform: 'taobao',
      account_id: null,
      actor_id: null,
      method: 'POST',
      route: '/v1/tasks/task-1',
      status: 201,
      duration_ms: 12.346,
      error_code: null,
      authz_decision_id: null,
      authz_policy_version: null,
      authz_mode: null,
      authz_result: null,
      authz_reason: null,
      authz_capability: null,
      worker_role: null,
      worker_credential_slot: null,
      worker_proof_timestamp: null,
      worker_body_sha256: null,
      worker_nonce_sha256: null,
      worker_verified_at: null,
    })
  })

  it('builds a structured failed event', () => {
    const incoming = request({ headers: { 'x-request-id': 'req-error' }, method: 'PATCH', url: '/v1/tasks/task-9' })
    expect(buildRequestLogEvent(incoming, 'request.failed', {
      workspaceId: 'workspace-9', taskId: 'task-9', accountId: 'store-3', actorId: 'actor-7', platform: 'douyin', attempt: 3, status: 503, durationMs: 91, errorCode: 'UPSTREAM_TIMEOUT',
    })).toEqual({
      event: 'request.failed',
      request_id: 'req-error',
      trace_id: 'req-error',
      workspace_id: 'workspace-9',
      task_id: 'task-9',
      attempt: 3,
      platform: 'douyin',
      account_id: 'store-3',
      actor_id: 'actor-7',
      method: 'PATCH',
      route: '/v1/tasks/task-9',
      status: 503,
      duration_ms: 91,
      error_code: 'UPSTREAM_TIMEOUT',
      authz_decision_id: null,
      authz_policy_version: null,
      authz_mode: null,
      authz_result: null,
      authz_reason: null,
      authz_capability: null,
      worker_role: null,
      worker_credential_slot: null,
      worker_proof_timestamp: null,
      worker_body_sha256: null,
      worker_nonce_sha256: null,
      worker_verified_at: null,
    })
  })

  it('uses an output whitelist and never serializes credentials, cookies, tokens or bodies', () => {
    const incoming = request({
      headers: {
        authorization: 'Bearer header-secret',
        cookie: 'session=cookie-secret',
        'x-request-id': 'safe-request',
      },
      method: 'POST',
      url: '/mcp?access_token=query-secret',
    })
    const unsafeInput = {
      workspaceId: 'workspace-safe',
      authorization: 'Bearer input-secret',
      cookie: 'input-cookie-secret',
      token: 'input-token-secret',
      body: { password: 'body-secret' },
    } as RequestLogInput & Record<string, unknown>
    const serialized = serializeRequestLogEvent(buildRequestLogEvent(incoming, 'request.received', unsafeInput))

    expect(JSON.parse(serialized)).toMatchObject({ workspace_id: 'workspace-safe', route: '/mcp' })
    for (const secret of ['header-secret', 'cookie-secret', 'query-secret', 'input-secret', 'input-cookie-secret', 'input-token-secret', 'body-secret']) {
      expect(serialized).not.toContain(secret)
    }
    expect(Object.keys(JSON.parse(serialized) as object)).toEqual([
      'event', 'request_id', 'trace_id', 'workspace_id', 'task_id', 'attempt', 'platform', 'account_id', 'actor_id', 'method', 'route', 'status', 'duration_ms', 'error_code', 'authz_decision_id', 'authz_policy_version', 'authz_mode', 'authz_result', 'authz_reason', 'authz_capability', 'worker_role', 'worker_credential_slot', 'worker_proof_timestamp', 'worker_body_sha256', 'worker_nonce_sha256', 'worker_verified_at',
    ])
  })

  it('records bounded authorization decision evidence without principal claims or request content', () => {
    const incoming = request({ headers: { 'x-request-id': 'req-authz' }, method: 'POST', url: '/mcp' })
    expect(buildRequestLogEvent(incoming, 'request.completed', {
      authorizationDecisionId: 'authz_123', authorizationPolicyVersion: '2026-08-31.v1', authorizationMode: 'enforce', authorizationResult: 'deny', authorizationReason: 'AUTHZ_SCOPE_MISMATCH', authorizationCapability: 'identity.update',
    })).toMatchObject({
      authz_decision_id: 'authz_123', authz_policy_version: '2026-08-31.v1', authz_mode: 'enforce', authz_result: 'deny', authz_reason: 'AUTHZ_SCOPE_MISMATCH', authz_capability: 'identity.update',
    })
  })

  it('records only bounded worker proof evidence and hashes the nonce before logging', () => {
    const incoming = request({ method: 'POST', url: '/v1/internal/automation/tick' })
    const bodySha256 = 'a'.repeat(64)
    const nonceSha256 = 'b'.repeat(64)
    const event = buildRequestLogEvent(incoming, 'request.completed', {
      workerRole: 'automation', workerCredentialSlot: 'rotation', workerProofTimestamp: 1_777_777_777,
      workerBodySha256: bodySha256, workerNonceSha256: nonceSha256, workerVerifiedAt: '2026-08-31T08:09:10.123Z',
    })

    expect(event).toMatchObject({
      worker_role: 'automation', worker_credential_slot: 'rotation', worker_proof_timestamp: 1_777_777_777,
      worker_body_sha256: bodySha256, worker_nonce_sha256: nonceSha256, worker_verified_at: '2026-08-31T08:09:10.123Z',
    })
  })
})
