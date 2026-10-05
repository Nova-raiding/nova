import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { CommercialGiftPlans, CommercialPointLedger, FrozenOnboardingGiftPolicy, giftBatchStatus, pointOriginLabel } from './CommercialGiftDetails'
import { fetchCreativePointStatement, type CommercialOnboardingGifts, type CreativePointStatementEntry } from './api'

const batch = { schedule_id: 'schedule-1', sequence: 1, points: 500, due_at: '2026-01-01T00:00:00Z', expires_at: '2026-02-01T00:00:00Z', schedule_status: 'scheduled', grant_id: null, granted_at: null, dispatch_id: null, dispatched_at: null, expiration_id: null, expired_at: null, expired_by_time: true, blockers: ['missing dispatch'] }
const projection: CommercialOnboardingGifts = { status: 'available', blockers: [], plans: [{ source_order_id: 'opening-old', source_order_status: 'paid', order_snapshot_id: 'frozen-old', sku_code: 'onboarding', sku_version_id: 'version-old', source_checksum: 'checksum', policy_ref: { policyId: 'commercial.onboarding', version: 'v2' }, grant_count: 6, points_per_grant: 500, total_points: 3000, batches: [batch] }] }
const entry = { id: 'ledger-1', workspaceId: 'ws', operationId: 'op', eventType: 'granted', pointsDelta: 500, availableAfter: 500, reservedAfter: 0, settledAfter: 0, accessRevision: 1, createdAt: '2026-01-01T00:00:00Z', intent: {}, grantSourceType: 'commercial_order_v2', grantSourceId: 'opening-old', commercial_origin: { status: 'known', kind: 'onboarding_gift', source_order_id: 'opening-old', sku_version_id: 'version-old', schedule_id: null, sequence: 1, grant_id: 'gift-1' } } satisfies CreativePointStatementEntry
describe('gift plans and ledger preserve server source facts', () => {
  it('retains the authenticated statement producer origin through client normalization', async () => {
    vi.stubGlobal('window', globalThis)
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: { result: { entries: [entry, { ...entry, id: 'unknown-origin', commercial_origin: { ...entry.commercial_origin, status: 'unknown', kind: null } }], next_cursor: null } } }), { status: 200, headers: { 'content-type': 'application/json' } })))
    try {
      const page = await fetchCreativePointStatement('/api')
      expect(page?.entries[0].commercial_origin).toEqual(entry.commercial_origin)
      expect(pointOriginLabel(page!.entries[1])).toBe('来源尚未核实')
    } finally { vi.unstubAllGlobals() }
  })
  it('distinguishes unavailable projection from a successful empty plan read', () => {
    const unavailable = renderToStaticMarkup(createElement(CommercialGiftPlans, { projection: { status: 'unknown', plans: null, blockers: ['repository unavailable'] } }))
    expect(unavailable).toContain('赠点计划尚未读取完整')
    expect(unavailable).toContain('repository unavailable')
    expect(unavailable).not.toContain('当前没有开通赠点计划')
    expect(renderToStaticMarkup(createElement(CommercialGiftPlans, { projection: { status: 'available', plans: [], blockers: [] } }))).toContain('已读取，当前没有开通赠点计划')
  })
  it('renders frozen 500 quantities, exact periods and original schedule state without inventing expired dispatch', () => {
    const html = renderToStaticMarkup(createElement(CommercialGiftPlans, { projection }))
    expect(html).toContain('每期 500 点')
    expect(html).toContain('不代表全部已到账')
    expect(html).toContain('version-old')
    expect(html).toContain('待按约定发放')
    expect(html).toContain('有效窗口已结束')
    expect(html).toContain('未取得授予记录')
    expect(html).not.toContain('已发放')
    expect(html).toContain('2026/2/1')
  })
  it('keeps user status readable and exact technical evidence in closed secondary details', () => {
    const html = renderToStaticMarkup(createElement(CommercialGiftPlans, { projection }))
    const primary = html.replace(/<details>.*?<\/details>/gu, '').replace(/<[^>]+>/gu, '')
    expect(primary).toContain('已支付')
    expect(primary).not.toContain('commercial.onboarding')
    expect(primary).not.toContain('schedule-1')
    expect(primary).not.toContain('version-old')
    expect(html).toContain('查看本期记录')
    expect(html).toContain('schedule-1')
    expect(giftBatchStatus('unrecognized_future_status')).toBe('发放状态待核实')
  })
  it('uses the server commercial origin even when initial gifts share the generic order source type', () => {
    expect(pointOriginLabel(entry)).toBe('开通赠点')
    expect(pointOriginLabel({ ...entry, commercial_origin: { ...entry.commercial_origin, kind: 'subscription_points' } })).toBe('套餐点数')
    expect(pointOriginLabel({ ...entry, commercial_origin: { ...entry.commercial_origin, kind: 'point_pack' } })).toBe('权益包点数')
    expect(pointOriginLabel({ ...entry, commercial_origin: undefined })).toBe('来源尚未核实')
    const html = renderToStaticMarkup(createElement(CommercialPointLedger, { entries: [entry], unavailableMessage: '', partial: true }))
    expect(html).toContain('opening-old')
    expect(html).toContain('version-old')
    expect(html).toContain('当前不是完整账本')
  })
  it('shows approved frozen 600 policy independently and never invents the old 500 default', () => {
    const order = { id: 'new-order', state: 'pending', sku_code: 'onboarding', sku_version_id: 'new-version', amount_fen: 550000, currency: 'CNY' as const, snapshot: { kind: 'onboarding', onboarding_gift_policy: { grant_count: 6, points_per_grant: 600, cadence: 'monthly', starts_at: 'payment_verified', grant_expires_at_rule: 'next_monthly_anniversary' } } }
    const html = renderToStaticMarkup(createElement(FrozenOnboardingGiftPolicy, { order }))
    expect(html).toContain('每期 600 点')
    expect(html).toContain('共 3600 点')
    expect(html).not.toContain('500 点')
    expect(html).toContain('不抵扣首期费')
    expect(renderToStaticMarkup(createElement(FrozenOnboardingGiftPolicy, { order: { ...order, snapshot: { kind: 'onboarding' } } }))).toContain('不能确认每期数量')
  })
})
