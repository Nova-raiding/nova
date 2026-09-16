import { createHash, generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createBundle, EVIDENCE_KINDS } from '../infra/protected/attest-release-evidence-bundle.mjs'
import { validateReleaseEvidenceBundle } from './release-evidence-bundle-gate.js'

const releaseId='release-13', imageSetDigest=`sha256:${'a'.repeat(64)}`, releaseGitSha='c'.repeat(40), deploymentNonce='deployment_nonce_abcdefghijklmnop', keyId='prod-evidence-2026'
function fixture(){
  const root=mkdtempSync(join(tmpdir(),'bundle-gate-')), now=new Date('2026-09-16T08:00:00.000Z'), paths={} as Record<string,string>
  for(const kind of EVIDENCE_KINDS){const path=join(root,`${kind}.json`);writeFileSync(path,JSON.stringify({release_id:releaseId,generated_at:'2026-09-16T07:30:00.000Z',kind}));paths[kind]=path}
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
})
