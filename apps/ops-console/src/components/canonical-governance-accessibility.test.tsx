import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { BrandGovernanceSummary } from './stores/BrandGovernanceSummary.js'
import { OpsPageError } from './OpsPageError.js'

describe('canonical governance empty and error accessibility', () => {
  it('renders an explicit empty state without inventing canonical counts', () => {
    const markup = renderToStaticMarkup(<BrandGovernanceSummary />)
    expect(markup).toContain('尚未取得平台品牌聚合数据')
    expect(markup).not.toContain('品牌数')
    expect(markup).not.toContain('ant-statistic-content')
  })

  it('keeps the error recovery control keyboard reachable and named', () => {
    const markup = renderToStaticMarkup(<OpsPageError error="canonical consistency service unavailable" onRetry={vi.fn()} />)
    expect(markup).toContain('role="alert"')
    expect(markup).toContain('aria-live="assertive"')
    expect(markup).toContain('aria-label="重试加载运营数据"')
    expect(markup).toMatch(/<button[^>]*aria-label="重试加载运营数据"[^>]*>/u)
    expect(markup).not.toMatch(/<button[^>]*tabindex="-1"/iu)
  })

  it('marks decorative governance icons as hidden from keyboard and assistive technology trees', () => {
    const markup = renderToStaticMarkup(<BrandGovernanceSummary summary={{ scope: 'platform', workspaceCount: 1, brandCount: 2, boundStoreCount: 1, unboundBrandCount: 0, canonicalProductCount: 3, listingCount: 2, workspaces: [] }} />)
    expect(markup).toContain('aria-hidden="true"')
    expect(markup).toContain('品牌治理聚合')
    expect(markup).toContain('刊登映射')
  })
})
