import { createPublicKey, verify } from 'node:crypto'
import { readFileSync } from 'node:fs'
import {
  PLATFORM_CAPABILITY_CONTRACT_CAPABILITIES,
  PLATFORM_CAPABILITY_CONTRACT_PLATFORMS,
  PLATFORM_CAPABILITY_EVIDENCE_STATES,
  validatePlatformCapabilityEvidence,
} from '../packages/connectors/src/platform-preflight.js'

export const REQUIRED_PLATFORMS = PLATFORM_CAPABILITY_CONTRACT_PLATFORMS
export const REQUIRED_CAPABILITIES = PLATFORM_CAPABILITY_CONTRACT_CAPABILITIES
export const EVIDENCE_STATES = PLATFORM_CAPABILITY_EVIDENCE_STATES

type ProductionBindings = {
  releaseId: string
  imageSetDigest: string
  manifestSha256: string
  releaseGitSha: string
  deploymentNonce: string
  trustedKeyId: string
  publicKeyPem: string
}

const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0
const compareCodeUnits = ([left]: [string, unknown], [right]: [string, unknown]) => left < right ? -1 : left > right ? 1 : 0
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>).filter(([key]) => key !== 'signature_base64').sort(compareCodeUnits).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
  return JSON.stringify(value)
}

export function validateCapabilityProductionSignature(document: unknown, options: ProductionBindings): string[] {
  if (!document || typeof document !== 'object' || Array.isArray(document)) return ['document must be a JSON object']
  const value = document as Record<string, unknown>
  const errors: string[] = []
  const expected: Record<string, string> = {
    release_id: options.releaseId,
    image_set_digest: options.imageSetDigest,
    manifest_sha256: options.manifestSha256,
    release_git_sha: options.releaseGitSha,
    deployment_nonce: options.deploymentNonce,
    key_id: options.trustedKeyId,
    environment: 'production',
  }
  for (const [field, wanted] of Object.entries(expected)) if (value[field] !== wanted) errors.push(`${field} must match ${wanted}`)
  if (value.simulated !== false) errors.push('simulated must be false')
  if (!text(value.signature_base64)) errors.push('signature_base64 is required')
  else if (!/^[A-Za-z0-9+/]{86}==$/u.test(value.signature_base64)) errors.push('signature_base64 must be a canonical Ed25519 signature')
  else {
    try {
      const key = createPublicKey(options.publicKeyPem)
      if (key.asymmetricKeyType !== 'ed25519') errors.push('trusted public key must be Ed25519')
      else if (!verify(null, Buffer.from(canonical(value)), key, Buffer.from(value.signature_base64, 'base64'))) errors.push('signature_base64 is invalid')
    } catch {
      errors.push('trusted public key or signature is invalid')
    }
  }
  return errors
}

export function validateCapabilityEvidence(document: unknown, options: { requireCanary?: boolean; expectedReleaseId?: string } = {}): string[] {
  const errors = validatePlatformCapabilityEvidence(document, options)
  return errors.some(error => error.includes('secret-like field is not allowed'))
    ? [...errors, 'evidence document must not contain secret-like keys or values']
    : errors
}

function main() {
  const args = process.argv.slice(2)
  const fileIndex = args.indexOf('--file')
  const path = (fileIndex >= 0 ? args[fileIndex + 1] : undefined) ?? 'doc/todo/platform/platform-capability-evidence.example.json'
  const releaseIndex = args.indexOf('--release-id')
  const expectedReleaseId = releaseIndex >= 0 ? args[releaseIndex + 1] : undefined
  let document: unknown
  try { document = JSON.parse(readFileSync(path, 'utf8')) } catch (error) { console.error(`unable to read JSON evidence: ${error instanceof Error ? error.message : String(error)}`); process.exit(1) }
  const errors = validateCapabilityEvidence(document, { requireCanary: args.includes('--require-canary'), expectedReleaseId })
  if (args.includes('--require-signed-production')) {
    const option = (name: string) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined }
    const imageSetDigest = option('--image-set-digest'); const manifestSha256 = option('--manifest-sha256'); const releaseGitSha = option('--release-git-sha'); const deploymentNonce = option('--deployment-nonce'); const publicKeyPath = option('--public-key'); const trustedKeyId = option('--key-id')
    if (!expectedReleaseId || !imageSetDigest || !manifestSha256 || !releaseGitSha || !deploymentNonce || !publicKeyPath || !trustedKeyId) {
      console.error('signed production capability evidence requires release, image set, manifest, commit, deployment nonce and fixed trust anchor bindings')
      process.exit(2)
    }
    try {
      errors.push(...validateCapabilityProductionSignature(document, { releaseId: expectedReleaseId, imageSetDigest, manifestSha256, releaseGitSha, deploymentNonce, publicKeyPem: readFileSync(publicKeyPath, 'utf8'), trustedKeyId }))
    } catch (error) {
      errors.push(`unable to read capability trust anchor: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (errors.length) { console.error(errors.map(error => `- ${error}`).join('\n')); process.exit(1) }
  console.log(args.includes('--require-canary')
    ? `capability evidence gate passed: ${path} (production_canary requirements validated; signed production binding is a separate gate)`
    : `capability evidence schema passed: ${path} (fixture/non-production validation only; not production evidence)`)
}

if (import.meta.url === `file://${process.argv[1]}`) main()
