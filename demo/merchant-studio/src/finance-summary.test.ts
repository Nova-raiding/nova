import { describe, expect, it } from 'vitest'
import { totalSettledConsumptionPoints } from './App.js'
import type { CreativePointStatementEntry } from './api.js'

const entry = (
  eventType: string,
  actualPoints?: number,
): CreativePointStatementEntry => ({
  id: `${eventType}-${actualPoints ?? 'none'}`,
  workspaceId: 'ws_finance',
  operationId: 'operation',
  eventType,
  pointsDelta: -1,
  availableAfter: 0,
  reservedAfter: 0,
  settledAfter: actualPoints ?? null,
  accessRevision: 1,
  createdAt: '2026-09-29T00:00:00.000Z',
  intent: actualPoints === undefined ? {} : { actual_points: actualPoints },
  grantSourceType: null,
  grantSourceId: null,
})

describe('finance lifetime settled consumption summary', () => {
  it('sums actual settled points and ignores reservations and releases', () => {
    expect(totalSettledConsumptionPoints([
      entry('settled', 240),
      entry('reserved', 500),
      entry('released'),
      entry('settled', 60),
    ], true)).toBe(300)
  })

  it('shows zero only for a successfully read, complete empty statement', () => {
    expect(totalSettledConsumptionPoints([], true)).toBe(0)
    expect(totalSettledConsumptionPoints(null, false)).toBeNull()
    expect(totalSettledConsumptionPoints([entry('settled', 240)], false)).toBeNull()
  })

  it.each([null, ''])('does not turn malformed settled actual_points (%s) into a complete zero', (actualPoints) => {
    const malformed = { ...entry('settled'), intent: { actual_points: actualPoints } }
    expect(totalSettledConsumptionPoints([malformed], true)).toBeNull()
  })
})
