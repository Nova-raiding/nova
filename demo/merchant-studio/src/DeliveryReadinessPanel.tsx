import { useEffect, useRef, useState } from 'react'
import { AlertCircle, FileWarning, RefreshCw, ShieldAlert } from 'lucide-react'
import { describeApiError, fetchDeliveryReadiness, type DeliveryReadinessSnapshot } from './api.js'
import { deliveryFindingReadiness } from './delivery-readiness.js'

const platformLabel: Record<string, string> = { jd: '京东', taobao: '淘宝', tmall: '天猫', pinduoduo: '拼多多', xiaohongshu: '小红书', douyin: '抖音' }

export function DeliveryReadinessPanel({ baseUrl }: { baseUrl?: string }) {
  const [snapshot, setSnapshot] = useState<DeliveryReadinessSnapshot | null>(null)
  const [loading, setLoading] = useState(Boolean(baseUrl))
  const [error, setError] = useState('')
  const [reloadKey, setReloadKey] = useState(0)
  const retryRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLElement>(null)
  const restoreRetryFocus = useRef(false)
  useEffect(() => {
    if (!baseUrl) { setSnapshot(null); setLoading(false); setError(''); return }
    let cancelled = false
    setLoading(true); setError('')
    fetchDeliveryReadiness(baseUrl)
      .then((readinessResult) => {
        if (cancelled) return
        setSnapshot(readinessResult)
      })
      .catch((reason) => { if (!cancelled) setError(describeApiError(reason)) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [baseUrl, reloadKey])
  useEffect(() => {
    if (loading || !restoreRetryFocus.current) return
    restoreRetryFocus.current = false
    window.requestAnimationFrame(() => (error ? retryRef.current : panelRef.current)?.focus())
  }, [error, loading])
  const retry = () => {
    restoreRetryFocus.current = true
    setReloadKey(value => value + 1)
  }
  // Older/partial readiness responses are valid evidence of an incomplete
  // check, not permission to crash the workspace. Normalize missing arrays
  // and nested findings before rendering the operator-facing status cards.
  const mappings = (snapshot?.mappingPreflights ?? []).map(item => ({ ...item, findings: item.findings ?? [], readiness: deliveryFindingReadiness(item.status, item.findings ?? []) }))
  const bundles = (snapshot?.bundles ?? []).map(bundle => ({ ...bundle, errors: bundle.errors ?? [] }))
  const evidence = (snapshot?.authenticity ?? []).map(item => ({ ...item, reasons: item.reasons ?? [] }))
  const announced = loading ? '正在读取平台交付状态' : error ? '平台交付状态读取不完整，所有缺失能力保持阻断' : `已读取 ${mappings.length} 项字段检查、${bundles.length} 个交付包`
  return <section ref={panelRef} tabIndex={-1} className="panel delivery-readiness" aria-labelledby="delivery-readiness-title" aria-busy={loading}>
    <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">{announced}</span>
    <div className="panel-heading"><div><span className="section-kicker">DELIVERY READINESS</span><h3 id="delivery-readiness-title">平台交付状态</h3><p className="panel-subtitle">只有来源、版本、有效期和批准状态同时完整才显示可用；技术校验详情只用于运营排查。</p></div><button className="text-button" onClick={() => setReloadKey(value => value + 1)} disabled={!baseUrl || loading}><RefreshCw size={14} className={loading ? 'spin' : undefined}/>刷新状态</button></div>
    {!baseUrl && <div className="delivery-empty"><ShieldAlert size={20}/><b>未连接 API，交付能力保持阻断</b><span>不会使用演示媒体规格、mapping 结果或 bundle 校验结果。</span></div>}
    {baseUrl && <div className="delivery-empty"><FileWarning size={18}/><b>媒体规格由平台运营统一维护</b><span>商家工作台不读取平台级能力证据；发布时由服务端按已批准且未过期的规格执行门禁。</span></div>}
    {error && <div className="inline-error" role="alert"><AlertCircle size={16}/><span>部分交付证据不可用：{error}。缺失项不会显示为通过。</span><button ref={retryRef} className="text-button" onClick={retry}>重试</button></div>}
    {loading && <div className="loading-state" role="status"><RefreshCw className="spin" size={16}/>正在读取交付证据…</div>}
    {!loading && baseUrl && <div className="delivery-readiness-grid">
      <article><h4>平台字段检查</h4>{mappings.length ? mappings.map(item => <div className={`delivery-status ${item.readiness}`} key={item.id}><div><b>{platformLabel[item.platform] ?? item.platform} · {item.productId ? '商品字段' : '商品未绑定'}</b>{item.findings.length ? item.findings.map(finding => <small key={`${finding.code}:${finding.field ?? ''}`}>{finding.message} · 下一步：{finding.nextAction ?? '人工处理'}</small>) : <small>字段检查通过；最终状态仍以服务端为准。</small>}</div><strong>{item.readiness === 'approved' ? '已通过' : item.readiness === 'blocked' ? '已阻断' : '未验证'}</strong></div>) : <Empty label="尚无平台字段检查结果" detail="没有服务端检查结果，不能进入平台写入。"/>}</article>
      <article><h4>交付包校验</h4>{bundles.length ? bundles.map(bundle => <div className={`delivery-status ${bundle.status === 'valid' && bundle.errors.length === 0 ? 'approved' : 'unverified'}`} key={bundle.id}><div><b>交付包</b><span>{bundle.manifestHash ? '完整性依据已读取' : '完整性依据未提供'}</span>{bundle.errors.map(item => <small key={`${item.code}:${item.path ?? ''}`}>{item.message}</small>)}</div><strong>{bundle.status === 'valid' && bundle.errors.length === 0 ? '已验证' : '无效/未验证'}</strong></div>) : <Empty label="尚无交付包校验结果" detail="未获得完整性和篡改检查结果，禁止宣称交付包有效。"/>}</article>
      <article><h4>图片真实性 / 视频成片</h4>{evidence.length ? evidence.map(item => <div className={`delivery-status ${item.status === 'verified' && item.evidenceRef ? 'approved' : 'unverified'}`} key={item.id}><div><b>{item.kind === 'image' ? '图片真实性' : '视频成片'}</b><span>{item.evidenceRef ? '服务端验证依据已读取' : '验证依据未提供'}</span><small>{item.reasons?.join('；') || '无可展示的验证说明'}</small></div><strong>{item.status === 'verified' && item.evidenceRef ? '已验证' : '未验证'}</strong></div>) : <Empty label="尚无真实性或成片证据" detail="人工选图、模型预览和分镜脚本均不等于真实性/真实渲染通过。"/>}</article>
    </div>}
  </section>
}

function Empty({ label, detail }: { label: string; detail: string }) {
  return <div className="delivery-empty"><FileWarning size={18}/><b>{label}</b><span>{detail}</span></div>
}
