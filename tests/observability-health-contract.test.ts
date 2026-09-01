import type { IncomingMessage } from 'node:http'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { buildRequestLogEvent, getRequestCorrelation, serializeRequestLogEvent } from '../apps/api/src/request-observability.js'
import { attachCorrelation, createRequestCorrelation, isolateSensitiveFields } from '../packages/security/src/request-security.js'

const serverSource = readFileSync(new URL('../apps/api/src/server.ts', import.meta.url), 'utf8')

function request(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return { headers: {}, method: 'POST', url: '/mcp?access_token=must-not-log', ...overrides } as IncomingMessage
}

describe('observability and health contracts', () => {
  it('preserves request/trace identity while correlating a downstream job and receipt chain', () => {
    const root = createRequestCorrelation({ workspaceId: 'ws_observability', requestId: 'req_1', traceId: 'trace_1' })
    const withJob = attachCorrelation(root, { jobId: 'job_1' })
    const withConnector = attachCorrelation(withJob, { connectorRequestId: 'provider_req_1' })
    const withReceipt = attachCorrelation(withConnector, { publishReceiptId: 'receipt_1' })

    expect(withReceipt).toMatchObject({ requestId: 'req_1', traceId: 'trace_1', workspaceId: 'ws_observability', jobId: 'job_1', connectorRequestId: 'provider_req_1', publishReceiptId: 'receipt_1' })
    expect(() => attachCorrelation(withReceipt, { jobId: 'job/other' })).toThrow(/jobId/u)

    const incoming = request({ headers: { 'x-request-id': 'req_1', 'x-trace-id': 'trace_1' } })
    const event = JSON.parse(serializeRequestLogEvent(buildRequestLogEvent(incoming, 'request.completed', { workspaceId: 'ws_observability', taskId: 'task_1', status: 200 }))) as Record<string, unknown>
    expect(event).toMatchObject({ request_id: 'req_1', trace_id: 'trace_1', workspace_id: 'ws_observability', task_id: 'task_1', status: 200 })
    expect(getRequestCorrelation(incoming)).toEqual({ requestId: 'req_1', traceId: 'trace_1' })
  })

  it('keeps credentials, raw payloads and sensitive nested evidence out of logs and audit projections', () => {
    const incoming = request({
      headers: { authorization: 'Bearer header-secret', cookie: 'session=cookie-secret', 'x-request-id': 'safe-request' },
    })
    const serialized = serializeRequestLogEvent(buildRequestLogEvent(incoming, 'request.received', {
      workspaceId: 'ws_safe', actorId: 'actor_safe', authorizationReason: 'AUTHZ_SCOPE_MISMATCH',
      workerBodySha256: 'a'.repeat(64),
    }))
    const isolated = isolateSensitiveFields({ authorization: 'Bearer body-secret', raw_payload: { prompt: 'private prompt' }, nested: { api_key: 'key-secret', safe: 'ok' } })

    expect(serialized).not.toMatch(/header-secret|cookie-secret|access_token|must-not-log|body-secret|private prompt/u)
    expect(isolated).toEqual({ authorization: '[REDACTED]', raw_payload: '[REDACTED]', nested: { api_key: '[REDACTED]', safe: 'ok' } })
  })

  it('requires health and readiness to report dependency failures as non-healthy', () => {
    const health = serverSource.slice(serverSource.indexOf("if (req.method === 'GET' && (path === '/healthz' || path === '/readyz'))"), serverSource.indexOf("if (req.method === 'POST' && path === '/v1/internal/automation/tick')"))
    expect(health).toContain("if (persistenceError) return send(res, 503")
    expect(health).toContain("return send(res, 503, 'system', { ...runtimeHealth(), persistence: { mode: persistence.mode, ready: false } }")
    expect(health).toContain("{ code: 'REDIS_UNAVAILABLE'")
    expect(health).toContain("'SCANNER_NOT_READY'")
    expect(health).toContain("return send(res, 200, 'system'")

    const databaseCheck = health.indexOf('await persistenceReady')
    const redisCheck = health.indexOf('await redisHealth.ping()')
    const success = health.indexOf("return send(res, 200, 'system'")
    expect(databaseCheck).toBeGreaterThanOrEqual(0)
    expect(redisCheck).toBeGreaterThan(databaseCheck)
    expect(success).toBeGreaterThan(redisCheck)
    expect(health.indexOf("persistence: { mode: persistence.mode, ready: false }")).toBeLessThan(success)
  })

  it('keeps request observation terminal events singular and status-derived', () => {
    const observation = serverSource.slice(serverSource.indexOf('function completeRequestObservation'), serverSource.indexOf('function requestId'))
    expect(observation).toContain('if (!state || state.failed) return')
    expect(observation).toContain('if (res.statusCode >= 400)')
    expect(observation).toContain("failRequestObservation(req, res.statusCode")
    expect(observation).toContain("writeRequestObservation(req, 'request.completed'")
  })
})
