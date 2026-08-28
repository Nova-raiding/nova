import { describe, expect, it } from 'vitest'
import { resolveStoreSyncTargets } from '../../demo/merchant-studio/src/store-sync'

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
