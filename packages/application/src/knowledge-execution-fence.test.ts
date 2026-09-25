import { describe, expect, it } from 'vitest'
import {
  generationKnowledgeReceiptHash,
  MAX_FROZEN_GENERATION_KNOWLEDGE_DOCUMENTS,
  validateGenerationKnowledgeReceipt,
  type FrozenGenerationKnowledgeDocument,
} from './knowledge-execution-fence.js'

const now = Date.parse('2026-09-25T12:00:00.000Z')
const documents: FrozenGenerationKnowledgeDocument[] = [
  { id: 'doc-a', title: '材质信息', content: '面料为棉', revision: 3 },
  { id: 'doc-b', title: '规格', content: '容量为 500ml', revision: 1 },
]

function receipt(overrides: Record<string, unknown> = {}) {
  return {
    ready: true,
    event_id: 'event-1',
    aggregate_id: 'generation-1',
    workspace_id: 'workspace-1',
    task_id: 'task-1',
    product_id: 'product-1',
    context_hash: 'a'.repeat(64),
    attempt: 0,
    provider_attempt_key: `mm-${'b'.repeat(64)}`,
    request_body_sha256: 'c'.repeat(64),
    request_nonce: '12345678-1234-4abc-8def-123456789abc',
    document_count: documents.length,
    content_hash: generationKnowledgeReceiptHash(documents),
    checked_at: new Date(now).toISOString(),
    ...overrides,
  }
}

function validate(documentsInput = documents, receiptInput: unknown = receipt()) {
  return validateGenerationKnowledgeReceipt({
    receipt: receiptInput,
    eventId: 'event-1',
    aggregateId: 'generation-1',
    workspaceId: 'workspace-1',
    taskId: 'task-1',
    productId: 'product-1',
    contextHash: 'a'.repeat(64),
    attempt: 0,
    providerAttemptKey: `mm-${'b'.repeat(64)}`,
    requestBodySha256: 'c'.repeat(64),
    requestNonce: '12345678-1234-4abc-8def-123456789abc',
    documents: documentsInput,
    now,
  })
}

describe('generation knowledge execution receipt', () => {
  it('accepts an empty frozen scope and a fresh receipt bound to that exact scope', () => {
    expect(validate([] as FrozenGenerationKnowledgeDocument[], receipt({ document_count: 0, content_hash: generationKnowledgeReceiptHash([]) })))
      .toMatchObject({ ready: true, document_count: 0 })
    expect(validate()).toMatchObject({ ready: true, event_id: 'event-1', task_id: 'task-1' })
  })

  it('hashes only the bounded snapshot, even when the product has more knowledge documents', () => {
    const selected = Array.from({ length: MAX_FROZEN_GENERATION_KNOWLEDGE_DOCUMENTS }, (_, index) => ({
      id: `doc-${index}`,
      title: `知识 ${index}`,
      content: `内容 ${index}`,
      revision: 1,
    }))
    const signed = receipt({ document_count: selected.length, content_hash: generationKnowledgeReceiptHash(selected) })
    expect(validate(selected, signed)).toMatchObject({ document_count: selected.length })
    // Documents outside this task snapshot are intentionally not part of the
    // receipt contract; products can have more records than the selected 8.
  })

  it('rejects snapshots beyond the generation context bound and duplicate document identities', () => {
    const tooMany = Array.from({ length: MAX_FROZEN_GENERATION_KNOWLEDGE_DOCUMENTS + 1 }, (_, index) => ({ id: `doc-${index}`, title: 't', content: 'c', revision: 1 }))
    expect(() => validate(tooMany, receipt({ document_count: tooMany.length, content_hash: generationKnowledgeReceiptHash(tooMany) })))
      .toThrow(expect.objectContaining({ code: 'KNOWLEDGE_EXECUTION_RECHECK_UNAVAILABLE' }))
    expect(() => validate([documents[0]!, documents[0]!], receipt()))
      .toThrow(expect.objectContaining({ code: 'KNOWLEDGE_EXECUTION_RECHECK_UNAVAILABLE' }))
  })

  it.each([
    ['event binding', { event_id: 'event-other' }],
    ['workspace binding', { workspace_id: 'workspace-other' }],
    ['product binding', { product_id: 'product-other' }],
    ['context binding', { context_hash: 'b'.repeat(64) }],
    ['attempt binding', { attempt: 1 }],
    ['provider attempt binding', { provider_attempt_key: `mm-${'d'.repeat(64)}` }],
    ['request body binding', { request_body_sha256: 'd'.repeat(64) }],
    ['request nonce binding', { request_nonce: '12345678-1234-4abc-8def-123456789abd' }],
    ['document count', { document_count: 3 }],
    ['document content', { content_hash: 'c'.repeat(64) }],
    ['readiness', { ready: false }],
  ])('fails closed when the API receipt has a mismatched %s', (_label, overrides) => {
    expect(() => validate(documents, receipt(overrides)))
      .toThrow(expect.objectContaining({ code: 'KNOWLEDGE_EXECUTION_RECHECK_UNAVAILABLE' }))
  })

  it('rejects missing, stale, and future-dated receipts', () => {
    expect(() => validate(documents, null)).toThrow(expect.objectContaining({ code: 'KNOWLEDGE_EXECUTION_RECHECK_UNAVAILABLE' }))
    expect(() => validate(documents, receipt({ checked_at: new Date(now - 30_001).toISOString() })))
      .toThrow(expect.objectContaining({ code: 'KNOWLEDGE_EXECUTION_RECHECK_UNAVAILABLE' }))
    expect(() => validate(documents, receipt({ checked_at: new Date(now + 5_001).toISOString() })))
      .toThrow(expect.objectContaining({ code: 'KNOWLEDGE_EXECUTION_RECHECK_UNAVAILABLE' }))
  })
})
