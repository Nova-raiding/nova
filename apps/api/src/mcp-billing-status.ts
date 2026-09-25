export interface BillingStatusInputs {
  workspaceId: string
  balanceFen: number
  usage?: { includedTasks: number; usedTasks: number; remainingTasks: number }
  storeCapacitySnapshot: unknown
  pendingAuthorizationFen: number
  pendingActionCount: number
  canViewWorkspaceBilling: boolean
  pointBalance?: { availablePoints: number | null; reservedPoints: number | null; settledPoints: number | null; revision: number }
  capabilityEntitlements: unknown
  actionCards: unknown
  providerReady: boolean
}

export function billingStatusProjection(input: BillingStatusInputs) {
  const { workspaceId, balanceFen, usage, pointBalance } = input
  const balanceCny = (balanceFen / 100).toFixed(2)
  const pointsUnlocked = pointBalance?.availablePoints !== null && pointBalance !== undefined && pointBalance.availablePoints > 0
  return {
    schema_version: 'commercial.billing-status.v2',
    workspace_id: workspaceId,
    balance_state: pointBalance?.availablePoints === null || !pointBalance ? 'unknown' : 'known',
    available_points: pointBalance?.availablePoints ?? null,
    reserved_points: pointBalance?.reservedPoints ?? null,
    settled_points: pointBalance?.settledPoints ?? null,
    access_revision: pointBalance?.availablePoints === null || !pointBalance ? null : String(pointBalance.revision),
    allowed: pointBalance?.availablePoints !== null && pointBalance !== undefined && pointBalance.availablePoints > 0,
    balance_cny: balanceCny,
    plugin_access: { unlocked: pointsUnlocked, balance_cny: balanceCny, unlocks: pointsUnlocked ? ['图片/OCR解析', '创意Brief与预览', 'SEO/GEO标题', '发布任务'] : [] },
    model_access: { ownership: 'platform', user_key_required: false, access_state: pointsUnlocked ? 'included_quota_available' : 'recharge_required', message: pointsUnlocked ? '模型额度可用，生成时直接扣除创意点。' : '创意点不足，无法执行模型能力。' },
    action_entitlement: { overage_policy: 'wallet' },
    capability_entitlements: input.capabilityEntitlements,
    action_cards: input.actionCards,
    next_actions: ['commercial.access.get', 'creative-points.balance.get', 'commercial.catalog.get'],
    legacy_non_authoritative: { currency: 'CNY', wallet_balance_cny: balanceCny, pending_authorization_cny: (input.pendingAuthorizationFen / 100).toFixed(2), settlement_pending_count: input.pendingActionCount, billing_mode: process.env.PAYMENT_MODE === 'provider' ? 'provider' : 'fixture', historical_task_quota: usage ? { included_tasks: usage.includedTasks, used_tasks: usage.usedTasks, remaining_tasks: usage.remainingTasks } : null, store_capacity: input.storeCapacitySnapshot, provider_ready: process.env.PAYMENT_MODE === 'provider' && input.providerReady, note: '仅供历史对账；不得参与业务准入、恢复建议或 worker execution-check。' },
    viewer: { default_scope: 'mine', available_scopes: input.canViewWorkspaceBilling ? ['mine', 'workspace'] : ['mine'] },
  }
}
