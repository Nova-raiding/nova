import { projectCommercialUpgradeQuote } from './commercial-quote-view.js'
import { DomainError } from '../../../packages/application/src/service.js'
import type { CommercialCatalogRepository, CommercialCatalogSkuSnapshot } from '../../../packages/persistence/src/commercial-catalog-repository.js'
import type { PostgresCommercialContractRepository, CommercialOrderV2 } from '../../../packages/persistence/src/commercial-contract-repository.js'
import { issueCommercialPreview, confirmCommercialPreview } from './mcp-commercial-receipts.js'
import type { CreateCommercialOrderInput } from '../../../packages/persistence/src/commercial-contract-repository.js'
export const MCP_OPS_PURCHASE_METHODS = new Set(['ops.commercial.order.preview', 'ops.commercial.order.create', 'ops.commercial.upgrade.quote.create', 'ops.commercial.upgrade.quote.get', 'ops.commercial.order.request.get', 'ops.commercial.upgrade.quote.request.get', 'ops.commercial.checkout.preview', 'ops.commercial.checkout.create', 'ops.commercial.checkout.request.get'])
type Params = Record<string, unknown>
export function projectFrozenSku(sku: CommercialCatalogSkuSnapshot) {
  return { name: typeof sku.payload.name === 'string' ? sku.payload.name : sku.code, sku_code: sku.code, version: sku.version, version_id: sku.versionId, price_fen: sku.priceFen, currency: sku.currency, quantity: 1, cycle: sku.payload.cycle ?? null, benefits: sku.benefits, checksum: sku.checksum }
}
export async function handleOpsCommercialPurchase(method: string, params: Params, deps: {
  catalog?: CommercialCatalogRepository; contracts?: PostgresCommercialContractRepository; actorId: string
  required(input: Params, key: string): string
  previewSigningKey?: string
  paymentProvider(): string
  view(order: CommercialOrderV2, code: string): Promise<unknown>
}) {
  const { catalog, contracts, required } = deps
  if (!catalog || !contracts) throw new DomainError('COMMERCIAL_PURCHASE_UNAVAILABLE', '商品与交易仓储未配置', 503)
  const workspaceId = required(params, 'target_workspace_id')
  const assertBeneficiary = async (memberId: string) => {
    if (!/^[0-9a-f-]{36}$/iu.test(memberId)) throw new DomainError('INVALID_REQUEST','beneficiary_member_id 必须是有效的企业成员标识',400)
    const beneficiaryMember = await contracts.getActiveWorkspaceMember(workspaceId,memberId)
    if (!beneficiaryMember) throw new DomainError('COMMERCIAL_BENEFICIARY_REQUIRED','指定商家成员不属于所选企业或未激活',409)
  }
  if (method === 'ops.commercial.order.request.get') {
    const order = await contracts.findOrderByIdempotencyKey(workspaceId, deps.actorId, required(params, 'idempotency_key'))
    return order ? deps.view(order.order, '') : null
  }
  if (method === 'ops.commercial.upgrade.quote.request.get') {
    const quote = await contracts.findQuoteByIdempotencyKey(workspaceId, deps.actorId, required(params, 'idempotency_key'))
    return quote ? projectCommercialUpgradeQuote(quote) : null
  }
  if (method === 'ops.commercial.checkout.request.get') {
    const key = required(params, 'idempotency_key')
    const orders = await Promise.all(['onboarding','subscription'].map(suffix => contracts.findOrderByIdempotencyKey(workspaceId, deps.actorId, `${key}:${suffix}`)))
    if (orders.every(order => !order)) return null
    if (orders.some(order => !order)) throw new DomainError('COMMERCIAL_CHECKOUT_CONFLICT', '首购状态需要核对', 409)
    return { checkout_id: orders[0]!.order.checkoutId, orders: await Promise.all(orders.map(order => deps.view(order!.order, ''))), amount_fen: orders.reduce((total, order) => total + order!.order.amountFen, 0), currency: 'CNY' }
  }
  if (method === 'ops.commercial.checkout.preview' || method === 'ops.commercial.checkout.create') {
    const beneficiaryMemberId = required(params,'beneficiary_member_id')
    await assertBeneficiary(beneficiaryMemberId)
    const key = method.endsWith('.create') ? required(params, 'idempotency_key') : null
    if (key) {
      const [opening, subscription] = await Promise.all(['onboarding','subscription'].map(suffix => contracts.findOrderByIdempotencyKey(workspaceId, deps.actorId, `${key}:${suffix}`)))
      if (opening || subscription) {
        if (!opening || !subscription || opening.snapshot.sku.code !== required(params,'onboarding_sku_code') || subscription.snapshot.sku.code !== required(params,'subscription_sku_code')) throw new DomainError('COMMERCIAL_CHECKOUT_CONFLICT','幂等键已绑定另一首购意图，请查询原单',409)
        if (opening.order.beneficiaryMemberId !== beneficiaryMemberId || subscription.order.beneficiaryMemberId !== beneficiaryMemberId) throw new DomainError('COMMERCIAL_CHECKOUT_CONFLICT','首购记录与指定客户不匹配，请查原订单',409)
        const original = await contracts.createFirstCheckout({workspaceId,actorId:deps.actorId,onboardingSku:opening.snapshot.sku,subscriptionSku:subscription.snapshot.sku,beneficiaryMemberId,paymentProvider:opening.order.paymentProvider,idempotencyKey:key,reason:required(params,'reason'),expectedOnboardingSkuVersionId:opening.order.skuVersionId,expectedSubscriptionSkuVersionId:subscription.order.skuVersionId})
        return {checkout_id:original.checkoutId,orders:await Promise.all([deps.view(original.onboarding,''),deps.view(original.subscription,'')]),amount_fen:original.amountFen,currency:'CNY',replayed:true}
      }
    }
    const [opening, subscription] = await Promise.all([required(params,'onboarding_sku_code'),required(params,'subscription_sku_code')].map(code => catalog.resolveApprovedExecutableSku(code,{includePrivate:false,capabilities:[]})))
    if (opening!.kind !== 'onboarding' || subscription!.kind !== 'monthly' || opening!.priceFen === null || subscription!.priceFen === null) throw new DomainError('COMMERCIAL_PURCHASE_KIND_MISMATCH','需要已批准开通费和首期套餐',409)
    const portfolio = await contracts.getSubscriptionSummary({workspaceId})
    const provider = deps.paymentProvider()
    const preview = { workspace_id: workspaceId, actor_id: deps.actorId, beneficiary_member_id: beneficiaryMemberId, lines: [{purchase_kind:'onboarding_once',snapshot:projectFrozenSku(opening!),amount_fen:opening!.priceFen},{purchase_kind:'purchase',snapshot:projectFrozenSku(subscription!),amount_fen:subscription!.priceFen,depends_on:'onboarding_once'}], amount_fen:opening!.priceFen+subscription!.priceFen, currency:'CNY', payment_provider:provider, onboarding_qualified:portfolio.onboardingQualified, current:portfolio.current,future:portfolio.future,reason:required(params,'reason') }
    if (method.endsWith('.preview')) return {schema_version:'commercial.checkout.preview.v1',...preview,...issueCommercialPreview(preview,'ops-checkout',deps.previewSigningKey)}
    confirmCommercialPreview(required(params,'preview_hash'),preview,'ops-checkout',deps.previewSigningKey)
    const checkout = await contracts.createFirstCheckout({workspaceId,actorId:deps.actorId,onboardingSku:opening!,subscriptionSku:subscription!,beneficiaryMemberId,paymentProvider:provider,idempotencyKey:key!,reason:required(params,'reason'),expectedOnboardingSkuVersionId:opening!.versionId,expectedSubscriptionSkuVersionId:subscription!.versionId})
    return {checkout_id:checkout.checkoutId,orders:await Promise.all([deps.view(checkout.onboarding,opening!.code),deps.view(checkout.subscription,subscription!.code)]),amount_fen:checkout.amountFen,currency:'CNY'}
  }
  if (method === 'ops.commercial.upgrade.quote.create') return projectCommercialUpgradeQuote(await contracts.createUpgradeQuote({ workspaceId, actorId: deps.actorId, targetSkuCode: required(params, 'target_sku_code'), idempotencyKey: required(params, 'idempotency_key') }))
  if (method === 'ops.commercial.upgrade.quote.get') {
    const quote = await contracts.getUpgradeQuote(workspaceId, required(params, 'upgrade_quote_id'))
    if (!quote) throw new DomainError('COMMERCIAL_UPGRADE_QUOTE_NOT_FOUND', '升级报价不存在', 404)
    return projectCommercialUpgradeQuote(quote)
  }
  const code = required(params, 'sku_code')
  const kind = required(params, 'purchase_kind') as NonNullable<CreateCommercialOrderInput['purchaseKind']>
  const beneficiaryMemberId = required(params,'beneficiary_member_id')
  await assertBeneficiary(beneficiaryMemberId)
  if (!['onboarding_once', 'purchase', 'renewal', 'upgrade', 'point_pack'].includes(kind)) throw new DomainError('INVALID_REQUEST', 'purchase_kind 无效', 400)
  if (method === 'ops.commercial.order.create') {
    const key=required(params,'idempotency_key'), prior=await contracts.findOrderByIdempotencyKey(workspaceId,deps.actorId,key)
    if (prior) {
      if (prior.snapshot.sku.code !== code) throw new DomainError('COMMERCIAL_CATALOG_CONFLICT','幂等键已绑定另一商品，请查询原单',409)
      // Let the repository compare its canonical original intent before any
      // catalog resolution, portfolio read or expired preview rejection.
      if (prior.order.beneficiaryMemberId !== beneficiaryMemberId) throw new DomainError('COMMERCIAL_IDEMPOTENCY_CONFLICT','幂等键已绑定其他指定客户',409)
      const order=await contracts.createOrder({workspaceId,sku:prior.snapshot.sku,...(kind==='upgrade' ? {} : {expectedSkuVersionId:prior.order.skuVersionId}),paymentProvider:prior.order.paymentProvider,createdByActorId:deps.actorId,idempotencyKey:key,reason:required(params,'reason'),purchaseKind:kind,beneficiaryMemberId,...(typeof params.upgrade_quote_id==='string'?{upgradeQuoteId:params.upgrade_quote_id}:{}),...(typeof params.checkout_id==='string'?{checkoutId:params.checkout_id}:{}),...(typeof params.onboarding_order_id==='string'?{onboardingOrderId:params.onboarding_order_id}:{})})
      return deps.view(order,code)
    }
  }
  let sku = await catalog.resolveApprovedExecutableSku(code, { includePrivate: false, capabilities: [] })
  const expectedKind = kind === 'onboarding_once' ? 'onboarding' : kind === 'point_pack' ? 'point_pack' : 'monthly'
  if (sku.kind !== expectedKind) throw new DomainError('COMMERCIAL_PURCHASE_KIND_MISMATCH', '购买意图和商品类别不一致', 409)
  const provider = deps.paymentProvider()
  const portfolio = await contracts.getSubscriptionSummary({ workspaceId })
  let amountFen = sku.priceFen
  if (kind === 'upgrade') {
    const quote = await contracts.getUpgradeQuote(workspaceId, required(params, 'upgrade_quote_id'))
    if (!quote || quote.targetSkuCode !== code) throw new DomainError('COMMERCIAL_UPGRADE_QUOTE_REQUIRED', '需要当前目标套餐的冻结升级报价', 409)
    if (!quote.targetSnapshot) throw new DomainError('COMMERCIAL_UPGRADE_QUOTE_REQUIRED','冻结目标商品快照不可用',409)
    sku = quote.targetSnapshot
    amountFen = quote.amountFen
  }
  const preview = { workspace_id: workspaceId, actor_id: deps.actorId, beneficiary_member_id: beneficiaryMemberId, sku_code: code, purchase_kind: kind, amount_fen: amountFen, currency: 'CNY', payment_provider: provider, snapshot: projectFrozenSku(sku), onboarding_qualified: portfolio.onboardingQualified, current: portfolio.current, future: portfolio.future, upgrade_quote_id: params.upgrade_quote_id ?? null, checkout_id: params.checkout_id ?? null, onboarding_order_id: params.onboarding_order_id ?? null, reason: required(params, 'reason'), sale_revision: kind==='upgrade' ? null : sku.saleRevision }
  if (method.endsWith('.preview')) return { schema_version: 'commercial.order.preview.v1', ...preview, ...issueCommercialPreview(preview,'ops-order',deps.previewSigningKey) }
  confirmCommercialPreview(required(params,'preview_hash'),preview,'ops-order',deps.previewSigningKey)
  const order = await contracts.createOrder({ workspaceId, sku, ...(kind==='upgrade'?{}:{expectedSkuVersionId:sku.versionId}), paymentProvider: provider, createdByActorId: deps.actorId, idempotencyKey: required(params, 'idempotency_key'), reason: required(params, 'reason'), purchaseKind: kind, beneficiaryMemberId, ...(typeof params.upgrade_quote_id === 'string' ? { upgradeQuoteId: params.upgrade_quote_id } : {}), ...(typeof params.checkout_id === 'string' ? { checkoutId: params.checkout_id } : {}), ...(typeof params.onboarding_order_id === 'string' ? { onboardingOrderId: params.onboarding_order_id } : {}) })
  return deps.view(order, code)
}
