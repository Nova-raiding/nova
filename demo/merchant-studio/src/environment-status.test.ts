import { describe, expect, it } from 'vitest'
import type { ApiHealth, PlatformModelStatus } from './api.js'
import { resolveMerchantEnvironmentStatus } from './environment-status.js'

const readyModel: PlatformModelStatus = { state: 'ready' }

function health(overrides: Partial<ApiHealth> = {}): ApiHealth {
  return {
    status: 'ok',
    writesEnabled: true,
    connectors: {},
    setup: { mode: 'production', productionGate: true },
    ...overrides,
  }
}

describe('merchant environment status', () => {
  it('never presents a fixture environment as online even when its model relay is ready', () => {
    const result = resolveMerchantEnvironmentStatus({
      apiConfigured: true,
      apiOnline: true,
      health: health({
        writesEnabled: false,
        setup: {
          mode: 'fixture',
          productionGate: false,
          nextActions: ['配置真实平台 OAuth 后重新检查'],
        },
      }),
      modelStatus: readyModel,
      modelStatusRead: true,
    })

    expect(result).toMatchObject({
      state: 'demo',
      tone: 'warning',
      topbarPrefix: '系统状态',
      topbarLabel: '演示环境',
      title: '演示环境 · 不可上线',
    })
    expect(result.detail).toContain('环境模式：fixture')
    expect(result.detail).toContain('写入能力：已关闭')
    expect(result.detail).toContain('生产门禁：未通过')
    expect(result.detail).toContain('不代表生产就绪')
    expect(result.detail).not.toContain('模型中转已就绪')
    expect(result.nextActions).toEqual(['配置真实平台 OAuth 后重新检查'])
  })

  it('shows an explicit launch block for a non-fixture environment with a failed production gate', () => {
    const result = resolveMerchantEnvironmentStatus({
      apiConfigured: true,
      apiOnline: true,
      health: health({ setup: { mode: 'production', productionGate: false } }),
      modelStatus: readyModel,
      modelStatusRead: true,
    })

    expect(result.state).toBe('blocked')
    expect(result.topbarLabel).toBe('不可上线')
    expect(result.detail).toContain('生产门禁：未通过')
  })

  it('fails closed when the health response omits write or production-gate evidence', () => {
    const result = resolveMerchantEnvironmentStatus({
      apiConfigured: true,
      apiOnline: true,
      health: { status: 'ok', connectors: {}, setup: { mode: 'production' } },
      modelStatus: readyModel,
      modelStatusRead: true,
    })

    expect(result.state).toBe('checking')
    expect(result.topbarLabel).toBe('待确认')
    expect(result.detail).toContain('不会显示生产在线')
  })

  it('only reports online after production, write, and model gates all pass', () => {
    const result = resolveMerchantEnvironmentStatus({
      apiConfigured: true,
      apiOnline: true,
      health: health(),
      modelStatus: readyModel,
      modelStatusRead: true,
    })

    expect(result).toMatchObject({
      state: 'ready',
      tone: 'ready',
      topbarPrefix: '系统健康',
      topbarLabel: '在线',
      title: '生产环境已就绪',
    })
  })
})
