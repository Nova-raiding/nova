import { createHash } from 'node:crypto'
import { validatePublishReceiptUsageTrace, type PublishReceiptTraceReceipt, type PublishReceiptTraceScope } from './publish-receipt-traceability.js'

const HASH = /^[a-f0-9]{64}$/u
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u

export type PublishPrepareConfirmErrorCode =
  | 'PUBLISH_PREPARE_INVALID'
  | 'PUBLISH_CONFIRMATION_REQUIRED'
  | 'PUBLISH_CONFIRMATION_STALE'
  | 'PUBLISH_IDEMPOTENCY_CONFLICT'
  | 'PUBLISH_RECEIPT_UNBOUND'

export class PublishPrepareConfirmError extends Error {
  constructor(readonly code: PublishPrepareConfirmErrorCode, message: string) {
    super(message)
    this.name = 'PublishPrepareConfirmError'
  }
}

export interface PublishPrepareInput {
  workspaceId: string
  taskId: string
  listingId: string
  canonicalProductId: string
  contextHash: string
  taskRevision: number
  contentVersionId: string
  contentVersionRevision: number
  remoteSnapshotHash: string
  payloadHash: string
}

export interface PublishPreparation {
  readonly kind: 'publish_preparation'
  readonly confirmationHash: string
  readonly preparedAt: string
  readonly input: Readonly<PublishPrepareInput>
  readonly receiptScope: Readonly<PublishReceiptTraceScope>
}

export interface PublishSecondConfirmation {
  confirmedBy: string
  confirmedAt: string
  confirmationHash: string
}

export interface PublishConfirmInput {
  preparation: PublishPreparation
  idempotencyKey: string
  currentTaskRevision: number
  currentContentVersionRevision: number
  currentRemoteSnapshotHash: string
  secondConfirmation?: PublishSecondConfirmation
}

export interface ConfirmedPublish {
  readonly kind: 'confirmed_publish'
  readonly idempotencyKey: string
  readonly confirmationHash: string
  readonly confirmedAt: string
  readonly confirmedBy: string
  readonly preparation: PublishPreparation
}

const text = (value: unknown) => typeof value === 'string' ? value.normalize('NFKC').trim() : ''
const fail = (code: PublishPrepareConfirmErrorCode, message: string): never => { throw new PublishPrepareConfirmError(code, message) }

function requireId(value: unknown, field: string) {
  const normalized = text(value)
  if (!ID.test(normalized)) fail('PUBLISH_PREPARE_INVALID', `${field} must be a valid identifier`)
  return normalized
}

function requireHash(value: unknown, field: string) {
  const normalized = text(value)
  if (!HASH.test(normalized)) fail('PUBLISH_PREPARE_INVALID', `${field} must be a SHA-256 digest`)
  return normalized
}

function requireRevision(value: unknown, field: string) {
  if (!Number.isSafeInteger(value) || (value as number) < 1) fail('PUBLISH_PREPARE_INVALID', `${field} must be a positive safe integer`)
  return value as number
}

function requireTimestamp(value: unknown, field: string) {
  const normalized = text(value)
  if (!normalized || !Number.isFinite(Date.parse(normalized))) fail('PUBLISH_CONFIRMATION_REQUIRED', `${field} must be a valid timestamp`)
  return new Date(normalized).toISOString()
}

function scopeFromInput(input: PublishPrepareInput): PublishReceiptTraceScope {
  return {
    workspaceId: requireId(input.workspaceId, 'workspaceId'),
    taskId: requireId(input.taskId, 'taskId'),
    listingId: requireId(input.listingId, 'listingId'),
    canonicalProductId: requireId(input.canonicalProductId, 'canonicalProductId'),
    contextHash: requireHash(input.contextHash, 'contextHash'),
  }
}

function normalizedInput(input: PublishPrepareInput) {
  const scope = scopeFromInput(input)
  return {
    ...scope,
    taskRevision: requireRevision(input.taskRevision, 'taskRevision'),
    contentVersionId: requireId(input.contentVersionId, 'contentVersionId'),
    contentVersionRevision: requireRevision(input.contentVersionRevision, 'contentVersionRevision'),
    remoteSnapshotHash: requireHash(input.remoteSnapshotHash, 'remoteSnapshotHash'),
    payloadHash: requireHash(input.payloadHash, 'payloadHash'),
  }
}

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

export function preparePublish(input: PublishPrepareInput, preparedAt = new Date().toISOString()): PublishPreparation {
  const normalized = normalizedInput(input)
  const timestamp = requireTimestamp(preparedAt, 'preparedAt')
  const confirmationHash = digest({ kind: 'publish_preparation', input: normalized })
  return Object.freeze({
    kind: 'publish_preparation' as const,
    confirmationHash,
    preparedAt: timestamp,
    input: Object.freeze(normalized),
    receiptScope: Object.freeze(scopeFromInput(normalized)),
  })
}

function samePreparation(left: PublishPreparation, right: PublishPreparation) {
  return left.confirmationHash === right.confirmationHash
}

export class PublishConfirmationLedger {
  private readonly confirmed = new Map<string, ConfirmedPublish>()

  confirm(input: PublishConfirmInput): ConfirmedPublish {
    const preparation = input?.preparation
    if (!preparation || preparation.kind !== 'publish_preparation') fail('PUBLISH_CONFIRMATION_STALE', 'publish preparation is required')
    const key = `${preparation.input.workspaceId}:${requireId(input.idempotencyKey, 'idempotencyKey')}`
    const existing = this.confirmed.get(key)
    if (existing) {
      if (!samePreparation(existing.preparation, preparation)) fail('PUBLISH_IDEMPOTENCY_CONFLICT', 'idempotency key is bound to another publish intent')
      return existing
    }
    const second = input.secondConfirmation
    if (!second) fail('PUBLISH_CONFIRMATION_REQUIRED', 'explicit second confirmation is required')
    if (text(second.confirmationHash) !== preparation.confirmationHash) fail('PUBLISH_CONFIRMATION_STALE', 'second confirmation does not match the prepared snapshot')
    requireId(second.confirmedBy, 'confirmedBy')
    requireTimestamp(second.confirmedAt, 'confirmedAt')
    requireRevision(input.currentTaskRevision, 'currentTaskRevision')
    requireRevision(input.currentContentVersionRevision, 'currentContentVersionRevision')
    requireHash(input.currentRemoteSnapshotHash, 'currentRemoteSnapshotHash')
    if (input.currentTaskRevision !== preparation.input.taskRevision || input.currentContentVersionRevision !== preparation.input.contentVersionRevision || input.currentRemoteSnapshotHash !== preparation.input.remoteSnapshotHash) {
      fail('PUBLISH_CONFIRMATION_STALE', 'task, content version, or remote snapshot changed after preparation')
    }
    const result = Object.freeze({ kind: 'confirmed_publish' as const, idempotencyKey: key, confirmationHash: preparation.confirmationHash, confirmedAt: new Date(second.confirmedAt).toISOString(), confirmedBy: text(second.confirmedBy), preparation })
    this.confirmed.set(key, result)
    return result
  }
}

export function bindPublishReceipt(preparation: PublishPreparation, receipt: PublishReceiptTraceReceipt): Readonly<PublishReceiptTraceReceipt & { preparationConfirmationHash: string }> {
  try {
    const trace = validatePublishReceiptUsageTrace({ receipt })
    if (JSON.stringify(trace.receipt.scope) !== JSON.stringify(preparation.receiptScope)) fail('PUBLISH_RECEIPT_UNBOUND', 'publish receipt scope does not match the prepared publish')
    return Object.freeze({ ...trace.receipt, preparationConfirmationHash: preparation.confirmationHash })
  } catch (error) {
    if (error instanceof PublishPrepareConfirmError) throw error
    fail('PUBLISH_RECEIPT_UNBOUND', 'publish receipt is invalid or unbound')
  }
}
