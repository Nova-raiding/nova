import { beforeAll,describe,expect,it } from 'vitest'
import { hasCommercialFunctionForVerifiedPrefix,hasCommercialRelationForVerifiedPrefix } from './commercial-schema-compatibility.js'
import { loadMigrations,migrationChecksum,type AppliedMigration } from './migration.js'
import type { SqlClient,SqlQueryResult } from './repository.js'
let history:AppliedMigration[]
beforeAll(async()=>{history=(await loadMigrations()).map(m=>({version:m.version,name:m.name,checksum:migrationChecksum(m.sql)}))})
class Client implements SqlClient {
  calls:string[]=[]
  constructor(private readonly present:boolean,private readonly rows:AppliedMigration[]){}
  async query<Row>(sql:string):Promise<SqlQueryResult<Row>> {this.calls.push(sql);return {rows:(sql.includes('to_regclass')||sql.includes('to_regprocedure')?[{present:this.present}]:this.rows) as Row[]}}
  release(){}
}
describe('commercial relation compatibility requires real verified prefix history',()=>{
  it.each([254,255,256,257,258])('preserves the unchanged pre-commercial schema at verified prefix %i',async prefix=>{
    expect(await hasCommercialRelationForVerifiedPrefix(new Client(false,history.slice(0,prefix)),'commercial_refund_source_holds_v2',261)).toBe(false)
    expect(await hasCommercialRelationForVerifiedPrefix(new Client(false,history.slice(0,prefix)),'commercial_source_recovery_holds_v3',259)).toBe(false)
  })
  it('requires present holds on the current schema and never treats a missing current table as no frozen balance',async()=>{
    await expect(hasCommercialRelationForVerifiedPrefix(new Client(false,history),'commercial_refund_source_holds_v2',261)).rejects.toMatchObject({code:'COMMERCIAL_SCHEMA_INCOMPLETE'})
    const client=new Client(true,[])
    expect(await hasCommercialRelationForVerifiedPrefix(client,'commercial_refund_source_holds_v2',261)).toBe(true)
    expect(client.calls).toHaveLength(1)
  })
  it('rejects a history checksum mismatch rather than trusting a reported old version',async()=>{
    const rows=history.slice(0,255).map(row=>({...row}));rows[143]!.checksum='0'.repeat(64)
    await expect(hasCommercialRelationForVerifiedPrefix(new Client(false,rows),'commercial_refund_source_holds_v2',261)).rejects.toMatchObject({code:'MIGRATION_CHECKSUM_MISMATCH'})
  })
  it('rejects null checksums, renamed migrations, gaps and an empty ledger',async()=>{
    const nullRows=history.slice(0,255).map(row=>({...row}));nullRows[143]!.checksum=null
    await expect(hasCommercialRelationForVerifiedPrefix(new Client(false,nullRows),'commercial_refund_source_holds_v2',261)).rejects.toThrow()
    const legacyAlias=history.slice(0,255).map(row=>({...row}));legacyAlias[13]!.name='read_only_schedules';legacyAlias[13]!.checksum=null
    await expect(hasCommercialRelationForVerifiedPrefix(new Client(false,legacyAlias),'commercial_refund_source_holds_v2',261)).rejects.toMatchObject({code:'COMMERCIAL_SCHEMA_INCOMPLETE'})
    const renamed=history.slice(0,255).map(row=>({...row}));renamed[254]!.name='foreign_migration'
    await expect(hasCommercialRelationForVerifiedPrefix(new Client(false,renamed),'commercial_refund_source_holds_v2',261)).rejects.toThrow()
    await expect(hasCommercialRelationForVerifiedPrefix(new Client(false,history.slice(1,255)),'commercial_refund_source_holds_v2',261)).rejects.toMatchObject({code:'COMMERCIAL_SCHEMA_INCOMPLETE'})
    await expect(hasCommercialRelationForVerifiedPrefix(new Client(false,[]),'commercial_refund_source_holds_v2',261)).rejects.toMatchObject({code:'COMMERCIAL_SCHEMA_INCOMPLETE'})
  })
  it('checks fixed function signatures with their actual migration identity, never relation lookup',async()=>{
    const existing=new Client(true,[])
    expect(await hasCommercialFunctionForVerifiedPrefix(existing,'public.merchant_entitlement_snapshots_v3(integer,timestamptz,text)')).toBe(true)
    expect(existing.calls[0]).toContain('to_regprocedure')
    expect(existing.calls[0]).not.toContain('to_regclass')
    expect(await hasCommercialFunctionForVerifiedPrefix(new Client(false,history.slice(0,253)),'public.merchant_entitlement_snapshots_v3(integer,timestamptz,text)')).toBe(false)
    await expect(hasCommercialFunctionForVerifiedPrefix(new Client(false,history.slice(0,254)),'public.merchant_entitlement_snapshots_v3(integer,timestamptz,text)')).rejects.toMatchObject({code:'COMMERCIAL_SCHEMA_INCOMPLETE'})
    await expect(hasCommercialFunctionForVerifiedPrefix(new Client(false,history),'public.merchant_entitlement_snapshots_v2(integer)')).rejects.toMatchObject({code:'COMMERCIAL_SCHEMA_INCOMPLETE'})
  })
})
