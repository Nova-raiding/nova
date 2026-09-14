import { describe, expect, it } from 'vitest'
import { MemoryCustomerDeliveryRepository } from './customer-delivery-repository.js'

describe('MemoryCustomerDeliveryRepository audit and lifecycle', () => {
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
    const items = Array.from({ length: 10 }, (_, i) => ({ itemKey: `接入-${i}`, completed: true, evidence: { note: `证据-${i}` } }))
    const saved = await repo.updateChecklistItems!({ workspaceId: paid.workspaceId, deliveryId: paid.id, checklistKey: 'system_integration', items, actorId: 'operator-1', expectedRevision: paid.revision })
    expect(saved).toHaveLength(10)
    expect(saved[0]).toMatchObject({ itemKey: '接入-0', completed: true, evidence: { note: '证据-0' } })
    expect((await repo.listChecklistItems!({ workspaceId: paid.workspaceId, deliveryId: paid.id, checklistKey: 'system_integration' }))).toHaveLength(10)
    expect((await repo.get(paid.workspaceId, paid.id))!.systemIntegrationStatus).toBe('complete')
  })
})
