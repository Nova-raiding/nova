import { CommercialRuntimePolicyError, type CommercialExistingIntentEvidence, type CommercialRuntimeOperation } from './commercial-runtime-policy.js'
import type { CommercialOrderV2 } from '../../../packages/persistence/src/commercial-contract-repository.js'
import type { CommercialCatalogSkuSnapshot } from '../../../packages/persistence/src/commercial-catalog-repository.js'
import type { CommercialRefundEvent } from '../../../packages/persistence/src/commercial-refund-repository.js'
import type { CommercialReceiptReturn } from '../../../packages/persistence/src/commercial-receipt-repository.js'

export interface CommercialRuntimeMethodClassification {
  operation: CommercialRuntimeOperation | 'unknown_commercial_write' | null
  /** A fresh legacy contract cannot use the sale lease to bypass V3 terms. */
  retiredLegacy?: boolean
  replay?: 'order' | 'checkout' | 'quote' | 'legacy_subscription' | 'private_conversion'
  evidence?: 'order' | 'batch_orders' | 'source_allocation' | 'refund_approval' | 'return_approval'
}
const newOrders = new Set(['commercial.order.create','ops.commercial.order.create','ops.commercial.private-trial.order.create'])
const newCheckouts = new Set(['commercial.checkout.create','ops.commercial.checkout.create'])
const newQuotes = new Set(['commercial.upgrade.quote.create','ops.commercial.upgrade.quote.create'])
const catalogs = new Set(['ops.commercial.catalog-v2.mutate','ops.commercial.catalog.mutate','ops.commercial.benefit-bundles.mutate'])
const administration = new Set(['commercial.service-boundary.accept','ops.commercial.offer.upsert','ops.commercial.addon.upsert','ops.commercial.coupon.upsert','ops.commercial.rollout.upsert','ops.commercial.model-markup.update','ops.commercial.private-trial.invite.revoke','ops.commercial.notifications.purchase-results.redrive'])
const newRecovery = new Set(['ops.commercial.order.refund.request','ops.commercial.order.refund.approve','ops.commercial.receipt.return.propose','ops.commercial.receipt.unmatched.return.propose','ops.commercial.points.adjust.propose','ops.commercial.points.adjust.decide','ops.commercial.private-trial.invite.create','ops.commercial.private-trial.eligibility.create','ops.commercial.private-trial.eligibility.approve','ops.commercial.private-trial.credit.prepare','ops.commercial.private-trial.credit.approve'])
const existingOrders = new Set(['commercial.order.payment.create','ops.commercial.order.payment.verify','ops.commercial.private-trial.trial-payment.verify','ops.commercial.private-trial.payment.verify','ops.commercial.private-trial.validation.complete','ops.commercial.receipt.allocation.confirm'])
const services = new Set(['ops.commercial.service-allocation.create','ops.commercial.service-fulfillment.schedule','ops.commercial.service-fulfillment.start','ops.commercial.service-fulfillment.complete','ops.commercial.service-fulfillment.adjust'])

/** Only classifies operations. It never accepts HTTP parameters as proof that
 * a prior intent or approval exists. Every evidence-bearing branch must load
 * scoped persisted facts, then still execute the original repository checks. */
export function classifyCommercialRuntimeMethod(method:string,params:Record<string,unknown>):CommercialRuntimeMethodClassification {
  if (newOrders.has(method)) return {operation:params.purchase_kind==='upgrade'?'new_upgrade':'new_purchase',replay:'order',...(method==='ops.commercial.private-trial.order.create'?{retiredLegacy:true}:{})}
  if (newCheckouts.has(method)) return {operation:'new_purchase',replay:'checkout'}
  if (newQuotes.has(method)) return {operation:'new_quote',replay:'quote'}
  if (method==='subscription.order.create') return {operation:'new_purchase',retiredLegacy:true,replay:'legacy_subscription'}
  if (method==='subscription.change') return {operation:'new_upgrade',retiredLegacy:true,replay:'legacy_subscription'}
  if (method==='ops.commercial.private-trial.conversion.create') return {operation:'new_purchase',retiredLegacy:true,replay:'private_conversion'}
  if (catalogs.has(method)) return {operation:params.action==='publish'?'catalog_publish':null}
  if (method==='ops.commercial.points.adjust.decide'&&params.decision==='rejected') return {operation:null}
  if (newRecovery.has(method)) return {operation:'new_recovery_intent'}
  if (method==='ops.commercial.receipt.return.decide'||method==='ops.commercial.receipt.unmatched.return.decide') return {operation:params.decision==='reject'?null:'new_recovery_intent'}
  if (method==='ops.commercial.order.refund.complete') return {operation:'approved_refund_recovery',evidence:'refund_approval'}
  if (method==='ops.commercial.receipt.return.complete'||method==='ops.commercial.receipt.unmatched.return.complete') return {operation:'approved_refund_recovery',evidence:'return_approval'}
  if (method==='ops.commercial.receipt.record'||method==='ops.commercial.receipt.unmatched.record'||method==='ops.commercial.receipt.unmatched.match') return {operation:'record_cash'}
  if (existingOrders.has(method)) return {operation:'existing_fulfillment',evidence:'order'}
  if (method==='ops.commercial.receipt.allocations.confirm') return {operation:'existing_fulfillment',evidence:'batch_orders'}
  if (services.has(method)) return {operation:'existing_fulfillment',evidence:'source_allocation'}
  // A trusted member acknowledging their own delivered message creates no financial intent.
  if (method === 'commercial.notifications.mark-read') return {operation:null}
  if (administration.has(method)) return {operation:null}
  if (/^(?:ops\.)?commercial\./u.test(method)) {
    if (/(?:\.get|\.list|\.preview|\.report|\.summary|\.export)$/u.test(method)) return {operation:'read'}
    return {operation:'unknown_commercial_write'}
  }
  return {operation:null}
}
const text=(value:unknown):value is string=>typeof value==='string'&&value.trim().length>0

/** Input is a server-loaded immutable order snapshot, not a supplied snapshot.
 * Temporal funds eligibility and source grant replay remain transaction checks;
 * a legitimate existing order can still route late money to disposition. */
export function commercialOrderObligationEvidence(workspaceId:string,orderId:string,fact:{order:CommercialOrderV2;snapshot:{sku:CommercialCatalogSkuSnapshot}}|null):CommercialExistingIntentEvidence {
  const order=fact?.order,sku=fact?.snapshot.sku
  if (!order||!sku||order.workspaceId!==workspaceId||order.id!==orderId||order.skuVersionId!==sku.versionId||sku.lifecycle!=='approved'||!sku.executable||!text(sku.checksum)||!/^[a-f0-9]{64}$/iu.test(sku.checksum)||!sku.effectiveAt||!Number.isFinite(Date.parse(order.createdAt))||!Number.isFinite(Date.parse(sku.effectiveAt))||Date.parse(sku.effectiveAt)>Date.parse(order.createdAt)||!['pending','paid','closed','reconciliation_required'].includes(order.status)) throw new CommercialRuntimePolicyError('EXISTING_VALID_OBLIGATION_REQUIRED')
  return {existingIntentId:order.id,originalFulfillmentValid:true}
}

/** Approval must be an actual immutable event in this request's history. The
 * requested event, client policy JSON or external receipt cannot substitute. */
export function commercialApprovedRefundEvidence(workspaceId:string,requestId:string,history:readonly CommercialRefundEvent[]):CommercialExistingIntentEvidence {
  const events=history.filter(event=>event.workspaceId===workspaceId&&event.requestId===requestId).sort((a,b)=>a.revision-b.revision)
  const requested=events.find(event=>event.eventType==='requested'),approved=events.find(event=>event.eventType==='approved'),latest=events.at(-1)
  const policy=approved?.evidence.policy_approval
  if (!requested||!approved||!latest||!text(approved.id)||requested.actorId===approved.actorId||approved.orderId!==requested.orderId||approved.amountFen!==requested.amountFen||approved.pointsToRevoke!==requested.pointsToRevoke||latest.orderId!==approved.orderId||latest.amountFen!==approved.amountFen||latest.pointsToRevoke!==approved.pointsToRevoke||!['approved','completed','reconciliation_required'].includes(latest.eventType)||!policy||typeof policy!=='object'||!text((policy as Record<string,unknown>).legal_review_ref)) throw new CommercialRuntimePolicyError('PERSISTED_REFUND_APPROVAL_REQUIRED')
  return {existingIntentId:requestId,refundApprovalId:approved.id}
}

/** Caller must load the return by exact ID in the authorized workspace/null
 * operations scope. This row is the durable approval record for cash returns. */
export function commercialApprovedReturnEvidence(returnId:string,fact:CommercialReceiptReturn|null):CommercialExistingIntentEvidence {
  if (!fact||fact.id!==returnId||!['approved','pending_external','external_unknown','completed'].includes(fact.status)||!text(fact.approvedByActorId)||fact.approvedByActorId===fact.requestedByActorId) throw new CommercialRuntimePolicyError('PERSISTED_REFUND_APPROVAL_REQUIRED')
  return {existingIntentId:fact.id,refundApprovalId:fact.id}
}
