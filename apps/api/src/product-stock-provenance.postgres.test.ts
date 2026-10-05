import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { Pool } from 'pg'
import { describe, expect, it } from 'vitest'
import { MerchantService } from '../../../packages/application/src/service.js'
import { PostgresBusinessRepository } from '../../../packages/persistence/src/business-repository.js'
import { loadMigrations, MigrationRunner } from '../../../packages/persistence/src/migration.js'
const databaseUrl=process.env.PERSISTENCE_RELEASE_DATABASE_URL
const postgresIt=databaseUrl?it:it.skip
const connection=(base:URL,database:string,user?:string,password?:string)=>{const url=new URL(base);url.pathname='/'+database;if(user)url.username=user;if(password)url.password=password;return url.toString()}
describe('product stock provenance durable snapshot',()=>{
  postgresIt('preserves true, false and absent through the real app-role normalized repository',async()=>{
    const base=new URL(databaseUrl!);const name='release_stock_'+randomUUID().replaceAll('-','')
    const admin=new Pool({connectionString:base.toString()});let database:Pool|undefined;let app:Pool|undefined
    try {
      await admin.query(`CREATE DATABASE "${name}"`);database=new Pool({connectionString:connection(base,name)})
      await new MigrationRunner(database,await loadMigrations()).run()
      await database.query(await readFile(new URL('../../../infra/local/ensure-app-role.sql',import.meta.url),'utf8'))
      app=new Pool({connectionString:connection(base,name,'merchant_app','merchant_app_local_only')})
      expect((await app.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows).toEqual([{rolsuper:false,rolbypassrls:false}])
      const ws='stock-'+randomUUID();await database.query("INSERT INTO workspaces(id,status) VALUES($1,'active')",[ws])
      const business=new PostgresBusinessRepository(app,{normalizedProjection:true})
      for(const supplied of [true,false,undefined]) {
        const service=new MerchantService({fixtureMode:true,seedFixture:false})
        const p=service.importProduct({workspaceId:ws,platform:'taobao',title:'durable stock fixture',localProductKey:String(supplied),...(supplied?{stock:0}:{})})
        service.confirmProductFacts(ws,p.id);if(supplied===undefined)delete p.stockProvided
        await business.save({workspaceId:ws,entityType:'product',entityId:p.id,entityVersion:p.version!,payload:p as unknown as Record<string,unknown>})
        const saved=await new PostgresBusinessRepository(app,{normalizedProjection:true}).get(ws,'product',p.id)
        expect(saved.payload.stockProvided).toBe(supplied)
        if(supplied===undefined)expect(saved.payload).not.toHaveProperty('stockProvided')
        const restored=new MerchantService({fixtureMode:true,seedFixture:false});restored.hydrateSnapshot({entityType:'product',entity:saved.payload})
        const task=restored.createTask({workspaceId:ws,productId:p.id,platform:'taobao',candidateOnly:true,requestText:'只要纯文本，内部审核。',answers:{placement:'纯文本'}})
        expect(task.missingQuestions.some(q=>q.id==='stock_status')).toBe(supplied===true)
        expect(saved.payload.stock).toBe(0)
      }
    } finally {await app?.end();await database?.end();await admin.query(`DROP DATABASE IF EXISTS "${name}"`);await admin.end()}
  },300_000)
})
