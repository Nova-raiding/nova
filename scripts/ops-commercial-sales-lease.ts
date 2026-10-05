import {createHash,randomBytes} from 'node:crypto'
import {execFileSync} from 'node:child_process'
import type {ChildProcess} from 'node:child_process'
import {hostname} from 'node:os'
import {appendFileSync,lstatSync,mkdirSync,readFileSync,renameSync,unlinkSync,writeFileSync} from 'node:fs'
import {resolve} from 'node:path'
import {Pool} from 'pg'
import {postCommercialNotificationTick} from '../apps/worker/src/main.js'
import {buildReleaseManifest} from './release-manifest.js'
import {loadMigrations} from '../packages/persistence/src/migration.js'
import {commercialSchemaAttestationDigest} from '../apps/api/src/commercial-schema-attestation.js'
import {loadCommercialRuntimePolicy} from '../apps/api/src/commercial-runtime-policy.js'
import {createCommercialFileFleetObserver} from '../apps/api/src/commercial-fleet-observer.js'

export const COMMERCIAL_SALES_SPEC='dogfood/chatgpt-all-functions/ops-commercial-sales-isolated.spec.js'
export function isolatedCommercialSalesMode(args:readonly string[],env:NodeJS.ProcessEnv):boolean {
  const flag=env.OPS_E2E_COMMERCIAL_SALES
  if(flag!==undefined && flag!=='true')throw new Error('OPS_E2E_COMMERCIAL_SALES_FLAG_INVALID')
  const selected=args.filter(arg=>arg.endsWith('.spec.js'))
  if(flag==='true' && (selected.length!==1 || selected[0]!==COMMERCIAL_SALES_SPEC || env.OPS_E2E_MERCHANT_UI!=='true' || env.OPS_E2E_DELIVERY_SCAN!==undefined))throw new Error('OPS_E2E_COMMERCIAL_SALES_REQUIRES_DEDICATED_TWO_UI_FIXTURE')
  if(selected.includes(COMMERCIAL_SALES_SPEC) && flag!=='true')throw new Error('OPS_E2E_COMMERCIAL_SALES_CONTROLLED_LEASE_REQUIRED')
  return flag==='true'
}
const digest=(raw:string|Buffer)=>createHash('sha256').update(raw).digest('hex')
/** Include uncommitted/untracked executable source; HEAD alone never binds this live checkout. */
export function commercialOwnedSourceIdentity(root:string):string {
  const names=execFileSync('git',['-C',root,'ls-files','-z','--cached','--others','--exclude-standard'],{encoding:'utf8'}).split('\0').filter(name=>/^(apps|packages|scripts|demo\/merchant-studio|dogfood\/chatgpt-all-functions)\//u.test(name)&&/\.(?:[cm]?js|tsx?|json|sql|ya?ml)$/u.test(name)&&!/(?:^|\/)(?:node_modules|dist|build|coverage|\.vite)\//u.test(name))
  const rows=[...new Set(names)].sort().map(name=>{const file=resolve(root,name);const stat=lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink())throw new Error('OPS_E2E_COMMERCIAL_SOURCE_NOT_REGULAR');return [name,digest(readFileSync(file))]})
  if(!rows.length)throw new Error('OPS_E2E_COMMERCIAL_SOURCE_EMPTY')
  return digest(JSON.stringify(rows))
}
function atomic(path:string,raw:string){const temp=`${path}.owned.tmp`;writeFileSync(temp,raw,{mode:0o600,flag:'wx'});renameSync(temp,path)}
export interface CommercialLeaseOptions {root:string;evidenceDir:string;runId:string;databaseUrl:string;opsDatabaseUrl:string;controllerActor:string;workspaceId:string;ownedWorkspaceIds:readonly string[]}
/** Provision evidence ONLY. This function does not start a DB, API or browser. */
export async function prepareOwnedCommercialSalesLease(options:CommercialLeaseOptions) {
  const root=resolve(options.root),dir=resolve(options.evidenceDir,'owned-commercial-lease');mkdirSync(dir,{recursive:true,mode:0o700})
  const suffix=options.runId.replaceAll('-','').slice(0,16),expectedWorkspaces=[options.workspaceId,`ws-owned-history-${suffix}`,`ws-owned-pending-${suffix}`].sort()
  if(!options.workspaceId.startsWith('ws_ops_fixture_')||options.ownedWorkspaceIds.length!==3||JSON.stringify([...options.ownedWorkspaceIds].sort())!==JSON.stringify(expectedWorkspaces))throw new Error('OPS_E2E_COMMERCIAL_OWNED_WORKSPACE_REQUIRED')
  const workerToken=randomBytes(32).toString('hex'),workerSecret=randomBytes(48).toString('hex')
  const workerEvidencePath=resolve(dir,'notification-worker-progress.jsonl')
  const sourceSha256=commercialOwnedSourceIdentity(root)
  const manifest={...buildReleaseManifest({root,releaseId:`owned-test-${options.runId}`}),ownedTest:{scope:'isolated-test-only',controllerActor:options.controllerActor,controllerPid:process.pid,sourceSha256,runId:options.runId,formalCandidateAcceptance:false}}
  const manifestRaw=JSON.stringify(manifest),candidateSha256=digest(manifestRaw)
  const pools=[new Pool({connectionString:options.databaseUrl,max:1}),new Pool({connectionString:options.opsDatabaseUrl,max:1})]
  let schemaSha256:string
  try {const inventoryClient=await pools[1]!.connect();let inventory;try{await inventoryClient.query('BEGIN');await inventoryClient.query("SELECT set_config('app.platform_scope','platform_ops',true)");inventory=await inventoryClient.query<{id:string}>('SELECT id FROM workspaces ORDER BY id');await inventoryClient.query('COMMIT')}catch(error){await inventoryClient.query('ROLLBACK');throw error}finally{inventoryClient.release()}if(JSON.stringify(inventory.rows.map(row=>row.id))!==JSON.stringify(expectedWorkspaces))throw new Error('OPS_E2E_COMMERCIAL_WORKSPACE_INVENTORY_MISMATCH');const migrations=await loadMigrations();const histories=await Promise.all(pools.map(async pool=>{const identity=await pool.query<{role:string;superuser:boolean;bypass:boolean}>(`SELECT current_user AS role,rolsuper AS superuser,rolbypassrls AS bypass FROM pg_roles WHERE rolname=current_user`);const role=identity.rows[0];if(!role||role.superuser||role.bypass)throw new Error('OPS_E2E_COMMERCIAL_RUNTIME_ROLE_UNSAFE');const rows=await pool.query<{version:number;name:string;checksum:string}>('SELECT version,name,checksum FROM schema_migrations ORDER BY version');return {role:role.role,digest:commercialSchemaAttestationDigest(rows.rows,migrations)}}));if(histories[0]!.role!=='merchant_app'||histories[1]!.role!=='merchant_ops'||histories[0]!.digest!==histories[1]!.digest)throw new Error('OPS_E2E_COMMERCIAL_SCHEMA_ROLES_MISMATCH');schemaSha256=histories[0]!.digest;}finally{await Promise.all(pools.map(pool=>pool.end()))}
  const observationPath=resolve(dir,'fleet-observation.json'),evidencePath=resolve(dir,'runtime-evidence.json'),pinPath=resolve(dir,'runtime-evidence.sha256')
  const approvalPath=resolve(dir,'owned-test-approval.json'),auditPath=resolve(dir,'owned-test-catalog-audit.json'),acceptancePath=resolve(dir,'owned-test-runtime-scope.json'),manifestPath=resolve(dir,'owned-test-manifest.json')
  const attesterRef=`owned-test-controller:${options.runId}:${process.pid}`
  writeFileSync(manifestPath,manifestRaw,{mode:0o600,flag:'wx'})
  const auditRaw=JSON.stringify({scope:'isolated-test-only',controllerActor:options.controllerActor,runId:options.runId,policyRefsScope:'owned-test-not-production',candidateSha256,sourceSha256,purpose:'new test catalog will be independently submitted/approved/published through real Ops; no live commercial catalog approval asserted'})
  writeFileSync(auditPath,auditRaw,{mode:0o600,flag:'wx'})
  writeFileSync(approvalPath,JSON.stringify({scope:'isolated-test-only',controllerActor:options.controllerActor,controllerPid:process.pid,runId:options.runId,candidateSha256,schemaSha256,productionApproved:false}),{mode:0o600,flag:'wx'})
  let timer:ReturnType<typeof setInterval>|undefined,child:ChildProcess|undefined,stopped=false,running=false
  let rejectFailure!:(reason:Error)=>void
  const failure=new Promise<never>((_,reject)=>{rejectFailure=reject});void failure.catch(()=>undefined)
  const env:NodeJS.ProcessEnv={WORKER_API_CREDENTIALS:JSON.stringify({reconcile:{token:workerToken,signing_secret:workerSecret}}),RELEASE_MANIFEST_SHA256:candidateSha256,COMMERCIAL_RUNTIME_CANDIDATE_SHA256:candidateSha256,COMMERCIAL_RUNTIME_SCHEMA_SHA256:schemaSha256,COMMERCIAL_RUNTIME_FLEET_ATTESTER_REF:attesterRef,COMMERCIAL_RUNTIME_EVIDENCE_PATH:evidencePath,COMMERCIAL_RUNTIME_EVIDENCE_SHA256_PATH:pinPath,COMMERCIAL_RUNTIME_FLEET_OBSERVATION_PATH:observationPath}
  const fence=()=>{for(const file of [pinPath,evidencePath,observationPath,...[pinPath,evidencePath,observationPath].map(path=>`${path}.owned.tmp`)])try{unlinkSync(file)}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error}}
  const reject=(error:unknown)=>{if(stopped)return;stopped=true;if(timer)clearInterval(timer);try{fence()}finally{rejectFailure(error instanceof Error?error:new Error('OPS_E2E_COMMERCIAL_LEASE_LOST'))}}
  let scopeWritten=false
  const renew=async(apiUrl:string,inventory:()=>readonly ChildProcess[])=>{
    if(stopped)return
    if(commercialOwnedSourceIdentity(root)!==sourceSha256)throw new Error('OPS_E2E_COMMERCIAL_SOURCE_CHANGED')
    const apis=inventory();if(apis.length!==1||apis[0]!==child||!child?.pid||child.exitCode!==null||child.signalCode!==null)throw new Error('OPS_E2E_COMMERCIAL_INGRESS_INVENTORY_CHANGED')
    process.kill(child.pid,0)
    const parsed=new URL(apiUrl);if(parsed.hostname!=='127.0.0.1'||parsed.protocol!=='http:'||parsed.pathname!=='/')throw new Error('OPS_E2E_COMMERCIAL_EXCLUSIVE_LOOPBACK_REQUIRED')
    const response=await fetch(new URL('/internal/commercial-runtime-attestation',parsed),{signal:AbortSignal.timeout(2000)});if(!response.ok)throw new Error('OPS_E2E_COMMERCIAL_LIVE_PROBE_FAILED')
    const envelope=await response.json() as {data?:{instanceId:string;salesProtocol:string;manifestSha256:string;schemaSha256:string}};const probe=envelope.data
    if(!probe||probe.instanceId!==hostname()||probe.salesProtocol!=='commercial.sales.v3'||probe.manifestSha256!==candidateSha256||probe.schemaSha256!==schemaSha256)throw new Error('OPS_E2E_COMMERCIAL_LIVE_PROBE_IDENTITY_MISMATCH')
    if(stopped)return
    if(child.exitCode!==null||child.signalCode!==null||inventory().length!==1||inventory()[0]!==child)throw new Error('OPS_E2E_COMMERCIAL_INGRESS_INVENTORY_CHANGED')
    if(!scopeWritten){writeFileSync(acceptancePath,JSON.stringify({scope:'isolated-test-only',controllerActor:options.controllerActor,controllerPid:process.pid,apiChildPid:child.pid,exclusiveApiBind:'127.0.0.1',apiUrl,ingressApiChildren:1,ownedWorkspaceIds:options.ownedWorkspaceIds,notificationKinds:['catalog_publication','purchase_result'],probe,sourceSha256,candidateSha256,schemaSha256,productionCandidateVerified:false}),{mode:0o600,flag:'wx'});scopeWritten=true}
    const now=Date.now(),instances=[{instanceId:probe.instanceId,salesProtocol:probe.salesProtocol,candidateSha256,schemaSha256}]
    atomic(observationPath,JSON.stringify({schema:'commercial.fleet.observation.v1',attesterRef,capturedAt:new Date(now).toISOString(),completeInventory:true,inventory:[probe.instanceId],instances}))
    atomic(evidencePath,JSON.stringify({schema:'commercial.runtime.evidence.v1',issuedAt:new Date(now).toISOString(),expiresAt:new Date(now+15_000).toISOString(),fleetAttesterRef:attesterRef,policy:{mode:'sale',policyRevision:`owned-test:${options.runId}`,approvedEvidenceRef:approvalPath,catalogManualAuditRef:auditPath,runtimeAcceptanceRef:acceptancePath,catalogAuditSha256:digest(auditRaw),candidateSha256,schemaSha256,fleetEvidenceRef:observationPath,activeInstances:instances}}))
    atomic(pinPath,`${digest(readFileSync(evidencePath))}\n`)
    // Exercise the same real file verifier and fleet observer as the API, never an inline true.
    await loadCommercialRuntimePolicy({evidencePath,evidenceSha256Path:pinPath,expectedCandidateSha256:candidateSha256,expectedSchemaSha256:schemaSha256,fleetAttesterRef:attesterRef,production:false},createCommercialFileFleetObserver({path:observationPath,attesterRef,production:false}))
    const requests=[{workspaceId:options.workspaceId,notificationKind:'catalog_publication' as const},...options.ownedWorkspaceIds.map(workspaceId=>({workspaceId,notificationKind:'purchase_result' as const}))]
    for(const request of requests){if(stopped)return;const progress=await postCommercialNotificationTick({apiBaseUrl:parsed.origin,apiToken:workerToken,signingSecret:workerSecret,...request,signal:AbortSignal.timeout(2000)});appendFileSync(workerEvidencePath,JSON.stringify({scope:'owned-test-signed-worker',capturedAt:new Date().toISOString(),...request,...progress})+'\n',{mode:0o600})}

  }
  return {env,candidateSha256,schemaSha256,sourceSha256,
    guard:<T>(operation:Promise<T>):Promise<T>=>Promise.race([operation,failure]),
    start:async(api:ChildProcess,apiUrl:string,inventory:()=>readonly ChildProcess[])=>{if(child)throw new Error('OPS_E2E_COMMERCIAL_LEASE_ALREADY_STARTED');child=api;api.once('exit',()=>reject(new Error('OPS_E2E_COMMERCIAL_API_EXITED')));try{await renew(apiUrl,inventory)}catch(error){reject(error);throw error}timer=setInterval(()=>{if(running||stopped)return;running=true;void renew(apiUrl,inventory).catch(reject).finally(()=>{running=false})},5000);timer.unref()},
    stop:async()=>{stopped=true;if(timer)clearInterval(timer);fence()},
  }
}
export type OwnedCommercialSalesLease=Awaited<ReturnType<typeof prepareOwnedCommercialSalesLease>>
