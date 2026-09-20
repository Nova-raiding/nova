import type { WorkspaceMetrics } from './api'

/**
 * Four states, never three.
 *
 * The topbar bell used to have one value for three different situations:
 * `.catch(() => setIssueMetrics(null))` collapsed 「未配置 API」, 「读取还没回来」
 * and 「读取失败」 into the same `null`, and `issueMetrics?.riskItems ?? []`
 * turned all three into an empty list. The panel then rendered
 * 「暂无需要处理的问题」 and the bell dropped its badge, so a workspace whose risk
 * read had just failed was indistinguishable from a healthy one — while
 * 今日看板 and 事务看板 on the same page reported the very same read as
 * 「未读取」 / 「读取失败」 (live reproduction: 500-ing API, bell aria-label
 * 「工作区待处理问题，暂无」, panels 「未读取 待处理」 and 「规则版本读取失败」).
 *
 * Only `ready` — a read that actually answered — may produce a number or
 * 「暂无」. Everything else says what it is.
 */
export type IssueReadMode = 'unconfigured' | 'loading' | 'read_error' | 'ready'

export type IssueReadState = {
  mode: IssueReadMode
  /** How many actionable issues were read. `null` unless the read answered. */
  count: number | null
  /** antd `Badge` count. `undefined` keeps every number off the bell. */
  badgeCount: number | undefined
  /** The bell's accessible name. */
  ariaLabel: string
  /**
   * The single line the panel shows instead of the list. Empty in `ready` mode
   * with issues, because the list itself is the answer then.
   */
  notice: string
}

export const ISSUE_READ_UNCONFIGURED_NOTICE = '未配置商家 API，工作区待处理问题未读取。'
export const ISSUE_READ_LOADING_NOTICE = '正在读取工作区待处理问题…'
export const ISSUE_READ_EMPTY_NOTICE = '暂无需要处理的问题'

export function resolveIssueReadState(input: {
  /** The configured API base url; absent means the offline demo. */
  baseUrl?: string
  /** Actionable risks, or `null` while no answer has arrived. */
  items: WorkspaceMetrics['riskItems'] | null
  /** `describeApiError` output for a read that failed. */
  error: string
  /** Whether a read is in flight. */
  loading: boolean
}): IssueReadState {
  const { baseUrl, items, error, loading } = input
  const unresolved = (mode: IssueReadMode, ariaLabel: string, notice: string): IssueReadState => ({
    mode,
    count: null,
    badgeCount: undefined,
    ariaLabel,
    notice,
  })
  if (!baseUrl) return unresolved('unconfigured', '工作区待处理问题，未读取', ISSUE_READ_UNCONFIGURED_NOTICE)
  if (error) return unresolved('read_error', '工作区待处理问题，读取失败', `工作区待处理问题读取失败：${error}`)
  if (loading || items === null) return unresolved('loading', '工作区待处理问题，正在读取', ISSUE_READ_LOADING_NOTICE)
  const count = items.length
  return {
    mode: 'ready',
    count,
    // `0` is a real answer, but it may not be drawn as a badge: antd hides a
    // zero count anyway, and passing `undefined` keeps that guarantee here
    // instead of depending on the renderer.
    badgeCount: count || undefined,
    ariaLabel: `工作区待处理问题${count ? `，${count} 项` : '，暂无'}`,
    notice: count ? '' : ISSUE_READ_EMPTY_NOTICE,
  }
}
