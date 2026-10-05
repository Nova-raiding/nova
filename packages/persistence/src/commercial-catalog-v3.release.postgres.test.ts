import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { Pool } from 'pg'
import { describe, expect, it } from 'vitest'
import { dropDrainedPostgresFixture, withPostgresFixtureCleanup } from './postgres-scope-fixture-cleanup.js'
import { PostgresCommercialCatalogRepository } from './commercial-catalog-repository.js'
import { PostgresCommercialBenefitBundleRepository } from './commercial-benefit-bundle-repository.js'
const source=process.env.PERSISTENCE_RELEASE_DATABASE_URL
if(!source) throw new Error('PERSISTENCE_RELEASE_DATABASE_URL_REQUIRED')
describe('commercial catalog v3 real PostgreSQL isolated evidence',()=>{
 it('publishes atomically, keeps live version during edits, binds immutable bundles and blocks retired history',async()=>{
  const admin=new Pool({connectionString:source}),name=`catalog_146_${randomUUID().replaceAll('-','')}`
   let db:Pool|undefined,primaryFailure:unknown
  try{
   await admin.query(`CREATE DATABASE "${name}"`)
   const url=new URL(source!);url.pathname=`/${name}`;db=new Pool({connectionString:url.toString()})
   await db.query(await readFile(new URL('./migrations/146_commercial_catalog_v2.sql',import.meta.url),'utf8'))
   await db.query(await readFile(new URL('./migrations/260_commercial_catalog_sales_and_bundles.sql',import.meta.url),'utf8'))
   const bootstrap=await readFile(new URL('../../../infra/local/ensure-app-role.sql',import.meta.url),'utf8')
   const acl=bootstrap.slice(bootstrap.indexOf('-- Versioned catalog facts and mutable sales projections:'),bootstrap.indexOf('-- Publication notifications:'))
   expect(acl).toContain('GRANT SELECT, INSERT ON TABLE')
   await db.query('GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO merchant_app')
   await db.query(acl)
   await db.query(`CREATE TABLE commercial_catalog_publish_outbox(event_id uuid PRIMARY KEY,sku_code text,version integer,visibility text,payload jsonb)`)
   await db.query('GRANT USAGE ON SCHEMA public TO merchant_ops; GRANT SELECT,INSERT ON commercial_catalog_publish_outbox TO merchant_ops')
   const opsPool = { connect: async () => { const client = await db!.connect(); await client.query('SET ROLE merchant_ops'); return {query:client.query.bind(client),release:() => { void client.query('RESET ROLE').finally(() => client.release()) }} } }
   const bundles=new PostgresCommercialBenefitBundleRepository(opsPool),repo=new PostgresCommercialCatalogRepository(opsPool)
   const benefit={code:'monthly_creative_points',quantity:5000,rawValue:null,rawUnit:'point',normalizedValue:5000,policyRef:'approved-test-v1',metadata:{}}
   const draftBundle=await bundles.mutate({action:'create',code:'base-benefits',name:'基础权益',usage:'included',benefits:[benefit],payload:{},expectedRevision:0,idempotencyKey:'bundle-create',actorId:'test',reason:'isolated',evidence:{}})
   const bundle=await bundles.mutate({action:'approve',code:'base-benefits',expectedRevision:1,idempotencyKey:'bundle-approve',actorId:'test',reason:'isolated',evidence:{}})
   expect(bundle.version).toBe(draftBundle.version+1)
   const draft=await repo.mutate({action:'create',code:'isolated-basic',kind:'monthly',priceFen:200000,payload:{blockers:[],purchasePolicy:{version:'test-v3',expiresInSeconds:3600,approved:true},cycle:{unit:'month',count:1},planFamily:'standard',tierRank:1,bundleRefs:[{code:bundle.code,versionId:bundle.versionId}]},expectedRevision:0,idempotencyKey:'create',actorId:'test',reason:'isolated',evidence:{}})
   expect(draft.benefits[0]?.metadata.bundleVersionId).toBe(bundle.versionId)
   const approved=await repo.mutate({action:'approve',code:draft.code,expectedRevision:1,idempotencyKey:'approve',actorId:'test',reason:'isolated',evidence:{}})
   const input={action:'publish' as const,code:draft.code,versionId:approved.versionId,expectedRevision:2,idempotencyKey:'publish',actorId:'test',reason:'isolated',evidence:{}}
   const published=await repo.mutate(input)
   expect(published).toMatchObject({lifecycle:'approved',executable:true,saleState:'on_sale',saleRevision:3})
   expect(await repo.mutate(input)).toEqual(published)
   expect((await db.query(`SELECT count(*)::int AS n FROM commercial_catalog_publish_outbox`)).rows[0].n).toBe(1)
   expect((await bundles.references(bundle.versionId))).toHaveLength(3)
   const changed=await repo.mutate({action:'create',code:draft.code,priceFen:250000,expectedRevision:3,idempotencyKey:'edit',actorId:'test',reason:'reprice',evidence:{}})
   expect(changed.benefits).toHaveLength(1)
   expect((await repo.resolveApprovedExecutableSku(draft.code)).priceFen).toBe(200000)
   const c=await db.connect();try{
    await c.query('BEGIN');await c.query("SELECT set_config('app.workspace_id','isolated-ws',true)")
    const result=await c.query(`SELECT merchant_resolve_sale_sku_v3($1) AS snapshot`,[draft.code])
    expect(result.rows[0].snapshot.versionId).toBe(published.versionId)
    const contender=await db.connect()
    try{
      await contender.query('BEGIN');await contender.query(`SET LOCAL lock_timeout='100ms'`)
      await expect(contender.query(`UPDATE commercial_catalog_sales_v3 SET revision=revision+1 WHERE sku_id=$1`,[draft.id])).rejects.toMatchObject({code:'55P03'})
      await contender.query('ROLLBACK')
    }finally{contender.release()}
    await c.query('COMMIT')
   }finally{c.release()}
   await repo.mutate({action:'retire',code:draft.code,expectedRevision:4,idempotencyKey:'retire',actorId:'test',reason:'retire',evidence:{}})
   await expect(repo.resolveApprovedExecutableSku(draft.code)).rejects.toMatchObject({code:'COMMERCIAL_CATALOG_UNAVAILABLE'})
   const revived=await repo.mutate({...input,expectedRevision:5,idempotencyKey:'republish'})
   expect(revived.saleState).toBe('on_sale')
   expect((await db.query(`SELECT count(*)::int AS n FROM commercial_catalog_publish_outbox`)).rows[0].n).toBe(2)
   await expect(repo.mutate({...input,idempotencyKey:'stale'})).rejects.toMatchObject({code:'COMMERCIAL_CATALOG_CONFLICT'})
   const count=(await db.query(`SELECT count(*)::int AS n FROM commercial_catalog_sku_versions WHERE sku_id=$1`,[draft.id])).rows[0].n
   await expect(repo.mutate({action:'create',code:draft.code,kind:'point_pack',expectedRevision:6,idempotencyKey:'identity',actorId:'test',reason:'invalid',evidence:{}})).rejects.toMatchObject({code:'COMMERCIAL_CATALOG_CONFLICT'})
   expect((await db.query(`SELECT count(*)::int AS n FROM commercial_catalog_sku_versions WHERE sku_id=$1`,[draft.id])).rows[0].n).toBe(count)
   await expect(db.query(`UPDATE commercial_catalog_sku_versions SET price_fen=1 WHERE id=$1`,[published.versionId])).rejects.toThrow('immutable')
   if((await db.query("SELECT 1 FROM pg_roles WHERE rolname='merchant_app'")).rowCount){
    expect((await db.query("SELECT has_table_privilege('merchant_ops','commercial_catalog_skus','INSERT') AS allowed")).rows[0].allowed).toBe(true)
    expect((await db.query("SELECT has_table_privilege('merchant_ops','commercial_catalog_sku_versions','UPDATE') AS allowed")).rows[0].allowed).toBe(false)
    expect((await db.query("SELECT has_table_privilege('merchant_app','commercial_catalog_sales_v3','SELECT') AS allowed")).rows[0].allowed).toBe(false)
    expect((await db.query("SELECT has_function_privilege('merchant_app','merchant_resolve_sale_sku_v3(text,boolean,text[])','EXECUTE') AS allowed")).rows[0].allowed).toBe(true)
   }
   }catch(e){primaryFailure=e;throw e}finally{await withPostgresFixtureCleanup(async()=>{await db?.end();await dropDrainedPostgresFixture(admin,name)},primaryFailure,[()=>admin.end()])}
 },120000)
})
