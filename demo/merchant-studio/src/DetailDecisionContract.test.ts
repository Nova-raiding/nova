import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  DetailDecisionContract,
} from './DetailDecisionContract'
import {
  moduleDecisionContract,
  type DecisionEvidenceStatus,
  type DetailPageDecisionContract,
} from './detail-decision-contract'

const contract = (
  status: DecisionEvidenceStatus,
  limitations: string[] = ['仅适用于已确认 SKU', '不代表所有炉具均适用'],
): DetailPageDecisionContract => ({
  buyerQuestion: '我家厨房能不能使用？',
  pageTask: '说明适配范围并降低确认成本',
  claim: { limitations },
  evidence: { status },
})

describe('DetailDecisionContract', () => {
  it('renders the buyer question, page task, and limitations as readable structure', () => {
    const markup = renderToStaticMarkup(createElement(DetailDecisionContract, {
      contract: contract('verified'),
    }))

    expect(markup).toContain('aria-label="详情页决策合同"')
    expect(markup).toContain('<dt>买家问题</dt>')
    expect(markup).toContain('我家厨房能不能使用？')
    expect(markup).toContain('<dt>页面任务</dt>')
    expect(markup).toContain('说明适配范围并降低确认成本')
    expect(markup).toContain('<ul>')
    expect(markup).toContain('仅适用于已确认 SKU')
    expect(markup).toContain('不代表所有炉具均适用')
  })

  it.each([
    ['verified', '证据状态：已验证', '证据已通过当前合同校验'],
    ['missing', '证据状态：缺少证据', '证据不完整，当前内容不能据此确认'],
    ['expired', '证据状态：证据已过期', '需要更新证据后重新校验'],
    ['conflict', '证据状态：证据冲突', '证据之间存在冲突，需要人工处理'],
  ] as const)(
    'exposes %s with visible status text instead of color alone',
    (status, label, detail) => {
      const markup = renderToStaticMarkup(createElement(DetailDecisionContract, {
        contract: contract(status),
      }))

      expect(markup).toContain(`data-evidence-status="${status}"`)
      expect(markup).toContain(label)
      expect(markup).toContain(detail)
      expect(markup).toContain('aria-hidden="true"')
    },
  )

  it('states when the contract has no recorded limitations', () => {
    const markup = renderToStaticMarkup(createElement(DetailDecisionContract, {
      contract: contract('verified', []),
    }))
    expect(markup).toContain('当前合同未记录限制条件')
  })

  it('does not invent a decision contract when the module has none', () => {
    expect(moduleDecisionContract({ key: 'hero' })).toBeNull()
    expect(moduleDecisionContract({
      decisionContract: {
        buyerQuestion: '是否适用？',
        pageTask: '解释适用范围',
        claim: { limitations: [] },
        evidence: { status: 'unknown' },
      },
    })).toBeNull()
    expect(
      renderToStaticMarkup(createElement(DetailDecisionContract, { contract: null })),
    ).toBe('')
  })
})
