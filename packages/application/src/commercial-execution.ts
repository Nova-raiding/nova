/**
 * The single charged-model execution protocol.  Entry points must use this
 * coordinator instead of debiting a wallet around a provider call: a quote is
 * reserved before I/O, successful calls require a verified provider receipt
 * before settlement, and known failures release the reservation.  Unknown
 * outcomes intentionally keep the reservation for reconciliation.
 */
export interface ChargedExecutionReservation {
  readonly reservation_id: string
  readonly points: number
  readonly rate_card_version: string
}

export interface ChargedExecutionLedger {
  reserve(input: { workspace_id: string; idempotency_key: string; action_key: string; points: number; rate_card_version: string }): Promise<ChargedExecutionReservation>
  settle(input: { workspace_id: string; idempotency_key: string; reservation_id: string; actual_points: number; provider_request_id: string; receipt_hash: string; usage: Record<string, unknown>; cost: Record<string, unknown> }): Promise<void>
  release(input: { workspace_id: string; idempotency_key: string; reservation_id: string; reason: string }): Promise<void>
}

export interface VerifiedProviderReceipt {
  readonly outcome: 'succeeded' | 'failed' | 'unknown'
  readonly provider_request_id: string
  readonly receipt_hash: string
  readonly usage?: Record<string, unknown>
  readonly cost?: Record<string, unknown>
}

export interface ChargedExecutionAudit {
  record(input: { workspace_id: string; action_key: string; state: 'reserved' | 'settled' | 'released' | 'reconciliation_required'; reservation_id: string; provider_request_id?: string; details?: Record<string, unknown> }): Promise<void>
}

export type ChargedProvider<T> = (reservation: ChargedExecutionReservation) => Promise<{ value: T; receipt: VerifiedProviderReceipt }>

export async function executeCharged<T>(input: {
  workspace_id: string
  action_key: string
  idempotency_key: string
  quoted_points: number
  rate_card_version: string
  ledger: ChargedExecutionLedger
  audit: ChargedExecutionAudit
  provider: ChargedProvider<T>
}): Promise<{ value: T; reservation: ChargedExecutionReservation; receipt: VerifiedProviderReceipt }> {
  const reservation = await input.ledger.reserve({
    workspace_id: input.workspace_id,
    idempotency_key: input.idempotency_key,
    action_key: input.action_key,
    points: input.quoted_points,
    rate_card_version: input.rate_card_version,
  })
  await input.audit.record({ workspace_id: input.workspace_id, action_key: input.action_key, state: 'reserved', reservation_id: reservation.reservation_id, details: { points: reservation.points, rate_card_version: reservation.rate_card_version } })
  try {
    const result = await input.provider(reservation)
    const receipt = result.receipt
    if (!receipt.provider_request_id.trim() || !receipt.receipt_hash.trim()) throw new Error('provider receipt identity is required')
    if (receipt.outcome === 'unknown') {
      await input.audit.record({ workspace_id: input.workspace_id, action_key: input.action_key, state: 'reconciliation_required', reservation_id: reservation.reservation_id, provider_request_id: receipt.provider_request_id })
      throw Object.assign(new Error('provider outcome is unknown; reservation requires reconciliation'), { code: 'PROVIDER_OUTCOME_UNKNOWN', providerSucceeded: false })
    }
    if (receipt.outcome === 'failed') {
      await input.ledger.release({ workspace_id: input.workspace_id, idempotency_key: `${input.idempotency_key}:release`, reservation_id: reservation.reservation_id, reason: 'provider_failed' })
      await input.audit.record({ workspace_id: input.workspace_id, action_key: input.action_key, state: 'released', reservation_id: reservation.reservation_id, provider_request_id: receipt.provider_request_id })
      throw Object.assign(new Error('provider reported failure'), { code: 'PROVIDER_FAILED', providerSucceeded: false })
    }
    if (!receipt.usage || !receipt.cost) throw Object.assign(new Error('successful provider receipt requires usage and cost evidence'), { code: 'MODEL_USAGE_EVIDENCE_MISSING', providerSucceeded: true })
    await input.ledger.settle({ workspace_id: input.workspace_id, idempotency_key: `${input.idempotency_key}:settle`, reservation_id: reservation.reservation_id, actual_points: reservation.points, provider_request_id: receipt.provider_request_id, receipt_hash: receipt.receipt_hash, usage: receipt.usage, cost: receipt.cost })
    await input.audit.record({ workspace_id: input.workspace_id, action_key: input.action_key, state: 'settled', reservation_id: reservation.reservation_id, provider_request_id: receipt.provider_request_id, details: { receipt_hash: receipt.receipt_hash, usage: receipt.usage, cost: receipt.cost } })
    return { value: result.value, reservation, receipt }
  } catch (error) {
    // Reserve failures and provider errors before a verified request identity
    // must release.  Unknown outcomes are deliberately retained for recovery.
    if ((error as { code?: string }).code !== 'PROVIDER_OUTCOME_UNKNOWN' && (error as { providerSucceeded?: boolean }).providerSucceeded !== true) {
      try { await input.ledger.release({ workspace_id: input.workspace_id, idempotency_key: `${input.idempotency_key}:release`, reservation_id: reservation.reservation_id, reason: 'execution_failed' }) } catch { /* reconciliation owns a failed compensation */ }
    }
    throw error
  }
}
