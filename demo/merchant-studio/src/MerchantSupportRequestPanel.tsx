import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Alert, Button, Input } from 'antd'
import { describeApiError, merchantSupportDiagnostic, fetchMerchantSupportRequest, redactMerchantSupportText, submitMerchantSupportRequest, type ApiError, type CommercialSubscriptionPortfolio, type MerchantSupportReceipt, type MerchantSupportRequestInput, type MerchantSupportRequestView } from './api'

export const supportDiagnostic = merchantSupportDiagnostic
const statusLabel = (status: string) => ({ open: '已登记', in_progress: '处理中', waiting_customer: '待客户补充', resolved: '已解决', closed: '已关闭' }[status] ?? status)
/** A support intake is separate from catalog/payment facts and never grants commercial permissions. */
export function MerchantSupportRequestPanel({ baseUrl, workspaceKey, handoff, requestId, traceId, version = 'commercial.subscription.v1', step = '目录或首购' }: {
  baseUrl: string; workspaceKey: string; handoff?: CommercialSubscriptionPortfolio['support_handoff']; requestId?: string; traceId?: string; version?: string; step?: string
}) {
  const [subject, setSubject] = useState('')
  const [message, setMessage] = useState('')
  const [receipt, setReceipt] = useState<MerchantSupportReceipt | null>(null)
  const [view, setView] = useState<MerchantSupportRequestView | null>(null)
  const [ticketId, setTicketId] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [outcomeUnknown, setOutcomeUnknown] = useState(false)
  const [resultNotice, setResultNotice] = useState('')
  const intent = useRef<MerchantSupportRequestInput | null>(null)
  const storageKey = `store-nova-support:${baseUrl}:${workspaceKey}`
  const blocked = !baseUrl || handoff?.status === 'blocked'
  const activeScope = useRef(storageKey)
  activeScope.current = storageKey
  useEffect(() => {
    let active = true
    setSubject(''); setMessage(''); setReceipt(null); setView(null); setTicketId(''); setError(''); setOutcomeUnknown(false); setBusy(false); intent.current = null
    try {
      const saved = JSON.parse(sessionStorage.getItem(storageKey) ?? 'null') as { intent?: MerchantSupportRequestInput; receipt?: MerchantSupportReceipt } | null
      if (saved?.intent) { intent.current = saved.intent; setSubject(saved.intent.subject); setMessage(saved.intent.message) }
      if (saved?.receipt) {
        setTicketId(saved.receipt.ticket_id); setBusy(true); setResultNotice('正在向服务端核对原支持工单与客户回复…')
        fetchMerchantSupportRequest(baseUrl, saved.receipt.ticket_id).then(reply => {
          if (!active) return
          setReceipt(reply); setView(reply); setOutcomeUnknown(false); setResultNotice(`已核对本人原工单 ${reply.ticket_number}。`)
        }).catch(cause => { if (active) { setError(`原工单核对失败：${describeApiError(cause)}`); setOutcomeUnknown(true); setResultNotice('原支持登记结果待核对，当前不把缓存回执当作真实读取结果。') } }).finally(() => { if (active) setBusy(false) })
      } else if (saved?.intent) { setOutcomeUnknown(true); setResultNotice('原支持提交结果待确认，可用原内容和标识恢复登记；当前尚未确认建立工单。') }
    } catch { setResultNotice('本地支持记录无法读取，可用已有工单 ID 查询；当前不声称已提交。') }
    return () => { active = false }
  }, [storageKey, baseUrl])
  const save = (confirmed?: MerchantSupportReceipt) => { try { sessionStorage.setItem(storageKey, JSON.stringify({ intent: intent.current, ...(confirmed ? { receipt: confirmed } : {}) })) } catch { /* original request remains in memory */ } }
  const submit = async (event?: FormEvent) => {
    event?.preventDefault()
    if (blocked || busy || receipt) return
    if (!intent.current) {
      if (subject.trim().length < 3 || message.trim().length < 3) { setError('问题标题和说明至少填写 3 个字，请勿输入密码、令牌或完整付款凭证。'); return }
      const diagnostic = { request_id: supportDiagnostic(requestId), trace_id: supportDiagnostic(traceId), version: supportDiagnostic(version), step: supportDiagnostic(step) }
      intent.current = { subject: redactMerchantSupportText(subject.trim()), message: redactMerchantSupportText(message.trim()), idempotency_key: `support-${crypto.randomUUID()}`, ...Object.fromEntries(Object.entries(diagnostic).filter(([, value]) => value !== undefined)) }
      setSubject(intent.current.subject); setMessage(intent.current.message)
    }
    const scope = storageKey
    save(); setBusy(true); setError(''); setResultNotice('')
    try {
      const confirmed = await submitMerchantSupportRequest(baseUrl, intent.current)
      if (activeScope.current !== scope) return
      setReceipt(confirmed); setTicketId(confirmed.ticket_id); setOutcomeUnknown(false); save(confirmed)
      setResultNotice(`已登记真实工单 ${confirmed.ticket_number}，${confirmed.replayed ? '本次恢复原登记，未重复创建。' : '可查询本人客户可见回复。'}`)
    } catch (cause) {
      if (activeScope.current !== scope) return
      const failure = cause as ApiError
      const unknown = !failure.status || failure.status >= 500 || failure.status === 409 || failure.code === 'API_REQUEST_TIMEOUT' || failure.code === 'SUPPORT_REQUEST_OUTCOME_UNKNOWN'
      setOutcomeUnknown(unknown); setError(describeApiError(cause))
      if (!unknown && failure.status !== 409) { intent.current = null; try { sessionStorage.removeItem(storageKey) } catch { /* preserve visible input */ } }
      if (unknown) setResultNotice('登记结果待确认，尚未确认建立工单。恢复提交会使用原内容及原幂等标识，不另建求助。')
    } finally { if (activeScope.current === scope) setBusy(false) }
  }
  const query = async () => {
    if (!baseUrl || busy) return
    const scope = storageKey
    setBusy(true); setError(''); setView(null)
    try {
      const reply = await fetchMerchantSupportRequest(baseUrl, ticketId.trim())
      if (activeScope.current !== scope) return
      setView(reply); setReceipt(reply); setOutcomeUnknown(false); save(reply)
    } catch (cause) { if (activeScope.current === scope) setError(`本人支持回复查询失败：${describeApiError(cause)}`) } finally { if (activeScope.current === scope) setBusy(false) }
  }
  return <section className="merchant-support-request" aria-label="首单前人工支持">
    <h3>提交人工支持</h3>
    <p>没有订单、任务或工单也可说明问题。提交后以真实工单回执为准；只查询本人当前企业的客户可见回复。</p>
    <p>负责团队：{handoff?.owner ?? '平台运营支持'}。请勿发送密码、令牌或完整付款凭证。</p>
    {blocked && <Alert type="warning" title="支持登记入口暂不可用" description={!baseUrl ? '未配置 API，请由安装或运营负责人恢复连接。' : '支持登记仓储未配置，请上述负责人配置项目内支持入口；当前未提交求助。'} />}
    <form onSubmit={event => void submit(event)}>
      <label htmlFor="merchant-support-subject">问题标题</label>
      <Input id="merchant-support-subject" value={subject} maxLength={200} onChange={event => setSubject(event.target.value)} disabled={busy || outcomeUnknown || Boolean(receipt)} aria-describedby="merchant-support-instructions" />
      <label htmlFor="merchant-support-message">问题说明</label>
      <Input.TextArea id="merchant-support-message" value={message} rows={4} maxLength={4000} showCount onChange={event => setMessage(event.target.value)} disabled={busy || outcomeUnknown || Boolean(receipt)} aria-describedby="merchant-support-instructions" />
      <p id="merchant-support-instructions">描述失败步骤及期望结果，凭证信息会脱敏。排障上下文：{supportDiagnostic(requestId) ? `请求 ${supportDiagnostic(requestId)}；` : ''}{supportDiagnostic(traceId) ? `跟踪 ${supportDiagnostic(traceId)}；` : ''}{version} · {step}。这些标识不能授权查询其他企业。</p>
      <Button htmlType="submit" type="primary" loading={busy} disabled={blocked || busy || Boolean(receipt)}>{outcomeUnknown ? '用原标识恢复支持登记' : '提交人工支持'}</Button>
    </form>
    {error && <Alert type="error" title={error} />}
    {resultNotice && <p role="status" aria-live="polite">{resultNotice}</p>}
    {receipt && <div role="status"><strong>工单：{receipt.ticket_number}</strong><p>状态：{statusLabel(receipt.status)} · 工单 ID：{receipt.ticket_id}</p></div>}
    <div className="merchant-support-query"><label htmlFor="merchant-support-ticket">已有支持工单 ID</label><Input id="merchant-support-ticket" value={ticketId} onChange={event => setTicketId(event.target.value)} /><Button onClick={() => void query()} disabled={!baseUrl || busy || !ticketId.trim()}>查询本人客户可见回复</Button></div>
    {view && <><h4>{view.subject}</h4>{view.replies.length ? <ul>{view.replies.map(reply => <li key={reply.id}><p>{reply.body}</p><time dateTime={reply.created_at}>{new Date(reply.created_at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}</time></li>)}</ul> : <p role="status">已读取该工单，目前暂无客户可见回复。</p>}</>}
    {receipt && <Button onClick={() => { intent.current = null; setReceipt(null); setView(null); setSubject(''); setMessage(''); setOutcomeUnknown(false); setResultNotice('新问题尚未提交。'); try { sessionStorage.removeItem(storageKey) } catch { /* visible state remains authoritative */ } }}>填写新的支持问题</Button>}
  </section>
}
