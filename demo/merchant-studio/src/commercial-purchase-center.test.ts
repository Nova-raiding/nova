import { describe, expect, it } from 'vitest'
import { normalizeCommercialFirstCheckout, normalizeCommercialCatalog, normalizeCommercialPurchaseOrder, normalizeCommercialSubscription, selectMerchantCatalogItems, type CommercialCatalogItem, type CommercialSubscriptionPortfolio } from './api'
import { canConfirmCommercialOrder, commercialOrdersToConfirm, commercialPurchaseAction, commercialRecoveryOrderIds, commercialTargetPriceChanged, commercialPurchaseWorkspaceStorageKey, legacyCommercialRecoveryDisposition, CommercialPurchaseCenter, openCommercialCurrentPlanFromNotification } from './CommercialPurchaseCenter'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const item: CommercialCatalogItem = { id: 'sku-basic', sku_code: 'basic', name: '基础', type: 'monthly', visibility: 'public', version: 2, price_label: '¥2000.00', price_fen: 200000, cycle_label: '每月', benefits_summary: '5000点', benefits: [], approval_state: 'approved', valid_from: null, valid_to: null, unresolved: [], checksum: 'sha', executable: true, plan_family: 'standard', tier_rank: 1 }
const empty: CommercialSubscriptionPortfolio = { schema_version: 'commercial.subscription.v1', status: 'available', onboarding_qualified: false, current: null, future: [], packs: [], history: [], orders: [] }
const period = { id: 'e1', sourceOrderId: 'o1', skuCode: 'basic', catalogVersionId: 'v2', periodStart: '2026-11-01T00:00:00.000Z', periodEnd: '2026-12-01T00:00:00.000Z', periodStatus: 'scheduled', resolvedBenefits: [], executable: true, plan_family: 'standard', tier_rank: 1 }

describe('commercial purchase decisions are based on verified contracts', () => {
  it('isolates purchase recovery keys by the selected workspace', () => {
    const first = commercialPurchaseWorkspaceStorageKey('/api', 'merchant-1:ws-a,ws-b', 'ws-a')
    const second = commercialPurchaseWorkspaceStorageKey('/api', 'merchant-1:ws-a,ws-b', 'ws-b')
    expect(first).not.toBe(second)
    expect(first).toContain(':ws-a')
    expect(second).toContain(':ws-b')
  })
  it('migrates an old recovery record only when the account had exactly one matching workspace', () => {
    const legacy = JSON.stringify({ orderIds: ['order-1'] })
    expect(legacyCommercialRecoveryDisposition('merchant-1:ws-a', 'ws-a', legacy)).toBe('migrate')
    expect(legacyCommercialRecoveryDisposition('merchant-1:ws-a,ws-b', 'ws-a', legacy)).toBe('block')
    expect(legacyCommercialRecoveryDisposition('merchant-1:ws-a,ws-b', 'ws-b', legacy)).toBe('block')
    expect(legacyCommercialRecoveryDisposition('merchant-1:ws-a', 'ws-a', null)).toBe('none')
  })
  it('fails closed without a selected workspace and does not render purchase actions', () => {
    const markup = renderToStaticMarkup(createElement(CommercialPurchaseCenter, {
      baseUrl: '/api', workspaceKey: 'merchant-1:ws-a,ws-b', workspaceId: '', onOpenSupport: () => {},
    }))
    expect(markup).toContain('请先选择已授权工作区')
    expect(markup).not.toContain('购买套餐')
    expect(markup).not.toContain('确认待付款')
  })
  it('opens the current-plan and upgrade view from a purchase-result notification and rereads current facts', () => {
    let activeTab = 'orders'
    let requestReload: ((current: number) => number) | undefined
    openCommercialCurrentPlanFromNotification(tab => { activeTab = tab }, update => { requestReload = update })
    expect(activeTab).toBe('current')
    expect(requestReload?.(3)).toBe(4)
  })
  it('blocks unknown portfolio rather than claiming the account has never purchased', () => {
    expect(() => normalizeCommercialSubscription({ status: 'unknown', current: null })).toThrow('从未购买')
    expect(() => normalizeCommercialSubscription({ ...empty, future: undefined })).toThrow()
    expect(normalizeCommercialSubscription(empty)).toEqual(empty)
  })
  it('does not insert an immediate plan into the gap before a future paid contract', () => {
    expect(commercialPurchaseAction({ ...empty, onboarding_qualified: true, future: [period] }, item)).toMatchObject({ kind: null, label: '联系运营衔接' })
    expect(commercialPurchaseAction(empty, item)).toMatchObject({ kind: 'purchase' })
  })
  it('uses quote upgrades, same-tier renewal, and prevents a duplicate opening fee', () => {
    const active = { ...empty, onboarding_qualified: true, current: { ...period, periodStatus: 'active' } }
    expect(commercialPurchaseAction(active, item).label).toBe('续购')
    expect(commercialPurchaseAction(active, { ...item, sku_code: 'growth', tier_rank: 2 }).kind).toBe('upgrade')
    expect(commercialPurchaseAction(active, { ...item, type: 'onboarding' }).kind).toBe(null)
  })
  it('blocks downgrades and cross-family targets instead of calling them upgrades', () => {
    const growth = { ...empty, current: { ...period, skuCode: 'growth', tier_rank: 2 } }
    expect(commercialPurchaseAction(growth, item)).toMatchObject({ kind: null, label: '不支持降档' })
    expect(commercialPurchaseAction({ ...empty, current: { ...period, skuCode: 'premium', tier_rank: 3 } }, { ...item, sku_code: 'growth', tier_rank: 2 })).toMatchObject({ kind: null, label: '不支持降档' })
    expect(commercialPurchaseAction(growth, { ...item, plan_family: 'other', tier_rank: 3 })).toMatchObject({ kind: null, label: '系列不兼容' })
  })
  it('renews equal approved tiers across SKU versions and blocks unknown frozen identities', () => {
    const active = { ...empty, current: period }
    expect(commercialPurchaseAction(active, { ...item, sku_code: 'basic-new-sku' })).toMatchObject({ kind: 'purchase', label: '续购' })
    expect(commercialPurchaseAction({ ...active, current: { ...period, plan_family: null, tier_rank: null } }, item)).toMatchObject({ kind: null, label: '当前档位待核实' })
    expect(commercialPurchaseAction(active, { ...item, tier_rank: null })).toMatchObject({ kind: null, label: '档位待核实' })
  })
  it('respects higher paid future tiers for fresh renewal without blocking a valid current upgrade', () => {
    const portfolio = { ...empty, current: period, future: [{ ...period, id: 'future-premium', skuCode: 'premium', tier_rank: 3 }] }
    expect(commercialPurchaseAction(portfolio, item)).toMatchObject({ kind: null, label: '已有更高档未来合同' })
    expect(commercialPurchaseAction(portfolio, { ...item, sku_code: 'growth', tier_rank: 2 })).toMatchObject({ kind: 'upgrade' })
    expect(commercialPurchaseAction({ ...portfolio, future: [{ ...period, tier_rank: null }] }, item)).toMatchObject({ kind: null, label: '未来档位待核实' })
  })
})

describe('a price display never authorizes payment', () => {
  const wire = { order_id: 'o1', sku_code: 'basic', sku_version_id: 'v2', status: 'pending', currency: 'CNY' as const, amount_fen: 210000, expires_at: '2099-01-01T00:00:00Z' }
  it('requires the server amount and exact frozen SKU version, never a display label', () => {
    expect(() => normalizeCommercialPurchaseOrder({ ...wire, amount_fen: undefined })).toThrow()
    expect(() => normalizeCommercialPurchaseOrder({ ...wire, amount_fen: 0 })).toThrow()
    expect(() => normalizeCommercialPurchaseOrder({ ...wire, sku_version_id: '' })).toThrow()
    expect(normalizeCommercialPurchaseOrder(wire)).toMatchObject({ id: 'o1', state: 'pending', amount_fen: 210000 })
  })
  it('accepts only HTTPS/provider checkout URIs and rejects HTTP, fixture, ambiguous schemes, and credentials', () => {
    expect(() => normalizeCommercialPurchaseOrder({ ...wire, payment_url: 'http://pay.example.com/order/o1' })).toThrow('支付链接未确认安全')
    expect(() => normalizeCommercialPurchaseOrder({ ...wire, payment_url: 'https://user:secret@pay.example.com/order/o1' })).toThrow('支付链接未确认安全')
    expect(() => normalizeCommercialPurchaseOrder({ ...wire, payment_url: 'fixture://alipay/order/o1' })).toThrow('支付链接未确认安全')
    expect(() => normalizeCommercialPurchaseOrder({ ...wire, payment_url: 'https://fixture.invalid/alipay/order/o1' })).toThrow('支付链接未确认安全')
    expect(() => normalizeCommercialPurchaseOrder({ ...wire, payment_url: 'weixin:wxpay/bizpayurl?pr=abc' })).toThrow('支付链接未确认安全')
    expect(normalizeCommercialPurchaseOrder({ ...wire, payment_url: 'https://pay.example.com/order/o1' }).payment_url).toBe('https://pay.example.com/order/o1')
    expect(normalizeCommercialPurchaseOrder({ ...wire, payment_url: 'weixin://wxpay/bizpayurl?pr=abc' }).payment_url).toBe('weixin://wxpay/bizpayurl?pr=abc')
    expect(normalizeCommercialPurchaseOrder({ ...wire, payment_url: 'alipays://platformapi/startapp?appId=20000067' }).payment_url).toBe('alipays://platformapi/startapp?appId=20000067')
  })
  it('blocks confirmation with missing rights/cycle or expired acceptance window', () => {
    const order = normalizeCommercialPurchaseOrder(wire)
    expect(canConfirmCommercialOrder(order)).toBe(false)
    const confirmed = { ...order, snapshot: { cycle: { unit: 'month', count: 1 }, benefits: [{ code: 'monthly_creative_points', quantity: 5000 }], quantity: 1 } }
    expect(canConfirmCommercialOrder(confirmed)).toBe(true)
    expect(canConfirmCommercialOrder({ ...confirmed, expires_at: '2000-01-01T00:00:00Z' })).toBe(false)
    expect(canConfirmCommercialOrder({ ...confirmed, state: 'paid_pending_resolution' })).toBe(false)
    expect(canConfirmCommercialOrder({ ...confirmed, expires_at: '2026-10-05T10:00:00Z' }, Date.parse('2026-10-05T10:00:01Z'))).toBe(false)
    expect(canConfirmCommercialOrder({ ...confirmed, expires_at: '2026-10-05T10:00:02Z' }, Date.parse('2026-10-05T10:00:01Z'))).toBe(true)
  })
  it('requires both distinct first-purchase order lines, instead of presenting partial checkout as complete', () => {
    expect(() => normalizeCommercialFirstCheckout({ checkout_id: 'cc1', orders: [wire] })).toThrow()
    expect(() => normalizeCommercialFirstCheckout({ checkout_id: 'cc1', orders: [wire, wire] })).toThrow('来源冲突')
    const checkout = normalizeCommercialFirstCheckout({ checkout_id: 'cc1', orders: [wire, { ...wire, order_id: 'opening-1', sku_code: 'onboarding_once', amount_fen: 500000 }] })
    expect(checkout.orders.map(order => order.id)).toEqual(['o1', 'opening-1'])
    expect(checkout.orders.reduce((sum, order) => sum + order.amount_fen, 0)).toBe(710000)
  })
  it('compares the frozen monthly line to its SKU, not whichever first-checkout line happens to be last', () => {
    const plan = normalizeCommercialPurchaseOrder({ ...wire, amount_fen: 200000, sku_code: 'basic' })
    const opening = normalizeCommercialPurchaseOrder({ ...wire, order_id: 'opening-1', sku_code: 'onboarding_once', amount_fen: 500000 })
    expect(commercialTargetPriceChanged('basic', [plan, opening], 200000)).toBe(false)
    expect(commercialTargetPriceChanged('basic', [opening, plan], 200000)).toBe(false)
    expect(commercialTargetPriceChanged('basic', [plan, opening], 210000)).toBe(true)
  })
  it('recovers a split first checkout by allowing only the still-pending valid line to be paid', () => {
    const pending = normalizeCommercialPurchaseOrder({ ...wire, order_id: 'subscription-line', snapshot: { quantity: 1, cycle: { unit: 'month', count: 1 }, benefits: [{ code: 'monthly_creative_points', quantity: 5000 }] } })
    const alreadyPaid = { ...pending, id: 'opening-line', sku_code: 'onboarding_once', purchase_kind: 'onboarding_once' as const, state: 'paid_pending_grant' }
    expect(commercialOrdersToConfirm([alreadyPaid, pending]).map(order => order.id)).toEqual(['subscription-line'])
    expect(commercialOrdersToConfirm([alreadyPaid])).toEqual([])
  })
  it('prioritizes the explicitly selected recovery ID over stale checkout lines', () => {
    const stale = normalizeCommercialPurchaseOrder({ ...wire, order_id: 'old-history-order', snapshot: { quantity: 1, cycle: { unit: 'once' }, benefits: [] } })
    expect(commercialRecoveryOrderIds(false, ' current-opening-order ', [stale])).toEqual(['current-opening-order'])
    expect(commercialRecoveryOrderIds(false, '   ', [stale])).toEqual(['old-history-order'])
    expect(commercialRecoveryOrderIds(true, 'current-opening-order', [stale])).toEqual(['old-history-order'])
  })
  it('does not revive retired sales or choose among multiple historical approved versions', () => {
    expect(selectMerchantCatalogItems([{ ...item, sale_state: 'off_sale' }])).toEqual([])
    expect(selectMerchantCatalogItems([item, { ...item, version: 3 }])).toEqual([])
    expect(() => normalizeCommercialCatalog({ status: 'unavailable', catalog: [] })).toThrow()
    expect(normalizeCommercialCatalog({ status: 'available', catalog: [] }).catalog).toEqual([])
  })
})
