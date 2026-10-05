import { describe, expect, it, vi } from 'vitest'
import { handleCommercialNotificationOpsMethod } from './mcp-commercial-notification-ops.js'
import type { PostgresCommercialNotificationRepository } from '../../../packages/persistence/src/commercial-notification-repository.js'

function setup(overrides: Record<string, unknown> = {}) {
  const repository = {
    getPurchaseResultBacklog: vi.fn().mockResolvedValue({ pending: 3, failed: 1, exhausted: 1, leased: 1, items: [{ eventId: '00000000-0000-0000-0000-000000000001', orderId: 'order-1', attempts: 8, cursorMemberId: 'internal-member-cursor', createdAt: '2026-10-05T00:00:00.000Z', status: 'exhausted' }], nextCursor: null }),
    claimPurchaseResultRedrive: vi.fn().mockResolvedValue({ eventId: '00000000-0000-0000-0000-000000000001', auditId: 'audit-1', attempts: 9, replayed: false, lease: { eventId: '00000000-0000-0000-0000-000000000001', token: 'private-lease-secret' } }),
    fanoutPurchaseResult: vi.fn().mockResolvedValue({ scanned: 20, delivered: 18, complete: false }),
    ...overrides,
  } as unknown as PostgresCommercialNotificationRepository
  const required = (params: Record<string, unknown>, key: string) => {
    const value = params[key]
    if (typeof value !== 'string' || !value.trim()) throw new Error(`missing ${key}`)
    return value
  }
  return { repository, required, deps: { repository, actorId: 'finance-operator', required } }
}

const target = 'ws-business-1'
const eventId = '00000000-0000-0000-0000-000000000001'

describe('Ops purchase-result notification backlog and redrive', () => {
  it('reads one explicit workspace and excludes internal cursor and lease data', async () => {
    const { repository, deps } = setup()
    const cursor = Buffer.from(JSON.stringify({ createdAt: '2026-10-01T00:00:00.000Z', eventId }), 'utf8').toString('base64url')
    const result = await handleCommercialNotificationOpsMethod('ops.commercial.notifications.purchase-results.list', { target_workspace_id: target, cursor, limit: '20' }, deps) as Record<string, unknown>
    expect(repository.getPurchaseResultBacklog).toHaveBeenCalledWith(target, { limit: 20, cursor: { createdAt: '2026-10-01T00:00:00.000Z', eventId } })
    expect(result).toMatchObject({ pending: 3, failed: 1, exhausted: 1, leased: 1, items: [{ event_id: eventId, order_id: 'order-1', status: 'exhausted' }] })
    expect(JSON.stringify(result)).not.toContain('internal-member-cursor')
    expect(JSON.stringify(result)).not.toContain('private-lease-secret')
  })

  it('synchronously consumes one bounded redrive lease but labels acceptance separately from delivery', async () => {
    const { repository, deps } = setup()
    const result = await handleCommercialNotificationOpsMethod('ops.commercial.notifications.purchase-results.redrive', { target_workspace_id: target, event_id: eventId, reason: '通知投递依赖已恢复', idempotency_key: 'redrive-command-1' }, deps) as Record<string, unknown>
    expect(repository.claimPurchaseResultRedrive).toHaveBeenCalledWith(target, { eventId, actorId: 'finance-operator', reason: '通知投递依赖已恢复', idempotencyKey: 'redrive-command-1' })
    expect(repository.fanoutPurchaseResult).toHaveBeenCalledWith(target, { eventId, token: 'private-lease-secret' }, 200)
    expect(result).toMatchObject({ status: 'accepted', accepted: true, replayed: false, delivery: { scanned: 20, delivered: 18, complete: false } })
    expect(JSON.stringify(result)).not.toContain('private-lease-secret')
  })

  it('does not repeat fanout when the idempotent command is replayed', async () => {
    const { repository, deps } = setup({ claimPurchaseResultRedrive: vi.fn().mockResolvedValue({ eventId, auditId: 'audit-1', attempts: 9, replayed: true }) })
    const result = await handleCommercialNotificationOpsMethod('ops.commercial.notifications.purchase-results.redrive', { target_workspace_id: target, event_id: eventId, reason: '通知投递依赖已恢复', idempotency_key: 'redrive-command-1' }, deps) as Record<string, unknown>
    expect(repository.fanoutPurchaseResult).not.toHaveBeenCalled()
    expect(result).toMatchObject({ status: 'accepted', accepted: true, replayed: true, delivery: null, attempts: 9 })
  })

  it('keeps the committed audit and reports a retryable business error if delivery fails', async () => {
    const { repository, deps } = setup({ fanoutPurchaseResult: vi.fn().mockRejectedValue(new Error('database detail must not leak')) })
    await expect(handleCommercialNotificationOpsMethod('ops.commercial.notifications.purchase-results.redrive', { target_workspace_id: target, event_id: eventId, reason: '通知投递依赖已恢复', idempotency_key: 'redrive-command-1' }, deps)).rejects.toMatchObject({
      code: 'COMMERCIAL_NOTIFICATION_REDRIVE_DELIVERY_FAILED', status: 503,
      details: { retryable: true, next_actions: ['ops.commercial.notifications.purchase-results.list'] },
    })
    expect(repository.claimPurchaseResultRedrive).toHaveBeenCalledOnce()
  })

  it('rejects malformed cursor before repository access', async () => {
    const { repository, deps } = setup()
    await expect(handleCommercialNotificationOpsMethod('ops.commercial.notifications.purchase-results.list', { target_workspace_id: target, cursor: Buffer.from('{"eventId":"missing-date"}').toString('base64url') }, deps)).rejects.toMatchObject({ code: 'INVALID_REQUEST', status: 400 })
    expect(repository.getPurchaseResultBacklog).not.toHaveBeenCalled()
  })

  it('maps an invalid backlog page limit to a client error', async () => {
    const { repository, deps } = setup()
    await expect(handleCommercialNotificationOpsMethod('ops.commercial.notifications.purchase-results.list', { target_workspace_id: target, limit: '0' }, deps)).rejects.toMatchObject({ code: 'COMMERCIAL_OPS_PAGE_LIMIT_INVALID', status: 400 })
    expect(repository.getPurchaseResultBacklog).not.toHaveBeenCalled()
  })
})
