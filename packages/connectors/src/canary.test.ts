import { describe, expect, it } from 'vitest'
import { createFakeConnector, runPlatformCanary } from './index.js'

describe('platform canary runner', () => {
  it('does not promote a fixture or disabled write/revoke run to production_canary', async () => {
    const result = await runPlatformCanary({
      connector: createFakeConnector('taobao', { configured: true, allowFakeWrites: true }),
      context: { workspaceId: 'ws_canary', accountId: 'acct_canary' },
      evidenceRef: 'artifact://canary/test', verifiedBy: 'qa', apiVersion: 'fixture', scope: 'fixture', allowWrite: false, allowRevoke: false,
    })
    expect(result.passed).toBe(false)
    expect(result.evidence.every(item => item.state !== 'production_canary')).toBe(true)
    expect(result.checks.find(item => item.capability === 'create')?.detail).toContain('write canary disabled')
  })

  it('requires non-simulated write and query evidence even when fixture operations succeed', async () => {
    const result = await runPlatformCanary({
      connector: createFakeConnector('jd', { configured: true, allowFakeWrites: true }),
      context: { workspaceId: 'ws_canary', accountId: 'acct_canary' },
      evidenceRef: 'artifact://canary/fixture', verifiedBy: 'qa', apiVersion: 'fixture', scope: 'fixture', allowWrite: true, allowRevoke: true,
    })
    expect(result.passed).toBe(false)
    expect(result.checks.filter(item => ['create', 'update', 'query_status'].includes(item.capability)).some(item => item.simulated)).toBe(true)
  })
})
