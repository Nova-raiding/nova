import { describe, expect, it } from 'vitest'
import { canonicalProductActionAllowed, groupTasksForRecovery, prioritizeProducts } from './merchant-ia.js'
import type { Product, Task } from './api.js'

const product = (overrides: Partial<Product>): Product => ({
  id: 'p-1', workspaceId: 'w-1', platform: 'taobao', storeName: '南风旗舰店',
  accountId: 'shop-1', title: '棉麻衬衫', skuCount: 1, stock: 20,
  factsConfirmed: false, source: 'connector', updatedAt: '2026-08-30T10:00:00Z', ...overrides,
})

const task = (overrides: Partial<Task>): Task => ({
  id: 't-1', workspaceId: 'w-1', productId: 'p-1', platform: 'taobao', state: 'direction_selected',
  version: 1, createdAt: '2026-08-30T10:00:00Z', accountId: 'shop-1', ...overrides,
})

describe('merchant IA contracts', () => {
  it('blocks real product actions until the server verifies the canonical chain', () => {
    expect(canonicalProductActionAllowed({ apiConfigured: true })).toBe(false)
    expect(canonicalProductActionAllowed({ apiConfigured: true, status: 'legacy_only' })).toBe(false)
    expect(canonicalProductActionAllowed({ apiConfigured: true, status: 'verified' })).toBe(true)
    expect(canonicalProductActionAllowed({ apiConfigured: false })).toBe(true)
  })
  it('deduplicates by platform/store/listing and prioritizes usable real products', () => {
    const result = prioritizeProducts([
      product({ id: 'fixture-1', remoteId: 'listing-1', source: 'fixture', storeName: '演示店铺', accountId: 'shop-1' }),
      product({ id: 'real-1', remoteId: 'listing-1', source: 'connector', factsConfirmed: true }),
      product({ id: 'real-2', remoteId: 'listing-2', source: 'connector', accountId: undefined, storeName: '未知店铺' }),
    ])
    expect(result).toHaveLength(2)
    expect(result[0].id).toBe('real-1')
    expect(result[1].id).toBe('real-2')
  })

  it('puts blockers first and gives each recovery row one clear action', () => {
    const result = groupTasksForRecovery([
      task({ id: 'done', state: 'delivered', createdAt: '2026-08-30T12:00:00Z' }),
      task({ id: 'ready', state: 'direction_selected', createdAt: '2026-08-30T11:00:00Z' }),
      task({ id: 'blocked', state: 'failed_recoverable', createdAt: '2026-08-30T09:00:00Z' }),
    ])
    expect(result.map(item => item.task.id)).toEqual(['blocked', 'ready', 'done'])
    expect(result.map(item => item.actionLabel)).toEqual(['恢复任务', '恢复任务', '恢复任务'])
  })
})
