import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { commercialResultLabel, fetchCommercialNotifications, markCommercialNotificationRead } from './api'
import { CommercialNotificationPanel, mergeNotificationPage } from './CommercialNotificationPanel'

const id = 'result:event-1:member-1'
const unread = { id, event_id: 'event-1', sku_code: 'growth', version: 2, title: '续购核验结果', body: '未来待生效', published_at: '2026-10-05T00:00:00Z', notification_kind: 'purchase_result', read_at: null, order_id: 'original-order', result_state: 'scheduled' }
const response = (data: unknown, mcp = false) => new Response(JSON.stringify({ data: mcp ? { result: data } : data }), { status: 200, headers: { 'content-type': 'application/json' } })
describe('notification reads are non-financial server confirmed member facts', () => {
  beforeEach(() => vi.stubGlobal('window', globalThis))
  afterEach(() => vi.unstubAllGlobals())
  it('reads scheduled results as future and requires confirmed read status rather than defaulting missing to unread', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response({ items: [unread], next_cursor: null }, true)))
    expect((await fetchCommercialNotifications('/api')).items[0]).toMatchObject({ read_at: null, result_state: 'scheduled', order_id: 'original-order' })
    expect(commercialResultLabel('scheduled')).toBe('未来待生效')
    expect(commercialResultLabel('awaiting_dependency')).toBe('待开通依赖')
    expect(commercialResultLabel('reconciliation_required')).toBe('待处置')
    vi.stubGlobal('fetch', vi.fn(async () => response({ items: [{ ...unread, read_at: undefined }], next_cursor: null }, true)))
    await expect(fetchCommercialNotifications('/api')).rejects.toThrow('已读状态')
  })
  it('retries an unknown mark-read with only the original key and without rewriting any payment or actor fact', async () => {
    const attempts: Array<{ url: string; body: unknown }> = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      attempts.push({ url, body: JSON.parse(String(init.body)) })
      return attempts.length === 1 ? new Response(JSON.stringify({ error: { code: 'NOTIFICATION_READ_OUTCOME_UNKNOWN', message: '结果未知' } }), { status: 503 }) : response({ notification_id: id, read_at: '2026-10-05T01:00:00Z', replayed: true })
    }))
    await expect(markCommercialNotificationRead('/api', id, 'notification-read-original')).rejects.toMatchObject({ code: 'NOTIFICATION_READ_OUTCOME_UNKNOWN' })
    await expect(markCommercialNotificationRead('/api', id, 'notification-read-original')).resolves.toMatchObject({ replayed: true })
    expect(attempts).toEqual([{ url: `/api/v1/commercial/notifications/${encodeURIComponent(id)}/read`, body: { idempotency_key: 'notification-read-original' } }, { url: `/api/v1/commercial/notifications/${encodeURIComponent(id)}/read`, body: { idempotency_key: 'notification-read-original' } }])
  })
  it('cannot call an unverified or wrong member receipt a successful read', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response({ notification_id: 'foreign-notice', read_at: '2026-10-05T01:00:00Z', replayed: false })))
    await expect(markCommercialNotificationRead('/api', id, 'same-key')).rejects.toThrow('当前不更新已读状态')
    vi.stubGlobal('fetch', vi.fn(async () => response({ notification_id: id, read_at: 'invalid', replayed: false })))
    await expect(markCommercialNotificationRead('/api', id, 'same-key')).rejects.toThrow('尚未确认')
  })
  it('does not manufacture an unread zero count before the authenticated feed is read', () => {
    const html = renderToStaticMarkup(createElement(CommercialNotificationPanel, { baseUrl: '/api', onOpenCatalog: () => undefined }))
    expect(html).toContain('商品与购买消息')
    expect(html).not.toContain('未读 0 条')
    expect(html).not.toContain('暂无符合当前企业权限')
  })
  it('does not merge a late notification page after the API scope changes', () => {
    const existing = [{ ...unread, id: 'current-scope' }]
    expect(mergeNotificationPage('/tenant-b/api', '/tenant-a/api', existing, [unread])).toBe(existing)
    expect(mergeNotificationPage('/tenant-a/api', '/tenant-a/api', existing, [{ ...unread, id: 'current-scope' }, { ...unread, id: 'next' }])?.map(item => item.id)).toEqual(['current-scope', 'next'])
  })
})
