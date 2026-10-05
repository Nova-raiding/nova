import { afterEach, describe, expect, it, vi } from 'vitest'
import { projectCommercialUpgradeQuote } from './commercial-quote-view.js'
import type { CommercialUpgradeQuoteV3 } from '../../../packages/persistence/src/commercial-transaction-repository.js'
import { handleOpsCommercialPurchase } from './mcp-commercial-ops-purchase.js'
import { confirmCommercialPreview, issueCommercialPreview } from './mcp-commercial-receipts.js'
import { PostgresCommercialContractRepository, CommercialContractError, type CommercialOrderV2, type CreateCommercialOrderInput } from '../../../packages/persistence/src/commercial-contract-repository.js'
import type { CommercialCatalogSkuSnapshot } from '../../../packages/persistence/src/commercial-catalog-repository.js'
import type { SqlClient } from '../../../packages/persistence/src/repository.js'
const key='shared-test-preview-signing-key', at=new Date('2026-10-05T00:00:00Z')
const required=(params:Record<string,unknown>,name:string)=>{if(typeof params[name]!=='string'||!params[name]) throw new Error(name);return params[name] as string}
const sku=(code='basic',version=1):CommercialCatalogSkuSnapshot=>({id:code,code,version,versionId:`${code}-v${version}`,kind:code==='opening'?'onboarding':'monthly',visibility:'public',requiredCapability:null,lifecycle:'approved',executable:true,priceMode:'fixed',priceFen:version*200000,currency:'CNY',durationDays:null,effectiveAt:'2026-01-01T00:00:00Z',checksum:'a'.repeat(64),payload:{purchasePolicy:{approved:true,version:'approved-1',expiresInSeconds:3600}},benefits:[]})
const order={id:'order-1',workspaceId:'ws-1',skuVersionId:'basic-v1',paymentProvider:'manual_transfer',amountFen:200000,checkoutId:'checkout-1'} as CommercialOrderV2
const args={target_workspace_id:'ws-1',beneficiary_member_id:'22222222-2222-4222-8222-222222222222',sku_code:'basic',purchase_kind:'purchase',reason:'confirmed bank transfer',idempotency_key:'intent-1'}
function setup(overrides:Record<string,unknown>={}) {
 const contracts={getSubscriptionSummary:vi.fn(async()=>({onboardingQualified:true,current:null,future:[]})),findOrderByIdempotencyKey:vi.fn(async()=>null),getActiveWorkspaceMember:vi.fn(async()=>true),createOrder:vi.fn(async(_input:CreateCommercialOrderInput)=>order),createFirstCheckout:vi.fn(),...overrides}
 const catalog={resolveApprovedExecutableSku:vi.fn(async(code:string)=>sku(code))}
 const deps={contracts,catalog,actorId:'operator-1',previewSigningKey:key,required,paymentProvider:()=> 'manual_transfer',view:async(value:CommercialOrderV2)=>value} as unknown as Parameters<typeof handleOpsCommercialPurchase>[2]
 return {contracts,catalog,deps}
}
afterEach(()=>vi.useRealTimers())
describe('Ops purchase confirmation and original intent',()=>{
 it('shares signed deadlines across instances and rejects scope, deadline or signature tampering',()=>{
  const value={actor:'a',workspace:'w',amount:200000}, token=issueCommercialPreview(value,'ops-order',key,at.valueOf())
  expect(()=>confirmCommercialPreview(token.preview_hash,value,'ops-order',key,at.valueOf()+299999)).not.toThrow()
  expect(()=>confirmCommercialPreview(token.preview_hash,value,'ops-order',key,at.valueOf()+300000)).toThrow('过期')
  expect(()=>confirmCommercialPreview(token.preview_hash,{...value,workspace:'other'},'ops-order',key,at.valueOf())).toThrow('变化')
  const changed=token.preview_hash.split('.');changed[1]=String(at.valueOf()+600000)
  expect(()=>confirmCommercialPreview(changed.join('.'),value,'ops-order',key,at.valueOf())).toThrow('篡改')
  expect(()=>issueCommercialPreview(value,'ops-order')).toThrow('配置缺失')
 })
 it('rejects expired or changed normal previews before creating any order',async()=>{
  vi.useFakeTimers();vi.setSystemTime(at);const {contracts,catalog,deps}=setup()
  const preview=await handleOpsCommercialPurchase('ops.commercial.order.preview',args,deps) as {preview_hash:string}
  vi.setSystemTime(at.valueOf()+300000)
  await expect(handleOpsCommercialPurchase('ops.commercial.order.create',{...args,preview_hash:preview.preview_hash},deps)).rejects.toMatchObject({code:'COMMERCIAL_PREVIEW_EXPIRED'})
  vi.setSystemTime(at);catalog.resolveApprovedExecutableSku.mockImplementation(async(code)=>sku(code,2))
  await expect(handleOpsCommercialPurchase('ops.commercial.order.create',{...args,preview_hash:preview.preview_hash},deps)).rejects.toMatchObject({code:'COMMERCIAL_PREVIEW_CONFLICT'})
  expect(contracts.createOrder).not.toHaveBeenCalled()
 })
 it('retries the original frozen order after catalog repricing and preview expiry, then delegates changed intent rejection to its original transaction hash',async()=>{
  const original=sku();const createOrder=vi.fn(async(input:{reason:string;purchaseKind:string;beneficiaryMemberId?:string})=>{if(input.reason!==args.reason||input.purchaseKind!=='purchase'||input.beneficiaryMemberId!==args.beneficiary_member_id)throw new CommercialContractError('COMMERCIAL_IDEMPOTENCY_CONFLICT','intent conflict');return order})
  const boundOrder={...order,beneficiaryMemberId:args.beneficiary_member_id} as CommercialOrderV2
  const {contracts,catalog,deps}=setup({findOrderByIdempotencyKey:vi.fn(async()=>({order:boundOrder,snapshot:{sku:original}})),createOrder})
  expect(await handleOpsCommercialPurchase('ops.commercial.order.create',{...args,preview_hash:'expired-previous-token'},deps)).toBe(order)
  expect(createOrder).toHaveBeenCalledWith(expect.objectContaining({sku:original,expectedSkuVersionId:'basic-v1',paymentProvider:'manual_transfer'}))
  expect(catalog.resolveApprovedExecutableSku).not.toHaveBeenCalled();expect(contracts.getSubscriptionSummary).not.toHaveBeenCalled()
  await expect(handleOpsCommercialPurchase('ops.commercial.order.create',{...args,reason:'different intent'},deps)).rejects.toMatchObject({code:'COMMERCIAL_IDEMPOTENCY_CONFLICT'})
  await expect(handleOpsCommercialPurchase('ops.commercial.order.create',{...args,sku_code:'growth'},deps)).rejects.toMatchObject({code:'COMMERCIAL_CATALOG_CONFLICT'})
 })
 it('rejects a missing or suspended beneficiary before previewing or creating any order',async()=>{
  const {contracts,catalog,deps}=setup({getActiveWorkspaceMember:vi.fn(async()=>false)})
  await expect(handleOpsCommercialPurchase('ops.commercial.order.preview',args,deps)).rejects.toMatchObject({code:'COMMERCIAL_BENEFICIARY_REQUIRED',status:409})
  expect(catalog.resolveApprovedExecutableSku).not.toHaveBeenCalled()
  expect(contracts.createOrder).not.toHaveBeenCalled()
 })
 it('checks both checkout identities on replay and does not silently reuse an unrelated original checkout',async()=>{
  const opening={...order,skuVersionId:'opening-v1',beneficiaryMemberId:args.beneficiary_member_id},subscription={...order,beneficiaryMemberId:args.beneficiary_member_id}
  const createFirstCheckout=vi.fn(async(value:{reason:string})=>{if(value.reason!=='same reason')throw new CommercialContractError('COMMERCIAL_IDEMPOTENCY_CONFLICT','intent conflict');return {checkoutId:'checkout-1',onboarding:opening,subscription,amountFen:400000}})
  const {catalog,deps}=setup({findOrderByIdempotencyKey:vi.fn(async(_w,_a,k:string)=>k.endsWith(':onboarding')?{order:opening,snapshot:{sku:sku('opening')}}:{order:subscription,snapshot:{sku:sku()}}),createFirstCheckout})
  const input={target_workspace_id:'ws-1',beneficiary_member_id:args.beneficiary_member_id,onboarding_sku_code:'opening',subscription_sku_code:'basic',reason:'same reason',idempotency_key:'checkout-intent',preview_hash:'old-token'}
  expect(await handleOpsCommercialPurchase('ops.commercial.checkout.create',input,deps)).toMatchObject({replayed:true})
  expect(createFirstCheckout).toHaveBeenCalledWith(expect.objectContaining({expectedOnboardingSkuVersionId:'opening-v1',expectedSubscriptionSkuVersionId:'basic-v1'}))
  await expect(handleOpsCommercialPurchase('ops.commercial.checkout.create',{...input,subscription_sku_code:'growth'},deps)).rejects.toMatchObject({code:'COMMERCIAL_CHECKOUT_CONFLICT'})
  await expect(handleOpsCommercialPurchase('ops.commercial.checkout.create',{...input,reason:'changed reason'},deps)).rejects.toMatchObject({code:'COMMERCIAL_IDEMPOTENCY_CONFLICT'})
  expect(catalog.resolveApprovedExecutableSku).not.toHaveBeenCalled()
 })
 it('rejects checkout price change between preview resolution and the real transaction sale lock',async()=>{
  vi.useFakeTimers();vi.setSystemTime(at)
  const calls:string[]=[]
  const client:SqlClient={async query<Row>(sql:string,values:readonly unknown[]=[]){calls.push(sql);return {rows:sql.includes('merchant_resolve_sale_sku_v3')?[{snapshot:sku(String(values[0]),2)}] as Row[]:[]}},release(){}}
  const real=new PostgresCommercialContractRepository({connect:async()=>client})
  const {deps}=setup({getSubscriptionSummary:vi.fn(async()=>({onboardingQualified:false,current:null,future:[]})),createFirstCheckout:real.createFirstCheckout.bind(real)})
  const input={target_workspace_id:'ws-1',beneficiary_member_id:args.beneficiary_member_id,onboarding_sku_code:'opening',subscription_sku_code:'basic',reason:'first checkout',idempotency_key:'first'}
  const preview=await handleOpsCommercialPurchase('ops.commercial.checkout.preview',input,deps) as {preview_hash:string}
  await expect(handleOpsCommercialPurchase('ops.commercial.checkout.create',{...input,preview_hash:preview.preview_hash},deps)).rejects.toMatchObject({code:'COMMERCIAL_ENTITLEMENT_CONFLICT'})
  expect(calls).toContain('ROLLBACK');expect(calls.some(sql=>sql.includes('INSERT INTO commercial_orders_v2'))).toBe(false)
 })
 it('previews and creates from the same valid frozen quote after current sale prices and benefits change',async()=>{
  vi.useFakeTimers();vi.setSystemTime(at)
  const frozen={...sku('growth'),priceFen:500000,benefits:[{code:'monthly_creative_points',quantity:10000,rawValue:null,rawUnit:'creative_points',normalizedValue:null,policyRef:null,metadata:{}}]}
  const quote={id:'q1',amountFen:150000,targetSkuCode:'growth',targetSnapshot:frozen}
  const {contracts,catalog,deps}=setup({getUpgradeQuote:vi.fn(async()=>quote)})
  catalog.resolveApprovedExecutableSku.mockImplementation(async(code)=>({...sku(code,2),priceFen:700000,benefits:[]}))
  const input={...args,sku_code:'growth',purchase_kind:'upgrade',upgrade_quote_id:'q1'}
  const preview=await handleOpsCommercialPurchase('ops.commercial.order.preview',input,deps) as {preview_hash:string;snapshot:{version_id:string;price_fen:number;benefits:unknown[]};amount_fen:number}
  expect(preview.snapshot).toMatchObject({version_id:'growth-v1',price_fen:500000,benefits:frozen.benefits});expect(preview.amount_fen).toBe(150000)
  catalog.resolveApprovedExecutableSku.mockImplementation(async(code)=>({...sku(code,3),priceFen:800000,benefits:[]}))
  await handleOpsCommercialPurchase('ops.commercial.order.create',{...input,preview_hash:preview.preview_hash},deps)
  expect(contracts.createOrder).toHaveBeenCalledWith(expect.objectContaining({sku:frozen,upgradeQuoteId:'q1'}))
  expect(contracts.createOrder.mock.calls[0]![0]).not.toHaveProperty('expectedSkuVersionId')
 })

 it('keeps internal frozen target/source snapshots out of the public quote DTO',()=>{
  const quote={targetSnapshot:sku(),sourceSnapshot:sku(),sourceUpgradeQuote:{internal:'prior'},benefitIncrements:[]} as unknown as CommercialUpgradeQuoteV3
  const view=projectCommercialUpgradeQuote(quote)
  expect(view).not.toHaveProperty('targetSnapshot');expect(view).not.toHaveProperty('sourceSnapshot');expect(view).not.toHaveProperty('sourceUpgradeQuote')
 })

})
