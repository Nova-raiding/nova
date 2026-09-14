import { describe, expect, it } from 'vitest'
import { CUSTOMER_DELIVERY_CHECKLIST_ITEM_KEYS, isValidCustomerDeliveryContractRef, MemoryCustomerDeliveryRepository, PostgresCustomerDeliveryRepository } from './customer-delivery-repository.js'
import type { SqlClient, SqlPool } from './repository.js'

class RecordingClient implements SqlClient {
  readonly calls: Array<{ text: string; values?: readonly unknown[] }> = []
  private readonly responses: Array<{ rows: Record<string, unknown>[] }> = []
  enqueue(...rows: Record<string, unknown>[]) { this.responses.push({ rows }) }
  async query<T = Record<string, unknown>>(text: string, values?: readonly unknown[]) {
    this.calls.push({ text, values })
    return (this.responses.shift() ?? { rows: [] }) as { rows: T[] }
  }
  release() {}
}

class RecordingPool implements SqlPool {
  constructor(readonly client: RecordingClient) {}
  async connect() { return this.client }
}

describe('MemoryCustomerDeliveryRepository audit and lifecycle', () => {
  it('preserves PostgreSQL DATE calendar values separately from timestamp instants', async () => {
    for (const paymentDate of [new Date(2026, 8, 14), '2026-09-14']) {
      const client = new RecordingClient()
      client.enqueue(); client.enqueue();
      client.enqueue({ id: 'cd_date', workspace_id: 'ws_date', payment_date: paymentDate,
        planned_go_live_at: new Date('2026-10-01T09:00:00+08:00'),
        created_at: new Date(), updated_at: new Date(), revision: 1 })
      client.enqueue(); client.enqueue()
      const result = await new PostgresCustomerDeliveryRepository(new RecordingPool(client)).get('ws_date', 'cd_date')
      expect(result?.paymentDate).toBe('2026-09-14')
      expect(result?.plannedGoLiveAt).toBe('2026-10-01T01:00:00.000Z')
    }
  })

  it('accepts only HTTPS or asset_ref contract evidence', async () => {
    expect(isValidCustomerDeliveryContractRef('https://example.com/contracts/acme.pdf')).toBe(true)
    expect(isValidCustomerDeliveryContractRef('http://example.com/contracts/acme.pdf')).toBe(false)
    expect(isValidCustomerDeliveryContractRef('https://')).toBe(false)
    expect(isValidCustomerDeliveryContractRef('asset_ref_contract-1')).toBe(true)
    expect(isValidCustomerDeliveryContractRef('local-file.pdf')).toBe(false)
    const repo = new MemoryCustomerDeliveryRepository()
    const d = await repo.create({ workspaceId: 'ws_contract', companyName: 'Acme', actorId: 'operator-1' })
    await expect(repo.update({ workspaceId: d.workspaceId, id: d.id, actorId: 'operator-1', expectedRevision: d.revision, patch: { contractRef: 'http://insecure.example/contract.pdf' } })).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })

  it('fails closed when an already-complete profile receives an invalid contract reference', async () => {
    const repo = new MemoryCustomerDeliveryRepository()
    const d = await repo.create({ workspaceId: 'ws_contract_complete', companyName: 'Acme', actorId: 'operator-1' })
    const complete = await repo.update({ workspaceId: d.workspaceId, id: d.id, actorId: 'operator-1', expectedRevision: d.revision, patch: { contractNumber: 'C-1', contractRef: 'asset_ref_contract-1', projectOwner: 'owner', supportOwner: 'support', plannedGoLiveAt: '2026-10-01', customerProfileStatus: 'complete' } })
    await expect(repo.update({ workspaceId: d.workspaceId, id: d.id, actorId: 'operator-1', expectedRevision: complete.revision, patch: { contractRef: 'not-a-reference' } })).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })

  it('writes audit events without inventing training completion from acceptance', async () => {
    const events: any[] = []
    const repo = new MemoryCustomerDeliveryRepository((event) => { events.push(event) })
    const d = await repo.create({ workspaceId: 'ws_audit', companyName: 'Acme', actorId: 'operator-1' })
    const paid = await repo.update({ workspaceId: d.workspaceId, id: d.id, actorId: 'operator-1', expectedRevision: d.revision, patch: { paymentStatus: 'paid' } })
    const updated = await repo.update({ workspaceId: d.workspaceId, id: d.id, actorId: 'operator-1', expectedRevision: paid.revision, patch: { functionalAcceptanceStatus: 'complete' } })
    expect(updated.trainingCompleted).toBe(false)
    const video = await repo.addVideo({ workspaceId: d.workspaceId, deliveryId: d.id, actorId: 'operator-1', title: '交付视频', assetRef: 'asset://video-1' })
    expect(events.map((e) => e.action)).toEqual(['customer_delivery.create', 'customer_delivery.update', 'customer_delivery.update', 'customer_delivery.video.add'])
    expect(events[0]).toMatchObject({ actorId: 'operator-1', before: {}, after: { id: d.id, companyName: 'Acme' }, reason: expect.any(String) })
    expect(events[2]).toMatchObject({ before: { paymentStatus: 'paid' }, after: { functionalAcceptanceStatus: 'complete', trainingCompleted: false } })
    await repo.removeVideo!({ workspaceId: d.workspaceId, deliveryId: d.id, videoId: video.id, actorId: 'operator-1' })
    expect((await repo.get(d.workspaceId, d.id))!.videos[0]!.deletedAt).toMatch(/T/)
    expect(events.at(-1)).toMatchObject({ action: 'customer_delivery.video.remove', evidence: { softDelete: true } })
  })

  it('fails closed for unpaid checklist changes', async () => {
    const repo = new MemoryCustomerDeliveryRepository()
    const d = await repo.create({ workspaceId: 'ws_unpaid', companyName: 'Acme', actorId: 'operator-1' })
    await expect(repo.update({ workspaceId: d.workspaceId, id: d.id, actorId: 'operator-1', expectedRevision: d.revision, patch: { trainingCompleted: true } })).rejects.toMatchObject({ code: 'PAYMENT_REQUIRED' })
  })

  it('never marks an otherwise complete delivery effective while unpaid', async () => {
    const repo = new MemoryCustomerDeliveryRepository()
    const draft = await repo.create({ workspaceId: 'ws_effective_payment', companyName: 'Payment Gate Co', actorId: 'operator-1' })
    const paid = await repo.update({
      workspaceId: draft.workspaceId,
      id: draft.id,
      actorId: 'operator-1',
      expectedRevision: draft.revision,
      patch: { paymentStatus: 'paid' },
    })
    const ready = await repo.update({
      workspaceId: paid.workspaceId,
      id: paid.id,
      actorId: 'operator-1',
      expectedRevision: paid.revision,
      patch: {
        contractNumber: 'C-1',
        contractRef: 'asset_ref_contract-1',
        projectOwner: 'owner',
        supportOwner: 'support',
        paymentDate: '2026-09-14',
        plannedGoLiveAt: '2026-10-01',
        customerProfileStatus: 'complete',
        systemIntegrationStatus: 'complete',
        functionalAcceptanceStatus: 'complete',
        trainingCompleted: true,
      },
    })
    await repo.addVideo({ workspaceId: ready.workspaceId, deliveryId: ready.id, actorId: 'operator-1', title: '交付视频', assetRef: 'asset://video-payment-gate' })
    const effective = (await repo.get(ready.workspaceId, ready.id))!
    expect(effective.effectiveAt).toBeTruthy()
    const unpaid = await repo.update({ workspaceId: ready.workspaceId, id: ready.id, actorId: 'operator-1', expectedRevision: effective.revision, patch: { paymentStatus: 'unpaid' } })
    expect(unpaid.effectiveAt).toBeNull()
  })

  it('persists batch checklist items and derives aggregate status without dropping evidence', async () => {
    const repo = new MemoryCustomerDeliveryRepository()
    const draft = await repo.create({ workspaceId: 'ws_batch', companyName: 'Batch Co', actorId: 'operator-1' })
    const paid = await repo.update({ workspaceId: draft.workspaceId, id: draft.id, actorId: 'operator-1', expectedRevision: draft.revision, patch: { paymentStatus: 'paid' } })
    const items = CUSTOMER_DELIVERY_CHECKLIST_ITEM_KEYS.system_integration.map((itemKey, i) => ({ itemKey, completed: true, evidence: { note: `证据-${i}` } }))
    const saved = await repo.updateChecklistItems!({ workspaceId: paid.workspaceId, deliveryId: paid.id, checklistKey: 'system_integration', items, actorId: 'operator-1', expectedRevision: paid.revision })
    expect(saved).toHaveLength(10)
    expect(saved[0]).toMatchObject({ itemKey: CUSTOMER_DELIVERY_CHECKLIST_ITEM_KEYS.system_integration[0], completed: true, evidence: { note: '证据-0' } })
    expect((await repo.listChecklistItems!({ workspaceId: paid.workspaceId, deliveryId: paid.id, checklistKey: 'system_integration' }))).toHaveLength(10)
    expect((await repo.get(paid.workspaceId, paid.id))!.systemIntegrationStatus).toBe('complete')
  })

  it('records the persisted checklist item as the audit before snapshot', async () => {
    const client = new RecordingClient()
    const previous = {
      workspace_id: 'ws_pg_audit', delivery_id: 'cd_1', checklist_key: 'system_integration',
      item_key: '店铺连接', completed: false, evidence: { note: '旧证据' },
      completed_by_actor_id: null, completed_at: null, revision: 2,
      updated_at: '2026-09-14T00:00:00.000Z',
    }
    const saved = { ...previous, completed: true, evidence: { note: '新证据' },
      completed_by_actor_id: 'operator-1', completed_at: '2026-09-14T00:01:00.000Z', revision: 3,
      updated_at: '2026-09-14T00:01:00.000Z' }
    // BEGIN, scope, delivery lock, previous item, upsert, count, status update,
    // effective-time recalculation, audit, COMMIT.
    client.enqueue(); client.enqueue(); client.enqueue({ revision: 4, payment_status: 'paid' });
    client.enqueue(previous); client.enqueue(saved); client.enqueue({ total: 1, done: 1 });
    client.enqueue(); client.enqueue(); client.enqueue(); client.enqueue()
    const repo = new PostgresCustomerDeliveryRepository(new RecordingPool(client))
    await repo.updateChecklistItem({ workspaceId: 'ws_pg_audit', deliveryId: 'cd_1', checklistKey: 'system_integration', itemKey: '店铺连接', completed: true, evidence: { note: '新证据' }, actorId: 'operator-1', expectedRevision: 4 })
    const audit = client.calls.find((call) => call.text.includes('INSERT INTO workspace_operation_audit'))
    expect(audit).toBeDefined()
    expect(audit?.values?.[0]).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u)
    const statusWrite = client.calls.findIndex(call => call.text.includes('SET system_integration_status='))
    const effectiveWrite = client.calls.findIndex(call => call.text.includes('SET effective_at=CASE'))
    expect(effectiveWrite).toBeGreaterThan(statusWrite)
    expect(JSON.parse(String(audit?.values?.[6]))).toMatchObject({ completed: false, revision: 2, evidence: { note: '旧证据' } })
    expect(JSON.parse(String(audit?.values?.[7]))).toMatchObject({ completed: true, revision: 3, evidence: { note: '新证据' } })
  })
})
