import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { customerDeliveryScanTargets } from '../scripts/customer-delivery-scan-evidence.js'
import { CUSTOMER_DELIVERY_CHECKLIST_ITEM_KEYS } from '../packages/persistence/src/customer-delivery-repository.js'

// Synthetic registration guard inputs; never accepted as live scanner evidence.
function registration() {
  const delivery = { id: 'delivery', contract_ref: 'contract', payment_status: 'paid', payment_date: '2026-09-15',
    payment_evidence_refs: ['payment'], training_completed: true, training_evidence_refs: ['training'],
    system_integration_status: 'complete', functional_acceptance_status: 'complete' }
  const videos = [1, 2].map(n => ({ id: `video-row-${n}`, delivery_id: delivery.id, asset_ref: `video-${n}` }))
  const items = Object.entries(CUSTOMER_DELIVERY_CHECKLIST_ITEM_KEYS).flatMap(([purpose, keys]) => keys.map(item_key => ({
    delivery_id: delivery.id, checklist_key: purpose, item_key, completed: true, evidence: { asset_refs: [purpose] },
  })))
  const audit: Array<Record<string, any>> = [
    { actor_present: true, resource_id: delivery.id, action: 'customer_delivery.update', contract_ref: 'contract',
      registration: { paymentEvidenceRefs: ['payment'], trainingEvidenceRefs: ['training'] } },
    ...videos.map(video => ({ actor_present: true, resource_id: video.id, action: 'customer_delivery.video.add', video_asset_ref: video.asset_ref })),
    ...Object.keys(CUSTOMER_DELIVERY_CHECKLIST_ITEM_KEYS).map(purpose => ({ actor_present: true,
      resource_id: `${delivery.id}:${purpose}`, action: 'customer_delivery.checklist_items.update', registration: {
        items: items.filter(item => item.checklist_key === purpose).map(item => ({ itemKey: item.item_key, completed: true, evidence: item.evidence })),
      } })),
  ]
  return { delivery, videos, items, audit }
}
const collect = (r: ReturnType<typeof registration>) => customerDeliveryScanTargets(r.delivery, r.videos, r.items, r.audit)
describe('seven attachment persisted registration guards', () => {
  it('owner probe derives one delivery from the verified attachment report contract', () => {
    const owner = readFileSync('scripts/verify-customer-delivery-owner.ts', 'utf8')
    expect(owner).not.toContain('scan.delivery.id')
    expect(owner).toContain('attachment.deliveryId')
    expect(owner).toContain("assert.equal(deliveryIds.length, 1")
  })
  it('requires all six purposes, including two distinct videos', () => {
    const targets = collect(registration())
    expect(targets).toHaveLength(7)
    expect(targets.map(target => target.purpose).sort()).toEqual(['contract', 'functional_acceptance', 'payment', 'system_integration', 'training', 'video', 'video'])
  })
  it.each(['payment_evidence_refs', 'training_evidence_refs'] as const)('rejects missing or extra %s', key => {
    for (const refs of [[], ['one', 'two']]) {
      const r = registration(); r.delivery[key] = refs
      expect(() => collect(r)).toThrow('ONE_REGISTERED_ATTACHMENT_PER_PURPOSE_REQUIRED')
    }
  })
  it('rejects incomplete and absent checklist registration', () => {
    const r = registration(); r.items[0]!.completed = false
    expect(() => collect(r)).toThrow('CHECKLIST_NOT_REGISTERED')
    r.items.shift()
    expect(() => collect(r)).toThrow('CHECKLIST_NOT_REGISTERED')
  })
  it('rejects one shared asset across purposes', () => {
    const r = registration(); r.delivery.training_evidence_refs = ['payment']
    expect(() => collect(r)).toThrow('DISTINCT_ATTACHMENTS_REQUIRED')
  })
  it('rejects upload-only audit, missing actor, and mismatched registered asset', () => {
    for (const change of ['upload', 'actor', 'asset']) {
      const r = registration()
      if (change === 'upload') r.audit[0]!.action = 'customer_delivery.asset.upload'
      if (change === 'actor') r.audit[0]!.actor_present = false
      if (change === 'asset') r.audit[0]!.registration!.paymentEvidenceRefs = ['other']
      expect(() => collect(r)).toThrow('REGISTRATION_AUDIT_MISSING')
    }
  })
})
