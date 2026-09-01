import { describe, expect, it } from 'vitest'
import { projectCommercialEntitlement } from './commercial-entitlement-projection.js'

const valid = {
  plan: 'growth',
  period: { start: '2026-09-01T00:00:00.000Z', end: '2026-10-01T00:00:00.000Z' },
  status: 'active',
  sourceVersion: 'plan-growth-v3',
  checksum: 'a'.repeat(64),
}

describe('commercial entitlement projection', () => {
  it('returns a complete available projection for verified evidence', () => {
    expect(projectCommercialEntitlement(valid)).toEqual({ ...valid, status: 'available' })
  })

  it('redacts all fields when an available snapshot is incomplete', () => {
    expect(projectCommercialEntitlement({ ...valid, checksum: undefined })).toEqual({
      plan: null, period: null, status: 'unknown', sourceVersion: null, checksum: null,
    })
  })

  it('rejects malformed checksums, periods, and source versions', () => {
    for (const input of [
      { ...valid, checksum: 'fixture' },
      { ...valid, period: { ...valid.period, end: valid.period.start } },
      { ...valid, sourceVersion: ' ' },
    ]) {
      expect(projectCommercialEntitlement(input).status).toBe('unknown')
      expect(projectCommercialEntitlement(input).plan).toBeNull()
    }
  })

  it('keeps known non-usable subscription states blocked and redacted', () => {
    for (const status of ['active_restricted', 'paused', 'past_due', 'canceled', 'expired', 'blocked']) {
      expect(projectCommercialEntitlement({ ...valid, status })).toEqual({
        plan: null, period: null, status: 'blocked', sourceVersion: null, checksum: null,
      })
    }
  })

  it('does not infer availability for missing or unknown source states', () => {
    for (const status of [undefined, 'fixture', 'pending']) {
      expect(projectCommercialEntitlement({ ...valid, status })).toEqual({
        plan: null, period: null, status: 'unknown', sourceVersion: null, checksum: null,
      })
    }
  })

  it('accepts the explicit available source state', () => {
    expect(projectCommercialEntitlement({ ...valid, status: 'available' }).status).toBe('available')
  })

  it('does not mutate caller-owned input', () => {
    const input = structuredClone(valid)
    const projection = projectCommercialEntitlement(input)
    expect(input).toEqual(valid)
    expect(projection.period).not.toBe(input.period)
  })
})
