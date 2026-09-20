import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AccountDashboard, FinanceOverview, Overview, TodayDashboard, resolvePurchaseBlockNotice, resolveRulePackBoard } from './App'
import { fetchCreativePointStatement } from './api'
import capture from './fixtures/creative-point-statement.capture.json'

const app = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')

const overview = (baseUrl?: string) => renderToStaticMarkup(createElement(Overview, {
  goTask: () => undefined,
  goProducts: () => undefined,
  goTasks: () => undefined,
  baseUrl,
  billing: null,
  onOpenUtility: () => undefined,
}))

const finance = () => renderToStaticMarkup(createElement(FinanceOverview, {
  baseUrl: 'http://127.0.0.1:9',
  billing: null,
  account: null,
  onOpenSupport: () => undefined,
}))

const today = () => renderToStaticMarkup(createElement(TodayDashboard, { baseUrl: 'http://127.0.0.1:9', metrics: null, billing: null }))

describe('unread reads are never rendered as measured values', () => {
  it('says the platform connections were not read instead of claiming there are none', () => {
    // With an API configured the account read starts unresolved: `rows` is `[]`
    // and the panel used to render 「暂无 / 当前工作区没有平台连接记录」 plus
    // 「0/0 已接入」 — a definite statement about a read that never happened.
    const html = overview('http://127.0.0.1:9')
    expect(html).toContain('平台连接未读取')
    expect(html).toContain('接入状态未读取')
    expect(html).not.toContain('当前工作区没有平台连接记录')
    expect(html).not.toContain('0/0 已接入')
    // The sibling store panel already reported the same read as unread.
    expect(html).toContain('店铺列表尚未从服务端读取')
  })

  it('keeps the offline demo connections labelled as demo rows', () => {
    const html = overview(undefined)
    expect(html).not.toContain('平台连接未读取')
    expect(html).toContain('演示连接')
  })

  it('still reports a successful read that returned no connections', () => {
    // `[]` is a real answer from a completed read, so the panel must keep
    // saying there are no connections rather than showing "unread" forever.
    const html = renderToStaticMarkup(createElement(AccountDashboard, { onOpenConnections: () => undefined, connections: [], stores: [] }))
    expect(html).toContain('当前工作区没有平台连接记录')
    expect(html).toContain('0/0 已接入')
    const unread = renderToStaticMarkup(createElement(AccountDashboard, { onOpenConnections: () => undefined, connections: null, stores: null }))
    expect(unread).toContain('平台连接未读取')
    expect(unread).not.toContain('当前工作区没有平台连接记录')
  })

  it('does not print a zero ledger total or claim the ledger was read after a failed read', () => {
    const html = finance()
    expect(html).not.toContain('已读取流水')
    expect(html).not.toContain('合计 0 点')
    expect(html).toContain('创意点流水未读取')
    expect(html).toContain('正在读取创意点流水…')
  })

  it('does not draw an empty storage track when no quota was read', () => {
    const html = finance()
    expect(html).not.toContain('finance-storage-track')
    expect(html).toContain('服务端未返回储存配额，当前不显示用量。')
  })

  it('removes the hardcoded 0% storage bars entirely', () => {
    expect(app).not.toContain("width: '0%'")
    expect(app).not.toContain('material-storage-track')
  })

  it('announces asynchronously filled regions to assistive technology', () => {
    const html = today()
    expect(html).toContain('role="status" aria-live="polite"')
    expect(html).toMatch(/class="today-rule-list" role="status" aria-live="polite"/u)
    expect(html).toMatch(/class="today-storage-meta" role="status" aria-live="polite"/u)
  })
})

describe('today rule packs keep failed, empty and pending reads apart', () => {
  it('reports a failed read as failed instead of as an empty result', () => {
    expect(resolveRulePackBoard({ baseUrl: '/api', packs: null, error: '网络不可用' })).toEqual({
      mode: 'read_error',
      message: '规则版本读取失败：网络不可用。当前不显示版本列表。',
    })
  })

  it('keeps the other four states distinct', () => {
    expect(resolveRulePackBoard({ baseUrl: undefined, packs: null, error: '' }).mode).toBe('unconfigured')
    expect(resolveRulePackBoard({ baseUrl: '/api', packs: null, error: '' })).toEqual({ mode: 'loading', message: '正在读取…' })
    expect(resolveRulePackBoard({ baseUrl: '/api', packs: [], error: '' })).toEqual({ mode: 'empty', message: '服务端未返回规则版本。' })
    const ready = resolveRulePackBoard({ baseUrl: '/api', packs: [{ id: 'pack-1' } as never], error: '' })
    expect(ready.mode).toBe('ready')
    expect(ready.message).toBe('')
  })
})

describe('checkout explains a disabled purchase button', () => {
  it('explains a contract-priced package with no orderable price', () => {
    expect(resolvePurchaseBlockNotice({ priceCny: null, blockedReason: '' })).toBe('服务端目录未给出可下单价格，当前无法创建充值订单；请联系客户经理确认价格。')
  })

  it('prefers the server blocked reason and stays silent when the package is orderable', () => {
    expect(resolvePurchaseBlockNotice({ priceCny: null, blockedReason: '服务端未将该套餐标记为可下单' })).toBe('')
    expect(resolvePurchaseBlockNotice({ priceCny: 500, blockedReason: '' })).toBe('')
    expect(resolvePurchaseBlockNotice(null)).toBe('')
  })
})

describe('creative point statement discloses its page budget', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_API_TOKEN', 'merchant-api-test-token')
    vi.stubGlobal('window', globalThis)
  })
  afterEach(() => vi.unstubAllGlobals())

  // Real server rows, not a hand-written stub: this fixture is a verbatim
  // capture of `creative-points.statement.list` on the local candidate stack.
  // The snake_case stub that used to live here matched only the dormant
  // contracts declaration and hid the fact that the client could not read a
  // single real row (see creative-point-statement-contract.test.ts).
  const capturedEntry = capture.data.result.entries[0]!
  const entry = (id: string) => ({ ...capturedEntry, id, eventType: 'settled', pointsDelta: -1, createdAt: '2026-09-01T00:00:00.000Z' })
  const envelope = (data: unknown) => new Response(JSON.stringify({
    request_id: 'merchant-studio-test', trace_id: 'merchant-studio-test', workspace_id: 'ws_demo',
    data, warnings: [], next_actions: [], error: null,
  }), { status: 200, headers: { 'content-type': 'application/json' } })

  it('flags a ledger longer than the page budget as truncated', async () => {
    // Six pages available, five allowed: the sixth page is never read, so the
    // caller must not present the result as the whole ledger.
    let page = 0
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => {
      page += 1
      return Promise.resolve(envelope({ result: { entries: [entry(`e${page}`)], next_cursor: page < 6 ? `cursor-${page}` : null } }))
    }))
    await expect(fetchCreativePointStatement('http://127.0.0.1:9')).resolves.toMatchObject({ truncated: true, pagesRead: 5 })
  })

  it('reports a complete ledger as complete', async () => {
    let page = 0
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() => {
      page += 1
      return Promise.resolve(envelope({ result: { entries: [entry(`e${page}`)], next_cursor: page < 2 ? `cursor-${page}` : null } }))
    }))
    await expect(fetchCreativePointStatement('http://127.0.0.1:9')).resolves.toMatchObject({ truncated: false, pagesRead: 2 })
  })

  it('still yields null for an unavailable ledger rather than an empty page', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(envelope({ result: { entries: 'unavailable' } })))
    await expect(fetchCreativePointStatement('http://127.0.0.1:9')).resolves.toBeNull()
  })
})
