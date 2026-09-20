import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { IssueNotificationBell, IssueNotificationPanel } from './App'
import type { WorkspaceMetrics } from './api'
import { resolveIssueReadState } from './issue-read-state'

/**
 * The bell used to answer 「暂无」 to a question it never got an answer to.
 *
 * Live reproduction of the shipped build (500-ing API, real browser,
 * 2026-09-20): the bell read `aria-label="工作区待处理问题，暂无"`, carried no
 * badge, and its panel said 「暂无需要处理的问题」 — on a page whose 今日看板 said
 * 「未读取」 for the same read, whose 事务看板 said 「未读取 待处理 / 工作区事务尚未
 * 从服务端读取」, and which carried 「运营指标：stub 注入的 500」 and
 * 「规则版本读取失败」 inline errors. The catch clause threw the outcome away
 * (`.catch(() => setIssueMetrics(null))`) and the panel turned `null` into `[]`.
 *
 * These tests render the two components the topbar actually mounts, so the
 * wording is asserted where the merchant reads it rather than in a helper.
 */
type Risk = WorkspaceMetrics['riskItems'][number]

const risk = (overrides: Partial<Risk> = {}): Risk => ({
  severity: 'high',
  type: 'LOW_STOCK',
  title: '库存不足',
  platform: 'taobao',
  storeName: '淘宝 Fixture 店',
  status: 'low_stock',
  nextAction: '确认补货',
  ...overrides,
})

const state = (input: { baseUrl?: string; items?: Risk[] | null; error?: string; loading?: boolean }) =>
  resolveIssueReadState({ baseUrl: input.baseUrl, items: input.items ?? null, error: input.error ?? '', loading: input.loading ?? false })

const panel = (input: Parameters<typeof state>[0], items: Risk[] = []) =>
  renderToStaticMarkup(createElement(IssueNotificationPanel, {
    state: state(input),
    items,
    onOpenIssue: () => undefined,
    onClose: () => undefined,
    onRetry: () => undefined,
  }))

const bell = (input: Parameters<typeof state>[0]) => renderToStaticMarkup(createElement(IssueNotificationBell, { state: state(input) }))

describe('the bell never reports a count it did not read', () => {
  const failed = { baseUrl: '/api', items: null, error: 'stub 注入的 500', loading: false }

  it('reports a failed read as failed on the bell and in the panel', () => {
    expect(bell(failed)).toContain('工作区待处理问题，读取失败')
    expect(panel(failed)).toContain('工作区待处理问题读取失败：stub 注入的 500')
    expect(panel(failed)).toContain('重新读取')
  })

  it('never answers 暂无 to a read that failed, is pending, or has no API', () => {
    for (const input of [
      failed,
      { baseUrl: '/api', items: null, error: '', loading: true },
      { baseUrl: undefined, items: null, error: '', loading: false },
    ]) {
      expect(bell(input)).not.toContain('，暂无')
      expect(panel(input)).not.toContain('暂无需要处理的问题')
      // And it may not draw a zero either: `0` is a measurement.
      expect(panel(input)).not.toContain('0 项需要关注')
    }
  })

  it('keeps the four states apart instead of collapsing them into one empty panel', () => {
    expect(state({ baseUrl: undefined })).toMatchObject({ mode: 'unconfigured', count: null, badgeCount: undefined })
    expect(state({ baseUrl: '/api', loading: true })).toMatchObject({ mode: 'loading', count: null, badgeCount: undefined })
    expect(state({ baseUrl: '/api', error: '网络不可用' })).toMatchObject({ mode: 'read_error', count: null, badgeCount: undefined })
    expect(state({ baseUrl: '/api', items: [] })).toMatchObject({ mode: 'ready', count: 0, badgeCount: undefined })
    expect(state({ baseUrl: '/api', items: [risk()] })).toMatchObject({ mode: 'ready', count: 1, badgeCount: 1 })
  })

  it('still speaks for a read that answered', () => {
    // `[]` is a real answer, and 0 is allowed to be said then — and only then.
    expect(panel({ baseUrl: '/api', items: [] })).toContain('暂无需要处理的问题')
    expect(bell({ baseUrl: '/api', items: [] })).toContain('工作区待处理问题，暂无')
    const one = panel({ baseUrl: '/api', items: [risk()] }, [risk()])
    expect(one).toContain('库存不足')
    expect(one).toContain('1 项需要关注')
    expect(one).not.toContain('暂无需要处理的问题')
    expect(bell({ baseUrl: '/api', items: [risk()] })).toContain('工作区待处理问题，1 项')
  })

  it('keeps an unconfigured workspace out of the empty state as well', () => {
    expect(panel({ baseUrl: undefined })).toContain('未配置商家 API，工作区待处理问题未读取。')
    expect(bell({ baseUrl: undefined })).toContain('工作区待处理问题，未读取')
    expect(panel({ baseUrl: '/api', loading: true })).toContain('正在读取工作区待处理问题…')
  })

  it('shows the number through the resolved state only', () => {
    // The badge and the accessible name are the two places a number can escape.
    // Both must come from `IssueReadState`, never from the raw list length.
    const app = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')
    const bellSource = app.slice(app.indexOf('export function IssueNotificationBell'), app.indexOf('export function IssueNotificationPanel'))
    expect(bellSource.length).toBeGreaterThan(200)
    expect(bellSource).toContain('count={state.badgeCount}')
    expect(bellSource).toContain('aria-label={state.ariaLabel}')
    // The topbar reads the state; it may not filter-and-count its own way.
    // Comments are stripped first: the line that explains this defect has to be
    // allowed to name 「暂无」, and `//` is the only comment syntax in this slice.
    const topbar = app
      .slice(app.indexOf('function Topbar({'), app.indexOf('function DescriptionsIssue'))
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('//'))
      .join('\n')
    expect(topbar.length).toBeGreaterThan(2_000)
    expect(topbar).toContain('resolveIssueReadState({ baseUrl: apiBaseUrl, items: issueItems, error: issueReadError, loading: issueReadPending })')
    expect(topbar).toContain('<IssueNotificationBell state={issueRead} />')
    expect(topbar).not.toContain('暂无')
    expect(topbar).not.toContain('issueItems.length')
  })
})
