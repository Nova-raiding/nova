import {createHash} from 'node:crypto'
import {beforeAll,describe,expect,it} from 'vitest'
import {loadMigrations,migrationChecksum,type AppliedMigration} from './migration.js'
import {PostgresCommercialContractRepository,type VerifiedPaymentGrantInput} from './commercial-contract-repository.js'
import type {CommercialCatalogSkuSnapshot} from './commercial-catalog-repository.js'
import type {SqlClient,SqlQueryResult} from './repository.js'
const canonical=(value:unknown):string=>Array.isArray(value)?`[${value.map(canonical).join(',')}]`:value&&typeof value==='object'?`{${Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>`${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`:JSON.stringify(value)??'null'
const digest=(value:unknown)=>createHash('sha256').update(canonical(value)).digest('hex')
const sku:CommercialCatalogSkuSnapshot={id:'sku',code:'pack',kind:'point_pack',visibility:'public',requiredCapability:null,versionId:'version',version:1,lifecycle:'approved',executable:true,priceFen:10000,currency:'CNY',priceMode:'fixed',durationDays:null,payload:{expiryRule:'purchase_plus_30_natural_days',expiryDays:30},checksum:'a'.repeat(64),effectiveAt:'2026-01-01T00:00:00Z',benefits:[{code:'creative_points',quantity:500,rawValue:null,rawUnit:'creative_points',normalizedValue:null,policyRef:null,metadata:{}}]}
const snapshot={schema_version:'commercial-order.v2',sku,private_eligibility_id:null}
const order={id:'order',workspaceId:'ws',skuId:sku.id,skuVersionId:sku.versionId,amountFen:10000,currency:'CNY',paymentProvider:'alipay',status:'pending',idempotencyKey:'original',requestHash:'b'.repeat(64),createdByActorId:'maker',providerOrderId:null,checkoutUrl:'https://pay.example/original',checkoutExpiresAt:'2026-09-02T01:00:00.000Z',checkoutIdempotencyKey:'payment',createdAt:'2026-09-01T00:00:00Z',paidAt:null,snapshotId:'frozen',snapshot,snapshotChecksum:digest(snapshot),snapshotCatalogChecksum:sku.checksum,skuCode:sku.code,accessRevision:null}
const payment:VerifiedPaymentGrantInput={workspaceId:'ws',orderId:'order',provider:'alipay',providerEventId:'cash',providerOrderId:'bank',nonce:'nonce',payloadHash:'c'.repeat(64),amountFen:10000,currency:'CNY',paidAt:'2026-09-01T00:00:00Z'}
let history:AppliedMigration[]=[]
beforeAll(async()=>{history=(await loadMigrations()).map(migration=>({version:migration.version,name:migration.name,checksum:migrationChecksum(migration.sql)}))})
class Client implements SqlClient {
 calls:string[]=[]
 bindings:readonly unknown[][]=[]
 constructor(readonly tail:number,readonly frozen:typeof order&{termsOrderId?:string|null}=order,readonly present=false,readonly queryFailure?:Error){}
 async query<Row>(sql:string,values:readonly unknown[]=[]):Promise<SqlQueryResult<Row>>{
  this.calls.push(sql)
  this.bindings=[...this.bindings,[...values]]
  if(sql.includes('pg_catalog.to_regclass'))return {rows:[{present:this.present}]} as SqlQueryResult<Row>
  if(sql.includes('pg_catalog.to_regclass'))return {rows:[{present:this.present}]} as SqlQueryResult<Row>
  if(sql.includes('FROM public.schema_migrations'))return {rows:history.slice(0,this.tail)} as SqlQueryResult<Row>
  if(sql.includes('FROM commercial_order_terms_v3')){if(this.queryFailure)throw this.queryFailure;return {rows:[]}}
  if(sql.includes('FROM commercial_orders_v2 o'))return {rows:[this.frozen]} as SqlQueryResult<Row>
  if(sql.includes('UPDATE creative_point_access_state'))return {rows:[{available:500,reserved:0,settled:0,revision:1}]} as SqlQueryResult<Row>
  if(sql.includes("UPDATE commercial_orders_v2 SET status='paid'"))return {rows:[{...this.frozen,status:'paid',paidAt:payment.paidAt}]} as SqlQueryResult<Row>
  return {rows:[]}
 }
 release(){}
}
const repository=(client:Client)=>new PostgresCommercialContractRepository({connect:async()=>client})
describe('verified historical commercial obligation compatibility',()=>{
 it.each([254,255,256,257])('reads the original immutable order on actual checksum-verified schema %i without touching V3 terms',async tail=>{
  const client=new Client(tail)
  await expect(repository(client).getOrderSnapshot('ws','order')).resolves.toMatchObject({order:{id:'order'},snapshot:{schema_version:'commercial-order.v2'}})
  expect(client.calls.some(sql=>sql.includes('JOIN commercial_order_terms_v3'))).toBe(false)
 })
 it('replays the original checkout and commits a real V2 grant on the verified old prefix',async()=>{
  const checkout=new Client(257)
  await expect(repository(checkout).attachCheckout({workspaceId:'ws',orderId:'order',channel:'alipay',idempotencyKey:'payment',paymentUrl:order.checkoutUrl,providerOrderId:null,expiresAt:order.checkoutExpiresAt})).resolves.toMatchObject({replayed:true})
  const paid=new Client(257)
  await expect(repository(paid).recordVerifiedPaymentAndGrant(payment)).resolves.toMatchObject({availablePoints:500,replayed:false,order:{status:'paid'}})
  expect(paid.calls.some(sql=>sql.includes('INSERT INTO creative_point_grants'))).toBe(true)
  expect(paid.calls.some(sql=>sql.includes('INSERT INTO commercial_payment_events_v2'))).toBe(true)
  expect(paid.calls.some(sql=>sql.includes('commercial_order_terms_v3'))).toBe(false)
 })
 it('rejects corrupted frozen snapshots and V3 snapshots instead of inventing legacy terms',async()=>{
  for(const frozen of [{...order,snapshotChecksum:'0'.repeat(64)},{...order,snapshot:{...snapshot,schema_version:'commercial-order.v3'}}]){
   const client=new Client(257,frozen)
   await expect(repository(client).recordVerifiedPaymentAndGrant(payment)).rejects.toMatchObject({code:'COMMERCIAL_POLICY_UNRESOLVED'})
   expect(client.calls.some(sql=>sql.includes('INSERT INTO commercial_payment_events_v2'))).toBe(false)
  }
 })
 it('fails closed when a current schema is missing required relations and does not swallow an actual query error',async()=>{
  await expect(repository(new Client(263)).getOrderSnapshot('ws','order')).rejects.toMatchObject({code:'COMMERCIAL_SCHEMA_INCOMPLETE'})
  const failure=new Error('relation query permission rejected')
  const client=new Client(263,order,true,failure)
  await expect(repository(client).recordVerifiedPaymentAndGrant(payment)).rejects.toBe(failure)
  expect(client.calls.some(sql=>sql.includes('INSERT INTO commercial_payment_events_v2'))).toBe(false)
 })
 it('distinguishes absent historical V3 intents from legacy actor-bound recovery facts',async()=>{
  const old=new Client(257)
  await expect(repository(old).findOrderByIdempotencyKey('ws','maker','original',{onlyV3:true})).resolves.toBeNull()
  expect(old.calls.some(sql=>sql.includes('FROM commercial_orders_v2 o'))).toBe(false)
  await expect(repository(old).findOrderByIdempotencyKey('ws','maker','original')).resolves.toMatchObject({order:{id:'order'},snapshot:{schema_version:'commercial-order.v2'}})
  const queryIndex=old.calls.findIndex(sql=>sql.includes('FROM commercial_orders_v2 o'))
  expect(old.calls[queryIndex]).toContain('o.workspace_id=$1 AND o.created_by_actor_id=$2 AND o.idempotency_key=$3')
  expect(old.bindings[queryIndex]).toEqual(['ws','maker','original'])
  await expect(repository(new Client(257)).findQuoteByIdempotencyKey('ws','maker','quote')).resolves.toBeNull()
 })
 it('keeps a committed V3 replay visible and refuses legacy or missing-terms facts as V3 evidence',async()=>{
  const v3={...order,snapshot:{...snapshot,schema_version:'commercial-order.v3'},termsOrderId:'order'}
  await expect(repository(new Client(263,v3,true)).findOrderByIdempotencyKey('ws','maker','original',{onlyV3:true})).resolves.toMatchObject({order:{id:'order'}})
  await expect(repository(new Client(263,order,true)).findOrderByIdempotencyKey('ws','maker','original',{onlyV3:true})).resolves.toBeNull()
  await expect(repository(new Client(263,{...v3,termsOrderId:null},true)).findOrderByIdempotencyKey('ws','maker','original',{onlyV3:true})).rejects.toMatchObject({code:'COMMERCIAL_POLICY_UNRESOLVED'})
 })
 it('returns verified V3 payment expiry on merchant recovery while retaining the old-schema query path',async()=>{
  const deadline='2026-10-06T12:00:00.000Z'
  const v3={...order,expiresAt:deadline,purchaseKind:'onboarding_once' as const}
  const current=new Client(266,v3,true)
  await expect(repository(current).getPaymentStatus('ws','order')).resolves.toMatchObject({order:{id:'order',expiresAt:deadline}})
  const lookup=current.calls.find(sql=>sql.includes('FROM commercial_orders_v2 o'))!
  expect(lookup).toContain('LEFT JOIN commercial_order_terms_v3 t')
  expect(lookup).toContain('t.expires_at AS "expiresAt"')
  const historical=new Client(257)
  await expect(repository(historical).getPaymentStatus('ws','order')).resolves.toMatchObject({order:{id:'order',expiresAt:null}})
  expect(historical.calls.some(sql=>sql.includes('commercial_order_terms_v3'))).toBe(false)
 })
 it('does not hide a current missing-table or real lookup error as no prior request',async()=>{
  await expect(repository(new Client(263)).findOrderByIdempotencyKey('ws','maker','original',{onlyV3:true})).rejects.toMatchObject({code:'COMMERCIAL_SCHEMA_INCOMPLETE'})
  await expect(repository(new Client(263)).findQuoteByIdempotencyKey('ws','maker','original')).rejects.toMatchObject({code:'COMMERCIAL_SCHEMA_INCOMPLETE'})
  const failure=new Error('actual lookup failed')
  const client=new Client(263,order,true)
  const realQuery=client.query.bind(client)
  client.query=async<Row>(sql:string,values:readonly unknown[]=[])=>{if(sql.includes('FROM commercial_orders_v2 o'))throw failure;return realQuery<Row>(sql,values)}
  await expect(repository(client).findOrderByIdempotencyKey('ws','maker','original')).rejects.toBe(failure)
 })
 it('marks the V3 portfolio unavailable on a verified old prefix instead of reporting no current contract',async()=>{
  const old=new Client(257)
  await expect(repository(old).getSubscriptionSummary({workspaceId:'ws'})).rejects.toMatchObject({code:'COMMERCIAL_SCHEMA_INCOMPLETE'})
  expect(old.calls.some(sql=>sql.includes('FROM workspace_commercial_onboarding_v3'))).toBe(false)
  await expect(repository(new Client(263)).getSubscriptionSummary({workspaceId:'ws'})).rejects.toMatchObject({code:'COMMERCIAL_SCHEMA_INCOMPLETE'})
 })
 it('preserves the actual scoped portfolio qualification query failure',async()=>{
  const failure=new Error('actual qualification read rejected')
  const client=new Client(263,order,true)
  const realQuery=client.query.bind(client)
  client.query=async<Row>(sql:string,values:readonly unknown[]=[])=>{if(sql.includes('FROM workspace_commercial_onboarding_v3')){expect(values).toEqual(['ws']);throw failure}return realQuery<Row>(sql,values)}
  await expect(repository(client).getSubscriptionSummary({workspaceId:'ws'})).rejects.toBe(failure)
 })
 it('projects current and future plan identity from the selected frozen SKU and removes the internal full snapshot',async()=>{
  const client=new Client(263,order,true)
  const realQuery=client.query.bind(client)
  client.query=async<Row>(sql:string,values:readonly unknown[]=[])=>{
   if(sql.includes('FROM workspace_entitlement_snapshots_v2 e JOIN')){
    expect(sql).toContain("COALESCE(u.target_snapshot,h.restored_snapshot,s.snapshot->'sku') AS \"resolvedSku\"")
    expect(values[0]).toBe('ws')
    const base={id:'ent',workspaceId:'ws',subscriptionPeriodId:'period',sourceOrderId:'source',sourceOrderStatus:'paid',periodStatus:'active',catalogVersionId:'version',skuCode:'same-name',resolvedBenefits:[],unresolvedBlockers:[],executable:true,checksum:'d'.repeat(64),createdAt:'2026-10-01T00:00:00.000Z',periodStart:'2026-10-01T00:00:00.000Z',periodEnd:'2026-11-01T00:00:00.000Z'}
    return {rows:[{...base,resolvedSku:{...sku,payload:{planFamily:'monthly-family',tierRank:3}}},{...base,id:'future',subscriptionPeriodId:'future-period',periodStart:'2026-11-01T00:00:00.000Z',periodEnd:'2026-12-01T00:00:00.000Z',resolvedSku:{...sku,payload:{planFamily:'monthly-family',tierRank:1}}}]} as SqlQueryResult<Row>
   }
   return realQuery<Row>(sql,values)
  }
  const summary=await repository(client).getSubscriptionSummary({workspaceId:'ws',now:'2026-10-05T00:00:00.000Z'})
  expect(summary.current).toMatchObject({plan_family:'monthly-family',tier_rank:3})
  expect(summary.future[0]).toMatchObject({plan_family:'monthly-family',tier_rank:1})
  expect(summary.current).not.toHaveProperty('resolvedSku')
  expect(summary.future[0]).not.toHaveProperty('resolvedSku')
 })
 it.each([253,255])('uses the actual projection on prefix %i and joins only its exact authoritative revision',async tail=>{
  const client=new Client(tail)
  const realQuery=client.query.bind(client)
  client.query=async<Row>(sql:string,values:readonly unknown[]=[])=>{
   if(sql.includes('to_regprocedure'))return {rows:[{present:values[0]==='public.merchant_entitlement_snapshots_v2(integer)'||tail>=254}]} as SqlQueryResult<Row>
   if(sql.includes('SELECT count(*) AS count FROM public.merchant_entitlement_snapshots_v2'))return {rows:[{count:1}]} as SqlQueryResult<Row>
   if(sql.includes('AS authoritative_e')){
    expect(sql).toContain('authoritative_p.revision=authoritative_e.subscription_period_revision')
    expect(sql).toContain(tail>=254?'public.merchant_entitlement_snapshots_v3':'public.merchant_entitlement_snapshots_v2')
    expect(sql).not.toContain('FROM commercial_catalog_skus')
    expect(values).toEqual([101,null,null])
    return {rows:[{id:'ent',workspaceId:'ws',subscriptionPeriodId:'period',sourceOrderId:null,sourceOrderStatus:null,periodStart:'2026-10-01T00:00:00.000Z',periodEnd:'2026-11-01T00:00:00.000Z',periodStatus:'active',catalogVersionId:'approved-version',skuCode:'basic',resolvedBenefits:[{code:'max_brands',quantity:1},{code:'max_stores',quantity:5}],unresolvedBlockers:[],executable:true,checksum:'a'.repeat(64),createdAt:'2026-10-01T00:00:00.000Z'}]} as SqlQueryResult<Row>
   }
   return realQuery<Row>(sql,values)
  }
  await expect(repository(client).listEntitlementSnapshots('ws')).resolves.toMatchObject([{id:'ent',workspaceId:'ws'}])
 })
 it('refuses a saturated noncursor projection instead of inferring no current authority from truncation',async()=>{
  const client=new Client(253)
  const realQuery=client.query.bind(client)
  client.query=async<Row>(sql:string,values:readonly unknown[]=[])=>{
   if(sql.includes('to_regprocedure'))return {rows:[{present:values[0]==='public.merchant_entitlement_snapshots_v2(integer)'}]} as SqlQueryResult<Row>
   if(sql.includes('SELECT count(*) AS count FROM public.merchant_entitlement_snapshots_v2'))return {rows:[{count:200}]} as SqlQueryResult<Row>
   return realQuery<Row>(sql,values)
  }
  await expect(repository(client).listEntitlementSnapshots('ws')).rejects.toMatchObject({code:'COMMERCIAL_SCHEMA_INCOMPLETE'})
 })
})
