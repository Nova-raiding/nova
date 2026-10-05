import {execFileSync} from 'node:child_process'
import {createHash,randomUUID} from 'node:crypto'
import {writeFileSync,renameSync} from 'node:fs'
import {dirname} from 'node:path'
import {readSafeRuntimeEvidenceFile} from '../apps/api/src/safe-evidence-file.js'
import {assertCommercialDeploymentPath,type CommercialRuntimePolicy} from '../apps/api/src/commercial-runtime-policy.js'

// Deployment-side only: run as root on the Docker host, never inside the API.
interface Config {project:string;apiPort:number;attesterRef:string;observationPath:string;approvalTemplatePath:string;approvalTemplateSha256:string;evidencePath:string;pinPath:string;candidateSha256:string;schemaSha256:string}
const digest=(raw:string)=>createHash('sha256').update(raw).digest('hex')
function atomic(path:string,raw:string){assertCommercialDeploymentPath(dirname(path),true);const temp=`${path}.${randomUUID()}.tmp`;writeFileSync(temp,raw,{mode:0o644,flag:'wx'});renameSync(temp,path)}
async function main(){
 if(process.getuid?.()!==0)throw new Error('ROOT_REQUIRED')
 const path=process.argv[2];if(!path)throw new Error('CONTROLLED_CONFIG_REQUIRED')
 assertCommercialDeploymentPath(path,true)
 const config=JSON.parse(readSafeRuntimeEvidenceFile(path)) as Config
 if(!config.project||!config.attesterRef||!Number.isSafeInteger(config.apiPort)||config.apiPort<1||config.apiPort>65535||![config.candidateSha256,config.schemaSha256,config.approvalTemplateSha256].every(v=>/^[a-f0-9]{64}$/.test(v)))throw new Error('CONFIG_INVALID')
 const started=Date.now()
 const docker=(args:string[])=>execFileSync('docker',args,{encoding:'utf8',timeout:10000,maxBuffer:1024*1024,stdio:['ignore','pipe','pipe']})
 const ids=docker(['ps','-a','--filter',`label=com.docker.compose.project=${config.project}`,'--format','{{.ID}}']).trim().split(/\s+/).filter(Boolean)
 if(!ids.length)throw new Error('FLEET_EMPTY')
 const inspected=JSON.parse(docker(['inspect',...ids])) as {Id:string;State:{Running:boolean};Config:{Hostname:string;Labels:Record<string,string>}}[]
 const apis=inspected.filter(c=>/^api(?:-|$)/.test(c.Config.Labels['com.docker.compose.service']??''))
 if(!apis.length||apis.some(c=>!['api','api-replica'].includes(c.Config.Labels['com.docker.compose.service']!)||!c.State.Running))throw new Error('API_INVENTORY_NOT_READY')
 const instances=[]
 for(const container of apis){
  const code=`const r=await fetch('http://127.0.0.1:${config.apiPort}/internal/commercial-runtime-attestation');if(!r.ok)process.exit(2);const b=await r.json();process.stdout.write(JSON.stringify(b.data));`
  const probe=JSON.parse(docker(['exec',container.Id,'node','--input-type=module','-e',code])) as {instanceId:string;salesProtocol:string;manifestSha256:string;schemaSha256:string}
  if(probe.instanceId!==container.Config.Hostname||probe.salesProtocol!=='commercial.sales.v3'||probe.manifestSha256!==config.candidateSha256||probe.schemaSha256!==config.schemaSha256)throw new Error('LIVE_API_PROBE_MISMATCH')
  instances.push({instanceId:probe.instanceId,salesProtocol:probe.salesProtocol,candidateSha256:probe.manifestSha256,schemaSha256:probe.schemaSha256})
 }
 // Inventory may change while probing: compare the actual container ids again.
 const after=docker(['ps','-a','--filter',`label=com.docker.compose.project=${config.project}`,'--format','{{.ID}}']).trim().split(/\s+/).filter(Boolean).sort()
 if(JSON.stringify([...ids].sort())!==JSON.stringify(after)||Date.now()-started>15000)throw new Error('FLEET_CHANGED_DURING_CAPTURE')
 assertCommercialDeploymentPath(config.approvalTemplatePath,true)
 const approvedRaw=readSafeRuntimeEvidenceFile(config.approvalTemplatePath)
 if(digest(approvedRaw)!==config.approvalTemplateSha256)throw new Error('ORIGINAL_APPROVAL_HASH_MISMATCH')
 const approved=JSON.parse(approvedRaw) as {approvedUntil:string;policy:CommercialRuntimePolicy}
 const until=Date.parse(approved.approvedUntil),now=Date.now()
 if(!Number.isFinite(until)||until<=now||approved.policy.candidateSha256!==config.candidateSha256||approved.policy.schemaSha256!==config.schemaSha256||approved.policy.mode!=='sale')throw new Error('ORIGINAL_APPROVAL_EXPIRED_OR_MISMATCH')
 const observation={schema:'commercial.fleet.observation.v1',attesterRef:config.attesterRef,capturedAt:new Date(now).toISOString(),completeInventory:true,inventory:apis.map(c=>c.Config.Hostname),instances}
 atomic(config.observationPath,JSON.stringify(observation))
 const evidence=JSON.stringify({schema:'commercial.runtime.evidence.v1',issuedAt:new Date(now).toISOString(),expiresAt:new Date(Math.min(until,now+15*60*1000)).toISOString(),fleetAttesterRef:config.attesterRef,policy:{...approved.policy,activeInstances:instances}})
 atomic(config.evidencePath,evidence);atomic(config.pinPath,`${digest(evidence)}\n`)
 process.stdout.write('commercial deployment fleet observation and bounded lease renewed\n')
}
main().catch(()=>{process.stderr.write('commercial deployment attestation failed; new writes must remain closed\n');process.exitCode=1})
