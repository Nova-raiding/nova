import { describe, expect, it } from 'vitest'
import { DETAIL_SOP_STEPS, resolveDetailSopSteps } from './detail-sop'

const verifiedModule = (key: string) => ({ key, body: `${key} 已核验内容`, contentKind: 'fact', decisionContract: { buyerQuestion: `${key} 要回答的问题`, pageTask: `${key} 的页面任务`, optional: false, claim: { limitations: [], factSourceIds: ['fact:1'] }, evidence: { status: 'verified', sourceIds: ['evidence:1'] } } })

describe('detail page SOP navigation', () => {
  it('keeps the eight buyer questions in the prescribed order', () => {
    expect(DETAIL_SOP_STEPS.map(step => step.key)).toEqual(['hero', 'material', 'result', 'experience', 'compatibility', 'specification', 'scene', 'summary'])
    expect(resolveDetailSopSteps([], '锅具').map(step => step.position)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
  })
  it('surfaces evidence state without turning absent modules into success', () => {
    const steps = resolveDetailSopSteps([verifiedModule('hero')], '锅具')
    expect(steps[0]).toMatchObject({ disposition: 'ready', evidenceStatus: 'verified', statusLabel: '可展示 · 证据已验证' })
    expect(steps[1]).toMatchObject({ disposition: 'pending', evidenceStatus: 'pending', statusLabel: '待生成' })
  })
  it('matches service semantic module keys to the cookware buyer-question rhythm', () => {
    const steps = resolveDetailSopSteps([
      verifiedModule('hero'),
      verifiedModule('details_craft'),
      verifiedModule('selling_points'),
      verifiedModule('specifications'),
      verifiedModule('usage_scenarios'),
      verifiedModule('cta'),
    ], '炒锅')

    expect(steps.map(step => step.disposition)).toEqual([
      'ready', 'ready', 'ready', 'pending', 'pending', 'ready', 'ready', 'ready',
    ])
    expect(steps.map(step => step.evidenceStatus)).toEqual([
      'verified', 'verified', 'verified', 'pending', 'pending', 'verified', 'verified', 'verified',
    ])
  })
  it('keeps blocked module recovery visible to the desktop reviewer', () => {
    const module = { ...verifiedModule('result'), contentKind: 'pending', body: '[待确认] 缺少烹饪结果' }
    const result = resolveDetailSopSteps([module], '锅具')[2]
    expect(result).toMatchObject({ disposition: 'blocked', evidenceStatus: 'pending', statusLabel: '已阻断 · 证据待确认' })
    expect(result.statusDetail).toContain('正文已隐藏')
  })
  it('shows the real evidence-backed modules for apparel instead of cookware questions', () => {
    const steps = resolveDetailSopSteps([
      { ...verifiedModule('hero'), title: '首屏卖点' },
      { ...verifiedModule('size_guide'), title: '尺码选择' },
    ], '运动鞋')
    expect(steps.map(step => step.key)).toEqual(['hero', 'size_guide'])
    expect(steps.map(step => step.label)).toEqual(['首屏卖点', '尺码选择'])
    expect(steps.map(step => step.question)).toEqual(['hero 要回答的问题', 'size_guide 要回答的问题'])
    expect(steps.every(step => step.evidenceStatus === 'verified')).toBe(true)
  })
  it('keeps the fixed eight-screen rhythm for cookware only', () => {
    expect(resolveDetailSopSteps([], '炒锅').map(step => step.key)).toEqual(DETAIL_SOP_STEPS.map(step => step.key))
    expect(resolveDetailSopSteps([], '运动鞋')).toEqual([])
    expect(resolveDetailSopSteps([])).toEqual([])
  })
})
