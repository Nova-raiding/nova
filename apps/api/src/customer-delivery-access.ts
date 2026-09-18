import { DomainError } from '../../../packages/application/src/service.js'
import type { CustomerDeliveryRepository } from '../../../packages/persistence/src/customer-delivery-repository.js'

export type CustomerDeliveryAccess = { state: 'unbound' | 'pending' | 'ready'; allowed: boolean }

/** Live evidence read: no cached effectiveAt, login inference or workspace-wide activation. */
export async function readCustomerDeliveryAccess(repository: Pick<CustomerDeliveryRepository, 'getByIdentity'>, workspaceId: string, identityId: string): Promise<CustomerDeliveryAccess> {
  if (!workspaceId.trim() || !identityId.trim()) throw new DomainError('CUSTOMER_DELIVERY_ACCESS_UNAVAILABLE', '交付访问检查缺少可信身份或工作区，已阻断', 503)
  try {
    const delivery = await repository.getByIdentity(workspaceId, identityId)
    if (!delivery) return { state: 'unbound', allowed: true }
    if (delivery.workspaceId !== workspaceId || delivery.targetIdentityId !== identityId || !delivery.targetAccountId) throw new Error('DELIVERY_IDENTITY_BINDING_INVALID')
    const allowed = Boolean(delivery.effectiveAt)
    return { state: allowed ? 'ready' : 'pending', allowed }
  } catch {
    throw new DomainError('CUSTOMER_DELIVERY_ACCESS_UNAVAILABLE', '暂时无法核验账号交付状态，请稍后重试；未开放业务访问', 503)
  }
}

export function assertCustomerDeliveryAllowed(access: CustomerDeliveryAccess) {
  if (!access.allowed) throw new DomainError('CUSTOMER_DELIVERY_REQUIRED', '当前登录账号的交付尚未完成，请联系运营完成交付验收', 403, { delivery_access: access, recovery_methods: ['workspace.health', 'commercial.access.get', 'platform.store.list'] })
}

export function pendingCustomerDeliveryProjection(access: CustomerDeliveryAccess) {
  return {
    status: 'delivery_pending', delivery_access: access,
    message: '当前登录账号正在交付验收中。请联系运营；店铺接入、登录和购买恢复入口仍可使用。',
    next_actions: [
      { method: 'platform.store.list', reason: '检查店铺接入状态' },
      { method: 'commercial.access.get', reason: '查看商业访问和购买恢复状态' },
      { method: 'workspace.health', reason: '重新检查交付状态' },
    ],
    // Passing delivery does not supersede administrator or commercial gates.
    business_access: { allowed: false, blocked_by: ['customer_delivery'] },
  }
}
