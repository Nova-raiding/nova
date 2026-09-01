import { describe, expect, it } from 'vitest'
import { capabilitiesForRoles, canonicalizeRole, resolveCanonicalRoles } from './authz.js'

describe('authorization role source boundary', () => {
  it('never derives a platform operations role from workspace membership', () => {
    expect(canonicalizeRole('platform_ops', 'membership')).toBeUndefined()
    expect(resolveCanonicalRoles({ memberRole: 'platform_ops' })).toEqual([])
  })

  it('continues to accept platform operations roles from the authenticated gateway', () => {
    expect(canonicalizeRole('platform_ops', 'gateway')).toBe('ops_admin')
    expect(resolveCanonicalRoles({ gatewayRoles: ['platform_ops'] })).toEqual(['ops_admin'])
    expect(capabilitiesForRoles(['ops_admin'])).toContain('platform.summary.read')
  })
})
