import { createHash, createPublicKey, verify } from 'node:crypto'
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import { validateCapacityEvidence } from './capacity-evidence-gate.js'

export const EVIDENCE_KINDS = ['capability','capacity','modelRelay','payment','restore','objectStorage','codexAppHost','canonicalCutover'] as const
type Kind = typeof EVIDENCE_KINDS[number]
type Bundle = Record<string, unknown> & { artifacts?: Array<{kind?: string; ref?: string}> }
const REF = /^artifact:\/\/production\/([A-Za-z0-9._/-]+)#([a-f0-9]{64})$/u
const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u
const canonical = (value: unknown): string => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : value && typeof value === 'object' ? `{${Object.entries(value as Record<string,unknown>).filter(([key]) => key !== 'signature_base64').sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0).map(([key,item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}` : JSON.stringify(value)
const sha256 = (value: Buffer) => createHash('sha256').update(value).digest('hex')

function validateCapacityArtifact(document: Record<string, unknown>, releaseId: string, errors: string[], now: Date) {
  if (document.status !== 'not_performed' && document.profile !== 'no_load') return
  errors.push(...validateCapacityEvidence(document, { expectedProfile: 'no_load', expectedReleaseId: releaseId, now }))
}

export function validateReleaseEvidenceBundle(document: unknown, options: { releaseId: string; imageSetDigest: string; manifestSha256: string; releaseGitSha: string; deploymentNonce: string; artifactRoot: string; evidenceFiles: Record<Kind,string>; trustedKeyId: string; publicKeyPem: string; releaseManifestBytes?: Buffer; now?: Date }): string[] {
  if (!document || typeof document !== 'object' || Array.isArray(document)) return ['bundle must be a JSON object']
  const value = document as Bundle, errors: string[] = [], now = (options.now ?? new Date()).getTime()
  const expected = { schema_version:'release-evidence-bundle/1', release_id:options.releaseId, image_set_digest:options.imageSetDigest, manifest_sha256:options.manifestSha256, release_git_sha:options.releaseGitSha, deployment_nonce:options.deploymentNonce, key_id:options.trustedKeyId }
  for (const [field,wanted] of Object.entries(expected)) if (value[field] !== wanted) errors.push(`${field} must match the deployment binding`)
  if (options.releaseManifestBytes) {
    if (sha256(options.releaseManifestBytes) !== options.manifestSha256) errors.push('release manifest SHA-256 does not match the deployment binding')
    try {
      const manifest = JSON.parse(options.releaseManifestBytes.toString('utf8')) as { releaseId?: unknown; components?: { releaseGitSha?: unknown }; productionEvidenceBundle?: { required?: unknown; schemaVersion?: unknown }; productionEvidence?: Record<string,string> }
      if (manifest.releaseId !== options.releaseId) errors.push('release manifest releaseId must match the bundle')
      if (manifest.components?.releaseGitSha !== options.releaseGitSha) errors.push('release manifest Git SHA must match the bundle')
      if (manifest.productionEvidenceBundle?.required !== true || manifest.productionEvidenceBundle?.schemaVersion !== 'release-evidence-bundle/1') errors.push('release manifest must require release-evidence-bundle/1')
      const bundleRefs = new Map((Array.isArray(value.artifacts) ? value.artifacts : []).map(entry => [entry.kind, entry.ref]))
      for (const kind of EVIDENCE_KINDS) if (manifest.productionEvidence?.[kind] !== bundleRefs.get(kind)) errors.push(`release manifest productionEvidence.${kind} must match the bundle artifact ref`)
    } catch { errors.push('release manifest is invalid JSON') }
  }
  const generated = typeof value.generated_at === 'string' && UTC.test(value.generated_at) ? Date.parse(value.generated_at) : Number.NaN
  const expires = typeof value.expires_at === 'string' && UTC.test(value.expires_at) ? Date.parse(value.expires_at) : Number.NaN
  if (!Number.isFinite(generated) || generated > now + 300_000 || now - generated > 86_400_000) errors.push('generated_at is invalid, stale, or in the future')
  if (!Number.isFinite(expires) || expires <= now || (Number.isFinite(generated) && expires > generated + 86_400_000)) errors.push('expires_at is invalid or outside the 24 hour bundle lifetime')
  let root = ''; try { root = realpathSync(options.artifactRoot) } catch { errors.push('artifact root cannot be resolved') }
  const entries = Array.isArray(value.artifacts) ? value.artifacts : []
  if (entries.length !== EVIDENCE_KINDS.length) errors.push('bundle must contain exactly eight evidence artifacts')
  const seenKinds = new Set<string>(), seenRefs = new Set<string>()
  for (const entry of entries) {
    const kind = entry.kind as Kind, match = REF.exec(entry.ref ?? '')
    if (!EVIDENCE_KINDS.includes(kind)) { errors.push('artifact kind is unknown'); continue }
    if (seenKinds.has(kind)) errors.push(`artifact kind is duplicated: ${kind}`); seenKinds.add(kind)
    if (!match) { errors.push(`${kind} ref must be an immutable production artifact`); continue }
    if (seenRefs.has(entry.ref!)) errors.push(`artifact ref is duplicated: ${kind}`); seenRefs.add(entry.ref!)
    const relative = match[1]!; if (relative.split('/').some(part => !part || part === '.' || part === '..')) { errors.push(`${kind} ref contains an invalid path`); continue }
    try {
      const candidate = resolve(root, relative), stat = lstatSync(candidate), real = realpathSync(candidate)
      if (!candidate.startsWith(`${root}${sep}`) || !real.startsWith(`${root}${sep}`) || stat.isSymbolicLink() || !stat.isFile()) throw new Error('unsafe')
      const bytes = readFileSync(real); if (sha256(bytes) !== match[2]) errors.push(`${kind} artifact SHA-256 mismatch`)
      if (kind === 'capacity') {
        try { validateCapacityArtifact(JSON.parse(bytes.toString('utf8')) as Record<string, unknown>, options.releaseId, errors, new Date(now)) }
        catch { errors.push('capacity artifact is invalid JSON') }
      }
      const supplied = options.evidenceFiles[kind]; if (!supplied || lstatSync(supplied).isSymbolicLink() || realpathSync(supplied) !== real) errors.push(`${kind} must reference the exact evidence file passed to deployment`)
    } catch { errors.push(`${kind} artifact escapes the root, is a symlink, or cannot be read`) }
  }
  for (const kind of EVIDENCE_KINDS) if (!seenKinds.has(kind)) errors.push(`artifact is missing: ${kind}`)
  const signature = value.signature_base64
  if (typeof signature !== 'string' || !/^[A-Za-z0-9+/]{86}==$/u.test(signature)) errors.push('signature_base64 must be a canonical Ed25519 signature')
  else try { const key = createPublicKey(options.publicKeyPem); if (key.asymmetricKeyType !== 'ed25519' || !verify(null, Buffer.from(canonical(value)), key, Buffer.from(signature,'base64'))) errors.push('bundle signature is invalid') } catch { errors.push('bundle trust anchor or signature is invalid') }
  return errors
}

function arg(name:string) { const index=process.argv.indexOf(name); return index<0?undefined:process.argv[index+1] }
function main() {
  const file=arg('--file'), releaseManifest=arg('--release-manifest'), artifactRoot=arg('--artifact-root'), publicKey=arg('--public-key'), trustedKeyId=arg('--key-id')
  const bindings={releaseId:arg('--release-id'),imageSetDigest:arg('--image-set-digest'),manifestSha256:arg('--manifest-sha256'),releaseGitSha:arg('--release-git-sha'),deploymentNonce:arg('--deployment-nonce')}
  const evidenceFiles=Object.fromEntries(EVIDENCE_KINDS.map(kind=>[kind,arg(`--${kind.replace(/[A-Z]/g,letter=>`-${letter.toLowerCase()}`)}-evidence`)])) as Record<Kind,string>
  if(!file||!releaseManifest||!artifactRoot||!publicKey||!trustedKeyId||Object.values(bindings).some(item=>!item)||Object.values(evidenceFiles).some(item=>!item)){console.error('bundle, release manifest, all eight artifacts, release binding, artifact root and trust anchor are required');process.exit(2)}
  const errors=validateReleaseEvidenceBundle(JSON.parse(readFileSync(file,'utf8')),{releaseId:bindings.releaseId!,imageSetDigest:bindings.imageSetDigest!,manifestSha256:bindings.manifestSha256!,releaseGitSha:bindings.releaseGitSha!,deploymentNonce:bindings.deploymentNonce!,artifactRoot,evidenceFiles,trustedKeyId,publicKeyPem:readFileSync(publicKey,'utf8'),releaseManifestBytes:readFileSync(releaseManifest)})
  if(errors.length){console.error(errors.join('\n'));process.exit(1)} console.log(`release evidence bundle gate passed: ${file}`)
}
if(import.meta.url===`file://${process.argv[1]}`)main()
