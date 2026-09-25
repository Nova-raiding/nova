import { createHash } from 'node:crypto'

/** Knowledge selected for one immutable generation task snapshot. */
export interface FrozenGenerationKnowledgeDocument {
  id: string
  title: string
  content: string
  revision: number
}

export interface GenerationKnowledgeExecutionReceipt {
  ready: true
  event_id: string
  aggregate_id: string
  workspace_id: string
  task_id: string
  product_id: string
  context_hash: string
  attempt: number
  provider_attempt_key: string
  request_body_sha256: string
  request_nonce: string
  document_count: number
  content_hash: string
  checked_at: string
}

export const MAX_FROZEN_GENERATION_KNOWLEDGE_DOCUMENTS = 8

const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex')

/** Stable digest of the bounded documents actually frozen into the task. */
export function generationKnowledgeReceiptHash(documents: readonly FrozenGenerationKnowledgeDocument[]): string {
  return sha256(JSON.stringify(documents.map(document => ({
    id: document.id,
    revision: document.revision,
    contentHash: sha256(document.content),
  }))))
}

export class GenerationKnowledgeReceiptError extends Error {
  readonly code = 'KNOWLEDGE_EXECUTION_RECHECK_UNAVAILABLE'

  constructor(message: string) {
    super(message)
    this.name = 'GenerationKnowledgeReceiptError'
  }
}

export interface ValidateGenerationKnowledgeReceiptInput {
  receipt: unknown
  eventId: string
  aggregateId: string
  workspaceId: string
  taskId: string
  productId: string
  contextHash: string
  attempt: number
  providerAttemptKey: string
  requestBodySha256: string
  requestNonce: string
  documents: readonly FrozenGenerationKnowledgeDocument[]
  now?: number
}

/**
 * Validate the API's final read receipt against the exact bounded generation
 * snapshot. This is a read-time fence, not a lock: knowledge can still change
 * after the API read and before the provider accepts the request.
 */
export function validateGenerationKnowledgeReceipt(input: ValidateGenerationKnowledgeReceiptInput): GenerationKnowledgeExecutionReceipt {
  const documents = input.documents
  if (!Number.isSafeInteger(input.attempt) || input.attempt < 0 || !/^mm-[a-f0-9]{64}$/u.test(input.providerAttemptKey)
    || !/^[a-f0-9]{64}$/u.test(input.requestBodySha256) || !/^[0-9a-f-]{36}$/iu.test(input.requestNonce)
    || !Array.isArray(documents) || documents.length > MAX_FROZEN_GENERATION_KNOWLEDGE_DOCUMENTS
    || documents.some(document => !document || typeof document.id !== 'string' || !document.id.trim()
      || typeof document.title !== 'string' || typeof document.content !== 'string'
      || !Number.isSafeInteger(document.revision) || document.revision < 1)
    || new Set(documents.map(document => document.id)).size !== documents.length) {
    throw new GenerationKnowledgeReceiptError('generation event has no valid bounded frozen knowledge scope')
  }

  const receipt = input.receipt
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) {
    throw new GenerationKnowledgeReceiptError('signed knowledge execution evidence is missing')
  }
  const value = receipt as Record<string, unknown>
  const checkedAt = typeof value.checked_at === 'string' ? Date.parse(value.checked_at) : Number.NaN
  const now = input.now ?? Date.now()
  if (value.ready !== true || value.event_id !== input.eventId || value.aggregate_id !== input.aggregateId
    || value.workspace_id !== input.workspaceId || value.task_id !== input.taskId || value.product_id !== input.productId
    || value.context_hash !== input.contextHash || value.attempt !== input.attempt
    || value.provider_attempt_key !== input.providerAttemptKey || value.request_body_sha256 !== input.requestBodySha256
    || value.request_nonce !== input.requestNonce || value.document_count !== documents.length
    || value.content_hash !== generationKnowledgeReceiptHash(documents)
    || !Number.isFinite(checkedAt) || checkedAt > now + 5_000 || now - checkedAt > 30_000) {
    throw new GenerationKnowledgeReceiptError('signed knowledge execution evidence is stale or does not bind this event')
  }
  return value as unknown as GenerationKnowledgeExecutionReceipt
}
