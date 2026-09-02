import { describe, expect, it } from 'vitest'
import { advanceCapabilityEvidence, isProductionCanaryReady, type CapabilityEvidence } from './capability-evidence.js'
import { validateConnectorReadiness } from './readiness.js'
import type { HttpConnectorConfig } from './types.js'

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

  it('does not treat malformed or future attribution as readiness evidence', () => {
    const capabilities = ['authorize', 'read', 'full_sync', 'incremental_sync', 'create', 'update', 'query_status', 'revoke', 'media_upload'] as const
    const config: HttpConnectorConfig = {
      clientId: 'jd-client',
      oauth: { authorizeUrl: 'https://jd.test/a', tokenUrl: 'https://jd.test/t' },
      api: { baseUrl: 'https://jd.test/api', syncPath: '/sync', createPath: '/create', updatePath: '/update', queryPath: '/query' },
      signer: { kind: 'platform' as const, sign: async () => ({}) },
      mapProducts: (() => []) as HttpConnectorConfig['mapProducts'],
      mapWriteReceipt: (() => undefined) as unknown as HttpConnectorConfig['mapWriteReceipt'],
      mapWriteStatus: (() => undefined) as unknown as HttpConnectorConfig['mapWriteStatus'],
      mappingEvidence: { version: 'v1', evidenceRef: 'artifact://mapping', verifiedBy: 'qa', verifiedAt: '2999-01-01T00:00:00Z' },
      capabilityEvidence: capabilities.map(capability => ({ platform: 'jd' as const, capability, state: 'test_e2e' as const, evidenceRef: 'artifact://capability', verifiedBy: 'qa', verifiedAt: '2999-01-01T00:00:00Z' })),
    }
    const result = validateConnectorReadiness('jd', config)
    expect(result.ready).toBe(false)
    expect(result.reasons).toContain('MAPPING_EVIDENCE_MISSING')
    expect(result.reasons).toContain('CAPABILITY_EVIDENCE_UNATTRIBUTED')
  })
})
