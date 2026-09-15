import { describe, expect, it } from 'vitest'
import type { ApiHealth, PlatformModelStatus } from './api'
import { resolveMerchantEnvironmentStatus } from './environment-status'

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

function resolve(apiHealth: ApiHealth) {
  return resolveMerchantEnvironmentStatus({
    apiBaseUrl: '/api',
    apiOnline: true,
    apiHealth,
    modelStatus: readyModel,
    modelStatusRead: true,
  })
}

describe('resolveMerchantEnvironmentStatus', () => {
  it('never presents fixture mode with closed writes and a failed gate as online', () => {
    const result = resolve(health({
      writesEnabled: false,
      setup: { mode: 'fixture', productionGate: false },
    }))

    expect(result).toMatchObject({
      state: 'demo',
      tone: 'warning',
      topbarLabel: '演示环境',
      title: '演示环境 · 不可上线',
    })
    expect(result.detail).toContain('外部平台写入已关闭')
    expect(result.detail).toContain('生产上线门禁未通过')
    expect(result.detail).toContain('不代表生产就绪')
    expect(`${result.title}${result.topbarLabel}`).not.toContain('在线')
  })

  it('blocks a production-shaped environment when the production gate fails', () => {
    const result = resolve(health({
      setup: { mode: 'production', productionGate: false },
    }))

    expect(result).toMatchObject({ state: 'blocked', tone: 'warning' })
    expect(result.title).toContain('不可上线')
  })

  it('fails closed when write or gate evidence is missing', () => {
    const result = resolve(health({
      writesEnabled: undefined,
      setup: { mode: 'production' },
    }))

    expect(result).toMatchObject({ state: 'blocked', tone: 'warning' })
    expect(result.detail).toContain('未返回外部写入能力证据')
    expect(result.detail).toContain('未返回生产上线门禁证据')
  })

  it('shows production ready only after all server gates pass', () => {
    const result = resolve(health())

    expect(result).toMatchObject({
      state: 'ready',
      tone: 'ready',
      topbarLabel: '生产就绪',
      title: '生产环境已就绪',
    })
  })
})
