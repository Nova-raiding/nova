import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { WorkspaceDataIntegrityNotice } from './App'

const baseMetrics = {
  stores: [],
  productSummary: { total: 0, lowStock: 0, missingImages: 0 },
  riskSummary: { total: 0, returned: 0, truncated: false },
  riskItems: [],
  taskFunnel: {},
}

describe('WorkspaceDataIntegrityNotice', () => {
  it('explains partial durable data and fixture scope', () => {
    const html = renderToStaticMarkup(createElement(WorkspaceDataIntegrityNotice, { metrics: {
      ...baseMetrics,
      source: 'durable_repository', dataCompleteness: 'partial', hydration: { invalidSnapshotCount: 8 },
      dataCoverage: { products: 76, tasks: 145, syncJobs: 20, publishJobs: 0, fixtureDataPresent: true },
    } }))
    expect(html).toContain('总览不是完整快照')
    expect(html).toContain('无效持久化快照：8')
    expect(html).toContain('不代表真实平台生产数据')
  })

  it('stays hidden for complete non-fixture data', () => {
    const html = renderToStaticMarkup(createElement(WorkspaceDataIntegrityNotice, { metrics: {
      ...baseMetrics,
      source: 'durable_repository', dataCompleteness: 'complete', hydration: { invalidSnapshotCount: 0 },
      dataCoverage: { products: 1, tasks: 2, syncJobs: 3, publishJobs: 4, fixtureDataPresent: false },
    } }))
    expect(html).toBe('')
  })
})
