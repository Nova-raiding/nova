import { describe, expect, it } from 'vitest'
import { defaultRuleCenterSeeds, RuleCenter } from './rule-center.js'
import { platformRuleSyncStatus } from './platform-rule-sync.js'

describe('platform rule sync status', () => {
  it('reports missing trusted manifest configuration fail-closed', () => {
    const rules = new RuleCenter(() => '2026-08-26T00:00:00.000Z', defaultRuleCenterSeeds.map(seed => ({ ...seed, source: { ...seed.source, kind: 'official' as const, trust: 'verified' as const, reference: seed.source.reference.replace('manual://', 'manifest://') } }))).list()
    const result = platformRuleSyncStatus(rules, { now: '2026-08-26T12:00:00.000Z' })
    expect(result).toHaveLength(6)
    expect(result.every(item => item.state === 'not_configured' && item.configured === false)).toBe(true)
  })

  it('detects stale platform packs individually', () => {
    const rules = new RuleCenter(() => '2026-08-26T00:00:00.000Z', defaultRuleCenterSeeds.map(seed => ({ ...seed, source: { ...seed.source, kind: 'official' as const, trust: 'verified' as const, reference: seed.source.reference.replace('manual://', 'manifest://') } }))).list()
    const result = platformRuleSyncStatus(rules, { now: '2026-08-26T12:00:00.000Z', intervalHours: 24, manifestUrl: 'https://rules.example/manifest.json', signingSecretConfigured: true })
    expect(result.find(item => item.platform === 'douyin')).toMatchObject({ state: 'ready', latestVersion: 'douyin-content-1.0.0' })
    expect(result.find(item => item.platform === 'jd')).toMatchObject({ state: 'stale', stale: true })
  })

  it('finds a signed public rule that carries its platform only in scopeValue', () => {
    // Regression guard. `PostgresRuleRepository.listPublic` reads the shared
    // platform table as `NULL::text AS target_id, platform AS scope_value`, and
    // `rulePackProjection` carries scopeValue through — so a signed manifest
    // import reaches this function with scopeValue set and NO targetId. That is
    // the exact opposite of what the API fixture builds (it seeded `targetId`),
    // which is why the suite stayed green while every production platform
    // reported `not_configured` after a successful import and the generation
    // preflight 503'd every request.
    const publicProjection = defaultRuleCenterSeeds
      .filter(seed => seed.targetId === 'taobao')
      .map(seed => ({
        ...seed,
        targetId: undefined,
        scopeValue: 'taobao',
        // Pin the freshness so this test can only fail on the platform match,
        // which is the regression under guard.
        source: { ...seed.source, kind: 'official' as const, trust: 'verified' as const, reference: seed.source.reference.replace('manual://', 'manifest://'), checkedAt: '2026-08-26T06:00:00.000Z' },
      }))
    const rules = new RuleCenter(() => '2026-08-26T00:00:00.000Z', publicProjection).list()
    const result = platformRuleSyncStatus(rules, { now: '2026-08-26T12:00:00.000Z', intervalHours: 24, manifestUrl: 'https://rules.example/manifest.json', signingSecretConfigured: true })
    expect(result.find(item => item.platform === 'taobao')).toMatchObject({ state: 'ready', configured: true })
  })

  it('treats an approved operator upload as ready without manifest configuration', () => {
    const rules = [{
      id: 'manual-public', name: '拼多多人工规则', version: '2026.09', scope: 'platform' as const,
      status: 'active' as const, targetId: 'pinduoduo', updatedAt: '2026-08-26T06:00:00.000Z',
      source: { kind: 'internal' as const, reference: 'manual://rules.md#PDD-1', checkedAt: '2026-08-26T06:00:00.000Z', trust: 'verified' as const },
      checksum: 'a'.repeat(64), revision: 2, checks: {},
    }]
    const result = platformRuleSyncStatus(rules, { now: '2026-08-26T12:00:00.000Z', intervalHours: 24 })
    expect(result.find(item => item.platform === 'pinduoduo')).toMatchObject({ state: 'ready', configured: true, latestVersion: '2026.09' })
  })

  it('does not treat an unapproved manual upload as usable policy', () => {
    const rules = [{
      id: 'manual-draft', name: '拼多多人工草稿', version: '2026.10', scope: 'platform' as const,
      status: 'active' as const, targetId: 'pinduoduo', updatedAt: '2026-08-26T06:00:00.000Z',
      source: { kind: 'internal' as const, reference: 'manual://rules.md#PDD-2', checkedAt: '2026-08-26T06:00:00.000Z', trust: 'unverified' as const },
      checksum: 'b'.repeat(64), revision: 1, checks: {},
    }]
    const result = platformRuleSyncStatus(rules, { now: '2026-08-26T12:00:00.000Z' })
    expect(result.find(item => item.platform === 'pinduoduo')).toMatchObject({ state: 'not_configured', configured: false, latestVersion: null })
  })

  it('does not treat inactive platform packs as usable rule data', () => {
    const rules = new RuleCenter(() => '2026-08-26T00:00:00.000Z', defaultRuleCenterSeeds.map(seed => ({
      ...seed,
      status: seed.targetId === 'taobao' ? 'inactive' as const : seed.status,
      source: { ...seed.source, kind: 'official' as const, trust: 'verified' as const, reference: seed.source.reference.replace('manual://', 'manifest://') },
    }))).list({ includeInactive: true })
    const result = platformRuleSyncStatus(rules, { now: '2026-08-26T12:00:00.000Z', intervalHours: 24, manifestUrl: 'https://rules.example/manifest.json', signingSecretConfigured: true })
    expect(result.find(item => item.platform === 'taobao')).toMatchObject({ state: 'not_configured', configured: true, latestVersion: null, sourceCheckedAt: null, reason: '尚未导入可验证的淘宝平台规则，商户与插件不能消费该平台规则' })
  })
})
