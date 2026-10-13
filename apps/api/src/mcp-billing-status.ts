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
  const canViewWorkspaceBilling = input.canViewWorkspaceBilling
  const balanceCny = (balanceFen / 100).toFixed(2)
  const availablePoints = canViewWorkspaceBilling ? pointBalance?.availablePoints ?? null : null
  const pointsKnown = canViewWorkspaceBilling && availablePoints !== null
  const pointsAvailable = pointsKnown ? availablePoints! > 0 : null
  const modelAccessState = !canViewWorkspaceBilling
    ? 'restricted'
    : !pointsKnown
      ? 'eligibility_unverified'
      : pointsAvailable
        ? 'eligibility_unverified'
        : 'recharge_required'
  const modelAccessMessage = !canViewWorkspaceBilling
    ? '当前身份无权查看工作区账务余额。'
    : !pointsKnown
      ? '创意点余额待确认；当前不能判断余额是否不足，也不能确认生成资格。'
      : pointsAvailable
        ? '点数余额可用；具体生成资格、套餐权益和模型门禁尚未在此查询，须由具体操作的服务端准入复核。'
        : '创意点余额为零，无法执行需要点数的模型能力。'
  const restrictedActionCards = Array.isArray(input.actionCards)
    ? input.actionCards.filter(card => card && typeof card === 'object' && !Array.isArray(card) && (card as { method?: unknown }).method === 'commercial.catalog.get')
    : []
  return {
    schema_version: 'commercial.billing-status.v2',
    workspace_id: workspaceId,
    balance_state: !canViewWorkspaceBilling ? 'restricted' : pointBalance?.availablePoints === null || !pointBalance ? 'unknown' : 'known',
    available_points: canViewWorkspaceBilling ? pointBalance?.availablePoints ?? null : null,
    reserved_points: canViewWorkspaceBilling ? pointBalance?.reservedPoints ?? null : null,
    settled_points: canViewWorkspaceBilling ? pointBalance?.settledPoints ?? null : null,
    access_revision: !canViewWorkspaceBilling || pointBalance?.availablePoints === null || !pointBalance ? null : String(pointBalance.revision),
    allowed: pointsKnown ? pointsAvailable : null,
    balance_cny: canViewWorkspaceBilling ? balanceCny : null,
    action_eligibility: !canViewWorkspaceBilling ? 'restricted' : 'not_checked',
    plugin_access: { unlocked: null, balance_available: pointsAvailable, eligibility_state: !canViewWorkspaceBilling ? 'restricted' : 'not_checked', balance_cny: canViewWorkspaceBilling ? balanceCny : null, unlocks: [] },
    model_access: { ownership: 'platform', user_key_required: false, access_state: modelAccessState, message: modelAccessMessage },
    action_entitlement: { overage_policy: 'wallet' },
    capability_entitlements: canViewWorkspaceBilling ? input.capabilityEntitlements : null,
    action_cards: canViewWorkspaceBilling ? input.actionCards : restrictedActionCards,
    next_actions: canViewWorkspaceBilling ? ['commercial.access.get', 'creative-points.balance.get', 'commercial.catalog.get'] : ['commercial.access.get', 'commercial.catalog.get'],
    legacy_non_authoritative: { currency: 'CNY', wallet_balance_cny: canViewWorkspaceBilling ? balanceCny : null, pending_authorization_cny: canViewWorkspaceBilling ? (input.pendingAuthorizationFen / 100).toFixed(2) : null, settlement_pending_count: canViewWorkspaceBilling ? input.pendingActionCount : null, billing_mode: canViewWorkspaceBilling ? process.env.PAYMENT_MODE === 'provider' ? 'provider' : 'fixture' : 'restricted', historical_task_quota: canViewWorkspaceBilling && usage ? { included_tasks: usage.includedTasks, used_tasks: usage.usedTasks, remaining_tasks: usage.remainingTasks } : null, store_capacity: canViewWorkspaceBilling ? input.storeCapacitySnapshot : null, provider_ready: canViewWorkspaceBilling ? process.env.PAYMENT_MODE === 'provider' && input.providerReady : null, note: '仅供历史对账；不得参与业务准入、恢复建议或 worker execution-check。' },
    viewer: { default_scope: 'mine', available_scopes: canViewWorkspaceBilling ? ['mine', 'workspace'] : ['mine'] },
  }
}
