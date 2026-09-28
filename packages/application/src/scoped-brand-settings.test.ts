import { describe, expect, it } from 'vitest'
import { parseScopedBrandSettings, resolveScopedBrandValues, type ScopedBrandBindings } from './scoped-brand-settings.js'

const bindings: ScopedBrandBindings = {
  accountIds: new Set(['store-a']),
  seriesKeysByAccount: new Map([['store-a', new Set(['autumn'])]]),
  assetIds: new Set(['logo-a', 'image-a', 'doc-a']),
  imageAssetIds: new Set(['logo-a', 'image-a']),
  usableReferenceAssetIds: new Set(['logo-a', 'doc-a']),
}

describe('scoped brand settings', () => {
  it('resolves global, store, series and image in order only with explicit bindings', () => {
    const settings = parseScopedBrandSettings({ schemaVersion: 1,
      global: { enabled: true, values: { color: '#AABBCC', persona: '全局受众', sellingPoints: '全局卖点' } },
      stores: { 'store-a': { enabled: true, values: { persona: '店铺受众' } } },
      series: { 'store-a': { autumn: { enabled: true, values: { sellingPoints: '秋季卖点' } } } },
      images: { 'image-a': { enabled: true, values: { color: '#112233' } } },
    }, bindings)
    expect(resolveScopedBrandValues(settings, {})).toEqual({ color: '#aabbcc', persona: '全局受众', sellingPoints: '全局卖点' })
    expect(resolveScopedBrandValues(settings, { accountId: 'store-a', seriesKey: 'autumn', assetId: 'image-a' })).toEqual({ color: '#112233', persona: '店铺受众', sellingPoints: '秋季卖点' })
    expect(resolveScopedBrandValues(settings, { seriesKey: 'autumn', assetId: 'image-a' })).toEqual({ color: '#112233', persona: '全局受众', sellingPoints: '全局卖点' })
  })

  it('rejects foreign store and asset references before persistence', () => {
    expect(() => parseScopedBrandSettings({ schemaVersion: 1, stores: { foreign: { enabled: true, values: {} } } }, bindings)).toThrow(/店铺不存在/)
    expect(() => parseScopedBrandSettings({ schemaVersion: 1, images: { foreign: { enabled: true, values: {} } } }, bindings)).toThrow(/图片不存在/)
    expect(() => parseScopedBrandSettings({ schemaVersion: 1, images: { 'doc-a': { enabled: true, values: {} } } }, bindings)).toThrow(/图片不存在/)
    expect(() => parseScopedBrandSettings({ schemaVersion: 1, series: { 'store-a': { winter: { enabled: true, values: {} } } } }, bindings)).toThrow(/系列不存在/)
    expect(() => parseScopedBrandSettings({ schemaVersion: 1, global: { enabled: true, values: { logoAssetId: 'image-a' } } }, bindings)).toThrow(/尚未通过扫描/)
  })

  it('keeps disabled lower scopes from overriding inherited values', () => {
    const settings = parseScopedBrandSettings({ schemaVersion: 1,
      global: { enabled: true, values: { color: '#abcdef' } },
      stores: { 'store-a': { enabled: false, values: { color: '#123456' } } },
    }, bindings)
    expect(resolveScopedBrandValues(settings, { accountId: 'store-a' }).color).toBe('#abcdef')
  })

  it('rejects unversioned, unknown and prototype keys', () => {
    expect(() => parseScopedBrandSettings({ global: { enabled: true, values: {} } }, bindings)).toThrow(/版本/)
    expect(() => parseScopedBrandSettings({ schemaVersion: 1, localOnly: true }, bindings)).toThrow(/不支持/)
    expect(() => parseScopedBrandSettings(JSON.parse('{"schemaVersion":1,"stores":{"__proto__":{"enabled":true,"values":{}}}}'), bindings)).toThrow(/店铺 ID 无效|店铺 ID无效/)
  })
})
