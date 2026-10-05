import {createHash} from 'node:crypto'
import {describe,expect,it} from 'vitest'
import {CommercialTransactionRepositoryV3,type CommercialUpgradeQuoteV3} from './commercial-transaction-repository.js'
import {assertCommercialNewPlanNotLower} from './commercial-transaction-policy.js'
import type {CommercialCatalogSkuSnapshot} from './commercial-catalog-repository.js'
import type {CommercialOrderV2,CreateCommercialOrderInput} from './commercial-contract-repository.js'
import type {SqlClient,SqlQueryResult} from './repository.js'
const at='2026-10-05T00:00:00.000Z'
const sku=(rank:number,family='standard',price=rank*200000):CommercialCatalogSkuSnapshot=>({id:`sku-${family}-${rank}`,code:`${family}-${rank}`,kind:'monthly',visibility:'public',requiredCapability:null,versionId:`version-${family}-${rank}`,version:1,lifecycle:'approved',executable:true,priceFen:price,currency:'CNY',priceMode:'fixed',durationDays:null,effectiveAt:'2026-10-01T00:00:00.000Z',checksum:'a'.repeat(64),payload:{planFamily:family,tierRank:rank,cycle:{unit:'month',count:1},purchasePolicy:{approved:true,version:'test-approved',expiresInSeconds:3600},upgradePolicy:{approved:true,version:'test-upgrade'}},benefits:[{code:'monthly_creative_points',quantity:5000*rank,rawValue:null,rawUnit:'creative_points',normalizedValue:null,policyRef:null,metadata:{}}]})
const input=(target:CommercialCatalogSkuSnapshot):CreateCommercialOrderInput=>({workspaceId:'ws',sku:target,paymentProvider:'manual_transfer',createdByActorId:'merchant',idempotencyKey:'original-intent',reason:'test intent',purchaseKind:'renewal',now:at})
const baseOrder:CommercialOrderV2={id:'original-order',workspaceId:'ws',skuId:'sku-standard-1',skuVersionId:'version-standard-1',amountFen:200000,currency:'CNY',paymentProvider:'manual_transfer',status:'pending',idempotencyKey:'original-intent',requestHash:'',createdByActorId:'merchant',providerOrderId:null,checkoutUrl:null,checkoutExpiresAt:null,checkoutIdempotencyKey:null,createdAt:at,paidAt:null}
class Client implements SqlClient {
 readonly calls:string[]=[]
 quote:CommercialUpgradeQuoteV3|null=null
 constructor(readonly target:CommercialCatalogSkuSnapshot,readonly current:CommercialCatalogSkuSnapshot|null,readonly paid:readonly CommercialCatalogSkuSnapshot[],readonly prior?:CommercialOrderV2,readonly validPaidFacts=true){}
 async query<Row>(sql:string,values:readonly unknown[]=[]):Promise<SqlQueryResult<Row>>{
  this.calls.push(sql)
  if(sql.includes('o.idempotency_key=$2'))return {rows:this.prior?[this.prior]:[]} as SqlQueryResult<Row>
  if(sql.includes('SELECT quote,target_snapshot AS target'))return {rows:this.quote?[{quote:this.quote,target:this.target}]:[]} as SqlQueryResult<Row>
  if(sql.includes('INSERT INTO commercial_upgrade_quotes_v3')){this.quote=JSON.parse(String(values[4])) as CommercialUpgradeQuoteV3;return {rows:[]}}
  if(sql.includes('merchant_resolve_sale_sku_v3'))return {rows:[{snapshot:this.target}]} as SqlQueryResult<Row>
  if(sql.includes('FROM workspace_commercial_onboarding_v3'))return {rows:[{status:'active',orderId:'opening',activatedAt:at}]} as SqlQueryResult<Row>
  if(sql.includes('e.unresolved_blockers AS "unresolvedBlockers"')){
   expect(sql).toContain("o.status='paid'")
   expect(sql).toContain('e.subscription_period_revision=p.revision')
   expect(sql).toContain('LEFT JOIN workspace_entitlement_snapshots_v2')
   expect(values).toEqual(['ws',at])
   return {rows:this.paid.map(plan=>({sku:plan,executable:this.validPaidFacts,unresolvedBlockers:this.validPaidFacts?[]:null}))} as SqlQueryResult<Row>
  }
  if(sql.includes('o.id AS "sourceOrderId",e.id AS "entitlementId"'))return {rows:this.current?[{periodId:'period',revision:1,periodStart:'2026-10-01T00:00:00.000Z',periodEnd:'2026-11-01T00:00:00.000Z',sourceOrderId:'paid-source',entitlementId:'ent',sku:this.current,resolvedBenefits:this.current.benefits}]:[]} as SqlQueryResult<Row>
  if(sql.includes('INSERT INTO commercial_orders_v2'))return {rows:[{...baseOrder,id:values[0],skuId:this.target.id,skuVersionId:this.target.versionId,requestHash:values[7]}]} as SqlQueryResult<Row>
  return {rows:[]}
 }
 release(){}
}
const repository=(client:Client)=>new CommercialTransactionRepositoryV3({connect:async()=>client})
describe('new paid-plan intent cannot downgrade',()=>{
 it('ranks explicit frozen identities independently of mutable price and rejects another family or unknown rank',()=>{
  expect(()=>assertCommercialNewPlanNotLower(sku(1,'standard',900000),[sku(3,'standard',10000)])).toThrow('new plan tier must not be lower')
  expect(()=>assertCommercialNewPlanNotLower(sku(3,'other'),[sku(1)])).toThrow('contract family')
  expect(()=>assertCommercialNewPlanNotLower({...sku(3),payload:{}},[sku(1)])).toThrow('tier identity required')
  expect(()=>assertCommercialNewPlanNotLower(sku(3),[sku(1),sku(3)])).not.toThrow()
 })
 it.each(['merchant','ops'])('blocks a fresh lower-tier renewal below an already-paid future plan for %s',async actor=>{
  const target=sku(1),client=new Client(target,sku(1),[sku(1),sku(3)])
  await expect(repository(client).createOrder({...input(target),createdByActorId:actor})).rejects.toMatchObject({code:'COMMERCIAL_DOWNGRADE_NOT_ALLOWED'})
  expect(client.calls.some(sql=>sql.includes('INSERT INTO commercial_orders_v2'))).toBe(false)
 })
 it('blocks lower current-tier intent and another family with specific codes before writing any order',async()=>{
  for(const [target,current,code] of [[sku(1),sku(3),'COMMERCIAL_DOWNGRADE_NOT_ALLOWED'],[sku(3,'other'),sku(1),'COMMERCIAL_PLAN_FAMILY_MISMATCH']] as const){
   const client=new Client(target,current,[current])
   await expect(repository(client).createOrder(input(target))).rejects.toMatchObject({code})
   expect(client.calls.some(sql=>sql.includes('INSERT INTO commercial_orders_v2'))).toBe(false)
  }
 })
 it('permits same-tier renewal while leaving an existing historical lower future contract untouched',async()=>{
  const target=sku(3),client=new Client(target,sku(3),[sku(3),sku(1)])
  await expect(repository(client).createOrder(input(target))).resolves.toMatchObject({status:'pending'})
  expect(client.calls.some(sql=>sql.startsWith('UPDATE workspace_subscription_periods_v2'))).toBe(false)
 })
 it('keeps exact frozen pending-order replay ahead of the new plan floor without reinterpreting its old tier',async()=>{
  const target=sku(1),request=input(target)
  const requestHash=createHash('sha256').update(JSON.stringify({skuCode:target.code,purchaseKind:request.purchaseKind,paymentProvider:request.paymentProvider,actorId:request.createdByActorId,reason:request.reason,quoteId:null,checkoutId:null,dependency:null,expectedSkuVersionId:null,beneficiaryMemberId:null})).digest('hex')
  const client=new Client(target,sku(3),[sku(3)],{...baseOrder,requestHash})
  await expect(repository(client).createOrder(request)).resolves.toMatchObject({id:'original-order',amountFen:200000})
  expect(client.calls.some(sql=>sql.includes('merchant_resolve_sale_sku_v3')||sql.includes('e.unresolved_blockers'))).toBe(false)
 })
 it('permits current basic to growth upgrade with a paid premium future contract, preserving the current period and future facts',async()=>{
  const target=sku(2),client=new Client(target,sku(1),[sku(1),sku(3)])
  const quote=await repository(client).createUpgradeQuote({workspaceId:'ws',actorId:'merchant',targetSkuCode:target.code,idempotencyKey:'quote',now:at})
  expect(quote).toMatchObject({sourcePeriodId:'period',targetSkuCode:target.code,amountFen:174194})
  expect(quote.remainingMs).toBe(Date.parse('2026-11-01T00:00:00.000Z')-Date.parse(at))
  await expect(repository(client).createOrder({...input(target),purchaseKind:'upgrade',upgradeQuoteId:quote.id})).resolves.toMatchObject({status:'pending'})
  expect(client.calls.some(sql=>sql.includes('e.unresolved_blockers AS "unresolvedBlockers"'))).toBe(false)
  expect(client.calls.some(sql=>sql.startsWith('UPDATE workspace_subscription_periods_v2'))).toBe(false)
  expect(client.paid.map(plan=>plan.payload.tierRank)).toEqual([1,3])
 })
 it('refuses a current downgrade quote and incomplete future source facts for a fresh renewal',async()=>{
  const lower=new Client(sku(1),sku(3),[sku(3)])
  await expect(repository(lower).createUpgradeQuote({workspaceId:'ws',actorId:'merchant',targetSkuCode:sku(1).code,idempotencyKey:'quote',now:at})).rejects.toMatchObject({code:'COMMERCIAL_DOWNGRADE_NOT_ALLOWED'})
  const invalid=new Client(sku(3),sku(1),[sku(3)],undefined,false)
  await expect(repository(invalid).createOrder(input(sku(3)))).rejects.toMatchObject({code:'COMMERCIAL_POLICY_UNRESOLVED'})
 })
})
