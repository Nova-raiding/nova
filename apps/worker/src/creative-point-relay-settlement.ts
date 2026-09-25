import { createHash } from 'node:crypto'
import type { RelayUsageRecord } from '../../../packages/ai/src/relay-usage.js'
import type { CreativePointRepository, PostgresCreativePointLifecycleRepository } from '../../../packages/persistence/src/index.js'
import type { DurableOutboxEvent } from '../../../packages/workers/src/durable.js'
import { parseWorkerCommercialAccessSnapshot } from '../../../packages/workers/src/commercial-access.js'

type OutcomeError = {
  providerRequestId?: unknown
  providerIdempotencyKey?: unknown
  providerOutcome?: unknown
  code?: unknown
  message?: unknown
}

const identity = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined
  const normalized = value.trim()
  return normalized && normalized.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(normalized) ? normalized : undefined
}

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const finiteNonNegative = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0
const modalities = new Set(['text', 'image', 'image_edit', 'ocr', 'video'])

function validUsageEvidence(value: unknown, requireObservedAt = false): boolean {
  if (!isRecord(value) || !modalities.has(String(value.modality)) || !identity(value.model)) return false
  if (requireObservedAt && (!identity(value.observedAt) || Number.isNaN(Date.parse(String(value.observedAt))))) return false
  for (const key of ['inputTokens', 'outputTokens', 'totalTokens', 'input_tokens', 'output_tokens', 'total_tokens'] as const) {
    if (value[key] !== undefined && (!finiteNonNegative(value[key]) || !Number.isSafeInteger(value[key]))) return false
  }
  return true
}

function validCostEvidence(value: unknown): boolean {
  return isRecord(value) && value.currency === 'CNY' && finiteNonNegative(value.actual)
}

const receiptHash = (value: Record<string, unknown>) => createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex')

/**
 * Bridges relay evidence to the creative-point reservation that was frozen in
 * the durable commercial access snapshot. A successful reservation must be
 * settled only after the generation result is accepted. Unknown provider
 * outcomes only append evidence and deliberately leave the reservation open.
 */
export class CreativePointRelaySettlement {
  constructor(
    private readonly points: Pick<CreativePointRepository, 'getReservation' | 'release'>,
    private readonly receipts: Pick<PostgresCreativePointLifecycleRepository, 'recordProviderReceipt' | 'getProviderReceipt' | 'verifyModelUsageDeliverySettlement'>,
    private readonly provider: string,
  ) {}

  private async reservation(event: DurableOutboxEvent, operation: 'generation.execute' | 'image_generation.execute' = 'generation.execute') {
    const snapshot = parseWorkerCommercialAccessSnapshot(event, operation)
    if (!snapshot.reservationId) return undefined
    const reservation = await this.points.getReservation(event.workspaceId, snapshot.reservationId)
    if (!reservation) throw Object.assign(new Error('creative point reservation was not found'), { code: 'CREATIVE_POINT_RESERVATION_NOT_FOUND' })
    if (reservation.points !== snapshot.quotedPoints) throw Object.assign(new Error('creative point reservation no longer matches the frozen quote'), { code: 'COMMERCIAL_EXECUTION_REVISION_STALE' })
    return reservation
  }

  async recordSucceeded(event: DurableOutboxEvent, usage: RelayUsageRecord, operation: 'generation.execute' | 'image_generation.execute' = 'generation.execute'): Promise<string | undefined> {
    const reservation = await this.reservation(event, operation)
    if (!reservation) return undefined
    const providerRequestId = identity(usage.providerRequestId) ?? identity(usage.providerAttemptId)
    if (!validUsageEvidence(usage, true) || !providerRequestId || !finiteNonNegative(usage.costCny)) throw Object.assign(new Error('verified relay identity, usage and finite non-negative cost are required before creative point settlement'), { code: 'MODEL_USAGE_EVIDENCE_MISSING', providerSucceeded: true })
    const usageEvidence = { modality: usage.modality, model: usage.model, ...(usage.inputTokens !== undefined ? { input_tokens: usage.inputTokens } : {}), ...(usage.outputTokens !== undefined ? { output_tokens: usage.outputTokens } : {}), ...(usage.totalTokens !== undefined ? { total_tokens: usage.totalTokens } : {}) }
    const costEvidence = { currency: 'CNY', actual: usage.costCny }
    const at = usage.observedAt
    await this.receipts.recordProviderReceipt({ workspaceId: event.workspaceId, operationId: reservation.operationId, provider: this.provider, providerRequestId, outcome: 'succeeded', usage: usageEvidence, cost: costEvidence, receiptHash: receiptHash({ workspace_id: event.workspaceId, operation_id: reservation.operationId, provider: this.provider, provider_request_id: providerRequestId, outcome: 'succeeded', usage: usageEvidence, cost: costEvidence, verified_at: at }), verifiedAt: at, at })
    return providerRequestId
  }

  async settleForDelivery(event: DurableOutboxEvent, providerRequestIds: readonly string[], operation: 'generation.execute' | 'image_generation.execute' = 'generation.execute'): Promise<void> {
    const reservation = await this.reservation(event, operation)
    if (!reservation) return
    const identities = [...new Set(providerRequestIds.map(identity).filter((value): value is string => Boolean(value)))].sort()
    if (identities.length !== 1) throw Object.assign(new Error('exactly one verified relay request is required for the original creative-point settlement'), { code: 'MODEL_USAGE_SETTLEMENT_EVIDENCE_MISMATCH', providerSucceeded: true, reconciliationRequired: true })
    if (this.provider === 'model-relay') throw Object.assign(new Error('worker relay identity must differ from the API settlement owner'), { code: 'MODEL_USAGE_SETTLEMENT_EVIDENCE_MISMATCH', providerSucceeded: true, reconciliationRequired: true })
    const actionId = identity(event.payload.action_id)
    if (!actionId || actionId !== reservation.actionKey) throw Object.assign(new Error('generation action does not match the frozen creative-point reservation'), { code: 'MODEL_USAGE_SETTLEMENT_EVIDENCE_MISMATCH', providerSucceeded: true, reconciliationRequired: true })
    for (const providerRequestId of identities) {
      const receipt = await this.receipts.getProviderReceipt({ workspaceId: event.workspaceId, operationId: reservation.operationId, provider: this.provider, providerRequestId })
      if (!receipt || receipt.outcome !== 'succeeded' || !validUsageEvidence(receipt.usage) || !validCostEvidence(receipt.cost) || !receipt.verifiedAt || Number.isNaN(Date.parse(receipt.verifiedAt))) {
        throw Object.assign(new Error('verified succeeded relay receipt with usage and cost is required before creative point settlement'), { code: 'MODEL_USAGE_EVIDENCE_MISSING', providerSucceeded: true, providerRequestId })
      }
    }
    const verified = await this.receipts.verifyModelUsageDeliverySettlement({ workspaceId: event.workspaceId, reservationId: reservation.id, actionId, providerRequestId: identities[0]!, relayProvider: this.provider })
    if (!verified) throw Object.assign(new Error('the API-owned provider usage and creative-point settlement evidence is incomplete or mismatched'), { code: 'MODEL_USAGE_SETTLEMENT_EVIDENCE_MISMATCH', providerSucceeded: true, reconciliationRequired: true, providerRequestId: identities[0] })
  }

  async recordProviderOutcome(event: DurableOutboxEvent, error: OutcomeError): Promise<void> {
    const reservation = await this.reservation(event)
    if (!reservation) return
    const providerRequestId = identity(error.providerRequestId) ?? identity(error.providerIdempotencyKey)
    const at = new Date().toISOString()
    if (error.providerOutcome === 'unknown') {
      if (providerRequestId) await this.receipts.recordProviderReceipt({ workspaceId: event.workspaceId, operationId: reservation.operationId, provider: this.provider, providerRequestId, outcome: 'unknown', receiptHash: receiptHash({ workspace_id: event.workspaceId, operation_id: reservation.operationId, provider: this.provider, provider_request_id: providerRequestId, outcome: 'unknown', error_code: identity(error.code) ?? 'MODEL_PROVIDER_OUTCOME_UNKNOWN' }), at })
      return
    }
    if (providerRequestId) await this.receipts.recordProviderReceipt({ workspaceId: event.workspaceId, operationId: reservation.operationId, provider: this.provider, providerRequestId, outcome: 'failed', receiptHash: receiptHash({ workspace_id: event.workspaceId, operation_id: reservation.operationId, provider: this.provider, provider_request_id: providerRequestId, outcome: 'failed', error_code: identity(error.code) ?? 'MODEL_PROVIDER_REQUEST_FAILED' }), at })
    await this.points.release({ workspaceId: event.workspaceId, reservationId: reservation.id, idempotencyKey: `relay-release:${providerRequestId ?? event.id}`, at })
  }
}

export async function deliverGenerationResultWithPointSettlement(hasContent: boolean, deliver: () => Promise<void>, settle: () => Promise<void>): Promise<void> {
  await deliver()
  if (hasContent) await settle()
}

export function requiresCreativePointSettlement(event: DurableOutboxEvent): boolean {
  const snapshot = event.payload.commercial_access_snapshot
  if (!isRecord(snapshot)) return false
  return snapshot.access_mode === 'POINT_CHARGED' && typeof snapshot.reservation_id === 'string' && Boolean(snapshot.reservation_id.trim())
}

export function relayProviderIdentity(source: Record<string, string | undefined>): string {
  const configured = source.MODEL_RELAY_PROVIDER?.trim()
  if (configured) return configured
  const baseUrl = source.MODEL_RELAY_BASE_URL?.trim()
  try { return baseUrl ? new URL(baseUrl).hostname : 'configured-relay' } catch { return 'configured-relay' }
}
