import { describe, expect, it, vi } from 'vitest'
import { MemoryPublishMediaOrphanRepository } from '../../../packages/persistence/src/publish-media-orphan-repository.js'
import { handleHttpWorkerExecutionRoute } from './http-worker-execution-routes.js'

const job = { id:'job_a',workspaceId:'ws_a',taskId:'task_a',platform:'taobao',accountId:'acct_a',selectedVisuals:[{visualRef:'visual_a',role:'main',sha256:'a'.repeat(64)}] }
const event = { id:'event_a',workspaceId:'ws_a',aggregateId:'job_a',eventType:'publish.requested',sequence:1,payload:{},createdAt:new Date().toISOString() }
function fixture(options: { role?:string; body?:Record<string,unknown>; workspace?:string } = {}) {
  const repository=new MemoryPublishMediaOrphanRepository()
  const send=vi.fn((_res:unknown,_status:number,_workspace:string,data:unknown)=>{(fixture as any).lastData=data;return true})
  const dependencies:any={
    service:{assertPublishExecutionAllowed:({workspaceId,publishJobId}:any)=>{if(workspaceId!==job.workspaceId||publishJobId!==job.id)throw new Error('tenant/job scope mismatch');return job}},
    persistence:()=>({publishMediaOrphans:repository,outbox:{listAggregateEvents:async()=>[event]}}),
    requireWorkerCredentialAuthorization:vi.fn(async()=>undefined),resolveWorkspace:()=>options.workspace??'ws_a',workerRole:()=>options.role??'publish',
    recheckCustomerDeliveryScan:async()=>({}),workerEventOperations:{},requiresStrictAuth:()=>true,recheckWorkerGenerationKnowledge:async()=>({}),requiresWorkerActorAuthorization:()=>true,
    recheckWorkerCommercialAccess:async()=>({}),serializedWorkerCommercialRecheck:()=>({}),recheckWorkerAuthorizationSnapshot:async()=>({}),enrichRequestObservation:()=>{},
    assertCanonicalTaskScopeForAction:async()=>undefined,isProduction:()=>false,serializedWorkerAuthorizationSnapshot:()=>({}),publishMediaPayload:async()=>[],readBody:async()=>options.body??{},send,
  }
  return {repository,dependencies,send}
}
const req={method:'POST',headers:{}} as any
const res={} as any
const body={event_id:'event_a',media_idempotency_key:'job_a:media:visual_a',platform:'taobao',account_id:'acct_a',visual_ref:'visual_a',role:'main',sha256:'a'.repeat(64),state:'uploaded',receipt:{platform:'taobao',visualRef:'visual_a',role:'main',sha256:'a'.repeat(64),mediaId:'remote_media_a'}}

describe('worker publish media lifecycle callback',()=>{
  it('accepts only the signed publish role and persists a job-bound upload receipt',async()=>{
    const f=fixture({body})
    await expect(handleHttpWorkerExecutionRoute(req,res,'/v1/publish-jobs/job_a/media/lifecycle',new URL('http://local/v1/publish-jobs/job_a/media/lifecycle'),f.dependencies)).resolves.toBe(true)
    expect(f.dependencies.requireWorkerCredentialAuthorization).toHaveBeenCalledOnce()
    expect(await f.repository.getByKey('ws_a','job_a',body.media_idempotency_key)).toMatchObject({state:'uploaded',eventId:'event_a',receipt:{mediaId:'remote_media_a'}})
  })
  it('rejects unsigned-role, wrong tenant, stale selection, and a non publish event',async()=>{
    const wrongRole=fixture({body,role:'generation'})
    await expect(handleHttpWorkerExecutionRoute(req,res,'/v1/publish-jobs/job_a/media/lifecycle',new URL('http://local/v1/publish-jobs/job_a/media/lifecycle'),wrongRole.dependencies)).rejects.toMatchObject({status:403})
    const wrongTenant=fixture({body,workspace:'ws_b'})
    await expect(handleHttpWorkerExecutionRoute(req,res,'/v1/publish-jobs/job_a/media/lifecycle',new URL('http://local/v1/publish-jobs/job_a/media/lifecycle'),wrongTenant.dependencies)).rejects.toThrow('tenant/job scope mismatch')
    const wrongSelection=fixture({body:{...body,sha256:'b'.repeat(64)}})
    await expect(handleHttpWorkerExecutionRoute(req,res,'/v1/publish-jobs/job_a/media/lifecycle',new URL('http://local/v1/publish-jobs/job_a/media/lifecycle'),wrongSelection.dependencies)).rejects.toMatchObject({status:403})
    const badEvent=fixture({body})
    badEvent.dependencies.persistence=()=>({publishMediaOrphans:badEvent.repository,outbox:{listAggregateEvents:async()=>[{...event,eventType:'publish.reconcile'}]}})
    await expect(handleHttpWorkerExecutionRoute(req,res,'/v1/publish-jobs/job_a/media/lifecycle',new URL('http://local/v1/publish-jobs/job_a/media/lifecycle'),badEvent.dependencies)).rejects.toMatchObject({status:403})
  })
  it('rejects a blank upload URL before persisting a receipt',async()=>{
    const invalidBody={...body,receipt:{...body.receipt,url:'   '}}
    const f=fixture({body:invalidBody})
    await expect(handleHttpWorkerExecutionRoute(req,res,'/v1/publish-jobs/job_a/media/lifecycle',new URL('http://local/v1/publish-jobs/job_a/media/lifecycle'),f.dependencies)).rejects.toMatchObject({code:'PUBLISH_MEDIA_RECEIPT_INVALID',status:400})
    expect(await f.repository.getByKey('ws_a','job_a',body.media_idempotency_key)).toBeUndefined()
  })
  it('rejects deletion without an existing receipt and exact confirmed adapter evidence',async()=>{
    const noReceipt=fixture({body:{...body,state:'deleted',receipt:undefined,reason:'discard_adapter_confirmed_delete'}})
    await expect(handleHttpWorkerExecutionRoute(req,res,'/v1/publish-jobs/job_a/media/lifecycle',new URL('http://local/v1/publish-jobs/job_a/media/lifecycle'),noReceipt.dependencies)).rejects.toThrow('PUBLISH_MEDIA_LIFECYCLE_CONFLICT')
    const valid=fixture({body})
    await handleHttpWorkerExecutionRoute(req,res,'/v1/publish-jobs/job_a/media/lifecycle',new URL('http://local/v1/publish-jobs/job_a/media/lifecycle'),valid.dependencies)
    valid.dependencies.readBody=async()=>({...body,state:'deleted',receipt:{...body.receipt,mediaId:'different'},reason:'discard_adapter_confirmed_delete'})
    await expect(handleHttpWorkerExecutionRoute(req,res,'/v1/publish-jobs/job_a/media/lifecycle',new URL('http://local/v1/publish-jobs/job_a/media/lifecycle'),valid.dependencies)).rejects.toThrow('PUBLISH_MEDIA_LIFECYCLE_CONFLICT')
    expect(await valid.repository.getByKey('ws_a','job_a',body.media_idempotency_key)).toMatchObject({state:'uploaded',receipt:body.receipt})
    valid.dependencies.readBody=async()=>({...body,state:'deleted',reason:'discard_adapter_confirmed_delete'})
    await expect(handleHttpWorkerExecutionRoute(req,res,'/v1/publish-jobs/job_a/media/lifecycle',new URL('http://local/v1/publish-jobs/job_a/media/lifecycle'),valid.dependencies)).resolves.toBe(true)
    expect(await valid.repository.getByKey('ws_a','job_a',body.media_idempotency_key)).toMatchObject({state:'deleted',reason:'discard_adapter_confirmed_delete'})
  })
})
