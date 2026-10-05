#!/usr/bin/env node
// Prepare host files only. Does not start services, modify live Compose or mint approval.
import * as nodeFs from 'node:fs'
import {pathToFileURL} from 'node:url'
import {createHash} from 'node:crypto'
import {dirname} from 'node:path'
function controlled(path,io){if(!/^\/[A-Za-z0-9_./-]+$/.test(path)||io.realpathSync(path)!==path)throw new Error('unsafe path');for(let p=path;;p=dirname(p)){const s=io.lstatSync(p);if(s.uid!==0||(s.mode&0o022)||s.isSymbolicLink())throw new Error('uncontrolled path');if(p===dirname(p))break}}
function exists(path,io){try{return io.lstatSync(path)}catch(e){if(e.code==='ENOENT')return undefined;throw e}}
function preflightParent(path,io){let current=path;while(!exists(current,io))current=dirname(current);controlled(current,io);if(!io.lstatSync(current).isDirectory())throw new Error('target parent is not a directory')}
export function planCommercialAttesterInstallation(args,{io=nodeFs,uid=process.getuid?.(),now=Date.now(),targetPrefix=''}={}){
 if(uid!==0)throw new Error('root required')
 const [root,node,project,portText,attester,approvedPath,candidate,schema]=args
 if(!root||!node||!approvedPath||!project||!attester||!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(project)||! /^[A-Za-z0-9_.:-]+$/.test(attester)||![candidate,schema].every(v=>/^[a-f0-9]{64}$/.test(v)))throw new Error('arguments invalid')
 for(const path of [root,node,approvedPath])controlled(path,io)
 if(!io.lstatSync(root).isDirectory()||!io.lstatSync(node).isFile()||(io.lstatSync(node).mode&0o111)===0||!io.lstatSync(approvedPath).isFile()||io.lstatSync(approvedPath).size<1||io.lstatSync(approvedPath).size>1024*1024)throw new Error('runtime or approval file type invalid')
 const port=Number(portText);if(!Number.isSafeInteger(port)||port<1||port>65535)throw new Error('port invalid')
 const template=io.readFileSync(approvedPath,'utf8'),approval=JSON.parse(template)
 if(approval.policy?.mode!=='sale'||approval.policy.candidateSha256!==candidate||approval.policy.schemaSha256!==schema||!Number.isFinite(Date.parse(approval.approvedUntil))||Date.parse(approval.approvedUntil)<=now||['policyRevision','approvedEvidenceRef','catalogManualAuditRef','runtimeAcceptanceRef','fleetEvidenceRef'].some(k=>typeof approval.policy[k]!=='string'||!approval.policy[k].trim())||!/^[a-f0-9]{64}$/.test(approval.policy.catalogAuditSha256??''))throw new Error('original approval missing or mismatched')
 const files=[]
 const target=path=>`${targetPrefix}${path}`
 const configPath=target('/etc/merchant-commercial/attester-config.json')
 const runtimeDir=target('/run/merchant-commercial')
 const add=(path,contents,mode)=>files.push({path:target(path),contents,mode})
 const config={project,apiPort:port,attesterRef:attester,observationPath:`${runtimeDir}/fleet.json`,approvalTemplatePath:approvedPath,approvalTemplateSha256:createHash('sha256').update(template).digest('hex'),evidencePath:`${runtimeDir}/lease.json`,pinPath:`${runtimeDir}/pin.sha256`,candidateSha256:candidate,schemaSha256:schema}
 add('/etc/merchant-commercial/attester-config.json',JSON.stringify(config,null,2)+'\n',0o600)
 add('/etc/merchant-commercial/compose-runtime.env',`COMMERCIAL_RUNTIME_HOST_DIR=/run/merchant-commercial\nCOMMERCIAL_RUNTIME_EVIDENCE_PATH=/run/merchant-commercial/lease.json\nCOMMERCIAL_RUNTIME_EVIDENCE_SHA256_PATH=/run/merchant-commercial/pin.sha256\nCOMMERCIAL_RUNTIME_FLEET_OBSERVATION_PATH=/run/merchant-commercial/fleet.json\nCOMMERCIAL_RUNTIME_CANDIDATE_SHA256=${candidate}\nCOMMERCIAL_RUNTIME_SCHEMA_SHA256=${schema}\nCOMMERCIAL_RUNTIME_FLEET_ATTESTER_REF=${attester}\n`,0o600)
 add('/etc/systemd/system/merchant-commercial-attester.service',`[Unit]\nDescription=Observe actual commercial API fleet and renew approved deployment lease\nAfter=docker.service\nRequires=docker.service\n[Service]\nType=oneshot\nUser=root\nWorkingDirectory=${root}\nExecStart=${node} --import tsx ${root}/scripts/commercial-fleet-attester.ts ${configPath}\nTimeoutStartSec=20\nUMask=0022\nNoNewPrivileges=true\n`,0o644)
 add('/etc/systemd/system/merchant-commercial-attester.timer','[Unit]\nDescription=Keep actual commercial fleet observation fresh\n[Timer]\nOnBootSec=1s\nOnUnitInactiveSec=5s\nAccuracySec=1s\nPersistent=false\nUnit=merchant-commercial-attester.service\n[Install]\nWantedBy=timers.target\n',0o644)
 add('/etc/tmpfiles.d/merchant-commercial.conf','d /run/merchant-commercial 0755 root root -\n',0o644)

 const directories=[...new Set([...files.map(f=>dirname(f.path)),runtimeDir])]
 for(const file of files){if(exists(file.path,io))throw new Error('target already exists');preflightParent(dirname(file.path),io)}
 for(const dir of directories)preflightParent(dir,io)
 return {files,directories}
}
export class CommercialAttesterInstallError extends Error {
 constructor(stage,report){super('commercial attester installation failed');this.stage=stage;this.report=report}
}
/** Every target is preflighted before writes. Rollback touches only files/dirs
 * created by this call whose inode is still the one we created. */
export function applyCommercialAttesterInstallation(plan,{io=nodeFs}={}){
 const createdFiles=[],createdDirectories=[],preserved=[],rollbackErrors=[]
 let stage='preflight'
 const identity=stat=>({dev:stat.dev,ino:stat.ino})
 const same=(a,b)=>a&&a.dev===b.dev&&a.ino===b.ino
 try{
  for(const file of plan.files){if(exists(file.path,io))throw new Error('target already exists');preflightParent(dirname(file.path),io)}
  for(const dir of plan.directories)preflightParent(dir,io)
  stage='directories'
  const createDirectory=path=>{if(exists(path,io)){controlled(path,io);return}createDirectory(dirname(path));io.mkdirSync(path,{mode:0o755});createdDirectories.push({path,...identity(io.lstatSync(path))});controlled(path,io)}
  for(const dir of plan.directories)createDirectory(dir)
  stage='files'
  for(const file of plan.files){
   // Record immediately after exclusive open, including a partially failed write.
   const fd=io.openSync(file.path,'wx',file.mode)
   const record={path:file.path};createdFiles.push(record)
   try{Object.assign(record,identity(io.fstatSync(fd)));io.writeFileSync(fd,file.contents);io.fsyncSync(fd)}finally{io.closeSync(fd)}
  }
  return {stage:'complete',createdFiles:createdFiles.map(f=>f.path),createdDirectories:createdDirectories.map(f=>f.path)}
 }catch{
  for(const file of [...createdFiles].reverse())try{if(same(exists(file.path,io),file))io.unlinkSync(file.path);else preserved.push(file.path)}catch{rollbackErrors.push(file.path)}
  for(const dir of [...createdDirectories].reverse())try{if(same(exists(dir.path,io),dir))io.rmdirSync(dir.path);else preserved.push(dir.path)}catch{rollbackErrors.push(dir.path)}
  throw new CommercialAttesterInstallError(stage,{createdFiles:createdFiles.map(f=>f.path),createdDirectories:createdDirectories.map(f=>f.path),preserved,rollbackErrors})
 }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 try{
  const plan=planCommercialAttesterInstallation(process.argv.slice(2))
  const result=applyCommercialAttesterInstallation(plan)
  process.stdout.write(`${JSON.stringify({status:'prepared',...result,servicesStarted:false,liveComposeChanged:false})}\n`)
 }catch(error){
  process.stderr.write(`${JSON.stringify({status:'blocked',stage:error instanceof CommercialAttesterInstallError?error.stage:'plan',report:error instanceof CommercialAttesterInstallError?error.report:undefined})}\n`)
  process.exitCode=1
 }
}
