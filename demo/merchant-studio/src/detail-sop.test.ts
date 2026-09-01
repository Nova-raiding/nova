import { describe, expect, it } from 'vitest'
import { DETAIL_SOP_STEPS, resolveDetailSopSteps } from './detail-sop'

const verifiedModule = (key: string) => ({ key, body: `${key} 已核验内容`, contentKind: 'fact', decisionContract: { buyerQuestion: `${key} 要回答的问题`, pageTask: `${key} 的页面任务`, optional: false, claim: { limitations: [], factSourceIds: ['fact:1'] }, evidence: { status: 'verified', sourceIds: ['evidence:1'] } } })

describe('detail page SOP navigation', () => {
  it('keeps the eight buyer questions in the prescribed order', () => {
    expect(DETAIL_SOP_STEPS.map(step => step.key)).toEqual(['hero', 'material', 'result', 'experience', 'compatibility', 'specification', 'scene', 'summary'])
    expect(resolveDetailSopSteps([]).map(step => step.position)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
  })
  it('surfaces evidence state without turning absent modules into success', () => {
    const steps = resolveDetailSopSteps([verifiedModule('hero')])
    expect(steps[0]).toMatchObject({ disposition: 'ready', evidenceStatus: 'verified', statusLabel: '可展示 · 证据已验证' })
    expect(steps[1]).toMatchObject({ disposition: 'pending', evidenceStatus: 'pending', statusLabel: '待生成' })
  })
  it('keeps blocked module recovery visible to the desktop reviewer', () => {
    const module = { ...verifiedModule('result'), contentKind: 'pending', body: '[待确认] 缺少烹饪结果' }
    const result = resolveDetailSopSteps([module])[2]
    expect(result).toMatchObject({ disposition: 'blocked', evidenceStatus: 'pending', statusLabel: '已阻断 · 证据待确认' })
    expect(result.statusDetail).toContain('正文已隐藏')
  })
})
