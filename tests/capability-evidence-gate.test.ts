import { describe, expect, it } from 'vitest'
import { REQUIRED_CAPABILITIES, REQUIRED_PLATFORMS, validateCapabilityEvidence } from './capability-evidence-gate.js'

function document(state: string = 'production_canary') {
  return {
    schema_version: '1', release_id: 'release-1', environment: 'preproduction', generated_at: '2026-08-23T00:00:00Z',
    platforms: REQUIRED_PLATFORMS.map(platform => ({ platform, application_id: `${platform}-app`, test_store_id: `${platform}-store`, capabilities: Object.fromEntries(REQUIRED_CAPABILITIES.map(capability => [capability, { state, evidence_ref: 'artifact://evidence/1', verified_by: 'qa', verified_at: '2026-08-23T00:00:00Z', api_version: 'v1', scope: 'product.read product.write' }])) })),
  }
}

describe('capability evidence gate', () => {
  it('accepts a complete production canary matrix', () => expect(validateCapabilityEvidence(document(), { requireCanary: true })).toEqual([]))
  it('rejects a missing platform and incomplete capability evidence', () => {
    const value = document('test_e2e') as any
    value.platforms = value.platforms.slice(0, 3)
    delete value.platforms[0].capabilities.update.evidence_ref
    expect(validateCapabilityEvidence(value, { requireCanary: true }).some(error => error.includes('missing platform: pinduoduo'))).toBe(true)
    expect(validateCapabilityEvidence(value).some(error => error.includes('update.evidence_ref'))).toBe(true)
  })
  it('rejects secret-like evidence fields', () => {
    const value = document() as any
    value.platforms[0].capabilities.read.access_token = 'never-store-this'
    expect(validateCapabilityEvidence(value)).toContain('evidence document must not contain secret-like keys or values')
  })
  it('binds evidence to the release being deployed', () => {
    expect(validateCapabilityEvidence(document(), { expectedReleaseId: 'release-2' })).toContain('release_id must match release-2')
  })
  it('requires a production environment and strict evidence timestamps for canary promotion', () => {
    const value = document() as any
    value.environment = 'local'
    value.generated_at = '2026-08-23'
    expect(validateCapabilityEvidence(value, { requireCanary: true })).toEqual(expect.arrayContaining([
      'environment must be preproduction or production for production_canary',
      'generated_at must be an ISO date',
    ]))
  })
  it('rejects a capability verified after the evidence document was generated', () => {
    const value = document() as any
    value.platforms[0].capabilities.read.verified_at = '2026-08-24T00:00:00Z'
    expect(validateCapabilityEvidence(value)).toContain('jd.read.verified_at cannot be after generated_at')
  })
  it('rejects placeholders inside a canary capability record', () => {
    const value = document() as any
    value.platforms[0].capabilities.read.scope = 'SET_SCOPE_FROM_PLATFORM'
    expect(validateCapabilityEvidence(value)).toContain('jd.read contains a placeholder production_canary field')
  })
  it('reports malformed platform entries without throwing', () => {
    const value = document() as any
    value.platforms[0] = null
    expect(validateCapabilityEvidence(value)).toContain('platform entry must be an object')
  })
})
