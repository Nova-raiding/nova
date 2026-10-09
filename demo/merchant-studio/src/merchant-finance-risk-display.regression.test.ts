import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { fillMonthlyFinancePoints, financeUsageRangeError } from './finance-window.js'
import { resolveIssueReadState } from './issue-read-state.js'
import { IssueNotificationPanel } from './App.js'
import type { WorkspaceMetrics } from './api.js'

describe('merchant finance and risk display boundaries', () => {
  it('rejects reverse chronological day and month ranges without changing valid open ranges', () => {
    expect(financeUsageRangeError({ mode: 'day', start: '2026-10-12', end: '2026-10-11' })).toBe('开始日期不能晚于结束日期。')
    expect(financeUsageRangeError({ mode: 'month', start: '2026-11', end: '2026-10' })).toBe('开始日期不能晚于结束日期。')
    expect(financeUsageRangeError({ mode: 'day', start: '2026-10-12', end: '' })).toBe('')
    expect(financeUsageRangeError({ mode: 'month', start: '', end: '2026-10' })).toBe('')
  })

  it('fills missing months only inside the bounded range and keeps observed month totals', () => {
    expect(fillMonthlyFinancePoints([
      { label: '2026/01', dateLabel: '2026/01', value: 8 },
      { label: '2026/03', dateLabel: '2026/03', value: 3 },
    ], '2026-01', '2026-04')).toEqual([
      { label: '2026/01', dateLabel: '2026/01', value: 8 },
      { label: '2026/02', dateLabel: '2026-02', value: 0 },
      { label: '2026/03', dateLabel: '2026/03', value: 3 },
      { label: '2026/04', dateLabel: '2026-04', value: 0 },
    ])
  })

  it('does not invent a complete trend for an empty, partial, or excessively wide source', () => {
    expect(fillMonthlyFinancePoints([], '2026-01', '2026-03')).toEqual([])
    const points = [{ label: '2026/01', dateLabel: '2026/01', value: 8 }]
    expect(fillMonthlyFinancePoints(points, '2026-01', '2037-01')).toEqual(points)
  })

  it('distinguishes a truncated actionable page from a complete risk count', () => {
    const issue = { severity: 'high', type: 'LOW_STOCK', title: '库存不足', platform: 'taobao', status: 'low_stock', nextAction: '核实库存' }
    const read = resolveIssueReadState({ baseUrl: '/api', items: [issue] as WorkspaceMetrics['riskItems'], error: '', loading: false, truncated: true })
    expect(read).toMatchObject({ count: 1, truncated: true, ariaLabel: '工作区待处理问题，至少 1 项，列表已截断' })
    expect(read.notice).toContain('完整数量未知')
    const html = renderToStaticMarkup(createElement(IssueNotificationPanel, {
      state: read,
      items: [issue] as WorkspaceMetrics['riskItems'],
      onOpenIssue: () => undefined,
      onClose: () => undefined,
      onRetry: () => undefined,
    }))
    expect(html).toContain('至少 1 项需要关注，列表已截断')
  })

  it('does not claim that a truncated empty page proves there are no actionable risks', () => {
    const read = resolveIssueReadState({ baseUrl: '/api', items: [], error: '', loading: false, truncated: true })
    expect(read.count).toBe(0)
    expect(read.notice).toContain('列表已截断')
    expect(read.ariaLabel).toContain('列表已截断，当前页无可处理项')
  })
})
