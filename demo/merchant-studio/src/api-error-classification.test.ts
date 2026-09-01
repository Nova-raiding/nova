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
    expect(describeApiError(apiError('jd OAuth missing', 'NOT_CONFIGURED', 503))).toContain('该平台尚未配置')
  })

  it('gives a safe recovery path for closed MCP transports and unknown 503 responses', () => {
    expect(describeApiError(apiError('Transport closed', undefined, 503))).toContain('大麦连接已中断')
    expect(describeApiError(apiError('upstream unavailable', undefined, 503))).toContain('服务暂不可用')
  })
})
