import { MerchantSupportRequestPanel } from './MerchantSupportRequestPanel'
import { CommercialGiftPlans, FrozenOnboardingGiftPolicy } from './CommercialGiftDetails'
import { CommercialPlanComparison } from './CommercialPlanComparison'
import { CommercialBenefitSnapshot, commercialBenefitName } from './CommercialBenefits'
import { commercialResultLabel } from './api'
import { useEffect, useRef, useState } from 'react'
import { Alert, Button, Checkbox, Modal, Table, Tabs } from 'antd'
import { createCommercialPaymentRequest, fetchCommercialFirstCheckoutRequest, createCommercialFirstCheckout, fetchCommercialPurchaseRequest, fetchCommercialUpgradeQuoteRequest, createCommercialPurchaseOrder, createCommercialUpgradeQuote, describeApiError, fetchCommercialCatalog, fetchCommercialPurchaseOrder, fetchCommercialSubscription, selectMerchantCatalogItems, type ApiError, type CommercialNotification, type CommercialCatalogItem, type CommercialPurchaseOrder, type CommercialSubscriptionPortfolio, type CommercialSubscriptionSnapshot, type CommercialUpgradeQuote } from './api'

const planNames: Record<string, string> = { basic: '基础版', growth: '成长版', premium: '尊享版', custom: '定制版' }
export const commercialMoney = (fen: number) => `¥${(fen / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
export const commercialDate = (instant: string) => new Date(instant).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })
export const commercialState = (state: string) => ({ active: '立即生效', scheduled: '未来待生效', pending: '待付款', paid: '已支付', awaiting_dependency: '待开通依赖', paid_pending_grant: '已支付待授予', paid_pending_resolution: '已收款待处置', reconciliation_required: '待对账', closed: '已关闭', refunded: '已退款', expired: '已到期' }[state] ?? state)
export function commercialPurchaseAction(portfolio: CommercialSubscriptionPortfolio, target: CommercialCatalogItem): { kind: 'purchase' | 'point_pack' | 'onboarding_once' | 'upgrade' | null; label: string; reason: string } {
  if (target.type === 'onboarding') return { kind: portfolio.onboarding_qualified ? null : 'onboarding_once', label: portfolio.onboarding_qualified ? '已开通' : '开通账户', reason: portfolio.onboarding_qualified ? '已获得开通资格，无需重复收费。' : '' }
  if (target.type === 'point_pack') return { kind: 'point_pack', label: '购买权益包', reason: '' }
  if (target.type !== 'monthly') return { kind: null, label: '受控购买', reason: '此商品需运营按批准政策处理。' }
  const targetKnown = typeof target.plan_family === 'string' && Boolean(target.plan_family.trim()) && Number.isSafeInteger(target.tier_rank) && (target.tier_rank ?? 0) > 0
  if (!targetKnown) return { kind: null, label: '档位待核实', reason: '商品系列与档位尚未核实，当前不能判断购买或升级。' }
  if (!portfolio.current) return portfolio.future.length ? { kind: null, label: '联系运营衔接', reason: '已有未来待生效合同，当前不能自动插入整期套餐或移动原合同。' } : { kind: 'purchase', label: '购买套餐', reason: '' }
  const source = portfolio.current
  if (typeof source.plan_family !== 'string' || !source.plan_family.trim() || !Number.isSafeInteger(source.tier_rank) || (source.tier_rank ?? 0) < 1) return { kind: null, label: '当前档位待核实', reason: '原合同系列与档位尚未读取完整，不能猜测升级或全价购买。' }
  if (source.plan_family !== target.plan_family) return { kind: null, label: '系列不兼容', reason: '当前合同与目标商品属于不同套餐系列，请由运营核实衔接方案。' }
  if (target.tier_rank! < source.tier_rank!) return { kind: null, label: '不支持降档', reason: '本期不提供降低档位入口；当前套餐与未来已购合同保持原约定。' }
  if (target.tier_rank === source.tier_rank) {
    if (portfolio.future.some(period => !period.plan_family?.trim() || !Number.isSafeInteger(period.tier_rank) || (period.tier_rank ?? 0) < 1)) return { kind: null, label: '未来档位待核实', reason: '未来已购合同身份尚未读取完整，当前不能判断新增续购是否降低档位。' }
    if (portfolio.future.some(period => period.plan_family === target.plan_family && period.tier_rank! > target.tier_rank!)) return { kind: null, label: '已有更高档未来合同', reason: '已购未来套餐具有更高档位，当前不能在其后新增较低档续购；原合同保持原约定。' }
    return { kind: 'purchase', label: '续购', reason: '同档位续购按核验顺序追加；待支付日期为预计，核验后固定。' }
  }
  // A valid higher identity enables requesting a quote, which remains the
  // server authority for compatible rights and the exact frozen difference.
  return { kind: 'upgrade', label: '计算升级差价', reason: '仅升级当前期，原到期日不变；未来已购及待付款续购保持原档位。' }
}
export function canConfirmCommercialOrder(order: CommercialPurchaseOrder, now = Date.now()): boolean {
  return order.state === 'pending' && Number.isSafeInteger(order.amount_fen) && order.amount_fen > 0 && Boolean(order.snapshot && Array.isArray(order.snapshot.benefits) && order.snapshot.cycle !== undefined && order.snapshot.quantity === 1 && order.expires_at && Date.parse(order.expires_at) > now)
}
export function commercialOrdersToConfirm(orders: CommercialPurchaseOrder[], now = Date.now()): CommercialPurchaseOrder[] {
  return orders.filter(order => canConfirmCommercialOrder(order, now))
}
export function commercialTargetPriceChanged(targetSkuCode: string, orders: CommercialPurchaseOrder[], expectedAmountFen: number | undefined): boolean {
  const targetOrder = orders.find(order => order.sku_code === targetSkuCode)
  return Boolean(targetOrder && expectedAmountFen !== undefined && targetOrder.amount_fen !== expectedAmountFen)
}
export function commercialRecoveryOrderIds(targetIsOpen: boolean, recoverOrderId: string, orders: CommercialPurchaseOrder[]): string[] {
  const explicitId = recoverOrderId.trim()
  if (!targetIsOpen && explicitId) return [explicitId]
  return orders.map(order => order.id)
}
function cycleSummary(value: unknown): string {
  if (value === 'monthly') return '自然月'
  if (value === 'once') return '一次性'
  if (value && typeof value === 'object') {
    const cycle = value as { unit?: unknown; count?: unknown }
    return cycle.unit === 'once' ? '一次性' : cycle.unit === 'month' ? `${cycle.count} 个自然月` : cycle.unit === 'day' ? `${cycle.count} 天` : '批准周期待核对'
  }
  return typeof value === 'string' ? value : '周期未确认'
}
function PeriodTable({ rows, name }: { rows: CommercialSubscriptionSnapshot[]; name: string }) {
  return <Table<CommercialSubscriptionSnapshot> size="middle" pagination={false} rowKey="id" scroll={{ x: 760 }} aria-label={name} dataSource={rows} locale={{ emptyText: `暂无${name}` }} columns={[
    { title: '套餐 / 来源订单', dataIndex: 'skuCode', render: (code: string, row) => <><strong>{planNames[code] ?? code}</strong><div>{row.sourceOrderId ?? '历史来源待核对'}</div></> },
    { title: '有效期（北京时间）', render: (_, row) => `${commercialDate(row.periodStart)} — ${commercialDate(row.periodEnd)}` },
    { title: '状态', dataIndex: 'periodStatus', render: (state: string) => name === '未来待生效套餐' ? '未来待生效' : commercialState(state) },
    { title: '合同权益', render: (_, row) => <CommercialBenefitSnapshot benefits={row.resolvedBenefits} label="查看合同原始权益快照" /> },
  ]} />
}

export function CommercialPurchaseCenter({ baseUrl, workspaceKey, onOpenSupport, openCatalog = false, onCatalogClose, notificationTarget }: { baseUrl: string; workspaceKey: string; onOpenSupport: () => void; openCatalog?: boolean; onCatalogClose?: () => void; notificationTarget?: CommercialNotification | null }) {
  const [catalog, setCatalog] = useState<CommercialCatalogItem[] | null>(null)
  const [portfolio, setPortfolio] = useState<CommercialSubscriptionPortfolio | null>(null)
  const [readError, setReadError] = useState('')
  const [loading, setLoading] = useState(true)
  const [reload, setReload] = useState(0)
  const [target, setTarget] = useState<CommercialCatalogItem | null>(null)
  const [recoveredCheckoutOpen, setRecoveredCheckoutOpen] = useState(false)
  const [quote, setQuote] = useState<CommercialUpgradeQuote | null>(null)
  const [orders, setOrders] = useState<CommercialPurchaseOrder[]>([])
  const [confirmed, setConfirmed] = useState(false)
  const [accepted, setAccepted] = useState(false)
  const [busy, setBusy] = useState(false)
  const [writeError, setWriteError] = useState('')
  const [resultUnknown, setResultUnknown] = useState(false)
  const [requestRef, setRequestRef] = useState('')
  const [traceRef, setTraceRef] = useState('')
  const [supportOpen, setSupportOpen] = useState(false)
  const [copyNotice, setCopyNotice] = useState('')
  const [activeTab, setActiveTab] = useState('current')
  const [clockNow, setClockNow] = useState(() => Date.now())
  useEffect(() => {
    if (notificationTarget?.notification_kind === 'purchase_result') {
      setActiveTab('orders'); setRecoverOrderId(notificationTarget.order_id ?? '')
    }
  }, [notificationTarget])
  const [recoverOrderId, setRecoverOrderId] = useState('')
  useEffect(() => {
    if (!orders.some(order => order.state === 'pending' && order.expires_at)) return
    const timer = setInterval(() => setClockNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [orders])
  const intent = useRef<{ target: string; key: string; checkoutId: string; kind?: 'first_checkout' | 'upgrade_quote' | 'upgrade_order' | 'order' } | null>(null)
  const savedKey = `store-nova-commercial:${baseUrl}:${workspaceKey}`
  useEffect(() => {
    let active = true
    setLoading(true); setReadError(''); setPortfolio(null); setCatalog(null)
    if (!baseUrl) { setReadError('未配置 API，商品和已购事实尚未读取。'); setLoading(false); return }
    Promise.allSettled([fetchCommercialCatalog(baseUrl), fetchCommercialSubscription(baseUrl)]).then(([items, summary]) => {
      if (!active) return
      const errors: string[] = []
      if (items.status === 'fulfilled') setCatalog(selectMerchantCatalogItems(items.value.catalog))
      else errors.push(`商品目录：${describeApiError(items.reason)}`)
      if (summary.status === 'fulfilled') setPortfolio(summary.value)
      else errors.push(`已购合同：${describeApiError(summary.reason)}`)
      setReadError(errors.join('；'))
      const failedRead = items.status === 'rejected' ? items.reason as ApiError : summary.status === 'rejected' ? summary.reason as ApiError : null
      if (failedRead) { setRequestRef(failedRead.requestId ?? ''); setTraceRef(failedRead.traceId ?? '') }
    }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [baseUrl, workspaceKey, reload])
  useEffect(() => {
    let active = true
    try {
      const saved = JSON.parse(sessionStorage.getItem(savedKey) ?? 'null') as { orderIds?: string[]; intent?: typeof intent.current } | null
      if (saved?.intent) { intent.current = saved.intent; setResultUnknown(true) }
      if (saved?.orderIds?.length) {
        setRecoverOrderId(saved.orderIds[0]); setResultUnknown(true)
        Promise.all(saved.orderIds.map(id => fetchCommercialPurchaseOrder(baseUrl, id))).then(next => {
          if (!active) return
          setOrders(next); setResultUnknown(false)
          if (next.every(order => order.state !== 'pending')) { intent.current = null; sessionStorage.removeItem(savedKey) }
        }).catch(cause => { if (active) setWriteError(`原订单恢复失败：${describeApiError(cause)}；请先核对原意图。`) })
      } else if (saved?.intent) setWriteError('上次提交结果待确认。请保留原请求标识联系运营查询，勿另建或重复付款。')
    } catch { setWriteError('本地订单恢复信息无法读取，请先查询原订单或联系运营核对。') }
    return () => { active = false }
  }, [savedKey, baseUrl])
  const persist = (next: CommercialPurchaseOrder[]) => { try { sessionStorage.setItem(savedKey, JSON.stringify({ orderIds: next.map(order => order.id), intent: intent.current })) } catch { /* original intent is retained in memory */ } }
  const choose = (item: CommercialCatalogItem) => {
    if (intent.current?.target === item.sku_code && orders.length) { setTarget(item); return }
    if (resultUnknown || orders.some(order => order.state === 'pending')) { setWriteError('已有待确认或待付款意图，请先查询原订单；关闭弹窗不会取消订单。'); return }
    setTarget(item); setQuote(null); setOrders([]); setConfirmed(false); setAccepted(false); setWriteError('')
    if (intent.current?.target !== item.sku_code) intent.current = { target: item.sku_code, key: `merchant-${crypto.randomUUID()}`, checkoutId: crypto.randomUUID() }
  }
  const reportError = (cause: unknown) => {
    const error = cause as ApiError
    const businessReason = typeof error.details?.business_reason === 'string' ? error.details.business_reason : error.code && /^(COMMERCIAL_|ONBOARDING_|UPGRADE_|PAYMENT_)/u.test(error.code) ? error.message : ''
    setWriteError(businessReason || describeApiError(cause)); setRequestRef(error.requestId ?? ''); setTraceRef(error.traceId ?? '')
    if (typeof error.details?.order_id === 'string') setRecoverOrderId(error.details.order_id)
    const uncertain = error.code === 'API_REQUEST_TIMEOUT' || error.code === 'MCP_TRANSPORT_CLOSED' || error.status === 503 || !error.status
    setResultUnknown(uncertain)
  }
  const prepare = async () => {
    if (!portfolio || !target || !intent.current || busy || resultUnknown || readError) return
    const action = commercialPurchaseAction(portfolio, target)
    if (!action.kind) return
    if (quote && Date.parse(quote.expires_at) <= Date.now()) {
      setQuote(null); intent.current = { target: target.sku_code, key: `merchant-${crypto.randomUUID()}`, checkoutId: crypto.randomUUID() }; setWriteError('报价已过期，请重新计算差价。'); return
    }
    intent.current.kind = action.kind === 'upgrade' ? quote ? 'upgrade_order' : 'upgrade_quote' : action.kind === 'purchase' && !portfolio.onboarding_qualified ? 'first_checkout' : 'order'
    persist(orders)
    setBusy(true); setWriteError(''); setConfirmed(false)
    try {
      if (action.kind === 'upgrade' && !quote) {
        setQuote(await createCommercialUpgradeQuote(baseUrl, target.sku_code, `${intent.current.key}-quote`))
        return
      }
      let next: CommercialPurchaseOrder[]
      if (action.kind === 'purchase' && !portfolio.onboarding_qualified) {
        const onboarding = catalog?.find(item => item.type === 'onboarding')
        if (!onboarding) throw new Error('开通费商品尚未批准上架，首购不能继续；开通费不包含首期套餐。')
        const checkout = await createCommercialFirstCheckout(baseUrl, onboarding.sku_code, target.sku_code, intent.current.key)
        next = checkout.orders
      } else {
        const order = await createCommercialPurchaseOrder(baseUrl, action.kind, target.sku_code, 'merchant_commercial_purchase', intent.current.key, quote?.upgrade_quote_id)
        next = [order]
      }
      setOrders(next); persist(next); setResultUnknown(false)
    } catch (cause) { reportError(cause) } finally { setBusy(false) }
  }
  const queryOriginalRequest = async () => {
    if (!intent.current || busy) return
    setBusy(true); setWriteError('')
    try {
      if (intent.current.kind === 'upgrade_quote') {
        const original = await fetchCommercialUpgradeQuoteRequest(baseUrl, `${intent.current.key}-quote`)
        if (original) { setQuote(original); setResultUnknown(false) }
        else { setResultUnknown(true); setWriteError('尚未查询到原报价的提交记录，原请求可能仍在处理中；保留原意图，请稍后查原请求或联系运营。') }
      } else if (intent.current.kind === 'first_checkout') {
        const original = await fetchCommercialFirstCheckoutRequest(baseUrl, intent.current.key)
        if (original) { setOrders(original.orders); persist(original.orders); setResultUnknown(false) }
        else { setResultUnknown(true); setWriteError('尚未查询到首购的提交记录，原请求可能仍在处理中；当前保留原意图，不另建或重复支付。') }
      } else {
        const original = await fetchCommercialPurchaseRequest(baseUrl, intent.current.key)
        if (original) { setOrders([original]); persist([original]); setResultUnknown(false) }
        else { setResultUnknown(true); setWriteError('尚未查询到原订单的提交记录，原请求可能仍在处理中；请稍后查原请求或联系运营，勿另建或重付。') }
      }
    } catch (cause) { reportError(cause) } finally { setBusy(false) }
  }
  const queryOrders = async () => {
    const ids = commercialRecoveryOrderIds(Boolean(target), recoverOrderId, orders)
    if (!ids.length) { setWriteError('本次提交结果待确认。请保留请求标识联系运营查询原幂等意图，不要重新下单或付款。'); return }
    setBusy(true); setWriteError('')
    try {
      const next = await Promise.all(ids.map(id => fetchCommercialPurchaseOrder(baseUrl, id)))
      setOrders(next); persist(next); setResultUnknown(false); setConfirmed(false); setAccepted(false)
      if (next.every(order => order.state !== 'pending')) { intent.current = null; sessionStorage.removeItem(savedKey); setReload(value => value + 1) }
    } catch (cause) { reportError(cause) } finally { setBusy(false) }
  }
  const confirmPayment = async () => {
    const payableOrders = commercialOrdersToConfirm(orders, clockNow)
    if (!accepted || busy || !payableOrders.length) return
    setBusy(true); setWriteError('')
    try {
      const nextPayable = await Promise.all(payableOrders.map(order => order.payment_mode === 'manual_transfer' ? Promise.resolve(order) : createCommercialPaymentRequest(baseUrl, order.id, `merchant-payment:${order.id}`)))
      const changed = nextPayable.some((order, index) => order.id !== payableOrders[index].id || order.amount_fen !== payableOrders[index].amount_fen || order.sku_version_id !== payableOrders[index].sku_version_id || JSON.stringify(order.snapshot) !== JSON.stringify(payableOrders[index].snapshot))
      const replacements = new Map(nextPayable.map(order => [order.id, order]))
      const next = orders.map(order => replacements.get(order.id) ?? order)
      setOrders(next); persist(next)
      if (changed) { setConfirmed(false); setAccepted(false); setWriteError('价格或权益已更新，请重新确认服务端明细；当前不会打开付款请求。') }
      else setConfirmed(true)
    } catch (cause) { reportError(cause) } finally { setBusy(false) }
  }
  const total = orders.reduce((sum, order) => sum + order.amount_fen, 0)
  const payableOrders = commercialOrdersToConfirm(orders, clockNow)
  const payableTotal = payableOrders.reduce((sum, order) => sum + order.amount_fen, 0)
  const priceChanged = target ? commercialTargetPriceChanged(target.sku_code, orders, quote?.amount_fen ?? target.price_fen ?? undefined) : false
  const expiredPendingOrders = orders.filter(order => order.state === 'pending' && order.expires_at && Date.parse(order.expires_at) <= clockNow)
  return <section className="commercial-center" aria-label="套餐与权益包">
    <div className="commercial-heading"><div><h3>我的套餐与权益包</h3><p>当前生效、未来待生效与独立权益包分别列示；价格和权益以冻结订单为准。</p></div><Button onClick={() => setReload(value => value + 1)} loading={loading}>刷新已购与商品</Button></div>
    {loading && <p role="status" aria-live="polite">正在读取商品与已购套餐，当前不能下单…</p>}{readError && <Alert type="error" showIcon title="套餐事实未读取成功" description={<>{readError}<p>事实未完整读取，暂不能新购或升级；已读取的合同仍可核对。</p>{requestRef && <p>可交接的请求标识：{requestRef} · 商业契约 commercial.subscription.v1 · 目录/已购查询</p>}<Button onClick={() => setSupportOpen(true)}>提交人工支持</Button></>} />}{!loading && portfolio && <>
      <p role="status">账户开通资格：{portfolio.onboarding_qualified ? '已开通' : '待开通；开通费与首期套餐分别计费'}</p>
      <Tabs activeKey={activeTab} onChange={setActiveTab} items={[
        { key: 'current', label: '当前套餐', children: portfolio.current ? <PeriodTable rows={[portfolio.current]} name="当前生效套餐" /> : <p role="status">{portfolio.future.length ? '当前没有生效套餐，已有未来合同；请查询原合同或联系运营衔接。' : '当前没有生效套餐，可选择已上架套餐购买。'}</p> },
        { key: 'future', label: `未来待生效（${portfolio.future.length}）`, children: <><p>未来套餐点数和服务在约定时点生效，当前不可消费或预留。</p><PeriodTable rows={portfolio.future} name="未来待生效套餐" /></> },
        { key: 'packs', label: `独立权益包（${portfolio.packs.length}）`, children: <Table rowKey="orderId" pagination={false} dataSource={portfolio.packs} locale={{ emptyText: '暂无已购独立权益包' }} scroll={{ x: 680 }} columns={[{ title: '权益包 / 版本', render: (_, row) => `${row.skuCode} / ${row.skuVersionId}` }, { title: '来源订单', dataIndex: 'orderId' }, { title: '有效期', dataIndex: 'expiresAt', render: (date: string | null) => date ? commercialDate(date) : '以批准合同为准' }, { title: '状态', dataIndex: 'grantStatus', render: (state: string) => commercialState(state) }, { title: '权益', render: (_, row) => <CommercialBenefitSnapshot benefits={row.benefits} label="查看权益包原始快照" /> }]} /> },
        { key: 'history', label: '套餐历史', children: <PeriodTable rows={portfolio.history} name="历史套餐" /> },
        { key: 'orders', label: '订单与恢复', children: <><Table rowKey={row => String(row.id ?? row.orderId ?? row.order_id)} pagination={false} dataSource={portfolio.orders} locale={{ emptyText: '暂无商业订单' }} columns={[{ title: '订单', render: (_, row) => String(row.id ?? row.order_id ?? '') }, { title: '状态', render: (_, row) => commercialState(String(row.status ?? row.state ?? '待确认')) }, { title: '操作', render: (_, row) => <Button onClick={() => { setRecoverOrderId(String(row.id ?? row.order_id ?? '')); setTarget(null); setOrders([]) }}>选择查单</Button> }]} /><label htmlFor="commercial-order-recovery">原订单 ID</label><input id="commercial-order-recovery" value={recoverOrderId} onChange={event => setRecoverOrderId(event.target.value)} /><Button onClick={() => void queryOrders()} disabled={!baseUrl || busy}>查询原订单</Button></> },
      ]} />
      <CommercialGiftPlans projection={portfolio.onboarding_gifts} />
      {notificationTarget?.notification_kind === 'purchase_result' && <Alert type="info" title="购买结果通知" description={<><p>通知记录的处理结果：{commercialResultLabel(notificationTarget.result_state)}。当前合同与权益以本页最新读取为准，通知不代表再次购买或再次授予。</p><p>相关订单：{notificationTarget.order_id ?? '尚未核实'}</p><Button onClick={() => { setActiveTab('orders'); setRecoverOrderId(notificationTarget.order_id ?? '') }}>查看相关原订单</Button></>} />}
      {notificationTarget && notificationTarget.notification_kind !== 'purchase_result' && catalog !== null && <Alert type="info" title="通知对应的当前商品" description={(() => {
        const current = catalog.find(item => item.sku_code === notificationTarget.sku_code)
        const oldPrice = typeof notificationTarget.payload?.price_fen === 'number' ? notificationTarget.payload.price_fen : null
        return <><p>历史发布版本 v{notificationTarget.version}{oldPrice !== null ? `，发布价格 ${commercialMoney(oldPrice)}` : ''}；历史通知保留。</p>{current ? <><p>{current.name} 当前在售 v{current.version}，{current.price_label} / {current.cycle_label ?? '一次性'}。{current.version !== notificationTarget.version || (oldPrice !== null && current.price_fen !== oldPrice) ? '价格或权益已更新，请以当前商品和冻结订单明细再次确认。' : ''}</p><Button onClick={() => choose(current)} disabled={Boolean(readError) || resultUnknown}>核对当前商品</Button></> : <p>该通知商品目前已下架或当前企业无购买资格；不能从历史通知直接付款。</p>}</>
      })()} />}
      <div className="commercial-heading"><h3>购买套餐与权益包</h3><p>开通费不含首期套餐；基础、成长、尊享商品以运营已批准的当前版本为准。</p></div>
      {catalog !== null && <CommercialPlanComparison catalog={catalog} />}
      {catalog === null ? <p role="status">商品目录未读取成功，不能确认有哪些可购商品；请刷新或联系运营。</p> : <Table<CommercialCatalogItem> rowKey="sku_code" dataSource={catalog ?? []} pagination={false} scroll={{ x: 760 }} locale={{ emptyText: '当前没有符合资格的上架商品' }} aria-label="可购商品目录" columns={[
        { title: '商品 / 版本', render: (_, item) => <><strong>{item.name}</strong><div>{item.sku_code} · v{item.version}</div></> },
        { title: '权益', dataIndex: 'benefits_summary' }, { title: '价格', dataIndex: 'price_label', align: 'right' }, { title: '周期', dataIndex: 'cycle_label', render: (cycle: string | null) => cycle ?? '一次性' },
        { title: '操作', render: (_, item) => { const action = commercialPurchaseAction(portfolio, item); return <><Button disabled={!action.kind || resultUnknown || Boolean(readError)} onClick={() => choose(item)}>{action.label}</Button>{action.reason && <p className="commercial-action-reason">{action.reason}</p>}</> } },
      ]} />}
    </>}
    {writeError && <Alert type="error" title={writeError} description={<>{requestRef && <><p>请求标识：{requestRef}</p><Button onClick={() => { const context = `请求标识：${requestRef}；商业契约：commercial.subscription.v1；步骤：${intent.current?.kind ?? '目录/已购查询'}`; if (!navigator.clipboard) { setCopyNotice('无法自动复制，请手动复制上方请求标识给运营负责人。'); return } void navigator.clipboard.writeText(context).then(() => setCopyNotice('排障标识已复制；尚未提交求助或建立工单。')).catch(() => setCopyNotice('无法自动复制，请手动复制上方请求标识给运营负责人。')) }}>复制脱敏排障标识</Button><p role="status">{copyNotice}</p></>}{resultUnknown && <p>结果待确认，请先查原订单或联系运营；不会重新建立付款意图。</p>}{resultUnknown && intent.current && <Button onClick={() => void queryOriginalRequest()} loading={busy}>查询原提交结果</Button>}<Button onClick={() => setSupportOpen(true)}>提交人工支持</Button></>} />}
    {orders.length > 0 && !target && <div><p>原订单查询结果：</p><Button disabled={busy} onClick={() => { setConfirmed(false); setAccepted(false); setRecoveredCheckoutOpen(true) }}>查看原冻结明细与付款</Button>{orders.map(order => <p key={order.id}>{order.id} · {commercialState(order.state)} · {commercialMoney(order.amount_fen)}</p>)}</div>}
    {!supportOpen && !readError && !writeError && <Button onClick={() => setSupportOpen(true)}>首单前需要人工支持</Button>}
    {supportOpen && <MerchantSupportRequestPanel baseUrl={baseUrl} workspaceKey={workspaceKey} handoff={portfolio?.support_handoff} requestId={requestRef || undefined} traceId={traceRef || undefined} step={intent.current?.kind ?? '目录及已购查询'} />}
    <Modal title="确认服务端订单与付款明细" open={Boolean(target) || recoveredCheckoutOpen} footer={null} width={860} onCancel={() => { if (!busy) { setTarget(null); setRecoveredCheckoutOpen(false) } }} mask={{ closable: !busy }} keyboard={!busy} className="commercial-checkout-modal" destroyOnHidden={false}>
      {(target || orders.length > 0) && <>
        <h3>{target?.name ?? orders[0]?.snapshot?.name ?? orders[0]?.sku_code}</h3><p>{portfolio && target && commercialPurchaseAction(portfolio, target).reason}</p>
        {quote && <div className="commercial-quote" role="status"><p>当前周期成交价 {commercialMoney(quote.current_cycle_price_fen)} → 目标周期价 {commercialMoney(quote.target_cycle_price_fen)}</p><p>剩余 {Math.ceil(quote.remaining_ms / 86400000)} 天 / 原周期 {Math.ceil(quote.total_ms / 86400000)} 天；补差价 <strong>{commercialMoney(quote.amount_fen)}</strong></p><p>到期日保持 {commercialDate(quote.period_end)}；实际到账须早于 {commercialDate(quote.expires_at)}。</p><p>增量权益：{Object.entries(quote.benefit_increments).map(([code, amount]) => `${commercialBenefitName(code)} ${amount}`).join('；') || '按批准报价'}</p><p>本次只升级当前期，未来订单仍按原档位。</p></div>}
        {!orders.length && target && <Button type="primary" disabled={busy || resultUnknown || loading || !portfolio} loading={busy} onClick={() => void prepare()}>{quote ? `生成补差价 ${commercialMoney(quote.amount_fen)} 的订单明细` : portfolio && commercialPurchaseAction(portfolio, target).kind === 'upgrade' ? '计算剩余期差价' : '生成订单明细，暂不付款'}</Button>}
        {orders.length > 0 && <>
          {priceChanged && <Alert type="warning" title="价格或权益已更新，请重新确认以下冻结订单。" />}
          {expiredPendingOrders.length > 0 && <Alert type="error" title="订单已过收款截止时间，请先查询订单状态或联系运营；不要继续付款。" />}
          <Table<CommercialPurchaseOrder> rowKey="id" pagination={false} dataSource={orders} scroll={{ x: 680 }} columns={[{ title: '分项 / 版本 / 数量', render: (_, order) => `${order.snapshot?.name ?? order.sku_code} / ${order.sku_version_id} / ${order.snapshot?.quantity ?? '未确认'}` }, { title: '冻结周期', render: (_, order) => cycleSummary(order.snapshot?.cycle) }, { title: '冻结权益', render: (_, order) => order.snapshot?.benefits ? <CommercialBenefitSnapshot benefits={order.snapshot.benefits} label="查看冻结权益原始快照" /> : '服务端未返回冻结明细，暂不能付款' }, { title: '金额', align: 'right', render: (_, order) => commercialMoney(order.amount_fen) }, { title: '状态 / 收款截止（北京时间）', render: (_, order) => <>{commercialState(order.state)}<div>{order.expires_at ? commercialDate(order.expires_at) : '截止未确认'}</div></> }]} />
          <p>开通与套餐分别计费、分别到账；未支付不增加权益。续购期间在核验时按既有合同顺延。</p><p className="commercial-total">原订单分项合计：<strong>{commercialMoney(total)}</strong></p>
          {payableOrders.length > 0 && <p className="commercial-total">当前仍待付款：<strong>{commercialMoney(payableTotal)}</strong>（仅处理有效且待付款的分项；已付款分项不会再次发起支付）</p>}
          {orders.map(order => <FrozenOnboardingGiftPolicy key={order.id} order={order} />)}
          {payableOrders.length > 0 && <>
            <Checkbox checked={accepted} disabled={payableOrders.length === 0} onChange={event => setAccepted(event.target.checked)}>我已核对当前待付款分项、企业、商品版本、周期、权益及金额 {commercialMoney(payableTotal)}，确认付款。</Checkbox>
            {!confirmed && <Button type="primary" disabled={!accepted || payableOrders.length === 0} loading={busy} onClick={() => void confirmPayment()}>确认待付款分项 {commercialMoney(payableTotal)}</Button>}
          </>}
          {payableOrders.length === 0 && <p role="status">当前没有满足付款条件的待付款分项；请查询订单状态或联系运营核实。</p>}
          {confirmed && orders.filter(order => canConfirmCommercialOrder(order, clockNow)).map(order => <div className="commercial-payment" key={order.id}>
            <h4>{order.snapshot?.name ?? order.sku_code} · {commercialMoney(order.amount_fen)}</h4>
            <p>本订单收款截止：{order.expires_at ? commercialDate(order.expires_at) : '尚未确认'}。须在截止时间前到账；过期后请先查询订单状态并联系运营处理，不要继续向过期订单付款。</p>
            {order.payment_mode === 'manual_transfer' ? order.transfer_instructions ? <><p>已批准人工转账：{order.transfer_instructions.receiver_name}</p><p>收款账户：{order.transfer_instructions.receiving_account} {order.transfer_instructions.bank_name}</p><p>备注/订单引用：{order.transfer_instructions.reference}</p><p>{order.transfer_instructions.warning ?? '转账后由授权运营核验真实到账，再授予权益；截图不作为到账。'}</p></> : <p role="alert">收款指引尚未核实，当前不能转账；请联系运营。</p> : order.payment_url ? <a className="commercial-payment-link" href={order.payment_url} target="_blank" rel="noreferrer">打开 {commercialMoney(order.amount_fen)} 的支付页面</a> : <p>支付请求尚未就绪，请联系运营确认批准的支付模式。</p>}
          </div>)}
          <Button onClick={() => void queryOrders()} loading={busy}>查询原订单与权益状态</Button>
        </>}
        {writeError && <p role="alert">{writeError}{requestRef ? ` · 请求 ${requestRef}` : ''}</p>}{resultUnknown && <Button onClick={() => void queryOriginalRequest()} loading={busy}>查询原提交结果</Button>}
        <Button onClick={() => { setTarget(null); setRecoveredCheckoutOpen(false); setSupportOpen(true) }}>需要运营协助</Button>
      </>}
    </Modal>
    {openCatalog && <Modal open title="套餐与权益包购买入口" footer={<Button type="primary" onClick={onCatalogClose}>查看本页购买目录</Button>} onCancel={onCatalogClose}><p>本页下方展示当前上架的套餐、开通费与独立权益包。请先核对已购合同，再选择商品。</p></Modal>}
  </section>
}
