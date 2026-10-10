import { describe, expect, it } from 'vitest'
import {
  clearRecycleMaterialRecords,
  merchantMaterialStorageScope,
  materialStorageKeys,
  recycleExpiryLabel,
  readRecycleMaterials,
  readRecycleMaterialsWithStatus,
  readRemovedMaterialIds,
  writeRecycleMaterials,
  writeRemovedMaterialIds,
} from './App.js'

const scope = { accountId: 'merchant one', workspaceId: 'ws-a' }
const other = { accountId: 'merchant two', workspaceId: 'ws-a' }
const record = (id: string, expiresAt = new Date(Date.now() + 60_000).toISOString()) => ({
  id, name: `material-${id}`, category: '未分类', series: '未分类', sizeLabel: '未读取', fileSizeLabel: '1 KB',
  format: 'PNG', addedAt: '2026-09-29', downloadUrl: '', assetId: id, storeId: '', storeName: '未归属',
  platform: '未归属', deletedAt: '2026-09-29T00:00:00.000Z', expiresAt,
})
const memoryStorage = () => {
  const values = new Map<string, string>()
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) },
  }
}

describe('merchant material browser storage isolation', () => {
  it('derives local storage scope only from the authenticated merchant workspace grant', () => {
    const merchant = { id: 'account-7', accountType: 'merchant', workspaceIds: ['ws-a', 'ws-b'] } as never
    const platform = { id: 'platform-1', accountType: 'platform', workspaceIds: ['ws-a'] } as never
    expect(merchantMaterialStorageScope(merchant, '')).toBeNull()
    expect(merchantMaterialStorageScope(merchant, 'ws-b')).toEqual({ accountId: 'account-7', workspaceId: 'ws-b' })
    expect(merchantMaterialStorageScope(merchant, 'ws-other')).toBeNull()
    expect(merchantMaterialStorageScope(platform, 'ws-a')).toBeNull()
  })

  it('namespaces each account and workspace and fails closed without scope', () => {
    expect(materialStorageKeys(scope)).not.toEqual(materialStorageKeys(other))
    expect(materialStorageKeys(null)).toBeNull()
    const storage = memoryStorage()
    writeRemovedMaterialIds(null, ['secret-id'], storage)
    expect(readRemovedMaterialIds(null, storage)).toEqual([])
    expect(storage.values.size).toBe(0)
  })

  it('keeps removed ids, restore, clear, and expiry consistent', () => {
    const storage = memoryStorage()
    writeRecycleMaterials(scope, [record('restore'), record('clear'), record('expire', '2020-01-01T00:00:00Z')], storage)
    writeRemovedMaterialIds(scope, ['restore', 'clear', 'expire'], storage)

    expect(readRecycleMaterials(scope, Date.now(), storage).map(({ id }) => id)).toEqual(['restore', 'clear'])
    expect(readRemovedMaterialIds(scope, storage)).toEqual(['restore', 'clear'])

    const restored = clearRecycleMaterialRecords(scope, ['restore'], storage)
    expect(restored.items.map(({ id }) => id)).toEqual(['clear'])
    expect(readRemovedMaterialIds(scope, storage)).toEqual(['clear'])

    const cleared = clearRecycleMaterialRecords(scope, ['clear'], storage)
    expect(cleared.items).toEqual([])
    expect(readRemovedMaterialIds(scope, storage)).toEqual([])
  })

  it('does not surface another tenant, malformed records, or duplicate hidden ids', () => {
    const storage = memoryStorage()
    writeRecycleMaterials(scope, [record('same'), { id: 'broken' } as never], storage)
    writeRecycleMaterials(other, [record('other')], storage)
    writeRemovedMaterialIds(scope, ['same', 'same', 3 as never], storage)
    expect(readRecycleMaterials(scope, Date.now(), storage).map(({ id }) => id)).toEqual(['same'])
    expect(readRemovedMaterialIds(scope, storage)).toEqual(['same'])
    expect(readRecycleMaterials(other, Date.now(), storage).map(({ id }) => id)).toEqual(['other'])
  })

  it('fails closed when browser storage throws', () => {
    const unavailable = { getItem: () => { throw new Error('storage unavailable') }, setItem: () => { throw new Error('storage unavailable') } }
    expect(readRecycleMaterials(scope, Date.now(), unavailable)).toEqual([])
    expect(readRemovedMaterialIds(scope, unavailable)).toEqual([])
    expect(() => writeRecycleMaterials(scope, [record('a')], unavailable)).not.toThrow()
    expect(() => writeRemovedMaterialIds(scope, ['a'], unavailable)).not.toThrow()
  })

  it('never leaves a removed id hidden when recycle cleanup cannot persist', () => {
    const storage = memoryStorage()
    writeRecycleMaterials(scope, [record('still-visible')], storage)
    writeRemovedMaterialIds(scope, ['still-visible'], storage)
    const keys = materialStorageKeys(scope)!
    const partialFailure = {
      getItem: storage.getItem,
      setItem: (key: string, value: string) => {
        if (key === keys.recycle) throw new Error('quota exceeded')
        storage.setItem(key, value)
      },
    }
    const result = clearRecycleMaterialRecords(scope, ['still-visible'], partialFailure)
    expect(result.success).toBe(false)
    expect(readRemovedMaterialIds(scope, storage)).toEqual([])
    expect(readRecycleMaterials(scope, Date.now(), storage).map(({ id }) => id)).toEqual(['still-visible'])
  })

  it('keeps expired recovery rows visible until hidden-id cleanup persists', () => {
    const storage = memoryStorage()
    const expired = record('expired-but-hidden', '2020-01-01T00:00:00Z')
    writeRecycleMaterials(scope, [expired], storage)
    writeRemovedMaterialIds(scope, [expired.id], storage)
    const keys = materialStorageKeys(scope)!
    const partialFailure = {
      getItem: storage.getItem,
      setItem: (key: string, value: string) => {
        if (key === keys.removed) throw new Error('quota exceeded')
        storage.setItem(key, value)
      },
    }

    const result = readRecycleMaterialsWithStatus(scope, Date.now(), partialFailure)
    expect(result.items.map(({ id }) => id)).toEqual([expired.id])
    expect(result.expiryCleanupFailed).toBe(true)
    expect(readRemovedMaterialIds(scope, storage)).toEqual([expired.id])
    expect(readRecycleMaterials(scope, Date.now(), storage).map(({ id }) => id)).toEqual([])
    expect(readRemovedMaterialIds(scope, storage)).toEqual([])
  })

  it('does not report an expiry cleanup warning after successful cleanup', () => {
    const storage = memoryStorage()
    writeRecycleMaterials(scope, [record('expired', '2020-01-01T00:00:00Z')], storage)
    writeRemovedMaterialIds(scope, ['expired'], storage)

    expect(readRecycleMaterialsWithStatus(scope, Date.now(), storage)).toEqual({ items: [], expiryCleanupFailed: false })
  })

  it('shows the server expiry date with its remaining-time status', () => {
    const expiry = '2030-05-06T00:00:00Z'
    const formattedDate = new Date(expiry).toLocaleDateString('zh-CN')
    expect(recycleExpiryLabel(expiry)).toContain(`保留至 ${formattedDate}（剩余 `)
    expect(recycleExpiryLabel('2020-01-01T00:00:00Z')).toContain('到期（已过期）')
    expect(recycleExpiryLabel('not-a-date')).toBe('到期时间无效')
  })
})
