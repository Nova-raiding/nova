import { DomainError, type MerchantService } from '../../../packages/application/src/service.js'
import { CommercialCountCapacityError, resolveCommercialCountBenefit, type CommercialCountBenefitCode } from './commercial-count-capacity.js'
import { COMMERCIAL_PLATFORMS, type CommercialPlatform } from '../../../packages/persistence/src/index.js'
import type { Platform } from '../../../packages/application/src/service.js'
import type { ApiPersistence } from './server.js'

export interface CommercialCapacityDependencies {
  persistence(): Pick<ApiPersistence, 'commercial' | 'commercialContracts' | 'subscriptions'>
  memoryCommercial: NonNullable<ApiPersistence['commercial']>
  memorySubscriptions: NonNullable<ApiPersistence['subscriptions']>
  service: Pick<MerchantService, 'listPlatformAccounts'>
  isProduction(): boolean
}

export function createCommercialCapacity(deps: CommercialCapacityDependencies) {
  async function requireEnabledPlatform(workspaceId: string, platform: Platform) {
    if (!COMMERCIAL_PLATFORMS.includes(platform as CommercialPlatform)) return
    const setting = (await (deps.persistence().commercial ?? deps.memoryCommercial).listPlatformSettings(workspaceId)).find(item => item.platform === platform)
    if (setting?.enabled === false) throw new DomainError('PLATFORM_DISABLED', `${platform} 平台已被运营后台关闭，不能创建新任务或发布`, 409)
  }

  async function commercialBenefitQuantity(workspaceId: string, code: CommercialCountBenefitCode): Promise<number | null> {
    const repository = deps.persistence().commercialContracts
    if (!repository) return null
    const snapshots = await repository.listEntitlementSnapshots(workspaceId, 100)
    try {
      return await resolveCommercialCountBenefit({ workspaceId, code, snapshots })
    } catch (error) {
      if (!(error instanceof CommercialCountCapacityError)) throw error
      const unavailable = error.code === 'COMMERCIAL_ENTITLEMENT_UNAVAILABLE'
      const ambiguous = error.code === 'COMMERCIAL_ENTITLEMENT_AMBIGUOUS'
      throw new DomainError(error.code, unavailable ? 'V2 商业权益额度证据不可用，无法安全判定套餐额度' : ambiguous ? '检测到多个重叠的 V2 商业权益，无法安全判定套餐额度' : '当前工作区没有有效的 V2 商业权益，无法使用套餐额度', unavailable ? 503 : ambiguous ? 409 : 402, {
        next_actions: ['commercial.catalog.get', 'commercial.order.create', 'commercial.access.get'],
      })
    }
  }

  async function storeCapacity(workspaceId: string) {
    const commercialIncluded = await commercialBenefitQuantity(workspaceId, 'max_stores')
    const subscription = await (deps.persistence().subscriptions ?? deps.memorySubscriptions).get(workspaceId)
    const used = deps.service.listPlatformAccounts(workspaceId).filter(account => account.tokenState !== 'revoked').length
    if (commercialIncluded !== null) return { used, included: commercialIncluded, remaining: Math.max(0, commercialIncluded - used), planCode: 'commercial_v2', planName: 'V2 商业权益' }
    const included = Math.max(0, subscription.includedStores)
    return { used, included, remaining: Math.max(0, included - used), planCode: subscription.planCode, planName: subscription.planName }
  }

  async function requireCommercialCountCapacity(input: { workspaceId: string; code: CommercialCountBenefitCode; used: number; label: string }) {
    const included = await commercialBenefitQuantity(input.workspaceId, input.code)
    if (included === null || input.used <= included) return { used: input.used, included }
    throw new DomainError('COMMERCIAL_QUOTA_EXCEEDED', `当前套餐已使用 ${input.used}/${included}${input.label}`, 402, {
      used: input.used,
      included,
      quota: input.code,
      next_actions: ['commercial.catalog.get', 'commercial.order.create', 'subscription.change'],
      action_cards: commercialActionCards(),
    })
  }

  async function requireStoreCapacity(workspaceId: string) {
    if (!deps.isProduction() && process.env.ENFORCE_STORE_CAPACITY !== 'true') return
    const capacity = await storeCapacity(workspaceId)
    if (capacity.used >= capacity.included) throw new DomainError('STORE_QUOTA_EXCEEDED', `当前套餐已使用 ${capacity.used}/${capacity.included} 家店铺`, 402, { ...capacity, next_actions: ['升级套餐增加店铺数', '购买店铺加购包'], action_cards: commercialActionCards() })
  }

  return { requireEnabledPlatform, commercialBenefitQuantity, storeCapacity, requireCommercialCountCapacity, requireStoreCapacity }
}

export function commercialActionCards() {
  return [
    { method: 'subscription.change', label: '升级套餐增加店铺数', required_inputs: ['to_plan_code', 'billing_cycle', 'channel', 'reason', 'idempotency_key'], input_schema: { type: 'object', properties: { to_plan_code: { type: 'string' }, billing_cycle: { type: 'string', enum: ['monthly', 'annual'] }, channel: { type: 'string', enum: ['alipay'] }, reason: { type: 'string' }, idempotency_key: { type: 'string' } }, required: ['to_plan_code', 'billing_cycle', 'channel', 'reason', 'idempotency_key'] }, confirmation: 'interactive_confirmation' },
    { method: 'ops.commercial.addons.list', label: '查看店铺加购包', arguments: {}, confirmation: 'none' },
  ]
}

export function billingActionCards() {
  return [
    { method: 'commercial.catalog.get', label: '查看可售点数套餐', required_inputs: [], confirmation: 'none' },
    { method: 'creative-points.balance.get', label: '查看创意点余额', required_inputs: [], confirmation: 'none' },
  ]
}
