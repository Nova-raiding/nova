import { describe, expect, it } from 'vitest'
import { advanceCapabilityEvidence, isProductionCanaryReady, type CapabilityEvidence } from './capability-evidence.js'

describe('platform capability evidence', () => {
  it('requires sequential, attributable proof', () => {
    const base: CapabilityEvidence = { platform: 'jd', capability: 'authorize', state: 'unverified' }
    expect(() => advanceCapabilityEvidence(base, 'test_e2e', { evidenceRef: 'e1', verifiedBy: 'qa', verifiedAt: '2026-08-22T00:00:00Z' })).toThrow('cannot skip')
    const documented = advanceCapabilityEvidence(base, 'documented', { evidenceRef: 'e1', verifiedBy: 'pm', verifiedAt: '2026-08-22T00:00:00Z' })
    expect(documented.state).toBe('documented')
    expect(() => advanceCapabilityEvidence(documented, 'fixture_verified')).toThrow('requires evidenceRef')
  })

  it('does not mark a platform ready from partial evidence', () => {
    const evidence: CapabilityEvidence[] = [{ platform: 'taobao', capability: 'authorize', state: 'production_canary' }]
    expect(isProductionCanaryReady(evidence, 'taobao')).toBe(false)
  })
})
