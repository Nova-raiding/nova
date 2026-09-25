import { randomUUID } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ApiEnvelope } from '../../../packages/contracts/src/index.js'
import { getRequestCorrelation, type RequestLogInput } from './request-observability.js'

export function createHttpResponseHelpers(deps: {
  enrichRequestObservation: (req: IncomingMessage, input: RequestLogInput) => void
  trustedRequestObservationActor: (req: IncomingMessage) => string | undefined
  isObject: (value: unknown) => value is Record<string, unknown>
  header: (req: IncomingMessage, name: string) => string | undefined
  requiresStrictAuth: () => boolean
}) {
  function requestId(req?: IncomingMessage) {
    return req ? getRequestCorrelation(req).requestId : `req_${randomUUID()}`
  }

  function send<T>(res: ServerResponse, status: number, workspaceId: string, data: T | null, error: ApiEnvelope<T>['error'] = null, req?: IncomingMessage) {
    const id = requestId(req)
    const traceId = req ? getRequestCorrelation(req).traceId : id
    if (req) deps.enrichRequestObservation(req, { workspaceId, status, actorId: deps.trustedRequestObservationActor(req), ...(error ? { errorCode: error.code } : {}) })
    const envelope: ApiEnvelope<T> = {
      request_id: id,
      trace_id: traceId as never,
      workspace_id: workspaceId as never,
      data: error ? null : data,
      warnings: [],
      next_actions: error && deps.isObject(error.details) && Array.isArray(error.details.next_actions) ? error.details.next_actions : [],
      error,
    }
    res.statusCode = status
    res.setHeader('content-type', 'application/json; charset=utf-8')
    const origin = deps.header(req ?? ({} as IncomingMessage), 'origin')
    const configuredOrigins = (process.env.ALLOWED_ORIGINS ?? process.env.ALLOWED_ORIGIN ?? (deps.requiresStrictAuth() ? '' : '*'))
      .split(',').map(value => value.trim()).filter(Boolean)
    const exactOriginAllowed = Boolean(origin && configuredOrigins.includes(origin))
    if (configuredOrigins.includes('*')) res.setHeader('access-control-allow-origin', '*')
    else if (exactOriginAllowed) {
      res.setHeader('access-control-allow-origin', origin!)
      res.setHeader('access-control-allow-credentials', 'true')
      res.setHeader('vary', 'Origin')
    }
    res.setHeader('access-control-allow-headers', 'authorization, content-type, idempotency-key, x-workspace-id, x-ops-workbench, x-account-id, x-actor-id, x-request-id, x-trace-id, x-role, x-rule-approval-token, x-authorization-approval-token')
    res.setHeader('access-control-allow-methods', 'DELETE,GET,POST,PUT,OPTIONS')
    res.setHeader('access-control-expose-headers', 'x-request-id, x-trace-id')
    res.setHeader('x-request-id', id)
    res.setHeader('x-trace-id', traceId)
    res.end(JSON.stringify(envelope))
  }

  function sendNativeMcp(res: ServerResponse, status: number, payload: unknown, req?: IncomingMessage) {
    const id = requestId(req)
    const traceId = req ? getRequestCorrelation(req).traceId : id
    res.statusCode = status
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.setHeader('x-request-id', id)
    res.setHeader('x-trace-id', traceId)
    res.end(JSON.stringify(payload))
  }


  return { requestId, send, sendNativeMcp }
}
