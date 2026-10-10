import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { campaignGenerationFailureMessage, campaignGenerationOutcomeUnknown } from './campaign-generation-outcome.js'

const app = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')

describe('campaign generation failure classification', () => {
  it.each([
    ['timeout', { code: 'API_REQUEST_TIMEOUT' }],
    ['closed transport', { code: 'MCP_TRANSPORT_CLOSED' }],
    ['network failure', new TypeError('connection reset')],
    ['server failure', { status: 503, code: 'INTERNAL_ERROR' }],
    ['explicit unknown result', { status: 409, details: { outcome: 'unknown' } }],
    ['reconciliation required', { status: 409, details: { reconciliation_required: true } }],
  ])('marks %s as requiring reconciliation', (_label, error) => {
    expect(campaignGenerationOutcomeUnknown(error)).toBe(true)
  })

  it.each([
    ['facts gate', { status: 409, code: 'PRODUCT_FACTS_CONFIRMATION_REQUIRED' }],
    ['permission denial', { status: 403, code: 'FORBIDDEN' }],
    ['invalid request', { status: 400, code: 'INVALID_REQUEST' }],
  ])('recognizes %s as a confirmed server rejection', (_label, error) => {
    expect(campaignGenerationOutcomeUnknown(error)).toBe(false)
  })

  it('keeps uncertain and rejected recovery instructions distinct', () => {
    const uncertain = campaignGenerationFailureMessage('campaign-1', 'API 请求超时', true)
    expect(uncertain).toContain('结果尚未确认')
    expect(uncertain).toContain('刷新并读取该计划状态')
    expect(uncertain).toContain('核对当前计划和目标范围')
    expect(uncertain).not.toContain('系统会复用')
    const rejected = campaignGenerationFailureMessage('campaign-1', '商品事实未确认', false)
    expect(rejected).toContain('请求被服务端拒绝')
    expect(rejected).toContain('目标身份变化可能形成不同计划')
  })

  it('returns after a generate failure so it cannot be overwritten by the empty-result branch', () => {
    const createGroup = app.slice(app.indexOf('const createGroup = async () =>'), app.indexOf('const checkImages = async (productId'))
    expect(createGroup).toContain('if (generationFailed)')
    expect(createGroup).toContain('campaignGenerationFailureMessage')
    expect(createGroup.indexOf('return')).toBeLessThan(createGroup.indexOf('const generatedState'))
  })
})
