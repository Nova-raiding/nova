import { createHash } from 'node:crypto'

const HASH = /^[a-f0-9]{64}$/u
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u

export interface PublishReceiptTraceScope {
  workspaceId: string
  taskId: string
  listingId: string
  canonicalProductId: string
  contextHash: string
}

export interface PublishReceiptTraceReceipt {
  receiptId: string
  remoteId: string
  publishedAt: string
  scope: PublishReceiptTraceScope
}

export interface PublishReceiptTraceUsage {
  usageId: string
  providerRequestId: string
  scope: PublishReceiptTraceScope
}

export interface PublishReceiptUsageTrace {
  receipt: PublishReceiptTraceReceipt
  usage?: PublishReceiptTraceUsage
}

export type PublishReceiptTraceErrorCode =
  | 'PUBLISH_RECEIPT_TRACE_SCOPE_INVALID'
  | 'PUBLISH_RECEIPT_TRACE_CONTEXT_MISMATCH'
  | 'PUBLISH_RECEIPT_TRACE_USAGE_MISMATCH'

export class PublishReceiptTraceError extends Error {
  constructor(readonly code: PublishReceiptTraceErrorCode, message: string) {
    super(message)
    this.name = 'PublishReceiptTraceError'
  }
}

const text = (value: unknown) => typeof value === 'string' ? value.normalize('NFKC').trim() : ''
const scopeKey = (scope: PublishReceiptTraceScope) => JSON.stringify({
  workspaceId: text(scope.workspaceId),
  taskId: text(scope.taskId),
  listingId: text(scope.listingId),
  canonicalProductId: text(scope.canonicalProductId),
  contextHash: text(scope.contextHash),
})
const scopeHash = (scope: PublishReceiptTraceScope) => createHash('sha256').update(scopeKey(scope)).digest('hex')

function requireId(value: unknown, field: string) {
  const normalized = text(value)
  if (!ID.test(normalized)) throw new PublishReceiptTraceError('PUBLISH_RECEIPT_TRACE_SCOPE_INVALID', `${field} must be a valid identifier`)
  return normalized
}

function validateScope(scope: PublishReceiptTraceScope): PublishReceiptTraceScope {
  const normalized = {
    workspaceId: requireId(scope?.workspaceId, 'workspaceId'),
    taskId: requireId(scope?.taskId, 'taskId'),
    listingId: requireId(scope?.listingId, 'listingId'),
    canonicalProductId: requireId(scope?.canonicalProductId, 'canonicalProductId'),
    contextHash: text(scope?.contextHash),
  }
  if (!HASH.test(normalized.contextHash)) throw new PublishReceiptTraceError('PUBLISH_RECEIPT_TRACE_SCOPE_INVALID', 'contextHash must be a SHA-256 digest')
  return normalized
}

function sameScope(left: PublishReceiptTraceScope, right: PublishReceiptTraceScope) {
  return scopeKey(left) === scopeKey(right)
}

/**
 * Validate the immutable link between a platform publish receipt and the
 * task/listing/context snapshot that produced it. A usage record, when
 * present, must point at the exact same scope; it is never inferred.
 */
export function validatePublishReceiptUsageTrace(input: PublishReceiptUsageTrace): PublishReceiptUsageTrace & { traceHash: string } {
  if (!input || !input.receipt) throw new PublishReceiptTraceError('PUBLISH_RECEIPT_TRACE_SCOPE_INVALID', 'publish receipt is required')
  const receiptScope = validateScope(input.receipt.scope)
  const receiptId = requireId(input.receipt.receiptId, 'receiptId')
  const remoteId = requireId(input.receipt.remoteId, 'remoteId')
  if (!Number.isFinite(Date.parse(input.receipt.publishedAt))) throw new PublishReceiptTraceError('PUBLISH_RECEIPT_TRACE_SCOPE_INVALID', 'publishedAt must be a valid timestamp')

  let usage: PublishReceiptTraceUsage | undefined
  if (input.usage !== undefined) {
    const usageScope = validateScope(input.usage.scope)
    if (!sameScope(receiptScope, usageScope)) throw new PublishReceiptTraceError('PUBLISH_RECEIPT_TRACE_USAGE_MISMATCH', 'usage scope must exactly match the publish receipt scope')
    const usageId = requireId(input.usage.usageId, 'usageId')
    const providerRequestId = requireId(input.usage.providerRequestId, 'providerRequestId')
    usage = { usageId, providerRequestId, scope: usageScope }
  }

  const receipt = { receiptId, remoteId, publishedAt: new Date(input.receipt.publishedAt).toISOString(), scope: receiptScope }
  const traceHash = createHash('sha256').update(JSON.stringify({ receipt, usage: usage ?? null })).digest('hex')
  return structuredClone({ receipt, ...(usage ? { usage } : {}), traceHash })
}

/** Build a stable digest for the scope used by external receipt envelopes. */
export function publishReceiptScopeHash(scope: PublishReceiptTraceScope) {
  return scopeHash(validateScope(scope))
}
