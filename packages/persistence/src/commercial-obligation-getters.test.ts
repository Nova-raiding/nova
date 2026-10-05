import { describe,expect,it } from 'vitest'
import { PostgresCommercialReceiptRepository } from './commercial-receipt-repository.js'
import { PostgresServiceFulfillmentRepository } from './service-fulfillment-repository.js'
import type { SqlClient,SqlPool,SqlQueryResult } from './repository.js'

const returned={id:'return-older-than-first-page',receiptId:'cash-1',amountFen:'100',payerRef:'original-payer',status:'approved',requestedByActorId:'maker',approvedByActorId:'independent-finance',externalReturnId:null,createdAt:'2026-10-05T00:00:00.000Z'}
class Client implements SqlClient {
  calls:Array<{sql:string;params:readonly unknown[]}> = []
  constructor(private readonly scope:string|null,private readonly row:unknown,private readonly table:string,private readonly id:string){}
  async query<Row>(sql:string,params:readonly unknown[]=[]):Promise<SqlQueryResult<Row>> {
    this.calls.push({sql,params})
    return { rows: sql.includes(`FROM ${this.table}`)&&params[0]===this.scope&&params[1]===this.id ? [this.row as Row] : [] }
  }
  release(){}
}
const pool=(client:Client):SqlPool=>({connect:async()=>client})

describe('exact old commercial obligation facts',()=>{
  it('allows independently authorized finance to find an approved return regardless of its maker or list position',async()=>{
    const client=new Client('ws-1',returned,'commercial_cash_returns_v2',returned.id)
    const repo=new PostgresCommercialReceiptRepository(pool(client))
    expect(await repo.getReturn('ws-1',returned.id)).toMatchObject({id:returned.id,status:'approved',requestedByActorId:'maker',amountFen:100})
    expect(await repo.getReturn('other-ws',returned.id)).toBeNull()
    expect(await repo.getReturn('ws-1','missing')).toBeNull()
    const query=client.calls.find(call=>call.sql.includes('FROM commercial_cash_returns_v2'))!
    expect(query.sql).not.toMatch(/LIMIT|requested_by_actor_id\s*=/)
  })
  it('keeps unmatched obligations inside the explicitly configured operations scope',async()=>{
    const base=new Client('ws-1',returned,'commercial_cash_returns_v2',returned.id)
    const ops=new Client(null,returned,'commercial_cash_returns_v2',returned.id)
    const repo=new PostgresCommercialReceiptRepository(pool(base),pool(ops))
    expect(await repo.getReturn(null,returned.id)).toMatchObject({id:returned.id,status:'approved'})
    expect(base.calls).toHaveLength(0)
    expect(ops.calls.some(call=>call.sql.includes("set_config('app.platform_scope','platform_ops',true)"))).toBe(true)
    await expect(new PostgresCommercialReceiptRepository(pool(base)).getReturn(null,returned.id)).rejects.toMatchObject({code:'COMMERCIAL_RECEIPT_STATE_INVALID'})
  })
  it('resolves a paid approved source by exact snapshot identity and returns null for another tenant',async()=>{
    const client=new Client('ws-1',{orderId:'old-order',sourceChecksum:'a'.repeat(64)},'commercial_order_snapshots_v2','old-snapshot')
    const repo=new PostgresServiceFulfillmentRepository(pool(client))
    expect(await repo.getSourceOrderObligation('ws-1','old-snapshot')).toEqual({orderId:'old-order',sourceChecksum:'a'.repeat(64)})
    expect(await repo.getSourceOrderObligation('other-ws','old-snapshot')).toBeNull()
    expect(await repo.getAllocation('ws-1','missing-allocation')).toBeNull()
    const query=client.calls.find(call=>call.sql.includes('FROM commercial_order_snapshots_v2'))!
    expect(query.sql).toContain("o.status='paid'")
    expect(query.sql).toContain("->>'lifecycle'='approved'")
    expect(query.sql).toContain("->>'executable'='true'")
    expect(query.sql).not.toContain('LIMIT')
  })
})
