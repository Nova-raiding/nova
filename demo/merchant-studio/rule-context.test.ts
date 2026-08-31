import { describe, expect, it } from 'vitest'
import { resolveRuleContext } from './src/rule-context.js'

describe('merchant rule context', () => {
  it('uses the selected platform and keeps store identity visible', () => {
    expect(resolveRuleContext({ platform: 'taobao', storeName: '淘宝 A 店', accountId: 'store-a' })).toEqual({ platform: 'taobao', label: 'taobao · 淘宝 A 店（店铺身份已确认）' })
  })

  it('does not invent a platform or store when no target exists', () => {
    expect(resolveRuleContext()).toEqual({ platform: 'all', label: '全部平台 · 未选择店铺' })
  })
})
