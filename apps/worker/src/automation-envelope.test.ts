import { describe, expect, it, vi } from 'vitest'
import { handleInternalRuntimeRoute } from '../../api/src/http-internal-runtime-routes.js'
import type { InternalRuntimeContext } from '../../api/src/server.js'
import { postAutomationTick, runAutomationMaintenance } from './main.js'

describe('automation actual route envelope contract', () => {
  it.each([true,false])('uses API data directly, native scheduling=%s', async nativeOnly => {
    const cleanup = vi.fn(async()=>({data:{cleaned:2}}))
    const purgeAssets = vi.fn(async()=>({data:{purged:0}}))
    const syncRules = vi.fn(async()=>({skipped:false}))
    const fetcher: typeof fetch = async url => {
      let response: Response | undefined
      await handleInternalRuntimeRoute({req:{method:'POST'},res:{},path:new URL(String(url)).pathname,
        requireWorkerAuthorization:vi.fn(),headerRequired:()=> 'workspace',hydrateWorkspace:vi.fn(),
        runAutomationTick:async()=>({executed:nativeOnly?[]:[{id:'fixture'}],skipped:nativeOnly,...(nativeOnly?{skipReason:'codex_native_automations_only'}:{})}),
        syncSignedPlatformRules:syncRules,
        send:(_res:unknown,status:number,_workspace:string,data:unknown)=>{response=Response.json({data,error:null},{status})},
      } as unknown as InternalRuntimeContext)
      return response!
    }
    const result = await runAutomationMaintenance({workspaces:['workspace'],
      tick:()=>postAutomationTick({apiBaseUrl:'https://fixture.test',apiToken:'fixture',workspaceId:'workspace',fetcher}) as ReturnType<Parameters<typeof runAutomationMaintenance>[0]['tick']>,
      cleanup,purgeAssets})
    expect(cleanup).toHaveBeenCalledTimes(nativeOnly?0:1)
    expect(syncRules).toHaveBeenCalledTimes(nativeOnly?0:1)
    expect(purgeAssets).toHaveBeenCalledOnce() // Existing independent purge policy.
    expect(result).toMatchObject({processed:nativeOnly?0:3,succeeded:nativeOnly?0:3,unknown:0})
  })
  it.each([{error:{code:'BROKEN'},data:{executed:[]}},{data:null},{},{data:{result:{executed:[]}}},{data:{executed:'wrong'}},{data:{executed:[],skipReason:4}}])('blocks cleanup and counts malformed/error response once: %j', async payload => {
    const cleanup=vi.fn(async()=>({data:{cleaned:9}})); const onError=vi.fn()
    const result=await runAutomationMaintenance({workspaces:['workspace'],tick:async()=>payload as never,cleanup,onError})
    expect(cleanup).not.toHaveBeenCalled();expect(onError).toHaveBeenCalledOnce()
    expect(result).toMatchObject({processed:0,succeeded:0,unknown:1})
  })
})
