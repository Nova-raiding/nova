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

  it.each([
    {
      caseName: 'fixture mode',
      apiHealth: health({ setup: { mode: 'fixture', productionGate: true } }),
      expectedState: 'demo',
      evidence: '当前是本地演示环境',
    },
    {
      caseName: 'failed production gate',
      apiHealth: health({ setup: { mode: 'production', productionGate: false } }),
      expectedState: 'blocked',
      evidence: '生产上线门禁未通过',
    },
    {
      caseName: 'closed external writes',
      apiHealth: health({
        writesEnabled: false,
        setup: { mode: 'production', productionGate: true },
      }),
      expectedState: 'blocked',
      evidence: '外部平台写入已关闭',
    },
  ] as const)('blocks production readiness when only $caseName is unmet', ({
    apiHealth,
    expectedState,
    evidence,
  }) => {
    const result = resolve(apiHealth)

    expect(result).toMatchObject({ state: expectedState, tone: 'warning' })
    expect(result.title).toContain('不可上线')
    expect(result.detail).toContain(evidence)
    expect(result.topbarLabel).not.toBe('生产就绪')
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
