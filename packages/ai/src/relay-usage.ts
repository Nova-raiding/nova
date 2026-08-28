import { createHash } from 'node:crypto'

export type RelayUsageModality = 'text' | 'image' | 'image_edit' | 'ocr' | 'video'

export interface RelayUsageContext {
  workspaceId?: string
  actionId?: string
  billingUnits?: number
}

export interface RelayUsageRecord {
  workspaceId?: string
  actionId?: string
  modality: RelayUsageModality
  model: string
  providerRequestId?: string
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  costCny?: number
  observedAt: string
  metadata?: Record<string, unknown>
}

export type RelayUsageSettlement = 'recorded' | 'unknown'

export type RelayUsageSink = (record: RelayUsageRecord) => void | Promise<void>

export class ModelUsageSettlementPendingError extends Error {
  readonly code = 'MODEL_USAGE_SETTLEMENT_PENDING'
  readonly providerSucceeded = true

  constructor(readonly receiptKey: string) {
    super('model usage settlement is pending')
    this.name = 'ModelUsageSettlementPendingError'
  }
}

type RecordLike = Record<string, unknown>

function record(value: unknown): value is RecordLike {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
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

function firstNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    const parsed = numberFrom(value)
    if (parsed !== undefined) return parsed
  }
  return undefined
}

export function relayUsageReceiptKey(usage: Pick<RelayUsageRecord, 'workspaceId' | 'actionId' | 'model' | 'modality' | 'providerRequestId'>) {
  const providerRequestId = usage.providerRequestId?.trim()
  if (providerRequestId) return providerRequestId
  const identity = JSON.stringify([
    usage.workspaceId?.trim() ?? '',
    usage.actionId?.trim() ?? '',
    usage.model.trim(),
    usage.modality,
  ])
  return `relay_usage_${createHash('sha256').update(identity, 'utf8').digest('hex')}`
}

/** Extract the provider-neutral usage shape without trusting arbitrary response fields. */
export function parseRelayUsage(payload: unknown, headers: Headers, defaults: { modality: RelayUsageModality; model: string; context?: RelayUsageContext }): RelayUsageRecord | undefined {
  const root = record(payload) ? payload : {}
  const usage = record(root.usage) ? root.usage : record(root.data) && record(root.data.usage) ? root.data.usage : undefined
  const inputTokens = firstNumber(usage?.prompt_tokens, usage?.input_tokens, usage?.inputTokens)
  const outputTokens = firstNumber(usage?.completion_tokens, usage?.output_tokens, usage?.outputTokens)
  const totalTokens = firstNumber(usage?.total_tokens, usage?.totalTokens, inputTokens !== undefined && outputTokens !== undefined ? inputTokens + outputTokens : undefined)
  const costCny = firstNumber(usage?.cost_cny, usage?.costCny, root.cost_cny, root.costCny, record(root.data) ? root.data.cost_cny : undefined, record(root.data) ? root.data.costCny : undefined)
  const providerRequestId = headers.get('x-request-id')?.trim() || headers.get('request-id')?.trim() || (typeof root.id === 'string' && root.id.trim() ? root.id.trim() : undefined)
  const usageObserved = inputTokens !== undefined || outputTokens !== undefined || totalTokens !== undefined || costCny !== undefined
  return {
    ...(defaults.context?.workspaceId ? { workspaceId: defaults.context.workspaceId } : {}),
    ...(defaults.context?.actionId ? { actionId: defaults.context.actionId } : {}),
    modality: defaults.modality,
    model: defaults.model,
    ...(providerRequestId ? { providerRequestId } : {}),
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
    ...(costCny !== undefined ? { costCny } : {}),
    observedAt: new Date().toISOString(),
    metadata: { usage_observed: usageObserved, ...(defaults.context?.billingUnits ? { billing_units: defaults.context.billingUnits } : {}) },
  }
}

export async function emitRelayUsage(sink: RelayUsageSink | undefined, payload: unknown, headers: Headers, defaults: { modality: RelayUsageModality; model: string; context?: RelayUsageContext }) {
  const usage = parseRelayUsage(payload, headers, defaults)
  if (usage && sink) {
    try {
      await sink(usage)
    } catch (error) {
      if ((error as { code?: unknown })?.code === 'MODEL_USAGE_COST_MISSING') throw error
      throw new ModelUsageSettlementPendingError(relayUsageReceiptKey(usage))
    }
    usage.metadata = { ...(usage.metadata ?? {}), settlement: 'recorded' satisfies RelayUsageSettlement }
  }
  return usage
}
