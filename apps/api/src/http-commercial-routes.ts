import type { IncomingMessage, ServerResponse } from 'node:http'
import { DomainError } from '../../../packages/application/src/service.js'
import type { CommercialAccessService } from '../../../packages/application/src/commercial-access-service.js'
import type { CommercialPurchaseService } from '../../../packages/application/src/commercial-purchase-service.js'
import type { CommercialCatalogRepository, CreativePointRepository } from '../../../packages/persistence/src/index.js'
import { ERROR_CODES, validateMcpRequest } from '../../../packages/contracts/src/index.js'

type JsonObject = Record<string, unknown>

export interface HttpCommercialRouteDependencies {
  commercialAccessService: Pick<CommercialAccessService, 'decide'>
  commercialPurchaseService: Pick<CommercialPurchaseService, 'create' | 'paymentStatus'>
  creativePoints?: Pick<CreativePointRepository, 'getBalance' | 'listStatement'>
  commercialCatalog?: Pick<CommercialCatalogRepository, 'list'>
  /** Invokes the same authorized commercial handler used by MCP with trusted request scope. */
  callCommercialMethod?(method: string, params: JsonObject, workspaceId: string, req: IncomingMessage): Promise<unknown>
  resolveWorkspace(req: IncomingMessage): string
  requestActor(req: IncomingMessage): string
  body(req: IncomingMessage): Promise<JsonObject>
  required(input: JsonObject, key: string): string
  rethrowCommercialPurchaseError(error: unknown): never
  send(res: ServerResponse, status: number, workspaceId: string, data: unknown, error: null, req: IncomingMessage): void
}

/** Returns true when a commercial HTTP route sent its response. */
export async function handleHttpCommercialRoute(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  url: URL,
  deps: HttpCommercialRouteDependencies,
): Promise<boolean> {
  const { commercialAccessService, creativePoints, resolveWorkspace, body, required, send } = deps
  const invoke = async (method: string, input: JsonObject, status = 200): Promise<boolean> => {
    // The HTTP principal and header binding own the workspace/actor; the body
    // cannot supply an identity or commercial amount to the shared handler.
    const workspaceId = resolveWorkspace(req)
    if ('workspace_id' in input || 'actor_id' in input) throw new DomainError(ERROR_CODES.INVALID_REQUEST, '请求不能指定身份或工作区', 400)
    const validation = validateMcpRequest({ jsonrpc: '2.0', id: 'commercial-http', method, params: input })
    if (!validation.valid) throw new DomainError(ERROR_CODES.INVALID_REQUEST, '商业请求参数无效', 400, { issues: validation.errors })
    if (!deps.callCommercialMethod) throw new DomainError('COMMERCIAL_HTTP_ADAPTER_UNAVAILABLE', '商业统一处理器未配置', 503)
    send(res, status, workspaceId, await deps.callCommercialMethod(method, input, workspaceId, req), null, req)
    return true
  }
  if (req.method === 'GET' && path === '/v1/commercial/access') {
    const workspaceId = resolveWorkspace(req)
    const access = await commercialAccessService.decide({ surface: 'MCP', operation: 'commercial.access.get', workspace_id: workspaceId })
    if (access.outcome !== 'DECISION') throw new DomainError('COMMERCIAL_ACCESS_STATE_UNAVAILABLE', '商业访问状态未完成精确分类', 503, { outcome: access.outcome })
    send(res, 200, workspaceId, { decision: access.decision }, null, req)
    return true
  }
  if (req.method === 'GET' && path === '/v1/creative-points/balance') {
    const workspaceId = resolveWorkspace(req)
    const balance = await creativePoints?.getBalance(workspaceId)
    send(res, 200, workspaceId, { schema_version: 'creative-points.balance.v1', workspace_id: workspaceId, balance_state: balance?.availablePoints === null || !balance ? 'unknown' : 'known', available_points: balance?.availablePoints ?? null, reserved_points: balance?.reservedPoints ?? null, settled_points: balance?.settledPoints ?? null, access_revision: balance?.availablePoints === null || !balance ? null : String(balance.revision), updated_at: balance?.updatedAt ?? null }, null, req)
    return true
  }
  if (req.method === 'GET' && path === '/v1/creative-points/statement') {
    const workspaceId = resolveWorkspace(req)
    if (!creativePoints) throw new DomainError('CREATIVE_POINT_STATEMENT_REPOSITORY_UNAVAILABLE', '创意点流水读取仓储尚未配置', 503, { entries: null })
    const requestedLimit = url.searchParams.get('limit')
    const statementLimit = requestedLimit !== null && /^\d+$/u.test(requestedLimit) ? Math.min(100, Math.max(1, Number(requestedLimit))) : 50
    const requestedCursor = url.searchParams.get('cursor')
    let cursor: { createdAt: string; id: string } | undefined
    if (requestedCursor?.trim()) {
      try {
        const decoded = JSON.parse(Buffer.from(requestedCursor, 'base64url').toString('utf8')) as unknown
        if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded) || typeof (decoded as JsonObject).createdAt !== 'string' || !(decoded as { createdAt: string }).createdAt.trim() || Number.isNaN(Date.parse((decoded as { createdAt: string }).createdAt)) || typeof (decoded as JsonObject).id !== 'string' || !(decoded as { id: string }).id.trim()) throw new Error('invalid')
        cursor = { createdAt: (decoded as { createdAt: string }).createdAt, id: (decoded as { id: string }).id }
      } catch {
        throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'cursor 无效', 400)
      }
    }
    return invoke('creative-points.statement.list', { limit: String(statementLimit), ...(cursor ? { cursor: requestedCursor! } : {}) })
  }

  const decodeSegment = (value: string): string => {
    try {
      const decoded = decodeURIComponent(value)
      if (!decoded.trim() || /[\u0000-\u001f\u007f/]/u.test(decoded)) throw new Error('invalid')
      return decoded
    } catch { throw new DomainError(ERROR_CODES.INVALID_REQUEST, '商业请求路径参数无效', 400) }
  }
  const query = (): JsonObject => {
    const input: JsonObject = {}
    for (const [key, value] of url.searchParams) {
      if (key in input) throw new DomainError(ERROR_CODES.INVALID_REQUEST, '商业查询参数不能重复', 400)
      input[key] = value
    }
    return input
  }
  if (req.method === 'GET' && path === '/v1/commercial/catalog') return invoke('commercial.catalog.get', query())
  if (req.method === 'GET' && path === '/v1/commercial/subscription') return invoke('commercial.subscription.get', query())
  if (req.method === 'GET' && path === '/v1/commercial/notifications') return invoke('commercial.notifications.list', query())
  const notificationReadMatch = path.match(/^\/v1\/commercial\/notifications\/([^/]+)\/read$/u)
  if (req.method === 'POST' && notificationReadMatch) {
    const input = await body(req)
    if ('notification_id' in input) throw new DomainError(ERROR_CODES.INVALID_REQUEST, '通知由请求路径指定', 400)
    return invoke('commercial.notifications.mark-read', { ...input, notification_id: decodeSegment(notificationReadMatch[1]!) })
  }
  if (req.method === 'POST' && path === '/v1/commercial/orders') {
    const input = await body(req)
    const purchaseKind = required(input, 'purchase_kind')
    if (!['purchase', 'onboarding_once', 'upgrade', 'point_pack'].includes(purchaseKind)) throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'purchase_kind 无效', 400)
    return invoke('commercial.order.create', input, 201)
  }
  if (req.method === 'POST' && path === '/v1/commercial/upgrade-quotes') return invoke('commercial.upgrade.quote.create', await body(req), 201)
  if (req.method === 'POST' && path === '/v1/commercial/checkouts') return invoke('commercial.checkout.create', await body(req), 201)
  const quoteMatch = path.match(/^\/v1\/commercial\/upgrade-quotes\/([^/]+)$/u)
  if (req.method === 'GET' && quoteMatch) return invoke('commercial.upgrade.quote.get', { ...query(), upgrade_quote_id: decodeSegment(quoteMatch[1]!) })
  const requestMatch = path.match(/^\/v1\/commercial\/(order-requests|upgrade-quote-requests|checkout-requests)\/([^/]+)$/u)
  if (req.method === 'GET' && requestMatch) {
    const method = requestMatch[1] === 'order-requests' ? 'commercial.order.request.get' : requestMatch[1] === 'upgrade-quote-requests' ? 'commercial.upgrade.quote.request.get' : 'commercial.checkout.request.get'
    return invoke(method, { ...query(), idempotency_key: decodeSegment(requestMatch[2]!) })
  }
  const commercialPaymentMatch = path.match(/^\/v1\/commercial\/orders\/([^/]+)\/payment$/u)
  if (req.method === 'GET' && commercialPaymentMatch) return invoke('commercial.order.payment.get', { ...query(), order_id: decodeSegment(commercialPaymentMatch[1]!) })
  const paymentCreateMatch = path.match(/^\/v1\/commercial\/orders\/([^/]+)\/checkout$/u)
  if (req.method === 'POST' && paymentCreateMatch) {
    const input = await body(req)
    if ('order_id' in input) throw new DomainError(ERROR_CODES.INVALID_REQUEST, '订单由请求路径指定', 400)
    return invoke('commercial.order.payment.create', { ...input, order_id: decodeSegment(paymentCreateMatch[1]!) })
  }
  return false
}
