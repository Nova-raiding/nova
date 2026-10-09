import { DomainError } from '../../../packages/application/src/service.js'
import { ERROR_CODES } from '../../../packages/contracts/src/index.js'
import type { ApiPersistence } from './server.js'
import { commercialOpsPageLimit } from './ops/commercial-ops-read-model.js'

type Params = Record<string, unknown>
type TimelinePersistence = Pick<ApiPersistence, 'commercialContracts' | 'creativePoints' | 'modelUsage' | 'serviceFulfillment' | 'operations'>
type CommercialContractRow = { id: string; createdAt: string }
type CommercialContractPage<T> = { items: T[]; hasMore: boolean }
type TimelineCursor = { workspaceId: string; fromAt?: string; toAt?: string; status: string; occurredAt: string; id: string }

function encodeTimelineCursor(value: TimelineCursor) {
  return Buffer.from(JSON.stringify(value)).toString('base64url')
}

function decodeTimelineCursor(value: unknown, expected: Pick<TimelineCursor, 'workspaceId' | 'fromAt' | 'toAt' | 'status'>): TimelineCursor | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string' || value.length > 4096) throw new DomainError(ERROR_CODES.INVALID_REQUEST, '商业时间线分页游标无效', 400)
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Partial<TimelineCursor>
    if (!parsed || typeof parsed !== 'object' || parsed.workspaceId !== expected.workspaceId || parsed.fromAt !== expected.fromAt || parsed.toAt !== expected.toAt || parsed.status !== expected.status || typeof parsed.occurredAt !== 'string' || !Number.isFinite(Date.parse(parsed.occurredAt)) || typeof parsed.id !== 'string' || !parsed.id.trim()) {
      throw new Error('invalid cursor')
    }
    return { workspaceId: parsed.workspaceId, ...(parsed.fromAt ? { fromAt: parsed.fromAt } : {}), ...(parsed.toAt ? { toAt: parsed.toAt } : {}), status: parsed.status, occurredAt: new Date(parsed.occurredAt).toISOString(), id: parsed.id }
  } catch {
    throw new DomainError(ERROR_CODES.INVALID_REQUEST, '商业时间线分页游标无效或与当前工作区/筛选条件不匹配', 400)
  }
}

export function paginateCommercialTimeline<T extends { occurred_at: string; id: string }>(events: readonly T[], input: { workspaceId: string; fromAt?: string; toAt?: string; status: string; cursor?: unknown; limit: number }) {
  const cursor = decodeTimelineCursor(input.cursor, input)
  const ordered = [...events].sort((left, right) => Date.parse(right.occurred_at) - Date.parse(left.occurred_at) || right.id.localeCompare(left.id))
  const cursorTime = cursor ? Date.parse(cursor.occurredAt) : undefined
  const remaining = cursor
    ? ordered.filter(event => Date.parse(event.occurred_at) < cursorTime! || (Date.parse(event.occurred_at) === cursorTime && event.id.localeCompare(cursor.id) < 0))
    : ordered
  const items = remaining.slice(0, input.limit)
  const hasMore = remaining.length > items.length
  const last = items.at(-1)
  return {
    items,
    total: ordered.length,
    truncated: hasMore,
    nextCursor: hasMore && last ? encodeTimelineCursor({ workspaceId: input.workspaceId, ...(input.fromAt ? { fromAt: input.fromAt } : {}), ...(input.toAt ? { toAt: input.toAt } : {}), status: input.status, occurredAt: last.occurred_at, id: last.id }) : null,
  }
}

export async function listCommercialContractRowsWithStatus<T extends CommercialContractRow>(
  list: (options: { limit: number; cursor?: { createdAt: string; id: string } }) => Promise<CommercialContractPage<T>>,
  maxRows = 500,
): Promise<{ items: T[]; truncated: boolean }> {
  const rows: T[] = []
  let cursor: { createdAt: string; id: string } | undefined
  let sourceHasMore = false
  while (rows.length < maxRows) {
    const limit = Math.min(200, maxRows - rows.length)
    const page = await list({ limit, ...(cursor ? { cursor } : {}) })
    rows.push(...page.items.slice(0, limit))
    const last = page.items.at(-1)
    sourceHasMore = page.hasMore
    if (!page.hasMore || !last) break
    cursor = { createdAt: last.createdAt, id: last.id }
  }
  return { items: rows, truncated: rows.length >= maxRows && sourceHasMore }
}

export async function listCommercialContractRows<T extends CommercialContractRow>(
  list: (options: { limit: number; cursor?: { createdAt: string; id: string } }) => Promise<CommercialContractPage<T>>,
  maxRows = 500,
): Promise<T[]> {
  return (await listCommercialContractRowsWithStatus(list, maxRows)).items
}

export interface CommercialOpsTimelineDependencies {
  persistence: TimelinePersistence
  fallbackOperations: NonNullable<ApiPersistence['operations']>
  required(params: Params, key: string): string
}

export async function commercialOpsTimeline(params: Params, deps: CommercialOpsTimelineDependencies) {
  const { persistence, fallbackOperations, required } = deps
  const targetWorkspaceId = required(params, 'target_workspace_id')
  const parseAt = (value: unknown) => { if (typeof value !== 'string' || !value.trim()) return undefined; const parsed = Date.parse(value); return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined }
  const fromAt = parseAt(params.from_at)
  const toAt = parseAt(params.to_at)
  if ((params.from_at && !fromAt) || (params.to_at && !toAt) || (fromAt && toAt && fromAt > toAt)) throw new DomainError(ERROR_CODES.INVALID_REQUEST, '时间范围无效', 400)
  const status = typeof params.status === 'string' ? params.status.trim().toLowerCase() : ''
  const events: Array<Record<string, unknown>> = []
  const inWindow = (at: string) => (!fromAt || at >= fromAt) && (!toAt || at <= toAt)
  const add = (event: Record<string, unknown>) => {
    const at = String(event.occurred_at ?? '')
    if (inWindow(at) && (!status || String(event.status ?? '').toLowerCase() === status)) events.push(event)
  }
  const { commercialContracts, creativePoints, modelUsage, serviceFulfillment } = persistence
  if (!commercialContracts || !creativePoints || !modelUsage || !serviceFulfillment) {
    throw new DomainError('COMMERCIAL_TIMELINE_REPOSITORY_UNAVAILABLE', '商业时间线依赖的事实仓储未完整配置，禁止返回不完整时间线', 503)
  }
  const [ordersPage, entitlementsPage, ledger, usage, allocations, audits] = await Promise.all([
    listCommercialContractRowsWithStatus(options => commercialContracts.listOrders(targetWorkspaceId, options)),
    listCommercialContractRowsWithStatus(options => commercialContracts.listEntitlementSnapshots(targetWorkspaceId, options)),
    creativePoints.listStatement(targetWorkspaceId, { limit: 500 }),
    modelUsage.listForStatement(targetWorkspaceId),
    serviceFulfillment.listAllocations(targetWorkspaceId, 500),
    (persistence.operations ?? fallbackOperations).list(targetWorkspaceId, 500),
  ])
  const { items: orders } = ordersPage
  const { items: entitlements } = entitlementsPage
  let serviceEventsTruncated = false
  for (const item of orders) add({ id: `order:${item.id}`, workspace_id: targetWorkspaceId, kind: 'order', status: item.status, occurred_at: item.createdAt, operation_id: null, trace_id: item.idempotencyKey, request_id: item.idempotencyKey, actor_id: null, resource_id: item.id, reason: null, evidence: { sku_code: item.skuCode, paid_at: item.paidAt } })
  for (const item of entitlements) add({ id: `entitlement:${item.id}`, workspace_id: targetWorkspaceId, kind: 'entitlement', status: item.periodStatus, occurred_at: item.createdAt, operation_id: null, trace_id: null, request_id: null, actor_id: null, resource_id: item.id, reason: null, evidence: { sku_code: item.skuCode, checksum: item.checksum } })
  for (const item of ledger.items) add({ id: `ledger:${item.id}`, workspace_id: targetWorkspaceId, kind: `points.${item.eventType}`, status: item.eventType, occurred_at: item.createdAt, operation_id: item.operationId, trace_id: item.operationId, request_id: null, actor_id: null, resource_id: item.id, reason: null, evidence: { intent: item.intent, access_revision: item.accessRevision } })
  for (const item of usage) add({ id: `model-usage:${item.id}`, workspace_id: targetWorkspaceId, kind: 'model.usage', status: item.settlementStatus, occurred_at: item.observedAt, operation_id: item.actionId ?? null, trace_id: typeof item.metadata?.trace_id === 'string' ? item.metadata.trace_id : item.providerRequestId ?? null, request_id: item.providerRequestId ?? null, actor_id: null, resource_id: item.id, reason: item.resolutionReason ?? null, evidence: { modality: item.modality, model: item.model, total_tokens: item.totalTokens ?? null, cost_cny: item.costCny ?? null } })
  for (const allocation of allocations) {
    const serviceEvents = await serviceFulfillment.listEvents(targetWorkspaceId, allocation.id, 500)
    serviceEventsTruncated ||= serviceEvents.length >= 500
    for (const item of serviceEvents) add({ id: `service:${item.id}`, workspace_id: targetWorkspaceId, kind: `service.${item.type}`, status: item.type, occurred_at: item.createdAt, operation_id: typeof item.evidence.operation_id === 'string' ? item.evidence.operation_id : allocation.id, trace_id: typeof item.evidence.trace_id === 'string' ? item.evidence.trace_id : item.idempotencyKey, request_id: item.idempotencyKey, actor_id: item.actorId, resource_id: allocation.id, reason: item.reason, evidence: item.evidence })
  }
  for (const item of audits) add({ id: `audit:${item.id}`, workspace_id: targetWorkspaceId, kind: `audit.${item.action}`, status: 'audited', occurred_at: item.createdAt, operation_id: typeof item.after.operation_id === 'string' ? item.after.operation_id : null, trace_id: typeof item.after.trace_id === 'string' ? item.after.trace_id : null, request_id: typeof item.after.request_id === 'string' ? item.after.request_id : null, actor_id: item.actorId, resource_id: item.resourceId, reason: item.reason, evidence: { before: item.before, after: item.after } })
  events.sort((a, b) => String(b.occurred_at).localeCompare(String(a.occurred_at)) || String(b.id).localeCompare(String(a.id)))
  const limit = commercialOpsPageLimit(params.limit, 100)
  const page = paginateCommercialTimeline(events as Array<{ occurred_at: string; id: string }>, { workspaceId: targetWorkspaceId, fromAt, toAt, status, cursor: params.cursor, limit })
  const sourceTruncated = ordersPage.truncated || entitlementsPage.truncated || Boolean(ledger.nextCursor) || allocations.length >= 500 || audits.length >= 500 || serviceEventsTruncated
  return { schema_version: 'commercial.timeline.v1', items: page.items, total: page.total, truncated: page.truncated, source_truncated: sourceTruncated, next_cursor: page.nextCursor, filters: { workspace_id: targetWorkspaceId, from_at: fromAt ?? null, to_at: toAt ?? null, status: status || null } }
}
