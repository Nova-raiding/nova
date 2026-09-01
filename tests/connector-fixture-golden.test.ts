import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { profiles, type Platform, type RawProduct } from '../packages/connectors/src/index.js'

const rawFixture = JSON.parse(readFileSync(new URL('./fixtures/connectors/raw-products.fixture.json', import.meta.url), 'utf8')) as Record<Platform, RawProduct>
const goldenFixture = JSON.parse(readFileSync(new URL('./fixtures/connectors/canonical-products.golden.fixture.json', import.meta.url), 'utf8')) as Record<Platform, unknown>
const platforms = Object.keys(profiles) as Platform[]
const rawKeys = ['remoteId', 'title', 'description', 'price', 'stock', 'sku', 'images', 'category', 'attributes', 'platformFields', 'observedAt']
const canonicalKeys = ['platform', 'remoteId', 'title', 'description', 'price', 'stock', 'sku', 'images', 'category', 'facts', 'mappingVersion', 'source', 'listingStatus', 'platformUpdatedAt', 'rawPlatformFields']

describe('technical solution connector fixtures', () => {
  it.each(platforms)('%s raw fixture has a closed field contract', platform => {
    expect(Object.keys(rawFixture[platform]).sort()).toEqual([...rawKeys].sort())
    expect(Object.keys(rawFixture[platform].platformFields).every(key => /^[A-Za-z][A-Za-z0-9]*$/u.test(key))).toBe(true)
    expect(rawFixture[platform].observedAt).toMatch(/^2026-08-22T00:00:00\.000Z$/u)
  })

  it.each(platforms)('%s maps exactly to the canonical golden fixture', platform => {
    const mapped = profiles[platform].mapProduct(rawFixture[platform], { id: 'technical-solution.fixture.v1' })
    expect(Object.keys(mapped).sort()).toEqual([...canonicalKeys].sort())
    expect(mapped).toEqual(goldenFixture[platform])
  })

  it.each(platforms)('%s is deterministic and replayable without mutating raw input', platform => {
    const firstRaw = structuredClone(rawFixture[platform])
    const secondRaw = structuredClone(rawFixture[platform])
    const first = profiles[platform].mapProduct(firstRaw, { id: 'technical-solution.fixture.v1' })
    const second = profiles[platform].mapProduct(secondRaw, { id: 'technical-solution.fixture.v1' })
    expect(second).toEqual(first)
    expect(firstRaw).toEqual(secondRaw)
    expect(first).not.toBe(second)
  })

  it.each(platforms)('%s writable fields reject fixture fields outside the profile whitelist', platform => {
    const profile = profiles[platform]
    const findings = profile.validateWrite({ fields: { ...Object.fromEntries(profile.writableFields.map(field => [field, field === 'price' || field === 'stock' ? 1 : 'fixture'])), platform_secret: 'must-not-write' }, idempotencyKey: `fixture-${platform}` })
    expect(findings).toContainEqual(expect.objectContaining({ field: 'platform_secret', code: 'NOT_ALLOWED', severity: 'error' }))
    expect(findings.filter(finding => finding.severity === 'error')).toHaveLength(1)
  })
})
