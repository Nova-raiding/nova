import * as fs from 'node:fs'
import {tmpdir} from 'node:os'
import {join,dirname} from 'node:path'
import {createHash} from 'node:crypto'
import {describe,expect,it} from 'vitest'
import {planCommercialAttesterInstallation,applyCommercialAttesterInstallation,CommercialAttesterInstallError} from '../infra/scripts/install-commercial-attester.mjs'
const sha='a'.repeat(64)
function fixture(){
 const root=fs.realpathSync(fs.mkdtempSync(join(tmpdir(),'commercial-installer-'))),runtime=join(root,'candidate'),node=join(root,'node'),approval=join(root,'approved.json'),prefix=join(root,'host')
 fs.mkdirSync(runtime);fs.mkdirSync(prefix);fs.writeFileSync(node,'node fixture',{mode:0o755})
 const raw=JSON.stringify({approvedUntil:new Date(Date.now()+3600000).toISOString(),policy:{mode:'sale',policyRevision:'fixture-1',candidateSha256:sha,schemaSha256:sha,catalogAuditSha256:sha,approvedEvidenceRef:'approval-fixture',catalogManualAuditRef:'audit-fixture',runtimeAcceptanceRef:'acceptance-fixture',fleetEvidenceRef:'fleet-fixture'}})
 fs.writeFileSync(approval,raw,{mode:0o600})
 // Inject only ownership/ancestor-mode observations for the pure host planner;
 // all opens/writes/partial failures/rollback operate on real temp files.
 const io={...fs,lstatSync:(path:string)=>{const stat=fs.lstatSync(path);return Object.assign(Object.create(Object.getPrototypeOf(stat)),stat,{uid:0,mode:stat.mode&~0o022})}}
 const args=[runtime,node,'actual-project','8787','actual-project-ingress',approval,sha,sha]
 const options={io,uid:0,targetPrefix:prefix}
 return {root,runtime,approval,raw,prefix,io,args,options,close:()=>fs.rmSync(root,{recursive:true,force:true})}
}
describe('commercial attester installer preflight and owned-file rollback',()=>{
 it('preflights every target and never mutates an existing later timer',()=>{
  const f=fixture();try{
   const timer=join(f.prefix,'etc/systemd/system/merchant-commercial-attester.timer');fs.mkdirSync(dirname(timer),{recursive:true});fs.writeFileSync(timer,'original timer')
   expect(()=>planCommercialAttesterInstallation(f.args,f.options)).toThrow('target already exists')
   expect(fs.readFileSync(timer,'utf8')).toBe('original timer');expect(fs.existsSync(join(f.prefix,'etc/merchant-commercial'))).toBe(false)
  }finally{f.close()}
 })
 it('rejects unapproved/mismatched/expired policies and uncontrolled paths without output',()=>{
  const f=fixture();try{
   expect(()=>planCommercialAttesterInstallation(f.args,{...f.options,uid:501})).toThrow('root required')
   const document=JSON.parse(f.raw)
   for(const change of [{approvedUntil:new Date(0).toISOString()},{policy:{...document.policy,candidateSha256:'b'.repeat(64)}},{policy:{...document.policy,approvedEvidenceRef:''}}]){
    fs.writeFileSync(f.approval,JSON.stringify({...document,...change}));expect(()=>planCommercialAttesterInstallation(f.args,f.options)).toThrow('original approval')
   }
   fs.writeFileSync(f.approval,f.raw)
   expect(()=>planCommercialAttesterInstallation(f.args,{...f.options,io:{...f.io,lstatSync:(path:string)=>{const stat=f.io.lstatSync(path);if(path===f.approval)stat.uid=501;return stat}}})).toThrow('uncontrolled path')
   expect(fs.readdirSync(f.prefix)).toEqual([])
  }finally{f.close()}
 })
 it('writes complete protected config and units preserving the original approval bytes',()=>{
  const f=fixture();try{
   const plan=planCommercialAttesterInstallation(f.args,f.options),result=applyCommercialAttesterInstallation(plan,{io:f.io})
   expect(result.stage).toBe('complete');expect(result.createdFiles).toHaveLength(5)
   for(const file of plan.files){expect(fs.readFileSync(file.path,'utf8')).toBe(file.contents);expect(fs.statSync(file.path).mode&0o777).toBe(file.mode)}
   const config=JSON.parse(fs.readFileSync(plan.files[0]!.path,'utf8'))
   expect(config.approvalTemplateSha256).toBe(createHash('sha256').update(f.raw).digest('hex'));expect(fs.readFileSync(f.approval,'utf8')).toBe(f.raw)
   expect(plan.files[2]!.contents).toContain(`ExecStart=${f.args[1]} --import tsx`);expect(plan.files[3]!.contents).toContain('OnUnitInactiveSec=5s')
   expect(()=>applyCommercialAttesterInstallation(plan,{io:f.io})).toThrow(CommercialAttesterInstallError)
   expect(fs.readFileSync(plan.files[0]!.path,'utf8')).toBe(plan.files[0]!.contents)
  }finally{f.close()}
 })
 it('rolls back owned files including a partial write and leaves original parent contents intact',()=>{
  const f=fixture();try{
   const parent=join(f.prefix,'etc/systemd/system');fs.mkdirSync(parent,{recursive:true});const original=join(parent,'unrelated.service');fs.writeFileSync(original,'existing service')
   const plan=planCommercialAttesterInstallation(f.args,f.options);let count=0
   const io={...f.io,writeFileSync:(fd:number,contents:string)=>{count++;if(count===4){fs.writeFileSync(fd,'partial');throw new Error('injected disk write failure')}fs.writeFileSync(fd,contents)}}
   let failure:unknown;try{applyCommercialAttesterInstallation(plan,{io})}catch(e){failure=e}
   expect(failure).toBeInstanceOf(CommercialAttesterInstallError);expect((failure as CommercialAttesterInstallError).stage).toBe('files')
   expect((failure as CommercialAttesterInstallError).report.rollbackErrors).toEqual([])
   for(const file of plan.files)expect(fs.existsSync(file.path)).toBe(false)
   expect(fs.readFileSync(original,'utf8')).toBe('existing service');expect(fs.existsSync(join(f.prefix,'etc/merchant-commercial'))).toBe(false)
   expect(()=>applyCommercialAttesterInstallation(plan,{io:f.io})).not.toThrow()
  }finally{f.close()}
 })
 it('does not remove a replaced inode during rollback and reports the preserved path',()=>{
  const f=fixture();try{
   const plan=planCommercialAttesterInstallation(f.args,f.options);let count=0
   const io={...f.io,writeFileSync:(fd:number,contents:string)=>{count++;if(count===2){fs.renameSync(plan.files[0]!.path,`${plan.files[0]!.path}.saved`);fs.writeFileSync(plan.files[0]!.path,'replacement by another owner');throw new Error('injected replacement')}fs.writeFileSync(fd,contents)}}
   let failure:unknown;try{applyCommercialAttesterInstallation(plan,{io})}catch(e){failure=e}
   expect((failure as CommercialAttesterInstallError).report.preserved).toContain(plan.files[0]!.path)
   expect(fs.readFileSync(plan.files[0]!.path,'utf8')).toBe('replacement by another owner')
  }finally{f.close()}
 })
})
