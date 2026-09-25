import type { IncomingMessage, ServerResponse } from 'node:http'
import { DomainError, type MerchantService, type Platform, type Task, type TaskState } from '../../../packages/application/src/service.js'
import type { PostgresBusinessRepository } from '../../../packages/persistence/src/business-repository.js'
import { ERROR_CODES } from '../../../packages/contracts/src/index.js'

export interface HttpCatalogReadRouteDependencies {
  service: Pick<MerchantService, 'listProducts' | 'listTasks'>
  business?: Pick<PostgresBusinessRepository, 'listProductsPage' | 'listTasksPage'>
  resolveWorkspace(req: IncomingMessage, candidate?: unknown): string
  accessibleTaskBrandIds(req: IncomingMessage, workspaceId: string): Promise<readonly string[] | undefined>
  accessibleProductIds(req: IncomingMessage, workspaceId: string): Promise<ReadonlySet<string> | undefined>
  filterByTaskBrandAccess(req: IncomingMessage, workspaceId: string, tasks: Task[]): Promise<Task[]>
  send(res: ServerResponse, status: number, workspaceId: string, data: unknown, error: null, req: IncomingMessage): void
}

function paginationRequest(url: URL): { limit: number; offset: number } {
  const requestedLimit = url.searchParams.get('limit')
  const requestedOffset = url.searchParams.get('offset')
  const limit = requestedLimit === null ? 20 : Number(requestedLimit)
  const offset = requestedOffset === null ? 0 : Number(requestedOffset)
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(offset) || offset < 0) throw new DomainError(ERROR_CODES.INVALID_REQUEST, 'limit 必须为 1–100 的整数，offset 必须为非负整数', 400)
  return { limit, offset }
}

function paginatedResult<T>(url: URL, items: T[]) {
  const { limit, offset } = paginationRequest(url)
  return { items: items.slice(offset, offset + limit), total: items.length, limit, offset }
}

/** Returns true after handling a product or task collection read. */
export async function handleHttpCatalogReadRoute(req: IncomingMessage, res: ServerResponse, path: string, url: URL, deps: HttpCatalogReadRouteDependencies): Promise<boolean> {
  const { service, business, resolveWorkspace, accessibleTaskBrandIds, accessibleProductIds, filterByTaskBrandAccess, send } = deps
  if (req.method === 'GET' && path === '/v1/products') {
    const workspaceId = resolveWorkspace(req, url.searchParams.get('workspace_id') ?? undefined)
    const page = paginationRequest(url)
    const accessibleBrandIds = await accessibleTaskBrandIds(req, workspaceId)
    if (business) {
      const facts = url.searchParams.get('facts_confirmed')
      send(res, 200, workspaceId, await business.listProductsPage(workspaceId, {
        ...page,
        ...(accessibleBrandIds !== undefined ? { accessibleBrandIds } : {}),
        ...(url.searchParams.get('query') ? { query: url.searchParams.get('query')! } : {}),
        ...(url.searchParams.get('platform') ? { platform: url.searchParams.get('platform')! } : {}),
        ...(url.searchParams.get('account_id') ? { accountId: url.searchParams.get('account_id')! } : {}),
        ...(url.searchParams.get('store_name') ? { storeName: url.searchParams.get('store_name')! } : {}),
        ...(facts !== null ? { factsConfirmed: facts === 'true' } : {}),
      }), null, req)
      return true
    }
    const accessibleIds = await accessibleProductIds(req, workspaceId)
    const products = service.listProducts(workspaceId, {
      ...(url.searchParams.get('query') ? { query: url.searchParams.get('query')! } : {}),
      ...(url.searchParams.get('platform') ? { platform: url.searchParams.get('platform') as Platform } : {}),
      ...(url.searchParams.get('account_id') ? { accountId: url.searchParams.get('account_id')! } : {}),
      ...(url.searchParams.get('store_name') ? { storeName: url.searchParams.get('store_name')! } : {}),
    }).filter(product => accessibleIds === undefined || accessibleIds.has(product.id))
      .filter(product => url.searchParams.get('facts_confirmed') === null || product.factsConfirmed === (url.searchParams.get('facts_confirmed') === 'true'))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id))
    send(res, 200, workspaceId, paginatedResult(url, products), null, req)
    return true
  }
  if (req.method === 'GET' && path === '/v1/tasks') {
    const workspaceId = resolveWorkspace(req, url.searchParams.get('workspace_id') ?? undefined)
    const page = paginationRequest(url)
    if (business) {
      const accessibleBrandIds = await accessibleTaskBrandIds(req, workspaceId)
      send(res, 200, workspaceId, await business.listTasksPage(workspaceId, {
        ...page,
        ...(accessibleBrandIds !== undefined ? { accessibleBrandIds } : {}),
        ...(url.searchParams.get('query') ? { query: url.searchParams.get('query')! } : {}),
        ...(url.searchParams.get('platform') ? { platform: url.searchParams.get('platform')! } : {}),
        ...(url.searchParams.get('state') ? { state: url.searchParams.get('state')! } : {}),
        ...(url.searchParams.get('product_id') ? { productId: url.searchParams.get('product_id')! } : {}),
      }), null, req)
      return true
    }
    const tasks = await filterByTaskBrandAccess(req, workspaceId, service.listTasks(workspaceId, {
      ...(url.searchParams.get('query') ? { query: url.searchParams.get('query')! } : {}),
      ...(url.searchParams.get('platform') ? { platform: url.searchParams.get('platform') as Platform } : {}),
      ...(url.searchParams.get('state') ? { state: url.searchParams.get('state') as TaskState } : {}),
      ...(url.searchParams.get('product_id') ? { productId: url.searchParams.get('product_id')! } : {}),
    }))
    send(res, 200, workspaceId, paginatedResult(url, tasks), null, req)
    return true
  }
  return false
}
