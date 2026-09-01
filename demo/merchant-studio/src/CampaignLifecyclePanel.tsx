import { useEffect, useRef, useState } from 'react'
import { AlertCircle, PauseCircle, PlayCircle, RefreshCw, RotateCcw, X } from 'lucide-react'
import { describeApiError, requestMcp } from './api.js'

export type CampaignLifecycleAction = 'pause' | 'resume' | 'retry_failed'

const campaignStateLabel = (state: string) => ({ queued: '排队中', running: '处理中', paused: '已暂停', succeeded: '已完成', completed: '已完成', failed: '处理失败', unknown: '状态待确认', reconciling: '正在核对结果' }[state] ?? '状态待确认')

export function campaignActionAvailability(state: string) {
  const uncertain = state === 'unknown' || state === 'reconciling'
  return { canPause: !uncertain && !['paused', 'succeeded', 'completed', 'failed'].includes(state), canResume: !uncertain && state === 'paused', canRetryFailed: !uncertain && state === 'failed' }
}

export interface CampaignSnapshot {
  id: string
  state: string
  revision: number
  reason?: string
  items: Array<{ id: string; productId?: string; platform?: string; accountId?: string; state: string; error?: { code?: string; message?: string } }>
}
interface CampaignOption { id: string; state: string; revision: number; platform: string; accountId: string; itemCount: number; failedCount: number; createdAt: string; updatedAt: string }

export function parseCampaignSnapshot(value: unknown): CampaignSnapshot {
  if (!value || typeof value !== 'object') throw new Error('campaign 响应格式无效')
  const row = value as Record<string, unknown>
  const revision = Number(row.revision)
  if (typeof row.id !== 'string' || typeof row.state !== 'string' || !Number.isSafeInteger(revision) || revision < 1 || !Array.isArray(row.items)) throw new Error('campaign 缺少 id、state、revision 或 items')
  const items = row.items.map((entry, index) => {
    if (!entry || typeof entry !== 'object') throw new Error(`campaign item ${index + 1} 格式无效`)
    const item = entry as Record<string, unknown>
    const id = typeof item.id === 'string' ? item.id : typeof item.item_id === 'string' ? item.item_id : undefined
    if (!id || typeof item.state !== 'string') throw new Error(`campaign item ${index + 1} 缺少 id 或 state`)
    const text = (camel: string, snake: string) => typeof item[camel] === 'string' ? item[camel] as string : typeof item[snake] === 'string' ? item[snake] as string : undefined
    const rawError = item.error ?? item.blocker
    const error = rawError && typeof rawError === 'object' ? { code: typeof (rawError as Record<string, unknown>).code === 'string' ? (rawError as Record<string, unknown>).code as string : undefined, message: typeof (rawError as Record<string, unknown>).message === 'string' ? (rawError as Record<string, unknown>).message as string : undefined } : undefined
    return { id, state: item.state, productId: text('productId', 'product_id'), platform: text('platform', 'platform'), accountId: text('accountId', 'account_id'), error }
  })
  return { id: row.id, state: row.state, revision, reason: typeof row.reason === 'string' ? row.reason : undefined, items }
}

export function buildCampaignLifecycleParams(input: { campaign: CampaignSnapshot; action: CampaignLifecycleAction; reason: string; selectedItemIds?: string[]; idempotencyKey: string }) {
  const reason = input.reason.trim()
  if (reason.length < 3) throw new Error('操作原因至少填写 3 个字符')
  if (input.action === 'retry_failed' && !input.selectedItemIds?.length) throw new Error('至少选择一个失败项')
  return {
    campaign_id: input.campaign.id,
    expected_revision: String(input.campaign.revision),
    idempotency_key: input.idempotencyKey,
    reason,
    ...(input.action === 'retry_failed' ? { item_ids_json: JSON.stringify(input.selectedItemIds) } : {}),
  }
}

export function campaignDialogFocusEdge(focusInside: boolean, shiftKey: boolean) {
  return focusInside ? undefined : shiftKey ? 'last' : 'first'
}

export function campaignDialogDescriptionIds(hasError: boolean) {
  return hasError ? 'campaign-action-description campaign-action-error' : 'campaign-action-description'
}

export function campaignReasonDescriptionIds(hasError: boolean) {
  return hasError ? 'campaign-action-reason-hint campaign-action-error' : 'campaign-action-reason-hint'
}

export function CampaignLifecyclePanel({ baseUrl }: { baseUrl?: string }) {
  const [campaignId, setCampaignId] = useState('')
  const [campaignOptions, setCampaignOptions] = useState<CampaignOption[]>([])
  const [showControls, setShowControls] = useState(false)
  const [campaign, setCampaign] = useState<CampaignSnapshot>()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [errorSource, setErrorSource] = useState<'list' | 'campaign' | ''>('')
  const [action, setAction] = useState<CampaignLifecycleAction>()
  const [reason, setReason] = useState('')
  const [confirmed, setConfirmed] = useState(false)
  const [selected, setSelected] = useState<string[]>([])
  const [submitting, setSubmitting] = useState(false)
  const statusRef = useRef<HTMLDivElement>(null)
  const errorRef = useRef<HTMLDivElement>(null)
  const actionErrorRef = useRef<HTMLDivElement>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const openProductSelection = () => {
    window.history.pushState(null, '', '/merchant/products')
    window.dispatchEvent(new PopStateEvent('popstate'))
  }

  const loadCampaignOptions = async () => {
    if (!baseUrl) return
    setLoading(true); setError(''); setErrorSource('')
    try {
      const response = await requestMcp<{ items?: CampaignOption[] }>(baseUrl, 'campaign.batch.list', { limit: '50' })
      const items = Array.isArray(response?.items) ? response.items : []
      setCampaignOptions(items)
      if (!items.some(item => item.id === campaignId)) { setCampaignId(items[0]?.id ?? ''); setCampaign(undefined) }
    } catch (cause) { setCampaignOptions([]); setCampaign(undefined); setCampaignId(''); setError(describeApiError(cause)); setErrorSource('list') }
    finally { setLoading(false) }
  }

  const load = async (id = campaignId.trim()) => {
    if (!baseUrl || !id) return
    setLoading(true); setError(''); setErrorSource('')
    try { setCampaign(parseCampaignSnapshot(await requestMcp(baseUrl, 'campaign.batch.get', { campaign_id: id }))) }
    catch (cause) { setCampaign(undefined); setError(describeApiError(cause)); setErrorSource('campaign') }
    finally { setLoading(false) }
  }
  useEffect(() => { if (!loading && (error || campaign)) window.requestAnimationFrame(() => (error ? (action ? actionErrorRef.current : errorRef.current) : statusRef.current)?.focus()) }, [action, campaign, error, loading])
  useEffect(() => {
    if (!action) return
    window.requestAnimationFrame(() => document.getElementById('merchant-campaign-reason')?.focus())
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !submitting) { setAction(undefined); window.requestAnimationFrame(() => triggerRef.current?.focus()); return }
      if (event.key !== 'Tab') return
      const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])') ?? [])
      const first = focusable[0]; const last = focusable[focusable.length - 1]
      if (!first || !last) return
      const outsideEdge = campaignDialogFocusEdge(Boolean(dialogRef.current?.contains(document.activeElement)), event.shiftKey)
      if (outsideEdge) { event.preventDefault(); (outsideEdge === 'last' ? last : first).focus(); return }
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [action, submitting])
  const open = (next: CampaignLifecycleAction, trigger: HTMLButtonElement) => {
    triggerRef.current = trigger; setAction(next); setReason(''); setConfirmed(false); setError('')
    setSelected(campaign?.items.filter(item => item.state === 'failed').map(item => item.id) ?? [])
  }
  const close = () => { if (!submitting) { setAction(undefined); window.requestAnimationFrame(() => triggerRef.current?.focus()) } }
  const submit = async () => {
    if (!baseUrl || !campaign || !action) return
    setSubmitting(true); setError('')
    try {
      const params = buildCampaignLifecycleParams({ campaign, action, reason, selectedItemIds: selected, idempotencyKey: `merchant:${action}:${campaign.id}:${crypto.randomUUID()}` })
      const next = parseCampaignSnapshot(await requestMcp(baseUrl, `campaign.batch.${action}`, params))
      setCampaign(next); setAction(undefined); setReason(''); setConfirmed(false)
    } catch (cause) { setError(describeApiError(cause)) }
    finally { setSubmitting(false) }
  }
  const failed = campaign?.items.filter(item => item.state === 'failed') ?? []
  const availability = campaign ? campaignActionAvailability(campaign.state) : { canPause: false, canResume: false, canRetryFailed: false }
  if (!showControls) return <section className="panel campaign-lifecycle campaign-lifecycle-collapsed" aria-labelledby="campaign-lifecycle-title"><div className="panel-heading"><div><span className="section-kicker">ADVANCED CONTROL</span><h3 id="campaign-lifecycle-title">批量任务控制</h3><p className="panel-subtitle">暂停、恢复或重试失败项属于高级操作；打开后从当前工作区的批量计划列表选择。</p></div><div className="button-row compact"><button type="button" className="secondary" onClick={openProductSelection}>选择商品开始任务</button><button type="button" className="text-button" onClick={() => { setShowControls(true); void loadCampaignOptions() }} disabled={!baseUrl}>打开高级控制</button></div></div></section>
  return <section className="panel campaign-lifecycle" aria-labelledby="campaign-lifecycle-title" aria-busy={loading || submitting}>
    <div className="panel-heading"><div><span className="section-kicker">BATCH CONTROL</span><h3 id="campaign-lifecycle-title">批量任务控制</h3><p className="panel-subtitle">读取任务批次后，可暂停、恢复或重试失败项；任何状态冲突都会阻断。</p></div><button type="button" className="text-button" onClick={() => setShowControls(false)} disabled={loading || submitting}>收起高级控制</button></div>
    <div className="campaign-lookup"><label htmlFor="merchant-campaign-select">选择批量计划<select id="merchant-campaign-select" value={campaignId} onChange={event => { setCampaignId(event.target.value); setCampaign(undefined) }} disabled={loading || submitting || !campaignOptions.length}><option value="">{loading ? '正在读取批量计划…' : campaignOptions.length ? '请选择一个批量计划' : '当前没有可操作的批量计划'}</option>{campaignOptions.map(option => <option key={option.id} value={option.id}>{campaignStateLabel(option.state)} · {option.itemCount} 项 · {new Date(option.updatedAt).toLocaleString('zh-CN', { hour12: false })}</option>)}</select></label><button type="button" className="secondary" onClick={() => void load()} disabled={!baseUrl || !campaignId.trim() || loading || submitting}>{loading ? <RefreshCw className="spin" size={16} aria-hidden="true"/> : null}{loading ? '读取中…' : '读取所选计划'}</button><button type="button" className="text-button" onClick={() => void loadCampaignOptions()} disabled={!baseUrl || loading || submitting}>重新读取列表</button></div>
    {!baseUrl && <div className="info-notice">API 未配置，campaign 控制保持关闭。</div>}
    {error && !action && <div ref={errorRef} tabIndex={-1} className="inline-error" role="alert" aria-live="assertive" aria-atomic="true"><AlertCircle size={16} aria-hidden="true"/><span>{error}</span><button type="button" className="text-button" onClick={() => void (errorSource === 'list' ? loadCampaignOptions() : load())}>重新读取</button></div>}
    {!loading && !error && !campaignOptions.length && <div className="empty-state">当前工作区暂无可操作的批量计划；请先在对话中创建批量任务。</div>}
    {campaign && <div ref={statusRef} tabIndex={-1} className="campaign-status"><div><b>已选择批量计划</b><span>{campaignStateLabel(campaign.state)} · 当前状态版本已读取 · {campaign.items.length} 项</span>{(campaign.state === 'unknown' || campaign.state === 'reconciling') && <small role="status">平台结果尚未确认，暂不允许暂停、恢复或重试；请刷新状态或进行人工核对。</small>}</div><div className="button-row compact">
      {availability.canResume && <button type="button" className="secondary" onClick={event => open('resume', event.currentTarget)}><PlayCircle size={16} aria-hidden="true"/>恢复</button>}
      {availability.canPause && <button type="button" className="danger-action" onClick={event => open('pause', event.currentTarget)}><PauseCircle size={16} aria-hidden="true"/>暂停</button>}
      {availability.canRetryFailed && <button type="button" className="secondary" onClick={event => open('retry_failed', event.currentTarget)} disabled={!failed.length}><RotateCcw size={16} aria-hidden="true"/>重试失败项 ({failed.length})</button>}
      <button type="button" className="text-button" onClick={() => void load(campaign.id)} disabled={loading}>刷新状态版本</button>
    </div></div>}
    {campaign && <div className="campaign-items" aria-label="任务批次逐项状态">{campaign.items.map(item => <div key={item.id}><b>{item.productId ? '商品任务' : '任务项'}</b><span>{item.platform ?? '平台未返回'} · {item.accountId ? '店铺身份已确认' : '店铺身份待确认'}</span><strong data-state={item.state}>{campaignStateLabel(item.state)}</strong></div>)}</div>}
    <div className="sr-only" role="status" aria-live="polite">{loading ? '正在读取任务批次' : submitting ? '正在提交批量任务操作' : campaign ? `已读取当前状态版本 ${campaign.revision}` : error ? '任务批次读取失败' : ''}</div>
    {action && campaign && <div className="modal-layer" role="presentation"><div ref={dialogRef} className="modal campaign-modal" role="dialog" aria-modal="true" aria-labelledby="campaign-action-title" aria-describedby={campaignDialogDescriptionIds(Boolean(error))}><div className="modal-head"><div><span className="section-kicker">CURRENT STATUS VERSION {campaign.revision}</span><h2 id="campaign-action-title">{action === 'pause' ? '确认暂停批量任务' : action === 'resume' ? '确认恢复批量任务' : '确认重试失败项'}</h2></div><button className="icon-button" onClick={close} disabled={submitting} aria-label="关闭批量任务操作"><X size={18} aria-hidden="true"/></button></div><div className="modal-body dialog-form">
      <p id="campaign-action-description">提交时固定使用当前读取的状态版本 {campaign.revision}；如果服务端已有变化，操作会失败并要求刷新。</p>
      {action === 'retry_failed' && <fieldset><legend>选择失败项</legend>{failed.map(item => <label key={item.id} className="campaign-check"><input type="checkbox" checked={selected.includes(item.id)} disabled={submitting} onChange={event => setSelected(values => event.target.checked ? [...values, item.id] : values.filter(value => value !== item.id))}/><span>{item.productId ? '商品任务' : '任务项'} · {item.platform ?? '平台未返回'} · {item.accountId ? '店铺身份已确认' : '店铺身份待确认'}</span></label>)}</fieldset>}
      <label htmlFor="merchant-campaign-reason">操作原因<textarea id="merchant-campaign-reason" data-dialog-initial-focus autoFocus rows={4} maxLength={1000} value={reason} disabled={submitting} aria-invalid={Boolean(error)} aria-describedby={campaignReasonDescriptionIds(Boolean(error))} onChange={event => setReason(event.target.value)} /></label><small id="campaign-action-reason-hint">必填，至少 3 个字符；将进入审计记录。</small>
      <label className="campaign-check"><input type="checkbox" checked={confirmed} disabled={submitting} onChange={event => setConfirmed(event.target.checked)}/><span>我已核对任务批次、失败项和当前状态版本；该操作不会伪造撤销外部进行中的工作。</span></label>
      {error && <div id="campaign-action-error" ref={actionErrorRef} tabIndex={-1} className="inline-error compact" role="alert" aria-live="assertive" aria-atomic="true" aria-labelledby="campaign-action-error-message"><AlertCircle size={16} aria-hidden="true"/><span id="campaign-action-error-message">{error}</span></div>}
    </div><div className="modal-actions"><button type="button" className="secondary" onClick={close} disabled={submitting}>取消</button><button type="button" className={action === 'pause' ? 'danger-action' : 'primary'} onClick={() => void submit()} disabled={submitting || reason.trim().length < 3 || !confirmed || (action === 'retry_failed' && !selected.length)}>{submitting ? '提交中…' : '确认并提交'}</button></div></div></div>}
  </section>
}
