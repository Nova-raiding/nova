import { describe, expect, it, vi } from 'vitest'
import { MemoryPublishMediaOrphanRepository } from '../../../packages/persistence/src/publish-media-orphan-repository.js'
import { createWorkerRequestProof } from '../../../packages/security/src/worker-request-proof.js'
import { handleHttpWorkerExecutionRoute } from './http-worker-execution-routes.js'

const job = { id:'job_a',workspaceId:'ws_a',taskId:'task_a',platform:'taobao',accountId:'acct_a',payloadHash:'d'.repeat(64),selectedVisuals:[{visualRef:'visual_a',role:'main',sha256:'a'.repeat(64)}] }
const event = { id:'event_a',workspaceId:'ws_a',aggregateId:'job_a',eventType:'publish.requested',sequence:1,payload:{payload_hash:'d'.repeat(64),platform:'taobao',account_id:'acct_a'},createdAt:new Date().toISOString() }
const reconcileEvent = { id:'event_reconcile_a',workspaceId:'ws_a',aggregateId:'job_a',eventType:'publish.reconcile_requested',sequence:2,payload:{payload_hash:'d'.repeat(64),platform:'taobao',account_id:'acct_a'},createdAt:new Date().toISOString() }
function fixture(options: { role?:string; body?:Record<string,unknown>; workspace?:string } = {}) {
  const repository=new MemoryPublishMediaOrphanRepository()
  const send=vi.fn((_res:unknown,_status:number,_workspace:string,data:unknown)=>{(fixture as any).lastData=data;return true})
  const dependencies:any={
    service:{assertPublishExecutionAllowed:({workspaceId,publishJobId}:any)=>{if(workspaceId!==job.workspaceId||publishJobId!==job.id)throw new Error('tenant/job scope mismatch');return job},getTask:()=>({id:'task_a'})},
    persistence:()=>({publishMediaOrphans:repository,outbox:{listAggregateEvents:async()=>[event,reconcileEvent]}}),
    requireWorkerCredentialAuthorization:vi.fn(async()=>undefined),resolveWorkspace:()=>options.workspace??'ws_a',workerRole:()=>options.role??'publish',
    recheckCustomerDeliveryScan:async()=>({}),workerEventOperations:{},requiresStrictAuth:()=>false,recheckWorkerGenerationKnowledge:async()=>({}),requiresWorkerActorAuthorization:()=>true,
    recheckWorkerCommercialAccess:vi.fn(async()=>({allowed:true,ready:true})),serializedWorkerCommercialRecheck:()=>({}),recheckWorkerAuthorizationSnapshot:vi.fn(async()=>({authorized:true})),enrichRequestObservation:()=>{},
    assertCanonicalTaskScopeForAction:async()=>undefined,isProduction:()=>false,serializedWorkerAuthorizationSnapshot:(snapshot:any)=>snapshot,publishMediaPayload:vi.fn(async()=>[]),readBody:async()=>options.body??{},send,
  }
  return {repository,dependencies,send}
}
const req={method:'POST',headers:{}} as any
const res={} as any
const body={event_id:'event_a',media_idempotency_key:'job_a:media:visual_a',platform:'taobao',account_id:'acct_a',visual_ref:'visual_a',role:'main',sha256:'a'.repeat(64),state:'uploaded',receipt:{platform:'taobao',visualRef:'visual_a',role:'main',sha256:'a'.repeat(64),mediaId:'remote_media_a',simulated:false}}
const lifecycleIdentity={workspaceId:'ws_a',publishJobId:'job_a',eventId:event.id,mediaIdempotencyKey:body.media_idempotency_key,platform:'taobao',accountId:'acct_a',visualRef:'visual_a',role:'main' as const,sha256:'a'.repeat(64)}

async function seedLifecycleRecord(repository: MemoryPublishMediaOrphanRepository, state: 'unknown', reason?: string) {
  await repository.transition({...lifecycleIdentity,state:'intent'})
  return repository.transition({...lifecycleIdentity,state,receipt:body.receipt,...(reason?{reason}:{})})
}

function withExecutionSnapshots(source: typeof event | typeof reconcileEvent, operation: 'publish.execute'|'publish.reconcile') {
  const authorization_snapshot={schema_version:1,decision_id:`decision_${source.id}`,actor_id:'actor_a',identity_id:'identity_a',workspace_id:source.workspaceId,workbench:'workspace',context_id:`workspace:${source.workspaceId}`,context_version:'ctx1',policy_version:'policy1',grant_revision:'grant:grant_a:1:identity_a:0',grant_ids:['grant_a'],scope_hash:'b'.repeat(64),capability:operation,resource_id:source.aggregateId,resource_revision:'1',request_id:`request_${source.id}`,trace_id:`trace_${source.id}`,authorized:true,decided_at:new Date().toISOString()}
  const commercial_access_snapshot={schema_version:1,decision_id:`commercial_${source.id}`,workspace_id:source.workspaceId,operation,access_mode:'POINT_REQUIRED_NO_CHARGE',access_revision:'access1',balance_state:'known',entitlement_snapshot_id:'entitlement1',entitlement_snapshot_checksum:'c'.repeat(64),rate_version:null,quoted_points:0,decided_at:new Date().toISOString()}
  return {...source,payload:{...source.payload,authorization_snapshot,commercial_access_snapshot}}
}

describe('worker publish media read event binding',()=>{
  it('returns media only for the exact publish or reconcile event bound to the frozen job',async()=>{
    const publish=fixture()
    publish.dependencies.workerRole=()=>undefined
    await handleHttpWorkerExecutionRoute({...req,method:'GET'} as any,res,'/v1/publish-jobs/job_a/media',new URL(`http://local/v1/publish-jobs/job_a/media?event_id=${event.id}`),publish.dependencies)
    expect(publish.send).toHaveBeenCalledWith(res,200,'ws_a',{job_id:'job_a',media:[]},null,expect.anything())

    const reconcile=fixture()
    reconcile.dependencies.workerRole=()=>undefined
    await handleHttpWorkerExecutionRoute({...req,method:'GET'} as any,res,'/v1/publish-jobs/job_a/media',new URL(`http://local/v1/publish-jobs/job_a/media?worker_role=reconcile&event_id=${reconcileEvent.id}`),reconcile.dependencies)
    expect(reconcile.send).toHaveBeenCalledWith(res,200,'ws_a',{job_id:'job_a',media:[]},null,expect.anything())
  })

  it('strict mode requires both snapshots and rechecks them before loading media',async()=>{
    const missing=fixture()
    missing.dependencies.requiresStrictAuth=()=>true
    await expect(handleHttpWorkerExecutionRoute({...req,method:'GET'} as any,res,'/v1/publish-jobs/job_a/media',new URL(`http://local/v1/publish-jobs/job_a/media?event_id=${event.id}`),missing.dependencies)).rejects.toMatchObject({code:'AUTHZ_EXECUTION_SNAPSHOT_INVALID',status:403})
    expect(missing.dependencies.publishMediaPayload).not.toHaveBeenCalled()

    const partial=fixture()
    partial.dependencies.requiresStrictAuth=()=>true
    const authorizationOnly=withExecutionSnapshots(event,'publish.execute')
    delete (authorizationOnly.payload as Record<string,unknown>).commercial_access_snapshot
    partial.dependencies.persistence=()=>({publishMediaOrphans:partial.repository,outbox:{listAggregateEvents:async()=>[authorizationOnly]}})
    await expect(handleHttpWorkerExecutionRoute({...req,method:'GET'} as any,res,'/v1/publish-jobs/job_a/media',new URL(`http://local/v1/publish-jobs/job_a/media?event_id=${event.id}`),partial.dependencies)).rejects.toMatchObject({code:'COMMERCIAL_EXECUTION_SNAPSHOT_INVALID',status:403})
    expect(partial.dependencies.publishMediaPayload).not.toHaveBeenCalled()

    const strict=fixture()
    strict.dependencies.requiresStrictAuth=()=>true
    const durable=withExecutionSnapshots(event,'publish.execute')
    strict.dependencies.persistence=()=>({publishMediaOrphans:strict.repository,outbox:{listAggregateEvents:async()=>[durable]}})
    strict.dependencies.recheckWorkerAuthorizationSnapshot=vi.fn(async()=>({authorized:true}))
    strict.dependencies.recheckWorkerCommercialAccess=vi.fn(async()=>({allowed:true,ready:true}))
    await handleHttpWorkerExecutionRoute({...req,method:'GET'} as any,res,'/v1/publish-jobs/job_a/media',new URL(`http://local/v1/publish-jobs/job_a/media?event_id=${event.id}`),strict.dependencies)
    expect(strict.dependencies.recheckWorkerAuthorizationSnapshot).toHaveBeenCalledWith(expect.objectContaining({decisionId:`decision_${event.id}`}),'ws_a','job_a',{eventId:event.id})
    expect(strict.dependencies.recheckWorkerCommercialAccess).toHaveBeenCalledOnce()
    expect(strict.dependencies.publishMediaPayload).toHaveBeenCalledOnce()
  })

  it('blocks media reads when authorization is revoked or commercial access is denied',async()=>{
    const durable=withExecutionSnapshots(event,'publish.execute')
    const revoked=fixture()
    revoked.dependencies.requiresStrictAuth=()=>true
    revoked.dependencies.persistence=()=>({publishMediaOrphans:revoked.repository,outbox:{listAggregateEvents:async()=>[durable]}})
    revoked.dependencies.recheckWorkerAuthorizationSnapshot=vi.fn(async()=>{throw Object.assign(new Error('revoked'),{code:'AUTHZ_EXECUTION_REVOKED',status:403})})
    await expect(handleHttpWorkerExecutionRoute({...req,method:'GET'} as any,res,'/v1/publish-jobs/job_a/media',new URL(`http://local/v1/publish-jobs/job_a/media?event_id=${event.id}`),revoked.dependencies)).rejects.toMatchObject({code:'AUTHZ_EXECUTION_REVOKED',status:403})
    expect(revoked.dependencies.publishMediaPayload).not.toHaveBeenCalled()
    expect(revoked.dependencies.recheckWorkerCommercialAccess).not.toHaveBeenCalled()

    const denied=fixture()
    denied.dependencies.requiresStrictAuth=()=>true
    denied.dependencies.persistence=()=>({publishMediaOrphans:denied.repository,outbox:{listAggregateEvents:async()=>[durable]}})
    denied.dependencies.recheckWorkerAuthorizationSnapshot=vi.fn(async()=>({authorized:true}))
    denied.dependencies.recheckWorkerCommercialAccess=vi.fn(async()=>({allowed:false,ready:false,denialCode:'COMMERCIAL_EXECUTION_BALANCE_BLOCKED'}))
    await expect(handleHttpWorkerExecutionRoute({...req,method:'GET'} as any,res,'/v1/publish-jobs/job_a/media',new URL(`http://local/v1/publish-jobs/job_a/media?event_id=${event.id}`),denied.dependencies)).rejects.toMatchObject({code:'COMMERCIAL_EXECUTION_BALANCE_BLOCKED',status:403})
    expect(denied.dependencies.publishMediaPayload).not.toHaveBeenCalled()
  })

  it('rejects a malformed event payload as a scoped client error',async()=>{
    const f=fixture()
    const malformed={...event,payload:null} as unknown as typeof event
    f.dependencies.persistence=()=>({publishMediaOrphans:f.repository,outbox:{listAggregateEvents:async()=>[malformed]}})
    await expect(handleHttpWorkerExecutionRoute({...req,method:'GET'} as any,res,'/v1/publish-jobs/job_a/media',new URL(`http://local/v1/publish-jobs/job_a/media?event_id=${event.id}`),f.dependencies)).rejects.toMatchObject({code:'PUBLISH_MEDIA_EVENT_SCOPE_INVALID',status:403})
    expect(f.dependencies.publishMediaPayload).not.toHaveBeenCalled()
  })

  it('rejects missing, wrong-role, or cross-scope media events before loading media',async()=>{
    const missing=fixture()
    await expect(handleHttpWorkerExecutionRoute({...req,method:'GET'} as any,res,'/v1/publish-jobs/job_a/media',new URL('http://local/v1/publish-jobs/job_a/media'),missing.dependencies)).rejects.toMatchObject({code:'PUBLISH_MEDIA_EVENT_REQUIRED',status:400})
    expect(missing.dependencies.publishMediaPayload).not.toHaveBeenCalled()

    const wrongRole=fixture()
    await expect(handleHttpWorkerExecutionRoute({...req,method:'GET'} as any,res,'/v1/publish-jobs/job_a/media',new URL(`http://local/v1/publish-jobs/job_a/media?event_id=${reconcileEvent.id}`),wrongRole.dependencies)).rejects.toMatchObject({code:'PUBLISH_MEDIA_EVENT_INVALID',status:403})

    for (const [label, override] of [
      ['workspace', { workspaceId:'ws_other' }],
      ['job', { aggregateId:'job_other' }],
      ['payload hash', { payload:{...event.payload,payload_hash:'e'.repeat(64)} }],
      ['platform', { payload:{...event.payload,platform:'jd'} }],
      ['account', { payload:{...event.payload,account_id:'acct_other'} }],
    ] as const) {
      const f=fixture()
      const mismatched={...event,...override}
      f.dependencies.persistence=()=>({publishMediaOrphans:f.repository,outbox:{listAggregateEvents:async()=>[mismatched]}})
      await expect(handleHttpWorkerExecutionRoute({...req,method:'GET'} as any,res,'/v1/publish-jobs/job_a/media',new URL(`http://local/v1/publish-jobs/job_a/media?event_id=${event.id}`),f.dependencies)).rejects.toMatchObject({code:label==='workspace'||label==='job'?'PUBLISH_MEDIA_EVENT_INVALID':'PUBLISH_MEDIA_EVENT_SCOPE_INVALID',status:403})
      expect(f.dependencies.publishMediaPayload).not.toHaveBeenCalled()
    }
  })
})

describe('worker publish media lifecycle callback',()=>{
  it('rejects mismatched reconcile credentials over loopback HTTP before lifecycle persistence',async()=>{
    vi.stubEnv('NODE_ENV','test')
    vi.stubEnv('AUTH_ENFORCEMENT','strict')
    vi.stubEnv('WORKER_API_CREDENTIALS',JSON.stringify({
      publish:{token:'lifecycle-publish-token',signing_secret:'lifecycle-publish-secret'},
      reconcile:{token:'lifecycle-reconcile-token',signing_secret:'lifecycle-reconcile-secret'},
    }))
    let apiServer: typeof import('./server.js')['server'] | undefined
    let persistence: Awaited<typeof import('./server.js').persistenceReady> | undefined
    let originalRepository: Awaited<typeof import('./server.js').persistenceReady>['publishMediaOrphans'] | undefined
    try {
      const loadedApi=await import('./server.js')
      apiServer=loadedApi.server
      persistence=await loadedApi.persistenceReady
      originalRepository=persistence.publishMediaOrphans
      expect(persistence.mode).toBe('memory')
      const repository=new MemoryPublishMediaOrphanRepository()
      const transition=vi.spyOn(repository,'transition')
      persistence.publishMediaOrphans=repository
      const workspaceId='ws_lifecycle_http_auth'
      const path='/v1/publish-jobs/job_lifecycle_http_auth/media/lifecycle'
      const payload=JSON.stringify({...body,event_id:'event_reconcile_a',state:'retained'})
      const proof=createWorkerRequestProof({secret:'lifecycle-reconcile-secret',role:'reconcile',workerId:'lifecycle-http-test',method:'POST',requestTarget:path,workspaceId,body:payload})
      await new Promise<void>((resolve,reject)=>{
        loadedApi.server.once('error',reject)
        loadedApi.server.listen(0,'127.0.0.1',()=>{loadedApi.server.removeListener('error',reject);resolve()})
      })
      const address=loadedApi.server.address()
      if(!address||typeof address==='string') throw new Error('loopback API failed to bind')
      const response=await fetch(`http://127.0.0.1:${address.port}${path}`,{method:'POST',headers:{
        authorization:'Bearer lifecycle-publish-token','content-type':'application/json','x-workspace-id':workspaceId,...proof.headers,
      },body:payload})
      expect(response.status).toBe(403)
      expect(await response.json()).toMatchObject({error:{code:'FORBIDDEN'},data:null})
      expect(transition).not.toHaveBeenCalled()
    } finally {
      try {
        const server=apiServer
        if(server?.listening) await new Promise<void>(resolve=>{
          server.close(()=>resolve())
          server.closeAllConnections()
        })
      } finally {
        if(persistence && originalRepository) persistence.publishMediaOrphans=originalRepository
        vi.unstubAllEnvs()
      }
    }
  },30_000)

  it('accepts only the signed publish role and persists a job-bound upload receipt',async()=>{
    const f=fixture({body})
    f.dependencies.readBody=async()=>({...body,state:'intent',receipt:undefined})
    await handleHttpWorkerExecutionRoute(req,res,'/v1/publish-jobs/job_a/media/lifecycle',new URL('http://local/v1/publish-jobs/job_a/media/lifecycle'),f.dependencies)
    f.dependencies.readBody=async()=>body
    await expect(handleHttpWorkerExecutionRoute(req,res,'/v1/publish-jobs/job_a/media/lifecycle',new URL('http://local/v1/publish-jobs/job_a/media/lifecycle'),f.dependencies)).resolves.toBe(true)
    expect(f.dependencies.requireWorkerCredentialAuthorization).toHaveBeenCalledTimes(2)
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
  it('rejects simulated upload receipts in production',async()=>{
    vi.stubEnv('NODE_ENV','production')
    try {
      const f=fixture({body:{...body,receipt:{...body.receipt,simulated:true}}})
      await expect(handleHttpWorkerExecutionRoute(req,res,'/v1/publish-jobs/job_a/media/lifecycle',new URL('http://local/v1/publish-jobs/job_a/media/lifecycle'),f.dependencies)).rejects.toMatchObject({code:'PUBLISH_MEDIA_RECEIPT_INVALID',status:400})
      expect(await f.repository.getByKey('ws_a','job_a',body.media_idempotency_key)).toBeUndefined()
    } finally { vi.unstubAllEnvs() }
  })
  it('rejects deletion claims even when the worker supplies an upload receipt and adapter reason',async()=>{
    const noReceipt=fixture({body})
    noReceipt.dependencies.readBody=async()=>({...body,state:'intent',receipt:undefined})
    await handleHttpWorkerExecutionRoute(req,res,'/v1/publish-jobs/job_a/media/lifecycle',new URL('http://local/v1/publish-jobs/job_a/media/lifecycle'),noReceipt.dependencies)
    noReceipt.dependencies.readBody=async()=>({...body,state:'deleted',receipt:undefined,reason:'discard_adapter_confirmed_delete'})
    await expect(handleHttpWorkerExecutionRoute(req,res,'/v1/publish-jobs/job_a/media/lifecycle',new URL('http://local/v1/publish-jobs/job_a/media/lifecycle'),noReceipt.dependencies)).rejects.toMatchObject({code:'PUBLISH_MEDIA_LIFECYCLE_CONFLICT',status:409})
    const valid=fixture({body})
    valid.dependencies.readBody=async()=>({...body,state:'intent',receipt:undefined})
    await handleHttpWorkerExecutionRoute(req,res,'/v1/publish-jobs/job_a/media/lifecycle',new URL('http://local/v1/publish-jobs/job_a/media/lifecycle'),valid.dependencies)
    valid.dependencies.readBody=async()=>body
    await handleHttpWorkerExecutionRoute(req,res,'/v1/publish-jobs/job_a/media/lifecycle',new URL('http://local/v1/publish-jobs/job_a/media/lifecycle'),valid.dependencies)
    valid.dependencies.readBody=async()=>({...body,state:'deleted',receipt:{...body.receipt,mediaId:'different'},reason:'discard_adapter_confirmed_delete'})
    await expect(handleHttpWorkerExecutionRoute(req,res,'/v1/publish-jobs/job_a/media/lifecycle',new URL('http://local/v1/publish-jobs/job_a/media/lifecycle'),valid.dependencies)).rejects.toMatchObject({code:'PUBLISH_MEDIA_LIFECYCLE_CONFLICT',status:409})
    expect(await valid.repository.getByKey('ws_a','job_a',body.media_idempotency_key)).toMatchObject({state:'uploaded',receipt:body.receipt})
    valid.dependencies.readBody=async()=>({...body,state:'deleted',reason:'discard_adapter_confirmed_delete'})
    await expect(handleHttpWorkerExecutionRoute(req,res,'/v1/publish-jobs/job_a/media/lifecycle',new URL('http://local/v1/publish-jobs/job_a/media/lifecycle'),valid.dependencies)).rejects.toMatchObject({code:'PUBLISH_MEDIA_LIFECYCLE_CONFLICT',status:409})
    expect(await valid.repository.getByKey('ws_a','job_a',body.media_idempotency_key)).toMatchObject({state:'uploaded',receipt:body.receipt})
  })
  it('classifies an out-of-order lifecycle transition as a recoverable 409 and preserves the current receipt',async()=>{
    const f=fixture({body})
    f.dependencies.readBody=async()=>({...body,state:'intent',receipt:undefined})
    await handleHttpWorkerExecutionRoute(req,res,'/v1/publish-jobs/job_a/media/lifecycle',new URL('http://local/v1/publish-jobs/job_a/media/lifecycle'),f.dependencies)
    f.dependencies.readBody=async()=>body
    await handleHttpWorkerExecutionRoute(req,res,'/v1/publish-jobs/job_a/media/lifecycle',new URL('http://local/v1/publish-jobs/job_a/media/lifecycle'),f.dependencies)
    f.dependencies.readBody=async()=>({...body,state:'intent',receipt:undefined})
    await expect(handleHttpWorkerExecutionRoute(req,res,'/v1/publish-jobs/job_a/media/lifecycle',new URL('http://local/v1/publish-jobs/job_a/media/lifecycle'),f.dependencies)).rejects.toMatchObject({code:'PUBLISH_MEDIA_LIFECYCLE_CONFLICT',status:409})
    expect(await f.repository.getByKey('ws_a','job_a',body.media_idempotency_key)).toMatchObject({state:'uploaded',receipt:body.receipt})
  })
  it('settles an unknown receipt only through the bound reconcile event and preserves its original publish event',async()=>{
    const f=fixture({role:'reconcile'})
    await seedLifecycleRecord(f.repository,'unknown','publish_outcome_unknown')
    const getUrl=new URL(`http://local/v1/publish-jobs/job_a/media/lifecycle?worker_role=reconcile&event_id=${reconcileEvent.id}&media_idempotency_key=${body.media_idempotency_key}`)
    await handleHttpWorkerExecutionRoute({...req,method:'GET'} as any,res,getUrl.pathname,getUrl,f.dependencies)
    expect((fixture as any).lastData.media_lifecycle).toMatchObject({state:'unknown',eventId:event.id})
    f.dependencies.readBody=async()=>({...body,event_id:reconcileEvent.id,state:'retained',original_event_id:'forged-event'})
    await handleHttpWorkerExecutionRoute(req,res,'/v1/publish-jobs/job_a/media/lifecycle',new URL('http://local/v1/publish-jobs/job_a/media/lifecycle?worker_role=reconcile'),f.dependencies)
    expect(await f.repository.getByKey('ws_a','job_a',body.media_idempotency_key)).toMatchObject({state:'retained',eventId:event.id,receipt:body.receipt})
  })
  it('rejects a reconcile role without its durable reconcile event or with a delete target',async()=>{
    const f=fixture({role:'reconcile',body:{...body,event_id:event.id,state:'retained'}})
    await expect(handleHttpWorkerExecutionRoute(req,res,'/v1/publish-jobs/job_a/media/lifecycle',new URL('http://local/v1/publish-jobs/job_a/media/lifecycle?worker_role=reconcile'),f.dependencies)).rejects.toMatchObject({status:403})
    await seedLifecycleRecord(f.repository,'unknown')
    f.dependencies.readBody=async()=>({...body,event_id:reconcileEvent.id,state:'deleted'})
    await expect(handleHttpWorkerExecutionRoute(req,res,'/v1/publish-jobs/job_a/media/lifecycle',new URL('http://local/v1/publish-jobs/job_a/media/lifecycle?worker_role=reconcile'),f.dependencies)).rejects.toMatchObject({status:403})
    expect(await f.repository.getByKey('ws_a','job_a',body.media_idempotency_key)).toMatchObject({state:'unknown',eventId:event.id})
  })
  it('releases reconcile credentials only for the same workspace job reconcile event and signed role',async()=>{
    const f=fixture({role:'reconcile'})
    const snapshot={schema_version:1,decision_id:'decision_reconcile',actor_id:'actor_a',identity_id:'identity_a',workspace_id:'ws_a',workbench:'workspace',context_id:'workspace:ws_a',context_version:'ctx1',policy_version:'policy1',grant_revision:'grant1',grant_ids:[],scope_hash:'b'.repeat(64),capability:'publish.reconcile',resource_id:'job_a',resource_revision:'1',request_id:'request_a',trace_id:'trace_a',authorized:true,decided_at:new Date().toISOString()}
    const commercial={schema_version:1,decision_id:'commercial_reconcile',workspace_id:'ws_a',operation:'publish.reconcile',access_mode:'POINT_REQUIRED_NO_CHARGE',access_revision:'access1',balance_state:'known',entitlement_snapshot_id:'entitlement1',entitlement_snapshot_checksum:'c'.repeat(64),rate_version:null,quoted_points:0,decided_at:new Date().toISOString()}
    const reconcile={...reconcileEvent,payload:{payload_hash:'d'.repeat(64),platform:'taobao',account_id:'acct_a',authorization_snapshot:snapshot,commercial_access_snapshot:commercial}}
    const publish={...event,payload:{payload_hash:'d'.repeat(64),platform:'taobao',account_id:'acct_a',authorization_snapshot:{...snapshot,capability:'publish.execute'},commercial_access_snapshot:{...commercial,operation:'publish.execute'}}}
    f.dependencies.service.assertPublishExecutionAllowed=()=>({...job,payloadHash:'d'.repeat(64),authorizationSnapshot:{...snapshot,capability:'publish.execute'}})
    f.dependencies.service.getTask=()=>({id:'task_a'})
    f.dependencies.service.getActivePlatformAccount=()=>({credentialRef:'vault://credential'})
    f.dependencies.persistence=()=>({publishMediaOrphans:f.repository,outbox:{listAggregateEvents:async()=>[publish,reconcile]}})
    const reconcileUrl=new URL(`http://local/v1/publish-jobs/job_a/execution-check?event_id=${reconcile.id}&worker_role=reconcile`)
    await handleHttpWorkerExecutionRoute({...req,method:'GET'} as any,res,reconcileUrl.pathname,reconcileUrl,f.dependencies)
    expect((fixture as any).lastData).toMatchObject({allowed:true,job_id:'job_a',authorization_snapshot:{capability:'publish.reconcile'}})
    const publishRole=fixture({role:'publish'})
    publishRole.dependencies.persistence=f.dependencies.persistence
    publishRole.dependencies.service=f.dependencies.service
    await expect(handleHttpWorkerExecutionRoute({...req,method:'GET'} as any,res,reconcileUrl.pathname,reconcileUrl,publishRole.dependencies)).rejects.toMatchObject({status:404})
    const wrongKindUrl=new URL(`http://local/v1/publish-jobs/job_a/execution-check?event_id=${publish.id}&worker_role=reconcile`)
    await expect(handleHttpWorkerExecutionRoute({...req,method:'GET'} as any,res,wrongKindUrl.pathname,wrongKindUrl,f.dependencies)).rejects.toMatchObject({status:404})
  })
  it('rejects media lifecycle events whose frozen hash, platform, or account differs from the job',async()=>{
    const badHash=fixture({body})
    badHash.dependencies.persistence=()=>({publishMediaOrphans:badHash.repository,outbox:{listAggregateEvents:async()=>[{...event,payload:{...event.payload,payload_hash:'e'.repeat(64)}}]}})
    await expect(handleHttpWorkerExecutionRoute(req,res,'/v1/publish-jobs/job_a/media/lifecycle',new URL('http://local/v1/publish-jobs/job_a/media/lifecycle'),badHash.dependencies)).rejects.toMatchObject({code:'PUBLISH_MEDIA_EVENT_SCOPE_INVALID',status:403})
    const badPlatform=fixture({role:'reconcile'})
    badPlatform.dependencies.persistence=()=>({publishMediaOrphans:badPlatform.repository,outbox:{listAggregateEvents:async()=>[{...reconcileEvent,payload:{...reconcileEvent.payload,platform:'jd'}}]}})
    const getUrl=new URL(`http://local/v1/publish-jobs/job_a/media/lifecycle?worker_role=reconcile&event_id=${reconcileEvent.id}&media_idempotency_key=${body.media_idempotency_key}`)
    await expect(handleHttpWorkerExecutionRoute({...req,method:'GET'} as any,res,getUrl.pathname,getUrl,badPlatform.dependencies)).rejects.toMatchObject({code:'PUBLISH_MEDIA_EVENT_SCOPE_INVALID',status:403})
    const badAccount=fixture({role:'reconcile',body:{...body,event_id:reconcileEvent.id,state:'orphaned'}})
    badAccount.dependencies.persistence=()=>({publishMediaOrphans:badAccount.repository,outbox:{listAggregateEvents:async()=>[{...reconcileEvent,payload:{...reconcileEvent.payload,account_id:'acct_other'}}]}})
    await expect(handleHttpWorkerExecutionRoute(req,res,'/v1/publish-jobs/job_a/media/lifecycle',new URL('http://local/v1/publish-jobs/job_a/media/lifecycle?worker_role=reconcile'),badAccount.dependencies)).rejects.toMatchObject({code:'PUBLISH_MEDIA_EVENT_SCOPE_INVALID',status:403})
  })
  it('rejects historical lifecycle rows whose original publish event snapshot no longer matches the frozen job',async()=>{
    const f=fixture({role:'reconcile',body:{...body,event_id:reconcileEvent.id,state:'retained'}})
    await seedLifecycleRecord(f.repository,'unknown')
    const badOriginal={...event,payload:{...event.payload,payload_hash:'e'.repeat(64)}}
    f.dependencies.persistence=()=>({publishMediaOrphans:f.repository,outbox:{listAggregateEvents:async()=>[badOriginal,reconcileEvent]}})
    const getUrl=new URL(`http://local/v1/publish-jobs/job_a/media/lifecycle?worker_role=reconcile&event_id=${reconcileEvent.id}&media_idempotency_key=${body.media_idempotency_key}`)
    await expect(handleHttpWorkerExecutionRoute({...req,method:'GET'} as any,res,getUrl.pathname,getUrl,f.dependencies)).rejects.toMatchObject({code:'PUBLISH_MEDIA_RECEIPT_SCOPE_INVALID',status:409})
    await expect(handleHttpWorkerExecutionRoute(req,res,'/v1/publish-jobs/job_a/media/lifecycle',new URL('http://local/v1/publish-jobs/job_a/media/lifecycle?worker_role=reconcile'),f.dependencies)).rejects.toMatchObject({code:'PUBLISH_MEDIA_RECEIPT_SCOPE_INVALID',status:409})
    expect(await f.repository.getByKey('ws_a','job_a',body.media_idempotency_key)).toMatchObject({state:'unknown',eventId:event.id})
  })
})
