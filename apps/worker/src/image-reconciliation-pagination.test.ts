import { describe, expect, it, vi } from 'vitest'
import { postImageGenerationReconciliation, reconcileImageGenerationWorkspace } from './main.js'
const input = {apiBaseUrl:'https://fixture.test',apiToken:'fixture',workspaceId:'workspace'}
describe('image reconciliation response and pagination', () => {
  it.each([{data:null,error:{code:'BROKEN'}},{data:null},{data:[]},{request_id:'missing-data'},{}])('rejects invalid/error envelope without claiming a completed sweep: %j', async payload => {
    await expect(reconcileImageGenerationWorkspace({...input,fetcher:async()=>Response.json(payload)})).rejects.toThrow('image reconciliation response')
  })
  it.each([{attention:[],next_cursor:null},{data:{attention:[],next_cursor:null},error:null}])('accepts legacy flat and actual API envelopes: %j', async payload => {
    expect(await postImageGenerationReconciliation({...input,fetcher:async()=>Response.json(payload)})).toEqual({attention:[],next_cursor:null})
  })
  it('bounds repeated cursors and resumes only the incomplete branch, then resets on a new sweep', async () => {
    const requests: Record<string,unknown>[] = []
    const fetcher: typeof fetch = async (_url,init) => {
      requests.push(JSON.parse(String(init?.body)))
      return Response.json({data:{attention:[],next_cursor:null,next_completion_ack_cursor:requests.length===1?'cursor-one':null}})
    }
    const queryStatus = vi.fn()
    const first = await reconcileImageGenerationWorkspace({...input,maxPages:1,fetcher,queryStatus})
    expect(first.completed).toBe(false)
    const second = await reconcileImageGenerationWorkspace({...input,...first.continuation,fetcher,queryStatus})
    expect(second.completed).toBe(true)
    expect(requests[1]).toMatchObject({execution_scan_done:true,completion_ack_cursor:'cursor-one'})
    await reconcileImageGenerationWorkspace({...input,fetcher,queryStatus})
    expect(requests[2]).not.toHaveProperty('completion_ack_cursor')
    expect(requests[2]).not.toHaveProperty('execution_scan_done')
    expect(queryStatus).not.toHaveBeenCalled()
    const looping = await reconcileImageGenerationWorkspace({...input,maxPages:2,fetcher:async()=>Response.json({data:{next_cursor:null,next_completion_ack_cursor:'same'}})})
    expect(looping).toMatchObject({pages:2,completed:false})
  })
})
