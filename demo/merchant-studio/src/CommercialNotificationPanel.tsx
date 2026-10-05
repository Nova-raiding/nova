import { useEffect, useRef, useState } from 'react'
import { Button, Tag } from 'antd'
import { commercialResultLabel, describeApiError, fetchCommercialNotifications, markCommercialNotificationRead, type CommercialNotification } from './api'
import { commercialDate } from './CommercialPurchaseCenter'

export function mergeNotificationPage(currentBase: string | undefined, requestBase: string, current: CommercialNotification[] | null, next: CommercialNotification[]): CommercialNotification[] | null {
  if (currentBase !== requestBase) return current
  return [...(current ?? []), ...next.filter(item => !current?.some(existing => existing.id === item.id))]
}

/** Commercial announcements retain publication history; the purchase page rereads current sales. */
export function CommercialNotificationPanel({ baseUrl, onOpenCatalog }: { baseUrl?: string; onOpenCatalog: (item: CommercialNotification) => void }) {
  const [items, setItems] = useState<CommercialNotification[] | null>(null)
  const [error, setError] = useState('')
  const [cursor, setCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [reload, setReload] = useState(0)
  const [reading, setReading] = useState<string | null>(null)
  const [readErrors, setReadErrors] = useState<Record<string, string>>({})
  const intents = useRef(new Map<string, string>())
  const scope = useRef(baseUrl)
  scope.current = baseUrl
  useEffect(() => {
    let active = true
    setItems(null); setError(''); setCursor(null); setReadErrors({})
    if (!baseUrl) { setError('未配置 API，商业通知尚未读取。'); return }
    setLoading(true)
    fetchCommercialNotifications(baseUrl).then(result => { if (active) { setItems(result.items); setCursor(result.next_cursor) } }).catch(cause => { if (active) setError(describeApiError(cause)) }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [baseUrl, reload])
  const loadMore = async () => {
    if (!baseUrl || !cursor || loading) return
    const requestedBase = baseUrl
    setLoading(true); setError('')
    try {
      const next = await fetchCommercialNotifications(requestedBase, cursor)
      if (scope.current !== requestedBase) return
      setItems(previous => mergeNotificationPage(scope.current, requestedBase, previous, next.items))
      setCursor(next.next_cursor)
    }
    catch (cause) { if (scope.current === requestedBase) setError(describeApiError(cause)) }
    finally { if (scope.current === requestedBase) setLoading(false) }
  }
  const markRead = async (item: CommercialNotification) => {
    if (!baseUrl || reading || item.read_at) return
    const activeBase = baseUrl
    let key = intents.current.get(item.id)
    if (!key) {
      const storageKey = `store-nova-notification-read:${baseUrl}:${item.id}`
      try { key = sessionStorage.getItem(storageKey) ?? undefined } catch { /* memory retains the intent */ }
      key ??= `notification-read:${crypto.randomUUID()}`
      intents.current.set(item.id, key)
      try { sessionStorage.setItem(storageKey, key) } catch { /* memory retains the intent */ }
    }
    setReading(item.id); setReadErrors(previous => ({ ...previous, [item.id]: '' }))
    try {
      const result = await markCommercialNotificationRead(baseUrl, item.id, key)
      if (scope.current !== activeBase) return
      setItems(previous => previous?.map(row => row.id === result.notification_id ? { ...row, read_at: result.read_at } : row) ?? null)
    } catch (cause) { if (scope.current === activeBase) setReadErrors(previous => ({ ...previous, [item.id]: `已读结果待确认：${describeApiError(cause)}。可用原标识重试，当前保留服务端已读取的状态。` })) } finally { if (scope.current === activeBase) setReading(null) }
  }
  const unread = items?.filter(item => item.read_at === null).length
  return <section className="merchant-commercial-notifications" aria-label="套餐与权益包通知">
    <div className="commercial-heading"><strong>商品与购买消息</strong><Button onClick={() => setReload(value => value + 1)} loading={loading}>刷新</Button></div>
    {items !== null && <p role="status">已读取消息中未读 {unread} 条{cursor ? '，还有下一页尚未读取' : ''}。</p>}
    {loading && items === null && <p role="status" aria-live="polite">正在读取商业通知…</p>}
    {error && <p role="alert">商业通知读取失败：{error}</p>}
    {items !== null && !items.length && <p role="status">暂无符合当前企业权限的商业通知。</p>}
    {items && <ul>{items.map(item => <li key={item.id}><Tag>{item.read_at === null ? '未读' : item.read_at ? '已读' : '已读状态待核实'}</Tag><strong>{item.title}</strong><p>{item.body}</p><p>{item.notification_kind === 'purchase_result' ? `购买结果：${commercialResultLabel(item.result_state)}` : `上架消息 · 发布版本 v${item.version}`} · {commercialDate(item.published_at)}</p>{item.notification_kind === 'purchase_result' ? <><p>这是当时的真实处理结果，当前已购与原订单需重新查询。</p><Button onClick={() => onOpenCatalog(item)}>查看已购与相关订单</Button></> : <>{item.current_sale_state && item.current_sale_state !== 'on_sale' && <p>商品目前已下架；历史通知保留。</p>}<Button onClick={() => onOpenCatalog(item)}>查看当前商品与价格</Button></>}{item.read_at === null && <Button onClick={() => void markRead(item)} disabled={Boolean(reading)} loading={reading === item.id}>{readErrors[item.id] ? '用原标识重试已读登记' : '标记已读'}</Button>}{readErrors[item.id] && <p role="alert">{readErrors[item.id]}</p>}</li>)}</ul>}
    {cursor && <Button onClick={() => void loadMore()} disabled={loading}>读取下一页商业通知</Button>}
  </section>
}
