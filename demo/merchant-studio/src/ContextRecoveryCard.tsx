import { useEffect, useRef, type ReactNode } from 'react'

export interface ContextRecoveryCardProps {
  message: string
  productTitle?: string
  platform?: string
  storeName?: string
  onBackToProducts: () => void
  onBackToTasks: () => void
  onReload: () => void
}

export function recoveryCopy(message: string) {
  if (message.includes('MODEL_RELAY') || message.includes('模型中转') || message.includes('模型鉴权') || message.includes('MCP_AUTH_REQUIRED')) return { title: '模型服务尚未就绪', body: '平台模型中转或真实鉴权尚未完成，内容没有生成，也没有扣费或发布。当前事实、任务和已有版本已保留；请联系运营完成模型 readiness 配置后再重试。', primary: '重新加载任务' }
  if (message.includes('生成超时') || message.includes('处理中') || message.includes('generation timeout')) return { title: '生成状态尚未确认', body: '内容生成请求可能仍在队列或处理中。请先查看任务状态，确认没有成功结果后再重试，避免重复生成。', primary: '查看任务列表' }
  if (message.includes('店铺身份')) return { title: '这项任务暂时无法继续', body: '商品和店铺信息与最新数据不一致。请返回商品列表重新选择，避免恢复到错误店铺。', primary: '返回商品与素材范围' }
  if (message.includes('CONTEXT_BUDGET_EXCEEDED') || message.includes('上下文')) return { title: '这项任务需要缩小范围', body: '本次商品事实、平台规则或素材过多。请减少未使用素材后再生成。', primary: '返回商品与素材范围' }
  if (message.includes('TASK_CONTEXT_SNAPSHOT_NOT_FOUND')) return { title: '原任务暂时无法恢复', body: '任务所依赖的商品、规则或素材快照已经不可用，请从任务列表重新开始。', primary: '返回任务列表' }
  return { title: '这项任务暂时无法继续', body: '商品、店铺或任务信息读取失败。可以重新加载，或返回任务列表检查数据。', primary: '重新加载任务' }
}

export function ContextRecoveryCard({ message, productTitle, platform, storeName, onBackToProducts, onBackToTasks, onReload }: ContextRecoveryCardProps): ReactNode {
  const copy = recoveryCopy(message)
  const cardRef = useRef<HTMLElement>(null)
  useEffect(() => { cardRef.current?.focus() }, [message])
  // Older task routes passed the same callback for both destinations. Keep
  // that contract safe: a product-scope recovery must never loop back into
  // the broken task, so fall back to the canonical products route.
  const backToProducts = () => {
    if (onBackToProducts !== onBackToTasks) return onBackToProducts()
    window.history.pushState(null, '', '/merchant/products')
    window.dispatchEvent(new PopStateEvent('popstate'))
  }
  const primary = copy.primary === '返回商品与素材范围' ? backToProducts : copy.primary === '返回任务列表' ? onBackToTasks : onReload
  const showTaskLink = copy.primary !== '返回任务列表' && copy.primary !== '查看任务列表'
  return <section ref={cardRef} className="panel context-recovery-card" role="alert" tabIndex={-1} aria-labelledby="context-recovery-title" aria-describedby="context-recovery-body" data-testid="context-recovery-card">
    <div className="panel-heading"><div><span className="section-kicker">TASK RECOVERY</span><h3 id="context-recovery-title">{copy.title}</h3></div><span className="status-chip amber">需要处理</span></div>
    <p id="context-recovery-body">{copy.body}</p>
    <div className="context-recovery-meta"><span>商品：{productTitle ?? '未恢复'}</span><span>平台：{platform ?? '待确认'}</span><span>店铺：{storeName ?? '待重新确认'}</span></div>
    <div className="button-row"><button className="primary" onClick={primary}>{copy.primary}</button>{showTaskLink && <button className="secondary" onClick={onBackToTasks}>查看任务列表</button>}</div>
  </section>
}
