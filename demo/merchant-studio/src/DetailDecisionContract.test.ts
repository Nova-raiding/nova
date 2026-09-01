import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { DetailDecisionContract } from './DetailDecisionContract'
import {
  evidenceSafeTopLevelContent,
  moduleDecisionContract,
  moduleDecisionPresentation,
  type DecisionEvidenceStatus,
  type DetailPageDecisionContract,
} from './detail-decision-contract'

const app = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')

const contract = (
  status: DecisionEvidenceStatus,
  input: { optional?: boolean; limitations?: string[] } = {},
): DetailPageDecisionContract => ({
  buyerQuestion: '我家厨房能不能使用？',
  pageTask: '说明适配范围并降低确认成本',
  claim: {
    limitations: input.limitations ?? ['仅适用于已确认 SKU', '不代表所有炉具均适用'],
  },
  evidence: { status },
  optional: input.optional ?? false,
})

const module = (
  status: DecisionEvidenceStatus,
  input: { optional?: boolean; limitations?: string[]; body?: string; contentKind?: string } = {},
) => ({
  key: 'compatibility',
  title: '适配说明',
  body: input.body ?? '燃气灶、电磁炉均可使用。',
  ...(input.contentKind ? { contentKind: input.contentKind } : {}),
  decisionContract: contract(status, input),
})

describe('DetailDecisionContract', () => {
  it('renders a ready contract with readable semantic structure', () => {
    const markup = renderToStaticMarkup(createElement(DetailDecisionContract, {
      module: module('verified'),
    }))

    expect(markup).toContain('aria-label="详情页决策合同：可展示 · 证据已验证"')
    expect(markup).toContain('data-disposition="ready"')
    expect(markup).toContain('<dt>买家问题</dt>')
    expect(markup).toContain('我家厨房能不能使用？')
    expect(markup).toContain('<dt>页面任务</dt>')
    expect(markup).toContain('说明适配范围并降低确认成本')
    expect(markup).toContain('<ul>')
    expect(markup).toContain('仅适用于已确认 SKU')
    expect(markup).not.toContain('aria-label="恢复提示"')
  })

  it('omits optional missing body without presenting omission as verified', () => {
    const presentation = moduleDecisionPresentation(module('missing', { optional: true }))
    const markup = renderToStaticMarkup(createElement(DetailDecisionContract, {
      module: module('missing', { optional: true }),
    }))

    expect(presentation).toMatchObject({ disposition: 'omitted', bodyVisible: false })
    expect(markup).toContain('data-disposition="omitted"')
    expect(markup).toContain('展示状态：已省略 · 可选证据缺失')
    expect(markup).toContain('省略不代表已验证')
    expect(markup).toContain('role="note" aria-label="恢复提示"')
    expect(markup).toContain('补充并验证证据后，可恢复正文展示。')
  })

  it.each([
    ['missing', '已阻断 · 必需证据缺失'],
    ['expired', '已阻断 · 证据已过期'],
    ['conflict', '已阻断 · 证据有冲突'],
  ] as const)(
    'blocks required %s content with visible status and recovery text',
    (status, label) => {
      const presentation = moduleDecisionPresentation(module(status))
      const markup = renderToStaticMarkup(createElement(DetailDecisionContract, {
        module: module(status),
      }))

      expect(presentation).toMatchObject({ disposition: 'blocked', bodyVisible: false })
      expect(markup).toContain('data-disposition="blocked"')
      expect(markup).toContain(`展示状态：${label}`)
      expect(markup).toContain('role="note" aria-label="恢复提示"')
      expect(markup).toContain('aria-hidden="true"')
      expect(markup).not.toContain('已确认事实')
    },
  )

  it('blocks pending content even when its stored evidence says verified', () => {
    expect(moduleDecisionPresentation(module('verified', {
      body: '[待确认] 等待材质报告。',
      contentKind: 'pending',
    }))).toMatchObject({
      disposition: 'blocked',
      evidenceStatus: 'pending',
      bodyVisible: false,
      label: '已阻断 · 证据待确认',
    })
  })

  it('shows legacy modules as migration review instead of facts', () => {
    const legacy = { key: 'legacy', title: '历史模块', body: '旧正文' }
    const presentation = moduleDecisionPresentation(legacy)
    const markup = renderToStaticMarkup(createElement(DetailDecisionContract, { module: legacy }))

    expect(presentation).toMatchObject({
      disposition: 'legacy_review_required',
      bodyVisible: false,
    })
    expect(markup).toContain('data-disposition="legacy_review_required"')
    expect(markup).toContain('展示状态：需迁移审核')
    expect(markup).toContain('不能视为已确认事实')
    expect(markup).toContain('补录买家问题、页面任务和证据后重新审核。')
    expect(moduleDecisionContract(legacy)).toBeNull()
  })

  it('does not expose top-level detail or selling points outside decision evidence', () => {
    const projection = evidenceSafeTopLevelContent({
      detail: '不应绕过合同展示的详情',
      sellingPoints: ['不应绕过合同展示的卖点'],
    })

    expect(projection).toEqual({
      detail: null,
      sellingPoints: [],
      suppressed: true,
      notice: '顶层详情和卖点未绑定逐项决策合同，已隐藏；请按下方详情模块审阅证据。',
    })
  })

  it('wires the desktop preview through the fail-closed evidence projection', () => {
    expect(app).toContain('evidenceSafeTopLevelContent(content?.body)')
    expect(app).toContain('decision.bodyVisible && <p>{module.body}</p>')
    expect(app).toContain('<DetailDecisionContract module={module} />')
    expect(app).toContain('顶层 detail/sellingPoints 未作为已验证内容展示')
    expect(app).not.toContain('content?.body.detail ??')
    expect(app).not.toContain('(content?.body.sellingPoints ?? []).map')
    expect(app).not.toContain(": '已确认事实'")
  })

  it('rejects malformed decision contracts instead of inventing a status', () => {
    expect(moduleDecisionContract({
      decisionContract: {
        buyerQuestion: '是否适用？',
        pageTask: '解释适用范围',
        claim: { limitations: [] },
        evidence: { status: 'unknown' },
        optional: false,
      },
    })).toBeNull()
  })
})
