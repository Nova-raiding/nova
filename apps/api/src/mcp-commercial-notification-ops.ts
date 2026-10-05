import { DomainError } from '../../../packages/application/src/service.js'
import { CommercialNotificationError, type PostgresCommercialNotificationRepository } from '../../../packages/persistence/src/commercial-notification-repository.js'
import { CommercialOpsReadModelError, commercialOpsPageLimit } from './ops/commercial-ops-read-model.js'

type Params = Record<string, unknown>
export const MCP_COMMERCIAL_NOTIFICATION_OPS_METHODS = new Set([
  'ops.commercial.notifications.purchase-results.list',
  'ops.commercial.notifications.purchase-results.redrive',
])

function decodeCursor(value: unknown): { createdAt: string; eventId: string } | undefined {
  if (value === undefined || value === null || value === '') return undefined
  try {
    if (typeof value !== 'string' || value.length > 4096 || !/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error('invalid')
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Record<string, unknown>
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
      || typeof parsed.createdAt !== 'string' || !Number.isFinite(Date.parse(parsed.createdAt))
      || typeof parsed.eventId !== 'string' || !/^[0-9a-f-]{36}$/iu.test(parsed.eventId)) throw new Error('invalid')
    return { createdAt: new Date(parsed.createdAt).toISOString(), eventId: parsed.eventId }
  } catch {
    throw new DomainError('INVALID_REQUEST', '购买结果通知游标无效', 400)
  }
}

function encodeCursor(cursor: { createdAt: string; eventId: string } | null) {
  return cursor ? Buffer.from(JSON.stringify(cursor)).toString('base64url') : null
}

/** Platform Ops entry point. The workspace is always explicit and lease secrets stay server-side. */
export async function handleCommercialNotificationOpsMethod(method: string, params: Params, deps: {
  repository?: PostgresCommercialNotificationRepository
  actorId: string
  required(params: Params, key: string): string
}) {
  const repository = deps.repository
  if (!repository) throw new DomainError('COMMERCIAL_NOTIFICATION_UNAVAILABLE', '购买结果通知仓储未配置', 503)
  const workspaceId = deps.required(params, 'target_workspace_id')
  try {
    if (method === 'ops.commercial.notifications.purchase-results.list') {
      let limit: number
      try { limit = commercialOpsPageLimit(params.limit) }
      catch (error) {
        if (error instanceof CommercialOpsReadModelError) throw new DomainError(error.code, error.message, 400)
        throw error
      }
      const page = await repository.getPurchaseResultBacklog(workspaceId, {
        limit,
        cursor: decodeCursor(params.cursor),
      })
      return {
        schema_version: 'commercial.purchase-result-notification-backlog.v1',
        pending: page.pending,
        failed: page.failed,
        exhausted: page.exhausted,
        leased: page.leased,
        items: page.items.map(({ eventId, orderId, attempts, createdAt, status }) => ({ event_id: eventId, order_id: orderId, attempts, created_at: createdAt, status })),
        next_cursor: encodeCursor(page.nextCursor),
      }
    }
    if (method === 'ops.commercial.notifications.purchase-results.redrive') {
      const command = await repository.claimPurchaseResultRedrive(workspaceId, {
        eventId: deps.required(params, 'event_id'),
        actorId: deps.actorId,
        reason: deps.required(params, 'reason'),
        idempotencyKey: deps.required(params, 'idempotency_key'),
      })
      if (command.replayed || !command.lease) {
        return { schema_version: 'commercial.purchase-result-notification-redrive.v1', status: 'accepted', accepted: true, replayed: true, event_id: command.eventId, audit_id: command.auditId, attempts: command.attempts, delivery: null, next_action: '查询购买结果通知积压；原 redrive 请求不会重复投递' }
      }
      try {
        const delivery = await repository.fanoutPurchaseResult(workspaceId, command.lease, 200)
        return {
          schema_version: 'commercial.purchase-result-notification-redrive.v1', status: 'accepted', accepted: true, replayed: false,
          event_id: command.eventId, audit_id: command.auditId, attempts: command.attempts,
          delivery: { scanned: delivery.scanned, delivered: delivery.delivered, complete: delivery.complete },
        }
      } catch {
        throw new DomainError('COMMERCIAL_NOTIFICATION_REDRIVE_DELIVERY_FAILED', '受控通知重试已记录，但本次投递结果未确认；查询积压后使用新的幂等键重试', 503, {
          business_reason: 'purchase_result_notification_redrive_delivery_failed', retryable: true,
          next_actions: ['ops.commercial.notifications.purchase-results.list'],
        })
      }
    }
    throw new DomainError('INVALID_REQUEST', '不支持的购买结果通知运营操作', 400)
  } catch (error) {
    if (error instanceof CommercialNotificationError) {
      throw new DomainError(error.code, error.message, error.status, {
        business_reason: error.code, retryable: error.status === 503,
        next_actions: ['ops.commercial.notifications.purchase-results.list'],
      })
    }
    throw error
  }
}
