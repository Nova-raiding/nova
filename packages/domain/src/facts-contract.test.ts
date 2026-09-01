import { describe, expect, it } from 'vitest'
import { confirmFact, isFactUsable, proposeFact, transitionFact, type FactField } from './facts.js'

const missingFact = (): FactField<string> => ({ id: 'fact_1', fieldPath: 'product.title', state: 'missing', version: 1 })

describe('fact state contract', () => {
  it('requires a sourced proposal before confirmation and increments revisions', () => {
    const proposed = proposeFact(missingFact(), 'A product', { type: 'merchant_input', reference: 'merchant://fact-1' })
    expect(proposed).toMatchObject({ ok: true, value: { state: 'pending_confirmation', version: 2, value: 'A product' } })
    if (!proposed.ok) return
    const confirmed = confirmFact(proposed.value, 'actor_1', '2026-09-01T00:00:00.000Z')
    expect(confirmed).toMatchObject({ ok: true, value: { state: 'confirmed', version: 3, confirmedBy: 'actor_1' } })
    expect(missingFact()).toEqual({ id: 'fact_1', fieldPath: 'product.title', state: 'missing', version: 1 })
  })

  it('rejects confirmation without actor, timestamp, source, or value', () => {
    expect(transitionFact(missingFact(), 'confirmed')).toMatchObject({ ok: false, error: { code: 'FACT_CONFIRMATION_REQUIRED' } })
    expect(proposeFact(missingFact(), 'value', { type: 'system', reference: ' ' })).toMatchObject({ ok: false, error: { code: 'FACT_CONFIRMATION_REQUIRED' } })
    const proposed = proposeFact(missingFact(), 'value', { type: 'system', reference: 'system://1' })
    if (!proposed.ok) throw new Error('fixture proposal failed')
    expect(confirmFact(proposed.value, ' ', '2026-09-01T00:00:00Z')).toMatchObject({ ok: false, error: { code: 'FACT_CONFIRMATION_REQUIRED' } })
    expect(confirmFact(proposed.value, 'actor_1', ' ')).toMatchObject({ ok: false, error: { code: 'FACT_CONFIRMATION_REQUIRED' } })
  })

  it('uses only confirmed and currently valid facts as content inputs', () => {
    const base: FactField<string> = { ...missingFact(), value: 'value', state: 'confirmed', version: 2, source: { type: 'official_api', reference: 'api://1' } }
    expect(isFactUsable(base, '2026-09-01T00:00:00Z')).toEqual({ ok: true, value: 'value' })
    expect(isFactUsable({ ...base, validFrom: '2026-09-02T00:00:00Z' }, '2026-09-01T00:00:00Z')).toMatchObject({ ok: false, error: { code: 'FACT_NOT_USABLE' } })
    expect(isFactUsable({ ...base, validTo: '2026-09-01T00:00:00Z' }, '2026-09-01T00:00:00Z')).toMatchObject({ ok: false, error: { code: 'FACT_NOT_USABLE' } })
    expect(isFactUsable({ ...base, state: 'conflict' }, '2026-09-01T00:00:00Z')).toMatchObject({ ok: false, error: { code: 'FACT_NOT_USABLE' } })
  })
})
