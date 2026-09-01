import { createHash } from 'node:crypto'

export type RelayUsageModality = 'text' | 'image' | 'image_edit' | 'ocr' | 'video'

export interface RelayUsageContext {
  workspaceId?: string
  actionId?: string
  /** Stable logical task identity shared by all provider calls in one budget run. */
  runKey?: string
  contextLinkId?: string
  contextHash?: string
  billingUnits?: number
  durationSeconds?: number
  /** Stable identity of this exact provider call when no provider request ID is returned. */
  providerAttemptId?: string
}

export interface RelayUsageRecord {
  workspaceId?: string
  actionId?: string
  runKey?: string
  contextLinkId?: string
  contextHash?: string
  modality: RelayUsageModality
  model: string
  providerRequestId?: string
  providerAttemptId?: string
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  costCny?: number
  observedAt: string
  metadata?: Record<string, unknown>
}

export type RelayUsageSettlement = 'recorded' | 'unknown'

export interface RelayUsageSettlementReceipt {
  recorded: true
  /** The settlement boundary verified provider or versioned derived cost. */
  costEvidence: true
}

export type RelayUsageSink = (record: RelayUsageRecord) => void | RelayUsageSettlementReceipt | Promise<void | RelayUsageSettlementReceipt>

export class ModelUsageSettlementPendingError extends Error {
  readonly code = 'MODEL_USAGE_SETTLEMENT_PENDING'
  readonly providerSucceeded = true

  constructor(readonly receiptKey: string) {
    super('model usage settlement is pending')
    this.name = 'ModelUsageSettlementPendingError'
  }
}

export class ModelUsageReceiptIdentityError extends Error {
  readonly code = 'MODEL_USAGE_RECEIPT_IDENTITY_MISSING'
  readonly providerSucceeded = true

  constructor() {
    super('model usage receipt is missing provider request and attempt identity')
    this.name = 'ModelUsageReceiptIdentityError'
  }
}

export class ModelUsageEvidenceMissingError extends Error {
  readonly code = 'MODEL_USAGE_EVIDENCE_MISSING'
  readonly providerSucceeded = true

  constructor(readonly missing: 'usage' | 'cost' | 'sink' | 'identity') {
    super(`model usage ${missing} evidence is missing`)
    this.name = 'ModelUsageEvidenceMissingError'
  }
}

type RecordLike = Record<string, unknown>

function record(value: unknown): value is RecordLike {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

// These identifiers cross into billing, audit and reconciliation evidence.
// Bound and sanitize them before accepting provider-controlled values so a
// response cannot inject control characters or create unbounded evidence rows.
function evidenceIdentity(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.trim()
  if (!normalized || normalized.length > 256 || /[\u0000-\u001f\u007f]/u.test(normalized)) return undefined
  return normalized
}

function finiteNonNegative(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined
  return value
}

function numberFrom(value: unknown): number | undefined {
  if (typeof value === 'number') return finiteNonNegative(value)
  if (typeof value === 'string' && /^\d+(?:\.\d+)?$/u.test(value.trim())) return finiteNonNegative(Number(value))
  return undefined
}

function tokenFrom(value: unknown): number | undefined {
  const parsed = numberFrom(value)
  return parsed !== undefined && Number.isSafeInteger(parsed) ? parsed : undefined
}

function firstNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    const parsed = numberFrom(value)
    if (parsed !== undefined) return parsed
  }
  return undefined
}

export function relayUsageReceiptKey(usage: Pick<RelayUsageRecord, 'workspaceId' | 'actionId' | 'model' | 'modality' | 'providerRequestId' | 'providerAttemptId'>) {
  const providerRequestId = evidenceIdentity(usage.providerRequestId)
  if (providerRequestId) return providerRequestId
  const providerAttemptId = evidenceIdentity(usage.providerAttemptId)
  if (!providerAttemptId) throw new ModelUsageReceiptIdentityError()
  const identity = JSON.stringify([
    usage.workspaceId?.trim() ?? '',
    usage.actionId?.trim() ?? '',
    usage.model.trim(),
    usage.modality,
    providerAttemptId,
  ])
  return `relay_usage_${createHash('sha256').update(identity, 'utf8').digest('hex')}`
}

/** Extract the provider-neutral usage shape without trusting arbitrary response fields. */
export function parseRelayUsage(payload: unknown, headers: Headers, defaults: { modality: RelayUsageModality; model: string; context?: RelayUsageContext }): RelayUsageRecord | undefined {
  const root = record(payload) ? payload : {}
  const data = record(root.data) ? root.data : undefined
  const nestedData = data && record(data.data) ? data.data : undefined
  // Some local/API relay adapters preserve the common API envelope and put
  // the provider response below data.result. Keep this explicit and bounded;
  // arbitrary recursive traversal could accidentally treat unrelated data as
  // metering evidence.
  const result = data && record(data.result) ? data.result : undefined
  const usage = record(root.usage) ? root.usage : data && record(data.usage) ? data.usage : nestedData && record(nestedData.usage) ? nestedData.usage : result && record(result.usage) ? result.usage : undefined
  const inputTokens = tokenFrom(usage?.prompt_tokens) ?? tokenFrom(usage?.input_tokens) ?? tokenFrom(usage?.inputTokens)
  const outputTokens = tokenFrom(usage?.completion_tokens) ?? tokenFrom(usage?.output_tokens) ?? tokenFrom(usage?.outputTokens)
  const reportedTotal = tokenFrom(usage?.total_tokens) ?? tokenFrom(usage?.totalTokens)
  const totalTokens = reportedTotal !== undefined && inputTokens !== undefined && outputTokens !== undefined && reportedTotal !== inputTokens + outputTokens
    ? undefined
    : reportedTotal ?? (inputTokens !== undefined && outputTokens !== undefined ? inputTokens + outputTokens : undefined)
  // Raw quota is deliberately excluded: without a versioned unit, exchange
  // rate and pricing formula it is not currency evidence.
  const costCny = firstNumber(usage?.cost_cny, usage?.costCny, root.cost_cny, root.costCny, data?.cost_cny, data?.costCny, nestedData?.cost_cny, nestedData?.costCny)
  const providerRequestId = evidenceIdentity(headers.get('x-oneapi-request-id'))
    || evidenceIdentity(headers.get('x-request-id'))
    || evidenceIdentity(headers.get('x-provider-request-id'))
    || evidenceIdentity(headers.get('request-id'))
    || evidenceIdentity(root.provider_request_id)
    || evidenceIdentity(root.request_id)
    || evidenceIdentity(data?.provider_request_id)
    || evidenceIdentity(data?.request_id)
    || evidenceIdentity(nestedData?.provider_request_id)
    || evidenceIdentity(nestedData?.request_id)
    || evidenceIdentity(result?.provider_request_id)
    || evidenceIdentity(result?.request_id)
  // Cost is not usage. A relay that reports only a price has not provided
  // enough metering evidence to settle a model call safely.
  const usageObserved = inputTokens !== undefined || outputTokens !== undefined || totalTokens !== undefined
  return {
    ...(defaults.context?.workspaceId ? { workspaceId: defaults.context.workspaceId } : {}),
    ...(defaults.context?.actionId ? { actionId: defaults.context.actionId } : {}),
    ...(defaults.context?.runKey ? { runKey: defaults.context.runKey } : {}),
    ...(defaults.context?.contextLinkId ? { contextLinkId: defaults.context.contextLinkId } : {}),
    ...(defaults.context?.contextHash ? { contextHash: defaults.context.contextHash } : {}),
    modality: defaults.modality,
    model: defaults.model,
    ...(providerRequestId ? { providerRequestId } : {}),
    ...(defaults.context?.providerAttemptId?.trim() ? { providerAttemptId: defaults.context.providerAttemptId.trim() } : {}),
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
    ...(costCny !== undefined ? { costCny } : {}),
    observedAt: new Date().toISOString(),
    metadata: {
      usage_observed: usageObserved,
      ...(defaults.context?.billingUnits ? { billing_units: defaults.context.billingUnits } : {}),
      ...(defaults.context?.durationSeconds ? { duration_seconds: defaults.context.durationSeconds } : {}),
      ...(typeof root.id === 'string' && root.id.trim() ? { provider_response_id: root.id.trim() } : {}),
    },
  }
}

export async function emitRelayUsage(sink: RelayUsageSink | undefined, payload: unknown, headers: Headers, defaults: { modality: RelayUsageModality; model: string; context?: RelayUsageContext }) {
  const usage = parseRelayUsage(payload, headers, defaults)
  if (!usage || usage.metadata?.usage_observed !== true) throw new ModelUsageEvidenceMissingError('usage')
  if (!usage.providerRequestId?.trim() && !usage.providerAttemptId?.trim()) throw new ModelUsageEvidenceMissingError('identity')
  if (!sink) throw new ModelUsageEvidenceMissingError('sink')
  let settlementReceipt: void | RelayUsageSettlementReceipt
  try {
    settlementReceipt = await sink(usage)
  } catch (error) {
    if (['MODEL_USAGE_COST_MISSING', 'MODEL_TASK_COST_ACTUAL_EXCEEDED', 'MODEL_DAILY_COST_ACTUAL_EXCEEDED'].includes(String((error as { code?: unknown })?.code ?? ''))) throw error
    throw new ModelUsageSettlementPendingError(relayUsageReceiptKey(usage))
  }
  // A sink may be implemented outside this package (or arrive through a
  // JavaScript boundary), so the TypeScript receipt type is not enough at
  // runtime. Never turn a malformed receipt into a successful settlement.
  if (usage.costCny !== undefined && settlementReceipt !== undefined && (settlementReceipt.recorded !== true || settlementReceipt.costEvidence !== true)) {
    throw new ModelUsageEvidenceMissingError('sink')
  }
  // Some relays return tokens but omit currency. Only a trusted settlement
  // sink may fill that gap from a versioned pricing snapshot; a plain sink
  // success is not sufficient cost evidence.
  // A cost attestation is only meaningful when the sink also confirms that
  // the usage record was durably recorded. Do not let a malformed or stale
  // adapter response turn derived pricing into a successful settlement.
  const settlementRecorded = settlementReceipt?.recorded === true
  if (usage.costCny === undefined && (!settlementRecorded || settlementReceipt?.costEvidence !== true)) throw new ModelUsageEvidenceMissingError('cost')
  usage.metadata = { ...(usage.metadata ?? {}), ...(usage.costCny === undefined ? { cost_evidence: 'settlement_sink' } : {}), settlement: 'recorded' satisfies RelayUsageSettlement }
  return usage
}
