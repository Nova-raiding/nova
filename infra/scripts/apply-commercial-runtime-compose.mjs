import {readFileSync,lstatSync,realpathSync} from 'node:fs'
import {dirname,isAbsolute,posix} from 'node:path'
import {pathToFileURL} from 'node:url'
export const COMMERCIAL_RUNTIME_ENV_KEYS=['COMMERCIAL_RUNTIME_EVIDENCE_PATH','COMMERCIAL_RUNTIME_EVIDENCE_SHA256','COMMERCIAL_RUNTIME_EVIDENCE_SHA256_PATH','COMMERCIAL_RUNTIME_FLEET_OBSERVATION_PATH','COMMERCIAL_RUNTIME_CANDIDATE_SHA256','COMMERCIAL_RUNTIME_SCHEMA_SHA256','COMMERCIAL_RUNTIME_FLEET_ATTESTER_REF']
export function readCommercialRuntimeEnvironment(path){
 const result={}
 for(const line of readFileSync(path,'utf8').split(/\r?\n/)){
  const match=line.match(/^\s*(COMMERCIAL_RUNTIME_[A-Z_]+)\s*=\s*(.*?)\s*$/)
  if(!match||!['COMMERCIAL_RUNTIME_HOST_DIR',...COMMERCIAL_RUNTIME_ENV_KEYS].includes(match[1]))continue
  let value=match[2];if((value.startsWith('"')&&value.endsWith('"'))||(value.startsWith("'")&&value.endsWith("'")))value=value.slice(1,-1)
  if(/[\r\n$`]/.test(value))throw new Error('commercial runtime environment contains unsafe interpolation')
  result[match[1]]=value
 }
 return result
}
export function applyCommercialRuntimeCompose(compose,env,{production=true}={}){
 const source=env.COMMERCIAL_RUNTIME_HOST_DIR?.trim()
 if(!source&&COMMERCIAL_RUNTIME_ENV_KEYS.some(key=>env[key]?.trim()))throw new Error('commercial runtime bindings require a controlled host directory')
 if(source){
  if(!isAbsolute(source)||realpathSync(source)!==source||!lstatSync(source).isDirectory())throw new Error('commercial runtime host directory must exist and be canonical')
  for(let current=source;;current=dirname(current)){
   const stat=lstatSync(current)
   if(stat.isSymbolicLink()||(production&&(stat.uid!==0||(stat.mode&0o022)!==0)))throw new Error('commercial runtime host directory is not deployment controlled')
   if(current===dirname(current))break
  }
  for(const key of ['COMMERCIAL_RUNTIME_EVIDENCE_PATH','COMMERCIAL_RUNTIME_EVIDENCE_SHA256_PATH','COMMERCIAL_RUNTIME_FLEET_OBSERVATION_PATH'])if(env[key]&&(!env[key].startsWith('/run/merchant-commercial/')||posix.normalize(env[key])!==env[key]))throw new Error('commercial evidence paths must use the controlled directory mount')
 }
 for(const name of ['api','api-replica']){
  const service=compose.services?.[name];if(!service)continue
  service.environment??={};for(const key of COMMERCIAL_RUNTIME_ENV_KEYS)service.environment[key]=env[key]??''
  if(source){service.volumes??=[];if(service.volumes.some(v=>(typeof v==='string'?v.split(':')[1]:v.target)==='/run/merchant-commercial'))throw new Error('duplicate commercial runtime mount');service.volumes.push({type:'bind',source,target:'/run/merchant-commercial',read_only:true,bind:{create_host_path:false}})}
 }
 return compose
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 try{
  let raw='';for await(const chunk of process.stdin)raw+=chunk
  const compose=applyCommercialRuntimeCompose(JSON.parse(raw),readCommercialRuntimeEnvironment(process.argv[2]))
  for(const service of Object.values(compose.services??{})){if(typeof service.cpus==='number')service.cpus=String(service.cpus);for(const r of [service.deploy?.resources?.limits,service.deploy?.resources?.reservations])if(r&&typeof r.cpus==='number')r.cpus=String(r.cpus)}
  process.stdout.write(`${JSON.stringify(compose,null,2)}\n`)
 }catch{process.stderr.write('commercial runtime Compose binding failed; protected diagnostics withheld\n');process.exitCode=1}
}
