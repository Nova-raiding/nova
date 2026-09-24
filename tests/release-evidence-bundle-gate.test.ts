import { createHash, createPrivateKey, generateKeyPairSync, sign } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createBundle, EVIDENCE_KINDS } from '../infra/protected/attest-release-evidence-bundle.mjs'
import { validateReleaseEvidenceBundle } from './release-evidence-bundle-gate.js'

const releaseId='release-13', imageSetDigest=`sha256:${'a'.repeat(64)}`, releaseGitSha='c'.repeat(40), deploymentNonce='deployment_nonce_abcdefghijklmnop', keyId='prod-evidence-2026'
const digest=(bytes:Buffer|string)=>createHash('sha256').update(bytes).digest('hex')
const canonical=(value:unknown):string=>Array.isArray(value)?`[${value.map(canonical).join(',')}]`:value&&typeof value==='object'?`{${Object.entries(value as Record<string,unknown>).filter(([key])=>key!=='signature_base64').sort(([a],[b])=>a<b?-1:a>b?1:0).map(([key,item])=>`${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`:JSON.stringify(value)
function resignBundle(bundle:Record<string,unknown>,privatePem:string){delete bundle.signature_base64;bundle.signature_base64=sign(null,Buffer.from(canonical(bundle)),createPrivateKey(privatePem)).toString('base64')}
function fixture(){
  const root=mkdtempSync(join(tmpdir(),'bundle-gate-')), now=new Date('2026-09-16T08:00:00.000Z'), paths={} as Record<string,string>
  for(const kind of EVIDENCE_KINDS){const path=join(root,`${kind}.json`);writeFileSync(path,JSON.stringify({release_id:releaseId,generated_at:'2026-09-16T07:30:00.000Z',kind}));paths[kind]=path}
  if(paths.codexAppHost)writeFileSync(paths.codexAppHost,JSON.stringify({release_id:releaseId,generated_at:'2026-09-16T07:30:00.000Z',kind:'codexAppHost',environment:'production'}))
  const productionEvidence=Object.fromEntries(EVIDENCE_KINDS.map(kind=>{const bytes=readFileSync(paths[kind]!);return [kind,`artifact://production/${kind}.json#${createHash('sha256').update(bytes).digest('hex')}`]}))
  const releaseManifestBytes=Buffer.from(JSON.stringify({schemaVersion:1,releaseId,components:{releaseGitSha},productionEvidenceBundle:{required:true,schemaVersion:'release-evidence-bundle/1'},productionEvidence}))
  const manifestSha256=createHash('sha256').update(releaseManifestBytes).digest('hex')
  const {privateKey,publicKey}=generateKeyPairSync('ed25519');const privatePem=privateKey.export({type:'pkcs8',format:'pem'}).toString(),publicPem=publicKey.export({type:'spki',format:'pem'}).toString()
  const options={releaseId,imageSetDigest,manifestSha256,releaseGitSha,deploymentNonce,artifactRoot:root,evidenceFiles:paths as any,trustedKeyId:keyId,publicKeyPem:publicPem,releaseManifestBytes,now}
  const bundle=createBundle(paths,{releaseId,imageSetDigest,manifestSha256,releaseGitSha,deploymentNonce,keyId},root,privatePem,publicPem,now)
  return {root,paths,options,bundle,privatePem,publicPem,now}
}
describe('release evidence bundle gate',()=>{
  it('accepts exactly eight fresh hash-bound artifacts under one signed release binding',()=>{const f=fixture();expect(validateReleaseEvidenceBundle(f.bundle,f.options)).toEqual([])})
  it('rejects a changed artifact and a duplicate reference',()=>{const f=fixture();writeFileSync(f.paths.capability!,'changed');expect(validateReleaseEvidenceBundle(f.bundle,f.options).join('\n')).toContain('SHA-256 mismatch');const duplicate=structuredClone(f.bundle) as any;duplicate.artifacts[1].ref=duplicate.artifacts[0].ref;expect(validateReleaseEvidenceBundle(duplicate,f.options).join('\n')).toContain('duplicated')})
  it('rejects wrong common bindings, stale bundles and invalid signatures',()=>{const f=fixture();const changed=structuredClone(f.bundle) as any;changed.release_id='another';changed.generated_at='2026-09-14T08:00:00.000Z';changed.signature_base64='A'.repeat(86)+'==';const errors=validateReleaseEvidenceBundle(changed,f.options).join('\n');expect(errors).toContain('release_id');expect(errors).toContain('stale');expect(errors).toContain('signature')})
  it('rejects symlinks and exact-path substitution',()=>{const f=fixture(),link=join(f.root,'link.json');symlinkSync(f.paths.capacity!,link);const changed=structuredClone(f.bundle) as any;const bytes=readFileSync(f.paths.capacity!);changed.artifacts.find((x:any)=>x.kind==='capacity').ref=`artifact://production/link.json#${createHash('sha256').update(bytes).digest('hex')}`;expect(validateReleaseEvidenceBundle(changed,{...f.options,evidenceFiles:{...f.options.evidenceFiles,capacity:link}}).join('\n')).toMatch(/symlink|exact evidence/)})
  it('rejects path traversal outside the artifact root',()=>{const f=fixture(),changed=structuredClone(f.bundle) as any;changed.artifacts.find((x:any)=>x.kind==='modelRelay').ref=`artifact://production/../outside.json#${'d'.repeat(64)}`;expect(validateReleaseEvidenceBundle(changed,f.options).join('\n')).toContain('invalid path')})
  it('rejects a manifest that does not require the bundle or references different evidence',()=>{const f=fixture();const manifest=JSON.parse(f.options.releaseManifestBytes.toString()) as any;manifest.productionEvidenceBundle.required=false;manifest.productionEvidence.objectStorage='artifact://production/other.json#'+'f'.repeat(64);const releaseManifestBytes=Buffer.from(JSON.stringify(manifest));const errors=validateReleaseEvidenceBundle(f.bundle,{...f.options,releaseManifestBytes}).join('\n');expect(errors).toContain('release manifest SHA-256');expect(errors).toContain('must require release-evidence-bundle/1');expect(errors).toContain('productionEvidence.objectStorage must match')})
  it('rejects preproduction ChatGPT evidence even when the bundle is freshly signed and manifest-bound',()=>{
    const f=fixture(),host=JSON.parse(readFileSync(f.paths.codexAppHost!,'utf8')) as Record<string,unknown>
    host.environment='preproduction';host.candidate_route={expected_git_sha:releaseGitSha}
    const bytes=JSON.stringify(host);writeFileSync(f.paths.codexAppHost!,bytes)
    const ref=`artifact://production/codexAppHost.json#${digest(bytes)}`
    const manifest=JSON.parse(f.options.releaseManifestBytes.toString()) as any;manifest.productionEvidence.codexAppHost=ref
    const releaseManifestBytes=Buffer.from(JSON.stringify(manifest)),manifestSha256=digest(releaseManifestBytes)
    const bundle=structuredClone(f.bundle) as any;bundle.manifest_sha256=manifestSha256;bundle.artifacts.find((entry:any)=>entry.kind==='codexAppHost').ref=ref
    resignBundle(bundle,f.privatePem)
    const errors=validateReleaseEvidenceBundle(bundle,{...f.options,manifestSha256,releaseManifestBytes}).join('\n')
    expect(errors).toContain('codexAppHost environment must be production')
    expect(errors).toContain('codexAppHost candidate_route is forbidden in production evidence')
  })
  it('rejects preproduction artifact paths and refuses to sign preproduction host evidence',()=>{
    const f=fixture(),bytes=readFileSync(f.paths.codexAppHost!),preprodDir=join(f.root,'preproduction')
    mkdirSync(preprodDir);const preprodPath=join(preprodDir,'codexAppHost.json');writeFileSync(preprodPath,bytes)
    const paths={...f.paths,codexAppHost:preprodPath}
    expect(()=>createBundle(paths,{releaseId,imageSetDigest,manifestSha256:f.options.manifestSha256,releaseGitSha,deploymentNonce,keyId},f.root,f.privatePem,f.publicPem,f.now)).toThrow('codexAppHost evidence path must not reference a preproduction artifact')
    const changed=structuredClone(f.bundle) as any;changed.artifacts.find((entry:any)=>entry.kind==='codexAppHost').ref=`artifact://production/preproduction/codexAppHost.json#${digest(bytes)}`
    expect(validateReleaseEvidenceBundle(changed,f.options).join('\n')).toContain('codexAppHost ref must not reference a preproduction artifact')
  })
})
