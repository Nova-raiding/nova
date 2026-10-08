import { describe, expect, it } from 'vitest'
import { requireCommercialNotificationPollSuccess } from './main.js'

describe('commercial outbox poll lifecycle regression', () => {
  it('fails closed when notification failure counters are malformed instead of acknowledging the poll', () => {
    for (const failed of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => requireCommercialNotificationPollSuccess({ commercialNotifications: { failed } }))
        .toThrow('invalid notification failure count')
    }
  })
})
