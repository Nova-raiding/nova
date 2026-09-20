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

/**
 * What a read leaves behind, in the shape the topbar stores it.
 *
 * This is the other half of `IssueReadState`: `resolveIssueReadState` turns an
 * outcome into words, and this is the outcome. They are separate types because
 * the defect lived between them — the read's result and the read's *outcome*
 * were the same `WorkspaceMetrics | null`, so a failure had nowhere to be and
 * came out as 「暂无需要处理的问题」.
 */
export type IssueReadOutcome = {
  /** Actionable risks, or `null` while no answer has arrived. Never `[]` for a read that did not answer. */
  items: WorkspaceMetrics['riskItems'] | null
  /** `describeApiError` output for a read that failed; '' otherwise. */
  error: string
  /** Whether a read is in flight. Cleared by every settle, success or failure. */
  loading: boolean
}

/** No API is configured, so nothing was read and nothing is pending. */
export const IDLE_ISSUE_READ: IssueReadOutcome = { items: null, error: '', loading: false }
/** A read is in flight; its result is not in yet, so there is no count. */
export const PENDING_ISSUE_READ: IssueReadOutcome = { items: null, error: '', loading: true }

/** The two things a read needs from outside, so a test can drive it with a real response shape. */
export type IssueReadDeps = {
  /** `fetchWorkspaceMetrics` in the app. */
  load: (baseUrl: string) => Promise<WorkspaceMetrics>
  /** `describeApiError` in the app. */
  describeError: (cause: unknown) => string
}

/**
 * One workspace-metrics read, with its outcome kept instead of thrown away.
 *
 * This is the exact chain the topbar effect runs, extracted so it can be driven
 * directly: the call it replaces was
 * `.then(setIssueMetrics).catch(() => setIssueMetrics(null))`, which mapped three
 * different facts — 未配置 / 读取中 / 读取失败 — onto the same `null` and let the
 * panel answer 「暂无需要处理的问题」 to a question the workspace had just failed
 * to read. It never throws: a failure is data here, not control flow.
 */
export async function readIssueOutcome(baseUrl: string, deps: IssueReadDeps): Promise<IssueReadOutcome> {
  try {
    const metrics = await deps.load(baseUrl)
    return { items: metrics.riskItems, error: '', loading: false }
  } catch (cause) {
    return { items: null, error: deps.describeError(cause), loading: false }
  }
}

/**
 * Only actionable risks belonging to a real bound store are notifications.
 * `workspace.metrics` also returns unbound and fixture records for
 * reconciliation; those are not problems the signed-in merchant can act on.
 *
 * `null` stays `null` — `[]` is a real answer and `null` is the absence of one.
 */
export function actionableIssueItems(items: WorkspaceMetrics['riskItems'] | null): WorkspaceMetrics['riskItems'] | null {
  return items === null ? null : items.filter(item => item.evidence?.unboundLocalData !== true && item.evidence?.fixtureData !== true)
}

/**
 * The whole bell read, from a settled outcome to the words the merchant sees.
 *
 * The topbar used to wire this composition by hand — the outcome's `error` into
 * one argument, its `loading` into another, the raw list into a filter — with
 * nothing driving the result. It is one function now so that the chain can be
 * driven end to end through a real response.
 */
export function resolveIssueReadStateFromOutcome({ baseUrl, outcome }: { baseUrl?: string; outcome: IssueReadOutcome }): IssueReadState {
  return resolveIssueReadState({
    baseUrl,
    items: actionableIssueItems(outcome.items),
    error: outcome.error,
    loading: outcome.loading,
  })
}

export type IssueReadSession = {
  /**
   * Start one read and publish its outcome. The pending state is published
   * before the request goes out, so the bell never shows a count while a read
   * is still in flight.
   *
   * A read that settles after a newer one has started is dropped rather than
   * published — this is the `active` flag the topbar effect used to carry
   * inline, and dropping it would let a slow first attempt overwrite the answer
   * the merchant is already looking at.
   *
   * Resolves with the outcome it published, or `null` when it was superseded.
   */
  read(baseUrl: string | undefined, publish: (outcome: IssueReadOutcome) => void): Promise<IssueReadOutcome | null>
}

/**
 * The topbar's read session. It exists so the retry has something to be a
 * *behaviour* of: retrying is calling `read` again, and the guard that a stale
 * attempt cannot win is a property of this object rather than of a `let` inside
 * an effect no test could reach.
 */
export function createIssueReadSession(deps: IssueReadDeps): IssueReadSession {
  let generation = 0
  return {
    async read(baseUrl, publish) {
      const mine = ++generation
      if (!baseUrl) {
        publish(IDLE_ISSUE_READ)
        return IDLE_ISSUE_READ
      }
      publish(PENDING_ISSUE_READ)
      const outcome = await readIssueOutcome(baseUrl, deps)
      if (mine !== generation) return null
      publish(outcome)
      return outcome
    },
  }
}

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
