/**
 * The ledger keys one model debit owns, and the one definition of what that
 * debit currently costs.
 *
 * One debit key owns more rows than its own: `settleDebit` appends
 * `settlement:<key>` / `settlement-refund:<key>` deltas and `refundDebit`
 * appends the reversal `refund:<key>`. Every consumer that has to answer "what
 * did this debit cost?" — the SQL aggregate in `billing-repository.ts`, the
 * memory wallet in `apps/api/src/server.ts`, and the reconciliation report that
 * compares the wallet against the provider's charge — reads that answer from
 * here. The defect this replaces was exactly one consumer keeping its own
 * version: the endpoint aggregated `actionId + settlement:* - settlement-refund:*`
 * without the `refund:<key>` row, so the ledger this branch made correct was
 * reported `needs_review` while a ledger that over-credited the workspace
 * reconciled clean.
 *
 * Nothing outside this module may re-derive the row set or the arithmetic from
 * it; the registry pins that with a forbidden-reimplementation check
 * (`tests/invariants/billing-effective-amount.invariant.ts`).
 */

/** A ledger row as the amount arithmetic sees it — a `billing_transactions`
 *  row or a memory `WalletTransaction`. */
export interface DebitLedgerRow {
  readonly type: string
  readonly amountFen: number
  readonly orderId?: string | null
}

/** The ledger key a settlement delta for `debitKey` is written under. */
export function settlementOrderId(debitKey: string, direction: 'debit' | 'refund'): string {
  return `${direction === 'debit' ? 'settlement' : 'settlement-refund'}:${debitKey}`
}

/** The ledger key the reversal of `debitKey` is written under. */
export function reversalOrderId(debitKey: string): string {
  return `refund:${debitKey}`
}

/**
 * Every ledger `order_id` that belongs to one debit key: the reservation, both
 * settlement deltas and the reversal. This list is the definition of which rows
 * decide what that key costs, so it is written once and read by every consumer.
 */
export function debitKeyOrderIds(debitKey: string): readonly string[] {
  return [debitKey, settlementOrderId(debitKey, 'debit'), settlementOrderId(debitKey, 'refund'), reversalOrderId(debitKey)]
}

/**
 * The one definition of "what this debit key is worth right now": the
 * reservation, plus every settlement delta already appended, minus any
 * reversal already written.
 *
 * `settleDebit` and `refundDebit` derive their amounts from this and are not
 * allowed to aggregate for themselves — the defect this replaces was exactly
 * one reader being taught about a new row kind while its sibling stayed on the
 * old arithmetic, so the two halves of the same settlement disagreed about what
 * the key cost. An existing `refund:<key>` row belongs in the sum: a reversal
 * taken before the settlement arrives, otherwise the settlement re-derives its
 * delta from the pre-reversal amount and hands the whole pre-authorization back
 * to the workspace.
 *
 * Returns `undefined` when the key owns no ledger row at all, so a caller can
 * tell "this key was never debited" from "this key's rows sum to zero".
 */
export function effectiveDebitFenOf(rows: readonly DebitLedgerRow[], debitKey: string): number | undefined {
  return effectiveDebitFensOf(rows, [debitKey]).get(debitKey)
}

/**
 * The same read for many keys over one pass of the ledger. Only the keys that
 * own at least one row are present, so a caller that has to fall back to
 * another source when a key has no ledger evidence can still do so.
 */
export function effectiveDebitFensOf(rows: readonly DebitLedgerRow[], debitKeys: readonly string[]): Map<string, number> {
  const keyByOrderId = new Map<string, string>()
  for (const debitKey of debitKeys) for (const orderId of debitKeyOrderIds(debitKey)) keyByOrderId.set(orderId, debitKey)
  const effectiveFen = new Map<string, number>()
  for (const row of rows) {
    if (!row.orderId) continue
    const debitKey = keyByOrderId.get(row.orderId)
    if (!debitKey) continue
    if (row.type !== 'debit' && row.type !== 'refund') continue
    effectiveFen.set(debitKey, (effectiveFen.get(debitKey) ?? 0) + (row.type === 'debit' ? row.amountFen : -row.amountFen))
  }
  return effectiveFen
}
