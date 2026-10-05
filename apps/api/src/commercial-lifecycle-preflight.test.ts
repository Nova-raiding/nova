import {describe,expect,it,vi} from 'vitest'
import {requireCommercialLifecycleDiagnostic} from './commercial-lifecycle-preflight.js'
import type {ContinuousFeatureEntitlementSnapshotV2} from '../../../packages/application/src/continuous-feature-entitlement.js'
const snapshot:ContinuousFeatureEntitlementSnapshotV2={id:'entitlement',workspaceId:'ws',subscriptionPeriodId:'period',periodStart:'2026-10-01T00:00:00.000Z',periodEnd:'2026-11-01T00:00:00.000Z',periodStatus:'active',catalogVersionId:'approved-version',skuCode:'basic',resolvedBenefits:[{code:'max_brands',quantity:1},{code:'max_stores',quantity:5}],unresolvedBlockers:[],executable:true,checksum:'a'.repeat(64),createdAt:'2026-10-01T00:00:00.000Z'}
const now=()=>new Date('2026-10-05T00:00:00.000Z')
const check=(rows:readonly ContinuousFeatureEntitlementSnapshotV2[])=>requireCommercialLifecycleDiagnostic({workspaceId:'ws',projection:{listV2EntitlementSnapshots:async()=>rows},now})
describe('durable entitlement diagnostic before unavailable lifecycle',()=>{
 it('returns 402 for an actual empty or invalid durable authority without pretending the schema has opening qualification',async()=>{
  for(const rows of [[],[{...snapshot,workspaceId:'other'}],[{...snapshot,executable:false}],[{...snapshot,periodEnd:'2026-10-04T00:00:00.000Z'}],[{...snapshot,resolvedBenefits:[{code:'creative_points',quantity:5000}]}]])await expect(check(rows)).rejects.toMatchObject({code:'COMMERCIAL_ENTITLEMENT_REQUIRED',status:402})
 })
 it('reads the exact workspace authority and returns diagnostic evidence only, never a paid-admission decision',async()=>{
  const list=vi.fn(async(_input:{readonly workspace_id:string})=>[snapshot])
  const result=await requireCommercialLifecycleDiagnostic({workspaceId:'ws',projection:{listV2EntitlementSnapshots:list},now})
  expect(list).toHaveBeenCalledExactlyOnceWith({workspace_id:'ws'})
  expect(result).toEqual({diagnosticOnly:true,snapshotId:'entitlement'})
  expect(result).not.toHaveProperty('allowed')
  expect(result).not.toHaveProperty('qualified')
 })
 it('preserves unknown and ambiguous authority as 503 without changing balances or selecting the newest snapshot',async()=>{
  await expect(requireCommercialLifecycleDiagnostic({workspaceId:'ws',projection:{listV2EntitlementSnapshots:async()=>{throw new Error('database unavailable')}},now})).rejects.toMatchObject({code:'COMMERCIAL_ENTITLEMENT_UNAVAILABLE',status:503})
  await expect(check([snapshot,{...snapshot,id:'second',subscriptionPeriodId:'other-period'}])).rejects.toMatchObject({code:'COMMERCIAL_ENTITLEMENT_AMBIGUOUS',status:503})
 })
})
