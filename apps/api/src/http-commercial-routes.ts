import type { IncomingMessage, ServerResponse } from 'node:http'
import { DomainError } from '../../../packages/application/src/service.js'
import type { CommercialAccessService } from '../../../packages/application/src/commercial-access-service.js'
import type { CommercialPurchaseService } from '../../../packages/application/src/commercial-purchase-service.js'
import type { CommercialCatalogRepository, CreativePointRepository } from '../../../packages/persistence/src/index.js'
import { ERROR_CODES } from '../../../packages/contracts/src/index.js'

type JsonObject = Record<string, unknown>

export interface HttpCommercialRouteDependencies {
  commercialAccessService: Pick<CommercialAccessService, 'decide'>
  commercialPurchaseService: Pick<CommercialPurchaseService, 'create' | 'paymentStatus'>
  creativePoints?: Pick<CreativePointRepository, 'getBalance' | 'listStatement'>
  commercialCatalog?: Pick<CommercialCatalogRepository, 'list'>
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
  const { commercialAccessService, commercialPurchaseService, creativePoints, commercialCatalog, resolveWorkspace, requestActor, body, required, rethrowCommercialPurchaseError, send } = deps
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
    const statement = await creativePoints.listStatement(workspaceId, { limit: statementLimit, ...(cursor ? { cursor } : {}) })
    send(res, 200, workspaceId, { schema_version: 'creative-points.statement.v1', entries: statement.items, next_cursor: statement.nextCursor ? Buffer.from(JSON.stringify(statement.nextCursor)).toString('base64url') : null }, null, req)
    return true
  }
  if (req.method === 'GET' && path === '/v1/commercial/catalog') {
    const workspaceId = resolveWorkspace(req)
    if (!commercialCatalog) throw new DomainError('COMMERCIAL_CATALOG_REPOSITORY_UNAVAILABLE', 'V2 商业目录仓储未配置', 503, { catalog: null })
    const catalog = await commercialCatalog.list({ includePrivate: false, capabilities: [] })
    if (!catalog.length) throw new DomainError('COMMERCIAL_CATALOG_UNAVAILABLE', '没有可展示的 V2 商业目录版本，不能回退到旧套餐数据', 503, { catalog: null })
    send(res, 200, workspaceId, { schema_version: 'commercial.catalog.v2', status: 'available', catalog }, null, req)
    return true
  }
  if (req.method === 'POST' && path === '/v1/commercial/orders') {
    const input = await body(req)
    const workspaceId = resolveWorkspace(req)
    const purchaseKind = required(input, 'purchase_kind')
    if (!['purchase', 'onboarding_once', 'upgrade', 'point_pack'].includes(purchaseKind)) throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'purchase_kind 无效', 400)
    try {
      send(res, 201, workspaceId, await commercialPurchaseService.create({ workspace_id: workspaceId, actor_id: requestActor(req), purchase_kind: purchaseKind as 'purchase' | 'onboarding_once' | 'upgrade' | 'point_pack', sku_code: required(input, 'sku_code'), idempotency_key: required(input, 'idempotency_key'), reason: required(input, 'reason') }), null, req)
      return true
    } catch (error) { rethrowCommercialPurchaseError(error) }
  }
  const commercialPaymentMatch = path.match(/^\/v1\/commercial\/orders\/([^/]+)\/payment$/u)
  if (req.method === 'GET' && commercialPaymentMatch) {
    const workspaceId = resolveWorkspace(req)
    try {
      send(res, 200, workspaceId, await commercialPurchaseService.paymentStatus({ workspace_id: workspaceId, actor_id: requestActor(req), order_id: decodeURIComponent(commercialPaymentMatch[1]!) }), null, req)
      return true
    } catch (error) { rethrowCommercialPurchaseError(error) }
  }
  return false
}
