import { describe, expect, it } from 'vitest'
import { creativePointRequestOwnership, mayReleaseCreativePointReservation } from './creative-point-reservation-ownership.js'

describe('creative point reservation ownership', () => {
  it('allows only the request that created the exact active reservation to release it', () => {
    const created = creativePointRequestOwnership({ value: { id: 'reservation_1' }, replayed: false })
    const replayed = creativePointRequestOwnership({ value: { id: 'reservation_1' }, replayed: true })

    expect(mayReleaseCreativePointReservation(created, { id: 'reservation_1', status: 'active' })).toBe(true)
    expect(mayReleaseCreativePointReservation(replayed, { id: 'reservation_1', status: 'active' })).toBe(false)
    expect(mayReleaseCreativePointReservation(created, { id: 'reservation_2', status: 'active' })).toBe(false)
    expect(mayReleaseCreativePointReservation(created, { id: 'reservation_1', status: 'settled' })).toBe(false)
  })
})
