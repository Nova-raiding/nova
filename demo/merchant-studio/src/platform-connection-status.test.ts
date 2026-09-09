import { describe, expect, it } from 'vitest'
import { isRealReadableStore, merchantConnectionPresentation } from './platform-connection-status'

describe('merchant connection presentation', () => {
  it('does not expose fixture accounts as real readable stores', () => {
    expect(merchantConnectionPresentation({ state: 'fixture_ready', readEnabled: true })).toEqual({ status: '演示连接', tone: 'amber', sync: '仅查看演示', canSync: false, canReauthorize: false })
    expect(merchantConnectionPresentation({ state: 'connected', readEnabled: true, dataMode: 'fixture', authorization: { state: 'fixture' } })).toEqual({ status: '演示连接', tone: 'amber', sync: '仅查看演示', canSync: false, canReauthorize: false })
  })

  it('distinguishes a configured account from a readable store', () => {
    expect(merchantConnectionPresentation({ state: 'connected', readEnabled: false })).toMatchObject({ status: '仅有账号记录', sync: '需重新授权', canSync: false, canReauthorize: true })
    expect(merchantConnectionPresentation({ state: 'connected', readEnabled: true })).toMatchObject({ status: '可读取', sync: '可同步', canSync: true, canReauthorize: false })
  })

  it('does not count readable fixture metrics as real connected stores', () => {
    expect(isRealReadableStore({ readable: true, state: 'fixture', dataMode: 'fixture' })).toBe(false)
    expect(isRealReadableStore({ readable: true, state: 'connected', dataMode: 'fixture' })).toBe(false)
    expect(isRealReadableStore({ readable: true, state: 'connected', dataMode: 'official_api' })).toBe(true)
    expect(isRealReadableStore({ readable: false, state: 'connected', dataMode: 'official_api' })).toBe(false)
  })

  it('uses explicit non-technical labels for unavailable states', () => {
    expect(merchantConnectionPresentation({ state: 'not_configured', readEnabled: false })).toMatchObject({ status: '平台暂未配置', sync: '暂不可读取', canSync: false })
    expect(merchantConnectionPresentation({ state: 'revoked', readEnabled: false })).toMatchObject({ status: '已撤销', canReauthorize: true })
  })
})
