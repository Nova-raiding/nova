import { describe, expect, it } from 'vitest'
import {
  PLATFORM_CAPABILITY_CONTRACT_CAPABILITIES,
  PLATFORM_CAPABILITY_CONTRACT_PLATFORMS,
  runPlatformPreflight,
  validatePlatformCapabilityEvidence,
} from './platform-preflight.js'
import { officialHostsFor } from './outbound-security.js'

function evidence(state: string = 'production_canary') {
  return {
    schema_version: '1', release_id: 'release-preflight', environment: 'preproduction', generated_at: '2026-08-23T00:00:00.000Z',
    platforms: PLATFORM_CAPABILITY_CONTRACT_PLATFORMS.map(platform => ({
      platform, application_id: `${platform}-app`, test_store_id: `${platform}-store`,
      capabilities: Object.fromEntries(PLATFORM_CAPABILITY_CONTRACT_CAPABILITIES.map(capability => [capability, {
        state, evidence_ref: 'artifact://platform/preflight', verified_by: 'qa', verified_at: '2026-08-23T00:00:00.000Z', api_version: 'v1', scope: 'product.read product.write',
      }])),
    })),
  }
}

describe('platform capability preflight', () => {
  it('runs the complete no-credential fixture contract for all six platforms', async () => {
    const result = await runPlatformPreflight()
    expect(result.fixtureContractPassed).toBe(true)
    expect(result.platforms).toHaveLength(6)
    expect(result.platforms.flatMap(item => item.checks).filter(item => !item.passed)).toEqual([])
    expect(result.productionReady).toBe(false)
  })

  it('allowlists documented social API hosts without implying commerce readiness', () => {
    expect(officialHostsFor('xiaohongshu')).toContain('openaccount.xiaohongshu.com')
    expect(officialHostsFor('douyin')).toContain('open.douyin.com')
    expect(runPlatformPreflight).toBeTypeOf('function')
  })

  it('does not promote fixture evidence to production readiness', async () => {
    const result = await runPlatformPreflight({ evidence: evidence('fixture_verified'), requireProductionCanary: true })
    expect(result.fixtureContractPassed).toBe(true)
    expect(result.evidenceValid).toBe(true)
    expect(result.passed).toBe(false)
    expect(result.productionReady).toBe(false)
    expect(result.gaps).toContain('all nine capabilities lack production_canary evidence')
  })

  it('accepts a complete evidence matrix but still requires HTTP readiness', async () => {
    const result = await runPlatformPreflight({ evidence: evidence(), requireProductionCanary: true })
    expect(result.evidenceValid).toBe(true)
    expect(result.productionReady).toBe(false)
    expect(result.platforms.every(item => item.gaps.some(gap => gap.includes('HTTP connector config not supplied')))).toBe(true)
  })

  it('rejects invalid dates, placeholders and hidden secret fields at the production gate', () => {
    const value = evidence() as any
    value.generated_at = 'not-a-date'
    value.platforms[0].application_id = 'SET_JD_APPLICATION_ID'
    value.platforms[0].capabilities.read.access_token = 'must-not-be-present'
    const errors = validatePlatformCapabilityEvidence(value, { requireCanary: true })
    expect(errors).toContain('generated_at must be an ISO date')
    expect(errors).toContain('jd.application_id/test_store_id cannot be placeholders for production_canary')
    expect(errors.some(error => error.includes('secret-like field is not allowed'))).toBe(true)
  })

  it('rejects an incomplete or duplicated six-platform matrix', () => {
    const value = evidence() as any
    value.platforms = [value.platforms[0], value.platforms[0]]
    const errors = validatePlatformCapabilityEvidence(value)
    expect(errors).toContain('duplicate platform: jd')
    expect(errors).toContain('missing platform: taobao')
    expect(errors).toContain('missing platform: tmall')
    expect(errors).toContain('missing platform: pinduoduo')
    expect(errors).toContain('missing platform: xiaohongshu')
    expect(errors).toContain('missing platform: douyin')
  })
})
