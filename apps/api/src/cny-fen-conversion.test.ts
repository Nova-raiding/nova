import { describe, expect, it } from 'vitest'
import { chargeFenFromCny, scaleCnyToFen } from './server.js'

/**
 * The wallet debit and the reconciliation audit derive integer fen from a
 * computed CNY float (relay pricing emits up to 12 decimals). Scaling by 100
 * in binary floating point is not exact, and `Math.ceil` on the noisy result
 * bills one extra fen for a whole family of ordinary amounts. Every case below
 * is an amount a real relay pricing policy can produce, and the "noisy" column
 * is the reason the shared helper exists instead of a bare `Math.ceil`.
 */
const noisyAmounts: ReadonlyArray<{ cny: number; scaledFen: number; chargedFen: number; naiveCeilFen: number }> = [
  // `Math.ceil(cny * 100)` overcharges by exactly one fen on these amounts.
  { cny: 0.07, scaledFen: 7, chargedFen: 7, naiveCeilFen: 8 },
  { cny: 0.14, scaledFen: 14, chargedFen: 14, naiveCeilFen: 15 },
  { cny: 0.28, scaledFen: 28, chargedFen: 28, naiveCeilFen: 29 },
  { cny: 0.55, scaledFen: 55, chargedFen: 55, naiveCeilFen: 56 },
  { cny: 1.09, scaledFen: 109, chargedFen: 109, naiveCeilFen: 110 },
  { cny: 1.11, scaledFen: 111, chargedFen: 111, naiveCeilFen: 112 },
  // These carry the same binary noise but the naive expression lands below the
  // integer boundary, so they pin that the helper is exact rather than merely
  // "one fen more generous".
  { cny: 0.29, scaledFen: 29, chargedFen: 29, naiveCeilFen: 29 },
  { cny: 1.07, scaledFen: 107, chargedFen: 107, naiveCeilFen: 107 },
  { cny: 12.34, scaledFen: 1234, chargedFen: 1234, naiveCeilFen: 1234 },
  { cny: 0.05, scaledFen: 5, chargedFen: 5, naiveCeilFen: 5 },
  { cny: 19.99, scaledFen: 1999, chargedFen: 1999, naiveCeilFen: 1999 },
  // Genuine sub-fen fractions survive: only representation noise is removed.
  { cny: 0.025, scaledFen: 2.5, chargedFen: 3, naiveCeilFen: 3 },
  { cny: 123.456789, scaledFen: 12345.6789, chargedFen: 12346, naiveCeilFen: 12346 },
]

describe('CNY to fen conversion', () => {
  it('scales a computed CNY float to an exact fen number', () => {
    for (const { cny, scaledFen } of noisyAmounts) {
      const scaled = scaleCnyToFen(cny)
      // Amounts that are an exact number of fen must scale to an integer; the
      // sub-fen row keeps its true fraction (123.456789 CNY is 12345.6789 fen).
      if (Number.isInteger(scaledFen)) expect(Number.isInteger(scaled), `${cny} scaled to a non-integer: ${scaled}`).toBe(true)
      expect(scaled, `${cny} must scale to ${scaledFen} fen`).toBe(scaledFen)
    }
  })

  it('charges the exact fen amount instead of the binary-noise ceiling', () => {
    for (const { cny, chargedFen, naiveCeilFen } of noisyAmounts) {
      expect(chargeFenFromCny(cny), `${cny} must charge ${chargedFen} fen`).toBe(chargedFen)
      // The regression this pins: `Math.max(1, Math.ceil(cny * 100))` billed
      // `naiveCeilFen` for the amounts where the two differ, and the wallet
      // debit and the reconciliation audit shared that same expression, so the
      // audit recomputed the overcharge as correct and reported no mismatch.
      if (naiveCeilFen !== chargedFen) {
        expect(Math.max(1, Math.ceil(cny * 100)), `${cny} is expected to be a float-noise amount`).toBe(naiveCeilFen)
      }
    }
  })

  it('keeps the one-fen platform minimum for free usage', () => {
    for (const free of [0, 0.000001, 0.004, 0.0099]) {
      expect(chargeFenFromCny(free)).toBe(1)
      expect(scaleCnyToFen(free)).toBeLessThanOrEqual(1)
    }
  })

  it('never rounds a genuine fraction of a fen down to a lower integer fen', () => {
    // A real charge of 7.5 fen must still bill 8 fen: the tolerance the helper
    // removes is 1e-6 fen of representation noise, not fractional pricing.
    expect(chargeFenFromCny(0.075)).toBe(8)
    expect(scaleCnyToFen(0.075)).toBe(7.5)
  })
})
