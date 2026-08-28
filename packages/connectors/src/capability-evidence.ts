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
