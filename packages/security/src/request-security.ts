import { createHash, randomBytes } from 'node:crypto'

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u
const HEX = /^[a-f0-9]{64}$/u

export type RequestCorrelation = {
  requestId: string
  traceId: string
  workspaceId: string
  jobId?: string
  connectorRequestId?: string
  publishReceiptId?: string
}

function id(value: string, field: string): string {
  if (!ID.test(value) || /[\u0000\r\n]/u.test(value)) throw new Error(`invalid ${field}`)
  return value
}

/** Creates the immutable correlation spine used by API, jobs, connectors and receipts. */
export function createRequestCorrelation(input: {
  workspaceId: string
  requestId?: string
  traceId?: string
  jobId?: string
  connectorRequestId?: string
  publishReceiptId?: string
}): RequestCorrelation {
  const result: RequestCorrelation = {
    requestId: id(input.requestId ?? `req_${randomBytes(16).toString('base64url')}`, 'requestId'),
    traceId: id(input.traceId ?? `trace_${randomBytes(16).toString('base64url')}`, 'traceId'),
    workspaceId: id(input.workspaceId, 'workspaceId'),
  }
  for (const [field, value] of Object.entries(input)) {
    if (field === 'workspaceId' || field === 'requestId' || field === 'traceId' || value === undefined) continue
    ;(result as Record<string, string>)[field] = id(value, field)
  }
  return result
}

/** Merges a downstream identifier without allowing a child operation to fork trace/workspace. */
export function attachCorrelation(base: RequestCorrelation, addition: Pick<RequestCorrelation, 'jobId' | 'connectorRequestId' | 'publishReceiptId'>): RequestCorrelation {
  const checked = createRequestCorrelation({ ...base, ...addition })
  if (checked.requestId !== base.requestId || checked.traceId !== base.traceId || checked.workspaceId !== base.workspaceId) throw new Error('correlation identity cannot change')
  return checked
}

export type ReplayDecision = { accepted: boolean; reason?: 'replayed' | 'invalid' }

/**
 * Process-local replay guard for signed internal requests. Callers should use a
 * shared durable implementation in multi-replica deployments; this guard is
 * intentionally bounded and fails closed when its capacity is exhausted.
 */
export class ReplayGuard {
  private readonly entries = new Map<string, number>()
  constructor(private readonly ttlMs = 60_000, private readonly maxEntries = 10_000, private readonly now = () => Date.now()) {
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 || !Number.isSafeInteger(maxEntries) || maxEntries <= 0) throw new Error('replay guard configuration is invalid')
  }

  checkAndRecord(input: { workspaceId: string; nonce: string; fingerprint?: string }): ReplayDecision {
    if (!ID.test(input.workspaceId) || !/^[A-Za-z0-9_-]{16,128}$/u.test(input.nonce) || (input.fingerprint !== undefined && !HEX.test(input.fingerprint))) return { accepted: false, reason: 'invalid' }
    const now = this.now()
    for (const [key, expiresAt] of this.entries) if (expiresAt <= now) this.entries.delete(key)
    const key = `${input.workspaceId}:${input.nonce}`
    if (this.entries.has(key)) return { accepted: false, reason: 'replayed' }
    if (this.entries.size >= this.maxEntries) return { accepted: false, reason: 'invalid' }
    this.entries.set(key, now + this.ttlMs)
    return { accepted: true }
  }

  size(): number { return this.entries.size }
}

const SENSITIVE_KEY = /(?:access|refresh)[_-]?token|client[_-]?secret|app[_-]?secret|authorization|cookie|set-cookie|password|passphrase|private[_-]?key|credential|api[_-]?key|signature|raw[_-]?(?:body|payload|response)|prompt(?:_?text)?/iu
const MAX_DEPTH = 8
const MAX_STRING = 2048

/** Produces audit-safe data without retaining secrets, raw payloads, or unbounded values. */
export function isolateSensitiveFields(value: unknown): unknown {
  const seen = new WeakSet<object>()
  const visit = (current: unknown, depth: number): unknown => {
    if (depth > MAX_DEPTH) return '[TRUNCATED]'
    if (typeof current === 'string') return current.length > MAX_STRING ? `${current.slice(0, MAX_STRING)}...[TRUNCATED]` : current
    if (current === null || typeof current !== 'object') return typeof current === 'bigint' ? current.toString() : current
    if (seen.has(current)) return '[CIRCULAR]'
    seen.add(current)
    if (Array.isArray(current)) return current.slice(0, 100).map(item => visit(item, depth + 1))
    const output: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(current)) output[key] = SENSITIVE_KEY.test(key) ? '[REDACTED]' : visit(child, depth + 1)
    return output
  }
  return visit(value, 0)
}

export function auditPayloadDigest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(isolateSensitiveFields(value))).digest('hex')
}
