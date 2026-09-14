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

  it('writes audit events for create/update/video and synchronizes training with acceptance', async () => {
    const events: any[] = []
    const repo = new MemoryCustomerDeliveryRepository((event) => { events.push(event) })
    const d = await repo.create({ workspaceId: 'ws_audit', companyName: 'Acme', actorId: 'operator-1' })
    const paid = await repo.update({ workspaceId: d.workspaceId, id: d.id, actorId: 'operator-1', expectedRevision: d.revision, patch: { paymentStatus: 'paid' } })
    const updated = await repo.update({ workspaceId: d.workspaceId, id: d.id, actorId: 'operator-1', expectedRevision: paid.revision, patch: { functionalAcceptanceStatus: 'complete' } })
    expect(updated.trainingCompleted).toBe(true)
    const video = await repo.addVideo({ workspaceId: d.workspaceId, deliveryId: d.id, actorId: 'operator-1', title: '交付视频', assetRef: 'asset://video-1' })
    expect(events.map((e) => e.action)).toEqual(['customer_delivery.create', 'customer_delivery.update', 'customer_delivery.update', 'customer_delivery.video.add'])
    expect(events[0]).toMatchObject({ actorId: 'operator-1', before: {}, after: { id: d.id, companyName: 'Acme' }, reason: expect.any(String) })
    expect(events[2]).toMatchObject({ before: { paymentStatus: 'paid' }, after: { functionalAcceptanceStatus: 'complete', trainingCompleted: true } })
    await repo.removeVideo!({ workspaceId: d.workspaceId, deliveryId: d.id, videoId: video.id, actorId: 'operator-1' })
    expect((await repo.get(d.workspaceId, d.id))!.videos[0]!.deletedAt).toMatch(/T/)
    expect(events.at(-1)).toMatchObject({ action: 'customer_delivery.video.remove', evidence: { softDelete: true } })
  })

  it('fails closed for unpaid checklist changes', async () => {
    const repo = new MemoryCustomerDeliveryRepository()
    const d = await repo.create({ workspaceId: 'ws_unpaid', companyName: 'Acme', actorId: 'operator-1' })
    await expect(repo.update({ workspaceId: d.workspaceId, id: d.id, actorId: 'operator-1', expectedRevision: d.revision, patch: { trainingCompleted: true } })).rejects.toMatchObject({ code: 'PAYMENT_REQUIRED' })
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
    // BEGIN, scope, delivery lock, previous item, upsert, count, delivery update, audit, COMMIT
    client.enqueue(); client.enqueue(); client.enqueue({ revision: 4, payment_status: 'paid' });
    client.enqueue(previous); client.enqueue(saved); client.enqueue({ total: 1, done: 1 });
    client.enqueue(); client.enqueue(); client.enqueue()
    const repo = new PostgresCustomerDeliveryRepository(new RecordingPool(client))
    await repo.updateChecklistItem({ workspaceId: 'ws_pg_audit', deliveryId: 'cd_1', checklistKey: 'system_integration', itemKey: '店铺连接', completed: true, evidence: { note: '新证据' }, actorId: 'operator-1', expectedRevision: 4 })
    const audit = client.calls.find((call) => call.text.includes('INSERT INTO workspace_operation_audit'))
    expect(audit).toBeDefined()
    expect(JSON.parse(String(audit?.values?.[6]))).toMatchObject({ completed: false, revision: 2, evidence: { note: '旧证据' } })
    expect(JSON.parse(String(audit?.values?.[7]))).toMatchObject({ completed: true, revision: 3, evidence: { note: '新证据' } })
  })
})
