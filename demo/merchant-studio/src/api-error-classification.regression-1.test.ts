import { describe, expect, it } from 'vitest'
import { describeApiError } from './api.js'

// Regression: platform rule gates were incorrectly shown as a generic outage.
// Found by /qa on 2026-10-06
// Report: .gstack/qa-reports/qa-report-yxsona-com-2026-10-06.md
describe('platform rule generation gate classification', () => {
  it('tells the merchant to approve and activate platform rules', () => {
    const error = Object.assign(new Error('platform rules unavailable'), {
      code: 'PLATFORM_RULE_DATA_UNAVAILABLE',
      status: 503,
    })

    const message = describeApiError(error)
    expect(message).toContain('平台规则尚未完成审批或已过期')
    expect(message).toContain('独立审批、激活')
    expect(message).not.toContain('服务暂不可用')
  })
})
