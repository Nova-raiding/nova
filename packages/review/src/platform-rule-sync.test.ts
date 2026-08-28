import { describe, expect, it } from 'vitest'
import { defaultRuleCenterSeeds, RuleCenter } from './rule-center.js'
import { platformRuleSyncStatus } from './platform-rule-sync.js'

describe('platform rule sync status', () => {
  it('reports missing trusted manifest configuration fail-closed', () => {
    const rules = new RuleCenter(() => '2026-08-26T00:00:00.000Z', defaultRuleCenterSeeds).list()
    const result = platformRuleSyncStatus(rules, { now: '2026-08-26T12:00:00.000Z' })
    expect(result).toHaveLength(6)
    expect(result.every(item => item.state === 'not_configured' && item.configured === false)).toBe(true)
  })

  it('detects stale platform packs individually', () => {
    const rules = new RuleCenter(() => '2026-08-26T00:00:00.000Z', defaultRuleCenterSeeds).list()
    const result = platformRuleSyncStatus(rules, { now: '2026-08-26T12:00:00.000Z', intervalHours: 24, manifestUrl: 'https://rules.example/manifest.json' })
    expect(result.find(item => item.platform === 'douyin')).toMatchObject({ state: 'ready', latestVersion: 'douyin-content-1.0.0' })
    expect(result.find(item => item.platform === 'jd')).toMatchObject({ state: 'stale', stale: true })
  })
})
