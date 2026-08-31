import { AlertTriangle, CheckCircle2, Clock3, RefreshCw } from 'lucide-react'
import type { ConsistencyItem } from './data-consistency.js'

type Freshness = 'fresh' | 'stale' | 'expired' | 'unknown'

export type CanonicalConsistencyPanelProps = {
  items: ConsistencyItem[]
  freshness?: Freshness
  generatedAt?: string
  errorMessage?: string
  onRefresh?: () => void
  refreshing?: boolean
}

const freshnessCopy: Record<Freshness, { label: string; detail: string; tone: 'green' | 'amber' }> = {
  fresh: { label: '报告新鲜', detail: '当前结果可以作为只读工作区依据。', tone: 'green' },
  stale: { label: '报告已变旧', detail: '结果可能未覆盖最新关系；处理前请重新检查。', tone: 'amber' },
  expired: { label: '报告已过期', detail: '过期结果不能作为发布依据，请重新检查。', tone: 'amber' },
  unknown: { label: '新鲜度未知', detail: '服务端没有提供报告新鲜度，不能据此判断已通过。', tone: 'amber' },
}

export function CanonicalConsistencyPanel({ items, freshness = 'unknown', generatedAt, errorMessage, onRefresh, refreshing = false }: CanonicalConsistencyPanelProps) {
  const canonical = items.find((item) => item.id === 'products')
  const pendingCount = items.filter((item) => item.status !== 'green').length
  const freshnessState = freshnessCopy[freshness]
  return (
    <section className="data-consistency-card canonical-consistency-panel" data-testid="canonical-consistency-panel" aria-labelledby="canonical-consistency-title">
      <div className="data-consistency-head">
        <div>
          <span className="section-kicker">CANONICAL STATUS</span>
          <h3 id="canonical-consistency-title">规范商品状态</h3>
          <p>只展示服务端已确认的商品关系；读取失败、过期或未验证都不会被标记为通过。</p>
        </div>
        {onRefresh && <button className="secondary canonical-refresh" onClick={onRefresh} disabled={refreshing} aria-label="重新检查规范商品状态"><RefreshCw size={14} aria-hidden="true" />{refreshing ? '检查中…' : '重新检查'}</button>}
      </div>
      {errorMessage && <div className="canonical-error-summary" role="alert"><AlertTriangle size={16} aria-hidden="true" /><div><b>一致性报告读取失败</b><span>{errorMessage}</span><small>下一步：重试；如果仍失败，请转交运营查看服务端诊断。</small></div></div>}
      <div className={`canonical-freshness ${freshnessState.tone}`} role="status" aria-live="polite">
        {freshness === 'fresh' ? <CheckCircle2 size={16} aria-hidden="true" /> : <Clock3 size={16} aria-hidden="true" />}
        <div><b>{freshnessState.label}</b><span>{freshnessState.detail}{generatedAt ? ` 生成于 ${generatedAt}。` : ''}</span></div>
      </div>
      {canonical && canonical.status !== 'green' && <div className="canonical-error-summary" role="status"><AlertTriangle size={16} aria-hidden="true" /><div><b>{canonical.statusLabel ?? '标准链待处理'}</b><span>{canonical.detail}</span><small>下一步：{canonical.nextStep}</small></div></div>}
      <div className="data-consistency-head canonical-summary-row">
        <b>当前工作区待处理：{pendingCount} 项</b>
        <span>{canonical?.statusLabel ?? '标准链状态尚未确认'}</span>
      </div>
      <div className="data-consistency-grid">
        {items.map((item) => <article key={item.id} className={`consistency-item ${item.status}`}>
          <div><b>{item.label}</b><span className="consistency-state-label">{item.statusLabel ?? (item.status === 'green' ? '已验证' : item.status === 'amber' ? '待处理' : '待真实流程')}</span></div>
          <span>{item.detail}</span>
          <small>下一步：{item.nextStep}</small>
        </article>)}
      </div>
    </section>
  )
}
