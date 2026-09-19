import { describe, expect, it } from 'vitest'
import { PostgresCommercialRefundRepository } from './commercial-refund-repository.js'
import type { SqlClient, SqlPool } from './repository.js'

type RefundRow = {
  id: string
  workspaceId: string
  orderId: string
  requestId: string
  revision: number
  eventType: string
  refundKind: string
  amountFen: number
  pointsToRevoke: number
  reason: string
  actorId: string
  evidence: Record<string, unknown>
  externalRefundId: string | null
  createdAt: string
}

type LedgerOrder = { amountFen: number; status: string }

/** In-memory stand-in for the refund tables that preserves the row semantics
 * the repository depends on: row locking is irrelevant for a single-threaded
 * fake, but the cumulative sum projection and the conditional order UPDATE
 * row count are exactly what the guards under test rely on. */
class RefundLedger {
  readonly events: RefundRow[] = []
  constructor(public order: LedgerOrder | null) {}

  seed(event: Partial<RefundRow> & { orderId: string; requestId: string; eventType: string; amountFen: number }) {
    this.events.push({
      id: `cre_seed_${this.events.length}`,
      workspaceId: 'ws-refund',
      revision: 1,
      refundKind: 'monthly_unused_points',
      pointsToRevoke: 0,
      reason: 'seeded',
      actorId: 'finance',
      evidence: { policy_approval: { legal_review_ref: 'LAW-1' } },
      externalRefundId: event.eventType === 'completed' ? 'bank-seed' : null,
      createdAt: '2026-09-08T00:00:00.000Z',
      ...event,
    })
  }

  latest(requestId: string): RefundRow | undefined {
    return this.events.filter(event => event.requestId === requestId).sort((left, right) => right.revision - left.revision)[0]
  }

  /** Mirrors the repository cumulative projection: each request contributes the
   * largest amount it was ever approved or completed for, so appending a later
   * non-money revision can never release money an earlier revision committed. */
  committed(orderId: string, excludeRequestId?: string): number {
    const perRequest = new Map<string, number>()
    for (const event of this.events.filter(candidate => candidate.orderId === orderId && (candidate.eventType === 'approved' || candidate.eventType === 'completed'))) {
      perRequest.set(event.requestId, Math.max(perRequest.get(event.requestId) ?? 0, event.amountFen))
    }
    return [...perRequest.entries()]
      .filter(([requestId]) => requestId !== excludeRequestId)
      .reduce((total, [, amountFen]) => total + amountFen, 0)
  }

  /** Money actually paid out for the order: every completed revision counts. */
  completed(orderId: string): number {
    return this.events
      .filter(event => event.orderId === orderId && event.eventType === 'completed')
      .reduce((total, event) => total + event.amountFen, 0)
  }
}

class FakeClient implements SqlClient {
  readonly queries: string[] = []
  constructor(private readonly ledger: RefundLedger) {}

  async query<Row = Record<string, unknown>>(text: string, values: readonly unknown[] = []) {
    this.queries.push(text)
    if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK' || text.includes('set_config')) return { rows: [] as Row[] }
    if (text.includes('FROM commercial_orders_v2')) {
      return { rows: (this.ledger.order ? [{ amountFen: this.ledger.order.amountFen, status: this.ledger.order.status }] : []) as Row[] }
    }
    if (text.includes('AS "committedFen"')) {
      const exclude = values[2] == null ? undefined : String(values[2])
      return { rows: [{ committedFen: this.ledger.committed(String(values[1]), exclude) }] as Row[] }
    }
    if (text.includes('AS "refundedFen"')) {
      return { rows: [{ refundedFen: this.ledger.completed(String(values[1])) }] as Row[] }
    }
    if (text.includes('FROM commercial_refund_events_v2') && text.includes('request_id=$2')) {
      const row = this.ledger.latest(String(values[1]))
      return { rows: (row ? [row] : []) as Row[] }
    }
    if (text.startsWith('INSERT INTO commercial_refund_events_v2')) {
      const row: RefundRow = {
        id: String(values[0]), workspaceId: String(values[1]), orderId: String(values[2]), requestId: String(values[3]),
        revision: Number(values[4]), eventType: String(values[5]), refundKind: String(values[6]), amountFen: Number(values[7]),
        pointsToRevoke: Number(values[8]), reason: String(values[9]), actorId: String(values[10]),
        evidence: JSON.parse(String(values[11])) as Record<string, unknown>, externalRefundId: values[12] == null ? null : String(values[12]),
        createdAt: String(values[13]),
      }
      this.ledger.events.push(row)
      return { rows: [row] as Row[], rowCount: 1 }
    }
    if (text.startsWith('UPDATE commercial_orders_v2')) {
      if (this.ledger.order && this.ledger.order.status === 'paid') {
        this.ledger.order.status = 'refunded'
        return { rows: [{ id: String(values[1]) }] as Row[], rowCount: 1 }
      }
      return { rows: [] as Row[], rowCount: 0 }
    }
    throw new Error(`unexpected refund SQL: ${text}`)
  }
}

class FakePool implements SqlPool {
  readonly client: FakeClient
  constructor(ledger: RefundLedger) { this.client = new FakeClient(ledger) }
  async connect() { return this.client }
}

const repositoryFor = (ledger: RefundLedger) => new PostgresCommercialRefundRepository(new FakePool(ledger))
const requestInput = (requestId: string, amountFen = 10000) => ({
  workspaceId: 'ws-refund', orderId: 'order-1', requestId, refundKind: 'monthly_unused_points' as const,
  amountFen, pointsToRevoke: 20, reason: '未使用月费点数', actorId: 'maker', evidence: { supplement_agreement_ref: 'SUP-1' }, at: '2026-09-08T00:00:00.000Z',
})
const approveInput = (requestId: string) => ({ workspaceId: 'ws-refund', requestId, actorId: 'finance', reason: 'approved', policyApproval: { legal_review_ref: 'LAW-1' }, at: '2026-09-08T00:01:00.000Z' })
const completeInput = (requestId: string, externalRefundId = 'bank-refund-1') => ({ workspaceId: 'ws-refund', requestId, actorId: 'finance', reason: 'external transfer confirmed', externalRefundId, evidence: { provider: 'manual_transfer', receipt: 'R-1' }, at: '2026-09-08T00:02:00.000Z' })

describe('commercial refund repository', () => {
  it('requires distinct approval and external evidence before completion', async () => {
    const ledger = new RefundLedger({ amountFen: 500000, status: 'paid' })
    const repository = repositoryFor(ledger)
    // The full paid amount, so completion is also the point where the order
    // legitimately reaches its 'refunded' terminal state.
    await expect(repository.request(requestInput('refund-1', 500000))).resolves.toMatchObject({ eventType: 'requested', pointsToRevoke: 20 })
    await expect(repository.approve({ ...approveInput('refund-1'), policyApproval: { legal_review_ref: '' } })).rejects.toMatchObject({ code: 'COMMERCIAL_REFUND_INPUT_INVALID' })
    await expect(repository.approve({ ...approveInput('refund-1'), actorId: 'maker' })).rejects.toMatchObject({ code: 'COMMERCIAL_REFUND_STATE_INVALID' })
    await expect(repository.approve(approveInput('refund-1'))).resolves.toMatchObject({ eventType: 'approved' })
    await expect(repository.complete({ ...completeInput('refund-1'), externalRefundId: '' })).rejects.toMatchObject({ code: 'COMMERCIAL_REFUND_INPUT_INVALID' })
    await expect(repository.complete(completeInput('refund-1'))).resolves.toMatchObject({ eventType: 'completed', externalRefundId: 'bank-refund-1' })
    expect(ledger.order?.status).toBe('refunded')
  })

  it('replays a pending request id verbatim and never rewrites its intent', async () => {
    const ledger = new RefundLedger({ amountFen: 500000, status: 'paid' })
    const repository = repositoryFor(ledger)
    const first = await repository.request(requestInput('refund-1'))
    await expect(repository.request(requestInput('refund-1'))).resolves.toEqual(first)
    expect(ledger.events.filter(event => event.eventType === 'requested')).toHaveLength(1)
    await expect(repository.request(requestInput('refund-1', 20000))).rejects.toMatchObject({ code: 'COMMERCIAL_REFUND_REQUEST_CONFLICT' })
  })

  it('fails closed when a completed request id is replayed instead of refunding twice', async () => {
    const ledger = new RefundLedger({ amountFen: 500000, status: 'paid' })
    const repository = repositoryFor(ledger)
    await repository.request(requestInput('refund-1'))
    await repository.approve(approveInput('refund-1'))
    await repository.complete(completeInput('refund-1'))
    await expect(repository.request(requestInput('refund-1'))).rejects.toMatchObject({ code: 'COMMERCIAL_REFUND_REQUEST_CONFLICT' })
    expect(ledger.events.filter(event => event.eventType === 'completed')).toHaveLength(1)
  })

  it('refuses a second refund request that would exceed the paid order amount', async () => {
    const ledger = new RefundLedger({ amountFen: 500000, status: 'paid' })
    const repository = repositoryFor(ledger)
    await expect(repository.request(requestInput('refund-a', 500000))).resolves.toMatchObject({ eventType: 'requested' })
    await repository.approve(approveInput('refund-a'))
    // The order is still "paid" while refund A is only approved: a per-request
    // bound alone would accept an identical second request here.
    await expect(repository.request(requestInput('refund-b', 500000))).rejects.toMatchObject({ code: 'COMMERCIAL_REFUND_STATE_INVALID' })
    expect(ledger.events.filter(event => event.eventType === 'requested')).toHaveLength(1)
  })

  it('completes two legal partial refunds on one paid order and only then leaves paid', async () => {
    const ledger = new RefundLedger({ amountFen: 500000, status: 'paid' })
    const repository = repositoryFor(ledger)
    await repository.request(requestInput('refund-a', 300000))
    await repository.approve(approveInput('refund-a'))
    await repository.request(requestInput('refund-b', 200000))
    await repository.approve(approveInput('refund-b'))
    // 300000 of 500000 paid out: the order is still partially refundable, so a
    // first completion must not move it to 'refunded' — the second chain is
    // approved and would otherwise be neither completable nor rejectable.
    await expect(repository.complete(completeInput('refund-a', 'bank-refund-a'))).resolves.toMatchObject({ eventType: 'completed' })
    expect(ledger.order?.status).toBe('paid')
    await expect(repository.complete(completeInput('refund-b', 'bank-refund-b'))).resolves.toMatchObject({ eventType: 'completed' })
    expect(ledger.order?.status).toBe('refunded')
    const completed = ledger.events.filter(event => event.eventType === 'completed')
    expect(completed.map(event => event.amountFen).sort((left, right) => left - right)).toEqual([200000, 300000])
    expect(completed.reduce((total, event) => total + event.amountFen, 0)).toBe(500000)
  })

  it('refuses an approval that would push the committed refunds past the paid amount', async () => {
    const ledger = new RefundLedger({ amountFen: 500000, status: 'paid' })
    const repository = repositoryFor(ledger)
    // Both requests are raised while nothing is approved yet, so each of them
    // is individually legal — the conflict only materialises at approval time.
    await repository.request(requestInput('refund-a', 300000))
    await repository.request(requestInput('refund-b', 300000))
    await repository.approve(approveInput('refund-a'))
    // The database trigger would reject this with a bare constraint error; the
    // repository must refuse it as a mapped business conflict instead.
    await expect(repository.approve(approveInput('refund-b'))).rejects.toMatchObject({ code: 'COMMERCIAL_REFUND_STATE_INVALID' })
    expect(ledger.events.filter(event => event.eventType === 'approved')).toHaveLength(1)
  })

  it('still allows partial refund requests that stay inside the paid order amount', async () => {
    const ledger = new RefundLedger({ amountFen: 500000, status: 'paid' })
    const repository = repositoryFor(ledger)
    await repository.request(requestInput('refund-a', 300000))
    await repository.approve(approveInput('refund-a'))
    await expect(repository.request(requestInput('refund-b', 200000))).resolves.toMatchObject({ eventType: 'requested', amountFen: 200000 })
    await expect(repository.request(requestInput('refund-c', 200001))).rejects.toMatchObject({ code: 'COMMERCIAL_REFUND_STATE_INVALID' })
  })

  it('refuses to complete a refund when earlier approved refunds already consumed the order', async () => {
    const ledger = new RefundLedger({ amountFen: 500000, status: 'paid' })
    ledger.seed({ orderId: 'order-1', requestId: 'refund-a', eventType: 'approved', amountFen: 500000, revision: 2 })
    ledger.seed({ orderId: 'order-1', requestId: 'refund-b', eventType: 'approved', amountFen: 500000, revision: 2 })
    const repository = repositoryFor(ledger)
    await expect(repository.complete(completeInput('refund-b'))).rejects.toMatchObject({ code: 'COMMERCIAL_REFUND_STATE_INVALID' })
    expect(ledger.events.filter(event => event.eventType === 'completed')).toHaveLength(0)
    expect(ledger.order?.status).toBe('paid')
  })

  it('never reports success when the conditional order update matched no paid row', async () => {
    const ledger = new RefundLedger({ amountFen: 500000, status: 'refunded' })
    ledger.seed({ orderId: 'order-1', requestId: 'refund-b', eventType: 'approved', amountFen: 100000, revision: 2 })
    const repository = repositoryFor(ledger)
    await expect(repository.complete(completeInput('refund-b'))).rejects.toMatchObject({ code: 'COMMERCIAL_REFUND_STATE_INVALID' })
    expect(ledger.events.filter(event => event.eventType === 'completed')).toHaveLength(0)
  })

  it('blocks the recorded double-refund chain at the second payout', async () => {
    const ledger = new RefundLedger({ amountFen: 500000, status: 'paid' })
    const repository = repositoryFor(ledger)
    await repository.request(requestInput('refund-a', 500000))
    await repository.approve(approveInput('refund-a'))
    await expect(repository.complete(completeInput('refund-a', 'bank-refund-a'))).resolves.toMatchObject({ eventType: 'completed' })
    expect(ledger.order?.status).toBe('refunded')
    // A live database written by the pre-fix code could still carry a second
    // approved chain for the same order; the request and completion gates must
    // both refuse to turn it into a second payout.
    await expect(repository.request(requestInput('refund-b', 500000))).rejects.toMatchObject({ code: 'COMMERCIAL_REFUND_STATE_INVALID' })
    ledger.seed({ orderId: 'order-1', requestId: 'refund-b', eventType: 'approved', amountFen: 500000, revision: 2 })
    await expect(repository.complete(completeInput('refund-b', 'bank-refund-b'))).rejects.toMatchObject({ code: 'COMMERCIAL_REFUND_STATE_INVALID' })
    const completed = ledger.events.filter(event => event.eventType === 'completed')
    expect(completed).toHaveLength(1)
    expect(completed.reduce((total, event) => total + event.amountFen, 0)).toBeLessThanOrEqual(500000)
  })

  it('refuses to pay out from a pre-existing over-committed order state', async () => {
    const ledger = new RefundLedger({ amountFen: 500000, status: 'paid' })
    // Two full-amount chains were approved before the cumulative guard shipped.
    ledger.seed({ orderId: 'order-1', requestId: 'refund-a', eventType: 'approved', amountFen: 500000, revision: 2 })
    ledger.seed({ orderId: 'order-1', requestId: 'refund-b', eventType: 'approved', amountFen: 500000, revision: 2 })
    const repository = repositoryFor(ledger)
    await expect(repository.complete(completeInput('refund-a', 'bank-refund-a'))).rejects.toMatchObject({ code: 'COMMERCIAL_REFUND_STATE_INVALID' })
    await expect(repository.complete(completeInput('refund-b', 'bank-refund-b'))).rejects.toMatchObject({ code: 'COMMERCIAL_REFUND_STATE_INVALID' })
    expect(ledger.events.filter(event => event.eventType === 'completed')).toHaveLength(0)
    expect(ledger.order?.status).toBe('paid')
  })
})
