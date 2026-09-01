import { describe, expect, it } from 'vitest'
import { resolveStoreSyncTargets } from '../../demo/merchant-studio/src/store-sync'
import { storeIdentityLabel, validateProductStoreIdentity, validateTargetStoreIdentity, validateTaskStoreIdentity } from '../../demo/merchant-studio/src/store-identity'
import { resolveLibraryData } from '../../demo/merchant-studio/src/library-data'
import { resolveTaskDirections, resolveTaskWorkflow } from '../../demo/merchant-studio/src/task-evidence'

describe('Merchant Studio server-owned task evidence', () => {
  const serverDirection = { id: 'KITCHEN-TRUTH', name: '收纳动线说明', coreIdea: '只描述收纳用途', structure: '问题到方案', copyDirection: '事实说明', visualDirection: '真实商品图', sellingPoints: ['分区收纳'], fitReason: '商品事实', risk: '避免扩展材质功效' }

  it('uses only server directions in API mode and keeps missing states explicit', () => {
    expect(resolveTaskDirections({ baseUrl: '/api', remote: [serverDirection], error: '' })).toEqual({ mode: 'api_ready', items: [serverDirection] })
    expect(resolveTaskDirections({ baseUrl: '/api', remote: [], error: '' })).toEqual({ mode: 'api_empty', items: [] })
    expect(resolveTaskDirections({ baseUrl: '/api', remote: null, error: '方向服务不可用' })).toEqual({ mode: 'api_error', items: [] })
  })

  it('keeps demo directions explicit and offline-only', () => {
    const result = resolveTaskDirections({ baseUrl: undefined, remote: null, error: '' })
    expect(result.mode).toBe('offline_demo')
    expect(result.items.every(item => item.id.startsWith('DEMO-') && item.name.startsWith('演示 ·'))).toBe(true)
  })

  it('derives workflow progress from the server task state', () => {
    expect(resolveTaskWorkflow('draft')).toEqual([
      { label: '事实确认', status: 'current' },
      { label: '方向选择', status: 'pending' },
      { label: '内容审核', status: 'pending' },
      { label: '确认发布', status: 'pending' },
    ])
    expect(resolveTaskWorkflow('delivered').every(step => step.status === 'complete')).toBe(true)
    expect(resolveTaskWorkflow('future_server_state').every(step => step.status === 'pending')).toBe(true)
  })
})

describe('Merchant Studio rule and category data isolation', () => {
  const fixtures = [{ id: 'demo' }]
  const remote = [{ id: 'api' }]

  it('uses fixtures only when no API base URL is configured', () => {
    expect(resolveLibraryData({ baseUrl: undefined, remote: null, error: '', fixtures })).toEqual({
      mode: 'offline_demo',
      items: fixtures,
    })
  })

  it('does not expose fixtures while an API request is loading or failed', () => {
    expect(resolveLibraryData({ baseUrl: '/api', remote: null, error: '', fixtures })).toEqual({ mode: 'loading', items: [] })
    expect(resolveLibraryData({ baseUrl: '/api', remote: null, error: '服务不可用', fixtures })).toEqual({ mode: 'api_error', items: [] })
  })

  it('keeps a successful API empty response distinct and accepts only API data when present', () => {
    expect(resolveLibraryData({ baseUrl: '/api', remote: [], error: '', fixtures })).toEqual({ mode: 'api_empty', items: [] })
    expect(resolveLibraryData({ baseUrl: '/api', remote, error: '', fixtures })).toEqual({ mode: 'api_ready', items: remote })
  })
})

describe('Merchant Studio store sync target resolution', () => {
  it('returns every readable store instead of selecting the first store on a platform', () => {
    const result = resolveStoreSyncTargets([
      { platform: 'taobao', accountId: 'store-a', label: '淘宝 A 店', state: 'connected', readEnabled: true, writeEnabled: true },
      { platform: 'taobao', accountId: 'store-b', label: '淘宝 B 店', state: 'connected', readEnabled: true, writeEnabled: true },
      { platform: 'jd', accountId: 'store-c', label: '京东 C 店', state: 'connected', readEnabled: true, writeEnabled: true },
      { platform: 'douyin', accountId: 'store-d', label: '未授权店', state: 'revoked', readEnabled: false, writeEnabled: false },
    ])

    expect(result).toEqual({
      ok: true,
      targets: [
        { platform: 'taobao', accountId: 'store-a', label: '淘宝 A 店' },
        { platform: 'taobao', accountId: 'store-b', label: '淘宝 B 店' },
        { platform: 'jd', accountId: 'store-c', label: '京东 C 店' },
      ],
    })
  })

  it('fails closed when store discovery has not succeeded', () => {
    expect(resolveStoreSyncTargets(null)).toEqual({
      ok: false,
      message: '店铺列表尚未读取成功，已停止同步。请先重试店铺发现。',
    })
  })

  it('fails closed when a readable store has no stable account id', () => {
    const result = resolveStoreSyncTargets([
      { platform: 'taobao', label: '身份不完整店铺', state: 'connected', readEnabled: true, writeEnabled: true },
    ])

    expect(result).toEqual({
      ok: false,
      message: '发现 1 家可读取店铺缺少店铺 ID，已停止全部同步，避免同步到错误店铺。',
    })
  })

  it('fails closed when no authorized readable stores exist', () => {
    const result = resolveStoreSyncTargets([
      { platform: 'jd', accountId: 'revoked-store', state: 'revoked', readEnabled: false, writeEnabled: false },
    ])

    expect(result).toEqual({
      ok: false,
      message: '没有发现已授权且可读取的店铺，未发起任何同步。',
    })
  })
})

describe('Merchant Studio store identity safety', () => {
  const target = { accountId: 'store-a', storeName: '淘宝 A 店' }

  it('accepts a complete identity that remains consistent across product and task', () => {
    expect(validateTargetStoreIdentity(target)).toBeNull()
    expect(validateProductStoreIdentity(target, target)).toBeNull()
    expect(validateTaskStoreIdentity(target, { accountId: 'store-a' })).toBeNull()
    expect(storeIdentityLabel(target)).toBe('淘宝 A 店 · 店铺身份已确认')
  })

  it('fails closed for missing identity fields', () => {
    expect(validateTargetStoreIdentity({ storeName: '淘宝 A 店' })).toContain('缺少完整店铺身份')
    expect(validateProductStoreIdentity(target, { storeName: '淘宝 A 店' })).toContain('商品事实缺少完整店铺身份')
    expect(validateTaskStoreIdentity(target, {})).toContain('任务缺少稳定的店铺身份')
  })

  it('fails closed for product or task identity mismatches', () => {
    expect(validateProductStoreIdentity(target, { accountId: 'store-b', storeName: '淘宝 B 店' })).toContain('店铺身份与最新商品事实不一致')
    expect(validateProductStoreIdentity(target, { accountId: 'store-a', storeName: '淘宝 A 店（旧名）' })).toContain('店铺身份与最新商品事实不一致')
    expect(validateTaskStoreIdentity(target, { accountId: 'store-b' })).toContain('任务店铺账号与所选商品不一致')
  })
})
