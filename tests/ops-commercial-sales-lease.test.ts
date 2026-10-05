import {mkdtempSync,readFileSync,rmSync,writeFileSync,utimesSync} from 'node:fs'
import {hostname,tmpdir} from 'node:os'
import {join} from 'node:path'
import {randomUUID} from 'node:crypto'
import {describe,expect,it} from 'vitest'
import {COMMERCIAL_SALES_SPEC,isolatedCommercialSalesMode} from '../scripts/ops-commercial-sales-lease.js'
import {acquireCommercialE2eLock} from '../scripts/commercial-e2e-exclusive-lock.js'
describe('isolated commercial sales runner opt-in boundary',()=>{
 it('keeps ordinary support and catalog runs closed without the sales flag',()=>{expect(isolatedCommercialSalesMode(['dogfood/chatgpt-all-functions/ops-commercial-support-isolated.spec.js'],{})).toBe(false);expect(isolatedCommercialSalesMode(['dogfood/chatgpt-all-functions/ops-commercial-packages-isolated.spec.js'],{})).toBe(false)})
 it('allows exactly the declared two-UI commercial fixture',()=>{expect(isolatedCommercialSalesMode([COMMERCIAL_SALES_SPEC],{OPS_E2E_COMMERCIAL_SALES:'true',OPS_E2E_MERCHANT_UI:'true'})).toBe(true)})
 it.each([{args:[COMMERCIAL_SALES_SPEC],env:{}},{args:[COMMERCIAL_SALES_SPEC],env:{OPS_E2E_COMMERCIAL_SALES:'false'}},{args:[COMMERCIAL_SALES_SPEC],env:{OPS_E2E_COMMERCIAL_SALES:'true'}},{args:[COMMERCIAL_SALES_SPEC,'dogfood/chatgpt-all-functions/ops-commercial-support-isolated.spec.js'],env:{OPS_E2E_COMMERCIAL_SALES:'true',OPS_E2E_MERCHANT_UI:'true'}},{args:['dogfood/chatgpt-all-functions/ops-commercial-support-isolated.spec.js'],env:{OPS_E2E_COMMERCIAL_SALES:'true',OPS_E2E_MERCHANT_UI:'true'}},{args:[COMMERCIAL_SALES_SPEC],env:{OPS_E2E_COMMERCIAL_SALES:'true',OPS_E2E_MERCHANT_UI:'true',OPS_E2E_DELIVERY_SCAN:'true'}}])('rejects broader or ambiguous commercial evidence scope %#',({args,env})=>{expect(()=>isolatedCommercialSalesMode(args,env)).toThrow()})
})

describe('commercial E2E exclusive lock lifecycle',()=>{
 const withTemp=(work:(root:string)=>void)=>{const root=mkdtempSync(join(tmpdir(),'commercial-e2e-lock-'));try{work(root)}finally{rmSync(root,{recursive:true,force:true})}}
 it('serializes live owners and releases its own lock idempotently',()=>withTemp(root=>{
  const path=join(root,'nested','.lock'),release=acquireCommercialE2eLock(path)
  expect(()=>acquireCommercialE2eLock(path)).toThrow('OPS_E2E_COMMERCIAL_SALES_ALREADY_RUNNING')
  release();release();expect(()=>readFileSync(path)).toThrow()
 }))
 it('reclaims a dead local owner without disturbing the next owner',()=>withTemp(root=>{
  const path=join(root,'.lock');writeFileSync(path,JSON.stringify({pid:2147483647,host:hostname(),token:randomUUID(),startedAt:new Date().toISOString()}))
  const release=acquireCommercialE2eLock(path),owner=JSON.parse(readFileSync(path,'utf8'))
  expect(owner.pid).toBe(process.pid);release()
 }))
 it('does not reclaim a fresh malformed lock or a lock owned by another host',()=>withTemp(root=>{
  const path=join(root,'.lock');writeFileSync(path,'partial')
  expect(()=>acquireCommercialE2eLock(path)).toThrow('OPS_E2E_COMMERCIAL_SALES_ALREADY_RUNNING')
  writeFileSync(path,JSON.stringify({pid:2147483647,host:'different-host',token:randomUUID(),startedAt:new Date().toISOString()}))
  expect(()=>acquireCommercialE2eLock(path)).toThrow('OPS_E2E_COMMERCIAL_SALES_ALREADY_RUNNING')
 }))
 it('reclaims an old incomplete lock left between create and metadata write',()=>withTemp(root=>{
  const path=join(root,'.lock');writeFileSync(path,'partial');const old=new Date(Date.now()-11*60_000);utimesSync(path,old,old)
  const release=acquireCommercialE2eLock(path);expect(JSON.parse(readFileSync(path,'utf8')).pid).toBe(process.pid);release()
 }))
 it('does not delete a replacement lock during cleanup',()=>withTemp(root=>{
  const path=join(root,'.lock'),release=acquireCommercialE2eLock(path);writeFileSync(path,JSON.stringify({pid:process.pid,host:hostname(),token:randomUUID(),startedAt:new Date().toISOString()}))
  const replacement=readFileSync(path,'utf8');release();expect(readFileSync(path,'utf8')).toBe(replacement)
 }))
 it('fails before acquiring a lock when its parent path is not a directory',()=>withTemp(root=>{
  const parent=join(root,'file');writeFileSync(parent,'x')
  expect(()=>acquireCommercialE2eLock(join(parent,'.lock'))).toThrow()
 }))
})
