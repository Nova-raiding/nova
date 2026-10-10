import { describe, expect, it } from 'vitest'
import { notificationPanelScope, notificationReadIntentScope } from './CommercialNotificationPanel'

describe('commercial notification read intents stay inside the API scope', () => {
  it('uses a different panel scope when the active merchant workspace changes on the same API', () => {
    const workspaceA = notificationPanelScope('/api', 'ws_alpha')
    const workspaceB = notificationPanelScope('/api', 'ws_beta')

    expect(workspaceA).not.toBe(workspaceB)
    expect(notificationPanelScope('/api', 'ws_alpha')).toBe(workspaceA)
    expect(notificationReadIntentScope('/api', 'notice-1', 'ws_alpha'))
      .not.toBe(notificationReadIntentScope('/api', 'notice-1', 'ws_beta'))
  })

  it('does not reuse an in-memory retry intent when the same notification ID appears in another tenant scope', () => {
    const tenantA = notificationReadIntentScope('/tenant-a/api', 'notice-1')
    const tenantB = notificationReadIntentScope('/tenant-b/api', 'notice-1')

    expect(tenantA).not.toBe(tenantB)
    expect(notificationReadIntentScope('/tenant-a/api', 'notice-1')).toBe(tenantA)
  })
})
