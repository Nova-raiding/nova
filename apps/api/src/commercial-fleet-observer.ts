import {readSafeRuntimeEvidenceFile} from './safe-evidence-file.js'
import {CommercialRuntimePolicyError,assertCommercialDeploymentPath,type CommercialFleetObserver} from './commercial-runtime-policy.js'
export {assertCommercialDeploymentPath} from './commercial-runtime-policy.js'
export interface CommercialFleetObservationConfig {path?:string;attesterRef?:string;production:boolean}
/** Production files and their ancestor directories are deployment-owned. The
 * runtime has no Docker access and cannot create its own observation evidence.
 */
export function createCommercialFileFleetObserver(config:CommercialFleetObservationConfig):CommercialFleetObserver {
  return async()=>{
    if(!config.path||!config.attesterRef)throw new CommercialRuntimePolicyError('FLEET_OBSERVER_NOT_CONFIGURED')
    try {
      assertCommercialDeploymentPath(config.path,config.production)
      const doc=JSON.parse(readSafeRuntimeEvidenceFile(config.path)) as {schema:string;attesterRef:string;capturedAt:string;completeInventory:boolean;inventory:readonly string[];instances:readonly {instanceId:string;salesProtocol:string;candidateSha256:string;schemaSha256:string}[]}
      const age=Date.now()-Date.parse(doc.capturedAt)
      if(doc.schema!=='commercial.fleet.observation.v1'||doc.attesterRef!==config.attesterRef||!Number.isFinite(age)||age<0||age>15000||doc.completeInventory!==true||!Array.isArray(doc.inventory)||!Array.isArray(doc.instances)||!doc.inventory.length||doc.inventory.length!==doc.instances.length)throw new Error('incomplete or stale')
      const expected=[...doc.inventory].sort(),actual=doc.instances.map(i=>i.instanceId).sort()
      if(new Set(expected).size!==expected.length||expected.some((id,n)=>typeof id!=='string'||!id||id!==actual[n])||doc.instances.some(i=>typeof i.salesProtocol!=='string'||!i.salesProtocol||![i.candidateSha256,i.schemaSha256].every(v=>/^[a-f0-9]{64}$/.test(v))))throw new Error('identity mismatch')
      return structuredClone(doc.instances)
    }catch(error){if(error instanceof CommercialRuntimePolicyError)throw error;throw new CommercialRuntimePolicyError('FLEET_OBSERVATION_INVALID')}
  }
}
