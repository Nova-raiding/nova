import { describe, expect, it } from 'vitest'
import { describeApiError, isNotConfigured } from './api.js'

function apiError(message: string, code: string | undefined, status: number) {
  return Object.assign(new Error(message), { code, status })
}

describe('merchant API error classification', () => {
  it('only treats the platform NOT_CONFIGURED contract as a platform configuration error', () => {
    expect(isNotConfigured(apiError('jd OAuth missing', 'NOT_CONFIGURED', 503))).toBe(true)
    expect(isNotConfigured(apiError('relay unavailable', 'MODEL_RELAY_NOT_CONFIGURED', 503))).toBe(false)
    expect(isNotConfigured(apiError('gateway unavailable', undefined, 503))).toBe(false)
  })

  it('keeps model relay failures separate from platform OAuth failures', () => {
    expect(describeApiError(apiError('No available channel', 'MODEL_RELAY_NO_CHANNEL', 503))).toContain('没有可用的中转通道')
    expect(describeApiError(apiError('relay unavailable', 'MODEL_RELAY_NOT_CONFIGURED', 503))).toContain('模型服务尚未就绪')
    expect(describeApiError(apiError('read unavailable', 'IMAGE_GENERATION_READ_UNAVAILABLE', 503))).toContain('read unavailable')
    expect(describeApiError(apiError('jd OAuth missing', 'NOT_CONFIGURED', 503))).toContain('该平台尚未配置')
  })

  it('keeps the task-list read recovery message when a task endpoint returns 503', () => {
    expect(describeApiError(apiError('内部错误', 'INTERNAL_ERROR', 503), { operation: 'read' })).toBe('读取暂不可用，请稍后重试。')
    expect(describeApiError(apiError('服务不可用', 'INTERNAL_ERROR', 503))).toContain('当前操作未确认完成')
    expect(describeApiError(apiError('标准商品事实不可用，已阻断任务读取', 'CANONICAL_TASK_READ_UNAVAILABLE', 503))).toBe('标准商品事实不可用，已阻断任务读取')
  })

  it('surfaces commercial entitlement gates instead of mislabeling them as outages', () => {
    const error = Object.assign(apiError('commercial access required', 'COMMERCIAL_ENTITLEMENT_UNAVAILABLE', 503), {
      details: { classification: 'POINT_REQUIRED_NO_CHARGE' },
    })
    expect(describeApiError(error)).toContain('不会扣费')
    expect(describeApiError(error)).not.toContain('服务暂不可用')
  })

  it('explains creative point upload gates in Chinese without reporting a service outage or success', () => {
    const unknown = describeApiError(apiError('creative points unavailable', 'CREATIVE_POINTS_UNAVAILABLE', 503))
    expect(unknown).toContain('余额尚未确认')
    expect(unknown).toContain('本次操作未完成')
    expect(unknown).toContain('财务与资源')
    expect(unknown).not.toContain('服务暂不可用')

    const insufficient = describeApiError(apiError('insufficient points', 'CREATIVE_POINTS_INSUFFICIENT', 402))
    expect(insufficient).toContain('可用创意点不足')
    expect(insufficient).toContain('本次操作未完成')
  })

  it('gives a safe recovery path for closed MCP transports and unknown 503 responses', () => {
    expect(describeApiError(apiError('Transport closed', undefined, 503))).toContain('Store Nova连接已中断')
    expect(describeApiError(apiError('upstream unavailable', undefined, 503))).toContain('服务暂不可用')
  })

  it('explains that an unknown provider outcome must be reconciled before retrying', () => {
    const message = describeApiError(apiError('provider result not confirmed', 'MODEL_PROVIDER_OUTCOME_UNKNOWN', 503))
    expect(message).toContain('先查询模型状态或提交人工对账')
    expect(message).toContain('不会重复生成、扣费或发布')
  })
})
