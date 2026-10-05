import { capabilitiesForRoles, resolveCanonicalRoles } from '../../../packages/contracts/src/index.js'
import type { CommercialNotificationAuthorizer } from '../../../packages/persistence/src/commercial-notification-repository.js'

/** Catalog notices may be public; private purchase results are visible only to
 * the exact member frozen as the order beneficiary and only with billing read. */
export const authorizeCommercialNotification: CommercialNotificationAuthorizer = (recipient, publication) => {
  const canReadBilling = capabilitiesForRoles(resolveCanonicalRoles({ memberRole: recipient.role })).includes('billing.self.read')
  const publicCatalogOrResult = publication.visibility === 'public'
  const exactPrivatePurchaseBeneficiary = publication.visibility === 'private'
    && publication.notificationKind === 'purchase_result'
    && Boolean(publication.beneficiaryMemberId)
    && publication.beneficiaryMemberId === recipient.memberId
  return canReadBilling && (publicCatalogOrResult || exactPrivatePurchaseBeneficiary)
}
