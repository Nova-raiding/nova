import { createHmac, timingSafeEqual } from 'node:crypto'
import { DomainError } from '../../../packages/application/src/service.js'
import { getHttpOperationPolicy } from '../../../packages/contracts/src/index.js'

function safeEqual(leftValue: string, rightValue: string) {
  const left = Buffer.from(leftValue)
  const right = Buffer.from(rightValue)
  return left.length === right.length && timingSafeEqual(left, right)
}

const CUSTOMER_DATA_METHOD_PREFIXES = [
  'brand.', 'brand-unit.', 'catalog.', 'asset.', 'content.', 'deliverable.', 'feedback.', 'knowledge.',
  'sync.', 'task.', 'publish.', 'multimodal.',
] as const
const CUSTOMER_DATA_EXACT_METHODS = new Set([
  'platform.store.list',
  'platform.connect',
  // Keep the HTTP platform-account sync surface bound to the same live MCP
  // method used by the registered HTTP authorization policy. `platform.sync`
  // is not a MCP method and would make temporary customer-data grants/audits
  // diverge from the actual authorization contract.
  'platform.revoke',
  'canonical.product.consistency',
  'ops.audit.detail',
  'ops.support.tickets.list',
  'ops.support.ticket.get',
  'support.customer.replies.list',
  'ops.support.ticket.create',
  'ops.support.ticket.assign',
  'ops.support.ticket.transition',
  'ops.support.ticket.comment',
  'ops.support.sla.report',
  'ops.support.sla.correction.create',
  'ops.support.sla.correction.decide',
  'ops.alert.ack',
])
const CUSTOMER_DATA_READ_METHODS = new Set(['brand.get', 'brand.list', 'brand-unit.list', 'brand-unit.listing.list', 'catalog.search', 'catalog.categories', 'catalog.image.get', 'catalog.sync.get', 'deliverable.list', 'asset.list', 'asset.get', 'content.get', 'content.list', 'feedback.list', 'knowledge.rule.list', 'knowledge.asset.list', 'knowledge.learning.list', 'knowledge.competitor.list', 'task.history', 'task.timeline', 'publish.get', 'ops.audit.detail', 'support.customer.replies.list'])

type CustomerDataAccessGrant = {
  grantId: string
  actorId: string
  workspaceId: string
  scopes: readonly string[]
  issuedAt: number
  expiresAt: number
}

export function isCustomerDataMethod(method: string, params: Record<string, unknown> = {}) {
  if (method === 'ops.support.tickets.list' && params.platform_scope === 'platform') return false
  return CUSTOMER_DATA_EXACT_METHODS.has(method) || CUSTOMER_DATA_METHOD_PREFIXES.some(prefix => method === prefix || method.startsWith(prefix))
}

export function isCustomerDataWriteMethod(method: string) {
  return !CUSTOMER_DATA_READ_METHODS.has(method)
}

/** Map HTTP customer surfaces to the same temporary-grant boundary as MCP.
 * Platform operations must not get a second, weaker authorization path merely
 * by switching transports.  The method name is intentionally coarse here;
 * resource-level workspace/brand checks remain enforced by each route. */
export function customerDataMethodForHttp(method: string | undefined, path: string): string | undefined {
  if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method ?? '')) return undefined
  // Prefer the registered HTTP policy so temporary customer-data grants use
  // the exact MCP operation (including read-transport/write-semantic routes)
  // instead of a coarse transport-only approximation.
  const registeredPolicy = getHttpOperationPolicy(method, path)
  if (registeredPolicy?.authentication === 'identity' && registeredPolicy.mcpMethod && isCustomerDataMethod(registeredPolicy.mcpMethod)) return registeredPolicy.mcpMethod
  if (method === 'GET' && path === '/v1/platform-accounts') return 'platform.store.list'
  if (method === 'POST' && /^\/v1\/platform-accounts\/(jd|taobao|tmall|pinduoduo|xiaohongshu|douyin)\/authorize$/u.test(path)) return 'platform.connect'
  if (method === 'POST' && /^\/v1\/platform-accounts\/(jd|taobao|tmall|pinduoduo|xiaohongshu|douyin)\/sync$/u.test(path)) return 'catalog.sync'
  if (method === 'DELETE' && /^\/v1\/platform-accounts\/(jd|taobao|tmall|pinduoduo|xiaohongshu|douyin)$/u.test(path)) return 'platform.revoke'
  // Publish confirmation is a distinct high-risk MCP operation. Keep the
  // temporary customer-data grant bound to that exact policy rather than
  // widening it to the generic product-update boundary.
  if (method === 'POST' && path === '/v1/publish-jobs') return 'publish.confirm'
  const customerPath = /^\/v1\/(?:products|assets|tasks|content-versions|content|brand-profile|knowledge|sync-jobs|generation-jobs|image-generation-jobs|publish-jobs|delivery-readiness|canonical)(?:\/|$)/u.test(path)
  if (!customerPath) return undefined
  return method === 'GET' ? 'catalog.search' : 'catalog.product.update'
}

// Local Compose is an explicitly isolated pilot surface. It uses a fixed
// local Bearer token and wildcard workspace grant, so the Ops console can
// inspect the seeded workspace without pretending that a production gateway
// issued a customer-data grant. Production never enables this escape hatch.
export function localComposeOpsCustomerDataAccess() {
  return process.env.NODE_ENV !== 'production'
    && process.env.LOCAL_COMPOSE === 'true'
    && process.env.ALLOW_WILDCARD_WORKSPACE_GRANT === 'true'
}

function base64UrlDecode(value: string) {
  return Buffer.from(value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - value.length % 4) % 4), 'base64').toString('utf8')
}

/** Validate a gateway-issued, short-lived customer-data access grant. */
export function validateCustomerDataAccessGrant(raw: string | undefined, expected: { actorId: string; workspaceId: string; method: string; nowSeconds?: number }, secret = process.env.OPS_CUSTOMER_ACCESS_SIGNING_SECRET?.trim()): CustomerDataAccessGrant {
  const parts = raw?.trim().split('.') ?? []
  if (parts.length !== 3 || parts[0] !== 'v1') throw new DomainError('OPS_CUSTOMER_ACCESS_REQUIRED', 'platform_ops 访问客户营销数据必须携带有效的限时授权票据', 403)
  if (!secret) throw new DomainError('OPS_CUSTOMER_ACCESS_GRANT_UNAVAILABLE', '客户数据临时授权未配置签名密钥', 503)
  const payloadPart = parts[1]!
  const signature = createHmac('sha256', secret).update(`v1.${payloadPart}`).digest('base64url')
  if (!safeEqual(signature, parts[2]!)) throw new DomainError('OPS_CUSTOMER_ACCESS_INVALID', '客户数据临时授权票据签名无效', 403)
  let payload: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(base64UrlDecode(payloadPart))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid payload')
    payload = parsed as Record<string, unknown>
  } catch {
    throw new DomainError('OPS_CUSTOMER_ACCESS_INVALID', '客户数据临时授权票据内容无效', 403)
  }
  const grantId = typeof payload.grant_id === 'string' ? payload.grant_id.trim() : ''
  const actorId = typeof payload.actor_id === 'string' ? payload.actor_id.trim() : ''
  const workspaceId = typeof payload.workspace_id === 'string' ? payload.workspace_id.trim() : ''
  const scopes = Array.isArray(payload.scopes) ? payload.scopes.filter((value): value is string => typeof value === 'string').map(value => value.trim()).filter(Boolean) : []
  const issuedAt = typeof payload.issued_at === 'number' ? payload.issued_at : Number(payload.issued_at)
  const expiresAt = typeof payload.expires_at === 'number' ? payload.expires_at : Number(payload.expires_at)
  const nowSeconds = expected.nowSeconds ?? Math.floor(Date.now() / 1000)
  const requiredScope = isCustomerDataWriteMethod(expected.method) ? 'customer_data.write' : 'customer_data.read'
  if (!/^[A-Za-z0-9_-]{8,128}$/u.test(grantId) || actorId !== expected.actorId || workspaceId !== expected.workspaceId || !Number.isSafeInteger(issuedAt) || !Number.isSafeInteger(expiresAt) || issuedAt > nowSeconds + 60 || expiresAt <= nowSeconds || expiresAt - issuedAt > 15 * 60 || (!scopes.includes(requiredScope) && !scopes.includes('customer_data.admin'))) {
    throw new DomainError('OPS_CUSTOMER_ACCESS_INVALID', '客户数据临时授权票据已过期、越权或范围不匹配', 403)
  }
  return { grantId, actorId, workspaceId, scopes, issuedAt, expiresAt }
}

