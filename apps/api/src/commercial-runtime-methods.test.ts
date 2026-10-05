import {describe,expect,it} from 'vitest'
import {assertCommercialRuntimeOperation,type CommercialRuntimePolicy} from './commercial-runtime-policy.js'
import {classifyCommercialRuntimeMethod,commercialApprovedRefundEvidence,commercialApprovedReturnEvidence,commercialOrderObligationEvidence} from './commercial-runtime-methods.js'
import type {CommercialRefundEvent} from '../../../packages/persistence/src/commercial-refund-repository.js'
import type {CommercialReceiptReturn} from '../../../packages/persistence/src/commercial-receipt-repository.js'
import type {CommercialCatalogSkuSnapshot} from '../../../packages/persistence/src/commercial-catalog-repository.js'
import type {CommercialOrderV2} from '../../../packages/persistence/src/commercial-contract-repository.js'
import {MCP_METHODS} from '../../../packages/contracts/src/mcp.js'
const rollback:CommercialRuntimePolicy={mode:'rollback',policyRevision:'incident'}
const order={id:'order-1',workspaceId:'ws-1',skuVersionId:'version-1',status:'pending',createdAt:'2026-10-01T00:00:00Z'} as CommercialOrderV2
const sku={versionId:'version-1',lifecycle:'approved',executable:true,checksum:'a'.repeat(64),effectiveAt:'2026-09-01T00:00:00Z'} as CommercialCatalogSkuSnapshot
const requested:CommercialRefundEvent={id:'refund-request-event',workspaceId:'ws-1',orderId:'order-1',requestId:'refund-1',revision:1,eventType:'requested',refundKind:'monthly_unused_points',amountFen:150000,pointsToRevoke:3750,actorId:'maker',reason:'owned test',evidence:{supplement_agreement_ref:'consent'},externalRefundId:null,createdAt:'2026-10-01T00:00:00Z'}
const approved:CommercialRefundEvent={...requested,id:'persisted-approval-event',revision:2,eventType:'approved',actorId:'finance',evidence:{policy_approval:{legal_review_ref:'signed-policy'}}}
describe('complete commercial runtime write classification',()=>{
 it('classifies the entire registered commercial MCP inventory without hiding unknown additions',()=>{
  for(const method of MCP_METHODS.filter(method=>method.startsWith('commercial.')||method.startsWith('ops.commercial.'))) expect(classifyCommercialRuntimeMethod(method,{}).operation,method).not.toBe('unknown_commercial_write')
  expect(classifyCommercialRuntimeMethod('ops.commercial.points.adjust.decide',{decision:'rejected'}).operation).toBeNull()
  expect(classifyCommercialRuntimeMethod('ops.commercial.model-markup.update',{}).operation).toBeNull()
 })
 it('covers merchant, Ops, checkout, quote and the actual catalog-v2 publication method',()=>{
  for(const method of ['commercial.order.create','ops.commercial.order.create','commercial.checkout.create','ops.commercial.checkout.create']) expect(classifyCommercialRuntimeMethod(method,{}).operation).toBe('new_purchase')
  expect(classifyCommercialRuntimeMethod('ops.commercial.order.create',{purchase_kind:'upgrade'}).operation).toBe('new_upgrade')
  expect(classifyCommercialRuntimeMethod('commercial.upgrade.quote.create',{}).operation).toBe('new_quote')
  for(const method of ['ops.commercial.catalog-v2.mutate','ops.commercial.benefit-bundles.mutate']) expect(classifyCommercialRuntimeMethod(method,{action:'publish'}).operation).toBe('catalog_publish')
  expect(classifyCommercialRuntimeMethod('ops.commercial.catalog-v2.mutate',{action:'retire'}).operation).toBeNull()
 })
 it('flags all fresh legacy subscription/private-trial contracts as retired even when a Sale lease exists',()=>{
  for(const method of ['subscription.order.create','subscription.change','ops.commercial.private-trial.order.create','ops.commercial.private-trial.conversion.create']) expect(classifyCommercialRuntimeMethod(method,{})).toMatchObject({retiredLegacy:true})
  expect(classifyCommercialRuntimeMethod('subscription.orders.list',{}).operation).toBeNull()
 })
 it('never treats a new refund/return approval or caller approval JSON as persisted recovery',()=>{
  for(const method of ['ops.commercial.order.refund.request','ops.commercial.order.refund.approve','ops.commercial.receipt.return.propose','ops.commercial.receipt.return.decide','ops.commercial.receipt.unmatched.return.decide']){
   const classification=classifyCommercialRuntimeMethod(method,{decision:'approve',refund_approval_id:'caller-fake',original_fulfillment_valid:true})
   expect(classification.operation).toBe('new_recovery_intent')
   expect(()=>assertCommercialRuntimeOperation(rollback,'new_recovery_intent',{existingIntentId:'caller',refundApprovalId:'caller-fake'})).toThrow('NEW_WRITES_CLOSED')
  }
  expect(classifyCommercialRuntimeMethod('ops.commercial.receipt.return.decide',{decision:'reject'}).operation).toBeNull()
 })
 it('preserves actual cash recording and distinguishes existing single/batch orders from new purchases',()=>{
  expect(classifyCommercialRuntimeMethod('ops.commercial.receipt.record',{}).operation).toBe('record_cash')
  expect(()=>assertCommercialRuntimeOperation(rollback,'record_cash')).not.toThrow()
  expect(classifyCommercialRuntimeMethod('ops.commercial.order.payment.verify',{})).toEqual({operation:'existing_fulfillment',evidence:'order'})
  expect(classifyCommercialRuntimeMethod('ops.commercial.receipt.allocations.confirm',{})).toEqual({operation:'existing_fulfillment',evidence:'batch_orders'})
  expect(classifyCommercialRuntimeMethod('ops.commercial.service-fulfillment.complete',{})).toEqual({operation:'existing_fulfillment',evidence:'source_allocation'})
 })
 it('marks an unrecognized commercial write closed while retaining read and noncommercial flows',()=>{
  expect(classifyCommercialRuntimeMethod('ops.commercial.magic.approve',{}).operation).toBe('unknown_commercial_write')
  expect(classifyCommercialRuntimeMethod('commercial.upgrade.quote.request.get',{}).operation).toBe('read')
  expect(classifyCommercialRuntimeMethod('billing.recharge.create',{}).operation).toBeNull()
 })
})
describe('server-loaded persisted obligation and approval evidence',()=>{
 it('permits legitimate old order cash disposition but refuses cross-tenant/version/failed snapshots',()=>{
  const evidence=commercialOrderObligationEvidence('ws-1','order-1',{order,snapshot:{sku}})
  expect(()=>assertCommercialRuntimeOperation(rollback,'existing_fulfillment',evidence)).not.toThrow()
  for(const fact of [null,{order:{...order,workspaceId:'other'},snapshot:{sku}},{order,snapshot:{sku:{...sku,versionId:'new-price'}}},{order:{...order,status:'failed' as const},snapshot:{sku}}]) expect(()=>commercialOrderObligationEvidence('ws-1','order-1',fact)).toThrow('EXISTING_VALID_OBLIGATION_REQUIRED')
 })
 it('uses immutable approved event ID and retains a completed replay without accepting fresh requested refunds',()=>{
  expect(()=>commercialApprovedRefundEvidence('ws-1','refund-1',[requested])).toThrow('PERSISTED_REFUND_APPROVAL_REQUIRED')
  const evidence=commercialApprovedRefundEvidence('ws-1','refund-1',[requested,approved,{...approved,id:'completion',revision:3,eventType:'completed',externalRefundId:'bank-refund'}])
  expect(evidence).toEqual({existingIntentId:'refund-1',refundApprovalId:'persisted-approval-event'})
  expect(()=>assertCommercialRuntimeOperation(rollback,'approved_refund_recovery',evidence)).not.toThrow()
 })
 it('rejects maker self-approval, changed monetary intent, foreign request history and client-only policy evidence',()=>{
  for(const history of [[requested,{...approved,actorId:'maker'}],[requested,{...approved,amountFen:150001}],[{...requested,workspaceId:'other'},{...approved,workspaceId:'other'}],[requested,{...approved,evidence:{legal_review_ref:'client-no-persisted-policy'}}]]) expect(()=>commercialApprovedRefundEvidence('ws-1','refund-1',history)).toThrow('PERSISTED_REFUND_APPROVAL_REQUIRED')
 })
 it('requires actual approved return state and distinct approving actor, including external-unknown recovery',()=>{
  const fact={id:'return-1',status:'external_unknown',approvedByActorId:'finance',requestedByActorId:'maker'} as CommercialReceiptReturn
  const evidence=commercialApprovedReturnEvidence('return-1',fact)
  expect(()=>assertCommercialRuntimeOperation(rollback,'approved_refund_recovery',evidence)).not.toThrow()
  for(const invalid of [null,{...fact,status:'requested' as const},{...fact,approvedByActorId:'maker'},{...fact,id:'other-return'}]) expect(()=>commercialApprovedReturnEvidence('return-1',invalid)).toThrow('PERSISTED_REFUND_APPROVAL_REQUIRED')
 })
})
