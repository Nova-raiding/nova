import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IssueNotificationBell, IssueNotificationPanel } from './App'
import { describeApiError, fetchWorkspaceMetrics, type WorkspaceMetrics } from './api'
import {
  actionableIssueItems,
  createIssueReadSession,
  resolveIssueReadState,
  resolveIssueReadStateFromOutcome,
  type IssueReadOutcome,
} from './issue-read-state'
// Captured live (2026-09-20) from the local demo API on 127.0.0.1:8787, verbatim:
// `POST /mcp {"jsonrpc":"2.0","method":"workspace.metrics","params":{"risk_limit":"100"}}`
// against ws_demo. `requestApi` unwraps `data`, and `requestMcp` returns `data.result`.
import metricsEnvelope from './fixtures/workspace-metrics.capture.json'

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
 * wording is asserted where the merchant reads it rather than in a helper — and
 * the second half of the file drives the read chain itself, because asserting the
 * *text* of that chain was not a guard. See the comment above
 * `describe('the bell read chain …')`.
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

const appSource = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')
const topbarSource = appSource.slice(appSource.indexOf('function Topbar({'), appSource.indexOf('function DescriptionsIssue'))
/** `Topbar` with its own comments removed, for the shape assertions below. */
const topbarCode = topbarSource
  .split('\n')
  .filter((line) => !line.trimStart().startsWith('//'))
  .join('\n')

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
    // Both must come from `IssueReadState`, never from the raw list length. This
    // is the last assertion in the file that reads source text, and it is here
    // because a rendered `Topbar` has no effects to run in this suite.
    const bellSource = appSource.slice(appSource.indexOf('export function IssueNotificationBell'), appSource.indexOf('export function IssueNotificationPanel'))
    expect(bellSource.length).toBeGreaterThan(200)
    expect(bellSource).toContain('count={state.badgeCount}')
    expect(bellSource).toContain('aria-label={state.ariaLabel}')
    expect(topbarCode.length).toBeGreaterThan(2_000)
    expect(topbarCode).not.toContain('issueItems.length')
    expect(topbarCode).not.toContain('暂无')
  })
})

/**
 * The read chain, driven — not read.
 *
 * This file used to end the block above with a `readFileSync` + `slice` +
 * `toContain` pair asserting the *text* of the topbar's `.then/.catch` chain. It
 * could not fail when the chain broke: restoring the shipped defect verbatim
 * (`.catch(() => setIssueMetrics(null))` — the one line this whole exercise
 * exists to prevent) left every test green, and so did wiring the 重新读取 button
 * to `() => undefined`. Both mutations were run and both stayed green. A string
 * that matches does not mean the code behind it runs, and the states that matter
 * here only exist while a promise settles.
 *
 * So the chain is a thing to call now. `Topbar` binds
 * `createIssueReadSession`; these tests run the real `fetchWorkspaceMetrics`
 * through it over an envelope captured from the live API, and assert what the two
 * mounted components then say. Nothing below reads source text.
 */
describe('the bell read chain', () => {
  const captured = metricsEnvelope as unknown as { data: { result: WorkspaceMetrics } }
  const capturedMetrics = captured.data.result
  const capturedRisks = capturedMetrics.riskItems

  // Captured from the live merchant path: `POST /mcp {method: "workspace.metrics",
  // params: {risk_limit: "abc"}}` answers this envelope with HTTP 400.
  const failureEnvelope = {
    request_id: 'req_e9163aca-dc37-4912-a707-a0f4a5b021b8',
    trace_id: 'req_e9163aca-dc37-4912-a707-a0f4a5b021b8',
    workspace_id: 'ws_demo',
    data: null,
    warnings: [],
    next_actions: [],
    error: { code: 'INVALID_REQUEST', message: 'risk_limit 必须是正整数' },
  }
  const failureText = 'risk_limit 必须是正整数'

  const json = (body: unknown, status: number) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  const answer = (result: unknown) => ({ ...captured, data: { jsonrpc: '2.0', id: 'studio-test', result } })
  const metricsWith = (riskItems: Risk[]) => ({ ...capturedMetrics, riskItems })

  beforeEach(() => {
    vi.stubGlobal('window', {
      localStorage: { getItem: () => null, setItem: () => undefined, removeItem: () => undefined, clear: () => undefined },
      setTimeout: globalThis.setTimeout,
      clearTimeout: globalThis.clearTimeout,
      dispatchEvent: () => true,
    })
  })
  afterEach(() => vi.unstubAllGlobals())

  /** The session `Topbar` binds, over the client the app really uses. */
  const session = () => createIssueReadSession({ load: fetchWorkspaceMetrics, describeError: describeApiError })

  const replyWith = (...responses: Array<() => Promise<Response>>) => {
    const fetchMock = vi.fn()
    for (const response of responses) fetchMock.mockImplementationOnce(response)
    vi.stubGlobal('fetch', fetchMock)
    return fetchMock
  }

  const words = (baseUrl: string | undefined, outcome: IssueReadOutcome) =>
    resolveIssueReadStateFromOutcome({ baseUrl, outcome })
  const bellOf = (baseUrl: string | undefined, outcome: IssueReadOutcome) =>
    renderToStaticMarkup(createElement(IssueNotificationBell, { state: words(baseUrl, outcome) }))
  const panelOf = (baseUrl: string | undefined, outcome: IssueReadOutcome, items: Risk[]) =>
    renderToStaticMarkup(createElement(IssueNotificationPanel, {
      state: words(baseUrl, outcome),
      items,
      onOpenIssue: () => undefined,
      onClose: () => undefined,
      onRetry: () => undefined,
    }))

  it('publishes a pending state before the request and the answer after it', async () => {
    replyWith(async () => json(answer(capturedMetrics), 200))
    const published: IssueReadOutcome[] = []
    const outcome = await session().read('/api', (next) => published.push(next))
    expect(published).toHaveLength(2)
    // The bell never shows a count while the read is in the air...
    expect(published[0]).toEqual({ items: null, error: '', loading: true })
    expect(bellOf('/api', published[0]!)).toContain('工作区待处理问题，正在读取')
    // ... and the answer is the captured one, not an empty list.
    expect(outcome).toMatchObject({ error: '', loading: false })
    expect(outcome!.items).toEqual(capturedRisks)
  })

  it('keeps a real failure a failure instead of an empty workspace', async () => {
    replyWith(async () => json(failureEnvelope, 400))
    const outcome = await session().read('/api', () => undefined)
    // The mutation this catches is the shipped code: the catch kept nothing but
    // `null`, so the panel answered 「暂无需要处理的问题」 to a failed read.
    expect(outcome).toMatchObject({ items: null, loading: false })
    expect(outcome!.error).toBe(failureText)
    expect(bellOf('/api', outcome!)).toContain('工作区待处理问题，读取失败')
    expect(bellOf('/api', outcome!)).not.toContain('，暂无')
    const rendered = panelOf('/api', outcome!, [])
    expect(rendered).toContain(`工作区待处理问题读取失败：${failureText}`)
    expect(rendered).toContain('重新读取')
    expect(rendered).not.toContain('暂无需要处理的问题')
  })

  it('turns a retry into a second read whose answer replaces the failure', async () => {
    const issue = risk()
    const fetchMock = replyWith(
      async () => json(failureEnvelope, 400),
      async () => json(answer(metricsWith([issue])), 200),
    )
    const read = session()
    const failed = await read.read('/api', () => undefined)
    expect(bellOf('/api', failed!)).toContain('工作区待处理问题，读取失败')
    const retried = await read.read('/api', () => undefined)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(retried).toMatchObject({ error: '', loading: false, items: [issue] })
    // The failure does not survive the retry that answered.
    expect(bellOf('/api', retried!)).toContain('工作区待处理问题，1 项')
    expect(bellOf('/api', retried!)).not.toContain('读取失败')
  })

  it('drops a slow read that settles after a newer one', async () => {
    // The retry has to win: a first attempt that answers late may not overwrite
    // the read the merchant is already looking at.
    let releaseSlow: (response: Response) => void = () => undefined
    const slow = new Promise<Response>((resolve) => { releaseSlow = resolve })
    replyWith(
      () => slow,
      async () => json(answer(metricsWith([])), 200),
    )
    const read = session()
    const published: IssueReadOutcome[] = []
    const first = read.read('/api', (next) => published.push(next))
    const second = await read.read('/api', (next) => published.push(next))
    expect(second!.items).toEqual([])
    releaseSlow(json(answer(capturedMetrics), 200))
    expect(await first).toBeNull()
    expect(published.at(-1)).toEqual({ items: [], error: '', loading: false })
    expect(bellOf('/api', published.at(-1)!)).toContain('工作区待处理问题，暂无')
  })

  it('reports no configured API without reaching for the network at all', async () => {
    const fetchMock = replyWith()
    const published: IssueReadOutcome[] = []
    const outcome = await session().read(undefined, (next) => published.push(next))
    expect(fetchMock).not.toHaveBeenCalled()
    expect(outcome).toEqual({ items: null, error: '', loading: false })
    expect(bellOf(undefined, outcome!)).toContain('工作区待处理问题，未读取')
  })

  it('raises a notification only for a risk a bound store owns, and counts only those', async () => {
    // The captured workspace is the local fixture one: every risk it returns
    // carries `evidence.fixtureData` or `evidence.unboundLocalData`, so none of
    // them is a notification a signed-in merchant can act on.
    expect(capturedRisks.length).toBeGreaterThan(10)
    expect(actionableIssueItems(capturedRisks)).toEqual([])
    // A risk belonging to a bound store is a notification, and it is counted.
    const bound = risk({ evidence: { stock: 7 } })
    replyWith(async () => json(answer(metricsWith([bound])), 200))
    const outcome = await session().read('/api', () => undefined)
    const actionable = actionableIssueItems(outcome!.items)
    expect(outcome!.items).toHaveLength(1)
    expect(actionable).toEqual([bound])
    expect(panelOf('/api', outcome!, actionable!)).toContain('1 项需要关注')
  })

  it('binds the topbar to this chain, and the retry button to another read', () => {
    // The last structural assertion, and the narrowest one that is still worth
    // making: a `useEffect` cannot run in this suite (no DOM), so the three lines
    // that connect `Topbar` to the chain above are pinned by text. Everything
    // they connect is covered by the tests above; if those go, this is worthless.
    expect(topbarSource).toContain('issueReadSession.read(apiBaseUrl')
    expect(topbarSource).toContain('resolveIssueReadStateFromOutcome({ baseUrl: apiBaseUrl')
    expect(topbarSource).toContain('setIssueReload((value) => value + 1)')
  })
})
