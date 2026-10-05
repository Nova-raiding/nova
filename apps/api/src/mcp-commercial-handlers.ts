import type { IncomingMessage } from 'node:http'
import { projectCommercialUpgradeQuote } from './commercial-quote-view.js'
import { DomainError } from '../../../packages/application/src/service.js'
import { CommercialPaymentError, type CommercialPaymentService } from '../../../packages/application/src/commercial-payment-service.js'
import type { CommercialAccessService } from '../../../packages/application/src/commercial-access-service.js'
import type { CommercialPurchaseService } from '../../../packages/application/src/commercial-purchase-service.js'
import { CommercialContractError } from '../../../packages/persistence/src/index.js'
import { ERROR_CODES } from '../../../packages/contracts/src/index.js'
import type { ApiPersistence } from './server.js'

type JsonObject = Record<string, unknown>

export function parseCommercialNotificationCursor(value: unknown): { published_at: string; event_id: string } | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') throw new DomainError('INVALID_REQUEST', '通知游标无效', 400)
  let decoded: unknown
  try { decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) } catch { throw new DomainError('INVALID_REQUEST', '通知游标无效', 400) }
  if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) throw new DomainError('INVALID_REQUEST', '通知游标无效', 400)
  const row = decoded as Record<string, unknown>
  if (typeof row.published_at !== 'string' || !Number.isFinite(Date.parse(row.published_at))
    || typeof row.event_id !== 'string' || !/^(?:publication:|result:)?[a-z0-9_:-]{1,200}$/i.test(row.event_id)) {
    throw new DomainError('INVALID_REQUEST', '通知游标无效', 400)
  }
  return { published_at: row.published_at, event_id: row.event_id }
}

export function parseCommercialNotificationLimit(value: unknown): number {
  if (value === undefined) return 50
  const limit = typeof value === 'number' || typeof value === 'string' ? Number(value) : NaN
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new DomainError('INVALID_REQUEST', '通知条数必须为 1 至 100 的整数', 400)
  return limit
}

export const MCP_COMMERCIAL_METHODS = new Set([
  'commercial.access.get', 'creative-points.balance.get', 'creative-points.statement.list',
  'commercial.catalog.get', 'commercial.order.create', 'commercial.order.payment.get', 'commercial.order.payment.create',
  'commercial.upgrade.quote.create', 'commercial.upgrade.quote.get', 'commercial.upgrade.quote.request.get', 'commercial.order.request.get',
  'commercial.subscription.get', 'commercial.notifications.list', 'commercial.notifications.mark-read', 'commercial.checkout.create', 'commercial.checkout.request.get',
])

export interface CommercialMcpDependencies {
  access: CommercialAccessService
  purchase: CommercialPurchaseService
  checkout: () => CommercialPaymentService
  persistence: ApiPersistence
  ready: Promise<unknown>
  required: (params: JsonObject, key: string) => string
  actor: (req: IncomingMessage) => string
  viewOrder(order: Awaited<ReturnType<NonNullable<ApiPersistence['commercialContracts']>['createOrder']>>, code: string): Promise<unknown>
  memberId(req: IncomingMessage, workspaceId: string): Promise<string>
  paymentProvider(): string
  rethrowPayment: (error: unknown) => never
  rethrowPurchase: (error: unknown) => never
}

/** Called after the shared MCP schema, identity, workspace and commercial gates. */
export async function handleCommercialMcpMethod(method: string, params: JsonObject, workspaceId: string, req: IncomingMessage, deps: CommercialMcpDependencies): Promise<unknown> {
  switch (method) {
    case 'commercial.access.get': {
      const access = await deps.access.decide({ surface: 'MCP', operation: 'commercial.access.get', workspace_id: workspaceId })
      if (access.outcome !== 'DECISION') throw new DomainError('COMMERCIAL_ACCESS_STATE_UNAVAILABLE', '商业访问状态未完成精确分类', 503, { outcome: access.outcome })
      return { decision: access.decision }
    }
    case 'creative-points.balance.get': {
      await deps.ready
      const balance = await deps.persistence.creativePoints?.getBalance(workspaceId)
      return {
        schema_version: 'creative-points.balance.v1',
        workspace_id: workspaceId,
        balance_state: balance?.availablePoints === null || !balance ? 'unknown' : 'known',
        available_points: balance?.availablePoints ?? null,
        reserved_points: balance?.reservedPoints ?? null,
        settled_points: balance?.settledPoints ?? null,
        access_revision: balance?.availablePoints === null || !balance ? null : String(balance.revision),
        updated_at: balance?.updatedAt ?? null,
      }
    }
    case 'creative-points.statement.list': {
      await deps.ready
      if (!deps.persistence.creativePoints) throw new DomainError('CREATIVE_POINT_STATEMENT_REPOSITORY_UNAVAILABLE', '创意点流水读取仓储尚未配置', 503, { entries: null })
      const limit = typeof params.limit === 'string' && /^\d+$/u.test(params.limit) ? Math.min(100, Math.max(1, Number(params.limit))) : 50
      let cursor: { createdAt: string; id: string } | undefined
      if (typeof params.cursor === 'string' && params.cursor.trim()) {
        try {
          const decoded = JSON.parse(Buffer.from(params.cursor, 'base64url').toString('utf8')) as unknown
          if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded) || !('createdAt' in decoded) || typeof decoded.createdAt !== 'string' || !('id' in decoded) || typeof decoded.id !== 'string') throw new Error('invalid')
          cursor = { createdAt: decoded.createdAt, id: decoded.id }
        } catch { throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'cursor 无效', 400) }
      }
      const statement = await deps.persistence.creativePoints.listStatement(workspaceId, { limit, ...(cursor ? { cursor } : {}) })
      const origins = await deps.persistence.commercialPointOrigins?.readStatementOrigins(workspaceId, statement.items.map(entry => entry.id)).catch(() => undefined)
      return { schema_version: 'creative-points.statement.v1', entries: statement.items.map(entry => ({ ...entry, commercial_origin: origins?.[entry.id] ?? { status: 'unknown', kind: null, source_order_id: null, sku_version_id: null, schedule_id: null, sequence: null, grant_id: null } })), next_cursor: statement.nextCursor ? Buffer.from(JSON.stringify(statement.nextCursor)).toString('base64url') : null }
    }
    case 'commercial.catalog.get': {
      await deps.ready
      if (!deps.persistence.commercialCatalog) throw new DomainError('COMMERCIAL_CATALOG_REPOSITORY_UNAVAILABLE', 'V2 商业目录仓储未配置', 503, { catalog: null })
      const rows = await deps.persistence.commercialCatalog.list({ includePrivate: false, capabilities: [] })
      const catalog = rows.filter(item => item.saleState === 'on_sale' && item.currentSaleVersionId === item.versionId && item.lifecycle === 'approved' && item.executable)
      return { schema_version: 'commercial.catalog.v2', status: 'available', catalog }
    }
    case 'commercial.order.create': {
      try {
        const idempotencyKey = deps.required(params, 'idempotency_key')
        const order = await deps.purchase.create({ workspace_id: workspaceId, actor_id: deps.actor(req), purchase_kind: deps.required(params, 'purchase_kind') as 'purchase' | 'onboarding_once' | 'upgrade' | 'point_pack', sku_code: deps.required(params, 'sku_code'), idempotency_key: idempotencyKey, reason: deps.required(params, 'reason'), ...(typeof params.upgrade_quote_id === 'string' ? { upgrade_quote_id: params.upgrade_quote_id } : {}), ...(typeof params.checkout_id === 'string' ? { checkout_id: params.checkout_id } : {}), ...(typeof params.onboarding_order_id === 'string' ? { onboarding_order_id: params.onboarding_order_id } : {}) })
        return order
      } catch (error) {
        if (error instanceof CommercialPaymentError || error instanceof CommercialContractError) deps.rethrowPayment(error)
        deps.rethrowPurchase(error)
      }
    }
    case 'commercial.order.payment.create': {
      try {
        const orderId = deps.required(params, 'order_id'), key = deps.required(params, 'idempotency_key')
        const order = await deps.purchase.paymentStatus({ workspace_id: workspaceId, actor_id: deps.actor(req), order_id: orderId })
        if (order.payment_provider !== 'alipay' && order.payment_provider !== 'wechat') return order
        const checkout = await deps.checkout().createCheckout({ workspaceId, orderId, channel: order.payment_provider, idempotencyKey: key })
        return { ...order, payment_url: checkout.paymentUrl, provider_order_id: checkout.providerOrderId, checkout_expires_at: checkout.expiresAt, checkout_replayed: checkout.replayed }
      } catch (error) { deps.rethrowPayment(error) }
    }
    case 'commercial.upgrade.quote.create':
    case 'commercial.upgrade.quote.get':
    case 'commercial.upgrade.quote.request.get': {
      await deps.ready
      const contracts = deps.persistence.commercialContracts
      if (!contracts) throw new DomainError('COMMERCIAL_PURCHASE_UNAVAILABLE', '交易仓储未配置', 503)
      const quote = method.endsWith('.create') ? await contracts.createUpgradeQuote({ workspaceId, actorId: deps.actor(req), targetSkuCode: deps.required(params, 'target_sku_code'), idempotencyKey: deps.required(params, 'idempotency_key') })
        : method.endsWith('.request.get') ? await contracts.findQuoteByIdempotencyKey(workspaceId, deps.actor(req), deps.required(params, 'idempotency_key'))
        : await contracts.getUpgradeQuote(workspaceId, deps.required(params, 'upgrade_quote_id'))
      if (!quote && !method.endsWith('.request.get')) throw new DomainError('COMMERCIAL_UPGRADE_QUOTE_NOT_FOUND', '升级报价不存在', 404)
      return quote ? projectCommercialUpgradeQuote(quote) : null
    }
    case 'commercial.order.request.get': {
      await deps.ready
      if (!deps.persistence.commercialContracts) throw new DomainError('COMMERCIAL_PURCHASE_UNAVAILABLE', '交易仓储未配置', 503)
      const order = await deps.persistence.commercialContracts.findOrderByIdempotencyKey(workspaceId, deps.actor(req), deps.required(params, 'idempotency_key'))
      return order ? deps.viewOrder(order.order, '') : null
    }
    case 'commercial.checkout.create':
    case 'commercial.checkout.request.get': {
      await deps.ready
      const contracts = deps.persistence.commercialContracts, catalog = deps.persistence.commercialCatalog
      if (!contracts || !catalog) throw new DomainError('COMMERCIAL_PURCHASE_UNAVAILABLE', '首购交易仓储未配置', 503)
      const key = deps.required(params, 'idempotency_key')
      let orders
      if (method.endsWith('.request.get')) {
        const found = await Promise.all(['onboarding', 'subscription'].map(suffix => contracts.findOrderByIdempotencyKey(workspaceId, deps.actor(req), `${key}:${suffix}`)))
        if (found.every(order => !order)) return null
        if (found.some(order => !order)) throw new DomainError('COMMERCIAL_CHECKOUT_CONFLICT', '首购合同状态需人工核对', 409)
        orders = found.filter((order): order is NonNullable<typeof order> => Boolean(order)).map(result => result.order)
      } else {
        const [onboardingSku, subscriptionSku] = await Promise.all([deps.required(params, 'onboarding_sku_code'), deps.required(params, 'subscription_sku_code')].map(code => catalog.resolveApprovedExecutableSku(code, { includePrivate: false, capabilities: [] })))
        const checkout = await contracts.createFirstCheckout({ workspaceId, actorId: deps.actor(req), onboardingSku: onboardingSku!, subscriptionSku: subscriptionSku!, paymentProvider: deps.paymentProvider(), idempotencyKey: key, reason: deps.required(params, 'reason') })
        orders = [checkout.onboarding, checkout.subscription]
      }
      return { checkout_id: orders[0]!.checkoutId, orders: await Promise.all(orders.map(order => deps.viewOrder(order, ''))), amount_fen: orders.reduce((total, order) => total + order.amountFen, 0), currency: 'CNY' }
    }
    case 'commercial.subscription.get': {
      await deps.ready
      if (!deps.persistence.commercialContracts) throw new DomainError('COMMERCIAL_ENTITLEMENT_UNAVAILABLE', '套餐合同仓储未配置', 503)
      const summary = await deps.persistence.commercialContracts.getSubscriptionSummary({ workspaceId })
      const gifts = await deps.persistence.commercialPointOrigins?.readOnboardingGifts(workspaceId).catch(() => ({ status: 'unknown' as const, plans: null, blockers: ['onboarding_gift_source_unavailable'] })) ?? { status: 'unknown', plans: null, blockers: ['onboarding_gift_source_not_configured'] }
      return { schema_version: 'commercial.subscription.v1', status: 'available', onboarding_qualified: summary.onboardingQualified, onboarding_gifts: gifts, current: summary.current, future: summary.future, packs: summary.packs, history: summary.history, orders: summary.orders, support_handoff: deps.persistence.support ? { status: 'available', entry_path: '/v1/support/requests', method: 'POST', owner: '平台运营支持', blockers: [] } : { status: 'blocked', owner: '平台运营支持', blockers: ['support_project_entry_not_configured'] } }
    }
    case 'commercial.notifications.mark-read': {
      await deps.ready
      if (!deps.persistence.commercialNotifications) throw new DomainError('COMMERCIAL_NOTIFICATION_UNAVAILABLE', '商业通知仓储未配置', 503)
      const memberId = await deps.memberId(req, workspaceId)
      return deps.persistence.commercialNotifications.markRead(workspaceId, memberId, { notificationId: deps.required(params, 'notification_id'), idempotencyKey: deps.required(params, 'idempotency_key') })
    }
    case 'commercial.notifications.list': {
      await deps.ready
      if (!deps.persistence.commercialNotifications) throw new DomainError('COMMERCIAL_NOTIFICATION_UNAVAILABLE', '商业通知仓储未配置', 503)
      const cursor = parseCommercialNotificationCursor(params.cursor)
      const memberId = await deps.memberId(req, workspaceId)
      const page = await deps.persistence.commercialNotifications.list(workspaceId, memberId, { limit: parseCommercialNotificationLimit(params.limit), ...(cursor ? { cursor } : {}) })
      return { schema_version: 'commercial.notifications.v1', items: page.items, next_cursor: page.next_cursor ? Buffer.from(JSON.stringify(page.next_cursor)).toString('base64url') : null }
    }
    case 'commercial.order.payment.get': {
      try {
        return await deps.purchase.paymentStatus({ workspace_id: workspaceId, actor_id: deps.actor(req), order_id: deps.required(params, 'order_id') })
      } catch (error) { deps.rethrowPurchase(error) }
    }
    default:
      throw new Error(`Unsupported commercial MCP method: ${method}`)
  }
}
