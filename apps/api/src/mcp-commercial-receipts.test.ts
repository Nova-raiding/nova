import { afterEach, describe, expect, it, vi } from 'vitest'
import { handleCommercialReceiptMethod } from './mcp-commercial-receipts.js'
const key='shared-test-preview-signing-key',at=new Date('2026-10-05T00:00:00Z')
const required=(params:Record<string,unknown>,name:string)=>{if(typeof params[name]!=='string'||!params[name])throw new Error(name);return params[name] as string}
const receipt={id:'r1',workspaceId:'ws-1',amountFen:10000,availableFen:10000,revision:1,receivedAt:'2026-10-01T00:00:00Z'}
const allocation={receiptId:'r1',orderId:'o1',amountFen:5000,actorId:'operator',result:{orderId:'o1',replayed:true}}
function setup(overrides:Record<string,unknown>={}) {
 const receipts={get:vi.fn(async()=>receipt),getOrderAllocationTotal:vi.fn(async()=>0),getAllocationByIdempotencyKey:vi.fn(async()=>null),allocateAndFulfill:vi.fn(async()=>allocation.result),allocateBatchAndFulfill:vi.fn(async()=>[allocation.result]),...overrides}
 const contracts={getPaymentStatus:vi.fn(async()=>({order:{id:'o1',amountFen:10000},skuCode:'basic'})),getOrderSnapshot:vi.fn(async()=>({snapshot:{sku:{code:'basic'}}}))}
 const deps={receipts,contracts,actorId:'operator',previewSigningKey:key,required,object:(params:Record<string,unknown>,name:string)=>params[name],fulfill:vi.fn()} as unknown as Parameters<typeof handleCommercialReceiptMethod>[2]
 return {receipts,contracts,deps}
}
const input={target_workspace_id:'ws-1',receipt_id:'r1',order_id:'o1',amount_fen:5000,expected_revision:1,idempotency_key:'allocation-key'}
afterEach(()=>vi.useRealTimers())
describe('cash allocation preview and pagination',()=>{
 it('rejects expired single allocation confirmation and returns a committed original after that same deadline',async()=>{
  vi.useFakeTimers();vi.setSystemTime(at);const {receipts,deps}=setup()
  const preview=await handleCommercialReceiptMethod('ops.commercial.receipt.allocation.preview',input,deps) as {preview_hash:string}
  vi.setSystemTime(at.valueOf()+300000)
  await expect(handleCommercialReceiptMethod('ops.commercial.receipt.allocation.confirm',{...input,preview_hash:preview.preview_hash},deps)).rejects.toMatchObject({code:'COMMERCIAL_PREVIEW_EXPIRED'})
  expect(receipts.allocateAndFulfill).not.toHaveBeenCalled()
  receipts.getAllocationByIdempotencyKey.mockResolvedValue(allocation as never)
  expect(await handleCommercialReceiptMethod('ops.commercial.receipt.allocation.confirm',{...input,preview_hash:preview.preview_hash},deps)).toMatchObject({replayed:true})
  await expect(handleCommercialReceiptMethod('ops.commercial.receipt.allocation.confirm',{...input,amount_fen:4999},deps)).rejects.toMatchObject({code:'COMMERCIAL_RECEIPT_CONFLICT'})
 })
 it('binds a batch to stable server details and deadline instead of regenerated child tokens',async()=>{
  vi.useFakeTimers();vi.setSystemTime(at);const {receipts,deps}=setup()
  const batch={target_workspace_id:'ws-1',allocations_json:JSON.stringify([input]),idempotency_key:'batch-key'}
  const preview=await handleCommercialReceiptMethod('ops.commercial.receipt.allocations.preview',batch,deps) as {preview_hash:string}
  vi.setSystemTime(at.valueOf()+1000)
  expect(await handleCommercialReceiptMethod('ops.commercial.receipt.allocations.confirm',{...batch,preview_hash:preview.preview_hash},deps)).toMatchObject({replayed:false})
  expect(receipts.allocateBatchAndFulfill).toHaveBeenCalledTimes(1)
  vi.setSystemTime(at.valueOf()+300000)
  await expect(handleCommercialReceiptMethod('ops.commercial.receipt.allocations.confirm',{...batch,preview_hash:preview.preview_hash},deps)).rejects.toMatchObject({code:'COMMERCIAL_PREVIEW_EXPIRED'})
  expect(receipts.allocateBatchAndFulfill).toHaveBeenCalledTimes(1)
 })
 it('rejects shortened or otherwise changed original batch intent on replay',async()=>{
  const {deps}=setup({getAllocationByIdempotencyKey:vi.fn(async()=>allocation)})
  const batch={target_workspace_id:'ws-1',allocations_json:JSON.stringify([input]),idempotency_key:'original-two-lines',preview_hash:'old-token'}
  await expect(handleCommercialReceiptMethod('ops.commercial.receipt.allocations.confirm',batch,deps)).rejects.toMatchObject({code:'COMMERCIAL_RECEIPT_CONFLICT'})
 })
 it('returns real tenant-scoped keyset cursors without repeated rows and rejects a cross-workspace cursor',async()=>{
  const rows=[3,2,1].map(n=>({...receipt,id:`r${n}`,receivedAt:`2026-10-0${n}T00:00:00.000Z`}))
  const list=vi.fn(async(_scope:string,limit:number,cursor?:{receivedAt:string;id:string})=>rows.filter(row=>!cursor||row.receivedAt<cursor.receivedAt||(row.receivedAt===cursor.receivedAt&&row.id<cursor.id)).slice(0,limit))
  const {deps}=setup({list})
  const first=await handleCommercialReceiptMethod('ops.commercial.receipt.list',{target_workspace_id:'ws-1',limit:2},deps) as {items:typeof rows;next_cursor:string}
  expect(first.items.map(row=>row.id)).toEqual(['r3','r2']);expect(first.next_cursor).toBeTruthy()
  const second=await handleCommercialReceiptMethod('ops.commercial.receipt.list',{target_workspace_id:'ws-1',limit:2,cursor:first.next_cursor},deps) as {items:typeof rows;next_cursor:string|null}
  expect(second.items.map(row=>row.id)).toEqual(['r1']);expect(second.next_cursor).toBeNull()
  expect(list).toHaveBeenLastCalledWith('ws-1',3,{receivedAt:rows[1]!.receivedAt,id:'r2'})
  await expect(handleCommercialReceiptMethod('ops.commercial.receipt.list',{target_workspace_id:'ws-2',cursor:first.next_cursor},deps)).rejects.toMatchObject({code:'INVALID_REQUEST'})
 })
 it('probes the next row for the maximum 100-row page instead of returning a false terminal page',async()=>{
  const rows=Array.from({length:101},(_,n)=>({...receipt,id:`r${n.toString().padStart(3,'0')}`,receivedAt:receipt.receivedAt}))
  const listUnmatched=vi.fn(async(limit:number,cursor?:{receivedAt:string;id:string})=>rows.filter(row=>!cursor||row.id>cursor.id).slice(0,limit))
  const {deps}=setup({listUnmatched})
  const page=await handleCommercialReceiptMethod('ops.commercial.receipt.unmatched.list',{limit:100},deps) as {items:typeof rows;next_cursor:string}
  expect(page.items).toHaveLength(100);expect(page.next_cursor).toBeTruthy();expect(listUnmatched).toHaveBeenLastCalledWith(1,{receivedAt:receipt.receivedAt,id:'r099'})
  const next=await handleCommercialReceiptMethod('ops.commercial.receipt.unmatched.list',{limit:100,cursor:page.next_cursor},deps) as {items:typeof rows;next_cursor:null}
  expect(next.items.map(row=>row.id)).toEqual(['r100']);expect(next.next_cursor).toBeNull()
 })
 it('paginates return facts by their own created-at cursor and prevents using a receipt cursor for returns',async()=>{
  const rows=[{id:'return2',createdAt:'2026-10-02T00:00:00.000Z'},{id:'return1',createdAt:'2026-10-01T00:00:00.000Z'}]
  const listReturns=vi.fn(async(_scope:string,limit:number,cursor?:{createdAt:string;id:string})=>rows.filter(row=>!cursor||row.createdAt<cursor.createdAt).slice(0,limit))
  const {deps}=setup({listReturns})
  const first=await handleCommercialReceiptMethod('ops.commercial.receipt.return.list',{target_workspace_id:'ws-1',limit:1},deps) as {items:typeof rows;next_cursor:string}
  expect(first.items[0]?.id).toBe('return2');expect(first.next_cursor).toBeTruthy()
  const second=await handleCommercialReceiptMethod('ops.commercial.receipt.return.list',{target_workspace_id:'ws-1',limit:1,cursor:first.next_cursor},deps) as {items:typeof rows;next_cursor:null}
  expect(second.items[0]?.id).toBe('return1');expect(second.next_cursor).toBeNull()
  await expect(handleCommercialReceiptMethod('ops.commercial.receipt.list',{target_workspace_id:'ws-1',cursor:first.next_cursor},deps)).rejects.toMatchObject({code:'INVALID_REQUEST'})
 })

})
