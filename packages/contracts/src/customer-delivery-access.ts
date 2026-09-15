import { getMcpMethodPolicy } from './authz.js'
import { HTTP_OPERATION_POLICIES } from './http-authz.js'

// Recovery is deliberately an exact inventory, not a read-only/onboarding
// prefix: many such methods read customer content or create durable writes.
const recovery = new Set([
  'ops.session',
  'workspace.bootstrap', 'workspace.invitations.list', 'workspace.invitation.accept',
  'onboarding.status', 'workspace.health', 'platform.model.status',
  'platform.store.list', 'platform.connect', 'platform.revoke',
  'commercial.access.get', 'commercial.catalog.get', 'commercial.order.create',
  'commercial.order.payment.get', 'creative-points.balance.get',
  'creative-points.statement.list', 'commercial.service-boundary.accept',
  'billing.status', 'billing.recharge.create', 'billing.recharge.get', 'billing.recharge.list',
  'subscription.get', 'subscription.orders.list', 'subscription.order.create', 'subscription.change',
])

/** Invoke only AFTER the existing identity/capability/workbench authorization. */
export function requiresCustomerDeliveryAccess(surface: 'MCP' | 'HTTP', operation: string, params: Record<string, unknown> = {}): boolean {
  if (surface === 'HTTP') {
    const policy = HTTP_OPERATION_POLICIES.find(candidate => candidate.operation === operation)
    if (!policy) return true
    if (policy.authentication !== 'identity') return false
    if (policy.identityOnly) return false // Exact registered platform operations.
    return policy.mcpMethod ? requiresCustomerDeliveryAccess('MCP', policy.mcpMethod, params) : true
  }
  const policy = getMcpMethodPolicy(operation)
  if (policy?.scope === 'platform' && policy.workbench === 'platform') return false
  if (operation === 'merchant.start') {
    return ['requested_platform', 'requested_goal', 'attachment_count'].some(key => Object.prototype.hasOwnProperty.call(params, key))
  }
  if (operation === 'merchant.first_value') return params.example !== 'true'
  return !recovery.has(operation)
}
