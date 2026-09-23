import { describe, expect, it } from 'vitest'
import type { ApiHealth, PlatformModelStatus } from './api'
import { resolveMerchantEnvironmentStatus } from './environment-status'

const readyModel: PlatformModelStatus = { state: 'ready' }

function health(overrides: Partial<ApiHealth> = {}): ApiHealth {
  return {
    status: 'ok',
    writesEnabled: false,
    connectors: {},
    setup: {
      mode: 'production',
      productionGate: true,
      platformOperations: { mode: 'manual', ready: true, automatedWritesEnabled: false },
    },
    ...overrides,
  }
}

function resolve(apiHealth: ApiHealth, modelStatus: PlatformModelStatus | null = readyModel) {
  return resolveMerchantEnvironmentStatus({
    apiBaseUrl: '/api', apiOnline: true, apiHealth, modelStatus, modelStatusRead: true,
  })
}

describe('resolveMerchantEnvironmentStatus', () => {
  it('keeps fixture/manual as demo even when manual operations are expected', () => {
    const result = resolve(health({
      setup: {
        mode: 'fixture', productionGate: false,
        platformOperations: { mode: 'manual', ready: true, automatedWritesEnabled: false },
      },
    }))

    expect(result).toMatchObject({ state: 'demo', tone: 'warning', topbarLabel: '演示环境' })
    expect(result.detail).toContain('当前是本地演示模式')
    expect(result.facts.join('；')).not.toContain('人工运营')
    expect(result.actions.join('；')).not.toMatch(/授权|同步|OAuth/iu)
  })

  it('blocks production/manual when the production gate is false without treating manual writes as missing', () => {
    const result = resolve(health({
      setup: {
        mode: 'production', productionGate: false,
        platformOperations: { mode: 'manual', ready: true, automatedWritesEnabled: false },
      },
    }))

    expect(result).toMatchObject({ state: 'blocked', tone: 'warning', topbarLabel: '不可上线' })
    expect(result.detail).toContain('生产上线门禁未通过')
    expect(result.detail).not.toContain('外部平台写入已关闭')
    expect(result.actions.join('；')).not.toMatch(/授权|同步|OAuth/iu)
  })

  it('marks production/manual ready when gate and model pass while automated writes remain off', () => {
    const result = resolve(health())

    expect(result).toMatchObject({ state: 'ready', tone: 'ready', topbarLabel: '生产就绪' })
    expect(result.detail).toBe('生产上线门禁和模型中转已通过服务端检查。')
    expect(result.facts).toContain('自动平台写入：已关闭')
  })

  it('still blocks production/manual when the model relay is not ready', () => {
    const result = resolve(health(), { state: 'blocked' })

    expect(result).toMatchObject({ state: 'blocked', tone: 'warning' })
    expect(result.detail).toContain('模型中转未就绪')
  })

  it.each([
    { caseName: 'explicitly false', ready: false, evidence: '平台运营未就绪' },
    { caseName: 'missing', ready: undefined, evidence: '未返回平台运营就绪证据' },
  ] as const)('blocks production/manual when platform readiness is $caseName', ({ ready, evidence }) => {
    const result = resolve(health({
      setup: {
        mode: 'production', productionGate: true,
        platformOperations: { mode: 'manual', ready, automatedWritesEnabled: false },
      },
    }))

    expect(result).toMatchObject({ state: 'blocked', tone: 'warning' })
    expect(result.detail).toContain(evidence)
  })

  it('blocks a contradictory manual mode that advertises automated writes', () => {
    const result = resolve(health({
      writesEnabled: true,
      setup: {
        mode: 'production', productionGate: true,
        platformOperations: { mode: 'manual', ready: true, automatedWritesEnabled: true },
      },
    }))

    expect(result).toMatchObject({ state: 'blocked', tone: 'warning' })
    expect(result.detail).toContain('自动平台写入边界未确认')
  })

  it('fails closed for an unknown platform operations mode', () => {
    const result = resolve(health({
      writesEnabled: undefined,
      setup: { mode: 'production', productionGate: true, platformOperations: undefined },
    }))

    expect(result).toMatchObject({ state: 'blocked', tone: 'warning' })
    expect(result.detail).toContain('未返回可识别的平台运营模式')
    expect(result.topbarLabel).not.toBe('生产就绪')
  })

  it('fails closed for an unknown environment mode even when manual operations are ready', () => {
    const result = resolve(health({
      setup: {
        productionGate: true,
        platformOperations: { mode: 'manual', ready: true, automatedWritesEnabled: false },
      },
    }))

    expect(result).toMatchObject({ state: 'blocked', tone: 'warning' })
    expect(result.detail).toContain('未确认当前为生产环境')
  })

  it('keeps official API mode fail-closed without write evidence', () => {
    const result = resolve(health({
      writesEnabled: false,
      setup: {
        mode: 'production', productionGate: true,
        platformOperations: { mode: 'official_api', ready: false, automatedWritesEnabled: false },
      },
    }))

    expect(result).toMatchObject({ state: 'blocked', tone: 'warning' })
    expect(result.detail).toContain('官方接口写入已关闭')
    expect(result.detail).toContain('官方接口自动写入未就绪')
  })
})
