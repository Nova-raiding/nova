import { describe, expect, it } from 'vitest'
import { notificationReadIntentScope } from './CommercialNotificationPanel'

describe('commercial notification read intents stay inside the API scope', () => {
  it('does not reuse an in-memory retry intent when the same notification ID appears in another tenant scope', () => {
    const tenantA = notificationReadIntentScope('/tenant-a/api', 'notice-1')
    const tenantB = notificationReadIntentScope('/tenant-b/api', 'notice-1')

    expect(tenantA).not.toBe(tenantB)
    expect(notificationReadIntentScope('/tenant-a/api', 'notice-1')).toBe(tenantA)
  })
})
