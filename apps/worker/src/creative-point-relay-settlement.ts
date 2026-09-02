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

const receiptHash = (value: Record<string, unknown>) => createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex')

/**
 * Bridges relay evidence to the creative-point reservation that was frozen in
 * the durable commercial access snapshot. A successful reservation must be
 * settled before the generation result can be delivered. Unknown provider
 * outcomes only append evidence and deliberately leave the reservation open.
 */
export class CreativePointRelaySettlement {
  constructor(
    private readonly points: Pick<CreativePointRepository, 'getReservation' | 'settle' | 'release'>,
    private readonly receipts: Pick<PostgresCreativePointLifecycleRepository, 'recordProviderReceipt'>,
    private readonly provider: string,
  ) {}

  private async reservation(event: DurableOutboxEvent) {
    const snapshot = parseWorkerCommercialAccessSnapshot(event, 'generation.execute')
    if (!snapshot.reservationId) return undefined
    const reservation = await this.points.getReservation(event.workspaceId, snapshot.reservationId)
    if (!reservation) throw Object.assign(new Error('creative point reservation was not found'), { code: 'CREATIVE_POINT_RESERVATION_NOT_FOUND' })
    if (reservation.points !== snapshot.quotedPoints) throw Object.assign(new Error('creative point reservation no longer matches the frozen quote'), { code: 'COMMERCIAL_EXECUTION_REVISION_STALE' })
    return reservation
  }

  async recordSucceeded(event: DurableOutboxEvent, usage: RelayUsageRecord): Promise<string | undefined> {
    const reservation = await this.reservation(event)
    if (!reservation) return undefined
    const providerRequestId = identity(usage.providerRequestId) ?? identity(usage.providerAttemptId)
    if (!providerRequestId || usage.costCny === undefined) throw Object.assign(new Error('verified relay identity and cost are required before creative point settlement'), { code: 'MODEL_USAGE_EVIDENCE_MISSING', providerSucceeded: true })
    const usageEvidence = { modality: usage.modality, model: usage.model, input_tokens: usage.inputTokens ?? null, output_tokens: usage.outputTokens ?? null, total_tokens: usage.totalTokens ?? null }
    const costEvidence = { currency: 'CNY', actual: usage.costCny }
    const at = usage.observedAt
    await this.receipts.recordProviderReceipt({ workspaceId: event.workspaceId, operationId: reservation.operationId, provider: this.provider, providerRequestId, outcome: 'succeeded', usage: usageEvidence, cost: costEvidence, receiptHash: receiptHash({ workspace_id: event.workspaceId, operation_id: reservation.operationId, provider: this.provider, provider_request_id: providerRequestId, outcome: 'succeeded', usage: usageEvidence, cost: costEvidence, verified_at: at }), verifiedAt: at, at })
    return providerRequestId
  }

  async settleForDelivery(event: DurableOutboxEvent, providerRequestIds: readonly string[]): Promise<void> {
    const reservation = await this.reservation(event)
    if (!reservation) return
    const identities = [...new Set(providerRequestIds.map(identity).filter((value): value is string => Boolean(value)))].sort()
    if (identities.length === 0) throw Object.assign(new Error('verified relay receipt is required before creative point settlement'), { code: 'MODEL_USAGE_EVIDENCE_MISSING', providerSucceeded: true })
    const at = new Date().toISOString()
    const settlementIdentity = createHash('sha256').update(identities.join('\n'), 'utf8').digest('hex')
    await this.points.settle({ workspaceId: event.workspaceId, reservationId: reservation.id, actualPoints: reservation.points, idempotencyKey: `relay-settle:${settlementIdentity}`, metadata: { provider: this.provider, provider_request_ids: identities, receipt_verified_at: at }, at })
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

export function relayProviderIdentity(source: Record<string, string | undefined>): string {
  const configured = source.MODEL_RELAY_PROVIDER?.trim()
  if (configured) return configured
  const baseUrl = source.MODEL_RELAY_BASE_URL?.trim()
  try { return baseUrl ? new URL(baseUrl).hostname : 'configured-relay' } catch { return 'configured-relay' }
}
