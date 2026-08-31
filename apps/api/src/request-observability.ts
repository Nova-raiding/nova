import { randomUUID } from 'node:crypto'
import type { IncomingMessage } from 'node:http'

export type RequestLogEvent = 'request.received' | 'request.completed' | 'request.failed'

export interface RequestCorrelation {
  readonly requestId: string
  readonly traceId: string
}

export interface RequestLogInput {
  workspaceId?: unknown
  taskId?: unknown
  attempt?: unknown
  platform?: unknown
  accountId?: unknown
  actorId?: unknown
  method?: unknown
  route?: unknown
  status?: unknown
  durationMs?: unknown
  errorCode?: unknown
  authorizationDecisionId?: unknown
  authorizationPolicyVersion?: unknown
  authorizationMode?: unknown
  authorizationResult?: unknown
  authorizationReason?: unknown
  authorizationCapability?: unknown
  workerRole?: unknown
  workerCredentialSlot?: unknown
  workerProofTimestamp?: unknown
  workerBodySha256?: unknown
  workerNonceSha256?: unknown
  workerVerifiedAt?: unknown
}

export interface RequestLogContext {
  event: RequestLogEvent
  request_id: string
  trace_id: string
  workspace_id: string | null
  task_id: string | null
  attempt: number | null
  platform: string | null
  account_id: string | null
  actor_id: string | null
  method: string | null
  route: string | null
  status: number | null
  duration_ms: number | null
  error_code: string | null
  authz_decision_id: string | null
  authz_policy_version: string | null
  authz_mode: string | null
  authz_result: string | null
  authz_reason: string | null
  authz_capability: string | null
  worker_role: string | null
  worker_credential_slot: string | null
  worker_proof_timestamp: number | null
  worker_body_sha256: string | null
  worker_nonce_sha256: string | null
  worker_verified_at: string | null
}

const MAX_CORRELATION_ID_LENGTH = 128
const correlationByRequest = new WeakMap<IncomingMessage, RequestCorrelation>()

export function getRequestCorrelation(request: IncomingMessage): RequestCorrelation {
  const memoized = correlationByRequest.get(request)
  if (memoized) return memoized

  const requestId = normalizedHeaderId(request.headers['x-request-id']) ?? `req_${randomUUID()}`
  const traceId = normalizedHeaderId(request.headers['x-trace-id']) ?? requestId
  const correlation = Object.freeze({ requestId, traceId })
  correlationByRequest.set(request, correlation)
  return correlation
}

export function buildRequestLogEvent(request: IncomingMessage, event: RequestLogEvent, input: RequestLogInput = {}): RequestLogContext {
  const correlation = getRequestCorrelation(request)
  return Object.freeze({
    event,
    request_id: correlation.requestId,
    trace_id: correlation.traceId,
    workspace_id: safeText(input.workspaceId),
    task_id: safeText(input.taskId),
    attempt: safeInteger(input.attempt, 0),
    platform: safeText(input.platform, 64),
    account_id: safeText(input.accountId),
    actor_id: safeText(input.actorId),
    method: safeMethod(input.method) ?? safeMethod(request.method),
    route: safeRoute(input.route) ?? routeFromRequest(request),
    status: safeInteger(input.status, 100, 599),
    duration_ms: safeDuration(input.durationMs),
    error_code: safeCode(input.errorCode),
    authz_decision_id: safeCode(input.authorizationDecisionId),
    authz_policy_version: safeCode(input.authorizationPolicyVersion),
    authz_mode: safeCode(input.authorizationMode),
    authz_result: safeCode(input.authorizationResult),
    authz_reason: safeCode(input.authorizationReason),
    authz_capability: safeCode(input.authorizationCapability),
    worker_role: safeCode(input.workerRole),
    worker_credential_slot: safeCode(input.workerCredentialSlot),
    worker_proof_timestamp: safeInteger(input.workerProofTimestamp, 0),
    worker_body_sha256: safeDigest(input.workerBodySha256),
    worker_nonce_sha256: safeDigest(input.workerNonceSha256),
    worker_verified_at: safeIsoTimestamp(input.workerVerifiedAt),
  })
}

export function serializeRequestLogEvent(context: RequestLogContext): string {
  return JSON.stringify(context)
}

function normalizedHeaderId(value: string | string[] | undefined): string | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.normalize('NFKC').trim()
  if (!normalized || normalized.length > MAX_CORRELATION_ID_LENGTH) return undefined
  if (/[^A-Za-z0-9._:/-]/u.test(normalized)) return undefined
  return normalized
}

function safeText(value: unknown, maxLength = 128): string | null {
  if (typeof value !== 'string') return null
  const normalized = value.normalize('NFKC').trim()
  if (!normalized || normalized.length > maxLength || /[\u0000-\u001F\u007F]/u.test(normalized)) return null
  return normalized
}

function safeMethod(value: unknown): string | null {
  const method = safeText(value, 24)?.toUpperCase()
  return method && /^[A-Z][A-Z0-9-]*$/u.test(method) ? method : null
}

function safeRoute(value: unknown): string | null {
  const route = safeText(value, 512)
  if (!route || !route.startsWith('/') || route.includes('?') || route.includes('#')) return null
  return route
}

function routeFromRequest(request: IncomingMessage): string | null {
  if (!request.url) return null
  try {
    return safeRoute(new URL(request.url, 'http://request.local').pathname)
  } catch {
    return null
  }
}

function safeInteger(value: unknown, minimum: number, maximum = Number.MAX_SAFE_INTEGER): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum ? value : null
}

function safeDuration(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value * 1000) / 1000 : null
}

function safeCode(value: unknown): string | null {
  const code = safeText(value, 128)
  return code && /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/u.test(code) ? code : null
}

function safeDigest(value: unknown): string | null {
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value) ? value : null
}

function safeIsoTimestamp(value: unknown): string | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) return null
  return Number.isFinite(Date.parse(value)) ? value : null
}
