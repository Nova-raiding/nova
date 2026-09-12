import { createHash } from 'node:crypto'

export type ProviderRequestOutcome = 'unknown' | 'failed'

/**
 * The request may have reached the provider, so callers must not refund or
 * retry it blindly. `providerSucceeded` is the existing server compatibility
 * marker for keeping settlement open until reconciliation proves the outcome.
 */
export class ProviderOutcomeUnknownError extends Error {
  readonly code = 'MODEL_PROVIDER_OUTCOME_UNKNOWN'
  readonly providerOutcome = 'unknown' satisfies ProviderRequestOutcome
  readonly providerSucceeded = true
  readonly reconciliationRequired = true
  readonly retryable = false
  readonly details: Readonly<Record<string, unknown>>

  constructor(
    readonly providerIdempotencyKey: string,
    message: string,
    readonly cause?: unknown,
    readonly status?: number,
    readonly providerRequestId?: string,
    readonly providerErrorSummary?: string,
  ) {
    super(message)
    this.name = 'ProviderOutcomeUnknownError'
    this.details = Object.freeze({
      provider_succeeded: true,
      provider_outcome: 'unknown',
      reconciliation_required: true,
      provider_idempotency_key: providerIdempotencyKey,
      ...(status !== undefined ? { provider_status: status } : {}),
      ...(providerRequestId ? { provider_request_id: providerRequestId } : {}),
      ...(providerErrorSummary ? { provider_error_summary: providerErrorSummary } : {}),
    })
  }
}

export class ProviderRequestFailedError extends Error {
  readonly code = 'MODEL_PROVIDER_REQUEST_FAILED'
  readonly providerOutcome = 'failed' satisfies ProviderRequestOutcome
  readonly providerSucceeded = false
  readonly reconciliationRequired = false
  readonly retryable: boolean
  readonly details: Readonly<Record<string, unknown>>

  constructor(
    readonly providerIdempotencyKey: string,
    readonly status: number,
    message: string,
    readonly providerRequestId?: string,
    readonly providerErrorSummary?: string,
    retryable = false,
    readonly retryAfterMs?: number,
  ) {
    super(message)
    this.name = 'ProviderRequestFailedError'
    this.retryable = retryable
    this.details = Object.freeze({
      provider_succeeded: false,
      provider_outcome: 'failed',
      reconciliation_required: false,
      provider_idempotency_key: providerIdempotencyKey,
      provider_status: status,
      retryable,
      ...(retryAfterMs !== undefined ? { retry_after_ms: retryAfterMs } : {}),
      ...(providerRequestId ? { provider_request_id: providerRequestId } : {}),
      ...(providerErrorSummary ? { provider_error_summary: providerErrorSummary } : {}),
    })
  }
}

const MAX_RETRY_AFTER_MS = 60_000

export interface ProviderRetryOptions {
  /** Total attempts, including the initial request. Never allow unbounded retries. */
  maxAttempts?: number
  /** Injectable for deterministic tests and graceful worker shutdown. */
  wait?: (milliseconds: number, signal?: AbortSignal) => Promise<void>
  random?: () => number
  signal?: AbortSignal
}

const defaultProviderRetryWait = (milliseconds: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal?.aborted) { reject(signal.reason ?? new DOMException('provider retry aborted', 'AbortError')); return }
  const timer = setTimeout(resolve, milliseconds)
  signal?.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason ?? new DOMException('provider retry aborted', 'AbortError')) }, { once: true })
})

/** Retry only explicit failed requests; ambiguous provider outcomes are never replayed. */
export async function withProviderRequestRetry<T>(operation: () => Promise<T>, options: ProviderRetryOptions = {}): Promise<T> {
  const maxAttempts = Math.max(1, Math.min(5, Math.trunc(options.maxAttempts ?? 3)))
  const wait = options.wait ?? defaultProviderRetryWait
  const random = options.random ?? Math.random
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation()
    } catch (error) {
      if (!(error instanceof ProviderRequestFailedError) || !error.retryable || attempt >= maxAttempts) throw error
      const exponentialMs = Math.min(10_000, 250 * (2 ** (attempt - 1)))
      const hintedMs = error.retryAfterMs ?? 0
      const jitterMs = Math.floor(Math.max(exponentialMs, hintedMs) * Math.min(1, Math.max(0, random())))
      await wait(Math.min(MAX_RETRY_AFTER_MS, Math.max(exponentialMs, hintedMs) + jitterMs), options.signal)
    }
  }
}

/** Parse provider backoff hints without allowing an unbounded worker delay. */
export function retryAfterMilliseconds(value: string | null, now = Date.now()): number | undefined {
  if (!value?.trim()) return undefined
  const seconds = Number(value.trim())
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(MAX_RETRY_AFTER_MS, Math.ceil(seconds * 1000))
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) return undefined
  return Math.min(MAX_RETRY_AFTER_MS, Math.max(0, timestamp - now))
}

export function providerIdempotencyKey(input: {
    operation: 'text_generate' | 'image_generate' | 'image_edit' | 'ocr' | 'video_generate'
  model: string
  workspaceId?: string
  actionId?: string
  requestBody: string
}): string {
  const identity = [input.operation, input.model.trim(), input.workspaceId?.trim() ?? '', input.actionId?.trim() ?? '', input.requestBody].join('\u0000')
  return `model_provider_${createHash('sha256').update(identity, 'utf8').digest('hex')}`
}

const AMBIGUOUS_NETWORK_CODES = new Set([
  'ECONNRESET',
  'EPIPE',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET',
])

const errorCode = (value: unknown): string | undefined => {
  if (!value || typeof value !== 'object') return undefined
  const code = (value as { code?: unknown }).code
  return typeof code === 'string' ? code : undefined
}

export function isAmbiguousProviderTransportFailure(error: unknown): boolean {
  if (error instanceof ProviderOutcomeUnknownError) return true
  if (error instanceof TypeError) return true
  if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) return true
  if (AMBIGUOUS_NETWORK_CODES.has(errorCode(error) ?? '')) return true
  return Boolean(error && typeof error === 'object' && AMBIGUOUS_NETWORK_CODES.has(errorCode((error as { cause?: unknown }).cause) ?? ''))
}

export function rethrowProviderTransportFailure(error: unknown, providerKey: string, label: string): never {
  // Preserve the original evidence when a caller has already classified the
  // provider outcome. Re-wrapping here would discard its status and request id
  // and make later reconciliation less reliable.
  if (error instanceof ProviderOutcomeUnknownError) throw error
  if (isAmbiguousProviderTransportFailure(error)) {
    throw new ProviderOutcomeUnknownError(providerKey, `${label} outcome is unknown and requires reconciliation`, error)
  }
  throw error
}

export function throwProviderOutcomeUnknown(providerKey: string, label: string, cause?: unknown): never {
  throw new ProviderOutcomeUnknownError(providerKey, `${label} outcome is unknown and requires reconciliation`, cause)
}

export function assertProviderResponseAccepted(response: Response, providerKey: string, label: string, providerErrorSummary?: string): void {
  if (response.ok) return
  const providerRequestId = [
    response.headers.get('x-oneapi-request-id'),
    response.headers.get('x-request-id'),
    response.headers.get('x-provider-request-id'),
    response.headers.get('request-id'),
  ].find(value => typeof value === 'string' && value.trim() && value.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(value))?.trim()
  if (response.status === 408 || response.status >= 500) {
    throw new ProviderOutcomeUnknownError(providerKey, `${label} returned ambiguous HTTP ${response.status}${providerErrorSummary ? `: ${providerErrorSummary}` : ''}; outcome requires reconciliation`, undefined, response.status, providerRequestId, providerErrorSummary)
  }
  const retryAfterMs = response.status === 429 ? retryAfterMilliseconds(response.headers.get('retry-after')) : undefined
  throw new ProviderRequestFailedError(providerKey, response.status, `${label} returned HTTP ${response.status}${providerErrorSummary ? `: ${providerErrorSummary}` : ''}`, providerRequestId, providerErrorSummary, response.status === 429, retryAfterMs)
}
