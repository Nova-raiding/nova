import { DomainError } from '../../../packages/application/src/service.js'
import { ERROR_CODES } from '../../../packages/contracts/src/index.js'
import type { ApiPersistence } from './server.js'
import { commercialOpsPageLimit } from './ops/commercial-ops-read-model.js'

type Params = Record<string, unknown>
type TimelinePersistence = Pick<ApiPersistence, 'commercialContracts' | 'creativePoints' | 'modelUsage' | 'serviceFulfillment' | 'operations'>
type CommercialContractRow = { id: string; createdAt: string }
type CommercialContractPage<T> = { items: T[]; hasMore: boolean }

export async function listCommercialContractRows<T extends CommercialContractRow>(
  list: (options: { limit: number; cursor?: { createdAt: string; id: string } }) => Promise<CommercialContractPage<T>>,
  maxRows = 500,
): Promise<T[]> {
  const rows: T[] = []
  let cursor: { createdAt: string; id: string } | undefined
  while (rows.length < maxRows) {
    const limit = Math.min(200, maxRows - rows.length)
    const page = await list({ limit, ...(cursor ? { cursor } : {}) })
    rows.push(...page.items.slice(0, limit))
    const last = page.items.at(-1)
    if (!page.hasMore || !last) break
    cursor = { createdAt: last.createdAt, id: last.id }
  }
  return rows
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
  const [orders, entitlements, ledger, usage, allocations, audits] = await Promise.all([
    listCommercialContractRows(options => commercialContracts.listOrders(targetWorkspaceId, options)),
    listCommercialContractRows(options => commercialContracts.listEntitlementSnapshots(targetWorkspaceId, options)),
    creativePoints.listStatement(targetWorkspaceId, { limit: 500 }),
    modelUsage.listForStatement(targetWorkspaceId),
    serviceFulfillment.listAllocations(targetWorkspaceId, 500),
    (persistence.operations ?? fallbackOperations).list(targetWorkspaceId, 500),
  ])
  for (const item of orders) add({ id: `order:${item.id}`, workspace_id: targetWorkspaceId, kind: 'order', status: item.status, occurred_at: item.createdAt, operation_id: null, trace_id: item.idempotencyKey, request_id: item.idempotencyKey, actor_id: null, resource_id: item.id, reason: null, evidence: { sku_code: item.skuCode, paid_at: item.paidAt } })
  for (const item of entitlements) add({ id: `entitlement:${item.id}`, workspace_id: targetWorkspaceId, kind: 'entitlement', status: item.periodStatus, occurred_at: item.createdAt, operation_id: null, trace_id: null, request_id: null, actor_id: null, resource_id: item.id, reason: null, evidence: { sku_code: item.skuCode, checksum: item.checksum } })
  for (const item of ledger.items) add({ id: `ledger:${item.id}`, workspace_id: targetWorkspaceId, kind: `points.${item.eventType}`, status: item.eventType, occurred_at: item.createdAt, operation_id: item.operationId, trace_id: item.operationId, request_id: null, actor_id: null, resource_id: item.id, reason: null, evidence: { intent: item.intent, access_revision: item.accessRevision } })
  for (const item of usage) add({ id: `model-usage:${item.id}`, workspace_id: targetWorkspaceId, kind: 'model.usage', status: item.settlementStatus, occurred_at: item.observedAt, operation_id: item.actionId ?? null, trace_id: typeof item.metadata?.trace_id === 'string' ? item.metadata.trace_id : item.providerRequestId ?? null, request_id: item.providerRequestId ?? null, actor_id: null, resource_id: item.id, reason: item.resolutionReason ?? null, evidence: { modality: item.modality, model: item.model, total_tokens: item.totalTokens ?? null, cost_cny: item.costCny ?? null } })
  for (const allocation of allocations) {
    const serviceEvents = await serviceFulfillment.listEvents(targetWorkspaceId, allocation.id, 500)
    for (const item of serviceEvents) add({ id: `service:${item.id}`, workspace_id: targetWorkspaceId, kind: `service.${item.type}`, status: item.type, occurred_at: item.createdAt, operation_id: typeof item.evidence.operation_id === 'string' ? item.evidence.operation_id : allocation.id, trace_id: typeof item.evidence.trace_id === 'string' ? item.evidence.trace_id : item.idempotencyKey, request_id: item.idempotencyKey, actor_id: item.actorId, resource_id: allocation.id, reason: item.reason, evidence: item.evidence })
  }
  for (const item of audits) add({ id: `audit:${item.id}`, workspace_id: targetWorkspaceId, kind: `audit.${item.action}`, status: 'audited', occurred_at: item.createdAt, operation_id: typeof item.after.operation_id === 'string' ? item.after.operation_id : null, trace_id: typeof item.after.trace_id === 'string' ? item.after.trace_id : null, request_id: typeof item.after.request_id === 'string' ? item.after.request_id : null, actor_id: item.actorId, resource_id: item.resourceId, reason: item.reason, evidence: { before: item.before, after: item.after } })
  events.sort((a, b) => String(b.occurred_at).localeCompare(String(a.occurred_at)) || String(b.id).localeCompare(String(a.id)))
  const limit = commercialOpsPageLimit(params.limit, 200)
  return { schema_version: 'commercial.timeline.v1', items: events.slice(0, limit), total: events.length, next_cursor: null, filters: { workspace_id: targetWorkspaceId, from_at: fromAt ?? null, to_at: toAt ?? null, status: status || null } }
}
