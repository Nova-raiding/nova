import { describe, expect, it } from 'vitest'
import { evaluateServiceCapacityGate } from './service-capacity.js'

describe('service capacity sales gate', () => {
  it('allows a commitment below 80% of the next-30-day schedulable minutes', () => {
    expect(evaluateServiceCapacityGate({ schedulableMinutes: 1000, committedMinutes: 700, requestedMinutes: 99 })).toMatchObject({
      ok: true,
      value: { allowed: true, projectedMinutes: 799, thresholdMinutes: 800, reason: 'capacity_available' },
    })
  })

  it('blocks when a commitment reaches the 80% threshold', () => {
    expect(evaluateServiceCapacityGate({ schedulableMinutes: 1000, committedMinutes: 700, requestedMinutes: 100 })).toMatchObject({
      ok: true,
      value: { allowed: false, projectedMinutes: 800, thresholdMinutes: 800, utilizationPercent: 80, reason: 'capacity_threshold_reached' },
    })
  })

  it('blocks a request that crosses the threshold even when current usage is below it', () => {
    expect(evaluateServiceCapacityGate({ schedulableMinutes: 125, committedMinutes: 90, requestedMinutes: 11 })).toMatchObject({
      ok: true,
      value: { allowed: false, projectedMinutes: 101, thresholdMinutes: 100 },
    })
  })

  it('rejects empty, negative, fractional, and invalid threshold inputs', () => {
    expect(evaluateServiceCapacityGate({ schedulableMinutes: 0, committedMinutes: 0, requestedMinutes: 15 })).toMatchObject({ ok: false, error: { code: 'SERVICE_CAPACITY_INVALID' } })
    expect(evaluateServiceCapacityGate({ schedulableMinutes: 100, committedMinutes: -1, requestedMinutes: 15 })).toMatchObject({ ok: false, error: { code: 'SERVICE_CAPACITY_INVALID' } })
    expect(evaluateServiceCapacityGate({ schedulableMinutes: 100, committedMinutes: 0, requestedMinutes: 15.5 })).toMatchObject({ ok: false, error: { code: 'SERVICE_CAPACITY_INVALID' } })
    expect(evaluateServiceCapacityGate({ schedulableMinutes: 100, committedMinutes: 0, requestedMinutes: 15, thresholdPercent: 100.5 })).toMatchObject({ ok: false, error: { code: 'SERVICE_CAPACITY_INVALID' } })
  })
})
