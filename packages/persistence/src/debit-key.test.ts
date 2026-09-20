import { describe, expect, it } from 'vitest'
import { debitKeyOrderIds, effectiveDebitFenOf, effectiveDebitFensOf, reversalOrderId, settlementOrderId } from './debit-key.js'

/**
 * The evidence for `billing-effective-amount-memory-wallet` in
 * `tests/invariants`.
 *
 * One debit key owns four ledger rows: the reservation, both settlement deltas
 * and the reversal. What that key costs is one sum over them, and the memory
 * wallet — the backend the fixture/browser flows run on — reads it from here.
 * The fixture used to hand-copy the arithmetic instead: it reversed the raw
 * reservation and computed its settlement delta as
 * `finalAmountFen - original.amountFen`, so a settle-then-correct sequence was
 * silently dropped and a reversal-first sequence charged the workspace the
 * pre-authorization twice. Each case below is asserted with a name, because the
 * registered mutation must fail on a named assertion rather than on a count of
 * red characters.
 */
describe('the one definition of what a debit key costs', () => {
  const key = 'model:debit-key-evidence'
  const ledger = [
    { type: 'debit', amountFen: 100, orderId: key },
    // The reversal arrived first: the action produced no result and was
    // reversed before the provider's receipt was reconciled.
    { type: 'refund', amountFen: 100, orderId: reversalOrderId(key) },
    { type: 'debit', amountFen: 40, orderId: settlementOrderId(key, 'debit') },
  ]

  it('reads the key row set once', () => {
    expect(debitKeyOrderIds(key)).toEqual([key, `settlement:${key}`, `settlement-refund:${key}`, `refund:${key}`])
    expect(reversalOrderId(key)).toBe(`refund:${key}`)
    expect(settlementOrderId(key, 'refund')).toBe(`settlement-refund:${key}`)
  })

  it('costs a reversal-first key exactly what the provider charged', () => {
    // 100 debited, 100 handed back by the reversal, 40 charged by the provider:
    // the key costs 40. Reading only the reservation gives 140 (the whole
    // pre-authorization charged twice), which is the defect this pins.
    expect(effectiveDebitFenOf(ledger, key), 'the effective amount of a reversal-first debit key').toBe(40)
    // The same answer through the batch read the API reconciliation path uses.
    expect(effectiveDebitFensOf(ledger, [key]).get(key), 'the effective amount of a reversal-first debit key').toBe(40)
  })

  it('costs a settle-first key what the provider charged after the reversal', () => {
    const settledFirst = [
      { type: 'debit', amountFen: 100, orderId: key },
      { type: 'refund', amountFen: 60, orderId: settlementOrderId(key, 'refund') },
    ]
    // 100 debited, the settlement corrected it down by 60, nothing reversed yet.
    expect(effectiveDebitFenOf(settledFirst, key), 'the effective amount of a settle-first debit key').toBe(40)
  })

  it('tells a key that was never debited from one whose rows sum to zero', () => {
    // A key with no ledger row is absent from the batch read, which is what
    // lets the reconciliation fall back to another source instead of reading
    // "never debited" as "costs nothing".
    expect(effectiveDebitFenOf(ledger, 'model:other-key')).toBeUndefined()
    expect(effectiveDebitFensOf(ledger, [key, 'model:other-key']).has('model:other-key')).toBe(false)
    // A key whose reservation and reversal cancel out costs zero, and is present.
    const reversed = [
      { type: 'debit', amountFen: 70, orderId: key },
      { type: 'refund', amountFen: 70, orderId: reversalOrderId(key) },
    ]
    expect(effectiveDebitFensOf(reversed, [key]).get(key)).toBe(0)
  })
})
