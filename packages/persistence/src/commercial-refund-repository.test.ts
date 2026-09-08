import { describe, expect, it } from 'vitest'
import { PostgresCommercialRefundRepository } from './commercial-refund-repository.js'
import type { SqlClient, SqlPool } from './repository.js'

class FakeClient implements SqlClient {
  private readonly events: Record<string, any>[] = []
  async query<Row = Record<string, unknown>>(text: string, values: readonly unknown[] = []) {
    if (text.includes('SELECT amount_fen')) return { rows: [{ amountFen: 500000, status: 'paid' }] as Row[] }
    if (text.includes('SELECT id,workspace_id') && text.includes('request_id=$2')) {
      const rows = this.events.filter(event => event.requestId === values[1]).sort((a, b) => b.revision - a.revision).slice(0, 1)
      return { rows: rows as Row[] }
    }
    if (text.startsWith('INSERT INTO commercial_refund_events_v2')) {
      const row = { id: values[0], workspaceId: values[1], orderId: values[2], requestId: values[3], revision: values[4], eventType: values[5], refundKind: values[6], amountFen: values[7], pointsToRevoke: values[8], reason: values[9], actorId: values[10], evidence: JSON.parse(String(values[11])), externalRefundId: values[12], createdAt: values[13] }
      this.events.push(row)
      return { rows: [row] as Row[] }
    }
    if (text.startsWith('UPDATE commercial_orders_v2')) return { rows: [] as Row[] }
    return { rows: [] as Row[] }
  }
  release() {}
}

class FakePool implements SqlPool {
  readonly client = new FakeClient()
  async connect() { return this.client }
}

describe('commercial refund repository', () => {
  it('requires distinct approval and external evidence before completion', async () => {
    const repository = new PostgresCommercialRefundRepository(new FakePool())
    await expect(repository.request({ workspaceId: 'ws-refund', orderId: 'order-1', requestId: 'refund-1', refundKind: 'monthly_unused_points', amountFen: 10000, pointsToRevoke: 20, reason: '未使用月费点数', actorId: 'maker', evidence: { supplement_agreement_ref: 'SUP-1' }, at: '2026-09-08T00:00:00.000Z' })).resolves.toMatchObject({ eventType: 'requested', pointsToRevoke: 20 })
    await expect(repository.approve({ workspaceId: 'ws-refund', requestId: 'refund-1', actorId: 'finance', reason: 'missing legal approval', policyApproval: { legal_review_ref: '' }, at: '2026-09-08T00:01:00.000Z' })).rejects.toMatchObject({ code: 'COMMERCIAL_REFUND_INPUT_INVALID' })
    await expect(repository.approve({ workspaceId: 'ws-refund', requestId: 'refund-1', actorId: 'maker', reason: 'same person', policyApproval: { legal_review_ref: 'LAW-1' }, at: '2026-09-08T00:01:00.000Z' })).rejects.toMatchObject({ code: 'COMMERCIAL_REFUND_STATE_INVALID' })
    await expect(repository.approve({ workspaceId: 'ws-refund', requestId: 'refund-1', actorId: 'finance', reason: 'approved', policyApproval: { legal_review_ref: 'LAW-1' }, at: '2026-09-08T00:01:00.000Z' })).resolves.toMatchObject({ eventType: 'approved' })
    await expect(repository.complete({ workspaceId: 'ws-refund', requestId: 'refund-1', actorId: 'finance', reason: 'missing evidence', externalRefundId: '', evidence: { provider: 'manual_transfer' }, at: '2026-09-08T00:02:00.000Z' })).rejects.toMatchObject({ code: 'COMMERCIAL_REFUND_INPUT_INVALID' })
    await expect(repository.complete({ workspaceId: 'ws-refund', requestId: 'refund-1', actorId: 'finance', reason: 'external transfer confirmed', externalRefundId: 'bank-refund-1', evidence: { provider: 'manual_transfer', receipt: 'R-1' }, at: '2026-09-08T00:02:00.000Z' })).resolves.toMatchObject({ eventType: 'completed', externalRefundId: 'bank-refund-1' })
  })
})
