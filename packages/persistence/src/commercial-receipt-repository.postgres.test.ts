import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { describe, expect, it } from 'vitest'
import { loadMigrations, MigrationRunner } from './migration.js'
import { PostgresCommercialReceiptRepository } from './commercial-receipt-repository.js'

const databaseUrl=process.env.PERSISTENCE_RELEASE_DATABASE_URL
const postgresIt=databaseUrl?it:it.skip
const time='2026-10-05T00:00:00.000Z'
const hash='a'.repeat(64)
describe('factual cash receipts PostgreSQL',()=>{
 postgresIt('serializes split cash, original payer returns, unmatched mapping and tenant isolation',async()=>{
  const admin=new Pool({connectionString:databaseUrl!});const name=`receipt_${randomUUID().replaceAll('-','')}`;let db:Pool|undefined
  try{
   await admin.query(`CREATE DATABASE "${name}"`);const connection=new URL(databaseUrl!);connection.pathname=`/${name}`;db=new Pool({connectionString:connection.toString()})
   await new MigrationRunner(db,await loadMigrations()).run()
   await db.query(`INSERT INTO workspaces(id,status) VALUES('receipt-ws','active'),('receipt-other','active')`)
   await db.query(`INSERT INTO commercial_catalog_skus(id,code,kind,visibility) VALUES('receipt-sku','receipt-test','point_pack','public')`)
   await db.query(`INSERT INTO commercial_catalog_sku_versions(id,sku_id,version,lifecycle,executable,price_fen,currency,price_mode,payload,checksum,effective_at) VALUES('receipt-v1','receipt-sku',1,'approved',true,1000,'CNY','fixed','{}',$1,$2)`,[hash,time])
   for(const orderId of ['receipt-order','receipt-order-other','receipt-order-late','receipt-batch-open','receipt-batch-plan']){
    await db.query(`INSERT INTO commercial_orders_v2(id,workspace_id,sku_id,sku_version_id,amount_fen,currency,payment_provider,status,idempotency_key,request_hash,created_by_actor_id,created_at) VALUES($1,'receipt-ws','receipt-sku','receipt-v1',1000,'CNY','manual_transfer','pending',$1,$2,'maker',$3)`,[orderId,hash,time])
    await db.query(`INSERT INTO commercial_order_terms_v3(workspace_id,order_id,purchase_kind,expires_at,policy_version,created_at) VALUES('receipt-ws',$1,'point_pack','2026-10-06T00:00:00Z','test-policy',$2)`,[orderId,time])
    await db.query(`INSERT INTO commercial_order_snapshots_v2(id,workspace_id,order_id,sku_id,sku_version_id,catalog_checksum,snapshot,checksum) VALUES($1,'receipt-ws',$2,'receipt-sku','receipt-v1',$3,'{"sku":{"kind":"point_pack"}}',$3)`,[`snap-${orderId}`,orderId,hash])
   }
   const repository=new PostgresCommercialReceiptRepository(db,db)
   const record=(externalTradeId:string,amountFen:number,receivedAt=time)=>({workspaceId:'receipt-ws',source:'manual_transfer',receivingAccountRef:'bank-real-1',externalTradeId,payerRef:'payer-A',amountFen,currency:'CNY' as const,receivedAt,verifiedAt:'2026-10-07T00:00:00.000Z',actorId:'finance',evidence:{bank_receipt_ref:'bank-document-1'}})
   const cash=await repository.record(record('external-split-a',600));const second=await repository.record(record('external-split-b',700))
   await expect(db.query(`INSERT INTO commercial_cash_returns_v2
    (id,workspace_id,receipt_id,amount_fen,payer_ref,requested_by_actor_id,reason,evidence,status,request_hash,created_at)
    VALUES('cross-tenant-return','receipt-other',$1,1,'payer-A','maker','scope regression','{"consent_ref":"CROSS"}','requested',$2,$3)`,[cash.id,hash,time]))
    .rejects.toMatchObject({code:'23503',constraint:'commercial_cash_returns_receipt_scope_fk'})
   expect(await repository.record(record('external-split-a',600))).toMatchObject({id:cash.id})
   expect(await repository.findReceiptByExternalIdentity('receipt-ws','finance',{source:'manual_transfer',receivingAccountRef:'bank-real-1',externalTradeId:'external-split-a'})).toMatchObject({id:cash.id})
   expect(await repository.findReceiptByExternalIdentity('receipt-ws','another-actor',{source:'manual_transfer',receivingAccountRef:'bank-real-1',externalTradeId:'external-split-a'})).toBeNull()
   expect(await repository.findReceiptByExternalIdentity('receipt-other','finance',{source:'manual_transfer',receivingAccountRef:'bank-real-1',externalTradeId:'external-split-a'})).toBeNull()
   await expect(repository.record(record('external-split-a',601))).rejects.toMatchObject({code:'COMMERCIAL_RECEIPT_CONFLICT'})
   const fulfilled:unknown[]=[];const fulfill=async(_client:unknown,input:unknown)=>{fulfilled.push(input)}
   const allocate=(receiptId:string,amountFen:number,key:string,expectedRevision=1,orderId='receipt-order')=>({workspaceId:'receipt-ws',receiptId,orderId,amountFen,expectedRevision,idempotencyKey:key,actorId:'finance',at:'2026-10-07T00:00:00.000Z'})
   expect(await repository.allocateAndFulfill(allocate(cash.id,600,'split-a'),fulfill)).toMatchObject({status:'partially_received'})
   expect(fulfilled).toHaveLength(0)
   expect(await repository.allocateAndFulfill(allocate(second.id,400,'split-b'),fulfill)).toMatchObject({status:'fully_received'})
   expect(fulfilled).toHaveLength(1)
   expect(fulfilled[0]).toMatchObject({amountFen:1000,paidAt:time,provider:'manual_transfer'})
   expect(await repository.getAllocationByIdempotencyKey('receipt-ws','split-b')).toMatchObject({amountFen:400,result:{replayed:true}})
   await expect(repository.allocateAndFulfill(allocate(second.id,401,'split-b'),fulfill)).rejects.toMatchObject({code:'COMMERCIAL_RECEIPT_CONFLICT'})
   const remainder=await repository.get('receipt-ws',second.id);expect(remainder).toMatchObject({availableFen:300,revision:2})
   const returned=await repository.proposeReturn({workspaceId:'receipt-ws',receiptId:second.id,returnId:'cash-return-1',amountFen:300,payerRef:'payer-A',actorId:'maker',reason:'overpayment return',evidence:{consent_ref:'C1'},at:time,expectedRevision:2})
   expect(await repository.getReturnByRequestId('receipt-ws','maker',returned.id)).toMatchObject({id:returned.id,status:'requested'})
   expect(await repository.getReturnByRequestId('receipt-ws','finance',returned.id)).toBeNull()
   expect(await repository.getReturnByRequestId('receipt-other','maker',returned.id)).toBeNull()
   await expect(repository.decideReturn({workspaceId:'receipt-ws',returnId:returned.id,actorId:'maker',action:'approve',evidence:{approval_ref:'A1'},at:time})).rejects.toMatchObject({code:'COMMERCIAL_RECEIPT_STATE_INVALID'})
   await repository.decideReturn({workspaceId:'receipt-ws',returnId:returned.id,actorId:'finance',action:'approve',evidence:{approval_ref:'A1'},at:time})
   expect(await repository.get('receipt-ws',second.id)).toMatchObject({availableFen:0,frozenReturnFen:300})
   await repository.completeReturn({workspaceId:'receipt-ws',returnId:returned.id,actorId:'finance',outcome:'unknown',evidence:{query_ref:'Q1'},at:time})
   expect(await repository.get('receipt-ws',second.id)).toMatchObject({availableFen:0,frozenReturnFen:300})
   const completion={workspaceId:'receipt-ws',returnId:returned.id,actorId:'finance',outcome:'completed' as const,externalReturnId:'bank-return-actual-1',evidence:{bank_receipt_ref:'return-document'},at:time}
   await repository.completeReturn(completion);await repository.completeReturn(completion)
   expect(await repository.get('receipt-ws',second.id)).toMatchObject({returnedFen:300,frozenReturnFen:0,allocatedFen:400})
   const late=await repository.record(record('external-late',1000,'2026-10-06T00:00:00.000Z'))
   await expect(repository.allocateAndFulfill(allocate(late.id,1000,'late',1,'receipt-order-late'),fulfill)).rejects.toMatchObject({code:'COMMERCIAL_RECEIPT_STATE_INVALID'})
   const race=await repository.record(record('external-race',1000))
   const concurrent=await Promise.allSettled([repository.allocateAndFulfill(allocate(race.id,1000,'race-a',1,'receipt-order-other'),fulfill),repository.allocateAndFulfill(allocate(race.id,1000,'race-b',1,'receipt-order-other'),fulfill)])
   expect(concurrent.filter(v=>v.status==='fulfilled')).toHaveLength(1)
   expect(await repository.get('receipt-ws',race.id)).toMatchObject({allocatedFen:1000,availableFen:0})
   const combined=await repository.record(record('external-combined',2000))
   const batchInputs=[allocate(combined.id,1000,'batch-open',1,'receipt-batch-open'),allocate(combined.id,1000,'batch-plan',1,'receipt-batch-plan')]
   await expect(repository.allocateBatchAndFulfill(batchInputs,async()=>{throw new Error('grant rollback injection')})).rejects.toThrow('grant rollback injection')
   expect(await repository.get('receipt-ws',combined.id)).toMatchObject({allocatedFen:0,availableFen:2000,revision:1})
   expect(await repository.getAllocationByIdempotencyKey('receipt-ws','batch-open')).toBeNull()
   const batch=await repository.allocateBatchAndFulfill(batchInputs,fulfill)
   expect(batch).toHaveLength(2);expect(batch.every(v=>v.status==='fully_received')).toBe(true)
   expect(await repository.get('receipt-ws',combined.id)).toMatchObject({allocatedFen:2000,availableFen:0,revision:3})
   const {workspaceId:_,...unmatchedInput}=record('external-unmatched',100)
   const unmatched=await repository.recordUnmatched(unmatchedInput)
   expect(await repository.findReceiptByExternalIdentity(null,'finance',{source:'manual_transfer',receivingAccountRef:'bank-real-1',externalTradeId:'external-unmatched'})).toMatchObject({id:unmatched.id,workspaceId:null})
   expect(await repository.findReceiptByExternalIdentity(null,'another-actor',{source:'manual_transfer',receivingAccountRef:'bank-real-1',externalTradeId:'external-unmatched'})).toBeNull()
   expect(await repository.findReceiptByExternalIdentity('receipt-ws','finance',{source:'manual_transfer',receivingAccountRef:'bank-real-1',externalTradeId:'external-unmatched'})).toBeNull()
   expect(await repository.listUnmatched()).toEqual(expect.arrayContaining([expect.objectContaining({id:unmatched.id})]))
   const matchedUnmatched=await repository.matchUnmatched({receiptId:unmatched.id,workspaceId:'receipt-ws',actorId:'finance',reason:'payer verified',evidence:{owner_match_ref:'MATCH1'},at:time})
   expect(matchedUnmatched).toMatchObject({workspaceId:'receipt-ws',availableFen:100})
   const matchedReturn=await repository.proposeReturn({workspaceId:'receipt-ws',receiptId:unmatched.id,returnId:'cash-return-after-match',amountFen:40,payerRef:'payer-A',actorId:'maker',reason:'return after tenant match',evidence:{consent_ref:'MATCHED1'},at:time,expectedRevision:matchedUnmatched.revision})
   expect(matchedReturn).toMatchObject({id:'cash-return-after-match',status:'requested'})
   await expect(db.query(`UPDATE commercial_cash_receipt_balances_v2 SET workspace_id='receipt-other' WHERE receipt_id=$1`,[unmatched.id])).rejects.toMatchObject({code:'23514'})
   await expect(db.query(`UPDATE commercial_cash_receipt_balances_v2 SET workspace_id=NULL WHERE receipt_id=$1`,[unmatched.id])).rejects.toMatchObject({code:'23514'})
   await expect(db.query(`INSERT INTO commercial_cash_returns_v2
    (id,workspace_id,receipt_id,amount_fen,payer_ref,requested_by_actor_id,reason,evidence,status,request_hash,created_at)
    VALUES('null-scope-matched-return',NULL,$1,1,'payer-A','maker','scope regression','{"consent_ref":"NULL-MATCHED"}','requested',$2,$3)`,[unmatched.id,hash,time]))
    .rejects.toMatchObject({code:'23503',constraint:'commercial_cash_returns_receipt_scope_fk'})
   const {workspaceId:unmatchedWorkspace,...unmatchedWithoutEvidenceInput}=record('external-unapproved-match',50)
   const unmatchedWithoutEvidence=await repository.recordUnmatched(unmatchedWithoutEvidenceInput)
   await expect(db.query(`UPDATE commercial_cash_receipt_balances_v2 SET workspace_id='receipt-ws' WHERE receipt_id=$1`,[unmatchedWithoutEvidence.id])).rejects.toMatchObject({code:'23514'})
   await db.query(`INSERT INTO creative_point_operations(id,workspace_id,kind,idempotency_key,status,request,completed_at) VALUES('receipt-grant-op','receipt-ws','grant','receipt-acl-grant','completed','{}',now())`)
   await db.query(`INSERT INTO creative_point_grants(id,workspace_id,operation_id,source_type,source_id,points,metadata) VALUES('receipt-grant','receipt-ws','receipt-grant-op','commercial_order_v2','receipt-order',10,'{}')`)
   const {workspaceId:unknownWorkspace,...unmatchedReturnCash}=record('external-unmatched-return',100)
   const unknownCash=await repository.recordUnmatched(unmatchedReturnCash)
   const unknownReturn=await repository.proposeUnmatchedReturn({receiptId:unknownCash.id,returnId:'cash-return-unmatched',amountFen:100,payerRef:'payer-A',actorId:'maker',reason:'original payer return without tenant assignment',evidence:{consent_ref:'UC1'},at:time,expectedRevision:1})
   expect(await repository.getReturnByRequestId(null,'maker',unknownReturn.id)).toMatchObject({id:unknownReturn.id,status:'requested'})
   expect(await repository.getReturnByRequestId(null,'finance',unknownReturn.id)).toBeNull()
   expect(await repository.getReturnByRequestId('receipt-ws','maker',unknownReturn.id)).toBeNull()
   await repository.decideUnmatchedReturn({returnId:unknownReturn.id,actorId:'finance',action:'approve',evidence:{approval_ref:'UA1'},at:time})
   await repository.completeUnmatchedReturn({returnId:unknownReturn.id,actorId:'finance',outcome:'unknown',evidence:{external_query_ref:'UQ1'},at:time})
   expect(await repository.getReturnByRequestId(null,'maker',unknownReturn.id)).toMatchObject({status:'external_unknown'})
   const {workspaceId:terminalWorkspace,...terminalCashInput}=record('external-terminal-return',25)
   const terminalCash=await repository.recordUnmatched(terminalCashInput)
   const terminalReturn=await repository.proposeUnmatchedReturn({receiptId:terminalCash.id,returnId:'cash-return-terminal-unmatched',amountFen:25,payerRef:'payer-A',actorId:'maker',reason:'terminal unmatched return before matching',evidence:{consent_ref:'UT1'},at:time,expectedRevision:1})
   await repository.decideUnmatchedReturn({returnId:terminalReturn.id,actorId:'finance',action:'approve',evidence:{approval_ref:'UT1'},at:time})
   await repository.completeUnmatchedReturn({returnId:terminalReturn.id,actorId:'finance',outcome:'completed',externalReturnId:'bank-return-terminal-unmatched',evidence:{bank_receipt_ref:'UT1'},at:time})
   expect(await repository.matchUnmatched({receiptId:terminalCash.id,workspaceId:'receipt-ws',actorId:'finance',reason:'terminal return resolved before matching',evidence:{owner_match_ref:'MATCH-UT1'},at:time})).toMatchObject({workspaceId:'receipt-ws'})
   expect(await repository.getReturnByRequestId(null,'maker',terminalReturn.id)).toMatchObject({status:'completed'})
   const opsClient=await db.connect()
   try{
    await opsClient.query('BEGIN');await opsClient.query('SET LOCAL ROLE merchant_ops');await opsClient.query(`SELECT set_config('app.workspace_id','receipt-ws',true)`)
    expect((await opsClient.query(`SELECT id FROM commercial_orders_v2 WHERE workspace_id='receipt-ws' FOR UPDATE`)).rows.length).toBeGreaterThan(0)
    expect((await opsClient.query(`SELECT id FROM creative_point_grants WHERE workspace_id='receipt-ws' FOR UPDATE`)).rows).toHaveLength(1)
    await opsClient.query('SAVEPOINT grant_points_immutable')
    await expect(opsClient.query(`UPDATE creative_point_grants SET points=11 WHERE workspace_id='receipt-ws' AND id='receipt-grant'`)).rejects.toMatchObject({code:'42501'})
    await opsClient.query('ROLLBACK TO SAVEPOINT grant_points_immutable')
    await opsClient.query('SAVEPOINT grant_identity_immutable')
    await expect(opsClient.query(`UPDATE creative_point_grants SET id=id WHERE workspace_id='receipt-ws' AND id='receipt-grant'`)).rejects.toMatchObject({code:'55000'})
    await opsClient.query('ROLLBACK TO SAVEPOINT grant_identity_immutable')
    await opsClient.query(`SELECT set_config('app.workspace_id','receipt-other',true)`)
    expect((await opsClient.query(`SELECT id FROM commercial_orders_v2`)).rows).toHaveLength(0)
    expect((await opsClient.query(`SELECT id FROM creative_point_grants`)).rows).toHaveLength(0)
    await opsClient.query('ROLLBACK')
   }finally{opsClient.release()}
   const client=await db.connect();try{await client.query('BEGIN');await client.query('SET LOCAL ROLE merchant_app');await client.query(`SELECT set_config('app.workspace_id','receipt-other',true)`);expect((await client.query('SELECT id FROM commercial_cash_receipts_v2')).rows).toHaveLength(0);await client.query('ROLLBACK')}finally{client.release()}
  }finally{
   try {
    await db?.end()
    let active=1
    for(let attempt=0;attempt<100&&active>0;attempt+=1){
     active=Number((await admin.query<{count:string}>('SELECT count(*)::text AS count FROM pg_stat_activity WHERE datname=$1',[name])).rows[0]!.count)
     if(active>0)await new Promise(resolve=>setTimeout(resolve,25))
    }
    expect(active,`owned database clients did not exit for ${name}`).toBe(0)
    await admin.query(`DROP DATABASE IF EXISTS "${name}"`)
   }finally{await admin.end()}
  }
 },60000)

 postgresIt('fails migration 271 closed on a NULL-scope unresolved return attached to a matched balance',async()=>{
  const admin=new Pool({connectionString:databaseUrl!});const name=`receipt271_${randomUUID().replaceAll('-','')}`;let db:Pool|undefined
  try{
   await admin.query(`CREATE DATABASE "${name}"`);const connection=new URL(databaseUrl!);connection.pathname=`/${name}`;db=new Pool({connectionString:connection.toString()})
   const migrations=await loadMigrations()
   await new MigrationRunner(db,migrations.filter(migration=>migration.version<=270)).run()
   await db.query(`INSERT INTO workspaces(id,status) VALUES('receipt-ws','active')`)
   await db.query(`INSERT INTO commercial_cash_receipts_v2(id,workspace_id,source,receiving_account_ref,external_trade_id,payer_ref,amount_fen,currency,received_at,verified_at,verified_by_actor_id,evidence,request_hash) VALUES('legacy-null-receipt',NULL,'manual_transfer','bank-legacy','legacy-null-open','payer-A',100,'CNY',$1::timestamptz,$1::timestamptz,'finance','{"bank_ref":"LEGACY"}'::jsonb,$2)`,[time,hash])
   await db.query(`INSERT INTO commercial_cash_receipt_matches_v2(receipt_id,workspace_id,actor_id,reason,evidence,created_at) VALUES('legacy-null-receipt','receipt-ws','finance','legacy verified match','{"owner_match_ref":"LEGACY-MATCH"}'::jsonb,$1::timestamptz)`,[time])
   await db.query(`INSERT INTO commercial_cash_receipt_balances_v2(receipt_id,workspace_id) VALUES('legacy-null-receipt','receipt-ws')`)
   await db.query(`INSERT INTO commercial_cash_returns_v2(id,workspace_id,receipt_id,amount_fen,payer_ref,requested_by_actor_id,reason,evidence,status,request_hash,created_at) VALUES('legacy-null-open-return',NULL,'legacy-null-receipt',25,'payer-A','maker','legacy unresolved return','{"consent_ref":"LEGACY"}'::jsonb,'requested',$1,$2::timestamptz)`,[hash,time])

   await expect(new MigrationRunner(db,migrations).run()).rejects.toMatchObject({code:'23514',message:expect.stringMatching(/NULL tenant scope/u)})
   expect((await db.query(`SELECT version FROM schema_migrations WHERE version=271`)).rows).toHaveLength(0)
  }finally{
   try{
    await db?.end()
    let active=1
    for(let attempt=0;attempt<100&&active>0;attempt+=1){
     active=Number((await admin.query<{count:string}>('SELECT count(*)::text AS count FROM pg_stat_activity WHERE datname=$1',[name])).rows[0]!.count)
     if(active>0)await new Promise(resolve=>setTimeout(resolve,25))
    }
    expect(active,`owned database clients did not exit for ${name}`).toBe(0)
    await admin.query(`DROP DATABASE IF EXISTS "${name}"`)
   }finally{await admin.end()}
  }
 },60000)

 postgresIt('fails migration 271 closed on an unresolved return without its required balance and can retry after repair',async()=>{
  const admin=new Pool({connectionString:databaseUrl!});const name=`receipt271_missing_balance_${randomUUID().replaceAll('-','')}`;let db:Pool|undefined
  try{
   await admin.query(`CREATE DATABASE "${name}"`);const connection=new URL(databaseUrl!);connection.pathname=`/${name}`;db=new Pool({connectionString:connection.toString()})
   const migrations=await loadMigrations()
   await new MigrationRunner(db,migrations.filter(migration=>migration.version<=270)).run()
   await db.query(`INSERT INTO commercial_cash_receipts_v2(id,workspace_id,source,receiving_account_ref,external_trade_id,payer_ref,amount_fen,currency,received_at,verified_at,verified_by_actor_id,evidence,request_hash) VALUES('legacy-receipt-without-balance',NULL,'manual_transfer','bank-legacy','legacy-missing-balance','payer-A',100,'CNY',$1::timestamptz,$1::timestamptz,'finance','{"bank_ref":"LEGACY"}'::jsonb,$2)`,[time,hash])
   await db.query(`INSERT INTO commercial_cash_returns_v2(id,workspace_id,receipt_id,amount_fen,payer_ref,requested_by_actor_id,reason,evidence,status,request_hash,created_at) VALUES('legacy-return-without-balance',NULL,'legacy-receipt-without-balance',25,'payer-A','maker','legacy unresolved return without balance','{"consent_ref":"LEGACY-NO-BALANCE"}'::jsonb,'requested',$1,$2::timestamptz)`,[hash,time])

   await expect(new MigrationRunner(db,migrations).run()).rejects.toMatchObject({code:'23514',message:expect.stringMatching(/missing balance/u)})
   expect((await db.query(`SELECT version FROM schema_migrations WHERE version=271`)).rows).toHaveLength(0)
   expect((await db.query(`SELECT 1 FROM pg_constraint WHERE conname='commercial_cash_returns_receipt_scope_fk'`)).rows).toHaveLength(0)
   expect((await db.query(`SELECT 1 FROM pg_trigger WHERE tgname IN ('commercial_cash_return_scope_guard','commercial_cash_balance_match_guard') AND NOT tgisinternal`)).rows).toHaveLength(0)
   expect((await db.query(`SELECT to_regprocedure('enforce_commercial_cash_return_scope_v2()') AS fn`)).rows[0]?.fn).toBeNull()

   await db.query(`INSERT INTO commercial_cash_receipt_balances_v2(receipt_id,workspace_id) VALUES('legacy-receipt-without-balance',NULL)`)
   // MigrationRunner applies every pending migration in the supplied release
   // chain. The failed first attempt rolled back 271, and this repaired retry
   // must therefore advance the database through the current head.
   const pendingVersions=migrations.filter(migration=>migration.version>270).map(migration=>migration.version)
   expect(await new MigrationRunner(db,migrations).run()).toEqual(pendingVersions)
   expect((await db.query(`SELECT version FROM schema_migrations ORDER BY version`)).rows.map(row=>row.version)).toEqual(migrations.map(migration=>migration.version))
   expect((await db.query(`SELECT version,name FROM schema_migrations WHERE version=271`)).rows).toEqual([{version:271,name:'cash_return_receipt_scope'}])
   await db.query(`UPDATE commercial_cash_returns_v2 SET reason='reconciled unmatched return' WHERE id='legacy-return-without-balance'`)
  }finally{
   try{
    await db?.end()
    let active=1
    for(let attempt=0;attempt<100&&active>0;attempt+=1){
     active=Number((await admin.query<{count:string}>('SELECT count(*)::text AS count FROM pg_stat_activity WHERE datname=$1',[name])).rows[0]!.count)
     if(active>0)await new Promise(resolve=>setTimeout(resolve,25))
    }
    expect(active,`owned database clients did not exit for ${name}`).toBe(0)
    await admin.query(`DROP DATABASE IF EXISTS "${name}"`)
   }finally{await admin.end()}
  }
 },60000)
})
