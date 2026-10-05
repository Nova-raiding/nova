import { loadMigrations, migrationChecksum } from './migration.js'
import { describe, expect, it } from 'vitest'
import { PostgresOnboardingGrantDispatchRepository } from './onboarding-grant-dispatch-repository.js'
import type { SqlClient, SqlPool } from './repository.js'

class DispatchClient implements SqlClient {
 readonly writes: { sql:string;values:readonly unknown[] }[]=[]
 constructor(readonly schedulePoints=600,readonly approvedPoints=600,readonly sequence=2,readonly grantCount=6,readonly expires='2026-11-05T00:00:00.000Z',readonly checksum='a'.repeat(64),readonly paid=true){}
 async query<Row>(sql:string,values:readonly unknown[]=[]){
  if(sql.includes('to_regclass'))return {rows:[{present:true}] as Row[]}
  if(sql.includes('INSERT')||sql.includes('UPDATE'))this.writes.push({sql,values})
  if(sql.includes('FROM onboarding_point_grant_schedules_v2 s'))return {rows:[] as Row[]}
  if(sql.includes('FROM onboarding_point_grant_schedules_v2'))return {rows:[{id:'schedule-2',workspaceId:'ws-gift',onboardingOrderId:'onboarding-order',entitlementSnapshotId:'snapshot',sequence:this.sequence,points:this.schedulePoints,dueAt:'2026-10-05T00:00:00.000Z',expiresAt:this.expires,policyRef:'commercial.onboarding.v2',sourceChecksum:this.checksum}] as Row[]}
  if(sql.includes("snapshot->'sku'"))return {rows:(this.paid?[{catalogChecksum:'a'.repeat(64),sku:{kind:'onboarding',lifecycle:'approved',executable:true,checksum:'a'.repeat(64),payload:{policyRef:{policyId:'commercial.onboarding',version:'v2'},grantSchedule:{grantCount:this.grantCount,pointsPerGrant:this.approvedPoints,cadence:'monthly',startsAt:'payment_verified',timezone:'UTC',grantExpiresAtRule:'next_monthly_anniversary',schedulingStatus:'resolved'}}}}]:[]) as Row[]}
  if(sql.includes('INSERT INTO creative_point_operations'))return {rows:[{id:'operation'}] as Row[]}
  if(sql.includes('INSERT INTO creative_point_grants'))return {rows:[{id:'gift'}] as Row[]}
  if(sql.includes('UPDATE creative_point_access_state'))return {rows:[{available:this.schedulePoints,reserved:0,settled:0,revision:1}] as Row[]}
  return {rows:[] as Row[]}
 }
 release(){}
}
const repository=(client:DispatchClient)=>new PostgresOnboardingGrantDispatchRepository({connect:async()=>client} satisfies SqlPool)
describe('approved frozen onboarding gifts',()=>{
 it('dispatches edited 600-point batches using the approved contract instead of a 500-point constant',async()=>{
  const client=new DispatchClient();expect(await repository(client).dispatchDue({workspaceId:'ws-gift',now:'2026-10-06T00:00:00Z'})).toMatchObject({dispatched:1})
  const grant=client.writes.find(write=>write.sql.includes('INSERT INTO creative_point_grants'))!
  expect(grant.values[4]).toBe(600);expect(grant.values[5]).toBe('2026-11-05T00:00:00.000Z')
 })
 it('preserves a historical 500-point contract even when later catalog prices or gifts change',async()=>{
  const client=new DispatchClient(500,500);expect(await repository(client).dispatchDue({workspaceId:'ws-gift',now:'2026-10-06T00:00:00Z'})).toMatchObject({dispatched:1})
  expect(client.writes.find(write=>write.sql.includes('INSERT INTO creative_point_grants'))!.values[4]).toBe(500)
 })
 it('records a missed configured 600-point window as expired without issuing fresh credit',async()=>{
  class ExpiredClient extends DispatchClient {
   override async query<Row>(sql:string,values:readonly unknown[]=[]){
    if(sql.includes('FROM onboarding_point_grant_schedules_v2 s'))return {rows:[{id:'schedule-expired',workspaceId:'ws-gift',onboardingOrderId:'onboarding-order',entitlementSnapshotId:'snapshot',sequence:2,points:600,dueAt:'2026-09-05T00:00:00.000Z',expiresAt:'2026-10-05T00:00:00.000Z',policyRef:'commercial.onboarding.v2',sourceChecksum:'a'.repeat(64)}] as Row[]}
    if(sql.includes('FROM onboarding_point_grant_schedules_v2'))return {rows:[] as Row[]}
    return super.query<Row>(sql,values)
   }
  }
  const client=new ExpiredClient();expect(await repository(client).dispatchDue({workspaceId:'ws-gift',now:'2026-10-06T00:00:00Z'})).toMatchObject({expired:1,dispatched:0})
  expect(client.writes.find(write=>write.sql.includes('INSERT INTO onboarding_point_grant_expirations_v2'))!.values[5]).toBe(600)
  expect(client.writes.some(write=>write.sql.includes('INSERT INTO creative_point_grants'))).toBe(false)
 })
 it.each([new DispatchClient(600,500),new DispatchClient(0,600),new DispatchClient(600,600,7,6),new DispatchClient(600,600,2,25),new DispatchClient(600,600,2,6,undefined,'b'.repeat(64)),new DispatchClient(600,600,2,6,undefined,undefined,false)])('rejects unapproved quantities, out-of-policy sequences, checksum drift and unpaid sources',async client=>{
  await expect(repository(client).dispatchDue({workspaceId:'ws-gift',now:'2026-10-06T00:00:00Z'})).rejects.toThrow()
  expect(client.writes.filter(write=>write.sql.includes('INSERT INTO creative_point_grants'))).toHaveLength(0)
 })
})

describe('onboarding historical-prefix fulfillment with real schema proof', () => {
 it('fulfills a legitimate V2 gift on a verified 257 history without querying missing V3 holds', async () => {
  const history = (await loadMigrations()).slice(0,257).map(m => ({version:m.version,name:m.name,checksum:migrationChecksum(m.sql)}))
  const reads:string[]=[]
  class OldClient extends DispatchClient {
   override async query<Row>(sql:string,values:readonly unknown[]=[]){
    reads.push(sql)
    if(sql.includes('to_regclass'))return {rows:[{present:false}] as Row[]}
    if(sql.includes('FROM public.schema_migrations'))return {rows:history as Row[]}
    return super.query<Row>(sql,values)
   }
  }
  const client=new OldClient(500,500)
  expect(await repository(client).dispatchDue({workspaceId:'ws-gift',now:'2026-10-06T00:00:00Z'})).toMatchObject({dispatched:1})
  expect(reads.filter(sql=>sql.includes('FROM onboarding_point_grant_schedules_v2')).every(sql=>!sql.includes('commercial_source_recovery_holds_v3'))).toBe(true)
  expect(client.writes.some(sql=>sql.sql.includes('INSERT INTO creative_point_grants'))).toBe(true)
 })
 it('retains both hold exclusions when the new relation exists',async()=>{
  const reads:string[]=[]
  class CurrentClient extends DispatchClient { override async query<Row>(sql:string,values:readonly unknown[]=[]){reads.push(sql);return super.query<Row>(sql,values)} }
  await repository(new CurrentClient()).dispatchDue({workspaceId:'ws-gift',now:'2026-10-06T00:00:00Z'})
  expect(reads.filter(sql=>sql.includes('FROM onboarding_point_grant_schedules_v2')&&sql.includes('commercial_source_recovery_holds_v3'))).toHaveLength(2)
 })
 it('fails closed before any gift writes when a current complete migration history has a missing hold relation',async()=>{
  const history=(await loadMigrations()).map(m=>({version:m.version,name:m.name,checksum:migrationChecksum(m.sql)}))
  class IncompleteCurrent extends DispatchClient { override async query<Row>(sql:string,values:readonly unknown[]=[]){
   if(sql.includes('to_regclass'))return {rows:[{present:false}] as Row[]}
   if(sql.includes('FROM public.schema_migrations'))return {rows:history as Row[]}
   return super.query<Row>(sql,values)
  } }
  const client=new IncompleteCurrent()
  await expect(repository(client).dispatchDue({workspaceId:'ws-gift',now:'2026-10-06T00:00:00Z'})).rejects.toThrow('absent')
  expect(client.writes).toHaveLength(0)
 })
 it('does not swallow SQL failures into a successful empty dispatch',async()=>{
  class FailedQuery extends DispatchClient { override async query<Row>(sql:string,values:readonly unknown[]=[]){
   if(sql.includes('FROM onboarding_point_grant_schedules_v2'))throw new Error('database query failed')
   return super.query<Row>(sql,values)
  } }
  const client=new FailedQuery()
  await expect(repository(client).dispatchDue({workspaceId:'ws-gift',now:'2026-10-06T00:00:00Z'})).rejects.toThrow('database query failed')
  expect(client.writes).toHaveLength(0)
 })
})
