import { describe, expect, it, vi } from 'vitest'
import { reconcileImageGenerationWorkspace, summarizeImageGenerationReconciliation } from './main.js'
const input={apiBaseUrl:'https://fixture.test',apiToken:'fixture',workspaceId:'workspace'}
const candidate={job_id:'job',event_id:'event',intent_hash:'a'.repeat(64),execution_attempt:1,query_attempt:1,execution_state:'outcome_unknown',provider_request_id:'provider'}
describe('image reconciliation truthfulness without provider query capability',()=>{
  it('reports blocked provider attention while retaining a successful local ACK scan',async()=>{
    const calls:string[]=[]
    const sweep=await reconcileImageGenerationWorkspace({...input,fetcher:async url=>{calls.push(String(url));return Response.json({data:{attention:[candidate],acknowledged_event_ids:['local-event'],next_cursor:null,next_completion_ack_cursor:null}})}})
    expect(calls).toHaveLength(1)
    expect(sweep).toMatchObject({completed:true,scanCompleted:true,providerQueryConfigured:false,providerQueryState:'not_configured',providerCandidates:1,providerQueriesAttempted:0,providerQueriesBlocked:1,providerEvidenceSubmitted:0})
    expect(sweep.results[0]).toMatchObject({queried:0,statusResults:[],page:{acknowledged_event_ids:['local-event']}})
    expect(summarizeImageGenerationReconciliation([{status:'fulfilled',value:sweep}])).toMatchObject({completed:1,completedMeaning:'local_scan_only',scanCompleted:1,providerBlockedWorkspaces:1,providerUnconfigured:1,providerQueriesAttempted:0,providerQueriesBlocked:1})
  })
  it('reports absent configuration separately when there is no pending provider work',async()=>{
    const sweep=await reconcileImageGenerationWorkspace({...input,fetcher:async()=>Response.json({data:{attention:[],next_cursor:null}})})
    expect(sweep).toMatchObject({providerQueryConfigured:false,providerQueryState:'not_configured',providerCandidates:0,providerQueriesAttempted:0,providerQueriesBlocked:0})
    expect(summarizeImageGenerationReconciliation([{status:'fulfilled',value:sweep}])).toMatchObject({providerUnconfigured:1,providerBlockedWorkspaces:0})
  })
  it('counts real invocations once across duplicate pages and unknown query errors as attempted, never resolved',async()=>{
    let page=0;const evidence:unknown[]=[]
    const queryStatus=vi.fn(async()=>{throw Object.assign(new Error('unsupported'),{code:'STATUS_UNSUPPORTED'})})
    const sweep=await reconcileImageGenerationWorkspace({...input,queryStatus,fetcher:async(url,init)=>{
      if(String(url).endsWith('/reconciliation')) return Response.json({data:{attention:[candidate],next_cursor:++page===1?'page2':null}})
      evidence.push(JSON.parse(String(init?.body)));return Response.json({data:{evidence_id:'fixture',provider_state:'unknown',reconciliation_required:true}})
    }})
    expect(queryStatus).toHaveBeenCalledOnce();expect(evidence).toHaveLength(1)
    expect(evidence[0]).toMatchObject({provider_state:'unknown',provider_request_id:'provider'})
    expect(sweep).toMatchObject({scanCompleted:true,providerQueryConfigured:true,providerQueryState:'attempted',providerCandidates:1,providerQueriesAttempted:1,providerEvidenceSubmitted:1,providerQueriesBlocked:0})
    expect(sweep.results.map(result=>(result as {queried:number}).queried)).toEqual([1,0])
  })
  it('does not count a page-limited fulfilled scan as completed',async()=>{
    const sweep=await reconcileImageGenerationWorkspace({...input,maxPages:1,fetcher:async()=>Response.json({data:{attention:[candidate],next_cursor:'more'}})})
    expect(summarizeImageGenerationReconciliation([{status:'fulfilled',value:sweep},{status:'rejected',reason:new Error('transport')}])).toMatchObject({completed:0,scanCompleted:0,scanIncomplete:1,providerBlockedWorkspaces:1,failed:1})
  })
})
