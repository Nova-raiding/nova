import {describe,expect,it} from 'vitest'
import {execFileSync} from 'node:child_process'
import {mkdtempSync,writeFileSync,rmSync,realpathSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {applyCommercialRuntimeCompose} from '../infra/scripts/apply-commercial-runtime-compose.mjs'
describe('C6 actual Compose runtime directory binding',()=>{
 it('renders no evidence mount by default and keeps both API instances closed',()=>{
  const dir=realpathSync(mkdtempSync(join(tmpdir(),'commercial-compose-')))
  try{
   const value=applyCommercialRuntimeCompose({services:{api:{image:'local-api'},'api-replica':{image:'local-api'}}},{})
   const path=join(dir,'compose.json');writeFileSync(path,JSON.stringify(value))
   const actual=JSON.parse(execFileSync('docker',['compose','-p','commercial-config-test','-f',path,'config','--format','json'],{encoding:'utf8',stdio:'pipe'}))
   for(const name of ['api','api-replica']){expect(actual.services[name].environment.COMMERCIAL_RUNTIME_EVIDENCE_PATH).toBe('');expect(actual.services[name].volumes??[]).toHaveLength(0)}
  }finally{rmSync(dir,{recursive:true,force:true})}
 })
 it('uses a read-only whole directory bind for both instances and rejects missing sources',()=>{
  const dir=realpathSync(mkdtempSync(join(tmpdir(),'commercial-compose-')))
  try{
   const env={COMMERCIAL_RUNTIME_HOST_DIR:dir,COMMERCIAL_RUNTIME_EVIDENCE_PATH:'/run/merchant-commercial/lease.json',COMMERCIAL_RUNTIME_EVIDENCE_SHA256_PATH:'/run/merchant-commercial/pin.sha256',COMMERCIAL_RUNTIME_FLEET_OBSERVATION_PATH:'/run/merchant-commercial/fleet.json'}
   const value=applyCommercialRuntimeCompose({services:{api:{image:'local-api'},'api-replica':{image:'local-api'}}},env,{production:false})
   const path=join(dir,'compose.json');writeFileSync(path,JSON.stringify(value))
   const actual=JSON.parse(execFileSync('docker',['compose','-p','commercial-config-test','-f',path,'config','--format','json'],{encoding:'utf8',stdio:'pipe'}))
   for(const name of ['api','api-replica'])expect(actual.services[name].volumes[0]).toMatchObject({source:dir,target:'/run/merchant-commercial',read_only:true,bind:{create_host_path:false}})
   expect(()=>applyCommercialRuntimeCompose({services:{}},{...env,COMMERCIAL_RUNTIME_HOST_DIR:join(dir,'missing')},{production:false})).toThrow()
   expect(()=>applyCommercialRuntimeCompose({services:{}},{COMMERCIAL_RUNTIME_EVIDENCE_PATH:env.COMMERCIAL_RUNTIME_EVIDENCE_PATH})).toThrow('controlled host directory')
  }finally{rmSync(dir,{recursive:true,force:true})}
 })
})
