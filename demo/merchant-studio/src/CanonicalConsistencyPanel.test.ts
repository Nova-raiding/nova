import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { CanonicalConsistencyPanel } from './CanonicalConsistencyPanel.js'
import type { ConsistencyItem } from './data-consistency.js'

const items: ConsistencyItem[] = [
  { id: 'products', label: '商品', status: 'amber', statusLabel: '标准链待处理', detail: '1 个商品的标准链尚未验证', nextStep: '打开商品关系并完成标准链核验' },
  { id: 'assets', label: '素材关系', status: 'green', detail: '已绑定', nextStep: '查看' },
]

describe('CanonicalConsistencyPanel', () => {
  it('exposes stale and actionable canonical state without a false green label', () => {
    const markup = renderToStaticMarkup(createElement(CanonicalConsistencyPanel, { items, freshness: 'expired', onRefresh: vi.fn() }))
    expect(markup).toContain('报告已过期')
    expect(markup).toContain('标准链待处理')
    expect(markup).toContain('下一步：打开商品关系并完成标准链核验')
    expect(markup).not.toContain('标准链已验证')
  })

  it('announces report errors and provides a recoverable action', () => {
    const markup = renderToStaticMarkup(createElement(CanonicalConsistencyPanel, { items, errorMessage: 'workspace snapshot unavailable', onRefresh: vi.fn() }))
    expect(markup).toContain('一致性报告读取失败')
    expect(markup).toContain('workspace snapshot unavailable')
    expect(markup).toContain('重新检查')
    expect(markup).toContain('role="alert" tabindex="-1"')
    expect(markup).toContain('aria-labelledby="canonical-error-title"')
    expect(markup).toContain('aria-describedby="canonical-error-description"')
    expect(markup).toContain('type="button"')
  })

  it('keeps the panel busy while refreshing and preserves trusted content', () => {
    const markup = renderToStaticMarkup(createElement(CanonicalConsistencyPanel, { items, refreshing: true, onRefresh: vi.fn() }))
    expect(markup).toContain('aria-busy="true"')
    expect(markup).toContain('当前工作区待处理：1 项')
    expect(markup).toContain('检查中…')
  })
})
