import { describe, expect, it } from 'vitest'
import { authorizeCommercialNotification } from './commercial-notification-authorization.js'
import type { CommercialNotificationPublication, CommercialNotificationRecipient } from '../../../packages/persistence/src/commercial-notification-repository.js'

const recipient: CommercialNotificationRecipient = { workspaceId: 'ws', memberId: 'beneficiary', identityId: null, role: 'merchant_admin' }
const publication: CommercialNotificationPublication = { eventId: 'event', skuCode: 'private-sku', version: 1, visibility: 'private', payload: {}, publishedAt: '2026-10-05T00:00:00.000Z', notificationKind: 'purchase_result', beneficiaryMemberId: 'beneficiary' }

describe('commercial notification authorization', () => {
  it('allows a private purchase result for its exact frozen beneficiary with billing read', () => {
    expect(authorizeCommercialNotification(recipient, publication)).toBe(true)
  })

  it('denies another member, an absent binding, or a private catalog publication', () => {
    expect(authorizeCommercialNotification({ ...recipient, memberId: 'other' }, publication)).toBe(false)
    expect(authorizeCommercialNotification(recipient, { ...publication, beneficiaryMemberId: null })).toBe(false)
    expect(authorizeCommercialNotification(recipient, { ...publication, notificationKind: 'catalog_publication' })).toBe(false)
  })

  it('requires billing read even when the private beneficiary binding matches', () => {
    expect(authorizeCommercialNotification({ ...recipient, role: 'unknown_role' }, publication)).toBe(false)
  })
})
