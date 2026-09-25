import type { IncomingMessage } from 'node:http'
import { DomainError } from '../../../packages/application/src/service.js'
import { CommercialPaymentError, type CommercialPaymentService } from '../../../packages/application/src/commercial-payment-service.js'
import type { CommercialAccessService } from '../../../packages/application/src/commercial-access-service.js'
import type { CommercialPurchaseService } from '../../../packages/application/src/commercial-purchase-service.js'
import { CommercialContractError } from '../../../packages/persistence/src/index.js'
import { ERROR_CODES } from '../../../packages/contracts/src/index.js'
import type { ApiPersistence } from './server.js'

type JsonObject = Record<string, unknown>

export const MCP_COMMERCIAL_METHODS = new Set([
  'commercial.access.get', 'creative-points.balance.get', 'creative-points.statement.list',
  'commercial.catalog.get', 'commercial.order.create', 'commercial.order.payment.get',
])

export interface CommercialMcpDependencies {
  access: CommercialAccessService
  purchase: CommercialPurchaseService
  checkout: () => CommercialPaymentService
  persistence: ApiPersistence
  ready: Promise<unknown>
  required: (params: JsonObject, key: string) => string
  actor: (req: IncomingMessage) => string
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
      return { schema_version: 'creative-points.statement.v1', entries: statement.items, next_cursor: statement.nextCursor ? Buffer.from(JSON.stringify(statement.nextCursor)).toString('base64url') : null }
    }
    case 'commercial.catalog.get': {
      await deps.ready
      if (!deps.persistence.commercialCatalog) throw new DomainError('COMMERCIAL_CATALOG_REPOSITORY_UNAVAILABLE', 'V2 商业目录仓储未配置', 503, { catalog: null })
      const catalog = await deps.persistence.commercialCatalog.list({ includePrivate: false, capabilities: [] })
      if (!catalog.length) throw new DomainError('COMMERCIAL_CATALOG_UNAVAILABLE', '没有可展示的 V2 商业目录版本，不能回退到旧套餐数据', 503, { catalog: null })
      return { schema_version: 'commercial.catalog.v2', status: 'available', catalog }
    }
    case 'commercial.order.create': {
      try {
        const idempotencyKey = deps.required(params, 'idempotency_key')
        const order = await deps.purchase.create({ workspace_id: workspaceId, actor_id: deps.actor(req), purchase_kind: deps.required(params, 'purchase_kind') as 'purchase' | 'onboarding_once' | 'upgrade' | 'point_pack', sku_code: deps.required(params, 'sku_code'), idempotency_key: idempotencyKey, reason: deps.required(params, 'reason') })
        if (order.payment_provider !== 'alipay' && order.payment_provider !== 'wechat') return order
        const checkout = await deps.checkout().createCheckout({ workspaceId, orderId: order.order_id, channel: order.payment_provider, idempotencyKey })
        return { ...order, payment_url: checkout.paymentUrl, provider_order_id: checkout.providerOrderId, checkout_expires_at: checkout.expiresAt, checkout_replayed: checkout.replayed }
      } catch (error) {
        if (error instanceof CommercialPaymentError || error instanceof CommercialContractError) deps.rethrowPayment(error)
        deps.rethrowPurchase(error)
      }
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
