import { createHash, randomUUID } from 'node:crypto'
import { requireWorkspaceScope, type SqlClient, type SqlPool, withWorkspaceTransaction } from './repository.js'

export class CommercialReceiptError extends Error {
  constructor(readonly code: 'COMMERCIAL_RECEIPT_INVALID' | 'COMMERCIAL_RECEIPT_CONFLICT' | 'COMMERCIAL_RECEIPT_NOT_FOUND' | 'COMMERCIAL_RECEIPT_INSUFFICIENT' | 'COMMERCIAL_RECEIPT_STATE_INVALID', message: string) { super(message); this.name = 'CommercialReceiptError' }
}
export interface CommercialReceiptRecordInput {
  workspaceId: string; source: string; receivingAccountRef: string; externalTradeId: string; payerRef: string
  amountFen: number; currency: 'CNY'; receivedAt: string; evidence: Record<string, unknown>; actorId: string; verifiedAt: string
}
export interface CommercialReceiptAllocationInput {
  workspaceId: string; receiptId: string; orderId: string; amountFen: number; expectedRevision: number; idempotencyKey: string; actorId: string; at: string
}
export interface CommercialReceipt {
  id: string; workspaceId: string | null; source: string; receivingAccountRef: string; externalTradeId: string; payerRef: string
  amountFen: number; currency: 'CNY'; receivedAt: string; verifiedAt: string; evidence: Record<string, unknown>
  allocatedFen: number; returnedFen: number; frozenReturnFen: number; availableFen: number; revision: number
}
export interface CommercialReceiptReturnInput { workspaceId: string; receiptId: string; returnId: string; amountFen: number; payerRef: string; actorId: string; reason: string; evidence: Record<string, unknown>; at: string; expectedRevision: number }
export interface CommercialReceiptReturnDecisionInput { workspaceId: string; returnId: string; actorId: string; action: 'approve' | 'reject'; evidence: Record<string, unknown>; at: string }
export interface CommercialReceiptReturnCompletionInput { workspaceId: string; returnId: string; actorId: string; externalReturnId?: string; outcome: 'completed' | 'unknown'; evidence: Record<string, unknown>; at: string }
export interface CommercialReceiptReturn { id: string; receiptId: string; amountFen: number; payerRef: string; status: 'requested' | 'approved' | 'pending_external' | 'external_unknown' | 'completed' | 'rejected'; requestedByActorId: string; approvedByActorId: string | null; externalReturnId: string | null; createdAt: string }
export interface CommercialReceiptFulfillmentInput { workspaceId: string; orderId: string; provider: 'manual_transfer'; providerEventId: string; nonce: string; payloadHash: string; amountFen: number; currency: 'CNY'; verified: true; paidAt: string; verifiedAt: string }
export interface CommercialReceiptAllocationResult { allocationId: string; receiptId: string; orderId: string; allocatedFen: number; orderAllocatedFen: number; orderAmountFen: number; status: 'partially_received' | 'fully_received'; replayed: boolean }
export type CommercialReceiptFulfill = (client: SqlClient, input: CommercialReceiptFulfillmentInput) => Promise<unknown>
const canonical = (value: unknown): string => JSON.stringify(normalize(value))
function normalize(value: unknown): unknown { if (Array.isArray(value)) return value.map(normalize); if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,normalize(v)])); return value }
const hash = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex')
function required(value: string, field: string): string { if (typeof value !== 'string' || !value.trim() || value.trim() !== value) throw new CommercialReceiptError('COMMERCIAL_RECEIPT_INVALID', `${field} is required`); return value }
function positive(value: number, field: string): number { if (!Number.isSafeInteger(value) || value<=0) throw new CommercialReceiptError('COMMERCIAL_RECEIPT_INVALID',`${field} must be positive integer fen`); return value }
function timestamp(value: string | Date): string { const date = new Date(value); if (!Number.isFinite(date.valueOf())) throw new CommercialReceiptError('COMMERCIAL_RECEIPT_INVALID','timestamp is invalid'); return date.toISOString() }
function evidence(value: Record<string, unknown>): Record<string, unknown> { if (!value || Array.isArray(value) || !Object.keys(value).length) throw new CommercialReceiptError('COMMERCIAL_RECEIPT_INVALID','evidence reference is required'); return value }
const projection = `r.id,b.workspace_id AS "workspaceId",r.source,r.receiving_account_ref AS "receivingAccountRef",r.external_trade_id AS "externalTradeId",r.payer_ref AS "payerRef",r.amount_fen AS "amountFen",r.currency,r.received_at AS "receivedAt",r.verified_at AS "verifiedAt",r.evidence,b.allocated_fen AS "allocatedFen",b.returned_fen AS "returnedFen",b.frozen_return_fen AS "frozenReturnFen",b.revision`
type ReceiptRow = Omit<CommercialReceipt,'availableFen'> & { requestHash?: string }
function map(row: ReceiptRow): CommercialReceipt { return { ...row, amountFen:Number(row.amountFen),allocatedFen:Number(row.allocatedFen),returnedFen:Number(row.returnedFen),frozenReturnFen:Number(row.frozenReturnFen),revision:Number(row.revision),receivedAt:timestamp(row.receivedAt),verifiedAt:timestamp(row.verifiedAt),availableFen:Number(row.amountFen)-Number(row.allocatedFen)-Number(row.returnedFen)-Number(row.frozenReturnFen) } }
const returnProjection=`id,receipt_id AS "receiptId",amount_fen AS "amountFen",payer_ref AS "payerRef",status,requested_by_actor_id AS "requestedByActorId",approved_by_actor_id AS "approvedByActorId",external_return_id AS "externalReturnId",created_at AS "createdAt"`

export class PostgresCommercialReceiptRepository {
  constructor(private readonly pool: SqlPool, private readonly operationsPool?: SqlPool) {}
  async record(input: CommercialReceiptRecordInput): Promise<CommercialReceipt> { return this.recordFact(input, false) }
  async recordUnmatched(input: Omit<CommercialReceiptRecordInput, 'workspaceId'>): Promise<CommercialReceipt> { return this.recordFact({ ...input, workspaceId: '' }, true) }
  private async recordFact(input: CommercialReceiptRecordInput, unmatched: boolean): Promise<CommercialReceipt> {
    const workspaceId=unmatched ? null : requireWorkspaceScope(input.workspaceId); required(input.source,'source'); required(input.receivingAccountRef,'receivingAccountRef'); required(input.externalTradeId,'externalTradeId');required(input.payerRef,'payerRef');required(input.actorId,'actorId');positive(input.amountFen,'amountFen');evidence(input.evidence)
    const receivedAt=timestamp(input.receivedAt), verifiedAt=timestamp(input.verifiedAt)
    if(input.currency!=='CNY' || receivedAt>verifiedAt) throw new CommercialReceiptError('COMMERCIAL_RECEIPT_INVALID','cash time/currency is invalid')
    const requestHash=hash({workspaceId,source:input.source,receivingAccountRef:input.receivingAccountRef,externalTradeId:input.externalTradeId,payerRef:input.payerRef,amountFen:input.amountFen,currency:input.currency,receivedAt,evidence:input.evidence})
    return this.transaction(workspaceId,async client=>{
      await client.query(`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext($1),pg_catalog.hashtext($2))`,['commercial_cash_receipt_identity',canonical([input.source,input.receivingAccountRef,input.externalTradeId])])
      const prior=await client.query<ReceiptRow>(`SELECT ${projection},r.request_hash AS "requestHash" FROM commercial_cash_receipts_v2 r JOIN commercial_cash_receipt_balances_v2 b ON b.receipt_id=r.id WHERE r.source=$1 AND r.receiving_account_ref=$2 AND r.external_trade_id=$3`,[input.source,input.receivingAccountRef,input.externalTradeId])
      if(prior.rows[0]) {if(prior.rows[0].requestHash!==requestHash) throw new CommercialReceiptError('COMMERCIAL_RECEIPT_CONFLICT','external cash identity is already recorded with different facts');return map(prior.rows[0])}
      const id=`cash_${randomUUID()}`
      try {await client.query(`INSERT INTO commercial_cash_receipts_v2(id,workspace_id,source,receiving_account_ref,external_trade_id,payer_ref,amount_fen,currency,received_at,verified_at,verified_by_actor_id,evidence,request_hash) VALUES($1,$2,$3,$4,$5,$6,$7,'CNY',$8::timestamptz,$9::timestamptz,$10,$11::jsonb,$12)`,[id,workspaceId,input.source,input.receivingAccountRef,input.externalTradeId,input.payerRef,input.amountFen,receivedAt,verifiedAt,input.actorId,JSON.stringify(input.evidence),requestHash])} catch(error) {if((error as {code?:string}).code==='23505')throw new CommercialReceiptError('COMMERCIAL_RECEIPT_CONFLICT','external cash identity is already recorded');throw error}
      await client.query(`INSERT INTO commercial_cash_receipt_balances_v2(receipt_id,workspace_id) VALUES($1,$2)`,[id,workspaceId])
      const row=await client.query<ReceiptRow>(`SELECT ${projection} FROM commercial_cash_receipts_v2 r JOIN commercial_cash_receipt_balances_v2 b ON b.receipt_id=r.id WHERE r.id=$1`,[id]);return map(row.rows[0]!)
    })
  }
  async listUnmatched(limit = 50,cursor?:{receivedAt:string;id:string}): Promise<CommercialReceipt[]> { if (!Number.isInteger(limit) || limit<1 || limit>100) throw new CommercialReceiptError('COMMERCIAL_RECEIPT_INVALID','limit must be 1..100'); return this.transaction(null, async client => (await client.query<ReceiptRow>(`SELECT ${projection} FROM commercial_cash_receipts_v2 r JOIN commercial_cash_receipt_balances_v2 b ON b.receipt_id=r.id WHERE b.workspace_id IS NULL AND ($2::timestamptz IS NULL OR (r.received_at,r.id)>($2::timestamptz,$3::text)) ORDER BY r.received_at,r.id LIMIT $1`, [limit,cursor?timestamp(cursor.receivedAt):null,cursor?required(cursor.id,'cursor.id'):null])).rows.map(map)) }
  async matchUnmatched(input: { receiptId: string; workspaceId: string; actorId: string; reason: string; evidence: Record<string, unknown>; at: string }): Promise<CommercialReceipt> {
    const workspaceId=requireWorkspaceScope(input.workspaceId); required(input.actorId,'actorId');required(input.reason,'reason');evidence(input.evidence)
    return this.transaction(null, async client => {
      const locked=await client.query<{workspaceId:string|null}>(`SELECT workspace_id AS "workspaceId" FROM commercial_cash_receipt_balances_v2 WHERE receipt_id=$1 FOR UPDATE`,[input.receiptId]);const row=locked.rows[0];if(!row)throw new CommercialReceiptError('COMMERCIAL_RECEIPT_NOT_FOUND','receipt not found')
      if(row.workspaceId!==null){if(row.workspaceId!==workspaceId)throw new CommercialReceiptError('COMMERCIAL_RECEIPT_CONFLICT','receipt already matched to another workspace');const prior=await client.query<ReceiptRow>(`SELECT ${projection} FROM commercial_cash_receipts_v2 r JOIN commercial_cash_receipt_balances_v2 b ON b.receipt_id=r.id WHERE r.id=$1`,[input.receiptId]);return map(prior.rows[0]!)}
      const openReturns=await client.query(`SELECT id FROM commercial_cash_returns_v2 WHERE receipt_id=$1 AND status NOT IN ('completed','rejected')`,[input.receiptId]);if(openReturns.rows.length)throw new CommercialReceiptError('COMMERCIAL_RECEIPT_STATE_INVALID','unmatched receipt has unresolved return disposition')
      await client.query(`INSERT INTO commercial_cash_receipt_matches_v2(receipt_id,workspace_id,actor_id,reason,evidence,created_at) VALUES($1,$2,$3,$4,$5::jsonb,$6::timestamptz)`,[input.receiptId,workspaceId,input.actorId,input.reason,JSON.stringify(input.evidence),timestamp(input.at)])
      await client.query(`UPDATE commercial_cash_receipt_balances_v2 SET workspace_id=$2,revision=revision+1 WHERE receipt_id=$1`,[input.receiptId,workspaceId])
      const receipt=await client.query<ReceiptRow>(`SELECT ${projection} FROM commercial_cash_receipts_v2 r JOIN commercial_cash_receipt_balances_v2 b ON b.receipt_id=r.id WHERE r.id=$1`,[input.receiptId]);return map(receipt.rows[0]!)
    })
  }
  private async transaction<T>(workspaceId:string|null, action:(client:SqlClient)=>Promise<T>):Promise<T>{
    if(workspaceId!==null)return withWorkspaceTransaction(this.pool,workspaceId,action)
    if(!this.operationsPool)throw new CommercialReceiptError('COMMERCIAL_RECEIPT_STATE_INVALID','unmatched cash requires configured operations database role')
    const client=await this.operationsPool.connect();try{await client.query('BEGIN');await client.query(`SELECT set_config('app.platform_scope','platform_ops',true)`);const result=await action(client);await client.query('COMMIT');return result}catch(error){await client.query('ROLLBACK');throw error}finally{client.release?.()}
  }
  /** Recover a lost response using factual external identity, never balance inference.
   * NULL scope is reserved for the configured operations pool and the original
   * unmatched fact; a later match does not erase that actor's original identity. */
  async findReceiptByExternalIdentity(workspaceIdInput:string|null,actorIdInput:string,identity:{source:string;receivingAccountRef:string;externalTradeId:string}):Promise<CommercialReceipt|null>{
    const workspaceId=workspaceIdInput===null?null:requireWorkspaceScope(workspaceIdInput)
    const actorId=required(actorIdInput,'actorId');required(identity.source,'source');required(identity.receivingAccountRef,'receivingAccountRef');required(identity.externalTradeId,'externalTradeId')
    return this.transaction(workspaceId,async client=>{
      const result=await client.query<ReceiptRow>(`SELECT ${projection} FROM commercial_cash_receipts_v2 r JOIN commercial_cash_receipt_balances_v2 b ON b.receipt_id=r.id WHERE (($1::text IS NULL AND r.workspace_id IS NULL) OR ($1::text IS NOT NULL AND b.workspace_id=$1)) AND r.verified_by_actor_id=$2 AND r.source=$3 AND r.receiving_account_ref=$4 AND r.external_trade_id=$5`,[workspaceId,actorId,identity.source,identity.receivingAccountRef,identity.externalTradeId])
      return result.rows[0]?map(result.rows[0]):null
    })
  }
  /** Return request IDs identify the original maker's intent, including unknown
   * cash in explicit NULL operations scope. They are never permission tokens. */
  async getReturnByRequestId(workspaceIdInput:string|null,actorIdInput:string,returnIdInput:string):Promise<CommercialReceiptReturn|null>{
    const workspaceId=workspaceIdInput===null?null:requireWorkspaceScope(workspaceIdInput)
    const actorId=required(actorIdInput,'actorId'),returnId=required(returnIdInput,'returnId')
    return this.transaction(workspaceId,async client=>{
      const result=await client.query<CommercialReceiptReturn>(`SELECT ${returnProjection} FROM commercial_cash_returns_v2 WHERE workspace_id IS NOT DISTINCT FROM $1::text AND requested_by_actor_id=$2 AND id=$3`,[workspaceId,actorId,returnId])
      return result.rows[0]?this.mapReturn(result.rows[0]):null
    })
  }
  /** Exact obligation lookup after the caller has checked the independent
   * finance capability. Maker-only request recovery remains a separate API. */
  async getReturn(workspaceIdInput:string|null,returnIdInput:string):Promise<CommercialReceiptReturn|null>{
    const workspaceId=workspaceIdInput===null?null:requireWorkspaceScope(workspaceIdInput)
    const returnId=required(returnIdInput,'returnId')
    return this.transaction(workspaceId,async client=>{
      const result=await client.query<CommercialReceiptReturn>(`SELECT ${returnProjection} FROM commercial_cash_returns_v2 WHERE workspace_id IS NOT DISTINCT FROM $1::text AND id=$2`,[workspaceId,returnId])
      return result.rows[0]?this.mapReturn(result.rows[0]):null
    })
  }
  async get(workspaceIdInput:string, receiptId:string):Promise<CommercialReceipt|null>{const workspaceId=requireWorkspaceScope(workspaceIdInput);return withWorkspaceTransaction(this.pool,workspaceId,client=>this.getIn(client,workspaceId,required(receiptId,'receiptId')))}
  async list(workspaceIdInput:string,limit=50,cursor?:{receivedAt:string;id:string}):Promise<CommercialReceipt[]>{const workspaceId=requireWorkspaceScope(workspaceIdInput);if(!Number.isInteger(limit)||limit<1||limit>100)throw new CommercialReceiptError('COMMERCIAL_RECEIPT_INVALID','limit must be 1..100');return withWorkspaceTransaction(this.pool,workspaceId,async client=>(await client.query<ReceiptRow>(`SELECT ${projection} FROM commercial_cash_receipts_v2 r JOIN commercial_cash_receipt_balances_v2 b ON b.receipt_id=r.id WHERE b.workspace_id=$1 AND ($3::timestamptz IS NULL OR (r.received_at,r.id)<($3::timestamptz,$4::text)) ORDER BY r.received_at DESC,r.id DESC LIMIT $2`,[workspaceId,limit,cursor?timestamp(cursor.receivedAt):null,cursor?required(cursor.id,'cursor.id'):null])).rows.map(map))}
  async getAllocationByIdempotencyKey(workspaceIdInput:string,key:string):Promise<{receiptId:string;orderId:string;amountFen:number;actorId:string;result:CommercialReceiptAllocationResult}|null>{const workspaceId=requireWorkspaceScope(workspaceIdInput);return withWorkspaceTransaction(this.pool,workspaceId,async client=>{const row=(await client.query<{receiptId:string;orderId:string;amountFen:string|number;actorId:string;result:CommercialReceiptAllocationResult}>(`SELECT receipt_id AS "receiptId",order_id AS "orderId",amount_fen AS "amountFen",actor_id AS "actorId",result FROM commercial_cash_allocations_v2 WHERE workspace_id=$1 AND idempotency_key=$2`,[workspaceId,required(key,'idempotencyKey')])).rows[0];return row?{...row,amountFen:Number(row.amountFen),result:{...row.result,replayed:true}}:null})}
  async getOrderAllocationTotal(workspaceIdInput:string,orderId:string):Promise<number>{const workspaceId=requireWorkspaceScope(workspaceIdInput);return withWorkspaceTransaction(this.pool,workspaceId,async client=>Number((await client.query<{total:string|number}>(`SELECT COALESCE(sum(amount_fen),0) AS total FROM commercial_cash_allocations_v2 WHERE workspace_id=$1 AND order_id=$2`,[workspaceId,orderId])).rows[0]?.total??0))}
  async allocateAndFulfill(input:CommercialReceiptAllocationInput,fulfill:CommercialReceiptFulfill):Promise<CommercialReceiptAllocationResult>{return (await this.allocateBatchAndFulfill([input],fulfill))[0]!}
  async allocateBatchAndFulfill(inputs:CommercialReceiptAllocationInput[],fulfill:CommercialReceiptFulfill):Promise<CommercialReceiptAllocationResult[]>{
    if(inputs.length<1||inputs.length>100)throw new CommercialReceiptError('COMMERCIAL_RECEIPT_INVALID','allocation batch must be 1..100')
    const workspaceId=requireWorkspaceScope(inputs[0]!.workspaceId)
    for(const input of inputs){if(input.workspaceId!==workspaceId)throw new CommercialReceiptError('COMMERCIAL_RECEIPT_INVALID','batch requires one workspace');positive(input.amountFen,'amountFen');required(input.idempotencyKey,'idempotencyKey');required(input.actorId,'actorId');timestamp(input.at);if(!Number.isSafeInteger(input.expectedRevision)||input.expectedRevision<1)throw new CommercialReceiptError('COMMERCIAL_RECEIPT_INVALID','expectedRevision required')}
    return withWorkspaceTransaction(this.pool,workspaceId,async client=>{
      for(const receiptId of [...new Set(inputs.map(v=>v.receiptId))].sort())await this.lockReceipt(client,workspaceId,receiptId)
      await this.workspaceLock(client,workspaceId)
      for(const orderId of [...new Set(inputs.map(v=>v.orderId))].sort())await client.query(`SELECT id FROM commercial_orders_v2 WHERE workspace_id=$1 AND id=$2 FOR UPDATE`,[workspaceId,orderId])
      const initialRevisions = new Map<string, number>()
      for (const receiptId of [...new Set(inputs.map(v=>v.receiptId))]) initialRevisions.set(receiptId, (await this.getIn(client,workspaceId,receiptId))!.revision)
      const results:CommercialReceiptAllocationResult[]=[]
      for(const input of inputs){
        const requestHash=hash({receiptId:input.receiptId,orderId:input.orderId,amountFen:input.amountFen,actorId:input.actorId})
        const replay=await client.query<{id:string;requestHash:string}>(`SELECT id,request_hash AS "requestHash" FROM commercial_cash_allocations_v2 WHERE workspace_id=$1 AND idempotency_key=$2`,[workspaceId,input.idempotencyKey])
        if(replay.rows[0]&&replay.rows[0].requestHash!==requestHash)throw new CommercialReceiptError('COMMERCIAL_RECEIPT_CONFLICT','allocation key has another intent')
        const receipt=(await this.getIn(client,workspaceId,input.receiptId))!
        const order=await client.query<{amountFen:string|number;status:string;expiresAt:string|Date|null}>(`SELECT o.amount_fen AS "amountFen",o.status,t.expires_at AS "expiresAt" FROM commercial_orders_v2 o LEFT JOIN commercial_order_terms_v3 t ON t.workspace_id=o.workspace_id AND t.order_id=o.id WHERE o.workspace_id=$1 AND o.id=$2`,[workspaceId,input.orderId]);const row=order.rows[0]
        if(!row)throw new CommercialReceiptError('COMMERCIAL_RECEIPT_NOT_FOUND','order was not found')
        const allocated=await client.query<{total:string|number}>(`SELECT COALESCE(sum(amount_fen),0) AS total FROM commercial_cash_allocations_v2 WHERE workspace_id=$1 AND order_id=$2`,[workspaceId,input.orderId]);const before=Number(allocated.rows[0]?.total??0)
        if(!replay.rows[0]){
          if(initialRevisions.get(input.receiptId)!==input.expectedRevision)throw new CommercialReceiptError('COMMERCIAL_RECEIPT_CONFLICT','receipt revision changed; refresh preview')
          if(row.status!=='pending'||!row.expiresAt||Date.parse(receipt.receivedAt)>=Date.parse(timestamp(row.expiresAt)))throw new CommercialReceiptError('COMMERCIAL_RECEIPT_STATE_INVALID','order cannot accept this receipt; use controlled disposition')
          if(receipt.availableFen<input.amountFen||before+input.amountFen>Number(row.amountFen))throw new CommercialReceiptError('COMMERCIAL_RECEIPT_INSUFFICIENT','allocation exceeds unallocated cash or order amount')
          const id=`casha_${randomUUID()}`;await client.query(`INSERT INTO commercial_cash_allocations_v2(id,workspace_id,receipt_id,order_id,amount_fen,idempotency_key,request_hash,actor_id,result,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$10::jsonb,$9::timestamptz)`,[id,workspaceId,input.receiptId,input.orderId,input.amountFen,input.idempotencyKey,requestHash,input.actorId,timestamp(input.at),JSON.stringify({allocationId:id,receiptId:input.receiptId,orderId:input.orderId,allocatedFen:input.amountFen,orderAllocatedFen:before+input.amountFen,orderAmountFen:Number(row.amountFen),status:before+input.amountFen===Number(row.amountFen)?'fully_received':'partially_received',replayed:false})])
          results.push({allocationId:id,receiptId:input.receiptId,orderId:input.orderId,allocatedFen:input.amountFen,orderAllocatedFen:before+input.amountFen,orderAmountFen:Number(row.amountFen),status:before+input.amountFen===Number(row.amountFen)?'fully_received':'partially_received',replayed:false})
        }else results.push({allocationId:replay.rows[0].id,receiptId:input.receiptId,orderId:input.orderId,allocatedFen:input.amountFen,orderAllocatedFen:before,orderAmountFen:Number(row.amountFen),status:before===Number(row.amountFen)?'fully_received':'partially_received',replayed:true})
      }
      // Qualification lines precede dependent plan lines while remaining in one transaction.
      const orders=await client.query<{id:string}>(`SELECT o.id FROM commercial_orders_v2 o JOIN commercial_order_snapshots_v2 s ON s.workspace_id=o.workspace_id AND s.order_id=o.id WHERE o.workspace_id=$1 AND o.id=ANY($2::text[]) ORDER BY CASE WHEN s.snapshot->'sku'->>'kind'='onboarding' THEN 0 ELSE 1 END,o.id`,[workspaceId,[...new Set(inputs.map(v=>v.orderId))]])
      for(const {id} of orders.rows){const result=results.find(r=>r.orderId===id&&r.status==='fully_received');if(!result)continue
        const cash=await client.query<{paidAt:string|Date;allocationIds:string[]}>(`SELECT max(r.received_at) AS "paidAt",array_agg(a.id ORDER BY a.id) AS "allocationIds" FROM commercial_cash_allocations_v2 a JOIN commercial_cash_receipts_v2 r ON r.id=a.receipt_id WHERE a.workspace_id=$1 AND a.order_id=$2`,[workspaceId,id]);const fact=cash.rows[0]!;const eventId=`cash_order:${id}`
        await fulfill(client,{workspaceId,orderId:id,provider:'manual_transfer',providerEventId:eventId,nonce:eventId,payloadHash:hash({orderId:id,allocationIds:fact.allocationIds,amountFen:result.orderAmountFen}),amountFen:result.orderAmountFen,currency:'CNY',verified:true,paidAt:timestamp(fact.paidAt),verifiedAt:timestamp(inputs[0]!.at)})
      }
      return results
    })
  }
  async proposeUnmatchedReturn(input:Omit<CommercialReceiptReturnInput,'workspaceId'>):Promise<CommercialReceiptReturn>{return this.proposeReturn({...input,workspaceId:''},true)}
  async proposeReturn(input:CommercialReceiptReturnInput,unmatched=false):Promise<CommercialReceiptReturn>{
    const workspaceId=unmatched?null:requireWorkspaceScope(input.workspaceId);positive(input.amountFen,'amountFen');required(input.returnId,'returnId');required(input.actorId,'actorId');required(input.reason,'reason');evidence(input.evidence)
    const requestHash=hash({receiptId:input.receiptId,amountFen:input.amountFen,payerRef:input.payerRef,actorId:input.actorId,reason:input.reason,evidence:input.evidence})
    return this.transaction(workspaceId,async client=>{await this.lockReceipt(client,workspaceId,input.receiptId);const prior=await client.query<CommercialReceiptReturn &{requestHash:string}>(`SELECT ${returnProjection},request_hash AS "requestHash" FROM commercial_cash_returns_v2 WHERE workspace_id IS NOT DISTINCT FROM $1 AND id=$2`,[workspaceId,input.returnId]);if(prior.rows[0]){if(prior.rows[0].requestHash!==requestHash)throw new CommercialReceiptError('COMMERCIAL_RECEIPT_CONFLICT','return identity has another intent');return this.mapReturn(prior.rows[0])}
      const receipt=(await this.getIn(client,workspaceId,input.receiptId))!;if(receipt.payerRef!==input.payerRef||receipt.availableFen<input.amountFen)throw new CommercialReceiptError('COMMERCIAL_RECEIPT_INSUFFICIENT','return must fit available cash and original payer');if(receipt.revision!==input.expectedRevision)throw new CommercialReceiptError('COMMERCIAL_RECEIPT_CONFLICT','receipt changed; refresh preview')
      const inserted=await client.query<CommercialReceiptReturn>(`INSERT INTO commercial_cash_returns_v2(id,workspace_id,receipt_id,amount_fen,payer_ref,requested_by_actor_id,reason,evidence,status,request_hash,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,'requested',$9,$10::timestamptz) RETURNING ${returnProjection}`,[input.returnId,workspaceId,input.receiptId,input.amountFen,input.payerRef,input.actorId,input.reason,JSON.stringify(input.evidence),requestHash,timestamp(input.at)]);return this.mapReturn(inserted.rows[0]!)})
  }
  async decideUnmatchedReturn(input:Omit<CommercialReceiptReturnDecisionInput,'workspaceId'>):Promise<CommercialReceiptReturn>{return this.decideReturn({...input,workspaceId:''},true)}
  async decideReturn(input:CommercialReceiptReturnDecisionInput,unmatched=false):Promise<CommercialReceiptReturn>{
    const workspaceId=unmatched?null:requireWorkspaceScope(input.workspaceId);required(input.actorId,'actorId');evidence(input.evidence)
    return this.transaction(workspaceId,async client=>{const row=await this.lockReturn(client,workspaceId,input.returnId);if(row.status===(input.action==='approve'?'approved':'rejected')){if(row.approvedByActorId!==input.actorId)throw new CommercialReceiptError('COMMERCIAL_RECEIPT_CONFLICT','decision actor differs from recorded decision');return row;}if(row.status!=='requested'||row.requestedByActorId===input.actorId)throw new CommercialReceiptError('COMMERCIAL_RECEIPT_STATE_INVALID','return requires distinct approver and requested state')
      if(input.action==='approve'){const receipt=(await this.getIn(client,workspaceId,row.receiptId))!;if(receipt.availableFen<row.amountFen)throw new CommercialReceiptError('COMMERCIAL_RECEIPT_INSUFFICIENT','cash already allocated or frozen');await client.query(`UPDATE commercial_cash_receipt_balances_v2 SET frozen_return_fen=frozen_return_fen+$3,revision=revision+1 WHERE workspace_id IS NOT DISTINCT FROM $1 AND receipt_id=$2`,[workspaceId,row.receiptId,row.amountFen])}
      const result=await client.query<CommercialReceiptReturn>(`UPDATE commercial_cash_returns_v2 SET status=$3,approved_by_actor_id=$4,approval_evidence=$5::jsonb WHERE workspace_id IS NOT DISTINCT FROM $1 AND id=$2 RETURNING ${returnProjection}`,[workspaceId,input.returnId,input.action==='approve'?'approved':'rejected',input.actorId,JSON.stringify(input.evidence)]);return this.mapReturn(result.rows[0]!)})
  }
  async completeUnmatchedReturn(input:Omit<CommercialReceiptReturnCompletionInput,'workspaceId'>):Promise<CommercialReceiptReturn>{return this.completeReturn({...input,workspaceId:''},true)}
  async completeReturn(input:CommercialReceiptReturnCompletionInput,unmatched=false):Promise<CommercialReceiptReturn>{
    const workspaceId=unmatched?null:requireWorkspaceScope(input.workspaceId);required(input.actorId,'actorId');evidence(input.evidence);if(input.outcome==='completed')required(input.externalReturnId??'','externalReturnId')
    return this.transaction(workspaceId,async client=>{const row=await this.lockReturn(client,workspaceId,input.returnId);if(row.status==='completed'){if(row.externalReturnId!==input.externalReturnId)throw new CommercialReceiptError('COMMERCIAL_RECEIPT_CONFLICT','return already completed with another external fact');return row}if(!['approved','pending_external','external_unknown'].includes(row.status))throw new CommercialReceiptError('COMMERCIAL_RECEIPT_STATE_INVALID','return must have approved frozen cash')
      if(input.outcome==='completed'){const settled=await client.query(`UPDATE commercial_cash_receipt_balances_v2 SET frozen_return_fen=frozen_return_fen-$3,returned_fen=returned_fen+$3,revision=revision+1 WHERE workspace_id IS NOT DISTINCT FROM $1 AND receipt_id=$2 AND frozen_return_fen>=$3`,[workspaceId,row.receiptId,row.amountFen]);if(settled.rowCount!==1)throw new CommercialReceiptError('COMMERCIAL_RECEIPT_STATE_INVALID','approved cash freeze is unavailable')}
      const result=await client.query<CommercialReceiptReturn>(`UPDATE commercial_cash_returns_v2 SET status=$3,external_return_id=$4,completed_at=$5::timestamptz,evidence=evidence||$6::jsonb WHERE workspace_id IS NOT DISTINCT FROM $1 AND id=$2 RETURNING ${returnProjection}`,[workspaceId,input.returnId,input.outcome==='completed'?'completed':'external_unknown',input.externalReturnId??null,input.outcome==='completed'?timestamp(input.at):null,JSON.stringify({completion:input.evidence})]);return this.mapReturn(result.rows[0]!)})
  }
  async listUnmatchedReturns(limit=50,cursor?:{createdAt:string;id:string}):Promise<CommercialReceiptReturn[]>{if(!Number.isInteger(limit)||limit<1||limit>100)throw new CommercialReceiptError('COMMERCIAL_RECEIPT_INVALID','limit must be 1..100');return this.transaction(null,async client=>(await client.query<CommercialReceiptReturn>(`SELECT ${returnProjection} FROM commercial_cash_returns_v2 WHERE workspace_id IS NULL AND ($2::timestamptz IS NULL OR (created_at,id)<($2::timestamptz,$3::text)) ORDER BY created_at DESC,id DESC LIMIT $1`,[limit,cursor?timestamp(cursor.createdAt):null,cursor?required(cursor.id,'cursor.id'):null])).rows.map(row=>this.mapReturn(row)))}
  async listReturns(workspaceIdInput:string,limit=50,cursor?:{createdAt:string;id:string}):Promise<CommercialReceiptReturn[]>{const workspaceId=requireWorkspaceScope(workspaceIdInput);if(!Number.isInteger(limit)||limit<1||limit>100)throw new CommercialReceiptError('COMMERCIAL_RECEIPT_INVALID','limit must be 1..100');return withWorkspaceTransaction(this.pool,workspaceId,async client=>(await client.query<CommercialReceiptReturn>(`SELECT ${returnProjection} FROM commercial_cash_returns_v2 WHERE workspace_id=$1 AND ($3::timestamptz IS NULL OR (created_at,id)<($3::timestamptz,$4::text)) ORDER BY created_at DESC,id DESC LIMIT $2`,[workspaceId,limit,cursor?timestamp(cursor.createdAt):null,cursor?required(cursor.id,'cursor.id'):null])).rows.map(row=>this.mapReturn(row)))}
  private async getIn(client:SqlClient,workspaceId:string|null,id:string){const result=await client.query<ReceiptRow>(`SELECT ${projection} FROM commercial_cash_receipts_v2 r JOIN commercial_cash_receipt_balances_v2 b ON b.receipt_id=r.id WHERE b.workspace_id IS NOT DISTINCT FROM $1 AND r.id=$2`,[workspaceId,id]);return result.rows[0]?map(result.rows[0]):null}
  private async lockReceipt(client:SqlClient,workspaceId:string|null,id:string){const result=await client.query(`SELECT receipt_id FROM commercial_cash_receipt_balances_v2 WHERE workspace_id IS NOT DISTINCT FROM $1 AND receipt_id=$2 FOR UPDATE`,[workspaceId,id]);if(result.rows.length!==1)throw new CommercialReceiptError('COMMERCIAL_RECEIPT_NOT_FOUND','receipt was not found')}
  private async workspaceLock(client:SqlClient,workspaceId:string){await client.query(`SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext($1),pg_catalog.hashtext($2))`,['workspace_subscription_periods_v2',workspaceId])}
  private async lockReturn(client:SqlClient,workspaceId:string|null,id:string){const found=await client.query<CommercialReceiptReturn>(`SELECT ${returnProjection} FROM commercial_cash_returns_v2 WHERE workspace_id IS NOT DISTINCT FROM $1 AND id=$2`,[workspaceId,id]);if(!found.rows[0])throw new CommercialReceiptError('COMMERCIAL_RECEIPT_NOT_FOUND','return request was not found');await this.lockReceipt(client,workspaceId,found.rows[0].receiptId);const locked=await client.query<CommercialReceiptReturn>(`SELECT ${returnProjection} FROM commercial_cash_returns_v2 WHERE workspace_id IS NOT DISTINCT FROM $1 AND id=$2 FOR UPDATE`,[workspaceId,id]);return this.mapReturn(locked.rows[0]!)}
  private mapReturn(row:CommercialReceiptReturn):CommercialReceiptReturn{return {...row,amountFen:Number(row.amountFen),createdAt:timestamp(row.createdAt)}}
}
