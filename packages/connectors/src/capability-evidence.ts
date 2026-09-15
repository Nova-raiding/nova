import { createPublicKey, verify } from 'node:crypto'
import type { Platform } from './types.js'

export type CapabilityName = 'authorize' | 'read' | 'full_sync' | 'incremental_sync' | 'create' | 'update' | 'query_status' | 'revoke' | 'media_upload'
export type CapabilityEvidenceState = 'unverified' | 'documented' | 'fixture_verified' | 'test_e2e' | 'production_canary'

export interface CapabilityEvidence {
  platform: Platform
  capability: CapabilityName
  state: CapabilityEvidenceState
  applicationId?: string
  scope?: string
  apiVersion?: string
  testAccountId?: string
  evidenceRef?: string
  verifiedBy?: string
  verifiedAt?: string
}

const order: CapabilityEvidenceState[] = ['unverified', 'documented', 'fixture_verified', 'test_e2e', 'production_canary']

export interface ProductionCapabilityEvidenceTrust {
  documentJson: string
  publicKeyPem: string
  trustedKeyId: string
}

const compareCodeUnits = ([left]: [string, unknown], [right]: [string, unknown]) => left < right ? -1 : left > right ? 1 : 0
function canonicalEvidence(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalEvidence).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>).filter(([key]) => key !== 'signature_base64').sort(compareCodeUnits).map(([key, item]) => `${JSON.stringify(key)}:${canonicalEvidence(item)}`).join(',')}}`
  return JSON.stringify(value) ?? 'null'
}

/** Verify the production capability document at the runtime trust boundary. */
export function validateProductionCapabilityEvidenceTrust(document: unknown, source: Readonly<Record<string, string | undefined>>, trust: ProductionCapabilityEvidenceTrust): string[] {
  if (!document || typeof document !== 'object' || Array.isArray(document)) return ['document must be a JSON object']
  const value = document as Record<string, unknown>
  const errors: string[] = []
  const expected: Record<string, string | undefined> = {
    release_id: source.RELEASE_ID?.trim(),
    image_set_digest: source.RELEASE_IMAGE_SET_DIGEST?.trim(),
    manifest_sha256: source.RELEASE_MANIFEST_SHA256?.trim(),
    release_git_sha: source.RELEASE_GIT_SHA?.trim(),
    key_id: trust.trustedKeyId.trim(),
  }
  for (const [field, wanted] of Object.entries(expected)) {
    if (!wanted || value[field] !== wanted) errors.push(`${field} must match the running release`)
  }
  if (value.environment !== 'production') errors.push('environment must be production')
  if (value.simulated !== false) errors.push('simulated must be false')
  if (!/^[A-Za-z0-9_-]{22,128}$/u.test(String(value.deployment_nonce ?? ''))) errors.push('deployment_nonce is invalid')
  const signature = value.signature_base64
  if (typeof signature !== 'string' || !/^[A-Za-z0-9+/]{86}==$/u.test(signature)) errors.push('signature_base64 is invalid')
  else {
    try {
      const key = createPublicKey(trust.publicKeyPem)
      if (key.asymmetricKeyType !== 'ed25519' || !verify(null, Buffer.from(canonicalEvidence(value)), key, Buffer.from(signature, 'base64'))) errors.push('signature_base64 is invalid')
    } catch { errors.push('trusted public key or signature is invalid') }
  }
  return errors
}

export function advanceCapabilityEvidence(current: CapabilityEvidence, next: CapabilityEvidenceState, proof: Partial<CapabilityEvidence> = {}): CapabilityEvidence {
  const currentIndex = order.indexOf(current.state)
  const nextIndex = order.indexOf(next)
  if (nextIndex < 0 || nextIndex > currentIndex + 1) throw new Error(`capability evidence cannot skip from ${current.state} to ${next}`)
  if (nextIndex > currentIndex && (!proof.evidenceRef || !proof.verifiedBy || !proof.verifiedAt)) throw new Error('capability advancement requires evidenceRef, verifiedBy and verifiedAt')
  return { ...current, ...proof, state: next }
}

export function isProductionCanaryReady(evidence: readonly CapabilityEvidence[], platform: Platform): boolean {
  const required: CapabilityName[] = ['authorize', 'read', 'full_sync', 'incremental_sync', 'create', 'update', 'query_status', 'revoke', 'media_upload']
  return required.every(capability => evidence.some(item => item.platform === platform && item.capability === capability && item.state === 'production_canary'))
}
