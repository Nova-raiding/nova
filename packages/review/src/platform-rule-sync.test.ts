import { describe, expect, it } from 'vitest'
import { defaultRuleCenterSeeds, RuleCenter } from './rule-center.js'
import { platformRuleSyncStatus } from './platform-rule-sync.js'

describe('platform rule sync status', () => {
  it('reports missing trusted manifest configuration fail-closed', () => {
    const rules = new RuleCenter(() => '2026-08-26T00:00:00.000Z', defaultRuleCenterSeeds.map(seed => ({ ...seed, source: { ...seed.source, reference: seed.source.reference.replace('manual://', 'manifest://') } }))).list()
    const result = platformRuleSyncStatus(rules, { now: '2026-08-26T12:00:00.000Z' })
    expect(result).toHaveLength(6)
    expect(result.every(item => item.state === 'not_configured' && item.configured === false)).toBe(true)
  })

  it('detects stale platform packs individually', () => {
    const rules = new RuleCenter(() => '2026-08-26T00:00:00.000Z', defaultRuleCenterSeeds.map(seed => ({ ...seed, source: { ...seed.source, reference: seed.source.reference.replace('manual://', 'manifest://') } }))).list()
    const result = platformRuleSyncStatus(rules, { now: '2026-08-26T12:00:00.000Z', intervalHours: 24, manifestUrl: 'https://rules.example/manifest.json', signingSecretConfigured: true })
    expect(result.find(item => item.platform === 'douyin')).toMatchObject({ state: 'ready', latestVersion: 'douyin-content-1.0.0' })
    expect(result.find(item => item.platform === 'jd')).toMatchObject({ state: 'stale', stale: true })
  })

  it('does not treat inactive platform packs as usable rule data', () => {
    const rules = new RuleCenter(() => '2026-08-26T00:00:00.000Z', defaultRuleCenterSeeds.map(seed => ({
      ...seed,
      status: seed.targetId === 'taobao' ? 'inactive' as const : seed.status,
      source: { ...seed.source, reference: seed.source.reference.replace('manual://', 'manifest://') },
    }))).list({ includeInactive: true })
    const result = platformRuleSyncStatus(rules, { now: '2026-08-26T12:00:00.000Z', intervalHours: 24, manifestUrl: 'https://rules.example/manifest.json', signingSecretConfigured: true })
    expect(result.find(item => item.platform === 'taobao')).toMatchObject({ state: 'not_configured', configured: true, latestVersion: null, sourceCheckedAt: null, reason: '尚未导入可验证的淘宝平台规则，商户与插件不能消费该平台规则' })
  })
})
