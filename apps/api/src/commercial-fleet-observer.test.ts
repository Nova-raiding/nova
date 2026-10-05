import {describe,expect,it} from 'vitest'
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createCommercialFileFleetObserver} from './commercial-fleet-observer.js'
import {assertCommercialRuntimeOperation,loadCommercialRuntimePolicy} from './commercial-runtime-policy.js'
import {createHash} from 'node:crypto'
const sha='a'.repeat(64)
describe('deployment-owned complete commercial fleet observation',()=>{
 it('rejects missing config, stale/partial/identity-mismatched files and observes actual mixed protocol',async()=>{
  await expect(createCommercialFileFleetObserver({production:true})()).rejects.toThrow('FLEET_OBSERVER_NOT_CONFIGURED')
  const dir=mkdtempSync(join(tmpdir(),'commercial-fleet-')),path=join(dir,'fleet.json')
  const instance={instanceId:'actual-api',salesProtocol:'commercial.sales.v3',candidateSha256:sha,schemaSha256:sha}
  const doc={schema:'commercial.fleet.observation.v1',attesterRef:'docker-project-actual',capturedAt:new Date().toISOString(),completeInventory:true,inventory:['actual-api'],instances:[instance]}
  const observer=createCommercialFileFleetObserver({path,attesterRef:doc.attesterRef,production:false})
  try{
   writeFileSync(path,JSON.stringify(doc),{mode:0o600});expect(await observer()).toEqual([instance])
   for(const delta of [{capturedAt:new Date(Date.now()-16000).toISOString()},{inventory:['actual-api','unprobed-api']},{instances:[{...instance,instanceId:'different-api'}]},{attesterRef:'wrong-attester'},{completeInventory:false}]){
    writeFileSync(path,JSON.stringify({...doc,...delta}),{mode:0o600});await expect(observer()).rejects.toThrow('FLEET_OBSERVATION_INVALID')
   }
   writeFileSync(path,JSON.stringify(doc),{mode:0o600});await expect(createCommercialFileFleetObserver({path,attesterRef:doc.attesterRef,production:true})()).rejects.toThrow('FLEET_PATH_NOT_DEPLOYMENT_OWNED')
   writeFileSync(path,JSON.stringify({...doc,instances:[{...instance,salesProtocol:'commercial.sales.v2'}]}),{mode:0o600})
   expect((await observer())[0]?.salesProtocol).toBe('commercial.sales.v2')
   const policy={mode:'sale',policyRevision:'1',approvedEvidenceRef:'approval',catalogManualAuditRef:'audit',runtimeAcceptanceRef:'acceptance',catalogAuditSha256:sha,candidateSha256:sha,schemaSha256:sha,fleetEvidenceRef:'fleet',activeInstances:[instance]}
   const raw=JSON.stringify({schema:'commercial.runtime.evidence.v1',issuedAt:new Date(Date.now()-1000).toISOString(),expiresAt:new Date(Date.now()+60000).toISOString(),fleetAttesterRef:doc.attesterRef,policy}),approvalPath=join(dir,'approval.json')
   writeFileSync(approvalPath,raw,{mode:0o600})
   await expect(loadCommercialRuntimePolicy({evidencePath:approvalPath,evidenceSha256:createHash('sha256').update(raw).digest('hex'),expectedCandidateSha256:sha,expectedSchemaSha256:sha,fleetAttesterRef:doc.attesterRef},observer)).rejects.toThrow('DEPLOYMENT_EVIDENCE_NOT_VERIFIED')
   expect(()=>assertCommercialRuntimeOperation(undefined,'new_purchase')).toThrow()
  }finally{rmSync(dir,{recursive:true,force:true})}
 })
})
